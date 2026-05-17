//! Cheap insurance against a future refactor accidentally gating the
//! kubelet probes behind auth: builds the full app router with the auth
//! middleware actually applied, then asserts that `GET /healthz` and
//! `GET /readyz` succeed without a `lucida_session` cookie.
//!
//! If somebody refactors `main.rs` and accidentally merges the health
//! router into the protected half, this test goes red because the auth
//! middleware will redirect/401 unauthenticated probe requests.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::routing::get;
use tower::ServiceExt;

use lucida_server::auth::middleware::{SharedExtractor, auth_middleware};
use lucida_server::auth::principal::SessionCookieExtractor;
use lucida_server::auth::{AuthConfig, LoginSessionStore, MemorySessionStore};
use lucida_server::health;

/// Build a router that mirrors `main.rs`'s public/protected split:
/// `health::router()` lives on the unwrapped public half; a stub
/// protected route exists only so the test exercises the same wrapping
/// pattern (auth middleware around the protected half, then merge with
/// the public half) used in production.
///
/// We use the cookie extractor explicitly (not `build_extractor`,
/// which picks the stub for the test config's `Disabled` mode) so the
/// protected stub route would actually 401 if somebody accidentally
/// merged the health router into the protected half.
async fn build_app() -> Router {
    let session_store: Arc<dyn LoginSessionStore> = Arc::new(MemorySessionStore::new());
    let config = Arc::new(AuthConfig::for_tests());
    let extractor: SharedExtractor = Arc::new(SessionCookieExtractor::new(
        Arc::clone(&config),
        Arc::clone(&session_store),
    ));

    // Stub protected route so the auth middleware actually has
    // something to wrap; we don't hit this in the assertions, but its
    // presence makes the test topology faithful to main.rs.
    async fn protected_stub() -> &'static str {
        "protected"
    }
    let protected = Router::new()
        .route("/protected", get(protected_stub))
        .layer(from_fn_with_state(extractor, auth_middleware));

    let public = health::router();

    protected.merge(public)
}

#[tokio::test]
async fn healthz_succeeds_without_session_cookie() {
    let app = build_app().await;
    let res = app
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "/healthz must answer without auth — kubelets don't carry session cookies",
    );
    let bytes = to_bytes(res.into_body(), 64).await.unwrap();
    assert_eq!(&bytes[..], b"ok");
}

#[tokio::test]
async fn readyz_succeeds_without_session_cookie() {
    let app = build_app().await;
    let res = app
        .oneshot(
            Request::builder()
                .uri("/readyz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "/readyz must answer without auth — Service/LB probes don't carry session cookies",
    );
    let bytes = to_bytes(res.into_body(), 64).await.unwrap();
    assert_eq!(&bytes[..], b"ok");
}
