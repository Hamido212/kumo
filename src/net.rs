//! HTTPS GETs through WinHTTP, the HTTP stack that ships with Windows: the system's proxy
//! settings and TLS, no extra crate. Only hosts on the catalogue's allow-list are reached;
//! redirects are followed here, not by WinHTTP, so every hop is checked. No cookies, no
//! credentials, no client certificates, and no header beyond the User-Agent that says who we are.

use crate::catalog::{self, Url};
use std::ffi::c_void;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Networking::WinHttp::*;

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

impl From<windows::core::Error> for Error {
    fn from(e: windows::core::Error) -> Error {
        // WinHTTP's codes have no text in the system message table: name the common ones, keep the number
        let code = e.code().0 as u32 & 0xffff;
        let what = match code {
            12002 => "the server took too long to answer",
            12007 => "no internet connection, or the server's name was not found",
            12029 | 12030 | 12152 => "the server could not be reached",
            12175 => "the secure connection failed",
            _ => "network error",
        };
        Error::Other(format!("{what} ({code}) {}", e.message()).trim_end().to_string())
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
/// read buffer: downloads never hold more than this in memory
const CHUNK: usize = 64 << 10;

pub fn user_agent() -> String {
    format!("Kumo/{} (+https://kumo.hyos.tech)", env!("CARGO_PKG_VERSION"))
}

/// A WinHTTP handle, closed when dropped.
struct Handle(*mut c_void);

impl Handle {
    fn new(h: *mut c_void) -> Result<Handle, Error> {
        if h.is_null() {
            Err(windows::core::Error::from_win32().into())
        } else {
            Ok(Handle(h))
        }
    }

    fn set(&self, option: u32, value: u32) -> windows::core::Result<()> {
        unsafe { WinHttpSetOption(Some(self.0 as *const c_void), option, Some(&value.to_ne_bytes())) }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

/// An answered request. Fields drop in order, so the request closes before its connection.
struct Open {
    req: Handle,
    _connect: Handle,
    _session: Handle,
    status: u32,
    length: Option<u64>,
    etag: String,
}

impl Open {
    fn read(&self, buf: &mut [u8]) -> Result<usize, Error> {
        let mut n = 0u32;
        unsafe { WinHttpReadData(self.req.0, buf.as_mut_ptr().cast(), buf.len() as u32, &mut n)? };
        Ok(n as usize)
    }
}

fn header(req: &Handle, level: u32) -> Option<String> {
    let mut len = 0u32;
    unsafe {
        let _ = WinHttpQueryHeaders(req.0, level, PCWSTR::null(), None, &mut len, std::ptr::null_mut());
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize / 2 + 1];
        WinHttpQueryHeaders(req.0, level, PCWSTR::null(), Some(buf.as_mut_ptr().cast()), &mut len, std::ptr::null_mut()).ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize / 2]))
    }
}

fn request(url: &Url, etag: Option<&str>) -> Result<Open, Error> {
    unsafe {
        // loopback (tests, devnet) never goes through a proxy
        let access = if url.loopback() { WINHTTP_ACCESS_TYPE_NO_PROXY } else { WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY };
        let session = Handle::new(WinHttpOpen(&HSTRING::from(user_agent()), access, PCWSTR::null(), PCWSTR::null(), 0))?;
        WinHttpSetTimeouts(session.0, 15_000, 15_000, 30_000, 30_000)?;
        session.set(WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_NEVER)?;
        let connect = Handle::new(WinHttpConnect(session.0, &HSTRING::from(url.host.as_str()), url.port, 0))?;
        let flags = if url.https { WINHTTP_FLAG_SECURE } else { WINHTTP_OPEN_REQUEST_FLAGS(0) };
        let req = Handle::new(WinHttpOpenRequest(connect.0, w!("GET"), &HSTRING::from(url.path.as_str()), PCWSTR::null(), PCWSTR::null(), std::ptr::null(), flags))?;
        req.set(WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION | WINHTTP_DISABLE_REDIRECTS)?;
        req.set(WINHTTP_OPTION_AUTOLOGON_POLICY, WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH)?;
        if url.https {
            // answer a server's certificate request with "none" instead of picking one
            WinHttpSetOption(Some(req.0 as *const c_void), WINHTTP_OPTION_CLIENT_CERT_CONTEXT, None)?;
        }
        let extra: Option<Vec<u16>> = etag.filter(|t| t.bytes().all(|b| (b' '..0x7f).contains(&b))).map(|t| format!("If-None-Match: {t}\r\n").encode_utf16().collect());
        WinHttpSendRequest(req.0, extra.as_deref(), None, 0, 0, 0)?;
        WinHttpReceiveResponse(req.0, std::ptr::null_mut())?;
        let status = header(&req, WINHTTP_QUERY_STATUS_CODE).and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        let length = header(&req, WINHTTP_QUERY_CONTENT_LENGTH).and_then(|s| s.trim().parse().ok());
        let etag = header(&req, WINHTTP_QUERY_ETAG).unwrap_or_default();
        Ok(Open { req, _connect: connect, _session: session, status, length, etag })
    }
}

/// Sends the request and follows up to five redirects, checking each target.
fn open(url: &str, etag: Option<&str>) -> Result<Open, Error> {
    let mut url = url.to_string();
    for _ in 0..=MAX_HOPS {
        let u = catalog::check_url(&url).map_err(Error::NotAllowed)?;
        let o = request(&u, etag)?;
        if !matches!(o.status, 301 | 302 | 303 | 307 | 308) {
            return Ok(o);
        }
        let to = header(&o.req, WINHTTP_QUERY_LOCATION).ok_or_else(|| Error::Other("a redirect without a target".into()))?;
        url = u.join(to.trim());
    }
    Err(Error::Other("too many redirects".into()))
}

/// GET into memory, refusing more than `max` bytes. `etag` is sent as If-None-Match; 304 gives
/// an empty body.
pub fn get(url: &str, max: usize, etag: Option<&str>) -> Result<Response, Error> {
    let o = open(url, etag)?;
    if o.status == 304 {
        return Ok(Response { status: 304, body: Vec::new(), etag: o.etag });
    }
    if o.status != 200 {
        return Err(Error::Status(o.status));
    }
    if o.length.is_some_and(|n| n > max as u64) {
        return Err(Error::TooLarge);
    }
    let mut body = Vec::with_capacity(o.length.unwrap_or(0) as usize);
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = o.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if body.len() + n > max {
            return Err(Error::TooLarge);
        }
        body.extend_from_slice(&buf[..n]);
    }
    Ok(Response { status: o.status, body, etag: o.etag })
}

/// GET to a file with a fixed buffer. Stops at `max` bytes (also when Content-Length already
/// says so), checks `cancel` between reads, reports (bytes so far, total if known). Returns the
/// byte count. A failed or cancelled download removes the partial file.
pub fn download(url: &str, dst: &Path, max: u64, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<u64, Error> {
    let r = fetch_to(url, dst, max, cancel, progress);
    if r.is_err() {
        let _ = std::fs::remove_file(dst);
    }
    r
}

fn fetch_to(url: &str, dst: &Path, max: u64, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<u64, Error> {
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::Cancelled);
    }
    let o = open(url, None)?;
    if o.status != 200 {
        return Err(Error::Status(o.status));
    }
    if o.length.is_some_and(|n| n > max) {
        return Err(Error::TooLarge);
    }
    let mut file = std::fs::File::create(dst)?;
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    progress(0, o.length);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let n = o.read(&mut buf)?;
        if n == 0 {
            break;
        }
        done += n as u64;
        if done > max {
            return Err(Error::TooLarge);
        }
        file.write_all(&buf[..n])?;
        progress(done, o.length);
    }
    if o.length.is_some_and(|n| n != done) {
        return Err(Error::Other("the connection ended early".into()));
    }
    file.flush()?;
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::test_server::{start, Reply};

    fn out(name: &str) -> std::path::PathBuf {
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
                "/ua" => Reply::ok(ua.into_bytes()),
                "/headers" => Reply::ok(format!("cookie={:?} auth={:?} referer={:?}", r.header("Cookie"), r.header("Authorization"), r.header("Referer")).into_bytes()),
                "/big" => Reply::ok(body(1 << 20)),
                "/unsized" => Reply { length: false, ..Reply::ok(body(300_000)) },
                "/redirect" => Reply::redirect("/big"),
                "/away" => Reply::redirect("https://evil.example/x"),
                "/plain-away" => Reply::redirect("http://example.org/x"),
                "/loop" => Reply::redirect("/loop"),
                _ => Reply::status(404),
            }
        })
    }

    #[test]
    fn get_ok_etag_and_limits() {
        let s = server();
        let r = get(&format!("{s}/small"), 100, None).unwrap();
        assert_eq!((r.status, r.body.as_slice(), r.etag.as_str()), (200, &b"hello"[..], "\"e1\""));
        let r = get(&format!("{s}/etag"), 100, Some("\"e1\"")).unwrap();
        assert_eq!((r.status, r.body.len(), r.etag.as_str()), (304, 0, "\"e1\""));
        assert_eq!(get(&format!("{s}/etag"), 100, Some("\"old\"")).unwrap().body, b"fresh");
        let ua = get(&format!("{s}/ua"), 100, None).unwrap().body;
        assert_eq!(String::from_utf8(ua).unwrap(), format!("Kumo/{} (+https://kumo.hyos.tech)", env!("CARGO_PKG_VERSION")));
        let h = get(&format!("{s}/headers"), 1000, None).unwrap().body;
        assert_eq!(String::from_utf8(h).unwrap(), "cookie=None auth=None referer=None");
        assert!(matches!(get(&format!("{s}/big"), 1000, None), Err(Error::TooLarge)));
        assert!(matches!(get(&format!("{s}/unsized"), 1000, None), Err(Error::TooLarge)));
        assert_eq!(get(&format!("{s}/unsized"), 300_000, None).unwrap().body, body(300_000));
        assert!(matches!(get(&format!("{s}/missing"), 1000, None), Err(Error::Status(404))));
    }

    #[test]
    fn addresses_are_checked_before_connecting() {
        for url in ["https://evil.example/x", "http://kumo.hyos.tech/x", "ftp://kumo.hyos.tech/", "http://192.168.0.1:80/"] {
            assert!(matches!(get(url, 10, None), Err(Error::NotAllowed(_))), "{url}");
        }
    }

    #[test]
    fn download_progress_and_redirects() {
        let s = server();
        let dst = out("big.bin");
        let mut calls = Vec::new();
        let n = download(&format!("{s}/redirect"), &dst, 2 << 20, &AtomicBool::new(false), &mut |d, t| calls.push((d, t))).unwrap();
        assert_eq!(n, 1 << 20);
        assert_eq!(std::fs::read(&dst).unwrap(), body(1 << 20));
        assert_eq!(calls.first(), Some(&(0, Some(1 << 20))));
        assert_eq!(calls.last(), Some(&(1 << 20, Some(1 << 20))));
        assert!(calls.windows(2).all(|w| w[0].0 <= w[1].0) && calls.len() > 2);
        // redirects to a forbidden host, to plain http elsewhere, in circles
        for (path, forbidden) in [("/away", true), ("/plain-away", true), ("/loop", false), ("/missing", false)] {
            let dst = out("never.bin");
            let r = download(&format!("{s}{path}"), &dst, 1 << 20, &AtomicBool::new(false), &mut |_, _| {});
            assert!(r.is_err(), "{path}");
            assert_eq!(matches!(r, Err(Error::NotAllowed(_))), forbidden, "{path}");
            assert!(!dst.exists(), "{path}");
        }
    }

    #[test]
    fn download_limits_and_cancel_remove_the_file() {
        let s = server();
        let dst = out("limit.bin");
        std::fs::write(&dst, b"old").unwrap();
        // Content-Length already too big
        assert!(matches!(download(&format!("{s}/big"), &dst, 1000, &AtomicBool::new(false), &mut |_, _| {}), Err(Error::TooLarge)));
        assert!(!dst.exists());
        // no Content-Length: stops while streaming
        let mut most = 0;
        assert!(matches!(download(&format!("{s}/unsized"), &dst, 100_000, &AtomicBool::new(false), &mut |d, _| most = most.max(d)), Err(Error::TooLarge)));
        assert!(most <= 100_000 && !dst.exists());
        // cancelled after the first chunk
        let cancel = AtomicBool::new(false);
        let r = download(&format!("{s}/big"), &dst, 2 << 20, &cancel, &mut |d, _| {
            if d > 0 {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert!(matches!(r, Err(Error::Cancelled)));
        assert!(!dst.exists());
        // cancelled before it started
        assert!(matches!(download(&format!("{s}/small"), &dst, 100, &cancel, &mut |_, _| {}), Err(Error::Cancelled)));
        assert!(!dst.exists());
    }
}
