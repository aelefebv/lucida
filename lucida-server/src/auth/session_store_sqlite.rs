//! SQLite-backed `LoginSessionStore`.
//!
//! Slice 2 (PRD #455) opens — and creates if missing — the lucida
//! database file, runs the bundled migrations, and serves session
//! reads/writes from it. The schema and indexes are defined in
//! `migrations/20260508000001_create_login_sessions.sql`; the migration
//! is run idempotently at startup via `sqlx::migrate!`.
//!
//! Connection-pool sizing: a single SQLite file is the bottleneck
//! anyway; default pool of 5 is plenty for the loopback-only deployment
//! shape this slice targets.

use std::path::Path;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use thiserror::Error;

use super::session_store::{LoginSession, LoginSessionStore, SessionStoreError};

/// Migrations bundled into the binary at compile time. Adding a new
/// `.sql` file to `migrations/` and rebuilding picks it up.
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Errors from opening the database. Distinct from `SessionStoreError`
/// because they only occur during startup; the boot path needs them
/// before the store handle exists.
#[derive(Debug, Error)]
pub enum StoreOpenError {
    #[error("failed to open SQLite at {0}: {1}")]
    Connect(String, sqlx::Error),
    #[error("migration failed: {0}")]
    Migrate(sqlx::migrate::MigrateError),
}

/// Production session store. Wraps a `SqlitePool` and runs queries
/// against it. The pool is `Clone` so this struct is cheap to share.
#[derive(Debug, Clone)]
pub struct SqliteSessionStore {
    pool: SqlitePool,
}

impl SqliteSessionStore {
    /// Open (or create) a SQLite file at `path`, run any pending
    /// migrations, and return a ready-to-use store. Idempotent: calling
    /// twice on the same file is harmless.
    pub async fn open(path: &Path) -> Result<Self, StoreOpenError> {
        let path_str = path.display().to_string();
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            // WAL keeps readers and the touch-writer non-blocking
            // relative to each other; the touch fire-and-forget would
            // otherwise occasionally serialize behind a long read.
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await
            .map_err(|e| StoreOpenError::Connect(path_str, e))?;

        MIGRATOR.run(&pool).await.map_err(StoreOpenError::Migrate)?;

        Ok(Self { pool })
    }

    /// Tests construct an in-memory pool by passing `":memory:"` as the
    /// path. `:memory:` databases are scoped to the connection that
    /// opened them, so we cap the pool at 1 and disable idle eviction
    /// (`min_connections = 1`) so the schema persists for the lifetime
    /// of the store.
    pub async fn open_in_memory() -> Result<Self, StoreOpenError> {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .idle_timeout(None)
            .max_lifetime(None)
            .connect_with(opts)
            .await
            .map_err(|e| StoreOpenError::Connect(":memory:".into(), e))?;

        MIGRATOR.run(&pool).await.map_err(StoreOpenError::Migrate)?;

        Ok(Self { pool })
    }

    /// Borrow the underlying connection pool. Slice 4 (PRD #455)
    /// derives `SqlitePendingAuthStore` from the same pool so both
    /// stores share a single SQLite file + connection budget.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
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
    use chrono::Duration as ChronoDuration;

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
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
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
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
        let now = Utc::now();
        store.create(sample("a", now, 24)).await.unwrap();

        let later = now + ChronoDuration::seconds(120);
        store.touch_last_used("a", later).await.unwrap();
        let got = store.get("a").await.unwrap().unwrap();
        assert!((got.last_used_at - later).num_milliseconds().abs() < 1);
    }

    #[tokio::test]
    async fn delete_expired_removes_only_past_rows() {
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
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
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
        let now = Utc::now();
        store.create(sample("a", now, 1)).await.unwrap();
        store.delete("a").await.unwrap();
        store.delete("a").await.unwrap();
        assert!(store.get("a").await.unwrap().is_none());
    }

    /// Smoke test for the production "mint a session per request" path:
    /// 16 concurrent inserts with UUID v4 ids must all land successfully
    /// and produce 16 distinct rows. (Slice 2's dev-login + slice 4's
    /// OAuth callback each call `create()` with a fresh UUID per call.)
    #[tokio::test]
    async fn parallel_inserts_produce_distinct_ids() {
        let store = SqliteSessionStore::open_in_memory().await.unwrap();
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
