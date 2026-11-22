// Packs the baked scenes that ship inside Kumo: scenes/out/<id>.kumo -> assets/scenes/<id>.kumo.z
// (the unpacked size as u32, little endian, then a raw deflate stream; src/inflate.rs reads it).
// Run after baking, then rebuild Kumo:  node scenes/pack.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateRawSync, inflateRawSync, constants } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// the ids src/library.rs lists as built in
const ids = ['metro-block', 'autumn-village', 'winter-square'];

mkdirSync(join(root, 'assets', 'scenes'), { recursive: true });
for (const id of ids) {
  const scene = readFileSync(join(root, 'scenes', 'out', `${id}.kumo`));
  const body = deflateRawSync(scene, { level: constants.Z_BEST_COMPRESSION });
  if (!inflateRawSync(body).equals(scene)) throw new Error(`${id}: does not unpack to the same bytes`);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(scene.length);
  writeFileSync(join(root, 'assets', 'scenes', `${id}.kumo.z`), Buffer.concat([head, body]));
  console.log(`${id}: ${(scene.length / 1e6).toFixed(2)} MB -> ${(body.length / 1e6).toFixed(2)} MB`);
}
