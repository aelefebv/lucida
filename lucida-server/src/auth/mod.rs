//! Authentication subsystem.
//!
//! Module map (slice 4 lands the OAuth flow on top of slice 2's
//! cookies + sessions and slice 3's logout; full setup per PRD #455
//! §"Crates and modules"):
//!
//! - `config` — runtime knobs read from env at boot (cookie name,
//!   timeouts, db path, secure-cookie mode, auth mode + Google
//!   credentials).
//! - `cookie` — cookie reading + Set-Cookie building. One source of
//!   truth for the `lucida_session` cookie's attribute set.
//! - `session_store` — `LoginSessionStore` trait + the row type.
//! - `session_store_sqlite` — production `SqliteSessionStore` backed by
//!   `sqlx`. Runs migrations from `migrations/` on open.
//! - `session_store_memory` — `MemorySessionStore` for tests.
//! - `pending_auth` / `pending_auth_sqlite` / `pending_auth_memory` —
//!   one-shot OAuth-intent rows: state token → intended path/hash.
//! - `google_oauth` — Google integration: authorization URL, code
//!   exchange, JWKS cache + refresh, JWT validation. The deepest piece.
//! - `principal` — `PrincipalExtractor` trait, the production
//!   `SessionCookieExtractor` (slice 2), the slice-4
//!   `GoogleJwtPrincipalExtractor`, and the
//!   `principal_from_claims` adapter the callback handler uses.
//! - `middleware` — axum middleware that runs the extractor and
//!   attaches the resulting principal to request extensions.
//! - `handlers` — `/auth/whoami`, `/auth/logout` (slice 3),
//!   `/auth/start` and `/auth/callback` (slice 4), `/auth/error`
//!   (slice 5), and the dev-only `/auth/dev/login`.
//! - `unauth_landing` — small inline HTML the middleware serves on an
//!   unauth HTML navigation; carries the JS shim that captures
//!   `location.hash` before redirecting to `/auth/start`.
//! - `error_page` — slice 5's `/auth/error` server-rendered page;
//!   user-facing destination after callback rejections (hd mismatch,
//!   unverified email, generic auth failure).
//! - `extractors` — slice 6's `AdminRequired` axum extractor: pulls
//!   the principal out of extensions and 403s on `!is_admin`. Handlers
//!   wear it declaratively rather than hand-rolling the gate.
//! - `cleanup` — slice 8's hourly background sweep that drops expired
//!   `login_sessions` and `pending_auth` rows so storage growth stays
//!   bounded over the life of a long-running deployment.

#[cfg(test)]
mod audit_event_tests;
pub mod cleanup;
pub mod config;
pub mod cookie;
pub mod error_page;
pub mod extractors;
pub mod google_oauth;
pub mod handlers;
pub mod middleware;
pub mod pending_auth;
pub mod pending_auth_memory;
pub mod pending_auth_sqlite;
pub mod principal;
pub mod session_store;
pub mod session_store_memory;
pub mod session_store_sqlite;
pub mod unauth_landing;

pub use cleanup::{spawn as spawn_cleanup, CleanupState};
pub use config::{AuthConfig, AuthConfigError, AuthMode, GoogleOAuthConfig};
pub use extractors::AdminRequired;
pub use google_oauth::{GoogleOAuthClient, OAuthError, VerifiedClaims};
pub use pending_auth::{PendingAuth, PendingAuthStore, PendingAuthStoreError};
pub use pending_auth_memory::MemoryPendingAuthStore;
pub use pending_auth_sqlite::SqlitePendingAuthStore;
pub use principal::{
    principal_from_claims, principal_or_rejection_from_claims, AuthError,
    GoogleJwtPrincipalExtractor, PrincipalExtractor, RejectionReason, SessionCookieExtractor,
};
pub use session_store::{LoginSession, LoginSessionStore, SessionStoreError};
pub use session_store_memory::MemorySessionStore;
pub use session_store_sqlite::{SqliteSessionStore, StoreOpenError};

/// Returns true if this binary should expose the dev-only auth surface
/// (currently `POST /auth/dev/login`).
///
/// Slice 2 gated on `cfg!(debug_assertions)` because `AuthMode::Disabled`
/// hadn't been validated yet. Slice 8 (per slice 7's hand-off note now
/// that mode is first-class) gates on `mode == AuthMode::Disabled`
/// instead: the dev-login route only lands when auth is intentionally
/// off (loopback default + auto-detect, or explicit `LUCIDA_AUTH=disabled`).
/// A release build running with auth disabled still gets the dev shortcut;
/// a debug build configured for Google OAuth doesn't expose it.
pub fn is_dev_mode(config: &config::AuthConfig) -> bool {
    matches!(config.mode, config::AuthMode::Disabled)
}
