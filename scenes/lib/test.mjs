// Self-tests for the scene tools:  node --test scenes/lib/

import test from 'node:test';
import assert from 'node:assert/strict';
import { Grid, KIND_GLOW, meshGrid, groups } from './grid.mjs';
import { parseVox, voxToGrid } from './vox.mjs';
import { SceneWriter } from './kumo.mjs';
import { Shapes, sphereCap } from './shapes.mjs';

/** A minimal .vox file: one model, optional palette, optional extra chunks. */
function voxFile(size, voxels, { palette = null, extra = [] } = {}) {
  const chunk = (id, content, children = Buffer.alloc(0)) => {
    const head = Buffer.alloc(12);
    head.write(id, 0, 'latin1'); head.writeInt32LE(content.length, 4); head.writeInt32LE(children.length, 8);
    return Buffer.concat([head, content, children]);
  };
  const ints = (...v) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeInt32LE(x, i * 4)); return b; };
  const parts = [chunk('SIZE', ints(...size)), chunk('XYZI', Buffer.concat([ints(voxels.length), Buffer.from(voxels.flat())]))];
  if (palette) {
    const p = Buffer.alloc(1024);
    palette.forEach((hex, i) => { p[i * 4] = hex >> 16; p[i * 4 + 1] = (hex >> 8) & 255; p[i * 4 + 2] = hex & 255; p[i * 4 + 3] = 255; });
    parts.push(chunk('RGBA', p));
  }
  for (const [id, content] of extra) parts.push(chunk(id, content));
  return Buffer.concat([Buffer.from('VOX '), ints(150), chunk('MAIN', Buffer.alloc(0), Buffer.concat(parts))]);
}

/** Checks that every edge of the mesh is shared by exactly two triangles, in opposite directions. */
function assertWatertight(geo) {
  const key = (i) => `${geo.pos[i * 3]},${geo.pos[i * 3 + 1]},${geo.pos[i * 3 + 2]}`;
  const edges = new Map();
  for (let t = 0; t < geo.idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = key(geo.idx[t + k]), b = key(geo.idx[t + (k + 1) % 3]);
      assert.notEqual(a, b, 'a triangle with two equal corners');
      edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) || 0) + 1);
    }
  }
  for (const [e, n] of edges) {
    const [a, b] = e.split('|');
    assert.equal(edges.get(`${b}|${a}`), n, `edge ${e} has no partner: the mesh has a seam`);
  }
}

function area(geo) {
  let sum = 0;
  const p = (i) => [geo.pos[i * 3], geo.pos[i * 3 + 1], geo.pos[i * 3 + 2]];
  for (let t = 0; t < geo.idx.length; t += 3) {
    const [a, b, c] = [p(geo.idx[t]), p(geo.idx[t + 1]), p(geo.idx[t + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    sum += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return sum;
}

test('reads size, voxels and palette, and turns z-up into y-up', () => {
  const vox = parseVox(voxFile([3, 2, 4], [[0, 0, 0, 1], [2, 1, 3, 2]], { palette: [0xff0000, 0x00ff00] }));
  assert.deepEqual(vox.models[0].size, [3, 2, 4]);
  const g = voxToGrid(vox);
  assert.deepEqual([g.sx, g.sy, g.sz], [3, 4, 2]);
  assert.equal(g.colorAt(0, 0, 1), 0xff0000); // y = 0 in the file is the far side (z = 1) here
  assert.equal(g.colorAt(2, 3, 0), 0x00ff00);
  assert.equal(g.count(), 2);
});

test('uses the default palette and marks emissive materials', () => {
  const dict = Buffer.concat([Buffer.from([7, 0, 0, 0]), Buffer.from([1, 0, 0, 0]), Buffer.from([5, 0, 0, 0]), Buffer.from('_type'), Buffer.from([5, 0, 0, 0]), Buffer.from('_emit')]);
  const g = voxToGrid(parseVox(voxFile([1, 1, 2], [[0, 0, 0, 1], [0, 0, 1, 7]], { extra: [['MATL', dict]] })));
  assert.equal(g.colorAt(0, 0, 0), 0xffffff);
  assert.equal(g.colorAt(0, 1, 0), 0xffccff);
  assert.equal(g.get(0, 1, 0), KIND_GLOW);
});

test('places the models of a scene graph, turned and moved', () => {
  const ints = (...v) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeInt32LE(x, i * 4)); return b; };
  const str = (t) => Buffer.concat([ints(t.length), Buffer.from(t)]);
  const dict = (o) => Buffer.concat([ints(Object.keys(o).length), ...Object.entries(o).flatMap(([k, v]) => [str(k), str(v)])]);
  const trn = (id, child, frame) => ['nTRN', Buffer.concat([ints(id), dict({}), ints(child, -1, -1, 1), dict(frame)])];
  const shp = (id, model) => ['nSHP', Buffer.concat([ints(id), dict({}), ints(1, model), dict({})])];
  const one = voxFile([2, 2, 2], [[0, 0, 0, 1]], { palette: [0xff0000, 0x00ff00] });
  // a second model, and a graph: the first stays, the second moves 10 along x and turns 90 degrees about z
  const second = voxFile([2, 2, 2], [[1, 0, 0, 2]]).subarray(20);
  const graph = [trn(0, 1, {}), ['nGRP', Buffer.concat([ints(1), dict({}), ints(2, 2, 4)])], trn(2, 3, { _t: '0 0 0' }), shp(3, 0), trn(4, 5, { _t: '10 0 0', _r: '17' }), shp(5, 1)]
    .map(([id, content]) => { const head = Buffer.alloc(12); head.write(id, 0, 'latin1'); head.writeInt32LE(content.length, 4); return Buffer.concat([head, content]); });
  const file = Buffer.concat([one, second, ...graph]);
  file.writeInt32LE(file.length - 20, 16); // MAIN's children
  const vox = parseVox(file);
  assert.equal(vox.models.length, 2);
  assert.equal(vox.placements.length, 2);
  const g = voxToGrid(vox);
  assert.deepEqual([g.sx, g.sy, g.sz], [12, 1, 2]);
  assert.equal(g.colorAt(0, 0, 1), 0xff0000);
  assert.equal(g.colorAt(11, 0, 0), 0x00ff00);
});

test('rejects files that are not .vox or are cut off', () => {
  assert.throws(() => parseVox(Buffer.from('hello world, this is not a model')), /not a MagicaVoxel/);
  const good = voxFile([2, 2, 2], [[0, 0, 0, 1]]);
  assert.throws(() => parseVox(good.subarray(0, good.length - 3)), /damaged/);
  const empty = Buffer.alloc(20);
  empty.write('VOX '); empty.writeInt32LE(150, 4); empty.write('MAIN', 8);
  assert.throws(() => parseVox(empty), /no model/);
});

test('a cube becomes six quads, and a hidden room is dropped', () => {
  const g = new Grid(8, 8, 8);
  g.box(1, 1, 1, 6, 6, 6, 0x808080);
  let geo = meshGrid(g);
  assert.equal(geo.faces, 6 * 36);
  assert.equal(geo.quads, 6);
  assert.equal(geo.pos.length / 3, 24);
  assertWatertight(geo);
  for (let x = 3; x <= 4; x++) for (let y = 3; y <= 4; y++) for (let z = 3; z <= 4; z++) g.clear(x, y, z);
  geo = meshGrid(g);
  assert.equal(geo.quads, 6, 'the closed room adds no faces');
  assert.equal(meshGrid(g, { hidden: false }).faces, 6 * 36 + 6 * 4);
});

test('merging keeps the surface, the shading and a watertight mesh', () => {
  // a lumpy shape with several colours, a glowing and a swaying voxel
  const g = new Grid(14, 10, 12);
  g.box(0, 0, 0, 13, 1, 11, 0x556b2f);
  g.box(2, 2, 2, 8, 6, 7, 0xb5651d);
  g.box(4, 7, 3, 6, 8, 6, 0x8b0000);
  g.box(10, 2, 9, 11, 5, 10, 0x2e8b57, 1);
  g.set(5, 4, 8, 0xffd27f, 0, KIND_GLOW);
  g.clear(5, 4, 2);
  const merged = meshGrid(g), plain = meshGrid(g, { greedy: false });
  assert.equal(merged.faces, plain.faces);
  assert.ok(merged.pos.length < plain.pos.length / 3, `expected far fewer vertices, got ${merged.pos.length / 3} of ${plain.pos.length / 3}`);
  assert.ok(Math.abs(area(merged) - area(plain)) < 1e-6);
  assert.ok(Math.abs(area(plain) - plain.faces) < 1e-6);
  assertWatertight(plain);
  assertWatertight(merged);
  // one glowing voxel, five open faces (the sixth touches the wall), four vertices each
  let glow = 0;
  for (let i = 3; i < merged.nrm.length; i += 4) glow += merged.nrm[i];
  assert.equal(glow, 5 * 4);
  // every shade of the plain mesh is still there (merged quads add the shade of their middle)
  const shades = (geo) => new Set(Array.from({ length: geo.col.length / 4 }, (_, i) => (geo.col[i * 4] << 16) | (geo.col[i * 4 + 1] << 8) | geo.col[i * 4 + 2]));
  const have = shades(merged);
  for (const c of shades(plain)) assert.ok(have.has(c), `shade ${c.toString(16)} is missing`);
});

test('stamp turns and recolours a model', () => {
  const model = new Grid(3, 2, 1);
  model.set(0, 0, 0, 0x111111); model.set(2, 1, 0, 0x222222);
  const g = new Grid(10, 10, 10);
  const box = g.stamp(model, [4, 0, 4], { rot: 1, paint: (c) => (c === 0x222222 ? { color: 0x333333, glow: true } : c) });
  assert.deepEqual(box, { x0: 4, y0: 0, z0: 4, x1: 4, y1: 1, z1: 6 });
  assert.equal(g.colorAt(4, 0, 4), 0x111111);
  assert.equal(g.colorAt(4, 1, 6), 0x333333);
  assert.equal(g.get(4, 1, 6), KIND_GLOW);
  assert.equal(g.count(), 2);
  assert.equal(groups(g, () => true).length, 2);
});

/** Every triangle's winding agrees with its stored normal (the engine culls the other side). */
function assertFacing(geo, outward = null) {
  const p = (i) => [geo.pos[i * 3], geo.pos[i * 3 + 1], geo.pos[i * 3 + 2]];
  for (let t = 0; t < geo.idx.length; t += 3) {
    const [a, b, c] = [p(geo.idx[t]), p(geo.idx[t + 1]), p(geo.idx[t + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const i = geo.idx[t] * 4, stored = [geo.nrm[i], geo.nrm[i + 1], geo.nrm[i + 2]];
    assert.ok(n[0] * stored[0] + n[1] * stored[1] + n[2] * stored[2] > 0, `triangle ${t / 3} is wound against its normal`);
    if (outward) {
      const m = [(a[0] + b[0] + c[0]) / 3 - outward[0], (a[1] + b[1] + c[1]) / 3 - outward[1], (a[2] + b[2] + c[2]) / 3 - outward[2]];
      assert.ok(n[0] * m[0] + n[1] * m[1] + n[2] * m[2] > 0, `triangle ${t / 3} faces inwards`);
    }
  }
}

test('shapes are wound the way their normals point', () => {
  const g = new Shapes();
  g.flat(0, 0, 2, 3, 1, 0x808080, { glow: true });
  g.box(-1, -1, -1, 1, 1, 1, 0x808080);
  g.poly([[0, 0, 5], [1, 0, 5], [1, 1, 5], [0, 1, 5]], [0xff0000, 0x00ff00, 0x0000ff, 0xffffff], { sway: 0.5 });
  const geo = g.build();
  assertFacing(geo);
  assert.equal(geo.pos.length / 3, 4 + 24 + 4);
  assert.equal(geo.nrm[1], 127, 'a flat strip faces up');
  assert.equal(geo.nrm[3], 1, 'and carries the glow flag');
  assert.deepEqual([...geo.col.slice(-16, -12)], [255, 0, 0, 128]);
  const box = new Shapes().box(-1, -1, -1, 1, 1, 1, 0x808080).build();
  assertFacing(box, [0, 0, 0]);
});

test('a sphere cap faces outwards', () => {
  const g = new Shapes();
  const n = sphereCap(g, { center: [0, -100, 0], r: 100, angle: 0.4, rings: 6, segments: 12, color: () => 0x3060a0 });
  assert.equal(n, 1 + 6 * 12);
  const geo = g.build();
  assertFacing(geo, [0, -100, 0]);
  assert.ok(Math.abs(geo.pos[1]) < 1e-4, 'its top is at the top of the sphere');
});

test('writes a file the engine can read', () => {
  const g = new Grid(4, 4, 4, 2, 0, 2);
  g.box(-2, 0, -2, 1, 1, 1, 0x7f7f7f);
  const s = new SceneWriter({ title: 'Test', credits: [{ title: 'Nothing', author: 'Nobody', license: 'CC0 1.0' }] });
  s.object({ mesh: s.addGrid('block', g), cast: true });
  s.manifest.water.mesh = s.addSurface('water', 1, [[-2, -2, 2, 2]]);
  s.groundFrom(g, { half: 4 });
  const { buf } = s.build();
  assert.equal(buf.toString('latin1', 0, 4), 'KUMO');
  const jsonLen = buf.readUInt32LE(8);
  const m = JSON.parse(buf.toString('utf8', 12, 12 + jsonLen));
  const binLen = buf.readUInt32LE(12 + jsonLen);
  assert.equal(buf.length, 16 + jsonLen + binLen);
  const vertices = m.meshes.reduce((n, x) => n + x.vertexCount, 0), indices = m.meshes.reduce((n, x) => n + x.indexCount, 0);
  assert.equal(binLen, vertices * 20 + indices * 4);
  assert.equal(m.ground.heights.length, 64);
  assert.equal(m.ground.heights[0], -999);
  assert.equal(m.ground.heights[2 * 8 + 2], 2);
  assert.equal(m.credits[0].author, 'Nobody');
  // every index stays inside its mesh
  const firstIndexByte = 16 + jsonLen + vertices * 20;
  for (const mesh of m.meshes) for (let i = 0; i < mesh.indexCount; i++) {
    assert.ok(buf.readUInt32LE(firstIndexByte + (mesh.firstIndex + i) * 4) < mesh.vertexCount);
  }
});
