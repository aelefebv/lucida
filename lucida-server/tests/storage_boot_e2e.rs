//! What a deployer sees when `LUCIDA_DB_URL` is wrong, unreachable, or
//! absent.
//!
//! These run the server binary rather than calling into the library,
//! because the claim under test is about the process: it exits, it exits
//! non-zero, and what it leaves on stderr names the database and not the
//! password. A library-level test cannot tell a returned `Err` from a
//! panic that happens to print something similar.
//!
//! Every case here fails before the socket is bound, except the last,
//! which has to come up. None needs a database server, which is what
//! makes them deterministic: the failing connection strings point at a
//! port nothing answers on, and the migration case is a SQLite file this
//! test writes. The PostgreSQL path that succeeds is covered by
//! `storage::end_to_end`, where a real server is available.

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A connection string with a password in it, pointed at a port nothing
/// can answer on: binding port 1 needs privileges no test process has.
const UNREACHABLE: &str = "postgres://lucida:hunter2@127.0.0.1:1/lucida";

/// The password in [`UNREACHABLE`], which must not appear in anything
/// the server prints.
const PASSWORD: &str = "hunter2";

/// How long the SQLite default gets to come up and answer before the
/// case gives up. Generous, because a slow machine failing this would be
/// a false alarm rather than a defect.
const STARTUP_BUDGET: Duration = Duration::from_secs(30);

/// The server binary, with the environment pinned so a variable set in
/// the shell running `cargo test` cannot change the outcome.
fn server(bind: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lucida-server"));
    command
        .env_remove("LUCIDA_DB_URL")
        .env_remove("LUCIDA_AUTH")
        .env_remove("LUCIDA_INSECURE")
        // Loopback, so the auth mode auto-detects to disabled and no
        // Google credentials are needed to reach the storage step.
        .env("LUCIDA_BIND", bind)
        .env("RUST_LOG", "lucida_server=info")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Run the server to completion and return its exit code and stderr.
/// Used only for the cases that fail before binding, so this cannot
/// hang on a server that came up.
fn boot_failure(db_url: &str) -> (Option<i32>, String) {
    let output = server("127.0.0.1:1")
        .env("LUCIDA_DB_URL", db_url)
        .output()
        .expect("the server binary runs");
    assert!(
        !output.status.success(),
        "the server must not come up on {db_url}"
    );
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// An unreachable database is a reported failure, not a crash and not a
/// server that accepts requests it cannot serve.
#[test]
fn an_unreachable_database_stops_the_boot() {
    let (code, stderr) = boot_failure(UNREACHABLE);
    assert_eq!(code, Some(1), "{stderr}");
    assert!(
        !stderr.contains("panicked"),
        "a database that is down is an operating condition, not a bug: {stderr}"
    );
    assert!(
        stderr.contains("cannot open the database"),
        "the message has to say what failed: {stderr}"
    );
    assert!(
        stderr.contains("127.0.0.1:1"),
        "and which database it was: {stderr}"
    );
    assert!(
        !stderr.contains(PASSWORD),
        "a password must not reach a log line: {stderr}"
    );
}

/// An unsupported scheme is refused during configuration and never
/// reaches a backend, so a *connect* failure is proof the alias was
/// understood, and no server is needed to see it. The message shows the
/// canonical spelling, because the alias is spent at the door.
#[test]
fn the_postgresql_spelling_reaches_the_same_backend() {
    let (_, stderr) = boot_failure(&UNREACHABLE.replace("postgres://", "postgresql://"));
    assert!(
        stderr.contains("cannot open the database at postgres://"),
        "postgresql:// must reach the PostgreSQL backend: {stderr}"
    );
    assert!(!stderr.contains(PASSWORD), "{stderr}");
}

#[test]
fn an_unsupported_scheme_stops_the_boot_naming_the_alternatives() {
    let (code, stderr) = boot_failure("mysql://lucida@127.0.0.1:1/lucida");
    assert_eq!(code, Some(1), "{stderr}");
    assert!(stderr.contains("LUCIDA_DB_URL"), "{stderr}");
    for supported in ["sqlite", "postgres"] {
        assert!(
            stderr.contains(supported),
            "the operator needs to be told {supported} works: {stderr}"
        );
    }
}

/// A database recording a migration this build does not have — what a
/// rollback past a migration leaves behind. The migrations run at
/// startup, so the server refuses rather than serving requests against
/// a schema it cannot account for.
///
/// SQLite makes the point without a server, and the arm in `main` that
/// reports it is the same one every backend returns through.
#[test]
fn a_migration_this_build_does_not_have_stops_the_boot() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("rolled-back.db");
    record_a_migration_from_the_future(&database);

    let (code, stderr) = boot_failure(&format!("sqlite://{}", database.display()));
    assert_eq!(code, Some(1), "{stderr}");
    assert!(
        !stderr.contains("panicked"),
        "a rollback is an operating condition, not a bug: {stderr}"
    );
    assert!(
        stderr.contains("cannot migrate the database"),
        "the message has to say the migrations were what failed: {stderr}"
    );
    assert!(
        stderr.contains("rolled-back.db"),
        "and which database it was: {stderr}"
    );
}

/// Write the migration bookkeeping a newer build would have left, and
/// nothing else. The version is far past anything this repo ships, so
/// the migrator finds an applied migration it cannot resolve.
fn record_a_migration_from_the_future(database: &Path) {
    let url = format!("sqlite://{}?mode=rwc", database.display());
    tokio::runtime::Runtime::new()
        .expect("a test can start a runtime")
        .block_on(async {
            let pool = sqlx::SqlitePool::connect(&url)
                .await
                .expect("SQLite creates the file");
            for statement in [
                "CREATE TABLE _sqlx_migrations (
                     version BIGINT PRIMARY KEY,
                     description TEXT NOT NULL,
                     installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                     success BOOLEAN NOT NULL,
                     checksum BLOB NOT NULL,
                     execution_time BIGINT NOT NULL
                 )",
                "INSERT INTO _sqlx_migrations
                     (version, description, success, checksum, execution_time)
                 VALUES (29990101000001, 'from a newer build', TRUE, X'00', 0)",
            ] {
                sqlx::query(statement)
                    .execute(&pool)
                    .await
                    .expect("the bookkeeping table is ordinary SQL");
            }
            pool.close().await;
        });
}

/// No `LUCIDA_DB_URL` still means a SQLite file in the working
/// directory, and the server comes up on it and answers.
///
/// This is the regression a second backend risks: the deployment that
/// never asked for one has to keep working.
#[test]
fn an_unset_connection_string_still_starts_on_sqlite() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("lucida.db");
    let port = free_port();

    let mut child = server(&format!("127.0.0.1:{port}"))
        .current_dir(directory.path())
        .spawn()
        .expect("the server binary runs");

    let answered = wait_for_health(port);
    // Stop the server before reading its pipes: draining them runs to
    // end-of-file, and a running server never reaches one.
    let _ = child.kill();
    let stderr = child
        .wait_with_output()
        .map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
        .unwrap_or_default();

    assert!(
        answered,
        "an unset LUCIDA_DB_URL must reach a server that serves: {stderr}"
    );
    assert!(
        database.exists(),
        "and the database it opened must be {}: {stderr}",
        database.display()
    );
}

/// Poll `/healthz` until it answers, up to [`STARTUP_BUDGET`].
///
/// A bound socket is not enough: the storage step runs before the bind,
/// so a server that answers is one that opened its database, migrated
/// it, and built every router over the stores it handed out.
fn wait_for_health(port: u16) -> bool {
    let deadline = Instant::now() + STARTUP_BUDGET;
    while Instant::now() < deadline {
        if let Ok(mut socket) = TcpStream::connect(("127.0.0.1", port)) {
            let request = format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
            let mut status = [0u8; 15];
            if socket.write_all(request.as_bytes()).is_ok()
                && socket.read_exact(&mut status).is_ok()
                && status.starts_with(b"HTTP/1.1 200")
            {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// A port nothing is listening on right now, which the kernel hands
/// back once the listener is dropped. Losing the race to another process
/// costs a failed bind, not a wrong answer, so the case that uses this
/// fails loudly rather than passing by accident.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("a loopback port is available")
        .local_addr()
        .expect("a bound listener has an address")
        .port()
}
