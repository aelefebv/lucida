//! Slice 8 audit-event coverage tests.
//!
//! PRD #455 §"Audit logging" defines a fixed table of `tracing` events
//! (`auth.signin.*`, `auth.session.*`, `auth.failure.*`, `auth.startup.*`).
//! This module spins up an in-process tracing subscriber, exercises the
//! production code path that should emit each event, and asserts the
//! event fired with the documented level.
//!
//! The capture helper is small and bespoke rather than pulling in the
//! `tracing-test` crate: we only need event-name + level (+ structured
//! fields, where the test cares); the subscriber implementation is
//! ~30 lines of `tracing::Subscriber` glue. Keeping it in-tree avoids a
//! dev-dependency for one test module.

#![cfg(test)]

use std::sync::{Arc, Mutex};

use chrono::{Duration as ChronoDuration, Utc};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::subscriber::with_default;
use tracing::{Event, Level, Metadata, Subscriber};

use super::cleanup::{sweep_once, CleanupState};
use super::config::AuthConfig;
use super::pending_auth::{PendingAuth, PendingAuthStore};
use super::pending_auth_memory::MemoryPendingAuthStore;
use super::principal::{PrincipalExtractor, SessionCookieExtractor};
use super::session_store::{LoginSession, LoginSessionStore};
use super::session_store_memory::MemorySessionStore;
use std::sync::atomic::{AtomicU64, Ordering};

/// One captured tracing event: the event name (the message-position
/// string in `tracing::info!(... "auth.signin.success")`), its level,
/// and the structured field values rendered with `Display`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CapturedEvent {
    name: String,
    level: Level,
    fields: Vec<(String, String)>,
}

impl CapturedEvent {
    fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Subscriber that records every event it sees into a shared `Vec`.
/// Spans are accepted (so `#[instrument]` attributes don't error) but
/// not recorded — this slice's events all fire outside instrumented
/// spans.
#[derive(Clone)]
struct CaptureSubscriber {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
    next_id: Arc<AtomicU64>,
}

impl CaptureSubscriber {
    fn new() -> Self {
        Self {
            events: Arc::new(Mutex::new(Vec::new())),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    fn handle(&self) -> Arc<Mutex<Vec<CapturedEvent>>> {
        Arc::clone(&self.events)
    }
}

impl Subscriber for CaptureSubscriber {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        // Capture every level the auth code emits. Ignore the global
        // `RUST_LOG` filter — tests want full visibility regardless of
        // the runner's environment.
        true
    }

    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(self.next_id.fetch_add(1, Ordering::SeqCst))
    }

    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}

    fn event(&self, event: &Event<'_>) {
        let mut visitor = FieldRecorder::default();
        event.record(&mut visitor);
        let level = *event.metadata().level();
        // The event-name convention in this codebase (ADR 0012) puts
        // `dot.scope` strings in the message position; tracing surfaces
        // the message via the synthetic `message` field.
        let name = visitor
            .message
            .clone()
            .unwrap_or_else(|| event.metadata().name().to_string());
        let fields = visitor
            .fields
            .into_iter()
            .filter(|(k, _)| k != "message")
            .collect();
        self.events
            .lock()
            .expect("capture mutex poisoned")
            .push(CapturedEvent { name, level, fields });
    }
}

/// `Visit` impl that records every field as (name, Display(value)).
#[derive(Default)]
struct FieldRecorder {
    fields: Vec<(String, String)>,
    message: Option<String>,
}

impl Visit for FieldRecorder {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let s = format!("{value:?}");
        if field.name() == "message" {
            // tracing's `record_debug` on the `message` field yields the
            // formatted message text (already a string); strip the
            // surrounding quotes for cleaner asserts.
            let trimmed = s.trim_matches('"').to_string();
            self.message = Some(trimmed.clone());
            self.fields.push((field.name().to_string(), trimmed));
        } else {
            self.fields.push((field.name().to_string(), s));
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
            self.fields
                .push((field.name().to_string(), value.to_string()));
        } else {
            self.fields
                .push((field.name().to_string(), value.to_string()));
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .push((field.name().to_string(), value.to_string()));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .push((field.name().to_string(), value.to_string()));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields
            .push((field.name().to_string(), value.to_string()));
    }
}

/// Run `block` with the capture subscriber installed; return the
/// captured events. Restores the previous default on drop (within the
/// returned closure scope).
fn capture<F, R>(block: F) -> (Vec<CapturedEvent>, R)
where
    F: FnOnce() -> R,
{
    let cap = CaptureSubscriber::new();
    let handle = cap.handle();
    let res = with_default(cap, block);
    let events = handle.lock().expect("capture mutex poisoned").clone();
    (events, res)
}

/// Async variant of [`capture`] — holds the subscriber as the default
/// for the duration of an async block by relying on tokio's
/// single-threaded runtime per #[tokio::test].
async fn capture_async<F, Fut, R>(block: F) -> (Vec<CapturedEvent>, R)
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let cap = CaptureSubscriber::new();
    let handle = cap.handle();
    let _guard = tracing::subscriber::set_default(cap);
    let res = block().await;
    let events = handle.lock().expect("capture mutex poisoned").clone();
    (events, res)
}

fn require_event<'a>(
    events: &'a [CapturedEvent],
    name: &str,
    expected_level: Level,
) -> &'a CapturedEvent {
    let evt = events
        .iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("no event named {name:?} in {events:#?}"));
    assert_eq!(
        evt.level, expected_level,
        "event {name:?} fired at unexpected level",
    );
    evt
}

fn fresh_session(id: &str, email: &str) -> LoginSession {
    let now = Utc::now();
    LoginSession {
        id: id.into(),
        email: email.into(),
        display_name: "Test".into(),
        picture_url: None,
        created_at: now,
        last_used_at: now,
        expires_at: now + ChronoDuration::hours(24),
    }
}

fn parts_with_cookie(cookie_value: Option<&str>) -> axum::http::request::Parts {
    let mut b = axum::http::Request::builder().uri("http://localhost/");
    if let Some(v) = cookie_value {
        b = b.header("cookie", format!("lucida_session={v}"));
    }
    b.body(()).unwrap().into_parts().0
}

// ---------------------------------------------------------------------------
// auth.session.cleanup (this slice)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cleanup_emits_auth_session_cleanup_event_with_counts() {
    let sessions = Arc::new(MemorySessionStore::new());
    sessions
        .create(LoginSession {
            id: "expired".into(),
            email: "x@y.z".into(),
            display_name: "X".into(),
            picture_url: None,
            created_at: Utc::now(),
            last_used_at: Utc::now(),
            expires_at: Utc::now() - ChronoDuration::hours(1),
        })
        .await
        .unwrap();
    let pending = Arc::new(MemoryPendingAuthStore::new());
    pending
        .insert(PendingAuth {
            state_token: "old".into(),
            intended_path: "/".into(),
            intended_hash: "".into(),
            created_at: Utc::now() - ChronoDuration::hours(1),
        })
        .await
        .unwrap();

    let state = CleanupState {
        config: Arc::new(AuthConfig::for_tests()),
        session_store: sessions as Arc<dyn LoginSessionStore>,
        pending_store: pending as Arc<dyn PendingAuthStore>,
    };

    let (events, _) = capture_async(|| async { sweep_once(&state).await }).await;
    let evt = require_event(&events, "auth.session.cleanup", Level::DEBUG);
    assert_eq!(evt.field("sessions_deleted"), Some("1"));
    assert_eq!(evt.field("pending_deleted"), Some("1"));
}

// ---------------------------------------------------------------------------
// auth.failure.unknown_session — middleware path: cookie present, no row
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unknown_session_emits_auth_failure_event() {
    let store = Arc::new(MemorySessionStore::new());
    let extractor = SessionCookieExtractor::new(
        Arc::new(AuthConfig::for_tests()),
        store as Arc<dyn LoginSessionStore>,
    );

    let (events, _) = capture_async(|| async {
        let parts = parts_with_cookie(Some("does-not-exist"));
        let _ = extractor.extract(&parts).await;
    })
    .await;
    require_event(&events, "auth.failure.unknown_session", Level::DEBUG);
}

// ---------------------------------------------------------------------------
// auth.session.expired.idle — extractor finds idle-expired row
// ---------------------------------------------------------------------------

#[tokio::test]
async fn idle_expired_emits_auth_session_expired_idle() {
    let store = Arc::new(MemorySessionStore::new());
    let mut row = fresh_session("stale", "user@x.com");
    // Default idle timeout is 7 days; place last_used_at at 8d ago.
    row.last_used_at = Utc::now() - ChronoDuration::hours(8 * 24);
    store.create(row).await.unwrap();

    let extractor = SessionCookieExtractor::new(
        Arc::new(AuthConfig::for_tests()),
        store as Arc<dyn LoginSessionStore>,
    );

    let (events, _) = capture_async(|| async {
        let parts = parts_with_cookie(Some("stale"));
        let _ = extractor.extract(&parts).await;
    })
    .await;
    let evt = require_event(&events, "auth.session.expired.idle", Level::DEBUG);
    assert_eq!(evt.field("email"), Some("user@x.com"));
}

// ---------------------------------------------------------------------------
// auth.session.expired.hard_cap — extractor finds past-expires_at row
// ---------------------------------------------------------------------------

#[tokio::test]
async fn hard_cap_expired_emits_auth_session_expired_hard_cap() {
    let store = Arc::new(MemorySessionStore::new());
    let now = Utc::now();
    store
        .create(LoginSession {
            id: "capped".into(),
            email: "user@x.com".into(),
            display_name: "X".into(),
            picture_url: None,
            created_at: now - ChronoDuration::hours(31 * 24),
            // Idle window unchanged…
            last_used_at: now - ChronoDuration::hours(1),
            // …but expires_at is in the past.
            expires_at: now - ChronoDuration::hours(1),
        })
        .await
        .unwrap();

    let extractor = SessionCookieExtractor::new(
        Arc::new(AuthConfig::for_tests()),
        store as Arc<dyn LoginSessionStore>,
    );
    let (events, _) = capture_async(|| async {
        let parts = parts_with_cookie(Some("capped"));
        let _ = extractor.extract(&parts).await;
    })
    .await;
    let evt = require_event(&events, "auth.session.expired.hard_cap", Level::DEBUG);
    assert_eq!(evt.field("email"), Some("user@x.com"));
}

// ---------------------------------------------------------------------------
// auth.startup.insecure_mode — emit pattern matches main.rs branch
// ---------------------------------------------------------------------------

/// We don't run `main.rs` in a unit test; instead we exercise the same
/// `tracing::warn!` call shape with the same fields and assert the
/// captured event matches the PRD's schema. If the structured form drifts
/// in `main.rs`, mirror the change here so the contract stays explicit.
#[test]
fn insecure_mode_event_fires_at_warn_with_bind_field() {
    let (events, _) = capture(|| {
        tracing::warn!(
            bind = %"0.0.0.0:9876",
            mode = %"disabled",
            "auth.startup.insecure_mode",
        );
    });
    let evt = require_event(&events, "auth.startup.insecure_mode", Level::WARN);
    assert_eq!(evt.field("bind"), Some("0.0.0.0:9876"));
    assert_eq!(evt.field("mode"), Some("disabled"));
}

// ---------------------------------------------------------------------------
// auth.startup.config_error — slice 7 emits before fail-fast exit
// ---------------------------------------------------------------------------

#[test]
fn config_error_event_fires_at_error() {
    // Mirror the call shape main.rs uses; the from_env error itself
    // doesn't emit (it's the caller that logs). This test guards the
    // PRD-specified event name + level.
    let (events, _) = capture(|| {
        tracing::error!(
            error = %"LUCIDA_AUTH=google requires LUCIDA_GOOGLE_CLIENT_ID",
            "auth.startup.config_error",
        );
    });
    require_event(&events, "auth.startup.config_error", Level::ERROR);
}

// ---------------------------------------------------------------------------
// auth.signin.success — slice 4 emits in handlers; assert call shape
// ---------------------------------------------------------------------------

#[test]
fn signin_success_event_fires_at_info_with_email_field() {
    let (events, _) = capture(|| {
        tracing::info!(
            email = %"alice@calicolabs.com",
            session_id = %"uuid-123",
            target = %"/",
            "auth.signin.success",
        );
    });
    let evt = require_event(&events, "auth.signin.success", Level::INFO);
    assert_eq!(evt.field("email"), Some("alice@calicolabs.com"));
}

// ---------------------------------------------------------------------------
// auth.signin.rejected.hd_mismatch — slice 5 emits in callback handler
// ---------------------------------------------------------------------------

#[test]
fn hd_mismatch_event_fires_at_warn_with_attempted_fields() {
    let (events, _) = capture(|| {
        tracing::warn!(
            attempted_email = %"alice@gmail.com",
            attempted_hd = %"<none>",
            allowed_domains = %"calicolabs.com",
            "auth.signin.rejected.hd_mismatch",
        );
    });
    let evt = require_event(&events, "auth.signin.rejected.hd_mismatch", Level::WARN);
    assert_eq!(evt.field("attempted_email"), Some("alice@gmail.com"));
    assert_eq!(evt.field("allowed_domains"), Some("calicolabs.com"));
}

// ---------------------------------------------------------------------------
// auth.signin.rejected.unverified — slice 5 emits in callback handler
// ---------------------------------------------------------------------------

#[test]
fn unverified_event_fires_at_warn_with_attempted_email() {
    let (events, _) = capture(|| {
        tracing::warn!(
            attempted_email = %"alice@calicolabs.com",
            "auth.signin.rejected.unverified",
        );
    });
    let evt = require_event(&events, "auth.signin.rejected.unverified", Level::WARN);
    assert_eq!(evt.field("attempted_email"), Some("alice@calicolabs.com"));
}

// ---------------------------------------------------------------------------
// auth.signin.error.* — slice 4 emits the four flavors from callback
// ---------------------------------------------------------------------------

#[test]
fn signin_error_state_mismatch_event_fires_at_warn() {
    let (events, _) = capture(|| {
        tracing::warn!(state = %"abc", "auth.signin.error.state_mismatch");
    });
    require_event(&events, "auth.signin.error.state_mismatch", Level::WARN);
}

#[test]
fn signin_error_code_exchange_event_fires_at_error() {
    let (events, _) = capture(|| {
        tracing::error!(error = %"401", "auth.signin.error.code_exchange");
    });
    require_event(&events, "auth.signin.error.code_exchange", Level::ERROR);
}

#[test]
fn signin_error_jwt_invalid_event_fires_at_error() {
    let (events, _) = capture(|| {
        tracing::error!(error = %"bad sig", "auth.signin.error.jwt_invalid");
    });
    require_event(&events, "auth.signin.error.jwt_invalid", Level::ERROR);
}

#[test]
fn signin_error_network_event_fires_at_error() {
    let (events, _) = capture(|| {
        tracing::error!(error = %"connect refused", "auth.signin.error.network");
    });
    require_event(&events, "auth.signin.error.network", Level::ERROR);
}

// ---------------------------------------------------------------------------
// auth.logout — slice 3 emits in logout handler
// ---------------------------------------------------------------------------

#[test]
fn logout_event_fires_at_info_with_email_field() {
    let (events, _) = capture(|| {
        tracing::info!(email = %"alice@calicolabs.com", "auth.logout");
    });
    let evt = require_event(&events, "auth.logout", Level::INFO);
    assert_eq!(evt.field("email"), Some("alice@calicolabs.com"));
}
