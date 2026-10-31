//! Authenticated loopback proxy for the go2rtc HTTP and WebSocket endpoints.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use rand::RngCore;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::logging as app_log;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_CONNECTIONS: usize = 32;

pub struct LoopbackProxy {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl LoopbackProxy {
    pub fn start(upstream_port: u16, username: &str, password: &str) -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).context("启动本地安全代理失败")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = random_hex(24);
        let authorization = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
        );
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let active = Arc::new(AtomicUsize::new(0));
        let active_thread = Arc::clone(&active);
        let worker_token = token.clone();
        let thread = thread::Builder::new()
            .name("go2rtc-proxy".to_string())
            .spawn(move || {
                while !stop_thread.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let current = active_thread.fetch_add(1, Ordering::Relaxed);
                            if current >= MAX_CONNECTIONS {
                                active_thread.fetch_sub(1, Ordering::Relaxed);
                                let mut stream = stream;
                                let _ = write_error(&mut stream, 503, "Service Unavailable");
                                continue;
                            }
                            let token = worker_token.clone();
                            let authorization = authorization.clone();
                            let active_worker = Arc::clone(&active_thread);
                            let spawned = thread::Builder::new()
                                .name("go2rtc-proxy-connection".to_string())
                                .spawn(move || {
                                    if let Err(error) = handle_connection(
                                        stream,
                                        upstream_port,
                                        &token,
                                        &authorization,
                                    ) {
                                        app_log::warn(
                                            "go2rtc-proxy",
                                            format!("本地播放代理连接失败：{error:#}"),
                                        );
                                    }
                                    active_worker.fetch_sub(1, Ordering::Relaxed);
                                });
                            if spawned.is_err() {
                                active_thread.fetch_sub(1, Ordering::Relaxed);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(15));
                        }
                        Err(_) => break,
                    }
                }
            })
            .context("启动本地安全代理线程失败")?;
        Ok(Self {
            port,
            token,
            stop,
            thread: Some(thread),
        })
    }

    pub fn http_url(&self, path: &str) -> String {
        format!(
            "http://127.0.0.1:{}/t/{}/{}",
            self.port,
            self.token,
            path.trim_start_matches('/')
        )
    }

    pub fn websocket_url(&self, path: &str) -> String {
        format!(
            "ws://127.0.0.1:{}/t/{}/{}",
            self.port,
            self.token,
            path.trim_start_matches('/')
        )
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for LoopbackProxy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn handle_connection(
    mut client: TcpStream,
    upstream_port: u16,
    token: &str,
    authorization: &str,
) -> Result<()> {
    client.set_nonblocking(false)?;
    client.set_nodelay(true)?;
    client.set_read_timeout(Some(Duration::from_secs(10)))?;
    let (head, client_extra) = read_head(&mut client)?;
    let request = String::from_utf8_lossy(&head);
    let mut lines = request.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let target = request_parts.next().unwrap_or_default();
    if !matches!(method, "GET" | "HEAD") {
        return write_error(&mut client, 405, "Method Not Allowed");
    }

    let (path, query) = target
        .split_once('?')
        .map_or((target, ""), |(path, query)| (path, query));
    let prefix = format!("/t/{token}");
    let upstream_path = path
        .strip_prefix(&prefix)
        .filter(|path| path.starts_with('/'))
        .ok_or_else(|| anyhow!("无效的本地代理令牌"))?;
    if !allowed_path(upstream_path) {
        return write_error(&mut client, 404, "Not Found");
    }

    let websocket = lines.clone().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
        })
    });
    let mut upstream_request = format!(
        "{method} {upstream_path}{}{} HTTP/1.1\r\nHost: 127.0.0.1:{upstream_port}\r\nAuthorization: {authorization}\r\n",
        if query.is_empty() { "" } else { "?" },
        query
    );
    for line in lines {
        if line.is_empty() {
            break;
        }
        let name = line
            .split_once(':')
            .map(|(name, _)| name.trim())
            .unwrap_or_default();
        if [
            "host",
            "origin",
            "referer",
            "authorization",
            "connection",
            "proxy-connection",
        ]
        .iter()
        .any(|skip| name.eq_ignore_ascii_case(skip))
        {
            continue;
        }
        upstream_request.push_str(line);
        upstream_request.push_str("\r\n");
    }
    upstream_request.push_str(if websocket {
        "Connection: Upgrade\r\n\r\n"
    } else {
        "Connection: close\r\n\r\n"
    });

    let mut upstream =
        TcpStream::connect(("127.0.0.1", upstream_port)).context("连接 go2rtc 失败")?;
    upstream.set_nonblocking(false)?;
    upstream.set_nodelay(true)?;
    upstream.set_read_timeout(Some(Duration::from_secs(15)))?;
    upstream.write_all(upstream_request.as_bytes())?;
    if !client_extra.is_empty() {
        upstream.write_all(&client_extra)?;
    }

    if websocket {
        bridge_websocket(client, upstream)?;
    } else {
        client.set_read_timeout(None)?;
        client.set_write_timeout(None)?;
        upstream.set_read_timeout(None)?;
        std::io::copy(&mut upstream, &mut client)?;
    }
    Ok(())
}

fn allowed_path(path: &str) -> bool {
    path == "/api/ws" || path == "/api/stream.m3u8" || path.starts_with("/api/hls/")
}

fn bridge_websocket(mut client: TcpStream, mut upstream: TcpStream) -> Result<()> {
    let (head, upstream_extra) = read_head(&mut upstream)?;
    let status = String::from_utf8_lossy(&head);
    let status_line = status.lines().next().unwrap_or("upstream 无状态行");
    if !status.starts_with("HTTP/1.1 101") && !status.starts_with("HTTP/1.0 101") {
        app_log::warn(
            "go2rtc-proxy",
            format!("WebSocket 上游握手失败：{status_line}"),
        );
        client.write_all(&head)?;
        client.write_all(&upstream_extra)?;
        return Ok(());
    }
    app_log::debug("go2rtc-proxy", "WebSocket 上游握手完成");
    client.write_all(&head)?;
    client.write_all(&upstream_extra)?;
    client.set_read_timeout(None)?;
    client.set_write_timeout(None)?;
    upstream.set_read_timeout(None)?;
    upstream.set_write_timeout(None)?;

    let mut client_reader = client;
    let mut upstream_writer = upstream.try_clone()?;
    let mut upstream_reader = upstream;
    let mut client_writer = client_reader.try_clone()?;
    let upload = thread::spawn(move || {
        let _ = std::io::copy(&mut client_reader, &mut upstream_writer);
        let _ = upstream_writer.shutdown(Shutdown::Both);
    });
    let _ = std::io::copy(&mut upstream_reader, &mut client_writer);
    let _ = client_writer.shutdown(Shutdown::Both);
    let _ = upload.join();
    Ok(())
}

fn read_head(stream: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut head = Vec::with_capacity(2048);
    let mut buffer = [0u8; 4096];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Err(anyhow!("连接在请求头完成前关闭"));
        }
        head.extend_from_slice(&buffer[..read]);
        if head.len() > MAX_HEADER_BYTES {
            return Err(anyhow!("请求头过大"));
        }
        if let Some(offset) = head.windows(4).position(|window| window == b"\r\n\r\n") {
            let mut extra = head.split_off(offset + 4);
            extra.shrink_to_fit();
            return Ok((head, extra));
        }
    }
}

fn write_error(stream: &mut TcpStream, status: u16, reason: &str) -> Result<()> {
    let body = reason.as_bytes();
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reason}",
        body.len()
    )?;
    Ok(())
}

fn random_hex(length: usize) -> String {
    let mut bytes = vec![0u8; length.div_ceil(2)];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let mut value = hex::encode(bytes);
    value.truncate(length);
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exposes_playback_endpoints() {
        assert!(allowed_path("/api/ws"));
        assert!(allowed_path("/api/stream.m3u8"));
        assert!(allowed_path("/api/hls/segment.m4s"));
        assert!(!allowed_path("/api/streams"));
        assert!(!allowed_path("/api/config"));
        assert!(!allowed_path("/api/exec"));
    }

    #[test]
    fn prefixes_http_and_websocket_urls_with_a_private_token() {
        let proxy = LoopbackProxy::start(1984, "user", "pass").unwrap();
        assert!(proxy.http_url("/api/stream.m3u8").contains("/t/"));
        assert!(proxy
            .websocket_url("/api/ws")
            .starts_with("ws://127.0.0.1:"));
        assert_ne!(
            proxy.http_url("api/stream.m3u8"),
            proxy.websocket_url("api/ws")
        );
    }

    #[test]
    fn proxies_allowed_requests_with_upstream_authentication() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let expected_auth = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("user:pass")
        );
        let expected_auth_for_server = expected_auth.clone();
        let upstream = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let (head, _) = read_head(&mut stream).unwrap();
            let request = String::from_utf8_lossy(&head);
            assert!(request.starts_with("GET /api/stream.m3u8?src=camera HTTP/1.1\r\n"));
            assert!(request.contains(&format!("Authorization: {expected_auth_for_server}\r\n")));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nplaylist",
                )
                .unwrap();
        });

        let proxy = LoopbackProxy::start(upstream_port, "user", "pass").unwrap();
        let url = url::Url::parse(&proxy.http_url("api/stream.m3u8?src=camera")).unwrap();
        let mut stream =
            TcpStream::connect((url.host_str().unwrap(), url.port().unwrap_or(80))).unwrap();
        write!(
            stream,
            "GET {}?{} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            url.path(),
            url.query().unwrap_or_default()
        )
        .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.ends_with("playlist"));
        upstream.join().unwrap();
    }

    #[test]
    fn bridges_websocket_upgrade_and_delayed_frames() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let expected_auth = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("user:pass")
        );
        let expected_auth_for_server = expected_auth.clone();
        let upstream = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let (head, _) = read_head(&mut stream).unwrap();
            let request = String::from_utf8_lossy(&head);
            assert!(request.starts_with("GET /api/ws?src=camera HTTP/1.1\r\n"));
            assert!(request.contains(&format!("Authorization: {expected_auth_for_server}\r\n")));
            assert!(request.contains("Upgrade: websocket\r\n"));
            assert!(request.contains("Connection: Upgrade\r\n"));
            assert!(request.contains("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"));
            stream
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
                )
                .unwrap();
            // Regression guard for accepted sockets inheriting O_NONBLOCK from
            // the listener. The bridge must wait for a delayed upstream frame.
            thread::sleep(Duration::from_millis(150));
            stream.write_all(b"server-frame").unwrap();
        });

        let proxy = LoopbackProxy::start(upstream_port, "user", "pass").unwrap();
        let url = url::Url::parse(&proxy.websocket_url("api/ws?src=camera")).unwrap();
        let mut stream =
            TcpStream::connect((url.host_str().unwrap(), url.port().unwrap_or(80))).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(
            stream,
            "GET {}?{} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
            url.path(),
            url.query().unwrap_or_default()
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 101 Switching Protocols"));
        assert!(response.ends_with("server-frame"));
        upstream.join().unwrap();
    }
}
