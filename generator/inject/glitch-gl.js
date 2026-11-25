// framehound's WebGL glitch injector.
//
// Loaded into any WebGL page before the page's own scripts (Playwright's addInitScript), whatever engine drew it.
// It lets a driver:
//   - freeze the page's clock and random numbers, so each step of the page's frame loop draws the same frame;
//   - record the draw calls of a clean frame;
//   - draw that frame again with one draw call broken the way real renderers break: a texture that never loaded,
//     a draw that never happened, corrupt vertex or index data, lost or squashed texture coordinates, flipped
//     culling, a depth test left off, a blend left on, a NaN colour.
// Every piece of GL state a glitch touches is put back right after the broken draw, so the next frame is clean again.
// Glitches that read vertex or index data use WebGL 2 readback, or on WebGL 1 a copy kept as the page uploads it.
(() => {
  if (window.__fh) return;

  // ---- clock, frame loop and random numbers -------------------------------------------------------------------
  const realRAF = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  const realDateNow = Date.now.bind(Date);
  const realRandom = Math.random.bind(Math);
  const FAKE_IDS = 1e9;
  // The page's clock stops while frozen, and the time spent frozen is taken out afterwards, as if the page had been
  // paused: otherwise a game sees one huge time step when it resumes and its physics jump.
  let frozen = false;
  let frozenNow = 0;
  let frozenDate = 0;
  let pausedPerf = 0; // total time spent frozen, on each clock
  let pausedDate = 0;
  let frozeAtPerf = 0;
  let frozeAtDate = 0;
  const pageNow = () => (frozen ? frozenNow : realNow() - pausedPerf);
  const pageDate = () => (frozen ? frozenDate : realDateNow() - pausedDate);
  let queue = [];
  let nextId = FAKE_IDS;
  const shifted = (cb) => (t) => cb(t - pausedPerf); // frame callbacks get the page's time too
  window.requestAnimationFrame = (cb) => {
    if (!frozen) return realRAF(shifted(cb));
    queue.push({ id: nextId, cb });
    return nextId++;
  };
  window.cancelAnimationFrame = (id) => {
    if (id >= FAKE_IDS) queue = queue.filter((e) => e.id !== id);
    else realCancel(id);
  };
  performance.now = pageNow;
  // `new Date()` reads the clock too (older games time themselves with new Date().getTime()), so Date is wrapped
  const RealDate = Date;
  function FrozenDate(...a) {
    if (!new.target) return RealDate(); // Date() called as a function gives a string
    return a.length === 0 ? new RealDate(pageDate()) : new RealDate(...a);
  }
  FrozenDate.prototype = RealDate.prototype;
  FrozenDate.now = pageDate;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  window.Date = FrozenDate;

  const mulberry = (s) => () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let pageRandom = mulberry(1);
  Math.random = () => (frozen ? pageRandom() : realRandom());

  // ---- WebGL contexts: keep the drawing buffer so a finished frame can be read back ------------------------------
  const contexts = new Set();
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (!/^(webgl2?|experimental-webgl)$/.test(type)) return realGetContext.call(this, type, attrs);
    const gl = realGetContext.call(this, type, { ...(attrs || {}), preserveDrawingBuffer: true });
    if (gl) contexts.add(gl);
    return gl;
  };
  const isGL2 = (gl) => typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

  // WebGL 1 can't read a buffer back, so keep a copy of what each buffer was given (WebGL 2 reads it directly).
  const shadows = new WeakMap();
  if (window.WebGLRenderingContext) {
    const proto = WebGLRenderingContext.prototype;
    const realBufferData = proto.bufferData;
    const realBufferSubData = proto.bufferSubData;
    const bound = (gl, target) => gl.getParameter(target === gl.ELEMENT_ARRAY_BUFFER ? gl.ELEMENT_ARRAY_BUFFER_BINDING : gl.ARRAY_BUFFER_BINDING);
    const bytesOf = (data) => (data instanceof ArrayBuffer ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null);
    proto.bufferData = function (target, data, usage) {
      const buf = bound(this, target);
      if (buf) {
        const b = typeof data === 'number' ? new Uint8Array(data) : bytesOf(data);
        if (b) shadows.set(buf, typeof data === 'number' ? b : b.slice());
      }
      return realBufferData.call(this, target, data, usage);
    };
    proto.bufferSubData = function (target, offset, data) {
      const buf = bound(this, target);
      const copy = buf && shadows.get(buf);
      const b = bytesOf(data);
      if (copy && b && offset + b.length <= copy.length) copy.set(b, offset);
      return realBufferSubData.call(this, target, offset, data);
    };
  }

  // ---- what each shader program reads ---------------------------------------------------------------------------
  const programs = new WeakMap();
  let programCount = 0;
  const SKIP_SAMPLER = /normal|rough|metal|occlu|^ao|emiss|shadow|env|light|bump|spec|depth|noise|lut|mask|clearcoat|sheen|irid|transm|thick|displac|alpha|bone|morph|blue|matcap|gradient|transmission|ssao|velocity/i;
  const BASE_SAMPLER = /(^|_)map$|diffuse|albedo|base_?colou?r|maintex|^u?_?tex(ture)?0?$|^s?texture$/i;
  const SKIP_COLOR = /light|fog|shadow|ambient|emissive|specular|clear|sheen|ground|sky|attenuation|transmission/i;
  const BASE_COLOR = /(diffuse|albedo|base_?colou?r|basecolorfactor|^u?_?colou?r)$/i;

  function programInfo(gl, prog) {
    if (!prog) return null;
    let info = programs.get(prog);
    if (info) return info;
    const attribs = [];
    const uniforms = [];
    const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES) || 0;
    for (let i = 0; i < na; i++) {
      const a = gl.getActiveAttrib(prog, i);
      if (a) attribs.push({ name: a.name, type: a.type, loc: gl.getAttribLocation(prog, a.name) });
    }
    const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
    for (let i = 0; i < nu; i++) {
      const u = gl.getActiveUniform(prog, i);
      if (u) uniforms.push({ name: u.name, type: u.type, size: u.size, loc: gl.getUniformLocation(prog, u.name) });
    }
    const leaf = (n) => n.replace(/\[0\]$/, '').split('.').pop();
    const samplers = uniforms.filter((u) => u.type === gl.SAMPLER_2D && u.loc && !SKIP_SAMPLER.test(leaf(u.name)));
    info = {
      id: ++programCount,
      position: attribs.find((a) => a.type === gl.FLOAT_VEC3 && a.loc >= 0 && (/position$/i.test(a.name) || /^a_?pos$/i.test(a.name))),
      uv: attribs.find((a) => a.type === gl.FLOAT_VEC2 && a.loc >= 0 && /(uv|texcoord|tex_coord)0?$/i.test(a.name)),
      baseSampler: samplers.find((u) => BASE_SAMPLER.test(leaf(u.name))) ?? null,
      color: uniforms.find((u) => (u.type === gl.FLOAT_VEC3 || u.type === gl.FLOAT_VEC4) && u.size === 1 && u.loc
        && BASE_COLOR.test(leaf(u.name)) && !SKIP_COLOR.test(u.name)) ?? null, // full name: "pointLights[0].color" is a light
    };
    programs.set(prog, info);
    return info;
  }

  // ---- draw calls --------------------------------------------------------------------------------------------------
  function drawParams(name, a) {
    switch (name) {
      case 'drawArrays': return { mode: a[0], first: a[1], count: a[2] };
      case 'drawArraysInstanced': return { mode: a[0], first: a[1], count: a[2] };
      case 'drawElements': return { mode: a[0], count: a[1], type: a[2], offset: a[3] };
      case 'drawElementsInstanced': return { mode: a[0], count: a[1], type: a[2], offset: a[3] };
      case 'drawRangeElements': return { mode: a[0], count: a[3], type: a[4], offset: a[5] };
      default: return null;
    }
  }
  const isTriangles = (gl, mode) => mode === gl.TRIANGLES || mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLE_FAN;

  // which glitches could apply to a draw, judged from the clean frame
  function eligible(gl, info, p, state) {
    const out = [];
    const scene = p.count > 6 && isTriangles(gl, p.mode); // leaves out full-screen passes, sprites and lines
    if (!scene || !info) return out;
    out.push('missing_draw', 'inside_out');
    if (state.depth) out.push('depth_test_off');
    if (!state.blend) out.push('additive_blend');
    if (info.baseSampler) out.push('missing_texture');
    if (info.baseSampler && info.uv) out.push('lost_uvs');
    // these read vertex or index data: WebGL 2 reads the buffer, WebGL 1 uses the copy kept at upload
    if (info.baseSampler && info.uv) out.push('stretched_uvs');
    if (info.position) out.push('exploded_vertices');
    if (p.type !== undefined && p.mode === gl.TRIANGLES) out.push('broken_indices');
    if (info.color) out.push('nan_color');
    return out;
  }

  // mode: 'record' while stepping a clean frame, 'glitch' while stepping a broken one, 'replay' while replaying one
  let mode = 'off';
  let capturing = false; // in record mode, also keep every GL call of the frame so it can be replayed
  let frame = [];
  let drawIndex = 0;
  let draws = [];
  let armed = null;
  let applied = null;
  const DRAWS = new Set(['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']);
  const NOT_REPLAYED = /^(get|is|check)|^(readPixels|finish|flush|getExtension|getContextAttributes)$/;

  // A call's arguments as they were at the time: the page reuses and changes its arrays (matrices, vertex data) and
  // its canvases and videos after the call, so they are copied.
  function snap(a) {
    if (a === null || typeof a !== 'object') return a;
    if (a instanceof DataView) return new DataView(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
    if (ArrayBuffer.isView(a)) return a.slice();
    if (a instanceof ArrayBuffer) return a.slice(0);
    if (Array.isArray(a)) return a.slice();
    if (a instanceof ImageData) return new ImageData(new Uint8ClampedArray(a.data), a.width, a.height);
    const live = a instanceof HTMLCanvasElement || a instanceof HTMLVideoElement
      || (typeof OffscreenCanvas !== 'undefined' && a instanceof OffscreenCanvas) || (typeof ImageBitmap !== 'undefined' && a instanceof ImageBitmap);
    if (live) {
      const c = document.createElement('canvas');
      c.width = a.videoWidth || a.width;
      c.height = a.videoHeight || a.height;
      if (c.width && c.height) c.getContext('2d').drawImage(a, 0, 0);
      return c;
    }
    return a; // GL objects, uniform locations, images
  }

  function describeDraw(gl, name, args, k) {
    const p = drawParams(name, args);
    const info = programInfo(gl, gl.getParameter(gl.CURRENT_PROGRAM));
    const state = { depth: gl.isEnabled(gl.DEPTH_TEST), blend: gl.isEnabled(gl.BLEND) };
    return { index: k, gl, name, count: p.count, program: info?.id ?? 0, eligible: eligible(gl, info, p, state) };
  }

  function wrap(name, orig, isDraw) {
    return function (...args) {
      if (mode === 'off' || mode === 'replay') return orig.apply(this, args);
      if (isDraw) {
        const k = drawIndex++;
        if (mode === 'glitch') {
          if (armed && armed.draw === k) return glitchDraw(this, name, orig, args);
          return orig.apply(this, args);
        }
        draws.push(describeDraw(this, name, args, k));
        if (capturing) frame.push({ target: this, fn: orig, args: args.map(snap), name, draw: k });
        return orig.apply(this, args);
      }
      if (!capturing || NOT_REPLAYED.test(name)) return orig.apply(this, args);
      const entry = { target: this, fn: orig, args: args.map(snap), name };
      frame.push(entry);
      const r = orig.apply(this, args);
      if (name.startsWith('create') && r && typeof r === 'object') entry.created = r;
      return r;
    };
  }
  for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Ctx) continue;
    for (const name of Object.getOwnPropertyNames(Ctx.prototype)) {
      const d = Object.getOwnPropertyDescriptor(Ctx.prototype, name);
      if (!d || typeof d.value !== 'function' || name === 'constructor') continue;
      Ctx.prototype[name] = wrap(name, d.value, DRAWS.has(name));
    }
    // extension functions (instanced drawing, vertex array objects in WebGL 1) are part of the frame too
    const getExtension = Ctx.prototype.getExtension;
    const wrapped = new WeakSet();
    Ctx.prototype.getExtension = function (n) {
      const ext = getExtension.call(this, n);
      if (ext && !wrapped.has(ext)) {
        wrapped.add(ext);
        const proto = Object.getPrototypeOf(ext);
        for (const k of Object.getOwnPropertyNames(proto)) {
          const d = Object.getOwnPropertyDescriptor(proto, k);
          if (d && typeof d.value === 'function' && k !== 'constructor') ext[k] = wrap(k, d.value, false);
        }
      }
      return ext;
    };
  }

  // Draw the captured frame again from its recorded GL calls, breaking the armed draw if there is one. Objects the
  // frame created are created afresh and stand in for the originals in later calls.
  function replay() {
    const created = new Map();
    mode = 'replay';
    try {
      for (const e of frame) {
        const args = created.size ? e.args.map((a) => created.get(a) ?? a) : e.args;
        if (e.draw !== undefined && armed && armed.draw === e.draw) {
          glitchDraw(e.target, e.name, e.fn, args);
          continue;
        }
        const r = e.fn.apply(e.target, args);
        if (e.created) created.set(e.created, r);
      }
    } finally {
      mode = 'off';
    }
  }

  // ---- helpers for broken draws -------------------------------------------------------------------------------------
  const temps = new WeakMap();
  function temp(gl) {
    let t = temps.get(gl);
    if (!t) {
      t = { array: gl.createBuffer(), index: gl.createBuffer(), textures: {} };
      temps.set(gl, t);
    }
    return t;
  }

  function readBuffer(gl, buf) {
    if (!isGL2(gl)) {
      const copy = shadows.get(buf);
      return copy ? copy.slice() : null;
    }
    const prev = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
    gl.bindBuffer(gl.COPY_READ_BUFFER, buf);
    const size = gl.getBufferParameter(gl.COPY_READ_BUFFER, gl.BUFFER_SIZE);
    const bytes = new Uint8Array(size);
    if (size) gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, bytes);
    gl.bindBuffer(gl.COPY_READ_BUFFER, prev);
    return bytes;
  }

  // the vertices this draw uses (indices into its vertex buffers), and its index data if it has any
  function usedVertices(gl, p) {
    if (p.type === undefined) {
      const v = new Uint32Array(p.count);
      for (let i = 0; i < p.count; i++) v[i] = p.first + i;
      return { verts: v };
    }
    const ebo = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
    if (!ebo) return null;
    const bytes = readBuffer(gl, ebo);
    if (!bytes) return null;
    const T = p.type === gl.UNSIGNED_INT ? Uint32Array : p.type === gl.UNSIGNED_SHORT ? Uint16Array : Uint8Array;
    if (p.offset + p.count * T.BYTES_PER_ELEMENT > bytes.length) return null;
    return { verts: new T(bytes.buffer, p.offset, p.count), ebo, bytes, T };
  }

  function uniqueSample(verts, rnd, limit) {
    const out = new Set();
    if (verts.length <= limit) for (const v of verts) out.add(v);
    else for (let i = 0; i < limit; i++) out.add(verts[Math.floor(rnd() * verts.length)]);
    return [...out];
  }

  // Edit a float vertex attribute for one draw: copy its buffer, let `edit` change the copy, draw from the copy, then
  // point the attribute back at the original buffer.
  function withEditedAttribute(gl, loc, edit, draw) {
    if (!gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_ENABLED)) return null;
    // (these two queries only exist in WebGL 2; asking WebGL 1 would raise a GL error the page might notice)
    if (isGL2(gl) && (gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_INTEGER) || gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_DIVISOR))) return null;
    if (gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_TYPE) !== gl.FLOAT) return null;
    const buffer = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING);
    if (!buffer) return null;
    const size = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_SIZE);
    const normalized = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED);
    const stride = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_STRIDE);
    const offset = gl.getVertexAttribOffset(loc, gl.VERTEX_ATTRIB_ARRAY_POINTER);
    const bytes = readBuffer(gl, buffer);
    if (!bytes) return null;
    const step = stride || size * 4;
    const n = bytes.length >= offset + size * 4 ? Math.floor((bytes.length - offset - size * 4) / step) + 1 : 0;
    const view = new DataView(bytes.buffer);
    const get = (v, c) => view.getFloat32(offset + v * step + c * 4, true);
    const set = (v, c, x) => view.setFloat32(offset + v * step + c * 4, x, true);
    const info = edit({ get, set, n, size });
    if (!info) return null;
    const prevArray = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    gl.bindBuffer(gl.ARRAY_BUFFER, temp(gl).array);
    gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STREAM_DRAW);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, normalized, stride, offset);
    draw();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, normalized, stride, offset);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevArray);
    return info;
  }

  const PLACEHOLDERS = {
    'magenta-checker': [[255, 0, 255], [0, 0, 0], 8],
    magenta: [[255, 0, 255], [255, 0, 255], 1],
    black: [[0, 0, 0], [0, 0, 0], 1],
    white: [[255, 255, 255], [255, 255, 255], 1],
    'grey-checker': [[200, 200, 200], [90, 90, 90], 8],
  };
  function placeholder(gl, style) {
    const t = temp(gl);
    if (t.textures[style]) return t.textures[style];
    const [a, b, cells] = PLACEHOLDERS[style];
    const size = 64;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = (Math.floor((x * cells) / size) + Math.floor((y * cells) / size)) % 2 ? a : b;
        data.set([c[0], c[1], c[2], 255], (y * size + x) * 4);
      }
    }
    // the caller has already saved the texture unit's binding; upload with default unpack state
    const gl2 = isGL2(gl);
    const saved = gl2 ? [gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING), gl.getParameter(gl.UNPACK_ROW_LENGTH),
      gl.getParameter(gl.UNPACK_SKIP_ROWS), gl.getParameter(gl.UNPACK_SKIP_PIXELS)] : null;
    const align = gl.getParameter(gl.UNPACK_ALIGNMENT);
    if (gl2) {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, align);
    if (gl2) {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, saved[0]);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, saved[1]);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, saved[2]);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, saved[3]);
    }
    t.textures[style] = tex;
    return tex;
  }

  // ---- the glitches -------------------------------------------------------------------------------------------------
  // Each draws the call once (or not at all) in its broken form, puts the state back, and returns a note on what it
  // did, or null if it couldn't apply (the call is then drawn normally).
  const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
  const GLITCHES = {
    // A draw that never happened: a missing part of a model, a missing wall, a character with no head.
    missing_draw: () => ({}),

    // A texture that never loaded, so the engine's fallback shows.
    missing_texture(gl, draw, rnd, info) {
      const prog = gl.getParameter(gl.CURRENT_PROGRAM);
      const unit = gl.getUniform(prog, info.baseSampler.loc);
      const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
      gl.activeTexture(gl.TEXTURE0 + unit);
      const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
      if (!prevTex) {
        gl.activeTexture(prevActive);
        return null;
      }
      const style = pick(rnd, ['magenta-checker', 'magenta-checker', 'magenta', 'black', 'white', 'grey-checker']);
      gl.bindTexture(gl.TEXTURE_2D, placeholder(gl, style));
      gl.activeTexture(prevActive);
      draw();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, prevTex);
      gl.activeTexture(prevActive);
      return { style, sampler: info.baseSampler.name };
    },

    // Garbage vertex positions: a few vertices shoot off and drag long spikes across the frame.
    exploded_vertices(gl, draw, rnd, info, p) {
      const used = usedVertices(gl, p);
      if (!used) return null;
      return withEditedAttribute(gl, info.position.loc, ({ get, set, n }) => {
        const verts = uniqueSample(used.verts, rnd, 20000).filter((v) => v < n);
        if (verts.length < 3) return null;
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (const v of verts) for (let c = 0; c < 3; c++) {
          lo[c] = Math.min(lo[c], get(v, c));
          hi[c] = Math.max(hi[c], get(v, c));
        }
        const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        if (!(diag > 0) || !Number.isFinite(diag)) return null;
        const count = 1 + Math.floor(rnd() * 6);
        for (let k = 0; k < count; k++) {
          const v = pick(rnd, verts);
          const d = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
          const len = Math.hypot(...d) || 1;
          const reach = diag * (0.6 + 2.4 * rnd());
          for (let c = 0; c < 3; c++) set(v, c, get(v, c) + (d[c] / len) * reach);
        }
        return { vertices: count };
      }, draw);
    },

    // Corrupt index data: triangles join the wrong vertices and stretch across the model.
    broken_indices(gl, draw, rnd, info, p) {
      const used = usedVertices(gl, p);
      if (!used || !used.ebo) return null;
      const copy = used.bytes.slice();
      const idx = new used.T(copy.buffer, p.offset, p.count);
      const style = rnd() < 0.6 ? 'few' : 'shifted';
      if (style === 'few') {
        const k = 1 + Math.floor(rnd() * 4);
        for (let i = 0; i < k; i++) idx[Math.floor(rnd() * p.count)] = used.verts[Math.floor(rnd() * p.count)];
      } else {
        const len = Math.max(3, Math.floor(p.count * (0.03 + 0.25 * rnd())));
        const start = Math.floor(rnd() * Math.max(1, p.count - len - 1));
        for (let i = start; i < start + len; i++) idx[i] = used.verts[i + 1];
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, temp(gl).index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, copy, gl.STREAM_DRAW);
      draw();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, used.ebo);
      return { style };
    },

    // Texture coordinates lost: the whole surface takes the colour of one texel.
    lost_uvs(gl, draw, rnd, info) {
      const loc = info.uv.loc;
      if (!gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_ENABLED)) return null;
      const prev = gl.getVertexAttrib(loc, gl.CURRENT_VERTEX_ATTRIB);
      gl.disableVertexAttribArray(loc);
      gl.vertexAttrib2f(loc, rnd(), rnd());
      draw();
      gl.enableVertexAttribArray(loc);
      gl.vertexAttrib4fv(loc, prev);
      return {};
    },

    // Texture coordinates squashed: the texture smears into stripes along one axis, or blows up into a blur.
    stretched_uvs(gl, draw, rnd, info, p) {
      const used = usedVertices(gl, p);
      if (!used) return null;
      return withEditedAttribute(gl, info.uv.loc, ({ get, set, n }) => {
        const verts = uniqueSample(used.verts, rnd, 1e6).filter((v) => v < n);
        if (verts.length < 3) return null;
        const mean = [0, 0];
        for (const v of verts) for (let c = 0; c < 2; c++) mean[c] += get(v, c) / verts.length;
        const style = rnd() < 0.7 ? 'one-axis' : 'both';
        const axis = rnd() < 0.5 ? 0 : 1;
        const factor = style === 'one-axis' ? 0.005 + 0.05 * rnd() : 0.03 + 0.15 * rnd();
        for (const v of verts) for (let c = 0; c < 2; c++) {
          if (style === 'both' || c === axis) set(v, c, mean[c] + (get(v, c) - mean[c]) * factor);
        }
        return { style, axis: style === 'one-axis' ? 'uv'[axis] : 'both', factor: +factor.toFixed(3) };
      }, draw);
    },

    // Wrong winding or culling: the front faces vanish and the model shows its inside.
    inside_out(gl, draw) {
      const on = gl.isEnabled(gl.CULL_FACE);
      const prevMode = gl.getParameter(gl.CULL_FACE_MODE);
      if (!on) gl.enable(gl.CULL_FACE);
      gl.cullFace(on && prevMode === gl.FRONT ? gl.BACK : gl.FRONT);
      draw();
      gl.cullFace(prevMode);
      if (!on) gl.disable(gl.CULL_FACE);
      return { cull_was_on: on };
    },

    // Depth test left off: the object draws over whatever should hide it.
    depth_test_off(gl, draw) {
      const prev = gl.getParameter(gl.DEPTH_FUNC);
      gl.depthFunc(gl.ALWAYS);
      draw();
      gl.depthFunc(prev);
      return {};
    },

    // A blend mode leaked from another draw: the object glows and turns see-through.
    additive_blend(gl, draw) {
      const saved = [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA, gl.BLEND_EQUATION_RGB, gl.BLEND_EQUATION_ALPHA]
        .map((k) => gl.getParameter(k));
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      draw();
      gl.disable(gl.BLEND);
      gl.blendFuncSeparate(saved[0], saved[1], saved[2], saved[3]);
      gl.blendEquationSeparate(saved[4], saved[5]);
      return {};
    },

    // A NaN or zero reached the material colour: the object turns black, and NaNs can spread through post effects.
    nan_color(gl, draw, rnd, info) {
      const prog = gl.getParameter(gl.CURRENT_PROGRAM);
      const u = info.color;
      const prev = gl.getUniform(prog, u.loc);
      const style = rnd() < 0.5 ? 'nan' : 'zero';
      const x = style === 'nan' ? NaN : 0;
      if (u.type === gl.FLOAT_VEC3) gl.uniform3f(u.loc, x, x, x);
      else gl.uniform4f(u.loc, x, x, x, prev[3]);
      draw();
      if (u.type === gl.FLOAT_VEC3) gl.uniform3fv(u.loc, prev);
      else gl.uniform4fv(u.loc, prev);
      return { style, uniform: u.name };
    },
  };

  function glitchDraw(gl, name, orig, args) {
    const draw = () => orig.apply(gl, args);
    const p = drawParams(name, args);
    const info = programInfo(gl, gl.getParameter(gl.CURRENT_PROGRAM));
    let note = null;
    try {
      note = GLITCHES[armed.type](gl, draw, armed.rnd, info, p);
    } catch (e) {
      note = null;
      applied = { ok: false, error: String(e) };
    }
    if (note) applied = { ok: true, info: note };
    else {
      if (!applied) applied = { ok: false };
      draw();
    }
    return undefined;
  }

  // ---- reading frames -----------------------------------------------------------------------------------------------
  let outW = 768;
  let outH = 432;
  function mainCanvas() {
    let best = null;
    let area = 0;
    for (const gl of contexts) {
      const c = gl.canvas;
      if (!(c instanceof HTMLCanvasElement) || !c.isConnected) continue;
      if (c.width * c.height > area) {
        area = c.width * c.height;
        best = c;
      }
    }
    return best;
  }
  // the frame as the page shows it, cropped to fill outW x outH
  function grab() {
    const src = mainCanvas();
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const g = out.getContext('2d', { willReadFrequently: true });
    const bg = getComputedStyle(document.body).backgroundColor;
    g.fillStyle = !bg || bg === 'rgba(0, 0, 0, 0)' ? '#000' : bg;
    g.fillRect(0, 0, outW, outH);
    if (!src) return out;
    const s = Math.max(outW / src.width, outH / src.height);
    g.drawImage(src, (outW - src.width * s) / 2, (outH - src.height * s) / 2, src.width * s, src.height * s);
    return out;
  }

  const DIFF_THRESHOLD = 12; // per channel, 0–255: below this a pixel counts as unchanged (as in the scene generator)
  const STRONG = 40; // a change this big is plain to see; faint changes (bloom halos, soft shadows) alone don't count
  function diff(a, b, threshold = DIFF_THRESHOLD, wantMask = false) {
    const da = a.getContext('2d').getImageData(0, 0, outW, outH).data;
    const db = b.getContext('2d').getImageData(0, 0, outW, outH).data;
    let changed = 0;
    let strong = 0;
    let sum = 0;
    const strongAt = wantMask ? new Uint8Array(outW * outH) : null;
    const m = wantMask ? document.createElement('canvas') : null;
    let out = null;
    if (m) {
      m.width = outW;
      m.height = outH;
      out = m.getContext('2d').createImageData(outW, outH);
    }
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      const on = d > threshold;
      if (on) {
        changed++;
        sum += d;
        if (d > STRONG) {
          strong++;
          if (strongAt) strongAt[i >> 2] = 1;
        }
      }
      if (out) {
        out.data[i] = out.data[i + 1] = out.data[i + 2] = on ? 255 : 0;
        out.data[i + 3] = 255;
      }
    }
    if (m) m.getContext('2d').putImageData(out, 0, 0);
    return { fraction: changed / (outW * outH), strong: strong / (outW * outH), mean: changed ? sum / changed : 0, mask: m, strongAt };
  }

  // Size of the biggest connected patch of plainly changed pixels, counting no further than `enough`. Scattered
  // speckles (particles drawn in another order) change many pixels but nothing a person would see.
  function biggestPatch(at, enough) {
    const seen = new Uint8Array(at.length);
    const stack = new Int32Array(at.length);
    let best = 0;
    for (let s = 0; s < at.length; s++) {
      if (!at[s] || seen[s]) continue;
      let top = 0;
      let size = 0;
      stack[top++] = s;
      seen[s] = 1;
      while (top) {
        const p = stack[--top];
        size++;
        const x = p % outW;
        const y = (p / outW) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= outW || ny >= outH) continue;
          const q = ny * outW + nx;
          if (at[q] && !seen[q]) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
      best = Math.max(best, size);
      if (best >= enough) return best;
    }
    return best;
  }

  // Spread of brightness over the frame; near zero means the glitch left an empty frame (all black, say), which
  // looks the same as a clean empty scene.
  function spread(canvas) {
    const d = canvas.getContext('2d').getImageData(0, 0, outW, outH).data;
    let s = 0;
    let s2 = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      s += l;
      s2 += l * l;
    }
    return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }
  // Frames count as the same only when identical: a camera still easing to a stop drifts away from the clean frame
  // while glitches are drawn, so settle() steps until the motion has shrunk below what a pixel can show.
  const same = (a, b) => diff(a, b, 0).fraction === 0;

  // ---- driving the page ---------------------------------------------------------------------------------------------
  const FRAME_SEED = 12345;
  function step(kind) {
    pageRandom = mulberry(FRAME_SEED); // same random numbers every frame
    mode = kind;
    drawIndex = 0;
    if (kind === 'record') draws = [];
    const q = queue;
    queue = [];
    const errors = [];
    for (const e of q) {
      try {
        e.cb(frozenNow);
      } catch (err) {
        errors.push(String(err));
      }
    }
    mode = 'off';
    return { callbacks: q.length, errors };
  }

  let clean = null;
  let cleanDraws = [];
  let replayable = false; // the clean frame is a recorded frame that replays exactly

  function keepClean(frameImage) {
    clean = frameImage;
    cleanDraws = draws.filter((d) => d.gl.canvas === mainCanvas() || !(d.gl.canvas instanceof HTMLCanvasElement));
    const byType = {};
    for (const d of cleanDraws) for (const t of d.eligible) byType[t] = (byType[t] ?? 0) + 1;
    return byType;
  }

  // Record one frame's GL calls and replay them. This holds the frame still even when the page animates by frame
  // count (an object turned a little every frame) rather than by time. It counts only if two replays match each
  // other and match the frame the page drew itself.
  function settleByReplay() {
    capturing = true;
    frame = [];
    let s;
    try {
      s = step('record');
    } finally {
      capturing = false;
    }
    if (!s.callbacks) return { ok: false, reason: 'the page does not draw from requestAnimationFrame' };
    const own = grab();
    replay();
    const a = grab();
    replay();
    const b = grab();
    if (!same(a, b)) return { ok: false, reason: 'the replay is not repeatable' };
    const d = diff(own, a);
    if (d.fraction > 0.001) return { ok: false, reason: `the replay differs from the page's own frame (${(d.fraction * 100).toFixed(2)}%)` };
    replayable = true;
    return { ok: true, steps: 1, replay: true, calls: frame.length, draws: 0, eligible: keepClean(a) };
  }

  // Prefer a replayed frame; otherwise step the frozen page until the frame stops changing (lets damping, TAA and
  // fades come to rest). An easing camera can hold still for a frame or two and then creep on, so it takes `hold`
  // identical frames in a row; with a typical damping factor of 0.05, that is about how long the rest of the motion
  // takes to add up.
  function settle(maxSteps = 600, hold = 25) {
    replayable = false;
    const r = settleByReplay();
    if (r.ok) {
      r.draws = cleanDraws.length;
      return r;
    }
    frame = [];
    const replayProblem = r.reason;
    let prev = null;
    let run = 0;
    for (let i = 0; i < maxSteps; i++) {
      const s = step('record');
      if (!s.callbacks) return { ok: false, reason: 'the page does not draw from requestAnimationFrame' };
      const cur = grab();
      run = prev && same(prev, cur) ? run + 1 : 0;
      prev = cur;
      if (run >= hold) {
        const byType = keepClean(cur);
        return { ok: true, steps: i + 1, draws: cleanDraws.length, eligible: byType, replay_problem: replayProblem };
      }
    }
    return { ok: false, reason: 'the frame never stopped changing', replay_problem: replayProblem };
  }

  // Draw the frame broken: replay it with the armed draw broken, or step the page once more.
  function drawBroken() {
    if (replayable) replay();
    else step('glitch');
  }

  // after a broken frame, check the clean frame comes back: a replay must reproduce it at once; a stepped page may
  // take a few frames (temporal effects can carry the glitch)
  function recover(maxSteps = 30) {
    if (replayable) {
      replay();
      return same(clean, grab());
    }
    for (let i = 0; i < maxSteps; i++) {
      step('record');
      if (same(clean, grab())) return true;
    }
    return false;
  }

  // minStrong: share of the frame that must change plainly (by more than STRONG), so faint glitches are left out.
  // minPatch: pixels in the biggest connected patch of plain change. minSpread: brightness spread the broken frame
  // must keep, so a glitch that blanks the whole frame is left out.
  function sample({ type, seed, tries = 6, minFraction = 0.002, maxFraction = 0.6, minStrong = 0.001, minPatch = 150, minSpread = 6 }) {
    if (!clean) return { ok: false, reason: 'not settled' };
    const rnd = mulberry(seed);
    const candidates = cleanDraws.filter((d) => d.eligible.includes(type));
    if (!candidates.length) return { ok: false, reason: 'no draw this glitch applies to' };
    const rejected = [];
    for (let t = 0; t < tries; t++) {
      const d = candidates[Math.floor(rnd() * candidates.length)];
      armed = { draw: d.index, type, rnd: mulberry(seed * 9973 + t + 1) };
      applied = null;
      drawBroken();
      const glitched = grab();
      const result = applied;
      armed = null;
      if (!recover()) return { ok: false, fatal: true, reason: 'the clean frame did not come back' };
      if (!result || !result.ok) {
        rejected.push(result?.error ?? 'did not apply');
        continue;
      }
      const m = diff(clean, glitched, DIFF_THRESHOLD, true);
      if (m.fraction < minFraction || m.fraction > maxFraction || m.strong < minStrong) {
        rejected.push(`fraction ${m.fraction.toFixed(4)} strong ${m.strong.toFixed(4)}`);
        continue;
      }
      const patch = biggestPatch(m.strongAt, minPatch);
      const sp = spread(glitched);
      if (patch < minPatch || sp < minSpread) {
        rejected.push(`patch ${patch} spread ${sp.toFixed(1)}`);
        continue;
      }
      return {
        ok: true, type, attempt: t, info: result.info, fraction: m.fraction, strong: m.strong, mean_change: m.mean,
        draw: { index: d.index, call: d.name, count: d.count, program: d.program },
        glitched: glitched.toDataURL('image/png'), mask: m.mask.toDataURL('image/png'),
      };
    }
    return { ok: false, reason: 'not visible', rejected };
  }

  window.__fh = {
    types: Object.keys(GLITCHES),
    setSize(w, h) {
      outW = w;
      outH = h;
    },
    status() {
      const c = mainCanvas();
      return { contexts: contexts.size, webgl2: [...contexts].some(isGL2), canvas: c ? [c.width, c.height] : null, frozen, queued: queue.length };
    },
    freeze() {
      frozenNow = realNow() - pausedPerf;
      frozenDate = realDateNow() - pausedDate;
      frozeAtPerf = realNow();
      frozeAtDate = realDateNow();
      frozen = true;
    },
    unfreeze() {
      pausedPerf += realNow() - frozeAtPerf;
      pausedDate += realDateNow() - frozeAtDate;
      frozen = false;
      replayable = false;
      frame = []; // the recorded frame holds copies of the page's data; let it go
      const q = queue;
      queue = [];
      for (const e of q) realRAF(shifted(e.cb));
    },
    settle,
    clean: () => clean?.toDataURL('image/png') ?? null,
    sample,
  };
})();
