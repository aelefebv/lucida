//! Axum middleware that runs the configured `PrincipalExtractor` on
//! every inbound request, attaches the resulting `AuthPrincipal` to
//! request extensions, and short-circuits with 401 when extraction
//! fails.
//!
//! ## 401 response shape
//!
//! Unauthenticated requests to HTML routes render the `UnauthLanding`
//! page (so the JS shim can capture `location.hash` for the OAuth
//! roundtrip): `200 + text/html` carrying the JS shim. API clients get
//! `401 + JSON`. The classification helper (`accepts_html`) is also
//! used by the integration test to assert correct branching without
//! standing up a real browser.
//!
//! ## Avoiding redirect loops
//!
//! `/auth/start`, `/auth/callback`, `/auth/whoami`, and `/auth/logout`
//! MUST NOT serve the unauth landing themselves — doing so would either
//! bounce the user back to `/auth/start` from `/auth/start` (infinite
//! loop) or hide the callback's session-mint from the browser. These
//! routes live on a separate router that the auth middleware never wraps.

use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::auth::config::{AuthConfig, AuthMode};
use crate::auth::cookie::read_signed_out_marker;
use crate::auth::principal::{
    AuthError, PrincipalExtractor, SessionCookieExtractor, StubPrincipalExtractor,
};
use crate::auth::session_store::LoginSessionStore;
use crate::auth::unauth_landing::{SIGNED_OUT_LANDING_HTML, UNAUTH_LANDING_HTML};

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

/// Build a 401 (or 5xx) response.
///
/// Branches HTML vs JSON on the request's `Accept` header. HTML
/// navigations get the unauth landing page (which JS-shims to
/// `/auth/start`) at `200 OK` so the page actually renders — a 401
/// with HTML body would still show the body, but keeping the success
/// status removes one source of confused browser devtools chatter for
/// the handoff page. API clients keep the bare JSON 401. `Internal`
/// errors stay bare-JSON for both shapes; an HTML page that says
/// "internal error" without context is worse than a 500 that the
/// browser renders as plain text.
///
/// On HTML routes the page also branches on the `lucida_signed_out`
/// marker cookie (set by `/auth/logout`). When present, the user just
/// explicitly logged out — serve the static `SIGNED_OUT_LANDING_HTML`
/// instead of the auto-bouncing landing, otherwise a refresh would
/// silently re-auth them through Google's still-active session and
/// defeat their intent.
///
/// On JSON routes (the SPA's `/auth/whoami` polling) we also surface
/// the marker as `"signedOut": true` in the 401 body. In dev, vite
/// serves `/` directly so the SPA never sees `SIGNED_OUT_LANDING_HTML`;
/// the JSON signal is what lets `UnauthLanding` render its static
/// "Signed out — Sign in again" card instead of auto-bouncing back
/// through Google. (HttpOnly cookie ⇒ JS can't read the marker
/// directly; this signal is the SPA's only window into it.)
fn unauthenticated_response(err: &AuthError, headers: &HeaderMap) -> Response {
    if matches!(err, AuthError::Unauthenticated) && accepts_html(headers) {
        let body = if read_signed_out_marker(headers) {
            SIGNED_OUT_LANDING_HTML
        } else {
            UNAUTH_LANDING_HTML
        };
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            Body::from(body),
        )
            .into_response();
    }

    let status = err.status_code();
    let code = match err {
        AuthError::Unauthenticated => "unauthenticated",
        AuthError::Internal(_) => "internal",
    };
    let detail = match err {
        AuthError::Unauthenticated => None,
        AuthError::Internal(msg) => Some(msg.as_str()),
    };
    let signed_out = matches!(err, AuthError::Unauthenticated) && read_signed_out_marker(headers);
    (
        status,
        Json(json!({ "error": code, "detail": detail, "signedOut": signed_out })),
    )
        .into_response()
}

/// Best-effort classification: does the client appear to want an HTML
/// page back? Wired through to the response branch and exposed for
/// callers (and as a smoke target for tests).
pub fn accepts_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|accept| accept.contains("text/html"))
        .unwrap_or(false)
}

/// Pick the active extractor for the configured `AuthMode`.
///
/// `Disabled` → [`StubPrincipalExtractor`]: every request resolves to
/// the selected local-dev principal, falling back to `dev@local`.
/// ADR-0018's loopback-default safety promise relies on this branch
/// existing — without it the cookie extractor would 401 every request
/// and the SPA would loop into a `/auth/start` that isn't registered.
///
/// `Google` → [`SessionCookieExtractor`]: read the `lucida_session`
/// cookie, look up the row, enforce idle + hard-cap, derive `is_admin`
/// from the configured allowlist. The OAuth callback handler mints
/// rows into the same store this extractor reads from.
///
/// The match is exhaustive so adding a new `AuthMode` variant later
/// will fail-compile here rather than silently falling through to the
/// wrong extractor.
pub fn build_extractor(
    config: Arc<AuthConfig>,
    store: Arc<dyn LoginSessionStore>,
) -> SharedExtractor {
    match config.mode {
        AuthMode::Disabled => Arc::new(StubPrincipalExtractor),
        AuthMode::Google => Arc::new(SessionCookieExtractor::new(config, store)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::extract::Request as ExtractRequest;
    use axum::http::{Request, StatusCode};
    use axum::middleware::from_fn_with_state;
    use axum::routing::get;
    use lucida_core::auth_principal::AuthPrincipal;
    use tower::ServiceExt;

    use crate::auth::principal::{AuthError, PrincipalExtractor};
    use crate::auth::session_store::LoginSession;
    use crate::auth::session_store_memory::MemorySessionStore;
    use async_trait::async_trait;
    use chrono::{Duration as ChronoDuration, Utc};

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

    /// Cookie-extractor wiring for the cookie-mode middleware tests.
    /// `build_extractor` with the test config now picks the stub (mode
    /// is `Disabled`), so cookie-path tests construct the cookie
    /// extractor directly to keep covering the cookie path.
    fn cookie_extractor(store: Arc<dyn LoginSessionStore>) -> SharedExtractor {
        Arc::new(SessionCookieExtractor::new(
            Arc::new(AuthConfig::for_tests()),
            store,
        ))
    }

    #[tokio::test]
    async fn middleware_attaches_principal_via_session_cookie() {
        let store = Arc::new(MemorySessionStore::new());
        let now = Utc::now();
        store
            .create(LoginSession {
                id: "s1".into(),
                email: "dev@local".into(),
                display_name: "Local Dev".into(),
                picture_url: None,
                created_at: now,
                last_used_at: now,
                expires_at: now + ChronoDuration::hours(24),
            })
            .await
            .unwrap();

        let extractor = cookie_extractor(store as Arc<dyn LoginSessionStore>);
        let app = router_with_extractor(extractor);

        let req = Request::builder()
            .uri("/echo")
            .header("cookie", "lucida_session=s1")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let p: AuthPrincipal = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(p.email, "dev@local");
    }

    #[tokio::test]
    async fn middleware_returns_401_when_no_cookie() {
        let store = Arc::new(MemorySessionStore::new());
        let extractor = cookie_extractor(store as Arc<dyn LoginSessionStore>);
        let app = router_with_extractor(extractor);

        let req = Request::builder().uri("/echo").body(Body::empty()).unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "unauthenticated");
        // No marker cookie present → signedOut: false. The SPA reads
        // this to decide between "render static signed-out card" and
        // "auto-bounce as cold visit / session expiry."
        assert_eq!(body["signedOut"], false);
    }

    /// SPA-facing companion to `middleware_returns_signed_out_landing_when_marker_cookie_present`:
    /// JSON 401 includes `signedOut: true` when the marker cookie is
    /// present, so the SPA can render its static signed-out card even
    /// in dev (where vite serves `/` and the static landing HTML never
    /// reaches the SPA).
    #[tokio::test]
    async fn middleware_returns_401_with_signed_out_true_when_marker_cookie_present() {
        let store = Arc::new(MemorySessionStore::new());
        let extractor = cookie_extractor(store as Arc<dyn LoginSessionStore>);
        let app = router_with_extractor(extractor);

        let req = Request::builder()
            .uri("/echo")
            .header(header::COOKIE, "lucida_signed_out=1")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "unauthenticated");
        assert_eq!(body["signedOut"], true);
    }

    /// Exercise the 5xx branch via a hand-rolled extractor that
    /// returns `Internal`. Keeps coverage on the not-the-caller's-fault
    /// path even though no production code path emits it today.
    struct AlwaysInternal;

    #[async_trait]
    impl PrincipalExtractor for AlwaysInternal {
        async fn extract(
            &self,
            _: &axum::http::request::Parts,
        ) -> Result<AuthPrincipal, AuthError> {
            Err(AuthError::Internal("simulated".into()))
        }
    }

    #[tokio::test]
    async fn middleware_surfaces_internal_errors_as_500() {
        let extractor: SharedExtractor = Arc::new(AlwaysInternal);
        let app = router_with_extractor(extractor);
        let req = Request::builder().uri("/echo").body(Body::empty()).unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// Disabled-mode wiring: `build_extractor` returns the stub, and
    /// the middleware attaches `dev@local` even with no cookie. Pins
    /// the regression where `build_extractor` always returned the
    /// cookie extractor regardless of `AuthMode`, 401ing every request.
    #[tokio::test]
    async fn build_extractor_disabled_mode_attaches_dev_principal_with_no_cookie() {
        let store = Arc::new(MemorySessionStore::new());
        // for_tests() = AuthMode::Disabled.
        let config = Arc::new(AuthConfig::for_tests());
        let extractor = build_extractor(config, store as Arc<dyn LoginSessionStore>);
        let app = router_with_extractor(extractor);

        let req = Request::builder().uri("/echo").body(Body::empty()).unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let p: AuthPrincipal = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(p.email, "dev@local");
        assert_eq!(p.display_name, "Local Dev");
        assert!(p.is_admin);
    }

    #[test]
    fn accepts_html_classifies_browser_navigation() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9"
                .parse()
                .unwrap(),
        );
        assert!(accepts_html(&headers));
    }

    #[test]
    fn accepts_html_rejects_json_only_clients() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, "application/json".parse().unwrap());
        assert!(!accepts_html(&headers));
    }

    /// HTML navigations get the unauth landing page back instead of
    /// the bare JSON 401 the API path uses.
    #[tokio::test]
    async fn middleware_returns_unauth_landing_html_to_browsers() {
        let store = Arc::new(MemorySessionStore::new());
        let extractor = cookie_extractor(store as Arc<dyn LoginSessionStore>);
        let app = router_with_extractor(extractor);

        let req = Request::builder()
            .uri("/echo")
            .header(header::ACCEPT, "text/html,application/xhtml+xml")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let ct = res
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(ct.starts_with("text/html"));

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body = std::str::from_utf8(&bytes).unwrap();
        assert!(
            body.contains("/auth/start"),
            "shim must point at /auth/start"
        );
        assert!(
            body.contains("encodeURIComponent"),
            "shim must url-encode hash + path",
        );
        // No marker cookie → must serve the auto-bouncing variant.
        assert!(
            body.contains("window.location.replace"),
            "no marker → auto-bounce landing",
        );
    }

    /// Marker cookie (set by `/auth/logout`) flips the landing to the
    /// static "Signed out" variant — no auto-bounce, click-required
    /// sign-in. Without this branch, refreshing after logout would
    /// silently re-auth via Google's still-active session.
    #[tokio::test]
    async fn middleware_returns_signed_out_landing_when_marker_cookie_present() {
        let store = Arc::new(MemorySessionStore::new());
        let extractor = cookie_extractor(store as Arc<dyn LoginSessionStore>);
        let app = router_with_extractor(extractor);

        let req = Request::builder()
            .uri("/echo")
            .header(header::ACCEPT, "text/html,application/xhtml+xml")
            .header(header::COOKIE, "lucida_signed_out=1")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body = std::str::from_utf8(&bytes).unwrap();
        // Static signed-out landing markers.
        assert!(body.contains("Signed out"));
        assert!(body.contains("Sign in again"));
        // Crucially: must NOT auto-bounce.
        assert!(
            !body.contains("window.location.replace"),
            "marker present → static landing, no auto-bounce",
        );
    }
}
