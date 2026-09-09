//! The `InboxStore` trait and the records it hands out.
//!
//! The trait is the seam between the socket handler that receives a
//! **Send report** and the database the bundle lands in. The
//! implementations are siblings, one module each: [`store_sqlite`] and
//! [`store_postgres`], running the statements in [`store_sql`] rather
//! than each holding a copy.
//!
//! Three things about the shape here are deliberate.
//!
//! **The payload travels as text.** A bundle is JSON the page produced,
//! and what the CLI fetches has to be what was sent, so nothing between
//! the socket and the column re-serialises it. The header rides beside
//! it as its own text, read out once at the write so a listing never
//! touches the megabytes.
//!
//! **The caller owns the clock.** `sent_at` and `expires_at` are
//! arguments, and every read takes the `now` it should judge expiry
//! against. Retention is then a policy of the caller ([`RETENTION_DAYS`])
//! rather than something the store decides, and a test can put an entry
//! past its expiry without waiting a fortnight.
//!
//! **A read is scoped to one workspace.** Not because a caller would
//! otherwise pass the wrong id, but because an entry id is the only
//! thing a fetch carries, and a store that answered on the id alone
//! would hand one workspace's field report to another.
//!
//! [`store_sqlite`]: super::store_sqlite
//! [`store_postgres`]: super::store_postgres
//! [`store_sql`]: super::store_sql
//! [`RETENTION_DAYS`]: super::RETENTION_DAYS

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use thiserror::Error;

/// One entry in a workspace inbox, without the bundle it holds.
///
/// What a listing shows, and what a fetch carries beside the bundle. The
/// header is the JSON text the page wrote, passed through rather than
/// re-serialised, so a reader sees the fields in the order the page
/// produced them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxEntry {
    pub id: String,
    pub workspace_id: String,
    /// The email of whoever pressed **Send report**.
    pub sent_by: String,
    /// How to show them, from the same principal. May be empty.
    pub sent_by_name: String,
    pub sent_at: DateTime<Utc>,
    /// When the fixed retention drops this entry. A read past it finds
    /// nothing, whether or not a sweep has run.
    pub expires_at: DateTime<Utc>,
    /// How many bytes the bundle is, so a listing can say what a fetch
    /// will cost without reading one.
    pub size_bytes: i64,
    /// The bundle's `header` section, verbatim.
    pub header_json: String,
}

/// An entry and the bundle it holds: the bytes the page sent, unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxBundle {
    pub entry: InboxEntry,
    pub bundle_json: String,
}

/// What a **Send report** hands the store. The id is the store's to mint;
/// everything else is settled before the write, including both instants.
#[derive(Debug, Clone, Copy)]
pub struct NewInboxEntry<'a> {
    pub workspace_id: &'a str,
    pub sent_by: &'a str,
    pub sent_by_name: &'a str,
    pub sent_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub header_json: &'a str,
    pub bundle_json: &'a str,
}

/// Storage-layer errors. One variant: everything that can go wrong at
/// this layer is the database failing, because the payload was parsed
/// and measured before it got here.
#[derive(Debug, Error)]
pub enum StoreError {
    #[error("storage backend error: {0}")]
    Backend(String),
}

/// Trait every backend implements. `'static` + `Send + Sync` so callers
/// can hold `Arc<dyn InboxStore>`.
#[async_trait]
pub trait InboxStore: Send + Sync + 'static {
    /// Store one bundle and hand back the entry it landed in, whose id
    /// is what the sender is told and what a fetch takes.
    ///
    /// The write also sweeps entries already past their expiry, wherever
    /// they are. A send is the only event that grows this table, so
    /// sweeping there bounds it without a background task, and the sweep
    /// is a delete over an index rather than a scan.
    async fn put(&self, entry: NewInboxEntry<'_>) -> Result<InboxEntry, StoreError>;

    /// One workspace's unexpired entries, newest first, without their
    /// bundles.
    async fn list(
        &self,
        workspace_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Vec<InboxEntry>, StoreError>;

    /// One unexpired entry and its bundle. `Ok(None)` when no such entry
    /// is in this workspace, which is the same answer an expired one
    /// gets: a reader learns that there is nothing to fetch, not what
    /// used to be there.
    async fn fetch(
        &self,
        workspace_id: &str,
        entry_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<InboxBundle>, StoreError>;

    /// Delete every entry that expired at or before `now`, and say how
    /// many went. Called by [`put`](Self::put); exposed so a caller with
    /// its own schedule, or a test, can run it alone.
    async fn delete_expired(&self, now: DateTime<Utc>) -> Result<u64, StoreError>;
}
