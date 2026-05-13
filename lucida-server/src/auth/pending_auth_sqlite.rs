//! SQLite-backed `PendingAuthStore`.
//!
//! Slice 4 (PRD #455) — sits next to `SqliteSessionStore`, shares the
//! same SQLite file and pool. Construction reuses the same migrator,
//! so opening either store advances the schema to the latest
//! migration.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use super::pending_auth::{PendingAuth, PendingAuthStore, PendingAuthStoreError};

/// Production pending-auth store. Holds a `SqlitePool` clone so it's
/// cheap to share with the session store; in `main.rs` both stores
/// derive from the same pool.
#[derive(Debug, Clone)]
pub struct SqlitePendingAuthStore {
    pool: SqlitePool,
}

impl SqlitePendingAuthStore {
    /// Build the store from an already-opened pool. We don't rerun the
    /// migrator here — the session store opens it once at boot and
    /// every store from then on rides the same connection pool.
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn map_err(e: sqlx::Error) -> PendingAuthStoreError {
    PendingAuthStoreError::Backend(e.to_string())
}

#[async_trait]
impl PendingAuthStore for SqlitePendingAuthStore {
    async fn insert(&self, row: PendingAuth) -> Result<(), PendingAuthStoreError> {
        sqlx::query(
            r#"
            INSERT INTO pending_auth (state_token, intended_path, intended_hash, created_at)
            VALUES (?, ?, ?, ?)
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
        // SQLite supports DELETE ... RETURNING since 3.35; sqlx ships
        // with a recent-enough libsqlite. Fetch_optional returns the
        // pre-delete row in the deletion's atomic step, which is the
        // single-use guarantee the trait promises.
        let row = sqlx::query(
            r#"
            DELETE FROM pending_auth
            WHERE state_token = ?
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
        let result = sqlx::query("DELETE FROM pending_auth WHERE created_at < ?")
            .bind(older_than)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(result.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::session_store_sqlite::SqliteSessionStore;
    use chrono::Duration as ChronoDuration;

    /// Open both stores against the same in-memory pool. Mirrors what
    /// `main.rs` will do: SqliteSessionStore::open_in_memory runs the
    /// migrator, then we derive a SqlitePendingAuthStore from the same
    /// pool. Tests reuse the helper through this constructor.
    async fn fresh_store() -> (SqliteSessionStore, SqlitePendingAuthStore) {
        let session = SqliteSessionStore::open_in_memory().await.unwrap();
        let pending = SqlitePendingAuthStore::new(session.pool().clone());
        (session, pending)
    }

    fn sample(token: &str, path: &str, hash: &str, now: DateTime<Utc>) -> PendingAuth {
        PendingAuth {
            state_token: token.to_string(),
            intended_path: path.to_string(),
            intended_hash: hash.to_string(),
            created_at: now,
        }
    }

    #[tokio::test]
    async fn insert_then_consume_returns_row() {
        let (_session, store) = fresh_store().await;
        let now = Utc::now();
        store
            .insert(sample("tok1", "/foo", "#bar", now))
            .await
            .unwrap();

        let got = store.consume("tok1").await.unwrap().unwrap();
        assert_eq!(got.state_token, "tok1");
        assert_eq!(got.intended_path, "/foo");
        assert_eq!(got.intended_hash, "#bar");
    }

    #[tokio::test]
    async fn second_consume_of_same_token_returns_none() {
        let (_session, store) = fresh_store().await;
        let now = Utc::now();
        store.insert(sample("once", "/", "", now)).await.unwrap();
        assert!(store.consume("once").await.unwrap().is_some());
        assert!(store.consume("once").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn consume_unknown_token_returns_none() {
        let (_session, store) = fresh_store().await;
        assert!(store.consume("ghost").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn duplicate_insert_errors() {
        let (_session, store) = fresh_store().await;
        let now = Utc::now();
        store.insert(sample("dupe", "/", "", now)).await.unwrap();
        let res = store.insert(sample("dupe", "/x", "", now)).await;
        assert!(res.is_err(), "PRIMARY KEY collision should error");
    }

    #[tokio::test]
    async fn delete_expired_removes_only_old_rows() {
        let (_session, store) = fresh_store().await;
        let now = Utc::now();
        store
            .insert(sample("old", "/", "", now - ChronoDuration::minutes(15)))
            .await
            .unwrap();
        store
            .insert(sample("new", "/", "", now - ChronoDuration::seconds(30)))
            .await
            .unwrap();

        let removed = store
            .delete_expired(now - ChronoDuration::minutes(10))
            .await
            .unwrap();
        assert_eq!(removed, 1);
        assert!(store.consume("old").await.unwrap().is_none());
        assert!(store.consume("new").await.unwrap().is_some());
    }
}
