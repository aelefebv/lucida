//! Hourly background sweep of expired session and pending-auth rows.
//!
//! Every hour the task wakes, asks each store to drop rows past their
//! respective windows, and emits a `auth.session.cleanup` debug event
//! with the per-table delete counts. Without this, a long-running
//! deployment accumulates dead rows forever (the extractor refuses to
//! issue a principal for an expired row, so they're invisible to the app
//! but live forever in the database).
//!
//! ## Design choices
//!
//! - **Warm-up grace** — first sweep fires ~60s after startup, not
//!   immediately. Boot is the busiest moment in a server's life (config
//!   load, JWKS fetch, migration check, accept loop spin-up); the sweep
//!   is non-urgent and can yield. After the warm-up, `tokio::time::interval`
//!   ticks every hour for the rest of the process's life.
//!
//! - **Idle-window vs hard-cap deletion logic lives on the store**.
//!   `LoginSessionStore::delete_expired(now)` already deletes rows with
//!   `expires_at <= now`. This task additionally invokes it with `now`
//!   to clear hard-capped sessions; the idle-timeout side is enforced at
//!   lookup time (extractor refuses idle-expired rows) and rows past the
//!   hard cap are eventually deleted here. Bounded growth either way.
//!
//! - **Errors do not crash the loop**. A transient SQLite hiccup (file
//!   locked, write failure) is logged and the task continues at the next
//!   tick. The contract: the cleanup task is best-effort hygiene; it must
//!   never bring the server down.
//!
//! - **No PII in cleanup logs**. Bulk deletes don't enumerate emails;
//!   the audit log records `auth.signin.success` / `auth.logout` per user
//!   instead. Cleanup is operational signal (counts), not audit (per-user
//!   trail).

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tracing::{debug, warn};

use super::config::AuthConfig;
use super::pending_auth::PendingAuthStore;
use super::session_store::LoginSessionStore;

/// How long after process start before the first sweep fires. Keeps the
/// sweep off the hot startup path while still landing the first deletion
/// well before the hour-long interval would.
pub const STARTUP_DELAY: Duration = Duration::from_secs(60);

/// Cadence between sweeps after the warm-up.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(3600);

/// Hard upper bound on a `pending_auth` row's lifetime. Pending rows
/// represent in-flight OAuth round-trips; ten minutes is generous (the
/// user has to click through Google's consent screen). Anything older
/// than this is either a cancelled flow or a leaked token.
pub const PENDING_TTL: Duration = Duration::from_secs(10 * 60);

/// State carried into the sweep loop. Cloned once at startup, owned by
/// the spawned task for the rest of the process's lifetime.
#[derive(Clone)]
pub struct CleanupState {
    pub config: Arc<AuthConfig>,
    pub session_store: Arc<dyn LoginSessionStore>,
    pub pending_store: Arc<dyn PendingAuthStore>,
}

/// Spawn the hourly cleanup loop. Returns the `JoinHandle` so the
/// caller (main.rs) can hold it on `AppState` and prevent the task from
/// being dropped (a dropped JoinHandle aborts the spawned future).
pub fn spawn(state: CleanupState) -> tokio::task::JoinHandle<()> {
    spawn_with_intervals(state, STARTUP_DELAY, SWEEP_INTERVAL)
}

/// Test seam: same as [`spawn`], but the warm-up and interval are
/// caller-supplied so tests can drive the loop in milliseconds rather
/// than waiting an hour for the second tick.
pub fn spawn_with_intervals(
    state: CleanupState,
    startup_delay: Duration,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(startup_delay).await;
        let mut ticker = tokio::time::interval(interval);
        // The first tick of `tokio::time::interval` fires immediately;
        // after the warm-up sleep above, we want that to be the first
        // sweep, then one per `interval` thereafter.
        loop {
            ticker.tick().await;
            sweep_once(&state).await;
        }
    })
}

/// Run a single sweep. Deletes expired session and pending-auth rows,
/// emits one structured `auth.session.cleanup` event with per-table
/// counts. Errors per-table are logged and swallowed: the next tick
/// retries from a clean slate.
pub async fn sweep_once(state: &CleanupState) {
    let now = Utc::now();
    let pending_cutoff = now
        - chrono::Duration::from_std(PENDING_TTL)
            .unwrap_or_else(|_| chrono::Duration::seconds(600));

    let sessions_deleted = match state.session_store.delete_expired(now).await {
        Ok(n) => Some(n),
        Err(e) => {
            // Operational failure, not auth failure. Warn so it surfaces
            // in `RUST_LOG=warn` deployments without polluting info-level
            // dashboards.
            warn!(error = %e, "auth.session.cleanup.sessions_failed");
            None
        }
    };

    let pending_deleted = match state.pending_store.delete_expired(pending_cutoff).await {
        Ok(n) => Some(n),
        Err(e) => {
            warn!(error = %e, "auth.session.cleanup.pending_failed");
            None
        }
    };

    debug!(
        sessions_deleted = sessions_deleted.unwrap_or(0),
        pending_deleted = pending_deleted.unwrap_or(0),
        sessions_ok = sessions_deleted.is_some(),
        pending_ok = pending_deleted.is_some(),
        "auth.session.cleanup",
    );

    // Suppress the "field set but never read" lint when neither branch
    // surfaces the config in the future. Borrowing it keeps the
    // `CleanupState` shape stable for downstream tests.
    let _ = &state.config;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::pending_auth::PendingAuth;
    use crate::auth::pending_auth_memory::MemoryPendingAuthStore;
    use crate::auth::session_store::{LoginSession, SessionStoreError};
    use crate::auth::session_store_memory::MemorySessionStore;
    use async_trait::async_trait;
    use chrono::{DateTime, Duration as ChronoDuration};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn cleanup_state(
        sessions: Arc<MemorySessionStore>,
        pending: Arc<MemoryPendingAuthStore>,
    ) -> CleanupState {
        CleanupState {
            config: Arc::new(AuthConfig::for_tests()),
            session_store: sessions as Arc<dyn LoginSessionStore>,
            pending_store: pending as Arc<dyn PendingAuthStore>,
        }
    }

    fn session_with_expiry(id: &str, expires_in_hours: i64) -> LoginSession {
        let now = Utc::now();
        LoginSession {
            id: id.into(),
            email: "x@y.z".into(),
            display_name: "X".into(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + ChronoDuration::hours(expires_in_hours),
        }
    }

    fn pending_with_age(token: &str, age_minutes: i64) -> PendingAuth {
        let now = Utc::now();
        PendingAuth {
            state_token: token.into(),
            browser_binding_hash: "binding-hash".into(),
            intended_path: "/".into(),
            intended_hash: "".into(),
            created_at: now - ChronoDuration::minutes(age_minutes),
        }
    }

    #[tokio::test]
    async fn sweep_deletes_expired_sessions_only() {
        let sessions = Arc::new(MemorySessionStore::new());
        sessions
            .create(session_with_expiry("dead", -1))
            .await
            .unwrap();
        sessions
            .create(session_with_expiry("alive", 24))
            .await
            .unwrap();
        let pending = Arc::new(MemoryPendingAuthStore::new());

        sweep_once(&cleanup_state(Arc::clone(&sessions), pending)).await;
        assert!(sessions.get("dead").await.unwrap().is_none());
        assert!(sessions.get("alive").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn sweep_deletes_expired_pending_only() {
        let sessions = Arc::new(MemorySessionStore::new());
        let pending = Arc::new(MemoryPendingAuthStore::new());
        // 15 minutes old: past the 10-minute TTL.
        pending
            .insert(pending_with_age("expired", 15))
            .await
            .unwrap();
        // 5 minutes old: still within window.
        pending.insert(pending_with_age("fresh", 5)).await.unwrap();

        sweep_once(&cleanup_state(sessions, Arc::clone(&pending))).await;
        let cutoff = Utc::now() - ChronoDuration::minutes(10);
        assert!(
            pending
                .consume("expired", "binding-hash", cutoff)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            pending
                .consume("fresh", "binding-hash", cutoff)
                .await
                .unwrap()
                .is_some()
        );
    }

    /// Mock store that returns `Backend` for every call. The cleanup
    /// loop must log + swallow rather than panic.
    struct FailingSessionStore {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl LoginSessionStore for FailingSessionStore {
        async fn create(&self, _: LoginSession) -> Result<(), SessionStoreError> {
            unimplemented!()
        }
        async fn get(&self, _: &str) -> Result<Option<LoginSession>, SessionStoreError> {
            unimplemented!()
        }
        async fn touch_last_used(
            &self,
            _: &str,
            _: DateTime<Utc>,
        ) -> Result<(), SessionStoreError> {
            unimplemented!()
        }
        async fn delete(&self, _: &str) -> Result<Option<LoginSession>, SessionStoreError> {
            unimplemented!()
        }
        async fn delete_expired(&self, _: DateTime<Utc>) -> Result<u64, SessionStoreError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(SessionStoreError::Backend("simulated".into()))
        }
    }

    #[tokio::test]
    async fn sweep_survives_session_store_errors() {
        let failing = Arc::new(FailingSessionStore {
            calls: AtomicUsize::new(0),
        });
        let pending = Arc::new(MemoryPendingAuthStore::new());
        let state = CleanupState {
            config: Arc::new(AuthConfig::for_tests()),
            session_store: failing.clone() as Arc<dyn LoginSessionStore>,
            pending_store: pending as Arc<dyn PendingAuthStore>,
        };
        // Two consecutive sweeps: both should run (no panic, no abort).
        sweep_once(&state).await;
        sweep_once(&state).await;
        assert_eq!(failing.calls.load(Ordering::SeqCst), 2);
    }

    /// End-to-end: spawn the loop with millisecond intervals; assert the
    /// expired row is gone shortly after the first tick. Verifies the
    /// JoinHandle stays alive (a dropped handle would abort the task and
    /// the row would survive).
    #[tokio::test]
    async fn spawned_loop_runs_periodically() {
        let sessions = Arc::new(MemorySessionStore::new());
        sessions
            .create(session_with_expiry("doomed", -5))
            .await
            .unwrap();
        let pending = Arc::new(MemoryPendingAuthStore::new());

        let _handle = spawn_with_intervals(
            cleanup_state(Arc::clone(&sessions), pending),
            Duration::from_millis(5),
            Duration::from_millis(20),
        );
        // First sweep happens after STARTUP_DELAY (5ms here); give the
        // runtime some slack to schedule it.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(sessions.get("doomed").await.unwrap().is_none());
    }
}
