// Turns MagicaVoxel models into a simple .kumo scene: the models stand side by side on a plate
// under the pagoda garden's sky. For a quick look at a model, or as a start for a scene script.
//
//   node scenes/vox2kumo.mjs out.kumo model.vox [more.vox ...] [--info] [--plain]
//
//   --info    also print each model's size and its colours (palette index, colour, voxel count)
//   --plain   bake without merging faces, to compare
//   --angle=0.55 --elev=0.3   where the camera stands (radians); it does not circle
//
// Then:  target\fast\kumo.exe --shot out.bmp --scene out.kumo --size 1920x1080 --hour 12

import { basename } from 'node:path';
import { Grid } from './lib/grid.mjs';
import { loadVox } from './lib/vox.mjs';
import { SceneWriter } from './lib/kumo.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const number = (name, fallback) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? +a.split('=')[1] : fallback; };
const [out, ...files] = args.filter((a) => !a.startsWith('--'));
if (!out || !files.length) {
  console.error('usage: node scenes/vox2kumo.mjs out.kumo model.vox [more.vox ...] [--info] [--plain]');
  process.exit(2);
}

const models = files.map((f) => ({ name: basename(f), grid: loadVox(f) }));
if (flags.has('--info')) {
  for (const { name, grid } of models) {
    const seen = new Map();
    grid.each((x, y, z, c, i) => { const k = grid.index[i]; seen.set(k, [c, (seen.get(k)?.[1] || 0) + 1]); });
    console.log(`${name}: ${grid.sx} wide, ${grid.sy} high, ${grid.sz} deep, ${grid.count()} voxels`);
    console.log('  ' + [...seen].sort((a, b) => b[1][1] - a[1][1]).map(([k, [c, n]]) => `${k}:#${c.toString(16).padStart(6, '0')}x${n}`).join(' '));
  }
}

// rows of models, about as wide as deep
const gap = 4;
const total = models.reduce((n, m) => n + m.grid.sx + gap, 0);
const rowWidth = Math.max(Math.sqrt(total * (Math.max(...models.map((m) => m.grid.sz)) + gap)), Math.max(...models.map((m) => m.grid.sx)) + gap);
let x = 0, z = 0, depth = 0, width = 0, height = 0;
const spots = [];
for (const m of models) {
  if (x && x + m.grid.sx > rowWidth) { x = 0; z += depth + gap; depth = 0; }
  spots.push([x, z]);
  x += m.grid.sx + gap;
  width = Math.max(width, x); depth = Math.max(depth, m.grid.sz); height = Math.max(height, m.grid.sy);
}
depth += z;
const world = new Grid(width + gap, height + 2, depth + gap, 0, 2, 0);
world.box(0, -2, 0, width + gap - 1, -1, depth + gap - 1, (px, py, pz) => (((px >> 3) + (pz >> 3)) & 1 ? 0x8a8f98 : 0x7f848d));
models.forEach((m, i) => world.stamp(m.grid, [spots[i][0] + gap, 0, spots[i][1] + gap]));

// one unit per voxel, the world centred on the origin and sized so that it fills the picture
const span = Math.max(width + gap, depth + gap, height * 1.6);
const scale = 100 / span;
const offset = [-(width + gap) / 2 * scale, 0, -(depth + gap) / 2 * scale];
const s = new SceneWriter({ title: models.map((m) => m.name).join(', ') });
s.object({ mesh: s.addGrid('models', world, { scale, offset, greedy: !flags.has('--plain') }), cast: true });
s.manifest.camera.target = [0, height * scale * 0.4, 0];
const fixed = args.some((a) => a.startsWith('--angle='));
Object.assign(s.manifest.camera, { angle: number('angle', 0.55), elev: number('elev', 0.3), orbitSpeed: fixed ? 0 : 0.028 });
s.manifest.shadow.target = [0, height * scale * 0.4, 0];
s.manifest.shadow.extent = 80;
s.write(out);
