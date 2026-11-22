// Bakes "Neon Horizon": a retro sunset that never ends. A striped sun sinks between mountain
// ridges, a neon grid runs to the horizon, palms line a straight road and a low car waits on it.
// By day the sky burns orange and pink; at night it turns violet, the stars come out and the neon
// shines brighter. The sun stays where it is.
//
//   node scenes/synthwave/bake.mjs [out.kumo]          default: scenes/out/neon-horizon.kumo
//
// Everything is generated here; no third-party models.
//
// Unlike the other scenes the camera does not circle: the picture is built for one view, down the
// road into the sun (camera.orbitSpeed 0). The sun stands still too: sky.sun.rise and set lie so
// far apart that the whole day is one moment of its arc.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Grid, KIND_GLOW, mulberry32, mixHex } from '../lib/grid.mjs';
import { SceneWriter, lin, skyKeys, v3 } from '../lib/kumo.mjs';
import { noise2 } from '../lib/parts.mjs';
import { Shapes } from '../lib/shapes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(here, '..', 'out', 'neon-horizon.kumo');
const rand = mulberry32(1985);

// The viewer stands on the road at EYE; the road runs towards -z, into the sun.
const EYE = [0, 7, 0];
const FAR = -720;           // where the ground ends, behind the last ridge
const SUN = { z: -760, y: 58, r: 112 };
const ROAD = 6;             // half width of the road

const s = new SceneWriter({ title: 'Neon Horizon' });
const m = s.manifest;

/** Turns a polygon so that its front faces the viewer (the camera never moves round). */
function facing(corners) {
  const [a, b, c] = corners;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const e = [EYE[0] - a[0], EYE[1] - a[1], EYE[2] - a[2]];
  return n[0] * e[0] + n[1] * e[1] + n[2] * e[2] >= 0 ? corners : [...corners].reverse();
}

// ---------------------------------------------------------------- ground: the grid and the road

const BASE = 0x0d0718, ROAD_C = 0x0a0812, GRID = 0x9a1278, EDGE = 0x1fa7c4, DASH = 0xb0368e;
const ground = new Shapes();
/** A flat strip from z0 to z1 (any order) between x0 < x1, with a colour at each end. */
function strip(x0, x1, za, zb, y, ca, cb, glow = true) {
  const [z0, z1, c0, c1] = za < zb ? [za, zb, ca, cb] : [zb, za, cb, ca];
  ground.poly([[x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]], [c0, c1, c1, c0], { glow });
}
// a dark sheet under everything, so no seam between the strips can show the sky
ground.flat(-900, -900, 900, 60, -0.6, 0x05030a);
ground.flat(-900, FAR, -ROAD, 60, 0, BASE);
ground.flat(ROAD, FAR, 900, 60, 0, BASE);
ground.flat(-ROAD, FAR, ROAD, 60, 0, ROAD_C);

const dist = (z) => Math.max(1, -z);        // distance from the viewer along the road
const fadeFar = (z) => 1 - Math.min(1, Math.max(0, (dist(z) - 380) / 340)) * 0.55;
// lines along the road: thin raised strips. Far out to the side a line runs almost level across
// the screen and gets thinner than a pixel, which would break it into dots: there it widens, up
// to a limit, and beyond that it fades out.
const SPACING = 9;
const PX = 3.4e-4; // half a line's width that shows as about 1.2 pixels at 1080p, per unit of distance
for (let k = 0; k < 60; k++) {
  const X = ROAD + 4 + k * SPACING;
  const look = (z) => {
    const need = PX * dist(z) * Math.hypot(X, EYE[1]) / EYE[1];
    const w = Math.min(0.9, Math.max(0.08, need));
    const fade = need > 0.9 ? (0.9 / need) ** 2 : 1;
    return { w, c: mixHex(BASE, GRID, fade * fadeFar(z)) };
  };
  for (const side of [-1, 1]) {
    for (let z = 50; z > FAR; z -= 30) {
      const za = z, zb = Math.max(FAR, z - 30), a = look(za), b = look(zb);
      if (a.c === BASE && b.c === BASE) continue;
      const x = side * X;
      const quad = [[x - a.w, 0.06, za], [x - b.w, 0.06, zb], [x + b.w, 0.06, zb], [x + a.w, 0.06, za]];
      ground.poly([...quad].reverse(), [a.c, b.c, b.c, a.c].reverse(), { glow: true });
    }
  }
}
// lines across: they thicken with distance (so they stay at least two pixels wide) and fade out
// before they would crowd into a shimmer
for (let z = 20, n = 0; z > -330; n++) {
  const d = dist(z);
  const w = Math.min(5, Math.max(0.25, 0.0009 * d * d / EYE[1]));
  const t = Math.min(1, Math.max(0, (d - 90) / 220));
  const color = mixHex(GRID, BASE, t * t);
  ground.flat(-900, z - w / 2, -ROAD, z + w / 2, 0.04, color, { glow: true });
  ground.flat(ROAD, z - w / 2, 900, z + w / 2, 0.04, color, { glow: true });
  z -= SPACING * (1 + n * 0.035);
}
// the road: glowing edges, a dashed middle line
for (const side of [-1, 1]) {
  const [x0, x1] = side < 0 ? [-ROAD + 0.15, -ROAD + 0.6] : [ROAD - 0.6, ROAD - 0.15];
  const zs = [50, -100, -250, -400, -550, FAR];
  for (let i = 0; i + 1 < zs.length; i++) strip(x0, x1, zs[i], zs[i + 1], 0.05, mixHex(BASE, EDGE, fadeFar(zs[i])), mixHex(BASE, EDGE, fadeFar(zs[i + 1])));
}
for (let z = 30; z > -430; z -= 9) {
  const len = 3.2 + dist(z) * 0.006, w = 0.16 + dist(z) * 0.0012;
  ground.flat(-w, z - len, w, z, 0.05, mixHex(BASE, DASH, fadeFar(z)), { glow: true });
}
s.object({ mesh: s.addMesh('ground', ground.build()), cast: false, receive: true });

// ---------------------------------------------------------------- mountains: flat ridges, one behind the other

/** A ridge line: heights along x, sharp crests from folded noise. */
function ridge({ x0, x1, step, base, height, seed, valley = null }) {
  const pts = [];
  for (let x = x0; x <= x1 + 1e-6; x += step) {
    let h = 0, amp = 1, f = 1 / 160, sum = 0;
    for (let o = 0; o < 5; o++) {
      const n = noise2(x * f + 11.3 * o, seed * 7.1 + o * 3.7, seed + o);
      h += (1 - Math.abs(n * 2 - 1)) * amp;
      sum += amp; amp *= 0.5; f *= 2.1;
    }
    let y = base + Math.pow(h / sum, 2.2) * height;
    if (valley) y *= valley(x);
    pts.push([x, Math.max(0.5, y)]);
  }
  return pts;
}

const ridges = [];
function mountains(name, { z, pts, body, foot, rim, rimWidth }) {
  const g = new Shapes();
  const n = [0, 0.2, 1];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [xa, ya] = pts[i], [xb, yb] = pts[i + 1];
    g.poly([[xa, -1, z], [xb, -1, z], [xb, yb, z], [xa, ya, z]], [foot, foot, body, body], { normal: n });
    // the glowing rim along the crest, a hair in front of the face
    g.poly([[xa, ya - rimWidth, z + 0.4], [xb, yb - rimWidth, z + 0.4], [xb, yb + 0.15, z + 0.4], [xa, ya + 0.15, z + 0.4]], rim, { glow: true, normal: n });
  }
  ridges.push({ z, pts });
  return s.object({ mesh: s.addMesh(name, g.build()), cast: false, receive: false });
}

const dip = (w, depth) => (x) => 1 - depth * Math.exp(-(x * x) / (w * w)); // the sun sits in the dip
mountains('ridge-far', { z: -690, pts: ridge({ x0: -900, x1: 900, step: 6, base: 6, height: 120, seed: 3, valley: dip(150, 0.82) }), body: 0x3a1a5c, foot: 0x6a2a6e, rim: 0x8a2a8e, rimWidth: 0.9 });
mountains('ridge-mid', { z: -600, pts: ridge({ x0: -800, x1: 800, step: 5, base: 2, height: 85, seed: 8, valley: dip(210, 0.95) }), body: 0x24103e, foot: 0x45204e, rim: 0xa02a90, rimWidth: 0.8 });
mountains('ridge-near', { z: -470, pts: ridge({ x0: -700, x1: 700, step: 4, base: 0, height: 62, seed: 14, valley: dip(260, 1.0) }), body: 0x150a26, foot: 0x2a1236, rim: 0x2c9fc0, rimWidth: 0.7 });

// ---------------------------------------------------------------- the sun: bands of one colour each, the lower ones cut by gaps

const SUN_RAMP = [0xfff27a, 0xffd85a, 0xffb247, 0xff8e40, 0xff6c48, 0xff5060, 0xff3b7a, 0xf22a8e, 0xd81f9e, 0xba17a8];
{
  const top = SUN.y + SUN.r, bottom = SUN.y - SUN.r;
  const cut = SUN.y + SUN.r * 0.18;
  const pieces = [];
  for (let i = 0; i < 5; i++) pieces.push([cut + (top - cut) * i / 5, cut + (top - cut) * (i + 1) / 5]);
  // below the cut, gaps open and widen towards the bottom
  let y = cut, gap = SUN.r * 0.028, band = SUN.r * 0.17;
  while (y > bottom) {
    const y1 = y - gap, y0 = Math.max(bottom, y1 - band);
    if (y1 <= bottom) break;
    pieces.push([y0, y1]);
    y = y0; gap *= 1.32; band *= 0.86;
  }
  for (const [y0, y1] of pieces) {
    const g = new Shapes();
    const steps = Math.max(2, Math.ceil((y1 - y0) / 3));
    const left = [], right = [];
    for (let k = 0; k <= steps; k++) {
      const yy = y0 + (y1 - y0) * k / steps;
      const half = Math.sqrt(Math.max(0, SUN.r * SUN.r - (yy - SUN.y) ** 2));
      left.push([-half, yy, SUN.z]); right.push([half, yy, SUN.z]);
    }
    for (let k = 0; k < steps; k++) g.quad(left[k], right[k], right[k + 1], left[k + 1], 0x000000, { normal: [0, 0, 1] });
    const t = 1 - ((y0 + y1) / 2 - bottom) / (top - bottom); // 0 at the top
    const f = t * (SUN_RAMP.length - 1), i = Math.floor(f);
    const c = mixHex(SUN_RAMP[i], SUN_RAMP[Math.min(SUN_RAMP.length - 1, i + 1)], f - i);
    s.object({ mesh: s.addMesh('sun', g.build()), cast: false, receive: false, emissive: lin(c).map((v) => Math.round(v * 1.35 * 1e4) / 1e4) });
  }
}

// ---------------------------------------------------------------- palms

const TRUNK = [0x170b20, 0x1f1029], FROND = [0x10081a, 0x150a20, 0x1a0c26];
/** A palm of height h (world units) standing at base: a curved trunk and drooping, serrated fronds. */
function palm(g, base, h, seed) {
  const r = mulberry32(seed);
  const head = r() * Math.PI * 2, lean = (0.05 + r() * 0.12) * h;
  const dx = Math.cos(head), dz = Math.sin(head);
  const at = (t) => [base[0] + dx * lean * t * t, base[1] + h * t, base[2] + dz * lean * t * t];
  const SEG = 12, SIDES = 6;
  for (let i = 0; i < SEG; i++) {
    const t0 = i / SEG, t1 = (i + 1) / SEG, c0 = at(t0), c1 = at(t1);
    const r0 = h * 0.026 * (1 - 0.35 * t0), r1 = h * 0.026 * (1 - 0.35 * t1);
    for (let k = 0; k < SIDES; k++) {
      const a0 = (k / SIDES) * Math.PI * 2, a1 = ((k + 1) / SIDES) * Math.PI * 2;
      const p = (c, rr, a) => [c[0] + Math.cos(a) * rr, c[1], c[2] + Math.sin(a) * rr];
      g.poly([p(c0, r0, a0), p(c1, r1, a0), p(c1, r1, a1), p(c0, r0, a1)], TRUNK[i % 2]);
    }
  }
  const top = at(1);
  // leaflets narrower than about two pixels would sparkle as they sway: far palms get broader ones
  const eyeDist = Math.hypot(top[0] - EYE[0], top[2] - EYE[2]);
  const fronds = 11 + Math.floor(r() * 3);
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + r() * 0.3, len = h * (0.42 + r() * 0.12);
    const ux = Math.cos(a), uz = Math.sin(a), qx = -uz, qz = ux;
    const lift = 0.35 + r() * 0.55, droop = 2.0 + r() * 0.9, M = 18;
    const spine = [top];
    for (let i = 1; i <= M; i++) {
      const pitch = lift - droop * Math.pow(i / M, 1.3), p = spine[i - 1], st = len / M;
      spine.push([p[0] + ux * Math.cos(pitch) * st, p[1] + Math.sin(pitch) * st, p[2] + uz * Math.cos(pitch) * st]);
    }
    const color = FROND[f % FROND.length];
    const sw = (t) => 0.15 + 0.85 * t;
    const put = (corners, sway) => {
      const turned = facing(corners);
      g.poly(turned, color, { sway: turned === corners ? sway : [...sway].reverse() });
    };
    // the rib, then a leaflet on each side of every joint, hanging down and pointing to the tip
    const rib = Math.max(len * 0.012, eyeDist * 0.0006);
    for (let i = 0; i < M; i++) {
      const p = spine[i], q = spine[i + 1];
      put([[p[0], p[1] + rib, p[2]], [p[0], p[1] - rib, p[2]], [q[0], q[1] - rib * 0.5, q[2]], [q[0], q[1] + rib * 0.5, q[2]]], [sw(i / M), sw(i / M), sw((i + 1) / M), sw((i + 1) / M)]);
    }
    const base = Math.max(len * 0.035, eyeDist * 0.0014);
    for (let i = 1; i < M; i++) {
      const t = i / M, p = spine[i], q = spine[Math.min(M, i + 1)];
      const tx = q[0] - p[0], ty = q[1] - p[1], tz = q[2] - p[2], tl = Math.hypot(tx, ty, tz) || 1;
      const ll = len * (0.08 + 0.2 * Math.sin(Math.PI * Math.min(1, t * 1.1)));
      for (const side of [-1, 1]) {
        const hang = 0.55 + t * 0.6;
        const dir = [qx * side * Math.cos(hang) + (tx / tl) * 0.45, -Math.sin(hang) + (ty / tl) * 0.45, qz * side * Math.cos(hang) + (tz / tl) * 0.45];
        const dl = Math.hypot(...dir);
        const tip = [p[0] + (dir[0] / dl) * ll, p[1] + (dir[1] / dl) * ll, p[2] + (dir[2] / dl) * ll];
        const b0 = [p[0] - (tx / tl) * base, p[1] - (ty / tl) * base, p[2] - (tz / tl) * base];
        const b1 = [p[0] + (tx / tl) * base, p[1] + (ty / tl) * base, p[2] + (tz / tl) * base];
        put([b0, b1, tip], [sw(t), sw(t), sw(Math.min(1, t + 0.15))]);
      }
    }
  }
  for (const [ox, oz] of [[0.35, 0], [-0.25, 0.3], [0, -0.35]]) {
    const c = [top[0] + ox * h * 0.03 * 3, top[1] - h * 0.03, top[2] + oz * h * 0.03 * 3], q = h * 0.018;
    g.box(c[0] - q, c[1] - q, c[2] - q, c[0] + q, c[1] + q, c[2] + q, 0x24101a);
  }
}

const palms = new Shapes();
let seed = 100;
for (const z of [-34, -62, -96, -140, -196, -268]) {
  palm(palms, [-(ROAD + 6 + rand() * 3), 0, z], 13 + rand() * 3, seed++);
  palm(palms, [ROAD + 6 + rand() * 3, 0, z - 14], 13 + rand() * 3, seed++);
}
palm(palms, [-31, 0, -16], 21, seed++); // two big ones that frame the view
palm(palms, [29, 0, -23], 20, seed++);
s.object({ mesh: s.addMesh('palms', palms.build()), cast: false, receive: true });

// ---------------------------------------------------------------- the car (an original wedge, no real model)

function car() {
  const L = 40, W = 19;
  const g = new Grid(W, 10, L);
  // dark paint; the surfaces that face the sky take its colour, so the shape reads against the road
  const BODY = 0x2a1442, SIDE = 0x301848, TOP = 0x8a3a8e, ROOF = 0x9a4a9a, GLASS = 0x1a1238, GLASS_HI = 0x6a2a6e;
  const TYRE = 0x08080c, RIM = 0x3a3446, LIGHT = 0xff1e4a, STRIPE = 0x22b7d6;
  // the body's top along its length (nose at z = 0, rear at z = L - 1, towards the viewer)
  const deck = (z) => (z < 8 ? 2 + Math.floor(z / 3) : z < 15 ? 4 : 5);
  // the cabin's top: windscreen, roof, rear window
  const cabin = (z) => (z < 15 || z > 31 ? 0 : z < 20 ? 5 + Math.ceil((z - 14) / 2.5) : z < 27 ? 7 : 7 - Math.floor((z - 26) / 2));
  for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
    const flank = x === 0 || x === W - 1;
    if (flank && (z < 2 || z > L - 3)) continue;
    for (let y = 1; y <= deck(z); y++) g.set(x, y, z, y === deck(z) ? TOP : flank ? SIDE : BODY);
    if (x >= 3 && x <= W - 4) for (let y = deck(z) + 1; y <= cabin(z); y++) {
      const glass = (y < cabin(z) || z < 20 || z > 26) && x > 3 && x < W - 4;
      g.set(x, y, z, glass ? (z > 26 && y === cabin(z) ? GLASS_HI : GLASS) : ROOF);
    }
  }
  // spoiler on two posts
  for (const x of [3, W - 4]) g.set(x, 6, L - 2, BODY);
  for (let x = 1; x < W - 1; x++) for (const z of [L - 3, L - 2, L - 1]) g.set(x, 7, z, z === L - 1 ? BODY : ROOF);
  // the tail light bar across the back, brighter at the ends; cyan trim above it and along the flanks
  for (let x = 1; x < W - 1; x++) g.set(x, 4, L - 1, x < 4 || x > W - 5 ? 0xff5070 : LIGHT, 0, KIND_GLOW);
  for (const x of [1, 2, 3, W - 4, W - 3, W - 2]) g.set(x, 3, L - 1, 0xff5070, 0, KIND_GLOW);
  for (let z = 3; z < L - 3; z++) { g.set(0, 3, z, STRIPE, 0, KIND_GLOW); g.set(W - 1, 3, z, STRIPE, 0, KIND_GLOW); }
  // wheels
  for (const wz of [7, 31]) for (const x of [0, W - 1]) for (let z = wz - 3; z <= wz + 3; z++) for (let y = 0; y <= 3; y++) {
    g.set(x, y, z, Math.abs(z - wz) === 3 || y === 0 || y === 3 ? TYRE : RIM);
  }
  return g;
}
const CAR = { x: 2.8, z: -46, scale: 0.19 };
const carGrid = car();
s.object({ mesh: s.addGrid('car', carGrid, { scale: CAR.scale, offset: [CAR.x - carGrid.sx * CAR.scale / 2, 0, CAR.z - carGrid.sz * CAR.scale] }), cast: true, receive: true });
const tail = [CAR.x, 4 * CAR.scale, CAR.z + 0.15];
for (const dx of [-1.4, 1.4]) s.glow([tail[0] + dx, tail[1], tail[2]], 1.8, 0xff2a55, 0.9);
s.glow(tail, 7, 0xff2a55, 0.35);

// ---------------------------------------------------------------- clouds: thin streaks that drift across the sun

/** A flat streak facing the viewer: dark on top, lit pink underneath. */
function streak(seed, w, h) {
  const r = mulberry32(seed), g = new Shapes();
  const N = 28, bumps = [r() * 6, r() * 6, r() * 6];
  const topAt = (u) => h * Math.pow(1 - u * u, 0.7) * (0.75 + 0.25 * Math.sin(u * 7 + bumps[0]) * Math.sin(u * 3.1 + bumps[1]));
  const botAt = (u) => -h * 0.3 * Math.pow(1 - u * u, 1.2);
  for (let i = 0; i < N; i++) {
    const u0 = -1 + (2 * i) / N, u1 = -1 + (2 * (i + 1)) / N;
    g.quad([u0 * w, botAt(u0), 0], [u1 * w, botAt(u1), 0], [u1 * w, topAt(u1), 0], [u0 * w, topAt(u0), 0], [0x8a2a6a, 0x8a2a6a, 0x2a0f3c, 0x2a0f3c], { normal: [0, 0, 1] });
  }
  return g.build();
}
const cloudMeshes = [0, 1, 2, 3].map((i) => s.addMesh(`cloud${i}`, streak(40 + i, 70 + i * 14, 4 + (i % 2) * 2.5)));
for (let i = 0; i < 8; i++) {
  s.object({
    mesh: cloudMeshes[i % 4], cast: false, receive: false, emissive: lin(0x2a0c26),
    orbit: { angle: (i / 8) * Math.PI * 2 + rand() * 0.5, radius: 600 + rand() * 90, y: 66 + rand() * 70, speed: -(0.0014 + rand() * 0.001), wobble: 0.5 },
  });
}

// ---------------------------------------------------------------- light

// a soft bloom around the sun, behind it so the stripes stay sharp
s.glow([0, SUN.y + SUN.r * 0.45, SUN.z - 30], SUN.r * 4.4, 0xff5a8a, 0.55);
// red beacons on two far peaks, blinking slowly
const peak = (pts, near) => pts.reduce((b, p) => (Math.abs(p[0] - near) < 90 && p[1] > b[1] ? p : b), [near, 0]);
const far = ridges[0];
m.fireflies = { color: lin(0xff2a3a), items: [peak(far.pts, -260), peak(far.pts, 300)].flatMap(([x, y]) => [v3([x, y + 2.5, far.z + 1, 1.3, 9]), v3([x, y + 2.5, far.z + 1, 4.4, 9])]) };
// point lights at night: red behind the car, magenta on the two framing palms, cyan down the road
s.light([CAR.x, 0.9, CAR.z + 2.4], 0xff2050, 9, 14, 1.6);
s.light([-28, 3, -12], 0xd02aa0, 26, 26, 1.6);
s.light([26, 3, -19], 0xd02aa0, 26, 26, 1.6);
s.light([0, 4, -90], 0x2ab8e0, 30, 40, 1.4);

// ---------------------------------------------------------------- sky, camera

// a dusk that lasts all day; night is the same sunset after dark, with stars and brighter neon.
// keyC also tints the glow the sky draws round the sun, so it is dark at night.
const DAY = { zen: 0x1c0848, hor: 0xd0487a, gnd: 0x3a1240, key: 2.2, keyC: 0xffa040, hemiS: 0x7a5aa8, hemiG: 0x40142e, hemiI: 1.0, glow: 0.62, stars: 0.3, exp: 1.0 };
const DUSK = { zen: 0x12063a, hor: 0xa83070, gnd: 0x2c0c38, key: 2.0, keyC: 0xd0607a, hemiS: 0x5a4294, hemiG: 0x30102a, hemiI: 0.95, glow: 0.85, stars: 0.6, exp: 1.04 };
const NIGHT = { zen: 0x04021a, hor: 0x4a0c58, gnd: 0x14061e, key: 2.4, keyC: 0x5a1a50, hemiS: 0x3a2c78, hemiG: 0x1c0a24, hemiI: 0.85, glow: 1, stars: 1, exp: 1.1 };
m.sky.keys = skyKeys([[0, NIGHT], [4.6, NIGHT], [6.4, DUSK], [8.2, DAY], [16.8, DAY], [18.8, DUSK], [20.6, NIGHT]]);
// the sky's own small sun disc hides behind the solid top of the big one
const sunTilt = Math.atan2(SUN.y + SUN.r * 0.55 - EYE[1], -SUN.z);
m.sky.sun = { rise: -9999, set: 9999, tilt: Math.round(sunTilt * 1e4) / 1e4, yaw: Math.round(Math.PI * 1e4) / 1e4 };
m.sky.moon = { tilt: 0.6, yaw: 0 }; // under the horizon: this sky has no moon
m.fog = { near: 600, far: 2600 };

// fixed camera: elev < 0 looks slightly up, so the horizon sits below the middle
const FOV = 34, ELEV = -0.035, D = 80;
m.camera = {
  target: v3([0, EYE[1] - Math.sin(ELEV) * D, -Math.cos(ELEV) * D]), fov: FOV, near: 2, far: 2600, angle: 0, elev: ELEV,
  fit: [Math.round(D * Math.tan((FOV / 2) * Math.PI / 180) * 1e3) / 1e3, 1], orbitSpeed: 0,
};
m.shadow = { size: 2048, extent: 24, near: 10, far: 420, target: [CAR.x, 1, CAR.z], distance: 200, bias: -0.0004, normalBias: 0.05 };

m.credits = [
  { title: 'Neon Horizon (scene, all geometry)', author: 'Kumo', source: 'https://github.com/Hamido212/kumo/tree/main/scenes/synthwave', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' },
];

mkdirSync(dirname(out), { recursive: true });
s.write(out);
