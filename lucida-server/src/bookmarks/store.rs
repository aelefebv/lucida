//! `BookmarkStore` trait + production SQLite backend + in-memory backend
//! for tests.
//!
//! The trait is the seam between handlers and storage. Handlers hold
//! `Arc<dyn BookmarkStore>` so the same wiring can swap between the
//! SQLite-backed production store and the in-memory test store without
//! changing call sites.
//!
//! The production schema lives in
//! `migrations/20260508000003_create_bookmarks.sql`. Two tables:
//!
//! - `bookmarks` — one row per bookmark, with the serialized `SavedView`
//!   stored as a JSON string in `view_json`.
//! - `bookmark_datasets` — side table mapping `(bookmark_id, dataset_url)`,
//!   indexed on `dataset_url` to power the any-overlap SELECT the sidebar
//!   runs. `EXPLAIN QUERY PLAN` is asserted in tests so the index isn't
//!   silently dropped from the migration.
//!
//! Create / patch_name / delete are transactional across the two tables
//! (insert into both, delete cascades via the FK).

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::sync::Mutex;
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
    /// `Ok(None)` when the id doesn't match. The `bookmark_datasets`
    /// side rows are cascaded via the FK.
    ///
    /// The broadcast helper needs the deleted bookmark's `dataset_urls`
    /// to scope its `BookmarkChanged { Deleted }` fanout, so returning
    /// the row from `delete` avoids a separate `get` round-trip plus
    /// the race window between the two queries.
    async fn delete(&self, id: &str) -> Result<Option<Bookmark>, StoreError>;
}

/// Production store. Wraps the `SqlitePool` the storage backend opened,
/// so every table rides one connection budget.
#[derive(Debug, Clone)]
pub struct SqliteBookmarkStore {
    pool: SqlitePool,
}

impl SqliteBookmarkStore {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn map_sql(e: sqlx::Error) -> StoreError {
    StoreError::Backend(e.to_string())
}

fn map_json_in(e: serde_json::Error) -> StoreError {
    StoreError::InvalidView(e.to_string())
}

fn map_json_out(e: serde_json::Error) -> StoreError {
    StoreError::Backend(format!("view_json serialize: {e}"))
}

#[async_trait]
impl BookmarkStore for SqliteBookmarkStore {
    async fn create(
        &self,
        name: &str,
        created_by: &str,
        created_by_name: &str,
        datasets: Vec<String>,
        view: SavedView,
    ) -> Result<Bookmark, StoreError> {
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = Utc::now();
        let view_json = serde_json::to_string(&view).map_err(map_json_out)?;

        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        sqlx::query(
            r#"
            INSERT INTO bookmarks
                (id, name, created_by, created_by_name, created_at, view_json)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(name)
        .bind(created_by)
        .bind(created_by_name)
        .bind(created_at.to_rfc3339())
        .bind(&view_json)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        // Deduplicate the URL list before insert so a caller passing
        // `[a, a]` doesn't trip the (bookmark_id, dataset_url) PK.
        let mut seen = std::collections::HashSet::new();
        for url in &datasets {
            if seen.insert(url.as_str()) {
                sqlx::query(
                    "INSERT INTO bookmark_datasets (bookmark_id, dataset_url) VALUES (?, ?)",
                )
                .bind(&id)
                .bind(url)
                .execute(&mut *tx)
                .await
                .map_err(map_sql)?;
            }
        }
        tx.commit().await.map_err(map_sql)?;

        Ok(Bookmark {
            id,
            name: name.to_string(),
            created_by: created_by.to_string(),
            created_by_name: created_by_name.to_string(),
            created_at,
            datasets: seen.into_iter().map(str::to_string).collect(),
            view,
        })
    }

    async fn get(&self, id: &str) -> Result<Option<Bookmark>, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT id, name, created_by, created_by_name, created_at, view_json
            FROM bookmarks
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_sql)?;

        let Some(row) = row else { return Ok(None) };
        let datasets = fetch_datasets_for(&self.pool, id).await?;
        Ok(Some(row_to_bookmark(row, datasets)?))
    }

    async fn list_by_dataset_overlap(
        &self,
        dataset_urls: &[String],
    ) -> Result<Vec<Bookmark>, StoreError> {
        if dataset_urls.is_empty() {
            return self.list_all().await;
        }
        // Build the "?, ?, ?" placeholder list dynamically — sqlx doesn't
        // expand `IN (?)` for slices on its own. Bookmark IDs in the
        // subquery dedupe via DISTINCT so a multi-overlap row still
        // shows up once.
        let placeholders = std::iter::repeat_n("?", dataset_urls.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            r#"
            SELECT id, name, created_by, created_by_name, created_at, view_json
            FROM bookmarks
            WHERE id IN (
                SELECT DISTINCT bookmark_id
                FROM bookmark_datasets
                WHERE dataset_url IN ({placeholders})
            )
            ORDER BY created_at DESC
            "#
        );
        let mut q = sqlx::query(&sql);
        for url in dataset_urls {
            q = q.bind(url);
        }
        let rows = q.fetch_all(&self.pool).await.map_err(map_sql)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.get("id");
            let datasets = fetch_datasets_for(&self.pool, &id).await?;
            out.push(row_to_bookmark(row, datasets)?);
        }
        Ok(out)
    }

    async fn list_all(&self) -> Result<Vec<Bookmark>, StoreError> {
        let rows = sqlx::query(
            r#"
            SELECT id, name, created_by, created_by_name, created_at, view_json
            FROM bookmarks
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(map_sql)?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.get("id");
            let datasets = fetch_datasets_for(&self.pool, &id).await?;
            out.push(row_to_bookmark(row, datasets)?);
        }
        Ok(out)
    }

    async fn patch_name(&self, id: &str, new_name: &str) -> Result<Option<Bookmark>, StoreError> {
        let result = sqlx::query("UPDATE bookmarks SET name = ? WHERE id = ?")
            .bind(new_name)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(map_sql)?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.get(id).await
    }

    async fn delete(&self, id: &str) -> Result<Option<Bookmark>, StoreError> {
        // `ON DELETE CASCADE` on bookmark_datasets requires
        // `PRAGMA foreign_keys = ON` per-connection; sqlx doesn't enable
        // it by default. Belt-and-braces: explicit DELETE on the side
        // table inside a transaction keeps the rows in sync regardless.
        //
        // Read the row + datasets inside the same transaction so the
        // returned `Bookmark` matches the row we removed even if a
        // concurrent writer was racing. The row goes back to the caller
        // so the slice-4 broadcast can scope on `dataset_urls` without
        // a second round-trip.
        let mut tx = self.pool.begin().await.map_err(map_sql)?;
        let row = sqlx::query(
            r#"
            SELECT id, name, created_by, created_by_name, created_at, view_json
            FROM bookmarks
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_sql)?;
        let Some(row) = row else {
            tx.commit().await.map_err(map_sql)?;
            return Ok(None);
        };
        let dataset_rows = sqlx::query(
            "SELECT dataset_url FROM bookmark_datasets WHERE bookmark_id = ? ORDER BY dataset_url",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .map_err(map_sql)?;
        let datasets: Vec<String> = dataset_rows
            .into_iter()
            .map(|r| r.get("dataset_url"))
            .collect();
        sqlx::query("DELETE FROM bookmark_datasets WHERE bookmark_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        let result = sqlx::query("DELETE FROM bookmarks WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(map_sql)?;
        tx.commit().await.map_err(map_sql)?;
        if result.rows_affected() == 0 {
            // Theoretically the SELECT saw the row but the DELETE didn't;
            // surface as None so the caller treats it as "not found".
            return Ok(None);
        }
        Ok(Some(row_to_bookmark(row, datasets)?))
    }
}

async fn fetch_datasets_for(pool: &SqlitePool, id: &str) -> Result<Vec<String>, StoreError> {
    let rows = sqlx::query(
        "SELECT dataset_url FROM bookmark_datasets WHERE bookmark_id = ? ORDER BY dataset_url",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(map_sql)?;
    Ok(rows.into_iter().map(|r| r.get("dataset_url")).collect())
}

fn row_to_bookmark(
    row: sqlx::sqlite::SqliteRow,
    datasets: Vec<String>,
) -> Result<Bookmark, StoreError> {
    let view_json: String = row.get("view_json");
    let view: SavedView = serde_json::from_str(&view_json).map_err(map_json_in)?;
    let created_at_str: String = row.get("created_at");
    let created_at = DateTime::parse_from_rfc3339(&created_at_str)
        .map_err(|e| StoreError::Backend(format!("created_at parse: {e}")))?
        .with_timezone(&Utc);
    Ok(Bookmark {
        id: row.get("id"),
        name: row.get("name"),
        created_by: row.get("created_by"),
        created_by_name: row.get("created_by_name"),
        created_at,
        datasets,
        view,
    })
}

/// Test-only in-memory implementation. Lives behind a regular module
/// (not `cfg(test)`) so integration tests in `tests/` can construct it
/// without dragging in SQLite. Mutex is uncontended in tests; the
/// overhead is irrelevant.
#[derive(Debug, Default)]
pub struct MemoryBookmarkStore {
    rows: Mutex<HashMap<String, Bookmark>>,
}

impl MemoryBookmarkStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.rows
            .lock()
            .expect("memory bookmark store mutex poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[async_trait]
impl BookmarkStore for MemoryBookmarkStore {
    async fn create(
        &self,
        name: &str,
        created_by: &str,
        created_by_name: &str,
        datasets: Vec<String>,
        view: SavedView,
    ) -> Result<Bookmark, StoreError> {
        let id = uuid::Uuid::new_v4().to_string();
        // Mirror SQLite dedupe so behavior is identical between backends.
        let mut seen = std::collections::HashSet::new();
        let mut deduped = Vec::with_capacity(datasets.len());
        for url in datasets {
            if seen.insert(url.clone()) {
                deduped.push(url);
            }
        }
        let bookmark = Bookmark {
            id: id.clone(),
            name: name.to_string(),
            created_by: created_by.to_string(),
            created_by_name: created_by_name.to_string(),
            created_at: Utc::now(),
            datasets: deduped,
            view,
        };
        let mut rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        rows.insert(id, bookmark.clone());
        Ok(bookmark)
    }

    async fn get(&self, id: &str) -> Result<Option<Bookmark>, StoreError> {
        let rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        Ok(rows.get(id).cloned())
    }

    async fn list_by_dataset_overlap(
        &self,
        dataset_urls: &[String],
    ) -> Result<Vec<Bookmark>, StoreError> {
        if dataset_urls.is_empty() {
            return self.list_all().await;
        }
        let needle: std::collections::HashSet<&str> =
            dataset_urls.iter().map(String::as_str).collect();
        let rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        let mut out: Vec<Bookmark> = rows
            .values()
            .filter(|b| b.datasets.iter().any(|u| needle.contains(u.as_str())))
            .cloned()
            .collect();
        out.sort_by_key(|b| std::cmp::Reverse(b.created_at));
        Ok(out)
    }

    async fn list_all(&self) -> Result<Vec<Bookmark>, StoreError> {
        let rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        let mut out: Vec<Bookmark> = rows.values().cloned().collect();
        out.sort_by_key(|b| std::cmp::Reverse(b.created_at));
        Ok(out)
    }

    async fn patch_name(&self, id: &str, new_name: &str) -> Result<Option<Bookmark>, StoreError> {
        let mut rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        let Some(row) = rows.get_mut(id) else {
            return Ok(None);
        };
        row.name = new_name.to_string();
        Ok(Some(row.clone()))
    }

    async fn delete(&self, id: &str) -> Result<Option<Bookmark>, StoreError> {
        let mut rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        Ok(rows.remove(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SqliteStorageBackend;

    /// A store over a migrated in-memory database, opened the way
    /// production opens one.
    async fn fresh_sqlite() -> SqliteBookmarkStore {
        let backend = SqliteStorageBackend::open_in_memory().await.unwrap();
        SqliteBookmarkStore::new(backend.pool().clone())
    }

    fn sample_view(viewport: [u32; 2]) -> SavedView {
        SavedView::empty(viewport)
    }

    // Each scenario below exercises both the SQLite and in-memory
    // backends via an `impl BookmarkStore` helper — looping over
    // `Vec<Box<dyn BookmarkStore>>` is awkward (lifetime juggling on
    // the future returned by `create`).
    async fn create_get_roundtrip<S: BookmarkStore>(store: &S) {
        let view = sample_view([800, 600]);
        let b = store
            .create(
                "Group B7 view",
                "alice@calicolabs.com",
                "Alice Example",
                vec!["gs://bucket/a.zarr".to_string()],
                view.clone(),
            )
            .await
            .unwrap();
        assert_eq!(b.name, "Group B7 view");
        assert_eq!(b.created_by, "alice@calicolabs.com");
        assert_eq!(b.datasets, vec!["gs://bucket/a.zarr".to_string()]);
        assert_eq!(b.view.v, view.v);
        // UUID v4 string length = 36
        assert_eq!(b.id.len(), 36);

        let got = store.get(&b.id).await.unwrap().unwrap();
        assert_eq!(got.id, b.id);
        assert_eq!(got.name, b.name);
        assert_eq!(got.datasets, b.datasets);
    }

    #[tokio::test]
    async fn create_then_get_roundtrips_sqlite() {
        let s = fresh_sqlite().await;
        create_get_roundtrip(&s).await;
    }

    #[tokio::test]
    async fn create_then_get_roundtrips_memory() {
        let s = MemoryBookmarkStore::new();
        create_get_roundtrip(&s).await;
    }

    #[tokio::test]
    async fn get_missing_returns_none_sqlite() {
        let s = fresh_sqlite().await;
        assert!(s.get("does-not-exist").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn get_missing_returns_none_memory() {
        let s = MemoryBookmarkStore::new();
        assert!(s.get("does-not-exist").await.unwrap().is_none());
    }

    async fn make_three<S: BookmarkStore>(store: &S) -> (String, String, String) {
        let b1 = store
            .create(
                "alpha",
                "alice@x",
                "Alice",
                vec!["url-a".into(), "url-b".into()],
                sample_view([1, 1]),
            )
            .await
            .unwrap();
        let b2 = store
            .create(
                "beta",
                "alice@x",
                "Alice",
                vec!["url-b".into(), "url-c".into()],
                sample_view([1, 1]),
            )
            .await
            .unwrap();
        let b3 = store
            .create(
                "gamma",
                "bob@x",
                "Bob",
                vec!["url-d".into()],
                sample_view([1, 1]),
            )
            .await
            .unwrap();
        (b1.id, b2.id, b3.id)
    }

    async fn list_by_dataset_overlap_scenarios<S: BookmarkStore>(store: &S) {
        let (b1, b2, b3) = make_three(store).await;
        // single-match: only b3 has url-d
        let r = store
            .list_by_dataset_overlap(&["url-d".into()])
            .await
            .unwrap();
        let ids: std::collections::HashSet<&str> = r.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, [b3.as_str()].into_iter().collect());

        // multi-match: url-b matches b1 and b2
        let r = store
            .list_by_dataset_overlap(&["url-b".into()])
            .await
            .unwrap();
        let ids: std::collections::HashSet<&str> = r.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, [b1.as_str(), b2.as_str()].into_iter().collect());

        // multiple URLs: union, deduplicated
        let r = store
            .list_by_dataset_overlap(&["url-a".into(), "url-d".into()])
            .await
            .unwrap();
        let ids: std::collections::HashSet<&str> = r.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, [b1.as_str(), b3.as_str()].into_iter().collect());

        // no match
        let r = store
            .list_by_dataset_overlap(&["url-zzz".into()])
            .await
            .unwrap();
        assert!(r.is_empty());

        // empty input → all
        let r = store.list_by_dataset_overlap(&[]).await.unwrap();
        assert_eq!(r.len(), 3);
    }

    #[tokio::test]
    async fn list_by_dataset_overlap_sqlite() {
        let s = fresh_sqlite().await;
        list_by_dataset_overlap_scenarios(&s).await;
    }

    #[tokio::test]
    async fn list_by_dataset_overlap_memory() {
        let s = MemoryBookmarkStore::new();
        list_by_dataset_overlap_scenarios(&s).await;
    }

    async fn patch_updates_name<S: BookmarkStore>(store: &S) {
        let b = store
            .create(
                "old",
                "alice@x",
                "Alice",
                vec!["u1".into()],
                sample_view([1, 1]),
            )
            .await
            .unwrap();
        let updated = store.patch_name(&b.id, "new").await.unwrap().unwrap();
        assert_eq!(updated.name, "new");
        // datasets, creator, view should be untouched
        assert_eq!(updated.created_by, "alice@x");
        assert_eq!(updated.datasets, vec!["u1".to_string()]);

        let got = store.get(&b.id).await.unwrap().unwrap();
        assert_eq!(got.name, "new");
    }

    #[tokio::test]
    async fn patch_updates_name_sqlite() {
        let s = fresh_sqlite().await;
        patch_updates_name(&s).await;
    }

    #[tokio::test]
    async fn patch_updates_name_memory() {
        let s = MemoryBookmarkStore::new();
        patch_updates_name(&s).await;
    }

    async fn patch_missing_returns_none<S: BookmarkStore>(store: &S) {
        assert!(store.patch_name("nope", "x").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn patch_missing_returns_none_sqlite() {
        let s = fresh_sqlite().await;
        patch_missing_returns_none(&s).await;
    }

    #[tokio::test]
    async fn patch_missing_returns_none_memory() {
        let s = MemoryBookmarkStore::new();
        patch_missing_returns_none(&s).await;
    }

    async fn delete_removes_row<S: BookmarkStore>(store: &S) {
        let b = store
            .create(
                "doomed",
                "alice@x",
                "Alice",
                vec!["u1".into(), "u2".into()],
                sample_view([1, 1]),
            )
            .await
            .unwrap();
        // delete returns the removed bookmark (datasets included) so the
        // slice-4 broadcast can scope on `dataset_urls` without a second
        // get round-trip.
        let removed = store.delete(&b.id).await.unwrap().expect("row removed");
        assert_eq!(removed.id, b.id);
        assert_eq!(
            removed
                .datasets
                .iter()
                .cloned()
                .collect::<std::collections::HashSet<_>>(),
            ["u1".to_string(), "u2".to_string()].into_iter().collect(),
        );
        assert!(store.get(&b.id).await.unwrap().is_none());
        // delete on missing returns None (idempotent-ish — the caller
        // can tell whether their request actually removed something).
        assert!(store.delete(&b.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_removes_row_sqlite() {
        let s = fresh_sqlite().await;
        delete_removes_row(&s).await;
    }

    #[tokio::test]
    async fn delete_removes_row_memory() {
        let s = MemoryBookmarkStore::new();
        delete_removes_row(&s).await;
    }

    /// SQLite-only: the dataset side rows must be cleaned up so a
    /// subsequent overlap query for the same URL doesn't surface a
    /// dangling row pointer.
    #[tokio::test]
    async fn delete_cascades_dataset_rows_sqlite() {
        let s = fresh_sqlite().await;
        let b = s
            .create(
                "x",
                "a@b",
                "A",
                vec!["only-this-bookmark.zarr".into()],
                sample_view([1, 1]),
            )
            .await
            .unwrap();
        assert!(s.delete(&b.id).await.unwrap().is_some());
        // No rows should overlap the now-deleted dataset URL.
        let r = s
            .list_by_dataset_overlap(&["only-this-bookmark.zarr".into()])
            .await
            .unwrap();
        assert!(r.is_empty(), "side-table rows must be cleaned up on delete");
    }

    /// Concurrency smoke: 16 parallel inserts must produce 16 distinct
    /// UUIDs and 16 surviving rows. Mirrors the auth store's parallel
    /// insert test — same hot path now that bookmark POSTs land per
    /// request.
    #[tokio::test]
    async fn parallel_inserts_produce_distinct_ids_sqlite() {
        let store = fresh_sqlite().await;
        let mut handles = Vec::new();
        for i in 0..16 {
            let store = store.clone();
            handles.push(tokio::spawn(async move {
                let b = store
                    .create(
                        &format!("name-{i}"),
                        "a@b",
                        "A",
                        vec!["u".to_string()],
                        sample_view([1, 1]),
                    )
                    .await
                    .unwrap();
                b.id
            }));
        }
        let mut ids = std::collections::HashSet::new();
        for h in handles {
            ids.insert(h.await.unwrap());
        }
        assert_eq!(ids.len(), 16);
        assert_eq!(store.list_all().await.unwrap().len(), 16);
    }

    /// Migrations apply cleanly to a fresh in-memory database — covers
    /// the "smoke a brand-new lucida.db" boot path. `fresh_sqlite()`
    /// already exercises this; the assertion makes the intent explicit.
    #[tokio::test]
    async fn migrations_apply_cleanly_to_fresh_db() {
        let store = fresh_sqlite().await;
        assert_eq!(store.list_all().await.unwrap().len(), 0);
    }

    /// The any-overlap SELECT MUST go through `idx_bookmark_datasets_url`
    /// — if the migration ever drops the index, the query degrades to a
    /// full-table scan and the sidebar's hot path balloons. Regression
    /// guard for the index.
    #[tokio::test]
    async fn overlap_query_uses_index_sqlite() {
        let store = fresh_sqlite().await;
        // Seed a row so SQLite has stats to drive the planner choice;
        // EXPLAIN QUERY PLAN works without rows but the fixture also
        // confirms the index hit on real data.
        store
            .create(
                "n",
                "a@b",
                "A",
                vec!["u-a".to_string()],
                sample_view([1, 1]),
            )
            .await
            .unwrap();
        let plan_rows = sqlx::query(
            r#"
            EXPLAIN QUERY PLAN
            SELECT id, name, created_by, created_by_name, created_at, view_json
            FROM bookmarks
            WHERE id IN (
                SELECT DISTINCT bookmark_id
                FROM bookmark_datasets
                WHERE dataset_url IN (?, ?)
            )
            "#,
        )
        .bind("u-a")
        .bind("u-b")
        .fetch_all(&store.pool)
        .await
        .unwrap();
        let plan_text = plan_rows
            .iter()
            .map(|r| r.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            plan_text.contains("idx_bookmark_datasets_url"),
            "EXPLAIN QUERY PLAN must reference idx_bookmark_datasets_url; got:\n{plan_text}",
        );
    }
}
