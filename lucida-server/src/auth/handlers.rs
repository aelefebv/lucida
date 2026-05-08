//! `/auth/whoami` endpoint.
//!
//! The other auth endpoints documented in PRD #455 §"REST API
//! contract" (`/auth/start`, `/auth/callback`, `/auth/logout`,
//! `/auth/error`) land in later slices alongside the cookie/session/
//! OAuth machinery. Slice 1 lands `/auth/whoami` because the web
//! client needs a probe to drive the `useAuthState` hook.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::Extension;
use serde_json::json;

use lucida_core::auth_principal::AuthPrincipal;

/// `GET /auth/whoami` — returns the current `AuthPrincipal` JSON when
/// the auth middleware attached one, or 401 otherwise. The middleware
/// itself answers 401 before the handler runs in the missing-cookie
/// case; this fallback covers the (currently unreachable) edge of the
/// route being mounted without the middleware.
pub async fn whoami(principal: Option<Extension<AuthPrincipal>>) -> Response {
    match principal {
        Some(Extension(p)) => Json(p).into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthenticated" })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use axum::middleware::from_fn_with_state;
    use axum::routing::get;
    use axum::Router;
    use std::sync::Arc;
    use tower::ServiceExt;

    use crate::auth::middleware::{auth_middleware, SharedExtractor};
    use crate::auth::principal::StubPrincipalExtractor;

    #[tokio::test]
    async fn whoami_returns_principal_when_authenticated() {
        let extractor: SharedExtractor = Arc::new(StubPrincipalExtractor::new());
        let app = Router::new()
            .route("/auth/whoami", get(whoami))
            .layer(from_fn_with_state(extractor, auth_middleware));

        let req = Request::builder()
            .uri("/auth/whoami")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let p: AuthPrincipal = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(p, StubPrincipalExtractor::principal());
    }

    /// When mounted *without* the middleware, the handler must still
    /// return 401 rather than panicking. This guards against a future
    /// refactor that accidentally drops the middleware from the route
    /// tree but keeps `/auth/whoami` exposed.
    #[tokio::test]
    async fn whoami_returns_401_when_no_principal_attached() {
        let app = Router::new().route("/auth/whoami", get(whoami));

        let req = Request::builder()
            .uri("/auth/whoami")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
}
