//! End-to-end HTTP tests for `AuthMode::Disabled`.
//!
//! Spawn the actual `lucida-server` binary in disabled mode, then drive
//! it over real HTTP via `reqwest`. The regression these tests close: if
//! `build_extractor` returned the cookie extractor regardless of
//! `AuthMode`, every request would 401 even though the binary booted
//! fine. `auth_config_e2e.rs` only checks that the binary boots and
//! binds; these tests close the gap by exercising actual HTTP
//! request/response.
//!
//! Each test:
//! - Picks a unique loopback (or `0.0.0.0`) port via `pick_loopback_port`.
//! - Wipes the parent process env with `env_clear` so the test
//!   environment can't smuggle in `LUCIDA_*` overrides.
//! - Sets a tempdir-scoped `LUCIDA_DB_PATH` so the SQLite store doesn't
//!   write `lucida.db` into the workspace root.
//! - Drains stdout/stderr in background threads to avoid the child
//!   blocking on a full pipe (axum + tracing chatter fills 64K fast).
//! - Kills the child + drops the tempdir on test end.

use std::io::Read;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_lucida-server");

/// Reserve and immediately drop a loopback TCP port. The port is briefly
/// available between the drop here and the spawned server's bind; that
/// race is acceptable for these tests because each test also runs with
/// a unique port (no two tests collide).
fn pick_loopback_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

/// Build a `Command` with a wiped env, then layer the supplied
/// `LUCIDA_*` vars on top. Always points the SQLite store at a tempdir.
fn server_command(tmp_db: &std::path::Path, env: &[(&str, &str)]) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("LUCIDA_DB_PATH", tmp_db.to_str().expect("utf-8"))
        .env("RUST_LOG", "lucida_server=warn");
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd
}

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

/// Spawn the server with the given env vars, poll the bind addr until
/// it accepts a TCP connection (success) or the process exits
/// (failure). Returns a `SpawnedServer` owning the child.
///
/// `connect_addr` is what the test client uses (always `127.0.0.1:port`
/// even when the server is bound on `0.0.0.0:port`, since the loopback
/// interface always reaches the wildcard bind from the same host).
fn spawn_server(bind: &str, connect_addr: &str, extra_env: &[(&str, &str)]) -> SpawnedServer {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("lucida.db");
    let mut env = vec![("LUCIDA_BIND", bind)];
    env.extend_from_slice(extra_env);
    let mut cmd = server_command(&db_path, &env);
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn server");

    // Drain pipes in background threads so the child never blocks on a
    // full stderr buffer (axum + tracing chatter fills 64K fast under
    // load even in `warn`-only mode).
    if let Some(s) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::BufReader::new(s).read_to_end(&mut buf);
        });
    }
    let stderr_buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    if let Some(s) = child.stderr.take() {
        let stderr_buf = std::sync::Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            let mut tmp = [0u8; 4096];
            let mut s = s;
            loop {
                match s.read(&mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => stderr_buf.lock().unwrap().extend_from_slice(&tmp[..n]),
                }
            }
        });
    }

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            let stderr = String::from_utf8_lossy(&stderr_buf.lock().unwrap()).into_owned();
            panic!(
                "server exited with {status:?} before binding {connect_addr}; stderr=\n{stderr}",
            );
        }
        match std::net::TcpStream::connect_timeout(
            &connect_addr.parse().unwrap(),
            Duration::from_millis(200),
        ) {
            Ok(_) => break,
            Err(last_err) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let stderr = String::from_utf8_lossy(&stderr_buf.lock().unwrap()).into_owned();
                    panic!(
                        "timed out waiting for {connect_addr} to accept; last error={last_err:?}; \
                         stderr=\n{stderr}",
                    );
                }
                std::thread::sleep(Duration::from_millis(75));
            }
        }
    }

    SpawnedServer {
        child,
        _tmp: tmp,
        base_url: format!("http://{connect_addr}"),
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
    assert_eq!(body["is_admin"], true);
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
    let port = pick_loopback_port();
    let bind = format!("127.0.0.1:{port}");
    let server = spawn_server(&bind, &bind, &[]);
    assert_whoami_returns_dev_principal(&server).await;
}

// Docker quickstart path: explicit LUCIDA_AUTH=disabled +
// LUCIDA_INSECURE=1 on a non-loopback bind behaves identically.
#[tokio::test]
async fn explicit_disabled_non_loopback_with_insecure_whoami_returns_dev_principal() {
    let port = pick_loopback_port();
    let bind = format!("0.0.0.0:{port}");
    // Connect via loopback; the wildcard bind reaches it on the same host.
    let connect = format!("127.0.0.1:{port}");
    let server = spawn_server(
        &bind,
        &connect,
        &[("LUCIDA_AUTH", "disabled"), ("LUCIDA_INSECURE", "1")],
    );
    assert_whoami_returns_dev_principal(&server).await;
}

// GET /api/browse without a cookie must not 401 — verifies the
// principal flows through middleware to non-auth handlers in disabled
// mode.
#[tokio::test]
async fn browse_works_without_cookie_in_disabled_mode() {
    let port = pick_loopback_port();
    let bind = format!("127.0.0.1:{port}");
    // Tempdir scoped to the test; seed one file so the listing isn't
    // entirely empty (catches a bug where the handler returned 200 on
    // an empty dir but 500 on a real one). We seed a regular file
    // rather than a directory so the test doesn't depend on canonical
    // sub-path resolution semantics.
    let data_tmp = tempfile::tempdir().unwrap();
    std::fs::write(data_tmp.path().join("seed.txt"), b"hello").unwrap();
    let data_dir_str = data_tmp.path().to_str().unwrap().to_string();

    let server = spawn_server(&bind, &bind, &[("LUCIDA_DATA_DIR", &data_dir_str)]);
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
}

// POST /auth/dev/login is gone — the route was retired in favour of
// the stub extractor. `LUCIDA_WEB_DIST` points at an empty tempdir so
// the SPA fallback returns its missing-dist landing instead of
// ServeDir's 405; assert on the meaningful negative: no session cookie
// set, body is NOT a JSON principal.
#[tokio::test]
async fn dev_login_route_is_gone_in_disabled_mode() {
    let port = pick_loopback_port();
    let bind = format!("127.0.0.1:{port}");
    let empty_dist = tempfile::tempdir().unwrap();
    let dist_str = empty_dist.path().to_str().unwrap().to_string();
    let server = spawn_server(&bind, &bind, &[("LUCIDA_WEB_DIST", &dist_str)]);

    let client = http_client();
    let res = client
        .post(format!("{}/auth/dev/login", server.base_url))
        .send()
        .await
        .expect("POST /auth/dev/login");

    // The dev_login handler used to set `Set-Cookie: lucida_session=…`
    // and return a JSON `AuthPrincipal` body. Both must be absent now
    // — whatever else the response looks like (404 from a route-not-
    // found, 405 from ServeDir, 200 from the missing-dist landing),
    // it must NOT be a session-mint.
    assert!(
        res.headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .all(|v| !v.to_str().unwrap_or("").contains("lucida_session=")),
        "/auth/dev/login was retired; must not set lucida_session",
    );
    let body = res.text().await.expect("body");
    assert!(
        !body.contains("\"email\":\"dev@local\""),
        "/auth/dev/login was retired; must not return a JSON dev principal; body=\n{body}",
    );
}
