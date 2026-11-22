// Building blocks the scenes share: lit windows, snow, the rock under a floating island, clouds.

import { Grid, KIND_GLOW, KIND_SOLID, groups, mulberry32, mixHex, shadeHex } from './grid.mjs';
import { lin, v3 } from './kumo.mjs';

// ---------------------------------------------------------------- noise

function hash2(x, z, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 1440670441) ^ Math.imul(seed + 1, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth noise in 0..1. */
export function noise2(x, z, seed = 0) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const f = (t) => t * t * (3 - 2 * t);
  const sx = f(x - ix), sz = f(z - iz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

// ---------------------------------------------------------------- models

/**
 * A copy of a model with some of its windows lit. A window is a group of touching voxels in one
 * of the `glass` colours; each group is lit with probability `chance` in one of the `lit`
 * colours and glows at night. Unlit windows keep their colour, or take `dark` if given. Groups
 * of more than `largest` voxels are left alone.
 */
export function lightWindows(model, { glass, chance = 0.5, lit = [0xffd98a, 0xffc870, 0xffe9b8], dark = null, largest = 260, rand }) {
  const m = model.clone();
  const set = new Set(glass);
  for (const group of groups(m, (c) => set.has(c))) {
    if (group.length > largest) continue; // a wall or a garage door in a glass colour, not a window
    const on = rand() < chance;
    const color = on ? lit[Math.floor(rand() * lit.length)] : dark;
    if (color === null) continue;
    for (const i of group) { m.col[i] = color; m.kind[i] = on ? KIND_GLOW : KIND_SOLID; }
  }
  return m;
}

/** Lays snow on everything the sky can see: one voxel on top of every column. */
export function snow(grid, { color = 0xf4f7fb, skip = () => false } = {}) {
  const { sx, sy, sz } = grid;
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    for (let y = sy - 2; y >= 0; y--) {
      const i = (y * sz + z) * sx + x;
      if (!grid.kind[i]) continue;
      if (grid.kind[i] !== KIND_GLOW && !skip(x - grid.ox, y - grid.oy, z - grid.oz, grid.col[i])) {
        const up = i + sx * sz;
        grid.col[up] = color; grid.kind[up] = KIND_SOLID; grid.sway[up] = grid.sway[i];
      }
      break;
    }
  }
}

/** A copy of a model `k` times as large (every voxel becomes a block of k * k * k). */
export function enlarge(model, k) {
  const m = new Grid(model.sx * k, model.sy * k, model.sz * k);
  model.each((x, y, z, c, i) => {
    for (let dy = 0; dy < k; dy++) for (let dz = 0; dz < k; dz++) for (let dx = 0; dx < k; dx++) {
      const j = m.idx(x * k + dx, y * k + dy, z * k + dz);
      m.col[j] = c; m.kind[j] = model.kind[i]; m.sway[j] = model.sway[i];
    }
  });
  return m;
}

// ---------------------------------------------------------------- island

/** A round island with an uneven shore: (x, z) => inside? */
export function roundIsland(radius, seed = 1, wobble = 16) {
  return (x, z) => Math.hypot(x + 0.5, z + 0.5) <= radius - noise2(x / 38 + 9, z / 38 + 4, seed) * wobble;
}

/** A square with rounded corners and a slightly uneven edge: (x, z) => inside? */
export function roundedSquare(half, radius, seed = 1, wobble = 2.5) {
  return (x, z) => {
    const ax = Math.abs(x + 0.5), az = Math.abs(z + 0.5);
    const edge = noise2(x / 14, z / 14, seed) * wobble;
    const dx = Math.max(0, ax - (half - radius)), dz = Math.max(0, az - (half - radius));
    return Math.hypot(dx, dz) <= radius - edge && ax <= half - edge && az <= half - edge;
  };
}

/**
 * The rock under a floating island, as a coarse grid: one of its voxels is `cell` voxels of the
 * world wide, which keeps it cheap and makes it look like rough stone. It hangs below y = 0 and
 * gets deeper towards the middle. Bake it with { scale: scale * cell, sides: rockSides }.
 */
export function rockBase({ inside, half, cell = 6, depth = 14, seed = 7, soil = 0x5b4636, stone = [0x77716b, 0x6a645f, 0x5d5853, 0x807a72] }) {
  const n = Math.ceil(half / cell) + 1;
  const size = n * 2;
  const at = (cx, cz) => (cz + n) * size + cx + n;
  const land = new Uint8Array(size * size), dist = new Int16Array(size * size);
  for (let cz = -n; cz < n; cz++) for (let cx = -n; cx < n; cx++) {
    land[at(cx, cz)] = inside(Math.floor((cx + 0.5) * cell), Math.floor((cz + 0.5) * cell)) ? 1 : 0;
  }
  // steps to the nearest gap, by repeated relaxation
  for (let i = 0; i < dist.length; i++) dist[i] = land[i] ? 999 : 0;
  for (let pass = 0; pass < n * 2; pass++) {
    let changed = false;
    for (let cz = -n + 1; cz < n - 1; cz++) for (let cx = -n + 1; cx < n - 1; cx++) {
      const i = at(cx, cz);
      if (!land[i]) continue;
      const d = 1 + Math.min(dist[i - 1], dist[i + 1], dist[i - size], dist[i + size]);
      if (d < dist[i]) { dist[i] = d; changed = true; }
    }
    if (!changed) break;
  }
  const g = new Grid(size, depth + 2, size, n, depth + 2, n);
  for (let cz = -n + 1; cz < n - 1; cz++) for (let cx = -n + 1; cx < n - 1; cx++) {
    const e = dist[at(cx, cz)];
    if (!e) continue;
    const deep = Math.max(1, Math.min(depth, Math.round(Math.pow(e, 0.85) * 1.35 + (noise2(cx / 3, cz / 3, seed) - 0.5) * 3.2)));
    for (let k = 1; k <= deep; k++) {
      const patch = Math.floor(noise2(cx / 2.5 + k * 0.6, cz / 2.5 - k * 0.4, seed + 3) * stone.length) % stone.length;
      const color = k === 1 ? soil : shadeHex(stone[patch], 1 - (k / depth) * 0.3);
      g.set(cx, -k, cz, color);
    }
  }
  return g;
}

/** Only the rock's flanks can be seen: its top is under the island and the camera never looks up at it. */
export const rockSides = (axis) => axis !== 1;

// ---------------------------------------------------------------- clouds

function cloudGrid(seed, len) {
  const r = mulberry32(seed);
  const w = len, d = Math.max(6, Math.round(len * (0.45 + r() * 0.2))), h = 7;
  const g = new Grid(w + 6, h + 4, d + 6, 3, 0, 3);
  const blobs = 4 + Math.floor(r() * 4);
  for (let k = 0; k < blobs; k++) {
    const cx = w * (0.12 + 0.76 * r()), cz = d * (0.25 + 0.5 * r());
    const rr = 1.8 + r() * 2.6, cy = 0.6 + rr * 0.45;
    for (let y = 0; y <= h + 2; y++) for (let z = -3; z < d + 3; z++) for (let x = -3; x < w + 3; x++) {
      const dx = (x + 0.5 - cx) / (rr * 1.45), dy = (y + 0.5 - cy) / (rr * 0.8), dz = (z + 0.5 - cz) / rr;
      if (dx * dx + dy * dy + dz * dz <= 1) g.set(x, y, z, y < 1 ? 0xdfe5ef : 0xffffff);
    }
  }
  return { grid: g, w, d };
}

/**
 * Voxel clouds that drift around the scene in rings: far ones at the horizon, a few below the
 * island. A handful of cloud shapes is shared by all of them. `layers` are
 * { n, r: [min, max] radius, y: [min, max], s: [min, max] size of one cloud voxel, speed }.
 */
export function addClouds(scene, { seed = 77, shapes = 6, tint = 0x1a1e28, layers = [
  { n: 8, r: [250, 400], y: [-30, 70], s: [3.2, 5], speed: 0.006 },
  { n: 5, r: [95, 150], y: [-40, -54], s: [2, 2.9], speed: 0.01 },
  { n: 5, r: [0, 170], y: [-86, -104], s: [3.5, 5.5], speed: 0.004 },
] } = {}) {
  const r = mulberry32(seed);
  const meshes = [];
  for (let i = 0; i < shapes; i++) {
    const c = cloudGrid(seed * 13 + i, 12 + Math.floor(r() * 12));
    meshes.push(scene.addGrid(`cloud${i}`, c.grid, { offset: [-c.w / 2, 0, -c.d / 2] }));
  }
  let k = 0;
  for (const L of layers) {
    for (let i = 0; i < L.n; i++, k++) {
      const s = L.s[0] + r() * (L.s[1] - L.s[0]);
      scene.object({
        mesh: meshes[k % meshes.length], cast: false, receive: false, emissive: lin(tint),
        scale: v3([s, s * 0.8, s]), rotY: Math.round(r() * Math.PI * 1e4) / 1e4,
        orbit: {
          angle: (i / L.n) * Math.PI * 2 + r() * 0.6, radius: L.r[0] + r() * (L.r[1] - L.r[0]),
          y: L.y[0] + r() * (L.y[1] - L.y[0]), speed: L.speed * (0.6 + r() * 0.8), wobble: 1.5,
        },
      });
    }
  }
}

export { mixHex, shadeHex };
