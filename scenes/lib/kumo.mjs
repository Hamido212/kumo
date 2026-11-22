// Writes .kumo scene files (the reader is src/scene.rs).
//
//   const s = new SceneWriter({ title: 'My scene' });
//   const world = s.addGrid('world', grid);                       // a mesh, from a voxel grid
//   s.object({ mesh: world, cast: true, receive: true });         // draw it
//   s.manifest.camera = { ... };                                  // everything else is plain data
//   s.write('my.kumo');
//
// File layout: "KUMO" | u32 version | u32 jsonLen | json (padded to 4) | u32 binLen | bin
// bin = every vertex (20 bytes, see grid.mjs) followed by u32 indices, relative to each mesh's
// first vertex. The engine needs every part of the manifest, so the writer starts with harmless
// defaults: no petals, no fireflies, and a waterfall and pond without triangles.

import { writeFileSync } from 'node:fs';
import { meshGrid } from './grid.mjs';

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** 0xRRGGBB (sRGB) -> [r, g, b] in linear light, which is what the manifest's colours are. */
export const lin = (hex) => [16, 8, 0].map((s) => r4(srgbToLinear(((hex >> s) & 255) / 255)));
export const v3 = (a) => a.map(r4);

// Time-of-day keyframes (hour -> look), the pagoda garden's. Colours are sRGB hex.
//  zen/hor/gnd : sky zenith, horizon, below-horizon haze (also the fog colour)
//  key/keyC    : sun (day) or moon (night) intensity and colour
//  hemiS/hemiG : fill light from the sky and from the ground, hemiI its intensity
//  glow        : lamps, lit windows and fireflies, stars : star visibility, exp : exposure
export const SKY_GARDEN = [
  [0.0, { zen: 0x050b1f, hor: 0x18264d, gnd: 0x101a38, key: 0.75, keyC: 0x9db4ff, hemiS: 0x40528a, hemiG: 0x151a2a, hemiI: 0.85, glow: 1, stars: 1, exp: 1.15 }],
  [4.5, { zen: 0x08122e, hor: 0x24315e, gnd: 0x141e40, key: 0.65, keyC: 0x9db4ff, hemiS: 0x44568e, hemiG: 0x171c2c, hemiI: 0.85, glow: 1, stars: 0.9, exp: 1.15 }],
  [5.4, { zen: 0x23356c, hor: 0xd88473, gnd: 0x5b4f72, key: 0.5, keyC: 0xff9a70, hemiS: 0x7d84b8, hemiG: 0x2f2a3c, hemiI: 0.85, glow: 0.75, stars: 0.25, exp: 1.08 }],
  [6.3, { zen: 0x4a78bf, hor: 0xffbd8c, gnd: 0xb3a0b6, key: 1.9, keyC: 0xffb47c, hemiS: 0xb6c4e2, hemiG: 0x5b4f42, hemiI: 0.9, glow: 0.2, stars: 0, exp: 1.0 }],
  [8.0, { zen: 0x3b82d6, hor: 0xbcdef6, gnd: 0x96bde3, key: 2.7, keyC: 0xfff0d8, hemiS: 0xcfe3ff, hemiG: 0x5d6a46, hemiI: 1.05, glow: 0, stars: 0, exp: 1.0 }],
  [12.5, { zen: 0x2e7ce0, hor: 0xcae6ff, gnd: 0x9cc4e9, key: 3.0, keyC: 0xfff8ef, hemiS: 0xd6e9ff, hemiG: 0x627048, hemiI: 1.1, glow: 0, stars: 0, exp: 1.0 }],
  [16.2, { zen: 0x3a7fd0, hor: 0xd8e8f4, gnd: 0xa6c6e2, key: 2.8, keyC: 0xffeccf, hemiS: 0xd3e3f6, hemiG: 0x606a44, hemiI: 1.05, glow: 0, stars: 0, exp: 1.0 }],
  [17.8, { zen: 0x4a6cb3, hor: 0xffc58b, gnd: 0xb9a7b9, key: 2.3, keyC: 0xffb066, hemiS: 0xd9c6c0, hemiG: 0x5a4a38, hemiI: 0.95, glow: 0.12, stars: 0, exp: 1.0 }],
  [18.7, { zen: 0x34407f, hor: 0xff9065, gnd: 0x5e4b7c, key: 1.5, keyC: 0xff7a48, hemiS: 0xa58cb4, hemiG: 0x3a2a30, hemiI: 0.9, glow: 0.6, stars: 0.05, exp: 1.06 }],
  [19.4, { zen: 0x1a2252, hor: 0x7a4a7c, gnd: 0x2b2448, key: 0.35, keyC: 0xa290ff, hemiS: 0x575490, hemiG: 0x1c1a2a, hemiI: 0.8, glow: 0.95, stars: 0.5, exp: 1.1 }],
  [20.5, { zen: 0x060d25, hor: 0x1c2a56, gnd: 0x111b3a, key: 0.75, keyC: 0x9db4ff, hemiS: 0x40528a, hemiG: 0x151a2a, hemiI: 0.85, glow: 1, stars: 1, exp: 1.15 }],
];

/** Sky keyframes in the manifest's form. `change(hour, key)` may adjust a copy of each key first. */
export function skyKeys(raw = SKY_GARDEN, change = null) {
  return raw.map(([h, key]) => {
    const k = { ...key };
    if (change) change(h, k);
    return {
      h, zen: lin(k.zen), hor: lin(k.hor), gnd: lin(k.gnd), keyC: lin(k.keyC), hemiS: lin(k.hemiS), hemiG: lin(k.hemiG),
      key: k.key, hemiI: k.hemiI, glow: k.glow, stars: k.stars, exp: k.exp,
    };
  });
}

export class SceneWriter {
  constructor({ title, credits = [] }) {
    this.parts = [];      // { pos, nrm, col, idx } per mesh
    this.vertices = 0;
    this.indices = 0;
    const empty = this.addMesh('empty', null);
    this.manifest = {
      version: 1,
      title,
      // who made what is shown: [{ title, author, source, license, licenseUrl, changes }]
      credits,
      camera: { target: [0, 10, 0], fov: 30, near: 1, far: 2000, angle: 0.55, elev: 0.3, fit: [53, 60], orbitSpeed: 0.028 },
      fog: { near: 160, far: 520 },
      shadow: { size: 2048, extent: 58, near: 10, far: 360, target: [0, 8, 0], distance: 180, bias: -0.0004, normalBias: 0.06 },
      sky: { keys: skyKeys(), sun: { rise: 6, set: 19, tilt: 0.95, yaw: 0.35 }, moon: { tilt: 0.75, yaw: -0.25 } },
      objects: [],
      swimmers: [],
      water: { mesh: empty, deep: lin(0x1f6f7a), shallow: lin(0x52b8b2), glow: lin(0xffb35a) },
      // the engine always animates spray along the fall's top edge: far below the world when unused
      waterfall: { mesh: empty, x: 0, y: -1e6, z0: 0, z1: 0, color: lin(0x8fd3e8), spray: lin(0xeaf6ff) },
      petals: { count: 0, max: 0, emissive: [0, 0, 0], colors: [[1, 1, 1]], spawns: [] },
      ground: { half: 1, heights: [-999, -999, -999, -999] },
      fireflies: { color: lin(0xd9ff7a), items: [] },
      glows: [],
      lights: [],
      meshes: [],
    };
  }

  /** Adds a mesh from one or more { pos, nrm, col, idx } parts (see meshGrid). Returns its number. */
  addMesh(name, ...geoms) {
    const m = { name, firstVertex: this.vertices, vertexCount: 0, firstIndex: this.indices, indexCount: 0, parts: [] };
    for (const g of geoms) {
      if (!g || !g.idx.length) continue;
      m.parts.push({ ...g, base: m.vertexCount });
      m.vertexCount += g.pos.length / 3;
      m.indexCount += g.idx.length;
    }
    this.vertices += m.vertexCount;
    this.indices += m.indexCount;
    this.parts.push(m);
    return this.parts.length - 1;
  }

  /** Meshes a voxel grid (options as for meshGrid) and adds it. */
  addGrid(name, grid, options = {}) {
    const geo = meshGrid(grid, options);
    const n = this.addMesh(name, geo);
    this.parts[n].stats = { faces: geo.faces, quads: geo.quads };
    return n;
  }

  /**
   * A flat surface at height y made of the given rectangles [x0, z0, x1, z1], for water.
   * Water is drawn by its own shader and takes its colours from manifest.water.
   */
  addSurface(name, y, rects) {
    const pos = [], idx = [];
    for (const [x0, z0, x1, z1] of rects) {
      const b = pos.length / 3;
      pos.push(x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const n = pos.length / 3;
    const nrm = new Int8Array(n * 4), col = new Uint8Array(n * 4).fill(255);
    for (let i = 0; i < n; i++) nrm[i * 4 + 1] = 127;
    return this.addMesh(name, { pos: new Float32Array(pos), nrm, col, idx: new Uint32Array(idx) });
  }

  /**
   * A waterfall: a sheet of water that leaves the world's edge at x (between z0 and z1, at
   * height y) towards +x and falls 52 units, the pagoda garden's shape, which the engine's spray
   * follows. Sets manifest.waterfall too.
   */
  addWaterfall(name, { x, y, z0, z1, color = 0x8fd3e8, spray = 0xeaf6ff }) {
    const pos = [], col = [], idx = [];
    const rows = 48, drop = 52;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows, d = t * drop;
      const fx = x + 1.7 * (1 - Math.exp(-d * 0.22)) + d * 0.02;
      for (const [zz, uu] of [[z0 - d * 0.03, 0], [z1 + d * 0.03, 1]]) {
        pos.push(fx, y - d, zz);
        col.push(uu * 255, Math.round((1 - t) * 255), 0, 0); // the fall's shader reads uv from the colour
      }
      if (r < rows) { const b = r * 2; idx.push(b, b + 1, b + 3, b, b + 3, b + 2); }
    }
    const n = pos.length / 3;
    const nrm = new Int8Array(n * 4);
    for (let i = 0; i < n; i++) nrm[i * 4] = 127;
    const mesh = this.addMesh(name, { pos: new Float32Array(pos), nrm, col: new Uint8Array(col), idx: new Uint32Array(idx) });
    this.manifest.waterfall = { mesh, x, y, z0, z1, color: lin(color), spray: lin(spray) };
    return mesh;
  }

  /** Adds an object to draw; returns its number (for glows that follow it). */
  object(o) {
    this.manifest.objects.push({ cast: false, receive: true, emissive: [0, 0, 0], ...o });
    return this.manifest.objects.length - 1;
  }

  /** A soft halo, visible at night. */
  glow(pos, size, color = 0xffb259, strength = 1, follow = null) {
    const g = { pos: v3(pos), size, color: lin(color), strength };
    if (follow) { g.follow = follow.object; g.local = v3(follow.local); }
    this.manifest.glows.push(g);
  }

  /** A point light, lit at night. The engine uses the first four. */
  light(pos, color = 0xffa64d, intensity = 22, distance = 22, decay = 1.6) {
    this.manifest.lights.push({ pos: v3(pos), color: lin(color), intensity, distance, decay });
  }

  /**
   * Where petals (or leaves, or snow) come to rest: the top of the grid, sampled once per unit
   * around the origin. `scale` is the world size of one voxel. `level(vx, vz)` may return a
   * height in world units for a column instead (the surface of a pond, say).
   */
  groundFrom(grid, { half, scale = 1, offset = [0, 0, 0], level = null }) {
    const h = new Array(half * 2 * half * 2);
    for (let z = -half; z < half; z++) for (let x = -half; x < half; x++) {
      const vx = Math.floor((x + 0.5 - offset[0]) / scale), vz = Math.floor((z + 0.5 - offset[2]) / scale);
      const fixed = level ? level(vx, vz) : undefined;
      const top = grid.heightAt(vx, vz);
      h[(z + half) * half * 2 + x + half] = fixed !== undefined ? Math.round(fixed * 100) / 100 : top < -900 ? -999 : Math.round((top * scale + offset[1]) * 100) / 100;
    }
    this.manifest.ground = { half, heights: h };
  }

  build() {
    const m = this.manifest;
    m.meshes = this.parts.map(({ name, firstVertex, vertexCount, firstIndex, indexCount }) => ({ name, firstVertex, vertexCount, firstIndex, indexCount }));
    if (m.lights.length > 4) throw new Error('a scene has at most four point lights');
    if (160 + m.fireflies.items.length + m.glows.length > 1024) throw new Error('too many fireflies and glows (160 spray drops + fireflies + glows must stay within 1024)');
    const json = Buffer.from(JSON.stringify(m));
    const pad = (4 - (json.length % 4)) % 4;
    const binLen = this.vertices * 20 + this.indices * 4;
    const buf = Buffer.alloc(16 + json.length + pad + binLen);
    let o = 0;
    buf.write('KUMO', o); o += 4;
    buf.writeUInt32LE(1, o); o += 4;
    buf.writeUInt32LE(json.length + pad, o); o += 4;
    json.copy(buf, o); o += json.length;
    buf.fill(0x20, o, o + pad); o += pad;
    buf.writeUInt32LE(binLen, o); o += 4;
    for (const mesh of this.parts) for (const g of mesh.parts) {
      for (let i = 0, n = g.pos.length / 3; i < n; i++, o += 20) {
        buf.writeFloatLE(g.pos[i * 3], o); buf.writeFloatLE(g.pos[i * 3 + 1], o + 4); buf.writeFloatLE(g.pos[i * 3 + 2], o + 8);
        for (let k = 0; k < 4; k++) buf.writeInt8(g.nrm[i * 4 + k], o + 12 + k);
        for (let k = 0; k < 4; k++) buf.writeUInt8(g.col[i * 4 + k], o + 16 + k);
      }
    }
    for (const mesh of this.parts) for (const g of mesh.parts) {
      for (let i = 0; i < g.idx.length; i++, o += 4) buf.writeUInt32LE(g.idx[i] + g.base, o);
    }
    return { buf, json: json.length };
  }

  write(path) {
    const { buf, json } = this.build();
    writeFileSync(path, buf);
    const mb = (b) => (b / 1048576).toFixed(2);
    const m = this.manifest;
    console.log(`${path}: ${this.parts.length} meshes, ${this.vertices} vertices, ${this.indices / 3} triangles, ` +
      `${m.objects.length} objects, ${m.glows.length} glows, ${m.lights.length} lights, ${m.fireflies.items.length} fireflies`);
    for (const p of this.parts) if (p.stats) console.log(`  ${p.name}: ${p.stats.faces} voxel faces -> ${p.stats.quads} quads, ${p.vertexCount} vertices`);
    console.log(`size ${mb(buf.length)} MB (json ${mb(json)} MB, geometry ${mb(buf.length - json)} MB)`);
    return buf;
  }
}
