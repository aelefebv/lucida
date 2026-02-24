use std::env;

use lucida_daemon::app;

#[tokio::main]
async fn main() {
    let bind_addr = env::var("LUCIDA_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_owned());
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .unwrap_or_else(|error| panic!("failed to bind {bind_addr}: {error}"));

    axum::serve(listener, app())
        .await
        .unwrap_or_else(|error| panic!("server exited with error: {error}"));
}
