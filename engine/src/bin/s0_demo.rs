use std::collections::BTreeMap;

use lucida_engine::{
    AttachRequest, CommandArgs, CommandEnvelope, CommandOutcome, CommandRouter, CommandScope,
    ErrorCode, ErrorDetails, ErrorEnvelope, ErrorMessageSerializer, EventBus,
    EventMessageSerializer, PermissionClass, ProjectionState, ReconnectRequest, SessionManager,
    command_error_to_envelope,
};

#[derive(Debug)]
struct DemoContext {
    session_id: String,
    request_seq: u64,
    client_seq: BTreeMap<String, u64>,
    router: CommandRouter,
    session_manager: SessionManager,
    event_bus: EventBus,
    projection: ProjectionState,
}

impl DemoContext {
    fn new(
        session_manager: SessionManager,
        session_id: String,
        initial_snapshot: &lucida_engine::SessionSnapshotEnvelope,
    ) -> Self {
        Self {
            session_id,
            request_seq: 0,
            client_seq: BTreeMap::new(),
            router: CommandRouter::new(),
            session_manager,
            event_bus: EventBus::new(),
            projection: ProjectionState::from_snapshot(initial_snapshot),
        }
    }

    fn reset_projection(&mut self, snapshot: &lucida_engine::SessionSnapshotEnvelope) {
        self.projection = ProjectionState::from_snapshot(snapshot);
    }

    fn next_request_id(&mut self) -> String {
        self.request_seq = self.request_seq.saturating_add(1);
        format!("req_{:08}", self.request_seq)
    }

    fn next_client_seq(&mut self, client_id: &str) -> u64 {
        let next = self.client_seq.get(client_id).copied().unwrap_or(0) + 1;
        self.client_seq.insert(client_id.to_owned(), next);
        next
    }

    fn build_command(
        &mut self,
        client_id: &str,
        op: &str,
        scope: CommandScope,
        requires_lease: bool,
        args: CommandArgs,
    ) -> CommandEnvelope {
        CommandEnvelope {
            message_type: lucida_engine::COMMAND_MESSAGE_TYPE.to_owned(),
            schema_version: lucida_engine::SCHEMA_VERSION.to_owned(),
            session_id: self.session_id.clone(),
            request_id: self.next_request_id(),
            client_id: client_id.to_owned(),
            client_seq: self.next_client_seq(client_id),
            op: op.to_owned(),
            scope,
            requires_lease,
            args,
        }
    }

    fn run_command(
        &mut self,
        client_id: &str,
        op: &str,
        scope: CommandScope,
        requires_lease: bool,
        args: CommandArgs,
    ) -> Result<CommandOutcome, Box<ErrorEnvelope>> {
        let command = self.build_command(client_id, op, scope, requires_lease, args);
        match self
            .router
            .route(&mut self.session_manager, command.clone())
        {
            Ok(outcome) => {
                self.apply_outcome(&outcome);
                Ok(outcome)
            }
            Err(error) => Err(Box::new(command_error_to_envelope(&command, &error))),
        }
    }

    fn apply_outcome(&mut self, outcome: &CommandOutcome) {
        for event in &outcome.events {
            let monotonic = self
                .event_bus
                .events()
                .last()
                .is_none_or(|last| event.session_rev > last.session_rev);
            if !monotonic {
                println!(
                    "  event: {:?} (session_rev={}) [co-revision sideband]",
                    event.event_type, event.session_rev
                );
                continue;
            }

            self.event_bus
                .publish(event.clone())
                .expect("event should publish with monotonic revisions");
            self.projection
                .apply_event(event)
                .expect("projection should accept authoritative event");
            println!(
                "  event: {:?} (session_rev={})",
                event.event_type, event.session_rev
            );
        }
    }
}

fn print_snapshot(label: &str, snapshot: &lucida_engine::SessionSnapshotEnvelope) {
    println!("{label}:");
    println!("  session_id={}", snapshot.session_id);
    println!("  session_rev={}", snapshot.session_rev);
    println!(
        "  client_id={} permission={:?}",
        snapshot.snapshot.client_view.client_id, snapshot.snapshot.permissions.permission_class
    );
    println!(
        "  scene: sources={} layers={} roster={}",
        snapshot.snapshot.shared_scene.sources.len(),
        snapshot.snapshot.shared_scene.layers.len(),
        snapshot.snapshot.client_roster.len()
    );
    println!("  warnings={}", snapshot.snapshot.warnings.len());
}

fn main() {
    println!("Lucida S0 canonical demo");
    println!("=======================");

    let mut session_manager = SessionManager::new();
    let created = session_manager.create_session("s0-canonical-demo");
    println!("created session: {}", created.session_id);

    let control_snapshot = session_manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "control-client".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("control attach should succeed");
    let viewer_snapshot = session_manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "viewer-client".to_owned(),
            requested_permission: PermissionClass::View,
        })
        .expect("viewer attach should succeed");

    print_snapshot("control attach snapshot", &control_snapshot);
    print_snapshot("viewer attach snapshot", &viewer_snapshot);

    let control_client_id = control_snapshot.snapshot.client_view.client_id.clone();
    let mut viewer_client_id = viewer_snapshot.snapshot.client_view.client_id.clone();

    let mut demo = DemoContext::new(
        session_manager,
        created.session_id.clone(),
        &control_snapshot,
    );

    println!();
    println!("1) Validate typed lease error before lease acquisition");
    let lease_error = demo
        .run_command(
            &control_client_id,
            "scene.add_source",
            CommandScope::SceneShared,
            true,
            CommandArgs::SceneAddSource {
                name: "source-before-lease".to_owned(),
            },
        )
        .expect_err("scene mutation without lease should fail");
    assert_eq!(lease_error.code, ErrorCode::LeaseRequired);
    assert!(matches!(
        lease_error.details,
        ErrorDetails::LeaseRequired(_)
    ));
    let encoded_error =
        ErrorMessageSerializer::serialize(&lease_error).expect("error envelope should serialize");
    let decoded_error = ErrorMessageSerializer::deserialize(&encoded_error)
        .expect("error envelope should deserialize");
    println!(
        "  typed error: code={:?} retryable={}",
        decoded_error.code, decoded_error.retryable
    );

    println!();
    println!("2) Acquire lease and perform shared scene edits");
    let _ = demo
        .run_command(
            &control_client_id,
            "lease.request",
            CommandScope::SceneShared,
            false,
            CommandArgs::LeaseRequest,
        )
        .expect("lease request should succeed");

    let source_outcome = demo
        .run_command(
            &control_client_id,
            "scene.add_source",
            CommandScope::SceneShared,
            true,
            CommandArgs::SceneAddSource {
                name: "demo-source".to_owned(),
            },
        )
        .expect("source add should succeed");
    let layer_outcome = demo
        .run_command(
            &control_client_id,
            "scene.layer_add",
            CommandScope::SceneShared,
            true,
            CommandArgs::SceneLayerAdd {
                name: "demo-layer".to_owned(),
            },
        )
        .expect("layer add should succeed");

    println!(
        "  source id={:?}, layer id={:?}",
        source_outcome.ack.created_object_id, layer_outcome.ack.created_object_id
    );

    println!();
    println!("3) Trigger warning aggregation through per-client state");
    let _ = demo
        .run_command(
            &viewer_client_id,
            "view.set_active_layer",
            CommandScope::ClientView,
            false,
            CommandArgs::ViewSetActiveLayer {
                active_layer_id: Some("lay_missing".to_owned()),
            },
        )
        .expect("view update should succeed");

    let warnings = demo
        .session_manager
        .combined_warnings_for_client(&created.session_id, &viewer_client_id)
        .expect("warning lookup should succeed");
    assert!(!warnings.is_empty());
    println!("  combined warnings for viewer={}", warnings.len());

    println!();
    println!("4) Heartbeat, idle disconnect, and reconnect");
    let heartbeat = demo
        .session_manager
        .heartbeat(&created.session_id, &control_client_id)
        .expect("heartbeat should succeed");
    println!(
        "  heartbeat: type={} session_rev={}",
        heartbeat.message_type, heartbeat.session_rev
    );

    let removed = demo
        .session_manager
        .disconnect_idle_clients(&created.session_id, 0)
        .expect("idle disconnect should succeed");
    println!("  idle disconnected clients={removed:?}");
    assert_eq!(removed, vec![viewer_client_id.clone()]);

    let reconnect_snapshot = demo
        .session_manager
        .reconnect_client(ReconnectRequest {
            session_id: created.session_id.clone(),
            previous_client_id: Some(viewer_client_id.clone()),
            client_label: "viewer-client".to_owned(),
            requested_permission: PermissionClass::View,
        })
        .expect("reconnect should succeed");
    viewer_client_id = reconnect_snapshot.snapshot.client_view.client_id.clone();
    print_snapshot("reconnect snapshot", &reconnect_snapshot);
    assert_eq!(reconnect_snapshot.snapshot.shared_scene.sources.len(), 1);
    assert_eq!(reconnect_snapshot.snapshot.shared_scene.layers.len(), 1);
    demo.reset_projection(&reconnect_snapshot);

    let stable_layer_id = reconnect_snapshot
        .snapshot
        .shared_scene
        .layer_order
        .first()
        .cloned()
        .expect("layer should exist after reconnect");
    let _ = demo
        .run_command(
            &viewer_client_id,
            "view.set_active_layer",
            CommandScope::ClientView,
            false,
            CommandArgs::ViewSetActiveLayer {
                active_layer_id: Some(stable_layer_id),
            },
        )
        .expect("view update after reconnect should succeed");

    println!();
    println!("5) Snapshot + event stream ordering checks");
    println!("  event count={}", demo.event_bus.events().len());
    if let Some(first_event) = demo.event_bus.events().first() {
        let wire = EventMessageSerializer::serialize(first_event).expect("event should serialize");
        println!("  first event wire payload={wire}");
    }
    println!("  projection session_rev={}", demo.projection.session_rev);
    println!(
        "  projection sources={} layers={}",
        demo.projection.sources.len(),
        demo.projection.layers.len()
    );

    println!();
    println!("S0 canonical demo completed successfully.");
}
