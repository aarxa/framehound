// Breaks real WebGL pages and saves clean frames, broken frames and masks, with the injector in generator/inject.
//
// Each page is loaded, left to run, then frozen at a few moments. At each moment the frozen frame is stepped until it
// stops changing (the clean frame), then drawn again with one draw call broken at a time. Between moments the page
// runs on and the camera is dragged a little, so the moments show different views.
//
//   node generator/capture.mjs --apps generator/apps/test.txt --out out/gl-check [--moments 3] [--per-moment 10]
//        [--warmup 6] [--gap 3] [--workers 4] [--serve sources/threejs-r170] [--types missing_texture,inside_out]
//        [--width 768 --height 432] [--min-strong 0.001] [--app-timeout 180]
//
// The apps file has one page per line: "<id> <url>" (lines starting with # are skipped). A url starting with "/" is
// served from the --serve folder on a local server.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []));
const outDir = join(root, args.out ?? 'out/gl-check');
const moments = Number(args.moments ?? 3);
const perMoment = Number(args['per-moment'] ?? 10);
const warmup = Number(args.warmup ?? 6);
const gap = Number(args.gap ?? 3);
const workers = Number(args.workers ?? 1);
const width = Number(args.width ?? 768);
const height = Number(args.height ?? 432);
const minStrong = Number(args['min-strong'] ?? 0.001); // share of the frame that must change plainly
const APP_TIMEOUT = Number(args["app-timeout"] ?? 180); // seconds; a page that hangs is given up on
const VAL_EVERY = 5; // apps whose id hashes to 0 mod 5 go to validation, so validation pages are never trained on
const injector = join(root, 'generator/inject/glitch-gl.js');

// a plain static server for pages kept on disk (only files under the served folder are reachable)
let base = null;
let server = null;
if (args.serve) {
  const dir = resolve(root, String(args.serve));
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
    '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  };
  server = createServer(async (req, res) => {
    const path = normalize(join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(dir)) return res.writeHead(403).end();
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': types[extname(path).toLowerCase()] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
}

const apps = (await readFile(join(root, args.apps ?? 'generator/apps/test.txt'), 'utf8'))
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const [id, url] = l.split(/\s+/);
    if (url.startsWith('/') && !base) throw new Error(`${id}: a local page needs --serve`);
    return { id, url: url.startsWith('/') ? base + url : url };
  });

const hash = (s) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0), 2166136261);
const pad = (n) => String(n).padStart(6, '0');
const save = async (rel, dataUrl) => {
  const file = join(outDir, rel);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
};
const sleep = (s) => new Promise((ok) => setTimeout(ok, s * 1000));

await mkdir(outDir, { recursive: true });
const manifest = join(outDir, 'manifest.jsonl');
await rm(manifest, { force: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const stats = { written: 0, byType: {}, apps: {} };
let seed = 1;
let types = null;
const t0 = Date.now();
let done = 0;

async function capture(app, page, report, split) {
  await page.addInitScript({ path: injector });
  await page.goto(app.url, { waitUntil: 'load', timeout: 60000 });
  await sleep(warmup);
  const status = await page.evaluate(([w, h]) => {
    window.__fh.setSize(w, h);
    return window.__fh.status();
  }, [width, height]);
  types ??= await page.evaluate(() => window.__fh.types);
  const wanted = args.types ? String(args.types).split(',') : types;
  if (!status.canvas) throw new Error('no WebGL canvas on the page');
  report.canvas = status.canvas;
  report.webgl2 = status.webgl2;

  for (let m = 0; m < moments; m++) {
    if (m > 0) {
      // let the page run on, and nudge the camera the way a player would
      await page.evaluate(() => window.__fh.unfreeze());
      const [x, y] = [640 + (Math.random() - 0.5) * 400, 360 + (Math.random() - 0.5) * 240];
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + (Math.random() - 0.5) * 500, y + (Math.random() - 0.5) * 200, { steps: 12 });
      await page.mouse.up();
      await sleep(gap);
    }
    await page.evaluate(() => window.__fh.freeze());
    await sleep(0.2); // frame callbacks already queued with the browser run once more, then land in our queue
    const settled = await page.evaluate(() => window.__fh.settle());
    report.moments.push(settled.ok ? `${settled.steps} steps, ${settled.draws} draws` : settled.reason);
    if (!settled.ok) {
      if (settled.reason.includes('requestAnimationFrame')) break;
      continue;
    }
    const cleanFile = `clean/${app.id}/${m}.png`;
    await save(cleanFile, await page.evaluate(() => window.__fh.clean()));
    // the glitches this frame offers, taken in turn so each moment covers as many kinds as it can
    const order = wanted.filter((t) => settled.eligible[t]).sort(() => Math.random() - 0.5);
    for (let i = 0; i < perMoment && order.length; i++) {
      const type = order[i % order.length];
      const id = seed++;
      const s = await page.evaluate(([t, sd, ms]) => window.__fh.sample({ type: t, seed: sd, minStrong: ms }), [type, id, minStrong]);
      if (s.fatal) {
        report.problems.push(`moment ${m}: ${s.reason}`);
        break;
      }
      if (!s.ok) continue;
      const files = { clean: cleanFile, glitched: `glitched/${type}/${pad(id)}.png`, mask: `masks/${type}/${pad(id)}.png` };
      await Promise.all([save(files.glitched, s.glitched), save(files.mask, s.mask)]);
      const { glitched, mask, ok, ...meta } = s;
      await appendFile(manifest, JSON.stringify({ seed: id, app: app.id, moment: m, glitch: type, ...meta, split, files }) + '\n');
      stats.written++;
      report.written++;
      stats.byType[type] = (stats.byType[type] ?? 0) + 1;
    }
  }
}

async function runApp(app) {
  const split = hash(app.id) % VAL_EVERY === 0 ? 'val' : 'train';
  const report = { split, written: 0, moments: [], problems: [] };
  stats.apps[app.id] = report;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let timer;
  try {
    await Promise.race([
      capture(app, page, report, split),
      new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`gave up after ${APP_TIMEOUT} s`)), APP_TIMEOUT * 1000); }),
    ]);
  } catch (e) {
    report.problems.push(String(e.message ?? e).split('\n')[0]);
  }
  clearTimeout(timer);
  if (errors.length) report.page_errors = errors.slice(0, 3);
  await context.close().catch(() => {});
  done++;
  const minutes = (Date.now() - t0) / 60000;
  console.log(`[${done}/${apps.length}, ${minutes.toFixed(1)} min] ${app.id} ${split}: ${report.written} samples; ${report.moments.join(' | ')}${report.problems.length ? ' | ' + report.problems.join('; ') : ''}`);
}

let next = 0;
await Promise.all(Array.from({ length: workers }, async () => {
  while (next < apps.length) await runApp(apps[next++]);
}));

await writeFile(join(outDir, 'dataset.json'), JSON.stringify({
  created: new Date().toISOString(), size: [width, height], glitch_types: types ?? [],
  source: 'real WebGL pages broken by generator/inject/glitch-gl.js', apps_file: args.apps ?? 'generator/apps/test.txt',
  val_rule: `hash(app id) % ${VAL_EVERY} == 0`, ...stats,
}, null, 2));
console.log(`wrote ${stats.written} samples from ${apps.length} pages to ${outDir} in ${((Date.now() - t0) / 60000).toFixed(0)} min`, JSON.stringify(stats.byType));
await browser.close();
server?.close();
