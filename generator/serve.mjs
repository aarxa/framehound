// A plain static server for pages kept on disk; only files under the served folder are reachable.
//
// fetchBase: a file missing from the folder is fetched from <fetchBase>/<path> and kept, so a page at a given version
// can be served without downloading a whole repository (for three.js: the folder holds one subfolder per release tag,
// and the base is https://raw.githubusercontent.com/mrdoob/three.js).
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

export async function serveFolder(folder, fetchBase = null) {
  const dir = resolve(folder);
  const fetching = new Map();
  const fetchMissing = (path) => {
    const rel = path.slice(dir.length).replace(/^\/+/, '');
    if (!fetching.has(rel)) {
      fetching.set(rel, (async () => {
        const res = await fetch(`${String(fetchBase).replace(/\/$/, '')}/${rel}`, { headers: { 'User-Agent': 'framehound/0.1' } });
        if (!res.ok) return null;
        const body = Buffer.from(await res.arrayBuffer());
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, body);
        return body;
      })().catch(() => null));
    }
    return fetching.get(rel);
  };
  const server = createServer(async (req, res) => {
    const path = normalize(join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(dir)) return res.writeHead(403).end();
    let body = await readFile(path).catch(() => null);
    if (!body && fetchBase) body = await fetchMissing(path);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' }).end(body);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
