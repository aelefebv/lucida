use lucida_engine::{
    AttachRequest, COMMAND_MESSAGE_TYPE, CommandArgs, CommandEnvelope, CommandRouter, CommandScope,
    PermissionClass, SCHEMA_VERSION, SessionManager,
};

#[test]
fn command_router_routes_scene_command_with_authorization_and_lease() {
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
                },
            },
        )
        .expect("scene command should succeed");

    assert!(outcome.ack.accepted);
    assert!(outcome.ack.resulting_scene_rev.is_some());
    assert_eq!(outcome.events.len(), 1);
    assert!(
        outcome
            .ack
            .created_object_id
            .expect("source id should be included")
            .starts_with("src_")
    );
}
