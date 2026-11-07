//! End-to-end startup tests for `AuthConfig::from_env`: spawn the real
//! `lucida-server` binary with `LUCIDA_*` combinations and assert it either
//! comes up or exits non-zero naming the variable. Only the binary covers
//! the fail-fast in `main.rs`, the bind, and the startup banner;
//! `from_env_map` has unit tests in `auth/config.rs`.
//!
//! Each test uses its own port and points `LUCIDA_DB_URL` at a tempdir,
//! and `boot::server` keeps the parent's `LUCIDA_*` variables out.

mod boot;

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard, OnceLock};

use boot::{exit_of, free_port, server, wait_for_health};

fn serial_test_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

/// The server on `bind` with `env` layered on, its SQLite store in `tmp`
/// so the workspace stays clean.
fn server_command(bind: &str, tmp: &Path, env: &[(&str, &str)]) -> Command {
    let mut command = server(bind);
    command
        .env(
            "LUCIDA_DB_URL",
            format!("sqlite://{}", tmp.join("lucida.db").display()),
        )
        .envs(env.iter().copied());
    command
}

/// Start the server on a free port of `host`, wait until it answers, then
/// stop it. Returns its stderr so callers can grep for a banner such as
/// the `LUCIDA_INSECURE` warning.
fn assert_server_starts(host: &str, env: &[(&str, &str)]) -> String {
    let tmp = tempfile::tempdir().unwrap();
    let port = free_port();
    let bind = format!("{host}:{port}");
    let mut child = server_command(&bind, tmp.path(), env)
        // Only stderr is asserted on, and a log pipe nobody drains can
        // fill and stall the server.
        .stdout(Stdio::null())
        .spawn()
        .expect("the server binary runs");
    let up = wait_for_health(port, &mut child);
    // Stop the server before reading stderr: draining it runs to
    // end-of-file, and a running server never reaches one.
    let _ = child.kill();
    let output = child.wait_with_output().expect("the server can be reaped");
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(up, "the server on {bind} must come up; stderr=\n{stderr}");
    stderr
}

/// Run the server on `bind` with `env`, expect it to exit non-zero, and
/// assert `expected_substr` appears in stderr. Returns the captured
/// stderr for any extra checks the caller wants to layer on.
fn assert_server_fails(bind: &str, env: &[(&str, &str)], expected_substr: &str) -> String {
    let tmp = tempfile::tempdir().unwrap();
    let (code, stderr) = exit_of(&mut server_command(bind, tmp.path(), env));
    assert_ne!(code, Some(0), "expected a non-zero exit; stderr=\n{stderr}");
    assert!(
        stderr.contains(expected_substr),
        "stderr missing {expected_substr:?}; got=\n{stderr}",
    );
    stderr
}

#[test]
fn loopback_default_starts_with_disabled_auth() {
    let _guard = serial_test_lock();
    // No LUCIDA_AUTH set → loopback bind → auto-detect Disabled →
    // server boots without requiring Google credentials.
    assert_server_starts("127.0.0.1", &[]);
}

#[test]
fn explicit_disabled_loopback_starts() {
    let _guard = serial_test_lock();
    assert_server_starts("127.0.0.1", &[("LUCIDA_AUTH", "disabled")]);
}

#[test]
fn explicit_disabled_non_loopback_with_insecure_starts() {
    let _guard = serial_test_lock();
    // 0.0.0.0 is the wildcard bind: `Ipv4Addr::is_loopback()` returns
    // false for it (verified), so it correctly trips the "non-loopback"
    // branch of the auto-detect safety check. With LUCIDA_INSECURE=1
    // set, the server should boot and emit the multi-line audit
    // banner so it's impossible to miss
    // in a `journalctl`/k8s log scroll.
    let stderr = assert_server_starts(
        "0.0.0.0",
        &[("LUCIDA_AUTH", "disabled"), ("LUCIDA_INSECURE", "1")],
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

#[test]
fn explicit_disabled_non_loopback_without_insecure_fails() {
    let _guard = serial_test_lock();
    let port = free_port();
    let bind = format!("0.0.0.0:{port}");
    let stderr = assert_server_fails(&bind, &[("LUCIDA_AUTH", "disabled")], "LUCIDA_INSECURE=1");
    // Bind value should appear in the error so an operator can grep
    // for the failure cause in their boot log.
    assert!(
        stderr.contains(&port.to_string()),
        "stderr lacks port: {stderr}"
    );
}

#[test]
fn explicit_google_without_credentials_fails() {
    let _guard = serial_test_lock();
    let bind = format!("127.0.0.1:{}", free_port());
    assert_server_fails(
        &bind,
        &[("LUCIDA_AUTH", "google")],
        "LUCIDA_GOOGLE_CLIENT_ID",
    );
}

#[test]
fn explicit_iap_without_an_audience_fails() {
    let _guard = serial_test_lock();
    let bind = format!("127.0.0.1:{}", free_port());
    let stderr = assert_server_fails(&bind, &[("LUCIDA_AUTH", "iap")], "LUCIDA_IAP_AUDIENCE");
    assert!(
        stderr.contains("backendServices"),
        "the message should show the shape of the value; got=\n{stderr}",
    );
}

#[test]
fn unknown_auth_mode_fails() {
    let _guard = serial_test_lock();
    let bind = format!("127.0.0.1:{}", free_port());
    assert_server_fails(&bind, &[("LUCIDA_AUTH", "microsoft")], "microsoft");
}

#[test]
fn invalid_bind_address_fails() {
    let _guard = serial_test_lock();
    assert_server_fails("not-a-socket-addr", &[], "LUCIDA_BIND");
}

// -- LUCIDA_DIRECTORY_* ------------------------------------------------
//
// Malformed directory configuration fails the boot like any other
// `LUCIDA_*` value. An unreachable directory does not: that is an
// outage to survive, not a typo to catch.

#[test]
fn a_malformed_directory_variable_stops_the_boot_naming_it() {
    let _guard = serial_test_lock();
    let bind = format!("127.0.0.1:{}", free_port());
    assert_server_fails(
        &bind,
        &[
            ("LUCIDA_DIRECTORY_URL", "http://127.0.0.1:1/people"),
            ("LUCIDA_DIRECTORY_NAME_FIELDS", ""),
        ],
        "LUCIDA_DIRECTORY_NAME_FIELDS",
    );
    assert_server_fails(
        &bind,
        &[("LUCIDA_DIRECTORY_URL", "people.example/people")],
        "LUCIDA_DIRECTORY_URL",
    );
    assert_server_fails(
        &bind,
        &[
            ("LUCIDA_DIRECTORY_URL", "http://127.0.0.1:1/people"),
            ("LUCIDA_DIRECTORY_HEADERS", "X-Requested-By lucida"),
        ],
        "LUCIDA_DIRECTORY_HEADERS",
    );
    assert_server_fails(
        &bind,
        &[
            ("LUCIDA_DIRECTORY_URL", "http://127.0.0.1:1/people"),
            ("LUCIDA_DIRECTORY_REFRESH_SECONDS", "soon"),
        ],
        "LUCIDA_DIRECTORY_REFRESH_SECONDS",
    );
}

#[test]
fn an_unreachable_directory_does_not_stop_the_boot() {
    let _guard = serial_test_lock();
    // Port 1 refuses at once, so the load fails without waiting out its
    // timeout. The failed load logs to stdout, which this harness does
    // not capture, so only that the server comes up is checked here. The
    // middleware tests pin what `whoami` serves meanwhile.
    assert_server_starts(
        "127.0.0.1",
        &[("LUCIDA_DIRECTORY_URL", "http://127.0.0.1:1/people")],
    );
}
