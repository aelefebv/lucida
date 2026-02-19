//! Step 07 daemon scaffold primitives.

/// Stable daemon defaults agreed for Step 07.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DaemonDefaults {
    pub event_queue_capacity: usize,
    pub closed_session_retention_seconds: u64,
    pub session_routing: SessionRoutingMode,
}

impl Default for DaemonDefaults {
    fn default() -> Self {
        Self {
            event_queue_capacity: 1024,
            closed_session_retention_seconds: 60,
            session_routing: SessionRoutingMode::SerialPerSession,
        }
    }
}

/// Session routing mode baseline for Step 07.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRoutingMode {
    SerialPerSession,
}

/// Startup summary used by scaffold checks and smoke tests.
pub fn startup_summary() -> String {
    let defaults = DaemonDefaults::default();
    format!(
        "routing={:?} queue={} retention_s={}",
        defaults.session_routing,
        defaults.event_queue_capacity,
        defaults.closed_session_retention_seconds
    )
}

#[cfg(test)]
mod tests {
    use super::{startup_summary, DaemonDefaults, SessionRoutingMode};

    #[test]
    fn defaults_match_step7_contract() {
        let defaults = DaemonDefaults::default();
        assert_eq!(defaults.event_queue_capacity, 1024);
        assert_eq!(defaults.closed_session_retention_seconds, 60);
        assert_eq!(defaults.session_routing, SessionRoutingMode::SerialPerSession);
    }

    #[test]
    fn startup_summary_is_non_empty() {
        assert!(!startup_summary().is_empty());
    }
}
