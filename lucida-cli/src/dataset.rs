use std::time::Duration;

use futures_util::{SinkExt, Stream, StreamExt};
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientMessage, ServerMessage};
use serde::Serialize;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::error::Error as WebSocketError;
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::config::EffectiveServer;
use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::workspace::{WorkspaceRecord, WorkspaceTarget};

#[derive(Debug, Serialize)]
pub struct DatasetOpenOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub dataset: DatasetOpenSummary,
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
        let mut request = self
            .ws_url
            .as_str()
            .into_client_request()
            .map_err(|error| {
                CliError::new(
                    ErrorKind::InvalidServer,
                    format!("invalid workspace WebSocket URL: {error}"),
                )
            })?;
        if let Some(token) = self.token.as_deref() {
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

        let (socket, _response) = connect_async(request).await.map_err(map_websocket_error)?;
        let (mut write, read) = socket.split();
        let message = ClientMessage::OpenRemoteDataset {
            url: source.to_string(),
        };
        let json = serde_json::to_string(&message)?;
        write
            .send(Message::Text(json.into()))
            .await
            .map_err(map_websocket_error)?;

        let incoming = read.map(|message| match message {
            Ok(Message::Text(text)) => Ok(IncomingDatasetMessage::Text(text.to_string())),
            Ok(Message::Close(_)) => Ok(IncomingDatasetMessage::Close),
            Ok(_) => Ok(IncomingDatasetMessage::Ignore),
            Err(error) => Err(map_websocket_error(error)),
        });

        wait_for_dataset_open_result(incoming, source, workspace_id, wait).await
    }
}

pub fn format_dataset_open_human(output: &DatasetOpenOutput) -> String {
    format!(
        "Opened dataset: {}\nWorkspace: {} ({})\nDataset ID: {}\nImages: {}\nEntities: {}\nSequence: {}\nURL: {}",
        output.dataset.name,
        output.workspace.name,
        output.dataset.workspace_id,
        output.dataset.workspace_dataset_id,
        output.dataset.image_count,
        output.dataset.entity_count,
        output.dataset.seq,
        output.target.web_url,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum IncomingDatasetMessage {
    Text(String),
    Close,
    Ignore,
}

async fn wait_for_dataset_open_result<S>(
    mut messages: S,
    source: &str,
    workspace_id: &str,
    wait: Duration,
) -> Result<DatasetOpenSummary, CliError>
where
    S: Stream<Item = Result<IncomingDatasetMessage, CliError>> + Unpin,
{
    tokio::time::timeout(wait, async {
        while let Some(message) = messages.next().await {
            match message? {
                IncomingDatasetMessage::Text(text) => {
                    if let Some(result) = observe_dataset_message(&text, source, workspace_id)? {
                        return Ok(result);
                    }
                }
                IncomingDatasetMessage::Close => {
                    return Err(CliError::new(
                        ErrorKind::SessionDisconnect,
                        "workspace WebSocket closed before the dataset opened",
                    ));
                }
                IncomingDatasetMessage::Ignore => {}
            }
        }

        Err(CliError::new(
            ErrorKind::SessionDisconnect,
            "workspace WebSocket disconnected before the dataset opened",
        ))
    })
    .await
    .map_err(|_| {
        CliError::new(
            ErrorKind::DatasetOpenFailure,
            format!(
                "timed out waiting for dataset open after {}s",
                wait.as_secs()
            ),
        )
    })?
}

fn observe_dataset_message(
    text: &str,
    source: &str,
    workspace_id: &str,
) -> Result<Option<DatasetOpenSummary>, CliError> {
    let message: ServerMessage = serde_json::from_str(text).map_err(|error| {
        CliError::new(
            ErrorKind::Protocol,
            format!("invalid workspace server message: {error}"),
        )
    })?;

    match message {
        ServerMessage::CommandBroadcast {
            seq,
            command: DocumentCommand::DatasetOpened(opened),
        } => {
            let image_count = opened.manifest.images().len();
            let entity_count = opened.manifest.entities().len();
            Ok(Some(DatasetOpenSummary {
                workspace_id: workspace_id.to_string(),
                workspace_dataset_id: opened.manifest.dataset_id.0,
                name: opened.manifest.name,
                image_count,
                entity_count,
                seq,
                source: source.to_string(),
            }))
        }
        ServerMessage::OpenDatasetFailed { url, error } => Err(open_dataset_failure(&url, &error)),
        ServerMessage::WorkspaceArchived { .. } => Err(CliError::new(
            ErrorKind::ArchivedWorkspace,
            "workspace was archived before the dataset opened",
        )),
        _ => Ok(None),
    }
}

fn open_dataset_failure(url: &str, error: &str) -> CliError {
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

fn map_websocket_error(error: WebSocketError) -> CliError {
    match error {
        WebSocketError::Http(response) => match response.status() {
            StatusCode::UNAUTHORIZED => CliError::new(
                ErrorKind::Unauthenticated,
                "not authenticated; run `lucida auth login`",
            ),
            StatusCode::FORBIDDEN => CliError::new(
                ErrorKind::Unauthorized,
                "workspace WebSocket request was forbidden",
            ),
            StatusCode::NOT_FOUND => CliError::new(
                ErrorKind::MissingResource,
                "workspace WebSocket target was not found",
            ),
            StatusCode::GONE | StatusCode::CONFLICT => {
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

    use super::*;

    fn dataset_opened_message(seq: u64) -> String {
        serde_json::json!({
            "type": "command_broadcast",
            "seq": seq,
            "command": {
                "type": "dataset_opened",
                "manifest": {
                    "dataset_id": "wds-test",
                    "name": "demo.zarr",
                    "kind": "Single",
                    "entities": [
                        {
                            "id": "entity-1",
                            "kind": "Image",
                            "parent": null,
                            "labels": { "name": "field-1" }
                        },
                        {
                            "id": "entity-2",
                            "kind": "Image",
                            "parent": null,
                            "labels": { "name": "field-2" }
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

    fn text_messages(
        texts: Vec<String>,
    ) -> impl Stream<Item = Result<IncomingDatasetMessage, CliError>> {
        stream::iter(texts.into_iter().map(IncomingDatasetMessage::Text).map(Ok))
    }

    #[tokio::test]
    async fn returns_dataset_opened_summary() {
        let result = wait_for_dataset_open_result(
            text_messages(vec![dataset_opened_message(17)]),
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
                dataset_opened_message(18),
            ]),
            "/data/demo.zarr",
            "workspace-1",
            Duration::from_secs(1),
        )
        .await
        .unwrap();

        assert_eq!(result.seq, 18);
    }

    #[tokio::test]
    async fn reports_open_dataset_failed() {
        let error = wait_for_dataset_open_result(
            text_messages(vec![
                serde_json::json!({
                    "type": "open_dataset_failed",
                    "url": "ftp://example/data.zarr",
                    "error": "unsupported URL scheme: ftp://example/data.zarr"
                })
                .to_string(),
            ]),
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
            stream::pending::<Result<IncomingDatasetMessage, CliError>>(),
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
            stream::empty::<Result<IncomingDatasetMessage, CliError>>(),
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
        let error = open_dataset_failure("/data/demo.zarr", "workspace role cannot add datasets");

        assert_eq!(error.kind, ErrorKind::Unauthorized);
    }

    #[allow(dead_code)]
    fn assert_infallible(_: Infallible) {}
}
