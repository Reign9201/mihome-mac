use crate::assistant_engine::{self, AssistantRequest};
use crate::AppState;
use mihome_core::PlatformKind;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

const EVENT_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const EVENT_CACHE_LIMIT: usize = 512;
const COMMAND_COOLDOWN: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(crate) struct PlatformEventDedup {
    seen: HashMap<String, Instant>,
    last_command_at: HashMap<String, Instant>,
}

impl PlatformEventDedup {
    pub(crate) fn claim(&mut self, key: String) -> bool {
        let now = Instant::now();
        self.seen
            .retain(|_, seen_at| now.duration_since(*seen_at) < EVENT_CACHE_TTL);
        if self.seen.contains_key(&key) {
            return false;
        }
        if self.seen.len() >= EVENT_CACHE_LIMIT {
            if let Some(oldest) = self
                .seen
                .iter()
                .min_by_key(|(_, seen_at)| **seen_at)
                .map(|(key, _)| key.clone())
            {
                self.seen.remove(&oldest);
            }
        }
        self.seen.insert(key, now);
        true
    }

    pub(crate) fn allow_command(&mut self, key: String) -> bool {
        let now = Instant::now();
        self.last_command_at
            .retain(|_, last_at| now.duration_since(*last_at) < EVENT_CACHE_TTL);
        if self
            .last_command_at
            .get(&key)
            .is_some_and(|last_at| now.duration_since(*last_at) < COMMAND_COOLDOWN)
        {
            return false;
        }
        self.last_command_at.insert(key, now);
        true
    }
}

pub(crate) async fn claim_event(state: &Arc<AppState>, key: String) -> bool {
    state.platform_events.lock().await.claim(key)
}

async fn allow_command(state: &Arc<AppState>, key: String) -> bool {
    state.platform_events.lock().await.allow_command(key)
}

pub(crate) async fn handle_platform_message(
    state: &Arc<AppState>,
    platform: PlatformKind,
    external_user_id: &str,
    chat_id: &str,
    event_id: Option<String>,
    text: &str,
) -> String {
    handle_platform_message_with_voice(
        state,
        platform,
        external_user_id,
        chat_id,
        event_id,
        text,
        false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_platform_message_with_voice(
    state: &Arc<AppState>,
    platform: PlatformKind,
    external_user_id: &str,
    chat_id: &str,
    event_id: Option<String>,
    text: &str,
    is_voice: bool,
) -> String {
    let text = clean_platform_text(text);
    if text.is_empty() {
        return if is_voice {
            "没有识别到语音内容，请重说一次或改发文字。".to_string()
        } else {
            "没有识别到文字指令。请发送“打开客厅灯”或“配对 123456”。".to_string()
        };
    }
    let heard_prefix = is_voice.then(|| format!("我听到的是：{text}\n\n"));

    if let Some(code) = extract_pair_code(&text) {
        let result = {
            let mut store = state.integrations.lock().await;
            match store.pair_code_home(&code, platform) {
                Ok(Some(home_id)) => {
                    store.claim_pair_code(&code, platform, external_user_id, chat_id, &home_id)
                }
                Ok(None) => Err(anyhow::anyhow!("配对码没有绑定家庭，请重新生成")),
                Err(error) => Err(error),
            }
        };
        let reply = match result {
            Ok(_) => "配对成功。现在可以发送“打开客厅灯”或“执行回家模式”。".to_string(),
            Err(error) => format!("配对失败：{error}。请在 MiHome Mac 的接入页重新生成配对码。"),
        };
        return format!("{}{}", heard_prefix.as_deref().unwrap_or_default(), reply);
    }

    let binding = state
        .integrations
        .lock()
        .await
        .binding_for(platform, external_user_id, chat_id);
    let Some(binding) = binding else {
        let reply = "这个会话还没有绑定家庭。请打开 MiHome Mac → 接入 → 生成配对码，然后发送“配对 123456”。";
        return format!("{}{}", heard_prefix.as_deref().unwrap_or_default(), reply);
    };
    if !allow_command(
        state,
        format!("{}:{chat_id}:{external_user_id}", platform_source(platform)),
    )
    .await
    {
        return format!(
            "{}操作太频繁，请等几秒后再试。",
            heard_prefix.as_deref().unwrap_or_default()
        );
    }

    let response = assistant_engine::handle_request(
        state,
        AssistantRequest {
            text,
            home_id: Some(binding.home_id),
            source: Some(platform_source(platform).to_string()),
            event_id,
            chat_id: Some(chat_id.to_string()),
        },
    )
    .await;
    let mut reply = response.reply;
    if !response.candidates.is_empty() {
        reply.push_str("\n候选：");
        for candidate in response.candidates.iter().take(5) {
            reply.push_str(&format!(
                "\n• {} / {} / {}",
                candidate.home, candidate.room, candidate.device
            ));
        }
    }
    format!("{}{}", heard_prefix.as_deref().unwrap_or_default(), reply)
}

pub(crate) fn clean_platform_text(input: &str) -> String {
    let mut text = input.trim();
    while text.starts_with('@') {
        let end = text.find(char::is_whitespace).unwrap_or(text.len());
        text = text[end..].trim_start();
    }
    text.chars().take(500).collect()
}

pub(crate) fn extract_pair_code(text: &str) -> Option<String> {
    let text = text.trim();
    let rest = ["配对", "绑定", "bind", "pair", "/bind", "/pair"]
        .iter()
        .find_map(|prefix| text.strip_prefix(prefix))
        .map(str::trim);
    let candidate = rest.unwrap_or(text);
    let digits: String = candidate
        .chars()
        .filter(char::is_ascii_digit)
        .take(12)
        .collect();
    if rest.is_some() && digits.chars().count() == 6 {
        Some(digits)
    } else {
        None
    }
}

fn platform_source(platform: PlatformKind) -> &'static str {
    match platform {
        PlatformKind::Feishu => "feishu",
        PlatformKind::Wecom => "wecom",
        PlatformKind::Dingtalk => "dingtalk",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_leading_mentions() {
        assert_eq!(
            clean_platform_text("@智能管家 @_user_1  打开客厅灯"),
            "打开客厅灯"
        );
        assert_eq!(clean_platform_text("  打开空调  "), "打开空调");
    }

    #[test]
    fn extracts_pair_commands() {
        assert_eq!(extract_pair_code("配对 123456").as_deref(), Some("123456"));
        assert_eq!(extract_pair_code("/bind 654321").as_deref(), Some("654321"));
        assert_eq!(extract_pair_code("123456"), None);
    }

    #[test]
    fn dedup_rejects_repeated_events() {
        let mut dedup = PlatformEventDedup::default();
        assert!(dedup.claim("feishu:evt-1".to_string()));
        assert!(!dedup.claim("feishu:evt-1".to_string()));
        assert!(dedup.claim("feishu:evt-2".to_string()));
    }

    #[test]
    fn rate_limit_rejects_immediate_repeats() {
        let mut dedup = PlatformEventDedup::default();
        assert!(dedup.allow_command("feishu:chat:user".to_string()));
        assert!(!dedup.allow_command("feishu:chat:user".to_string()));
        assert!(dedup.allow_command("wecom:chat:user".to_string()));
    }
}
