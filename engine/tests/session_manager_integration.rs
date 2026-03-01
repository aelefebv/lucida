use lucida_engine::{
    AddSourceRequest, AttachRequest, AxisName, ClientViewMode, PermissionClass, ReconnectRequest,
    SessionManager, SourceKind,
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
fn session_manager_public_api_allocates_ids_and_revisions() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc200_session_manager_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    let source_path = fixture_dir.join("integration-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-session");

    let attached = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "integration-client".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("attach should succeed");

    let registered = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "integration-source".to_owned(),
                uri: source_path.display().to_string(),
            },
        )
        .expect("source add should succeed");
    let layer = manager
        .add_layer(&created.session_id, "integration-layer")
        .expect("layer add should succeed");

    let generation_seq = manager
        .bump_source_generation_seq(&created.session_id, &registered.source.source_id)
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
    assert!(registered.source.source_id.starts_with("src_"));
    assert!(registered.dataset.dataset_id.starts_with("ds_"));
    assert_eq!(registered.source.source_kind, SourceKind::Tiff);
    assert_eq!(registered.source.source_metadata.shape.x, 32);
    assert_eq!(registered.source.source_metadata.shape.y, 16);
    assert_eq!(registered.source.source_metadata.shape.c, 3);
    assert_eq!(
        registered.dataset.canonical_axes,
        vec![
            AxisName::T,
            AxisName::C,
            AxisName::Z,
            AxisName::Y,
            AxisName::X
        ]
    );
    assert!(layer.layer_id.starts_with("lay_"));
    assert_eq!(generation_seq, 1);
    assert_eq!(metadata_rev, 1);
    assert_eq!(write_rev, 1);
    assert_eq!(view_rev, 1);

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
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
