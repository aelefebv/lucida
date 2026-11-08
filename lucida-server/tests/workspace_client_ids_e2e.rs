//! Connections in different workspaces of one server get different ids.
//!
//! Source reads are shared out per client id across the whole process, so a
//! repeated id across workspaces would charge two clients as one reader.

use std::sync::Arc;

use futures_util::StreamExt;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use lucida_core::protocol::{ClientId, ServerMessage};
use lucida_server::ProxyConfig;
use lucida_server::auth::dev::default_dev_principal;
use lucida_server::auth::principal::StubPrincipalExtractor;
use lucida_server::auth::{AuthConfig, PrincipalExtractor};
use lucida_server::storage::{self, DatabaseUrl};
use lucida_server::workspace::WorkspaceManager;

const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

async fn joined_as(address: std::net::SocketAddr, workspace_id: &str) -> ClientId {
    let url = format!(
        "ws://{address}/ws/workspaces/{}",
        urlencoding::encode(workspace_id)
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    loop {
        let frame = timeout(READ_TIMEOUT, socket.next())
            .await
            .expect("snapshot before the timeout")
            .expect("socket open")
            .unwrap();
        if let WsMessage::Text(text) = frame
            && let Ok(ServerMessage::Snapshot { your_id, .. }) = serde_json::from_str(&text)
        {
            return your_id;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_clients_of_two_workspaces_get_different_ids() {
    let storage = storage::open(&DatabaseUrl::in_memory()).await.unwrap();
    let owner = default_dev_principal();
    let first = storage
        .workspaces()
        .create_workspace(&owner, Some("First"))
        .await
        .unwrap();
    let second = storage
        .workspaces()
        .create_workspace(&owner, Some("Second"))
        .await
        .unwrap();

    let manager = Arc::new(WorkspaceManager::new(
        storage.workspaces(),
        ProxyConfig::defaults(),
    ));
    let extractor: Arc<dyn PrincipalExtractor> = Arc::new(StubPrincipalExtractor::new(Arc::new(
        AuthConfig::for_tests(),
    )));
    let app =
        lucida_server::workspace::router(manager).layer(axum::middleware::from_fn_with_state(
            extractor,
            lucida_server::auth::middleware::auth_middleware,
        ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let in_first = joined_as(address, &first.id).await;
    let in_second = joined_as(address, &second.id).await;
    assert_ne!(
        in_first, in_second,
        "each workspace's first client must not share an id"
    );

    server.abort();
}
