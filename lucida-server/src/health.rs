//! Liveness, readiness, and version endpoints for containerized deploys.
//!
//! `GET /healthz` answers liveness ("is this process alive?"). The
//! kubelet uses it to decide "kill and restart this pod."
//!
//! `GET /readyz` answers readiness ("should I send traffic to this
//! pod?"). The Service / load balancer uses it to decide whether to
//! route requests here.
//!
//! `GET /version` returns the running server version (sourced from
//! `Cargo.toml` at build time). Lets ops confirm what's deployed
//! without `kubectl exec`-ing in to run `lucida-server --version`.
//!
//! The probe routes return `200 OK` with body `"ok"` today. The
//! liveness/readiness split is intentional even though they behave
//! identically: future drain-on-shutdown semantics will flip readiness
//! to 503 while liveness stays 200, so the LB stops routing but the
//! kubelet doesn't restart the pod mid-drain. The boundary belongs in
//! code now so the manifests (and any future drain logic) have stable
//! URLs to point at.
//!
//! ## Auth interaction
//!
//! All three routes MUST land on the public router half — the kubelet
//! does not present a session cookie, and probes timing out due to a
//! 401 would defeat their entire purpose. /version is similarly public
//! so it's reachable from monitoring/alerting that may not authenticate.
//! See [[subsystems/auth]] for the public/protected split.

use axum::Router;
use axum::http::StatusCode;
use axum::routing::get;

/// Liveness probe handler. Always 200 today; the moment we have an
/// "I should be killed" condition (e.g. fatal background-task failure)
/// this is where it surfaces.
async fn healthz() -> (StatusCode, &'static str) {
    (StatusCode::OK, "ok")
}

/// Readiness probe handler. Always 200 today; future drain-on-shutdown
/// will flip this to 503 while liveness stays 200.
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
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/version", get(version))
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
