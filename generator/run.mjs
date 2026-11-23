// Renders samples in headless Chrome and writes them to disk.
//
// Dataset mode (default): one glitch per scene, the clean frame saved once (it doubles as a "no glitch" example),
// a fixed train/val split by seed, and a dataset.json summary.
//   node generator/run.mjs --count 5000 --out data/v1 [--workers 4] [--start 1] [--width 768 --height 432]
//
// Sheet mode: every glitch type on every scene, for eyeballing with generator/sheet.mjs.
//   node generator/run.mjs --all-types --count 6 --out out/check [--types missing_texture,z_fighting]
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []));
const count = Number(args.count ?? 10);
const start = Number(args.start ?? 1);
const outDir = join(root, args.out ?? 'out');
// frames are 16:9 like game screenshots; --size N makes them square
const width = Number(args.size ?? args.width ?? 768);
const height = Number(args.size ?? args.height ?? 432);
const workers = Number(args.workers ?? 4);
const allTypes = Boolean(args['all-types']);
const VAL_EVERY = 10; // every 10th seed goes to validation

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/generator/index.html`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function openPage() {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.ready === true);
  return page;
}

const first = await openPage();
const all = await first.evaluate(() => window.glitchNames);
const wanted = args.types ? String(args.types).split(',') : all;
await rm(join(outDir, 'manifest.jsonl'), { force: true });
await mkdir(outDir, { recursive: true });
const manifest = join(outDir, 'manifest.jsonl');
const pad = (n) => String(n).padStart(6, '0');
const save = async (rel, dataUrl) => {
  const file = join(outDir, rel);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
};
const render = (page, seed, glitch) => page.evaluate(([s, g, w, h]) => window.renderSample(s, g, w, h), [seed, glitch, width, height]);

// which glitch a seed gets: a hash, so it doesn't line up with the seed-based split
const typeFor = (seed) => {
  let h = (seed * 2654435761) >>> 0;
  h ^= h >>> 16;
  return (h % wanted.length + wanted.length) % wanted.length;
};

const stats = { written: 0, skipped: 0, byType: Object.fromEntries(wanted.map((t) => [t, 0])), split: { train: 0, val: 0 } };
const t0 = Date.now();

async function datasetSeed(page, seed) {
  // try this seed's glitch first; if it isn't visible in this scene, fall through to the next type
  for (let k = 0; k < wanted.length; k++) {
    const glitch = wanted[(typeFor(seed) + k) % wanted.length];
    const s = await render(page, seed, glitch);
    if (!s.ok) continue;
    const split = seed % VAL_EVERY === 0 ? 'val' : 'train';
    const files = { clean: `clean/${pad(seed)}.png`, glitched: `glitched/${glitch}/${pad(seed)}.png`, mask: `masks/${glitch}/${pad(seed)}.png` };
    await Promise.all([save(files.clean, s.clean), save(files.glitched, s.glitched), save(files.mask, s.mask)]);
    const { clean, glitched, mask, ok, ...meta } = s;
    await appendFile(manifest, JSON.stringify({ ...meta, split, files }) + '\n');
    stats.written++;
    stats.byType[glitch]++;
    stats.split[split]++;
    return;
  }
  stats.skipped++;
}

async function allTypesSeed(page, seed) {
  for (const glitch of wanted) {
    const s = await render(page, seed, glitch);
    if (!s.ok) {
      stats.skipped++;
      continue;
    }
    const rel = `${glitch}/${pad(seed)}`;
    const files = { clean: `${rel}_clean.png`, glitched: `${rel}_glitched.png`, mask: `${rel}_mask.png` };
    await Promise.all([save(files.clean, s.clean), save(files.glitched, s.glitched), save(files.mask, s.mask)]);
    const { clean, glitched, mask, ok, ...meta } = s;
    await appendFile(manifest, JSON.stringify({ ...meta, files }) + '\n');
    stats.written++;
    stats.byType[glitch]++;
  }
}

// workers pull seeds from a shared counter
let next = start;
const end = start + count;
async function worker(page) {
  while (next < end) {
    const seed = next++;
    await (allTypes ? allTypesSeed : datasetSeed)(page, seed);
    const done = stats.written + stats.skipped;
    if (!allTypes && done % 250 === 0) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`${done}/${count} scenes, ${rate.toFixed(1)}/s, ~${Math.round((count - done) / rate / 60)} min left`);
    }
  }
}
const pages = [first, ...(await Promise.all(Array.from({ length: Math.max(0, workers - 1) }, openPage)))];
await Promise.all(pages.map(worker));

const seconds = (Date.now() - t0) / 1000;
if (!allTypes) {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() + (execSync('git status --porcelain generator', { cwd: root }).toString().trim() ? '+dirty' : '');
  } catch {}
  await writeFile(join(outDir, 'dataset.json'), JSON.stringify({
    generator_commit: commit, created: new Date().toISOString(), size: [width, height], seeds: [start, end - 1],
    val_rule: `seed % ${VAL_EVERY} == 0`, glitch_types: wanted, ...stats, seconds: Math.round(seconds),
    assets: 'Poly Haven CC0 models and HDRIs (assets/manifest.json)',
  }, null, 2));
}
console.log(`wrote ${stats.written} samples (${stats.skipped} skipped: glitch not visible) to ${outDir} in ${seconds.toFixed(0)} s`);
await browser.close();
server.close();
