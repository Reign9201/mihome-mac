//! Rust remote-camera stream: MISS media -> ffmpeg (Annex-B -> RTSP) -> go2rtc.
//!
//! This replaces the Java `micam` experiment for the product path. ffmpeg remains only as the
//! remuxer; the Xiaomi cloud, CS2 relay, MISS authentication and media decryption are all
//! implemented in this crate.

use anyhow::{anyhow, Context, Result};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::UdpSocket;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::auth::Session;
use crate::camera::Go2Rtc;
use crate::logging as app_log;
use crate::media::{find_ffmpeg, free_port, tail};
use crate::miss::{MediaPacket, CODEC_H264, CODEC_H265, CODEC_OPUS};
use crate::remote::RemoteCamera;

static REMOTE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const MEDIA_POLL_TIMEOUT: Duration = Duration::from_millis(250);
const OPUS_PAYLOAD_TYPE: u8 = 96;
const OPUS_TIMESTAMP_STEP: u32 = 48_000 * 40 / 1000;

pub struct RemoteStream {
    camera: Arc<RemoteCamera>,
    ffmpeg: Child,
    relay: Go2Rtc,
    temp_dir: PathBuf,
    reader: Option<JoinHandle<()>>,
    running: Arc<AtomicBool>,
    frames: Arc<std::sync::atomic::AtomicUsize>,
}

struct StartupResources {
    temp_dir: PathBuf,
    child: Option<Child>,
    reader: Option<JoinHandle<()>>,
    running: Arc<AtomicBool>,
    relay: Option<Go2Rtc>,
    active: bool,
}

impl StartupResources {
    fn new(temp_dir: PathBuf, running: Arc<AtomicBool>) -> Self {
        Self {
            temp_dir,
            child: None,
            reader: None,
            running,
            relay: None,
            active: true,
        }
    }
}

impl Drop for StartupResources {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        self.running.store(false, Ordering::Relaxed);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        self.relay.take();
        let _ = fs::remove_dir_all(&self.temp_dir);
    }
}

impl RemoteStream {
    /// Blocking entry point. Call it from a worker thread, not the UI thread.
    pub fn start(session: Session, did: &str, quality: u8, audio: bool) -> Result<Self> {
        cleanup_stale_remote_dirs();
        let started = Instant::now();
        app_log::info(
            "Remote",
            format!(
                "开始建立远程画面：did={} quality={quality} audio={audio}",
                app_log::mask_id(did)
            ),
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("创建摄像头运行时失败")?;
        let camera = runtime
            .block_on(RemoteCamera::open(
                &session,
                did,
                quality,
                audio,
                Duration::from_secs(90),
            ))
            .map_err(|error| {
                app_log::error(
                    "Remote",
                    format!(
                        "MISS 通道建立失败：did={} error={error:#}",
                        app_log::mask_id(did)
                    ),
                );
                error
            })?;
        let stream = Self::from_camera(camera, audio).map_err(|error| {
            app_log::error(
                "Remote",
                format!(
                    "远程画面启动失败：did={} error={error:#}",
                    app_log::mask_id(did)
                ),
            );
            error
        })?;
        app_log::info(
            "Remote",
            format!(
                "远程画面已就绪：did={} elapsed={}ms",
                app_log::mask_id(did),
                started.elapsed().as_millis()
            ),
        );
        Ok(stream)
    }

    fn from_camera(camera: RemoteCamera, audio: bool) -> Result<Self> {
        let started = Instant::now();
        let camera = Arc::new(camera);
        let first = first_video_packet(&camera, Duration::from_secs(20))?;
        let (input_format, tag) = match first.codec_id {
            CODEC_H264 => ("h264", "avc1"),
            CODEC_H265 => ("hevc", "hvc1"),
            other => return Err(anyhow!("不支持的视频编码 id={other}")),
        };
        app_log::info(
            "Remote",
            format!(
                "收到首帧：codec={input_format} bytes={} elapsed={}ms",
                first.payload.len(),
                started.elapsed().as_millis()
            ),
        );

        let ffmpeg = find_ffmpeg()?;
        app_log::info("ffmpeg", format!("使用编码封装器：{}", ffmpeg.display()));
        let sequence = REMOTE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!(
            "mihome-remote-{}-{sequence}-{timestamp}",
            std::process::id()
        ));
        create_private_dir(&temp_dir)?;
        let running = Arc::new(AtomicBool::new(true));
        let mut resources = StartupResources::new(temp_dir.clone(), Arc::clone(&running));
        let go2rtc = crate::camera::find_binary()?;
        let relay = Go2Rtc::start_for_ingest(&go2rtc, "remote")?;
        let rtsp_target = relay.rtsp_url("remote");
        resources.relay = Some(relay);
        let ffmpeg_log = temp_dir.join("ffmpeg.log");
        let ffmpeg_log_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&ffmpeg_log)?;
        let ffmpeg_err = ffmpeg_log_file.try_clone()?;

        // 摄像头送来的是裸 Opus 包。给 ffmpeg 一份 SDP，用本地 UDP/RTP 喂给它。
        // WebRTC 原生支持 Opus；音频和视频都只做封装，避免转码延迟与兼容问题。
        let audio_target = if audio {
            // ffmpeg 的 SDP 输入要自己 bind 这个端口；这里只保留一个发送 socket，
            // 端口号用空闲探测提前选出来。
            let port = free_port()?;
            let socket = UdpSocket::bind("127.0.0.1:0").context("创建音频发送端口失败")?;
            let sdp = format!(
                "v=0\no=- 0 0 IN IP4 127.0.0.1\ns=MiHome Camera\nc=IN IP4 127.0.0.1\nt=0 0\nm=audio {port} RTP/AVP 96\na=rtpmap:96 opus/48000/2\na=fmtp:96 stereo=0;sprop-stereo=0\n"
            );
            let sdp_path = temp_dir.join("audio.sdp");
            fs::write(&sdp_path, sdp).context("写入 audio.sdp 失败")?;
            Some((socket, port))
        } else {
            None
        };

        let audio_sdp = audio_target.as_ref().map(|_| temp_dir.join("audio.sdp"));
        let args = ffmpeg_args(
            input_format,
            tag,
            audio_sdp.as_deref(),
            rtsp_target.as_str(),
        );
        let mut child = Command::new(&ffmpeg)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::from(ffmpeg_log_file))
            .stderr(Stdio::from(ffmpeg_err))
            .spawn()
            .with_context(|| format!("启动 ffmpeg 失败：{}", ffmpeg.display()))?;
        app_log::info(
            "ffmpeg",
            format!(
                "进程已启动：pid={} audio={} temp={}",
                child.id(),
                audio,
                temp_dir.display()
            ),
        );
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("ffmpeg stdin 不可用"))?;
        stdin.write_all(&first.payload).context("写入首帧失败")?;
        resources.child = Some(child);

        let frames = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let thread_frames = Arc::clone(&frames);
        let thread_camera = Arc::clone(&camera);
        let thread_running = Arc::clone(&running);
        let reader = thread::Builder::new()
            .name("miss-media".to_string())
            .spawn(move || {
                let mut last_video_seq: Option<u32> = None;
                let mut last_audio_seq: Option<u32> = None;
                let mut rtp_seq: u16 = 0;
                let mut audio_rtp_ts: u32 = 0;
                while thread_running.load(Ordering::Relaxed) {
                    // Keep the blocking read short so dropping a stream does not
                    // freeze camera switching for several seconds.
                    match thread_camera.next_media(MEDIA_POLL_TIMEOUT) {
                        Ok(Some(packet)) if packet.is_video() => {
                            if last_video_seq.is_some_and(|last| {
                                let diff = packet.sequence.wrapping_sub(last);
                                diff == 0 || diff > 0x7fff_ffff
                            }) {
                                continue;
                            }
                            last_video_seq = Some(packet.sequence);
                            if let Err(error) = stdin.write_all(&packet.payload) {
                                if thread_running.load(Ordering::Relaxed) {
                                    app_log::warn(
                                        "Remote",
                                        format!("写入视频帧失败，媒体线程退出：{error}"),
                                    );
                                }
                                break;
                            }
                            thread_frames.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(Some(packet)) if packet.codec_id == CODEC_OPUS => {
                            let Some((socket, audio_port)) = audio_target.as_ref() else {
                                continue;
                            };
                            if last_audio_seq.is_some_and(|last| {
                                let diff = packet.sequence.wrapping_sub(last);
                                diff == 0 || diff > 0x7fff_ffff
                            }) {
                                continue;
                            }
                            last_audio_seq = Some(packet.sequence);
                            let mut rtp = Vec::with_capacity(12 + packet.payload.len());
                            rtp.push(0x80);
                            rtp.push(OPUS_PAYLOAD_TYPE);
                            rtp.extend_from_slice(&rtp_seq.to_be_bytes());
                            rtp.extend_from_slice(&audio_rtp_ts.to_be_bytes());
                            rtp.extend_from_slice(&0x1234_5678u32.to_be_bytes());
                            rtp.extend_from_slice(&packet.payload);
                            audio_rtp_ts = audio_rtp_ts.wrapping_add(OPUS_TIMESTAMP_STEP);
                            rtp_seq = rtp_seq.wrapping_add(1);
                            if let Err(error) =
                                socket.send_to(&rtp, format!("127.0.0.1:{audio_port}"))
                            {
                                if thread_running.load(Ordering::Relaxed) {
                                    app_log::warn(
                                        "Remote",
                                        format!("发送音频包失败，媒体线程退出：{error}"),
                                    );
                                }
                                break;
                            }
                        }
                        Ok(_) => {}
                        Err(error) => {
                            app_log::error("Remote", format!("读取媒体包失败：{error:#}"));
                            break;
                        }
                    }
                }
            })
            .context("启动媒体写入线程失败")?;
        resources.reader = Some(reader);

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut ready = false;
        while Instant::now() < deadline {
            if resources
                .relay
                .as_ref()
                .is_some_and(|relay| relay.producer_ready("remote"))
            {
                ready = true;
                break;
            }
            if let Some(status) = resources
                .child
                .as_mut()
                .ok_or_else(|| anyhow!("ffmpeg 子进程丢失"))?
                .try_wait()?
            {
                return Err(anyhow!(
                    "ffmpeg 提前退出（{status}）。\nffmpeg: {}",
                    tail(&ffmpeg_log, 6)
                ));
            }
            thread::sleep(Duration::from_millis(150));
        }
        if !ready {
            app_log::error(
                "ffmpeg",
                format!(
                    "低延迟中继等待超时：elapsed={}ms tail={}",
                    started.elapsed().as_millis(),
                    tail(&ffmpeg_log, 8)
                ),
            );
            return Err(anyhow!(
                "远程画面没有推送到低延迟中继。\nffmpeg: {}",
                tail(&ffmpeg_log, 6)
            ));
        }

        app_log::info(
            "Remote",
            format!(
                "低延迟中继已就绪：rtsp={rtsp_target} elapsed={}ms",
                started.elapsed().as_millis()
            ),
        );
        let ffmpeg = resources
            .child
            .take()
            .ok_or_else(|| anyhow!("ffmpeg 子进程丢失"))?;
        let relay = resources
            .relay
            .take()
            .ok_or_else(|| anyhow!("go2rtc 中继丢失"))?;
        let reader = resources.reader.take();
        resources.active = false;
        Ok(Self {
            camera,
            ffmpeg,
            relay,
            temp_dir: resources.temp_dir.clone(),
            reader,
            running,
            frames,
        })
    }

    pub fn url(&self) -> String {
        self.relay.stream_url("remote")
    }

    pub fn webrtc_url(&self) -> String {
        self.relay.webrtc_url("remote")
    }

    pub fn frames(&self) -> usize {
        self.frames.load(Ordering::Relaxed)
    }

    pub fn ptz(&self, direction: &str) -> Result<()> {
        let operation = match direction {
            "left" => 1,
            "right" => 2,
            "up" => 3,
            "down" => 4,
            other => return Err(anyhow!("不支持的云台方向: {other}")),
        };
        self.camera.motor(operation)
    }
}

fn ffmpeg_args(
    input_format: &str,
    tag: &str,
    audio_sdp: Option<&std::path::Path>,
    rtsp_target: &str,
) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        // Raw H.264/H.265 has no timestamps. Wall-clock timestamps track the
        // camera instead of forcing every model to ffmpeg's default 25 fps.
        "-use_wallclock_as_timestamps".to_string(),
        "1".to_string(),
        "-fflags".to_string(),
        "+genpts+nobuffer".to_string(),
        "-f".to_string(),
        input_format.to_string(),
        "-i".to_string(),
        "pipe:0".to_string(),
    ];
    if let Some(path) = audio_sdp {
        args.extend([
            "-protocol_whitelist".to_string(),
            "file,udp,rtp".to_string(),
            "-i".to_string(),
            path.to_string_lossy().to_string(),
            "-map".to_string(),
            "0:v".to_string(),
            "-map".to_string(),
            "1:a".to_string(),
            "-c:a".to_string(),
            "copy".to_string(),
        ]);
    } else {
        args.push("-an".to_string());
    }
    args.extend([
        "-c:v".to_string(),
        "copy".to_string(),
        "-tag:v".to_string(),
        tag.to_string(),
        "-vsync".to_string(),
        "0".to_string(),
        "-max_delay".to_string(),
        "0".to_string(),
        "-flush_packets".to_string(),
        "1".to_string(),
        "-muxdelay".to_string(),
        "0".to_string(),
        "-muxpreload".to_string(),
        "0".to_string(),
        "-rtsp_transport".to_string(),
        "tcp".to_string(),
        "-f".to_string(),
        "rtsp".to_string(),
        rtsp_target.to_string(),
    ]);
    args
}

fn create_private_dir(path: &std::path::Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn cleanup_stale_remote_dirs() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("mihome-remote-") {
            continue;
        }
        let pid = remote_dir_pid(&name);
        let age = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .unwrap_or_default();
        let owner_gone = pid.is_some_and(|pid| pid != std::process::id() && !process_is_alive(pid));
        if owner_gone || age > Duration::from_secs(24 * 60 * 60) {
            if let Err(error) = fs::remove_dir_all(entry.path()) {
                app_log::warn(
                    "Remote",
                    format!("清理残留临时目录失败：{}：{error}", entry.path().display()),
                );
            }
        }
    }
}

fn remote_dir_pid(name: &str) -> Option<u32> {
    name.strip_prefix("mihome-remote-")?
        .split('-')
        .next()?
        .parse()
        .ok()
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(true)
}

#[cfg(not(unix))]
fn process_is_alive(_pid: u32) -> bool {
    true
}

impl Drop for RemoteStream {
    fn drop(&mut self) {
        app_log::info(
            "Remote",
            format!(
                "停止远程画面：port={} frames={}",
                self.relay.port,
                self.frames.load(Ordering::Relaxed)
            ),
        );
        self.running.store(false, Ordering::Relaxed);
        let _ = self.ffmpeg.kill();
        let _ = self.ffmpeg.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        let _ = fs::remove_dir_all(&self.temp_dir);
    }
}

fn first_video_packet(camera: &RemoteCamera, timeout: Duration) -> Result<MediaPacket> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(packet) = camera.next_media(Duration::from_secs(2))? {
            if can_start_decoder(&packet) {
                return Ok(packet);
            }
        }
    }
    Err(anyhow!("摄像头没有在超时前返回关键帧"))
}

fn can_start_decoder(packet: &MediaPacket) -> bool {
    packet.is_video() && packet.is_keyframe()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_temp_directory_is_private() {
        let path = std::env::temp_dir().join(format!(
            "mihome-private-dir-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        create_private_dir(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let _ = fs::remove_dir_all(path);
    }

    #[test]
    fn remote_ffmpeg_publishes_low_latency_rtsp_without_hls() {
        let args = ffmpeg_args(
            "hevc",
            "hvc1",
            Some(std::path::Path::new("/tmp/audio.sdp")),
            "rtsp://127.0.0.1:41002/remote",
        );
        let joined = args.join(" ");
        assert!(joined.contains("-use_wallclock_as_timestamps 1"));
        assert!(joined.contains("-fflags +genpts+nobuffer"));
        assert!(joined.contains("-vsync 0"));
        assert!(joined.contains("-rtsp_transport tcp"));
        assert!(joined.contains("-f rtsp rtsp://127.0.0.1:41002/remote"));
        assert!(joined.contains("-c:a copy"));
        assert!(!joined.contains("-c:a aac"));
        assert!(!joined.contains("-c:a pcm_alaw"));
        assert!(!joined.contains("m3u8"));
        assert!(!joined.contains("hls"));
    }

    #[test]
    fn parses_owner_pid_from_remote_temp_directory() {
        assert_eq!(
            remote_dir_pid("mihome-remote-1234-2-1793420811427261000"),
            Some(1234)
        );
        assert_eq!(remote_dir_pid("mihome-remote-not-a-pid"), None);
        assert_eq!(remote_dir_pid("unrelated"), None);
    }

    #[test]
    fn waits_for_a_video_keyframe_before_starting_ffmpeg() {
        let packet = |codec_id, flags| MediaPacket {
            codec_id,
            sequence: 1,
            flags,
            timestamp_ms: 0,
            payload: vec![0],
        };
        assert!(!can_start_decoder(&packet(CODEC_H264, 0)));
        assert!(can_start_decoder(&packet(CODEC_H264, 1)));
        assert!(!can_start_decoder(&packet(CODEC_OPUS, 1)));
    }

    #[test]
    fn removes_remote_temp_directory_owned_by_dead_process() {
        let path = std::env::temp_dir().join(format!(
            "mihome-remote-999999-0-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        create_private_dir(&path).unwrap();
        cleanup_stale_remote_dirs();
        assert!(!path.exists());
    }
}
