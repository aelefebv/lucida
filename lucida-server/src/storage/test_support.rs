//! Database setup shared by every test that needs a real one.
//!
//! Each store's tests used to open their own in-memory database with the
//! same three lines. They go through here instead, so how a test database
//! comes up is written once and cannot drift from how production opens
//! one: the migrations, the pool shape, and the pinned connection all
//! come from [`SqliteStorageBackend`].
//!
//! SQLite needs nothing but a process, so [`sqlite_backend`] always
//! answers. PostgreSQL needs a server, which not every machine running
//! `cargo test` has, so [`postgres_backend`] answers `None` and says so
//! on the way past — see the note on that function.

use std::io::Write as _;

use sqlx::SqlitePool;

use super::{PostgresStorageBackend, SqliteStorageBackend};

/// A migrated in-memory SQLite backend.
pub(crate) async fn sqlite_backend() -> SqliteStorageBackend {
    SqliteStorageBackend::open_in_memory()
        .await
        .expect("in-memory SQLite backend should open")
}

/// The pool behind a fresh [`sqlite_backend`], for tests that build a
/// concrete store by hand or close the pool to provoke a store failure.
pub(crate) async fn sqlite_pool() -> SqlitePool {
    sqlite_backend().await.pool().clone()
}

/// The environment variable naming a PostgreSQL the tests may use.
///
/// One variable answers two requirements that pull apart: continuous
/// integration must run the PostgreSQL cases, and a developer with no
/// PostgreSQL must still be able to run `cargo test`. Set and reachable
/// means run; unset or unreachable means skip.
pub(crate) const POSTGRES_URL_VAR: &str = "LUCIDA_TEST_POSTGRES_URL";

/// Set alongside [`POSTGRES_URL_VAR`] where skipping is not an acceptable
/// outcome, which turns every skip into a failure.
///
/// Continuous integration sets it. A skip is the right answer on a laptop
/// and the wrong one on the machine that is supposed to be running the
/// PostgreSQL cases, and without this the two are indistinguishable: a
/// service container that never came up, or a connection string with a
/// typo in it, would report green having tested nothing.
const POSTGRES_REQUIRED_VAR: &str = "LUCIDA_TEST_POSTGRES_REQUIRED";

/// How long a leftover test schema survives before the next run reclaims
/// it. Long enough that no live run can be swept out from under itself,
/// short enough that a developer's database does not fill up.
const SCHEMA_LIFETIME_SECONDS: i64 = 3600;

/// A migrated PostgreSQL, private to one test.
pub(crate) struct PostgresTestDatabase {
    /// The backend, migrated into [`Self::schema`].
    pub(crate) backend: PostgresStorageBackend,
    /// The schema it was migrated into.
    pub(crate) schema: String,
    /// The connection string that reaches that schema, for a test that
    /// wants to open a second backend over the same database.
    pub(crate) url: String,
}

/// A migrated PostgreSQL backend in a schema of its own, or `None` when
/// no PostgreSQL was offered.
///
/// Every case gets its own schema, so cases that write the same key run
/// in parallel without colliding. Nothing drops the schema afterwards: a
/// teardown would have to run after the case's last use of the store,
/// which is exactly where a panicking case does not reach. Instead each
/// schema carries the second it was created, and the next run reclaims
/// the ones older than [`SCHEMA_LIFETIME_SECONDS`] — self-healing, and
/// too old to belong to a run still going.
///
/// A `None` says so on the process's stderr, or fails the case outright
/// where [`POSTGRES_REQUIRED_VAR`] says a skip is not acceptable.
pub(crate) async fn postgres_backend() -> Option<PostgresTestDatabase> {
    let base = match std::env::var(POSTGRES_URL_VAR) {
        Ok(base) if !base.trim().is_empty() => base,
        _ => {
            return skip_postgres_cases(&format!(
                "{POSTGRES_URL_VAR} is not set. Set it to a connection string, \
                 for example `postgres://postgres@localhost:5432/lucida_test`."
            ));
        }
    };

    let schema = fresh_schema_name();
    let admin = match sqlx::PgPool::connect(&base).await {
        Ok(admin) => admin,
        Err(e) => {
            return skip_postgres_cases(&format!(
                "the PostgreSQL named by {POSTGRES_URL_VAR} did not answer: {e}"
            ));
        }
    };

    reclaim_stale_schemas(&admin).await;
    sqlx::query(&format!(r#"CREATE SCHEMA "{schema}""#))
        .execute(&admin)
        .await
        .expect("a reachable PostgreSQL should let a test create its own schema");
    admin.close().await;

    let url = scoped_to_schema(&base, &schema);
    let backend = PostgresStorageBackend::open(&url)
        .await
        .expect("a reachable PostgreSQL should migrate a fresh schema");

    Some(PostgresTestDatabase {
        backend,
        schema,
        url,
    })
}

/// A schema name no other test holds, carrying the second it was made.
fn fresh_schema_name() -> String {
    format!(
        "lucida_test_{}_{}",
        chrono::Utc::now().timestamp(),
        uuid::Uuid::new_v4().simple()
    )
}

/// The connection string with `search_path` pointed at `schema`.
///
/// `options` is libpq's pass-through for server settings and sqlx parses
/// it out of the query string, so the pool needs no per-connection hook:
/// every connection it opens starts in the right schema, including the
/// one the migrator runs on.
fn scoped_to_schema(base: &str, schema: &str) -> String {
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}{separator}options=-c%20search_path%3D{schema}")
}

/// Drop test schemas left behind by runs that are long over.
///
/// Best effort. A failure here means a database that is filling up, not a
/// test that should fail, and the case about to run does not depend on it.
async fn reclaim_stale_schemas(admin: &sqlx::PgPool) {
    let stale: Vec<String> = sqlx::query_scalar(
        r#"
        SELECT nspname::text
        FROM pg_namespace
        WHERE nspname ~ '^lucida_test_[0-9]+_[0-9a-f]+$'
          AND split_part(nspname, '_', 3)::bigint < extract(epoch FROM now()) - $1
        "#,
    )
    .bind(SCHEMA_LIFETIME_SECONDS)
    .fetch_all(admin)
    .await
    .unwrap_or_default();

    for schema in stale {
        let _ = sqlx::query(&format!(r#"DROP SCHEMA IF EXISTS "{schema}" CASCADE"#))
            .execute(admin)
            .await;
    }
}

/// Report that the PostgreSQL cases are not running, and say why.
///
/// Panics instead where [`POSTGRES_REQUIRED_VAR`] is set. Otherwise the
/// reason goes out once per test process and the caller gets `None`.
fn skip_postgres_cases(reason: &str) -> Option<PostgresTestDatabase> {
    assert!(
        std::env::var_os(POSTGRES_REQUIRED_VAR).is_none(),
        "{POSTGRES_REQUIRED_VAR} is set, so the PostgreSQL cases must run: {reason}"
    );

    static ANNOUNCED: std::sync::Once = std::sync::Once::new();
    ANNOUNCED.call_once(|| {
        // Not `eprintln!`: the test harness captures what that macro
        // writes and shows it only for a failing case, which is the one
        // outcome this message will never accompany. Writing to the
        // process's stderr handle goes around the capture, so the skip
        // is visible on the green run it is reporting on.
        let _ = writeln!(
            std::io::stderr(),
            "SKIPPED: the PostgreSQL cases did not run. {reason}"
        );
    });
    None
}
