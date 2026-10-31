use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, Semaphore};
use url::Url;

const SPEC_ENDPOINT: &str = "https://miot-spec.org/miot-spec-v2/instance";
const SPEC_CONCURRENCY: usize = 6;
const CACHE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceSpec {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub services: Vec<SpecService>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecService {
    pub iid: u32,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub properties: Vec<SpecProperty>,
    #[serde(default)]
    pub actions: Vec<SpecAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecProperty {
    pub iid: u32,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub access: Vec<String>,
    #[serde(rename = "value-range", default)]
    pub value_range: Option<SpecValueRange>,
    #[serde(rename = "value-list", default)]
    pub value_list: Option<Vec<SpecValueItem>>,
    #[serde(default)]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecAction {
    pub iid: u32,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "in", default)]
    pub inputs: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpecValueRange {
    pub min: f64,
    pub max: f64,
    #[serde(default = "default_step")]
    pub step: f64,
}

impl<'de> Deserialize<'de> for SpecValueRange {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum RawRange {
            Object {
                min: f64,
                max: f64,
                #[serde(default = "default_step")]
                step: f64,
            },
            Array(Vec<f64>),
        }

        match RawRange::deserialize(deserializer)? {
            RawRange::Object { min, max, step } => Ok(Self { min, max, step }),
            RawRange::Array(values) if values.len() >= 2 => Ok(Self {
                min: values[0],
                max: values[1],
                step: values.get(2).copied().unwrap_or_else(default_step),
            }),
            RawRange::Array(_) => Err(de::Error::custom("value-range 至少需要 min 和 max")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecValueItem {
    pub value: i64,
    #[serde(default)]
    pub description: String,
}

fn default_step() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize)]
pub struct SpecBatch {
    pub specs: HashMap<String, DeviceSpec>,
    pub errors: Vec<String>,
}

pub struct SpecRegistry {
    client: Client,
    cache: Mutex<HashMap<String, Arc<DeviceSpec>>>,
    cache_path: PathBuf,
    persist_lock: Mutex<()>,
}

#[derive(Serialize, Deserialize)]
struct DiskSpecCache {
    version: u32,
    saved_at: u64,
    specs: HashMap<String, DeviceSpec>,
}

impl Default for SpecRegistry {
    fn default() -> Self {
        Self::with_cache_path(cache_path())
    }
}

impl SpecRegistry {
    pub fn with_cache_path(cache_path: PathBuf) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("MiHome-Mac/0.1")
            .build()
            .unwrap_or_else(|_| Client::new());
        let cached = load_cache_file(&cache_path).unwrap_or_default();
        Self {
            client,
            cache: Mutex::new(
                cached
                    .into_iter()
                    .map(|(spec_type, spec)| (spec_type, Arc::new(spec)))
                    .collect(),
            ),
            cache_path,
            persist_lock: Mutex::new(()),
        }
    }

    pub async fn load(&self, spec_types: &[String]) -> SpecBatch {
        let unique: HashSet<&str> = spec_types
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect();
        let mut specs = HashMap::new();
        let mut errors = Vec::new();
        let mut missing = Vec::new();
        for spec_type in unique {
            let cached = self.cache.lock().await.get(spec_type).cloned();
            match cached {
                Some(spec) => {
                    specs.insert(spec_type.to_string(), (*spec).clone());
                }
                None => missing.push(spec_type.to_string()),
            }
        }

        let permits = Arc::new(Semaphore::new(SPEC_CONCURRENCY));
        let mut tasks = tokio::task::JoinSet::new();
        let mut fetched = false;
        for spec_type in missing {
            let client = self.client.clone();
            let permits = Arc::clone(&permits);
            tasks.spawn(async move {
                let result = match permits.acquire_owned().await {
                    Ok(_permit) => Self::fetch_with_client(&client, &spec_type).await,
                    Err(_) => Err(anyhow!("设备规格请求调度器已关闭")),
                };
                (spec_type, result)
            });
        }
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok((spec_type, Ok(spec))) => {
                    let spec = Arc::new(spec);
                    self.cache
                        .lock()
                        .await
                        .insert(spec_type.clone(), Arc::clone(&spec));
                    specs.insert(spec_type, (*spec).clone());
                    fetched = true;
                }
                Ok((spec_type, Err(error))) => {
                    errors.push(format!("{spec_type}: {error}"));
                }
                Err(error) => {
                    errors.push(format!("设备规格任务异常: {error}"));
                }
            }
        }
        if fetched {
            self.persist().await;
        }

        SpecBatch { specs, errors }
    }

    async fn persist(&self) {
        let _guard = self.persist_lock.lock().await;
        let snapshot = {
            let cache = self.cache.lock().await;
            cache
                .iter()
                .map(|(spec_type, spec)| (spec_type.clone(), (**spec).clone()))
                .collect::<HashMap<_, _>>()
        };
        if snapshot.is_empty() {
            return;
        }
        let path = self.cache_path.clone();
        match tokio::task::spawn_blocking(move || write_cache_file(&path, &snapshot)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("写入 MIoT-Spec 缓存失败: {error:#}"),
            Err(error) => eprintln!("MIoT-Spec 缓存任务失败: {error}"),
        }
    }

    async fn fetch_with_client(client: &Client, spec_type: &str) -> Result<DeviceSpec> {
        let mut url = Url::parse(SPEC_ENDPOINT).context("规格地址无效")?;
        url.query_pairs_mut().append_pair("type", spec_type);
        let response = client
            .get(url)
            .send()
            .await
            .with_context(|| format!("请求设备规格失败：{spec_type}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(anyhow!("miot-spec.org 返回 HTTP {status}"));
        }
        let value: Value = response.json().await.context("设备规格不是合法 JSON")?;
        parse_spec(&value)
    }
}

fn cache_path() -> PathBuf {
    if let Some(path) = std::env::var_os("MIHOME_SPEC_CACHE") {
        return PathBuf::from(path);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Application Support/MiHome/miot-spec-cache.json")
}

fn load_cache_file(path: &Path) -> anyhow::Result<HashMap<String, DeviceSpec>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("读取规格缓存失败：{}", path.display()))
        }
    };
    let cache: DiskSpecCache = serde_json::from_slice(&bytes)
        .with_context(|| format!("解析规格缓存失败：{}", path.display()))?;
    if cache.version != CACHE_VERSION {
        return Ok(HashMap::new());
    }
    Ok(cache.specs)
}

fn write_cache_file(path: &Path, specs: &HashMap<String, DeviceSpec>) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建设备规格缓存目录失败：{}", parent.display()))?;
    }
    let saved_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let bytes = serde_json::to_vec(&DiskSpecCache {
        version: CACHE_VERSION,
        saved_at,
        specs: specs.clone(),
    })
    .context("序列化设备规格缓存失败")?;
    let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .with_context(|| format!("创建规格缓存临时文件失败：{}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .with_context(|| format!("设置规格缓存权限失败：{}", temp.display()))?;
    }
    file.write_all(&bytes).context("写入规格缓存失败")?;
    file.sync_all().context("同步规格缓存失败")?;
    fs::rename(&temp, path).with_context(|| format!("替换规格缓存失败：{}", path.display()))?;
    Ok(())
}

fn parse_spec(value: &Value) -> Result<DeviceSpec> {
    let mut spec: DeviceSpec =
        serde_json::from_value(value.clone()).context("设备规格字段格式异常")?;
    spec.services.retain(|service| service.iid > 0);
    for service in &mut spec.services {
        service
            .properties
            .retain(|property| property.iid > 0 && supported_property(property));
        service.actions.retain(|action| action.iid > 0);
    }
    Ok(spec)
}

fn supported_property(property: &SpecProperty) -> bool {
    matches!(
        property.format.as_str(),
        "bool" | "uint8" | "uint16" | "uint32" | "int8" | "int16" | "int32" | "float" | "string"
    ) || property.value_list.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_array_value_range_and_actions() {
        let value = json!({
            "type": "urn:miot-spec-v2:device:light:0000A001:test:1",
            "description": "Light",
            "services": [{
                "iid": 2,
                "type": "urn:miot-spec-v2:service:light:00007802:test:1",
                "description": "Light",
                "properties": [{
                    "iid": 2,
                    "type": "urn:miot-spec-v2:property:brightness:0000000D:test:1",
                    "description": "Brightness",
                    "format": "uint8",
                    "access": ["read", "write"],
                    "value-range": [1, 100, 1]
                }],
                "actions": [{
                    "iid": 1,
                    "type": "urn:miot-spec-v2:action:toggle:00002801:test:1",
                    "description": "Toggle",
                    "in": []
                }]
            }]
        });
        let spec = parse_spec(&value).expect("valid spec");
        let range = spec.services[0].properties[0]
            .value_range
            .as_ref()
            .expect("range");
        assert_eq!((range.min, range.max, range.step), (1.0, 100.0, 1.0));
        assert_eq!(spec.services[0].actions[0].iid, 1);
    }

    #[test]
    fn disk_cache_round_trips() {
        let path = std::env::temp_dir().join(format!(
            "mihome-spec-cache-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let value = json!({
            "type": "urn:miot-spec-v2:device:light:0000A001:test:1",
            "services": [{
                "iid": 2,
                "type": "urn:miot-spec-v2:service:light:00007802:test:1",
                "properties": [{
                    "iid": 1,
                    "type": "urn:miot-spec-v2:property:on:00000006:test:1",
                    "format": "bool",
                    "access": ["read", "write"]
                }]
            }]
        });
        let spec = parse_spec(&value).expect("valid spec");
        let specs = HashMap::from([(
            "urn:miot-spec-v2:device:light:0000A001:test:1".to_string(),
            spec,
        )]);
        write_cache_file(&path, &specs).expect("write cache");
        let loaded = load_cache_file(&path).expect("load cache");
        assert_eq!(loaded.len(), 1);
        assert_eq!(
            loaded.values().next().unwrap().services[0].properties[0].iid,
            1
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn ignores_corrupt_cache() {
        let path = std::env::temp_dir().join(format!(
            "mihome-spec-cache-broken-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::write(&path, b"{broken").expect("write broken cache");
        assert!(load_cache_file(&path).is_err());
        let _ = fs::remove_file(path);
    }
}
