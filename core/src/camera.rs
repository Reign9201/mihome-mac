use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraDevice {
    pub did: String,
    pub name: String,
    pub model: String,
    pub ip: Option<String>,
    pub online: bool,
    pub subtype: String,
    pub channel: u32,
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
        Self::start_for_cameras(binary, &[camera.clone()], user_id, pass_token)
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
        let yaml = format!(
            "streams:\n  {}: {}\n",
            yaml_string(id),
            yaml_string(source)
        );
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

impl Drop for Go2Rtc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.config_path);
    }
}

pub fn find_binary() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("MIHOME_GO2RTC") {
        let path = PathBuf::from(path);
        if path.exists() {
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
    roots
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| anyhow!("找不到 go2rtc。设置 MIHOME_GO2RTC 或放到 helpers/go2rtc/go2rtc"))
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
    Some(CameraDevice {
        did,
        name,
        model,
        ip,
        online,
        subtype,
        channel,
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
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n"))
}

fn write_private(path: &Path, content: &str) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).with_context(|| format!("写入配置失败：{}", path.display()))?;
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
}
