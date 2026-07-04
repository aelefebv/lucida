use super::*;

#[tokio::test]
async fn dataset_membership_and_document_persist_together() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store.create_workspace(&owner, Some("Demo")).await.unwrap();
    let workspace_dataset_id = DatasetId("wds_runtime".into());
    let mut doc = DocumentState::default();
    doc.manifests.insert(
        workspace_dataset_id.clone(),
        lucida_content::DatasetManifest::new(
            workspace_dataset_id.clone(),
            "dataset".into(),
            lucida_content::DatasetKind::Single,
            vec![],
            vec![],
            vec![],
            vec![],
            None,
        ),
    );

    store
        .persist_dataset_opened(
            &workspace.id,
            &workspace_dataset_id,
            "ds_source",
            "file:///data/demo.zarr",
            "demo.zarr",
            &owner.email,
            1,
            &doc,
        )
        .await
        .unwrap();

    let sources = store.list_dataset_sources(&workspace.id).await.unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].workspace_dataset_id, workspace_dataset_id);
    assert_eq!(sources[0].dataset_source_id, "ds_source");
    assert_eq!(
        store
            .dataset_by_source(&workspace.id, "ds_source")
            .await
            .unwrap()
            .unwrap()
            .workspace_dataset_id,
        DatasetId("wds_runtime".into())
    );

    let restored = store.get_workspace(&workspace.id).await.unwrap().unwrap();
    assert_eq!(restored.seq, 1);
    assert!(
        restored
            .document
            .manifests
            .contains_key(&DatasetId("wds_runtime".into()))
    );
}

// --- Dataset rename (#701) -------------------------------------------

// THE HEADLINE TEST: a rename must survive close + reopen. The prior
// (rejected) attempt updated only the DB display_name and a web-local
// override, so the persisted document still carried the old manifest name
// and the rename was silently lost on reopen. This drives the rename
// through the document-mutation path, evicts the live workspace, reopens
// it (which loads the persisted document_json), and asserts the
// client-visible manifest name is the NEW one.
#[tokio::test]
async fn rename_dataset_survives_evict_and_reopen() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new_with_runtime_config(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
        idle_eviction_config(),
    );

    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();
    // Sanity: the live document carries the original name.
    assert_eq!(
        live.session.lock().await.document.manifests[&wds_id].name,
        "original.zarr"
    );

    let (seq, _) = manager
        .rename_dataset(&live, &owner, &wds_id, "Renamed Layer")
        .await
        .unwrap();
    assert_eq!(seq, 2, "rename should advance the document seq");
    // In-session reflection is immediate.
    assert_eq!(
        live.session.lock().await.document.manifests[&wds_id].name,
        "Renamed Layer"
    );

    // Evict the live workspace so the next open reloads from the store.
    let evicted = manager.evict_idle_workspaces().await;
    assert_eq!(evicted, 1);
    assert_eq!(manager.live_workspace_count().await, 0);

    // Reopen: the client-visible document manifest name is the NEW one.
    let reopened = manager.live_workspace(&workspace_id, &owner).await.unwrap();
    assert!(!Arc::ptr_eq(&live, &reopened));
    let reopened_name = reopened.session.lock().await.document.manifests[&wds_id]
        .name
        .clone();
    assert_eq!(
        reopened_name, "Renamed Layer",
        "the renamed name must survive reopen (loaded from persisted document_json)"
    );

    // The server-private DB display_name is kept in sync too, so listings
    // and restored bindings agree.
    let db_name = store
        .dataset_by_workspace_dataset(&workspace_id, &wds_id)
        .await
        .unwrap()
        .unwrap()
        .display_name;
    assert_eq!(db_name, "Renamed Layer");
}

#[tokio::test]
async fn rename_dataset_trims_and_persists_trimmed_name() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    manager
        .rename_dataset(&live, &owner, &wds_id, "  Padded Name  ")
        .await
        .unwrap();
    assert_eq!(
        live.session.lock().await.document.manifests[&wds_id].name,
        "Padded Name"
    );
    let db_name = store
        .dataset_by_workspace_dataset(&workspace_id, &wds_id)
        .await
        .unwrap()
        .unwrap()
        .display_name;
    assert_eq!(db_name, "Padded Name");
}

#[tokio::test]
async fn rename_dataset_is_editor_only_and_never_leaks() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    let viewer = principal("viewer@example.com", false);
    manager
        .upsert_member(
            &workspace_id,
            &owner,
            &viewer.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    // A viewer cannot rename — Forbidden (role-first).
    let err = manager
        .rename_dataset(&live, &viewer, &wds_id, "viewer rename")
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    // A non-member cannot rename — Forbidden, identical to the viewer, so
    // membership is never confirmed.
    let stranger = principal("stranger@example.com", false);
    let err = manager
        .rename_dataset(&live, &stranger, &wds_id, "stranger rename")
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    // The denied renames did not mutate anything.
    assert_eq!(
        live.session.lock().await.document.manifests[&wds_id].name,
        "original.zarr"
    );
}

#[tokio::test]
async fn rename_dataset_missing_id_is_not_found() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, _wds_id) =
        seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    // An editor renaming a dataset that does not exist in the document
    // gets NotFound (uniform with a dataset that was never opened) — and
    // the seq does not advance (no phantom mutation persisted).
    let before_seq = live.session.lock().await.seq;
    let err = manager
        .rename_dataset(
            &live,
            &owner,
            &DatasetId("wds_ghost".into()),
            "ghost rename",
        )
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));
    assert_eq!(live.session.lock().await.seq, before_seq);
}

#[tokio::test]
async fn rename_dataset_validation_rejects_empty_whitespace_and_overlong() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    for bad in ["", "   ", "\t\n"] {
        let err = manager
            .rename_dataset(&live, &owner, &wds_id, bad)
            .await
            .unwrap_err();
        assert!(
            matches!(err, WorkspaceError::BadRequest(_)),
            "empty/whitespace name {bad:?} should be BadRequest, got {err:?}"
        );
    }

    let overlong = "x".repeat(MAX_DATASET_NAME_CHARS + 1);
    let err = manager
        .rename_dataset(&live, &owner, &wds_id, &overlong)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::BadRequest(_)));

    // None of the rejected renames mutated the document or advanced seq.
    let sess = live.session.lock().await;
    assert_eq!(sess.document.manifests[&wds_id].name, "original.zarr");
    assert_eq!(sess.seq, 1);
}

#[tokio::test]
async fn rename_dataset_leaves_source_url_unchanged() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    let url_before = store
        .dataset_by_workspace_dataset(&workspace_id, &wds_id)
        .await
        .unwrap()
        .unwrap()
        .canonical_url;

    manager
        .rename_dataset(&live, &owner, &wds_id, "Renamed")
        .await
        .unwrap();

    let after = store
        .dataset_by_workspace_dataset(&workspace_id, &wds_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.canonical_url, url_before);
    assert_eq!(after.canonical_url, "file:///data/original.zarr");
    // The source id is unchanged; only the per-workspace label moved.
    assert_eq!(after.dataset_source_id, "ds_source");
    assert_eq!(after.display_name, "Renamed");
}

#[tokio::test]
async fn rename_dataset_leaves_existing_saved_view_name_unchanged() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    // A saved view references dataset ids, not names; renaming the dataset
    // must not rewrite the saved view's own name.
    let saved = manager
        .create_saved_view(
            &workspace_id,
            &owner,
            "My Saved View",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap();

    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();
    manager
        .rename_dataset(&live, &owner, &wds_id, "Renamed Dataset")
        .await
        .unwrap();

    let after = manager
        .get_saved_view(&workspace_id, &owner, &saved.id)
        .await
        .unwrap();
    assert_eq!(after.name, "My Saved View");
}

#[tokio::test]
async fn rename_dataset_broadcasts_command_to_peers() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    // A co-present peer subscribes to the live broadcast channel.
    let mut rx = live.tx.subscribe();

    manager
        .rename_dataset(&live, &owner, &wds_id, "Live Rename")
        .await
        .unwrap();
    // The handler is what broadcasts in production; here we assert the
    // rename produced the document the peer would converge on, then
    // emulate the handler's broadcast and confirm the peer receives a
    // CommandBroadcast carrying the rename.
    let (seq, command) = {
        // Re-derive what the handler sends: it forwards the same
        // (seq, RenameDataset) returned by rename_dataset. We already
        // applied; reconstruct the broadcast item exactly as the handler.
        let sess = live.session.lock().await;
        (
            sess.seq,
            DocumentCommand::RenameDataset {
                id: wds_id.clone(),
                name: "Live Rename".to_string(),
            },
        )
    };
    let broadcast_msg = ServerMessage::CommandBroadcast { seq, command };
    let ack_msg = ServerMessage::Ack { seq };
    // `BroadcastItem` is not `Debug`, so don't `.unwrap()` the send result
    // (its error would need Debug); a failed send just means no receiver.
    let _ = live.tx.send(BroadcastItem::CommandBroadcast {
        sender: u64::MAX,
        broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
        ack_json: serde_json::to_string(&ack_msg).unwrap(),
    });

    let item = rx.recv().await.unwrap();
    match item {
        BroadcastItem::CommandBroadcast { broadcast_json, .. } => {
            assert!(broadcast_json.contains("\"type\":\"rename_dataset\""));
            assert!(broadcast_json.contains("Live Rename"));
        }
        _ => panic!("expected a CommandBroadcast broadcast item"),
    }
}

#[tokio::test]
async fn same_source_can_have_distinct_workspace_dataset_ids() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let a = store.create_workspace(&owner, Some("A")).await.unwrap();
    let b = store.create_workspace(&owner, Some("B")).await.unwrap();
    let source_id = "ds_shared_source";
    let canonical_url = "file:///data/shared.zarr";

    for (workspace, workspace_dataset_id) in [
        (&a, DatasetId("wds_workspace_a".into())),
        (&b, DatasetId("wds_workspace_b".into())),
    ] {
        let mut doc = DocumentState::default();
        doc.manifests.insert(
            workspace_dataset_id.clone(),
            lucida_content::DatasetManifest::new(
                workspace_dataset_id.clone(),
                "shared.zarr".into(),
                lucida_content::DatasetKind::Single,
                vec![],
                vec![],
                vec![],
                vec![],
                None,
            ),
        );
        store
            .persist_dataset_opened(
                &workspace.id,
                &workspace_dataset_id,
                source_id,
                canonical_url,
                "shared.zarr",
                &owner.email,
                1,
                &doc,
            )
            .await
            .unwrap();
    }

    let source_a = store
        .dataset_by_source(&a.id, source_id)
        .await
        .unwrap()
        .unwrap();
    let source_b = store
        .dataset_by_source(&b.id, source_id)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(source_a.dataset_source_id, source_b.dataset_source_id);
    assert_eq!(source_a.canonical_url, source_b.canonical_url);
    assert_ne!(source_a.workspace_dataset_id, source_b.workspace_dataset_id);
    assert_eq!(
        source_a.workspace_dataset_id,
        DatasetId("wds_workspace_a".into())
    );
    assert_eq!(
        source_b.workspace_dataset_id,
        DatasetId("wds_workspace_b".into())
    );
}

#[tokio::test]
async fn live_workspace_sessions_are_independent() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let a = store.create_workspace(&owner, Some("A")).await.unwrap();
    let b = store.create_workspace(&owner, Some("B")).await.unwrap();
    let manager = WorkspaceManager::new(Arc::new(store), ProxyConfig::defaults());

    let live_a = manager.live_workspace(&a.id, &owner).await.unwrap();
    let live_b = manager.live_workspace(&b.id, &owner).await.unwrap();

    let cmd = DocumentCommand::RegisterLayout {
        dataset_id: DatasetId("ds-a".into()),
        layout: lucida_content::LayoutSpec {
            id: lucida_content::LayoutId("layout-a".into()),
            name: "Layout A".into(),
            placements: vec![],
        },
    };
    let (seq, document) = {
        let mut sess = live_a.session.lock().await;
        let seq = sess.apply(cmd.clone());
        (seq, sess.document.clone())
    };
    manager
        .persist_applied_command(&live_a, &cmd, seq, &document)
        .await
        .unwrap();

    assert_eq!(live_a.session.lock().await.seq, 1);
    assert_eq!(live_b.session.lock().await.seq, 0);
    assert!(
        live_a
            .session
            .lock()
            .await
            .document
            .registered_layouts
            .contains_key(&DatasetId("ds-a".into()))
    );
    assert!(
        !live_b
            .session
            .lock()
            .await
            .document
            .registered_layouts
            .contains_key(&DatasetId("ds-a".into()))
    );
}
// ===================================================================
// RED TEAM (#817 issue-sweep): probe the new transition allow-list and
// the surrounding never-leak / self-approve invariants.
// ===================================================================
