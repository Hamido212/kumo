// Downloads the third-party models listed in scenes/models.json into scenes/models/<pack>/ and
// checks each file against its SHA-256. Files that are already there and correct are kept.
//
//   node scenes/fetch-models.mjs                       download what is missing
//   node scenes/fetch-models.mjs --add mmmm obj_tree1  put more models of a pack on the list
//
// Only add models whose licence you have read: the list is Kumo's record of what a scene uses.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { LIST, modelPath, readList, sha256 } from './lib/models.mjs';
import { parseVox } from './lib/vox.mjs';

const list = readList();
const args = process.argv.slice(2);

async function download(pack, name) {
  const url = list[pack].files_url.replace('{name}', name);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  parseVox(bytes); // a .vox file and nothing else
  return bytes;
}

if (args[0] === '--add') {
  const [, pack, ...names] = args;
  if (!list[pack] || !names.length) { console.error('usage: node scenes/fetch-models.mjs --add <pack> <model> [more ...]'); process.exit(2); }
  for (const name of names) {
    const path = modelPath(pack, name);
    if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, await download(pack, name)); }
    list[pack].files[name] = sha256(path);
    console.log(`added ${pack}/${name}`);
  }
  list[pack].files = Object.fromEntries(Object.entries(list[pack].files).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(LIST, JSON.stringify(list, null, 2) + '\n');
} else {
  let fetched = 0, kept = 0;
  for (const [pack, info] of Object.entries(list)) {
    for (const [name, want] of Object.entries(info.files)) {
      const path = modelPath(pack, name);
      if (existsSync(path) && sha256(path) === want) { kept++; continue; }
      const bytes = await download(pack, name);
      const got = createHash('sha256').update(bytes).digest('hex');
      if (got !== want) throw new Error(`${pack}/${name}: the download does not match scenes/models.json (SHA-256 ${got})`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      fetched++;
    }
    console.log(`${pack}: ${info.title} by ${info.author}, ${info.license}`);
  }
  console.log(`${fetched} downloaded, ${kept} already there`);
}
