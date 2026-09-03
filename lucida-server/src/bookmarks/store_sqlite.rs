//! SQLite-backed `BookmarkStore`.
//!
//! Shares the SQLite file and pool that [`crate::storage`] opened, as
//! every SQLite store does.
//!
//! The statements come from [`super::store_sql`], which the PostgreSQL
//! store runs too, so this module holds the binding and the row mapping
//! and no SQL of its own. Read it beside `store_postgres`. What differs
//! is the pool type, the type name, and how `view_json` is bound and
//! decoded, because the column is `TEXT` here and `JSONB` there.

use async_trait::async_trait;
use chrono::Utc;
use sqlx::{Row, SqlitePool};

use lucida_core::saved_view::SavedView;

use super::store::{Bookmark, BookmarkStore, StoreError, attachment_set};
use super::store_sql::{self as sql, map_err, map_stored_view};

/// Production store. Wraps the `SqlitePool` the storage backend opened,
/// so every table rides one connection budget.
#[derive(Debug, Clone)]
pub struct SqliteBookmarkStore {
    pool: SqlitePool,
}

impl SqliteBookmarkStore {
    /// Build the store from an already-opened pool. The migrator does
    /// not run here: the storage backend runs it once, before any store
    /// exists.
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Turn bookmark rows into records, fetching each one's attachments.
    async fn rows_to_bookmarks(
        &self,
        rows: Vec<sqlx::sqlite::SqliteRow>,
    ) -> Result<Vec<Bookmark>, StoreError> {
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.get("id");
            let datasets = self.attachments_of(&id).await?;
            out.push(row_to_bookmark(row, datasets)?);
        }
        Ok(out)
    }

    /// The dataset URLs one bookmark is attached to.
    async fn attachments_of(&self, id: &str) -> Result<Vec<String>, StoreError> {
        let rows = sqlx::query(sql::SELECT_ATTACHMENTS)
            .bind(id)
            .fetch_all(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(rows.into_iter().map(|r| r.get("dataset_url")).collect())
    }
}

/// A view that will not serialize. Nothing the caller sent can provoke
/// it — `SavedView` is a plain struct — so it is a backend fault rather
/// than a bad payload.
fn map_outgoing_view(e: serde_json::Error) -> StoreError {
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
        let view_json = serde_json::to_string(&view).map_err(map_outgoing_view)?;
        let datasets = attachment_set(datasets);

        let mut tx = self.pool.begin().await.map_err(map_err)?;
        sqlx::query(sql::INSERT)
            .bind(&id)
            .bind(name)
            .bind(created_by)
            .bind(created_by_name)
            .bind(created_at)
            .bind(&view_json)
            .execute(&mut *tx)
            .await
            .map_err(map_err)?;

        for url in &datasets {
            sqlx::query(sql::ATTACH)
                .bind(&id)
                .bind(url)
                .execute(&mut *tx)
                .await
                .map_err(map_err)?;
        }
        tx.commit().await.map_err(map_err)?;

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
        let row = sqlx::query(sql::SELECT_BY_ID)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_err)?;

        let Some(row) = row else { return Ok(None) };
        let datasets = self.attachments_of(id).await?;
        Ok(Some(row_to_bookmark(row, datasets)?))
    }

    async fn list_by_dataset_overlap(
        &self,
        dataset_urls: &[String],
    ) -> Result<Vec<Bookmark>, StoreError> {
        if dataset_urls.is_empty() {
            return self.list_all().await;
        }
        let statement = sql::select_by_overlap(dataset_urls.len());
        let mut query = sqlx::query(&statement);
        for url in dataset_urls {
            query = query.bind(url);
        }
        let rows = query.fetch_all(&self.pool).await.map_err(map_err)?;
        self.rows_to_bookmarks(rows).await
    }

    async fn list_all(&self) -> Result<Vec<Bookmark>, StoreError> {
        let rows = sqlx::query(sql::SELECT_ALL)
            .fetch_all(&self.pool)
            .await
            .map_err(map_err)?;
        self.rows_to_bookmarks(rows).await
    }

    async fn patch_name(&self, id: &str, new_name: &str) -> Result<Option<Bookmark>, StoreError> {
        let result = sqlx::query(sql::RENAME)
            .bind(new_name)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.get(id).await
    }

    async fn delete(&self, id: &str) -> Result<Option<Bookmark>, StoreError> {
        // Read the attachments before the DELETE takes them: only
        // `bookmarks` is deleted, and the schema's `ON DELETE CASCADE`
        // holds because the backend opens every connection with foreign
        // keys on. They ride back with the row so the change broadcast
        // can scope on them without a second round-trip, and one
        // transaction keeps the two statements agreeing about a row a
        // concurrent writer may have removed.
        let mut tx = self.pool.begin().await.map_err(map_err)?;
        let dataset_rows = sqlx::query(sql::SELECT_ATTACHMENTS)
            .bind(id)
            .fetch_all(&mut *tx)
            .await
            .map_err(map_err)?;
        let datasets: Vec<String> = dataset_rows
            .into_iter()
            .map(|r| r.get("dataset_url"))
            .collect();
        let row = sqlx::query(sql::DELETE)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(map_err)?;
        tx.commit().await.map_err(map_err)?;
        row.map(|row| row_to_bookmark(row, datasets)).transpose()
    }
}

fn row_to_bookmark(
    row: sqlx::sqlite::SqliteRow,
    datasets: Vec<String>,
) -> Result<Bookmark, StoreError> {
    let view_json: String = row.get("view_json");
    let view: SavedView = serde_json::from_str(&view_json).map_err(map_stored_view)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::sqlite_pool;

    /// The any-overlap SELECT must go through `idx_bookmark_datasets_url`.
    /// Drop the index from the migration and the query degrades to a full
    /// table scan, which no assertion about the rows it returns would
    /// notice. So this one reads the plan, and it stays here rather than
    /// in the conformance suite because a query plan belongs to an engine
    /// and `EXPLAIN QUERY PLAN` is SQLite's own spelling. The PostgreSQL
    /// store asserts the same guarantee its own way.
    ///
    /// One seeded row is enough: SQLite's planner picks an index it can
    /// use without weighing it against the table size.
    #[tokio::test]
    async fn the_overlap_query_goes_through_the_dataset_url_index() {
        let store = SqliteBookmarkStore::new(sqlite_pool().await);
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

        let plan_rows = sqlx::query(&format!("EXPLAIN QUERY PLAN {}", sql::select_by_overlap(2)))
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
    ///
    /// SQLite only enforces a foreign key on a connection that asked it
    /// to, which is a property of how this backend opens one rather than
    /// of the schema, so the cascade is worth asserting here as well as
    /// beside the PostgreSQL store.
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
