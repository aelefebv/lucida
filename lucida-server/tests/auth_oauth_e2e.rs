//! End-to-end OAuth flow test.
//!
//! Stands up two axum apps inside the test process:
//!
//! 1. A **mock Google**: serves `/token` (returns a fake JWT) and
//!    `/certs` (returns the JWKS for the test signing key). Listens
//!    on an ephemeral 127.0.0.1 port; the URL is plumbed into the
//!    lucida server's `AuthConfig` via `for_tests_google`.
//! 2. The **lucida server under test**: built from the same `Router`
//!    pieces `main.rs` wires (auth_start + auth_callback + whoami +
//!    middleware) but with a `MemorySessionStore` +
//!    `MemoryPendingAuthStore` in place of SQLite. We drive it
//!    directly via `tower::ServiceExt::oneshot`; no real listener.
//!
//! The test then walks the full flow:
//!
//!   - POST /auth/start with `{path, hash}` → 302 with state in the
//!     Location header. We capture the state token.
//!   - Forge a code, mint a JWT with the test key, ride the JWT through
//!     the mock token endpoint by wiring the mock to return it.
//!   - GET /auth/callback?code=…&state=… → 302 with Set-Cookie + the
//!     reconstructed Location (path#hash).
//!   - GET /auth/whoami with the captured cookie → 200 with the
//!     extracted principal JSON.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::header::{LOCATION, SET_COOKIE};
use axum::http::{Request, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use chrono::Utc;
use jsonwebtoken::{EncodingKey, Header, encode};
use lucida_core::auth_principal::AuthPrincipal;
use rsa::pkcs1::{EncodeRsaPrivateKey, EncodeRsaPublicKey};
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpListener;
use tower::ServiceExt;

use lucida_server::auth::handlers::{OAuthState, auth_callback, auth_start, whoami};
use lucida_server::auth::middleware::{SharedExtractor, auth_middleware, build_extractor};
use lucida_server::auth::{
    AuthConfig, BearerTokenStore, GoogleOAuthClient, LoginSessionStore, MemoryBearerTokenStore,
    MemoryPendingAuthStore, MemorySessionStore, PendingAuthStore,
};

const TEST_CLIENT_ID: &str = "test-client-id";
const TEST_REDIRECT_URI: &str = "http://localhost:9876/auth/callback";
const TEST_KID: &str = "kid-test-1";
const TEST_ISSUER: &str = "https://test-issuer";

// -- Mock Google --------------------------------------------------------

/// The mock issues whatever JWT the test queues up via this state.
/// Each `/token` POST drains one queued JWT (so a "no JWT queued"
/// case can be exercised by leaving the queue empty).
#[derive(Clone)]
struct MockGoogleState {
    jwks_json: String,
    queued_id_token: Arc<Mutex<Option<String>>>,
}

#[derive(Deserialize)]
struct TokenForm {
    code: String,
    #[serde(default)]
    grant_type: String,
}

#[derive(Serialize)]
struct TokenSuccess {
    id_token: String,
    access_token: String,
    expires_in: u64,
    token_type: String,
}

async fn mock_token(
    State(state): State<MockGoogleState>,
    body: axum::extract::Form<TokenForm>,
) -> impl IntoResponse {
    // Refuse anything but the documented grant_type so a bug in the
    // handler that posts e.g. refresh_token to the mock surfaces here.
    if body.grant_type != "authorization_code" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_grant_type" })),
        )
            .into_response();
    }
    if body.code.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing_code" })),
        )
            .into_response();
    }
    let queued = state.queued_id_token.lock().unwrap().take();
    match queued {
        Some(token) => Json(TokenSuccess {
            id_token: token,
            access_token: "fake-access".into(),
            expires_in: 3600,
            token_type: "Bearer".into(),
        })
        .into_response(),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "no_token_queued" })),
        )
            .into_response(),
    }
}

async fn mock_jwks(State(state): State<MockGoogleState>) -> impl IntoResponse {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        state.jwks_json,
    )
        .into_response()
}

async fn spawn_mock_google(jwks_json: String) -> (String, MockGoogleState) {
    let state = MockGoogleState {
        jwks_json,
        queued_id_token: Arc::new(Mutex::new(None)),
    };
    let app = Router::new()
        .route("/token", post(mock_token))
        .route("/certs", get(mock_jwks))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    // Tiny pause so the listener is actually accepting before the
    // first GET hits it. Without this, occasionally the JWKS prime in
    // GoogleOAuthClient::new races the listener.
    tokio::time::sleep(Duration::from_millis(50)).await;
    (format!("http://{addr}"), state)
}

// -- Test signing key + JWKS construction --------------------------------

struct TestKeyPair {
    private_pem: String,
    jwks_json: String,
}

fn build_test_keys() -> TestKeyPair {
    use rand::rngs::OsRng;
    let mut rng = OsRng;
    // 2048 bits matches Google's typical key size; keeps the test
    // honest about RS256 behaviour without paying for 4096-bit
    // generation overhead.
    let private = RsaPrivateKey::new(&mut rng, 2048).expect("rsa keygen");
    let public = RsaPublicKey::from(&private);

    let private_pem = private
        .to_pkcs1_pem(rsa::pkcs1::LineEnding::LF)
        .expect("pkcs1 pem")
        .to_string();
    // Verify the public key encodes (we don't actually need the PEM
    // form, but the round-trip sanity-checks the JWK we build below).
    public
        .to_pkcs1_pem(rsa::pkcs1::LineEnding::LF)
        .expect("pub pem");

    let n = base64_url(public.n());
    let e = base64_url(public.e());
    let jwks_json = json!({
        "keys": [{
            "kty": "RSA",
            "use": "sig",
            "alg": "RS256",
            "kid": TEST_KID,
            "n": n,
            "e": e,
        }]
    })
    .to_string();
    TestKeyPair {
        private_pem,
        jwks_json,
    }
}

fn base64_url(b: &BigUint) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b.to_bytes_be())
}

// Standard Google ID-token claim shape (the subset that matters).
#[derive(Serialize)]
struct TestClaims<'a> {
    iss: &'a str,
    aud: &'a str,
    sub: &'a str,
    email: &'a str,
    email_verified: bool,
    name: &'a str,
    picture: &'a str,
    iat: i64,
    exp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    hd: Option<&'a str>,
}

fn mint_id_token(
    private_pem: &str,
    email: &str,
    name: &str,
    picture: &str,
    hd: Option<&str>,
) -> String {
    mint_id_token_full(private_pem, email, name, picture, hd, true)
}

/// Lets tests forge tokens with `email_verified: false` to exercise
/// the unverified-rejection path. `mint_id_token` keeps the default
/// of `true` so existing call sites don't need updating.
fn mint_id_token_full(
    private_pem: &str,
    email: &str,
    name: &str,
    picture: &str,
    hd: Option<&str>,
    email_verified: bool,
) -> String {
    let now = Utc::now().timestamp();
    let claims = TestClaims {
        iss: TEST_ISSUER,
        aud: TEST_CLIENT_ID,
        sub: "test-subject-id-12345",
        email,
        email_verified,
        name,
        picture,
        iat: now,
        exp: now + 3600,
        hd,
    };
    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some(TEST_KID.to_string());
    let key = EncodingKey::from_rsa_pem(private_pem.as_bytes()).expect("encoding key");
    encode(&header, &claims, &key).expect("encode jwt")
}

// -- App-under-test wiring ----------------------------------------------

struct LucidaApp {
    router: Router,
    session_store: Arc<MemorySessionStore>,
    pending_store: Arc<MemoryPendingAuthStore>,
}

async fn build_lucida_app(mock_base: &str) -> LucidaApp {
    build_lucida_app_with_allowed_domains(mock_base, &[]).await
}

/// Same wiring as `build_lucida_app` but with
/// `LUCIDA_ALLOWED_HOSTED_DOMAINS` set to the supplied list. Empty
/// list = OSS-permissive default (any verified email accepted).
async fn build_lucida_app_with_allowed_domains(mock_base: &str, allowed: &[&str]) -> LucidaApp {
    let mut config = AuthConfig::for_tests_google(TEST_CLIENT_ID, TEST_REDIRECT_URI, mock_base);
    config.allowed_hosted_domains = allowed.iter().map(|s| s.to_string()).collect();

    let arc_config = Arc::new(config);
    let session_store = Arc::new(MemorySessionStore::new());
    let token_store = Arc::new(MemoryBearerTokenStore::new());
    let pending_store = Arc::new(MemoryPendingAuthStore::new());

    let google = Arc::new(
        GoogleOAuthClient::new(Arc::new(arc_config.google.clone().unwrap()))
            .await
            .expect("google client init"),
    );

    let oauth_state = OAuthState {
        config: Arc::clone(&arc_config),
        session_store: Arc::clone(&session_store) as Arc<dyn LoginSessionStore>,
        pending_store: Arc::clone(&pending_store) as Arc<dyn PendingAuthStore>,
        google: Arc::clone(&google),
    };

    let extractor: SharedExtractor = build_extractor(
        Arc::clone(&arc_config),
        Arc::clone(&session_store) as Arc<dyn LoginSessionStore>,
        Arc::clone(&token_store) as Arc<dyn BearerTokenStore>,
    );

    // Authed half: only `/auth/whoami` here so tests can probe it.
    let authed = Router::new()
        .route("/auth/whoami", get(whoami))
        .layer(from_fn_with_state(extractor, auth_middleware));

    // Public half: /auth/start + /auth/callback + /auth/error. NOT
    // wrapped in the middleware (would loop). Mirrors `main.rs`'s
    // split. /auth/error is plumbed so the integration test can probe
    // the redirect target end-to-end.
    let public = Router::new()
        .route(
            "/auth/start",
            post(auth_start)
                .get(auth_start)
                .with_state(oauth_state.clone()),
        )
        .route("/auth/callback", get(auth_callback).with_state(oauth_state))
        .route(
            "/auth/error",
            get(lucida_server::auth::error_page::auth_error),
        );

    let router = authed.merge(public);
    LucidaApp {
        router,
        session_store,
        pending_store,
    }
}

// -- The actual end-to-end test -----------------------------------------

#[tokio::test]
async fn full_oauth_flow_lands_user_at_intended_path_with_hash() {
    let keys = build_test_keys();
    let (mock_base, mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app(&mock_base).await;

    // Step 1: client posts /auth/start with the captured intent.
    let start_body = json!({"path": "/dataset/foo", "hash": "view=encoded-blob"}).to_string();
    let start_req = Request::builder()
        .method("POST")
        .uri("/auth/start")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(start_body))
        .unwrap();
    let start_res = app.router.clone().oneshot(start_req).await.unwrap();
    assert_eq!(start_res.status(), StatusCode::FOUND);
    let location = start_res
        .headers()
        .get(LOCATION)
        .expect("/auth/start must 302")
        .to_str()
        .unwrap()
        .to_string();
    assert!(location.starts_with(&format!("{mock_base}/oauth2/v2/auth?")));
    assert!(location.contains("state="));
    let state_token = extract_state_param(&location);
    let binding_cookie = extract_oauth_binding_cookie(&start_res);
    assert!(!state_token.is_empty(), "state token must be in redirect");
    assert_eq!(app.pending_store.len(), 1);

    // Step 2: queue a JWT for the mock to return on /token, then
    // simulate Google calling our /auth/callback.
    let id_token = mint_id_token(
        &keys.private_pem,
        "alice@example.com",
        "Alice E2E",
        "https://example.com/a.png",
        None,
    );
    *mock_state.queued_id_token.lock().unwrap() = Some(id_token);

    let cb_uri = format!("/auth/callback?code=fake-code-abc&state={state_token}");
    let cb_req = Request::builder()
        .uri(&cb_uri)
        .header("cookie", &binding_cookie)
        .body(Body::empty())
        .unwrap();
    let cb_res = app.router.clone().oneshot(cb_req).await.unwrap();
    assert_eq!(cb_res.status(), StatusCode::FOUND, "callback must 302");

    // Cookie set + redirect target reconstructed from intent.
    // Two Set-Cookie headers expected: the new session cookie AND a
    // clearing-marker for `lucida_signed_out` (no-op when marker
    // wasn't present, but emitted unconditionally — see ADR-0019).
    let set_cookies: Vec<String> = cb_res
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect();
    let set_cookie = set_cookies
        .iter()
        .find(|c| c.contains("lucida_session=") && !c.contains("lucida_session=;"))
        .expect("session cookie must be set")
        .clone();
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Lax"));
    assert!(set_cookie.contains("Path=/"));
    assert!(
        set_cookies
            .iter()
            .any(|c| c.contains("lucida_signed_out=") && c.contains("Max-Age=0")),
        "callback must emit a clearing-marker Set-Cookie",
    );

    let landing = cb_res.headers().get(LOCATION).unwrap().to_str().unwrap();
    assert_eq!(landing, "/dataset/foo#view=encoded-blob");

    // Pending row was consumed (one-time use)
    assert_eq!(app.pending_store.len(), 0, "pending row must be consumed");

    // Session row was created
    assert_eq!(app.session_store.len(), 1);

    // Step 3: hit /auth/whoami with the cookie; assert principal data
    // came from the JWT we forged.
    let cookie_pair = set_cookie.split(';').next().unwrap().to_string();
    let whoami_req = Request::builder()
        .uri("/auth/whoami")
        .header("cookie", cookie_pair)
        .body(Body::empty())
        .unwrap();
    let whoami_res = app.router.oneshot(whoami_req).await.unwrap();
    assert_eq!(whoami_res.status(), StatusCode::OK);
    let bytes = to_bytes(whoami_res.into_body(), 64 * 1024).await.unwrap();
    let principal: AuthPrincipal = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(principal.email, "alice@example.com");
    assert_eq!(principal.display_name, "Alice E2E");
    assert_eq!(
        principal.picture_url.as_deref(),
        Some("https://example.com/a.png")
    );
}

#[tokio::test]
async fn callback_with_unknown_state_redirects_to_auth_failed() {
    // Every callback failure 302s to /auth/error?code=auth_failed
    // (generic; details stay in server logs to avoid aiding
    // reconnaissance).
    let keys = build_test_keys();
    let (mock_base, _mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app(&mock_base).await;

    let cb_req = Request::builder()
        .uri("/auth/callback?code=anything&state=ghost")
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(cb_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get(LOCATION).unwrap().to_str().unwrap();
    assert_eq!(location, "/auth/error?code=auth_failed");
}

#[tokio::test]
async fn callback_from_another_browser_cannot_consume_oauth_state() {
    let keys = build_test_keys();
    let (mock_base, _mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app(&mock_base).await;

    let start_req = Request::builder()
        .method("POST")
        .uri("/auth/start")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"path": "/", "hash": ""}).to_string()))
        .unwrap();
    let start_res = app.router.clone().oneshot(start_req).await.unwrap();
    let state_token =
        extract_state_param(start_res.headers().get(LOCATION).unwrap().to_str().unwrap());

    let foreign_callback = Request::builder()
        .uri(format!("/auth/callback?code=c&state={state_token}"))
        .header("cookie", "lucida_oauth_binding=foreign-browser")
        .body(Body::empty())
        .unwrap();
    let response = app.router.oneshot(foreign_callback).await.unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(
        response.headers().get(LOCATION).unwrap(),
        "/auth/error?code=auth_failed"
    );
    assert_eq!(
        app.pending_store.len(),
        1,
        "foreign browser cannot consume state"
    );
}

#[tokio::test]
async fn callback_replay_of_consumed_state_returns_400() {
    let keys = build_test_keys();
    let (mock_base, mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app(&mock_base).await;

    // Drive a successful flow once.
    let start_req = Request::builder()
        .method("POST")
        .uri("/auth/start")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"path": "/", "hash": ""}).to_string()))
        .unwrap();
    let start_res = app.router.clone().oneshot(start_req).await.unwrap();
    let state_token =
        extract_state_param(start_res.headers().get(LOCATION).unwrap().to_str().unwrap());
    let binding_cookie = extract_oauth_binding_cookie(&start_res);

    let id_token = mint_id_token(
        &keys.private_pem,
        "bob@example.com",
        "Bob E2E",
        "https://example.com/b.png",
        None,
    );
    *mock_state.queued_id_token.lock().unwrap() = Some(id_token);
    let cb_req = Request::builder()
        .uri(format!("/auth/callback?code=c&state={state_token}"))
        .header("cookie", &binding_cookie)
        .body(Body::empty())
        .unwrap();
    let cb_res = app.router.clone().oneshot(cb_req).await.unwrap();
    assert_eq!(cb_res.status(), StatusCode::FOUND);

    // Replay the same state token — 302 to /auth/error?code=auth_failed.
    let replay = Request::builder()
        .uri(format!("/auth/callback?code=c&state={state_token}"))
        .header("cookie", &binding_cookie)
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(replay).await.unwrap();
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get(LOCATION).unwrap().to_str().unwrap();
    assert_eq!(location, "/auth/error?code=auth_failed");
}

#[tokio::test]
async fn callback_with_invalid_jwt_signature_redirects_to_auth_failed() {
    // Use a fresh keypair for the JWKS but sign with a *different*
    // private key — the signature must fail validation. The handler
    // 302s to /auth/error?code=auth_failed (vague to user; detail in
    // the server logs).
    let presented = build_test_keys();
    let (mock_base, mock_state) = spawn_mock_google(presented.jwks_json.clone()).await;
    let app = build_lucida_app(&mock_base).await;

    // Drive /auth/start to mint a state.
    let start_req = Request::builder()
        .method("POST")
        .uri("/auth/start")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"path": "/", "hash": ""}).to_string()))
        .unwrap();
    let start_res = app.router.clone().oneshot(start_req).await.unwrap();
    let state_token =
        extract_state_param(start_res.headers().get(LOCATION).unwrap().to_str().unwrap());
    let binding_cookie = extract_oauth_binding_cookie(&start_res);

    // Sign with a different key — JWKS + signing key disagree, so
    // jsonwebtoken's validate must reject.
    let attacker = build_test_keys();
    let bad_token = mint_id_token(
        &attacker.private_pem,
        "bad@example.com",
        "Bad",
        "https://x/bad.png",
        None,
    );
    *mock_state.queued_id_token.lock().unwrap() = Some(bad_token);

    let cb_req = Request::builder()
        .uri(format!("/auth/callback?code=c&state={state_token}"))
        .header("cookie", &binding_cookie)
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(cb_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FOUND);
    let location = res.headers().get(LOCATION).unwrap().to_str().unwrap();
    assert_eq!(location, "/auth/error?code=auth_failed");
}

#[tokio::test]
async fn auth_start_via_query_params_works_too() {
    // The noscript fallback in unauth_landing.rs calls /auth/start
    // with query params instead of a JSON body.
    let keys = build_test_keys();
    let (mock_base, _mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app(&mock_base).await;

    let req = Request::builder()
        .method("POST")
        .uri("/auth/start?path=%2Fdataset%2Fbar&hash=b%3D42")
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FOUND);
    assert_eq!(app.pending_store.len(), 1);
}

/// Marker-cookie path: when `lucida_signed_out=1` is on the inbound
/// request, `/auth/start` must include `prompt=select_account` on
/// Google's authorization URL. **The marker is NOT cleared here** —
/// it persists across multiple `/auth/start` invocations so the user
/// can bail out at Google's chooser and come back without losing the
/// signed-out posture. The marker is cleared by `/auth/callback` on
/// successful sign-in.
#[tokio::test]
async fn auth_start_with_marker_cookie_adds_prompt_but_does_not_clear_marker() {
    let keys = build_test_keys();
    let (mock_base, _mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app(&mock_base).await;

    let req = Request::builder()
        .method("POST")
        .uri("/auth/start?path=%2F&hash=")
        .header("cookie", "lucida_signed_out=1")
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FOUND);

    let location = res
        .headers()
        .get(LOCATION)
        .expect("/auth/start must 302")
        .to_str()
        .unwrap();
    assert!(
        location.contains("prompt=select_account"),
        "marker-cookie path must request the account chooser, got: {}",
        location,
    );

    // The marker must NOT be cleared — it's load-bearing for the
    // "user bailed out, came back" cycle. /auth/callback clears it
    // on success.
    let set_cookies: Vec<_> = res
        .headers()
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .collect();
    assert_eq!(set_cookies.len(), 1, "only the OAuth binding cookie is set");
    assert!(
        set_cookies[0]
            .to_str()
            .unwrap()
            .starts_with("lucida_oauth_binding=")
    );
}

/// Cold path (no marker cookie): no `prompt=` on the URL, no clearing
/// Set-Cookie. Confirms the conditional branch doesn't leak into the
/// friction-free first-visit / session-expiry path.
#[tokio::test]
async fn auth_start_without_marker_cookie_omits_prompt() {
    let keys = build_test_keys();
    let (mock_base, _mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app(&mock_base).await;

    let req = Request::builder()
        .method("POST")
        .uri("/auth/start?path=%2F&hash=")
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FOUND);

    let location = res.headers().get(LOCATION).unwrap().to_str().unwrap();
    assert!(!location.contains("prompt="));

    let set_cookies: Vec<_> = res
        .headers()
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .collect();
    assert_eq!(set_cookies.len(), 1);
    assert!(
        set_cookies[0]
            .to_str()
            .unwrap()
            .starts_with("lucida_oauth_binding=")
    );
}

// -- hosted-domain + email_verified -----------------------------------

/// `LUCIDA_ALLOWED_HOSTED_DOMAINS=allowedcorp.com` + a JWT with
/// `hd: othercorp.com`: callback must NOT mint a session, MUST 302 to
/// `/auth/error?code=hd_mismatch&attempted_email=…&allowed_domains=…`.
#[tokio::test]
async fn callback_with_disallowed_hd_redirects_to_error_no_session() {
    let keys = build_test_keys();
    let (mock_base, mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app_with_allowed_domains(&mock_base, &["allowedcorp.com"]).await;

    // /auth/start to mint a state token.
    let start_req = Request::builder()
        .method("POST")
        .uri("/auth/start")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"path": "/dataset/x", "hash": ""}).to_string(),
        ))
        .unwrap();
    let start_res = app.router.clone().oneshot(start_req).await.unwrap();
    let state_token =
        extract_state_param(start_res.headers().get(LOCATION).unwrap().to_str().unwrap());
    let binding_cookie = extract_oauth_binding_cookie(&start_res);

    // Forge JWT with disallowed hd.
    let bad = mint_id_token(
        &keys.private_pem,
        "alice@othercorp.com",
        "Alice Other",
        "https://example.com/a.png",
        Some("othercorp.com"),
    );
    *mock_state.queued_id_token.lock().unwrap() = Some(bad);

    let cb_req = Request::builder()
        .uri(format!("/auth/callback?code=c&state={state_token}"))
        .header("cookie", &binding_cookie)
        .body(Body::empty())
        .unwrap();
    let res = app.router.clone().oneshot(cb_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FOUND);

    // No session minted: cookie absent + store empty.
    assert!(
        res.headers().get(SET_COOKIE).is_none(),
        "rejection must not set the session cookie",
    );
    assert_eq!(app.session_store.len(), 0, "no session row on rejection");

    let location = res.headers().get(LOCATION).unwrap().to_str().unwrap();
    assert!(
        location.starts_with("/auth/error?"),
        "must redirect to /auth/error, got {location}",
    );
    assert!(location.contains("code=hd_mismatch"));
    // urlencoding encodes `@` as %40
    assert!(
        location.contains("attempted_email=alice%40othercorp.com"),
        "missing attempted_email in {location}",
    );
    assert!(
        location.contains("allowed_domains=allowedcorp.com"),
        "missing allowed_domains in {location}",
    );

    // Spot-check the rendered error page since the redirect target
    // is server-rendered: GET it and assert the message contains the
    // user-facing copy from the PRD.
    let err_req = Request::builder()
        .uri(location)
        .body(Body::empty())
        .unwrap();
    let err_res = app.router.oneshot(err_req).await.unwrap();
    assert_eq!(err_res.status(), StatusCode::OK);
    let body_bytes = to_bytes(err_res.into_body(), 64 * 1024).await.unwrap();
    let body = std::str::from_utf8(&body_bytes).unwrap();
    assert!(body.contains("alice@othercorp.com"), "page must echo email");
    assert!(
        body.contains("allowedcorp.com"),
        "page must echo allowed domain"
    );
    assert!(
        body.contains(r#"href="/auth/start""#),
        "page must offer retry link",
    );
}

/// Same setup, but JWT's hd matches the allowlist: callback must mint
/// the session as today (slice-4 happy path is preserved).
#[tokio::test]
async fn callback_with_allowed_hd_succeeds_and_mints_session() {
    let keys = build_test_keys();
    let (mock_base, mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app_with_allowed_domains(&mock_base, &["allowedcorp.com"]).await;

    let start_req = Request::builder()
        .method("POST")
        .uri("/auth/start")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"path": "/", "hash": ""}).to_string()))
        .unwrap();
    let start_res = app.router.clone().oneshot(start_req).await.unwrap();
    let state_token =
        extract_state_param(start_res.headers().get(LOCATION).unwrap().to_str().unwrap());
    let binding_cookie = extract_oauth_binding_cookie(&start_res);

    let good = mint_id_token(
        &keys.private_pem,
        "bob@allowedcorp.com",
        "Bob Allowed",
        "https://example.com/b.png",
        Some("allowedcorp.com"),
    );
    *mock_state.queued_id_token.lock().unwrap() = Some(good);

    let cb_req = Request::builder()
        .uri(format!("/auth/callback?code=c&state={state_token}"))
        .header("cookie", &binding_cookie)
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(cb_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FOUND);
    assert!(
        res.headers().get(SET_COOKIE).is_some(),
        "session cookie expected"
    );
    assert_eq!(app.session_store.len(), 1);
    let location = res.headers().get(LOCATION).unwrap().to_str().unwrap();
    assert_eq!(location, "/", "lands at intended path, not /auth/error");
}

/// JWT with `email_verified: false` (and hd matching the allowlist)
/// must reject with `code=unverified` regardless.
#[tokio::test]
async fn callback_with_unverified_email_redirects_to_unverified() {
    let keys = build_test_keys();
    let (mock_base, mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app_with_allowed_domains(&mock_base, &["allowedcorp.com"]).await;

    let start_req = Request::builder()
        .method("POST")
        .uri("/auth/start")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"path": "/", "hash": ""}).to_string()))
        .unwrap();
    let start_res = app.router.clone().oneshot(start_req).await.unwrap();
    let state_token =
        extract_state_param(start_res.headers().get(LOCATION).unwrap().to_str().unwrap());
    let binding_cookie = extract_oauth_binding_cookie(&start_res);

    let token = mint_id_token_full(
        &keys.private_pem,
        "charlie@allowedcorp.com",
        "Charlie Unverified",
        "https://example.com/c.png",
        Some("allowedcorp.com"),
        false, // email_verified
    );
    *mock_state.queued_id_token.lock().unwrap() = Some(token);

    let cb_req = Request::builder()
        .uri(format!("/auth/callback?code=c&state={state_token}"))
        .header("cookie", &binding_cookie)
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(cb_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FOUND);
    assert!(
        res.headers().get(SET_COOKIE).is_none(),
        "no cookie on rejection"
    );
    assert_eq!(app.session_store.len(), 0);
    let location = res.headers().get(LOCATION).unwrap().to_str().unwrap();
    assert!(location.contains("code=unverified"), "got {location}");
    assert!(
        location.contains("attempted_email=charlie%40allowedcorp.com"),
        "got {location}",
    );
}

/// Empty allowlist (the OSS-permissive default): any verified Google
/// email is accepted, with or without an `hd` claim.
#[tokio::test]
async fn empty_allowlist_accepts_any_verified_email() {
    let keys = build_test_keys();
    let (mock_base, mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app(&mock_base).await; // empty allowed_hosted_domains

    let start_req = Request::builder()
        .method("POST")
        .uri("/auth/start")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"path": "/", "hash": ""}).to_string()))
        .unwrap();
    let start_res = app.router.clone().oneshot(start_req).await.unwrap();
    let state_token =
        extract_state_param(start_res.headers().get(LOCATION).unwrap().to_str().unwrap());
    let binding_cookie = extract_oauth_binding_cookie(&start_res);

    // Personal Gmail (no hd): must succeed under the OSS-permissive default.
    let token = mint_id_token(
        &keys.private_pem,
        "personal@gmail.com",
        "Personal Account",
        "https://example.com/p.png",
        None,
    );
    *mock_state.queued_id_token.lock().unwrap() = Some(token);

    let cb_req = Request::builder()
        .uri(format!("/auth/callback?code=c&state={state_token}"))
        .header("cookie", &binding_cookie)
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(cb_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FOUND);
    assert!(res.headers().get(SET_COOKIE).is_some());
    assert_eq!(app.session_store.len(), 1, "permissive default accepts");
}

// -- helpers -------------------------------------------------------------

fn extract_state_param(location: &str) -> String {
    let q = location.split('?').nth(1).unwrap_or("");
    for pair in q.split('&') {
        if let Some(rest) = pair.strip_prefix("state=") {
            return urlencoding::decode(rest).unwrap().into_owned();
        }
    }
    String::new()
}

fn extract_oauth_binding_cookie<B>(response: &axum::http::Response<B>) -> String {
    response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with("lucida_oauth_binding="))
        .and_then(|value| value.split(';').next())
        .expect("/auth/start must set the OAuth browser binding")
        .to_string()
}
