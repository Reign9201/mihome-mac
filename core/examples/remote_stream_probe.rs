use mihome_core::auth::Session;
use mihome_core::remote_stream::RemoteStream;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;
use std::time::Duration;

fn main() -> anyhow::Result<()> {
    let did = std::env::args().nth(1).unwrap_or_else(|| "1053392676".into());
    let quality = std::env::args().nth(2).and_then(|v| v.parse().ok()).unwrap_or(2);
    let session = Session::restore()?.ok_or_else(|| anyhow::anyhow!("没有登录会话"))?;
    let stream = RemoteStream::start(session, &did, quality)?;
    println!("STREAM {}", stream.url());
    thread::sleep(Duration::from_secs(30));
    println!("FRAMES {}", stream.frames());
    let url = stream.url();
    let path = url.split("127.0.0.1:").nth(1).unwrap();
    let addr = format!("127.0.0.1:{}", path.split('/').next().unwrap());
    let mut socket = TcpStream::connect(&addr)?;
    write!(socket, "GET /index.m3u8 HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n")?;
    let mut body = String::new();
    socket.read_to_string(&mut body)?;
    println!("PLAYLIST\n{}", body.lines().take(12).collect::<Vec<_>>().join("\n"));
    Ok(())
}
