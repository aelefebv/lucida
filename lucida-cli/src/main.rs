mod auth;
mod config;
mod credentials;
mod dataset;
mod error;
mod output;
mod status;
mod workspace;

use std::time::Duration;

use clap::{Parser, Subcommand};

use crate::auth::{
    AuthClient, LoginResult, PollOutcome, generate_raw_token, open_browser, poll_interval,
};
use crate::config::{CliConfig, ConfigStore, normalize_server_base_url, resolve_server};
use crate::credentials::{clear_local_token, resolve_token, store_local_token};
use crate::dataset::{DatasetOpenClient, DatasetOpenOutput, format_dataset_open_human};
use crate::error::{CliError, ErrorKind};
use crate::output::Output;
use crate::status::{ServerClient, StatusReport, format_status_human};
use crate::workspace::{
    WorkspaceClient, WorkspaceListOutput, WorkspaceLookupMode, WorkspaceOpenOutput,
    WorkspaceOutput, WorkspaceUseOutput, format_workspace_human, format_workspace_list_human,
    resolve_workspace_record, target_for,
};

#[derive(Parser, Debug)]
#[command(name = "lucida", about = "Command line client for Lucida", version)]
struct Cli {
    /// Lucida server base URL
    #[arg(long, value_name = "BASE_URL", global = true)]
    server: Option<String>,

    /// Workspace name or id for commands that target a workspace
    #[arg(long, value_name = "ID_OR_NAME", global = true)]
    workspace: Option<String>,

    /// Emit machine-readable JSON
    #[arg(long, global = true)]
    json: bool,

    /// Suppress success output
    #[arg(long, global = true)]
    quiet: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Summarize configured server, auth, and connection health
    Status,
    /// Inspect the configured Lucida server
    Server {
        #[command(subcommand)]
        command: ServerCommand,
    },
    /// Authenticate the CLI with a Lucida server
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    /// Discover and select Lucida workspaces
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
    /// Open and inspect datasets in the selected workspace
    Dataset {
        #[command(subcommand)]
        command: DatasetCommand,
    },
    /// Read or write local Lucida CLI configuration
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
}

#[derive(Subcommand, Debug)]
enum ServerCommand {
    /// Check server health, readiness, version, and auth status
    Status,
    /// Print server version
    Version,
}

#[derive(Subcommand, Debug)]
enum AuthCommand {
    /// Start a browser-assisted CLI login
    Login {
        /// Human-readable name for this credential
        #[arg(long, default_value = "Lucida CLI")]
        name: String,
        /// Token lifetime in days
        #[arg(long, default_value_t = 30)]
        ttl_days: u64,
        /// Do not attempt to open a browser automatically
        #[arg(long)]
        no_browser: bool,
        /// Seconds to wait for browser approval
        #[arg(long, default_value_t = 180)]
        timeout_seconds: u64,
    },
    /// Print the authenticated principal
    Whoami,
    /// Remove the local token and revoke it server-side by default
    Logout {
        /// Only remove the local token; skip server-side revocation
        #[arg(long)]
        local_only: bool,
    },
}

#[derive(Subcommand, Debug)]
enum WorkspaceCommand {
    /// List accessible workspaces
    List {
        /// List archived workspaces instead of active workspaces
        #[arg(long)]
        archived: bool,
    },
    /// Create a workspace
    Create {
        /// Optional workspace name
        name: Option<String>,
    },
    /// Show workspace details and derived target URLs
    Info {
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
        /// Allow resolving archived workspaces by name
        #[arg(long)]
        archived: bool,
    },
    /// Persist the default workspace
    Use {
        /// Workspace id or unambiguous name
        selector: String,
    },
    /// Mark a workspace as recently opened and print/open its browser URL
    Open {
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
        /// Do not attempt to open a browser automatically
        #[arg(long)]
        no_browser: bool,
    },
}

#[derive(Subcommand, Debug)]
enum DatasetCommand {
    /// Open a dataset path or URL in the selected workspace
    Open {
        /// Dataset path or URL visible to the Lucida server
        #[arg(value_name = "PATH_OR_URL")]
        source: String,
        /// Seconds to wait for the server to finish opening the dataset
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
    },
}

#[derive(Subcommand, Debug)]
enum ConfigCommand {
    /// Set a configuration value
    Set {
        #[command(subcommand)]
        command: ConfigSetCommand,
    },
    /// Get a configuration value
    Get {
        #[command(subcommand)]
        command: ConfigGetCommand,
    },
    /// Print the config file path
    Path,
}

#[derive(Subcommand, Debug)]
enum ConfigSetCommand {
    /// Persist the default Lucida server base URL
    Server {
        /// Server base URL, e.g. http://127.0.0.1:9876
        base_url: String,
    },
}

#[derive(Subcommand, Debug)]
enum ConfigGetCommand {
    /// Print the effective default server
    Server,
    /// Print the effective default workspace
    Workspace,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let json_errors = cli.json;
    if let Err(error) = run(cli).await {
        if json_errors {
            eprintln!(
                "{}",
                serde_json::to_string_pretty(&error.to_json())
                    .unwrap_or_else(|_| error.to_string())
            );
        } else {
            eprintln!("error[{}]: {}", error.kind.as_str(), error.message);
        }
        std::process::exit(error.exit_code());
    }
}

async fn run(cli: Cli) -> Result<(), CliError> {
    let output = Output::new(cli.json, cli.quiet);
    let store = ConfigStore::default()?;
    let mut config = store.load()?;

    match &cli.command {
        Command::Status => {
            let report = load_status(cli.server.as_deref(), &config).await?;
            output.print_either(&report, || format_status_human(&report))?;
        }
        Command::Server { command } => match command {
            ServerCommand::Status => {
                let report = load_status(cli.server.as_deref(), &config).await?;
                output.print_either(&report, || format_status_human(&report))?;
            }
            ServerCommand::Version => {
                let report = load_status(cli.server.as_deref(), &config).await?;
                output.print_either(&report, || format_version_human(&report))?;
            }
        },
        Command::Auth { command } => match command {
            AuthCommand::Login {
                name,
                ttl_days,
                no_browser,
                timeout_seconds,
            } => {
                let result = login(
                    cli.server.as_deref(),
                    &mut config,
                    &store,
                    name,
                    *ttl_days,
                    *no_browser,
                    Duration::from_secs(*timeout_seconds),
                    &output,
                )
                .await?;
                output.print_either(&result, || {
                    format!(
                        "Logged in as {}\nToken: {}\nStorage: {}\nConfig: {}",
                        result.approved_email.as_deref().unwrap_or("approved user"),
                        result.token_name.as_deref().unwrap_or("Lucida CLI"),
                        result.token_storage.as_str(),
                        result.config_path
                    )
                })?;
            }
            AuthCommand::Whoami => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = AuthClient::new(server.url);
                let principal = client
                    .whoami(token.as_ref().map(|effective| effective.token.as_str()))
                    .await?;
                output.print_either(&principal, || {
                    if principal.is_admin {
                        format!("{} (admin)", principal.email)
                    } else {
                        principal.email.clone()
                    }
                })?;
            }
            AuthCommand::Logout { local_only } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let mut revoked = false;
                if !*local_only {
                    let effective = token.as_ref().ok_or_else(|| {
                        CliError::new(ErrorKind::Unauthenticated, "no configured token to revoke")
                    })?;
                    let client = AuthClient::new(server.url.clone());
                    revoked = client.revoke_current(&effective.token).await?;
                }
                let local_removed = clear_local_token(&server.url, &mut config);
                store.save(&config)?;
                let payload = serde_json::json!({
                    "local_removed": local_removed,
                    "server_revoked": revoked,
                    "config_path": store.path(),
                });
                output.print_either(&payload, || {
                    if *local_only {
                        if local_removed {
                            format!("Removed local token\nConfig: {}", store.path().display())
                        } else {
                            "No local token found".to_string()
                        }
                    } else if revoked {
                        format!(
                            "Revoked server token and removed local token\nConfig: {}",
                            store.path().display()
                        )
                    } else {
                        format!(
                            "Removed local token; server token was already invalid\nConfig: {}",
                            store.path().display()
                        )
                    }
                })?;
            }
        },
        Command::Workspace { command } => match command {
            WorkspaceCommand::List { archived } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = WorkspaceClient::new(server.url.clone(), token);
                let workspaces = client.list(*archived).await?;
                let output_payload = WorkspaceListOutput {
                    server,
                    include_archived: *archived,
                    workspaces,
                };
                output.print_either(&output_payload, || {
                    format_workspace_list_human(&output_payload.workspaces)
                })?;
            }
            WorkspaceCommand::Create { name } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = WorkspaceClient::new(server.url.clone(), token);
                let workspace = client.create(name.as_deref()).await?;
                let target = target_for(&server.url, &workspace)?;
                let output_payload = WorkspaceOutput {
                    server,
                    workspace,
                    target,
                };
                output.print_either(&output_payload, || {
                    format_workspace_human(&output_payload.workspace, &output_payload.target)
                })?;
            }
            WorkspaceCommand::Info { selector, archived } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = WorkspaceClient::new(server.url.clone(), token);
                let workspace = resolve_workspace_record(
                    &client,
                    first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                    &config,
                    if *archived {
                        WorkspaceLookupMode::IncludeArchived
                    } else {
                        WorkspaceLookupMode::ActiveOnly
                    },
                )
                .await?;
                let target = target_for(&server.url, &workspace)?;
                let output_payload = WorkspaceOutput {
                    server,
                    workspace,
                    target,
                };
                output.print_either(&output_payload, || {
                    format_workspace_human(&output_payload.workspace, &output_payload.target)
                })?;
            }
            WorkspaceCommand::Use { selector } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = WorkspaceClient::new(server.url.clone(), token);
                let workspace = resolve_workspace_record(
                    &client,
                    Some(selector.as_str()),
                    &config,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                config.workspace = Some(workspace.id.clone());
                store.save(&config)?;
                let target = target_for(&server.url, &workspace)?;
                let output_payload = WorkspaceUseOutput {
                    server,
                    workspace,
                    target,
                    config_path: store.path().display().to_string(),
                };
                output.print_either(&output_payload, || {
                    format!(
                        "{}\nDefault workspace set to {}\nConfig: {}",
                        format_workspace_human(&output_payload.workspace, &output_payload.target),
                        output_payload.workspace.id,
                        output_payload.config_path
                    )
                })?;
            }
            WorkspaceCommand::Open {
                selector,
                no_browser,
            } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = WorkspaceClient::new(server.url.clone(), token);
                let workspace = resolve_workspace_record(
                    &client,
                    first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                    &config,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                let workspace = client.open(&workspace.id).await?;
                let target = target_for(&server.url, &workspace)?;
                let opened = if *no_browser {
                    false
                } else {
                    open_browser(&target.web_url)
                };
                let output_payload = WorkspaceOpenOutput {
                    server,
                    workspace,
                    target,
                    opened,
                };
                output.print_either(&output_payload, || {
                    format!(
                        "{}\nOpened: {}",
                        output_payload.target.web_url, output_payload.opened
                    )
                })?;
            }
        },
        Command::Dataset { command } => match command {
            DatasetCommand::Open {
                source,
                timeout_seconds,
            } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let workspace_client = WorkspaceClient::new(server.url.clone(), token.clone());
                let workspace = resolve_workspace_record(
                    &workspace_client,
                    cli.workspace.as_deref(),
                    &config,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                let target = target_for(&server.url, &workspace)?;
                let dataset_client = DatasetOpenClient::new(target.ws_url.clone(), token);
                let dataset = dataset_client
                    .open(source, &workspace.id, Duration::from_secs(*timeout_seconds))
                    .await?;
                let output_payload = DatasetOpenOutput {
                    server,
                    workspace,
                    target,
                    dataset,
                };
                output.print_either(&output_payload, || {
                    format_dataset_open_human(&output_payload)
                })?;
            }
        },
        Command::Config { command } => match command {
            ConfigCommand::Set { command } => match command {
                ConfigSetCommand::Server { base_url } => {
                    let normalized = normalize_server_base_url(base_url)?;
                    config.server = Some(normalized.clone());
                    store.save(&config)?;
                    let payload = serde_json::json!({
                        "server": normalized,
                        "config_path": store.path(),
                    });
                    output.print_either(&payload, || {
                        format!(
                            "Server set to {}\nConfig: {}",
                            payload["server"].as_str().unwrap_or_default(),
                            store.path().display()
                        )
                    })?;
                }
            },
            ConfigCommand::Get { command } => match command {
                ConfigGetCommand::Server => {
                    let effective = resolve_server(None, &config)?;
                    output.print_either(&effective, || {
                        format!("{} ({})", effective.url, effective.source.as_str())
                    })?;
                }
                ConfigGetCommand::Workspace => {
                    let payload = serde_json::json!({
                        "workspace": config.workspace,
                        "source": if config.workspace.is_some() { "config" } else { "unset" },
                    });
                    output.print_either(&payload, || {
                        config
                            .workspace
                            .clone()
                            .unwrap_or_else(|| "unset".to_string())
                    })?;
                }
            },
            ConfigCommand::Path => {
                let payload = serde_json::json!({ "config_path": store.path() });
                output.print_either(&payload, || store.path().display().to_string())?;
            }
        },
    }

    Ok(())
}

async fn load_status(
    server_override: Option<&str>,
    config: &CliConfig,
) -> Result<StatusReport, CliError> {
    let server = resolve_server(server_override, config)?;
    let token = resolve_token(&server.url, config).map(|effective| effective.token);
    let client = ServerClient::new(server.url.clone(), token);
    Ok(client.status_report(server).await)
}

async fn login(
    server_override: Option<&str>,
    config: &mut CliConfig,
    store: &ConfigStore,
    name: &str,
    ttl_days: u64,
    no_browser: bool,
    timeout: Duration,
    output: &Output,
) -> Result<LoginResult, CliError> {
    let server = resolve_server(server_override, config)?;
    let client = AuthClient::new(server.url.clone());
    let raw_token = generate_raw_token();
    let ttl_seconds = ttl_days.saturating_mul(24 * 60 * 60);
    let start = client
        .start_login(name, &raw_token, Some(ttl_seconds))
        .await?;
    let approval_url = format!("{}{}", server.url, start.approval_path);

    if output.json() {
        eprintln!("Open this URL to approve CLI access:");
        eprintln!("{approval_url}");
        eprintln!("Code: {}", start.user_code);
    } else if !output.quiet() {
        println!("Open this URL to approve CLI access:");
        println!("{approval_url}");
        println!("Code: {}", start.user_code);
    }
    if !no_browser {
        let _ = open_browser(&approval_url);
    }

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match client
            .poll_login(&start.poll_path, &start.poll_token)
            .await?
        {
            PollOutcome::Approved(approved) => {
                let storage = store_local_token(&server.url, &raw_token, config);
                store.save(config)?;
                return Ok(LoginResult {
                    server: server.url,
                    approved_email: approved.email,
                    token_id: approved.token_id,
                    token_name: approved.token_name,
                    token_expires_at: approved.token_expires_at,
                    token_storage: storage,
                    config_path: store.path().display().to_string(),
                });
            }
            PollOutcome::Expired => {
                return Err(CliError::new(
                    ErrorKind::Unauthenticated,
                    "CLI login request expired before approval",
                ));
            }
            PollOutcome::Pending => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(CliError::new(
                        ErrorKind::Unauthenticated,
                        "timed out waiting for browser approval",
                    ));
                }
                tokio::time::sleep(poll_interval()).await;
            }
        }
    }
}

fn format_version_human(report: &StatusReport) -> String {
    if report.checks.version.ok {
        report
            .checks
            .version
            .body
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string()
    } else if let Some(error) = report.checks.version.error.as_deref() {
        format!("unreachable ({error})")
    } else if let Some(status) = report.checks.version.status {
        format!("failed (HTTP {status})")
    } else {
        "failed".to_string()
    }
}

fn first_workspace_selector<'a>(
    command_selector: Option<&'a str>,
    global_selector: Option<&'a str>,
) -> Option<&'a str> {
    command_selector.or(global_selector)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn parse(args: &[&str]) -> Cli {
        Cli::parse_from(std::iter::once("lucida").chain(args.iter().copied()))
    }

    fn try_parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from(std::iter::once("lucida").chain(args.iter().copied()))
    }

    #[test]
    fn help_shows_only_product_foundation_surface() {
        let help = Cli::command().render_help().to_string();

        assert!(help.contains("status"));
        assert!(help.contains("server"));
        assert!(help.contains("auth"));
        assert!(help.contains("workspace"));
        assert!(help.contains("dataset"));
        assert!(help.contains("config"));
        assert!(!help.contains("visible-chunks"));
        assert!(!help.contains("set-mode-2d"));
        assert!(!help.contains("steer"));
    }

    #[test]
    fn status_parses_shared_flags() {
        let cli = parse(&[
            "--server",
            "http://127.0.0.1:9988",
            "--json",
            "--quiet",
            "status",
        ]);

        assert_eq!(cli.server.as_deref(), Some("http://127.0.0.1:9988"));
        assert!(cli.json);
        assert!(cli.quiet);
        assert!(matches!(cli.command, Command::Status));
    }

    #[test]
    fn config_set_server_parses_product_shape() {
        let cli = parse(&["config", "set", "server", "http://127.0.0.1:9988"]);

        match cli.command {
            Command::Config {
                command:
                    ConfigCommand::Set {
                        command: ConfigSetCommand::Server { base_url },
                    },
            } => assert_eq!(base_url, "http://127.0.0.1:9988"),
            _ => panic!("expected config set server"),
        }
    }

    #[test]
    fn auth_login_parses_product_shape() {
        let cli = parse(&["auth", "login", "--name", "Laptop"]);

        match cli.command {
            Command::Auth {
                command: AuthCommand::Login { name, .. },
            } => assert_eq!(name, "Laptop"),
            _ => panic!("expected auth login"),
        }
    }

    #[test]
    fn workspace_list_parses_product_shape() {
        let cli = parse(&["workspace", "list", "--archived"]);

        match cli.command {
            Command::Workspace {
                command: WorkspaceCommand::List { archived },
            } => assert!(archived),
            _ => panic!("expected workspace list"),
        }
    }

    #[test]
    fn workspace_create_parses_optional_name() {
        let cli = parse(&["workspace", "create", "Analysis"]);

        match cli.command {
            Command::Workspace {
                command: WorkspaceCommand::Create { name },
            } => assert_eq!(name.as_deref(), Some("Analysis")),
            _ => panic!("expected workspace create"),
        }
    }

    #[test]
    fn workspace_info_uses_positional_selector_with_global_workspace_available() {
        let cli = parse(&[
            "--workspace",
            "Default",
            "workspace",
            "info",
            "Explicit",
            "--archived",
        ]);

        assert_eq!(cli.workspace.as_deref(), Some("Default"));
        match cli.command {
            Command::Workspace {
                command: WorkspaceCommand::Info { selector, archived },
            } => {
                assert_eq!(selector.as_deref(), Some("Explicit"));
                assert!(archived);
            }
            _ => panic!("expected workspace info"),
        }
        assert_eq!(
            first_workspace_selector(Some("Explicit"), Some("Default")),
            Some("Explicit")
        );
    }

    #[test]
    fn workspace_open_parses_no_browser() {
        let cli = parse(&["workspace", "open", "w1", "--no-browser"]);

        match cli.command {
            Command::Workspace {
                command:
                    WorkspaceCommand::Open {
                        selector,
                        no_browser,
                    },
            } => {
                assert_eq!(selector.as_deref(), Some("w1"));
                assert!(no_browser);
            }
            _ => panic!("expected workspace open"),
        }
    }

    #[test]
    fn dataset_open_parses_product_shape() {
        let cli = parse(&[
            "--workspace",
            "w1",
            "dataset",
            "open",
            "/data/demo.ome.zarr",
            "--timeout-seconds",
            "12",
        ]);

        assert_eq!(cli.workspace.as_deref(), Some("w1"));
        match cli.command {
            Command::Dataset {
                command:
                    DatasetCommand::Open {
                        source,
                        timeout_seconds,
                    },
            } => {
                assert_eq!(source, "/data/demo.ome.zarr");
                assert_eq!(timeout_seconds, 12);
            }
            _ => panic!("expected dataset open"),
        }
    }

    #[test]
    fn flat_open_command_is_not_accepted() {
        assert!(try_parse(&["open", "/tmp/data.ome.zarr"]).is_err());
    }

    #[test]
    fn removed_steer_and_peer_flags_are_not_accepted() {
        assert!(try_parse(&["--steer", "1", "status"]).is_err());
        assert!(try_parse(&["--peer", "1", "status"]).is_err());
        assert!(try_parse(&["config", "set", "workspace", "w1"]).is_err());
    }
}
