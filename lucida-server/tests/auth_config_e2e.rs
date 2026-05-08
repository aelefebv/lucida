//! End-to-end startup tests for `AuthConfig::from_env` (slice 7,
//! issue #462). We spawn the actual `lucida-server` binary with various
//! `LUCIDA_*` env-var combinations and assert it either:
//!
//! - boots and starts listening (we close the listener as soon as we
//!   see the bind succeed via a short port-poll), or
//! - exits non-zero with the expected named-variable error in stderr.
//!
//! Running the binary (rather than calling `from_env` in-process) is
//! the only way to cover the whole startup path: fail-fast in
//! `main.rs`, the bind syscall, and the startup logging banner. The
//! lower-level `from_env_map` path is exercised by the unit tests in
//! `auth/config.rs`.
//!
//! Each test:
//! - Picks a unique loopback port via `pick_loopback_port`.
//! - Wipes the parent process env with `env_clear` so the test
//!   environment can't smuggle in `LUCIDA_*` overrides.
//! - Sets a tempdir-scoped `LUCIDA_DB_PATH` so the SQLite store
//!   doesn't write `lucida.db` into the workspace root.

use std::io::Read;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_lucida-server");

/// Reserve and immediately drop a loopback TCP port. The port is
/// briefly available between the drop here and the spawned server's
/// bind; that race is acceptable for these tests because each test
/// also runs with a unique port (no two tests collide).
fn pick_loopback_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

/// Build a `Command` with a wiped env, then layer the supplied
/// LUCIDA_* vars on top. Always points the SQLite store at a tempdir
/// so we don't pollute the workspace.
fn server_command(tmp_db: &std::path::Path, env: &[(&str, &str)]) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.env_clear()
        // PATH is needed so dynamic loader / sqlx can resolve libs on
        // some hosts; HOME for any default-cache-dir lookups.
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("LUCIDA_DB_PATH", tmp_db.to_str().expect("utf-8"))
        // Force trace level off / quiet so stderr stays scannable.
        .env("RUST_LOG", "lucida_server=warn");
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd
}

/// Spawn the server with the given env, poll the port until it accepts
/// a TCP connection (success) or the process exits (failure), then
/// kill / harvest. Returns the captured stderr so callers can grep
/// for any expected banners (the LUCIDA_INSECURE warning, etc).
fn assert_server_starts(port: u16, env: &[(&str, &str)]) -> String {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("lucida.db");
    let mut cmd = server_command(&db_path, env);
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn server");

    let deadline = Instant::now() + Duration::from_secs(10);
    let addr = format!("127.0.0.1:{port}");
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            // Process exited before we observed a successful bind.
            let stderr = drain(child.stderr.as_mut().unwrap());
            panic!(
                "server exited with {status:?} before binding {addr}; stderr=\n{stderr}",
            );
        }
        match std::net::TcpStream::connect_timeout(
            &addr.parse().unwrap(),
            Duration::from_millis(200),
        ) {
            Ok(_) => break,
            Err(last_err) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let stderr = drain(child.stderr.as_mut().unwrap());
                    panic!(
                        "timed out waiting for {addr} to accept; last error={last_err:?}; \
                         stderr=\n{stderr}",
                    );
                }
                std::thread::sleep(Duration::from_millis(75));
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    // Drain whatever stderr was buffered up to the bind moment. Tests
    // that care about the startup banner can grep this.
    drain(child.stderr.as_mut().unwrap())
}

/// Spawn the server with the given env, expect it to exit non-zero
/// within the timeout, and assert `expected_substr` appears in
/// stderr. Returns the captured stderr for any extra checks the caller
/// wants to layer on.
fn assert_server_fails(env: &[(&str, &str)], expected_substr: &str) -> String {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("lucida.db");
    let mut cmd = server_command(&db_path, env);
    let child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn server");
    // The fail-fast paths exit synchronously after env parsing; 5s is
    // generous for any cold-start overhead.
    let output = wait_with_timeout(child, Duration::from_secs(5));
    assert!(
        !output.status.success(),
        "expected non-zero exit, got {:?}\nstderr=\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        stderr.contains(expected_substr),
        "stderr missing {expected_substr:?}; got=\n{stderr}",
    );
    stderr
}

fn wait_with_timeout(mut child: Child, timeout: Duration) -> std::process::Output {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            let mut stderr = Vec::new();
            if let Some(mut s) = child.stderr.take() {
                let _ = s.read_to_end(&mut stderr);
            }
            let mut stdout = Vec::new();
            if let Some(mut s) = child.stdout.take() {
                let _ = s.read_to_end(&mut stdout);
            }
            return std::process::Output { status, stdout, stderr };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child did not exit within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn drain(stream: &mut std::process::ChildStderr) -> String {
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

// ---------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------

#[test]
fn loopback_default_starts_with_disabled_auth() {
    let port = pick_loopback_port();
    let bind = format!("127.0.0.1:{port}");
    // No LUCIDA_AUTH set → loopback bind → auto-detect Disabled →
    // server boots without requiring Google credentials.
    assert_server_starts(port, &[("LUCIDA_BIND", &bind)]);
}

#[test]
fn explicit_disabled_loopback_starts() {
    let port = pick_loopback_port();
    let bind = format!("127.0.0.1:{port}");
    assert_server_starts(
        port,
        &[("LUCIDA_BIND", &bind), ("LUCIDA_AUTH", "disabled")],
    );
}

#[test]
fn explicit_disabled_non_loopback_with_insecure_starts() {
    // 0.0.0.0 is the wildcard bind: `Ipv4Addr::is_loopback()` returns
    // false for it (verified), so it correctly trips the "non-loopback"
    // branch of the auto-detect safety check. With LUCIDA_INSECURE=1
    // set, the server should boot — and emit the multi-line audit
    // banner per ADR-0018 §"Consequences" so it's impossible to miss
    // in a `journalctl`/k8s log scroll.
    let port = pick_loopback_port();
    let bind = format!("0.0.0.0:{port}");
    let stderr = assert_server_starts(
        port,
        &[
            ("LUCIDA_BIND", &bind),
            ("LUCIDA_AUTH", "disabled"),
            ("LUCIDA_INSECURE", "1"),
        ],
    );
    assert!(
        stderr.contains("LUCIDA_INSECURE=1"),
        "warning banner missing from stderr; got=\n{stderr}",
    );
    assert!(
        stderr.contains("AUTH DISABLED"),
        "warning banner missing AUTH DISABLED line; got=\n{stderr}",
    );
}

// ---------------------------------------------------------------------
// Fail-fast paths
// ---------------------------------------------------------------------

#[test]
fn explicit_disabled_non_loopback_without_insecure_fails() {
    let port = pick_loopback_port();
    let bind = format!("0.0.0.0:{port}");
    let stderr = assert_server_fails(
        &[("LUCIDA_BIND", &bind), ("LUCIDA_AUTH", "disabled")],
        "LUCIDA_INSECURE=1",
    );
    // Bind value should appear in the error so an operator can grep
    // for the failure cause in their boot log.
    assert!(stderr.contains(&port.to_string()), "stderr lacks port: {stderr}");
}

#[test]
fn explicit_google_without_credentials_fails() {
    let port = pick_loopback_port();
    let bind = format!("127.0.0.1:{port}");
    assert_server_fails(
        &[("LUCIDA_BIND", &bind), ("LUCIDA_AUTH", "google")],
        "LUCIDA_GOOGLE_CLIENT_ID",
    );
}

#[test]
fn unknown_auth_mode_fails() {
    let port = pick_loopback_port();
    let bind = format!("127.0.0.1:{port}");
    assert_server_fails(
        &[("LUCIDA_BIND", &bind), ("LUCIDA_AUTH", "microsoft")],
        "microsoft",
    );
}

#[test]
fn invalid_bind_address_fails() {
    assert_server_fails(
        &[("LUCIDA_BIND", "not-a-socket-addr")],
        "LUCIDA_BIND",
    );
}
