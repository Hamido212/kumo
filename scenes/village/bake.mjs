// Bakes "Autumn Village": four houses and a tent around a green on a floating island, with a
// duck pond whose stream falls off the edge, trees in autumn colours that shed their leaves, a
// camp fire, lamps and fireflies after dark.
//
//   node scenes/fetch-models.mjs                      once: download the models (see models.json)
//   node scenes/village/bake.mjs [out.kumo]           default: scenes/out/autumn-village.kumo
//
// Houses, trees and garden things are MagicaVoxel models from Mini Mike's Metro Minis by Mike
// Judge (CC BY 4.0). The island, the pond, the paths and the ducks are generated here.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grid, meshGrid, mulberry32 } from '../lib/grid.mjs';
import { SceneWriter, lin, v3 } from '../lib/kumo.mjs';
import { Models } from '../lib/models.mjs';
import { addClouds, lightWindows, noise2, rockBase, rockSides, roundIsland } from '../lib/parts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(here, '..', 'out', 'autumn-village.kumo');
const models = new Models('mmmm');
const rand = mulberry32(1107);
const pick = (list) => list[Math.floor(rand() * list.length)];
// KUMO_STAGES=1 prints how many vertices the world has after each step (slow)
const stage = (name) => { if (process.env.KUMO_STAGES) console.log(`  after ${name}: ${meshGrid(world).pos.length / 3} vertices`); };

const SCALE = 0.3;   // world units per voxel
const R = 150;       // the island's radius in voxels
const SLAB = 7;      // how far the ground reaches below y = 0
const world = new Grid(R * 2 + 4, 96, R * 2 + 4, R + 2, SLAB, R + 2);
const shore = roundIsland(R, 21);
const U = (x, y, z) => [x * SCALE, y * SCALE, z * SCALE];

// ---------------------------------------------------------------- plan

const POND = { x: 84, z: 14, rx: 31, rz: 24 };
const STREAM = { z0: 9, z1: 15 };           // flows east from the pond to the edge
const WATER = 0.45;                          // water level (voxels above y = 0)
const GREEN = { x: -12, z: 0, r: 44 };       // the path circles the green

// rot turns a model: 0 as modelled, 1..3 quarter turns
const HOUSES = [
  { name: 'obj_house4', x: -92, z: -28, rot: 3 },
  { name: 'obj_house5', x: -22, z: -98, rot: 0 },
  { name: 'obj_house1', x: 52, z: -88, rot: 2 },
  { name: 'obj_house8', x: -62, z: 86, rot: 0 },
  { name: 'obj_house7', x: 22, z: 96, rot: 1, tent: true },
];
for (const h of HOUSES) {
  const m = models.get(h.name);
  const w = h.rot % 2 ? m.sz : m.sx, d = h.rot % 2 ? m.sx : m.sz;
  Object.assign(h, { x0: Math.round(h.x - w / 2), z0: Math.round(h.z - d / 2), w, d });
}
const inPond = (x, z) => ((x - POND.x) / POND.rx) ** 2 + ((z - POND.z) / POND.rz) ** 2 + (noise2(x / 9, z / 9, 8) - 0.5) * 0.25 < 1;
const lastLand = Math.max(...[...Array(STREAM.z1 - STREAM.z0 + 1)].map((_, i) => { let x = R; while (x > 0 && !shore(x, STREAM.z0 + i)) x--; return x; }));
const inStream = (x, z) => z >= STREAM.z0 && z <= STREAM.z1 && x > POND.x && x <= lastLand;
const isWater = (x, z) => inPond(x, z) || inStream(x, z);
const inside = (x, z) => shore(x, z) || (z >= STREAM.z0 - 3 && z <= STREAM.z1 + 3 && x > 0 && x <= lastLand);
const nearWater = (x, z, by) => { for (const [dx, dz] of [[by, 0], [-by, 0], [0, by], [0, -by], [by, by], [-by, -by], [by, -by], [-by, by]]) if (isWater(x + dx, z + dz)) return true; return isWater(x, z); };
const onPad = (x, z, by = 0) => HOUSES.find((h) => x >= h.x0 - by && x < h.x0 + h.w + by && z >= h.z0 - by && z < h.z0 + h.d + by);

function onPath(x, z) {
  const wob = 0;
  if (Math.abs(Math.hypot(x - GREEN.x, z - GREEN.z) - GREEN.r) < 3.6 + wob) return true;
  // spurs from the ring to each door and to the pond
  for (const t of [...HOUSES, { x: POND.x - POND.rx, z: POND.z }]) {
    const dx = t.x - GREEN.x, dz = t.z - GREEN.z, len = Math.hypot(dx, dz);
    const along = ((x - GREEN.x) * dx + (z - GREEN.z) * dz) / len, across = Math.abs((x - GREEN.x) * dz - (z - GREEN.z) * dx) / len;
    if (along > GREEN.r && along < len - 8 && across < 3 + wob) return true;
  }
  return false;
}

/** Height of the ground's surface at a column (voxels). */
function surface(x, z) {
  if (isWater(x, z)) return inPond(x, z) ? -3 : -1;
  if (nearWater(x, z, 3)) return 1;
  const pad = onPad(x, z, 3);
  const at = pad ? [pad.x, pad.z] : [x, z];
  return 1 + Math.round(noise2(at[0] / 70, at[1] / 70, 4) * 2.4);
}

// ---------------------------------------------------------------- ground

const GRASS = [0x7d9c46, 0x8aa64e], DIRT = 0xa58460, SOIL = 0x6d5239, SAND = 0xbfa873, BED = 0x8f8a6a;
for (let z = -R; z < R; z++) for (let x = -R; x < R; x++) {
  if (!inside(x, z)) continue;
  const top = surface(x, z) - 1;
  const water = isWater(x, z);
  const color = water ? (inPond(x, z) ? BED : SAND) : nearWater(x, z, 2) ? SAND : onPath(x, z) && !onPad(x, z) ? DIRT : GRASS[noise2(x / 40, z / 40, 2) > 0.5 ? 1 : 0];
  for (let y = -SLAB; y <= top; y++) world.set(x, y, z, y === top ? color : SOIL);
}
stage('ground');

// ---------------------------------------------------------------- houses

const GLASS = [0x98ccfc, 0x30ccfc, 0x3098fc, 0xccfcfc, 0x64ccfc];
const WARM = [0xffd98a, 0xffc870, 0xffe9b8, 0xffb65c];
const doors = [];
for (const h of HOUSES) {
  const m = h.tent ? models.get(h.name) : lightWindows(models.get(h.name), { glass: GLASS, chance: 0.6, lit: WARM, largest: 120, rand });
  const y = surface(h.x, h.z);
  world.stamp(m, [h.x0, y, h.z0], { rot: h.rot });
  // a light by the door, on the side that faces the green
  const dx = GREEN.x - h.x, dz = GREEN.z - h.z, len = Math.hypot(dx, dz), reach = Math.min(h.w, h.d) / 2 + 5;
  doors.push([h.x + (dx / len) * reach, y + 9, h.z + (dz / len) * reach]);
}
stage('houses');

// ---------------------------------------------------------------- trees

const LEAF = [0xd9762b, 0xc24a2a, 0xe2a530, 0xb8862c, 0xd95f2a, 0x8f9c3a];
const spawns = [], trees = [];
function tree(x, z, name) {
  const m = models.get(name), leaf = pick(LEAF), y = surface(x, z);
  world.stamp(m, [x, y, z], { center: true, paint: (c, mx, my) => (c === 0x64cc00 ? { color: leaf, sway: my > m.sy * 0.7 ? 0.9 : 0.5 } : c === 0x989864 ? 0x6b4a2f : c === 0xfc0000 ? 0xa3301f : c) });
  trees.push([x, z]);
  for (let k = 0; k < 4; k++) spawns.push(U(x + (rand() - 0.5) * m.sx * 0.8, y + m.sy * (0.6 + rand() * 0.35), z + (rand() - 0.5) * m.sz * 0.8));
}
for (let tries = 0; trees.length < 24 && tries < 4000; tries++) {
  const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * (R - 14);
  const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
  if (!shore(Math.round(x * 1.09), Math.round(z * 1.09)) || onPad(x, z, 9) || nearWater(x, z, 9) || onPath(x, z)) continue;
  if (Math.hypot(x - GREEN.x, z - GREEN.z) < GREEN.r - 26) continue; // keep the middle of the green open
  if (trees.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 15)) continue;
  tree(x, z, pick(['obj_tree1', 'obj_tree1', 'obj_tree4', 'obj_tree2', 'obj_tree3']));
}
stage('trees');

// ---------------------------------------------------------------- garden things

const put = (name, x, z, rot = 0, paint = null) => world.stamp(models.get(name), [x, surface(x, z), z], { center: true, rot, paint });
const FIRE = new Set([0xfccc30, 0xfc9800, 0xfccc00, 0xa80000, 0xb80000, 0x880000]);
const camp = [50, 84];
put('obj_campfire', ...camp, 0, (c) => (FIRE.has(c) ? { color: c === 0xa80000 || c === 0x880000 || c === 0xb80000 ? 0xff5a1f : c, glow: true } : c));
const LAMP = 0xfff1b8, lampHeads = [];
for (const [x, z, rot] of [[GREEN.x - 20, GREEN.z + 30, 0], [GREEN.x + 24, GREEN.z - 26, 0]]) {
  const box = put('obj_stlight1', x, z, rot, (c) => (c === 0xcccc98 ? { color: LAMP, glow: true } : c));
  for (const end of [box.x0 + 2, box.x1 - 2]) lampHeads.push([end + 0.5, box.y1 - 2, (box.z0 + box.z1 + 1) / 2]);
}
put('obj_bench1', POND.x - POND.rx - 9, POND.z - 12, 1);
put('obj_bench1', GREEN.x + 2, GREEN.z + 8, 0);
put('obj_table1', 36, 74, 0);
put('obj_grill', 44, 70, 0);
put('mob_dog1', 58, 96, 2);
put('mob_cat1', -70, -2, 1);
put('obj_mailbox2', -66, -40, 0);
put('obj_mailbox2', -8, -66, 0);
put('obj_mailbox2', 40, -56, 0);
put('obj_mailbox2', -44, 56, 0);
for (const [x, z] of [[-60, -52], [-56, -48], [-2, -62], [30, -54], [-42, 62], [-38, 58], [10, 80], [-74, 10]]) put('obj_pumpkin', x, z, Math.floor(rand() * 4));
for (const [x, z] of [[-110, 30], [96, -44], [-20, 128], [8, -128]]) put(pick(['obj_mushroom1', 'obj_mushroom2', 'obj_mushroom3']), x, z);
// a picket fence along the front of the white house
for (let k = 0; k < 5; k++) put('obj_fence7', -52, -56 + k * 14, 1);
stage('garden things');

// ---------------------------------------------------------------- scene

const s = new SceneWriter({ title: 'Autumn Village' });
s.object({ mesh: s.addGrid('village', world, { scale: SCALE }), cast: true, receive: true });
const rock = rockBase({ inside, half: R, cell: 6, depth: 15, seed: 19, soil: SOIL });
s.object({ mesh: s.addGrid('rock', rock, { scale: SCALE * 6, offset: [0, -SLAB * SCALE, 0], sides: rockSides }), cast: false, receive: false });

// water: one strip per row of the pond and the stream, and the fall at the island's edge
const strips = [];
for (let z = -R; z < R; z++) {
  for (let x = -R; x < R; x++) {
    if (!isWater(x, z)) continue;
    const x0 = x;
    while (x + 1 < R && isWater(x + 1, z)) x++;
    strips.push([x0 * SCALE, z * SCALE, (x + 1) * SCALE, (z + 1) * SCALE]);
  }
}
const waterY = WATER * SCALE;
const m = s.manifest;
m.water.mesh = s.addSurface('water', waterY, strips);
s.addWaterfall('waterfall', { x: (lastLand + 1) * SCALE, y: waterY, z0: STREAM.z0 * SCALE, z1: (STREAM.z1 + 1) * SCALE });

// three ducks on the pond (they face +x and swim in circles)
const duck = new Grid(6, 5, 3, 0, 0, 0);
duck.box(0, 0, 0, 3, 1, 2, 0xf3f1ea); duck.box(0, 2, 1, 0, 2, 1, 0xf3f1ea); // body, tail
duck.box(3, 2, 1, 4, 3, 1, 0xf3f1ea); duck.set(5, 3, 1, 0xf2a03a);          // neck and head, beak
const duckMesh = s.addGrid('duck', duck, { scale: SCALE, offset: [-2 * SCALE, -0.4 * SCALE, -1.5 * SCALE] });
for (const [th, w, rx, rz, ox, oz] of [[0.4, 0.2, 5.2, 3.6, -1, 0], [2.6, 0.17, 3.2, 4.4, 1.5, -0.6], [4.4, -0.14, 6.4, 4.6, 0, 0.6]]) {
  m.swimmers.push({ mesh: duckMesh, scale: [1.2, 1.2, 1.2], center: [POND.x * SCALE, POND.z * SCALE], th, w, rx, rz, ph: th * 7, ox, oz, y: waterY });
}

// lights: lamps on the green, the camp fire, doors
for (const p of lampHeads) s.glow(U(...p), 3.6, 0xffc978, 0.9);
const fire = U(camp[0] + 0.5, surface(...camp) + 5, camp[1] + 0.5);
s.glow(fire, 6, 0xff8a3c, 1);
s.light(fire, 0xff8a3c, 30, 20, 1.6);
s.light(U(...lampHeads[1]), 0xffb866, 22, 20, 1.6);
s.light(U(...lampHeads[2]), 0xffb866, 22, 20, 1.6);
doors.slice(0, 4).forEach((p, i) => { s.glow(U(...p), 3, 0xffc070, 0.7); if (i === 0) s.light(U(...p), 0xffb866, 20, 18, 1.6); });

// leaves fall from the crowns, and fireflies come out over the pond and the green
m.petals = {
  count: 420, max: 900, emissive: lin(0x1c0f06),
  colors: [0xe0822e, 0xc9502a, 0xe6ad36, 0xb8742a, 0xd8632a].map(lin),
  spawns: spawns.map(v3),
};
s.groundFrom(world, { half: 50, scale: SCALE, level: (x, z) => (isWater(x, z) ? waterY : undefined) });
const flies = [];
for (const [cx, cz, r, n] of [[POND.x, POND.z, 36, 34], [GREEN.x, GREEN.z, 34, 22], [camp[0] - 20, camp[1] - 6, 20, 10]]) {
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r;
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    flies.push(v3([x * SCALE, Math.max(1, surface(Math.round(x), Math.round(z))) * SCALE + 0.8 + rand() * 3.2, z * SCALE, rand() * 100, 0.35 + rand() * 0.3]));
  }
}
m.fireflies.items = flies;

addClouds(s, { seed: 52 });

m.credits = [
  models.credit('Converted from MagicaVoxel models to meshes; some windows, lamps and the fire recoloured so that they light up; trees recoloured for autumn; arranged into a scene.'),
  { title: 'Autumn Village (scene, island, pond, ducks)', author: 'Kumo', source: 'https://github.com/Hamido212/kumo', license: 'GPL-3.0', licenseUrl: 'https://www.gnu.org/licenses/gpl-3.0.html' },
];
m.water.glow = lin(0xffa24a);
m.camera = { target: [0, 6, 0], fov: 30, near: 1, far: 2000, angle: 0.9, elev: 0.36, fit: [34, 51], orbitSpeed: 0.028 };
m.shadow = { size: 2048, extent: 56, near: 10, far: 400, target: [0, 5, 0], distance: 190, bias: -0.0004, normalBias: 0.05 };
// warmer afternoons and a deeper sunset than the garden's sky
m.sky.keys.forEach((k) => { if (k.h >= 16 && k.h <= 19) k.keyC = lin(k.h < 17 ? 0xffe2b8 : k.h < 18 ? 0xffa255 : 0xff7040); });

mkdirSync(dirname(out), { recursive: true });
s.write(out);
console.log(`models: ${m.credits[0].models.join(' ')}`);
