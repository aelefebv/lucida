use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use clap::{Args, Parser, Subcommand};
use tokio::sync::{broadcast, Mutex};
use tower_http::cors::CorsLayer;

use lucida_server::admin::{self, admin_clear_proxy_cache};
use lucida_server::session::Session;
use lucida_server::{browse, handler, AppState, BroadcastItem, ProxyConfig, UnicastRoutes};

// ---------------------------------------------------------------------------
// CLI definition
//
// We support two invocation styles for backward compatibility:
//
//   lucida-server --data-dir /path                       (legacy, no subcommand)
//   lucida-server serve --data-dir /path                 (explicit serve)
//   lucida-server clear-proxy-cache [--dataset URL]      (one-shot admin)
//
// When no subcommand is given we treat the top-level args as `serve`'s
// args. The clap derive macros are invoked with `args_conflicts_with_subcommands`
// so the legacy form keeps working without ambiguity.
// ---------------------------------------------------------------------------

#[derive(Parser, Debug)]
#[command(name = "lucida-server", about = "Lucida collaborative imaging server")]
#[command(args_conflicts_with_subcommands = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Top-level args: only used when no subcommand is given (backward
    /// compat with the pre-clap form `lucida-server --data-dir ...`).
    #[command(flatten)]
    serve_args: ServeArgs,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run the WebSocket server (default if no subcommand is given).
    Serve(ServeArgs),
    /// Clear the on-disk proxy cache for one dataset URL or all datasets.
    ClearProxyCache(ClearArgs),
}

#[derive(Args, Debug, Default)]
struct ServeArgs {
    /// Constrain `/api/browse` to this root directory.
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// Override the proxy cache root (default: platform user cache dir).
    #[arg(long)]
    proxy_cache_dir: Option<PathBuf>,
    /// Override the per-generator concurrency cap (default: NCPU/2).
    #[arg(long)]
    proxy_concurrency: Option<usize>,
}

#[derive(Args, Debug)]
struct ClearArgs {
    /// URL of the dataset to clear. If omitted, clears every dataset
    /// subdirectory under the cache root.
    #[arg(long)]
    dataset: Option<String>,
    /// Override the cache directory (default: platform user cache dir).
    #[arg(long)]
    cache_dir: Option<PathBuf>,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    ws.on_upgrade(move |socket| async move {
        eprintln!("client {id} connected");
        handler::handle_client(
            id,
            socket,
            state.session,
            state.tx,
            state.unicast_routes,
            state.proxy_config,
        )
        .await;
    })
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lucida_server=info".parse().unwrap()),
        )
        .init();

    let cli = Cli::parse();
    // Treat "no subcommand" as `serve` with the top-level flags.
    let command = cli.command.unwrap_or(Commands::Serve(cli.serve_args));

    match command {
        Commands::Serve(args) => run_serve(args).await,
        Commands::ClearProxyCache(args) => run_clear(args),
    }
}

async fn run_serve(args: ServeArgs) -> std::io::Result<()> {
    let data_dir = args.data_dir;
    let proxy_cache_dir = args
        .proxy_cache_dir
        .unwrap_or_else(ProxyConfig::default_cache_dir);
    let proxy_concurrency = args
        .proxy_concurrency
        .map(|n| n.max(1))
        .unwrap_or_else(ProxyConfig::default_concurrency);

    let proxy_config = ProxyConfig {
        cache_dir: proxy_cache_dir,
        concurrency: proxy_concurrency,
    };
    eprintln!(
        "proxy cache dir: {} | concurrency: {}",
        proxy_config.cache_dir.display(),
        proxy_config.concurrency
    );

    let session = Arc::new(Mutex::new(Session::new()));
    let (tx, _) = broadcast::channel::<BroadcastItem>(256);
    let next_id = Arc::new(AtomicU64::new(0));
    let unicast_routes: UnicastRoutes = Arc::new(Mutex::new(HashMap::new()));

    let state = AppState {
        session,
        tx,
        next_id,
        unicast_routes,
        data_dir,
        proxy_config,
    };

    let app = Router::new()
        .route("/", get(ws_handler))
        .route("/ws", get(ws_handler))
        .route("/api/browse", get(browse::browse_handler))
        .route("/admin/clear-proxy-cache", post(admin_clear_proxy_cache))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:9876")
        .await
        .expect("failed to bind to port 9876");
    eprintln!("lucida-server listening on http://0.0.0.0:9876");

    axum::serve(listener, app).await.expect("server error");
    Ok(())
}

fn run_clear(args: ClearArgs) -> std::io::Result<()> {
    let cache_dir = args.cache_dir.unwrap_or_else(admin::default_cache_dir);
    let outcome = admin::clear_proxy_cache(&cache_dir, args.dataset.as_deref())?;
    match args.dataset {
        Some(url) => {
            eprintln!(
                "cleared {} dataset for {} ({} files) under {}",
                outcome.datasets,
                url,
                outcome.files,
                cache_dir.display()
            );
        }
        None => {
            eprintln!(
                "cleared {} datasets ({} files) under {}",
                outcome.datasets,
                outcome.files,
                cache_dir.display()
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// CLI parsing tests
//
// These verify that the legacy invocation form
// `lucida-server --data-dir /path` keeps parsing into a `Serve` command,
// while the new subcommand forms (`serve`, `clear-proxy-cache`) parse as
// expected. The handlers themselves (`run_serve`, `run_clear`) are
// covered by integration tests against the library types.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod cli_tests {
    use super::*;

    fn parse(args: &[&str]) -> Cli {
        Cli::parse_from(std::iter::once("lucida-server").chain(args.iter().copied()))
    }

    #[test]
    fn no_args_defaults_to_serve_with_no_data_dir() {
        let cli = parse(&[]);
        assert!(cli.command.is_none(), "bare invocation has no subcommand");
        assert!(cli.serve_args.data_dir.is_none());
        assert!(cli.serve_args.proxy_cache_dir.is_none());
    }

    #[test]
    fn legacy_data_dir_at_top_level_parses() {
        let cli = parse(&["--data-dir", "/tmp/foo"]);
        assert!(cli.command.is_none(), "no explicit subcommand");
        assert_eq!(cli.serve_args.data_dir.as_deref(), Some(std::path::Path::new("/tmp/foo")));
    }

    #[test]
    fn explicit_serve_with_data_dir_parses() {
        let cli = parse(&["serve", "--data-dir", "/tmp/foo"]);
        match cli.command.expect("serve subcommand") {
            Commands::Serve(args) => {
                assert_eq!(args.data_dir.as_deref(), Some(std::path::Path::new("/tmp/foo")));
            }
            _ => panic!("expected Serve"),
        }
    }

    #[test]
    fn clear_proxy_cache_with_dataset_parses() {
        let cli = parse(&[
            "clear-proxy-cache",
            "--cache-dir",
            "/tmp/cache",
            "--dataset",
            "http://example.com/x",
        ]);
        match cli.command.expect("clear subcommand") {
            Commands::ClearProxyCache(args) => {
                assert_eq!(args.cache_dir.as_deref(), Some(std::path::Path::new("/tmp/cache")));
                assert_eq!(args.dataset.as_deref(), Some("http://example.com/x"));
            }
            _ => panic!("expected ClearProxyCache"),
        }
    }

    #[test]
    fn clear_proxy_cache_without_dataset_parses() {
        let cli = parse(&["clear-proxy-cache"]);
        match cli.command.expect("clear subcommand") {
            Commands::ClearProxyCache(args) => {
                assert!(args.dataset.is_none());
                assert!(args.cache_dir.is_none());
            }
            _ => panic!("expected ClearProxyCache"),
        }
    }
}
