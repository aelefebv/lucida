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
            &test_source("file:///data/demo.zarr"),
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
    let identity = SourceIdentity::parse("file:///data/demo.zarr").unwrap();
    assert_eq!(sources[0].identity, identity);
    assert_eq!(
        store
            .dataset_by_source(&workspace.id, &identity)
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

#[tokio::test]
async fn persisted_source_rejects_mismatched_locator_reuse() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let workspace = store.create_workspace(&owner, Some("Demo")).await.unwrap();
    let workspace_dataset_id = DatasetId("wds-collision".into());
    let source = test_source("gs://bucket/original.zarr");
    store
        .persist_dataset_opened(
            &workspace.id,
            &workspace_dataset_id,
            &source,
            "original.zarr",
            &owner.email,
            1,
            &DocumentState::default(),
        )
        .await
        .unwrap();

    sqlx::query("UPDATE dataset_sources SET canonical_url = ? WHERE id = ?")
        .bind("gs://bucket/different.zarr")
        .bind(source.identity.dataset_id())
        .execute(&pool)
        .await
        .unwrap();

    let error = store
        .list_dataset_sources(&workspace.id)
        .await
        .expect_err("mismatched persisted locator must be rejected");
    assert!(matches!(error, StoreError::InvalidSourceIdentity(_)));
}

#[tokio::test]
async fn source_revision_and_document_refresh_commit_atomically() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store.create_workspace(&owner, Some("Demo")).await.unwrap();
    let workspace_dataset_id = DatasetId("wds-refresh".into());
    let identity = SourceIdentity::parse("gs://bucket/mutable.zarr").unwrap();
    let first = SourceVersion::new(
        identity.clone(),
        SourceRevision::from_bytes(b"generation-a"),
    );
    let mut first_document = DocumentState::default();
    first_document.manifests.insert(
        workspace_dataset_id.clone(),
        lucida_content::DatasetManifest::new(
            workspace_dataset_id.clone(),
            "Generation A".into(),
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
            &first,
            "mutable.zarr",
            &owner.email,
            1,
            &first_document,
        )
        .await
        .unwrap();

    let second = SourceVersion::new(identity, SourceRevision::from_bytes(b"generation-b"));
    let mut second_document = first_document;
    second_document
        .manifests
        .get_mut(&workspace_dataset_id)
        .unwrap()
        .name = "Generation B".into();
    store
        .persist_dataset_refreshed(
            &workspace.id,
            &workspace_dataset_id,
            &second,
            "mutable.zarr",
            2,
            &second_document,
        )
        .await
        .unwrap();

    let persisted_source = store
        .dataset_by_workspace_dataset(&workspace.id, &workspace_dataset_id)
        .await
        .unwrap()
        .unwrap();
    let persisted_workspace = store.get_workspace(&workspace.id).await.unwrap().unwrap();
    assert_eq!(persisted_source.revision, Some(second.revision));
    assert_eq!(persisted_workspace.seq, 2);
    assert_eq!(
        persisted_workspace.document.manifests[&workspace_dataset_id].name,
        "Generation B"
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
        DatasetRuntimeConfig::defaults(),
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    let url_before = store
        .dataset_by_workspace_dataset(&workspace_id, &wds_id)
        .await
        .unwrap()
        .unwrap()
        .identity
        .locator;

    manager
        .rename_dataset(&live, &owner, &wds_id, "Renamed")
        .await
        .unwrap();

    let after = store
        .dataset_by_workspace_dataset(&workspace_id, &wds_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.identity.locator, url_before);
    assert_eq!(after.identity.locator.as_str(), "/data/original.zarr");
    // The source id is unchanged; only the per-workspace label moved.
    assert_eq!(
        after.identity,
        SourceIdentity::parse("file:///data/original.zarr").unwrap()
    );
    assert_eq!(after.display_name, "Renamed");
}

#[tokio::test]
async fn rename_dataset_leaves_existing_saved_view_name_unchanged() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    // A co-present peer subscribes to the live broadcast channel.
    let mut rx = live.tx.subscribe();

    manager
        .rename_dataset(&live, &owner, &wds_id, "Live Rename")
        .await
        .unwrap();

    let item = rx.recv().await.unwrap();
    assert!(matches!(
        item.kind(),
        BroadcastKind::CommandBroadcast { .. }
    ));
    assert!(item.primary_json().contains("\"type\":\"rename_dataset\""));
    assert!(item.primary_json().contains("Live Rename"));
}

#[tokio::test]
async fn same_source_can_have_distinct_workspace_dataset_ids() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let a = store.create_workspace(&owner, Some("A")).await.unwrap();
    let b = store.create_workspace(&owner, Some("B")).await.unwrap();
    let canonical_url = "file:///data/shared.zarr";
    let identity = SourceIdentity::parse(canonical_url).unwrap();

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
                &test_source(canonical_url),
                "shared.zarr",
                &owner.email,
                1,
                &doc,
            )
            .await
            .unwrap();
    }

    let source_a = store
        .dataset_by_source(&a.id, &identity)
        .await
        .unwrap()
        .unwrap();
    let source_b = store
        .dataset_by_source(&b.id, &identity)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(source_a.identity, source_b.identity);
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
    let dataset_id = open_dataset_into(
        &store,
        &a.id,
        &owner,
        "independent-session-source",
        "file:///data/independent-session.zarr",
        "Independent session dataset",
        1,
    )
    .await;
    let manager = WorkspaceManager::new(Arc::new(store), DatasetRuntimeConfig::defaults());

    let live_a = manager.live_workspace(&a.id, &owner).await.unwrap();
    let live_b = manager.live_workspace(&b.id, &owner).await.unwrap();

    let cmd = DocumentCommand::RegisterLayout {
        dataset_id: dataset_id.clone(),
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

    assert_eq!(live_a.session.lock().await.seq, 2);
    assert_eq!(live_b.session.lock().await.seq, 0);
    assert!(
        live_a
            .session
            .lock()
            .await
            .document
            .registered_layouts
            .contains_key(&dataset_id)
    );
    assert!(
        !live_b
            .session
            .lock()
            .await
            .document
            .registered_layouts
            .contains_key(&dataset_id)
    );
}
// ===================================================================
// RED TEAM (#817 issue-sweep): probe the new transition allow-list and
// the surrounding never-leak / self-approve invariants.
// ===================================================================

// --- Manager-layer command authorization ---------------------------

// Generic document commands are authorized (and persisted) by the
// manager, mirroring `rename_dataset`: the WS handler holds no role
// checks, so a gate that only lived there would be bypassable by any
// new transport. These tests drive the manager API directly to prove
// the gate bites without any websocket.

#[tokio::test]
async fn apply_document_command_is_editor_gated_and_never_mutates_on_deny() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "layer.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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

    // A viewer cannot apply a document command — Forbidden (role-first).
    let err = manager
        .apply_document_command(
            &live,
            &viewer,
            DocumentCommand::RemoveDataset { id: wds_id.clone() },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CommandApplyError::Forbidden));

    // A non-member is denied identically, so membership never leaks.
    let stranger = principal("stranger@example.com", false);
    let err = manager
        .apply_document_command(
            &live,
            &stranger,
            DocumentCommand::RemoveDataset { id: wds_id.clone() },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CommandApplyError::Forbidden));

    // Denied commands touched nothing: dataset still present, seq unmoved.
    {
        let sess = live.session.lock().await;
        assert!(sess.document.manifests.contains_key(&wds_id));
        assert_eq!(sess.seq, 1);
    }

    // The owner's command applies AND persists (RemoveDataset routes
    // through the membership-row removal path).
    let (seq, applied) = manager
        .apply_document_command(
            &live,
            &owner,
            DocumentCommand::RemoveDataset { id: wds_id.clone() },
        )
        .await
        .unwrap();
    assert_eq!(seq, 2);
    assert!(matches!(applied, DocumentCommand::RemoveDataset { .. }));
    assert!(
        !live
            .session
            .lock()
            .await
            .document
            .manifests
            .contains_key(&wds_id)
    );
    let persisted = store.get_workspace(&workspace_id).await.unwrap().unwrap();
    assert_eq!(persisted.seq, 2);
    assert!(!persisted.document.manifests.contains_key(&wds_id));
    assert!(
        store
            .dataset_by_workspace_dataset(&workspace_id, &wds_id)
            .await
            .unwrap()
            .is_none(),
        "RemoveDataset must also drop the workspace_datasets row"
    );
}

#[tokio::test]
async fn inverse_command_rechecks_authorship_revision_persistence_and_replay() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, dataset_id) =
        seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
    let editor = principal("editor@example.com", false);
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

    let (target, _) = manager
        .apply_document_command(
            &live,
            &owner,
            DocumentCommand::RenameDataset {
                id: dataset_id.clone(),
                name: "renamed.zarr".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(target, 2);
    let mut peer_document = live.session.lock().await.document.clone();

    // Editor role is insufficient: collaborative undo is additionally scoped
    // to the authenticated author of the target operation.
    assert!(matches!(
        manager
            .apply_inverse_command(&live, &editor, target, target)
            .await
            .unwrap_err(),
        CommandApplyError::Forbidden
    ));
    assert!(matches!(
        manager
            .apply_inverse_command(&live, &owner, target, target + 1)
            .await
            .unwrap_err(),
        CommandApplyError::Conflict(_)
    ));
    {
        let session = live.session.lock().await;
        assert_eq!(session.seq, target);
        assert_eq!(session.document.manifests[&dataset_id].name, "renamed.zarr");
    }

    let (undo_seq, inverse) = manager
        .apply_inverse_command(&live, &owner, target, target)
        .await
        .unwrap();
    assert_eq!(undo_seq, 3);
    peer_document.try_apply(inverse).unwrap();
    assert_eq!(
        serde_json::to_value(&peer_document).unwrap(),
        serde_json::to_value(&live.session.lock().await.document).unwrap(),
        "all clients converge by applying the ordinary inverse broadcast"
    );
    let persisted = store.get_workspace(&workspace_id).await.unwrap().unwrap();
    assert_eq!(persisted.seq, undo_seq);
    assert_eq!(
        persisted.document.manifests[&dataset_id].name,
        "original.zarr"
    );
    assert_eq!(
        store
            .dataset_by_workspace_dataset(&workspace_id, &dataset_id)
            .await
            .unwrap()
            .unwrap()
            .display_name,
        "original.zarr",
        "inverse rename updates the private listing row and document atomically"
    );

    // Replaying the original target conflicts because its semantic
    // postcondition no longer holds. Redo targets the newly appended inverse.
    assert!(matches!(
        manager
            .apply_inverse_command(&live, &owner, target, target)
            .await
            .unwrap_err(),
        CommandApplyError::Conflict(_)
    ));
    let (redo_seq, redo) = manager
        .apply_inverse_command(&live, &owner, undo_seq, undo_seq)
        .await
        .unwrap();
    assert_eq!(redo_seq, 4);
    assert!(matches!(
        redo,
        DocumentCommand::RenameDataset { name, .. } if name == "renamed.zarr"
    ));
}

#[tokio::test]
async fn persistence_failure_never_publishes_or_revokes_staged_command() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, dataset_id) =
        seed_workspace_with_dataset(&store, &owner, "durable.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    let service = {
        let mut session = live.session.lock().await;
        let manifest = session.document.manifests[&dataset_id].clone();
        let binding = inert_server_binding("file:///data/durable.zarr", manifest);
        let service = Arc::clone(&binding.generated_service);
        session.server_bindings.insert(dataset_id.clone(), binding);
        service
    };

    sqlx::query(
        r#"
        CREATE TRIGGER reject_document_persist
        BEFORE UPDATE OF seq ON workspaces
        BEGIN
            SELECT RAISE(FAIL, 'injected persistence failure');
        END
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let error = manager
        .apply_document_command(
            &live,
            &owner,
            DocumentCommand::RemoveDataset {
                id: dataset_id.clone(),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(error, CommandApplyError::PersistFailed(_)));

    let session = live.session.lock().await;
    assert_eq!(session.seq, 1);
    assert!(session.document.manifests.contains_key(&dataset_id));
    assert!(session.server_bindings.contains_key(&dataset_id));
    drop(session);
    assert!(!service.is_shutdown().await);
    assert!(
        store
            .dataset_by_workspace_dataset(&workspace_id, &dataset_id)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn concurrent_persistence_failure_cannot_skip_or_poison_the_next_acknowledged_revision() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, dataset_id) =
        seed_workspace_with_dataset(&store, &owner, "original.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    // Reject only the candidate containing this name. Whichever future gets
    // the ordered workspace commit lock first, one write fails and the other
    // must still publish the exact next durable revision.
    sqlx::query(
        r#"
        CREATE TRIGGER reject_one_document_candidate
        BEFORE UPDATE OF seq ON workspaces
        WHEN NEW.document_json LIKE '%rejected-name%'
        BEGIN
            SELECT RAISE(FAIL, 'injected candidate-specific persistence failure');
        END
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let rejected = manager.apply_document_command(
        &live,
        &owner,
        DocumentCommand::RenameDataset {
            id: dataset_id.clone(),
            name: "rejected-name".into(),
        },
    );
    let accepted = manager.apply_document_command(
        &live,
        &owner,
        DocumentCommand::RenameDataset {
            id: dataset_id.clone(),
            name: "acknowledged-name".into(),
        },
    );
    let (rejected, accepted) = tokio::join!(rejected, accepted);

    assert!(matches!(rejected, Err(CommandApplyError::PersistFailed(_))));
    let (acknowledged_seq, acknowledged_command) = accepted.unwrap();
    assert_eq!(acknowledged_seq, 2);
    assert!(matches!(
        acknowledged_command,
        DocumentCommand::RenameDataset { name, .. } if name == "acknowledged-name"
    ));

    let session = live.session.lock().await;
    assert_eq!(session.seq, acknowledged_seq);
    assert_eq!(
        session.document.manifests[&dataset_id].name,
        "acknowledged-name"
    );
    drop(session);

    let persisted = store.get_workspace(&workspace_id).await.unwrap().unwrap();
    assert_eq!(persisted.seq, acknowledged_seq);
    assert_eq!(
        persisted.document.manifests[&dataset_id].name,
        "acknowledged-name"
    );
    assert_eq!(
        store
            .dataset_by_workspace_dataset(&workspace_id, &dataset_id)
            .await
            .unwrap()
            .unwrap()
            .display_name,
        "acknowledged-name"
    );
}

#[tokio::test]
async fn durable_dataset_removal_revokes_every_runtime_capability() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, dataset_id) =
        seed_workspace_with_dataset(&store, &owner, "removable.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    let service = {
        let mut session = live.session.lock().await;
        let manifest = session.document.manifests[&dataset_id].clone();
        let binding = inert_server_binding("file:///data/removable.zarr", manifest);
        let service = Arc::clone(&binding.generated_service);
        session.server_bindings.insert(dataset_id.clone(), binding);
        session.record_binding_source(
            dataset_id.clone(),
            "file:///data/removable.zarr".into(),
            Some("source-removable".into()),
            "removable.zarr".into(),
        );
        session
            .generated_availability
            .insert(dataset_id.clone(), Default::default());
        service
    };

    let (seq, _) = manager
        .apply_document_command(
            &live,
            &owner,
            DocumentCommand::RemoveDataset {
                id: dataset_id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(seq, 2);

    let session = live.session.lock().await;
    assert!(!session.document.manifests.contains_key(&dataset_id));
    assert!(!session.server_bindings.contains_key(&dataset_id));
    assert!(!session.binding_runtime.contains_key(&dataset_id));
    assert!(!session.generated_availability.contains_key(&dataset_id));
    drop(session);
    assert!(service.is_shutdown().await);
    assert!(
        store
            .dataset_by_workspace_dataset(&workspace_id, &dataset_id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn process_shutdown_checkpoints_active_and_late_workspace_services() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let active = store
        .create_workspace(&owner, Some("Active runtime"))
        .await
        .unwrap();
    let late = store
        .create_workspace(&owner, Some("Late runtime"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store), DatasetRuntimeConfig::defaults());
    let active_live = manager.live_workspace(&active.id, &owner).await.unwrap();
    let dataset_id = DatasetId("shutdown-runtime".into());
    let manifest = DatasetManifest::new(
        dataset_id.clone(),
        "runtime".into(),
        lucida_content::DatasetKind::Single,
        vec![],
        vec![],
        vec![],
        vec![],
        None,
    );
    let service = {
        let mut session = active_live.session.lock().await;
        let binding = inert_server_binding("file:///data/runtime.zarr", manifest);
        let service = Arc::clone(&binding.generated_service);
        session.server_bindings.insert(dataset_id, binding);
        service
    };

    let stopped = manager
        .shutdown_all_live_background("process_shutdown")
        .await;
    assert_eq!(stopped, 1);
    assert!(active_live.background_cancelled());
    assert!(service.is_shutdown().await);

    // A restore racing after the process-wide marker cannot start a fresh
    // background runtime after the original live-workspace snapshot.
    let late_live = manager.live_workspace(&late.id, &owner).await.unwrap();
    assert!(late_live.background_cancelled());
}

#[tokio::test]
async fn dataset_source_for_retry_is_editor_gated() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "layer.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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

    // Viewer and non-member are denied before any row is read.
    let err = manager
        .dataset_source_for_retry(&workspace_id, &viewer, &wds_id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));
    let stranger = principal("stranger@example.com", false);
    let err = manager
        .dataset_source_for_retry(&workspace_id, &stranger, &wds_id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    // An editor-capable principal resolves the persisted source…
    let source = manager
        .dataset_source_for_retry(&workspace_id, &owner, &wds_id)
        .await
        .unwrap()
        .expect("seeded dataset source must resolve");
    assert_eq!(source.workspace_dataset_id, wds_id);
    assert_eq!(source.identity.locator.as_str(), "/data/original.zarr");

    // …and an unknown dataset id resolves to None (not an error).
    assert!(
        manager
            .dataset_source_for_retry(&workspace_id, &owner, &DatasetId("wds_missing".into()))
            .await
            .unwrap()
            .is_none()
    );
}

/// The editor gate's two failure modes must never be conflated: a role
/// that DENIES is an authorization verdict, but a role lookup that
/// ERRORS is transient store trouble — no verdict was reached. Closing
/// the sqlite pool makes every subsequent query fail, so both manager
/// entry points can be driven against a genuinely failing store.
#[tokio::test]
async fn gate_store_failure_is_infrastructure_not_an_authorization_verdict() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let (workspace_id, wds_id) = seed_workspace_with_dataset(&store, &owner, "layer.zarr").await;
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
    let live = manager.live_workspace(&workspace_id, &owner).await.unwrap();

    // Kill the store: role lookups (and everything else) now error.
    pool.close().await;

    // Command apply: reported as GateUnavailable — NOT Forbidden (no
    // verdict was reached) and NOT PersistFailed (nothing was applied).
    let err = manager
        .apply_document_command(
            &live,
            &owner,
            DocumentCommand::RemoveDataset { id: wds_id.clone() },
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, CommandApplyError::GateUnavailable(_)),
        "expected GateUnavailable, got: {err:?}"
    );
    {
        let sess = live.session.lock().await;
        assert!(
            sess.document.manifests.contains_key(&wds_id),
            "a gate store failure must not mutate the document"
        );
        assert_eq!(sess.seq, 1, "seq must not advance");
    }

    // Retry lookup: surfaces as a Store error, distinct from Forbidden,
    // so the transport maps it to the retryable lookup diagnostic (pinned
    // in the handler's `dataset_retry_failure_diagnostic` tests) rather
    // than an authorization denial.
    let err = manager
        .dataset_source_for_retry(&workspace_id, &owner, &wds_id)
        .await
        .unwrap_err();
    assert!(
        matches!(err, WorkspaceError::Store(_)),
        "expected Store, got: {err:?}"
    );
}
