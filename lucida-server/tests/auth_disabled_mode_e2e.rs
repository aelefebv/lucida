//! End-to-end HTTP tests for `AuthMode::Disabled`: spawn the real binary
//! in disabled mode and drive it over HTTP. They guard against
//! `build_extractor` returning the cookie extractor in every mode, which
//! would 401 every request from a binary that boots fine.
//!
//! Each test uses its own port and points `LUCIDA_DB_URL` at a tempdir,
//! and `boot::server` keeps the parent's `LUCIDA_*` variables out.

mod boot;

use std::process::{Child, Stdio};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use boot::{free_port, server, wait_for_health};
use serde_json::Value;

/// Owns the spawned child so the Drop implementation can kill it on
/// test exit (or panic). Holds the tempdir handle to keep the
/// SQLite file alive for the test's lifetime.
struct SpawnedServer {
    child: Child,
    _tmp: tempfile::TempDir,
    base_url: String,
}

impl Drop for SpawnedServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Start the server on a free port of `host` with `extra_env` layered on,
/// and wait until it answers. The client connects over loopback, which
/// also reaches a wildcard bind on the same host.
fn spawn_server(host: &str, extra_env: &[(&str, &str)]) -> SpawnedServer {
    // The cases run in parallel, and two handed the same free port before
    // either server bound it would both talk to whichever server won. A
    // case picks its port only once the previous one's server listens.
    static STARTING: Mutex<()> = Mutex::new(());
    let _starting = STARTING.lock().unwrap_or_else(PoisonError::into_inner);

    let tmp = tempfile::tempdir().unwrap();
    let port = free_port();
    let mut child = server(&format!("{host}:{port}"))
        .env(
            "LUCIDA_DB_URL",
            format!("sqlite://{}", tmp.path().join("lucida.db").display()),
        )
        .envs(extra_env.iter().copied())
        // Nothing reads the log, and a pipe nobody drains can fill and
        // stall the server mid-case.
        .stdout(Stdio::null())
        .spawn()
        .expect("the server binary runs");
    if !wait_for_health(port, &mut child) {
        let _ = child.kill();
        let stderr = child
            .wait_with_output()
            .map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
            .unwrap_or_default();
        panic!("the server on {host}:{port} must come up; stderr=\n{stderr}");
    }

    SpawnedServer {
        child,
        _tmp: tmp,
        base_url: format!("http://127.0.0.1:{port}"),
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        // No redirect-following: tests assert exact status codes; the
        // SPA-static-serve catch-all could otherwise mask a routing bug.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build reqwest client")
}

/// Hit `GET /auth/whoami` and assert the response is the canned dev
/// principal. Used by tests 1 + 2 — same shape, different env permutation.
async fn assert_whoami_returns_dev_principal(server: &SpawnedServer) {
    let client = http_client();
    let res = client
        .get(format!("{}/auth/whoami", server.base_url))
        .send()
        .await
        .expect("GET /auth/whoami");
    assert_eq!(res.status(), reqwest::StatusCode::OK);
    let body: Value = res.json().await.expect("json body");
    assert_eq!(
        body["email"], "dev@local",
        "whoami must yield the canned dev principal; got {body}",
    );
    assert_eq!(body["display_name"], "Local Dev");
    assert_eq!(
        body["is_admin"], false,
        "the identity every caller gets for free carries no admin rights; got {body}",
    );
    // picture_url is JSON null in the canned principal.
    assert!(
        body["picture_url"].is_null(),
        "picture_url should be null; got {body}",
    );
}

// Loopback default (no LUCIDA_AUTH set) → whoami yields dev principal.
// Regression guard: a cookie extractor demanding a session cookie no
// route minted in disabled mode would 401.
#[tokio::test]
async fn loopback_default_whoami_returns_dev_principal() {
    let server = spawn_server("127.0.0.1", &[]);
    assert_whoami_returns_dev_principal(&server).await;
}

// The SPA draws its sign-out control off this answer, so disabled
// mode ends up with no control rather than one that clears nothing.
#[tokio::test]
async fn disabled_mode_advertises_no_sign_out_url() {
    let server = spawn_server("127.0.0.1", &[]);

    let mode: Value = http_client()
        .get(format!("{}/auth/mode", server.base_url))
        .send()
        .await
        .expect("GET /auth/mode")
        .json()
        .await
        .expect("json body");
    assert!(mode["sign_out_url"].is_null(), "got {mode}");
}

// Docker quickstart path: explicit LUCIDA_AUTH=disabled +
// LUCIDA_INSECURE=1 on a non-loopback bind behaves identically.
#[tokio::test]
async fn explicit_disabled_non_loopback_with_insecure_whoami_returns_dev_principal() {
    let server = spawn_server(
        "0.0.0.0",
        &[("LUCIDA_AUTH", "disabled"), ("LUCIDA_INSECURE", "1")],
    );
    assert_whoami_returns_dev_principal(&server).await;
}

// GET /api/browse without a cookie must not 401 — verifies the
// principal flows through middleware to non-auth handlers in disabled
// mode.
#[tokio::test]
async fn browse_works_without_cookie_in_disabled_mode() {
    // Tempdir scoped to the test; seed one file so the listing isn't
    // entirely empty (catches a bug where the handler returned 200 on
    // an empty dir but 500 on a real one). We seed a regular file
    // rather than a directory so the test doesn't depend on canonical
    // sub-path resolution semantics.
    let data_tmp = tempfile::tempdir().unwrap();
    std::fs::write(data_tmp.path().join("seed.txt"), b"hello").unwrap();
    let data_dir_str = data_tmp.path().to_str().unwrap().to_string();

    let server = spawn_server("127.0.0.1", &[("LUCIDA_DATA_DIR", &data_dir_str)]);
    let client = http_client();
    // The browse handler canonicalizes its `path` arg and constrains
    // it to LUCIDA_DATA_DIR; pointing at the same directory we set
    // LUCIDA_DATA_DIR to is the simplest happy path.
    let url = format!(
        "{}/api/browse?path={}",
        server.base_url,
        urlencoding::encode(&data_dir_str),
    );
    let res = client.get(&url).send().await.expect("GET /api/browse");
    assert_ne!(
        res.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "/api/browse must NOT 401 in disabled mode (the principal flows from the stub)",
    );
    assert_eq!(
        res.status(),
        reqwest::StatusCode::OK,
        "/api/browse should answer 200 against the seeded data dir",
    );
    let body: Value = res.json().await.expect("json body");
    let entries = body["entries"].as_array().expect("entries array");
    assert!(
        entries.iter().any(|e| e["name"] == "seed.txt"),
        "seeded file should appear in the listing; got {body}",
    );

    // The response's `path` field must be in canonical-display form:
    // forward slashes throughout, no `\\?\` verbatim-UNC prefix, and
    // (on Windows) a lowercase drive letter. On Linux the canonical
    // form of an absolute Unix path is identical to its raw string, so
    // the assertion reduces to "no backslashes and no `\\?\` prefix"
    // — both trivially true on Linux but load-bearing on Windows.
    let response_path = body["path"].as_str().expect("path string");
    assert!(
        !response_path.contains('\\'),
        "browse response path must use forward slashes only; got {response_path:?}",
    );
    assert!(
        !response_path.starts_with(r"\\?\"),
        "browse response path must strip the Windows verbatim-UNC prefix; got {response_path:?}",
    );
}

// Both directions of the loopback gate need a test: an always-off
// switcher passes the non-loopback case, and an always-on one passes
// the loopback case.

/// Hit `GET /auth/dev/status` and assert the verdict the SPA reads to
/// decide whether to draw the switcher.
async fn assert_dev_switcher_advertised(server: &SpawnedServer, expected: bool) {
    let status: Value = http_client()
        .get(format!("{}/auth/dev/status", server.base_url))
        .send()
        .await
        .expect("GET /auth/dev/status")
        .json()
        .await
        .expect("json body");
    assert_eq!(status["enabled"], expected, "got {status}");
}

#[tokio::test]
async fn dev_login_switches_identity_on_a_loopback_bind() {
    let server = spawn_server("127.0.0.1", &[]);
    let client = http_client();

    assert_dev_switcher_advertised(&server, true).await;

    let res = client
        .post(format!("{}/auth/dev/login", server.base_url))
        .json(&serde_json::json!({
            "email": "owner@example.com",
            "display_name": "Owner",
            "is_admin": true,
        }))
        .send()
        .await
        .expect("POST /auth/dev/login");
    assert_eq!(res.status(), reqwest::StatusCode::OK);
    assert!(
        res.headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .any(|v| v.to_str().unwrap_or("").contains("lucida_dev_principal=")),
        "a successful switch sets the dev principal cookie",
    );
    let principal: Value = res.json().await.expect("json body");
    assert_eq!(principal["email"], "owner@example.com");
    assert_eq!(principal["is_admin"], true);
}

// `LUCIDA_INSECURE=1` is what lets a disabled-mode server boot on an
// exposed bind. It does not buy back the switcher.
#[tokio::test]
async fn dev_login_404s_on_a_non_loopback_bind() {
    let dist = tempfile::tempdir().unwrap();
    let index_html = "<html>lucida</html>";
    std::fs::write(dist.path().join("index.html"), index_html).unwrap();
    let dist_str = dist.path().to_str().unwrap().to_string();
    let server = spawn_server(
        "0.0.0.0",
        &[
            ("LUCIDA_AUTH", "disabled"),
            ("LUCIDA_INSECURE", "1"),
            ("LUCIDA_WEB_DIST", &dist_str),
        ],
    );
    let client = http_client();

    let res = client
        .post(format!("{}/auth/dev/login", server.base_url))
        .json(&serde_json::json!({ "email": "owner@example.com", "is_admin": true }))
        .send()
        .await
        .expect("POST /auth/dev/login");
    assert_eq!(
        res.status(),
        reqwest::StatusCode::NOT_FOUND,
        "an exposed server must not let a caller choose an identity",
    );
    assert!(
        res.headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .all(|v| !v.to_str().unwrap_or("").contains("lucida_dev_principal=")),
        "a 404 must not carry a principal cookie",
    );

    assert_dev_switcher_advertised(&server, false).await;

    // The gate is the only difference: disabled mode still serves the
    // app and still attaches the stub principal.
    let res = client.get(&server.base_url).send().await.expect("GET /");
    assert_eq!(res.status(), reqwest::StatusCode::OK);
    assert_eq!(res.text().await.expect("body"), index_html);
    assert_whoami_returns_dev_principal(&server).await;
}
