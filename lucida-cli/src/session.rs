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
use lucida_core::protocol::{ClientId, ClientMessage, PresenceState, ServerMessage};
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

/// The connected workspace socket; callers `split()` it into a write half
/// (for [`send_client_message`]) and a read half (for [`incoming_messages`]).
pub type WorkspaceSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The authoritative connect handshake, decoded from
/// [`ServerMessage::Snapshot`]. Carries the full payload; commands that only
/// need the document simply ignore the presence and availability fields.
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
fn workspace_socket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(256 * 1024 * 1024))
        .max_frame_size(Some(64 * 1024 * 1024))
}

/// Connect to a workspace WebSocket URL with optional bearer auth.
pub async fn connect_workspace_socket(
    ws_url: &str,
    token: Option<&str>,
) -> Result<WorkspaceSocket, CliError> {
    let (socket, _response) = connect_async_with_config(
        workspace_ws_request(ws_url, token)?,
        Some(workspace_socket_config()),
        false,
    )
    .await
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
pub async fn send_client_message<W>(write: &mut W, message: &ClientMessage) -> Result<(), CliError>
where
    W: Sink<Message, Error = WebSocketError> + Unpin,
{
    let json = serde_json::to_string(message)?;
    write
        .send(Message::Text(json.into()))
        .await
        .map_err(map_websocket_error)
}

/// Wait for the connect handshake: the first [`ServerMessage::Snapshot`] on
/// the session.
pub async fn wait_for_workspace_snapshot<S>(
    messages: &mut S,
    wait: Duration,
) -> Result<WorkspaceSnapshot, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
{
    wait_for_server_message(messages, wait, &SNAPSHOT_WAIT, |message| match message {
        ServerMessage::Snapshot {
            seq,
            document,
            peers,
            your_id,
            generated_availability,
        } => Ok(Some(WorkspaceSnapshot {
            seq,
            document,
            peers,
            your_id,
            generated_availability,
        })),
        _ => Ok(None),
    })
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
    wait: Duration,
    outcomes: &SessionWait,
    mut on_message: F,
) -> Result<T, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
    F: FnMut(ServerMessage) -> Result<Option<T>, CliError>,
{
    wait_for_server_message(messages, wait, outcomes, |message| match message {
        ServerMessage::Snapshot { .. } => Ok(None),
        message => on_message(message),
    })
    .await
}

async fn wait_for_server_message<S, T, F>(
    messages: &mut S,
    wait: Duration,
    outcomes: &SessionWait,
    mut on_message: F,
) -> Result<T, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
    F: FnMut(ServerMessage) -> Result<Option<T>, CliError>,
{
    tokio::time::timeout(wait, async {
        while let Some(message) = messages.next().await {
            match message? {
                IncomingSessionMessage::Text(text) => {
                    // Skip text frames that don't parse as a known
                    // `ServerMessage`: a newer server may notify with
                    // message types this binary predates, and none of them
                    // can be the reply an observer is waiting for. Failing
                    // the whole wait would make every server-side protocol
                    // addition break deployed CLIs.
                    let Ok(message) = serde_json::from_str::<ServerMessage>(&text) else {
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
                "timed out waiting for {} after {}s",
                outcomes.timeout_subject,
                wait.as_secs()
            ),
        )
    })?
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
            "active_layout_ids": {},
            "asset_catalogs": {}
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

        let snapshot = wait_for_workspace_snapshot(&mut messages, Duration::from_secs(1))
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

        let error = wait_for_workspace_snapshot(&mut messages, Duration::from_millis(1))
            .await
            .unwrap_err();

        assert_eq!(error.kind, ErrorKind::SessionDisconnect);
        assert!(error.message.contains("timed out"));
    }

    #[tokio::test]
    async fn snapshot_wait_close_and_disconnect_are_session_disconnect() {
        let mut closed = stream::iter(vec![Ok::<_, CliError>(IncomingSessionMessage::Close)]);
        let closed_error = wait_for_workspace_snapshot(&mut closed, Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(closed_error.kind, ErrorKind::SessionDisconnect);
        assert!(closed_error.message.contains("closed before snapshot"));

        let mut ended = stream::empty::<Result<IncomingSessionMessage, CliError>>();
        let ended_error = wait_for_workspace_snapshot(&mut ended, Duration::from_secs(1))
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
            Duration::from_secs(1),
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
            serde_json::json!({ "type": "ack", "seq": 51 }).to_string(),
        ]);

        let mut observed_snapshot = false;
        let seq = observe_until(
            &mut messages,
            Duration::from_secs(1),
            &ack_wait(),
            |message| match message {
                ServerMessage::Snapshot { .. } => {
                    observed_snapshot = true;
                    Ok(None)
                }
                ServerMessage::Ack { seq } => Ok(Some(seq)),
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
                "type": "notification_from_the_future",
                "detail": "unknown vocabulary"
            })
            .to_string(),
            serde_json::json!({ "type": "ack", "seq": 9 }).to_string(),
        ]);

        let seq = observe_until(
            &mut messages,
            Duration::from_secs(1),
            &ack_wait(),
            |message| match message {
                ServerMessage::Ack { seq } => Ok(Some(seq)),
                _ => Ok(None),
            },
        )
        .await
        .unwrap();

        assert_eq!(seq, 9);
    }

    #[tokio::test]
    async fn observe_until_timeout_uses_the_wait_vocabulary() {
        let mut messages = stream::pending::<Result<IncomingSessionMessage, CliError>>();

        let error = observe_until(
            &mut messages,
            Duration::from_millis(1),
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

        send_client_message(&mut write, &ClientMessage::RequestSnapshot)
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
