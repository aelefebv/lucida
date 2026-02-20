use anyhow::Result;
use lucida_daemon::{parse_socket_path, Daemon};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_target(false)
        .compact()
        .init();

    let args: Vec<String> = std::env::args().collect();
    let config = parse_socket_path(&args);

    let daemon = Daemon::new();
    daemon.run(config).await
}
