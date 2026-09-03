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
//! which is the one that has to come up. None of them needs a database
//! server: the connection strings point at a port nothing answers on,
//! which is what makes the failure deterministic. The PostgreSQL path
//! that succeeds is covered where a real server is available, by the
//! end-to-end case beside the storage backends.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A connection string with a password in it, pointed at a port nothing
/// can answer on: binding port 1 needs privileges no test process has.
const UNREACHABLE: &str = "postgres://lucida:hunter2@127.0.0.1:1/lucida";

/// The password in [`UNREACHABLE`], which must not appear in anything
/// the server prints.
const PASSWORD: &str = "hunter2";

/// How long the SQLite default gets to create its file before the case
/// gives up. Generous: the process has a whole startup to get through,
/// and a slow machine failing this would be a false alarm.
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

/// The `postgresql://` spelling selects the same backend as `postgres://`.
///
/// No server is needed to see it: an unsupported scheme is refused
/// during configuration and never reaches a backend, so a *connect*
/// failure is proof the alias was understood. The message shows the
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

/// A backend this build does not have is refused during configuration,
/// naming the variable and the schemes that would have worked.
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

/// The default is unchanged: no `LUCIDA_DB_URL` still means a SQLite
/// file in the working directory, and the server comes up on it.
///
/// This is the regression the rest of this file risks — a new backend
/// is only worth having if the deployment that never asked for one
/// keeps working.
#[test]
fn an_unset_connection_string_still_starts_on_sqlite() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("lucida.db");

    let mut child = server(&format!("127.0.0.1:{}", free_port()))
        .current_dir(directory.path())
        .spawn()
        .expect("the server binary runs");

    let created = wait_for(&database);
    // Stop the server before reading its pipes: draining them runs to
    // end-of-file, and a running server never reaches one.
    let _ = child.kill();
    let stderr = child
        .wait_with_output()
        .map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
        .unwrap_or_default();

    assert!(
        created,
        "an unset LUCIDA_DB_URL must open {}: {stderr}",
        database.display()
    );
}

/// Wait for `path` to appear, up to [`STARTUP_BUDGET`].
fn wait_for(path: &Path) -> bool {
    let deadline = Instant::now() + STARTUP_BUDGET;
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// A port nothing is listening on right now. The kernel hands it back
/// once the listener is dropped, and the case that uses it does not
/// depend on getting it: the assertion is about a file, and a bind that
/// lost a race to another process still opened the database first.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("a loopback port is available")
        .local_addr()
        .expect("a bound listener has an address")
        .port()
}
