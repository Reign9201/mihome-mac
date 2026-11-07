use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const STORE_VERSION: u32 = 1;
const PAIR_CODE_TTL_SECONDS: i64 = 10 * 60;
const PAIR_CODE_MAX_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlatformKind {
    Feishu,
    Wecom,
    Dingtalk,
}

impl PlatformKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Feishu => "feishu",
            Self::Wecom => "wecom",
            Self::Dingtalk => "dingtalk",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionMode {
    Webhook,
    Websocket,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlatformConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mode: Option<ConnectionMode>,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub app_secret: String,
    #[serde(default)]
    pub verification_token: String,
    #[serde(default)]
    pub encrypt_key: String,
}

impl PlatformConfig {
    pub fn effective_mode(&self, platform: PlatformKind) -> ConnectionMode {
        if let Some(mode) = self.mode {
            return mode;
        }
        match platform {
            PlatformKind::Feishu
                if !self.verification_token.trim().is_empty()
                    || !self.encrypt_key.trim().is_empty() =>
            {
                ConnectionMode::Webhook
            }
            PlatformKind::Feishu => ConnectionMode::Websocket,
            PlatformKind::Wecom
                if !self.verification_token.trim().is_empty()
                    || !self.encrypt_key.trim().is_empty() =>
            {
                ConnectionMode::Webhook
            }
            PlatformKind::Wecom => ConnectionMode::Websocket,
            PlatformKind::Dingtalk => ConnectionMode::Websocket,
        }
    }

    pub fn is_configured(&self, platform: PlatformKind) -> bool {
        let has_credentials = !self.app_id.trim().is_empty() && !self.app_secret.trim().is_empty();
        match self.effective_mode(platform) {
            ConnectionMode::Websocket => has_credentials,
            ConnectionMode::Webhook => {
                has_credentials && !self.verification_token.trim().is_empty()
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_llm_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
}

fn default_llm_base_url() -> String {
    "https://api.openai.com/v1".to_string()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AsrProvider {
    Apple,
    #[default]
    WhisperCpp,
    OpenaiCompatible,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrConfig {
    #[serde(default = "default_asr_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub provider: AsrProvider,
    #[serde(default = "default_llm_base_url")]
    pub base_url: String,
    #[serde(default = "default_asr_model")]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_asr_language")]
    pub language: String,
    #[serde(default = "default_asr_command")]
    pub command: String,
    #[serde(default)]
    pub model_path: String,
}

impl Default for AsrConfig {
    fn default() -> Self {
        Self {
            enabled: default_asr_enabled(),
            provider: AsrProvider::WhisperCpp,
            base_url: default_llm_base_url(),
            model: default_asr_model(),
            api_key: String::new(),
            language: default_asr_language(),
            command: default_asr_command(),
            model_path: String::new(),
        }
    }
}

fn default_asr_enabled() -> bool {
    true
}

fn default_asr_model() -> String {
    "whisper-1".to_string()
}

fn default_asr_language() -> String {
    "zh-CN".to_string()
}

fn default_asr_command() -> String {
    "whisper-cli".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrationSettings {
    #[serde(default = "store_version")]
    pub version: u32,
    #[serde(default)]
    pub gateway_enabled: bool,
    #[serde(default = "default_gateway_port")]
    pub gateway_port: u16,
    #[serde(default)]
    pub gateway_token: String,
    #[serde(default)]
    pub feishu: PlatformConfig,
    #[serde(default)]
    pub wecom: PlatformConfig,
    #[serde(default)]
    pub dingtalk: PlatformConfig,
    #[serde(default)]
    pub llm: LlmConfig,
    #[serde(default)]
    pub asr: AsrConfig,
}

fn store_version() -> u32 {
    STORE_VERSION
}

fn default_gateway_port() -> u16 {
    17666
}

impl Default for IntegrationSettings {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            gateway_enabled: false,
            gateway_port: default_gateway_port(),
            gateway_token: random_hex(24),
            feishu: PlatformConfig::default(),
            wecom: PlatformConfig::default(),
            dingtalk: PlatformConfig::default(),
            llm: LlmConfig {
                base_url: default_llm_base_url(),
                ..LlmConfig::default()
            },
            asr: AsrConfig::default(),
        }
    }
}

impl IntegrationSettings {
    pub fn platform(&self, platform: PlatformKind) -> &PlatformConfig {
        match platform {
            PlatformKind::Feishu => &self.feishu,
            PlatformKind::Wecom => &self.wecom,
            PlatformKind::Dingtalk => &self.dingtalk,
        }
    }

    pub fn platform_mut(&mut self, platform: PlatformKind) -> &mut PlatformConfig {
        match platform {
            PlatformKind::Feishu => &mut self.feishu,
            PlatformKind::Wecom => &mut self.wecom,
            PlatformKind::Dingtalk => &mut self.dingtalk,
        }
    }

    fn normalize(&mut self) {
        if self.gateway_port == 0 {
            self.gateway_port = default_gateway_port();
        }
        if self.gateway_token.trim().is_empty() {
            self.gateway_token = random_hex(24);
        }
        if self.llm.base_url.trim().is_empty() {
            self.llm.base_url = default_llm_base_url();
        }
        if self.asr.base_url.trim().is_empty() {
            self.asr.base_url = default_llm_base_url();
        }
        if self.asr.model.trim().is_empty() {
            self.asr.model = default_asr_model();
        }
        if self.asr.language.trim().is_empty() {
            self.asr.language = default_asr_language();
        }
        if self.asr.command.trim().is_empty() {
            self.asr.command = default_asr_command();
        }
        if self.asr.model_path.trim().is_empty() {
            let model = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join("Library/Application Support/MiHome/models/ggml-small-q5_1.bin");
            if model.is_file() {
                self.asr.model_path = model.display().to_string();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingCode {
    pub code: String,
    pub platform: PlatformKind,
    #[serde(default)]
    pub home_id: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub claimed_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Binding {
    pub id: String,
    pub platform: PlatformKind,
    pub external_user_id: String,
    pub chat_id: String,
    pub home_id: String,
    pub created_at: i64,
    #[serde(default)]
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairingCodeView {
    pub code: String,
    pub platform: PlatformKind,
    pub expires_in: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BindingView {
    pub id: String,
    pub platform: PlatformKind,
    pub chat_id_masked: String,
    pub home_id: String,
    pub created_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlatformStatus {
    pub enabled: bool,
    pub configured: bool,
    pub mode: ConnectionMode,
    pub app_id: Option<String>,
    pub secret_configured: bool,
    pub verification_configured: bool,
    pub encryption_configured: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct IntegrationSnapshot {
    pub gateway_enabled: bool,
    pub gateway_port: u16,
    pub gateway_token_masked: String,
    pub gateway_token_configured: bool,
    pub feishu: PlatformStatus,
    pub wecom: PlatformStatus,
    pub dingtalk: PlatformStatus,
    pub llm_enabled: bool,
    pub llm_base_url: String,
    pub llm_model: String,
    pub llm_key_configured: bool,
    pub asr_enabled: bool,
    pub asr_provider: AsrProvider,
    pub asr_base_url: String,
    pub asr_model: String,
    pub asr_language: String,
    pub asr_key_configured: bool,
    pub asr_command: String,
    pub asr_model_path: String,
    pub bindings: Vec<BindingView>,
    pub active_pairing_codes: Vec<PairingCodeView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileData {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    settings: IntegrationSettings,
    #[serde(default)]
    pairings: Vec<PairingCode>,
    #[serde(default)]
    bindings: Vec<Binding>,
}

impl Default for FileData {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            settings: IntegrationSettings::default(),
            pairings: Vec::new(),
            bindings: Vec::new(),
        }
    }
}

pub struct IntegrationStore {
    path: PathBuf,
    data: FileData,
    load_error: Option<String>,
}

impl IntegrationStore {
    pub fn load() -> Self {
        Self::load_from(default_path())
    }

    pub fn load_from(path: PathBuf) -> Self {
        match load_file(&path) {
            Ok(mut data) => {
                data.settings.normalize();
                Self {
                    path,
                    data,
                    load_error: None,
                }
            }
            Err(error) => Self {
                path,
                data: FileData::default(),
                load_error: Some(error.to_string()),
            },
        }
    }

    pub fn load_error(&self) -> Option<&str> {
        self.load_error.as_deref()
    }

    pub fn settings(&self) -> &IntegrationSettings {
        &self.data.settings
    }

    pub fn snapshot(&self) -> IntegrationSnapshot {
        self.snapshot_at(Utc::now().timestamp())
    }

    fn snapshot_at(&self, now: i64) -> IntegrationSnapshot {
        IntegrationSnapshot {
            gateway_enabled: self.data.settings.gateway_enabled,
            gateway_port: self.data.settings.gateway_port,
            gateway_token_masked: mask_token(&self.data.settings.gateway_token),
            gateway_token_configured: !self.data.settings.gateway_token.is_empty(),
            feishu: platform_status(PlatformKind::Feishu, &self.data.settings.feishu),
            wecom: platform_status(PlatformKind::Wecom, &self.data.settings.wecom),
            dingtalk: platform_status(PlatformKind::Dingtalk, &self.data.settings.dingtalk),
            llm_enabled: self.data.settings.llm.enabled,
            llm_base_url: self.data.settings.llm.base_url.clone(),
            llm_model: self.data.settings.llm.model.clone(),
            llm_key_configured: !self.data.settings.llm.api_key.is_empty(),
            asr_enabled: self.data.settings.asr.enabled,
            asr_provider: self.data.settings.asr.provider,
            asr_base_url: self.data.settings.asr.base_url.clone(),
            asr_model: self.data.settings.asr.model.clone(),
            asr_language: self.data.settings.asr.language.clone(),
            asr_key_configured: !self.data.settings.asr.api_key.is_empty(),
            asr_command: self.data.settings.asr.command.clone(),
            asr_model_path: self.data.settings.asr.model_path.clone(),
            bindings: self
                .data
                .bindings
                .iter()
                .map(|binding| BindingView {
                    id: binding.id.clone(),
                    platform: binding.platform,
                    chat_id_masked: mask_id(&binding.chat_id),
                    home_id: binding.home_id.clone(),
                    created_at: binding.created_at,
                    last_seen_at: binding.last_seen_at,
                })
                .collect(),
            active_pairing_codes: self
                .data
                .pairings
                .iter()
                .filter(|pairing| pairing.claimed_by.is_none() && pairing.expires_at > now)
                .map(|pairing| PairingCodeView {
                    code: pairing.code.clone(),
                    platform: pairing.platform,
                    expires_in: (pairing.expires_at - now).max(0),
                    expires_at: pairing.expires_at,
                })
                .collect(),
        }
    }

    pub fn set_gateway(&mut self, enabled: bool, port: u16) -> Result<()> {
        if port == 0 {
            return Err(anyhow!("网关端口不能为 0"));
        }
        let mut next = self.data.settings.clone();
        next.gateway_enabled = enabled;
        next.gateway_port = port;
        self.commit_settings(next)
    }

    pub fn regenerate_gateway_token(&mut self) -> Result<String> {
        let mut next = self.data.settings.clone();
        next.gateway_token = random_hex(24);
        let token = next.gateway_token.clone();
        self.commit_settings(next)?;
        Ok(token)
    }

    pub fn gateway_token(&self) -> &str {
        &self.data.settings.gateway_token
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_platform(
        &mut self,
        platform: PlatformKind,
        enabled: bool,
        mode: Option<ConnectionMode>,
        app_id: String,
        app_secret: Option<String>,
        verification_token: Option<String>,
        encrypt_key: Option<String>,
    ) -> Result<()> {
        let mut next = self.data.settings.clone();
        let target = next.platform_mut(platform);
        target.enabled = enabled;
        if let Some(mode) = mode {
            target.mode = Some(mode);
        }
        if !app_id.trim().is_empty() {
            target.app_id = app_id.trim().chars().take(160).collect();
        }
        if let Some(secret) = app_secret.filter(|secret| !secret.trim().is_empty()) {
            target.app_secret = secret.trim().to_string();
        }
        if let Some(token) = verification_token.filter(|token| !token.trim().is_empty()) {
            target.verification_token = token.trim().to_string();
        }
        if let Some(key) = encrypt_key.filter(|key| !key.trim().is_empty()) {
            target.encrypt_key = key.trim().to_string();
        }
        if enabled && !target.is_configured(platform) {
            return Err(anyhow!(
                "{}配置不完整，请检查凭据和连接模式",
                platform_label(platform)
            ));
        }
        self.commit_settings(next)
    }

    pub fn save_llm(
        &mut self,
        enabled: bool,
        base_url: String,
        model: String,
        api_key: Option<String>,
    ) -> Result<()> {
        let mut next = self.data.settings.clone();
        next.llm.enabled = enabled;
        next.llm.base_url = base_url.trim().trim_end_matches('/').to_string();
        next.llm.model = model.trim().chars().take(120).collect();
        if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
            next.llm.api_key = key.trim().to_string();
        }
        next.normalize();
        self.commit_settings(next)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_asr(
        &mut self,
        enabled: bool,
        provider: AsrProvider,
        base_url: String,
        model: String,
        api_key: Option<String>,
        language: String,
        command: String,
        model_path: String,
    ) -> Result<()> {
        let mut next = self.data.settings.clone();
        next.asr.enabled = enabled;
        next.asr.provider = provider;
        next.asr.base_url = base_url.trim().trim_end_matches('/').to_string();
        next.asr.model = model.trim().chars().take(120).collect();
        next.asr.language = language.trim().chars().take(40).collect();
        next.asr.command = command.trim().chars().take(500).collect();
        next.asr.model_path = model_path.trim().chars().take(1000).collect();
        if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
            next.asr.api_key = key.trim().to_string();
        }
        if enabled
            && provider == AsrProvider::OpenaiCompatible
            && (next.asr.base_url.is_empty() || next.asr.model.is_empty())
        {
            return Err(anyhow!("启用云端语音识别前请填写接口地址和模型名称"));
        }
        if enabled
            && provider == AsrProvider::WhisperCpp
            && (next.asr.command.is_empty() || next.asr.model_path.is_empty())
        {
            return Err(anyhow!("启用 Whisper.cpp 前请填写命令和模型路径"));
        }
        next.normalize();
        self.commit_settings(next)
    }

    pub fn generate_pair_code(
        &mut self,
        platform: PlatformKind,
        home_id: Option<String>,
    ) -> Result<PairingCodeView> {
        let now = Utc::now().timestamp();
        self.data
            .pairings
            .retain(|pairing| pairing.expires_at > now || pairing.claimed_by.is_some());
        let code = loop {
            let candidate = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000));
            if !self
                .data
                .pairings
                .iter()
                .any(|pairing| pairing.code == candidate)
            {
                break candidate;
            }
        };
        let pairing = PairingCode {
            code: code.clone(),
            platform,
            home_id: home_id.filter(|home| !home.trim().is_empty()),
            created_at: now,
            expires_at: now + PAIR_CODE_TTL_SECONDS,
            attempts: 0,
            claimed_by: None,
        };
        let previous = self.data.clone();
        self.data.pairings.push(pairing);
        if let Err(error) = self.save() {
            self.data = previous;
            return Err(error);
        }
        Ok(PairingCodeView {
            code,
            platform,
            expires_in: PAIR_CODE_TTL_SECONDS,
            expires_at: now + PAIR_CODE_TTL_SECONDS,
        })
    }

    pub fn claim_pair_code(
        &mut self,
        code: &str,
        platform: PlatformKind,
        external_user_id: &str,
        chat_id: &str,
        home_id: &str,
    ) -> Result<Binding> {
        let code = code.trim();
        if external_user_id.trim().is_empty() || chat_id.trim().is_empty() {
            return Err(anyhow!("缺少平台用户或会话标识"));
        }
        if home_id.trim().is_empty() {
            return Err(anyhow!("请先在桌面端选择家庭"));
        }
        let now = Utc::now().timestamp();
        let pairing = self
            .data
            .pairings
            .iter_mut()
            .find(|pairing| pairing.code == code && pairing.platform == platform)
            .ok_or_else(|| anyhow!("配对码不存在或平台不匹配"))?;
        if pairing.claimed_by.is_some() {
            return Err(anyhow!("配对码已使用，请重新生成"));
        }
        if pairing.expires_at <= now {
            return Err(anyhow!("配对码已过期，请重新生成"));
        }
        pairing.attempts += 1;
        if pairing.attempts > PAIR_CODE_MAX_ATTEMPTS {
            return Err(anyhow!("尝试次数过多，请重新生成配对码"));
        }
        if let Some(expected_home) = pairing.home_id.as_deref() {
            if expected_home != home_id {
                return Err(anyhow!("配对码与当前家庭不匹配"));
            }
        }
        let binding = Binding {
            id: random_hex(10),
            platform,
            external_user_id: external_user_id.trim().chars().take(200).collect(),
            chat_id: chat_id.trim().chars().take(200).collect(),
            home_id: home_id.trim().to_string(),
            created_at: now,
            last_seen_at: now,
        };
        pairing.claimed_by = Some(binding.id.clone());
        let previous = self.data.clone();
        self.data.bindings.retain(|existing| {
            existing.platform != platform
                || existing.external_user_id != binding.external_user_id
                || existing.chat_id != binding.chat_id
        });
        self.data.bindings.push(binding.clone());
        if let Err(error) = self.save() {
            self.data = previous;
            return Err(error);
        }
        Ok(binding)
    }

    pub fn pair_code_home(&self, code: &str, platform: PlatformKind) -> Result<Option<String>> {
        let now = Utc::now().timestamp();
        let pairing = self
            .data
            .pairings
            .iter()
            .find(|pairing| pairing.code == code.trim() && pairing.platform == platform)
            .ok_or_else(|| anyhow!("配对码不存在或平台不匹配"))?;
        if pairing.claimed_by.is_some() {
            return Err(anyhow!("配对码已使用，请重新生成"));
        }
        if pairing.expires_at <= now {
            return Err(anyhow!("配对码已过期，请重新生成"));
        }
        pairing
            .home_id
            .clone()
            .map(Some)
            .ok_or_else(|| anyhow!("配对码没有绑定家庭，请重新生成"))
    }

    pub fn binding_for(
        &mut self,
        platform: PlatformKind,
        external_user_id: &str,
        chat_id: &str,
    ) -> Option<Binding> {
        let now = Utc::now().timestamp();
        let binding = self.data.bindings.iter_mut().find(|binding| {
            binding.platform == platform
                && binding.external_user_id == external_user_id
                && binding.chat_id == chat_id
        });
        binding.map(|binding| {
            binding.last_seen_at = now;
            binding.clone()
        })
    }

    pub fn revoke_binding(&mut self, id: &str) -> Result<()> {
        let previous = self.data.clone();
        self.data.bindings.retain(|binding| binding.id != id);
        if let Err(error) = self.save() {
            self.data = previous;
            return Err(error);
        }
        Ok(())
    }

    fn commit_settings(&mut self, settings: IntegrationSettings) -> Result<()> {
        if let Some(error) = &self.load_error {
            return Err(anyhow!("接入配置加载失败，已拒绝覆盖：{error}"));
        }
        let previous = self.data.settings.clone();
        let mut settings = settings;
        settings.version = STORE_VERSION;
        settings.normalize();
        self.data.settings = settings;
        if let Err(error) = self.save() {
            self.data.settings = previous;
            return Err(error);
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        if let Some(error) = &self.load_error {
            return Err(anyhow!("接入配置加载失败，已拒绝覆盖：{error}"));
        }
        let bytes = serde_json::to_vec_pretty(&self.data).context("序列化接入配置失败")?;
        write_private_file(&self.path, &bytes)
    }
}

fn platform_status(platform: PlatformKind, config: &PlatformConfig) -> PlatformStatus {
    PlatformStatus {
        enabled: config.enabled,
        configured: config.is_configured(platform),
        mode: config.effective_mode(platform),
        app_id: (!config.app_id.is_empty()).then(|| mask_id(&config.app_id)),
        secret_configured: !config.app_secret.is_empty(),
        verification_configured: !config.verification_token.is_empty(),
        encryption_configured: !config.encrypt_key.is_empty(),
    }
}

fn platform_label(platform: PlatformKind) -> &'static str {
    match platform {
        PlatformKind::Feishu => "飞书",
        PlatformKind::Wecom => "企业微信",
        PlatformKind::Dingtalk => "钉钉",
    }
}

fn default_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Application Support/MiHome/integrations.json")
}

fn load_file(path: &Path) -> Result<FileData> {
    if !path.exists() {
        return Ok(FileData::default());
    }
    let bytes = fs::read(path).with_context(|| format!("读取接入配置失败：{}", path.display()))?;
    if bytes.is_empty() {
        return Err(anyhow!("接入配置文件为空"));
    }
    let data: FileData = serde_json::from_slice(&bytes).context("接入配置文件格式错误")?;
    if data.version != STORE_VERSION {
        return Err(anyhow!("不支持的接入配置版本：{}", data.version));
    }
    Ok(data)
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        let created = !parent.exists();
        fs::create_dir_all(parent)
            .with_context(|| format!("创建接入配置目录失败：{}", parent.display()))?;
        #[cfg(unix)]
        {
            if created {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                    .with_context(|| format!("设置接入配置目录权限失败：{}", parent.display()))?;
            }
        }
    }
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
        .with_context(|| format!("创建接入配置临时文件失败：{}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .with_context(|| format!("设置接入配置权限失败：{}", temp.display()))?;
    }
    file.write_all(bytes).context("写入接入配置失败")?;
    file.sync_all().context("同步接入配置失败")?;
    fs::rename(&temp, path).with_context(|| format!("替换接入配置失败：{}", path.display()))?;
    Ok(())
}

fn random_hex(length: usize) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut rng = rand::thread_rng();
    (0..length)
        .map(|_| HEX[rng.gen_range(0..HEX.len())] as char)
        .collect()
}

fn mask_token(token: &str) -> String {
    if token.is_empty() {
        return String::new();
    }
    let suffix: String = token
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("••••{suffix}")
}

fn mask_id(id: &str) -> String {
    if id.chars().count() <= 8 {
        return "••••".to_string();
    }
    let start: String = id.chars().take(4).collect();
    let end: String = id
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{start}…{end}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("mihome-{name}-{stamp}.json"))
    }

    #[test]
    fn pair_code_is_single_use_and_persisted() {
        let path = temp_path("pair");
        let mut store = IntegrationStore::load_from(path.clone());
        let pairing = store
            .generate_pair_code(PlatformKind::Feishu, Some("home-1".to_string()))
            .expect("pair code");
        let binding = store
            .claim_pair_code(
                &pairing.code,
                PlatformKind::Feishu,
                "user-1",
                "chat-1",
                "home-1",
            )
            .expect("claim");
        assert_eq!(binding.home_id, "home-1");
        assert!(store
            .claim_pair_code(
                &pairing.code,
                PlatformKind::Feishu,
                "user-2",
                "chat-2",
                "home-1"
            )
            .is_err());
        let reloaded = IntegrationStore::load_from(path);
        assert_eq!(reloaded.snapshot().bindings.len(), 1);
    }

    #[test]
    fn secrets_are_not_returned_in_snapshot() {
        let path = temp_path("secrets");
        let mut store = IntegrationStore::load_from(path);
        store
            .save_platform(
                PlatformKind::Feishu,
                true,
                Some(ConnectionMode::Websocket),
                "cli_1234567890".to_string(),
                Some("very-secret".to_string()),
                Some("verify-secret".to_string()),
                None,
            )
            .expect("save");
        let snapshot = serde_json::to_string(&store.snapshot()).expect("snapshot");
        assert!(!snapshot.contains("very-secret"));
        assert!(!snapshot.contains("verify-secret"));
        assert!(snapshot.contains("secret_configured"));
    }

    #[test]
    fn disabling_llm_persists_without_clearing_the_saved_key() {
        let path = temp_path("llm-toggle");
        let mut store = IntegrationStore::load_from(path.clone());
        store
            .save_llm(
                true,
                "http://127.0.0.1:7863/v1".to_string(),
                "test-model".to_string(),
                Some("test-key".to_string()),
            )
            .expect("enable llm");
        store
            .save_llm(
                false,
                "http://127.0.0.1:7863/v1".to_string(),
                "test-model".to_string(),
                None,
            )
            .expect("disable llm");

        let snapshot = store.snapshot();
        assert!(!snapshot.llm_enabled);
        assert!(snapshot.llm_key_configured);
        let reloaded = IntegrationStore::load_from(path);
        assert!(!reloaded.snapshot().llm_enabled);
    }

    #[test]
    fn rejects_wrong_home_for_scoped_code() {
        let path = temp_path("home");
        let mut store = IntegrationStore::load_from(path);
        let pairing = store
            .generate_pair_code(PlatformKind::Feishu, Some("home-1".to_string()))
            .expect("pair code");
        assert!(store
            .claim_pair_code(
                &pairing.code,
                PlatformKind::Feishu,
                "user-1",
                "chat-1",
                "home-2"
            )
            .is_err());
    }

    #[test]
    fn gateway_token_can_be_rotated() {
        let path = temp_path("gateway");
        let mut store = IntegrationStore::load_from(path);
        let before = store.gateway_token().to_string();
        let after = store.regenerate_gateway_token().expect("rotate");
        assert_ne!(before, after);
        assert_eq!(store.gateway_token(), after);
    }

    #[test]
    fn new_platform_defaults_to_websocket() {
        let config = PlatformConfig::default();
        assert_eq!(
            config.effective_mode(PlatformKind::Feishu),
            ConnectionMode::Websocket
        );
        assert_eq!(
            config.effective_mode(PlatformKind::Wecom),
            ConnectionMode::Websocket
        );
        assert!(!config.is_configured(PlatformKind::Feishu));
    }

    #[test]
    fn legacy_webhook_configuration_is_detected() {
        let config = PlatformConfig {
            verification_token: "token".to_string(),
            ..PlatformConfig::default()
        };
        assert_eq!(
            config.effective_mode(PlatformKind::Feishu),
            ConnectionMode::Webhook
        );
    }

    #[test]
    fn webhook_requires_event_verification_secret() {
        let path = temp_path("webhook-validation");
        let mut store = IntegrationStore::load_from(path);
        let error = store
            .save_platform(
                PlatformKind::Feishu,
                true,
                Some(ConnectionMode::Webhook),
                "cli_1234567890".to_string(),
                Some("secret".to_string()),
                None,
                None,
            )
            .expect_err("webhook should require token or encrypt key");
        assert!(error.to_string().contains("配置不完整"));
    }
}
