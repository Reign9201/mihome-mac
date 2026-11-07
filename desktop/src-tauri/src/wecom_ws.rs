use crate::platform_bridge;
use crate::{app_log, platform_recovery, AppState};
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use mihome_core::{ConnectionMode, PlatformConfig, PlatformKind};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_ENDPOINT: &str = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const HEARTBEAT_TIMEOUT_COUNT: u64 = 3;
const REPLY_ACK_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RECONNECTS: u32 = 10;
const MAX_AUTH_FAILURES: u32 = 5;

#[derive(Default)]
pub(crate) struct WecomRuntime {
    task: Option<JoinHandle<()>>,
    generation: u64,
    state: String,
    last_error: Option<String>,
    connected_at: Option<Instant>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct WecomStatus {
    pub running: bool,
    pub state: String,
    pub endpoint: &'static str,
    pub connected_seconds: Option<u64>,
    pub last_error: Option<String>,
}

impl Default for WecomStatus {
    fn default() -> Self {
        Self {
            running: false,
            state: "stopped".to_string(),
            endpoint: DEFAULT_ENDPOINT,
            connected_seconds: None,
            last_error: None,
        }
    }
}

#[derive(Clone)]
struct WecomCredentials {
    bot_id: String,
    secret: String,
}

enum Outbound {
    Text(String),
    Pong(Vec<u8>),
}

#[derive(Clone)]
struct ReplySender {
    outbound: mpsc::Sender<Outbound>,
    pending: Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<Value>>>>,
}

enum ConnectionEnd {
    Closed { reason: String, stable: bool },
    AuthFailed(String),
    Replaced,
}

pub(crate) async fn start(state: &Arc<AppState>) -> Result<WecomStatus> {
    let config = state.integrations.lock().await.settings().wecom.clone();
    if !config.enabled {
        stop(state).await;
        return Ok(status(state).await);
    }
    if config.effective_mode(PlatformKind::Wecom) != ConnectionMode::Websocket {
        stop(state).await;
        return Err(anyhow!("企业微信当前配置为 Webhook 模式，请切换到长连接"));
    }
    let credentials = credentials_from_config(&config)?;
    let mut runtime = state.wecom_ws.lock().await;
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
            "Wecom",
            format!(
                "企业微信长连接启动：bot={}",
                app_log::mask_id(&credentials.bot_id)
            ),
        );
        run_connection_loop(state_for_task, generation, credentials).await;
    }));
    Ok(status_from(&runtime))
}

pub(crate) async fn stop(state: &Arc<AppState>) {
    let mut runtime = state.wecom_ws.lock().await;
    if let Some(task) = runtime.task.take() {
        task.abort();
    }
    runtime.generation = runtime.generation.wrapping_add(1);
    runtime.state = "stopped".to_string();
    runtime.last_error = None;
    runtime.connected_at = None;
}

pub(crate) async fn autostart(state: &Arc<AppState>) {
    let config = state.integrations.lock().await.settings().wecom.clone();
    if !config.enabled || config.effective_mode(PlatformKind::Wecom) != ConnectionMode::Websocket {
        return;
    }
    if let Err(error) = start(state).await {
        app_log::warn("Wecom", format!("自动启动企业微信长连接失败：{error}"));
    }
}

pub(crate) async fn reconnect_if_needed(state: &Arc<AppState>) -> bool {
    let config = state.integrations.lock().await.settings().wecom.clone();
    if !config.enabled || config.effective_mode(PlatformKind::Wecom) != ConnectionMode::Websocket {
        return false;
    }
    let current = status(state).await;
    if current.state == "replaced"
        || !platform_recovery::should_reconnect(current.running, &current.state)
    {
        return false;
    }
    app_log::info("Wecom", "应用恢复或窗口重新激活，正在重连企业微信长连接");
    if let Err(error) = start(state).await {
        app_log::warn("Wecom", format!("恢复企业微信长连接失败：{error}"));
    }
    true
}

pub(crate) async fn restart_after_resume(state: &Arc<AppState>) -> bool {
    let config = state.integrations.lock().await.settings().wecom.clone();
    if !config.enabled || config.effective_mode(PlatformKind::Wecom) != ConnectionMode::Websocket {
        return false;
    }
    if !platform_recovery::should_restart_after_resume(&status(state).await.state) {
        app_log::warn(
            "Wecom",
            "企业微信连接已被同一机器人的新连接替换，跳过睡眠恢复自动重建",
        );
        return false;
    }
    app_log::info("Wecom", "电脑从睡眠恢复，重建企业微信长连接以清理失效会话");
    if let Err(error) = start(state).await {
        app_log::warn("Wecom", format!("睡眠恢复后重连企业微信失败：{error}"));
    }
    true
}

pub(crate) async fn status(state: &Arc<AppState>) -> WecomStatus {
    let runtime = state.wecom_ws.lock().await;
    status_from(&runtime)
}

fn status_from(runtime: &WecomRuntime) -> WecomStatus {
    WecomStatus {
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
        ..WecomStatus::default()
    }
}

async fn run_connection_loop(state: Arc<AppState>, generation: u64, credentials: WecomCredentials) {
    let mut reconnect_attempt = 0_u32;
    let mut auth_failures = 0_u32;
    loop {
        set_status(&state, generation, "connecting", None, false).await;
        match connect_once(&state, generation, &credentials).await {
            Ok(ConnectionEnd::Replaced) => {
                set_status(
                    &state,
                    generation,
                    "replaced",
                    Some("检测到新的机器人连接，当前连接已停止重连".to_string()),
                    false,
                )
                .await;
                app_log::warn("Wecom", "企业微信连接被同一机器人的新连接替换");
                return;
            }
            Ok(ConnectionEnd::AuthFailed(error)) => {
                auth_failures = auth_failures.saturating_add(1);
                app_log::warn(
                    "Wecom",
                    format!("企业微信认证失败（{auth_failures}/{MAX_AUTH_FAILURES}）：{error}"),
                );
                if auth_failures >= MAX_AUTH_FAILURES {
                    set_status(&state, generation, "error", Some(error), false).await;
                    return;
                }
            }
            Ok(ConnectionEnd::Closed { reason, stable }) => {
                if stable {
                    reconnect_attempt = 0;
                    auth_failures = 0;
                }
                reconnect_attempt = reconnect_attempt.saturating_add(1);
                app_log::warn("Wecom", format!("企业微信长连接断开：{reason}"));
                if reconnect_attempt > MAX_RECONNECTS {
                    set_status(
                        &state,
                        generation,
                        "error",
                        Some(format!("连接断开且重试耗尽：{reason}")),
                        false,
                    )
                    .await;
                    return;
                }
            }
            Err(error) => {
                reconnect_attempt = reconnect_attempt.saturating_add(1);
                app_log::warn("Wecom", format!("企业微信长连接失败：{error:#}"));
                if reconnect_attempt > MAX_RECONNECTS {
                    set_status(
                        &state,
                        generation,
                        "error",
                        Some(format!("连接失败且重试耗尽：{error}")),
                        false,
                    )
                    .await;
                    return;
                }
            }
        }

        let attempt = reconnect_attempt.max(auth_failures);
        let delay = Duration::from_secs(
            1_u64
                .checked_shl(attempt.saturating_sub(1).min(4))
                .unwrap_or(16)
                .min(30),
        );
        set_status(
            &state,
            generation,
            "reconnecting",
            Some(format!("{} 秒后重连", delay.as_secs())),
            false,
        )
        .await;
        tokio::time::sleep(delay).await;
    }
}

async fn connect_once(
    state: &Arc<AppState>,
    generation: u64,
    credentials: &WecomCredentials,
) -> Result<ConnectionEnd> {
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(DEFAULT_ENDPOINT),
    )
    .await
    .context("连接企业微信长连接超时")?
    .context("连接企业微信长连接失败")?;
    let (mut sink, mut stream) = socket.split();
    let (outbound, mut outbound_rx) = mpsc::channel::<Outbound>(128);
    let pending = Arc::new(tokio::sync::Mutex::new(HashMap::<
        String,
        oneshot::Sender<Value>,
    >::new()));
    let writer = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            let result = match message {
                Outbound::Text(text) => sink.send(Message::Text(text.into())).await,
                Outbound::Pong(payload) => sink.send(Message::Pong(payload.into())).await,
            };
            if let Err(error) = result {
                app_log::warn("Wecom", format!("发送企业微信长连接消息失败：{error}"));
                break;
            }
        }
    });

    let auth_request_id = request_id("aibot_subscribe");
    let auth_frame = json!({
        "cmd": "aibot_subscribe",
        "headers": {"req_id": auth_request_id},
        "body": {
            "bot_id": credentials.bot_id,
            "secret": credentials.secret,
        }
    });
    if outbound
        .send(Outbound::Text(auth_frame.to_string()))
        .await
        .is_err()
    {
        writer.abort();
        return Err(anyhow!("企业微信长连接写入通道已关闭"));
    }

    let sender = ReplySender {
        outbound: outbound.clone(),
        pending: pending.clone(),
    };
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
        HEARTBEAT_INTERVAL,
    );
    let auth_timeout = tokio::time::sleep(AUTH_TIMEOUT);
    tokio::pin!(auth_timeout);
    let mut authenticated_at = None;
    let mut missed_pongs = 0_u64;
    let mut last_error = None;

    let end = loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(incoming) = incoming else {
                    break ConnectionEnd::Closed {
                        reason: "WebSocket 已关闭".to_string(),
                        stable: authenticated_at
                            .is_some_and(|connected_at: Instant| connected_at.elapsed() >= Duration::from_secs(60)),
                    };
                };
                let message = match incoming {
                    Ok(message) => message,
                    Err(error) => {
                        last_error = Some(error.to_string());
                        break ConnectionEnd::Closed {
                            reason: format!("读取 WebSocket 失败：{error}"),
                            stable: authenticated_at
                                .is_some_and(|connected_at: Instant| connected_at.elapsed() >= Duration::from_secs(60)),
                        };
                    }
                };
                match message {
                    Message::Text(text) => {
                        let text = text
                            .chars()
                            .filter(|ch| !ch.is_control() || *ch == '\n' || *ch == '\r' || *ch == '\t')
                            .collect::<String>();
                        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                            app_log::warn("Wecom", "收到无法解析的企业微信长连接消息");
                            continue;
                        };
                        let req_id = frame
                            .pointer("/headers/req_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let command = frame.get("cmd").and_then(Value::as_str).unwrap_or_default();
                        if command == "aibot_msg_callback" {
                            let reply_sender = sender.clone();
                            let state_for_message = state.clone();
                            tokio::spawn(async move {
                                if let Err(error) = handle_callback(
                                    state_for_message,
                                    reply_sender,
                                    req_id,
                                    frame.get("body").cloned().unwrap_or(Value::Null),
                                )
                                .await
                                {
                                    app_log::warn("Wecom", format!("处理企业微信消息失败：{error:#}"));
                                }
                            });
                            continue;
                        }
                        if command == "aibot_event_callback" {
                            let event_type = frame
                                .pointer("/body/event/eventtype")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            if event_type == "disconnected_event" {
                                break ConnectionEnd::Replaced;
                            }
                            if event_type == "enter_chat" {
                                let reply_sender = sender.clone();
                                tokio::spawn(async move {
                                    let welcome = "欢迎使用 MiHome Mac 智能管家。请先在桌面端接入页生成配对码，然后发送“配对 123456”。";
                                    if let Err(error) = reply_sender
                                        .send_welcome(&req_id, welcome)
                                        .await
                                    {
                                        app_log::warn("Wecom", format!("发送欢迎语失败：{error:#}"));
                                    }
                                });
                            }
                            continue;
                        }
                        if command.is_empty() {
                            if req_id.starts_with("aibot_subscribe") {
                                let errcode = frame.get("errcode").and_then(Value::as_i64).unwrap_or(-1);
                                if errcode != 0 {
                                    let message = frame
                                        .get("errmsg")
                                        .and_then(Value::as_str)
                                        .unwrap_or("未知认证错误")
                                        .to_string();
                                    break ConnectionEnd::AuthFailed(message);
                                }
                                authenticated_at = Some(Instant::now());
                                missed_pongs = 0;
                                set_status(state, generation, "connected", None, true).await;
                                app_log::info("Wecom", "企业微信长连接认证成功");
                                continue;
                            }
                            if req_id.starts_with("ping-") {
                                let errcode = frame.get("errcode").and_then(Value::as_i64).unwrap_or(0);
                                if errcode == 0 {
                                    missed_pongs = 0;
                                }
                                continue;
                            }
                            if let Some(waiter) = pending.lock().await.remove(&req_id) {
                                let _ = waiter.send(frame);
                            }
                            continue;
                        }
                    }
                    Message::Binary(_) | Message::Frame(_) => {}
                    Message::Ping(payload) => {
                        let _ = outbound.send(Outbound::Pong(payload.to_vec())).await;
                    }
                    Message::Pong(_) => {}
                    Message::Close(reason) => {
                        break ConnectionEnd::Closed {
                            reason: reason
                                .map(|reason| reason.reason.to_string())
                                .filter(|reason| !reason.is_empty())
                                .unwrap_or_else(|| "服务端关闭连接".to_string()),
                            stable: authenticated_at
                                .is_some_and(|connected_at: Instant| connected_at.elapsed() >= Duration::from_secs(60)),
                        };
                    }
                }
            }
            _ = heartbeat.tick() => {
                if authenticated_at.is_none() {
                    continue;
                }
                if missed_pongs >= HEARTBEAT_TIMEOUT_COUNT {
                    break ConnectionEnd::Closed {
                        reason: "心跳连续超时".to_string(),
                        stable: authenticated_at
                            .is_some_and(|connected_at: Instant| connected_at.elapsed() >= Duration::from_secs(60)),
                    };
                }
                missed_pongs = missed_pongs.saturating_add(1);
                let ping = json!({
                    "cmd": "ping",
                    "headers": {"req_id": request_id("ping")}
                });
                if outbound.send(Outbound::Text(ping.to_string())).await.is_err() {
                    break ConnectionEnd::Closed {
                        reason: "心跳写入通道已关闭".to_string(),
                        stable: authenticated_at
                            .is_some_and(|connected_at: Instant| connected_at.elapsed() >= Duration::from_secs(60)),
                    };
                }
            }
            _ = &mut auth_timeout, if authenticated_at.is_none() => {
                break ConnectionEnd::AuthFailed("认证响应超时".to_string());
            }
        }
    };

    writer.abort();
    pending.lock().await.clear();
    drop(outbound);
    if let ConnectionEnd::Closed { reason, .. } = &end {
        let message = last_error.unwrap_or_else(|| reason.clone());
        set_status(state, generation, "reconnecting", Some(message), false).await;
    }
    Ok(end)
}

async fn handle_callback(
    state: Arc<AppState>,
    sender: ReplySender,
    request_id: String,
    body: Value,
) -> Result<()> {
    #[derive(Deserialize)]
    struct From {
        userid: String,
    }
    #[derive(Deserialize)]
    struct Text {
        content: String,
    }
    #[derive(Deserialize)]
    struct Voice {
        #[serde(default)]
        recognition: String,
        #[serde(default)]
        content: String,
    }
    #[derive(Deserialize)]
    struct Callback {
        msgid: String,
        #[serde(default)]
        chatid: Option<String>,
        #[serde(default)]
        chattype: Option<String>,
        from: From,
        msgtype: String,
        #[serde(default)]
        text: Option<Text>,
        #[serde(default)]
        voice: Option<Voice>,
    }

    let Ok(callback) = serde_json::from_value::<Callback>(body) else {
        return Ok(());
    };
    let is_voice = matches!(callback.msgtype.as_str(), "voice" | "audio");
    let text = if callback.msgtype == "text" {
        callback.text.as_ref().map(|text| text.content.clone())
    } else if is_voice {
        callback.voice.as_ref().and_then(|voice| {
            let recognized = voice.recognition.trim();
            if !recognized.is_empty() {
                Some(recognized.to_string())
            } else if !voice.content.trim().is_empty() {
                Some(voice.content.clone())
            } else {
                None
            }
        })
    } else {
        None
    };
    let Some(text) = text else {
        sender
            .send_stream(
                &request_id,
                &stream_id(&callback.msgid),
                if is_voice {
                    "企业微信没有返回语音识别结果，请重说一次或改发文字。"
                } else {
                    "目前只支持文字和语音指令，请发送“打开客厅灯”。"
                },
                true,
            )
            .await?;
        return Ok(());
    };
    let chat_id = match callback.chattype.as_deref() {
        Some("group") => callback
            .chatid
            .clone()
            .ok_or_else(|| anyhow!("企业微信群消息缺少 chatid"))?,
        _ => callback.from.userid.clone(),
    };
    if !platform_bridge::claim_event(&state, format!("wecom:{}", callback.msgid)).await {
        return Ok(());
    }

    let stream_id = stream_id(&callback.msgid);
    sender
        .send_stream(&request_id, &stream_id, "正在处理…", false)
        .await?;
    let reply = platform_bridge::handle_platform_message_with_voice(
        &state,
        PlatformKind::Wecom,
        &callback.from.userid,
        &chat_id,
        Some(callback.msgid),
        &text,
        is_voice,
    )
    .await;
    sender
        .send_stream(
            &request_id,
            &stream_id,
            &reply.chars().take(6000).collect::<String>(),
            true,
        )
        .await?;
    Ok(())
}

impl ReplySender {
    async fn send_stream(
        &self,
        request_id: &str,
        stream_id: &str,
        content: &str,
        finish: bool,
    ) -> Result<()> {
        let body = json!({
            "msgtype": "stream",
            "stream": {
                "id": stream_id,
                "finish": finish,
                "content": content,
            }
        });
        self.send_command("aibot_respond_msg", request_id, body)
            .await
    }

    async fn send_welcome(&self, request_id: &str, content: &str) -> Result<()> {
        self.send_command(
            "aibot_respond_welcome_msg",
            request_id,
            json!({
                "msgtype": "text",
                "text": {"content": content}
            }),
        )
        .await
    }

    async fn send_command(&self, command: &str, request_id: &str, body: Value) -> Result<()> {
        let (ack_tx, ack_rx) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(request_id.to_string(), ack_tx);
        let frame = json!({
            "cmd": command,
            "headers": {"req_id": request_id},
            "body": body,
        });
        if self
            .outbound
            .send(Outbound::Text(frame.to_string()))
            .await
            .is_err()
        {
            self.pending.lock().await.remove(request_id);
            return Err(anyhow!("企业微信回复通道已关闭"));
        }
        let ack = tokio::time::timeout(REPLY_ACK_TIMEOUT, ack_rx)
            .await
            .map_err(|_| anyhow!("等待企业微信回复回执超时"))?
            .map_err(|_| anyhow!("企业微信回复回执通道已关闭"))?;
        let errcode = ack.get("errcode").and_then(Value::as_i64).unwrap_or(0);
        if errcode != 0 {
            return Err(anyhow!(
                "企业微信回复失败：{}",
                ack.get("errmsg")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误")
            ));
        }
        Ok(())
    }
}

pub(crate) async fn test_connection(bot_id: &str, secret: &str) -> Result<()> {
    let credentials = credentials_from_parts(bot_id, secret)?;
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(DEFAULT_ENDPOINT),
    )
    .await
    .context("连接企业微信长连接超时")?
    .context("连接企业微信长连接失败")?;
    let request_id = request_id("aibot_subscribe");
    socket
        .send(Message::Text(
            json!({
                "cmd": "aibot_subscribe",
                "headers": {"req_id": request_id},
                "body": {
                    "bot_id": credentials.bot_id,
                    "secret": credentials.secret,
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .context("发送企业微信认证帧失败")?;
    let deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(incoming) = incoming else {
                    return Err(anyhow!("企业微信认证期间连接已关闭"));
                };
                let message = incoming.context("读取企业微信认证响应失败")?;
                let Message::Text(text) = message else {
                    continue;
                };
                let frame: Value = serde_json::from_str(&text)
                    .context("企业微信认证响应格式错误")?;
                let received_id = frame
                    .pointer("/headers/req_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !received_id.starts_with("aibot_subscribe") {
                    continue;
                }
                let errcode = frame.get("errcode").and_then(Value::as_i64).unwrap_or(-1);
                if errcode != 0 {
                    return Err(anyhow!(
                        "企业微信认证失败：{}",
                        frame.get("errmsg").and_then(Value::as_str).unwrap_or("未知错误")
                    ));
                }
                return Ok(());
            }
            _ = &mut deadline => {
                return Err(anyhow!("等待企业微信认证响应超时"));
            }
        }
    }
}

fn credentials_from_config(config: &PlatformConfig) -> Result<WecomCredentials> {
    credentials_from_parts(&config.app_id, &config.app_secret)
}

fn credentials_from_parts(bot_id: &str, secret: &str) -> Result<WecomCredentials> {
    if bot_id.trim().is_empty() || secret.trim().is_empty() {
        return Err(anyhow!("企业微信 Bot ID 或 Secret 未配置"));
    }
    Ok(WecomCredentials {
        bot_id: bot_id.trim().to_string(),
        secret: secret.trim().to_string(),
    })
}

async fn set_status(
    state: &Arc<AppState>,
    generation: u64,
    status: &str,
    error: Option<String>,
    connected: bool,
) {
    let mut runtime = state.wecom_ws.lock().await;
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

fn request_id(prefix: &str) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    format!(
        "{prefix}-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn stream_id(message_id: &str) -> String {
    let safe_id = message_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(80)
        .collect::<String>();
    if safe_id.is_empty() {
        request_id("stream")
    } else {
        format!("stream-{safe_id}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_ids_are_stable_and_safe() {
        assert_eq!(stream_id("abc/123"), "stream-abc123");
        assert_eq!(stream_id("abc-123"), "stream-abc-123");
        assert!(stream_id("").starts_with("stream-"));
    }

    #[test]
    fn status_defaults_to_stopped() {
        let status = WecomStatus::default();
        assert_eq!(status.state, "stopped");
        assert_eq!(status.endpoint, DEFAULT_ENDPOINT);
    }
}
