//! Xiaomi CS2 relay handshake and the DRW transport carried over it.
//!
//! The relay path is deliberately used instead of direct hole punching: the target
//! deployment sits behind a symmetric NAT, and the vendor app falls back to the relay
//! as well. Every stage is unacknowledged UDP, so each one is retried.

use anyhow::{anyhow, Context, Result};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::logging as app_log;
use crate::pppp::*;

const SERVER_PORT: u16 = 32100;
const RELAY_PORT: u16 = 25000;
const DISCOVERY_REPEATS: usize = 4;
const SESSION_REPEATS: usize = 24;
const HELLO_ATTEMPTS: usize = 4;
const PORT_ATTEMPTS: usize = 4;
const JOIN_ATTEMPTS: usize = 6;
const COMMAND_QUEUE: usize = 64;
const MEDIA_QUEUE: usize = 64;

pub struct RelaySession {
    uid: Uid,
    servers: Vec<String>,
    socket: UdpSocket,
    relay: Option<SocketAddr>,
    session_token: Option<[u8; 4]>,
    local_ip: Option<std::net::Ipv4Addr>,
}

impl RelaySession {
    pub fn new(uid: Uid, servers: Vec<String>) -> Result<Self> {
        if servers.is_empty() {
            return Err(anyhow!("摄像头没有返回 rendezvous 服务器"));
        }
        let socket = UdpSocket::bind("0.0.0.0:0").context("创建 UDP socket 失败")?;
        socket.set_read_timeout(Some(Duration::from_millis(300)))?;
        let local_ip = discover_local_ip(&servers[0]);
        Ok(Self {
            uid,
            servers,
            socket,
            relay: None,
            session_token: None,
            local_ip,
        })
    }

    fn uid_bytes(&self) -> [u8; UID_LEN] {
        self.uid.encode()
    }

    /// Establish the relay session. Consumes the handshake state and returns a live
    /// `PpppConnection` that owns the same UDP socket.
    pub fn connect(mut self, timeout: Duration) -> Result<PpppConnection> {
        let deadline = Instant::now() + timeout;
        let mut last_failure = "等待 relay 超时".to_string();
        let started = Instant::now();
        while Instant::now() < deadline {
            let candidates = match self.discover_relays(deadline) {
                Ok(value) if !value.is_empty() => value,
                Ok(_) => {
                    last_failure = "摄像头没有返回 relay 候选".to_string();
                    continue;
                }
                Err(error) => {
                    last_failure = error.to_string();
                    continue;
                }
            };
            let chosen = match self.greet_relays(&candidates, deadline) {
                Some(value) => value,
                None => {
                    last_failure = "relay 没有接受注册".to_string();
                    continue;
                }
            };
            app_log::info(
                "Relay",
                format!("发现 {} 个候选，已选择 {chosen}", candidates.len()),
            );
            if !self.allocate_session_port(chosen, deadline)? {
                last_failure = "relay 没有分配会话端口".to_string();
                continue;
            }
            if !self.await_device_join(deadline)? {
                last_failure = "摄像头没有加入 relay".to_string();
                continue;
            }
            let relay = self.relay.ok_or_else(|| anyhow!("relay 地址丢失"))?;
            let local_ip = self
                .local_ip
                .unwrap_or_else(|| std::net::Ipv4Addr::new(0, 0, 0, 0));
            let local = SocketAddr::from((local_ip, self.socket.local_addr()?.port()));
            app_log::info(
                "Relay",
                format!(
                    "设备加入完成：relay={relay} local={local} elapsed={}ms",
                    started.elapsed().as_millis()
                ),
            );
            return PpppConnection::start(self.socket, relay, local);
        }
        app_log::error(
            "Relay",
            format!(
                "Relay 建立失败：{last_failure} elapsed={}ms",
                started.elapsed().as_millis()
            ),
        );
        Err(anyhow!("建立 relay 失败：{last_failure}"))
    }

    fn send(&self, to: SocketAddr, kind: u8, payload: &[u8]) -> Result<()> {
        self.socket
            .send_to(&encode_frame(kind, payload), to)
            .with_context(|| format!("发送 PPPP 帧到 {to} 失败"))?;
        Ok(())
    }

    fn receive(&self, deadline: Instant) -> Option<(u8, Vec<u8>, SocketAddr)> {
        let mut buf = [0u8; 4096];
        loop {
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            let wait = (deadline - now).min(Duration::from_millis(300));
            self.socket.set_read_timeout(Some(wait)).ok()?;
            match self.socket.recv_from(&mut buf) {
                Ok((len, from)) => {
                    if let Some((kind, payload)) = parse_frame(&buf[..len]) {
                        return Some((kind, payload.to_vec(), from));
                    }
                }
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    continue;
                }
                Err(_) => return None,
            }
        }
    }

    fn discover_relays(&self, deadline: Instant) -> Result<BTreeMap<SocketAddr, Vec<[u8; 4]>>> {
        let uid = self.uid_bytes();
        for server in &self.servers {
            let addr: SocketAddr = format!("{server}:{SERVER_PORT}")
                .parse()
                .with_context(|| format!("rendezvous 地址无效: {server}"))?;
            self.send(addr, MSG_LIST_REQ1, &uid)?;
        }
        let hard_stop = (Instant::now() + Duration::from_millis(2500)).min(deadline);
        // The first RLY_TO usually arrives in a few hundred milliseconds. Once one
        // relay answers, keep a short quiet window for other candidates instead of
        // burning the full 2.5 s on every camera open.
        let mut quiet_stop = hard_stop;
        let mut out: BTreeMap<SocketAddr, Vec<[u8; 4]>> = BTreeMap::new();
        while let Some((kind, payload, _)) = self.receive(quiet_stop) {
            if kind != MSG_RLY_TO || payload.len() < 20 {
                continue;
            }
            let addr = AddrBlock::decode(&payload, 0)?.socket_addr();
            let mut token = [0u8; 4];
            token.copy_from_slice(&payload[16..20]);
            let entry = out.entry(addr).or_default();
            if !entry.contains(&token) {
                entry.push(token);
            }
            quiet_stop = (Instant::now() + Duration::from_millis(600)).min(hard_stop);
        }
        Ok(out)
    }

    fn register(&self, addr: SocketAddr, tokens: &[[u8; 4]]) -> Result<()> {
        let uid = self.uid_bytes();
        for token in tokens {
            let mut body = Vec::with_capacity(28);
            body.extend_from_slice(token);
            body.extend_from_slice(&uid);
            body.extend_from_slice(&[0, 0, 0, 0]);
            for _ in 0..DISCOVERY_REPEATS {
                self.send(addr, MSG_RLY_PKT, &body)?;
            }
        }
        Ok(())
    }

    fn greet_relays(
        &mut self,
        candidates: &BTreeMap<SocketAddr, Vec<[u8; 4]>>,
        deadline: Instant,
    ) -> Option<SocketAddr> {
        for _ in 0..HELLO_ATTEMPTS {
            for (addr, tokens) in candidates {
                let _ = self.register(*addr, tokens);
            }
            for addr in candidates.keys() {
                let _ = self.send(*addr, MSG_RLY_HELLO, &[]);
            }
            let stop = (Instant::now() + Duration::from_millis(2500)).min(deadline);
            while let Some((kind, _, from)) = self.receive(stop) {
                if kind == MSG_RLY_HELLO_ACK {
                    return Some(SocketAddr::new(from.ip(), RELAY_PORT));
                }
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        None
    }

    fn allocate_session_port(&mut self, chosen: SocketAddr, deadline: Instant) -> Result<bool> {
        for _ in 0..PORT_ATTEMPTS {
            self.send(chosen, MSG_RLY_PORT, &[])?;
            let stop = (Instant::now() + Duration::from_secs(2)).min(deadline);
            while let Some((kind, payload, _)) = self.receive(stop) {
                if kind == MSG_RLY_PORT_ACK && payload.len() >= 6 {
                    let mut token = [0u8; 4];
                    token.copy_from_slice(&payload[..4]);
                    self.session_token = Some(token);
                    let port = u16::from_be_bytes([payload[4], payload[5]]);
                    self.relay = Some(SocketAddr::new(chosen.ip(), port));
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn await_device_join(&self, deadline: Instant) -> Result<bool> {
        let relay = self.relay.ok_or_else(|| anyhow!("relay 地址丢失"))?;
        let token = self
            .session_token
            .ok_or_else(|| anyhow!("session token 丢失"))?;
        let uid = self.uid_bytes();
        let addr = AddrBlock::from_socket(relay)?.encode();
        let mut request = Vec::with_capacity(UID_LEN + ADDR_LEN + 4);
        request.extend_from_slice(&uid);
        request.extend_from_slice(&addr);
        request.extend_from_slice(&token);

        let mut keepalive = Vec::with_capacity(28);
        keepalive.extend_from_slice(&token);
        keepalive.extend_from_slice(&uid);
        keepalive.extend_from_slice(&[0, 0, 0, 0]);
        let keepalive = encode_frame(MSG_RLY_PKT, &keepalive);

        for _ in 0..JOIN_ATTEMPTS {
            if Instant::now() >= deadline {
                break;
            }
            for server in &self.servers {
                let target: SocketAddr = format!("{server}:{SERVER_PORT}").parse()?;
                self.send(target, MSG_RLY_REQ, &request)?;
            }
            for _ in 0..SESSION_REPEATS {
                self.socket.send_to(&keepalive, relay)?;
            }
            let stop = (Instant::now() + Duration::from_secs(2)).min(deadline);
            while let Some((kind, _, _from)) = self.receive(stop) {
                if kind == MSG_RLY_RDY {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

fn discover_local_ip(server: &str) -> Option<std::net::Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    let target: SocketAddr = format!("{server}:{SERVER_PORT}").parse().ok()?;
    socket.connect(target).ok()?;
    match socket.local_addr().ok()? {
        SocketAddr::V4(v4) => Some(*v4.ip()),
        _ => None,
    }
}

/// A live PPPP connection. The receive thread handles acknowledgements, keepalives
/// and the relay's 0x28 linking request even when nobody is reading media.
pub struct PpppConnection {
    socket: Arc<UdpSocket>,
    relay: SocketAddr,
    local: SocketAddr,
    running: Arc<AtomicBool>,
    seq: Mutex<u16>,
    commands: Mutex<Receiver<Vec<u8>>>,
    media: Mutex<Receiver<Vec<u8>>>,
}

impl PpppConnection {
    fn start(socket: UdpSocket, relay: SocketAddr, local: SocketAddr) -> Result<Self> {
        let socket = Arc::new(socket);
        socket.set_read_timeout(Some(Duration::from_millis(500)))?;
        let (command_tx, command_rx) = mpsc::sync_channel(COMMAND_QUEUE);
        let (media_tx, media_rx) = mpsc::sync_channel(MEDIA_QUEUE);
        let running = Arc::new(AtomicBool::new(true));
        let rx_socket = socket.clone();
        let rx_running = running.clone();
        let rx_local = local;
        let rx_relay = relay;
        thread::Builder::new()
            .name("pppp-rx".to_string())
            .spawn(move || {
                receive_loop(
                    rx_socket, rx_running, rx_relay, rx_local, command_tx, media_tx,
                )
            })
            .context("启动 PPPP 接收线程失败")?;
        Ok(Self {
            socket,
            relay,
            local,
            running,
            seq: Mutex::new(0),
            commands: Mutex::new(command_rx),
            media: Mutex::new(media_rx),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    pub fn relay_addr(&self) -> SocketAddr {
        self.relay
    }

    pub fn send_command(&self, command: u32, body: &[u8]) -> Result<()> {
        let mut message = Vec::with_capacity(8 + body.len());
        let total = 4 + body.len() as u32;
        message.extend_from_slice(&total.to_be_bytes());
        message.extend_from_slice(&command.to_be_bytes());
        message.extend_from_slice(body);

        let mut seq = self.seq.lock().map_err(|_| anyhow!("序号锁损坏"))?;
        let mut payload = Vec::with_capacity(4 + message.len());
        payload.extend_from_slice(&[0xD1, 0]);
        payload.extend_from_slice(&seq.to_be_bytes());
        payload.extend_from_slice(&message);
        *seq = seq.wrapping_add(1);
        drop(seq);

        self.socket
            .send_to(&encode_frame(MSG_DRW, &payload), self.relay)?;
        Ok(())
    }

    pub fn next_command(&self, timeout: Duration) -> Option<Vec<u8>> {
        self.commands.lock().ok()?.recv_timeout(timeout).ok()
    }

    pub fn next_media(&self, timeout: Duration) -> Option<Vec<u8>> {
        self.media.lock().ok()?.recv_timeout(timeout).ok()
    }
}

impl Drop for PpppConnection {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        let _ = self
            .socket
            .send_to(&encode_frame(MSG_CLOSE, &[]), self.relay);
    }
}

fn receive_loop(
    socket: Arc<UdpSocket>,
    running: Arc<AtomicBool>,
    relay: SocketAddr,
    local: SocketAddr,
    commands: SyncSender<Vec<u8>>,
    media: SyncSender<Vec<u8>>,
) {
    let mut command_channel = DataChannel::new();
    let mut media_channel = DataChannel::new();
    let mut buf = vec![0u8; usize::from(u16::MAX) + FRAME_HEADER];
    while running.load(Ordering::SeqCst) {
        let (len, from) = match socket.recv_from(&mut buf) {
            Ok(value) => value,
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                continue;
            }
            Err(_) => break,
        };
        if from.ip() != relay.ip() {
            continue;
        }
        let Some((kind, payload)) = parse_frame(&buf[..len]) else {
            continue;
        };
        match kind {
            MSG_DRW => {
                if payload.len() < 4 || payload[0] != 0xD1 {
                    continue;
                }
                let channel = payload[1];
                let seq = u16::from_be_bytes([payload[2], payload[3]]);
                let _ = socket.send_to(
                    &encode_frame(MSG_DRW_ACK, &[0xD1, channel, 0, 1, payload[2], payload[3]]),
                    relay,
                );
                let target = match channel {
                    0 => &mut command_channel,
                    2 => &mut media_channel,
                    _ => continue,
                };
                if target.push(seq, &payload[4..]).is_err() {
                    running.store(false, Ordering::SeqCst);
                    break;
                }
                let queue = if channel == 0 { &commands } else { &media };
                while let Some(message) = target.poll() {
                    match queue.try_send(message) {
                        Ok(()) | Err(TrySendError::Disconnected(_)) => {}
                        Err(TrySendError::Full(message)) => {
                            target.requeue(message);
                            break;
                        }
                    }
                }
            }
            MSG_ALIVE => {
                let _ = socket.send_to(&encode_frame(MSG_ALIVE_ACK, &[]), relay);
            }
            MSG_MISS_SETUP => {
                if let Ok(reply) = miss_setup_reply(payload, local) {
                    let _ = socket.send_to(&encode_frame(MSG_MISS_SETUP, &reply), relay);
                }
            }
            MSG_CLOSE => break,
            _ => {}
        }
    }
}
