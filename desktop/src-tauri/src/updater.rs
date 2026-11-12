//! 应用内升级：与 montage 项目相同的思路——匿名查询 GitHub Releases，比对版本，
//! 下载与架构匹配的 DMG，校验 sha256 后挂载并替换当前 .app，最后重启。
//! 发布资产由 CI 上传，命名为 `MiHome-Mac-<版本>-<架构>.dmg`（附带 `.sha256`）。

use futures_util::StreamExt;
use mihome_core::logging as app_log;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::ipc::Channel;

const GITHUB_REPO: &str = "Reign9201/mihome-mac";
const API_BASE: &str = "https://api.github.com";
const USER_AGENT: &str = concat!("MiHomeMac-Updater/", env!("CARGO_PKG_VERSION"));

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub notes: String,
    pub size: u64,
    pub download_url: String,
    pub sha256: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
}

fn asset_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

/// 直连 GitHub 失败时（典型的大陆网络），读取 macOS 系统代理再试一次。
fn system_https_proxy() -> Option<String> {
    if cfg!(not(target_os = "macos")) {
        return None;
    }
    let output = Command::new("scutil").arg("--proxy").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let enabled = text.lines().any(|l| l.trim() == "HTTPSEnable : 1");
    if !enabled {
        return None;
    }
    let host = text.lines().find(|l| l.contains("HTTPSProxy"))?
        .split(':').nth(1)?.trim().to_string();
    let port = text.lines().find(|l| l.contains("HTTPSPort"))?
        .split(':').nth(1)?.trim().to_string();
    if host.is_empty() || port.is_empty() {
        return None;
    }
    Some(format!("http://{host}:{port}"))
}

async fn http_client() -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30));
    if let Some(proxy) = system_https_proxy() {
        if let Ok(p) = reqwest::Proxy::all(&proxy) {
            builder = builder.proxy(p);
        }
        app_log::info("Updater", format!("更新检查走系统代理 {proxy}"));
    }
    builder.build().expect("构建 HTTP 客户端失败")
}

/// 简易语义化版本比较：逐段数值比较，返回 latest 是否大于 current。
fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split(|c: char| c == '.' || !c.is_ascii_digit())
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse().ok())
            .collect()
    };
    let (l, c) = (parse(latest), parse(current));
    for i in 0..l.len().max(c.len()) {
        let a = l.get(i).copied().unwrap_or(0);
        let b = c.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    false
}

fn pick_dmg_asset(assets: &[Value]) -> Option<(String, u64, String)> {
    let arch = asset_arch();
    let suffix = format!("-{arch}.dmg");
    let dmg = assets.iter().find(|a| {
        let name = a["name"].as_str().unwrap_or_default();
        name.ends_with(&suffix) && !name.ends_with(".sha256")
    })?;
    let name = dmg["name"].as_str()?;
    let url = dmg["browser_download_url"].as_str()?.to_string();
    let size = dmg["size"].as_u64().unwrap_or(0);
    // sha256 以同名 `.sha256` 资产里的文本为准
    let sha_name = format!("{name}.sha256");
    let sha_url = assets.iter()
        .find(|a| a["name"].as_str() == Some(sha_name.as_str()))
        .and_then(|a| a["browser_download_url"].as_str())
        .map(str::to_string);
    Some((url, size, sha_url.unwrap_or_default()))
}

#[tauri::command]
pub async fn updater_check() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let client = http_client().await;
    let url = format!("{API_BASE}/repos/{GITHUB_REPO}/releases/latest");
    let release: Value = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("访问 GitHub Releases 失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("查询最新版本失败：{e}"))?
        .json()
        .await
        .map_err(|e| format!("解析版本信息失败：{e}"))?;
    let tag = release["tag_name"].as_str().unwrap_or_default().to_string();
    if tag.is_empty() {
        return Err("最新发布缺少版本标签".into());
    }
    let assets = release["assets"].as_array().cloned().unwrap_or_default();
    let (download_url, size, sha_url) = pick_dmg_asset(&assets)
        .ok_or_else(|| format!("发布 {tag} 中找不到 {arch} 架构的 DMG", arch = asset_arch()))?;
    let mut sha256 = String::new();
    if !sha_url.is_empty() {
        if let Ok(response) = client.get(&sha_url).send().await {
            if let Ok(body) = response.text().await {
                sha256 = body.split_whitespace().next().unwrap_or("").to_lowercase();
            }
        }
    }
    let notes = release["body"].as_str().unwrap_or_default().to_string();
    let latest_version = tag.trim_start_matches('v').to_string();
    let update_available = version_newer(&latest_version, &current);
    app_log::info("Updater", format!(
        "版本检查：当前 {current}，最新 {latest_version}，可升级 {update_available}"
    ));
    Ok(UpdateInfo {
        current_version: current,
        update_available,
        notes,
        size,
        download_url,
        sha256,
        latest_version,
    })
}

#[tauri::command]
pub async fn updater_download(
    download_url: String,
    expected_sha256: Option<String>,
    on_progress: Channel<DownloadProgress>,
) -> Result<String, String> {
    let expected = expected_sha256.map(|s| s.to_lowercase()).filter(|s| !s.is_empty());
    let client = http_client().await;
    let response = client
        .get(&download_url)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败：{e}"))?;
    let total = response.content_length().unwrap_or(0);
    let file_name = download_url.rsplit('/').next().unwrap_or("MiHome-Mac.dmg");
    let dir = std::env::temp_dir().join("mihome-updates");
    fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
    let path = dir.join(file_name);
    let mut file = fs::File::create(&path).map_err(|e| format!("创建下载文件失败：{e}"))?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_reported: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| format!("写入文件失败：{e}"))?;
        downloaded += chunk.len() as u64;
        // 每 2MB 或完成时上报一次进度
        if downloaded - last_reported >= 2 * 1024 * 1024 || (total > 0 && downloaded >= total) {
            last_reported = downloaded;
            let _ = on_progress.send(DownloadProgress { downloaded, total });
        }
    }
    drop(file);
    let digest = format!("{:x}", hasher.finalize());
    if let Some(expected) = expected {
        if digest != expected {
            let _ = fs::remove_file(&path);
            return Err(format!(
                "安装包校验失败：期望 {expected}，实际 {digest}"
            ));
        }
    }
    app_log::info("Updater", format!("已下载 {downloaded} 字节，sha256 校验通过"));
    Ok(path.to_string_lossy().into_owned())
}

/// 当前应用包路径，例如 /Applications/MiHome Mac.app
fn current_app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| {
            p.extension().map(|e| e == "app").unwrap_or(false)
                && p.file_name().map(|n| n.to_string_lossy().contains("MiHome")).unwrap_or(false)
        })
        .map(Path::to_path_buf)
}

fn run(command: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .map_err(|e| format!("执行 {command} 失败：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{command} 退出码 {}：{}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
pub async fn updater_install(app: tauri::AppHandle, dmg_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(app, Path::new(&dmg_path)))
        .await
        .map_err(|e| format!("安装任务异常：{e}"))?
}

fn install_blocking(app: tauri::AppHandle, dmg: &Path) -> Result<(), String> {
    let bundle = current_app_bundle()
        .ok_or("未找到当前应用包，开发模式请在发布安装后使用应用内升级")?;
    app_log::info("Updater", format!("开始替换应用包 {}", bundle.display()));

    // 挂载 DMG 并定位 .app
    let plist = run("hdiutil", &[
        "attach", "-nobrowse", "-readonly", "-plist",
        &dmg.to_string_lossy(),
    ])?;
    let parsed: Value = serde_json::from_str(&plist).map_err(|e| format!("解析挂载结果失败：{e}"))?;
    let mount_point = parsed["system-entities"]
        .as_array()
        .and_then(|entities| {
            entities.iter().find(|e| e["mount-point"].is_string())
        })
        .and_then(|e| e["mount-point"].as_str())
        .ok_or("DMG 挂载失败：找不到挂载点")?
        .to_string();
    let mounted = Path::new(&mount_point);
    let new_app = fs::read_dir(mounted)
        .map_err(|e| format!("读取挂载卷失败：{e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.extension().map(|e| e == "app").unwrap_or(false))
        .ok_or("挂载卷中找不到 .app")?;

    // 替换：先移走旧包（运行中的进程不受影响），再完整拷入新包
    let backup = bundle.with_extension("app_old");
    let _ = fs::remove_dir_all(&backup);
    fs::rename(&bundle, &backup).map_err(|e| format!("移开旧应用包失败：{e}"))?;
    if let Err(error) = run("ditto", &[&new_app.to_string_lossy(), &bundle.to_string_lossy()]) {
        let _ = fs::rename(&backup, &bundle);
        return Err(format!("复制新应用包失败：{error}"));
    }
    let _ = fs::remove_dir_all(&backup);
    let _ = run("xattr", &["-dr", "com.apple.quarantine", &bundle.to_string_lossy()]);
    let _ = run("hdiutil", &["detach", &mount_point, "-quiet"]);

    app_log::info("Updater", "应用包已替换，准备重启");
    // 先拉起新版本，再退出当前进程；RunEvent::ExitRequested 会走正常清理流程
    let _ = Command::new("open")
        .arg("-n")
        .arg(&bundle)
        .spawn();
    app.exit(0);
    Ok(())
}
