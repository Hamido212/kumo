// Third-party models for the scenes, and the record of where each one comes from.
//
// scenes/models.json lists every model a scene may use: its pack (author, source, licence, the
// exact commit) and the SHA-256 of the file. The files themselves are not in this repository;
// `node scenes/fetch-models.mjs` downloads them into scenes/models/ (ignored by git). A scene
// script asks for a model by name and gets a voxel grid; a model that is not on the list, or
// whose file differs from the list, stops the bake.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVox } from './vox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LIST = join(ROOT, 'models.json');
export const modelPath = (pack, name) => join(ROOT, 'models', pack, `${name}.vox`);
export const readList = () => JSON.parse(readFileSync(LIST, 'utf8'));
export const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export class Models {
  constructor(pack) {
    this.pack = pack;
    this.info = readList()[pack];
    if (!this.info) throw new Error(`scenes/models.json has no pack "${pack}"`);
    this.cache = new Map();
  }

  /** The model as a grid (y up, one unit per voxel). Do not change it: take a clone() first. */
  get(name) {
    let g = this.cache.get(name);
    if (g) return g;
    const want = this.info.files[name];
    if (!want) throw new Error(`model "${name}" is not listed in scenes/models.json. Add it with: node scenes/fetch-models.mjs --add ${this.pack} ${name}`);
    const path = modelPath(this.pack, name);
    if (!existsSync(path)) throw new Error(`${path} is missing. Download the models with: node scenes/fetch-models.mjs`);
    if (sha256(path) !== want) throw new Error(`${path} is not the file scenes/models.json lists (different SHA-256)`);
    g = loadVox(path);
    this.cache.set(name, g);
    return g;
  }

  /** The credit for the scene's manifest: the pack, the licence and the models actually used. */
  credit(changes) {
    const { title, author, source, license, licenseUrl, attribution } = this.info;
    return { title, author, source, license, licenseUrl, attribution, changes, models: [...this.cache.keys()].sort() };
  }
}
