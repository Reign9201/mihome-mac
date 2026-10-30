use mihome_core::auth::Session;
use mihome_core::remote_stream::RemoteStream;
use std::process::Command;
use std::thread;
use std::time::Duration;

fn grab(url: &str, path: &str) -> anyhow::Result<()> {
    let status = Command::new("/opt/homebrew/bin/ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i", url, "-frames:v", "1", path])
        .status()?;
    if !status.success() { anyhow::bail!("抓帧失败 {path}"); }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let did = std::env::args().nth(1).unwrap_or_else(|| "1178828157".into());
    let quality = std::env::args().nth(2).and_then(|v| v.parse().ok()).unwrap_or(2);
    let session = Session::restore()?.ok_or_else(|| anyhow::anyhow!("没有登录会话"))?;
    let stream = RemoteStream::start(session, &did, quality)?;
    let url = stream.url();
    println!("STREAM {url}");
    thread::sleep(Duration::from_secs(5));
    grab(&url, "/tmp/ptz-before.png")?;
    thread::sleep(Duration::from_secs(3));
    grab(&url, "/tmp/ptz-baseline.png")?;
    println!("PTZ left");
    stream.ptz("left", 40)?;
    thread::sleep(Duration::from_secs(2));
    stream.ptz("stop", 0)?;
    thread::sleep(Duration::from_secs(2));
    grab(&url, "/tmp/ptz-after.png")?;
    println!("FRAMES {}", stream.frames());
    Ok(())
}
