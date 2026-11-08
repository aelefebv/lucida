//! The live document and the stored one move together: a command reaches
//! memory and peers only after the database took it.

use lucida_content::{LayoutId, LayoutSpec};
use serde_json::Value;

use crate::connection::CLOSE_WORKSPACE_RELOADED;

use super::*;

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

fn layout_names(document: &DocumentState, dataset_id: &DatasetId) -> Vec<String> {
    document
        .registered_layouts
        .get(dataset_id)
        .map(|layouts| layouts.iter().map(|layout| layout.name.clone()).collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn a_refused_write_leaves_memory_and_the_database_at_one_seq() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "layer.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), GeneratedConfig::defaults());
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), GeneratedConfig::defaults());
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
        GeneratedConfig::defaults(),
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
        GeneratedConfig::defaults(),
    ));
    let (url, server) = serve_workspace_socket(manager, owner.clone(), &workspace_id).await;
    let mut socket = connect_socket(&url).await;

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

/// Another server process on the same database, or the live workspace an
/// eviction put in this one's place, writes the workspace from its own
/// memory. Both start from the same stored seq.
async fn two_writers_on_one_workspace(
    store: &SqliteWorkspaceStore,
    owner: &AuthPrincipal,
) -> (WorkspaceManager, WorkspaceManager, String, DatasetId) {
    let (workspace_id, wds_id) = seed_workspace_with_dataset(store, owner, "layer.zarr").await;
    let here = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    let elsewhere = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    (here, elsewhere, workspace_id, wds_id)
}

async fn write_elsewhere(
    elsewhere: &WorkspaceManager,
    workspace_id: &str,
    owner: &AuthPrincipal,
    wds_id: &DatasetId,
) {
    let other = elsewhere.live_workspace(workspace_id, owner).await.unwrap();
    elsewhere
        .apply_document_command(&other, owner, 1, register_layout(wds_id, "elsewhere"))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_stale_write_retires_the_live_workspace_so_the_next_socket_loads_it_fresh() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (here, elsewhere, workspace_id, wds_id) =
        two_writers_on_one_workspace(&store, &owner).await;
    let live = here.live_workspace(&workspace_id, &owner).await.unwrap();
    let sender = attach(&here, &live, 1, &owner).await;
    let peer = attach(&here, &live, 2, &owner).await;
    write_elsewhere(&elsewhere, &workspace_id, &owner, &wds_id).await;

    let err = here
        .apply_document_command(&live, &owner, 1, register_layout(&wds_id, "here"))
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            CommandApplyError::PersistFailed(WorkspaceError::Store(StoreError::StaleDocument(2)))
        ),
        "got {err:?}"
    );

    assert!(!here.live.lock().await.contains_key(&workspace_id));
    let told = sender.close_signal().current().expect("the sender closes");
    assert_eq!(told.frame.code, CLOSE_WORKSPACE_RELOADED);
    assert_eq!(
        serde_json::from_str::<Value>(&told.notice.unwrap()).unwrap(),
        json!({ "type": "command_rejected", "reason": "unavailable" }),
    );
    let peer_close = peer.close_signal().current().expect("the peer closes");
    assert_eq!(peer_close.frame.code, CLOSE_WORKSPACE_RELOADED);
    assert!(
        peer_close.notice.is_none(),
        "the peer sent nothing to refuse"
    );

    // No eviction needed: the next socket gets the stored document, and
    // its writes land.
    let fresh = here.live_workspace(&workspace_id, &owner).await.unwrap();
    assert!(!Arc::ptr_eq(&fresh, &live));
    {
        let sess = fresh.session.lock().await;
        assert_eq!(sess.seq, 2);
        assert_eq!(layout_names(&sess.document, &wds_id), ["elsewhere"]);
    }
    let seq = here
        .apply_document_command(&fresh, &owner, 1, register_layout(&wds_id, "here"))
        .await
        .unwrap();
    assert_eq!(seq, 3);
}

#[tokio::test]
async fn a_stale_rename_retires_the_live_workspace_too() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (here, elsewhere, workspace_id, wds_id) =
        two_writers_on_one_workspace(&store, &owner).await;
    let live = here.live_workspace(&workspace_id, &owner).await.unwrap();
    let sender = attach(&here, &live, 1, &owner).await;
    write_elsewhere(&elsewhere, &workspace_id, &owner, &wds_id).await;

    let err = here
        .rename_dataset(&live, &owner, 1, &wds_id, "Renamed")
        .await
        .unwrap_err();
    assert!(
        matches!(err, WorkspaceError::Store(StoreError::StaleDocument(2))),
        "got {err:?}"
    );
    assert!(!here.live.lock().await.contains_key(&workspace_id));
    let told = sender.close_signal().current().expect("the sender closes");
    assert_eq!(told.frame.code, CLOSE_WORKSPACE_RELOADED);
    assert!(told.notice.is_some());
}

/// Retiring a live workspace that an eviction already replaced leaves the
/// replacement alone: only the retired one's sockets close.
#[tokio::test]
async fn retiring_a_replaced_live_workspace_leaves_its_replacement_serving() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "layer.zarr").await;
    let manager = WorkspaceManager::new_with_runtime_config(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
        idle_eviction_config(),
    );
    let replaced = manager.live_workspace(&workspace_id, &owner).await.unwrap();
    assert_eq!(manager.evict_idle_workspaces().await, 1);
    let current = manager.live_workspace(&workspace_id, &owner).await.unwrap();
    let on_current = attach(&manager, &current, 1, &owner).await;
    let on_replaced = attach(&manager, &replaced, 2, &owner).await;
    manager
        .apply_document_command(&current, &owner, 1, register_layout(&wds_id, "current"))
        .await
        .unwrap();

    manager
        .apply_document_command(&replaced, &owner, 2, register_layout(&wds_id, "replaced"))
        .await
        .unwrap_err();

    assert!(on_replaced.close_requested());
    assert!(!on_current.close_requested());
    let serving = manager.live.lock().await.get(&workspace_id).cloned();
    assert!(serving.is_some_and(|serving| Arc::ptr_eq(&serving, &current)));
}

#[tokio::test]
async fn a_socket_whose_write_was_stale_hears_why_and_reconnects_to_the_stored_document() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (here, elsewhere, workspace_id, wds_id) =
        two_writers_on_one_workspace(&store, &owner).await;
    let (url, server) = serve_workspace_socket(Arc::new(here), owner.clone(), &workspace_id).await;
    let mut socket = connect_socket(&url).await;
    assert_eq!(next_text(&mut socket).await["type"], "snapshot");
    write_elsewhere(&elsewhere, &workspace_id, &owner, &wds_id).await;

    send_command(&mut socket, register_layout(&wds_id, "here")).await;
    assert_eq!(
        next_text(&mut socket).await,
        json!({ "type": "command_rejected", "reason": "unavailable" }),
    );
    assert_eq!(next_close_code(&mut socket).await, CLOSE_WORKSPACE_RELOADED);

    let mut socket = connect_socket(&url).await;
    let snapshot = next_text(&mut socket).await;
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(snapshot["seq"], 2);
    send_command(&mut socket, register_layout(&wds_id, "here")).await;
    assert_eq!(
        next_text(&mut socket).await,
        json!({ "type": "ack", "seq": 3 })
    );

    server.abort();
}
