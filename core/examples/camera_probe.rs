use mihome_core::camera::Go2Rtc;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let binary = std::env::var("MIHOME_GO2RTC")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp/go2rtc-test/go2rtc"));
    let source = "exec:ffmpeg -re -f lavfi -i testsrc=size=640x360:rate=25 -c:v libx264 -preset ultrafast -tune zerolatency -f rtsp {output}";
    let rt = Go2Rtc::start_with_source(&binary, "demo", source)?;
    println!("port={} url={}", rt.port, rt.stream_url("demo"));
    let url = rt.stream_url("demo");
    std::thread::sleep(std::time::Duration::from_secs(2));
    let response = reqwest::get(&url).await?;
    println!("status={}", response.status());
    let body = response.text().await?;
    println!(
        "bytes={} hls={}",
        body.len(),
        body.lines().next().unwrap_or("")
    );
    let playlist = body
        .lines()
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .ok_or_else(|| anyhow::anyhow!("HLS 主播放列表缺少媒体列表地址"))?;
    let playlist_url = url::Url::parse(&url)?.join(playlist)?;
    let response = reqwest::get(playlist_url).await?;
    println!("playlist_status={}", response.status());
    let body = response.text().await?;
    println!(
        "playlist_bytes={} hls={}",
        body.len(),
        body.lines().next().unwrap_or("")
    );

    let ws_url = url::Url::parse(&rt.webrtc_url("demo"))?;
    let mut ws = TcpStream::connect((
        ws_url.host_str().unwrap_or("127.0.0.1"),
        ws_url.port().unwrap_or(80),
    ))?;
    ws.set_read_timeout(Some(Duration::from_secs(5)))?;
    let target = format!(
        "{}{}",
        ws_url.path(),
        ws_url
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    );
    write!(
        ws,
        "GET {target} HTTP/1.1\r\nHost: {}\r\nOrigin: tauri://localhost\r\nUpgrade: websocket\r\nPragma: no-cache\r\nCache-Control: no-cache\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n",
        ws_url.host_str().unwrap_or("127.0.0.1")
    )?;
    let mut response = [0u8; 4096];
    let read = ws.read(&mut response)?;
    println!(
        "websocket_status={}",
        String::from_utf8_lossy(&response[..read])
            .lines()
            .next()
            .unwrap_or("")
    );
    std::thread::sleep(std::time::Duration::from_secs(1));
    Ok(())
}
