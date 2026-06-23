use std::collections::{HashMap, HashSet};
use std::time::Duration;

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use lucida_content::LayoutId;
use lucida_core::DatasetId;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientId, ClientMessage, PresenceState, ServerMessage};
use lucida_core::saved_view::SavedView;
use lucida_core::scene::{DatasetDisplaySettings, DocumentState};
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
use crate::workspace::{WorkspaceRecord, WorkspaceRole, WorkspaceTarget};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSavedViewRecord {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: String,
    pub updated_at: String,
    /// Sharing layer: "shared" | "personal" | "proposed". Defaulted to "shared"
    /// so a record from a pre-visibility server (which omits the field) still
    /// deserializes — matching how the server defaults the column.
    #[serde(default = "default_visibility")]
    pub visibility: String,
    pub view: SavedView,
}

fn default_visibility() -> String {
    SavedViewVisibility::default().as_str().to_string()
}

/// The saved-view sharing layer, mirroring the server's `SavedViewVisibility`.
/// One source of truth for both the `--visibility` CLI flag (`ValueEnum`) and
/// the JSON sent on the wire (`Serialize` as the server's lowercase tokens).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum SavedViewVisibility {
    /// Part of the workspace's collaborative surface (the historical default).
    #[default]
    Shared,
    /// Belongs to one member; never disclosed to anyone else.
    Personal,
    /// A bid to share, surfaced to editors as a review queue (approve/reject).
    Proposed,
}

impl SavedViewVisibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Personal => "personal",
            Self::Proposed => "proposed",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SavedViewListOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub saved_views: Vec<SavedViewSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SavedViewSummary {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub is_default: bool,
    pub visibility: String,
    pub dataset_count: usize,
    pub layout_count: usize,
}

#[derive(Debug, Serialize)]
pub struct SavedViewOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub saved_view: WorkspaceSavedViewRecord,
}

#[derive(Debug, Serialize)]
pub struct SavedViewDeleteOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub deleted: SavedViewSummary,
}

#[derive(Debug, Serialize)]
pub struct SavedViewDefaultOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub default_saved_view_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SavedViewLinkOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub saved_view: SavedViewSummary,
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct SavedViewCaptureOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub source: SavedViewPresenceSource,
    pub saved_view: WorkspaceSavedViewRecord,
}

#[derive(Debug, Serialize)]
pub struct SavedViewApplyOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub saved_view: SavedViewSummary,
    pub result: SavedViewApplyResult,
}

#[derive(Debug, Clone, Serialize)]
pub struct SavedViewApplyResult {
    pub own_client_id: ClientId,
    pub snapshot_seq: u64,
    pub layout_command_count: usize,
    pub dataset_presence_sent: bool,
    pub presence_sent: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SavedViewPresenceSource {
    pub client_id: ClientId,
    pub kind: SavedViewPresenceSourceKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SavedViewPresenceSourceKind {
    Own,
    Peer,
}

#[derive(Debug, Serialize)]
struct CreateWorkspaceSavedViewBody<'a> {
    name: &'a str,
    view: &'a SavedView,
    visibility: &'static str,
}

#[derive(Debug, Serialize)]
struct SetWorkspaceSavedViewVisibilityBody {
    visibility: &'static str,
}

#[derive(Debug, Serialize)]
struct UpdateWorkspaceSavedViewBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view: Option<&'a SavedView>,
}

#[derive(Debug, Serialize)]
struct UpdateWorkspaceDefaultSavedViewBody<'a> {
    saved_view_id: Option<&'a str>,
}

#[derive(Debug, Clone)]
struct WorkspaceSavedViewSnapshot {
    seq: u64,
    document: DocumentState,
    peers: Vec<PresenceState>,
    your_id: ClientId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum IncomingSavedViewMessage {
    Text(String),
    Close,
    Ignore,
}

pub struct WorkspaceSavedViewClient {
    base_url: String,
    ws_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl WorkspaceSavedViewClient {
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

    pub async fn list(
        &self,
        workspace: &WorkspaceRecord,
    ) -> Result<Vec<WorkspaceSavedViewRecord>, CliError> {
        self.send(
            self.http
                .get(saved_view_collection_url(&self.base_url, &workspace.id)?),
        )
        .await?
        .json::<Vec<WorkspaceSavedViewRecord>>()
        .await
        .map_err(CliError::from)
    }

    pub async fn get(
        &self,
        workspace: &WorkspaceRecord,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedViewRecord, CliError> {
        self.send(self.http.get(saved_view_item_url(
            &self.base_url,
            &workspace.id,
            saved_view_id,
        )?))
        .await?
        .json::<WorkspaceSavedViewRecord>()
        .await
        .map_err(CliError::from)
    }

    pub async fn create(
        &self,
        workspace: &WorkspaceRecord,
        name: &str,
        view: &SavedView,
        visibility: SavedViewVisibility,
    ) -> Result<WorkspaceSavedViewRecord, CliError> {
        ensure_saved_view_mutation_allowed(workspace)?;
        let body = CreateWorkspaceSavedViewBody {
            name,
            view,
            visibility: visibility.as_str(),
        };
        self.send(
            self.http
                .post(saved_view_collection_url(&self.base_url, &workspace.id)?)
                .json(&body),
        )
        .await?
        .json::<WorkspaceSavedViewRecord>()
        .await
        .map_err(CliError::from)
    }

    /// Re-scope a saved view's visibility (PATCH .../visibility). "Promote" in
    /// the CLI is exactly this with `Shared`. The server owns every permission
    /// and target-visibility authority check; the client just sends the verb.
    pub async fn set_visibility(
        &self,
        workspace: &WorkspaceRecord,
        saved_view_id: &str,
        visibility: SavedViewVisibility,
    ) -> Result<WorkspaceSavedViewRecord, CliError> {
        let body = SetWorkspaceSavedViewVisibilityBody {
            visibility: visibility.as_str(),
        };
        self.send(
            self.http
                .patch(saved_view_visibility_url(
                    &self.base_url,
                    &workspace.id,
                    saved_view_id,
                )?)
                .json(&body),
        )
        .await?
        .json::<WorkspaceSavedViewRecord>()
        .await
        .map_err(CliError::from)
    }

    /// Approve a proposed view (POST .../approve) — an editor action that
    /// re-scopes it to `Shared`. Returns the updated record.
    pub async fn approve(
        &self,
        workspace: &WorkspaceRecord,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedViewRecord, CliError> {
        self.send(self.http.post(saved_view_approve_url(
            &self.base_url,
            &workspace.id,
            saved_view_id,
        )?))
        .await?
        .json::<WorkspaceSavedViewRecord>()
        .await
        .map_err(CliError::from)
    }

    /// Reject a proposed view (POST .../reject) — an editor action that returns
    /// it to the proposer's `Personal`. Returns the updated record.
    pub async fn reject(
        &self,
        workspace: &WorkspaceRecord,
        saved_view_id: &str,
    ) -> Result<WorkspaceSavedViewRecord, CliError> {
        self.send(self.http.post(saved_view_reject_url(
            &self.base_url,
            &workspace.id,
            saved_view_id,
        )?))
        .await?
        .json::<WorkspaceSavedViewRecord>()
        .await
        .map_err(CliError::from)
    }

    pub async fn rename(
        &self,
        workspace: &WorkspaceRecord,
        saved_view_id: &str,
        name: &str,
    ) -> Result<WorkspaceSavedViewRecord, CliError> {
        ensure_saved_view_mutation_allowed(workspace)?;
        let body = UpdateWorkspaceSavedViewBody {
            name: Some(name),
            view: None,
        };
        self.patch_saved_view(workspace, saved_view_id, &body).await
    }

    pub async fn update_view(
        &self,
        workspace: &WorkspaceRecord,
        saved_view_id: &str,
        view: &SavedView,
    ) -> Result<WorkspaceSavedViewRecord, CliError> {
        ensure_saved_view_mutation_allowed(workspace)?;
        let body = UpdateWorkspaceSavedViewBody {
            name: None,
            view: Some(view),
        };
        self.patch_saved_view(workspace, saved_view_id, &body).await
    }

    pub async fn delete(
        &self,
        workspace: &WorkspaceRecord,
        saved_view_id: &str,
    ) -> Result<(), CliError> {
        ensure_saved_view_mutation_allowed(workspace)?;
        self.send(self.http.delete(saved_view_item_url(
            &self.base_url,
            &workspace.id,
            saved_view_id,
        )?))
        .await?;
        Ok(())
    }

    pub async fn set_default(
        &self,
        workspace: &WorkspaceRecord,
        saved_view_id: Option<&str>,
    ) -> Result<WorkspaceRecord, CliError> {
        ensure_saved_view_mutation_allowed(workspace)?;
        let body = UpdateWorkspaceDefaultSavedViewBody { saved_view_id };
        self.send(
            self.http
                .patch(default_saved_view_url(&self.base_url, &workspace.id)?)
                .json(&body),
        )
        .await?
        .json::<WorkspaceRecord>()
        .await
        .map_err(CliError::from)
    }

    pub async fn capture(
        &self,
        from_peer: Option<ClientId>,
        wait: Duration,
    ) -> Result<(SavedViewPresenceSource, SavedView), CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (_write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        capture_saved_view_from_snapshot(&snapshot, from_peer)
    }

    pub async fn apply(
        &self,
        workspace: &WorkspaceRecord,
        view: &SavedView,
        wait: Duration,
    ) -> Result<SavedViewApplyResult, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        apply_saved_view_to_workspace(&mut write, &mut incoming, &snapshot, workspace, view, wait)
            .await
    }

    async fn patch_saved_view(
        &self,
        workspace: &WorkspaceRecord,
        saved_view_id: &str,
        body: &UpdateWorkspaceSavedViewBody<'_>,
    ) -> Result<WorkspaceSavedViewRecord, CliError> {
        self.send(
            self.http
                .patch(saved_view_item_url(
                    &self.base_url,
                    &workspace.id,
                    saved_view_id,
                )?)
                .json(body),
        )
        .await?
        .json::<WorkspaceSavedViewRecord>()
        .await
        .map_err(CliError::from)
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
        Err(map_saved_view_http_error(status, &body))
    }
}

pub fn format_saved_view_list_human(output: &SavedViewListOutput) -> String {
    if output.saved_views.is_empty() {
        return "No saved views".to_string();
    }
    output
        .saved_views
        .iter()
        .map(|view| {
            let default = if view.is_default { " default" } else { "" };
            format!(
                "{}  {}{}  visibility={} datasets={} layouts={} updated={}",
                view.id,
                view.name,
                default,
                view.visibility,
                view.dataset_count,
                view.layout_count,
                view.updated_at
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn format_saved_view_human(output: &SavedViewOutput) -> String {
    let summary = saved_view_summary(
        &output.saved_view,
        output.workspace.default_saved_view_id.as_deref(),
    );
    format!(
        "Saved view: {}\nID: {}\nWorkspace: {} ({})\nVisibility: {}\nCreated by: {} ({})\nUpdated: {}\nDatasets: {}\nLayouts: {}",
        summary.name,
        summary.id,
        output.workspace.name,
        output.workspace.id,
        output.saved_view.visibility,
        output.saved_view.created_by_name,
        output.saved_view.created_by,
        output.saved_view.updated_at,
        summary.dataset_count,
        summary.layout_count
    )
}

pub fn format_saved_view_delete_human(output: &SavedViewDeleteOutput) -> String {
    format!(
        "Deleted saved view: {}\nID: {}\nWorkspace: {} ({})",
        output.deleted.name, output.deleted.id, output.workspace.name, output.workspace.id
    )
}

pub fn format_saved_view_default_human(output: &SavedViewDefaultOutput) -> String {
    match output.default_saved_view_id.as_deref() {
        Some(id) => format!(
            "Default saved view set to {}\nWorkspace: {} ({})",
            id, output.workspace.name, output.workspace.id
        ),
        None => format!(
            "Default saved view cleared\nWorkspace: {} ({})",
            output.workspace.name, output.workspace.id
        ),
    }
}

pub fn format_saved_view_link_human(output: &SavedViewLinkOutput) -> String {
    output.url.clone()
}

pub fn format_saved_view_capture_human(output: &SavedViewCaptureOutput) -> String {
    format!(
        "Captured saved view: {}\nID: {}\nWorkspace: {} ({})\nVisibility: {}\nSource: {}",
        output.saved_view.name,
        output.saved_view.id,
        output.workspace.name,
        output.workspace.id,
        output.saved_view.visibility,
        format_source(&output.source)
    )
}

pub fn format_saved_view_apply_human(output: &SavedViewApplyOutput) -> String {
    let mut lines = vec![
        format!("Applied saved view: {}", output.saved_view.name),
        format!("ID: {}", output.saved_view.id),
        format!(
            "Workspace: {} ({})",
            output.workspace.name, output.workspace.id
        ),
        format!("Client: {}", output.result.own_client_id),
        format!("Layout commands: {}", output.result.layout_command_count),
        format!(
            "Dataset presence: {}",
            if output.result.dataset_presence_sent {
                "sent"
            } else {
                "not sent"
            }
        ),
        format!(
            "Presence: {}",
            if output.result.presence_sent {
                "sent"
            } else {
                "not sent"
            }
        ),
    ];
    lines.extend(
        output
            .result
            .warnings
            .iter()
            .map(|warning| format!("Warning: {warning}")),
    );
    lines.join("\n")
}

pub fn saved_view_summaries(
    saved_views: &[WorkspaceSavedViewRecord],
    default_saved_view_id: Option<&str>,
) -> Vec<SavedViewSummary> {
    saved_views
        .iter()
        .map(|view| saved_view_summary(view, default_saved_view_id))
        .collect()
}

pub fn saved_view_summary(
    saved_view: &WorkspaceSavedViewRecord,
    default_saved_view_id: Option<&str>,
) -> SavedViewSummary {
    SavedViewSummary {
        id: saved_view.id.clone(),
        name: saved_view.name.clone(),
        created_by: saved_view.created_by.clone(),
        created_by_name: saved_view.created_by_name.clone(),
        created_at: saved_view.created_at.clone(),
        updated_at: saved_view.updated_at.clone(),
        is_default: default_saved_view_id == Some(saved_view.id.as_str()),
        visibility: saved_view.visibility.clone(),
        dataset_count: saved_view.view.dataset_order.len(),
        layout_count: saved_view.view.active_layouts.len(),
    }
}

pub fn resolve_saved_view_record(
    selector: &str,
    saved_views: &[WorkspaceSavedViewRecord],
) -> Result<WorkspaceSavedViewRecord, CliError> {
    if let Some(view) = saved_views.iter().find(|view| view.id == selector).cloned() {
        return Ok(view);
    }

    let matches = saved_views
        .iter()
        .filter(|view| view.name == selector)
        .cloned()
        .collect::<Vec<_>>();
    match matches.len() {
        0 => Err(CliError::new(
            ErrorKind::MissingResource,
            format!("no saved view named or identified by {selector:?}"),
        )),
        1 => Ok(matches[0].clone()),
        _ => {
            let ids = matches
                .iter()
                .map(|view| view.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(CliError::new(
                ErrorKind::AmbiguousName,
                format!("saved view name {selector:?} is ambiguous; use one of: {ids}"),
            ))
        }
    }
}

pub fn saved_view_link(target: &WorkspaceTarget, saved_view_id: &str) -> Result<String, CliError> {
    let mut url = reqwest::Url::parse(&target.web_url)
        .map_err(|error| CliError::invalid_server(format!("invalid workspace URL: {error}")))?;
    url.set_fragment(Some(&format!("b={saved_view_id}")));
    Ok(url.to_string())
}

fn ensure_saved_view_mutation_allowed(workspace: &WorkspaceRecord) -> Result<(), CliError> {
    if workspace.role == WorkspaceRole::Viewer {
        return Err(CliError::new(
            ErrorKind::Unauthorized,
            "workspace role cannot mutate saved views",
        ));
    }
    Ok(())
}

fn capture_saved_view_from_snapshot(
    snapshot: &WorkspaceSavedViewSnapshot,
    from_peer: Option<ClientId>,
) -> Result<(SavedViewPresenceSource, SavedView), CliError> {
    let source_client_id = from_peer.unwrap_or(snapshot.your_id);
    let source_presence = snapshot
        .peers
        .iter()
        .find(|presence| presence.client_id == source_client_id)
        .ok_or_else(|| {
            CliError::new(
                ErrorKind::MissingResource,
                format!("no peer presence found for client {source_client_id}"),
            )
        })?;
    let (dataset_order, dataset_settings) =
        hydrated_dataset_presence(&snapshot.document, source_presence);
    let view = SavedView {
        v: lucida_core::saved_view::SAVED_VIEW_VERSION,
        datasets: Vec::new(),
        // `SavedView`'s per-dataset maps are `IndexMap` (deterministic wire
        // order); the CLI helpers build plain `HashMap`s, so collect into the
        // field's `IndexMap` type at the boundary.
        active_layouts: active_layouts_from_document(&snapshot.document)
            .into_iter()
            .collect(),
        camera: source_presence.camera.clone(),
        view: source_presence.view.clone(),
        display: source_presence.display.clone(),
        dataset_order,
        dataset_settings: dataset_settings.into_iter().collect(),
        auto_contrast: Default::default(),
    };
    let source = SavedViewPresenceSource {
        client_id: source_client_id,
        kind: if source_client_id == snapshot.your_id {
            SavedViewPresenceSourceKind::Own
        } else {
            SavedViewPresenceSourceKind::Peer
        },
    };
    Ok((source, view))
}

async fn apply_saved_view_to_workspace<W, S>(
    write: &mut W,
    incoming: &mut S,
    snapshot: &WorkspaceSavedViewSnapshot,
    workspace: &WorkspaceRecord,
    view: &SavedView,
    wait: Duration,
) -> Result<SavedViewApplyResult, CliError>
where
    W: Sink<Message, Error = WebSocketError> + Unpin,
    S: Stream<Item = Result<IncomingSavedViewMessage, CliError>> + Unpin,
{
    let own_presence = snapshot
        .peers
        .iter()
        .find(|presence| presence.client_id == snapshot.your_id)
        .ok_or_else(|| {
            CliError::new(
                ErrorKind::Protocol,
                "workspace snapshot did not include the CLI client presence",
            )
        })?;
    if own_presence.following.is_some() {
        send_client_message(write, &ClientMessage::Follow { target: None }).await?;
    }

    let loaded_ids = snapshot
        .document
        .manifests
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let requested_ids = requested_dataset_ids(view);
    let mut warnings = missing_dataset_warnings(&loaded_ids, &requested_ids);
    let mut layout_command_count = 0;

    if !view.active_layouts.is_empty() {
        if workspace.role == WorkspaceRole::Viewer {
            warnings.push(
                "workspace role cannot change active layouts; applied local saved-view state only"
                    .to_string(),
            );
        } else {
            for (dataset_id, layout_id) in &view.active_layouts {
                if !loaded_ids.contains(dataset_id) {
                    continue;
                }
                if !layout_exists(&snapshot.document, dataset_id, layout_id) {
                    warnings.push(format!(
                        "dataset {:?} has no layout {:?}; leaving shared layout unchanged",
                        dataset_id.0, layout_id.0
                    ));
                    continue;
                }
                let message = ClientMessage::Command {
                    command: DocumentCommand::SetActiveLayout {
                        dataset_id: dataset_id.clone(),
                        layout_id: layout_id.clone(),
                    },
                };
                send_client_message(write, &message).await?;
                wait_for_document_ack(incoming, dataset_id, layout_id, wait).await?;
                layout_command_count += 1;
            }
        }
    }

    let dataset_presence = dataset_presence_for_saved_view(&snapshot.document, own_presence, view);
    let dataset_presence_sent = if let Some((dataset_order, dataset_settings)) = dataset_presence {
        send_client_message(
            write,
            &ClientMessage::DatasetPresence {
                dataset_order,
                dataset_settings,
            },
        )
        .await?;
        true
    } else {
        false
    };

    send_client_message(
        write,
        &ClientMessage::Presence {
            camera: view.camera.clone(),
            view: view.view.clone(),
            display: view.display.clone(),
        },
    )
    .await?;

    Ok(SavedViewApplyResult {
        own_client_id: snapshot.your_id,
        snapshot_seq: snapshot.seq,
        layout_command_count,
        dataset_presence_sent,
        presence_sent: true,
        warnings,
    })
}

fn requested_dataset_ids(view: &SavedView) -> HashSet<DatasetId> {
    view.dataset_order
        .iter()
        .chain(view.dataset_settings.keys())
        .chain(view.active_layouts.keys())
        .cloned()
        .collect()
}

fn missing_dataset_warnings(
    loaded_ids: &HashSet<DatasetId>,
    requested_ids: &HashSet<DatasetId>,
) -> Vec<String> {
    requested_ids
        .iter()
        .filter(|id| !loaded_ids.contains(*id))
        .map(|id| format!("saved view references missing workspace dataset {:?}", id.0))
        .collect()
}

fn dataset_presence_for_saved_view(
    document: &DocumentState,
    own_presence: &PresenceState,
    view: &SavedView,
) -> Option<(Vec<DatasetId>, HashMap<DatasetId, DatasetDisplaySettings>)> {
    let loaded_ids = document.manifests.keys().cloned().collect::<HashSet<_>>();
    let requested_ids = requested_dataset_ids(view);
    let mut order = view
        .dataset_order
        .iter()
        .filter(|id| loaded_ids.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    if order.is_empty() && requested_ids.is_empty() {
        order = own_presence.dataset_order.clone();
    }
    for id in &own_presence.dataset_order {
        if loaded_ids.contains(id) && !order.contains(id) {
            order.push(id.clone());
        }
    }
    for id in document.manifests.keys() {
        if !order.contains(id) {
            order.push(id.clone());
        }
    }

    let mut settings = own_presence.dataset_settings.clone();
    for id in &loaded_ids {
        settings.entry(id.clone()).or_default();
    }
    for (id, saved_settings) in &view.dataset_settings {
        if loaded_ids.contains(id) {
            settings.insert(id.clone(), saved_settings.clone());
        }
    }
    if !requested_ids.is_empty() {
        for id in loaded_ids.difference(&requested_ids) {
            settings.entry(id.clone()).or_default().visible = false;
        }
    }
    settings.retain(|id, _| loaded_ids.contains(id));
    Some((order, settings))
}

fn hydrated_dataset_presence(
    document: &DocumentState,
    presence: &PresenceState,
) -> (Vec<DatasetId>, HashMap<DatasetId, DatasetDisplaySettings>) {
    let loaded_ids = document.manifests.keys().cloned().collect::<HashSet<_>>();
    let mut order = presence.dataset_order.clone();
    for id in document.manifests.keys() {
        if !order.contains(id) {
            order.push(id.clone());
        }
    }
    order.retain(|id| loaded_ids.contains(id));

    let mut settings = presence.dataset_settings.clone();
    for id in document.manifests.keys() {
        settings.entry(id.clone()).or_default();
    }
    settings.retain(|id, _| loaded_ids.contains(id));
    (order, settings)
}

fn active_layouts_from_document(document: &DocumentState) -> HashMap<DatasetId, LayoutId> {
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

fn layout_exists(document: &DocumentState, dataset_id: &DatasetId, layout_id: &LayoutId) -> bool {
    let Some(manifest) = document.manifests.get(dataset_id) else {
        return false;
    };
    manifest
        .source_layouts()
        .iter()
        .any(|layout| &layout.id == layout_id)
        || document
            .registered_layouts
            .get(dataset_id)
            .map(|layouts| layouts.iter().any(|layout| &layout.id == layout_id))
            .unwrap_or(false)
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

async fn wait_for_document_ack<S>(
    messages: &mut S,
    dataset_id: &DatasetId,
    layout_id: &LayoutId,
    wait: Duration,
) -> Result<u64, CliError>
where
    S: Stream<Item = Result<IncomingSavedViewMessage, CliError>> + Unpin,
{
    tokio::time::timeout(wait, async {
        while let Some(message) = messages.next().await {
            match message? {
                IncomingSavedViewMessage::Text(text) => {
                    let message: ServerMessage = serde_json::from_str(&text).map_err(|error| {
                        CliError::new(
                            ErrorKind::Protocol,
                            format!("invalid workspace server message: {error}"),
                        )
                    })?;
                    match message {
                        ServerMessage::Ack { seq } => return Ok(seq),
                        ServerMessage::CommandBroadcast {
                            seq,
                            command:
                                DocumentCommand::SetActiveLayout {
                                    dataset_id: observed_dataset_id,
                                    layout_id: observed_layout_id,
                                },
                        } if &observed_dataset_id == dataset_id
                            && &observed_layout_id == layout_id =>
                        {
                            return Ok(seq);
                        }
                        ServerMessage::WorkspaceArchived { .. } => {
                            return Err(CliError::new(
                                ErrorKind::ArchivedWorkspace,
                                "workspace was archived before saved-view apply completed",
                            ));
                        }
                        _ => {}
                    }
                }
                IncomingSavedViewMessage::Close => {
                    return Err(CliError::new(
                        ErrorKind::SessionDisconnect,
                        "workspace WebSocket closed before saved-view apply confirmation",
                    ));
                }
                IncomingSavedViewMessage::Ignore => {}
            }
        }
        Err(CliError::new(
            ErrorKind::SessionDisconnect,
            "workspace WebSocket disconnected before saved-view apply confirmation",
        ))
    })
    .await
    .map_err(|_| {
        CliError::new(
            ErrorKind::RejectedCommand,
            format!(
                "timed out waiting for saved-view layout confirmation after {}s",
                wait.as_secs()
            ),
        )
    })?
}

fn incoming_messages<S>(read: S) -> impl Stream<Item = Result<IncomingSavedViewMessage, CliError>>
where
    S: Stream<Item = Result<Message, WebSocketError>>,
{
    read.map(|message| match message {
        Ok(Message::Text(text)) => Ok(IncomingSavedViewMessage::Text(text.to_string())),
        Ok(Message::Close(_)) => Ok(IncomingSavedViewMessage::Close),
        Ok(_) => Ok(IncomingSavedViewMessage::Ignore),
        Err(error) => Err(map_websocket_error(error)),
    })
}

async fn wait_for_workspace_snapshot<S>(
    messages: &mut S,
    wait: Duration,
) -> Result<WorkspaceSavedViewSnapshot, CliError>
where
    S: Stream<Item = Result<IncomingSavedViewMessage, CliError>> + Unpin,
{
    tokio::time::timeout(wait, async {
        while let Some(message) = messages.next().await {
            match message? {
                IncomingSavedViewMessage::Text(text) => {
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
                            ..
                        } => {
                            return Ok(WorkspaceSavedViewSnapshot {
                                seq,
                                document,
                                peers,
                                your_id,
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
                IncomingSavedViewMessage::Close => {
                    return Err(CliError::new(
                        ErrorKind::SessionDisconnect,
                        "workspace WebSocket closed before snapshot",
                    ));
                }
                IncomingSavedViewMessage::Ignore => {}
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

fn saved_view_collection_url(
    server_url: &str,
    workspace_id: &str,
) -> Result<reqwest::Url, CliError> {
    api_url(
        server_url,
        &["api", "workspaces", workspace_id, "saved-views"],
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

fn default_saved_view_url(server_url: &str, workspace_id: &str) -> Result<reqwest::Url, CliError> {
    api_url(
        server_url,
        &["api", "workspaces", workspace_id, "default-saved-view"],
    )
}

fn saved_view_visibility_url(
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
            "visibility",
        ],
    )
}

fn saved_view_approve_url(
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
            "approve",
        ],
    )
}

fn saved_view_reject_url(
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
            "reject",
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

fn map_saved_view_http_error(status: reqwest::StatusCode, body: &str) -> CliError {
    let detail = response_detail(body);
    match status {
        reqwest::StatusCode::UNAUTHORIZED => CliError::new(
            ErrorKind::Unauthenticated,
            "not authenticated; run `lucida auth login`",
        ),
        reqwest::StatusCode::FORBIDDEN => CliError::new(
            ErrorKind::Unauthorized,
            detail.unwrap_or_else(|| "saved-view request was forbidden".to_string()),
        ),
        reqwest::StatusCode::NOT_FOUND => CliError::new(
            ErrorKind::MissingResource,
            detail.unwrap_or_else(|| "saved view was not found".to_string()),
        ),
        reqwest::StatusCode::BAD_REQUEST => CliError::new(
            ErrorKind::Config,
            detail.unwrap_or_else(|| "saved-view request was invalid".to_string()),
        ),
        reqwest::StatusCode::CONFLICT | reqwest::StatusCode::GONE => CliError::new(
            ErrorKind::ArchivedWorkspace,
            detail.unwrap_or_else(|| "workspace is archived".to_string()),
        ),
        status => CliError::new(
            ErrorKind::Protocol,
            detail.unwrap_or_else(|| {
                format!("unexpected saved-view response: HTTP {}", status.as_u16())
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

fn format_source(source: &SavedViewPresenceSource) -> String {
    match source.kind {
        SavedViewPresenceSourceKind::Own => format!("own client {}", source.client_id),
        SavedViewPresenceSourceKind::Peer => format!("peer client {}", source.client_id),
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use futures_util::stream;
    use lucida_core::camera::{Camera, Slice};
    use lucida_core::protocol::PresenceState;
    use lucida_core::scene::DisplayState;
    use lucida_core::view::ViewState;

    use super::*;

    fn presence(client_id: ClientId) -> PresenceState {
        PresenceState {
            client_id,
            camera: Camera::Slice(Slice {
                center: [10.0, 20.0],
                zoom: 2.0,
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

    fn document_with_layouts() -> DocumentState {
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
                    "images": [],
                    "source_layouts": [
                        {
                            "id": "layout-source",
                            "name": "Source layout",
                            "placements": [
                                { "entity_id": "entity-1", "position": [0.0, 0.0] }
                            ]
                        }
                    ],
                    "default_layout_id": "layout-source"
                }
            },
            "registered_layouts": {},
            "active_layout_ids": {},
            "asset_catalogs": {}
        }))
        .unwrap()
    }

    fn snapshot() -> WorkspaceSavedViewSnapshot {
        WorkspaceSavedViewSnapshot {
            seq: 12,
            document: document_with_layouts(),
            peers: vec![presence(7)],
            your_id: 7,
        }
    }

    fn saved_record(id: &str, name: &str) -> WorkspaceSavedViewRecord {
        WorkspaceSavedViewRecord {
            id: id.to_string(),
            workspace_id: "w".to_string(),
            name: name.to_string(),
            created_by: "dev@local".to_string(),
            created_by_name: "Local Dev".to_string(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            updated_at: "2026-06-06T00:00:00Z".to_string(),
            visibility: "shared".to_string(),
            view: SavedView::empty([800, 600]),
        }
    }

    fn workspace(role: WorkspaceRole) -> WorkspaceRecord {
        WorkspaceRecord {
            id: "w".to_string(),
            name: "Workspace".to_string(),
            role,
            created_by: "dev@local".to_string(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            updated_at: "2026-06-06T00:00:00Z".to_string(),
            archived_at: None,
            seq: 0,
            default_saved_view_id: Some("sv-1".to_string()),
            last_opened_at: None,
            pinned_at: None,
        }
    }

    fn target() -> WorkspaceTarget {
        WorkspaceTarget {
            id: "w".to_string(),
            name: "Workspace".to_string(),
            role: WorkspaceRole::Owner,
            archived: false,
            server_url: "http://127.0.0.1:9988".to_string(),
            web_url: "http://127.0.0.1:9988/w/w".to_string(),
            ws_url: "ws://127.0.0.1:9988/ws/workspaces/w".to_string(),
        }
    }

    fn text_messages(
        values: Vec<String>,
    ) -> impl Stream<Item = Result<IncomingSavedViewMessage, CliError>> {
        stream::iter(
            values
                .into_iter()
                .map(IncomingSavedViewMessage::Text)
                .map(Ok::<_, Infallible>)
                .map(|result| result.map_err(|never| match never {})),
        )
    }

    #[test]
    fn resolve_saved_view_prefers_id_and_rejects_ambiguous_names() {
        let views = vec![
            saved_record("sv-1", "A"),
            saved_record("sv-2", "A"),
            saved_record("A", "By id"),
        ];

        assert_eq!(resolve_saved_view_record("A", &views).unwrap().id, "A");
        assert_eq!(
            resolve_saved_view_record("missing", &views)
                .unwrap_err()
                .kind,
            ErrorKind::MissingResource
        );
        assert_eq!(
            resolve_saved_view_record("A", &views[0..2])
                .unwrap_err()
                .kind,
            ErrorKind::AmbiguousName
        );
    }

    #[test]
    fn saved_view_link_uses_workspace_bookmark_hash() {
        assert_eq!(
            saved_view_link(&target(), "sv-1").unwrap(),
            "http://127.0.0.1:9988/w/w#b=sv-1"
        );
    }

    #[test]
    fn visibility_value_enum_serializes_as_server_lowercase_tokens() {
        assert_eq!(SavedViewVisibility::default(), SavedViewVisibility::Shared);
        assert_eq!(SavedViewVisibility::Shared.as_str(), "shared");
        assert_eq!(SavedViewVisibility::Personal.as_str(), "personal");
        assert_eq!(SavedViewVisibility::Proposed.as_str(), "proposed");
        assert_eq!(
            serde_json::to_string(&SavedViewVisibility::Proposed).unwrap(),
            "\"proposed\""
        );
    }

    #[test]
    fn record_defaults_visibility_when_server_omits_it() {
        // A pre-visibility server response (no `visibility` field) must still
        // deserialize, defaulting to "shared" — never panic, never leak.
        let record: WorkspaceSavedViewRecord = serde_json::from_value(serde_json::json!({
            "id": "sv-1",
            "workspace_id": "w",
            "name": "Legacy",
            "created_by": "dev@local",
            "created_by_name": "Local Dev",
            "created_at": "2026-06-06T00:00:00Z",
            "updated_at": "2026-06-06T00:00:00Z",
            "view": SavedView::empty([800, 600]),
        }))
        .unwrap();
        assert_eq!(record.visibility, "shared");
    }

    #[test]
    fn summary_carries_visibility_into_human_and_json_output() {
        let mut record = saved_record("sv-1", "Proposal");
        record.visibility = "proposed".to_string();
        let summary = saved_view_summary(&record, None);
        assert_eq!(summary.visibility, "proposed");

        let output = SavedViewListOutput {
            server: EffectiveServer {
                url: "http://127.0.0.1:9988".to_string(),
                source: crate::config::ServerSource::Default,
            },
            workspace: workspace(WorkspaceRole::Owner),
            target: target(),
            saved_views: vec![summary],
        };
        assert!(format_saved_view_list_human(&output).contains("visibility=proposed"));
    }

    #[test]
    fn summaries_mark_default_without_source_urls() {
        let mut record = saved_record("sv-1", "View");
        record.view.datasets.push("/tmp/source.zarr".to_string());
        record
            .view
            .dataset_order
            .push(DatasetId("wds-test".to_string()));

        let summary = saved_view_summary(&record, Some("sv-1"));

        assert!(summary.is_default);
        assert_eq!(summary.dataset_count, 1);
    }

    #[test]
    fn capture_uses_workspace_dataset_ids_and_clears_source_urls() {
        let (_source, view) = capture_saved_view_from_snapshot(&snapshot(), None).unwrap();

        assert!(view.datasets.is_empty());
        assert_eq!(view.dataset_order, vec![DatasetId("wds-test".to_string())]);
        assert_eq!(
            view.active_layouts[&DatasetId("wds-test".to_string())],
            LayoutId("layout-source".to_string())
        );
    }

    #[test]
    fn viewer_role_cannot_mutate_saved_views() {
        assert_eq!(
            ensure_saved_view_mutation_allowed(&workspace(WorkspaceRole::Viewer))
                .unwrap_err()
                .kind,
            ErrorKind::Unauthorized
        );
    }

    #[tokio::test]
    async fn document_ack_wait_accepts_ack() {
        let mut messages = text_messages(vec![
            serde_json::json!({ "type": "peer_left", "client_id": 99 }).to_string(),
            serde_json::json!({ "type": "ack", "seq": 23 }).to_string(),
        ]);

        let seq = wait_for_document_ack(
            &mut messages,
            &DatasetId("wds-test".to_string()),
            &LayoutId("layout-source".to_string()),
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        assert_eq!(seq, 23);
    }

    #[tokio::test]
    async fn document_ack_wait_timeout_is_rejected() {
        let mut messages = stream::pending::<Result<IncomingSavedViewMessage, CliError>>();

        let error = wait_for_document_ack(
            &mut messages,
            &DatasetId("wds-test".to_string()),
            &LayoutId("layout-source".to_string()),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::RejectedCommand);
    }
}
