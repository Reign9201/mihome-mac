//! Rust remote-camera stream: MISS media -> ffmpeg (Annex-B -> fMP4 HLS) -> loopback HTTP.
//!
//! This replaces the Java `micam` experiment for the product path. ffmpeg remains only as the
//! HLS packager; the Xiaomi cloud, CS2 relay, MISS authentication and media decryption are all
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
use crate::media::{find_ffmpeg, free_port, tail, FileServer};
use crate::miss::{MediaPacket, CODEC_H264, CODEC_H265, CODEC_OPUS};
use crate::remote::RemoteCamera;

static REMOTE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct RemoteStream {
    camera: Arc<RemoteCamera>,
    ffmpeg: Child,
    server: FileServer,
    temp_dir: PathBuf,
    reader: Option<JoinHandle<()>>,
    running: Arc<AtomicBool>,
    frames: Arc<std::sync::atomic::AtomicUsize>,
    port: u16,
}

struct StartupResources {
    temp_dir: PathBuf,
    child: Option<Child>,
    reader: Option<JoinHandle<()>>,
    running: Arc<AtomicBool>,
    server: Option<FileServer>,
    active: bool,
}

impl StartupResources {
    fn new(temp_dir: PathBuf, running: Arc<AtomicBool>) -> Self {
        Self {
            temp_dir,
            child: None,
            reader: None,
            running,
            server: None,
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
        if let Some(mut server) = self.server.take() {
            server.stop();
        }
        let _ = fs::remove_dir_all(&self.temp_dir);
    }
}

impl RemoteStream {
    /// Blocking entry point. Call it from a worker thread, not the UI thread.
    pub fn start(session: Session, did: &str, quality: u8, audio: bool) -> Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("创建摄像头运行时失败")?;
        let camera = runtime.block_on(RemoteCamera::open(
            &session,
            did,
            quality,
            audio,
            Duration::from_secs(90),
        ))?;
        Self::from_camera(camera, audio)
    }

    fn from_camera(camera: RemoteCamera, audio: bool) -> Result<Self> {
        let camera = Arc::new(camera);
        let first = first_video_packet(&camera, Duration::from_secs(20))?;
        let (input_format, tag) = match first.codec_id {
            CODEC_H264 => ("h264", "avc1"),
            CODEC_H265 => ("hevc", "hvc1"),
            other => return Err(anyhow!("不支持的视频编码 id={other}")),
        };

        let ffmpeg = find_ffmpeg()?;
        let sequence = REMOTE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!(
            "mihome-remote-{}-{sequence}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir_all(&temp_dir)?;
        let running = Arc::new(AtomicBool::new(true));
        let mut resources = StartupResources::new(temp_dir.clone(), Arc::clone(&running));
        let playlist = temp_dir.join("index.m3u8");
        let segment_pattern = temp_dir.join("seg%03d.m4s");
        let ffmpeg_log = temp_dir.join("ffmpeg.log");
        let ffmpeg_log_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&ffmpeg_log)?;
        let ffmpeg_err = ffmpeg_log_file.try_clone()?;

        // 摄像头送来的是裸 Opus 包。给 ffmpeg 一份 SDP，用本地 UDP/RTP 喂给它，
        // 这样视频仍是低开销 copy，音频能在 HLS 里转成 AAC。
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

        let mut args = vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "warning".to_string(),
            "-fflags".to_string(),
            "+genpts".to_string(),
            "-f".to_string(),
            input_format.to_string(),
            "-i".to_string(),
            "pipe:0".to_string(),
        ];
        if audio_target.is_some() {
            args.extend([
                "-protocol_whitelist".to_string(),
                "file,udp,rtp".to_string(),
                "-i".to_string(),
                temp_dir.join("audio.sdp").to_string_lossy().to_string(),
                "-map".to_string(),
                "0:v".to_string(),
                "-map".to_string(),
                "1:a".to_string(),
                "-c:a".to_string(),
                "aac".to_string(),
                "-b:a".to_string(),
                "64k".to_string(),
                "-ar".to_string(),
                "48000".to_string(),
                "-ac".to_string(),
                "1".to_string(),
            ]);
        } else {
            args.extend(["-an".to_string()]);
        }
        args.extend([
            "-c:v".to_string(),
            "copy".to_string(),
            "-tag:v".to_string(),
            tag.to_string(),
            "-f".to_string(),
            "hls".to_string(),
            "-hls_time".to_string(),
            "1".to_string(),
            "-hls_list_size".to_string(),
            "6".to_string(),
            "-hls_flags".to_string(),
            "delete_segments+append_list+omit_endlist".to_string(),
            "-hls_segment_type".to_string(),
            "fmp4".to_string(),
            "-hls_fmp4_init_filename".to_string(),
            "init.mp4".to_string(),
            "-hls_segment_filename".to_string(),
            segment_pattern.to_str().unwrap_or_default().to_string(),
            playlist.to_str().unwrap_or_default().to_string(),
        ]);
        let mut child = Command::new(&ffmpeg)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::from(ffmpeg_log_file))
            .stderr(Stdio::from(ffmpeg_err))
            .spawn()
            .with_context(|| format!("启动 ffmpeg 失败：{}", ffmpeg.display()))?;
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
                let mut audio_base_ts: Option<u64> = None;
                let mut rtp_seq: u16 = 0;
                while thread_running.load(Ordering::Relaxed) {
                    match thread_camera.next_media(Duration::from_secs(3)) {
                        Ok(Some(packet)) if packet.is_video() => {
                            if last_video_seq.is_some_and(|last| {
                                let diff = packet.sequence.wrapping_sub(last);
                                diff == 0 || diff > 0x7fff_ffff
                            }) {
                                continue;
                            }
                            last_video_seq = Some(packet.sequence);
                            if stdin.write_all(&packet.payload).is_err() {
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
                            let base = *audio_base_ts.get_or_insert(packet.timestamp_ms);
                            let timestamp =
                                packet.timestamp_ms.saturating_sub(base).min(0xffff_ffff) * 48;
                            let mut rtp = Vec::with_capacity(12 + packet.payload.len());
                            rtp.push(0x80);
                            rtp.push(96);
                            rtp.extend_from_slice(&rtp_seq.to_be_bytes());
                            rtp.extend_from_slice(&(timestamp as u32).to_be_bytes());
                            rtp.extend_from_slice(&0x1234_5678u32.to_be_bytes());
                            rtp.extend_from_slice(&packet.payload);
                            rtp_seq = rtp_seq.wrapping_add(1);
                            if socket
                                .send_to(&rtp, format!("127.0.0.1:{audio_port}"))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            })
            .context("启动媒体写入线程失败")?;
        resources.reader = Some(reader);

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut ready = false;
        while Instant::now() < deadline {
            if let Ok(text) = fs::read_to_string(&playlist) {
                if text.contains("#EXTM3U") && text.contains("#EXTINF") {
                    ready = true;
                    break;
                }
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
            return Err(anyhow!(
                "远程画面没有生成 HLS。\nffmpeg: {}",
                tail(&ffmpeg_log, 6)
            ));
        }

        let server = FileServer::start(temp_dir.clone())?;
        let port = server.port();
        resources.server = Some(server);
        let ffmpeg = resources
            .child
            .take()
            .ok_or_else(|| anyhow!("ffmpeg 子进程丢失"))?;
        let server = resources
            .server
            .take()
            .ok_or_else(|| anyhow!("HLS 服务丢失"))?;
        let reader = resources.reader.take();
        resources.active = false;
        Ok(Self {
            camera,
            ffmpeg,
            server,
            temp_dir: resources.temp_dir.clone(),
            reader,
            running,
            frames,
            port,
        })
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/index.m3u8", self.port)
    }

    pub fn frames(&self) -> usize {
        self.frames.load(Ordering::Relaxed)
    }

    pub fn ptz(&self, direction: &str, _speed: u8) -> Result<()> {
        let operation = match direction {
            "left" => 1,
            "right" => 2,
            "up" => 3,
            "down" => 4,
            "stop" => 0,
            other => return Err(anyhow!("不支持的云台方向: {other}")),
        };
        self.camera.motor(operation)
    }
}

impl Drop for RemoteStream {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        let _ = self.ffmpeg.kill();
        let _ = self.ffmpeg.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        self.server.stop();
        let _ = fs::remove_dir_all(&self.temp_dir);
    }
}

fn first_video_packet(camera: &RemoteCamera, timeout: Duration) -> Result<MediaPacket> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(packet) = camera.next_media(Duration::from_secs(2))? {
            if packet.is_video() {
                return Ok(packet);
            }
        }
    }
    Err(anyhow!("摄像头没有返回视频帧"))
}
