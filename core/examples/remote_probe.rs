use anyhow::{anyhow, Result};
use mihome_core::auth::Session;
use mihome_core::cloud::MiCloud;
use mihome_core::remote::RemoteCamera;
use std::time::{Duration, Instant};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let did = std::env::args().nth(1).ok_or_else(|| anyhow!("用法: remote_probe <did> [quality]"))?;
    let quality = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "2".to_string())
        .parse::<u8>()?;
    let session = Session::restore()?.ok_or_else(|| anyhow!("没有登录会话"))?;
    let cloud = MiCloud::new(session.clone());
    let devices = cloud.devices(None).await?;
    let device = devices
        .iter()
        .find(|device| device.did == did)
        .ok_or_else(|| anyhow!("找不到设备 {did}"))?;
    if !device.online {
        return Err(anyhow!("{} 离线，无法建立 P2P", device.name));
    }
    eprintln!("opening {} ({}) ...", device.name, device.model);
    let audio = std::env::args().nth(3).map(|v| v != "0").unwrap_or(false);
    let camera = RemoteCamera::open(&session, &did, quality, audio, Duration::from_secs(45)).await?;
    eprintln!("relay {} p2p {}", camera.relay, camera.p2p_id);
    let deadline = Instant::now() + Duration::from_secs(12);
    let mut frames = 0usize;
    let mut bytes = 0usize;
    let mut audio_frames = 0usize;
    let mut audio_bytes = 0usize;
    while Instant::now() < deadline {
        if let Some(packet) = camera.next_media(Duration::from_secs(2))? {
            frames += 1;
            bytes += packet.payload.len();
            if !packet.is_video() { audio_frames += 1; audio_bytes += packet.payload.len(); }
            if !packet.is_video() && audio_frames <= 3 { eprintln!("audio {} codec={} seq={} flags={} ts={} bytes={:02x?}", audio_frames, packet.codec_name(), packet.sequence, packet.flags, packet.timestamp_ms, &packet.payload[..packet.payload.len().min(48)]); }
            if frames == 1 || packet.is_keyframe() || (!packet.is_video() && audio_frames == 1) {
                eprintln!(
                    "frame {} codec={} key={} {}B ts={}",
                    frames,
                    packet.codec_name(),
                    packet.is_keyframe(),
                    packet.payload.len(),
                    packet.timestamp_ms
                );
            }
        }
    }
    if frames == 0 {
        return Err(anyhow!("12 秒内没有收到媒体帧"));
    }
    eprintln!("received {frames} video frames / {bytes} bytes, {audio_frames} audio packets / {audio_bytes} bytes");
    Ok(())
}
