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

use async_trait::async_trait;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use super::url::DatabaseUrl;
use super::{PingError, StorageBackend, StorageError, log_archived_bookmarks};
use crate::auth::{
    BearerTokenStore, CliTokenAuthorizationStore, LoginSessionStore, PendingAuthStore,
    SqliteBearerTokenStore, SqliteCliTokenAuthorizationStore, SqlitePendingAuthStore,
    SqliteSessionStore,
};
use crate::inbox::{InboxStore, SqliteInboxStore};
use crate::workspace::{SqliteWorkspaceStore, WorkspaceStore};

/// Migrations bundled into the binary at compile time. One baseline
/// creates the whole schema; a later change is another `.sql` file beside
/// it, picked up by rebuilding.
///
/// Each backend has its own directory under `migrations/`, because a
/// schema cannot be written once for two engines that do not agree on
/// what a timestamp is.
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

        let migrate_failed = |e: sqlx::Error| StorageError::Migrate {
            target: target.clone(),
            reason: e.to_string(),
        };
        let archived_bookmarks = bookmarks_to_archive(&pool).await.map_err(migrate_failed)?;
        MIGRATOR
            .run(&pool)
            .await
            .map_err(|e| StorageError::Migrate {
                target: target.clone(),
                reason: e.to_string(),
            })?;
        log_archived_bookmarks(&target, archived_bookmarks);

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

/// The bookmark rows the `archive_bookmarks` migration is about to set
/// aside, or `None` where there is no live bookmark table: a fresh
/// database, or one that already archived it.
async fn bookmarks_to_archive(pool: &SqlitePool) -> Result<Option<i64>, sqlx::Error> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bookmarks')",
    )
    .fetch_one(pool)
    .await?;
    if !exists {
        return Ok(None);
    }
    sqlx::query_scalar("SELECT COUNT(*) FROM bookmarks")
        .fetch_one(pool)
        .await
        .map(Some)
}

/// Every accessor builds a fresh handle over the shared pool. The
/// stores hold nothing but that handle, so this costs a pool clone and
/// the handles are interchangeable.
#[async_trait]
impl StorageBackend for SqliteStorageBackend {
    async fn ping(&self) -> Result<(), PingError> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(PingError::new)
    }

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

    fn workspaces(&self) -> Arc<dyn WorkspaceStore> {
        Arc::new(SqliteWorkspaceStore::new(self.pool.clone()))
    }

    fn inbox(&self) -> Arc<dyn InboxStore> {
        Arc::new(SqliteInboxStore::new(self.pool.clone()))
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
        let orphaned = sqlx::query(
            "INSERT INTO workspace_members (workspace_id, email, role, added_at) \
             VALUES (?, ?, 'viewer', '2026-01-02T03:04:05Z')",
        )
        .bind("no-such-workspace")
        .bind("dev@example.com")
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

    /// The one SQLite behavior the shared statements rest on: sqlx's SQLite
    /// driver binds argument N to `$N` by the number in the name, not by
    /// order of appearance. The shared statements number in order and
    /// repeat nothing, so this is where the behavior is pinned.
    #[tokio::test]
    async fn numbered_placeholders_bind_by_number() {
        let backend = SqliteStorageBackend::open_in_memory().await.unwrap();
        sqlx::query(
            "INSERT INTO pending_auth (state_token, intended_path, intended_hash, created_at) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind("token")
        .bind("/w/demo")
        .bind("#v=1")
        .bind(Utc::now())
        .execute(backend.pool())
        .await
        .unwrap();

        // The placeholders are out of order, so this matches only if the
        // numbers won over the positions: by position, the driver would
        // look for a token spelled `#v=1`.
        let by_number: Option<String> = sqlx::query_scalar(
            "SELECT intended_path FROM pending_auth \
             WHERE intended_hash = $2 AND state_token = $1",
        )
        .bind("token")
        .bind("#v=1")
        .fetch_optional(backend.pool())
        .await
        .unwrap();
        assert_eq!(by_number.as_deref(), Some("/w/demo"));

        // A placeholder used twice takes one argument, as it does on
        // PostgreSQL, rather than consuming a second.
        let repeated: Option<String> = sqlx::query_scalar(
            "SELECT intended_path FROM pending_auth \
             WHERE state_token = $1 OR intended_path = $1",
        )
        .bind("token")
        .fetch_optional(backend.pool())
        .await
        .unwrap();
        assert_eq!(repeated.as_deref(), Some("/w/demo"));
    }

    /// A JSON column carries JSON. SQLite has no type that says so, so the
    /// schema says it with a check, and the check is only worth writing if
    /// it refuses something.
    #[tokio::test]
    async fn a_json_column_refuses_text_that_is_not_json() {
        let backend = SqliteStorageBackend::open_in_memory().await.unwrap();
        let refused = sqlx::query(
            r#"
            INSERT INTO workspaces
                (id, name, created_by, created_at, updated_at, document_json)
            VALUES ('w', 'Workspace', 'dev@example.com', '2026-01-02T03:04:05Z',
                    '2026-01-02T03:04:05Z', 'not json')
            "#,
        )
        .execute(backend.pool())
        .await;
        assert!(
            refused.is_err(),
            "document_json must hold JSON, not any text"
        );
    }

    /// A database from before the archive still holds its bookmark rows. The
    /// open that archives the tables counts the rows first, which is the
    /// number it logs, and keeps every row under the archived name.
    #[tokio::test]
    async fn opening_archives_the_bookmark_tables_after_counting_their_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lucida.db");
        let url = DatabaseUrl::parse(&format!("sqlite://{}", path.display())).unwrap();
        {
            let options = SqliteConnectOptions::from_str(url.as_str())
                .unwrap()
                .create_if_missing(true);
            let pool = SqlitePoolOptions::new()
                .connect_with(options)
                .await
                .unwrap();
            let mut before_archive = sqlx::migrate!("./migrations/sqlite");
            before_archive.migrations = before_archive
                .migrations
                .iter()
                .filter(|m| !m.description.contains("archive bookmarks"))
                .cloned()
                .collect::<Vec<_>>()
                .into();
            before_archive.run(&pool).await.unwrap();
            for id in ["a", "b"] {
                sqlx::query(
                    "INSERT INTO bookmarks \
                     (id, name, created_by, created_by_name, created_at, view_json) \
                     VALUES (?, 'Bookmark', 'dev@example.com', 'Dev', \
                     '2026-01-02T03:04:05Z', '{\"v\":1}')",
                )
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO bookmark_datasets (bookmark_id, dataset_url) \
                     VALUES (?, 'file:///data/a.zarr')",
                )
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
            }
            assert_eq!(bookmarks_to_archive(&pool).await.unwrap(), Some(2));
            pool.close().await;
        }

        let backend = SqliteStorageBackend::open(&url).await.unwrap();
        assert_eq!(bookmarks_to_archive(backend.pool()).await.unwrap(), None);
        for (live, archived) in [
            ("bookmarks", "archived_bookmarks"),
            ("bookmark_datasets", "archived_bookmark_datasets"),
        ] {
            let gone = sqlx::query(&format!("SELECT 1 FROM {live}"))
                .fetch_optional(backend.pool())
                .await;
            assert!(gone.is_err(), "{live} is renamed away");
            let kept: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {archived}"))
                .fetch_one(backend.pool())
                .await
                .unwrap();
            assert_eq!(kept, 2, "{archived} keeps every row");
        }
        // The child table's foreign key follows its parent to the new name.
        let orphan = sqlx::query(
            "INSERT INTO archived_bookmark_datasets (bookmark_id, dataset_url) \
             VALUES ('no-such-bookmark', 'file:///data/a.zarr')",
        )
        .execute(backend.pool())
        .await;
        assert!(
            orphan.is_err(),
            "the archived child still references its parent"
        );
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
