// Bakes "Neon Alley": a block of a rainy future city on a floating slab. Four alleys meet on a
// small square with a sign pillar; low houses crowd round it, stepped towers stand at the corners.
// Signs with made-up glyphs, billboards and strings of lamps glow over wet streets, passenger
// drones circle the roofs. By day it is an overcast, grey city with its signs still on; at night
// the neon takes over.
//
//   node scenes/alley/bake.mjs [out.kumo]              default: scenes/out/neon-alley.kumo
//
// Everything is generated here; no third-party models. The signs show shapes, not writing.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grid, KIND_GLOW, KIND_SOLID, meshGrid, mulberry32, shadeHex } from '../lib/grid.mjs';
import { SceneWriter, lin, skyKeys, v3 } from '../lib/kumo.mjs';
import { noise2, rockBase, rockSides, roundedSquare } from '../lib/parts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(here, '..', 'out', 'neon-alley.kumo');
const rand = mulberry32(2077);
const pick = (list, r = rand) => list[Math.floor(r() * list.length)];
const stage = (name) => { if (process.env.KUMO_STAGES) console.log(`  after ${name}: ${meshGrid(world).pos.length / 3} vertices`); };

const SCALE = 0.3;   // world units per voxel
const HALF = 100;    // the slab reaches from -100 to 100 voxels
const SLAB = 4;
const PLAZA = 22;    // the square: |x|, |z| <= 22
const ALLEY = 6;     // the alleys: |x| <= 6 or |z| <= 6
const world = new Grid(HALF * 2 + 4, 176, HALF * 2 + 4, HALF + 2, SLAB + 2, HALF + 2);
const inside = roundedSquare(HALF, 28, 7);
const U = (x, y, z) => [x * SCALE, y * SCALE, z * SCALE];

// ---------------------------------------------------------------- palette

const NEON = { pink: 0xe0207e, cyan: 0x18c0e8, amber: 0xf09a20, lime: 0x70e040, violet: 0x9a50ff, red: 0xf02a3a };
const NEON_LIST = [NEON.pink, NEON.cyan, NEON.amber, NEON.lime, NEON.violet, NEON.pink, NEON.cyan];
const LIT = [0xd09050, 0xc88040, 0xe0b070, 0x80c0d8, 0xd09050, 0xc070b0];
const GLASS = 0x1e2632, SIGN_BACK = 0x14101c, FRAME = 0x1e1c26;

// ---------------------------------------------------------------- ground

const isPlaza = (x, z) => Math.abs(x + 0.5) <= PLAZA && Math.abs(z + 0.5) <= PLAZA;
const isStreet = (x, z) => isPlaza(x, z) || Math.abs(z + 0.5) <= ALLEY || Math.abs(x + 0.5) <= ALLEY;
const TILE = [0x2a2e36, 0x30343c], ASPHALT = [0x23272f, 0x262a33], CONCRETE = 0x3a3d44, GUIDE = 0x1890b0;
for (let z = -HALF; z < HALF; z++) for (let x = -HALF; x < HALF; x++) {
  if (!inside(x, z)) continue;
  let color = CONCRETE, kind = KIND_SOLID;
  if (isPlaza(x, z)) color = TILE[((x >> 2) + (z >> 2)) & 1];
  else if (isStreet(x, z)) {
    color = ASPHALT[noise2(x / 6, z / 6, 4) > 0.5 ? 1 : 0];
    const along = Math.abs(z + 0.5) <= ALLEY ? x : z, across = Math.abs(z + 0.5) <= ALLEY ? z : x;
    if (Math.abs(across + 0.5) <= 0.5 && ((along + 400) % 8) < 4) { color = GUIDE; kind = KIND_GLOW; }
  }
  for (let y = -SLAB; y <= 0; y++) world.set(x, y, z, y === 0 ? color : 0x2a2c31, 0, y === 0 ? kind : KIND_SOLID);
}
stage('ground');

// ---------------------------------------------------------------- glyphs: strokes in a 5 x 5 cell, never letters

function glyph(r) {
  const cells = new Set();
  const strokes = 2 + Math.floor(r() * 3);
  for (let k = 0; k < strokes; k++) {
    const vertical = r() < 0.5, at = Math.floor(r() * 5), from = Math.floor(r() * 3), len = 2 + Math.floor(r() * (5 - from - 1));
    for (let i = from; i < from + len && i < 5; i++) cells.add(vertical ? `${at},${i}` : `${i},${at}`);
  }
  return (u, v) => cells.has(`${u},${v}`);
}

// ---------------------------------------------------------------- building parts

/**
 * The four faces of a box, each walked in its own coordinates: u along the face, y up, and
 * `at(u, y, d)` the voxel d in front of it (d = 0 is the face itself).
 */
function faces({ x0, x1, z0, z1 }) {
  return [
    { n: [0, 1], w: x1 - x0 + 1, at: (u, y, d) => [x0 + u, y, z1 + d] },
    { n: [0, -1], w: x1 - x0 + 1, at: (u, y, d) => [x1 - u, y, z0 - d] },
    { n: [1, 0], w: z1 - z0 + 1, at: (u, y, d) => [x1 + d, y, z1 - u] },
    { n: [-1, 0], w: z1 - z0 + 1, at: (u, y, d) => [x0 - d, y, z0 + u] },
  ];
}
/** Does the face look onto the square or an alley (checked in the middle of the face)? */
const onStreet = (f) => { const [x, , z] = f.at(Math.floor(f.w / 2), 0, 2); return isStreet(x, z); };

const FLOOR = 6, SHOP = 9;
const halos = [];      // { p (voxels), color, size, strength }
const beacons = [];

function sign(p, color, size, strength = 0.55) { halos.push({ p, color, size, strength }); }

/** A blade sign standing out from a face: a dark frame, glowing strokes on both sides. */
function bladeSign(f, u, y0, height, color, r) {
  const depth = 7;
  for (let y = y0; y < y0 + height; y++) for (let d = 1; d <= depth; d++) for (const t of [0, 1]) {
    const edge = y === y0 || y === y0 + height - 1 || d === 1 || d === depth;
    world.set(...f.at(u + t, y, d), edge ? FRAME : SIGN_BACK);
  }
  for (let y = y0 + 2; y + 5 <= y0 + height - 1; y += 6) {
    const g = glyph(r);
    for (let gv = 0; gv < 5; gv++) for (let gu = 0; gu < 5; gu++) if (g(gu, gv)) for (const t of [0, 1]) world.set(...f.at(u + t, y + 4 - gv, gu + 2), color, 0, KIND_GLOW);
  }
  sign(f.at(u + 1, y0 + height / 2, depth / 2 + 1), color, height * 0.55);
}

/** A panel sign flat on a face: a glowing border round dark glyphs, or the reverse. */
function panelSign(f, u0, y0, w, hgt, color, inverse, r) {
  for (let y = y0; y < y0 + hgt; y++) for (let u = u0; u < u0 + w; u++) {
    const border = y === y0 || y === y0 + hgt - 1 || u === u0 || u === u0 + w - 1;
    world.set(...f.at(u, y, 1), border || inverse ? color : SIGN_BACK, 0, border || inverse ? KIND_GLOW : KIND_SOLID);
  }
  const gy = y0 + Math.floor((hgt - 5) / 2);
  for (let u = u0 + 2; u + 5 <= u0 + w - 1; u += 6) {
    const g = glyph(r);
    for (let gv = 0; gv < 5; gv++) for (let gu = 0; gu < 5; gu++) if (g(gu, gv)) {
      world.set(...f.at(u + gu, gy + 4 - gv, 1), inverse ? SIGN_BACK : color, 0, inverse ? KIND_SOLID : KIND_GLOW);
    }
  }
  sign(f.at(u0 + w / 2, y0 + hgt / 2, 2), color, Math.max(w, hgt) * 0.6);
}

/** A billboard: an abstract picture in bands of colour (a sun over waves, a ring, stripes). */
const RAMPS = [[0x401060, 0xa02080, 0xf04070, 0xf8a040], [0x082848, 0x106080, 0x18b0c0, 0x80f0e0], [0x301050, 0x7030c0, 0xc040e0, 0xf0a0f0]];
function billboard(f, u0, y0, w, hgt, kind, d = 1) {
  const ramp = RAMPS[kind % RAMPS.length];
  for (let y = y0; y < y0 + hgt; y++) for (let u = u0; u < u0 + w; u++) {
    const frame = y === y0 || y === y0 + hgt - 1 || u === u0 || u === u0 + w - 1;
    const tu = (u - u0) / (w - 1), tv = (y - y0) / (hgt - 1);
    let c;
    if (kind % 3 === 0) {
      const rr = Math.hypot((tu - 0.5) * w / hgt, tv - 0.6);
      c = rr < 0.3 && tv > 0.36 ? (Math.floor(tv * 14) % 2 && tv < 0.58 ? ramp[1] : ramp[3]) : tv < 0.32 ? (Math.floor(tv * 10 + Math.sin(tu * 9) * 0.6) % 2 ? ramp[0] : ramp[1]) : ramp[Math.min(2, Math.floor((1 - tv) * 3))];
    } else if (kind % 3 === 1) {
      const rr = Math.hypot((tu - 0.5) * w / hgt, tv - 0.5);
      c = Math.abs(rr - 0.32) < 0.07 ? ramp[3] : rr < 0.1 ? ramp[2] : ramp[Math.floor(tv * 2)];
    } else c = ramp[Math.floor(((tu * w + tv * hgt) / 5) % 4)];
    world.set(...f.at(u, y, d), frame ? FRAME : c, 0, frame ? KIND_SOLID : KIND_GLOW);
  }
  sign(f.at(u0 + w / 2, y0 + hgt / 2, d + 2), ramp[2], Math.max(w, hgt) * 0.65, 0.5);
}

/** An air conditioner hanging on a face. */
function airCon(f, u, y) {
  for (let a = 0; a < 3; a++) for (let b = 0; b < 2; b++) for (let d = 1; d <= 2; d++) world.set(...f.at(u + a, y + b, d), d === 2 && b === 1 ? 0x8a8e96 : 0x6e727a);
}

/**
 * One building: a stack of tiers, each set back from the one below. Windows floor by floor,
 * shops where a face meets the street, signs, neon along the tops of the tiers.
 */
function building(b) {
  const r = mulberry32(b.seed);
  const body = b.body, trim = shadeHex(body, 0.72), band = shadeHex(body, 0.86);
  let y0 = 1, box = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 };
  const edge = b.edge ?? pick([NEON.cyan, NEON.pink, NEON.violet], r);
  b.tiers.forEach((h, ti) => {
    const y1 = y0 + h - 1;
    for (let y = y0; y <= y1; y++) for (let z = box.z0; z <= box.z1; z++) for (let x = box.x0; x <= box.x1; x++) {
      if (y === y1 || x === box.x0 || x === box.x1 || z === box.z0 || z === box.z1) world.set(x, y, z, body);
    }
    for (const f of faces(box)) {
      const street = ti === 0 && onStreet(f);
      const from = ti === 0 ? SHOP : y0 + 1;
      // windows: pairs of panes, some lit; a darker band at each floor
      for (let fy = from; fy + FLOOR <= y1 - 1; fy += FLOOR) {
        for (let u = 0; u < f.w; u++) world.set(...f.at(u, fy, 0), band);
        for (let u = 2; u + 2 < f.w - 1; u += b.pitch ?? 5) {
          const on = r() < b.lit;
          const c = on ? pick(LIT, r) : GLASS;
          for (let k = 0; k < 2; k++) for (let dy = 2; dy <= 4; dy++) world.set(...f.at(u + k, fy + dy, 0), c, 0, on ? KIND_GLOW : KIND_SOLID);
          if (!on && r() < 0.05) airCon(f, u, fy + 1);
        }
      }
      // the street floor: lit shop windows, doors, an awning with a glowing edge
      if (ti === 0) for (let u = 0; u < f.w; u++) for (let y = 1; y < SHOP; y++) {
        const shop = street && u >= 2 && u < f.w - 2 && y >= 2 && y <= 6;
        if (!shop) { world.set(...f.at(u, y, 0), y === 1 ? trim : body); continue; }
        const seg = Math.floor((u - 2) / 9), inSeg = (u - 2) % 9;
        const door = inSeg >= 3 && inSeg <= 4;
        world.set(...f.at(u, y, 0), door ? 0x241c18 : y === 6 ? pick(NEON_LIST, mulberry32(b.seed + seg)) : [0xe8b070, 0xd8e0e8, 0xe89070, 0x90d8e8][(seg + b.seed) % 4], 0, door ? KIND_SOLID : KIND_GLOW);
      }
      if (street) {
        const c = pick(NEON_LIST, r);
        for (let u = 2; u < f.w - 2; u++) for (let d = 1; d <= 3; d++) world.set(...f.at(u, SHOP - 1, d), d === 3 ? c : 0x2c2a30, 0, d === 3 ? KIND_GLOW : KIND_SOLID);
      }
      // neon along the top of the tier, and up the corners of the towers
      for (let u = 0; u < f.w; u++) world.set(...f.at(u, y1, 0), edge, 0, KIND_GLOW);
      if (b.corners) for (let y = y0; y < y1; y++) world.set(...f.at(0, y, 0), edge, 0, KIND_GLOW);
      // signs
      const big = f.w >= 30 && h >= 30;
      const choice = r();
      if (street || choice < 0.45) {
        for (let u = 4; u < f.w - 6; u += 10 + Math.floor(r() * 8)) {
          if (r() < 0.7) bladeSign(f, u, Math.max(from, SHOP) + 2 + Math.floor(r() * 6), Math.min(y1 - Math.max(from, SHOP) - 6, 18 + Math.floor(r() * 3) * 6), pick(NEON_LIST, r), r);
        }
      } else if (big && choice < 0.8) {
        const w = Math.min(f.w - 8, 22 + Math.floor(r() * 10)), hh = Math.min(h - 12, Math.round(w * 0.6));
        if (hh >= 10) billboard(f, Math.floor((f.w - w) / 2), y0 + Math.floor((h - hh) / 2), w, hh, Math.floor(r() * 3));
      } else if (f.w >= 18 && h >= 16) {
        const w = Math.min(f.w - 4, 14 + Math.floor(r() * 3) * 6);
        panelSign(f, Math.floor((f.w - w) / 2), y0 + Math.floor(h / 2) - 4, w, 9, pick(NEON_LIST, r), r() < 0.4, r);
      }
    }
    y0 = y1 + 1;
    if (ti + 1 < b.tiers.length) {
      const k = b.inset ?? 6;
      box = { x0: box.x0 + k, x1: box.x1 - k, z0: box.z0 + k, z1: box.z1 - k };
    }
  });
  // roof: units, maybe a tank, maybe a mast with a red light
  const top = y0, { x0, x1, z0, z1 } = box, w = x1 - x0, d = z1 - z0;
  for (let k = 0; k < 2 + Math.floor(r() * 2); k++) {
    const bx = x0 + 2 + Math.floor(r() * Math.max(1, w - 9)), bz = z0 + 2 + Math.floor(r() * Math.max(1, d - 8));
    world.box(bx, top, bz, bx + 3 + Math.floor(r() * 4), top + 1 + Math.floor(r() * 3), bz + 2 + Math.floor(r() * 4), 0x50545c);
  }
  if (w > 14 && d > 14 && r() < 0.5) {
    const cx = x0 + 6 + Math.floor(r() * (w - 12)), cz = z0 + 6 + Math.floor(r() * (d - 12));
    for (let y = top; y < top + 9; y++) for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) {
      if (x * x + z * z <= (y < top + 3 ? 4 : 15)) world.set(cx + x, y, cz + z, y < top + 3 ? 0x3a3030 : y === top + 8 ? 0x4a3a34 : 0x5c4a40);
    }
  }
  if (b.mast) {
    const mx = Math.round((x0 + x1) / 2), mz = Math.round((z0 + z1) / 2);
    for (let y = top; y < top + b.mast; y++) world.set(mx, y, mz, 0x5a5e66);
    for (let y = top; y < top + b.mast * 0.6; y += 4) for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) world.set(mx + ax, y, mz + az, 0x5a5e66);
    world.set(mx, top + b.mast, mz, NEON.red, 0, KIND_GLOW);
    beacons.push([mx + 0.5, top + b.mast + 0.5, mz + 0.5]);
  }
  b.roof = { box, top };
}

// ---------------------------------------------------------------- the block

// low houses round the square (two rows on each side, split by the alley), stepped towers at the
// corners. tiers: heights of the stacked parts, each set back by `inset`.
const BUILDINGS = [];
const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const rows = [
  { near: 23, far: 44, h: [[26], [34], [22], [30]] },
  { near: 48, far: 86, h: [[44], [56], [38], [62]] },
];
const BODIES = [0x7a8090, 0x868c9a, 0x8c7e86, 0x76867e, 0x7e7a92, 0x9094a0, 0x84787c, 0x76808c];
SIDES.forEach(([sx, sz], side) => {
  rows.forEach((row, ri) => {
    for (const half of [-1, 1]) {
      // across: from the alley to x = 30; along: from row.near to row.far, away from the square
      const a0 = 7, a1 = 30, n0 = row.near, n1 = row.far;
      const lo = half < 0 ? [-a1, -a0] : [a0, a1];
      const box = sx ? { x0: sx > 0 ? n0 : -n1, x1: sx > 0 ? n1 : -n0, z0: lo[0], z1: lo[1] } : { x0: lo[0], x1: lo[1], z0: sz > 0 ? n0 : -n1, z1: sz > 0 ? n1 : -n0 };
      const tiers = row.h[(side + (half > 0 ? 1 : 0) * 2) % 4].map((h) => h + Math.floor(rand() * 3) * 4);
      BUILDINGS.push({ ...box, tiers, body: BODIES[BUILDINGS.length % BODIES.length], lit: 0.32, pitch: 6 });
    }
  });
});
const TOWERS = [
  { x0: 34, x1: 84, z0: 34, z1: 84, tiers: [46, 36, 28], edge: NEON.cyan, mast: 14 },
  { x0: -84, x1: -34, z0: 34, z1: 84, tiers: [40, 36], edge: NEON.pink },
  { x0: -84, x1: -34, z0: -84, z1: -34, tiers: [52, 40, 30], edge: NEON.violet, mast: 16 },
  { x0: 34, x1: 84, z0: -84, z1: -34, tiers: [46, 40], edge: NEON.amber },
];
for (const t of TOWERS) BUILDINGS.push({ ...t, body: pick([0x6a7486, 0x727a8c, 0x6e6a7e]), lit: 0.36, pitch: 5, inset: 7, corners: true });
BUILDINGS.forEach((b, i) => { b.seed = 300 + i * 7; building(b); });
stage('buildings');

// ---------------------------------------------------------------- the square

// a sign pillar in the middle, glyphs on all four sides
const PILLAR = { r: 3, h: 40 };
{
  const r = mulberry32(5);
  const colors = [NEON.cyan, NEON.pink, NEON.cyan, NEON.amber];
  const box = { x0: -PILLAR.r, x1: PILLAR.r - 1, z0: -PILLAR.r, z1: PILLAR.r - 1 };
  world.box(box.x0 - 1, 1, box.z0 - 1, box.x1 + 1, 3, box.z1 + 1, 0x3a3c44);
  world.box(box.x0, 4, box.z0, box.x1, PILLAR.h, box.z1, SIGN_BACK);
  faces(box).forEach((f, fi) => {
    for (let y = 6; y + 5 <= PILLAR.h - 2; y += 6) {
      const g = glyph(r);
      for (let gv = 0; gv < 5; gv++) for (let gu = 0; gu < 5; gu++) if (g(gu, gv)) world.set(...f.at(gu, y + 4 - gv, 0), colors[fi], 0, KIND_GLOW);
    }
  });
  world.box(box.x0 - 1, PILLAR.h + 1, box.z0 - 1, box.x1 + 1, PILLAR.h + 1, box.z1 + 1, NEON.cyan, 0, KIND_GLOW);
  world.box(box.x0, PILLAR.h + 2, box.z0, box.x1, PILLAR.h + 3, box.z1, FRAME);
  sign([0, PILLAR.h * 0.6, 0], NEON.cyan, 26, 0.4);
}

/** A cable with lamps on it, sagging between two points (voxels). */
function lampString([ax, ay, az], [bx, by, bz], color, every = 4) {
  const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az), 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n, sag = Math.sin(Math.PI * t) * n * 0.12;
    const x = Math.round(ax + (bx - ax) * t), z = Math.round(az + (bz - az) * t), y = Math.round(ay + (by - ay) * t - sag);
    world.set(x, y, z, 0x16161a);
    if (i % every === every >> 1) { world.set(x, y - 1, z, color, 0, KIND_GLOW); if (i % (every * 2) === every >> 1) sign([x + 0.5, y - 0.5, z + 0.5], color, 3.2, 0.8); }
  }
}
// from the pillar's top to the roofs of the houses round the square
const LAMP_COLORS = [0xff6a8a, 0xffb050, 0x60e0ff, 0xffb050];
BUILDINGS.slice(0, 16).filter((_, i) => i % 4 < 2).forEach((b, i) => {
  const roof = b.roof;
  const tx = Math.max(roof.box.x0 + 1, Math.min(roof.box.x1 - 1, 0)), tz = Math.max(roof.box.z0 + 1, Math.min(roof.box.z1 - 1, 0));
  const cx = Math.abs(tx) > Math.abs(tz) ? (tx > 0 ? roof.box.x0 : roof.box.x1) : Math.round((roof.box.x0 + roof.box.x1) / 2);
  const cz = Math.abs(tz) >= Math.abs(tx) ? (tz > 0 ? roof.box.z0 : roof.box.z1) : Math.round((roof.box.z0 + roof.box.z1) / 2);
  lampString([0, PILLAR.h + 1, 0], [cx, roof.top - 1, cz], LAMP_COLORS[i % 4], 5);
});
// across the alleys, between the houses
for (const a of [-70, -52, 36, 58, 76]) {
  lampString([a, 30, -ALLEY - 1], [a + 3, 30, ALLEY + 1], pick(LAMP_COLORS));
  lampString([-ALLEY - 1, 28, a], [ALLEY + 1, 28, a + 3], pick(LAMP_COLORS));
}
stage('lamps');

// food stalls in two corners of the square, vending machines along the walls
function stall(x0, z0, roofA, roofB) {
  world.box(x0, 1, z0, x0 + 9, 4, z0 + 6, 0x3a2a24);
  world.box(x0, 5, z0, x0 + 9, 5, z0 + 6, 0xe8a050, 0, KIND_GLOW);
  for (const [x, z] of [[x0, z0], [x0 + 9, z0], [x0, z0 + 6], [x0 + 9, z0 + 6]]) for (let y = 6; y <= 10; y++) world.set(x, y, z, 0x2a2228);
  world.box(x0 - 1, 11, z0 - 1, x0 + 10, 11, z0 + 7, (x, y, z) => ((x + z) % 2 ? roofA : roofB));
  for (let x = x0 - 1; x <= x0 + 10; x += 3) { world.set(x, 10, z0 - 1, 0xff9050, 0, KIND_GLOW); world.set(x, 10, z0 + 7, 0xff9050, 0, KIND_GLOW); }
  sign([x0 + 5, 8, z0 + 3], 0xffa050, 10, 0.7);
}
stall(-19, -19, 0xc02040, 0xd83a50);
stall(10, 12, 0x2060a0, 0x3080c0);
const machines = [[-7 + 1, 30, 1, 0], [6, -40, -1, 0], [-40, 7 - 1, 0, -1], [52, -6, 0, 1], [-22, 22, 0, -1], [14, -22, 0, 1]];
for (const [x, z, nx, nz] of machines) {
  for (let a = 0; a < 4; a++) for (let y = 1; y <= 7; y++) for (let d = 0; d < 3; d++) {
    const xx = x + nx * d + (nx ? 0 : a), zz = z + nz * d + (nz ? 0 : a);
    const screen = d === 2 && y >= 3 && y <= 6;
    world.set(xx, y, zz, screen ? 0xa0e8ff : 0x3a6a8a, 0, screen ? KIND_GLOW : KIND_SOLID);
  }
}
stage('street');

// ---------------------------------------------------------------- scene

const s = new SceneWriter({ title: 'Neon Alley' });
const m = s.manifest;
s.object({ mesh: s.addGrid('city', world, { scale: SCALE }), cast: true, receive: true });
const rock = rockBase({ inside, half: HALF, cell: 6, depth: 13, seed: 41, soil: 0x2a2c31, stone: [0x3a3c44, 0x34363e, 0x2e3038, 0x40424a] });
s.object({ mesh: s.addGrid('rock', rock, { scale: SCALE * 6, offset: [0, -SLAB * SCALE, 0], sides: rockSides }), cast: false, receive: false });

// puddles on the square and in the alleys
const puddle = (x, z) => isStreet(x, z) && world.heightAt(x, z) === 1 && noise2(x / 8 + 3, z / 8 - 7, 21) > 0.6;
const strips = [];
for (let z = -HALF; z < HALF; z++) for (let x = -HALF; x < HALF; x++) {
  if (!inside(x, z) || !puddle(x, z)) continue;
  const x0 = x;
  while (x + 1 < HALF && puddle(x + 1, z)) x++;
  strips.push([x0 * SCALE, z * SCALE, (x + 1) * SCALE, (z + 1) * SCALE]);
}
m.water = { mesh: s.addSurface('puddles', SCALE + 0.03, strips), deep: lin(0x101820), shallow: lin(0x243040), glow: lin(0xc0308a) };

// passenger drones circle the towers: four rotors in glowing rings, a lit cabin
function drone() {
  const g = new Grid(21, 6, 21, 10, 0, 10);
  g.box(-3, 1, -4, 3, 3, 4, 0x2a2e38);
  g.box(-2, 4, -3, 2, 4, 3, 0x343842);
  for (const z of [-4, 4]) for (let x = -2; x <= 2; x++) g.set(x, 3, z, 0xbfefff, 0, KIND_GLOW);
  for (const x of [-3, 3]) for (let z = -3; z <= 3; z++) g.set(x, 3, z, 0xbfefff, 0, KIND_GLOW);
  for (const [cx, cz] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) {
    for (let k = 1; k < 7; k++) { const t = k / 7; g.set(Math.round(cx * t), 2, Math.round(cz * t), 0x22252c); }
    for (let z = -3; z <= 3; z++) for (let x = -3; x <= 3; x++) {
      const rr = Math.hypot(x, z);
      if (rr > 2.2 && rr < 3.6) g.set(cx + x, 2, cz + z, NEON.cyan, 0, KIND_GLOW);
    }
  }
  g.box(-2, 0, -2, 2, 0, 2, 0xff4a6a, 0, KIND_GLOW);
  return g;
}
const droneMesh = s.addGrid('drone', drone(), { scale: SCALE });
for (const d of [{ angle: 0.6, radius: 5, y: 17, speed: 0.08 }, { angle: 3.4, radius: 38, y: 26, speed: -0.03 }]) {
  const o = s.object({ mesh: droneMesh, cast: false, receive: false, emissive: lin(0x0a0c10), orbit: { ...d, wobble: 1.2 }, bob: { amp: 0, speed: 0, phase: d.angle, rotAmp: 0.25, rotSpeed: 0.3 } });
  s.glow([0, 0, 0], 5, NEON.cyan, 0.6, { object: o, local: [0, 0.8, 0] });
  s.glow([0, 0, 0], 2.4, 0xff4a6a, 0.8, { object: o, local: [0, -0.1, 0] });
}

// halos for signs, lamps and beacons
for (const g of halos) s.glow(U(...g.p), g.size * SCALE, g.color, g.strength);
for (const p of beacons) s.glow(U(...p), 2.2, NEON.red, 1);
// street light: pink and cyan down the alleys, warm at the stalls
s.light(U(-44, 12, 0), 0xff3aa0, 30, 24, 1.6);
s.light(U(44, 12, 0), 0x30d0ff, 30, 24, 1.6);
s.light(U(-14, 14, -15), 0xffa050, 24, 20, 1.6);
s.light(U(14, 14, 15), 0x60a0ff, 24, 20, 1.6);

// small drones: lights that hover and blink between the towers (night only)
m.fireflies = { color: lin(0xd8f4ff), items: [] };
for (let i = 0; i < 24; i++) {
  const a = rand() * Math.PI * 2, rr = 20 + rand() * 70;
  m.fireflies.items.push(v3([Math.cos(a) * rr * SCALE, (40 + rand() * 90) * SCALE, Math.sin(a) * rr * SCALE, rand() * 100, 0.35 + rand() * 0.25]));
}

/**
 * Far off, more of the city floats past: two small blocks of towers on rock, at a coarser scale,
 * shown several times round the scene. They circle slowly, well outside the camera's path.
 */
function islands() {
  const S = 0.8, H = 22;
  const meshes = [0, 1].map((v) => {
    const r = mulberry32(900 + v);
    const g = new Grid(H * 2 + 4, 64, H * 2 + 4, H + 2, 3, H + 2);
    const ins = roundedSquare(H, 7, 30 + v, 1.5);
    for (let z = -H; z < H; z++) for (let x = -H; x < H; x++) if (ins(x, z)) for (let y = -2; y <= 0; y++) g.set(x, y, z, y === 0 ? 0x3a3d44 : 0x2a2c31);
    for (let k = 0; k < 6; k++) {
      const w = 6 + Math.floor(r() * 7), d = 6 + Math.floor(r() * 7), h = 10 + Math.floor(r() * (k < 2 ? 40 : 22));
      const x0 = -H + 4 + Math.floor(r() * (2 * H - w - 8)), z0 = -H + 4 + Math.floor(r() * (2 * H - d - 8));
      const box = { x0, x1: x0 + w - 1, z0, z1: z0 + d - 1 };
      const body = pick([0x5a6272, 0x646a7a, 0x5e5a6e], r), edge = pick([NEON.cyan, NEON.pink, NEON.violet, NEON.amber], r);
      g.box(box.x0, 1, box.z0, box.x1, h, box.z1, body);
      for (const f of faces(box)) {
        for (let u = 1; u < f.w - 1; u += 2) for (let y = 3; y < h - 2; y += 3) if (r() < 0.22) g.set(...f.at(u, y, 0), pick(LIT, r), 0, KIND_GLOW);
        for (let u = 0; u < f.w; u++) g.set(...f.at(u, h, 0), edge, 0, KIND_GLOW);
        if (h > 30) for (let y = 1; y < h; y++) g.set(...f.at(0, y, 0), edge, 0, KIND_GLOW);
      }
    }
    const base = rockBase({ inside: ins, half: H, cell: 3, depth: 9, seed: 70 + v, soil: 0x2a2c31, stone: [0x3a3c44, 0x34363e, 0x2e3038, 0x40424a] });
    return s.addMesh(`island${v}`, meshGrid(g, { scale: S }), meshGrid(base, { scale: S * 3, offset: [0, -3 * S, 0], sides: rockSides }));
  });
  for (let i = 0; i < 5; i++) {
    const sc = 0.8 + rand() * 0.45;
    s.object({
      mesh: meshes[i % 2], cast: false, receive: false, scale: v3([sc, sc, sc]), rotY: Math.round(rand() * 6.28 * 1e4) / 1e4,
      orbit: { angle: (i / 5) * Math.PI * 2 + rand() * 0.5, radius: 200 + rand() * 70, y: -24 + rand() * 40, speed: 0.004 + rand() * 0.002, wobble: 2 },
    });
  }
}
islands();

// overcast by day, violet haze at night
const NIGHT = { zen: 0x060816, hor: 0x2a1840, gnd: 0x140e22, key: 0.7, keyC: 0x8a9ad8, hemiS: 0x4a5a8a, hemiG: 0x2a1c34, hemiI: 1.3, glow: 1, stars: 0.25, exp: 1.2 };
const DUSK = { zen: 0x1c2240, hor: 0x7a4a6a, gnd: 0x3a2a44, key: 1.4, keyC: 0xd08a90, hemiS: 0x8a8ab0, hemiG: 0x3a2e38, hemiI: 1.6, glow: 0.8, stars: 0.05, exp: 1.08 };
const DAY = { zen: 0x5c6a76, hor: 0xaab4b8, gnd: 0x8c969a, key: 2.0, keyC: 0xe4eaee, hemiS: 0xc4ced4, hemiG: 0x6a6e74, hemiI: 2.4, glow: 0.38, stars: 0, exp: 1.0 };
m.sky.keys = skyKeys([[0, NIGHT], [5.0, NIGHT], [6.4, DUSK], [8.0, DAY], [16.6, DAY], [18.4, DUSK], [19.8, NIGHT]]);
m.fog = { near: 140, far: 520 };
m.camera = { target: [0, 10, 0], fov: 30, near: 1, far: 2000, angle: 0.7, elev: 0.44, fit: [35, 46], orbitSpeed: 0.028 };
m.shadow = { size: 2048, extent: 46, near: 10, far: 400, target: [0, 10, 0], distance: 190, bias: -0.0004, normalBias: 0.05 };

m.credits = [
  { title: 'Neon Alley (scene, all geometry)', author: 'Kumo', source: 'https://github.com/Hamido212/kumo/tree/main/scenes/alley', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' },
];

mkdirSync(dirname(out), { recursive: true });
s.write(out);
