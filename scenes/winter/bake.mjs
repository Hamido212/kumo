// Bakes "Winter Square": a village square under snow on a floating island, with a tall
// decorated tree in the middle, houses with warm windows, pines, an ice pond with penguins,
// snowmen, and snow that keeps falling.
//
//   node scenes/fetch-models.mjs                      once: download the models (see models.json)
//   node scenes/winter/bake.mjs [out.kumo]            default: scenes/out/winter-square.kumo
//
// Houses, the tree, lamps and the other things are MagicaVoxel models from Mini Mike's Metro
// Minis by Mike Judge (CC BY 4.0). The island, the snow and the snowmen are generated here.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grid, KIND_GLOW, meshGrid, mulberry32 } from '../lib/grid.mjs';
import { SceneWriter, SKY_GARDEN, lin, skyKeys, v3 } from '../lib/kumo.mjs';
import { Models } from '../lib/models.mjs';
import { addClouds, enlarge, lightWindows, mixHex, noise2, rockBase, rockSides, roundIsland, snow } from '../lib/parts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(here, '..', 'out', 'winter-square.kumo');
const models = new Models('mmmm');
const rand = mulberry32(1224);
const pick = (list) => list[Math.floor(rand() * list.length)];
// KUMO_STAGES=1 prints how many vertices the world has after each step (slow)
const stage = (name) => { if (process.env.KUMO_STAGES) console.log(`  after ${name}: ${meshGrid(world).pos.length / 3} vertices`); };

const SCALE = 0.3;   // world units per voxel
const R = 140;       // the island's radius in voxels
const SLAB = 5;
const GROUND = 1;    // the ground's surface, before the snow
const world = new Grid(R * 2 + 4, 96, R * 2 + 4, R + 2, SLAB, R + 2);
const inside = roundIsland(R, 33);
const U = (x, y, z) => [x * SCALE, y * SCALE, z * SCALE];

// ---------------------------------------------------------------- plan

const HOUSES = [
  { name: 'obj_house4b', x: -84, z: -36, rot: 3 },
  { name: 'obj_house8b', x: -8, z: -92, rot: 2 },
  { name: 'obj_house1a', x: 76, z: -52, rot: 1 },
  { name: 'obj_house6b', x: -70, z: 62, rot: 0 },
  { name: 'obj_house2a', x: 20, z: 94, rot: 0 },
];
for (const h of HOUSES) {
  const m = models.get(h.name);
  const w = h.rot % 2 ? m.sz : m.sx, d = h.rot % 2 ? m.sx : m.sz;
  Object.assign(h, { x0: Math.round(h.x - w / 2), z0: Math.round(h.z - d / 2), w, d });
}
const ICE = { x: 82, z: 40, rx: 27, rz: 21 };
const onIce = (x, z) => ((x - ICE.x) / ICE.rx) ** 2 + ((z - ICE.z) / ICE.rz) ** 2 < 1;
const onPad = (x, z, by = 0) => HOUSES.find((h) => x >= h.x0 - by && x < h.x0 + h.w + by && z >= h.z0 - by && z < h.z0 + h.d + by);
/** Swept paths: a ring around the tree and a lane to every door. */
function swept(x, z) {
  const r = Math.hypot(x, z);
  if (r > 25 && r < 34) return true;
  for (const h of HOUSES) {
    const len = Math.hypot(h.x, h.z);
    const along = (x * h.x + z * h.z) / len, across = Math.abs(x * h.z - z * h.x) / len;
    if (along > 30 && along < len - 10 && across < 3.5) return true;
  }
  return false;
}

// ---------------------------------------------------------------- ground

const COBBLE = [0x8d9299, 0x7f848b], EARTH = 0x7a7468, SOIL = 0x66564a, ICE_1 = 0xbfe2f0, ICE_2 = 0xd3edf6;
for (let z = -R; z < R; z++) for (let x = -R; x < R; x++) {
  if (!inside(x, z)) continue;
  const ice = onIce(x, z);
  const top = ice ? GROUND - 2 : GROUND - 1;
  const color = ice ? (noise2(x / 5 + z / 9, z / 14, 6) > 0.62 ? ICE_2 : ICE_1) : swept(x, z) ? COBBLE[((x >> 2) + (z >> 2)) & 1] : EARTH;
  for (let y = -SLAB; y <= top; y++) world.set(x, y, z, y === top ? color : SOIL);
}
stage('ground');

// ---------------------------------------------------------------- houses

const GLASS = [0x98ccfc, 0x30ccfc, 0x3098fc, 0xccfcfc, 0x64ccfc];
const WARM = [0xffd98a, 0xffc870, 0xffe9b8, 0xffb65c];
const doors = [];
for (const h of HOUSES) {
  world.stamp(lightWindows(models.get(h.name), { glass: GLASS, chance: 0.7, lit: WARM, largest: 120, rand }), [h.x0, GROUND, h.z0], { rot: h.rot });
  const len = Math.hypot(h.x, h.z), reach = Math.min(h.w, h.d) / 2 + 5;
  doors.push([h.x - (h.x / len) * reach, GROUND + 9, h.z - (h.z / len) * reach]);
}
stage('houses');

// ---------------------------------------------------------------- trees

const PINE = 0x1f5a36, PINE_2 = 0x2a6a40;
const fir = models.get('obj_christmas1');
// the big tree: twice the size, its baubles in four colours and glowing
const BAUBLE = [0xff3b30, 0xffcf40, 0x4fb8ff, 0xfff0c8];
const baubles = [];
const big = enlarge(fir, 2);
big.each((x, y, z, c, i) => {
  if (c === 0x005400) { big.col[i] = PINE; return; }
  const k = (Math.floor(x / 2) * 7 + Math.floor(y / 2) * 13 + Math.floor(z / 2) * 5) % BAUBLE.length;
  big.col[i] = BAUBLE[k]; big.kind[i] = KIND_GLOW;
  if (x % 2 === 0 && y % 2 === 0 && z % 2 === 0) baubles.push([x + 1 - big.sx / 2, y + 1, z + 1 - big.sz / 2, BAUBLE[k]]);
});
const bigBox = world.stamp(big, [0, GROUND, 0], { center: true });
const tip = [0, bigBox.y1 + 1, 0];
for (const [dx, dy, dz] of [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0], [-1, 2, 0], [1, 2, 0], [0, 2, -1], [0, 2, 1], [-2, 2, 0], [2, 2, 0]]) world.set(tip[0] + dx, tip[1] + dy, tip[2] + dz, 0xffd84a, 0, KIND_GLOW);

// plain pines around the square and along the shore
const pines = [];
for (let tries = 0; pines.length < 8 && tries < 4000; tries++) {
  const a = rand() * Math.PI * 2, r = 46 + Math.sqrt(rand()) * (R - 60);
  const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
  if (!inside(Math.round(x * 1.12), Math.round(z * 1.12)) || onPad(x, z, 12) || swept(x, z) || onIce(x + 8, z) || onIce(x - 8, z) || onIce(x, z + 8) || onIce(x, z - 8)) continue;
  if (pines.some(([px, pz]) => Math.hypot(px - x, pz - z) < 26)) continue;
  const green = pick([PINE, PINE_2]);
  world.stamp(fir, [x, GROUND, z], { center: true, rot: Math.floor(rand() * 4), paint: () => ({ color: green, sway: 0 }) });
  pines.push([x, z]);
}
stage('trees');

// ---------------------------------------------------------------- things

const put = (name, x, z, rot = 0, paint = null, y = GROUND) => world.stamp(models.get(name), [x, y, z], { center: true, rot, paint });
const LAMP = 0xfff1b8, lamps = [];
for (let k = 0; k < 6; k++) {
  const a = (k / 6) * Math.PI * 2 + 0.52, x = Math.round(Math.cos(a) * 40), z = Math.round(Math.sin(a) * 40);
  const box = put('obj_stlight2', x, z, k % 4, (c) => (c === 0xcccc98 ? { color: LAMP, glow: true } : c));
  let n = 0, sx = 0, sy = 0, sz = 0;
  for (let yy = box.y0; yy <= box.y1; yy++) for (let zz = box.z0; zz <= box.z1; zz++) for (let xx = box.x0; xx <= box.x1; xx++) {
    if (world.colorAt(xx, yy, zz) === LAMP) { n++; sx += xx + 0.5; sy += yy; sz += zz + 0.5; }
  }
  lamps.push([sx / n, sy / n, sz / n]);
}
function snowman(x, z) {
  const WHITE = 0xeef2f7;
  let y = GROUND;
  for (const r of [4.2, 3.2, 2.3]) {
    const c = Math.ceil(r);
    for (let dy = 0; dy < c * 2; dy++) for (let dz = -c; dz <= c; dz++) for (let dx = -c; dx <= c; dx++) {
      if (dx * dx + (dy + 0.5 - r) ** 2 + dz * dz <= r * r) world.set(x + dx, y + dy, z + dz, WHITE);
    }
    y += Math.round(r * 1.55);
  }
  world.set(x, y - 2, z + 3, 0xf28a2e); world.set(x, y - 2, z + 4, 0xf28a2e);        // carrot
  world.set(x - 1, y - 1, z + 2, 0x22262b); world.set(x + 1, y - 1, z + 2, 0x22262b); // eyes
  for (const dy of [-6, -8]) world.set(x, y + dy, z + 3, 0x22262b);                    // buttons
}
snowman(-30, 52); snowman(46, -8); snowman(-44, -78);
for (const [x, z, rot] of [[78, 36, 1], [88, 46, 3], [70, 48, 0]]) put('mob_penguin', x, z, rot, null, GROUND - 1);
put('obj_bench1', 12, 44, 2); put('obj_bench1', -42, 14, 1);
put('veh_wagon1', -100, 24, 0);
put('obj_mailbox2', -50, -30, 0); put('obj_mailbox2', 44, -40, 0); put('obj_mailbox2', -44, 44, 0);
stage('things');

// snow on everything the sky can see, except the swept paths and the ice
snow(world, { skip: (x, y, z) => y < GROUND && (swept(x, z) || onIce(x, z)) });
stage('snow');

// ---------------------------------------------------------------- scene

const s = new SceneWriter({ title: 'Winter Square' });
s.object({ mesh: s.addGrid('square', world, { scale: SCALE }), cast: true, receive: true });
const rock = rockBase({ inside, half: R, cell: 6, depth: 14, seed: 23, soil: SOIL });
s.object({ mesh: s.addGrid('rock', rock, { scale: SCALE * 6, offset: [0, -SLAB * SCALE, 0], sides: rockSides }), cast: false, receive: false });

const m = s.manifest;
for (const p of lamps) s.glow(U(...p), 3.6, 0xffc978, 0.9);
// the tree: one warm light in its branches, a halo on a few baubles and on the star
s.light(U(0, GROUND + 26, 14), 0xffc27a, 30, 26, 1.6);
for (const i of [0, 2, 4]) s.light(U(lamps[i][0], lamps[i][1] - 2, lamps[i][2]), 0xffb866, 22, 20, 1.6);
for (let i = 0; i < baubles.length; i += Math.ceil(baubles.length / 18)) {
  const [x, y, z, color] = baubles[i];
  s.glow(U(x, GROUND + y, z), 2.4, color, 0.8);
}
s.glow(U(0.5, tip[1] + 2.5, 0.5), 5, 0xffd84a, 1);
doors.forEach((p) => s.glow(U(...p), 3, 0xffc070, 0.7));

// snowfall: flakes start high above the island, all over it
const spawns = [];
for (let z = -R; z <= R; z += 18) for (let x = -R; x <= R; x += 18) {
  if (Math.hypot(x, z) < R + 10) spawns.push(v3([(x + rand() * 12) * SCALE, 30 + rand() * 16, (z + rand() * 12) * SCALE]));
}
m.petals = { count: 650, max: 1300, emissive: lin(0x555b63), colors: [0xffffff, 0xf2f6fb, 0xe6eef7, 0xffffff, 0xf7fafd].map(lin), spawns };
s.groundFrom(world, { half: 46, scale: SCALE });

addClouds(s, { seed: 91 });

m.credits = [
  models.credit('Converted from MagicaVoxel models to meshes; some windows, lamps and the tree\'s decorations recoloured so that they light up; one tree enlarged and others recoloured; snow added; arranged into a scene.'),
  { title: 'Winter Square (scene, island, snow, snowmen)', author: 'Kumo', source: 'https://github.com/Hamido212/kumo', license: 'GPL-3.0', licenseUrl: 'https://www.gnu.org/licenses/gpl-3.0.html' },
];
// a paler winter sky by day
m.sky.keys = skyKeys(SKY_GARDEN, (h, k) => {
  if (h >= 8 && h <= 16.2) { k.zen = mixHex(k.zen, 0x9fb6cf, 0.45); k.hor = mixHex(k.hor, 0xeef3f8, 0.5); k.gnd = mixHex(k.gnd, 0xcfd9e4, 0.5); k.key *= 0.9; }
});
m.camera = { target: [0, 7, 0], fov: 30, near: 1, far: 2000, angle: 0.5, elev: 0.36, fit: [35, 50], orbitSpeed: 0.028 };
m.shadow = { size: 2048, extent: 52, near: 10, far: 400, target: [0, 5, 0], distance: 190, bias: -0.0004, normalBias: 0.05 };

mkdirSync(dirname(out), { recursive: true });
s.write(out);
console.log(`models: ${m.credits[0].models.join(' ')}`);
