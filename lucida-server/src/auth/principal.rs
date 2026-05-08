//! `PrincipalExtractor` trait + `StubPrincipalExtractor`.
//!
//! The trait is the OSS extension point (per ADR 0017): a self-hoster
//! adding a new auth provider implements this trait once and wires it
//! into the middleware. Saved-views, admin endpoints, and any future
//! per-user feature consume the resulting `AuthPrincipal` and never
//! see provider-specific details.
//!
//! Slice 1 (this slice) ships the stub only. The real
//! `GoogleJwtPrincipalExtractor` lands in a later slice.

use async_trait::async_trait;
use axum::http::{request::Parts, StatusCode};

use lucida_core::auth_principal::AuthPrincipal;

/// Failure modes from extracting a principal off an inbound request.
///
/// `Unauthenticated` is the common case (no session cookie, missing
/// header, expired session). `Internal` covers backend hiccups that
/// aren't the caller's fault. The middleware maps these to HTTP status
/// codes; handlers should never see this type directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    Unauthenticated,
    Internal(String),
}

impl AuthError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            AuthError::Unauthenticated => StatusCode::UNAUTHORIZED,
            AuthError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

/// Pull an `AuthPrincipal` off an inbound request.
///
/// Implementations read whatever they need from `Parts` (cookies for
/// the cookie+session production extractor; nothing for the stub) and
/// return either a principal or a structured error. The trait is
/// intentionally object-safe so the middleware can hold a
/// `Arc<dyn PrincipalExtractor>` and swap implementations at startup.
#[async_trait]
pub trait PrincipalExtractor: Send + Sync + 'static {
    async fn extract(&self, req: &Parts) -> Result<AuthPrincipal, AuthError>;
}

/// Dev-mode extractor that returns a fixed principal for every request.
///
/// Used when `LUCIDA_AUTH=disabled` (slice 4 wires the env var) and in
/// tests so handler logic can be exercised without minting real Google
/// JWTs. The principal is `dev@local` with `is_admin: true` so admin-only
/// endpoints are exercisable in dev without extra setup.
#[derive(Debug, Default, Clone, Copy)]
pub struct StubPrincipalExtractor;

impl StubPrincipalExtractor {
    pub fn new() -> Self {
        Self
    }

    /// The exact principal returned by every `extract` call. Public so
    /// tests can assert against it without pulling in the trait.
    pub fn principal() -> AuthPrincipal {
        AuthPrincipal {
            email: "dev@local".to_string(),
            display_name: "Local Dev".to_string(),
            picture_url: None,
            is_admin: true,
        }
    }
}

#[async_trait]
impl PrincipalExtractor for StubPrincipalExtractor {
    async fn extract(&self, _req: &Parts) -> Result<AuthPrincipal, AuthError> {
        Ok(Self::principal())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    #[tokio::test]
    async fn stub_returns_documented_principal() {
        let extractor = StubPrincipalExtractor::new();
        let req: Request<()> = Request::builder().uri("/").body(()).unwrap();
        let (parts, _) = req.into_parts();

        let principal = extractor.extract(&parts).await.expect("stub never fails");

        assert_eq!(principal.email, "dev@local");
        assert_eq!(principal.display_name, "Local Dev");
        assert_eq!(principal.picture_url, None);
        assert!(principal.is_admin);
    }

    #[test]
    fn stub_principal_helper_matches_extract() {
        let helper = StubPrincipalExtractor::principal();
        assert_eq!(helper.email, "dev@local");
        assert_eq!(helper.display_name, "Local Dev");
        assert_eq!(helper.picture_url, None);
        assert!(helper.is_admin);
    }

    #[test]
    fn auth_error_status_code_mapping() {
        assert_eq!(
            AuthError::Unauthenticated.status_code(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            AuthError::Internal("oops".into()).status_code(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
