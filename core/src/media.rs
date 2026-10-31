//! Shared ffmpeg and loopback HTTP helpers for camera streams.

use anyhow::{anyhow, Result};
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
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
    Err(anyhow!(
        "找不到 ffmpeg。安装 `brew install ffmpeg`，或设置 MIHOME_FFMPEG"
    ))
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
