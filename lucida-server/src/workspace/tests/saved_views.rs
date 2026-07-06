use super::*;

#[tokio::test]
async fn workspace_saved_views_are_scoped_and_strip_source_urls() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let a = store.create_workspace(&owner, Some("A")).await.unwrap();
    let b = store.create_workspace(&owner, Some("B")).await.unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    let mut view = SavedView::empty([800, 600]);
    view.datasets.push("gs://bucket/source-url.zarr".into());
    view.dataset_order.push(DatasetId("wds_workspace_a".into()));

    let saved = manager
        .create_saved_view(
            &a.id,
            &owner,
            "  morphology view  ",
            view,
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap();
    assert_eq!(saved.workspace_id, a.id);
    assert_eq!(saved.name, "morphology view");
    assert!(saved.view.datasets.is_empty());
    assert_eq!(
        saved.view.dataset_order,
        vec![DatasetId("wds_workspace_a".into())]
    );

    let listed_a = manager.list_saved_views(&a.id, &owner).await.unwrap();
    assert_eq!(listed_a.len(), 1);
    assert_eq!(listed_a[0].id, saved.id);
    let listed_b = manager.list_saved_views(&b.id, &owner).await.unwrap();
    assert!(listed_b.is_empty());

    let mut replacement = SavedView::empty([640, 480]);
    replacement
        .datasets
        .push("file:///should-not-store.zarr".into());
    replacement
        .dataset_order
        .push(DatasetId("wds_workspace_a_reordered".into()));
    let updated = manager
        .update_saved_view(&a.id, &owner, &saved.id, Some("renamed"), Some(replacement))
        .await
        .unwrap();
    assert_eq!(updated.name, "renamed");
    assert!(updated.view.datasets.is_empty());
    assert_eq!(
        updated.view.dataset_order,
        vec![DatasetId("wds_workspace_a_reordered".into())]
    );
}

#[tokio::test]
async fn workspace_saved_view_viewers_can_read_but_not_mutate() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Shared saved views"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &viewer.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    let saved = manager
        .create_saved_view(
            &workspace.id,
            &owner,
            "view",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap();

    let listed = manager
        .list_saved_views(&workspace.id, &viewer)
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, saved.id);
    assert_eq!(
        manager
            .get_saved_view(&workspace.id, &viewer, &saved.id)
            .await
            .unwrap()
            .id,
        saved.id
    );

    let err = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "viewer create",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    let err = manager
        .update_saved_view(&workspace.id, &viewer, &saved.id, Some("nope"), None)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    let err = manager
        .delete_saved_view(&workspace.id, &viewer, &saved.id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));
}

#[tokio::test]
async fn workspace_personal_saved_view_mutations_are_creator_only() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let editor = principal("editor@example.com", false);
    let admin = principal("admin@example.com", true);
    let workspace = store
        .create_workspace(&owner, Some("Personal saved views"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &viewer.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &editor.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();

    // A viewer may create a personal view (mirrors create_saved_view), and
    // must be able to mutate their own — editor is NOT required for the
    // owner of a personal view.
    let personal = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "my personal",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    assert_eq!(personal.visibility, SavedViewVisibility::Personal);

    // Every other caller — editor, owner, admin — is told NotFound (never
    // Forbidden, never success): the row's existence is never confirmed.
    for other in [&editor, &owner, &admin] {
        let err = manager
            .update_saved_view(&workspace.id, other, &personal.id, Some("hijack"), None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, WorkspaceError::NotFound),
            "update by {} should be NotFound, got {err:?}",
            other.email
        );
        let err = manager
            .delete_saved_view(&workspace.id, other, &personal.id)
            .await
            .unwrap_err();
        assert!(
            matches!(err, WorkspaceError::NotFound),
            "delete by {} should be NotFound, got {err:?}",
            other.email
        );
    }

    // The personal view survived every unauthorized attempt.
    let still_there = manager
        .get_saved_view(&workspace.id, &viewer, &personal.id)
        .await
        .unwrap();
    assert_eq!(still_there.name, "my personal");

    // The creator (a viewer) can update their own personal view.
    let updated = manager
        .update_saved_view(&workspace.id, &viewer, &personal.id, Some("renamed"), None)
        .await
        .unwrap();
    assert_eq!(updated.name, "renamed");

    // ...and delete it.
    manager
        .delete_saved_view(&workspace.id, &viewer, &personal.id)
        .await
        .unwrap();
    let err = manager
        .get_saved_view(&workspace.id, &viewer, &personal.id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));

    // A non-existent id is NotFound for everyone (unchanged).
    let err = manager
        .update_saved_view(&workspace.id, &owner, "does-not-exist", Some("x"), None)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));
    let err = manager
        .delete_saved_view(&workspace.id, &owner, "does-not-exist")
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));
}

#[tokio::test]
async fn promote_personal_view_to_shared_enforces_creator_editor_and_never_leak() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let admin = principal("admin@example.com", true);
    let workspace = store
        .create_workspace(&owner, Some("Promote saved views"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &editor.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &viewer.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    // The editor creates a personal view, plus a second personal view and a
    // shared view that must remain untouched by any promotion.
    let personal = manager
        .create_saved_view(
            &workspace.id,
            &editor,
            "editor personal",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let bystander = manager
        .create_saved_view(
            &workspace.id,
            &editor,
            "editor personal 2",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let shared = manager
        .create_saved_view(
            &workspace.id,
            &owner,
            "shared default",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap();
    manager
        .set_default_saved_view(&workspace.id, &owner, Some(&shared.id))
        .await
        .unwrap();

    // Never-leak: a non-creator (editor or owner or admin) of the *other*
    // member's personal view cannot even see it, so promotion is NotFound —
    // never Forbidden, which would confirm the row exists.
    let viewer_personal = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "viewer personal",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    for other in [&editor, &owner, &admin] {
        let err = manager
            .set_saved_view_visibility(
                &workspace.id,
                other,
                &viewer_personal.id,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, WorkspaceError::NotFound),
            "promotion by {} of someone else's personal view should be NotFound, got {err:?}",
            other.email
        );
    }

    // A non-member is denied before any row is read (Forbidden, not
    // NotFound — membership is the first gate).
    let stranger = principal("stranger@example.com", false);
    let err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &stranger,
            &personal.id,
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    // The creator promotes their own personal view to shared. created_by is
    // preserved (attribution) and the view payload is untouched.
    let promoted = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &personal.id,
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap();
    assert_eq!(promoted.id, personal.id);
    assert_eq!(promoted.visibility, SavedViewVisibility::Shared);
    assert_eq!(promoted.created_by, normalize_email(&editor.email));
    assert_eq!(promoted.created_by_name, personal.created_by_name);
    assert_eq!(promoted.name, "editor personal");

    // Now that it is shared, every member can see it — including the viewer,
    // who never could before.
    let seen = manager
        .get_saved_view(&workspace.id, &viewer, &personal.id)
        .await
        .unwrap();
    assert_eq!(seen.visibility, SavedViewVisibility::Shared);

    // Promotion never touched the other personal view or the shared
    // default.
    let still_personal = manager
        .get_saved_view(&workspace.id, &editor, &bystander.id)
        .await
        .unwrap();
    assert_eq!(still_personal.visibility, SavedViewVisibility::Personal);
    let record = store.get_workspace(&workspace.id).await.unwrap().unwrap();
    assert_eq!(
        record.default_saved_view_id.as_deref(),
        Some(shared.id.as_str())
    );

    // The creator can demote it back to personal WITHOUT editor being
    // required for the demote path itself: prove this with a creator who is
    // only a viewer.
    let owned_by_viewer = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "viewer second",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    // A viewer cannot promote to shared (shared mutation needs editor).
    let err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &viewer,
            &owned_by_viewer.id,
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    // The editor demotes their now-shared view back to personal; no editor
    // is strictly needed for demote, and attribution is still preserved.
    let demoted = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &personal.id,
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    assert_eq!(demoted.visibility, SavedViewVisibility::Personal);
    assert_eq!(demoted.created_by, normalize_email(&editor.email));
    // ...and once personal again, the viewer can no longer see it.
    let err = manager
        .get_saved_view(&workspace.id, &viewer, &personal.id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));

    // Creator-only on a SHARED view: a shared view is readable by everyone,
    // but a non-creator (here the editor, who did not create `shared`)
    // cannot re-scope it — Forbidden, not success and not NotFound.
    let err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &shared.id,
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    // A non-existent id is NotFound for everyone.
    let err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &owner,
            "does-not-exist",
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));
}

#[tokio::test]
async fn set_saved_view_visibility_rest_promotes_and_preserves_attribution() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Promote REST"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
    ));
    let personal = manager
        .create_saved_view(
            &workspace.id,
            &owner,
            "rest personal",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();

    let app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());
    let res = app
        .oneshot(
            Request::builder()
                .method(Method::PATCH)
                .uri(format!(
                    "/api/workspaces/{}/saved-views/{}/visibility",
                    workspace.id, personal.id
                ))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"visibility":"shared"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = response_json(res).await;
    assert_eq!(body["id"], personal.id);
    assert_eq!(body["visibility"], "shared");
    assert_eq!(body["created_by"], normalize_email(&owner.email));

    // The store reflects the new visibility.
    let reread = store
        .get_saved_view(&workspace.id, &personal.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reread.visibility, SavedViewVisibility::Shared);
}

#[test]
fn saved_view_transition_allow_list_is_closed_by_construction() {
    use SavedViewVisibility::{Personal, Proposed, Shared};
    // The four legal creator transitions.
    assert!(saved_view_transition_allowed(Personal, Shared));
    assert!(saved_view_transition_allowed(Shared, Personal));
    assert!(saved_view_transition_allowed(Personal, Proposed));
    assert!(saved_view_transition_allowed(Proposed, Personal));
    // Same-state is an idempotent no-op for every state.
    assert!(saved_view_transition_allowed(Personal, Personal));
    assert!(saved_view_transition_allowed(Shared, Shared));
    assert!(saved_view_transition_allowed(Proposed, Proposed));
    // The illegal transitions #817 closes: Shared cannot be demoted into the
    // review queue, and a proposal cannot self-approve straight to shared.
    assert!(!saved_view_transition_allowed(Shared, Proposed));
    assert!(!saved_view_transition_allowed(Proposed, Shared));
}

/// #817: the `/visibility` endpoint may only perform the creator
/// transition allow-list. This proves the gate is closed by construction:
/// the two illegal transitions (`Shared→Proposed`, and the
/// `Proposed→Shared` self-approve bypass attempted by an editor-creator) are
/// `BadRequest`; every legal transition succeeds; `→Shared` by a non-editor
/// creator keeps the existing authority error; never-leak and `created_by`
/// are preserved.
#[tokio::test]
async fn set_saved_view_visibility_enforces_transition_allow_list() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Transition gate"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    for (p, role) in [
        (&editor, WorkspaceRole::Editor),
        (&viewer, WorkspaceRole::Viewer),
    ] {
        manager
            .upsert_member(&workspace.id, &owner, &p.email, None, role)
            .await
            .unwrap();
    }

    // --- never-leak: a member who is not the creator of a Personal view
    // gets NotFound, uniform with a missing id (the view's existence is
    // never confirmed via the visibility endpoint). ---
    let viewer_personal = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "viewer private",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let leak_err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &viewer_personal.id,
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(leak_err, WorkspaceError::NotFound),
        "non-creator rescope of a personal view must be NotFound, got {leak_err:?}"
    );
    let missing_err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            "does-not-exist",
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(missing_err, WorkspaceError::NotFound),
        "missing id must be NotFound, identical to the hidden personal view"
    );

    // --- legal: Personal -> Proposed (creator proposes their own view). ---
    let proposing = manager
        .create_saved_view(
            &workspace.id,
            &editor,
            "to propose",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let proposed = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &proposing.id,
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();
    assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);
    assert_eq!(proposed.created_by, normalize_email(&editor.email));

    // --- illegal: Proposed -> Shared by the editor-creator (the
    // self-approve bypass) MUST be BadRequest, NOT a silent share. Sharing a
    // proposal is exclusively the editor review queue (`approve_saved_view`).
    let bypass_err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &proposed.id,
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(bypass_err, WorkspaceError::BadRequest(_)),
        "Proposed->Shared self-approve bypass must be BadRequest, got {bypass_err:?}"
    );
    // It is genuinely still Proposed in the store — the bypass changed
    // nothing.
    let still_proposed = store
        .get_saved_view(&workspace.id, &proposed.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still_proposed.visibility, SavedViewVisibility::Proposed);

    // --- legal: Proposed -> Personal (creator withdraws their proposal). ---
    let withdrawn = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &proposed.id,
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    assert_eq!(withdrawn.visibility, SavedViewVisibility::Personal);
    assert_eq!(withdrawn.created_by, normalize_email(&editor.email));

    // --- legal: Personal -> Shared by an editor-creator; created_by is
    // preserved across the rescope (authorship is never reassigned). ---
    let to_share = manager
        .create_saved_view(
            &workspace.id,
            &editor,
            "to share",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let shared = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &to_share.id,
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap();
    assert_eq!(shared.visibility, SavedViewVisibility::Shared);
    assert_eq!(
        shared.created_by,
        normalize_email(&editor.email),
        "created_by must be preserved across a legal rescope"
    );
    assert_eq!(shared.created_by_name, to_share.created_by_name);

    // --- illegal: Shared -> Proposed (a shared view cannot be demoted into
    // the review queue) MUST be BadRequest. ---
    let demote_to_queue_err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &shared.id,
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(demote_to_queue_err, WorkspaceError::BadRequest(_)),
        "Shared->Proposed must be BadRequest, got {demote_to_queue_err:?}"
    );

    // --- legal: Shared -> Personal by the creator (make it private again). ---
    let private_again = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &shared.id,
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    assert_eq!(private_again.visibility, SavedViewVisibility::Personal);
    assert_eq!(private_again.created_by, normalize_email(&editor.email));

    // --- authority preserved: ->Shared by a creator who is NOT an editor
    // (a viewer) is the existing authority error (Forbidden), even though
    // Personal->Shared is itself on the allow-list. ---
    let viewer_to_share = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "viewer wants to share",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let authority_err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &viewer,
            &viewer_to_share.id,
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(authority_err, WorkspaceError::Forbidden),
        "non-editor creator promoting to Shared must be Forbidden, got {authority_err:?}"
    );
}

#[test]
fn saved_view_visibility_proposed_round_trips_text() {
    assert_eq!(SavedViewVisibility::Proposed.as_str(), "proposed");
    assert_eq!(
        SavedViewVisibility::try_from("proposed").unwrap(),
        SavedViewVisibility::Proposed
    );
    // Serializes lowercase for the REST/JSON surface.
    assert_eq!(
        serde_json::to_value(SavedViewVisibility::Proposed).unwrap(),
        serde_json::json!("proposed")
    );
    // An unknown string is still rejected (no silent fallback).
    assert!(SavedViewVisibility::try_from("queued").is_err());
}

#[test]
fn proposed_view_is_readable_only_by_creator_in_the_pure_gate() {
    // The role-blind gate treats Proposed exactly like Personal: creator
    // Ok, everyone else NotFound. The editor exception is layered above.
    let creator = principal("creator@example.com", false);
    let other = principal("other@example.com", false);
    let proposed = WorkspaceSavedView {
        id: "sv".into(),
        workspace_id: "ws".into(),
        name: "p".into(),
        created_by: normalize_email(&creator.email),
        created_by_name: creator.display_name.clone(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
        visibility: SavedViewVisibility::Proposed,
        view: SavedView::empty([800, 600]),
    };
    assert!(ensure_saved_view_readable(&proposed, &creator).is_ok());
    assert!(matches!(
        ensure_saved_view_readable(&proposed, &other),
        Err(WorkspaceError::NotFound)
    ));
}

#[tokio::test]
async fn viewer_can_propose_and_only_creator_or_editor_sees_it() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let other_viewer = principal("nosy@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Propose visibility"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    for (p, role) in [
        (&editor, WorkspaceRole::Editor),
        (&viewer, WorkspaceRole::Viewer),
        (&other_viewer, WorkspaceRole::Viewer),
    ] {
        manager
            .upsert_member(&workspace.id, &owner, &p.email, None, role)
            .await
            .unwrap();
    }

    // A plain viewer may propose, exactly as they may save a personal view.
    let proposed = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "viewer proposal",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();
    assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);
    assert_eq!(proposed.created_by, normalize_email(&viewer.email));

    // The proposer sees their own proposal.
    let seen = manager
        .get_saved_view(&workspace.id, &viewer, &proposed.id)
        .await
        .unwrap();
    assert_eq!(seen.visibility, SavedViewVisibility::Proposed);
    // An editor (and the owner) may read it for review.
    for reviewer in [&editor, &owner] {
        let seen = manager
            .get_saved_view(&workspace.id, reviewer, &proposed.id)
            .await
            .unwrap();
        assert_eq!(seen.id, proposed.id);
    }
    // Never-leak: another plain viewer cannot even see it (NotFound, not
    // Forbidden — its existence is never confirmed).
    let err = manager
        .get_saved_view(&workspace.id, &other_viewer, &proposed.id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));

    // list_saved_views: the proposer sees their proposal; an editor gets the
    // review queue; another plain viewer does NOT see the pending proposal.
    let viewer_list = manager
        .list_saved_views(&workspace.id, &viewer)
        .await
        .unwrap();
    assert!(viewer_list.iter().any(|v| v.id == proposed.id));
    let editor_list = manager
        .list_saved_views(&workspace.id, &editor)
        .await
        .unwrap();
    assert!(editor_list.iter().any(|v| v.id == proposed.id));
    let other_list = manager
        .list_saved_views(&workspace.id, &other_viewer)
        .await
        .unwrap();
    assert!(!other_list.iter().any(|v| v.id == proposed.id));
}

#[tokio::test]
async fn approve_proposal_shares_it_preserving_attribution_and_is_editor_only() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let other_viewer = principal("bystander@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Approve proposal"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    for (p, role) in [
        (&editor, WorkspaceRole::Editor),
        (&viewer, WorkspaceRole::Viewer),
        (&other_viewer, WorkspaceRole::Viewer),
    ] {
        manager
            .upsert_member(&workspace.id, &owner, &p.email, None, role)
            .await
            .unwrap();
    }

    let proposed = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "to approve",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();

    // A viewer (the proposer included) cannot approve their own proposal.
    for non_editor in [&viewer, &other_viewer] {
        let err = manager
            .approve_saved_view(&workspace.id, non_editor, &proposed.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::Forbidden));
    }
    // A non-member is denied before any row is read.
    let stranger = principal("stranger@example.com", false);
    let err = manager
        .approve_saved_view(&workspace.id, &stranger, &proposed.id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    // Still Proposed after the failed attempts.
    let still = store
        .get_saved_view(&workspace.id, &proposed.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still.visibility, SavedViewVisibility::Proposed);

    // The editor approves: it becomes Shared, attribution preserved.
    let approved = manager
        .approve_saved_view(&workspace.id, &editor, &proposed.id)
        .await
        .unwrap();
    assert_eq!(approved.visibility, SavedViewVisibility::Shared);
    assert_eq!(approved.created_by, normalize_email(&viewer.email));
    assert_eq!(approved.created_by_name, proposed.created_by_name);
    assert_eq!(approved.name, "to approve");

    // Now every member sees it as a shared view, including the bystander.
    let seen = manager
        .get_saved_view(&workspace.id, &other_viewer, &proposed.id)
        .await
        .unwrap();
    assert_eq!(seen.visibility, SavedViewVisibility::Shared);

    // Approving a non-proposed (already shared) view is a BadRequest.
    let err = manager
        .approve_saved_view(&workspace.id, &editor, &proposed.id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::BadRequest(_)));

    // A missing id is NotFound; another member's personal view stays
    // NotFound even for an editor (never-leak), not BadRequest.
    let err = manager
        .approve_saved_view(&workspace.id, &editor, "does-not-exist")
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));
    let hidden_personal = manager
        .create_saved_view(
            &workspace.id,
            &other_viewer,
            "private",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let err = manager
        .approve_saved_view(&workspace.id, &editor, &hidden_personal.id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));
}

#[tokio::test]
async fn reject_proposal_reverts_to_proposer_personal_non_destructively() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let other_viewer = principal("bystander@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Reject proposal"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    for (p, role) in [
        (&editor, WorkspaceRole::Editor),
        (&viewer, WorkspaceRole::Viewer),
        (&other_viewer, WorkspaceRole::Viewer),
    ] {
        manager
            .upsert_member(&workspace.id, &owner, &p.email, None, role)
            .await
            .unwrap();
    }

    let proposed = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "to reject",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();

    // A viewer cannot reject.
    let err = manager
        .reject_saved_view(&workspace.id, &viewer, &proposed.id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    // The editor rejects: it reverts to the proposer's PERSONAL view,
    // attribution and payload intact (non-destructive).
    let rejected = manager
        .reject_saved_view(&workspace.id, &editor, &proposed.id)
        .await
        .unwrap();
    assert_eq!(rejected.visibility, SavedViewVisibility::Personal);
    assert_eq!(rejected.created_by, normalize_email(&viewer.email));
    assert_eq!(rejected.name, "to reject");

    // The proposer still owns it privately...
    let still_mine = manager
        .get_saved_view(&workspace.id, &viewer, &proposed.id)
        .await
        .unwrap();
    assert_eq!(still_mine.visibility, SavedViewVisibility::Personal);
    // ...and it is no longer visible to anyone else, including the editor
    // (the review exception only applies while it is pending).
    for other in [&editor, &other_viewer] {
        let err = manager
            .get_saved_view(&workspace.id, other, &proposed.id)
            .await
            .unwrap_err();
        assert!(matches!(err, WorkspaceError::NotFound));
    }

    // Rejecting again (now personal, not proposed) is a BadRequest, and the
    // editor cannot even probe via the personal id once it is hidden again
    // -> NotFound for the now-hidden personal view.
    let err = manager
        .reject_saved_view(&workspace.id, &editor, &proposed.id)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));
}

#[tokio::test]
async fn approve_reject_rest_endpoints_are_editor_only_and_return_updated_view() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Review REST"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
    ));
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &viewer.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    // The viewer proposes (create with visibility Proposed is allowed for a
    // viewer at the manager; the REST create path threads `visibility`
    // straight through `CreateWorkspaceSavedViewRequest`).
    let proposed = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "rest proposal",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();
    let proposed_id = proposed.id.clone();

    // A viewer cannot approve through REST (403).
    let viewer_app = workspace_router_with_principal(Arc::clone(&manager), viewer.clone());
    let res = viewer_app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!(
                    "/api/workspaces/{}/saved-views/{}/approve",
                    workspace.id, proposed_id
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // The owner (editor authority) approves: 200 + updated shared view.
    let owner_app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());
    let res = owner_app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!(
                    "/api/workspaces/{}/saved-views/{}/approve",
                    workspace.id, proposed_id
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = response_json(res).await;
    assert_eq!(body["id"], proposed_id);
    assert_eq!(body["visibility"], "shared");
    assert_eq!(body["created_by"], normalize_email(&viewer.email));

    // Approving the now-shared view again is a 400 (not a proposal).
    let owner_app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());
    let res = owner_app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!(
                    "/api/workspaces/{}/saved-views/{}/reject",
                    workspace.id, proposed_id
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn workspace_viewer_profiles_are_private_and_strip_source_urls() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Headless viewer state"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &viewer.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    let mut view = SavedView::empty([800, 600]);
    view.datasets.push("/tmp/source.zarr".into());
    view.dataset_order.push(DatasetId("wds_headless".into()));

    let saved = manager
        .upsert_viewer_profile(
            &workspace.id,
            &viewer,
            "default",
            Some("document_defaults"),
            view,
        )
        .await
        .unwrap();

    assert_eq!(saved.workspace_id, workspace.id);
    assert_eq!(saved.user_email, viewer.email);
    assert_eq!(saved.profile, "default");
    assert_eq!(saved.seed_source.as_deref(), Some("document_defaults"));
    assert!(saved.view.datasets.is_empty());
    assert_eq!(
        saved.view.dataset_order,
        vec![DatasetId("wds_headless".into())]
    );

    let owner_profile = manager
        .get_viewer_profile(&workspace.id, &owner, "default")
        .await
        .unwrap();
    assert!(owner_profile.is_none());

    let viewer_profile = manager
        .get_viewer_profile(&workspace.id, &viewer, "default")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(viewer_profile.user_email, viewer.email);
    assert_eq!(
        viewer_profile.view.dataset_order,
        vec![DatasetId("wds_headless".into())]
    );
}

#[tokio::test]
async fn workspace_viewer_profiles_reject_invalid_profile_names() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Headless viewer profile names"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    let err = manager
        .upsert_viewer_profile(
            &workspace.id,
            &owner,
            "../escape",
            None,
            SavedView::empty([800, 600]),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::BadRequest(_)));
}

#[tokio::test]
async fn workspace_default_saved_view_is_editor_controlled_and_scoped() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Default view"))
        .await
        .unwrap();
    let other_workspace = store.create_workspace(&owner, Some("Other")).await.unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &editor.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &viewer.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    let saved = manager
        .create_saved_view(
            &workspace.id,
            &owner,
            "default",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap();
    let other_saved = manager
        .create_saved_view(
            &other_workspace.id,
            &owner,
            "other default",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap();

    let (record, role) = manager
        .set_default_saved_view(&workspace.id, &editor, Some(&saved.id))
        .await
        .unwrap();
    assert_eq!(role, WorkspaceRole::Editor);
    assert_eq!(
        record.default_saved_view_id.as_deref(),
        Some(saved.id.as_str())
    );

    let err = manager
        .set_default_saved_view(&workspace.id, &viewer, None)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    let err = manager
        .set_default_saved_view(&workspace.id, &editor, Some(&other_saved.id))
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));

    manager
        .delete_saved_view(&workspace.id, &editor, &saved.id)
        .await
        .unwrap();
    let restored = store.get_workspace(&workspace.id).await.unwrap().unwrap();
    assert!(restored.default_saved_view_id.is_none());
}

#[tokio::test]
async fn workspace_last_view_round_trips_per_user_and_never_touches_default() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Remember my last view"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &viewer.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    // Pin the shared default first so we can prove recording a last view
    // leaves it untouched.
    let shared = manager
        .create_saved_view(
            &workspace.id,
            &owner,
            "shared default",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap();
    manager
        .set_default_saved_view(&workspace.id, &owner, Some(&shared.id))
        .await
        .unwrap();

    // Before any record, the caller's state has no last view.
    let before = manager
        .get_user_workspace_state(&workspace.id, &viewer)
        .await
        .unwrap();
    assert!(before.last_view.is_none());

    // A viewer (lowest role) records their own view; source URLs are
    // stripped, the workspace-local dataset order is kept.
    let mut view = SavedView::empty([1024, 768]);
    view.datasets.push("/secret/source.zarr".into());
    view.dataset_order.push(DatasetId("wds_mine".into()));
    let state = manager
        .set_user_workspace_last_view(&workspace.id, &viewer, view)
        .await
        .unwrap();
    let last = state.last_view.expect("last_view recorded");
    assert!(last.datasets.is_empty(), "source URLs must be stripped");
    assert_eq!(last.dataset_order, vec![DatasetId("wds_mine".into())]);

    // Read-back via the principal-scoped getter sees the same view.
    let got = manager
        .get_user_workspace_state(&workspace.id, &viewer)
        .await
        .unwrap();
    assert_eq!(
        got.last_view.as_ref().map(|v| &v.dataset_order),
        Some(&vec![DatasetId("wds_mine".into())])
    );

    // Invariant: recording a last view never changes the shared default.
    let record = store.get_workspace(&workspace.id).await.unwrap().unwrap();
    assert_eq!(
        record.default_saved_view_id.as_deref(),
        Some(shared.id.as_str())
    );

    // Per-user isolation: another member never sees the viewer's last view.
    let owner_state = manager
        .get_user_workspace_state(&workspace.id, &owner)
        .await
        .unwrap();
    assert!(owner_state.last_view.is_none());
}

#[tokio::test]
async fn workspace_last_view_does_not_disturb_pin_and_recents() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Last view coexists"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    // Establish pin + recents on the owner's row.
    manager
        .set_workspace_pinned(&workspace.id, &owner, true)
        .await
        .unwrap();
    let opened = store
        .record_workspace_open(&workspace.id, &owner)
        .await
        .unwrap();
    assert!(opened.pinned_at.is_some());
    assert!(opened.last_opened_at.is_some());

    // Recording a last view must upsert ONLY last_view, leaving the
    // existing pin/recents intact.
    let state = manager
        .set_user_workspace_last_view(&workspace.id, &owner, SavedView::empty([640, 480]))
        .await
        .unwrap();
    assert!(state.last_view.is_some());
    assert!(
        state.pinned_at.is_some(),
        "pin must survive a last-view write"
    );
    assert!(
        state.last_opened_at.is_some(),
        "recents must survive a last-view write"
    );
}

#[tokio::test]
async fn workspace_last_view_requires_membership() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let stranger = principal("stranger@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Members only"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    let set_err = manager
        .set_user_workspace_last_view(&workspace.id, &stranger, SavedView::empty([800, 600]))
        .await
        .unwrap_err();
    assert!(matches!(set_err, WorkspaceError::Forbidden));

    let get_err = manager
        .get_user_workspace_state(&workspace.id, &stranger)
        .await
        .unwrap_err();
    assert!(matches!(get_err, WorkspaceError::Forbidden));
}

#[tokio::test]
async fn workspace_last_view_absent_on_legacy_rows() {
    // A row written before #700 (here: via record_workspace_open, which
    // leaves last_view_json NULL) reads back last_view = None — the
    // additive migration adds a nullable column with no backfill.
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Legacy"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    store
        .record_workspace_open(&workspace.id, &owner)
        .await
        .unwrap();
    let state = manager
        .get_user_workspace_state(&workspace.id, &owner)
        .await
        .unwrap();
    assert!(state.last_opened_at.is_some());
    assert!(state.last_view.is_none());
}

/// RED TEAM #1 — the self-approve bypass via `approve_saved_view`.
///
/// The #817 change closes Proposed->Shared on `/visibility`
/// (`set_saved_view_visibility`) "so sharing a proposal stays exclusively
/// the editor review queue's job (`approve_saved_view`)". The whole point
/// of a *review queue* is that someone OTHER than the proposer signs off.
/// This test drives the entire creator-only path the change permits
/// (Personal -> Proposed on /visibility, which is on the allow-list) and
/// then has the SAME principal approve their OWN proposal. If that yields
/// Shared, the editor-creator has achieved Proposed->Shared on their own
/// view with no second party — the exact outcome the allow-list was added
/// to forbid, simply routed through approve instead of /visibility.
#[tokio::test]
async fn redteam_editor_self_approves_own_proposal_proposed_to_shared() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("self approve"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &editor.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();

    // Editor creates a Personal view, then proposes it via the very
    // /visibility transition the allow-list blesses (Personal -> Proposed).
    let personal = manager
        .create_saved_view(
            &workspace.id,
            &editor,
            "my view",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let proposed = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &personal.id,
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();
    assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);

    // The SAME editor now approves their OWN proposal.
    let approve_result = manager
        .approve_saved_view(&workspace.id, &editor, &proposed.id)
        .await;

    // The review-queue intent: a proposer cannot be their own reviewer, so
    // self-approval is denied (Forbidden — an authorization act on the view,
    // like the creator-only re-scope gate) and must NOT share the view.
    assert!(
        matches!(approve_result, Err(WorkspaceError::Forbidden)),
        "self-approve must be Forbidden (creator != reviewer), got {approve_result:?}"
    );
    let shared_in_store = store
        .get_saved_view(&workspace.id, &proposed.id)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(
        shared_in_store.visibility,
        SavedViewVisibility::Shared,
        "SELF-APPROVE BYPASS: editor-creator drove their own proposal \
             Proposed->Shared via approve_saved_view. The /visibility allow-list \
             forbids Proposed->Shared for the creator, and approve must enforce \
             the same reviewer!=creator rule so the same person cannot both \
             propose and approve — preserving the review queue.",
    );
    // The proposal is untouched: still Proposed, still the editor's, free for
    // a *different* editor to review.
    assert_eq!(shared_in_store.visibility, SavedViewVisibility::Proposed);
}

/// RED TEAM #2 — single-editor (owner-only) workspace: the proposer is the
/// only person who CAN review. The review queue is structurally a no-op
/// rubber stamp. Owner creates -> proposes -> self-approves -> Shared.
#[tokio::test]
async fn redteam_single_owner_self_approves_in_solo_workspace() {
    let store = fresh_store().await;
    let owner = principal("solo@example.com", false);
    let workspace = store.create_workspace(&owner, Some("solo")).await.unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    let personal = manager
        .create_saved_view(
            &workspace.id,
            &owner,
            "solo view",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let proposed = manager
        .set_saved_view_visibility(
            &workspace.id,
            &owner,
            &personal.id,
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();
    assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);

    let approve_result = manager
        .approve_saved_view(&workspace.id, &owner, &proposed.id)
        .await;
    assert!(
        matches!(approve_result, Err(WorkspaceError::Forbidden)),
        "solo self-approve must be Forbidden (creator != reviewer), got {approve_result:?}"
    );
    let after = store
        .get_saved_view(&workspace.id, &proposed.id)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(
        after.visibility,
        SavedViewVisibility::Shared,
        "SELF-APPROVE BYPASS (solo): the sole owner proposed and approved \
             their own view, reaching Shared with literally no second party."
    );
    // The view is not stranded: it stays Proposed (and the owner can still
    // withdraw it via the legal Proposed->Personal /visibility path, or share
    // their own view directly via Personal->Shared — the queue is for a
    // *different* reviewer).
    assert_eq!(after.visibility, SavedViewVisibility::Proposed);
}

/// RED TEAM #3 — confirm the /visibility allow-list itself holds for the
/// two illegal direct transitions, even attempted by an owner (highest
/// role). These SHOULD be BadRequest (this is the part the change gets
/// right; included so the report is grounded).
#[tokio::test]
async fn redteam_visibility_endpoint_rejects_illegal_transitions_for_owner() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("owner gate"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    // Proposed -> Shared (self-approve) via /visibility must be BadRequest.
    let personal = manager
        .create_saved_view(
            &workspace.id,
            &owner,
            "p1",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let proposed = manager
        .set_saved_view_visibility(
            &workspace.id,
            &owner,
            &personal.id,
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();
    let err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &owner,
            &proposed.id,
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, WorkspaceError::BadRequest(_)),
        "Proposed->Shared via /visibility must be BadRequest, got {err:?}"
    );

    // Shared -> Proposed via /visibility must be BadRequest.
    let p2 = manager
        .create_saved_view(
            &workspace.id,
            &owner,
            "p2",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let shared = manager
        .set_saved_view_visibility(&workspace.id, &owner, &p2.id, SavedViewVisibility::Shared)
        .await
        .unwrap();
    let err2 = manager
        .set_saved_view_visibility(
            &workspace.id,
            &owner,
            &shared.id,
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err2, WorkspaceError::BadRequest(_)),
        "Shared->Proposed via /visibility must be BadRequest, got {err2:?}"
    );
}

/// RED TEAM #4 — never-leak ordering on the NEW allow-list deny.
///
/// A workspace MEMBER who is not the creator attempts an ILLEGAL transition
/// (Proposed->Shared) on another member's *Proposed* view. Because Proposed
/// is creator-private (ensure_saved_view_readable treats Proposed like
/// Personal), the readability check must fire FIRST and yield NotFound —
/// identical to a missing id — so the BadRequest allow-list error never
/// leaks the view's existence. If this ever returned BadRequest, a stranger
/// could distinguish "exists but illegal" from "absent".
#[tokio::test]
async fn redteam_illegal_transition_does_not_leak_hidden_proposed_view() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let other_editor = principal("other-editor@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("leak gate"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    for p in [&editor, &other_editor] {
        manager
            .upsert_member(&workspace.id, &owner, &p.email, None, WorkspaceRole::Editor)
            .await
            .unwrap();
    }

    // `editor` owns a Proposed view (creator-private until reviewed).
    let personal = manager
        .create_saved_view(
            &workspace.id,
            &editor,
            "hidden",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let proposed = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &personal.id,
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();

    // `other_editor` (a non-creator member) attempts the illegal
    // Proposed->Shared transition on a view they cannot read.
    let leak_err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &other_editor,
            &proposed.id,
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();
    let missing_err = manager
        .set_saved_view_visibility(
            &workspace.id,
            &other_editor,
            "does-not-exist",
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap_err();

    // Both must be NotFound (indistinguishable). A BadRequest here would be
    // a never-leak hole: it confirms the hidden Proposed view exists.
    assert!(
        matches!(leak_err, WorkspaceError::NotFound),
        "NEVER-LEAK: illegal transition on a hidden Proposed view must be \
             NotFound (uniform with a missing id), got {leak_err:?}"
    );
    assert!(matches!(missing_err, WorkspaceError::NotFound));
}

/// RED TEAM #5 — created_by preservation across approve (the only
/// Proposed->Shared path). Confirms authorship is not reassigned to the
/// reviewer. (Sanity guard for the created_by-tampering axis.)
#[tokio::test]
async fn redteam_approve_preserves_created_by_not_reviewer() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let workspace = store.create_workspace(&owner, Some("attr")).await.unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    for (p, role) in [
        (&editor, WorkspaceRole::Editor),
        (&viewer, WorkspaceRole::Viewer),
    ] {
        manager
            .upsert_member(&workspace.id, &owner, &p.email, None, role)
            .await
            .unwrap();
    }
    let proposed = manager
        .create_saved_view(
            &workspace.id,
            &viewer,
            "bid",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();
    let approved = manager
        .approve_saved_view(&workspace.id, &editor, &proposed.id)
        .await
        .unwrap();
    assert_eq!(
        approved.created_by,
        normalize_email(&viewer.email),
        "created_by must stay the proposer, not become the reviewer"
    );
}

/// The self-approve guard must NOT be over-broad: a *different* editor can
/// still approve a proposal whose creator is themselves an editor. This is
/// the precise over-reach risk of a creator!=reviewer check — it must gate on
/// the *individual*, not the role, so the normal two-party review flow keeps
/// working when the proposer happens to be an editor/owner.
#[tokio::test]
async fn different_editor_can_approve_an_editor_creators_proposal() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let reviewer = principal("reviewer@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("two editors"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    for p in [&editor, &reviewer] {
        manager
            .upsert_member(&workspace.id, &owner, &p.email, None, WorkspaceRole::Editor)
            .await
            .unwrap();
    }

    // An editor creates and proposes their own view (legal Personal->Proposed).
    let personal = manager
        .create_saved_view(
            &workspace.id,
            &editor,
            "shared candidate",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let proposed = manager
        .set_saved_view_visibility(
            &workspace.id,
            &editor,
            &personal.id,
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();
    assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);

    // The creator-editor still cannot self-approve...
    let self_err = manager
        .approve_saved_view(&workspace.id, &editor, &proposed.id)
        .await
        .unwrap_err();
    assert!(matches!(self_err, WorkspaceError::Forbidden));

    // ...but a DIFFERENT editor can — the two-party review flow is intact and
    // the original author keeps attribution.
    let approved = manager
        .approve_saved_view(&workspace.id, &reviewer, &proposed.id)
        .await
        .unwrap();
    assert_eq!(approved.visibility, SavedViewVisibility::Shared);
    assert_eq!(approved.created_by, normalize_email(&editor.email));
}

/// The self-approve guard is scoped to APPROVE only: a creator may still
/// self-*reject* (withdraw) their own proposal, reverting it to their own
/// Personal view (Proposed->Personal). Rejecting is non-destructive and the
/// equivalent withdraw is already legal via /visibility, so it must keep
/// working for the proposer.
#[tokio::test]
async fn creator_can_self_reject_to_withdraw_own_proposal() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("withdraw"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    let personal = manager
        .create_saved_view(
            &workspace.id,
            &owner,
            "to withdraw",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    let proposed = manager
        .set_saved_view_visibility(
            &workspace.id,
            &owner,
            &personal.id,
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap();
    assert_eq!(proposed.visibility, SavedViewVisibility::Proposed);

    // The creator rejects their OWN proposal: allowed (withdraw), reverts to
    // their Personal view non-destructively.
    let rejected = manager
        .reject_saved_view(&workspace.id, &owner, &proposed.id)
        .await
        .unwrap();
    assert_eq!(rejected.visibility, SavedViewVisibility::Personal);
    assert_eq!(rejected.created_by, normalize_email(&owner.email));
    assert_eq!(rejected.name, "to withdraw");
}
