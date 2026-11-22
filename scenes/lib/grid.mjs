// Voxel grids and the mesher that turns them into Kumo's vertex format.
//
// A Grid is a box of voxels, each with an sRGB colour (0xRRGGBB), a kind (solid or glowing) and
// a wind sway (0..1, for leaves). Scene scripts fill grids by hand (set, box) or by stamping
// MagicaVoxel models into them (stamp), and `meshGrid` bakes a grid into vertices:
//
//   20 bytes per vertex: f32 x,y,z | i8 nx,ny,nz,flags | u8 r,g,b,sway
//   rgb is the sRGB colour with ambient occlusion baked in; flags bit 0 marks a glowing voxel
//
// The mesher merges flat areas of one colour into large quads (greedy meshing), drops faces that
// can never be seen (rooms closed on all sides) and keeps the mesh watertight, see `meshGrid`.

export const KIND_SOLID = 1;
export const KIND_GLOW = 2;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shadeHex(c, f) {
  const ch = (v) => Math.min(255, Math.max(0, Math.round(v * f)));
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}

export function mixHex(a, b, t) {
  const ch = (s) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

export class Grid {
  /** A box of sx * sy * sz voxels. World position (x, y, z) is stored at (x + ox, y + oy, z + oz). */
  constructor(sx, sy, sz, ox = 0, oy = 0, oz = 0) {
    if (!(sx > 0 && sy > 0 && sz > 0) || sx > 2040 || sy > 2040 || sz > 2040) throw new Error(`grid size ${sx}x${sy}x${sz} is out of range`);
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.ox = ox; this.oy = oy; this.oz = oz;
    const n = sx * sy * sz;
    this.col = new Int32Array(n);
    this.kind = new Uint8Array(n);
    this.sway = new Uint8Array(n);
  }

  idx(x, y, z) {
    const gx = Math.floor(x) + this.ox, gy = Math.floor(y) + this.oy, gz = Math.floor(z) + this.oz;
    if (gx < 0 || gy < 0 || gz < 0 || gx >= this.sx || gy >= this.sy || gz >= this.sz) return -1;
    return (gy * this.sz + gz) * this.sx + gx;
  }

  /** Sets a voxel; positions outside the grid are ignored. */
  set(x, y, z, color, sway = 0, kind = KIND_SOLID) {
    const i = this.idx(x, y, z);
    if (i < 0) return;
    this.col[i] = color;
    this.kind[i] = kind;
    this.sway[i] = Math.round(Math.min(1, Math.max(0, sway)) * 255);
  }

  get(x, y, z) {
    const i = this.idx(x, y, z);
    return i < 0 ? 0 : this.kind[i];
  }

  colorAt(x, y, z) {
    const i = this.idx(x, y, z);
    return i < 0 || !this.kind[i] ? -1 : this.col[i];
  }

  clear(x, y, z) {
    const i = this.idx(x, y, z);
    if (i >= 0) this.kind[i] = 0;
  }

  /** Fills the box from (x0, y0, z0) to (x1, y1, z1), both included. `color` may be a function of (x, y, z). */
  box(x0, y0, z0, x1, y1, z1, color, sway = 0, kind = KIND_SOLID) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      this.set(x, y, z, typeof color === 'function' ? color(x, y, z) : color, sway, kind);
    }
  }

  /** Calls fn(x, y, z, color, i) for every voxel, in world coordinates. */
  each(fn) {
    const { sx, sy, sz } = this;
    for (let y = 0, i = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++, i++) {
      if (this.kind[i]) fn(x - this.ox, y - this.oy, z - this.oz, this.col[i], i);
    }
  }

  /** The top of the highest voxel in the column at (x, z), or `none` if the column is empty. */
  heightAt(x, z, none = -999) {
    for (let gy = this.sy - 1; gy >= 0; gy--) if (this.get(x, gy - this.oy, z)) return gy - this.oy + 1;
    return none;
  }

  count() {
    let n = 0;
    for (let i = 0; i < this.kind.length; i++) if (this.kind[i]) n++;
    return n;
  }

  clone() {
    const g = new Grid(this.sx, this.sy, this.sz, this.ox, this.oy, this.oz);
    g.col.set(this.col); g.kind.set(this.kind); g.sway.set(this.sway);
    if (this.index) g.index = this.index.slice();
    return g;
  }

  /**
   * Copies a model (another grid, usually from `loadVox`) into this one.
   *   at      where the model's lowest corner goes; with `center` x and z name the middle of
   *           its footprint instead (y is always the bottom)
   *   rot     quarter turns around the vertical axis, 0..3
   *   paint   (color, x, y, z, i) => colour, or { color, sway, glow }, or null to leave the voxel
   *           out; x, y, z are the model's own coordinates and i its voxel index
   * Returns the box the model now fills: { x0, y0, z0, x1, y1, z1 } (both included).
   */
  stamp(model, at, { rot = 0, center = false, paint = null } = {}) {
    const r = ((rot % 4) + 4) % 4;
    const w = r % 2 ? model.sz : model.sx, d = r % 2 ? model.sx : model.sz;
    const bx = center ? Math.round(at[0] - w / 2) : at[0], by = at[1], bz = center ? Math.round(at[2] - d / 2) : at[2];
    const { sx, sy, sz } = model;
    for (let y = 0, i = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++, i++) {
      if (!model.kind[i]) continue;
      let color = model.col[i], sway = model.sway[i] / 255, kind = model.kind[i];
      if (paint) {
        const p = paint(color, x, y, z, i);
        if (p === null || p === undefined) continue;
        if (typeof p === 'number') color = p;
        else { color = p.color ?? color; sway = p.sway ?? sway; if (p.glow !== undefined) kind = p.glow ? KIND_GLOW : KIND_SOLID; }
      }
      const tx = r === 0 ? x : r === 1 ? sz - 1 - z : r === 2 ? sx - 1 - x : z;
      const tz = r === 0 ? z : r === 1 ? x : r === 2 ? sz - 1 - z : sx - 1 - x;
      this.set(bx + tx, by + y, bz + tz, color, sway, kind);
    }
    return { x0: bx, y0: by, z0: bz, x1: bx + w - 1, y1: by + sy - 1, z1: bz + d - 1 };
  }
}

/**
 * Groups of touching voxels that pass `test(color, x, y, z, i)`: for windows, each pane of glass
 * is one group. Returns an array of groups, each a list of voxel indices into the grid's arrays.
 */
export function groups(grid, test) {
  const { sx, sy, sz } = grid;
  const mark = new Uint8Array(sx * sy * sz);
  grid.each((x, y, z, c, i) => { if (test(c, x, y, z, i)) mark[i] = 1; });
  const out = [], stack = [];
  const step = [1, -1, sx, -sx, sx * sz, -sx * sz];
  for (let s = 0; s < mark.length; s++) {
    if (mark[s] !== 1) continue;
    const group = [];
    mark[s] = 2; stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      group.push(i);
      const x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / (sx * sz));
      const ok = [x + 1 < sx, x > 0, z + 1 < sz, z > 0, y + 1 < sy, y > 0];
      for (let k = 0; k < 6; k++) {
        const j = i + step[k];
        if (ok[k] && mark[j] === 1) { mark[j] = 2; stack.push(j); }
      }
    }
    out.push(group);
  }
  return out;
}

// ---------------------------------------------------------------- mesher

const AO_CURVE = [0.5, 0.68, 0.85, 1.0]; // the same curve as the pagoda's mesher
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Empty cells that the outside can reach: a face is only visible next to one of these. */
function openCells(g) {
  const { sx, sy, sz, kind } = g;
  const n = sx * sy * sz, layer = sx * sz;
  const open = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const push = (i) => { if (!kind[i] && !open[i]) { open[i] = 1; queue[tail++] = i; } };
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    if (x === 0 || y === 0 || z === 0 || x === sx - 1 || y === sy - 1 || z === sz - 1) push((y * sz + z) * sx + x);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / layer);
    if (x + 1 < sx) push(i + 1);
    if (x > 0) push(i - 1);
    if (z + 1 < sz) push(i + sx);
    if (z > 0) push(i - sx);
    if (y + 1 < sy) push(i + layer);
    if (y > 0) push(i - layer);
  }
  return open;
}

/**
 * Bakes a grid into vertices and indices.
 *
 *   scale      size of one voxel in world units (default 1)
 *   offset     added to every position after scaling
 *   greedy     merge flat areas of one colour and one shade into large quads (default on). A
 *              face with an ambient-occlusion gradient only grows in the direction in which
 *              its shade does not change, so the result looks like the unmerged mesh.
 *   hidden     drop faces of closed rooms nobody can look into (default on)
 *   sides      which faces to bake: 'all', or a filter (axis, sign) => boolean
 *
 * Where a large quad meets the corners of smaller neighbours along its edge, those corners are
 * added to it (it is then drawn as a fan around its centre). Without that, single pixels of sky
 * flicker through the seams ("T-junctions").
 *
 * Returns { pos: Float32Array, nrm: Int8Array (4 per vertex), col: Uint8Array (4 per vertex),
 * idx: Uint32Array, quads, faces } where faces is the number of voxel faces before merging.
 */
export function meshGrid(g, { scale = 1, offset = [0, 0, 0], greedy = true, hidden = true, sides = 'all' } = {}) {
  const { sx, sy, sz, kind } = g;
  const dims = [sx, sy, sz];
  const open = hidden ? openCells(g) : null;
  const occ = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : kind[(y * sz + z) * sx + x] ? 1 : 0);
  const seen = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return true;
    const i = (y * sz + z) * sx + x;
    return !kind[i] && (!open || open[i] === 1);
  };

  // ---- pass 1: faces -> quads (in grid coordinates)
  const quads = [];
  let faces = 0;
  const c = [0, 0, 0], b = [0, 0, 0], p = [0, 0, 0];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    const nu = dims[u], nv = dims[v];
    const mask = new Float64Array(nu * nv);
    const grow = new Uint8Array(nu * nv);
    for (const s of [1, -1]) {
      if (sides !== 'all' && !sides(d, s)) continue;
      const corners = s > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
      for (let plane = 0; plane < dims[d]; plane++) {
        let any = false;
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
          c[d] = plane; c[u] = i; c[v] = j;
          const ci = (c[1] * sz + c[2]) * sx + c[0];
          let key = 0;
          if (kind[ci]) {
            b[0] = c[0]; b[1] = c[1]; b[2] = c[2]; b[d] += s;
            if (seen(b[0], b[1], b[2])) {
              let ao = 0;
              for (let q = 0; q < 4; q++) {
                const du = corners[q][0] ? 1 : -1, dv = corners[q][1] ? 1 : -1;
                p[0] = b[0]; p[1] = b[1]; p[2] = b[2];
                p[u] += du;
                const s1 = occ(p[0], p[1], p[2]);
                p[v] += dv;
                const cc = occ(p[0], p[1], p[2]);
                p[u] -= du;
                const s2 = occ(p[0], p[1], p[2]);
                const a = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
                ao |= a << (q * 2);
              }
              // colour 24 bits | glow 1 | sway 8 | ao 8, plus one so that a key is never zero
              key = g.col[ci] * 131072 + (kind[ci] === KIND_GLOW ? 65536 : 0) + g.sway[ci] * 256 + ao + 1;
              // In which directions may this face grow? A face whose shade is the same at both
              // ends of a direction can be merged along it without changing a single pixel.
              const q00 = ao & 3, q11 = (ao >> 4) & 3;
              const q10 = (ao >> (s > 0 ? 2 : 6)) & 3, q01 = (ao >> (s > 0 ? 6 : 2)) & 3;
              grow[j * nu + i] = !greedy ? 0 : (q00 === q10 && q01 === q11 ? 1 : 0) | (q00 === q01 && q10 === q11 ? 2 : 0);
              faces++;
              any = true;
            }
          }
          mask[j * nu + i] = key;
        }
        if (!any) continue;
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
          const k = mask[j * nu + i];
          if (!k) continue;
          let w = 1, h = 1;
          const dir = grow[j * nu + i];
          if (dir & 1) while (i + w < nu && mask[j * nu + i + w] === k) w++;
          if (dir & 2) rows: for (; j + h < nv; h++) for (let m = 0; m < w; m++) if (mask[(j + h) * nu + i + m] !== k) break rows;
          for (let hh = 0; hh < h; hh++) mask.fill(0, (j + hh) * nu + i, (j + hh) * nu + i + w);
          quads.push({ d, s, plane, i, j, w, h, key: k - 1 });
        }
      }
    }
  }

  // ---- pass 2: every corner position, so large quads can pick up their neighbours' corners
  const pack = (x, y, z) => (x * 2048 + y) * 2048 + z;
  const cornerOf = (q, cu, cv, out) => {
    const u = (q.d + 1) % 3, v = (q.d + 2) % 3;
    out[q.d] = q.plane + (q.s > 0 ? 1 : 0);
    out[u] = q.i + cu * q.w;
    out[v] = q.j + cv * q.h;
    return out;
  };
  const corners = new Set();
  const t = [0, 0, 0];
  for (const q of quads) for (const [cu, cv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { cornerOf(q, cu, cv, t); corners.add(pack(t[0], t[1], t[2])); }

  // ---- pass 3: vertices
  const pos = [], nrm = [], col = [], idx = [];
  const shade = new Map();
  const colour = (hex, ao) => {
    const k = hex * 4 + ao;
    let r = shade.get(k);
    if (!r) {
      const l = AO_CURVE[ao];
      r = [16, 8, 0].map((sh) => Math.max(0, Math.min(255, Math.round(toSrgb(toLinear(((hex >> sh) & 255) / 255) * l) * 255))));
      shade.set(k, r);
    }
    return r;
  };
  const vertex = (x, y, z, q, rgb, sway, glow) => {
    pos.push((x - g.ox) * scale + offset[0], (y - g.oy) * scale + offset[1], (z - g.oz) * scale + offset[2]);
    nrm.push(q.d === 0 ? q.s * 127 : 0, q.d === 1 ? q.s * 127 : 0, q.d === 2 ? q.s * 127 : 0, glow);
    col.push(rgb[0], rgb[1], rgb[2], sway);
    return pos.length / 3 - 1;
  };
  const a0 = [0, 0, 0], a1 = [0, 0, 0];
  for (const q of quads) {
    const ao = q.key % 256, sway = Math.floor(q.key / 256) % 256, glow = Math.floor(q.key / 65536) % 2, hex = Math.floor(q.key / 131072);
    const order = q.s > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
    const aos = [0, 1, 2, 3].map((k) => (ao >> (k * 2)) & 3);
    // the outline, with the corners of neighbours that sit on an edge
    const ring = [];
    let extra = false;
    for (let k = 0; k < 4; k++) {
      cornerOf(q, order[k][0], order[k][1], a0);
      cornerOf(q, order[(k + 1) % 4][0], order[(k + 1) % 4][1], a1);
      ring.push([a0[0], a0[1], a0[2], aos[k]]);
      const len = Math.abs(a1[0] - a0[0]) + Math.abs(a1[1] - a0[1]) + Math.abs(a1[2] - a0[2]);
      for (let m = 1; m < len; m++) {
        const x = a0[0] + ((a1[0] - a0[0]) / len) * m, y = a0[1] + ((a1[1] - a0[1]) / len) * m, z = a0[2] + ((a1[2] - a0[2]) / len) * m;
        if (corners.has(pack(x, y, z))) { ring.push([x, y, z, aos[k]]); extra = true; }
      }
    }
    if (!extra) {
      const base = pos.length / 3;
      for (const r of ring) vertex(r[0], r[1], r[2], q, colour(hex, r[3]), sway, glow);
      if (aos[0] + aos[2] > aos[1] + aos[3]) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    } else {
      // only merged quads get here: their shade is constant along the long edges, so the
      // middle is the mean of the corners (in linear light, where the GPU interpolates)
      const mid = [0, 1, 2].map((ch) => {
        let sum = 0;
        for (const a of aos) sum += toLinear(colour(hex, a)[ch] / 255);
        return Math.round(toSrgb(sum / 4) * 255);
      });
      cornerOf(q, 0.5, 0.5, a0);
      const centre = vertex(a0[0], a0[1], a0[2], q, mid, sway, glow);
      const first = pos.length / 3;
      for (const r of ring) vertex(r[0], r[1], r[2], q, colour(hex, r[3]), sway, glow);
      for (let k = 0; k < ring.length; k++) idx.push(centre, first + k, first + ((k + 1) % ring.length));
    }
  }
  return { pos: new Float32Array(pos), nrm: new Int8Array(nrm), col: new Uint8Array(col), idx: new Uint32Array(idx), quads: quads.length, faces };
}
