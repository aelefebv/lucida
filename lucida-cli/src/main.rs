mod auth;
mod config;
mod credentials;
mod dataset;
mod error;
mod output;
mod status;
mod view;
mod workspace;

use std::time::Duration;

use clap::{Parser, Subcommand, ValueEnum};
use lucida_core::command::ViewportCommand;
use lucida_core::scene::{BlendMode, Colormap, RenderMode};

use crate::auth::{
    AuthClient, LoginResult, PollOutcome, generate_raw_token, open_browser, poll_interval,
};
use crate::config::{CliConfig, ConfigStore, normalize_server_base_url, resolve_server};
use crate::credentials::{clear_local_token, resolve_token, store_local_token};
use crate::dataset::{
    DatasetBrowseOutput, DatasetHttpClient, DatasetInfoOutput, DatasetListOutput,
    DatasetOpenClient, DatasetOpenOutput, DatasetRemoveOutput, DatasetWorkspaceClient,
    format_dataset_browse_human, format_dataset_info_human, format_dataset_list_human,
    format_dataset_open_human, format_dataset_remove_human,
};
use crate::error::{CliError, ErrorKind};
use crate::output::Output;
use crate::status::{ServerClient, StatusReport, format_status_human};
use crate::view::{DatasetDisplayCommand, DatasetPresenceOutput, format_dataset_presence_human};
use crate::view::{ViewApplyOutput, ViewWorkspaceClient, format_view_apply_human};
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
    /// Update local view state in the selected workspace
    View {
        /// Start from an explicit peer's presence instead of this CLI session
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
        /// Seconds to wait for the workspace snapshot
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: ViewCommand,
    },
    /// Update local camera state in the selected workspace
    Camera {
        /// Start from an explicit peer's presence instead of this CLI session
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
        /// Seconds to wait for the workspace snapshot
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: CameraCommand,
    },
    /// Update dataset layer display state in the selected workspace
    Layer {
        /// Start from an explicit peer's dataset presence instead of this CLI session
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
        /// Seconds to wait for the workspace snapshot
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: LayerCommand,
    },
    /// Update channel display state in the selected workspace
    Channel {
        /// Start from an explicit peer's dataset presence instead of this CLI session
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
        /// Seconds to wait for the workspace snapshot
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: ChannelCommand,
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
    /// Browse server-visible filesystem paths
    Browse {
        /// Directory path to browse. Omit for the server root.
        path: Option<String>,
    },
    /// Open a dataset path or URL in the selected workspace
    Open {
        /// Dataset path or URL visible to the Lucida server
        #[arg(value_name = "PATH_OR_URL")]
        source: String,
        /// Seconds to wait for the server to finish opening the dataset
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
    },
    /// List datasets loaded in the selected workspace
    List {
        /// Seconds to wait for the workspace snapshot
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
    },
    /// Show loaded dataset metadata from the selected workspace
    Info {
        /// Workspace-local dataset id or unambiguous dataset name
        dataset: String,
        /// Seconds to wait for the workspace snapshot
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
    },
    /// Remove a loaded dataset from the selected workspace
    Remove {
        /// Workspace-local dataset id or unambiguous dataset name
        dataset: String,
        /// Seconds to wait for command acknowledgement
        #[arg(long, default_value_t = 60)]
        timeout_seconds: u64,
    },
}

#[derive(Subcommand, Debug)]
enum ViewCommand {
    /// Pan the 2D slice camera in screen pixels
    Pan {
        #[arg(long, allow_hyphen_values = true)]
        dx: f64,
        #[arg(long, allow_hyphen_values = true)]
        dy: f64,
    },
    /// Multiply the 2D slice zoom by a factor
    Zoom {
        #[arg(long, allow_hyphen_values = true)]
        factor: f64,
    },
    /// Set the absolute 2D slice zoom
    SetZoom {
        #[arg(long, allow_hyphen_values = true)]
        value: f64,
    },
    /// Set the 2D slice camera center
    Center {
        #[arg(long, allow_hyphen_values = true)]
        x: f64,
        #[arg(long, allow_hyphen_values = true)]
        y: f64,
    },
    /// Set one selected dimension index
    Slice { axis: SliceAxis, index: u32 },
    /// Set the selected Z slab range
    ZRange { start: u32, end: u32 },
    /// Set camera viewport size in pixels
    ViewportSize { width: u32, height: u32 },
}

impl ViewCommand {
    fn viewport_command(&self) -> Result<ViewportCommand, CliError> {
        Ok(match self {
            ViewCommand::Pan { dx, dy } => ViewportCommand::Pan { dx: *dx, dy: *dy },
            ViewCommand::Zoom { factor } => {
                if *factor <= 0.0 {
                    return Err(CliError::config("view zoom --factor must be positive"));
                }
                ViewportCommand::ZoomBy { factor: *factor }
            }
            ViewCommand::SetZoom { value } => {
                if *value <= 0.0 {
                    return Err(CliError::config("view set-zoom --value must be positive"));
                }
                ViewportCommand::SetZoom { value: *value }
            }
            ViewCommand::Center { x, y } => ViewportCommand::SetCenter { x: *x, y: *y },
            ViewCommand::Slice { axis, index } => match axis {
                SliceAxis::Z => ViewportCommand::SetZ { z: *index },
                SliceAxis::T => ViewportCommand::SetT { t: *index },
                SliceAxis::C => ViewportCommand::SetC { c: *index },
            },
            ViewCommand::ZRange { start, end } => {
                if end <= start {
                    return Err(CliError::config(
                        "view z-range end must be greater than start",
                    ));
                }
                ViewportCommand::SetZRange {
                    start: *start,
                    end: *end,
                }
            }
            ViewCommand::ViewportSize { width, height } => {
                if *width == 0 || *height == 0 {
                    return Err(CliError::config(
                        "view viewport-size width and height must be positive",
                    ));
                }
                ViewportCommand::SetViewport {
                    width: *width,
                    height: *height,
                }
            }
        })
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum SliceAxis {
    Z,
    T,
    C,
}

#[derive(Subcommand, Debug)]
enum CameraCommand {
    /// Switch camera mode
    Mode { mode: CameraMode },
    /// Rotate the arcball camera
    Rotate {
        #[arg(long, allow_hyphen_values = true)]
        d_theta: f64,
        #[arg(long, allow_hyphen_values = true)]
        d_phi: f64,
    },
    /// Pan the arcball camera
    Pan {
        #[arg(long, allow_hyphen_values = true)]
        dx: f64,
        #[arg(long, allow_hyphen_values = true)]
        dy: f64,
    },
    /// Zoom the arcball camera by a relative delta
    Zoom {
        #[arg(long, allow_hyphen_values = true)]
        delta: f64,
    },
    /// Advance the fly camera by one input tick
    FlyTick {
        #[arg(
            long,
            default_value_t = 0.016666666666666666,
            allow_hyphen_values = true
        )]
        dt: f64,
        #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
        forward: f64,
        #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
        right: f64,
        #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
        up: f64,
        #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
        yaw: f64,
        #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
        pitch: f64,
        #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
        roll: f64,
    },
}

impl CameraCommand {
    fn viewport_command(&self) -> Result<ViewportCommand, CliError> {
        Ok(match self {
            CameraCommand::Mode { mode } => match mode {
                CameraMode::Slice => ViewportCommand::SetMode2D,
                CameraMode::Arcball => ViewportCommand::SetMode3D,
                CameraMode::Fly => ViewportCommand::SetModeFly,
            },
            CameraCommand::Rotate { d_theta, d_phi } => ViewportCommand::Rotate3D {
                d_theta: *d_theta,
                d_phi: *d_phi,
            },
            CameraCommand::Pan { dx, dy } => ViewportCommand::Pan3D { dx: *dx, dy: *dy },
            CameraCommand::Zoom { delta } => ViewportCommand::Zoom3D { delta: *delta },
            CameraCommand::FlyTick {
                dt,
                forward,
                right,
                up,
                yaw,
                pitch,
                roll,
            } => {
                if *dt < 0.0 {
                    return Err(CliError::config(
                        "camera fly-tick --dt must be non-negative",
                    ));
                }
                ViewportCommand::FlyTick {
                    dt: *dt,
                    forward: *forward,
                    right: *right,
                    up: *up,
                    yaw: *yaw,
                    pitch: *pitch,
                    roll: *roll,
                }
            }
        })
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum CameraMode {
    Slice,
    Arcball,
    Fly,
}

#[derive(Subcommand, Debug)]
enum LayerCommand {
    /// List loaded dataset layers and display settings
    List,
    /// Put named datasets first in layer order; unnamed loaded datasets keep their relative order after them
    Order {
        #[arg(required = true)]
        datasets: Vec<String>,
    },
    /// Show a dataset layer
    Show { dataset: String },
    /// Hide a dataset layer
    Hide { dataset: String },
    /// Set dataset layer opacity
    Opacity { dataset: String, opacity: f32 },
    /// Set contrast for the current or explicit channel of a layer
    Contrast {
        dataset: String,
        #[arg(long, allow_hyphen_values = true)]
        min: f64,
        #[arg(long, allow_hyphen_values = true)]
        max: f64,
        #[arg(long)]
        channel: Option<u32>,
    },
    /// Set gamma for the current or explicit channel of a layer
    Gamma {
        dataset: String,
        #[arg(long, allow_hyphen_values = true)]
        gamma: f64,
        #[arg(long)]
        channel: Option<u32>,
    },
    /// Set colormap for the current or explicit channel of a layer
    Colormap {
        dataset: String,
        colormap: ColormapValue,
        #[arg(long)]
        channel: Option<u32>,
    },
    /// Set dataset blend mode
    BlendMode {
        dataset: String,
        mode: BlendModeValue,
    },
    /// Set volume render mode
    RenderMode {
        dataset: String,
        mode: RenderModeValue,
    },
    /// Set or clear selectable detail-level override
    DetailLevel { dataset: String, level: Option<u32> },
}

impl LayerCommand {
    fn display_command(&self) -> Result<Option<DatasetDisplayCommand>, CliError> {
        Ok(match self {
            LayerCommand::List => None,
            LayerCommand::Order { datasets } => Some(DatasetDisplayCommand::SetOrder {
                selectors: datasets.clone(),
            }),
            LayerCommand::Show { dataset } => Some(DatasetDisplayCommand::SetDatasetVisible {
                selector: dataset.clone(),
                visible: true,
            }),
            LayerCommand::Hide { dataset } => Some(DatasetDisplayCommand::SetDatasetVisible {
                selector: dataset.clone(),
                visible: false,
            }),
            LayerCommand::Opacity { dataset, opacity } => {
                if !(0.0..=1.0).contains(opacity) {
                    return Err(CliError::config("layer opacity must be between 0 and 1"));
                }
                Some(DatasetDisplayCommand::SetDatasetOpacity {
                    selector: dataset.clone(),
                    opacity: *opacity,
                })
            }
            LayerCommand::Contrast {
                dataset,
                min,
                max,
                channel,
            } => {
                validate_contrast(*min, *max)?;
                Some(DatasetDisplayCommand::SetCurrentChannelContrast {
                    selector: dataset.clone(),
                    channel: *channel,
                    min: *min,
                    max: *max,
                })
            }
            LayerCommand::Gamma {
                dataset,
                gamma,
                channel,
            } => {
                validate_gamma(*gamma)?;
                Some(DatasetDisplayCommand::SetCurrentChannelGamma {
                    selector: dataset.clone(),
                    channel: *channel,
                    gamma: *gamma,
                })
            }
            LayerCommand::Colormap {
                dataset,
                colormap,
                channel,
            } => Some(DatasetDisplayCommand::SetCurrentChannelColormap {
                selector: dataset.clone(),
                channel: *channel,
                colormap: (*colormap).into(),
            }),
            LayerCommand::BlendMode { dataset, mode } => {
                Some(DatasetDisplayCommand::SetDatasetBlendMode {
                    selector: dataset.clone(),
                    blend_mode: (*mode).into(),
                })
            }
            LayerCommand::RenderMode { dataset, mode } => {
                Some(DatasetDisplayCommand::SetDatasetRenderMode {
                    selector: dataset.clone(),
                    render_mode: (*mode).into(),
                })
            }
            LayerCommand::DetailLevel { dataset, level } => {
                Some(DatasetDisplayCommand::SetDatasetDetailLevelOverride {
                    selector: dataset.clone(),
                    level: *level,
                })
            }
        })
    }
}

#[derive(Subcommand, Debug)]
enum ChannelCommand {
    /// Switch single-channel or multichannel rendering mode
    Mode { mode: ChannelMode },
    /// Show a dataset channel
    Show { dataset: String, channel: u32 },
    /// Hide a dataset channel
    Hide { dataset: String, channel: u32 },
    /// Set a dataset channel colormap
    Colormap {
        dataset: String,
        channel: u32,
        colormap: ColormapValue,
    },
    /// Set a dataset channel contrast window
    Contrast {
        dataset: String,
        channel: u32,
        #[arg(long, allow_hyphen_values = true)]
        min: f64,
        #[arg(long, allow_hyphen_values = true)]
        max: f64,
    },
    /// Set a dataset channel gamma
    Gamma {
        dataset: String,
        channel: u32,
        #[arg(long, allow_hyphen_values = true)]
        gamma: f64,
    },
    /// Set the dataset channel blend mode
    BlendMode {
        dataset: String,
        mode: BlendModeValue,
    },
}

#[derive(Debug)]
enum ChannelCommandAction {
    Viewport(ViewportCommand),
    Dataset(DatasetDisplayCommand),
}

impl ChannelCommand {
    fn action(&self) -> Result<ChannelCommandAction, CliError> {
        Ok(match self {
            ChannelCommand::Mode { mode } => {
                ChannelCommandAction::Viewport(ViewportCommand::SetMultiChannel {
                    enabled: *mode == ChannelMode::Multi,
                })
            }
            ChannelCommand::Show { dataset, channel } => {
                ChannelCommandAction::Dataset(DatasetDisplayCommand::SetChannelVisible {
                    selector: dataset.clone(),
                    channel: *channel,
                    visible: true,
                })
            }
            ChannelCommand::Hide { dataset, channel } => {
                ChannelCommandAction::Dataset(DatasetDisplayCommand::SetChannelVisible {
                    selector: dataset.clone(),
                    channel: *channel,
                    visible: false,
                })
            }
            ChannelCommand::Colormap {
                dataset,
                channel,
                colormap,
            } => ChannelCommandAction::Dataset(DatasetDisplayCommand::SetChannelColormap {
                selector: dataset.clone(),
                channel: *channel,
                colormap: (*colormap).into(),
            }),
            ChannelCommand::Contrast {
                dataset,
                channel,
                min,
                max,
            } => {
                validate_contrast(*min, *max)?;
                ChannelCommandAction::Dataset(DatasetDisplayCommand::SetChannelContrast {
                    selector: dataset.clone(),
                    channel: *channel,
                    min: *min,
                    max: *max,
                })
            }
            ChannelCommand::Gamma {
                dataset,
                channel,
                gamma,
            } => {
                validate_gamma(*gamma)?;
                ChannelCommandAction::Dataset(DatasetDisplayCommand::SetChannelGamma {
                    selector: dataset.clone(),
                    channel: *channel,
                    gamma: *gamma,
                })
            }
            ChannelCommand::BlendMode { dataset, mode } => {
                ChannelCommandAction::Dataset(DatasetDisplayCommand::SetChannelBlendMode {
                    selector: dataset.clone(),
                    blend_mode: (*mode).into(),
                })
            }
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum ChannelMode {
    Single,
    Multi,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum BlendModeValue {
    Alpha,
    Additive,
    Max,
}

impl From<BlendModeValue> for BlendMode {
    fn from(value: BlendModeValue) -> Self {
        match value {
            BlendModeValue::Alpha => BlendMode::Alpha,
            BlendModeValue::Additive => BlendMode::Additive,
            BlendModeValue::Max => BlendMode::Max,
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum RenderModeValue {
    Translucent,
    #[value(name = "max-intensity")]
    MaxIntensity,
}

impl From<RenderModeValue> for RenderMode {
    fn from(value: RenderModeValue) -> Self {
        match value {
            RenderModeValue::Translucent => RenderMode::Translucent,
            RenderModeValue::MaxIntensity => RenderMode::MaxIntensity,
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ColormapValue {
    Gray,
    Magenta,
    Green,
    Cyan,
    Red,
    Blue,
    Yellow,
    Viridis,
    Inferno,
    Plasma,
    Magma,
    Turbo,
    Hot,
    Cool,
    Jet,
}

impl From<ColormapValue> for Colormap {
    fn from(value: ColormapValue) -> Self {
        match value {
            ColormapValue::Gray => Colormap::Gray,
            ColormapValue::Magenta => Colormap::Magenta,
            ColormapValue::Green => Colormap::Green,
            ColormapValue::Cyan => Colormap::Cyan,
            ColormapValue::Red => Colormap::Red,
            ColormapValue::Blue => Colormap::Blue,
            ColormapValue::Yellow => Colormap::Yellow,
            ColormapValue::Viridis => Colormap::Viridis,
            ColormapValue::Inferno => Colormap::Inferno,
            ColormapValue::Plasma => Colormap::Plasma,
            ColormapValue::Magma => Colormap::Magma,
            ColormapValue::Turbo => Colormap::Turbo,
            ColormapValue::Hot => Colormap::Hot,
            ColormapValue::Cool => Colormap::Cool,
            ColormapValue::Jet => Colormap::Jet,
        }
    }
}

fn validate_contrast(min: f64, max: f64) -> Result<(), CliError> {
    if !min.is_finite() || !max.is_finite() {
        return Err(CliError::config("contrast bounds must be finite"));
    }
    if max <= min {
        return Err(CliError::config(
            "contrast --max must be greater than --min",
        ));
    }
    Ok(())
}

fn validate_gamma(gamma: f64) -> Result<(), CliError> {
    if !gamma.is_finite() || gamma <= 0.0 {
        return Err(CliError::config("gamma must be positive and finite"));
    }
    Ok(())
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
            DatasetCommand::Browse { path } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = DatasetHttpClient::new(server.url.clone(), token);
                let browse = client.browse(path.as_deref()).await?;
                let output_payload = DatasetBrowseOutput {
                    server,
                    path: browse.path,
                    entries: browse.entries,
                };
                output.print_either(&output_payload, || {
                    format_dataset_browse_human(&output_payload)
                })?;
            }
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
            DatasetCommand::List { timeout_seconds } => {
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
                let dataset_client = DatasetWorkspaceClient::new(target.ws_url.clone(), token);
                let (seq, datasets) = dataset_client
                    .list(Duration::from_secs(*timeout_seconds))
                    .await?;
                let output_payload = DatasetListOutput {
                    server,
                    workspace,
                    target,
                    seq,
                    datasets,
                };
                output.print_either(&output_payload, || {
                    format_dataset_list_human(&output_payload)
                })?;
            }
            DatasetCommand::Info {
                dataset,
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
                let dataset_client = DatasetWorkspaceClient::new(target.ws_url.clone(), token);
                let (seq, dataset) = dataset_client
                    .info(dataset, Duration::from_secs(*timeout_seconds))
                    .await?;
                let output_payload = DatasetInfoOutput {
                    server,
                    workspace,
                    target,
                    seq,
                    dataset,
                };
                output.print_either(&output_payload, || {
                    format_dataset_info_human(&output_payload)
                })?;
            }
            DatasetCommand::Remove {
                dataset,
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
                let dataset_client = DatasetWorkspaceClient::new(target.ws_url.clone(), token);
                let (seq, removed) = dataset_client
                    .remove(dataset, &workspace, Duration::from_secs(*timeout_seconds))
                    .await?;
                let output_payload = DatasetRemoveOutput {
                    server,
                    workspace,
                    target,
                    seq,
                    removed,
                };
                output.print_either(&output_payload, || {
                    format_dataset_remove_human(&output_payload)
                })?;
            }
        },
        Command::View {
            from_peer,
            timeout_seconds,
            command,
        } => {
            emit_viewport_command(
                &cli,
                &config,
                output,
                command.viewport_command()?,
                *from_peer,
                *timeout_seconds,
            )
            .await?;
        }
        Command::Camera {
            from_peer,
            timeout_seconds,
            command,
        } => {
            emit_viewport_command(
                &cli,
                &config,
                output,
                command.viewport_command()?,
                *from_peer,
                *timeout_seconds,
            )
            .await?;
        }
        Command::Layer {
            from_peer,
            timeout_seconds,
            command,
        } => {
            emit_dataset_presence_command(
                &cli,
                &config,
                output,
                command.display_command()?,
                *from_peer,
                *timeout_seconds,
            )
            .await?;
        }
        Command::Channel {
            from_peer,
            timeout_seconds,
            command,
        } => match command.action()? {
            ChannelCommandAction::Viewport(command) => {
                emit_viewport_command(&cli, &config, output, command, *from_peer, *timeout_seconds)
                    .await?;
            }
            ChannelCommandAction::Dataset(command) => {
                emit_dataset_presence_command(
                    &cli,
                    &config,
                    output,
                    Some(command),
                    *from_peer,
                    *timeout_seconds,
                )
                .await?;
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

async fn emit_viewport_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: ViewportCommand,
    from_peer: Option<u64>,
    timeout_seconds: u64,
) -> Result<(), CliError> {
    let server = resolve_server(cli.server.as_deref(), config)?;
    let token = resolve_token(&server.url, config);
    let workspace_client = WorkspaceClient::new(server.url.clone(), token.clone());
    let workspace = resolve_workspace_record(
        &workspace_client,
        cli.workspace.as_deref(),
        config,
        WorkspaceLookupMode::ActiveOnly,
    )
    .await?;
    let target = target_for(&server.url, &workspace)?;
    let view_client = ViewWorkspaceClient::new(target.ws_url.clone(), token);
    let result = view_client
        .apply(command, from_peer, Duration::from_secs(timeout_seconds))
        .await?;
    let output_payload = ViewApplyOutput {
        server,
        workspace,
        target,
        result,
    };
    output.print_either(&output_payload, || format_view_apply_human(&output_payload))?;
    Ok(())
}

async fn emit_dataset_presence_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: Option<DatasetDisplayCommand>,
    from_peer: Option<u64>,
    timeout_seconds: u64,
) -> Result<(), CliError> {
    let server = resolve_server(cli.server.as_deref(), config)?;
    let token = resolve_token(&server.url, config);
    let workspace_client = WorkspaceClient::new(server.url.clone(), token.clone());
    let workspace = resolve_workspace_record(
        &workspace_client,
        cli.workspace.as_deref(),
        config,
        WorkspaceLookupMode::ActiveOnly,
    )
    .await?;
    let target = target_for(&server.url, &workspace)?;
    let view_client = ViewWorkspaceClient::new(target.ws_url.clone(), token);
    let result = if let Some(command) = command {
        view_client
            .apply_dataset(command, from_peer, Duration::from_secs(timeout_seconds))
            .await?
    } else {
        view_client
            .dataset_state(from_peer, Duration::from_secs(timeout_seconds))
            .await?
    };
    let output_payload = DatasetPresenceOutput {
        server,
        workspace,
        target,
        result,
    };
    output.print_either(&output_payload, || {
        format_dataset_presence_human(&output_payload)
    })?;
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
        assert!(help.contains("view"));
        assert!(help.contains("camera"));
        assert!(help.contains("layer"));
        assert!(help.contains("channel"));
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
    fn dataset_browse_parses_optional_path() {
        let cli = parse(&["dataset", "browse", "/data"]);

        match cli.command {
            Command::Dataset {
                command: DatasetCommand::Browse { path },
            } => assert_eq!(path.as_deref(), Some("/data")),
            _ => panic!("expected dataset browse"),
        }
    }

    #[test]
    fn dataset_list_and_info_parse_timeout_shape() {
        let list = parse(&["dataset", "list", "--timeout-seconds", "7"]);
        match list.command {
            Command::Dataset {
                command: DatasetCommand::List { timeout_seconds },
            } => assert_eq!(timeout_seconds, 7),
            _ => panic!("expected dataset list"),
        }

        let info = parse(&["dataset", "info", "wds-1", "--timeout-seconds", "8"]);
        match info.command {
            Command::Dataset {
                command:
                    DatasetCommand::Info {
                        dataset,
                        timeout_seconds,
                    },
            } => {
                assert_eq!(dataset, "wds-1");
                assert_eq!(timeout_seconds, 8);
            }
            _ => panic!("expected dataset info"),
        }
    }

    #[test]
    fn dataset_remove_parses_product_shape() {
        let cli = parse(&["dataset", "remove", "wds-1", "--timeout-seconds", "9"]);

        match cli.command {
            Command::Dataset {
                command:
                    DatasetCommand::Remove {
                        dataset,
                        timeout_seconds,
                    },
            } => {
                assert_eq!(dataset, "wds-1");
                assert_eq!(timeout_seconds, 9);
            }
            _ => panic!("expected dataset remove"),
        }
    }

    #[test]
    fn view_pan_parses_negative_numbers_and_maps_to_viewport_command() {
        let cli = parse(&[
            "--workspace",
            "w1",
            "view",
            "--from-peer",
            "7",
            "--timeout-seconds",
            "4",
            "pan",
            "--dx",
            "-10.5",
            "--dy",
            "-2.25",
        ]);

        assert_eq!(cli.workspace.as_deref(), Some("w1"));
        match cli.command {
            Command::View {
                from_peer,
                timeout_seconds,
                command,
            } => {
                assert_eq!(from_peer, Some(7));
                assert_eq!(timeout_seconds, 4);
                match command.viewport_command().unwrap() {
                    ViewportCommand::Pan { dx, dy } => {
                        assert_eq!(dx, -10.5);
                        assert_eq!(dy, -2.25);
                    }
                    _ => panic!("expected pan command"),
                }
            }
            _ => panic!("expected view pan"),
        }
    }

    #[test]
    fn view_slice_and_z_range_map_to_viewport_commands() {
        let slice = parse(&["view", "slice", "t", "12"]);
        match slice.command {
            Command::View { command, .. } => match command.viewport_command().unwrap() {
                ViewportCommand::SetT { t } => assert_eq!(t, 12),
                _ => panic!("expected set t"),
            },
            _ => panic!("expected view slice"),
        }

        let range = parse(&["view", "z-range", "3", "9"]);
        match range.command {
            Command::View { command, .. } => match command.viewport_command().unwrap() {
                ViewportCommand::SetZRange { start, end } => {
                    assert_eq!(start, 3);
                    assert_eq!(end, 9);
                }
                _ => panic!("expected z range"),
            },
            _ => panic!("expected view z-range"),
        }
    }

    #[test]
    fn camera_commands_parse_and_map_to_viewport_commands() {
        let mode = parse(&["camera", "mode", "fly"]);
        match mode.command {
            Command::Camera { command, .. } => {
                assert!(matches!(
                    command.viewport_command().unwrap(),
                    ViewportCommand::SetModeFly
                ));
            }
            _ => panic!("expected camera mode"),
        }

        let rotate = parse(&["camera", "rotate", "--d-theta", "-0.1", "--d-phi", "-0.2"]);
        match rotate.command {
            Command::Camera { command, .. } => match command.viewport_command().unwrap() {
                ViewportCommand::Rotate3D { d_theta, d_phi } => {
                    assert_eq!(d_theta, -0.1);
                    assert_eq!(d_phi, -0.2);
                }
                _ => panic!("expected rotate"),
            },
            _ => panic!("expected camera rotate"),
        }

        let tick = parse(&["camera", "fly-tick", "--forward", "1", "--yaw", "-0.5"]);
        match tick.command {
            Command::Camera { command, .. } => match command.viewport_command().unwrap() {
                ViewportCommand::FlyTick { forward, yaw, .. } => {
                    assert_eq!(forward, 1.0);
                    assert_eq!(yaw, -0.5);
                }
                _ => panic!("expected fly tick"),
            },
            _ => panic!("expected camera fly tick"),
        }
    }

    #[test]
    fn layer_commands_parse_and_map_to_dataset_presence_commands() {
        let opacity = parse(&["layer", "opacity", "demo.zarr", "0.5"]);
        match opacity.command {
            Command::Layer { command, .. } => match command.display_command().unwrap().unwrap() {
                DatasetDisplayCommand::SetDatasetOpacity { selector, opacity } => {
                    assert_eq!(selector, "demo.zarr");
                    assert_eq!(opacity, 0.5);
                }
                _ => panic!("expected layer opacity"),
            },
            _ => panic!("expected layer opacity"),
        }

        let contrast = parse(&[
            "layer",
            "contrast",
            "demo.zarr",
            "--min",
            "-1",
            "--max",
            "99",
            "--channel",
            "1",
        ]);
        match contrast.command {
            Command::Layer { command, .. } => match command.display_command().unwrap().unwrap() {
                DatasetDisplayCommand::SetCurrentChannelContrast {
                    selector,
                    channel,
                    min,
                    max,
                } => {
                    assert_eq!(selector, "demo.zarr");
                    assert_eq!(channel, Some(1));
                    assert_eq!(min, -1.0);
                    assert_eq!(max, 99.0);
                }
                _ => panic!("expected layer contrast"),
            },
            _ => panic!("expected layer contrast"),
        }

        let order = parse(&["layer", "order", "b.zarr", "a.zarr"]);
        match order.command {
            Command::Layer { command, .. } => match command.display_command().unwrap().unwrap() {
                DatasetDisplayCommand::SetOrder { selectors } => {
                    assert_eq!(selectors, vec!["b.zarr", "a.zarr"]);
                }
                _ => panic!("expected layer order"),
            },
            _ => panic!("expected layer order"),
        }
    }

    #[test]
    fn channel_commands_parse_and_map_to_presence_or_dataset_presence() {
        let mode = parse(&["channel", "mode", "multi"]);
        match mode.command {
            Command::Channel { command, .. } => match command.action().unwrap() {
                ChannelCommandAction::Viewport(ViewportCommand::SetMultiChannel { enabled }) => {
                    assert!(enabled);
                }
                _ => panic!("expected multi-channel view command"),
            },
            _ => panic!("expected channel mode"),
        }

        let colormap = parse(&["channel", "colormap", "demo.zarr", "1", "viridis"]);
        match colormap.command {
            Command::Channel { command, .. } => match command.action().unwrap() {
                ChannelCommandAction::Dataset(DatasetDisplayCommand::SetChannelColormap {
                    selector,
                    channel,
                    colormap,
                }) => {
                    assert_eq!(selector, "demo.zarr");
                    assert_eq!(channel, 1);
                    assert_eq!(colormap, Colormap::Viridis);
                }
                _ => panic!("expected channel colormap"),
            },
            _ => panic!("expected channel colormap"),
        }
    }

    #[test]
    fn layer_and_channel_validation_reject_bad_numbers() {
        let opacity = parse(&["layer", "opacity", "demo.zarr", "2.0"]);
        match opacity.command {
            Command::Layer { command, .. } => {
                assert_eq!(
                    command.display_command().unwrap_err().kind,
                    ErrorKind::Config
                );
            }
            _ => panic!("expected layer opacity"),
        }

        let gamma = parse(&["channel", "gamma", "demo.zarr", "1", "--gamma", "0"]);
        match gamma.command {
            Command::Channel { command, .. } => {
                assert_eq!(command.action().unwrap_err().kind, ErrorKind::Config);
            }
            _ => panic!("expected channel gamma"),
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
