"""Builds the pictures of our own wallpaper mirror, the public repository Hamido212/kumo-wallpapers.

    python tools/mirror_pictures.py fetch                download each original once into target/mirror-src/
    python tools/mirror_pictures.py build [--mirror DIR] write pictures/, thumbs/pictures/, pictures/items.json,
                                                         CREDITS.md, README.md and LICENSES/ into the mirror
    python tools/mirror_pictures.py credits [--mirror DIR]
                                                         write CREDITS.md again (also lists loops/ and scenes/)

The list of pictures, with their licence and where each original comes from, is
tools/mirror-pictures.json; docs/discover.md explains the rules. DIR defaults to ../kumo-wallpapers
next to this repository. `fetch` asks each source's own server over https, one file at a time, with
a neutral user agent, checks the file type by its first bytes and never runs anything it downloads.
`build` needs Pillow (pip install pillow) and, for JPEG XL originals, ffmpeg with libjxl.
Output is deterministic: the same originals give byte-identical files.
"""
import argparse
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PICKS = ROOT / "tools" / "mirror-pictures.json"
ORIGINALS = ROOT / "target" / "mirror-src" / "originals"
DECODED = ROOT / "target" / "mirror-src" / "decoded"
MIRROR_DIR = ROOT.parent / "kumo-wallpapers"
MIRROR_URL = "https://raw.githubusercontent.com/Hamido212/kumo-wallpapers/main/"
USER_AGENT = "catalog-tool/1.0"
MAX_WIDTH = 3840          # wider originals are scaled down; no screen needs more for a background
JPEG_QUALITY = 88
MAX_BYTES = 6 << 20       # no mirrored file above 6 MB
THUMB = (480, 270)
ID = re.compile(r"[a-z0-9-]{1,64}")
LICENSE_TEXTS = {  # licence name -> (file in LICENSES/, where the text comes from)
    "CC BY-SA 4.0": ("CC-BY-SA-4.0.txt", "https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt"),
    "CC BY 4.0": ("CC-BY-4.0.txt", "https://creativecommons.org/licenses/by/4.0/legalcode.txt"),
    "CC0 1.0": ("CC0-1.0.txt", "https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt"),
}


def picks():
    data = json.loads(PICKS.read_text(encoding="utf-8"))
    ids = [p["id"] for p in data["pictures"]]
    assert len(ids) == len(set(ids)), "duplicate ids in mirror-pictures.json"
    for p in data["pictures"]:
        assert ID.fullmatch(p["id"]) and p["id"].startswith(p["source"] + "-"), p["id"]
    return data


def kind_of(head):
    """The picture format from the first bytes, or None for anything else."""
    if head[:3] == b"\xff\xd8\xff":
        return "jpg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:2] == b"\xff\x0a" or head[:12] == b"\x00\x00\x00\x0cJXL \r\n\x87\n":
        return "jxl"
    return None


def get(url):
    """One https download with a neutral user agent; refuses to leave https."""
    if not url.startswith("https://"):
        raise ValueError("not https: " + url)
    url = urllib.parse.quote(url, safe=":/?&=%+~#@!$'()*,;")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=180) as r:
                if not r.geturl().startswith("https://"):
                    raise ValueError("redirected away from https: " + r.geturl())
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == 3:
                raise
        time.sleep(5 * (attempt + 1))


def original(p):
    """The downloaded original of a pick, or None."""
    found = sorted((ORIGINALS / p["source"]).glob(p["id"] + ".*"))
    return found[0] if found else None


def fetch(args):
    for p in picks()["pictures"]:
        if original(p):
            continue
        data = get(p["download"])
        ext = kind_of(data[:16])
        if not ext:
            print(f"REFUSED {p['id']}: not a picture by its first bytes")
            continue
        folder = ORIGINALS / p["source"]
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{p['id']}.{ext}").write_bytes(data)
        print(f"{p['id']}: {len(data) / 1e6:.1f} MB {ext}", flush=True)
        time.sleep(0.5)
    return 0


# --------------------------------------------------------------------------------------------
# Build

def load(path):
    """An original as an 8-bit sRGB RGB image without metadata; JPEG XL is decoded with ffmpeg."""
    from PIL import Image, ImageCms
    Image.MAX_IMAGE_PIXELS = 250_000_000
    if path.suffix == ".jxl":
        DECODED.mkdir(parents=True, exist_ok=True)
        png = DECODED / (path.stem + ".png")
        if not png.exists():
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(path), "-frames:v", "1",
                            "-pix_fmt", "rgb24", str(png)], check=True)
        path = png
    im = Image.open(path)
    im.load()
    notes = []
    icc = im.info.get("icc_profile")
    if im.getexif().get(0x0112, 1) != 1:  # EXIF orientation: turn the pixels, as the metadata goes
        from PIL import ImageOps
        im = ImageOps.exif_transpose(im)
        notes.append("turned upright as its EXIF orientation said")
    if im.mode in ("P", "L", "LA", "PA", "I", "I;16", "F", "CMYK"):
        im = im.convert("RGBA" if "A" in im.mode or "transparency" in im.info else "RGB")
    if im.mode == "RGBA":
        lo = im.getchannel("A").getextrema()[0]
        if lo < 255:  # partly transparent: shown on black, as a desktop shows it
            notes.append("semi-transparent pixels laid over black")
            black = Image.new("RGBA", im.size, (0, 0, 0, 255))
            im = Image.alpha_composite(black, im)
        im = im.convert("RGB")
    if icc:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            name = ImageCms.getProfileDescription(src).strip()
            if "srgb" not in name.lower():
                im = ImageCms.profileToProfile(im, src, ImageCms.createProfile("sRGB"), outputMode="RGB")
                notes.append(f"colour profile {name} converted to sRGB")
        except (OSError, ImageCms.PyCMSError):
            pass
    # Pillow writes a source's comment (and in newer versions XMP) back when saving; nothing of
    # the original's metadata may travel on, so the pixels go on without any of it
    im.info = {}
    return im, notes


def encode(im, flat):
    """(bytes, ext, quality): a baseline JPEG at quality 88, or a PNG where that is smaller (flat
    art). JPEG quality steps down only if a file would be above 6 MB. No comment, EXIF, XMP or
    colour profile is written: the image's info is cleared and empty values are passed explicitly."""
    im.info = {}
    def jpeg(q):
        b = io.BytesIO()
        im.save(b, "JPEG", quality=q, optimize=True, progressive=False, subsampling="4:2:0" if not flat else "4:4:4",
                comment=b"", exif=b"", icc_profile=None)
        return b.getvalue()
    out, ext, q = jpeg(JPEG_QUALITY), "jpg", JPEG_QUALITY
    if flat:
        b = io.BytesIO()
        im.save(b, "PNG", optimize=True)
        if len(b.getvalue()) < len(out):
            out, ext, q = b.getvalue(), "png", None
    while len(out) > MAX_BYTES and ext == "jpg" and q > 70:
        q -= 3
        out = jpeg(q)
    if len(out) > MAX_BYTES:
        raise ValueError("cannot get below 6 MB")
    return out, ext, q


def jpeg_segments(data):
    """(marker, segment, offset) for every header segment of a JPEG up to and including the start
    of scan; None if the file is not a JPEG that can be walked."""
    if data[:2] != b"\xff\xd8":
        return None
    out, i = [], 2
    while i + 4 <= len(data) and data[i] == 0xFF:
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        length = int.from_bytes(data[i + 2:i + 4], "big")
        out.append((marker, data[i:i + 2 + length], i))
        if marker == 0xDA:
            return out
        i += 2 + length
    return None


def harmless(marker, segment):
    """The JPEG header segments a mirrored file may keep: everything that is not metadata, plus
    the JFIF header (APP0) and Adobe's colour-transform flag (APP14), which carry no personal data
    and which decoders need to show the colours right."""
    if marker == 0xE0:
        return segment[4:9] == b"JFIF\0"
    if marker == 0xEE:
        return segment[4:9] == b"Adobe"
    return not (0xE1 <= marker <= 0xEF or marker == 0xFE)


def metadata_left(data):
    """What metadata a mirrored file still carries (empty when none): JPEG comments, EXIF, XMP,
    IPTC, colour profiles and any other APPn block; PNG text, EXIF, time and profile chunks."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        found, i = [], 8
        while i + 8 <= len(data):
            length, kind = int.from_bytes(data[i:i + 4], "big"), data[i + 4:i + 8]
            if kind in (b"tEXt", b"zTXt", b"iTXt", b"eXIf", b"tIME", b"iCCP"):
                found.append(kind.decode())
            i += 12 + length
        return found
    segments = jpeg_segments(data)
    if segments is None:
        return ["not a JPEG or PNG that can be read"]
    return [f"{'COM' if m == 0xFE else f'APP{m - 0xE0}'} {s[4:10]!r}" for m, s, _ in segments if not harmless(m, s)]


def strip_jpeg(data):
    """A baseline JPEG without its metadata (EXIF, XMP, IPTC, an sRGB colour profile, comments),
    losslessly: the image data stays byte for byte. None if the file is progressive or cannot be
    walked, so it has to be encoded again. Only called when load() found no other colour profile."""
    segments = jpeg_segments(data)
    if segments is None or any(m in (0xC2, 0xC6, 0xCA, 0xCE) for m, _, _ in segments):  # progressive: needs much more memory
        return None
    head = b"".join(s for m, s, _ in segments[:-1] if harmless(m, s))
    return b"\xff\xd8" + head + data[segments[-1][2]:]  # the start of scan and everything after it stays as it is


def thumb(im):
    """480x270 JPEG preview, cropped to fill from the centre."""
    from PIL import Image
    scale = max(THUMB[0] / im.width, THUMB[1] / im.height)
    w, h = round(im.width * scale), round(im.height * scale)
    small = im.resize((w, h), Image.LANCZOS)
    left, top = (w - THUMB[0]) // 2, (h - THUMB[1]) // 2
    b = io.BytesIO()
    small.crop((left, top, left + THUMB[0], top + THUMB[1])).save(b, "JPEG", quality=85, optimize=True)
    return b.getvalue()


def changes_note(raw, out, src_ext, w0, h0, w, h, ext, quality, notes):
    """What we did to the original, as CC licences ask ('Resized from ..., converted ...'), or
    'none' when the mirrored file is byte for byte the original."""
    if out == raw:
        return "none"
    fmt = {"jpg": "JPEG", "png": "PNG", "webp": "WebP", "jxl": "JPEG XL"}
    q = f" (quality {quality})" if quality else ""
    parts = [f"resized from {w0}x{h0} to {w}x{h}"] if (w, h) != (w0, h0) else []
    if src_ext != ext:
        parts.append(f"converted from {fmt[src_ext]} to {fmt[ext]}{q}")
    elif quality or ext == "png":  # encoded again; a JPEG kept as it was has no quality
        parts.append(f"saved again as {fmt[ext]}{q}")
    parts += notes
    if src_ext in ("jpg", "png") and metadata_left(raw):
        parts.append("metadata removed")
    text = ", ".join(parts) or "metadata removed"
    return text[0].upper() + text[1:] + "."


def build(args):
    from PIL import Image
    mirror = pathlib.Path(args.mirror)
    data = picks()
    sources = data["sources"]
    records, missing, problems = [], [], []
    for p in data["pictures"]:
        src = original(p)
        if not src:
            missing.append(p["id"])
            continue
        raw = src.read_bytes()
        im, notes = load(src)
        w0, h0 = im.size
        kept = strip_jpeg(raw) if src.suffix == ".jpg" and im.width <= MAX_WIDTH and not notes else None
        if kept and len(kept) <= MAX_BYTES:  # a JPEG that fits: only the metadata goes
            out, ext, quality = kept, "jpg", None
        else:
            if im.width > MAX_WIDTH:
                im = im.resize((MAX_WIDTH, round(im.height * MAX_WIDTH / im.width)), Image.LANCZOS)
            out, ext, quality = encode(im, p.get("flat", False))
        rel = f"pictures/{p['source']}/{p['id']}.{ext}"
        prev = f"thumbs/pictures/{p['id']}.jpg"
        preview = thumb(im)
        for path, blob in ((rel, out), (prev, preview)):
            (mirror / path).parent.mkdir(parents=True, exist_ok=True)
            if not (mirror / path).exists() or (mirror / path).read_bytes() != blob:
                (mirror / path).write_bytes(blob)
        for stale in (mirror / "pictures" / p["source"]).glob(p["id"] + ".*"):
            if stale.name != pathlib.Path(rel).name:
                stale.unlink()
        left = metadata_left(out) + [f"preview: {x}" for x in metadata_left(preview)]
        if left:
            problems.append(f"{p['id']}: metadata left in the mirrored file: {', '.join(left)}")
        s = sources[p["source"]]
        changes = changes_note(raw, out, src.suffix[1:], w0, h0, im.width, im.height, ext, quality, notes)
        credit = (f"“{p['title']}” by {p['author']}. {s['name']}, {p['sourceUrl']}. {p['license']}."
                  + ("" if changes == "none" else f" Changes: {changes}"))
        records.append({
            "id": p["id"],
            "kind": "image",
            "title": p["title"],
            "author": p["author"],
            "source": s["name"],
            "sourceUrl": p["sourceUrl"],
            "license": p["license"],
            "licenseUrl": p["licenseUrl"],
            "credit": credit,
            "changes": changes,
            "category": p["category"],
            "width": im.width, "height": im.height,
            "bytes": len(out),
            "sha256": hashlib.sha256(out).hexdigest(),
            "path": rel,
            "thumb": prev,
            "original": {"url": p["download"], "width": w0, "height": h0, "bytes": len(raw),
                         "sha256": hashlib.sha256(raw).hexdigest()},
            "licenceEvidence": p["licenceEvidence"],
            **({"authorEvidence": p["authorEvidence"]} if p.get("authorEvidence") else {}),
            **({"provenance": p["provenance"]} if p.get("provenance") else {}),
        })
        print(f"{p['id']}: {w0}x{h0} -> {im.width}x{im.height} {ext} {len(out) / 1e6:.2f} MB", flush=True)
    if missing:
        print("not downloaded yet (run fetch): " + ", ".join(missing))
        return 1
    records.sort(key=lambda r: (r["source"], r["id"]))
    # files of pictures that left the list (a takedown, a changed decision) go too
    wanted = {r["path"] for r in records} | {r["thumb"] for r in records}
    for folder in [mirror / "pictures" / s for s in sources] + [mirror / "thumbs" / "pictures"]:
        for f in sorted(folder.glob("*.*")) if folder.is_dir() else []:
            if f.relative_to(mirror).as_posix() not in wanted:
                print(f"removed {f.relative_to(mirror).as_posix()} (not in the list any more)")
                f.unlink()
    items = {"description": "Pictures mirrored for Kumo's Discover tab. Every file keeps the licence named here.",
             "base": MIRROR_URL, "items": records}
    (mirror / "pictures").mkdir(parents=True, exist_ok=True)
    (mirror / "pictures" / "items.json").write_text(json.dumps(items, ensure_ascii=False, indent=1) + "\n",
                                                   encoding="utf-8", newline="\n")
    licenses(mirror, {r["license"] for r in records})
    (mirror / "README.md").write_text(README, encoding="utf-8", newline="\n")
    credits(mirror)
    total = sum(r["bytes"] for r in records)
    print(f"{len(records)} pictures, {total / 1e6:.1f} MB, largest {max(r['bytes'] for r in records) / 1e6:.2f} MB")
    for p in problems:
        print("ERROR " + p)
    return 1 if problems else 0


README = """# Kumo wallpapers

Freely licensed wallpapers for the *Discover* tab of [Kumo](https://github.com/Hamido212/kumo), a free
and open-source live wallpaper engine for Windows. Kumo lists these files in its online catalogue
and downloads them from this repository when someone adds one to their library.

* `pictures/`: desktop art and photographs from open-source projects (KDE Plasma, Fedora, Pop!_OS,
  COSMIC, Ubuntu).
* `loops/`: short animated loops (videos). Six of them, the `loops/kumo/` files, are AI-generated:
  made by the Kumo project with an AI video model, marked as AI-generated in their records, and
  dedicated to the public domain (CC0 1.0).
* `scenes/`: 3D scenes in Kumo's `.kumo` format, made by the Kumo project.
* `thumbs/`: a 480x270 preview of every file. Previews are scaled and cropped copies; each one is
  under the licence of the item it shows and carries that item's credit.
* `tools/`: the scripts that made the loops, under the GPL-3.0-only like Kumo itself.

Each folder has an `items.json` that names, for every file, its title, author, source, licence,
the full credit line and what we changed (for example "resized from 5120x2880 to 3840x2160,
converted from PNG to JPEG", or "none" for a file that is byte for byte the original).

## Licences

**Every file keeps its own licence.** This repository as a whole has no single licence: each file
is under the licence its `items.json` record and [CREDITS.md](CREDITS.md) name, and the full texts
are in [LICENSES/](LICENSES/). Files under CC BY-SA 4.0 stay under CC BY-SA 4.0 in the changed form
we publish here. We take only public domain works and works under CC0 1.0, CC BY 4.0, CC BY-SA 4.0
or a permissive licence that the author applied; nothing NonCommercial or NoDerivatives. How we
choose and check the files is described in Kumo's
[docs/discover.md](https://github.com/Hamido212/kumo/blob/main/docs/discover.md).

## Reporting a problem

If you made one of these works and want it credited differently or removed, or you think a file
should not be here, please open an issue in the
[Kumo repository](https://github.com/Hamido212/kumo/issues) or write to the contact address in the
[Impressum](https://kumo.hyos.tech/impressum) of the Kumo website. We take a file out of the
catalogue at once while we look into it, and answer within 72 hours.
"""


def licenses(mirror, names):
    folder = mirror / "LICENSES"
    folder.mkdir(parents=True, exist_ok=True)
    for name in sorted(names):
        file, url = LICENSE_TEXTS[name]
        if not (folder / file).exists():
            (folder / file).write_bytes(get(url))


# --------------------------------------------------------------------------------------------
# CREDITS.md

def read_items(path):
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items", []) if isinstance(data, dict) else data
    return [i for i in items if isinstance(i, dict)]


def credits(mirror):
    """CREDITS.md: grouped by part and source, one line per file with title, author, source link,
    licence and the changes we made."""
    def field(i, *keys):
        return next((str(i[k]) for k in keys if i.get(k) not in (None, "")), "")

    lines = ["# Credits", "",
             "Every file in this repository keeps the licence of its original. One line per file: title, author,",
             "source, licence and what we changed. The full licence texts are in [LICENSES/](LICENSES/).", ""]
    for part, heading in (("pictures", "Pictures"), ("loops", "Animated loops"), ("scenes", "3D scenes")):
        items = read_items(mirror / part / "items.json")
        if not items:
            continue
        lines += [f"## {heading}", ""]
        groups = {}
        for i in items:
            groups.setdefault(field(i, "source", "sourceName", "source_name") or "Other", []).append(i)
        for source in sorted(groups):
            lines += [f"### {source}", ""]
            for i in sorted(groups[source], key=lambda x: field(x, "path", "file", "id")):
                path = field(i, "path", "file", "mirrorPath", "mirror_path")
                lic, lic_url = field(i, "license", "licence"), field(i, "licenseUrl", "licenceUrl", "license_url")
                changes = re.sub(r"^changes:\s*", "", field(i, "changes"), flags=re.I).strip()
                lines.append(f"* `{path}`: “{field(i, 'title')}” by {field(i, 'author', 'creator', 'artist')}, "
                             f"[source]({field(i, 'sourceUrl', 'source_url', 'sourcePage', 'page')}), "
                             f"[{lic}]({lic_url})" + ("" if changes.lower().rstrip(".") in ("", "none")
                                                     else f". Changes: {changes}"))
            lines.append("")
    (mirror / "CREDITS.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("fetch", help="download the originals")
    for name in ("build", "credits"):
        s = sub.add_parser(name)
        s.add_argument("--mirror", default=str(MIRROR_DIR), help="the local copy of kumo-wallpapers")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if args.command == "fetch":
        sys.exit(fetch(args))
    if args.command == "credits":
        credits(pathlib.Path(args.mirror))
        sys.exit(0)
    sys.exit(build(args))


if __name__ == "__main__":
    main()
