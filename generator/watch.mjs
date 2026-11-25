// framehound watch: plays a WebGL app and checks every frame it stops on with a model learned for that app
// (framehound learn). For each frame the model flags, it finds the draw calls that drew the flagged pixels: it draws
// the frame again with each draw left out and sees which pixels change. It writes report.html: each flagged frame,
// the heatmap, and the draws found there with their shader, textures, size and a picture of what each one draws.
//
//   node generator/watch.mjs --model models/hexgl --url <url> [--id name] [--driver play.mjs] [--serve folder]
//        [--fetch-missing <base url>] [--minutes 5 | --moments N] [--gap 2.5] [--warmup 6] [--out watch/<id>]
//        [--threshold t] [--plant 0.5] [--types missing_texture,inside_out] [--seed 1]
//   node generator/watch.mjs --rebuild --out watch/<id>     (write report.html again from report.json)
//
// --plant s tests watch itself: on a share s of the frames, one draw is broken first with a known glitch (as framehound
// learn breaks them) and kept broken while the frame is checked. The report then says how many planted glitches were
// flagged, and whether the draw that was broken came first among the draws found.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { serveFolder } from './serve.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []));
const width = 768; // the size the model was trained at
const height = 432;
if (args.rebuild && args.out) {
  const dir = resolve(root, String(args.out));
  const r = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  await writeFile(join(dir, 'report.html'), html(r, r.frames.filter((f) => !f.skipped)));
  console.log(join(dir, 'report.html'));
  process.exit(0);
}
if (!args.model || !args.url) {
  console.log('usage: node generator/watch.mjs --model <model folder> --url <url> [--driver play.mjs] [--serve folder] [--minutes 5]');
  process.exit(1);
}
const modelDir = resolve(root, String(args.model));
const id = String(args.id ?? 'app');
const outDir = resolve(root, String(args.out ?? join('watch', id)));
const minutes = Number(args.minutes ?? 5);
const maxMoments = args.moments ? Number(args.moments) : Infinity;
const gap = Number(args.gap ?? 2.5);
const warmup = Number(args.warmup ?? 6);
const plantShare = Number(args.plant ?? 0);
const plantTypes = args.types ? String(args.types).split(',') : null; // glitches to plant (default: any that applies)
const injector = join(root, 'generator/inject/glitch-gl.js');
const python = process.env.FRAMEHOUND_PYTHON ?? (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
const sleep = (s) => new Promise((ok) => setTimeout(ok, s * 1000));
const pad = (n) => String(n).padStart(4, '0');
let seed = Number(args.seed ?? 1);
const rand = (() => {
  let s = seed * 7919;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
})();

const served = args.serve ? await serveFolder(resolve(root, String(args.serve)), args['fetch-missing'] ?? null) : null;
const url = String(args.url).startsWith('/') ? (served ? served.base + args.url : null) : String(args.url);
if (!url) throw new Error('a local page needs --serve');

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'frames'), { recursive: true });
await mkdir(join(outDir, 'draws'), { recursive: true });
const saveData = (file, dataUrl) => writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
const rel = (p) => relative(outDir, p);

// the model stays loaded in one Python process; each frame is a line in and a line of JSON out
const checker = spawn(python, ['train/check.py', '--model', modelDir, '--stdin', '--out', join(outDir, 'heatmaps'),
  ...(args.threshold ? ['--threshold', String(args.threshold)] : [])], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
const answers = [];
createInterface({ input: checker.stdout }).on('line', (l) => {
  if (l.startsWith('{')) answers.shift()?.(JSON.parse(l));
});
const check = (file) => new Promise((ok) => {
  answers.push(ok);
  checker.stdin.write(`${file}\n`);
});

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const driver = args.driver ? await import(pathToFileURL(resolve(root, String(args.driver))).href) : null;
await page.addInitScript({ path: injector });
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await sleep(warmup);
if (driver?.start) await driver.start(page);
const status = await page.evaluate(([w, h]) => {
  window.__fh.setSize(w, h);
  return window.__fh.status();
}, [width, height]);
if (!status.canvas) throw new Error('no WebGL canvas on the page');

const t0 = Date.now();
const frames = [];
const log = join(outDir, 'frames.jsonl');
for (let m = 0; m < maxMoments && (Date.now() - t0) / 60000 < minutes; m++) {
  if (m > 0) {
    await page.evaluate(() => window.__fh.unfreeze());
    if (driver?.between) await driver.between(page, gap);
    else {
      const [x, y] = [640 + (rand() - 0.5) * 400, 360 + (rand() - 0.5) * 240];
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + (rand() - 0.5) * 500, y + (rand() - 0.5) * 200, { steps: 12 });
      await page.mouse.up();
      await sleep(gap);
    }
  }
  const at = +((Date.now() - t0) / 1000).toFixed(1);
  await page.evaluate(() => window.__fh.freeze());
  await sleep(0.2);
  const settled = await page.evaluate(() => window.__fh.settle());
  if (!settled.ok) {
    console.log(`frame ${m} at ${at} s: skipped, ${settled.reason}`);
    frames.push({ moment: m, seconds: at, skipped: settled.reason });
    if (settled.reason.includes('requestAnimationFrame') && !driver) break;
    continue;
  }
  let image = await page.evaluate(() => window.__fh.clean());

  // testing watch: break one draw with a known glitch and keep it broken while the frame is checked
  let planted = null;
  if (plantShare && rand() < plantShare) {
    const kinds = Object.keys(settled.eligible).filter((t) => settled.eligible[t] && (!plantTypes || plantTypes.includes(t)))
      .sort(() => rand() - 0.5);
    for (const type of kinds.slice(0, 4)) {
      const s = await page.evaluate(([t, sd]) => window.__fh.sample({ type: t, seed: sd, keep: true }), [type, seed++]);
      if (s.fatal) break;
      if (s.ok) {
        planted = { type, draw: s.draw.index, info: s.info, fraction: +s.fraction.toFixed(4) };
        image = s.glitched;
        await mkdir(join(outDir, 'planted'), { recursive: true });
        await saveData(join(outDir, 'planted', `${pad(m)}.png`), s.mask);
        planted.mask = `planted/${pad(m)}.png`;
        break;
      }
    }
  }

  const file = join(outDir, 'frames', `${pad(m)}.png`);
  await saveData(file, image);
  const v = await check(file);
  const entry = {
    moment: m, seconds: at, frame: rel(file), heatmap: v.heatmap ? rel(v.heatmap) : null, score: v.score, threshold: v.threshold,
    flagged: !!v.glitch, likely_kind: v.likely_kind, region: v.region, region_is_faint: v.region_is_faint,
    held: settled.replay ? 'replay' : 'steps', draws_in_frame: settled.draws, planted,
  };
  if (v.error) entry.error = v.error;
  if (entry.flagged && entry.region) {
    const loc = await page.evaluate(([box, heat]) => window.__fh.locate({ box, heat }), [entry.region, v.heat ?? null]);
    if (loc.ok) {
      const draws = [];
      for (const [i, d] of loc.draws.entries()) {
        const { image: picture, ...rest } = d;
        const pic = join(outDir, 'draws', `${pad(m)}-${i + 1}.jpg`);
        await saveData(pic, picture);
        draws.push({ ...rest, picture: rel(pic) });
      }
      entry.located = { box: loc.box, tried: loc.tried, drew_in_box: loc.drew_in_box, seconds: loc.seconds, back: loc.back, draws };
      if (planted) {
        const r = loc.ranks.indexOf(planted.draw);
        planted.rank = r < 0 ? null : r + 1;
      }
    } else entry.located = { error: loc.reason };
  }
  if (planted) {
    const back = await page.evaluate(() => window.__fh.unplant());
    if (!back) entry.problem = 'the clean frame did not come back after the planted glitch';
  }
  frames.push(entry);
  await appendFile(log, JSON.stringify(entry) + '\n');
  const named = entry.located?.draws?.[0];
  console.log(`frame ${m} at ${at} s: score ${entry.score}${entry.flagged ? ` FLAGGED (${entry.likely_kind})` : ''}` +
    (planted ? `; planted ${planted.type} on draw ${planted.draw}${planted.rank ? `, found at rank ${planted.rank}` : ''}` : '') +
    (named ? `; first draw found: #${named.index} ${named.shader ?? named.call} (${entry.located.seconds} s)` : '') +
    (entry.located?.error ? `; locate: ${entry.located.error}` : ''));
}

checker.stdin.end();
await browser.close();
served?.close();

// ---- the report --------------------------------------------------------------------------------------------------
const checked = frames.filter((f) => !f.skipped);
const flagged = checked.filter((f) => f.flagged);
const plantedFrames = checked.filter((f) => f.planted);
const cleanFrames = checked.filter((f) => !f.planted);
const summary = {
  id, url: String(args.url), model: modelDir, played_minutes: +((Date.now() - t0) / 60000).toFixed(1),
  frames_checked: checked.length, frames_skipped: frames.length - checked.length, flagged: flagged.length,
  threshold: checked[0]?.threshold ?? null, page_errors: pageErrors.slice(0, 5),
};
if (plantShare) {
  const caught = plantedFrames.filter((f) => f.flagged);
  const located = caught.filter((f) => f.located?.draws);
  summary.test = {
    planted: plantedFrames.length, planted_flagged: caught.length,
    planted_draw_first: located.filter((f) => f.planted.rank === 1).length,
    planted_draw_in_top3: located.filter((f) => f.planted.rank && f.planted.rank <= 3).length,
    unplanted: cleanFrames.length, unplanted_flagged: cleanFrames.filter((f) => f.flagged).length,
    by_type: Object.fromEntries([...new Set(plantedFrames.map((f) => f.planted.type))].map((t) => {
      const of = plantedFrames.filter((f) => f.planted.type === t);
      return [t, { planted: of.length, flagged: of.filter((f) => f.flagged).length, named_first: of.filter((f) => f.planted.rank === 1).length }];
    })),
  };
}
await writeFile(join(outDir, 'report.json'), JSON.stringify({ ...summary, frames }, null, 2));
await writeFile(join(outDir, 'report.html'), html(summary, checked));
console.log(`\n${checked.length} frames checked, ${flagged.length} flagged. Report: ${join(outDir, 'report.html')}`);
if (summary.test) console.log(JSON.stringify(summary.test));

function html(s, list) {
  const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const box = (r) => (r ? `<span class="box" style="left:${(r[0] / width) * 100}%;top:${(r[1] / height) * 100}%;width:${((r[2] - r[0]) / width) * 100}%;height:${((r[3] - r[1]) / height) * 100}%"></span>` : '');
  const tris = (d) => (d.primitive === 'triangles' ? `${Math.floor(d.count / 3).toLocaleString('en')} triangles` : `${d.count?.toLocaleString('en')} vertices (${d.primitive})`);
  const drawText = (d) => {
    const tex = (d.textures ?? []).map((t) => `<code>${esc(t.uniform)}</code> ${t.file ? esc(t.file) : 'unnamed'}${t.size ? ` (${esc(t.size)})` : ''}`).join(', ');
    return `<p><b>Draw #${d.index}</b>${d.shader ? ` · shader <code>${esc(d.shader)}</code>` : ` · program ${d.program}, shader ${esc(d.shader_hash)}`}</p>
      <p>${esc(d.call)}, ${tris(d)}${d.instances ? `, ${d.instances} instances` : ''}, to the ${d.target === 'screen' ? 'screen' : esc(d.target) + ' target'}${d.blend ? ', blended' : ''}${d.depth_test ? '' : ', no depth test'}</p>
      ${tex ? `<p>Textures: ${tex}</p>` : '<p>No textures.</p>'}
      <p class="dim">Explains ${pct(d.coverage)} of the flagged area; ${pct(d.focus)} of what it draws is flagged.</p>`;
  };
  const sections = list.filter((f) => f.flagged).map((f) => {
    const loc = f.located;
    const planted = f.planted ? `<p class="plant">Planted for the test: <code>${esc(f.planted.type)}</code> on draw #${f.planted.draw}. ${f.planted.rank ? `Found at rank ${f.planted.rank}.` : 'Not among the draws found.'}</p>` : '';
    const draws = loc?.draws?.length
      ? loc.draws.map((d) => `<div class="draw"><img src="${esc(d.picture)}" alt="what draw ${d.index} draws"><div>${drawText(d)}</div></div>`).join('')
      : loc?.error ? `<p class="dim">Couldn't look for the draws: ${esc(loc.error)}</p>`
        : loc ? '<p>No draw call in this frame draws in the flagged area, so if something is wrong there, it is something missing.</p>'
          : '<p class="dim">The model gave no clear area, so no draws were looked for.</p>';
    return `<section>
      <h2>Frame ${f.moment}, ${f.seconds} s in</h2>
      <p>Score ${f.score} (flagged above ${f.threshold}), most like <code>${esc(f.likely_kind)}</code>.${loc?.tried ? ` Looked at ${loc.tried} draws in ${loc.seconds} s.` : ''}</p>
      ${planted}
      <div class="pair"><div class="frame"><img src="${esc(f.frame)}" alt="frame ${f.moment}">${box(f.region)}</div>
      <img class="heat" src="${esc(f.heatmap)}" alt="heatmap"></div>
      ${draws}
    </section>`;
  }).join('\n');
  const strip = list.map((f) => `<a class="thumb${f.flagged ? ' hit' : ''}" href="${esc(f.frame)}"><img src="${esc(f.frame)}" alt=""><span>${f.moment} · ${f.score}</span></a>`).join('');
  const t = s.test;
  const testLine = t ? `<p>Test run: ${t.planted} frames had a glitch planted, and ${t.planted_flagged} of them were flagged. The broken draw came first in ${t.planted_draw_first} of those and in the top three in ${t.planted_draw_in_top3}. ${t.unplanted_flagged} of ${t.unplanted} frames without a planted glitch were flagged.</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>framehound watch: ${esc(s.id)}</title>
<style>
:root { color-scheme: dark; --bg: #111; --fg: #e6e6e6; --dim: #9a9a9a; --line: #2a2a2a; --hit: #ff6b6b; --box: #35d0ff; }
body { margin: 0 auto; max-width: 1100px; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, system-ui, sans-serif; }
h1 { font-size: 22px; margin: 0 0 8px; } h2 { font-size: 17px; margin: 0 0 4px; }
p { margin: 4px 0; } code { font: 13px ui-monospace, Menlo, monospace; } .dim { color: var(--dim); } .plant { color: #ffd479; }
section { border-top: 1px solid var(--line); padding: 20px 0; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0; }
.frame { position: relative; } .frame img, .heat { display: block; width: 100%; aspect-ratio: 16 / 9; }
.heat { object-fit: cover; object-position: right; }
.box { position: absolute; outline: 2px solid var(--box); }
.draw { display: grid; grid-template-columns: minmax(0, 360px) 1fr; gap: 16px; margin: 12px 0; }
.draw img { width: 100%; display: block; }
.strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; margin-top: 12px; }
.thumb { color: var(--dim); text-decoration: none; font-size: 12px; } .thumb img { width: 100%; display: block; opacity: .75; }
.thumb.hit img { outline: 2px solid var(--hit); opacity: 1; } .thumb.hit { color: var(--hit); }
@media (max-width: 640px) { .pair, .draw { grid-template-columns: 1fr; } }
</style></head><body>
<h1>framehound watch: ${esc(s.id)}</h1>
<p class="dim">${esc(s.url)}</p>
<p>Played for ${s.played_minutes} min and checked ${s.frames_checked} frames${s.frames_skipped ? ` (${s.frames_skipped} more wouldn't hold still)` : ''}. The model flagged ${s.flagged}.</p>
${testLine}
<p class="dim">For each flagged frame, the draws listed are the ones that drew the flagged pixels, best match first, each with a picture of what it draws. A draw that never happened can't be listed: if the area looks empty, what's missing is something that should have been drawn there.</p>
${sections || '<section><p>No frame was flagged.</p></section>'}
<section><h2>Every frame checked</h2><p class="dim">Frame number and score; flagged frames are outlined.</p><div class="strip">${strip}</div></section>
</body></html>`;
}
