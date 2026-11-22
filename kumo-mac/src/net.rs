//! HTTPS GETs through the system's curl (part of macOS, and of Windows 10 and later, so this
//! also runs on a Windows dev PC). Same API as the WinHTTP version in the Windows build.
//!
//! curl is told to follow no redirects; they are followed here so every hop passes the
//! catalogue's host check. `-q` keeps a user's ~/.curlrc out, so no cookies, credentials or
//! extra headers sneak in. Proxies come from the usual environment variables.

use crate::catalog::{self, Url};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug)]
pub enum Error {
    /// the address or a redirect leads somewhere Kumo may not go
    NotAllowed(String),
    /// an HTTP status other than the expected one
    Status(u32),
    TooLarge,
    Cancelled,
    Other(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Error::NotAllowed(why) => write!(f, "{why}"),
            Error::Status(code) => write!(f, "the server answered {code}"),
            Error::TooLarge => write!(f, "the file is larger than allowed"),
            Error::Cancelled => write!(f, "cancelled"),
            Error::Other(why) => write!(f, "{why}"),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error {
        Error::Other(e.to_string())
    }
}

pub struct Response {
    pub status: u32,
    pub body: Vec<u8>,
    pub etag: String,
}

const MAX_HOPS: usize = 5;
/// curl's exit code for --max-filesize
const CURL_TOO_LARGE: i32 = 63;
/// room for the response headers that come before the body on stdout
const HEAD_ROOM: usize = 64 << 10;

pub fn user_agent() -> String {
    format!("Kumo/{} (+https://kumo.hyos.tech)", env!("CARGO_PKG_VERSION"))
}

/// The system's curl by full path, never one found through PATH.
fn curl() -> PathBuf {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        root.join("System32").join("curl.exe")
    }
    #[cfg(not(windows))]
    PathBuf::from("/usr/bin/curl")
}

/// What matters of a response's headers.
#[derive(Default)]
struct Head {
    status: u32,
    length: Option<u64>,
    etag: String,
    location: Option<String>,
}

/// Splits curl's `-D -` output into the last header block and the body. A proxy's CONNECT
/// answer and 1xx responses come as blocks of their own before the real one.
fn split_head(out: &[u8]) -> (Head, &[u8]) {
    let mut head = Head::default();
    let mut rest = out;
    while rest.starts_with(b"HTTP/") {
        let end = rest.windows(4).position(|w| w == b"\r\n\r\n");
        let block = String::from_utf8_lossy(&rest[..end.unwrap_or(rest.len())]);
        let mut lines = block.lines();
        head = Head { status: lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).unwrap_or(0), ..Head::default() };
        for (k, v) in lines.filter_map(|l| l.split_once(':')) {
            let v = v.trim();
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => head.length = v.parse().ok(),
                "etag" => head.etag = v.to_string(),
                "location" => head.location = Some(v.to_string()),
                _ => {}
            }
        }
        rest = end.map_or(&[][..], |e| &rest[e + 4..]);
    }
    (head, rest)
}

/// A running curl, killed if it is dropped before it ended.
struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(None) = self.0.try_wait() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

impl Running {
    fn finish(mut self) -> Result<(), Error> {
        let status = self.0.wait()?;
        let mut err = String::new();
        if let Some(e) = self.0.stderr.as_mut() {
            let _ = e.take(4096).read_to_string(&mut err);
        }
        match status.code() {
            Some(0) => Ok(()),
            Some(CURL_TOO_LARGE) => Err(Error::TooLarge),
            code => Err(Error::Other(format!("curl failed ({}): {}", code.unwrap_or(-1), err.trim()))),
        }
    }
}

fn spawn(u: &Url, max: u64, etag: Option<&str>, output: Option<&Path>) -> Result<Running, Error> {
    let mut c = Command::new(curl());
    // -q must come first: it keeps ~/.curlrc out
    c.arg("-q").args(["--silent", "--show-error", "--globoff", "--max-redirs", "0", "-D", "-"]);
    c.args(["--proto", if u.https { "=https" } else { "=http" }]);
    c.args(["--connect-timeout", "15", "--speed-limit", "1", "--speed-time", "30"]);
    c.arg("--max-filesize").arg(max.to_string());
    c.arg("-A").arg(user_agent()).args(["-H", "Accept:"]);
    if u.loopback() {
        c.args(["--noproxy", "*"]);
    }
    if let Some(t) = etag.filter(|t| t.bytes().all(|b| (b' '..0x7f).contains(&b))) {
        c.arg("-H").arg(format!("If-None-Match: {t}"));
    }
    if let Some(o) = output {
        c.arg("-o").arg(o);
    }
    c.arg(u.to_string()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    Ok(Running(c.spawn().map_err(|e| Error::Other(format!("curl: {e}")))?))
}

fn is_redirect(status: u32) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn redirect(u: &Url, head: Head) -> Result<String, Error> {
    Ok(u.join(&head.location.ok_or_else(|| Error::Other("a redirect without a target".into()))?))
}

/// GET into memory, refusing more than `max` bytes. `etag` is sent as If-None-Match; 304 gives
/// an empty body.
pub fn get(url: &str, max: usize, etag: Option<&str>) -> Result<Response, Error> {
    let mut url = url.to_string();
    for _ in 0..=MAX_HOPS {
        let u = catalog::check_url(&url).map_err(Error::NotAllowed)?;
        let mut run = spawn(&u, max as u64, etag, None)?;
        let mut out = Vec::new();
        let mut stdout = run.0.stdout.take().ok_or_else(|| Error::Other("curl: no output".into()))?;
        let mut buf = vec![0u8; 64 << 10];
        loop {
            let n = stdout.read(&mut buf)?;
            if n == 0 {
                break;
            }
            if out.len() + n > max + HEAD_ROOM {
                return Err(Error::TooLarge);
            }
            out.extend_from_slice(&buf[..n]);
        }
        run.finish()?;
        let (head, body) = split_head(&out);
        if body.len() > max {
            return Err(Error::TooLarge);
        }
        if is_redirect(head.status) {
            url = redirect(&u, head)?;
            continue;
        }
        return match head.status {
            304 => Ok(Response { status: 304, body: Vec::new(), etag: head.etag }),
            200 => Ok(Response { status: 200, body: body.to_vec(), etag: head.etag }),
            s => Err(Error::Status(s)),
        };
    }
    Err(Error::Other("too many redirects".into()))
}

/// GET to a file. Stops at `max` bytes (also when Content-Length already says so), checks
/// `cancel` while curl runs, reports (bytes so far, total if known) from the file's size.
/// Returns the byte count. A failed or cancelled download removes the partial file.
pub fn download(url: &str, dst: &Path, max: u64, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<u64, Error> {
    let r = fetch_to(url, dst, max, cancel, progress);
    if r.is_err() {
        let _ = std::fs::remove_file(dst);
    }
    r
}

fn fetch_to(url: &str, dst: &Path, max: u64, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<u64, Error> {
    let mut url = url.to_string();
    for _ in 0..=MAX_HOPS {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let u = catalog::check_url(&url).map_err(Error::NotAllowed)?;
        let _ = std::fs::remove_file(dst);
        let mut run = spawn(&u, max, None, Some(dst))?;
        // only the headers come on stdout; a thread collects them while the body goes to the file
        let headers = Arc::new(Mutex::new(Vec::new()));
        let mut stdout = run.0.stdout.take().ok_or_else(|| Error::Other("curl: no output".into()))?;
        let sink = headers.clone();
        let reader = std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n @ 1..) = stdout.read(&mut buf) {
                let mut h = sink.lock().unwrap();
                if h.len() < HEAD_ROOM {
                    h.extend_from_slice(&buf[..n]);
                }
            }
        });
        let mut last = None;
        while run.0.try_wait()?.is_none() {
            if cancel.load(Ordering::Relaxed) {
                return Err(Error::Cancelled);
            }
            let size = std::fs::metadata(dst).map(|m| m.len()).unwrap_or(0);
            if size > max {
                return Err(Error::TooLarge);
            }
            let head = split_head(&headers.lock().unwrap()).0;
            if head.status == 200 && last != Some(size) {
                last = Some(size);
                progress(size, head.length);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = reader.join();
        run.finish()?;
        let head = split_head(&headers.lock().unwrap()).0;
        if is_redirect(head.status) {
            url = redirect(&u, head)?;
            continue;
        }
        if head.status != 200 {
            return Err(Error::Status(head.status));
        }
        let size = std::fs::metadata(dst).map(|m| m.len()).unwrap_or(0);
        if size > max {
            return Err(Error::TooLarge);
        }
        if head.length.is_some_and(|t| t != size) {
            return Err(Error::Other("the connection ended early".into()));
        }
        progress(size, head.length);
        return Ok(size);
    }
    Err(Error::Other("too many redirects".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::test_server::{start, Reply};

    fn out(name: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("test-out").join("net");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = std::fs::remove_file(&p);
        p
    }

    fn body(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 7 % 251) as u8).collect()
    }

    fn server() -> String {
        start(|r| {
            let ua = r.header("User-Agent").unwrap_or("").to_string();
            match r.path.as_str() {
                "/small" => Reply::ok(b"hello".to_vec()).header("ETag", "\"e1\""),
                "/etag" if r.header("If-None-Match") == Some("\"e1\"") => Reply::status(304).header("ETag", "\"e1\""),
                "/etag" => Reply::ok(b"fresh".to_vec()).header("ETag", "\"e1\""),
                "/ua" => Reply::ok(format!("{ua} accept={:?} cookie={:?}", r.header("Accept"), r.header("Cookie")).into_bytes()),
                "/big" => Reply::ok(body(1 << 20)),
                "/unsized" => Reply { length: false, ..Reply::ok(body(300_000)) },
                "/redirect" => Reply::redirect("/big"),
                "/away" => Reply::redirect("https://evil.example/x"),
                "/loop" => Reply::redirect("/loop"),
                _ => Reply::status(404),
            }
        })
    }

    #[test]
    fn head_blocks() {
        let (h, body) = split_head(b"HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 302\r\nlocation: /x\r\netag: \"a\"\r\n\r\n");
        assert_eq!((h.status, h.location.as_deref(), h.etag.as_str(), body.len()), (302, Some("/x"), "\"a\"", 0));
        let (h, body) = split_head(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi");
        assert_eq!((h.status, h.length, body), (200, Some(2), &b"hi"[..]));
    }

    #[test]
    fn get_ok_etag_and_limits() {
        let s = server();
        let r = get(&format!("{s}/small"), 100, None).unwrap();
        assert_eq!((r.status, r.body.as_slice(), r.etag.as_str()), (200, &b"hello"[..], "\"e1\""));
        let r = get(&format!("{s}/etag"), 100, Some("\"e1\"")).unwrap();
        assert_eq!((r.status, r.body.len()), (304, 0));
        let ua = String::from_utf8(get(&format!("{s}/ua"), 1000, None).unwrap().body).unwrap();
        assert_eq!(ua, format!("{} accept=None cookie=None", user_agent()));
        assert_eq!(get(&format!("{s}/redirect"), 2 << 20, None).unwrap().body, body(1 << 20));
        assert!(matches!(get(&format!("{s}/big"), 1000, None), Err(Error::TooLarge)));
        assert!(matches!(get(&format!("{s}/unsized"), 1000, None), Err(Error::TooLarge)));
        assert!(matches!(get(&format!("{s}/missing"), 1000, None), Err(Error::Status(404))));
        assert!(matches!(get(&format!("{s}/away"), 1000, None), Err(Error::NotAllowed(_))));
        assert!(matches!(get("https://evil.example/", 10, None), Err(Error::NotAllowed(_))));
    }

    #[test]
    fn download_redirects_limits_cancel() {
        let s = server();
        let dst = out("curl-big.bin");
        let mut calls = Vec::new();
        assert_eq!(download(&format!("{s}/redirect"), &dst, 2 << 20, &AtomicBool::new(false), &mut |d, t| calls.push((d, t))).unwrap(), 1 << 20);
        assert_eq!(std::fs::read(&dst).unwrap(), body(1 << 20));
        assert_eq!(calls.last(), Some(&(1 << 20, Some(1 << 20))));
        for (path, max) in [("/away", 1 << 20), ("/loop", 1 << 20), ("/missing", 1 << 20), ("/big", 1000), ("/unsized", 100_000)] {
            let r = download(&format!("{s}{path}"), &dst, max, &AtomicBool::new(false), &mut |_, _| {});
            assert!(r.is_err(), "{path}");
            assert!(!dst.exists(), "{path}");
        }
        let cancel = AtomicBool::new(true);
        assert!(matches!(download(&format!("{s}/big"), &dst, 2 << 20, &cancel, &mut |_, _| {}), Err(Error::Cancelled)));
        assert!(!dst.exists());
    }
}
