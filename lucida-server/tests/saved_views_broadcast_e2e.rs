//! Workspace saved-view lifecycle against the real REST and WebSocket routes.
//!
//! Saved views are workspace-scoped records, not a second global bookmark
//! store and not an unsequenced WebSocket message. The active socket proves
//! CRUD remains intentionally refetch-driven while the REST lifecycle uses the
//! same manager/store boundary as production.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::middleware::from_fn;
use futures_util::StreamExt;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::protocol::ServerMessage;
use lucida_core::saved_view::SavedView;
use lucida_server::DatasetRuntimeConfig;
use lucida_server::workspace::{SqliteWorkspaceStore, WorkspaceManager, WorkspaceStore};
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tower::ServiceExt;

type WsClient = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Rig {
    app: Router,
    addr: SocketAddr,
    workspace_id: String,
    _tmp: tempfile::TempDir,
}

fn principal() -> AuthPrincipal {
    AuthPrincipal {
        email: "saved-views@example.test".into(),
        display_name: "Saved Views Test".into(),
        picture_url: None,
        is_admin: false,
        auth_epoch: 0,
    }
}

async fn build_rig() -> Rig {
    let tmp = tempfile::tempdir().expect("tempdir");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(":memory:")
                .create_if_missing(true),
        )
        .await
        .expect("sqlite");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");
    let sqlite = Arc::new(SqliteWorkspaceStore::new(pool));
    let actor = principal();
    let workspace = sqlite
        .create_workspace(&actor, Some("Saved views workspace"))
        .await
        .expect("workspace");
    let mut runtime = DatasetRuntimeConfig::defaults();
    runtime.generated_cache_dir = tmp.path().join("generated-coarse");
    let store: Arc<dyn WorkspaceStore> = sqlite;
    let manager = Arc::new(WorkspaceManager::new(store, runtime));

    let injected = Arc::new(actor);
    let app = lucida_server::workspace::router(manager).layer(from_fn(
        move |mut request: Request<Body>, next: axum::middleware::Next| {
            let actor = Arc::clone(&injected);
            async move {
                request.extensions_mut().insert((*actor).clone());
                next.run(request).await
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("address");
    let server_app = app.clone();
    tokio::spawn(async move {
        axum::serve(listener, server_app).await.expect("serve");
    });

    Rig {
        app,
        addr,
        workspace_id: workspace.id,
        _tmp: tmp,
    }
}

async fn connect(rig: &Rig) -> WsClient {
    let url = format!("ws://{}/ws/workspaces/{}", rig.addr, rig.workspace_id);
    connect_async(url).await.expect("workspace websocket").0
}

async fn next_server_message(socket: &mut WsClient) -> ServerMessage {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .expect("server message timeout")
            .expect("stream ended")
            .expect("socket read");
        if let WsMessage::Text(text) = message {
            return serde_json::from_str(text.as_str()).expect("server message");
        }
    }
}

async fn assert_no_server_message(socket: &mut WsClient) {
    assert!(
        tokio::time::timeout(Duration::from_millis(200), socket.next())
            .await
            .is_err(),
        "saved-view CRUD must not emit the retired bookmark broadcast"
    );
}

async fn request_json(
    rig: &Rig,
    method: &str,
    uri: String,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(serde_json::to_vec(&value).unwrap())
        }
        None => Body::empty(),
    };
    let response = rig
        .app
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

#[tokio::test]
async fn workspace_saved_view_crud_is_scoped_and_refetch_driven() {
    let rig = build_rig().await;
    let mut socket = connect(&rig).await;
    let ServerMessage::Snapshot { seq: 0, .. } = next_server_message(&mut socket).await else {
        panic!("workspace socket must start with a snapshot");
    };
    let collection = format!("/api/workspaces/{}/saved-views", rig.workspace_id);
    let view = SavedView::empty([800, 600]);

    let (status, created) = request_json(
        &rig,
        "POST",
        collection.clone(),
        Some(json!({ "name": "Shared view", "view": view, "visibility": "shared" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["workspace_id"], rig.workspace_id);
    assert_eq!(created["name"], "Shared view");
    let saved_view_id = created["id"].as_str().expect("saved view id");
    assert_no_server_message(&mut socket).await;

    let item = format!("{collection}/{saved_view_id}");
    let (status, fetched) = request_json(&rig, "GET", item.clone(), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetched["id"], saved_view_id);

    let (status, updated) = request_json(
        &rig,
        "PATCH",
        item.clone(),
        Some(json!({ "name": "Renamed view" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "Renamed view");
    assert_no_server_message(&mut socket).await;

    let (status, _) = request_json(&rig, "DELETE", item.clone(), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = request_json(&rig, "GET", item, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_no_server_message(&mut socket).await;
}
