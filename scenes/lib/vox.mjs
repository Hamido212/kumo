// Reads MagicaVoxel .vox files (https://github.com/ephtracy/voxel-model, format version 150/200).
//
//   const model = loadVox('house.vox');      // a Grid, y up, one unit per voxel
//
// Understands SIZE/XYZI/RGBA, the scene graph (nTRN/nGRP/nSHP, translations and the 24 axis
// rotations) and the material chunks (MATL and the old MATT) far enough to know which palette
// entries are emissive or glass. Everything else (layers, cameras, render settings) is skipped.

import { readFileSync } from 'node:fs';
import { Grid, KIND_SOLID, KIND_GLOW } from './grid.mjs';

// The palette MagicaVoxel uses when a file has no RGBA chunk: a 6x6x6 colour cube without black,
// then ramps of red, green, blue and grey. Index 0 is "no voxel".
function defaultPalette() {
  const p = new Int32Array(256);
  const steps = [0xff, 0xcc, 0x99, 0x66, 0x33, 0x00];
  let i = 1;
  for (const r of steps) for (const g of steps) for (const b of steps) {
    if (i <= 215) p[i++] = (r << 16) | (g << 8) | b; // blue runs fastest in the table
  }
  const ramp = [0xee, 0xdd, 0xbb, 0xaa, 0x88, 0x77, 0x55, 0x44, 0x22, 0x11];
  for (const shift of [16, 8, 0]) for (const v of ramp) p[i++] = v << shift;
  for (const v of ramp) p[i++] = (v << 16) | (v << 8) | v;
  return p;
}

/**
 * Parses the bytes of a .vox file.
 * Returns { models: [{ size: [x, y, z], xyzi: Uint8Array }], palette: Int32Array(256) of 0xRRGGBB
 * (index 0 unused), emissive: Set<index>, glass: Set<index>, placements: [{ model, t, r }] }.
 * Coordinates are MagicaVoxel's own here (z up); `voxToGrid` turns them into a Kumo grid.
 */
export function parseVox(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'VOX ') throw new Error('not a MagicaVoxel .vox file');
  const models = [];
  let palette = null;
  const emissive = new Set(), glass = new Set();
  const nodes = new Map();
  let pendingSize = null;

  let o = 0;
  const int = () => { const v = buf.readInt32LE(o); o += 4; return v; };
  const str = () => { const n = int(); if (n < 0 || o + n > buf.length) throw new Error('damaged .vox file (string)'); const s = buf.toString('utf8', o, o + n); o += n; return s; };
  const dict = () => { const d = {}; const n = int(); for (let i = 0; i < n; i++) { const k = str(); d[k] = str(); } return d; };

  function chunk(end) {
    while (o + 12 <= end) {
      const id = buf.toString('latin1', o, o + 4);
      const size = buf.readInt32LE(o + 4), children = buf.readInt32LE(o + 8);
      const start = o + 12, next = start + size;
      if (size < 0 || children < 0 || next + children > buf.length) throw new Error(`damaged .vox file (chunk ${id})`);
      o = start;
      switch (id) {
        case 'SIZE': pendingSize = [int(), int(), int()]; break;
        case 'XYZI': {
          const n = int();
          if (n < 0 || o + n * 4 > next) throw new Error('damaged .vox file (XYZI)');
          if (!pendingSize) throw new Error('damaged .vox file (XYZI without SIZE)');
          models.push({ size: pendingSize, xyzi: buf.subarray(o, o + n * 4) });
          pendingSize = null;
          break;
        }
        case 'RGBA': {
          palette = new Int32Array(256);
          for (let i = 0; i < 255; i++) palette[i + 1] = (buf[o + i * 4] << 16) | (buf[o + i * 4 + 1] << 8) | buf[o + i * 4 + 2];
          break;
        }
        case 'MATL': {
          const index = int() & 255, d = dict();
          if (d._type === '_emit' || d._type === '_blend' && +d._emit > 0) emissive.add(index);
          if (d._type === '_glass') glass.add(index);
          break;
        }
        case 'MATT': { // files written before 0.99
          const index = int() & 255, type = int();
          if (type === 3) emissive.add(index);
          if (type === 2) glass.add(index);
          break;
        }
        case 'nTRN': {
          const node = int(); dict();
          const child = int(); int(); int();
          const frames = int();
          let t = [0, 0, 0], r = 4; // 4 = identity
          for (let f = 0; f < frames; f++) {
            const d = dict();
            if (f) continue;
            if (d._t) t = d._t.trim().split(/\s+/).map(Number);
            if (d._r) r = +d._r;
          }
          nodes.set(node, { type: 'trn', child, t, r });
          break;
        }
        case 'nGRP': {
          const node = int(); dict();
          const n = int(), kids = [];
          for (let i = 0; i < n; i++) kids.push(int());
          nodes.set(node, { type: 'grp', kids });
          break;
        }
        case 'nSHP': {
          const node = int(); dict();
          const n = int(), ids = [];
          for (let i = 0; i < n; i++) { ids.push(int()); dict(); }
          nodes.set(node, { type: 'shp', model: ids[0] });
          break;
        }
        default: break;
      }
      o = next;
      if (children) chunk(next + children);
      o = next + children;
    }
  }
  o = 8;
  chunk(buf.length);
  if (!models.length) throw new Error('the .vox file has no model');

  // walk the scene graph; a file without one holds animation frames, of which the first counts
  const placements = [];
  const IDENT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const mul = (a, b) => a.map((row) => [0, 1, 2].map((c) => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c]));
  const apply = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  function rotation(byte) {
    const i0 = byte & 3, i1 = (byte >> 2) & 3;
    if (i0 > 2 || i1 > 2 || i0 === i1) return IDENT;
    const i2 = 3 - i0 - i1;
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    m[0][i0] = byte & 16 ? -1 : 1;
    m[1][i1] = byte & 32 ? -1 : 1;
    m[2][i2] = byte & 64 ? -1 : 1;
    return m;
  }
  function walk(id, m, t, depth) {
    const n = nodes.get(id);
    if (!n || depth > 64) return;
    if (n.type === 'trn') {
      const nt = apply(m, n.t).map((v, k) => v + t[k]);
      walk(n.child, mul(m, rotation(n.r)), nt, depth + 1);
    } else if (n.type === 'grp') {
      for (const k of n.kids) walk(k, m, t, depth + 1);
    } else if (n.model >= 0 && n.model < models.length) {
      placements.push({ model: n.model, r: m, t });
    }
  }
  if (nodes.has(0)) walk(0, IDENT, [0, 0, 0], 0);
  if (!placements.length) placements.push({ model: 0, r: IDENT, t: null });

  return { models, palette: palette || defaultPalette(), emissive, glass, placements };
}

/**
 * Turns a parsed file into one Grid with y up: MagicaVoxel's (x, y, z) becomes (x, z, -y), which
 * keeps the model the right way round (text on a sign stays readable). The grid's origin is the
 * model's lowest corner. `grid.index` holds each voxel's palette index for later recolouring.
 * Emissive palette entries become glowing voxels.
 */
export function voxToGrid(vox) {
  const pts = [];
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const pl of vox.placements) {
    const m = vox.models[pl.model];
    const half = m.size.map((s) => Math.floor(s / 2));
    for (let i = 0; i < m.xyzi.length; i += 4) {
      let p = [m.xyzi[i], m.xyzi[i + 1], m.xyzi[i + 2]];
      const c = m.xyzi[i + 3];
      if (!c) continue;
      if (pl.t) {
        // the scene graph places a model by its centre; rotate the voxel's own centre
        const q = [p[0] - half[0] + 0.5, p[1] - half[1] + 0.5, p[2] - half[2] + 0.5];
        p = pl.r.map((row, k) => Math.floor(row[0] * q[0] + row[1] * q[1] + row[2] * q[2] + pl.t[k]));
      }
      for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
      pts.push(p[0], p[1], p[2], c);
    }
  }
  if (!pts.length) throw new Error('the .vox file has no voxels');
  const sx = max[0] - min[0] + 1, sy = max[2] - min[2] + 1, sz = max[1] - min[1] + 1;
  if (sx > 2040 || sy > 2040 || sz > 2040) throw new Error('the .vox scene is larger than 2040 voxels');
  const g = new Grid(sx, sy, sz);
  g.index = new Uint8Array(sx * sy * sz);
  for (let i = 0; i < pts.length; i += 4) {
    const x = pts[i] - min[0], y = pts[i + 2] - min[2], z = max[1] - pts[i + 1], c = pts[i + 3];
    g.set(x, y, z, vox.palette[c], 0, vox.emissive.has(c) ? KIND_GLOW : KIND_SOLID);
    g.index[g.idx(x, y, z)] = c;
  }
  return g;
}

export function loadVox(path) {
  try {
    return voxToGrid(parseVox(readFileSync(path)));
  } catch (e) {
    throw new Error(`${path}: ${e.message}`);
  }
}
