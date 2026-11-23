// Each glitch breaks the scene in one way that real renderers break, and returns a short note on what it did.
// It gets the built world ({ scene, camera, objects, floor, sun }) and its own seeded random function.
import * as THREE from 'three';

const pick = (r, list) => list[Math.floor(r() * list.length)];
const range = (r, lo, hi) => lo + (hi - lo) * r();

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
  const target = r() < 0.15 ? floor : pick(r, objects);
  const style = pick(r, ['magenta-checker', 'magenta', 'black']);
  const mat = target.material;
  mat.color.set(0xffffff);
  mat.map = style === 'magenta-checker'
    ? checkerTexture('#ff00ff', '#000000', pick(r, [4, 8, 16]))
    : style === 'magenta' ? checkerTexture('#ff00ff', '#ff00ff', 1) : checkerTexture('#000000', '#000000', 1);
  mat.needsUpdate = true;
  return { target: target.name, style };
}

// A few vertices get garbage positions and the mesh shoots spikes across the frame.
function explodedVertices({ objects }, r) {
  const target = pick(r, objects);
  target.geometry = target.geometry.clone();
  const pos = target.geometry.attributes.position;
  const count = 1 + Math.floor(r() * 5);
  const dir = new THREE.Vector3();
  for (let k = 0; k < count; k++) {
    const i = Math.floor(r() * pos.count);
    dir.set(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(range(r, 2, 8) / target.scale.x);
    pos.setXYZ(i, pos.getX(i) + dir.x, pos.getY(i) + dir.y, pos.getZ(i) + dir.z);
  }
  pos.needsUpdate = true;
  target.geometry.computeBoundingSphere();
  return { target: target.name, vertices: count };
}

// Two surfaces share (almost) the same depth and flicker through each other in stripes.
function zFighting({ scene, objects, floor }, r) {
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(r(), 0.7, 0.5), roughness: 0.6 });
  if (r() < 0.5) {
    // a decal or second floor placed exactly on the floor
    const size = range(r, 3, 12);
    const patch = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    patch.rotation.x = -Math.PI / 2;
    patch.rotation.z = r() * Math.PI;
    // offsets must stay below the depth buffer's precision (~1e-4 units at these distances) or one surface simply wins
    patch.position.set(range(r, -3, 3), range(r, 0, 0.00003), range(r, -3, 3));
    patch.receiveShadow = true;
    scene.add(patch);
    return { target: floor.name, with: 'floor patch' };
  }
  // a duplicate of an object, scaled by a hair (again, below depth precision)
  const target = pick(r, objects);
  const twin = new THREE.Mesh(target.geometry, mat);
  twin.position.copy(target.position);
  twin.quaternion.copy(target.quaternion);
  twin.scale.copy(target.scale).multiplyScalar(1 + range(r, -0.00002, 0.00002));
  twin.castShadow = twin.receiveShadow = true;
  scene.add(twin);
  return { target: target.name, with: 'duplicate' };
}

// Shading breaks (NaN normals, a failed shader) and the object renders black.
function blackObject({ objects }, r) {
  const target = pick(r, objects);
  const how = pick(r, ['black-material', 'nan-normals']);
  if (how === 'black-material') {
    target.material = new THREE.MeshBasicMaterial({ color: 0x000000 });
  } else {
    target.geometry = target.geometry.clone();
    const n = target.geometry.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, NaN, NaN, NaN);
    n.needsUpdate = true;
  }
  return { target: target.name, how };
}

// Winding or culling is flipped and the object renders inside out (you see its back faces).
function insideOut({ objects }, r) {
  const closed = objects.filter((o) => !(o.geometry instanceof THREE.PlaneGeometry));
  const target = pick(r, closed.length ? closed : objects);
  target.material.side = THREE.BackSide;
  target.material.needsUpdate = true;
  return { target: target.name };
}

export const GLITCHES = {
  missing_texture: missingTexture,
  exploded_vertices: explodedVertices,
  z_fighting: zFighting,
  black_object: blackObject,
  inside_out: insideOut,
};
