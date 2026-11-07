use crate::{app_log, platform_bridge, platform_recovery, AppState};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use dingtalk_stream::frames::down_message::callback_message::CallbackMessage;
use dingtalk_stream::frames::down_message::MessageTopic;
use dingtalk_stream::frames::up_message::callback_message::{WebhookMessage, WebhookMessageAt};
use dingtalk_stream::frames::up_message::MessageContent;
use dingtalk_stream::frames::DingTalkUserId;
use dingtalk_stream::handlers::{CallbackHandler, Error, LifecycleListener, Resp};
use dingtalk_stream::{ClientConfig, Credential, DingTalkStream, TOPIC_ROBOT, VERSION};
use mihome_core::{ConnectionMode, PlatformConfig, PlatformKind};
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::task::JoinHandle;

#[derive(Default)]
pub(crate) struct DingtalkRuntime {
    task: Option<JoinHandle<()>>,
    generation: u64,
    state: String,
    last_error: Option<String>,
    connected_at: Option<Instant>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct DingtalkStatus {
    pub running: bool,
    pub state: String,
    pub endpoint: &'static str,
    pub connected_seconds: Option<u64>,
    pub last_error: Option<String>,
}

impl Default for DingtalkStatus {
    fn default() -> Self {
        Self {
            running: false,
            state: "stopped".to_string(),
            endpoint: "钉钉 Stream 长连接",
            connected_seconds: None,
            last_error: None,
        }
    }
}

#[derive(Clone)]
struct DingtalkCredentials {
    client_id: String,
    client_secret: String,
}

struct StatusListener {
    state: Arc<AppState>,
    generation: u64,
}

#[async_trait]
impl LifecycleListener for StatusListener {
    async fn on_connecting(&self, _client: Arc<DingTalkStream>, _websocket_url: &str) {
        set_status(&self.state, self.generation, "connecting", None, false).await;
    }

    async fn on_connected(&self, _client: Arc<DingTalkStream>, _websocket_url: &str) {
        set_status(&self.state, self.generation, "connected", None, true).await;
        app_log::info("Dingtalk", "钉钉 Stream 长连接已建立");
    }

    async fn on_disconnected(
        &self,
        _client: Arc<DingTalkStream>,
        result: &dingtalk_stream::Result<()>,
    ) {
        let error = result
            .as_ref()
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "连接已断开".to_string());
        set_status(
            &self.state,
            self.generation,
            "reconnecting",
            Some(error),
            false,
        )
        .await;
    }

    async fn on_stopped(&self, _client: Arc<DingTalkStream>) {
        set_status(&self.state, self.generation, "stopped", None, false).await;
    }
}

struct RobotHandler {
    state: Arc<AppState>,
    topic: MessageTopic,
}

struct InboundMessage {
    event_id: String,
    external_user_id: String,
    chat_id: String,
    sender_id: String,
    text: String,
    is_voice: bool,
}

#[async_trait]
impl CallbackHandler for RobotHandler {
    async fn process(
        &self,
        _client: Arc<DingTalkStream>,
        message: &CallbackMessage,
        reply_sender: Option<tokio::sync::mpsc::Sender<WebhookMessage>>,
    ) -> Result<Resp, Error> {
        let Some(data) = message.data.as_ref() else {
            return Ok(Resp::Text("OK".to_string()));
        };
        let value = serde_json::to_value(data).unwrap_or(Value::Null);
        let Some(inbound) = parse_inbound(&value) else {
            return Ok(Resp::Text("OK".to_string()));
        };
        let state = self.state.clone();
        let sender_id = inbound.sender_id.clone();
        tokio::spawn(async move {
            if !platform_bridge::claim_event(&state, format!("dingtalk:{}", inbound.event_id)).await
            {
                return;
            }
            let reply = platform_bridge::handle_platform_message_with_voice(
                &state,
                PlatformKind::Dingtalk,
                &inbound.external_user_id,
                &inbound.chat_id,
                Some(inbound.event_id),
                &inbound.text,
                inbound.is_voice,
            )
            .await;
            let Some(reply_sender) = reply_sender else {
                app_log::warn("Dingtalk", "钉钉消息缺少 sessionWebhook，无法回复");
                return;
            };
            let message = WebhookMessage {
                content: MessageContent::Text {
                    text: reply.chars().take(3500).collect::<String>().into(),
                },
                at: WebhookMessageAt {
                    at_all: false,
                    at_user_ids: Some(vec![DingTalkUserId(sender_id)]),
                },
                send_result_cb: None,
            };
            if reply_sender.send(message).await.is_err() {
                app_log::warn("Dingtalk", "钉钉 sessionWebhook 回复通道已关闭");
            }
        });
        Ok(Resp::Text("OK".to_string()))
    }

    fn topic(&self) -> &MessageTopic {
        &self.topic
    }
}

pub(crate) async fn start(state: &Arc<AppState>) -> Result<DingtalkStatus> {
    let config = state.integrations.lock().await.settings().dingtalk.clone();
    if !config.enabled {
        stop(state).await;
        return Ok(status(state).await);
    }
    if config.effective_mode(PlatformKind::Dingtalk) != ConnectionMode::Websocket {
        stop(state).await;
        return Err(anyhow!("钉钉当前只支持 Stream 长连接"));
    }
    let credentials = credentials_from_config(&config)?;
    let mut runtime = state.dingtalk_ws.lock().await;
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
        app_log::info(
            "Dingtalk",
            format!(
                "钉钉 Stream 启动：client={}",
                app_log::mask_id(&credentials.client_id)
            ),
        );
        let handler = Arc::new(RobotHandler {
            state: state_for_task.clone(),
            topic: MessageTopic::Callback(TOPIC_ROBOT.to_string()),
        });
        let listener = Arc::new(StatusListener {
            state: state_for_task.clone(),
            generation,
        });
        let config = ClientConfig {
            auto_reconnect: true,
            ua: format!("MiHome-Mac/{VERSION}"),
            reconnect_interval: Duration::from_secs(5),
            keep_alive_interval: Duration::from_secs(30),
        };
        let client = DingTalkStream::with_config(
            Credential::new(credentials.client_id, credentials.client_secret),
            config,
        )
        .register_callback_handler(handler)
        .await
        .register_lifecycle_listener(listener)
        .await;
        let client = Arc::new(client);
        let (_client, join) = match client.start().await {
            Ok(started) => started,
            Err(error) => {
                set_status(
                    &state_for_task,
                    generation,
                    "error",
                    Some(error.to_string()),
                    false,
                )
                .await;
                return;
            }
        };
        match join.await {
            Ok(Ok(())) => {
                set_status(&state_for_task, generation, "stopped", None, false).await;
            }
            Ok(Err(error)) => {
                set_status(
                    &state_for_task,
                    generation,
                    "error",
                    Some(error.to_string()),
                    false,
                )
                .await;
            }
            Err(error) => {
                set_status(
                    &state_for_task,
                    generation,
                    "error",
                    Some(error.to_string()),
                    false,
                )
                .await;
            }
        }
    }));
    Ok(status_from(&runtime))
}

pub(crate) async fn stop(state: &Arc<AppState>) {
    let mut runtime = state.dingtalk_ws.lock().await;
    if let Some(task) = runtime.task.take() {
        task.abort();
    }
    runtime.generation = runtime.generation.wrapping_add(1);
    runtime.state = "stopped".to_string();
    runtime.last_error = None;
    runtime.connected_at = None;
}

pub(crate) async fn autostart(state: &Arc<AppState>) {
    let config = state.integrations.lock().await.settings().dingtalk.clone();
    if !config.enabled || config.effective_mode(PlatformKind::Dingtalk) != ConnectionMode::Websocket
    {
        return;
    }
    if let Err(error) = start(state).await {
        app_log::warn("Dingtalk", format!("自动启动钉钉 Stream 失败：{error}"));
    }
}

pub(crate) async fn reconnect_if_needed(state: &Arc<AppState>) -> bool {
    let config = state.integrations.lock().await.settings().dingtalk.clone();
    if !config.enabled || config.effective_mode(PlatformKind::Dingtalk) != ConnectionMode::Websocket
    {
        return false;
    }
    let current = status(state).await;
    if !platform_recovery::should_reconnect(current.running, &current.state) {
        return false;
    }
    app_log::info("Dingtalk", "应用恢复或窗口重新激活，正在重连钉钉 Stream");
    if let Err(error) = start(state).await {
        app_log::warn("Dingtalk", format!("恢复钉钉 Stream 失败：{error}"));
    }
    true
}

pub(crate) async fn restart_after_resume(state: &Arc<AppState>) -> bool {
    let config = state.integrations.lock().await.settings().dingtalk.clone();
    if !config.enabled || config.effective_mode(PlatformKind::Dingtalk) != ConnectionMode::Websocket
    {
        return false;
    }
    app_log::info("Dingtalk", "电脑从睡眠恢复，重建钉钉 Stream 以清理失效会话");
    if let Err(error) = start(state).await {
        app_log::warn(
            "Dingtalk",
            format!("睡眠恢复后重连钉钉 Stream 失败：{error}"),
        );
    }
    true
}

pub(crate) async fn status(state: &Arc<AppState>) -> DingtalkStatus {
    let runtime = state.dingtalk_ws.lock().await;
    status_from(&runtime)
}

fn status_from(runtime: &DingtalkRuntime) -> DingtalkStatus {
    DingtalkStatus {
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
        ..DingtalkStatus::default()
    }
}

pub(crate) async fn test_connection(client_id: &str, client_secret: &str) -> Result<()> {
    let credentials = credentials_from_parts(client_id, client_secret)?;
    let response = reqwest::Client::new()
        .post("https://api.dingtalk.com/v1.0/oauth2/accessToken")
        .json(&serde_json::json!({
            "appKey": credentials.client_id,
            "appSecret": credentials.client_secret,
        }))
        .send()
        .await
        .context("连接钉钉开放平台失败")?;
    let status = response.status();
    let response: Value = response.json().await.context("读取钉钉凭据响应失败")?;
    if !status.is_success() {
        return Err(anyhow!(
            "钉钉凭据校验失败：{}",
            response
                .get("message")
                .or_else(|| response.get("errmsg"))
                .and_then(Value::as_str)
                .unwrap_or("请求被钉钉拒绝")
        ));
    }
    if response
        .get("accessToken")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(anyhow!(
            "钉钉凭据校验失败：{}",
            response
                .get("message")
                .or_else(|| response.get("errmsg"))
                .and_then(Value::as_str)
                .unwrap_or("没有返回 accessToken")
        ));
    }
    Ok(())
}

fn parse_inbound(value: &Value) -> Option<InboundMessage> {
    let event_id = value.get("msgId")?.as_str()?.to_string();
    let external_user_id = value
        .get("senderStaffId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .or_else(|| value.get("senderId").and_then(Value::as_str))?
        .to_string();
    let sender_id = value
        .get("senderId")
        .and_then(Value::as_str)
        .unwrap_or(&external_user_id)
        .to_string();
    let chat_id = value
        .get("conversationId")
        .and_then(Value::as_str)
        .unwrap_or(&external_user_id)
        .to_string();
    let is_voice = value.get("msgtype").and_then(Value::as_str) == Some("audio");
    let text = if is_voice {
        value
            .pointer("/content/recognition")
            .and_then(Value::as_str)
            .unwrap_or_default()
    } else {
        value
            .pointer("/text/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let text = platform_bridge::clean_platform_text(text);
    Some(InboundMessage {
        event_id,
        external_user_id,
        chat_id,
        sender_id,
        text,
        is_voice,
    })
}

fn credentials_from_config(config: &PlatformConfig) -> Result<DingtalkCredentials> {
    credentials_from_parts(&config.app_id, &config.app_secret)
}

fn credentials_from_parts(client_id: &str, client_secret: &str) -> Result<DingtalkCredentials> {
    if client_id.trim().is_empty() || client_secret.trim().is_empty() {
        return Err(anyhow!("钉钉 Client ID 或 Client Secret 未配置"));
    }
    Ok(DingtalkCredentials {
        client_id: client_id.trim().to_string(),
        client_secret: client_secret.trim().to_string(),
    })
}

async fn set_status(
    state: &Arc<AppState>,
    generation: u64,
    status: &str,
    error: Option<String>,
    connected: bool,
) {
    let mut runtime = state.dingtalk_ws.lock().await;
    if runtime.generation != generation {
        return;
    }
    runtime.state = status.to_string();
    runtime.last_error = error;
    if connected {
        runtime.connected_at = Some(Instant::now());
    } else if status != "reconnecting" {
        runtime.connected_at = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_and_voice_callbacks() {
        let text = serde_json::json!({
            "msgId": "m1",
            "senderId": "u1",
            "senderStaffId": "staff1",
            "conversationId": "c1",
            "msgtype": "text",
            "text": {"content": " 打开客厅灯 "}
        });
        let parsed = parse_inbound(&text).expect("text");
        assert_eq!(parsed.text, "打开客厅灯");
        assert!(!parsed.is_voice);
        assert_eq!(parsed.external_user_id, "staff1");

        let voice = serde_json::json!({
            "msgId": "m2",
            "senderId": "u1",
            "conversationId": "c1",
            "msgtype": "audio",
            "content": {"recognition": "关闭空调"}
        });
        let parsed = parse_inbound(&voice).expect("voice");
        assert_eq!(parsed.text, "关闭空调");
        assert!(parsed.is_voice);
    }

    #[test]
    fn validates_required_credentials() {
        assert!(credentials_from_parts("", "secret").is_err());
        assert!(credentials_from_parts("client", "").is_err());
        assert!(credentials_from_parts("client", "secret").is_ok());
    }
}
