use crate::{app_log, dingtalk_ws, feishu_ws, wecom_ws, AppState};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;

#[derive(Default)]
pub(crate) struct NetworkRecovery {
    last_online: Option<bool>,
}

impl NetworkRecovery {
    fn observe(&mut self, online: bool) -> bool {
        let restored = self.last_online == Some(false) && online;
        self.last_online = Some(online);
        restored
    }
}

pub(crate) async fn probe_and_recover_network(
    state: &Arc<AppState>,
    recovery: &mut NetworkRecovery,
) {
    let has_enabled_platform = {
        let store = state.integrations.lock().await;
        let settings = store.settings();
        settings.feishu.enabled || settings.wecom.enabled || settings.dingtalk.enabled
    };
    if !has_enabled_platform {
        recovery.last_online = None;
        return;
    }
    let online = tokio::time::timeout(
        Duration::from_secs(3),
        TcpStream::connect("captive.apple.com:80"),
    )
    .await
    .is_ok_and(|result| result.is_ok());
    if recovery.observe(online) {
        app_log::info("Supervisor", "检测到网络从断开恢复，检查平台长连接");
        reconnect_disconnected(state).await;
    }
}

/// Reconnect configured platforms whose tasks stopped or exhausted their retry
/// budget. This is used when the app regains focus, not as an unconditional
/// background retry loop.
pub(crate) async fn reconnect_disconnected(state: &Arc<AppState>) {
    let (feishu, wecom, dingtalk) = tokio::join!(
        feishu_ws::reconnect_if_needed(state),
        wecom_ws::reconnect_if_needed(state),
        dingtalk_ws::reconnect_if_needed(state),
    );
    if feishu || wecom || dingtalk {
        app_log::info(
            "Supervisor",
            format!("恢复断开的平台长连接：feishu={feishu}, wecom={wecom}, dingtalk={dingtalk}"),
        );
    }
}

/// Rebuild all configured platform sessions after macOS resumes from sleep.
/// A WebSocket can look connected while its underlying session is already dead.
pub(crate) async fn restart_after_resume(state: &Arc<AppState>) {
    let (feishu, wecom, dingtalk) = tokio::join!(
        feishu_ws::restart_after_resume(state),
        wecom_ws::restart_after_resume(state),
        dingtalk_ws::restart_after_resume(state),
    );
    if feishu || wecom || dingtalk {
        app_log::info(
            "Supervisor",
            format!(
                "睡眠恢复后重建平台长连接：feishu={feishu}, wecom={wecom}, dingtalk={dingtalk}"
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_recovery_only_fires_on_offline_to_online_transition() {
        let mut recovery = NetworkRecovery::default();
        assert!(!recovery.observe(true));
        assert!(!recovery.observe(false));
        assert!(recovery.observe(true));
        assert!(!recovery.observe(true));
    }
}
