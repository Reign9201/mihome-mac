//! Product remote-camera path: Xiaomi cloud provisioning -> CS2 relay -> MISS.
//!
//! Unlike `micam`, this path has no Java subprocess. It still uses ffmpeg for HLS
//! packaging until the VideoToolbox writer is wired in.

use anyhow::{anyhow, Result};
use std::time::Duration;

use crate::auth::Session;
use crate::cloud::MiCloud;
use crate::logging as app_log;
use crate::miss::MissClient;
use crate::pppp::{decode_init_string, Uid};
use crate::relay::RelaySession;
use crate::remote_crypto::KeyPair;

pub struct RemoteCamera {
    pub client: MissClient,
    pub vendor_id: i64,
    pub p2p_id: String,
    pub relay: std::net::SocketAddr,
}

impl RemoteCamera {
    pub async fn open(
        session: &Session,
        did: &str,
        quality: u8,
        audio: bool,
        timeout: Duration,
    ) -> Result<Self> {
        let started = std::time::Instant::now();
        if !(0..=3).contains(&quality) {
            return Err(anyhow!("quality 只能是 0、1、2、3"));
        }
        app_log::info(
            "MISS",
            format!(
                "请求远程通道：did={} quality={quality} audio={audio}",
                app_log::mask_id(did)
            ),
        );
        let keys = KeyPair::generate();
        let cloud = MiCloud::new(session.clone());
        let vendor = cloud.miss_vendor(did, &keys.public_hex).await?;
        app_log::info(
            "MISS",
            format!(
                "云端已返回传输信息：vendor={} p2p={}",
                vendor.vendor_id,
                app_log::mask_id(&vendor.p2p_id)
            ),
        );
        if vendor.vendor_id != 4 {
            return Err(anyhow!(
                "摄像头返回的传输类型是 {}，当前产品通道只支持 CS2",
                vendor.vendor_id
            ));
        }
        if vendor.p2p_id.is_empty() || vendor.device_public.is_empty() || vendor.sign.is_empty() {
            return Err(anyhow!("miss_get_vendor 缺少 p2p_id / public_key / sign"));
        }
        let servers = decode_init_string(&vendor.init_string)?;
        let uid = Uid::parse(&vendor.p2p_id)?;
        let relay = RelaySession::new(uid, servers)?.connect(timeout)?;
        let relay_addr = relay.relay_addr();
        app_log::info(
            "MISS",
            format!(
                "Relay 已连接：{relay_addr} elapsed={}ms",
                started.elapsed().as_millis()
            ),
        );
        let key = keys.session_key(&vendor.device_public)?;
        let client = MissClient::new(relay, key);
        client.authenticate(&keys.public_hex, &vendor.sign, Duration::from_secs(15))?;
        app_log::info(
            "MISS",
            format!(
                "认证完成，请求视频：elapsed={}ms",
                started.elapsed().as_millis()
            ),
        );
        client.start_video(quality, audio)?;
        Ok(Self {
            client,
            vendor_id: vendor.vendor_id,
            p2p_id: vendor.p2p_id,
            relay: relay_addr,
        })
    }

    pub fn next_media(&self, timeout: Duration) -> Result<Option<crate::miss::MediaPacket>> {
        self.client.next_media(timeout)
    }

    pub fn motor(&self, operation: u8) -> Result<()> {
        self.client.motor(operation)
    }
}
