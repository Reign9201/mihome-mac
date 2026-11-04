//! Shared ffmpeg and loopback HTTP helpers for camera streams.

use anyhow::{anyhow, Result};
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

pub fn find_ffmpeg() -> Result<PathBuf> {
    if let Ok(value) = std::env::var("MIHOME_FFMPEG") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
        return Err(anyhow!(
            "MIHOME_FFMPEG 指向的文件不存在：{}",
            path.display()
        ));
    }

    let executable = std::env::current_exe().ok();
    let cwd = std::env::current_dir().ok();
    let path_env = std::env::var("PATH").ok();
    for path in ffmpeg_candidates(executable.as_deref(), cwd.as_deref(), path_env.as_deref()) {
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(anyhow!(
        "找不到应用内置的 ffmpeg。请重新安装 MiHome Mac，或设置 MIHOME_FFMPEG 覆盖"
    ))
}

fn ffmpeg_candidates(
    executable: Option<&Path>,
    cwd: Option<&Path>,
    path_env: Option<&str>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut push = |path: PathBuf| {
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    };

    if let Some(executable) = executable {
        let mut current = executable.parent();
        for _ in 0..6 {
            let Some(dir) = current else {
                break;
            };
            push(dir.join("ffmpeg"));
            push(dir.join("helpers/ffmpeg/ffmpeg"));
            push(dir.join("helpers/ffmpeg"));
            push(dir.join("Resources/ffmpeg"));
            push(dir.join("Resources/helpers/ffmpeg/ffmpeg"));
            current = dir.parent();
        }
    }
    if let Some(cwd) = cwd {
        push(cwd.join("helpers/ffmpeg/ffmpeg"));
        push(cwd.join("helpers/ffmpeg"));
        push(cwd.join("ffmpeg"));
    }
    for path in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        push(PathBuf::from(path));
    }
    if let Some(path_env) = path_env {
        for dir in path_env.split(':').filter(|dir| !dir.is_empty()) {
            push(PathBuf::from(dir).join("ffmpeg"));
        }
    }
    candidates
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

#[cfg(test)]
mod tests {
    use super::ffmpeg_candidates;
    use std::path::{Path, PathBuf};

    #[test]
    fn finds_the_bundled_sidecar_before_system_installs() {
        let candidates = ffmpeg_candidates(
            Some(Path::new(
                "/Applications/MiHome Mac.app/Contents/MacOS/mihome-mac",
            )),
            Some(Path::new("/Users/test/mihome-mac")),
            Some("/usr/bin:/opt/homebrew/bin"),
        );

        assert_eq!(
            candidates.first(),
            Some(&PathBuf::from(
                "/Applications/MiHome Mac.app/Contents/MacOS/ffmpeg"
            ))
        );
        let sidecar = candidates
            .iter()
            .position(|path| path.ends_with("Contents/MacOS/ffmpeg"))
            .unwrap();
        let homebrew = candidates
            .iter()
            .position(|path| path == Path::new("/opt/homebrew/bin/ffmpeg"))
            .unwrap();
        let path_ffmpeg = candidates
            .iter()
            .position(|path| path == Path::new("/usr/bin/ffmpeg"))
            .unwrap();
        assert!(sidecar < homebrew);
        assert!(homebrew < path_ffmpeg);
    }

    #[test]
    fn checks_repository_helper_paths_for_development_builds() {
        let candidates = ffmpeg_candidates(
            Some(Path::new("/repo/desktop/src-tauri/target/debug/mihome-mac")),
            Some(Path::new("/repo")),
            None,
        );

        assert!(candidates.contains(&PathBuf::from("/repo/helpers/ffmpeg/ffmpeg")));
        assert!(!candidates.contains(&PathBuf::from("/repo/helpers/ffmpeg/ffmpeg/ffmpeg")));
    }
}
