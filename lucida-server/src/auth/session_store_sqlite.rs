//! SQLite-backed `LoginSessionStore`.
//!
//! Serves session reads and writes from the pool the SQLite storage
//! backend opened. The schema and indexes are defined in
//! `migrations/20260508000001_create_login_sessions.sql`.
//!
//! Connecting and migrating belong to [`crate::storage`], not here. A
//! store that opened its own database would be the only one that could,
//! and the other five would have to borrow its pool — which is the
//! arrangement the storage backend replaced.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use super::session_store::{LoginSession, LoginSessionStore, SessionStoreError};

/// Production session store. Wraps a `SqlitePool` and runs queries
/// against it. The pool is `Clone` so this struct is cheap to share.
#[derive(Debug, Clone)]
pub struct SqliteSessionStore {
    pool: SqlitePool,
}

impl SqliteSessionStore {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn map_err(e: sqlx::Error) -> SessionStoreError {
    SessionStoreError::Backend(e.to_string())
}

#[async_trait]
impl LoginSessionStore for SqliteSessionStore {
    async fn create(&self, session: LoginSession) -> Result<(), SessionStoreError> {
        sqlx::query(
            r#"
            INSERT INTO login_sessions
                (id, email, display_name, picture_url, created_at, last_used_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&session.id)
        .bind(&session.email)
        .bind(&session.display_name)
        .bind(&session.picture_url)
        .bind(session.created_at)
        .bind(session.last_used_at)
        .bind(session.expires_at)
        .execute(&self.pool)
        .await
        .map_err(map_err)?;
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<Option<LoginSession>, SessionStoreError> {
        let row = sqlx::query(
            r#"
            SELECT id, email, display_name, picture_url, created_at, last_used_at, expires_at
            FROM login_sessions
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(map_err)?;

        Ok(row.map(|r| LoginSession {
            id: r.get("id"),
            email: r.get("email"),
            display_name: r.get("display_name"),
            picture_url: r.get("picture_url"),
            created_at: r.get("created_at"),
            last_used_at: r.get("last_used_at"),
            expires_at: r.get("expires_at"),
        }))
    }

    async fn touch_last_used(&self, id: &str, now: DateTime<Utc>) -> Result<(), SessionStoreError> {
        // Affecting 0 rows is fine: the session might have been deleted
        // between extractor lookup and this update. Race-and-tolerate.
        sqlx::query("UPDATE login_sessions SET last_used_at = ? WHERE id = ?")
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<(), SessionStoreError> {
        sqlx::query("DELETE FROM login_sessions WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(())
    }

    async fn delete_expired(&self, now: DateTime<Utc>) -> Result<u64, SessionStoreError> {
        let result = sqlx::query("DELETE FROM login_sessions WHERE expires_at <= ?")
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(result.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SqliteStorageBackend;
    use chrono::Duration as ChronoDuration;

    /// A store over a migrated in-memory database, opened the way
    /// production opens one.
    async fn fresh_store() -> SqliteSessionStore {
        let backend = SqliteStorageBackend::open_in_memory().await.unwrap();
        SqliteSessionStore::new(backend.pool().clone())
    }

    fn sample(id: &str, now: DateTime<Utc>, expires_in_hours: i64) -> LoginSession {
        LoginSession {
            id: id.to_string(),
            email: "dev@local".to_string(),
            display_name: "Local Dev".to_string(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + ChronoDuration::hours(expires_in_hours),
        }
    }

    #[tokio::test]
    async fn migrations_run_and_roundtrip_works() {
        let store = fresh_store().await;
        let now = Utc::now();
        let s = sample("uuid-a", now, 24);
        store.create(s.clone()).await.unwrap();

        let got = store.get("uuid-a").await.unwrap().unwrap();
        assert_eq!(got.id, s.id);
        assert_eq!(got.email, s.email);
        assert_eq!(got.display_name, s.display_name);
        assert_eq!(got.picture_url, s.picture_url);
        // Timestamps roundtrip with <1s precision (TIMESTAMP storage):
        // we wrote and read on the same machine so equality is fine,
        // but compare with millisecond tolerance to be defensive.
        assert!((got.created_at - s.created_at).num_milliseconds().abs() < 1);
    }

    #[tokio::test]
    async fn touch_last_used_updates_row() {
        let store = fresh_store().await;
        let now = Utc::now();
        store.create(sample("a", now, 24)).await.unwrap();

        let later = now + ChronoDuration::seconds(120);
        store.touch_last_used("a", later).await.unwrap();
        let got = store.get("a").await.unwrap().unwrap();
        assert!((got.last_used_at - later).num_milliseconds().abs() < 1);
    }

    #[tokio::test]
    async fn delete_expired_removes_only_past_rows() {
        let store = fresh_store().await;
        let now = Utc::now();
        store.create(sample("dead", now, -1)).await.unwrap();
        store.create(sample("alive", now, 24)).await.unwrap();

        let removed = store.delete_expired(now).await.unwrap();
        assert_eq!(removed, 1);
        assert!(store.get("dead").await.unwrap().is_none());
        assert!(store.get("alive").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn delete_is_idempotent() {
        let store = fresh_store().await;
        let now = Utc::now();
        store.create(sample("a", now, 1)).await.unwrap();
        store.delete("a").await.unwrap();
        store.delete("a").await.unwrap();
        assert!(store.get("a").await.unwrap().is_none());
    }

    /// Smoke test for the production "mint a session per request" path:
    /// 16 concurrent inserts with UUID v4 ids must all land successfully
    /// and produce 16 distinct rows. (The OAuth callback calls
    /// `create()` with a fresh UUID per call.)
    #[tokio::test]
    async fn parallel_inserts_produce_distinct_ids() {
        let store = fresh_store().await;
        let now = Utc::now();

        let mut handles = Vec::new();
        for _ in 0..16 {
            let store = store.clone();
            handles.push(tokio::spawn(async move {
                let id = uuid::Uuid::new_v4().to_string();
                store.create(sample(&id, now, 24)).await.unwrap();
                id
            }));
        }
        let mut ids = std::collections::HashSet::new();
        for h in handles {
            ids.insert(h.await.unwrap());
        }
        assert_eq!(ids.len(), 16);

        let removed = store
            .delete_expired(now + chrono::Duration::hours(48))
            .await
            .unwrap();
        assert_eq!(removed, 16);
    }
}
