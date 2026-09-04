mod admin;
mod auth;
mod browser;
mod config;
mod credentials;
mod dataset;
mod error;
mod http;
mod layout;
mod montage;
mod output;
mod saved_view;
mod session;
mod status;
mod trace;
mod view;
mod workspace;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use clap::{Parser, Subcommand, ValueEnum};
use flate2::Compression;
use flate2::write::GzEncoder;
use lucida_core::command::ViewportCommand;
use lucida_core::saved_view::{SavedView, normalize_dataset_url};
use lucida_core::scene::{BlendMode, Colormap, RenderMode};
use lucida_core::view_transform::{ExplorationSidecar, ViewExtent, default_view};
use lucida_protocol::DatasetSourceHealth;
use serde_json::Value;

use crate::admin::{
    AdminClearProxyCacheOutput, AdminClient, AdminWorkspaceDetailsOutput,
    AdminWorkspaceOwnerOutput, AdminWorkspaceSearchOutput, REMOTE_ADMIN_SCOPE,
    format_admin_clear_proxy_cache_human, format_admin_workspace_details_human,
    format_admin_workspace_owner_human, format_admin_workspace_search_human,
};
use crate::auth::{
    AuthClient, LoginResult, PollOutcome, generate_raw_token, open_browser, poll_interval,
};
use crate::browser::Viewport;
use crate::config::{
    CliConfig, ConfigStore, EffectiveServer, normalize_server_base_url, resolve_server,
};
use crate::credentials::{EffectiveToken, clear_local_token, resolve_token, store_local_token};
use crate::dataset::{
    DatasetBrowseOutput, DatasetHealthOutput, DatasetHttpClient, DatasetInfoOutput,
    DatasetListOutput, DatasetOpenClient, DatasetOpenOutput, DatasetRemoveOutput,
    DatasetRetryOutput, DatasetWorkspaceClient, format_dataset_browse_human,
    format_dataset_health_human, format_dataset_info_human, format_dataset_list_human,
    format_dataset_open_human, format_dataset_remove_human, format_dataset_retry_human,
};

use crate::error::{CliError, ErrorKind};
use crate::layout::{
    LayoutActiveOutput, LayoutListOutput, LayoutSetOutput, LayoutWorkspaceClient,
    format_layout_active_human, format_layout_list_human, format_layout_set_human,
};
use crate::output::Output;
use crate::saved_view::{
    SavedViewApplyOutput, SavedViewCaptureOutput, SavedViewDefaultOutput, SavedViewDeleteOutput,
    SavedViewLinkOutput, SavedViewListOutput, SavedViewOutput, SavedViewVisibility,
    WorkspaceSavedViewClient, format_saved_view_apply_human, format_saved_view_capture_human,
    format_saved_view_default_human, format_saved_view_delete_human, format_saved_view_human,
    format_saved_view_link_human, format_saved_view_list_human, resolve_saved_view_record,
    saved_view_link, saved_view_summaries, saved_view_summary,
};
use crate::status::{ServerClient, StatusReport, format_status_human};
use crate::view::{
    DatasetDisplayCommand, DatasetPresenceOutput, DebugStateOutput, PeerCursorOutput,
    PeerFollowOutput, PeerListOutput, PeerWorkspaceClient, PlanVisibleChunksOutput,
    ViewApplyOutput, ViewWorkspaceClient, ViewerProfileClient, ViewerProfileOutput,
    ViewerSourceOutput, format_dataset_presence_human, format_debug_state_human,
    format_diagnostic_source, format_peer_cursor_human, format_peer_follow_human,
    format_peer_list_human, format_plan_visible_chunks_human, format_view_apply_human,
    format_viewer_profile_human, format_viewer_source_human,
};
use crate::workspace::{
    WorkspaceClient, WorkspaceLifecycleOutput, WorkspaceLinkAccess, WorkspaceListOutput,
    WorkspaceLookupMode, WorkspaceMemberOutput, WorkspaceOpenOutput, WorkspaceOutput,
    WorkspacePinOutput, WorkspaceRecord, WorkspaceRole, WorkspaceSharingOutput, WorkspaceTarget,
    WorkspaceUseOutput, format_workspace_human, format_workspace_lifecycle_human,
    format_workspace_list_human, format_workspace_member_human, format_workspace_pin_human,
    format_workspace_sharing_human, resolve_workspace_record, target_for,
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
    /// Measure a headless open and read the page's own diagnostic
    ///
    /// `lucida trace <dataset>` drives the run; the subcommands read a run it
    /// wrote. Top level rather than a verb under `dataset` because it drives a
    /// run, and its follow-up depths take a run id rather than a dataset.
    ///
    /// The page loads the whole selected workspace, so a workspace holding
    /// other datasets measures opening those too — the run header lists every
    /// dataset it actually loaded. Measure one dataset in a workspace that has
    /// only that dataset.
    #[command(args_conflicts_with_subcommands = true)]
    Trace {
        /// Dataset URL in canonical form, or an id the server already has open
        #[arg(value_name = "DATASET")]
        dataset: Option<String>,
        #[command(flatten)]
        run: TraceRunArgs,
        #[command(subcommand)]
        command: Option<TraceCommand>,
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
    /// Pin a workspace in your personal workspace list
    Pin {
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
    },
    /// Remove a workspace from your personal pins
    Unpin {
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
    },
    /// Archive a workspace you own
    Archive {
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
    },
    /// Restore an archived workspace you own
    Restore {
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
    },
    /// Inspect and update workspace link sharing
    Share {
        #[command(subcommand)]
        command: WorkspaceShareCommand,
    },
    /// Manage explicit workspace members
    Member {
        #[command(subcommand)]
        command: WorkspaceMemberCommand,
    },
}

#[derive(Subcommand, Debug)]
enum WorkspaceShareCommand {
    /// Show link sharing and explicit members
    Show {
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
    },
    /// Set link sharing to off, viewer, or editor
    Link {
        /// Link sharing mode
        mode: WorkspaceLinkMode,
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum WorkspaceLinkMode {
    Off,
    Viewer,
    Editor,
}

impl WorkspaceLinkMode {
    fn access_and_role(self) -> (WorkspaceLinkAccess, WorkspaceRole) {
        match self {
            Self::Off => (WorkspaceLinkAccess::Restricted, WorkspaceRole::Viewer),
            Self::Viewer => (WorkspaceLinkAccess::AnyoneWithLink, WorkspaceRole::Viewer),
            Self::Editor => (WorkspaceLinkAccess::AnyoneWithLink, WorkspaceRole::Editor),
        }
    }
}

#[derive(Subcommand, Debug)]
enum WorkspaceMemberCommand {
    /// List explicit workspace members
    List {
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
    },
    /// Add a member or update an existing member
    Add {
        /// Member email
        email: String,
        /// Member role
        role: WorkspaceRole,
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
        /// Display name to store when adding a member
        #[arg(long)]
        display_name: Option<String>,
    },
    /// Update an existing member's role
    SetRole {
        /// Member email
        email: String,
        /// Member role
        role: WorkspaceRole,
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
    },
    /// Remove a member
    Remove {
        /// Member email
        email: String,
        /// Workspace id or unambiguous name. Defaults to --workspace/config.
        selector: Option<String>,
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
    /// Show server-authored runtime dataset health
    Health {
        /// Workspace-local dataset id or unambiguous dataset name. Omit for all datasets.
        dataset: Option<String>,
        /// Seconds to wait for the workspace snapshot and health response
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
    },
    /// Retry rebuilding a loaded dataset's server binding from its persisted source
    Retry {
        /// Workspace-local dataset id or unambiguous dataset name
        dataset: String,
        /// Seconds to wait for the server to finish retrying the dataset binding
        #[arg(long, default_value_t = 300)]
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
    /// Render an agent overview: a contact-sheet montage sampling the dataset
    /// (Z / T / tiles), each cell a re-openable view. Writes a labeled PNG and,
    /// with --json, a sidecar mapping each cell to its z/t/c + a `#view=` URL.
    Montage {
        /// Workspace-local dataset id or unambiguous dataset name
        dataset: String,
        /// PNG output path for the montage
        #[arg(long)]
        out: String,
        /// Maximum number of cells to sample
        #[arg(long, default_value_t = 16)]
        cells: usize,
        /// Grid width (max columns)
        #[arg(long, default_value_t = 4)]
        cols: u32,
        /// Per-cell thumbnail size in pixels (square). Larger cells preserve
        /// fine/sparse structure that downsampling would otherwise average away.
        #[arg(long, default_value_t = 320)]
        cell_px: u32,
        /// Also write a JSON sidecar at <out>.json
        #[arg(long)]
        json: bool,
        /// Seconds to wait for the workspace snapshot and each render
        #[arg(long, default_value_t = 30)]
        timeout_seconds: u64,
    },
    /// Plan a guided-exploration step from a view: enumerate the sensible next
    /// moves (Home / rotate / zoom / step Z) as re-openable child views. Prints
    /// a typed `ExplorationSidecar` (each cell carrying a `#view=` drill-in URL)
    /// and, with --out, renders a labeled contact sheet of the children. Omit
    /// --view to start from the dataset's Home view; re-invoke with a child's
    /// `view` to descend.
    Explore {
        /// Workspace-local dataset id or unambiguous dataset name
        dataset: String,
        /// Current view as `SavedView` JSON — inline, `-` for stdin, or
        /// `@<path>` for a file. Omit to start from the dataset's Home view.
        #[arg(long, value_name = "JSON|-|@FILE")]
        view: Option<String>,
        /// Exploration depth to stamp on the printed sidecar's current node.
        /// An agent walking deep passes its own running depth so the trail is
        /// honest across these stateless calls (the command can't infer it).
        #[arg(long, default_value_t = 0)]
        depth: u32,
        /// Comma-separated breadcrumb of move labels taken to reach this view,
        /// stamped on the current node. Likewise agent-supplied for an honest
        /// trail across stateless calls. Empty by default.
        #[arg(long, default_value = "")]
        breadcrumb: String,
        /// PNG output path for the children contact sheet. Omit to skip render
        /// (the JSON sidecar is always printed).
        #[arg(long)]
        out: Option<String>,
        /// Per-cell thumbnail size in pixels (square)
        #[arg(long, default_value_t = 320)]
        cell_px: u32,
        /// Also write the JSON sidecar at <out>.json (or <dataset>.json)
        #[arg(long)]
        json: bool,
        /// Seconds to wait for the workspace snapshot and each render
        #[arg(long, default_value_t = 30)]
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
    /// Pin the dataset's target level to one source level, or clear the pin
    /// so the target follows the screen
    LevelPin {
        dataset: String,
        /// The level to pin, 0 being the finest. Omit it to follow the screen
        level: Option<u32>,
    },
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
            LayerCommand::LevelPin { dataset, level } => {
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
    /// Show the durable viewer profile state or an explicit live peer source
    State {
        /// Inspect an explicit live peer's current view instead of the viewer profile
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
    },
    /// Print a browser URL that opens this viewer profile
    Link,
    /// Copy a live peer's current view into this durable viewer profile
    Adopt {
        /// Live peer client id to copy into the viewer profile
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: u64,
    },
    /// Capture a browser screenshot of this viewer profile or an explicit live peer
    Screenshot {
        /// PNG output path
        output: String,
        /// Capture an explicit live peer's current view instead of the viewer profile
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
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
    /// Capture a browser screenshot after fitting this viewer profile or live peer
    Overview {
        /// PNG output path
        output: String,
        /// Capture an explicit live peer's current view instead of the viewer profile
        #[arg(long, value_name = "CLIENT_ID")]
        from_peer: Option<u64>,
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
        /// Seconds to wait for follow and cleanup confirmations
        #[arg(long)]
        timeout_seconds: Option<u64>,
    },
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

/// The run's own arguments. Flattened onto `trace` rather than hung off a
/// `run` subcommand, because the command an agent is told to run — by the
/// diagnostic's own follow-up lines — is `lucida trace <dataset>`.
#[derive(clap::Args, Debug, Clone)]
struct TraceRunArgs {
    /// Viewport width in CSS pixels
    #[arg(long, default_value_t = trace::DEFAULT_WIDTH)]
    width: u32,
    /// Viewport height in CSS pixels
    #[arg(long, default_value_t = trace::DEFAULT_HEIGHT)]
    height: u32,
    /// Device pixel ratio to drive the page at
    #[arg(long, default_value_t = trace::DEFAULT_DEVICE_PIXEL_RATIO, value_name = "RATIO")]
    device_pixel_ratio: f64,
    /// Write the run here instead of the trace directory beside the config
    #[arg(long, short, value_name = "PATH")]
    output: Option<String>,
    /// Directory runs are written to and read back from
    #[arg(long, value_name = "DIR", env = "LUCIDA_TRACE_DIR")]
    trace_dir: Option<PathBuf>,
    /// Also write this run's raw spans as Chrome Trace Event JSON, for Perfetto
    #[arg(long, value_name = "PATH")]
    perfetto: Option<String>,
    /// Also write the frame the page shows once it has settled, as a PNG at
    /// the run's device pixel ratio
    #[arg(long, value_name = "PATH")]
    screenshot: Option<PathBuf>,
    /// Seconds to wait for the page to load and settle
    #[arg(long, default_value_t = 120)]
    timeout_seconds: u64,
    /// Fail (non-zero) on a stall verdict or a run that never settled
    ///
    /// Opt-in, because every other non-zero exit in this CLI means the command
    /// itself failed. Never fires on coverage: most of a healthy cold open is
    /// pre-instrument boot, so a coverage gate fires on every green run.
    #[arg(long)]
    gate: bool,
}

#[derive(Subcommand, Debug)]
enum TraceCommand {
    /// Print a persisted run at a chosen depth
    Show {
        /// Run id, or a path to a run file written with --output
        #[arg(value_name = "RUN")]
        run: String,
        /// Every phase, one row each, with the critical path and the ruleset
        #[arg(long)]
        phases: bool,
        /// One phase's numbers and the findings against it
        #[arg(long, value_name = "PHASE", conflicts_with = "phases")]
        phase: Option<String>,
        /// Directory runs are read back from
        #[arg(long, value_name = "DIR", env = "LUCIDA_TRACE_DIR")]
        trace_dir: Option<PathBuf>,
    },
    /// Write the page's trace as Chrome Trace Event JSON, for ui.perfetto.dev
    Perfetto {
        /// File to write the trace to
        #[arg(long, short, value_name = "PATH", default_value = "lucida-trace.json")]
        output: String,
        /// Durable headless viewer profile to open
        #[arg(long, default_value = "default", value_name = "NAME")]
        viewer_profile: String,
        /// Seconds to wait for the page to load and settle
        #[arg(long, default_value_t = 120)]
        timeout_seconds: u64,
        /// Viewport width in CSS pixels
        #[arg(long, default_value_t = trace::DEFAULT_WIDTH)]
        width: u32,
        /// Viewport height in CSS pixels
        #[arg(long, default_value_t = trace::DEFAULT_HEIGHT)]
        height: u32,
        /// Device pixel ratio to drive the page at
        #[arg(long, default_value_t = trace::DEFAULT_DEVICE_PIXEL_RATIO, value_name = "RATIO")]
        device_pixel_ratio: f64,
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
        /// Sharing layer for the new saved view
        #[arg(long, value_enum, default_value_t = SavedViewVisibility::Shared)]
        visibility: SavedViewVisibility,
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
    /// Change a saved view's sharing layer (defaults to promoting it to shared)
    Promote {
        /// Saved-view id or unambiguous saved-view name
        saved_view: String,
        /// Target sharing layer
        #[arg(long, value_enum, default_value_t = SavedViewVisibility::Shared)]
        visibility: SavedViewVisibility,
    },
    /// Approve a proposed saved view (editor action; re-scopes it to shared)
    Approve {
        /// Saved-view id or unambiguous saved-view name
        saved_view: String,
    },
    /// Reject a proposed saved view (editor action; returns it to personal)
    Reject {
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
                    &server.url,
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
                    &server.url,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                config.set_workspace_for_server(&server.url, workspace.id.clone());
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
                    &server.url,
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
            WorkspaceCommand::Pin { selector } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = WorkspaceClient::new(server.url.clone(), token);
                let mut workspace = resolve_workspace_record(
                    &client,
                    first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                    &config,
                    &server.url,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                let user_state = client.set_pinned(&workspace.id, true).await?;
                workspace.pinned_at = user_state.pinned_at.clone();
                let target = target_for(&server.url, &workspace)?;
                let output_payload = WorkspacePinOutput {
                    server,
                    workspace,
                    target,
                    user_state,
                    pinned: true,
                };
                output.print_either(&output_payload, || {
                    format_workspace_pin_human(&output_payload)
                })?;
            }
            WorkspaceCommand::Unpin { selector } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = WorkspaceClient::new(server.url.clone(), token);
                let mut workspace = resolve_workspace_record(
                    &client,
                    first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                    &config,
                    &server.url,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                let user_state = client.set_pinned(&workspace.id, false).await?;
                workspace.pinned_at = user_state.pinned_at.clone();
                let target = target_for(&server.url, &workspace)?;
                let output_payload = WorkspacePinOutput {
                    server,
                    workspace,
                    target,
                    user_state,
                    pinned: false,
                };
                output.print_either(&output_payload, || {
                    format_workspace_pin_human(&output_payload)
                })?;
            }
            WorkspaceCommand::Archive { selector } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = WorkspaceClient::new(server.url.clone(), token);
                let workspace = resolve_workspace_record(
                    &client,
                    first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                    &config,
                    &server.url,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                let workspace = client.archive(&workspace.id).await?;
                let target = target_for(&server.url, &workspace)?;
                let output_payload = WorkspaceLifecycleOutput {
                    server,
                    workspace,
                    target,
                    action: "Archived",
                };
                output.print_either(&output_payload, || {
                    format_workspace_lifecycle_human(&output_payload)
                })?;
            }
            WorkspaceCommand::Restore { selector } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let client = WorkspaceClient::new(server.url.clone(), token);
                let workspace = resolve_workspace_record(
                    &client,
                    first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                    &config,
                    &server.url,
                    WorkspaceLookupMode::IncludeArchived,
                )
                .await?;
                let workspace = client.restore(&workspace.id).await?;
                let target = target_for(&server.url, &workspace)?;
                let output_payload = WorkspaceLifecycleOutput {
                    server,
                    workspace,
                    target,
                    action: "Restored",
                };
                output.print_either(&output_payload, || {
                    format_workspace_lifecycle_human(&output_payload)
                })?;
            }
            WorkspaceCommand::Share { command } => match command {
                WorkspaceShareCommand::Show { selector } => {
                    let server = resolve_server(cli.server.as_deref(), &config)?;
                    let token = resolve_token(&server.url, &config);
                    let client = WorkspaceClient::new(server.url.clone(), token);
                    let workspace = resolve_workspace_record(
                        &client,
                        first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                        &config,
                        &server.url,
                        WorkspaceLookupMode::ActiveOnly,
                    )
                    .await?;
                    let target = target_for(&server.url, &workspace)?;
                    let sharing = client.sharing(&workspace.id).await?;
                    let output_payload = WorkspaceSharingOutput {
                        server,
                        workspace,
                        target,
                        sharing,
                    };
                    output.print_either(&output_payload, || {
                        format_workspace_sharing_human(&output_payload)
                    })?;
                }
                WorkspaceShareCommand::Link { mode, selector } => {
                    let server = resolve_server(cli.server.as_deref(), &config)?;
                    let token = resolve_token(&server.url, &config);
                    let client = WorkspaceClient::new(server.url.clone(), token);
                    let workspace = resolve_workspace_record(
                        &client,
                        first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                        &config,
                        &server.url,
                        WorkspaceLookupMode::ActiveOnly,
                    )
                    .await?;
                    let target = target_for(&server.url, &workspace)?;
                    let (link_access, link_role) = mode.access_and_role();
                    let sharing = client
                        .update_link_access(&workspace.id, link_access, link_role)
                        .await?;
                    let output_payload = WorkspaceSharingOutput {
                        server,
                        workspace,
                        target,
                        sharing,
                    };
                    output.print_either(&output_payload, || {
                        format_workspace_sharing_human(&output_payload)
                    })?;
                }
            },
            WorkspaceCommand::Member { command } => match command {
                WorkspaceMemberCommand::List { selector } => {
                    let server = resolve_server(cli.server.as_deref(), &config)?;
                    let token = resolve_token(&server.url, &config);
                    let client = WorkspaceClient::new(server.url.clone(), token);
                    let workspace = resolve_workspace_record(
                        &client,
                        first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                        &config,
                        &server.url,
                        WorkspaceLookupMode::ActiveOnly,
                    )
                    .await?;
                    let target = target_for(&server.url, &workspace)?;
                    let sharing = client.sharing(&workspace.id).await?;
                    let output_payload = WorkspaceSharingOutput {
                        server,
                        workspace,
                        target,
                        sharing,
                    };
                    output.print_either(&output_payload, || {
                        format_workspace_sharing_human(&output_payload)
                    })?;
                }
                WorkspaceMemberCommand::Add {
                    email,
                    role,
                    selector,
                    display_name,
                } => {
                    let server = resolve_server(cli.server.as_deref(), &config)?;
                    let token = resolve_token(&server.url, &config);
                    let client = WorkspaceClient::new(server.url.clone(), token);
                    let workspace = resolve_workspace_record(
                        &client,
                        first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                        &config,
                        &server.url,
                        WorkspaceLookupMode::ActiveOnly,
                    )
                    .await?;
                    let target = target_for(&server.url, &workspace)?;
                    let member = client
                        .upsert_member(&workspace.id, email, *role, display_name.as_deref())
                        .await?;
                    let output_payload = WorkspaceMemberOutput {
                        server,
                        workspace,
                        target,
                        member: Some(member),
                        email: None,
                        action: "Saved member",
                    };
                    output.print_either(&output_payload, || {
                        format_workspace_member_human(&output_payload)
                    })?;
                }
                WorkspaceMemberCommand::SetRole {
                    email,
                    role,
                    selector,
                } => {
                    let server = resolve_server(cli.server.as_deref(), &config)?;
                    let token = resolve_token(&server.url, &config);
                    let client = WorkspaceClient::new(server.url.clone(), token);
                    let workspace = resolve_workspace_record(
                        &client,
                        first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                        &config,
                        &server.url,
                        WorkspaceLookupMode::ActiveOnly,
                    )
                    .await?;
                    let target = target_for(&server.url, &workspace)?;
                    let member = client
                        .update_member_role(&workspace.id, email, *role)
                        .await?;
                    let output_payload = WorkspaceMemberOutput {
                        server,
                        workspace,
                        target,
                        member: Some(member),
                        email: None,
                        action: "Updated member",
                    };
                    output.print_either(&output_payload, || {
                        format_workspace_member_human(&output_payload)
                    })?;
                }
                WorkspaceMemberCommand::Remove { email, selector } => {
                    let server = resolve_server(cli.server.as_deref(), &config)?;
                    let token = resolve_token(&server.url, &config);
                    let client = WorkspaceClient::new(server.url.clone(), token);
                    let workspace = resolve_workspace_record(
                        &client,
                        first_workspace_selector(selector.as_deref(), cli.workspace.as_deref()),
                        &config,
                        &server.url,
                        WorkspaceLookupMode::ActiveOnly,
                    )
                    .await?;
                    let target = target_for(&server.url, &workspace)?;
                    client.remove_member(&workspace.id, email).await?;
                    let output_payload = WorkspaceMemberOutput {
                        server,
                        workspace,
                        target,
                        member: None,
                        email: Some(email.clone()),
                        action: "Removed member",
                    };
                    output.print_either(&output_payload, || {
                        format_workspace_member_human(&output_payload)
                    })?;
                }
            },
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
                    &server.url,
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
                    &server.url,
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
                    &server.url,
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
            DatasetCommand::Health {
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
                    &server.url,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                let target = target_for(&server.url, &workspace)?;
                let dataset_client = DatasetWorkspaceClient::new(target.ws_url.clone(), token);
                let (seq, datasets) = dataset_client
                    .health(dataset.as_deref(), Duration::from_secs(*timeout_seconds))
                    .await?;
                let output_payload = DatasetHealthOutput {
                    server,
                    workspace,
                    target,
                    seq,
                    datasets,
                };
                output.print_either(&output_payload, || {
                    format_dataset_health_human(&output_payload)
                })?;
            }
            DatasetCommand::Retry {
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
                    &server.url,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                let target = target_for(&server.url, &workspace)?;
                let dataset_client = DatasetWorkspaceClient::new(target.ws_url.clone(), token);
                let dataset = dataset_client
                    .retry(
                        dataset,
                        &workspace.id,
                        Duration::from_secs(*timeout_seconds),
                    )
                    .await?;
                let output_payload = DatasetRetryOutput {
                    server,
                    workspace,
                    target,
                    dataset,
                };
                output.print_either(&output_payload, || {
                    format_dataset_retry_human(&output_payload)
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
                    &server.url,
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
            DatasetCommand::Montage {
                dataset,
                out,
                cells,
                cols,
                cell_px,
                json,
                timeout_seconds,
            } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let workspace_client = WorkspaceClient::new(server.url.clone(), token.clone());
                let workspace = resolve_workspace_record(
                    &workspace_client,
                    cli.workspace.as_deref(),
                    &config,
                    &server.url,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                let target = target_for(&server.url, &workspace)?;
                let wait = Duration::from_secs(*timeout_seconds);
                let dataset_client =
                    DatasetWorkspaceClient::new(target.ws_url.clone(), token.clone());
                let (_seq, info) = dataset_client.info(dataset, wait).await?;
                let dims = info.summary.dimensions.ok_or_else(|| {
                    CliError::new(ErrorKind::Protocol, "dataset has no dimensions to montage")
                })?;
                let ds_id = info.summary.workspace_dataset_id.clone();
                let full_x = dims[4];
                let full_y = dims[3];
                // MVP samples the Z / T / single axis with a whole-image fit.
                // Per-tile collection montage (which needs member positions) is a
                // follow-up slice, so plan as a single image here.
                let plan = montage::plan_montage(dims, 1, *cells, *cols);
                let viewport = [*cell_px, *cell_px];

                // Pre-pass: read the dataset's auto-contrast window from a
                // representative (middle) cell, then pin ONE shared,
                // background-clipped window for every cell. Per-cell auto-contrast
                // normalises each slice independently — which flattens a contact
                // sheet of a densely-labelled stack (every cell ends up the same
                // brightness). A shared clipped window keeps brightness comparable
                // and lifts the low end to suppress the background, so structure
                // and through-stack variation show. Best-effort: if the probe can't
                // read a window, fall back to per-cell auto.
                let mid = plan.cells.len() / 2;
                let probe_saved = montage::build_cell_view(
                    &ds_id,
                    &plan.cells[mid],
                    full_x,
                    full_y,
                    viewport,
                    None,
                );
                let probe_url =
                    montage::with_render_param(&viewer_inline_view_web_url(&target, &probe_saved)?);
                const BG_CLIP: f64 = 0.3;
                let shared_contrast = match probe_montage_auto_contrast(
                    &probe_url,
                    token.as_ref(),
                    *cell_px,
                    *cell_px,
                    wait,
                )
                .await
                {
                    Ok(Some([lo, hi])) if hi > lo => Some([lo + BG_CLIP * (hi - lo), hi]),
                    _ => None,
                };

                let mut urls: Vec<String> = Vec::with_capacity(plan.cells.len());
                let mut cell_json: Vec<serde_json::Value> = Vec::with_capacity(plan.cells.len());
                for (index, cell) in plan.cells.iter().enumerate() {
                    // Same shared window for the sidecar drill-in URL and the
                    // captured thumbnail, so drilling in matches the montage.
                    let saved = montage::build_cell_view(
                        &ds_id,
                        cell,
                        full_x,
                        full_y,
                        viewport,
                        shared_contrast,
                    );
                    let url = viewer_inline_view_web_url(&target, &saved)?;
                    cell_json.push(serde_json::json!({
                        "index": index,
                        // Grid position of this cell in the image (row-major), so
                        // an agent can map a cell it sees back to this entry with
                        // no counting: cell at (row, col) == cells[row*cols + col].
                        "row": index as u32 / plan.cols.max(1),
                        "col": index as u32 % plan.cols.max(1),
                        "z": cell.z, "t": cell.t, "c": cell.c, "tile": cell.tile,
                        "label": cell.label,
                        "url": url,
                    }));
                    // Capture through the chrome-free render surface; the sidecar
                    // keeps the clean interactive URL above for drill-in.
                    urls.push(montage::with_render_param(&url));
                }

                let labels: Vec<String> =
                    plan.cells.iter().map(|cell| cell.label.clone()).collect();
                let pngs =
                    capture_montage_pngs(&urls, token.as_ref(), *cell_px, *cell_px, wait).await?;
                let montage_png = montage::stitch_grid(&pngs, &labels, plan.cols)
                    .map_err(|message| CliError::new(ErrorKind::Protocol, message))?;
                if let Some(parent) = Path::new(out).parent()
                    && !parent.as_os_str().is_empty()
                {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(out, &montage_png).await?;
                let axis = format!("{:?}", plan.axis);
                let json_path = format!("{out}.json");
                let sidecar = serde_json::json!({
                    "dataset": ds_id,
                    "out": out,
                    "axis": axis,
                    "cols": plan.cols,
                    "rows": plan.rows,
                    // Cells fill the grid left-to-right, top-to-bottom.
                    "order": "row-major",
                    "cell_px": cell_px,
                    // The shared contrast window applied to every cell (null when
                    // the probe fell back to per-cell auto-contrast).
                    "contrast": shared_contrast,
                    "cells": cell_json,
                });
                if *json {
                    tokio::fs::write(&json_path, serde_json::to_vec_pretty(&sidecar)?).await?;
                }
                let n = plan.cells.len();
                let (cols_n, rows_n, json_written) = (plan.cols, plan.rows, *json);
                output.print_either(&sidecar, || {
                    let mut human =
                        format!("Wrote montage: {out} ({n} cells, {cols_n}x{rows_n}, axis {axis})");
                    if json_written {
                        human.push_str(&format!("\nSidecar: {json_path}"));
                    }
                    human
                })?;
            }
            DatasetCommand::Explore {
                dataset,
                view,
                depth,
                breadcrumb,
                out,
                cell_px,
                json,
                timeout_seconds,
            } => {
                let server = resolve_server(cli.server.as_deref(), &config)?;
                let token = resolve_token(&server.url, &config);
                let workspace_client = WorkspaceClient::new(server.url.clone(), token.clone());
                let workspace = resolve_workspace_record(
                    &workspace_client,
                    cli.workspace.as_deref(),
                    &config,
                    &server.url,
                    WorkspaceLookupMode::ActiveOnly,
                )
                .await?;
                let target = target_for(&server.url, &workspace)?;
                let wait = Duration::from_secs(*timeout_seconds);
                let dataset_client =
                    DatasetWorkspaceClient::new(target.ws_url.clone(), token.clone());
                let (_seq, info) = dataset_client.info(dataset, wait).await?;
                let dims = info.summary.dimensions.ok_or_else(|| {
                    CliError::new(ErrorKind::Protocol, "dataset has no dimensions to explore")
                })?;
                let ds_id = info.summary.workspace_dataset_id.clone();

                let extent = ViewExtent::from_dims(dims);
                let viewport = [*cell_px, *cell_px];

                // Current view: parse the caller's `--view` (the "descend" path,
                // accepting inline JSON / stdin `-` / `@file` so the loop closes
                // hands-free), else synthesize the dataset's Home view (a 3D
                // Arcball for a volume so rotate cells appear; a 2D Slice for a
                // flat image).
                let current = match view {
                    Some(raw) => read_view_arg(raw)?,
                    None => default_view(&ds_id, dims, viewport),
                };

                // depth/breadcrumb are agent-supplied passthrough: the command is
                // stateless across calls and can't know how deep this walk is, so
                // stamp exactly what the caller reports rather than a lie.
                let breadcrumb_trail: Vec<String> = breadcrumb
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect();
                let mut sidecar =
                    ExplorationSidecar::build(&current, &extent, *depth, breadcrumb_trail);

                // Fill each cell's interactive drill-in URL (clean `#view=`, no
                // render chrome) so an agent/human can open or re-explore it.
                for cell in sidecar.cells.iter_mut() {
                    cell.url = Some(viewer_inline_view_web_url(&target, &cell.view)?);
                }

                // The PNG (when --out) and the sidecar JSON (when --json) share
                // the same output directory, so create it up front. Doing it here
                // — not inside the render's Ok arm — means a best-effort render
                // failure can't take the `<out>.json` write down with it (ENOENT).
                if let Some(out) = out
                    && let Some(parent) = Path::new(out).parent()
                    && !parent.as_os_str().is_empty()
                {
                    tokio::fs::create_dir_all(parent).await?;
                }

                // Render a labeled contact sheet of the children only when asked.
                // Best-effort: a render failure logs and leaves the JSON sidecar
                // (the primary output) intact rather than failing the command.
                if let Some(out) = out {
                    match render_explore_contact_sheet(
                        &target,
                        &sidecar,
                        token.as_ref(),
                        *cell_px,
                        wait,
                    )
                    .await
                    {
                        Ok(png) => tokio::fs::write(out, &png).await?,
                        Err(error) => {
                            eprintln!("warning: skipped explore contact sheet render: {error}");
                        }
                    }
                }

                // Emit the typed sidecar. The core sidecar already carries the
                // orientation an agent needs without the PNG — the dataset
                // `extent` and each cell's destination `z`/`t`/`c` (and the
                // per-cell `url` filled in above). The only CLI-specific addition
                // is the top-level `dataset` (the ds_id), added to the serialized
                // Value (montage-style) without disturbing the typed fields.
                let mut output_value = serde_json::to_value(&sidecar)?;
                if let Some(obj) = output_value.as_object_mut() {
                    obj.insert("dataset".to_string(), serde_json::json!(ds_id));
                }

                let json_path = match out {
                    Some(out) => format!("{out}.json"),
                    None => format!("{dataset}.json"),
                };
                if *json {
                    tokio::fs::write(&json_path, serde_json::to_vec_pretty(&output_value)?).await?;
                }

                let cell_count = sidecar.cells.len();
                let depth = sidecar.current.depth;
                let handle = sidecar.current.handle.clone();
                let labels: Vec<String> = sidecar.cells.iter().map(|c| c.label.clone()).collect();
                let (out_written, json_written) = (out.clone(), *json);
                output.print_either(&output_value, || {
                    let mut human = format!(
                        "Exploration from {handle} (depth {depth}): {cell_count} next step(s)"
                    );
                    for label in &labels {
                        human.push_str(&format!("\n  - {label}"));
                    }
                    if let Some(out) = &out_written {
                        human.push_str(&format!("\nContact sheet: {out}"));
                    }
                    if json_written {
                        human.push_str(&format!("\nSidecar: {json_path}"));
                    }
                    human
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
        Command::Trace {
            dataset,
            run,
            command,
        } => {
            emit_trace_command(
                &cli,
                &config,
                output,
                dataset.as_deref(),
                command.as_ref(),
                run,
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
                    let server = resolve_server(cli.server.as_deref(), &config)?;
                    let workspace = config.workspace_for_server(&server.url);
                    let payload = serde_json::json!({
                        "server": server,
                        "workspace": workspace,
                        "source": if workspace.is_some() { "config" } else { "unset" },
                    });
                    output.print_either(&payload, || {
                        workspace
                            .map(ToString::to_string)
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
        &server.url,
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
        SavedViewCommand::Capture {
            name,
            from_peer,
            visibility,
        } => {
            let (source, view) = saved_view_client.capture(*from_peer, wait).await?;
            let saved_view = saved_view_client
                .create(&workspace, name, &view, *visibility)
                .await?;
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
        SavedViewCommand::Promote {
            saved_view,
            visibility,
        } => {
            let saved_views = saved_view_client.list(&workspace).await?;
            let resolved = resolve_saved_view_record(saved_view, &saved_views)?;
            let saved_view = saved_view_client
                .set_visibility(&workspace, &resolved.id, *visibility)
                .await?;
            let output_payload = SavedViewOutput {
                server,
                workspace,
                target,
                saved_view,
            };
            output.print_either(&output_payload, || format_saved_view_human(&output_payload))?;
        }
        SavedViewCommand::Approve { saved_view } => {
            let saved_views = saved_view_client.list(&workspace).await?;
            let resolved = resolve_saved_view_record(saved_view, &saved_views)?;
            let saved_view = saved_view_client.approve(&workspace, &resolved.id).await?;
            let output_payload = SavedViewOutput {
                server,
                workspace,
                target,
                saved_view,
            };
            output.print_either(&output_payload, || format_saved_view_human(&output_payload))?;
        }
        SavedViewCommand::Reject { saved_view } => {
            let saved_views = saved_view_client.list(&workspace).await?;
            let resolved = resolve_saved_view_record(saved_view, &saved_views)?;
            let saved_view = saved_view_client.reject(&workspace, &resolved.id).await?;
            let output_payload = SavedViewOutput {
                server,
                workspace,
                target,
                saved_view,
            };
            output.print_either(&output_payload, || format_saved_view_human(&output_payload))?;
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
        &server.url,
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
        &server.url,
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
        &server.url,
        WorkspaceLookupMode::ActiveOnly,
    )
    .await?;
    let target = target_for(&server.url, &workspace)?;
    let wait = Duration::from_secs(timeout_seconds);
    let view_client =
        ViewerProfileClient::new(server.url.clone(), target.ws_url.clone(), token.clone());

    match command {
        ViewerCommand::State { from_peer } => {
            if from_peer.is_some() {
                let result = view_client
                    .source_state(&workspace, profile, *from_peer, None, wait)
                    .await?;
                let output_payload = ViewerSourceOutput {
                    server,
                    workspace,
                    target,
                    result,
                };
                output.print_either(&output_payload, || {
                    format_viewer_source_human(&output_payload)
                })?;
            } else {
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
        ViewerCommand::Adopt { from_peer } => {
            let result = view_client
                .adopt_from_peer(&workspace, profile, *from_peer, wait)
                .await?;
            let output_payload = ViewerProfileOutput {
                server,
                workspace,
                target,
                result,
            };
            output.print_either(&output_payload, || {
                let mut human = format_viewer_profile_human(&output_payload);
                human.push_str(&format!("\nAdopted from peer: {from_peer}"));
                human
            })?;
        }
        ViewerCommand::Screenshot {
            output: output_path,
            from_peer,
            width,
            height,
            timeout_seconds: screenshot_timeout_seconds,
        } => {
            let wait = Duration::from_secs(screenshot_timeout_seconds.unwrap_or(timeout_seconds));
            if from_peer.is_some() {
                let result = view_client
                    .source_state(&workspace, profile, *from_peer, None, wait)
                    .await?;
                let url = viewer_inline_view_web_url(&target, &result.saved_view)?;
                capture_viewer_screenshot(&url, token.as_ref(), output_path, *width, *height, wait)
                    .await?;
                let source = result.source.clone();
                let payload = serde_json::json!({
                    "server": server,
                    "workspace": workspace,
                    "target": target,
                    "source": source,
                    "url": url,
                    "output": output_path,
                    "width": width,
                    "height": height,
                });
                output.print_either(&payload, || {
                    format!(
                        "Captured viewer screenshot: {output_path}\nSource: {}\nURL: {url}",
                        format_diagnostic_source(&result.source)
                    )
                })?;
            } else {
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
        }
        ViewerCommand::Overview {
            output: output_path,
            from_peer,
            width,
            height,
            timeout_seconds: screenshot_timeout_seconds,
        } => {
            let wait = Duration::from_secs(screenshot_timeout_seconds.unwrap_or(timeout_seconds));
            if from_peer.is_some() {
                let result = view_client
                    .source_state(
                        &workspace,
                        profile,
                        *from_peer,
                        Some([*width, *height]),
                        wait,
                    )
                    .await?;
                let url = viewer_inline_view_web_url(&target, &result.saved_view)?;
                capture_viewer_screenshot(&url, token.as_ref(), output_path, *width, *height, wait)
                    .await?;
                let source = result.source.clone();
                let payload = serde_json::json!({
                    "server": server,
                    "workspace": workspace,
                    "target": target,
                    "source": source,
                    "url": url,
                    "output": output_path,
                    "width": width,
                    "height": height,
                });
                output.print_either(&payload, || {
                    format!(
                        "Captured viewer overview: {output_path}\nSource: {}\nURL: {url}",
                        format_diagnostic_source(&result.source)
                    )
                })?;
            } else {
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
        &server.url,
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
        PeerCommand::Follow {
            client_id,
            timeout_seconds: follow_timeout_seconds,
        } => {
            let follow_wait =
                Duration::from_secs(follow_timeout_seconds.unwrap_or(timeout_seconds));
            let initial_server = server.clone();
            let initial_workspace = workspace.clone();
            let initial_target = target.clone();
            let final_result = peer_client
                .follow_live(*client_id, follow_wait, |result| {
                    let output_payload = PeerFollowOutput {
                        server: initial_server,
                        workspace: initial_workspace,
                        target: initial_target,
                        result,
                    };
                    output.print_either(&output_payload, || {
                        let mut human = format_peer_follow_human(&output_payload);
                        human.push_str("\nFollowing live. Press Ctrl-C to stop following.");
                        human
                    })
                })
                .await?;
            if !output.json() && !output.quiet() {
                let output_payload = PeerFollowOutput {
                    server,
                    workspace,
                    target,
                    result: final_result,
                };
                output.print_human(format_peer_follow_human(&output_payload));
            }
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
        &server.url,
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

async fn emit_trace_command(
    cli: &Cli,
    config: &CliConfig,
    output: Output,
    dataset: Option<&str>,
    command: Option<&TraceCommand>,
    trace_args: &TraceRunArgs,
) -> Result<(), CliError> {
    let server = resolve_server(cli.server.as_deref(), config)?;
    let token = resolve_token(&server.url, config);
    let workspace_client = WorkspaceClient::new(server.url.clone(), token.clone());
    let workspace = resolve_workspace_record(
        &workspace_client,
        cli.workspace.as_deref(),
        config,
        &server.url,
        WorkspaceLookupMode::ActiveOnly,
    )
    .await?;
    let target = target_for(&server.url, &workspace)?;
    let config_path = ConfigStore::default_path()?;

    match (dataset, command) {
        (Some(dataset), _) => {
            let outcome = run_trace(
                &server,
                &workspace,
                &target,
                token.as_ref(),
                dataset,
                trace_args,
                &trace::resolve_trace_dir(trace_args.trace_dir.as_deref(), &config_path),
                Duration::from_secs(trace_args.timeout_seconds),
            )
            .await?;
            let payload = serde_json::json!({
                "server": server,
                "workspace": workspace,
                "target": target,
                "runFile": outcome.path,
                "screenshot": outcome.file.header.screenshot,
                "header": outcome.file.header,
                "verdict": outcome.file.diagnostic.get("verdict"),
                "text": outcome.file.renderings.summary,
                "gate": outcome.gate,
            });
            output.print_either(&payload, || {
                trace::format_run_human(&outcome.file, &outcome.path)
            })?;
            if let Some(reason) = outcome.gate {
                return Err(CliError::new(ErrorKind::GateFailed, reason));
            }
        }
        (
            None,
            Some(TraceCommand::Show {
                run,
                phases,
                phase,
                trace_dir,
            }),
        ) => {
            let dir = trace::resolve_trace_dir(trace_dir.as_deref(), &config_path);
            let path = trace::resolve_run_file(&dir, run);
            let file = trace::read_run_file(&path)?;
            let depth = match (phase, phases) {
                (Some(phase), _) => trace::ShowDepth::Phase(phase.clone()),
                (None, true) => trace::ShowDepth::Phases,
                (None, false) => trace::ShowDepth::Summary,
            };
            let text = trace::render_show(&file, &depth);
            let payload = serde_json::json!({
                "runFile": path,
                "header": file.header,
                "diagnostic": file.diagnostic,
                "text": text,
            });
            output.print_either(&payload, || text.clone())?;
        }
        (
            None,
            Some(TraceCommand::Perfetto {
                output: output_path,
                viewer_profile,
                timeout_seconds,
                width,
                height,
                device_pixel_ratio,
            }),
        ) => {
            let url = viewer_profile_web_url(&target, viewer_profile)?;
            let viewport = Viewport::new(*width, *height, *device_pixel_ratio);
            let capture = trace::capture_chrome_trace(
                &url,
                token.as_ref(),
                output_path,
                viewport,
                Duration::from_secs(*timeout_seconds),
            )
            .await?;
            let payload = serde_json::json!({
                "server": server,
                "workspace": workspace,
                "target": target,
                "url": url,
                "output": output_path,
                "format": "chrome-trace-event",
                "events": capture.events,
                "bytes": capture.bytes,
                "settled": capture.settled,
                "devicePixelRatio": device_pixel_ratio,
                "syntheticValues": capture.synthetic_values,
                "derivedValues": capture.derived_values,
            });
            output.print_either(&payload, || {
                trace::format_chrome_trace_human(output_path, &capture)
            })?;
        }
        (None, None) => {
            return Err(CliError::config(
                "lucida trace takes a dataset URL to measure, or a subcommand (show, perfetto)",
            ));
        }
    }

    Ok(())
}

/// A driven run, its file, and whether an opt-in gate should fail on it.
struct TraceRunOutcome {
    file: trace::TraceRunFile,
    path: PathBuf,
    gate: Option<String>,
}

/// Drive one run: read the server's warmth, compose the view, take the trace,
/// persist it.
///
/// The server is required, as it is for montage — spawning one is a different
/// command — and reading its warmth first is also how that requirement is felt:
/// a run measured against a server nobody can reach is not a measurement.
#[allow(clippy::too_many_arguments)]
async fn run_trace(
    server: &EffectiveServer,
    workspace: &WorkspaceRecord,
    target: &WorkspaceTarget,
    token: Option<&EffectiveToken>,
    dataset: &str,
    args: &TraceRunArgs,
    trace_dir: &Path,
    wait: Duration,
) -> Result<TraceRunOutcome, CliError> {
    let dataset_client = DatasetWorkspaceClient::new(target.ws_url.clone(), token.cloned());
    let (_seq, health) = dataset_client.health(None, wait).await?;
    let dataset_url = dataset_source_url(dataset, &health)?;
    let mut warmth = trace::summarise_server_warmth(&dataset_url, &health);

    // A dataset the workspace does not have yet never reaches a scene in the
    // page — the composed view has nothing to apply to, and the run measures an
    // empty viewer until the deadline. Opening it here is what makes a
    // first-time dataset measurable; the warmth block says the driver did it,
    // because it warms the server the run is about to be measured against.
    if !warmth.dataset_open_before_run {
        DatasetOpenClient::new(target.ws_url.clone(), token.cloned())
            .open(&dataset_url, &workspace.id, wait)
            .await?;
        warmth.note_driver_open();
    }

    let view = trace::compose_dataset_view(&dataset_url, args.width, args.height);
    let url = montage::with_render_param(&viewer_inline_view_web_url(target, &view)?);
    let composed = trace::ComposedView {
        dataset: normalize_dataset_url(&dataset_url),
        url: url.clone(),
        width: args.width,
        height: args.height,
        device_pixel_ratio: args.device_pixel_ratio,
    };

    let perfetto = args.perfetto.clone();
    let facts = trace::DriverFacts {
        composed_view: composed,
        server_warmth: warmth,
        server_url: server.url.clone(),
        workspace_id: workspace.id.clone(),
        screenshot: args.screenshot.clone(),
    };
    let viewport = Viewport::new(args.width, args.height, args.device_pixel_ratio);
    // A drive that fails says what it drove: the composed URL is the whole
    // workload, and without it a timeout is unreproducible by hand.
    let file = trace::drive_run(&url, token, viewport, wait, &facts, perfetto.as_deref())
        .await
        .map_err(|error| error.with_context("url", &url))?;
    let path = trace::write_run_file(&file, trace_dir, args.output.as_deref()).await?;
    let gate = if args.gate {
        trace::gate_failure(&file)
    } else {
        None
    };
    Ok(TraceRunOutcome { file, path, gate })
}

/// A dataset argument is a URL in canonical form, or the id of a dataset the
/// server already has open — the form the diagnostic's own follow-up commands
/// print. An id resolves through the health snapshot, which is the one place
/// that knows a workspace dataset's source URL.
///
/// An id is exact, so it wins outright. A name is a convenience and two
/// datasets can share one: measuring whichever came back first would be a coin
/// flip in a command whose whole output is a comparison.
fn dataset_source_url(dataset: &str, health: &[DatasetSourceHealth]) -> Result<String, CliError> {
    if let Some(found) = health
        .iter()
        .find(|entry| entry.workspace_dataset_id.0 == dataset)
        && let Some(source_url) = &found.source_url
    {
        return Ok(source_url.clone());
    }

    let by_name: Vec<&DatasetSourceHealth> = health
        .iter()
        .filter(|entry| entry.name == dataset && entry.source_url.is_some())
        .collect();
    match by_name.as_slice() {
        [only] => Ok(only.source_url.clone().unwrap_or_default()),
        [] => Ok(dataset.to_string()),
        many => Err(CliError::new(
            ErrorKind::AmbiguousName,
            format!(
                "{} datasets are named {dataset:?}; name one by id or by source URL",
                many.len()
            ),
        )),
    }
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
        &server.url,
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

/// Resolve a `--view` argument's raw JSON text from its source, honoring the
/// slice-1 `<json | - | @file>` contract: `-` reads stdin, `@<path>` reads the
/// file at `path`, and anything else is treated as inline JSON. Split out from
/// [`read_view_arg`] so the dispatch (inline / `@file`) is unit-testable without
/// a live stdin.
fn read_view_source(raw: &str) -> Result<String, CliError> {
    if raw == "-" {
        use std::io::Read as _;
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf).map_err(|error| {
            CliError::config(format!("failed to read --view from stdin: {error}"))
        })?;
        Ok(buf)
    } else if let Some(path) = raw.strip_prefix('@') {
        std::fs::read_to_string(path).map_err(|error| {
            CliError::config(format!("failed to read --view file {path:?}: {error}"))
        })
    } else {
        Ok(raw.to_string())
    }
}

/// Parse `SavedView` JSON text, mapping a decode failure to a config error.
/// Pure (no I/O) so the parse path is unit-testable directly.
fn parse_saved_view_json(json: &str) -> Result<SavedView, CliError> {
    serde_json::from_str::<SavedView>(json)
        .map_err(|error| CliError::new(ErrorKind::Config, format!("invalid --view JSON: {error}")))
}

/// Resolve a `--view` argument to a [`SavedView`]: read its source
/// ([`read_view_source`] — inline / stdin `-` / `@file`) then parse it
/// ([`parse_saved_view_json`]). This is the descend path's entry point and lets
/// the loop close hands-free (an agent pipes a child view back in via stdin or a
/// file rather than inlining ~700 bytes of JSON on the command line).
fn read_view_arg(raw: &str) -> Result<SavedView, CliError> {
    parse_saved_view_json(&read_view_source(raw)?)
}

/// Render a labeled contact sheet of an exploration's child cells, reusing the
/// montage capture + stitch path. Each cell is captured through the chrome-free
/// render surface ([`montage::with_render_param`]) and laid out in a near-square
/// grid (capped at 4 columns) with the move label burned in. Returns the encoded
/// PNG bytes; the caller writes the file.
async fn render_explore_contact_sheet(
    target: &WorkspaceTarget,
    sidecar: &ExplorationSidecar,
    token: Option<&EffectiveToken>,
    cell_px: u32,
    wait: Duration,
) -> Result<Vec<u8>, CliError> {
    let mut urls: Vec<String> = Vec::with_capacity(sidecar.cells.len());
    for cell in &sidecar.cells {
        urls.push(montage::with_render_param(&viewer_inline_view_web_url(
            target, &cell.view,
        )?));
    }
    let labels: Vec<String> = sidecar.cells.iter().map(|c| c.label.clone()).collect();
    let cols = ((sidecar.cells.len() as f64).sqrt().ceil() as u32).clamp(1, 4);
    let pngs = capture_montage_pngs(&urls, token, cell_px, cell_px, wait).await?;
    montage::stitch_grid(&pngs, &labels, cols)
        .map_err(|message| CliError::new(ErrorKind::Protocol, message))
}

fn viewer_inline_view_web_url(
    target: &WorkspaceTarget,
    saved_view: &SavedView,
) -> Result<String, CliError> {
    let payload = encode_saved_view_url_payload(saved_view)?;
    let mut url = reqwest::Url::parse(&target.web_url)
        .map_err(|error| CliError::invalid_server(format!("invalid workspace URL: {error}")))?;
    url.set_fragment(Some(&format!("view={payload}")));
    Ok(url.to_string())
}

fn encode_saved_view_url_payload(saved_view: &SavedView) -> Result<String, CliError> {
    let json = serde_json::to_vec(saved_view)?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&json)?;
    let gz = encoder.finish()?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(gz))
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

    browser::with_browser(capture_viewport(width, height), wait, async |browser| {
        let mut page = browser.open_page(url, token, wait).await?;
        let png = page.screenshot_png(wait).await?;
        if let Some(parent) = Path::new(output_path).parent()
            && !parent.as_os_str().is_empty()
        {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(output_path, png).await?;
        Ok(())
    })
    .await
}

/// Viewport for the image-producing captures (`viewer screenshot`,
/// `dataset montage`). Their device pixel ratio stays 1: it decides the output
/// image's pixel size, not the workload the renderer is put under.
fn capture_viewport(width: u32, height: u32) -> Viewport {
    Viewport::new(width, height, 1.0)
}

/// Render many view URLs in ONE headless browser session and return a PNG per
/// URL (in order). Each URL gets a fresh CDP target from the same launch —
/// much cheaper than relaunching the browser per montage cell.
async fn capture_montage_pngs(
    urls: &[String],
    token: Option<&EffectiveToken>,
    width: u32,
    height: u32,
    wait: Duration,
) -> Result<Vec<Vec<u8>>, CliError> {
    if urls.is_empty() {
        return Err(CliError::config("montage has no cells to render"));
    }
    browser::with_browser(capture_viewport(width, height), wait, async |browser| {
        let mut pngs = Vec::with_capacity(urls.len());
        for url in urls {
            let mut page = browser.open_page(url, token, wait).await?;
            pngs.push(page.screenshot_png(wait).await?);
        }
        Ok(pngs)
    })
    .await
}

/// Reads back the dataset's auto-contrast data window, which the web app
/// publishes as `window.__lucidaAutoContrast` once it has computed the slice's
/// range.
const AUTO_CONTRAST_PROBE: &str = "(() => { const a = window.__lucidaAutoContrast; return (a && Number.isFinite(a.min) && Number.isFinite(a.max)) ? [a.min, a.max] : null; })()";

/// Read an `[min, max]` window out of [`AUTO_CONTRAST_PROBE`]'s value, `None`
/// when the page never published one.
fn parse_auto_contrast_window(value: &Value) -> Option<[f64; 2]> {
    let array = value.as_array()?;
    let lo = array.first()?.as_f64()?;
    let hi = array.get(1)?.as_f64()?;
    Some([lo, hi])
}

/// Spawn one headless browser, load `url`, and return the dataset's
/// auto-contrast window (`None` if unavailable). A small pre-pass for
/// `dataset montage` so all cells can share one background-clipped window.
async fn probe_montage_auto_contrast(
    url: &str,
    token: Option<&EffectiveToken>,
    width: u32,
    height: u32,
    wait: Duration,
) -> Result<Option<[f64; 2]>, CliError> {
    browser::with_browser(capture_viewport(width, height), wait, async |browser| {
        let mut page = browser.open_page(url, token, wait).await?;
        let value = page.evaluate(AUTO_CONTRAST_PROBE, wait).await?;
        Ok(parse_auto_contrast_window(&value))
    })
    .await
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
        &server.url,
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
    use lucida_core::DatasetId;
    use lucida_core::camera::Camera;
    use serde_json::json;
    use std::io::Read;

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
        assert!(help.contains("trace"));
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
    fn workspace_lifecycle_commands_parse_product_shape() {
        let pin = parse(&["workspace", "pin", "w1"]);
        match pin.command {
            Command::Workspace {
                command: WorkspaceCommand::Pin { selector },
            } => assert_eq!(selector.as_deref(), Some("w1")),
            _ => panic!("expected workspace pin"),
        }

        let unpin = parse(&["workspace", "unpin"]);
        assert!(matches!(
            unpin.command,
            Command::Workspace {
                command: WorkspaceCommand::Unpin { selector: None },
            }
        ));

        let archive = parse(&["workspace", "archive", "w1"]);
        assert!(matches!(
            archive.command,
            Command::Workspace {
                command: WorkspaceCommand::Archive { .. },
            }
        ));

        let restore = parse(&["workspace", "restore", "w1"]);
        assert!(matches!(
            restore.command,
            Command::Workspace {
                command: WorkspaceCommand::Restore { .. },
            }
        ));
    }

    #[test]
    fn workspace_share_commands_parse_product_shape() {
        let show = parse(&["workspace", "share", "show", "w1"]);
        match show.command {
            Command::Workspace {
                command:
                    WorkspaceCommand::Share {
                        command: WorkspaceShareCommand::Show { selector },
                    },
            } => assert_eq!(selector.as_deref(), Some("w1")),
            _ => panic!("expected workspace share show"),
        }

        let link = parse(&["workspace", "share", "link", "editor", "w1"]);
        match link.command {
            Command::Workspace {
                command:
                    WorkspaceCommand::Share {
                        command: WorkspaceShareCommand::Link { mode, selector },
                    },
            } => {
                assert_eq!(selector.as_deref(), Some("w1"));
                assert!(matches!(mode, WorkspaceLinkMode::Editor));
                assert_eq!(
                    mode.access_and_role(),
                    (WorkspaceLinkAccess::AnyoneWithLink, WorkspaceRole::Editor)
                );
            }
            _ => panic!("expected workspace share link"),
        }

        let off = parse(&["workspace", "share", "link", "off"]);
        assert!(matches!(
            off.command,
            Command::Workspace {
                command: WorkspaceCommand::Share {
                    command: WorkspaceShareCommand::Link {
                        mode: WorkspaceLinkMode::Off,
                        selector: None,
                    },
                },
            }
        ));
    }

    #[test]
    fn workspace_member_commands_parse_product_shape() {
        let list = parse(&["workspace", "member", "list", "w1"]);
        match list.command {
            Command::Workspace {
                command:
                    WorkspaceCommand::Member {
                        command: WorkspaceMemberCommand::List { selector },
                    },
            } => assert_eq!(selector.as_deref(), Some("w1")),
            _ => panic!("expected workspace member list"),
        }

        let add = parse(&[
            "workspace",
            "member",
            "add",
            "editor@example.com",
            "editor",
            "w1",
            "--display-name",
            "Editor",
        ]);
        match add.command {
            Command::Workspace {
                command:
                    WorkspaceCommand::Member {
                        command:
                            WorkspaceMemberCommand::Add {
                                email,
                                role,
                                selector,
                                display_name,
                            },
                    },
            } => {
                assert_eq!(email, "editor@example.com");
                assert_eq!(role, WorkspaceRole::Editor);
                assert_eq!(selector.as_deref(), Some("w1"));
                assert_eq!(display_name.as_deref(), Some("Editor"));
            }
            _ => panic!("expected workspace member add"),
        }

        let set_role = parse(&[
            "workspace",
            "member",
            "set-role",
            "viewer@example.com",
            "viewer",
        ]);
        assert!(matches!(
            set_role.command,
            Command::Workspace {
                command: WorkspaceCommand::Member {
                    command: WorkspaceMemberCommand::SetRole {
                        role: WorkspaceRole::Viewer,
                        selector: None,
                        ..
                    },
                },
            }
        ));

        let remove = parse(&["workspace", "member", "remove", "viewer@example.com", "w1"]);
        match remove.command {
            Command::Workspace {
                command:
                    WorkspaceCommand::Member {
                        command: WorkspaceMemberCommand::Remove { email, selector },
                    },
            } => {
                assert_eq!(email, "viewer@example.com");
                assert_eq!(selector.as_deref(), Some("w1"));
            }
            _ => panic!("expected workspace member remove"),
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
    fn dataset_retry_parses_product_shape() {
        let cli = parse(&["dataset", "retry", "wds-1", "--timeout-seconds", "11"]);

        match cli.command {
            Command::Dataset {
                command:
                    DatasetCommand::Retry {
                        dataset,
                        timeout_seconds,
                    },
            } => {
                assert_eq!(dataset, "wds-1");
                assert_eq!(timeout_seconds, 11);
            }
            _ => panic!("expected dataset retry"),
        }
    }

    #[test]
    fn dataset_explore_parses_product_shape() {
        let cli = parse(&[
            "dataset",
            "explore",
            "wds-1",
            "--view",
            "{\"v\":1}",
            "--depth",
            "3",
            "--breadcrumb",
            "Home (fit dataset),Rotate right 45°",
            "--out",
            "kids.png",
            "--cell-px",
            "256",
            "--json",
            "--timeout-seconds",
            "15",
        ]);

        match cli.command {
            Command::Dataset {
                command:
                    DatasetCommand::Explore {
                        dataset,
                        view,
                        depth,
                        breadcrumb,
                        out,
                        cell_px,
                        json,
                        timeout_seconds,
                    },
            } => {
                assert_eq!(dataset, "wds-1");
                assert_eq!(view.as_deref(), Some("{\"v\":1}"));
                assert_eq!(depth, 3);
                assert_eq!(breadcrumb, "Home (fit dataset),Rotate right 45°");
                assert_eq!(out.as_deref(), Some("kids.png"));
                assert_eq!(cell_px, 256);
                assert!(json);
                assert_eq!(timeout_seconds, 15);
            }
            _ => panic!("expected dataset explore"),
        }
    }

    #[test]
    fn dataset_explore_defaults_optional_args() {
        // Bare form: only the dataset, everything else defaulted/absent.
        let cli = parse(&["dataset", "explore", "wds-2"]);
        match cli.command {
            Command::Dataset {
                command:
                    DatasetCommand::Explore {
                        dataset,
                        view,
                        depth,
                        breadcrumb,
                        out,
                        cell_px,
                        json,
                        timeout_seconds,
                    },
            } => {
                assert_eq!(dataset, "wds-2");
                assert!(view.is_none());
                assert_eq!(depth, 0);
                assert!(breadcrumb.is_empty());
                assert!(out.is_none());
                assert_eq!(cell_px, 320);
                assert!(!json);
                assert_eq!(timeout_seconds, 30);
            }
            _ => panic!("expected dataset explore"),
        }
    }

    #[test]
    fn read_view_arg_dispatches_inline_and_at_file() {
        // Inline JSON: parsed straight through.
        let inline = serde_json::to_string(&SavedView::empty([800, 600])).unwrap();
        let from_inline = read_view_arg(&inline).expect("inline view parses");
        assert_eq!(from_inline, SavedView::empty([800, 600]));

        // `@<path>`: read the same JSON from a file, parse identically. Uses a
        // unique temp path so the test is hermetic (no stdin needed to exercise
        // the dispatch).
        let dir = std::env::temp_dir();
        let path = dir.join(format!("lucida-explore-view-{}.json", std::process::id()));
        std::fs::write(&path, &inline).unwrap();
        let arg = format!("@{}", path.display());
        let from_file = read_view_arg(&arg).expect("@file view parses");
        assert_eq!(from_file, SavedView::empty([800, 600]));
        let _ = std::fs::remove_file(&path);

        // A missing `@file` is a config error, not a panic.
        let missing = read_view_arg("@/no/such/lucida/view.json");
        assert!(missing.is_err());
        assert_eq!(missing.unwrap_err().kind, ErrorKind::Config);

        // Malformed inline JSON is a config error.
        let bad = read_view_arg("{not json");
        assert!(bad.is_err());
        assert_eq!(bad.unwrap_err().kind, ErrorKind::Config);
    }

    #[test]
    fn explore_extent_from_dims() {
        // The CLI explore handler derives its extent via the shared core fn.
        let extent = ViewExtent::from_dims([1, 2, 340, 512, 512]);
        assert_eq!(extent.z_count, 340);
        assert_eq!(extent.t_count, 1);
        assert_eq!(extent.c_count, 2);
        assert_eq!(extent.max, [512.0, 512.0, 340.0]);
        assert_eq!(extent.min, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn explore_output_value_has_core_fields_plus_cli_additions() {
        // The dedup contract: the core sidecar now carries `extent` + per-cell
        // `z`/`t`/`c`, so the CLI no longer injects them — it only fills each
        // cell's `url` and adds the top-level `dataset`. This mirrors the handler
        // construction (build → fill urls → to_value → add dataset) and asserts
        // the printed JSON has all of: extent, per-cell z/t/c, dataset, url.
        let dims = [5, 3, 40, 80, 100]; // [T, C, Z, Y, X], rich on every axis
        let ds_id = "wds-explore";
        let extent = ViewExtent::from_dims(dims);
        let mut current = default_view(ds_id, dims, [320, 320]);
        // Sit in the interior so steps in both directions are offered.
        current.view.t = 2;
        current.view.c = 1;
        let mut sidecar = ExplorationSidecar::build(&current, &extent, 0, Vec::new());
        assert!(!sidecar.cells.is_empty(), "expected some next-step cells");

        // Fill the per-cell URL exactly as the handler does.
        let target = WorkspaceTarget {
            id: "ws-1".to_string(),
            name: "ws".to_string(),
            role: WorkspaceRole::Editor,
            archived: false,
            server_url: "http://127.0.0.1:9876".to_string(),
            web_url: "http://127.0.0.1:9876/w/ws-1".to_string(),
            ws_url: "ws://127.0.0.1:9876/ws/ws-1".to_string(),
        };
        for cell in sidecar.cells.iter_mut() {
            cell.url = Some(viewer_inline_view_web_url(&target, &cell.view).unwrap());
        }

        let mut output_value = serde_json::to_value(&sidecar).unwrap();
        output_value
            .as_object_mut()
            .unwrap()
            .insert("dataset".to_string(), serde_json::json!(ds_id));

        // Top-level: CLI `dataset` + core `extent` (no double-add).
        assert_eq!(output_value["dataset"], serde_json::json!(ds_id));
        assert_eq!(output_value["extent"]["z_count"], serde_json::json!(40));
        assert_eq!(output_value["extent"]["t_count"], serde_json::json!(5));
        assert_eq!(output_value["extent"]["c_count"], serde_json::json!(3));

        // Per-cell: core z/t/c + CLI url, matching the typed sidecar cells.
        let cells = output_value["cells"].as_array().unwrap();
        assert_eq!(cells.len(), sidecar.cells.len());
        for (cell, src) in cells.iter().zip(sidecar.cells.iter()) {
            assert_eq!(cell["z"], serde_json::json!(src.view.view.z_range.start));
            assert_eq!(cell["t"], serde_json::json!(src.view.view.t));
            assert_eq!(cell["c"], serde_json::json!(src.view.view.c));
            assert_eq!(cell["url"], serde_json::json!(src.url));
            assert!(
                cell["url"].as_str().unwrap().contains("#view="),
                "each cell carries a #view= drill-in URL"
            );
        }
    }

    #[test]
    fn default_explore_view_is_3d_for_volume() {
        // The CLI explore handler synthesizes its Home view via the shared core fn.
        let view = default_view("wds-1", [1, 1, 340, 512, 512], [800, 600]);
        assert!(
            matches!(view.camera, Camera::Arcball(_)),
            "a volume should open in a 3D Arcball Home"
        );
        assert_eq!(view.dataset_order, vec![DatasetId("wds-1".to_string())]);
        // Mid-stack single slice (340 / 2 = 170).
        assert_eq!(view.view.z_range, 170..171);
        // Dataset is made visible (auto-contrast on, default settings present).
        assert_eq!(
            view.auto_contrast.get(&DatasetId("wds-1".to_string())),
            Some(&true)
        );
        assert!(
            view.dataset_settings
                .contains_key(&DatasetId("wds-1".to_string()))
        );
    }

    #[test]
    fn default_explore_view_is_2d_for_flat() {
        let view = default_view("wds-1", [1, 3, 1, 1024, 1024], [800, 600]);
        assert!(
            matches!(view.camera, Camera::Slice(_)),
            "a flat image should open in a 2D Slice Home"
        );
        // A flat dataset has a single slice at z 0.
        assert_eq!(view.view.z_range, 0..1);
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
                command:
                    SavedViewCommand::Capture {
                        name,
                        from_peer,
                        visibility,
                    },
                ..
            } => {
                assert_eq!(name, "Current");
                assert_eq!(from_peer, Some(7));
                // Defaults to shared so existing capture invocations are unchanged.
                assert_eq!(visibility, SavedViewVisibility::Shared);
            }
            _ => panic!("expected saved-view capture"),
        }

        let capture_personal =
            parse(&["saved-view", "capture", "Mine", "--visibility", "personal"]);
        match capture_personal.command {
            Command::SavedView {
                command: SavedViewCommand::Capture { visibility, .. },
                ..
            } => assert_eq!(visibility, SavedViewVisibility::Personal),
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

        // Promote defaults to shared (the #699 happy path) and accepts an
        // explicit target visibility.
        let promote = parse(&["saved-view", "promote", "sv-1"]);
        match promote.command {
            Command::SavedView {
                command:
                    SavedViewCommand::Promote {
                        saved_view,
                        visibility,
                    },
                ..
            } => {
                assert_eq!(saved_view, "sv-1");
                assert_eq!(visibility, SavedViewVisibility::Shared);
            }
            _ => panic!("expected saved-view promote"),
        }

        let promote_personal =
            parse(&["saved-view", "promote", "sv-1", "--visibility", "personal"]);
        match promote_personal.command {
            Command::SavedView {
                command: SavedViewCommand::Promote { visibility, .. },
                ..
            } => assert_eq!(visibility, SavedViewVisibility::Personal),
            _ => panic!("expected saved-view promote"),
        }

        let approve = parse(&["saved-view", "approve", "sv-1"]);
        match approve.command {
            Command::SavedView {
                command: SavedViewCommand::Approve { saved_view },
                ..
            } => assert_eq!(saved_view, "sv-1"),
            _ => panic!("expected saved-view approve"),
        }

        let reject = parse(&["saved-view", "reject", "sv-1"]);
        match reject.command {
            Command::SavedView {
                command: SavedViewCommand::Reject { saved_view },
                ..
            } => assert_eq!(saved_view, "sv-1"),
            _ => panic!("expected saved-view reject"),
        }
    }

    #[test]
    fn viewer_commands_parse_product_shape() {
        let state = parse(&["viewer", "--profile", "cli.default", "state"]);
        match state.command {
            Command::Viewer {
                profile,
                timeout_seconds,
                command: ViewerCommand::State { from_peer },
            } => {
                assert_eq!(profile, "cli.default");
                assert_eq!(timeout_seconds, 30);
                assert_eq!(from_peer, None);
            }
            _ => panic!("expected viewer state"),
        }

        let peer_state = parse(&["viewer", "state", "--from-peer", "7"]);
        match peer_state.command {
            Command::Viewer {
                command: ViewerCommand::State { from_peer },
                ..
            } => assert_eq!(from_peer, Some(7)),
            _ => panic!("expected viewer state from peer"),
        }

        let adopt = parse(&["viewer", "adopt", "--from-peer", "8"]);
        match adopt.command {
            Command::Viewer {
                command: ViewerCommand::Adopt { from_peer },
                ..
            } => assert_eq!(from_peer, 8),
            _ => panic!("expected viewer adopt"),
        }

        let screenshot = parse(&[
            "viewer",
            "screenshot",
            "/tmp/view.png",
            "--from-peer",
            "9",
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
                        from_peer,
                        width,
                        height,
                        timeout_seconds,
                    },
                ..
            } => {
                assert_eq!(output, "/tmp/view.png");
                assert_eq!(from_peer, Some(9));
                assert_eq!(width, 900);
                assert_eq!(height, 700);
                assert_eq!(timeout_seconds, Some(60));
            }
            _ => panic!("expected viewer screenshot"),
        }

        let overview = parse(&[
            "viewer",
            "overview",
            "/tmp/overview.png",
            "--from-peer",
            "10",
        ]);
        match overview.command {
            Command::Viewer {
                command:
                    ViewerCommand::Overview {
                        output, from_peer, ..
                    },
                ..
            } => {
                assert_eq!(output, "/tmp/overview.png");
                assert_eq!(from_peer, Some(10));
            }
            _ => panic!("expected viewer overview"),
        }
    }

    #[test]
    fn saved_view_url_payload_is_gzip_base64url_json() {
        let view = SavedView::empty([640, 480]);
        let payload = encode_saved_view_url_payload(&view).unwrap();
        assert!(!payload.contains(['+', '/', '=']));

        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .unwrap();
        let mut decoder = flate2::read::GzDecoder::new(bytes.as_slice());
        let mut json = String::new();
        decoder.read_to_string(&mut json).unwrap();
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["v"].as_u64(), Some(view.v as u64));
        assert!(parsed["camera"].is_object());
    }

    #[test]
    fn auto_contrast_window_reads_a_pair_and_tolerates_no_window() {
        assert_eq!(
            parse_auto_contrast_window(&json!([12.0, 480.0])),
            Some([12.0, 480.0])
        );
        assert_eq!(parse_auto_contrast_window(&Value::Null), None);
        assert_eq!(parse_auto_contrast_window(&json!([12.0])), None);
    }

    #[test]
    fn image_captures_keep_a_scale_factor_of_one() {
        let viewport = capture_viewport(900, 700);
        assert_eq!(viewport.width, 900);
        assert_eq!(viewport.height, 700);
        assert_eq!(viewport.device_scale_factor, 1.0);
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
                command:
                    PeerCommand::Follow {
                        client_id,
                        timeout_seconds,
                    },
                ..
            } => {
                assert_eq!(client_id, 42);
                assert_eq!(timeout_seconds, None);
            }
            _ => panic!("expected peer follow"),
        }

        let follow_with_leaf_timeout = parse(&["peer", "follow", "42", "--timeout-seconds", "11"]);
        match follow_with_leaf_timeout.command {
            Command::Peer {
                command:
                    PeerCommand::Follow {
                        client_id,
                        timeout_seconds,
                    },
                ..
            } => {
                assert_eq!(client_id, 42);
                assert_eq!(timeout_seconds, Some(11));
            }
            _ => panic!("expected peer follow"),
        }

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

    /// DPR 2 is the default because that is the condition the defects this
    /// trace exists to find actually appear at, and the viewport is a window
    /// rather than a capture cell.
    #[test]
    fn trace_defaults_to_a_retina_workload_at_a_representative_window() {
        let trace = parse(&["trace", "gs://bucket/set.zarr"]);
        match trace.command {
            Command::Trace {
                dataset,
                run,
                command,
            } => {
                assert_eq!(dataset.as_deref(), Some("gs://bucket/set.zarr"));
                assert!(command.is_none());
                assert_eq!(run.timeout_seconds, 120);
                assert_eq!((run.width, run.height), (1440, 900));
                assert_eq!(run.device_pixel_ratio, 2.0);
                assert_eq!(run.output, None);
                // A stall exits zero unless the call site asks otherwise.
                assert!(!run.gate);
            }
            _ => panic!("expected a trace run"),
        }

        let gated = parse(&[
            "trace",
            "/data/set.zarr",
            "--gate",
            "--output",
            "/tmp/r.json",
            "--screenshot",
            "/tmp/r.png",
        ]);
        match gated.command {
            Command::Trace { run, .. } => {
                assert!(run.gate);
                assert_eq!(run.output.as_deref(), Some("/tmp/r.json"));
                // The frame rides the same drive, so a twin comparison is two
                // commands and not four.
                assert_eq!(run.screenshot.as_deref(), Some(Path::new("/tmp/r.png")));
            }
            _ => panic!("expected a trace run"),
        }
    }

    /// The follow-up depths the diagnostic prints have to parse, or the default
    /// rendering names commands that do not run.
    #[test]
    fn trace_show_takes_a_run_id_and_a_depth() {
        match parse(&["trace", "show", "run-17-3", "--phases"]).command {
            Command::Trace {
                dataset,
                command:
                    Some(TraceCommand::Show {
                        run, phases, phase, ..
                    }),
                ..
            } => {
                assert_eq!(dataset, None);
                assert_eq!(run, "run-17-3");
                assert!(phases);
                assert_eq!(phase, None);
            }
            _ => panic!("expected trace show"),
        }

        match parse(&["trace", "show", "run-17-3", "--phase", "wire"]).command {
            Command::Trace {
                command: Some(TraceCommand::Show { phase, .. }),
                ..
            } => assert_eq!(phase.as_deref(), Some("wire")),
            _ => panic!("expected trace show"),
        }

        // One depth at a time: the two flags would otherwise both apply.
        assert!(try_parse(&["trace", "show", "r", "--phases", "--phase", "wire"]).is_err());
    }

    #[test]
    fn trace_perfetto_keeps_its_own_flags() {
        let explicit = parse(&[
            "trace",
            "perfetto",
            "--viewer-profile",
            "analysis",
            "--output",
            "/tmp/run.json",
            "--device-pixel-ratio",
            "1",
        ]);
        match explicit.command {
            Command::Trace {
                command:
                    Some(TraceCommand::Perfetto {
                        output,
                        viewer_profile,
                        device_pixel_ratio,
                        ..
                    }),
                ..
            } => {
                assert_eq!(viewer_profile, "analysis");
                assert_eq!(output, "/tmp/run.json");
                assert_eq!(device_pixel_ratio, 1.0);
            }
            _ => panic!("expected trace perfetto"),
        }
    }

    /// An id the server already has open is what the diagnostic's own follow-up
    /// line names, so it has to reach the same dataset a URL would.
    #[test]
    fn a_dataset_argument_resolves_an_open_id_to_its_source_url() {
        let health = vec![lucida_protocol::DatasetSourceHealth {
            workspace_dataset_id: lucida_core::DatasetId("ds-1".to_string()),
            name: "set".to_string(),
            status: lucida_protocol::DatasetHealthStatus::Healthy,
            source_url: Some("gs://bucket/set.zarr".to_string()),
            backend: None,
            binding: lucida_protocol::DatasetHealthComponent {
                status: lucida_protocol::DatasetHealthStatus::Healthy,
                message: None,
            },
            source_cache: None,
            generated_coarse: lucida_protocol::DatasetGeneratedCoarseHealth {
                status: lucida_protocol::DatasetHealthStatus::Healthy,
                level_count: 0,
                ready_chunks: 0,
                pending_chunks: 0,
                failed_chunks: 0,
                unavailable_chunks: 0,
                message: None,
                cache: None,
                recent_failures: Vec::new(),
            },
            messages: Vec::new(),
        }];

        assert_eq!(
            dataset_source_url("ds-1", &health).unwrap(),
            "gs://bucket/set.zarr"
        );
        assert_eq!(
            dataset_source_url("set", &health).unwrap(),
            "gs://bucket/set.zarr"
        );
        assert_eq!(
            dataset_source_url("gs://bucket/other.zarr", &health).unwrap(),
            "gs://bucket/other.zarr"
        );

        // Two datasets under one name is a refusal, not whichever came first.
        let mut twins = health.clone();
        twins.push(twins[0].clone());
        let error = dataset_source_url("set", &twins).unwrap_err();
        assert_eq!(error.kind, ErrorKind::AmbiguousName);
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
