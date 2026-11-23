// Builds a random 3D scene from a seed, renders it clean, breaks it in one way, renders it again,
// and returns both frames plus a mask of the pixels the glitch changed.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { drawHud } from './hud.js';
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
const MAX_MODELS = 60; // game scenes use up to ~16 models each
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

// earthy, desaturated colours: what most game environments look like, unlike the bright test-scene palette
const mutedColor = (r) => new THREE.Color().setHSL(r(), range(r, 0.04, 0.35), range(r, 0.12, 0.55));

function canvasTexture(r, size = 256, color = randomColor) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const a = color(r).getStyle();
  const b = color(r).getStyle();
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

// Three quarters of scenes look like a game (an environment seen from eye level, post-processing, often a HUD);
// the rest are the original "props on a floor" scenes.
export async function buildScene(seed, width, height) {
  const r = rng(seed);
  const assets = await loadManifest();
  return r() < 0.75 ? buildGameScene(r, width, height, assets) : buildPropsScene(r, width, height, assets);
}

async function loadThings(r, assets, nModels, nPrims) {
  const entries = Array.from({ length: nModels }, () => pick(r, assets.models));
  const loaded = await Promise.all(entries.map(loadModel));
  const things = loaded.map((m, i) => Object.assign(instance(m), { name: entries[i].id }));
  for (let i = 0; i < nPrims; i++) things.push(Object.assign(primitive(r), { name: `primitive${i}` }));
  return things;
}

function makeSun(r, intensity, extent) {
  const sun = new THREE.DirectionalLight(0xffffff, intensity);
  const a = r() * Math.PI * 2;
  sun.position.set(Math.cos(a) * extent, range(r, 0.5, 1.3) * extent, Math.sin(a) * extent);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 0.5, far: extent * 4 });
  return sun;
}

const at = (obj, x, y, z) => {
  obj.position.set(x, y, z);
  return obj;
};

function solid(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function wallMaterial(r, repeatX, repeatY) {
  const map = canvasTexture(r, 256, mutedColor);
  map.repeat.set(repeatX, repeatY);
  return new THREE.MeshStandardMaterial({ map, roughness: range(r, 0.6, 1), metalness: r() < 0.1 ? 0.5 : 0 });
}

async function buildGameScene(r, width, height, assets) {
  const scene = new THREE.Scene();
  let env = null;
  if (assets.hdris.length && r() < 0.85) {
    env = await loadHdri(pick(r, assets.hdris));
    scene.environment = scene.background = env;
    scene.environmentIntensity = scene.backgroundIntensity = range(r, 0.5, 1.4);
    scene.environmentRotation.y = scene.backgroundRotation.y = r() * Math.PI * 2;
  } else {
    scene.background = mutedColor(r);
    scene.add(new THREE.HemisphereLight(mutedColor(r), mutedColor(r), range(r, 0.4, 1.2)));
  }
  if (r() < 0.4) scene.fog = new THREE.Fog(new THREE.Color().setHSL(r(), 0.1, range(r, 0.3, 0.8)), range(r, 5, 20), range(r, 30, 90));

  const groundMap = canvasTexture(r, 512, mutedColor);
  groundMap.repeat.set(range(r, 20, 60), range(r, 20, 60));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ map: groundMap, roughness: range(r, 0.5, 1) }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  scene.add(floor);

  // the space: a room, a street, or a plaza ringed by buildings
  const layout = pick(r, ['room', 'street', 'plaza']);
  const structures = [];
  let bounds;
  if (layout === 'room') {
    const W = range(r, 8, 18), D = range(r, 8, 18), H = range(r, 3, 6), t = 0.3;
    const mat = wallMaterial(r, W / 3, H / 3);
    structures.push(at(solid(W, H, t, mat), 0, H / 2, -D / 2));
    structures.push(at(solid(W, H, t, mat), 0, H / 2, D / 2));
    structures.push(at(solid(t, H, D, mat), -W / 2, H / 2, 0));
    structures.push(at(solid(t, H, D, mat), W / 2, H / 2, 0));
    if (r() < 0.4) structures.push(at(solid(W, t, D, wallMaterial(r, W / 3, D / 3)), 0, H, 0));
    for (let i = 0, n = 1 + Math.floor(r() * 3); i < n; i++) {
      const lamp = new THREE.PointLight(new THREE.Color().setHSL(range(r, 0.05, 0.15), 0.6, 0.7), range(r, 40, 140), 0, 2);
      lamp.position.set(range(r, -W / 3, W / 3), H - 0.5, range(r, -D / 3, D / 3));
      scene.add(lamp);
    }
    scene.add(new THREE.HemisphereLight(0xfff2e0, 0x404040, range(r, 0.4, 1.0))); // bounce light a real engine would fake too
    bounds = { x: W / 2 - 0.8, z: D / 2 - 0.8 };
  } else if (layout === 'street') {
    const L = 50, road = range(r, 6, 12);
    for (const side of [-1, 1]) {
      for (let x = -L / 2; x < L / 2;) {
        const w = range(r, 4, 10), h = range(r, 5, 20), d = range(r, 6, 10);
        structures.push(at(solid(w, h, d, wallMaterial(r, w / 3, h / 3)), x + w / 2, h / 2, side * (road / 2 + d / 2)));
        x += w + (r() < 0.3 ? range(r, 0.5, 3) : 0);
      }
    }
    bounds = { x: L / 2 - 2, z: road / 2 - 0.5 };
  } else {
    const S = range(r, 16, 30);
    for (let i = 0, n = 4 + Math.floor(r() * 5); i < n; i++) {
      const a = (i / n) * Math.PI * 2 + range(r, -0.3, 0.3);
      const w = range(r, 4, 10), h = range(r, 4, 16), d = range(r, 4, 10);
      const b = solid(w, h, d, wallMaterial(r, w / 3, h / 3));
      b.position.set(Math.cos(a) * (S / 2 + d / 2), h / 2, Math.sin(a) * (S / 2 + d / 2));
      b.rotation.y = -a;
      structures.push(b);
    }
    bounds = { x: S / 2 - 1, z: S / 2 - 1 };
  }
  structures.forEach((s, i) => {
    s.name = `structure${i}`;
    scene.add(s);
  });

  const things = await loadThings(r, assets, 6 + Math.floor(r() * 11), Math.floor(r() * 3));
  for (const obj of things) {
    place(obj, r, range(r, -bounds.x, bounds.x), range(r, -bounds.z, bounds.z));
    scene.add(obj);
  }

  const objects = [...structures];
  for (const t of things) t.traverse((o) => o.isMesh && objects.push(o));

  const sun = makeSun(r, env ? range(r, 0.6, 2.2) : range(r, 1.5, 3.5), 25);
  scene.add(sun);

  // eye-level camera (first person) or a bit higher (third person), looking at one of the props
  scene.updateMatrixWorld(true);
  const focus = box.setFromObject(pick(r, things)).getCenter(new THREE.Vector3());
  const fov = range(r, 55, 85);
  const camera = new THREE.PerspectiveCamera(fov, width / height, 0.05, 300);
  const a = r() * Math.PI * 2;
  const dist = range(r, 2.5, 9);
  camera.position.set(
    THREE.MathUtils.clamp(focus.x + Math.cos(a) * dist, -bounds.x, bounds.x),
    r() < 0.7 ? range(r, 1.2, 2.0) : range(r, 2.5, 4),
    THREE.MathUtils.clamp(focus.z + Math.sin(a) * dist, -bounds.z, bounds.z),
  );
  camera.lookAt(focus.x + range(r, -1, 1), focus.y + range(r, -0.4, 0.6), focus.z + range(r, -1, 1));

  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const inView = objects.filter((o) => frustum.intersectsObject(o));
  const exposure = range(r, 0.8, 1.5);

  const post = r() < 0.85 ? {
    bloom: range(r, 0.05, 0.9), bloomRadius: range(r, 0.2, 0.8), bloomThreshold: range(r, 0.6, 0.95),
    vignette: range(r, 0, 0.6), contrast: range(r, 0.9, 1.25), saturation: range(r, 0.7, 1.25),
    tint: [1 + range(r, -0.08, 0.08), 1 + range(r, -0.08, 0.08), 1 + range(r, -0.08, 0.08)],
    grain: r() < 0.5 ? range(r, 0.01, 0.06) : 0, aberration: r() < 0.3 ? range(r, 0.001, 0.006) : 0, noiseSeed: r() * 100,
  } : null;
  const hud = r() < 0.55 ? Math.floor(r() * 1e9) : null;
  return { scene, camera, objects: inView.length ? inView : objects, floor, sun, post, hud, exposure, style: `game-${layout}` };
}

async function buildPropsScene(r, width, height, assets) {
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

  return { scene, camera, objects, floor, sun, post: null, hud: null, style: 'props' };
}

// ---------- render, glitch, diff ----------

// Final look: contrast, saturation, tint, vignette, film grain and chromatic aberration, in display space.
// The grain is seeded per scene, so it is identical in the clean and glitched frames and never enters the mask.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uVignette: { value: 0 }, uContrast: { value: 1 }, uSaturation: { value: 1 },
    uTint: { value: new THREE.Vector3(1, 1, 1) }, uGrain: { value: 0 }, uAberration: { value: 0 }, uSeed: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uVignette, uContrast, uSaturation, uGrain, uAberration, uSeed; uniform vec3 uTint;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      vec3 c = vec3(texture2D(tDiffuse, vUv + d * uAberration).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - d * uAberration).b);
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      c *= uTint;
      c *= 1.0 - uVignette * dot(d, d) * 2.0;
      c += (hash(floor(vUv * 2048.0)) - 0.5) * uGrain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

let renderer, composer, renderPass, bloomPass, gradePass, composerSize = '';
function getRenderer(width, height) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(renderer.domElement);
    composer = new EffectComposer(renderer);
    renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.5, 0.4, 0.85);
    gradePass = new ShaderPass(GradeShader);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass()); // tone mapping + sRGB, then the grade works on display colours
    composer.addPass(gradePass);
  }
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  if (composerSize !== `${width}x${height}`) {
    composer.setSize(width, height);
    composerSize = `${width}x${height}`;
  }
  return renderer;
}

function grab(r, world, width, height) {
  const { scene, camera, post, hud } = world;
  r.toneMappingExposure = world.exposure ?? 1;
  if (post) {
    renderPass.scene = scene;
    renderPass.camera = camera;
    Object.assign(bloomPass, { strength: post.bloom, radius: post.bloomRadius, threshold: post.bloomThreshold });
    const u = gradePass.uniforms;
    u.uVignette.value = post.vignette;
    u.uContrast.value = post.contrast;
    u.uSaturation.value = post.saturation;
    u.uTint.value.set(...post.tint);
    u.uGrain.value = post.grain;
    u.uAberration.value = post.aberration;
    u.uSeed.value = post.noiseSeed;
    composer.render();
  } else {
    r.render(scene, camera);
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  g.drawImage(r.domElement, 0, 0);
  if (hud !== null && hud !== undefined) drawHud(g, width, height, rng(hud)); // same seed, same overlay on both frames
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

function meanLuminance(canvas) {
  const s = document.createElement('canvas');
  s.width = 64;
  s.height = 36;
  const g = s.getContext('2d');
  g.drawImage(canvas, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return sum / (d.length / 4) / 255;
}

// Like a game's auto-exposure: nudge exposure until the frame's average brightness lands near a target,
// so no scene comes out blown-out white or nearly black. Done before the clean frame; the glitch never sees it.
function autoExpose(r, world, width, height, rand) {
  const target = 0.28 + 0.2 * rand();
  world.exposure = world.exposure ?? 1;
  for (let i = 0; i < 3; i++) {
    const mean = meanLuminance(grab(r, world, width, height));
    if (Math.abs(mean - target) < 0.04) break;
    world.exposure = THREE.MathUtils.clamp(world.exposure * Math.pow(target / Math.max(mean, 0.01), 1.5), 0.05, 6);
  }
}

export async function renderSample(seed, glitchName, width = 512, height = 512, maxAttempts = 8) {
  const glitch = GLITCHES[glitchName];
  if (!glitch) throw new Error(`unknown glitch: ${glitchName}`);
  const r = getRenderer(width, height);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const world = await buildScene(seed, width, height);
    autoExpose(r, world, width, height, rng(seed + 17));
    const clean = grab(r, world, width, height);
    const info = glitch(world, rng(seed * 7919 + attempt * 104729 + 1));
    const glitched = grab(r, world, width, height);
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
        style: world.style,
        post: Boolean(world.post),
        hud: world.hud !== null && world.hud !== undefined,
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
