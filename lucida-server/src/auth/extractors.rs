//! Axum extractors for auth-gated handlers.
//!
//! Slice 6 (PRD #455 §"Permission model" + §"Admin role bootstrap").
//! [`AdminRequired`] reads the [`AuthPrincipal`] the auth middleware
//! attached to request extensions and short-circuits with 403 if the
//! principal is not an admin. Handlers that need admin-only access
//! declare `AdminRequired(principal): AdminRequired` in their signature
//! and don't repeat the check.
//!
//! The check is purely on `principal.is_admin`; the bool itself is
//! derived per-request inside the principal extractor (slice 6 wires
//! `LUCIDA_ADMIN_EMAILS` in `auth/principal.rs`). Keeping the extractor
//! ignorant of how `is_admin` was computed means future changes — e.g.
//! a database-backed role table — don't ripple here.
//!
//! 403 shape: JSON `{"error":"forbidden"}` (PRD did not specify; the
//! parent agent picked this for parity with the middleware's
//! `{"error":"unauthenticated"}` shape).

use axum::Json;
use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use lucida_core::auth_principal::AuthPrincipal;

/// Wrapper extractor that yields the request's [`AuthPrincipal`] only
/// when `is_admin` is true. Otherwise returns 403 + JSON
/// `{"error":"forbidden"}`. If the auth middleware never ran (no
/// principal in extensions), returns 500 — that's a wiring bug, not a
/// permission failure, and surfacing it as 403 would mask the misroute.
pub struct AdminRequired(pub AuthPrincipal);

impl<S> FromRequestParts<S> for AdminRequired
where
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let principal = parts
            .extensions
            .get::<AuthPrincipal>()
            .cloned()
            .ok_or_else(|| {
                // No principal attached = auth middleware was bypassed
                // for this route. That's a server-side wiring bug; emit
                // a structured log and return 500 so it's loud rather
                // than silently 403'd.
                tracing::error!("admin_required.no_principal_in_extensions");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "internal" })),
                )
                    .into_response()
            })?;

        if !principal.is_admin {
            tracing::warn!(email = %principal.email, "admin_required.forbidden");
            return Err(
                (StatusCode::FORBIDDEN, Json(json!({ "error": "forbidden" }))).into_response(),
            );
        }

        Ok(AdminRequired(principal))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use tower::ServiceExt;

    /// Handler that simply confirms it ran (and the extractor admitted
    /// the request). Returns the principal email so the test can assert
    /// the principal flowed through.
    async fn admin_only(AdminRequired(p): AdminRequired) -> String {
        p.email
    }

    fn admin_app() -> Router {
        Router::new().route("/admin/ping", get(admin_only))
    }

    /// Inject an `AuthPrincipal` into extensions before the route runs.
    /// In production the auth middleware does this; the test fakes it
    /// with a small adapter middleware so the extractor sees the same
    /// shape it would in `main.rs`.
    fn with_principal(p: AuthPrincipal) -> Router {
        let p = std::sync::Arc::new(p);
        admin_app().layer(axum::middleware::from_fn(
            move |mut req: Request<Body>, next: axum::middleware::Next| {
                let p = p.clone();
                async move {
                    req.extensions_mut().insert(AuthPrincipal::clone(&*p));
                    next.run(req).await
                }
            },
        ))
    }

    fn principal(email: &str, is_admin: bool) -> AuthPrincipal {
        AuthPrincipal {
            email: email.into(),
            display_name: email.into(),
            picture_url: None,
            is_admin,
        }
    }

    #[tokio::test]
    async fn admin_required_succeeds_for_admin() {
        let app = with_principal(principal("austin@calicolabs.com", true));
        let req = Request::builder()
            .uri("/admin/ping")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        assert_eq!(&bytes[..], b"austin@calicolabs.com");
    }

    #[tokio::test]
    async fn admin_required_forbids_non_admin() {
        let app = with_principal(principal("alice@calicolabs.com", false));
        let req = Request::builder()
            .uri("/admin/ping")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "forbidden");
    }

    #[tokio::test]
    async fn admin_required_500s_when_no_principal_attached() {
        // No middleware = no principal in extensions = wiring bug. We
        // surface 500 so the misroute is loud, not silently 403'd.
        let app = admin_app();
        let req = Request::builder()
            .uri("/admin/ping")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
