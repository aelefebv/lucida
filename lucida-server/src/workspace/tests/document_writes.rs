//! The live document and the stored one move together: a command reaches
//! memory and peers only after the database took it.

use futures_util::{SinkExt, StreamExt};
use lucida_content::{LayoutId, LayoutSpec};
use lucida_core::protocol::ClientMessage;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::*;

const READ_TIMEOUT: Duration = Duration::from_secs(5);

fn register_layout(dataset_id: &DatasetId, name: &str) -> DocumentCommand {
    DocumentCommand::RegisterLayout {
        dataset_id: dataset_id.clone(),
        layout: LayoutSpec {
            id: LayoutId(format!("layout-{name}")),
            name: name.to_string(),
            placements: vec![],
        },
    }
}

/// Make every document write fail while role lookups keep working, the
/// way a full disk or a dropped write connection would.
async fn refuse_document_writes(pool: &sqlx::sqlite::SqlitePool) {
    sqlx::query(
        "CREATE TRIGGER refuse_document_writes BEFORE UPDATE OF document_json ON workspaces \
         BEGIN SELECT RAISE(ABORT, 'document writes refused'); END",
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn allow_document_writes(pool: &sqlx::sqlite::SqlitePool) {
    sqlx::query("DROP TRIGGER refuse_document_writes")
        .execute(pool)
        .await
        .unwrap();
}

fn as_json(document: &DocumentState) -> Value {
    serde_json::to_value(document).unwrap()
}

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn send_command(socket: &mut WsClient, command: DocumentCommand) {
    let message = serde_json::to_string(&ClientMessage::Command { command }).unwrap();
    socket.send(WsMessage::Text(message.into())).await.unwrap();
}

async fn next_text(socket: &mut WsClient) -> Value {
    loop {
        let frame = timeout(READ_TIMEOUT, socket.next())
            .await
            .expect("the server answers")
            .expect("the socket is open")
            .expect("the frame reads");
        if let WsMessage::Text(text) = frame {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

#[tokio::test]
async fn a_refused_write_leaves_memory_and_the_database_at_one_seq() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "layer.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();
    let mut peer = live.tx.subscribe();

    refuse_document_writes(&pool).await;
    let err = manager
        .apply_document_command(&live, &owner, 1, register_layout(&wds_id, "refused"))
        .await
        .unwrap_err();
    assert!(
        matches!(err, CommandApplyError::PersistFailed(_)),
        "got {err:?}"
    );

    let stored = store.get_workspace(&workspace_id).await.unwrap().unwrap();
    {
        let sess = live.session.lock().await;
        assert_eq!(sess.seq, 1);
        assert_eq!(stored.seq, sess.seq);
        assert_eq!(as_json(&stored.document), as_json(&sess.document));
        assert!(sess.document.registered_layouts.is_empty());
    }
    assert!(peer.try_recv().is_err(), "no peer heard of the command");

    // The refused command never took a seq, so the next one gets the seq
    // it would have had.
    allow_document_writes(&pool).await;
    let seq = manager
        .apply_document_command(&live, &owner, 1, register_layout(&wds_id, "accepted"))
        .await
        .unwrap();
    assert_eq!(seq, 2);
    assert_eq!(
        store
            .get_workspace(&workspace_id)
            .await
            .unwrap()
            .unwrap()
            .seq,
        2
    );
}

#[tokio::test]
async fn a_refused_rename_leaves_the_name_in_memory_and_the_database() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "layer.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    refuse_document_writes(&pool).await;
    let err = manager
        .rename_dataset(&live, &owner, 1, &wds_id, "Renamed")
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Store(_)), "got {err:?}");

    let sess = live.session.lock().await;
    assert_eq!(sess.seq, 1);
    assert_eq!(sess.document.manifests[&wds_id].name, "layer.zarr");
    let stored = store.get_workspace(&workspace_id).await.unwrap().unwrap();
    assert_eq!(stored.seq, 1);
    assert_eq!(stored.document.manifests[&wds_id].name, "layer.zarr");
}

/// Two editors' commands interleave freely on the way in. However the
/// database writes would have raced, the stored document ends at the
/// highest seq and equals the live one, and peers hear every seq once, in
/// order. The database is a file so its pool hands out several connections
/// and writes can genuinely reach it out of order.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn commands_from_two_clients_leave_the_database_at_the_highest_seq() {
    const PER_CLIENT: usize = 25;

    let dir = tempfile::tempdir().unwrap();
    let url = crate::storage::DatabaseUrl::parse(&format!(
        "sqlite://{}",
        dir.path().join("lucida.db").display()
    ))
    .unwrap();
    let backend = crate::storage::SqliteStorageBackend::open(&url)
        .await
        .unwrap();
    let store = SqliteWorkspaceStore::new(backend.pool().clone());
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "layer.zarr").await;
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
    ));
    manager
        .upsert_member(
            &workspace_id,
            &owner,
            &editor.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();
    let mut peer = live.tx.subscribe();

    let mut tasks = Vec::new();
    for (client, who) in [(1, owner.clone()), (2, editor.clone())] {
        for n in 0..PER_CLIENT {
            let manager = Arc::clone(&manager);
            let live = Arc::clone(&live);
            let who = who.clone();
            let command = register_layout(&wds_id, &format!("{client}-{n}"));
            tasks.push(tokio::spawn(async move {
                manager
                    .apply_document_command(&live, &who, client, command)
                    .await
                    .unwrap()
            }));
        }
    }
    for task in tasks {
        task.await.unwrap();
    }

    let highest = 1 + 2 * PER_CLIENT as u64;
    let stored = store.get_workspace(&workspace_id).await.unwrap().unwrap();
    {
        let sess = live.session.lock().await;
        assert_eq!(sess.seq, highest);
        assert_eq!(stored.seq, highest);
        assert_eq!(as_json(&stored.document), as_json(&sess.document));
        assert_eq!(
            sess.document.registered_layouts[&wds_id].len(),
            2 * PER_CLIENT
        );
    }

    let mut heard = Vec::new();
    while let Ok(item) = peer.try_recv() {
        if let BroadcastItem::CommandBroadcast { broadcast_json, .. } = item {
            let message: Value = serde_json::from_str(&broadcast_json).unwrap();
            heard.push(message["seq"].as_u64().unwrap());
        }
    }
    assert_eq!(heard, (2..=highest).collect::<Vec<_>>());
}

#[tokio::test]
async fn a_refused_command_tells_its_sender_why() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "layer.zarr").await;
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
    ));
    let app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let url = format!(
        "ws://{addr}/ws/workspaces/{}",
        urlencoding::encode(&workspace_id)
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(url.into_client_request().unwrap())
        .await
        .unwrap();

    assert_eq!(next_text(&mut socket).await["type"], "snapshot");

    refuse_document_writes(&pool).await;
    send_command(&mut socket, register_layout(&wds_id, "refused")).await;
    assert_eq!(
        next_text(&mut socket).await,
        json!({ "type": "command_rejected", "reason": "unavailable" }),
    );

    allow_document_writes(&pool).await;
    send_command(&mut socket, register_layout(&wds_id, "accepted")).await;
    assert_eq!(
        next_text(&mut socket).await,
        json!({ "type": "ack", "seq": 2 })
    );

    server.abort();
}
