use lucida_engine::{AttachRequest, PermissionClass, SessionManager};

fn main() {
    let mut manager = SessionManager::new();
    let created = manager.create_session("local-session");

    let snapshot = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "local-cli".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("session attach should succeed");

    println!(
        "attached client {} to session {} at session_rev {}",
        snapshot.snapshot.client_view.client_id, snapshot.session_id, snapshot.session_rev
    );
}
