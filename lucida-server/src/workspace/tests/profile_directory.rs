//! The profile directory at the two places one person is shown to
//! another: peers in a live session, and the owner row a new workspace
//! records.
//!
//! ADR-0063 applies the directory in the auth middleware and nowhere
//! else, and argues that every consumer picks the enriched principal up
//! because each reads `AuthPrincipal` from request extensions. These
//! tests check that argument the way production is wired, with
//! `AuthMiddlewareState::build` over a mock listing in front of the real
//! workspace router. They run in `google` mode so that a principal
//! without a row has a name and picture of its own to keep.

use std::net::SocketAddr;

use axum::http::header;
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::*;
use crate::auth::LoginSession;
use crate::auth::config::DirectoryConfig;
use crate::auth::directory::test_support::spawn_mock_listing;
use crate::auth::middleware::{AuthMiddlewareState, auth_middleware};

struct Person {
    email: &'static str,
    session: &'static str,
    name: &'static str,
    picture: &'static str,
}

/// In the listing, under a full name whose first letter differs from
/// the sign-in name's, so the initial shows which name the server used.
const BILL: Person = Person {
    email: "bill@example.com",
    session: "bill-session",
    name: "Bill From Sign-In",
    picture: "https://sign-in.example/bill.png",
};

/// Not in the listing.
const CAROL: Person = Person {
    email: "carol@example.com",
    session: "carol-session",
    name: "Carol From Sign-In",
    picture: "https://sign-in.example/carol.png",
};

const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// One row, spelled with a capital and a trailing space to prove the
/// key is normalized on the way in.
fn listing() -> Value {
    json!([{
        "email": "Bill@Example.com ",
        "name": "William Example",
        "picture": "https://pictures.example/william.png",
    }])
}

fn cookie(person: &Person) -> String {
    format!("{}={}", AuthConfig::for_tests().cookie_name, person.session)
}

async fn fresh_manager() -> Arc<WorkspaceManager> {
    Arc::new(WorkspaceManager::new(
        Arc::new(fresh_store().await),
        ProxyConfig::defaults(),
    ))
}

/// The workspace router behind the middleware as production wires it,
/// with both people signed in. `google` mode needs no sign-in block
/// here, because the sessions are seeded and no request reaches the
/// sign-in flow.
async fn app_over(manager: Arc<WorkspaceManager>, directory: Option<DirectoryConfig>) -> Router {
    let mut config = AuthConfig::for_tests();
    config.mode = AuthMode::Google;
    config.directory = directory;

    let store = Arc::new(MemorySessionStore::new());
    let now = Utc::now();
    for person in [&BILL, &CAROL] {
        store
            .create(LoginSession {
                id: person.session.to_string(),
                email: person.email.to_string(),
                display_name: person.name.to_string(),
                picture_url: Some(person.picture.to_string()),
                created_at: now,
                last_used_at: now,
                expires_at: now + chrono::Duration::hours(24),
            })
            .await
            .unwrap();
    }
    let state = AuthMiddlewareState::build(
        Arc::new(config),
        store as Arc<dyn LoginSessionStore>,
        Arc::new(MemoryBearerTokenStore::new()) as Arc<dyn BearerTokenStore>,
    )
    .await
    .expect("google mode builds");
    router(manager).layer(axum::middleware::from_fn_with_state(state, auth_middleware))
}

async fn app_with_directory() -> Router {
    let (url, _mock) = spawn_mock_listing(listing()).await;
    app_over(
        fresh_manager().await,
        Some(DirectoryConfig::for_tests(&url)),
    )
    .await
}

// -- HTTP ---------------------------------------------------------------

async fn send_ok(app: &Router, request: Request<Body>) -> Value {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    assert!(
        status.is_success(),
        "{status}: {}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}

async fn get(app: &Router, person: &Person, uri: &str) -> Value {
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header(header::COOKIE, cookie(person))
        .body(Body::empty())
        .unwrap();
    send_ok(app, request).await
}

async fn post(app: &Router, person: &Person, uri: &str, body: Value) -> Value {
    let request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::COOKIE, cookie(person))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    send_ok(app, request).await
}

async fn create_workspace(app: &Router, person: &Person) -> String {
    let created = post(app, person, "/api/workspaces", json!({"name": "Shared"})).await;
    created["id"]
        .as_str()
        .expect("a workspace has an id")
        .to_string()
}

async fn add_member(
    app: &Router,
    owner: &Person,
    workspace_id: &str,
    member: &Person,
    display_name: Option<&str>,
) -> Value {
    post(
        app,
        owner,
        &format!("/api/workspaces/{workspace_id}/members"),
        json!({"email": member.email, "role": "editor", "display_name": display_name}),
    )
    .await
}

async fn members(app: &Router, owner: &Person, workspace_id: &str) -> Value {
    let sharing = get(
        app,
        owner,
        &format!("/api/workspaces/{workspace_id}/sharing"),
    )
    .await;
    sharing["members"].clone()
}

fn member_named(members: &Value, person: &Person) -> Value {
    members
        .as_array()
        .expect("members is a list")
        .iter()
        .find(|m| m["email"] == person.email)
        .unwrap_or_else(|| panic!("{} is not a member: {members}", person.email))
        .clone()
}

// -- WebSocket ------------------------------------------------------------

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Served {
    addr: SocketAddr,
    server: JoinHandle<()>,
    workspace_id: String,
}

impl Drop for Served {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Served {
    async fn join(&self, person: &Person) -> WsClient {
        let url = format!(
            "ws://{}/ws/workspaces/{}",
            self.addr,
            urlencoding::encode(&self.workspace_id)
        );
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert(header::COOKIE, cookie(person).parse().unwrap());
        let (socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        socket
    }

    /// Reads `first`'s snapshot before `second` connects, so `second`
    /// arrives as a join rather than inside `first`'s snapshot.
    async fn one_then_the_other(&self, first: &Person, second: &Person) -> (WsClient, WsClient) {
        let mut present = self.join(first).await;
        next_of_kind(&mut present, "snapshot").await;
        let arriving = self.join(second).await;
        (present, arriving)
    }
}

async fn shared_workspace(app: Router, owner: &Person, member: &Person) -> Served {
    let workspace_id = create_workspace(&app, owner).await;
    add_member(&app, owner, &workspace_id, member, None).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Served {
        addr,
        server,
        workspace_id,
    }
}

async fn next_of_kind(ws: &mut WsClient, kind: &str) -> (String, Value) {
    loop {
        let frame = timeout(READ_TIMEOUT, ws.next())
            .await
            .unwrap_or_else(|_| panic!("no {kind} within {READ_TIMEOUT:?}"))
            .expect("the socket is open")
            .expect("the frame reads");
        let WsMessage::Text(text) = frame else {
            continue;
        };
        let decoded: Value = serde_json::from_str(&text).expect("server messages are JSON");
        if decoded["type"] == kind {
            return (text.to_string(), decoded);
        }
    }
}

// -- Peers in a live session -------------------------------------------

#[tokio::test]
async fn a_peer_with_a_row_joins_under_the_directory_name_and_picture() {
    let served = shared_workspace(app_with_directory().await, &CAROL, &BILL).await;
    let (mut carol, _bill) = served.one_then_the_other(&CAROL, &BILL).await;

    let (_, joined) = next_of_kind(&mut carol, "peer_joined").await;
    let identity = &joined["presence"]["identity"];
    assert_eq!(identity["display_name"], "William Example");
    assert_eq!(
        identity["picture_url"],
        "https://pictures.example/william.png"
    );
    assert_eq!(
        identity["initial"], "W",
        "the initial of the directory name"
    );
}

#[tokio::test]
async fn a_peer_without_a_row_joins_under_the_values_the_mode_resolved() {
    let served = shared_workspace(app_with_directory().await, &BILL, &CAROL).await;
    let (mut bill, _carol) = served.one_then_the_other(&BILL, &CAROL).await;

    let (_, joined) = next_of_kind(&mut bill, "peer_joined").await;
    let identity = &joined["presence"]["identity"];
    assert_eq!(identity["display_name"], CAROL.name);
    assert_eq!(identity["picture_url"], CAROL.picture);
    assert_eq!(identity["initial"], "C");
}

#[tokio::test]
async fn what_peers_receive_carries_no_email_and_the_same_fields_as_before() {
    let served = shared_workspace(app_with_directory().await, &CAROL, &BILL).await;
    let (mut carol, mut bill) = served.one_then_the_other(&CAROL, &BILL).await;

    let (joined_text, joined) = next_of_kind(&mut carol, "peer_joined").await;
    let (snapshot_text, snapshot) = next_of_kind(&mut bill, "snapshot").await;
    for text in [&joined_text, &snapshot_text] {
        assert!(
            !text.contains("@example.com"),
            "an address crossed the wire: {text}"
        );
    }

    let identity_fields = |identity: &Value| -> Vec<String> {
        identity
            .as_object()
            .unwrap_or_else(|| panic!("identity is an object: {identity}"))
            .keys()
            .cloned()
            .collect()
    };
    assert_eq!(
        identity_fields(&joined["presence"]["identity"]),
        ["display_name", "initial", "picture_url"]
    );
    let peers = snapshot["peers"].as_array().expect("peers is a list");
    assert_eq!(peers.len(), 2);
    for peer in peers {
        assert_eq!(
            identity_fields(&peer["identity"]),
            ["display_name", "initial", "picture_url"]
        );
    }
}

// -- Members and creators ------------------------------------------------

#[tokio::test]
async fn created_by_on_a_new_workspace_is_the_principals_email() {
    let app = app_with_directory().await;

    let created = post(&app, &BILL, "/api/workspaces", json!({"name": "Shared"})).await;
    assert_eq!(created["created_by"], BILL.email);

    let uri = format!("/api/workspaces/{}", created["id"].as_str().unwrap());
    let fetched = get(&app, &BILL, &uri).await;
    assert_eq!(fetched["created_by"], BILL.email);
}

/// The owner row is the one member row taken from a principal, so it is
/// where the directory's name reaches the member list.
#[tokio::test]
async fn the_owner_row_a_new_workspace_adds_carries_the_directory_name() {
    let app = app_with_directory().await;

    let workspace_id = create_workspace(&app, &BILL).await;
    let owner = member_named(&members(&app, &BILL, &workspace_id).await, &BILL);
    assert_eq!(owner["role"], "owner");
    assert_eq!(owner["display_name"], "William Example");

    let copy = post(
        &app,
        &BILL,
        &format!("/api/workspaces/{workspace_id}/duplicate"),
        json!({}),
    )
    .await;
    let copy_id = copy["id"].as_str().expect("a copy has an id");
    let owner = member_named(&members(&app, &BILL, copy_id).await, &BILL);
    assert_eq!(owner["display_name"], "William Example");
}

/// The directory enriches the principal at the middleware and nowhere
/// else, so nothing looks up an address a request body names, whatever
/// the listing says about them.
#[tokio::test]
async fn adding_a_member_by_email_records_the_name_the_request_carries() {
    let app = app_with_directory().await;
    let workspace_id = create_workspace(&app, &CAROL).await;

    let added = add_member(&app, &CAROL, &workspace_id, &BILL, None).await;
    assert_eq!(added["display_name"], BILL.email);

    let renamed = add_member(&app, &CAROL, &workspace_id, &BILL, Some("Bill As Typed")).await;
    assert_eq!(renamed["display_name"], "Bill As Typed");
}

#[tokio::test]
async fn rows_written_before_the_directory_turned_on_are_unchanged_after_it_does() {
    let manager = fresh_manager().await;
    let before = app_over(Arc::clone(&manager), None).await;
    let workspace_id = create_workspace(&before, &BILL).await;
    add_member(
        &before,
        &BILL,
        &workspace_id,
        &CAROL,
        Some("Carol As Typed"),
    )
    .await;
    let uri = format!("/api/workspaces/{workspace_id}");
    let workspace_before = get(&before, &BILL, &uri).await;
    let members_before = members(&before, &BILL, &workspace_id).await;
    assert_eq!(
        member_named(&members_before, &BILL)["display_name"],
        BILL.name
    );

    let (url, _mock) = spawn_mock_listing(listing()).await;
    let after = app_over(manager, Some(DirectoryConfig::for_tests(&url))).await;
    let workspace_after = get(&after, &BILL, &uri).await;
    for field in ["name", "created_by"] {
        assert_eq!(workspace_after[field], workspace_before[field], "{field}");
    }
    assert_eq!(members(&after, &BILL, &workspace_id).await, members_before);

    let later = create_workspace(&after, &BILL).await;
    assert_eq!(
        member_named(&members(&after, &BILL, &later).await, &BILL)["display_name"],
        "William Example",
        "the directory is on: only rows written from now on carry its name",
    );
}
