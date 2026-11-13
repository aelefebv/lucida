use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::routing::{get, post};
use clap::{Args, Parser, Subcommand};

use lucida_server::auth;
use lucida_server::deployment_theme::{self, DeploymentTheme};
use lucida_server::health;
use lucida_server::inbox;
use lucida_server::link_throttle::{LinkThrottleConfig, LinkThrottleProfile};
use lucida_server::listings;
use lucida_server::origin::{self, OriginPolicy};
use lucida_server::static_serve;
use lucida_server::status;
use lucida_server::storage;
use lucida_server::{GeneratedConfig, workspace};
use lucida_store::source_policy::{SourcePolicy, SourcePolicyConfig};
use lucida_store::source_throttle::{SourceThrottleConfig, SourceThrottleProfile};

// CLI supports legacy `lucida-server --data-dir /path` (no subcommand,
// treated as `serve`) alongside an explicit `serve` subcommand.
// `args_conflicts_with_subcommands` keeps the legacy form unambiguous.
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
    Serve(Box<ServeArgs>),
}

#[derive(Args, Debug, Default)]
struct ServeArgs {
    #[command(flatten)]
    sources: SourceArgs,
    #[command(flatten)]
    source_throttle: SourceThrottleArgs,
    #[command(flatten)]
    link_throttle: LinkThrottleArgs,
    /// Enable server-generated coarse chunks.
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_ENABLED", default_value_t = true)]
    generated_coarse_enabled: bool,
    /// Override the generated coarse derived-cache root (default: platform
    /// user cache dir).
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
    /// Bytes of generated chunks held in memory, across every dataset.
    #[arg(long, env = "LUCIDA_GENERATED_COARSE_MEMORY_BUDGET_BYTES")]
    generated_coarse_memory_budget_bytes: Option<u64>,
    /// How long a live workspace with no connected clients remains in memory.
    #[arg(long, env = "LUCIDA_WORKSPACE_IDLE_TTL_SECS", default_value_t = 3600)]
    workspace_idle_ttl_secs: u64,
    /// How often the server checks for idle live workspaces.
    #[arg(long, env = "LUCIDA_WORKSPACE_IDLE_SWEEP_SECS", default_value_t = 60)]
    workspace_idle_sweep_secs: u64,
    /// How often the server asks its dataset sources what they list, such
    /// as by walking the data directories.
    #[arg(long, env = "LUCIDA_LISTINGS_REFRESH_SECS", default_value_t = 300)]
    listings_refresh_secs: u64,
    /// When a page that declares the codecs it decodes is sent chunks still
    /// encoded: `auto` (a page on another machine, or any page under a link
    /// throttle), `always`, or `never`.
    #[arg(long, env = "LUCIDA_CHUNK_RELAY", default_value = "auto")]
    chunk_relay: lucida_protocol::codec::ChunkRelaySetting,
}

/// Where datasets may be opened from.
#[derive(Args, Debug, Default)]
struct SourceArgs {
    /// A directory search lists datasets from and, when auth is enabled,
    /// the only place local datasets open from. Repeat for several.
    ///
    /// A `gs://` or `s3://` URL, with an optional prefix, is a data root in
    /// a bucket: search lists the datasets under it, and they open even when
    /// the bucket allowlist leaves the bucket out.
    ///
    /// Also readable from `LUCIDA_DATA_DIR`. Several are separated as in
    /// `PATH`, by `:` (`;` on Windows), except the colon of a leading
    /// `gs://` or `s3://`. CLI flags win over the env var when both are set
    /// (clap's default behavior).
    #[arg(long, env = "LUCIDA_DATA_DIR")]
    data_dir: Vec<String>,
    /// A host, IP address, or CIDR range an `http(s)` dataset may reach
    /// when auth is enabled, although it is not a public address. Repeat
    /// for several.
    ///
    /// Also readable from `LUCIDA_SOURCE_ALLOW_HOSTS`, comma-separated.
    #[arg(long, env = "LUCIDA_SOURCE_ALLOW_HOSTS", value_delimiter = ',')]
    source_allow_host: Vec<String>,
    /// A `gs://bucket` or `s3://bucket` datasets may be opened from when
    /// auth is enabled. Once one is set, other buckets are refused. Repeat
    /// for several.
    ///
    /// Also readable from `LUCIDA_SOURCE_ALLOW_BUCKETS`, comma-separated.
    #[arg(long, env = "LUCIDA_SOURCE_ALLOW_BUCKETS", value_delimiter = ',')]
    source_allow_bucket: Vec<String>,
}

/// A dev-only delay on every source read, so a dataset on local disk loads
/// the way one in object storage does. Off unless one of these is set.
#[derive(Args, Debug, Default)]
struct SourceThrottleArgs {
    /// Start from a named profile: `local` (off), `object-store`, or
    /// `remote`. A value set below replaces the profile's.
    #[arg(long = "source-throttle", env = "LUCIDA_SOURCE_THROTTLE", value_enum)]
    profile: Option<SourceThrottleProfile>,
    /// Milliseconds added to every source request.
    #[arg(long, env = "LUCIDA_SOURCE_THROTTLE_LATENCY_MS")]
    source_throttle_latency_ms: Option<u64>,
    /// The most milliseconds drawn per request on top of the latency.
    #[arg(long, env = "LUCIDA_SOURCE_THROTTLE_JITTER_MS")]
    source_throttle_jitter_ms: Option<u64>,
    /// The cap on all source reads together, in bytes per second. Zero
    /// lifts the cap.
    #[arg(long, env = "LUCIDA_SOURCE_THROTTLE_BYTES_PER_SEC")]
    source_throttle_bytes_per_sec: Option<u64>,
}

impl SourceThrottleArgs {
    fn config(&self) -> SourceThrottleConfig {
        SourceThrottleConfig {
            profile: self.profile,
            latency_ms: self.source_throttle_latency_ms,
            jitter_ms: self.source_throttle_jitter_ms,
            bytes_per_sec: self.source_throttle_bytes_per_sec,
        }
    }
}

/// A dev-only delay on the session socket, so a page on this machine waits
/// for its chunks the way one across a network does. Off unless one of
/// these is set.
#[derive(Args, Debug, Default)]
struct LinkThrottleArgs {
    /// Start from a named profile: `local` (off) or `broadband`. A value
    /// set below replaces the profile's.
    #[arg(long = "link-throttle", env = "LUCIDA_LINK_THROTTLE", value_enum)]
    link_throttle: Option<LinkThrottleProfile>,
    /// Milliseconds added to every round trip, half each way.
    #[arg(long, env = "LUCIDA_LINK_THROTTLE_LATENCY_MS")]
    link_throttle_latency_ms: Option<u64>,
    /// The cap on what the server sends each connection, in bytes per
    /// second. Zero lifts the cap.
    #[arg(long, env = "LUCIDA_LINK_THROTTLE_BYTES_PER_SEC")]
    link_throttle_bytes_per_sec: Option<u64>,
}

impl LinkThrottleArgs {
    fn config(&self) -> LinkThrottleConfig {
        LinkThrottleConfig {
            profile: self.link_throttle,
            latency_ms: self.link_throttle_latency_ms,
            bytes_per_sec: self.link_throttle_bytes_per_sec,
        }
    }
}

/// What separates several data roots in `LUCIDA_DATA_DIR`, as in `PATH`.
const PATH_LIST_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// The data roots in one `--data-dir` value. A `separator` of `:` would cut
/// a bucket URL after its scheme, so a piece that starts with `//` rejoins
/// a bare `gs` or `s3` before it.
fn split_data_roots(list: &str, separator: char) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for piece in list.split(separator) {
        match roots.last_mut() {
            Some(last) if separator == ':' && is_bucket_scheme(last) && piece.starts_with("//") => {
                last.push(':');
                last.push_str(piece);
            }
            _ => roots.push(piece.to_string()),
        }
    }
    roots
}

fn is_bucket_scheme(text: &str) -> bool {
    text.eq_ignore_ascii_case("gs") || text.eq_ignore_ascii_case("s3")
}

/// Where datasets may be opened from. Auth disabled means one person on
/// their own machine, or a network the operator declared trusted with
/// `LUCIDA_INSECURE`, so only an enabled auth mode restricts sources.
fn source_policy_config(mode: auth::AuthMode, args: &SourceArgs) -> SourcePolicyConfig {
    let (bucket_roots, directories): (Vec<String>, Vec<String>) = args
        .data_dir
        .iter()
        .flat_map(|list| split_data_roots(list, PATH_LIST_SEPARATOR))
        .partition(|root| {
            root.split_once("://")
                .is_some_and(|(scheme, _)| is_bucket_scheme(scheme))
        });
    SourcePolicyConfig {
        restricted: mode != auth::AuthMode::Disabled,
        data_roots: directories.into_iter().map(PathBuf::from).collect(),
        bucket_roots,
        allowed_hosts: args.source_allow_host.clone(),
        allowed_buckets: args.source_allow_bucket.clone(),
    }
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
    // and span-close timing work identically in either
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
                // #[tracing::instrument]-wrapped function.
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
        .unwrap_or(Commands::Serve(Box::new(cli.serve_args)));

    match command {
        Commands::Serve(args) => run_serve(*args).await,
    }
}

async fn run_serve(args: ServeArgs) -> std::io::Result<()> {
    let generated_cache_dir_set = args.generated_coarse_cache_dir.is_some();
    let generated_config = GeneratedConfig {
        generated_cache_dir: args
            .generated_coarse_cache_dir
            .unwrap_or_else(GeneratedConfig::default_cache_dir),
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
        generated_memory: lucida_server::generated::GeneratedChunkMemory::new(
            args.generated_coarse_memory_budget_bytes
                .unwrap_or(lucida_server::generated::DEFAULT_GENERATED_MEMORY_BYTES),
        ),
    };
    // Operational logs go through the configured tracing subscriber
    // so RUST_LOG filtering applies.
    //
    // Generated levels used to default to a directory under this variable.
    // A deployment still setting it, and nothing newer, would otherwise lose
    // its persistent cache without a word.
    if !generated_cache_dir_set && std::env::var_os("LUCIDA_PROXY_CACHE_DIR").is_some() {
        tracing::warn!(
            generated_cache_dir = %generated_config.generated_cache_dir.display(),
            hint = "set LUCIDA_GENERATED_COARSE_CACHE_DIR",
            "config.proxy_cache_dir_ignored",
        );
    }
    tracing::info!(
        enabled = generated_config.generated_enabled,
        cache_dir = %generated_config.generated_cache_dir.display(),
        concurrency = generated_config.generated_concurrency,
        background_chunk_limit = generated_config.generated_background_chunk_limit,
        target_long_axis = generated_config.generated_target_long_axis,
        chunk_long_axis = generated_config.generated_chunk_long_axis,
        max_chunk_bytes = generated_config.generated_max_chunk_bytes,
        disk_budget_bytes = ?generated_config.generated_disk_budget_bytes,
        memory_budget_bytes = generated_config.generated_memory.max_bytes(),
        "generated_coarse.config",
    );
    tracing::info!(
        budget_bytes = lucida_store::cache::SourceCacheBudget::process().max_bytes(),
        "source_cache.config",
    );

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
    // Read before the database opens, so a bad value fails the boot with
    // the other configuration errors rather than after a connection was
    // made.
    let status_config = match status::StatusRouteConfig::from_env(&auth_config.db_url) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "status.startup.config_error");
            return Err(std::io::Error::other(e.to_string()));
        }
    };
    let deployment_theme = match DeploymentTheme::from_env() {
        Ok(theme) => theme,
        Err(e) => {
            tracing::error!(error = %e, "theme.startup.config_error");
            return Err(std::io::Error::other(e.to_string()));
        }
    };
    let origin_policy = match OriginPolicy::from_env() {
        Ok(policy) => policy,
        Err(e) => {
            tracing::error!(error = %e, "origin.startup.config_error");
            return Err(std::io::Error::other(e.to_string()));
        }
    };
    tracing::info!(
        allowed_origins = ?origin_policy.allowed(),
        "origin.config",
    );
    if let Some(theme) = deployment_theme.as_ref() {
        tracing::info!(
            file = %std::env::var(deployment_theme::FILE_VAR).unwrap_or_default().trim(),
            dark_tokens = theme.tokens.dark.len(),
            light_tokens = theme.tokens.light.len(),
            "theme.configured",
        );
    }
    // Operator-facing startup line: mode + bind together so a glance
    // at the boot log answers "is this server reachable, and is it
    // protected?"
    // Stable string mode tag (`"google"` / `"iap"` / `"disabled"`)
    // lands cleanly in audit pipelines that key off the exact string
    // rather than the Debug-formatted variant.
    let mode_str = match auth_config.mode {
        auth::AuthMode::Google => "google",
        auth::AuthMode::Iap => "iap",
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
    // raise eyebrows in code review; the
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
    if let Some(i) = auth_config.iap.as_ref() {
        // The audience is logged unredacted. It is not a secret, and an
        // operator chasing a wrong-audience rejection needs to read the
        // value the server is comparing against.
        tracing::info!(
            audience = %i.audience,
            issuer = %i.issuer,
            jwks_uri = %i.jwks_uri,
            "auth.iap.configured",
        );
    }
    let source_policy =
        match SourcePolicy::new(source_policy_config(auth_config.mode, &args.sources)) {
            Ok(policy) => Arc::new(policy),
            Err(e) => {
                tracing::error!(error = %e, "source_policy.startup.config_error");
                return Err(std::io::Error::other(e.to_string()));
            }
        };
    tracing::info!(
        restricted = source_policy.is_restricted(),
        data_roots = ?source_policy.data_roots().collect::<Vec<_>>(),
        bucket_roots = ?source_policy
            .bucket_roots()
            .map(|root| root.as_str())
            .collect::<Vec<_>>(),
        allowed_hosts = args.sources.source_allow_host.len(),
        allowed_buckets = args.sources.source_allow_bucket.len(),
        "source_policy.config",
    );
    // Installed before anything opens a source, so no read escapes it, and
    // announced the way an insecure bind is, because every timing the server
    // reports from here on includes a wait it added on purpose.
    match args.source_throttle.config().resolve() {
        Ok(None) => {}
        Ok(Some(throttle)) => {
            let label = throttle.report().label();
            tracing::warn!(throttle = %label, "source_throttle.enabled");
            eprintln!("============================================================");
            eprintln!("WARNING: source reads are throttled");
            eprintln!("{label}");
            eprintln!("Every source read waits on purpose to model a remote store.");
            eprintln!("A development setting. Do not use in production.");
            eprintln!("============================================================");
            lucida_store::source_throttle::install(throttle);
        }
        Err(e) => {
            tracing::error!(error = %e, "source_throttle.startup.config_error");
            return Err(std::io::Error::other(e.to_string()));
        }
    }
    // Installed before the server accepts a connection, so no socket
    // escapes it, and announced for the same reason as the source throttle.
    match args.link_throttle.config().resolve() {
        Ok(None) => {}
        Ok(Some(throttle)) => {
            let label = throttle.report().label();
            tracing::warn!(throttle = %label, "link_throttle.enabled");
            eprintln!("============================================================");
            eprintln!("WARNING: the session socket is throttled");
            eprintln!("{label}");
            eprintln!("Every message to and from a client waits on purpose to");
            eprintln!("model a network between them.");
            eprintln!("A development setting. Do not use in production.");
            eprintln!("============================================================");
            lucida_server::link_throttle::install(throttle);
        }
        Err(e) => {
            tracing::error!(error = %e, "link_throttle.startup.config_error");
            return Err(std::io::Error::other(e.to_string()));
        }
    }
    let listings_index = Arc::new(listings::ListingsIndex::new(
        listings::configured(&listings::SourceContext {
            policy: Arc::clone(&source_policy),
        })
        .await,
        Arc::clone(&source_policy),
    ));
    let listings_refresh = Duration::from_secs(args.listings_refresh_secs.max(1));
    tracing::info!(
        sources = listings_index.source_count(),
        refresh_secs = listings_refresh.as_secs(),
        "listings.config",
    );
    // The first refresh runs in the background, so a slow walk never holds
    // up the boot; search answers from what the index holds meanwhile.
    let _listings_refresh_handle = listings_index.spawn_refresh_loop(listings_refresh);

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

    let auth_state = match auth::middleware::AuthMiddlewareState::build(
        Arc::clone(&auth_config),
        Arc::clone(&session_store_dyn),
        Arc::clone(&bearer_token_store),
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = %e, "auth.startup.iap_key_set_unavailable");
            return Err(std::io::Error::other(e.to_string()));
        }
    };

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
    //     read the principal/cookie, so they must run through the auth
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
            auth::LOGOUT_PATH,
            post(auth::handlers::logout).with_state(logout_state),
        );

    let workspace_store = storage.workspaces();
    let workspace_runtime_config = workspace::WorkspaceRuntimeConfig {
        idle_ttl: Duration::from_secs(args.workspace_idle_ttl_secs),
        idle_sweep_interval: Duration::from_secs(args.workspace_idle_sweep_secs.max(1)),
        chunk_relay: args.chunk_relay,
        ..workspace::WorkspaceRuntimeConfig::default()
    };
    tracing::info!(
        idle_ttl_secs = workspace_runtime_config.idle_ttl.as_secs(),
        idle_sweep_secs = workspace_runtime_config.idle_sweep_interval.as_secs(),
        chunk_relay = ?workspace_runtime_config.chunk_relay,
        "workspace.runtime.config"
    );
    let inbox_store = storage.inbox();
    let workspace_manager = Arc::new(
        workspace::WorkspaceManager::new_with_runtime_config(
            workspace_store,
            generated_config.clone(),
            workspace_runtime_config,
        )
        // A **Send report** arrives on a workspace socket, so the
        // manager behind that socket is what holds the inbox.
        .with_inbox(Arc::clone(&inbox_store))
        .with_source_policy(Arc::clone(&source_policy)),
    );
    let _workspace_idle_eviction_handle = workspace_manager.spawn_idle_eviction_loop();
    // The inbox's own read routes, on the protected half beside the
    // workspace ones: the CLI lists and fetches what people sent.
    let inbox_router: Router<()> = inbox::router(inbox::InboxState {
        manager: Arc::clone(&workspace_manager),
        store: inbox_store,
    });
    // Recent datasets come from per-member workspace state, so the
    // listings routes read the workspaces too.
    let listings_router: Router<()> =
        listings::router(listings_index, Arc::clone(&workspace_manager));
    let workspaces_router: Router<()> = workspace::router(workspace_manager);

    // /auth/error is available regardless of auth mode — if the user
    // somehow reaches it (a stale link, a misconfigured deployment),
    // we still render the generic page rather than 404. Mounted on
    // the public router so the auth middleware never wraps it (the
    // user is unauthenticated by definition when they're being told
    // to retry sign-in).
    //
    // The dev identity routes mount unconditionally and gate on
    // `DevAuthState::new`: elsewhere `/auth/dev/status` reports
    // `enabled: false` and `/auth/dev/login` 404s.
    let dev_auth_state = auth::handlers::DevAuthState::new(Arc::clone(&auth_config));
    let mut public_auth_router: Router<()> = Router::new()
        .route("/auth/error", get(auth::error_page::auth_error))
        .route(
            "/auth/mode",
            get(auth::handlers::auth_mode).with_state(Arc::clone(&auth_config)),
        )
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
        )
        .route(
            "/auth/dev/login",
            post(auth::handlers::dev_login).with_state(dev_auth_state),
        );
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
    // Liveness and readiness probes go on the public router half, because
    // the kubelet presents no session cookie. See `health.rs`.
    public_auth_router = public_auth_router.merge(health::router());
    // Public half, for the same reason as the probes: an external
    // monitor presents no session. The startup line is the one place the
    // route is logged above debug level. See `status.rs`.
    if let Some(status) = status_config.as_ref() {
        tracing::info!(
            path = %status.path,
            label = %status.label,
            resource_name = %status.resource_name,
            "status.route.configured",
        );
    }
    public_auth_router =
        public_auth_router.merge(status::router(status_config, Arc::clone(&storage)));
    // Public because the sign-in screen is themed before anyone has a
    // session. It answers whether or not a theme is configured.
    public_auth_router =
        public_auth_router.merge(deployment_theme::router(deployment_theme.as_ref()));

    // Serve the SPA bundle from `LUCIDA_WEB_DIST` (default
    // `./lucida-web/dist`) on the public router half. Merged
    // last so `/auth/*`, `/api/*`, `/admin/*`, and `/ws/*` take precedence
    // and the SPA fallback only fires for unknown paths.
    let web_dist = PathBuf::from(
        std::env::var("LUCIDA_WEB_DIST").unwrap_or_else(|_| "./lucida-web/dist".to_string()),
    );
    tracing::info!(
        web_dist = %web_dist.display(),
        "static_serve.config",
    );
    // A page load is a browser's first visit, so a disabled-mode server on
    // a shared bind gives each browser its own anonymous session here,
    // before the app's first request asks who it is.
    let static_serve_router = auth::anonymous::with_anonymous_sessions(
        static_serve::router(web_dist, deployment_theme.as_ref()),
        Arc::clone(&auth_config),
        Arc::clone(&session_store_dyn),
    );

    // App routes carry the auth middleware; public auth routes don't.
    // `/` falls through to the SPA so a browser hitting `:9876` sees the
    // app. A WebSocket client connects to one workspace, at
    // `/ws/workspaces/{id}`.
    let app_router = Router::new()
        .merge(authed_auth_router)
        .merge(inbox_router)
        .merge(workspaces_router)
        .merge(listings_router)
        .layer(axum::middleware::from_fn_with_state(
            auth_state,
            auth::middleware::auth_middleware,
        ));

    let mut app = app_router
        .merge(public_auth_router)
        // SPA catch-all. Merged last so the fallback only fires for paths
        // no other route claimed.
        .merge(static_serve_router)
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(origin_policy.clone()),
            origin::reject_cross_origin_upgrade,
        ));
    if let Some(cors) = origin_policy.cors_layer() {
        app = app.layer(cors);
    }

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

    // LUCIDA_BIND defaults to 127.0.0.1:9876 (loopback) so
    // `cargo run --bin lucida-server` is friction-free for local dev.
    // Set LUCIDA_BIND=0.0.0.0:9876 (or a deployment-specific interface)
    // to expose on all interfaces; production deployments must do so
    // explicitly.
    let bind_addr = auth_config.bind_addr;
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind to {bind_addr}: {e}"));
    tracing::info!(bind = %bind_addr, "server.listening");

    // The peer address decides whether a connection is sent chunks still
    // encoded (`wire_chunk::relays_to`).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("server error");
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
        assert!(cli.serve_args.sources.data_dir.is_empty());
        assert!(cli.serve_args.generated_coarse_cache_dir.is_none());
        assert!(
            cli.serve_args
                .source_throttle
                .config()
                .resolve()
                .unwrap()
                .is_none(),
            "sources read unthrottled unless a throttle is set"
        );
        assert!(
            cli.serve_args
                .link_throttle
                .config()
                .resolve()
                .unwrap()
                .is_none(),
            "the session socket runs at full speed unless a throttle is set"
        );
    }

    #[test]
    fn chunk_relay_defaults_to_auto_and_takes_only_its_three_settings() {
        use lucida_protocol::codec::ChunkRelaySetting;
        let relay = |argv: &[&str]| {
            let Some(Commands::Serve(args)) = parse(argv).command else {
                panic!("serve subcommand");
            };
            args.chunk_relay
        };
        assert_eq!(relay(&["serve"]), ChunkRelaySetting::Auto);
        assert_eq!(
            relay(&["serve", "--chunk-relay", "never"]),
            ChunkRelaySetting::Never
        );
        assert!(
            Cli::try_parse_from(["lucida-server", "serve", "--chunk-relay", "sometimes"]).is_err()
        );
    }

    #[test]
    fn link_throttle_takes_a_profile_and_values_that_replace_its_own() {
        let cli = parse(&[
            "serve",
            "--link-throttle",
            "broadband",
            "--link-throttle-latency-ms",
            "80",
        ]);
        let Some(Commands::Serve(args)) = cli.command else {
            panic!("serve subcommand");
        };
        let report = args
            .link_throttle
            .config()
            .resolve()
            .unwrap()
            .unwrap()
            .report();
        assert_eq!(report.profile, None);
        assert_eq!(
            (report.latency_ms, report.bytes_per_sec),
            (80, Some(12_500_000))
        );
        assert!(Cli::try_parse_from(["lucida-server", "--link-throttle", "fast"]).is_err());
    }

    #[test]
    fn source_throttle_takes_a_profile_and_values_that_replace_its_own() {
        let cli = parse(&[
            "serve",
            "--source-throttle",
            "object-store",
            "--source-throttle-latency-ms",
            "40",
        ]);
        let Some(Commands::Serve(args)) = cli.command else {
            panic!("serve subcommand");
        };
        let report = args
            .source_throttle
            .config()
            .resolve()
            .unwrap()
            .unwrap()
            .report();
        assert_eq!(report.profile, None);
        assert_eq!((report.latency_ms, report.jitter_ms), (40, 100));
        assert!(Cli::try_parse_from(["lucida-server", "--source-throttle", "fast"]).is_err());
    }

    #[test]
    fn legacy_data_dir_at_top_level_parses() {
        let cli = parse(&["--data-dir", "/tmp/foo"]);
        assert!(cli.command.is_none(), "no explicit subcommand");
        assert_eq!(cli.serve_args.sources.data_dir, ["/tmp/foo"]);
    }

    #[test]
    fn explicit_serve_with_data_dir_parses() {
        let cli = parse(&["serve", "--data-dir", "/tmp/foo"]);
        let Some(Commands::Serve(args)) = cli.command else {
            panic!("serve subcommand");
        };
        assert_eq!(args.sources.data_dir, ["/tmp/foo"]);
    }

    #[test]
    fn data_dir_and_source_allowlists_repeat() {
        let cli = parse(&[
            "serve",
            "--data-dir",
            "/srv/a",
            "--data-dir",
            "/srv/b",
            "--source-allow-host",
            "10.0.0.0/8,files.internal",
            "--source-allow-bucket",
            "gs://team-data",
        ]);
        let Some(Commands::Serve(args)) = cli.command else {
            panic!("serve subcommand");
        };
        assert_eq!(args.sources.data_dir, ["/srv/a", "/srv/b"]);
        assert_eq!(
            args.sources.source_allow_host,
            ["10.0.0.0/8", "files.internal"]
        );
        assert_eq!(args.sources.source_allow_bucket, ["gs://team-data"]);
    }

    #[test]
    fn a_data_root_list_keeps_the_colon_of_a_bucket_url() {
        assert_eq!(
            split_data_roots("/srv/a:gs://bucket/images:/srv/b:S3://archive:", ':'),
            ["/srv/a", "gs://bucket/images", "/srv/b", "S3://archive", ""]
        );
        assert_eq!(
            split_data_roots("/srv/gs://x:http://host", ':'),
            ["/srv/gs", "//x", "http", "//host"]
        );
        assert_eq!(
            split_data_roots(r"C:\data;gs://bucket/images", ';'),
            [r"C:\data", "gs://bucket/images"]
        );
    }

    #[test]
    fn bucket_urls_among_the_data_roots_become_bucket_roots() {
        let list = format!("/srv/a{PATH_LIST_SEPARATOR}gs://bucket/images");
        let cli = parse(&["serve", "--data-dir", &list, "--data-dir", "s3://archive"]);
        let Some(Commands::Serve(args)) = cli.command else {
            panic!("serve subcommand");
        };
        let config = source_policy_config(auth::AuthMode::Iap, &args.sources);
        assert_eq!(config.data_roots, [PathBuf::from("/srv/a")]);
        assert_eq!(config.bucket_roots, ["gs://bucket/images", "s3://archive"]);
    }

    /// An enabled auth mode, as behind an authenticating perimeter, is
    /// what restricts sources; auth disabled leaves them open.
    #[test]
    fn only_an_enabled_auth_mode_restricts_sources() {
        let args = SourceArgs::default();
        for (mode, restricted) in [
            (auth::AuthMode::Iap, true),
            (auth::AuthMode::Google, true),
            (auth::AuthMode::Disabled, false),
        ] {
            assert_eq!(
                source_policy_config(mode, &args).restricted,
                restricted,
                "{mode:?}"
            );
        }
    }
}
