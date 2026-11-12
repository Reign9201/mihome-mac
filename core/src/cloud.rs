use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::auth::Session;

const HOMES_CACHE_TTL: Duration = Duration::from_secs(30);
// LAN addresses from `/home/device_list` change rarely. Remote-only cameras
// have no address, so without a cache every camera-page visit re-downloaded
// the whole account device list. A stale address only costs one local attempt
// before the UI falls back to the remote channel.
const NETWORK_CACHE_TTL: Duration = Duration::from_secs(300);

type DeviceNetwork = std::collections::HashMap<String, (String, Option<String>)>;
// At startup the device list and the camera list are read at the same time and
// both page through every home's devices. Concurrent callers for one home wait
// for a single fetch, and its result is reused for a few seconds; the 15 s
// presence sync still always sees fresh data.
const HOME_DEVICES_CACHE_TTL: Duration = Duration::from_secs(3);

type HomeDevicesSlot = Arc<Mutex<Option<(Instant, Vec<Value>)>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Home {
    pub id: String,
    pub name: String,
    pub uid: i64,
    pub shared: bool,
    pub room_count: usize,
    pub rooms: Vec<Room>,
    #[serde(skip_serializing, default)]
    pub dids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Room {
    pub id: String,
    pub name: String,
    pub dids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub home_id: String,
    #[serde(skip_serializing)]
    pub raw: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub did: String,
    pub name: String,
    pub model: String,
    pub home_id: String,
    pub room_id: Option<String>,
    pub room_name: Option<String>,
    pub online: bool,
    pub spec_type: Option<String>,
    pub parent_id: Option<String>,
    #[serde(skip_serializing)]
    pub raw: Value,
}

#[derive(Clone)]
pub struct MiCloud {
    session: Session,
    homes_cache: Arc<Mutex<Option<CachedHomes>>>,
    network_cache: Arc<Mutex<Option<(Instant, DeviceNetwork)>>>,
    home_devices_cache: Arc<Mutex<std::collections::HashMap<String, HomeDevicesSlot>>>,
}

struct CachedHomes {
    fetched_at: Instant,
    homes: Vec<Home>,
}

#[derive(Debug, Clone)]
pub struct MissProvision {
    pub vendor_id: i64,
    pub p2p_id: String,
    pub init_string: String,
    pub device_public: String,
    pub sign: String,
}

impl MiCloud {
    pub fn new(session: Session) -> Self {
        Self {
            session,
            homes_cache: Arc::new(Mutex::new(None)),
            network_cache: Arc::new(Mutex::new(None)),
            home_devices_cache: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub async fn homes(&self) -> Result<Vec<Home>> {
        if let Some(cached) = self.homes_cache.lock().await.as_ref() {
            if cached.fetched_at.elapsed() < HOMES_CACHE_TTL {
                return Ok(cached.homes.clone());
            }
        }
        let result = self
            .session
            .request(
                "/v2/homeroom/gethome_merged",
                json!({"fg": true, "fetch_share": true, "fetch_share_dev": true, "fetch_cariot": true, "limit": 300, "app_ver": 7, "plat_form": 0}),
            )
            .await?;
        let has_home_list = ["homelist", "home_list", "share_home_list"]
            .iter()
            .any(|key| result.get(*key).and_then(Value::as_array).is_some());
        if !has_home_list {
            return Err(anyhow!("家庭列表格式异常"));
        }
        let homes = parse_homes(&result);
        *self.homes_cache.lock().await = Some(CachedHomes {
            fetched_at: Instant::now(),
            homes: homes.clone(),
        });
        Ok(homes)
    }

    pub async fn devices(&self, home_id: Option<&str>) -> Result<Vec<Device>> {
        let homes = self.homes().await?;
        let targets: Vec<&Home> = match home_id {
            Some(id) => homes.iter().filter(|h| h.id == id).collect(),
            None => homes.iter().collect(),
        };
        if targets.is_empty() {
            return Err(anyhow!("没有找到家庭 {home_id:?}"));
        }
        let mut result = Vec::new();
        let mut seen_dids = std::collections::HashSet::new();
        let mut contexts = std::collections::HashMap::new();
        let mut request_succeeded = false;
        let mut request_failures = 0usize;
        for home in targets {
            let mut room_by_did = std::collections::HashMap::new();
            for room in &home.rooms {
                for did in &room.dids {
                    room_by_did.insert(did.clone(), (room.id.clone(), room.name.clone()));
                }
            }
            for (did, fallback) in home_did_entries(home) {
                contexts
                    .entry(did)
                    .or_insert_with(|| (home.id.clone(), fallback));
            }
            match self.home_devices(home).await {
                Ok(info) => {
                    request_succeeded = true;
                    for item in info {
                        let did = value_text(&item["did"]);
                        if did.is_empty() || !seen_dids.insert(did.clone()) {
                            continue;
                        }
                        let fallback = room_by_did.get(&did).cloned();
                        result.push(map_device(&item, &home.id, fallback));
                    }
                }
                Err(error) => {
                    request_failures += 1;
                    crate::logging::warn(
                        "Cloud",
                        format!(
                            "读取家庭「{}」设备失败，将继续尝试按 DID 补查：{error:#}",
                            home.name
                        ),
                    );
                }
            }
        }

        let mut missing: Vec<String> = contexts
            .keys()
            .filter(|did| !seen_dids.contains(*did))
            .cloned()
            .collect();
        missing.sort();
        for chunk in missing.chunks(150) {
            match self
                .query_paged_devices(
                    "/v2/home/device_list_page",
                    json!({
                        "limit": 200,
                        "get_split_device": true,
                        "support_smart_home": true,
                        "get_third_device": true,
                        "dids": chunk
                    }),
                )
                .await
            {
                Ok(info) => {
                    request_succeeded = true;
                    for item in info {
                        let did = value_text(&item["did"]);
                        if did.is_empty() || !seen_dids.insert(did.clone()) {
                            continue;
                        }
                        let Some((home_id, fallback)) = contexts.get(&did) else {
                            continue;
                        };
                        result.push(map_device(&item, home_id, fallback.clone()));
                    }
                }
                Err(error) => {
                    request_failures += 1;
                    crate::logging::warn(
                        "Cloud",
                        format!(
                            "共享设备按 DID 补查失败（{} 个），已跳过该批：{error:#}",
                            chunk.len()
                        ),
                    );
                }
            }
        }
        let unresolved = contexts
            .keys()
            .filter(|did| !seen_dids.contains(*did))
            .count();
        if unresolved > 0 {
            crate::logging::info(
                "Cloud",
                format!("有 {unresolved} 个房间 DID 未解析到设备，可能是红外遥控器或已移除设备"),
            );
        }
        if !request_succeeded && request_failures > 0 {
            return Err(anyhow!("读取设备失败，请查看诊断日志"));
        }
        Ok(result)
    }

    async fn home_devices(&self, home: &Home) -> Result<Vec<Value>> {
        let slot = self
            .home_devices_cache
            .lock()
            .await
            .entry(home.id.clone())
            .or_default()
            .clone();
        let mut cached = slot.lock().await;
        if let Some((fetched_at, devices)) = cached.as_ref() {
            if fetched_at.elapsed() < HOME_DEVICES_CACHE_TTL {
                return Ok(devices.clone());
            }
        }
        let devices = self.fetch_home_devices(home).await?;
        *cached = Some((Instant::now(), devices.clone()));
        Ok(devices)
    }

    async fn fetch_home_devices(&self, home: &Home) -> Result<Vec<Value>> {
        let numeric_home_id: u64 = home
            .id
            .parse()
            .with_context(|| format!("家庭 ID 不是数字: {}", home.id))?;
        let owner_uid = if home.uid != 0 {
            home.uid
        } else {
            self.session.user_id.parse().unwrap_or(0)
        };
        let body = json!({
            "home_owner": owner_uid,
            "home_id": numeric_home_id,
            "limit": 200,
            "get_split_device": true,
            "support_smart_home": true,
            "get_cariot_device": true,
            "get_third_device": true
        });
        let mut last_error = None;
        for endpoint in ["/home/home_device_list", "/v2/home/home_device_list"] {
            match self.query_paged_devices(endpoint, body.clone()).await {
                Ok(devices) => return Ok(devices),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow!("家庭设备接口不可用")))
    }

    async fn query_paged_devices(&self, endpoint: &str, mut body: Value) -> Result<Vec<Value>> {
        let mut devices = Vec::new();
        let mut start_did = String::new();
        let mut seen_cursors = std::collections::HashSet::new();
        for _ in 0..1000 {
            if !start_did.is_empty() {
                body["start_did"] = Value::String(start_did.clone());
            }
            let data = self.session.request(endpoint, body.clone()).await?;
            devices.extend(device_items(&data));
            let has_more = data.get("has_more").map(value_bool).unwrap_or(false);
            let next = ["next_start_did", "max_did"]
                .iter()
                .map(|key| value_text(&data[*key]))
                .find(|value| !value.is_empty())
                .unwrap_or_default();
            if !has_more || next.is_empty() {
                return Ok(devices);
            }
            if !seen_cursors.insert(next.clone()) {
                return Err(anyhow!("设备分页游标重复"));
            }
            start_did = next;
        }
        Err(anyhow!("设备分页超过 1000 页，已停止请求"))
    }

    pub async fn scenes(&self, home_id: &str) -> Result<Vec<Scene>> {
        let homes = self.homes().await?;
        let home = homes
            .iter()
            .find(|home| home.id == home_id)
            .ok_or_else(|| anyhow!("没有找到家庭 {home_id:?}"))?;
        let result = self
            .session
            .request(
                "/appgateway/miot/appsceneservice/AppSceneService/GetSimpleSceneList",
                json!({"app_version": 12, "get_type": 2, "home_id": home.id, "owner_uid": home.uid}),
            )
            .await?;
        let list = result
            .get("manual_scene_info_list")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(list
            .iter()
            .map(|scene| Scene {
                id: value_text(&scene["scene_id"]),
                name: scene["name"].as_str().unwrap_or("未命名场景").to_string(),
                home_id: home.id.clone(),
                raw: scene.clone(),
            })
            .collect())
    }

    pub async fn run_scene(&self, scene_id: &str, home_id: &str) -> Result<Value> {
        let homes = self.homes().await?;
        let home = homes
            .iter()
            .find(|home| home.id == home_id)
            .ok_or_else(|| anyhow!("没有找到家庭 {home_id:?}"))?;
        self.session
            .request(
                "/appgateway/miot/appsceneservice/AppSceneService/NewRunScene",
                json!({
                    "scene_id": scene_id,
                    "scene_type": 2,
                    "phone_id": "null",
                    "home_id": home.id,
                    "owner_uid": home.uid
                }),
            )
            .await
    }

    pub fn user_id(&self) -> &str {
        &self.session.user_id
    }

    pub fn pass_token(&self) -> &str {
        &self.session.pass_token
    }

    pub async fn cameras(&self) -> Result<Vec<crate::CameraDevice>> {
        let devices = self.devices(None).await?;
        let needs_network = devices.iter().any(|device| {
            device.model.contains("camera")
                && device
                    .raw
                    .get("localip")
                    .and_then(Value::as_str)
                    .map(|ip| ip.is_empty())
                    .unwrap_or(true)
        });
        let network = if needs_network {
            self.cached_device_network().await
        } else {
            std::collections::HashMap::new()
        };
        Ok(devices
            .into_iter()
            .filter_map(|device| {
                let mut raw = device.raw.clone();
                if let Some(info) = network.get(&device.did) {
                    if raw
                        .get("localip")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .is_empty()
                    {
                        raw["localip"] = Value::String(info.0.clone());
                    }
                    if info.1.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
                        raw["token"] = Value::String(info.1.clone().unwrap_or_default());
                    }
                }
                crate::camera::camera_from_raw(
                    device.did,
                    device.name,
                    device.model,
                    device.online,
                    &raw,
                )
            })
            .collect())
    }

    async fn cached_device_network(&self) -> DeviceNetwork {
        if let Some((fetched_at, network)) = self.network_cache.lock().await.as_ref() {
            if fetched_at.elapsed() < NETWORK_CACHE_TTL {
                return network.clone();
            }
        }
        match self.device_network().await {
            Ok(network) => {
                *self.network_cache.lock().await = Some((Instant::now(), network.clone()));
                network
            }
            Err(error) => {
                crate::logging::warn("Cloud", format!("读取设备网络信息失败：{error:#}"));
                self.network_cache
                    .lock()
                    .await
                    .as_ref()
                    .map(|(_, network)| network.clone())
                    .unwrap_or_default()
            }
        }
    }

    async fn device_network(&self) -> Result<DeviceNetwork> {
        let result = self
            .session
            .request("/home/device_list", json!({"get_extra": true}))
            .await?;
        let list = result
            .get("list")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("设备网络信息格式异常"))?;
        let mut map = std::collections::HashMap::new();
        for item in list {
            let did = value_text(&item["did"]);
            let ip = item
                .get("localip")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let token = item
                .get("token")
                .and_then(Value::as_str)
                .map(str::to_string);
            if !did.is_empty() && !ip.is_empty() {
                map.insert(did, (ip, token));
            }
        }
        Ok(map)
    }

    /// Negotiate the P2P transport for one camera. The public key is part of the request;
    /// without it the cloud returns `code -6 "nil request"`.
    pub async fn miss_vendor(&self, did: &str, app_pubkey: &str) -> Result<MissProvision> {
        let result = self
            .session
            .request(
                "/v2/device/miss_get_vendor",
                json!({
                    "app_pubkey": app_pubkey,
                    "did": did,
                    "support_vendors": "TUTK_CS2_MTP"
                }),
            )
            .await?;
        let vendor = result.get("vendor").cloned().unwrap_or_default();
        let params = vendor.get("vendor_params").cloned().unwrap_or_default();
        Ok(MissProvision {
            vendor_id: vendor.get("vendor").and_then(Value::as_i64).unwrap_or(-1),
            p2p_id: params
                .get("p2p_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            init_string: params
                .get("init_string")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            device_public: result
                .get("public_key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            sign: result
                .get("sign")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }

    pub async fn get_prop(&self, did: &str, siid: u32, piid: u32) -> Result<Value> {
        self.get_props(&[(did.to_string(), siid, piid)]).await
    }

    /// Read several properties in one cloud call. The card grid uses this so a
    /// page with a dozen devices does not fan out into dozens of requests.
    pub async fn get_props(&self, requests: &[(String, u32, u32)]) -> Result<Value> {
        // The MIoT endpoint accepts at most 20 property keys per request.
        // Fetch independent chunks concurrently; Session's RequestGate bounds
        // the actual cloud concurrency, and results are merged in input order.
        let mut seen = std::collections::HashSet::new();
        let requests: Vec<_> = requests
            .iter()
            .filter(|item| seen.insert((item.0.as_str(), item.1, item.2)))
            .collect();
        let chunks: Vec<Vec<(String, u32, u32)>> = requests
            .chunks(20)
            .map(|chunk| {
                chunk
                    .iter()
                    .map(|(did, siid, piid)| (did.clone(), *siid, *piid))
                    .collect()
            })
            .collect();
        let mut tasks = tokio::task::JoinSet::new();
        for (index, chunk) in chunks.iter().cloned().enumerate() {
            let session = self.session.clone();
            tasks.spawn(async move {
                let params: Vec<Value> = chunk
                    .iter()
                    .map(|(did, siid, piid)| json!({"did": did, "siid": siid, "piid": piid}))
                    .collect();
                let value = session
                    .request(
                        "/miotspec/prop/get",
                        json!({"params": params, "datasource": 1}),
                    )
                    .await?;
                Ok::<_, anyhow::Error>((index, value))
            });
        }
        let mut ordered = vec![None; chunks.len()];
        while let Some(result) = tasks.join_next().await {
            let (index, value) = result
                .map_err(|error| anyhow!("属性请求任务失败：{error}"))?
                .map_err(|error| anyhow!("属性请求失败：{error:#}"))?;
            ordered[index] = Some(value);
        }
        let mut merged = Vec::with_capacity(requests.len());
        for value in ordered.into_iter().flatten() {
            if let Some(items) = value.as_array() {
                merged.extend(items.iter().cloned());
            }
        }
        Ok(Value::Array(merged))
    }

    pub async fn set_prop(&self, did: &str, siid: u32, piid: u32, value: Value) -> Result<Value> {
        self.session
            .request(
                "/miotspec/prop/set",
                json!({"params": [{"did": did, "siid": siid, "piid": piid, "value": value}]}),
            )
            .await
    }

    pub async fn call_action(
        &self,
        did: &str,
        siid: u32,
        aiid: u32,
        params: Value,
    ) -> Result<Value> {
        self.session
            .request(
                "/miotspec/action",
                json!({"params": [{"did": did, "siid": siid, "aiid": aiid, "in": params}]}),
            )
            .await
    }

    /// Read cloud usage statistics for one property, such as a plug's daily
    /// energy use. `key` is `siid.piid`; the cloud only keeps statistics for
    /// some models and returns an empty list for the rest.
    pub async fn statistics(&self, query: &StatQuery) -> Result<Vec<StatPoint>> {
        query.validate()?;
        let result = self
            .session
            .request(
                "/v2/user/statistics",
                json!({
                    "did": query.did,
                    "key": query.key,
                    "data_type": query.data_type,
                    "time_start": query.time_start,
                    "time_end": query.time_end,
                    "limit": query.limit,
                }),
            )
            .await?;
        Ok(parse_statistics(&result))
    }
}

pub const STAT_DATA_TYPES: [&str; 4] = [
    "stat_hour_v3",
    "stat_day_v3",
    "stat_week_v3",
    "stat_month_v3",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatQuery {
    pub did: String,
    pub key: String,
    pub data_type: String,
    pub time_start: i64,
    pub time_end: i64,
    pub limit: u32,
}

impl StatQuery {
    fn validate(&self) -> Result<()> {
        if self.did.trim().is_empty() {
            return Err(anyhow!("缺少设备 ID"));
        }
        let mut parts = self.key.split('.');
        let valid_key = matches!(
            (parts.next(), parts.next(), parts.next()),
            (Some(siid), Some(piid), None)
                if siid.parse::<u32>().is_ok() && piid.parse::<u32>().is_ok()
        );
        if !valid_key {
            return Err(anyhow!("统计属性格式应为 siid.piid：{}", self.key));
        }
        if !STAT_DATA_TYPES.contains(&self.data_type.as_str()) {
            return Err(anyhow!("不支持的统计类型：{}", self.data_type));
        }
        if self.time_start >= self.time_end {
            return Err(anyhow!("统计开始时间必须早于结束时间"));
        }
        if self.limit == 0 || self.limit > 400 {
            return Err(anyhow!("统计条数应在 1 到 400 之间"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatPoint {
    /// Start of the period, in Unix seconds.
    pub time: i64,
    pub value: f64,
}

/// Each record carries its number as a JSON array string, for example
/// `{"time": 1731340800, "value": "[0.42]"}`. Records without a usable time
/// or number are dropped, the same period is kept once, and the result is
/// sorted from oldest to newest.
pub fn parse_statistics(result: &Value) -> Vec<StatPoint> {
    let mut points: Vec<StatPoint> = result
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|record| {
            let time = record.get("time").and_then(|time| {
                time.as_i64()
                    .or_else(|| time.as_str().and_then(|text| text.parse().ok()))
            })?;
            if time <= 0 {
                return None;
            }
            let value = match record.get("value")? {
                Value::String(text) => match serde_json::from_str::<Value>(text).ok()? {
                    Value::Array(items) => items.first()?.as_f64()?,
                    Value::Number(number) => number.as_f64()?,
                    _ => return None,
                },
                Value::Array(items) => items.first()?.as_f64()?,
                Value::Number(number) => number.as_f64()?,
                _ => return None,
            };
            value.is_finite().then_some(StatPoint { time, value })
        })
        .collect();
    points.sort_by_key(|point| point.time);
    points.dedup_by_key(|point| point.time);
    points
}

fn map_device(item: &Value, home_id: &str, fallback_room: Option<(String, String)>) -> Device {
    let room_id = item
        .get("room_id")
        .or_else(|| item.get("roomid"))
        .map(value_text)
        .filter(|s| !s.is_empty())
        .or_else(|| fallback_room.as_ref().map(|(id, _)| id.clone()));
    let room_name = item
        .get("room_name")
        .or_else(|| item.get("roomName"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| fallback_room.as_ref().map(|(_, name)| name.clone()));
    Device {
        did: value_text(&item["did"]),
        name: item["name"].as_str().unwrap_or("未命名设备").to_string(),
        model: item["model"].as_str().unwrap_or_default().to_string(),
        home_id: home_id.to_string(),
        room_id,
        room_name,
        online: item
            .get("isOnline")
            .or_else(|| item.get("is_online"))
            .or_else(|| item.get("online"))
            .map(value_bool)
            .unwrap_or(false),
        spec_type: item
            .get("spec_type")
            .or_else(|| item.get("specType"))
            .and_then(Value::as_str)
            .map(str::to_string),
        parent_id: item
            .get("parent_id")
            .or_else(|| item.get("parentId"))
            .map(value_text)
            .filter(|s| !s.is_empty() && s != "0"),
        raw: item.clone(),
    }
}

fn parse_homes(result: &Value) -> Vec<Home> {
    let mut homes = Vec::new();
    let mut seen_homes = std::collections::HashSet::new();
    for (key, shared) in [
        ("homelist", false),
        ("home_list", false),
        ("share_home_list", true),
    ] {
        let Some(list) = result.get(key).and_then(Value::as_array) else {
            continue;
        };
        for home in list {
            let id = value_text(&home["id"]);
            if id.is_empty() || !seen_homes.insert(id.clone()) {
                continue;
            }
            let rooms: Vec<Room> = home["roomlist"]
                .as_array()
                .map(|rooms| {
                    rooms
                        .iter()
                        .map(|room| Room {
                            id: value_text(&room["id"]),
                            name: room["name"].as_str().unwrap_or("房间").to_string(),
                            dids: value_id_list(&room["dids"]),
                        })
                        .collect()
                })
                .unwrap_or_default();
            homes.push(Home {
                id,
                name: home["name"].as_str().unwrap_or("我的家").to_string(),
                uid: ["uid", "owner_uid", "ownerUid"]
                    .iter()
                    .find_map(|key| value_i64(&home[*key]))
                    .or_else(|| value_i64(&home["owner"]["uid"]))
                    .unwrap_or(0),
                shared,
                room_count: rooms.len(),
                rooms,
                dids: value_id_list(&home["dids"]),
            });
        }
    }
    homes
}

fn home_did_entries(home: &Home) -> Vec<(String, Option<(String, String)>)> {
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for room in &home.rooms {
        for did in &room.dids {
            if !did.is_empty() && seen.insert(did.clone()) {
                entries.push((did.clone(), Some((room.id.clone(), room.name.clone()))));
            }
        }
    }
    for did in &home.dids {
        if !did.is_empty() && seen.insert(did.clone()) {
            entries.push((did.clone(), None));
        }
    }
    entries
}

fn device_items(data: &Value) -> Vec<Value> {
    let mut items = Vec::new();
    for key in ["device_info", "list"] {
        if let Some(list) = data.get(key).and_then(Value::as_array) {
            items.extend(list.iter().cloned());
        }
    }
    items
}

fn value_id_list(value: &Value) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(value_text)
                .filter(|item| !item.is_empty() && seen.insert(item.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn value_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}

fn value_bool(value: &Value) -> bool {
    value
        .as_bool()
        .or_else(|| value.as_i64().map(|n| n != 0))
        .or_else(|| {
            value
                .as_str()
                .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
        })
        .unwrap_or(false)
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn statistics_records_are_parsed_sorted_and_deduplicated() {
        let result = serde_json::json!([
            {"key": "11.1", "time": 1731427200, "value": "[0.5]"},
            {"key": "11.1", "time": 1731340800, "value": "[1.25]"},
            {"key": "11.1", "time": 1731340800, "value": "[1.25]"},
            {"key": "11.1", "time": "1731513600", "value": 2},
            {"key": "11.1", "time": 1731600000, "value": "[]"},
            {"key": "11.1", "time": 0, "value": "[3]"},
            {"key": "11.1", "value": "[4]"},
            {"key": "11.1", "time": 1731686400, "value": "not json"},
        ]);
        let points = super::parse_statistics(&result);
        assert_eq!(
            points,
            vec![
                super::StatPoint {
                    time: 1731340800,
                    value: 1.25
                },
                super::StatPoint {
                    time: 1731427200,
                    value: 0.5
                },
                super::StatPoint {
                    time: 1731513600,
                    value: 2.0
                },
            ]
        );
        assert!(super::parse_statistics(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn statistics_query_rejects_bad_input() {
        let query = |key: &str, data_type: &str, limit: u32| super::StatQuery {
            did: "plug1".into(),
            key: key.into(),
            data_type: data_type.into(),
            time_start: 100,
            time_end: 200,
            limit,
        };
        assert!(query("11.1", "stat_day_v3", 7).validate().is_ok());
        assert!(query("11", "stat_day_v3", 7).validate().is_err());
        assert!(query("11.1.2", "stat_day_v3", 7).validate().is_err());
        assert!(query("a.1", "stat_day_v3", 7).validate().is_err());
        assert!(query("11.1", "stat_year", 7).validate().is_err());
        assert!(query("11.1", "stat_day_v3", 0).validate().is_err());
        let mut reversed = query("11.1", "stat_day_v3", 7);
        reversed.time_start = 300;
        assert!(reversed.validate().is_err());
    }

    use super::*;

    #[test]
    fn homes_merge_owned_and_shared_and_deduplicate() {
        let result = json!({
            "homelist": [{
                "id": 1001,
                "name": "我的家",
                "uid": "42",
                "dids": ["unassigned-1", 77],
                "roomlist": [{
                    "id": 11,
                    "name": "客厅",
                    "dids": ["light-1", "light-1", 88]
                }]
            }],
            "share_home_list": [{
                "id": "2002",
                "name": "爸妈家",
                "owner_uid": "9009",
                "roomlist": [{
                    "id": "21",
                    "name": "卧室",
                    "dids": ["shared-light"]
                }]
            }, {
                "id": 1001,
                "name": "重复家庭",
                "roomlist": []
            }]
        });

        let homes = parse_homes(&result);
        assert_eq!(homes.len(), 2);
        assert_eq!(homes[0].id, "1001");
        assert_eq!(homes[0].uid, 42);
        assert!(!homes[0].shared);
        assert_eq!(homes[0].dids, vec!["unassigned-1", "77"]);
        assert_eq!(homes[0].rooms[0].dids, vec!["light-1", "88"]);
        assert_eq!(homes[1].id, "2002");
        assert_eq!(homes[1].uid, 9009);
        assert!(homes[1].shared);
        assert_eq!(homes[1].rooms[0].dids, vec!["shared-light"]);
    }

    #[test]
    fn shared_only_account_still_gets_home_and_room_context() {
        let result = json!({
            "homelist": [],
            "share_home_list": [{
                "id": "3003",
                "name": "共享的家",
                "uid": 123,
                "dids": ["home-device"],
                "roomlist": [{
                    "id": "31",
                    "name": "书房",
                    "dids": ["room-device"]
                }]
            }]
        });

        let homes = parse_homes(&result);
        assert_eq!(homes.len(), 1);
        assert_eq!(
            home_did_entries(&homes[0]),
            vec![
                (
                    "room-device".to_string(),
                    Some(("31".to_string(), "书房".to_string()))
                ),
                ("home-device".to_string(), None)
            ]
        );
    }

    #[test]
    fn device_items_support_both_cloud_response_shapes() {
        let legacy = json!({
            "device_info": [{"did": "one", "name": "One"}],
            "list": [{"did": "duplicate", "name": "Duplicate"}]
        });
        let page = json!({
            "list": [{"did": "two", "name": "Two"}]
        });

        assert_eq!(device_items(&legacy).len(), 2);
        assert_eq!(device_items(&page)[0]["did"], "two");
    }

    #[test]
    fn home_serialization_marks_shared_without_exposing_home_level_dids() {
        let home = Home {
            id: "2002".into(),
            name: "共享的家".into(),
            uid: 9009,
            shared: true,
            room_count: 1,
            rooms: vec![Room {
                id: "21".into(),
                name: "卧室".into(),
                dids: vec!["shared-light".into()],
            }],
            dids: vec!["home-level-device".into()],
        };

        let serialized = serde_json::to_value(home).unwrap();
        assert_eq!(serialized["shared"], true);
        assert!(serialized.get("dids").is_none());
    }

    #[test]
    fn device_serialization_does_not_leak_raw_cloud_fields() {
        let device = Device {
            did: "did-1".into(),
            name: "Camera".into(),
            model: "chuangmi.camera.test".into(),
            home_id: "home-1".into(),
            room_id: None,
            room_name: None,
            online: true,
            spec_type: None,
            parent_id: None,
            raw: json!({"token": "secret-device-token", "localip": "192.168.1.2"}),
        };
        let serialized = serde_json::to_value(device).unwrap();
        assert!(serialized.get("raw").is_none());
        assert_eq!(serialized["did"], "did-1");
    }
}
