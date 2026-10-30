//! Rust remote-camera stream: MISS media -> ffmpeg (Annex-B -> fMP4 HLS) -> loopback HTTP.
//!
//! This replaces the Java `micam` experiment for the product path. ffmpeg remains only as the
//! HLS packager; the Xiaomi cloud, CS2 relay, MISS authentication and media decryption are all
//! implemented in this crate.

use anyhow::{anyhow, Context, Result};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::auth::Session;
use crate::media::{find_ffmpeg, free_port, tail, FileServer};
use crate::miss::{MediaPacket, CODEC_H264, CODEC_H265};
use crate::remote::RemoteCamera;

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

impl RemoteStream {
    /// Blocking entry point. Call it from a worker thread, not the UI thread.
    pub fn start(session: Session, did: &str, quality: u8) -> Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("创建摄像头运行时失败")?;
        let camera = runtime.block_on(RemoteCamera::open(
            &session,
            did,
            quality,
            Duration::from_secs(90),
        ))?;
        Self::from_camera(camera)
    }

    fn from_camera(camera: RemoteCamera) -> Result<Self> {
        let camera = Arc::new(camera);
        let first = first_video_packet(&camera, Duration::from_secs(20))?;
        let (input_format, tag) = match first.codec_id {
            CODEC_H264 => ("h264", "avc1"),
            CODEC_H265 => ("hevc", "hvc1"),
            other => return Err(anyhow!("不支持的视频编码 id={other}")),
        };

        let ffmpeg = find_ffmpeg()?;
        let temp_tag = free_port()?;
        let temp_dir = std::env::temp_dir().join(format!("mihome-remote-{}-{temp_tag}", std::process::id()));
        fs::create_dir_all(&temp_dir)?;
        let playlist = temp_dir.join("index.m3u8");
        let segment_pattern = temp_dir.join("seg%03d.m4s");
        let ffmpeg_log = temp_dir.join("ffmpeg.log");
        let ffmpeg_log_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&ffmpeg_log)?;
        let ffmpeg_err = ffmpeg_log_file.try_clone()?;

        let mut child = Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "warning",
                "-fflags",
                "+genpts",
                "-f",
                input_format,
                "-i",
                "pipe:0",
                "-an",
                "-c",
                "copy",
                "-tag:v",
                tag,
                "-f",
                "hls",
                "-hls_time",
                "1",
                "-hls_list_size",
                "6",
                "-hls_flags",
                "delete_segments+append_list+omit_endlist",
                "-hls_segment_type",
                "fmp4",
                "-hls_fmp4_init_filename",
                "init.mp4",
                "-hls_segment_filename",
                segment_pattern.to_str().unwrap_or_default(),
                playlist.to_str().unwrap_or_default(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::from(ffmpeg_log_file))
            .stderr(Stdio::from(ffmpeg_err))
            .spawn()
            .with_context(|| format!("启动 ffmpeg 失败：{}", ffmpeg.display()))?;
        let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("ffmpeg stdin 不可用"))?;
        stdin.write_all(&first.payload).context("写入首帧失败")?;

        let running = Arc::new(AtomicBool::new(true));
        let frames = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let thread_frames = Arc::clone(&frames);
        let thread_camera = Arc::clone(&camera);
        let thread_running = Arc::clone(&running);
        let reader = thread::Builder::new()
            .name("miss-media".to_string())
            .spawn(move || {
                while thread_running.load(Ordering::Relaxed) {
                    match thread_camera.next_media(Duration::from_secs(3)) {
                        Ok(Some(packet)) if packet.is_video() => {
                            if stdin.write_all(&packet.payload).is_err() {
                                break;
                            }
                            thread_frames.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            })
            .context("启动媒体写入线程失败")?;

        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Ok(text) = fs::read_to_string(&playlist) {
                if text.contains("#EXTM3U") && text.contains("#EXTINF") {
                    break;
                }
            }
            if let Some(status) = child.try_wait()? {
                running.store(false, Ordering::Relaxed);
                return Err(anyhow!(
                    "ffmpeg 提前退出（{status}）。\nffmpeg: {}",
                    tail(&ffmpeg_log, 6)
                ));
            }
            thread::sleep(Duration::from_millis(150));
        }
        if !playlist.is_file() {
            running.store(false, Ordering::Relaxed);
            let _ = child.kill();
            return Err(anyhow!(
                "远程画面没有生成 HLS。\nffmpeg: {}",
                tail(&ffmpeg_log, 6)
            ));
        }

        let server = FileServer::start(temp_dir.clone())?;
        let port = server.port();
        Ok(Self {
            camera,
            ffmpeg: child,
            server,
            temp_dir,
            reader: Some(reader),
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

    pub fn ptz(&self, direction: &str, speed: u8) -> Result<()> {
        self.camera.motor(direction, speed)
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
