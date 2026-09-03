//! The `BookmarkStore` trait, and the record it hands out.
//!
//! The trait is the seam between handlers and storage. Handlers hold
//! `Arc<dyn BookmarkStore>` so the same wiring can swap between the
//! SQL-backed production stores and the in-memory test store without
//! changing call sites.
//!
//! The implementations are siblings, one module each: [`store_sqlite`],
//! [`store_postgres`], and [`store_memory`]. The two SQL ones run the
//! statements in [`store_sql`] rather than each holding a copy.
//!
//! The production schema lives in the baseline migration. Two tables:
//!
//! - `bookmarks` — one row per bookmark, with the serialized `SavedView`
//!   in `view_json`.
//! - `bookmark_datasets` — side table mapping `(bookmark_id, dataset_url)`,
//!   indexed on `dataset_url` to power the any-overlap SELECT the sidebar
//!   runs. Each SQL store reads its own query plan in tests so the index
//!   isn't silently dropped from the migration.
//!
//! Create is transactional across the two tables. Delete touches only
//! `bookmarks`; the attachments go with it through the schema's cascade.
//!
//! [`store_sqlite`]: super::store_sqlite
//! [`store_postgres`]: super::store_postgres
//! [`store_memory`]: super::store_memory
//! [`store_sql`]: super::store_sql

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use lucida_core::saved_view::SavedView;

/// One bookmark row, with the side-table dataset URLs gathered up so
/// callers don't have to issue a second query.
///
/// `view` is deserialized from `view_json` on read. The wire format is
/// the same one the URL-hash side of the saved-views feature emits, so
/// a bookmark created via `POST /api/bookmarks` round-trips through
/// the same apply-orchestrator the `#b=<id>` link uses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
    pub datasets: Vec<String>,
    pub view: SavedView,
}

/// Storage-layer errors. Same shape as the auth stores: `Backend` for
/// IO/SQL failures, `InvalidView` for the (handler-mediated) JSON
/// reserialization that runs on read. Handlers map both to 500.
#[derive(Debug, Error)]
pub enum StoreError {
    #[error("storage backend error: {0}")]
    Backend(String),
    /// `view_json` failed to deserialize back into a `SavedView`. Either
    /// schema drift between writer and reader or on-disk corruption.
    #[error("stored view payload no longer parses: {0}")]
    InvalidView(String),
}

/// Trait every backend implements. `'static` + `Send + Sync` so handlers
/// can hold `Arc<dyn BookmarkStore>` without lifetime gymnastics.
///
/// Methods follow the same shape as the auth `LoginSessionStore`:
/// `Ok(None)` for "not found" on lookups, `Ok(false)` for "nothing to
/// delete," structured `StoreError` for storage hiccups.
#[async_trait]
pub trait BookmarkStore: Send + Sync + 'static {
    /// Insert a new bookmark. The store mints the UUID v4 id and the
    /// `created_at` timestamp; the caller passes everything else. Both
    /// tables are written in a single transaction so partial writes
    /// can't surface a row without its dataset URLs.
    async fn create(
        &self,
        name: &str,
        created_by: &str,
        created_by_name: &str,
        datasets: Vec<String>,
        view: SavedView,
    ) -> Result<Bookmark, StoreError>;

    async fn get(&self, id: &str) -> Result<Option<Bookmark>, StoreError>;

    /// List bookmarks whose dataset set overlaps any of the supplied
    /// URLs. Empty input → return every bookmark (the sidebar's
    /// "no datasets loaded yet" cold-start case + the explicit "show
    /// me everything" toggle).
    async fn list_by_dataset_overlap(
        &self,
        dataset_urls: &[String],
    ) -> Result<Vec<Bookmark>, StoreError>;

    async fn list_all(&self) -> Result<Vec<Bookmark>, StoreError>;

    /// Update a bookmark's `name` only. Returns `Ok(None)` when the id
    /// doesn't match. Other fields (creator, datasets, view) are
    /// immutable in v1.
    async fn patch_name(&self, id: &str, new_name: &str) -> Result<Option<Bookmark>, StoreError>;

    /// Delete a bookmark and return the row that was removed. Returns
    /// `Ok(None)` when the id doesn't match. The attachments go with it.
    ///
    /// The broadcast helper needs the deleted bookmark's `dataset_urls`
    /// to scope its `BookmarkChanged { Deleted }` fanout, so returning
    /// the row from `delete` avoids a separate `get` round-trip plus
    /// the race window between the two queries.
    async fn delete(&self, id: &str) -> Result<Option<Bookmark>, StoreError>;
}

/// The dataset URLs a bookmark is attached to, deduplicated and sorted.
///
/// Attachment is a set: a caller passing `[a, a]` means one attachment,
/// and the order they were passed in carries nothing. Reads return them
/// in URL order, so creates hand back the same order rather than
/// whatever the caller supplied.
pub(super) fn attachment_set(datasets: Vec<String>) -> Vec<String> {
    datasets
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}
