//! PostgreSQL-backed `PendingAuthStore`.
//!
//! Shares the PostgreSQL pool that [`crate::storage`] opened, as every
//! PostgreSQL store does.
//!
//! Read this beside `pending_auth_sqlite`. The two are the same code
//! apart from the pool type and the placeholder spelling — `$1` here,
//! `?` there — and keeping them that way is the point: the difference a
//! reader has to hold is one line per query, not a dialect. ADR-0058
//! records why the SQL text is duplicated rather than shared.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};

use super::pending_auth::{PendingAuth, PendingAuthStore, PendingAuthStoreError};

/// PostgreSQL pending-auth store. Holds a `PgPool` clone, so it is cheap
/// to build and cheap to share.
#[derive(Debug, Clone)]
pub struct PostgresPendingAuthStore {
    pool: PgPool,
}

impl PostgresPendingAuthStore {
    /// Build the store from an already-opened pool. The migrator does
    /// not run here: the storage backend runs it once, before any store
    /// exists.
    pub(crate) fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

fn map_err(e: sqlx::Error) -> PendingAuthStoreError {
    PendingAuthStoreError::Backend(e.to_string())
}

#[async_trait]
impl PendingAuthStore for PostgresPendingAuthStore {
    async fn insert(&self, row: PendingAuth) -> Result<(), PendingAuthStoreError> {
        sqlx::query(
            r#"
            INSERT INTO pending_auth (state_token, intended_path, intended_hash, created_at)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(&row.state_token)
        .bind(&row.intended_path)
        .bind(&row.intended_hash)
        .bind(row.created_at)
        .execute(&self.pool)
        .await
        .map_err(map_err)?;
        Ok(())
    }

    async fn consume(
        &self,
        state_token: &str,
    ) -> Result<Option<PendingAuth>, PendingAuthStoreError> {
        // DELETE ... RETURNING is atomic here for the same reason it is
        // in SQLite: the row is handed back by the statement that removed
        // it, so two callers racing on one token cannot both be served.
        // PostgreSQL adds a wrinkle SQLite does not have — a concurrent
        // DELETE sees the row, blocks on its lock, then re-checks the
        // WHERE clause under READ COMMITTED and matches nothing — and it
        // lands on the same answer.
        let row = sqlx::query(
            r#"
            DELETE FROM pending_auth
            WHERE state_token = $1
            RETURNING state_token, intended_path, intended_hash, created_at
            "#,
        )
        .bind(state_token)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_err)?;

        Ok(row.map(|r| PendingAuth {
            state_token: r.get("state_token"),
            intended_path: r.get("intended_path"),
            intended_hash: r.get("intended_hash"),
            created_at: r.get("created_at"),
        }))
    }

    async fn delete_expired(
        &self,
        older_than: DateTime<Utc>,
    ) -> Result<u64, PendingAuthStoreError> {
        let result = sqlx::query("DELETE FROM pending_auth WHERE created_at < $1")
            .bind(older_than)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(result.rows_affected())
    }
}
