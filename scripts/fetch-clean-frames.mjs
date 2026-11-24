// Downloads three.js's own reference screenshots (one clean render per official example, MIT) into eval-data/.
// They are frames from a real engine that should contain no glitch, so they measure false alarms.
// Usage: node scripts/fetch-clean-frames.mjs [--tag r170]
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const tag = args.tag ?? 'r170'; // the three.js version the generator uses
const out = join(root, 'eval-data', `threejs-${tag}`);
const headers = { 'User-Agent': 'framehound-eval/0.1' };
const raw = (path) => `https://raw.githubusercontent.com/mrdoob/three.js/${tag}/${path}`;

async function get(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
}

// three.js leaves some examples out of its own screenshot test (not deterministic, text differs between systems, ...).
// Record which, so results can be read with and without them.
const testScript = await (await get(raw('test/e2e/puppeteer.js'))).text();
const listSource = testScript.slice(testScript.indexOf('const exceptionList = ['), testScript.indexOf('];', testScript.indexOf('const exceptionList')));
const skippedByThree = new Set([...listSource.matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1]));

const tree = await (await get(`https://api.github.com/repos/mrdoob/three.js/git/trees/${tag}?recursive=1`)).json();
const shots = tree.tree.filter((e) => e.path.startsWith('examples/screenshots/') && e.path.endsWith('.jpg'));
await mkdir(out, { recursive: true });

let bytes = 0;
let next = 0;
async function worker() {
  while (next < shots.length) {
    const e = shots[next++];
    const file = join(out, e.path.split('/').pop());
    try {
      await stat(file);
      continue; // already have it
    } catch {}
    const buf = Buffer.from(await (await get(raw(e.path))).arrayBuffer());
    await writeFile(file, buf);
    bytes += buf.length;
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

const files = shots.map((e) => {
  const name = e.path.split('/').pop().replace(/\.jpg$/, '');
  return { file: `${name}.jpg`, example: name, skipped_in_threejs_tests: skippedByThree.has(name) };
});
const manifest = { source: `https://github.com/mrdoob/three.js/tree/${tag}/examples/screenshots`, license: 'MIT', tag, fetched: new Date().toISOString(), files };
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`${files.length} screenshots (${files.filter((f) => f.skipped_in_threejs_tests).length} left out of three.js's own tests), ${(bytes / 1e6).toFixed(1)} MB new, in ${out}`);
