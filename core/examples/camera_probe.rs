use mihome_core::camera::Go2Rtc;
use std::path::PathBuf;

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
    std::thread::sleep(std::time::Duration::from_secs(1));
    Ok(())
}
