//! End-to-end OAuth flow test for slice 4 (PRD #455, issue #460).
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

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::header::{LOCATION, SET_COOKIE};
use axum::http::{Request, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use chrono::Utc;
use jsonwebtoken::{encode, EncodingKey, Header};
use lucida_core::auth_principal::AuthPrincipal;
use rsa::pkcs1::{EncodeRsaPrivateKey, EncodeRsaPublicKey};
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tower::ServiceExt;

use lucida_server::auth::handlers::{
    auth_callback, auth_start, whoami, OAuthState,
};
use lucida_server::auth::middleware::{auth_middleware, build_extractor, SharedExtractor};
use lucida_server::auth::{
    AuthConfig, GoogleOAuthClient, LoginSessionStore, MemoryPendingAuthStore,
    MemorySessionStore, PendingAuthStore,
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
    public.to_pkcs1_pem(rsa::pkcs1::LineEnding::LF).expect("pub pem");

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
    let now = Utc::now().timestamp();
    let claims = TestClaims {
        iss: TEST_ISSUER,
        aud: TEST_CLIENT_ID,
        sub: "test-subject-id-12345",
        email,
        email_verified: true,
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
    let mut config = AuthConfig::for_tests_google(TEST_CLIENT_ID, TEST_REDIRECT_URI, mock_base);
    // Lucida's google client validates against this issuer list; the
    // helper sets it to ["https://test-issuer"], matching mint_id_token.
    let _ = &mut config;

    let arc_config = Arc::new(config);
    let session_store = Arc::new(MemorySessionStore::new());
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
    );

    // Authed half: only `/auth/whoami` here so tests can probe it.
    let authed = Router::new()
        .route("/auth/whoami", get(whoami))
        .layer(from_fn_with_state(extractor, auth_middleware));

    // Public half: /auth/start + /auth/callback. NOT wrapped in the
    // middleware (would loop). Mirrors `main.rs`'s split.
    let public = Router::new()
        .route(
            "/auth/start",
            post(auth_start).get(auth_start).with_state(oauth_state.clone()),
        )
        .route(
            "/auth/callback",
            get(auth_callback).with_state(oauth_state),
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
        .body(Body::empty())
        .unwrap();
    let cb_res = app.router.clone().oneshot(cb_req).await.unwrap();
    assert_eq!(cb_res.status(), StatusCode::FOUND, "callback must 302");

    // Cookie set + redirect target reconstructed from intent
    let set_cookie = cb_res
        .headers()
        .get(SET_COOKIE)
        .expect("callback must set cookie")
        .to_str()
        .unwrap()
        .to_string();
    assert!(set_cookie.contains("lucida_session="));
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Lax"));
    assert!(set_cookie.contains("Path=/"));

    let landing = cb_res
        .headers()
        .get(LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
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
async fn callback_with_unknown_state_returns_400_and_state_mismatch() {
    let keys = build_test_keys();
    let (mock_base, _mock_state) = spawn_mock_google(keys.jwks_json.clone()).await;
    let app = build_lucida_app(&mock_base).await;

    let cb_req = Request::builder()
        .uri("/auth/callback?code=anything&state=ghost")
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(cb_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["error"], "state_mismatch");
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
    let state_token = extract_state_param(start_res.headers().get(LOCATION).unwrap().to_str().unwrap());

    let id_token = mint_id_token(
        &keys.private_pem,
        "bob@example.com",
        "Bob E2E",
        "https://example.com/b.png",
        None,
    );
    *mock_state.queued_id_token.lock().unwrap() = Some(id_token);
    let cb_req = Request::builder()
        .uri(&format!("/auth/callback?code=c&state={state_token}"))
        .body(Body::empty())
        .unwrap();
    let cb_res = app.router.clone().oneshot(cb_req).await.unwrap();
    assert_eq!(cb_res.status(), StatusCode::FOUND);

    // Replay the same state token — must 400.
    let replay = Request::builder()
        .uri(&format!("/auth/callback?code=c&state={state_token}"))
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(replay).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["error"], "state_mismatch");
}

#[tokio::test]
async fn callback_with_invalid_jwt_signature_returns_500_jwt_invalid() {
    // Use a fresh keypair for the JWKS but sign with a *different*
    // private key — the signature must fail validation.
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
    let state_token = extract_state_param(start_res.headers().get(LOCATION).unwrap().to_str().unwrap());

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
        .uri(&format!("/auth/callback?code=c&state={state_token}"))
        .body(Body::empty())
        .unwrap();
    let res = app.router.oneshot(cb_req).await.unwrap();
    assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let bytes = to_bytes(res.into_body(), 64 * 1024).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["error"], "jwt_invalid");
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
