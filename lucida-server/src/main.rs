#![deny(clippy::print_stderr)]

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::http::Method;
use axum::http::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HOST};
use axum::routing::{get, post};
use axum::{Extension, Router};
use clap::{Args, Parser, Subcommand};
use tower_http::cors::{AllowOrigin, CorsLayer};

use lucida_server::admin::{self, admin_clear_proxy_cache};
use lucida_server::auth;
use lucida_server::health;
use lucida_server::legacy_bookmark_recovery::{self, RecoveryRequest, RecoveryVisibility};
use lucida_server::static_serve;
use lucida_server::{AppState, DatasetRuntimeConfig, browse, workspace};

// CLI supports legacy `lucida-server --data-dir /path` (no subcommand,
// treated as `serve`) alongside explicit `serve` / `clear-proxy-cache`
// subcommands. `args_conflicts_with_subcommands` keeps the legacy form
// unambiguous.
#[derive(Parser, Debug)]
#[command(name = "lucida-server", about = "Lucida collaborative imaging server")]
#[command(version = health::BUILD_VERSION)]
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
    Serve(Box<ServeArgs>),
    /// Clear the on-disk proxy cache for one dataset URL or all datasets.
    ClearProxyCache(ClearArgs),
    /// Probe this server's readiness (used by the container healthcheck).
    Healthcheck(HealthcheckArgs),
    /// Validate or apply recovery of one retired bookmark into a workspace.
    RecoverLegacyBookmark(RecoverLegacyBookmarkArgs),
}

#[derive(Args, Debug, Default)]
struct ServeArgs {
    /// Constrain `/api/browse` to this root directory.
    ///
    /// Also readable from `LUCIDA_DATA_DIR`. CLI flag wins over env
    /// var when both are set (clap's default behavior).
    #[arg(long, env = "LUCIDA_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// HTTP(S) dataset hosts allowed for server-side reads. DNS answers must
    /// also be public unless covered by an allowed CIDR.
    #[arg(long, env = "LUCIDA_SOURCE_HTTP_HOSTS", value_delimiter = ',')]
    source_http_hosts: Vec<String>,
    /// Network ranges allowed for HTTP(S) dataset reads. This is the explicit
    /// opt-in for intentional private/LAN sources.
    #[arg(long, env = "LUCIDA_SOURCE_HTTP_CIDRS", value_delimiter = ',')]
    source_http_cidrs: Vec<String>,
    /// Deployment-specific IPv6 translation/transition prefixes to reject.
    /// Use this for RFC 6052 network-specific prefixes, which cannot be
    /// recognized from the address alone. Built-in standard prefixes are
    /// always rejected.
    #[arg(
        long,
        env = "LUCIDA_SOURCE_HTTP_IPV6_TRANSLATION_CIDRS",
        value_delimiter = ','
    )]
    source_http_ipv6_translation_cidrs: Vec<String>,
    /// S3 buckets an editor may open through server credentials.
    #[arg(long, env = "LUCIDA_SOURCE_S3_BUCKETS", value_delimiter = ',')]
    source_s3_buckets: Vec<String>,
    /// GCS buckets an editor may open through server credentials.
    #[arg(long, env = "LUCIDA_SOURCE_GCS_BUCKETS", value_delimiter = ',')]
    source_gcs_buckets: Vec<String>,
    /// Permit the process ambient cloud identity, restricted to the explicit
    /// bucket allowlists above.
    #[arg(
        long,
        env = "LUCIDA_SOURCE_ALLOW_AMBIENT_CLOUD_CREDENTIALS",
        default_value_t = false
    )]
    source_allow_ambient_cloud_credentials: bool,
    /// Hard process-resident budget shared by source cache bodies, in-flight
    /// reads, decode work, and generated ready chunks.
    #[arg(
        long,
        env = "LUCIDA_MEMORY_BUDGET_BYTES",
        default_value_t = 512 * 1024 * 1024
    )]
    memory_budget_bytes: usize,
    /// Reject any one source object larger than this before collecting its
    /// response body.
    #[arg(
        long,
        env = "LUCIDA_MAX_SOURCE_OBJECT_BYTES",
        default_value_t = 64 * 1024 * 1024
    )]
    max_source_object_bytes: usize,
    /// Enable server-generated coarse chunks.
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_ENABLED", default_value_t = true)]
    generated_coarse_enabled: bool,
    /// Override the generated coarse derived-cache root.
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_CACHE_DIR")]
    generated_coarse_cache_dir: Option<PathBuf>,
    /// Retired proxy-cache root, used only by cache-clear upgrade cleanup.
    /// `LUCIDA_PROXY_CACHE_DIR` is preserved as an explicit deprecated
    /// compatibility input; generated-coarse writes never target this root.
    #[arg(long, env = "LUCIDA_PROXY_CACHE_DIR")]
    legacy_proxy_cache_dir: Option<PathBuf>,
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
    #[arg(
        long,
        env = "LUCIDA_GENERATED_COARSE_DISK_BUDGET_BYTES",
        default_value_t = lucida_server::DEFAULT_GENERATED_DISK_BUDGET_BYTES
    )]
    generated_coarse_disk_budget_bytes: u64,
    /// How long a live workspace with no connected clients remains in memory.
    #[arg(long, env = "LUCIDA_WORKSPACE_IDLE_TTL_SECS", default_value_t = 3600)]
    workspace_idle_ttl_secs: u64,
    /// How often the server checks for idle live workspaces.
    #[arg(long, env = "LUCIDA_WORKSPACE_IDLE_SWEEP_SECS", default_value_t = 60)]
    workspace_idle_sweep_secs: u64,
    /// Hard process-wide byte budget shared by every WebSocket outbound queue.
    #[arg(
        long,
        env = "LUCIDA_WEBSOCKET_OUTBOX_BUDGET_BYTES",
        default_value_t = lucida_server::outbox::DEFAULT_PROCESS_OUTBOX_BYTES
    )]
    websocket_outbox_budget_bytes: usize,
    /// Additional browser origins allowed to make credentialed requests.
    /// Same-host requests are always allowed. Comma-delimited in the env var.
    #[arg(long, env = "LUCIDA_CORS_ALLOWED_ORIGINS", value_delimiter = ',')]
    cors_allowed_origins: Vec<String>,
    /// Explicit development escape hatch that reflects any browser Origin.
    #[arg(long, env = "LUCIDA_CORS_PERMISSIVE", default_value_t = false)]
    cors_permissive: bool,
    /// Total time allowed for connection/background-work drain after a
    /// termination signal. Includes the readiness propagation quiet period.
    #[arg(long, env = "LUCIDA_SHUTDOWN_TIMEOUT_SECS", default_value_t = 30)]
    shutdown_timeout_secs: u64,
    /// Time between flipping readiness false and stopping HTTP acceptance.
    #[arg(long, env = "LUCIDA_SHUTDOWN_QUIET_PERIOD_SECS", default_value_t = 2)]
    shutdown_quiet_period_secs: u64,
}

#[derive(Args, Debug)]
struct ClearArgs {
    /// URL of the dataset to clear. If omitted, clears every dataset
    /// subdirectory under the cache root.
    #[arg(long)]
    dataset: Option<String>,
    /// Override the active generated-coarse cache directory.
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_CACHE_DIR")]
    cache_dir: Option<PathBuf>,
    /// Override the retired proxy-cache directory cleaned during upgrades.
    #[arg(long, env = "LUCIDA_PROXY_CACHE_DIR")]
    legacy_cache_dir: Option<PathBuf>,
}

#[derive(Args, Debug)]
struct HealthcheckArgs {
    /// Readiness URL served by this container.
    #[arg(
        long,
        env = "LUCIDA_HEALTHCHECK_URL",
        default_value = "http://127.0.0.1:9876/readyz"
    )]
    url: String,
    /// Hard deadline for the probe request.
    #[arg(long, default_value_t = 2_000)]
    timeout_ms: u64,
}

#[derive(Args, Debug)]
struct RecoverLegacyBookmarkArgs {
    /// Existing Lucida SQLite database. A missing path is never created.
    #[arg(long, env = "LUCIDA_DB_PATH", default_value = "lucida.db")]
    db_path: PathBuf,
    /// UUID/id from the retired `bookmarks` table.
    #[arg(long)]
    bookmark: String,
    /// Chosen target workspace UUID/id.
    #[arg(long)]
    workspace: String,
    /// Current target-workspace member to own the saved view. Defaults to the
    /// legacy creator, who must still be a member.
    #[arg(long)]
    creator: Option<String>,
    /// Personal is the safe default. Shared requires an editor or owner.
    #[arg(long, value_enum, default_value_t = RecoveryVisibility::Personal)]
    visibility: RecoveryVisibility,
    /// Commit the validated recovery. Without this flag, the command is a
    /// read-only dry run.
    #[arg(long)]
    apply: bool,
    /// Emit the recovery plan/result as JSON.
    #[arg(long)]
    json: bool,
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
    let command = cli
        .command
        .unwrap_or_else(|| Commands::Serve(Box::new(cli.serve_args)));

    match command {
        Commands::Serve(args) => run_serve(*args).await,
        Commands::ClearProxyCache(args) => run_clear(args),
        Commands::Healthcheck(args) => run_healthcheck(args).await,
        Commands::RecoverLegacyBookmark(args) => {
            let json = args.json;
            match run_recover_legacy_bookmark(args).await {
                Ok(()) => Ok(()),
                Err(error) => exit_legacy_bookmark_recovery_error(&error, json),
            }
        }
    }
}

async fn run_serve(args: ServeArgs) -> std::io::Result<()> {
    // Created before any fallible startup dependency. No request can observe
    // `Ready` until every store/router is initialized and the listener binds.
    let lifecycle = health::RuntimeLifecycle::new();
    lucida_server::outbox::configure_process_outbox_budget(args.websocket_outbox_budget_bytes)
        .map_err(std::io::Error::other)?;
    tracing::info!(
        budget_bytes = args.websocket_outbox_budget_bytes,
        per_connection_bytes = lucida_server::outbox::DEFAULT_OUTBOX_BYTES,
        "websocket.outbox_budget.config"
    );
    let origin_policy = lucida_server::origin::OriginPolicy::new(
        args.cors_allowed_origins.clone(),
        args.cors_permissive,
    )
    .map_err(std::io::Error::other)?;
    if origin_policy.permissive() {
        tracing::warn!("http.origin_policy.permissive");
    }
    let data_dir = args.data_dir;
    let source_policy = Arc::new(
        lucida_server::source_policy::SourceTrustPolicy::from_config(
            lucida_server::source_policy::SourceTrustConfig {
                local_roots: data_dir.iter().cloned().collect(),
                http_hosts: args.source_http_hosts,
                http_cidrs: args.source_http_cidrs,
                http_ipv6_translation_cidrs: args.source_http_ipv6_translation_cidrs,
                s3_buckets: args.source_s3_buckets,
                gcs_buckets: args.source_gcs_buckets,
                allow_ambient_cloud_credentials: args.source_allow_ambient_cloud_credentials,
            },
        )
        .map_err(std::io::Error::other)?,
    );
    if args.memory_budget_bytes == 0 {
        return Err(std::io::Error::other(
            "memory budget must be greater than zero",
        ));
    }
    if args.generated_coarse_disk_budget_bytes == 0 {
        return Err(std::io::Error::other(
            "generated coarse disk budget must be greater than zero",
        ));
    }
    if args.max_source_object_bytes == 0 || args.max_source_object_bytes > args.memory_budget_bytes
    {
        return Err(std::io::Error::other(
            "maximum source object bytes must be positive and no larger than the memory budget",
        ));
    }
    let source_cache = lucida_store::cache::SharedObjectCache::new(
        args.memory_budget_bytes,
        args.max_source_object_bytes,
    );

    let dataset_runtime = DatasetRuntimeConfig {
        source_policy: Arc::clone(&source_policy),
        source_cache: Arc::clone(&source_cache),
        generated_cache_dir: args
            .generated_coarse_cache_dir
            .unwrap_or_else(DatasetRuntimeConfig::default_generated_cache_dir),
        legacy_proxy_cache_dir: args
            .legacy_proxy_cache_dir
            .unwrap_or_else(DatasetRuntimeConfig::default_legacy_proxy_cache_dir),
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
        local_roots = source_policy.local_roots().len(),
        "source_policy.config",
    );
    tracing::info!(
        memory_budget_bytes = source_cache.memory_snapshot().max_bytes,
        max_source_object_bytes = args.max_source_object_bytes,
        "memory_budget.config",
    );
    tracing::info!(
        enabled = dataset_runtime.generated_enabled,
        cache_dir = %dataset_runtime.generated_cache_dir.display(),
        legacy_proxy_cache_dir = %dataset_runtime.legacy_proxy_cache_dir.display(),
        concurrency = dataset_runtime.generated_concurrency,
        background_chunk_limit = dataset_runtime.generated_background_chunk_limit,
        target_long_axis = dataset_runtime.generated_target_long_axis,
        chunk_long_axis = dataset_runtime.generated_chunk_long_axis,
        max_chunk_bytes = dataset_runtime.generated_max_chunk_bytes,
        disk_budget_bytes = dataset_runtime.generated_disk_budget_bytes,
        disk_entry_budget = lucida_server::DEFAULT_GENERATED_DISK_ENTRY_BUDGET,
        "generated_coarse.config",
    );

    let state = AppState {
        data_dir,
        dataset_runtime: dataset_runtime.clone(),
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
        db = %auth_config.db_path.display(),
        idle_timeout_s = auth_config.idle_timeout.as_secs(),
        hard_cap_s = auth_config.hard_cap.as_secs(),
        "auth.startup",
    );
    // Audit signal: explicit acknowledgment that we're running with
    // auth disabled on a non-loopback bind. This combination should
    // raise eyebrows in code review (ADR-0018 §"Consequences"); the
    // Keep this as one structured warning so RUST_LOG filtering, span context,
    // and JSON log collectors all observe the same event.
    if auth_config.insecure_acknowledged {
        tracing::warn!(
            bind = %auth_config.bind_addr,
            mode = %mode_str,
            "auth.startup.insecure_mode",
        );
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
            tracing::error!(error = %e, "auth.startup.session_store_open_failed");
            return Err(std::io::Error::other(e.to_string()));
        }
    };
    let session_store_dyn: Arc<dyn auth::LoginSessionStore> = session_store.clone();
    let bearer_token_store: Arc<dyn auth::BearerTokenStore> = Arc::new(
        auth::SqliteBearerTokenStore::new(session_store.pool().clone()),
    );
    let cli_authorization_store: Arc<dyn auth::CliTokenAuthorizationStore> = Arc::new(
        auth::SqliteCliTokenAuthorizationStore::new(session_store.pool().clone()),
    );
    // Pending-auth store rides the same SQLite pool the session store
    // opened (one DB, one migration system, one connection budget).
    let pending_store: Arc<dyn auth::PendingAuthStore> = Arc::new(
        auth::SqlitePendingAuthStore::new(session_store.pool().clone()),
    );

    // Construct the workspace runtime before auth routes so credential
    // revocation can synchronously disconnect every live socket belonging to
    // that principal, rather than waiting for its next request to fail.
    let workspace_store = Arc::new(workspace::SqliteWorkspaceStore::new(
        session_store.pool().clone(),
    ));
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
        workspace_store as Arc<dyn workspace::WorkspaceStore>,
        dataset_runtime.clone(),
        workspace_runtime_config,
    ));

    let extractor = auth::middleware::build_extractor_with_auth_epochs(
        Arc::clone(&auth_config),
        Arc::clone(&session_store_dyn),
        Arc::clone(&bearer_token_store),
        workspace_manager.auth_epoch_registry(),
    );

    let logout_state = auth::handlers::LogoutState {
        config: Arc::clone(&auth_config),
        store: Arc::clone(&session_store_dyn),
        workspace_manager: Some(Arc::clone(&workspace_manager)),
    };
    let cli_auth_state = auth::handlers::CliAuthState {
        config: Arc::clone(&auth_config),
        token_store: Arc::clone(&bearer_token_store),
        cli_store: Arc::clone(&cli_authorization_store),
        workspace_manager: Some(Arc::clone(&workspace_manager)),
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

    let workspace_idle_eviction_handle = workspace_manager.spawn_idle_eviction_loop();
    let workspaces_router: Router<()> = workspace::router(Arc::clone(&workspace_manager));

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
    // without being 401'd. Readiness follows the startup/drain lifecycle;
    // liveness remains 200 while an instance drains.
    // See `lucida-server/src/health.rs`.
    public_auth_router = public_auth_router
        .merge(health::router(lifecycle.clone()))
        .merge(health::resource_router(Arc::clone(source_cache.budget())));

    // ADR-0020: serve the SPA bundle from `LUCIDA_WEB_DIST` (default
    // `./lucida-web/dist`) via `tower-http::ServeDir`. Lands on the
    // public router half so HTML/JS/CSS aren't 401'd by the auth
    // middleware — auth gates remain on `/auth/whoami` polling and
    // `/api/*` calls. Merged LAST below so route-specific handlers
    // (`/auth/*`, `/api/*`, `/admin/*`, `/ws/workspaces/*`) take precedence and the
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
    // ADR-0020: `/` falls through to the SPA `static_serve` fallback below.
    // Collaborative clients connect only through the authorized
    // `/ws/workspaces/{workspace_id}` route merged from `workspaces_router`.
    let app_state_router = Router::new()
        .route("/api/browse", get(browse::browse_handler))
        .route("/admin/clear-proxy-cache", post(admin_clear_proxy_cache))
        .with_state(state)
        .merge(authed_auth_router)
        .merge(workspaces_router)
        .layer(axum::middleware::from_fn_with_state(
            extractor,
            auth::middleware::auth_middleware,
        ));

    let cors_policy = origin_policy.clone();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, request| {
            cors_policy.allows(origin, request.headers.get(HOST))
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE, ACCEPT])
        .allow_credentials(true);

    let app = app_state_router
        .merge(public_auth_router)
        // ADR-0020: SPA static-serve catch-all. Merged last so the
        // fallback only fires for paths no other route claimed.
        .merge(static_serve_router)
        .layer(cors)
        // Existing WebSocket handlers can extract this extension and await
        // `wait_for_draining`; request admission itself uses explicit state so
        // it cannot depend on extension-layer ordering.
        .layer(Extension(lifecycle.clone()))
        .layer(Extension(origin_policy))
        .layer(axum::middleware::from_fn_with_state(
            lifecycle.clone(),
            health::reject_while_draining,
        ));

    // Hourly background sweep of expired session + pending-auth rows.
    // Spawned here (after stores are open, before the listener accepts
    // connections) so the loop runs for the lifetime of the process.
    // Holding the JoinHandle keeps the task alive — dropping the
    // handle would abort the spawned future. Operational logs only
    // (no PII per row); per-user audit lives in `auth.signin.success`
    // and `auth.logout`.
    let cleanup_handle = auth::spawn_cleanup(auth::CleanupState {
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

    let shutdown_timeout = Duration::from_secs(args.shutdown_timeout_secs.max(1));
    let quiet_period = Duration::from_secs(
        args.shutdown_quiet_period_secs
            .min(shutdown_timeout.as_secs().saturating_sub(1)),
    );
    tracing::info!(
        timeout_s = shutdown_timeout.as_secs(),
        quiet_period_s = quiet_period.as_secs(),
        "server.shutdown.config"
    );

    if !lifecycle.mark_ready() {
        return Err(std::io::Error::other(
            "server entered drain before startup completed",
        ));
    }
    tracing::info!("server.ready");

    // Axum's graceful server implements `IntoFuture` rather than `Future`
    // directly. Convert it explicitly so one pinned future can participate in
    // both the drain-start race and the bounded completion wait below.
    let graceful = std::future::IntoFuture::into_future(
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal(lifecycle.clone(), quiet_period)),
    );
    tokio::pin!(graceful);

    let server_result = tokio::select! {
        result = &mut graceful => {
            let shutdown = workspace_manager
                .shutdown_all_live_background("server_stopped");
            let _ = tokio::time::timeout(shutdown_timeout, shutdown).await;
            result
        },
        () = lifecycle.wait_for_draining() => {
            tracing::info!(timeout_s = shutdown_timeout.as_secs(), "server.shutdown.drain_started");
            let background_shutdown = workspace_manager
                .shutdown_all_live_background("process_shutdown");
            let bounded_drain = async {
                let (result, generated_services) =
                    tokio::join!(&mut graceful, background_shutdown);
                tracing::info!(
                    generated_services,
                    "server.shutdown.background_checkpoint_complete"
                );
                result
            };
            match tokio::time::timeout(shutdown_timeout, bounded_drain).await {
                Ok(result) => result,
                Err(_) => {
                    // Dropping the server future cancels connections that did
                    // not finish within the operator-defined grace period.
                    tracing::warn!(
                        timeout_s = shutdown_timeout.as_secs(),
                        "server.shutdown.forced_timeout"
                    );
                    Ok(())
                }
            }
        }
    };

    // These loops are best-effort maintenance, not request work. Abort them
    // after graceful drain (or its hard deadline) so process exit is bounded.
    cleanup_handle.abort();
    workspace_idle_eviction_handle.abort();
    server_result
}

async fn shutdown_signal(lifecycle: health::RuntimeLifecycle, quiet_period: Duration) {
    let reason = wait_for_termination_signal().await;
    lifecycle.begin_draining();
    tracing::info!(reason, "server.shutdown.signal_received");
    if !quiet_period.is_zero() {
        tokio::time::sleep(quiet_period).await;
    }
    tracing::info!(reason, "server.shutdown.acceptance_stopped");
}

async fn wait_for_termination_signal() -> &'static str {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    tracing::error!(%error, "server.shutdown.ctrl_c_handler_failed");
                }
                "ctrl_c"
            }
            _ = terminate.recv() => "sigterm",
        }
    }

    #[cfg(not(unix))]
    {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "server.shutdown.ctrl_c_handler_failed");
        }
        "ctrl_c"
    }
}

async fn run_healthcheck(args: HealthcheckArgs) -> std::io::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(args.timeout_ms.max(1)))
        .build()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let response = client
        .get(&args.url)
        .send()
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    if !response.status().is_success() {
        return Err(std::io::Error::other(format!(
            "readiness probe returned {}",
            response.status()
        )));
    }
    Ok(())
}

async fn run_recover_legacy_bookmark(
    args: RecoverLegacyBookmarkArgs,
) -> Result<(), legacy_bookmark_recovery::RecoveryError> {
    let pool = legacy_bookmark_recovery::open_existing_database(&args.db_path).await?;
    let outcome = legacy_bookmark_recovery::recover_legacy_bookmark(
        &pool,
        RecoveryRequest {
            bookmark_id: &args.bookmark,
            workspace_id: &args.workspace,
            creator_email: args.creator.as_deref(),
            visibility: args.visibility,
            apply: args.apply,
        },
    )
    .await;
    pool.close().await;
    let outcome = outcome?;

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&outcome)
                .expect("recovery outcome contains only JSON-serializable values")
        );
    } else if outcome.already_present {
        println!(
            "legacy bookmark {} is already recovered as saved view {} in workspace {}",
            outcome.bookmark_id, outcome.saved_view_id, outcome.workspace_id
        );
    } else if outcome.applied {
        println!(
            "recovered legacy bookmark {} as {} saved view {} in workspace {} ({} datasets)",
            outcome.bookmark_id,
            outcome.visibility.as_str(),
            outcome.saved_view_id,
            outcome.workspace_id,
            outcome.dataset_mappings.len()
        );
    } else {
        println!(
            "dry run validated legacy bookmark {} for workspace {} ({} datasets); rerun with --apply to commit",
            outcome.bookmark_id,
            outcome.workspace_id,
            outcome.dataset_mappings.len()
        );
    }
    Ok(())
}

fn exit_legacy_bookmark_recovery_error(
    error: &legacy_bookmark_recovery::RecoveryError,
    json: bool,
) -> ! {
    let write_result = if json {
        let mut document = serde_json::to_string(&error.envelope())
            .unwrap_or_else(|_| {
                r#"{"ok":false,"error":{"code":"serialization_error","message":"recovery error could not be serialized"}}"#
                    .to_string()
            })
            .into_bytes();
        document.push(b'\n');
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(&document).and_then(|()| stdout.flush())
    } else {
        let line = format!("legacy bookmark recovery failed: {error}\n");
        let mut stderr = std::io::stderr().lock();
        stderr
            .write_all(line.as_bytes())
            .and_then(|()| stderr.flush())
    };
    std::process::exit(if write_result.is_ok() { 1 } else { 2 });
}

fn run_clear(args: ClearArgs) -> std::io::Result<()> {
    let cache_dir = args.cache_dir.unwrap_or_else(admin::default_cache_dir);
    let legacy_cache_dir = args
        .legacy_cache_dir
        .unwrap_or_else(admin::default_legacy_proxy_cache_dir);
    let cache_roots = admin::DerivedCacheRoots::new(cache_dir.clone(), legacy_cache_dir.clone());
    let identity = args
        .dataset
        .as_deref()
        .map(lucida_content::url::SourceIdentity::parse)
        .transpose()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let outcome = admin::clear_derived_cache_roots(&cache_roots, identity.as_ref())?;
    match identity {
        Some(identity) => {
            println!(
                "cleared {} dataset roots for {} ({} files) under {} and {}",
                outcome.datasets,
                identity.dataset_id(),
                outcome.files,
                cache_dir.display(),
                legacy_cache_dir.display()
            );
        }
        None => {
            println!(
                "cleared {} dataset roots ({} files) under {} and {}",
                outcome.datasets,
                outcome.files,
                cache_dir.display(),
                legacy_cache_dir.display()
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
        assert_eq!(
            cli.serve_args.generated_coarse_disk_budget_bytes,
            lucida_server::DEFAULT_GENERATED_DISK_BUDGET_BYTES
        );
    }

    #[tokio::test]
    async fn zero_generated_disk_budget_fails_before_server_startup() {
        let cli = parse(&["--generated-coarse-disk-budget-bytes", "0"]);
        let error = run_serve(cli.serve_args).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "generated coarse disk budget must be greater than zero"
        );
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
    fn healthcheck_defaults_to_container_readiness_url() {
        let cli = parse(&["healthcheck"]);
        match cli.command.expect("healthcheck subcommand") {
            Commands::Healthcheck(args) => {
                assert_eq!(args.url, "http://127.0.0.1:9876/readyz");
                assert_eq!(args.timeout_ms, 2_000);
            }
            _ => panic!("expected healthcheck"),
        }
    }

    #[test]
    fn clear_proxy_cache_with_dataset_parses() {
        let cli = parse(&[
            "clear-proxy-cache",
            "--cache-dir",
            "/tmp/cache",
            "--legacy-cache-dir",
            "/tmp/legacy-cache",
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
                assert_eq!(
                    args.legacy_cache_dir.as_deref(),
                    Some(std::path::Path::new("/tmp/legacy-cache"))
                );
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
                assert!(args.legacy_cache_dir.is_none());
            }
            _ => panic!("expected ClearProxyCache"),
        }
    }

    #[test]
    fn recover_legacy_bookmark_defaults_to_safe_dry_run() {
        let cli = parse(&[
            "recover-legacy-bookmark",
            "--db-path",
            "/tmp/lucida.db",
            "--bookmark",
            "bookmark-1",
            "--workspace",
            "workspace-1",
        ]);
        match cli.command.expect("recover subcommand") {
            Commands::RecoverLegacyBookmark(args) => {
                assert_eq!(args.db_path, std::path::Path::new("/tmp/lucida.db"));
                assert_eq!(args.bookmark, "bookmark-1");
                assert_eq!(args.workspace, "workspace-1");
                assert_eq!(args.visibility, RecoveryVisibility::Personal);
                assert!(!args.apply);
                assert!(!args.json);
            }
            _ => panic!("expected RecoverLegacyBookmark"),
        }
    }
}
