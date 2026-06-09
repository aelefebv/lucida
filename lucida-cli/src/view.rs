use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use lucida_core::DatasetId;
use lucida_core::camera::Camera;
use lucida_core::chunk::ChunkCoord;
use lucida_core::command::{Command as CoreCommand, ViewportCommand};
use lucida_core::protocol::{ClientId, ClientMessage, PresenceState, ServerMessage};
use lucida_core::saved_view::{SAVED_VIEW_VERSION, SavedView};
use lucida_core::scene::{
    BlendMode, ChannelSettings, Colormap, DatasetDisplaySettings, DisplayState, DocumentState,
    RenderMode, Scene,
};
use lucida_core::view::ViewState;
use lucida_protocol::{GeneratedAvailabilitySnapshot, GeneratedChunkStatus, GeneratedLevelSummary};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::error::Error as WebSocketError;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::{Request as WsRequest, StatusCode as WsStatusCode};
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::config::EffectiveServer;
use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::workspace::{WorkspaceRecord, WorkspaceTarget};

#[derive(Debug, Serialize)]
pub struct ViewApplyOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    #[serde(flatten)]
    pub result: ViewApplyResult,
}

#[derive(Debug, Clone, Serialize)]
pub struct ViewApplyResult {
    pub snapshot_seq: u64,
    pub own_client_id: ClientId,
    pub source: ViewPresenceSource,
    pub command: ViewportCommand,
    pub camera: Camera,
    pub view: ViewState,
    pub display: DisplayState,
    #[serde(skip)]
    pub break_follow: bool,
}

#[derive(Debug, Serialize)]
pub struct DatasetPresenceOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    #[serde(flatten)]
    pub result: DatasetPresenceResult,
}

#[derive(Debug, Serialize)]
pub struct PeerListOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    #[serde(flatten)]
    pub result: PeerListResult,
}

#[derive(Debug, Serialize)]
pub struct PeerFollowOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    #[serde(flatten)]
    pub result: PeerFollowResult,
}

#[derive(Debug, Serialize)]
pub struct PeerCursorOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    #[serde(flatten)]
    pub result: PeerCursorResult,
}

#[derive(Debug, Serialize)]
pub struct PlanVisibleChunksOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    #[serde(flatten)]
    pub result: PlanVisibleChunksResult,
}

#[derive(Debug, Serialize)]
pub struct DebugStateOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    #[serde(flatten)]
    pub result: DebugStateResult,
}

#[derive(Debug, Serialize)]
pub struct ViewerProfileOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    #[serde(flatten)]
    pub result: ViewerProfileResult,
}

#[derive(Debug, Clone, Serialize)]
pub struct ViewerProfileResult {
    pub snapshot_seq: u64,
    pub own_client_id: ClientId,
    pub profile: String,
    pub user_email: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<ViewportCommand>,
    pub camera: Camera,
    pub view: ViewState,
    pub display: DisplayState,
    pub multi_channel: bool,
    pub layers: Vec<LayerState>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DatasetPresenceResult {
    pub snapshot_seq: u64,
    pub own_client_id: ClientId,
    pub source: ViewPresenceSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<ViewportCommand>,
    pub multi_channel: bool,
    pub layers: Vec<LayerState>,
    #[serde(skip)]
    pub dataset_order: Vec<DatasetId>,
    #[serde(skip)]
    pub dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    #[serde(skip)]
    pub break_follow: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerListResult {
    pub snapshot_seq: u64,
    pub own_client_id: ClientId,
    pub peers: Vec<PeerSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerSummary {
    pub client_id: ClientId,
    pub is_self: bool,
    pub following: Option<ClientId>,
    pub followers: Vec<ClientId>,
    pub cursor: Option<[f64; 2]>,
    pub camera: Camera,
    pub view: ViewState,
    pub display: DisplayState,
    pub dataset_order: Vec<DatasetId>,
    pub dataset_settings_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerFollowResult {
    pub snapshot_seq: u64,
    pub own_client_id: ClientId,
    pub accepted: bool,
    pub changed: bool,
    pub requested_target: Option<ClientId>,
    pub current_target: Option<ClientId>,
    pub changes: Vec<PeerFollowChange>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerFollowChange {
    pub client_id: ClientId,
    pub target: Option<ClientId>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerCursorResult {
    pub snapshot_seq: u64,
    pub own_client_id: ClientId,
    pub position: Option<[f64; 2]>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanVisibleChunksResult {
    pub snapshot_seq: u64,
    pub own_client_id: ClientId,
    pub source: DiagnosticViewSource,
    pub diagnostic_kind: &'static str,
    pub planner_parity: bool,
    pub datasets: Vec<PlanDatasetDiagnostic>,
    pub caveats: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlanDatasetDiagnostic {
    pub dataset_id: String,
    pub name: String,
    pub visible: bool,
    pub multi_channel: bool,
    pub display: DisplayState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_layout_id: Option<String>,
    pub active_members: Vec<ActiveMemberDiagnostic>,
    pub member_plans: Vec<MemberVisibleChunksDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_availability: Option<GeneratedAvailabilityDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActiveMemberDiagnostic {
    pub entity_id: String,
    pub image_id: String,
    pub position: [f64; 2],
    pub level_indices: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemberVisibleChunksDiagnostic {
    pub image_id: String,
    pub position: [f64; 2],
    pub needed_count: usize,
    pub prefetch_count: usize,
    pub tiers: Vec<ChunkTierDiagnostic>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChunkTierDiagnostic {
    pub tier: &'static str,
    pub level_index: u32,
    pub count: usize,
    pub chunks: Vec<ChunkCoord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugStateResult {
    pub snapshot_seq: u64,
    pub own_client_id: ClientId,
    pub source: DiagnosticViewSource,
    pub diagnostic_kind: &'static str,
    pub planner_parity: bool,
    pub viewer: DebugViewerState,
    pub datasets: Vec<DebugDatasetState>,
    pub peers: Vec<PeerSummary>,
    pub generated_availability: Vec<DatasetGeneratedAvailabilityDiagnostic>,
    pub caveats: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugViewerState {
    pub camera: Camera,
    pub view: ViewState,
    pub display: DisplayState,
    pub multi_channel: bool,
    pub dataset_order: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugDatasetState {
    pub dataset_id: String,
    pub name: String,
    pub visible: bool,
    pub member_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_layout_id: Option<String>,
    pub generated_level_count: usize,
    pub generated_chunk_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DatasetGeneratedAvailabilityDiagnostic {
    pub dataset_id: String,
    pub name: String,
    pub availability: GeneratedAvailabilityDiagnostic,
}

#[derive(Debug, Clone, Serialize)]
pub struct GeneratedAvailabilityDiagnostic {
    pub level_count: usize,
    pub chunk_count: usize,
    pub levels: Vec<GeneratedLevelDiagnostic>,
    pub chunk_status: GeneratedChunkStatusCounts,
}

#[derive(Debug, Clone, Serialize)]
pub struct GeneratedLevelDiagnostic {
    pub image_id: String,
    pub level_index: u32,
    pub role: String,
    pub generator: String,
    pub config_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<GeneratedLevelSummary>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct GeneratedChunkStatusCounts {
    pub ready: usize,
    pub pending: usize,
    pub unavailable: usize,
    pub failed_transient: usize,
    pub failed_permanent: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiagnosticViewSource {
    pub kind: DiagnosticViewSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<ClientId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed_source: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticViewSourceKind {
    ViewerProfile,
    Peer,
}

#[derive(Debug, Clone, Serialize)]
pub struct LayerState {
    pub workspace_dataset_id: String,
    pub name: String,
    pub visible: bool,
    pub opacity: f32,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
    pub blend_mode: BlendMode,
    pub render_mode: RenderMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_level_override: Option<u32>,
    pub channel_blend_mode: BlendMode,
    pub channel_count: u32,
    pub channels: Vec<ChannelState>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelState {
    pub channel: u32,
    pub visible: bool,
    pub colormap: Colormap,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
}

#[derive(Debug, Clone)]
#[allow(clippy::enum_variant_names)]
pub enum DatasetDisplayCommand {
    SetOrder {
        selectors: Vec<String>,
    },
    SetDatasetVisible {
        selector: String,
        visible: bool,
    },
    SetDatasetOpacity {
        selector: String,
        opacity: f32,
    },
    SetCurrentChannelContrast {
        selector: String,
        channel: Option<u32>,
        min: f64,
        max: f64,
    },
    SetCurrentChannelGamma {
        selector: String,
        channel: Option<u32>,
        gamma: f64,
    },
    SetCurrentChannelColormap {
        selector: String,
        channel: Option<u32>,
        colormap: Colormap,
    },
    SetDatasetBlendMode {
        selector: String,
        blend_mode: BlendMode,
    },
    SetDatasetRenderMode {
        selector: String,
        render_mode: RenderMode,
    },
    SetDatasetDetailLevelOverride {
        selector: String,
        level: Option<u32>,
    },
    SetChannelVisible {
        selector: String,
        channel: u32,
        visible: bool,
    },
    SetChannelColormap {
        selector: String,
        channel: u32,
        colormap: Colormap,
    },
    SetChannelContrast {
        selector: String,
        channel: u32,
        min: f64,
        max: f64,
    },
    SetChannelGamma {
        selector: String,
        channel: u32,
        gamma: f64,
    },
    SetChannelBlendMode {
        selector: String,
        blend_mode: BlendMode,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ViewPresenceSource {
    pub client_id: ClientId,
    pub kind: ViewPresenceSourceKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewPresenceSourceKind {
    Own,
    Peer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceViewerProfileRecord {
    pub workspace_id: String,
    pub user_email: String,
    pub profile: String,
    pub created_at: String,
    pub updated_at: String,
    pub seed_source: Option<String>,
    pub view: SavedView,
}

#[derive(Debug, Deserialize)]
struct WorkspaceSavedViewSeedRecord {
    view: SavedView,
}

#[derive(Debug, Serialize)]
struct UpsertViewerProfileBody<'a> {
    view: &'a SavedView,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed_source: Option<&'a str>,
}

#[derive(Debug, Clone)]
struct WorkspacePresenceSnapshot {
    seq: u64,
    document: DocumentState,
    peers: Vec<PresenceState>,
    your_id: ClientId,
    generated_availability: HashMap<DatasetId, GeneratedAvailabilitySnapshot>,
}

#[derive(Debug, Clone)]
struct DiagnosticScene {
    snapshot: WorkspacePresenceSnapshot,
    source: DiagnosticViewSource,
    scene: Scene,
}

pub struct ViewWorkspaceClient {
    ws_url: String,
    token: Option<String>,
}

impl ViewWorkspaceClient {
    pub fn new(ws_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            ws_url: ws_url.into(),
            token: token.map(|effective| effective.token),
        }
    }

    pub async fn apply(
        &self,
        command: ViewportCommand,
        from_peer: Option<ClientId>,
        wait: Duration,
    ) -> Result<ViewApplyResult, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let result = apply_presence_command(&snapshot, command, from_peer)?;

        if result.break_follow {
            send_client_message(&mut write, &ClientMessage::Follow { target: None }).await?;
        }
        send_client_message(&mut write, &presence_message(&result)).await?;
        Ok(result)
    }

    pub async fn dataset_state(
        &self,
        from_peer: Option<ClientId>,
        wait: Duration,
    ) -> Result<DatasetPresenceResult, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (_write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        dataset_presence_state(&snapshot, from_peer)
    }

    pub async fn apply_dataset(
        &self,
        command: DatasetDisplayCommand,
        from_peer: Option<ClientId>,
        wait: Duration,
    ) -> Result<DatasetPresenceResult, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let result = apply_dataset_presence_command(&snapshot, command, from_peer)?;

        if result.break_follow {
            send_client_message(&mut write, &ClientMessage::Follow { target: None }).await?;
        }
        send_client_message(&mut write, &dataset_presence_message(&result)).await?;
        Ok(result)
    }
}

pub struct PeerWorkspaceClient {
    ws_url: String,
    token: Option<String>,
}

impl PeerWorkspaceClient {
    pub fn new(ws_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            ws_url: ws_url.into(),
            token: token.map(|effective| effective.token),
        }
    }

    pub async fn list(&self, wait: Duration) -> Result<PeerListResult, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (_write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        Ok(peer_list_result(&snapshot))
    }

    pub async fn follow_live<F>(
        &self,
        target: ClientId,
        wait: Duration,
        on_followed: F,
    ) -> Result<PeerFollowResult, CliError>
    where
        F: FnOnce(PeerFollowResult) -> Result<(), CliError>,
    {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        validate_follow_request(&snapshot, target)?;

        let before = own_presence(&snapshot)?.following;
        send_client_message(&mut write, &follow_message(Some(target))).await?;
        let changes =
            wait_for_follow_change(&mut incoming, snapshot.your_id, Some(target), wait).await?;
        let followed = PeerFollowResult {
            snapshot_seq: snapshot.seq,
            own_client_id: snapshot.your_id,
            accepted: true,
            changed: before != Some(target),
            requested_target: Some(target),
            current_target: Some(target),
            changes,
        };
        on_followed(followed)?;

        tokio::signal::ctrl_c().await.map_err(CliError::from)?;
        send_client_message(&mut write, &follow_message(None)).await?;
        let changes = wait_for_follow_change(&mut incoming, snapshot.your_id, None, wait).await?;
        Ok(PeerFollowResult {
            snapshot_seq: snapshot.seq,
            own_client_id: snapshot.your_id,
            accepted: true,
            changed: true,
            requested_target: None,
            current_target: None,
            changes,
        })
    }

    pub async fn cursor(
        &self,
        position: Option<[f64; 2]>,
        wait: Duration,
    ) -> Result<PeerCursorResult, CliError> {
        if let Some([x, y]) = position
            && (!x.is_finite() || !y.is_finite())
        {
            return Err(CliError::config("peer cursor coordinates must be finite"));
        }

        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        send_client_message(&mut write, &cursor_message(position)).await?;
        Ok(PeerCursorResult {
            snapshot_seq: snapshot.seq,
            own_client_id: snapshot.your_id,
            position,
        })
    }
}

pub struct ViewerProfileClient {
    base_url: String,
    ws_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl ViewerProfileClient {
    pub fn new(
        base_url: impl Into<String>,
        ws_url: impl Into<String>,
        token: Option<EffectiveToken>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            ws_url: ws_url.into(),
            token: token.map(|effective| effective.token),
            http: reqwest::Client::new(),
        }
    }

    pub async fn state(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
        wait: Duration,
    ) -> Result<ViewerProfileResult, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (_write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let record = self.ensure_profile(workspace, profile, &snapshot).await?;
        Ok(viewer_profile_result(&snapshot, record, None))
    }

    pub async fn apply(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
        command: ViewportCommand,
        wait: Duration,
    ) -> Result<ViewerProfileResult, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let break_follow = own_presence(&snapshot)?.following.is_some();
        let record = self.ensure_profile(workspace, profile, &snapshot).await?;

        let mut scene = scene_from_saved_view(&snapshot.document, &record.view);
        validate_viewport_indices(&scene, &command)?;
        apply_viewport_command(&mut scene, &command);
        let next_view = saved_view_from_scene(&snapshot.document, scene.clone());
        let record = self
            .upsert_profile(workspace, profile, None, &next_view)
            .await?;

        if break_follow {
            send_client_message(&mut write, &ClientMessage::Follow { target: None }).await?;
        }
        send_client_message(
            &mut write,
            &ClientMessage::Presence {
                camera: scene.camera,
                view: scene.view,
                display: scene.display,
            },
        )
        .await?;

        Ok(viewer_profile_result(&snapshot, record, Some(command)))
    }

    pub async fn dataset_state(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
        wait: Duration,
    ) -> Result<ViewerProfileResult, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (_write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let record = self.ensure_profile(workspace, profile, &snapshot).await?;
        Ok(viewer_profile_result(&snapshot, record, None))
    }

    pub async fn apply_dataset(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
        command: DatasetDisplayCommand,
        wait: Duration,
    ) -> Result<ViewerProfileResult, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let record = self.ensure_profile(workspace, profile, &snapshot).await?;

        let mut scene = scene_from_saved_view(&snapshot.document, &record.view);
        let viewport_command = display_viewport_command(&scene, command)?;
        scene.apply(CoreCommand::Viewport(viewport_command.clone()));
        let next_view = saved_view_from_scene(&snapshot.document, scene.clone());
        let record = self
            .upsert_profile(workspace, profile, None, &next_view)
            .await?;

        send_client_message(
            &mut write,
            &ClientMessage::DatasetPresence {
                dataset_order: scene.dataset_order,
                dataset_settings: scene.dataset_settings,
            },
        )
        .await?;

        Ok(viewer_profile_result(
            &snapshot,
            record,
            Some(viewport_command),
        ))
    }

    pub async fn overview(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
        viewport: [u32; 2],
        wait: Duration,
    ) -> Result<ViewerProfileResult, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let record = self.ensure_profile(workspace, profile, &snapshot).await?;

        let mut scene = scene_from_saved_view(&snapshot.document, &record.view);
        apply_overview_to_scene(&mut scene, viewport)?;
        let next_view = saved_view_from_scene(&snapshot.document, scene.clone());
        let record = self
            .upsert_profile(workspace, profile, None, &next_view)
            .await?;

        send_client_message(
            &mut write,
            &ClientMessage::Presence {
                camera: scene.camera,
                view: scene.view,
                display: scene.display,
            },
        )
        .await?;

        Ok(viewer_profile_result(&snapshot, record, None))
    }

    pub async fn plan_visible_chunks(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
        from_peer: Option<ClientId>,
        dataset: Option<&str>,
        wait: Duration,
    ) -> Result<PlanVisibleChunksResult, CliError> {
        let diagnostic = self
            .diagnostic_scene(workspace, profile, from_peer, wait)
            .await?;
        plan_visible_chunks_result(
            &diagnostic.snapshot,
            diagnostic.source,
            &diagnostic.scene,
            dataset,
        )
    }

    pub async fn debug_state(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
        from_peer: Option<ClientId>,
        wait: Duration,
    ) -> Result<DebugStateResult, CliError> {
        let diagnostic = self
            .diagnostic_scene(workspace, profile, from_peer, wait)
            .await?;
        Ok(debug_state_result(
            &diagnostic.snapshot,
            diagnostic.source,
            &diagnostic.scene,
        ))
    }

    async fn diagnostic_scene(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
        from_peer: Option<ClientId>,
        wait: Duration,
    ) -> Result<DiagnosticScene, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (_write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;

        if let Some(client_id) = from_peer {
            let presence = find_presence(&snapshot, client_id).ok_or_else(|| {
                CliError::new(
                    ErrorKind::MissingResource,
                    format!("no live peer with client id {client_id}"),
                )
            })?;
            let scene = scene_from_presence(&snapshot.document, presence);
            return Ok(DiagnosticScene {
                source: DiagnosticViewSource {
                    kind: DiagnosticViewSourceKind::Peer,
                    client_id: Some(client_id),
                    profile: None,
                    user_email: None,
                    seed_source: None,
                },
                snapshot,
                scene,
            });
        }

        let record = self.ensure_profile(workspace, profile, &snapshot).await?;
        let scene = scene_from_saved_view(&snapshot.document, &record.view);
        Ok(DiagnosticScene {
            source: DiagnosticViewSource {
                kind: DiagnosticViewSourceKind::ViewerProfile,
                client_id: None,
                profile: Some(record.profile),
                user_email: Some(record.user_email),
                seed_source: record.seed_source,
            },
            snapshot,
            scene,
        })
    }

    async fn ensure_profile(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
        snapshot: &WorkspacePresenceSnapshot,
    ) -> Result<WorkspaceViewerProfileRecord, CliError> {
        if let Some(record) = self.get_profile(workspace, profile).await? {
            return Ok(record);
        }

        let (view, seed_source) = self.seed_view(workspace, snapshot).await?;
        self.upsert_profile(workspace, profile, Some(seed_source.as_str()), &view)
            .await
    }

    async fn seed_view(
        &self,
        workspace: &WorkspaceRecord,
        snapshot: &WorkspacePresenceSnapshot,
    ) -> Result<(SavedView, String), CliError> {
        if let Some(default_saved_view_id) = workspace.default_saved_view_id.as_deref() {
            let saved_view = self
                .get_saved_view_seed(workspace, default_saved_view_id)
                .await?;
            return Ok((
                saved_view.view,
                format!("default_saved_view:{default_saved_view_id}"),
            ));
        }

        let own_presence = own_presence(snapshot)?;
        let scene = scene_from_presence(&snapshot.document, own_presence);
        Ok((
            saved_view_from_scene(&snapshot.document, scene),
            "workspace_snapshot".to_string(),
        ))
    }

    async fn get_profile(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
    ) -> Result<Option<WorkspaceViewerProfileRecord>, CliError> {
        let response = self
            .send(
                self.http
                    .get(viewer_profile_url(&self.base_url, &workspace.id, profile)?),
            )
            .await?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        decode_viewer_profile_json(response, "viewer profile get")
            .await
            .map(Some)
    }

    async fn upsert_profile(
        &self,
        workspace: &WorkspaceRecord,
        profile: &str,
        seed_source: Option<&str>,
        view: &SavedView,
    ) -> Result<WorkspaceViewerProfileRecord, CliError> {
        let body = UpsertViewerProfileBody { view, seed_source };
        let response = self
            .send(
                self.http
                    .put(viewer_profile_url(&self.base_url, &workspace.id, profile)?)
                    .json(&body),
            )
            .await?;
        decode_viewer_profile_json(response, "viewer profile upsert").await
    }

    async fn get_saved_view_seed(
        &self,
        workspace: &WorkspaceRecord,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedViewSeedRecord, CliError> {
        let response = self
            .send(self.http.get(saved_view_item_url(
                &self.base_url,
                &workspace.id,
                saved_view_id,
            )?))
            .await?;
        decode_viewer_profile_json(response, "saved view seed get").await
    }

    async fn send(
        &self,
        mut request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, CliError> {
        if let Some(token) = self.token.as_deref() {
            request = request.bearer_auth(token);
        }
        let response = request
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let body = response.text().await.unwrap_or_default();
        Err(map_viewer_profile_http_error(status, &body))
    }
}

pub fn format_view_apply_human(output: &ViewApplyOutput) -> String {
    format!(
        "Updated presence: {}\nWorkspace: {} ({})\nClient: {}\nSource: {}\nCamera: {}\nView: {}",
        viewport_command_label(&output.result.command),
        output.workspace.name,
        output.workspace.id,
        output.result.own_client_id,
        format_source(&output.result.source),
        format_camera(&output.result.camera),
        format_view(&output.result.view)
    )
}

pub fn format_dataset_presence_human(output: &DatasetPresenceOutput) -> String {
    let header = if let Some(command) = &output.result.command {
        format!(
            "Updated dataset presence: {}",
            viewport_command_label(command)
        )
    } else {
        "Dataset layers".to_string()
    };
    let multi = if output.result.multi_channel {
        "enabled"
    } else {
        "disabled"
    };
    if output.result.layers.is_empty() {
        return format!(
            "{header}\nWorkspace: {} ({})\nSource: {}\nMulti-channel: {multi}\nNo datasets loaded",
            output.workspace.name,
            output.workspace.id,
            format_source(&output.result.source)
        );
    }
    let layers = output
        .result
        .layers
        .iter()
        .map(|layer| {
            let detail = layer
                .detail_level_override
                .map(|level| level.to_string())
                .unwrap_or_else(|| "auto".to_string());
            let channels = layer
                .channels
                .iter()
                .map(|channel| {
                    format!(
                        "  ch{} visible={} colormap={:?} contrast={:.3}..{:.3} gamma={:.3}",
                        channel.channel,
                        channel.visible,
                        channel.colormap,
                        channel.contrast_min,
                        channel.contrast_max,
                        channel.gamma
                    )
                })
                .collect::<Vec<_>>();
            let mut line = format!(
                "{}  {}  visible={} opacity={:.3} blend={:?} render={:?} detail={} channels={}",
                layer.workspace_dataset_id,
                layer.name,
                layer.visible,
                layer.opacity,
                layer.blend_mode,
                layer.render_mode,
                detail,
                layer.channel_count
            );
            if !channels.is_empty() {
                line.push('\n');
                line.push_str(&channels.join("\n"));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{header}\nWorkspace: {} ({})\nSource: {}\nMulti-channel: {multi}\n{}",
        output.workspace.name,
        output.workspace.id,
        format_source(&output.result.source),
        layers
    )
}

pub fn format_peer_list_human(output: &PeerListOutput) -> String {
    let mut lines = vec![
        "Peers".to_string(),
        format!(
            "Workspace: {} ({})",
            output.workspace.name, output.workspace.id
        ),
        format!("Snapshot: {}", output.result.snapshot_seq),
        format!("Your client: {}", output.result.own_client_id),
    ];
    if output.result.peers.is_empty() {
        lines.push("No live peers".to_string());
    } else {
        lines.extend(output.result.peers.iter().map(format_peer_summary));
    }
    lines.join("\n")
}

pub fn format_peer_follow_human(output: &PeerFollowOutput) -> String {
    let action = if output.result.requested_target.is_some() {
        "Follow accepted"
    } else if output.result.changed {
        "Unfollow accepted"
    } else {
        "Already not following"
    };
    let target = output
        .result
        .current_target
        .map(|target| target.to_string())
        .unwrap_or_else(|| "none".to_string());
    let mut lines = vec![
        action.to_string(),
        format!(
            "Workspace: {} ({})",
            output.workspace.name, output.workspace.id
        ),
        format!("Client: {}", output.result.own_client_id),
        format!("Current following: {target}"),
    ];
    if !output.result.changes.is_empty() {
        let changes = output
            .result
            .changes
            .iter()
            .map(|change| {
                let target = change
                    .target
                    .map(|target| target.to_string())
                    .unwrap_or_else(|| "none".to_string());
                format!("{}->{target}", change.client_id)
            })
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Confirmed changes: {changes}"));
    }
    lines.join("\n")
}

pub fn format_peer_cursor_human(output: &PeerCursorOutput) -> String {
    let cursor = output
        .result
        .position
        .map(|[x, y]| format!("({x:.3}, {y:.3})"))
        .unwrap_or_else(|| "cleared".to_string());
    format!(
        "Cursor diagnostic sent\nWorkspace: {} ({})\nClient: {}\nCursor: {}",
        output.workspace.name, output.workspace.id, output.result.own_client_id, cursor
    )
}

pub fn format_plan_visible_chunks_human(output: &PlanVisibleChunksOutput) -> String {
    let mut lines = vec![
        "Visible chunks".to_string(),
        format!(
            "Workspace: {} ({})",
            output.workspace.name, output.workspace.id
        ),
        format!(
            "Source: {}",
            format_diagnostic_source(&output.result.source)
        ),
        format!("Diagnostic: {}", output.result.diagnostic_kind),
        format!("Web planner equivalent: {}", output.result.planner_parity),
    ];
    if output.result.datasets.is_empty() {
        lines.push("No datasets loaded".to_string());
    } else {
        for dataset in &output.result.datasets {
            let generated = dataset
                .generated_availability
                .as_ref()
                .map(format_generated_availability_summary)
                .unwrap_or_else(|| "generated=none".to_string());
            lines.push(format!(
                "{}  {}  visible={} multichannel={} members={} plans={} {}",
                dataset.dataset_id,
                dataset.name,
                dataset.visible,
                dataset.multi_channel,
                dataset.active_members.len(),
                dataset.member_plans.len(),
                generated
            ));
            for member in &dataset.member_plans {
                lines.push(format!(
                    "  member {} pos=({:.3}, {:.3}) visible={} prefetch={}",
                    member.image_id,
                    member.position[0],
                    member.position[1],
                    member.needed_count,
                    member.prefetch_count
                ));
                for tier in &member.tiers {
                    lines.push(format!(
                        "    tier={} level={} chunks={}",
                        tier.tier, tier.level_index, tier.count
                    ));
                }
            }
        }
    }
    lines.push(format!("Caveats: {}", output.result.caveats.join("; ")));
    lines.join("\n")
}

pub fn format_debug_state_human(output: &DebugStateOutput) -> String {
    let mut lines = vec![
        "Debug state".to_string(),
        format!(
            "Workspace: {} ({})",
            output.workspace.name, output.workspace.id
        ),
        format!("Snapshot: {}", output.result.snapshot_seq),
        format!(
            "Source: {}",
            format_diagnostic_source(&output.result.source)
        ),
        format!("Diagnostic: {}", output.result.diagnostic_kind),
        format!("Camera: {}", format_camera(&output.result.viewer.camera)),
        format!("View: {}", format_view(&output.result.viewer.view)),
        format!("Display: {}", format_display(&output.result.viewer.display)),
        format!(
            "Datasets: {}  Peers: {}  Generated datasets: {}",
            output.result.datasets.len(),
            output.result.peers.len(),
            output.result.generated_availability.len()
        ),
    ];
    for dataset in &output.result.datasets {
        let layout = dataset.active_layout_id.as_deref().unwrap_or("default");
        lines.push(format!(
            "{}  {}  visible={} members={} layout={} generated_levels={} generated_chunks={}",
            dataset.dataset_id,
            dataset.name,
            dataset.visible,
            dataset.member_count,
            layout,
            dataset.generated_level_count,
            dataset.generated_chunk_count
        ));
    }
    lines.push(format!("Caveats: {}", output.result.caveats.join("; ")));
    lines.join("\n")
}

pub fn format_viewer_profile_human(output: &ViewerProfileOutput) -> String {
    let header = if let Some(command) = &output.result.command {
        format!(
            "Updated viewer profile: {}",
            viewport_command_label(command)
        )
    } else {
        "Viewer profile".to_string()
    };
    let multi = if output.result.multi_channel {
        "enabled"
    } else {
        "disabled"
    };
    let seed = output
        .result
        .seed_source
        .as_deref()
        .unwrap_or("existing_profile");
    let mut lines = vec![
        format!("{header}: {}", output.result.profile),
        format!(
            "Workspace: {} ({})",
            output.workspace.name, output.workspace.id
        ),
        format!("Client: {}", output.result.own_client_id),
        format!("Seed: {seed}"),
        format!("Updated: {}", output.result.updated_at),
        format!("Camera: {}", format_camera(&output.result.camera)),
        format!("View: {}", format_view(&output.result.view)),
        format!("Multi-channel: {multi}"),
    ];
    if output.result.layers.is_empty() {
        lines.push("No datasets loaded".to_string());
    } else {
        lines.push(format_layers(&output.result.layers));
    }
    lines.join("\n")
}

fn format_layers(layers: &[LayerState]) -> String {
    layers
        .iter()
        .map(|layer| {
            let detail = layer
                .detail_level_override
                .map(|level| level.to_string())
                .unwrap_or_else(|| "auto".to_string());
            let channels = layer
                .channels
                .iter()
                .map(|channel| {
                    format!(
                        "  ch{} visible={} colormap={:?} contrast={:.3}..{:.3} gamma={:.3}",
                        channel.channel,
                        channel.visible,
                        channel.colormap,
                        channel.contrast_min,
                        channel.contrast_max,
                        channel.gamma
                    )
                })
                .collect::<Vec<_>>();
            let mut line = format!(
                "{}  {}  visible={} opacity={:.3} blend={:?} render={:?} detail={} channels={}",
                layer.workspace_dataset_id,
                layer.name,
                layer.visible,
                layer.opacity,
                layer.blend_mode,
                layer.render_mode,
                detail,
                layer.channel_count
            );
            if !channels.is_empty() {
                line.push('\n');
                line.push_str(&channels.join("\n"));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn apply_presence_command(
    snapshot: &WorkspacePresenceSnapshot,
    command: ViewportCommand,
    from_peer: Option<ClientId>,
) -> Result<ViewApplyResult, CliError> {
    let own_presence = find_presence(snapshot, snapshot.your_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::Protocol,
            "workspace snapshot did not include the CLI client presence",
        )
    })?;
    let source_client_id = from_peer.unwrap_or(snapshot.your_id);
    let source_presence = find_presence(snapshot, source_client_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::MissingResource,
            format!("no peer presence found for client {source_client_id}"),
        )
    })?;

    let mut scene = scene_from_presence(&snapshot.document, source_presence);
    validate_viewport_indices(&scene, &command)?;
    apply_viewport_command(&mut scene, &command);

    Ok(ViewApplyResult {
        snapshot_seq: snapshot.seq,
        own_client_id: snapshot.your_id,
        source: ViewPresenceSource {
            client_id: source_client_id,
            kind: if source_client_id == snapshot.your_id {
                ViewPresenceSourceKind::Own
            } else {
                ViewPresenceSourceKind::Peer
            },
        },
        command,
        camera: scene.camera,
        view: scene.view,
        display: scene.display,
        break_follow: own_presence.following.is_some(),
    })
}

fn dataset_presence_state(
    snapshot: &WorkspacePresenceSnapshot,
    from_peer: Option<ClientId>,
) -> Result<DatasetPresenceResult, CliError> {
    let own_presence = find_presence(snapshot, snapshot.your_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::Protocol,
            "workspace snapshot did not include the CLI client presence",
        )
    })?;
    let source_client_id = from_peer.unwrap_or(snapshot.your_id);
    let source_presence = find_presence(snapshot, source_client_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::MissingResource,
            format!("no peer presence found for client {source_client_id}"),
        )
    })?;
    let scene = scene_from_presence(&snapshot.document, source_presence);
    Ok(dataset_presence_result(
        snapshot,
        source_client_id,
        own_presence,
        None,
        scene,
    ))
}

fn apply_dataset_presence_command(
    snapshot: &WorkspacePresenceSnapshot,
    command: DatasetDisplayCommand,
    from_peer: Option<ClientId>,
) -> Result<DatasetPresenceResult, CliError> {
    let own_presence = find_presence(snapshot, snapshot.your_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::Protocol,
            "workspace snapshot did not include the CLI client presence",
        )
    })?;
    let source_client_id = from_peer.unwrap_or(snapshot.your_id);
    let source_presence = find_presence(snapshot, source_client_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::MissingResource,
            format!("no peer presence found for client {source_client_id}"),
        )
    })?;

    let mut scene = scene_from_presence(&snapshot.document, source_presence);
    let viewport_command = display_viewport_command(&scene, command)?;
    scene.apply(CoreCommand::Viewport(viewport_command.clone()));

    Ok(dataset_presence_result(
        snapshot,
        source_client_id,
        own_presence,
        Some(viewport_command),
        scene,
    ))
}

fn dataset_presence_result(
    snapshot: &WorkspacePresenceSnapshot,
    source_client_id: ClientId,
    own_presence: &PresenceState,
    command: Option<ViewportCommand>,
    scene: Scene,
) -> DatasetPresenceResult {
    let source = ViewPresenceSource {
        client_id: source_client_id,
        kind: if source_client_id == snapshot.your_id {
            ViewPresenceSourceKind::Own
        } else {
            ViewPresenceSourceKind::Peer
        },
    };
    DatasetPresenceResult {
        snapshot_seq: snapshot.seq,
        own_client_id: snapshot.your_id,
        source,
        command,
        multi_channel: scene.view.multi_channel,
        layers: layer_states(&scene),
        dataset_order: scene.dataset_order,
        dataset_settings: scene.dataset_settings,
        break_follow: own_presence.following.is_some(),
    }
}

fn scene_from_presence(document: &DocumentState, presence: &PresenceState) -> Scene {
    let mut scene = Scene::new(presence.camera.viewport());
    scene.document = document.clone();
    scene.camera = presence.camera.clone();
    scene.view = presence.view.clone();
    scene.display = presence.display.clone();
    scene.dataset_order = presence.dataset_order.clone();
    scene.dataset_settings = presence.dataset_settings.clone();
    hydrate_scene_document_defaults(&mut scene);
    scene
}

fn scene_from_saved_view(document: &DocumentState, view: &SavedView) -> Scene {
    let mut scene = Scene::new(view.camera.viewport());
    scene.document = document.clone();
    scene.camera = view.camera.clone();
    scene.view = view.view.clone();
    scene.display = view.display.clone();
    scene.dataset_order = view.dataset_order.clone();
    scene.dataset_settings = view.dataset_settings.clone();
    hydrate_scene_document_defaults(&mut scene);
    scene
}

fn saved_view_from_scene(document: &DocumentState, scene: Scene) -> SavedView {
    SavedView {
        v: SAVED_VIEW_VERSION,
        datasets: Vec::new(),
        active_layouts: active_layouts_from_document(document),
        camera: scene.camera,
        view: scene.view,
        display: scene.display,
        dataset_order: scene.dataset_order,
        dataset_settings: scene.dataset_settings,
        auto_contrast: HashMap::new(),
    }
}

fn apply_overview_to_scene(scene: &mut Scene, viewport: [u32; 2]) -> Result<(), CliError> {
    if viewport[0] == 0 || viewport[1] == 0 {
        return Err(CliError::config("overview viewport must be positive"));
    }
    let bounds = scene.visible_content_bounds_2d().ok_or_else(|| {
        CliError::new(
            ErrorKind::MissingResource,
            "no visible image dataset is available for overview",
        )
    })?;
    let width = bounds.width();
    let height = bounds.height();
    if width <= 0.0 || height <= 0.0 {
        return Err(CliError::new(
            ErrorKind::MissingResource,
            "visible image dataset has invalid XY dimensions",
        ));
    }

    let zoom_x = viewport[0] as f64 / width;
    let zoom_y = viewport[1] as f64 / height;
    let zoom = zoom_x.min(zoom_y).max(f64::EPSILON) * 0.9;
    apply_viewport_command(scene, &ViewportCommand::SetMode2D);
    apply_viewport_command(
        scene,
        &ViewportCommand::SetViewport {
            width: viewport[0],
            height: viewport[1],
        },
    );
    apply_viewport_command(
        scene,
        &ViewportCommand::SetCenter {
            x: bounds.center_x(),
            y: bounds.center_y(),
        },
    );
    apply_viewport_command(scene, &ViewportCommand::SetZoom { value: zoom });
    let z = bounds.max_depth.saturating_sub(1) / 2;
    apply_viewport_command(scene, &ViewportCommand::SetZ { z });
    Ok(())
}

fn active_layouts_from_document(
    document: &DocumentState,
) -> HashMap<DatasetId, lucida_content::LayoutId> {
    document
        .manifests
        .iter()
        .filter_map(|(dataset_id, manifest)| {
            let layout = document
                .active_layout_ids
                .get(dataset_id)
                .or(manifest.default_layout_id.as_ref())
                .or_else(|| manifest.source_layouts().first().map(|layout| &layout.id))?;
            Some((dataset_id.clone(), layout.clone()))
        })
        .collect()
}

fn hydrate_scene_document_defaults(scene: &mut Scene) {
    for id in scene.document.manifests.keys() {
        if !scene.dataset_order.contains(id) {
            scene.dataset_order.push(id.clone());
        }
        scene.dataset_settings.entry(id.clone()).or_default();
    }
    let dataset_ids = scene
        .document
        .manifests
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    scene.dataset_order.retain(|id| dataset_ids.contains(id));
    scene
        .dataset_settings
        .retain(|id, _| dataset_ids.contains(id));
    scene.rebuild_derived();
}

fn apply_viewport_command(scene: &mut Scene, command: &ViewportCommand) {
    match command {
        ViewportCommand::Rotate3D { .. }
        | ViewportCommand::Zoom3D { .. }
        | ViewportCommand::Pan3D { .. } => {
            scene.apply(CoreCommand::Viewport(ViewportCommand::SetMode3D))
        }
        ViewportCommand::FlyTick { .. } => {
            scene.apply(CoreCommand::Viewport(ViewportCommand::SetModeFly))
        }
        _ => {}
    }
    scene.apply(CoreCommand::Viewport(command.clone()));
}

#[derive(Debug, Clone, Copy)]
struct ViewIndexBounds {
    t: u32,
    c: u32,
    z: u32,
}

fn validate_viewport_indices(scene: &Scene, command: &ViewportCommand) -> Result<(), CliError> {
    let Some(bounds) = visible_view_index_bounds(scene) else {
        return Ok(());
    };

    match command {
        ViewportCommand::SetZ { z } if *z >= bounds.z => Err(view_index_error("Z", *z, bounds.z)),
        ViewportCommand::SetZRange { start, end } => {
            if *start >= bounds.z || *end > bounds.z {
                return Err(CliError::config(format!(
                    "visible datasets have {count} Z plane(s); requested Z range {start}..{end}",
                    count = bounds.z,
                )));
            }
            Ok(())
        }
        ViewportCommand::SetT { t } if *t >= bounds.t => Err(view_index_error("T", *t, bounds.t)),
        ViewportCommand::SetC { c } if *c >= bounds.c => Err(view_index_error("C", *c, bounds.c)),
        _ => Ok(()),
    }
}

fn view_index_error(axis: &str, requested: u32, count: u32) -> CliError {
    CliError::config(format!(
        "visible datasets have {count} {axis} value(s); requested {axis} index {requested}"
    ))
}

fn visible_view_index_bounds(scene: &Scene) -> Option<ViewIndexBounds> {
    let mut bounds: Option<ViewIndexBounds> = None;
    for id in &scene.dataset_order {
        let settings = scene.dataset_settings.get(id).cloned().unwrap_or_default();
        if !settings.visible {
            continue;
        }
        let Some(manifest) = scene.document.manifests.get(id) else {
            continue;
        };
        let Some(level) = manifest
            .images()
            .first()
            .and_then(|image| image.multiscale.levels.first())
        else {
            continue;
        };
        let current = ViewIndexBounds {
            t: shape_count_to_u32(level.shape[0]),
            c: shape_count_to_u32(level.shape[1]),
            z: shape_count_to_u32(level.shape[2]),
        };
        bounds = Some(if let Some(existing) = bounds {
            ViewIndexBounds {
                t: existing.t.min(current.t),
                c: existing.c.min(current.c),
                z: existing.z.min(current.z),
            }
        } else {
            current
        });
    }
    bounds
}

fn shape_count_to_u32(value: u64) -> u32 {
    value.min(u32::MAX as u64) as u32
}

fn display_viewport_command(
    scene: &Scene,
    command: DatasetDisplayCommand,
) -> Result<ViewportCommand, CliError> {
    Ok(match command {
        DatasetDisplayCommand::SetOrder { selectors } => {
            let mut order = resolve_dataset_ids(&scene.document, &selectors)?;
            for id in &scene.dataset_order {
                if !order.contains(id) {
                    order.push(id.clone());
                }
            }
            ViewportCommand::SetDatasetOrder {
                order: order.into_iter().map(|id| id.0).collect(),
            }
        }
        DatasetDisplayCommand::SetDatasetVisible { selector, visible } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            ViewportCommand::SetDatasetVisible {
                dataset_id: dataset_id.0,
                visible,
            }
        }
        DatasetDisplayCommand::SetDatasetOpacity { selector, opacity } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            ViewportCommand::SetDatasetOpacity {
                dataset_id: dataset_id.0,
                opacity,
            }
        }
        DatasetDisplayCommand::SetCurrentChannelContrast {
            selector,
            channel,
            min,
            max,
        } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            let channel = resolve_channel(
                &scene.document,
                &dataset_id,
                channel.unwrap_or(scene.view.c),
            )?;
            ViewportCommand::SetChannelContrast {
                dataset_id: dataset_id.0,
                channel,
                min,
                max,
            }
        }
        DatasetDisplayCommand::SetCurrentChannelGamma {
            selector,
            channel,
            gamma,
        } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            let channel = resolve_channel(
                &scene.document,
                &dataset_id,
                channel.unwrap_or(scene.view.c),
            )?;
            ViewportCommand::SetChannelGamma {
                dataset_id: dataset_id.0,
                channel,
                gamma,
            }
        }
        DatasetDisplayCommand::SetCurrentChannelColormap {
            selector,
            channel,
            colormap,
        } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            let channel = resolve_channel(
                &scene.document,
                &dataset_id,
                channel.unwrap_or(scene.view.c),
            )?;
            ViewportCommand::SetChannelColormap {
                dataset_id: dataset_id.0,
                channel,
                colormap,
            }
        }
        DatasetDisplayCommand::SetDatasetBlendMode {
            selector,
            blend_mode,
        } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            ViewportCommand::SetDatasetBlendMode {
                dataset_id: dataset_id.0,
                blend_mode,
            }
        }
        DatasetDisplayCommand::SetDatasetRenderMode {
            selector,
            render_mode,
        } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            ViewportCommand::SetDatasetRenderMode {
                dataset_id: dataset_id.0,
                render_mode,
            }
        }
        DatasetDisplayCommand::SetDatasetDetailLevelOverride { selector, level } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            ViewportCommand::SetDatasetDetailLevelOverride {
                dataset_id: dataset_id.0,
                level,
            }
        }
        DatasetDisplayCommand::SetChannelVisible {
            selector,
            channel,
            visible,
        } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            let channel = resolve_channel(&scene.document, &dataset_id, channel)?;
            ViewportCommand::SetChannelVisible {
                dataset_id: dataset_id.0,
                channel,
                visible,
            }
        }
        DatasetDisplayCommand::SetChannelColormap {
            selector,
            channel,
            colormap,
        } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            let channel = resolve_channel(&scene.document, &dataset_id, channel)?;
            ViewportCommand::SetChannelColormap {
                dataset_id: dataset_id.0,
                channel,
                colormap,
            }
        }
        DatasetDisplayCommand::SetChannelContrast {
            selector,
            channel,
            min,
            max,
        } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            let channel = resolve_channel(&scene.document, &dataset_id, channel)?;
            ViewportCommand::SetChannelContrast {
                dataset_id: dataset_id.0,
                channel,
                min,
                max,
            }
        }
        DatasetDisplayCommand::SetChannelGamma {
            selector,
            channel,
            gamma,
        } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            let channel = resolve_channel(&scene.document, &dataset_id, channel)?;
            ViewportCommand::SetChannelGamma {
                dataset_id: dataset_id.0,
                channel,
                gamma,
            }
        }
        DatasetDisplayCommand::SetChannelBlendMode {
            selector,
            blend_mode,
        } => {
            let dataset_id = resolve_dataset_id(&scene.document, &selector)?;
            ViewportCommand::SetChannelBlendMode {
                dataset_id: dataset_id.0,
                blend_mode,
            }
        }
    })
}

fn resolve_dataset_ids(
    document: &DocumentState,
    selectors: &[String],
) -> Result<Vec<DatasetId>, CliError> {
    let mut ids = Vec::new();
    for selector in selectors {
        let id = resolve_dataset_id(document, selector)?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn resolve_dataset_id(document: &DocumentState, selector: &str) -> Result<DatasetId, CliError> {
    if let Some((id, _)) = document.manifests.iter().find(|(id, _)| id.0 == selector) {
        return Ok(id.clone());
    }

    let matches = document
        .manifests
        .iter()
        .filter(|(_, manifest)| manifest.name == selector)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    match matches.len() {
        0 => Err(CliError::new(
            ErrorKind::MissingResource,
            format!("no dataset named or identified by {selector:?}"),
        )),
        1 => Ok(matches[0].clone()),
        _ => {
            let ids = matches
                .iter()
                .map(|id| id.0.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(CliError::new(
                ErrorKind::AmbiguousName,
                format!("dataset name {selector:?} is ambiguous; use one of: {ids}"),
            ))
        }
    }
}

fn resolve_channel(
    document: &DocumentState,
    dataset_id: &DatasetId,
    channel: u32,
) -> Result<u32, CliError> {
    let count = channel_count(document, dataset_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::MissingResource,
            format!("dataset {:?} has no image channel metadata", dataset_id.0),
        )
    })?;
    if channel >= count {
        return Err(CliError::new(
            ErrorKind::MissingResource,
            format!(
                "dataset {:?} has {count} channels; channel {channel} was requested",
                dataset_id.0
            ),
        ));
    }
    Ok(channel)
}

fn channel_count(document: &DocumentState, dataset_id: &DatasetId) -> Option<u32> {
    document
        .manifests
        .get(dataset_id)?
        .images()
        .first()?
        .multiscale
        .levels
        .first()
        .map(|level| level.shape[1] as u32)
}

fn layer_states(scene: &Scene) -> Vec<LayerState> {
    scene
        .dataset_order
        .iter()
        .filter_map(|id| {
            let manifest = scene.document.manifests.get(id)?;
            let default_settings;
            let settings = if let Some(settings) = scene.dataset_settings.get(id) {
                settings
            } else {
                default_settings = DatasetDisplaySettings::default();
                &default_settings
            };
            let channel_count = channel_count(&scene.document, id).unwrap_or(0);
            let channels = (0..channel_count)
                .map(|channel| channel_state(settings, channel))
                .collect();
            Some(LayerState {
                workspace_dataset_id: id.0.clone(),
                name: manifest.name.clone(),
                visible: settings.visible,
                opacity: settings.opacity,
                contrast_min: settings.contrast_min,
                contrast_max: settings.contrast_max,
                gamma: settings.gamma,
                blend_mode: settings.blend_mode,
                render_mode: settings.render_mode,
                detail_level_override: settings.detail_level_override,
                channel_blend_mode: settings.channel_blend_mode,
                channel_count,
                channels,
            })
        })
        .collect()
}

fn channel_state(settings: &DatasetDisplaySettings, channel: u32) -> ChannelState {
    let default_settings;
    let settings = if let Some(settings) = settings.channel_settings.get(channel as usize) {
        settings
    } else {
        default_settings = ChannelSettings {
            colormap: Colormap::default_for_channel(channel as usize),
            ..Default::default()
        };
        &default_settings
    };
    ChannelState {
        channel,
        visible: settings.visible,
        colormap: settings.colormap,
        contrast_min: settings.contrast_min,
        contrast_max: settings.contrast_max,
        gamma: settings.gamma,
    }
}

fn find_presence(
    snapshot: &WorkspacePresenceSnapshot,
    client_id: ClientId,
) -> Option<&PresenceState> {
    snapshot
        .peers
        .iter()
        .find(|presence| presence.client_id == client_id)
}

fn own_presence(snapshot: &WorkspacePresenceSnapshot) -> Result<&PresenceState, CliError> {
    find_presence(snapshot, snapshot.your_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::Protocol,
            "workspace snapshot did not include the CLI client presence",
        )
    })
}

fn peer_list_result(snapshot: &WorkspacePresenceSnapshot) -> PeerListResult {
    let peers = snapshot
        .peers
        .iter()
        .map(|presence| {
            let followers = snapshot
                .peers
                .iter()
                .filter(|candidate| candidate.following == Some(presence.client_id))
                .map(|candidate| candidate.client_id)
                .collect::<Vec<_>>();
            PeerSummary {
                client_id: presence.client_id,
                is_self: presence.client_id == snapshot.your_id,
                following: presence.following,
                followers,
                cursor: presence.cursor,
                camera: presence.camera.clone(),
                view: presence.view.clone(),
                display: presence.display.clone(),
                dataset_order: presence.dataset_order.clone(),
                dataset_settings_count: presence.dataset_settings.len(),
            }
        })
        .collect();
    PeerListResult {
        snapshot_seq: snapshot.seq,
        own_client_id: snapshot.your_id,
        peers,
    }
}

fn validate_follow_request(
    snapshot: &WorkspacePresenceSnapshot,
    target: ClientId,
) -> Result<(), CliError> {
    let own = own_presence(snapshot)?;
    if target == snapshot.your_id {
        return Err(CliError::new(
            ErrorKind::RejectedCommand,
            format!("cannot follow yourself (client {target})"),
        ));
    }

    let target_presence = find_presence(snapshot, target).ok_or_else(|| {
        CliError::new(
            ErrorKind::RejectedCommand,
            format!("cannot follow client {target}: no live peer with that client id"),
        )
    })?;

    if let Some(target_following) = target_presence.following {
        return Err(CliError::new(
            ErrorKind::RejectedCommand,
            format!(
                "cannot follow client {target}: target is already following client {target_following}"
            ),
        ));
    }

    if own.client_id != snapshot.your_id {
        return Err(CliError::new(
            ErrorKind::Protocol,
            "workspace snapshot own presence did not match your client id",
        ));
    }

    Ok(())
}

fn plan_visible_chunks_result(
    snapshot: &WorkspacePresenceSnapshot,
    source: DiagnosticViewSource,
    scene: &Scene,
    dataset: Option<&str>,
) -> Result<PlanVisibleChunksResult, CliError> {
    let dataset_ids = diagnostic_dataset_ids(&scene.document, &scene.dataset_order, dataset)?;
    let datasets = dataset_ids
        .iter()
        .filter_map(|dataset_id| plan_dataset_diagnostic(snapshot, scene, dataset_id))
        .collect();
    Ok(PlanVisibleChunksResult {
        snapshot_seq: snapshot.seq,
        own_client_id: snapshot.your_id,
        source,
        diagnostic_kind: "lower_level_scene_diagnostic",
        planner_parity: false,
        datasets,
        caveats: plan_diagnostic_caveats(),
    })
}

fn plan_dataset_diagnostic(
    snapshot: &WorkspacePresenceSnapshot,
    scene: &Scene,
    dataset_id: &DatasetId,
) -> Option<PlanDatasetDiagnostic> {
    let manifest = scene.document.manifests.get(dataset_id)?;
    let settings = scene
        .dataset_settings
        .get(dataset_id)
        .cloned()
        .unwrap_or_default();
    let member_plans = if settings.visible {
        scene
            .chunk_plan_for(dataset_id)
            .unwrap_or_default()
            .into_iter()
            .map(member_visible_chunks_diagnostic)
            .collect()
    } else {
        Vec::new()
    };
    Some(PlanDatasetDiagnostic {
        dataset_id: dataset_id.0.clone(),
        name: manifest.name.clone(),
        visible: settings.visible,
        multi_channel: scene.view.multi_channel,
        display: scene.display.clone(),
        active_layout_id: scene
            .document
            .active_layout_ids
            .get(dataset_id)
            .map(|layout_id| layout_id.0.clone()),
        active_members: active_member_diagnostics(scene, dataset_id),
        member_plans,
        generated_availability: snapshot
            .generated_availability
            .get(dataset_id)
            .map(generated_availability_diagnostic),
    })
}

fn debug_state_result(
    snapshot: &WorkspacePresenceSnapshot,
    source: DiagnosticViewSource,
    scene: &Scene,
) -> DebugStateResult {
    DebugStateResult {
        snapshot_seq: snapshot.seq,
        own_client_id: snapshot.your_id,
        source,
        diagnostic_kind: "workspace_scene_state",
        planner_parity: false,
        viewer: DebugViewerState {
            camera: scene.camera.clone(),
            view: scene.view.clone(),
            display: scene.display.clone(),
            multi_channel: scene.view.multi_channel,
            dataset_order: scene
                .dataset_order
                .iter()
                .map(|dataset_id| dataset_id.0.clone())
                .collect(),
        },
        datasets: debug_dataset_states(snapshot, scene),
        peers: peer_list_result(snapshot).peers,
        generated_availability: dataset_generated_availability(snapshot),
        caveats: debug_state_caveats(),
    }
}

fn diagnostic_dataset_ids(
    document: &DocumentState,
    dataset_order: &[DatasetId],
    dataset: Option<&str>,
) -> Result<Vec<DatasetId>, CliError> {
    if let Some(dataset) = dataset {
        return Ok(vec![resolve_dataset_id(document, dataset)?]);
    }

    let mut ids = dataset_order.to_vec();
    for id in document.manifests.keys() {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    Ok(ids)
}

fn debug_dataset_states(
    snapshot: &WorkspacePresenceSnapshot,
    scene: &Scene,
) -> Vec<DebugDatasetState> {
    diagnostic_dataset_ids(&scene.document, &scene.dataset_order, None)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|dataset_id| {
            let manifest = scene.document.manifests.get(&dataset_id)?;
            let settings = scene
                .dataset_settings
                .get(&dataset_id)
                .cloned()
                .unwrap_or_default();
            let availability = snapshot.generated_availability.get(&dataset_id);
            Some(DebugDatasetState {
                dataset_id: dataset_id.0.clone(),
                name: manifest.name.clone(),
                visible: settings.visible,
                member_count: scene
                    .derived
                    .get(&dataset_id)
                    .map(|derived| derived.members.len())
                    .unwrap_or(0),
                active_layout_id: scene
                    .document
                    .active_layout_ids
                    .get(&dataset_id)
                    .map(|layout_id| layout_id.0.clone()),
                generated_level_count: availability.map(|value| value.levels.len()).unwrap_or(0),
                generated_chunk_count: availability.map(|value| value.chunks.len()).unwrap_or(0),
            })
        })
        .collect()
}

fn active_member_diagnostics(scene: &Scene, dataset_id: &DatasetId) -> Vec<ActiveMemberDiagnostic> {
    scene
        .derived
        .get(dataset_id)
        .map(|derived| {
            derived
                .members
                .iter()
                .map(|member| ActiveMemberDiagnostic {
                    entity_id: member.entity_id.0.clone(),
                    image_id: member.image_id.0.clone(),
                    position: member.position,
                    level_indices: member
                        .levels
                        .iter()
                        .map(|level| level.level_index)
                        .collect(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn member_visible_chunks_diagnostic(
    plan: lucida_core::scene::MemberChunkPlan,
) -> MemberVisibleChunksDiagnostic {
    let mut tiers = chunk_tier_diagnostics("visible", &plan.needed);
    tiers.extend(chunk_tier_diagnostics("prefetch", &plan.prefetch));
    MemberVisibleChunksDiagnostic {
        image_id: plan.image_id.0,
        position: plan.position,
        needed_count: plan.needed.len(),
        prefetch_count: plan.prefetch.len(),
        tiers,
    }
}

fn chunk_tier_diagnostics(tier: &'static str, chunks: &[ChunkCoord]) -> Vec<ChunkTierDiagnostic> {
    let mut by_level = BTreeMap::<u32, Vec<ChunkCoord>>::new();
    for chunk in chunks {
        by_level.entry(chunk.level).or_default().push(chunk.clone());
    }
    by_level
        .into_iter()
        .map(|(level_index, chunks)| ChunkTierDiagnostic {
            tier,
            level_index,
            count: chunks.len(),
            chunks,
        })
        .collect()
}

fn dataset_generated_availability(
    snapshot: &WorkspacePresenceSnapshot,
) -> Vec<DatasetGeneratedAvailabilityDiagnostic> {
    snapshot
        .generated_availability
        .iter()
        .map(|(dataset_id, availability)| {
            let name = snapshot
                .document
                .manifests
                .get(dataset_id)
                .map(|manifest| manifest.name.clone())
                .unwrap_or_else(|| dataset_id.0.clone());
            DatasetGeneratedAvailabilityDiagnostic {
                dataset_id: dataset_id.0.clone(),
                name,
                availability: generated_availability_diagnostic(availability),
            }
        })
        .collect()
}

fn generated_availability_diagnostic(
    availability: &GeneratedAvailabilitySnapshot,
) -> GeneratedAvailabilityDiagnostic {
    GeneratedAvailabilityDiagnostic {
        level_count: availability.levels.len(),
        chunk_count: availability.chunks.len(),
        levels: availability
            .levels
            .iter()
            .map(|level| GeneratedLevelDiagnostic {
                image_id: level.image_id.0.clone(),
                level_index: level.info.level_index,
                role: format!("{:?}", level.info.role).to_ascii_lowercase(),
                generator: level.info.provenance.generator.clone(),
                config_id: level.info.provenance.config_id.clone(),
                summary: level.summary.clone(),
            })
            .collect(),
        chunk_status: generated_chunk_status_counts(availability),
    }
}

fn generated_chunk_status_counts(
    availability: &GeneratedAvailabilitySnapshot,
) -> GeneratedChunkStatusCounts {
    let mut counts = GeneratedChunkStatusCounts::default();
    for chunk in &availability.chunks {
        match chunk.status {
            GeneratedChunkStatus::Ready => counts.ready += 1,
            GeneratedChunkStatus::Pending => counts.pending += 1,
            GeneratedChunkStatus::Unavailable => counts.unavailable += 1,
            GeneratedChunkStatus::FailedTransient => counts.failed_transient += 1,
            GeneratedChunkStatus::FailedPermanent => counts.failed_permanent += 1,
        }
    }
    counts
}

fn plan_diagnostic_caveats() -> Vec<&'static str> {
    vec![
        "uses lucida-core Scene::chunk_plan_for for scene-visible source chunks",
        "does not run the web planner's lane priorities, active-set carry-forward, minimap path, CPU-cache filtering, or generated-coarse tier selection",
        "dataset visibility is applied before calling the scene chunk diagnostic",
    ]
}

fn debug_state_caveats() -> Vec<&'static str> {
    vec![
        "reports workspace snapshot and selected viewer scene state",
        "does not include browser renderer residency, CPU-cache state, or worker wanted-set state",
    ]
}

fn viewer_profile_result(
    snapshot: &WorkspacePresenceSnapshot,
    record: WorkspaceViewerProfileRecord,
    command: Option<ViewportCommand>,
) -> ViewerProfileResult {
    let scene = scene_from_saved_view(&snapshot.document, &record.view);
    let layers = layer_states(&scene);
    let multi_channel = scene.view.multi_channel;
    ViewerProfileResult {
        snapshot_seq: snapshot.seq,
        own_client_id: snapshot.your_id,
        profile: record.profile,
        user_email: record.user_email,
        created_at: record.created_at,
        updated_at: record.updated_at,
        seed_source: record.seed_source,
        command,
        camera: scene.camera,
        view: scene.view,
        display: scene.display,
        multi_channel,
        layers,
    }
}

fn presence_message(result: &ViewApplyResult) -> ClientMessage {
    ClientMessage::Presence {
        camera: result.camera.clone(),
        view: result.view.clone(),
        display: result.display.clone(),
    }
}

fn dataset_presence_message(result: &DatasetPresenceResult) -> ClientMessage {
    ClientMessage::DatasetPresence {
        dataset_order: result.dataset_order.clone(),
        dataset_settings: result.dataset_settings.clone(),
    }
}

fn follow_message(target: Option<ClientId>) -> ClientMessage {
    ClientMessage::Follow { target }
}

fn cursor_message(position: Option<[f64; 2]>) -> ClientMessage {
    ClientMessage::Cursor { position }
}

async fn send_client_message<W>(write: &mut W, message: &ClientMessage) -> Result<(), CliError>
where
    W: Sink<Message, Error = WebSocketError> + Unpin,
{
    let json = serde_json::to_string(message)?;
    write
        .send(Message::Text(json.into()))
        .await
        .map_err(map_websocket_error)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum IncomingViewMessage {
    Text(String),
    Close,
    Ignore,
}

fn incoming_messages<S>(read: S) -> impl Stream<Item = Result<IncomingViewMessage, CliError>>
where
    S: Stream<Item = Result<Message, WebSocketError>>,
{
    read.map(|message| match message {
        Ok(Message::Text(text)) => Ok(IncomingViewMessage::Text(text.to_string())),
        Ok(Message::Close(_)) => Ok(IncomingViewMessage::Close),
        Ok(_) => Ok(IncomingViewMessage::Ignore),
        Err(error) => Err(map_websocket_error(error)),
    })
}

async fn wait_for_workspace_snapshot<S>(
    messages: &mut S,
    wait: Duration,
) -> Result<WorkspacePresenceSnapshot, CliError>
where
    S: Stream<Item = Result<IncomingViewMessage, CliError>> + Unpin,
{
    tokio::time::timeout(wait, async {
        while let Some(message) = messages.next().await {
            match message? {
                IncomingViewMessage::Text(text) => {
                    let message: ServerMessage = serde_json::from_str(&text).map_err(|error| {
                        CliError::new(
                            ErrorKind::Protocol,
                            format!("invalid workspace server message: {error}"),
                        )
                    })?;
                    match message {
                        ServerMessage::Snapshot {
                            seq,
                            document,
                            peers,
                            your_id,
                            generated_availability,
                        } => {
                            return Ok(WorkspacePresenceSnapshot {
                                seq,
                                document,
                                peers,
                                your_id,
                                generated_availability,
                            });
                        }
                        ServerMessage::WorkspaceArchived { .. } => {
                            return Err(CliError::new(
                                ErrorKind::ArchivedWorkspace,
                                "workspace was archived before snapshot",
                            ));
                        }
                        _ => {}
                    }
                }
                IncomingViewMessage::Close => {
                    return Err(CliError::new(
                        ErrorKind::SessionDisconnect,
                        "workspace WebSocket closed before snapshot",
                    ));
                }
                IncomingViewMessage::Ignore => {}
            }
        }
        Err(CliError::new(
            ErrorKind::SessionDisconnect,
            "workspace WebSocket disconnected before snapshot",
        ))
    })
    .await
    .map_err(|_| {
        CliError::new(
            ErrorKind::SessionDisconnect,
            format!(
                "timed out waiting for workspace snapshot after {}s",
                wait.as_secs()
            ),
        )
    })?
}

async fn wait_for_follow_change<S>(
    messages: &mut S,
    client_id: ClientId,
    target: Option<ClientId>,
    wait: Duration,
) -> Result<Vec<PeerFollowChange>, CliError>
where
    S: Stream<Item = Result<IncomingViewMessage, CliError>> + Unpin,
{
    tokio::time::timeout(wait, async {
        let mut changes = Vec::new();
        while let Some(message) = messages.next().await {
            match message? {
                IncomingViewMessage::Text(text) => {
                    let message: ServerMessage = serde_json::from_str(&text).map_err(|error| {
                        CliError::new(
                            ErrorKind::Protocol,
                            format!("invalid workspace server message: {error}"),
                        )
                    })?;
                    match message {
                        ServerMessage::FollowChanged {
                            client_id: changed_client_id,
                            target: changed_target,
                        } => {
                            changes.push(PeerFollowChange {
                                client_id: changed_client_id,
                                target: changed_target,
                            });
                            if changed_client_id == client_id && changed_target == target {
                                return Ok(changes);
                            }
                        }
                        ServerMessage::WorkspaceArchived { .. } => {
                            return Err(CliError::new(
                                ErrorKind::ArchivedWorkspace,
                                "workspace was archived before follow confirmation",
                            ));
                        }
                        _ => {}
                    }
                }
                IncomingViewMessage::Close => {
                    return Err(CliError::new(
                        ErrorKind::SessionDisconnect,
                        "workspace WebSocket closed before follow confirmation",
                    ));
                }
                IncomingViewMessage::Ignore => {}
            }
        }
        Err(CliError::new(
            ErrorKind::SessionDisconnect,
            "workspace WebSocket disconnected before follow confirmation",
        ))
    })
    .await
    .map_err(|_| {
        CliError::new(
            ErrorKind::RejectedCommand,
            format!(
                "timed out waiting for follow confirmation after {}s",
                wait.as_secs()
            ),
        )
    })?
}

fn viewer_profile_url(
    server_url: &str,
    workspace_id: &str,
    profile: &str,
) -> Result<reqwest::Url, CliError> {
    api_url(
        server_url,
        &[
            "api",
            "workspaces",
            workspace_id,
            "viewer-profiles",
            profile,
        ],
    )
}

fn saved_view_item_url(
    server_url: &str,
    workspace_id: &str,
    saved_view_id: &str,
) -> Result<reqwest::Url, CliError> {
    api_url(
        server_url,
        &[
            "api",
            "workspaces",
            workspace_id,
            "saved-views",
            saved_view_id,
        ],
    )
}

fn api_url(server_url: &str, segments: &[&str]) -> Result<reqwest::Url, CliError> {
    let mut url = reqwest::Url::parse(server_url)
        .map_err(|error| CliError::invalid_server(format!("invalid server URL: {error}")))?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| CliError::invalid_server("server URL cannot be used as a base URL"))?;
        path.clear();
        for segment in segments {
            path.push(segment);
        }
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn workspace_ws_request(ws_url: &str, token: Option<&str>) -> Result<WsRequest<()>, CliError> {
    let mut request = ws_url.into_client_request().map_err(|error| {
        CliError::new(
            ErrorKind::InvalidServer,
            format!("invalid workspace WebSocket URL: {error}"),
        )
    })?;
    if let Some(token) = token {
        request.headers_mut().insert(
            AUTHORIZATION,
            format!("Bearer {token}").parse().map_err(|error| {
                CliError::new(
                    ErrorKind::Config,
                    format!("failed to build bearer authorization header: {error}"),
                )
            })?,
        );
    }
    Ok(request)
}

async fn decode_viewer_profile_json<T: DeserializeOwned>(
    response: reqwest::Response,
    context: &str,
) -> Result<T, CliError> {
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    if !content_type.contains("application/json") {
        return Err(CliError::new(
            ErrorKind::Protocol,
            format!("{context} returned {content_type}; expected application/json"),
        ));
    }
    response.json::<T>().await.map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("{context} response was not valid JSON: {error}"),
        )
    })
}

fn map_viewer_profile_http_error(status: reqwest::StatusCode, body: &str) -> CliError {
    let detail = response_detail(body);
    match status {
        reqwest::StatusCode::UNAUTHORIZED => CliError::new(
            ErrorKind::Unauthenticated,
            "not authenticated; run `lucida auth login`",
        ),
        reqwest::StatusCode::FORBIDDEN => CliError::new(
            ErrorKind::Unauthorized,
            detail.unwrap_or_else(|| "viewer profile request was forbidden".to_string()),
        ),
        reqwest::StatusCode::NOT_FOUND => CliError::new(
            ErrorKind::MissingResource,
            detail.unwrap_or_else(|| "viewer profile target was not found".to_string()),
        ),
        reqwest::StatusCode::BAD_REQUEST => CliError::new(
            ErrorKind::Config,
            detail.unwrap_or_else(|| "viewer profile request was invalid".to_string()),
        ),
        reqwest::StatusCode::CONFLICT | reqwest::StatusCode::GONE => CliError::new(
            ErrorKind::ArchivedWorkspace,
            detail.unwrap_or_else(|| "workspace is archived".to_string()),
        ),
        status => CliError::new(
            ErrorKind::Protocol,
            detail.unwrap_or_else(|| {
                format!(
                    "unexpected viewer profile response: HTTP {}",
                    status.as_u16()
                )
            }),
        ),
    }
}

fn response_detail(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    value
        .get("detail")
        .or_else(|| value.get("error"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

fn map_websocket_error(error: WebSocketError) -> CliError {
    match error {
        WebSocketError::Http(response) => match response.status() {
            WsStatusCode::UNAUTHORIZED => CliError::new(
                ErrorKind::Unauthenticated,
                "not authenticated; run `lucida auth login`",
            ),
            WsStatusCode::FORBIDDEN => CliError::new(
                ErrorKind::Unauthorized,
                "workspace WebSocket request was forbidden",
            ),
            WsStatusCode::NOT_FOUND => CliError::new(
                ErrorKind::MissingResource,
                "workspace WebSocket target was not found",
            ),
            WsStatusCode::GONE | WsStatusCode::CONFLICT => {
                CliError::new(ErrorKind::ArchivedWorkspace, "workspace is archived")
            }
            status => CliError::new(
                ErrorKind::SessionDisconnect,
                format!(
                    "workspace WebSocket upgrade failed with HTTP {}",
                    status.as_u16()
                ),
            ),
        },
        WebSocketError::ConnectionClosed | WebSocketError::AlreadyClosed => CliError::new(
            ErrorKind::SessionDisconnect,
            "workspace WebSocket disconnected",
        ),
        WebSocketError::Io(error) => CliError::new(
            ErrorKind::SessionDisconnect,
            format!("workspace WebSocket I/O failed: {error}"),
        ),
        other => CliError::new(
            ErrorKind::SessionDisconnect,
            format!("workspace WebSocket failed: {other}"),
        ),
    }
}

fn format_source(source: &ViewPresenceSource) -> String {
    match source.kind {
        ViewPresenceSourceKind::Own => format!("own client {}", source.client_id),
        ViewPresenceSourceKind::Peer => format!("peer client {}", source.client_id),
    }
}

fn format_diagnostic_source(source: &DiagnosticViewSource) -> String {
    match source.kind {
        DiagnosticViewSourceKind::ViewerProfile => {
            let profile = source.profile.as_deref().unwrap_or("unknown");
            let seed = source.seed_source.as_deref().unwrap_or("existing_profile");
            format!("viewer profile {profile} ({seed})")
        }
        DiagnosticViewSourceKind::Peer => {
            let client_id = source
                .client_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            format!("peer client {client_id}")
        }
    }
}

fn format_generated_availability_summary(availability: &GeneratedAvailabilityDiagnostic) -> String {
    format!(
        "generated=levels:{} chunks:{} ready:{} pending:{} failed:{}",
        availability.level_count,
        availability.chunk_count,
        availability.chunk_status.ready,
        availability.chunk_status.pending,
        availability.chunk_status.failed_transient + availability.chunk_status.failed_permanent
    )
}

fn format_camera(camera: &Camera) -> String {
    match camera {
        Camera::Slice(slice) => format!(
            "slice viewport={}x{} center=({:.3}, {:.3}) zoom={:.3}",
            slice.viewport[0], slice.viewport[1], slice.center[0], slice.center[1], slice.zoom
        ),
        Camera::Arcball(arcball) => format!(
            "arcball viewport={}x{} target=({:.3}, {:.3}, {:.3}) theta={:.3} phi={:.3} distance={:.3}",
            arcball.viewport[0],
            arcball.viewport[1],
            arcball.target[0],
            arcball.target[1],
            arcball.target[2],
            arcball.theta,
            arcball.phi,
            arcball.distance
        ),
        Camera::Fly(fly) => format!(
            "fly viewport={}x{} position=({:.3}, {:.3}, {:.3})",
            fly.viewport[0], fly.viewport[1], fly.position[0], fly.position[1], fly.position[2]
        ),
    }
}

fn format_view(view: &ViewState) -> String {
    format!(
        "T{} C{} Z{}..{}",
        view.t, view.c, view.z_range.start, view.z_range.end
    )
}

fn format_peer_summary(peer: &PeerSummary) -> String {
    let self_marker = if peer.is_self { " (you)" } else { "" };
    let following = peer
        .following
        .map(|target| target.to_string())
        .unwrap_or_else(|| "none".to_string());
    let followers = if peer.followers.is_empty() {
        "none".to_string()
    } else {
        peer.followers
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",")
    };
    let cursor = peer
        .cursor
        .map(|[x, y]| format!("({x:.3}, {y:.3})"))
        .unwrap_or_else(|| "none".to_string());
    format!(
        "{}{} following={} followers={} cursor={} datasets={} settings={} camera={} view={} display={}",
        peer.client_id,
        self_marker,
        following,
        followers,
        cursor,
        peer.dataset_order.len(),
        peer.dataset_settings_count,
        format_camera(&peer.camera),
        format_view(&peer.view),
        format_display(&peer.display)
    )
}

fn format_display(display: &DisplayState) -> String {
    format!(
        "contrast={:.3}..{:.3} gamma={:.3}",
        display.contrast_min, display.contrast_max, display.gamma
    )
}

fn viewport_command_label(command: &ViewportCommand) -> &'static str {
    match command {
        ViewportCommand::SetMode2D => "camera mode slice",
        ViewportCommand::SetMode3D => "camera mode arcball",
        ViewportCommand::SetModeFly => "camera mode fly",
        ViewportCommand::SetViewport { .. } => "view viewport-size",
        ViewportCommand::Pan { .. } => "view pan",
        ViewportCommand::ZoomBy { .. } => "view zoom",
        ViewportCommand::SetCenter { .. } => "view center",
        ViewportCommand::SetZoom { .. } => "view set-zoom",
        ViewportCommand::Rotate3D { .. } => "camera rotate",
        ViewportCommand::Zoom3D { .. } => "camera zoom",
        ViewportCommand::Pan3D { .. } => "camera pan",
        ViewportCommand::FlyTick { .. } => "camera fly-tick",
        ViewportCommand::SetZ { .. } => "view slice z",
        ViewportCommand::SetZRange { .. } => "view z-range",
        ViewportCommand::SetT { .. } => "view slice t",
        ViewportCommand::SetC { .. } => "view slice c",
        ViewportCommand::SetContrast { .. } => "view contrast",
        ViewportCommand::SetGamma { .. } => "view gamma",
        ViewportCommand::SetDatasetOrder { .. } => "layer order",
        ViewportCommand::SetDatasetVisible { .. } => "layer visibility",
        ViewportCommand::SetDatasetOpacity { .. } => "layer opacity",
        ViewportCommand::SetDatasetContrast { .. } => "layer contrast",
        ViewportCommand::SetDatasetGamma { .. } => "layer gamma",
        ViewportCommand::SetDatasetBlendMode { .. } => "layer blend-mode",
        ViewportCommand::SetDatasetRenderMode { .. } => "layer render-mode",
        ViewportCommand::SetDatasetDetailLevelOverride { .. } => "layer detail-level",
        ViewportCommand::SetMultiChannel { .. } => "channel mode",
        ViewportCommand::SetChannelVisible { .. } => "channel visibility",
        ViewportCommand::SetChannelColormap { .. } => "channel colormap",
        ViewportCommand::SetChannelContrast { .. } => "channel contrast",
        ViewportCommand::SetChannelGamma { .. } => "channel gamma",
        ViewportCommand::SetChannelBlendMode { .. } => "channel blend-mode",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use lucida_content::{
        GeneratedLevelInfo, GeneratedLevelProvenance, GeneratedLevelRole, LevelGeometry,
    };
    use lucida_core::ImageId;
    use lucida_core::camera::{Camera, Slice};
    use lucida_core::protocol::PresenceState;
    use lucida_core::scene::{DisplayState, DocumentState};
    use lucida_core::view::ViewState;
    use lucida_protocol::{
        GeneratedAvailabilitySnapshot, GeneratedChunkStatus, GeneratedChunkStatusUpdate,
        GeneratedLevelAvailability, GeneratedLevelSummary,
    };

    use crate::workspace::WorkspaceRole;

    use super::*;

    fn presence(client_id: ClientId, center: [f64; 2]) -> PresenceState {
        PresenceState {
            client_id,
            camera: Camera::Slice(Slice {
                center,
                zoom: 1.0,
                viewport: [800, 600],
            }),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: None,
            cursor: None,
            dataset_order: Vec::new(),
            dataset_settings: HashMap::new(),
        }
    }

    fn snapshot() -> WorkspacePresenceSnapshot {
        WorkspacePresenceSnapshot {
            seq: 12,
            document: DocumentState::default(),
            peers: vec![presence(7, [0.0, 0.0]), presence(9, [100.0, 200.0])],
            your_id: 7,
            generated_availability: HashMap::new(),
        }
    }

    fn document_with_two_datasets() -> DocumentState {
        serde_json::from_value(serde_json::json!({
            "manifests": {
                "wds-test": {
                    "dataset_id": "wds-test",
                    "name": "demo.zarr",
                    "kind": "Single",
                    "entities": [
                        {
                            "id": "entity-1",
                            "kind": "Image",
                            "parent": null,
                            "labels": { "name": "field-1" }
                        }
                    ],
                    "transforms": [],
                    "images": [
                        {
                            "image_id": "image-1",
                            "owner": "entity-1",
                            "multiscale": {
                                "axes": [],
                                "levels": [
                                    {
                                        "level_index": 0,
                                        "shape": [1, 3, 5, 64, 32],
                                        "chunk_shape": [1, 1, 1, 32, 32],
                                        "grid_shape": [1, 3, 5, 2, 1],
                                        "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                                    }
                                ],
                                "coarse_level_index": null,
                                "generated_levels": [],
                                "data_type": "Uint16",
                                "pinned_axes": []
                            }
                        }
                    ],
                    "source_layouts": [],
                    "default_layout_id": null
                },
                "wds-other": {
                    "dataset_id": "wds-other",
                    "name": "other.zarr",
                    "kind": "Single",
                    "entities": [
                        {
                            "id": "entity-2",
                            "kind": "Image",
                            "parent": null,
                            "labels": { "name": "field-2" }
                        }
                    ],
                    "transforms": [],
                    "images": [
                        {
                            "image_id": "image-2",
                            "owner": "entity-2",
                            "multiscale": {
                                "axes": [],
                                "levels": [
                                    {
                                        "level_index": 0,
                                        "shape": [1, 2, 4, 32, 32],
                                        "chunk_shape": [1, 1, 1, 32, 32],
                                        "grid_shape": [1, 2, 4, 1, 1],
                                        "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                                    }
                                ],
                                "coarse_level_index": null,
                                "generated_levels": [],
                                "data_type": "Uint16",
                                "pinned_axes": []
                            }
                        }
                    ],
                    "source_layouts": [],
                    "default_layout_id": null
                }
            },
            "registered_layouts": {},
            "active_layout_ids": {},
            "asset_catalogs": {}
        }))
        .unwrap()
    }

    fn display_snapshot() -> WorkspacePresenceSnapshot {
        WorkspacePresenceSnapshot {
            seq: 13,
            document: document_with_two_datasets(),
            peers: vec![presence(7, [0.0, 0.0])],
            your_id: 7,
            generated_availability: HashMap::new(),
        }
    }

    fn generated_availability() -> GeneratedAvailabilitySnapshot {
        GeneratedAvailabilitySnapshot {
            levels: vec![GeneratedLevelAvailability {
                image_id: ImageId("image-1".to_string()),
                info: GeneratedLevelInfo {
                    level_index: 3,
                    role: GeneratedLevelRole::Coarse,
                    provenance: GeneratedLevelProvenance {
                        generator: "coarse-v1".to_string(),
                        config_id: "coarse-64".to_string(),
                        source_content_id: Some("source-a".to_string()),
                    },
                },
                level: LevelGeometry {
                    level_index: 3,
                    shape: [1, 3, 5, 8, 4],
                    chunk_shape: [1, 1, 1, 8, 4],
                    grid_shape: [1, 3, 5, 1, 1],
                    scale: [1.0, 1.0, 1.0, 8.0, 8.0],
                },
                summary: Some(GeneratedLevelSummary {
                    total_chunks: 2,
                    ready_chunks: 1,
                    pending_chunks: 1,
                    failed_chunks: 0,
                }),
            }],
            chunks: vec![
                GeneratedChunkStatusUpdate {
                    image_id: ImageId("image-1".to_string()),
                    level_index: 3,
                    key: "3/0/0/0/0/0".to_string(),
                    status: GeneratedChunkStatus::Ready,
                    message: None,
                },
                GeneratedChunkStatusUpdate {
                    image_id: ImageId("image-1".to_string()),
                    level_index: 3,
                    key: "3/0/0/1/0/0".to_string(),
                    status: GeneratedChunkStatus::Pending,
                    message: Some("queued".to_string()),
                },
            ],
        }
    }

    #[test]
    fn viewer_profile_human_includes_updated_time() {
        let output = ViewerProfileOutput {
            server: EffectiveServer {
                url: "http://localhost:9876".to_string(),
                source: crate::config::ServerSource::Default,
            },
            workspace: WorkspaceRecord {
                id: "w".to_string(),
                name: "Workspace".to_string(),
                role: WorkspaceRole::Owner,
                created_by: "dev@local".to_string(),
                created_at: "2026-06-07T00:00:00Z".to_string(),
                updated_at: "2026-06-07T00:00:00Z".to_string(),
                archived_at: None,
                seq: 1,
                default_saved_view_id: None,
                last_opened_at: None,
                pinned_at: None,
            },
            target: WorkspaceTarget {
                id: "w".to_string(),
                name: "Workspace".to_string(),
                role: WorkspaceRole::Owner,
                archived: false,
                server_url: "http://localhost:9876".to_string(),
                web_url: "http://localhost:9876/w/w".to_string(),
                ws_url: "ws://localhost:9876/ws/workspaces/w".to_string(),
            },
            result: ViewerProfileResult {
                snapshot_seq: 12,
                own_client_id: 7,
                profile: "default".to_string(),
                user_email: "dev@local".to_string(),
                created_at: "2026-06-07T00:00:00Z".to_string(),
                updated_at: "2026-06-07T00:01:00Z".to_string(),
                seed_source: Some("workspace_snapshot".to_string()),
                command: None,
                camera: Camera::Slice(Slice {
                    center: [0.0, 0.0],
                    zoom: 1.0,
                    viewport: [800, 600],
                }),
                view: ViewState::new(),
                display: DisplayState::default(),
                multi_channel: false,
                layers: Vec::new(),
            },
        };

        let human = format_viewer_profile_human(&output);

        assert!(human.contains("Updated: 2026-06-07T00:01:00Z"));
    }

    #[test]
    fn apply_presence_command_starts_from_own_presence_by_default() {
        let result = apply_presence_command(
            &snapshot(),
            ViewportCommand::Pan { dx: 10.0, dy: -5.0 },
            None,
        )
        .unwrap();

        assert_eq!(result.snapshot_seq, 12);
        assert_eq!(result.source.kind, ViewPresenceSourceKind::Own);
        match result.camera {
            Camera::Slice(slice) => assert_eq!(slice.center, [10.0, -5.0]),
            _ => panic!("expected slice camera"),
        }
    }

    #[test]
    fn apply_presence_command_can_adopt_explicit_peer_state() {
        let result = apply_presence_command(
            &snapshot(),
            ViewportCommand::SetCenter { x: 3.0, y: 4.0 },
            Some(9),
        )
        .unwrap();

        assert_eq!(result.source.client_id, 9);
        assert_eq!(result.source.kind, ViewPresenceSourceKind::Peer);
        match result.camera {
            Camera::Slice(slice) => assert_eq!(slice.center, [3.0, 4.0]),
            _ => panic!("expected slice camera"),
        }
    }

    #[test]
    fn missing_peer_adoption_is_a_missing_resource() {
        let error = apply_presence_command(&snapshot(), ViewportCommand::SetZ { z: 5 }, Some(99))
            .unwrap_err();

        assert_eq!(error.kind, ErrorKind::MissingResource);
    }

    #[test]
    fn viewport_command_emits_presence_message_not_document_command() {
        let result =
            apply_presence_command(&snapshot(), ViewportCommand::SetZ { z: 4 }, None).unwrap();
        let value = serde_json::to_value(presence_message(&result)).unwrap();

        assert_eq!(value["type"], "presence");
        assert!(value.get("command").is_none());
        assert_eq!(value["view"]["z_range"]["start"], 4);
        assert_eq!(value["view"]["z_range"]["end"], 5);
    }

    #[test]
    fn viewport_slice_rejects_indices_outside_visible_dataset_bounds() {
        let error =
            apply_presence_command(&display_snapshot(), ViewportCommand::SetZ { z: 5 }, None)
                .unwrap_err();

        assert_eq!(error.kind, ErrorKind::Config);
        assert!(error.message.contains("requested Z index 5"));
    }

    #[test]
    fn viewport_z_range_rejects_ranges_outside_visible_dataset_bounds() {
        let error = apply_presence_command(
            &display_snapshot(),
            ViewportCommand::SetZRange { start: 3, end: 9 },
            None,
        )
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::Config);
        assert!(error.message.contains("requested Z range 3..9"));
    }

    #[test]
    fn camera_3d_commands_enter_arcball_before_applying() {
        let result = apply_presence_command(
            &snapshot(),
            ViewportCommand::Rotate3D {
                d_theta: 0.5,
                d_phi: 0.25,
            },
            None,
        )
        .unwrap();

        match result.camera {
            Camera::Arcball(arcball) => {
                assert!(arcball.theta > 0.5);
                assert!(arcball.phi > 0.8);
            }
            _ => panic!("expected arcball camera"),
        }
    }

    #[test]
    fn fly_tick_enters_fly_mode_before_applying() {
        let result = apply_presence_command(
            &snapshot(),
            ViewportCommand::FlyTick {
                dt: 0.1,
                forward: 1.0,
                right: 0.0,
                up: 0.0,
                yaw: 0.0,
                pitch: 0.0,
                roll: 0.0,
            },
            None,
        )
        .unwrap();

        assert!(matches!(result.camera, Camera::Fly(_)));
    }

    #[test]
    fn followed_own_presence_breaks_follow_before_presence_emit() {
        let mut own = presence(7, [0.0, 0.0]);
        own.following = Some(9);
        let snapshot = WorkspacePresenceSnapshot {
            peers: vec![own, presence(9, [0.0, 0.0])],
            ..snapshot()
        };

        let result =
            apply_presence_command(&snapshot, ViewportCommand::SetZoom { value: 2.0 }, None)
                .unwrap();

        assert!(result.break_follow);
    }

    #[test]
    fn peer_list_result_summarizes_snapshot_presence() {
        let mut own = presence(7, [1.0, 2.0]);
        own.cursor = Some([12.5, 13.5]);
        own.dataset_order = vec![DatasetId("wds-test".to_string())];
        let mut follower = presence(9, [3.0, 4.0]);
        follower.following = Some(7);
        let snapshot = WorkspacePresenceSnapshot {
            peers: vec![own, follower],
            ..snapshot()
        };

        let result = peer_list_result(&snapshot);

        assert_eq!(result.snapshot_seq, 12);
        assert_eq!(result.own_client_id, 7);
        let own_summary = result
            .peers
            .iter()
            .find(|peer| peer.client_id == 7)
            .unwrap();
        assert!(own_summary.is_self);
        assert_eq!(own_summary.cursor, Some([12.5, 13.5]));
        assert_eq!(
            own_summary.dataset_order,
            vec![DatasetId("wds-test".to_string())]
        );
        assert_eq!(own_summary.followers, vec![9]);
        let follower_summary = result
            .peers
            .iter()
            .find(|peer| peer.client_id == 9)
            .unwrap();
        assert!(!follower_summary.is_self);
        assert_eq!(follower_summary.following, Some(7));
    }

    #[test]
    fn follow_request_rejects_self_missing_and_following_targets() {
        let self_error = validate_follow_request(&snapshot(), 7).unwrap_err();
        assert_eq!(self_error.kind, ErrorKind::RejectedCommand);

        let missing_error = validate_follow_request(&snapshot(), 99).unwrap_err();
        assert_eq!(missing_error.kind, ErrorKind::RejectedCommand);

        let mut target = presence(9, [0.0, 0.0]);
        target.following = Some(11);
        let snapshot = WorkspacePresenceSnapshot {
            peers: vec![presence(7, [0.0, 0.0]), target],
            ..snapshot()
        };
        let following_error = validate_follow_request(&snapshot, 9).unwrap_err();
        assert_eq!(following_error.kind, ErrorKind::RejectedCommand);
    }

    #[test]
    fn follow_and_unfollow_messages_use_protocol_follow_shape() {
        let follow = serde_json::to_value(follow_message(Some(9))).unwrap();
        assert_eq!(follow["type"], "follow");
        assert_eq!(follow["target"], 9);

        let unfollow = serde_json::to_value(follow_message(None)).unwrap();
        assert_eq!(unfollow["type"], "follow");
        assert!(unfollow["target"].is_null());
    }

    #[test]
    fn cursor_message_uses_protocol_cursor_shape() {
        let set = serde_json::to_value(cursor_message(Some([1.25, 2.5]))).unwrap();
        assert_eq!(set["type"], "cursor");
        assert_eq!(set["position"][0], 1.25);
        assert_eq!(set["position"][1], 2.5);

        let clear = serde_json::to_value(cursor_message(None)).unwrap();
        assert_eq!(clear["type"], "cursor");
        assert!(clear["position"].is_null());
    }

    #[test]
    fn plan_visible_chunks_reconstructs_scene_from_snapshot() {
        let snapshot = display_snapshot();
        let scene = scene_from_presence(&snapshot.document, &snapshot.peers[0]);
        let result = plan_visible_chunks_result(
            &snapshot,
            DiagnosticViewSource {
                kind: DiagnosticViewSourceKind::Peer,
                client_id: Some(7),
                profile: None,
                user_email: None,
                seed_source: None,
            },
            &scene,
            Some("demo.zarr"),
        )
        .unwrap();

        assert_eq!(result.diagnostic_kind, "lower_level_scene_diagnostic");
        assert!(!result.planner_parity);
        assert_eq!(result.datasets.len(), 1);
        let dataset = &result.datasets[0];
        assert_eq!(dataset.dataset_id, "wds-test");
        assert!(!dataset.active_members.is_empty());
        assert!(!dataset.member_plans.is_empty());
        assert!(
            dataset.member_plans[0]
                .tiers
                .iter()
                .any(|tier| tier.tier == "visible")
        );
    }

    #[test]
    fn diagnostics_include_generated_availability() {
        let mut snapshot = display_snapshot();
        snapshot
            .generated_availability
            .insert(DatasetId("wds-test".to_string()), generated_availability());
        let scene = scene_from_presence(&snapshot.document, &snapshot.peers[0]);

        let plan = plan_visible_chunks_result(
            &snapshot,
            DiagnosticViewSource {
                kind: DiagnosticViewSourceKind::Peer,
                client_id: Some(7),
                profile: None,
                user_email: None,
                seed_source: None,
            },
            &scene,
            Some("wds-test"),
        )
        .unwrap();
        let generated = plan.datasets[0].generated_availability.as_ref().unwrap();
        assert_eq!(generated.level_count, 1);
        assert_eq!(generated.chunk_status.ready, 1);
        assert_eq!(generated.chunk_status.pending, 1);

        let debug = debug_state_result(
            &snapshot,
            DiagnosticViewSource {
                kind: DiagnosticViewSourceKind::Peer,
                client_id: Some(7),
                profile: None,
                user_email: None,
                seed_source: None,
            },
            &scene,
        );
        assert_eq!(debug.generated_availability.len(), 1);
        let debug_dataset = debug
            .datasets
            .iter()
            .find(|dataset| dataset.dataset_id == "wds-test")
            .unwrap();
        assert_eq!(debug_dataset.generated_level_count, 1);
        assert_eq!(debug_dataset.generated_chunk_count, 2);
    }

    #[test]
    fn debug_state_json_shape_is_labeled() {
        let snapshot = display_snapshot();
        let scene = scene_from_presence(&snapshot.document, &snapshot.peers[0]);
        let result = debug_state_result(
            &snapshot,
            DiagnosticViewSource {
                kind: DiagnosticViewSourceKind::Peer,
                client_id: Some(7),
                profile: None,
                user_email: None,
                seed_source: None,
            },
            &scene,
        );
        let value = serde_json::to_value(result).unwrap();

        assert_eq!(value["diagnostic_kind"], "workspace_scene_state");
        assert_eq!(value["planner_parity"], false);
        assert!(value["viewer"]["camera"].is_object());
        assert!(value["datasets"].as_array().unwrap().len() >= 2);
        assert!(!value["caveats"].as_array().unwrap().is_empty());
    }

    #[test]
    fn dataset_presence_state_hydrates_document_defaults() {
        let result = dataset_presence_state(&display_snapshot(), None).unwrap();

        assert_eq!(result.dataset_order.len(), 2);
        assert!(
            result
                .dataset_order
                .contains(&DatasetId("wds-test".to_string()))
        );
        assert!(
            result
                .dataset_order
                .contains(&DatasetId("wds-other".to_string()))
        );
        assert_eq!(result.layers.len(), 2);
        let layer = result
            .layers
            .iter()
            .find(|layer| layer.workspace_dataset_id == "wds-test")
            .unwrap();
        assert_eq!(layer.name, "demo.zarr");
        assert_eq!(layer.channel_count, 3);
        assert_eq!(layer.channels.len(), 3);
        assert!(layer.visible);
    }

    #[test]
    fn overview_fits_first_visible_image_into_requested_viewport() {
        let snapshot = display_snapshot();
        let mut scene = scene_from_presence(&snapshot.document, &snapshot.peers[0]);
        scene.dataset_order = vec![
            DatasetId("wds-test".to_string()),
            DatasetId("wds-other".to_string()),
        ];

        apply_overview_to_scene(&mut scene, [320, 320]).unwrap();

        match scene.camera {
            Camera::Slice(slice) => {
                assert_eq!(slice.viewport, [320, 320]);
                assert_eq!(slice.center, [16.0, 32.0]);
                assert!((slice.zoom - 4.5).abs() < f64::EPSILON);
            }
            _ => panic!("expected slice camera"),
        }
        assert_eq!(scene.view.z_range.start, 2);
        assert_eq!(scene.view.z_range.end, 3);
    }

    #[test]
    fn dataset_presence_command_resolves_name_and_emits_dataset_presence_message() {
        let result = apply_dataset_presence_command(
            &display_snapshot(),
            DatasetDisplayCommand::SetDatasetVisible {
                selector: "demo.zarr".to_string(),
                visible: false,
            },
            None,
        )
        .unwrap();
        let layer = result
            .layers
            .iter()
            .find(|layer| layer.workspace_dataset_id == "wds-test")
            .unwrap();
        assert!(!layer.visible);
        assert!(matches!(
            result.command,
            Some(ViewportCommand::SetDatasetVisible { .. })
        ));

        let value = serde_json::to_value(dataset_presence_message(&result)).unwrap();
        assert_eq!(value["type"], "dataset_presence");
        assert!(value.get("command").is_none());
        assert!(
            value["dataset_order"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("wds-test"))
        );
        assert_eq!(
            value["dataset_settings"]["wds-test"]["visible"],
            serde_json::json!(false)
        );
    }

    #[test]
    fn layer_order_resolves_names_and_keeps_unmentioned_layers() {
        let result = apply_dataset_presence_command(
            &display_snapshot(),
            DatasetDisplayCommand::SetOrder {
                selectors: vec!["other.zarr".to_string()],
            },
            None,
        )
        .unwrap();

        assert_eq!(
            result.dataset_order,
            vec![
                DatasetId("wds-other".to_string()),
                DatasetId("wds-test".to_string()),
            ]
        );
    }

    #[test]
    fn layer_current_channel_commands_resolve_scene_channel() {
        let mut peer = presence(7, [0.0, 0.0]);
        peer.view.c = 2;
        let snapshot = WorkspacePresenceSnapshot {
            peers: vec![peer],
            ..display_snapshot()
        };

        let result = apply_dataset_presence_command(
            &snapshot,
            DatasetDisplayCommand::SetCurrentChannelColormap {
                selector: "wds-test".to_string(),
                channel: None,
                colormap: Colormap::Viridis,
            },
            None,
        )
        .unwrap();

        let layer = result
            .layers
            .iter()
            .find(|layer| layer.workspace_dataset_id == "wds-test")
            .unwrap();
        assert_eq!(layer.channels[2].colormap, Colormap::Viridis);
    }

    #[test]
    fn invalid_channel_is_a_missing_resource() {
        let error = apply_dataset_presence_command(
            &display_snapshot(),
            DatasetDisplayCommand::SetChannelVisible {
                selector: "wds-test".to_string(),
                channel: 9,
                visible: false,
            },
            None,
        )
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::MissingResource);
    }

    #[test]
    fn ambiguous_dataset_names_fail_before_sending() {
        let mut snapshot = display_snapshot();
        snapshot
            .document
            .manifests
            .get_mut(&DatasetId("wds-other".to_string()))
            .unwrap()
            .name = "demo.zarr".to_string();

        let error = apply_dataset_presence_command(
            &snapshot,
            DatasetDisplayCommand::SetDatasetOpacity {
                selector: "demo.zarr".to_string(),
                opacity: 0.5,
            },
            None,
        )
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::AmbiguousName);
    }
}
