//! Liveness (`/healthz`), readiness (`/readyz`), and version (`/version`)
//! endpoints for containerized deploys.
//!
//! Liveness and readiness answer the same. They are separate routes so a
//! drain can flip readiness to 503 while liveness stays 200. None of them
//! checks the storage backend; that is [`crate::status`]. All three mount
//! on the public router half, because probes and monitors carry no session.

use axum::Router;
use axum::http::StatusCode;
use axum::routing::get;

pub const HEALTHZ_PATH: &str = "/healthz";
pub const READYZ_PATH: &str = "/readyz";
pub const VERSION_PATH: &str = "/version";

/// Every path [`router`] mounts. A route configured to sit beside these,
/// such as the status route, checks its path against this list at boot,
/// where the message can name the variable, rather than letting the
/// router panic on the collision.
pub const PATHS: [&str; 3] = [HEALTHZ_PATH, READYZ_PATH, VERSION_PATH];

/// Liveness probe handler. Always 200; an "I should be killed" condition,
/// such as a fatal background-task failure, would surface here.
async fn healthz() -> (StatusCode, &'static str) {
    (StatusCode::OK, "ok")
}

/// Readiness probe handler. Always 200; a drain on shutdown would flip it
/// to 503 while liveness stays 200.
async fn readyz() -> (StatusCode, &'static str) {
    (StatusCode::OK, "ok")
}

/// Version handler. Returns the lucida-server version sourced from
/// `Cargo.toml` at build time (`CARGO_PKG_VERSION` is set by cargo).
/// Body is plain text matching `lucida-server --version` output, so
/// scripts can grep either source interchangeably.
async fn version() -> (StatusCode, &'static str) {
    (StatusCode::OK, env!("CARGO_PKG_VERSION"))
}

/// Build the health-probe router with `/healthz`, `/readyz`, and
/// `/version` mounted.
///
/// The returned router is intended to be merged into the application's
/// **public** router half (the one NOT wrapped by auth middleware) so
/// that a kubelet without credentials can hit the probes and so
/// monitoring can read /version without a session cookie.
pub fn router() -> Router {
    Router::new()
        .route(HEALTHZ_PATH, get(healthz))
        .route(READYZ_PATH, get(readyz))
        .route(VERSION_PATH, get(version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn healthz_returns_200_ok() {
        let app = router();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 64).await.unwrap();
        assert_eq!(&bytes[..], b"ok");
    }

    #[tokio::test]
    async fn readyz_returns_200_ok() {
        let app = router();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 64).await.unwrap();
        assert_eq!(&bytes[..], b"ok");
    }

    #[tokio::test]
    async fn version_returns_cargo_pkg_version() {
        let app = router();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/version")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 64).await.unwrap();
        assert_eq!(&bytes[..], env!("CARGO_PKG_VERSION").as_bytes());
    }
}
