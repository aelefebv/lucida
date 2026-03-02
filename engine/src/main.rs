use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

use lucida_engine::{EngineRuntimeConfig, run_runtime_server};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const DEFAULT_BIND: &str = "127.0.0.1:8787";
const DEFAULT_CACHE_ROOT: &str = ".tmp/cache";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bind = DEFAULT_BIND.to_owned();
    let mut cache_root = PathBuf::from(DEFAULT_CACHE_ROOT);

    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--bind" => {
                if let Some(value) = args.next() {
                    bind = value;
                }
            }
            "--cache-root" => {
                if let Some(value) = args.next() {
                    cache_root = PathBuf::from(value);
                }
            }
            _ => {}
        }
    }

    let bind_addr: SocketAddr = bind.parse()?;
    let listener = TcpListener::bind(bind_addr).await?;
    let local_addr = listener.local_addr()?;

    println!(
        "lucida-engine runtime listening on http://{} (cache root: {})",
        local_addr,
        cache_root.display()
    );

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = shutdown_tx.send(());
    });

    run_runtime_server(
        listener,
        EngineRuntimeConfig {
            cache_root,
            ..EngineRuntimeConfig::default()
        },
        shutdown_rx,
    )
    .await?;
    Ok(())
}
