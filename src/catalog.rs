//! The online catalogue: free wallpapers (public domain and open licences) listed in one JSON
//! file on kumo.hyos.tech, downloaded only after the user agreed (`Config::online`).
//!
//! Everything from the network is untrusted: hosts come from a fixed allow-list, sizes are
//! capped, the file type is read from the bytes and never from a name, and a checksum from the
//! catalogue is verified when present. Downloads stream to disk; no media file is held in memory.
//! Platform-neutral: `crate::net` and `crate::media` differ per platform with the same API.

use crate::library::{self, Item, Kind};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

pub const URL: &str = "https://kumo.hyos.tech/catalog/v1/catalog.json";
pub const VERSION: u32 = 1;

/// The only hosts Kumo ever connects to, redirects included. Every host here needs a line in
/// the privacy policy (site/), so add one there with each new entry.
const HOSTS: &[&str] = &[
    "kumo.hyos.tech",
    "cdn.kumo.hyos.tech",
    "svs.gsfc.nasa.gov",
    "openaccess-cdn.clevelandart.org",
    "cdn.esahubble.org",
    "cdn.esawebb.org",
    "cdn.eso.org",
    // our own file mirror, the public repository Hamido212/kumo-wallpapers on GitHub; the host
    // serves every public repository, so the catalogue tool only lists files under our path, and
    // every mirrored item carries its sha256
    "raw.githubusercontent.com",
];

pub const MAX_CATALOG: usize = 4 << 20;
pub const MAX_THUMB: u64 = 8 << 20;
pub const MAX_IMAGE: u64 = 80 << 20;
pub const MAX_VIDEO: u64 = 500 << 20;
pub const MAX_SCENE: u64 = 50 << 20;
/// Pictures above this are not offered: decoding a progressive JPEG of 100 megapixels can take
/// hundreds of MB for a moment, and no screen shows that many pixels.
pub const MAX_PIXELS: u64 = 40_000_000;

/// Plain http to 127.0.0.1/localhost and `KUMO_CATALOG`, for tests and UI work without the internet.
pub const DEV: bool = cfg!(any(test, feature = "devnet"));

pub fn host_allowed(host: &str) -> bool {
    HOSTS.contains(&host)
}

pub fn max_bytes(kind: Kind) -> u64 {
    match kind {
        Kind::Image => MAX_IMAGE,
        Kind::Video => MAX_VIDEO,
        Kind::Scene => MAX_SCENE,
    }
}

// ---------------------------------------------------------------- URLs

/// An absolute http(s) URL, split for the HTTP clients.
#[derive(Clone, Debug, PartialEq)]
pub struct Url {
    pub https: bool,
    /// lower case
    pub host: String,
    pub port: u16,
    /// path and query, starts with '/'
    pub path: String,
}

impl Url {
    pub fn parse(s: &str) -> Option<Url> {
        if s.len() > 4096 || s.bytes().any(|b| b <= b' ' || b == 0x7f || b == b'\\') {
            return None;
        }
        let (https, rest) = match s.split_once("://")? {
            (scheme, rest) if scheme.eq_ignore_ascii_case("https") => (true, rest),
            (scheme, rest) if scheme.eq_ignore_ascii_case("http") => (false, rest),
            _ => return None,
        };
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let (authority, tail) = rest.split_at(end);
        let tail = tail.split('#').next().unwrap_or("");
        let path = if tail.starts_with('/') { tail.to_string() } else { format!("/{tail}") };
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (h, p.parse::<u16>().ok().filter(|&p| p != 0)?),
            None => (authority, if https { 443 } else { 80 }),
        };
        let host = host.to_ascii_lowercase();
        // no user info, no IPv6 literals, nothing a host name cannot contain
        if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
            return None;
        }
        Some(Url { https, host, port, path })
    }

    pub fn loopback(&self) -> bool {
        self.host == "127.0.0.1" || self.host == "localhost"
    }

    /// The target of a redirect (`Location`), absolute or relative to this URL.
    pub fn join(&self, location: &str) -> String {
        let origin = format!("{}://{}:{}", if self.https { "https" } else { "http" }, self.host, self.port);
        if location.contains("://") {
            location.to_string()
        } else if let Some(rest) = location.strip_prefix("//") {
            format!("{}://{rest}", if self.https { "https" } else { "http" })
        } else if location.starts_with('/') {
            format!("{origin}{location}")
        } else {
            let dir = self.path.split('?').next().unwrap_or("/");
            format!("{origin}{}{location}", &dir[..dir.rfind('/').map_or(0, |i| i + 1)])
        }
    }
}

impl std::fmt::Display for Url {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}://{}:{}{}", if self.https { "https" } else { "http" }, self.host, self.port, self.path)
    }
}

/// A URL Kumo may fetch: https on an allowed host (or loopback http in development).
pub fn check_url(s: &str) -> Result<Url, String> {
    let url = Url::parse(s).ok_or_else(|| format!("not a valid address: {s}"))?;
    if (url.https && host_allowed(&url.host)) || (DEV && !url.https && url.loopback()) {
        Ok(url)
    } else {
        Err(format!("{}{} is not an allowed source", if url.https { "" } else { "http://" }, url.host))
    }
}

// ---------------------------------------------------------------- the catalogue file

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    /// language code -> title
    #[serde(default)]
    pub title: std::collections::BTreeMap<String, String>,
}

impl Category {
    /// The title in `lang` ("de", "en"), else English, else the id.
    pub fn title(&self, lang: &str) -> &str {
        self.title.get(lang).or_else(|| self.title.get("en")).map(String::as_str).unwrap_or(&self.id)
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// `[a-z0-9-]{1,64}`, unique in the catalogue
    pub id: String,
    pub title: String,
    pub kind: Kind,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub source_url: String,
    pub license: String,
    #[serde(default)]
    pub license_url: String,
    #[serde(default)]
    pub credit: String,
    pub thumb: String,
    pub file: String,
    /// exact size of `file`, 0 if unknown
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    /// videos: seconds
    #[serde(default)]
    pub duration: f32,
    /// videos: e.g. "h264"
    #[serde(default)]
    pub codec: String,
    /// hex, verified when present
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub revoked: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    pub version: u32,
    pub updated: String,
    pub categories: Vec<Category>,
    pub items: Vec<Entry>,
}

impl Catalog {
    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.items.iter().find(|e| e.id == id)
    }
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Whether an entry may be shown and installed.
pub fn usable(e: &Entry) -> bool {
    !e.revoked
        && valid_id(&e.id)
        && !e.title.trim().is_empty()
        && !e.license.trim().is_empty()
        && check_url(&e.thumb).is_ok()
        && check_url(&e.file).is_ok()
        && e.bytes <= max_bytes(e.kind)
        && (e.kind != Kind::Image || e.width as u64 * e.height as u64 <= MAX_PIXELS)
        && (e.sha256.is_empty() || (e.sha256.len() == 64 && e.sha256.bytes().all(|b| b.is_ascii_hexdigit())))
}

/// Reads a catalogue. A wrong version is an error; a single bad, revoked or unknown entry is
/// dropped silently, so the format can grow without breaking older Kumos.
pub fn parse(bytes: &[u8]) -> Result<Catalog, String> {
    #[derive(Deserialize)]
    struct Raw {
        version: u32,
        #[serde(default)]
        updated: String,
        #[serde(default)]
        categories: Vec<serde_json::Value>,
        #[serde(default)]
        items: Vec<serde_json::Value>,
    }
    if bytes.len() > MAX_CATALOG {
        return Err("the catalogue is too large".into());
    }
    let raw: Raw = serde_json::from_slice(bytes).map_err(|e| format!("catalogue: {e}"))?;
    if raw.version != VERSION {
        return Err(format!("unsupported catalogue version {}", raw.version));
    }
    let categories = raw.categories.into_iter().filter_map(|v| serde_json::from_value::<Category>(v).ok()).filter(|c| valid_id(&c.id)).collect();
    let mut seen = std::collections::HashSet::new();
    let items = raw
        .items
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Entry>(v).ok())
        .filter(|e| usable(e) && seen.insert(e.id.clone()))
        .collect();
    Ok(Catalog { version: raw.version, updated: raw.updated, categories, items })
}

// ---------------------------------------------------------------- cache

/// `%LOCALAPPDATA%\Kumo\cache`, next to the library.
pub fn cache_dir() -> PathBuf {
    let lib = library::dir();
    lib.parent().map(Path::to_path_buf).unwrap_or(lib).join("cache")
}

fn catalog_file() -> PathBuf {
    cache_dir().join("catalog.json")
}

fn etag_file() -> PathBuf {
    cache_dir().join("catalog.etag")
}

fn thumbs_dir() -> PathBuf {
    cache_dir().join("thumbs")
}

/// A temp file name no other download uses, also across threads.
fn temp_file(dir: &Path, id: &str) -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    dir.join(format!(".{id}.{}-{}.part", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
}

/// The last downloaded catalogue, without touching the network.
pub fn cached() -> Option<Catalog> {
    let path = catalog_file();
    if std::fs::metadata(&path).ok()?.len() > MAX_CATALOG as u64 {
        return None;
    }
    parse(&std::fs::read(path).ok()?).ok()
}

fn store(bytes: &[u8], etag: &str) -> Result<(), String> {
    let e = |x: std::io::Error| x.to_string();
    std::fs::create_dir_all(cache_dir()).map_err(e)?;
    // the old tag must not outlive the file it belongs to
    let _ = std::fs::remove_file(etag_file());
    let tmp = catalog_file().with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(e)?;
    std::fs::rename(&tmp, catalog_file()).map_err(e)?;
    if !etag.is_empty() {
        let _ = std::fs::write(etag_file(), etag);
    }
    Ok(())
}

/// Where the catalogue comes from; development builds may point `KUMO_CATALOG` at a local file
/// or a loopback URL.
fn source() -> String {
    if DEV {
        if let Some(s) = std::env::var("KUMO_CATALOG").ok().filter(|s| !s.is_empty()) {
            return s;
        }
    }
    URL.into()
}

/// Fetches the catalogue (a conditional request when a copy is cached) and caches it.
pub fn refresh() -> Result<Catalog, String> {
    let src = source();
    if !src.contains("://") {
        let len = std::fs::metadata(&src).map_err(|e| format!("{src}: {e}"))?.len();
        if len > MAX_CATALOG as u64 {
            return Err("the catalogue is too large".into());
        }
        let bytes = std::fs::read(&src).map_err(|e| format!("{src}: {e}"))?;
        let cat = parse(&bytes)?;
        store(&bytes, "")?;
        return Ok(cat);
    }
    let have = cached();
    let etag = have.as_ref().and_then(|_| std::fs::read_to_string(etag_file()).ok()).filter(|t| !t.is_empty());
    let r = crate::net::get(&src, MAX_CATALOG, etag.as_deref()).map_err(|e| e.to_string())?;
    if r.status == 304 {
        return have.ok_or_else(|| "the cached catalogue is gone".into());
    }
    let cat = parse(&r.body)?;
    store(&r.body, &r.etag)?;
    Ok(cat)
}

fn thumb_path(e: &Entry) -> PathBuf {
    thumbs_dir().join(format!("{}-{}.jpg", e.id, &hex(&sha256(e.thumb.as_bytes()))[..16]))
}

/// The entry's 480x270 JPEG preview, downloaded and shrunk on first use.
pub fn thumb(e: &Entry) -> Result<PathBuf, String> {
    if !valid_id(&e.id) {
        return Err("bad catalogue id".into());
    }
    let out = thumb_path(e);
    if out.exists() {
        return Ok(out);
    }
    std::fs::create_dir_all(thumbs_dir()).map_err(|x| x.to_string())?;
    let part = temp_file(&thumbs_dir(), &e.id);
    let small = part.with_extension("jpg-part");
    let result = (|| {
        crate::net::download(&e.thumb, &part, MAX_THUMB, &AtomicBool::new(false), &mut |_, _| {}).map_err(|x| x.to_string())?;
        if sniff_file(&part)?.map(|s| s.0) != Some(Kind::Image) {
            return Err("the preview is not a picture".to_string());
        }
        crate::media::thumbnail_from_file(&part, &small).map_err(|x| x.to_string())?;
        std::fs::rename(&small, &out).map_err(|x| x.to_string())
    })();
    let _ = std::fs::remove_file(&part);
    let _ = std::fs::remove_file(&small);
    result.map(|_| out)
}

/// Downloads an entry into the library, or returns the copy already there. `progress` gets
/// 0..1 of the download.
pub fn install(e: &Entry, cancel: &AtomicBool, progress: &mut dyn FnMut(f32)) -> Result<Item, String> {
    if let Some(item) = library::by_catalog_id(&e.id) {
        return Ok(item);
    }
    if !usable(e) {
        return Err(format!("{}: not a usable catalogue entry", e.id));
    }
    let dir = library::dir();
    std::fs::create_dir_all(&dir).map_err(|x| x.to_string())?;
    let part = temp_file(&dir, &e.id);
    let ext = match fetch_verified(e, &part, cancel, progress) {
        Ok(ext) => ext,
        Err(x) => {
            let _ = std::fs::remove_file(&part);
            return Err(x);
        }
    };
    let thumb = thumb(e).map_err(|x| crate::log(&format!("kumo: no catalogue preview for {}: {x}", e.id))).ok();
    let info = Item {
        title: e.title.clone(),
        kind: e.kind,
        author: e.author.clone(),
        license: e.license.clone(),
        license_url: e.license_url.clone(),
        source: e.source.clone(),
        source_url: e.source_url.clone(),
        credit: e.credit.clone(),
        catalog_id: e.id.clone(),
        ..Item::default()
    };
    let item = library::adopt(&part, ext, info, thumb.as_deref())?;
    progress(1.0);
    Ok(item)
}

/// Downloads `e.file` to `part` and checks size, checksum and type. Returns the extension.
fn fetch_verified(e: &Entry, part: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(f32)) -> Result<&'static str, String> {
    let cap = if e.bytes > 0 { e.bytes } else { max_bytes(e.kind) };
    let mut report = |done: u64, total: Option<u64>| {
        if let Some(t) = total.or((e.bytes > 0).then_some(e.bytes)) {
            progress((done as f32 / t.max(1) as f32).min(1.0));
        }
    };
    let n = crate::net::download(&e.file, part, cap, cancel, &mut report).map_err(|x| x.to_string())?;
    if e.bytes > 0 && n != e.bytes {
        return Err(format!("{}: {n} bytes instead of {}", e.id, e.bytes));
    }
    if !e.sha256.is_empty() && !sha256_file(part)?.eq_ignore_ascii_case(&e.sha256) {
        return Err(format!("{}: the checksum does not match", e.id));
    }
    let (kind, ext) = sniff_file(part)?.ok_or_else(|| format!("{}: not a picture, video or scene", e.id))?;
    if kind != e.kind {
        return Err(format!("{}: the file is a {kind:?}, the catalogue says {:?}", e.id, e.kind));
    }
    if kind == Kind::Scene {
        crate::scene::parse(&std::fs::read(part).map_err(|x| x.to_string())?)?;
    }
    Ok(ext)
}

/// Deletes previews the current catalogue no longer lists and temp files older than an hour
/// (a download that is still running keeps writing to its file).
pub fn prune_cache() {
    let stale = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() > 3600);
    let keep: Option<std::collections::HashSet<PathBuf>> = cached().map(|c| c.items.iter().map(thumb_path).collect());
    for dir in [cache_dir(), thumbs_dir(), library::dir()] {
        for f in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = f.path();
            if !p.is_file() {
                continue;
            }
            let name = f.file_name().to_string_lossy().into_owned();
            let temp = name.ends_with(".part") || name.ends_with(".jpg-part") || name.ends_with(".tmp");
            let unlisted = dir == thumbs_dir() && name.ends_with(".jpg") && keep.as_ref().is_some_and(|k| !k.contains(&p));
            if (temp && stale(&p)) || unlisted {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

// ---------------------------------------------------------------- file types

/// The real type of a file from its first bytes: (kind, extension). Names and the server's
/// Content-Type are never trusted.
pub fn sniff(head: &[u8]) -> Option<(Kind, &'static str)> {
    let at = |o: usize, sig: &[u8]| head.get(o..o + sig.len()) == Some(sig);
    if at(0, &[0xFF, 0xD8, 0xFF]) {
        return Some((Kind::Image, "jpg"));
    }
    if at(0, b"\x89PNG\r\n\x1a\n") {
        return Some((Kind::Image, "png"));
    }
    if at(0, b"RIFF") && at(8, b"WEBP") {
        return Some((Kind::Image, "webp"));
    }
    if at(0, b"KUMO") {
        return Some((Kind::Scene, "kumo"));
    }
    if at(0, &[0x1A, 0x45, 0xDF, 0xA3]) {
        let webm = head.windows(4).any(|w| w == b"webm");
        return Some((Kind::Video, if webm { "webm" } else { "mkv" }));
    }
    if at(4, b"ftyp") {
        // ISO base media: the brands tell HEIF/AVIF pictures from MP4/QuickTime videos
        let size = u32::from_be_bytes(head.get(0..4)?.try_into().ok()?) as usize;
        let ftyp = head.get(8..size.clamp(12, head.len().max(12)))?;
        let major = &ftyp[0..4];
        let brands: Vec<&[u8]> = std::iter::once(major).chain(ftyp.get(8..).unwrap_or(&[]).chunks_exact(4)).collect();
        let has = |b: &[u8]| brands.contains(&b);
        if has(b"avif") || has(b"avis") {
            return Some((Kind::Image, "avif"));
        }
        if [b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"].iter().any(|b| major == *b) {
            return Some((Kind::Image, "heic"));
        }
        if major == b"qt  " {
            return Some((Kind::Video, "mov"));
        }
        let video: [&[u8; 4]; 14] = [b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"M4V ", b"M4VH", b"M4VP", b"dash", b"mmp4"];
        if video.iter().any(|b| major == *b) {
            return Some((Kind::Video, "mp4"));
        }
    }
    None
}

pub fn sniff_file(path: &Path) -> Result<Option<(Kind, &'static str)>, String> {
    use std::io::Read;
    let mut head = Vec::with_capacity(128);
    std::fs::File::open(path).and_then(|f| f.take(128).read_to_end(&mut head)).map_err(|e| e.to_string())?;
    Ok(sniff(&head))
}

// ---------------------------------------------------------------- SHA-256

/// SHA-256 (FIPS 180-4), small enough that no crate is needed for checking downloads.
pub struct Sha256 {
    h: [u32; 8],
    block: [u8; 64],
    used: usize,
    len: u64,
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

impl Default for Sha256 {
    fn default() -> Self {
        Sha256 { h: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], block: [0; 64], used: 0, len: 0 }
    }
}

impl Sha256 {
    pub fn update(&mut self, mut data: &[u8]) {
        self.len = self.len.wrapping_add(data.len() as u64);
        while !data.is_empty() {
            let take = (64 - self.used).min(data.len());
            self.block[self.used..self.used + take].copy_from_slice(&data[..take]);
            self.used += take;
            data = &data[take..];
            if self.used == 64 {
                compress(&mut self.h, &self.block);
                self.used = 0;
            }
        }
    }

    pub fn finish(mut self) -> [u8; 32] {
        let bits = self.len.wrapping_mul(8);
        self.update(&[0x80]);
        while self.used != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        let mut out = [0u8; 32];
        for (o, h) in out.chunks_exact_mut(4).zip(self.h) {
            o.copy_from_slice(&h.to_be_bytes());
        }
        out
    }
}

fn compress(h: &mut [u32; 8], block: &[u8; 64]) {
    let mut w = [0u32; 64];
    for (i, c) in block.chunks_exact(4).enumerate() {
        w[i] = u32::from_be_bytes([c[0], c[1], c[2], c[3]]);
    }
    for i in 16..64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = *h;
    for i in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ (!e & g);
        let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let t2 = s0.wrapping_add(maj);
        hh = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    for (x, y) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
        *x = x.wrapping_add(y);
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut s = Sha256::default();
    s.update(data);
    s.finish()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hex SHA-256 of a file, read with a fixed buffer.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut s = Sha256::default();
    let mut buf = vec![0u8; 64 << 10];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(hex(&s.finish()));
        }
        s.update(&buf[..n]);
    }
}

// ---------------------------------------------------------------- tests

/// A tiny HTTP/1.1 server on 127.0.0.1 for the network tests: no test reaches the internet.
#[cfg(test)]
pub mod test_server {
    use std::io::{Read, Write};
    use std::sync::Arc;

    pub struct Request {
        pub path: String,
        pub headers: Vec<(String, String)>,
    }

    impl Request {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
        }
    }

    pub struct Reply {
        pub status: u32,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
        /// send Content-Length (else the body ends when the connection closes)
        pub length: bool,
    }

    impl Reply {
        pub fn ok(body: Vec<u8>) -> Reply {
            Reply { status: 200, headers: Vec::new(), body, length: true }
        }
        pub fn status(status: u32) -> Reply {
            Reply { status, headers: Vec::new(), body: Vec::new(), length: true }
        }
        pub fn redirect(to: &str) -> Reply {
            Reply { status: 302, headers: vec![("Location".into(), to.into())], body: Vec::new(), length: true }
        }
        pub fn header(mut self, k: &str, v: &str) -> Reply {
            self.headers.push((k.into(), v.into()));
            self
        }
    }

    /// Serves `route` until the test process ends; returns "http://127.0.0.1:<port>".
    pub fn start(route: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let route = Arc::new(route);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let route = route.clone();
                std::thread::spawn(move || serve(stream, &*route));
            }
        });
        base
    }

    fn serve(mut s: std::net::TcpStream, route: &dyn Fn(&Request) -> Reply) {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") && head.len() < 16384 {
            match s.read(&mut byte) {
                Ok(1) => head.push(byte[0]),
                _ => return,
            }
        }
        let text = String::from_utf8_lossy(&head);
        let mut lines = text.split("\r\n");
        let path = lines.next().unwrap_or("").split(' ').nth(1).unwrap_or("/").to_string();
        let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
        let r = route(&Request { path, headers });
        let mut out = format!("HTTP/1.1 {} X\r\nConnection: close\r\n", r.status);
        for (k, v) in &r.headers {
            out += &format!("{k}: {v}\r\n");
        }
        if r.length {
            out += &format!("Content-Length: {}\r\n", r.body.len());
        }
        out += "\r\n";
        let _ = s.write_all(out.as_bytes()).and_then(|_| s.write_all(&r.body)).and_then(|_| s.flush());
        let _ = s.shutdown(std::net::Shutdown::Write);
        // let the client read everything before the socket goes away
        let _ = s.read(&mut [0u8; 64]);
    }

    /// An uncompressed RGB PNG, so the tests need no encoder.
    pub fn png(w: u32, h: u32) -> Vec<u8> {
        fn crc(data: &[u8]) -> u32 {
            let mut c = !0u32;
            for &b in data {
                c ^= b as u32;
                for _ in 0..8 {
                    c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
                }
            }
            !c
        }
        fn chunk(out: &mut Vec<u8>, kind: &[u8], data: &[u8]) {
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            let start = out.len();
            out.extend_from_slice(kind);
            out.extend_from_slice(data);
            let c = crc(&out[start..]);
            out.extend_from_slice(&c.to_be_bytes());
        }
        let mut raw = Vec::new();
        for y in 0..h {
            raw.push(0);
            for x in 0..w {
                raw.extend_from_slice(&[(x * 255 / w) as u8, (y * 255 / h) as u8, 128]);
            }
        }
        let mut z = vec![0x78, 0x01];
        for (i, block) in raw.chunks(65535).enumerate() {
            let last = (i + 1) * 65535 >= raw.len();
            z.push(last as u8);
            z.extend_from_slice(&(block.len() as u16).to_le_bytes());
            z.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
            z.extend_from_slice(block);
        }
        let (mut a, mut b) = (1u32, 0u32);
        for &x in &raw {
            a = (a + x as u32) % 65521;
            b = (b + a) % 65521;
        }
        z.extend_from_slice(&((b << 16) | a).to_be_bytes());
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        chunk(&mut out, b"IHDR", &ihdr);
        chunk(&mut out, b"IDAT", &z);
        chunk(&mut out, b"IEND", &[]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::test_server::{png, start, Reply};
    use super::*;

    fn entry(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "title": "Wave", "author": "Hokusai", "kind": "image", "category": "art",
            "source": "The Cleveland Museum of Art", "sourceUrl": "https://example.org/w",
            "license": "CC0 1.0", "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
            "credit": "Hokusai, CMA, CC0",
            "thumb": "https://openaccess-cdn.clevelandart.org/t.jpg", "file": "https://openaccess-cdn.clevelandart.org/f.jpg",
            "bytes": 2345678, "width": 3400, "height": 2270, "someFutureField": [1, 2]
        })
    }

    fn catalog(items: Vec<serde_json::Value>) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": 1, "updated": "2026-11-22", "future": true,
            "categories": [{ "id": "space", "title": { "en": "Space", "de": "Weltraum" } }, { "id": "Bad Id" }],
            "items": items
        }))
        .unwrap()
    }

    #[test]
    fn hosts_are_matched_exactly() {
        assert!(host_allowed("kumo.hyos.tech") && host_allowed("cdn.eso.org"));
        for h in ["KUMO.hyos.tech", "kumo.hyos.tech.", "evil.kumo.hyos.tech", "kumo.hyos.tech.evil.com", "xkumo.hyos.tech", "", "eso.org"] {
            assert!(!host_allowed(h), "{h}");
        }
    }

    #[test]
    fn the_mirror_on_github_is_allowed() {
        let u = check_url("https://raw.githubusercontent.com/Hamido212/kumo-wallpapers/main/pictures/kde/kde-altai.jpg").unwrap();
        assert_eq!((u.https, u.host.as_str(), u.port), (true, "raw.githubusercontent.com", 443));
        assert_eq!(u.path, "/Hamido212/kumo-wallpapers/main/pictures/kde/kde-altai.jpg");
        // only that exact host, over https; GitHub's other hosts stay out
        for bad in [
            "http://raw.githubusercontent.com/Hamido212/kumo-wallpapers/main/a.jpg",
            "https://raw.githubusercontent.com.evil.example/a.jpg",
            "https://evil.raw.githubusercontent.com/a.jpg",
            "https://github.com/Hamido212/kumo-wallpapers/raw/main/a.jpg",
            "https://objects.githubusercontent.com/a.jpg",
            "https://media.githubusercontent.com/media/Hamido212/kumo-wallpapers/main/a.jpg",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn urls() {
        let u = check_url("https://KUMO.hyos.tech/catalog/v1/catalog.json?x=1#frag").unwrap();
        assert_eq!((u.https, u.host.as_str(), u.port, u.path.as_str()), (true, "kumo.hyos.tech", 443, "/catalog/v1/catalog.json?x=1"));
        assert_eq!(check_url("https://cdn.eso.org").unwrap().path, "/");
        for bad in [
            "http://kumo.hyos.tech/a",
            "https://evil.example/a",
            "https://user@kumo.hyos.tech/a",
            "https://kumo.hyos.tech@evil.example/a",
            "ftp://kumo.hyos.tech/a",
            "https://kumo.hyos.tech/a b",
            "https://kumo.hyos.tech:0/",
            "https://[::1]/",
            "file:///C:/x",
            "kumo.hyos.tech/a",
            "https://kumo.hyos.tech\\@evil.example/",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        // loopback http only in tests and devnet builds
        assert!(check_url("http://127.0.0.1:8080/x").is_ok() && check_url("http://localhost:1/").is_ok());
        assert!(check_url("http://127.0.0.2:8080/x").is_err());
        let base = Url::parse("https://cdn.eso.org/a/b/c.jpg?q").unwrap();
        assert_eq!(base.join("/x"), "https://cdn.eso.org:443/x");
        assert_eq!(base.join("d.jpg"), "https://cdn.eso.org:443/a/b/d.jpg");
        assert_eq!(base.join("//cdn.eso.org/e"), "https://cdn.eso.org/e");
        assert_eq!(base.join("https://evil.example/"), "https://evil.example/");
    }

    #[test]
    fn parse_reads_a_good_catalogue() {
        let c = parse(&catalog(vec![entry("cma-1948-306")])).unwrap();
        assert_eq!((c.version, c.updated.as_str()), (1, "2026-11-22"));
        assert_eq!(c.categories.len(), 1);
        assert_eq!((c.categories[0].title("de"), c.categories[0].title("fr")), ("Weltraum", "Space"));
        let e = c.get("cma-1948-306").unwrap();
        assert_eq!((e.kind, e.bytes, e.width, e.license.as_str(), e.source_url.as_str()), (Kind::Image, 2345678, 3400, "CC0 1.0", "https://example.org/w"));
        // optional fields may be missing
        let mut min = entry("min");
        for k in ["author", "category", "source", "sourceUrl", "licenseUrl", "credit", "bytes", "width", "height"] {
            min.as_object_mut().unwrap().remove(k);
        }
        let e = parse(&catalog(vec![min])).unwrap().items.remove(0);
        assert_eq!((e.bytes, e.author.as_str(), e.duration, e.revoked), (0, "", 0.0, false));
    }

    #[test]
    fn parse_drops_bad_entries() {
        let with = |id: &str, k: &str, v: serde_json::Value| {
            let mut e = entry(id);
            e[k] = v;
            e
        };
        let mut no_title = entry("no-title");
        no_title.as_object_mut().unwrap().remove("title");
        let items = vec![
            entry("good"),
            with("revoked", "revoked", true.into()),
            with("UPPER", "id", "UPPER".into()),
            with("x", "id", "a/b".into()),
            with("x", "id", "".into()),
            with("x", "id", "a".repeat(65).into()),
            with("no-licence", "license", " ".into()),
            with("empty-title", "title", "".into()),
            no_title,
            with("http-thumb", "thumb", "http://openaccess-cdn.clevelandart.org/t.jpg".into()),
            with("foreign-file", "file", "https://evil.example/f.jpg".into()),
            with("huge-image", "bytes", (MAX_IMAGE + 1).into()),
            with("too-many-pixels", "width", 20_000.into()),
            with("huge-scene", "kind", "scene".into()),
            with("odd-kind", "kind", "gif".into()),
            with("bad-sum", "sha256", "abc".into()),
            entry("good"),
        ];
        let mut items = items;
        items[13]["bytes"] = (MAX_SCENE + 1).into();
        let c = parse(&catalog(items)).unwrap();
        assert_eq!(c.items.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["good"]);
        // a big video is fine, a too big one is not
        let video = |id: &str, n: u64| {
            let mut e = with(id, "kind", "video".into());
            e["bytes"] = n.into();
            e
        };
        let c = parse(&catalog(vec![video("ok", MAX_VIDEO), video("big", MAX_VIDEO + 1)])).unwrap();
        assert_eq!(c.items.len(), 1);
    }

    /// site/catalog/v1/catalog.json is what released Kumos download. Every item in it must pass
    /// this version's rules, so tools/catalog.py and the app cannot drift apart unnoticed.
    #[test]
    fn the_published_catalogue_is_fully_usable() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let file = "site/catalog/v1/catalog.json";
        // the Mac crate lives one folder below the repository root
        let bytes = std::fs::read(root.join(file)).or_else(|_| std::fs::read(root.join("..").join(file))).unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let live = raw["items"].as_array().unwrap().iter().filter(|i| i["revoked"] != true).count();
        let c = parse(&bytes).unwrap();
        assert!(live > 0 && c.items.len() == live, "{} of {live} items are usable", c.items.len());
        assert!(c.items.iter().all(|e| c.categories.iter().any(|k| k.id == e.category)));
        assert!(c.items.iter().all(|e| !e.credit.is_empty() && !e.source_url.is_empty() && !e.license_url.is_empty()));
    }

    #[test]
    fn parse_rejects_whole_files() {
        assert!(parse(br#"{"version": 2, "items": []}"#).is_err());
        assert!(parse(br#"{"items": []}"#).is_err());
        assert!(parse(b"<html>").is_err());
        let mut big = br#"{"version": 1, "updated": ""#.to_vec();
        big.resize(MAX_CATALOG + 10, b'x');
        big.extend_from_slice(br#""}"#);
        assert!(parse(&big).is_err());
        assert_eq!(parse(br#"{"version": 1}"#).unwrap().items.len(), 0);
    }

    #[test]
    fn sniffing() {
        let ftyp = |brand: &[u8; 4], compat: &[u8]| {
            let mut b = vec![0, 0, 0, (16 + compat.len()) as u8];
            b.extend_from_slice(b"ftyp");
            b.extend_from_slice(brand);
            b.extend_from_slice(&[0, 0, 0, 0]);
            b.extend_from_slice(compat);
            b.extend_from_slice(&[0; 16]);
            b
        };
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some((Kind::Image, "jpg")));
        assert_eq!(sniff(&png(2, 2)), Some((Kind::Image, "png")));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some((Kind::Image, "webp")));
        assert_eq!(sniff(b"RIFF\0\0\0\0AVI LIST"), None);
        assert_eq!(sniff(&ftyp(b"avif", b"mif1miaf")), Some((Kind::Image, "avif")));
        assert_eq!(sniff(&ftyp(b"mif1", b"avifmiaf")), Some((Kind::Image, "avif")));
        assert_eq!(sniff(&ftyp(b"heic", b"mif1heic")), Some((Kind::Image, "heic")));
        assert_eq!(sniff(&ftyp(b"isom", b"iso2avc1mp41")), Some((Kind::Video, "mp4")));
        assert_eq!(sniff(&ftyp(b"mp42", b"")), Some((Kind::Video, "mp4")));
        assert_eq!(sniff(&ftyp(b"qt  ", b"qt  ")), Some((Kind::Video, "mov")));
        assert_eq!(sniff(&ftyp(b"M4A ", b"isom")), None);
        assert_eq!(sniff(b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm"), Some((Kind::Video, "webm")));
        assert_eq!(sniff(b"\x1a\x45\xdf\xa3\xa3\x42\x86\x81\x01\x42\x82\x88matroska"), Some((Kind::Video, "mkv")));
        assert_eq!(sniff(library::PAGODA_SCENE), Some((Kind::Scene, "kumo")));
        for junk in [&b"<!DOCTYPE html><html><body>404</body></html>"[..], b"MZ\x90\0\x03\0\0\0", b"PK\x03\x04\x14\0\0\0", b"", b"\xFF\xD8", b"GIF89a"] {
            assert_eq!(sniff(junk), None, "{junk:?}");
        }
    }

    #[test]
    fn sha256_vectors() {
        assert_eq!(hex(&sha256(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(hex(&sha256(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(hex(&sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
        // a million 'a', fed in uneven pieces
        let mut s = Sha256::default();
        let a = vec![b'a'; 1000];
        let mut left = 1_000_000;
        let mut step = 1;
        while left > 0 {
            let n = step.min(left).min(1000);
            s.update(&a[..n]);
            left -= n;
            step = step % 997 + 13;
        }
        assert_eq!(hex(&s.finish()), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("test-out");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("sha.bin");
        std::fs::write(&f, vec![b'a'; 1_000_000]).unwrap();
        assert_eq!(sha256_file(&f).unwrap(), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }

    #[test]
    fn refresh_caches_and_revalidates() {
        let (_g, base) = library::test_home("catalog-refresh");
        assert!(cache_dir().starts_with(&base));
        assert!(cached().is_none());
        let body = catalog(vec![entry("one")]);
        let hits = std::sync::Arc::new(AtomicU32::new(0));
        let h = hits.clone();
        let url = start(move |r| {
            h.fetch_add(1, Ordering::Relaxed);
            if r.header("If-None-Match") == Some("\"v1\"") {
                Reply::status(304).header("ETag", "\"v1\"")
            } else {
                Reply::ok(body.clone()).header("ETag", "\"v1\"")
            }
        });
        std::env::set_var("KUMO_CATALOG", format!("{url}/catalog.json"));
        assert_eq!(refresh().unwrap().items.len(), 1);
        assert_eq!(std::fs::read_to_string(etag_file()).unwrap(), "\"v1\"");
        assert_eq!(cached().unwrap().items[0].id, "one");
        // the second time the server answers 304 and the cached copy is used
        assert_eq!(refresh().unwrap().items[0].id, "one");
        assert_eq!(hits.load(Ordering::Relaxed), 2);
        // a local file
        let file = base.join("local.json");
        std::fs::write(&file, catalog(vec![entry("a"), entry("b")])).unwrap();
        std::env::set_var("KUMO_CATALOG", &file);
        assert_eq!(refresh().unwrap().items.len(), 2);
        assert_eq!(cached().unwrap().items.len(), 2);
        assert!(!etag_file().exists());
        std::env::remove_var("KUMO_CATALOG");
    }

    fn served_entry(url: &str, kind: &str, file: &[u8]) -> Entry {
        Entry {
            id: "test-png".into(),
            title: "Gradient".into(),
            kind: serde_json::from_value(kind.into()).unwrap(),
            author: "Kumo tests".into(),
            source: "Loopback".into(),
            source_url: format!("{url}/page"),
            license: "CC0 1.0".into(),
            license_url: "https://creativecommons.org/publicdomain/zero/1.0/".into(),
            credit: "Kumo tests, CC0".into(),
            thumb: format!("{url}/thumb.png"),
            file: format!("{url}/file"),
            bytes: file.len() as u64,
            sha256: hex(&sha256(file)),
            ..Entry::default()
        }
    }

    #[test]
    fn install_end_to_end() {
        let (_g, base) = library::test_home("catalog-install");
        let picture = png(320, 180);
        let small = png(64, 36);
        let p = picture.clone();
        let url = start(move |r| match r.path.as_str() {
            "/file" => Reply::ok(p.clone()),
            "/thumb.png" => Reply::ok(small.clone()),
            "/html" => Reply::ok(b"<!DOCTYPE html><html>not found</html>".to_vec()),
            _ => Reply::status(404),
        });
        let e = served_entry(&url, "image", &picture);
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();
        let item = install(&e, &cancel, &mut |f| seen.push(f)).unwrap();
        assert!(item.folder().starts_with(&base));
        assert_eq!((item.file.as_str(), item.kind, item.title.as_str()), ("media.png", Kind::Image, "Gradient"));
        assert_eq!((item.catalog_id.as_str(), item.license.as_str(), item.author.as_str(), item.credit.as_str()), ("test-png", "CC0 1.0", "Kumo tests", "Kumo tests, CC0"));
        assert_eq!(std::fs::read(item.path()).unwrap(), picture);
        // the Mac crate built on Windows has no picture decoder, so it makes no previews
        if cfg!(target_os = "macos") || !env!("CARGO_MANIFEST_DIR").ends_with("kumo-mac") {
            assert_eq!(crate::media::image_size(&item.thumbnail()).unwrap(), (480, 270));
            assert!(thumb(&e).unwrap().exists());
        }
        assert_eq!(seen.last(), Some(&1.0));
        let saved = library::get(&item.id).unwrap();
        assert_eq!((saved.source.as_str(), saved.license_url.as_str()), ("Loopback", "https://creativecommons.org/publicdomain/zero/1.0/"));
        // installing again returns the same item
        assert_eq!(install(&e, &cancel, &mut |_| {}).unwrap().id, item.id);
        let count = library::list().len();

        // wrong checksum, wrong size, wrong kind, not a picture: nothing is added, nothing left over
        let bad = [
            Entry { id: "bad-sum".into(), sha256: hex(&sha256(b"other")), ..e.clone() },
            Entry { id: "bad-size".into(), bytes: e.bytes + 1, sha256: String::new(), ..e.clone() },
            Entry { id: "bad-kind".into(), kind: Kind::Video, ..e.clone() },
            Entry { id: "bad-html".into(), file: format!("{url}/html"), bytes: 0, sha256: String::new(), ..e.clone() },
            Entry { id: "bad-404".into(), file: format!("{url}/missing"), ..e.clone() },
            Entry { id: "bad-host".into(), file: "https://evil.example/x.png".into(), ..e.clone() },
        ];
        for b in &bad {
            assert!(install(b, &cancel, &mut |_| {}).is_err(), "{}", b.id);
        }
        assert_eq!(library::list().len(), count);
        let leftovers: Vec<_> = std::fs::read_dir(library::dir()).unwrap().flatten().filter(|f| f.path().is_file()).collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        // a cancelled install leaves nothing either
        cancel.store(true, Ordering::Relaxed);
        assert!(install(&Entry { id: "cancelled".into(), ..e.clone() }, &cancel, &mut |_| {}).is_err());
        assert_eq!(library::list().len(), count);

        // the cache keeps listed previews and drops the rest
        std::fs::write(catalog_file(), b"{\"version\": 1}").unwrap();
        let old = thumbs_dir().join(".x.1-1.part");
        std::fs::write(&old, b"x").unwrap();
        prune_cache();
        assert!(!thumb_path(&e).exists());
        assert!(old.exists(), "a fresh temp file may still be in use");
    }
}
