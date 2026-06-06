mod auth;
mod config;
mod credentials;
mod error;
mod output;
mod status;

use std::time::Duration;

use clap::{Parser, Subcommand};

use crate::auth::{
    AuthClient, LoginResult, PollOutcome, generate_raw_token, open_browser, poll_interval,
};
use crate::config::{CliConfig, ConfigStore, normalize_server_base_url, resolve_server};
use crate::credentials::{clear_local_token, resolve_token, store_local_token};
use crate::error::{CliError, ErrorKind};
use crate::output::Output;
use crate::status::{ServerClient, StatusReport, format_status_human};

#[derive(Parser, Debug)]
#[command(name = "lucida", about = "Command line client for Lucida", version)]
struct Cli {
    /// Lucida server base URL
    #[arg(long, value_name = "BASE_URL", global = true)]
    server: Option<String>,

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
        assert!(help.contains("config"));
        assert!(!help.contains("open"));
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
    fn flat_open_command_is_not_accepted() {
        assert!(try_parse(&["open", "/tmp/data.ome.zarr"]).is_err());
    }

    #[test]
    fn removed_steer_and_peer_flags_are_not_accepted() {
        assert!(try_parse(&["--steer", "1", "status"]).is_err());
        assert!(try_parse(&["--peer", "1", "status"]).is_err());
    }
}
