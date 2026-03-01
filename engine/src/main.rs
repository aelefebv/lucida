use lucida_engine::SessionService;

fn main() {
    let mut service = SessionService::new();
    let snapshot = service.create_session();

    println!(
        "created session {} at session_rev {}",
        snapshot.session_id, snapshot.session_rev
    );
}
