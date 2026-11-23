// Makes a contact sheet (clean | glitched | glitch outlined) from an output folder, for eyeballing the data.
// Usage: node generator/sheet.mjs out/smoke [--per 3] [--file sheet.png]
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const dir = resolve(process.argv[2] ?? 'out');
const opt = Object.fromEntries(process.argv.slice(3).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const per = Number(opt.per ?? 3);
const file = opt.file ?? 'sheet.png';

const rows = (await readFile(join(dir, 'manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const byType = {};
for (const r of rows) (byType[r.glitch] ??= []).length < per && byType[r.glitch].push(r);

const img = async (p) => `data:image/png;base64,${(await readFile(join(dir, p))).toString('base64')}`;
let body = '';
for (const [type, list] of Object.entries(byType)) {
  body += `<h2>${type.replace(/_/g, ' ')}</h2><div class="row">`;
  for (const r of list) {
    const [c, g, m] = await Promise.all([img(r.files.clean), img(r.files.glitched), img(r.files.mask)]);
    body += `<figure><div class="trio"><img src="${c}"><img src="${g}"><div class="ov"><img src="${g}"><div class="m" style="-webkit-mask-image:url(${m});mask-image:url(${m})"></div></div></div>
      <figcaption>seed ${r.seed} · ${(r.fraction * 100).toFixed(1)}% of pixels</figcaption></figure>`;
  }
  body += '</div>';
}
const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 24px; background: #111; color: #ddd; font: 14px system-ui; }
  h2 { margin: 18px 0 8px; font-weight: 600; text-transform: capitalize; }
  .row { display: flex; gap: 18px; }
  .trio { display: flex; gap: 4px; }
  .trio > img, .ov { width: 200px; height: 200px; }
  .ov { position: relative; }
  .ov img, .ov .m { position: absolute; inset: 0; width: 100%; height: 100%; }
  .ov img { filter: grayscale(0.6) brightness(0.7); }
  .ov .m { background: #ff2d55; opacity: 0.85; mask-mode: luminance; -webkit-mask-size: 100% 100%; mask-size: 100% 100%; }
  figcaption { margin-top: 4px; color: #999; font-size: 12px; }
</style><body>${body}</body>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: per * 630 + 60, height: 800 } });
await page.setContent(html, { waitUntil: 'load' });
await page.screenshot({ path: join(dir, file), fullPage: true });
await browser.close();
console.log(`wrote ${join(dir, file)}`);
