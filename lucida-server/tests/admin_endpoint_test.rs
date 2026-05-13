//! HTTP-level tests for `POST /admin/clear-proxy-cache`.
//!
//! Slice 6 (PRD #455): the endpoint is now gated by the auth middleware
//! + the `AdminRequired` extractor. There's no env-var token check
//!   anymore — admin-ness is derived from the principal's email against
//!   the `LUCIDA_ADMIN_EMAILS`-seeded set on `AuthConfig`.
//!
//! Cases covered:
//!   - No session cookie → 401 (auth middleware rejects).
//!   - Session cookie for a non-admin email → 403 (AdminRequired).
//!   - Session cookie for an admin email → 200, cache cleared.
//!   - Same, with `?dataset=URL` → 200, only that subdir cleared.
//!   - Empty admin set → admin email lookup misses → 403 (the
//!     "no admin configured" path; matches PRD §"Admin role bootstrap").
//!
//! The router is built from the same auth-middleware + extractor pieces
//! `main.rs` wires, but with a `MemorySessionStore` instead of SQLite.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::routing::post;
use chrono::{Duration as ChronoDuration, Utc};
use http_body_util::BodyExt;
use serde_json::Value;
use tokio::sync::{Mutex, broadcast};
use tower::ServiceExt;

use lucida_server::admin::admin_clear_proxy_cache;
use lucida_server::auth::middleware::{auth_middleware, build_extractor};
use lucida_server::auth::session_store::{LoginSession, LoginSessionStore};
use lucida_server::auth::{AuthConfig, MemorySessionStore};
use lucida_server::handler::dataset_url_hash16;
use lucida_server::session::Session;
use lucida_server::{AppState, BroadcastItem, ProxyConfig, UnicastRoutes};

const URL_A: &str = "gs://lucida-test/datasets/dataset-a.zarr";
const URL_B: &str = "gs://lucida-test/datasets/dataset-b.zarr";
const ADMIN_EMAIL: &str = "admin@calicolabs.com";
const NONADMIN_EMAIL: &str = "alice@calicolabs.com";

/// Build a router with the admin route + the auth middleware, wired to
/// an `AppState` whose proxy cache root is `cache_dir`. `admin_emails`
/// drives the `is_admin` derivation in the cookie extractor.
fn build_router(
    cache_dir: &Path,
    store: Arc<MemorySessionStore>,
    admin_emails: HashSet<String>,
) -> Router {
    let mut config = AuthConfig::for_tests();
    config.admin_emails = admin_emails;
    let config = Arc::new(config);

    let extractor = build_extractor(
        Arc::clone(&config),
        Arc::clone(&store) as Arc<dyn LoginSessionStore>,
    );

    let app_state = AppState {
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
        .with_state(app_state)
        .layer(from_fn_with_state(extractor, auth_middleware))
}

/// Mint a fresh session for `email` and return its cookie ID.
async fn seed_session(store: &MemorySessionStore, email: &str) -> String {
    let id = format!("sess-{email}");
    let now = Utc::now();
    store
        .create(LoginSession {
            id: id.clone(),
            email: email.to_string(),
            display_name: email.to_string(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + ChronoDuration::hours(24),
        })
        .await
        .unwrap();
    id
}

/// Convenience: build the cookie header value the cookie extractor reads.
fn cookie_header(session_id: &str) -> String {
    format!("lucida_session={session_id}")
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

fn admins(emails: &[&str]) -> HashSet<String> {
    emails.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn returns_401_without_session_cookie() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(MemorySessionStore::new());
    let app = build_router(tmp.path(), store, admins(&[ADMIN_EMAIL]));

    let req = Request::builder()
        .method("POST")
        .uri("/admin/clear-proxy-cache")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn returns_403_when_principal_not_admin() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(MemorySessionStore::new());
    let cookie_id = seed_session(&store, NONADMIN_EMAIL).await;

    let app = build_router(tmp.path(), Arc::clone(&store), admins(&[ADMIN_EMAIL]));
    let req = Request::builder()
        .method("POST")
        .uri("/admin/clear-proxy-cache")
        .header("cookie", cookie_header(&cookie_id))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let body = body_to_string(res.into_body()).await;
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["error"], "forbidden");
}

#[tokio::test]
async fn returns_403_when_admin_set_empty() {
    // PRD: "Empty/unset → empty set (no admins; admin endpoints return
    // 403 for everyone)." A logged-in user with no configured admins
    // must still be rejected.
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(MemorySessionStore::new());
    let cookie_id = seed_session(&store, ADMIN_EMAIL).await;

    let app = build_router(tmp.path(), Arc::clone(&store), admins(&[])); // empty
    let req = Request::builder()
        .method("POST")
        .uri("/admin/clear-proxy-cache")
        .header("cookie", cookie_header(&cookie_id))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn returns_200_with_admin_session_and_clears_all() {
    let tmp = tempfile::tempdir().unwrap();
    let dir_a = populate_dataset(tmp.path(), URL_A);
    let dir_b = populate_dataset(tmp.path(), URL_B);
    assert!(dir_a.exists());
    assert!(dir_b.exists());

    let store = Arc::new(MemorySessionStore::new());
    let cookie_id = seed_session(&store, ADMIN_EMAIL).await;

    let app = build_router(tmp.path(), Arc::clone(&store), admins(&[ADMIN_EMAIL]));
    let req = Request::builder()
        .method("POST")
        .uri("/admin/clear-proxy-cache")
        .header("cookie", cookie_header(&cookie_id))
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
    let tmp = tempfile::tempdir().unwrap();
    let dir_a = populate_dataset(tmp.path(), URL_A);
    let dir_b = populate_dataset(tmp.path(), URL_B);

    let store = Arc::new(MemorySessionStore::new());
    let cookie_id = seed_session(&store, ADMIN_EMAIL).await;

    let app = build_router(tmp.path(), Arc::clone(&store), admins(&[ADMIN_EMAIL]));
    let encoded = urlencode(URL_A);
    let uri = format!("/admin/clear-proxy-cache?dataset={encoded}");
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("cookie", cookie_header(&cookie_id))
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

/// Integration test from the slice 6 acceptance criteria: a dev-login
/// session for `dev@local`, with `dev@local` in the admin set, can hit
/// the admin endpoint.
#[tokio::test]
async fn dev_local_session_with_dev_local_admin_allowlist_succeeds() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(MemorySessionStore::new());
    let cookie_id = seed_session(&store, "dev@local").await;

    let app = build_router(tmp.path(), Arc::clone(&store), admins(&["dev@local"]));
    let req = Request::builder()
        .method("POST")
        .uri("/admin/clear-proxy-cache")
        .header("cookie", cookie_header(&cookie_id))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

/// Same dev-login session, but no admin emails configured: must 403.
/// This is the "env var unset" half of the acceptance criteria.
#[tokio::test]
async fn dev_local_session_without_admin_allowlist_403s() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(MemorySessionStore::new());
    let cookie_id = seed_session(&store, "dev@local").await;

    let app = build_router(tmp.path(), Arc::clone(&store), admins(&[]));
    let req = Request::builder()
        .method("POST")
        .uri("/admin/clear-proxy-cache")
        .header("cookie", cookie_header(&cookie_id))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
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
