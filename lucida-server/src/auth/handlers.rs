//! Auth HTTP handlers.
//!
//! Slice 2 (PRD #455) lands `/auth/whoami` (slice 1, kept) and
//! `/auth/dev/login` (new — dev-only convenience that mints a
//! `dev@local` session). The other endpoints documented in PRD #455
//! §"REST API contract" (`/auth/start`, `/auth/callback`,
//! `/auth/logout`, `/auth/error`) land in later slices.

use std::sync::Arc;

use axum::extract::State;
use axum::http::header::SET_COOKIE;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::Extension;
use chrono::{Duration as ChronoDuration, Utc};
use serde_json::json;
use tracing::info;

use lucida_core::auth_principal::AuthPrincipal;

use super::config::AuthConfig;
use super::cookie::{build_session_cookie, request_is_https};
use super::session_store::{LoginSession, LoginSessionStore};

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

/// State carried into the dev-login route so it can mint sessions and
/// set the cookie. Lives in a small struct (rather than re-exporting
/// the full `AppState`) so unit tests don't need to construct the rest
/// of the server's state graph.
#[derive(Clone)]
pub struct DevLoginState {
    pub config: Arc<AuthConfig>,
    pub store: Arc<dyn LoginSessionStore>,
}

/// `POST /auth/dev/login` — dev-only: mint a `dev@local` session and
/// set the cookie. Slice 2 gates this at the router level: it's only
/// mounted when `is_dev_mode()` is true (currently
/// `cfg!(debug_assertions)`). The handler itself is unconditional;
/// production builds simply don't expose the route, so requests hit
/// axum's default 404.
pub async fn dev_login<B>(
    State(state): State<DevLoginState>,
    req: Request<B>,
) -> Response {
    let (parts, _body) = req.into_parts();
    let now = Utc::now();
    let id = uuid::Uuid::new_v4().to_string();
    let session = LoginSession {
        id: id.clone(),
        email: "dev@local".to_string(),
        display_name: "Local Dev".to_string(),
        picture_url: None,
        created_at: now,
        last_used_at: now,
        expires_at: now
            + ChronoDuration::from_std(state.config.hard_cap)
                .unwrap_or(ChronoDuration::hours(720)),
    };

    if let Err(e) = state.store.create(session.clone()).await {
        tracing::error!(error = %e, "dev_login.create_session.failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "internal" })),
        )
            .into_response();
    }

    let cookie_header = build_session_cookie(&state.config, &id, request_is_https(&parts));
    info!(session_id = %id, "dev_login.minted");

    let principal = AuthPrincipal {
        email: session.email,
        display_name: session.display_name,
        picture_url: session.picture_url,
        is_admin: true,
    };

    (
        StatusCode::OK,
        [(SET_COOKIE, cookie_header)],
        Json(principal),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::middleware::{auth_middleware, SharedExtractor};
    use crate::auth::principal::SessionCookieExtractor;
    use crate::auth::session_store_memory::MemorySessionStore;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use axum::middleware::from_fn_with_state;
    use axum::routing::{get, post};
    use axum::Router;
    use tower::ServiceExt;

    fn dev_state() -> DevLoginState {
        DevLoginState {
            config: Arc::new(AuthConfig::for_tests()),
            store: Arc::new(MemorySessionStore::new()),
        }
    }

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

    #[tokio::test]
    async fn dev_login_creates_session_and_sets_cookie() {
        let state = dev_state();
        let app = Router::new()
            .route("/auth/dev/login", post(dev_login))
            .with_state(state.clone());

        let req = Request::builder()
            .method("POST")
            .uri("/auth/dev/login")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let set_cookie = res
            .headers()
            .get(SET_COOKIE)
            .expect("dev login must set the session cookie")
            .to_str()
            .unwrap()
            .to_string();
        assert!(set_cookie.contains("lucida_session="));
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("Path=/"));
        assert!(set_cookie.contains("SameSite=Lax"));

        // The store should now hold exactly one session.
        // We can't pull the in-memory store back out of `state` without
        // exposing it; instead, parse the cookie value and look it up
        // via the store handle still owned by the state.
        let body_bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let p: AuthPrincipal = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(p.email, "dev@local");
        assert!(p.is_admin);
    }

    /// Round-trip: hit the dev-login endpoint, capture the cookie, then
    /// hit /auth/whoami with that cookie and assert we get the dev
    /// principal back. This is the integration test the slice's
    /// acceptance criteria call out explicitly.
    #[tokio::test]
    async fn dev_login_then_whoami_returns_dev_principal() {
        let store: Arc<MemorySessionStore> = Arc::new(MemorySessionStore::new());
        let config = Arc::new(AuthConfig::for_tests());
        let dev = DevLoginState {
            config: Arc::clone(&config),
            store: Arc::clone(&store) as Arc<dyn LoginSessionStore>,
        };
        let extractor: SharedExtractor = Arc::new(SessionCookieExtractor::new(
            Arc::clone(&config),
            Arc::clone(&store) as Arc<dyn LoginSessionStore>,
        ));

        let app = Router::new()
            .route("/auth/whoami", get(whoami))
            .layer(from_fn_with_state(extractor, auth_middleware))
            .route("/auth/dev/login", post(dev_login).with_state(dev));

        // Step 1: mint via dev/login
        let mint_req = Request::builder()
            .method("POST")
            .uri("/auth/dev/login")
            .body(Body::empty())
            .unwrap();
        let mint_res = app.clone().oneshot(mint_req).await.unwrap();
        assert_eq!(mint_res.status(), StatusCode::OK);
        let cookie_header = mint_res
            .headers()
            .get(SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        // Strip attributes; only the name=value pair goes back as Cookie.
        let cookie_pair = cookie_header
            .split(';')
            .next()
            .unwrap()
            .to_string();

        // Step 2: hit /auth/whoami with the cookie
        let whoami_req = Request::builder()
            .uri("/auth/whoami")
            .header("cookie", cookie_pair)
            .body(Body::empty())
            .unwrap();
        let whoami_res = app.oneshot(whoami_req).await.unwrap();
        assert_eq!(whoami_res.status(), StatusCode::OK);
        let bytes = to_bytes(whoami_res.into_body(), 64 * 1024).await.unwrap();
        let p: AuthPrincipal = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(p.email, "dev@local");
        assert!(p.is_admin);
    }

    #[tokio::test]
    async fn whoami_returns_401_without_cookie_under_real_extractor() {
        let store: Arc<MemorySessionStore> = Arc::new(MemorySessionStore::new());
        let config = Arc::new(AuthConfig::for_tests());
        let extractor: SharedExtractor = Arc::new(SessionCookieExtractor::new(
            Arc::clone(&config),
            Arc::clone(&store) as Arc<dyn LoginSessionStore>,
        ));
        let app = Router::new()
            .route("/auth/whoami", get(whoami))
            .layer(from_fn_with_state(extractor, auth_middleware));
        let req = Request::builder()
            .uri("/auth/whoami")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
}
