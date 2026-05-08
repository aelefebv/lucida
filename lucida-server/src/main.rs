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
use lucida_server::auth;
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
        // Emit a span-close event with elapsed time for every
        // #[tracing::instrument]-wrapped function. See
        // wiki/decisions/logging-conventions.md.
        .with_span_events(tracing_subscriber::fmt::format::FmtSpan::CLOSE)
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

    // Slice 2 (issue #457) landed the session store + cookie extractor.
    // Slice 4 (issue #460) layers the Google OAuth flow on top.
    // Slice 7 (issue #462) consolidates env-var validation here:
    // `LUCIDA_BIND`, the auto-detect-by-bind auth-mode default, and
    // the `LUCIDA_INSECURE=1` opt-in for the "disabled + public bind"
    // combination all live in `AuthConfig::from_env`. Failures are
    // fatal at startup with a named-variable error message.
    let auth_config = match auth::AuthConfig::from_env() {
        Ok(c) => Arc::new(c),
        Err(e) => {
            eprintln!("auth config error: {e}");
            return Err(std::io::Error::other(e.to_string()));
        }
    };
    // Operator-facing startup line: mode + bind together so a glance
    // at the boot log answers "is this server reachable, and is it
    // protected?" Per ADR-0018 both signals should be visible together.
    tracing::info!(
        mode = ?auth_config.mode,
        bind = %auth_config.bind_addr,
        cookie = %auth_config.cookie_name,
        db = %auth_config.db_path.display(),
        idle_timeout_s = auth_config.idle_timeout.as_secs(),
        hard_cap_s = auth_config.hard_cap.as_secs(),
        "auth.startup",
    );
    // Audit signal: explicit acknowledgment that we're running with
    // auth disabled on a non-loopback bind. This combination should
    // raise eyebrows in code review (ADR-0018 §"Consequences"); the
    // banner is multi-line on purpose so it survives log truncation
    // and stands out in `journalctl` / k8s logs.
    if auth_config.insecure_acknowledged {
        tracing::warn!(
            bind = %auth_config.bind_addr,
            "AUTH DISABLED on a non-loopback bind — server is exposed without authentication",
        );
        eprintln!("============================================================");
        eprintln!("WARNING: LUCIDA_INSECURE=1 is set");
        eprintln!("AUTH DISABLED on bind {} — server is exposed", auth_config.bind_addr);
        eprintln!("without authentication. Do not use in production.");
        eprintln!("============================================================");
    }
    if let Some(g) = auth_config.google.as_ref() {
        tracing::info!(
            client_id_prefix = %g.client_id.chars().take(6).collect::<String>(),
            client_id_suffix = %g.client_id.chars().rev().take(4).collect::<String>(),
            redirect_uri = %g.redirect_uri,
            jwks_uri = %g.jwks_uri,
            "auth.google.configured",
        );
    }
    let session_store = match auth::SqliteSessionStore::open(&auth_config.db_path).await {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("failed to open session store: {e}");
            return Err(std::io::Error::other(e.to_string()));
        }
    };
    let session_store_dyn: Arc<dyn auth::LoginSessionStore> = session_store.clone();
    // Pending-auth store rides the same SQLite pool the session store
    // opened (one DB, one migration system, one connection budget).
    let pending_store: Arc<dyn auth::PendingAuthStore> = Arc::new(
        auth::SqlitePendingAuthStore::new(session_store.pool().clone()),
    );

    let extractor = auth::middleware::build_extractor(
        Arc::clone(&auth_config),
        Arc::clone(&session_store_dyn),
    );

    let dev_login_state = auth::handlers::DevLoginState {
        config: Arc::clone(&auth_config),
        store: Arc::clone(&session_store_dyn),
    };
    let logout_state = auth::handlers::LogoutState {
        config: Arc::clone(&auth_config),
        store: Arc::clone(&session_store_dyn),
    };

    // Two auth-route flavors so the OAuth flow doesn't bounce itself:
    //   * `authed_router` — `/auth/whoami` and `/auth/logout`. These
    //     read the principal/cookie, so they MUST run through the auth
    //     middleware (whoami specifically returns 401 when missing).
    //   * `public_router` — `/auth/start`, `/auth/callback`, and the
    //     dev-only `/auth/dev/login`. These mint sessions and must NOT
    //     be wrapped — otherwise an unauthed user hitting `/auth/start`
    //     would be 401'd into the unauth landing, which then redirects
    //     back to `/auth/start` (infinite loop).
    let authed_auth_router: Router<()> = Router::new()
        .route("/auth/whoami", get(auth::handlers::whoami))
        .route(
            "/auth/logout",
            post(auth::handlers::logout).with_state(logout_state),
        );

    // /auth/error is available regardless of auth mode — if the user
    // somehow reaches it (a stale link, a misconfigured deployment),
    // we still render the generic page rather than 404. Mounted on
    // the public router so the auth middleware never wraps it (the
    // user is unauthenticated by definition when they're being told
    // to retry sign-in).
    let mut public_auth_router: Router<()> = Router::new()
        .route("/auth/error", get(auth::error_page::auth_error));
    if let Some(g) = auth_config.google.clone() {
        let google_client = match auth::GoogleOAuthClient::new(Arc::new(g)).await {
            Ok(c) => Arc::new(c),
            Err(e) => {
                eprintln!("auth: failed to initialize Google client: {e}");
                return Err(std::io::Error::other(e.to_string()));
            }
        };
        let oauth_state = auth::handlers::OAuthState {
            config: Arc::clone(&auth_config),
            session_store: Arc::clone(&session_store_dyn),
            pending_store: Arc::clone(&pending_store),
            google: Arc::clone(&google_client),
        };
        public_auth_router = public_auth_router
            .route(
                "/auth/start",
                get(auth::handlers::auth_start)
                    .post(auth::handlers::auth_start)
                    .with_state(oauth_state.clone()),
            )
            .route(
                "/auth/callback",
                get(auth::handlers::auth_callback).with_state(oauth_state),
            );
    }
    if auth::is_dev_mode() {
        eprintln!("auth: dev mode — exposing POST /auth/dev/login");
        public_auth_router = public_auth_router.route(
            "/auth/dev/login",
            post(auth::handlers::dev_login).with_state(dev_login_state),
        );
    }

    // App routes carry the auth middleware; public auth routes don't.
    let app_state_router = Router::new()
        .route("/", get(ws_handler))
        .route("/ws", get(ws_handler))
        .route("/api/browse", get(browse::browse_handler))
        .route("/admin/clear-proxy-cache", post(admin_clear_proxy_cache))
        .with_state(state)
        .merge(authed_auth_router)
        .layer(axum::middleware::from_fn_with_state(
            extractor,
            auth::middleware::auth_middleware,
        ));

    let app = app_state_router
        .merge(public_auth_router)
        .layer(CorsLayer::permissive());

    // ADR-0018: LUCIDA_BIND defaults to 127.0.0.1:9876 (loopback) so
    // `cargo run --bin lucida-server` is friction-free for local dev.
    // Set LUCIDA_BIND=0.0.0.0:9876 (or a deployment-specific interface)
    // to expose on all interfaces; production deployments must do so
    // explicitly. Pre-slice-7 deployments that relied on the old
    // hardcoded 0.0.0.0 default need to set LUCIDA_BIND going forward.
    let bind_addr = auth_config.bind_addr;
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind to {bind_addr}: {e}"));
    tracing::info!(bind = %bind_addr, "lucida-server listening");
    eprintln!("lucida-server listening on http://{bind_addr}");

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
