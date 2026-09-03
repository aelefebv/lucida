//! SQLite-backed `BookmarkStore`.
//!
//! Shares the SQLite file and pool that [`crate::storage`] opened, as
//! every SQLite store does.

use async_trait::async_trait;
use chrono::Utc;
use sqlx::{Row, SqlitePool};

use lucida_core::saved_view::SavedView;

use super::store::{Bookmark, BookmarkStore, StoreError, attachment_set};

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
