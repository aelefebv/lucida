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

// GET /api/listings without a cookie must not 401: the principal flows
// through the middleware to the app routes in disabled mode.
#[tokio::test]
async fn listings_answer_without_cookie_in_disabled_mode() {
    let server = spawn_server("127.0.0.1", &[]);
    let res = http_client()
        .get(format!("{}/api/listings", server.base_url))
        .send()
        .await
        .expect("GET /api/listings");
    assert_eq!(
        res.status(),
        reqwest::StatusCode::OK,
        "/api/listings must answer in disabled mode (the principal flows from the stub)",
    );
    let body: Value = res.json().await.expect("json body");
    assert!(body["results"].is_array(), "got {body}");
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
    let server = spawn_server("127.0.0.1", &[("LUCIDA_ADMIN_EMAILS", "admin@example.com")]);
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
    assert_eq!(
        principal["is_admin"], false,
        "a switch cannot ask for admin rights"
    );

    let admin: Value = client
        .post(format!("{}/auth/dev/login", server.base_url))
        .json(&serde_json::json!({ "email": "admin@example.com" }))
        .send()
        .await
        .expect("POST /auth/dev/login")
        .json()
        .await
        .expect("json body");
    assert_eq!(admin["is_admin"], true, "LUCIDA_ADMIN_EMAILS grants them");
}

/// A dev principal cookie written by hand rather than by the switcher.
fn forged_dev_cookie(email: &str) -> String {
    use base64::Engine;
    let payload = serde_json::json!({ "email": email, "display_name": "Forged", "is_admin": true });
    format!(
        "lucida_dev_principal={}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string())
    )
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

    // Nor does a cookie the caller wrote themselves name anybody.
    let whoami: Value = client
        .get(format!("{}/auth/whoami", server.base_url))
        .header(
            reqwest::header::COOKIE,
            forged_dev_cookie("owner@example.com"),
        )
        .send()
        .await
        .expect("GET /auth/whoami")
        .json()
        .await
        .expect("json body");
    assert_eq!(whoami["email"], "dev@local", "got {whoami}");
    assert_eq!(whoami["is_admin"], false, "got {whoami}");
}

/// A directory holding a stand-in SPA bundle, for `LUCIDA_WEB_DIST`.
fn web_dist() -> tempfile::TempDir {
    let dist = tempfile::tempdir().unwrap();
    std::fs::write(dist.path().join("index.html"), "<html>lucida</html>").unwrap();
    dist
}

/// Load a page the way a browser does, and return the session cookie the
/// response set, whole, if it set one.
async fn load_page(server: &SpawnedServer, path: &str, cookie: Option<&str>) -> Option<String> {
    let mut request = http_client()
        .get(format!("{}{path}", server.base_url))
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml");
    if let Some(cookie) = cookie {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    let res = request.send().await.expect("GET a page");
    assert_eq!(res.status(), reqwest::StatusCode::OK);
    res.headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.starts_with("lucida_session="))
        .map(str::to_string)
}

async fn whoami(server: &SpawnedServer, cookie: Option<&str>) -> Value {
    let mut request = http_client().get(format!("{}/auth/whoami", server.base_url));
    if let Some(cookie) = cookie {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    request
        .send()
        .await
        .expect("GET /auth/whoami")
        .json()
        .await
        .expect("json body")
}

fn name_value(set_cookie: &str) -> &str {
    set_cookie.split(';').next().unwrap()
}

// On a server other machines reach, each browser that loads the app
// becomes its own person, through the session store the server already
// keeps. Anything that never loads the page, such as the command-line
// client, is still `dev@local`.
#[tokio::test]
async fn on_a_shared_bind_each_browser_gets_its_own_anonymous_identity() {
    let dist = web_dist();
    let server = spawn_server(
        "0.0.0.0",
        &[
            ("LUCIDA_AUTH", "disabled"),
            ("LUCIDA_INSECURE", "1"),
            ("LUCIDA_WEB_DIST", dist.path().to_str().unwrap()),
        ],
    );

    let first = load_page(&server, "/", None)
        .await
        .expect("a first visit mints");
    assert!(first.contains("HttpOnly"), "{first}");
    assert!(first.contains("Secure"), "an exposed bind: {first}");
    let second = load_page(&server, "/open?url=/data/a.zarr", None)
        .await
        .expect("another browser's first visit mints too");

    let a = whoami(&server, Some(name_value(&first))).await;
    let b = whoami(&server, Some(name_value(&second))).await;
    assert_ne!(a["email"], b["email"], "{a} vs {b}");
    for person in [&a, &b] {
        assert!(
            person["email"].as_str().unwrap().starts_with("anon-"),
            "{person}"
        );
        assert_eq!(person["is_admin"], false, "{person}");
    }

    assert_eq!(
        load_page(&server, "/", Some(name_value(&first))).await,
        None,
        "a browser with a live session keeps it",
    );
    assert_eq!(
        load_page(&server, "/w/ws-1?render=1", None).await,
        None,
        "the capture surface stays the CLI that opened it",
    );
    assert_whoami_returns_dev_principal(&server).await;
    let forged = whoami(&server, Some("lucida_session=anon_forged")).await;
    assert_eq!(forged["email"], "dev@local", "got {forged}");
}

// On loopback the one person at the machine drives the CLI and the
// browser alike, so a workspace the CLI made opens in the browser with
// no share step.
#[tokio::test]
async fn on_loopback_the_browser_opens_a_workspace_the_cli_made() {
    let dist = web_dist();
    let server = spawn_server(
        "127.0.0.1",
        &[("LUCIDA_WEB_DIST", dist.path().to_str().unwrap())],
    );
    let client = http_client();

    let created: Value = client
        .post(format!("{}/api/workspaces", server.base_url))
        .json(&serde_json::json!({ "name": "made by the cli" }))
        .send()
        .await
        .expect("POST /api/workspaces")
        .json()
        .await
        .expect("json body");
    let id = created["id"].as_str().expect("a workspace id");

    assert_eq!(
        load_page(&server, &format!("/w/{id}"), None).await,
        None,
        "the browser is given no identity of its own",
    );
    let opened = client
        .get(format!("{}/api/workspaces/{id}", server.base_url))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .expect("GET /api/workspaces/{id}");
    assert_eq!(opened.status(), reqwest::StatusCode::OK);
    let opened: Value = opened.json().await.expect("json body");
    assert_eq!(opened["role"], "owner", "got {opened}");
}
