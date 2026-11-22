# Discover: the online wallpaper catalogue

Kumo's *Discover* tab shows wallpapers that are free to use and lets you add one to your library
with a click. This page explains where they come from, which rules decide what gets in, and how to
look after the catalogue.

## How it works

* The catalogue is one static file, `site/catalog/v1/catalog.json`, deployed with the website as
  `https://kumo.hyos.tech/catalog/v1/catalog.json`. We host only this index.
* Nothing is fetched before you open Discover and agree. Then Kumo loads the index, shows the
  previews, and on a click downloads the file **directly from the source's own server** (NASA, a
  museum, ESA, ESO) into the local library, the same as a file you drag in.
* Kumo downloads over https only, and only from a fixed list of hosts built into the app:
  `kumo.hyos.tech`, `cdn.kumo.hyos.tech`, `svs.gsfc.nasa.gov`, `openaccess-cdn.clevelandart.org`,
  `cdn.esahubble.org`, `cdn.esawebb.org`, `cdn.eso.org`. The tool checks against the same list
  (`ALLOWED_HOSTS`). A URL on any other host, after redirects too, is refused. Size caps: preview 8 MB, picture 80 MB, video 500 MB.
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
| `id` | `[a-z0-9-]{1,64}`, unique and stable: source prefix plus the source's own number (`svs-`, `cma-`, `esahubble-`, `esawebb-`, `eso-`; `met-` and `smk-` for the sources that are switched off) |
| `kind` | `image` or `video` |
| `category` | one of the `categories` ids: `space`, `nightsky`, `earth`, `japan`, `landscape` |
| `thumb`, `file` | https URLs on the app's host list, checked with a HEAD request at build time |
| `bytes`, `width`, `height` | from the server's `Content-Length`; the pixel size from the source's data or from the JPEG's own header (see below) |
| `duration`, `codec` | videos only: seconds (0 until a `--hash` run measures it) and `h264`, `hevc`, `vp9` or `av1` |
| `sha256` | empty, or the file's hash after a `--hash` run; the app checks it when present |
| `revoked` | `true` keeps the id known after a takedown, so apps can remove downloaded copies |

The app ignores fields it does not know, so new fields can be added without a new version. A
change that old apps would misread gets a new path (`/catalog/v2/`), and `v1` stays online.

## What gets in, and why

**Licences: public domain, CC0 1.0 and CC BY 4.0 only.** Nothing with NonCommercial (NC) or
NoDerivatives (ND), and no CC BY-SA in this first version. The reasons:

* Kumo is under the GPL, which lets anyone redistribute it, including commercially. NonCommercial
  content would not travel with it.
* The publisher is in Germany, so German and EU law apply, not just the licence a museum states.
* It keeps a Microsoft Store listing possible: the Store asks that the publisher holds the rights to
  all content an app shows (policy 11.2).

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
as ESA and ESO ask, followed by "ESA/Hubble", "ESA/Webb" or "ESO" and "CC BY 4.0".

## Sources

| Source | Licence | What we take | Credit shown |
|---|---|---|---|
| [NASA Scientific Visualization Studio](https://svs.gsfc.nasa.gov) | Public domain (NASA media guidelines) | calm visualisations: Earth, clouds, aurora, oceans, Sun, Moon, nebula fly-throughs | title, the page's credit, "NASA's Scientific Visualization Studio", link |
| [The Cleveland Museum of Art](https://www.clevelandart.org/open-access) | CC0 1.0 | Japanese woodblock landscapes, Western, Japanese and Chinese landscape painting, colour prints and watercolours (`images.print`, about 3400 px) | title, date, artist, museum, credit line |
| [ESA/Hubble](https://esahubble.org/copyright/) | CC BY 4.0 | hand-picked images, see the variant order below | the image's credit line, "ESA/Hubble, CC BY 4.0" |
| [ESA/Webb](https://esawebb.org/copyright/) | CC BY 4.0 | hand-picked images, see the variant order below | the image's credit line, "ESA/Webb, CC BY 4.0" |
| [ESO](https://www.eso.org/public/copyright/) | CC BY 4.0 | nebulae, galaxies and star clusters (Space), and photographs of the Paranal, La Silla, ALMA and APEX sites under the night sky (Night sky); candidates from ESO's Top 100 and archive categories | the image's credit line, unaltered, "ESO, CC BY 4.0", link |

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

### The review pass

Every build writes `target/catalog-review.html`, a contact sheet with each preview (loaded from the
source), its title, credit, id, size and codec. Look through it before deploying: a word list does
not see what a picture shows, a video can have a title card, and a museum photo can show a frame or
a mount instead of the work.

## Adding or removing an item

* **Remove:** add its id to `tools/catalog-exclude.txt` with a short reason and the date, build,
  deploy.
* **Add a single item** from a source that is already there: for ESA, add the image id to `IDS` in
  `EsaHubble` or `EsaWebb`; for ESO, add a listing to `LISTINGS`; for the others, add a search to
  the source's `SEARCHES`. The rules apply
  as to everything else.
* **Add a source:** write a small `Source` class in `tools/catalog.py` with a `candidates()` method
  that yields items, add it to `SOURCES`, and add its media hosts to the app's host list (in
  `src/catalog.rs`) and to `ALLOWED_HOSTS` in the tool. Check its licence and terms first, and add a
  line to the table above.

## Takedown requests

1. Remove the item at once: add `<id> revoked` to `tools/catalog-exclude.txt`, build and deploy.
   The entry stays in the catalogue with `"revoked": true`, so apps stop offering it and can remove
   copies they downloaded. Because of the short cache time this takes effect within minutes.
2. Answer the sender within 72 hours, from the contact address in the
   [Impressum](https://kumo.hyos.tech/impressum) (`hello@hyos.tech`): what was removed and when.
3. If the claim is unclear, keep the item removed while you check it with the source.

## Next steps

* **Our own file mirror** on object storage (`cdn.kumo.hyos.tech`) for sources that discourage
  hotlinking, such as Wikimedia Commons, and for previews made with `--thumbs`.
* **Downloadable `.kumo` 3D scenes**, built from CC0 voxel assets with the scene generator in
  `scenes/`.
* **A signed catalogue**, so the app can tell that the index really comes from us.
* As Kumo is free, a later version could consider **CC BY-SA 4.0** works and sources whose API is
  free for apps that do not charge (Coverr), each only after a written OK from the source.
