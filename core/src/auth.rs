use anyhow::{anyhow, Context, Result};
use reqwest::cookie::{CookieStore, Jar};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};
use url::Url;

use crate::sign;

const ACCOUNT: &str = "https://account.xiaomi.com";
const LOCALE: &str = "zh_CN";
const KEYCHAIN_SERVICE: &str = "com.reign9201.mihomemac.session";
const KEYCHAIN_ACCOUNT: &str = "session";
const KEYCHAIN_ITEM_NOT_FOUND: i32 = -25300;
const REQUEST_INTERVAL: Duration = Duration::from_millis(100);
const REQUEST_CONCURRENCY: usize = 4;

fn can_retry_request(uri: &str) -> bool {
    matches!(
        uri,
        "/v2/homeroom/gethome_merged"
            | "/home/home_device_list"
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
        Err(error) => return Err(error).context("长轮询失败"),
    };
    let data = parse_service(&response.text().await?)?;
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
        .unwrap_or_default()
        .to_string();

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

#[derive(Serialize, Deserialize)]
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

fn use_file_session() -> bool {
    cfg!(debug_assertions) && std::env::var_os("MIHOME_FORCE_FILE_SESSION").is_some()
}

fn remove_legacy_file() -> Result<()> {
    match fs::remove_file(session_path()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("删除旧版明文会话失败"),
    }
}

fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("创建会话目录失败")?;
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

#[cfg(target_os = "macos")]
fn save_secret(bytes: &[u8]) -> Result<()> {
    use security_framework::passwords::set_generic_password;

    if use_file_session() {
        return write_private_file(&session_path(), bytes);
    }
    set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, bytes)
        .context("写入 macOS Keychain 失败")?;
    remove_legacy_file()
}

#[cfg(not(target_os = "macos"))]
fn save_secret(bytes: &[u8]) -> Result<()> {
    write_private_file(&session_path(), bytes)
}

#[cfg(target_os = "macos")]
fn load_secret() -> Result<Option<Vec<u8>>> {
    use security_framework::passwords::get_generic_password;

    if use_file_session() {
        return match fs::read(session_path()) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).context("读取本地会话失败"),
        };
    }
    match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.code() == KEYCHAIN_ITEM_NOT_FOUND => Ok(None),
        Err(error) => Err(error).context("读取 macOS Keychain 失败"),
    }
}

#[cfg(not(target_os = "macos"))]
fn load_secret() -> Result<Option<Vec<u8>>> {
    match fs::read(session_path()) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("读取本地会话失败"),
    }
}

#[cfg(target_os = "macos")]
fn delete_secret() -> Result<()> {
    use security_framework::passwords::delete_generic_password;

    if !use_file_session() {
        match delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            Ok(()) => {}
            Err(error) if error.code() == KEYCHAIN_ITEM_NOT_FOUND => {}
            Err(error) => return Err(error).context("删除 macOS Keychain 会话失败"),
        }
    }
    remove_legacy_file()
}

#[cfg(not(target_os = "macos"))]
fn delete_secret() -> Result<()> {
    remove_legacy_file()
}

impl Session {
    pub fn user_info(&self) -> UserInfo {
        UserInfo {
            user_id: self.user_id.clone(),
            logged_in: true,
        }
    }

    pub fn save(&self) -> Result<()> {
        let stored = StoredSession {
            user_id: self.user_id.clone(),
            c_user_id: self.c_user_id.clone(),
            service_token: self.service_token.clone(),
            ssecurity: self.ssecurity.clone(),
            pass_token: self.pass_token.clone(),
            device_id: self.device_id.clone(),
            pass_o: self.pass_o.clone(),
            ua: self.ua.clone(),
        };
        let bytes = serde_json::to_vec(&stored).context("序列化会话失败")?;
        save_secret(&bytes)
    }

    pub fn restore() -> Result<Option<Self>> {
        let bytes = match load_secret()? {
            Some(bytes) => bytes,
            None if cfg!(target_os = "macos") && !use_file_session() => {
                let legacy = match fs::read(session_path()) {
                    Ok(bytes) => bytes,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(error) => return Err(error).context("读取旧版会话失败"),
                };
                save_secret(&legacy).context("迁移旧版会话到 Keychain 失败")?;
                legacy
            }
            None => return Ok(None),
        };
        let stored: StoredSession = serde_json::from_slice(&bytes).context("登录凭据格式错误")?;
        let (client, _) = make_client()?;
        Ok(Some(Self {
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
        }))
    }

    pub fn clear_saved() -> Result<()> {
        delete_secret()
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
    use super::can_retry_request;

    #[test]
    fn retries_only_idempotent_cloud_reads() {
        assert!(can_retry_request("/v2/homeroom/gethome_merged"));
        assert!(can_retry_request("/miotspec/prop/get"));
        assert!(!can_retry_request("/miotspec/prop/set"));
        assert!(!can_retry_request("/miotspec/action"));
        assert!(!can_retry_request(
            "/appgateway/miot/appsceneservice/AppSceneService/NewRunScene"
        ));
    }
}
