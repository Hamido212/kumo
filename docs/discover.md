# Discover: the online wallpaper catalogue

Kumo's *Discover* tab shows wallpapers that are free to use and lets you add one to your library
with a click. This page explains where they come from, which rules decide what gets in, and how to
look after the catalogue.

## How it works

* The catalogue is one static file, `site/catalog/v1/catalog.json`, deployed with the website as
  `https://kumo.hyos.tech/catalog/v1/catalog.json`. We host this index, and a mirror of freely
  licensed desktop art in a public GitHub repository (see [Our own mirror](#our-own-mirror)).
* Nothing is fetched before you open Discover and agree. Then Kumo loads the index, shows the
  previews, and on a click downloads the file **directly from the source's own server** (NASA, a
  museum, ESA, ESO), or for mirrored files from GitHub, into the local library, the same as a file
  you drag in.
* Kumo downloads over https only, and only from a fixed list of hosts built into the app:
  `kumo.hyos.tech`, `cdn.kumo.hyos.tech`, `svs.gsfc.nasa.gov`, `openaccess-cdn.clevelandart.org`,
  `cdn.esahubble.org`, `cdn.esawebb.org`, `cdn.eso.org`, `raw.githubusercontent.com`. The tool
  checks against the same list (`ALLOWED_HOSTS`), and on `raw.githubusercontent.com` accepts only
  files of our mirror repository. A URL on any other host, after redirects too, is refused. Kumo
  1.1.0 does not know the GitHub host yet and skips mirrored items; later versions show them.
  Size caps: preview 8 MB, picture 80 MB, video 500 MB, 3D scene 50 MB.
* Each wallpaper shows its title, author, source and licence, with links to the work's page and
  the licence text, in the app and in the library afterwards.
* The website answers with `Cache-Control: public, max-age=300, must-revalidate`
  (`site/vercel.json`), so a removed item disappears from apps within minutes.

## The format, version 1

```json
{
  "version": 1,
  "updated": "2026-11-22",
  "categories": [ { "id": "space", "title": { "en": "Space", "de": "Weltraum" } } ],
  "items": [ {
    "id": "cma-1948-306",
    "title": "Driving Rain at Shōno, from Fifty-Three Stations of the Tokaidō",
    "author": "Utagawa Hiroshige (Japanese, 1797–1858)",
    "kind": "image",
    "category": "japan",
    "source": "The Cleveland Museum of Art",
    "sourceUrl": "https://clevelandart.org/art/1948.306",
    "license": "CC0 1.0",
    "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
    "credit": "“Driving Rain at Shōno, …”, 1833, Utagawa Hiroshige (Japanese, 1797–1858). The Cleveland Museum of Art, …. CC0 1.0.",
    "thumb": "https://openaccess-cdn.clevelandart.org/1948.306/1948.306_web.jpg",
    "file": "https://openaccess-cdn.clevelandart.org/1948.306/1948.306_print.jpg",
    "bytes": 3611531, "width": 3400, "height": 2270,
    "duration": 0, "codec": "",
    "sha256": "", "revoked": false
  } ]
}
```

| Field | Meaning |
|---|---|
| `id` | `[a-z0-9-]{1,64}`, unique and stable: source prefix plus the source's own number (`svs-`, `cma-`, `esahubble-`, `esawebb-`, `eso-`; `met-` and `smk-` for the sources that are switched off; mirrored pictures: `kde-`, `popos-`, `cosmic-`, `fedora-`, `ubuntu-` plus a name) |
| `kind` | `image`, `video` or `scene` (see [3D scenes](#3d-scenes) below) |
| `category` | one of the `categories` ids: `space`, `nightsky`, `earth`, `japan`, `landscape`, `desktop`, `photo`, `loops`, `scenes` |
| `thumb`, `file` | https URLs on the app's host list, checked with a HEAD request at build time (mirror items: against the local copy with `--mirror-local` until they are published) |
| `bytes`, `width`, `height` | from the server's `Content-Length` (mirror items: from `items.json`); the pixel size from the source's data or from the JPEG's own header (see below); 0 for scenes |
| `duration`, `codec` | videos only: seconds (0 until a `--hash` run measures it) and `h264`, `hevc`, `vp9` or `av1` |
| `sha256` | empty, or the file's hash after a `--hash` run; always filled in for mirror items; the app checks it when present |
| `revoked` | `true` keeps the id known after a takedown, so apps can remove downloaded copies |

The app ignores fields it does not know, so new fields can be added without a new version. A
change that old apps would misread gets a new path (`/catalog/v2/`), and `v1` stays online.

## What gets in, and why

**Licences: public domain, CC0 1.0, CC BY 4.0, CC BY-SA 4.0, and MIT (or another permissive
software licence) where the artwork's own author applied it.** Nothing with NonCommercial (NC) or
NoDerivatives (ND), no Creative Commons licence older than 4.0, nothing "free for personal use",
nothing without a clear licence. The reasons:

* Kumo is under the GPL, which lets anyone redistribute it, including commercially. NonCommercial
  content would not travel with it.
* The publisher is in Germany, so German and EU law apply, not just the licence a museum states.
* It keeps a Microsoft Store listing possible: the Store asks that the publisher holds the rights to
  all content an app shows (policy 11.2).

**Why CC BY-SA 4.0 and MIT artwork are accepted now, and CC 3.0 is not.** The first catalogue only
linked to files on the sources' servers. Desktop art from open-source projects (KDE, Fedora, Pop!_OS,
Ubuntu) mostly comes under CC BY-SA 4.0, and has no server that a wallpaper app could use, so we
mirror it (see [Our own mirror](#our-own-mirror)). ShareAlike asks nothing of Kumo itself: the
pictures are separate files that keep their licence, and the few changes we make (scaling down to
3840 pixels, converting to JPEG, removing metadata) are named in the credit and stay under the same
licence. Kumo is free and carries no advertising, which removes the last commercial question. MIT
and similar licences count only when the artwork's author applied them; a repository licence that
covers a project's code does not cover pictures its maintainers collected elsewhere. Licences 2.x
and 3.0 end automatically at the first mistake in attribution, and in Germany rights holders have
claimed damages for exactly such slips; version 4.0 gives 30 days to correct them (section 6(b)).
So 3.0 works stay out even when the rest looks fine, and so do files whose licence statement does
not name them exactly.

**EU copyright term.** A work is only taken when its creator died more than 70 years ago, that is
before 1956 in 2026, and the source's own data gives the death year. Unknown or later death year:
the work is skipped, with one exception: when no death year is known (anonymous and workshop
pieces), a work whose latest possible creation year is 1850 or earlier is taken, because no
copyright can still run on it; undated works are still skipped. A museum's CC0 flag alone is not enough for a German publisher, because US
museums apply US rules (publication before 1930), and a painter who died in 1960 is still protected
in the EU. NASA, ESA and ESO material is covered by its own licence instead.

**Family-friendly.** The Store's age rating applies to content an app downloads. The tool drops
anything whose title, description, tags or classification suggests nudity or erotica (shunga),
violence, war, death, religious martyrdom, medical subjects or identifiable living people. For
NASA it also drops astronauts, crews, portraits, logos and insignia, anything with music or
narration, and pages whose credits name other rights holders. Word lists cannot see the picture, so
a person looks through every build (see below).

**A good wallpaper.** At least 1920 pixels wide, landscape with an aspect ratio between 1.3 and
2.4, not a part of a larger object (one panel of a screen, one section of a handscroll; an album
leaf counts as a complete picture when the museum's record calls it one), a real title. From
museums only paintings, prints and drawings (no bound volumes, portfolios, photographs or objects),
and Western prints and drawings only in colour media (colour print, watercolour, gouache, pastel,
oil): black-and-white etchings and pencil drawings sit small on a large pale sheet. Items that
were already published stay when such a taste rule is tightened later; the exclusion list removes
them by hand.
Pictures have at most 40 megapixels: Kumo scales every picture to the screen anyway, and decoding a
huge (especially progressive) JPEG can take hundreds of MB, which would break Kumo's low-memory
promise. `check` enforces this too.
Videos: one file per page, H.264 MP4 at 1920x1080 first, 4K only when there is no 1080p, never a
version with labels, dates or captions burnt in. HEVC needs a Windows extension, so H.264 wins.

**Credit.** Every item carries a complete credit line with title, author, source and licence.
For CC BY images the credit is the image's own line from its page (for example "NASA, ESA, CSA,
STScI; J. DePasquale, A. Koekemoer, A. Pagan (STScI)" or "ESO/B. Tafreshi"), full and unaltered,
as ESA and ESO ask, followed by "ESA/Hubble", "ESA/Webb" or "ESO" and "CC BY 4.0". Mirrored
pictures name the author as the source names them, the source with a link, the licence, and what
we changed ("Changes: resized from 5120x2880 to 3840x2160, converted from PNG to JPEG (quality
88), metadata removed.").

## Sources

| Source | Licence | What we take | Credit shown |
|---|---|---|---|
| [NASA Scientific Visualization Studio](https://svs.gsfc.nasa.gov) | Public domain (NASA media guidelines) | calm visualisations: Earth, clouds, aurora, oceans, Sun, Moon, nebula fly-throughs | title, the page's credit, "NASA's Scientific Visualization Studio", link |
| [The Cleveland Museum of Art](https://www.clevelandart.org/open-access) | CC0 1.0 | Japanese woodblock landscapes, Western, Japanese and Chinese landscape painting, colour prints and watercolours (`images.print`, about 3400 px) | title, date, artist, museum, credit line |
| [ESA/Hubble](https://esahubble.org/copyright/) | CC BY 4.0 | hand-picked images, see the variant order below | the image's credit line, "ESA/Hubble, CC BY 4.0" |
| [ESA/Webb](https://esawebb.org/copyright/) | CC BY 4.0 | hand-picked images, see the variant order below | the image's credit line, "ESA/Webb, CC BY 4.0" |
| [ESO](https://www.eso.org/public/copyright/) | CC BY 4.0 | nebulae, galaxies and star clusters (Space), and photographs of the Paranal, La Silla, ALMA and APEX sites under the night sky (Night sky); candidates from ESO's Top 100 and archive categories | the image's credit line, unaltered, "ESO, CC BY 4.0", link |
| [KDE Plasma wallpapers](https://invent.kde.org/plasma/plasma-workspace-wallpapers) and the current default in [Breeze](https://invent.kde.org/plasma/breeze/-/tree/master/wallpapers/Next) (mirrored) | CC BY-SA 4.0, as each wallpaper's `metadata.json` states | every wallpaper whose `metadata.json` says `CC-BY-SA-4.0`, light and dark variants; the LGPL-3 ones stay out | title and author from `metadata.json`, "KDE Plasma wallpapers", link, CC BY-SA 4.0, changes |
| [Pop!_OS wallpapers](https://github.com/pop-os/wallpapers) (mirrored) | CC BY-SA 4.0 for the works the README lists under Kate Hazen (designed for System76) and Nick Nazzaro (commissioned by System76) | those works without the Pop!_OS logo, slogans or mascots; never the Unsplash photos | author, "Pop!_OS wallpapers (System76)", link, CC BY-SA 4.0, changes |
| [COSMIC wallpapers](https://github.com/pop-os/cosmic-wallpapers) (mirrored) | CC BY 4.0 for the files the README marks "Source: System76" | System76's own picture, not the logo or the NASA/ESA pictures | "System76", link, CC BY 4.0, changes |
| [Fedora backgrounds](https://github.com/fedoradesign/backgrounds) (mirrored) | CC BY-SA 4.0 (`Attribution` file of each release tag, and the package spec) | the default wallpapers of Fedora 33 to 43, day and night where they differ | "Fedora Design Team", release, link, CC BY-SA 4.0, changes |
| [Ubuntu wallpapers](https://launchpad.net/ubuntu/+source/ubuntu-wallpapers) (mirrored) | per file in `debian/copyright`; we take the CC-BY-SA-4.0 and CC0 entries only | community contest pictures whose file name the entry names exactly; no Canonical release artwork, no release mascots or logos, no Unsplash downloads, no 2.0 or 3.0 entries | title and author from the file name, "Ubuntu wallpapers", link, CC BY-SA 4.0, changes |

**Fedora's licence files** disagree in one place: the `Attribution` file of every release tag, the
repository's `COPYING` (the full CC BY-SA 4.0 International text) and the package spec
(`License: CC-BY-SA-4.0`) all say 4.0, but `default/CC-BY-SA-4.0` holds the 3.0 Unported legal
code under a "4.0" heading. We follow the three statements that name 4.0 with its URL; if the
Fedora Design Team ever says otherwise, the Fedora items go.

For ESA and ESO images the tool takes the 3840x2160 desktop wallpaper (`wallpaper_uhd`) if the
site made one; else the larger of the publication JPEG and the large JPEG that is landscape, at
least 1920 wide and at most 40 megapixels; else nothing.

**Pixel sizes from the file header.** The image pages state the original's size but not the size
of the publication JPEG. So the tool asks the server for the first 64 KB of each candidate JPEG (an
HTTP range request) and reads the width and height from the JPEG frame header (the SOF marker),
which sits near the start of the file. That is not a download of the picture. If the range request
is refused or the header is not within 64 KB, it uses what the page states. The results are cached
with the HEAD results.

**ESO's terms** (https://www.eso.org/public/copyright/): the full credit line, unaltered, with a
link; no identifiable people; and for videos a burnt-in credit, so the catalogue takes no ESO
videos. The tool skips ESO's categories for illustrations, people and events, premises, the ELT,
exoplanets, cosmology, black holes, the Solar System, full-dome and 360-degree panoramas, drops
titles that name an illustration, chart, building, event or equipment, drops pictures whose title
or first sentence names people, and takes a site photograph only when its title or caption speaks
of the night sky. ESO makes no 16:9 crops, so the shape the listing states decides before the page
is fetched.

**The Met** (CC0, open access) is in the tool but switched off: its API answers normally, but
`images.metmuseum.org` answers automated requests with a bot-protection web page instead of the
picture (November 2026). The app would meet the same page, and the host is not on the app's list,
so Met items need our own file mirror first. `python tools/catalog.py build --only met` still runs
it. The API also has no pixel sizes, so the tool only takes Met items in a `--hash` run, which
reads the size from the file.

**SMK, Statens Museum for Kunst** (public domain, Public Domain Mark 1.0; Danish Golden Age and
German Romantic landscapes) is in the tool but switched off too. Its pictures come from a IIIF
server, `iip.smk.dk`, that renders every file on demand: previews took 0.5 to 6 seconds each and
varied from request to request, and some 3840 px files sent no headers within 120 seconds. That is
too slow and unreliable for downloads at runtime, and the rendered file may not stay
byte-identical, which would break the exact `bytes` check. SMK items need our own file mirror
first; `python tools/catalog.py build --only smk` still runs it (it asks for 3840 px wide files and
800 px previews from `iip.smk.dk`, not the `iip-thumb.smk.dk` previews its API names).

### Examined and rejected

* **Reddit** (r/wallpaper and similar): the API is closed to commercial use and being shut down, and posters rarely own what they post.
* **Wallhaven, MoeWalls, MotionBGs, DesktopHut:** no rights to the uploads they host.
* **Steam Workshop:** the Subscriber Agreement limits Workshop items to use with Steam.
* **Pexels, Pixabay, Unsplash:** their terms forbid using the content in a wallpaper app as such.
* **Mixkit, Freepik:** no redistribution of the files.
* **Omarchy** (github.com/basecamp/omarchy, MIT): the MIT licence covers what the project's authors
  own, and no theme background has a record that it was made by or for the project and licensed by
  its author. We traced every background through the git history, pull requests and the theme
  authors' own repositories (November 2026): community pull requests add pictures found elsewhere
  without a source (issue #617 asked for "backgrounds that match", nothing about rights), one theme's
  README shows wallpaper-site file names, several are AI-upscaled or AI-reworked copies of other
  works, the Starship theme says its SpaceX photographs are not covered by MIT, and others show
  third-party property (Severance's Lumon, Totoro, an Audi quattro with its logos, a Hopper
  painting). None is mirrored.
* **GNOME backgrounds:** the module's `COPYING` says CC BY-SA 3.0 United States, and authors are
  named only inside the image files. Left out while 3.0 is excluded.
* **Unsplash photos inside distribution packages** (Pop!_OS, Ubuntu's `Unsplash` entries and its
  CC0 entries that are Unsplash downloads, elementary OS): the Unsplash licence, or an old Unsplash
  CC0 grant we cannot check with the photographer.
* **Release mascots and logos** in KDE, Pop!_OS, COSMIC and Ubuntu artwork: brand marks as the
  subject, whatever the licence of the picture.
* **Budgie backgrounds** (CC0): the repository does not record per file who made each photo and
  where it came from, which its own rules ask of submitters. Not taken for now.
* **KDE wallpapers under LGPL-3** and **Ubuntu entries under CC BY-SA 2.0/3.0 or CC BY 2.0**: not on
  the licence list.

## Our own mirror

Some good free sources have no server a wallpaper app may use, so we host their files ourselves in
the public GitHub repository [Hamido212/kumo-wallpapers](https://github.com/Hamido212/kumo-wallpapers)
(branch `main`). Kumo downloads them from `https://raw.githubusercontent.com/Hamido212/kumo-wallpapers/main/<path>`.

* `pictures/<source>/<id>.jpg` (or `.png` for flat art where that is smaller), a 480x270 preview at
  `thumbs/pictures/<id>.jpg`, and `pictures/items.json` with every fact the catalogue needs: title,
  author, source and its page, licence and its page, the full credit line, the changes we made,
  category, pixel size, bytes, sha256, the file and preview paths, the original's URL, size and
  hash, and where we read the licence. `loops/` (videos) and `scenes/` (`.kumo` 3D scenes) follow
  the same pattern with their own `items.json`.
* `CREDITS.md` lists every file with title, author, source, licence and changes; `LICENSES/` has
  the full licence texts; `README.md` says that every file keeps its own licence and how to report
  a problem.
* **Rules for a mirrored picture:** a licence from the list above, read on the source's own licence
  file or page for that exact file; the content rules of the catalogue (no people, logos, brand
  marks, mascots or slogans as the subject, no text-heavy pictures, family-friendly); landscape,
  at least 1920 px wide, aspect 1.3 to 2.4. Originals wider than 3840 px are scaled down with a
  Lanczos filter, saved as a baseline JPEG at quality 88 (no progressive JPEG, for Kumo's memory),
  or as PNG for flat art where that is smaller, without metadata, never above 6 MB. A person looks
  at every picture before it goes in.
* The first set (November 2026): 108 pictures, about 114 MB with previews: KDE 30, Fedora 19,
  Pop!_OS 8, COSMIC 1 and Ubuntu 50, in the categories `desktop` (70) and `photo` (38).
* GitHub serves files of this repository only as long as they are plain files: no Git LFS (raw
  links would return the LFS pointer), and no file above GitHub's limit of 100 MB.
* The catalogue item carries `bytes` and `sha256`, so the app refuses a file that changed. A
  changed picture gets a new file name.

**Adding a mirrored picture:** check the licence on the source's own file or page, add a record
to `tools/mirror-pictures.json` (id with the source prefix, title, author, source page, licence,
licence page, where you read the licence, the download URL of the original, category, `flat` for
flat art), then:

```powershell
python tools/mirror_pictures.py fetch                          # the original, once, into target/mirror-src/
python tools/mirror_pictures.py build --mirror ..\kumo-wallpapers   # file, preview, items.json, CREDITS.md, LICENSES/
```

Look at the new preview, commit and push the mirror repository, wait until the file answers on
`raw.githubusercontent.com`, then build the catalogue (below). `mirror_pictures.py` needs Pillow,
and ffmpeg for JPEG XL originals.

**Before the files are published** the catalogue cannot check their URLs. `python tools/catalog.py
build --only mirror --mirror-local --out target/catalog-with-mirror.json` checks each mirror item
against the local copy instead (the file is there, has the size and sha256 of its record and the
type of its kind) and writes the would-be catalogue without touching `site/`. After publishing, a
normal `build` checks the mirror's URLs on GitHub like every other source's.

## Building the catalogue

```powershell
python tools/catalog.py build            # collect, filter, verify, write site/catalog/v1/catalog.json
python tools/catalog.py check            # validate the file offline (the build does this too)
```

`build` asks each source's API, applies the rules above, checks every preview and file with a
HEAD request (final status 200, final host on the app's list, a picture or video type, a
`Content-Length` under the cap) and prints, per source, how many items it kept and why it dropped
the rest. It exits with an error if the result breaks a format rule. Output is deterministic:
sorted by category, source and id, and `updated` changes only when the items do.

The tool is polite: one request at a time with a pause, `429` and `Retry-After` honoured, and every
API answer and HEAD result cached in `target/catalog-cache/`, so a second run asks nothing again
(`--refresh` ignores the cache). It sends `KumoCatalog/1.0 (+https://kumo.hyos.tech)` as its
User-Agent unless `--user-agent` says otherwise. It never downloads a picture or video unless asked:

* `--hash` downloads every file once to fill in `sha256`, and for videos the real codec and length.
* `--thumbs DIR` downloads every preview and writes `DIR/<id>.jpg` at 480x270, for hosting previews
  ourselves later (needs Windows for the picture scaling).
* `--only NAME` rebuilds one source and keeps the others from the last build.
* `--mirror DIR` names the local copy of the kumo-wallpapers repository (default:
  `../kumo-wallpapers` next to this repository). Without it on the machine, the build keeps the
  mirror items of the last catalogue.
* `--mirror-local` checks mirror items against that local copy instead of GitHub.
* `--out FILE` writes the catalogue somewhere else than `site/catalog/v1/catalog.json`.
* `check FILE --mirror-local [--mirror DIR]` also compares the mirror items of a catalogue file
  with the local copy (file and preview present, size and sha256 equal).

### The review pass

Every build writes `target/catalog-review.html`, a contact sheet with each preview (loaded from the
source, or from the local copy for mirror items checked with `--mirror-local`), its title, credit,
id, size and codec. Look through it before deploying: a word list does
not see what a picture shows, a video can have a title card, and a museum photo can show a frame or
a mount instead of the work.

## Adding or removing an item

* **Remove:** add its id to `tools/catalog-exclude.txt` with a short reason and the date, build,
  deploy.
* **Add a single item** from a source that is already there: for ESA, add the image id to `IDS` in
  `EsaHubble` or `EsaWebb`; for ESO, add a listing to `LISTINGS`; for the others, add a search to
  the source's `SEARCHES`; for a mirrored picture see [Our own mirror](#our-own-mirror). The rules
  apply as to everything else.
* **Add a source:** write a small `Source` class in `tools/catalog.py` with a `candidates()` method
  that yields items, add it to `SOURCES`, and add its media hosts to the app's host list (in
  `src/catalog.rs`) and to `ALLOWED_HOSTS` in the tool. Check its licence and terms first, and add a
  line to the table above.

## Takedown requests

1. Remove the item at once: add `<id> revoked` to `tools/catalog-exclude.txt`, build and deploy.
   The entry stays in the catalogue with `"revoked": true`, so apps stop offering it and can remove
   copies they downloaded. Because of the short cache time this takes effect within minutes.
2. **For a mirrored file** also delete the file and its preview from the kumo-wallpapers repository,
   remove its record from the folder's `items.json` and its line from `CREDITS.md` (for pictures:
   remove it from `tools/mirror-pictures.json` and run `mirror_pictures.py build`, which rewrites
   both; delete the file and preview by hand), and push. The catalogue item stays, marked revoked
   by step 1. Deleting the file stops new downloads even in apps that still have an old catalogue.
   The file remains in the repository's git history; if the claim asks for that too, rewrite the
   history and ask GitHub to drop cached views.
3. Answer the sender within 72 hours, from the contact address in the
   [Impressum](https://kumo.hyos.tech/impressum) (`hello@hyos.tech`): what was removed and when.
4. If the claim is unclear, keep the item removed while you check it with the source.

## 3D scenes

3D scenes are what other wallpaper apps do not have, and the catalogue can carry them: the app
already knows items of kind `scene`. **No scene is listed yet.** This section says what is ready
and what has to happen first.

**What a scene item is.** A `.kumo` file baked by the scripts in `scenes/` (see
[scenes/README.md](../scenes/README.md)): a list of numbers and one block of vertices. It holds
no code, no script and no texture. Three scenes exist: Metro Block, Autumn Village and Winter
Square, about 5 MB each. These three ship inside Kumo (packed to about 1 MB each), so they are
not catalogue items; what follows is for scenes that come later as downloads.

**What the app does with it** (`src/catalog.rs`): it downloads the file from a host on its list
with a cap of 50 MB, checks `bytes` and `sha256`, makes sure the file really is a scene (it starts
with `KUMO`), and reads it with the engine's own reader (`scene::parse`), which refuses any
number that would send the renderer outside its data. Only then does the file enter the library,
with title, author, licence and credit, like any other download.

**Where the files live.** Unlike pictures, scenes have no source server of their own, so we host
them: the file and a 480x270 preview next to the catalogue on `kumo.hyos.tech`, which is on the
app's list already (later `cdn.kumo.hyos.tech`). A scene that changes gets a new file name, so
`bytes` and `sha256` of a listed file never change.

**The item**, with the values of today's bake as an example:

```json
{
  "id": "kumo-metro-block",
  "title": "Metro Block",
  "author": "Kumo, with models by Mike Judge",
  "kind": "scene",
  "category": "scenes",
  "source": "Kumo",
  "sourceUrl": "https://github.com/Hamido212/kumo/tree/main/scenes/metro",
  "license": "CC BY 4.0",
  "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
  "credit": "“Metro Block”, a 3D scene by Kumo. Buildings, vehicles and street furniture: Mini Mike's Metro Minis by Mike Judge (github.com/mikelovesrobots/mmmm), converted to meshes, recoloured and arranged. Additional Artwork by Mike Judge. CC BY 4.0.",
  "thumb": "https://kumo.hyos.tech/catalog/v1/scenes/metro-block-1.jpg",
  "file": "https://kumo.hyos.tech/catalog/v1/scenes/metro-block-1.kumo",
  "bytes": 4929444, "width": 0, "height": 0,
  "duration": 0, "codec": "",
  "sha256": "75b7f401458d301a5e34397b373123c3f2a37728fab459d73884aeb131ab89fb", "revoked": false
}
```

* `credit` is what CC BY 4.0 asks for in one line: the work, its author, the source, the licence
  and that it was changed. The app shows it with the item and keeps it in the library. The same
  facts are inside the file (`credits` in its manifest, with the name of every model used) and in
  `assets/third-party-notices.txt`.
* `sha256` is always filled in for scenes: we make the file, so we know it.
* `width` and `height` are 0: a scene has no pixel size, it is drawn at the screen's.

**Before the first scene can be listed:**

1. **A licence for Kumo's own part.** The models are CC BY 4.0. The islands, ground and the
   arrangement come from the GPL scripts in `scenes/`. The item needs one licence from the
   catalogue's list, so the publisher has to decide to offer the baked scenes under CC BY 4.0
   (the scene files name "GPL-3.0" for Kumo's part until then).
2. **The tool** is ready: `check` accepts kind `scene` with a cap of 50 MB and no pixel size, the
   category `scenes` ("3D scenes" / "3D-Szenen") exists, and the mirror source reads
   `scenes/items.json` of the kumo-wallpapers repository, so scenes can be hosted there as well as
   next to the catalogue.
3. **A look at the Discover tab** with a scene item, from a local catalogue file (`KUMO_CATALOG`):
   preview, the line under the title, download, and the scene running afterwards. The download
   path is covered by tests, the look of a scene card is not.
4. **Files on the website:** bake, render the preview with
   `kumo.exe --shot preview.bmp --scene file.kumo --size 1920x1080 --hour 18.4`, scale it to
   480x270, and put both next to the catalogue. Then build, review and deploy as for any change.

**Memory.** A scene must not need much more memory than the built-in one; the numbers are in
[scenes/README.md](../scenes/README.md). Measure a new scene before listing it.

## Next steps

* **Publishing the mirror** (kumo-wallpapers on GitHub): until then its items cannot be listed.
  Later, object storage (`cdn.kumo.hyos.tech`) could take over for larger files, for sources that
  discourage hotlinking such as Wikimedia Commons, and for the Met and SMK.
* **GNOME backgrounds** if 3.0 works are ever accepted, and **Ubuntu files whose
  `debian/copyright` entry differs from the file name** once Ubuntu corrects the entries.
* **Listing the 3D scenes** from `scenes/`: what is ready and what is missing is under
  [3D scenes](#3d-scenes) above.
* **A signed catalogue**, so the app can tell that the index really comes from us.
* As Kumo is free, a later version could consider sources whose API is free for apps that do not
  charge (Coverr), each only after a written OK from the source.
