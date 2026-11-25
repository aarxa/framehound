#!/usr/bin/env node
// framehound: learn what one WebGL app looks like broken, then check its screenshots for rendering glitches.
//
//   node framehound.mjs learn <url> [--id name] [--driver play.mjs] [--serve folder] [--minutes 10] [--epochs 15]
//                                   [--out models/<id>]
//   node framehound.mjs check <model folder> <screenshot.png ...> [--out folder] [--threshold 0.8]
//   node framehound.mjs watch <model folder> <url> [--driver play.mjs] [--serve folder] [--minutes 5] [--out folder]
//   node framehound.mjs learn-native --id name [--every 5] [--captures 140] -- <Vulkan app command>
//   node framehound.mjs watch-native <model folder> [--every 20] [--count 15] -- <Vulkan app command>
//
// learn opens the app in headless Chrome, freezes it at moments spread over --minutes of play, breaks each frame's
// draw calls in eleven ways (generator/inject/glitch-gl.js), and trains a detector on the result. The last fifth of the
// moments is held out, and report.json says how well the model does on those views it never trained on, with the
// score threshold that flags 5% of clean frames. A driver (--driver) gets a game past its menus and plays it between
// moments; without one, the camera is dragged a little. A url starting with "/" is served from --serve.
//
// watch plays the app (a new build, say) the same way and checks every frame it stops on. For each frame the model
// flags, it finds the draw calls that drew the flagged pixels and writes them into report.html with their shader,
// textures and size (generator/watch.mjs). --plant 0.5 tests watch itself by breaking a known draw on half the frames.
//
// learn-native and watch-native do the same for a native Vulkan app, through the layer in native/ (build it first, see
// native/README.md). The app runs with the layer loaded; for watch it runs twice, so it has to draw the same frames
// each time (a deterministic app, or a GFXReconstruct replay of a recording).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const [command, ...all] = process.argv.slice(2);
// everything after a lone "--" is the command line of a native app
const split = all.indexOf('--');
const rest = split < 0 ? all : all.slice(0, split);
const appCommand = split < 0 ? [] : all.slice(split + 1);
const positional = [];
const opts = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  else positional.push(rest[i]);
}
const python = process.env.FRAMEHOUND_PYTHON ?? (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
const mine = (p) => resolve(process.cwd(), String(p)); // paths the user gives are relative to where they ran us

function run(cmd, argv, { env, cwd = root } = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, argv, { cwd, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env });
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

async function watch() {
  const [model, url] = positional;
  if (!model || !url) throw new Error('usage: framehound watch <model folder> <url> [--driver play.mjs] [--serve folder] [--minutes 5]');
  const id = String(opts.id ?? basename(mine(model)));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const out = mine(opts.out ?? join('watch', `${id}-${stamp}`));
  const pass = ['minutes', 'moments', 'gap', 'warmup', 'threshold', 'plant', 'types', 'seed', 'fetch-missing']
    .flatMap((k) => (opts[k] !== undefined ? [`--${k}`, String(opts[k])] : []));
  await run(process.execPath, ['generator/watch.mjs', '--model', mine(model), '--url', url, '--id', id, '--out', out, ...pass,
    ...(opts.driver ? ['--driver', mine(opts.driver)] : []), ...(opts.serve ? ['--serve', mine(opts.serve)] : [])]);
}

// learn for a native Vulkan app: the layer breaks its draws while it runs, then the same split, training and test as
// learn
async function learnNative() {
  if (!appCommand.length) throw new Error('usage: framehound learn-native --id name [--every 5] [--captures 140] -- <app command>');
  const id = String(opts.id ?? basename(appCommand[0])).replace(/[^\w-]+/g, '_');
  const out = mine(opts.out ?? join('models', id));
  const step = (n, text) => console.log(`\n[${n}/4] ${text}`);
  step(1, `running ${appCommand.join(' ')} with the framehound layer`);
  await rm(join(out, 'frames'), { recursive: true, force: true }); // the layer appends to its manifest
  await run(appCommand[0], appCommand.slice(1), {
    cwd: process.cwd(),
    env: {
      VK_ADD_LAYER_PATH: join(root, 'native/build'), VK_INSTANCE_LAYERS: 'VK_LAYER_FRAMEHOUND_glitch',
      FRAMEHOUND_OUT: join(out, 'frames'), FRAMEHOUND_APP: id, FRAMEHOUND_START: String(opts.start ?? 10),
      FRAMEHOUND_EVERY: String(opts.every ?? 5), FRAMEHOUND_CAPTURES: String(opts.captures ?? 140),
      FRAMEHOUND_VARIANTS: String(opts.variants ?? 10), ...(opts['shadow-all'] ? { FRAMEHOUND_SHADOW_ALL: '1' } : {}),
    },
  });
  step(2, 'holding out the last fifth of the frames for testing');
  await run(python, ['-I', 'scripts/split_same_page.py', join(out, 'frames'), join(out, 'split'), '--last-share', '0.2']);
  step(3, 'training');
  await run(python, ['train/train.py', '--data', join(out, 'split'), '--out', join(out, 'run'), '--epochs', String(opts.epochs ?? 15)]);
  step(4, 'testing on the held-out frames');
  await run(python, ['train/eval_by_page.py', '--ckpt', join(out, 'run/best.pt'), '--data', join(out, 'split'), '--json', join(out, 'report.json')]);
  await copyFile(join(out, 'run/best.pt'), join(out, 'model.pt'));
  const r = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  console.log(`\nmodel for ${id} in ${out}: AUROC ${r.auroc} (95% CI ${r.auroc_95ci.join('–')}) on held-out frames`);
}

// watch for a native Vulkan app: native/locate.py runs it twice, checks its frames and names the draws behind flags
async function watchNative() {
  const [model] = positional;
  if (!model || !appCommand.length) throw new Error('usage: framehound watch-native <model folder> [--every 20] [--count 15] -- <app command>');
  const id = String(opts.id ?? basename(mine(model)));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const pass = ['start', 'every', 'count', 'expect'].flatMap((k) => (opts[k] !== undefined ? [`--${k}`, String(opts[k])] : []));
  await run(python, [join(root, 'native/locate.py'), '--model', mine(model), '--id', id, '--out', mine(opts.out ?? join('watch', `${id}-${stamp}`)),
    ...pass, '--', ...appCommand], { cwd: process.cwd() });
}

const commands = { learn, check, watch, 'learn-native': learnNative, 'watch-native': watchNative };
if (!commands[command]) {
  console.log('usage:\n  framehound learn <url> [--driver play.mjs] [--serve folder] [--minutes 10] [--out models/<id>]\n' +
    '  framehound check <model folder> <screenshot.png ...> [--out folder] [--threshold t]\n' +
    '  framehound watch <model folder> <url> [--driver play.mjs] [--serve folder] [--minutes 5] [--out folder]\n' +
    '  framehound learn-native --id name [--every 5] [--captures 140] -- <Vulkan app command>\n' +
    '  framehound watch-native <model folder> [--every 20] [--count 15] -- <Vulkan app command>');
  process.exit(command ? 1 : 0);
}
commands[command]().catch((e) => {
  console.error(`framehound: ${e.message}`);
  process.exit(1);
});
