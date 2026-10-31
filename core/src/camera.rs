use anyhow::{anyhow, Context, Result};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::logging as app_log;
use crate::loopback_proxy::LoopbackProxy;

#[cfg(target_arch = "x86_64")]
const GO2RTC_AMD64_SHA256: &str =
    "9eebe5ec870d6762e358a6052796ddb42609429981b359d43c225f5d9cc7b967";
#[cfg(target_arch = "aarch64")]
const GO2RTC_ARM64_SHA256: &str =
    "d69780b0ed222866f2a9a8160537bae9936887ff467626ccba00b8840c609266";
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
const GO2RTC_UNIVERSAL_SHA256: &str =
    "6576ea73b17563e81a77f72c3d692df57208fd1d05c8a9f5b8a7ff6830d54a44";

#[derive(Debug, Clone, Eq, Hash, PartialEq)]
struct VerifiedBinary {
    path: PathBuf,
    len: u64,
    modified_ns: u128,
    changed_ns: i128,
    inode: u64,
    device: u64,
}

static VERIFIED_BINARIES: OnceLock<Mutex<std::collections::HashSet<VerifiedBinary>>> =
    OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraDevice {
    pub did: String,
    pub name: String,
    pub model: String,
    pub ip: Option<String>,
    pub online: bool,
    pub subtype: String,
    pub channel: u32,
    pub spec_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CameraStream {
    pub id: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webrtc_url: Option<String>,
    pub host: String,
    #[serde(default)]
    pub prefer_mse: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CameraDiagnostics {
    pub alive: bool,
    pub api_ready: bool,
    pub detail: String,
}

const DIAGNOSTIC_LINES: usize = 24;

pub struct Go2Rtc {
    child: Child,
    config_path: PathBuf,
    diagnostics: Arc<Mutex<VecDeque<String>>>,
    proxy: LoopbackProxy,
    api_authorization: String,
    pub port: u16,
    rtsp_port: u16,
}

impl Go2Rtc {
    pub fn start_for_camera(
        binary: &Path,
        camera: &CameraDevice,
        user_id: &str,
        pass_token: &str,
    ) -> Result<Self> {
        Self::start_for_cameras(binary, std::slice::from_ref(camera), user_id, pass_token)
    }

    pub fn start_for_cameras(
        binary: &Path,
        cameras: &[CameraDevice],
        user_id: &str,
        pass_token: &str,
    ) -> Result<Self> {
        if cameras.is_empty() {
            return Err(anyhow!("没有可用的摄像头"));
        }
        if user_id.is_empty() || pass_token.is_empty() {
            return Err(anyhow!("缺少小米账号 token，请重新登录"));
        }
        app_log::info(
            "Camera",
            format!(
                "准备本地取流：{} 路；{}",
                cameras.len(),
                cameras
                    .iter()
                    .map(|camera| format!(
                        "{} did={} model={} channel={}",
                        camera.name,
                        app_log::mask_id(&camera.did),
                        camera.model,
                        camera.channel
                    ))
                    .collect::<Vec<_>>()
                    .join("；")
            ),
        );
        let yaml = cameras_yaml(cameras, user_id, pass_token)?;
        Self::start_with_yaml(binary, "cameras", &yaml)
    }

    /// 用于本地 HLS 验收。source 是 go2rtc 的源表达式，例如 exec:ffmpeg ...。
    pub fn start_with_source(binary: &Path, id: &str, source: &str) -> Result<Self> {
        let yaml = format!("streams:\n  {}: {}\n", yaml_string(id), yaml_string(source));
        Self::start_with_yaml(binary, id, &yaml)
    }

    /// Starts an empty stream that will be published through go2rtc's RTSP server.
    pub fn start_for_ingest(binary: &Path, id: &str) -> Result<Self> {
        let yaml = format!("streams:\n  {}: null\n", yaml_string(id));
        Self::start_with_yaml(binary, id, &yaml)
    }

    fn start_with_yaml(binary: &Path, id: &str, streams_yaml: &str) -> Result<Self> {
        if !binary.exists() {
            return Err(anyhow!("找不到 go2rtc：{}", binary.display()));
        }
        let ports = free_ports(3)?;
        let port = ports[0];
        let rtsp_port = ports[1];
        let webrtc_port = ports[2];
        let username = format!("mihome-{}", random_secret(8));
        let password = random_secret(32);
        let api_authorization = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
        );
        cleanup_stale_configs();
        let config_path = std::env::temp_dir().join(format!(
            "mihome-go2rtc-{}-{}.yaml",
            std::process::id(),
            port
        ));
        let api_yaml = go2rtc_config(
            port,
            rtsp_port,
            webrtc_port,
            streams_yaml,
            go2rtc_log_level(),
            &username,
            &password,
        );
        write_private(&config_path, &api_yaml)?;

        let started = Instant::now();
        let mut child = spawn_supervised(binary, &config_path)
            .with_context(|| format!("启动 go2rtc 失败：{}", binary.display()))?;
        app_log::info(
            "go2rtc",
            format!(
                "进程已启动：{} pid={} api=127.0.0.1:{} rtsp=127.0.0.1:{} webrtc=127.0.0.1:{}",
                binary.display(),
                child.id(),
                port,
                rtsp_port,
                webrtc_port
            ),
        );
        let diagnostics = Arc::new(Mutex::new(VecDeque::with_capacity(DIAGNOSTIC_LINES)));
        if let Some(stderr) = child.stderr.take() {
            spawn_diagnostic_reader(stderr, Arc::clone(&diagnostics), id.to_string());
        }
        if !wait_port(port, Duration::from_secs(5))
            || !wait_port(rtsp_port, Duration::from_millis(1500))
            || !wait_port(webrtc_port, Duration::from_millis(1500))
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&config_path);
            app_log::error(
                "go2rtc",
                format!("内置取流服务端口未就绪：api={port} rtsp={rtsp_port} webrtc={webrtc_port}"),
            );
            return Err(anyhow!(
                "go2rtc 的 API、RTSP 或 WebRTC 端口没有在 5 秒内就绪"
            ));
        }
        let proxy = LoopbackProxy::start(port, &username, &password).inspect_err(|_| {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&config_path);
        })?;
        let runtime = Self {
            child,
            config_path: config_path.clone(),
            diagnostics,
            proxy,
            api_authorization,
            port,
            rtsp_port,
        };
        app_log::info(
            "go2rtc",
            format!(
                "API 已就绪：port={port} elapsed={}ms",
                started.elapsed().as_millis()
            ),
        );
        // go2rtc reads the YAML once during startup. Keeping the file around
        // would leave the Xiaomi passToken on disk after a crash.
        if let Err(error) = fs::remove_file(&config_path) {
            app_log::warn(
                "go2rtc",
                format!("删除临时配置失败：{}：{error}", config_path.display()),
            );
        }
        Ok(runtime)
    }

    pub fn stream_url_for_did(&self, did: &str) -> String {
        self.stream_url(&safe_id(did))
    }

    pub fn webrtc_url_for_did(&self, did: &str) -> String {
        self.webrtc_url(&safe_id(did))
    }

    pub fn webrtc_url(&self, id: &str) -> String {
        self.proxy
            .websocket_url(&format!("api/ws?src={}", url_component(id)))
    }

    pub fn rtsp_url(&self, id: &str) -> String {
        format!("rtsp://127.0.0.1:{}/{}", self.rtsp_port, url_component(id))
    }

    pub fn wait_for_producer(&self, id: &str, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.producer_ready(id) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(anyhow!("go2rtc 没有在 {timeout:?} 内收到 RTSP 推流"))
    }

    pub fn producer_ready(&self, id: &str) -> bool {
        self.has_producer(id).unwrap_or(false)
    }

    fn has_producer(&self, id: &str) -> Result<bool> {
        let address = format!("127.0.0.1:{}", self.port);
        let mut stream = TcpStream::connect_timeout(
            &address
                .parse()
                .map_err(|_| anyhow!("无效地址：{address}"))?,
            Duration::from_millis(500),
        )?;
        stream.set_read_timeout(Some(Duration::from_millis(800)))?;
        stream.set_write_timeout(Some(Duration::from_millis(500)))?;
        write!(
            stream,
            "GET /api/streams HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: {}\r\nConnection: close\r\n\r\n",
            self.api_authorization
        )?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response)?;
        let response = String::from_utf8_lossy(&response);
        let body = response
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or_default();
        let streams: serde_json::Value = serde_json::from_str(body)?;
        Ok(streams
            .get(id)
            .and_then(|stream| stream.get("producers"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|producers| !producers.is_empty()))
    }

    pub fn stream_url(&self, id: &str) -> String {
        self.proxy
            .http_url(&format!("api/stream.m3u8?src={}&mp4", url_component(id)))
    }

    pub fn is_alive(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }

    pub fn diagnostics(&mut self) -> CameraDiagnostics {
        let alive = self.is_alive();
        let api_ready = alive
            && TcpStream::connect_timeout(
                &format!("127.0.0.1:{}", self.proxy.port())
                    .parse()
                    .expect("loopback"),
                Duration::from_millis(300),
            )
            .is_ok();
        let recent = self
            .diagnostics
            .lock()
            .map(|lines| {
                lines
                    .iter()
                    .rev()
                    .find(|line| diagnostic_is_relevant(line))
                    .cloned()
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        let diagnostics = CameraDiagnostics {
            alive,
            api_ready,
            detail: explain_go2rtc_error(&recent),
        };
        app_log::warn(
            "Camera",
            format!(
                "本地取流诊断：alive={} api_ready={} detail={}",
                diagnostics.alive, diagnostics.api_ready, diagnostics.detail
            ),
        );
        diagnostics
    }
}

fn go2rtc_config(
    api_port: u16,
    rtsp_port: u16,
    webrtc_port: u16,
    streams_yaml: &str,
    log_level: &str,
    username: &str,
    password: &str,
) -> String {
    let username = yaml_string(username);
    let password = yaml_string(password);
    // The Tauri page has a different origin from the loopback API. go2rtc only
    // disables its same-origin WebSocket check when this value is "*".
    format!(
        "api:\n  listen: \"127.0.0.1:{api_port}\"\n  username: {username}\n  password: {password}\n  local_auth: true\n  origin: \"*\"\n  allow_paths: [\"/api/streams\", \"/api/ws\", \"/api/stream.m3u8\", \"/api/hls/playlist.m3u8\", \"/api/hls/segment.ts\", \"/api/hls/init.mp4\", \"/api/hls/segment.m4s\"]\nrtsp:\n  listen: \"127.0.0.1:{rtsp_port}\"\nwebrtc:\n  listen: \"127.0.0.1:{webrtc_port}\"\nlog:\n  level: {log_level}\n{streams_yaml}"
    )
}

fn random_secret(length: usize) -> String {
    let mut bytes = vec![0u8; length.div_ceil(2)];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let mut value = hex::encode(bytes);
    value.truncate(length);
    value
}

fn go2rtc_log_level() -> &'static str {
    match std::env::var("MIHOME_LOG_LEVEL")
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "trace" => "trace",
        "debug" => "debug",
        "warn" | "warning" => "warning",
        "error" => "error",
        _ => "info",
    }
}

/// Keeps go2rtc tied to the desktop process. The watcher reads our stdin pipe;
/// when the pipe closes because MiHome exits or crashes, it terminates go2rtc.
fn spawn_supervised(binary: &Path, config_path: &Path) -> std::io::Result<Child> {
    #[cfg(unix)]
    {
        const SUPERVISOR: &str = r#"
child=
cleanup() {
  [ -n "$child" ] && kill "$child" 2>/dev/null || true
  [ -n "$child" ] && wait "$child" 2>/dev/null || true
}
trap cleanup TERM INT HUP
"$1" -c "$2" </dev/null &
child=$!
while IFS= read -r _; do :; done
cleanup
exit 0
"#;
        Command::new("/bin/sh")
            .arg("-c")
            .arg(SUPERVISOR)
            .arg("mihome-go2rtc-supervisor")
            .arg(binary)
            .arg(config_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
    }
    #[cfg(not(unix))]
    {
        Command::new(binary)
            .arg("-c")
            .arg(config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
    }
}

fn cameras_yaml(cameras: &[CameraDevice], user_id: &str, pass_token: &str) -> Result<String> {
    let mut streams = String::new();
    for camera in cameras {
        let ip = camera
            .ip
            .as_deref()
            .filter(|ip| !ip.is_empty())
            .ok_or_else(|| anyhow!("{} 没有 localip，无法局域网取流", camera.name))?;
        let source = format!(
            "xiaomi://{}:cn@{}?did={}&model={}&subtype={}&channel={}",
            user_id, ip, camera.did, camera.model, camera.subtype, camera.channel
        );
        streams.push_str(&format!(
            "  {}: {}\n",
            yaml_string(&safe_id(&camera.did)),
            yaml_string(&source)
        ));
    }
    let yaml = format!(
        "xiaomi:\n  {}: {}\nstreams:\n{}",
        yaml_string(user_id),
        yaml_string(pass_token),
        streams
    );
    Ok(yaml)
}

fn spawn_diagnostic_reader(
    stderr: impl Read + Send + 'static,
    diagnostics: Arc<Mutex<VecDeque<String>>>,
    id: String,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let line = sanitize_diagnostic_line(&line);
            if line.is_empty() {
                continue;
            }
            if diagnostic_is_relevant(&line) {
                app_log::info("go2rtc", format!("{id}: {line}"));
            } else {
                app_log::debug("go2rtc", format!("{id}: {line}"));
            }
            if let Ok(mut lines) = diagnostics.lock() {
                if lines.len() == DIAGNOSTIC_LINES {
                    lines.pop_front();
                }
                lines.push_back(line);
            }
        }
    });
}

fn sanitize_diagnostic_line(line: &str) -> String {
    line.split_whitespace()
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            if lower.contains("xiaomi://")
                || lower.contains("client_private=")
                || lower.contains("client_public=")
                || lower.contains("device_public=")
                || lower.contains("sign=")
                || lower.contains("\"sign\"")
                || lower.contains("\"public_key\"")
                || lower.contains("\"app_pubkey\"")
                || part.starts_with("V1:")
            {
                "<已隐藏>"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(600)
        .collect()
}

fn diagnostic_is_relevant(line: &str) -> bool {
    line.contains("error=")
        || line.contains("xiaomi:")
        || line.contains("miss:")
        || line.contains("cs2:")
}

fn explain_go2rtc_error(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if lower.contains("i/o timeout") || lower.contains("timed out") {
        if lower.contains("read media") {
            "本地通道握手成功，但摄像头未返回媒体数据。请退出米家 App 中该摄像头的直播后重试；若仍失败，可切换远程通道。".to_string()
        } else if lower.contains("read command") || lower.contains("auth") {
            "摄像头没有响应认证请求。请退出米家 App 中该摄像头的直播后重试。".to_string()
        } else {
            "连接摄像头本地通道超时。请确认 Mac 与摄像头处于同一局域网后重试。".to_string()
        }
    } else if lower.contains("no video") || lower.contains("no media") {
        "摄像头已连接，但当前没有可用的视频流。请确认摄像头未被其他设备占用后重试。".to_string()
    } else if lower.contains("auth") || lower.contains("unauthorized") || lower.contains("sign") {
        "本地取流认证失败。请退出应用后重新扫码登录，再重试。".to_string()
    } else if lower.contains("unsupported") {
        "当前摄像头型号或传输方式不受内置取流服务支持，请切换到远程通道。".to_string()
    } else if lower.contains("connection refused")
        || lower.contains("no route")
        || lower.contains("network is down")
    {
        "无法连接摄像头本地端口。请检查 Mac 与摄像头是否在同一局域网。".to_string()
    } else {
        "本地取流服务仍在等待摄像头响应，暂未收到视频数据。请确认摄像头未被其他设备占用，或切换到远程画面。".to_string()
    }
}

fn cleanup_stale_configs() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(60))
        .unwrap_or(std::time::UNIX_EPOCH);
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("mihome-go2rtc-") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .map(|modified| modified < cutoff)
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

impl Drop for Go2Rtc {
    fn drop(&mut self) {
        app_log::info("go2rtc", "正在停止内置取流服务");
        // Closing the supervisor's stdin asks it to terminate go2rtc and wait
        // for the child. Fall back to a hard kill if cleanup does not finish.
        drop(self.child.stdin.take());
        #[cfg(not(unix))]
        let _ = self.child.kill();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let status = self.child.wait();
        app_log::info("go2rtc", format!("内置取流服务已停止：{status:?}"));
        let _ = fs::remove_file(&self.config_path);
    }
}

pub fn find_binary() -> Result<PathBuf> {
    let allow_unverified = std::env::var_os("MIHOME_ALLOW_UNVERIFIED_GO2RTC").is_some();
    if let Ok(path) = std::env::var("MIHOME_GO2RTC") {
        let path = PathBuf::from(path);
        if path.exists() {
            if !allow_unverified {
                verify_go2rtc(&path)?;
            }
            return Ok(path);
        }
    }
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Library/Application Support/MiHome/go2rtc"));
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..6 {
            let Some(current) = dir else { break };
            roots.push(current.join("helpers/go2rtc/go2rtc"));
            roots.push(current.join("helpers/go2rtc"));
            roots.push(current.join("go2rtc"));
            roots.push(current.join("Resources/go2rtc"));
            roots.push(current.join("Resources/helpers/go2rtc/go2rtc"));
            dir = current.parent().map(Path::to_path_buf);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("helpers/go2rtc/go2rtc"));
        roots.push(cwd.join("helpers/go2rtc"));
    }
    if let Ok(paths) = std::env::var("PATH") {
        for dir in paths.split(':') {
            roots.push(PathBuf::from(dir).join("go2rtc"));
        }
    }
    let mut verification_error = None;
    for path in roots.into_iter().filter(|path| path.is_file()) {
        if allow_unverified {
            app_log::warn(
                "go2rtc",
                format!("使用未校验的内置程序：{}", path.display()),
            );
            return Ok(path);
        }
        match verify_go2rtc(&path) {
            Ok(()) => {
                app_log::info("go2rtc", format!("完整性校验通过：{}", path.display()));
                return Ok(path);
            }
            Err(error) => verification_error = Some(error),
        }
    }
    if let Some(error) = verification_error {
        return Err(error.context(
            "没有找到通过完整性校验的 go2rtc 1.9.15；可用 helpers/go2rtc/fetch.sh 重新准备，\
             或显式设置 MIHOME_ALLOW_UNVERIFIED_GO2RTC=1 使用自定义版本",
        ));
    }
    Err(anyhow!(
        "找不到 go2rtc。运行 helpers/go2rtc/fetch.sh 或设置 MIHOME_GO2RTC"
    ))
}

pub fn verify_go2rtc(path: &Path) -> Result<()> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("读取 go2rtc 文件信息失败：{}", path.display()))?;
    let fingerprint = binary_fingerprint(path, &metadata);
    let verified = VERIFIED_BINARIES.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    if verified
        .lock()
        .map(|cache| cache.contains(&fingerprint))
        .unwrap_or(false)
    {
        return Ok(());
    }

    let actual = sha256_file(path)?;
    let expected = expected_go2rtc_hashes();
    if !expected.contains(&actual.as_str()) {
        if signed_app_bundle_contains(path) {
            app_log::warn(
                "go2rtc",
                format!(
                    "go2rtc 已由签名应用包封装，跳过上游 SHA256 固定值校验：{}",
                    path.display()
                ),
            );
            if let Ok(mut cache) = verified.lock() {
                cache.insert(fingerprint);
            }
            return Ok(());
        }
        return Err(anyhow!(
            "go2rtc SHA256 不匹配：期望固定版本 1.9.15，实际 {actual}（{}）",
            path.display()
        ));
    }
    if let Ok(mut cache) = verified.lock() {
        cache.insert(fingerprint);
    }
    Ok(())
}

fn signed_app_bundle_contains(path: &Path) -> bool {
    let Some(bundle) = app_bundle_for_path(path) else {
        return false;
    };
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bundle;
        false
    }
}

fn app_bundle_for_path(path: &Path) -> Option<&Path> {
    path.ancestors().find(|candidate| {
        candidate
            .extension()
            .is_some_and(|extension| extension == "app")
    })
}

fn binary_fingerprint(path: &Path, metadata: &fs::Metadata) -> VerifiedBinary {
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        VerifiedBinary {
            path: path.to_path_buf(),
            len: metadata.len(),
            modified_ns,
            changed_ns: i128::from(metadata.ctime()) * 1_000_000_000
                + i128::from(metadata.ctime_nsec()),
            inode: metadata.ino(),
            device: metadata.dev(),
        }
    }
    #[cfg(not(unix))]
    {
        VerifiedBinary {
            path: path.to_path_buf(),
            len: metadata.len(),
            modified_ns,
            changed_ns: 0,
            inode: 0,
            device: 0,
        }
    }
}

fn expected_go2rtc_hashes() -> &'static [&'static str] {
    #[cfg(target_arch = "x86_64")]
    {
        return &[GO2RTC_AMD64_SHA256, GO2RTC_UNIVERSAL_SHA256];
    }
    #[cfg(target_arch = "aarch64")]
    {
        return &[GO2RTC_ARM64_SHA256, GO2RTC_UNIVERSAL_SHA256];
    }
    #[allow(unreachable_code)]
    &[]
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        fs::File::open(path).with_context(|| format!("打开 go2rtc 失败：{}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn camera_from_raw(
    did: String,
    name: String,
    model: String,
    online: bool,
    raw: &serde_json::Value,
) -> Option<CameraDevice> {
    if !looks_like_camera(&model) {
        return None;
    }
    let ip = raw
        .get("localip")
        .or_else(|| raw.get("local_ip"))
        .or_else(|| raw.get("ip"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let subtype = raw
        .get("camera_subtype")
        .or_else(|| raw.get("subtype"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("hd")
        .to_string();
    let channel = raw
        .get("channel")
        .and_then(serde_json::Value::as_u64)
        .map(go2rtc_channel)
        .unwrap_or(0);
    let spec_type = raw
        .get("spec_type")
        .or_else(|| raw.get("specType"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(CameraDevice {
        did,
        name,
        model,
        ip,
        online,
        subtype,
        channel,
        spec_type,
    })
}

fn go2rtc_channel(raw_channel: u64) -> u32 {
    // Xiaomi device lists use channel 1 for the primary lens. go2rtc uses
    // channel 0 for the primary stream and channel 2 for a second lens.
    if raw_channel <= 1 {
        0
    } else {
        raw_channel.min(u32::MAX as u64) as u32
    }
}

fn looks_like_camera(model: &str) -> bool {
    model.starts_with("chuangmi.camera.")
        || model.starts_with("isa.camera.")
        || model.contains(".camera.")
        || model.contains("ipc")
}

fn safe_id(value: &str) -> String {
    let id: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if id.is_empty() {
        "camera".to_string()
    } else {
        id
    }
}

fn url_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn yaml_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                escaped.push_str(&format!("\\u{:04X}", character as u32));
            }
            character => escaped.push(character),
        }
    }
    escaped.push('"');
    escaped
}

fn write_private(path: &Path, content: &str) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("写入配置失败：{}", path.display()))?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

fn free_ports(count: usize) -> Result<Vec<u16>> {
    let mut listeners = Vec::with_capacity(count);
    for _ in 0..count {
        listeners.push(TcpListener::bind("127.0.0.1:0").context("申请本地端口失败")?);
    }
    let ports = listeners
        .iter()
        .map(|listener| listener.local_addr().map(|addr| addr.port()))
        .collect::<std::io::Result<Vec<_>>>()?;
    drop(listeners);
    Ok(ports)
}

fn wait_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().expect("loopback"),
            Duration::from_millis(200),
        )
        .is_ok()
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaml_escapes_tokens() {
        assert_eq!(yaml_string("a:b\"c"), "\"a:b\\\"c\"");
        assert_eq!(yaml_string("a\r\t\u{7f}"), "\"a\\r\\t\\u007F\"");
    }

    #[cfg(unix)]
    #[test]
    fn supervised_child_is_tied_to_the_parent_pipe() {
        let mut child =
            spawn_supervised(Path::new("/bin/sh"), Path::new("sleep 30")).expect("supervisor");
        std::thread::sleep(Duration::from_millis(100));
        assert!(child.try_wait().expect("poll supervisor").is_none());

        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if child.try_wait().expect("poll supervisor").is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        panic!("supervisor did not stop after stdin closed");
    }

    #[test]
    fn stream_id_is_safe() {
        assert_eq!(safe_id("12/34"), "1234");
        assert_eq!(url_component("a b"), "a%20b");
    }

    #[test]
    fn non_camera_is_filtered() {
        assert!(camera_from_raw(
            "1".into(),
            "灯".into(),
            "yeelink.light.lamp4".into(),
            true,
            &serde_json::json!({})
        )
        .is_none());
        assert!(camera_from_raw(
            "2".into(),
            "摄像头".into(),
            "chuangmi.camera.046c04".into(),
            true,
            &serde_json::json!({"localip": "192.168.1.8"})
        )
        .is_some());
    }

    #[test]
    fn maps_xiaomi_primary_channel_to_go2rtc_channel_zero() {
        let camera = camera_from_raw(
            "2".into(),
            "摄像头".into(),
            "chuangmi.camera.069a01".into(),
            true,
            &serde_json::json!({"localip": "192.168.31.150"}),
        )
        .unwrap();
        assert_eq!(camera.channel, 0);

        let camera = camera_from_raw(
            "2".into(),
            "摄像头".into(),
            "chuangmi.camera.069a01".into(),
            true,
            &serde_json::json!({"localip": "192.168.31.150", "channel": 1}),
        )
        .unwrap();
        assert_eq!(camera.channel, 0);
        assert_eq!(go2rtc_channel(2), 2);
    }

    #[test]
    fn camera_config_uses_primary_channel() {
        let camera = CameraDevice {
            did: "1178828157".into(),
            name: "摄像头".into(),
            model: "chuangmi.camera.069a01".into(),
            ip: Some("192.168.31.150".into()),
            online: true,
            subtype: "hd".into(),
            channel: 0,
            spec_type: None,
        };
        let yaml = cameras_yaml(&[camera], "20373857", "secret").unwrap();
        assert!(yaml.contains("channel=0"));
        assert!(!yaml.contains("channel=1"));
    }

    #[test]
    fn go2rtc_uses_distinct_api_rtsp_and_webrtc_ports() {
        let config = go2rtc_config(
            41001,
            41002,
            41003,
            "streams:\n  camera: null\n",
            "debug",
            "mihome-test",
            "secret",
        );
        assert!(config.contains("listen: \"127.0.0.1:41001\""));
        assert!(config.contains("rtsp:\n  listen: \"127.0.0.1:41002\""));
        assert!(config.contains("webrtc:\n  listen: \"127.0.0.1:41003\""));
        assert!(config.contains("username: \"mihome-test\""));
        assert!(config.contains("password: \"secret\""));
        assert!(config.contains("local_auth: true"));
        assert!(config.contains("origin: \"*\""));
        assert!(config.contains("allow_paths:"));
        assert!(config.contains("\"/api/ws\""));
        assert!(config.contains("\"/api/stream.m3u8\""));
        assert!(!config.contains("\"/api/config\""));
        assert!(config.contains("log:\n  level: debug"));
        assert!(config.contains("camera: null"));
    }

    #[test]
    fn rtsp_url_uses_the_rtsp_listener_port() {
        let child = Command::new("/bin/sleep").arg("1").spawn().unwrap();
        let proxy = LoopbackProxy::start(41001, "user", "password").unwrap();
        let expected_webrtc = proxy.websocket_url("api/ws?src=remote");
        let expected_stream = proxy.http_url("api/stream.m3u8?src=remote&mp4");
        let runtime = Go2Rtc {
            child,
            config_path: std::env::temp_dir().join("mihome-go2rtc-test.yaml"),
            diagnostics: Arc::new(Mutex::new(VecDeque::new())),
            proxy,
            api_authorization: "Basic dXNlcjpwYXNzd29yZA==".to_string(),
            port: 41001,
            rtsp_port: 41002,
        };
        assert_eq!(runtime.rtsp_url("remote"), "rtsp://127.0.0.1:41002/remote");
        assert_eq!(runtime.webrtc_url("remote"), expected_webrtc);
        assert_eq!(runtime.stream_url("remote"), expected_stream);
    }

    #[test]
    fn camera_stream_exposes_the_webrtc_endpoint_to_the_ui() {
        let stream = CameraStream {
            id: "camera-1".to_string(),
            url: "http://127.0.0.1:41001/api/stream.m3u8?src=camera-1&mp4".to_string(),
            webrtc_url: Some("ws://127.0.0.1:41001/api/ws?src=camera-1".to_string()),
            host: "192.168.1.8".to_string(),
            prefer_mse: true,
        };
        let value = serde_json::to_value(stream).unwrap();
        assert_eq!(
            value.get("webrtc_url").and_then(serde_json::Value::as_str),
            Some("ws://127.0.0.1:41001/api/ws?src=camera-1")
        );
        assert_eq!(
            value.get("prefer_mse").and_then(serde_json::Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn diagnostics_hide_credentials_and_explain_media_timeout() {
        let line = sanitize_diagnostic_line(
            "xiaomi://user:cn@192.168.31.150?client_private=secret error=cs2: read media: i/o timeout",
        );
        assert!(!line.contains("client_private=secret"));
        assert!(!line.contains("xiaomi://user"));
        assert!(explain_go2rtc_error(&line).contains("未返回媒体数据"));
        assert!(explain_go2rtc_error("miss: auth: invalid token").contains("认证失败"));
        assert!(explain_go2rtc_error("xiaomi: unsupported model").contains("不受内置取流服务支持"));
        let unknown = explain_go2rtc_error("unexpected internal packet state");
        assert!(unknown.contains("等待摄像头响应"));
        assert!(!unknown.contains("unexpected"));
    }

    #[test]
    fn hashes_files_and_rejects_unknown_go2rtc() {
        let path = std::env::temp_dir().join(format!(
            "mihome-go2rtc-hash-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(verify_go2rtc(&path).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn finds_the_signed_app_bundle_that_contains_go2rtc() {
        let path = Path::new("/Applications/MiHome Mac.app/Contents/MacOS/go2rtc");
        assert_eq!(
            app_bundle_for_path(path),
            Some(Path::new("/Applications/MiHome Mac.app"))
        );
        assert_eq!(app_bundle_for_path(Path::new("/tmp/mihome/go2rtc")), None);
    }

    #[test]
    fn binary_fingerprint_changes_when_file_is_replaced() {
        let path = std::env::temp_dir().join(format!(
            "mihome-go2rtc-fingerprint-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::write(&path, b"abc").unwrap();
        let first = binary_fingerprint(&path, &fs::metadata(&path).unwrap());
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&path, b"abd").unwrap();
        let second = binary_fingerprint(&path, &fs::metadata(&path).unwrap());
        assert_ne!(first, second);
        let _ = fs::remove_file(path);
    }
}
