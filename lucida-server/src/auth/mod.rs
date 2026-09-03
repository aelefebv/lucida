//! Authentication subsystem.
//!
//! Module map:
//!
//! - `config` — runtime knobs read from env at boot (cookie name,
//!   timeouts, database connection string, secure-cookie mode, auth
//!   mode + Google credentials).
//! - `cookie` — cookie reading + Set-Cookie building. One source of
//!   truth for the `lucida_session` cookie's attribute set.
//! - `dev` — disabled-auth identity switch cookie for local multi-user
//!   testing. Not used by Google/production auth.
//! - `session_store` — `LoginSessionStore` trait + the row type.
//! - `session_store_sqlite` — production `SqliteSessionStore` backed by
//!   `sqlx`. Connecting and migrating belong to [`crate::storage`].
//! - `session_store_memory` — `MemorySessionStore` for tests.
//! - `bearer_token` / `bearer_token_sqlite` / `bearer_token_memory` —
//!   opaque CLI/Python credentials stored as hashes and resolved to
//!   the same `AuthPrincipal` boundary as cookie sessions.
//! - `cli_authorization` / `cli_authorization_sqlite` /
//!   `cli_authorization_memory` — short-lived browser approval rows
//!   for `lucida auth login`.
//! - `pending_auth` / `pending_auth_sqlite` / `pending_auth_postgres` /
//!   `pending_auth_memory` — one-shot OAuth-intent rows: state token →
//!   intended path/hash. The PostgreSQL one is the only store with a
//!   second SQL implementation, and `pending_auth_sql` holds the
//!   statements the two run; see ADR-0058.
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
pub mod bearer_token;
pub mod bearer_token_memory;
pub mod bearer_token_sqlite;
pub mod cleanup;
pub mod cli_authorization;
pub mod cli_authorization_memory;
pub mod cli_authorization_sqlite;
pub mod config;
pub mod cookie;
pub mod dev;
pub mod error_page;
pub mod extractors;
pub mod google_oauth;
pub mod handlers;
pub mod middleware;
pub mod pending_auth;
pub mod pending_auth_memory;
pub mod pending_auth_postgres;
pub(crate) mod pending_auth_sql;
pub mod pending_auth_sqlite;
pub mod principal;
pub mod session_store;
pub mod session_store_memory;
pub mod session_store_sqlite;
pub mod unauth_landing;

pub use bearer_token::{BearerToken, BearerTokenStore, BearerTokenStoreError, hash_bearer_token};
pub use bearer_token_memory::MemoryBearerTokenStore;
pub use bearer_token_sqlite::SqliteBearerTokenStore;
pub use cleanup::{CleanupState, spawn as spawn_cleanup};
pub use cli_authorization::{
    CliTokenAuthorization, CliTokenAuthorizationStore, CliTokenAuthorizationStoreError,
};
pub use cli_authorization_memory::MemoryCliTokenAuthorizationStore;
pub use cli_authorization_sqlite::SqliteCliTokenAuthorizationStore;
pub use config::{AuthConfig, AuthConfigError, AuthMode, GoogleOAuthConfig};
pub use extractors::AdminRequired;
pub use google_oauth::{GoogleOAuthClient, OAuthError, VerifiedClaims};
pub use pending_auth::{PendingAuth, PendingAuthStore, PendingAuthStoreError};
pub use pending_auth_memory::MemoryPendingAuthStore;
pub use pending_auth_postgres::PostgresPendingAuthStore;
pub use pending_auth_sqlite::SqlitePendingAuthStore;
pub use principal::{
    AuthError, BearerTokenExtractor, DualCredentialExtractor, GoogleJwtPrincipalExtractor,
    PrincipalExtractor, RejectionReason, SessionCookieExtractor, StubPrincipalExtractor,
    principal_from_claims, principal_or_rejection_from_claims,
};
pub use session_store::{LoginSession, LoginSessionStore, SessionStoreError};
pub use session_store_memory::MemorySessionStore;
pub use session_store_sqlite::SqliteSessionStore;
