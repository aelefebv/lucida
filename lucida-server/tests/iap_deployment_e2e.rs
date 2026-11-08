//! The production shape, end to end against the real binary: `LUCIDA_AUTH=iap`
//! on a non-loopback bind, `LUCIDA_INSECURE` unset, no allowed origins
//! configured. Browsers reach the server on its own origin with the
//! perimeter's signed assertion; the CLI and the Python client present a
//! bearer token and send no `Origin`.
//!
//! The perimeter's key set is served by a mock on loopback, and assertions
//! are signed with a key generated per run.

mod boot;

use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::routing::get;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::StreamExt;
use jsonwebtoken::{EncodingKey, Header, encode};
use p256::SecretKey;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

use boot::{STARTUP_BUDGET, free_port, server};
use lucida_server::auth::hash_bearer_token;
use lucida_server::auth::iap::IAP_ASSERTION_HEADER;
use lucida_server::connection::CLOSE_ACCESS_REVOKED;

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Placeholder digits, not anybody's project.
const AUDIENCE: &str = "/projects/000000000000/global/backendServices/0000000000000000000";
const ISSUER: &str = "https://test-iap-issuer";
const READ_TIMEOUT: Duration = Duration::from_secs(20);

struct SigningKey {
    kid: String,
    pem: String,
    jwks: String,
}

impl SigningKey {
    fn generate() -> Self {
        let secret = SecretKey::random(&mut rand::rngs::OsRng);
        let pem = secret.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
        let point = secret.public_key().to_encoded_point(false);
        let kid = "e2e-key".to_string();
        let jwks = json!({
            "keys": [{
                "kty": "EC", "crv": "P-256", "alg": "ES256", "use": "sig", "kid": kid,
                "x": URL_SAFE_NO_PAD.encode(point.x().unwrap()),
                "y": URL_SAFE_NO_PAD.encode(point.y().unwrap()),
            }]
        })
        .to_string();
        Self { kid, pem, jwks }
    }

    /// The assertion the perimeter attaches for a signed-in `email`.
    fn assertion(&self, email: &str) -> String {
        let now = chrono::Utc::now().timestamp();
        let claims = json!({
            "iss": ISSUER, "aud": AUDIENCE, "email": email,
            "sub": format!("accounts.example.com:{email}"),
            "iat": now - 10, "exp": now + 600,
        });
        let mut header = Header::new(jsonwebtoken::Algorithm::ES256);
        header.kid = Some(self.kid.clone());
        encode(
            &header,
            &claims,
            &EncodingKey::from_ec_pem(self.pem.as_bytes()).unwrap(),
        )
        .unwrap()
    }
}

struct Deployment {
    child: Child,
    port: u16,
    key: SigningKey,
    stderr: Arc<Mutex<Vec<u8>>>,
    http: reqwest::Client,
    _tmp: tempfile::TempDir,
}

impl Drop for Deployment {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Deployment {
    async fn start() -> Self {
        let key = SigningKey::generate();
        let jwks = key.jwks.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let jwks_addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = Router::new().route(
                "/iap-keys",
                get(move || {
                    let jwks = jwks.clone();
                    async move { ([("content-type", "application/json")], jwks) }
                }),
            );
            let _ = axum::serve(listener, app).await;
        });

        // The cases run in parallel, and two handed the same free port
        // before either server bound it would both talk to whichever won.
        // A case picks its port only once the previous one's server answers.
        static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _starting = STARTING.lock().await;

        let tmp = tempfile::tempdir().unwrap();
        let port = free_port();
        // `server` passes no `LUCIDA_*` variable through, so
        // `LUCIDA_INSECURE` and `LUCIDA_ALLOWED_ORIGINS` are unset.
        let mut command = server(&format!("0.0.0.0:{port}"));
        command
            .env("LUCIDA_AUTH", "iap")
            .env("LUCIDA_IAP_AUDIENCE", AUDIENCE)
            .env("LUCIDA_IAP_ISSUER", ISSUER)
            .env(
                "LUCIDA_IAP_JWKS_URI",
                format!("http://{jwks_addr}/iap-keys"),
            )
            .env(
                "LUCIDA_DB_URL",
                format!("sqlite://{}", tmp.path().join("lucida.db").display()),
            )
            .env(
                "LUCIDA_GENERATED_COARSE_CACHE_DIR",
                tmp.path().join("cache"),
            )
            .env("LUCIDA_WEB_DIST", tmp.path().join("no-dist"))
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command.spawn().expect("spawn lucida-server");
        let stderr = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut pipe) = child.stderr.take() {
            let stderr = Arc::clone(&stderr);
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = pipe.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    stderr.lock().unwrap().extend_from_slice(&buf[..n]);
                }
            });
        }

        let mut deployment = Self {
            child,
            port,
            key,
            stderr,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            _tmp: tmp,
        };
        deployment.wait_until_healthy().await;
        deployment
    }

    async fn wait_until_healthy(&mut self) {
        let deadline = tokio::time::Instant::now() + STARTUP_BUDGET;
        while tokio::time::Instant::now() < deadline {
            if !matches!(self.child.try_wait(), Ok(None)) {
                break;
            }
            if let Ok(res) = self.http.get(self.url("/healthz")).send().await
                && res.status().is_success()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the server never became healthy; stderr:\n{}", self.logs());
    }

    fn logs(&self) -> String {
        String::from_utf8_lossy(&self.stderr.lock().unwrap()).into_owned()
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// The server's own origin, as a browser on it would send.
    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// A browser request from the server's own origin, signed in as `email`.
    fn browser(&self, method: reqwest::Method, path: &str, email: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, self.url(path))
            .header(IAP_ASSERTION_HEADER, self.key.assertion(email))
            .header("origin", self.origin())
    }

    async fn create_workspace(&self, owner: &str) -> String {
        let res = self
            .browser(reqwest::Method::POST, "/api/workspaces", owner)
            .json(&json!({ "name": "Deployment" }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 201, "create workspace");
        res.json::<Value>().await.unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// `lucida auth login`'s flow: start, approve in the browser, poll.
    async fn mint_bearer_token(&self, approver: &str) -> String {
        let raw = format!("lucida_pat_{}", uuid::Uuid::new_v4().simple());
        let started: Value = self
            .http
            .post(self.url("/auth/cli/start"))
            .json(&json!({ "name": "e2e", "token_hash": hash_bearer_token(&raw) }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let approved = self
            .browser(
                reqwest::Method::POST,
                started["approval_path"].as_str().unwrap(),
                approver,
            )
            .header("content-type", "application/x-www-form-urlencoded")
            .body("action=approve")
            .send()
            .await
            .unwrap();
        assert_eq!(approved.status(), 200, "approve the CLI request");
        let polled: Value = self
            .http
            .get(self.url(started["poll_path"].as_str().unwrap()))
            .bearer_auth(started["poll_token"].as_str().unwrap())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(polled["status"], "approved");
        raw
    }

    /// Open a workspace socket with the given extra headers.
    async fn socket(
        &self,
        workspace_id: &str,
        headers: &[(&str, String)],
    ) -> Result<WsClient, tokio_tungstenite::tungstenite::Error> {
        let mut request = format!("ws://127.0.0.1:{}/ws/workspaces/{workspace_id}", self.port)
            .into_client_request()
            .unwrap();
        for (name, value) in headers {
            request.headers_mut().insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        let config = WebSocketConfig::default().max_message_size(Some(256 * 1024 * 1024));
        connect_async_with_config(request, Some(config), false)
            .await
            .map(|(ws, _)| ws)
    }

    async fn browser_socket(&self, workspace_id: &str, email: &str) -> WsClient {
        self.socket(
            workspace_id,
            &[
                (IAP_ASSERTION_HEADER, self.key.assertion(email)),
                ("origin", self.origin()),
            ],
        )
        .await
        .unwrap_or_else(|e| panic!("browser socket refused: {e}; stderr:\n{}", self.logs()))
    }
}

/// The first text message, which on a fresh socket is the join snapshot.
async fn first_message(ws: &mut WsClient) -> Value {
    loop {
        match timeout(READ_TIMEOUT, ws.next())
            .await
            .expect("timed out waiting for a message")
        {
            Some(Ok(WsMessage::Text(text))) => return serde_json::from_str(text.as_str()).unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("socket ended: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_origin_browsers_and_bearer_clients_reach_their_workspace() {
    let deployment = Deployment::start().await;
    let workspace = deployment.create_workspace("alice@example.com").await;

    let mut browser = deployment
        .browser_socket(&workspace, "alice@example.com")
        .await;
    assert_eq!(first_message(&mut browser).await["type"], "snapshot");

    // The CLI and the Python client: a bearer token and no `Origin`.
    let token = deployment.mint_bearer_token("alice@example.com").await;
    let mut cli = deployment
        .socket(&workspace, &[("authorization", format!("Bearer {token}"))])
        .await
        .unwrap_or_else(|e| panic!("bearer socket refused: {e}"));
    assert_eq!(first_message(&mut cli).await["type"], "snapshot");
    let listed: Value = deployment
        .http
        .get(deployment.url("/api/workspaces"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w["id"] == workspace.as_str()),
        "the bearer client lists the workspace: {listed}"
    );

    // Cookies the server sets are `Secure` on a bind other machines reach.
    let logout = deployment
        .browser(reqwest::Method::POST, "/auth/logout", "alice@example.com")
        .send()
        .await
        .unwrap();
    let cookies: Vec<_> = logout
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect();
    assert!(!cookies.is_empty());
    assert!(cookies.iter().all(|c| c.contains("Secure")), "{cookies:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_page_on_another_origin_gets_no_socket_and_no_cors() {
    let deployment = Deployment::start().await;
    let workspace = deployment.create_workspace("alice@example.com").await;

    let refused = deployment
        .socket(
            &workspace,
            &[
                (
                    IAP_ASSERTION_HEADER,
                    deployment.key.assertion("alice@example.com"),
                ),
                ("origin", "https://elsewhere.example".to_string()),
            ],
        )
        .await;
    match refused {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), 403);
        }
        other => panic!("a cross-origin upgrade must be refused, got {other:?}"),
    }

    let preflight = deployment
        .http
        .request(reqwest::Method::OPTIONS, deployment.url("/api/workspaces"))
        .header("origin", "https://elsewhere.example")
        .header("access-control-request-method", "POST")
        .send()
        .await
        .unwrap();
    assert!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .is_none(),
        "no CORS grant for another origin"
    );
    let read = deployment
        .http
        .get(deployment.url("/api/workspaces"))
        .header(
            IAP_ASSERTION_HEADER,
            deployment.key.assertion("alice@example.com"),
        )
        .header("origin", "https://elsewhere.example")
        .send()
        .await
        .unwrap();
    assert!(read.headers().get("access-control-allow-origin").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removing_a_member_closes_their_open_socket() {
    let deployment = Deployment::start().await;
    let workspace = deployment.create_workspace("alice@example.com").await;
    let added = deployment
        .browser(
            reqwest::Method::POST,
            &format!("/api/workspaces/{workspace}/members"),
            "alice@example.com",
        )
        .json(&json!({ "email": "bob@example.com", "role": "viewer" }))
        .send()
        .await
        .unwrap();
    assert_eq!(added.status(), 200);

    let mut bob = deployment
        .browser_socket(&workspace, "bob@example.com")
        .await;
    assert_eq!(first_message(&mut bob).await["type"], "snapshot");

    let removed = deployment
        .browser(
            reqwest::Method::DELETE,
            &format!("/api/workspaces/{workspace}/members/bob@example.com"),
            "alice@example.com",
        )
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 204);

    let frame = loop {
        match timeout(READ_TIMEOUT, bob.next())
            .await
            .expect("the socket stayed open after the member was removed")
        {
            Some(Ok(WsMessage::Close(frame))) => break frame,
            Some(Ok(_)) => continue,
            other => panic!("socket ended without a close frame: {other:?}"),
        }
    };
    assert_eq!(
        u16::from(frame.expect("a close frame with a reason").code),
        CLOSE_ACCESS_REVOKED
    );
}
