mod admin;
mod auth;
mod config;
mod credentials;
mod dataset;
mod error;
mod layout;
mod output;
mod saved_view;
mod status;
mod view;
mod workspace;

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use base64::Engine as _;
use clap::{Parser, Subcommand, ValueEnum};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use lucida_core::command::ViewportCommand;
use lucida_core::scene::{BlendMode, Colormap, RenderMode};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Error as WebSocketError;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::admin::{
    AdminClearProxyCacheOutput, AdminClient, AdminWorkspaceDetailsOutput,
    AdminWorkspaceOwnerOutput, AdminWorkspaceSearchOutput, REMOTE_ADMIN_SCOPE,
    format_admin_clear_proxy_cache_human, format_admin_workspace_details_human,
    format_admin_workspace_owner_human, format_admin_workspace_search_human,
};
use crate::auth::{
    AuthClient, LoginResult, PollOutcome, generate_raw_token, open_browser, poll_interval,
};
use crate::config::{CliConfig, ConfigStore, normalize_server_base_url, resolve_server};
use crate::credentials::{EffectiveToken, clear_local_token, resolve_token, store_local_token};
use crate::dataset::{
    DatasetBrowseOutput, DatasetHttpClient, DatasetInfoOutput, DatasetListOutput,
    DatasetOpenClient, DatasetOpenOutput, DatasetRemoveOutput, DatasetWorkspaceClient,
    format_dataset_browse_human, format_dataset_info_human, format_dataset_list_human,
    format_dataset_open_human, format_dataset_remove_human,
};
use crate::error::{CliError, ErrorKind};
use crate::layout::{
    LayoutActiveOutput, LayoutListOutput, LayoutSetOutput, LayoutWorkspaceClient,
    format_layout_active_human, format_layout_list_human, format_layout_set_human,
};
use crate::output::Output;
use crate::saved_view::{
    SavedViewApplyOutput, SavedViewCaptureOutput, SavedViewDefaultOutput, SavedViewDeleteOutput,
    SavedViewLinkOutput, SavedViewListOutput, SavedViewOutput, WorkspaceSavedViewClient,
    format_saved_view_apply_human, format_saved_view_capture_human,
    format_saved_view_default_human, format_saved_view_delete_human, format_saved_view_human,
    format_saved_view_link_human, format_saved_view_list_human, resolve_saved_view_record,
    saved_view_link, saved_view_summaries, saved_view_summary,
};
use crate::status::{ServerClient, StatusReport, format_status_human};
use crate::view::{
    DatasetDisplayCommand, DatasetPresenceOutput, DebugStateOutput, PeerCursorOutput,
    PeerFollowOutput, PeerListOutput, PeerWorkspaceClient, PlanVisibleChunksOutput,
    ViewApplyOutput, ViewWorkspaceClient, ViewerProfileClient, ViewerProfileOutput,
    format_dataset_presence_human, format_debug_state_human, format_peer_cursor_human,
    format_peer_follow_human, format_peer_list_human, format_plan_visible_chunks_human,
    format_view_apply_human, format_viewer_profile_human,
};
use crate::workspace::{
    WorkspaceClient, WorkspaceListOutput, WorkspaceLookupMode, WorkspaceOpenOutput,
    WorkspaceOutput, WorkspaceTarget, WorkspaceUseOutput, format_workspace_human,
    format_workspace_list_human, resolve_workspace_record, target_for,
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
        /// Durable headless viewer profile to update when --from-peer is omitted
        #[arg(long, default_value = "default", value_name = "NAME")]
        viewer_profile: String,
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
        /// Durable headless viewer profile to update when --from-peer is omitted
        #[arg(long, default_value = "default", value_name = "NAME")]
        viewer_profile: String,
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
        /// Durable headless viewer profile to update when --from-peer is omitted
        #[arg(long, default_value = "default", value_name = "NAME")]
        viewer_profile: String,
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
        /// Durable headless viewer profile to update when --from-peer is omitted
        #[arg(long, default_value = "default", value_name = "NAME")]
        viewer_profile: String,
        /// Start from an explicit peer's dataset presence instead of this CLI session
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
        /// Seconds to wait for the workspace snapshot
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: ChannelCommand,
    },
    /// Inspect and capture durable headless viewer profiles
    Viewer {
        /// Durable headless viewer profile
        #[arg(long, default_value = "default", value_name = "NAME")]
        profile: String,
        /// Seconds to wait for workspace state
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: ViewerCommand,
    },
    /// Inspect live peers and send explicit presence diagnostics
    Peer {
        /// Seconds to wait for workspace state or follow confirmation
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: PeerCommand,
    },
    /// Inspect chunk-planning diagnostics for the selected workspace view
    Plan {
        /// Durable headless viewer profile to inspect when --from-peer is omitted
        #[arg(long, default_value = "default", value_name = "NAME")]
        viewer_profile: String,
        /// Inspect an explicit live peer's presence instead of the viewer profile
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
        /// Seconds to wait for workspace state
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: PlanCommand,
    },
    /// Inspect read-only workspace and viewer diagnostics
    Debug {
        /// Durable headless viewer profile to inspect when --from-peer is omitted
        #[arg(long, default_value = "default", value_name = "NAME")]
        viewer_profile: String,
        /// Inspect an explicit live peer's presence instead of the viewer profile
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
        /// Seconds to wait for workspace state
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: DebugCommand,
    },
    /// Inspect and change shared dataset layouts in the selected workspace
    Layout {
        /// Seconds to wait for the workspace snapshot or command acknowledgement
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: LayoutCommand,
    },
    /// Manage workspace saved views
    SavedView {
        /// Seconds to wait for workspace capture/apply state
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
        #[command(subcommand)]
        command: SavedViewCommand,
    },
    /// Run authenticated remote admin/support commands
    Admin {
        #[command(subcommand)]
        command: AdminCommand,
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
enum AdminCommand {
    /// Search and mutate workspaces through the remote admin API
    Workspace {
        #[command(subcommand)]
        command: AdminWorkspaceCommand,
    },
    /// Clear the remote server proxy cache
    ClearProxyCache {
        /// Dataset URL to clear. Omit to clear every cached dataset.
        #[arg(long)]
        dataset: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum AdminWorkspaceCommand {
    /// Search workspace admin metadata by id, name, creator, or member email
    Search {
        /// Optional search text
        query: Option<String>,
        /// Include archived workspaces
        #[arg(long)]
        include_archived: bool,
        /// Maximum rows to return
        #[arg(long, default_value_t = 25)]
        limit: usize,
    },
    /// Show admin metadata and members for one workspace id
    Info {
        /// Workspace id
        workspace_id: String,
    },
    /// Archive one workspace id through the remote admin API
    Archive {
        /// Workspace id
        workspace_id: String,
    },
    /// Restore one archived workspace id through the remote admin API
    Restore {
        /// Workspace id
        workspace_id: String,
    },
    /// Add or promote workspace owners through the remote admin API
    Owner {
        #[command(subcommand)]
        command: AdminWorkspaceOwnerCommand,
    },
}

#[derive(Subcommand, Debug)]
enum AdminWorkspaceOwnerCommand {
    /// Add a new owner or leave an existing owner as owner
    Add {
        /// Workspace id
        workspace_id: String,
        /// Owner email
        email: String,
        /// Display name to store if adding the member
        #[arg(long)]
        display_name: Option<String>,
    },
    /// Promote an existing member to owner, or add them if missing
    Promote {
        /// Workspace id
        workspace_id: String,
        /// Owner email
        email: String,
        /// Display name to store if adding the member
        #[arg(long)]
        display_name: Option<String>,
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

#[derive(Subcommand, Debug)]
enum ViewerCommand {
    /// Show the durable viewer profile state
    State,
    /// Print a browser URL that opens this viewer profile
    Link,
    /// Capture a browser screenshot of this viewer profile
    Screenshot {
        /// PNG output path
        output: String,
        /// Browser viewport width in pixels
        #[arg(long, default_value_t = 1200)]
        width: u32,
        /// Browser viewport height in pixels
        #[arg(long, default_value_t = 800)]
        height: u32,
        /// Seconds to wait for workspace state and browser render
        #[arg(long)]
        timeout_seconds: Option<u64>,
    },
    /// Capture a browser screenshot after opening this viewer profile
    Overview {
        /// PNG output path
        output: String,
        /// Browser viewport width in pixels
        #[arg(long, default_value_t = 1200)]
        width: u32,
        /// Browser viewport height in pixels
        #[arg(long, default_value_t = 800)]
        height: u32,
        /// Seconds to wait for workspace state and browser render
        #[arg(long)]
        timeout_seconds: Option<u64>,
    },
}

#[derive(Subcommand, Debug)]
enum PeerCommand {
    /// List live clients in the selected workspace
    List,
    /// Follow another live client
    Follow {
        /// Live client id to follow
        client_id: u64,
    },
    /// Stop following any client
    Unfollow,
    /// Send cursor presence diagnostics for tests
    Cursor {
        #[command(subcommand)]
        command: PeerCursorCommand,
    },
}

#[derive(Subcommand, Debug)]
enum PeerCursorCommand {
    /// Set this client's cursor position
    Set {
        #[arg(long, allow_hyphen_values = true)]
        x: f64,
        #[arg(long, allow_hyphen_values = true)]
        y: f64,
    },
    /// Clear this client's cursor position
    Clear,
}

#[derive(Subcommand, Debug)]
enum PlanCommand {
    /// Show lower-level scene visible/prefetch chunks
    VisibleChunks {
        /// Optional workspace-local dataset id or unambiguous dataset name
        dataset: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum DebugCommand {
    /// Show read-only workspace snapshot and selected viewer state
    State,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum ChannelMode {
    Single,
    Multi,
}

#[derive(Subcommand, Debug)]
enum LayoutCommand {
    /// List available source and registered layouts
    List {
        /// Workspace-local dataset id or unambiguous dataset name
        dataset: Option<String>,
    },
    /// Show the active and effective layout
    Active {
        /// Workspace-local dataset id or unambiguous dataset name
        dataset: Option<String>,
    },
    /// Set the active layout for a dataset
    Set {
        /// Workspace-local dataset id or unambiguous dataset name
        dataset: String,
        /// Layout id or unambiguous layout name
        layout: String,
    },
}

#[derive(Subcommand, Debug)]
enum SavedViewCommand {
    /// List saved views in the selected workspace
    List,
    /// Show a saved view by id or unambiguous name
    Show {
        /// Saved-view id or unambiguous saved-view name
        saved_view: String,
    },
    /// Apply a saved view to the current CLI/browser workspace state
    Apply {
        /// Saved-view id or unambiguous saved-view name
        saved_view: String,
    },
    /// Capture the current workspace state as a saved view
    Capture {
        /// Saved-view name
        name: String,
        /// Capture from an explicit peer's presence instead of this CLI session
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
    },
    /// Rename a saved view
    Rename {
        /// Saved-view id or unambiguous saved-view name
        saved_view: String,
        /// New saved-view name
        name: String,
    },
    /// Replace a saved view with the current workspace state
    Update {
        /// Saved-view id or unambiguous saved-view name
        saved_view: String,
        /// Replace the saved-view payload with the current workspace state
        #[arg(long)]
        from_current: bool,
        /// Capture from an explicit peer's presence instead of this CLI session
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
    },
    /// Delete a saved view
    Delete {
        /// Saved-view id or unambiguous saved-view name
        saved_view: String,
    },
    /// Set the workspace default saved view
    SetDefault {
        /// Saved-view id or unambiguous saved-view name
        saved_view: String,
    },
    /// Clear the workspace default saved view
    ClearDefault,
    /// Print a browser link to a workspace saved view
    Link {
        /// Saved-view id or unambiguous saved-view name
        saved_view: String,
    },
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
                let options = LoginOptions {
                    name,
                    ttl_days: *ttl_days,
                    no_browser: *no_browser,
                    timeout: Duration::from_secs(*timeout_seconds),
                };
                let result =
                    login(cli.server.as_deref(), &mut config, &store, options, &output).await?;
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
            viewer_profile,
            from_peer,
            timeout_seconds,
            command,
        } => {
            emit_viewport_command(
                &cli,
                &config,
                output,
                command.viewport_command()?,
                viewer_profile,
                *from_peer,
                *timeout_seconds,
            )
            .await?;
        }
        Command::Camera {
            viewer_profile,
            from_peer,
            timeout_seconds,
            command,
        } => {
            emit_viewport_command(
                &cli,
                &config,
                output,
                command.viewport_command()?,
                viewer_profile,
                *from_peer,
                *timeout_seconds,
            )
            .await?;
        }
        Command::Layer {
            viewer_profile,
            from_peer,
            timeout_seconds,
            command,
        } => {
            emit_dataset_presence_command(
                &cli,
                &config,
                output,
                command.display_command()?,
                viewer_profile,
                *from_peer,
                *timeout_seconds,
            )
            .await?;
        }
        Command::Channel {
            viewer_profile,
            from_peer,
            timeout_seconds,
            command,
        } => match command.action()? {
            ChannelCommandAction::Viewport(command) => {
                emit_viewport_command(
                    &cli,
                    &config,
                    output,
                    command,
                    viewer_profile,
                    *from_peer,
                    *timeout_seconds,
                )
                .await?;
            }
            ChannelCommandAction::Dataset(command) => {
                emit_dataset_presence_command(
                    &cli,
                    &config,
                    output,
                    Some(command),
                    viewer_profile,
                    *from_peer,
                    *timeout_seconds,
                )
                .await?;
            }
        },
        Command::Viewer {
            profile,
            timeout_seconds,
            command,
        } => {
            emit_viewer_command(&cli, &config, output, command, profile, *timeout_seconds).await?;
        }
        Command::Peer {
            timeout_seconds,
            command,
        } => {
            emit_peer_command(&cli, &config, output, command, *timeout_seconds).await?;
        }
        Command::Plan {
            viewer_profile,
            from_peer,
            timeout_seconds,
            command,
        } => {
            emit_plan_command(
                &cli,
                &config,
                output,
                command,
                viewer_profile,
                *from_peer,
                *timeout_seconds,
            )
            .await?;
        }
        Command::Debug {
            viewer_profile,
            from_peer,
            timeout_seconds,
            command,
        } => {
            emit_debug_command(
                &cli,
                &config,
                output,
                command,
                viewer_profile,
                *from_peer,
                *timeout_seconds,
            )
            .await?;
        }
        Command::Layout {
            timeout_seconds,
            command,
        } => {
            emit_layout_command(&cli, &config, output, command, *timeout_seconds).await?;
        }
        Command::SavedView {
            timeout_seconds,
            command,
        } => {
            emit_saved_view_command(&cli, &config, output, command, *timeout_seconds).await?;
        }
        Command::Admin { command } => {
            emit_admin_command(&cli, &config, output, command).await?;
        }
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

async fn emit_admin_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: &AdminCommand,
) -> Result<(), CliError> {
    let server = resolve_server(cli.server.as_deref(), config)?;
    let token = resolve_token(&server.url, config);
    let client = AdminClient::new(server.url.clone(), token);

    match command {
        AdminCommand::Workspace { command } => match command {
            AdminWorkspaceCommand::Search {
                query,
                include_archived,
                limit,
            } => {
                let workspaces = client
                    .search_workspaces(query.as_deref(), *include_archived, *limit)
                    .await?;
                let output_payload = AdminWorkspaceSearchOutput {
                    scope: REMOTE_ADMIN_SCOPE,
                    server,
                    query: query.clone(),
                    include_archived: *include_archived,
                    limit: *limit,
                    workspaces,
                };
                output.print_either(&output_payload, || {
                    format_admin_workspace_search_human(&output_payload)
                })?;
            }
            AdminWorkspaceCommand::Info { workspace_id } => {
                let details = client.workspace_info(workspace_id).await?;
                let output_payload = AdminWorkspaceDetailsOutput {
                    scope: REMOTE_ADMIN_SCOPE,
                    server,
                    workspace: details.workspace,
                    members: details.members,
                };
                output.print_either(&output_payload, || {
                    format_admin_workspace_details_human(&output_payload, "info")
                })?;
            }
            AdminWorkspaceCommand::Archive { workspace_id } => {
                let details = client.archive_workspace(workspace_id).await?;
                let output_payload = AdminWorkspaceDetailsOutput {
                    scope: REMOTE_ADMIN_SCOPE,
                    server,
                    workspace: details.workspace,
                    members: details.members,
                };
                output.print_either(&output_payload, || {
                    format_admin_workspace_details_human(&output_payload, "archive")
                })?;
            }
            AdminWorkspaceCommand::Restore { workspace_id } => {
                let details = client.restore_workspace(workspace_id).await?;
                let output_payload = AdminWorkspaceDetailsOutput {
                    scope: REMOTE_ADMIN_SCOPE,
                    server,
                    workspace: details.workspace,
                    members: details.members,
                };
                output.print_either(&output_payload, || {
                    format_admin_workspace_details_human(&output_payload, "restore")
                })?;
            }
            AdminWorkspaceCommand::Owner { command } => {
                let (workspace_id, email, display_name) = match command {
                    AdminWorkspaceOwnerCommand::Add {
                        workspace_id,
                        email,
                        display_name,
                    }
                    | AdminWorkspaceOwnerCommand::Promote {
                        workspace_id,
                        email,
                        display_name,
                    } => (workspace_id, email, display_name),
                };
                let member = client
                    .add_or_promote_owner(workspace_id, email, display_name.as_deref())
                    .await?;
                let output_payload = AdminWorkspaceOwnerOutput {
                    scope: REMOTE_ADMIN_SCOPE,
                    server,
                    workspace_id: workspace_id.clone(),
                    member,
                };
                output.print_either(&output_payload, || {
                    format_admin_workspace_owner_human(&output_payload)
                })?;
            }
        },
        AdminCommand::ClearProxyCache { dataset } => {
            let result = client.clear_proxy_cache(dataset.as_deref()).await?;
            let output_payload = AdminClearProxyCacheOutput {
                scope: REMOTE_ADMIN_SCOPE,
                server,
                dataset: dataset.clone(),
                cleared: result.cleared,
                datasets: result.datasets,
                files: result.files,
            };
            output.print_either(&output_payload, || {
                format_admin_clear_proxy_cache_human(&output_payload)
            })?;
        }
    }

    Ok(())
}

async fn emit_saved_view_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: &SavedViewCommand,
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
    let saved_view_client =
        WorkspaceSavedViewClient::new(server.url.clone(), target.ws_url.clone(), token);
    let wait = Duration::from_secs(timeout_seconds);

    match command {
        SavedViewCommand::List => {
            let saved_views = saved_view_client.list(&workspace).await?;
            let default_saved_view_id = workspace.default_saved_view_id.clone();
            let output_payload = SavedViewListOutput {
                server,
                workspace,
                target,
                saved_views: saved_view_summaries(&saved_views, default_saved_view_id.as_deref()),
            };
            output.print_either(&output_payload, || {
                format_saved_view_list_human(&output_payload)
            })?;
        }
        SavedViewCommand::Show { saved_view } => {
            let saved_views = saved_view_client.list(&workspace).await?;
            let resolved = resolve_saved_view_record(saved_view, &saved_views)?;
            let saved_view = saved_view_client.get(&workspace, &resolved.id).await?;
            let output_payload = SavedViewOutput {
                server,
                workspace,
                target,
                saved_view,
            };
            output.print_either(&output_payload, || format_saved_view_human(&output_payload))?;
        }
        SavedViewCommand::Apply { saved_view } => {
            let saved_views = saved_view_client.list(&workspace).await?;
            let resolved = resolve_saved_view_record(saved_view, &saved_views)?;
            let saved_view = saved_view_client.get(&workspace, &resolved.id).await?;
            let default_saved_view_id = workspace.default_saved_view_id.clone();
            let summary = saved_view_summary(&saved_view, default_saved_view_id.as_deref());
            let result = saved_view_client
                .apply(&workspace, &saved_view.view, wait)
                .await?;
            let output_payload = SavedViewApplyOutput {
                server,
                workspace,
                target,
                saved_view: summary,
                result,
            };
            output.print_either(&output_payload, || {
                format_saved_view_apply_human(&output_payload)
            })?;
        }
        SavedViewCommand::Capture { name, from_peer } => {
            let (source, view) = saved_view_client.capture(*from_peer, wait).await?;
            let saved_view = saved_view_client.create(&workspace, name, &view).await?;
            let output_payload = SavedViewCaptureOutput {
                server,
                workspace,
                target,
                source,
                saved_view,
            };
            output.print_either(&output_payload, || {
                format_saved_view_capture_human(&output_payload)
            })?;
        }
        SavedViewCommand::Rename { saved_view, name } => {
            let saved_views = saved_view_client.list(&workspace).await?;
            let resolved = resolve_saved_view_record(saved_view, &saved_views)?;
            let saved_view = saved_view_client
                .rename(&workspace, &resolved.id, name)
                .await?;
            let output_payload = SavedViewOutput {
                server,
                workspace,
                target,
                saved_view,
            };
            output.print_either(&output_payload, || format_saved_view_human(&output_payload))?;
        }
        SavedViewCommand::Update {
            saved_view,
            from_current,
            from_peer,
        } => {
            if !from_current {
                return Err(CliError::config(
                    "saved-view update currently requires --from-current",
                ));
            }
            let saved_views = saved_view_client.list(&workspace).await?;
            let resolved = resolve_saved_view_record(saved_view, &saved_views)?;
            let (_source, view) = saved_view_client.capture(*from_peer, wait).await?;
            let saved_view = saved_view_client
                .update_view(&workspace, &resolved.id, &view)
                .await?;
            let output_payload = SavedViewOutput {
                server,
                workspace,
                target,
                saved_view,
            };
            output.print_either(&output_payload, || format_saved_view_human(&output_payload))?;
        }
        SavedViewCommand::Delete { saved_view } => {
            let saved_views = saved_view_client.list(&workspace).await?;
            let resolved = resolve_saved_view_record(saved_view, &saved_views)?;
            let default_saved_view_id = workspace.default_saved_view_id.clone();
            let deleted = saved_view_summary(&resolved, default_saved_view_id.as_deref());
            saved_view_client.delete(&workspace, &resolved.id).await?;
            let output_payload = SavedViewDeleteOutput {
                server,
                workspace,
                target,
                deleted,
            };
            output.print_either(&output_payload, || {
                format_saved_view_delete_human(&output_payload)
            })?;
        }
        SavedViewCommand::SetDefault { saved_view } => {
            let saved_views = saved_view_client.list(&workspace).await?;
            let resolved = resolve_saved_view_record(saved_view, &saved_views)?;
            let workspace = saved_view_client
                .set_default(&workspace, Some(&resolved.id))
                .await?;
            let default_saved_view_id = workspace.default_saved_view_id.clone();
            let output_payload = SavedViewDefaultOutput {
                server,
                workspace,
                target,
                default_saved_view_id,
            };
            output.print_either(&output_payload, || {
                format_saved_view_default_human(&output_payload)
            })?;
        }
        SavedViewCommand::ClearDefault => {
            let workspace = saved_view_client.set_default(&workspace, None).await?;
            let default_saved_view_id = workspace.default_saved_view_id.clone();
            let output_payload = SavedViewDefaultOutput {
                server,
                workspace,
                target,
                default_saved_view_id,
            };
            output.print_either(&output_payload, || {
                format_saved_view_default_human(&output_payload)
            })?;
        }
        SavedViewCommand::Link { saved_view } => {
            let saved_views = saved_view_client.list(&workspace).await?;
            let resolved = resolve_saved_view_record(saved_view, &saved_views)?;
            let default_saved_view_id = workspace.default_saved_view_id.clone();
            let saved_view = saved_view_summary(&resolved, default_saved_view_id.as_deref());
            let url = saved_view_link(&target, &resolved.id)?;
            let output_payload = SavedViewLinkOutput {
                server,
                workspace,
                target,
                saved_view,
                url,
            };
            output.print_either(&output_payload, || {
                format_saved_view_link_human(&output_payload)
            })?;
        }
    }

    Ok(())
}

async fn emit_viewport_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: ViewportCommand,
    viewer_profile: &str,
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
    if let Some(from_peer) = from_peer {
        let view_client = ViewWorkspaceClient::new(target.ws_url.clone(), token);
        let result = view_client
            .apply(
                command,
                Some(from_peer),
                Duration::from_secs(timeout_seconds),
            )
            .await?;
        let output_payload = ViewApplyOutput {
            server,
            workspace,
            target,
            result,
        };
        output.print_either(&output_payload, || format_view_apply_human(&output_payload))?;
    } else {
        let view_client =
            ViewerProfileClient::new(server.url.clone(), target.ws_url.clone(), token);
        let result = view_client
            .apply(
                &workspace,
                viewer_profile,
                command,
                Duration::from_secs(timeout_seconds),
            )
            .await?;
        let output_payload = ViewerProfileOutput {
            server,
            workspace,
            target,
            result,
        };
        output.print_either(&output_payload, || {
            format_viewer_profile_human(&output_payload)
        })?;
    }
    Ok(())
}

async fn emit_dataset_presence_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: Option<DatasetDisplayCommand>,
    viewer_profile: &str,
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
    if from_peer.is_some() {
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
    } else {
        let view_client =
            ViewerProfileClient::new(server.url.clone(), target.ws_url.clone(), token);
        let result = if let Some(command) = command {
            view_client
                .apply_dataset(
                    &workspace,
                    viewer_profile,
                    command,
                    Duration::from_secs(timeout_seconds),
                )
                .await?
        } else {
            view_client
                .dataset_state(
                    &workspace,
                    viewer_profile,
                    Duration::from_secs(timeout_seconds),
                )
                .await?
        };
        let output_payload = ViewerProfileOutput {
            server,
            workspace,
            target,
            result,
        };
        output.print_either(&output_payload, || {
            format_viewer_profile_human(&output_payload)
        })?;
    }
    Ok(())
}

async fn emit_viewer_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: &ViewerCommand,
    profile: &str,
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
    let wait = Duration::from_secs(timeout_seconds);
    let view_client =
        ViewerProfileClient::new(server.url.clone(), target.ws_url.clone(), token.clone());

    match command {
        ViewerCommand::State => {
            let result = view_client.state(&workspace, profile, wait).await?;
            let output_payload = ViewerProfileOutput {
                server,
                workspace,
                target,
                result,
            };
            output.print_either(&output_payload, || {
                format_viewer_profile_human(&output_payload)
            })?;
        }
        ViewerCommand::Link => {
            let result = view_client.state(&workspace, profile, wait).await?;
            let url = viewer_profile_web_url(&target, profile)?;
            let payload = serde_json::json!({
                "server": server,
                "workspace": workspace,
                "target": target,
                "profile": result.profile,
                "url": url,
            });
            output.print_either(&payload, || url)?;
        }
        ViewerCommand::Screenshot {
            output: output_path,
            width,
            height,
            timeout_seconds: screenshot_timeout_seconds,
        } => {
            let wait = Duration::from_secs(screenshot_timeout_seconds.unwrap_or(timeout_seconds));
            let result = view_client.state(&workspace, profile, wait).await?;
            let url = viewer_profile_web_url(&target, profile)?;
            capture_viewer_screenshot(&url, token.as_ref(), output_path, *width, *height, wait)
                .await?;
            let payload = serde_json::json!({
                "server": server,
                "workspace": workspace,
                "target": target,
                "profile": result.profile,
                "url": url,
                "output": output_path,
                "width": width,
                "height": height,
            });
            output.print_either(&payload, || {
                format!("Captured viewer screenshot: {output_path}\nURL: {url}")
            })?;
        }
        ViewerCommand::Overview {
            output: output_path,
            width,
            height,
            timeout_seconds: screenshot_timeout_seconds,
        } => {
            let wait = Duration::from_secs(screenshot_timeout_seconds.unwrap_or(timeout_seconds));
            let result = view_client
                .overview(&workspace, profile, [*width, *height], wait)
                .await?;
            let url = viewer_profile_web_url(&target, profile)?;
            capture_viewer_screenshot(&url, token.as_ref(), output_path, *width, *height, wait)
                .await?;
            let payload = serde_json::json!({
                "server": server,
                "workspace": workspace,
                "target": target,
                "profile": result.profile,
                "url": url,
                "output": output_path,
                "width": width,
                "height": height,
            });
            output.print_either(&payload, || {
                format!("Captured viewer overview: {output_path}\nURL: {url}")
            })?;
        }
    }

    Ok(())
}

async fn emit_peer_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: &PeerCommand,
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
    let wait = Duration::from_secs(timeout_seconds);
    let peer_client = PeerWorkspaceClient::new(target.ws_url.clone(), token);

    match command {
        PeerCommand::List => {
            let result = peer_client.list(wait).await?;
            let output_payload = PeerListOutput {
                server,
                workspace,
                target,
                result,
            };
            output.print_either(&output_payload, || format_peer_list_human(&output_payload))?;
        }
        PeerCommand::Follow { client_id } => {
            let result = peer_client.follow(*client_id, wait).await?;
            let output_payload = PeerFollowOutput {
                server,
                workspace,
                target,
                result,
            };
            output.print_either(&output_payload, || {
                format_peer_follow_human(&output_payload)
            })?;
        }
        PeerCommand::Unfollow => {
            let result = peer_client.unfollow(wait).await?;
            let output_payload = PeerFollowOutput {
                server,
                workspace,
                target,
                result,
            };
            output.print_either(&output_payload, || {
                format_peer_follow_human(&output_payload)
            })?;
        }
        PeerCommand::Cursor { command } => {
            let position = match command {
                PeerCursorCommand::Set { x, y } => Some([*x, *y]),
                PeerCursorCommand::Clear => None,
            };
            let result = peer_client.cursor(position, wait).await?;
            let output_payload = PeerCursorOutput {
                server,
                workspace,
                target,
                result,
            };
            output.print_either(&output_payload, || {
                format_peer_cursor_human(&output_payload)
            })?;
        }
    }

    Ok(())
}

async fn emit_plan_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: &PlanCommand,
    viewer_profile: &str,
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
    let wait = Duration::from_secs(timeout_seconds);
    let view_client = ViewerProfileClient::new(server.url.clone(), target.ws_url.clone(), token);

    match command {
        PlanCommand::VisibleChunks { dataset } => {
            let result = view_client
                .plan_visible_chunks(
                    &workspace,
                    viewer_profile,
                    from_peer,
                    dataset.as_deref(),
                    wait,
                )
                .await?;
            let output_payload = PlanVisibleChunksOutput {
                server,
                workspace,
                target,
                result,
            };
            output.print_either(&output_payload, || {
                format_plan_visible_chunks_human(&output_payload)
            })?;
        }
    }

    Ok(())
}

async fn emit_debug_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: &DebugCommand,
    viewer_profile: &str,
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
    let wait = Duration::from_secs(timeout_seconds);
    let view_client = ViewerProfileClient::new(server.url.clone(), target.ws_url.clone(), token);

    match command {
        DebugCommand::State => {
            let result = view_client
                .debug_state(&workspace, viewer_profile, from_peer, wait)
                .await?;
            let output_payload = DebugStateOutput {
                server,
                workspace,
                target,
                result,
            };
            output.print_either(&output_payload, || {
                format_debug_state_human(&output_payload)
            })?;
        }
    }

    Ok(())
}

fn viewer_profile_web_url(target: &WorkspaceTarget, profile: &str) -> Result<String, CliError> {
    let mut url = reqwest::Url::parse(&target.web_url)
        .map_err(|error| CliError::invalid_server(format!("invalid workspace URL: {error}")))?;
    url.query_pairs_mut().append_pair("viewer_profile", profile);
    Ok(url.to_string())
}

async fn capture_viewer_screenshot(
    url: &str,
    token: Option<&EffectiveToken>,
    output_path: &str,
    width: u32,
    height: u32,
    wait: Duration,
) -> Result<(), CliError> {
    if width == 0 || height == 0 {
        return Err(CliError::config(
            "viewer screenshot width and height must be positive",
        ));
    }

    let browser = find_browser_binary()?;
    let user_data_dir = chrome_user_data_dir();
    tokio::fs::create_dir_all(&user_data_dir).await?;
    let mut child = TokioCommand::new(&browser)
        .arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", user_data_dir.display()))
        .arg(format!("--window-size={width},{height}"))
        .arg("about:blank")
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|error| {
            CliError::new(
                ErrorKind::Config,
                format!("failed to launch browser {browser:?}: {error}"),
            )
        })?;

    let result = async {
        let stderr = child.stderr.take().ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "browser stderr was not available for DevTools discovery",
            )
        })?;
        let endpoint = wait_for_devtools_endpoint(stderr, wait).await?;
        let png = capture_cdp_png(&endpoint, url, token, width, height, wait).await?;
        if let Some(parent) = Path::new(output_path).parent()
            && !parent.as_os_str().is_empty()
        {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(output_path, png).await?;
        Ok::<(), CliError>(())
    }
    .await;

    let _ = child.kill().await;
    let _ = child.wait().await;
    let _ = tokio::fs::remove_dir_all(&user_data_dir).await;
    result
}

fn find_browser_binary() -> Result<String, CliError> {
    if let Some(path) = std::env::var_os("LUCIDA_BROWSER") {
        let path = path.to_string_lossy().to_string();
        if Path::new(&path).exists() {
            return Ok(path);
        }
        return Err(CliError::new(
            ErrorKind::Config,
            format!("LUCIDA_BROWSER points to a missing executable: {path}"),
        ));
    }

    let absolute_candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    for candidate in absolute_candidates {
        if Path::new(candidate).exists() {
            return Ok(candidate.to_string());
        }
    }

    let path_candidates = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "msedge",
    ];
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for candidate in path_candidates {
                let executable = dir.join(candidate);
                if executable.is_file() {
                    return Ok(executable.to_string_lossy().to_string());
                }
            }
        }
    }

    Err(CliError::new(
        ErrorKind::Config,
        "could not find Chrome/Chromium; set LUCIDA_BROWSER to a browser executable",
    ))
}

fn chrome_user_data_dir() -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("lucida-cli-chrome-{}-{nanos}", std::process::id()))
}

async fn wait_for_devtools_endpoint<R>(stderr: R, wait: Duration) -> Result<String, CliError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stderr).lines();
    tokio::time::timeout(wait, async {
        while let Some(line) = lines.next_line().await? {
            if let Some(endpoint) = line
                .strip_prefix("DevTools listening on ")
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Ok(endpoint.to_string());
            }
        }
        Err(CliError::new(
            ErrorKind::Protocol,
            "browser exited before printing a DevTools endpoint",
        ))
    })
    .await
    .map_err(|_| {
        CliError::new(
            ErrorKind::SessionDisconnect,
            format!(
                "timed out waiting for browser DevTools endpoint after {}s",
                wait.as_secs()
            ),
        )
    })?
}

async fn capture_cdp_png(
    browser_ws_url: &str,
    url: &str,
    token: Option<&EffectiveToken>,
    width: u32,
    height: u32,
    wait: Duration,
) -> Result<Vec<u8>, CliError> {
    let (socket, _response) = connect_async(browser_ws_url)
        .await
        .map_err(|error| CliError::new(ErrorKind::SessionDisconnect, error.to_string()))?;
    let (mut write, mut read) = socket.split();
    let mut id = 1_u64;

    let created = cdp_call(
        &mut write,
        &mut read,
        &mut id,
        None,
        "Target.createTarget",
        json!({ "url": "about:blank" }),
        wait,
    )
    .await?;
    let target_id = created
        .get("targetId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP targetId was missing"))?
        .to_string();
    let attached = cdp_call(
        &mut write,
        &mut read,
        &mut id,
        None,
        "Target.attachToTarget",
        json!({ "targetId": target_id, "flatten": true }),
        wait,
    )
    .await?;
    let session_id = attached
        .get("sessionId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP sessionId was missing"))?
        .to_string();

    cdp_call(
        &mut write,
        &mut read,
        &mut id,
        Some(&session_id),
        "Network.enable",
        json!({}),
        wait,
    )
    .await?;
    if let Some(token) = token {
        cdp_call(
            &mut write,
            &mut read,
            &mut id,
            Some(&session_id),
            "Network.setExtraHTTPHeaders",
            json!({ "headers": { "Authorization": format!("Bearer {}", token.token) } }),
            wait,
        )
        .await?;
    }
    cdp_call(
        &mut write,
        &mut read,
        &mut id,
        Some(&session_id),
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": width,
            "height": height,
            "deviceScaleFactor": 1,
            "mobile": false
        }),
        wait,
    )
    .await?;
    cdp_call(
        &mut write,
        &mut read,
        &mut id,
        Some(&session_id),
        "Page.enable",
        json!({}),
        wait,
    )
    .await?;
    cdp_call(
        &mut write,
        &mut read,
        &mut id,
        Some(&session_id),
        "Page.navigate",
        json!({ "url": url }),
        wait,
    )
    .await?;
    wait_for_page_ready(&mut write, &mut read, &mut id, &session_id, wait).await?;
    let captured = cdp_call(
        &mut write,
        &mut read,
        &mut id,
        Some(&session_id),
        "Page.captureScreenshot",
        json!({ "format": "png", "fromSurface": true }),
        wait,
    )
    .await?;
    let data = captured
        .get("data")
        .and_then(|value| value.as_str())
        .ok_or_else(|| CliError::new(ErrorKind::Protocol, "CDP screenshot data was missing"))?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| CliError::new(ErrorKind::Protocol, format!("invalid PNG data: {error}")))
}

async fn wait_for_page_ready<W, S>(
    write: &mut W,
    read: &mut S,
    id: &mut u64,
    session_id: &str,
    wait: Duration,
) -> Result<(), CliError>
where
    W: Sink<Message, Error = WebSocketError> + Unpin,
    S: Stream<Item = Result<Message, WebSocketError>> + Unpin,
{
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let ready = cdp_call(
            write,
            read,
            id,
            Some(session_id),
            "Runtime.evaluate",
            json!({
                "expression": "document.readyState === 'complete' && !!document.querySelector('canvas')",
                "returnByValue": true
            }),
            wait,
        )
        .await?;
        if ready
            .get("result")
            .and_then(|value| value.get("value"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            tokio::time::sleep(Duration::from_millis(500)).await;
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(CliError::new(
                ErrorKind::SessionDisconnect,
                format!(
                    "timed out waiting for viewer canvas after {}s",
                    wait.as_secs()
                ),
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn cdp_call<W, S>(
    write: &mut W,
    read: &mut S,
    id: &mut u64,
    session_id: Option<&str>,
    method: &str,
    params: Value,
    wait: Duration,
) -> Result<Value, CliError>
where
    W: Sink<Message, Error = WebSocketError> + Unpin,
    S: Stream<Item = Result<Message, WebSocketError>> + Unpin,
{
    let request_id = *id;
    *id += 1;
    let mut message = json!({
        "id": request_id,
        "method": method,
        "params": params,
    });
    if let Some(session_id) = session_id {
        message["sessionId"] = json!(session_id);
    }
    write
        .send(Message::Text(message.to_string().into()))
        .await
        .map_err(|error| CliError::new(ErrorKind::SessionDisconnect, error.to_string()))?;

    tokio::time::timeout(wait, async {
        while let Some(message) = read.next().await {
            let Message::Text(text) = message
                .map_err(|error| CliError::new(ErrorKind::SessionDisconnect, error.to_string()))?
            else {
                continue;
            };
            let value: Value = serde_json::from_str(&text).map_err(|error| {
                CliError::new(ErrorKind::Protocol, format!("invalid CDP message: {error}"))
            })?;
            if value.get("id").and_then(|value| value.as_u64()) != Some(request_id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(CliError::new(
                    ErrorKind::Protocol,
                    format!("CDP {method} failed: {error}"),
                ));
            }
            return Ok(value.get("result").cloned().unwrap_or_else(|| json!({})));
        }
        Err(CliError::new(
            ErrorKind::SessionDisconnect,
            "browser DevTools connection closed",
        ))
    })
    .await
    .map_err(|_| {
        CliError::new(
            ErrorKind::SessionDisconnect,
            format!(
                "timed out waiting for CDP {method} after {}s",
                wait.as_secs()
            ),
        )
    })?
}

async fn emit_layout_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    command: &LayoutCommand,
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
    let layout_client = LayoutWorkspaceClient::new(target.ws_url.clone(), token);
    match command {
        LayoutCommand::List { dataset } => {
            let (seq, datasets) = layout_client
                .list(dataset.as_deref(), Duration::from_secs(timeout_seconds))
                .await?;
            let output_payload = LayoutListOutput {
                server,
                workspace,
                target,
                seq,
                datasets,
            };
            output.print_either(&output_payload, || {
                format_layout_list_human(&output_payload)
            })?;
        }
        LayoutCommand::Active { dataset } => {
            let (seq, datasets) = layout_client
                .active(dataset.as_deref(), Duration::from_secs(timeout_seconds))
                .await?;
            let output_payload = LayoutActiveOutput {
                server,
                workspace,
                target,
                seq,
                datasets,
            };
            output.print_either(&output_payload, || {
                format_layout_active_human(&output_payload)
            })?;
        }
        LayoutCommand::Set { dataset, layout } => {
            let (seq, requested_layout_id, warning, dataset_state) = layout_client
                .set(
                    dataset,
                    layout,
                    &workspace,
                    Duration::from_secs(timeout_seconds),
                )
                .await?;
            let output_payload = LayoutSetOutput {
                server,
                workspace,
                target,
                seq,
                requested_layout_id,
                warning,
                dataset: dataset_state,
            };
            output.print_either(&output_payload, || format_layout_set_human(&output_payload))?;
        }
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

struct LoginOptions<'a> {
    name: &'a str,
    ttl_days: u64,
    no_browser: bool,
    timeout: Duration,
}

async fn login(
    server_override: Option<&str>,
    config: &mut CliConfig,
    store: &ConfigStore,
    options: LoginOptions<'_>,
    output: &Output,
) -> Result<LoginResult, CliError> {
    let server = resolve_server(server_override, config)?;
    let client = AuthClient::new(server.url.clone());
    let raw_token = generate_raw_token();
    let ttl_seconds = options.ttl_days.saturating_mul(24 * 60 * 60);
    let start = client
        .start_login(options.name, &raw_token, Some(ttl_seconds))
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
    if !options.no_browser {
        let _ = open_browser(&approval_url);
    }

    let deadline = tokio::time::Instant::now() + options.timeout;
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
        assert!(help.contains("peer"));
        assert!(help.contains("plan"));
        assert!(help.contains("debug"));
        assert!(help.contains("layout"));
        assert!(help.contains("saved-view"));
        assert!(help.contains("admin"));
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
    fn admin_workspace_search_parses_remote_admin_shape() {
        let cli = parse(&[
            "admin",
            "workspace",
            "search",
            "owner@example.com",
            "--include-archived",
            "--limit",
            "12",
        ]);

        match cli.command {
            Command::Admin {
                command:
                    AdminCommand::Workspace {
                        command:
                            AdminWorkspaceCommand::Search {
                                query,
                                include_archived,
                                limit,
                            },
                    },
            } => {
                assert_eq!(query.as_deref(), Some("owner@example.com"));
                assert!(include_archived);
                assert_eq!(limit, 12);
            }
            _ => panic!("expected admin workspace search"),
        }
    }

    #[test]
    fn admin_workspace_mutations_parse_id_based_shape() {
        let info = parse(&["admin", "workspace", "info", "w1"]);
        match info.command {
            Command::Admin {
                command:
                    AdminCommand::Workspace {
                        command: AdminWorkspaceCommand::Info { workspace_id },
                    },
            } => assert_eq!(workspace_id, "w1"),
            _ => panic!("expected admin workspace info"),
        }

        let archive = parse(&["admin", "workspace", "archive", "w1"]);
        match archive.command {
            Command::Admin {
                command:
                    AdminCommand::Workspace {
                        command: AdminWorkspaceCommand::Archive { workspace_id },
                    },
            } => assert_eq!(workspace_id, "w1"),
            _ => panic!("expected admin workspace archive"),
        }

        let restore = parse(&["admin", "workspace", "restore", "w1"]);
        match restore.command {
            Command::Admin {
                command:
                    AdminCommand::Workspace {
                        command: AdminWorkspaceCommand::Restore { workspace_id },
                    },
            } => assert_eq!(workspace_id, "w1"),
            _ => panic!("expected admin workspace restore"),
        }
    }

    #[test]
    fn admin_workspace_owner_and_cache_commands_parse() {
        let owner = parse(&[
            "admin",
            "workspace",
            "owner",
            "add",
            "w1",
            "owner@example.com",
            "--display-name",
            "Owner",
        ]);
        match owner.command {
            Command::Admin {
                command:
                    AdminCommand::Workspace {
                        command:
                            AdminWorkspaceCommand::Owner {
                                command:
                                    AdminWorkspaceOwnerCommand::Add {
                                        workspace_id,
                                        email,
                                        display_name,
                                    },
                            },
                    },
            } => {
                assert_eq!(workspace_id, "w1");
                assert_eq!(email, "owner@example.com");
                assert_eq!(display_name.as_deref(), Some("Owner"));
            }
            _ => panic!("expected admin workspace owner add"),
        }

        let promote = parse(&[
            "admin",
            "workspace",
            "owner",
            "promote",
            "w1",
            "owner@example.com",
        ]);
        assert!(matches!(
            promote.command,
            Command::Admin {
                command: AdminCommand::Workspace {
                    command: AdminWorkspaceCommand::Owner {
                        command: AdminWorkspaceOwnerCommand::Promote { .. },
                    },
                },
            }
        ));

        let clear = parse(&[
            "admin",
            "clear-proxy-cache",
            "--dataset",
            "file:///data/demo.ome.zarr",
        ]);
        match clear.command {
            Command::Admin {
                command: AdminCommand::ClearProxyCache { dataset },
            } => assert_eq!(dataset.as_deref(), Some("file:///data/demo.ome.zarr")),
            _ => panic!("expected admin clear-proxy-cache"),
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
                viewer_profile,
                from_peer,
                timeout_seconds,
                command,
            } => {
                assert_eq!(viewer_profile, "default");
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
    fn layout_commands_parse_product_shape() {
        let list = parse(&["layout", "--timeout-seconds", "9", "list", "demo.zarr"]);
        match list.command {
            Command::Layout {
                timeout_seconds,
                command,
            } => {
                assert_eq!(timeout_seconds, 9);
                match command {
                    LayoutCommand::List { dataset } => {
                        assert_eq!(dataset.as_deref(), Some("demo.zarr"));
                    }
                    _ => panic!("expected layout list"),
                }
            }
            _ => panic!("expected layout list"),
        }

        let active = parse(&["layout", "active"]);
        match active.command {
            Command::Layout {
                command: LayoutCommand::Active { dataset },
                ..
            } => assert!(dataset.is_none()),
            _ => panic!("expected layout active"),
        }

        let set = parse(&["layout", "set", "wds-test", "layout-source"]);
        match set.command {
            Command::Layout {
                command: LayoutCommand::Set { dataset, layout },
                ..
            } => {
                assert_eq!(dataset, "wds-test");
                assert_eq!(layout, "layout-source");
            }
            _ => panic!("expected layout set"),
        }
    }

    #[test]
    fn saved_view_commands_parse_product_shape() {
        let list = parse(&["saved-view", "--timeout-seconds", "9", "list"]);
        match list.command {
            Command::SavedView {
                timeout_seconds,
                command: SavedViewCommand::List,
            } => assert_eq!(timeout_seconds, 9),
            _ => panic!("expected saved-view list"),
        }

        let show = parse(&["saved-view", "show", "sv-1"]);
        match show.command {
            Command::SavedView {
                command: SavedViewCommand::Show { saved_view },
                ..
            } => assert_eq!(saved_view, "sv-1"),
            _ => panic!("expected saved-view show"),
        }

        let apply = parse(&["saved-view", "apply", "Nice view"]);
        match apply.command {
            Command::SavedView {
                command: SavedViewCommand::Apply { saved_view },
                ..
            } => assert_eq!(saved_view, "Nice view"),
            _ => panic!("expected saved-view apply"),
        }

        let capture = parse(&["saved-view", "capture", "Current", "--from-peer", "7"]);
        match capture.command {
            Command::SavedView {
                command: SavedViewCommand::Capture { name, from_peer },
                ..
            } => {
                assert_eq!(name, "Current");
                assert_eq!(from_peer, Some(7));
            }
            _ => panic!("expected saved-view capture"),
        }

        let rename = parse(&["saved-view", "rename", "sv-1", "Renamed"]);
        match rename.command {
            Command::SavedView {
                command: SavedViewCommand::Rename { saved_view, name },
                ..
            } => {
                assert_eq!(saved_view, "sv-1");
                assert_eq!(name, "Renamed");
            }
            _ => panic!("expected saved-view rename"),
        }

        let update = parse(&[
            "saved-view",
            "update",
            "sv-1",
            "--from-current",
            "--from-peer",
            "8",
        ]);
        match update.command {
            Command::SavedView {
                command:
                    SavedViewCommand::Update {
                        saved_view,
                        from_current,
                        from_peer,
                    },
                ..
            } => {
                assert_eq!(saved_view, "sv-1");
                assert!(from_current);
                assert_eq!(from_peer, Some(8));
            }
            _ => panic!("expected saved-view update"),
        }

        let delete = parse(&["saved-view", "delete", "sv-1"]);
        match delete.command {
            Command::SavedView {
                command: SavedViewCommand::Delete { saved_view },
                ..
            } => assert_eq!(saved_view, "sv-1"),
            _ => panic!("expected saved-view delete"),
        }

        let set_default = parse(&["saved-view", "set-default", "sv-1"]);
        match set_default.command {
            Command::SavedView {
                command: SavedViewCommand::SetDefault { saved_view },
                ..
            } => assert_eq!(saved_view, "sv-1"),
            _ => panic!("expected saved-view set-default"),
        }

        let clear_default = parse(&["saved-view", "clear-default"]);
        assert!(matches!(
            clear_default.command,
            Command::SavedView {
                command: SavedViewCommand::ClearDefault,
                ..
            }
        ));

        let link = parse(&["saved-view", "link", "sv-1"]);
        match link.command {
            Command::SavedView {
                command: SavedViewCommand::Link { saved_view },
                ..
            } => assert_eq!(saved_view, "sv-1"),
            _ => panic!("expected saved-view link"),
        }
    }

    #[test]
    fn viewer_commands_parse_product_shape() {
        let state = parse(&["viewer", "--profile", "cli.default", "state"]);
        match state.command {
            Command::Viewer {
                profile,
                timeout_seconds,
                command: ViewerCommand::State,
            } => {
                assert_eq!(profile, "cli.default");
                assert_eq!(timeout_seconds, 30);
            }
            _ => panic!("expected viewer state"),
        }

        let screenshot = parse(&[
            "viewer",
            "screenshot",
            "/tmp/view.png",
            "--width",
            "900",
            "--height",
            "700",
            "--timeout-seconds",
            "60",
        ]);
        match screenshot.command {
            Command::Viewer {
                command:
                    ViewerCommand::Screenshot {
                        output,
                        width,
                        height,
                        timeout_seconds,
                    },
                ..
            } => {
                assert_eq!(output, "/tmp/view.png");
                assert_eq!(width, 900);
                assert_eq!(height, 700);
                assert_eq!(timeout_seconds, Some(60));
            }
            _ => panic!("expected viewer screenshot"),
        }
    }

    #[test]
    fn peer_commands_parse_product_shape() {
        let list = parse(&["peer", "--timeout-seconds", "9", "list"]);
        match list.command {
            Command::Peer {
                timeout_seconds,
                command: PeerCommand::List,
            } => assert_eq!(timeout_seconds, 9),
            _ => panic!("expected peer list"),
        }

        let follow = parse(&["peer", "follow", "42"]);
        match follow.command {
            Command::Peer {
                command: PeerCommand::Follow { client_id },
                ..
            } => assert_eq!(client_id, 42),
            _ => panic!("expected peer follow"),
        }

        let unfollow = parse(&["peer", "unfollow"]);
        assert!(matches!(
            unfollow.command,
            Command::Peer {
                command: PeerCommand::Unfollow,
                ..
            }
        ));

        let cursor_set = parse(&["peer", "cursor", "set", "--x", "-1.5", "--y", "2.25"]);
        match cursor_set.command {
            Command::Peer {
                command:
                    PeerCommand::Cursor {
                        command: PeerCursorCommand::Set { x, y },
                    },
                ..
            } => {
                assert_eq!(x, -1.5);
                assert_eq!(y, 2.25);
            }
            _ => panic!("expected peer cursor set"),
        }

        let cursor_clear = parse(&["peer", "cursor", "clear"]);
        assert!(matches!(
            cursor_clear.command,
            Command::Peer {
                command: PeerCommand::Cursor {
                    command: PeerCursorCommand::Clear
                },
                ..
            }
        ));
    }

    #[test]
    fn plan_and_debug_commands_parse_product_shape() {
        let plan = parse(&[
            "plan",
            "--viewer-profile",
            "analysis",
            "--from-peer",
            "7",
            "--timeout-seconds",
            "9",
            "visible-chunks",
            "demo.zarr",
        ]);
        match plan.command {
            Command::Plan {
                viewer_profile,
                from_peer,
                timeout_seconds,
                command: PlanCommand::VisibleChunks { dataset },
            } => {
                assert_eq!(viewer_profile, "analysis");
                assert_eq!(from_peer, Some(7));
                assert_eq!(timeout_seconds, 9);
                assert_eq!(dataset.as_deref(), Some("demo.zarr"));
            }
            _ => panic!("expected plan visible-chunks"),
        }

        let debug = parse(&["debug", "--viewer-profile", "analysis", "state"]);
        match debug.command {
            Command::Debug {
                viewer_profile,
                from_peer,
                timeout_seconds,
                command: DebugCommand::State,
            } => {
                assert_eq!(viewer_profile, "analysis");
                assert_eq!(from_peer, None);
                assert_eq!(timeout_seconds, 30);
            }
            _ => panic!("expected debug state"),
        }
    }

    #[test]
    fn flat_open_command_is_not_accepted() {
        assert!(try_parse(&["open", "/tmp/data.ome.zarr"]).is_err());
        assert!(try_parse(&["visible-chunks"]).is_err());
    }

    #[test]
    fn removed_steer_and_peer_flags_are_not_accepted() {
        assert!(try_parse(&["--steer", "1", "status"]).is_err());
        assert!(try_parse(&["--peer", "1", "status"]).is_err());
        assert!(try_parse(&["config", "set", "workspace", "w1"]).is_err());
    }
}
