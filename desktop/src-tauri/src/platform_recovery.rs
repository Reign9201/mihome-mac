pub(crate) fn should_reconnect(running: bool, state: &str) -> bool {
    !running || state == "error"
}

pub(crate) fn should_restart_after_resume(state: &str) -> bool {
    state != "replaced"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnects_exhausted_or_stopped_tasks_only() {
        assert!(!should_reconnect(true, "connected"));
        assert!(!should_reconnect(true, "reconnecting"));
        assert!(should_reconnect(true, "error"));
        assert!(should_reconnect(false, "stopped"));
        assert!(should_reconnect(false, "connected"));
    }

    #[test]
    fn resume_does_not_steal_a_replaced_wecom_session() {
        assert!(should_restart_after_resume("connected"));
        assert!(should_restart_after_resume("error"));
        assert!(should_restart_after_resume("stopped"));
        assert!(!should_restart_after_resume("replaced"));
    }
}
