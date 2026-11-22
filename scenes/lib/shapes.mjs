// Meshes that are not made of voxels: flat planes, discs, curtains, spheres. Same vertex format
// as the mesher in grid.mjs (position, normal + glow flag, sRGB colour + wind sway), so the result
// goes straight into SceneWriter.addMesh.
//
//   const m = new Shapes();
//   m.quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], 0xff00ff, { glow: true });
//   s.object({ mesh: s.addMesh('sign', m.build()) });
//
// Corners go counter-clockwise as seen from the front (the side the normal points to), which is
// the side the engine draws.

const clampByte = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));

function normalOf(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

export class Shapes {
  constructor() {
    this.pos = []; this.nrm = []; this.col = []; this.idx = [];
  }

  get vertices() { return this.pos.length / 3; }

  /** One vertex; `color` is 0xRRGGBB (sRGB). Returns its number. */
  vertex(p, n, color, { glow = false, sway = 0 } = {}) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(clampByte(n[0]), clampByte(n[1]), clampByte(n[2]), glow ? 1 : 0);
    this.col.push((color >> 16) & 255, (color >> 8) & 255, color & 255, Math.round(Math.max(0, Math.min(1, sway)) * 255));
    return this.vertices - 1;
  }

  /**
   * A flat polygon from corners in counter-clockwise order (seen from the front), drawn as a fan.
   * `color` is one colour or one per corner; `normal` defaults to the polygon's own.
   */
  poly(corners, color, { glow = false, sway = 0, normal = null } = {}) {
    const n = normal || normalOf(corners[0], corners[1], corners[2]);
    const first = this.vertices;
    corners.forEach((p, i) => this.vertex(p, n, Array.isArray(color) ? color[i] : color, { glow, sway: Array.isArray(sway) ? sway[i] : sway }));
    for (let i = 1; i + 1 < corners.length; i++) this.idx.push(first, first + i, first + i + 1);
    return this;
  }

  quad(a, b, c, d, color, options) { return this.poly([a, b, c, d], color, options); }

  /** A rectangle lying flat at height y, facing up: x0..x1, z0..z1. */
  flat(x0, z0, x1, z1, y, color, options) {
    return this.poly([[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], color, options);
  }

  /** An axis-aligned box; `color` is one colour or { top, side, bottom }. */
  box(x0, y0, z0, x1, y1, z1, color, options = {}) {
    const c = typeof color === 'number' ? { top: color, side: color, bottom: color } : color;
    this.poly([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], c.top, options);
    if (!options.noBottom) this.poly([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], c.bottom ?? c.side, options);
    this.poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], c.side, options); // +z
    this.poly([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], c.side, options); // -z
    this.poly([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], c.side, options); // +x
    this.poly([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], c.side, options); // -x
    return this;
  }

  /** Appends another Shapes (or a meshGrid result) moved by `offset`. */
  add(g, offset = [0, 0, 0]) {
    const base = this.vertices;
    for (let i = 0; i < g.pos.length; i += 3) this.pos.push(g.pos[i] + offset[0], g.pos[i + 1] + offset[1], g.pos[i + 2] + offset[2]);
    for (const v of g.nrm) this.nrm.push(v);
    for (const v of g.col) this.col.push(v);
    for (const i of g.idx) this.idx.push(i + base);
    return this;
  }

  /** The geometry in the form SceneWriter.addMesh takes. */
  build() {
    return { pos: new Float32Array(this.pos), nrm: new Int8Array(this.nrm), col: new Uint8Array(this.col), idx: new Uint32Array(this.idx) };
  }
}

/**
 * A spherical cap: the part of a sphere of radius `r` around `center` within `angle` radians of
 * its top, as `rings` rings of `segments` vertices, finer near the top. `color(x, y, z, nx, ny, nz)`
 * gives each vertex its colour (or { color, glow }). Normals point outwards, so it is lit like a
 * planet seen from above.
 */
export function sphereCap(shapes, { center, r, angle, rings = 64, segments = 128, color, power = 1.6 }) {
  const first = shapes.vertices;
  const at = (k, s) => {
    const t = Math.pow(k / rings, power) * angle, a = (s / segments) * Math.PI * 2;
    const nx = Math.sin(t) * Math.cos(a), ny = Math.cos(t), nz = Math.sin(t) * Math.sin(a);
    return [[center[0] + nx * r, center[1] + ny * r, center[2] + nz * r], [nx, ny, nz]];
  };
  const put = (p, n) => {
    const c = color(p[0], p[1], p[2], n[0], n[1], n[2]);
    return typeof c === 'number' ? shapes.vertex(p, n, c) : shapes.vertex(p, n, c.color, { glow: c.glow });
  };
  const top = put(...at(0, 0));
  const ring = [];
  for (let k = 1; k <= rings; k++) {
    const row = [];
    for (let s = 0; s < segments; s++) row.push(put(...at(k, s)));
    ring.push(row);
  }
  for (let s = 0; s < segments; s++) shapes.idx.push(top, ring[0][(s + 1) % segments], ring[0][s]);
  for (let k = 0; k + 1 < rings; k++) for (let s = 0; s < segments; s++) {
    const a = ring[k][s], b = ring[k][(s + 1) % segments], c = ring[k + 1][(s + 1) % segments], d = ring[k + 1][s];
    shapes.idx.push(a, b, c, a, c, d);
  }
  return shapes.vertices - first;
}
