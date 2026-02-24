use std::env;

use lucida_daemon::app;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    init_tracing();
    let active_features = feature_list();
    tracing::info!(
        active_features = %active_features,
        "starting lucida-daemon",
    );

    let bind_addr = env::var("LUCIDA_DAEMON_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_owned());
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .unwrap_or_else(|error| panic!("failed to bind {bind_addr}: {error}"));

    axum::serve(listener, app())
        .await
        .unwrap_or_else(|error| panic!("server exited with error: {error}"));
}

fn init_tracing() {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,lucida.cache=debug"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(true)
        .try_init();
}

fn feature_list() -> String {
    let mut features: Vec<&'static str> = Vec::new();
    #[cfg(feature = "gpu")]
    features.push("gpu");
    #[cfg(feature = "software")]
    features.push("software");
    if features.is_empty() {
        return "none".to_owned();
    }
    features.join(",")
}
