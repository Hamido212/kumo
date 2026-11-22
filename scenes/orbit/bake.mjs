// Bakes "Orbit": an outpost on a small asteroid, high above a blue planet. A ring habitat, solar
// wings and a dish sit on the rock; satellites and stray stones circle it. By day the planet
// below shows oceans, land and clouds; at night it turns dark, its cities light up and the
// station's windows glow.
//
//   node scenes/orbit/bake.mjs [out.kumo]              default: scenes/out/orbit.kumo
//
// Everything is generated here; no third-party models. The planet is not a voxel model but a
// smooth cap of a sphere far below the station (lib/shapes.mjs), with the haze of its air
// painted into its colours towards the horizon.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grid, KIND_GLOW, meshGrid, mulberry32, mixHex, shadeHex } from '../lib/grid.mjs';
import { SceneWriter, lin, skyKeys, v3 } from '../lib/kumo.mjs';
import { noise2 } from '../lib/parts.mjs';
import { Shapes, sphereCap } from '../lib/shapes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(here, '..', 'out', 'orbit.kumo');
const rand = mulberry32(1969);
const pick = (list, r = rand) => list[Math.floor(r() * list.length)];

const s = new SceneWriter({ title: 'Orbit' });
const m = s.manifest;

// ---------------------------------------------------------------- the planet

const R = 4000, TOP = -150;                // radius, and the height of its top under the station
const CENTER = [0, TOP - R, 0];
const fbm = (x, z, seed, oct = 5) => { let v = 0, a = 1, f = 1, sum = 0; for (let o = 0; o < oct; o++) { v += noise2(x * f, z * f, seed + o) * a; sum += a; a *= 0.5; f *= 2.03; } return v / sum; };
const OCEAN = 0x0b2a5c, SHALLOW = 0x1c5a8c, GREEN = 0x3a6a30, DRY = 0x8a7a4a, SAND = 0xc0a878, CLOUD = 0xf2f6fa, HAZE = 0x8ab8ec;
/** The ground at a point of the surface, by its position (u, w) along it. */
function surface(u, w) {
  const c = fbm(u / 1000 + 3, w / 1000 - 7, 11);
  const land = c > 0.53;
  let col;
  if (!land) col = mixHex(OCEAN, SHALLOW, Math.max(0, Math.min(1, (c - 0.44) / 0.09)));
  else {
    const dry = fbm(u / 600, w / 600, 31);
    col = c < 0.545 ? SAND : dry > 0.55 ? mixHex(DRY, SAND, (dry - 0.55) * 3) : mixHex(GREEN, DRY, Math.max(0, (dry - 0.4) * 3));
  }
  const warp = fbm(u / 300, w / 300, 51) * 2.2;
  const cl = fbm(u / 120 + warp, w / 120 - warp, 61);
  const cloud = Math.max(0, Math.min(1, (cl - 0.57) / 0.09));
  return { land, cloud, col: mixHex(col, CLOUD, cloud * 0.92) };
}
const hazeAt = (u, w) => Math.max(0, Math.min(1, (Math.hypot(u, w) - 420) / 820)) ** 1.2 * 0.9;
{
  const g = new Shapes();
  sphereCap(g, {
    center: CENTER, r: R, angle: 0.36, rings: 150, segments: 220, power: 1.35,
    color: (x, y, z) => mixHex(surface(x, z).col, HAZE, hazeAt(x, z)),
  });
  s.object({ mesh: s.addMesh('planet', g.build()), cast: false, receive: false });
}
// city lights: small squares on land, under a clear sky, that glow at night
{
  const g = new Shapes();
  const r = mulberry32(7);
  let cities = 0;
  for (let tries = 0; cities < 70 && tries < 4000; tries++) {
    const a = r() * Math.PI * 2, d = 120 + Math.sqrt(r()) * 1150;
    const cu = Math.cos(a) * d, cw = Math.sin(a) * d;
    const here0 = surface(cu, cw);
    if (!here0.land || here0.cloud > 0.3) continue;
    cities++;
    const n = 8 + Math.floor(r() * 26), spread = 12 + r() * 26;
    for (let i = 0; i < n; i++) {
      const u = cu + (r() + r() + r() - 1.5) * spread, w = cw + (r() + r() + r() - 1.5) * spread;
      const here = surface(u, w);
      if (!here.land || here.cloud > 0.4) continue;
      const q = (0.8 + r() * 0.8) * (1 + Math.hypot(u, w) / 500);
      const lift = (x, z) => { const dx = x - CENTER[0], dz = z - CENTER[2]; return CENTER[1] + Math.sqrt(R * R - dx * dx - dz * dz) + 1.5; };
      const p = (x, z) => [x, lift(x, z), z];
      g.poly([p(u - q, w - q), p(u - q, w + q), p(u + q, w + q), p(u + q, w - q)], pick([0xa07040, 0xb08048, 0x907858], r), { glow: true, normal: [u / R, 1, w / R] });
    }
  }
  s.object({ mesh: s.addMesh('cities', g.build()), cast: false, receive: false });
}

// ---------------------------------------------------------------- the asteroid and the station

const SCALE = 0.25;
const world = new Grid(150, 110, 150, 75, 46, 75);
const n3 = (x, y, z, sd) => (noise2(x, y, sd) + noise2(y + 7.1, z, sd + 1) + noise2(z - 3.3, x, sd + 2)) / 3;
const ROCK = [0x6e6862, 0x5e5954, 0x7a736b, 0x55504c];
// the rock: a lumpy, flattened blob with its top cut level for the base. It is built from voxels
// twice the station's size (its lumpy surface would otherwise cost most of the scene's
// vertices); coarse cell (cx, cy, cz) covers the station's voxels 2cx..2cx+1, 2cy+1..2cy+2.
const blob = (x, y, z) => y <= 0 && Math.hypot(x / 56, (y + 6) / 40, z / 52) + (n3(x / 14, y / 14, z / 14, 5) - 0.5) * 0.55 <= 1;
const rockCell = (cx, cy, cz) => blob(2 * cx + 1, 2 * cy + 2, 2 * cz + 1);
const inRock = (x, y, z) => rockCell(Math.floor(x / 2), Math.floor((y - 1) / 2), Math.floor(z / 2));
const rockGrid = new Grid(66, 25, 66, 33, 24, 33);
for (let cy = -23; cy <= -1; cy++) for (let cz = -32; cz <= 31; cz++) for (let cx = -32; cx <= 31; cx++) {
  if (!rockCell(cx, cy, cz)) continue;
  const crater = noise2(cx / 4.5 + 40, cz / 4.5 - 13, 9) > 0.72 && cy === -1;
  rockGrid.set(cx, cy, cz, crater ? 0x46423e : ROCK[Math.floor(n3(cx / 5.5, cy / 5.5, cz / 5.5, 17) * 4) % 4]);
}
// glowing crystals in clefts of the rock
const crystals = [];
for (let k = 0; k < 9; k++) {
  const a = rand() * Math.PI * 2, y0 = -8 - Math.floor(rand() * 26);
  let x = Math.round(Math.cos(a) * 70), z = Math.round(Math.sin(a) * 70);
  while ((x || z) && !inRock(x, y0, z)) { x -= Math.sign(x); z -= Math.sign(z); }
  const c = pick([0x30e0c8, 0x40c0ff, 0x9a70ff]);
  for (let i = 0; i < 4 + Math.floor(rand() * 3); i++) world.set(x + Math.sign(x) * i, y0 + Math.floor(i / 2), z + Math.sign(z) * Math.floor(i * 0.6), c, 0, KIND_GLOW);
  crystals.push({ p: [x + Math.sign(x) * 2, y0 + 1, z + Math.sign(z)], c });
}

const HULL = 0xd8dce2, HULL_2 = 0xb8bec8, DARK = 0x3a3e48, PANEL = 0x1e3a6a, PANEL_LINE = 0x5a7ab0, WIN = 0xffd890, GOLD = 0xc8a050;
const halos = [];
// the hub: a tall drum with rows of windows
const cyl = (cx, cz, y0, y1, r, color) => {
  for (let y = y0; y <= y1; y++) for (let z = -r; z <= r; z++) for (let x = -r; x <= r; x++) {
    if (x * x + z * z <= r * r + r) world.set(cx + x, y, cz + z, typeof color === 'function' ? color(x, y, z) : color);
  }
};
cyl(0, 0, 1, 30, 9, (x, y, z) => (y % 6 === 3 && Math.abs(Math.atan2(z, x) * 8 / Math.PI % 1) < 0.5 && x * x + z * z > 60 ? WIN : y % 6 === 0 ? HULL_2 : HULL));
for (let y = 1; y <= 30; y++) for (let z = -9; z <= 9; z++) for (let x = -9; x <= 9; x++) if (world.colorAt(x, y, z) === WIN) world.set(x, y, z, WIN, 0, KIND_GLOW);
cyl(0, 0, 31, 33, 6, DARK);
cyl(0, 0, 34, 35, 4, HULL_2);
// the ring: a torus round the hub on four spokes
const RING = { r: 36, t: 4.2, y: 20 };
for (let y = RING.y - 6; y <= RING.y + 6; y++) for (let z = -42; z <= 42; z++) for (let x = -42; x <= 42; x++) {
  const q = Math.hypot(x, z) - RING.r, d = Math.hypot(q, y - RING.y);
  if (d <= RING.t) {
    const window = Math.abs(y - RING.y) <= 1 && q > 2.4 && (Math.floor(Math.atan2(z, x) * 40 / Math.PI) % 3 !== 0);
    world.set(x, y, z, window ? WIN : d > RING.t - 1.2 && Math.abs(y - RING.y) > 2 ? HULL_2 : HULL, 0, window ? KIND_GLOW : 1);
  }
}
for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (let k = 9; k <= RING.r - 3; k++) for (const o of [-1, 0, 1]) world.set(dx * k + (dz ? o : 0), RING.y, dz * k + (dx ? o : 0), HULL_2);
// solar wings on a truss above the ring, east and west: upright panels above and below it
const TRUSS = 38;
for (const side of [-1, 1]) {
  for (let k = 1; k <= 66; k++) for (const [oy, oz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) world.set(side * k, TRUSS + oy, -1 + oz, (k + oy) % 4 === 0 ? GOLD : DARK);
  for (const k of [26, 42, 58]) for (const up of [-1, 1]) {
    for (let a = -6; a <= 6; a++) for (let b = 3; b <= 13; b++) {
      const line = Math.abs(a) === 6 || b === 13 || b % 5 === 3 || a === 0;
      world.set(side * k + a, TRUSS + up * b + (up > 0 ? 1 : 0), 0, line ? PANEL_LINE : PANEL);
    }
  }
  halos.push({ p: [side * 67, TRUSS + 1, 0.5], c: side < 0 ? 0xff3030 : 0x30ff60, size: 3.2 });
}
// a dish on a mast, a landing pad with lights, a greenhouse dome
for (let y = 36; y <= 46; y++) world.set(0, y, 0, DARK);
for (let z = -7; z <= 7; z++) for (let x = -7; x <= 7; x++) {
  const r2 = x * x + z * z;
  if (r2 <= 49) world.set(x + 2, 46 + Math.round(r2 / 14), z, r2 < 4 ? DARK : HULL);
}
world.set(2, 51, 0, 0xff4040, 0, KIND_GLOW); halos.push({ p: [2.5, 51.5, 0.5], c: 0xff4040, size: 3 });
const PAD = { x: 26, z: 26 };
world.box(PAD.x - 9, 0, PAD.z - 9, PAD.x + 9, 1, PAD.z + 9, 0x50545c);
for (let a = -9; a <= 9; a += 3) for (const [x, z] of [[a, -9], [a, 9], [-9, a], [9, a]]) {
  world.set(PAD.x + x, 2, PAD.z + z, 0x60e0ff, 0, KIND_GLOW);
}
for (let k = -5; k <= 5; k++) { world.set(PAD.x + k, 2, PAD.z, 0xe8e8e8); world.set(PAD.x, 2, PAD.z + k, 0xe8e8e8); }
halos.push({ p: [PAD.x + 0.5, 3, PAD.z + 0.5], c: 0x60e0ff, size: 9, strength: 0.4 });
const DOME = { x: -24, z: 22, r: 11 };
for (let y = 0; y <= DOME.r; y++) for (let z = -DOME.r; z <= DOME.r; z++) for (let x = -DOME.r; x <= DOME.r; x++) {
  const d = Math.hypot(x, y, z);
  if (d > DOME.r) continue;
  const shell = d > DOME.r - 1.2;
  const frame = shell && (Math.abs(x) % 5 === 0 || y % 4 === 0);
  if (shell) world.set(DOME.x + x, 1 + y, DOME.z + z, frame ? HULL_2 : 0x7ad8c0, 0, frame ? 1 : KIND_GLOW);
  else if (y <= 2) world.set(DOME.x + x, 1 + y, DOME.z + z, y < 2 ? 0x3a2a20 : (x + z) % 3 ? 0x3a8a3a : 0x5aa040);
}
halos.push({ p: [DOME.x, 6, DOME.z], c: 0x60e0b0, size: 16, strength: 0.35 });
// a docked shuttle by the pad
for (let z = -6; z <= 6; z++) for (let x = -3; x <= 3; x++) for (let y = 0; y <= 3; y++) {
  const taper = Math.max(0, z - 2) * 0.6;
  if (Math.abs(x) + taper > 3.2 || y + taper * 0.5 > 3.5) continue;
  world.set(PAD.x + x, 3 + y, PAD.z + z, y === 3 && z > -2 && z < 3 ? 0x2a3a5a : z === -6 ? DARK : HULL);
}
for (const x of [-2, 2]) world.set(PAD.x + x, 4, PAD.z - 7, 0x60c0ff, 0, KIND_GLOW);

s.object({ mesh: s.addGrid('station', world, { scale: SCALE }), cast: true, receive: true });
s.object({ mesh: s.addGrid('rock', rockGrid, { scale: SCALE * 2, offset: [0, SCALE, 0] }), cast: true, receive: true });

// ---------------------------------------------------------------- things that circle the station

function satellite(seed) {
  const r = mulberry32(seed), g = new Grid(30, 10, 12, 15, 0, 6);
  g.box(-2, 2, -2, 2, 6, 2, r() < 0.5 ? GOLD : HULL);
  for (const side of [-1, 1]) for (let a = 3; a <= 13; a++) for (let b = -3; b <= 3; b++) g.set(side * a, 4, b, a % 3 === 0 ? PANEL_LINE : PANEL);
  g.set(0, 7, 0, DARK); g.set(0, 8, 0, 0xff5050, 0, KIND_GLOW);
  return g;
}
for (let i = 0; i < 2; i++) {
  const mesh = s.addGrid(`satellite${i}`, satellite(80 + i), { scale: SCALE * 0.6 });
  const o = s.object({ mesh, cast: false, receive: false, rotY: i * 1.1, orbit: { angle: i * 3, radius: 34 + i * 12, y: 6 + i * 9, speed: (i ? -1 : 1) * (0.05 - i * 0.012), wobble: 1.5 }, bob: { amp: 0, speed: 0, phase: i, rotAmp: 0.6, rotSpeed: 0.04 } });
  s.glow([0, 0, 0], 1.6, 0xff5050, 0.9, { object: o, local: [0, 2.1, 0] });
}
// stray stones
const stone = (seed) => {
  const g = new Grid(14, 12, 14, 7, 6, 7);
  for (let y = -6; y < 6; y++) for (let z = -7; z < 7; z++) for (let x = -7; x < 7; x++) {
    if (Math.hypot(x, y * 1.2, z) + (n3(x / 4, y / 4, z / 4, seed) - 0.5) * 5 < 5.5) g.set(x, y, z, ROCK[(x + y + z + 99) % 4]);
  }
  return s.addGrid(`stone${seed}`, g, { scale: SCALE });
};
const stones = [stone(1), stone(2)];
for (let i = 0; i < 7; i++) {
  const sc = 0.4 + rand() * 0.8;
  s.object({ mesh: stones[i % 2], cast: false, receive: false, scale: v3([sc, sc, sc]), rotY: rand() * 6,
    orbit: { angle: rand() * 6.28, radius: 24 + rand() * 20, y: -12 + rand() * 14, speed: 0.012 + rand() * 0.02, wobble: 1 },
    bob: { amp: 0, speed: 0, phase: rand() * 6, rotAmp: 1.2, rotSpeed: 0.05 + rand() * 0.05 } });
}

// ---------------------------------------------------------------- light

const U = (x, y, z) => [x * SCALE, y * SCALE, z * SCALE];
for (const h of halos) s.glow(U(...h.p), h.size * SCALE * 3, h.c, h.strength ?? 0.9);
for (const c of crystals) s.glow(U(...c.p), 3.2, c.c, 0.7);
// the air at the edge of the planet: soft halos round the horizon, half hidden by its curve
for (let i = 0; i < 180; i++) {
  const a = (i / 180) * Math.PI * 2;
  s.glow([Math.cos(a) * 1250, -352, Math.sin(a) * 1250], 230, 0x4a90ff, 0.32);
}
s.light(U(PAD.x, 8, PAD.z), 0x80e0ff, 18, 14, 1.6);
s.light(U(DOME.x, 8, DOME.z), 0x80ffc0, 14, 12, 1.6);
s.light(U(0, 22, 44), 0xffd090, 16, 14, 1.6);
s.light(U(0, 22, -44), 0xffd090, 16, 14, 1.6);
// far satellites that catch the light and blink (night only)
m.fireflies = { color: lin(0xfff4d8), items: [] };
for (let i = 0; i < 16; i++) {
  const a = rand() * Math.PI * 2, rr = 260 + rand() * 200;
  m.fireflies.items.push(v3([Math.cos(a) * rr, 40 + rand() * 160, Math.sin(a) * rr, rand() * 100, 1.4 + rand() * 1.2]));
}

// ---------------------------------------------------------------- sky, camera

// space: black sky and stars at every hour. Day: hard sunlight and blue light from the planet
// below; night: the station in the planet's shadow, lit by the moon and its own lamps.
const DAY = { zen: 0x000005, hor: 0x02040c, gnd: 0x02040c, key: 3.2, keyC: 0xfff6ea, hemiS: 0x1a2236, hemiG: 0x3a6aa8, hemiI: 1.0, glow: 0.35, stars: 0.75, exp: 1.0 };
const NIGHT = { zen: 0x000005, hor: 0x02040c, gnd: 0x02040c, key: 0.9, keyC: 0x9ab0ff, hemiS: 0x101624, hemiG: 0x14203a, hemiI: 0.9, glow: 1, stars: 1, exp: 1.2 };
const EDGE = { ...DAY, key: 2.4, keyC: 0xffe8d8, glow: 0.7, stars: 0.9, hemiG: 0x2a4070 };
m.sky.keys = skyKeys([[0, NIGHT], [4.8, NIGHT], [6.4, EDGE], [8.0, DAY], [16.8, DAY], [18.6, EDGE], [20.2, NIGHT]]);
m.sky.sun = { rise: 6, set: 19, tilt: 0.75, yaw: 0.6 };
m.sky.moon = { tilt: 0.7, yaw: -0.4 };
m.fog = { near: 3000, far: 6000 };
m.camera = { target: [0, 3.5, 0], fov: 30, near: 2, far: 2600, angle: 0.5, elev: 0.2, fit: [23, 31], orbitSpeed: 0.024 };
m.shadow = { size: 2048, extent: 26, near: 10, far: 300, target: [0, 2, 0], distance: 150, bias: -0.0004, normalBias: 0.05 };

m.credits = [
  { title: 'Orbit (scene, all geometry)', author: 'Kumo', source: 'https://github.com/Hamido212/kumo/tree/main/scenes/orbit', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' },
];

mkdirSync(dirname(out), { recursive: true });
s.write(out);
