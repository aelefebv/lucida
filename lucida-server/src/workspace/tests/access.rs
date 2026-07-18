use super::*;

#[tokio::test]
async fn create_lists_owner_workspace() {
    let store = fresh_store().await;
    let p = principal("Alice@Example.com", false);

    let workspace = store.create_workspace(&p, None).await.unwrap();
    assert_eq!(workspace.name, "Untitled workspace");

    let rows = store.list_workspaces(&p).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, workspace.id);
    assert_eq!(rows[0].role, WorkspaceRole::Owner);
}

#[tokio::test]
async fn annotation_identity_is_server_stamped_and_editor_ownership_is_enforced() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let alice = principal("alice@example.com", false);
    let bob = principal("bob@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Annotation policy"))
        .await
        .unwrap();
    let dataset_id = open_dataset_into(
        &store,
        &workspace.id,
        &owner,
        "annotation-policy-source",
        "file:///data/annotation-policy.zarr",
        "Annotation policy dataset",
        1,
    )
    .await;
    let manager = WorkspaceManager::new(Arc::new(store), DatasetRuntimeConfig::defaults());
    for member in [&alice, &bob] {
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &member.email,
                None,
                WorkspaceRole::Editor,
            )
            .await
            .unwrap();
    }
    let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();

    let (_, applied) = manager
        .apply_document_command(
            &live,
            &alice,
            DocumentCommand::AddAnnotation {
                dataset_id: dataset_id.clone(),
                id: "pin".into(),
                position: [1.0, 2.0],
                end: None,
                z: 0.0,
                t: 0,
                c: 0,
                author: owner.email.clone(),
                kind: lucida_core::scene::AnnotationKind::Point,
                view: None,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        applied,
        DocumentCommand::AddAnnotation { author, .. } if author == alice.email
    ));

    let denied = manager
        .apply_document_command(
            &live,
            &bob,
            DocumentCommand::MoveAnnotation {
                dataset_id: dataset_id.clone(),
                id: "pin".into(),
                position: [9.0, 9.0],
                end: None,
                z: 0.0,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(denied, CommandApplyError::Forbidden));
    assert_eq!(
        live.session.lock().await.document.annotations[&dataset_id][0].position,
        [1.0, 2.0]
    );

    // Workspace owners retain explicit moderation authority.
    manager
        .apply_document_command(
            &live,
            &owner,
            DocumentCommand::RemoveAnnotation {
                dataset_id,
                id: "pin".into(),
            },
        )
        .await
        .unwrap();
    assert!(live.session.lock().await.document.annotations.is_empty());
}

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
        DatasetRuntimeConfig::defaults(),
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

async fn websocket_handshake_status(request: Request<()>) -> StatusCode {
    match tokio_tungstenite::connect_async(request).await {
        Ok((socket, response)) => {
            drop(socket);
            response.status()
        }
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => response.status(),
        Err(error) => panic!("unexpected WebSocket handshake failure: {error}"),
    }
}

fn bearer_websocket_request(url: &str, raw_token: &str, origin: Option<&str>) -> Request<()> {
    let mut request = url.into_client_request().unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {raw_token}").parse().unwrap(),
    );
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
    }
    request
}

#[tokio::test]
async fn workspace_websocket_enforces_origin_policy_before_attachment() {
    let store = fresh_store().await;
    let owner = principal("cli@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Bearer WS"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
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
    // A browser request through a router that forgot to install the origin
    // policy must fail closed before lazy workspace restoration.
    let app_without_policy =
        router(Arc::clone(&manager)).layer(axum::middleware::from_fn_with_state(
            Arc::clone(&extractor),
            crate::auth::middleware::auth_middleware,
        ));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app_without_policy).await.unwrap();
    });
    let url = format!(
        "ws://{addr}/ws/workspaces/{}",
        urlencoding::encode(&workspace.id)
    );
    assert_eq!(
        websocket_handshake_status(bearer_websocket_request(
            &url,
            raw_token,
            Some(&format!("http://{addr}")),
        ))
        .await,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(manager.live_workspace_count().await, 0);
    server.abort();

    let policy =
        crate::origin::OriginPolicy::new(vec!["https://ui.example.test".to_string()], false)
            .unwrap();
    let app = router(Arc::clone(&manager))
        .layer(axum::middleware::from_fn_with_state(
            extractor,
            crate::auth::middleware::auth_middleware,
        ))
        .layer(axum::Extension(policy));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let url = format!(
        "ws://{addr}/ws/workspaces/{}",
        urlencoding::encode(&workspace.id)
    );

    for denied_origin in [
        "https://sibling.example.test",
        "https://ui.example.test/path",
        "null",
    ] {
        assert_eq!(
            websocket_handshake_status(bearer_websocket_request(
                &url,
                raw_token,
                Some(denied_origin),
            ))
            .await,
            StatusCode::FORBIDDEN,
            "origin {denied_origin:?} must be denied",
        );
        assert_eq!(
            manager.live_workspace_count().await,
            0,
            "origin denial must happen before workspace attachment",
        );
    }

    // Originless CLI/automation clients, the exact same Host browser origin,
    // and an explicitly configured cross-origin UI are the three supported
    // admission paths.
    assert_eq!(
        websocket_handshake_status(bearer_websocket_request(&url, raw_token, None)).await,
        StatusCode::SWITCHING_PROTOCOLS,
    );
    assert_eq!(
        websocket_handshake_status(bearer_websocket_request(
            &url,
            raw_token,
            Some(&format!("http://{addr}")),
        ))
        .await,
        StatusCode::SWITCHING_PROTOCOLS,
    );
    assert_eq!(
        websocket_handshake_status(bearer_websocket_request(
            &url,
            raw_token,
            Some("https://ui.example.test"),
        ))
        .await,
        StatusCode::SWITCHING_PROTOCOLS,
    );
    server.abort();
}

#[tokio::test]
async fn workspace_router_builds_with_archived_static_route() {
    let store = fresh_store().await;
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
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
        DatasetRuntimeConfig::defaults(),
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
        DatasetRuntimeConfig::defaults(),
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
        DatasetRuntimeConfig::defaults(),
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
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
    assert_eq!(item.kind(), BroadcastKind::WorkspaceArchived);
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
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let recovered = principal("Recovered@Example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Orphaned"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

    // Simulate a legacy/corrupt orphan directly. The supported store API now
    // enforces last-owner retention transactionally, so it cannot create the
    // recovery condition this admin-only path exists to repair.
    let deleted = sqlx::query("DELETE FROM workspace_members WHERE workspace_id = ? AND email = ?")
        .bind(&workspace.id)
        .bind(&owner.email)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(deleted.rows_affected(), 1);
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
async fn non_member_cannot_see_role_but_admin_can() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let other = principal("other@example.com", false);
    let admin = principal("admin@example.com", true);
    let workspace = store.create_workspace(&owner, Some("Demo")).await.unwrap();

    assert_eq!(store.role_for(&workspace.id, &other).await.unwrap(), None,);
    assert_eq!(
        store.role_for(&workspace.id, &admin).await.unwrap(),
        Some(WorkspaceRole::Owner),
    );
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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
    assert!(manager.live_workspace(&workspace.id, &owner).await.is_ok());
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());
    let attachment = manager
        .attach_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    let pending_attachment = manager
        .attach_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    let live = Arc::clone(attachment.live());
    let mut rx = live.tx.subscribe();
    let (route_tx, mut route_rx) = crate::outbox::unicast_channel(4, 1024);
    live.unicast_routes.lock().await.insert(90, route_tx);
    let lease = manager
        .register_attachment_connection(&attachment, 90, &owner)
        .await
        .unwrap();

    manager
        .archive_workspace(&workspace.id, &owner)
        .await
        .unwrap();

    assert!(live.background_cancelled());
    assert!(lease.is_revoked());
    assert!(matches!(
        route_rx.recv().await,
        Some(axum::extract::ws::Message::Close(_))
    ));
    assert_eq!(
        manager
            .register_attachment_connection(&pending_attachment, 91, &owner)
            .await
            .unwrap_err(),
        ConnectionAdmissionError::AccessRevoked
    );
    assert!(!manager.live.lock().await.contains_key(&workspace.id));
    let item = rx.recv().await.unwrap();
    assert_eq!(item.kind(), BroadcastKind::WorkspaceArchived);
    let msg: ServerMessage = serde_json::from_str(item.primary_json()).unwrap();
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
        DatasetRuntimeConfig::defaults(),
        idle_eviction_config(),
    );
    let live = manager.live_workspace(&workspace.id, &owner).await.unwrap();

    for seq in 1..=7 {
        store
            .persist_document(&workspace.id, seq, &DocumentState::default())
            .await
            .unwrap();
    }

    let evicted = manager.evict_idle_workspaces().await;
    assert_eq!(evicted, 1);
    assert!(live.background_cancelled());
    assert_eq!(manager.live_workspace_count().await, 0);

    let reopened = manager.live_workspace(&workspace.id, &owner).await.unwrap();
    assert!(!Arc::ptr_eq(&live, &reopened));
    assert_eq!(reopened.session.lock().await.seq, 7);
}

#[tokio::test]
async fn concurrent_cold_workspace_joins_share_one_live_session() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Single flight"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
    ));

    let (first, second) = tokio::join!(
        manager.live_workspace(&workspace.id, &owner),
        manager.live_workspace(&workspace.id, &owner),
    );
    let first = first.unwrap();
    let second = second.unwrap();

    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(manager.live_workspace_count().await, 1);
}

#[tokio::test]
async fn pending_workspace_attachment_is_atomic_with_idle_eviction() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Upgrade lease"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new_with_runtime_config(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
        idle_eviction_config(),
    );

    // No Session client exists yet: this models the gap between accepting the
    // HTTP upgrade and registering WebSocket presence.
    let attachment = manager
        .attach_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    assert!(attachment.session.lock().await.clients.is_empty());
    assert_eq!(manager.evict_idle_workspaces().await, 0);

    drop(attachment);
    assert_eq!(manager.evict_idle_workspaces().await, 1);
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
    let dataset_id = open_dataset_into(
        &store,
        &workspace.id,
        &owner,
        "presence-privacy-source",
        "file:///data/presence-privacy.zarr",
        "Presence privacy dataset",
        1,
    )
    .await;
    let manager = WorkspaceManager::new_with_runtime_config(
        Arc::new(store.clone()),
        DatasetRuntimeConfig::defaults(),
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
            dataset_id,
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
        DatasetRuntimeConfig::defaults(),
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
        DatasetRuntimeConfig::defaults(),
        idle_eviction_config(),
    );
    let workspace_dataset_id = DatasetId("wds-reusable".into());

    manager.live_workspace(&workspace.id, &owner).await.unwrap();
    store
        .persist_dataset_opened(
            &workspace.id,
            &workspace_dataset_id,
            &test_source("file:///tmp/reusable.zarr"),
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
    assert_eq!(
        sources[0].identity,
        SourceIdentity::parse("file:///tmp/reusable.zarr").unwrap()
    );
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
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

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

#[tokio::test]
async fn concurrent_owner_mutations_retain_exactly_one_owner() {
    async fn seeded_pair(
        name: &str,
    ) -> (
        SqliteWorkspaceStore,
        Arc<WorkspaceManager>,
        WorkspaceRecord,
        AuthPrincipal,
        AuthPrincipal,
    ) {
        let store = fresh_store().await;
        let first = principal("first-owner@example.com", false);
        let second = principal("second-owner@example.com", false);
        let workspace = store.create_workspace(&first, Some(name)).await.unwrap();
        let manager = Arc::new(WorkspaceManager::new(
            Arc::new(store.clone()),
            DatasetRuntimeConfig::defaults(),
        ));
        manager
            .upsert_member(
                &workspace.id,
                &first,
                &second.email,
                None,
                WorkspaceRole::Owner,
            )
            .await
            .unwrap();
        (store, manager, workspace, first, second)
    }

    async fn assert_one_owner(store: &SqliteWorkspaceStore, workspace_id: &str) {
        let settings = store.sharing_settings(workspace_id).await.unwrap().unwrap();
        assert_eq!(
            settings
                .members
                .iter()
                .filter(|member| member.role == WorkspaceRole::Owner)
                .count(),
            1
        );
    }

    let (store, manager, workspace, first, second) = seeded_pair("Remove race").await;
    let (a, b) = tokio::join!(
        manager.remove_member(&workspace.id, &first, &first.email),
        manager.remove_member(&workspace.id, &second, &second.email),
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_one_owner(&store, &workspace.id).await;

    let (store, manager, workspace, first, second) = seeded_pair("Demote race").await;
    let (a, b) = tokio::join!(
        manager.update_member_role(&workspace.id, &first, &first.email, WorkspaceRole::Viewer,),
        manager.update_member_role(&workspace.id, &second, &second.email, WorkspaceRole::Viewer,),
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_one_owner(&store, &workspace.id).await;

    let (store, manager, workspace, first, second) = seeded_pair("Mixed race").await;
    let (a, b) = tokio::join!(
        manager.remove_member(&workspace.id, &first, &first.email),
        manager.update_member_role(&workspace.id, &second, &second.email, WorkspaceRole::Editor,),
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_one_owner(&store, &workspace.id).await;
}

#[tokio::test]
async fn membership_removal_and_downgrade_close_live_connections() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let member = principal("member@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Revocation"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store), DatasetRuntimeConfig::defaults());
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &member.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    let first_attachment = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .unwrap();
    let second_attachment = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .unwrap();
    let live = Arc::clone(first_attachment.live());

    let (first_tx, mut first_rx) = crate::outbox::unicast_channel(4, 1024);
    let (second_tx, mut second_rx) = crate::outbox::unicast_channel(4, 1024);
    live.unicast_routes.lock().await.insert(10, first_tx);
    live.unicast_routes.lock().await.insert(11, second_tx);
    manager
        .register_attachment_connection(&first_attachment, 10, &member)
        .await
        .unwrap();
    manager
        .register_attachment_connection(&second_attachment, 11, &member)
        .await
        .unwrap();

    let dataset_id = DatasetId("revocation-interest".into());
    let manifest = DatasetManifest::new(
        dataset_id.clone(),
        "revocation interest".into(),
        lucida_content::DatasetKind::Single,
        vec![],
        vec![],
        vec![],
        vec![],
        None,
    );
    let generated_service = {
        let mut session = live.session.lock().await;
        let binding = inert_server_binding("file:///data/revocation-interest.zarr", manifest);
        let service = Arc::clone(&binding.generated_service);
        session.server_bindings.insert(dataset_id.clone(), binding);
        service
    };
    generated_service
        .install_test_client_interest(
            10,
            lucida_core::protocol::ViewerInterestHint {
                client_id: None,
                dataset_id,
                generation: 1,
                t: 0,
                z: 0,
                channels: vec![],
                mode: lucida_core::protocol::ViewerInterestMode::Slice,
                viewport: None,
                desired_keys: vec![],
                predicted_keys: vec![],
                interaction: lucida_core::protocol::ViewerInteractionMode::Idle,
                timestamp_ms: 0,
                ttl_ms: u64::MAX,
            },
        )
        .await;
    assert!(generated_service.has_client_interest(10).await);

    manager
        .remove_member(&workspace.id, &owner, &member.email)
        .await
        .unwrap();
    assert!(
        !generated_service.has_client_interest(10).await,
        "revocation must synchronously discard generated-work interest"
    );
    assert!(matches!(
        first_rx.recv().await,
        Some(axum::extract::ws::Message::Close(_))
    ));
    assert!(matches!(
        second_rx.recv().await,
        Some(axum::extract::ws::Message::Close(_))
    ));

    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &member.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    let third_attachment = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .unwrap();
    let (third_tx, mut third_rx) = crate::outbox::unicast_channel(4, 1024);
    live.unicast_routes.lock().await.insert(12, third_tx);
    manager
        .register_attachment_connection(&third_attachment, 12, &member)
        .await
        .unwrap();
    manager
        .update_member_role(&workspace.id, &owner, &member.email, WorkspaceRole::Viewer)
        .await
        .unwrap();
    assert!(matches!(
        third_rx.recv().await,
        Some(axum::extract::ws::Message::Close(_))
    ));
}

#[tokio::test]
async fn disabling_link_access_revokes_only_link_derived_connections() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let link_viewer = principal("link-viewer@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Link revocation"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store), DatasetRuntimeConfig::defaults());
    manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    let owner_attachment = manager
        .attach_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    let link_attachment = manager
        .attach_workspace(&workspace.id, &link_viewer)
        .await
        .unwrap();
    let pending_link_attachment = manager
        .attach_workspace(&workspace.id, &link_viewer)
        .await
        .unwrap();
    let live = Arc::clone(owner_attachment.live());
    let (owner_tx, mut owner_rx) = crate::outbox::unicast_channel(4, 1024);
    let (link_tx, mut link_rx) = crate::outbox::unicast_channel(4, 1024);
    live.unicast_routes.lock().await.insert(20, owner_tx);
    live.unicast_routes.lock().await.insert(21, link_tx);
    let owner_access = manager
        .register_attachment_connection(&owner_attachment, 20, &owner)
        .await
        .unwrap();
    let link_access = manager
        .register_attachment_connection(&link_attachment, 21, &link_viewer)
        .await
        .unwrap();

    manager
        .update_link_access(
            &workspace.id,
            &owner,
            WorkspaceLinkAccess::Restricted,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    assert!(link_access.is_revoked());
    assert!(matches!(
        link_rx.recv().await,
        Some(axum::extract::ws::Message::Close(_))
    ));
    assert!(!owner_access.is_revoked());
    assert_eq!(
        manager
            .register_attachment_connection(&pending_link_attachment, 22, &link_viewer)
            .await
            .unwrap_err(),
        ConnectionAdmissionError::AccessRevoked
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(20), owner_rx.recv())
            .await
            .is_err(),
        "an explicit member must not be disconnected by a link-policy change"
    );
}

#[tokio::test]
async fn membership_and_auth_revocation_reject_pending_upgrade_attachments() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let removed_member = principal("removed@example.com", false);
    let logged_out_member = principal("logged-out@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Pending upgrade revocation"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store), DatasetRuntimeConfig::defaults());
    for member in [&removed_member, &logged_out_member] {
        manager
            .upsert_member(
                &workspace.id,
                &owner,
                &member.email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap();
    }

    // These attachments model the period after HTTP authentication and
    // workspace authorization but before the WebSocket callback registers.
    let membership_attachment = manager
        .attach_workspace(&workspace.id, &removed_member)
        .await
        .unwrap();
    manager
        .remove_member(&workspace.id, &owner, &removed_member.email)
        .await
        .unwrap();
    assert_eq!(
        manager
            .register_attachment_connection(&membership_attachment, 30, &removed_member)
            .await
            .unwrap_err(),
        ConnectionAdmissionError::AccessRevoked
    );

    let auth_attachment = manager
        .attach_workspace(&workspace.id, &logged_out_member)
        .await
        .unwrap();
    assert_eq!(
        manager
            .revoke_principal_connections(&logged_out_member.email)
            .await,
        0
    );
    assert_eq!(
        manager
            .register_attachment_connection(&auth_attachment, 31, &logged_out_member)
            .await
            .unwrap_err(),
        ConnectionAdmissionError::AccessRevoked
    );
}

#[tokio::test]
async fn access_policy_changes_never_launder_pending_attachments_into_new_grants() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let member = principal("member@example.com", false);
    let link_viewer = principal("link-viewer@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Pending policy changes"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store), DatasetRuntimeConfig::defaults());
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
            &member.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();

    // Removing an explicit member must not let their old member attachment
    // register under the still-enabled link grant.
    let removed_member_attachment = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .unwrap();
    manager
        .remove_member(&workspace.id, &owner, &member.email)
        .await
        .unwrap();
    assert_eq!(
        manager
            .register_attachment_connection(&removed_member_attachment, 32, &member)
            .await
            .unwrap_err(),
        ConnectionAdmissionError::AccessRevoked
    );

    // A link-role change is a new policy even while sharing stays enabled.
    let old_link_role_attachment = manager
        .attach_workspace(&workspace.id, &link_viewer)
        .await
        .unwrap();
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
        manager
            .register_attachment_connection(&old_link_role_attachment, 33, &link_viewer)
            .await
            .unwrap_err(),
        ConnectionAdmissionError::AccessRevoked
    );

    // Likewise, a member downgrade requires a fresh HTTP authorization pass.
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &member.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    let old_member_role_attachment = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .unwrap();
    manager
        .update_member_role(&workspace.id, &owner, &member.email, WorkspaceRole::Viewer)
        .await
        .unwrap();
    assert_eq!(
        manager
            .register_attachment_connection(&old_member_role_attachment, 34, &member)
            .await
            .unwrap_err(),
        ConnectionAdmissionError::AccessRevoked
    );
}

#[tokio::test]
async fn slow_cold_init_cannot_replace_a_removed_member_grant_with_link_access() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let member = principal("member@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Cold policy generation"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
    ));
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
            &member.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();

    let cold_init = manager.pause_next_cold_init();
    let pending = {
        let manager = Arc::clone(&manager);
        let workspace_id = workspace.id.clone();
        let member = member.clone();
        tokio::spawn(async move { manager.attach_workspace(&workspace_id, &member).await })
    };
    tokio::time::timeout(Duration::from_secs(1), cold_init.wait_until_paused())
        .await
        .expect("attachment should pause after capturing its member grant");

    manager
        .remove_member(&workspace.id, &owner, &member.email)
        .await
        .unwrap();
    cold_init.resume();
    let error = match tokio::time::timeout(Duration::from_secs(1), pending)
        .await
        .expect("cold initialization should resume")
        .unwrap()
    {
        Ok(_) => panic!("removed member attachment used the replacement link grant"),
        Err(error) => error,
    };
    assert!(matches!(error, WorkspaceError::Forbidden));

    // Fresh requests under the current policy still admit both the link user
    // and an unaffected explicit member.
    let link_attachment = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .unwrap();
    manager
        .register_attachment_connection(&link_attachment, 60, &member)
        .await
        .unwrap();
    let owner_attachment = manager
        .attach_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    manager
        .register_attachment_connection(&owner_attachment, 61, &owner)
        .await
        .unwrap();
}

#[tokio::test]
async fn credential_revoked_after_authentication_is_rejected_before_workspace_attach() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Pre-attach credential revocation"))
        .await
        .unwrap();
    let manager = WorkspaceManager::new(Arc::new(store), DatasetRuntimeConfig::defaults());

    let session_store = Arc::new(crate::auth::MemorySessionStore::new());
    let now = chrono::Utc::now();
    crate::auth::LoginSessionStore::create(
        &*session_store,
        crate::auth::LoginSession {
            id: "authenticated-before-revoke".into(),
            email: "delayed@example.com".into(),
            display_name: "Delayed User".into(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + chrono::Duration::hours(1),
        },
    )
    .await
    .unwrap();
    let extractor = crate::auth::SessionCookieExtractor::new_with_auth_epochs(
        Arc::new(crate::auth::AuthConfig::for_tests()),
        session_store as Arc<dyn crate::auth::LoginSessionStore>,
        manager.auth_epoch_registry(),
    );
    let request_parts = axum::http::Request::builder()
        .uri("/api/workspaces/ws")
        .header("cookie", "lucida_session=authenticated-before-revoke")
        .body(())
        .unwrap()
        .into_parts()
        .0;
    let authenticated = crate::auth::PrincipalExtractor::extract(&extractor, &request_parts)
        .await
        .unwrap();
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &authenticated.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    // The request has already passed credential validation but has not reached
    // workspace authorization yet. Revocation must make that captured
    // capability unusable even though the authenticated request is queued.
    manager
        .revoke_principal_connections(&authenticated.email)
        .await;
    assert!(matches!(
        manager
            .attach_workspace(&workspace.id, &authenticated)
            .await,
        Err(WorkspaceError::Forbidden)
    ));
}

#[tokio::test]
async fn auth_revocation_return_waits_for_admitted_connection_work() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Revocation operation barrier"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
    ));
    let attachment = manager
        .attach_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    let lease = manager
        .register_attachment_connection(&attachment, 40, &owner)
        .await
        .unwrap();
    let operation = lease.begin_operation().await.unwrap();

    let revoking_manager = Arc::clone(&manager);
    let email = owner.email.clone();
    let revocation =
        tokio::spawn(async move { revoking_manager.revoke_principal_connections(&email).await });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !lease.is_revoked() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("revocation should mark the lease promptly");
    assert!(
        !revocation.is_finished(),
        "revocation must wait for admitted connection work"
    );

    drop(operation);
    tokio::time::timeout(Duration::from_secs(1), revocation)
        .await
        .expect("revocation should finish after work drains")
        .unwrap();
}

#[tokio::test]
async fn cancelled_logout_finishes_epoch_revocation_and_operation_quiescence() {
    let store = fresh_store().await;
    let owner = principal("logout-cancel@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Cancellation-safe logout"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
    ));
    let (lease, operation, mut route_rx) =
        register_blocked_connection(&manager, &workspace.id, &owner, 41).await;

    let sessions = Arc::new(MemorySessionStore::new());
    let now = Utc::now();
    sessions
        .create(crate::auth::LoginSession {
            id: "cancelled-logout".into(),
            email: owner.email.clone(),
            display_name: owner.display_name.clone(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + chrono::Duration::hours(1),
        })
        .await
        .unwrap();
    let state = crate::auth::handlers::LogoutState {
        config: Arc::new(AuthConfig::for_tests()),
        store: Arc::clone(&sessions) as Arc<dyn LoginSessionStore>,
        workspace_manager: Some(Arc::clone(&manager)),
    };
    let hook = manager.pause_next_credential_mutation_after_commit();
    let mut request = Request::builder()
        .method("POST")
        .uri("/auth/logout")
        .header("cookie", "lucida_session=cancelled-logout")
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(owner.clone());
    let caller = tokio::spawn(crate::auth::handlers::logout(
        axum::extract::State(state),
        request,
    ));

    hook.wait_until_committed().await;
    assert!(sessions.get("cancelled-logout").await.unwrap().is_none());
    assert!(!lease.is_revoked());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    hook.resume();

    tokio::time::timeout(Duration::from_secs(1), async {
        while !lease.is_revoked() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("detached logout must revoke the registered lease");
    assert_eq!(manager.auth_epoch_registry().current(&owner.email).await, 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), route_rx.recv())
            .await
            .is_err(),
        "credential revocation must wait for admitted work"
    );
    drop(operation);
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), route_rx.recv())
            .await
            .expect("detached logout should close after work drains"),
        Some(axum::extract::ws::Message::Close(_))
    ));
    assert!(lease.begin_operation().await.is_none());
}

#[tokio::test]
async fn cancelled_bearer_revoke_finishes_epoch_revocation_and_operation_quiescence() {
    let store = fresh_store().await;
    let owner = principal("bearer-cancel@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Cancellation-safe bearer revoke"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
    ));
    let (lease, operation, mut route_rx) =
        register_blocked_connection(&manager, &workspace.id, &owner, 42).await;

    let raw_token = "lucida_pat_cancelled_revoke";
    let token_hash = hash_bearer_token(raw_token);
    let tokens = Arc::new(MemoryBearerTokenStore::new());
    let now = Utc::now();
    tokens
        .create(BearerToken {
            id: "cancelled-token".into(),
            token_hash: token_hash.clone(),
            name: "cancelled request".into(),
            email: owner.email.clone(),
            display_name: owner.display_name.clone(),
            picture_url: None,
            created_at: now,
            last_used_at: None,
            expires_at: now + chrono::Duration::hours(1),
            revoked_at: None,
        })
        .await
        .unwrap();
    let state = crate::auth::handlers::CliAuthState {
        config: Arc::new(AuthConfig::for_tests()),
        token_store: Arc::clone(&tokens) as Arc<dyn BearerTokenStore>,
        cli_store: Arc::new(crate::auth::MemoryCliTokenAuthorizationStore::new()),
        workspace_manager: Some(Arc::clone(&manager)),
    };
    let hook = manager.pause_next_credential_mutation_after_commit();
    let request = Request::builder()
        .method("POST")
        .uri("/auth/tokens/revoke-current")
        .header("authorization", format!("Bearer {raw_token}"))
        .body(Body::empty())
        .unwrap();
    let caller = tokio::spawn(crate::auth::handlers::revoke_current_bearer_token(
        axum::extract::State(state),
        request,
    ));

    hook.wait_until_committed().await;
    assert!(
        tokens
            .get_by_hash(&token_hash)
            .await
            .unwrap()
            .unwrap()
            .revoked_at
            .is_some()
    );
    assert!(!lease.is_revoked());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    hook.resume();

    tokio::time::timeout(Duration::from_secs(1), async {
        while !lease.is_revoked() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("detached bearer revoke must revoke the registered lease");
    assert_eq!(manager.auth_epoch_registry().current(&owner.email).await, 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), route_rx.recv())
            .await
            .is_err(),
        "credential revocation must wait for admitted work"
    );
    drop(operation);
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), route_rx.recv())
            .await
            .expect("detached bearer revoke should close after work drains"),
        Some(axum::extract::ws::Message::Close(_))
    ));
    assert!(lease.begin_operation().await.is_none());
}

struct DeleteFailingCredentialStore {
    inner: Arc<MemorySessionStore>,
}

struct LostCompletionCredentialStore {
    inner: Arc<MemorySessionStore>,
}

#[async_trait::async_trait]
impl LoginSessionStore for LostCompletionCredentialStore {
    async fn create(
        &self,
        session: crate::auth::LoginSession,
    ) -> Result<(), crate::auth::SessionStoreError> {
        self.inner.create(session).await
    }

    async fn get(
        &self,
        id: &str,
    ) -> Result<Option<crate::auth::LoginSession>, crate::auth::SessionStoreError> {
        self.inner.get(id).await
    }

    async fn touch_last_used(
        &self,
        id: &str,
        now: chrono::DateTime<Utc>,
    ) -> Result<(), crate::auth::SessionStoreError> {
        self.inner.touch_last_used(id, now).await
    }

    async fn delete(
        &self,
        id: &str,
    ) -> Result<Option<crate::auth::LoginSession>, crate::auth::SessionStoreError> {
        self.inner.delete(id).await
    }

    fn begin_delete(
        &self,
        id: &str,
    ) -> crate::persistence::PersistenceOperation<
        Option<crate::auth::LoginSession>,
        crate::auth::SessionStoreError,
    > {
        let inner = Arc::clone(&self.inner);
        let id = id.to_owned();
        crate::persistence::PersistenceOperation::spawn(
            crate::persistence::PersistenceDeadline::default(),
            async move {
                inner.delete(&id).await.unwrap();
                crate::persistence::PersistenceWorkerOutcome::RecoverablyIndeterminate(
                    crate::auth::SessionStoreError::Backend(
                        "injected lost delete completion".into(),
                    ),
                )
            },
            || async { true },
        )
    }

    async fn delete_expired(
        &self,
        now: chrono::DateTime<Utc>,
    ) -> Result<u64, crate::auth::SessionStoreError> {
        self.inner.delete_expired(now).await
    }
}

#[tokio::test]
async fn lost_logout_completion_is_read_back_and_revokes_live_credentials() {
    let store = fresh_store().await;
    let owner = principal("logout-recovery@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Recovered logout completion"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
    ));
    let attachment = manager
        .attach_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    let (route_tx, mut route_rx) = crate::outbox::unicast_channel(4, 1024);
    attachment
        .live()
        .unicast_routes
        .lock()
        .await
        .insert(152, route_tx);
    let lease = manager
        .register_attachment_connection(&attachment, 152, &owner)
        .await
        .unwrap();

    let sessions = Arc::new(MemorySessionStore::new());
    let now = Utc::now();
    sessions
        .create(crate::auth::LoginSession {
            id: "lost-completion-logout".into(),
            email: owner.email.clone(),
            display_name: owner.display_name.clone(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + chrono::Duration::hours(1),
        })
        .await
        .unwrap();
    let state = crate::auth::handlers::LogoutState {
        config: Arc::new(AuthConfig::for_tests()),
        store: Arc::new(LostCompletionCredentialStore {
            inner: Arc::clone(&sessions),
        }),
        workspace_manager: Some(Arc::clone(&manager)),
    };
    let mut request = Request::builder()
        .method("POST")
        .uri("/auth/logout")
        .header("cookie", "lucida_session=lost-completion-logout")
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(owner.clone());
    let response = crate::auth::handlers::logout(axum::extract::State(state), request).await;

    assert_eq!(response.status(), axum::http::StatusCode::FOUND);
    assert!(
        sessions
            .get("lost-completion-logout")
            .await
            .unwrap()
            .is_none()
    );
    assert!(lease.is_revoked());
    assert_eq!(manager.auth_epoch_registry().current(&owner.email).await, 1);
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), route_rx.recv())
            .await
            .expect("recovered logout must close the stale connection"),
        Some(axum::extract::ws::Message::Close(_))
    ));
}

#[async_trait::async_trait]
impl LoginSessionStore for DeleteFailingCredentialStore {
    async fn create(
        &self,
        session: crate::auth::LoginSession,
    ) -> Result<(), crate::auth::SessionStoreError> {
        self.inner.create(session).await
    }

    async fn get(
        &self,
        id: &str,
    ) -> Result<Option<crate::auth::LoginSession>, crate::auth::SessionStoreError> {
        self.inner.get(id).await
    }

    async fn touch_last_used(
        &self,
        id: &str,
        now: chrono::DateTime<Utc>,
    ) -> Result<(), crate::auth::SessionStoreError> {
        self.inner.touch_last_used(id, now).await
    }

    async fn delete(
        &self,
        _id: &str,
    ) -> Result<Option<crate::auth::LoginSession>, crate::auth::SessionStoreError> {
        Err(crate::auth::SessionStoreError::Backend(
            "simulated delete failure".into(),
        ))
    }

    fn begin_delete(
        &self,
        _id: &str,
    ) -> crate::persistence::PersistenceOperation<
        Option<crate::auth::LoginSession>,
        crate::auth::SessionStoreError,
    > {
        crate::persistence::PersistenceOperation::ready(
            crate::persistence::PersistenceWorkerOutcome::DefinitelyNotCommitted(
                crate::auth::SessionStoreError::Backend("simulated delete failure".into()),
            ),
        )
    }

    async fn delete_expired(
        &self,
        now: chrono::DateTime<Utc>,
    ) -> Result<u64, crate::auth::SessionStoreError> {
        self.inner.delete_expired(now).await
    }
}

#[tokio::test]
async fn failed_logout_delete_does_not_advance_epoch_or_revoke_live_lease() {
    let store = fresh_store().await;
    let owner = principal("logout-failure@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Failed logout stays authorized"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
    ));
    let attachment = manager
        .attach_workspace(&workspace.id, &owner)
        .await
        .unwrap();
    let lease = manager
        .register_attachment_connection(&attachment, 43, &owner)
        .await
        .unwrap();
    let sessions = Arc::new(MemorySessionStore::new());
    let now = Utc::now();
    sessions
        .create(crate::auth::LoginSession {
            id: "cannot-delete".into(),
            email: owner.email.clone(),
            display_name: owner.display_name.clone(),
            picture_url: None,
            created_at: now,
            last_used_at: now,
            expires_at: now + chrono::Duration::hours(1),
        })
        .await
        .unwrap();
    let state = crate::auth::handlers::LogoutState {
        config: Arc::new(AuthConfig::for_tests()),
        store: Arc::new(DeleteFailingCredentialStore {
            inner: Arc::clone(&sessions),
        }),
        workspace_manager: Some(Arc::clone(&manager)),
    };
    let mut request = Request::builder()
        .method("POST")
        .uri("/auth/logout")
        .header("cookie", "lucida_session=cannot-delete")
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(owner.clone());
    let response = crate::auth::handlers::logout(axum::extract::State(state), request).await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(sessions.get("cannot-delete").await.unwrap().is_some());
    assert_eq!(manager.auth_epoch_registry().current(&owner.email).await, 0);
    assert!(!lease.is_revoked());
    assert!(lease.begin_operation().await.is_some());
}

async fn register_blocked_connection(
    manager: &WorkspaceManager,
    workspace_id: &str,
    principal: &AuthPrincipal,
    client_id: lucida_core::protocol::ClientId,
) -> (
    WorkspaceConnectionLease,
    tokio::sync::OwnedRwLockReadGuard<()>,
    crate::outbox::UnicastReceiver,
) {
    let attachment = manager
        .attach_workspace(workspace_id, principal)
        .await
        .unwrap();
    let (route_tx, route_rx) = crate::outbox::unicast_channel(4, 1024);
    attachment
        .live()
        .unicast_routes
        .lock()
        .await
        .insert(client_id, route_tx);
    let lease = manager
        .register_attachment_connection(&attachment, client_id, principal)
        .await
        .unwrap();
    let operation = lease.begin_operation().await.unwrap();
    (lease, operation, route_rx)
}

async fn finish_cancelled_access_mutation(
    hook: &AccessMutationTestHook,
    lease: &WorkspaceConnectionLease,
    operation: tokio::sync::OwnedRwLockReadGuard<()>,
    mut route_rx: crate::outbox::UnicastReceiver,
) {
    hook.resume();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !lease.is_revoked() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("detached access mutation must mark the lease revoked");
    assert!(
        tokio::time::timeout(Duration::from_millis(20), route_rx.recv())
            .await
            .is_err(),
        "revocation completion must wait for admitted connection work"
    );
    drop(operation);
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), route_rx.recv())
            .await
            .expect("detached revocation should close after work drains"),
        Some(axum::extract::ws::Message::Close(_))
    ));
    assert!(lease.begin_operation().await.is_none());
}

#[tokio::test]
async fn lost_membership_completion_is_read_back_before_revocation_returns() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let member = principal("member@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Recovered membership completion"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
    ));
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &member.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    let attachment = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .unwrap();
    let (route_tx, mut route_rx) = crate::outbox::unicast_channel(4, 1024);
    attachment
        .live()
        .unicast_routes
        .lock()
        .await
        .insert(151, route_tx);
    let lease = manager
        .register_attachment_connection(&attachment, 151, &member)
        .await
        .unwrap();

    manager.lose_next_persistence_completion();
    let updated = manager
        .update_member_role(&workspace.id, &owner, &member.email, WorkspaceRole::Viewer)
        .await
        .expect("durable read-back must recover the committed role change");
    assert_eq!(updated.role, WorkspaceRole::Viewer);
    assert!(lease.is_revoked());
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), route_rx.recv())
            .await
            .expect("recovered access mutation must close stale capability"),
        Some(axum::extract::ws::Message::Close(_))
    ));
    assert!(lease.begin_operation().await.is_none());
}

#[tokio::test]
async fn stalled_role_reconciliation_fails_closed_without_reverting_a_committed_downgrade() {
    let (_, pool) = fresh_store_with_pool().await;
    let store =
        SqliteWorkspaceStore::with_persistence_deadline(pool.clone(), Duration::from_millis(10));
    let owner = principal("stalled-role-owner@example.com", false);
    let member = principal("stalled-role-member@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Stalled role reconciliation"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store.clone()),
        DatasetRuntimeConfig::defaults(),
    ));
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &member.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    let attachment = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .unwrap();
    let old_live = Arc::clone(attachment.live());
    let (route_tx, mut route_rx, route_process_budget) =
        crate::outbox::unicast_channel_with_process_budget_probe(4, 1024, 4096);
    let route_payload_baseline = route_tx.queued_bytes();
    old_live
        .unicast_routes
        .lock()
        .await
        .insert(171, route_tx.clone());
    let lease = manager
        .register_attachment_connection(&attachment, 171, &member)
        .await
        .unwrap();

    store.lose_next_persistence_completion_in_backend();
    store.stall_next_reconciliation_read();
    let started = tokio::time::Instant::now();
    let error = tokio::time::timeout(
        Duration::from_millis(250),
        manager.update_member_role(&workspace.id, &owner, &member.email, WorkspaceRole::Viewer),
    )
    .await
    .expect("membership reconciliation must be finitely bounded")
    .expect_err("a stalled read-back cannot claim a role-change verdict");
    let WorkspaceError::PersistenceIndeterminate(detail) = error else {
        panic!("stalled membership reconciliation must remain indeterminate");
    };
    assert!(started.elapsed() < Duration::from_millis(250));
    assert!(detail.contains("persist-"));
    assert!(lease.is_revoked());
    assert!(lease.begin_operation().await.is_none());

    let close = tokio::time::timeout(Duration::from_millis(250), route_rx.recv())
        .await
        .expect("fail-close must release the access mutation guard")
        .expect("the stale editor connection must receive one close");
    assert!(matches!(close, axum::extract::ws::Message::Close(_)));
    drop(close);
    assert!(route_rx.try_recv().is_err());
    assert_eq!(route_tx.queued_bytes(), route_payload_baseline);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?",
        )
        .bind(&workspace.id)
        .bind(&member.email)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "viewer",
        "the injected worker committed before its completion was lost"
    );
    let _session_guard = old_live
        .session
        .try_lock()
        .expect("bounded reconciliation must release every live-session guard");
    let operation_id = store.last_persistence_operation_id();
    tokio::time::timeout(Duration::from_millis(100), async {
        while crate::persistence::persistence_operation_resources(operation_id) != (false, false) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("stalled membership reconciliation must release operation resources");
    assert_eq!(
        crate::persistence::persistence_operation_resources(operation_id),
        (false, false)
    );

    let restored = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .expect("Quiesced recovery permits restore from the committed viewer role");
    assert!(!Arc::ptr_eq(&old_live, restored.live()));
    drop(_session_guard);
    old_live.unicast_routes.lock().await.clear();
    drop(attachment);
    drop(old_live);
    drop(route_tx);
    drop(route_rx);
    assert_eq!(route_process_budget.queued_bytes(), 0);
}

#[tokio::test]
async fn never_completing_role_revocation_returns_bounded_indeterminate_and_releases_live_capabilities()
 {
    let (_, pool) = fresh_store_with_pool().await;
    let store =
        SqliteWorkspaceStore::with_persistence_deadline(pool.clone(), Duration::from_millis(10));
    let owner = principal("never-revoke-owner@example.com", false);
    let member = principal("never-revoke-member@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Never-completing revocation"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store.clone()),
        DatasetRuntimeConfig::defaults(),
    ));
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &member.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    let attachment = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .unwrap();
    let old_live = Arc::clone(attachment.live());
    let (route_tx, mut route_rx, route_process_budget) =
        crate::outbox::unicast_channel_with_process_budget_probe(4, 1024, 4096);
    let route_payload_baseline = route_tx.queued_bytes();
    attachment
        .live()
        .unicast_routes
        .lock()
        .await
        .insert(181, route_tx.clone());
    let lease = manager
        .register_attachment_connection(&attachment, 181, &member)
        .await
        .unwrap();

    store.never_complete_next_persistence();
    let started = tokio::time::Instant::now();
    let error = tokio::time::timeout(
        Duration::from_millis(250),
        manager.update_member_role(&workspace.id, &owner, &member.email, WorkspaceRole::Viewer),
    )
    .await
    .expect("the backend-issued deadline must bound access revocation")
    .expect_err("a never-completing role mutation cannot claim a durable verdict");
    let WorkspaceError::PersistenceIndeterminate(detail) = error else {
        panic!("deadline must remain explicitly indeterminate");
    };
    assert!(started.elapsed() < Duration::from_millis(250));
    assert!(detail.contains("persist-"));
    assert!(lease.is_revoked());
    assert!(lease.begin_operation().await.is_none());

    let close = tokio::time::timeout(Duration::from_millis(250), route_rx.recv())
        .await
        .expect("fail-close must not retain the revocation guard")
        .expect("the revoked connection must receive one close");
    assert!(matches!(close, axum::extract::ws::Message::Close(_)));
    drop(close);
    assert!(
        route_rx.try_recv().is_err(),
        "revocation must close exactly once"
    );
    assert_eq!(
        route_tx.queued_bytes(),
        route_payload_baseline,
        "revocation close must return its payload reservation to baseline"
    );

    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?",
        )
        .bind(&workspace.id)
        .bind(&member.email)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "editor",
        "an aborted fake mutation must not be reported or observed as a downgrade"
    );
    let _session_guard = old_live
        .session
        .try_lock()
        .expect("bounded return must release every live-session guard");

    let operation_id = store.last_persistence_operation_id();
    tokio::time::timeout(Duration::from_millis(100), async {
        while crate::persistence::persistence_operation_resources(operation_id) != (false, false) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("access revocation must retain no backend worker or operation controller");

    let restored = manager
        .attach_workspace(&workspace.id, &member)
        .await
        .expect("quiesced access persistence permits a durable restore");
    assert!(!Arc::ptr_eq(&old_live, restored.live()));
    drop(_session_guard);
    old_live.unicast_routes.lock().await.clear();
    drop(attachment);
    drop(old_live);
    drop(route_tx);
    drop(route_rx);
    assert_eq!(
        route_process_budget.queued_bytes(),
        0,
        "closed revocation route must return retained wire capacity to process baseline"
    );
}

#[tokio::test]
async fn committed_membership_mutations_revoke_even_when_the_caller_is_cancelled() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let member = principal("member@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Cancellation-safe members"))
        .await
        .unwrap();
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store),
        DatasetRuntimeConfig::defaults(),
    ));
    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &member.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();

    // Owner-driven upsert downgrade.
    let (lease, operation, route_rx) =
        register_blocked_connection(&manager, &workspace.id, &member, 101).await;
    let hook = manager.pause_next_access_mutation_after_commit();
    let task_manager = Arc::clone(&manager);
    let workspace_id = workspace.id.clone();
    let owner_for_task = owner.clone();
    let member_email = member.email.clone();
    let caller = tokio::spawn(async move {
        task_manager
            .upsert_member(
                &workspace_id,
                &owner_for_task,
                &member_email,
                None,
                WorkspaceRole::Viewer,
            )
            .await
    });
    hook.wait_until_committed().await;
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?",
        )
        .bind(&workspace.id)
        .bind(&member.email)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "viewer"
    );
    assert!(!lease.is_revoked());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    finish_cancelled_access_mutation(&hook, &lease, operation, route_rx).await;

    manager
        .update_member_role(&workspace.id, &owner, &member.email, WorkspaceRole::Editor)
        .await
        .unwrap();

    // Direct role downgrade.
    let (lease, operation, route_rx) =
        register_blocked_connection(&manager, &workspace.id, &member, 102).await;
    let hook = manager.pause_next_access_mutation_after_commit();
    let task_manager = Arc::clone(&manager);
    let workspace_id = workspace.id.clone();
    let owner_for_task = owner.clone();
    let member_email = member.email.clone();
    let caller = tokio::spawn(async move {
        task_manager
            .update_member_role(
                &workspace_id,
                &owner_for_task,
                &member_email,
                WorkspaceRole::Viewer,
            )
            .await
    });
    hook.wait_until_committed().await;
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?",
        )
        .bind(&workspace.id)
        .bind(&member.email)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "viewer"
    );
    assert!(!lease.is_revoked());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    finish_cancelled_access_mutation(&hook, &lease, operation, route_rx).await;

    manager
        .update_member_role(&workspace.id, &owner, &member.email, WorkspaceRole::Editor)
        .await
        .unwrap();

    // Removal.
    let (lease, operation, route_rx) =
        register_blocked_connection(&manager, &workspace.id, &member, 103).await;
    let hook = manager.pause_next_access_mutation_after_commit();
    let task_manager = Arc::clone(&manager);
    let workspace_id = workspace.id.clone();
    let owner_for_task = owner.clone();
    let member_email = member.email.clone();
    let caller = tokio::spawn(async move {
        task_manager
            .remove_member(&workspace_id, &owner_for_task, &member_email)
            .await
    });
    hook.wait_until_committed().await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ? AND email = ?",
        )
        .bind(&workspace.id)
        .bind(&member.email)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    assert!(!lease.is_revoked());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    finish_cancelled_access_mutation(&hook, &lease, operation, route_rx).await;

    manager
        .upsert_member(
            &workspace.id,
            &owner,
            &member.email,
            None,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();

    // Admin owner promotion also invalidates capabilities captured under the
    // prior role, and therefore has the same completion contract.
    let (lease, operation, route_rx) =
        register_blocked_connection(&manager, &workspace.id, &member, 104).await;
    let hook = manager.pause_next_access_mutation_after_commit();
    let task_manager = Arc::clone(&manager);
    let workspace_id = workspace.id.clone();
    let member_email = member.email.clone();
    let caller = tokio::spawn(async move {
        task_manager
            .admin_upsert_owner(&workspace_id, &member_email, None)
            .await
    });
    hook.wait_until_committed().await;
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?",
        )
        .bind(&workspace.id)
        .bind(&member.email)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "owner"
    );
    assert!(!lease.is_revoked());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    finish_cancelled_access_mutation(&hook, &lease, operation, route_rx).await;
}

#[tokio::test]
async fn committed_archive_and_link_policy_revoke_after_caller_cancellation() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let link_viewer = principal("link@example.com", false);
    let manager = Arc::new(WorkspaceManager::new(
        Arc::new(store.clone()),
        DatasetRuntimeConfig::defaults(),
    ));

    // Owner archive.
    let owner_workspace = store
        .create_workspace(&owner, Some("Owner archive cancellation"))
        .await
        .unwrap();
    let (lease, operation, route_rx) =
        register_blocked_connection(&manager, &owner_workspace.id, &owner, 111).await;
    let hook = manager.pause_next_access_mutation_after_commit();
    let task_manager = Arc::clone(&manager);
    let workspace_id = owner_workspace.id.clone();
    let owner_for_task = owner.clone();
    let caller = tokio::spawn(async move {
        task_manager
            .archive_workspace(&workspace_id, &owner_for_task)
            .await
    });
    hook.wait_until_committed().await;
    assert!(
        sqlx::query_scalar::<_, Option<String>>("SELECT archived_at FROM workspaces WHERE id = ?")
            .bind(&owner_workspace.id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .is_some()
    );
    assert!(!lease.is_revoked());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    finish_cancelled_access_mutation(&hook, &lease, operation, route_rx).await;

    // Admin archive.
    let admin_workspace = store
        .create_workspace(&owner, Some("Admin archive cancellation"))
        .await
        .unwrap();
    let (lease, operation, route_rx) =
        register_blocked_connection(&manager, &admin_workspace.id, &owner, 112).await;
    let hook = manager.pause_next_access_mutation_after_commit();
    let task_manager = Arc::clone(&manager);
    let workspace_id = admin_workspace.id.clone();
    let caller =
        tokio::spawn(async move { task_manager.admin_archive_workspace(&workspace_id).await });
    hook.wait_until_committed().await;
    assert!(
        sqlx::query_scalar::<_, Option<String>>("SELECT archived_at FROM workspaces WHERE id = ?")
            .bind(&admin_workspace.id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .is_some()
    );
    assert!(!lease.is_revoked());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    finish_cancelled_access_mutation(&hook, &lease, operation, route_rx).await;

    // Link-policy mutation.
    let link_workspace = store
        .create_workspace(&owner, Some("Link policy cancellation"))
        .await
        .unwrap();
    manager
        .update_link_access(
            &link_workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();
    let (lease, operation, route_rx) =
        register_blocked_connection(&manager, &link_workspace.id, &link_viewer, 113).await;
    let hook = manager.pause_next_access_mutation_after_commit();
    let task_manager = Arc::clone(&manager);
    let workspace_id = link_workspace.id.clone();
    let owner_for_task = owner.clone();
    let caller = tokio::spawn(async move {
        task_manager
            .update_link_access(
                &workspace_id,
                &owner_for_task,
                WorkspaceLinkAccess::Restricted,
                WorkspaceRole::Viewer,
            )
            .await
    });
    hook.wait_until_committed().await;
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT link_access FROM workspaces WHERE id = ?")
            .bind(&link_workspace.id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "restricted"
    );
    assert!(!lease.is_revoked());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    finish_cancelled_access_mutation(&hook, &lease, operation, route_rx).await;
}

#[tokio::test]
async fn fallible_access_mutation_readback_rolls_back_before_revocation() {
    let (store, pool) = fresh_store_with_pool().await;
    let owner = principal("owner@example.com", false);
    let member = principal("member@example.com", false);
    let link_viewer = principal("link@example.com", false);
    let manager = WorkspaceManager::new(Arc::new(store.clone()), DatasetRuntimeConfig::defaults());

    let archive_workspace = store
        .create_workspace(&owner, Some("Malformed archive row"))
        .await
        .unwrap();
    let (archive_lease, archive_operation, _archive_rx) =
        register_blocked_connection(&manager, &archive_workspace.id, &owner, 121).await;
    sqlx::query("UPDATE workspaces SET document_json = 'not-json' WHERE id = ?")
        .bind(&archive_workspace.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        manager
            .archive_workspace(&archive_workspace.id, &owner)
            .await,
        Err(WorkspaceError::Store(_))
    ));
    assert!(
        sqlx::query_scalar::<_, Option<String>>("SELECT archived_at FROM workspaces WHERE id = ?")
            .bind(&archive_workspace.id)
            .fetch_one(&pool)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!archive_lease.is_revoked());
    drop(archive_operation);

    let member_workspace = store
        .create_workspace(&owner, Some("Malformed member row"))
        .await
        .unwrap();
    manager
        .upsert_member(
            &member_workspace.id,
            &owner,
            &member.email,
            None,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    let (member_lease, member_operation, _member_rx) =
        register_blocked_connection(&manager, &member_workspace.id, &member, 122).await;
    sqlx::query(
        "UPDATE workspace_members SET added_at = 'not-a-date' WHERE workspace_id = ? AND email = ?",
    )
    .bind(&member_workspace.id)
    .bind(&member.email)
    .execute(&pool)
    .await
    .unwrap();
    assert!(matches!(
        manager
            .update_member_role(
                &member_workspace.id,
                &owner,
                &member.email,
                WorkspaceRole::Viewer,
            )
            .await,
        Err(WorkspaceError::Store(_))
    ));
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT role FROM workspace_members WHERE workspace_id = ? AND email = ?",
        )
        .bind(&member_workspace.id)
        .bind(&member.email)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "editor"
    );
    assert!(!member_lease.is_revoked());
    drop(member_operation);

    let link_workspace = store
        .create_workspace(&owner, Some("Malformed sharing row"))
        .await
        .unwrap();
    manager
        .update_link_access(
            &link_workspace.id,
            &owner,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();
    let (link_lease, link_operation, _link_rx) =
        register_blocked_connection(&manager, &link_workspace.id, &link_viewer, 123).await;
    sqlx::query(
        "UPDATE workspace_members SET added_at = 'not-a-date' WHERE workspace_id = ? AND email = ?",
    )
    .bind(&link_workspace.id)
    .bind(&owner.email)
    .execute(&pool)
    .await
    .unwrap();
    assert!(matches!(
        manager
            .update_link_access(
                &link_workspace.id,
                &owner,
                WorkspaceLinkAccess::Restricted,
                WorkspaceRole::Viewer,
            )
            .await,
        Err(WorkspaceError::Store(_))
    ));
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT link_access FROM workspaces WHERE id = ?")
            .bind(&link_workspace.id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "anyone_with_link"
    );
    assert!(!link_lease.is_revoked());
    drop(link_operation);
}

#[tokio::test]
async fn persisted_workspace_sequence_requires_the_exact_predecessor() {
    let store = fresh_store().await;
    let owner = principal("owner@example.com", false);
    let workspace = store
        .create_workspace(&owner, Some("Monotonic sequence"))
        .await
        .unwrap();
    let newer = DocumentState::default();

    let skipped = store
        .persist_document(&workspace.id, 2, &newer)
        .await
        .unwrap_err();
    assert!(matches!(
        skipped,
        StoreError::SequenceConflict { attempted: 2 }
    ));

    store
        .persist_document(&workspace.id, 1, &DocumentState::default())
        .await
        .unwrap();
    let replayed = store
        .persist_document(&workspace.id, 1, &newer)
        .await
        .unwrap_err();
    assert!(matches!(
        replayed,
        StoreError::SequenceConflict { attempted: 1 }
    ));

    store
        .persist_document(&workspace.id, 2, &newer)
        .await
        .unwrap();
    let stale = store
        .persist_document(&workspace.id, 1, &DocumentState::default())
        .await
        .unwrap_err();
    assert!(matches!(
        stale,
        StoreError::SequenceConflict { attempted: 1 }
    ));

    let persisted = store.get_workspace(&workspace.id).await.unwrap().unwrap();
    assert_eq!(persisted.seq, 2);
    assert_eq!(
        serde_json::to_value(persisted.document).unwrap(),
        serde_json::to_value(newer).unwrap()
    );
}
