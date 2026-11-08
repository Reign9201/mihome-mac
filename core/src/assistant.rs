use crate::cloud::{Device, Home, Scene};
use crate::spec::{DeviceSpec, SpecValueItem, SpecValueRange};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

/// A model-produced instruction intentionally contains names, never Mi Home IDs.
/// The resolver maps these names to the real `did/siid/piid` locally.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssistantIntent {
    pub action: IntentAction,
    #[serde(default)]
    pub target: IntentTarget,
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub scene: Option<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntentAction {
    SetDevice,
    AdjustDevice,
    RunScene,
    QueryState,
    QueryDevices,
    Help,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct IntentTarget {
    #[serde(default)]
    pub home: Option<String>,
    #[serde(default)]
    pub room: Option<String>,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub exclude_rooms: Vec<String>,
    #[serde(default)]
    pub exclude_devices: Vec<String>,
    #[serde(default)]
    pub exclude_categories: Vec<String>,
}

fn default_confidence() -> f32 {
    0.5
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogValueItem {
    pub value: i64,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogValueRange {
    pub min: f64,
    pub max: f64,
    #[serde(default = "default_step")]
    pub step: f64,
}

fn default_step() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogCapability {
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub service: String,
    pub siid: u32,
    pub piid: u32,
    pub data_type: String,
    #[serde(default)]
    pub writable: bool,
    #[serde(default)]
    pub readable: bool,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub value_range: Option<CatalogValueRange>,
    #[serde(default)]
    pub value_list: Vec<CatalogValueItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogAction {
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub service: String,
    pub siid: u32,
    pub aiid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogDevice {
    #[serde(skip_serializing)]
    pub did: String,
    #[serde(skip_serializing)]
    pub home_id: String,
    pub home_name: String,
    #[serde(skip_serializing)]
    pub room_id: Option<String>,
    pub room_name: String,
    pub name: String,
    pub category: String,
    pub online: bool,
    #[serde(default)]
    pub capabilities: Vec<CatalogCapability>,
    #[serde(default)]
    pub actions: Vec<CatalogAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogScene {
    #[serde(skip_serializing)]
    pub id: String,
    #[serde(skip_serializing)]
    pub home_id: String,
    pub home_name: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeviceCatalog {
    #[serde(default)]
    pub devices: Vec<CatalogDevice>,
    #[serde(default)]
    pub scenes: Vec<CatalogScene>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedTarget {
    pub home: String,
    pub room: String,
    pub device: String,
    pub category: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AdjustmentDirection {
    Increase,
    Decrease,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AdjustmentUnit {
    Default,
    Step,
    Percent,
    Degree,
    Kelvin,
}

#[derive(Debug, Clone)]
pub struct PropertyQuery {
    pub did: String,
    pub device_name: String,
    pub siid: u32,
    pub piid: u32,
    pub label: String,
    pub capability: CatalogCapability,
}

#[derive(Debug, Clone)]
pub enum ResolvedOperation {
    SetProperty {
        did: String,
        device_name: String,
        siid: u32,
        piid: u32,
        value: Value,
        label: String,
        capability: CatalogCapability,
    },
    AdjustProperty {
        did: String,
        device_name: String,
        capability: CatalogCapability,
        direction: AdjustmentDirection,
        amount: Option<f64>,
        unit: AdjustmentUnit,
    },
    Batch {
        description: String,
        operations: Vec<ResolvedOperation>,
        skipped: Vec<String>,
    },
    CallAction {
        did: String,
        device_name: String,
        siid: u32,
        aiid: u32,
        name: String,
        repeat: u32,
    },
    RunScene {
        scene_id: String,
        home_id: String,
        name: String,
    },
    QueryProperty {
        did: String,
        device_name: String,
        siid: u32,
        piid: u32,
        label: String,
        capability: CatalogCapability,
    },
    QueryProperties {
        description: String,
        queries: Vec<PropertyQuery>,
        skipped: Vec<String>,
    },
    DeviceOverview {
        reply: String,
    },
}

#[derive(Debug, Clone)]
pub struct ResolvedCommand {
    pub intent: AssistantIntent,
    pub target: Option<ResolvedTarget>,
    pub operation: ResolvedOperation,
    pub summary: String,
    pub requires_confirmation: bool,
    pub confirmation_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CandidateView {
    pub home: String,
    pub room: String,
    pub device: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResolveOutcome {
    Ready {
        summary: String,
        requires_confirmation: bool,
        confirmation_reason: Option<String>,
        #[serde(skip_serializing)]
        command: Box<ResolvedCommand>,
    },
    Ambiguous {
        message: String,
        candidates: Vec<CandidateView>,
    },
    NotFound {
        message: String,
    },
}

impl ResolveOutcome {
    pub fn command(self) -> Option<ResolvedCommand> {
        match self {
            Self::Ready { command, .. } => Some(*command),
            _ => None,
        }
    }
}

impl DeviceCatalog {
    pub fn from_parts(
        homes: &[Home],
        devices: &[Device],
        specs: &HashMap<String, DeviceSpec>,
        scenes: &[Scene],
    ) -> Self {
        let home_names: HashMap<&str, &str> = homes
            .iter()
            .map(|home| (home.id.as_str(), home.name.as_str()))
            .collect();
        let catalog_devices = devices
            .iter()
            .map(|device| {
                let spec = device
                    .spec_type
                    .as_deref()
                    .and_then(|spec_type| specs.get(spec_type));
                let category = infer_category(device, spec);
                CatalogDevice {
                    did: device.did.clone(),
                    home_id: device.home_id.clone(),
                    home_name: home_names
                        .get(device.home_id.as_str())
                        .copied()
                        .unwrap_or("我的家")
                        .to_string(),
                    room_id: device.room_id.clone(),
                    room_name: device
                        .room_name
                        .clone()
                        .unwrap_or_else(|| "未分房间".to_string()),
                    name: device.name.clone(),
                    category: category.clone(),
                    online: device.online,
                    capabilities: spec
                        .map(|spec| capabilities_from_spec(spec, &category))
                        .unwrap_or_default(),
                    actions: spec.map(actions_from_spec).unwrap_or_default(),
                }
            })
            .collect();
        let catalog_scenes = scenes
            .iter()
            .map(|scene| CatalogScene {
                id: scene.id.clone(),
                home_id: scene.home_id.clone(),
                home_name: home_names
                    .get(scene.home_id.as_str())
                    .copied()
                    .unwrap_or("我的家")
                    .to_string(),
                name: scene.name.clone(),
            })
            .collect();
        Self {
            devices: catalog_devices,
            scenes: catalog_scenes,
        }
    }

    pub fn model_digest(&self) -> Value {
        json!({
            "homes": self.homes(),
            "devices": self.devices.iter().map(|device| json!({
                "home": device.home_name,
                "room": device.room_name,
                "device": device.name,
                "category": device.category,
                "online": device.online,
                "capabilities": device.capabilities.iter()
                    .filter(|capability| capability.writable || capability.readable)
                    .map(|capability| json!({
                        "name": capability.name,
                        "label": capability.label,
                        "type": capability.data_type,
                        "readable": capability.readable,
                        "writable": capability.writable,
                        "unit": capability.unit,
                        "range": capability.value_range,
                        "values": capability.value_list,
                    }))
                    .collect::<Vec<_>>(),
                "actions": device.actions.iter()
                    .map(|action| json!({
                        "name": action.name,
                        "label": action.label,
                    }))
                    .collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "scenes": self.scenes.iter().map(|scene| json!({
                "home": scene.home_name,
                "name": scene.name,
            })).collect::<Vec<_>>(),
        })
    }

    pub fn homes(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        self.devices
            .iter()
            .map(|device| device.home_name.clone())
            .chain(self.scenes.iter().map(|scene| scene.home_name.clone()))
            .filter(|name| seen.insert(name.clone()))
            .collect()
    }

    pub fn rooms(&self) -> Vec<(String, String)> {
        let mut seen = HashSet::new();
        self.devices
            .iter()
            .filter(|device| seen.insert((device.home_name.clone(), device.room_name.clone())))
            .map(|device| (device.home_name.clone(), device.room_name.clone()))
            .collect()
    }

    pub fn parse_local(&self, text: &str) -> Option<AssistantIntent> {
        parse_local_intent(self, text)
    }

    pub fn resolve(&self, intent: AssistantIntent) -> ResolveOutcome {
        resolve_intent(self, intent)
    }
}

pub struct OpenAiIntentParser {
    client: reqwest::Client,
    endpoint: String,
    model: String,
    api_key: String,
}

impl OpenAiIntentParser {
    pub fn new(base_url: &str, model: &str, api_key: &str) -> Result<Self> {
        let base_url = normalize_base_url(base_url);
        if base_url.is_empty() || model.trim().is_empty() {
            return Err(anyhow!("请配置模型接口地址和模型名称"));
        }
        let endpoint = if base_url.ends_with("/chat/completions") {
            base_url.to_string()
        } else {
            format!("{base_url}/chat/completions")
        };
        let mut client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60));
        if is_loopback_url(&base_url) {
            client = client.no_proxy();
        }
        let client = client.build().context("创建模型客户端失败")?;
        Ok(Self {
            client,
            endpoint,
            model: model.trim().to_string(),
            api_key: api_key.trim().to_string(),
        })
    }

    pub async fn parse(&self, catalog: &DeviceCatalog, text: &str) -> Result<AssistantIntent> {
        let system = r#"你是智能家居意图解析器。只输出一个 JSON 对象，不要 Markdown，不要解释。
可用 action: set_device, adjust_device, run_scene, query_state, query_devices, help。
set_device 示例:
{"action":"set_device","target":{"home":"我的家","room":"客厅","device":"空调"},"capability":"target_temperature","value":26,"confidence":0.94}
adjust_device 示例:
{"action":"adjust_device","target":{"home":"我的家","room":"客厅","device":"灯"},"capability":"brightness","value":{"direction":"increase","amount":10,"unit":"percent"},"confidence":0.9}
run_scene 示例:
{"action":"run_scene","target":{"home":"我的家"},"scene":"回家模式","confidence":0.9}
query_devices 示例:
{"action":"query_devices","capability":"online_count","confidence":0.9}
规则：
1. 只能使用目录中存在的家庭、房间、设备、能力和场景；不能猜测 ID。
2. target.device 填用户说的设备名或品类；room/home 不确定时省略。
3. capability 必须来自目录。常用能力：on, brightness, color_temperature, color, target_temperature, relative_humidity, fan_level, mode, volume, mute, current_position, motor_control。
   开关设备仍使用 capability=on 和 value=true/false；actions 是无参数设备动作，播放、暂停、下一首、上一首、开始清扫、暂停清扫、回充可直接作为 capability。
4. query_devices 的 capability 只能使用 online_count, offline_count, online_list, offline_list 或 all_count。
5. “所有/全部/全屋”在 target.all 填 true；调整方向只能使用 increase 或 decrease。
6. “除了/不包括”写入 target.exclude_rooms、exclude_devices 或 exclude_categories，不能把排除项当成目标。
7. 无法确定时返回 {"action":"help","confidence":0.2}。
8. 不执行设备重启、门锁、燃气、摄像头隐私等高风险操作，仍只输出意图，由本地策略校验。
9. 用户只说泛化品类（如“卧室灯”“客厅空调”）时，target.device 填对应品类（light、air_conditioner 等），room 填房间；不要自行收窄成目录里的某个具体设备名，本地会处理单设备或批量执行。
10. 风扇灯、带新风模块的空调等多服务设备，按用户实际说的“灯”或“风扇”选择 capability，不要假设两个服务共用同一个开关。"#;
        let user = format!(
            "设备目录：\n{}\n\n用户指令：{}",
            serde_json::to_string(&catalog.model_digest()).context("序列化设备目录失败")?,
            text.trim()
        );
        let mut request = self.client.post(&self.endpoint).json(&json!({
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user}
            ]
        }));
        if !self.api_key.is_empty() {
            request = request.bearer_auth(&self.api_key);
        }
        let response = request
            .send()
            .await
            .map_err(|error| anyhow!("模型接口请求失败：{error}"))?;
        let status = response.status();
        let body: Value = response.json().await.context("模型接口返回不是 JSON")?;
        if !status.is_success() {
            return Err(anyhow!(
                "模型接口返回 HTTP {status}: {}",
                body.get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误")
            ));
        }
        let content = body
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("模型响应缺少 choices[0].message.content"))?;
        parse_model_content(content)
    }

    pub async fn test_connection(&self) -> Result<()> {
        let mut request = self.client.post(&self.endpoint).json(&json!({
            "model": self.model,
            "temperature": 0,
            "max_tokens": 8,
            "messages": [
                {"role": "user", "content": "只回复 OK"}
            ]
        }));
        if !self.api_key.is_empty() {
            request = request.bearer_auth(&self.api_key);
        }
        let response = request
            .send()
            .await
            .map_err(|error| anyhow!("模型接口请求失败：{error}"))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .context("模型接口返回不是 JSON，请检查接口地址是否兼容 OpenAI")?;
        if !status.is_success() {
            return Err(anyhow!(
                "模型接口返回 HTTP {status}: {}",
                body.pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误")
            ));
        }
        body.pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("模型响应缺少 choices[0].message.content"))?;
        Ok(())
    }
}

fn normalize_base_url(base_url: &str) -> String {
    let value = base_url.trim().trim_end_matches('/');
    if value.is_empty() {
        return String::new();
    }
    let value = if value.starts_with("http://") || value.starts_with("https://") {
        value.to_string()
    } else {
        format!("http://{value}")
    };
    if url_has_path(&value) {
        value
    } else {
        format!("{value}/v1")
    }
}

fn url_has_path(value: &str) -> bool {
    let Some(scheme) = value.find("://") else {
        return false;
    };
    let rest = &value[scheme + 3..];
    rest.split_once('/')
        .is_some_and(|(_, path)| !path.trim().is_empty())
}

fn is_loopback_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("http://127.0.0.1")
        || lower.starts_with("http://localhost")
        || lower.starts_with("http://[::1]")
}

pub fn parse_model_content(content: &str) -> Result<AssistantIntent> {
    let start = content
        .find('{')
        .ok_or_else(|| anyhow!("模型没有返回 JSON 对象"))?;
    let end = content
        .rfind('}')
        .ok_or_else(|| anyhow!("模型没有返回完整 JSON 对象"))?;
    if end < start {
        return Err(anyhow!("模型返回的 JSON 边界无效"));
    }
    let mut intent: AssistantIntent =
        serde_json::from_str(&content[start..=end]).context("模型意图 JSON 格式错误")?;
    intent.confidence = intent.confidence.clamp(0.0, 1.0);
    if intent.confidence < 0.55 {
        return Ok(AssistantIntent {
            action: IntentAction::Help,
            target: IntentTarget::default(),
            capability: None,
            value: Value::Null,
            scene: None,
            confidence: intent.confidence,
        });
    }
    if matches!(
        intent.action,
        IntentAction::SetDevice | IntentAction::AdjustDevice
    ) && intent.capability.is_none()
    {
        return Err(anyhow!("设备控制意图缺少 capability"));
    }
    if intent.action == IntentAction::AdjustDevice {
        let direction = intent
            .value
            .get("direction")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(direction, "increase" | "decrease") {
            return Err(anyhow!(
                "adjust_device 的 value.direction 必须是 increase 或 decrease"
            ));
        }
    }
    if intent.action == IntentAction::QueryDevices
        && !matches!(
            intent.capability.as_deref(),
            Some("online_count" | "offline_count" | "online_list" | "offline_list" | "all_count")
        )
    {
        intent.capability = Some("all_count".to_string());
    }
    Ok(intent)
}

fn capabilities_from_spec(spec: &DeviceSpec, category: &str) -> Vec<CatalogCapability> {
    let mut capabilities = Vec::new();
    let mut seen = HashSet::new();
    for service in &spec.services {
        let service_kind = kind_suffix(&service.kind);
        for property in &service.properties {
            let name = semantic_capability_name(kind_suffix(&property.kind));
            let key = (service.iid, property.iid);
            if !seen.insert(key) {
                continue;
            }
            let readable = property.access.is_empty()
                || property
                    .access
                    .iter()
                    .any(|access| access == "read" || access == "notify");
            let writable = property.access.iter().any(|access| access == "write");
            let primary = name == "on" && service_kind != "indicator-light"
                || service_kind_matches_category(service_kind, category);
            capabilities.push(CatalogCapability {
                name: name.clone(),
                label: capability_label(&name, service_kind),
                service: service_kind.to_string(),
                siid: service.iid,
                piid: property.iid,
                data_type: property.format.clone(),
                writable,
                readable,
                primary,
                unit: property.unit.clone(),
                value_range: property.value_range.as_ref().map(range_from_spec),
                value_list: property
                    .value_list
                    .as_ref()
                    .map(|values| values.iter().map(value_item_from_spec).collect())
                    .unwrap_or_default(),
            });
        }
    }
    capabilities
}

fn actions_from_spec(spec: &DeviceSpec) -> Vec<CatalogAction> {
    let mut actions = Vec::new();
    let mut seen = HashSet::new();
    for service in &spec.services {
        for action in &service.actions {
            if !action.inputs.is_empty() {
                continue;
            }
            let Some(name) = semantic_action_name(kind_suffix(&action.kind)) else {
                continue;
            };
            if !seen.insert((service.iid, action.iid)) {
                continue;
            }
            actions.push(CatalogAction {
                name: name.to_string(),
                label: action_label(name).to_string(),
                service: kind_suffix(&service.kind).to_string(),
                siid: service.iid,
                aiid: action.iid,
            });
        }
    }
    actions
}

fn semantic_action_name(kind: &str) -> Option<&'static str> {
    match kind {
        "turn-on" | "tv-switchon" => Some("turn_on"),
        "turn-off" => Some("turn_off"),
        "toggle" => Some("toggle"),
        "temperature-up" => Some("temperature_up"),
        "temperature-down" => Some("temperature_down"),
        "fan-speed-up" | "fan-level-up" => Some("fan_level_up"),
        "fan-speed-down" | "fan-level-down" => Some("fan_level_down"),
        "brightness-up" | "bright-increase" => Some("brightness_up"),
        "brightness-down" | "bright-decrease" => Some("brightness_down"),
        "color-temperature-up" | "ct-increase" => Some("color_temperature_up"),
        "color-temperature-down" | "ct-decrease" => Some("color_temperature_down"),
        "play" => Some("play"),
        "pause" => Some("pause"),
        "next" => Some("next"),
        "previous" => Some("previous"),
        "press-volume-up" => Some("volume_up"),
        "press-volume-down" => Some("volume_down"),
        "start-sweep" | "start-clean" => Some("start_sweep"),
        "stop-sweep" | "stop-clean" => Some("stop_sweep"),
        "start-charge" | "charge" | "go-charge" => Some("return_to_charge"),
        "lock" | "lock-door" => Some("lock"),
        "unlock" | "unlock-door" => Some("unlock"),
        _ => None,
    }
}

fn action_label(name: &str) -> &'static str {
    match name {
        "turn_on" => "开机",
        "turn_off" => "关机",
        "toggle" => "切换开关",
        "temperature_up" => "升温",
        "temperature_down" => "降温",
        "fan_level_up" => "调高风速",
        "fan_level_down" => "调低风速",
        "brightness_up" => "调亮",
        "brightness_down" => "调暗",
        "color_temperature_up" => "调冷色温",
        "color_temperature_down" => "调暖色温",
        "play" => "播放",
        "pause" => "暂停",
        "next" => "下一首",
        "previous" => "上一首",
        "volume_up" => "调高音量",
        "volume_down" => "调低音量",
        "start_sweep" => "开始清扫",
        "stop_sweep" => "暂停清扫",
        "return_to_charge" => "回充",
        "lock" => "上锁",
        "unlock" => "开锁",
        _ => "设备动作",
    }
}

fn range_from_spec(range: &SpecValueRange) -> CatalogValueRange {
    CatalogValueRange {
        min: range.min,
        max: range.max,
        step: range.step,
    }
}

fn value_item_from_spec(item: &SpecValueItem) -> CatalogValueItem {
    CatalogValueItem {
        value: item.value,
        description: item.description.clone(),
    }
}

fn kind_suffix(kind: &str) -> &str {
    let parts: Vec<&str> = kind.split(':').filter(|part| !part.is_empty()).collect();
    let Some(marker) = parts
        .iter()
        .position(|part| matches!(*part, "device" | "service" | "property" | "action"))
    else {
        return parts.last().copied().unwrap_or(kind);
    };
    parts.get(marker + 1).copied().unwrap_or(kind)
}

fn semantic_capability_name(kind: &str) -> String {
    match kind {
        "target-temperature" => "target_temperature".to_string(),
        "temperature" => "current_temperature".to_string(),
        "fan-level" => "fan_level".to_string(),
        "current-temperature" => "current_temperature".to_string(),
        "relative-humidity" => "relative_humidity".to_string(),
        "battery-level" => "battery_level".to_string(),
        "current-position" => "current_position".to_string(),
        "color-temperature" => "color_temperature".to_string(),
        "color-temperature-delta" => "color_temperature_delta".to_string(),
        "brightness-delta" => "brightness_delta".to_string(),
        "motor-control" => "motor_control".to_string(),
        "is-on" => "is_on".to_string(),
        "playing-state" => "playing_state".to_string(),
        other => other.replace('-', "_"),
    }
}

fn capability_label(name: &str, service_kind: &str) -> String {
    match name {
        "on" if service_kind == "indicator-light" => "指示灯",
        "on" => "开关",
        "brightness" => "亮度",
        "color_temperature" => "色温",
        "color" => "颜色",
        "target_temperature" => "目标温度",
        "current_temperature" => "当前温度",
        "relative_humidity" => "湿度",
        "battery_level" => "电量",
        "fan_level" => "风速",
        "mode" => "模式",
        "door_state" => "门状态",
        "current_position" | "position" => "开合度",
        "motor_control" => "电机控制",
        "volume" => "音量",
        "mute" => "静音",
        "vertical_swing" => "上下扫风",
        "horizontal_swing" => "左右扫风",
        "oscillate" => "摇头",
        "is_on" => "开关",
        "playing_state" => "播放状态",
        other => other,
    }
    .to_string()
}

fn localized_property_unit(unit: &str) -> Option<String> {
    let unit = unit.trim();
    match unit.to_ascii_lowercase().as_str() {
        "" | "none" => None,
        "percentage" | "percent" => Some("%".to_string()),
        "celsius" => Some("°C".to_string()),
        "fahrenheit" => Some("°F".to_string()),
        "kelvin" => Some("K".to_string()),
        "arcdegrees" | "degrees" | "degree" => Some("°".to_string()),
        "minutes" | "minute" => Some("分钟".to_string()),
        "seconds" | "second" => Some("秒".to_string()),
        "hours" | "hour" => Some("小时".to_string()),
        "milliseconds" => Some("毫秒".to_string()),
        "microseconds" => Some("微秒".to_string()),
        "lux" => Some("lx".to_string()),
        "mg/m3" => Some("mg/m³".to_string()),
        "μg/m3" => Some("μg/m³".to_string()),
        "ppm" => Some("ppm".to_string()),
        "db" => Some("dB".to_string()),
        _ if !unit.is_ascii()
            || !unit
                .chars()
                .any(|character| character.is_ascii_alphabetic()) =>
        {
            Some(unit.to_string())
        }
        _ => None,
    }
}

fn service_kind_matches_category(service_kind: &str, category: &str) -> bool {
    category_from_miot_device_kind(service_kind) == Some(category)
}

fn category_from_miot_device_kind(kind: &str) -> Option<&'static str> {
    let kind = kind_suffix(kind).replace('_', "-");
    if kind.ends_with("-sensor") {
        return Some("sensor");
    }
    match kind.as_str() {
        "light" | "fan-light" | "fanlight" | "ceiling-fan-light" => Some("light"),
        "air-conditioner" | "airconditioner" => Some("air_conditioner"),
        "fan" | "ceiling-fan" => Some("fan"),
        "curtain" => Some("curtain"),
        "airer" => Some("airer"),
        "switch" | "outlet" => Some("switch"),
        "camera" | "camera-control" => Some("camera"),
        "lock" | "door-lock" => Some("lock"),
        "television" | "projector" => Some("television"),
        "speaker" => Some("speaker"),
        "sensor" => Some("sensor"),
        "air-purifier" => Some("air_purifier"),
        "fresh-air-system" => Some("fresh_air_system"),
        "humidifier" => Some("humidifier"),
        "dehumidifier" => Some("dehumidifier"),
        "vacuum" | "robot-vacuum" => Some("vacuum"),
        "water-heater" => Some("water_heater"),
        "heater" => Some("heater"),
        "bath-heater" | "bathroom-heater" => Some("bathroom_heater"),
        "washing-machine" => Some("washing_machine"),
        "dishwasher" => Some("dishwasher"),
        "refrigerator" | "fridge" => Some("refrigerator"),
        "cooker" => Some("cooker"),
        "water-purifier" => Some("water_purifier"),
        _ => None,
    }
}

fn infer_category(device: &Device, spec: Option<&DeviceSpec>) -> String {
    if let Some(category) = spec
        .map(|spec| spec.kind.as_str())
        .or(device.spec_type.as_deref())
        .and_then(category_from_miot_device_kind)
    {
        return category.to_string();
    }
    let text = format!(
        "{} {} {}",
        device.name,
        device.model,
        device.spec_type.as_deref().unwrap_or("")
    )
    .to_ascii_lowercase();
    for (needle, category) in [
        ("空调扇", "fan"),
        ("电视柜灯", "light"),
        ("air-conditioner", "air_conditioner"),
        ("air conditioner", "air_conditioner"),
        ("aircondition", "air_conditioner"),
        ("空调", "air_conditioner"),
        ("冷气", "air_conditioner"),
        ("air-purifier", "air_purifier"),
        ("air purifier", "air_purifier"),
        ("净化器", "air_purifier"),
        ("fresh-air", "fresh_air_system"),
        ("新风", "fresh_air_system"),
        ("humidifier", "humidifier"),
        ("加湿器", "humidifier"),
        ("dehumidifier", "dehumidifier"),
        ("除湿机", "dehumidifier"),
        ("抽湿机", "dehumidifier"),
        ("vacuum", "vacuum"),
        ("扫地机", "vacuum"),
        ("吸尘器", "vacuum"),
        ("water-heater", "water_heater"),
        ("热水器", "water_heater"),
        ("bath-heater", "bathroom_heater"),
        ("浴霸", "bathroom_heater"),
        ("heater", "heater"),
        ("电暖器", "heater"),
        ("取暖器", "heater"),
        ("暖气", "heater"),
        ("washing-machine", "washing_machine"),
        ("洗衣机", "washing_machine"),
        ("dishwasher", "dishwasher"),
        ("洗碗机", "dishwasher"),
        ("refrigerator", "refrigerator"),
        ("fridge", "refrigerator"),
        ("冰箱", "refrigerator"),
        ("cooker", "cooker"),
        ("电饭煲", "cooker"),
        ("电压力锅", "cooker"),
        ("water-purifier", "water_purifier"),
        ("净水器", "water_purifier"),
        ("door-lock", "lock"),
        ("lock", "lock"),
        ("门锁", "lock"),
        ("camera", "camera"),
        ("摄像头", "camera"),
        ("监控", "camera"),
        ("curtain", "curtain"),
        ("窗帘", "curtain"),
        ("blind", "curtain"),
        ("百叶窗", "curtain"),
        ("airer", "airer"),
        ("晾衣架", "airer"),
        ("晾衣机", "airer"),
        ("television", "television"),
        ("电视", "television"),
        ("projector", "television"),
        ("投影仪", "television"),
        ("speaker", "speaker"),
        ("音箱", "speaker"),
        ("音响", "speaker"),
        ("风扇灯", "light"),
        ("吊扇灯", "light"),
        ("fan-light", "light"),
        ("fanlight", "light"),
        ("cfan", "light"),
        ("fan", "fan"),
        ("风扇", "fan"),
        ("电扇", "fan"),
        ("light", "light"),
        ("灯", "light"),
        ("switch", "switch"),
        ("插座", "switch"),
        ("开关", "switch"),
        ("sensor", "sensor"),
        ("传感器", "sensor"),
    ] {
        if text.contains(needle) {
            return category.to_string();
        }
    }
    "device".to_string()
}

fn category_words(category: &str) -> &'static [&'static str] {
    match category {
        "light" => &[
            "灯",
            "灯光",
            "照明",
            "台灯",
            "吊灯",
            "吸顶灯",
            "灯带",
            "落地灯",
            "床头灯",
            "light",
            "lamp",
        ],
        "air_conditioner" => &[
            "空调",
            "冷气",
            "中央空调",
            "空调机",
            "air conditioner",
            "airconditioner",
            "ac unit",
        ],
        "fan" => &["风扇", "电扇", "电风扇", "循环扇", "塔扇", "空调扇", "fan"],
        "curtain" => &[
            "窗帘",
            "卷帘",
            "百叶窗",
            "纱帘",
            "遮阳帘",
            "幕布",
            "curtain",
            "blind",
            "shade",
        ],
        "airer" => &["晾衣架", "晾衣机", "衣架", "airer"],
        "switch" => &["插座", "开关", "排插", "插线板", "switch", "outlet", "plug"],
        "camera" => &["摄像头", "监控", "摄像机", "camera"],
        "lock" => &["门锁", "锁", "lock"],
        "television" => &[
            "电视",
            "电视机",
            "投影仪",
            "投影机",
            "television",
            "tv",
            "projector",
        ],
        "speaker" => &["音箱", "音响", "小爱同学", "speaker"],
        "sensor" => &["传感器", "温度计", "湿度计", "温湿度计"],
        "air_purifier" => &["净化器", "空气净化器", "purifier"],
        "fresh_air_system" => &["新风", "新风系统", "新风机", "fresh air"],
        "humidifier" => &["加湿器", "humidifier"],
        "dehumidifier" => &["除湿机", "抽湿机", "dehumidifier"],
        "vacuum" => &[
            "扫地机",
            "扫地机器人",
            "吸尘器",
            "扫拖机器人",
            "vacuum",
            "robot vacuum",
        ],
        "water_heater" => &["热水器", "water heater"],
        "heater" => &["电暖器", "取暖器", "暖风机", "heater"],
        "bathroom_heater" => &["浴霸", "bathroom heater"],
        "washing_machine" => &["洗衣机", "washing machine"],
        "dishwasher" => &["洗碗机", "dishwasher"],
        "refrigerator" => &["冰箱", "refrigerator", "fridge"],
        "cooker" => &["电饭煲", "电饭锅", "电压力锅", "cooker"],
        "water_purifier" => &["净水器", "water purifier"],
        _ => &[],
    }
}

fn parse_local_intent(catalog: &DeviceCatalog, text: &str) -> Option<AssistantIntent> {
    let normalized = normalize_text(text);
    if normalized.is_empty() {
        return Some(help_intent(0.1));
    }
    if matches!(
        normalized.as_str(),
        "帮助" | "help" | "能做什么" | "怎么用" | "示例"
    ) {
        return Some(help_intent(1.0));
    }

    if let Some(device_query) = detect_device_query(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::QueryDevices,
            target: IntentTarget::default(),
            capability: Some(device_query.to_string()),
            value: Value::Null,
            scene: None,
            confidence: 0.96,
        });
    }

    if let Some(scene) = match_scene(catalog, &normalized) {
        return Some(AssistantIntent {
            action: IntentAction::RunScene,
            target: IntentTarget {
                home: scene.home_name.clone().into(),
                room: None,
                device: None,
                all: false,
                exclude_rooms: Vec::new(),
                exclude_devices: Vec::new(),
                exclude_categories: Vec::new(),
            },
            capability: None,
            value: Value::Null,
            scene: Some(scene.name.clone()),
            confidence: 0.96,
        });
    }

    if is_query(&normalized) {
        let target = extract_target(catalog, &normalized);
        let capability = query_capability(&normalized);
        return Some(AssistantIntent {
            action: IntentAction::QueryState,
            target,
            capability: Some(capability),
            value: Value::Null,
            scene: None,
            confidence: 0.88,
        });
    }

    let target = extract_target(catalog, &normalized);
    if let Some(value) = extract_mute(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some("mute".to_string()),
            value: json!(value),
            scene: None,
            confidence: 0.94,
        });
    }
    if let Some(action) = extract_lock_action(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(action.to_string()),
            value: json!(true),
            scene: None,
            confidence: 0.92,
        });
    }
    if let Some(action) = extract_media_action(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(action.to_string()),
            value: json!(true),
            scene: None,
            confidence: 0.91,
        });
    }
    if let Some(action) = extract_appliance_action(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(action.to_string()),
            value: json!(true),
            scene: None,
            confidence: 0.9,
        });
    }
    if let Some(adjustment) = extract_relative_adjustment(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::AdjustDevice,
            target: target.clone(),
            capability: Some(adjustment.capability),
            value: json!({
                "direction": adjustment.direction,
                "amount": adjustment.amount,
                "unit": adjustment.unit,
            }),
            scene: None,
            confidence: 0.9,
        });
    }
    if let Some((capability, value)) = extract_position(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(capability),
            value,
            scene: None,
            confidence: 0.91,
        });
    }
    if let Some((capability, value)) = extract_curtain_control(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(capability),
            value,
            scene: None,
            confidence: 0.92,
        });
    }
    if let Some((capability, value)) = extract_color_temperature(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(capability),
            value,
            scene: None,
            confidence: 0.92,
        });
    }
    if let Some((capability, value)) = extract_color(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(capability),
            value,
            scene: None,
            confidence: 0.9,
        });
    }
    if let Some((capability, value)) = extract_volume(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(capability),
            value,
            scene: None,
            confidence: 0.92,
        });
    }
    if let Some((capability, value)) = extract_humidity(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(capability),
            value,
            scene: None,
            confidence: 0.91,
        });
    }
    if let Some((value, capability)) = extract_temperature(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(capability),
            value: json!(value),
            scene: None,
            confidence: 0.93,
        });
    }
    if let Some((capability, value)) = extract_fan_setting(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(capability),
            value,
            scene: None,
            confidence: 0.9,
        });
    }
    if let Some(value) = extract_brightness(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some("brightness".to_string()),
            value,
            scene: None,
            confidence: 0.91,
        });
    }
    if let Some((capability, value)) = extract_swing(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(capability),
            value,
            scene: None,
            confidence: 0.9,
        });
    }
    if let Some((mode, value)) = extract_mode(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target: target.clone(),
            capability: Some(mode),
            value,
            scene: None,
            confidence: 0.88,
        });
    }
    if let Some(on) = extract_power(&normalized) {
        return Some(AssistantIntent {
            action: IntentAction::SetDevice,
            target,
            capability: Some("on".to_string()),
            value: json!(on),
            scene: None,
            confidence: 0.94,
        });
    }
    Some(help_intent(0.2))
}

fn help_intent(confidence: f32) -> AssistantIntent {
    AssistantIntent {
        action: IntentAction::Help,
        target: IntentTarget::default(),
        capability: None,
        value: Value::Null,
        scene: None,
        confidence,
    }
}

fn normalize_text(text: &str) -> String {
    text.trim()
        .to_ascii_lowercase()
        .replace(['，', '。', '！', '？', '：', '；'], " ")
        .replace(['“', '”', '‘', '’'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("")
}

fn normalize_device_reference(text: &str) -> String {
    normalize_text(text)
        .replace("吊扇灯", "风扇灯")
        .replace("吊扇", "风扇")
        .replace("fan-light", "风扇灯")
        .replace("fanlight", "风扇灯")
        .replace("ceiling-fan", "风扇")
        .replace("ceilingfan", "风扇")
}

fn match_scene<'a>(catalog: &'a DeviceCatalog, text: &str) -> Option<&'a CatalogScene> {
    let candidates: Vec<&CatalogScene> = catalog
        .scenes
        .iter()
        .filter(|scene| {
            let name = normalize_text(&scene.name);
            !name.is_empty()
                && (text == name
                    || text.contains(&name)
                    || (matches!(text, "回家" | "离家" | "睡眠" | "观影" | "起床" | "晚安")
                        && name.contains(text)))
        })
        .collect();
    if let Some(exact) = candidates
        .iter()
        .find(|scene| normalize_text(&scene.name) == text)
    {
        return Some(*exact);
    }
    let longest = candidates
        .iter()
        .map(|scene| scene.name.chars().count())
        .max()?;
    let best: Vec<&CatalogScene> = candidates
        .into_iter()
        .filter(|scene| scene.name.chars().count() == longest)
        .collect();
    (best.len() == 1).then(|| best[0])
}

fn is_query(text: &str) -> bool {
    let asks_for_value = [
        "状态",
        "多少",
        "几度",
        "是否",
        "开着吗",
        "关着吗",
        "开着没",
        "关着没",
        "开着",
        "关着",
        "温度",
        "湿度",
        "电量",
        "音量",
        "色温",
        "开合度",
        "播放状态",
        "开了吗",
        "开了没",
        "关了吗",
        "关了没",
        "有没有开",
        "有没有关",
        "开没开",
        "关没关",
        "锁了吗",
        "锁了没",
        "在运行",
        "运行吗",
        "工作吗",
        "亮着吗",
        "还亮",
        "颜色",
        "什么颜色",
        "颜色是什么",
        "摇头吗",
        "摆风吗",
        "扫风吗",
        "关好",
        "锁好",
        "剩余电量",
        "还有多少电",
        "电量还有",
        "空气质量",
        "pm2.5",
        "pm10",
        "co2",
        "有人吗",
        "漏水",
        "ison",
        "isoff",
        "status",
        "howmuch",
        "howmany",
        "temperature",
        "brightness",
        "humidity",
        "battery",
        "volume",
        "powerstatus",
        "color",
        "islighton",
        "isthelighton",
        "isacon",
        "isfanon",
    ]
    .iter()
    .any(|word| text.contains(word));
    asks_for_value && !has_control_verb(text) && !has_relative_marker(text)
}

fn query_capability(text: &str) -> String {
    if text.contains("pm2.5") || text.contains("pm25") {
        return "pm2_5".to_string();
    }
    if text.contains("pm10") {
        return "pm10".to_string();
    }
    if text.contains("co2") || text.contains("二氧化碳") {
        return "co2".to_string();
    }
    if text.contains("湿度") {
        return "relative_humidity".to_string();
    }
    if text.contains("电量") || text.contains("电池") || text.contains("battery") {
        return "battery_level".to_string();
    }
    if text.contains("亮度") || text.contains("brightness") {
        return "brightness".to_string();
    }
    if text.contains("风速") || text.contains("风量") || text.contains("fanspeed") {
        return "fan_level".to_string();
    }
    if text.contains("模式") {
        return "mode".to_string();
    }
    if text.contains("音量") || text.contains("volume") {
        return "volume".to_string();
    }
    if text.contains("静音") {
        return "mute".to_string();
    }
    if text.contains("色温") || text.contains("colortemperature") {
        return "color_temperature".to_string();
    }
    if text.contains("颜色")
        || text.contains("什么色")
        || (text.contains("color") && !text.contains("colortemperature"))
    {
        return "color".to_string();
    }
    if text.contains("左右")
        && (text.contains("摆风") || text.contains("扫风") || text.contains("swing"))
    {
        return "horizontal_swing".to_string();
    }
    if text.contains("上下")
        && (text.contains("摆风") || text.contains("扫风") || text.contains("swing"))
    {
        return "vertical_swing".to_string();
    }
    if text.contains("摇头") || text.contains("oscillat") {
        return "oscillate".to_string();
    }
    if text.contains("播放") {
        return "playing_state".to_string();
    }
    if text.contains("开合")
        || text.contains("位置")
        || text.contains("position")
        || text.contains("openpercent")
    {
        return "current_position".to_string();
    }
    if text.contains("漏水") || text.contains("浸水") {
        return "water_leak".to_string();
    }
    if text.contains("有人") || text.contains("人体") || text.contains("移动") {
        return "motion_state".to_string();
    }
    if mentions_curtain(text) {
        return "current_position".to_string();
    }
    if text.contains("门")
        || text.contains("窗")
        || text.contains("关好")
        || text.contains("锁好")
        || text.contains("door")
        || text.contains("window")
        || text.contains("lock")
    {
        return "door_state".to_string();
    }
    if text.contains("温度") || text.contains("几度") || text.contains("temperature") {
        return "current_temperature".to_string();
    }
    "on".to_string()
}

fn detect_device_query(text: &str) -> Option<&'static str> {
    if has_control_verb(text) {
        return None;
    }
    let mentions_devices = text.contains("设备") || text.contains("device");
    let online = text.contains("在线") || text.contains("online");
    let offline = text.contains("离线") || text.contains("掉线") || text.contains("offline");
    let asks_count = text.contains("几个")
        || text.contains("多少")
        || text.contains("数量")
        || text.contains("总数")
        || text.contains("how many");
    let asks_list = text.contains("哪些")
        || text.contains("哪个")
        || text.contains("列出")
        || text.contains("名单")
        || text.contains("which");
    let asks_overview = text.contains("在线情况")
        || text.contains("离线情况")
        || text.contains("状态总览")
        || text.contains("设备概况")
        || text.contains("overview");

    if mentions_devices && offline && asks_list {
        return Some("offline_list");
    }
    if mentions_devices && online && asks_list {
        return Some("online_list");
    }
    if mentions_devices && offline && (asks_count || asks_overview) {
        return Some("offline_count");
    }
    if mentions_devices && online && (asks_count || asks_overview) {
        return Some("online_count");
    }
    if mentions_devices
        && (asks_count || asks_overview)
        && (text.contains("一共")
            || text.contains("总共")
            || text.contains("所有")
            || asks_overview)
    {
        return Some("all_count");
    }
    None
}

fn has_control_verb(text: &str) -> bool {
    [
        "打开",
        "开启",
        "开机",
        "启动",
        "关掉",
        "关闭",
        "关机",
        "关上",
        "停止",
        "调到",
        "调成",
        "调至",
        "设成",
        "设为",
        "设置",
        "保持",
        "维持",
        "调高",
        "调低",
        "升高",
        "降低",
        "调亮",
        "调暗",
        "点亮",
        "亮灯",
        "熄灯",
        "灭灯",
        "开始清扫",
        "暂停清扫",
        "回充",
        "turnon",
        "turnoff",
        "switchon",
        "switchoff",
    ]
    .iter()
    .any(|verb| text.contains(verb))
}

fn extract_power(text: &str) -> Option<bool> {
    if [
        "关闭",
        "关掉",
        "关上",
        "关机",
        "关一下",
        "关了",
        "断电",
        "停止",
        "休眠",
        "熄灭",
        "熄灯",
        "灭灯",
        "停用",
        "turnoff",
        "switchoff",
        "poweroff",
        "shutoff",
    ]
    .iter()
    .any(|word| text.contains(word))
        || text == "关"
        || text.starts_with("关")
    {
        return Some(false);
    }
    if [
        "打开",
        "开启",
        "开机",
        "开一下",
        "开了",
        "启动",
        "通电",
        "唤醒",
        "点亮",
        "亮灯",
        "启用",
        "turnon",
        "switchon",
        "poweron",
    ]
    .iter()
    .any(|word| text.contains(word))
        || text == "开"
        || text.starts_with("开")
    {
        return Some(true);
    }
    None
}

fn extract_mute(text: &str) -> Option<bool> {
    if text.contains("静音模式") || text.contains("安静模式") {
        return None;
    }
    if ["取消静音", "关闭静音", "解除静音", "打开声音", "恢复声音"]
        .iter()
        .any(|word| text.contains(word))
    {
        return Some(false);
    }
    if ["静音", "关闭声音", "关掉声音", "声音关掉"]
        .iter()
        .any(|word| text.contains(word))
    {
        return Some(true);
    }
    None
}

fn extract_lock_action(text: &str) -> Option<&'static str> {
    if ["开锁", "解锁", "打开门锁", "开门锁", "把锁打开", "unlock"]
        .iter()
        .any(|word| text.contains(word))
    {
        return Some("unlock");
    }
    if [
        "上锁",
        "锁门",
        "锁上",
        "反锁",
        "关闭门锁",
        "把门锁上",
        "lockdoor",
    ]
    .iter()
    .any(|word| text.contains(word))
    {
        return Some("lock");
    }
    None
}

fn extract_media_action(text: &str) -> Option<&'static str> {
    if mentions_curtain(text) || mentions_airer(text) {
        return None;
    }
    if text.contains("下一首") || text.contains("下一个") || text.contains("nextsong") {
        return Some("next");
    }
    if text.contains("上一首") || text.contains("上一个") || text.contains("previoussong") {
        return Some("previous");
    }
    if text.contains("继续播放")
        || text == "播放"
        || text.contains("播放音乐")
        || text.contains("resume")
    {
        return Some("play");
    }
    if text == "暂停" || text.contains("暂停播放") || text.contains("pause") {
        return Some("pause");
    }
    None
}

fn mentions_curtain(text: &str) -> bool {
    [
        "窗帘",
        "卷帘",
        "百叶窗",
        "纱帘",
        "遮阳帘",
        "幕布",
        "curtain",
        "blind",
    ]
    .iter()
    .any(|word| text.contains(word))
}

fn mentions_airer(text: &str) -> bool {
    ["晾衣架", "晾衣机", "衣架", "airer"]
        .iter()
        .any(|word| text.contains(word))
}

fn mentions_light(text: &str) -> bool {
    category_words("light")
        .iter()
        .any(|word| text.contains(word))
}

fn extract_appliance_action(text: &str) -> Option<&'static str> {
    let cleaning = text.contains("清扫")
        || text.contains("扫地")
        || text.contains("打扫")
        || text.contains("吸尘")
        || text.contains("clean");
    let vacuum_context = cleaning
        || text.contains("扫地机")
        || text.contains("扫地机器人")
        || text.contains("扫拖机器人")
        || text.contains("vacuum");
    if cleaning
        && (text.contains("暂停")
            || text.contains("停止")
            || text.contains("别扫")
            || text.contains("停下"))
    {
        return Some("stop_sweep");
    }
    if text.contains("回充")
        || text.contains("回去充电")
        || text.contains("返回充电")
        || text.contains("去充电")
        || (vacuum_context && text.contains("充电"))
        || text.contains("回基站")
        || text.contains("回座")
        || text.contains("returntocharge")
    {
        return Some("return_to_charge");
    }
    if cleaning
        && (text.contains("开始")
            || text.contains("启动")
            || text.contains("扫一下")
            || text.contains("打扫一下")
            || text.contains("清扫一下")
            || text.contains("继续扫")
            || text.contains("接着扫")
            || text == "扫地"
            || text.starts_with("开始"))
    {
        return Some("start_sweep");
    }
    None
}

struct RelativeAdjustment {
    capability: String,
    direction: AdjustmentDirection,
    amount: Option<f64>,
    unit: AdjustmentUnit,
}

fn extract_relative_adjustment(text: &str) -> Option<RelativeAdjustment> {
    if ["暖光", "冷光", "白光", "自然光", "暖白", "冷白"]
        .iter()
        .any(|word| text.contains(word))
        && !has_relative_marker(text)
    {
        return None;
    }
    let capability = if text.contains("音量")
        || text.contains("声音")
        || text.contains("声大")
        || text.contains("声小")
        || text.contains("响一点")
        || text.contains("太响")
        || text.contains("volume")
        || text.contains("louder")
        || text.contains("quieter")
    {
        "volume"
    } else if text.contains("开合")
        || text.contains("开度")
        || mentions_curtain(text)
        || text.contains("位置")
    {
        "current_position"
    } else if text.contains("风速")
        || text.contains("风量")
        || text.contains("风")
        || text.contains("闷")
        || text.contains("不透气")
        || text.contains("fan")
        || text.contains("wind")
        || text.contains("faster")
        || text.contains("slower")
    {
        "fan_level"
    } else if text.contains("色温")
        || ((text.contains("灯光") || text.contains("灯")) && has_warm_cool_word(text))
    {
        "color_temperature"
    } else if text.contains("亮度")
        || text.contains("调亮")
        || text.contains("调暗")
        || text.contains("亮一点")
        || text.contains("亮一些")
        || text.contains("暗一点")
        || text.contains("暗一些")
        || text.contains("太亮")
        || text.contains("太暗")
        || text.contains("更亮")
        || text.contains("更暗")
        || text.contains("再亮")
        || text.contains("再暗")
        || text.contains("刺眼")
        || text.contains("晃眼")
        || text.contains("太黑")
        || text.contains("看不见")
        || text.contains("bright")
        || text.contains("dim")
        || text.contains("darker")
    {
        "brightness"
    } else if text.contains("温度")
        || text.contains("空调")
        || text.contains("暖气")
        || text.contains("冷")
        || text.contains("热")
        || text.contains("暖")
        || text.contains("凉")
        || text.contains("temperature")
        || text.contains("warm")
        || text.contains("cool")
        || text.contains("hot")
        || text.contains("cold")
    {
        "target_temperature"
    } else {
        return None;
    };

    let direction = adjustment_direction(capability, text)?;
    let (amount, unit) =
        extract_adjustment_amount(text).unwrap_or((None, default_adjustment_unit(capability)));
    Some(RelativeAdjustment {
        capability: capability.to_string(),
        direction,
        amount,
        unit,
    })
}

fn has_relative_marker(text: &str) -> bool {
    [
        "一点",
        "一些",
        "稍微",
        "调高",
        "调低",
        "升高",
        "降低",
        "调亮",
        "调暗",
        "调暖",
        "调冷",
        "更亮",
        "更暗",
        "再亮",
        "再暗",
        "大点",
        "小点",
        "高点",
        "低点",
        "亮些",
        "暗些",
        "白一点",
        "黄一点",
        "再高",
        "再低",
        "强一点",
        "弱一点",
        "柔和一点",
        "小点声",
        "大点声",
        "响一点",
        "轻一点",
        "brighter",
        "dimmer",
        "warmer",
        "cooler",
        "hotter",
        "colder",
        "increase",
        "decrease",
        "higher",
        "lower",
        "abit",
        "alittle",
        "turnup",
        "turndown",
        "louder",
        "quieter",
        "faster",
        "slower",
    ]
    .iter()
    .any(|word| text.contains(word))
}

fn has_warm_cool_word(text: &str) -> bool {
    ["暖", "冷", "黄", "白", "warm", "cool", "yellow", "white"]
        .iter()
        .any(|word| text.contains(word))
}

fn adjustment_direction(capability: &str, text: &str) -> Option<AdjustmentDirection> {
    if capability == "color_temperature" {
        if ["暖", "黄", "warm", "yellow"]
            .iter()
            .any(|word| text.contains(word))
        {
            return Some(AdjustmentDirection::Decrease);
        }
        if ["冷", "白", "cool", "white"]
            .iter()
            .any(|word| text.contains(word))
        {
            return Some(AdjustmentDirection::Increase);
        }
    }
    if capability == "current_position" {
        if ["打开一点", "开一点", "拉开一点", "再打开", "再拉开"]
            .iter()
            .any(|word| text.contains(word))
        {
            return Some(AdjustmentDirection::Increase);
        }
        if ["关一点", "合一点", "拉上一点", "再关上", "再拉上"]
            .iter()
            .any(|word| text.contains(word))
        {
            return Some(AdjustmentDirection::Decrease);
        }
    }
    let increase = [
        "调高",
        "升高",
        "提高",
        "增大",
        "变大",
        "调大",
        "大一点",
        "大一些",
        "大点",
        "开大",
        "增强",
        "亮一点",
        "亮一些",
        "亮些",
        "调亮",
        "更亮",
        "再亮",
        "太暗",
        "热一点",
        "热些",
        "暖一点",
        "升温",
        "往上",
        "高一点",
        "高点",
        "加一档",
        "调大一档",
        "有点冷",
        "太低",
        "温度不够",
        "有点闷",
        "太闷",
        "风太小",
        "风力不够",
        "声音太小",
        "太小声",
        "太轻",
        "暖和一点",
        "热乎一点",
        "凉快一点",
        "强一点",
        "brighter",
        "increase",
        "higher",
        "warmer",
        "hotter",
        "turnup",
        "louder",
        "faster",
    ];
    if increase.iter().any(|word| text.contains(word)) {
        return Some(AdjustmentDirection::Increase);
    }
    let decrease = [
        "调低",
        "降低",
        "减小",
        "变小",
        "调小",
        "小一点",
        "小一些",
        "小点",
        "关小",
        "减弱",
        "暗一点",
        "暗一些",
        "暗些",
        "调暗",
        "更暗",
        "太亮",
        "冷一点",
        "凉一点",
        "降温",
        "往下",
        "低一点",
        "低点",
        "减一档",
        "调小一档",
        "有点热",
        "太高",
        "闷热",
        "风太大",
        "声音太大",
        "太响",
        "刺眼",
        "晃眼",
        "弱一点",
        "柔和一点",
        "小点声",
        "dimmer",
        "decrease",
        "lower",
        "cooler",
        "colder",
        "turndown",
        "quieter",
        "slower",
    ];
    if decrease.iter().any(|word| text.contains(word)) {
        return Some(AdjustmentDirection::Decrease);
    }
    if text.contains("太热") || text.contains("太吵") || text.contains("声音太大") {
        return Some(AdjustmentDirection::Decrease);
    }
    if text.contains("太冷") || text.contains("声音太小") {
        return Some(AdjustmentDirection::Increase);
    }
    None
}

fn default_adjustment_unit(capability: &str) -> AdjustmentUnit {
    match capability {
        "brightness" | "volume" | "current_position" => AdjustmentUnit::Percent,
        "color_temperature" => AdjustmentUnit::Kelvin,
        "fan_level" => AdjustmentUnit::Step,
        _ => AdjustmentUnit::Degree,
    }
}

fn extract_adjustment_amount(text: &str) -> Option<(Option<f64>, AdjustmentUnit)> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        let mut end = index;
        while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
            end += 1;
        }
        let Ok(amount) = text[start..end].parse::<f64>() else {
            index = end.max(index + 1);
            continue;
        };
        if let Some(unit) = adjustment_unit_at(&text[end..]) {
            return Some((Some(amount), unit));
        }
        index = end.max(index + 1);
    }

    for (word, amount) in [
        ("一半", 50.0),
        ("半度", 0.5),
        ("半档", 0.5),
        ("十度", 10.0),
        ("十档", 10.0),
        ("九度", 9.0),
        ("八度", 8.0),
        ("七度", 7.0),
        ("六度", 6.0),
        ("五度", 5.0),
        ("四度", 4.0),
        ("三度", 3.0),
        ("两度", 2.0),
        ("二度", 2.0),
        ("一度", 1.0),
        ("十级", 10.0),
        ("九级", 9.0),
        ("八级", 8.0),
        ("七级", 7.0),
        ("六级", 6.0),
        ("五级", 5.0),
        ("四级", 4.0),
        ("三级", 3.0),
        ("两级", 2.0),
        ("二级", 2.0),
        ("一级", 1.0),
        ("三档", 3.0),
        ("两档", 2.0),
        ("二档", 2.0),
        ("一档", 1.0),
    ] {
        if text.contains(word) {
            let unit = if word.ends_with('%') || word == "一半" {
                AdjustmentUnit::Percent
            } else if word.ends_with('档') || word.ends_with('级') {
                AdjustmentUnit::Step
            } else {
                AdjustmentUnit::Degree
            };
            return Some((Some(amount), unit));
        }
    }
    None
}

fn adjustment_unit_at(rest: &str) -> Option<AdjustmentUnit> {
    let rest = rest.trim_start();
    if rest.starts_with('%') {
        Some(AdjustmentUnit::Percent)
    } else if rest.starts_with('度') || rest.starts_with('℃') {
        Some(AdjustmentUnit::Degree)
    } else if rest.starts_with('档') || rest.starts_with('级') {
        Some(AdjustmentUnit::Step)
    } else if rest.starts_with('k') || rest.starts_with('开') {
        Some(AdjustmentUnit::Kelvin)
    } else {
        None
    }
}

fn extract_temperature(text: &str) -> Option<(i64, String)> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        let mut end = index;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end < bytes.len() && has_temperature_suffix(&text[end..]) {
            if let Ok(value) = text[start..end].parse::<i64>() {
                if temperature_target_allowed(text, value) {
                    return Some((value, "target_temperature".to_string()));
                }
            }
        }
        index = end.max(index + 1);
    }
    if let Some(value) = extract_chinese_number_before_suffix(text, "度") {
        if temperature_target_allowed(text, value) {
            return Some((value, "target_temperature".to_string()));
        }
    }
    if text.contains("空调")
        || text.contains("温度")
        || text.contains("temperature")
        || text.contains("settemp")
    {
        if let Some(value) = extract_number_after_any(
            text,
            &[
                "调到",
                "调至",
                "调成",
                "设成",
                "设为",
                "设置",
                "保持",
                "维持",
                "temperatureto",
                "settemperatureto",
                "settemperature",
                "settemp",
            ],
        ) {
            if temperature_target_allowed(text, value) {
                return Some((value, "target_temperature".to_string()));
            }
        }
    }
    None
}

fn temperature_target_allowed(text: &str, value: i64) -> bool {
    let broad_range = [
        "热水器",
        "water heater",
        "waterheater",
        "地暖",
        "采暖",
        "暖气",
        "冰箱",
        "冷藏",
        "冷冻",
        "refrigerator",
        "fridge",
    ]
    .iter()
    .any(|word| text.contains(word));
    if broad_range {
        (0..=100).contains(&value)
    } else {
        (10..=35).contains(&value)
    }
}

fn has_temperature_suffix(text: &str) -> bool {
    text.starts_with('度')
        || text.starts_with('℃')
        || text.starts_with("°c")
        || text.starts_with("摄氏度")
        || text.starts_with("degrees")
        || text.starts_with("degree")
        || text.starts_with("celsius")
}

fn extract_percentage(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        let mut end = index;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end < bytes.len() && text[end..].starts_with('%') {
            if let Ok(value) = text[start..end].parse::<i64>() {
                if (0..=100).contains(&value) {
                    return Some(value);
                }
            }
        }
        index = end.max(index + 1);
    }
    if let Some(value) = extract_chinese_number_after(text, "百分之") {
        if (0..=100).contains(&value) {
            return Some(value);
        }
    }
    if let Some(value) = extract_number_before_suffix(text, "percent") {
        if (0..=100).contains(&value) {
            return Some(value);
        }
    }
    if text.contains("一半") {
        return Some(50);
    }
    None
}

fn extract_position(text: &str) -> Option<(String, Value)> {
    if !mentions_curtain(text)
        && !text.contains("开合")
        && !text.contains("开度")
        && !text.contains("位置")
    {
        return None;
    }
    if let Some(percent) = extract_percentage(text) {
        return Some((
            "current_position".to_string(),
            json!({ "percent": percent }),
        ));
    }
    if text.contains("一半") {
        return Some(("current_position".to_string(), json!({ "percent": 50 })));
    }
    let value = extract_number_after_any(
        text,
        &[
            "开到",
            "调到",
            "调至",
            "打开到",
            "打开至",
            "拉到",
            "拉至",
            "open",
            "closeto",
            "to",
        ],
    )?;
    (0..=100)
        .contains(&value)
        .then(|| ("current_position".to_string(), json!({ "percent": value })))
}

fn extract_curtain_control(text: &str) -> Option<(String, Value)> {
    let curtain = mentions_curtain(text);
    let airer = mentions_airer(text);
    if !curtain && !airer {
        return None;
    }
    if text.contains("暂停")
        || text.contains("停一下")
        || text.contains("停止")
        || text.contains("停住")
        || text.contains("pause")
        || text.contains("stop")
    {
        return Some(("motor_control".to_string(), json!("pause")));
    }
    if airer
        && ["上升", "升起", "升高", "往上升", "升起", "up"]
            .iter()
            .any(|word| text.contains(word))
    {
        return Some(("motor_control".to_string(), json!("open")));
    }
    if airer
        && ["下降", "降下", "降低", "往下降", "down"]
            .iter()
            .any(|word| text.contains(word))
    {
        return Some(("motor_control".to_string(), json!("close")));
    }
    if ["打开", "开启", "拉开", "展开", "open"]
        .iter()
        .any(|word| text.contains(word))
    {
        return Some(("motor_control".to_string(), json!("open")));
    }
    if ["关闭", "关上", "拉上", "收起", "close"]
        .iter()
        .any(|word| text.contains(word))
    {
        return Some(("motor_control".to_string(), json!("close")));
    }
    None
}

fn extract_color_temperature(text: &str) -> Option<(String, Value)> {
    if !text.contains("色温")
        && !text.contains("暖光")
        && !text.contains("冷光")
        && !text.contains("白光")
        && !text.contains("黄光")
        && !text.contains("自然光")
        && !text.contains("中性光")
    {
        return None;
    }
    if text.contains("暖光") || text.contains("暖白") || text.contains("黄光") {
        return Some(("color_temperature".to_string(), json!("warm")));
    }
    if text.contains("冷光") || text.contains("冷白") {
        return Some(("color_temperature".to_string(), json!("cool")));
    }
    if text.contains("自然光") || text.contains("中性光") || text.contains("白光") {
        return Some(("color_temperature".to_string(), json!("natural")));
    }
    if let Some(percent) = extract_percentage(text) {
        return Some((
            "color_temperature".to_string(),
            json!({ "percent": percent }),
        ));
    }
    if let Some(value) = extract_number_before_suffix(text, "k")
        .or_else(|| extract_number_before_suffix(text, "开"))
        .or_else(|| {
            extract_number_after_any(text, &["色温", "调到", "调至", "调成", "设成", "设为"])
        })
    {
        return Some(("color_temperature".to_string(), json!(value)));
    }
    None
}

fn extract_color(text: &str) -> Option<(String, Value)> {
    if !mentions_light(text) {
        return None;
    }
    let explicit_color = text.contains("颜色")
        || text.contains("彩色")
        || text.contains("rgb")
        || text.contains("色灯");
    for (names, rgb) in [
        (&["红色", "红光", "red"][..], 0x00ff0000_i64),
        (&["橙色", "橘色", "橙光", "orange"][..], 0x00ff8000_i64),
        (&["黄色", "黄光", "yellow"][..], 0x00ffff00_i64),
        (&["绿色", "绿光", "green"][..], 0x0000ff00_i64),
        (&["青色", "青蓝", "青光", "cyan"][..], 0x0000ffff_i64),
        (&["蓝色", "天蓝", "蓝光", "blue"][..], 0x000000ff_i64),
        (&["紫色", "紫光", "purple"][..], 0x008000ff_i64),
        (&["粉色", "粉红", "桃红", "pink"][..], 0x00ff66cc_i64),
        (&["白色", "white"][..], 0x00ffffff_i64),
    ] {
        if names.iter().any(|name| text.contains(name)) {
            return Some(("color".to_string(), json!(rgb)));
        }
    }
    if explicit_color {
        if let Some(value) = extract_number_after_any(text, &["rgb", "颜色", "色值"]) {
            if (0..=0x00ff_ffff).contains(&value) {
                return Some(("color".to_string(), json!(value)));
            }
        }
    }
    None
}

fn extract_volume(text: &str) -> Option<(String, Value)> {
    if !text.contains("音量")
        && !text.contains("声音")
        && !text.contains("声大")
        && !text.contains("声小")
        && !text.contains("响一点")
        && !text.contains("volume")
    {
        return None;
    }
    if text.contains("最大") || text.contains("最响") {
        return Some(("volume".to_string(), json!("max")));
    }
    if text.contains("最小") || text.contains("最轻") {
        return Some(("volume".to_string(), json!("min")));
    }
    if let Some(percent) = extract_percentage(text) {
        return Some(("volume".to_string(), json!({ "percent": percent })));
    }
    let value = extract_number_after_any(
        text,
        &[
            "音量", "声音", "调到", "调至", "调成", "设成", "设为", "volume", "to",
        ],
    )?;
    Some(("volume".to_string(), json!(value)))
}

fn extract_humidity(text: &str) -> Option<(String, Value)> {
    if !text.contains("湿度") && !text.contains("humidity") {
        return None;
    }
    let value = extract_percentage(text).or_else(|| {
        extract_number_after_any(
            text,
            &["湿度", "调到", "调至", "调成", "设成", "设为", "设置"],
        )
    })?;
    if !(1..=100).contains(&value) {
        return None;
    }
    Some(("relative_humidity".to_string(), json!(value)))
}

fn extract_fan_setting(text: &str) -> Option<(String, Value)> {
    let mentions_fan = text.contains("风速")
        || text.contains("风量")
        || text.contains("风扇")
        || text.contains("电扇")
        || text.contains("fanspeed")
        || text.contains("fanlevel");
    let mentions_level = text.contains("档") || text.contains("级");
    if !mentions_fan && !mentions_level {
        return None;
    }
    if text.contains("自然风")
        || text.contains("直吹风")
        || text.contains("循环风")
        || text.contains("睡眠风")
    {
        let value = if text.contains("自然风") {
            "natural"
        } else if text.contains("直吹风") {
            "straight"
        } else if text.contains("循环风") {
            "circulate"
        } else {
            "sleep"
        };
        return Some(("mode".to_string(), json!(value)));
    }
    if text.contains("最大") || text.contains("强风") || text.contains("高档") {
        return Some(("fan_level".to_string(), json!("max")));
    }
    if text.contains("最小") || text.contains("弱风") || text.contains("低档") {
        return Some(("fan_level".to_string(), json!("min")));
    }
    if text.contains("中风") || text.contains("中档") {
        return Some(("fan_level".to_string(), json!("medium")));
    }
    if let Some(percent) = extract_percentage(text) {
        return Some(("fan_level".to_string(), json!({ "percent": percent })));
    }
    let value = extract_number_after_any(
        text,
        &[
            "风速", "风量", "调到", "调至", "调成", "设成", "设为", "fanspeed", "fanlevel", "to",
        ],
    )
    .or_else(|| extract_number_before_suffix(text, "档"))
    .or_else(|| extract_number_before_suffix(text, "级"))?;
    Some(("fan_level".to_string(), json!(value)))
}

fn extract_swing(text: &str) -> Option<(String, Value)> {
    let off = text.contains("关闭")
        || text.contains("关掉")
        || text.contains("停止")
        || text.contains("取消")
        || text.contains("off");
    if text.contains("摇头") || text.contains("oscillat") {
        return Some(("oscillate".to_string(), json!(!off)));
    }
    if text.contains("左右")
        && (text.contains("摆风") || text.contains("扫风") || text.contains("swing"))
    {
        return Some(("horizontal_swing".to_string(), json!(!off)));
    }
    if text.contains("上下")
        && (text.contains("摆风") || text.contains("扫风") || text.contains("swing"))
    {
        return Some(("vertical_swing".to_string(), json!(!off)));
    }
    None
}

fn extract_brightness(text: &str) -> Option<Value> {
    if !text.contains("亮度")
        && !text.contains("灯光")
        && !text.contains("灯")
        && !text.contains("brightness")
        && !text.contains("light")
    {
        return None;
    }
    if text.contains("最亮") || text.contains("全亮") {
        return Some(json!("max"));
    }
    if text.contains("最暗") {
        return Some(json!("min"));
    }
    if let Some(percent) = extract_percentage(text) {
        return Some(json!({ "percent": percent }));
    }
    let value = extract_number_after_any(
        text,
        &[
            "亮度",
            "调到",
            "调至",
            "调成",
            "设为",
            "设成",
            "开到",
            "brightness",
            "to",
        ],
    )?;
    (0..=100).contains(&value).then(|| json!(value))
}

fn extract_number_after_any(text: &str, keywords: &[&str]) -> Option<i64> {
    let mut best: Option<(usize, i64)> = None;
    for keyword in keywords {
        let Some(position) = text.find(keyword) else {
            continue;
        };
        let rest = &text[position + keyword.len()..];
        if let Some(value) =
            extract_first_number(rest).or_else(|| extract_chinese_number_from_text(rest))
        {
            if best.is_none_or(|(earlier, _)| position < earlier) {
                best = Some((position, value));
            }
        }
    }
    best.map(|(_, value)| value)
}

fn extract_number_before_suffix(text: &str, suffix: &str) -> Option<i64> {
    let position = text.find(suffix)?;
    let prefix = &text[..position];
    let bytes = text.as_bytes();
    let mut index = 0;
    let mut last = None;
    while index < prefix.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        let mut end = index;
        while end < prefix.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if let Ok(value) = prefix[start..end].parse::<i64>() {
            last = Some(value);
        }
        index = end.max(index + 1);
    }
    last.or_else(|| extract_chinese_number_before_suffix(text, suffix))
}

fn extract_first_number(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        let mut end = index;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if let Ok(value) = text[start..end].parse::<i64>() {
            return Some(value);
        }
        index = end.max(index + 1);
    }
    None
}

fn extract_chinese_number_after(text: &str, keyword: &str) -> Option<i64> {
    let position = text.find(keyword)?;
    extract_chinese_number_from_text(&text[position + keyword.len()..])
}

fn extract_chinese_number_from_text(text: &str) -> Option<i64> {
    let mut token = String::new();
    let mut started = false;
    for character in text.chars() {
        if is_chinese_number_char(character) {
            token.push(character);
            started = true;
        } else if started {
            break;
        }
    }
    parse_chinese_number(&token)
}

fn extract_chinese_number_before_suffix(text: &str, suffix: &str) -> Option<i64> {
    let position = text.find(suffix)?;
    let prefix = &text[..position];
    let token: String = prefix
        .chars()
        .rev()
        .take_while(|character| is_chinese_number_char(*character))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    parse_chinese_number(&token)
}

fn is_chinese_number_char(character: char) -> bool {
    matches!(
        character,
        '零' | '〇'
            | '一'
            | '二'
            | '两'
            | '三'
            | '四'
            | '五'
            | '六'
            | '七'
            | '八'
            | '九'
            | '十'
            | '百'
            | '千'
    )
}

fn parse_chinese_number(text: &str) -> Option<i64> {
    if text.is_empty() {
        return None;
    }
    let mut total = 0_i64;
    let mut current = 0_i64;
    let mut saw_number = false;
    for character in text.chars() {
        let digit = match character {
            '零' | '〇' => Some(0),
            '一' => Some(1),
            '二' | '两' => Some(2),
            '三' => Some(3),
            '四' => Some(4),
            '五' => Some(5),
            '六' => Some(6),
            '七' => Some(7),
            '八' => Some(8),
            '九' => Some(9),
            _ => None,
        };
        if let Some(digit) = digit {
            current = digit;
            saw_number = true;
            continue;
        }
        let unit = match character {
            '十' => 10,
            '百' => 100,
            '千' => 1000,
            _ => return None,
        };
        total += current.max(1) * unit;
        current = 0;
        saw_number = true;
    }
    saw_number.then_some(total + current)
}

fn extract_mode(text: &str) -> Option<(String, Value)> {
    let modes = [
        (
            ["制冷", "冷风", "吹冷风", "cooling", "coolmode"].as_slice(),
            "cool",
        ),
        (
            [
                "制热",
                "暖风",
                "暖气",
                "吹暖风",
                "加热",
                "heating",
                "heatmode",
            ]
            .as_slice(),
            "heat",
        ),
        (["除湿", "drymode"].as_slice(), "dry"),
        (["抽湿"].as_slice(), "dry"),
        (["送风", "通风", "吹风", "fanmode"].as_slice(), "fan"),
        (
            ["自动", "自动模式", "自动风", "automode", "automatic"].as_slice(),
            "auto",
        ),
        (
            ["睡眠", "睡眠模式", "睡眠风", "sleepmode"].as_slice(),
            "sleep",
        ),
        (["节能", "eco", "省电"].as_slice(), "eco"),
        (["舒适", "comfort"].as_slice(), "comfort"),
        (["强劲", "强力", "turbo", "急速"].as_slice(), "turbo"),
        (["静音模式", "安静模式", "quiet"].as_slice(), "quiet"),
        (["清新", "fresh"].as_slice(), "fresh"),
        (
            ["防直吹", "避人吹", "无风感", "柔风"].as_slice(),
            "anti_direct",
        ),
    ];
    for (words, value) in modes {
        if words.iter().any(|word| text.contains(word)) {
            return Some(("mode".to_string(), json!(value)));
        }
    }
    None
}

fn extract_target(catalog: &DeviceCatalog, text: &str) -> IntentTarget {
    let (main_text, excluded_text) = split_exclusion_text(text);
    let all = ["全部", "所有", "全屋", "每个", "各个", "全都"]
        .iter()
        .any(|word| main_text.contains(word))
        || [
            "都关",
            "都开",
            "都打开",
            "都关闭",
            "都调",
            "一起关",
            "一起开",
        ]
        .iter()
        .any(|word| main_text.contains(word));
    let home = catalog
        .homes()
        .into_iter()
        .find(|name| main_text.contains(&normalize_text(name)));
    let room = catalog
        .rooms()
        .into_iter()
        .map(|(_, room)| room)
        .filter(|room| room != "未分房间")
        .filter(|room| {
            main_text.contains(&normalize_text(room))
                || english_room_aliases(room)
                    .iter()
                    .any(|alias| main_text.contains(alias))
        })
        .max_by_key(|room| room.chars().count());
    let normalized_main_text = normalize_device_reference(main_text);
    let mentioned_device = catalog
        .devices
        .iter()
        .filter(|device| normalized_main_text.contains(&normalize_device_reference(&device.name)))
        .max_by_key(|device| device.name.chars().count())
        .map(|device| device.name.clone());
    let device = mentioned_device
        .or_else(|| category_words_for_text(main_text))
        .or_else(|| {
            let mut leftover = main_text.to_string();
            for word in [
                "打开",
                "开启",
                "开机",
                "开一下",
                "启动",
                "关闭",
                "关掉",
                "关上",
                "关机",
                "关一下",
                "停止",
                "全部",
                "所有",
                "全屋",
                "每个",
                "各个",
                "全都",
                "把",
                "请",
                "帮我",
                "调到",
                "调至",
                "调成",
                "设成",
                "调高",
                "调低",
                "升高",
                "降低",
                "设置为",
                "设置",
                "开到",
                "打开到",
                "打开至",
                "拉到",
                "拉至",
                "保持",
                "维持",
                "度",
                "摄氏度",
                "°c",
                "℃",
                "百分之",
                "%",
                "亮度",
                "温度",
                "湿度",
                "色温",
                "颜色",
                "红色",
                "橙色",
                "橘色",
                "黄色",
                "绿色",
                "青色",
                "蓝色",
                "紫色",
                "粉色",
                "白色",
                "音量",
                "声音",
                "空调",
                "灯",
                "风扇",
                "晾衣架",
                "窗帘",
                "风速",
                "模式",
                "多少",
                "状态",
                "一下",
                "一点",
                "一些",
                "大点",
                "小点",
                "高点",
                "低点",
                "亮些",
                "暗些",
                "调大",
                "调小",
                "调亮",
                "调暗",
                "更亮",
                "更暗",
                "再亮",
                "再暗",
                "有点",
                "稍微",
                "左右",
                "模式",
                "k",
                "取消",
                "静音",
                "恢复",
                "暂停",
                "播放",
                "上一首",
                "下一首",
                "上一个",
                "下一个",
                "继续",
                "白一点",
                "黄一点",
                "开始清扫",
                "暂停清扫",
                "回充",
                "上下",
                "左右",
                "扫风",
                "摆风",
                "摇头",
            ] {
                leftover = leftover.replace(word, "");
            }
            if let Some(room) = &room {
                leftover = leftover.replace(&normalize_text(room), "");
            }
            let leftover = leftover
                .trim_matches(|character: char| !character.is_alphanumeric() && !is_cjk(character))
                .to_string();
            let meaningful_characters = leftover
                .chars()
                .filter(|character| is_cjk(*character) || character.is_ascii_alphabetic())
                .count();
            (meaningful_characters >= 2).then_some(leftover)
        });
    let (exclude_rooms, exclude_devices, exclude_categories) = excluded_text
        .map(|excluded| extract_exclusions(catalog, excluded))
        .unwrap_or_default();
    IntentTarget {
        home,
        room,
        device,
        all,
        exclude_rooms,
        exclude_devices,
        exclude_categories,
    }
}

fn english_room_aliases(room: &str) -> &'static [&'static str] {
    match room {
        "客厅" => &["livingroom", "lounge"],
        "餐厅" => &["diningroom"],
        "主卧" | "主卧室" => &["masterbedroom", "primarybedroom"],
        "次卧" => &["guestbedroom", "secondbedroom"],
        "卧室" => &["bedroom"],
        "书房" | "办公室" => &["study", "office"],
        "厨房" => &["kitchen"],
        "卫生间" | "洗手间" | "浴室" => &["bathroom", "restroom"],
        "阳台" => &["balcony"],
        "儿童房" => &["kidsroom", "childroom"],
        "老人房" => &["elderroom"],
        _ => &[],
    }
}

fn split_exclusion_text(text: &str) -> (&str, Option<&str>) {
    for marker in ["除了", "除去", "不包括"] {
        if let Some(position) = text.find(marker) {
            let excluded = &text[position + marker.len()..];
            return (
                &text[..position],
                (!excluded.is_empty()).then_some(excluded),
            );
        }
    }
    (text, None)
}

fn extract_exclusions(
    catalog: &DeviceCatalog,
    text: &str,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let normalized = normalize_text(text);
    let devices: Vec<String> = catalog
        .devices
        .iter()
        .filter(|device| normalized.contains(&normalize_text(&device.name)))
        .map(|device| device.name.clone())
        .collect();
    if !devices.is_empty() {
        return (Vec::new(), devices, Vec::new());
    }
    let room = catalog
        .rooms()
        .into_iter()
        .map(|(_, room)| room)
        .filter(|room| room != "未分房间")
        .filter(|room| {
            normalized.contains(&normalize_text(room))
                || english_room_aliases(room)
                    .iter()
                    .any(|alias| normalized.contains(alias))
        })
        .max_by_key(|room| room.chars().count());
    let category = category_words_for_text(&normalized);
    match (room, category) {
        (Some(room), Some(_)) => (vec![room], Vec::new(), Vec::new()),
        (Some(room), None) => (vec![room], Vec::new(), Vec::new()),
        (None, Some(category)) => (Vec::new(), Vec::new(), vec![category]),
        (None, None) => (Vec::new(), Vec::new(), Vec::new()),
    }
}

fn category_words_for_text(text: &str) -> Option<String> {
    for (needle, category) in [
        ("airconditioner", "air_conditioner"),
        ("aircon", "air_conditioner"),
        ("airpurifier", "air_purifier"),
        ("robotvacuum", "vacuum"),
        ("waterheater", "water_heater"),
        ("空气净化器", "air_purifier"),
        ("净化器", "air_purifier"),
        ("新风系统", "fresh_air_system"),
        ("新风机", "fresh_air_system"),
        ("新风", "fresh_air_system"),
        ("加湿器", "humidifier"),
        ("除湿机", "dehumidifier"),
        ("抽湿机", "dehumidifier"),
        ("扫地机器人", "vacuum"),
        ("扫拖机器人", "vacuum"),
        ("扫地机", "vacuum"),
        ("吸尘器", "vacuum"),
        ("热水器", "water_heater"),
        ("电暖器", "heater"),
        ("取暖器", "heater"),
        ("暖气", "heater"),
        ("浴霸", "bathroom_heater"),
        ("洗衣机", "washing_machine"),
        ("洗碗机", "dishwasher"),
        ("冰箱", "refrigerator"),
        ("电饭煲", "cooker"),
        ("电饭锅", "cooker"),
        ("电压力锅", "cooker"),
        ("净水器", "water_purifier"),
        ("空调扇", "fan"),
        ("空调", "air_conditioner"),
        ("冷气", "air_conditioner"),
        ("晾衣架", "airer"),
        ("晾衣机", "airer"),
        ("窗帘", "curtain"),
        ("卷帘", "curtain"),
        ("百叶窗", "curtain"),
        ("纱帘", "curtain"),
        ("遮阳帘", "curtain"),
        ("摄像头", "camera"),
        ("监控", "camera"),
        ("门锁", "lock"),
        ("锁门", "lock"),
        ("开锁", "lock"),
        ("电视", "television"),
        ("投影", "television"),
        ("音箱", "speaker"),
        ("音响", "speaker"),
        ("风扇", "fan"),
        ("电扇", "fan"),
        ("灯", "light"),
        ("插座", "switch"),
        ("开关", "switch"),
        ("排插", "switch"),
        ("light", "light"),
        ("lamp", "light"),
        ("curtain", "curtain"),
        ("blind", "curtain"),
        ("shade", "curtain"),
        ("fan", "fan"),
        ("television", "television"),
        ("projector", "television"),
        ("speaker", "speaker"),
        ("purifier", "air_purifier"),
        ("humidifier", "humidifier"),
        ("dehumidifier", "dehumidifier"),
        ("vacuum", "vacuum"),
        ("dishwasher", "dishwasher"),
        ("refrigerator", "refrigerator"),
        ("fridge", "refrigerator"),
        ("lock", "lock"),
        ("camera", "camera"),
    ] {
        if text.contains(needle) {
            return Some(category.to_string());
        }
    }
    None
}

fn is_cjk(character: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&character)
}

fn resolve_intent(catalog: &DeviceCatalog, intent: AssistantIntent) -> ResolveOutcome {
    if intent.action == IntentAction::Help {
        return ResolveOutcome::NotFound {
            message: "没听懂。可以试试“打开客厅灯”“把主卧空调调到 26 度”或“执行回家模式”。"
                .to_string(),
        };
    }
    if intent.action == IntentAction::RunScene {
        return resolve_scene(catalog, intent);
    }
    if intent.action == IntentAction::QueryDevices {
        return resolve_device_overview(catalog, intent);
    }
    let capability = match intent.capability.clone() {
        Some(capability) => capability,
        None => {
            return ResolveOutcome::NotFound {
                message: "没有识别出要控制的能力。".to_string(),
            }
        }
    };
    if intent.target.all && intent.action != IntentAction::QueryState {
        return resolve_batch(catalog, intent, &capability);
    }
    let matches = matching_devices(catalog, &intent.target, &capability, intent.action);
    if intent.action == IntentAction::QueryState
        && ((intent.target.all && matches.len() > 1)
            || should_batch_generic_target(catalog, &intent, matches.len()))
    {
        return resolve_query_batch(catalog, intent, &capability, matches);
    }
    if should_batch_generic_target(catalog, &intent, matches.len()) {
        return resolve_batch(catalog, intent, &capability);
    }
    let mut ranked: Vec<(&CatalogDevice, CatalogCapability, i32)> = matches;
    ranked.sort_by_key(|left| std::cmp::Reverse(left.2));
    if ranked.is_empty() {
        if let Some(outcome) = resolve_action_fallback(catalog, &intent, &capability) {
            return outcome;
        }
        return ResolveOutcome::NotFound {
            message: format!(
                "没有找到可执行“{}”的设备。请先在米家完成设备同步。",
                capability_label(&capability, "")
            ),
        };
    }
    if top_matches_are_ambiguous(&intent, &ranked) {
        let candidates = ranked
            .iter()
            .take(6)
            .map(|(device, _, _)| CandidateView {
                home: device.home_name.clone(),
                room: device.room_name.clone(),
                device: device.name.clone(),
                online: device.online,
            })
            .collect();
        return ResolveOutcome::Ambiguous {
            message: "匹配到多个设备，请补充房间或完整设备名。".to_string(),
            candidates,
        };
    }
    let (device, descriptor, _) = ranked.remove(0);
    if !device.online {
        return ResolveOutcome::NotFound {
            message: format!("{} 当前离线，无法执行。", device.name),
        };
    }
    let operation = if intent.action == IntentAction::QueryState {
        ResolvedOperation::QueryProperty {
            did: device.did.clone(),
            device_name: device.name.clone(),
            siid: descriptor.siid,
            piid: descriptor.piid,
            label: descriptor.label.clone(),
            capability: descriptor.clone(),
        }
    } else if intent.action == IntentAction::AdjustDevice {
        let (direction, amount, unit) = match parse_adjustment(&intent.value) {
            Ok(adjustment) => adjustment,
            Err(error) => {
                return ResolveOutcome::NotFound {
                    message: error.to_string(),
                }
            }
        };
        ResolvedOperation::AdjustProperty {
            did: device.did.clone(),
            device_name: device.name.clone(),
            capability: descriptor.clone(),
            direction,
            amount,
            unit,
        }
    } else {
        if !descriptor.writable {
            return ResolveOutcome::NotFound {
                message: format!("{} 不支持写入“{}”。", device.name, descriptor.label),
            };
        }
        let value = match coerce_value(&descriptor, &intent.value) {
            Ok(value) => value,
            Err(error) => {
                return ResolveOutcome::NotFound {
                    message: error.to_string(),
                }
            }
        };
        ResolvedOperation::SetProperty {
            did: device.did.clone(),
            device_name: device.name.clone(),
            siid: descriptor.siid,
            piid: descriptor.piid,
            value: value.clone(),
            label: descriptor.label.clone(),
            capability: descriptor.clone(),
        }
    };
    let (requires_confirmation, confirmation_reason) = risk_for(device, &capability);
    let summary = command_summary(device, &capability, &descriptor, &intent.value);
    ResolveOutcome::Ready {
        summary: summary.clone(),
        requires_confirmation,
        confirmation_reason: confirmation_reason.clone(),
        command: Box::new(ResolvedCommand {
            intent,
            target: Some(ResolvedTarget {
                home: device.home_name.clone(),
                room: device.room_name.clone(),
                device: device.name.clone(),
                category: device.category.clone(),
            }),
            operation,
            summary,
            requires_confirmation,
            confirmation_reason,
        }),
    }
}

fn resolve_query_batch(
    catalog: &DeviceCatalog,
    intent: AssistantIntent,
    capability: &str,
    mut matches: Vec<(&CatalogDevice, CatalogCapability, i32)>,
) -> ResolveOutcome {
    matches.sort_by(|left, right| {
        left.0
            .home_name
            .cmp(&right.0.home_name)
            .then(left.0.room_name.cmp(&right.0.room_name))
            .then(left.0.name.cmp(&right.0.name))
    });
    let mut queries = Vec::new();
    let mut skipped = Vec::new();
    for (device, descriptor, _) in matches {
        if !device.online {
            skipped.push(format!("{}（离线）", device.name));
            continue;
        }
        queries.push(PropertyQuery {
            did: device.did.clone(),
            device_name: device.name.clone(),
            siid: descriptor.siid,
            piid: descriptor.piid,
            label: descriptor.label.clone(),
            capability: descriptor,
        });
    }
    if queries.is_empty() {
        return ResolveOutcome::NotFound {
            message: if skipped.is_empty() {
                "没有找到可读取状态的设备。".to_string()
            } else {
                format!("没有可读取状态的在线设备：{}。", skipped.join("、"))
            },
        };
    }
    let first_target = queries.first().and_then(|query| {
        catalog
            .devices
            .iter()
            .find(|device| device.did == query.did && device.name == query.device_name)
            .map(|device| ResolvedTarget {
                home: device.home_name.clone(),
                room: device.room_name.clone(),
                device: device.name.clone(),
                category: device.category.clone(),
            })
    });
    let scope_label = intent
        .target
        .device
        .as_deref()
        .and_then(category_display_name)
        .unwrap_or_else(|| capability_label(capability, ""));
    let description = format!("查询{}（{} 个设备）", scope_label, queries.len());
    ResolveOutcome::Ready {
        summary: description.clone(),
        requires_confirmation: false,
        confirmation_reason: None,
        command: Box::new(ResolvedCommand {
            intent,
            target: first_target,
            operation: ResolvedOperation::QueryProperties {
                description: description.clone(),
                queries,
                skipped,
            },
            summary: description,
            requires_confirmation: false,
            confirmation_reason: None,
        }),
    }
}

fn resolve_action_fallback(
    catalog: &DeviceCatalog,
    intent: &AssistantIntent,
    capability: &str,
) -> Option<ResolveOutcome> {
    let (action_name, repeat) = if intent.action == IntentAction::SetDevice && capability == "on" {
        let on = parse_bool(&intent.value)?;
        (if on { "turn_on" } else { "turn_off" }, 1)
    } else if intent.action == IntentAction::SetDevice
        && matches!(
            capability,
            "play"
                | "pause"
                | "next"
                | "previous"
                | "start_sweep"
                | "stop_sweep"
                | "return_to_charge"
                | "lock"
                | "unlock"
        )
    {
        (capability, 1)
    } else if intent.action == IntentAction::AdjustDevice {
        let (direction, amount, unit) = parse_adjustment(&intent.value).ok()?;
        let action = match (capability, direction) {
            ("target_temperature", AdjustmentDirection::Increase) => "temperature_up",
            ("target_temperature", AdjustmentDirection::Decrease) => "temperature_down",
            ("fan_level", AdjustmentDirection::Increase) => "fan_level_up",
            ("fan_level", AdjustmentDirection::Decrease) => "fan_level_down",
            ("brightness", AdjustmentDirection::Increase) => "brightness_up",
            ("brightness", AdjustmentDirection::Decrease) => "brightness_down",
            ("color_temperature", AdjustmentDirection::Increase) => "color_temperature_up",
            ("color_temperature", AdjustmentDirection::Decrease) => "color_temperature_down",
            ("volume", AdjustmentDirection::Increase) => "volume_up",
            ("volume", AdjustmentDirection::Decrease) => "volume_down",
            _ => return None,
        };
        if unit == AdjustmentUnit::Percent && amount.is_some() {
            return None;
        }
        let repeat = amount
            .map(|amount| amount.abs().round().max(1.0) as u32)
            .unwrap_or(1)
            .clamp(1, 10);
        (action, repeat)
    } else {
        return None;
    };

    let mut matches = matching_action_devices(catalog, &intent.target, action_name);
    matches.sort_by_key(|left| std::cmp::Reverse(left.2));
    if matches.is_empty() {
        return None;
    }
    if should_batch_generic_target(catalog, intent, matches.len()) {
        return Some(resolve_batch(catalog, intent.clone(), capability));
    }
    if top_matches_are_ambiguous(intent, &matches) {
        return Some(ResolveOutcome::Ambiguous {
            message: "匹配到多个设备，请补充房间或完整设备名。".to_string(),
            candidates: matches
                .iter()
                .take(6)
                .map(|(device, _, _)| CandidateView {
                    home: device.home_name.clone(),
                    room: device.room_name.clone(),
                    device: device.name.clone(),
                    online: device.online,
                })
                .collect(),
        });
    }
    let (device, action, _) = matches.remove(0);
    if !device.online {
        return Some(ResolveOutcome::NotFound {
            message: format!("{} 当前离线，无法执行。", device.name),
        });
    }
    let summary = if repeat > 1 {
        format!("对 {} 执行 {} ×{repeat}", device.name, action.label)
    } else {
        format!("对 {} 执行 {}", device.name, action.label)
    };
    let (requires_confirmation, confirmation_reason) = risk_for(device, capability);
    Some(ResolveOutcome::Ready {
        summary: summary.clone(),
        requires_confirmation,
        confirmation_reason: confirmation_reason.clone(),
        command: Box::new(ResolvedCommand {
            intent: intent.clone(),
            target: Some(ResolvedTarget {
                home: device.home_name.clone(),
                room: device.room_name.clone(),
                device: device.name.clone(),
                category: device.category.clone(),
            }),
            operation: ResolvedOperation::CallAction {
                did: device.did.clone(),
                device_name: device.name.clone(),
                siid: action.siid,
                aiid: action.aiid,
                name: action.label.clone(),
                repeat,
            },
            summary,
            requires_confirmation,
            confirmation_reason,
        }),
    })
}

fn matching_action_devices<'a>(
    catalog: &'a DeviceCatalog,
    target: &IntentTarget,
    action_name: &str,
) -> Vec<(&'a CatalogDevice, &'a CatalogAction, i32)> {
    let home = target.home.as_deref().map(normalize_text);
    let room = target.room.as_deref().map(normalize_text);
    let device_query = target.device.as_deref().map(normalize_text);
    let mut result = Vec::new();
    for device in &catalog.devices {
        if matches_exclusion(device, target) {
            continue;
        }
        if home
            .as_ref()
            .is_some_and(|home| normalize_text(&device.home_name) != *home)
        {
            continue;
        }
        if room
            .as_ref()
            .is_some_and(|room| normalize_text(&device.room_name) != *room)
        {
            continue;
        }
        let preferred_service = device_query
            .as_deref()
            .and_then(|query| preferred_service_for_query(device, query));
        let Some(action) = device
            .actions
            .iter()
            .filter(|action| action.name == action_name)
            .min_by_key(|action| {
                preferred_service.is_some_and(|service| action.service != service)
            })
        else {
            continue;
        };
        let mut score = 0;
        if let Some(query) = &device_query {
            score += target_score(device, query);
            if score == 0 {
                continue;
            }
        }
        if room.is_some() {
            score += 12;
        }
        if home.is_some() {
            score += 4;
        }
        if device.online {
            score += 2;
        }
        result.push((device, action, score));
    }
    result
}

fn resolve_batch(
    catalog: &DeviceCatalog,
    intent: AssistantIntent,
    capability: &str,
) -> ResolveOutcome {
    if intent.target.device.is_none() && intent.target.room.is_none() {
        return ResolveOutcome::NotFound {
            message: "批量控制需要说明品类或房间，例如“关闭所有灯”或“关闭客厅的灯”。".to_string(),
        };
    }
    let mut matches = matching_devices(catalog, &intent.target, capability, intent.action);
    matches.sort_by(|left, right| {
        left.0
            .home_name
            .cmp(&right.0.home_name)
            .then(left.0.room_name.cmp(&right.0.room_name))
            .then(left.0.name.cmp(&right.0.name))
    });
    let mut operations = Vec::new();
    let mut selected_devices = HashSet::new();
    let mut skipped = Vec::new();
    let mut risky_reason = None;
    if intent.action == IntentAction::AdjustDevice {
        let (direction, amount, unit) = match parse_adjustment(&intent.value) {
            Ok(adjustment) => adjustment,
            Err(error) => {
                return ResolveOutcome::NotFound {
                    message: error.to_string(),
                }
            }
        };
        for (device, descriptor, _) in matches {
            if !device.online {
                skipped.push(format!("{}（离线）", device.name));
                continue;
            }
            if !descriptor.readable || !descriptor.writable {
                skipped.push(format!("{}（不支持相对调节）", device.name));
                continue;
            }
            let (needs_confirmation, reason) = risk_for(device, capability);
            if needs_confirmation && risky_reason.is_none() {
                risky_reason = reason;
            }
            operations.push(ResolvedOperation::AdjustProperty {
                did: device.did.clone(),
                device_name: device.name.clone(),
                capability: descriptor.clone(),
                direction,
                amount,
                unit,
            });
            selected_devices.insert(device.did.clone());
        }
    } else {
        for (device, descriptor, _) in matches {
            if !device.online {
                skipped.push(format!("{}（离线）", device.name));
                continue;
            }
            if !descriptor.writable {
                skipped.push(format!("{}（不支持写入）", device.name));
                continue;
            }
            let value = match coerce_value(&descriptor, &intent.value) {
                Ok(value) => value,
                Err(error) => {
                    skipped.push(format!("{}（{}）", device.name, error));
                    continue;
                }
            };
            let (needs_confirmation, reason) = risk_for(device, capability);
            if needs_confirmation && risky_reason.is_none() {
                risky_reason = reason;
            }
            operations.push(ResolvedOperation::SetProperty {
                did: device.did.clone(),
                device_name: device.name.clone(),
                siid: descriptor.siid,
                piid: descriptor.piid,
                value,
                label: descriptor.label.clone(),
                capability: descriptor.clone(),
            });
            selected_devices.insert(device.did.clone());
        }
    }
    if let Some((action_name, repeat)) = batch_action_plan(&intent, capability) {
        for (device, action, _) in matching_action_devices(catalog, &intent.target, action_name) {
            if selected_devices.contains(&device.did) {
                continue;
            }
            if !device.online {
                skipped.push(format!("{}（离线）", device.name));
                continue;
            }
            let (needs_confirmation, reason) = risk_for(device, capability);
            if needs_confirmation && risky_reason.is_none() {
                risky_reason = reason;
            }
            operations.push(ResolvedOperation::CallAction {
                did: device.did.clone(),
                device_name: device.name.clone(),
                siid: action.siid,
                aiid: action.aiid,
                name: action.label.clone(),
                repeat,
            });
            selected_devices.insert(device.did.clone());
        }
    }
    if operations.is_empty() {
        return ResolveOutcome::NotFound {
            message: if skipped.is_empty() {
                "没有找到可批量控制的设备。".to_string()
            } else {
                format!("没有可执行的在线设备：{}。", skipped.join("、"))
            },
        };
    }
    let first_target = operations.first().and_then(|operation| match operation {
        ResolvedOperation::SetProperty {
            did, device_name, ..
        }
        | ResolvedOperation::AdjustProperty {
            did, device_name, ..
        } => catalog
            .devices
            .iter()
            .find(|device| device.did == *did && device.name == *device_name)
            .map(|device| ResolvedTarget {
                home: device.home_name.clone(),
                room: device.room_name.clone(),
                device: device.name.clone(),
                category: device.category.clone(),
            }),
        _ => None,
    });
    let scope_label = intent
        .target
        .device
        .as_deref()
        .and_then(category_display_name)
        .unwrap_or_else(|| capability_label(capability, ""));
    let summary = if capability == "on" {
        format!(
            "{}全部{}（{} 个设备）",
            if parse_bool(&intent.value).unwrap_or(false) {
                "打开"
            } else {
                "关闭"
            },
            scope_label,
            operations.len()
        )
    } else {
        format!(
            "{}{}（{} 个设备）",
            if intent.action == IntentAction::AdjustDevice {
                "批量调节"
            } else {
                "批量设置"
            },
            scope_label,
            operations.len()
        )
    };
    let needs_confirmation = risky_reason.is_some() || operations.len() > 8;
    let confirmation_reason = risky_reason.or_else(|| {
        (operations.len() > 8).then(|| format!("本次会同时控制 {} 个设备", operations.len()))
    });
    ResolveOutcome::Ready {
        summary: summary.clone(),
        requires_confirmation: needs_confirmation,
        confirmation_reason: confirmation_reason.clone(),
        command: Box::new(ResolvedCommand {
            intent,
            target: first_target,
            operation: ResolvedOperation::Batch {
                description: summary.clone(),
                operations,
                skipped,
            },
            summary,
            requires_confirmation: needs_confirmation,
            confirmation_reason,
        }),
    }
}

fn batch_action_plan(intent: &AssistantIntent, capability: &str) -> Option<(&'static str, u32)> {
    if intent.action == IntentAction::SetDevice && capability == "on" {
        return parse_bool(&intent.value).map(|on| (if on { "turn_on" } else { "turn_off" }, 1));
    }
    if intent.action == IntentAction::SetDevice
        && matches!(capability, "play" | "pause" | "next" | "previous")
    {
        return Some((
            match capability {
                "play" => "play",
                "pause" => "pause",
                "next" => "next",
                _ => "previous",
            },
            1,
        ));
    }
    if intent.action != IntentAction::AdjustDevice {
        return None;
    }
    let (direction, amount, unit) = parse_adjustment(&intent.value).ok()?;
    let action = match (capability, direction) {
        ("target_temperature", AdjustmentDirection::Increase) => "temperature_up",
        ("target_temperature", AdjustmentDirection::Decrease) => "temperature_down",
        ("fan_level", AdjustmentDirection::Increase) => "fan_level_up",
        ("fan_level", AdjustmentDirection::Decrease) => "fan_level_down",
        ("brightness", AdjustmentDirection::Increase) => "brightness_up",
        ("brightness", AdjustmentDirection::Decrease) => "brightness_down",
        ("color_temperature", AdjustmentDirection::Increase) => "color_temperature_up",
        ("color_temperature", AdjustmentDirection::Decrease) => "color_temperature_down",
        ("volume", AdjustmentDirection::Increase) => "volume_up",
        ("volume", AdjustmentDirection::Decrease) => "volume_down",
        _ => return None,
    };
    if unit == AdjustmentUnit::Percent && amount.is_some() {
        return None;
    }
    let repeat = amount
        .map(|amount| amount.abs().round().max(1.0) as u32)
        .unwrap_or(1)
        .clamp(1, 10);
    Some((action, repeat))
}

fn category_display_name(category: &str) -> Option<String> {
    let label = match category {
        "light" => "灯",
        "air_conditioner" => "空调",
        "fan" => "风扇",
        "curtain" => "窗帘",
        "airer" => "晾衣架",
        "switch" => "插座",
        "television" => "电视",
        "speaker" => "音箱",
        "camera" => "摄像头",
        "lock" => "门锁",
        "sensor" => "传感器",
        "air_purifier" => "空气净化器",
        "fresh_air_system" => "新风",
        "humidifier" => "加湿器",
        "dehumidifier" => "除湿机",
        "vacuum" => "扫地机",
        "water_heater" => "热水器",
        "heater" => "电暖器",
        "bathroom_heater" => "浴霸",
        "washing_machine" => "洗衣机",
        "dishwasher" => "洗碗机",
        "refrigerator" => "冰箱",
        "cooker" => "电饭煲",
        "water_purifier" => "净水器",
        _ => return None,
    };
    Some(label.to_string())
}

fn parse_adjustment(value: &Value) -> Result<(AdjustmentDirection, Option<f64>, AdjustmentUnit)> {
    let direction = match value
        .get("direction")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "increase" => AdjustmentDirection::Increase,
        "decrease" => AdjustmentDirection::Decrease,
        _ => return Err(anyhow!("相对调节缺少有效方向")),
    };
    let amount = value.get("amount").and_then(Value::as_f64);
    let unit = match value
        .get("unit")
        .and_then(Value::as_str)
        .unwrap_or("default")
    {
        "step" => AdjustmentUnit::Step,
        "percent" => AdjustmentUnit::Percent,
        "degree" => AdjustmentUnit::Degree,
        "kelvin" => AdjustmentUnit::Kelvin,
        _ => AdjustmentUnit::Default,
    };
    Ok((direction, amount, unit))
}

fn resolve_device_overview(catalog: &DeviceCatalog, intent: AssistantIntent) -> ResolveOutcome {
    let mode = intent.capability.as_deref().unwrap_or("all_count");
    let total = catalog.devices.len();
    let online = catalog
        .devices
        .iter()
        .filter(|device| device.online)
        .count();
    let offline = total.saturating_sub(online);
    let device_label = |device: &CatalogDevice| {
        if device.room_name.trim().is_empty() {
            device.name.clone()
        } else {
            format!("{}（{}）", device.name, device.room_name)
        }
    };
    let listed_devices = |wanted_online: bool| {
        let mut names = catalog
            .devices
            .iter()
            .filter(|device| device.online == wanted_online)
            .map(device_label)
            .collect::<Vec<_>>();
        names.sort();
        names
    };
    let reply = match mode {
        "online_count" => {
            format!("当前有 {online} 个设备在线，共 {total} 个设备，{offline} 个离线。")
        }
        "offline_count" => {
            format!("当前有 {offline} 个设备离线，共 {total} 个设备，{online} 个在线。")
        }
        "online_list" => {
            let names = listed_devices(true);
            if names.is_empty() {
                "当前没有在线设备。".to_string()
            } else {
                format!(
                    "当前在线设备有 {} 个：\n{}",
                    names.len(),
                    names
                        .iter()
                        .map(|name| format!("• {name}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            }
        }
        "offline_list" => {
            let names = listed_devices(false);
            if names.is_empty() {
                "当前没有离线设备。".to_string()
            } else {
                format!(
                    "当前离线设备有 {} 个：\n{}",
                    names.len(),
                    names
                        .iter()
                        .map(|name| format!("• {name}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            }
        }
        _ => format!("当前共有 {total} 个设备，其中 {online} 个在线，{offline} 个离线。"),
    };
    ResolveOutcome::Ready {
        summary: reply.clone(),
        requires_confirmation: false,
        confirmation_reason: None,
        command: Box::new(ResolvedCommand {
            intent,
            target: None,
            operation: ResolvedOperation::DeviceOverview {
                reply: reply.clone(),
            },
            summary: reply,
            requires_confirmation: false,
            confirmation_reason: None,
        }),
    }
}

fn resolve_scene(catalog: &DeviceCatalog, intent: AssistantIntent) -> ResolveOutcome {
    let wanted = intent
        .scene
        .as_deref()
        .map(normalize_text)
        .unwrap_or_default();
    let home = intent.target.home.as_deref().map(normalize_text);
    let matches: Vec<&CatalogScene> = catalog
        .scenes
        .iter()
        .filter(|scene| {
            let scene_name = normalize_text(&scene.name);
            (scene_name == wanted || scene_name.contains(&wanted) || wanted.contains(&scene_name))
                && home
                    .as_ref()
                    .is_none_or(|home| normalize_text(&scene.home_name) == *home)
        })
        .collect();
    if matches.is_empty() {
        return ResolveOutcome::NotFound {
            message: format!("没有找到场景“{}”。", intent.scene.unwrap_or_default()),
        };
    }
    if matches.len() > 1 {
        return ResolveOutcome::Ambiguous {
            message: "匹配到多个同名场景，请补充家庭名称。".to_string(),
            candidates: matches
                .iter()
                .map(|scene| CandidateView {
                    home: scene.home_name.clone(),
                    room: "场景".to_string(),
                    device: scene.name.clone(),
                    online: true,
                })
                .collect(),
        };
    }
    let scene = matches[0];
    let summary = format!("执行场景「{}」", scene.name);
    ResolveOutcome::Ready {
        summary: summary.clone(),
        requires_confirmation: false,
        confirmation_reason: None,
        command: Box::new(ResolvedCommand {
            intent,
            target: Some(ResolvedTarget {
                home: scene.home_name.clone(),
                room: "场景".to_string(),
                device: scene.name.clone(),
                category: "scene".to_string(),
            }),
            operation: ResolvedOperation::RunScene {
                scene_id: scene.id.clone(),
                home_id: scene.home_id.clone(),
                name: scene.name.clone(),
            },
            summary,
            requires_confirmation: false,
            confirmation_reason: None,
        }),
    }
}

fn matches_exclusion(device: &CatalogDevice, target: &IntentTarget) -> bool {
    let name = normalize_text(&device.name);
    target
        .exclude_devices
        .iter()
        .any(|excluded| name == normalize_text(excluded))
        || target
            .exclude_rooms
            .iter()
            .any(|room| normalize_text(&device.room_name) == normalize_text(room))
        || target.exclude_categories.contains(&device.category)
}

fn matching_devices<'a>(
    catalog: &'a DeviceCatalog,
    target: &IntentTarget,
    capability: &str,
    action: IntentAction,
) -> Vec<(&'a CatalogDevice, CatalogCapability, i32)> {
    let home = target.home.as_deref().map(normalize_text);
    let room = target.room.as_deref().map(normalize_text);
    let device_query = target.device.as_deref().map(normalize_text);
    let mut result = Vec::new();
    for device in &catalog.devices {
        if matches_exclusion(device, target) {
            continue;
        }
        if home
            .as_ref()
            .is_some_and(|home| normalize_text(&device.home_name) != *home)
        {
            continue;
        }
        if room
            .as_ref()
            .is_some_and(|room| normalize_text(&device.room_name) != *room)
        {
            continue;
        }
        let preferred_service = device_query
            .as_deref()
            .and_then(|query| preferred_service_for_query(device, query));
        let Some(descriptor) = best_capability(device, capability, action, preferred_service)
        else {
            continue;
        };
        let mut score = 0;
        if let Some(query) = &device_query {
            score += target_score(device, query);
            if score == 0 {
                continue;
            }
        }
        if room.is_some() {
            score += 12;
        }
        if home.is_some() {
            score += 4;
        }
        if descriptor.primary {
            score += 5;
        }
        if device.online {
            score += 2;
        }
        result.push((device, descriptor, score));
    }
    result
}

fn should_batch_generic_target(
    catalog: &DeviceCatalog,
    intent: &AssistantIntent,
    match_count: usize,
) -> bool {
    if match_count < 2 {
        return false;
    }
    let Some(query) = intent.target.device.as_deref() else {
        return false;
    };
    let normalized_query = normalize_device_reference(query);
    let is_specific_device = catalog.devices.iter().any(|device| {
        let name = normalize_device_reference(&device.name);
        name == normalized_query || normalized_query.contains(&name)
    });
    !is_specific_device && (intent.target.room.is_some() || intent.target.home.is_some())
}

fn top_matches_are_ambiguous<T>(
    intent: &AssistantIntent,
    ranked: &[(&CatalogDevice, T, i32)],
) -> bool {
    let [first, second, ..] = ranked else {
        return false;
    };
    if let Some(query) = intent.target.device.as_deref() {
        return target_score(first.0, query) == target_score(second.0, query);
    }
    first.2 == second.2
}

fn target_score(device: &CatalogDevice, query: &str) -> i32 {
    let query = normalize_device_reference(query);
    let name = normalize_device_reference(&device.name);
    if name == query {
        return 1_000;
    }
    let mut score = 0;
    if name.contains(&query) {
        score += 50;
    }
    if device.category == query {
        score += 40;
    }
    let mut category_query = query.clone();
    for scope in [&device.home_name, &device.room_name] {
        let scope = normalize_device_reference(scope);
        if !scope.is_empty() {
            category_query = category_query.replace(&scope, "");
        }
    }
    if let Some(category) = generic_category_for_query(&category_query) {
        if device.category == category {
            score += 40;
        }
        if category_words(category)
            .iter()
            .any(|word| name.contains(&normalize_device_reference(word)))
        {
            score += 30;
        }
    }
    if score > 0
        && device.room_name != "未分房间"
        && name.contains(&normalize_device_reference(&device.room_name))
        && query.contains(&normalize_device_reference(&device.room_name))
    {
        score += 20;
    }
    score
}

fn generic_category_for_query(query: &str) -> Option<&'static str> {
    match query {
        "灯" | "灯光" | "照明" | "light" | "lamp" => Some("light"),
        "空调" | "冷气" | "airconditioner" | "air_conditioner" | "aircon" => {
            Some("air_conditioner")
        }
        "风扇" | "电扇" | "电风扇" | "fan" => Some("fan"),
        "窗帘" | "curtain" | "blind" => Some("curtain"),
        "晾衣架" | "晾衣机" | "airer" => Some("airer"),
        "插座" | "开关" | "switch" | "outlet" | "plug" => Some("switch"),
        "摄像头" | "监控" | "camera" => Some("camera"),
        "门锁" | "lock" => Some("lock"),
        "电视" | "电视机" | "television" | "tv" => Some("television"),
        "音箱" | "音响" | "speaker" => Some("speaker"),
        "空气净化器" | "净化器" | "airpurifier" => Some("air_purifier"),
        "新风机" | "新风" => Some("fresh_air_system"),
        "加湿器" | "humidifier" => Some("humidifier"),
        "除湿机" | "抽湿机" | "dehumidifier" => Some("dehumidifier"),
        "扫地机" | "扫地机器人" | "vacuum" => Some("vacuum"),
        "热水器" | "waterheater" => Some("water_heater"),
        "电暖器" | "取暖器" | "heater" => Some("heater"),
        "浴霸" => Some("bathroom_heater"),
        "洗衣机" => Some("washing_machine"),
        "洗碗机" => Some("dishwasher"),
        "冰箱" => Some("refrigerator"),
        "电饭煲" | "电饭锅" => Some("cooker"),
        "净水器" => Some("water_purifier"),
        _ => None,
    }
}

fn best_capability(
    device: &CatalogDevice,
    capability: &str,
    action: IntentAction,
    preferred_service: Option<&str>,
) -> Option<CatalogCapability> {
    let aliases = capability_aliases(capability);
    let mut matches: Vec<&CatalogCapability> = device
        .capabilities
        .iter()
        .filter(|candidate| aliases.contains(&candidate.name.as_str()))
        .filter(|candidate| {
            if action == IntentAction::QueryState {
                candidate.readable
            } else if action == IntentAction::AdjustDevice {
                candidate.readable && candidate.writable
            } else {
                candidate.writable
            }
        })
        .collect();
    matches.sort_by_key(|candidate| {
        (
            preferred_service.is_some_and(|service| candidate.service != service),
            capability_rank(&candidate.name),
            std::cmp::Reverse(candidate.primary),
            std::cmp::Reverse(service_kind_matches_category(
                &candidate.service,
                &device.category,
            )),
        )
    });
    matches.first().map(|candidate| (*candidate).clone())
}

fn preferred_service_for_query(device: &CatalogDevice, query: &str) -> Option<&'static str> {
    let mut query = normalize_device_reference(query);
    for scope in [&device.home_name, &device.room_name] {
        let scope = normalize_device_reference(scope);
        if !scope.is_empty() {
            query = query.replace(&scope, "");
        }
    }
    let category = generic_category_for_query(&query)?;
    service_kind_for_category(category)
}

fn service_kind_for_category(category: &str) -> Option<&'static str> {
    match category {
        "light" => Some("light"),
        "air_conditioner" => Some("air-conditioner"),
        "fan" => Some("fan"),
        "curtain" => Some("curtain"),
        "airer" => Some("airer"),
        "switch" => Some("switch"),
        "camera" => Some("camera-control"),
        "television" => Some("television"),
        "speaker" => Some("speaker"),
        "sensor" => Some("sensor"),
        "air_purifier" => Some("air-purifier"),
        "fresh_air_system" => Some("fresh-air-system"),
        "humidifier" => Some("humidifier"),
        "dehumidifier" => Some("dehumidifier"),
        "vacuum" => Some("vacuum"),
        "water_heater" => Some("water-heater"),
        "heater" => Some("heater"),
        "bathroom_heater" => Some("bath-heater"),
        "washing_machine" => Some("washing-machine"),
        "dishwasher" => Some("dishwasher"),
        "refrigerator" => Some("refrigerator"),
        "cooker" => Some("cooker"),
        "water_purifier" => Some("water-purifier"),
        "lock" => Some("door-lock"),
        _ => None,
    }
}

fn capability_aliases(capability: &str) -> HashSet<&str> {
    match capability {
        "on" => ["on", "switch_status", "power", "is_on"]
            .into_iter()
            .collect(),
        "brightness" => ["brightness"].into_iter().collect(),
        "color_temperature" => ["color_temperature", "color_temperature_percent"]
            .into_iter()
            .collect(),
        "color" => ["color", "rgb_color", "rgb"].into_iter().collect(),
        "target_temperature" => ["target_temperature", "ir_temperature"]
            .into_iter()
            .collect(),
        "current_temperature" => [
            "current_temperature",
            "temperature",
            "target_temperature",
            "ir_temperature",
        ]
        .into_iter()
        .collect(),
        "relative_humidity" => [
            "relative_humidity",
            "humidity",
            "target_humidity",
            "target_relative_humidity",
        ]
        .into_iter()
        .collect(),
        "fan_level" => ["fan_level", "fan_speed", "speed_level"]
            .into_iter()
            .collect(),
        "mode" => ["mode", "ir_mode"].into_iter().collect(),
        "volume" => ["volume"].into_iter().collect(),
        "mute" => ["mute"].into_iter().collect(),
        "vertical_swing" => ["vertical_swing", "swing_up_down"].into_iter().collect(),
        "horizontal_swing" => ["horizontal_swing", "swing_left_right"]
            .into_iter()
            .collect(),
        "oscillate" => ["oscillate", "oscillation", "horizontal_swing"]
            .into_iter()
            .collect(),
        "current_position" => ["current_position", "position"].into_iter().collect(),
        "motor_control" => ["motor_control", "on"].into_iter().collect(),
        "battery_level" => ["battery_level"].into_iter().collect(),
        "playing_state" => ["playing_state"].into_iter().collect(),
        "door_state" => ["door_state", "contact_state", "lock_state", "window_state"]
            .into_iter()
            .collect(),
        "motion_state" => ["motion_state", "occupancy_state", "human_motion_state"]
            .into_iter()
            .collect(),
        "water_leak" => ["water_leak", "leak_state"].into_iter().collect(),
        "pm2_5" => ["pm2_5", "pm25"].into_iter().collect(),
        "pm10" => ["pm10"].into_iter().collect(),
        "co2" => ["co2", "carbon_dioxide"].into_iter().collect(),
        other => [other].into_iter().collect(),
    }
}

fn capability_rank(capability: &str) -> usize {
    match capability {
        "current_temperature" => 0,
        "motor_control" => 0,
        "on" | "is_on" => 1,
        "brightness" => 2,
        "color_temperature" => 3,
        "color" => 3,
        "target_temperature" | "ir_temperature" => 4,
        "fan_level" => 5,
        "mode" => 6,
        "volume" => 7,
        "mute" => 8,
        "current_position" | "position" => 9,
        _ => 10,
    }
}

fn coerce_value(capability: &CatalogCapability, value: &Value) -> Result<Value> {
    match capability.data_type.as_str() {
        "bool" => parse_bool(value)
            .map(Value::Bool)
            .ok_or_else(|| anyhow!("“{}”只接受开或关。", capability.label)),
        "uint8" | "uint16" | "uint32" | "int8" | "int16" | "int32" | "float" => {
            if !capability.value_list.is_empty() {
                return coerce_enum(capability, value);
            }
            let mut number = parse_numeric_target(capability, value)
                .ok_or_else(|| anyhow!("“{}”需要一个数字。", capability.label))?;
            if let Some(range) = &capability.value_range {
                if number < range.min || number > range.max {
                    return Err(anyhow!(
                        "“{}”范围是 {}–{}{}。",
                        capability.label,
                        range.min,
                        range.max,
                        capability
                            .unit
                            .as_deref()
                            .and_then(localized_property_unit)
                            .unwrap_or_default()
                    ));
                }
                if range.step > 0.0 {
                    number = range.min + ((number - range.min) / range.step).round() * range.step;
                    number = number.clamp(range.min, range.max);
                }
            }
            if number.fract().abs() < 0.001 {
                Ok(json!(number.round() as i64))
            } else {
                serde_json::Number::from_f64(number)
                    .map(Value::Number)
                    .ok_or_else(|| anyhow!("“{}”的数值无效。", capability.label))
            }
        }
        "string" => Ok(Value::String(
            value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string()),
        )),
        _ => Err(anyhow!(
            "“{}”的属性类型 {} 暂不支持自动控制。",
            capability.label,
            capability.data_type
        )),
    }
}

fn parse_bool(value: &Value) -> Option<bool> {
    value.as_bool().or_else(|| {
        value
            .as_str()
            .and_then(|text| match text.trim().to_ascii_lowercase().as_str() {
                "true" | "on" | "open" | "开" | "打开" | "开启" | "1" => Some(true),
                "false" | "off" | "close" | "关" | "关闭" | "关掉" | "0" => Some(false),
                _ => None,
            })
    })
}

fn parse_number(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .as_str()
            .and_then(|text| text.trim().trim_end_matches('%').parse().ok())
    })
}

fn parse_numeric_target(capability: &CatalogCapability, value: &Value) -> Option<f64> {
    if let Some(number) = parse_number(value) {
        return Some(number);
    }
    if let Some(percent) = value
        .get("percent")
        .and_then(Value::as_f64)
        .or_else(|| value.as_str()?.strip_suffix('%')?.parse::<f64>().ok())
    {
        let (min, max) = capability
            .value_range
            .as_ref()
            .map(|range| (range.min, range.max))
            .unwrap_or((0.0, 100.0));
        if (min - 1.0).abs() < 0.001 && (max - 100.0).abs() < 0.001 {
            return Some(percent.clamp(1.0, 100.0));
        }
        return Some(min + (max - min) * percent.clamp(0.0, 100.0) / 100.0);
    }
    let semantic = normalize_enum_text(value.as_str()?);
    let range = capability.value_range.as_ref()?;
    match semantic.as_str() {
        "max" | "high" | "最高" | "最大" | "最亮" | "最响" | "全亮" => Some(range.max),
        "min" | "low" | "最低" | "最小" | "最暗" | "最轻" => Some(range.min),
        "medium" | "mid" | "中" | "中等" => Some(range.min + (range.max - range.min) / 2.0),
        "warm" | "暖光" | "暖白" | "黄光" => Some(range.min + (range.max - range.min) * 0.25),
        "cool" | "冷光" | "冷白" => Some(range.min + (range.max - range.min) * 0.75),
        "natural" | "自然光" | "中性光" | "白光" => {
            Some(range.min + (range.max - range.min) / 2.0)
        }
        _ => None,
    }
}

fn coerce_enum(capability: &CatalogCapability, value: &Value) -> Result<Value> {
    if let Some(number) = value.as_i64() {
        if capability
            .value_list
            .iter()
            .any(|item| item.value == number)
        {
            return Ok(json!(number));
        }
    }
    let wanted = normalize_enum_text(
        value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string())
            .as_str(),
    );
    let matching = capability.value_list.iter().find(|item| {
        let description = normalize_enum_text(&item.description);
        description == wanted || description.contains(&wanted) || wanted.contains(&description)
    });
    if let Some(item) = matching {
        return Ok(json!(item.value));
    }
    let aliases = enum_aliases(&wanted);
    if let Some(item) = capability.value_list.iter().find(|item| {
        let description = normalize_enum_text(&item.description);
        aliases.iter().any(|alias| {
            description == normalize_enum_text(alias)
                || description.contains(&normalize_enum_text(alias))
        })
    }) {
        return Ok(json!(item.value));
    }
    Err(anyhow!(
        "“{}”不支持值“{}”。可用值：{}。",
        capability.label,
        value,
        capability
            .value_list
            .iter()
            .map(|item| item.description.as_str())
            .filter(|description| !description.is_empty())
            .collect::<Vec<_>>()
            .join("、")
    ))
}

fn normalize_enum_text(text: &str) -> String {
    text.trim()
        .to_ascii_lowercase()
        .replace([' ', '_', '-'], "")
}

fn enum_aliases(value: &str) -> &'static [&'static str] {
    match value {
        "cool" | "制冷" => &["cool", "制冷"],
        "heat" | "制热" => &["heat", "制热"],
        "dry" | "除湿" => &["dry", "除湿"],
        "fan" | "送风" => &["fan", "送风"],
        "auto" | "自动" => &["auto", "automatic", "自动"],
        "low" | "min" | "低" => &["low", "min", "低", "最小"],
        "medium" | "中" => &["medium", "mid", "中", "中等"],
        "high" | "max" | "高" => &["high", "max", "高", "最大"],
        "sleep" | "睡眠" => &["sleep", "睡眠"],
        "eco" | "节能" => &["eco", "energy saving", "节能", "省电"],
        "comfort" | "舒适" => &["comfort", "舒适"],
        "turbo" | "强劲" => &["turbo", "powerful", "strong", "强劲", "强力"],
        "quiet" | "静音" => &["quiet", "silent", "静音", "安静"],
        "fresh" | "清新" => &["fresh", "清新"],
        "anti_direct" | "antidirect" | "防直吹" => &[
            "anti-direct",
            "anti direct",
            "avoid",
            "防直吹",
            "避人吹",
            "无风感",
            "柔风",
        ],
        "natural" | "自然风" => &["natural", "自然风"],
        "straight" | "直吹风" => &["straight", "直吹风", "直吹"],
        "circulate" | "循环风" => &["circulate", "circular", "循环风"],
        "open" | "打开" => &["open", "up", "打开", "升起", "上升", "拉开"],
        "close" | "关闭" => &["close", "down", "关闭", "下降", "收起", "拉上"],
        "pause" | "暂停" => &["pause", "暂停", "停止"],
        _ => &[],
    }
}

fn risk_for(device: &CatalogDevice, capability: &str) -> (bool, Option<String>) {
    if device.category == "lock" {
        return (true, Some("门锁属于高风险设备".to_string()));
    }
    if device.category == "airer" && capability == "motor_control" {
        return (true, Some("晾衣架升降可能涉及人身或衣物安全".to_string()));
    }
    if matches!(capability, "reboot" | "privacy_mode") {
        return (true, Some("该能力可能中断设备或影响隐私".to_string()));
    }
    if device.category == "camera"
        && capability == "on"
        && device
            .capabilities
            .iter()
            .any(|item| item.name == "camera_control")
    {
        return (true, Some("摄像头开关会影响隐私".to_string()));
    }
    (false, None)
}

fn command_summary(
    device: &CatalogDevice,
    capability: &str,
    descriptor: &CatalogCapability,
    raw_value: &Value,
) -> String {
    if capability == "on" {
        let on = parse_bool(raw_value).unwrap_or(false);
        return format!(
            "{}「{}」{}",
            if on { "打开" } else { "关闭" },
            device.name,
            device.room_name
        );
    }
    if let Some(direction) = raw_value.get("direction").and_then(Value::as_str) {
        return format!(
            "将 {}（{}）的{}调{}",
            device.name,
            device.room_name,
            descriptor.label,
            if direction == "increase" {
                "高"
            } else {
                "低"
            }
        );
    }
    format!(
        "将 {}（{}）的{}设为 {}",
        device.name,
        device.room_name,
        descriptor.label,
        display_intent_value(descriptor, raw_value)
    )
}

fn display_intent_value(capability: &CatalogCapability, value: &Value) -> String {
    if let Some(percent) = value.get("percent").and_then(Value::as_f64) {
        return format!("{percent}%");
    }
    if capability.name == "color_temperature" {
        if let Some(text) = value.as_str() {
            let text = normalize_enum_text(text);
            if matches!(text.as_str(), "warm" | "暖光" | "暖白" | "黄光") {
                return "暖光".to_string();
            }
            if matches!(text.as_str(), "cool" | "冷光" | "冷白") {
                return "冷光".to_string();
            }
            if matches!(text.as_str(), "natural" | "自然光" | "中性光" | "白光") {
                return "自然光".to_string();
            }
        }
    }
    if capability.name == "color" {
        if let Some(rgb) = value.as_i64() {
            return color_label_from_rgb(rgb)
                .map(str::to_string)
                .unwrap_or_else(|| format!("#{rgb:06X}"));
        }
    }
    if !capability.value_list.is_empty() {
        if let Some(number) = value.as_i64() {
            if let Some(item) = capability
                .value_list
                .iter()
                .find(|item| item.value == number)
            {
                return localized_enum_value(&item.description)
                    .unwrap_or_else(|| item.description.clone());
            }
        }
    }
    if let Some(text) = value.as_str() {
        if let Some(localized) = localized_enum_value(text) {
            return localized;
        }
    }
    match value {
        Value::Bool(true) => "开启".to_string(),
        Value::Bool(false) => "关闭".to_string(),
        Value::Number(number) => format!(
            "{}{}",
            number,
            capability
                .unit
                .as_deref()
                .and_then(localized_property_unit)
                .unwrap_or_default()
        ),
        _ => value.to_string(),
    }
}

fn color_label_from_rgb(rgb: i64) -> Option<&'static str> {
    match rgb {
        0x00ff0000 => Some("红色"),
        0x00ff8000 => Some("橙色"),
        0x00ffff00 => Some("黄色"),
        0x0000ff00 => Some("绿色"),
        0x0000ffff => Some("青色"),
        0x000000ff => Some("蓝色"),
        0x008000ff => Some("紫色"),
        0x00ff66cc => Some("粉色"),
        0x00ffffff => Some("白色"),
        _ => None,
    }
}

fn localized_enum_value(value: &str) -> Option<String> {
    let value = normalize_enum_text(value);
    let label = match value.as_str() {
        "cool" | "制冷" => "制冷",
        "heat" | "制热" => "制热",
        "dry" | "除湿" => "除湿",
        "fan" | "送风" => "送风",
        "auto" | "automatic" | "自动" => "自动",
        "sleep" | "睡眠" => "睡眠",
        "eco" | "节能" | "省电" => "节能",
        "comfort" | "舒适" => "舒适",
        "turbo" | "强劲" | "强力" => "强劲",
        "quiet" | "静音" | "安静" => "静音",
        "fresh" | "清新" => "清新",
        "anti_direct" | "antidirect" | "anti-direct" | "防直吹" | "避人吹" | "无风感" | "柔风" => {
            "防直吹"
        }
        "low" | "min" | "低" | "最小" => "低",
        "medium" | "middle" | "mid" | "中" => "中",
        "high" | "max" | "高" | "最大" => "高",
        "up" | "open" | "上升" | "打开" => "打开",
        "down" | "close" | "下降" | "关闭" => "关闭",
        "pause" | "暂停" => "暂停",
        "warm" | "暖光" => "暖光",
        "coolwhite" | "冷光" => "冷光",
        "natural" | "自然光" => "自然光",
        _ => return None,
    };
    Some(label.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::{Device, Home, Room};
    use crate::spec::{SpecProperty, SpecService};
    use serde_json::json;

    fn catalog() -> DeviceCatalog {
        let home = Home {
            id: "home-1".to_string(),
            name: "我的家".to_string(),
            uid: 1,
            shared: false,
            room_count: 2,
            rooms: vec![
                Room {
                    id: "room-1".to_string(),
                    name: "客厅".to_string(),
                    dids: vec!["light-1".to_string()],
                },
                Room {
                    id: "room-2".to_string(),
                    name: "主卧".to_string(),
                    dids: vec!["ac-1".to_string()],
                },
            ],
            dids: Vec::new(),
        };
        let devices = vec![
            Device {
                did: "light-1".to_string(),
                name: "客厅吸顶灯".to_string(),
                model: "light.test".to_string(),
                home_id: "home-1".to_string(),
                room_id: Some("room-1".to_string()),
                room_name: Some("客厅".to_string()),
                online: true,
                spec_type: Some("light-spec".to_string()),
                parent_id: None,
                raw: json!({}),
            },
            Device {
                did: "ac-1".to_string(),
                name: "主卧空调".to_string(),
                model: "ac.test".to_string(),
                home_id: "home-1".to_string(),
                room_id: Some("room-2".to_string()),
                room_name: Some("主卧".to_string()),
                online: true,
                spec_type: Some("ac-spec".to_string()),
                parent_id: None,
                raw: json!({}),
            },
        ];
        let light_spec = DeviceSpec {
            kind: "urn:miot-spec-v2:device:light:test:1".to_string(),
            description: "Light".to_string(),
            services: vec![SpecService {
                iid: 2,
                kind: "urn:miot-spec-v2:service:light:test:1".to_string(),
                description: "Light".to_string(),
                properties: vec![
                    spec_property(1, "on", "bool", true, None, None),
                    spec_property(
                        2,
                        "brightness",
                        "uint8",
                        true,
                        Some(SpecValueRange {
                            min: 1.0,
                            max: 100.0,
                            step: 1.0,
                        }),
                        None,
                    ),
                ],
                actions: vec![],
            }],
        };
        let ac_spec = DeviceSpec {
            kind: "urn:miot-spec-v2:device:air-conditioner:test:1".to_string(),
            description: "Air Conditioner".to_string(),
            services: vec![SpecService {
                iid: 2,
                kind: "urn:miot-spec-v2:service:air-conditioner:test:1".to_string(),
                description: "Air Conditioner".to_string(),
                properties: vec![
                    spec_property(1, "on", "bool", true, None, None),
                    spec_property(
                        2,
                        "target-temperature",
                        "int8",
                        true,
                        Some(SpecValueRange {
                            min: 16.0,
                            max: 30.0,
                            step: 1.0,
                        }),
                        None,
                    ),
                    spec_property(
                        3,
                        "mode",
                        "uint8",
                        true,
                        None,
                        Some(vec![
                            SpecValueItem {
                                value: 0,
                                description: "Cool".to_string(),
                            },
                            SpecValueItem {
                                value: 1,
                                description: "Heat".to_string(),
                            },
                        ]),
                    ),
                ],
                actions: vec![],
            }],
        };
        let specs = HashMap::from([
            ("light-spec".to_string(), light_spec),
            ("ac-spec".to_string(), ac_spec),
        ]);
        DeviceCatalog::from_parts(
            &[home],
            &devices,
            &specs,
            &[Scene {
                id: "scene-1".to_string(),
                name: "回家模式".to_string(),
                home_id: "home-1".to_string(),
                raw: json!({}),
            }],
        )
    }

    fn spec_property(
        iid: u32,
        kind: &str,
        format: &str,
        writable: bool,
        value_range: Option<SpecValueRange>,
        value_list: Option<Vec<SpecValueItem>>,
    ) -> SpecProperty {
        SpecProperty {
            iid,
            kind: format!("urn:miot-spec-v2:property:{kind}:test:1"),
            description: String::new(),
            format: format.to_string(),
            access: if writable {
                vec!["read".to_string(), "write".to_string()]
            } else {
                vec!["read".to_string()]
            },
            value_range,
            value_list,
            unit: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn catalog_capability(
        name: &str,
        label: &str,
        piid: u32,
        data_type: &str,
        writable: bool,
        min: f64,
        max: f64,
        step: f64,
        values: &[(i64, &str)],
    ) -> CatalogCapability {
        CatalogCapability {
            name: name.to_string(),
            label: label.to_string(),
            service: String::new(),
            siid: 2,
            piid,
            data_type: data_type.to_string(),
            writable,
            readable: true,
            primary: true,
            unit: None,
            value_range: Some(CatalogValueRange { min, max, step }),
            value_list: values
                .iter()
                .map(|(value, description)| CatalogValueItem {
                    value: *value,
                    description: description.to_string(),
                })
                .collect(),
        }
    }

    fn extended_device(
        did: &str,
        name: &str,
        room: &str,
        category: &str,
        capabilities: Vec<CatalogCapability>,
    ) -> CatalogDevice {
        CatalogDevice {
            did: did.to_string(),
            home_id: "home-1".to_string(),
            home_name: "我的家".to_string(),
            room_id: Some(room.to_string()),
            room_name: room.to_string(),
            name: name.to_string(),
            category: category.to_string(),
            online: true,
            capabilities,
            actions: vec![],
        }
    }

    fn extended_catalog() -> DeviceCatalog {
        DeviceCatalog {
            devices: vec![
                extended_device(
                    "light-1",
                    "客厅吸顶灯",
                    "客厅",
                    "light",
                    vec![
                        catalog_capability("on", "开关", 1, "bool", true, 0.0, 1.0, 1.0, &[]),
                        catalog_capability(
                            "brightness",
                            "亮度",
                            2,
                            "uint8",
                            true,
                            1.0,
                            100.0,
                            1.0,
                            &[],
                        ),
                        catalog_capability(
                            "color_temperature",
                            "色温",
                            3,
                            "uint16",
                            true,
                            2700.0,
                            6500.0,
                            1.0,
                            &[],
                        ),
                        catalog_capability(
                            "color",
                            "颜色",
                            4,
                            "uint32",
                            true,
                            0.0,
                            16_777_215.0,
                            1.0,
                            &[],
                        ),
                    ],
                ),
                extended_device(
                    "light-2",
                    "主卧台灯",
                    "主卧",
                    "light",
                    vec![
                        catalog_capability("on", "开关", 1, "bool", true, 0.0, 1.0, 1.0, &[]),
                        catalog_capability(
                            "brightness",
                            "亮度",
                            2,
                            "uint8",
                            true,
                            1.0,
                            100.0,
                            1.0,
                            &[],
                        ),
                    ],
                ),
                extended_device(
                    "ac-1",
                    "主卧空调",
                    "主卧",
                    "air_conditioner",
                    vec![
                        catalog_capability("on", "开关", 1, "bool", true, 0.0, 1.0, 1.0, &[]),
                        catalog_capability(
                            "target_temperature",
                            "目标温度",
                            2,
                            "int8",
                            true,
                            16.0,
                            30.0,
                            1.0,
                            &[],
                        ),
                        catalog_capability(
                            "mode",
                            "模式",
                            3,
                            "uint8",
                            true,
                            0.0,
                            4.0,
                            1.0,
                            &[
                                (0, "Cool"),
                                (1, "Heat"),
                                (2, "Dry"),
                                (3, "Fan"),
                                (4, "Auto"),
                            ],
                        ),
                        catalog_capability(
                            "fan_level",
                            "风速",
                            4,
                            "uint8",
                            true,
                            1.0,
                            100.0,
                            1.0,
                            &[],
                        ),
                        catalog_capability(
                            "vertical_swing",
                            "上下扫风",
                            5,
                            "bool",
                            true,
                            0.0,
                            1.0,
                            1.0,
                            &[],
                        ),
                        catalog_capability(
                            "horizontal_swing",
                            "左右扫风",
                            6,
                            "bool",
                            true,
                            0.0,
                            1.0,
                            1.0,
                            &[],
                        ),
                    ],
                ),
                extended_device(
                    "curtain-1",
                    "客厅窗帘",
                    "客厅",
                    "curtain",
                    vec![
                        catalog_capability(
                            "motor_control",
                            "电机控制",
                            1,
                            "uint8",
                            true,
                            0.0,
                            2.0,
                            1.0,
                            &[(0, "Pause"), (1, "Open"), (2, "Close")],
                        ),
                        catalog_capability(
                            "current_position",
                            "开合度",
                            2,
                            "uint8",
                            true,
                            0.0,
                            100.0,
                            1.0,
                            &[],
                        ),
                    ],
                ),
                extended_device(
                    "speaker-1",
                    "客厅音箱",
                    "客厅",
                    "speaker",
                    vec![
                        catalog_capability(
                            "volume",
                            "音量",
                            1,
                            "uint8",
                            true,
                            0.0,
                            100.0,
                            1.0,
                            &[],
                        ),
                        catalog_capability("mute", "静音", 2, "bool", true, 0.0, 1.0, 1.0, &[]),
                    ],
                ),
                extended_device(
                    "humidifier-1",
                    "主卧加湿器",
                    "主卧",
                    "humidifier",
                    vec![
                        catalog_capability("on", "开关", 1, "bool", true, 0.0, 1.0, 1.0, &[]),
                        catalog_capability(
                            "relative_humidity",
                            "湿度",
                            2,
                            "uint8",
                            true,
                            30.0,
                            80.0,
                            1.0,
                            &[],
                        ),
                    ],
                ),
                extended_device(
                    "water-heater-1",
                    "阳台热水器",
                    "阳台",
                    "water_heater",
                    vec![
                        catalog_capability("on", "开关", 1, "bool", true, 0.0, 1.0, 1.0, &[]),
                        catalog_capability(
                            "target_temperature",
                            "目标温度",
                            2,
                            "uint8",
                            true,
                            30.0,
                            75.0,
                            1.0,
                            &[],
                        ),
                    ],
                ),
                extended_device(
                    "fridge-1",
                    "厨房冰箱",
                    "厨房",
                    "refrigerator",
                    vec![catalog_capability(
                        "target_temperature",
                        "目标温度",
                        1,
                        "int8",
                        true,
                        1.0,
                        8.0,
                        1.0,
                        &[],
                    )],
                ),
            ],
            scenes: vec![],
        }
    }

    fn bedroom_lights_catalog() -> DeviceCatalog {
        DeviceCatalog {
            devices: vec![
                extended_device(
                    "bedroom-lamp",
                    "卧室台灯",
                    "卧室",
                    "light",
                    vec![catalog_capability(
                        "on",
                        "开关",
                        1,
                        "bool",
                        true,
                        0.0,
                        1.0,
                        1.0,
                        &[],
                    )],
                ),
                extended_device(
                    "bedroom-fanlight",
                    "卧室风扇灯",
                    "卧室",
                    "light",
                    vec![catalog_capability(
                        "on",
                        "开关",
                        1,
                        "bool",
                        true,
                        0.0,
                        1.0,
                        1.0,
                        &[],
                    )],
                ),
            ],
            scenes: vec![],
        }
    }

    fn action_catalog() -> DeviceCatalog {
        let mut tv = extended_device("tv-1", "客厅电视", "客厅", "television", vec![]);
        tv.actions = vec![
            CatalogAction {
                name: "turn_on".to_string(),
                label: "开机".to_string(),
                service: "television".to_string(),
                siid: 2,
                aiid: 1,
            },
            CatalogAction {
                name: "turn_off".to_string(),
                label: "关机".to_string(),
                service: "television".to_string(),
                siid: 2,
                aiid: 2,
            },
        ];
        let mut ir_ac = extended_device(
            "ir-ac-1",
            "客厅空调",
            "客厅",
            "air_conditioner",
            vec![{
                let mut temperature = catalog_capability(
                    "target_temperature",
                    "目标温度",
                    2,
                    "float",
                    true,
                    16.0,
                    30.0,
                    1.0,
                    &[],
                );
                temperature.readable = false;
                temperature
            }],
        );
        ir_ac.actions = vec![
            CatalogAction {
                name: "temperature_up".to_string(),
                label: "升温".to_string(),
                service: "air-conditioner".to_string(),
                siid: 2,
                aiid: 3,
            },
            CatalogAction {
                name: "temperature_down".to_string(),
                label: "降温".to_string(),
                service: "air-conditioner".to_string(),
                siid: 2,
                aiid: 4,
            },
        ];
        let mut speaker =
            extended_device("speaker-action-1", "客厅音箱", "客厅", "speaker", vec![]);
        speaker.actions = vec![CatalogAction {
            name: "pause".to_string(),
            label: "暂停".to_string(),
            service: "speaker".to_string(),
            siid: 2,
            aiid: 1,
        }];
        DeviceCatalog {
            devices: vec![tv, ir_ac, speaker],
            scenes: vec![],
        }
    }

    fn resolve(text: &str) -> ResolveOutcome {
        let catalog = catalog();
        let intent = catalog.parse_local(text).expect("intent");
        catalog.resolve(intent)
    }

    fn operation_for(catalog: &DeviceCatalog, text: &str) -> ResolvedOperation {
        let intent = catalog.parse_local(text).expect("intent");
        match catalog.resolve(intent) {
            outcome @ ResolveOutcome::Ready { .. } => outcome.command().expect("command").operation,
            other => panic!("{text}: {other:?}"),
        }
    }

    fn assert_ready(catalog: &DeviceCatalog, text: &str) {
        let intent = catalog.parse_local(text).expect("intent");
        assert!(
            matches!(catalog.resolve(intent), ResolveOutcome::Ready { .. }),
            "{text}"
        );
    }

    #[test]
    fn parses_and_resolves_power() {
        let outcome = resolve("打开客厅灯");
        let command = outcome.command().expect("command");
        match command.operation {
            ResolvedOperation::SetProperty {
                did,
                siid,
                piid,
                value,
                ..
            } => {
                assert_eq!(did, "light-1");
                assert_eq!((siid, piid), (2, 1));
                assert_eq!(value, json!(true));
            }
            _ => panic!("expected set_property"),
        }
    }

    #[test]
    fn parses_temperature_and_mode() {
        let outcome = resolve("把主卧空调调到26度");
        match outcome.command().expect("command").operation {
            ResolvedOperation::SetProperty {
                did,
                siid,
                piid,
                value,
                ..
            } => {
                assert_eq!(did, "ac-1");
                assert_eq!((siid, piid), (2, 2));
                assert_eq!(value, json!(26));
            }
            _ => panic!("expected set_property"),
        }

        let outcome = resolve("主卧空调制冷");
        match outcome.command().expect("command").operation {
            ResolvedOperation::SetProperty { piid, value, .. } => {
                assert_eq!(piid, 3);
                assert_eq!(value, json!(0));
            }
            _ => panic!("expected set_property"),
        }
    }

    #[test]
    fn parses_light_brightness_without_percent_sign() {
        let outcome = resolve("客厅灯亮度 1");
        match outcome.command().expect("command").operation {
            ResolvedOperation::SetProperty {
                did,
                siid,
                piid,
                value,
                ..
            } => {
                assert_eq!(did, "light-1");
                assert_eq!((siid, piid), (2, 2));
                assert_eq!(value, json!(1));
            }
            _ => panic!("expected set_property"),
        }
    }

    #[test]
    fn parses_common_chinese_number_phrases() {
        let catalog = extended_catalog();
        match operation_for(&catalog, "客厅灯亮度百分之五十") {
            ResolvedOperation::SetProperty { value, .. } => assert_eq!(value, json!(50)),
            other => panic!("expected Chinese percentage: {other:?}"),
        }
        match operation_for(&catalog, "主卧空调调到二十六度") {
            ResolvedOperation::SetProperty {
                capability, value, ..
            } => {
                assert_eq!(capability.name, "target_temperature");
                assert_eq!(value, json!(26));
            }
            other => panic!("expected Chinese temperature: {other:?}"),
        }
    }

    #[test]
    fn parses_relative_adjustments_by_capability() {
        let catalog = extended_catalog();
        match operation_for(&catalog, "把客厅灯调暗一点") {
            ResolvedOperation::AdjustProperty {
                capability,
                direction,
                amount,
                unit,
                ..
            } => {
                assert_eq!(capability.name, "brightness");
                assert_eq!(direction, AdjustmentDirection::Decrease);
                assert_eq!(amount, None);
                assert_eq!(unit, AdjustmentUnit::Percent);
            }
            _ => panic!("expected brightness adjustment"),
        }
        match operation_for(&catalog, "把主卧空调调高一度") {
            ResolvedOperation::AdjustProperty {
                capability,
                direction,
                amount,
                unit,
                ..
            } => {
                assert_eq!(capability.name, "target_temperature");
                assert_eq!(direction, AdjustmentDirection::Increase);
                assert_eq!(amount, Some(1.0));
                assert_eq!(unit, AdjustmentUnit::Degree);
            }
            _ => panic!("expected temperature adjustment"),
        }
        match operation_for(&catalog, "客厅灯色温调暖一点") {
            ResolvedOperation::AdjustProperty {
                capability,
                direction,
                ..
            } => {
                assert_eq!(capability.name, "color_temperature");
                assert_eq!(direction, AdjustmentDirection::Decrease);
            }
            other => panic!("expected color temperature adjustment: {other:?}"),
        }
    }

    #[test]
    fn parses_color_temperature_volume_and_mute() {
        let catalog = extended_catalog();
        match operation_for(&catalog, "客厅灯色温调到3500K") {
            ResolvedOperation::SetProperty {
                capability, value, ..
            } => {
                assert_eq!(capability.name, "color_temperature");
                assert_eq!(value, json!(3500));
            }
            _ => panic!("expected color temperature"),
        }
        match operation_for(&catalog, "客厅灯调成暖光") {
            ResolvedOperation::SetProperty { value, .. } => assert_eq!(value, json!(3650)),
            other => panic!("expected warm light: {other:?}"),
        }
        match operation_for(&catalog, "客厅灯亮度调到50%") {
            ResolvedOperation::SetProperty { value, .. } => assert_eq!(value, json!(50)),
            _ => panic!("expected brightness"),
        }
        match operation_for(&catalog, "音箱音量调到40%") {
            ResolvedOperation::SetProperty {
                capability, value, ..
            } => {
                assert_eq!(capability.name, "volume");
                assert_eq!(value, json!(40));
            }
            _ => panic!("expected volume"),
        }
        match operation_for(&catalog, "给音箱静音") {
            ResolvedOperation::SetProperty { value, .. } => assert_eq!(value, json!(true)),
            _ => panic!("expected mute"),
        }
        match operation_for(&catalog, "取消静音") {
            ResolvedOperation::SetProperty { value, .. } => assert_eq!(value, json!(false)),
            _ => panic!("expected unmute"),
        }
    }

    #[test]
    fn parses_rgb_swing_humidity_and_extended_temperature_targets() {
        let catalog = extended_catalog();
        match operation_for(&catalog, "客厅灯调成蓝色") {
            ResolvedOperation::SetProperty {
                capability, value, ..
            } => {
                assert_eq!(capability.name, "color");
                assert_eq!(value, json!(255));
            }
            other => panic!("expected RGB color: {other:?}"),
        }
        match operation_for(&catalog, "主卧空调上下扫风") {
            ResolvedOperation::SetProperty {
                capability, value, ..
            } => {
                assert_eq!(capability.name, "vertical_swing");
                assert_eq!(value, json!(true));
            }
            other => panic!("expected vertical swing: {other:?}"),
        }
        match operation_for(&catalog, "主卧空调关闭左右扫风") {
            ResolvedOperation::SetProperty {
                capability, value, ..
            } => {
                assert_eq!(capability.name, "horizontal_swing");
                assert_eq!(value, json!(false));
            }
            other => panic!("expected horizontal swing: {other:?}"),
        }
        match operation_for(&catalog, "主卧加湿器湿度调到60%") {
            ResolvedOperation::SetProperty {
                capability, value, ..
            } => {
                assert_eq!(capability.name, "relative_humidity");
                assert_eq!(value, json!(60));
            }
            other => panic!("expected humidity target: {other:?}"),
        }
        match operation_for(&catalog, "阳台热水器调到60度") {
            ResolvedOperation::SetProperty { value, .. } => assert_eq!(value, json!(60)),
            other => panic!("expected water heater temperature: {other:?}"),
        }
        match operation_for(&catalog, "厨房冰箱调到4度") {
            ResolvedOperation::SetProperty { value, .. } => assert_eq!(value, json!(4)),
            other => panic!("expected refrigerator temperature: {other:?}"),
        }

        let color = catalog.parse_local("客厅灯什么颜色").expect("color query");
        assert_eq!(color.action, IntentAction::QueryState);
        assert_eq!(color.capability.as_deref(), Some("color"));
        assert!(matches!(
            catalog.resolve(color),
            ResolveOutcome::Ready { .. }
        ));

        let swing = catalog
            .parse_local("主卧空调上下扫风开着吗")
            .expect("swing query");
        assert_eq!(swing.action, IntentAction::QueryState);
        assert_eq!(swing.capability.as_deref(), Some("vertical_swing"));
        assert!(matches!(
            catalog.resolve(swing),
            ResolveOutcome::Ready { .. }
        ));
    }

    #[test]
    fn parses_colloquial_power_queries_and_vacuum_actions() {
        assert_eq!(extract_power("客厅灯关了"), Some(false));
        assert_eq!(extract_power("客厅灯开了"), Some(true));
        assert_eq!(
            extract_appliance_action("扫地机继续扫地"),
            Some("start_sweep")
        );
        assert_eq!(
            extract_appliance_action("扫地机回去充电"),
            Some("return_to_charge")
        );

        let catalog = extended_catalog();
        let curtain = catalog
            .parse_local("客厅窗帘关好了吗")
            .expect("curtain query");
        assert_eq!(curtain.action, IntentAction::QueryState);
        assert_eq!(curtain.capability.as_deref(), Some("current_position"));
        assert!(matches!(
            catalog.resolve(curtain),
            ResolveOutcome::Ready { .. }
        ));

        let lock = catalog.parse_local("门锁了吗").expect("lock query");
        assert_eq!(lock.action, IntentAction::QueryState);
        assert_eq!(lock.capability.as_deref(), Some("door_state"));
    }

    #[test]
    fn parses_curtain_position_and_motor_control() {
        let catalog = extended_catalog();
        match operation_for(&catalog, "窗帘打开一半") {
            ResolvedOperation::SetProperty {
                capability, value, ..
            } => {
                assert_eq!(capability.name, "current_position");
                assert_eq!(value, json!(50));
            }
            _ => panic!("expected curtain position"),
        }
        match operation_for(&catalog, "打开客厅窗帘") {
            ResolvedOperation::SetProperty {
                capability, value, ..
            } => {
                assert_eq!(capability.name, "motor_control");
                assert_eq!(value, json!(1));
            }
            _ => panic!("expected curtain open"),
        }
        match operation_for(&catalog, "暂停窗帘") {
            ResolvedOperation::SetProperty { value, .. } => assert_eq!(value, json!(0)),
            _ => panic!("expected curtain pause"),
        }
    }

    #[test]
    fn parses_explicit_batch_scope() {
        let catalog = extended_catalog();
        match operation_for(&catalog, "关闭所有灯") {
            ResolvedOperation::Batch {
                operations,
                skipped,
                ..
            } => {
                assert_eq!(operations.len(), 2);
                assert!(skipped.is_empty());
            }
            _ => panic!("expected batch operation"),
        }
    }

    #[test]
    fn structured_miot_device_kind_wins_over_incidental_service_names() {
        let device = Device {
            did: "ac-1".to_string(),
            name: "主卧空调".to_string(),
            model: "xiaomi.light.cfan01".to_string(),
            home_id: "home-1".to_string(),
            room_id: Some("room-1".to_string()),
            room_name: Some("主卧".to_string()),
            online: true,
            spec_type: Some("ac-spec".to_string()),
            parent_id: None,
            raw: json!({}),
        };
        let spec = DeviceSpec {
            kind: "urn:miot-spec-v2:device:air-conditioner:test:1".to_string(),
            description: "Air Conditioner".to_string(),
            services: vec![
                SpecService {
                    iid: 2,
                    kind: "urn:miot-spec-v2:service:air-conditioner:test:1".to_string(),
                    description: "Air Conditioner".to_string(),
                    properties: vec![],
                    actions: vec![],
                },
                SpecService {
                    iid: 3,
                    kind: "urn:miot-spec-v2:service:light:test:1".to_string(),
                    description: "Display light".to_string(),
                    properties: vec![],
                    actions: vec![],
                },
                SpecService {
                    iid: 4,
                    kind: "urn:miot-spec-v2:service:fan:test:1".to_string(),
                    description: "Indoor fan".to_string(),
                    properties: vec![],
                    actions: vec![],
                },
            ],
        };
        assert_eq!(infer_category(&device, Some(&spec)), "air_conditioner");
    }

    #[test]
    fn maps_common_miot_device_kinds_to_catalog_categories() {
        for (kind, expected) in [
            ("light", "light"),
            ("fan-light", "light"),
            ("air-conditioner", "air_conditioner"),
            ("fan", "fan"),
            ("curtain", "curtain"),
            ("airer", "airer"),
            ("outlet", "switch"),
            ("camera", "camera"),
            ("door-lock", "lock"),
            ("television", "television"),
            ("speaker", "speaker"),
            ("temperature-humidity-sensor", "sensor"),
            ("motion-sensor", "sensor"),
            ("air-purifier", "air_purifier"),
            ("fresh-air-system", "fresh_air_system"),
            ("humidifier", "humidifier"),
            ("dehumidifier", "dehumidifier"),
            ("vacuum", "vacuum"),
            ("water-heater", "water_heater"),
            ("heater", "heater"),
            ("bath-heater", "bathroom_heater"),
            ("washing-machine", "washing_machine"),
            ("dishwasher", "dishwasher"),
            ("refrigerator", "refrigerator"),
            ("cooker", "cooker"),
            ("water-purifier", "water_purifier"),
        ] {
            let urn = format!("urn:miot-spec-v2:device:{kind}:test:1");
            assert_eq!(
                category_from_miot_device_kind(&urn),
                Some(expected),
                "{kind}"
            );
        }
    }

    #[test]
    fn infers_fan_light_models_as_lights() {
        let device = Device {
            did: "bedroom-fanlight".to_string(),
            name: "卧室风扇灯".to_string(),
            model: "xiaomi.light.cfan01".to_string(),
            home_id: "home-1".to_string(),
            room_id: Some("room-1".to_string()),
            room_name: Some("卧室".to_string()),
            online: true,
            spec_type: Some("light-spec".to_string()),
            parent_id: None,
            raw: json!({}),
        };
        assert_eq!(infer_category(&device, None), "light");
    }

    #[test]
    fn uses_spec_type_when_the_full_spec_is_not_loaded() {
        let device = Device {
            did: "bedroom-fanlight".to_string(),
            name: "卧室风扇灯".to_string(),
            model: "xiaomi.light.cfan01".to_string(),
            home_id: "home-1".to_string(),
            room_id: Some("room-1".to_string()),
            room_name: Some("卧室".to_string()),
            online: true,
            spec_type: Some("urn:miot-spec-v2:device:light:test:1".to_string()),
            parent_id: None,
            raw: json!({}),
        };
        assert_eq!(infer_category(&device, None), "light");
    }

    #[test]
    fn generic_room_light_controls_every_light_in_the_room() {
        let catalog = bedroom_lights_catalog();
        match operation_for(&catalog, "关闭卧室灯") {
            ResolvedOperation::Batch {
                operations,
                skipped,
                ..
            } => {
                let dids: HashSet<&str> = operations
                    .iter()
                    .map(|operation| match operation {
                        ResolvedOperation::SetProperty { did, .. } => did.as_str(),
                        other => panic!("expected a property operation: {other:?}"),
                    })
                    .collect();
                assert_eq!(dids, HashSet::from(["bedroom-lamp", "bedroom-fanlight"]));
                assert!(skipped.is_empty());
            }
            other => panic!("expected a batch operation: {other:?}"),
        }
    }

    #[test]
    fn generic_room_light_status_queries_every_light_in_the_room() {
        let catalog = bedroom_lights_catalog();
        for text in ["卧室灯现在是什么状态", "帮我看下卧室里两盏灯现在开没开"]
        {
            match operation_for(&catalog, text) {
                ResolvedOperation::QueryProperties {
                    queries, skipped, ..
                } => {
                    let dids: HashSet<&str> =
                        queries.iter().map(|query| query.did.as_str()).collect();
                    assert_eq!(
                        dids,
                        HashSet::from(["bedroom-lamp", "bedroom-fanlight"]),
                        "{text}"
                    );
                    assert!(skipped.is_empty(), "{text}");
                }
                other => panic!("{text}: expected a batch query: {other:?}"),
            }
        }
    }

    #[test]
    fn specific_light_status_query_stays_precise() {
        let catalog = bedroom_lights_catalog();
        match operation_for(&catalog, "卧室台灯现在是什么状态") {
            ResolvedOperation::QueryProperty { did, .. } => {
                assert_eq!(did, "bedroom-lamp");
            }
            other => panic!("expected a single query: {other:?}"),
        }
    }

    #[test]
    fn specific_light_and_fan_light_names_stay_precise() {
        let catalog = bedroom_lights_catalog();
        match operation_for(&catalog, "关闭卧室台灯") {
            ResolvedOperation::SetProperty { did, .. } => {
                assert_eq!(did, "bedroom-lamp");
            }
            other => panic!("expected the desk lamp: {other:?}"),
        }
        match operation_for(&catalog, "关闭卧室吊扇灯") {
            ResolvedOperation::SetProperty { did, .. } => {
                assert_eq!(did, "bedroom-fanlight");
            }
            other => panic!("expected the ceiling fan light: {other:?}"),
        }
        match operation_for(&catalog, "关闭卧室风扇") {
            ResolvedOperation::SetProperty { did, .. } => {
                assert_eq!(did, "bedroom-fanlight");
            }
            other => panic!("expected the fan part of the fan light: {other:?}"),
        }
    }

    #[test]
    fn fan_light_commands_select_the_requested_service() {
        let mut light_on =
            catalog_capability("on", "灯光开关", 1, "bool", true, 0.0, 1.0, 1.0, &[]);
        light_on.service = "light".to_string();
        let mut fan_on = catalog_capability("on", "风扇开关", 10, "bool", true, 0.0, 1.0, 1.0, &[]);
        fan_on.service = "fan".to_string();
        let catalog = DeviceCatalog {
            devices: vec![extended_device(
                "bedroom-fanlight",
                "卧室风扇灯",
                "卧室",
                "light",
                vec![light_on, fan_on],
            )],
            scenes: vec![],
        };
        match operation_for(&catalog, "关闭卧室风扇") {
            ResolvedOperation::SetProperty { piid, .. } => assert_eq!(piid, 10),
            other => panic!("expected the fan service: {other:?}"),
        }
        match operation_for(&catalog, "关闭卧室灯") {
            ResolvedOperation::SetProperty { piid, .. } => assert_eq!(piid, 1),
            other => panic!("expected the light service: {other:?}"),
        }
    }

    #[test]
    fn exact_fan_name_beats_a_fan_light_partial_match() {
        let catalog = DeviceCatalog {
            devices: vec![
                extended_device(
                    "bedroom-fan",
                    "卧室风扇",
                    "卧室",
                    "fan",
                    vec![catalog_capability(
                        "on",
                        "开关",
                        1,
                        "bool",
                        true,
                        0.0,
                        1.0,
                        1.0,
                        &[],
                    )],
                ),
                extended_device(
                    "bedroom-fanlight",
                    "卧室风扇灯",
                    "卧室",
                    "light",
                    vec![catalog_capability(
                        "on",
                        "开关",
                        1,
                        "bool",
                        true,
                        0.0,
                        1.0,
                        1.0,
                        &[],
                    )],
                ),
            ],
            scenes: vec![],
        };
        match operation_for(&catalog, "关闭卧室风扇") {
            ResolvedOperation::SetProperty { did, .. } => assert_eq!(did, "bedroom-fan"),
            other => panic!("expected the exact fan match: {other:?}"),
        }
    }

    #[test]
    fn excludes_named_room_from_batch_scope() {
        let catalog = extended_catalog();
        match operation_for(&catalog, "关闭所有灯，除了客厅灯") {
            ResolvedOperation::Batch { operations, .. } => {
                assert_eq!(operations.len(), 1);
                assert!(matches!(
                    &operations[0],
                    ResolvedOperation::SetProperty { did, .. } if did == "light-2"
                ));
            }
            other => panic!("expected filtered batch: {other:?}"),
        }
    }

    #[test]
    fn falls_back_to_safe_miot_actions() {
        let catalog = action_catalog();
        match operation_for(&catalog, "关闭电视") {
            ResolvedOperation::CallAction {
                name, repeat, siid, ..
            } => {
                assert_eq!(name, "关机");
                assert_eq!(repeat, 1);
                assert_eq!(siid, 2);
            }
            other => panic!("expected TV power action: {other:?}"),
        }
        match operation_for(&catalog, "客厅空调调高两度") {
            ResolvedOperation::CallAction { name, repeat, .. } => {
                assert_eq!(name, "升温");
                assert_eq!(repeat, 2);
            }
            other => panic!("expected IR temperature action: {other:?}"),
        }
        match operation_for(&catalog, "暂停播放") {
            ResolvedOperation::CallAction { name, .. } => assert_eq!(name, "暂停"),
            other => panic!("expected media action: {other:?}"),
        }
        match operation_for(&catalog, "关闭所有电视") {
            ResolvedOperation::Batch { operations, .. } => {
                assert_eq!(operations.len(), 1);
                assert!(matches!(
                    &operations[0],
                    ResolvedOperation::CallAction { .. }
                ));
            }
            other => panic!("expected action batch: {other:?}"),
        }
    }

    #[test]
    fn generic_room_targets_batch_action_only_devices() {
        let mut first = extended_device("tv-1", "客厅电视一", "客厅", "television", vec![]);
        first.actions = vec![CatalogAction {
            name: "turn_off".to_string(),
            label: "关机".to_string(),
            service: "television".to_string(),
            siid: 2,
            aiid: 1,
        }];
        let mut second = extended_device("tv-2", "客厅电视二", "客厅", "television", vec![]);
        second.actions = vec![CatalogAction {
            name: "turn_off".to_string(),
            label: "关机".to_string(),
            service: "television".to_string(),
            siid: 2,
            aiid: 1,
        }];
        let catalog = DeviceCatalog {
            devices: vec![first, second],
            scenes: vec![],
        };
        match operation_for(&catalog, "关闭客厅电视") {
            ResolvedOperation::Batch { operations, .. } => {
                assert_eq!(operations.len(), 2);
                assert!(operations
                    .iter()
                    .all(|operation| matches!(operation, ResolvedOperation::CallAction { .. })));
            }
            other => panic!("expected an action batch: {other:?}"),
        }
    }

    #[test]
    fn exposes_only_safe_no_argument_miot_actions() {
        let spec = DeviceSpec {
            kind: "urn:miot-spec-v2:device:television:test:1".to_string(),
            description: "TV".to_string(),
            services: vec![SpecService {
                iid: 2,
                kind: "urn:miot-spec-v2:service:television:test:1".to_string(),
                description: "TV".to_string(),
                properties: vec![],
                actions: vec![
                    crate::spec::SpecAction {
                        iid: 1,
                        kind: "urn:miot-spec-v2:action:turn-off:test:1".to_string(),
                        description: "Power off".to_string(),
                        inputs: vec![],
                    },
                    crate::spec::SpecAction {
                        iid: 2,
                        kind: "urn:miot-spec-v2:action:post:test:1".to_string(),
                        description: "Post arbitrary content".to_string(),
                        inputs: vec![json!(1)],
                    },
                ],
            }],
        };
        let actions = actions_from_spec(&spec);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].name, "turn_off");
        assert_eq!(actions[0].label, "关机");
    }

    #[test]
    fn queries_volume_without_treating_it_as_brightness() {
        let catalog = extended_catalog();
        let intent = catalog.parse_local("音箱音量多少").expect("query intent");
        assert_eq!(intent.action, IntentAction::QueryState);
        assert_eq!(intent.capability.as_deref(), Some("volume"));
        assert!(matches!(
            catalog.resolve(intent),
            ResolveOutcome::Ready { .. }
        ));
    }

    #[test]
    fn queries_specific_readable_capabilities() {
        let catalog = extended_catalog();
        let brightness = catalog
            .parse_local("客厅灯亮度多少")
            .expect("brightness query");
        assert_eq!(brightness.action, IntentAction::QueryState);
        assert_eq!(brightness.capability.as_deref(), Some("brightness"));
        assert!(matches!(
            catalog.resolve(brightness),
            ResolveOutcome::Ready { .. }
        ));

        let temperature = catalog
            .parse_local("主卧空调温度多少")
            .expect("temperature query");
        match catalog.resolve(temperature) {
            ResolveOutcome::Ready { command, .. } => match command.operation {
                ResolvedOperation::QueryProperty { capability, .. } => {
                    assert_eq!(capability.name, "target_temperature");
                }
                other => panic!("expected temperature query: {other:?}"),
            },
            other => panic!("expected temperature query: {other:?}"),
        }
    }

    #[test]
    fn covers_common_smart_home_phrases() {
        let catalog = extended_catalog();
        for text in [
            "客厅灯打开",
            "关掉主卧台灯",
            "把主卧空调调到26度",
            "主卧空调制冷",
            "主卧空调风大一点",
            "客厅灯调亮一点",
            "客厅灯调成暖光",
            "客厅灯调成蓝色",
            "客厅灯什么颜色",
            "客厅灯色温调冷一点",
            "客厅灯最亮",
            "点亮客厅灯",
            "熄灭客厅灯",
            "主卧空调太热了",
            "主卧空调调到二十六度",
            "主卧空调上下扫风",
            "主卧空调关闭左右扫风",
            "主卧加湿器湿度调到60%",
            "阳台热水器调到60度",
            "厨房冰箱调到4度",
            "客厅窗帘打开",
            "客厅窗帘打开一点",
            "客厅音箱音量调到40",
            "客厅音箱静音",
            "取消静音",
            "关闭所有灯",
        ] {
            assert_ready(&catalog, text);
        }

        let actions = action_catalog();
        for text in [
            "打开电视",
            "关闭电视",
            "暂停播放",
            "客厅空调调低一度",
            "客厅空调调到24度",
        ] {
            assert_ready(&actions, text);
        }
    }

    #[test]
    fn answers_device_online_overview_locally() {
        let catalog = catalog();
        let intent = catalog
            .parse_local("当前有几个设备在线")
            .expect("device overview intent");
        assert_eq!(intent.action, IntentAction::QueryDevices);
        assert_eq!(intent.capability.as_deref(), Some("online_count"));
        let outcome = catalog.resolve(intent);
        match outcome.command().expect("device overview").operation {
            ResolvedOperation::DeviceOverview { reply } => {
                assert!(reply.contains("2 个设备在线"));
                assert!(reply.contains("2 个设备"));
            }
            _ => panic!("expected device overview"),
        }
    }

    #[test]
    fn lists_offline_devices_from_catalog() {
        let mut catalog = catalog();
        catalog.devices[0].online = false;
        let intent = catalog
            .parse_local("哪些设备离线")
            .expect("offline list intent");
        assert_eq!(intent.capability.as_deref(), Some("offline_list"));
        match catalog
            .resolve(intent)
            .command()
            .expect("command")
            .operation
        {
            ResolvedOperation::DeviceOverview { reply } => {
                assert!(reply.contains("当前离线设备有 1 个"));
                assert!(reply.contains("客厅吸顶灯（客厅）"));
            }
            _ => panic!("expected device overview"),
        }
    }

    #[test]
    fn resolves_scene_and_ambiguity() {
        let outcome = resolve("执行回家模式");
        match outcome.command().expect("command").operation {
            ResolvedOperation::RunScene { scene_id, .. } => assert_eq!(scene_id, "scene-1"),
            _ => panic!("expected run_scene"),
        }

        let catalog = catalog();
        let intent = catalog.parse_local("打开空调").expect("intent");
        assert!(matches!(
            catalog.resolve(intent),
            ResolveOutcome::Ready { .. }
        ));
    }

    #[test]
    fn rejects_out_of_range_temperature() {
        let outcome = resolve("主卧空调调到40度");
        assert!(matches!(outcome, ResolveOutcome::NotFound { .. }));
    }

    #[test]
    fn model_output_is_strictly_delimited() {
        let intent = parse_model_content(
            "```json\n{\"action\":\"set_device\",\"target\":{\"device\":\"灯\"},\"capability\":\"on\",\"value\":true,\"confidence\":0.9}\n```",
        )
        .expect("parse");
        assert_eq!(intent.capability.as_deref(), Some("on"));
        assert!(parse_model_content("not json").is_err());
    }

    #[test]
    fn model_digest_does_not_contain_mi_home_ids() {
        let digest = catalog().model_digest().to_string();
        assert!(!digest.contains("light-1"));
        assert!(!digest.contains("ac-1"));
        assert!(!digest.contains("home-1"));
        assert!(!digest.contains("scene-1"));
    }

    #[test]
    fn normalizes_openai_compatible_base_urls() {
        assert_eq!(
            normalize_base_url("127.0.0.1:7863"),
            "http://127.0.0.1:7863/v1"
        );
        assert_eq!(
            normalize_base_url("http://127.0.0.1:7863/v1"),
            "http://127.0.0.1:7863/v1"
        );
        assert_eq!(
            normalize_base_url("https://api.example.com/"),
            "https://api.example.com/v1"
        );
    }

    #[test]
    fn localizes_standard_miot_properties_and_units() {
        assert_eq!(
            semantic_capability_name("temperature"),
            "current_temperature"
        );
        assert_eq!(capability_label("current_temperature", ""), "当前温度");
        assert_eq!(localized_property_unit("celsius").as_deref(), Some("°C"));
        assert_eq!(localized_property_unit("percentage").as_deref(), Some("%"));
        assert_eq!(localized_property_unit("none"), None);
        assert_eq!(localized_property_unit("vendor_points"), None);
    }
}
