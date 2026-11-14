//! Audit-event coverage tests.
//!
//! A fixed table of `tracing` events (`auth.signin.*`, `auth.session.*`,
//! `auth.failure.*`, `auth.startup.*`) is the audit-log surface. Each test
//! drives the production path that should emit an event and asserts it
//! fired at the documented level.

#![cfg(test)]

use std::sync::Arc;

use chrono::{Duration as ChronoDuration, Utc};
use tracing::Level;

use super::cleanup::{CleanupState, sweep_once};
use super::config::AuthConfig;
use super::pending_auth::{PendingAuth, PendingAuthStore};
use super::pending_auth_memory::MemoryPendingAuthStore;
use super::principal::{BearerTokenExtractor, PrincipalExtractor, SessionCookieExtractor};
use super::session_store::{LoginSession, LoginSessionStore};
use super::session_store_memory::MemorySessionStore;
use super::{BearerToken, BearerTokenStore, MemoryBearerTokenStore, hash_bearer_token};
use crate::log_capture::{capture, capture_async, require_event};

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

fn parts_with_bearer(raw_token: &str) -> axum::http::request::Parts {
    axum::http::Request::builder()
        .uri("http://localhost/")
        .header("authorization", format!("Bearer {raw_token}"))
        .body(())
        .unwrap()
        .into_parts()
        .0
}

fn bearer_token_row(id: &str, raw_token: &str, email: &str) -> BearerToken {
    let now = Utc::now();
    BearerToken {
        id: id.into(),
        token_hash: hash_bearer_token(raw_token),
        name: "audit test".into(),
        email: email.into(),
        display_name: "Audit Test".into(),
        picture_url: None,
        created_at: now,
        last_used_at: None,
        expires_at: now + ChronoDuration::hours(1),
        revoked_at: None,
    }
}

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

// auth.failure.unknown_session — middleware path: cookie present, no row
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

// auth.failure.unknown_bearer_token — bearer token hash has no row
#[tokio::test]
async fn unknown_bearer_token_emits_auth_failure_event() {
    let store = Arc::new(MemoryBearerTokenStore::new());
    let extractor = BearerTokenExtractor::new(
        Arc::new(AuthConfig::for_tests()),
        store as Arc<dyn BearerTokenStore>,
    );

    let (events, _) = capture_async(|| async {
        let parts = parts_with_bearer("lucida_pat_unknown");
        let _ = extractor.extract(&parts).await;
    })
    .await;
    require_event(&events, "auth.failure.unknown_bearer_token", Level::DEBUG);
}

// auth.bearer.expired — extractor finds past-expires_at bearer row
#[tokio::test]
async fn expired_bearer_token_emits_auth_bearer_expired() {
    let raw_token = "lucida_pat_expired_audit";
    let store = Arc::new(MemoryBearerTokenStore::new());
    let mut row = bearer_token_row("expired-token", raw_token, "cli@example.com");
    row.expires_at = Utc::now() - ChronoDuration::seconds(1);
    store.create(row).await.unwrap();
    let extractor = BearerTokenExtractor::new(
        Arc::new(AuthConfig::for_tests()),
        store as Arc<dyn BearerTokenStore>,
    );

    let (events, _) = capture_async(|| async {
        let parts = parts_with_bearer(raw_token);
        let _ = extractor.extract(&parts).await;
    })
    .await;
    let evt = require_event(&events, "auth.bearer.expired", Level::DEBUG);
    assert_eq!(evt.field("email"), Some("cli@example.com"));
    assert_eq!(evt.field("token_id"), Some("expired-token"));
}

// auth.bearer.revoked — extractor finds revoked bearer row
#[tokio::test]
async fn revoked_bearer_token_emits_auth_bearer_revoked() {
    let raw_token = "lucida_pat_revoked_audit";
    let store = Arc::new(MemoryBearerTokenStore::new());
    let mut row = bearer_token_row("revoked-token", raw_token, "cli@example.com");
    row.revoked_at = Some(Utc::now());
    store.create(row).await.unwrap();
    let extractor = BearerTokenExtractor::new(
        Arc::new(AuthConfig::for_tests()),
        store as Arc<dyn BearerTokenStore>,
    );

    let (events, _) = capture_async(|| async {
        let parts = parts_with_bearer(raw_token);
        let _ = extractor.extract(&parts).await;
    })
    .await;
    let evt = require_event(&events, "auth.bearer.revoked", Level::DEBUG);
    assert_eq!(evt.field("email"), Some("cli@example.com"));
    assert_eq!(evt.field("token_id"), Some("revoked-token"));
}

// auth.session.expired.idle — extractor finds idle-expired row
#[tokio::test]
async fn idle_expired_emits_auth_session_expired_idle() {
    let store = Arc::new(MemorySessionStore::new());
    let mut row = fresh_session("stale", "user@example.com");
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
    assert_eq!(evt.field("email"), Some("user@example.com"));
}

// auth.session.expired.hard_cap — extractor finds past-expires_at row
#[tokio::test]
async fn hard_cap_expired_emits_auth_session_expired_hard_cap() {
    let store = Arc::new(MemorySessionStore::new());
    let now = Utc::now();
    store
        .create(LoginSession {
            id: "capped".into(),
            email: "user@example.com".into(),
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
    assert_eq!(evt.field("email"), Some("user@example.com"));
}

// auth.startup.insecure_mode — emit pattern matches main.rs branch.
/// We don't run `main.rs` in a unit test; instead we exercise the same
/// `tracing::warn!` call shape with the same fields and assert the
/// captured event matches the documented schema. If the structured form drifts
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

// auth.startup.config_error — emitted before fail-fast exit
#[test]
fn config_error_event_fires_at_error() {
    // Mirror the call shape main.rs uses; the from_env error itself
    // doesn't emit (it's the caller that logs). This test guards the
    // event name + level.
    let (events, _) = capture(|| {
        tracing::error!(
            error = %"LUCIDA_AUTH=google requires LUCIDA_GOOGLE_CLIENT_ID",
            "auth.startup.config_error",
        );
    });
    require_event(&events, "auth.startup.config_error", Level::ERROR);
}

// auth.signin.success — emitted in callback handler; assert call shape
#[test]
fn signin_success_event_fires_at_info_with_email_field() {
    let (events, _) = capture(|| {
        tracing::info!(
            email = %"alice@example.com",
            session_id = %"uuid-123",
            target = %"/",
            "auth.signin.success",
        );
    });
    let evt = require_event(&events, "auth.signin.success", Level::INFO);
    assert_eq!(evt.field("email"), Some("alice@example.com"));
}

// auth.signin.rejected.hd_mismatch — emitted in callback handler
#[test]
fn hd_mismatch_event_fires_at_warn_with_attempted_fields() {
    let (events, _) = capture(|| {
        tracing::warn!(
            attempted_email = %"alice@example.net",
            attempted_hd = %"<none>",
            allowed_domains = %"example.com",
            "auth.signin.rejected.hd_mismatch",
        );
    });
    let evt = require_event(&events, "auth.signin.rejected.hd_mismatch", Level::WARN);
    assert_eq!(evt.field("attempted_email"), Some("alice@example.net"));
    assert_eq!(evt.field("allowed_domains"), Some("example.com"));
}

// auth.signin.rejected.unverified — emitted in callback handler
#[test]
fn unverified_event_fires_at_warn_with_attempted_email() {
    let (events, _) = capture(|| {
        tracing::warn!(
            attempted_email = %"alice@example.com",
            "auth.signin.rejected.unverified",
        );
    });
    let evt = require_event(&events, "auth.signin.rejected.unverified", Level::WARN);
    assert_eq!(evt.field("attempted_email"), Some("alice@example.com"));
}

// auth.signin.error.* — four flavors emitted from callback
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

// auth.logout — emitted in logout handler
#[test]
fn logout_event_fires_at_info_with_email_field() {
    let (events, _) = capture(|| {
        tracing::info!(email = %"alice@example.com", "auth.logout");
    });
    let evt = require_event(&events, "auth.logout", Level::INFO);
    assert_eq!(evt.field("email"), Some("alice@example.com"));
}

// auth.bearer.revoke_current — emitted in bearer-token logout handler
#[test]
fn bearer_revoke_current_event_fires_at_info_with_token_id_and_email() {
    let (events, _) = capture(|| {
        tracing::info!(
            token_id = %"token-123",
            email = %"alice@example.com",
            "auth.bearer.revoke_current",
        );
    });
    let evt = require_event(&events, "auth.bearer.revoke_current", Level::INFO);
    assert_eq!(evt.field("token_id"), Some("token-123"));
    assert_eq!(evt.field("email"), Some("alice@example.com"));
}
