# Scenes

Kumo's 3D scenes are made here and baked into `.kumo` files, which the engine only has to load.
Nothing in this folder runs inside Kumo.

```
pagoda/           the built-in Voxel Pagoda Garden (three.js generator, bakes assets/pagoda.kumo)
lib/              tools for new scenes, plain Node with no packages to install
  vox.mjs         reads MagicaVoxel .vox files
  grid.mjs        voxel grids and the mesher
  kumo.mjs        writes .kumo files
  parts.mjs       lit windows, snow, island rock, clouds
  models.mjs      loads third-party models and keeps their credits
  test.mjs        self-tests: node --test scenes/lib/test.mjs
metro/            Metro Block: a city block that lights up at night
village/          Autumn Village: houses round a green, a duck pond, falling leaves
winter/           Winter Square: a decorated tree, snow, warm windows
vox2kumo.mjs      one or more .vox models on a plate, as a .kumo scene
fetch-models.mjs  downloads the third-party models
models.json       which models, by whom, under which licence, with checksums
models/, out/     downloads and baked scenes (not in git)
```

## Baking the scenes

You need Node 20 or newer.

```powershell
node scenes/fetch-models.mjs     # once: 67 models, about 7 MB, into scenes/models/
node scenes/metro/bake.mjs       # scenes/out/metro-block.kumo
node scenes/village/bake.mjs     # scenes/out/autumn-village.kumo
node scenes/winter/bake.mjs      # scenes/out/winter-square.kumo
node scenes/pack.mjs             # assets/scenes/<id>.kumo.z, the copies that ship inside Kumo
```

These three scenes are built into Kumo (`BUILTIN` in `src/library.rs`). `pack.mjs` compresses each
baked file to about a fifth of its size, and `src/inflate.rs` unpacks it when the scene is first
shown, so they add about 3 MB to the program instead of 15. After baking, run `pack.mjs` and
rebuild Kumo; a test fails if the packed copies and `scenes/out` differ. A new built-in scene
also needs a 480x270 `assets/scenes/<id>-thumb.jpg`, made from a still rendered with `--shot`.

Each script takes another output path as its argument. Baking is deterministic: the same script
and models give the same file, byte for byte. To look at a scene without installing it:

```powershell
target\fast\kumo.exe --shot target\shots\metro.bmp --scene scenes\out\metro-block.kumo --size 2560x1440 --hour 21.5
```

`--hour` sets the time of day, `--warmup 40` lets the snow fall for 40 seconds first, and
`--rotate=10 --warmup 14` turns the camera to another side. To use a scene as your wallpaper,
drag the `.kumo` file into Kumo's window. `cargo test` loads every scene in `scenes/out` with
the engine's own reader.

## A MagicaVoxel model as a wallpaper

```powershell
node scenes/vox2kumo.mjs out.kumo model.vox [more.vox ...] --info
```

puts the models side by side on a plate under the pagoda garden's sky, and `--info` lists each
model's size and colours. It is the quickest way to check a model, and a start for a scene of
your own.

The reader takes `.vox` files of format version 150 and 200: models, palette, the scene graph
with its translations and rotations, and which palette entries are emissive (those voxels glow
at night). MagicaVoxel's z axis becomes Kumo's y. Layers, cameras and render settings are
ignored, and of an animation only the first frame is used.

## Writing a scene

A scene script fills a voxel grid, by hand or by stamping models into it, and hands it to the
writer. The three scripts here are meant to be read and copied from. The core of each:

```js
import { Grid } from '../lib/grid.mjs';
import { SceneWriter } from '../lib/kumo.mjs';
import { Models } from '../lib/models.mjs';

const models = new Models('mmmm');                // the pack, as named in models.json
const world = new Grid(200, 80, 200, 100, 4, 100); // size, then where (0, 0, 0) sits inside
world.box(-100, -4, -100, 99, -1, 99, 0x5c9a48);   // ground
world.stamp(models.get('obj_house4'), [0, 0, 0], { center: true, rot: 1 });

const s = new SceneWriter({ title: 'My scene' });
s.object({ mesh: s.addGrid('world', world, { scale: 0.3 }), cast: true });
s.manifest.credits = [models.credit('Converted from MagicaVoxel models to meshes.')];
s.write('my.kumo');
```

`stamp` takes a `paint` function to recolour voxels, make them glow or sway in the wind as they
are placed. `lightWindows` (in `parts.mjs`) lights some of a model's windows. Lamps get a halo
with `s.glow(...)` and real light with `s.light(...)`. Water is `s.addSurface(...)`, a waterfall
`s.addWaterfall(...)`, and falling leaves or snow are `manifest.petals` with their own colours.

### What the mesher does

`meshGrid` turns a grid into Kumo's vertices (20 bytes each: position, normal and a glow flag,
colour with ambient occlusion baked in, wind sway).

* **Merging.** Flat areas of one colour become one large quad (greedy meshing). A face with an
  ambient-occlusion gradient is merged only in the direction in which its shade stays the same,
  so the picture does not change: a test set of ten buildings went from 601,560 vertices to
  58,316, and 3,509 of 2 million pixels differed, mostly by one step of brightness.
* **Hidden rooms.** Faces that the outside cannot reach are dropped. Many models are solid or
  have closed rooms inside.
* **No seams.** Where a large quad meets the corners of smaller neighbours, those corners are
  added to it. Without that, single pixels of sky flicker through the seams.

### What the engine can show

The `.kumo` format did not change for these scenes. A scene has, at most: four point lights;
1024 sprites for waterfall spray (always 160), fireflies and halos together; one water surface
and one waterfall, which falls towards +x; 20,000 petals in up to five colours. Objects can bob
or circle the middle of the scene, and the camera always circles it too, so a scene is seen
from every side.

The built-in scene has 193,422 vertices. Stay near that: memory is what Kumo is for.

| Scene | File | Vertices | Private working set, day / night | GPU 3D load, day / night |
|---|---|---|---|---|
| Voxel Pagoda Garden (built in) | 4.85 MB | 193,422 | 63 / 63 MB | 4.1 / 5.3 % |
| Metro Block | 4.70 MB | 178,278 | 63 / 63 MB | 4.1 / 6.0 % |
| Autumn Village | 4.55 MB | 171,631 | 63 / 63 MB | 4.9 / 5.6 % |
| Winter Square | 4.86 MB | 186,030 | 63 / 63 MB | 4.1 / 5.6 % |

Measured on 22 November 2026 with `kumo.exe --window --size 1920x1080` (the `fast` build) on an
Intel Iris Xe laptop running on battery, where Kumo draws 15 frames a second; day is `--hour 13`,
night `--hour 22`, when lamps and point lights are on. Memory is the private working set from
`--stats`, GPU load the 3D engine's share from Windows' performance counters over 20 seconds.
Each scene also held 64 MB of the graphics card's shared memory, the same as the built-in one.

## Credits and licences

Only models under public domain, CC0 or CC BY 4.0 may be used, the same rule as for the online
catalogue (see [docs/discover.md](../docs/discover.md)).

* `models.json` is the record: every model a scene may use, with its pack's author, source,
  licence, the exact commit it was taken from, and the file's SHA-256. A bake stops if a model is
  not on the list or its file differs. `node scenes/fetch-models.mjs --add <pack> <model>` puts
  another model of a pack on the list. Read the licence before adding a new pack.
* Every baked scene carries its credits in the manifest, under `credits`: for each pack the
  title, author, source, licence, what was changed, and the names of the models used.
* `assets/third-party-notices.txt`, which Kumo shows under *About Kumo*, names the packs too.
  `python tools/third_party.py` writes that part from `models.json`.

The three scenes use 67 models from **Mini Mike's Metro Minis** by Mike Judge
(<https://github.com/mikelovesrobots/mmmm>), under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The models were converted to meshes,
recoloured in places (lit windows, autumn leaves, snow) and arranged into scenes. Everything else
in the scenes (islands, ground, the tower, pond, ducks, snowmen) is generated by the scripts.
