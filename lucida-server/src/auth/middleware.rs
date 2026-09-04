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
use axum::extract::{FromRef, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::auth::bearer_token::BearerTokenStore;
use crate::auth::config::{AuthConfig, AuthMode};
use crate::auth::cookie::read_signed_out_marker;
use crate::auth::directory::{self, ProfileDirectory};
use crate::auth::iap::{IapAssertionExtractor, IapError, IapVerifier};
use crate::auth::principal::{
    AuthError, BearerTokenExtractor, DualCredentialExtractor, PrincipalExtractor,
    StubPrincipalExtractor,
};
use crate::auth::session_store::LoginSessionStore;
use crate::auth::unauth_landing::{SIGNED_OUT_LANDING_HTML, UNAUTH_LANDING_HTML};

/// Shared handle to the active extractor. Wired into the router's
/// state so middleware closures can grab it without holding a
/// dedicated app-state field for every variant.
pub type SharedExtractor = Arc<dyn PrincipalExtractor>;

/// Everything the auth middleware needs: the mode's extractor, which
/// decides who a caller is, and the profile directory, which decides
/// only how they are shown and is absent unless configured.
///
/// Wire it with `from_fn_with_state(state, auth_middleware)`. A bare
/// [`SharedExtractor`] is accepted in the same position and means "no
/// directory", so every router that predates the directory is wired
/// exactly as it was.
#[derive(Clone)]
pub struct AuthMiddlewareState {
    pub extractor: SharedExtractor,
    pub directory: Option<Arc<ProfileDirectory>>,
}

impl AuthMiddlewareState {
    /// The production composition: the extractor for the configured
    /// mode, then the directory when `LUCIDA_DIRECTORY_URL` is set,
    /// loaded once. Fallible only for the reason
    /// [`build_extractor`] is; the directory never fails a boot.
    pub async fn build(
        config: Arc<AuthConfig>,
        store: Arc<dyn LoginSessionStore>,
        token_store: Arc<dyn BearerTokenStore>,
    ) -> Result<Self, IapError> {
        let extractor = build_extractor(Arc::clone(&config), store, token_store).await?;
        let directory = match config.directory.clone() {
            Some(directory_config) => directory::load_at_boot(directory_config).await,
            None => None,
        };
        Ok(Self {
            extractor,
            directory,
        })
    }
}

impl From<SharedExtractor> for AuthMiddlewareState {
    fn from(extractor: SharedExtractor) -> Self {
        Self {
            extractor,
            directory: None,
        }
    }
}

/// Lets `State<AuthMiddlewareState>` be extracted from a router whose
/// state is a bare `SharedExtractor`, which is how every test router
/// and every pre-directory caller is wired.
impl FromRef<SharedExtractor> for AuthMiddlewareState {
    fn from_ref(extractor: &SharedExtractor) -> Self {
        Self::from(Arc::clone(extractor))
    }
}

/// Axum middleware that runs the extractor, enriches the principal
/// from the profile directory when one is configured, and attaches the
/// result to request extensions for downstream handlers to read via
/// `req.extensions().get::<AuthPrincipal>()`.
///
/// The directory runs after extraction and before attachment, and
/// nowhere else: this is the single seam ADR-0062 names. It is given
/// the principal the mode resolved, so the email it keys on is one no
/// request header chose, and it may write the display name and the
/// picture and nothing more.
pub async fn auth_middleware(
    State(auth): State<AuthMiddlewareState>,
    req: Request,
    next: Next,
) -> Response {
    let (parts, body) = req.into_parts();
    let outcome = auth.extractor.extract(&parts).await;

    match outcome {
        Ok(mut principal) => {
            if let Some(directory) = &auth.directory {
                directory.apply(&mut principal);
            }
            let mut req = Request::from_parts(parts, body);
            req.extensions_mut().insert(principal);
            next.run(req).await
        }
        Err(err) => {
            let headers = parts.headers;
            unauthenticated_response(&err, &headers, auth.extractor.offers_sign_in())
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
/// A mode whose extractor answers no to
/// [`PrincipalExtractor::offers_sign_in`] gets the JSON 401 whatever it
/// asked for. The landing page's only move is to bounce to
/// `/auth/start`, and where no provider registered that route the
/// bounce lands on the SPA catch-all, which serves the app, which polls
/// whoami, which 401s, which bounces again. ADR-0018 records the last
/// time that loop shipped.
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
fn unauthenticated_response(
    err: &AuthError,
    headers: &HeaderMap,
    offers_sign_in: bool,
) -> Response {
    if matches!(err, AuthError::Unauthenticated) && accepts_html(headers) && offers_sign_in {
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
/// `Google` → [`SessionCookieExtractor`] behind the bearer path: read
/// the `lucida_session` cookie, look up the row, enforce idle +
/// hard-cap, derive `is_admin` from the configured allowlist. The OAuth
/// callback handler mints rows into the same store this extractor reads
/// from.
///
/// `Iap` → [`IapAssertionExtractor`] behind the bearer path: verify the
/// assertion the perimeter attached and read its `email` claim. Nothing
/// here mints a session, because nothing here ran a sign-in.
///
/// Fallible because IAP mode reads its key set before serving a single
/// request (ADR-0060), and a key set it cannot read is a server that
/// can never authenticate anybody. The other two modes cannot fail.
///
/// The match is exhaustive so adding a new `AuthMode` variant later
/// will fail-compile here rather than silently falling through to the
/// wrong extractor.
pub async fn build_extractor(
    config: Arc<AuthConfig>,
    store: Arc<dyn LoginSessionStore>,
    token_store: Arc<dyn BearerTokenStore>,
) -> Result<SharedExtractor, IapError> {
    Ok(match config.mode {
        AuthMode::Disabled => Arc::new(StubPrincipalExtractor),
        AuthMode::Google => Arc::new(DualCredentialExtractor::new(config, store, token_store)),
        AuthMode::Iap => {
            let iap_config = config
                .iap
                .clone()
                .expect("from_env guarantees an IAP block in IAP mode");
            let verifier = Arc::new(IapVerifier::new(Arc::new(iap_config)).await?);
            let assertion = IapAssertionExtractor::new(Arc::clone(&config), verifier);
            Arc::new(DualCredentialExtractor::with_fallback(
                Arc::new(assertion),
                BearerTokenExtractor::new(config, token_store),
            ))
        }
    })
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

    use crate::auth::bearer_token::{BearerToken, hash_bearer_token};
    use crate::auth::bearer_token_memory::MemoryBearerTokenStore;
    use crate::auth::iap::IAP_ASSERTION_HEADER;
    use crate::auth::iap::test_support::{TEST_AUDIENCE, TestKey, spawn_mock_key_set, test_claims};
    use crate::auth::principal::{AuthError, PrincipalExtractor, SessionCookieExtractor};
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
        let token_store = Arc::new(MemoryBearerTokenStore::new());
        // for_tests() = AuthMode::Disabled.
        let config = Arc::new(AuthConfig::for_tests());
        let extractor = build_extractor(
            config,
            store as Arc<dyn LoginSessionStore>,
            token_store as Arc<dyn BearerTokenStore>,
        )
        .await
        .expect("disabled mode cannot fail to build");
        let app = router_with_extractor(extractor);

        let req = Request::builder().uri("/echo").body(Body::empty()).unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let p: AuthPrincipal = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(p.email, "dev@local");
        assert_eq!(p.display_name, "Local Dev");
        assert!(
            !p.is_admin,
            "the principal the middleware attaches for free is not an admin",
        );
    }

    // -- IAP mode wiring --------------------------------------------------
    //
    // `build_extractor` is the only place that decides a mode gets the IAP
    // provider, so these run through it rather than building the extractor
    // directly.

    /// Config, stores, and a mock key set for an IAP-mode router.
    /// Returns the app and the signing key the test mints assertions
    /// with.
    async fn iap_app(admin_emails: &[&str], seeded_token: Option<&str>) -> (Router, TestKey) {
        let key = TestKey::generate("kid-1");
        let (base, _mock) = spawn_mock_key_set(key.jwks_json.clone()).await;
        let mut config = AuthConfig::for_tests_iap(TEST_AUDIENCE, &base);
        config.admin_emails = admin_emails.iter().map(|s| s.to_string()).collect();

        let store = Arc::new(MemorySessionStore::new());
        let token_store = Arc::new(MemoryBearerTokenStore::new());
        if let Some(raw) = seeded_token {
            let now = Utc::now();
            token_store
                .create(BearerToken {
                    id: "bearer-1".into(),
                    token_hash: hash_bearer_token(raw),
                    name: "laptop".into(),
                    email: "cli@example.com".into(),
                    display_name: "CLI User".into(),
                    picture_url: None,
                    created_at: now,
                    last_used_at: None,
                    expires_at: now + ChronoDuration::hours(1),
                    revoked_at: None,
                })
                .await
                .unwrap();
        }

        let extractor = build_extractor(
            Arc::new(config),
            store as Arc<dyn LoginSessionStore>,
            token_store as Arc<dyn BearerTokenStore>,
        )
        .await
        .expect("the mock key set primes");
        (router_with_extractor(extractor), key)
    }

    #[tokio::test]
    async fn build_extractor_iap_mode_attaches_the_principal_the_assertion_names() {
        let (app, key) = iap_app(&["admin@example.com"], None).await;

        let req = Request::builder()
            .uri("/echo")
            .header(
                IAP_ASSERTION_HEADER,
                key.sign(&test_claims("admin@example.com")),
            )
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let p: AuthPrincipal = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(p.email, "admin@example.com");
        assert!(
            p.is_admin,
            "admin rights still come from the configured list"
        );
    }

    #[tokio::test]
    async fn build_extractor_iap_mode_401s_a_request_carrying_no_credential() {
        let (app, _) = iap_app(&[], None).await;

        let req = Request::builder().uri("/echo").body(Body::empty()).unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn build_extractor_iap_mode_does_not_bounce_a_browser_into_a_sign_in_it_lacks() {
        let (app, _) = iap_app(&[], None).await;

        let req = Request::builder()
            .uri("/echo")
            .header(header::ACCEPT, "text/html,application/xhtml+xml")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let body = std::str::from_utf8(&bytes).unwrap();
        assert!(!body.contains("/auth/start"), "no bounce: {body}");
    }

    #[tokio::test]
    async fn build_extractor_iap_mode_resolves_a_bearer_token_ahead_of_the_assertion() {
        // The command-line client reaches lucida through IAP holding a
        // lucida token, so both credentials arrive together.
        let raw = "lucida_pat_through_iap";
        let (app, key) = iap_app(&[], Some(raw)).await;

        let req = Request::builder()
            .uri("/echo")
            .header("authorization", format!("Bearer {raw}"))
            .header(
                IAP_ASSERTION_HEADER,
                key.sign(&test_claims("alice@example.com")),
            )
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        let p: AuthPrincipal = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(p.email, "cli@example.com");
    }

    // -- Profile directory wiring ------------------------------------------
    //
    // These go through `AuthMiddlewareState::build` and the real
    // `/auth/whoami` handler, as main wires them, so they cover the
    // production path in every mode rather than `apply` alone.

    use crate::auth::config::DirectoryConfig;
    use crate::auth::dev::{build_dev_principal_cookie, normalize_dev_principal};
    use crate::auth::directory::test_support::{spawn_failing_listing, spawn_mock_listing};
    use crate::auth::handlers::whoami;
    use serde_json::{Value, json};

    /// The listing most of these serve: one person, spelled with a
    /// capital and a trailing space to prove the key is normalized, and
    /// carrying an administrator flag nothing should read.
    fn listing() -> Value {
        json!([{
            "email": "Alice@Example.com ",
            "name": "Alice Example",
            "picture": "https://pictures.example/alice.png",
            "is_admin": true,
        }])
    }

    fn whoami_router(state: AuthMiddlewareState) -> Router {
        Router::new()
            .route("/auth/whoami", get(whoami))
            .layer(from_fn_with_state(state, auth_middleware))
    }

    /// The production composition for a mode whose credential is not
    /// read from a store: IAP's assertion, or disabled mode's cookie.
    async fn state_over_empty_stores(config: Arc<AuthConfig>) -> AuthMiddlewareState {
        AuthMiddlewareState::build(
            config,
            Arc::new(MemorySessionStore::new()) as Arc<dyn LoginSessionStore>,
            Arc::new(MemoryBearerTokenStore::new()) as Arc<dyn BearerTokenStore>,
        )
        .await
        .expect("the state builds")
    }

    fn whoami_request(session: &str) -> Request<Body> {
        Request::builder()
            .uri("/auth/whoami")
            .header("cookie", format!("lucida_session={session}"))
            .body(Body::empty())
            .unwrap()
    }

    async fn body_of(app: Router, req: Request<Body>) -> (StatusCode, Vec<u8>) {
        let res = app.oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
        (status, bytes.to_vec())
    }

    async fn whoami_of(app: Router, req: Request<Body>) -> AuthPrincipal {
        let (status, bytes) = body_of(app, req).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Google-mode config with two sessions seeded: `alice`, whom the
    /// listing knows, with a name and picture of her own from sign-in, and
    /// `bob`, whom it does not.
    async fn google_state(
        directory: Option<DirectoryConfig>,
        admin_emails: &[&str],
    ) -> AuthMiddlewareState {
        let mut config = AuthConfig::for_tests();
        config.mode = AuthMode::Google;
        config.admin_emails = admin_emails.iter().map(|s| s.to_string()).collect();
        config.directory = directory;

        let store = Arc::new(MemorySessionStore::new());
        let now = Utc::now();
        for (id, email, name, picture) in [
            (
                "alice-session",
                "alice@example.com",
                "Alice From Sign-In",
                Some("https://sign-in.example/alice.png"),
            ),
            ("bob-session", "bob@example.com", "Bob From Sign-In", None),
        ] {
            store
                .create(LoginSession {
                    id: id.into(),
                    email: email.into(),
                    display_name: name.into(),
                    picture_url: picture.map(str::to_string),
                    created_at: now,
                    last_used_at: now,
                    expires_at: now + ChronoDuration::hours(24),
                })
                .await
                .unwrap();
        }
        let token_store = Arc::new(MemoryBearerTokenStore::new());
        AuthMiddlewareState::build(
            Arc::new(config),
            store as Arc<dyn LoginSessionStore>,
            token_store as Arc<dyn BearerTokenStore>,
        )
        .await
        .expect("google mode builds")
    }

    #[tokio::test]
    async fn whoami_with_the_directory_unset_is_byte_identical_to_the_bare_extractor() {
        let state = google_state(None, &[]).await;
        assert!(state.directory.is_none(), "unset means no directory at all");

        let bare = Router::new()
            .route("/auth/whoami", get(whoami))
            .layer(from_fn_with_state(
                Arc::clone(&state.extractor),
                auth_middleware,
            ));
        let (bare_status, bare_bytes) = body_of(bare, whoami_request("alice-session")).await;
        let (status, bytes) = body_of(whoami_router(state), whoami_request("alice-session")).await;
        assert_eq!(bare_status, StatusCode::OK);
        assert_eq!(status, bare_status);
        assert_eq!(bytes, bare_bytes);
        assert!(
            String::from_utf8_lossy(&bytes).contains("Alice From Sign-In"),
            "the name the mode resolved is what comes back",
        );
    }

    #[tokio::test]
    async fn an_email_in_the_listing_gets_the_listing_name_and_picture() {
        let (url, _mock) = spawn_mock_listing(listing()).await;
        let state = google_state(Some(DirectoryConfig::for_tests(&url)), &[]).await;

        let p = whoami_of(whoami_router(state), whoami_request("alice-session")).await;
        assert_eq!(
            p.email, "alice@example.com",
            "the mode's spelling, not the row's"
        );
        assert_eq!(p.display_name, "Alice Example");
        assert_eq!(
            p.picture_url.as_deref(),
            Some("https://pictures.example/alice.png")
        );
        assert!(!p.is_admin, "the row's flag is not consulted");
    }

    #[tokio::test]
    async fn an_email_not_in_the_listing_keeps_the_values_the_mode_resolved() {
        let (url, _mock) = spawn_mock_listing(listing()).await;
        let state = google_state(Some(DirectoryConfig::for_tests(&url)), &[]).await;

        let p = whoami_of(whoami_router(state), whoami_request("bob-session")).await;
        assert_eq!(p.email, "bob@example.com");
        assert_eq!(p.display_name, "Bob From Sign-In");
        assert!(p.picture_url.is_none());
    }

    #[tokio::test]
    async fn two_spellings_of_one_email_in_the_listing_are_one_row() {
        let (url, _mock) = spawn_mock_listing(json!([
            {"email": "ALICE@EXAMPLE.COM", "name": "Earlier Spelling"},
            {"email": "  alice@example.com", "name": "Later Spelling"},
        ]))
        .await;
        let state = google_state(Some(DirectoryConfig::for_tests(&url)), &[]).await;
        let directory = Arc::clone(state.directory.as_ref().expect("configured"));

        let p = whoami_of(whoami_router(state), whoami_request("alice-session")).await;
        assert_eq!(p.display_name, "Later Spelling");
        assert_eq!(
            directory.load().await.expect("the mock serves").rows,
            1,
            "one person, however spelled, is one row",
        );
    }

    /// The row names a different address under the key the auth
    /// modes use, and claims administrator rights. The principal keeps
    /// the email the mode resolved and the rights the configured list
    /// grants, and takes only the name.
    #[tokio::test]
    async fn a_row_that_disagrees_about_the_email_or_the_admin_flag_changes_neither() {
        let (url, _mock) = spawn_mock_listing(json!([
            {
                "address": "alice@example.com",
                "email": "mallory@example.com",
                "name": "Alice Example",
                "is_admin": true,
            },
            {
                "address": "bob@example.com",
                "email": "bob@example.com",
                "name": "Bob Example",
                "is_admin": false,
            },
        ]))
        .await;
        let mut directory = DirectoryConfig::for_tests(&url);
        directory.email_field = "address".into();
        let state = google_state(Some(directory), &["bob@example.com"]).await;
        let app = whoami_router(state);

        let alice = whoami_of(app.clone(), whoami_request("alice-session")).await;
        assert_eq!(alice.email, "alice@example.com");
        assert_eq!(alice.display_name, "Alice Example");
        assert!(!alice.is_admin, "a row cannot promote");

        let bob = whoami_of(app, whoami_request("bob-session")).await;
        assert_eq!(bob.email, "bob@example.com");
        assert_eq!(bob.display_name, "Bob Example");
        assert!(bob.is_admin, "a row cannot demote");
    }

    #[tokio::test]
    async fn a_name_built_from_two_fields_is_joined_by_one_space() {
        let (url, _mock) = spawn_mock_listing(json!([
            {"email": "alice@example.com", "first_name": "Alice", "last_name": "Example"},
        ]))
        .await;
        let mut directory = DirectoryConfig::for_tests(&url);
        directory.name_fields = vec!["first_name".into(), "last_name".into()];
        let state = google_state(Some(directory), &[]).await;

        let p = whoami_of(whoami_router(state), whoami_request("alice-session")).await;
        assert_eq!(p.display_name, "Alice Example");
    }

    #[tokio::test]
    async fn a_listing_that_fails_at_startup_leaves_the_server_serving_the_modes_values() {
        let (url, mock) = spawn_failing_listing(StatusCode::INTERNAL_SERVER_ERROR).await;
        let state = google_state(Some(DirectoryConfig::for_tests(&url)), &[]).await;
        assert!(
            state.directory.is_some(),
            "configured, loaded nothing, still there"
        );
        assert_eq!(mock.fetch_count().await, 1, "one load was attempted");

        let p = whoami_of(whoami_router(state), whoami_request("alice-session")).await;
        assert_eq!(p.display_name, "Alice From Sign-In");
        assert_eq!(
            p.picture_url.as_deref(),
            Some("https://sign-in.example/alice.png")
        );
    }

    /// IAP mode is where the directory matters most: the assertion
    /// carries only an email, so without a row the name is derived from
    /// the address and there is no picture.
    #[tokio::test]
    async fn iap_mode_takes_the_listing_name_and_picture_and_keeps_admin_from_config() {
        let key = TestKey::generate("kid-1");
        let (key_set_base, _key_set) = spawn_mock_key_set(key.jwks_json.clone()).await;
        let (url, _listing) = spawn_mock_listing(json!([
            {
                "email": "alice@example.com",
                "name": "Alice Example",
                "picture": "https://pictures.example/alice.png",
                "is_admin": false,
            },
        ]))
        .await;
        let mut config = AuthConfig::for_tests_iap(TEST_AUDIENCE, &key_set_base);
        config.admin_emails = ["alice@example.com".to_string()].into_iter().collect();
        config.directory = Some(DirectoryConfig::for_tests(&url));
        let app = whoami_router(state_over_empty_stores(Arc::new(config)).await);

        let assertion = |email: &str| {
            Request::builder()
                .uri("/auth/whoami")
                .header(IAP_ASSERTION_HEADER, key.sign(&test_claims(email)))
                .body(Body::empty())
                .unwrap()
        };
        let alice = whoami_of(app.clone(), assertion("alice@example.com")).await;
        assert_eq!(alice.email, "alice@example.com");
        assert_eq!(alice.display_name, "Alice Example");
        assert_eq!(
            alice.picture_url.as_deref(),
            Some("https://pictures.example/alice.png")
        );
        assert!(alice.is_admin, "rights come from the configured list");

        let carol = whoami_of(app, assertion("carol.example@example.com")).await;
        assert_eq!(carol.display_name, "Carol Example", "derived, as before");
        assert!(carol.picture_url.is_none());
    }

    #[tokio::test]
    async fn disabled_mode_leaves_the_dev_principal_unchanged_because_it_has_no_row() {
        let (url, _mock) = spawn_mock_listing(listing()).await;
        let mut config = AuthConfig::for_tests();
        config.directory = Some(DirectoryConfig::for_tests(&url));
        let state = state_over_empty_stores(Arc::new(config)).await;

        let req = Request::builder()
            .uri("/auth/whoami")
            .body(Body::empty())
            .unwrap();
        let p = whoami_of(whoami_router(state), req).await;
        assert_eq!(p.email, "dev@local");
        assert_eq!(p.display_name, "Local Dev");
        assert!(p.picture_url.is_none());
        assert!(!p.is_admin);
    }

    /// The directory is not tied to a mode. A dev principal switched to
    /// an address the listing knows is shown the way the listing says.
    #[tokio::test]
    async fn disabled_mode_applies_a_row_to_a_switched_dev_principal() {
        let (url, _mock) = spawn_mock_listing(listing()).await;
        let mut config = AuthConfig::for_tests();
        config.directory = Some(DirectoryConfig::for_tests(&url));
        let config = Arc::new(config);
        let state = state_over_empty_stores(Arc::clone(&config)).await;

        let switched =
            normalize_dev_principal("alice@example.com", Some("Alice Dev"), false).unwrap();
        let set_cookie = build_dev_principal_cookie(&config, &switched, false);
        let cookie = set_cookie.split(';').next().unwrap().to_string();
        let req = Request::builder()
            .uri("/auth/whoami")
            .header("cookie", cookie)
            .body(Body::empty())
            .unwrap();
        let p = whoami_of(whoami_router(state), req).await;
        assert_eq!(p.email, "alice@example.com");
        assert_eq!(p.display_name, "Alice Example");
        assert_eq!(
            p.picture_url.as_deref(),
            Some("https://pictures.example/alice.png")
        );
        assert!(!p.is_admin);
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
