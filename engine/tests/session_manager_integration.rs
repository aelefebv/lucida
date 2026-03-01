use lucida_engine::{
    AttachRequest, ClientViewMode, PermissionClass, ReconnectRequest, SessionManager,
};

#[test]
fn session_manager_public_api_allocates_ids_and_revisions() {
    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-session");

    let attached = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "integration-client".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("attach should succeed");

    let source = manager
        .add_source(&created.session_id, "integration-source")
        .expect("source add should succeed");
    let layer = manager
        .add_layer(&created.session_id, "integration-layer")
        .expect("layer add should succeed");

    let generation_seq = manager
        .bump_source_generation_seq(&created.session_id, &source.source_id)
        .expect("generation bump should succeed");
    let metadata_rev = manager
        .bump_layer_metadata_revision(&created.session_id, &layer.layer_id)
        .expect("metadata rev bump should succeed");
    let write_rev = manager
        .bump_layer_write_revision(&created.session_id, &layer.layer_id)
        .expect("write rev bump should succeed");
    let view_rev = manager
        .update_client_view_mode(
            &created.session_id,
            &attached.snapshot.client_view.client_id,
            ClientViewMode::ThreeD,
        )
        .expect("view rev bump should succeed");

    assert!(created.session_id.starts_with("sess_"));
    assert!(attached.snapshot.client_view.client_id.starts_with("cli_"));
    assert!(source.source_id.starts_with("src_"));
    assert!(layer.layer_id.starts_with("lay_"));
    assert_eq!(generation_seq, 1);
    assert_eq!(metadata_rev, 1);
    assert_eq!(write_rev, 1);
    assert_eq!(view_rev, 1);
}

#[test]
fn session_manager_supports_heartbeat_idle_disconnect_and_reconnect() {
    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-reconnect");

    let first = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "first".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("first attach should succeed");
    let second = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "second".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("second attach should succeed");

    manager
        .heartbeat(&created.session_id, &second.snapshot.client_view.client_id)
        .expect("heartbeat should succeed");
    let removed = manager
        .disconnect_idle_clients(&created.session_id, 0)
        .expect("disconnect should succeed");

    assert_eq!(removed, vec![first.snapshot.client_view.client_id.clone()]);

    let reconnected = manager
        .reconnect_client(ReconnectRequest {
            session_id: created.session_id,
            previous_client_id: Some(first.snapshot.client_view.client_id),
            client_label: "first".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("reconnect should succeed");

    assert_eq!(reconnected.snapshot.client_roster.len(), 2);
}
