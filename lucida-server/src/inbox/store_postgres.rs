//! PostgreSQL-backed [`InboxStore`].
//!
//! The SQLite store's twin. It runs the same statements from
//! [`super::store_sql`] and binds the same values: the timestamps are
//! `TIMESTAMPTZ` here and RFC 3339 text there, but both decode to
//! `DateTime<Utc>`, and both payload columns are text on either engine
//! because the inbox stores bytes rather than a parsed value. See
//! ADR-0058 for why the Rust is duplicated rather than shared.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};

use super::store::{InboxBundle, InboxEntry, InboxStore, NewInboxEntry, StoreError};
use super::store_sql::{self as sql, map_err};

/// Production store. Wraps the `PgPool` the storage backend opened.
#[derive(Debug, Clone)]
pub struct PostgresInboxStore {
    pool: PgPool,
}

impl PostgresInboxStore {
    /// Build the store from an already-opened pool. The migrator does
    /// not run here: the storage backend runs it once, before any store
    /// exists.
    pub(crate) fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl InboxStore for PostgresInboxStore {
    async fn put(&self, entry: NewInboxEntry<'_>) -> Result<InboxEntry, StoreError> {
        let stored = InboxEntry {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: entry.workspace_id.to_string(),
            sent_by: entry.sent_by.to_string(),
            sent_by_name: entry.sent_by_name.to_string(),
            sent_at: entry.sent_at,
            expires_at: entry.expires_at,
            size_bytes: entry.bundle_json.len() as i64,
            header_json: entry.header_json.to_string(),
        };
        sqlx::query(sql::INSERT)
            .bind(&stored.id)
            .bind(&stored.workspace_id)
            .bind(&stored.sent_by)
            .bind(&stored.sent_by_name)
            .bind(stored.sent_at)
            .bind(stored.expires_at)
            .bind(stored.size_bytes)
            .bind(&stored.header_json)
            .bind(entry.bundle_json)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        // The one moment the table grows is the one moment it is swept.
        self.delete_expired(entry.sent_at).await?;
        Ok(stored)
    }

    async fn list(
        &self,
        workspace_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Vec<InboxEntry>, StoreError> {
        let rows = sqlx::query(sql::SELECT_LIST)
            .bind(workspace_id)
            .bind(now)
            .fetch_all(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(rows.iter().map(row_to_entry).collect())
    }

    async fn fetch(
        &self,
        workspace_id: &str,
        entry_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<InboxBundle>, StoreError> {
        let row = sqlx::query(sql::SELECT_ONE)
            .bind(workspace_id)
            .bind(entry_id)
            .bind(now)
            .fetch_optional(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(row.map(|row| InboxBundle {
            entry: row_to_entry(&row),
            bundle_json: row.get("bundle_json"),
        }))
    }

    async fn delete_expired(&self, now: DateTime<Utc>) -> Result<u64, StoreError> {
        let result = sqlx::query(sql::DELETE_EXPIRED)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(result.rows_affected())
    }
}

fn row_to_entry(row: &sqlx::postgres::PgRow) -> InboxEntry {
    InboxEntry {
        id: row.get("id"),
        workspace_id: row.get("workspace_id"),
        sent_by: row.get("sent_by"),
        sent_by_name: row.get("sent_by_name"),
        sent_at: row.get("sent_at"),
        expires_at: row.get("expires_at"),
        size_bytes: row.get("size_bytes"),
        header_json: row.get("header_json"),
    }
}
