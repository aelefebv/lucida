//! `PendingAuthStore` trait + the row type it returns.
//!
//! Backs the in-flight OAuth intent table. The trait mirrors the shape
//! of `LoginSessionStore` so the OAuth handlers can hold
//! `Arc<dyn PendingAuthStore>` and tests can swap an
//! `Arc<MemoryPendingAuthStore>` in without re-implementing surface.
//!
//! The single-use `consume` method is the load-bearing operation: it
//! atomically returns the captured intent and deletes the row, so a
//! replayed `state` token can't ride to the same landing twice.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use thiserror::Error;

/// One row in `pending_auth`. The state token is opaque (256-bit
/// random, base64url-encoded) and used only as a primary key — the
/// client never sees it parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingAuth {
    pub state_token: String,
    pub intended_path: String,
    pub intended_hash: String,
    pub created_at: DateTime<Utc>,
}

/// Storage-layer errors. Same structure as `SessionStoreError`; the
/// distinction between "row not found" (`Ok(None)`) and "backend
/// failed" (this enum) is preserved.
#[derive(Debug, Error)]
pub enum PendingAuthStoreError {
    #[error("storage backend error: {0}")]
    Backend(String),
}

/// Trait implemented by every storage backend. Object-safe.
#[async_trait]
pub trait PendingAuthStore: Send + Sync + 'static {
    /// Insert a freshly-minted pending row. Returns an error if the
    /// state token already exists (vanishingly unlikely with 256-bit
    /// random tokens, but the SQLite UNIQUE constraint will reject it
    /// rather than silently overwrite).
    async fn insert(&self, row: PendingAuth) -> Result<(), PendingAuthStoreError>;

    /// Atomic lookup-and-delete. Returns `Ok(Some(row))` when the token
    /// existed (and is now gone) or `Ok(None)` when it didn't. The
    /// callback handler uses the second arm to emit
    /// `auth.signin.error.state_mismatch` and 400 the request.
    ///
    /// Implementations MUST be atomic: a concurrent `consume` of the
    /// same token from two callers MUST return `Some` to exactly one of
    /// them. SQLite's `DELETE … RETURNING` (or the read+delete pair
    /// inside a transaction) provides this; the in-memory implementation
    /// holds the mutex across the operation.
    async fn consume(
        &self,
        state_token: &str,
    ) -> Result<Option<PendingAuth>, PendingAuthStoreError>;

    /// Bulk-delete every row whose `created_at` is `< older_than`.
    /// Returns the number of rows deleted. Called from the periodic
    /// cleanup sweep.
    async fn delete_expired(&self, older_than: DateTime<Utc>)
    -> Result<u64, PendingAuthStoreError>;
}
