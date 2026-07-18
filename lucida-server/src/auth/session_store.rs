//! `LoginSessionStore` trait and the row type it returns.
//!
//! The trait is the seam between the cookie-based extractor (which
//! only knows how to look up by ID) and the storage layer (SQLite in
//! production, an in-memory map for unit tests). The trait is
//! `async_trait`-annotated so it's object-safe; the extractor holds
//! `Arc<dyn LoginSessionStore>`.
//!
//! See `wiki/decisions/0015-server-stored-bookmarks-and-auth-seam.md`
//! and `wiki/decisions/0016-backend-mediated-oauth-with-session-cookies.md`
//! for the architectural rationale.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use thiserror::Error;

/// One row in `login_sessions`.
///
/// `id` is the opaque session ID written to the cookie; nothing about
/// it is meaningful to the client. `created_at` and `expires_at` are
/// the hard-cap anchors; `last_used_at` is the idle-timeout anchor and
/// is bumped on every successful lookup.
///
/// `email`, `display_name`, and `picture_url` are denormalized copies
/// of the identity at session-creation time. The OAuth callback
/// populates them from Google.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginSession {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub picture_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// Storage-layer errors. The extractor maps these to `AuthError`
/// (`Internal` for storage hiccups; `Unauthenticated` for the
/// not-found case is signalled by `Ok(None)`, not via this enum).
#[derive(Debug, Error)]
pub enum SessionStoreError {
    #[error("storage backend error: {0}")]
    Backend(String),
}

/// Trait implemented by every storage backend (SQLite in production,
/// in-memory map for tests). Object-safe so the extractor can hold
/// `Arc<dyn LoginSessionStore>`.
#[async_trait]
pub trait LoginSessionStore: Send + Sync + 'static {
    /// Insert a freshly minted session. Caller has already chosen the
    /// id (UUID v4 in production); passing it in lets tests use
    /// deterministic ids when they need to.
    async fn create(&self, session: LoginSession) -> Result<(), SessionStoreError>;

    /// Look up a session by id. Returns `Ok(None)` when no row exists
    /// (the common "missing or already deleted" case); error variants
    /// signal storage failure, not absence.
    ///
    /// Note: this method does **not** enforce timeouts — the extractor
    /// applies the idle-timeout / hard-cap policy on the returned row.
    /// Keeping policy out of the store keeps the trait stable when the
    /// timeout knobs change.
    async fn get(&self, id: &str) -> Result<Option<LoginSession>, SessionStoreError>;

    /// Bump `last_used_at` to `now`. Race-and-tolerate: two parallel
    /// callers overwriting each other is harmless because the value
    /// only ever monotonically increases under normal use.
    async fn touch_last_used(&self, id: &str, now: DateTime<Utc>) -> Result<(), SessionStoreError>;

    /// Atomically remove and return a single session by id. Logout uses the
    /// returned row so local revocation targets exactly the credential whose
    /// deletion committed, rather than the result of a preceding racy lookup.
    /// Idempotent: a row that is already gone returns `Ok(None)`.
    async fn delete(&self, id: &str) -> Result<Option<LoginSession>, SessionStoreError>;

    /// Bulk-delete every session whose `expires_at` is `<= now`.
    /// Returns the number of rows deleted. Called from the periodic
    /// cleanup sweep.
    async fn delete_expired(&self, now: DateTime<Utc>) -> Result<u64, SessionStoreError>;
}
