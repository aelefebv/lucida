mod config;
mod error;
mod output;
mod status;

use clap::{Parser, Subcommand};

use crate::config::{CliConfig, ConfigStore, normalize_server_base_url, resolve_server};
use crate::error::CliError;
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
    let client = ServerClient::new(server.url.clone());
    Ok(client.status_report(server).await)
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
    fn flat_open_command_is_not_accepted() {
        assert!(try_parse(&["open", "/tmp/data.ome.zarr"]).is_err());
    }

    #[test]
    fn removed_steer_and_peer_flags_are_not_accepted() {
        assert!(try_parse(&["--steer", "1", "status"]).is_err());
        assert!(try_parse(&["--peer", "1", "status"]).is_err());
    }
}
