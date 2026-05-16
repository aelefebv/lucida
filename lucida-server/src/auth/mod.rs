//! Authentication subsystem.
//!
//! Module map:
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
//! - `principal` — `PrincipalExtractor` trait plus the three
//!   implementations: `SessionCookieExtractor` (Google-mode cookie
//!   path), `GoogleJwtPrincipalExtractor` (Bearer-token validator),
//!   and `StubPrincipalExtractor` (disabled-mode canned principal).
//!   Also `principal_from_claims`, the adapter the callback uses.
//! - `middleware` — axum middleware that runs the extractor and
//!   attaches the resulting principal to request extensions.
//!   `build_extractor` picks between the three implementations based
//!   on `AuthMode`.
//! - `handlers` — `/auth/whoami`, `/auth/logout`, `/auth/start`,
//!   `/auth/callback`, and `/auth/error`.
//! - `unauth_landing` — small inline HTML the middleware serves on an
//!   unauth HTML navigation; carries the JS shim that captures
//!   `location.hash` before redirecting to `/auth/start`.
//! - `error_page` — `/auth/error` server-rendered page; user-facing
//!   destination after callback rejections (hd mismatch, unverified
//!   email, generic auth failure).
//! - `extractors` — `AdminRequired` axum extractor: pulls the
//!   principal out of extensions and 403s on `!is_admin`. Handlers
//!   wear it declaratively rather than hand-rolling the gate.
//! - `cleanup` — hourly background sweep that drops expired
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

pub use cleanup::{CleanupState, spawn as spawn_cleanup};
pub use config::{AuthConfig, AuthConfigError, AuthMode, GoogleOAuthConfig};
pub use extractors::AdminRequired;
pub use google_oauth::{GoogleOAuthClient, OAuthError, VerifiedClaims};
pub use pending_auth::{PendingAuth, PendingAuthStore, PendingAuthStoreError};
pub use pending_auth_memory::MemoryPendingAuthStore;
pub use pending_auth_sqlite::SqlitePendingAuthStore;
pub use principal::{
    AuthError, GoogleJwtPrincipalExtractor, PrincipalExtractor, RejectionReason,
    SessionCookieExtractor, StubPrincipalExtractor, principal_from_claims,
    principal_or_rejection_from_claims,
};
pub use session_store::{LoginSession, LoginSessionStore, SessionStoreError};
pub use session_store_memory::MemorySessionStore;
pub use session_store_sqlite::{SqliteSessionStore, StoreOpenError};
