// Renders clean / glitched / mask triples in headless Chrome and writes them to disk.
// Usage: node generator/run.mjs --count 20 --out out [--types missing_texture,z_fighting] [--start 1]
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const count = Number(args.count ?? 10);
const start = Number(args.start ?? 1);
const outDir = join(root, args.out ?? 'out');
const size = Number(args.size ?? 512);

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
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(url);
await page.waitForFunction(() => window.ready === true);

const all = await page.evaluate(() => window.glitchNames);
const wanted = args.types ? args.types.split(',') : all;
await mkdir(outDir, { recursive: true });
const manifest = join(outDir, 'manifest.jsonl');

const save = (file, dataUrl) => writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
let written = 0;
let skipped = 0;
for (let seed = start; seed < start + count; seed++) {
  for (const glitch of wanted) {
    const s = await page.evaluate(([seed, glitch, size]) => window.renderSample(seed, glitch, size, size), [seed, glitch, size]);
    if (!s.ok) {
      skipped++;
      continue;
    }
    const dir = join(outDir, glitch);
    await mkdir(dir, { recursive: true });
    const base = join(dir, String(seed).padStart(6, '0'));
    await save(`${base}_clean.png`, s.clean);
    await save(`${base}_glitched.png`, s.glitched);
    await save(`${base}_mask.png`, s.mask);
    const { clean, glitched, mask, ...meta } = s;
    const rel = `${glitch}/${String(seed).padStart(6, '0')}`; // paths in the manifest are relative to the output folder
    await appendFile(manifest, JSON.stringify({ ...meta, files: { clean: `${rel}_clean.png`, glitched: `${rel}_glitched.png`, mask: `${rel}_mask.png` } }) + '\n');
    written++;
  }
}
console.log(`wrote ${written} samples (${skipped} skipped: glitch not visible) to ${outDir}`);
await browser.close();
server.close();
