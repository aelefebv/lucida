//! Per-browser anonymous sessions for disabled auth on a shared server.
//!
//! Disabled mode has no sign-in, so without these every browser on a
//! server other machines can reach would be the one shared `dev@local`. A
//! browser that loads the app with no live session gets one minted here: a
//! row in the session store behind the ordinary opaque session cookie,
//! naming a fresh `anon-…@local` principal with a generated name and
//! avatar color. A browser can present only a session the server minted,
//! so it never picks who it is. Clearing cookies makes a new person: this
//! tells people apart and secures nothing.
//!
//! A loopback bind has one person at it, who drives the CLI and the
//! browser alike. There every caller stays `dev@local`, so a workspace the
//! CLI made opens in the browser, and the dev switcher is how a developer
//! becomes someone else.
//!
//! Only a page load mints. The command-line and Python clients never load
//! the page and stay `dev@local`, and so does the capture surface the CLI
//! drives, which acts as the CLI that opened it.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::header::{AUTHORIZATION, SET_COOKIE};
use axum::http::request::Parts;
use axum::http::{HeaderValue, Method};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use tracing::{error, info};

use super::config::{AuthConfig, AuthMode};
use super::cookie::{build_session_cookie, request_is_https};
use super::handlers::random_state_token;
use super::middleware::accepts_html;
use super::principal::{AuthError, PrincipalExtractor, SessionCookieExtractor};
use super::session_store::{LoginSession, LoginSessionStore};

/// What every anonymous session id starts with, and no signed-in one
/// does. [`SessionCookieExtractor`] tells the two kinds apart by it.
const ANONYMOUS_SESSION_PREFIX: &str = "anon_";

pub fn is_anonymous_session_id(id: &str) -> bool {
    id.starts_with(ANONYMOUS_SESSION_PREFIX)
}

/// Whether browsers get anonymous sessions: disabled auth on a bind other
/// machines can reach. Never where [`super::dev::dev_switcher_enabled`]
/// holds.
pub fn anonymous_sessions_enabled(config: &AuthConfig) -> bool {
    config.mode == AuthMode::Disabled && !config.bind_is_loopback()
}

/// `router` with anonymous sessions minted on page loads, where
/// [`anonymous_sessions_enabled`] holds. Elsewhere `router` comes back
/// unchanged.
pub fn with_anonymous_sessions(
    router: Router,
    config: Arc<AuthConfig>,
    store: Arc<dyn LoginSessionStore>,
) -> Router {
    if !anonymous_sessions_enabled(&config) {
        return router;
    }
    let sessions = AnonymousSessions {
        live: Arc::new(SessionCookieExtractor::anonymous(
            Arc::clone(&config),
            Arc::clone(&store),
        )),
        config,
        store,
    };
    router.layer(from_fn_with_state(sessions, mint_on_page_load))
}

#[derive(Clone)]
struct AnonymousSessions {
    config: Arc<AuthConfig>,
    store: Arc<dyn LoginSessionStore>,
    /// Answers whether the browser already holds a live session.
    live: Arc<SessionCookieExtractor>,
}

async fn mint_on_page_load(
    State(sessions): State<AnonymousSessions>,
    req: Request,
    next: Next,
) -> Response {
    let (parts, body) = req.into_parts();
    let cookie = if is_page_load(&parts) {
        sessions.mint_unless_live(&parts).await
    } else {
        None
    };
    let mut response = next.run(Request::from_parts(parts, body)).await;
    if let Some(value) = cookie.and_then(|c| HeaderValue::from_str(&c).ok()) {
        response.headers_mut().append(SET_COOKIE, value);
    }
    response
}

/// A browser loading the app. A request carrying a credential of its own
/// is some other client, and the capture surface (`?render=1`, as the web
/// client reads it) acts for the CLI that opened it, so neither gets a
/// session here.
fn is_page_load(parts: &Parts) -> bool {
    parts.method == Method::GET
        && accepts_html(&parts.headers)
        && !parts.headers.contains_key(AUTHORIZATION)
        && !parts
            .uri
            .query()
            .is_some_and(|query| query.split('&').any(|pair| pair == "render=1"))
}

impl AnonymousSessions {
    /// The `Set-Cookie` value for a freshly minted session, or `None` when
    /// the browser already holds a live one. A cookie that names no live
    /// anonymous session, forged or expired, is replaced.
    async fn mint_unless_live(&self, parts: &Parts) -> Option<String> {
        match self.live.extract(parts).await {
            Ok(_) => return None,
            // The store is failing, and a write would fail with it. The
            // page still loads, as `dev@local`.
            Err(AuthError::Internal(_)) => return None,
            Err(AuthError::Unauthenticated) => {}
        }
        let session = new_session(&self.config, rand::random(), Utc::now());
        if let Err(e) = self.store.create(session.clone()).await {
            error!(error = %e, "auth.anonymous.session_create_failed");
            return None;
        }
        info!(email = %session.email, "auth.anonymous.session_minted");
        Some(build_session_cookie(
            &self.config,
            &session.id,
            request_is_https(parts),
        ))
    }
}

/// A session that expires as a signed-in one does: idle timeout and hard
/// cap. `seed` picks the principal, and nothing about it is in the id.
fn new_session(config: &AuthConfig, seed: [u8; 6], now: DateTime<Utc>) -> LoginSession {
    let identity = AnonymousIdentity::from_seed(seed);
    LoginSession {
        id: format!("{ANONYMOUS_SESSION_PREFIX}{}", random_state_token()),
        email: identity.email,
        display_name: identity.display_name,
        picture_url: Some(identity.picture_url),
        created_at: now,
        last_used_at: now,
        expires_at: now
            + ChronoDuration::from_std(config.hard_cap).unwrap_or(ChronoDuration::hours(720)),
    }
}

/// Avatar fills, and the color word each puts in a display name. White
/// initials read on every one at a contrast above 5:1.
const COLORS: [(&str, &str); 11] = [
    ("Crimson", "#b4233c"),
    ("Rust", "#b4441b"),
    ("Bronze", "#9a5b00"),
    ("Olive", "#5f6f00"),
    ("Jade", "#047857"),
    ("Teal", "#0f766e"),
    ("Azure", "#1d5fbf"),
    ("Indigo", "#4338ca"),
    ("Violet", "#7e22ce"),
    ("Magenta", "#a21caf"),
    ("Slate", "#475569"),
];

const NOUNS: [&str; 16] = [
    "Anchor", "Beacon", "Bridge", "Canyon", "Compass", "Ember", "Harbor", "Kite", "Lantern",
    "Marble", "Pebble", "Quill", "Ribbon", "Sail", "Summit", "Whistle",
];

/// Who an anonymous session names: a unique address, and a name and
/// avatar color that follow from it, so one person looks the same
/// everywhere they appear.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AnonymousIdentity {
    email: String,
    display_name: String,
    /// An SVG avatar inline as a `data:` URL, which is what carries the
    /// color to every place a principal's picture is shown.
    picture_url: String,
}

impl AnonymousIdentity {
    fn from_seed(seed: [u8; 6]) -> Self {
        let local: String = seed.iter().map(|b| format!("{b:02x}")).collect();
        let (color, fill) = COLORS[usize::from(seed[0]) % COLORS.len()];
        let noun = NOUNS[usize::from(seed[1]) % NOUNS.len()];
        let initials = format!("{}{}", &color[..1], &noun[..1]);
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="{fill}"/><text x="32" y="32" dominant-baseline="central" text-anchor="middle" font-family="system-ui,sans-serif" font-size="26" font-weight="600" fill="#ffffff">{initials}</text></svg>"##
        );
        Self {
            email: format!("anon-{local}@local"),
            display_name: format!("{color} {noun}"),
            picture_url: format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::bearer_token::BearerTokenStore;
    use crate::auth::bearer_token_memory::MemoryBearerTokenStore;
    use crate::auth::config::SecureCookieMode;
    use crate::auth::dev::{build_dev_principal_cookie, normalize_dev_principal};
    use crate::auth::handlers::whoami;
    use crate::auth::middleware::{auth_middleware, build_extractor};
    use crate::auth::principal::StubPrincipalExtractor;
    use crate::auth::session_store_memory::MemorySessionStore;
    use axum::body::{Body, to_bytes};
    use axum::http::{StatusCode, header};
    use axum::routing::get;
    use lucida_core::auth_principal::AuthPrincipal;
    use tower::ServiceExt;

    const PAGE_ACCEPT: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    /// Disabled auth on a bind other machines reach, as the
    /// `LUCIDA_INSECURE=1` deployment runs it.
    fn shared() -> AuthConfig {
        let mut config = AuthConfig::for_tests();
        config.bind_addr = "0.0.0.0:9876".parse().unwrap();
        config.insecure_acknowledged = true;
        config
    }

    /// Disabled auth on loopback, the zero-config local run.
    fn loopback() -> AuthConfig {
        AuthConfig::for_tests()
    }

    /// The app as `main` composes it in disabled mode: `/auth/whoami`
    /// behind the auth middleware, and a page fallback wrapped in
    /// [`with_anonymous_sessions`], over one session store.
    async fn app(config: AuthConfig, store: Arc<MemorySessionStore>) -> Router {
        let config = Arc::new(config);
        let store = store as Arc<dyn LoginSessionStore>;
        let extractor = build_extractor(
            Arc::clone(&config),
            Arc::clone(&store),
            Arc::new(MemoryBearerTokenStore::new()) as Arc<dyn BearerTokenStore>,
        )
        .await
        .expect("disabled mode builds");
        let authed = Router::new()
            .route("/auth/whoami", get(whoami))
            .layer(from_fn_with_state(extractor, auth_middleware));
        let pages = Router::new().fallback(|| async { "<html>lucida</html>" });
        authed.merge(with_anonymous_sessions(pages, config, store))
    }

    fn page_load(path: &str, cookie: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .uri(path)
            .header(header::ACCEPT, PAGE_ACCEPT);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        builder.body(Body::empty()).unwrap()
    }

    /// The `Set-Cookie` values on `response` that write the session cookie.
    fn session_cookies(response: &Response) -> Vec<String> {
        response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter(|v| v.starts_with("lucida_session="))
            .map(str::to_string)
            .collect()
    }

    /// Load a page with `cookie`, and return the `name=value` pair of the
    /// session cookie it set, if any.
    async fn load(app: &Router, path: &str, cookie: Option<&str>) -> Option<String> {
        let response = app.clone().oneshot(page_load(path, cookie)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let set = session_cookies(&response);
        assert!(set.len() <= 1, "one session cookie at most: {set:?}");
        set.first()
            .map(|c| c.split(';').next().unwrap().to_string())
    }

    async fn whoami_with(app: &Router, cookie: Option<&str>) -> AuthPrincipal {
        let mut builder = Request::builder().uri("/auth/whoami");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn two_browsers_loading_the_app_are_two_people() {
        let app = app(shared(), Arc::new(MemorySessionStore::new())).await;

        let first = load(&app, "/", None).await.expect("a first visit mints");
        let second = load(&app, "/open?url=/data/a.zarr", None)
            .await
            .expect("so does another browser's");
        assert_ne!(first, second);

        let a = whoami_with(&app, Some(&first)).await;
        let b = whoami_with(&app, Some(&second)).await;
        assert_ne!(a.email, b.email);
        for person in [&a, &b] {
            assert!(
                person.email.starts_with("anon-") && person.email.ends_with("@local"),
                "{person:?}"
            );
            assert!(
                person
                    .picture_url
                    .as_deref()
                    .is_some_and(|url| url.starts_with("data:image/svg+xml;base64,")),
                "{person:?}"
            );
            assert!(!person.is_admin);
        }
    }

    #[tokio::test]
    async fn a_browser_keeps_its_session_across_page_loads() {
        let app = app(shared(), Arc::new(MemorySessionStore::new())).await;
        let cookie = load(&app, "/", None).await.unwrap();
        let before = whoami_with(&app, Some(&cookie)).await;

        assert_eq!(load(&app, "/w/some-workspace", Some(&cookie)).await, None);
        assert_eq!(whoami_with(&app, Some(&cookie)).await, before);
    }

    #[tokio::test]
    async fn the_session_cookie_is_http_only_secure_and_lasts_the_hard_cap() {
        let app = app(shared(), Arc::new(MemorySessionStore::new())).await;
        let response = app.oneshot(page_load("/", None)).await.unwrap();
        let cookie = session_cookies(&response).pop().unwrap();
        assert!(cookie.contains("HttpOnly"), "{cookie}");
        assert!(cookie.contains("SameSite=Lax"), "{cookie}");
        assert!(cookie.contains("Path=/"), "{cookie}");
        assert!(cookie.contains("Max-Age=2592000"), "{cookie}");
        assert!(cookie.contains("Secure"), "off loopback: {cookie}");

        let mut config = shared();
        config.secure_mode = SecureCookieMode::Never;
        let app = self::app(config, Arc::new(MemorySessionStore::new())).await;
        let response = app.oneshot(page_load("/", None)).await.unwrap();
        let cookie = session_cookies(&response).pop().unwrap();
        assert!(!cookie.contains("Secure"), "{cookie}");
    }

    #[tokio::test]
    async fn only_a_page_load_mints() {
        let store = Arc::new(MemorySessionStore::new());
        let app = app(shared(), Arc::clone(&store)).await;

        let fetch = Request::builder()
            .uri("/assets/index.js")
            .header(header::ACCEPT, "*/*")
            .body(Body::empty())
            .unwrap();
        let post = Request::builder()
            .method(Method::POST)
            .uri("/")
            .header(header::ACCEPT, PAGE_ACCEPT)
            .body(Body::empty())
            .unwrap();
        let with_token = Request::builder()
            .uri("/")
            .header(header::ACCEPT, PAGE_ACCEPT)
            .header(AUTHORIZATION, "Bearer lucida_pat_cli")
            .body(Body::empty())
            .unwrap();
        for request in [fetch, post, with_token] {
            let response = app.clone().oneshot(request).await.unwrap();
            assert!(session_cookies(&response).is_empty());
        }
        assert_eq!(
            store
                .delete_expired(Utc::now() + ChronoDuration::days(365))
                .await
                .unwrap(),
            0,
            "no row was written"
        );
        assert_eq!(whoami_with(&app, None).await.email, "dev@local");
    }

    /// The trace driver and `dataset montage` open a workspace the CLI
    /// chose, as `dev@local`, and load it with `?render=1` in a browser
    /// with no cookies. Given a session there, the page would be someone
    /// with no access to that workspace.
    #[tokio::test]
    async fn the_capture_surface_stays_the_cli_that_opened_it() {
        let app = app(shared(), Arc::new(MemorySessionStore::new())).await;
        assert_eq!(load(&app, "/w/ws-1?render=1", None).await, None);
        assert_eq!(load(&app, "/w/ws-1?x=1&render=1", None).await, None);
        assert!(load(&app, "/w/ws-1?render=0", None).await.is_some());
    }

    #[tokio::test]
    async fn a_forged_session_cookie_names_nobody_and_a_page_load_replaces_it() {
        let app = app(shared(), Arc::new(MemorySessionStore::new())).await;
        let forged = "lucida_session=anon_never-minted-by-this-server";

        assert_eq!(whoami_with(&app, Some(forged)).await.email, "dev@local");

        let replaced = load(&app, "/", Some(forged)).await.expect("a fresh one");
        assert_ne!(replaced, forged);
        assert!(
            whoami_with(&app, Some(&replaced))
                .await
                .email
                .starts_with("anon-")
        );
    }

    #[tokio::test]
    async fn a_signed_in_session_is_not_honored_in_disabled_mode() {
        let store = Arc::new(MemorySessionStore::new());
        let now = Utc::now();
        store
            .create(LoginSession {
                id: "3f2a8c1e-0000-4000-8000-000000000000".into(),
                email: "alice@example.com".into(),
                display_name: "Alice".into(),
                picture_url: None,
                created_at: now,
                last_used_at: now,
                expires_at: now + ChronoDuration::hours(1),
            })
            .await
            .unwrap();
        let app = app(shared(), store).await;
        let cookie = "lucida_session=3f2a8c1e-0000-4000-8000-000000000000";
        assert_eq!(whoami_with(&app, Some(cookie)).await.email, "dev@local");
    }

    #[tokio::test]
    async fn an_anonymous_session_is_not_honored_by_sign_in() {
        let store = Arc::new(MemorySessionStore::new());
        let config = shared();
        let session = new_session(&config, [1, 2, 3, 4, 5, 6], Utc::now());
        store.create(session.clone()).await.unwrap();

        let mut google = config.clone();
        google.mode = AuthMode::Google;
        let extractor =
            SessionCookieExtractor::new(Arc::new(google), store as Arc<dyn LoginSessionStore>);
        let parts = Request::builder()
            .uri("/")
            .header(header::COOKIE, format!("lucida_session={}", session.id))
            .body(())
            .unwrap()
            .into_parts()
            .0;
        assert_eq!(
            extractor.extract(&parts).await.unwrap_err(),
            AuthError::Unauthenticated,
            "a session nobody signed in for must not sign anyone in",
        );
    }

    #[tokio::test]
    async fn an_anonymous_session_never_carries_admin_rights() {
        let store = Arc::new(MemorySessionStore::new());
        let first = {
            let app = app(shared(), Arc::clone(&store)).await;
            let cookie = load(&app, "/", None).await.unwrap();
            (cookie.clone(), whoami_with(&app, Some(&cookie)).await)
        };

        // Even an allowlist that names the minted address grants nothing.
        let mut config = shared();
        config.admin_emails = [first.1.email.clone()].into_iter().collect();
        let app = app(config, store).await;
        let p = whoami_with(&app, Some(&first.0)).await;
        assert_eq!(p.email, first.1.email);
        assert!(!p.is_admin);
    }

    #[tokio::test]
    async fn an_expired_session_names_nobody() {
        let store = Arc::new(MemorySessionStore::new());
        let config = shared();
        let now = Utc::now();

        let mut idle = new_session(&config, [1; 6], now - ChronoDuration::days(8));
        idle.expires_at = now + ChronoDuration::days(20);
        let capped = new_session(&config, [2; 6], now - ChronoDuration::days(31));
        for session in [&idle, &capped] {
            store.create(session.clone()).await.unwrap();
        }

        let app = app(config, store).await;
        for session in [idle, capped] {
            let cookie = format!("lucida_session={}", session.id);
            assert_eq!(whoami_with(&app, Some(&cookie)).await.email, "dev@local");
            assert!(load(&app, "/", Some(&cookie)).await.is_some(), "replaced");
        }
    }

    fn dev_cookie(config: &AuthConfig, email: &str) -> String {
        let principal = normalize_dev_principal(email, None).unwrap();
        let set_cookie = build_dev_principal_cookie(config, &principal, false);
        set_cookie.split(';').next().unwrap().to_string()
    }

    /// One person sits at a loopback bind and drives the CLI and the
    /// browser alike, so the browser is `dev@local` too and opens the
    /// workspaces the CLI made.
    #[tokio::test]
    async fn on_loopback_a_browser_is_the_cli_and_the_switcher_still_works() {
        let store = Arc::new(MemorySessionStore::new());
        let config = loopback();
        let app = app(config.clone(), Arc::clone(&store)).await;

        assert_eq!(load(&app, "/", None).await, None, "nothing is minted");
        assert_eq!(whoami_with(&app, None).await.email, "dev@local");

        let switched = dev_cookie(&config, "viewer@example.com");
        assert_eq!(
            whoami_with(&app, Some(&switched)).await.email,
            "viewer@example.com"
        );

        // A session minted while the same database served a shared bind
        // names nobody here.
        let session = new_session(&config, [3; 6], Utc::now());
        store.create(session.clone()).await.unwrap();
        let cookie = format!("lucida_session={}", session.id);
        assert_eq!(whoami_with(&app, Some(&cookie)).await.email, "dev@local");
    }

    #[tokio::test]
    async fn off_loopback_the_dev_cookie_is_ignored_and_the_session_answers() {
        let config = shared();
        let app = app(config.clone(), Arc::new(MemorySessionStore::new())).await;
        let session = load(&app, "/", None).await.unwrap();
        let anonymous = whoami_with(&app, Some(&session)).await;
        let both = format!("{session}; {}", dev_cookie(&config, "owner@example.com"));

        assert_eq!(whoami_with(&app, Some(&both)).await, anonymous);
    }

    #[tokio::test]
    async fn other_modes_mint_nothing() {
        for mode in [AuthMode::Google, AuthMode::Iap] {
            let mut config = shared();
            config.mode = mode;
            let pages = Router::new().fallback(|| async { "<html>lucida</html>" });
            let app = with_anonymous_sessions(
                pages,
                Arc::new(config),
                Arc::new(MemorySessionStore::new()) as Arc<dyn LoginSessionStore>,
            );
            assert_eq!(load(&app, "/", None).await, None, "{mode:?}");
        }
    }

    #[tokio::test]
    async fn the_stub_extractor_resolves_a_minted_session_to_its_row() {
        let store = Arc::new(MemorySessionStore::new());
        let config = Arc::new(shared());
        let session = new_session(&config, [9, 8, 7, 6, 5, 4], Utc::now());
        store.create(session.clone()).await.unwrap();

        let extractor = StubPrincipalExtractor::new(config, store as Arc<dyn LoginSessionStore>);
        let parts = Request::builder()
            .uri("/")
            .header(header::COOKIE, format!("lucida_session={}", session.id))
            .body(())
            .unwrap()
            .into_parts()
            .0;
        let p = extractor.extract(&parts).await.unwrap();
        assert_eq!(p.email, session.email);
        assert_eq!(p.display_name, session.display_name);
        assert_eq!(p.picture_url, session.picture_url);
    }

    #[test]
    fn the_name_and_color_follow_from_the_address() {
        let a = AnonymousIdentity::from_seed([0, 8, 0xab, 0xcd, 0xef, 0x01]);
        assert_eq!(
            a,
            AnonymousIdentity::from_seed([0, 8, 0xab, 0xcd, 0xef, 0x01])
        );
        assert_eq!(a.email, "anon-0008abcdef01@local");
        assert_eq!(a.display_name, "Crimson Lantern");
        let svg = STANDARD
            .decode(
                a.picture_url
                    .strip_prefix("data:image/svg+xml;base64,")
                    .unwrap(),
            )
            .unwrap();
        let svg = String::from_utf8(svg).unwrap();
        assert!(svg.contains(r##"fill="#b4233c""##), "{svg}");
        assert!(svg.contains(">CL</text>"), "{svg}");

        let b = AnonymousIdentity::from_seed([5, 1, 0, 0, 0, 0]);
        assert_eq!(b.display_name, "Teal Beacon");
    }

    #[test]
    fn every_session_gets_an_id_of_its_own() {
        let config = shared();
        let session = new_session(&config, [0xaa; 6], Utc::now());
        assert!(is_anonymous_session_id(&session.id));
        assert_ne!(session.id, new_session(&config, [0xaa; 6], Utc::now()).id);
    }
}
