//! Small PPPP/CS2 pieces shared by the relay and MISS session.
//!
//! Wire format: `F1 <type> <len:u16 BE> <payload>`. Xiaomi's deployment does not
//! use the optional PSK layer, so frames are plaintext.

use anyhow::{anyhow, Result};
use std::collections::{BTreeMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

pub const FRAME_MAGIC: u8 = 0xF1;
pub const FRAME_HEADER: usize = 4;
pub const UID_LEN: usize = 20;
pub const ADDR_LEN: usize = 16;

pub const MSG_DRW: u8 = 0xD0;
pub const MSG_DRW_ACK: u8 = 0xD1;
pub const MSG_ALIVE: u8 = 0xE0;
pub const MSG_ALIVE_ACK: u8 = 0xE1;
pub const MSG_MISS_SETUP: u8 = 0x28;
pub const MSG_CLOSE: u8 = 0xF0;
pub const MSG_LIST_REQ1: u8 = 0x67;
pub const MSG_RLY_TO: u8 = 0x82;
pub const MSG_RLY_HELLO: u8 = 0x70;
pub const MSG_RLY_HELLO_ACK: u8 = 0x71;
pub const MSG_RLY_PORT: u8 = 0x72;
pub const MSG_RLY_PORT_ACK: u8 = 0x73;
pub const MSG_RLY_REQ: u8 = 0x80;
pub const MSG_RLY_REQ_ACK: u8 = 0x81;
pub const MSG_RLY_PKT: u8 = 0x83;
pub const MSG_RLY_RDY: u8 = 0x84;

pub fn encode_frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_HEADER + payload.len());
    out.push(FRAME_MAGIC);
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn parse_frame(bytes: &[u8]) -> Option<(u8, &[u8])> {
    if bytes.len() < FRAME_HEADER || bytes[0] != FRAME_MAGIC {
        return None;
    }
    let declared = u16::from_be_bytes([bytes[2], bytes[3]]) as usize;
    if declared > bytes.len() - FRAME_HEADER {
        return None;
    }
    Some((bytes[1], &bytes[FRAME_HEADER..FRAME_HEADER + declared]))
}

#[derive(Debug, Clone)]
pub struct Uid {
    pub prefix: String,
    pub serial: u32,
    pub check: String,
}

impl Uid {
    pub fn parse(text: &str) -> Result<Self> {
        let parts: Vec<&str> = text.trim().split('-').collect();
        if parts.len() != 3 {
            return Err(anyhow!("P2P ID 格式应为 PREFIX-SERIAL-CHECK: {text}"));
        }
        Ok(Self {
            prefix: parts[0].to_string(),
            serial: parts[1].parse()?,
            check: parts[2].to_string(),
        })
    }

    pub fn encode(&self) -> [u8; UID_LEN] {
        let mut out = [0u8; UID_LEN];
        let prefix = self.prefix.as_bytes();
        let check = self.check.as_bytes();
        let p = prefix.len().min(8);
        let c = check.len().min(8);
        out[..p].copy_from_slice(&prefix[..p]);
        out[8..12].copy_from_slice(&self.serial.to_be_bytes());
        out[12..12 + c].copy_from_slice(&check[..c]);
        out
    }
}

impl std::fmt::Display for Uid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}-{}-{}", self.prefix, self.serial, self.check)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AddrBlock {
    pub ip: Ipv4Addr,
    pub port: u16,
}

impl AddrBlock {
    pub fn from_socket(addr: SocketAddr) -> Result<Self> {
        match addr {
            SocketAddr::V4(v4) => Ok(Self {
                ip: *v4.ip(),
                port: v4.port(),
            }),
            SocketAddr::V6(_) => Err(anyhow!("PPPP 只接受 IPv4 地址")),
        }
    }

    pub fn encode(&self) -> [u8; ADDR_LEN] {
        let mut out = [0u8; ADDR_LEN];
        out[0] = 0x00;
        out[1] = 0x02;
        out[2..4].copy_from_slice(&self.port.to_le_bytes());
        let octets = self.ip.octets();
        for i in 0..4 {
            out[4 + i] = octets[3 - i];
        }
        out
    }

    pub fn decode(bytes: &[u8], offset: usize) -> Result<Self> {
        if bytes.len() < offset + ADDR_LEN {
            return Err(anyhow!("地址块长度不足"));
        }
        let port = u16::from_le_bytes([bytes[offset + 2], bytes[offset + 3]]);
        let ip = Ipv4Addr::new(
            bytes[offset + 7],
            bytes[offset + 6],
            bytes[offset + 5],
            bytes[offset + 4],
        );
        Ok(Self { ip, port })
    }

    pub fn socket_addr(&self) -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(self.ip, self.port))
    }

    pub fn compact(&self) -> [u8; 8] {
        let mut out = [0u8; 8];
        out[0] = 0x02;
        out[1] = 0x00;
        out[2..4].copy_from_slice(&self.port.to_be_bytes());
        out[4..8].copy_from_slice(&self.ip.octets());
        out
    }
}

/// Decode the obfuscated rendezvous server list. The trailing comma in the plaintext
/// is part of the format, not a typo.
pub fn decode_init_string(encoded: &str) -> Result<Vec<String>> {
    const LUT: [u8; 54] = [
        0x49, 0x59, 0x43, 0x3d, 0xb5, 0xbf, 0x6d, 0xa3, 0x47, 0x53, 0x4f, 0x61, 0x65, 0xe3, 0x71,
        0xe9, 0x67, 0x7f, 0x02, 0x03, 0x0b, 0xad, 0xb3, 0x89, 0x2b, 0x2f, 0x35, 0xc1, 0x6b, 0x8b,
        0x95, 0x97, 0x11, 0xe5, 0xa7, 0x0d, 0xef, 0xf1, 0x05, 0x07, 0x83, 0xfb, 0x9d, 0x3b, 0xc5,
        0xc7, 0x13, 0x17, 0x1d, 0x1f, 0x25, 0x29, 0xd3, 0xdf,
    ];
    let head = encoded.split(':').next().unwrap_or("");
    if !head.len().is_multiple_of(2) {
        return Err(anyhow!("init_string 长度不是偶数"));
    }
    let mut out = Vec::with_capacity(head.len() / 2);
    for i in 0..head.len() / 2 {
        let hi = head.as_bytes()[2 * i]
            .checked_sub(b'A')
            .ok_or_else(|| anyhow!("init_string 字符越界"))?;
        let lo = head.as_bytes()[2 * i + 1]
            .checked_sub(b'A')
            .ok_or_else(|| anyhow!("init_string 字符越界"))?;
        if hi >= 16 || lo >= 16 {
            return Err(anyhow!("init_string 字符越界"));
        }
        let mut running = 0x39u8;
        for byte in &out {
            running ^= byte;
        }
        out.push(running ^ LUT[i % LUT.len()] ^ (hi * 16 + lo));
    }
    let text = String::from_utf8(out)?;
    Ok(text
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect())
}

/// The relay's 0x28 linking request and the deterministic reply.
pub fn miss_setup_reply(request: &[u8], local: SocketAddr) -> Result<Vec<u8>> {
    if request.len() < 88 || request[0] != 0xA1 || request[1] != 0x01 {
        return Err(anyhow!("不是 0x28 请求"));
    }
    let mut out = request.to_vec();
    out[1] = 0x02;
    out[56..60].copy_from_slice(&[0xFE, 0xFF, 0xFF, 0xFF]);
    for i in 0..4 {
        out[60 + i] = request[4 + 3 - i];
    }
    let local_block = AddrBlock::from_socket(local)?.encode();
    out[64..80].copy_from_slice(&local_block);
    let external = AddrBlock::decode(request, 40)?;
    out[80..88].copy_from_slice(&external.compact());
    Ok(out)
}

#[derive(Debug, Default)]
pub struct DataChannel {
    expected: u16,
    pending: BTreeMap<u16, Vec<u8>>,
    pending_bytes: usize,
    chunks: VecDeque<Vec<u8>>,
    head: usize,
    available: usize,
    messages: VecDeque<Vec<u8>>,
    queued_bytes: usize,
}

const MAX_PENDING_FRAGMENTS: usize = 256;
const MAX_PENDING_BYTES: usize = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_QUEUED_MESSAGES: usize = 64;
const MAX_BUFFERED_BYTES: usize = 16 * 1024 * 1024;
const MAX_QUEUED_BYTES: usize = 16 * 1024 * 1024;

impl DataChannel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Accept one DRW fragment. Returns true when it advanced the stream.
    pub fn push(&mut self, seq: u16, data: &[u8]) -> Result<bool> {
        let distance = seq.wrapping_sub(self.expected);
        if distance & 0x8000 != 0 {
            return Ok(false);
        }
        if distance != 0 {
            if self.pending.contains_key(&seq) {
                return Ok(false);
            }
            if self.pending.len() >= MAX_PENDING_FRAGMENTS
                || self.pending_bytes + data.len() > MAX_PENDING_BYTES
            {
                return Err(anyhow!("PPPP 乱序缓存超过上限"));
            }
            self.pending_bytes += data.len();
            self.pending.insert(seq, data.to_vec());
            return Ok(false);
        }
        self.append(data)?;
        self.expected = self.expected.wrapping_add(1);
        while let Some(next) = self.pending.remove(&self.expected) {
            self.pending_bytes = self.pending_bytes.saturating_sub(next.len());
            self.append(&next)?;
            self.expected = self.expected.wrapping_add(1);
        }
        self.extract()?;
        Ok(true)
    }

    pub fn poll(&mut self) -> Option<Vec<u8>> {
        let message = self.messages.pop_front()?;
        self.queued_bytes = self.queued_bytes.saturating_sub(message.len());
        Some(message)
    }

    pub fn requeue(&mut self, message: Vec<u8>) {
        self.queued_bytes = self.queued_bytes.saturating_add(message.len());
        self.messages.push_front(message);
    }

    fn append(&mut self, data: &[u8]) -> Result<()> {
        if !data.is_empty() {
            if data.len() > MAX_BUFFERED_BYTES.saturating_sub(self.available) {
                return Err(anyhow!("PPPP 缓冲区超过上限"));
            }
            self.chunks.push_back(data.to_vec());
            self.available += data.len();
        }
        Ok(())
    }

    fn extract(&mut self) -> Result<()> {
        while self.available >= 4 && self.messages.len() < MAX_QUEUED_MESSAGES {
            let length = self.peek_u32() as usize;
            if length > MAX_MESSAGE_BYTES {
                return Err(anyhow!("PPPP 消息长度超过上限：{length}"));
            }
            if length > MAX_QUEUED_BYTES.saturating_sub(self.queued_bytes) {
                return Ok(());
            }
            if self.available < 4 + length {
                return Ok(());
            }
            self.skip(4);
            let message = self.read(length);
            self.queued_bytes += message.len();
            self.messages.push_back(message);
        }
        Ok(())
    }

    fn peek_u32(&self) -> u32 {
        let mut value = 0u32;
        let mut remaining = 4;
        let mut offset = self.head;
        for chunk in &self.chunks {
            for &byte in &chunk[offset..] {
                if remaining == 0 {
                    break;
                }
                value = (value << 8) | byte as u32;
                remaining -= 1;
            }
            if remaining == 0 {
                break;
            }
            offset = 0;
        }
        value
    }

    fn skip(&mut self, mut n: usize) {
        while n > 0 {
            let chunk = self.chunks.front().expect("available bytes imply a chunk");
            let in_chunk = chunk.len() - self.head;
            if in_chunk > n {
                self.head += n;
                self.available -= n;
                return;
            }
            self.chunks.pop_front();
            self.head = 0;
            self.available -= in_chunk;
            n -= in_chunk;
        }
    }

    fn read(&mut self, mut n: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(n);
        while n > 0 {
            let chunk = self.chunks.front().expect("available bytes imply a chunk");
            let in_chunk = chunk.len() - self.head;
            let take = in_chunk.min(n);
            out.extend_from_slice(&chunk[self.head..self.head + take]);
            self.available -= take;
            if take == in_chunk {
                self.chunks.pop_front();
                self.head = 0;
            } else {
                self.head += take;
            }
            n -= take;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_truncated_frames() {
        assert!(parse_frame(&[FRAME_MAGIC, MSG_ALIVE, 0, 4, 1]).is_none());
    }

    #[test]
    fn caps_out_of_order_packets() {
        let mut channel = DataChannel::new();
        for seq in 1..=MAX_PENDING_FRAGMENTS as u16 {
            channel.push(seq, &[seq as u8]).unwrap();
        }
        assert!(channel
            .push(MAX_PENDING_FRAGMENTS as u16 + 1, &[0])
            .is_err());
    }

    #[test]
    fn rejects_oversized_message_length() {
        let mut channel = DataChannel::new();
        let length = (MAX_MESSAGE_BYTES as u32 + 1).to_be_bytes();
        channel.append(&length).unwrap();
        assert!(channel.extract().is_err());
    }

    #[test]
    fn requeues_messages_without_losing_data() {
        let mut channel = DataChannel::new();
        channel.requeue(vec![1, 2, 3]);
        assert_eq!(channel.poll(), Some(vec![1, 2, 3]));
        assert_eq!(channel.queued_bytes, 0);
    }
}
