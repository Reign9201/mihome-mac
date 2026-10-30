use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::Session;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Home {
    pub id: String,
    pub name: String,
    pub uid: i64,
    pub room_count: usize,
    pub rooms: Vec<Room>,
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
    pub raw: Value,
}

#[derive(Clone)]
pub struct MiCloud {
    session: Session,
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
        Self { session }
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub async fn homes(&self) -> Result<Vec<Home>> {
        let result = self
            .session
            .request(
                "/v2/homeroom/gethome_merged",
                json!({"fg": true, "fetch_share": true, "fetch_share_dev": true, "fetch_cariot": true, "limit": 300, "app_ver": 7, "plat_form": 0}),
            )
            .await?;
        let list = result
            .get("homelist")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("家庭列表格式异常"))?;
        Ok(list
            .iter()
            .map(|home| Home {
                id: value_text(&home["id"]),
                name: home["name"].as_str().unwrap_or("我的家").to_string(),
                uid: home["uid"].as_i64().unwrap_or(0),
                room_count: home["roomlist"].as_array().map(Vec::len).unwrap_or(0),
                rooms: home["roomlist"]
                    .as_array()
                    .map(|rooms| {
                        rooms
                            .iter()
                            .map(|room| Room {
                                id: value_text(&room["id"]),
                                name: room["name"].as_str().unwrap_or("房间").to_string(),
                                dids: room["dids"]
                                    .as_array()
                                    .map(|dids| dids.iter().map(value_text).collect())
                                    .unwrap_or_default(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect())
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
        for home in targets {
            let numeric_home_id: u64 = home
                .id
                .parse()
                .with_context(|| format!("家庭 ID 不是数字: {}", home.id))?;
            let mut room_by_did = std::collections::HashMap::new();
            for room in &home.rooms {
                for did in &room.dids {
                    room_by_did.insert(did.clone(), (room.id.clone(), room.name.clone()));
                }
            }
            let mut start_did = String::new();
            let mut seen_cursors = std::collections::HashSet::new();
            let mut pages = 0usize;
            loop {
                pages += 1;
                if pages > 1000 {
                    return Err(anyhow!("设备分页超过 1000 页，已停止请求"));
                }
                let data = self
                    .session
                    .request(
                        "/home/home_device_list",
                        json!({
                            "home_owner": home.uid,
                            "home_id": numeric_home_id,
                            "limit": 200,
                            "start_did": start_did,
                            "get_split_device": true,
                            "support_smart_home": true,
                            "get_cariot_device": true,
                            "get_third_device": true
                        }),
                    )
                    .await?;
                let info = data
                    .get("device_info")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for item in &info {
                    let did = value_text(&item["did"]);
                    if did.is_empty() || !seen_dids.insert(did.clone()) {
                        continue;
                    }
                    let fallback = room_by_did.get(&did).cloned();
                    result.push(map_device(item, &home.id, fallback));
                }
                let has_more = data
                    .get("has_more")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let max_did = value_text(&data["max_did"]);
                if !has_more || max_did.is_empty() {
                    break;
                }
                if !seen_cursors.insert(max_did.clone()) {
                    return Err(anyhow!("设备分页游标重复：{max_did}"));
                }
                start_did = max_did;
            }
        }
        Ok(result)
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
            self.device_network().await.unwrap_or_default()
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

    async fn device_network(
        &self,
    ) -> Result<std::collections::HashMap<String, (String, Option<String>)>> {
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
        // The MIoT endpoint accepts at most 20 property keys per request. Keep
        // larger card refreshes in ordered chunks and merge the result arrays.
        let mut seen = std::collections::HashSet::new();
        let requests: Vec<_> = requests
            .iter()
            .filter(|item| seen.insert((item.0.as_str(), item.1, item.2)))
            .collect();
        let mut merged = Vec::with_capacity(requests.len());
        for chunk in requests.chunks(20) {
            let params: Vec<Value> = chunk
                .iter()
                .map(|(did, siid, piid)| json!({"did": did, "siid": siid, "piid": piid}))
                .collect();
            let value = self
                .session
                .request(
                    "/miotspec/prop/get",
                    json!({"params": params, "datasource": 1}),
                )
                .await?;
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
