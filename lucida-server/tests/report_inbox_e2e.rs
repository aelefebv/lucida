//! **Send report**, end to end: a bundle over a real workspace socket,
//! into a real database, and back out of the routes the CLI reads.
//!
//! The unit tests either side of this one can say that a bundle parses
//! and that a row round-trips. What only a live run can say is that the
//! two halves of the feature meet: the page sends on the socket it
//! already has, the CLI reads over HTTP with the token it already has,
//! and what comes out of the second is byte for byte what went into the
//! first. Written in the style of `server_timing_rows_e2e.rs`, which
//! drives the same socket for the same reason.

use std::sync::Arc;

use axum::Router;
use chrono::{DateTime, Duration, Utc};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::protocol::{ClientMessage, ServerMessage};
use lucida_server::auth::{
    AuthConfig, AuthMode, BearerToken, BearerTokenStore, DualCredentialExtractor,
    LoginSessionStore, MemoryBearerTokenStore, MemorySessionStore, PrincipalExtractor,
    hash_bearer_token,
};
use lucida_server::inbox::{InboxState, MAX_BUNDLE_BYTES, RETENTION_DAYS};
use lucida_server::storage::{self, DatabaseUrl};
use lucida_server::workspace::WorkspaceManager;
use lucida_server::{ProxyConfig, inbox};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The token the reporter's session and the CLI both present. One
/// principal, two transports, which is the arrangement the feature is
/// built on.
const RAW_TOKEN: &str = "lucida_pat_inbox_e2e";

/// A live server with one workspace in it, and the address to reach it.
struct Rig {
    address: std::net::SocketAddr,
    workspace_id: String,
    server: tokio::task::JoinHandle<()>,
}

impl Rig {
    fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    async fn connect(&self) -> WsClient {
        let url = format!(
            "ws://{}/ws/workspaces/{}",
            self.address,
            urlencoding::encode(&self.workspace_id)
        );
        let mut request = url.into_client_request().unwrap();
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {RAW_TOKEN}").parse().unwrap(),
        );
        let (socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        socket
    }

    /// The inbox listing, as the CLI reads it.
    async fn list(&self) -> Vec<serde_json::Value> {
        let response = reqwest::Client::new()
            .get(format!(
                "{}/api/workspaces/{}/inbox",
                self.base_url(),
                urlencoding::encode(&self.workspace_id)
            ))
            .bearer_auth(RAW_TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        response.json().await.unwrap()
    }

    /// One bundle, as the CLI fetches it to a file.
    async fn fetch(&self, entry_id: &str) -> reqwest::Response {
        reqwest::Client::new()
            .get(format!(
                "{}/api/workspaces/{}/inbox/{}",
                self.base_url(),
                urlencoding::encode(&self.workspace_id),
                urlencoding::encode(entry_id)
            ))
            .bearer_auth(RAW_TOKEN)
            .send()
            .await
            .unwrap()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn reporter() -> AuthPrincipal {
    AuthPrincipal {
        email: "reporter@example.com".into(),
        display_name: "Reporter".into(),
        picture_url: None,
        is_admin: false,
    }
}

/// A server with the inbox attached, one workspace, and one bearer token
/// that reaches both.
async fn rig() -> Rig {
    let storage = storage::open(&DatabaseUrl::in_memory()).await.unwrap();
    let workspace = storage
        .workspaces()
        .create_workspace(&reporter(), Some("Field reports"))
        .await
        .unwrap();

    let inbox_store = storage.inbox();
    let manager = Arc::new(
        WorkspaceManager::new(storage.workspaces(), ProxyConfig::defaults())
            .with_inbox(Arc::clone(&inbox_store)),
    );
    let app: Router = lucida_server::workspace::router(Arc::clone(&manager))
        .merge(inbox::router(InboxState {
            manager: Arc::clone(&manager),
            store: inbox_store,
        }))
        .layer(axum::middleware::from_fn_with_state(
            bearer_extractor().await,
            lucida_server::auth::middleware::auth_middleware,
        ));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Rig {
        address,
        workspace_id: workspace.id,
        server,
    }
}

/// The principal extractor the real server runs, holding one token for
/// the reporter.
async fn bearer_extractor() -> Arc<dyn PrincipalExtractor> {
    let now = Utc::now();
    let tokens = Arc::new(MemoryBearerTokenStore::new());
    let principal = reporter();
    tokens
        .create(BearerToken {
            id: "inbox-e2e".into(),
            token_hash: hash_bearer_token(RAW_TOKEN),
            name: "inbox e2e".into(),
            email: principal.email.clone(),
            display_name: principal.display_name.clone(),
            picture_url: None,
            created_at: now,
            last_used_at: None,
            expires_at: now + Duration::hours(1),
            revoked_at: None,
        })
        .await
        .unwrap();
    let mut config = AuthConfig::for_tests();
    config.mode = AuthMode::Google;
    Arc::new(DualCredentialExtractor::new(
        Arc::new(config),
        Arc::new(MemorySessionStore::new()) as Arc<dyn LoginSessionStore>,
        tokens as Arc<dyn BearerTokenStore>,
    ))
}

/// A bundle shaped like the page's, with `run_id` in its header and a
/// key order no re-serialization would reproduce, so a byte comparison
/// afterwards means something.
fn bundle(run_id: &str) -> String {
    format!(
        r#"{{"format":"lucida-trace-bundle","bundleVersion":1,"header":{{"runId":"{run_id}","zzz":"last","aaa":"first"}},"trace":{{"schemaVersion":2,"runs":[]}}}}"#
    )
}

async fn send_report(socket: &mut WsClient, bundle_json: &str) {
    let message = ClientMessage::SendReport {
        request_id: "cli-e2e-1".into(),
        bundle: bundle_json.to_string(),
    };
    socket
        .send(WsMessage::Text(
            serde_json::to_string(&message).unwrap().into(),
        ))
        .await
        .unwrap();
}

/// The server's answer to a **Send report**, skipping whatever else the
/// socket says on the way (a snapshot, a peer joining).
async fn await_receipt(socket: &mut WsClient) -> ServerMessage {
    loop {
        let frame = timeout(READ_TIMEOUT, socket.next())
            .await
            .expect("the server answers a report")
            .expect("the socket stays open")
            .unwrap();
        let WsMessage::Text(text) = frame else {
            continue;
        };
        match serde_json::from_str::<ServerMessage>(&text) {
            Ok(msg @ (ServerMessage::ReportSent { .. } | ServerMessage::ReportFailed { .. })) => {
                return msg;
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn a_sent_report_is_listed_and_fetched_back_byte_for_byte() {
    let rig = rig().await;
    let mut socket = rig.connect().await;
    // The server writes no row of its own: a workspace with a live
    // session in it has an empty inbox until somebody sends something.
    assert!(rig.list().await.is_empty());

    let sent = bundle("remote-cold");
    send_report(&mut socket, &sent).await;

    let ServerMessage::ReportSent {
        request_id,
        entry_id,
        expires_at,
    } = await_receipt(&mut socket).await
    else {
        panic!("the report was refused");
    };
    assert_eq!(request_id, "cli-e2e-1");
    assert!(!entry_id.is_empty(), "the sender is told where it landed");
    let expiry: DateTime<Utc> = expires_at.parse().expect("an RFC 3339 expiry");
    let kept_for = expiry - Utc::now();
    assert!(
        kept_for > Duration::days(RETENTION_DAYS) - Duration::minutes(1)
            && kept_for <= Duration::days(RETENTION_DAYS),
        "the sender is told the fixed retention, got {kept_for}",
    );

    // The listing: what the CLI prints, with the run's own header in it.
    let listed = rig.list().await;
    let [entry] = listed.as_slice() else {
        panic!("one report was sent, {} came back", listed.len());
    };
    assert_eq!(entry["id"], serde_json::json!(entry_id));
    assert_eq!(entry["sent_by"], serde_json::json!("reporter@example.com"));
    assert_eq!(entry["sent_by_name"], serde_json::json!("Reporter"));
    assert_eq!(entry["size_bytes"], serde_json::json!(sent.len()));
    assert_eq!(entry["header"]["runId"], serde_json::json!("remote-cold"));

    // The fetch: the file the CLI writes and `lucida trace show` reads.
    let fetched = rig.fetch(&entry_id).await;
    assert_eq!(fetched.status(), reqwest::StatusCode::OK);
    assert_eq!(
        fetched
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("application/json"),
    );
    // Byte for byte, field order and all: the inbox hands back what the
    // page produced rather than something it reassembled.
    assert_eq!(fetched.text().await.unwrap(), sent);
}

#[tokio::test]
async fn a_payload_that_is_not_a_bundle_is_refused_and_nothing_is_kept() {
    let rig = rig().await;
    let mut socket = rig.connect().await;
    send_report(&mut socket, r#"{"schemaVersion":2,"runs":[]}"#).await;

    let ServerMessage::ReportFailed { request_id, error } = await_receipt(&mut socket).await else {
        panic!("a saved run is not a bundle and should have been refused");
    };
    assert_eq!(request_id, "cli-e2e-1");
    assert!(
        error.contains("not a lucida trace bundle"),
        "the sender is told what was wrong, got {error}",
    );
    assert!(rig.list().await.is_empty(), "a refusal keeps nothing");
}

#[tokio::test]
async fn a_bundle_over_the_cap_is_refused_with_both_numbers() {
    let rig = rig().await;
    let mut socket = rig.connect().await;
    let padding = "x".repeat(MAX_BUNDLE_BYTES);
    send_report(
        &mut socket,
        &format!(
            r#"{{"format":"lucida-trace-bundle","header":{{"runId":"huge"}},"padding":"{padding}"}}"#
        ),
    )
    .await;

    let ServerMessage::ReportFailed { error, .. } = await_receipt(&mut socket).await else {
        panic!("a bundle over the cap should have been refused");
    };
    assert!(
        error.contains(&MAX_BUNDLE_BYTES.to_string()),
        "the sender is told the limit it passed, got {error}",
    );
    assert!(rig.list().await.is_empty(), "a refusal keeps nothing");
}

/// The inbox is the workspace's, and membership is what reaches it.
#[tokio::test]
async fn a_stranger_reads_no_inbox() {
    let rig = rig().await;
    let mut socket = rig.connect().await;
    send_report(&mut socket, &bundle("remote-cold")).await;
    let ServerMessage::ReportSent { entry_id, .. } = await_receipt(&mut socket).await else {
        panic!("the report was refused");
    };

    for path in [
        format!("/api/workspaces/{}/inbox", rig.workspace_id),
        format!("/api/workspaces/{}/inbox/{entry_id}", rig.workspace_id),
    ] {
        let response = reqwest::Client::new()
            .get(format!("{}{path}", rig.base_url()))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "{path} answered a caller with no credential",
        );
    }
}
