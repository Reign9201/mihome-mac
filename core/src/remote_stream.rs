//! Rust remote-camera stream: MISS media -> ffmpeg (Annex-B -> RTSP) -> go2rtc.
//!
//! This replaces the Java `micam` experiment for the product path. ffmpeg is used only for
//! low-latency H.264 transcoding and RTSP publishing; the Xiaomi cloud, CS2 relay, MISS
//! authentication and media decryption are all implemented in this crate.

use anyhow::{anyhow, Context, Result};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::UdpSocket;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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
const MAX_LIVE_MEDIA_AGE: Duration = Duration::from_millis(300);
const OPUS_PAYLOAD_TYPE: u8 = 96;
const OPUS_TIMESTAMP_STEP: u32 = 48_000 * 40 / 1000;

#[derive(Clone, Copy)]
enum AudioEncoder {
    Opus,
    Pcma,
}

#[derive(Clone, Copy)]
enum VideoEncoder {
    VideoToolbox,
    X264,
}

pub struct RemoteStream {
    camera: Arc<RemoteCamera>,
    quality: u8,
    ffmpeg: Child,
    audio_ffmpeg: Option<Child>,
    relay: Go2Rtc,
    temp_dir: PathBuf,
    reader: Option<JoinHandle<()>>,
    running: Arc<AtomicBool>,
    frames: Arc<std::sync::atomic::AtomicUsize>,
    health: Arc<StreamHealth>,
}

struct StreamHealth {
    failed: AtomicBool,
    reason: Mutex<String>,
}

impl StreamHealth {
    fn new() -> Self {
        Self {
            failed: AtomicBool::new(false),
            reason: Mutex::new(String::new()),
        }
    }

    fn fail(&self, reason: impl Into<String>) {
        if let Ok(mut stored) = self.reason.lock() {
            *stored = reason.into();
        }
        self.failed.store(true, Ordering::Release);
    }

    fn reason(&self) -> Option<String> {
        if !self.failed.load(Ordering::Acquire) {
            return None;
        }
        self.reason
            .lock()
            .ok()
            .map(|reason| reason.clone())
            .filter(|reason| !reason.is_empty())
            .or_else(|| Some("媒体线程已停止".to_string()))
    }
}

struct StartupResources {
    temp_dir: PathBuf,
    child: Option<Child>,
    audio_child: Option<Child>,
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
            audio_child: None,
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
        if let Some(mut child) = self.audio_child.take() {
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
        let relay_started = Instant::now();
        let relay_thread = thread::Builder::new()
            .name("remote-relay-prepare".to_string())
            .spawn(move || -> Result<Go2Rtc> {
                let go2rtc = crate::camera::find_binary()?;
                let stream_ids: &[&str] = if audio {
                    &["remote", "remote-audio"]
                } else {
                    &["remote"]
                };
                let relay = Go2Rtc::start_for_ingest_streams(&go2rtc, stream_ids)?;
                app_log::info(
                    "Remote",
                    format!(
                        "低延迟中继预热完成：elapsed={}ms",
                        relay_started.elapsed().as_millis()
                    ),
                );
                Ok(relay)
            })
            .context("启动低延迟中继预热线程失败")?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("创建摄像头运行时失败")?;
        let camera_result = runtime.block_on(RemoteCamera::open(
            &session,
            did,
            quality,
            audio,
            Duration::from_secs(90),
        ));
        let relay_result = relay_thread
            .join()
            .map_err(|_| anyhow!("低延迟中继预热线程异常退出"))?;
        let camera = camera_result.map_err(|error| {
            app_log::error(
                "Remote",
                format!(
                    "MISS 通道建立失败：did={} error={error:#}",
                    app_log::mask_id(did)
                ),
            );
            error
        })?;
        let relay = relay_result?;
        let stream = Self::from_camera(camera, quality, audio, relay).map_err(|error| {
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

    fn from_camera(camera: RemoteCamera, quality: u8, audio: bool, relay: Go2Rtc) -> Result<Self> {
        let started = Instant::now();
        let camera = Arc::new(camera);
        let first = first_video_packet(&camera, Duration::from_secs(20))?;
        let first_received_at = Instant::now();
        let input_format = match first.codec_id {
            CODEC_H264 => "h264",
            CODEC_H265 => "hevc",
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
        let health = Arc::new(StreamHealth::new());
        let mut resources = StartupResources::new(temp_dir.clone(), Arc::clone(&running));
        let rtsp_target = relay.rtsp_url("remote");
        let audio_rtsp_target = relay.rtsp_url("remote-audio");
        resources.relay = Some(relay);
        let ffmpeg_log = temp_dir.join("ffmpeg.log");
        let ffmpeg_log_file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&ffmpeg_log)?;
        let ffmpeg_err = ffmpeg_log_file.try_clone()?;

        // 摄像头送来的是裸 Opus 包。音频走独立 ffmpeg 和 RTSP 通道，避免
        // 音视频 mux 的时间轴互相阻塞；视频转成 H.264 躲开非标准 HEVC 的
        // VideoToolbox 解码停顿。
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

        let video_encoder = detect_video_encoder(&ffmpeg);
        let args = ffmpeg_args(input_format, video_encoder, rtsp_target.as_str());
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
                "视频进程已启动：pid={} encoder={} temp={}",
                child.id(),
                video_encoder.name(),
                temp_dir.display()
            ),
        );
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("ffmpeg stdin 不可用"))?;
        // The packet may already have been waiting in the relay receive queue
        // before ffmpeg starts. Checking only the time since this function got
        // the packet misses that case and anchors playback behind the live edge.
        let first_queue_delay = first.queue_delay;
        let first_is_stale = first_queue_delay > MAX_LIVE_MEDIA_AGE
            || first_received_at.elapsed() > MAX_LIVE_MEDIA_AGE;
        if first_is_stale {
            app_log::warn(
                "Remote",
                format!(
                    "首帧已落后 {}ms（队列 {}ms），跳过后等待新的关键帧",
                    first_received_at.elapsed().as_millis(),
                    first_queue_delay.as_millis()
                ),
            );
        } else {
            stdin.write_all(&first.payload).context("写入首帧失败")?;
        }
        resources.child = Some(child);

        if let Some((_, _)) = audio_target.as_ref() {
            let audio_log = temp_dir.join("audio-ffmpeg.log");
            let audio_log_file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&audio_log)?;
            let audio_err = audio_log_file.try_clone()?;
            let audio_encoder = detect_audio_encoder(&ffmpeg);
            let audio_args = audio_ffmpeg_args(
                &temp_dir.join("audio.sdp"),
                audio_encoder,
                audio_rtsp_target.as_str(),
            );
            let audio_child = Command::new(&ffmpeg)
                .args(&audio_args)
                .stdin(Stdio::null())
                .stdout(Stdio::from(audio_log_file))
                .stderr(Stdio::from(audio_err))
                .spawn()
                .with_context(|| format!("启动音频 ffmpeg 失败：{}", ffmpeg.display()))?;
            app_log::info(
                "ffmpeg",
                format!(
                    "音频进程已启动：pid={} encoder={} target={}",
                    audio_child.id(),
                    audio_encoder.name(),
                    audio_rtsp_target
                ),
            );
            resources.audio_child = Some(audio_child);
        }

        let frames = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let thread_frames = Arc::clone(&frames);
        let thread_camera = Arc::clone(&camera);
        let thread_running = Arc::clone(&running);
        let thread_health = Arc::clone(&health);
        let reader = thread::Builder::new()
            .name("miss-media".to_string())
            .spawn(move || {
                let mut last_video_seq: Option<u32> = None;
                let mut last_audio_seq: Option<u32> = None;
                let mut rtp_seq: u16 = 0;
                let mut audio_rtp_ts: u32 = 0;
                let mut video_needs_keyframe = first_is_stale;
                let mut skipped_video = 0_u64;
                let mut video_packets = 0_u64;
                let mut audio_packets = 0_u64;
                let mut max_queue_delay = Duration::ZERO;
                let mut max_write_time = Duration::ZERO;
                let mut last_report = Instant::now();
                while thread_running.load(Ordering::Relaxed) {
                    // Keep the blocking read short so dropping a stream does not
                    // freeze camera switching for several seconds.
                    match thread_camera.next_media(MEDIA_POLL_TIMEOUT) {
                        Ok(Some(packet)) if packet.is_video() => {
                            max_queue_delay = max_queue_delay.max(packet.queue_delay);
                            let stale = packet.queue_delay > MAX_LIVE_MEDIA_AGE;
                            if packet.discontinuity || stale {
                                if !video_needs_keyframe {
                                    app_log::warn(
                                        "Remote",
                                        format!(
                                            "视频包延迟 {}ms，丢弃积压并等待新的关键帧",
                                            packet.queue_delay.as_millis()
                                        ),
                                    );
                                }
                                video_needs_keyframe = true;
                            }
                            if video_needs_keyframe && (stale || !packet.is_keyframe()) {
                                skipped_video += 1;
                                continue;
                            }
                            if video_needs_keyframe {
                                video_needs_keyframe = false;
                                app_log::info(
                                    "Remote",
                                    format!("媒体管道已回到关键帧，跳过视频帧={skipped_video}"),
                                );
                            }
                            if last_video_seq.is_some_and(|last| {
                                let diff = packet.sequence.wrapping_sub(last);
                                diff == 0 || diff > 0x7fff_ffff
                            }) {
                                continue;
                            }
                            last_video_seq = Some(packet.sequence);
                            let write_started = Instant::now();
                            if let Err(error) = stdin.write_all(&packet.payload) {
                                if thread_running.load(Ordering::Relaxed) {
                                    thread_health
                                        .fail(format!("写入视频帧失败，媒体线程已退出：{error}"));
                                    app_log::warn(
                                        "Remote",
                                        format!("写入视频帧失败，媒体线程退出：{error}"),
                                    );
                                }
                                break;
                            }
                            let write_time = write_started.elapsed();
                            max_write_time = max_write_time.max(write_time);
                            if write_time > Duration::from_millis(250) {
                                app_log::warn(
                                    "Remote",
                                    format!(
                                        "视频写入阻塞：elapsed={}ms bytes={}",
                                        write_time.as_millis(),
                                        packet.payload.len()
                                    ),
                                );
                            }
                            thread_frames.fetch_add(1, Ordering::Relaxed);
                            video_packets += 1;
                        }
                        Ok(Some(packet)) if packet.codec_id == CODEC_OPUS => {
                            max_queue_delay = max_queue_delay.max(packet.queue_delay);
                            if packet.queue_delay > MAX_LIVE_MEDIA_AGE {
                                continue;
                            }
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
                                    thread_health
                                        .fail(format!("发送音频包失败，媒体线程已退出：{error}"));
                                    app_log::warn(
                                        "Remote",
                                        format!("发送音频包失败，媒体线程退出：{error}"),
                                    );
                                }
                                break;
                            }
                            audio_packets += 1;
                        }
                        Ok(_) => {}
                        Err(error) => {
                            thread_health
                                .fail(format!("读取媒体包失败，媒体线程已退出：{error:#}"));
                            app_log::error("Remote", format!("读取媒体包失败：{error:#}"));
                            break;
                        }
                    }
                    if last_report.elapsed() >= Duration::from_secs(5) {
                        app_log::debug(
                            "Remote",
                            format!(
                                "媒体线程正常：video={video_packets} audio={audio_packets} \
                                 skipped={skipped_video} queue_gap={video_needs_keyframe} \
                                 queue_max_ms={} write_max_ms={}",
                                max_queue_delay.as_millis(),
                                max_write_time.as_millis(),
                            ),
                        );
                        max_queue_delay = Duration::ZERO;
                        max_write_time = Duration::ZERO;
                        last_report = Instant::now();
                    }
                }
            })
            .context("启动媒体写入线程失败")?;
        resources.reader = Some(reader);

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut ready = false;
        while Instant::now() < deadline {
            let video_ready = resources
                .relay
                .as_ref()
                .is_some_and(|relay| relay.producer_ready("remote"));
            let audio_ready = !audio
                || resources
                    .relay
                    .as_ref()
                    .is_some_and(|relay| relay.producer_ready("remote-audio"));
            if video_ready && audio_ready {
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
            if let Some(audio_child) = resources.audio_child.as_mut() {
                if let Some(status) = audio_child.try_wait()? {
                    return Err(anyhow!(
                        "音频 ffmpeg 提前退出（{status}）。\nffmpeg: {}",
                        tail(&temp_dir.join("audio-ffmpeg.log"), 6)
                    ));
                }
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
                "低延迟中继已就绪：rtsp={rtsp_target} audio={} elapsed={}ms",
                if audio { &audio_rtsp_target } else { "off" },
                started.elapsed().as_millis()
            ),
        );
        let ffmpeg = resources
            .child
            .take()
            .ok_or_else(|| anyhow!("ffmpeg 子进程丢失"))?;
        let audio_ffmpeg = resources.audio_child.take();
        let relay = resources
            .relay
            .take()
            .ok_or_else(|| anyhow!("go2rtc 中继丢失"))?;
        let reader = resources.reader.take();
        resources.active = false;
        Ok(Self {
            camera,
            quality,
            ffmpeg,
            audio_ffmpeg,
            relay,
            temp_dir: resources.temp_dir.clone(),
            reader,
            running,
            frames,
            health,
        })
    }

    pub fn url(&self) -> String {
        self.relay.stream_url("remote")
    }

    pub fn webrtc_url(&self) -> String {
        self.relay.webrtc_url("remote")
    }

    pub fn audio_webrtc_url(&self) -> Option<String> {
        self.audio_ffmpeg
            .as_ref()
            .map(|_| self.relay.webrtc_url("remote-audio"))
    }

    pub fn quality(&self) -> u8 {
        self.quality
    }

    pub fn has_audio(&self) -> bool {
        self.audio_ffmpeg.is_some()
    }

    pub fn frames(&self) -> usize {
        self.frames.load(Ordering::Relaxed)
    }

    pub fn health_reason(&self) -> Option<String> {
        if let Some(reason) = self.health.reason() {
            return Some(reason);
        }
        if self.running.load(Ordering::Acquire)
            && self.reader.as_ref().is_some_and(JoinHandle::is_finished)
        {
            return Some("媒体线程意外停止".to_string());
        }
        None
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

fn ffmpeg_args(input_format: &str, video_encoder: VideoEncoder, rtsp_target: &str) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        // Raw H.264/H.265 has no timestamps. Wall-clock timestamps track the
        // camera instead of forcing every model to ffmpeg's default 25 fps.
        "-use_wallclock_as_timestamps".to_string(),
        "1".to_string(),
        "-fflags".to_string(),
        "+genpts+nobuffer+flush_packets".to_string(),
        "-flags".to_string(),
        "low_delay".to_string(),
        "-analyzeduration".to_string(),
        "0".to_string(),
        "-probesize".to_string(),
        "32k".to_string(),
        "-f".to_string(),
        input_format.to_string(),
        "-i".to_string(),
        "pipe:0".to_string(),
        "-an".to_string(),
        // Xiaomi commonly sends a 2960x1666 HEVC frame. Cap the WebView stream
        // at 1080p so software HEVC decode and H.264 playback stay real-time.
        "-vf".to_string(),
        r"scale=min(1920\,iw):-2".to_string(),
    ];
    args.extend(video_encoder.args());
    args.extend(strings(&[
        "-tag:v",
        "avc1",
        "-vsync",
        "0",
        "-max_delay",
        "0",
        "-flush_packets",
        "1",
        "-avioflags",
        "direct",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-rtsp_transport",
        "tcp",
        "-f",
        "rtsp",
        rtsp_target,
    ]));
    args
}

fn audio_ffmpeg_args(
    audio_sdp: &std::path::Path,
    audio_encoder: AudioEncoder,
    rtsp_target: &str,
) -> Vec<String> {
    let mut args = strings(&[
        "-hide_banner",
        "-loglevel",
        "warning",
        "-protocol_whitelist",
        "file,udp,rtp",
        "-fflags",
        "+genpts+nobuffer+flush_packets",
        "-flags",
        "low_delay",
        "-avioflags",
        "direct",
        "-thread_queue_size",
        "64",
        "-i",
    ]);
    args.push(audio_sdp.to_string_lossy().to_string());
    args.extend(strings(&["-map", "0:a", "-vn"]));
    args.extend(audio_encoder.args());
    // The camera timestamps every Opus frame in 40 ms steps. Align the first
    // sample to zero and compensate clock drift without buffering video.
    args.extend(strings(&["-af", "aresample=async=1:first_pts=0"]));
    args.extend(strings(&[
        "-flush_packets",
        "1",
        "-max_delay",
        "0",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-rtsp_transport",
        "tcp",
        "-f",
        "rtsp",
        rtsp_target,
    ]));
    args
}

impl AudioEncoder {
    fn name(self) -> &'static str {
        match self {
            Self::Opus => "libopus",
            Self::Pcma => "pcm_alaw",
        }
    }

    fn args(self) -> Vec<String> {
        match self {
            // Xiaomi sends complete but unusually packetized Opus frames. Forwarding
            // those packets through Pion can produce silence or robotic audio, so
            // decode and emit a standards-compliant low-delay Opus stream.
            Self::Opus => strings(&[
                "-c:a",
                "libopus",
                "-b:a",
                "48k",
                "-ar",
                "48000",
                "-ac",
                "1",
                "-application",
                "lowdelay",
                "-frame_duration",
                "20",
            ]),
            // Some Homebrew/system ffmpeg builds omit libopus. PCMA is still
            // supported by WebRTC and avoids leaving the user with no audio.
            Self::Pcma => strings(&["-c:a", "pcm_alaw", "-ar", "8000", "-ac", "1"]),
        }
    }
}

impl VideoEncoder {
    fn name(self) -> &'static str {
        match self {
            Self::VideoToolbox => "h264_videotoolbox",
            Self::X264 => "libx264",
        }
    }

    fn args(self) -> Vec<String> {
        match self {
            // The camera's HEVC cannot be decoded reliably by VideoToolbox.
            // Decode in software, then encode standards-compliant H.264.
            Self::VideoToolbox => strings(&[
                "-c:v",
                "h264_videotoolbox",
                "-g",
                "20",
                "-bf",
                "0",
                "-profile:v",
                "high",
                "-level:v",
                "4.2",
                "-realtime",
                "true",
                "-allow_sw",
                "0",
                "-b:v",
                "5M",
                "-maxrate",
                "8M",
                "-bufsize",
                "5M",
                "-pix_fmt:v",
                "yuv420p",
            ]),
            Self::X264 => strings(&[
                "-c:v",
                "libx264",
                "-preset:v",
                "superfast",
                "-tune:v",
                "zerolatency",
                "-g",
                "20",
                "-profile:v",
                "high",
                "-level:v",
                "4.2",
                "-bf",
                "0",
                "-b:v",
                "5M",
                "-maxrate",
                "8M",
                "-bufsize",
                "5M",
                "-pix_fmt:v",
                "yuv420p",
            ]),
        }
    }
}

fn detect_video_encoder(ffmpeg: &std::path::Path) -> VideoEncoder {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output();
    let encoders = output
        .as_ref()
        .map(|output| String::from_utf8_lossy(&output.stdout))
        .unwrap_or_default();
    let requested = std::env::var("MIHOME_REMOTE_ENCODER")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let encoder = choose_remote_video_encoder(&encoders, &requested);
    match encoder {
        VideoEncoder::X264 => {
            if !encoders.contains("libx264") {
                app_log::warn("ffmpeg", "当前 ffmpeg 不含 libx264，远程视频可能无法启动");
            }
            app_log::info(
                "ffmpeg",
                "远程视频使用 libx264 零延迟软件编码，避免硬件转码队列积压",
            );
        }
        VideoEncoder::VideoToolbox => {
            if !encoders.contains("h264_videotoolbox") {
                app_log::warn(
                    "ffmpeg",
                    "远程视频请求 h264_videotoolbox，但当前 ffmpeg 不支持",
                );
            }
            app_log::info("ffmpeg", "远程视频使用 h264_videotoolbox 硬件编码");
        }
    }
    if let Err(error) = output {
        app_log::warn(
            "ffmpeg",
            format!("无法读取 ffmpeg 编码器列表，按可用编码器回退：{error}"),
        );
    }
    encoder
}

fn choose_remote_video_encoder(encoders: &str, requested: &str) -> VideoEncoder {
    let has_x264 = encoders.contains("libx264");
    let has_videotoolbox = encoders.contains("h264_videotoolbox");
    match requested {
        "videotoolbox" | "video-toolbox" | "hardware" | "vt" if has_videotoolbox => {
            VideoEncoder::VideoToolbox
        }
        "x264" | "libx264" | "software" if has_x264 => VideoEncoder::X264,
        _ if has_x264 => VideoEncoder::X264,
        _ if has_videotoolbox => VideoEncoder::VideoToolbox,
        _ => VideoEncoder::X264,
    }
}

fn detect_audio_encoder(ffmpeg: &std::path::Path) -> AudioEncoder {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output();
    match output {
        Ok(output) if String::from_utf8_lossy(&output.stdout).contains("libopus") => {
            AudioEncoder::Opus
        }
        Ok(_) => {
            app_log::warn(
                "ffmpeg",
                "当前 ffmpeg 不含 libopus，远程音频回退到 PCMA 转码",
            );
            AudioEncoder::Pcma
        }
        Err(error) => {
            app_log::warn(
                "ffmpeg",
                format!("无法读取 ffmpeg 编码器列表，远程音频回退到 PCMA：{error}"),
            );
            AudioEncoder::Pcma
        }
    }
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
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
        if let Some(audio_ffmpeg) = self.audio_ffmpeg.as_mut() {
            let _ = audio_ffmpeg.kill();
            let _ = audio_ffmpeg.wait();
        }
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
            VideoEncoder::VideoToolbox,
            "rtsp://127.0.0.1:41002/remote",
        );
        let joined = args.join(" ");
        assert!(joined.contains("-use_wallclock_as_timestamps 1"));
        assert!(joined.contains("-fflags +genpts+nobuffer"));
        assert!(joined.contains("-flags low_delay"));
        assert!(joined.contains("-analyzeduration 0"));
        assert!(joined.contains("-probesize 32k"));
        assert!(joined.contains("-avioflags direct"));
        assert!(joined.contains("-vsync 0"));
        assert!(joined.contains("-rtsp_transport tcp"));
        assert!(joined.contains("-f rtsp rtsp://127.0.0.1:41002/remote"));
        assert!(joined.contains("-c:v h264_videotoolbox"));
        assert!(joined.contains("-realtime true"));
        assert!(joined.contains("-allow_sw 0"));
        assert!(joined.contains("-g 20"));
        assert!(joined.contains("-level:v 4.2"));
        assert!(joined.contains(r"scale=min(1920\,iw):-2"));
        assert!(joined.contains("-tag:v avc1"));
        assert!(joined.contains("-an"));
        assert!(!joined.contains("-c:v copy"));
        assert!(!joined.contains("audio.sdp"));
        assert!(!joined.contains("m3u8"));
        assert!(!joined.contains("hls"));
    }

    #[test]
    fn remote_h264_transcode_has_a_software_fallback() {
        let args = ffmpeg_args("hevc", VideoEncoder::X264, "rtsp://127.0.0.1:41002/remote");
        let joined = args.join(" ");
        assert!(joined.contains("-c:v libx264"));
        assert!(joined.contains("-preset:v superfast"));
        assert!(joined.contains("-tune:v zerolatency"));
        assert!(joined.contains("-bf 0"));
        assert!(joined.contains("-tag:v avc1"));
    }

    #[test]
    fn remote_transcode_prefers_x264_zero_latency_by_default() {
        assert!(matches!(
            choose_remote_video_encoder("libx264 h264_videotoolbox", ""),
            VideoEncoder::X264
        ));
        assert!(matches!(
            choose_remote_video_encoder("libx264 h264_videotoolbox", "hardware"),
            VideoEncoder::VideoToolbox
        ));
        assert!(matches!(
            choose_remote_video_encoder("h264_videotoolbox", "x264"),
            VideoEncoder::VideoToolbox
        ));
    }

    #[test]
    fn remote_audio_runs_on_an_independent_low_latency_stream() {
        let args = audio_ffmpeg_args(
            std::path::Path::new("/tmp/audio.sdp"),
            AudioEncoder::Opus,
            "rtsp://127.0.0.1:41002/remote-audio",
        );
        let joined = args.join(" ");
        assert!(joined.contains("-protocol_whitelist file,udp,rtp"));
        assert!(joined.contains("-thread_queue_size 64"));
        assert!(joined.contains("-c:a libopus"));
        assert!(joined.contains("-application lowdelay"));
        assert!(joined.contains("-frame_duration 20"));
        assert!(joined.contains("aresample=async=1:first_pts=0"));
        assert!(joined.contains("rtsp://127.0.0.1:41002/remote-audio"));
        assert!(!joined.contains("-c:a copy"));
        assert!(!joined.contains("pipe:0"));
    }

    #[test]
    fn remote_audio_has_a_webrtc_compatible_fallback() {
        let args = audio_ffmpeg_args(
            std::path::Path::new("/tmp/audio.sdp"),
            AudioEncoder::Pcma,
            "rtsp://127.0.0.1:41002/remote-audio",
        );
        let joined = args.join(" ");
        assert!(joined.contains("-c:a pcm_alaw"));
        assert!(!joined.contains("-c:a copy"));
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
            discontinuity: false,
            queue_delay: Duration::ZERO,
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
