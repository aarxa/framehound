// Builds a random 3D scene from a seed, renders it clean, breaks it in one way, renders it again,
// and returns both frames plus a mask of the pixels the glitch changed.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import { GLITCHES } from './glitches.js';

export function rng(seed) {
  // mulberry32: small, fast, deterministic
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];
const range = (r, lo, hi) => lo + (hi - lo) * r();
const randomColor = (r) => new THREE.Color().setHSL(r(), range(r, 0.2, 0.8), range(r, 0.25, 0.7));

// ---------- assets (CC0 models and HDRIs from Poly Haven, fetched by scripts/fetch-assets.mjs) ----------
// Loaded once and shared between scenes. Anything shared is flagged so a scene never disposes or edits it.

const ASSET_ROOT = '/assets/';
let manifest = null;
async function loadManifest() {
  if (manifest) return manifest;
  try {
    const res = await fetch(`${ASSET_ROOT}manifest.json`);
    manifest = res.ok ? await res.json() : { models: [], hdris: [] };
  } catch {
    manifest = { models: [], hdris: [] };
  }
  return manifest;
}

const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap'];
const markShared = (root) => root.traverse((o) => {
  if (o.geometry) o.geometry.userData.shared = true;
  for (const m of [o.material].flat().filter(Boolean)) {
    for (const slot of TEXTURE_SLOTS) if (m[slot]) m[slot].userData.shared = true;
  }
});

const gltfLoader = new GLTFLoader();
const rgbeLoader = new RGBELoader();
const modelCache = new Map(); // id -> Promise<Object3D>; oldest evicted past MAX_MODELS
const MAX_MODELS = 24;
const hdriCache = new Map();

function disposeShared(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat().filter(Boolean)) {
      for (const slot of TEXTURE_SLOTS) m[slot]?.dispose();
      m.dispose();
    }
  });
}

function loadModel(entry) {
  if (modelCache.has(entry.id)) {
    const p = modelCache.get(entry.id);
    modelCache.delete(entry.id); // move to the back: most recently used
    modelCache.set(entry.id, p);
    return p;
  }
  const p = gltfLoader.loadAsync(ASSET_ROOT + entry.file).then((g) => {
    markShared(g.scene);
    return g.scene;
  });
  modelCache.set(entry.id, p);
  if (modelCache.size > MAX_MODELS) {
    const [oldId, oldP] = modelCache.entries().next().value;
    modelCache.delete(oldId);
    oldP.then(disposeShared);
  }
  return p;
}

function loadHdri(entry) {
  if (!hdriCache.has(entry.id)) {
    hdriCache.set(entry.id, rgbeLoader.loadAsync(ASSET_ROOT + entry.file).then((t) => {
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.userData.shared = true;
      return t;
    }));
  }
  return hdriCache.get(entry.id);
}

// A per-scene copy of a cached model: shares geometry and textures, owns its materials (glitches edit those).
function instance(model) {
  const copy = model.clone(true);
  copy.traverse((o) => {
    if (o.isMesh) {
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      o.castShadow = o.receiveShadow = true;
    }
  });
  return copy;
}

// ---------- procedural textures and shapes (no downloads) ----------

function canvasTexture(r, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const a = randomColor(r).getStyle();
  const b = randomColor(r).getStyle();
  const kind = pick(r, ['checker', 'stripes', 'bricks', 'dots', 'noise']);
  g.fillStyle = a;
  g.fillRect(0, 0, size, size);
  g.fillStyle = b;
  const n = 2 + Math.floor(r() * 10);
  const s = size / n;
  if (kind === 'checker') {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if ((x + y) % 2) g.fillRect(x * s, y * s, s, s);
  } else if (kind === 'stripes') {
    for (let i = 0; i < n; i += 2) g.fillRect(i * s, 0, s, size);
  } else if (kind === 'bricks') {
    g.strokeStyle = b;
    g.lineWidth = Math.max(2, s / 8);
    for (let y = 0; y < n; y++) {
      const off = (y % 2) * s / 2;
      for (let x = -1; x < n; x++) g.strokeRect(x * s + off, y * s, s, s);
    }
  } else if (kind === 'dots') {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      g.beginPath();
      g.arc((x + 0.5) * s, (y + 0.5) * s, s * 0.3, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    const img = g.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 0.6 + 0.4 * r();
      img.data[i] *= v; img.data[i + 1] *= v; img.data[i + 2] *= v;
    }
    g.putImageData(img, 0, 0);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

const SHAPES = [
  () => new THREE.BoxGeometry(1, 1, 1, 4, 4, 4),
  () => new THREE.SphereGeometry(0.6, 48, 24),
  () => new THREE.TorusKnotGeometry(0.45, 0.15, 160, 24),
  () => new THREE.CylinderGeometry(0.4, 0.4, 1.2, 40, 4),
  () => new THREE.ConeGeometry(0.5, 1.2, 40, 4),
  () => new THREE.IcosahedronGeometry(0.6, 1),
  () => new THREE.TorusGeometry(0.5, 0.18, 24, 64),
  () => new THREE.CapsuleGeometry(0.35, 0.6, 8, 24),
];

function primitive(r) {
  const mat = new THREE.MeshStandardMaterial({
    color: r() < 0.5 ? 0xffffff : randomColor(r),
    roughness: range(r, 0.1, 1),
    metalness: r() < 0.25 ? range(r, 0.5, 1) : 0,
  });
  if (r() < 0.65) {
    mat.map = canvasTexture(r);
    mat.map.repeat.set(1 + Math.floor(r() * 3), 1 + Math.floor(r() * 3));
  }
  const mesh = new THREE.Mesh(pick(r, SHAPES)(), mat);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// ---------- the scene ----------

const box = new THREE.Box3();
const size = new THREE.Vector3();

// Scale a thing to a target size and stand it on the floor at (x, z).
function place(obj, r, x, z) {
  obj.rotation.y = r() * Math.PI * 2;
  obj.updateMatrixWorld(true);
  box.setFromObject(obj).getSize(size);
  obj.scale.multiplyScalar(range(r, 0.5, 2.2) / Math.max(size.x, size.y, size.z, 1e-3));
  obj.updateMatrixWorld(true);
  box.setFromObject(obj);
  obj.position.set(x, -box.min.y, z);
  if (r() < 0.12 && obj.isMesh) obj.position.y += range(r, 0.2, 1.2); // the odd floating primitive
}

export async function buildScene(seed, width, height) {
  const r = rng(seed);
  const assets = await loadManifest();
  const scene = new THREE.Scene();

  const useHdri = assets.hdris.length > 0 && r() < 0.75;
  let env = null;
  if (useHdri) {
    env = await loadHdri(pick(r, assets.hdris));
    scene.environment = env;
    scene.background = env;
    scene.backgroundBlurriness = r() < 0.5 ? 0 : range(r, 0.05, 0.4);
    scene.environmentIntensity = range(r, 0.6, 1.6);
    scene.backgroundIntensity = scene.environmentIntensity;
    scene.environmentRotation.y = scene.backgroundRotation.y = r() * Math.PI * 2;
  } else {
    scene.background = randomColor(r).multiplyScalar(range(r, 0.4, 1.2));
    if (r() < 0.3) scene.fog = new THREE.Fog(scene.background, 8, range(r, 18, 40));
    scene.add(new THREE.HemisphereLight(randomColor(r), randomColor(r), range(r, 0.3, 1.2)));
  }

  // floor: a patterned one, a plain one, or (with an HDRI) the panorama's own ground with a shadow catcher on top
  const floorKind = env && r() < 0.35 ? 'grounded' : r() < 0.5 ? 'pattern' : 'plain';
  let floorMat;
  if (floorKind === 'grounded') {
    const camHeight = range(r, 8, 20); // how high the panorama was shot; sets the projected ground's scale
    const sky = new GroundedSkybox(env, camHeight, 100);
    sky.position.y = camHeight - 0.01; // its ground sits camHeight below its origin, so this puts it at y = 0
    sky.name = 'skybox';
    scene.add(sky);
    floorMat = new THREE.ShadowMaterial({ opacity: range(r, 0.3, 0.6) });
  } else if (floorKind === 'pattern') {
    const floorTex = canvasTexture(r, 512);
    floorTex.repeat.set(range(r, 2, 8), range(r, 2, 8));
    floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: range(r, 0.4, 1) });
  } else {
    floorMat = new THREE.MeshStandardMaterial({ color: randomColor(r).multiplyScalar(range(r, 0.5, 1.3)), roughness: range(r, 0.3, 1), metalness: r() < 0.15 ? 0.6 : 0 });
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  scene.add(floor);

  // things on the floor: mostly real models, some primitives
  const things = [];
  const nModels = assets.models.length ? 1 + Math.floor(r() * 5) : 0;
  const nPrims = Math.floor(r() * (nModels ? 3 : 7)) + (nModels ? 0 : 3);
  const entries = Array.from({ length: nModels }, () => pick(r, assets.models));
  const loaded = await Promise.all(entries.map(loadModel));
  loaded.forEach((m, i) => {
    const obj = instance(m);
    obj.name = entries[i].id;
    things.push(obj);
  });
  for (let i = 0; i < nPrims; i++) {
    const p = primitive(r);
    p.name = `primitive${i}`;
    things.push(p);
  }
  things.forEach((obj, i) => {
    const ang = (i / things.length) * Math.PI * 2 + range(r, -0.4, 0.4);
    const rad = things.length === 1 ? 0 : range(r, 0.5, 1 + 0.3 * things.length);
    place(obj, r, Math.cos(ang) * rad, Math.sin(ang) * rad);
    scene.add(obj);
  });

  // every mesh is a candidate for a glitch (a model's parts break one at a time, as in real engines)
  const objects = [];
  for (const t of things) t.traverse((o) => o.isMesh && objects.push(o));

  const sun = new THREE.DirectionalLight(0xffffff, useHdri ? range(r, 0.5, 2) : range(r, 1.5, 3.5));
  const sunAng = r() * Math.PI * 2;
  sun.position.set(Math.cos(sunAng) * 8, range(r, 4, 12), Math.sin(sunAng) * 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 0.5, far: 40 });
  scene.add(sun);

  // frame the group: back off far enough to fit its bounding sphere, from a random direction and height
  const sphere = new THREE.Sphere();
  scene.updateMatrixWorld(true);
  const all = new THREE.Box3();
  for (const t of things) all.union(box.setFromObject(t));
  all.getBoundingSphere(sphere);
  const fov = range(r, 35, 65);
  const camera = new THREE.PerspectiveCamera(fov, width / height, 0.05, 200);
  // under 1 lets the frame crop the group a little, which is how real game cameras look at things
  const dist = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(fov) / 2)) * range(r, 0.55, 1.0);
  const camAng = r() * Math.PI * 2;
  const elev = range(r, 0.1, 0.7);
  camera.position.set(
    sphere.center.x + Math.cos(camAng) * Math.cos(elev) * dist,
    Math.max(0.3, sphere.center.y + Math.sin(elev) * dist),
    sphere.center.z + Math.sin(camAng) * Math.cos(elev) * dist,
  );
  camera.lookAt(sphere.center.x + range(r, -0.3, 0.3), sphere.center.y + range(r, -0.3, 0.3), sphere.center.z + range(r, -0.3, 0.3));

  return { scene, camera, objects, floor, sun };
}

// ---------- render, glitch, diff ----------

let renderer;
function getRenderer(width, height) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(renderer.domElement);
  }
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  return renderer;
}

function grab(r, scene, camera, width, height) {
  r.render(scene, camera);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d').drawImage(r.domElement, 0, 0);
  return c;
}

const DIFF_THRESHOLD = 12; // per channel, 0–255: below this a pixel counts as unchanged

function diffMask(a, b) {
  const w = a.width;
  const h = a.height;
  const da = a.getContext('2d').getImageData(0, 0, w, h).data;
  const db = b.getContext('2d').getImageData(0, 0, w, h).data;
  const m = document.createElement('canvas');
  m.width = w;
  m.height = h;
  const g = m.getContext('2d');
  const out = g.createImageData(w, h);
  let changed = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
    const on = d > DIFF_THRESHOLD ? 255 : 0;
    if (on) changed++;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = on;
    out.data[i + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return { canvas: m, fraction: changed / (w * h) };
}

// Frees what this scene owns; shared model data and HDRIs stay cached.
function disposeScene(scene) {
  scene.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    for (const m of [o.material].flat().filter(Boolean)) {
      for (const slot of TEXTURE_SLOTS) if (m[slot] && !m[slot].userData.shared) m[slot].dispose();
      m.dispose();
    }
  });
}

const MIN_FRACTION = 0.002; // a glitch must change at least 0.2% of the frame to count as visible

export async function renderSample(seed, glitchName, width = 512, height = 512, maxAttempts = 8) {
  const glitch = GLITCHES[glitchName];
  if (!glitch) throw new Error(`unknown glitch: ${glitchName}`);
  const r = getRenderer(width, height);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const world = await buildScene(seed, width, height);
    const clean = grab(r, world.scene, world.camera, width, height);
    const info = glitch(world, rng(seed * 7919 + attempt * 104729 + 1));
    const glitched = grab(r, world.scene, world.camera, width, height);
    const { canvas: mask, fraction } = diffMask(clean, glitched);
    disposeScene(world.scene);
    if (fraction >= MIN_FRACTION) {
      return {
        ok: true,
        seed,
        glitch: glitchName,
        attempt,
        fraction,
        info,
        clean: clean.toDataURL('image/png'),
        glitched: glitched.toDataURL('image/png'),
        mask: mask.toDataURL('image/png'),
      };
    }
  }
  return { ok: false, seed, glitch: glitchName };
}

window.renderSample = renderSample;
window.glitchNames = Object.keys(GLITCHES);
window.ready = true;
