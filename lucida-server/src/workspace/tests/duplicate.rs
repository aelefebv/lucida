use super::*;

// ===================================================================
// Duplicate workspace (#698): a private copy that never transfers the
// source's members or any permission. Security-sensitive — see the
// headline `..._never_copies_members_or_link_access` test.
// ===================================================================

#[tokio::test]
async fn duplicate_is_owned_by_caller_named_copy_of_and_restricted_owner_only() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let (source_id, _datasets, _shared) = seed_rich_source(&store, &owner, &bob).await;
    let manager = manager_for(&store);

    // The owner duplicates their own workspace.
    let copy = manager
        .duplicate_workspace(&source_id, &owner, None)
        .await
        .unwrap();

    assert_ne!(copy.id, source_id, "the copy is a new workspace");
    assert_eq!(copy.name, "Copy of My Project");
    assert_eq!(copy.created_by, "alice@example.com");
    assert_eq!(copy.seq, 0);
    assert!(copy.archived_at.is_none());

    // Restricted, owner-only, link access OFF (the new-workspace defaults).
    let sharing = store.sharing_settings(&copy.id).await.unwrap().unwrap();
    assert_eq!(sharing.link_access, WorkspaceLinkAccess::Restricted);
    assert_eq!(sharing.members.len(), 1);
    assert_eq!(sharing.members[0].email, "alice@example.com");
    assert_eq!(sharing.members[0].role, WorkspaceRole::Owner);
}

/// THE KEY SECURITY TEST. The source has extra members + link access ON +
/// a non-default link role; the duplicate must carry NONE of it — only the
/// duplicator as a member, link access OFF. Members/permissions never
/// transfer.
#[tokio::test]
async fn duplicate_never_copies_members_or_link_access() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let (source_id, _datasets, _shared) = seed_rich_source(&store, &owner, &bob).await;

    // Sanity: the SOURCE really does have the extra member + link sharing.
    let src_sharing = store.sharing_settings(&source_id).await.unwrap().unwrap();
    assert_eq!(src_sharing.members.len(), 2);
    assert_eq!(src_sharing.link_access, WorkspaceLinkAccess::AnyoneWithLink);
    assert_eq!(src_sharing.link_role, WorkspaceRole::Editor);

    let manager = manager_for(&store);
    let copy = manager
        .duplicate_workspace(&source_id, &owner, None)
        .await
        .unwrap();

    let copy_sharing = store.sharing_settings(&copy.id).await.unwrap().unwrap();
    // ONLY the duplicator is a member.
    assert_eq!(
        copy_sharing.members.len(),
        1,
        "no source member may carry over"
    );
    assert_eq!(copy_sharing.members[0].email, "alice@example.com");
    assert!(
        !copy_sharing
            .members
            .iter()
            .any(|m| m.email == "bob@example.com"),
        "the source's other member must NOT appear in the copy"
    );
    // Link access is the default OFF — the source's AnyoneWithLink/editor
    // settings did not transfer.
    assert_eq!(copy_sharing.link_access, WorkspaceLinkAccess::Restricted);
    assert_eq!(copy_sharing.link_role, WorkspaceRole::Viewer);

    // And bob, an editor on the source, has NO access to the copy at all
    // (the manager's never-leak check returns NotFound).
    let err = manager.get_workspace_for(&copy.id, &bob).await.unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));
}

#[tokio::test]
async fn duplicate_copies_datasets_with_display_names() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let (source_id, _datasets, _shared) = seed_rich_source(&store, &owner, &bob).await;
    let manager = manager_for(&store);

    let copy = manager
        .duplicate_workspace(&source_id, &owner, None)
        .await
        .unwrap();

    let mut copied = store.list_dataset_sources(&copy.id).await.unwrap();
    copied.sort_by(|x, y| x.display_name.cmp(&y.display_name));
    assert_eq!(copied.len(), 2);
    assert_eq!(copied[0].display_name, "Alpha");
    assert_eq!(copied[1].display_name, "Beta");
    // Same GLOBAL source ids (datasets are shared by source), but FRESH
    // workspace-local ids (independent membership).
    let src = store.list_dataset_sources(&source_id).await.unwrap();
    let src_source_ids: std::collections::HashSet<_> =
        src.iter().map(|d| d.identity.clone()).collect();
    let copy_source_ids: std::collections::HashSet<_> =
        copied.iter().map(|d| d.identity.clone()).collect();
    assert_eq!(src_source_ids, copy_source_ids, "global source ids reused");
    for d in &copied {
        assert!(
            !src.iter()
                .any(|s| s.workspace_dataset_id == d.workspace_dataset_id),
            "copied datasets must get fresh workspace-local ids"
        );
    }
}

#[tokio::test]
async fn duplicate_copies_only_shared_views_attributed_to_duplicator() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let (source_id, _datasets, _shared) = seed_rich_source(&store, &owner, &bob).await;
    let manager = manager_for(&store);

    let copy = manager
        .duplicate_workspace(&source_id, &owner, None)
        .await
        .unwrap();

    // List as the duplicator (an editor would see proposed views too; we
    // list as the owner, who can edit, to PROVE no proposed view exists).
    let copied_views = store
        .list_saved_views(&copy.id, &normalize_email(&owner.email), true)
        .await
        .unwrap();
    assert_eq!(copied_views.len(), 1, "only the Shared view is copied");
    let copied = &copied_views[0];
    assert_eq!(copied.name, "Team view");
    assert_eq!(copied.visibility, SavedViewVisibility::Shared);
    // Re-attributed to the duplicator (not bob, not the original author if
    // it differed) — the assumed-default attribution.
    assert_eq!(copied.created_by, "alice@example.com");
    // Neither bob's personal nor bob's proposed view crossed over.
    assert!(
        !copied_views.iter().any(|v| v.name.starts_with("Bob")),
        "no personal/proposed view of another user may be copied"
    );
}

#[tokio::test]
async fn duplicate_sets_default_view_to_the_copied_view() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let (source_id, _datasets, _shared) = seed_rich_source(&store, &owner, &bob).await;
    let manager = manager_for(&store);

    let copy = manager
        .duplicate_workspace(&source_id, &owner, None)
        .await
        .unwrap();

    let default_id = copy
        .default_saved_view_id
        .clone()
        .expect("the copy should have a default view (source default was Shared)");
    let copied_views = store
        .list_saved_views(&copy.id, &normalize_email(&owner.email), true)
        .await
        .unwrap();
    // The default points at the COPIED view (a new id in the copy), not the
    // source's view id.
    assert_eq!(copied_views.len(), 1);
    assert_eq!(default_id, copied_views[0].id);
    assert_ne!(
        Some(default_id),
        store
            .get_workspace(&source_id)
            .await
            .unwrap()
            .unwrap()
            .default_saved_view_id,
        "the copy's default must be the copied view, not the source's"
    );
}

/// The id-consistency contract end-to-end: the copied document and the
/// copied saved view must resolve against the COPY's datasets, with no
/// dangling reference to the source's ids. Proven by reopening the copy and
/// checking its live document's dataset ids match its membership rows and
/// the copied saved view's `dataset_order`.
#[tokio::test]
async fn duplicate_document_and_views_resolve_to_copied_datasets() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let (source_id, source_dataset_ids, _shared) = seed_rich_source(&store, &owner, &bob).await;
    let manager = manager_for(&store);

    let copy = manager
        .duplicate_workspace(&source_id, &owner, None)
        .await
        .unwrap();

    // The copy's membership ids — the ground truth set of dataset ids the
    // copy's document/views are allowed to reference.
    let copy_members = store.list_dataset_sources(&copy.id).await.unwrap();
    let copy_ids: std::collections::HashSet<DatasetId> = copy_members
        .iter()
        .map(|d| d.workspace_dataset_id.clone())
        .collect();
    assert_eq!(copy_ids.len(), 2);
    // None of the copy's ids are the source's ids.
    for src in &source_dataset_ids {
        assert!(!copy_ids.contains(src), "copy must not reuse source ids");
    }

    // (a) Document: every manifest key resolves to a copied membership id,
    // and the embedded manifest.dataset_id agrees.
    for (id, manifest) in &copy.document.manifests {
        assert!(
            copy_ids.contains(id),
            "document manifest key must be a copied id"
        );
        assert_eq!(&manifest.dataset_id, id, "embedded manifest id remapped");
    }
    assert_eq!(copy.document.manifests.len(), 2);

    // (b) Copied saved view: dataset_order/active_layouts reference copied
    // ids only — no dangling source id.
    let copied_views = store
        .list_saved_views(&copy.id, &normalize_email(&owner.email), true)
        .await
        .unwrap();
    let copied_view = &copied_views[0].view;
    assert_eq!(copied_view.dataset_order.len(), 2);
    for id in &copied_view.dataset_order {
        assert!(
            copy_ids.contains(id),
            "saved-view dataset_order must resolve to a copied dataset id"
        );
    }
    for id in copied_view.active_layouts.keys() {
        assert!(
            copy_ids.contains(id),
            "saved-view layout key must be a copied id"
        );
    }

    // (c) Reopen the copy: the live document loaded from persisted JSON
    // carries exactly the copy's dataset ids (a broken copy would dangle).
    let live = manager.live_workspace(&copy.id, &owner).await.unwrap();
    let live_ids: std::collections::HashSet<DatasetId> = live
        .session
        .lock()
        .await
        .document
        .manifests
        .keys()
        .cloned()
        .collect();
    assert_eq!(
        live_ids, copy_ids,
        "reopened copy resolves to its own datasets"
    );
}

/// End-to-end proof for the embedded-author-view remap (the carrier missed
/// in the first cut of #698): a pin carries the author's captured view
/// (`Annotation::view`), itself keyed by the workspace's dataset ids. After
/// a duplicate, that embedded view must resolve to the COPY's ids — never
/// the source's — or a copied pin's "go to author's view" would dangle and
/// silently lose its per-channel colors/contrast. Seeds a pin-with-view on a
/// source dataset, duplicates, and asserts the copied document's
/// `annotations[].view` references copied ids only, with NO source id left in
/// any of active_layouts / dataset_order / dataset_settings / auto_contrast.
#[tokio::test]
async fn duplicate_remaps_pin_captured_view_to_copied_datasets() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let (source_id, source_dataset_ids, _shared) = seed_rich_source(&store, &owner, &bob).await;

    // Drop a pin carrying a captured view on the first source dataset.
    let source_pin_dataset = source_dataset_ids[0].clone();
    seed_pin_with_view(&store, &source_id, &owner, &source_pin_dataset, 3).await;

    // Sanity: the SOURCE document really carries the embedded view keyed by
    // the source dataset id (so a no-op remap couldn't vacuously pass).
    let src_doc = store.get_workspace(&source_id).await.unwrap().unwrap();
    let src_pins = src_doc
        .document
        .annotations
        .get(&source_pin_dataset)
        .expect("source must have a pin under the seeded dataset");
    let src_view = src_pins[0]
        .view
        .as_ref()
        .expect("seeded pin must carry a captured view");
    assert!(src_view.dataset_order.contains(&source_pin_dataset));
    assert!(src_view.active_layouts.contains_key(&source_pin_dataset));

    let manager = manager_for(&store);
    let copy = manager
        .duplicate_workspace(&source_id, &owner, None)
        .await
        .unwrap();

    // Ground truth: the copy's membership ids.
    let copy_members = store.list_dataset_sources(&copy.id).await.unwrap();
    let copy_ids: std::collections::HashSet<DatasetId> = copy_members
        .iter()
        .map(|d| d.workspace_dataset_id.clone())
        .collect();
    let source_ids: std::collections::HashSet<DatasetId> =
        source_dataset_ids.iter().cloned().collect();

    // Find the copied pin (under one of the copy's dataset ids) and pull its
    // embedded captured view.
    let copied_pin = copy
        .document
        .annotations
        .iter()
        .find_map(|(ds_id, anns)| {
            anns.iter()
                .find(|a| a.id == "pin-with-view")
                .map(|a| (ds_id.clone(), a))
        })
        .expect("copied document must still carry the pin");
    let (copied_pin_ds, copied_pin) = copied_pin;
    // The annotations-map KEY itself moved onto a copied id (existing
    // contract — the pin must hang off the copy's dataset).
    assert!(
        copy_ids.contains(&copied_pin_ds),
        "copied pin must be keyed under a copied dataset id, not the source's"
    );
    let copied_view = copied_pin
        .view
        .as_ref()
        .expect("copied pin must still carry its captured view");

    // Every id-keyed field of the embedded view resolves to a COPIED id, and
    // NO source id remains anywhere in it.
    assert_eq!(copied_view.dataset_order.len(), 1);
    for id in &copied_view.dataset_order {
        assert!(
            copy_ids.contains(id),
            "embedded view dataset_order must resolve to a copied id"
        );
        assert!(
            !source_ids.contains(id),
            "embedded view dataset_order must not retain a source id"
        );
    }
    for id in copied_view.active_layouts.keys() {
        assert!(copy_ids.contains(id), "embedded active_layouts key copied");
        assert!(
            !source_ids.contains(id),
            "embedded active_layouts must not retain a source id"
        );
    }
    for id in copied_view.dataset_settings.keys() {
        assert!(
            copy_ids.contains(id),
            "embedded dataset_settings key copied"
        );
        assert!(
            !source_ids.contains(id),
            "embedded dataset_settings must not retain a source id"
        );
    }
    for id in copied_view.auto_contrast.keys() {
        assert!(copy_ids.contains(id), "embedded auto_contrast key copied");
        assert!(
            !source_ids.contains(id),
            "embedded auto_contrast must not retain a source id"
        );
    }
    // The view did carry real id-keyed content (not a vacuous empty-map pass).
    assert!(!copied_view.active_layouts.is_empty());
    assert!(!copied_view.dataset_settings.is_empty());
    assert!(!copied_view.auto_contrast.is_empty());
}

#[tokio::test]
async fn viewer_of_source_can_duplicate_into_their_own_owned_copy() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let viewer = principal("carol@example.com", false);
    let (source_id, _datasets, _shared) = seed_rich_source(&store, &owner, &viewer).await;
    // Re-grant carol as a plain VIEWER (seed_rich_source made `other` an
    // editor); we want to prove a viewer specifically can duplicate.
    store
        .update_member_role(
            &source_id,
            &normalize_email(&viewer.email),
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();
    let manager = manager_for(&store);

    // Sanity: carol is a viewer on the source.
    let (_rec, role) = manager
        .get_workspace_for(&source_id, &viewer)
        .await
        .unwrap();
    assert_eq!(role, WorkspaceRole::Viewer);

    let copy = manager
        .duplicate_workspace(&source_id, &viewer, None)
        .await
        .unwrap();
    // It is carol's OWN owned copy.
    assert_eq!(copy.created_by, "carol@example.com");
    let sharing = store.sharing_settings(&copy.id).await.unwrap().unwrap();
    assert_eq!(sharing.members.len(), 1);
    assert_eq!(sharing.members[0].email, "carol@example.com");
    assert_eq!(sharing.members[0].role, WorkspaceRole::Owner);
    // Datasets + the Shared view came along, attributed to carol.
    assert_eq!(store.list_dataset_sources(&copy.id).await.unwrap().len(), 2);
    let views = store
        .list_saved_views(&copy.id, &normalize_email(&viewer.email), true)
        .await
        .unwrap();
    assert_eq!(views.len(), 1);
    assert_eq!(views[0].created_by, "carol@example.com");
}

#[tokio::test]
async fn non_member_duplicate_gets_uniform_never_leak_not_found() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    // Restricted source (default), bob is NOT a member.
    let ws = store
        .create_workspace(&owner, Some("Secret"))
        .await
        .unwrap();
    let stranger = principal("mallory@example.com", false);
    let manager = manager_for(&store);

    // Duplicating an inaccessible workspace is byte-identical to a missing
    // one: NotFound, never Forbidden — duplication must not reveal it.
    let err = manager
        .duplicate_workspace(&ws.id, &stranger, None)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound), "got {err:?}");

    // A truly missing workspace yields the SAME error.
    let missing = manager
        .duplicate_workspace("does-not-exist", &stranger, None)
        .await
        .unwrap_err();
    assert!(matches!(missing, WorkspaceError::NotFound));

    // No copy leaked into existence for the stranger.
    assert!(store.list_workspaces(&stranger).await.unwrap().is_empty());
    let _ = bob;
}

#[tokio::test]
async fn duplicate_empty_workspace_yields_empty_copy() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let ws = store.create_workspace(&owner, Some("Empty")).await.unwrap();
    let manager = manager_for(&store);

    let copy = manager
        .duplicate_workspace(&ws.id, &owner, None)
        .await
        .unwrap();
    assert_eq!(copy.name, "Copy of Empty");
    assert!(
        store
            .list_dataset_sources(&copy.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_saved_views(&copy.id, &normalize_email(&owner.email), true)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(copy.default_saved_view_id.is_none());
    assert!(copy.document.manifests.is_empty());
}

#[tokio::test]
async fn duplicate_with_multiple_datasets_and_multiple_shared_views() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let ws = store.create_workspace(&owner, Some("Multi")).await.unwrap();
    let a = open_dataset_into(&store, &ws.id, &owner, "s-a", "file:///a.zarr", "A", 1).await;
    let b = open_dataset_into(&store, &ws.id, &owner, "s-b", "file:///b.zarr", "B", 2).await;
    let c = open_dataset_into(&store, &ws.id, &owner, "s-c", "file:///c.zarr", "C", 3).await;
    for (n, order) in [
        ("v1", vec![a.clone()]),
        ("v2", vec![a.clone(), b.clone()]),
        ("v3", vec![b.clone(), c.clone()]),
    ] {
        store
            .create_saved_view(
                &ws.id,
                n,
                &owner,
                view_over(&order),
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap()
            .unwrap();
    }
    let manager = manager_for(&store);

    let copy = manager
        .duplicate_workspace(&ws.id, &owner, None)
        .await
        .unwrap();

    assert_eq!(store.list_dataset_sources(&copy.id).await.unwrap().len(), 3);
    let copy_ids: std::collections::HashSet<DatasetId> = store
        .list_dataset_sources(&copy.id)
        .await
        .unwrap()
        .iter()
        .map(|d| d.workspace_dataset_id.clone())
        .collect();
    let views = store
        .list_saved_views(&copy.id, &normalize_email(&owner.email), true)
        .await
        .unwrap();
    assert_eq!(views.len(), 3, "all three Shared views copied");
    // Every dataset id referenced by every copied view resolves to a copied
    // membership — no dangling references across the whole fan-out.
    for v in &views {
        for id in &v.view.dataset_order {
            assert!(
                copy_ids.contains(id),
                "{} references a copied dataset",
                v.name
            );
        }
    }
}

/// An explicit name override is honored (and trimmed); attribution and the
/// restricted-owner-only invariant still hold.
#[tokio::test]
async fn duplicate_honors_explicit_name_override() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let ws = store.create_workspace(&owner, Some("Orig")).await.unwrap();
    let manager = manager_for(&store);

    let copy = manager
        .duplicate_workspace(&ws.id, &owner, Some("  My Experiment  "))
        .await
        .unwrap();
    assert_eq!(copy.name, "My Experiment");
}

// ===================================================================
// RED-TEAM adversarial probes for #698 (added by red-team; do not
// weaken). Each asserts the *observed* behavior so a regression in the
// duplicate's never-copy / never-leak contract trips a test.
// ===================================================================

/// ROOT-CAUSE FIX: `DocumentState::apply(AddAnnotation { view })` now
/// enforces the documented `Annotation::view` invariant — the embedded
/// captured view's `datasets` Vec is stripped to EMPTY before the pin is
/// stored, so embedding a view on a pin never leaks dataset source URLs
/// (incl. local `file:///` paths, per decision 0014) into the persisted /
/// broadcast document. (Was the red-team's observed-leak test; flipped to
/// assert the fix.)
#[tokio::test]
async fn apply_add_annotation_strips_embedded_view_datasets() {
    let mut doc = DocumentState::default();
    let ds = DatasetId("wds-x".into());
    let mut view = SavedView::empty([800, 600]);
    view.datasets.push("file:///private/secret.zarr".into());
    doc.apply(DocumentCommand::AddAnnotation {
        dataset_id: ds.clone(),
        id: "p".into(),
        position: [0.0, 0.0],
        end: None,
        z: 0.0,
        t: 0,
        c: 0,
        author: "alice@example.com".into(),
        kind: lucida_core::scene::AnnotationKind::Point,
        view: Some(Box::new(view)),
    });
    let stored = doc.annotations[&ds][0].view.as_ref().unwrap();
    assert!(
        stored.datasets.is_empty(),
        "apply must strip the embedded view's source URLs — the \
             'left EMPTY' guarantee in Annotation::view is now enforced \
             (got {:?})",
        stored.datasets
    );
}

/// DUPLICATE IS CLEAN even for a pre-existing DIRTY source: a SOURCE dataset
/// URL smuggled into a pin's captured view (`Annotation::view.datasets`) of
/// the source document is NOT carried into the copy. The duplicate's
/// document remap clears `datasets` on every copied embedded view (the
/// copy-point defense), so even a source persisted before the apply-path
/// fix yields a clean copy. (A local `file://` URL here is exactly what
/// decision 0014 keeps out of shared/persisted state.) The pin itself is
/// still copied — only its leaked URLs are dropped. (Was the red-team's
/// observed-leak test; flipped to assert the fix.)
#[tokio::test]
async fn duplicate_strips_source_urls_embedded_in_pin_view() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let (source_id, source_dataset_ids, _shared) = seed_rich_source(&store, &owner, &bob).await;

    let leak_url = "file:///home/alice/unshared/private.zarr";
    seed_pin_with_view_urls(
        &store,
        &source_id,
        &owner,
        &source_dataset_ids[0],
        &[leak_url],
        3,
    )
    .await;

    let manager = manager_for(&store);
    let copy = manager
        .duplicate_workspace(&source_id, &owner, None)
        .await
        .unwrap();

    // The pin survived the copy, and its embedded view carries NO source
    // URLs (the duplicate stripped them at the copy point).
    let copied_view_datasets: Vec<String> = copy
        .document
        .annotations
        .values()
        .flatten()
        .find(|a| a.id == "pin-url-leak")
        .and_then(|a| a.view.as_ref())
        .map(|v| v.datasets.clone())
        .expect("copied document must still carry the pin + its view");

    assert!(
        copied_view_datasets.is_empty(),
        "the source URL must NOT survive into the copy's embedded pin view \
             (datasets={copied_view_datasets:?}); the duplicate strips \
             embedded-view source URLs"
    );
}

/// The duplicate has its OWN URL-strip defense for copied shared views,
/// independent of the manager's create path: even when a shared-view row
/// carries source URLs (e.g. inserted store-level, bypassing the manager's
/// `workspace_saved_view_payload` strip, or persisted before that strip
/// existed), the duplicate clears `datasets` on the copied view at the copy
/// point. So the copy's shared views carry NO source URLs regardless of the
/// source row's state (decision 0014). (Was the red-team's observed-leak
/// test; flipped to assert the fix.)
#[tokio::test]
async fn duplicate_strips_datasets_from_copied_shared_view() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let ws = store.create_workspace(&owner, Some("S")).await.unwrap();
    let a = open_dataset_into(&store, &ws.id, &owner, "s-a", "file:///a.zarr", "A", 1).await;

    // Persist a SHARED view that still carries source URLs (store-level
    // insert bypasses the manager's strip; this is the exact JSON the
    // duplicate will read + re-emit).
    let mut view = view_over(std::slice::from_ref(&a));
    view.datasets.push("file:///a.zarr".into());
    view.datasets
        .push("gs://corp-bucket/restricted.zarr".into());
    store
        .create_saved_view(&ws.id, "leaky", &owner, view, SavedViewVisibility::Shared)
        .await
        .unwrap()
        .unwrap();

    let manager = manager_for(&store);
    let copy = manager
        .duplicate_workspace(&ws.id, &owner, None)
        .await
        .unwrap();

    let copied = store
        .list_saved_views(&copy.id, &normalize_email(&owner.email), true)
        .await
        .unwrap();
    assert_eq!(copied.len(), 1);
    assert!(
        copied[0].view.datasets.is_empty(),
        "copied shared view must carry NO source URLs — the duplicate \
             re-strips datasets at the copy point (got {:?})",
        copied[0].view.datasets
    );
}

/// NEVER-LEAK (HTTP, byte-level): a non-member POSTing /duplicate against
/// an EXISTING restricted workspace must get a response byte-identical to
/// duplicating a MISSING id — same status AND same body bytes. Confirms the
/// access check leaks nothing distinguishing through the route.
#[tokio::test]
async fn duplicate_route_non_member_byte_identical_to_missing() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    // A RESTRICTED source (default link access OFF) with a real dataset, so
    // the stranger is a genuine non-member (no anyone-with-link grant).
    let ws = store
        .create_workspace(&owner, Some("Restricted"))
        .await
        .unwrap();
    let _ = open_dataset_into(&store, &ws.id, &owner, "s-a", "file:///a.zarr", "A", 1).await;
    let source_id = ws.id;

    let stranger = principal("mallory@example.com", false);

    let manager = manager_for(&store);
    let app = workspace_router_with_principal(Arc::new(manager), stranger.clone());
    let existing = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/workspaces/{source_id}/duplicate"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let existing_status = existing.status();
    let existing_body = to_bytes(existing.into_body(), 64 * 1024).await.unwrap();

    // Rebuild the manager/app (oneshot consumes the router).
    let manager2 = manager_for(&store);
    let app2 = workspace_router_with_principal(Arc::new(manager2), stranger);
    let missing = app2
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/workspaces/00000000-0000-0000-0000-000000000000/duplicate")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let missing_status = missing.status();
    let missing_body = to_bytes(missing.into_body(), 64 * 1024).await.unwrap();

    assert_eq!(existing_status, StatusCode::NOT_FOUND);
    assert_eq!(
        existing_status, missing_status,
        "status must match between existing-but-denied and missing"
    );
    assert_eq!(
        existing_body, missing_body,
        "body bytes must be identical between existing-but-denied and missing"
    );
}

/// NEVER-LEAK boundary: a MEMBER of an ARCHIVED source gets 410 Gone
/// (Archived) from /duplicate, NOT 404 — i.e. archive-state is disclosed to
/// a member through the duplicate route. A non-member still gets 404. This
/// documents that the duplicate route inherits `get_workspace_for`'s
/// member-only archive disclosure; acceptable under the never-leak doctrine
/// (only members, who already know it exists, see Gone), but recorded here
/// so any change is deliberate.
#[tokio::test]
async fn duplicate_archived_source_member_gets_gone_nonmember_not_found() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let ws = store.create_workspace(&owner, Some("A")).await.unwrap();
    store.archive_workspace(&ws.id).await.unwrap();
    let manager = manager_for(&store);

    // Member (owner) of the archived source.
    let member_err = manager
        .duplicate_workspace(&ws.id, &owner, None)
        .await
        .unwrap_err();
    assert!(
        matches!(member_err, WorkspaceError::Archived),
        "member of archived source gets Archived (410), got {member_err:?}"
    );

    // Non-member sees the uniform NotFound (indistinguishable from missing).
    let stranger = principal("mallory@example.com", false);
    let stranger_err = manager
        .duplicate_workspace(&ws.id, &stranger, None)
        .await
        .unwrap_err();
    assert!(
        matches!(stranger_err, WorkspaceError::NotFound),
        "non-member of archived source gets NotFound, got {stranger_err:?}"
    );
}

/// PRIVILEGE-VIA-COPY (negative / confirms NO hole): a pin authored by a
/// DIFFERENT member carries that author's email in the source document. A
/// viewer duplicating gets that email in their copy — but they could
/// already read it as a viewer of the source document, so it is not a new
/// disclosure. This test pins the *expected* behavior: annotation authorship
/// (content) rides along, while it is NOT a workspace member grant on the
/// copy (sharing stays owner-only).
#[tokio::test]
async fn duplicate_carries_annotation_author_as_content_not_membership() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let (source_id, source_dataset_ids, _s) = seed_rich_source(&store, &owner, &bob).await;

    // Bob (an editor on the source) authors a pin.
    let mut doc = store
        .get_workspace(&source_id)
        .await
        .unwrap()
        .unwrap()
        .document;
    doc.apply(DocumentCommand::AddAnnotation {
        dataset_id: source_dataset_ids[0].clone(),
        id: "bobs-pin".into(),
        position: [0.0, 0.0],
        end: None,
        z: 0.0,
        t: 0,
        c: 0,
        author: bob.email.clone(),
        kind: lucida_core::scene::AnnotationKind::Point,
        view: None,
    });
    store.persist_document(&source_id, 3, &doc).await.unwrap();

    // Carol, a plain viewer, duplicates.
    let carol = principal("carol@example.com", false);
    store
        .upsert_member(
            &source_id,
            &carol.email,
            &carol.display_name,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();
    let manager = manager_for(&store);
    let copy = manager
        .duplicate_workspace(&source_id, &carol, None)
        .await
        .unwrap();

    // Bob's authorship rides along as document CONTENT...
    let author = copy
        .document
        .annotations
        .values()
        .flatten()
        .find(|a| a.id == "bobs-pin")
        .map(|a| a.author.clone())
        .expect("copied document keeps the pin");
    assert_eq!(author, "bob@example.com");

    // ...but bob is NOT a member of carol's copy, and sharing is owner-only.
    let sharing = store.sharing_settings(&copy.id).await.unwrap().unwrap();
    assert_eq!(sharing.members.len(), 1);
    assert_eq!(sharing.members[0].email, "carol@example.com");
    assert_eq!(sharing.link_access, WorkspaceLinkAccess::Restricted);
    // Bob cannot access carol's copy.
    let err = manager.get_workspace_for(&copy.id, &bob).await.unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));
}

/// DANGLING-DEFAULT (confirms NO hole): if the source's default view is a
/// PERSONAL view (not copied), the copy's `default_saved_view_id` must be
/// NULL — never the source's view id (which would be a cross-workspace
/// dangling pointer to a view the copy doesn't own and the duplicator may
/// not be allowed to see).
#[tokio::test]
async fn duplicate_default_pointing_at_personal_view_resolves_to_null() {
    let store = fresh_store().await;
    let owner = principal("alice@example.com", false);
    let ws = store.create_workspace(&owner, Some("D")).await.unwrap();
    let a = open_dataset_into(&store, &ws.id, &owner, "s-a", "file:///a.zarr", "A", 1).await;

    // Owner's PERSONAL view, set as the workspace default.
    let personal = store
        .create_saved_view(
            &ws.id,
            "my personal",
            &owner,
            view_over(std::slice::from_ref(&a)),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap()
        .unwrap();
    store
        .set_default_saved_view(&ws.id, Some(&personal.id))
        .await
        .unwrap();

    let manager = manager_for(&store);
    let copy = manager
        .duplicate_workspace(&ws.id, &owner, None)
        .await
        .unwrap();

    // No shared view existed → nothing copied → default is NULL, and in
    // particular NOT the source's personal-view id.
    assert!(
        copy.default_saved_view_id.is_none(),
        "copy default must be NULL when the source default was a non-copied \
             (personal) view; got {:?}",
        copy.default_saved_view_id
    );
    assert_ne!(
        copy.default_saved_view_id.as_deref(),
        Some(personal.id.as_str())
    );
    // And the personal view itself did not cross over.
    let copied_views = store
        .list_saved_views(&copy.id, &normalize_email(&owner.email), true)
        .await
        .unwrap();
    assert!(copied_views.is_empty(), "no personal view may be copied");
}
