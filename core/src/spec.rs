use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};
use url::Url;

const SPEC_ENDPOINT: &str = "https://miot-spec.org/miot-spec-v2/instance";
const SPEC_CONCURRENCY: usize = 6;

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
}

impl Default for SpecRegistry {
    fn default() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("MiHome-Mac/0.1")
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            cache: Mutex::new(HashMap::new()),
        }
    }
}

impl SpecRegistry {
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
                }
                Ok((spec_type, Err(error))) => {
                    errors.push(format!("{spec_type}: {error}"));
                }
                Err(error) => {
                    errors.push(format!("设备规格任务异常: {error}"));
                }
            }
        }

        SpecBatch { specs, errors }
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
}
