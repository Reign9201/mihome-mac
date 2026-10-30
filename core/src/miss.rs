//! MISS session over a PPPP relay connection.

use anyhow::{anyhow, Result};
use std::time::{Duration, Instant};

use crate::relay::PpppConnection;
use crate::remote_crypto;

pub const CMD_AUTH_REQ: u32 = 0x100;
pub const CMD_AUTH_RES: u32 = 0x101;
pub const CMD_VIDEO_START: u32 = 0x102;
pub const CMD_VIDEO_STOP: u32 = 0x103;
pub const CMD_ENCODED: u32 = 0x1001;
pub const CMD_MOTOR: u32 = 0x112;

pub const CODEC_H264: u32 = 4;
pub const CODEC_H265: u32 = 5;
pub const CODEC_PCMA: u32 = 1027;
pub const CODEC_OPUS: u32 = 1032;

pub struct MissClient {
    conn: PpppConnection,
    key: [u8; 32],
}

#[derive(Debug)]
pub struct MediaPacket {
    pub codec_id: u32,
    pub sequence: u32,
    pub flags: u32,
    pub timestamp_ms: u64,
    pub payload: Vec<u8>,
}

impl MediaPacket {
    pub fn is_keyframe(&self) -> bool {
        self.flags & 1 != 0
    }

    pub fn is_video(&self) -> bool {
        self.codec_id == CODEC_H264 || self.codec_id == CODEC_H265
    }

    pub fn codec_name(&self) -> &'static str {
        match self.codec_id {
            CODEC_H264 => "H264",
            CODEC_H265 => "H265",
            CODEC_PCMA => "PCMA",
            CODEC_OPUS => "OPUS",
            _ => "unknown",
        }
    }
}

impl MissClient {
    pub fn new(conn: PpppConnection, key: [u8; 32]) -> Self {
        Self { conn, key }
    }

    pub fn connection(&self) -> &PpppConnection {
        &self.conn
    }

    /// Authentication is plaintext; only commands after it are encrypted.
    pub fn authenticate(
        &self,
        client_public_hex: &str,
        sign_hex: &str,
        timeout: Duration,
    ) -> Result<String> {
        let uuid = format!(
            "{:016x}-{:04x}-{:04x}-{:04x}-{:012x}",
            rand::random::<u64>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u64>() & 0xffff_ffffffff
        );
        let body = format!(
            "{{\"public_key\":\"{client_public_hex}\", \"sign\":\"{sign_hex}\",\"uuid\":\"{uuid}\",\"support_encrypt\":15}}"
        );
        let deadline = Instant::now() + timeout;
        let mut attempts = 0;
        while Instant::now() < deadline {
            attempts += 1;
            self.conn.send_command(CMD_AUTH_REQ, body.as_bytes())?;
            if let Some((command, data)) = self.await_response(Duration::from_secs(2)) {
                if command == CMD_AUTH_RES {
                    let text = String::from_utf8_lossy(&data).to_string();
                    if !text.contains("\"result\":\"success\"") {
                        return Err(anyhow!("摄像头拒绝认证: {text}"));
                    }
                    return Ok(text);
                }
            }
        }
        Err(anyhow!("{attempts} 次尝试后仍没有认证响应"))
    }

    pub fn send_encrypted(&self, command: u32, json: &str) -> Result<()> {
        let body = json.as_bytes();
        let mut inner = Vec::with_capacity(4 + body.len());
        inner.extend_from_slice(&command.to_be_bytes());
        inner.extend_from_slice(body);
        let encrypted = remote_crypto::encrypt(&self.key, &inner);
        self.conn.send_command(CMD_ENCODED, &encrypted)
    }

    pub fn start_video(&self, quality: u8, audio: bool) -> Result<()> {
        self.send_encrypted(
            CMD_VIDEO_START,
            &format!(
                "{{\"videoquality\":{quality},\"enableaudio\":{}}}",
                if audio { 1 } else { 0 }
            ),
        )
    }

    pub fn stop_video(&self) -> Result<()> {
        self.send_encrypted(CMD_VIDEO_STOP, "")
    }

    /// Xiaomi 摄像头的云台命令是 `{"operation":n}`，不是方向字符串：
    /// 1 左、2 右、3 上、4 下。相机每次命令走一个固定步长。
    pub fn motor(&self, operation: u8) -> Result<()> {
        if !(1..=4).contains(&operation) {
            return Err(anyhow!("当前摄像头协议不支持云台停止命令，请单步操作"));
        }
        self.send_encrypted(CMD_MOTOR, &format!("{{\"operation\":{operation}}}"))
    }

    pub fn next_media(&self, timeout: Duration) -> Result<Option<MediaPacket>> {
        let Some(message) = self.conn.next_media(timeout) else {
            return Ok(None);
        };
        if message.len() < 32 {
            return Err(anyhow!("MISS 媒体消息不足 32 字节"));
        }
        let payload = remote_crypto::decrypt(&self.key, &message[32..])?;
        Ok(Some(MediaPacket {
            codec_id: u32::from_le_bytes([message[4], message[5], message[6], message[7]]),
            sequence: u32::from_le_bytes([message[8], message[9], message[10], message[11]]),
            flags: u32::from_le_bytes([message[12], message[13], message[14], message[15]]),
            timestamp_ms: u64::from_le_bytes([
                message[16],
                message[17],
                message[18],
                message[19],
                message[20],
                message[21],
                message[22],
                message[23],
            ]),
            payload,
        }))
    }

    pub fn await_response(&self, timeout: Duration) -> Option<(u32, Vec<u8>)> {
        let message = self.conn.next_command(timeout)?;
        if message.len() < 4 {
            return None;
        }
        let command = u32::from_be_bytes([message[0], message[1], message[2], message[3]]);
        Some((command, message[4..].to_vec()))
    }
}
