//! HTTP-level tests for `POST /admin/clear-proxy-cache`.
//!
//! Builds a minimal axum `Router` containing just the admin route +
//! `AppState` and drives it with `tower::ServiceExt::oneshot`. We don't
//! need a TCP listener — axum services are just `tower::Service`s, so we
//! can hand them constructed `Request`s directly.
//!
//! Cases covered:
//!   - `LUCIDA_ADMIN_TOKEN` unset → 503.
//!   - Missing `Authorization` → 401.
//!   - Wrong token → 401.
//!   - Correct token → 200, cache cleared.
//!   - Correct token + `?dataset=URL` → 200, only that subdir cleared.
//!
//! The env var is global state, so the tests gate around a `Mutex` and
//! restore the previous value at the end. They run serially via the
//! mutex, so `cargo test` parallelism stays correct without `--test-threads=1`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use axum::Router;
use http_body_util::BodyExt;
use serde_json::Value;
use tokio::sync::{broadcast, Mutex};
use tower::ServiceExt;

use lucida_server::admin::admin_clear_proxy_cache;
use lucida_server::handler::dataset_url_hash16;
use lucida_server::session::Session;
use lucida_server::{AppState, BroadcastItem, ProxyConfig, UnicastRoutes};

const ADMIN_TOKEN: &str = "test_secret";
const URL_A: &str = "gs://lucida-test/datasets/dataset-a.zarr";
const URL_B: &str = "gs://lucida-test/datasets/dataset-b.zarr";

/// Serializes env var mutations across tests in this file. The
/// `LUCIDA_ADMIN_TOKEN` env var is process-global, so concurrent tests
/// would race without this. We keep the lock in a `OnceLock` so each
/// test grabs the same one.
fn env_lock() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| StdMutex::new(()))
}

/// Set or clear `LUCIDA_ADMIN_TOKEN` for the duration of the returned
/// guard. Drop restores the previous value (or removes the var if it
/// was unset). Holds the global env lock, so callers serialize against
/// each other.
struct EnvGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(value: Option<&str>) -> Self {
        // SAFETY: env mutation is only safe single-threaded; we serialize
        // via the global mutex so no other test thread is racing.
        let lock = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var("LUCIDA_ADMIN_TOKEN").ok();
        unsafe {
            match value {
                Some(v) => std::env::set_var("LUCIDA_ADMIN_TOKEN", v),
                None => std::env::remove_var("LUCIDA_ADMIN_TOKEN"),
            }
        }
        Self { _lock: lock, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.previous {
                Some(v) => std::env::set_var("LUCIDA_ADMIN_TOKEN", v),
                None => std::env::remove_var("LUCIDA_ADMIN_TOKEN"),
            }
        }
    }
}

/// Build a router with just the admin route, wired to `AppState` whose
/// `proxy_config.cache_dir` points at the given directory.
fn build_router(cache_dir: &Path) -> Router {
    let state = AppState {
        session: Arc::new(Mutex::new(Session::new())),
        tx: broadcast::channel::<BroadcastItem>(8).0,
        next_id: Arc::new(AtomicU64::new(0)),
        unicast_routes: Arc::new(Mutex::new(HashMap::new())) as UnicastRoutes,
        data_dir: None,
        proxy_config: ProxyConfig {
            cache_dir: cache_dir.to_path_buf(),
            concurrency: 1,
        },
    };
    Router::new()
        .route("/admin/clear-proxy-cache", post(admin_clear_proxy_cache))
        .with_state(state)
}

/// Hex-encode a 16-byte hash to 32 lowercase chars (matches `proxy::cache`).
fn hex16(bytes: &[u8; 16]) -> String {
    let mut out = String::with_capacity(32);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Plant a couple of fake chunk files under the dataset's expected
/// subdir, returning that subdir.
fn populate_dataset(cache_dir: &Path, url: &str) -> std::path::PathBuf {
    let dir = cache_dir
        .join(hex16(&dataset_url_hash16(url)))
        .join("entity")
        .join("field3d");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("T00000_C000.bin"), b"a").unwrap();
    std::fs::write(dir.join("T00001_C000.bin"), b"b").unwrap();
    cache_dir.join(hex16(&dataset_url_hash16(url)))
}

async fn body_to_string(body: Body) -> String {
    let bytes = body.collect().await.unwrap().to_bytes();
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[tokio::test]
async fn returns_503_when_admin_token_unset() {
    let _env = EnvGuard::set(None);
    let tmp = tempfile::tempdir().unwrap();
    let app = build_router(tmp.path());

    let req = Request::builder()
        .method("POST")
        .uri("/admin/clear-proxy-cache")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = body_to_string(res.into_body()).await;
    assert!(body.contains("admin disabled"), "got {body:?}");
}

#[tokio::test]
async fn returns_401_when_authorization_header_missing() {
    let _env = EnvGuard::set(Some(ADMIN_TOKEN));
    let tmp = tempfile::tempdir().unwrap();
    let app = build_router(tmp.path());

    let req = Request::builder()
        .method("POST")
        .uri("/admin/clear-proxy-cache")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn returns_401_when_token_wrong() {
    let _env = EnvGuard::set(Some(ADMIN_TOKEN));
    let tmp = tempfile::tempdir().unwrap();
    let app = build_router(tmp.path());

    let req = Request::builder()
        .method("POST")
        .uri("/admin/clear-proxy-cache")
        .header("authorization", "Bearer not_the_token")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn returns_200_with_correct_token_and_clears_all() {
    let _env = EnvGuard::set(Some(ADMIN_TOKEN));
    let tmp = tempfile::tempdir().unwrap();
    let dir_a = populate_dataset(tmp.path(), URL_A);
    let dir_b = populate_dataset(tmp.path(), URL_B);
    assert!(dir_a.exists());
    assert!(dir_b.exists());

    let app = build_router(tmp.path());
    let req = Request::builder()
        .method("POST")
        .uri("/admin/clear-proxy-cache")
        .header("authorization", format!("Bearer {ADMIN_TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = body_to_string(res.into_body()).await;
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["cleared"], Value::Bool(true));
    assert_eq!(json["datasets"], Value::from(2));
    assert_eq!(json["files"], Value::from(4));

    assert!(!dir_a.exists());
    assert!(!dir_b.exists());
}

#[tokio::test]
async fn returns_200_and_clears_only_specified_dataset() {
    let _env = EnvGuard::set(Some(ADMIN_TOKEN));
    let tmp = tempfile::tempdir().unwrap();
    let dir_a = populate_dataset(tmp.path(), URL_A);
    let dir_b = populate_dataset(tmp.path(), URL_B);

    let app = build_router(tmp.path());
    // Encode the URL into the query string so axum's Query extractor
    // sees the full value.
    let encoded = urlencode(URL_A);
    let uri = format!("/admin/clear-proxy-cache?dataset={encoded}");
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("authorization", format!("Bearer {ADMIN_TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = body_to_string(res.into_body()).await;
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["datasets"], Value::from(1));
    assert_eq!(json["files"], Value::from(2));

    assert!(!dir_a.exists(), "A should be cleared");
    assert!(dir_b.exists(), "B should be untouched");
}

/// Minimal percent-encoder for the handful of characters in our test
/// URLs. We deliberately avoid pulling in `percent-encoding` just for
/// tests.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}
