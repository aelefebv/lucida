use std::time::Duration;

use futures_util::{SinkExt, Stream, StreamExt};
use lucida_content::LayoutId;
use lucida_core::DatasetId;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientMessage, ServerMessage};
use lucida_core::scene::DocumentState;
use serde::Serialize;
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

#[derive(Debug, Serialize)]
pub struct LayoutListOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub seq: u64,
    pub datasets: Vec<DatasetLayoutState>,
}

#[derive(Debug, Serialize)]
pub struct LayoutActiveOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub seq: u64,
    pub datasets: Vec<DatasetLayoutState>,
}

#[derive(Debug, Serialize)]
pub struct LayoutSetOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub seq: u64,
    pub requested_layout_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub dataset: DatasetLayoutState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasetLayoutState {
    pub workspace_dataset_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_layout_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_layout_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_layout: Option<LayoutInfo>,
    pub fallback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    pub layouts: Vec<LayoutInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LayoutInfo {
    pub id: String,
    pub name: String,
    pub source: LayoutSource,
    pub placement_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LayoutSource {
    Source,
    Registered,
}

#[derive(Debug, Clone)]
struct WorkspaceLayoutSnapshot {
    seq: u64,
    document: DocumentState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum IncomingLayoutMessage {
    Text(String),
    Close,
    Ignore,
}

pub struct LayoutWorkspaceClient {
    ws_url: String,
    token: Option<String>,
}

impl LayoutWorkspaceClient {
    pub fn new(ws_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            ws_url: ws_url.into(),
            token: token.map(|effective| effective.token),
        }
    }

    pub async fn list(
        &self,
        selector: Option<&str>,
        wait: Duration,
    ) -> Result<(u64, Vec<DatasetLayoutState>), CliError> {
        let snapshot = self.snapshot(wait).await?;
        Ok((
            snapshot.seq,
            layout_states_from_document(&snapshot.document, selector)?,
        ))
    }

    pub async fn active(
        &self,
        selector: Option<&str>,
        wait: Duration,
    ) -> Result<(u64, Vec<DatasetLayoutState>), CliError> {
        self.list(selector, wait).await
    }

    pub async fn set(
        &self,
        dataset_selector: &str,
        layout_selector: &str,
        workspace: &WorkspaceRecord,
        wait: Duration,
    ) -> Result<(u64, String, Option<String>, DatasetLayoutState), CliError> {
        ensure_layout_mutation_allowed(workspace)?;

        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let dataset_id = resolve_dataset_id(&snapshot.document, dataset_selector)?;
        let layout_id = resolve_layout_id(&snapshot.document, &dataset_id, layout_selector)?;
        let message = set_active_layout_message(&dataset_id, &layout_id);
        let json = serde_json::to_string(&message)?;
        write
            .send(Message::Text(json.into()))
            .await
            .map_err(map_websocket_error)?;
        let seq = wait_for_layout_set_ack(&mut incoming, &dataset_id, &layout_id, wait).await?;

        let mut document = snapshot.document;
        document
            .active_layout_ids
            .insert(dataset_id.clone(), layout_id.clone());
        let dataset = layout_state_for_dataset(&document, &dataset_id)?;
        let warning = dataset.warning.clone();
        Ok((seq, layout_id.0, warning, dataset))
    }

    async fn snapshot(&self, wait: Duration) -> Result<WorkspaceLayoutSnapshot, CliError> {
        let (socket, _response) =
            connect_async(workspace_ws_request(&self.ws_url, self.token.as_deref())?)
                .await
                .map_err(map_websocket_error)?;
        let (_write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        wait_for_workspace_snapshot(&mut incoming, wait).await
    }
}

pub fn format_layout_list_human(output: &LayoutListOutput) -> String {
    if output.datasets.is_empty() {
        return "No datasets loaded".to_string();
    }
    output
        .datasets
        .iter()
        .map(format_dataset_layouts)
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn format_layout_active_human(output: &LayoutActiveOutput) -> String {
    if output.datasets.is_empty() {
        return "No datasets loaded".to_string();
    }
    output
        .datasets
        .iter()
        .map(format_dataset_active_layout)
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn format_layout_set_human(output: &LayoutSetOutput) -> String {
    let mut lines = vec![
        format!(
            "Updated active layout: {}",
            output.dataset.active_layout_id.as_deref().unwrap_or("none")
        ),
        format!(
            "Dataset: {} ({})",
            output.dataset.name, output.dataset.workspace_dataset_id
        ),
        format!(
            "Workspace: {} ({})",
            output.workspace.name, output.workspace.id
        ),
        format!("Sequence: {}", output.seq),
        format_effective_layout(&output.dataset),
    ];
    if let Some(warning) = &output.warning {
        lines.push(format!("Warning: {warning}"));
    }
    lines.join("\n")
}

fn format_dataset_layouts(dataset: &DatasetLayoutState) -> String {
    let mut lines = vec![
        format!("{}  {}", dataset.workspace_dataset_id, dataset.name),
        format_effective_layout(dataset),
    ];
    if let Some(warning) = &dataset.warning {
        lines.push(format!("Warning: {warning}"));
    }
    if dataset.layouts.is_empty() {
        lines.push("  No layouts".to_string());
    } else {
        lines.extend(dataset.layouts.iter().map(|layout| {
            let marker = if dataset
                .effective_layout
                .as_ref()
                .map(|effective| effective.id == layout.id)
                .unwrap_or(false)
            {
                "*"
            } else {
                " "
            };
            format!(
                "  {marker} {}  {}  {:?} placements={}",
                layout.id, layout.name, layout.source, layout.placement_count
            )
        }));
    }
    lines.join("\n")
}

fn format_dataset_active_layout(dataset: &DatasetLayoutState) -> String {
    let mut lines = vec![
        format!(
            "Dataset: {} ({})",
            dataset.name, dataset.workspace_dataset_id
        ),
        format!(
            "Active layout: {}",
            dataset.active_layout_id.as_deref().unwrap_or("none")
        ),
        format_effective_layout(dataset),
    ];
    if let Some(warning) = &dataset.warning {
        lines.push(format!("Warning: {warning}"));
    }
    lines.join("\n")
}

fn format_effective_layout(dataset: &DatasetLayoutState) -> String {
    match &dataset.effective_layout {
        Some(layout) => format!(
            "Rendering layout: {}  {}  {:?}",
            layout.id, layout.name, layout.source
        ),
        None => "Rendering layout: none".to_string(),
    }
}

fn ensure_layout_mutation_allowed(workspace: &WorkspaceRecord) -> Result<(), CliError> {
    if workspace.role == WorkspaceRole::Viewer {
        return Err(CliError::new(
            ErrorKind::Unauthorized,
            "workspace role cannot change active layouts",
        ));
    }
    Ok(())
}

fn layout_states_from_document(
    document: &DocumentState,
    selector: Option<&str>,
) -> Result<Vec<DatasetLayoutState>, CliError> {
    if let Some(selector) = selector {
        let dataset_id = resolve_dataset_id(document, selector)?;
        return Ok(vec![layout_state_for_dataset(document, &dataset_id)?]);
    }
    document
        .manifests
        .keys()
        .map(|dataset_id| layout_state_for_dataset(document, dataset_id))
        .collect()
}

fn layout_state_for_dataset(
    document: &DocumentState,
    dataset_id: &DatasetId,
) -> Result<DatasetLayoutState, CliError> {
    let manifest = document.manifests.get(dataset_id).ok_or_else(|| {
        CliError::new(
            ErrorKind::MissingResource,
            format!("dataset {:?} was not found", dataset_id.0),
        )
    })?;
    let layouts = layout_infos(document, dataset_id);
    let explicit_active = document
        .active_layout_ids
        .get(dataset_id)
        .map(|id| id.0.clone());
    let default_layout_id = manifest.default_layout_id.as_ref().map(|id| id.0.clone());
    let selected_layout_id = explicit_active
        .clone()
        .or_else(|| default_layout_id.clone())
        .or_else(|| {
            manifest
                .source_layouts()
                .first()
                .map(|layout| layout.id.0.clone())
        });
    let effective_layout = selected_layout_id
        .as_deref()
        .and_then(|id| layouts.iter().find(|layout| layout.id == id).cloned())
        .or_else(|| {
            default_layout_id
                .as_deref()
                .and_then(|id| layouts.iter().find(|layout| layout.id == id).cloned())
        })
        .or_else(|| {
            manifest.source_layouts().first().and_then(|layout| {
                layouts
                    .iter()
                    .find(|candidate| candidate.id == layout.id.0)
                    .cloned()
            })
        });
    let fallback = explicit_active.as_ref().is_some_and(|active| {
        effective_layout
            .as_ref()
            .map(|layout| layout.id.as_str() != active)
            .unwrap_or(true)
    });
    let warning = if fallback {
        Some(match &effective_layout {
            Some(layout) => format!(
                "active layout {:?} is unknown; rendering fallback {:?}",
                explicit_active.as_deref().unwrap_or_default(),
                layout.id
            ),
            None => format!(
                "active layout {:?} is unknown and no fallback layout is available",
                explicit_active.as_deref().unwrap_or_default()
            ),
        })
    } else {
        None
    };
    Ok(DatasetLayoutState {
        workspace_dataset_id: dataset_id.0.clone(),
        name: manifest.name.clone(),
        active_layout_id: selected_layout_id,
        default_layout_id,
        effective_layout,
        fallback,
        warning,
        layouts,
    })
}

fn layout_infos(document: &DocumentState, dataset_id: &DatasetId) -> Vec<LayoutInfo> {
    let mut layouts = Vec::new();
    if let Some(manifest) = document.manifests.get(dataset_id) {
        layouts.extend(manifest.source_layouts().iter().map(|layout| LayoutInfo {
            id: layout.id.0.clone(),
            name: layout.name.clone(),
            source: LayoutSource::Source,
            placement_count: layout.placements.len(),
        }));
    }
    if let Some(registered) = document.registered_layouts.get(dataset_id) {
        layouts.extend(registered.iter().map(|layout| LayoutInfo {
            id: layout.id.0.clone(),
            name: layout.name.clone(),
            source: LayoutSource::Registered,
            placement_count: layout.placements.len(),
        }));
    }
    layouts
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

fn resolve_layout_id(
    document: &DocumentState,
    dataset_id: &DatasetId,
    selector: &str,
) -> Result<LayoutId, CliError> {
    let layouts = layout_infos(document, dataset_id);
    if let Some(layout) = layouts.iter().find(|layout| layout.id == selector) {
        return Ok(LayoutId(layout.id.clone()));
    }

    let matches = layouts
        .iter()
        .filter(|layout| layout.name == selector)
        .collect::<Vec<_>>();
    match matches.len() {
        0 => Ok(LayoutId(selector.to_string())),
        1 => Ok(LayoutId(matches[0].id.clone())),
        _ => {
            let ids = matches
                .iter()
                .map(|layout| layout.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(CliError::new(
                ErrorKind::AmbiguousName,
                format!("layout name {selector:?} is ambiguous; use one of: {ids}"),
            ))
        }
    }
}

fn set_active_layout_message(dataset_id: &DatasetId, layout_id: &LayoutId) -> ClientMessage {
    ClientMessage::Command {
        command: DocumentCommand::SetActiveLayout {
            dataset_id: dataset_id.clone(),
            layout_id: layout_id.clone(),
        },
    }
}

fn incoming_messages<S>(read: S) -> impl Stream<Item = Result<IncomingLayoutMessage, CliError>>
where
    S: Stream<Item = Result<Message, WebSocketError>>,
{
    read.map(|message| match message {
        Ok(Message::Text(text)) => Ok(IncomingLayoutMessage::Text(text.to_string())),
        Ok(Message::Close(_)) => Ok(IncomingLayoutMessage::Close),
        Ok(_) => Ok(IncomingLayoutMessage::Ignore),
        Err(error) => Err(map_websocket_error(error)),
    })
}

async fn wait_for_workspace_snapshot<S>(
    messages: &mut S,
    wait: Duration,
) -> Result<WorkspaceLayoutSnapshot, CliError>
where
    S: Stream<Item = Result<IncomingLayoutMessage, CliError>> + Unpin,
{
    tokio::time::timeout(wait, async {
        while let Some(message) = messages.next().await {
            match message? {
                IncomingLayoutMessage::Text(text) => {
                    let message: ServerMessage = serde_json::from_str(&text).map_err(|error| {
                        CliError::new(
                            ErrorKind::Protocol,
                            format!("invalid workspace server message: {error}"),
                        )
                    })?;
                    match message {
                        ServerMessage::Snapshot { seq, document, .. } => {
                            return Ok(WorkspaceLayoutSnapshot { seq, document });
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
                IncomingLayoutMessage::Close => {
                    return Err(CliError::new(
                        ErrorKind::SessionDisconnect,
                        "workspace WebSocket closed before snapshot",
                    ));
                }
                IncomingLayoutMessage::Ignore => {}
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

async fn wait_for_layout_set_ack<S>(
    messages: &mut S,
    dataset_id: &DatasetId,
    layout_id: &LayoutId,
    wait: Duration,
) -> Result<u64, CliError>
where
    S: Stream<Item = Result<IncomingLayoutMessage, CliError>> + Unpin,
{
    tokio::time::timeout(wait, async {
        while let Some(message) = messages.next().await {
            match message? {
                IncomingLayoutMessage::Text(text) => {
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
                                "workspace was archived before the active layout changed",
                            ));
                        }
                        _ => {}
                    }
                }
                IncomingLayoutMessage::Close => {
                    return Err(CliError::new(
                        ErrorKind::SessionDisconnect,
                        "workspace WebSocket closed before layout confirmation",
                    ));
                }
                IncomingLayoutMessage::Ignore => {}
            }
        }
        Err(CliError::new(
            ErrorKind::SessionDisconnect,
            "workspace WebSocket disconnected before layout confirmation",
        ))
    })
    .await
    .map_err(|_| {
        CliError::new(
            ErrorKind::RejectedCommand,
            format!(
                "timed out waiting for active layout confirmation after {}s",
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

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use futures_util::stream;
    use lucida_core::scene::DocumentState;

    use super::*;

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
            "registered_layouts": {
                "wds-test": [
                    {
                        "id": "layout-registered",
                        "name": "Registered layout",
                        "placements": [
                            { "entity_id": "entity-1", "position": [10.0, 20.0] }
                        ]
                    }
                ]
            },
            "active_layout_ids": {
                "wds-test": "layout-registered"
            },
            "asset_catalogs": {}
        }))
        .unwrap()
    }

    fn text_messages(
        values: Vec<String>,
    ) -> impl Stream<Item = Result<IncomingLayoutMessage, CliError>> {
        stream::iter(
            values
                .into_iter()
                .map(IncomingLayoutMessage::Text)
                .map(Ok::<_, Infallible>)
                .map(|result| result.map_err(|never| match never {})),
        )
    }

    fn viewer_workspace() -> WorkspaceRecord {
        WorkspaceRecord {
            id: "w".into(),
            name: "Workspace".into(),
            role: WorkspaceRole::Viewer,
            created_by: "dev@local".into(),
            created_at: "2026-06-06T00:00:00Z".into(),
            updated_at: "2026-06-06T00:00:00Z".into(),
            archived_at: None,
            seq: 0,
            default_saved_view_id: None,
            last_opened_at: None,
            pinned_at: None,
        }
    }

    #[test]
    fn layout_states_include_source_registered_and_active_layout() {
        let states = layout_states_from_document(&document_with_layouts(), None).unwrap();

        assert_eq!(states.len(), 1);
        let state = &states[0];
        assert_eq!(state.workspace_dataset_id, "wds-test");
        assert_eq!(state.active_layout_id.as_deref(), Some("layout-registered"));
        assert!(!state.fallback);
        assert_eq!(
            state.effective_layout.as_ref().unwrap().id,
            "layout-registered"
        );
        assert_eq!(state.layouts.len(), 2);
        assert_eq!(state.layouts[0].source, LayoutSource::Source);
        assert_eq!(state.layouts[1].source, LayoutSource::Registered);
    }

    #[test]
    fn active_layout_warns_when_unknown_id_falls_back() {
        let mut document = document_with_layouts();
        document.active_layout_ids.insert(
            DatasetId("wds-test".to_string()),
            LayoutId("missing-layout".to_string()),
        );

        let state =
            layout_state_for_dataset(&document, &DatasetId("wds-test".to_string())).unwrap();

        assert_eq!(state.active_layout_id.as_deref(), Some("missing-layout"));
        assert!(state.fallback);
        assert_eq!(state.effective_layout.as_ref().unwrap().id, "layout-source");
        assert!(state.warning.unwrap().contains("missing-layout"));
    }

    #[test]
    fn layout_selector_resolves_ids_names_and_unknown_ids() {
        let document = document_with_layouts();
        let dataset_id = DatasetId("wds-test".to_string());

        assert_eq!(
            resolve_layout_id(&document, &dataset_id, "layout-source").unwrap(),
            LayoutId("layout-source".to_string())
        );
        assert_eq!(
            resolve_layout_id(&document, &dataset_id, "Registered layout").unwrap(),
            LayoutId("layout-registered".to_string())
        );
        assert_eq!(
            resolve_layout_id(&document, &dataset_id, "future-layout").unwrap(),
            LayoutId("future-layout".to_string())
        );
    }

    #[test]
    fn set_active_layout_command_maps_to_document_command() {
        let message = set_active_layout_message(
            &DatasetId("wds-test".to_string()),
            &LayoutId("layout-registered".to_string()),
        );
        let value = serde_json::to_value(message).unwrap();

        assert_eq!(value["type"], "command");
        assert_eq!(value["command"]["type"], "set_active_layout");
        assert_eq!(value["command"]["dataset_id"], "wds-test");
        assert_eq!(value["command"]["layout_id"], "layout-registered");
    }

    #[tokio::test]
    async fn layout_set_wait_accepts_ack() {
        let mut messages = text_messages(vec![
            serde_json::json!({ "type": "peer_left", "client_id": 99 }).to_string(),
            serde_json::json!({ "type": "ack", "seq": 23 }).to_string(),
        ]);

        let seq = wait_for_layout_set_ack(
            &mut messages,
            &DatasetId("wds-test".to_string()),
            &LayoutId("layout-registered".to_string()),
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        assert_eq!(seq, 23);
    }

    #[tokio::test]
    async fn layout_set_wait_accepts_matching_broadcast() {
        let mut messages = text_messages(vec![
            serde_json::json!({
                "type": "command_broadcast",
                "seq": 24,
                "command": {
                    "type": "set_active_layout",
                    "dataset_id": "wds-test",
                    "layout_id": "layout-registered"
                }
            })
            .to_string(),
        ]);

        let seq = wait_for_layout_set_ack(
            &mut messages,
            &DatasetId("wds-test".to_string()),
            &LayoutId("layout-registered".to_string()),
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        assert_eq!(seq, 24);
    }

    #[tokio::test]
    async fn layout_set_wait_timeout_is_rejected_command() {
        let mut messages = stream::pending::<Result<IncomingLayoutMessage, CliError>>();

        let error = wait_for_layout_set_ack(
            &mut messages,
            &DatasetId("wds-test".to_string()),
            &LayoutId("layout-registered".to_string()),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::RejectedCommand);
    }

    #[test]
    fn viewer_role_cannot_set_layout() {
        let error = ensure_layout_mutation_allowed(&viewer_workspace()).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Unauthorized);
    }
}
