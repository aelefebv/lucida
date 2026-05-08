//! `PrincipalExtractor` trait + the production `SessionCookieExtractor`.
//!
//! The trait is the OSS extension point (per ADR 0017): a self-hoster
//! adding a new auth provider implements this trait once and wires it
//! into the middleware. Saved-views, admin endpoints, and any future
//! per-user feature consume the resulting `AuthPrincipal` and never
//! see provider-specific details.
//!
//! Slice 2 (PRD #455) retires the slice-1 `StubPrincipalExtractor` and
//! lands the real cookie+session lookup. The stub is gone from the
//! crate surface; tests that need an authenticated principal mint a
//! row in a `MemorySessionStore` and exercise the same extractor that
//! production uses.

use std::sync::Arc;

use async_trait::async_trait;
use axum::http::{request::Parts, StatusCode};
use chrono::Utc;
use tracing::{debug, error};

use lucida_core::auth_principal::AuthPrincipal;

use super::config::AuthConfig;
use super::cookie::read_session_cookie;
use super::google_oauth::{GoogleOAuthClient, OAuthError, VerifiedClaims};
use super::session_store::{LoginSession, LoginSessionStore};

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
/// Implementations read whatever they need from `Parts` (the cookie
/// header for the production extractor) and return either a principal
/// or a structured error. The trait is intentionally object-safe so
/// the middleware can hold a `Arc<dyn PrincipalExtractor>` and swap
/// implementations at startup.
#[async_trait]
pub trait PrincipalExtractor: Send + Sync + 'static {
    async fn extract(&self, req: &Parts) -> Result<AuthPrincipal, AuthError>;
}

/// Production extractor: read the `lucida_session` cookie, look up the
/// session in the store, enforce idle-timeout + hard-cap, and bump
/// `last_used_at` in the background.
///
/// The bump is a fire-and-forget `tokio::spawn` so the request isn't
/// blocked on the write. Race-and-tolerate semantics: two parallel
/// requests overwriting each other's bump is fine because the value
/// only monotonically advances under normal use.
pub struct SessionCookieExtractor {
    config: Arc<AuthConfig>,
    store: Arc<dyn LoginSessionStore>,
}

impl SessionCookieExtractor {
    pub fn new(config: Arc<AuthConfig>, store: Arc<dyn LoginSessionStore>) -> Self {
        Self { config, store }
    }

    /// Decide whether a row is still valid given the current time.
    /// Two checks: idle-timeout (last_used_at + idle_timeout >= now)
    /// and hard-cap (expires_at >= now). Either failing kills the
    /// session. Pure function; tested independently.
    fn is_session_active(&self, row: &LoginSession, now: chrono::DateTime<Utc>) -> bool {
        if row.expires_at <= now {
            return false;
        }
        let idle_deadline = row.last_used_at
            + chrono::Duration::from_std(self.config.idle_timeout).unwrap_or(chrono::Duration::zero());
        idle_deadline > now
    }
}

#[async_trait]
impl PrincipalExtractor for SessionCookieExtractor {
    async fn extract(&self, req: &Parts) -> Result<AuthPrincipal, AuthError> {
        let session_id = read_session_cookie(req, &self.config.cookie_name)
            .ok_or(AuthError::Unauthenticated)?;

        let row = self
            .store
            .get(&session_id)
            .await
            .map_err(|e| {
                error!(error = %e, "session_store.get.failed");
                AuthError::Internal(e.to_string())
            })?
            .ok_or(AuthError::Unauthenticated)?;

        let now = Utc::now();
        if !self.is_session_active(&row, now) {
            // Either idle-expired or hard-capped. Either way, treat as
            // unauthenticated. Sweep (slice 8) will eventually drop the
            // row; we don't bother deleting here to keep the extract
            // path read-only.
            debug!(
                session_id = %row.id,
                "session_extractor.expired",
            );
            return Err(AuthError::Unauthenticated);
        }

        // Race-and-tolerate touch. Spawn a task so the response isn't
        // blocked on the SQLite write. We don't await; the work runs
        // even if the request handler returns first.
        let store = Arc::clone(&self.store);
        let id = row.id.clone();
        tokio::spawn(async move {
            if let Err(e) = store.touch_last_used(&id, now).await {
                debug!(session_id = %id, error = %e, "session_extractor.touch.failed");
            }
        });

        Ok(AuthPrincipal {
            email: row.email,
            display_name: row.display_name,
            picture_url: row.picture_url,
            // Slice 2 doesn't have admin roles wired yet — the dev
            // endpoint mints sessions with is_admin: true so existing
            // admin endpoints keep working in dev. Real role plumbing
            // lands in a later slice (out of scope here).
            is_admin: true,
        })
    }
}

/// Convert a Google ID-token's verified claims into the
/// `AuthPrincipal` we persist on the new `LoginSession` row at
/// callback time. Slice 4 deliberately accepts any verified email so
/// the end-to-end flow works against the mock harness; slice 5 layers
/// hosted-domain + email_verified rejection on top.
///
/// `display_name` falls back to the local part of the email when
/// Google's `name` claim is absent (rare, but happens for accounts
/// without a populated profile). `is_admin` is `false` until
/// `LUCIDA_ADMIN_EMAILS` plumbing arrives in a later slice.
pub fn principal_from_claims(claims: &VerifiedClaims) -> AuthPrincipal {
    let display_name = claims.name.clone().unwrap_or_else(|| {
        claims
            .email
            .split('@')
            .next()
            .unwrap_or(&claims.email)
            .to_string()
    });
    AuthPrincipal {
        email: claims.email.clone(),
        display_name,
        picture_url: claims.picture.clone(),
        is_admin: false,
    }
}

/// `PrincipalExtractor` adapter that runs Google's JWT validator on a
/// `Bearer` token in the `Authorization` header.
///
/// Slice 4 wires this as the authoritative extractor when
/// `LUCIDA_AUTH=google`; in practice production relies on the session
/// cookie path because the callback handler mints a `LoginSession` row
/// out of the validated claims, so per-request JWT extraction is
/// optional. Keeping the adapter around lets slice 5+ wire in
/// integrations that bypass the cookie (CLI, server-to-server) without
/// re-implementing JWT validation in two places.
pub struct GoogleJwtPrincipalExtractor {
    google: Arc<GoogleOAuthClient>,
}

impl GoogleJwtPrincipalExtractor {
    pub fn new(google: Arc<GoogleOAuthClient>) -> Self {
        Self { google }
    }

    /// Validate `id_token` and convert it to an `AuthPrincipal`. Used
    /// directly by `/auth/callback` — the handler doesn't go through the
    /// `PrincipalExtractor` trait because it's holding the token in
    /// hand from the code-exchange step.
    pub async fn principal_from_id_token(
        &self,
        id_token: &str,
    ) -> Result<AuthPrincipal, OAuthError> {
        let claims = self.google.validate_id_token(id_token).await?;
        Ok(principal_from_claims(&claims))
    }
}

#[async_trait]
impl PrincipalExtractor for GoogleJwtPrincipalExtractor {
    async fn extract(&self, req: &Parts) -> Result<AuthPrincipal, AuthError> {
        let header = req
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AuthError::Unauthenticated)?;
        let token = header
            .strip_prefix("Bearer ")
            .ok_or(AuthError::Unauthenticated)?;

        match self.google.validate_id_token(token).await {
            Ok(claims) => Ok(principal_from_claims(&claims)),
            Err(OAuthError::JwtInvalid(msg)) => {
                debug!(error = %msg, "google_extractor.jwt_invalid");
                Err(AuthError::Unauthenticated)
            }
            Err(other) => {
                error!(error = %other, "google_extractor.internal");
                Err(AuthError::Internal(other.to_string()))
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod test_helpers {
    //! Test scaffolding shared between `principal::tests` and the
    //! middleware tests next door. Keeps boilerplate from drifting
    //! between callers.

    use super::*;
    use crate::auth::session_store::LoginSession;
    use crate::auth::session_store_memory::MemorySessionStore;
    use chrono::Duration as ChronoDuration;

    pub fn make_extractor_with(
        store: Arc<MemorySessionStore>,
    ) -> SessionCookieExtractor {
        SessionCookieExtractor::new(
            Arc::new(AuthConfig::for_tests()),
            store as Arc<dyn LoginSessionStore>,
        )
    }

    pub fn fresh_session(id: &str) -> LoginSession {
        let now = Utc::now();
        LoginSession {
            id: id.to_string(),
            email: "dev@local".to_string(),
            display_name: "Local Dev".to_string(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + ChronoDuration::hours(24),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_helpers::*;
    use super::*;
    use crate::auth::session_store_memory::MemorySessionStore;
    use axum::http::Request;
    use chrono::Duration as ChronoDuration;

    fn parts_with_cookie(value: Option<&str>) -> Parts {
        let mut builder = Request::builder().uri("http://localhost/");
        if let Some(v) = value {
            builder = builder.header("cookie", format!("lucida_session={v}"));
        }
        builder.body(()).unwrap().into_parts().0
    }

    #[tokio::test]
    async fn missing_cookie_yields_unauthenticated() {
        let store = Arc::new(MemorySessionStore::new());
        let ext = make_extractor_with(store);
        let parts = parts_with_cookie(None);
        assert_eq!(ext.extract(&parts).await.unwrap_err(), AuthError::Unauthenticated);
    }

    #[tokio::test]
    async fn unknown_cookie_yields_unauthenticated() {
        let store = Arc::new(MemorySessionStore::new());
        let ext = make_extractor_with(store);
        let parts = parts_with_cookie(Some("does-not-exist"));
        assert_eq!(ext.extract(&parts).await.unwrap_err(), AuthError::Unauthenticated);
    }

    #[tokio::test]
    async fn known_cookie_returns_principal() {
        let store = Arc::new(MemorySessionStore::new());
        let s = fresh_session("good-id");
        store.create(s.clone()).await.unwrap();

        let ext = make_extractor_with(Arc::clone(&store));
        let parts = parts_with_cookie(Some("good-id"));
        let p = ext.extract(&parts).await.unwrap();
        assert_eq!(p.email, "dev@local");
        assert_eq!(p.display_name, "Local Dev");
    }

    #[tokio::test]
    async fn idle_expired_yields_unauthenticated() {
        let store = Arc::new(MemorySessionStore::new());
        let mut s = fresh_session("stale");
        // Set last_used_at to 8 days ago: idle timeout default is 7d.
        s.last_used_at = Utc::now() - ChronoDuration::hours(8 * 24);
        store.create(s).await.unwrap();

        let ext = make_extractor_with(Arc::clone(&store));
        let parts = parts_with_cookie(Some("stale"));
        assert_eq!(ext.extract(&parts).await.unwrap_err(), AuthError::Unauthenticated);
    }

    #[tokio::test]
    async fn hard_capped_yields_unauthenticated_even_when_idle_ok() {
        let store = Arc::new(MemorySessionStore::new());
        let now = Utc::now();
        let s = LoginSession {
            id: "capped".to_string(),
            email: "dev@local".to_string(),
            display_name: "Local Dev".to_string(),
            picture_url: None,
            created_at: now - ChronoDuration::hours(31 * 24),
            // Idle timeout would not have fired (touched 1h ago)…
            last_used_at: now - ChronoDuration::hours(1),
            // …but the hard cap was 1h ago.
            expires_at: now - ChronoDuration::hours(1),
        };
        store.create(s).await.unwrap();

        let ext = make_extractor_with(Arc::clone(&store));
        let parts = parts_with_cookie(Some("capped"));
        assert_eq!(ext.extract(&parts).await.unwrap_err(), AuthError::Unauthenticated);
    }

    #[tokio::test]
    async fn successful_extract_bumps_last_used_in_background() {
        let store = Arc::new(MemorySessionStore::new());
        let s = fresh_session("bump-me");
        let original = s.last_used_at;
        store.create(s).await.unwrap();

        let ext = make_extractor_with(Arc::clone(&store));
        let parts = parts_with_cookie(Some("bump-me"));
        let _ = ext.extract(&parts).await.unwrap();

        // Yield enough times for the spawned task to run. tokio's
        // multi-thread runtime in tests usually picks it up immediately,
        // but a tiny sleep is the deterministic version.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        let row = store.get("bump-me").await.unwrap().unwrap();
        assert!(row.last_used_at > original, "last_used_at should advance");
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

    // -- principal_from_claims (slice 4) ---------------------------------

    #[test]
    fn principal_from_claims_uses_name_when_present() {
        let claims = VerifiedClaims {
            email: "alice@example.com".into(),
            email_verified: true,
            name: Some("Alice Example".into()),
            picture: Some("https://example.com/a.png".into()),
            hd: None,
        };
        let p = principal_from_claims(&claims);
        assert_eq!(p.email, "alice@example.com");
        assert_eq!(p.display_name, "Alice Example");
        assert_eq!(p.picture_url.as_deref(), Some("https://example.com/a.png"));
        assert!(!p.is_admin, "is_admin defaults false; admin plumbing later");
    }

    #[test]
    fn principal_from_claims_falls_back_to_email_local_part() {
        let claims = VerifiedClaims {
            email: "noname@example.com".into(),
            email_verified: true,
            name: None,
            picture: None,
            hd: None,
        };
        let p = principal_from_claims(&claims);
        assert_eq!(p.display_name, "noname");
    }
}
