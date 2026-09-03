use super::*;

#[tokio::test]
async fn duplicate_route_returns_201_for_member_and_404_for_non_member() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Routed"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
    ));

    // Owner POSTs /duplicate → 201 Created, owns the copy named "Copy of …".
    let app = workspace_router_with_principal(Arc::clone(&manager), owner);
    let res = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/workspaces/{}/duplicate", workspace.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body = response_json(res).await;
    assert_eq!(body["name"], "Copy of Routed");
    assert_eq!(body["role"], "owner");
    assert_ne!(body["id"], serde_json::Value::String(workspace.id.clone()));

    // A non-member POSTing /duplicate gets 404 — byte-identical to a missing
    // workspace (never-leak). Duplication must not reveal it.
    let stranger = principal("mallory@example.com", false);
    let app2 = workspace_router_with_principal(Arc::clone(&manager), stranger);
    let res2 = app2
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/workspaces/{}/duplicate", workspace.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res2.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn bearer_authenticates_workspace_websocket_upgrade() {
    let store = fresh_store().await;
    let owner = principal("cli@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Bearer WS"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        ProxyConfig::defaults(),
    ));

    let raw_token = "lucida_pat_ws_test";
    let now = Utc::now();
    let bearer_store = Arc::new(MemoryBearerTokenStore::new());
    bearer_store
        .create(BearerToken {
            id: "ws-token".into(),
            token_hash: hash_bearer_token(raw_token),
            name: "ws test".into(),
            email: owner.email.clone(),
            display_name: owner.display_name.clone(),
            picture_url: owner.picture_url.clone(),
            created_at: now,
            last_used_at: None,
            expires_at: now + chrono::Duration::hours(1),
            revoked_at: None,
        })
        .await
        .unwrap();
    let mut config = AuthConfig::for_tests();
    config.mode = AuthMode::Google;
    let extractor: Arc<dyn PrincipalExtractor> = Arc::new(DualCredentialExtractor::new(
        Arc::new(config),
        Arc::new(MemorySessionStore::new()) as Arc<dyn LoginSessionStore>,
        Arc::clone(&bearer_store) as Arc<dyn BearerTokenStore>,
    ));
    let app = router(manager).layer(axum::middleware::from_fn_with_state(
        extractor,
        crate::auth::middleware::auth_middleware,
    ));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let url = format!(
        "ws://{addr}/ws/workspaces/{}",
        urlencoding::encode(&workspace.id)
    );
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {raw_token}").parse().unwrap(),
    );

    let (socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SWITCHING_PROTOCOLS
    );
    drop(socket);
    server.abort();
}

#[tokio::test]
async fn workspace_router_builds_with_archived_static_route() {
    let store = fresh_store().await;
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        ProxyConfig::defaults(),
    ));
    let _router = router(manager);
}

#[tokio::test]
async fn admin_support_routes_require_admin_even_for_workspace_owner() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Support deny"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        ProxyConfig::defaults(),
    ));
    let app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());

    let requests = [
        Request::builder()
            .method(Method::GET)
            .uri("/admin/workspaces")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .method(Method::GET)
            .uri(format!("/admin/workspaces/{}", workspace.id))
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .method(Method::POST)
            .uri(format!("/admin/workspaces/{}/archive", workspace.id))
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .method(Method::POST)
            .uri(format!("/admin/workspaces/{}/restore", workspace.id))
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .method(Method::POST)
            .uri(format!("/admin/workspaces/{}/owners", workspace.id))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"email":"owner@example.com"}"#))
            .unwrap(),
    ];

    for req in requests {
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn admin_support_route_returns_details_without_membership() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let admin = principal("admin@example.com", true);
    let workspace = store
        .create_workspace(&owner, Some("Support details"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        ProxyConfig::defaults(),
    ));
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &editor.email,
            Some("Editor User"),
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    let app = workspace_router_with_principal(Arc::clone(&manager), admin);

    let res = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/admin/workspaces/{}", workspace.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = response_json(res).await;
    assert_eq!(body["workspace"]["id"], workspace.id);
    assert_eq!(body["workspace"]["member_count"], 2);
    assert_eq!(body["workspace"]["owner_count"], 1);
    assert_eq!(body["members"][0]["email"], "owner@example.com");
    assert_eq!(body["members"][1]["email"], "editor@example.com");
}

#[tokio::test]
async fn last_view_rest_round_trips_and_preserves_default() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Last view REST"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
    ));

    // Pin a shared default so we can prove the last-view PATCH leaves it.
    let shared = manager
        .create_saved_view(
            &workspace.id,
            &owner,
            "shared",
            SavedView::empty([800, 600]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap();
    manager
        .set_default_saved_view(&workspace.id, &owner, Some(&shared.id))
        .await
        .unwrap();

    let app = workspace_router_with_principal(Arc::clone(&manager), owner.clone());

    // GET user-state before any record: last_view is null.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/workspaces/{}/user-state", workspace.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = response_json(res).await;
    assert!(body["last_view"].is_null());

    // PATCH last-view with a {view} body.
    let view = SavedView::empty([1024, 768]);
    let payload = serde_json::json!({ "view": view });
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::PATCH)
                .uri(format!("/api/workspaces/{}/last-view", workspace.id))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&payload).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = response_json(res).await;
    assert_eq!(body["workspace_id"], workspace.id);
    assert!(!body["last_view"].is_null());

    // GET user-state now returns the remembered view.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/workspaces/{}/user-state", workspace.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(res).await;
    assert_eq!(body["last_view"]["v"], 1);

    // Invariant at the wire layer: the shared default is untouched.
    let record = store.get_workspace(&workspace.id).await.unwrap().unwrap();
    assert_eq!(
        record.default_saved_view_id.as_deref(),
        Some(shared.id.as_str())
    );
}

#[tokio::test]
async fn admin_support_search_and_lifecycle_override_without_membership() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Support lifecycle"))
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

    let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();
    let mut rx = live.tx.subscribe();

    let rows = manager
        .admin_search_workspaces(Some("editor@example.com"), false, 10)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, workspace.id);
    assert_eq!(rows[0].member_count, 2);
    assert_eq!(rows[0].owner_count, 1);

    let archived = manager
        .admin_archive_workspace(&workspace.id)
        .await
        .unwrap();
    assert!(archived.workspace.archived_at.is_some());
    assert!(!manager.live.lock().await.contains_key(&workspace.id));
    let item = rx.recv().await.unwrap();
    assert!(matches!(item, BroadcastItem::WorkspaceArchived { .. }));
    assert!(store.list_workspaces(&owner).await.unwrap().is_empty());

    assert!(
        manager
            .admin_search_workspaces(Some("support lifecycle"), false, 10)
            .await
            .unwrap()
            .is_empty()
    );
    let archived_rows = manager
        .admin_search_workspaces(Some("support lifecycle"), true, 10)
        .await
        .unwrap();
    assert_eq!(archived_rows.len(), 1);
    assert!(archived_rows[0].archived_at.is_some());

    let restored = manager
        .admin_restore_workspace(&workspace.id)
        .await
        .unwrap();
    assert!(restored.workspace.archived_at.is_none());
    assert_eq!(store.list_workspaces(&owner).await.unwrap().len(), 1);
}

#[tokio::test]
async fn admin_can_recover_orphaned_workspace_owner() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let recovered = principal("Recovered@Example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Orphaned"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    assert!(
        store
            .remove_member(&workspace.id, &owner.email)
            .await
            .unwrap()
    );
    let details = manager
        .admin_workspace_details(&workspace.id)
        .await
        .unwrap();
    assert_eq!(details.workspace.owner_count, 0);
    // The former owner was removed, so they are now a non-member: opening the
    // workspace must be indistinguishable from a missing one (never-leak),
    // i.e. NotFound rather than Forbidden. (Recovery is admin-only, below.)
    let err = manager
        .get_workspace_for(&workspace.id, &owner)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::NotFound));

    let member = manager
        .admin_upsert_owner(&workspace.id, &recovered.email, Some("Recovered Owner"))
        .await
        .unwrap();
    assert_eq!(member.email, "recovered@example.com");
    assert_eq!(member.role, WorkspaceRole::Owner);
    assert_eq!(
        store.role_for(&workspace.id, &recovered).await.unwrap(),
        Some(WorkspaceRole::Owner)
    );

    let err = manager
        .update_member_role(
            &workspace.id,
            &recovered,
            &recovered.email,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::BadRequest(_)));
}

#[tokio::test]
async fn owner_can_add_explicit_member_role() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let other = principal("other@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Shared"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    let member = manager
        .upsert_member(
            &workspace.id,
            &owner,
            "Other@Example.com",
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();

    assert_eq!(member.email, "other@example.com");
    assert_eq!(
        store.role_for(&workspace.id, &other).await.unwrap(),
        Some(WorkspaceRole::Editor)
    );
    let rows = store.list_workspaces(&other).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].role, WorkspaceRole::Editor);
}

#[tokio::test]
async fn anyone_with_link_grants_configured_non_owner_role() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let other = principal("other@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Linked"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    assert_eq!(store.role_for(&workspace.id, &other).await.unwrap(), None);

    manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();
    assert_eq!(
        store.role_for(&workspace.id, &other).await.unwrap(),
        Some(WorkspaceRole::Viewer)
    );

    manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    assert_eq!(
        store.role_for(&workspace.id, &other).await.unwrap(),
        Some(WorkspaceRole::Editor)
    );

    let err = manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Owner,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::BadRequest(_)));
}

#[tokio::test]
async fn explicit_membership_overrides_link_role() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let other = principal("other@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Linked member"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &other.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();

    assert_eq!(
        store.role_for(&workspace.id, &other).await.unwrap(),
        Some(WorkspaceRole::Editor)
    );
}

#[tokio::test]
async fn link_workspace_enters_recents_only_after_successful_open() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let visitor = principal("visitor@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Linked recent"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    assert!(store.list_workspaces(&visitor).await.unwrap().is_empty());

    let (_record, role, state) = manager
        .open_workspace_for(&workspace.id, &visitor)
        .await
        .unwrap();
    assert_eq!(role, WorkspaceRole::Viewer);
    assert_eq!(state.workspace_id, workspace.id);
    assert!(state.last_opened_at.is_some());

    let rows = store.list_workspaces(&visitor).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, workspace.id);
    assert_eq!(rows[0].role, WorkspaceRole::Viewer);
    assert!(rows[0].last_opened_at.is_some());
    assert!(rows[0].pinned_at.is_none());
}

#[tokio::test]
async fn link_recents_do_not_make_workspaces_globally_discoverable() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let visitor = principal("visitor@example.com", false);
    let stranger = principal("stranger@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Private link"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();
    manager
        .open_workspace_for(&workspace.id, &visitor)
        .await
        .unwrap();

    assert_eq!(store.list_workspaces(&visitor).await.unwrap().len(), 1);
    assert!(store.list_workspaces(&stranger).await.unwrap().is_empty());
}

#[tokio::test]
async fn pins_are_personal_and_sort_before_recents() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let teammate = principal("teammate@example.com", false);
    let first = store.create_workspace(&owner, Some("First")).await.unwrap();
    let second = store
        .create_workspace(&owner, Some("Second"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .upsert_member(
            &first.id,
            &owner,
            &teammate.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();
    manager
        .upsert_member(
            &second.id,
            &owner,
            &teammate.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    manager
        .open_workspace_for(&second.id, &owner)
        .await
        .unwrap();
    manager.open_workspace_for(&first.id, &owner).await.unwrap();
    manager
        .set_workspace_pinned(&second.id, &owner, true)
        .await
        .unwrap();

    let owner_rows = store.list_workspaces(&owner).await.unwrap();
    assert_eq!(owner_rows[0].id, second.id);
    assert!(owner_rows[0].pinned_at.is_some());

    let teammate_rows = store.list_workspaces(&teammate).await.unwrap();
    let teammate_second = teammate_rows
        .iter()
        .find(|row| row.id == second.id)
        .expect("teammate can see second workspace");
    assert!(teammate_second.pinned_at.is_none());
}

#[tokio::test]
async fn link_only_recent_disappears_when_link_access_is_disabled() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let visitor = principal("visitor@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Disable link"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    manager
        .open_workspace_for(&workspace.id, &visitor)
        .await
        .unwrap();
    manager
        .set_workspace_pinned(&workspace.id, &visitor, true)
        .await
        .unwrap();

    assert_eq!(store.list_workspaces(&visitor).await.unwrap().len(), 1);

    manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::Restricted,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    assert!(store.list_workspaces(&visitor).await.unwrap().is_empty());
}

#[tokio::test]
async fn unpin_without_existing_state_does_not_create_link_recent() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let visitor = principal("visitor@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("No accidental recent"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    let state = manager
        .set_workspace_pinned(&workspace.id, &visitor, false)
        .await
        .unwrap();
    assert!(state.last_opened_at.is_none());
    assert!(state.pinned_at.is_none());
    assert!(store.list_workspaces(&visitor).await.unwrap().is_empty());
}

#[tokio::test]
async fn archive_restore_is_owner_only_and_controls_dashboard_visibility() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let editor = principal("editor@example.com", false);
    let viewer = principal("viewer@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Lifecycle"))
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

    let err = manager
        .archive_workspace(&workspace.id, &editor)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));
    let err = manager
        .archive_workspace(&workspace.id, &viewer)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    let (archived, role) = manager
        .archive_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    assert_eq!(role, WorkspaceRole::Owner);
    assert!(archived.archived_at.is_some());
    assert!(store.list_workspaces(&owner).await.unwrap().is_empty());
    assert!(store.list_workspaces(&editor).await.unwrap().is_empty());

    let owner_archived = store.list_archived_workspaces(&owner).await.unwrap();
    assert_eq!(owner_archived.len(), 1);
    assert_eq!(owner_archived[0].id, workspace.id);
    assert!(
        store
            .list_archived_workspaces(&editor)
            .await
            .unwrap()
            .is_empty()
    );

    let err = manager
        .restore_workspace(&workspace.id, &viewer)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));

    let (restored, role) = manager
        .restore_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    assert_eq!(role, WorkspaceRole::Owner);
    assert!(restored.archived_at.is_none());
    assert_eq!(store.list_workspaces(&owner).await.unwrap().len(), 1);
    assert_eq!(store.list_workspaces(&editor).await.unwrap().len(), 1);
    assert!(
        store
            .list_archived_workspaces(&owner)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn archived_workspace_blocks_new_access_until_restored() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Archived access"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    manager
        .archive_workspace(&workspace.id, &owner)
        .await
        .unwrap();

    let err = manager
        .get_workspace_for(&workspace.id, &owner)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Archived));
    let err = match manager.live_workspace(&workspace.id, &owner).await {
        Ok(_) => panic!("archived workspace unexpectedly opened a live session"),
        Err(err) => err,
    };
    assert!(matches!(err, WorkspaceError::Archived));

    manager
        .restore_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    assert!(
        manager
            .get_workspace_for(&workspace.id, &owner)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn workspace_open_never_leaks_existence_to_non_member() {
    // NEVER-LEAK regression (annotation share-by-link, slice 3): the
    // workspace-open response a deep-link recipient receives must be
    // byte-identical whether the workspace exists-but-is-restricted, is
    // archived, or never existed. Otherwise a recipient enumerates which
    // workspaces/annotations exist via the Network tab. Folded from the
    // red-team family `annotation_deeplink_neverleak_family.json` cases
    // nl-http-restricted-exists-vs-missing, nl-http-deleted-vs-missing,
    // and nl-http-control-member-ok.
    let store = fresh_store().await;
    let alice = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);

    // A default (restricted) workspace alice owns; bob is not a member.
    let restricted = store
        .create_workspace(&alice, Some("Restricted"))
        .await
        .unwrap();
    // A workspace alice owns then archives; bob is not a member.
    let archived = store
        .create_workspace(&alice, Some("Archived"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    manager
        .archive_workspace(&archived.id, &alice)
        .await
        .unwrap();

    let missing = open_status_body(&manager, "does-not-exist-xyz", &bob).await;
    let restricted_exists = open_status_body(&manager, &restricted.id, &bob).await;
    let archived_exists = open_status_body(&manager, &archived.id, &bob).await;

    // The control: a missing workspace is 404 {"error":"not_found"}.
    assert_eq!(missing.0, StatusCode::NOT_FOUND);
    assert_eq!(missing.1, json!({ "error": "not_found" }));

    // exists-but-restricted is indistinguishable from missing.
    assert_eq!(
        restricted_exists, missing,
        "restricted-but-existing open must be byte-identical to a missing one for a non-member"
    );
    // archived is also indistinguishable from missing (no 410 leak to a non-member).
    assert_eq!(
        archived_exists, missing,
        "archived open must be byte-identical to a missing one for a non-member"
    );

    // Control: a real member (the owner) still opens the restricted one (200),
    // so the never-leak collapse did not over-collapse access for everyone.
    let owner_open = open_status_body(&manager, &restricted.id, &alice).await;
    assert_eq!(owner_open.0, StatusCode::OK);

    // Control: a member still learns their OWN archived workspace is archived
    // (410), the one party that already knows it exists.
    let owner_archived = open_status_body(&manager, &archived.id, &alice).await;
    assert_eq!(owner_archived.0, StatusCode::GONE);
    assert_eq!(owner_archived.1, json!({ "error": "workspace_archived" }));
}

#[tokio::test]
async fn workspace_open_anyone_with_link_still_grants_access() {
    // The never-leak collapse must NOT break the share-by-link grant: a
    // non-member opening an anyone-with-link workspace still gets 200 and the
    // configured link role (the "deep-link is not a grant, but the link
    // *role* is" path the feature relies on).
    let store = fresh_store().await;
    let alice = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let workspace = store
        .create_workspace(&alice, Some("Linked"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    // Before enabling the link, bob is a non-member → never-leak 404.
    let before = open_status_body(&manager, &workspace.id, &bob).await;
    assert_eq!(before.0, StatusCode::NOT_FOUND);

    manager
        .update_link_access(
            &workspace.id,
            &alice,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    let (record, role) = manager
        .get_workspace_for(&workspace.id, &bob)
        .await
        .unwrap();
    assert_eq!(record.id, workspace.id);
    assert_eq!(role, WorkspaceRole::Viewer);
}

#[tokio::test]
async fn archiving_revokes_live_workspace_and_denies_new_mutations() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Live archive"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());
    let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();
    let mut rx = live.tx.subscribe();

    manager
        .archive_workspace(&workspace.id, &owner)
        .await
        .unwrap();

    assert!(live.background_cancelled());
    assert!(!manager.live.lock().await.contains_key(&workspace.id));
    let item = rx.recv().await.unwrap();
    let BroadcastItem::WorkspaceArchived { json } = item else {
        panic!("expected workspace archived broadcast");
    };
    let msg: ServerMessage = serde_json::from_str(&json).unwrap();
    match msg {
        ServerMessage::WorkspaceArchived { workspace_id } => {
            assert_eq!(workspace_id, workspace.id);
        }
        _ => panic!("expected workspace archived server message"),
    }

    let err = manager
        .require_editor(&workspace.id, &owner)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::Forbidden));
}

#[tokio::test]
async fn idle_eviction_drops_empty_live_workspace_and_reopen_restores_document() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Idle restore"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new_with_runtime_config(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
        idle_eviction_config(),
    );
    let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();

    store
        .persist_document(&workspace.id, 7, &DocumentState::default())
        .await
        .unwrap();

    let evicted = manager.evict_idle_workspaces().await;
    assert_eq!(evicted, 1);
    assert!(live.background_cancelled());
    assert_eq!(manager.live_workspace_count().await, 0);

    let reopened = manager.live_workspace(&workspace.id, &owner).await.unwrap();
    assert!(!Arc::ptr_eq(&live, &reopened));
    assert_eq!(reopened.session.lock().await.seq, 7);
}

#[tokio::test]
async fn presence_identity_is_never_persisted_into_document_json() {
    // PRIVACY INVARIANT (#540 review): peer identity (display name, avatar,
    // initial — and certainly any email) is EPHEMERAL session presence. It
    // must NEVER cross into the persisted workspace document, or a stale
    // identity / address would leak through `document_json` on every reload
    // and to anyone the workspace is later shared with. Presence lives only
    // on `Session::clients`; the document is built solely from sequenced
    // commands. This guards that separation across a real persist+reload.
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Presence privacy"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new_with_runtime_config(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
        idle_eviction_config(),
    );
    let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();

    // A connected client carries a fully-populated server-authored identity
    // — name, avatar URL, and the precomputed initial — on its presence.
    let identity = lucida_core::protocol::PeerIdentity {
        display_name: "Grace Hopper".into(),
        picture_url: Some("https://avatars.example.com/grace.png".into()),
        initial: "G".into(),
    };
    // Apply a real document command too, so the document is non-empty and we
    // prove identity stays out even alongside genuine document content. The
    // annotation author is deliberately NOT an identity string.
    let seq = {
        let mut sess = live.session.lock().await;
        sess.add_client(7, Some(identity.clone()));
        assert!(
            sess.clients.get(&7).unwrap().identity.is_some(),
            "presence carries identity on the live session"
        );
        sess.apply(DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [1.0, 2.0],
            end: None,
            z: 0.0,
            t: 0,
            c: 0,
            author: "anon".into(),
            kind: lucida_core::scene::AnnotationKind::Point,
            view: None,
        })
    };

    // Persist exactly what the server writes: the session's document.
    let persisted_json = {
        let sess = live.session.lock().await;
        store
            .persist_document(&workspace.id, seq, &sess.document)
            .await
            .unwrap();
        serde_json::to_string(&sess.document).unwrap()
    };

    // The bytes that hit `document_json` carry no presence identity at all.
    let assert_no_identity = |json: &str, where_: &str| {
        for needle in [
            "Grace Hopper",
            "avatars.example.com",
            "grace.png",
            "owner@example.com",
            "display_name",
            "picture_url",
            "\"identity\"",
            "\"initial\"",
            "@",
        ] {
            assert!(
                !json.contains(needle),
                "{where_}: document_json must not contain presence identity \
                     ({needle:?}); presence is ephemeral, never persisted: {json}"
            );
        }
        // Sanity: the genuine document content IS there.
        assert!(json.contains("pin-1"), "{where_}: document content present");
    };
    assert_no_identity(&persisted_json, "serialized session document");

    // The client disconnects (presence is ephemeral), leaving the workspace
    // idle so it can be evicted and rehydrated from the store below.
    live.session.lock().await.remove_client(7);

    // Reload through the real path: evict the live workspace, reopen it so the
    // document is rehydrated straight from `document_json`. The reloaded
    // DocumentState and its re-serialization are equally identity-free, and
    // presence does not survive — `clients` is empty on the fresh session.
    assert_eq!(manager.evict_idle_workspaces().await, 1);
    let reopened = manager.live_workspace(&workspace.id, &owner).await.unwrap();
    let reloaded_json = {
        let sess = reopened.session.lock().await;
        assert!(
            sess.clients.is_empty(),
            "reloaded session starts with no presence (ephemeral)"
        );
        serde_json::to_string(&sess.document).unwrap()
    };
    assert_no_identity(&reloaded_json, "reloaded document");
}

#[tokio::test]
async fn active_live_workspace_is_not_idle_evicted() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Active"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new_with_runtime_config(
        Arc::new(store),
        ProxyConfig::defaults(),
        idle_eviction_config(),
    );
    let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();
    live.session.lock().await.add_client(42, None);

    let evicted = manager.evict_idle_workspaces().await;
    assert_eq!(evicted, 0);
    assert!(!live.background_cancelled());
    assert_eq!(manager.live_workspace_count().await, 1);
}

#[tokio::test]
async fn idle_eviction_preserves_dataset_source_membership_for_reuse() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Reusable source"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new_with_runtime_config(
        Arc::new(store.clone()),
        ProxyConfig::defaults(),
        idle_eviction_config(),
    );
    let workspace_dataset_id = DatasetId("wds-reusable".into());

    manager.live_workspace(&workspace.id, &owner).await.unwrap();
    store
        .persist_dataset_opened(
            &workspace.id,
            &workspace_dataset_id,
            "ds_reusable_source",
            "file:///tmp/reusable.zarr",
            "reusable.zarr",
            &owner.email,
            1,
            &DocumentState::default(),
        )
        .await
        .unwrap();

    assert_eq!(manager.evict_idle_workspaces().await, 1);
    let sources = store.list_dataset_sources(&workspace.id).await.unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].workspace_dataset_id, workspace_dataset_id);
    assert_eq!(sources[0].dataset_source_id, "ds_reusable_source");
}

#[tokio::test]
async fn last_owner_cannot_be_removed_or_demoted() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let other_owner = principal("other-owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Owners"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), ProxyConfig::defaults());

    let err = manager
        .update_member_role(&workspace.id, &owner, &owner.email, WorkspaceRole::Viewer)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::BadRequest(_)));

    let err = manager
        .remove_member(&workspace.id, &owner, &owner.email)
        .await
        .unwrap_err();
    assert!(matches!(err, WorkspaceError::BadRequest(_)));

    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &other_owner.email,
            None,
            WorkspaceRole::Owner,
        )
        .await
        .unwrap();
    manager
        .update_member_role(&workspace.id, &owner, &owner.email, WorkspaceRole::Viewer)
        .await
        .unwrap();

    assert_eq!(
        store.role_for(&workspace.id, &owner).await.unwrap(),
        Some(WorkspaceRole::Viewer)
    );
    assert_eq!(
        store.role_for(&workspace.id, &other_owner).await.unwrap(),
        Some(WorkspaceRole::Owner)
    );
}
