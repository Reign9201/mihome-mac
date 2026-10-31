use mihome_core::auth::Session;
use mihome_core::remote_stream::RemoteStream;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::Duration;

fn main() -> anyhow::Result<()> {
    let did = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "1053392676".into());
    let quality = std::env::args()
        .nth(2)
        .and_then(|v| v.parse().ok())
        .unwrap_or(2);
    let seconds = std::env::args()
        .nth(3)
        .and_then(|value| value.parse().ok())
        .unwrap_or(30);
    let session = Session::restore()?.ok_or_else(|| anyhow::anyhow!("没有登录会话"))?;
    let stream = RemoteStream::start(session, &did, quality, true)?;
    println!("STREAM {}", stream.url());
    println!("WEBRTC {}", stream.webrtc_url());
    thread::sleep(Duration::from_secs(seconds));
    println!("FRAMES {}", stream.frames());
    let url = stream.url();
    let endpoint = url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow::anyhow!("播放地址不是本机 HTTP 地址"))?;
    let (addr, path) = endpoint
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("播放地址缺少路径"))?;
    let mut socket = TcpStream::connect(addr)?;
    write!(
        socket,
        "GET /{path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
    )?;
    let mut body = String::new();
    socket.read_to_string(&mut body)?;
    println!(
        "PLAYLIST\n{}",
        body.lines().take(12).collect::<Vec<_>>().join("\n")
    );
    Ok(())
}
