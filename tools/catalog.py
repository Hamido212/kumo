"""Builds and checks the online wallpaper catalogue that Kumo's Discover tab reads:
site/catalog/v1/catalog.json, deployed with the website as https://kumo.hyos.tech/catalog/v1/catalog.json.
We host this index. The app downloads each file directly from the source's own server, or, for
the files we mirror ourselves, from the public repository Hamido212/kumo-wallpapers on GitHub.

    python tools/catalog.py build      collect, filter and verify items, write the catalogue
    python tools/catalog.py check      validate an existing catalogue offline

Options for build:
    --user-agent TEXT   the User-Agent sent with every request
    --refresh           ignore the cache in target/catalog-cache and ask the servers again
    --only NAME         run one source (svs, cleveland, met, smk, esahubble, esawebb, eso, mirror), keep the others
    --hash              download every file once to fill in sha256 (and the codec and length of videos)
    --thumbs DIR        download every preview and write DIR/<id>.jpg at 480x270 (needs Windows)
    --mirror DIR        a local copy of the kumo-wallpapers repository (default: ../kumo-wallpapers
                        next to this repository); its pictures/, loops/ and scenes/items.json are read
    --mirror-local      check mirror items against the files in DIR (size and sha256) instead of
                        asking GitHub, for files that are not published yet
    --out FILE          write the catalogue there instead of site/catalog/v1/catalog.json

The rules (licences, EU copyright term, wallpaper fitness, family-friendly content) are explained
in docs/discover.md. Items can be removed by hand in tools/catalog-exclude.txt. Every build also
writes target/catalog-review.html, a contact sheet for looking through the result.
Python 3 standard library only. Everything a server returns is treated as data.
"""
import argparse
import datetime
import hashlib
import html
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "catalog" / "v1" / "catalog.json"
CACHE = ROOT / "target" / "catalog-cache"
REVIEW = ROOT / "target" / "catalog-review.html"
EXCLUDE = ROOT / "tools" / "catalog-exclude.txt"
USER_AGENT = "KumoCatalog/1.0 (+https://kumo.hyos.tech)"
DELAY = 0.4  # seconds between two requests: everything runs one request at a time

# The app downloads over https from these hosts only (src/catalog.rs has the same list).
ALLOWED_HOSTS = {
    "kumo.hyos.tech", "cdn.kumo.hyos.tech", "svs.gsfc.nasa.gov", "openaccess-cdn.clevelandart.org",
    "cdn.esahubble.org", "cdn.esawebb.org", "cdn.eso.org", "raw.githubusercontent.com",
}
# Our own file mirror: a public GitHub repository. raw.githubusercontent.com serves every public
# repository, so the tool accepts that host only below this path.
MIRROR_URL = "https://raw.githubusercontent.com/Hamido212/kumo-wallpapers/main/"
MIRROR_DIR = ROOT.parent / "kumo-wallpapers"  # the local copy, next to this repository
PROBE_BYTES = 65536  # how much of a JPEG a size probe may read: enough for the frame header
# The licence allow-list: name -> the pages that may explain it
NASA_TERMS = "https://www.nasa.gov/nasa-brand-center/images-and-media/"
PD_MARK = "https://creativecommons.org/publicdomain/mark/1.0/"
CC0 = "https://creativecommons.org/publicdomain/zero/1.0/"
CC_BY = "https://creativecommons.org/licenses/by/4.0/"
CC_BY_SA = "https://creativecommons.org/licenses/by-sa/4.0/"
MIT = "https://opensource.org/license/mit"
LICENSES = {"Public Domain": {NASA_TERMS, PD_MARK}, "CC0 1.0": {CC0}, "CC BY 4.0": {CC_BY},
            "CC BY-SA 4.0": {CC_BY_SA}, "MIT": {MIT}}
CAPS = {"thumb": 8 << 20, "image": 80 << 20, "video": 500 << 20, "scene": 50 << 20}
CODECS = {"h264", "hevc", "vp9", "av1"}
# Kumo scales every picture to the screen anyway, and decoding a huge (progressive) JPEG can take
# hundreds of MB, which would break the low-RAM promise. 40 MP is about 8400 x 4700.
MAX_PIXELS = 40_000_000
CATEGORIES = [
    {"id": "space", "title": {"en": "Space", "de": "Weltraum"}},
    {"id": "nightsky", "title": {"en": "Night sky", "de": "Nachthimmel"}},
    {"id": "earth", "title": {"en": "Earth", "de": "Erde"}},
    {"id": "japan", "title": {"en": "Japan (ukiyo-e)", "de": "Japan (Ukiyo-e)"}},
    {"id": "landscape", "title": {"en": "Landscape painting", "de": "Landschaftsmalerei"}},
    {"id": "desktop", "title": {"en": "Desktop art", "de": "Desktop-Kunst"}},
    {"id": "photo", "title": {"en": "Photography", "de": "Fotografie"}},
    {"id": "loops", "title": {"en": "Animated loops", "de": "Animierte Loops"}},
    {"id": "scenes", "title": {"en": "3D scenes", "de": "3D-Szenen"}},
]
KINDS = ("image", "video", "scene")
ID = re.compile(r"[a-z0-9-]{1,64}")
ITEM_FIELDS = ["id", "title", "author", "kind", "category", "source", "sourceUrl", "license", "licenseUrl",
               "credit", "thumb", "file", "bytes", "width", "height", "duration", "codec", "sha256", "revoked"]


def last_death_year():
    """EU term: 70 years after the end of the year the creator died. In 2026 that frees deaths up to 1955."""
    return datetime.date.today().year - 71


# Words that keep an item out of a family-friendly catalogue. Matched as whole words in titles,
# descriptions, tags and classifications, in English and (for SMK) Danish.
UNSUITABLE = re.compile(r"\b(" + "|".join([
    r"nude?s?", r"nudity", r"naked", r"erotic\w*", r"shunga", r"pillow book", r"lovers?", r"courtesans?",
    r"bath(?:ing|ers?)?", r"divers?", r"abalone", r"awabi", r"venus", r"leda", r"susanna", r"bacchanal\w*", r"nymphs?", r"harem",
    r"war", r"wars", r"battle\w*", r"warriors?", r"soldiers?", r"army", r"siege", r"massacre", r"murder\w*",
    r"execution\w*", r"kill\w*", r"slaughter\w*", r"blood\w*", r"weapons?", r"swords?", r"guns?", r"hunt\w*",
    r"fight\w*", r"violence", r"suicide", r"ghosts?", r"demons?", r"hell", r"skulls?", r"skeletons?",
    r"death", r"dead", r"dying", r"corpses?", r"funeral", r"graves?", r"tomb\w*", r"burial", r"entombment",
    r"martyr\w*", r"crucifi\w*", r"lamentation", r"pieta", r"pietà", r"sebastian",
    r"medical", r"covid\w*", r"pandemic", r"virus\w*", r"surgery", r"anatomy", r"anatomical", r"disease", r"hospital",
    r"astronauts?", r"crew", r"portraits?", r"self-portrait", r"logos?", r"insignia", r"patch",
    r"interview", r"narrat\w*", r"music",
    r"nøgen", r"badende", r"død", r"døde", r"krig", r"slag", r"korsfæst\w*", r"lig",
]) + r")\b", re.I)
MULTI_PART = re.compile(r"\b(triptych|diptych|polyptych|pair of|album|screens?|folding|fan|sheet of|panels?)\b", re.I)
NO_TITLE = re.compile(r"^\s*(\[?untitled\]?|no title|title unknown|fragment|uden titel|\?)\s*$", re.I)


# --------------------------------------------------------------------------------------------
# Network: one request at a time, a pause between them, 429/Retry-After honoured, answers cached.

class Net:
    def __init__(self, user_agent, refresh):
        self.user_agent = user_agent
        self.refresh = refresh
        self.last = 0.0
        self.requests = 0
        CACHE.mkdir(parents=True, exist_ok=True)
        self.head_file = CACHE / "head.json"
        self.heads = {} if refresh or not self.head_file.exists() else json.loads(self.head_file.read_text(encoding="utf-8"))
        self.hosts_seen = Counter()

    def _wait(self):
        pause = self.last + DELAY - time.monotonic()
        if pause > 0:
            time.sleep(pause)
        self.last = time.monotonic()

    def open(self, url, method="GET", headers=None, tries=4):
        """Opens a URL and returns the response; follows redirects. Raises urllib.error.HTTPError."""
        for attempt in range(tries):
            self._wait()
            self.requests += 1
            request = urllib.request.Request(url, method=method, headers={"User-Agent": self.user_agent, **(headers or {})})
            try:
                return urllib.request.urlopen(request, timeout=60)
            except urllib.error.HTTPError as e:
                if e.code in (429, 502, 503, 504) and attempt + 1 < tries:
                    wait = e.headers.get("Retry-After", "")
                    time.sleep(min(int(wait) if wait.isdigit() else 5 * (attempt + 1), 120))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if attempt + 1 < tries:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise

    def text(self, url, suffix=".json"):
        """The body of an API answer or page, from the cache when it is there."""
        path = CACHE / (hashlib.sha1(url.encode()).hexdigest() + suffix)
        if path.exists() and not self.refresh:
            return path.read_text(encoding="utf-8")
        with self.open(url, headers={"Accept": "application/json" if suffix == ".json" else "text/html"}) as r:
            body = r.read().decode("utf-8", errors="replace")
        path.write_text(body, encoding="utf-8")
        return body

    def json(self, url):
        return json.loads(self.text(url, ".json"))

    def head(self, url):
        """Checks that a media URL answers 200 on an allowed https host. Returns a dict with ok,
        reason, bytes, type and final URL. Uses HEAD, or a GET of the first kilobyte if HEAD is refused."""
        if url in self.heads:
            return self.heads[url]
        result = self._head(url)
        if not re.match(r"HTTP 5|network error", result.get("reason", "")):  # ask again next time
            self.heads[url] = result
        if len(self.heads) % 25 == 0:
            self.save()
        return result

    def _head(self, url):
        if urllib.parse.urlsplit(url).scheme != "https":
            return {"ok": False, "reason": "not https"}
        try:
            try:
                r = self.open(url, method="HEAD")
                size = r.headers.get("Content-Length")
            except urllib.error.HTTPError as e:
                if e.code not in (403, 405, 501):
                    raise
                r = self.open(url, headers={"Range": "bytes=0-1023"})
                r.read(1024)
                total = (r.headers.get("Content-Range") or "").rpartition("/")[2]
                size = total if total.isdigit() else r.headers.get("Content-Length") if r.status == 200 else None
            with r:
                final = r.geturl()
                kind = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                status = r.status
        except urllib.error.HTTPError as e:
            return {"ok": False, "reason": f"HTTP {e.code}"}
        except Exception as e:  # network trouble is a reason to drop the item, not to stop the build
            return {"ok": False, "reason": f"network error ({type(e).__name__})"}
        host = urllib.parse.urlsplit(final).hostname or ""
        self.hosts_seen[host] += 1
        out = {"ok": False, "final": final, "type": kind, "bytes": int(size) if size and size.isdigit() else 0}
        if status not in (200, 206):
            out["reason"] = f"HTTP {status}"
        elif not final.startswith("https://"):
            out["reason"] = "redirected to http"
        elif host not in ALLOWED_HOSTS:
            out["reason"] = f"host not allowed: {host}"
        elif kind == "text/html":
            out["reason"] = "server answers with a web page (bot challenge)"
        elif not kind.startswith(("image/", "video/")) and kind not in ("application/octet-stream", "binary/octet-stream"):
            out["reason"] = f"content type {kind or 'missing'}"
        elif not out["bytes"]:
            out["reason"] = "no Content-Length"
        else:
            out["ok"] = True
        return out

    def jpeg_size(self, url):
        """(width, height) of a JPEG read from its frame header within the first 64 KB, fetched with
        a range request; this never downloads the picture itself. None if the header is not there."""
        key = "size " + url
        if key in self.heads:
            return tuple(self.heads[key]) if self.heads[key] else None
        size = None
        try:
            with self.open(url, headers={"Range": f"bytes=0-{PROBE_BYTES - 1}"}) as r:
                if (urllib.parse.urlsplit(r.geturl()).hostname or "") in ALLOWED_HOSTS:
                    size = jpeg_dimensions(r.read(PROBE_BYTES))  # read() stops there even if Range was ignored
        except urllib.error.HTTPError as e:
            if e.code >= 500:
                return None
        except Exception:
            return None
        self.heads[key] = list(size) if size else None
        return size

    def save(self):
        self.head_file.write_text(json.dumps(self.heads, indent=1, sort_keys=True), encoding="utf-8")


def jpeg_dimensions(data):
    """(width, height) from the first frame header (SOF marker) found in the start of a JPEG."""
    if data[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 9 < len(data) and data[i] == 0xFF:
        marker, length = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        i += 2 + length
    return None


# --------------------------------------------------------------------------------------------
# Shared rules

def clean(text):
    """Plain text from a string that may hold HTML, entities or doubled spaces."""
    text = html.unescape(re.sub(r"<[^>]+>", " ", str(text or "")))
    return re.sub(r"\s+", " ", text).strip()


def flatten(value):
    """All strings inside a JSON value, joined: for fields whose shape varies between records."""
    if isinstance(value, dict):
        return " ".join(flatten(v) for v in value.values())
    if isinstance(value, list):
        return " ".join(flatten(v) for v in value)
    return value if isinstance(value, str) else ""


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def fits_screen(width, height):
    """None if a picture or video makes a good desktop background, else the reason it does not."""
    if not width or not height:
        return "unknown pixel size"
    if width < 1920:
        return "narrower than 1920 px"
    if not 1.3 <= width / height <= 2.4:
        return "not landscape 1.3 to 2.4"
    if width * height > MAX_PIXELS:
        return "more than 40 megapixels"
    return None


def unsuitable(*texts):
    """The first word that keeps an item out of a family-friendly catalogue, or None."""
    for text in texts:
        m = UNSUITABLE.search(clean(text))
        if m:
            return m[1].lower()
    return None


OLD_ENOUGH = 1850  # a work made by then has no copyright left, whoever made it


def free_in_eu(death_years, latest_year=None):
    """None if every creator died long enough ago, else the reason. When a death year is unknown
    (anonymous or workshop pieces), the work still qualifies if it was made in 1850 or earlier."""
    known = [y for y in death_years if y is not None]
    if known and max(known) > last_death_year():
        return "creator died after " + str(last_death_year())
    if death_years and len(known) == len(death_years):
        return None
    latest = year(latest_year)
    if latest is None:
        return "creator's death year unknown, work undated"
    if latest > OLD_ENOUGH:
        return f"creator's death year unknown, made after {OLD_ENOUGH}"
    return None


def year(value):
    m = re.match(r"\s*(-?\d{3,4})", str(value or ""))
    return int(m[1]) if m else None


class Source:
    """One place wallpapers come from. candidates() yields items with every catalogue field except
    bytes, plus '_text' (what the content filter reads); it calls self.drop(reason) for the rest."""
    name = ""

    def __init__(self, net, hashing=False):
        self.net = net
        self.hashing = hashing  # files will be downloaded, so facts only the bytes tell can wait
        self.dropped = Counter()
        self.considered = 0

    def drop(self, reason):
        self.dropped[reason] += 1
        return None

    def candidates(self):
        raise NotImplementedError


# --------------------------------------------------------------------------------------------
# NASA Scientific Visualization Studio: public domain videos

class Svs(Source):
    name = "svs"
    SEARCHES = [
        "spinning earth", "rotating earth clouds", "blue marble", "earth at night", "city lights",
        "global clouds", "aurora", "perpetual ocean", "ocean currents", "sea surface temperature",
        "solar dynamics observatory", "sun ultraviolet", "solar corona", "moon rotation", "lunar orbiter",
        "nebula flythrough", "galaxy flythrough", "milky way", "star field", "sea ice",
        "earth clouds", "cloud animation", "GEOS clouds", "SDO sun", "aurora australis", "moon turntable",
        "ocean flows", "earth night", "rotating globe", "sun rotation",
        "blue marble rotation", "rotating blue marble", "earth from space clouds", "clouds from orbit",
        "black marble", "night lights earth", "aurora iss", "aurora from space", "perpetual ocean currents",
        "sea surface currents", "sdo extreme ultraviolet", "sun extreme ultraviolet", "sun 4k", "solar surface",
        "lunar terrain flyover", "moon flyover", "lunar reconnaissance orbiter flyover", "jupiter rotation",
        "saturn rotation", "rotating jupiter", "galaxy fly-through", "nebula fly-through", "flight through nebula",
        "orion nebula", "earth rotation 4k", "earth day night", "geos-5 clouds", "global weather", "cloud cover",
    ]
    TYPES = {"Visualization", "Animation", "B-Roll"}
    SKIP_TITLE = re.compile(r"\b(" + "|".join([
        r"data", r"model", r"anomal\w*", r"temperature", r"chart", r"graph", r"maps?", r"comparison",
        r"asset library", r"projection", r"coded colou?r", r"terrain", r"aerosols?", r"air quality",
        r"ozone", r"carbon", r"co2", r"methane", r"fires?", r"wildfires?", r"smoke", r"hurricanes?",
        r"storms?", r"tornado\w*", r"floods?", r"drought", r"sea level", r"loss", r"melt\w*",
        r"black holes?", r"plunge", r"launch\w*", r"eclipse", r"phase", r"libration", r"flares?",
        r"mass ejection", r"cme", r"enlil", r"x\d", r"m\d", r"trailer", r"teaser", r"promo",
        r"live shots?", r"q&a", r"explainer", r"timeline", r"orbit tracks?", r"satellites?", r"spacecraft",
        r"illumination", r"crater", r"landing", r"impact", r"\d{4}",
        r"explain\w*", r"briefing", r"graphics", r"sampler", r"flight path", r"mission", r"dinosaur\w*",
        r"pollution", r"nitrogen", r"variations?", r"examine", r"rates?", r"versus", r"insights", r"experiment",
        r"first light", r"baily'?s", r"disasters?", r"gravity", r"magnetotail", r"magnetospheres?",
        r"vertical", r"erosion", r"thinning", r"animals?", r"movement", r"contribut\w*", r"spheres",
        r"layers", r"phases", r"nova", r"geocorona", r"seasons", r"how", r"what", r"why",
        r"fleet", r"change", r"height", r"vignettes",
    ]) + r")\b", re.I)
    # and the title has to name something calm to look at
    CALM = re.compile(r"\b(earth|globe|clouds?|aurora\w*|oceans?|currents?|tides?|sea|seas|sun|solar|corona|moon|"
                      r"lunar|nebula\w*|galax\w*|milky way|stars?|starfield|night lights|black marble|blue marble|"
                      r"planet|jupiter|saturn|heliosphere|ice|rotation|turntable|spinning|flyover|fly-through|flythrough)\b", re.I)
    LABELLED = re.compile(r"(?<!no)(label|annot|caption|title|text|legend|colorbar|colourbar|date|key|scale|slate|credit)", re.I)
    RIGHTS = re.compile(r"©|copyright|courtesy|permission|getty|shutterstock|universal production music|all rights|"
                        r"licensed|\bmusic\b|narrat", re.I)

    def candidates(self):
        seen = set()
        for words in self.SEARCHES:
            url = "https://svs.gsfc.nasa.gov/api/search/?" + urllib.parse.urlencode({"search": words, "limit": 40})
            for hit in self.net.json(url).get("results", []):
                if hit["id"] in seen:
                    continue
                seen.add(hit["id"])
                self.considered += 1
                if hit.get("result_type") not in self.TYPES:
                    self.drop("not a visualization")
                    continue
                if self.SKIP_TITLE.search(hit.get("title", "")) or not self.CALM.search(hit.get("title", "")):
                    self.drop("topic not calm or carries data overlays")
                    continue
                item = self.item(self.net.json(f"https://svs.gsfc.nasa.gov/api/{hit['id']}/"))
                if item:
                    yield item

    @staticmethod
    def https(url):
        """SVS gives http:// links, and some file names hold spaces or accents: https, percent-encoded."""
        url = re.sub(r"^http://", "https://", url or "")
        return urllib.parse.quote(url, safe=":/%?&=#~+,;@!$'()*")

    def item(self, page):
        title = clean(page.get("title"))
        groups = page.get("media_groups") or []
        credits_text = " ".join(
            f'{c.get("role", "")}: ' + ", ".join(f'{p.get("name", "")} {p.get("employer") or ""}' for p in c.get("people") or [])
            for c in page.get("credits") or [])
        captions = " ".join(clean(g.get("caption")) for g in groups)
        if self.RIGHTS.search(credits_text + " " + captions + " " + clean(page.get("description"))):
            return self.drop("credits name other rights holders, music or narration")
        movies, pictures = [], []
        for g in groups:
            for entry in g.get("items") or []:
                inst = entry.get("instance") or {}
                if inst.get("media_type") == "Movie":
                    movies.append(inst)
                elif inst.get("media_type") == "Image":
                    pictures.append(inst)
        video = self.pick_video(movies)
        if not video:
            return self.drop("no unlabelled MP4 or WebM at 1080p or 4K")
        if fits_screen(video["width"], video["height"]):
            return self.drop(fits_screen(video["width"], video["height"]))
        thumb = self.pick_thumb(pictures, page.get("main_image"))
        if not thumb:
            return self.drop("no preview picture")
        names = [p.get("name") for c in page.get("credits") or [] for p in c.get("people") or []]
        caption = next((clean(g["caption"]) for g in groups if clean(g.get("caption")).lower().startswith("credit:")), "")
        author = caption.split(":", 1)[1].strip() if caption else "NASA's Scientific Visualization Studio"
        url = self.https(page.get("url")) or f"https://svs.gsfc.nasa.gov/{page['id']}/"
        text = " ".join([title, clean(page.get("description")), " ".join(page.get("keywords") or []), " ".join(names)])
        earthy = re.search(r"\b(earth|ocean|sea|cloud|aurora|ice|atmosphere|night lights|city lights|blue marble|planet)\b", title + " " + " ".join(page.get("keywords") or []), re.I)
        return {
            "id": f"svs-{page['id']}",
            "title": title,
            "author": author,
            "kind": "video",
            "category": "earth" if earthy and not re.search(r"\b(sun|solar|moon|lunar|nebula|galax\w*|milky way|mars|jupiter|saturn|venus)\b", title, re.I) else "space",
            "source": "NASA Scientific Visualization Studio",
            "sourceUrl": url,
            "license": "Public Domain",
            "licenseUrl": NASA_TERMS,
            "credit": f"“{title}”, {author}. NASA's Scientific Visualization Studio, {url}. Public domain (NASA).",
            "thumb": self.https(thumb["url"]),
            "file": self.https(video["url"]),
            "width": video["width"], "height": video["height"],
            "duration": 0,
            "codec": video["codec"],
            "_text": text,
        }

    def pick_video(self, movies):
        """One file per page: H.264 MP4 at 1920x1080 first, other 1080p next, 4K last, never a labelled cut."""
        best = None
        for m in movies:
            name = m.get("filename") or ""
            stem = name.rsplit(".", 1)[0]
            ext = name.rsplit(".", 1)[-1].lower()
            if ext not in ("mp4", "webm") or self.LABELLED.search(stem) or not m.get("width"):
                continue
            low = name.lower()
            codec = "vp9" if ext == "webm" else "hevc" if re.search(r"hevc|h265|x265|hvc", low) else "av1" if "av1" in low else "h264"
            w, h = m["width"], m["height"]
            rank = (0 if (w, h) == (1920, 1080) and codec == "h264" else
                    1 if w == 1920 and codec == "h264" else
                    2 if (w, h) == (3840, 2160) and codec == "h264" else
                    3 if w in (1920, 3840) else 9)
            if rank < 9 and (best is None or rank < best[0]):
                best = (rank, {"url": m["url"], "width": w, "height": h, "codec": codec})
        return best[1] if best else None

    @staticmethod
    def pick_thumb(pictures, main):
        jpegs = [p for p in pictures if (p.get("filename") or "").lower().endswith((".jpg", ".jpeg", ".png"))]
        good = [p for p in jpegs if 500 <= (p.get("width") or 0) <= 1300 and (p.get("height") or 0) and p["width"] / p["height"] > 1.2]
        if good:
            return max(good, key=lambda p: (p["filename"].lower().endswith(".jpg"), p["width"]))
        return main if main and main.get("url") else (jpegs[0] if jpegs else None)


# --------------------------------------------------------------------------------------------
# The Cleveland Museum of Art: CC0 open access

COLOUR = re.compile(r"colou?r|watercolou?r|gouache|pastel|oil|tempera|chromolithograph", re.I)


class Cleveland(Source):
    name = "cleveland"
    published = set()  # ids in the catalogue before this build, set by build()
    # (search words, type, department, pages of 100); the type and department filters are the API's own
    JAPAN, CHINA = "Japanese Art", "Chinese Art"
    SEARCHES = [
        # the first catalogue's searches, kept so its items stay
        ("hiroshige", "Print", None, 1), ("hokusai", "Print", None, 1), ("eisen landscape", "Print", None, 1),
        ("yoshida hiroshi", "Print", None, 1), ("tsuchiya koitsu", "Print", None, 1),
        ("landscape", "Painting", None, 1), ("monet", "Painting", None, 1), ("turner", None, None, 1),
        ("bierstadt", "Painting", None, 1), ("frederic edwin church", "Painting", None, 1),
        ("thomas cole", "Painting", None, 1), ("caspar david friedrich", None, None, 1),
        ("corot", "Painting", None, 1), ("inness", "Painting", None, 1), ("seascape", "Painting", None, 1),
        ("river", "Painting", None, 1), ("mountains", "Painting", None, 1),
        # ukiyo-e and shin-hanga landscapes (Kawase Hasui died 1957 and is dropped by the term rule)
        ("hiroshige", "Print", JAPAN, 3), ("hiroshige II", "Print", JAPAN, 1), ("hokusai", "Print", JAPAN, 2),
        ("kuniyoshi landscape", "Print", JAPAN, 1), ("kiyochika", "Print", JAPAN, 1), ("eisen", "Print", JAPAN, 1),
        ("hokuju", "Print", JAPAN, 1), ("hiroshi yoshida", "Print", JAPAN, 1), ("koitsu", "Print", JAPAN, 1),
        ("landscape", "Print", JAPAN, 2), ("view", "Print", JAPAN, 2), ("snow", "Print", JAPAN, 1),
        ("moon", "Print", JAPAN, 1), ("river", "Print", JAPAN, 1), ("bridge", "Print", JAPAN, 1),
        ("waterfall", None, JAPAN, 1), ("mount fuji", None, JAPAN, 1),
        # Japanese and Chinese landscape painting (handscrolls and album leaves are landscape format)
        ("landscape", "Painting", JAPAN, 2), ("landscape", "Painting", CHINA, 3), ("mountains", "Painting", CHINA, 1),
        ("river", "Painting", CHINA, 1), ("handscroll", "Painting", CHINA, 1), ("album leaf", "Painting", CHINA, 1),
        # Western landscape and seascape painting, drawing and printmaking
        ("landscape", "Painting", None, 3), ("seascape", None, None, 1), ("coast", "Painting", None, 1),
        ("harbor", "Painting", None, 1), ("forest", "Painting", None, 1), ("winter", "Painting", None, 1),
        ("sunset", "Painting", None, 1), ("moonlight", None, None, 1), ("valley", "Painting", None, 1),
        ("lake", "Painting", None, 1), ("landscape", "Drawing", None, 2), ("landscape", "Print", None, 2),
        # painters and printmakers by school, all died before 1956
        ("kensett", None, None, 1), ("gifford", None, None, 1), ("durand", None, None, 1), ("cropsey", None, None, 1),
        ("heade", None, None, 1), ("fitz henry lane", None, None, 1), ("thomas moran", None, None, 1),
        ("twachtman", None, None, 1), ("wyant", None, None, 1), ("homer dodge martin", None, None, 1),
        ("tryon", None, None, 1), ("winslow homer", None, None, 1),
        ("daubigny", None, None, 1), ("theodore rousseau", None, None, 1), ("jules dupre", None, None, 1),
        ("diaz de la pena", None, None, 1), ("harpignies", None, None, 1), ("boudin", None, None, 1),
        ("ruisdael", None, None, 1), ("hobbema", None, None, 1), ("van goyen", None, None, 1), ("cuyp", None, None, 1),
        ("van de velde", None, None, 1), ("van der neer", None, None, 1), ("koninck", None, None, 1),
        ("cotman", None, None, 1), ("girtin", None, None, 1), ("david cox", None, None, 1), ("de wint", None, None, 1),
        ("constable", None, None, 1), ("bonington", None, None, 1),
        ("sisley", None, None, 1), ("pissarro", None, None, 1), ("monet", None, None, 1), ("cezanne landscape", None, None, 1),
        ("jongkind", None, None, 1), ("dahl", None, None, 1), ("carus", None, None, 1), ("blechen", None, None, 1),
        ("whistler", "Print", None, 1), ("seymour haden", "Print", None, 1), ("meryon", "Print", None, 1),
    ]

    def candidates(self):
        seen = set()
        for words, kind, department, pages in self.SEARCHES:
            for page in range(pages):
                query = {"q": words, "cc0": "", "has_image": 1, "limit": 100}
                if kind:
                    query["type"] = kind
                if department:
                    query["department"] = department
                if page:
                    query["skip"] = page * 100
                url = "https://openaccess-api.clevelandart.org/api/artworks/?" + urllib.parse.urlencode(query)
                found = self.net.json(url).get("data", [])
                for art in found:
                    if art["id"] in seen:
                        continue
                    seen.add(art["id"])
                    self.considered += 1
                    item = self.item(art, None)
                    if item:
                        yield item
                if len(found) < 100:
                    break

    def item(self, art, category):
        if art.get("share_license_status") != "CC0":
            return self.drop("not CC0")
        title = clean(art.get("title"))
        if not title or NO_TITLE.match(title):
            return self.drop("no real title")
        creators = art.get("creators") or []
        why = free_in_eu([year(c.get("death_year")) for c in creators], art.get("creation_date_latest"))
        if why:
            return self.drop(why)
        images = art.get("images") or {}
        web, prints = images.get("web") or {}, images.get("print") or {}
        if not web.get("url") or not prints.get("url"):
            return self.drop("no web and print image")
        width, height = int(prints.get("width") or 0), int(prints.get("height") or 0)
        if fits_screen(width, height):
            return self.drop(fits_screen(width, height))
        # an accession number with a third part (1981.57.2) is one panel or section of a larger object,
        # unless the record calls it an album leaf, which is a complete picture of its own; a handscroll
        # section stays a section even when it is mounted as a leaf
        record = " ".join([title, art.get("technique") or "", clean(art.get("tombstone"))])
        part = re.fullmatch(r"\d+\.\d+\.\d+.*", art.get("accession_number", "")) and (
            not re.search(r"\balbum leaf\b|\bleaf from\b", record, re.I) or re.search(r"\bhandscroll\b", record, re.I))
        kind = art.get("type") or ""
        # these collections hold mostly religious and epic narrative scenes, which the word lists
        # cannot judge (an Indian miniature with "landscape" in its description may show a battle)
        if art.get("department") in ("Indian and Southeast Asian Art", "Islamic Art", "African Art", "Medieval Art",
                                     "Egyptian and Ancient Near Eastern Art", "Greek and Roman Art"):
            return self.drop("narrative or religious collection")
        if kind not in ("Painting", "Print", "Drawing"):
            return self.drop(f"not a painting, print or drawing ({kind or 'no type'})")
        # Black-and-white etchings and pencil drawings sit small on a large pale sheet and make poor
        # wallpapers. Western prints and drawings are taken in colour media only. Items already
        # published stay, so the catalogue does not shrink under its users; the exclusion list is
        # the way to remove them.
        technique = (art.get("technique") or "").lower()
        eastern = art.get("department") in ("Japanese Art", "Chinese Art", "Korean Art")
        if kind in ("Print", "Drawing") and not eastern and not COLOUR.search(technique) \
                and "cma-" + slug(art.get("accession_number", "")) not in self.published:
            return self.drop("monochrome print or drawing")
        if MULTI_PART.search(title) or part:
            return self.drop("multi-part object")
        japanese = "Japan" in " ".join(art.get("culture") or []) or art.get("department") == "Japanese Art"
        category = "japan" if japanese else "landscape"
        text = " ".join([title, clean(art.get("description")), art.get("type") or "", art.get("technique") or "",
                         " ".join(art.get("alternate_titles") or [])])
        if not is_landscape(text, japanese):
            return self.drop("not a landscape")
        author = "; ".join(filter(None, (clean(c.get("description")) for c in creators))) or "Unknown"
        date = clean(art.get("creation_date"))
        url = art.get("url") or f"https://clevelandart.org/art/{art['accession_number']}"
        return {
            "id": "cma-" + slug(art["accession_number"]),
            "title": title,
            "author": author,
            "kind": "image",
            "category": category,
            "source": "The Cleveland Museum of Art",
            "sourceUrl": url,
            "license": "CC0 1.0",
            "licenseUrl": CC0,
            "credit": f"“{title}”{', ' + date if date else ''}, {author}. The Cleveland Museum of Art, "
                      f"{clean(art.get('creditline'))}. CC0 1.0.".replace(", .", "."),
            "thumb": web["url"],
            "file": prints["url"],
            "width": width, "height": height,
            "duration": 0, "codec": "",
            "_text": text,
        }


LANDSCAPE_WORDS = re.compile(r"\b(" + "|".join([
    r"landscapes?", r"views?", r"vista", r"river\w*", r"lakes?", r"sea", r"seascape", r"coast\w*", r"mountains?",
    r"mount", r"mt\.?", r"valley", r"forests?", r"woods?", r"woodland", r"harbou?r", r"bay", r"sunset", r"sunrise",
    r"moon\w*", r"fields?", r"meadows?", r"gardens?", r"cliffs?", r"waterfalls?", r"falls", r"snow\w*", r"winter",
    r"autumn", r"spring", r"summer", r"storm", r"clouds?", r"beach", r"shore", r"bridge", r"road", r"village",
    r"morning", r"evening", r"twilight", r"night", r"water ?lil(?:y|ies)", r"pond", r"marsh", r"hills?",
    r"canal", r"venice", r"seine", r"thames", r"rain", r"mist\w*", r"fuji", r"stations?", r"tokaido", r"tōkaidō",
    r"kisokaido", r"kisokaidō", r"provinces", r"famous places", r"eight views", r"ferry", r"island", r"wave",
    r"pines?", r"cherry", r"plum", r"blossoms?", r"harvest", r"pasture", r"glacier", r"desert", r"canyon",
    r"rocks?", r"stream", r"brook", r"fjord", r"heath", r"dunes?", r"lagoon", r"port", r"pier",
    r"landskab\w*", r"udsigt", r"skov\w*", r"sø", r"søen", r"hav\w*", r"kyst\w*", r"bjerg\w*", r"aften",
    r"morgen", r"strand\w*", r"vinter\w*", r"mark", r"eng", r"å", r"fjord\w*", r"parti", r"bakke\w*", r"klit\w*",
]) + r")\b", re.I)
FIGURE_WORDS = re.compile(r"\b(actors?|kabuki|beauty|beauties|geisha|portrait|surimono|warriors?|heroes|kuniyoshi|kunisada|still life|"
                          r"christ|baptism|saints?|madonna|virgin|annunciation|holy family|apostles?|burning|fire|calligraphy)\b", re.I)


def is_landscape(text, japanese):
    if FIGURE_WORDS.search(text) and not (japanese and LANDSCAPE_WORDS.search(text.split(",")[0])):
        return False
    return bool(LANDSCAPE_WORDS.search(text))


# --------------------------------------------------------------------------------------------
# The Metropolitan Museum of Art: CC0 open access

class Met(Source):
    name = "met"
    SEARCHES = [("Hiroshige", 6, "japan"), ("Hokusai", 6, "japan"), ("landscape", 11, "landscape"),
                ("landscape", 1, "landscape")]  # departments: 6 Asian Art, 11 European Paintings, 1 American Wing
    PER_SEARCH = 60

    def candidates(self):
        seen, probed = set(), None
        for words, department, category in self.SEARCHES:
            url = "https://collectionapi.metmuseum.org/public/collection/v1.1/search?" + urllib.parse.urlencode(
                {"q": words, "hasImages": "true", "departmentId": department})
            ids = [i for i in (self.net.json(url).get("objectIDs") or [])[: self.PER_SEARCH] if i not in seen]
            seen.update(ids)
            for object_id in ids:
                self.considered += 1
                if probed is False:
                    self.drop("image host answers with a web page (bot challenge)")
                    continue
                obj = self.net.json(f"https://collectionapi.metmuseum.org/public/collection/v1/objects/{object_id}")
                if probed is None and obj.get("primaryImageSmall"):
                    # one look at the image host before asking for hundreds of objects
                    probed = self.net.head(obj["primaryImageSmall"])["ok"]
                    if not probed:
                        self.drop("image host answers with a web page (bot challenge)")
                        continue
                item = self.item(obj, category)
                if item:
                    yield item

    def item(self, obj, category):
        if not obj.get("isPublicDomain"):
            return self.drop("not public domain")
        title = clean(obj.get("title"))
        if not title or NO_TITLE.match(title):
            return self.drop("no real title")
        constituents = obj.get("constituents") or []
        ends = [year(e) for e in (obj.get("artistEndDate") or "").split("|")] if obj.get("artistEndDate") else []
        why = free_in_eu([e if e != 9999 else None for e in ends] if constituents else [])
        if why:
            return self.drop(why)
        if not obj.get("primaryImage") or not obj.get("primaryImageSmall"):
            return self.drop("no image")
        # The API has no pixel size. The physical measurements give the shape; the pixel size is read
        # from the file with --hash. Until then the item cannot pass the width check.
        size = next((m.get("elementMeasurements") or {} for m in obj.get("measurements") or [] if m.get("elementName") == "Overall"), {})
        if size.get("Width") and size.get("Height") and not 1.3 <= size["Width"] / size["Height"] <= 2.4:
            return self.drop("not landscape 1.3 to 2.4")
        if MULTI_PART.search(title + " " + (obj.get("objectName") or "")):
            return self.drop("multi-part object")
        if not self.hashing:
            return self.drop("pixel size unknown until a --hash run")
        japanese = obj.get("culture") == "Japan" or category == "japan"
        tags = " ".join(t.get("term", "") for t in obj.get("tags") or [])
        text = " ".join([title, obj.get("objectName") or "", obj.get("classification") or "", obj.get("medium") or "", tags])
        if not is_landscape(text, japanese):
            return self.drop("not a landscape")
        author = clean(obj.get("artistDisplayName")) or "Unknown"
        bio = clean(obj.get("artistDisplayBio"))
        date = clean(obj.get("objectDate"))
        return {
            "id": f"met-{obj['objectID']}",
            "title": title,
            "author": author + (f" ({bio})" if bio else ""),
            "kind": "image",
            "category": "japan" if japanese else "landscape",
            "source": "The Metropolitan Museum of Art",
            "sourceUrl": obj.get("objectURL") or f"https://www.metmuseum.org/art/collection/search/{obj['objectID']}",
            "license": "CC0 1.0",
            "licenseUrl": CC0,
            "credit": f"“{title}”{', ' + date if date else ''}, {author}. The Metropolitan Museum of Art, "
                      f"{clean(obj.get('creditLine'))}. CC0 1.0.".replace(", .", "."),
            "thumb": obj["primaryImageSmall"],
            "file": obj["primaryImage"],
            "width": 0, "height": 0,
            "duration": 0, "codec": "",
            "_text": text,
        }


# --------------------------------------------------------------------------------------------
# SMK, the National Gallery of Denmark: public domain

class Smk(Source):
    name = "smk"
    SEARCHES = ["landskab", "Caspar David Friedrich", "J.C. Dahl", "Christen Købke", "C.W. Eckersberg",
                "J.Th. Lundbye", "P.C. Skovgaard", "Vilhelm Kyhn", "Thorald Brendstrup", "Godfred Christensen",
                "Janus la Cour", "Anton Melbye", "Holger Drachmann", "kyst", "skov", "aften", "vinter"]
    IIIF_WIDTH = 3840  # the size we ask SMK's IIIF server for; it scales the original

    def candidates(self):
        seen = set()
        for words in self.SEARCHES:
            url = "https://api.smk.dk/api/v1/art/search/?" + urllib.parse.urlencode(
                {"keys": words, "filters": "[has_image:true],[public_domain:true]", "offset": 0, "rows": 100, "lang": "en"})
            for art in self.net.json(url).get("items") or []:
                if art["object_number"] in seen:
                    continue
                seen.add(art["object_number"])
                self.considered += 1
                item = self.item(art)
                if item:
                    yield item

    @staticmethod
    def title(art):
        titles = art.get("titles") or []
        english = [t for t in titles if (t.get("language") or "").lower() in ("engelsk", "english", "en")]
        return clean((english or titles or [{}])[0].get("title"))

    def item(self, art):
        if not art.get("public_domain"):
            return self.drop("not public domain")
        title = self.title(art)
        if not title or NO_TITLE.match(title):
            return self.drop("no real title")
        names = " ".join(n.get("name", "") for n in art.get("object_names") or []).lower()
        if not re.search(r"maleri|painting", names):
            return self.drop("not a painting")
        creators = art.get("production") or []
        why = free_in_eu([year(c.get("creator_date_of_death")) for c in creators])
        if why:
            return self.drop(why)
        if (art.get("number_of_parts") or 1) > 1 or MULTI_PART.search(title):
            return self.drop("multi-part object")
        base = art.get("image_iiif_id")
        if not base:
            return self.drop("no IIIF image")
        width, height = art.get("image_width") or 0, art.get("image_height") or 0
        if width > self.IIIF_WIDTH:
            height, width = round(height * self.IIIF_WIDTH / width), self.IIIF_WIDTH
            file = f"{base}/full/{self.IIIF_WIDTH},/0/default.jpg"
        else:
            file = f"{base}/full/full/0/default.jpg"
        if fits_screen(width, height):
            return self.drop(fits_screen(width, height))
        all_titles = " ".join(t.get("title", "") for t in art.get("titles") or [])
        text = " ".join([all_titles, flatten(art.get("content_subject")), flatten(art.get("labels")),
                         flatten(art.get("content_description")), names])
        if not is_landscape(all_titles, False):
            return self.drop("not a landscape")
        author = "; ".join(f'{c.get("creator_forename", "")} {c.get("creator_surname", "")}'.strip() or c.get("creator", "")
                           for c in creators) or "Unknown"
        dates = art.get("production_date") or [{}]
        date = clean(dates[0].get("period"))
        number = art["object_number"]
        url = art.get("frontend_url") or f"https://open.smk.dk/artwork/image/{number}"
        return {
            "id": "smk-" + slug(number),
            "title": title,
            "author": author,
            "kind": "image",
            "category": "landscape",
            "source": "SMK – Statens Museum for Kunst",
            "sourceUrl": url,
            "license": "Public Domain",
            "licenseUrl": PD_MARK,
            "credit": f"“{title}”{', ' + date if date else ''}, {author}. SMK – Statens Museum for Kunst, "
                      f"{number}, open.smk.dk. Public domain.",
            "thumb": f"{base}/full/800,/0/default.jpg",
            "file": file,
            "width": width, "height": height,
            "duration": 0, "codec": "",
            "_text": text,
        }


# --------------------------------------------------------------------------------------------
# ESA/Hubble, ESA/Webb and ESO: CC BY 4.0, no API; title, credit and sizes come from each image page

def with_stop(text):
    return text if text.endswith((".", "!", "?")) else text + "."


class EsaImages(Source):
    """Images from the djangoplicity archives of ESA/Hubble, ESA/Webb and ESO. Picks the 3840x2160
    desktop wallpaper if there is one; else the larger of the publication JPEG and the large JPEG
    that is landscape, at least 1920 wide and at most 40 MP. Pixel sizes come from the first 64 KB
    of each JPEG; if that fails, from what the page states (it states only the original's size,
    which is the large JPEG's). The credit line is the image's own, unaltered, as the sites ask."""
    name = ""
    site = ""        # the image pages: https://<site>/images/<id>/
    media = ""       # the files: <media>/<variant>/<id>.jpg
    label = ""
    IDS = []

    def candidates(self):
        for image_id in self.IDS:
            self.considered += 1
            item = self.from_page(image_id)
            if item:
                yield item

    def from_page(self, image_id):
        page_url = f"https://{self.site}/images/{image_id}/"
        try:
            page = self.net.text(page_url, ".html")
        except urllib.error.HTTPError as e:
            return self.drop(f"page HTTP {e.code}")
        return self.item(image_id, page_url, page)

    def choose(self, variants, size):
        """(url, width, height) of the file to offer, or the reason there is none."""
        if "wallpaper_uhd" in variants:
            return variants["wallpaper_uhd"], 3840, 2160
        options, reason = [], "no wallpaper or large JPEG"
        for kind in ("publicationjpg", "large"):
            if kind not in variants:
                continue
            dims = self.net.jpeg_size(variants[kind])
            if not dims and kind == "large" and size:
                dims = int(size[1]), int(size[2])
            if not dims:
                reason = "pixel size unknown"
                continue
            why = fits_screen(*dims)
            if why:
                reason = why
            else:
                options.append((dims[0] * dims[1], variants[kind], dims[0], dims[1]))
        return max(options)[1:] if options else reason

    def page_facts(self, image_id, page):
        h1 = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.S)
        credit = re.search(r'<div class="credit">(.*?)</div>', page, re.S)
        if not h1 or not credit:
            return None
        size = re.search(r"Size:\s*</t[hd]>\s*<td[^>]*>\s*(\d+)\s*x\s*(\d+)\s*px", page)
        links = set(re.findall(r'href="(%s/([a-z0-9_]+)/%s\.jpg)"' % (re.escape(self.media), re.escape(image_id)), page))
        cell = re.search(r"Category:\s*</t[hd]>\s*<td[^>]*>(.*?)</td>", page, re.S)
        after = page[h1.end():]
        description = clean(after[: after.find("Credit:")] if "Credit:" in after else "")[:2000]
        return {"title": clean(h1[1]), "credit": clean(credit[1]), "size": size,
                "variants": {kind: url for url, kind in links},
                "categories": set(re.findall(r'category/[a-z0-9-]+/">([^<]+)</a>', cell[1])) if cell else set(),
                "description": description}

    def item(self, image_id, page_url, page, category="space"):
        facts = self.page_facts(image_id, page)
        if not facts:
            return self.drop("page has no title or credit")
        title, credit = facts["title"], facts["credit"]
        if ILLUSTRATION.search(title):
            return self.drop("illustration, chart or annotated")
        chosen = self.choose(facts["variants"], facts["size"])
        if isinstance(chosen, str):
            return self.drop(chosen)
        file, width, height = chosen
        thumb = facts["variants"].get("screen") or f"{self.media}/screen/{image_id}.jpg"
        return {
            "id": f"{self.name}-{slug(image_id)}",
            "title": title,
            "author": credit,
            "kind": "image",
            "category": category,
            "source": self.label,
            "sourceUrl": page_url,
            "license": "CC BY 4.0",
            "licenseUrl": CC_BY,
            "credit": f"“{title}”. Credit: {with_stop(credit)} {self.label}, CC BY 4.0.",
            "thumb": thumb,
            "file": file,
            "width": width, "height": height,
            "duration": 0, "codec": "",
            "_text": title,
        }


ILLUSTRATION = re.compile(r"\b(artist\w*|illustrations?|impressions?|render\w*|simulat\w*|diagrams?|charts?|maps?|annotated|"
                          r"labell?ed|graphics?|comparisons?|infographic|mock-?up|concept|360|fulldome|"
                          r"compass|scale|before and after|animation|highlights|excerpts|composite of|several wavelengths|"
                          r"side[- ]by[- ]side|showing the|field[- ]of[- ]view)\b", re.I)


class EsaHubble(EsaImages):
    name, site, media, label = "esahubble", "esahubble.org", "https://cdn.esahubble.org/archives/images", "ESA/Hubble"
    IDS = [
        "heic2007a", "heic1509a", "heic1501a", "heic2018b", "heic0715a", "heic1608a", "potw1345a", "heic1307a",
        "heic0817a", "heic0406a", "potw2049a", "opo0328a", "heic0702a", "heic0515a", "heic1808a", "potw1811a",
        "heic0910h", "heic0601a", "heic0514a", "heic0506a", "heic0506b", "opo0511a", "heic0503a", "opo0501a",
        "heic0206a", "heic0206c", "heic0109a", "opo0006a", "heic2105a", "heic1302a", "heic1105a", "heic1104a",
        "heic1007a", "heic0910s", "heic0910i", "heic0905a", "heic0707a", "heic0706a", "opo0624a", "heic0604a",
        "heic0602a", "opo0028a", "opo9941a", "potw2114a", "potw2108a", "potw2036a", "heic1516a", "heic1310a",
        "heic0411a", "potw2110a", "potw1441a", "heic1406a", "heic1305a", "heic1110a", "opo0010a", "potw1932a",
        "potw1847a", "potw2144a", "heic1907a", "potw1849a", "heic1811a", "potw1751a", "heic1712a", "heic1520a",
        "heic1518a", "heic1502a", "opo1438b", "heic0910e", "potw2044a", "potw2006a", "potw1940a", "heic2017a",
        "heic1917a",
    ]


class EsaWebb(EsaImages):
    name, site, media, label = "esawebb", "esawebb.org", "https://cdn.esawebb.org/archives/images", "ESA/Webb"
    IDS = [
        "weic2619a", "weic2425a", "potm2510a", "potm2503a", "potm2208a", "potm2209a", "weic2218a", "weic2216b",
        "carinanebula3", "potm2610a", "weic2620a", "potm2609a", "potm2608a", "weic2617a", "weic2616a", "potm2607a",
        "weic2615a", "potm2606a", "weic2612a", "weic2611a", "potm2605a", "potm2604a", "weic2608a", "potm2602a",
        "potm2601a", "weic2601a", "potm2512a", "potm2511a", "potm2509a", "weic2520a", "weic2519a", "weic2518a",
        "potm2508a", "weic2517b", "potm2507a", "weic2514a", "weic2513a", "potm2506a", "potm2505a", "potm2504a",
        "weic2506a", "weic2503a", "potm2502a", "potm2501a", "potm2412a", "weic2429a", "potm2411a", "weic2427a",
        "weic2426a", "potm2410a", "potm2409a", "weic2423a", "weic2422a", "potm2408a", "potm2407a", "weic2420a",
        "potm2406a", "weic2415a", "weic2417a", "potm2405a", "potm2404a", "weic2411a", "potm2403a", "weic2407a",
        "potm2402a", "potm2401a", "weic2331a", "weic2330a", "potm2312a", "weic2328a", "potm2311a", "weic2326a",
        "weic2324a",
    ]


class Eso(EsaImages):
    """ESO, the European Southern Observatory. Candidates come from ESO's own listings (the Top 100
    and archive categories), filtered by the size the listing states before any page is fetched.
    Deep-sky pictures go to Space; photographs of the observatory sites under the night sky go to
    Night sky. ESO's terms: the full, unaltered credit line, a link, no identifiable people, and
    pictures only (its videos need a burnt-in credit)."""
    name, site, media, label = "eso", "www.eso.org/public", "https://cdn.eso.org/images", "ESO"
    # (listing path under /public/images/archive/, pages of 50)
    LISTINGS = [("top100", 1), ("category/nebulae", 3), ("category/galaxies", 2), ("category/starclusters", 2),
                ("category/paranal", 4), ("category/lasilla", 2), ("category/alma", 2), ("category/apex", 1),
                ("category/chile", 1)]
    SKIP_CATEGORIES = {"Illustrations", "People and Events", "Premises", "ESO Supernova", "Fulldome",
                       "360 Panorama", "ELT", "Exoplanets", "Cosmology", "Quasars and Black Holes", "Solar System"}
    DEEP_SKY = {"Nebulae", "Galaxies", "Star Clusters", "Stars", "Galaxy Clusters"}
    SITES = {"Paranal", "La Silla", "ALMA", "APEX", "Chile"}
    PEOPLE = re.compile(r"\b(astronomers?|staff|visitors?|engineers?|technicians?|workers?|team|photographers?|people|"
                        r"persons?|man|woman|men|women|child(?:ren)?|kids|students?|director\w*|minister|president|"
                        r"king|queen|prince\w*|ambassadors?|guests?|crowd|group|ceremony|inauguration|visit\w*|"
                        r"meeting|award\w*|selfie|portrait|family|couple|himself|herself)\b", re.I)
    PLACES = re.compile(r"\b(construction|building|residencia|hotel|office|headquarters|control room|interior|inside|"
                        r"workshop|warehouse|truck|vehicle|crane|first stone|opening|anniversary|celebration|"
                        r"exhibition|planetarium|installation|transport\w*|arrival|mirror|segment|lifting|"
                        r"maintenance|aerial|drone|camp|kitchen|cafeteria|logo|instruments?|windscreens?|"
                        r"technology|transporter|en route)\b", re.I)
    NIGHT = re.compile(r"\b(night\w*|stars?|starry|star trails|milky way|galac\w*|magellanic|sky|skies|aurora|moon\w*|"
                       r"twilight|dusk|dawn|zodiacal|airglow|laser\w*|comets?|meteors?|nebula\w*|constellations?|"
                       r"eclipse|planets?|venus|jupiter|orion|southern cross|celestial|cosmos|universe|nocturnal)\b", re.I)

    def candidates(self):
        seen = []
        for path, pages in self.LISTINGS:
            for n in range(1, pages + 1):
                suffix = "" if n == 1 else f"list/{n}/"
                listing = self.net.text(f"https://www.eso.org/public/images/archive/{path}/{suffix}", ".html")
                for m in re.finditer(r"id: '([a-z0-9-]+)',\s*title: '[^']*',\s*width: (\d+),\s*height: (\d+)", listing):
                    if m[1] not in (s[0] for s in seen):
                        seen.append((m[1], int(m[2]), int(m[3])))
                if path == "top100":  # the Top 100 page has no list of sizes, only links
                    for m in re.finditer(r'href="/public/images/([a-z0-9-]+)/"', listing):
                        if m[1] not in ("search", "comparisons", "potw", "viewall") and m[1] not in (s[0] for s in seen):
                            seen.append((m[1], 0, 0))
        for image_id, width, height in seen:
            self.considered += 1
            # ESO makes no 16:9 desktop crops, so the original's shape is the shape of every JPEG
            if width and height and not 1.3 <= width / height <= 2.4:
                self.drop("not landscape 1.3 to 2.4 (listing)")
                continue
            if width and width < 1920:
                self.drop("narrower than 1920 px (listing)")
                continue
            item = self.from_page(image_id)
            if item:
                yield item

    def item(self, image_id, page_url, page, category="space"):
        facts = self.page_facts(image_id, page)
        if not facts:
            return self.drop("page has no title or credit")
        cats = facts["categories"]
        first = facts["title"] + " " + re.split(r"(?<=[.!?])\s", facts["description"], 1)[0]
        if cats & self.SKIP_CATEGORIES:
            return self.drop("ESO category: " + sorted(cats & self.SKIP_CATEGORIES)[0])
        if not re.search(r"\bESO\b", facts["credit"]):
            return self.drop("credit does not name ESO (other rights holder)")
        if self.PEOPLE.search(first):
            return self.drop("people in the picture")
        if self.PLACES.search(facts["title"]):
            return self.drop("buildings, events or equipment as the subject")
        if cats & self.DEEP_SKY:
            category = "space"
        elif cats & self.SITES:
            if not self.NIGHT.search(first):  # the title or the caption's first sentence
                return self.drop("site photo without night sky")
            category = "nightsky"
        else:
            return self.drop("ESO category not wanted: " + (", ".join(sorted(cats)) or "none"))
        item = super().item(image_id, page_url, page, category)
        if item:
            item["_text"] = first
        return item


# --------------------------------------------------------------------------------------------
# Our own mirror: freely licensed desktop art, loops and scenes in the public repository
# Hamido212/kumo-wallpapers, served by raw.githubusercontent.com

# Licence names as other tools write them -> the names of the allow-list
LICENSE_NAMES = {
    "public domain": "Public Domain", "pd": "Public Domain", "pdm": "Public Domain", "pdm 1.0": "Public Domain",
    "cc0": "CC0 1.0", "cc0 1.0": "CC0 1.0", "cc0-1.0": "CC0 1.0",
    "cc by 4.0": "CC BY 4.0", "cc-by-4.0": "CC BY 4.0", "cc by-4.0": "CC BY 4.0",
    "cc by-sa 4.0": "CC BY-SA 4.0", "cc-by-sa-4.0": "CC BY-SA 4.0", "cc by sa 4.0": "CC BY-SA 4.0",
    "mit": "MIT", "mit license": "MIT",
}
LICENSE_URLS = {"Public Domain": PD_MARK, "CC0 1.0": CC0, "CC BY 4.0": CC_BY, "CC BY-SA 4.0": CC_BY_SA, "MIT": MIT}
MIRROR_PATH = re.compile(r"[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*")


def license_name(text):
    """The allow-list name for a licence as a tool or a person wrote it, or the text unchanged."""
    key = re.sub(r"\s+", " ", str(text or "").replace("_", "-").strip().lower())
    return LICENSE_NAMES.get(key, str(text or "").strip())


def license_url(name, url):
    """The page for an allowed licence: the given one if it is one of the allow-list's (ignoring
    http and a deed suffix), else the canonical page."""
    url = re.sub(r"^http://", "https://", str(url or "").strip())
    url = re.sub(r"(deed|legalcode)(\.[a-z-]+)?$", "", url)
    if url and not url.endswith("/") and "creativecommons.org" in url:
        url += "/"
    allowed = LICENSES.get(name, set())
    return url if url in allowed else LICENSE_URLS.get(name, url)


def is_mirrored(item):
    return str(item.get("file", "")).startswith(MIRROR_URL)


def source_of(item):
    """The name of the Source that made a catalogue item: 'mirror' for our own files, else from the id prefix."""
    if is_mirrored(item):
        return "mirror"
    prefix = item["id"].split("-")[0]
    return {"cma": "cleveland"}.get(prefix, prefix)


def sniff(head):
    """'image', 'video' or 'scene' from a file's first bytes, the same signatures the app checks."""
    if head[:3] == b"\xff\xd8\xff" or head[:8] == b"\x89PNG\r\n\x1a\n" or (head[:4] == b"RIFF" and head[8:12] == b"WEBP"):
        return "image"
    if head[:4] == b"KUMO":
        return "scene"
    if head[4:8] == b"ftyp" or head[:4] == b"\x1a\x45\xdf\xa3":
        return "video"
    return None


class Mirror(Source):
    """The files we host ourselves, in the public repository Hamido212/kumo-wallpapers: freely
    licensed desktop art (pictures/), animated loops (loops/) and 3D scenes (scenes/). Each folder
    has an items.json written when its files were mirrored, with title, author, source, licence,
    credit, the changes we made, pixel size, bytes, sha256 and the file and preview paths. This
    source reads them from a local copy of the repository and points the catalogue at
    MIRROR_URL. The records come from different tools, so field names are read tolerantly and a
    missing items.json is skipped. Every mirror item carries bytes and sha256, which the app checks."""
    name = "mirror"
    folder = MIRROR_DIR
    local = False  # True: check against the local files instead of asking GitHub
    PARTS = [("pictures", "image", "desktop"), ("loops", "video", "loops"), ("scenes", "scene", "scenes")]

    def candidates(self):
        self.local_files = {}  # catalogue URL -> local path, for --mirror-local and the review sheet
        for part, kind, category in self.PARTS:
            path = self.folder / part / "items.json"
            if not path.exists():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                print(f"mirror: {part}/items.json is not valid JSON, skipped")
                continue
            records = data.get("items", []) if isinstance(data, dict) else data
            for record in records if isinstance(records, list) else []:
                self.considered += 1
                item = self.item(record, part, kind, category) if isinstance(record, dict) else self.drop("record is not an object")
                if item:
                    yield item

    def relpath(self, value, part):
        """A file's path inside the repository, from a path relative to the repository, to the
        part's folder, or a full mirror URL. None if it is not a plain relative path."""
        value = str(value or "").strip().replace("\\", "/")
        if value.startswith(MIRROR_URL):
            value = urllib.parse.unquote(value[len(MIRROR_URL):])
        if value.startswith("./"):
            value = value[2:]
        if not value or value.startswith("/") or ".." in value.split("/") or not MIRROR_PATH.fullmatch(value):
            return None
        if not (self.folder / value).exists() and (self.folder / part / value).exists():
            value = f"{part}/{value}"
        return value

    def item(self, rec, part, kind, category):
        def get(*keys):
            return next((rec[k] for k in keys if rec.get(k) not in (None, "")), "")

        item_id = str(get("id"))
        if not ID.fullmatch(item_id):
            return self.drop("id must match [a-z0-9-]{1,64}")
        kind = str(get("kind") or kind)
        if kind not in KINDS:
            return self.drop(f"unknown kind {kind}")
        if rec.get("revoked") is True:
            return self.drop("revoked in items.json")
        title, author = clean(get("title")), clean(get("author", "creator", "artist"))
        lic = license_name(get("license", "licence", "licenseName", "license_name"))
        if lic not in LICENSES:
            return self.drop(f"licence {lic or 'missing'} is not on the allow-list")
        file = self.relpath(get("path", "file", "mirrorPath", "mirror_path"), part)
        thumb = self.relpath(get("thumb", "preview", "previewPath", "preview_path", "thumbPath"), "thumbs/" + part)
        if not file or not thumb:
            return self.drop("no file or preview path inside the repository")
        size, digest = get("bytes"), str(get("sha256")).lower()
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0 or not re.fullmatch(r"[0-9a-f]{64}", digest):
            return self.drop("bytes or sha256 missing")
        try:
            width, height = int(get("width") or 0), int(get("height") or 0)
        except (TypeError, ValueError):
            return self.drop("width or height is not a number")
        if kind != "scene" and fits_screen(width, height):
            return self.drop(fits_screen(width, height))
        if kind == "video" and str(get("codec")) not in CODECS:
            return self.drop(f"video codec {get('codec') or 'missing'}")
        if not title or not author or not get("sourceUrl", "source_url", "sourcePage", "source_page", "page"):
            return self.drop("title, author or source page missing")
        credit = clean(get("credit", "creditLine", "credit_line"))
        changes = clean(get("changes"))
        if changes and changes.rstrip(".").lower() not in credit.lower():
            credit = f"{with_stop(credit)} {with_stop(changes)}" if credit else with_stop(changes)
        category = str(get("category"))
        if category not in {c["id"] for c in CATEGORIES}:
            category = {"pictures": "desktop", "loops": "loops", "scenes": "scenes"}[part]
        item = {
            "id": item_id,
            "title": title,
            "author": author,
            "kind": kind,
            "category": category,
            "source": clean(get("source", "sourceName", "source_name")),
            "sourceUrl": str(get("sourceUrl", "source_url", "sourcePage", "source_page", "page")),
            "license": lic,
            "licenseUrl": license_url(lic, get("licenseUrl", "licenceUrl", "license_url", "licence_url")),
            "credit": credit,
            "thumb": MIRROR_URL + urllib.parse.quote(thumb),
            "file": MIRROR_URL + urllib.parse.quote(file),
            "bytes": size,
            "width": width if kind != "scene" else 0, "height": height if kind != "scene" else 0,
            "duration": float(get("duration") or 0) if kind == "video" else 0,
            "codec": str(get("codec")) if kind == "video" else "",
            "sha256": digest,
            "_text": title,
        }
        self.local_files[item["file"]] = self.folder / file
        self.local_files[item["thumb"]] = self.folder / thumb
        return item

    def verify_local(self, item):
        """--mirror-local: the file and preview exist in the local copy, the file has exactly the
        bytes and sha256 of its record and the type of its kind, and both are under their caps."""
        file, thumb = self.local_files[item["file"]], self.local_files[item["thumb"]]
        if not thumb.is_file():
            return self.drop("preview: not in the local copy")
        if thumb.stat().st_size > CAPS["thumb"] or sniff(thumb.read_bytes()[:16]) != "image":
            return self.drop("preview: larger than 8 MB or not a picture")
        if not file.is_file():
            return self.drop("file: not in the local copy")
        if file.stat().st_size != item["bytes"]:
            return self.drop("file: size differs from items.json")
        if item["bytes"] > CAPS[item["kind"]]:
            return self.drop(f"file larger than the {CAPS[item['kind']] >> 20} MB cap")
        data = file.read_bytes()
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            return self.drop("file: sha256 differs from items.json")
        if sniff(data[:16]) != item["kind"]:
            return self.drop(f"file: not a {item['kind']} by its first bytes")
        return item


SOURCES = [Svs, Cleveland, EsaHubble, EsaWebb, Eso, Mirror]
# Not run by default. The Met's API works, but images.metmuseum.org answers automated requests with a
# bot-protection web page instead of the picture (November 2026), and the app would get the same page.
# Its host is also not on the app's list. It needs our own file mirror first; `--only met` still runs it.
# SMK is off too: iip.smk.dk renders every IIIF picture on demand. Previews took 0.5 to 6 s each and
# varied from request to request, and some 3840 px files sent no headers within 120 s. That is too
# slow and unreliable for downloads at runtime, and the output may not stay byte-identical, which
# breaks the exact `bytes` check. It needs our own file mirror first; `--only smk` still runs it.
DISABLED = [Met, Smk]


# --------------------------------------------------------------------------------------------
# Build

def read_exclusions():
    """tools/catalog-exclude.txt: one id per line removes the item; 'id revoked' keeps it in the
    catalogue marked revoked, so apps that downloaded it can remove it too. '#' starts a comment."""
    removed, revoked = set(), set()
    if EXCLUDE.exists():
        for line in EXCLUDE.read_text(encoding="utf-8").splitlines():
            words = line.split("#", 1)[0].split()
            if words:
                (revoked if words[1:2] == ["revoked"] else removed).add(words[0])
    return removed, revoked


def verify(net, source, item):
    """HEAD checks for the preview and the file; fills in bytes. Returns the item or None."""
    thumb = net.head(item["thumb"])
    if not thumb["ok"]:
        return source.drop("preview: " + thumb["reason"])
    if thumb["bytes"] > CAPS["thumb"]:
        return source.drop("preview larger than 8 MB")
    file = net.head(item["file"])
    if not file["ok"]:
        return source.drop("file: " + file["reason"])
    if not file["type"].startswith(item["kind"] + "/") and "octet-stream" not in file["type"]:
        return source.drop(f"file: content type {file['type']} for {item['kind']}")
    if file["bytes"] > CAPS[item["kind"]]:
        return source.drop(f"file larger than the {CAPS[item['kind']] >> 20} MB cap")
    if item.get("bytes") and item["bytes"] != file["bytes"]:  # mirror items know their size
        return source.drop("file: the server's size differs from items.json")
    item["bytes"] = file["bytes"]
    return item


def download(net, url):
    with net.open(url) as r:
        return r.read()


def media_facts(data):
    """Pixel size of a JPEG, or codec and seconds of an MP4, read from the downloaded bytes."""
    facts = {}
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data) and data[i] == 0xFF:
            marker, length = data[i + 1], int.from_bytes(data[i + 2:i + 4], "big")
            if marker in (0xC0, 0xC1, 0xC2):
                facts["height"], facts["width"] = int.from_bytes(data[i + 5:i + 7], "big"), int.from_bytes(data[i + 7:i + 9], "big")
                break
            i += 2 + length
    for tag, codec in ((b"avc1", "h264"), (b"hvc1", "hevc"), (b"hev1", "hevc"), (b"vp09", "vp9"), (b"av01", "av1")):
        if tag in data[: 64 << 20] or tag in data[-(64 << 20):]:
            facts["codec"] = codec
            break
    m = data.find(b"mvhd")
    if m > 0:
        version = data[m + 4]
        at = m + 4 + 4 + (16 if version == 1 else 8)
        scale = int.from_bytes(data[at:at + 4], "big")
        length = int.from_bytes(data[at + 4:at + (12 if version == 1 else 8)], "big")
        if scale:
            facts["duration"] = round(length / scale, 1)
    return facts


def hash_files(net, items):
    """--hash: downloads each file once (cached by URL) and fills in sha256 and what the bytes tell."""
    store = CACHE / "hashes.json"
    known = json.loads(store.read_text(encoding="utf-8")) if store.exists() else {}
    for n, item in enumerate(items, 1):
        if is_mirrored(item):  # our own files: bytes and sha256 come from items.json
            continue
        if item["file"] not in known:
            print(f"  hashing {n}/{len(items)} {item['id']}", flush=True)
            data = download(net, item["file"])
            known[item["file"]] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), **media_facts(data)}
            store.write_text(json.dumps(known, indent=1, sort_keys=True), encoding="utf-8")
        facts = known[item["file"]]
        item["sha256"], item["bytes"] = facts["sha256"], facts["bytes"]
        if not item["width"] and facts.get("width"):
            item["width"], item["height"] = facts["width"], facts["height"]
        if item["kind"] == "video":
            item["codec"] = facts.get("codec") or item["codec"]
            item["duration"] = facts.get("duration") or item["duration"]


RESIZE = r"""
Add-Type -AssemblyName System.Drawing
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L
Get-ChildItem -LiteralPath $args[0] -Filter *.src | ForEach-Object {
  $src = [System.Drawing.Image]::FromFile($_.FullName)
  $scale = [Math]::Max(480 / $src.Width, 270 / $src.Height)
  $w = $src.Width * $scale; $h = $src.Height * $scale
  $out = New-Object System.Drawing.Bitmap 480, 270
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.DrawImage($src, (480 - $w) / 2, (270 - $h) / 2, $w, $h)
  $out.Save([IO.Path]::ChangeExtension($_.FullName, '.jpg'), $codec, $params)
  $g.Dispose(); $out.Dispose(); $src.Dispose(); Remove-Item -LiteralPath $_.FullName
}
"""


def make_thumbs(net, items, folder):
    """--thumbs DIR: local 480x270 previews, cropped to fill, for hosting them ourselves later."""
    folder = pathlib.Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    for item in items:
        if not (folder / f"{item['id']}.jpg").exists():
            (folder / f"{item['id']}.src").write_bytes(download(net, item["thumb"]))
    subprocess.run(["powershell", "-NoProfile", "-Command", RESIZE, str(folder)], check=True)


def build(args):
    net = Net(args.user_agent, args.refresh)
    removed, revoked = read_exclusions()
    out = pathlib.Path(args.out) if args.out else OUT
    previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"items": []}
    Cleveland.published = {i["id"] for i in previous["items"]}
    Mirror.folder, Mirror.local = pathlib.Path(args.mirror), args.mirror_local
    kept, report, local_thumbs = [], [], {}
    for cls in SOURCES + [s for s in DISABLED if s.name == args.only]:
        if args.only and cls.name != args.only:
            kept += [i for i in previous["items"] if source_of(i) == cls.name]
            continue
        if cls is Mirror and not Mirror.folder.is_dir():
            # no local copy of the mirror on this machine: keep what the last build listed
            old = [i for i in previous["items"] if source_of(i) == "mirror"]
            print(f"mirror: {Mirror.folder} not found, keeping the {len(old)} mirror items of the last build")
            kept += old
            continue
        source = cls(net, args.hash)
        count = 0
        print(f"{source.name}: collecting", flush=True)
        for item in source.candidates():
            if item["id"] in removed or item["id"] in revoked:
                source.drop("excluded by hand")
                continue
            word = unsuitable(item["title"], item.pop("_text"))
            if word:
                source.drop(f"content filter ({word})")
                continue
            if item["license"] not in LICENSES:
                source.drop("licence not on the allow-list")
                continue
            if any(i["id"] == item["id"] for i in kept):
                source.drop("duplicate id")
                continue
            local = isinstance(source, Mirror) and source.local
            if source.verify_local(item) if local else verify(net, source, item):
                if local:
                    local_thumbs[item["thumb"]] = source.local_files[item["thumb"]]
                item.setdefault("sha256", "")
                item.setdefault("revoked", False)
                kept.append({k: item[k] for k in ITEM_FIELDS})
                count += 1
        net.save()
        report.append((source.name, source.considered, count, source.dropped))

    for old in previous["items"]:
        if old["id"] in revoked and not any(i["id"] == old["id"] for i in kept):
            kept.append({**old, "revoked": True})
    if args.hash:
        hash_files(net, [i for i in kept if not i["revoked"]])
        for item in list(kept):  # pixel sizes read from the files themselves get the same test
            why = fits_screen(item["width"], item["height"]) if item["kind"] != "scene" else None
            if why and not item["revoked"]:
                kept.remove(item)
                for name, considered, count, dropped in report:
                    if source_of(item) == name:
                        dropped[why] += 1
        report = [(n, c, sum(source_of(i) == n for i in kept), d) for n, c, _, d in report]
    if args.thumbs:
        make_thumbs(net, [i for i in kept if not i["revoked"]], args.thumbs)

    order = {c["id"]: n for n, c in enumerate(CATEGORIES)}
    kept.sort(key=lambda i: (order.get(i["category"], 99), i["source"], i["id"]))
    catalog = {"version": 1, "updated": previous.get("updated", ""), "categories": CATEGORIES, "items": kept}
    if catalog["items"] != previous.get("items") or not catalog["updated"]:
        catalog["updated"] = datetime.date.today().isoformat()
    text = json.dumps(catalog, ensure_ascii=False, indent=1) + "\n"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8", newline="\n")
    write_review(catalog, local_thumbs)

    print()
    for name, considered, count, dropped in report:
        print(f"{name}: {considered} considered, {count} kept")
        for reason, n in sorted(dropped.items(), key=lambda r: (-r[1], r[0])):
            print(f"    {n:4}  {reason}")
    by_category = Counter(i["category"] for i in kept if not i["revoked"])
    print("\nper category: " + ", ".join(f"{c['id']} {by_category[c['id']]}" for c in CATEGORIES))
    print("hosts: " + ", ".join(sorted({urllib.parse.urlsplit(i[k]).hostname for i in kept for k in ("thumb", "file")})))
    print(f"{len(kept)} items, {len(text.encode()) // 1024} KB, {net.requests} requests -> {out.resolve()}")
    print(f"contact sheet: {REVIEW.relative_to(ROOT)}")
    problems = check_catalog(catalog)
    for p in problems:
        print("ERROR " + p)
    return 1 if problems else 0


def write_review(catalog, local_thumbs=None):
    """A local contact sheet for a human pass: previews (from the source, or from the local copy of
    the mirror for files that are not published yet), title, credit and id."""
    cards = []
    for i in catalog["items"]:
        thumb = (local_thumbs or {}).get(i["thumb"])
        src = thumb.resolve().as_uri() if thumb else i["thumb"]
        cards.append(
            f'<figure{" class=revoked" if i["revoked"] else ""}><a href="{html.escape(i["sourceUrl"])}">'
            f'<img loading="lazy" src="{html.escape(src)}" alt=""></a><figcaption><b>{html.escape(i["title"])}</b>'
            f'<span>{html.escape(i["credit"])}</span><code>{i["id"]} · {i["category"]} · {i["kind"]} · '
            f'{i["width"]}x{i["height"]} · {i["bytes"] / 1e6:.1f} MB{" · " + i["codec"] if i["codec"] else ""}</code></figcaption></figure>')
    REVIEW.parent.mkdir(parents=True, exist_ok=True)
    REVIEW.write_text(f"""<!doctype html><meta charset="utf-8"><title>Kumo catalogue review</title>
<style>body{{font:14px system-ui;margin:24px;background:#111;color:#ddd}}main{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}}
figure{{margin:0;background:#1c1c1c;border-radius:8px;overflow:hidden}}img{{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#333}}
figcaption{{padding:10px;display:grid;gap:6px}}span{{color:#aaa;font-size:12px}}code{{font-size:11px;color:#8ab}}.revoked{{opacity:.35}}</style>
<h1>Kumo catalogue review: {len(catalog["items"])} items, {catalog["updated"]}</h1>
<p>Remove an item by adding its id to tools/catalog-exclude.txt and building again.</p><main>{"".join(cards)}</main>
""", encoding="utf-8")


# --------------------------------------------------------------------------------------------
# Check

def check_catalog(catalog):
    """Every format rule the app relies on. Returns a list of problems, empty when the file is good."""
    problems = []
    if catalog.get("version") != 1:
        problems.append("version must be 1")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(catalog.get("updated", ""))):
        problems.append("updated must be YYYY-MM-DD")
    categories = {c.get("id") for c in catalog.get("categories", [])}
    for c in catalog.get("categories", []):
        if not ID.fullmatch(str(c.get("id"))) or not all((c.get("title") or {}).get(k) for k in ("en", "de")):
            problems.append(f"category {c.get('id')}: needs an id and an en and de title")
    seen = set()
    for item in catalog.get("items", []):
        where = f"item {item.get('id')}"
        if not ID.fullmatch(str(item.get("id", ""))):
            problems.append(f"{where}: id must match [a-z0-9-]{{1,64}}")
        if item.get("id") in seen:
            problems.append(f"{where}: id is not unique")
        seen.add(item.get("id"))
        for key in ("title", "author", "source", "sourceUrl", "license", "licenseUrl", "credit", "thumb", "file"):
            if not isinstance(item.get(key), str) or not item[key].strip():
                problems.append(f"{where}: {key} missing")
        if item.get("kind") not in KINDS:
            problems.append(f"{where}: kind must be image, video or scene")
        if item.get("category") not in categories:
            problems.append(f"{where}: unknown category {item.get('category')}")
        if item.get("license") not in LICENSES:
            problems.append(f"{where}: licence {item.get('license')} is not on the allow-list")
        elif item.get("licenseUrl") not in LICENSES[item["license"]]:
            problems.append(f"{where}: licenseUrl does not belong to {item['license']}")
        for key in ("thumb", "file", "sourceUrl", "licenseUrl"):
            if not str(item.get(key, "")).startswith("https://"):
                problems.append(f"{where}: {key} must be https")
        for key in ("thumb", "file"):
            url = str(item.get(key, ""))
            host = urllib.parse.urlsplit(url).hostname
            if host not in ALLOWED_HOSTS:
                problems.append(f"{where}: {key} host {host} is not on the app's list")
            elif host == "raw.githubusercontent.com" and not url.startswith(MIRROR_URL):
                problems.append(f"{where}: {key} is on GitHub but not in our mirror ({MIRROR_URL})")
        for key in ("bytes", "width", "height", "duration"):
            if not isinstance(item.get(key), (int, float)) or isinstance(item.get(key), bool) or item[key] < 0:
                problems.append(f"{where}: {key} must be a number")
        if not item.get("bytes") or item.get("bytes", 0) > CAPS.get(item.get("kind"), 0):
            problems.append(f"{where}: bytes missing or above the cap for {item.get('kind')}")
        if item.get("kind") == "scene":
            if item.get("width") or item.get("height"):
                problems.append(f"{where}: scenes have no pixel size (width and height 0)")
        elif not item.get("width") or not item.get("height"):
            problems.append(f"{where}: width and height missing")
        if item.get("kind") == "image" and isinstance(item.get("width"), int) and isinstance(item.get("height"), int) \
                and item["width"] * item["height"] > MAX_PIXELS:
            problems.append(f"{where}: more than {MAX_PIXELS // 1_000_000} megapixels")
        if item.get("kind") == "video" and item.get("codec") not in CODECS:
            problems.append(f"{where}: codec must be one of {sorted(CODECS)}")
        if item.get("kind") in ("image", "scene") and item.get("codec"):
            problems.append(f"{where}: only videos have a codec")
        if not re.fullmatch(r"([0-9a-f]{64})?", str(item.get("sha256", ""))):
            problems.append(f"{where}: sha256 must be empty or 64 hex digits")
        elif is_mirrored(item) and not item.get("sha256"):
            problems.append(f"{where}: mirror items need their sha256")
        if not isinstance(item.get("revoked"), bool):
            problems.append(f"{where}: revoked must be true or false")
    return problems


def check_mirror_files(catalog, folder):
    """check --mirror-local: every live mirror item's file and preview are in the local copy of the
    mirror, and the file has exactly the item's bytes and sha256."""
    problems = []
    for item in catalog.get("items", []):
        if item.get("revoked") or not is_mirrored(item):
            continue
        where = f"item {item.get('id')}"
        for key in ("thumb", "file"):
            local = folder / urllib.parse.unquote(str(item[key])[len(MIRROR_URL):])
            if not local.is_file():
                problems.append(f"{where}: {key} is not in {folder}")
            elif key == "file":
                data = local.read_bytes()
                if len(data) != item.get("bytes") or hashlib.sha256(data).hexdigest() != item.get("sha256"):
                    problems.append(f"{where}: the local file's size or sha256 differs from the catalogue")
    return problems


def check(args):
    path = pathlib.Path(args.file) if args.file else OUT
    try:
        catalog = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"ERROR cannot read {path}: {e}")
        return 1
    problems = check_catalog(catalog)
    if args.mirror_local:
        problems += check_mirror_files(catalog, pathlib.Path(args.mirror))
    for p in problems:
        print("ERROR " + p)
    items = catalog.get("items", [])
    print(f"{path.name}: {len(items)} items, {sum(not i.get('revoked') for i in items)} live, "
          f"{len(problems)} problems")
    return 1 if problems else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build", help="collect, filter and verify items, write the catalogue")
    b.add_argument("--user-agent", default=USER_AGENT)
    b.add_argument("--refresh", action="store_true", help="ignore the on-disk cache")
    b.add_argument("--only", choices=[s.name for s in SOURCES + DISABLED], help="run one source, keep the others from the last build")
    b.add_argument("--hash", action="store_true", help="download each file once to fill in sha256")
    b.add_argument("--thumbs", metavar="DIR", help="download previews and write DIR/<id>.jpg at 480x270")
    b.add_argument("--mirror", metavar="DIR", default=str(MIRROR_DIR),
                   help="local copy of the kumo-wallpapers repository (default: ../kumo-wallpapers)")
    b.add_argument("--mirror-local", action="store_true",
                   help="check mirror items against the local files (size, sha256) instead of asking GitHub")
    b.add_argument("--out", metavar="FILE", help="write the catalogue there (default: site/catalog/v1/catalog.json)")
    c = sub.add_parser("check", help="validate a catalogue file offline")
    c.add_argument("file", nargs="?", help="default: site/catalog/v1/catalog.json")
    c.add_argument("--mirror", metavar="DIR", default=str(MIRROR_DIR), help="local copy of the mirror (default: ../kumo-wallpapers)")
    c.add_argument("--mirror-local", action="store_true", help="also compare mirror items with the files in the local copy")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(build(args) if args.command == "build" else check(args))


if __name__ == "__main__":
    main()
