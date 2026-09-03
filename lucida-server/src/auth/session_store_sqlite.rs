//! SQLite-backed `LoginSessionStore`.
//!
//! Serves session reads and writes from the pool the SQLite storage
//! backend opened. The `login_sessions` table and its indexes are defined
//! in the baseline migration.
//!
//! Connecting and migrating belong to [`crate::storage`], not here. A
//! store that opened its own database would be the only one that could,
//! and the other five would have to borrow its pool — which is the
//! arrangement the storage backend replaced.
//!
//! The statements come from [`super::session_store_sql`], which the
//! PostgreSQL store runs too, so this module holds the binding and the
//! row mapping and no SQL of its own. The numbered placeholders in those
//! statements are PostgreSQL's spelling, and
//! `numbered_placeholders_bind_by_number` in [`crate::storage`] is what
//! pins sqlx's SQLite driver to reading them the same way.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

use super::session_store::{LoginSession, LoginSessionStore, SessionStoreError};
use super::session_store_sql::{self as sql, map_err};

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

#[async_trait]
impl LoginSessionStore for SqliteSessionStore {
    async fn create(&self, session: LoginSession) -> Result<(), SessionStoreError> {
        sqlx::query(sql::INSERT)
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
        let row = sqlx::query(sql::SELECT_BY_ID)
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
        sqlx::query(sql::TOUCH_LAST_USED)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<(), SessionStoreError> {
        sqlx::query(sql::DELETE)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(())
    }

    async fn delete_expired(&self, now: DateTime<Utc>) -> Result<u64, SessionStoreError> {
        let result = sqlx::query(sql::DELETE_EXPIRED)
            .bind(now)
            .execute(&self.pool)
            .await
            .map_err(map_err)?;
        Ok(result.rows_affected())
    }
}
