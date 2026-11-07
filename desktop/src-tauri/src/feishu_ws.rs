use crate::platform_bridge;
use crate::{app_log, asr, platform_recovery, AppState};
use anyhow::{anyhow, Context, Result};
use lark_channel::lark_openapi::{
    OpenApiClient, ReqwestOpenApiTransport, TokioTungsteniteWebSocketTransport,
    WebSocketConnection, WebSocketEndpoint, WebSocketEventAck,
};
use lark_channel::media::{DownloadedResource, ResourceType};
use lark_channel::{
    ChannelConfig, ChannelEvent, EventLoop, EventLoopOptions, MessageChatType, MessageId,
    MessageSender, MessageSenderType, OpenApiWebSocketEventConnector, WebSocketEndpointConnector,
};
use mihome_core::{ConnectionMode, PlatformConfig, PlatformKind};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;

const MAX_AUTO_RECONNECT_ATTEMPTS: u32 = 5;

#[derive(Default)]
pub(crate) struct FeishuRuntime {
    task: Option<JoinHandle<()>>,
    generation: u64,
    state: String,
    last_error: Option<String>,
    connected_at: Option<Instant>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct FeishuStatus {
    pub running: bool,
    pub state: String,
    pub endpoint: &'static str,
    pub connected_seconds: Option<u64>,
    pub last_error: Option<String>,
}

impl Default for FeishuStatus {
    fn default() -> Self {
        Self {
            running: false,
            state: "stopped".to_string(),
            endpoint: "飞书事件长连接",
            connected_seconds: None,
            last_error: None,
        }
    }
}

#[derive(Clone)]
struct StatusTransport {
    inner: TokioTungsteniteWebSocketTransport,
    state: Arc<AppState>,
    generation: u64,
}

impl WebSocketEndpointConnector for StatusTransport {
    type Connection = WebSocketConnection;

    async fn connect_endpoint(
        &mut self,
        endpoint: &WebSocketEndpoint,
    ) -> lark_channel::Result<Self::Connection> {
        set_status(&self.state, self.generation, "connecting", None, false).await;
        match self.inner.connect(endpoint).await {
            Ok(connection) => {
                set_status(&self.state, self.generation, "connected", None, true).await;
                Ok(connection)
            }
            Err(error) => {
                set_status(
                    &self.state,
                    self.generation,
                    "reconnecting",
                    Some(error.to_string()),
                    false,
                )
                .await;
                Err(error)
            }
        }
    }
}

pub(crate) async fn start(state: &Arc<AppState>) -> Result<FeishuStatus> {
    let config = state.integrations.lock().await.settings().feishu.clone();
    if !config.enabled {
        stop(state).await;
        return Ok(status(state).await);
    }
    if config.effective_mode(PlatformKind::Feishu) != ConnectionMode::Websocket {
        stop(state).await;
        return Err(anyhow!("飞书当前配置为 Webhook 模式，请切换到长连接"));
    }
    let (app_id, app_secret) = credentials_from_config(&config)?;
    let mut runtime = state.feishu_ws.lock().await;
    if let Some(task) = runtime.task.take() {
        task.abort();
    }
    runtime.generation = runtime.generation.wrapping_add(1);
    let generation = runtime.generation;
    runtime.state = "connecting".to_string();
    runtime.last_error = None;
    runtime.connected_at = None;
    let state_for_task = state.clone();
    runtime.task = Some(tokio::spawn(async move {
        let channel_config = ChannelConfig::new(app_id.clone(), app_secret);
        let openapi = OpenApiClient::new(channel_config, ReqwestOpenApiTransport::new());
        let sender = MessageSender::new(openapi.clone());
        for retry_attempt in 0..=MAX_AUTO_RECONNECT_ATTEMPTS {
            app_log::info(
                "Feishu",
                if retry_attempt == 0 {
                    format!("飞书长连接启动：app={}", app_log::mask_id(&app_id))
                } else {
                    format!(
                        "飞书长连接恢复中：app={}，第 {retry_attempt} 次",
                        app_log::mask_id(&app_id)
                    )
                },
            );
            let transport = StatusTransport {
                inner: TokioTungsteniteWebSocketTransport::new(),
                state: state_for_task.clone(),
                generation,
            };
            let connector = OpenApiWebSocketEventConnector::new(openapi.clone(), transport);
            let options = EventLoopOptions::new()
                .with_max_reconnects(3)
                .with_reconnect_delay(Duration::from_secs(2))
                .with_heartbeat_timeout(Some(Duration::from_secs(120)));
            let mut event_loop = EventLoop::with_options(connector, options);
            let state_for_event = state_for_task.clone();
            let sender_for_handler = sender.clone();
            let result = event_loop
                .run(move |event| {
                    let state = state_for_event.clone();
                    let sender = sender_for_handler.clone();
                    async move { handle_event(state, sender, event).await }
                })
                .await;
            let error = match result {
                Ok(exit) => format!("飞书长连接已退出：{exit:?}"),
                Err(error) => format!("飞书长连接异常退出：{error}"),
            };
            if retry_attempt == MAX_AUTO_RECONNECT_ATTEMPTS {
                let message = format!("{error}；自动重连已停止，请点击“重新连接”或等待电脑唤醒");
                set_status(
                    &state_for_task,
                    generation,
                    "error",
                    Some(message.clone()),
                    false,
                )
                .await;
                app_log::warn("Feishu", message);
                break;
            }
            let delay = reconnect_delay(retry_attempt);
            set_status(
                &state_for_task,
                generation,
                "reconnecting",
                Some(format!("{error}；{} 秒后自动重建连接", delay.as_secs())),
                false,
            )
            .await;
            app_log::warn(
                "Feishu",
                format!("{error}；{} 秒后自动重建长连接", delay.as_secs()),
            );
            tokio::time::sleep(delay).await;
        }
    }));
    Ok(status_from(&runtime))
}

pub(crate) async fn stop(state: &Arc<AppState>) {
    let mut runtime = state.feishu_ws.lock().await;
    if let Some(task) = runtime.task.take() {
        task.abort();
    }
    runtime.generation = runtime.generation.wrapping_add(1);
    runtime.state = "stopped".to_string();
    runtime.last_error = None;
    runtime.connected_at = None;
}

pub(crate) async fn autostart(state: &Arc<AppState>) {
    let config = state.integrations.lock().await.settings().feishu.clone();
    if !config.enabled || config.effective_mode(PlatformKind::Feishu) != ConnectionMode::Websocket {
        return;
    }
    if let Err(error) = start(state).await {
        app_log::warn("Feishu", format!("自动启动飞书长连接失败：{error}"));
    }
}

pub(crate) async fn reconnect_if_needed(state: &Arc<AppState>) -> bool {
    let config = state.integrations.lock().await.settings().feishu.clone();
    if !config.enabled || config.effective_mode(PlatformKind::Feishu) != ConnectionMode::Websocket {
        return false;
    }
    let current = status(state).await;
    if !platform_recovery::should_reconnect(current.running, &current.state) {
        return false;
    }
    app_log::info("Feishu", "检测到应用恢复或窗口重新激活，正在重连飞书长连接");
    if let Err(error) = start(state).await {
        app_log::warn("Feishu", format!("恢复飞书长连接失败：{error}"));
    }
    true
}

pub(crate) async fn restart_after_resume(state: &Arc<AppState>) -> bool {
    let config = state.integrations.lock().await.settings().feishu.clone();
    if !config.enabled || config.effective_mode(PlatformKind::Feishu) != ConnectionMode::Websocket {
        return false;
    }
    app_log::info("Feishu", "电脑从睡眠恢复，重建飞书长连接以清理失效会话");
    if let Err(error) = start(state).await {
        app_log::warn("Feishu", format!("睡眠恢复后重连飞书失败：{error}"));
    }
    true
}

pub(crate) async fn status(state: &Arc<AppState>) -> FeishuStatus {
    let runtime = state.feishu_ws.lock().await;
    status_from(&runtime)
}

fn status_from(runtime: &FeishuRuntime) -> FeishuStatus {
    FeishuStatus {
        running: runtime
            .task
            .as_ref()
            .is_some_and(|task| !task.is_finished()),
        state: if runtime.state.is_empty() {
            "stopped".to_string()
        } else {
            runtime.state.clone()
        },
        connected_seconds: runtime
            .connected_at
            .map(|connected_at| connected_at.elapsed().as_secs()),
        last_error: runtime.last_error.clone(),
        ..FeishuStatus::default()
    }
}

async fn handle_event(
    state: Arc<AppState>,
    sender: MessageSender<ReqwestOpenApiTransport>,
    event: lark_channel::ReceivedEvent,
) -> lark_channel::Result<WebSocketEventAck> {
    let ChannelEvent::Message(message) = event.event else {
        return Ok(WebSocketEventAck::ok());
    };
    if message.sender.sender_type == MessageSenderType::Bot {
        return Ok(WebSocketEventAck::ok());
    }
    let is_voice = message.message_type == "audio";
    let is_text = message.message_type == "text" && !message.text.trim().is_empty();
    if !is_text && !is_voice {
        return Ok(WebSocketEventAck::ok());
    }
    let is_pair_command = is_text && platform_bridge::extract_pair_code(&message.text).is_some();
    let should_process = match message.chat_type {
        MessageChatType::P2p => true,
        MessageChatType::Group => !message.mentions.is_empty() || is_pair_command,
        MessageChatType::Unknown => false,
    };
    if !should_process {
        return Ok(WebSocketEventAck::ok());
    }
    let external_user_id = if message.sender.open_id.is_empty() {
        message.sender_id
    } else {
        message.sender.open_id.clone()
    };
    let chat_id = message.chat_id.clone();
    if external_user_id.is_empty() || chat_id.is_empty() {
        return Ok(WebSocketEventAck::ok());
    }
    if !platform_bridge::claim_event(&state, format!("feishu:{}", message.message_id)).await {
        return Ok(WebSocketEventAck::ok());
    }
    let parent_message_id = message.message_id.clone();
    let event_id = message.message_id;
    let voice_resource = message
        .resources
        .iter()
        .find(|resource| resource.resource_type == ResourceType::Audio)
        .cloned();
    let text = if is_text { message.text } else { String::new() };
    tokio::spawn(async move {
        let (text, is_voice) =
            if is_voice {
                let Some(resource) = voice_resource else {
                    send_feishu_reply(
                        &sender,
                        &parent_message_id,
                        "收到语音消息，但没有找到可下载的音频资源。",
                    )
                    .await;
                    return;
                };
                let Some(file_key) = resource.file_key.as_deref() else {
                    send_feishu_reply(
                        &sender,
                        &parent_message_id,
                        "收到语音消息，但飞书事件里没有音频 file_key。",
                    )
                    .await;
                    return;
                };
                app_log::info("Feishu", "收到飞书语音，开始下载并识别");
                let downloaded =
                    match download_feishu_audio(sender.client(), &resource.message_id, file_key)
                        .await
                    {
                        Ok(downloaded) => downloaded,
                        Err(error) => {
                            app_log::warn("Feishu", format!("下载飞书语音失败：{error}"));
                            send_feishu_reply(
                                &sender,
                                &parent_message_id,
                                &format!("下载飞书语音失败：{error}"),
                            )
                            .await;
                            return;
                        }
                    };
                let config = state.integrations.lock().await.settings().asr.clone();
                if !config.enabled {
                    send_feishu_reply(
                        &sender,
                        &parent_message_id,
                        "语音识别未启用。请在 MiHome Mac 接入中心开启语音识别后重试。",
                    )
                    .await;
                    return;
                }
                let extension = audio_extension(
                    resource.file_name.as_deref(),
                    downloaded.content_type.as_deref(),
                );
                let transcribed = asr::transcribe(&config, downloaded.bytes, extension).await;
                match transcribed {
                    Ok(text) => (text, true),
                    Err(error) => {
                        app_log::warn("Feishu", format!("飞书语音识别失败：{error}"));
                        send_feishu_reply(
                            &sender,
                            &parent_message_id,
                            &format!("语音识别失败：{error}"),
                        )
                        .await;
                        return;
                    }
                }
            } else {
                (text, false)
            };
        let reply = platform_bridge::handle_platform_message_with_voice(
            &state,
            PlatformKind::Feishu,
            &external_user_id,
            &chat_id,
            Some(event_id),
            &text,
            is_voice,
        )
        .await;
        send_feishu_reply(&sender, &parent_message_id, &reply).await;
    });
    Ok(WebSocketEventAck::ok())
}

async fn download_feishu_audio(
    client: &lark_channel::lark_openapi::OpenApiClient<ReqwestOpenApiTransport>,
    message_id: &str,
    file_key: &str,
) -> Result<DownloadedResource> {
    let token = client
        .tenant_access_token()
        .await
        .context("获取飞书 tenant_access_token 失败")?;
    let url = build_feishu_audio_url(&client.config().base_url(), message_id, file_key)?;
    let response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .context("创建飞书资源下载客户端失败")?
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| anyhow!("请求飞书资源接口失败：{}", error.without_url()))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_disposition = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let content_length = response.content_length();
    let body = response
        .bytes()
        .await
        .map_err(|error| anyhow!("读取飞书资源响应失败：{}", error.without_url()))?;
    if !status.is_success() {
        return Err(anyhow!("{}", feishu_resource_error(status.as_u16(), &body)));
    }
    if content_length.is_some_and(|length| length > MAX_FEISHU_RESOURCE_BYTES as u64)
        || body.len() > MAX_FEISHU_RESOURCE_BYTES
    {
        return Err(anyhow!("飞书语音超过 100MB 下载上限"));
    }
    Ok(DownloadedResource {
        bytes: body.to_vec(),
        content_type,
        content_disposition,
    })
}

fn build_feishu_audio_url(
    base_url: &reqwest::Url,
    message_id: &str,
    file_key: &str,
) -> Result<reqwest::Url> {
    validate_path_segment(message_id, "message_id")?;
    validate_path_segment(file_key, "file_key")?;
    let path = format!("/open-apis/im/v1/messages/{message_id}/resources/{file_key}");
    let mut url = base_url.join(&path).context("构造飞书语音下载地址失败")?;
    // Feishu's message-resource endpoint only documents `image` and `file`.
    // Audio resources use `file`; `audio` returns 234001 Invalid request param.
    url.query_pairs_mut().append_pair("type", "file");
    Ok(url)
}

const MAX_FEISHU_RESOURCE_BYTES: usize = 100_000_000;

fn validate_path_segment(value: &str, name: &str) -> Result<()> {
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(anyhow!("飞书资源 {name} 格式无效"));
    }
    Ok(())
}

fn feishu_resource_error(status: u16, body: &[u8]) -> String {
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(body) else {
        return format!("飞书资源接口返回 HTTP {status}，响应不是 JSON");
    };
    let code = payload
        .get("code")
        .and_then(serde_json::Value::as_i64)
        .or_else(|| {
            payload
                .pointer("/error/code")
                .and_then(serde_json::Value::as_i64)
        });
    let message = payload
        .get("msg")
        .and_then(serde_json::Value::as_str)
        .or_else(|| payload.get("message").and_then(serde_json::Value::as_str))
        .or_else(|| {
            payload
                .pointer("/error/message")
                .and_then(serde_json::Value::as_str)
        })
        .unwrap_or("飞书未返回具体错误信息");
    let hint = match code {
        Some(234001) => "请求参数无效；飞书语音资源应使用 type=file，请重新发送语音。",
        Some(234003) => "资源不属于这条消息或已失效，请重新发送语音。",
        Some(234004) => "机器人不在该会话中，或无权读取这条消息。",
        Some(234005) => "资源已被删除，请重新发送语音。",
        Some(234008) => "该接口不能读取机器人自己上传的资源。",
        Some(234009) => {
            "应用缺少“获取消息中的资源文件”权限（im:resource）；请在飞书开放平台添加权限并发布新版本。"
        }
        Some(234037) => "语音文件超过飞书 100MB 下载上限。",
        _ if status == 401 || status == 403 => "请重新保存飞书 App ID/Secret 并发布应用。",
        _ => "请确认应用已添加“获取消息中的资源文件”权限并发布版本。",
    };
    match code {
        Some(code) => format!("飞书错误码 {code}：{message}。{hint}"),
        None => format!("飞书资源接口返回 HTTP {status}：{message}。{hint}"),
    }
}

async fn send_feishu_reply(
    sender: &MessageSender<ReqwestOpenApiTransport>,
    parent_message_id: &str,
    reply: &str,
) {
    if let Err(error) = sender
        .text_reply(
            MessageId(parent_message_id.to_string()),
            reply.chars().take(3500).collect::<String>(),
        )
        .send()
        .await
    {
        app_log::warn("Feishu", format!("发送飞书长连接回复失败：{error}"));
    }
}

fn audio_extension(file_name: Option<&str>, content_type: Option<&str>) -> &'static str {
    if let Some(extension) = file_name.and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext)) {
        match extension.to_ascii_lowercase().as_str() {
            "wav" => "wav",
            "mp3" => "mp3",
            "m4a" => "m4a",
            "aac" => "aac",
            "amr" => "amr",
            "ogg" => "ogg",
            "opus" => "opus",
            _ => "bin",
        }
    } else if content_type.is_some_and(|value| value.contains("wav")) {
        "wav"
    } else if content_type.is_some_and(|value| value.contains("mp3")) {
        "mp3"
    } else {
        "opus"
    }
}

fn credentials_from_config(config: &PlatformConfig) -> Result<(String, String)> {
    if config.app_id.trim().is_empty() || config.app_secret.trim().is_empty() {
        return Err(anyhow!("飞书 App ID 或 App Secret 未配置"));
    }
    Ok((
        config.app_id.trim().to_string(),
        config.app_secret.trim().to_string(),
    ))
}

fn reconnect_delay(attempt: u32) -> Duration {
    Duration::from_secs((1_u64 << attempt.min(6)).min(60))
}

async fn set_status(
    state: &Arc<AppState>,
    generation: u64,
    status: &str,
    error: Option<String>,
    connected: bool,
) {
    let mut runtime = state.feishu_ws.lock().await;
    if runtime.generation != generation {
        return;
    }
    runtime.state = status.to_string();
    runtime.last_error = error;
    if connected {
        runtime.connected_at = Some(Instant::now());
    } else {
        runtime.connected_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_feishu_resource_error_details() {
        let error = feishu_resource_error(
            400,
            br#"{"code":234009,"msg":"no permission","error":{"log_id":"log-1"}}"#,
        );
        assert!(error.contains("234009"));
        assert!(error.contains("no permission"));
        assert!(error.contains("im:resource"));
    }

    #[test]
    fn rejects_invalid_resource_path_segments() {
        assert!(validate_path_segment("om_123", "message_id").is_ok());
        assert!(validate_path_segment("file_123", "file_key").is_ok());
        assert!(validate_path_segment("../secret", "file_key").is_err());
    }

    #[test]
    fn builds_audio_resource_download_urls() {
        let base = reqwest::Url::parse("https://open.feishu.cn").expect("base url");
        let url = build_feishu_audio_url(&base, "om_123", "file_456").expect("resource url");
        assert_eq!(
            url.path(),
            "/open-apis/im/v1/messages/om_123/resources/file_456"
        );
        let resource_type = url
            .query_pairs()
            .find(|(name, _)| name == "type")
            .map(|(_, value)| value.into_owned());
        assert_eq!(resource_type.as_deref(), Some("file"));
    }

    #[test]
    fn reconnect_backoff_is_exponential_and_bounded() {
        assert_eq!(reconnect_delay(0), Duration::from_secs(1));
        assert_eq!(reconnect_delay(1), Duration::from_secs(2));
        assert_eq!(reconnect_delay(2), Duration::from_secs(4));
        assert_eq!(reconnect_delay(6), Duration::from_secs(60));
        assert_eq!(reconnect_delay(100), Duration::from_secs(60));
    }
}
