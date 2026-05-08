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
//!   `/auth/start` and `/auth/callback` (slice 4), and the dev-only
//!   `/auth/dev/login`. `/auth/error` lands in slice 5.
//! - `unauth_landing` — small inline HTML the middleware serves on an
//!   unauth HTML navigation; carries the JS shim that captures
//!   `location.hash` before redirecting to `/auth/start`.

pub mod config;
pub mod cookie;
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

pub use config::{AuthConfig, AuthConfigError, AuthMode, GoogleOAuthConfig};
pub use google_oauth::{GoogleOAuthClient, OAuthError, VerifiedClaims};
pub use pending_auth::{PendingAuth, PendingAuthStore, PendingAuthStoreError};
pub use pending_auth_memory::MemoryPendingAuthStore;
pub use pending_auth_sqlite::SqlitePendingAuthStore;
pub use principal::{
    principal_from_claims, AuthError, GoogleJwtPrincipalExtractor, PrincipalExtractor,
    SessionCookieExtractor,
};
pub use session_store::{LoginSession, LoginSessionStore, SessionStoreError};
pub use session_store_memory::MemorySessionStore;
pub use session_store_sqlite::{SqliteSessionStore, StoreOpenError};

/// Returns true if this binary should expose the dev-only auth surface
/// (currently `POST /auth/dev/login`). Slice 2 gates on
/// `cfg!(debug_assertions)` per PRD #455 §"Important design notes" —
/// the full LUCIDA_AUTH=disabled vs google selection lands in slice 7.
pub fn is_dev_mode() -> bool {
    cfg!(debug_assertions)
}
