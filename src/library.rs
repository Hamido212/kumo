//! The wallpaper library: the built-in scenes and animations plus everything the user added.
//!
//! Every added wallpaper lives in its own folder `%APPDATA%\Kumo\library\<id>\` with the media
//! file, a `thumb.jpg` and a `wallpaper.json` describing it. Built-in scenes and animations are
//! part of the program; their folder holds only the thumbnail.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub static PAGODA_SCENE: &[u8] = include_bytes!("../assets/pagoda.kumo");
static PAGODA_THUMB: &[u8] = include_bytes!("../assets/pagoda-thumb.jpg");

/// A scene or animation that ships inside the program.
struct Builtin {
    id: &'static str,
    title: &'static str,
    kind: Kind,
    thumb: &'static [u8],
    /// packed by scenes/pack.mjs; None for the pagoda, which is the fallback for everything
    /// that fails and so stays as it is, ready without unpacking
    packed: Option<&'static [u8]>,
    /// the models come from someone else
    metro_minis: bool,
}

macro_rules! packed_scene {
    ($id:literal, $title:literal) => {
        Builtin {
            id: $id,
            title: $title,
            kind: Kind::Scene,
            thumb: include_bytes!(concat!("../assets/scenes/", $id, "-thumb.jpg")),
            packed: Some(include_bytes!(concat!("../assets/scenes/", $id, ".kumo.z"))),
            metro_minis: true,
        }
    };
}

/// The first one is `config::BUILTIN_SCENE`. To add a scene: bake it, list it in
/// scenes/pack.mjs and here, and put a 480x270 `<id>-thumb.jpg` next to the packed file.
static BUILTIN: &[Builtin] = &[
    Builtin { id: crate::config::BUILTIN_SCENE, title: "Voxel Pagoda Garden", kind: Kind::Scene, thumb: PAGODA_THUMB, packed: None, metro_minis: false },
    packed_scene!("metro-block", "Metro Block"),
    packed_scene!("autumn-village", "Autumn Village"),
    packed_scene!("winter-square", "Winter Square"),
];

#[cfg(shader_wallpapers)]
macro_rules! animation {
    ($id:literal, $title:literal) => {
        Builtin {
            id: $id,
            title: $title,
            kind: Kind::Shader,
            thumb: include_bytes!(concat!("../assets/animations/", $id, "-thumb.jpg")),
            packed: None,
            metro_minis: false,
        }
    };
}

/// Shader wallpapers: each one is `src/fx/<id>.hlsl`, drawn by src/shader.rs. Only builds that
/// compile them (build.rs sets `cfg(shader_wallpapers)`) list them; the Mac version has none yet.
/// To add one: write the effect, list it here and in shader.rs, and render its 480x270
/// thumbnail with `kumo --shot assets/animations/<id>-thumb.jpg --scene <id> --thumb`.
#[cfg(shader_wallpapers)]
static ANIMATIONS: &[Builtin] = &[
    animation!("northern-lights", "Northern Lights"),
    animation!("neon-horizon", "Neon Horizon"),
    animation!("nebula-drift", "Nebula Drift"),
    animation!("midnight-silk", "Midnight Silk"),
    animation!("star-drift", "Star Drift"),
    animation!("ocean-swell", "Ocean Swell"),
];
#[cfg(not(shader_wallpapers))]
static ANIMATIONS: &[Builtin] = &[];

fn builtins() -> impl Iterator<Item = &'static Builtin> {
    BUILTIN.iter().chain(ANIMATIONS)
}

fn builtin(id: &str) -> Option<&'static Builtin> {
    builtins().find(|b| b.id == id)
}

/// A built-in wallpaper by id, without looking at the library folder.
pub fn builtin_item(id: &str) -> Option<Item> {
    builtin(id).map(Builtin::item)
}

/// The built-in wallpapers, scenes first, without looking at the library folder.
pub fn builtin_items() -> Vec<Item> {
    builtins().map(Builtin::item).collect()
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Scene,
    Video,
    #[default]
    Image,
    /// A shader wallpaper. Only ever built in: it is code, so it never comes from a file, a
    /// download or the catalogue, and it is never written to one (serde skips it both ways, so
    /// a "shader" kind fails to load, and an older Kumo never sees one).
    #[serde(skip)]
    Shader,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub title: String,
    pub kind: Kind,
    /// media file name inside the item's folder (empty for a built-in scene)
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub builtin: bool,
    // Provenance of a catalogue download or of a built-in scene's models; all empty for the
    // user's own files, so their wallpaper.json stays as it always was.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub author: String,
    /// short name such as "CC0 1.0" or "Public domain"
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub license: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub license_url: String,
    /// who publishes the work, e.g. "The Cleveland Museum of Art"
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    /// the work's page at the source
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source_url: String,
    /// the full attribution line to show
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub credit: String,
    /// id in the online catalogue, empty for local imports
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub catalog_id: String,
}

pub fn dir() -> PathBuf {
    // big media files belong in the local (not roaming) profile
    let base = std::env::var_os("LOCALAPPDATA").map(|b| PathBuf::from(b).join("Kumo")).unwrap_or_else(crate::config::dir);
    base.join("library")
}

impl Item {
    pub fn folder(&self) -> PathBuf {
        dir().join(&self.id)
    }

    pub fn path(&self) -> PathBuf {
        self.folder().join(&self.file)
    }

    pub fn thumbnail(&self) -> PathBuf {
        self.folder().join("thumb.jpg")
    }

    /// The scene file's bytes (built-in or from disk).
    pub fn scene_bytes(&self) -> std::io::Result<std::borrow::Cow<'static, [u8]>> {
        use std::borrow::Cow;
        if self.kind != Kind::Scene {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a scene"));
        }
        if !self.builtin {
            return std::fs::read(self.path()).map(Cow::Owned);
        }
        match builtin(&self.id).and_then(|b| b.packed) {
            Some(packed) => crate::inflate::unpack(packed).map(Cow::Owned).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
            None => Ok(Cow::Borrowed(PAGODA_SCENE)),
        }
    }
}

impl Builtin {
    fn item(&self) -> Item {
        let item = Item { id: self.id.into(), title: self.title.into(), kind: self.kind, builtin: true, ..Item::default() };
        if !self.metro_minis {
            return item;
        }
        // CC BY asks for the author, the source, the licence and a note of what was changed
        Item {
            author: "Mike Judge".into(),
            license: "CC BY 4.0".into(),
            license_url: "https://creativecommons.org/licenses/by/4.0/".into(),
            source: "Mini Mike's Metro Minis".into(),
            source_url: "https://github.com/mikelovesrobots/mmmm".into(),
            credit: format!("{}, a scene by Kumo. Voxel models from Mini Mike's Metro Minis by Mike Judge, CC BY 4.0, turned into meshes, partly recoloured and arranged.", self.title),
            ..item
        }
    }
}

/// All wallpapers: the built-in scenes and animations first, then the user's, newest first.
pub fn list() -> Vec<Item> {
    let mut items = builtin_items();
    for (b, item) in builtins().zip(&items) {
        if !item.thumbnail().exists() {
            let _ = std::fs::create_dir_all(item.folder());
            let _ = std::fs::write(item.thumbnail(), b.thumb);
        }
    }
    let mut added: Vec<(std::time::SystemTime, Item)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir()) {
        for e in entries.flatten() {
            let meta = e.path().join("wallpaper.json");
            let Ok(text) = std::fs::read_to_string(&meta) else { continue };
            let Ok(item) = serde_json::from_str::<Item>(&text) else { continue };
            if item.builtin || item.id != e.file_name().to_string_lossy() {
                continue;
            }
            let when = std::fs::metadata(&meta).and_then(|m| m.created()).unwrap_or(std::time::UNIX_EPOCH);
            added.push((when, item));
        }
    }
    added.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    items.extend(added.into_iter().map(|(_, i)| i));
    items
}

pub fn get(id: &str) -> Option<Item> {
    list().into_iter().find(|i| i.id == id)
}

/// The installed copy of a catalogue entry, if there is one.
pub fn by_catalog_id(id: &str) -> Option<Item> {
    list().into_iter().find(|i| !id.is_empty() && i.catalog_id == id)
}

pub fn kind_of(path: &Path) -> Option<Kind> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "kumo" => Some(Kind::Scene),
        "mp4" | "m4v" | "mov" | "webm" | "mkv" | "wmv" | "avi" => Some(Kind::Video),
        "jpg" | "jpeg" | "png" | "bmp" | "webp" | "tif" | "tiff" | "heic" | "avif" | "jxr" => Some(Kind::Image),
        _ => None,
    }
}

fn copy_with_progress(src: &Path, dst: &Path, progress: &mut impl FnMut(f32)) -> std::io::Result<()> {
    use std::io::{Read, Write};
    let mut from = std::fs::File::open(src)?;
    let total = from.metadata()?.len().max(1);
    let mut to = std::fs::File::create(dst)?;
    let mut buf = vec![0u8; 1 << 20];
    let mut done = 0;
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        to.write_all(&buf[..n])?;
        done += n as u64;
        progress(done as f32 / total as f32);
    }
}

/// A fresh folder name: the name as a slug plus the time, so a re-added file never collides.
fn new_id(name: &str) -> String {
    let slug: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).take(32).collect();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{}-{:x}", slug.trim_matches('-'), stamp)
}

/// Copies a file into the library. The caller creates the thumbnail (`thumb.jpg`).
pub fn import(src: &Path, mut progress: impl FnMut(f32)) -> Result<Item, String> {
    let kind = kind_of(src).ok_or_else(|| format!("{}: unsupported file type", src.display()))?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "wallpaper".into());
    let ext = src.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let item = Item { id: new_id(&stem), title: stem, kind, file: format!("media.{ext}"), ..Item::default() };
    if kind == Kind::Scene {
        crate::scene::parse(&std::fs::read(src).map_err(|e| e.to_string())?)?;
    }
    std::fs::create_dir_all(item.folder()).map_err(|e| e.to_string())?;
    let copied = copy_with_progress(src, &item.path(), &mut progress).map_err(|e| e.to_string()).and_then(|_| save(&item));
    if copied.is_err() {
        let _ = std::fs::remove_dir_all(item.folder());
    }
    copied.map(|_| item)
}

/// Moves a downloaded and already verified file (`tmp`, in the library folder so this is a
/// rename) into the library as a new item. `info` carries title, kind and provenance; id and
/// file are set here. `thumb` is a ready JPEG to copy, else one is made from the media.
/// Nothing is left behind on failure, `tmp` included.
pub fn adopt(tmp: &Path, ext: &str, info: Item, thumb: Option<&Path>) -> Result<Item, String> {
    if ext.is_empty() || ext.len() > 5 || !ext.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
        let _ = std::fs::remove_file(tmp);
        return Err(format!("bad file extension {ext:?}"));
    }
    let name = if info.catalog_id.is_empty() { info.title.clone() } else { info.catalog_id.clone() };
    let item = Item { id: new_id(&name), file: format!("media.{ext}"), builtin: false, ..info };
    let result = (|| {
        std::fs::create_dir_all(item.folder()).map_err(|e| e.to_string())?;
        std::fs::rename(tmp, item.path()).map_err(|e| e.to_string())?;
        let copied = thumb.is_some_and(|t| std::fs::copy(t, item.thumbnail()).is_ok());
        if !copied {
            let made = match item.kind {
                Kind::Image => crate::media::thumbnail_from_file(&item.path(), &item.thumbnail()).map_err(|e| e.to_string()),
                _ => crate::media::thumbnail_via_shell(&item.path(), &item.thumbnail()).map_err(|e| e.to_string()),
            };
            if let Err(e) = made {
                crate::log(&format!("kumo: no thumbnail for {}: {e}", item.title));
            }
        }
        save(&item)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(item.folder());
        let _ = std::fs::remove_file(tmp);
    }
    result.map(|_| item)
}

/// Removes what an interrupted import left: folders without a `wallpaper.json`.
pub fn sweep() {
    for e in std::fs::read_dir(dir()).into_iter().flatten().flatten() {
        // files here are downloads in progress (`*.part`), not items
        if e.path().is_dir() && builtin(&e.file_name().to_string_lossy()).is_none() && !e.path().join("wallpaper.json").exists() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

pub fn save(item: &Item) -> Result<(), String> {
    let text = serde_json::to_string_pretty(item).map_err(|e| e.to_string())?;
    std::fs::write(item.folder().join("wallpaper.json"), text).map_err(|e| e.to_string())
}

pub fn remove(id: &str) -> Result<(), String> {
    let item = get(id).ok_or("unknown wallpaper")?;
    if item.builtin {
        return Err("the built-in scene cannot be removed".into());
    }
    // the engine lets go of a playing video only after it has reloaded
    let mut result = Ok(());
    for _ in 0..10 {
        result = std::fs::remove_dir_all(item.folder());
        if result.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    result.map_err(|e| e.to_string())
}

/// Tests that point `LOCALAPPDATA` at a temp folder take this first: the variable is global.
#[cfg(test)]
pub static TEST_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Points the library (and the catalogue cache next to it) at an empty `target\test-out\<name>`.
#[cfg(test)]
pub fn test_home(name: &str) -> (std::sync::MutexGuard<'static, ()>, PathBuf) {
    let guard = TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("test-out").join(name);
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    std::env::set_var("LOCALAPPDATA", &base);
    std::env::remove_var("KUMO_CATALOG");
    (guard, base)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "{\n  \"id\": \"beach-18c\",\n  \"title\": \"beach\",\n  \"kind\": \"video\",\n  \"file\": \"media.mp4\",\n  \"builtin\": false\n}";

    #[test]
    fn old_items_load_and_local_ones_are_written_as_before() {
        let item: Item = serde_json::from_str(OLD).unwrap();
        assert_eq!((item.kind, item.file.as_str(), item.catalog_id.as_str()), (Kind::Video, "media.mp4", ""));
        assert_eq!(serde_json::to_string_pretty(&item).unwrap(), OLD);
    }

    #[test]
    fn every_built_in_scene_unpacks_and_loads() {
        assert_eq!(BUILTIN[0].id, crate::config::BUILTIN_SCENE);
        for b in BUILTIN {
            let item = b.item();
            let bytes = item.scene_bytes().unwrap_or_else(|e| panic!("{}: {e}", b.id));
            crate::scene::parse(&bytes).unwrap_or_else(|e| panic!("{}: {e}", b.id));
            // packed scenes come from scenes/out: if that bake is still there, the bytes must match
            let baked = Path::new(env!("CARGO_MANIFEST_DIR")).join("scenes/out").join(format!("{}.kumo", b.id));
            if let (Some(_), Ok(original)) = (b.packed, std::fs::read(baked)) {
                assert!(bytes[..] == original[..], "{}: run `node scenes/pack.mjs` after baking", b.id);
            }
            assert_eq!(item.credit.is_empty(), !b.metro_minis);
            assert_eq!(&b.thumb[..3], [0xFF, 0xD8, 0xFF], "{}: the thumbnail is not a JPEG", b.id);
        }
    }

    #[test]
    fn built_in_scenes_come_first_and_survive_a_sweep() {
        let (_g, _base) = test_home("library-builtin");
        let ids: Vec<String> = list().into_iter().map(|i| i.id).collect();
        assert_eq!(ids[..4], ["pagoda", "metro-block", "autumn-village", "winter-square"]);
        // then the animations, where this build has them
        assert_eq!(ids[4..], ANIMATIONS.iter().map(|b| b.id).collect::<Vec<_>>());
        sweep();
        for item in list() {
            assert!(item.builtin && item.thumbnail().exists(), "{}", item.id);
            assert!(remove(&item.id).is_err());
        }
    }

    #[test]
    fn provenance_round_trip() {
        let item = Item {
            id: "a".into(),
            title: "Wave".into(),
            author: "Hokusai".into(),
            license: "CC0 1.0".into(),
            license_url: "https://creativecommons.org/publicdomain/zero/1.0/".into(),
            source: "Museum".into(),
            source_url: "https://example.org/w".into(),
            credit: "Hokusai, Museum, CC0".into(),
            catalog_id: "cma-1".into(),
            ..Item::default()
        };
        let text = serde_json::to_string(&item).unwrap();
        assert!(text.contains("\"licenseUrl\"") && text.contains("\"catalogId\":\"cma-1\"") && text.contains("\"sourceUrl\""));
        let back: Item = serde_json::from_str(&text).unwrap();
        assert_eq!((back.author, back.license, back.credit, back.catalog_id), (item.author, item.license, item.credit, item.catalog_id));
    }

    #[test]
    fn adopt_moves_a_download_into_the_library() {
        let (_g, base) = test_home("library-adopt");
        let dir = dir();
        assert!(dir.starts_with(&base));
        std::fs::create_dir_all(&dir).unwrap();
        let tmp = dir.join("x.part");
        std::fs::write(&tmp, PAGODA_SCENE).unwrap();
        let thumb = base.join("t.jpg");
        std::fs::write(&thumb, PAGODA_THUMB).unwrap();
        let info = Item { title: "Pagoda".into(), kind: Kind::Scene, catalog_id: "pagoda-copy".into(), license: "CC0 1.0".into(), ..Item::default() };
        let item = adopt(&tmp, "kumo", info.clone(), Some(&thumb)).unwrap();
        assert!(!tmp.exists() && item.path().exists() && item.thumbnail().exists());
        assert!(item.id.starts_with("pagoda-copy-") && item.file == "media.kumo");
        assert_eq!(by_catalog_id("pagoda-copy").unwrap().id, item.id);
        assert!(by_catalog_id("").is_none() && by_catalog_id("other").is_none());
        // a bad extension leaves nothing behind
        std::fs::write(&tmp, b"x").unwrap();
        assert!(adopt(&tmp, "../x", info, None).is_err());
        assert!(!tmp.exists());
        sweep();
        assert_eq!(list().len(), builtins().count() + 1);
    }

    #[test]
    fn animations_are_built_in_only() {
        let animations: Vec<Item> = builtin_items().into_iter().filter(|i| i.kind == Kind::Shader).collect();
        // the Windows build compiles them, the Mac crate lists none
        assert_eq!(animations.is_empty(), !cfg!(shader_wallpapers));
        let ids: Vec<&str> = builtins().map(|b| b.id).collect();
        for (i, id) in ids.iter().enumerate() {
            assert!(!ids[..i].contains(id), "{id} is listed twice");
        }
        for (b, item) in ANIMATIONS.iter().zip(&animations) {
            assert!(item.builtin && item.credit.is_empty() && item.file.is_empty());
            assert!(item.scene_bytes().is_err(), "{} is not a scene", item.id);
            assert_eq!(&b.thumb[..3], [0xFF, 0xD8, 0xFF], "{}: the thumbnail is not a JPEG", b.id);
            assert!(b.thumb.len() > 5000, "{}: the thumbnail is a placeholder", b.id);
        }
    }

    #[test]
    fn the_shader_kind_is_never_read_or_written() {
        for (kind, text) in [(Kind::Scene, "\"scene\""), (Kind::Video, "\"video\""), (Kind::Image, "\"image\"")] {
            assert_eq!(serde_json::to_string(&kind).unwrap(), text);
            assert_eq!(serde_json::from_str::<Kind>(text).unwrap(), kind);
        }
        assert!(serde_json::from_str::<Kind>("\"shader\"").is_err());
        assert!(serde_json::to_string(&Kind::Shader).is_err());
        // a wallpaper.json that claims to be one does not load, and none can be saved
        assert!(serde_json::from_str::<Item>(&OLD.replace("\"video\"", "\"shader\"")).is_err());
        assert!(serde_json::to_string(&Item { kind: Kind::Shader, ..Item::default() }).is_err());
        // the catalogue keeps exactly pictures, videos and scenes
        let entry = |id: &str, kind: &str| {
            serde_json::json!({ "id": id, "title": id, "kind": kind, "license": "CC0 1.0",
                "thumb": "https://kumo.hyos.tech/t.jpg", "file": "https://kumo.hyos.tech/f" })
        };
        let file = serde_json::json!({ "version": 1, "items": [entry("a", "image"), entry("b", "shader"), entry("c", "video"), entry("d", "scene"), entry("e", "Shader")] });
        let c = crate::catalog::parse(file.to_string().as_bytes()).unwrap();
        assert_eq!(c.items.iter().map(|e| (e.id.as_str(), e.kind)).collect::<Vec<_>>(), [("a", Kind::Image), ("c", Kind::Video), ("d", Kind::Scene)]);
    }

    #[test]
    fn file_types() {
        assert_eq!(kind_of(Path::new("a.MP4")), Some(Kind::Video));
        assert_eq!(kind_of(Path::new("a.webm")), Some(Kind::Video));
        assert_eq!(kind_of(Path::new("b.jpeg")), Some(Kind::Image));
        assert_eq!(kind_of(Path::new("c.kumo")), Some(Kind::Scene));
        assert_eq!(kind_of(Path::new("d.txt")), None);
        assert_eq!(kind_of(Path::new("noextension")), None);
    }
}
