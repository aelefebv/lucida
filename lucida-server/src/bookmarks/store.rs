//! `BookmarkStore` trait + production SQLite backend + in-memory backend
//! for tests.
//!
//! The trait is the seam between handlers and storage. Handlers hold
//! `Arc<dyn BookmarkStore>` so the same wiring can swap between the
//! SQLite-backed production store and the in-memory test store without
//! changing call sites.
//!
//! The production schema lives in the baseline migration. Two tables:
//!
//! - `bookmarks` — one row per bookmark, with the serialized `SavedView`
//!   stored as a JSON string in `view_json`.
//! - `bookmark_datasets` — side table mapping `(bookmark_id, dataset_url)`,
//!   indexed on `dataset_url` to power the any-overlap SELECT the sidebar
//!   runs. `EXPLAIN QUERY PLAN` is asserted in tests so the index isn't
//!   silently dropped from the migration.
//!
//! Create is transactional across the two tables. Delete touches only
//! `bookmarks`; the attachments go with it through the schema's cascade.

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
    /// `Ok(None)` when the id doesn't match. The attachments go with it.
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

/// The dataset URLs a bookmark is attached to, deduplicated and sorted.
///
/// Attachment is a set: a caller passing `[a, a]` means one attachment,
/// and the order they were passed in carries nothing. Reads return them
/// in URL order, so creates hand back the same order rather than
/// whatever the caller supplied.
fn attachment_set(datasets: Vec<String>) -> Vec<String> {
    datasets
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
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
        let datasets = attachment_set(datasets);

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
        .bind(created_at)
        .bind(&view_json)
        .execute(&mut *tx)
        .await
        .map_err(map_sql)?;

        for url in &datasets {
            sqlx::query("INSERT INTO bookmark_datasets (bookmark_id, dataset_url) VALUES (?, ?)")
                .bind(&id)
                .bind(url)
                .execute(&mut *tx)
                .await
                .map_err(map_sql)?;
        }
        tx.commit().await.map_err(map_sql)?;

        Ok(Bookmark {
            id,
            name: name.to_string(),
            created_by: created_by.to_string(),
            created_by_name: created_by_name.to_string(),
            created_at,
            datasets,
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
        // Read the row + datasets inside the same transaction as the
        // DELETE so the returned `Bookmark` matches the row we removed
        // even if a concurrent writer was racing. The row goes back to the
        // caller so the change broadcast can scope on `dataset_urls`
        // without a second round-trip.
        //
        // Only `bookmarks` is deleted: `bookmark_datasets` declares
        // `ON DELETE CASCADE` and the SQLite backend enforces it.
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
    Ok(Bookmark {
        id: row.get("id"),
        name: row.get("name"),
        created_by: row.get("created_by"),
        created_by_name: row.get("created_by_name"),
        created_at: row.get("created_at"),
        datasets,
        view,
    })
}

/// Test-only in-memory implementation. Lives behind a regular module
/// (not `cfg(test)`) so integration tests in `tests/` can construct it
/// without dragging in SQLite. Mutex is uncontended in tests; the
/// overhead is irrelevant.
///
/// The `BookmarkStore` conformance suite in [`crate::storage`] runs
/// against this store and [`SqliteBookmarkStore`], so the two answer
/// alike.
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
        let bookmark = Bookmark {
            id: id.clone(),
            name: name.to_string(),
            created_by: created_by.to_string(),
            created_by_name: created_by_name.to_string(),
            created_at: Utc::now(),
            datasets: attachment_set(datasets),
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
    use crate::storage::test_support::sqlite_pool;

    /// The any-overlap SELECT must go through `idx_bookmark_datasets_url`.
    /// Drop the index from the migration and the query degrades to a full
    /// table scan, which no assertion about the rows it returns would
    /// notice. So this one reads the plan, and it stays here rather than
    /// in the conformance suite because a query plan is a SQLite fact.
    #[tokio::test]
    async fn the_overlap_query_goes_through_the_dataset_url_index() {
        let store = SqliteBookmarkStore::new(sqlite_pool().await);
        // Seed a row so the planner is choosing over real data.
        store
            .create(
                "seed",
                "author@example.com",
                "Author",
                vec!["file:///data/a.zarr".to_string()],
                SavedView::empty([800, 600]),
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
        .bind("file:///data/a.zarr")
        .bind("file:///data/b.zarr")
        .fetch_all(&store.pool)
        .await
        .unwrap();

        let plan = plan_rows
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            plan.contains("idx_bookmark_datasets_url"),
            "the overlap query must use idx_bookmark_datasets_url; the plan was:\n{plan}",
        );
    }

    /// Deleting a bookmark deletes only `bookmarks`, and the schema's
    /// cascade takes the attachments with it. Through the trait an
    /// orphaned attachment is invisible — the overlap query joins back to
    /// a bookmark that is gone — so the conformance suite cannot see one
    /// and this counts the rows directly.
    #[tokio::test]
    async fn deleting_a_bookmark_leaves_no_attachment_rows_behind() {
        let pool = sqlite_pool().await;
        let store = SqliteBookmarkStore::new(pool.clone());
        let created = store
            .create(
                "doomed",
                "author@example.com",
                "Author",
                vec![
                    "file:///data/a.zarr".to_string(),
                    "file:///data/b.zarr".to_string(),
                ],
                SavedView::empty([800, 600]),
            )
            .await
            .unwrap();

        store.delete(&created.id).await.unwrap();

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bookmark_datasets")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 0, "the attachments went with the bookmark");
    }
}
