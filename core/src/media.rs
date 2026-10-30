//! Shared ffmpeg and loopback HTTP helpers for camera streams.

use anyhow::{anyhow, Result};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub fn find_ffmpeg() -> Result<PathBuf> {
    if let Ok(value) = std::env::var("MIHOME_FFMPEG") {
        return Ok(PathBuf::from(value));
    }
    for path in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let path = PathBuf::from(dir).join("ffmpeg");
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    Err(anyhow!("找不到 ffmpeg。安装 `brew install ffmpeg`，或设置 MIHOME_FFMPEG"))
}

pub fn free_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

pub fn wait_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(250),
        )
        .is_ok()
        {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

pub fn tail(path: &Path, lines: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join(" | ")
}

pub struct FileServer {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl FileServer {
    pub fn start(dir: PathBuf) -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let thread = thread::spawn(move || {
            while !stop_thread.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = handle_file(stream, &dir);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(15));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            port,
            stop,
            thread: Some(thread),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn handle_file(mut stream: TcpStream, dir: &Path) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut buffer = [0u8; 4096];
    let read = stream.read(&mut buffer)?;
    if read == 0 {
        return Ok(());
    }
    let request = String::from_utf8_lossy(&buffer[..read]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let relative = path.split('?').next().unwrap_or("/").trim_start_matches('/');
    if relative.contains("..") {
        return write_response(&mut stream, 400, "text/plain", b"bad path");
    }
    let file = dir.join(relative);
    match fs::read(&file) {
        Ok(body) => {
            let mime = match Path::new(relative).extension().and_then(|value| value.to_str()) {
                Some("m3u8") => "application/vnd.apple.mpegurl",
                Some("m4s") | Some("mp4") => "video/mp4",
                Some("ts") => "video/mp2t",
                _ => "application/octet-stream",
            };
            write_response(&mut stream, 200, mime, &body)
        }
        Err(_) => write_response(&mut stream, 404, "text/plain", b"not found"),
    }
}

fn write_response(stream: &mut TcpStream, status: u16, mime: &str, body: &[u8]) -> Result<()> {
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    Ok(())
}
