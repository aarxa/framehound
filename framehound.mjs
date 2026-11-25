#!/usr/bin/env node
// framehound: learn what one WebGL app looks like broken, then check its screenshots for rendering glitches.
//
//   node framehound.mjs learn <url> [--id name] [--driver play.mjs] [--serve folder] [--minutes 10] [--epochs 15]
//                                   [--out models/<id>]
//   node framehound.mjs check <model folder> <screenshot.png ...> [--out folder] [--threshold 0.8]
//
// learn opens the app in headless Chrome, freezes it at moments spread over --minutes of play, breaks each frame's
// draw calls in eleven ways (generator/inject/glitch-gl.js), and trains a detector on the result. The last fifth of the
// moments is held out, and report.json says how well the model does on those views it never trained on, with the
// score threshold that flags 5% of clean frames. A driver (--driver) gets a game past its menus and plays it between
// moments; without one, the camera is dragged a little. A url starting with "/" is served from --serve.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const positional = [];
const opts = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  else positional.push(rest[i]);
}
const python = process.env.FRAMEHOUND_PYTHON ?? (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
const mine = (p) => resolve(process.cwd(), String(p)); // paths the user gives are relative to where they ran us

function run(cmd, argv) {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, argv, { cwd: root, stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${[cmd, ...argv].join(' ')} exited with ${code}`))));
  });
}

async function learn() {
  const url = positional[0];
  if (!url) throw new Error('usage: framehound learn <url> [--driver play.mjs] [--serve folder] [--minutes 10]');
  const id = String(opts.id ?? new URL(url, 'http://local').pathname.split('/').filter(Boolean).pop()?.replace(/\.html?$/, '') ?? 'app')
    .replace(/[^\w-]+/g, '_');
  const out = mine(opts.out ?? join('models', id));
  const minutes = Number(opts.minutes ?? 10);
  const gap = Number(opts.gap ?? 2.5);
  const moments = Math.max(20, Math.round((minutes * 60) / (gap + 2))); // a moment takes the gap plus ~2 s of capture
  const step = (n, text) => console.log(`\n[${n}/4] ${text}`);

  step(1, `playing and breaking ${url} for about ${minutes} min (${moments} moments)`);
  await run(process.execPath, ['generator/capture.mjs', '--url', url, '--id', id, '--out', join(out, 'frames'),
    '--moments', String(moments), '--per-moment', String(opts['per-moment'] ?? 8), '--gap', String(gap),
    '--app-timeout', String(minutes * 60 * 3 + 300),
    ...(opts.driver ? ['--driver', mine(opts.driver)] : []), ...(opts.serve ? ['--serve', mine(opts.serve)] : [])]);

  step(2, 'holding out the last fifth of the moments for testing');
  await run(python, ['-I', 'scripts/split_same_page.py', join(out, 'frames'), join(out, 'split'), '--last-share', '0.2']);

  step(3, 'training');
  await run(python, ['train/train.py', '--data', join(out, 'split'), '--out', join(out, 'run'), '--epochs', String(opts.epochs ?? 15)]);

  step(4, 'testing on the held-out moments');
  await run(python, ['train/eval_by_page.py', '--ckpt', join(out, 'run/best.pt'), '--data', join(out, 'split'), '--json', join(out, 'report.json')]);
  await run(python, ['train/visualize.py', '--ckpt', join(out, 'run/best.pt'), '--data', join(out, 'split'), '--n', '12']);
  await copyFile(join(out, 'run/best.pt'), join(out, 'model.pt'));
  await copyFile(join(out, 'run/val_predictions.png'), join(out, 'examples.png'));

  const r = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  console.log(`\nmodel for ${id} in ${out}`);
  console.log(`on ${r.broken} broken and ${r.clean} clean frames from views it never trained on: AUROC ${r.auroc} ` +
    `(95% CI ${r.auroc_95ci.join('–')}); flagging 5% of clean frames, it catches ${Math.round(r.caught_at_5pct_false_alarms * 100)}% of glitches`);
  console.log(`examples: ${join(out, 'examples.png')}\ncheck screenshots: node framehound.mjs check ${out} shot.png`);
}

async function check() {
  const [model, ...images] = positional;
  if (!model || !images.length) throw new Error('usage: framehound check <model folder> <screenshot.png ...>');
  await run(python, ['train/check.py', '--model', mine(model), ...images.map(mine),
    ...(opts.out ? ['--out', mine(opts.out)] : []), ...(opts.threshold ? ['--threshold', String(opts.threshold)] : [])]);
}

const commands = { learn, check };
if (!commands[command]) {
  console.log('usage:\n  framehound learn <url> [--driver play.mjs] [--serve folder] [--minutes 10] [--out models/<id>]\n' +
    '  framehound check <model folder> <screenshot.png ...> [--out folder] [--threshold t]');
  process.exit(command ? 1 : 0);
}
commands[command]().catch((e) => {
  console.error(`framehound: ${e.message}`);
  process.exit(1);
});
