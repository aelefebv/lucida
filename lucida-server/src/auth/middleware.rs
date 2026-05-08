//! Axum middleware that runs the configured `PrincipalExtractor` on
//! every inbound request, attaches the resulting `AuthPrincipal` to
//! request extensions, and short-circuits with 401 when extraction
//! fails.
//!
//! ## 401 response shape
//!
//! Per PRD #455 §"REST API contract", unauthenticated requests to HTML
//! routes will eventually render the `UnauthLanding` page (so the JS
//! shim can capture `location.hash` for the OAuth roundtrip), while
//! API routes get bare JSON. Slice 4 lands the real branching plus the
//! HTML page; this slice ships a placeholder that returns JSON for
//! every route. The route-classification surface lives here so future
//! slices have one obvious place to extend.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::auth::principal::{AuthError, PrincipalExtractor};

/// Shared handle to the active extractor. Wired into the router's
/// state so middleware closures can grab it without holding a
/// dedicated app-state field for every variant.
pub type SharedExtractor = Arc<dyn PrincipalExtractor>;

/// Axum middleware that runs the extractor and attaches the principal
/// to request extensions for downstream handlers to read via
/// `req.extensions().get::<AuthPrincipal>()`.
///
/// Wire it with `axum::middleware::from_fn_with_state(extractor, auth_middleware)`.
pub async fn auth_middleware(
    State(extractor): State<SharedExtractor>,
    req: Request,
    next: Next,
) -> Response {
    let (parts, body) = req.into_parts();
    let outcome = extractor.extract(&parts).await;

    match outcome {
        Ok(principal) => {
            let mut req = Request::from_parts(parts, body);
            req.extensions_mut().insert(principal);
            next.run(req).await
        }
        Err(err) => {
            let headers = parts.headers;
            unauthenticated_response(&err, &headers)
        }
    }
}

/// Build a 401 (or 5xx) response. Today: bare JSON regardless of
/// route. Slice 4 will branch on `accepts_html(headers)` to render the
/// JS-shim landing page for HTML navigations.
fn unauthenticated_response(err: &AuthError, _headers: &HeaderMap) -> Response {
    let status = err.status_code();
    let code = match err {
        AuthError::Unauthenticated => "unauthenticated",
        AuthError::Internal(_) => "internal",
    };
    let detail = match err {
        AuthError::Unauthenticated => None,
        AuthError::Internal(msg) => Some(msg.as_str()),
    };
    (
        status,
        Json(json!({ "error": code, "detail": detail })),
    )
        .into_response()
}

/// Best-effort classification: does the client appear to want an HTML
/// page back? Wired through to the response branch in slice 4; today
/// it's exposed for callers (and as a smoke target for tests) so the
/// future branching has a stable home.
pub fn accepts_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|accept| accept.contains("text/html"))
        .unwrap_or(false)
}

/// Build a default extractor for use when no other configuration is
/// provided. Today returns the stub; slice 4 replaces this with the
/// `LUCIDA_AUTH` env-driven selection.
pub fn default_extractor() -> SharedExtractor {
    Arc::new(crate::auth::principal::StubPrincipalExtractor::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::extract::Request as ExtractRequest;
    use axum::http::{Request, StatusCode};
    use axum::middleware::from_fn_with_state;
    use axum::routing::get;
    use axum::Router;
    use lucida_core::auth_principal::AuthPrincipal;
    use tower::ServiceExt;

    use crate::auth::principal::{StubPrincipalExtractor, AuthError, PrincipalExtractor};
    use async_trait::async_trait;

    /// Echo handler that returns whatever `AuthPrincipal` it sees in
    /// extensions. Used to assert the middleware actually attached one.
    async fn echo_principal(req: ExtractRequest) -> Response {
        match req.extensions().get::<AuthPrincipal>() {
            Some(p) => Json(p.clone()).into_response(),
            None => (StatusCode::INTERNAL_SERVER_ERROR, "no principal").into_response(),
        }
    }

    fn router_with_extractor(extractor: SharedExtractor) -> Router {
        Router::new()
            .route("/echo", get(echo_principal))
            .layer(from_fn_with_state(extractor, auth_middleware))
    }

    #[tokio::test]
    async fn middleware_attaches_stub_principal_to_extensions() {
        let extractor: SharedExtractor = Arc::new(StubPrincipalExtractor::new());
        let app = router_with_extractor(extractor);

        let req = Request::builder()
            .uri("/echo")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let p: AuthPrincipal = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(p, StubPrincipalExtractor::principal());
    }

    /// Always-fail extractor used to exercise the 401 branch without
    /// waiting for the real cookie/session machinery.
    struct AlwaysUnauth;

    #[async_trait]
    impl PrincipalExtractor for AlwaysUnauth {
        async fn extract(&self, _: &axum::http::request::Parts) -> Result<AuthPrincipal, AuthError> {
            Err(AuthError::Unauthenticated)
        }
    }

    #[tokio::test]
    async fn middleware_returns_401_when_extractor_fails() {
        let extractor: SharedExtractor = Arc::new(AlwaysUnauth);
        let app = router_with_extractor(extractor);

        let req = Request::builder()
            .uri("/echo")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "unauthenticated");
    }

    #[test]
    fn accepts_html_classifies_browser_navigation() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9".parse().unwrap(),
        );
        assert!(accepts_html(&headers));
    }

    #[test]
    fn accepts_html_rejects_json_only_clients() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, "application/json".parse().unwrap());
        assert!(!accepts_html(&headers));
    }
}
