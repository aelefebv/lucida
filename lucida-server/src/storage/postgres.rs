//! PostgreSQL storage backend.
//!
//! Connects to the server named by a `postgres:` connection string, runs
//! the bundled PostgreSQL migrations, and serves all six stores. A
//! deployer selects it with `LUCIDA_DB_URL=postgres://…`, or with the
//! `postgresql://` spelling of the same thing; ADR-0058 records the
//! pattern each store implementation followed.
//!
//! This module is the only place in the server that names a PostgreSQL
//! type. Everything above it works through [`StorageBackend`] and the
//! six store traits.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

use super::url::DatabaseUrl;
use super::{StorageBackend, StorageError};
use crate::auth::{
    BearerTokenStore, CliTokenAuthorizationStore, LoginSessionStore, PendingAuthStore,
    PostgresBearerTokenStore, PostgresCliTokenAuthorizationStore, PostgresPendingAuthStore,
    PostgresSessionStore,
};
use crate::bookmarks::{BookmarkStore, PostgresBookmarkStore};
use crate::workspace::{PostgresWorkspaceStore, WorkspaceStore};

/// Migrations bundled into the binary at compile time, from the
/// PostgreSQL directory. The SQLite baseline is the same schema in the
/// sibling directory; ADR-0058 says why they are two files.
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/postgres");

/// Connections held open against the server.
///
/// A PostgreSQL server serves concurrent writers, so unlike the SQLite
/// backend this number is not pinned by the storage engine. It is sqlx's
/// own default. A deployment that runs several replicas against one
/// server should divide that server's `max_connections` by the replica
/// count and check this against the result.
const MAX_CONNECTIONS: u32 = 10;

/// How long [`PostgresStorageBackend::open`] waits for its first
/// connection.
///
/// A pool does not give up on a refused connection; it retries with
/// backoff until this deadline. sqlx's default is thirty seconds, which
/// is the wrong shape for a startup that reports a storage failure and
/// exits: the platform restarting the process is the retry loop, and a
/// long in-process one only delays the message an operator is waiting
/// for. Three seconds absorbs a database that is up and busy, and is
/// also what an unreachable one costs before it is reported.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
pub struct PostgresStorageBackend {
    pool: PgPool,
}

impl PostgresStorageBackend {
    /// Connect, run any pending migrations, and return a ready backend.
    /// Idempotent: opening the same database twice is harmless, and so is
    /// opening it twice at once — see `concurrent_opens_apply_the_baseline_once`.
    ///
    /// Every failure carries the redacted connection string, because the
    /// operator reading it has nothing else to tell them which database
    /// the server could not bring up.
    pub async fn open(url: &DatabaseUrl) -> Result<Self, StorageError> {
        let target = url.redacted().into_owned();
        let options =
            PgConnectOptions::from_str(url.as_str()).map_err(|e| StorageError::Connect {
                target: target.clone(),
                reason: e.to_string(),
            })?;

        let pool = PgPoolOptions::new()
            .max_connections(MAX_CONNECTIONS)
            .acquire_timeout(CONNECT_TIMEOUT)
            .connect_with(options)
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

    /// The pool behind the store, for tests that drive SQL directly.
    #[cfg(test)]
    pub(crate) fn pool(&self) -> &PgPool {
        &self.pool
    }
}

/// Every accessor builds a fresh handle over the shared pool, exactly as
/// the SQLite backend does: the stores hold nothing but that handle, so
/// this costs a pool clone and the handles are interchangeable.
impl StorageBackend for PostgresStorageBackend {
    fn login_sessions(&self) -> Arc<dyn LoginSessionStore> {
        Arc::new(PostgresSessionStore::new(self.pool.clone()))
    }

    fn pending_auth(&self) -> Arc<dyn PendingAuthStore> {
        Arc::new(PostgresPendingAuthStore::new(self.pool.clone()))
    }

    fn bearer_tokens(&self) -> Arc<dyn BearerTokenStore> {
        Arc::new(PostgresBearerTokenStore::new(self.pool.clone()))
    }

    fn cli_token_authorizations(&self) -> Arc<dyn CliTokenAuthorizationStore> {
        Arc::new(PostgresCliTokenAuthorizationStore::new(self.pool.clone()))
    }

    fn bookmarks(&self) -> Arc<dyn BookmarkStore> {
        Arc::new(PostgresBookmarkStore::new(self.pool.clone()))
    }

    fn workspaces(&self) -> Arc<dyn WorkspaceStore> {
        Arc::new(PostgresWorkspaceStore::new(self.pool.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::{PostgresTestDatabase, postgres_backend};
    use std::collections::BTreeSet;

    /// Every column the SQLite baseline declares, as `table.column`, with
    /// `!` appended where the column cannot be null. A primary key counts
    /// as not-null: SQLite records that separately, and PostgreSQL folds
    /// it into the same answer.
    async fn sqlite_columns() -> BTreeSet<String> {
        let pool = crate::storage::test_support::sqlite_pool().await;
        query_set(
            r#"
            SELECT m.name || '.' || p.name
                 || CASE WHEN p."notnull" = 1 OR p.pk > 0 THEN '!' ELSE '' END
            FROM sqlite_master m
            JOIN pragma_table_info(m.name) p
            WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
                  AND m.name <> '_sqlx_migrations'
            "#,
            &pool,
        )
        .await
    }

    /// The same, from a migrated PostgreSQL database, restricted to the
    /// schema this test owns.
    async fn postgres_columns(db: &PostgresTestDatabase) -> BTreeSet<String> {
        query_set_in_schema(
            r#"
            SELECT table_name || '.' || column_name
                 || CASE WHEN is_nullable = 'NO' THEN '!' ELSE '' END
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name <> '_sqlx_migrations'
            "#,
            db,
        )
        .await
    }

    /// The indexes the SQLite baseline names. SQLite's implicit indexes
    /// are `sqlite_autoindex_…`, so filtering them out leaves the ones
    /// the schema asked for by name.
    async fn sqlite_indexes() -> BTreeSet<String> {
        let pool = crate::storage::test_support::sqlite_pool().await;
        query_set(
            "SELECT name FROM sqlite_master \
             WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
            &pool,
        )
        .await
    }

    /// The same on PostgreSQL, where the implicit ones carry the
    /// constraint's name rather than the `idx_` prefix the schema uses.
    async fn postgres_indexes(db: &PostgresTestDatabase) -> BTreeSet<String> {
        query_set_in_schema(
            r"SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE 'idx\_%'",
            db,
        )
        .await
    }

    async fn query_set(sql: &str, pool: &sqlx::SqlitePool) -> BTreeSet<String> {
        sqlx::query_scalar::<_, String>(sql)
            .fetch_all(pool)
            .await
            .expect("the SQLite baseline is readable through sqlite_master")
            .into_iter()
            .collect()
    }

    async fn query_set_in_schema(sql: &str, db: &PostgresTestDatabase) -> BTreeSet<String> {
        sqlx::query_scalar::<_, String>(sql)
            .bind(&db.schema)
            .fetch_all(db.backend.pool())
            .await
            .expect("the PostgreSQL baseline is readable through the catalog")
            .into_iter()
            .collect()
    }

    #[tokio::test]
    async fn opening_runs_the_migrations() {
        let Some(db) = postgres_backend().await else {
            return;
        };
        // A table only the migrations create.
        sqlx::query("SELECT id FROM login_sessions LIMIT 1")
            .fetch_optional(db.backend.pool())
            .await
            .unwrap();
    }

    /// The two baselines are separate files, so nothing but a test stops
    /// one from gaining a column the other never hears about. Column
    /// types are deliberately left out of the comparison: they are the
    /// one thing the translation is allowed to change. Nullability is
    /// not, so it is compared.
    #[tokio::test]
    async fn the_two_baselines_declare_the_same_columns() {
        let Some(db) = postgres_backend().await else {
            return;
        };
        let sqlite = sqlite_columns().await;
        assert!(!sqlite.is_empty(), "the SQLite baseline declares columns");
        assert_eq!(
            sqlite,
            postgres_columns(&db).await,
            "the PostgreSQL baseline must declare the same columns as the SQLite one",
        );
    }

    /// An index dropped from one baseline turns a hot read into a scan on
    /// that backend alone, which no conformance case can see.
    #[tokio::test]
    async fn the_two_baselines_declare_the_same_indexes() {
        let Some(db) = postgres_backend().await else {
            return;
        };
        let sqlite = sqlite_indexes().await;
        assert!(!sqlite.is_empty(), "the SQLite baseline declares indexes");
        assert_eq!(
            sqlite,
            postgres_indexes(&db).await,
            "the PostgreSQL baseline must declare the same indexes as the SQLite one",
        );
    }

    /// The SQLite baseline spends a `json_valid` check to get this far.
    /// PostgreSQL parses the value into `JSONB`, so the refusal comes
    /// from the type rather than from a constraint anyone had to write.
    ///
    /// The accepted row comes first, or a renamed column would pass the
    /// refusal for the wrong reason.
    #[tokio::test]
    async fn a_json_column_refuses_text_that_is_not_json() {
        let Some(db) = postgres_backend().await else {
            return;
        };

        insert_bookmark(&db, "well-formed", r#"{"v":1}"#, "$2::jsonb")
            .await
            .expect("a JSON payload is accepted");
        assert!(
            insert_bookmark(&db, "malformed", "not json", "$2::jsonb")
                .await
                .is_err(),
            "view_json must hold JSON, not any text",
        );
    }

    /// What a `JSONB` column costs the Rust, for every store still to
    /// port. Each one serializes its payload with `serde_json` and binds
    /// the resulting `String`, which a `TEXT` column takes and a `JSONB`
    /// column refuses.
    ///
    /// The way out is a `sqlx::types::Json` bind rather than the
    /// `$2::jsonb` cast the case above uses, because `::` is PostgreSQL
    /// syntax that SQLite rejects outright: casting would end the sharing
    /// for that statement, and rebinding leaves the text alone.
    #[tokio::test]
    async fn a_json_column_will_not_take_a_bound_string() {
        let Some(db) = postgres_backend().await else {
            return;
        };
        assert!(
            insert_bookmark(&db, "bound-string", r#"{"v":1}"#, "$2")
                .await
                .is_err(),
            "a bound String reaches a jsonb column as text and is refused",
        );
    }

    async fn insert_bookmark(
        db: &PostgresTestDatabase,
        id: &str,
        payload: &str,
        view_json_placeholder: &str,
    ) -> Result<sqlx::postgres::PgQueryResult, sqlx::Error> {
        sqlx::query(&format!(
            "INSERT INTO bookmarks \
             (id, name, created_by, created_by_name, created_at, view_json) \
             VALUES ($1, 'Bookmark', 'dev@example.com', 'Dev', '2026-01-02T03:04:05Z', \
             {view_json_placeholder})"
        ))
        .bind(id)
        .bind(payload)
        .execute(db.backend.pool())
        .await
    }

    /// Two replicas rolling out at once both migrate on startup. sqlx
    /// wraps a PostgreSQL migration run in `pg_advisory_lock`, keyed on
    /// the database name, so the second waits for the first and then
    /// finds nothing to apply. Each `open` here builds its own pool, so
    /// each holds a session of its own and the lock is genuinely
    /// contended — which is the whole of what one process versus two
    /// changes about this.
    #[tokio::test]
    async fn concurrent_opens_apply_the_baseline_once() {
        let Some(db) = postgres_backend().await else {
            return;
        };
        // The harness already migrated this schema, and the race worth
        // testing is the one where every starter finds work to do.
        for statement in [
            format!(r#"DROP SCHEMA "{}" CASCADE"#, db.schema),
            format!(r#"CREATE SCHEMA "{}""#, db.schema),
        ] {
            sqlx::query(&statement)
                .execute(db.backend.pool())
                .await
                .unwrap();
        }

        let mut starters = Vec::new();
        for _ in 0..4 {
            let url = db.url.clone();
            starters.push(tokio::spawn(async move {
                PostgresStorageBackend::open(&url).await
            }));
        }
        let mut started = Vec::new();
        for starter in starters {
            started.push(
                starter
                    .await
                    .unwrap()
                    .expect("a concurrent starter must not lose the migration race"),
            );
        }

        let applied: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
            .fetch_one(started[0].pool())
            .await
            .unwrap();
        assert_eq!(
            applied, 1,
            "the baseline is applied once, not once per starter"
        );
    }

    /// Needs no server: the point is that an unreachable one is a connect
    /// failure naming the target, and that the target is redacted. Port 1
    /// is unbindable without privileges, so nothing answers there.
    #[tokio::test]
    async fn an_unreachable_server_is_reported_as_a_connect_failure() {
        let url = DatabaseUrl::parse("postgres://lucida:hunter2@127.0.0.1:1/lucida").unwrap();
        let err = PostgresStorageBackend::open(&url).await.unwrap_err();
        assert!(
            matches!(err, StorageError::Connect { .. }),
            "expected a connect failure, got {err:?}"
        );
        let message = err.to_string();
        assert!(message.contains("127.0.0.1:1"), "{message}");
        assert!(!message.contains("hunter2"), "{message}");
    }

    /// A database whose recorded migration no longer matches the one in
    /// this build — the deployment that rolled back a release, or the
    /// developer who edited an applied migration in place. sqlx refuses
    /// rather than guessing, and the refusal has to reach the operator
    /// as a migrate failure naming the database, not as a panic.
    ///
    /// Tampering with the recorded checksum is how the state is reached
    /// without shipping a second, deliberately broken migration.
    #[tokio::test]
    async fn a_migration_that_no_longer_matches_is_reported_as_a_migrate_failure() {
        let Some(db) = postgres_backend().await else {
            return;
        };
        sqlx::query("UPDATE _sqlx_migrations SET checksum = $1")
            .bind(vec![0u8; 48])
            .execute(db.backend.pool())
            .await
            .unwrap();

        let err = PostgresStorageBackend::open(&db.url).await.unwrap_err();
        let StorageError::Migrate { target, .. } = &err else {
            panic!("expected a migrate failure, got {err:?}");
        };
        // Whatever the connection string carried, what the operator
        // reads is the redacted form of it.
        assert_eq!(target, &db.url.redacted());
        assert!(err.to_string().contains("cannot migrate"), "{err}");
    }
}
