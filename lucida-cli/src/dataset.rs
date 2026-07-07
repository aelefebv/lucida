use std::time::Duration;

use futures_util::{Stream, StreamExt};
use lucida_core::DatasetId;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientMessage, ServerMessage};
use lucida_core::scene::DocumentState;
use lucida_protocol::{
    DatasetHealthStatus, DatasetOpenFailureDiagnostic, DatasetOpenFailureKind,
    DatasetOpenProgressDiagnostic, DatasetOpenStage, DatasetOpenSuccessDiagnostic,
    DatasetSourceHealth,
};
use serde::{Deserialize, Serialize};

use crate::config::EffectiveServer;
use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::http::{api_url, send_json};
use crate::session::{
    IncomingSessionMessage, SessionWait, connect_workspace_socket, incoming_messages,
    observe_until, send_client_message, wait_for_workspace_snapshot,
};
use crate::workspace::{WorkspaceRecord, WorkspaceRole, WorkspaceTarget};

#[derive(Debug, Serialize)]
pub struct DatasetBrowseOutput {
    pub server: EffectiveServer,
    pub path: String,
    pub entries: Vec<BrowseEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasetBrowseResult {
    pub path: String,
    pub entries: Vec<BrowseEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowseEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
}

#[derive(Debug, Deserialize)]
struct BrowseResponse {
    path: String,
    entries: Vec<BrowseEntry>,
}

pub struct DatasetHttpClient {
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl DatasetHttpClient {
    pub fn new(base_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            base_url: base_url.into(),
            token: token.map(|effective| effective.token),
            http: reqwest::Client::new(),
        }
    }

    pub async fn browse(&self, path: Option<&str>) -> Result<DatasetBrowseResult, CliError> {
        let mut request = self.http.get(api_url(&self.base_url, &["api", "browse"])?);
        if let Some(path) = path {
            request = request.query(&[("path", path)]);
        }

        let response = send_json(request, self.token.as_deref(), map_browse_error).await?;
        let body = response.json::<BrowseResponse>().await?;
        Ok(DatasetBrowseResult {
            path: body.path,
            entries: body.entries,
        })
    }
}

#[derive(Debug, Serialize)]
pub struct DatasetOpenOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub dataset: DatasetOpenSummary,
}

#[derive(Debug, Serialize)]
pub struct DatasetListOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub seq: u64,
    pub datasets: Vec<DatasetSummary>,
}

#[derive(Debug, Serialize)]
pub struct DatasetInfoOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub seq: u64,
    pub dataset: DatasetInfo,
}

#[derive(Debug, Serialize)]
pub struct DatasetHealthOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub seq: u64,
    pub datasets: Vec<DatasetSourceHealth>,
}

#[derive(Debug, Serialize)]
pub struct DatasetRetryOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub dataset: DatasetOpenSummary,
}

#[derive(Debug, Serialize)]
pub struct DatasetRemoveOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub seq: u64,
    pub removed: DatasetSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasetOpenSummary {
    pub workspace_id: String,
    pub workspace_dataset_id: String,
    pub name: String,
    pub image_count: usize,
    pub entity_count: usize,
    pub seq: u64,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<DatasetOpenSuccessDiagnostic>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub progress: Vec<DatasetOpenProgressDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasetSummary {
    pub workspace_dataset_id: String,
    pub name: String,
    pub kind: String,
    pub image_count: usize,
    pub entity_count: usize,
    pub channel_count: Option<u64>,
    pub dimensions: Option<[u64; 5]>,
    pub active_layout_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasetInfo {
    #[serde(flatten)]
    pub summary: DatasetSummary,
    pub default_layout_id: Option<String>,
    pub source_layout_count: usize,
    pub registered_layout_count: usize,
    pub images: Vec<DatasetImageSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DatasetImageSummary {
    pub image_id: String,
    pub owner: String,
    pub data_type: String,
    pub level_count: usize,
    pub level_indices: Vec<u32>,
    pub dimensions: Option<[u64; 5]>,
    pub channel_count: Option<u64>,
}

pub struct DatasetOpenClient {
    ws_url: String,
    token: Option<String>,
}

impl DatasetOpenClient {
    pub fn new(ws_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            ws_url: ws_url.into(),
            token: token.map(|effective| effective.token),
        }
    }

    pub async fn open(
        &self,
        source: &str,
        workspace_id: &str,
        wait: Duration,
    ) -> Result<DatasetOpenSummary, CliError> {
        let socket = connect_workspace_socket(&self.ws_url, self.token.as_deref()).await?;
        let (mut write, read) = socket.split();
        let request_id = dataset_open_request_id();
        let message = ClientMessage::OpenRemoteDataset {
            request_id: request_id.clone(),
            url: source.to_string(),
        };
        send_client_message(&mut write, &message).await?;

        let incoming = incoming_messages(read);
        wait_for_dataset_open_result(incoming, &request_id, source, workspace_id, wait).await
    }
}

pub struct DatasetWorkspaceClient {
    ws_url: String,
    token: Option<String>,
}

impl DatasetWorkspaceClient {
    pub fn new(ws_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            ws_url: ws_url.into(),
            token: token.map(|effective| effective.token),
        }
    }

    pub async fn list(&self, wait: Duration) -> Result<(u64, Vec<DatasetSummary>), CliError> {
        let socket = connect_workspace_socket(&self.ws_url, self.token.as_deref()).await?;
        let (_write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        Ok((
            snapshot.seq,
            dataset_summaries_from_document(&snapshot.document),
        ))
    }

    pub async fn info(
        &self,
        selector: &str,
        wait: Duration,
    ) -> Result<(u64, DatasetInfo), CliError> {
        let socket = connect_workspace_socket(&self.ws_url, self.token.as_deref()).await?;
        let (_write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let dataset = dataset_info_from_document(&snapshot.document, selector)?;
        Ok((snapshot.seq, dataset))
    }

    pub async fn health(
        &self,
        selector: Option<&str>,
        wait: Duration,
    ) -> Result<(u64, Vec<DatasetSourceHealth>), CliError> {
        let socket = connect_workspace_socket(&self.ws_url, self.token.as_deref()).await?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let dataset_id = match selector {
            Some(selector) => {
                let datasets = dataset_summaries_from_document(&snapshot.document);
                Some(DatasetId(
                    resolve_dataset_summary(selector, &datasets)?.workspace_dataset_id,
                ))
            }
            None => None,
        };
        let request_id = dataset_health_request_id();
        let message = ClientMessage::DatasetHealth {
            request_id: request_id.clone(),
            dataset_id,
        };
        send_client_message(&mut write, &message).await?;
        let health = wait_for_dataset_health_result(&mut incoming, &request_id, wait).await?;
        Ok((snapshot.seq, health))
    }

    pub async fn retry(
        &self,
        selector: &str,
        workspace_id: &str,
        wait: Duration,
    ) -> Result<DatasetOpenSummary, CliError> {
        let socket = connect_workspace_socket(&self.ws_url, self.token.as_deref()).await?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let datasets = dataset_summaries_from_document(&snapshot.document);
        let dataset = resolve_dataset_summary(selector, &datasets)?;
        let request_id = dataset_retry_request_id();
        let message = ClientMessage::DatasetRetry {
            request_id: request_id.clone(),
            dataset_id: DatasetId(dataset.workspace_dataset_id.clone()),
        };
        send_client_message(&mut write, &message).await?;
        wait_for_dataset_open_result(incoming, &request_id, &dataset.name, workspace_id, wait).await
    }

    pub async fn remove(
        &self,
        selector: &str,
        workspace: &WorkspaceRecord,
        wait: Duration,
    ) -> Result<(u64, DatasetSummary), CliError> {
        if workspace.role == WorkspaceRole::Viewer {
            return Err(CliError::new(
                ErrorKind::Unauthorized,
                "workspace role cannot remove datasets",
            ));
        }

        let socket = connect_workspace_socket(&self.ws_url, self.token.as_deref()).await?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let datasets = dataset_summaries_from_document(&snapshot.document);
        let removed = resolve_dataset_summary(selector, &datasets)?;
        let message = remove_dataset_message(&removed.workspace_dataset_id);
        send_client_message(&mut write, &message).await?;
        let seq = wait_for_remove_ack(&mut incoming, &removed.workspace_dataset_id, wait).await?;
        Ok((seq, removed))
    }
}

pub fn format_dataset_open_human(output: &DatasetOpenOutput) -> String {
    let progress = format_dataset_open_progress_trail(&output.dataset.progress);
    format!(
        "Opened dataset: {}\nWorkspace: {} ({})\nDataset ID: {}\nImages: {}\nEntities: {}\nSequence: {}\nURL: {}{}",
        output.dataset.name,
        output.workspace.name,
        output.dataset.workspace_id,
        output.dataset.workspace_dataset_id,
        output.dataset.image_count,
        output.dataset.entity_count,
        output.dataset.seq,
        output.target.web_url,
        progress,
    )
}

fn format_dataset_open_progress_trail(progress: &[DatasetOpenProgressDiagnostic]) -> String {
    if progress.is_empty() {
        return String::new();
    }
    format!(
        "\nProgress: {}",
        progress
            .iter()
            .map(|progress| dataset_open_stage_label(progress.stage))
            .collect::<Vec<_>>()
            .join(" -> ")
    )
}

pub fn format_dataset_browse_human(output: &DatasetBrowseOutput) -> String {
    if output.entries.is_empty() {
        return format!("{}\nNo entries", output.path);
    }
    let entries = output
        .entries
        .iter()
        .map(|entry| {
            let suffix = if entry.entry_type == "directory" {
                "/"
            } else {
                ""
            };
            format!("{:<9} {}{}", entry.entry_type, entry.name, suffix)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{}\n{}", output.path, entries)
}

fn dataset_open_stage_label(stage: DatasetOpenStage) -> &'static str {
    match stage {
        DatasetOpenStage::RequestReceived => "request_received",
        DatasetOpenStage::Authorization => "authorization",
        DatasetOpenStage::SourceLookup => "source_lookup",
        DatasetOpenStage::BackendOpen => "backend_open",
        DatasetOpenStage::MetadataImport => "metadata_import",
        DatasetOpenStage::BindingBuild => "binding_build",
        DatasetOpenStage::GeneratedCoarsePlanning => "generated_coarse_planning",
        DatasetOpenStage::WorkspacePersist => "workspace_persist",
        DatasetOpenStage::Broadcast => "broadcast",
        DatasetOpenStage::Complete => "complete",
    }
}

pub fn format_dataset_list_human(output: &DatasetListOutput) -> String {
    if output.datasets.is_empty() {
        return "No datasets loaded".to_string();
    }
    output
        .datasets
        .iter()
        .map(|dataset| {
            format!(
                "{}  {}  ({} images, {} entities, {} channels{})",
                dataset.workspace_dataset_id,
                dataset.name,
                dataset.image_count,
                dataset.entity_count,
                dataset
                    .channel_count
                    .map(|count| count.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                dataset
                    .active_layout_id
                    .as_ref()
                    .map(|layout| format!(", layout {layout}"))
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn format_dataset_info_human(output: &DatasetInfoOutput) -> String {
    let dataset = &output.dataset;
    let dimensions = dataset
        .summary
        .dimensions
        .map(format_dimensions)
        .unwrap_or_else(|| "unknown".to_string());
    let images = if dataset.images.is_empty() {
        "Images: none".to_string()
    } else {
        format!(
            "Images:\n{}",
            dataset
                .images
                .iter()
                .map(|image| {
                    format!(
                        "  {} owner={} levels={} dtype={} dims={}",
                        image.image_id,
                        image.owner,
                        image.level_count,
                        image.data_type,
                        image
                            .dimensions
                            .map(format_dimensions)
                            .unwrap_or_else(|| "unknown".to_string())
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    format!(
        "Dataset: {}\nID: {}\nKind: {}\nImages: {}\nEntities: {}\nChannels: {}\nDimensions: {}\nActive layout: {}\nDefault layout: {}\nSource layouts: {}\nRegistered layouts: {}\n{}",
        dataset.summary.name,
        dataset.summary.workspace_dataset_id,
        dataset.summary.kind,
        dataset.summary.image_count,
        dataset.summary.entity_count,
        dataset
            .summary
            .channel_count
            .map(|count| count.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        dimensions,
        dataset
            .summary
            .active_layout_id
            .as_deref()
            .unwrap_or("none"),
        dataset.default_layout_id.as_deref().unwrap_or("none"),
        dataset.source_layout_count,
        dataset.registered_layout_count,
        images
    )
}

pub fn format_dataset_health_human(output: &DatasetHealthOutput) -> String {
    if output.datasets.is_empty() {
        return "No datasets loaded".to_string();
    }
    output
        .datasets
        .iter()
        .map(format_one_dataset_health)
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn format_dataset_retry_human(output: &DatasetRetryOutput) -> String {
    let progress = format_dataset_open_progress_trail(&output.dataset.progress);
    format!(
        "Retried dataset binding: {}\nWorkspace: {} ({})\nDataset ID: {}\nImages: {}\nEntities: {}\nSequence: {}\nSource: {}\nURL: {}{}",
        output.dataset.name,
        output.workspace.name,
        output.dataset.workspace_id,
        output.dataset.workspace_dataset_id,
        output.dataset.image_count,
        output.dataset.entity_count,
        output.dataset.seq,
        output.dataset.source,
        output.target.web_url,
        progress,
    )
}

fn format_one_dataset_health(dataset: &DatasetSourceHealth) -> String {
    let mut lines = vec![
        format!(
            "Dataset health: {} ({})",
            dataset.name, dataset.workspace_dataset_id
        ),
        format!("Status: {}", health_status_label(dataset.status)),
        format!(
            "Source: {}",
            dataset.source_url.as_deref().unwrap_or("unavailable")
        ),
        format!(
            "Backend: {}",
            dataset.backend.as_deref().unwrap_or("unknown")
        ),
        format!(
            "Binding: {}{}",
            health_status_label(dataset.binding.status),
            dataset
                .binding
                .message
                .as_ref()
                .map(|message| format!(" ({message})"))
                .unwrap_or_default()
        ),
        format!(
            "Generated coarse: {} (levels {}, ready {}, pending {}, failed {}, unavailable {}){}",
            health_status_label(dataset.generated_coarse.status),
            dataset.generated_coarse.level_count,
            dataset.generated_coarse.ready_chunks,
            dataset.generated_coarse.pending_chunks,
            dataset.generated_coarse.failed_chunks,
            dataset.generated_coarse.unavailable_chunks,
            dataset
                .generated_coarse
                .message
                .as_ref()
                .map(|message| format!(" - {message}"))
                .unwrap_or_default()
        ),
    ];
    if let Some(cache) = &dataset.source_cache {
        lines.push(format!(
            "Source cache: {} / {} bytes ({}%), {} entries, hits {}, misses {}, evictions {}, backend errors {}",
            cache.current_bytes,
            cache.max_bytes,
            cache.used_percent,
            cache.entry_count,
            cache.hits,
            cache.misses,
            cache.evictions,
            cache.backend_errors
        ));
    }
    if let Some(cache) = &dataset.generated_coarse.cache {
        let budget = cache
            .max_bytes
            .map(|bytes| format!(" / {bytes} bytes"))
            .unwrap_or_default();
        let percent = cache
            .used_percent
            .map(|percent| format!(" ({percent}%)"))
            .unwrap_or_default();
        lines.push(format!(
            "Generated cache: {}{}{} on {}, evictions {}{}",
            cache.current_bytes,
            budget,
            percent,
            cache.storage,
            cache.evictions,
            cache
                .root
                .as_ref()
                .map(|root| format!(", root {root}"))
                .unwrap_or_default()
        ));
    }
    for failure in &dataset.generated_coarse.recent_failures {
        lines.push(format!(
            "Generated failure: {:?} image {} L{} key {}{}",
            failure.status,
            failure.image_id,
            failure.level_index,
            failure.key,
            failure
                .message
                .as_ref()
                .map(|message| format!(" ({message})"))
                .unwrap_or_default()
        ));
    }
    for message in &dataset.messages {
        lines.push(format!("Note: {message}"));
    }
    lines.join("\n")
}

fn health_status_label(status: DatasetHealthStatus) -> &'static str {
    match status {
        DatasetHealthStatus::Healthy => "healthy",
        DatasetHealthStatus::Degraded => "degraded",
        DatasetHealthStatus::Unavailable => "unavailable",
    }
}

pub fn format_dataset_remove_human(output: &DatasetRemoveOutput) -> String {
    format!(
        "Removed dataset: {}\nID: {}\nWorkspace: {} ({})\nSequence: {}",
        output.removed.name,
        output.removed.workspace_dataset_id,
        output.workspace.name,
        output.workspace.id,
        output.seq
    )
}

async fn wait_for_remove_ack<S>(
    messages: &mut S,
    dataset_id: &str,
    wait: Duration,
) -> Result<u64, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
{
    const REMOVE_WAIT: SessionWait = SessionWait {
        expectation: "remove confirmation",
        archived_outcome: "the dataset was removed",
        timeout_subject: "dataset remove confirmation",
        timeout_kind: ErrorKind::RejectedCommand,
    };
    observe_until(messages, wait, &REMOVE_WAIT, |message| match message {
        ServerMessage::Ack { seq } => Ok(Some(seq)),
        ServerMessage::CommandBroadcast {
            seq,
            command: DocumentCommand::RemoveDataset { id },
        } if id.0 == dataset_id => Ok(Some(seq)),
        _ => Ok(None),
    })
    .await
}

fn dataset_summaries_from_document(document: &DocumentState) -> Vec<DatasetSummary> {
    document
        .manifests
        .values()
        .map(|manifest| dataset_summary(document, manifest))
        .collect()
}

fn dataset_info_from_document(
    document: &DocumentState,
    selector: &str,
) -> Result<DatasetInfo, CliError> {
    let summaries = dataset_summaries_from_document(document);
    let summary = resolve_dataset_summary(selector, &summaries)?;
    let dataset_id = DatasetId(summary.workspace_dataset_id.clone());
    let manifest = document
        .manifests
        .get(&dataset_id)
        .ok_or_else(|| CliError::new(ErrorKind::MissingResource, "dataset was not found"))?;
    let images = manifest
        .images()
        .iter()
        .map(|image| {
            let first_level = image.multiscale.levels.first();
            DatasetImageSummary {
                image_id: image.image_id.0.clone(),
                owner: image.owner.0.clone(),
                data_type: format!("{:?}", image.multiscale.data_type),
                level_count: image.multiscale.levels.len(),
                level_indices: image
                    .multiscale
                    .levels
                    .iter()
                    .map(|level| level.level_index)
                    .collect(),
                dimensions: first_level.map(|level| level.shape),
                channel_count: first_level.map(|level| level.shape[1]),
            }
        })
        .collect();
    Ok(DatasetInfo {
        summary,
        default_layout_id: manifest.default_layout_id.as_ref().map(|id| id.0.clone()),
        source_layout_count: manifest.source_layouts().len(),
        registered_layout_count: document
            .registered_layouts
            .get(&dataset_id)
            .map(|layouts| layouts.len())
            .unwrap_or(0),
        images,
    })
}

fn dataset_summary(
    document: &DocumentState,
    manifest: &lucida_core::DatasetManifest,
) -> DatasetSummary {
    let first_level = manifest
        .images()
        .first()
        .and_then(|image| image.multiscale.levels.first());
    DatasetSummary {
        workspace_dataset_id: manifest.dataset_id.0.clone(),
        name: manifest.name.clone(),
        kind: dataset_kind_label(&manifest.kind),
        image_count: manifest.images().len(),
        entity_count: manifest.entities().len(),
        channel_count: first_level.map(|level| level.shape[1]),
        dimensions: first_level.map(|level| level.shape),
        active_layout_id: active_layout_id(document, manifest),
    }
}

fn active_layout_id(
    document: &DocumentState,
    manifest: &lucida_core::DatasetManifest,
) -> Option<String> {
    document
        .active_layout_ids
        .get(&manifest.dataset_id)
        .or(manifest.default_layout_id.as_ref())
        .or_else(|| manifest.source_layouts().first().map(|layout| &layout.id))
        .map(|id| id.0.clone())
}

fn resolve_dataset_summary(
    selector: &str,
    datasets: &[DatasetSummary],
) -> Result<DatasetSummary, CliError> {
    if let Some(dataset) = datasets
        .iter()
        .find(|dataset| dataset.workspace_dataset_id == selector)
        .cloned()
    {
        return Ok(dataset);
    }

    let matches = datasets
        .iter()
        .filter(|dataset| dataset.name == selector)
        .cloned()
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
                .map(|dataset| dataset.workspace_dataset_id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(CliError::new(
                ErrorKind::AmbiguousName,
                format!("dataset name {selector:?} is ambiguous; use one of: {ids}"),
            ))
        }
    }
}

fn remove_dataset_message(dataset_id: &str) -> ClientMessage {
    ClientMessage::Command {
        command: DocumentCommand::RemoveDataset {
            id: DatasetId(dataset_id.to_string()),
        },
    }
}

fn dataset_kind_label(kind: &impl std::fmt::Debug) -> String {
    let raw = format!("{kind:?}");
    if raw.starts_with("Collection") {
        "collection".to_string()
    } else {
        raw.to_ascii_lowercase()
    }
}

fn format_dimensions(shape: [u64; 5]) -> String {
    format!(
        "T{} C{} Z{} Y{} X{}",
        shape[0], shape[1], shape[2], shape[3], shape[4]
    )
}

async fn wait_for_dataset_open_result<S>(
    mut messages: S,
    request_id: &str,
    _source: &str,
    workspace_id: &str,
    wait: Duration,
) -> Result<DatasetOpenSummary, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
{
    const OPEN_WAIT: SessionWait = SessionWait {
        expectation: "the dataset opened",
        archived_outcome: "the dataset opened",
        timeout_subject: "dataset open",
        timeout_kind: ErrorKind::DatasetOpenFailure,
    };
    let mut progress = Vec::new();
    observe_until(&mut messages, wait, &OPEN_WAIT, |message| {
        observe_dataset_message(message, request_id, workspace_id, &mut progress)
    })
    .await
}

fn observe_dataset_message(
    message: ServerMessage,
    request_id: &str,
    workspace_id: &str,
    progress: &mut Vec<DatasetOpenProgressDiagnostic>,
) -> Result<Option<DatasetOpenSummary>, CliError> {
    match message {
        ServerMessage::DatasetOpenProgress {
            request_id: message_request_id,
            diagnostic,
            ..
        } => {
            if message_request_id == request_id {
                progress.push(diagnostic);
            }
            Ok(None)
        }
        ServerMessage::OpenDatasetSucceeded {
            request_id: message_request_id,
            url,
            seq,
            opened,
            diagnostic,
        } => {
            if message_request_id != request_id {
                return Ok(None);
            }
            let image_count = opened.manifest.images().len();
            let entity_count = opened.manifest.entities().len();
            Ok(Some(DatasetOpenSummary {
                workspace_id: workspace_id.to_string(),
                workspace_dataset_id: opened.manifest.dataset_id.0,
                name: opened.manifest.name,
                image_count,
                entity_count,
                seq,
                source: url,
                diagnostic,
                progress: progress.clone(),
            }))
        }
        ServerMessage::OpenDatasetFailed {
            request_id: message_request_id,
            url,
            error,
            diagnostic,
        } => {
            if message_request_id != request_id {
                return Ok(None);
            }
            Err(open_dataset_failure(&url, &error, diagnostic.as_ref()))
        }
        _ => Ok(None),
    }
}

fn dataset_open_request_id() -> String {
    format!(
        "cli-{hi:016x}{lo:016x}",
        hi = rand::random::<u64>(),
        lo = rand::random::<u64>()
    )
}

fn dataset_health_request_id() -> String {
    format!(
        "cli-health-{hi:016x}{lo:016x}",
        hi = rand::random::<u64>(),
        lo = rand::random::<u64>()
    )
}

fn dataset_retry_request_id() -> String {
    format!(
        "cli-retry-{hi:016x}{lo:016x}",
        hi = rand::random::<u64>(),
        lo = rand::random::<u64>()
    )
}

async fn wait_for_dataset_health_result<S>(
    messages: &mut S,
    request_id: &str,
    wait: Duration,
) -> Result<Vec<DatasetSourceHealth>, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
{
    const HEALTH_WAIT: SessionWait = SessionWait {
        expectation: "dataset health returned",
        archived_outcome: "dataset health returned",
        timeout_subject: "dataset health",
        timeout_kind: ErrorKind::RejectedCommand,
    };
    observe_until(messages, wait, &HEALTH_WAIT, |message| match message {
        ServerMessage::DatasetHealth {
            request_id: message_request_id,
            datasets,
        } if message_request_id == request_id => Ok(Some(datasets)),
        _ => Ok(None),
    })
    .await
}

fn open_dataset_failure(
    url: &str,
    error: &str,
    diagnostic: Option<&DatasetOpenFailureDiagnostic>,
) -> CliError {
    if let Some(diagnostic) = diagnostic {
        let prefix = format!(
            "dataset open failed for {url:?} at {:?} ({:?}, retryable={}): {}",
            diagnostic.stage, diagnostic.kind, diagnostic.retryable, diagnostic.message
        );
        let message = diagnostic
            .detail
            .as_ref()
            .map(|detail| format!("{prefix}: {detail}"))
            .unwrap_or(prefix);
        return CliError::new(error_kind_for_open_failure(diagnostic.kind), message)
            .with_context("diagnostic", diagnostic);
    }
    if error.contains("workspace role cannot add datasets") {
        return CliError::new(ErrorKind::Unauthorized, error);
    }
    if error.contains("workspace runtime is closed") {
        return CliError::new(ErrorKind::SessionDisconnect, error);
    }
    if error.contains("unsupported URL scheme") {
        return CliError::new(
            ErrorKind::DatasetOpenFailure,
            format!("unsupported dataset path or URL {url:?}: {error}"),
        );
    }

    CliError::new(
        ErrorKind::DatasetOpenFailure,
        format!("dataset open failed for {url:?}: {error}"),
    )
}

fn error_kind_for_open_failure(kind: DatasetOpenFailureKind) -> ErrorKind {
    match kind {
        DatasetOpenFailureKind::Authorization => ErrorKind::Unauthorized,
        DatasetOpenFailureKind::SessionClosed => ErrorKind::SessionDisconnect,
        DatasetOpenFailureKind::LocalPath
        | DatasetOpenFailureKind::MissingObject
        | DatasetOpenFailureKind::MissingMetadata => ErrorKind::MissingResource,
        DatasetOpenFailureKind::CloudConfiguration | DatasetOpenFailureKind::UnsupportedScheme => {
            ErrorKind::Config
        }
        _ => ErrorKind::DatasetOpenFailure,
    }
}

fn map_browse_error(status: reqwest::StatusCode, body: &str) -> CliError {
    let body = body.trim();
    match status {
        reqwest::StatusCode::UNAUTHORIZED => CliError::new(
            ErrorKind::Unauthenticated,
            "not authenticated; run `lucida auth login`",
        ),
        reqwest::StatusCode::FORBIDDEN => CliError::new(
            ErrorKind::Unauthorized,
            "browse request was forbidden by the server data directory policy",
        ),
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND => CliError::new(
            ErrorKind::MissingResource,
            if body.is_empty() {
                format!("browse request failed with HTTP {}", status.as_u16())
            } else {
                body.to_string()
            },
        ),
        _ => CliError::new(
            ErrorKind::Protocol,
            if body.is_empty() {
                format!("unexpected browse response: HTTP {}", status.as_u16())
            } else {
                format!(
                    "unexpected browse response HTTP {}: {body}",
                    status.as_u16()
                )
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;

    use futures_util::stream;

    use super::*;

    fn dataset_open_succeeded_message(request_id: &str, seq: u64) -> String {
        serde_json::json!({
            "type": "open_dataset_succeeded",
            "request_id": request_id,
            "url": "/data/demo.zarr",
            "seq": seq,
            "opened": {
                "manifest": {
                    "dataset_id": "wds-test",
                    "name": "demo.zarr",
                    "kind": "Single",
                    "entities": [
                        {
                            "id": "entity-1",
                            "kind": "Image",
                            "parent": null,
                            "labels": { "name": "tile-1" }
                        },
                        {
                            "id": "entity-2",
                            "kind": "Image",
                            "parent": null,
                            "labels": { "name": "tile-2" }
                        }
                    ],
                    "transforms": [],
                    "images": [],
                    "source_layouts": [],
                    "default_layout_id": null
                },
                "fetch": { "Proxied": { "images": [] } },
                "catalog": { "entries": [] }
            }
        })
        .to_string()
    }

    fn dataset_open_progress_message(request_id: &str, stage: &str) -> String {
        serde_json::json!({
            "type": "dataset_open_progress",
            "request_id": request_id,
            "url": "/data/demo.zarr",
            "diagnostic": {
                "stage": stage,
                "message": format!("{stage} started"),
                "workspace_dataset_id": "wds-test",
                "dataset_source_id": "source-test"
            }
        })
        .to_string()
    }

    fn snapshot_message(seq: u64) -> String {
        serde_json::json!({
            "type": "snapshot",
            "seq": seq,
            "document": {
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
                                "labels": { "name": "tile-1" }
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
                        "source_layouts": [
                            {
                                "id": "layout-source",
                                "name": "Source layout",
                                "placements": []
                            }
                        ],
                        "default_layout_id": "layout-source"
                    },
                    "wds-duplicate": {
                        "dataset_id": "wds-duplicate",
                        "name": "demo.zarr",
                        "kind": "Single",
                        "entities": [],
                        "transforms": [],
                        "images": [],
                        "source_layouts": [],
                        "default_layout_id": null
                    }
                },
                "registered_layouts": {
                    "wds-test": [
                        {
                            "id": "layout-registered",
                            "name": "Registered layout",
                            "placements": []
                        }
                    ]
                },
                "active_layout_ids": {
                    "wds-test": "layout-registered"
                },
                "asset_catalogs": {}
            },
            "peers": [],
            "your_id": 7,
            "generated_availability": {}
        })
        .to_string()
    }

    fn text_messages(
        texts: Vec<String>,
    ) -> impl Stream<Item = Result<IncomingSessionMessage, CliError>> {
        stream::iter(texts.into_iter().map(IncomingSessionMessage::Text).map(Ok))
    }

    #[tokio::test]
    async fn returns_dataset_opened_summary() {
        let result = wait_for_dataset_open_result(
            text_messages(vec![dataset_open_succeeded_message("req-1", 17)]),
            "req-1",
            "/data/demo.zarr",
            "workspace-1",
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        assert_eq!(result.workspace_id, "workspace-1");
        assert_eq!(result.workspace_dataset_id, "wds-test");
        assert_eq!(result.name, "demo.zarr");
        assert_eq!(result.entity_count, 2);
        assert_eq!(result.image_count, 0);
        assert_eq!(result.seq, 17);
        assert!(result.progress.is_empty());
    }

    #[tokio::test]
    async fn ignores_unrelated_server_messages_before_dataset_opened() {
        let result = wait_for_dataset_open_result(
            text_messages(vec![
                serde_json::json!({
                    "type": "peer_left",
                    "client_id": 42
                })
                .to_string(),
                dataset_open_succeeded_message("other-req", 17),
                serde_json::json!({
                    "type": "open_dataset_failed",
                    "request_id": "other-req",
                    "url": "ftp://example/data.zarr",
                    "error": "unsupported URL scheme: ftp://example/data.zarr"
                })
                .to_string(),
                dataset_open_succeeded_message("req-1", 18),
            ]),
            "req-1",
            "/data/demo.zarr",
            "workspace-1",
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        assert_eq!(result.seq, 18);
    }

    #[tokio::test]
    async fn collects_dataset_open_progress_for_matching_request() {
        let result = wait_for_dataset_open_result(
            text_messages(vec![
                dataset_open_progress_message("other-req", "backend_open"),
                dataset_open_progress_message("req-1", "request_received"),
                dataset_open_progress_message("req-1", "metadata_import"),
                dataset_open_succeeded_message("req-1", 19),
            ]),
            "req-1",
            "/data/demo.zarr",
            "workspace-1",
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        assert_eq!(
            result
                .progress
                .iter()
                .map(|progress| progress.stage)
                .collect::<Vec<_>>(),
            vec![
                DatasetOpenStage::RequestReceived,
                DatasetOpenStage::MetadataImport
            ]
        );
    }

    #[tokio::test]
    async fn reports_open_dataset_failed() {
        let error = wait_for_dataset_open_result(
            text_messages(vec![
                serde_json::json!({
                    "type": "open_dataset_failed",
                    "request_id": "req-1",
                    "url": "ftp://example/data.zarr",
                    "error": "unsupported URL scheme: ftp://example/data.zarr"
                })
                .to_string(),
            ]),
            "req-1",
            "ftp://example/data.zarr",
            "workspace-1",
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::DatasetOpenFailure);
        assert!(error.message.contains("unsupported dataset path or URL"));
    }

    #[tokio::test]
    async fn reports_timeout() {
        let error = wait_for_dataset_open_result(
            stream::pending::<Result<IncomingSessionMessage, CliError>>(),
            "req-1",
            "/data/demo.zarr",
            "workspace-1",
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::DatasetOpenFailure);
        assert!(error.message.contains("timed out"));
    }

    #[tokio::test]
    async fn reports_disconnect() {
        let error = wait_for_dataset_open_result(
            stream::empty::<Result<IncomingSessionMessage, CliError>>(),
            "req-1",
            "/data/demo.zarr",
            "workspace-1",
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::SessionDisconnect);
    }

    #[test]
    fn permission_failure_maps_to_unauthorized() {
        let error = open_dataset_failure(
            "/data/demo.zarr",
            "workspace role cannot add datasets",
            None,
        );

        assert_eq!(error.kind, ErrorKind::Unauthorized);
    }

    #[test]
    fn structured_missing_object_maps_to_missing_resource() {
        let diagnostic = DatasetOpenFailureDiagnostic {
            stage: lucida_protocol::DatasetOpenStage::BackendOpen,
            kind: DatasetOpenFailureKind::MissingObject,
            retryable: false,
            message: "object was not found".into(),
            detail: Some("zarr.json missing".into()),
        };
        let error = open_dataset_failure(
            "/data/missing.zarr",
            "object was not found",
            Some(&diagnostic),
        );

        assert_eq!(error.kind, ErrorKind::MissingResource);
        assert!(error.message.contains("MissingObject"));
        assert!(error.message.contains("zarr.json missing"));
        let json = error.to_json();
        assert_eq!(json["error"]["diagnostic"]["stage"], "backend_open");
        assert_eq!(json["error"]["diagnostic"]["kind"], "missing_object");
        assert_eq!(json["error"]["diagnostic"]["retryable"], false);
    }

    #[test]
    fn health_human_output_includes_cache_and_generated_status() {
        let output = DatasetHealthOutput {
            server: EffectiveServer {
                url: "http://localhost:9876".into(),
                source: crate::config::ServerSource::Default,
            },
            workspace: WorkspaceRecord {
                id: "workspace-1".into(),
                name: "Workspace".into(),
                role: WorkspaceRole::Owner,
                created_by: "dev@local".into(),
                created_at: "2026-06-10T00:00:00Z".into(),
                updated_at: "2026-06-10T00:00:00Z".into(),
                archived_at: None,
                seq: 1,
                default_saved_view_id: None,
                last_opened_at: None,
                pinned_at: None,
            },
            target: WorkspaceTarget {
                id: "workspace-1".into(),
                name: "Workspace".into(),
                role: WorkspaceRole::Owner,
                archived: false,
                server_url: "http://localhost:9876".into(),
                web_url: "http://localhost:9876/w/workspace-1".into(),
                ws_url: "ws://localhost:9876/ws/workspaces/workspace-1".into(),
            },
            seq: 1,
            datasets: vec![DatasetSourceHealth {
                workspace_dataset_id: DatasetId("wds-test".into()),
                name: "demo.zarr".into(),
                status: DatasetHealthStatus::Healthy,
                source_url: Some("/data/demo.zarr".into()),
                backend: Some("local".into()),
                binding: lucida_protocol::DatasetHealthComponent {
                    status: DatasetHealthStatus::Healthy,
                    message: Some("server binding is ready".into()),
                },
                source_cache: Some(lucida_protocol::DatasetSourceCacheStats {
                    max_bytes: 1024,
                    current_bytes: 128,
                    used_percent: 12,
                    entry_count: 2,
                    hits: 3,
                    misses: 4,
                    evictions: 1,
                    backend_errors: 0,
                }),
                generated_coarse: lucida_protocol::DatasetGeneratedCoarseHealth {
                    status: DatasetHealthStatus::Healthy,
                    level_count: 1,
                    ready_chunks: 2,
                    pending_chunks: 0,
                    failed_chunks: 0,
                    unavailable_chunks: 0,
                    message: Some("generated coarse is healthy".into()),
                    cache: Some(lucida_protocol::DatasetGeneratedCoarseCacheStats {
                        storage: "disk".into(),
                        current_bytes: 256,
                        max_bytes: Some(2048),
                        used_percent: Some(12),
                        evictions: 1,
                        root: Some("/tmp/lucida-generated".into()),
                    }),
                    recent_failures: vec![lucida_protocol::DatasetGeneratedCoarseFailure {
                        image_id: "image-1".into(),
                        level_index: 3,
                        key: "3/0/0/0/0/0".into(),
                        status: lucida_protocol::GeneratedChunkStatus::FailedTransient,
                        message: Some("temporary source error".into()),
                    }],
                },
                messages: vec![],
            }],
        };

        let human = format_dataset_health_human(&output);

        assert!(human.contains("Dataset health: demo.zarr"));
        assert!(human.contains("Source cache: 128 / 1024 bytes (12%)"));
        assert!(human.contains("Generated coarse: healthy"));
        assert!(human.contains("Generated cache: 256 / 2048 bytes (12%) on disk"));
        assert!(human.contains("Generated failure: FailedTransient"));
    }

    #[test]
    fn browse_human_output_marks_directories() {
        let output = DatasetBrowseOutput {
            server: EffectiveServer {
                url: "http://localhost:9876".into(),
                source: crate::config::ServerSource::Default,
            },
            path: "/data".into(),
            entries: vec![
                BrowseEntry {
                    name: "collection.zarr".into(),
                    entry_type: "directory".into(),
                },
                BrowseEntry {
                    name: "notes.txt".into(),
                    entry_type: "file".into(),
                },
            ],
        };

        let human = format_dataset_browse_human(&output);

        assert!(human.contains("/data"));
        assert!(human.contains("directory collection.zarr/"));
        assert!(human.contains("file      notes.txt"));
    }

    #[tokio::test]
    async fn snapshot_yields_dataset_summaries() {
        let mut messages = text_messages(vec![snapshot_message(22)]);
        let snapshot = wait_for_workspace_snapshot(&mut messages, Duration::from_secs(1))
            .await
            .unwrap();

        let summaries = dataset_summaries_from_document(&snapshot.document);
        let summary = summaries
            .iter()
            .find(|summary| summary.workspace_dataset_id == "wds-test")
            .unwrap();

        assert_eq!(snapshot.seq, 22);
        assert_eq!(summaries.len(), 2);
        assert_eq!(summary.channel_count, Some(3));
        assert_eq!(summary.dimensions, Some([1, 3, 5, 64, 32]));
        assert_eq!(
            summary.active_layout_id.as_deref(),
            Some("layout-registered")
        );
    }

    #[tokio::test]
    async fn dataset_info_includes_image_and_layout_metadata() {
        let mut messages = text_messages(vec![snapshot_message(22)]);
        let snapshot = wait_for_workspace_snapshot(&mut messages, Duration::from_secs(1))
            .await
            .unwrap();

        let info = dataset_info_from_document(&snapshot.document, "wds-test").unwrap();

        assert_eq!(info.summary.name, "demo.zarr");
        assert_eq!(info.summary.image_count, 1);
        assert_eq!(info.summary.entity_count, 1);
        assert_eq!(info.default_layout_id.as_deref(), Some("layout-source"));
        assert_eq!(info.registered_layout_count, 1);
        assert_eq!(info.source_layout_count, 1);
        assert_eq!(info.images[0].image_id, "image-1");
        assert_eq!(info.images[0].data_type, "Uint16");
    }

    #[tokio::test]
    async fn ambiguous_dataset_names_fail() {
        let mut messages = text_messages(vec![snapshot_message(22)]);
        let snapshot = wait_for_workspace_snapshot(&mut messages, Duration::from_secs(1))
            .await
            .unwrap();

        let error = dataset_info_from_document(&snapshot.document, "demo.zarr").unwrap_err();

        assert_eq!(error.kind, ErrorKind::AmbiguousName);
    }

    #[test]
    fn remove_dataset_command_maps_to_document_command() {
        let message = remove_dataset_message("wds-test");
        let value = serde_json::to_value(message).unwrap();

        assert_eq!(value["type"], "command");
        assert_eq!(value["command"]["type"], "remove_dataset");
        assert_eq!(value["command"]["id"], "wds-test");
    }

    #[tokio::test]
    async fn remove_wait_accepts_ack() {
        let mut messages = text_messages(vec![
            serde_json::json!({
                "type": "peer_left",
                "client_id": 99
            })
            .to_string(),
            serde_json::json!({
                "type": "ack",
                "seq": 23
            })
            .to_string(),
        ]);

        let seq = wait_for_remove_ack(&mut messages, "wds-test", Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(seq, 23);
    }

    #[tokio::test]
    async fn remove_wait_completes_across_unsolicited_snapshot() {
        // A resync snapshot pushed between the command and its ack (broadcast
        // lag or an answered request_snapshot) is skipped, not mistaken for
        // the reply.
        let mut messages = text_messages(vec![
            snapshot_message(24),
            serde_json::json!({
                "type": "ack",
                "seq": 25
            })
            .to_string(),
        ]);

        let seq = wait_for_remove_ack(&mut messages, "wds-test", Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(seq, 25);
    }

    #[tokio::test]
    async fn remove_wait_timeout_is_rejected_command() {
        let mut messages = stream::pending::<Result<IncomingSessionMessage, CliError>>();

        let error = wait_for_remove_ack(&mut messages, "wds-test", Duration::from_millis(1))
            .await
            .unwrap_err();

        assert_eq!(error.kind, ErrorKind::RejectedCommand);
    }

    #[tokio::test]
    async fn viewer_role_cannot_remove_without_socket() {
        let client = DatasetWorkspaceClient::new("ws://127.0.0.1:1/ws/workspaces/w", None);
        let workspace = WorkspaceRecord {
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
        };

        let error = client
            .remove("wds-test", &workspace, Duration::from_millis(1))
            .await
            .unwrap_err();

        assert_eq!(error.kind, ErrorKind::Unauthorized);
    }

    #[allow(dead_code)]
    fn assert_infallible(_: Infallible) {}
}
