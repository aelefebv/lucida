use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::WebSocketUpgrade;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use clap::{Args, Parser, Subcommand};
use tokio::sync::{Mutex, broadcast};
use tower_http::cors::CorsLayer;

use lucida_server::admin::{self, admin_clear_proxy_cache};
use lucida_server::auth;
use lucida_server::bookmarks;
use lucida_server::health;
use lucida_server::session::Session;
use lucida_server::static_serve;
use lucida_server::storage;
use lucida_server::{
    AppState, BroadcastItem, ProxyConfig, UnicastRoutes, browse, handler, workspace,
};

// CLI supports legacy `lucida-server --data-dir /path` (no subcommand,
// treated as `serve`) alongside explicit `serve` / `clear-proxy-cache`
// subcommands. `args_conflicts_with_subcommands` keeps the legacy form
// unambiguous.
#[derive(Parser, Debug)]
#[command(name = "lucida-server", about = "Lucida collaborative imaging server")]
#[command(version)] // pulls from Cargo.toml's [package].version at build time
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
    ///
    /// Also readable from `LUCIDA_DATA_DIR`. CLI flag wins over env
    /// var when both are set (clap's default behavior).
    #[arg(long, env = "LUCIDA_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Override the proxy cache root (default: platform user cache dir).
    ///
    /// Also readable from `LUCIDA_PROXY_CACHE_DIR`. CLI flag wins.
    #[arg(long, env = "LUCIDA_PROXY_CACHE_DIR")]
    proxy_cache_dir: Option<PathBuf>,
    /// Override the per-generator concurrency cap (default: NCPU/2).
    ///
    /// Also readable from `LUCIDA_PROXY_CONCURRENCY`. CLI flag wins.
    #[arg(long, env = "LUCIDA_PROXY_CONCURRENCY")]
    proxy_concurrency: Option<usize>,
    /// Re-enable retired proxy fallback catalogs and asset generation.
    #[arg(long, env = "LUCIDA_LEGACY_PROXY_ENABLED", default_value_t = false)]
    legacy_proxy_enabled: bool,
    /// Enable server-generated coarse chunks.
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_ENABLED", default_value_t = true)]
    generated_coarse_enabled: bool,
    /// Override the generated coarse derived-cache root.
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_CACHE_DIR")]
    generated_coarse_cache_dir: Option<PathBuf>,
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_CONCURRENCY")]
    generated_coarse_concurrency: Option<usize>,
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_BACKGROUND_CHUNKS")]
    generated_coarse_background_chunks: Option<usize>,
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_TARGET_LONG_AXIS")]
    generated_coarse_target_long_axis: Option<u64>,
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_CHUNK_LONG_AXIS")]
    generated_coarse_chunk_long_axis: Option<u64>,
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_MAX_CHUNK_BYTES")]
    generated_coarse_max_chunk_bytes: Option<u64>,
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_DISK_BUDGET_BYTES")]
    generated_coarse_disk_budget_bytes: Option<u64>,
    /// How long a live workspace with no connected clients remains in memory.
    #[arg(long, env = "LUCIDA_WORKSPACE_IDLE_TTL_SECS", default_value_t = 3600)]
    workspace_idle_ttl_secs: u64,
    /// How often the server checks for idle live workspaces.
    #[arg(long, env = "LUCIDA_WORKSPACE_IDLE_SWEEP_SECS", default_value_t = 60)]
    workspace_idle_sweep_secs: u64,
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

// LUCIDA_LOG_FORMAT={text,json} (default text) switches between
// dev-friendly pretty-text and production JSON output. Unknown values
// fall back to Text so a deploy-manifest typo doesn't break boot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LogFormat {
    Text,
    Json,
}

impl LogFormat {
    /// Parse the env-var spelling. Case-insensitive; unknown values
    /// fall back to `Text` (matches the documented default rather than
    /// failing boot). Mirror of `SecureCookieMode::parse`.
    fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "json" => Self::Json,
            // "text" or anything else falls through to Text.
            _ => Self::Text,
        }
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    ws.on_upgrade(move |socket| async move {
        tracing::info!(client_id = id, "ws.client_connected");
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
    // LUCIDA_LOG_FORMAT={text,json} (default text). Both branches share
    // the same EnvFilter + FmtSpan::CLOSE config so `RUST_LOG` filtering
    // and span-close timing per ADR-0012 work identically in either
    // mode; only the line format differs.
    let log_format = std::env::var("LUCIDA_LOG_FORMAT")
        .ok()
        .map(|raw| LogFormat::parse(&raw))
        .unwrap_or(LogFormat::Text);
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "lucida_server=info".parse().unwrap());
    match log_format {
        LogFormat::Text => {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter)
                // Emit a span-close event with elapsed time for every
                // #[tracing::instrument]-wrapped function. See
                // wiki/decisions/0012-logging-conventions.
                .with_span_events(tracing_subscriber::fmt::format::FmtSpan::CLOSE)
                .init();
        }
        LogFormat::Json => {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter)
                .with_span_events(tracing_subscriber::fmt::format::FmtSpan::CLOSE)
                .json()
                .init();
        }
    }

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
        generated_cache_dir: args
            .generated_coarse_cache_dir
            .unwrap_or_else(|| proxy_cache_dir.join("generated-coarse")),
        cache_dir: proxy_cache_dir,
        concurrency: proxy_concurrency,
        legacy_proxy_enabled: args.legacy_proxy_enabled,
        generated_enabled: args.generated_coarse_enabled,
        generated_concurrency: args
            .generated_coarse_concurrency
            .map(|n| n.max(1))
            .unwrap_or(1),
        generated_background_chunk_limit: args.generated_coarse_background_chunks.unwrap_or(32),
        generated_target_long_axis: args.generated_coarse_target_long_axis.unwrap_or(512),
        generated_chunk_long_axis: args.generated_coarse_chunk_long_axis.unwrap_or(256),
        generated_max_chunk_bytes: args
            .generated_coarse_max_chunk_bytes
            .unwrap_or(2 * 1024 * 1024),
        generated_disk_budget_bytes: args.generated_coarse_disk_budget_bytes,
    };
    // Operational logs go through the configured tracing subscriber
    // so RUST_LOG filtering applies (ADR 0012).
    tracing::info!(
        cache_dir = %proxy_config.cache_dir.display(),
        concurrency = proxy_config.concurrency,
        legacy_enabled = proxy_config.legacy_proxy_enabled,
        "proxy.config",
    );
    tracing::info!(
        enabled = proxy_config.generated_enabled,
        cache_dir = %proxy_config.generated_cache_dir.display(),
        concurrency = proxy_config.generated_concurrency,
        background_chunk_limit = proxy_config.generated_background_chunk_limit,
        target_long_axis = proxy_config.generated_target_long_axis,
        chunk_long_axis = proxy_config.generated_chunk_long_axis,
        max_chunk_bytes = proxy_config.generated_max_chunk_bytes,
        disk_budget_bytes = ?proxy_config.generated_disk_budget_bytes,
        "generated_coarse.config",
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
        proxy_config: proxy_config.clone(),
    };

    // Env-var validation lives in `AuthConfig::from_env`: `LUCIDA_BIND`,
    // the auto-detect-by-bind auth-mode default, and the
    // `LUCIDA_INSECURE=1` opt-in for the "disabled + public bind"
    // combination. Failures are fatal at startup with a named-variable
    // error message.
    let auth_config = match auth::AuthConfig::from_env() {
        Ok(c) => Arc::new(c),
        Err(e) => {
            // Emit this before the fail-fast exit so ops can grep
            // `auth.startup.config_error` for "server refused to start
            // because of bad config".
            tracing::error!(error = %e, "auth.startup.config_error");
            return Err(std::io::Error::other(e.to_string()));
        }
    };
    // Operator-facing startup line: mode + bind together so a glance
    // at the boot log answers "is this server reachable, and is it
    // protected?" Per ADR-0018 both signals should be visible together.
    // Stable string mode tag (`"google"` / `"disabled"`) lands cleanly
    // in audit pipelines that key off the exact string rather than the
    // Debug-formatted variant.
    let mode_str = match auth_config.mode {
        auth::AuthMode::Google => "google",
        auth::AuthMode::Disabled => "disabled",
    };
    tracing::info!(
        mode = %mode_str,
        bind = %auth_config.bind_addr,
        cookie = %auth_config.cookie_name,
        db = %auth_config.db_url.redacted(),
        db_backend = %auth_config.db_url.scheme(),
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
        // Structured audit event so the signal lands in the audit log
        // pipeline alongside the other `auth.*` events, not just the
        // operator-eyeballed stderr banner.
        tracing::warn!(
            bind = %auth_config.bind_addr,
            mode = %mode_str,
            "auth.startup.insecure_mode",
        );
        eprintln!("============================================================");
        eprintln!("WARNING: LUCIDA_INSECURE=1 is set");
        eprintln!(
            "AUTH DISABLED on bind {} — server is exposed",
            auth_config.bind_addr
        );
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
    // The only place the server picks a database. Nothing downstream
    // knows which one it got.
    let storage = match storage::open(&auth_config.db_url).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = %e, "storage.startup.open_failed");
            return Err(std::io::Error::other(e.to_string()));
        }
    };
    let session_store_dyn = storage.login_sessions();
    let bearer_token_store = storage.bearer_tokens();
    let cli_authorization_store = storage.cli_token_authorizations();
    let pending_store = storage.pending_auth();

    let extractor = auth::middleware::build_extractor(
        Arc::clone(&auth_config),
        Arc::clone(&session_store_dyn),
        Arc::clone(&bearer_token_store),
    );

    let logout_state = auth::handlers::LogoutState {
        config: Arc::clone(&auth_config),
        store: Arc::clone(&session_store_dyn),
    };
    let cli_auth_state = auth::handlers::CliAuthState {
        config: Arc::clone(&auth_config),
        token_store: Arc::clone(&bearer_token_store),
        cli_store: Arc::clone(&cli_authorization_store),
    };

    // Two auth-route flavors so the OAuth flow doesn't bounce itself:
    //   * `authed_router` — `/auth/whoami` and `/auth/logout`. These
    //     read the principal/cookie, so they MUST run through the auth
    //     middleware (whoami specifically returns 401 when missing).
    //   * `public_router` — `/auth/start` and `/auth/callback`. These
    //     mint sessions and must NOT be wrapped — otherwise an unauthed
    //     user hitting `/auth/start` would be 401'd into the unauth
    //     landing, which then redirects back to `/auth/start` (infinite
    //     loop).
    let authed_auth_router: Router<()> = Router::new()
        .route("/auth/whoami", get(auth::handlers::whoami))
        .route(
            "/auth/cli/approve/{request_id}",
            get(auth::handlers::cli_auth_approve_page)
                .post(auth::handlers::cli_auth_approve_submit)
                .with_state(cli_auth_state.clone()),
        )
        .route(
            "/auth/tokens/revoke-current",
            post(auth::handlers::revoke_current_bearer_token).with_state(cli_auth_state.clone()),
        )
        .route(
            "/auth/logout",
            post(auth::handlers::logout).with_state(logout_state),
        );

    // The bookmarks router lands on the protected half, so every
    // handler sees an `AuthPrincipal` in extensions.
    let bookmarks_state = bookmarks::handlers::BookmarksState {
        store: storage.bookmarks(),
        // Plumb the live session + unicast routes so handlers can
        // broadcast `BookmarkChanged` to clients with overlapping
        // loaded datasets after every successful CUD operation.
        session: Some(Arc::clone(&state.session)),
        unicast_routes: Some(Arc::clone(&state.unicast_routes)),
    };
    let bookmarks_router: Router<()> = bookmarks::routes::router(bookmarks_state);

    let workspace_store = storage.workspaces();
    let workspace_runtime_config = workspace::WorkspaceRuntimeConfig {
        idle_ttl: Duration::from_secs(args.workspace_idle_ttl_secs),
        idle_sweep_interval: Duration::from_secs(args.workspace_idle_sweep_secs.max(1)),
    };
    tracing::info!(
        idle_ttl_secs = workspace_runtime_config.idle_ttl.as_secs(),
        idle_sweep_secs = workspace_runtime_config.idle_sweep_interval.as_secs(),
        "workspace.runtime.config"
    );
    let workspace_manager = Arc::new(workspace::WorkspaceManager::new_with_runtime_config(
        workspace_store,
        proxy_config.clone(),
        workspace_runtime_config,
    ));
    let _workspace_idle_eviction_handle = workspace_manager.spawn_idle_eviction_loop();
    let workspaces_router: Router<()> = workspace::router(workspace_manager);

    // /auth/error is available regardless of auth mode — if the user
    // somehow reaches it (a stale link, a misconfigured deployment),
    // we still render the generic page rather than 404. Mounted on
    // the public router so the auth middleware never wraps it (the
    // user is unauthenticated by definition when they're being told
    // to retry sign-in).
    let dev_auth_state = auth::handlers::DevAuthState {
        config: Arc::clone(&auth_config),
        enabled: auth_config.mode == auth::AuthMode::Disabled,
    };
    let mut public_auth_router: Router<()> = Router::new()
        .route("/auth/error", get(auth::error_page::auth_error))
        .route(
            "/auth/cli/start",
            post(auth::handlers::cli_auth_start).with_state(cli_auth_state.clone()),
        )
        .route(
            "/auth/cli/poll/{request_id}",
            get(auth::handlers::cli_auth_poll).with_state(cli_auth_state.clone()),
        )
        .route(
            "/auth/dev/status",
            get(auth::handlers::dev_status).with_state(dev_auth_state.clone()),
        );
    if auth_config.mode == auth::AuthMode::Disabled {
        public_auth_router = public_auth_router.route(
            "/auth/dev/login",
            post(auth::handlers::dev_login).with_state(dev_auth_state.clone()),
        );
    }
    if let Some(g) = auth_config.google.clone() {
        let google_client = match auth::GoogleOAuthClient::new(Arc::new(g)).await {
            Ok(c) => Arc::new(c),
            Err(e) => {
                tracing::error!(error = %e, "auth.startup.google_client_init_failed");
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
    // Liveness/readiness probes mounted on the public router half so
    // the kubelet (which presents no session cookie) can hit them
    // without being 401'd. Always-200 today; the split between
    // `/healthz` and `/readyz` exists so future drain-on-shutdown can
    // flip readiness to 503 while liveness stays 200, letting the LB
    // stop routing without the kubelet restarting the pod mid-drain.
    // See `lucida-server/src/health.rs`.
    public_auth_router = public_auth_router.merge(health::router());

    // ADR-0020: serve the SPA bundle from `LUCIDA_WEB_DIST` (default
    // `./lucida-web/dist`) via `tower-http::ServeDir`. Lands on the
    // public router half so HTML/JS/CSS aren't 401'd by the auth
    // middleware — auth gates remain on `/auth/whoami` polling and
    // `/api/*` calls. Merged LAST below so route-specific handlers
    // (`/auth/*`, `/api/*`, `/admin/*`, `/ws`) take precedence and the
    // SPA fallback only fires for truly unknown paths. The dist
    // directory is re-stat'd on every request, so a dev who builds the
    // SPA mid-session sees fresh content without restarting the server.
    let web_dist = PathBuf::from(
        std::env::var("LUCIDA_WEB_DIST").unwrap_or_else(|_| "./lucida-web/dist".to_string()),
    );
    tracing::info!(
        web_dist = %web_dist.display(),
        "static_serve.config",
    );
    let static_serve_router = static_serve::router(web_dist);

    // App routes carry the auth middleware; public auth routes don't.
    //
    // ADR-0020: `/` no longer routes to the WebSocket handler — it now
    // falls through to the SPA `static_serve` fallback below so a browser
    // hitting `:9876` directly sees the app instead of a 401 / unauth
    // landing. WebSocket clients use `/ws` (already the canonical path
    // used by `lucida-web/src/bridge.ts`); `lucida-cli` callers that
    // relied on the legacy `ws://localhost:9876` default URL must now
    // pass `--server ws://localhost:9876/ws` explicitly.
    let app_state_router = Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/browse", get(browse::browse_handler))
        .route("/admin/clear-proxy-cache", post(admin_clear_proxy_cache))
        .with_state(state)
        .merge(authed_auth_router)
        .merge(bookmarks_router)
        .merge(workspaces_router)
        .layer(axum::middleware::from_fn_with_state(
            extractor,
            auth::middleware::auth_middleware,
        ));

    let app = app_state_router
        .merge(public_auth_router)
        // ADR-0020: SPA static-serve catch-all. Merged last so the
        // fallback only fires for paths no other route claimed.
        .merge(static_serve_router)
        .layer(CorsLayer::permissive());

    // Hourly background sweep of expired session + pending-auth rows.
    // Spawned here (after stores are open, before the listener accepts
    // connections) so the loop runs for the lifetime of the process.
    // Holding the JoinHandle keeps the task alive — dropping the
    // handle would abort the spawned future. Operational logs only
    // (no PII per row); per-user audit lives in `auth.signin.success`
    // and `auth.logout`.
    let _cleanup_handle = auth::spawn_cleanup(auth::CleanupState {
        config: Arc::clone(&auth_config),
        session_store: Arc::clone(&session_store_dyn),
        pending_store: Arc::clone(&pending_store),
    });
    tracing::info!(
        startup_delay_s = auth::cleanup::STARTUP_DELAY.as_secs(),
        interval_s = auth::cleanup::SWEEP_INTERVAL.as_secs(),
        pending_ttl_s = auth::cleanup::PENDING_TTL.as_secs(),
        "auth.cleanup.spawned",
    );

    // ADR-0018: LUCIDA_BIND defaults to 127.0.0.1:9876 (loopback) so
    // `cargo run --bin lucida-server` is friction-free for local dev.
    // Set LUCIDA_BIND=0.0.0.0:9876 (or a deployment-specific interface)
    // to expose on all interfaces; production deployments must do so
    // explicitly.
    let bind_addr = auth_config.bind_addr;
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind to {bind_addr}: {e}"));
    tracing::info!(bind = %bind_addr, "server.listening");

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
        assert!(!cli.serve_args.legacy_proxy_enabled);
    }

    #[test]
    fn legacy_data_dir_at_top_level_parses() {
        let cli = parse(&["--data-dir", "/tmp/foo"]);
        assert!(cli.command.is_none(), "no explicit subcommand");
        assert_eq!(
            cli.serve_args.data_dir.as_deref(),
            Some(std::path::Path::new("/tmp/foo"))
        );
    }

    #[test]
    fn explicit_serve_with_data_dir_parses() {
        let cli = parse(&["serve", "--data-dir", "/tmp/foo"]);
        match cli.command.expect("serve subcommand") {
            Commands::Serve(args) => {
                assert_eq!(
                    args.data_dir.as_deref(),
                    Some(std::path::Path::new("/tmp/foo"))
                );
            }
            _ => panic!("expected Serve"),
        }
    }

    #[test]
    fn legacy_proxy_flag_parses() {
        let cli = parse(&["serve", "--legacy-proxy-enabled"]);
        match cli.command.expect("serve subcommand") {
            Commands::Serve(args) => {
                assert!(args.legacy_proxy_enabled);
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
                assert_eq!(
                    args.cache_dir.as_deref(),
                    Some(std::path::Path::new("/tmp/cache"))
                );
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
