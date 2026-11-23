// Builds a random 3D scene from a seed, renders it clean, breaks it in one way, renders it again,
// and returns both frames plus a mask of the pixels the glitch changed.
import * as THREE from 'three';
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

// ---------- procedural textures (no downloads) ----------

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

// ---------- the scene ----------

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

export function buildScene(seed, width, height) {
  const r = rng(seed);
  const scene = new THREE.Scene();
  scene.background = randomColor(r).multiplyScalar(range(r, 0.4, 1.2));
  if (r() < 0.3) scene.fog = new THREE.Fog(scene.background, 8, range(r, 18, 40));

  const floorTex = canvasTexture(r, 512);
  floorTex.repeat.set(range(r, 2, 8), range(r, 2, 8));
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: range(r, 0.4, 1) }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  scene.add(floor);

  const objects = [];
  const count = 3 + Math.floor(r() * 6);
  for (let i = 0; i < count; i++) {
    const geo = pick(r, SHAPES)();
    const mat = new THREE.MeshStandardMaterial({
      color: r() < 0.5 ? 0xffffff : randomColor(r),
      roughness: range(r, 0.1, 1),
      metalness: r() < 0.25 ? range(r, 0.5, 1) : 0,
    });
    if (r() < 0.65) {
      mat.map = canvasTexture(r);
      mat.map.repeat.set(1 + Math.floor(r() * 3), 1 + Math.floor(r() * 3));
    }
    const mesh = new THREE.Mesh(geo, mat);
    const s = range(r, 0.6, 1.8);
    mesh.scale.setScalar(s);
    const ang = r() * Math.PI * 2;
    const rad = range(r, 0, 3.2);
    mesh.position.set(Math.cos(ang) * rad, 0.6 * s + (r() < 0.2 ? range(r, 0.3, 1.5) : 0), Math.sin(ang) * rad);
    mesh.rotation.set(range(r, -0.4, 0.4), r() * Math.PI * 2, range(r, -0.4, 0.4));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = `object${i}`;
    scene.add(mesh);
    objects.push(mesh);
  }

  scene.add(new THREE.HemisphereLight(randomColor(r), randomColor(r), range(r, 0.3, 1.2)));
  const sun = new THREE.DirectionalLight(0xffffff, range(r, 1.5, 3.5));
  const sunAng = r() * Math.PI * 2;
  sun.position.set(Math.cos(sunAng) * 8, range(r, 4, 12), Math.sin(sunAng) * 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 0.5, far: 40 });
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(range(r, 35, 65), width / height, 0.05, 200);
  const camAng = r() * Math.PI * 2;
  const camDist = range(r, 6, 11);
  camera.position.set(Math.cos(camAng) * camDist, range(r, 1.5, 6), Math.sin(camAng) * camDist);
  camera.lookAt(range(r, -0.5, 0.5), range(r, 0.3, 1.2), range(r, -0.5, 0.5));

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

function disposeScene(scene) {
  scene.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      m.map?.dispose();
      m.dispose();
    }
  });
}

const MIN_FRACTION = 0.002; // a glitch must change at least 0.2% of the frame to count as visible

export function renderSample(seed, glitchName, width = 512, height = 512, maxAttempts = 8) {
  const glitch = GLITCHES[glitchName];
  if (!glitch) throw new Error(`unknown glitch: ${glitchName}`);
  const r = getRenderer(width, height);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const world = buildScene(seed, width, height);
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
