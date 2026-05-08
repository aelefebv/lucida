//! Authentication subsystem.
//!
//! Module map (slice 2 lands cookies + sessions; OAuth handlers and
//! audit logging arrive in later slices per PRD #455 §"Crates and
//! modules"):
//!
//! - `config` — runtime knobs read from env at boot (cookie name,
//!   timeouts, db path, secure-cookie mode).
//! - `cookie` — cookie reading + Set-Cookie building. One source of
//!   truth for the `lucida_session` cookie's attribute set.
//! - `session_store` — `LoginSessionStore` trait + the row type.
//! - `session_store_sqlite` — production `SqliteSessionStore` backed by
//!   `sqlx`. Runs migrations from `migrations/` on open.
//! - `session_store_memory` — `MemorySessionStore` for tests.
//! - `principal` — `PrincipalExtractor` trait + production
//!   `SessionCookieExtractor`. Slice 1's `StubPrincipalExtractor` is
//!   retired in this slice.
//! - `middleware` — axum middleware that runs the extractor and
//!   attaches the resulting principal to request extensions.
//! - `handlers` — `/auth/whoami` and the dev-only
//!   `/auth/dev/login`. The OAuth-flow endpoints (`/auth/start`,
//!   `/auth/callback`, `/auth/logout`, `/auth/error`) land in later
//!   slices.

pub mod config;
pub mod cookie;
pub mod handlers;
pub mod middleware;
pub mod principal;
pub mod session_store;
pub mod session_store_memory;
pub mod session_store_sqlite;

pub use config::AuthConfig;
pub use principal::{AuthError, PrincipalExtractor, SessionCookieExtractor};
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
