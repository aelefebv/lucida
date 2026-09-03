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
