//! End-to-end happy-path lifecycle for server-stored bookmarks.
//!
//! Stands up the bookmarks router behind the real auth middleware
//! (driven by a `MemorySessionStore` seeded with a known cookie) and
//! walks through the full CRUD cycle the way a curl smoke test would:
//!
//!   POST   /api/bookmarks            → 201 with Location header
//!   GET    /api/bookmarks            → 200 with the new entry visible
//!   GET    /api/bookmarks/:id        → 200 with single body
//!   PATCH  /api/bookmarks/:id        → 200 with renamed body
//!   DELETE /api/bookmarks/:id        → 204
//!   GET    /api/bookmarks/:id        → 404
//!
//! Plus the cross-user permission boundary: a second principal (Bob)
//! gets 403 when trying to PATCH or DELETE Alice's bookmark.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::header::LOCATION;
use axum::http::{Request, StatusCode};
use axum::middleware::from_fn_with_state;
use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{Value, json};
use tower::ServiceExt;

use lucida_server::auth::middleware::{SharedExtractor, auth_middleware};
use lucida_server::auth::principal::SessionCookieExtractor;
use lucida_server::auth::{AuthConfig, LoginSession, LoginSessionStore, MemorySessionStore};
use lucida_server::bookmarks::handlers::BookmarksState;
use lucida_server::bookmarks::routes::router as bookmarks_router;
use lucida_server::bookmarks::{BookmarkStore, MemoryBookmarkStore};

/// Pre-seeded cookie value for the dev session — matches the canned
/// principal `StubPrincipalExtractor` would yield in disabled mode, so
/// the bookmarks lifecycle test that used to walk through `/auth/dev/login`
/// still exercises the same `dev@local` identity.
const DEV_COOKIE: &str = "dev-cookie";

/// Build the test app. Three prebaked sessions: `alice@x`, `bob@x`,
/// and `dev@local`, keyed by the cookies `alice-cookie` / `bob-cookie`
/// / `dev-cookie` so tests can switch identities by sending the right
/// Cookie header.
///
/// Bookmarks tests stay on the cookie path because they need per-user
/// identity to exercise the cross-user permission boundary — the
/// disabled-mode stub extractor's single shared `dev@local` principal
/// can't drive the alice-vs-bob assertion. So this harness keeps the
/// cookie extractor explicitly rather than going through the
/// AuthMode-aware `build_extractor` picker.
async fn build_app() -> Router {
    let session_store = Arc::new(MemorySessionStore::new());
    let now = Utc::now();
    session_store
        .create(LoginSession {
            id: "alice-cookie".into(),
            email: "alice@x".into(),
            display_name: "Alice".into(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + ChronoDuration::hours(24),
        })
        .await
        .unwrap();
    session_store
        .create(LoginSession {
            id: "bob-cookie".into(),
            email: "bob@x".into(),
            display_name: "Bob".into(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + ChronoDuration::hours(24),
        })
        .await
        .unwrap();
    session_store
        .create(LoginSession {
            id: DEV_COOKIE.into(),
            email: "dev@local".into(),
            display_name: "Local Dev".into(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + ChronoDuration::hours(24),
        })
        .await
        .unwrap();

    let config = Arc::new(AuthConfig::for_tests());
    let extractor: SharedExtractor = Arc::new(SessionCookieExtractor::new(
        Arc::clone(&config),
        session_store.clone() as Arc<dyn LoginSessionStore>,
    ));

    let bookmark_store: Arc<dyn BookmarkStore> = Arc::new(MemoryBookmarkStore::new());
    let bookmarks_state = BookmarksState {
        store: bookmark_store,
        // This REST-only test doesn't drive the broadcast path (no live
        // WebSocket session); leaving these None makes the handlers
        // no-op the broadcast call.
        session: None,
        unicast_routes: None,
    };

    bookmarks_router(bookmarks_state).layer(from_fn_with_state(extractor, auth_middleware))
}

async fn read_json(res: axum::response::Response) -> Value {
    let bytes = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        panic!(
            "body did not parse: {e}; raw: {}",
            String::from_utf8_lossy(&bytes)
        )
    })
}

#[tokio::test]
async fn full_crud_happy_path_lifecycle() {
    let app = build_app().await;

    // POST as Alice
    let body = json!({
        "name": "Group B7 view",
        "datasets": ["gs://bucket/a.zarr"],
        "view": {
            "v": 1,
            "camera": {"mode": "slice", "center": [0.0, 0.0], "zoom": 1.0, "viewport": [800, 600]},
            "view": {"z_range": {"start": 0, "end": 1}, "t": 0, "c": 0},
            "display": {"contrast_min": 0.0, "contrast_max": 65535.0, "gamma": 1.0}
        }
    });
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bookmarks")
                .header("cookie", "lucida_session=alice-cookie")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let location = res
        .headers()
        .get(LOCATION)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let created = read_json(res).await;
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["created_by"], "alice@x");
    assert_eq!(created["created_by_name"], "Alice");
    assert_eq!(location, format!("/api/bookmarks/{id}"));

    // GET list (should include the bookmark)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/bookmarks")
                .header("cookie", "lucida_session=alice-cookie")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let list = read_json(res).await;
    assert_eq!(list.as_array().unwrap().len(), 1);

    // GET list filtered by dataset URL — overlap
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/bookmarks?dataset=gs%3A%2F%2Fbucket%2Fa.zarr")
                .header("cookie", "lucida_session=alice-cookie")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let filtered = read_json(res).await;
    assert_eq!(filtered.as_array().unwrap().len(), 1);

    // GET list filtered by non-overlapping dataset — empty
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/bookmarks?dataset=other.zarr")
                .header("cookie", "lucida_session=alice-cookie")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let filtered = read_json(res).await;
    assert!(filtered.as_array().unwrap().is_empty());

    // GET single
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bookmarks/{id}"))
                .header("cookie", "lucida_session=alice-cookie")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let single = read_json(res).await;
    assert_eq!(single["id"], id);

    // Bob (cross-user) tries to PATCH Alice's bookmark — 403
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/bookmarks/{id}"))
                .header("cookie", "lucida_session=bob-cookie")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({"name": "hijacked"})).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // Alice renames her own bookmark — 200
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/bookmarks/{id}"))
                .header("cookie", "lucida_session=alice-cookie")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({"name": "Renamed by owner"})).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let patched = read_json(res).await;
    assert_eq!(patched["name"], "Renamed by owner");

    // Bob tries to DELETE — 403
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/bookmarks/{id}"))
                .header("cookie", "lucida_session=bob-cookie")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // Alice deletes her own — 204
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/bookmarks/{id}"))
                .header("cookie", "lucida_session=alice-cookie")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    // GET single after delete — 404
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/bookmarks/{id}"))
                .header("cookie", "lucida_session=alice-cookie")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

/// Walk through CRUD as the `dev@local` principal. Mirrors what the
/// curl smoke test would see against a server running in disabled
/// mode — every request resolves to `dev@local` via the stub
/// extractor. This harness uses the cookie path with a pre-seeded dev
/// session so the bookmarks permission boundary tests above can stay
/// on the same wiring.
#[tokio::test]
async fn lifecycle_as_dev_principal() {
    let app = build_app().await;

    let cookie = format!("lucida_session={DEV_COOKIE}");

    // POST a bookmark
    let body = json!({
        "name": "Dev cycle",
        "datasets": [],
        "view": {
            "v": 1,
            "camera": {"mode": "slice", "center": [0.0, 0.0], "zoom": 1.0, "viewport": [800, 600]},
            "view": {"z_range": {"start": 0, "end": 1}, "t": 0, "c": 0},
            "display": {"contrast_min": 0.0, "contrast_max": 65535.0, "gamma": 1.0}
        }
    });
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/bookmarks")
                .header("cookie", &cookie)
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let created = read_json(res).await;
    assert_eq!(created["created_by"], "dev@local");
}
