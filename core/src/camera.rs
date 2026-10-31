use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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
    pub host: String,
}

pub struct Go2Rtc {
    child: Child,
    config_path: PathBuf,
    pub port: u16,
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
        Self::start_with_yaml(binary, "cameras", &yaml)
    }

    /// 用于本地 HLS 验收。source 是 go2rtc 的源表达式，例如 exec:ffmpeg ...。
    pub fn start_with_source(binary: &Path, id: &str, source: &str) -> Result<Self> {
        let yaml = format!("streams:\n  {}: {}\n", yaml_string(id), yaml_string(source));
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
        cleanup_stale_configs();
        let config_path = std::env::temp_dir().join(format!(
            "mihome-go2rtc-{}-{}.yaml",
            std::process::id(),
            port
        ));
        let api_yaml = format!(
            "api:\n  listen: \"127.0.0.1:{}\"\nrtsp:\n  listen: \"127.0.0.1:{}\"\nwebrtc:\n  listen: \"127.0.0.1:{}\"\nlog:\n  level: info\n{}",
            port, rtsp_port, webrtc_port, streams_yaml
        );
        write_private(&config_path, &api_yaml)?;

        let child = Command::new(binary)
            .arg("-c")
            .arg(&config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("启动 go2rtc 失败：{}", binary.display()))?;
        let mut runtime = Self {
            child,
            config_path,
            port,
        };
        if !wait_port(port, Duration::from_secs(5)) {
            let _ = runtime.child.kill();
            return Err(anyhow!("go2rtc 没有在 5 秒内监听 127.0.0.1:{port}"));
        }
        let _ = id;
        Ok(runtime)
    }

    pub fn stream_url_for_did(&self, did: &str) -> String {
        self.stream_url(&safe_id(did))
    }

    pub fn stream_url(&self, id: &str) -> String {
        format!(
            "http://127.0.0.1:{}/api/stream.m3u8?src={}&mp4",
            self.port,
            url_component(id)
        )
    }

    pub fn is_alive(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }
}

fn cleanup_stale_configs() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let cutoff = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(6 * 60 * 60))
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
        let _ = self.child.kill();
        let _ = self.child.wait();
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
            return Ok(path);
        }
        match verify_go2rtc(&path) {
            Ok(()) => return Ok(path),
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
        .unwrap_or(1) as u32;
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
