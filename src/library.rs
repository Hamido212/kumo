//! The wallpaper library: the built-in pagoda scene plus everything the user added.
//!
//! Every added wallpaper lives in its own folder `%APPDATA%\Kumo\library\<id>\` with the media
//! file, a `thumb.jpg` and a `wallpaper.json` describing it.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub static PAGODA_SCENE: &[u8] = include_bytes!("../assets/pagoda.kumo");
static PAGODA_THUMB: &[u8] = include_bytes!("../assets/pagoda-thumb.jpg");

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Scene,
    Video,
    #[default]
    Image,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub title: String,
    pub kind: Kind,
    /// media file name inside the item's folder (empty for the built-in scene)
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub builtin: bool,
    // Provenance of a catalogue download; all empty for the user's own files, so their
    // wallpaper.json stays as it always was.
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
        if self.builtin {
            Ok(std::borrow::Cow::Borrowed(PAGODA_SCENE))
        } else {
            std::fs::read(self.path()).map(std::borrow::Cow::Owned)
        }
    }
}

fn builtin() -> Item {
    Item { id: crate::config::BUILTIN_SCENE.into(), title: "Voxel Pagoda Garden".into(), kind: Kind::Scene, builtin: true, ..Item::default() }
}

/// All wallpapers: the built-in one first, then the user's, newest first.
pub fn list() -> Vec<Item> {
    let b = builtin();
    if !b.thumbnail().exists() {
        let _ = std::fs::create_dir_all(b.folder());
        let _ = std::fs::write(b.thumbnail(), PAGODA_THUMB);
    }
    let mut items = vec![b];
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
        if e.path().is_dir() && e.file_name() != crate::config::BUILTIN_SCENE && !e.path().join("wallpaper.json").exists() {
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
        assert_eq!(list().len(), 2);
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
