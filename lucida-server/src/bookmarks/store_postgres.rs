//! PostgreSQL-backed `BookmarkStore`.
//!
//! Shares the PostgreSQL pool that [`crate::storage`] opened, as every
//! PostgreSQL store does.
//!
//! The statements come from [`super::store_sql`], which the SQLite store
//! runs too, so this module holds the binding and the row mapping and no
//! SQL of its own. Read it beside `store_sqlite`: what differs is the
//! pool type, the type name, and how `view_json` is bound and decoded,
//! because the column is `JSONB` here and `TEXT` there. ADR-0058 records
//! why the SQL is shared and the Rust is not.

use async_trait::async_trait;
use chrono::{DateTime, SubsecRound, Utc};
use sqlx::types::Json;
use sqlx::{PgPool, Row};

use lucida_core::saved_view::SavedView;

use super::store::{Bookmark, BookmarkStore, StoreError, attachment_set};
use super::store_sql::{self as sql, map_err, map_stored_view};

/// PostgreSQL bookmark store. Holds a `PgPool` clone, so it is cheap to
/// build and cheap to share.
#[derive(Debug, Clone)]
pub struct PostgresBookmarkStore {
    pool: PgPool,
}

impl PostgresBookmarkStore {
    /// Build the store from an already-opened pool. The migrator does
    /// not run here: the storage backend runs it once, before any store
    /// exists.
    pub(crate) fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Turn bookmark rows into records, fetching each one's attachments.
    async fn gather(&self, rows: Vec<sqlx::postgres::PgRow>) -> Result<Vec<Bookmark>, StoreError> {
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.get("id");
            let datasets = fetch_datasets_for(&self.pool, &id).await?;
            out.push(row_to_bookmark(row, datasets)?);
        }
        Ok(out)
    }
}

#[async_trait]
impl BookmarkStore for PostgresBookmarkStore {
    async fn create(
        &self,
        name: &str,
        created_by: &str,
        created_by_name: &str,
        datasets: Vec<String>,
        view: SavedView,
    ) -> Result<Bookmark, StoreError> {
        let id = uuid::Uuid::new_v4().to_string();
        // `TIMESTAMPTZ` holds microseconds, and the clock offers
        // nanoseconds. Round the value down before it is written, so the
        // instant this call reports is the instant a later read reports
        // rather than one the column could not keep.
        let created_at = Utc::now().trunc_subsecs(6);
        let datasets = attachment_set(datasets);

        let mut tx = self.pool.begin().await.map_err(map_err)?;
        sqlx::query(sql::INSERT)
            .bind(&id)
            .bind(name)
            .bind(created_by)
            .bind(created_by_name)
            .bind(created_at)
            // A `JSONB` column refuses a bound `String`, which is what
            // the SQLite store's `TEXT` column takes. `Json` sends the
            // view as JSON instead. A `$6::jsonb` cast would do the same
            // and would end the sharing for this statement, because
            // SQLite rejects `::` outright.
            .bind(Json(&view))
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
        let row = sqlx::query(sql::SELECT_ONE)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_err)?;

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
        let statement = sql::select_by_overlap(dataset_urls.len());
        let mut query = sqlx::query(&statement);
        for url in dataset_urls {
            query = query.bind(url);
        }
        let rows = query.fetch_all(&self.pool).await.map_err(map_err)?;
        self.gather(rows).await
    }

    async fn list_all(&self) -> Result<Vec<Bookmark>, StoreError> {
        let rows = sqlx::query(sql::SELECT_ALL)
            .fetch_all(&self.pool)
            .await
            .map_err(map_err)?;
        self.gather(rows).await
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
        // Read the row + datasets inside the same transaction as the
        // DELETE so the returned `Bookmark` matches the row we removed
        // even if a concurrent writer was racing. The row goes back to the
        // caller so the change broadcast can scope on `dataset_urls`
        // without a second round-trip.
        //
        // Only `bookmarks` is deleted: `bookmark_datasets` declares
        // `ON DELETE CASCADE` and PostgreSQL enforces it unconditionally.
        let mut tx = self.pool.begin().await.map_err(map_err)?;
        let row = sqlx::query(sql::SELECT_ONE)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(map_err)?;
        let Some(row) = row else {
            tx.commit().await.map_err(map_err)?;
            return Ok(None);
        };
        let dataset_rows = sqlx::query(sql::SELECT_ATTACHMENTS)
            .bind(id)
            .fetch_all(&mut *tx)
            .await
            .map_err(map_err)?;
        let datasets: Vec<String> = dataset_rows
            .into_iter()
            .map(|r| r.get("dataset_url"))
            .collect();
        let result = sqlx::query(sql::DELETE)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(map_err)?;
        tx.commit().await.map_err(map_err)?;
        if result.rows_affected() == 0 {
            // Theoretically the SELECT saw the row but the DELETE didn't;
            // surface as None so the caller treats it as "not found".
            return Ok(None);
        }
        Ok(Some(row_to_bookmark(row, datasets)?))
    }
}

async fn fetch_datasets_for(pool: &PgPool, id: &str) -> Result<Vec<String>, StoreError> {
    let rows = sqlx::query(sql::SELECT_ATTACHMENTS)
        .bind(id)
        .fetch_all(pool)
        .await
        .map_err(map_err)?;
    Ok(rows.into_iter().map(|r| r.get("dataset_url")).collect())
}

fn row_to_bookmark(
    row: sqlx::postgres::PgRow,
    datasets: Vec<String>,
) -> Result<Bookmark, StoreError> {
    // `JSONB` hands back a parsed value rather than the characters that
    // were written, so the view is rebuilt from that rather than from
    // text. What PostgreSQL keeps is the JSON document, not its
    // spelling: key order, whitespace, and number form are all its own
    // by the time it comes back. The store's contract is the decoded
    // `SavedView`, which none of that changes.
    let view_json: serde_json::Value = row.get("view_json");
    let view: SavedView = serde_json::from_value(view_json).map_err(map_stored_view)?;
    Ok(Bookmark {
        id: row.get("id"),
        name: row.get("name"),
        created_by: row.get("created_by"),
        created_by_name: row.get("created_by_name"),
        created_at: row.get::<DateTime<Utc>, _>("created_at"),
        datasets,
        view,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::{PostgresTestDatabase, postgres_backend};

    /// Bookmarks to seed before reading a query plan, and dataset URLs
    /// per bookmark.
    ///
    /// PostgreSQL's planner weighs an index scan against the cost of
    /// reading the whole table, and on a table of a few hundred rows the
    /// scan honestly wins — so a plan read over a token row would assert
    /// the opposite of what it means to. These counts put the attachment
    /// table well past the size where that flips, with room to spare, and
    /// each table is seeded by a single statement.
    const SEEDED_BOOKMARKS: i64 = 2_000;
    const SEEDED_URLS_EACH: i64 = 4;

    fn store(db: &PostgresTestDatabase) -> PostgresBookmarkStore {
        PostgresBookmarkStore::new(db.backend.pool().clone())
    }

    /// The any-overlap SELECT must go through `idx_bookmark_datasets_url`.
    /// Drop the index from the migration and the query degrades to a full
    /// table scan, which no assertion about the rows it returns would
    /// notice.
    ///
    /// The SQLite store asserts the same guarantee, and asserts it
    /// differently: `EXPLAIN QUERY PLAN` is SQLite's own spelling and its
    /// planner needs no statistics to prefer an index it can use. A query
    /// plan belongs to an engine, so neither assertion can be a
    /// conformance case, and the two are free to be shaped differently.
    #[tokio::test]
    async fn the_overlap_query_goes_through_the_dataset_url_index() {
        let Some(db) = postgres_backend().await else {
            return;
        };
        let pool = db.backend.pool();

        sqlx::query(
            "INSERT INTO bookmarks \
             SELECT 'seed-' || g, 'seed', 'author@example.com', 'Author', now(), '{}' \
             FROM generate_series(1, $1) g",
        )
        .bind(SEEDED_BOOKMARKS)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO bookmark_datasets \
             SELECT 'seed-' || g, 'file:///data/' || g || '-' || k || '.zarr' \
             FROM generate_series(1, $1) g, generate_series(1, $2) k",
        )
        .bind(SEEDED_BOOKMARKS)
        .bind(SEEDED_URLS_EACH)
        .execute(pool)
        .await
        .unwrap();
        // Without statistics the planner is guessing at the table size,
        // and the seeded rows are exactly what it has to weigh.
        for table in ["bookmarks", "bookmark_datasets"] {
            sqlx::query(&format!("ANALYZE {table}"))
                .execute(pool)
                .await
                .unwrap();
        }

        let plan_rows = sqlx::query(&format!("EXPLAIN {}", sql::select_by_overlap(2)))
            .bind("file:///data/1-1.zarr")
            .bind("file:///data/2-1.zarr")
            .fetch_all(pool)
            .await
            .unwrap();

        let plan = plan_rows
            .iter()
            .map(|row| row.get::<String, _>("QUERY PLAN"))
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
    /// and this counts the rows directly, as the SQLite store does.
    #[tokio::test]
    async fn deleting_a_bookmark_leaves_no_attachment_rows_behind() {
        let Some(db) = postgres_backend().await else {
            return;
        };
        let store = store(&db);
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
            .fetch_one(db.backend.pool())
            .await
            .unwrap();
        assert_eq!(remaining, 0, "the attachments went with the bookmark");
    }

    /// The written view reaches the column as JSON rather than as text.
    /// A `JSONB` column refuses a bound `String`, so this is the one
    /// binding the two SQL stores cannot share, and the refusal is silent
    /// in the sense that nothing but a write proves the bind was right.
    #[tokio::test]
    async fn the_view_is_written_as_json_not_as_text() {
        let Some(db) = postgres_backend().await else {
            return;
        };
        let store = store(&db);
        let created = store
            .create(
                "json",
                "author@example.com",
                "Author",
                vec![],
                SavedView::empty([800, 600]),
            )
            .await
            .unwrap();

        // `->>` reaches into the document, which only answers if the
        // column holds a JSON object rather than a string that looks
        // like one.
        let version: Option<String> =
            sqlx::query_scalar("SELECT view_json ->> 'v' FROM bookmarks WHERE id = $1")
                .bind(&created.id)
                .fetch_one(db.backend.pool())
                .await
                .unwrap();
        assert_eq!(version.as_deref(), Some("1"), "the view is a JSON document");
    }
}
