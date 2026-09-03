//! SQLite-backed `PendingAuthStore`.
//!
//! Shares the SQLite file and pool that [`crate::storage`] opened, as
//! every SQLite store does.
//!
//! The statements come from [`super::pending_auth_sql`], which the
//! PostgreSQL store runs too, so this module holds the binding and the
//! row mapping and no SQL of its own.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use super::pending_auth::{PendingAuth, PendingAuthStore, PendingAuthStoreError};
use super::pending_auth_sql as sql;

/// Production pending-auth store. Holds a `SqlitePool` clone, so it is
/// cheap to build and cheap to share.
#[derive(Debug, Clone)]
pub struct SqlitePendingAuthStore {
    pool: SqlitePool,
}

impl SqlitePendingAuthStore {
    /// Build the store from an already-opened pool. The migrator does
    /// not run here: the storage backend runs it once, before any store
    /// exists.
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn map_err(e: sqlx::Error) -> PendingAuthStoreError {
    PendingAuthStoreError::Backend(e.to_string())
}

#[async_trait]
impl PendingAuthStore for SqlitePendingAuthStore {
    async fn insert(&self, row: PendingAuth) -> Result<(), PendingAuthStoreError> {
        sqlx::query(sql::INSERT)
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
        let row = sqlx::query(sql::CONSUME)
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
        let result = sqlx::query(sql::DELETE_EXPIRED)
            .bind(older_than)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(result.rows_affected())
    }
}
