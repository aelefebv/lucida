//! Workspace WebSocket session plumbing shared by the noun command modules.
//!
//! Every workspace-scoped command follows the same one-shot session shape:
//! connect to the workspace socket (URL built by
//! [`crate::workspace::workspace_ws_url`]), wait for the authoritative
//! [`ServerMessage::Snapshot`] handshake, optionally send [`ClientMessage`]s
//! and observe the reply, then drop the connection.
//!
//! # Unsolicited snapshots
//!
//! `Snapshot` is not only the connect handshake. The server also pushes a
//! fresh snapshot outside the request/reply rhythm: after broadcast lag (its
//! per-client queue overflowed and dropped sequenced messages) and in answer
//! to [`ClientMessage::RequestSnapshot`]. Helpers waiting on a specific reply
//! must therefore tolerate a snapshot arriving mid-exchange: [`observe_until`]
//! treats it as a harmless state refresh and keeps waiting — the one-shot
//! helpers cache no snapshot state beyond the initial handshake, so
//! skip-and-continue is the whole refresh — rather than failing or misreading
//! it as the awaited reply.

use std::collections::HashMap;
use std::time::Duration;

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use lucida_core::DatasetId;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{
    ClientId, ClientMessage, CommandFailureCode, PresenceState, ServerMessage,
};
use lucida_core::scene::DocumentState;
use lucida_protocol::GeneratedAvailabilitySnapshot;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::error::Error as WebSocketError;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::{Request as WsRequest, StatusCode as WsStatusCode};
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};

use crate::error::{CliError, ErrorKind};
use crate::transport::TransportLimits;

#[derive(Debug, Clone, Copy)]
pub struct SessionDeadline {
    expires_at: tokio::time::Instant,
    budget: Duration,
    operation: &'static str,
}

impl SessionDeadline {
    pub fn new(budget: Duration, operation: &'static str) -> Self {
        Self {
            expires_at: tokio::time::Instant::now() + budget,
            budget,
            operation,
        }
    }

    fn remaining(self) -> Result<Duration, CliError> {
        self.expires_at
            .checked_duration_since(tokio::time::Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| self.error())
    }

    fn error(self) -> CliError {
        CliError::new(
            ErrorKind::DeadlineExceeded,
            format!(
                "{} exceeded its end-to-end deadline after {}s",
                self.operation,
                self.budget.as_secs_f64()
            ),
        )
        .with_context("operation", self.operation)
        .with_context("deadline_ms", self.budget.as_millis())
    }
}

/// The connected workspace socket; callers `split()` it into a write half
/// (for [`send_client_message`]) and a read half (for [`incoming_messages`]).
pub type WorkspaceSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The authoritative connect handshake, decoded from
/// [`ServerMessage::Snapshot`]. Carries the session fields used by CLI
/// commands; viewer-only dataset fetch descriptors are deliberately ignored.
#[derive(Debug, Clone)]
pub struct WorkspaceSnapshot {
    pub seq: u64,
    pub document: DocumentState,
    pub peers: Vec<PresenceState>,
    pub your_id: ClientId,
    pub generated_availability: HashMap<DatasetId, GeneratedAvailabilitySnapshot>,
}

/// A workspace socket frame reduced to what the session loops care about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncomingSessionMessage {
    Text(String),
    Close,
    Ignore,
}

/// A document command and the correlation id that must identify its terminal
/// Ack/Nack. Keeping the pair in one value prevents call sites from generating
/// an id for the wire message and accidentally waiting on a different id.
#[derive(Debug, Clone)]
pub struct PendingCommand {
    pub request_id: String,
    pub message: ClientMessage,
}

impl PendingCommand {
    pub fn new(command: DocumentCommand) -> Self {
        let request_id = format!(
            "cli-command-{hi:016x}{lo:016x}",
            hi = rand::random::<u64>(),
            lo = rand::random::<u64>()
        );
        Self {
            message: ClientMessage::Command {
                request_id: request_id.clone(),
                command,
            },
            request_id,
        }
    }
}

/// Names one wait's error surfaces so the shared loop reports failures in the
/// waiting command's vocabulary.
#[derive(Debug, Clone, Copy)]
pub struct SessionWait {
    /// Completes "workspace WebSocket closed/disconnected before {expectation}".
    pub expectation: &'static str,
    /// Completes "workspace was archived before {archived_outcome}".
    pub archived_outcome: &'static str,
    /// Completes "timed out waiting for {timeout_subject} after {N}s".
    pub timeout_subject: &'static str,
    /// Error category when the wait times out. Command-reply waits report
    /// `RejectedCommand`, the snapshot handshake reports `SessionDisconnect`,
    /// and dataset opens report `DatasetOpenFailure`.
    pub timeout_kind: ErrorKind,
}

const SNAPSHOT_WAIT: SessionWait = SessionWait {
    expectation: "snapshot",
    archived_outcome: "snapshot",
    timeout_subject: "workspace snapshot",
    timeout_kind: ErrorKind::SessionDisconnect,
};

/// Build the workspace WebSocket upgrade request, attaching bearer auth when
/// a token is available.
pub fn workspace_ws_request(ws_url: &str, token: Option<&str>) -> Result<WsRequest<()>, CliError> {
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

/// Message/frame limits for the workspace socket. Snapshots of workspaces
/// with many datasets — and dataset-opened broadcasts for wide collections —
/// are legitimately large, so raise tungstenite's 64 MiB / 16 MiB defaults
/// (which would otherwise drop the connection mid-handshake) well clear of
/// any payload the server produces.
fn workspace_socket_config() -> Result<WebSocketConfig, CliError> {
    let limits = TransportLimits::from_env()?;
    Ok(WebSocketConfig::default()
        .max_message_size(Some(limits.ws_message_bytes))
        .max_frame_size(Some(limits.ws_frame_bytes)))
}

/// Connect to a workspace WebSocket URL with optional bearer auth.
pub async fn connect_workspace_socket(
    ws_url: &str,
    token: Option<&str>,
    deadline: &SessionDeadline,
) -> Result<WorkspaceSocket, CliError> {
    let connect = connect_async_with_config(
        workspace_ws_request(ws_url, token)?,
        Some(workspace_socket_config()?),
        false,
    );
    let (socket, _response) = tokio::time::timeout(deadline.remaining()?, connect)
        .await
        .map_err(|_| deadline.error())?
        .map_err(map_websocket_error)?;
    Ok(socket)
}

/// Reduce raw socket frames to [`IncomingSessionMessage`]s, mapping transport
/// failures to categorized [`CliError`]s.
pub fn incoming_messages<S>(read: S) -> impl Stream<Item = Result<IncomingSessionMessage, CliError>>
where
    S: Stream<Item = Result<Message, WebSocketError>>,
{
    read.map(|message| match message {
        Ok(Message::Text(text)) => Ok(IncomingSessionMessage::Text(text.to_string())),
        Ok(Message::Close(_)) => Ok(IncomingSessionMessage::Close),
        Ok(_) => Ok(IncomingSessionMessage::Ignore),
        Err(error) => Err(map_websocket_error(error)),
    })
}

/// Send one [`ClientMessage`] as a JSON text frame.
pub async fn send_client_message<W>(
    write: &mut W,
    message: &ClientMessage,
    deadline: &SessionDeadline,
) -> Result<(), CliError>
where
    W: Sink<Message, Error = WebSocketError> + Unpin,
{
    let json = serde_json::to_string(message)?;
    tokio::time::timeout(
        deadline.remaining()?,
        write.send(Message::Text(json.into())),
    )
    .await
    .map_err(|_| deadline.error())?
    .map_err(map_websocket_error)
}

/// Wait for the connect handshake: the first [`ServerMessage::Snapshot`] on
/// the session.
pub async fn wait_for_workspace_snapshot<S>(
    messages: &mut S,
    deadline: &SessionDeadline,
) -> Result<WorkspaceSnapshot, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
{
    wait_for_server_message(
        messages,
        deadline,
        &SNAPSHOT_WAIT,
        |message| match message {
            ServerMessage::Snapshot {
                seq,
                document,
                peers,
                your_id,
                generated_availability,
                dataset_fetch: _,
            } => Ok(Some(WorkspaceSnapshot {
                seq,
                document,
                peers,
                your_id,
                generated_availability,
            })),
            _ => Ok(None),
        },
    )
    .await
}

/// Observe the session until `on_message` recognizes the awaited reply.
///
/// `on_message` returns `Ok(Some(_))` for the reply, `Ok(None)` to keep
/// waiting, or `Err(_)` for a message that decides the wait negatively.
/// The loop owns the cross-cutting outcomes: `WorkspaceArchived`, socket
/// close/disconnect, malformed frames, and the timeout — each reported with
/// the vocabulary in [`SessionWait`].
///
/// Unsolicited [`ServerMessage::Snapshot`]s (lagged-broadcast resync pushes;
/// see the module docs) are consumed here as a state refresh and never reach
/// `on_message`, so a reply observer cannot mistake one for its reply.
pub async fn observe_until<S, T, F>(
    messages: &mut S,
    deadline: &SessionDeadline,
    outcomes: &SessionWait,
    mut on_message: F,
) -> Result<T, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
    F: FnMut(ServerMessage) -> Result<Option<T>, CliError>,
{
    wait_for_server_message(messages, deadline, outcomes, |message| match message {
        ServerMessage::Snapshot { .. } => Ok(None),
        message => on_message(message),
    })
    .await
}

/// Wait for the terminal result of exactly one document command.
///
/// Results for other in-flight commands are ignored. A matching Nack is
/// converted into stable CLI categories while retaining the server's typed
/// failure code and retryability in machine-readable error context.
pub async fn wait_for_command_result<S>(
    messages: &mut S,
    request_id: &str,
    deadline: &SessionDeadline,
    outcomes: &SessionWait,
) -> Result<u64, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
{
    observe_until(messages, deadline, outcomes, |message| match message {
        ServerMessage::Ack {
            request_id: observed,
            seq,
        } if observed == request_id => Ok(Some(seq)),
        ServerMessage::Nack {
            request_id: observed,
            code,
            message,
            retryable,
        } if observed == request_id => {
            Err(command_nack_error(request_id, code, message, retryable))
        }
        _ => Ok(None),
    })
    .await
}

fn command_nack_error(
    request_id: &str,
    code: CommandFailureCode,
    message: String,
    retryable: bool,
) -> CliError {
    let kind = match code {
        CommandFailureCode::Forbidden => ErrorKind::Unauthorized,
        CommandFailureCode::AuthorizationUnavailable
        | CommandFailureCode::PersistenceUnavailable => ErrorKind::Network,
        CommandFailureCode::Internal => ErrorKind::Unexpected,
        CommandFailureCode::InvalidRequest
        | CommandFailureCode::Conflict
        | CommandFailureCode::ResourceLimit => ErrorKind::RejectedCommand,
    };
    CliError::new(kind, message)
        .with_context("request_id", request_id)
        .with_context("command_failure_code", code)
        .with_context("retryable", retryable)
}

async fn wait_for_server_message<S, T, F>(
    messages: &mut S,
    deadline: &SessionDeadline,
    outcomes: &SessionWait,
    mut on_message: F,
) -> Result<T, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
    F: FnMut(ServerMessage) -> Result<Option<T>, CliError>,
{
    tokio::time::timeout(deadline.remaining()?, async {
        while let Some(message) = messages.next().await {
            match message? {
                IncomingSessionMessage::Text(text) => {
                    // Unknown string-tagged variants are forward-compatible
                    // notifications and can be skipped. Malformed JSON,
                    // missing tags, and malformed *known* variants are
                    // protocol errors rather than timeout-shaped failures.
                    let Some(message) = decode_server_message(&text)? else {
                        continue;
                    };
                    if matches!(message, ServerMessage::WorkspaceArchived { .. }) {
                        return Err(CliError::new(
                            ErrorKind::ArchivedWorkspace,
                            format!(
                                "workspace was archived before {}",
                                outcomes.archived_outcome
                            ),
                        ));
                    }
                    if let Some(result) = on_message(message)? {
                        return Ok(result);
                    }
                }
                IncomingSessionMessage::Close => {
                    return Err(CliError::new(
                        ErrorKind::SessionDisconnect,
                        format!("workspace WebSocket closed before {}", outcomes.expectation),
                    ));
                }
                IncomingSessionMessage::Ignore => {}
            }
        }
        Err(CliError::new(
            ErrorKind::SessionDisconnect,
            format!(
                "workspace WebSocket disconnected before {}",
                outcomes.expectation
            ),
        ))
    })
    .await
    .map_err(|_| {
        CliError::new(
            outcomes.timeout_kind,
            format!(
                "timed out waiting for {} within the end-to-end {}s deadline",
                outcomes.timeout_subject,
                deadline.budget.as_secs_f64()
            ),
        )
        .with_context("operation", deadline.operation)
        .with_context("deadline_ms", deadline.budget.as_millis())
    })?
}

fn decode_server_message(text: &str) -> Result<Option<ServerMessage>, CliError> {
    match serde_json::from_str::<ServerMessage>(text) {
        Ok(message) => Ok(Some(message)),
        Err(server_message_error) => {
            let value = serde_json::from_str::<serde_json::Value>(text).map_err(|error| {
                CliError::new(
                    ErrorKind::Protocol,
                    format!("invalid workspace server JSON: {error}"),
                )
            })?;
            let object = value.as_object().ok_or_else(|| {
                CliError::new(
                    ErrorKind::Protocol,
                    "workspace server message must be a JSON object",
                )
            })?;
            let message_type = object
                .get("type")
                .and_then(serde_json::Value::as_str)
                .filter(|message_type| !message_type.is_empty())
                .ok_or_else(|| {
                    CliError::new(
                        ErrorKind::Protocol,
                        "workspace server message requires a non-empty string field 'type'",
                    )
                })?;
            if !is_known_server_message_type(message_type) {
                return Ok(None);
            }
            Err(CliError::new(
                ErrorKind::Protocol,
                format!(
                    "workspace server message type {message_type:?} had an invalid schema: \
                     {server_message_error}"
                ),
            )
            .with_context("message_type", message_type))
        }
    }
}

fn is_known_server_message_type(message_type: &str) -> bool {
    matches!(
        message_type,
        "snapshot"
            | "command_broadcast"
            | "ack"
            | "nack"
            | "peer_joined"
            | "peer_left"
            | "presence_update"
            | "cursor_update"
            | "follow_changed"
            | "dataset_presence_update"
            | "dataset_open_progress"
            | "open_dataset_succeeded"
            | "open_dataset_failed"
            | "dataset_health"
            | "generated_availability_update"
            | "generated_chunk_status"
            | "workspace_archived"
            | "source_chunk_status"
    )
}

/// Map WebSocket transport failures onto the CLI's categorized errors,
/// keeping HTTP-upgrade rejections aligned with the HTTP-side categories.
pub fn map_websocket_error(error: WebSocketError) -> CliError {
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
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use futures_util::stream;

    use super::*;

    fn empty_document() -> serde_json::Value {
        serde_json::json!({
            "manifests": {},
            "registered_layouts": {},
            "active_layout_ids": {}
        })
    }

    fn snapshot_message(seq: u64, your_id: ClientId) -> String {
        serde_json::json!({
            "type": "snapshot",
            "seq": seq,
            "document": empty_document(),
            "peers": [],
            "your_id": your_id,
            "generated_availability": {}
        })
        .to_string()
    }

    fn text_messages(
        values: Vec<String>,
    ) -> impl Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin {
        stream::iter(values.into_iter().map(IncomingSessionMessage::Text).map(Ok))
    }

    fn ack_wait() -> SessionWait {
        SessionWait {
            expectation: "test confirmation",
            archived_outcome: "the test completed",
            timeout_subject: "test confirmation",
            timeout_kind: ErrorKind::RejectedCommand,
        }
    }

    #[derive(Default)]
    struct RecordingSink {
        sent: Vec<Message>,
    }

    impl Sink<Message> for RecordingSink {
        type Error = WebSocketError;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.get_mut().sent.push(item);
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn snapshot_wait_skips_unrelated_messages_and_decodes_full_payload() {
        let mut messages = text_messages(vec![
            serde_json::json!({ "type": "peer_left", "client_id": 99 }).to_string(),
            snapshot_message(41, 7),
        ]);

        let snapshot = wait_for_workspace_snapshot(
            &mut messages,
            &SessionDeadline::new(Duration::from_secs(1), "test workspace snapshot"),
        )
        .await
        .unwrap();

        assert_eq!(snapshot.seq, 41);
        assert_eq!(snapshot.your_id, 7);
        assert!(snapshot.peers.is_empty());
        assert!(snapshot.generated_availability.is_empty());
    }

    #[tokio::test]
    async fn snapshot_wait_timeout_is_session_disconnect() {
        let mut messages = stream::pending::<Result<IncomingSessionMessage, CliError>>();

        let error = wait_for_workspace_snapshot(
            &mut messages,
            &SessionDeadline::new(Duration::from_millis(1), "test workspace snapshot timeout"),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::SessionDisconnect);
        assert!(error.message.contains("timed out"));
    }

    #[tokio::test]
    async fn snapshot_wait_close_and_disconnect_are_session_disconnect() {
        let mut closed = stream::iter(vec![Ok::<_, CliError>(IncomingSessionMessage::Close)]);
        let closed_error = wait_for_workspace_snapshot(
            &mut closed,
            &SessionDeadline::new(Duration::from_secs(1), "test closed workspace"),
        )
        .await
        .unwrap_err();
        assert_eq!(closed_error.kind, ErrorKind::SessionDisconnect);
        assert!(closed_error.message.contains("closed before snapshot"));

        let mut ended = stream::empty::<Result<IncomingSessionMessage, CliError>>();
        let ended_error = wait_for_workspace_snapshot(
            &mut ended,
            &SessionDeadline::new(Duration::from_secs(1), "test ended workspace"),
        )
        .await
        .unwrap_err();
        assert_eq!(ended_error.kind, ErrorKind::SessionDisconnect);
        assert!(ended_error.message.contains("disconnected before snapshot"));
    }

    #[tokio::test]
    async fn archived_workspace_fails_the_wait_with_its_outcome() {
        let mut messages = text_messages(vec![
            serde_json::json!({ "type": "workspace_archived", "workspace_id": "w" }).to_string(),
        ]);

        let error = observe_until(
            &mut messages,
            &SessionDeadline::new(Duration::from_secs(1), "test archive outcome"),
            &ack_wait(),
            |_message| Ok(Some(())),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::ArchivedWorkspace);
        assert!(error.message.contains("before the test completed"));
    }

    #[tokio::test]
    async fn observe_until_completes_across_an_unsolicited_snapshot() {
        // A resync snapshot pushed mid-exchange (broadcast lag or an answered
        // request_snapshot) must not be handed to the reply observer and must
        // not end the wait; the ack after it still lands.
        let mut messages = text_messages(vec![
            serde_json::json!({ "type": "peer_left", "client_id": 3 }).to_string(),
            snapshot_message(50, 7),
            serde_json::json!({ "type": "ack", "request_id": "generic-1", "seq": 51 }).to_string(),
        ]);

        let mut observed_snapshot = false;
        let seq = observe_until(
            &mut messages,
            &SessionDeadline::new(Duration::from_secs(1), "test observe sequence"),
            &ack_wait(),
            |message| match message {
                ServerMessage::Snapshot { .. } => {
                    observed_snapshot = true;
                    Ok(None)
                }
                ServerMessage::Ack { seq, .. } => Ok(Some(seq)),
                _ => Ok(None),
            },
        )
        .await
        .unwrap();

        assert_eq!(seq, 51);
        assert!(!observed_snapshot, "resync snapshot leaked to the observer");
    }

    #[tokio::test]
    async fn observe_until_skips_unknown_message_types() {
        // A newer server may unicast message types this binary predates
        // (protocol additions land server-first). They can never be the
        // awaited reply, so the wait skips them instead of failing.
        let mut messages = text_messages(vec![
            serde_json::json!({
                "type": "bookmark_changed",
                "id": "retired-bookmark",
                "action": "updated",
                "dataset_urls": []
            })
            .to_string(),
            serde_json::json!({
                "type": "notification_from_the_future",
                "detail": "unknown vocabulary"
            })
            .to_string(),
            serde_json::json!({ "type": "ack", "request_id": "generic-2", "seq": 9 }).to_string(),
        ]);

        let seq = observe_until(
            &mut messages,
            &SessionDeadline::new(Duration::from_secs(1), "test rejection context"),
            &ack_wait(),
            |message| match message {
                ServerMessage::Ack { seq, .. } => Ok(Some(seq)),
                _ => Ok(None),
            },
        )
        .await
        .unwrap();

        assert_eq!(seq, 9);
    }

    #[tokio::test]
    async fn observe_until_rejects_malformed_known_message_without_timing_out() {
        let mut messages = text_messages(vec![
            serde_json::json!({ "type": "ack", "request_id": "missing-seq" }).to_string(),
        ]);

        let error = observe_until(
            &mut messages,
            &SessionDeadline::new(Duration::from_secs(1), "test malformed message"),
            &ack_wait(),
            |_message| Ok(Some(())),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::Protocol);
        assert!(error.message.contains("invalid schema"));
        assert_eq!(error.to_json()["error"]["message_type"], "ack");
    }

    #[test]
    fn pending_command_keeps_wire_and_wait_ids_together() {
        let pending = PendingCommand::new(DocumentCommand::RemoveDataset {
            id: DatasetId("dataset-1".into()),
        });
        let ClientMessage::Command {
            request_id,
            command: DocumentCommand::RemoveDataset { id },
        } = pending.message
        else {
            panic!("expected document command");
        };
        assert_eq!(request_id, pending.request_id);
        assert!(request_id.starts_with("cli-command-"));
        assert_eq!(id.0, "dataset-1");
    }

    #[tokio::test]
    async fn command_result_ignores_foreign_results_and_correlates_exact_ack() {
        let mut messages = text_messages(vec![
            serde_json::json!({
                "type": "nack",
                "request_id": "other",
                "code": "internal",
                "message": "not ours",
                "retryable": true
            })
            .to_string(),
            serde_json::json!({ "type": "ack", "request_id": "other", "seq": 8 }).to_string(),
            serde_json::json!({ "type": "ack", "request_id": "ours", "seq": 9 }).to_string(),
        ]);

        let seq = wait_for_command_result(
            &mut messages,
            "ours",
            &SessionDeadline::new(Duration::from_secs(1), "test command result"),
            &ack_wait(),
        )
        .await
        .unwrap();

        assert_eq!(seq, 9);
    }

    #[test]
    fn command_nack_codes_map_to_stable_cli_categories() {
        let cases = [
            (
                CommandFailureCode::InvalidRequest,
                ErrorKind::RejectedCommand,
            ),
            (CommandFailureCode::Forbidden, ErrorKind::Unauthorized),
            (CommandFailureCode::Conflict, ErrorKind::RejectedCommand),
            (
                CommandFailureCode::ResourceLimit,
                ErrorKind::RejectedCommand,
            ),
            (
                CommandFailureCode::AuthorizationUnavailable,
                ErrorKind::Network,
            ),
            (
                CommandFailureCode::PersistenceUnavailable,
                ErrorKind::Network,
            ),
            (CommandFailureCode::Internal, ErrorKind::Unexpected),
        ];

        for (code, expected) in cases {
            let error = command_nack_error("req-1", code, "rejected".into(), true);
            assert_eq!(error.kind, expected);
            let json = error.to_json();
            assert_eq!(json["error"]["request_id"], "req-1");
            assert_eq!(json["error"]["retryable"], true);
            assert!(json["error"]["command_failure_code"].is_string());
        }
    }

    #[tokio::test]
    async fn observe_until_timeout_uses_the_wait_vocabulary() {
        let mut messages = stream::pending::<Result<IncomingSessionMessage, CliError>>();

        let error = observe_until(
            &mut messages,
            &SessionDeadline::new(Duration::from_millis(1), "test chatter deadline"),
            &ack_wait(),
            |_message| Ok(Some(())),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::RejectedCommand);
        assert!(error.message.contains("test confirmation"));
    }

    #[tokio::test]
    async fn send_client_message_writes_one_json_text_frame() {
        let mut write = RecordingSink::default();

        send_client_message(
            &mut write,
            &ClientMessage::RequestSnapshot,
            &SessionDeadline::new(Duration::from_secs(1), "test WebSocket send"),
        )
        .await
        .unwrap();

        assert_eq!(write.sent.len(), 1);
        match &write.sent[0] {
            Message::Text(text) => {
                assert_eq!(text.as_str(), r#"{"type":"request_snapshot"}"#);
            }
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    #[test]
    fn ws_request_attaches_bearer_token_only_when_present() {
        let with_token =
            workspace_ws_request("ws://127.0.0.1:9988/ws/workspaces/w", Some("tok")).unwrap();
        assert_eq!(
            with_token.headers().get(AUTHORIZATION).unwrap(),
            "Bearer tok"
        );

        let without_token =
            workspace_ws_request("ws://127.0.0.1:9988/ws/workspaces/w", None).unwrap();
        assert!(without_token.headers().get(AUTHORIZATION).is_none());
    }
}
