// Bakes "Metro Block": a city block on a floating slab of rock, with shops, flats above them, a
// glass tower in the courtyard, parked cars, street lamps and a visitor circling overhead. By
// day it is a toy town; at night the windows and lamps come on.
//
//   node scenes/fetch-models.mjs                      once: download the models (see models.json)
//   node scenes/metro/bake.mjs [out.kumo]             default: scenes/out/metro-block.kumo
//
// Buildings, vehicles and street furniture are MagicaVoxel models from Mini Mike's Metro Minis
// by Mike Judge (CC BY 4.0). The ground, the tower and the rock are generated here.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grid, KIND_GLOW, meshGrid, mulberry32 } from '../lib/grid.mjs';
import { SceneWriter, lin } from '../lib/kumo.mjs';
import { Models } from '../lib/models.mjs';
import { addClouds, lightWindows, noise2, rockBase, rockSides, roundedSquare } from '../lib/parts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(here, '..', 'out', 'metro-block.kumo');
const models = new Models('mmmm');
const rand = mulberry32(2026);
const pick = (list) => list[Math.floor(rand() * list.length)];

const SCALE = 0.3;           // world units per voxel
const HALF = 150;            // the slab reaches from -150 to 150 voxels
const BLOCK = 96;            // the buildings fill -96..96
const WALK = 110, ROAD = 138; // pavement out to 110, road out to 138, then the rim
const SLAB = 3;              // thickness of the ground
const world = new Grid(HALF * 2 + 4, 150, HALF * 2 + 4, HALF + 2, SLAB, HALF + 2);
const inside = roundedSquare(HALF, 38, 5);
// KUMO_STAGES=1 prints how many vertices the world has after each step (slow)
const stage = (name) => { if (process.env.KUMO_STAGES) console.log(`  after ${name}: ${meshGrid(world).pos.length / 3} vertices`); };

// ---------------------------------------------------------------- ground

const ASPHALT = 0x3b3e44, LINE = 0xd9d6c8, PAVE = 0x9ea1a8, PAVE_JOINT = 0x8d9097, CURB = 0xb9bcc2, GRASS = 0x5c9a48, GRASS_2 = 0x538f43;
for (let z = -HALF; z < HALF; z++) for (let x = -HALF; x < HALF; x++) {
  if (!inside(x, z)) continue;
  const m = Math.max(Math.abs(x + 0.5), Math.abs(z + 0.5));   // distance from the middle, square rings
  const along = Math.abs(x + 0.5) > Math.abs(z + 0.5) ? z : x; // position along the road
  let top, color;
  if (m < WALK) {
    top = 0;
    color = m > WALK - 1 ? CURB : ((x + 150) % 14 === 0 || (z + 150) % 14 === 0) ? PAVE_JOINT : PAVE;
  } else if (m < ROAD) {
    top = -1;
    const mid = Math.abs(m - (WALK + ROAD) / 2) < 1 && Math.abs(along) < WALK && ((along + 300) % 12) < 7;
    const zebra = Math.abs(along) < 9 && m > WALK + 3 && m < ROAD - 3 && ((Math.floor(m) - WALK) % 4) < 2;
    color = zebra || mid ? LINE : ASPHALT;
  } else {
    top = 0;
    color = m < ROAD + 1 ? CURB : noise2(x / 9, z / 9, 3) > 0.5 ? GRASS : GRASS_2;
  }
  for (let y = -SLAB; y <= top; y++) world.set(x, y, z, y === top ? color : y < -1 ? 0x6a6660 : 0x77736c);
}
stage('ground');
const GROUND = 1; // buildings and street furniture stand on the pavement's top

// ---------------------------------------------------------------- buildings

const GLASS = [0xccfcfc, 0x98ccfc, 0x30ccfc, 0xfcfccc];
const WARM = [0xffd98a, 0xffc870, 0xffe9b8, 0xffb65c, 0xbfe6ff];
// The models are plain grey where a neighbour is meant to stand. Each plot gets a colour of its
// own instead, so that a windowless side wall reads as painted brick; flat roofs become gravel.
const BODY = 0x888888, GRAVEL = 0x70747b;
function dress(name, chance, wall) {
  const m = lightWindows(models.get(name), { glass: GLASS, chance, lit: WARM, rand });
  m.each((x, y, z, c, i) => { if (c === BODY) m.col[i] = y === m.sy - 1 ? GRAVEL : wall; });
  if (name === 'obj_store15') return m;
  // windows in the bare side and back walls (a neighbour that stands against one hides them)
  const y0 = m.sy > 20 ? 9 : 7;
  const pane = (cells) => {
    const on = rand() < 0.55, color = on ? pick(WARM) : 0x98ccfc;
    for (const [x, y, z] of cells) {
      const i = m.idx(x, y, z);
      if (m.col[i] === wall) { m.col[i] = color; m.kind[i] = on ? KIND_GLOW : m.kind[i]; }
    }
  };
  const cells = (fn) => { const list = []; for (let a = 0; a < 5; a++) for (let y = y0; y < y0 + 6; y++) list.push(fn(a, y)); return list; };
  for (const x of [0, m.sx - 1]) for (const z of [12, 36]) pane(cells((a, y) => [x, y, z + a]));
  for (let x = 5; x + 5 < m.sx; x += 16) pane(cells((a, y) => [x + a, y, 0]));
  return m;
}

// Eight plots around a courtyard, as a pinwheel: every side of the block shows two shop fronts.
// rot turns a model's front (its +z side) to face: 0 south, 1 west, 2 north, 3 east.
const plots = [
  { x: -96, z: 32, rot: 0, shops: ['obj_store01'], floors: 2, wall: 0x9c5f4a },
  { x: -32, z: 32, rot: 0, shops: ['obj_store07', 'obj_store08'], floors: 1, wall: 0xc4ad84 },
  { x: 32, z: 32, rot: 3, shops: ['obj_store03'], floors: 3, wall: 0x6d7d93 },
  { x: 32, z: -32, rot: 3, shops: ['obj_store12'], floors: 1, wall: 0xa9765a },
  { x: 32, z: -96, rot: 2, shops: ['obj_store04'], floors: 2, wall: 0x8c8f78 },
  { x: -32, z: -96, rot: 2, shops: ['obj_store15'], floors: 0, wall: 0x888888 },
  { x: -96, z: -96, rot: 1, shops: ['obj_store13'], floors: 1, wall: 0x7c6a8c },
  { x: -96, z: -32, rot: 1, shops: ['obj_store09', 'obj_store10'], floors: 3, wall: 0xb5805f },
];
const FLOORS = ['obj_story01', 'obj_story02', 'obj_story03', 'obj_story05', 'obj_story06'];
const signs = [];

/** Puts a model on a 64x64 plot: `slot` of `slots` along the front, its front on the plot's front. */
function place(plot, model, slot, slots, y) {
  const wide = 64 / slots, deep = model.sz;
  const side = plot.rot === 0 || plot.rot === 3 ? slot * wide : 64 - (slot + 1) * wide; // left to right, seen from the street
  const at = plot.rot === 0 ? [plot.x + side, y, plot.z + 64 - deep]
    : plot.rot === 2 ? [plot.x + side, y, plot.z]
    : plot.rot === 3 ? [plot.x + 64 - deep, y, plot.z + side]
    : [plot.x, y, plot.z + side];
  return world.stamp(model, at, { rot: plot.rot });
}

for (const plot of plots) {
  const slots = plot.shops.length;
  plot.shops.forEach((name, i) => {
    const box = place(plot, dress(name, 0.75, plot.wall), i, slots, GROUND);
    signs.push({ plot, box });
  });
  let y = GROUND + 24;
  if (plot.shops[0] === 'obj_store15') continue; // the cinema is taller than a shop and has no flats
  for (let f = 0; f < plot.floors; f++, y += 20) {
    for (let i = 0; i < 2; i++) place(plot, dress(pick(FLOORS), 0.5, plot.wall), i, 2, y);
  }
  // on the roof: a ventilation unit or two, and a water tank on the tall ones
  const rx = plot.x + 10 + Math.floor(rand() * 20), rz = plot.z + 12 + Math.floor(rand() * 20);
  world.box(rx, y, rz, rx + 7, y + 3, rz + 5, 0x9aa0a8);
  world.box(rx + 16, y, rz + 9, rx + 21, y + 2, rz + 16, 0x8b9199);
  if (plot.floors >= 2) {
    world.box(rx + 14, y, rz - 6, rx + 21, y + 1, rz + 1, 0x5d4a3a);
    world.box(rx + 13, y + 2, rz - 7, rx + 22, y + 9, rz + 2, (x, yy, z) => ((x + z) % 3 === 0 ? 0x7a5a40 : 0x8a6848));
    world.box(rx + 14, y + 10, rz - 6, rx + 21, y + 10, rz + 1, 0x4a3a2e);
  }
}

stage('buildings');
// ---------------------------------------------------------------- the tower in the courtyard

function tower(x0, z0, w, d, y0, floors) {
  const WALL = 0x54606f, PIER = 0x657282, DARK = 0x33475f, ROOF = 0x6d7480;
  const h = floors * 10;
  world.box(x0, y0, z0, x0 + w - 1, y0 + h - 1, z0 + d - 1, (x, y, z) => {
    const fy = (y - y0) % 10;
    const onX = x === x0 || x === x0 + w - 1, onZ = z === z0 || z === z0 + d - 1;
    if (!onX && !onZ) return WALL;
    const a = onZ ? x - x0 : z - z0, n = onZ ? w : d; // position along the face
    if (a < 3 || a >= n - 3 || (a - 3) % 7 >= 5) return PIER;
    return fy >= 3 && fy <= 7 ? DARK : WALL;
  });
  // light some of the windows, one pane at a time
  for (let f = 0; f < floors; f++) for (const face of [0, 1, 2, 3]) {
    const n = face < 2 ? w : d;
    for (let a = 3; a + 5 <= n - 3; a += 7) {
      if (rand() > 0.5) continue;
      const color = pick(WARM);
      for (let k = 0; k < 5; k++) for (let fy = 3; fy <= 7; fy++) {
        const x = face === 0 ? x0 + a + k : face === 1 ? x0 + a + k : face === 2 ? x0 : x0 + w - 1;
        const z = face === 0 ? z0 : face === 1 ? z0 + d - 1 : z0 + a + k;
        world.set(x, y0 + f * 10 + fy, z, color, 0, KIND_GLOW);
      }
    }
  }
  const top = y0 + h;
  world.box(x0, top, z0, x0 + w - 1, top, z0 + d - 1, ROOF);
  world.box(x0, top + 1, z0, x0 + w - 1, top + 2, z0 + d - 1, (x, y, z) => (x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + d - 1 ? PIER : ROOF));
  for (let x = x0 + 1; x < x0 + w - 1; x++) for (let z = z0 + 1; z < z0 + d - 1; z++) { world.clear(x, top + 1, z); world.clear(x, top + 2, z); }
  world.box(x0 + 8, top + 1, z0 + 8, x0 + 19, top + 6, z0 + 17, 0x7d848f); // plant room
  return top;
}
const towerTop = tower(-26, -26, 52, 52, GROUND, 11);
const mast = world.stamp(models.get('obj_celltower'), [8, towerTop + 1, 6], { center: true });
const beacon = [8, mast.y1 + 1, 6];
world.set(...beacon, 0xff3b2f, 0, KIND_GLOW);

stage('tower');
// ---------------------------------------------------------------- street furniture

const LAMP = 0xfff1b8;
const lamps = [];
function lamp(x, z, rot) {
  const box = world.stamp(models.get('obj_stlight2'), [x, GROUND, z], { rot, center: true, paint: (c) => (c === 0xcccc98 ? { color: LAMP, glow: true } : c) });
  let n = 0, sx = 0, sy = 0, sz = 0;
  for (let y = box.y0; y <= box.y1; y++) for (let zz = box.z0; zz <= box.z1; zz++) for (let xx = box.x0; xx <= box.x1; xx++) {
    if (world.colorAt(xx, y, zz) === LAMP) { n++; sx += xx + 0.5; sy += y; sz += zz + 0.5; }
  }
  lamps.push([sx / n, sy / n, sz / n]);
}
const KERB = WALK - 5;
for (const a of [-70, 0, 70]) {
  lamp(a, KERB, 0); lamp(a, -KERB, 2); lamp(KERB, a, 3); lamp(-KERB, a, 1);
}

const LEAVES = [0x4f9d3a, 0x5fae45, 0x3f8f3a, 0x6bb650];
function tree(x, z, name = pick(['obj_tree1', 'obj_tree2', 'obj_tree3', 'obj_tree1'])) {
  const m = models.get(name), leaf = pick(LEAVES);
  // the crown sways in the wind, more at the top; two steps keep the mesh small
  world.stamp(m, [x, GROUND, z], { center: true, paint: (c, mx, my) => (c === 0x64cc00 ? { color: leaf, sway: my > m.sy * 0.7 ? 0.9 : 0.5 } : c === 0x989864 ? 0x6b4a2f : c) });
}
// a row of trees on the rim, and a few on the pavement in front of the windowless walls
for (let a = -108; a <= 108; a += 36) {
  if (Math.abs(a) < 14) continue;
  for (const [x, z] of [[a, 144], [a, -144], [144, a], [-144, a]]) if (inside(x, z) && inside(x * 1.03, z * 1.03)) tree(x + Math.round(rand() * 4 - 2), z);
}
for (const [x, z] of [[-103, 64], [64, 103], [103, -64], [-64, -103]]) tree(x, z, 'obj_tree2');

stage('lamps and trees');
// parked along the kerb: [model, position along the road, side]
const CARS = [
  ['veh_cab1', -74, 'S'], ['veh_car1', -30, 'S'], ['veh_mini2', 52, 'S'], ['veh_bus', 40, 'N'], ['veh_car3', -58, 'N'],
  ['veh_suv1', 60, 'E'], ['veh_lunch1', -44, 'E'], ['veh_police1', 34, 'W'], ['veh_mini4', -62, 'W'],
];
for (const [name, a, side] of CARS) {
  const m = models.get(name);
  const lane = WALK + 2 + Math.ceil(m.sx / 2); // the model is as wide as its sx, parked near the kerb
  const at = side === 'S' ? [a, 0, lane] : side === 'N' ? [a, 0, -lane] : side === 'E' ? [lane, 0, a] : [-lane, 0, a];
  world.stamp(m, at, { center: true, rot: side === 'S' ? 1 : side === 'N' ? 3 : side === 'E' ? 0 : 2 });
}

stage('cars');
// small things on the pavement
const SMALL = [
  ['obj_busstop', 30, 103, 2], ['obj_bench1', -12, 104, 2], ['obj_hydrant', -86, 105, 0], ['obj_newsbox1', -52, 104, 0], ['obj_mailbox', 14, 104, 0],
  ['obj_bench1', 104, 10, 1], ['obj_trashcan1', 104, 26, 0], ['obj_newsbox3', 104, -20, 0], ['obj_hydrant', 105, 86, 0],
  ['obj_bench2', 6, -104, 0], ['obj_trashcan2', -20, -104, 0], ['obj_mailbox', 60, -104, 2], ['obj_newsbox2', 86, -104, 0],
  ['obj_bench1', -104, -8, 3], ['obj_planter1', -104, 20, 0], ['obj_planter1', -104, -40, 0], ['obj_trashcan1', -104, 60, 0],
];
for (const [name, x, z, rot] of SMALL) world.stamp(models.get(name), [x, GROUND, z], { center: true, rot });

stage('small things');
// ---------------------------------------------------------------- scene

const s = new SceneWriter({ title: 'Metro Block' });
const U = (x, y, z) => [x * SCALE, y * SCALE, z * SCALE]; // voxels -> world units

s.object({ mesh: s.addGrid('city', world, { scale: SCALE }), cast: true, receive: true });
const rock = rockBase({ inside, half: HALF, cell: 6, depth: 13, seed: 11 });
s.object({ mesh: s.addGrid('rock', rock, { scale: SCALE * 6, offset: [0, -SLAB * SCALE, 0], sides: rockSides }), cast: false, receive: false });

// lamps: a halo each, and real light from the four in the middle of each side
for (const p of lamps) s.glow(U(...p), 3.6, 0xffc978, 0.9);
for (const i of [1, 4, 7, 10]) { const p = lamps[i]; s.light(U(p[0], p[1] - 2, p[2]), 0xffb866, 24, 22, 1.6); }
// shop signs: a soft wash of colour over each front
const NEON = [0xff4fa3, 0x4fd8ff, 0xffb347, 0x9d7bff, 0x5dffb0];
signs.forEach(({ plot, box }, i) => {
  const cx = (box.x0 + box.x1 + 1) / 2, cz = (box.z0 + box.z1 + 1) / 2, y = GROUND + 19;
  const p = plot.rot === 0 ? [cx, y, box.z1 + 2] : plot.rot === 2 ? [cx, y, box.z0 - 1] : plot.rot === 3 ? [box.x1 + 2, y, cz] : [box.x0 - 1, y, cz];
  s.glow(U(...p), 8, NEON[i % NEON.length], 0.5);
});
s.glow(U(beacon[0] + 0.5, beacon[1] + 0.5, beacon[2] + 0.5), 3, 0xff3b2f, 1);

// the visitor: a saucer that circles above the roofs, with a cold light under it
const saucer = models.get('alien_saucer1a');
const saucerMesh = s.addGrid('saucer', saucer, { scale: SCALE, offset: [-saucer.sx / 2 * SCALE, 0, -saucer.sz / 2 * SCALE] });
const ufo = s.object({
  mesh: saucerMesh, cast: false, receive: false, emissive: lin(0x141c26),
  orbit: { angle: 2.2, radius: 27, y: 43, speed: 0.11, wobble: 1 },
});
s.glow([0, 0, 0], 11, 0x7fe9ff, 0.8, { object: ufo, local: [0, 0.5, 0] });

addClouds(s, { seed: 31 });

const m = s.manifest;
m.credits = [
  models.credit('Converted from MagicaVoxel models to meshes; some windows and lamps recoloured so that they light up; trees recoloured; arranged into a scene.'),
  { title: 'Metro Block (scene, ground, tower, island)', author: 'Kumo', source: 'https://github.com/Hamido212/kumo', license: 'GPL-3.0', licenseUrl: 'https://www.gnu.org/licenses/gpl-3.0.html' },
];
m.camera = { target: [0, 12, 0], fov: 30, near: 1, far: 2000, angle: 0.62, elev: 0.33, fit: [43, 58], orbitSpeed: 0.028 };
m.shadow = { size: 2048, extent: 60, near: 10, far: 400, target: [0, 8, 0], distance: 190, bias: -0.0004, normalBias: 0.05 };

mkdirSync(dirname(out), { recursive: true });
s.write(out);
console.log(`models: ${m.credits[0].models.join(' ')}`);
