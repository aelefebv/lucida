//! SQLite storage backend.
//!
//! Opens the database named by a `sqlite:` connection string, creating
//! the file if it is missing, runs the bundled migrations, and serves
//! all six stores from the one pool.
//!
//! This module is the only place in the server that names a SQLite
//! type. Everything above it works through [`StorageBackend`] and the
//! six store traits.

use std::str::FromStr;
use std::sync::Arc;

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use super::url::DatabaseUrl;
use super::{StorageBackend, StorageError};
use crate::auth::{
    BearerTokenStore, CliTokenAuthorizationStore, LoginSessionStore, PendingAuthStore,
    SqliteBearerTokenStore, SqliteCliTokenAuthorizationStore, SqlitePendingAuthStore,
    SqliteSessionStore,
};
use crate::bookmarks::{BookmarkStore, SqliteBookmarkStore};
use crate::workspace::{SqliteWorkspaceStore, WorkspaceStore};

/// Migrations bundled into the binary at compile time. One baseline
/// creates the whole schema; a later change is another `.sql` file beside
/// it, picked up by rebuilding.
///
/// Each backend has its own directory under `migrations/`, because a
/// schema cannot be written once for two engines that do not agree on
/// what a timestamp is. See ADR-0058.
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/sqlite");

/// Connections for a file-backed database. A single SQLite file
/// serializes writes anyway, so a small pool is all the parallelism
/// there is to have.
const FILE_MAX_CONNECTIONS: u32 = 5;

/// Whether a connection string asks for an in-memory database.
///
/// The question has to be answered from the string, not from the parsed
/// options: sqlx knows the answer but keeps it private, and it rewrites
/// the filename to `file:sqlx-in-memory-N`, so `get_filename` cannot be
/// asked either. These are the two spellings sqlx itself recognizes.
fn wants_memory(raw: &str) -> bool {
    // `DatabaseUrl::parse` has already lowercased the scheme, so a
    // literal strip is enough. The longer prefix goes first.
    let rest = raw
        .strip_prefix("sqlite://")
        .or_else(|| raw.strip_prefix("sqlite:"))
        .unwrap_or(raw);
    let (database, params) = match rest.split_once('?') {
        Some((database, params)) => (database, Some(params)),
        None => (rest, None),
    };
    database == ":memory:" || params.is_some_and(|p| p.split('&').any(|pair| pair == "mode=memory"))
}

#[derive(Debug, Clone)]
pub struct SqliteStorageBackend {
    pool: SqlitePool,
}

impl SqliteStorageBackend {
    /// Open the database, run any pending migrations, and return a
    /// ready backend. Idempotent: opening the same file twice is
    /// harmless.
    pub async fn open(url: &DatabaseUrl) -> Result<Self, StorageError> {
        let target = url.redacted().into_owned();
        let parsed =
            SqliteConnectOptions::from_str(url.as_str()).map_err(|e| StorageError::Connect {
                target: target.clone(),
                reason: e.to_string(),
            })?;
        let in_memory = wants_memory(url.as_str());

        let base_options = parsed
            .create_if_missing(true)
            // SQLite ignores foreign keys unless a connection asks for
            // them, and the schema declares every cascade, so asking is
            // what makes those declarations load-bearing. Set here rather
            // than left to the driver: sqlx turns this on by default
            // today, but a default is not a guarantee, and it would lose
            // to a connection string that spelled `foreign_keys=off`.
            .foreign_keys(true);

        let opts = if in_memory {
            base_options
        } else {
            // Write-ahead logging keeps readers and the
            // fire-and-forget session touch-writer from blocking
            // each other. An in-memory database has no journal to
            // write, so it is skipped there rather than set and
            // quietly ignored.
            base_options.journal_mode(SqliteJournalMode::Wal)
        };

        // sqlx reaches an in-memory database through a shared cache, so
        // it survives as long as some connection holds it open — and
        // vanishes, schema and all, once the last one closes. Pin one
        // connection open for the life of the backend so ordinary idle
        // reaping cannot empty the database mid-run.
        let pool_opts = if in_memory {
            SqlitePoolOptions::new()
                .max_connections(1)
                .min_connections(1)
                .idle_timeout(None)
                .max_lifetime(None)
        } else {
            SqlitePoolOptions::new().max_connections(FILE_MAX_CONNECTIONS)
        };

        let pool = pool_opts
            .connect_with(opts)
            .await
            .map_err(|e| StorageError::Connect {
                target: target.clone(),
                reason: e.to_string(),
            })?;

        MIGRATOR
            .run(&pool)
            .await
            .map_err(|e| StorageError::Migrate {
                target,
                reason: e.to_string(),
            })?;

        Ok(Self { pool })
    }

    /// A migrated in-memory database. Unit tests that need the pool
    /// itself go through this rather than assembling their own.
    #[cfg(test)]
    pub(crate) async fn open_in_memory() -> Result<Self, StorageError> {
        Self::open(&DatabaseUrl::in_memory()).await
    }

    /// The pool behind the stores, for tests that drive SQL directly or
    /// close the pool to provoke a store failure.
    #[cfg(test)]
    pub(crate) fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

/// Every accessor builds a fresh handle over the shared pool. The
/// stores hold nothing but that handle, so this costs a pool clone and
/// the handles are interchangeable.
impl StorageBackend for SqliteStorageBackend {
    fn login_sessions(&self) -> Arc<dyn LoginSessionStore> {
        Arc::new(SqliteSessionStore::new(self.pool.clone()))
    }

    fn pending_auth(&self) -> Arc<dyn PendingAuthStore> {
        Arc::new(SqlitePendingAuthStore::new(self.pool.clone()))
    }

    fn bearer_tokens(&self) -> Arc<dyn BearerTokenStore> {
        Arc::new(SqliteBearerTokenStore::new(self.pool.clone()))
    }

    fn cli_token_authorizations(&self) -> Arc<dyn CliTokenAuthorizationStore> {
        Arc::new(SqliteCliTokenAuthorizationStore::new(self.pool.clone()))
    }

    fn bookmarks(&self) -> Arc<dyn BookmarkStore> {
        Arc::new(SqliteBookmarkStore::new(self.pool.clone()))
    }

    fn workspaces(&self) -> Arc<dyn WorkspaceStore> {
        Arc::new(SqliteWorkspaceStore::new(self.pool.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::LoginSession;
    use chrono::Utc;

    #[test]
    fn in_memory_spellings_are_recognized() {
        for raw in [
            "sqlite::memory:",
            "sqlite://:memory:",
            "sqlite://lucida.db?mode=memory",
            "sqlite://lucida.db?cache=shared&mode=memory",
        ] {
            assert!(wants_memory(raw), "{raw} should be in-memory");
        }
        for raw in [
            "sqlite://lucida.db",
            "sqlite:lucida.db",
            "sqlite:///var/lib/lucida/lucida.db",
            "sqlite://memory.db",
        ] {
            assert!(!wants_memory(raw), "{raw} should be file-backed");
        }
    }

    #[tokio::test]
    async fn opening_runs_the_migrations() {
        let backend = SqliteStorageBackend::open_in_memory().await.unwrap();
        // A table only the migrations create.
        sqlx::query("SELECT id FROM login_sessions LIMIT 1")
            .fetch_optional(backend.pool())
            .await
            .unwrap();
    }

    /// The schema states its cascades, and SQLite honors them only on a
    /// connection that asked. A row whose parent never existed is the
    /// cheapest thing to ask for: it can only be refused when enforcement
    /// is on.
    #[tokio::test]
    async fn every_connection_enforces_foreign_keys() {
        let backend = SqliteStorageBackend::open_in_memory().await.unwrap();
        let orphaned =
            sqlx::query("INSERT INTO bookmark_datasets (bookmark_id, dataset_url) VALUES (?, ?)")
                .bind("no-such-bookmark")
                .bind("file:///data/a.zarr")
                .execute(backend.pool())
                .await;
        assert!(
            orphaned.is_err(),
            "a child row with no parent must be refused",
        );

        // A file-backed database takes a different options path, and its
        // pool hands out more than one connection. Hold them all at once
        // so the pragma is read on each rather than on whichever one the
        // pool happened to reuse.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lucida.db");
        let url = DatabaseUrl::parse(&format!("sqlite://{}", path.display())).unwrap();
        let on_disk = SqliteStorageBackend::open(&url).await.unwrap();
        let mut held = Vec::new();
        for _ in 0..FILE_MAX_CONNECTIONS {
            let mut connection = on_disk.pool().acquire().await.unwrap();
            let enforced: bool = sqlx::query_scalar("PRAGMA foreign_keys")
                .fetch_one(&mut *connection)
                .await
                .unwrap();
            assert!(enforced, "every pooled connection enforces foreign keys");
            held.push(connection);
        }
    }

    /// A JSON column carries JSON. SQLite has no type that says so, so the
    /// schema says it with a check, and the check is only worth writing if
    /// it refuses something.
    #[tokio::test]
    async fn a_json_column_refuses_text_that_is_not_json() {
        let backend = SqliteStorageBackend::open_in_memory().await.unwrap();
        let refused = sqlx::query(
            r#"
            INSERT INTO bookmarks
                (id, name, created_by, created_by_name, created_at, view_json)
            VALUES ('b', 'Bookmark', 'dev@example.com', 'Dev', '2026-01-02T03:04:05Z', 'not json')
            "#,
        )
        .execute(backend.pool())
        .await;
        assert!(refused.is_err(), "view_json must hold JSON, not any text");
    }

    #[tokio::test]
    async fn the_stores_share_one_database() {
        let backend = SqliteStorageBackend::open_in_memory().await.unwrap();
        let now = Utc::now();
        backend
            .login_sessions()
            .create(LoginSession {
                id: "session-a".to_string(),
                email: "dev@example.com".to_string(),
                display_name: "Dev".to_string(),
                picture_url: None,
                created_at: now,
                last_used_at: now,
                expires_at: now + chrono::Duration::hours(1),
            })
            .await
            .unwrap();

        let found = backend.login_sessions().get("session-a").await.unwrap();
        assert_eq!(found.unwrap().email, "dev@example.com");
    }

    #[tokio::test]
    async fn a_file_database_is_created_on_demand() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lucida.db");
        let url = DatabaseUrl::parse(&format!("sqlite://{}", path.display())).unwrap();

        let backend = SqliteStorageBackend::open(&url).await.unwrap();
        assert!(path.exists());

        // Reopening the same file is the restart case: it must migrate
        // idempotently rather than fail on an already-applied version.
        drop(backend);
        SqliteStorageBackend::open(&url).await.unwrap();
    }

    #[tokio::test]
    async fn a_file_database_keeps_its_rows_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lucida.db");
        let url = DatabaseUrl::parse(&format!("sqlite://{}", path.display())).unwrap();
        let now = Utc::now();

        let backend = SqliteStorageBackend::open(&url).await.unwrap();
        backend
            .login_sessions()
            .create(LoginSession {
                id: "durable".to_string(),
                email: "dev@example.com".to_string(),
                display_name: "Dev".to_string(),
                picture_url: None,
                created_at: now,
                last_used_at: now,
                expires_at: now + chrono::Duration::hours(1),
            })
            .await
            .unwrap();
        drop(backend);

        let reopened = SqliteStorageBackend::open(&url).await.unwrap();
        assert!(
            reopened
                .login_sessions()
                .get("durable")
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn an_unreachable_path_is_reported_as_a_connect_failure() {
        let url = DatabaseUrl::parse("sqlite:///nonexistent-directory/lucida.db").unwrap();
        let err = SqliteStorageBackend::open(&url).await.unwrap_err();
        assert!(
            matches!(err, StorageError::Connect { .. }),
            "expected a connect failure, got {err:?}"
        );
        // The message has to name the database, or the operator cannot
        // tell which of several paths was wrong.
        assert!(err.to_string().contains("lucida.db"), "{err}");
    }
}
