use crate::{app_log, AppState};
use chrono::Local;
use mihome_core::assistant::{
    AdjustmentDirection, AdjustmentUnit, AssistantIntent, CandidateView, CatalogCapability,
    DeviceCatalog, IntentAction, IntentTarget, OpenAiIntentParser, ResolveOutcome, ResolvedCommand,
    ResolvedOperation,
};
use mihome_core::{LlmConfig, MiCloud};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

const CATALOG_TTL: Duration = Duration::from_secs(20);
const CONFIRMATION_TTL: Duration = Duration::from_secs(120);
const EVENT_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const EVENT_CACHE_LIMIT: usize = 256;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AssistantRequest {
    pub text: String,
    #[serde(default)]
    pub home_id: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AssistantResponse {
    pub status: String,
    pub reply: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<CandidateView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
}

impl AssistantResponse {
    fn simple(status: &str, reply: impl Into<String>) -> Self {
        Self {
            status: status.to_string(),
            reply: reply.into(),
            summary: None,
            confirmation_id: None,
            candidates: Vec::new(),
            verified: None,
        }
    }
}

struct PendingConfirmation {
    scope: String,
    command: ResolvedCommand,
    expires_at: Instant,
}

#[derive(Default)]
pub(crate) struct AssistantRuntime {
    confirmations: HashMap<String, PendingConfirmation>,
    seen_events: HashMap<String, (Instant, AssistantResponse)>,
    catalog: Option<(Instant, Option<String>, DeviceCatalog)>,
}

impl AssistantRuntime {
    pub(crate) fn clear_sensitive_state(&mut self) {
        self.confirmations.clear();
        self.seen_events.clear();
        self.catalog = None;
    }
}

pub(crate) async fn handle_request(
    state: &Arc<AppState>,
    request: AssistantRequest,
) -> AssistantResponse {
    let text = request.text.trim().chars().take(500).collect::<String>();
    if text.is_empty() {
        return AssistantResponse::simple("help", help_text());
    }
    let event_key = request.event_id.as_ref().map(|event_id| {
        format!(
            "{}:{}",
            request.source.as_deref().unwrap_or("desktop"),
            event_id
        )
    });
    if let Some(event_key) = &event_key {
        if let Some(response) = cached_response(state, event_key).await {
            return response;
        }
    }

    let scope = format!(
        "{}:{}",
        request.source.as_deref().unwrap_or("desktop"),
        request.chat_id.as_deref().unwrap_or("local")
    );
    let response = if is_cancel(&text) {
        cancel_pending(state, &scope).await
    } else if is_confirm(&text) {
        confirm_pending(state, &scope, &text).await
    } else {
        interpret_and_execute(state, request.home_id.as_deref(), &scope, &text).await
    };

    if let Some(event_key) = event_key {
        cache_response(state, event_key, response.clone()).await;
    }
    append_audit(
        request.source.as_deref().unwrap_or("desktop"),
        request.event_id.as_deref(),
        &text,
        &response,
    );
    response
}

async fn cached_response(state: &Arc<AppState>, key: &str) -> Option<AssistantResponse> {
    let mut runtime = state.assistant_runtime.lock().await;
    let now = Instant::now();
    runtime
        .seen_events
        .retain(|_, (seen_at, _)| now.duration_since(*seen_at) < EVENT_CACHE_TTL);
    runtime
        .seen_events
        .get(key)
        .map(|(_, response)| response.clone())
}

async fn cache_response(state: &Arc<AppState>, key: String, response: AssistantResponse) {
    let mut runtime = state.assistant_runtime.lock().await;
    if runtime.seen_events.len() >= EVENT_CACHE_LIMIT {
        if let Some(oldest) = runtime
            .seen_events
            .iter()
            .min_by_key(|(_, (seen_at, _))| *seen_at)
            .map(|(key, _)| key.clone())
        {
            runtime.seen_events.remove(&oldest);
        }
    }
    runtime.seen_events.insert(key, (Instant::now(), response));
}

async fn interpret_and_execute(
    state: &Arc<AppState>,
    home_id: Option<&str>,
    scope: &str,
    text: &str,
) -> AssistantResponse {
    if let Some(reason) = unsupported_request_reason(text) {
        return AssistantResponse::simple("not_found", reason);
    }
    let catalog = match catalog_for(state, home_id).await {
        Ok(catalog) => catalog,
        Err(error) => {
            app_log::warn("Assistant", format!("构建设备目录失败：{error}"));
            return AssistantResponse::simple("error", format!("读取设备目录失败：{error}"));
        }
    };
    if let Some(intents) = parse_local_command_chain(&catalog, text) {
        return execute_command_chain(state, &catalog, intents).await;
    }
    let mut intent = catalog.parse_local(text);
    let mut llm_error = None;
    if intent
        .as_ref()
        .is_none_or(|intent| intent.action == IntentAction::Help && intent.confidence < 0.55)
    {
        let llm = state.integrations.lock().await.settings().llm.clone();
        if llm.enabled {
            intent = match parse_with_llm(&catalog, text, &llm).await {
                Ok(intent) => Some(intent),
                Err(error) => {
                    app_log::warn(
                        "Assistant",
                        format!("模型意图解析失败，已回退本地规则：{error}"),
                    );
                    llm_error = Some(error.to_string());
                    intent
                }
            };
        }
    }
    let Some(intent) = intent else {
        return AssistantResponse::simple("help", help_text());
    };
    if intent.action == IntentAction::Help {
        let reply = llm_error
            .map(|error| format!("{}（模型解析失败：{error}）", help_text()))
            .unwrap_or_else(help_text);
        return AssistantResponse::simple("help", reply);
    }

    let response = match catalog.resolve(intent) {
        ResolveOutcome::Ready {
            summary,
            requires_confirmation,
            confirmation_reason,
            command,
        } => {
            if requires_confirmation {
                create_confirmation(state, scope, *command, summary, confirmation_reason).await
            } else {
                execute(state, *command).await
            }
        }
        ResolveOutcome::Ambiguous {
            message,
            candidates,
        } => AssistantResponse {
            status: "ambiguous".to_string(),
            reply: message,
            summary: None,
            confirmation_id: None,
            candidates,
            verified: None,
        },
        ResolveOutcome::NotFound { message } => AssistantResponse::simple("not_found", message),
    };
    response
}

fn unsupported_request_reason(text: &str) -> Option<String> {
    let normalized = text
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let has_negated_control = [
        "不要开",
        "不要关",
        "别开",
        "别关",
        "不用开",
        "不用关",
        "不必开",
        "不必关",
        "无需开",
        "无需关",
        "不想开",
        "不想关",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase));
    if has_negated_control {
        return Some(
            "这条指令包含否定语义，暂时无法可靠判断要在现有状态上做什么。请直接说要执行的动作，例如“关闭客厅灯”。"
                .to_string(),
        );
    }
    if ["只留", "只保留", "其余都", "其他的都"]
        .iter()
        .any(|phrase| normalized.contains(phrase))
    {
        return Some(
            "暂不支持“只保留/其余都”这类排除式批量指令。请改用“关闭所有灯，除了客厅灯”这样的说法。"
                .to_string(),
        );
    }
    let delayed = [
        "分钟后",
        "小时后",
        "半小时后",
        "秒后",
        "稍后",
        "过一会",
        "待会",
        "等一下再",
        "之后",
        "以后再",
        "明早",
        "明天",
        "后天",
        "下周",
        "定时",
        "预约",
    ]
    .iter()
    .any(|phrase| normalized.contains(phrase));
    if delayed
        && [
            "打开", "开启", "启动", "关闭", "关掉", "调到", "调至", "设成", "设为", "清扫", "回充",
            "开机", "关机", "关上", "点亮", "开灯", "关灯",
        ]
        .iter()
        .any(|phrase| normalized.contains(phrase))
    {
        return Some(
            "暂不支持通过聊天消息执行定时或延时控制。请先在 MiHome Mac 的“自动化”里创建定时任务，避免把未来指令立即执行。"
                .to_string(),
        );
    }
    None
}

fn parse_local_command_chain(catalog: &DeviceCatalog, text: &str) -> Option<Vec<AssistantIntent>> {
    let clauses = split_command_clauses(text);
    if clauses.len() < 2 {
        return None;
    }
    let mut intents = Vec::new();
    let mut previous_target = IntentTarget::default();
    for clause in clauses {
        let mut intent = catalog.parse_local(&clause)?;
        if intent.action == IntentAction::Help {
            let hint = target_hint(&previous_target)?;
            intent = catalog.parse_local(&format!("{hint}{clause}"))?;
        }
        if intent.action == IntentAction::Help {
            return None;
        }
        inherit_target(&mut intent.target, &previous_target);
        previous_target = intent.target.clone();
        intents.push(intent);
    }
    Some(intents)
}

fn split_command_clauses(text: &str) -> Vec<String> {
    let mut clauses = Vec::new();
    for piece in text.split(['，', ',', '、', '；', ';', '\n']) {
        let piece = piece
            .replace("并且", "\u{0}")
            .replace("然后再", "\u{0}")
            .replace("然后", "\u{0}")
            .replace("接着", "\u{0}")
            .replace('并', "\u{0}");
        for part in piece.split('\u{0}') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            clauses.extend(split_implicit_power_setting(part));
        }
    }
    clauses
}

fn split_implicit_power_setting(text: &str) -> Vec<String> {
    if ["除了", "除去", "不包括"]
        .iter()
        .any(|word| text.contains(word))
    {
        return vec![text.to_string()];
    }
    let power_words = ["打开", "开启", "开机", "启动", "点亮", "亮灯"];
    let Some((power_position, power_word)) = power_words
        .iter()
        .filter_map(|word| text.find(word).map(|position| (position, *word)))
        .min_by_key(|(position, _)| *position)
    else {
        return vec![text.to_string()];
    };
    let power_end = power_position + power_word.len();
    let secondary = [
        "调到",
        "调至",
        "调成",
        "设成",
        "设为",
        "设置",
        "亮度",
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
        "湿度",
        "风速",
        "风量",
        "风扇档位",
        "模式",
        "制冷",
        "制热",
        "除湿",
        "抽湿",
        "送风",
        "通风",
        "自然风",
        "自动",
        "自动模式",
        "睡眠",
        "睡眠模式",
        "节能",
        "舒适",
        "强劲",
        "静音模式",
        "安静模式",
        "防直吹",
        "无风感",
        "上下扫风",
        "上下摆风",
        "左右扫风",
        "左右摆风",
        "摇头",
        "停止摇头",
        "暖光",
        "冷光",
        "自然光",
        "开始清扫",
        "暂停清扫",
        "播放",
        "暂停播放",
        "下一首",
        "上一首",
    ];
    let marker = secondary
        .iter()
        .filter_map(|word| {
            text[power_end..]
                .find(word)
                .map(|offset| power_end + offset)
        })
        .filter(|position| *position > power_end)
        .min();
    let degree = degree_value_start(text, power_end);
    let split_at = match (marker, degree) {
        (Some(marker), Some(degree)) => marker.min(degree),
        (Some(marker), None) => marker,
        (None, Some(degree)) => degree,
        (None, None) => return vec![text.to_string()],
    };
    let first = text[..split_at].trim();
    let second = text[split_at..].trim();
    if first.is_empty() || second.is_empty() {
        vec![text.to_string()]
    } else {
        vec![first.to_string(), second.to_string()]
    }
}

fn degree_value_start(text: &str, start: usize) -> Option<usize> {
    let suffix = &text[start..];
    for marker in ["摄氏度", "℃", "°c", "°C", "度"] {
        let Some(offset) = suffix.find(marker) else {
            continue;
        };
        let marker_position = start + offset;
        let bytes = text.as_bytes();
        let mut value_start = marker_position;
        while value_start > start && bytes[value_start - 1].is_ascii_digit() {
            value_start -= 1;
        }
        if value_start < marker_position {
            return Some(value_start);
        }
    }
    None
}

fn target_hint(target: &IntentTarget) -> Option<String> {
    if let Some(device) = target.device.as_deref() {
        return Some(category_hint(device).unwrap_or(device).to_string());
    }
    if let Some(room) = target.room.as_deref() {
        return Some(room.to_string());
    }
    None
}

fn category_hint(value: &str) -> Option<&'static str> {
    match value {
        "light" => Some("灯"),
        "air_conditioner" => Some("空调"),
        "fan" => Some("风扇"),
        "curtain" => Some("窗帘"),
        "airer" => Some("晾衣架"),
        "switch" => Some("插座"),
        "television" => Some("电视"),
        "speaker" => Some("音箱"),
        "air_purifier" => Some("空气净化器"),
        "fresh_air_system" => Some("新风机"),
        "humidifier" => Some("加湿器"),
        "dehumidifier" => Some("除湿机"),
        "vacuum" => Some("扫地机器人"),
        "water_heater" => Some("热水器"),
        "heater" => Some("电暖器"),
        "bathroom_heater" => Some("浴霸"),
        "washing_machine" => Some("洗衣机"),
        "dishwasher" => Some("洗碗机"),
        "refrigerator" => Some("冰箱"),
        "cooker" => Some("电饭煲"),
        "water_purifier" => Some("净水器"),
        _ => None,
    }
}

fn inherit_target(target: &mut IntentTarget, previous: &IntentTarget) {
    if target.home.is_none() {
        target.home.clone_from(&previous.home);
    }
    if target.room.is_none() {
        target.room.clone_from(&previous.room);
    }
    if target.device.is_none() {
        target.device.clone_from(&previous.device);
    }
    target.all |= previous.all;
    if target.exclude_rooms.is_empty() {
        target.exclude_rooms.clone_from(&previous.exclude_rooms);
    }
    if target.exclude_devices.is_empty() {
        target.exclude_devices.clone_from(&previous.exclude_devices);
    }
    if target.exclude_categories.is_empty() {
        target
            .exclude_categories
            .clone_from(&previous.exclude_categories);
    }
}

async fn execute_command_chain(
    state: &Arc<AppState>,
    catalog: &DeviceCatalog,
    intents: Vec<AssistantIntent>,
) -> AssistantResponse {
    let mut commands = Vec::new();
    let mut summaries = Vec::new();
    for (index, intent) in intents.into_iter().enumerate() {
        match catalog.resolve(intent) {
            ResolveOutcome::Ready {
                summary,
                requires_confirmation,
                confirmation_reason,
                command,
            } => {
                if requires_confirmation {
                    return AssistantResponse::simple(
                        "confirmation_required",
                        format!(
                            "组合指令第 {} 条需要二次确认：{}。请把这条指令单独发送，完成确认后再执行其他步骤。",
                            index + 1,
                            confirmation_reason.unwrap_or_else(|| "涉及高风险操作".to_string())
                        ),
                    );
                }
                summaries.push(summary);
                commands.push(*command);
            }
            ResolveOutcome::Ambiguous {
                message,
                candidates,
            } => {
                return AssistantResponse {
                    status: "ambiguous".to_string(),
                    reply: format!("组合指令第 {} 条没有唯一目标：{message}", index + 1),
                    summary: None,
                    confirmation_id: None,
                    candidates,
                    verified: None,
                };
            }
            ResolveOutcome::NotFound { message } => {
                return AssistantResponse::simple(
                    "not_found",
                    format!("组合指令第 {} 条无法执行：{message}", index + 1),
                );
            }
        }
    }
    let mut replies = Vec::new();
    let mut statuses = Vec::new();
    let mut verified = Vec::new();
    for command in commands {
        let response = execute(state, command).await;
        statuses.push(response.status.clone());
        if let Some(value) = response.verified {
            verified.push(value);
        }
        replies.push(response.reply);
    }
    let successful = statuses
        .iter()
        .filter(|status| matches!(status.as_str(), "executed" | "state"))
        .count();
    let status = if successful == statuses.len() {
        if statuses.iter().all(|status| status == "state") {
            "state"
        } else {
            "executed"
        }
    } else if successful > 0 {
        "partial"
    } else {
        "error"
    };
    let verified = (verified.len() == statuses.len()).then(|| verified.iter().all(|value| *value));
    AssistantResponse {
        status: status.to_string(),
        reply: replies
            .iter()
            .enumerate()
            .map(|(index, reply)| format!("{}. {reply}", index + 1))
            .collect::<Vec<_>>()
            .join("\n"),
        summary: Some(summaries.join("；")),
        confirmation_id: None,
        candidates: Vec::new(),
        verified,
    }
}

async fn parse_with_llm(
    catalog: &DeviceCatalog,
    text: &str,
    config: &LlmConfig,
) -> anyhow::Result<mihome_core::AssistantIntent> {
    let parser = OpenAiIntentParser::new(&config.base_url, &config.model, &config.api_key)?;
    parser.parse(catalog, text).await
}

async fn create_confirmation(
    state: &Arc<AppState>,
    scope: &str,
    command: ResolvedCommand,
    summary: String,
    reason: Option<String>,
) -> AssistantResponse {
    let id = format!("{:06}", rand::random::<u32>() % 1_000_000);
    let scope = scope.to_string();
    let mut runtime = state.assistant_runtime.lock().await;
    runtime
        .confirmations
        .retain(|_, pending| pending.expires_at > Instant::now() && pending.scope != scope);
    runtime.confirmations.insert(
        id.clone(),
        PendingConfirmation {
            scope,
            command,
            expires_at: Instant::now() + CONFIRMATION_TTL,
        },
    );
    AssistantResponse {
        status: "confirmation_required".to_string(),
        reply: format!(
            "{}{}。请在 2 分钟内发送“确认 {}”，或发送“取消”。",
            summary,
            reason
                .map(|reason| format!("，{reason}"))
                .unwrap_or_default(),
            id
        ),
        summary: Some(summary),
        confirmation_id: Some(id),
        candidates: Vec::new(),
        verified: None,
    }
}

async fn cancel_pending(state: &Arc<AppState>, scope: &str) -> AssistantResponse {
    let mut runtime = state.assistant_runtime.lock().await;
    let before = runtime.confirmations.len();
    runtime
        .confirmations
        .retain(|_, pending| pending.scope != scope);
    if runtime.confirmations.len() < before {
        AssistantResponse::simple("cancelled", "已取消待确认操作。")
    } else {
        AssistantResponse::simple("help", "当前没有待确认操作。")
    }
}

async fn confirm_pending(state: &Arc<AppState>, scope: &str, text: &str) -> AssistantResponse {
    let requested_id = extract_confirmation_id(text);
    let command = {
        let mut runtime = state.assistant_runtime.lock().await;
        runtime
            .confirmations
            .retain(|_, pending| pending.expires_at > Instant::now());
        let key = runtime
            .confirmations
            .iter()
            .find(|(id, pending)| {
                pending.scope == scope
                    && requested_id
                        .as_deref()
                        .is_none_or(|requested| id.as_str() == requested)
            })
            .map(|(key, _)| key.clone());
        key.and_then(|key| runtime.confirmations.remove(&key))
    };
    let Some(pending) = command else {
        return AssistantResponse::simple(
            "not_found",
            "没有找到可确认的操作，可能已过期或已在其他会话处理。",
        );
    };
    execute(state, pending.command).await
}

fn extract_confirmation_id(text: &str) -> Option<String> {
    let digits: String = text.chars().filter(char::is_ascii_digit).take(12).collect();
    (digits.chars().count() >= 4).then_some(digits)
}

fn is_confirm(text: &str) -> bool {
    let Some(rest) = text.trim().strip_prefix("确认") else {
        return false;
    };
    let rest = rest.trim();
    rest.is_empty()
        || (rest.len() <= 12 && rest.chars().all(|character| character.is_ascii_digit()))
}

fn is_cancel(text: &str) -> bool {
    matches!(text, "取消" | "算了" | "不要了" | "停止")
}

async fn execute(state: &Arc<AppState>, command: ResolvedCommand) -> AssistantResponse {
    let cloud = {
        let cloud = state.cloud.lock().await;
        match cloud.as_ref() {
            Some(cloud) => cloud.clone(),
            None => return AssistantResponse::simple("error", "米家账号未登录。"),
        }
    };
    let summary = command.summary.clone();
    match &command.operation {
        ResolvedOperation::RunScene {
            scene_id,
            home_id,
            name,
        } => match cloud.run_scene(scene_id, home_id).await {
            Ok(_) => AssistantResponse {
                status: "executed".to_string(),
                reply: format!("已执行场景「{name}」。"),
                summary: Some(summary),
                confirmation_id: None,
                candidates: Vec::new(),
                verified: None,
            },
            Err(error) => AssistantResponse::simple("error", format!("执行场景失败：{error}")),
        },
        ResolvedOperation::SetProperty {
            did,
            siid,
            piid,
            value,
            label,
            capability,
            ..
        } => {
            let result = write_property(
                &cloud,
                did,
                *siid,
                *piid,
                value,
                label,
                capability,
                summary.clone(),
            )
            .await;
            AssistantResponse {
                status: if result.success {
                    "executed".to_string()
                } else {
                    "error".to_string()
                },
                reply: result.reply,
                summary: Some(summary),
                confirmation_id: None,
                candidates: Vec::new(),
                verified: Some(result.verified),
            }
        }
        ResolvedOperation::AdjustProperty {
            did,
            device_name,
            capability,
            direction,
            amount,
            unit,
            ..
        } => {
            let result = adjust_property(
                &cloud,
                did,
                device_name,
                capability,
                *direction,
                *amount,
                *unit,
            )
            .await;
            AssistantResponse {
                status: if result.success {
                    "executed".to_string()
                } else {
                    "error".to_string()
                },
                reply: result.reply,
                summary: Some(summary),
                confirmation_id: None,
                candidates: Vec::new(),
                verified: Some(result.verified),
            }
        }
        ResolvedOperation::Batch {
            description,
            operations,
            skipped,
        } => {
            let mut succeeded = 0;
            let mut verified = 0;
            let mut failures = Vec::new();
            for operation in operations {
                let result = match operation {
                    ResolvedOperation::SetProperty {
                        did,
                        siid,
                        piid,
                        value,
                        label,
                        capability,
                        device_name,
                    } => {
                        write_property(
                            &cloud,
                            did,
                            *siid,
                            *piid,
                            value,
                            label,
                            capability,
                            format!("设置 {}", device_name),
                        )
                        .await
                    }
                    ResolvedOperation::AdjustProperty {
                        did,
                        device_name,
                        capability,
                        direction,
                        amount,
                        unit,
                    } => {
                        adjust_property(
                            &cloud,
                            did,
                            device_name,
                            capability,
                            *direction,
                            *amount,
                            *unit,
                        )
                        .await
                    }
                    ResolvedOperation::CallAction {
                        did,
                        device_name,
                        siid,
                        aiid,
                        name,
                        repeat,
                    } => {
                        execute_batch_action(&cloud, did, device_name, *siid, *aiid, name, *repeat)
                            .await
                    }
                    _ => PropertyExecution {
                        reply: "批量操作中包含不支持的子操作。".to_string(),
                        success: false,
                        verified: false,
                    },
                };
                if result.success {
                    succeeded += 1;
                    if result.verified {
                        verified += 1;
                    }
                } else {
                    failures.push(result.reply);
                }
            }
            let status = if failures.is_empty() {
                "executed"
            } else if succeeded == 0 {
                "error"
            } else {
                "partial"
            };
            let mut reply = format!("{}：成功 {} 个", description, succeeded);
            if !failures.is_empty() {
                reply.push_str(&format!("，失败 {} 个", failures.len()));
            }
            if verified > 0 {
                reply.push_str(&format!("，已回读确认 {} 个", verified));
            }
            reply.push('。');
            if !failures.is_empty() {
                reply.push('\n');
                reply.push_str(
                    &failures
                        .iter()
                        .map(|failure| format!("• {failure}"))
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
            }
            if !skipped.is_empty() {
                reply.push_str("\n未执行：");
                reply.push_str(&skipped.join("、"));
                reply.push('。');
            }
            AssistantResponse {
                status: status.to_string(),
                reply,
                summary: Some(summary),
                confirmation_id: None,
                candidates: Vec::new(),
                verified: Some(failures.is_empty() && verified == succeeded),
            }
        }
        ResolvedOperation::CallAction {
            did,
            device_name,
            siid,
            aiid,
            name,
            repeat,
        } => {
            let mut succeeded = 0;
            for _ in 0..(*repeat).clamp(1, 10) {
                match cloud.call_action(did, *siid, *aiid, json!([])).await {
                    Ok(raw) => {
                        if let Some(error) = cloud_error(&raw) {
                            return AssistantResponse::simple(
                                "error",
                                format!("{device_name} 拒绝执行{name}：{error}"),
                            );
                        }
                        succeeded += 1;
                        if *repeat > 1 {
                            tokio::time::sleep(Duration::from_millis(250)).await;
                        }
                    }
                    Err(error) => {
                        return AssistantResponse::simple(
                            "error",
                            format!("执行 {device_name} {name}失败：{error}"),
                        )
                    }
                }
            }
            AssistantResponse {
                status: "executed".to_string(),
                reply: if succeeded > 1 {
                    format!("已对 {device_name} 执行 {name} {succeeded} 次。")
                } else {
                    format!("已对 {device_name} 执行 {name}。")
                },
                summary: Some(summary),
                confirmation_id: None,
                candidates: Vec::new(),
                verified: None,
            }
        }
        ResolvedOperation::QueryProperty {
            did,
            device_name,
            siid,
            piid,
            label,
            capability,
        } => {
            let result =
                read_property(&cloud, did, device_name, *siid, *piid, label, capability).await;
            AssistantResponse {
                status: if result.success {
                    "state".to_string()
                } else {
                    "error".to_string()
                },
                reply: result.reply,
                summary: Some(format!("{device_name} {label}")),
                confirmation_id: None,
                candidates: Vec::new(),
                verified: Some(result.verified),
            }
        }
        ResolvedOperation::QueryProperties {
            description,
            queries,
            skipped,
        } => {
            let mut states = Vec::new();
            let mut failures = Vec::new();
            for query in queries {
                let result = read_property(
                    &cloud,
                    &query.did,
                    &query.device_name,
                    query.siid,
                    query.piid,
                    &query.label,
                    &query.capability,
                )
                .await;
                if result.success {
                    states.push(result.reply);
                } else {
                    failures.push(result.reply);
                }
            }
            let status = if failures.is_empty() {
                "state"
            } else if states.is_empty() {
                "error"
            } else {
                "partial"
            };
            let mut reply = if states.is_empty() {
                "没有读取到设备状态。".to_string()
            } else {
                states
                    .iter()
                    .map(|state| format!("• {state}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            if !failures.is_empty() {
                reply.push_str("\n读取失败：");
                reply.push_str(
                    &failures
                        .iter()
                        .map(|failure| format!("• {failure}"))
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
            }
            if !skipped.is_empty() {
                reply.push_str("\n未查询：");
                reply.push_str(&skipped.join("、"));
                reply.push('。');
            }
            AssistantResponse {
                status: status.to_string(),
                reply,
                summary: Some(description.clone()),
                confirmation_id: None,
                candidates: Vec::new(),
                verified: Some(failures.is_empty()),
            }
        }
        ResolvedOperation::DeviceOverview { reply } => {
            AssistantResponse::simple("state", reply.clone())
        }
    }
}

async fn read_property(
    cloud: &MiCloud,
    did: &str,
    device_name: &str,
    siid: u32,
    piid: u32,
    label: &str,
    capability: &CatalogCapability,
) -> PropertyExecution {
    match cloud.get_prop(did, siid, piid).await {
        Ok(value) => match property_value(&value) {
            Some(value) => PropertyExecution {
                reply: format!(
                    "{} {}：{}",
                    device_name,
                    label,
                    format_capability_value(capability, value)
                ),
                success: true,
                verified: true,
            },
            None => PropertyExecution {
                reply: format!("没有读取到 {device_name} 的设备状态。"),
                success: false,
                verified: false,
            },
        },
        Err(error) => PropertyExecution {
            reply: format!("读取 {device_name} 状态失败：{error}"),
            success: false,
            verified: false,
        },
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_batch_action(
    cloud: &MiCloud,
    did: &str,
    device_name: &str,
    siid: u32,
    aiid: u32,
    name: &str,
    repeat: u32,
) -> PropertyExecution {
    for _ in 0..repeat.clamp(1, 10) {
        let result = cloud.call_action(did, siid, aiid, json!([])).await;
        match result {
            Ok(raw) => {
                if let Some(error) = cloud_error(&raw) {
                    return PropertyExecution {
                        reply: format!("{device_name} 执行{name}失败：{error}"),
                        success: false,
                        verified: false,
                    };
                }
            }
            Err(error) => {
                return PropertyExecution {
                    reply: format!("{device_name} 执行{name}失败：{error}"),
                    success: false,
                    verified: false,
                }
            }
        }
    }
    PropertyExecution {
        reply: if repeat > 1 {
            format!("{device_name} {name} ×{repeat}")
        } else {
            format!("{device_name} {name}")
        },
        success: true,
        verified: false,
    }
}

struct PropertyExecution {
    reply: String,
    success: bool,
    verified: bool,
}

#[allow(clippy::too_many_arguments)]
async fn write_property(
    cloud: &MiCloud,
    did: &str,
    siid: u32,
    piid: u32,
    value: &Value,
    label: &str,
    capability: &CatalogCapability,
    summary: String,
) -> PropertyExecution {
    let raw = match cloud.set_prop(did, siid, piid, value.clone()).await {
        Ok(raw) => raw,
        Err(error) => {
            return PropertyExecution {
                reply: format!("执行失败：{error}"),
                success: false,
                verified: false,
            }
        }
    };
    if let Some(error) = cloud_error(&raw) {
        return PropertyExecution {
            reply: format!("设备拒绝执行：{error}"),
            success: false,
            verified: false,
        };
    }
    let mut last_actual = None;
    let mut last_error = None;
    for delay_ms in [350_u64, 700, 1200] {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        match cloud.get_prop(did, siid, piid).await {
            Ok(state) => match property_value(&state) {
                Some(actual) if value_matches(value, actual) => {
                    return PropertyExecution {
                        reply: format!(
                            "{}，当前{}为 {}。",
                            summary,
                            label,
                            format_capability_value(capability, actual)
                        ),
                        success: true,
                        verified: true,
                    };
                }
                Some(actual) => last_actual = Some(actual.clone()),
                None => {
                    last_error = Some("响应里没有可读取的属性值".to_string());
                }
            },
            Err(error) => {
                last_error = Some(format!("{error:#}"));
            }
        }
    }
    if let Some(actual) = last_actual {
        PropertyExecution {
            reply: format!(
                "{}，但读取到的{}仍为 {}，请检查设备状态。",
                summary,
                label,
                format_capability_value(capability, &actual)
            ),
            success: true,
            verified: false,
        }
    } else {
        if let Some(error) = last_error {
            app_log::debug("Assistant", format!("执行后状态读取失败：{error}"));
        }
        PropertyExecution {
            reply: format!("命令已发送：{summary}。状态回读未确认。"),
            success: true,
            verified: false,
        }
    }
}

async fn adjust_property(
    cloud: &MiCloud,
    did: &str,
    device_name: &str,
    capability: &CatalogCapability,
    direction: AdjustmentDirection,
    amount: Option<f64>,
    unit: AdjustmentUnit,
) -> PropertyExecution {
    let raw = match cloud.get_prop(did, capability.siid, capability.piid).await {
        Ok(raw) => raw,
        Err(error) => {
            return PropertyExecution {
                reply: format!("读取 {device_name} 当前状态失败：{error}"),
                success: false,
                verified: false,
            }
        }
    };
    if let Some(error) = cloud_error(&raw) {
        return PropertyExecution {
            reply: format!("读取 {device_name} 当前状态失败：{error}"),
            success: false,
            verified: false,
        };
    }
    let Some(current) = property_value(&raw) else {
        return PropertyExecution {
            reply: format!("没有读取到 {device_name} 的当前{}。", capability.label),
            success: false,
            verified: false,
        };
    };
    let (value, display) = if !capability.value_list.is_empty() {
        let Some(current_value) = current.as_i64() else {
            return PropertyExecution {
                reply: format!("{device_name} 的{}不是可识别的档位。", capability.label),
                success: false,
                verified: false,
            };
        };
        let Some(index) = capability
            .value_list
            .iter()
            .position(|item| item.value == current_value)
        else {
            return PropertyExecution {
                reply: format!(
                    "{device_name} 的{}当前值 {} 不在可选档位中。",
                    capability.label, current_value
                ),
                success: false,
                verified: false,
            };
        };
        let shift = amount.unwrap_or(1.0).abs().round().max(1.0) as i64;
        let next = match direction {
            AdjustmentDirection::Increase => {
                (index as i64 + shift).min(capability.value_list.len().saturating_sub(1) as i64)
            }
            AdjustmentDirection::Decrease => (index as i64 - shift).max(0),
        } as usize;
        let item = &capability.value_list[next];
        (
            json!(item.value),
            if item.description.is_empty() {
                item.value.to_string()
            } else {
                localized_enum(&item.description).to_string()
            },
        )
    } else {
        let Some(current_number) = current
            .as_f64()
            .or_else(|| current.as_str().and_then(|value| value.parse().ok()))
        else {
            return PropertyExecution {
                reply: format!(
                    "{device_name} 的{}不是数字，无法相对调节。",
                    capability.label
                ),
                success: false,
                verified: false,
            };
        };
        let Some(range) = capability.value_range.as_ref() else {
            return PropertyExecution {
                reply: format!("{device_name} 的{}缺少可调范围。", capability.label),
                success: false,
                verified: false,
            };
        };
        let delta = adjustment_delta(capability, range.min, range.max, range.step, amount, unit);
        let target = match direction {
            AdjustmentDirection::Increase => current_number + delta,
            AdjustmentDirection::Decrease => current_number - delta,
        }
        .clamp(range.min, range.max);
        let step = range.step.max(f64::EPSILON);
        let snapped =
            (range.min + ((target - range.min) / step).round() * step).clamp(range.min, range.max);
        let numeric = if capability.data_type.starts_with("uint")
            || capability.data_type.starts_with("int")
        {
            json!(snapped.round() as i64)
        } else {
            serde_json::Number::from_f64(snapped)
                .map(Value::Number)
                .unwrap_or_else(|| json!(snapped))
        };
        let display = format_capability_value(capability, &numeric);
        (numeric, display)
    };
    let verb = match direction {
        AdjustmentDirection::Increase => "调高",
        AdjustmentDirection::Decrease => "调低",
    };
    let summary = format!(
        "将 {device_name} 的{}从 {} {}到 {}",
        capability.label,
        format_capability_value(capability, current),
        verb,
        display
    );
    write_property(
        cloud,
        did,
        capability.siid,
        capability.piid,
        &value,
        &capability.label,
        capability,
        summary,
    )
    .await
}

fn adjustment_delta(
    capability: &CatalogCapability,
    min: f64,
    max: f64,
    step: f64,
    amount: Option<f64>,
    unit: AdjustmentUnit,
) -> f64 {
    let span = (max - min).abs();
    let fallback = match capability.name.as_str() {
        "brightness" | "volume" | "current_position" | "position" => span * 0.1,
        "color_temperature" => 500.0,
        "target_temperature" => 1.0,
        "fan_level" => span * 0.1,
        _ => step.max(1.0),
    };
    match unit {
        AdjustmentUnit::Percent => span * amount.unwrap_or(10.0).clamp(0.1, 100.0) / 100.0,
        AdjustmentUnit::Step => match amount {
            Some(amount) => step * amount.abs().max(1.0),
            None => fallback,
        },
        AdjustmentUnit::Degree | AdjustmentUnit::Kelvin => amount.unwrap_or(fallback).abs(),
        AdjustmentUnit::Default => amount.unwrap_or(fallback).abs(),
    }
    .max(step)
}

fn format_capability_value(capability: &CatalogCapability, value: &Value) -> String {
    if !capability.value_list.is_empty() {
        if let Some(number) = value.as_i64() {
            if let Some(item) = capability
                .value_list
                .iter()
                .find(|item| item.value == number)
            {
                return if item.description.is_empty() {
                    number.to_string()
                } else {
                    localized_enum(&item.description).to_string()
                };
            }
        }
    }
    let formatted = format_value(value);
    capability
        .unit
        .as_deref()
        .and_then(localized_property_unit)
        .map(|unit| format!("{formatted}{unit}"))
        .unwrap_or(formatted)
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

fn localized_enum(description: &str) -> &str {
    match description.trim().to_ascii_lowercase().as_str() {
        "cool" => "制冷",
        "heat" => "制热",
        "dry" => "除湿",
        "fan" => "送风",
        "auto" | "automatic" => "自动",
        "sleep" => "睡眠",
        "eco" | "energy saving" => "节能",
        "comfort" => "舒适",
        "turbo" | "powerful" | "strong" => "强劲",
        "quiet" | "silent" => "静音",
        "fresh" => "清新",
        "anti-direct" | "anti direct" | "avoid" => "防直吹",
        "low" => "低",
        "medium" | "middle" | "mid" => "中",
        "high" => "高",
        "up" => "上升",
        "down" => "下降",
        "pause" => "暂停",
        "playing" => "播放中",
        "stop" => "停止",
        "natural wind" => "自然风",
        "straight wind" => "直吹风",
        "circular wind" => "循环风",
        _ => description,
    }
}

fn cloud_error(value: &Value) -> Option<String> {
    let items = value
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_else(|| std::slice::from_ref(value));
    for item in items {
        let code = item.get("code").and_then(Value::as_i64).unwrap_or(0);
        if code != 0 {
            return Some(
                item.get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("错误码 {code}")),
            );
        }
    }
    None
}

fn property_value(value: &Value) -> Option<&Value> {
    value
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("code").and_then(Value::as_i64).unwrap_or(0) == 0)
        })
        .or_else(|| value.as_object().map(|_| value))
        .and_then(|item| item.get("value"))
}

fn value_matches(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Number(left), Value::Number(right)) => left
            .as_f64()
            .zip(right.as_f64())
            .is_some_and(|(left, right)| (left - right).abs() < 0.001),
        (Value::Bool(left), Value::Bool(right)) => left == right,
        (Value::String(left), Value::String(right)) => left == right,
        _ => expected == actual,
    }
}

fn format_value(value: &Value) -> String {
    match value {
        Value::Bool(true) => "开启".to_string(),
        Value::Bool(false) => "关闭".to_string(),
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Null => "未知".to_string(),
        other => other.to_string(),
    }
}

async fn catalog_for(
    state: &Arc<AppState>,
    home_id: Option<&str>,
) -> anyhow::Result<DeviceCatalog> {
    {
        let runtime = state.assistant_runtime.lock().await;
        if let Some((fetched_at, cached_home, catalog)) = &runtime.catalog {
            if fetched_at.elapsed() < CATALOG_TTL && cached_home.as_deref() == home_id {
                return Ok(catalog.clone());
            }
        }
    }
    let cloud = {
        let cloud = state.cloud.lock().await;
        cloud
            .as_ref()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("米家账号未登录"))?
    };
    let homes = cloud.homes().await?;
    let targets: Vec<_> = homes
        .iter()
        .filter(|home| home_id.is_none_or(|home_id| home.id == home_id))
        .cloned()
        .collect();
    if targets.is_empty() {
        anyhow::bail!("没有找到家庭");
    }
    let devices = cloud.devices(home_id).await?;
    let mut scenes = Vec::new();
    for home in &targets {
        match cloud.scenes(&home.id).await {
            Ok(mut items) => scenes.append(&mut items),
            Err(error) => app_log::warn(
                "Assistant",
                format!("读取家庭 {} 的场景失败：{error}", home.name),
            ),
        }
    }
    let spec_types: Vec<String> = devices
        .iter()
        .filter_map(|device| device.spec_type.clone())
        .collect();
    let batch = state.specs.load(&spec_types).await;
    if !batch.errors.is_empty() {
        app_log::warn(
            "Assistant",
            format!("部分设备规格读取失败：{}", batch.errors.join("; ")),
        );
    }
    let catalog = DeviceCatalog::from_parts(&targets, &devices, &batch.specs, &scenes);
    let mut runtime = state.assistant_runtime.lock().await;
    runtime.catalog = Some((Instant::now(), home_id.map(str::to_string), catalog.clone()));
    Ok(catalog)
}

pub(crate) async fn catalog_snapshot(
    state: &Arc<AppState>,
    home_id: Option<&str>,
) -> anyhow::Result<Value> {
    let catalog = catalog_for(state, home_id).await?;
    Ok(json!({
        "homes": catalog.homes(),
        "devices": catalog.devices,
        "scenes": catalog.scenes,
    }))
}

fn help_text() -> String {
    "可以这样说：\n• 打开客厅灯 / 关闭所有灯，除了客厅灯\n• 打开空调并调至 24°C / 调高一度\n• 客厅灯亮度 50% / 百分之五十 / 调成暖光\n• 打开窗帘一半 / 暂停窗帘\n• 音箱音量 40% / 静音 / 暂停播放\n• 扫地机器人开始清扫 / 回充\n• 关灯、关空调、打开空气净化器\n• 执行回家模式 / 客厅温度多少 / 当前有几个设备在线".to_string()
}

fn append_audit(source: &str, event_id: Option<&str>, text: &str, response: &AssistantResponse) {
    let path = audit_path();
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let record = json!({
        "at": Local::now().to_rfc3339(),
        "source": source,
        "event_id": event_id,
        "text": text.chars().take(120).collect::<String>(),
        "status": response.status,
        "summary": response.summary,
        "verified": response.verified,
    });
    let Ok(line) = serde_json::to_string(&record) else {
        return;
    };
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn audit_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Application Support/MiHome/assistant-audit.jsonl")
}

#[cfg(test)]
mod tests {
    use super::{
        adjustment_delta, format_capability_value, is_confirm, localized_property_unit,
        parse_local_command_chain, split_command_clauses, unsupported_request_reason,
    };
    use mihome_core::assistant::{
        AdjustmentUnit, CatalogCapability, DeviceCatalog, ResolveOutcome,
    };
    use serde_json::json;

    #[test]
    fn confirmation_only_accepts_the_command_or_its_numeric_code() {
        assert!(is_confirm("确认"));
        assert!(is_confirm("确认 123456"));
        assert!(is_confirm("确认123456"));
        assert!(!is_confirm("确认一下客厅灯的状态"));
        assert!(!is_confirm("确认打开门锁"));
        assert!(!is_confirm("帮我确认 123456"));
    }

    fn capability(name: &str, min: f64, max: f64, step: f64) -> CatalogCapability {
        CatalogCapability {
            name: name.to_string(),
            label: name.to_string(),
            service: String::new(),
            siid: 2,
            piid: 1,
            data_type: "uint8".to_string(),
            writable: true,
            readable: true,
            primary: true,
            unit: None,
            value_range: Some(mihome_core::assistant::CatalogValueRange { min, max, step }),
            value_list: vec![],
        }
    }

    #[test]
    fn relative_defaults_follow_capability_ranges() {
        let brightness = capability("brightness", 1.0, 100.0, 1.0);
        assert!(
            (adjustment_delta(&brightness, 1.0, 100.0, 1.0, None, AdjustmentUnit::Percent) - 9.9)
                .abs()
                < 0.001
        );
        let temperature = capability("target_temperature", 16.0, 30.0, 1.0);
        assert_eq!(
            adjustment_delta(
                &temperature,
                16.0,
                30.0,
                1.0,
                Some(2.0),
                AdjustmentUnit::Degree
            ),
            2.0
        );
        let color = capability("color_temperature", 2700.0, 6500.0, 1.0);
        assert_eq!(
            adjustment_delta(&color, 2700.0, 6500.0, 1.0, None, AdjustmentUnit::Kelvin),
            500.0
        );
    }

    #[test]
    fn formats_miot_units_for_user_facing_status() {
        let mut temperature = capability("current_temperature", -20.0, 80.0, 0.1);
        temperature.unit = Some("celsius".to_string());
        assert_eq!(
            format_capability_value(&temperature, &json!(19.4)),
            "19.4°C"
        );

        let mut humidity = capability("relative_humidity", 0.0, 100.0, 1.0);
        humidity.unit = Some("percentage".to_string());
        assert_eq!(format_capability_value(&humidity, &json!(56)), "56%");

        let mut vendor = capability("vendor_value", 0.0, 100.0, 1.0);
        vendor.unit = Some("vendor_points".to_string());
        assert_eq!(format_capability_value(&vendor, &json!(12)), "12");
        assert_eq!(localized_property_unit("none"), None);
    }

    #[test]
    fn splits_chained_and_implicit_device_settings() {
        assert_eq!(
            split_command_clauses("打开空调并调至24°C"),
            vec!["打开空调", "调至24°C"]
        );
        assert_eq!(
            split_command_clauses("打开客厅灯调到50%"),
            vec!["打开客厅灯", "调到50%"]
        );
        assert_eq!(
            split_command_clauses("打开空调上下扫风"),
            vec!["打开空调", "上下扫风"]
        );
        assert_eq!(
            split_command_clauses("关灯、关空调、打开空气净化器"),
            vec!["关灯", "关空调", "打开空气净化器"]
        );
    }

    #[test]
    fn blocks_negated_and_delayed_controls() {
        assert!(unsupported_request_reason("不要关空调").is_some());
        assert!(unsupported_request_reason("一小时后打开风扇").is_some());
        assert!(unsupported_request_reason("定时关闭客厅灯").is_some());
        assert!(unsupported_request_reason("关闭所有灯，除了客厅灯").is_none());
    }

    #[test]
    fn chain_inherits_the_previous_device_target() {
        let catalog: DeviceCatalog = serde_json::from_value(json!({
            "devices": [{
                "did": "ac-1",
                "home_id": "home-1",
                "home_name": "我的家",
                "room_name": "主卧",
                "name": "主卧空调",
                "category": "air_conditioner",
                "online": true,
                "capabilities": [
                    {
                        "name": "on",
                        "label": "开关",
                        "siid": 2,
                        "piid": 1,
                        "data_type": "bool",
                        "writable": true,
                        "readable": true,
                        "primary": true
                    },
                    {
                        "name": "target_temperature",
                        "label": "目标温度",
                        "siid": 2,
                        "piid": 2,
                        "data_type": "int8",
                        "writable": true,
                        "readable": true,
                        "primary": true,
                        "unit": "°C",
                        "value_range": {"min": 16.0, "max": 30.0, "step": 1.0}
                    },
                    {
                        "name": "vertical_swing",
                        "label": "上下扫风",
                        "siid": 2,
                        "piid": 3,
                        "data_type": "bool",
                        "writable": true,
                        "readable": true,
                        "primary": true
                    }
                ],
                "actions": []
            }],
            "scenes": []
        }))
        .expect("catalog");
        let intents = parse_local_command_chain(&catalog, "打开空调并调至24°C").expect("chain");
        assert_eq!(intents.len(), 2);
        assert_eq!(intents[0].target.device.as_deref(), Some("air_conditioner"));
        assert_eq!(intents[1].target.device.as_deref(), Some("air_conditioner"));
        assert!(matches!(
            catalog.resolve(intents[0].clone()),
            ResolveOutcome::Ready { .. }
        ));
        assert!(matches!(
            catalog.resolve(intents[1].clone()),
            ResolveOutcome::Ready { .. }
        ));

        let swing = parse_local_command_chain(&catalog, "打开空调上下扫风").expect("swing chain");
        assert_eq!(swing.len(), 2);
        assert_eq!(swing[1].capability.as_deref(), Some("vertical_swing"));
        assert!(matches!(
            catalog.resolve(swing[1].clone()),
            ResolveOutcome::Ready { .. }
        ));
    }
}
