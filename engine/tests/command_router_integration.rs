use lucida_engine::{
    AttachRequest, COMMAND_MESSAGE_TYPE, CommandArgs, CommandEnvelope, CommandRouter, CommandScope,
    EventType, PermissionClass, SCHEMA_VERSION, SessionManager,
};
use std::fs;
use std::path::Path;

fn write_minimal_rgb_tiff(path: &Path) {
    const TIFF_BYTES: [u8; 62] = [
        0x49, 0x49, 0x2A, 0x00, // II + classic TIFF marker
        0x08, 0x00, 0x00, 0x00, // first IFD offset
        0x04, 0x00, // entry count
        0x00, 0x01, // tag 256 image width
        0x04, 0x00, // type LONG
        0x01, 0x00, 0x00, 0x00, // count
        0x20, 0x00, 0x00, 0x00, // width 32
        0x01, 0x01, // tag 257 image length
        0x04, 0x00, // type LONG
        0x01, 0x00, 0x00, 0x00, // count
        0x10, 0x00, 0x00, 0x00, // height 16
        0x15, 0x01, // tag 277 samples per pixel
        0x03, 0x00, // type SHORT
        0x01, 0x00, 0x00, 0x00, // count
        0x03, 0x00, 0x00, 0x00, // 3 channels
        0x02, 0x01, // tag 258 bits per sample
        0x03, 0x00, // type SHORT
        0x01, 0x00, 0x00, 0x00, // count
        0x08, 0x00, 0x00, 0x00, // 8 bits
        0x00, 0x00, 0x00, 0x00, // next IFD offset
    ];

    fs::write(path, TIFF_BYTES).expect("TIFF fixture write should succeed");
}

#[test]
fn command_router_routes_scene_command_with_authorization_and_lease() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc200_router_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    let source_path = fixture_dir.join("integration-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("router-integration");

    let attached = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "control-client".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("attach should succeed");

    manager
        .set_lease_holder(
            &created.session_id,
            Some(&attached.snapshot.client_view.client_id),
        )
        .expect("lease assignment should succeed");

    let router = CommandRouter::new();
    let outcome = router
        .route(
            &mut manager,
            CommandEnvelope {
                message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id,
                request_id: "req_integration_1".to_owned(),
                client_id: attached.snapshot.client_view.client_id,
                client_seq: 1,
                op: "scene.add_source".to_owned(),
                scope: CommandScope::SceneShared,
                requires_lease: true,
                args: CommandArgs::SceneAddSource {
                    name: "integration-source".to_owned(),
                    uri: source_path.display().to_string(),
                },
            },
        )
        .expect("scene command should succeed");

    assert!(outcome.ack.accepted);
    assert!(outcome.ack.resulting_scene_rev.is_some());
    assert!(
        outcome
            .events
            .iter()
            .any(|event| event.event_type == EventType::SceneSourceUpsert)
    );
    assert!(
        outcome
            .events
            .iter()
            .any(|event| event.event_type == EventType::SceneDatasetUpsert)
    );
    assert!(
        outcome
            .events
            .iter()
            .any(|event| event.event_type == EventType::WarningsUpdated)
    );
    assert!(
        outcome
            .ack
            .created_object_id
            .expect("source id should be included")
            .starts_with("src_")
    );

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
}

#[test]
fn command_router_routes_lease_request_and_steal_between_control_clients() {
    let mut manager = SessionManager::new();
    let created = manager.create_session("router-lease-integration");

    let first = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "first-control".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("first attach should succeed");
    let second = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "second-control".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("second attach should succeed");

    let router = CommandRouter::new();

    let request = router
        .route(
            &mut manager,
            CommandEnvelope {
                message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id.clone(),
                request_id: "req_lease_i1".to_owned(),
                client_id: first.snapshot.client_view.client_id.clone(),
                client_seq: 1,
                op: "lease.request".to_owned(),
                scope: CommandScope::SceneShared,
                requires_lease: false,
                args: CommandArgs::LeaseRequest,
            },
        )
        .expect("lease request should succeed");
    let steal = router
        .route(
            &mut manager,
            CommandEnvelope {
                message_type: COMMAND_MESSAGE_TYPE.to_owned(),
                schema_version: SCHEMA_VERSION.to_owned(),
                session_id: created.session_id,
                request_id: "req_lease_i2".to_owned(),
                client_id: second.snapshot.client_view.client_id.clone(),
                client_seq: 2,
                op: "lease.steal".to_owned(),
                scope: CommandScope::SceneShared,
                requires_lease: false,
                args: CommandArgs::LeaseSteal,
            },
        )
        .expect("lease steal should succeed");

    assert!(request.ack.accepted);
    assert!(steal.ack.accepted);
    assert_eq!(request.events.len(), 1);
    assert_eq!(steal.events.len(), 1);

    let first_state = manager
        .client_permission_and_lease(
            &request.ack.session_id,
            &first.snapshot.client_view.client_id,
        )
        .expect("first state lookup should succeed");
    let second_state = manager
        .client_permission_and_lease(
            &request.ack.session_id,
            &second.snapshot.client_view.client_id,
        )
        .expect("second state lookup should succeed");
    assert!(!first_state.1);
    assert!(second_state.1);
}
