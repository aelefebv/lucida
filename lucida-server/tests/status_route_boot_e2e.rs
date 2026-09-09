//! What a deployer sees when the status route is configured: the route
//! answers on the public half with no session presented, and a bad
//! variable stops the boot naming itself.
//!
//! These run the server binary rather than calling into the library
//! because the claims are about the wiring in `main`: which router half
//! the route lands on, that the startup line is written, and that the
//! configuration error reaches the exit code. What the route says once
//! it is mounted is covered beside it in `lucida_server::status`.

mod boot;

use boot::{exit_of, free_port, get, server, wait_for_health};
use serde_json::{Value, json};

#[test]
fn a_configured_route_answers_with_no_session() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("status.db");
    let port = free_port();

    let mut child = server(&format!("127.0.0.1:{port}"))
        .current_dir(directory.path())
        .env("LUCIDA_DB_URL", format!("sqlite://{}", database.display()))
        .env("LUCIDA_STATUS_PATH", "/status")
        .env("LUCIDA_STATUS_LABEL", "sql")
        .spawn()
        .expect("the server binary runs");

    let up = wait_for_health(port);
    let answer = if up { get(port, "/status") } else { None };
    // Stop the server before reading its pipes: draining them runs to
    // end-of-file, and a running server never reaches one. Log lines go
    // to stdout and a startup error to stderr, so both are kept.
    let _ = child.kill();
    let logs = child
        .wait_with_output()
        .map(|output| {
            format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        })
        .unwrap_or_default();

    assert!(up, "the server must come up: {logs}");
    let (status_line, body) = answer.expect("the route answers");
    assert!(
        status_line.starts_with("HTTP/1.1 200"),
        "{status_line}: {body}"
    );
    let body: Value =
        serde_json::from_str(&body).unwrap_or_else(|e| panic!("not JSON ({e}): {body}"));
    assert_eq!(
        body,
        json!({
            "details": {
                "dependencies": {
                    "sql": [
                        {"resource_name": "status.db", "connected": true, "message": "Success"}
                    ]
                }
            }
        })
    );
    assert!(
        logs.contains("status.route.configured"),
        "one startup line names the route: {logs}"
    );
}

#[test]
fn a_path_without_a_leading_slash_stops_the_boot() {
    let directory = tempfile::tempdir().unwrap();
    let (code, stderr) = exit_of(
        server("127.0.0.1:1")
            .current_dir(directory.path())
            .env("LUCIDA_STATUS_PATH", "status"),
    );
    assert_eq!(code, Some(1), "{stderr}");
    assert!(
        !stderr.contains("panicked"),
        "a typo is an operating condition, not a bug: {stderr}"
    );
    assert!(
        stderr.contains("LUCIDA_STATUS_PATH"),
        "the message has to name the variable: {stderr}"
    );
}
