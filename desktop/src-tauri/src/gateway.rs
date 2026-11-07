use crate::assistant_engine::{self, AssistantRequest};
use crate::platform_bridge;
use crate::{app_log, AppState};
use aes::Aes256;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use chrono::{Local, Utc};
use mihome_core::{ConnectionMode, PlatformKind};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Instant;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

type ApiResponse = (StatusCode, Json<Value>);

#[derive(Default)]
pub(crate) struct GatewayRuntime {
    task: Option<JoinHandle<()>>,
    port: Option<u16>,
    started_at: Option<Instant>,
    error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct GatewayStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub base_url: Option<String>,
    pub uptime_seconds: Option<u64>,
    pub error: Option<String>,
}

pub(crate) async fn start(state: &Arc<AppState>) -> anyhow::Result<GatewayStatus> {
    let mut runtime = state.gateway.lock().await;
    let settings = state.integrations.lock().await.settings().clone();
    if runtime.task.is_some() && runtime.port == Some(settings.gateway_port) {
        return Ok(status_from(&runtime));
    }
    if let Some(task) = runtime.task.take() {
        task.abort();
    }
    let listener = TcpListener::bind(("127.0.0.1", settings.gateway_port))
        .await
        .map_err(|error| {
            let message = format!(
                "本地网关监听 127.0.0.1:{} 失败：{error}",
                settings.gateway_port
            );
            runtime.error = Some(message.clone());
            anyhow::anyhow!(message)
        })?;
    let app = router(Arc::downgrade(state));
    let port = settings.gateway_port;
    let task = tokio::spawn(async move {
        app_log::info("Gateway", format!("本地控制网关已启动：127.0.0.1:{port}"));
        if let Err(error) = axum::serve(listener, app).await {
            app_log::error("Gateway", format!("本地控制网关退出：{error}"));
        }
    });
    runtime.task = Some(task);
    runtime.port = Some(port);
    runtime.started_at = Some(Instant::now());
    runtime.error = None;
    Ok(status_from(&runtime))
}

pub(crate) async fn stop(state: &Arc<AppState>) {
    let mut runtime = state.gateway.lock().await;
    if let Some(task) = runtime.task.take() {
        task.abort();
        app_log::info("Gateway", "本地控制网关已停止");
    }
    runtime.port = None;
    runtime.started_at = None;
    runtime.error = None;
}

pub(crate) async fn autostart(state: &Arc<AppState>) {
    let enabled = state.integrations.lock().await.settings().gateway_enabled;
    if !enabled {
        return;
    }
    if let Err(error) = start(state).await {
        app_log::warn("Gateway", format!("自动启动本地网关失败：{error}"));
    }
}

pub(crate) async fn status(state: &Arc<AppState>) -> GatewayStatus {
    let runtime = state.gateway.lock().await;
    status_from(&runtime)
}

fn status_from(runtime: &GatewayRuntime) -> GatewayStatus {
    GatewayStatus {
        running: runtime
            .task
            .as_ref()
            .is_some_and(|task| !task.is_finished()),
        port: runtime.port,
        base_url: runtime.port.map(|port| format!("http://127.0.0.1:{port}")),
        uptime_seconds: runtime
            .started_at
            .map(|started_at| started_at.elapsed().as_secs()),
        error: runtime.error.clone(),
    }
}

fn router(state: Weak<AppState>) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/catalog", get(catalog))
        .route("/v1/command", post(command))
        .route("/v1/pair/claim", post(claim_pair))
        .route("/v1/platform/feishu", post(feishu_event))
        .route("/v1/platform/wecom", post(wecom_not_implemented))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(state)
}

async fn health(State(state): State<Weak<AppState>>) -> ApiResponse {
    let Some(state) = state.upgrade() else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "应用正在退出");
    };
    let logged_in = state.cloud.lock().await.is_some();
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "service": "mihome-mac-local-gateway",
            "version": env!("CARGO_PKG_VERSION"),
            "logged_in": logged_in,
            "time": Local::now().to_rfc3339(),
        })),
    )
}

async fn catalog(
    State(state): State<Weak<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(state) = state.upgrade() else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "应用正在退出").into_response();
    };
    if !authorized(&state, &headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "网关令牌无效").into_response();
    }
    match assistant_engine::catalog_snapshot(&state, query.get("home_id").map(String::as_str)).await
    {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => api_error(StatusCode::CONFLICT, &error.to_string()).into_response(),
    }
}

async fn command(
    State(state): State<Weak<AppState>>,
    headers: HeaderMap,
    Json(mut request): Json<AssistantRequest>,
) -> Response {
    let Some(state) = state.upgrade() else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "应用正在退出").into_response();
    };
    if !authorized(&state, &headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "网关令牌无效").into_response();
    }
    request
        .source
        .get_or_insert_with(|| "local-api".to_string());
    let response = assistant_engine::handle_request(&state, request).await;
    (StatusCode::OK, Json(response)).into_response()
}

#[derive(Debug, Deserialize)]
struct PairClaimRequest {
    code: String,
    platform: PlatformKind,
    external_user_id: String,
    chat_id: String,
    home_id: String,
}

async fn claim_pair(
    State(state): State<Weak<AppState>>,
    headers: HeaderMap,
    Json(request): Json<PairClaimRequest>,
) -> Response {
    let Some(state) = state.upgrade() else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "应用正在退出").into_response();
    };
    if !authorized(&state, &headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "网关令牌无效").into_response();
    }
    let mut store = state.integrations.lock().await;
    match store.claim_pair_code(
        &request.code,
        request.platform,
        &request.external_user_id,
        &request.chat_id,
        &request.home_id,
    ) {
        Ok(binding) => (
            StatusCode::OK,
            Json(json!({
                "ok": true,
                "binding_id": binding.id,
                "home_id": binding.home_id,
            })),
        )
            .into_response(),
        Err(error) => api_error(StatusCode::BAD_REQUEST, &error.to_string()).into_response(),
    }
}

async fn authorized(state: &Arc<AppState>, headers: &HeaderMap) -> bool {
    let expected = state.integrations.lock().await.gateway_token().to_string();
    let provided = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("");
    !expected.is_empty() && constant_time_eq(expected.as_bytes(), provided.as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

async fn feishu_event(
    State(weak_state): State<Weak<AppState>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let Some(state) = weak_state.upgrade() else {
        return api_error(StatusCode::SERVICE_UNAVAILABLE, "应用正在退出").into_response();
    };
    let config = state.integrations.lock().await.settings().feishu.clone();
    if !config.enabled {
        return api_error(StatusCode::FORBIDDEN, "飞书接入未启用").into_response();
    }
    if config.effective_mode(PlatformKind::Feishu) != ConnectionMode::Webhook {
        return api_error(
            StatusCode::CONFLICT,
            "飞书当前使用长连接模式，Webhook 回调已关闭",
        )
        .into_response();
    }
    if let Err(message) = verify_feishu_signature(&headers, &bytes, &config.encrypt_key) {
        app_log::warn("Feishu", format!("Webhook 签名校验失败：{message}"));
        return api_error(StatusCode::UNAUTHORIZED, &message).into_response();
    }
    let raw: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            return api_error(StatusCode::BAD_REQUEST, "Webhook 请求体不是 JSON").into_response()
        }
    };
    let body = match raw.get("encrypt").and_then(Value::as_str) {
        Some(encrypted) => {
            if config.encrypt_key.is_empty() {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "收到加密事件，但未配置 Encrypt Key",
                )
                .into_response();
            }
            match decrypt_feishu(encrypted, &config.encrypt_key) {
                Ok(body) => body,
                Err(error) => {
                    app_log::warn("Feishu", format!("事件解密失败：{error}"));
                    return api_error(StatusCode::BAD_REQUEST, "事件解密失败").into_response();
                }
            }
        }
        None => raw,
    };
    if body.get("type").and_then(Value::as_str) == Some("url_verification") {
        let token = body
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if config.verification_token.is_empty()
            || !constant_time_eq(config.verification_token.as_bytes(), token.as_bytes())
        {
            return api_error(StatusCode::UNAUTHORIZED, "Verification Token 不匹配")
                .into_response();
        }
        return (
            StatusCode::OK,
            Json(json!({"challenge": body.get("challenge").and_then(Value::as_str).unwrap_or_default()})),
        )
            .into_response();
    }
    let token = body
        .pointer("/header/token")
        .and_then(Value::as_str)
        .or_else(|| body.get("token").and_then(Value::as_str))
        .unwrap_or_default();
    if config.verification_token.is_empty()
        || !constant_time_eq(config.verification_token.as_bytes(), token.as_bytes())
    {
        return api_error(StatusCode::UNAUTHORIZED, "Verification Token 不匹配").into_response();
    }
    if body.pointer("/header/event_type").and_then(Value::as_str) != Some("im.message.receive_v1") {
        return (StatusCode::OK, Json(json!({}))).into_response();
    }
    let event_id = body
        .pointer("/header/event_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let dedup_key = event_id
        .clone()
        .or_else(|| {
            body.pointer("/event/message/message_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("body-{:x}", Sha256::digest(&bytes)));
    if !platform_bridge::claim_event(&state, format!("feishu:http:{dedup_key}")).await {
        return (StatusCode::OK, Json(json!({}))).into_response();
    }
    let Some(text) = feishu_text(&body) else {
        return (StatusCode::OK, Json(json!({}))).into_response();
    };
    let open_id = body
        .pointer("/event/sender/sender_id/open_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let chat_id = body
        .pointer("/event/message/chat_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if open_id.is_empty() || chat_id.is_empty() || text.trim().is_empty() {
        return (StatusCode::OK, Json(json!({}))).into_response();
    }
    tokio::spawn(async move {
        let reply = platform_bridge::handle_platform_message(
            &state,
            PlatformKind::Feishu,
            &open_id,
            &chat_id,
            event_id,
            &text,
        )
        .await;
        if let Err(error) = send_feishu_text(
            &config.app_id,
            &config.app_secret,
            &chat_id,
            &reply.chars().take(3500).collect::<String>(),
        )
        .await
        {
            app_log::warn("Feishu", format!("处理飞书消息失败：{error}"));
        }
    });
    // Feishu requires a callback response within three seconds.
    (StatusCode::OK, Json(json!({}))).into_response()
}

fn feishu_text(body: &Value) -> Option<String> {
    if body
        .pointer("/event/message/message_type")
        .and_then(Value::as_str)
        != Some("text")
    {
        return None;
    }
    let content = body
        .pointer("/event/message/content")
        .and_then(Value::as_str)?;
    let content: Value = serde_json::from_str(content).ok()?;
    let text = platform_bridge::clean_platform_text(content.get("text")?.as_str()?);
    (!text.is_empty()).then_some(text)
}

async fn send_feishu_text(
    app_id: &str,
    app_secret: &str,
    chat_id: &str,
    text: &str,
) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let token = feishu_tenant_token(&client, app_id, app_secret).await?;
    let content = serde_json::to_string(&json!({"text": text}))?;
    let response: Value = client
        .post("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id")
        .bearer_auth(token)
        .json(&json!({
            "receive_id": chat_id,
            "msg_type": "text",
            "content": content,
        }))
        .send()
        .await?
        .json()
        .await?;
    if response.get("code").and_then(Value::as_i64).unwrap_or(0) != 0 {
        anyhow::bail!(
            "飞书消息发送失败：{}",
            response
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("未知错误")
        );
    }
    Ok(())
}

pub(crate) async fn test_feishu_connection(app_id: &str, app_secret: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    feishu_tenant_token(&client, app_id, app_secret).await?;
    Ok(())
}

async fn feishu_tenant_token(
    client: &reqwest::Client,
    app_id: &str,
    app_secret: &str,
) -> anyhow::Result<String> {
    if app_id.trim().is_empty() || app_secret.trim().is_empty() {
        anyhow::bail!("飞书 App ID/Secret 未配置");
    }
    let token_body: Value = client
        .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
        .json(&json!({"app_id": app_id, "app_secret": app_secret}))
        .send()
        .await?
        .json()
        .await?;
    token_body
        .get("tenant_access_token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "获取飞书 tenant_access_token 失败：{}",
                token_body
                    .get("msg")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误")
            )
        })
}

fn verify_feishu_signature(
    headers: &HeaderMap,
    body: &[u8],
    encrypt_key: &str,
) -> Result<(), String> {
    if encrypt_key.is_empty() {
        return Ok(());
    }
    let timestamp = headers
        .get("x-lark-request-timestamp")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "缺少 X-Lark-Request-Timestamp".to_string())?;
    let nonce = headers
        .get("x-lark-request-nonce")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "缺少 X-Lark-Request-Nonce".to_string())?;
    let signature = headers
        .get("x-lark-signature")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "缺少 X-Lark-Signature".to_string())?;
    if nonce.len() > 256 || nonce.is_empty() {
        return Err("X-Lark-Request-Nonce 无效".to_string());
    }
    let mut timestamp_seconds = timestamp
        .parse::<i64>()
        .map_err(|_| "X-Lark-Request-Timestamp 无效".to_string())?;
    if timestamp_seconds > 10_000_000_000 {
        timestamp_seconds /= 1000;
    }
    let now = Utc::now().timestamp();
    if timestamp_seconds < now - 300 || timestamp_seconds > now + 300 {
        return Err("Webhook 请求时间戳已过期".to_string());
    }
    let mut hasher = Sha256::new();
    hasher.update(timestamp.as_bytes());
    hasher.update(nonce.as_bytes());
    hasher.update(encrypt_key.as_bytes());
    hasher.update(body);
    let expected = format!("{:x}", hasher.finalize());
    let signature = signature.to_ascii_lowercase();
    if !constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
        return Err("X-Lark-Signature 不匹配".to_string());
    }
    Ok(())
}

fn decrypt_feishu(encrypted: &str, encrypt_key: &str) -> anyhow::Result<Value> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(encrypted)?;
    if bytes.len() < 17 {
        anyhow::bail!("密文长度无效");
    }
    let iv = &bytes[..16];
    let ciphertext = &bytes[16..];
    let key = Sha256::digest(encrypt_key.as_bytes());
    let mut buffer = ciphertext.to_vec();
    let plaintext = cbc::Decryptor::<Aes256>::new_from_slices(&key, iv)?
        .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        .map_err(|_| anyhow::anyhow!("飞书事件密文填充无效"))?
        .to_vec();
    Ok(serde_json::from_slice(&plaintext)?)
}

async fn wecom_not_implemented() -> Response {
    api_error(
        StatusCode::NOT_IMPLEMENTED,
        "企业微信 Webhook 回调尚未启用。请在接入中心切换到长连接模式。",
    )
    .into_response()
}

fn api_error(status: StatusCode, message: &str) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({
            "ok": false,
            "error": message,
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_feishu_signature() {
        let timestamp = Utc::now().timestamp().to_string();
        let nonce = "nonce-123";
        let encrypt_key = "test-encrypt-key";
        let body = br#"{"encrypt":"payload"}"#;
        let mut hasher = Sha256::new();
        hasher.update(timestamp.as_bytes());
        hasher.update(nonce.as_bytes());
        hasher.update(encrypt_key.as_bytes());
        hasher.update(body);
        let mut headers = HeaderMap::new();
        headers.insert("x-lark-request-timestamp", timestamp.parse().unwrap());
        headers.insert("x-lark-request-nonce", nonce.parse().unwrap());
        headers.insert(
            "x-lark-signature",
            format!("{:x}", hasher.finalize()).parse().unwrap(),
        );
        assert!(verify_feishu_signature(&headers, body, encrypt_key).is_ok());
    }

    #[test]
    fn rejects_stale_feishu_webhook() {
        let timestamp = (Utc::now().timestamp() - 301).to_string();
        let mut headers = HeaderMap::new();
        headers.insert("x-lark-request-timestamp", timestamp.parse().unwrap());
        headers.insert("x-lark-request-nonce", "nonce".parse().unwrap());
        headers.insert("x-lark-signature", "invalid".parse().unwrap());
        assert!(verify_feishu_signature(&headers, b"{}", "key").is_err());
    }

    #[test]
    fn decrypts_feishu_event() {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        let key_text = "test-encrypt-key";
        let key = Sha256::digest(key_text.as_bytes());
        let iv = [7_u8; 16];
        let plaintext = br#"{"type":"url_verification","challenge":"ok"}"#;
        let mut buffer = vec![0_u8; plaintext.len() + 16];
        let encrypted = cbc::Encryptor::<Aes256>::new_from_slices(&key, &iv)
            .expect("cipher")
            .encrypt_padded_b2b_mut::<Pkcs7>(plaintext, &mut buffer)
            .expect("encrypt")
            .to_vec();
        let mut payload = iv.to_vec();
        payload.extend(encrypted);
        let encoded = base64::engine::general_purpose::STANDARD.encode(payload);
        let value = decrypt_feishu(&encoded, key_text).expect("decrypt");
        assert_eq!(value["challenge"], "ok");
    }
}
