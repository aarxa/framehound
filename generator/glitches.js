// Each glitch breaks the scene in one way that real renderers break, and returns a short note on what it did.
// It gets the built world ({ scene, camera, objects, floor, sun }; floor can be null) and its own seeded random function.
// `objects` are individual meshes, often parts of a bigger model. Their geometry may be shared with a cache,
// so a glitch that edits geometry clones it first; materials are per-scene copies and safe to edit.
import * as THREE from 'three';

const pick = (r, list) => list[Math.floor(r() * list.length)];
const range = (r, lo, hi) => lo + (hi - lo) * r();
const materialsOf = (mesh) => [mesh.material].flat();

// A private copy of a mesh's geometry (never the cached one), so edits don't leak into other scenes.
function ownGeometry(mesh) {
  mesh.geometry = mesh.geometry.clone();
  mesh.geometry.userData = {};
  return mesh.geometry;
}

function checkerTexture(a, b, cells = 8, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const s = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      g.fillStyle = (x + y) % 2 ? a : b;
      g.fillRect(x * s, y * s, s, s);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// A texture failed to load and the engine shows its fallback: magenta/black checker, flat magenta, or black.
function missingTexture({ objects, floor }, r) {
  const target = floor && r() < 0.1 ? floor : pick(r, objects);
  const style = pick(r, ['magenta-checker', 'magenta', 'black']);
  for (const mat of materialsOf(target)) {
    mat.color?.set(0xffffff);
    mat.map = style === 'magenta-checker'
      ? checkerTexture('#ff00ff', '#000000', pick(r, [4, 8, 16]))
      : style === 'magenta' ? checkerTexture('#ff00ff', '#ff00ff', 1) : checkerTexture('#000000', '#000000', 1);
    mat.needsUpdate = true;
  }
  return { target: target.name, style };
}

// A few vertices get garbage positions and the mesh shoots spikes across the frame.
function explodedVertices({ objects }, r) {
  const target = pick(r, objects);
  const pos = ownGeometry(target).attributes.position;
  const worldScale = target.getWorldScale(new THREE.Vector3()).x || 1;
  const count = 1 + Math.floor(r() * 5);
  const dir = new THREE.Vector3();
  for (let k = 0; k < count; k++) {
    const i = Math.floor(r() * pos.count);
    dir.set(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(range(r, 2, 8) / worldScale);
    pos.setXYZ(i, pos.getX(i) + dir.x, pos.getY(i) + dir.y, pos.getZ(i) + dir.z);
  }
  pos.needsUpdate = true;
  target.geometry.computeBoundingSphere();
  return { target: target.name, vertices: count };
}

// Two surfaces share (almost) the same depth and flicker through each other in stripes.
function zFighting({ scene, objects, floor }, r) {
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(r(), 0.7, 0.5), roughness: 0.6 });
  if (floor && r() < 0.4) {
    // a decal or second floor placed exactly on the floor
    const size = range(r, 3, 12);
    const patch = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    // A hair of tilt makes the depth difference cross zero, so neither surface wins everywhere. Offsets and tilt
    // must stay below the depth buffer's precision (~1e-4 units at these distances) or one surface simply wins.
    patch.rotation.set(-Math.PI / 2 + range(r, -1e-5, 1e-5), range(r, -1e-5, 1e-5), r() * Math.PI);
    patch.position.set(range(r, -2, 2), floor.position.y + range(r, -0.00001, 0.00001), range(r, -2, 2));
    patch.receiveShadow = true;
    scene.add(patch);
    return { target: floor.name, with: 'floor patch' };
  }
  // a duplicate of a mesh in the same parent, scaled by a hair (again, below depth precision)
  const target = pick(r, objects);
  const twin = new THREE.Mesh(target.geometry, mat);
  twin.position.copy(target.position);
  twin.quaternion.copy(target.quaternion);
  twin.scale.copy(target.scale).multiplyScalar(1 + range(r, -0.00002, 0.00002));
  twin.castShadow = twin.receiveShadow = true;
  target.parent.add(twin);
  return { target: target.name, with: 'duplicate' };
}

// Shading breaks (NaN normals, a failed shader) and the object renders black.
function blackObject({ objects }, r) {
  const target = pick(r, objects);
  const how = target.geometry.attributes.normal ? pick(r, ['black-material', 'nan-normals']) : 'black-material';
  if (how === 'black-material') {
    target.material = new THREE.MeshBasicMaterial({ color: 0x000000 });
  } else {
    const n = ownGeometry(target).attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, NaN, NaN, NaN);
    n.needsUpdate = true;
  }
  return { target: target.name, how };
}

// Winding or culling is flipped and the object renders inside out (you see its back faces).
function insideOut({ objects }, r) {
  const closed = objects.filter((o) => !(o.geometry instanceof THREE.PlaneGeometry));
  const target = pick(r, closed.length ? closed : objects);
  for (const mat of materialsOf(target)) {
    mat.side = THREE.BackSide;
    mat.needsUpdate = true;
  }
  return { target: target.name };
}

// The shadow bias is wrong, so surfaces shadow themselves in stripes and moiré ("shadow acne").
function shadowAcne({ sun }, r) {
  const how = pick(r, ['zero-bias', 'positive-bias', 'low-res-zero-bias']);
  // just slightly wrong gives stripes; much more than ~0.001 shadows whole surfaces instead, which isn't acne
  sun.shadow.bias = how === 'positive-bias' ? range(r, 0.0001, 0.0006) : 0;
  sun.shadow.normalBias = 0;
  if (how === 'low-res-zero-bias') sun.shadow.mapSize.set(256, 256);
  if (sun.shadow.map) {
    // the shadow map is rebuilt on the next render with the new settings
    sun.shadow.map.dispose();
    sun.shadow.map = null;
  }
  return { how, bias: sun.shadow.bias };
}

// Texture coordinates are corrupted, so the texture smears into streaks or turns to noise.
function stretchedTexture({ objects }, r) {
  const textured = objects.filter((o) => o.geometry.attributes.uv && materialsOf(o).some((m) => m.map));
  if (!textured.length) return { target: null }; // nothing textured to break; the sample gets retried
  const target = pick(r, textured);
  const uv = ownGeometry(target).attributes.uv;
  const how = pick(r, ['collapse-u', 'collapse-v', 'shrink', 'scramble']);
  const cu = r();
  const cv = r();
  const k = range(r, 0.005, 0.03);
  for (let i = 0; i < uv.count; i++) {
    if (how === 'collapse-u') uv.setX(i, cu);
    else if (how === 'collapse-v') uv.setY(i, cv);
    else if (how === 'shrink') uv.setXY(i, cu + (uv.getX(i) - cu) * k, cv + (uv.getY(i) - cv) * k);
    else if (r() < 0.35) uv.setXY(i, r() * 4, r() * 4);
  }
  uv.needsUpdate = true;
  return { target: target.name, how };
}

export const GLITCHES = {
  missing_texture: missingTexture,
  exploded_vertices: explodedVertices,
  z_fighting: zFighting,
  black_object: blackObject,
  inside_out: insideOut,
  shadow_acne: shadowAcne,
  stretched_texture: stretchedTexture,
};
