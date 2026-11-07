use anyhow::{anyhow, Context, Result};
use reqwest::cookie::{CookieStore, Jar};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};
use url::Url;

use crate::sign;

const ACCOUNT: &str = "https://account.xiaomi.com";
const LOCALE: &str = "zh_CN";
const REQUEST_INTERVAL: Duration = Duration::from_millis(100);
const REQUEST_CONCURRENCY: usize = 4;

fn can_retry_request(uri: &str) -> bool {
    matches!(
        uri,
        "/v2/homeroom/gethome_merged"
            | "/home/home_device_list"
            | "/v2/home/home_device_list"
            | "/v2/home/device_list_page"
            | "/home/device_list"
            | "/appgateway/miot/appsceneservice/AppSceneService/GetSimpleSceneList"
            | "/miotspec/prop/get"
            | "/v2/device/miss_get_vendor"
    )
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthStart {
    pub qr_svg: String,
    pub expires_in: u64,
}

#[derive(Debug, Clone)]
pub struct PendingLogin {
    client: Client,
    jar: Arc<Jar>,
    lp: String,
    device_id: String,
    pass_o: String,
    ua: String,
    created_at: Instant,
    poll_failures: Arc<AtomicU32>,
}

#[derive(Clone)]
pub struct Session {
    pub user_id: String,
    pub c_user_id: String,
    pub service_token: String,
    pub ssecurity: String,
    pub pass_token: String,
    pub device_id: String,
    pub pass_o: String,
    pub ua: String,
    client: Client,
    gate: Arc<RequestGate>,
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("user_id", &self.user_id)
            .field("device_id", &self.device_id)
            .finish_non_exhaustive()
    }
}

struct RequestGate {
    permits: Arc<Semaphore>,
    next_start: Mutex<Instant>,
}

impl Default for RequestGate {
    fn default() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(REQUEST_CONCURRENCY)),
            next_start: Mutex::new(Instant::now()),
        }
    }
}

impl RequestGate {
    async fn acquire(&self) -> Result<tokio::sync::OwnedSemaphorePermit> {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| anyhow!("云端请求调度器已关闭"))?;
        let start = {
            let mut next = self.next_start.lock().await;
            let now = Instant::now();
            let start = (*next).max(now);
            *next = start + REQUEST_INTERVAL;
            start
        };
        if start > Instant::now() {
            tokio::time::sleep(start - Instant::now()).await;
        }
        Ok(permit)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UserInfo {
    pub user_id: String,
    pub logged_in: bool,
}

fn random_string(n: usize) -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";
    let mut rng = rand::thread_rng();
    (0..n)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}

fn make_ua(pass_o: &str) -> String {
    use rand::Rng;
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut rng = rand::thread_rng();
    let mut hex = |n: usize| -> String {
        (0..n)
            .map(|_| HEX[rng.gen_range(0..HEX.len())] as char)
            .collect()
    };
    format!(
        "Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-{}-CN-{}-{}-SmartHome-MI_APP_STORE-{}|{}|{}-64",
        hex(40), hex(32), hex(32), hex(40), hex(40), pass_o
    )
}

fn make_client() -> Result<(Client, Arc<Jar>)> {
    let jar = Arc::new(Jar::default());
    let client = Client::builder()
        .cookie_provider(jar.clone())
        .gzip(true)
        .timeout(Duration::from_secs(30))
        .build()
        .context("创建 HTTP 客户端失败")?;
    Ok((client, jar))
}

fn cookie_header(device_id: &str, pass_o: &str) -> String {
    format!("deviceId={device_id};pass_o={pass_o};uLocale={LOCALE};")
}

fn parse_service(text: &str) -> Result<Value> {
    let text = sign::strip_prefix(text);
    serde_json::from_str(text).context("小米返回不是 JSON")
}

impl PendingLogin {
    fn poll_retry_delay(&self) -> Duration {
        let failures = self.poll_failures.fetch_add(1, Ordering::Relaxed).min(4);
        poll_retry_delay(failures)
    }

    async fn defer_poll_retry(&self, reason: impl fmt::Display) {
        let delay = self.poll_retry_delay();
        crate::logging::warn(
            "Auth",
            format!("{reason}；{} 秒后继续等待二维码", delay.as_secs()),
        );
        tokio::time::sleep(delay).await;
    }
}

fn poll_retry_delay(failures: u32) -> Duration {
    const DELAYS: [u64; 5] = [1, 2, 4, 8, 15];
    Duration::from_secs(DELAYS[failures.min(DELAYS.len() as u32 - 1) as usize])
}

fn cookie_value(jar: &Jar, url: &str, name: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    let value = jar.cookies(&url)?;
    let text = value.to_str().ok()?;
    let prefix = format!("{name}=");
    text.split(';').find_map(|part| {
        let part = part.trim();
        part.strip_prefix(&prefix).map(|v| v.to_string())
    })
}

pub async fn start_login() -> Result<(PendingLogin, AuthStart)> {
    start_login_for("mijia").await
}

pub async fn start_login_for(sid: &str) -> Result<(PendingLogin, AuthStart)> {
    let device_id = random_string(16);
    let pass_o = random_string(16);
    let ua = make_ua(&pass_o);
    let (client, jar) = make_client()?;

    let service_url = format!("{ACCOUNT}/pass/serviceLogin?_json=true&sid={sid}&_locale={LOCALE}");
    let response = client
        .get(&service_url)
        .header(reqwest::header::USER_AGENT, &ua)
        .header(reqwest::header::COOKIE, cookie_header(&device_id, &pass_o))
        .send()
        .await
        .context("请求 serviceLogin 失败")?;
    let service = parse_service(&response.text().await?)?;
    let location = service
        .get("location")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("未拿到登录 location: {}", service))?;

    let parsed = Url::parse(location).context("location 不是合法 URL")?;
    let mut query: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    for key in ["theme", "bizDeviceType"] {
        query.push((key.to_string(), String::new()));
    }
    query.push(("_hasLogo".to_string(), "false".to_string()));
    query.push(("_qrsize".to_string(), "240".to_string()));
    query.push((
        "_dc".to_string(),
        format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis()
        ),
    ));
    let login_url = {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in &query {
            serializer.append_pair(k, v);
        }
        format!("{ACCOUNT}/longPolling/loginUrl?{}", serializer.finish())
    };
    let response = client
        .get(&login_url)
        .header(reqwest::header::USER_AGENT, &ua)
        .send()
        .await
        .context("请求二维码失败")?;
    let data = parse_service(&response.text().await?)?;
    if data.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(anyhow!("获取二维码失败: {}", data));
    }
    let qr_content = data
        .get("loginUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("二维码内容为空"))?;
    let lp = data
        .get("lp")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("长轮询地址为空"))?
        .to_string();

    let code = qrcode::QrCode::new(qr_content.as_bytes()).context("生成二维码失败")?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .dark_color(qrcode::render::svg::Color("#111111"))
        .light_color(qrcode::render::svg::Color("#f5f0e6"))
        .build();

    let pending = PendingLogin {
        client,
        jar,
        lp,
        device_id,
        pass_o,
        ua,
        created_at: Instant::now(),
        poll_failures: Arc::new(AtomicU32::new(0)),
    };
    Ok((
        pending,
        AuthStart {
            qr_svg: svg,
            expires_in: 300,
        },
    ))
}

pub async fn poll_login(pending: &PendingLogin) -> Result<Option<Session>> {
    if pending.created_at.elapsed() > Duration::from_secs(300) {
        return Err(anyhow!("二维码已过期"));
    }
    let response = match pending
        .client
        .get(&pending.lp)
        .header(reqwest::header::USER_AGENT, &pending.ua)
        .timeout(Duration::from_secs(25))
        .send()
        .await
    {
        Ok(response) => response,
        // The QR stays valid for five minutes; a quiet long poll must not stop the
        // frontend from polling again while the user is still reaching for the phone.
        Err(error) if error.is_timeout() => return Ok(None),
        Err(error) => {
            pending
                .defer_poll_retry(format!("长轮询暂时失败：{error}"))
                .await;
            return Ok(None);
        }
    };
    let status = response.status();
    if matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return Err(anyhow!(
            "小米登录长轮询被拒绝（HTTP {status}）。请重新生成二维码；若持续出现，请检查代理或 VPN"
        ));
    }
    if !status.is_success() {
        pending
            .defer_poll_retry(format!("长轮询返回 HTTP {status}"))
            .await;
        return Ok(None);
    }
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            pending
                .defer_poll_retry(format!("读取长轮询响应失败：{error}"))
                .await;
            return Ok(None);
        }
    };
    let data = match parse_service(&body) {
        Ok(data) => data,
        Err(error) => {
            pending
                .defer_poll_retry(format!("长轮询响应暂时不可解析：{error:#}"))
                .await;
            return Ok(None);
        }
    };
    pending.poll_failures.store(0, Ordering::Relaxed);
    let code = data.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        if let Some(msg) = data.get("message").and_then(Value::as_str) {
            if msg.contains("等待") || msg.contains("未扫码") {
                return Ok(None);
            }
        }
        return Ok(None);
    }
    let callback = data
        .get("location")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("登录回调地址为空: {}", data))?;
    let _ = pending
        .client
        .get(callback)
        .header(reqwest::header::USER_AGENT, &pending.ua)
        .send()
        .await
        .context("访问登录回调失败")?;

    let mut service_token = None;
    for base in [
        "https://api.mijia.tech/",
        "https://sts.api.mijia.tech/",
        "https://api.io.mi.com/",
        "https://sts.api.io.mi.com/",
        "https://account.xiaomi.com/",
    ] {
        service_token = service_token
            .or_else(|| cookie_value(&pending.jar, base, "serviceToken"))
            .or_else(|| cookie_value(&pending.jar, base, "yetAnotherServiceToken"));
    }
    let service_token = service_token.ok_or_else(|| anyhow!("登录成功但没有 serviceToken"))?;
    let ssecurity = data
        .get("ssecurity")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("登录成功但没有 ssecurity"))?
        .to_string();
    let user_id = data
        .get("userId")
        .map(|v| v.to_string().trim_matches('"').to_string())
        .ok_or_else(|| anyhow!("登录成功但没有 userId"))?;
    let c_user_id = data
        .get("cUserId")
        .map(|v| v.to_string().trim_matches('"').to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| cookie_value(&pending.jar, "https://account.xiaomi.com/", "cUserId"))
        .unwrap_or_default();
    let pass_token = data
        .get("passToken")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            [
                "https://account.xiaomi.com/",
                "https://api.mijia.tech/",
                "https://api.io.mi.com/",
            ]
            .into_iter()
            .find_map(|base| cookie_value(&pending.jar, base, "passToken"))
        })
        .unwrap_or_default();

    Ok(Some(Session {
        user_id,
        c_user_id,
        service_token,
        ssecurity,
        pass_token,
        device_id: pending.device_id.clone(),
        pass_o: pending.pass_o.clone(),
        ua: pending.ua.clone(),
        client: pending.client.clone(),
        gate: Arc::new(RequestGate::default()),
    }))
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredSession {
    user_id: String,
    c_user_id: String,
    service_token: String,
    ssecurity: String,
    pass_token: String,
    device_id: String,
    pass_o: String,
    ua: String,
}

fn session_path() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Library/Application Support/MiHome/session.json")
}

fn accounts_path() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Library/Application Support/MiHome/accounts.json")
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredAccount {
    session: StoredSession,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredAccounts {
    #[serde(default = "stored_accounts_version")]
    version: u32,
    #[serde(default)]
    active_user_id: Option<String>,
    #[serde(default)]
    accounts: Vec<StoredAccount>,
}

fn stored_accounts_version() -> u32 {
    1
}

impl Default for StoredAccounts {
    fn default() -> Self {
        Self {
            version: stored_accounts_version(),
            active_user_id: None,
            accounts: Vec::new(),
        }
    }
}

#[derive(Clone)]
struct AccountRecord {
    session: Session,
    display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountSummary {
    pub user_id: String,
    pub display_name: Option<String>,
    pub active: bool,
}

/// Persisted account switcher state. Tokens remain in the private account file;
/// callers only receive non-secret summaries.
#[derive(Clone)]
pub struct AccountBook {
    path: std::path::PathBuf,
    legacy_path: std::path::PathBuf,
    active_user_id: Option<String>,
    accounts: Vec<AccountRecord>,
}

impl AccountBook {
    pub fn empty() -> Self {
        Self {
            path: accounts_path(),
            legacy_path: session_path(),
            active_user_id: None,
            accounts: Vec::new(),
        }
    }

    pub fn load() -> Result<Self> {
        Self::load_from(accounts_path(), session_path())
    }

    fn load_from(path: std::path::PathBuf, legacy_path: std::path::PathBuf) -> Result<Self> {
        if path.exists() {
            let bytes =
                fs::read(&path).with_context(|| format!("读取账号列表失败：{}", path.display()))?;
            let stored: StoredAccounts =
                serde_json::from_slice(&bytes).context("账号列表格式错误")?;
            if stored.version != stored_accounts_version() {
                return Err(anyhow!("不支持的账号列表版本：{}", stored.version));
            }
            let mut accounts = Vec::new();
            for account in stored.accounts {
                accounts.push(AccountRecord {
                    session: Session::from_stored(account.session)?,
                    display_name: clean_display_name(account.display_name),
                });
            }
            let active_user_id = stored
                .active_user_id
                .filter(|id| {
                    accounts
                        .iter()
                        .any(|account| account.session.user_id == *id)
                })
                .or_else(|| {
                    accounts
                        .first()
                        .map(|account| account.session.user_id.clone())
                });
            return Ok(Self {
                path,
                legacy_path,
                active_user_id,
                accounts,
            });
        }

        if legacy_path.exists() {
            let bytes = fs::read(&legacy_path)
                .with_context(|| format!("读取旧登录凭据失败：{}", legacy_path.display()))?;
            let stored: StoredSession =
                serde_json::from_slice(&bytes).context("旧登录凭据格式错误")?;
            let session = Session::from_stored(stored)?;
            let active_user_id = Some(session.user_id.clone());
            let book = Self {
                path,
                legacy_path: legacy_path.clone(),
                active_user_id,
                accounts: vec![AccountRecord {
                    session,
                    display_name: None,
                }],
            };
            book.save()?;
            return Ok(book);
        }

        Ok(Self {
            path,
            legacy_path,
            active_user_id: None,
            accounts: Vec::new(),
        })
    }

    pub fn summaries(&self) -> Vec<AccountSummary> {
        self.accounts
            .iter()
            .map(|account| AccountSummary {
                user_id: account.session.user_id.clone(),
                display_name: account.display_name.clone(),
                active: self.active_user_id.as_deref() == Some(account.session.user_id.as_str()),
            })
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty()
    }

    pub fn active_user_id(&self) -> Option<&str> {
        self.active_user_id.as_deref()
    }

    pub fn active_session(&self) -> Option<Session> {
        let active = self.active_user_id.as_deref()?;
        self.session(active)
    }

    pub fn session(&self, user_id: &str) -> Option<Session> {
        self.accounts
            .iter()
            .find(|account| account.session.user_id == user_id)
            .map(|account| account.session.clone())
    }

    pub fn upsert(&mut self, session: Session, display_name: Option<String>) -> Result<()> {
        let previous = self.clone();
        let display_name = clean_display_name(display_name);
        if let Some(account) = self
            .accounts
            .iter_mut()
            .find(|account| account.session.user_id == session.user_id)
        {
            account.session = session.clone();
            if display_name.is_some() {
                account.display_name = display_name;
            }
        } else {
            self.accounts.insert(
                0,
                AccountRecord {
                    session: session.clone(),
                    display_name,
                },
            );
        }
        self.active_user_id = Some(session.user_id);
        self.save().inspect_err(|_| {
            *self = previous;
        })
    }

    pub fn switch_to(&mut self, user_id: &str) -> Result<Session> {
        let session = self
            .session(user_id)
            .ok_or_else(|| anyhow!("没有找到要切换的账号"))?;
        let previous = self.active_user_id.clone();
        self.active_user_id = Some(user_id.to_string());
        if let Err(error) = self.save() {
            self.active_user_id = previous;
            return Err(error);
        }
        Ok(session)
    }

    pub fn remove(&mut self, user_id: &str) -> Result<Option<Session>> {
        let previous = self.clone();
        self.accounts
            .retain(|account| account.session.user_id != user_id);
        if self.active_user_id.as_deref() == Some(user_id) {
            self.active_user_id = self
                .accounts
                .first()
                .map(|account| account.session.user_id.clone());
        }
        self.save().inspect_err(|_| {
            *self = previous;
        })?;
        Ok(self.active_session())
    }

    pub fn set_display_name(&mut self, user_id: &str, display_name: &str) -> Result<()> {
        let Some(name) = clean_display_name(Some(display_name.to_string())) else {
            return Ok(());
        };
        let previous = self.clone();
        let Some(account) = self
            .accounts
            .iter_mut()
            .find(|account| account.session.user_id == user_id)
        else {
            return Err(anyhow!("没有找到要更新的账号"));
        };
        if account.display_name.as_deref() == Some(name.as_str()) {
            return Ok(());
        }
        account.display_name = Some(name);
        self.save().inspect_err(|_| {
            *self = previous;
        })
    }

    pub fn clear(&mut self) -> Result<()> {
        let previous = self.clone();
        self.accounts.clear();
        self.active_user_id = None;
        self.save().inspect_err(|_| {
            *self = previous;
        })
    }

    fn save(&self) -> Result<()> {
        let stored = StoredAccounts {
            version: stored_accounts_version(),
            active_user_id: self.active_user_id.clone(),
            accounts: self
                .accounts
                .iter()
                .map(|account| StoredAccount {
                    session: account.session.to_stored(),
                    display_name: account.display_name.clone(),
                })
                .collect(),
        };
        let bytes = serde_json::to_vec_pretty(&stored).context("序列化账号列表失败")?;
        write_private_file(&self.path, &bytes)
            .with_context(|| format!("保存账号列表失败：{}", self.path.display()))?;
        if self.legacy_path.exists() {
            let _ = fs::remove_file(&self.legacy_path);
        }
        Ok(())
    }
}

fn clean_display_name(value: Option<String>) -> Option<String> {
    let value = value?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(80).collect())
}

pub fn account_storage_key(user_id: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(user_id.as_bytes()))
}

fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("创建会话目录失败")?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .context("设置会话目录权限失败")?;
    }
    let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temp)
        .with_context(|| format!("创建临时会话失败：{}", temp.display()))?;
    file.write_all(bytes).context("写入临时会话失败")?;
    file.sync_all().context("同步临时会话失败")?;
    fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).context("设置会话权限失败")?;
    fs::rename(&temp, path).with_context(|| format!("替换会话失败：{}", path.display()))?;
    Ok(())
}

impl Session {
    pub fn user_info(&self) -> UserInfo {
        UserInfo {
            user_id: self.user_id.clone(),
            logged_in: true,
        }
    }

    pub fn save(&self) -> Result<()> {
        let mut book = AccountBook::load()?;
        book.upsert(self.clone(), None)
    }

    fn to_stored(&self) -> StoredSession {
        StoredSession {
            user_id: self.user_id.clone(),
            c_user_id: self.c_user_id.clone(),
            service_token: self.service_token.clone(),
            ssecurity: self.ssecurity.clone(),
            pass_token: self.pass_token.clone(),
            device_id: self.device_id.clone(),
            pass_o: self.pass_o.clone(),
            ua: self.ua.clone(),
        }
    }

    pub fn restore() -> Result<Option<Self>> {
        Ok(AccountBook::load()?.active_session())
    }

    fn from_stored(stored: StoredSession) -> Result<Self> {
        let (client, _) = make_client()?;
        Ok(Self {
            user_id: stored.user_id,
            c_user_id: stored.c_user_id,
            service_token: stored.service_token,
            ssecurity: stored.ssecurity,
            pass_token: stored.pass_token,
            device_id: stored.device_id,
            pass_o: stored.pass_o,
            ua: stored.ua,
            client,
            gate: Arc::new(RequestGate::default()),
        })
    }

    pub fn clear_saved() -> Result<()> {
        AccountBook::load()?.clear()
    }

    pub fn cookie(&self) -> String {
        format!(
            "cUserId={};yetAnotherServiceToken={};serviceToken={};userId={};PassportDeviceId={};locale={LOCALE};countryCode=CN;channel=MI_APP_STORE;",
            self.c_user_id, self.service_token, self.service_token, self.user_id, self.device_id
        )
    }

    pub async fn request(&self, uri: &str, data: Value) -> Result<Value> {
        let body = serde_json::to_string(&data)?;
        let nonce = sign::gen_nonce();
        let signed = sign::signed_nonce(&self.ssecurity, &nonce)?;
        let params =
            sign::generate_enc_params(uri, "POST", &signed, &nonce, &body, &self.ssecurity)?;
        let retryable = can_retry_request(uri);
        let mut attempt = 0u32;
        let text = loop {
            let _permit = self.gate.acquire().await?;
            let response = self
                .client
                .post(format!("https://api.mijia.tech/app{uri}"))
                .header(reqwest::header::USER_AGENT, &self.ua)
                .header("accept-encoding", "identity")
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header("miot-accept-encoding", "GZIP")
                .header("miot-encrypt-algorithm", "ENCRYPT-RC4")
                .header("x-xiaomi-protocal-flag-cli", "PROTOCAL-HTTP2")
                .header(reqwest::header::COOKIE, self.cookie())
                .form(&params)
                .send()
                .await;
            match response {
                Ok(response)
                    if (response.status().is_server_error()
                        || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS)
                        && retryable
                        && attempt < 2 =>
                {
                    attempt += 1;
                    let delay = Duration::from_millis(300 * 2u64.pow(attempt));
                    tokio::time::sleep(delay).await;
                }
                Ok(response) if !response.status().is_success() => {
                    return Err(anyhow!("小米云返回 HTTP {}", response.status()));
                }
                Ok(response) => break response.text().await?,
                Err(error)
                    if retryable && attempt < 2 && (error.is_timeout() || error.is_connect()) =>
                {
                    attempt += 1;
                    let delay = Duration::from_millis(300 * 2u64.pow(attempt));
                    tokio::time::sleep(delay).await;
                }
                Err(error) => return Err(error).context("请求小米云失败"),
            }
        };
        let decoded = sign::decode_response(&signed, &text).map_err(|e| anyhow!(e))?;
        let value: Value = serde_json::from_str(&decoded).context("响应不是 JSON")?;
        let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if code != 0 {
            return Err(anyhow!(
                "小米云返回错误 {}: {}",
                code,
                value
                    .get("message")
                    .or_else(|| value.get("desc"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ));
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("响应没有 result"))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        can_retry_request, cookie_value, make_client, poll_retry_delay, write_private_file,
        AccountBook, RequestGate, Session,
    };
    use reqwest::cookie::Jar;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use url::Url;

    fn test_session(user_id: &str, token: &str) -> Session {
        let (client, _) = make_client().expect("test client");
        Session {
            user_id: user_id.to_string(),
            c_user_id: format!("c-{user_id}"),
            service_token: token.to_string(),
            ssecurity: format!("security-{token}"),
            pass_token: format!("pass-{token}"),
            device_id: format!("device-{user_id}"),
            pass_o: format!("pass-o-{user_id}"),
            ua: "test-ua".to_string(),
            client,
            gate: Arc::new(RequestGate::default()),
        }
    }

    #[test]
    fn retries_only_idempotent_cloud_reads() {
        assert!(can_retry_request("/v2/homeroom/gethome_merged"));
        assert!(can_retry_request("/v2/home/device_list_page"));
        assert!(can_retry_request("/v2/home/home_device_list"));
        assert!(can_retry_request("/miotspec/prop/get"));
        assert!(!can_retry_request("/miotspec/prop/set"));
        assert!(!can_retry_request("/miotspec/action"));
        assert!(!can_retry_request(
            "/appgateway/miot/appsceneservice/AppSceneService/NewRunScene"
        ));
    }

    #[test]
    fn login_poll_backoff_is_bounded() {
        assert_eq!(poll_retry_delay(0).as_secs(), 1);
        assert_eq!(poll_retry_delay(1).as_secs(), 2);
        assert_eq!(poll_retry_delay(4).as_secs(), 15);
        assert_eq!(poll_retry_delay(100).as_secs(), 15);
    }

    #[test]
    fn login_can_read_pass_token_from_account_cookie() {
        let jar = Jar::default();
        let url = Url::parse("https://account.xiaomi.com/").expect("account URL");
        jar.add_cookie_str("passToken=test-cookie-token; Path=/; Secure", &url);

        assert_eq!(
            cookie_value(&jar, "https://account.xiaomi.com/", "passToken").as_deref(),
            Some("test-cookie-token")
        );
    }

    #[test]
    fn session_file_and_directory_are_private() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "mihome-auth-session-test-{}-{nonce}",
            std::process::id()
        ));
        let path = dir.join("nested/session.json");
        write_private_file(&path, br#"{"user_id":"test"}"#).expect("write private session");

        let parent_mode = fs::metadata(path.parent().expect("session parent"))
            .expect("session directory")
            .permissions()
            .mode()
            & 0o777;
        let file_mode = fs::metadata(&path)
            .expect("session file")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(parent_mode, 0o700);
        assert_eq!(file_mode, 0o600);
        assert_eq!(
            fs::read(&path).expect("read session"),
            br#"{"user_id":"test"}"#
        );

        fs::remove_dir_all(dir).expect("cleanup session test");
    }

    #[test]
    fn account_book_switches_accounts_without_leaking_sessions() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "mihome-account-book-test-{}-{nonce}",
            std::process::id()
        ));
        let path = dir.join("accounts.json");
        let legacy = dir.join("session.json");
        let mut book = AccountBook::load_from(path.clone(), legacy.clone()).expect("empty book");

        book.upsert(
            test_session("user-a", "token-a"),
            Some("账号 A".to_string()),
        )
        .expect("save first account");
        book.upsert(
            test_session("user-b", "token-b"),
            Some("账号 B".to_string()),
        )
        .expect("save second account");

        assert_eq!(book.active_user_id(), Some("user-b"));
        assert_eq!(book.summaries().len(), 2);
        assert_eq!(
            book.session("user-a").expect("first session").service_token,
            "token-a"
        );
        assert_eq!(
            book.session("user-b")
                .expect("second session")
                .service_token,
            "token-b"
        );

        book.switch_to("user-a").expect("switch account");
        assert_eq!(book.active_user_id(), Some("user-a"));

        let reloaded = AccountBook::load_from(path.clone(), legacy.clone()).expect("reload book");
        assert_eq!(reloaded.active_user_id(), Some("user-a"));
        assert_eq!(reloaded.summaries().len(), 2);
        assert_eq!(
            reloaded
                .session("user-b")
                .expect("second session after reload")
                .service_token,
            "token-b"
        );

        let mut reloaded = reloaded;
        let next = reloaded.remove("user-a").expect("remove active account");
        assert_eq!(
            next.expect("fallback account").user_id,
            "user-b",
            "removing the active account must switch to another isolated session"
        );
        assert_eq!(reloaded.active_user_id(), Some("user-b"));

        let mode = fs::metadata(&path)
            .expect("account file")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);

        reloaded.clear().expect("clear account book");
        assert!(reloaded.is_empty());
        assert!(reloaded.active_session().is_none());

        fs::remove_dir_all(dir).expect("cleanup account book test");
    }

    #[test]
    fn legacy_session_is_migrated_to_the_account_book() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "mihome-account-migration-test-{}-{nonce}",
            std::process::id()
        ));
        let accounts = dir.join("accounts.json");
        let legacy = dir.join("session.json");
        let session = test_session("legacy-user", "legacy-token");
        let stored = serde_json::to_vec(&session.to_stored()).expect("serialize legacy session");
        write_private_file(&legacy, &stored).expect("write legacy session");

        let book = AccountBook::load_from(accounts.clone(), legacy.clone()).expect("migrate");
        assert_eq!(book.active_user_id(), Some("legacy-user"));
        assert_eq!(
            book.active_session().expect("migrated session").pass_token,
            "pass-legacy-token"
        );
        assert!(accounts.exists());
        assert!(!legacy.exists());

        fs::remove_dir_all(dir).expect("cleanup migration test");
    }
}
