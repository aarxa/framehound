// Downloads a fixed, varied set of CC0 models and HDRIs from Poly Haven into assets/ (not committed).
// The choice is seeded, so running it again picks the same assets.
// Usage: node scripts/fetch-assets.mjs [--models 80] [--hdris 24] [--budget-mb 250]
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const wantModels = Number(args.models ?? 80);
const wantHdris = Number(args.hdris ?? 24);
const budget = Number(args['budget-mb'] ?? 250) * 1e6;
const MAX_MODEL_BYTES = 15e6;

// Poly Haven asks API clients to identify themselves with a unique user agent.
const headers = { 'User-Agent': 'glitch-detector-dataset/0.1' };
const api = async (path) => {
  const res = await fetch(`https://api.polyhaven.com${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function download(url, file) {
  try {
    await stat(file);
    return 0; // already have it
  } catch {}
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  await sleep(100);
  return buf.length;
}

function shuffled(list, seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Objects that sit on a floor and fit in a frame; trees, ground cover and whole structures are too big for these scenes.
const MODEL_KINDS = ['props', 'furniture', 'decorative', 'tools', 'containers', 'electronics', 'appliances', 'food', 'lighting', 'seating', 'table', 'shelves', 'rocks', 'plants', 'industrial'];
const SKIP_KINDS = ['trees', 'ground cover', 'structures'];
const HDRI_KINDS = ['indoor', 'outdoor', 'studio', 'night', 'sunrise-sunset', 'overcast', 'urban'];

const manifest = { source: 'https://polyhaven.com', license: 'CC0', fetched: new Date().toISOString(), models: [], hdris: [] };
let total = 0;

const models = await api('/assets?t=models');
const candidates = shuffled(
  Object.entries(models)
    .filter(([, m]) => m.categories.some((c) => MODEL_KINDS.includes(c)) && !m.categories.some((c) => SKIP_KINDS.includes(c)))
    .map(([id]) => id)
    .sort(),
  20261123,
);
for (const id of candidates) {
  if (manifest.models.length >= wantModels || total > budget * 0.85) break;
  const files = await api(`/files/${id}`);
  const g = files.gltf?.['1k']?.gltf;
  if (!g) continue;
  const size = g.size + Object.values(g.include ?? {}).reduce((s, f) => s + f.size, 0);
  if (size > MAX_MODEL_BYTES) continue;
  const dir = join(root, 'assets', 'models', id);
  let got = await download(g.url, join(dir, `${id}.gltf`));
  for (const [path, f] of Object.entries(g.include ?? {})) got += await download(f.url, join(dir, path));
  total += size;
  manifest.models.push({ id, name: models[id].name, categories: models[id].categories, file: `models/${id}/${id}.gltf`, bytes: size });
  console.log(`model ${manifest.models.length}/${wantModels} ${id} ${(size / 1e6).toFixed(1)} MB${got ? '' : ' (cached)'}`);
}

const hdris = await api('/assets?t=hdris');
// round-robin over lighting kinds so the set isn't all sunny skies
const byKind = HDRI_KINDS.map((k, i) => shuffled(Object.keys(hdris).filter((id) => hdris[id].categories.includes(k)).sort(), 1123 + i));
const chosen = new Set();
for (let i = 0; chosen.size < wantHdris && i < 1000; i++) {
  const list = byKind[i % byKind.length];
  const id = list.find((x) => !chosen.has(x));
  if (id) chosen.add(id);
}
for (const id of chosen) {
  const files = await api(`/files/${id}`);
  const h = files.hdri?.['1k']?.hdr;
  if (!h) continue;
  const got = await download(h.url, join(root, 'assets', 'hdris', `${id}.hdr`));
  total += h.size;
  manifest.hdris.push({ id, name: hdris[id].name, categories: hdris[id].categories, file: `hdris/${id}.hdr`, bytes: h.size });
  console.log(`hdri ${manifest.hdris.length}/${wantHdris} ${id} ${(h.size / 1e6).toFixed(1)} MB${got ? '' : ' (cached)'}`);
}

await writeFile(join(root, 'assets', 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`done: ${manifest.models.length} models, ${manifest.hdris.length} HDRIs, ${(total / 1e6).toFixed(0)} MB`);
