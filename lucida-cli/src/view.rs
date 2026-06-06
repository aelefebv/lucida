use std::time::Duration;

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use lucida_core::camera::Camera;
use lucida_core::command::{Command as CoreCommand, ViewportCommand};
use lucida_core::protocol::{ClientId, ClientMessage, PresenceState, ServerMessage};
use lucida_core::scene::{DisplayState, DocumentState, Scene};
use lucida_core::view::ViewState;
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

#[derive(Debug, Clone)]
struct WorkspacePresenceSnapshot {
    seq: u64,
    document: DocumentState,
    peers: Vec<PresenceState>,
    your_id: ClientId,
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

fn scene_from_presence(document: &DocumentState, presence: &PresenceState) -> Scene {
    let mut scene = Scene::new(presence.camera.viewport());
    scene.document = document.clone();
    scene.camera = presence.camera.clone();
    scene.view = presence.view.clone();
    scene.display = presence.display.clone();
    scene.dataset_order = presence.dataset_order.clone();
    scene.dataset_settings = presence.dataset_settings.clone();
    scene
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

fn find_presence(
    snapshot: &WorkspacePresenceSnapshot,
    client_id: ClientId,
) -> Option<&PresenceState> {
    snapshot
        .peers
        .iter()
        .find(|presence| presence.client_id == client_id)
}

fn presence_message(result: &ViewApplyResult) -> ClientMessage {
    ClientMessage::Presence {
        camera: result.camera.clone(),
        view: result.view.clone(),
        display: result.display.clone(),
    }
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
                            ..
                        } => {
                            return Ok(WorkspacePresenceSnapshot {
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

fn format_source(source: &ViewPresenceSource) -> String {
    match source.kind {
        ViewPresenceSourceKind::Own => format!("own client {}", source.client_id),
        ViewPresenceSourceKind::Peer => format!("peer client {}", source.client_id),
    }
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
        ViewportCommand::SetDatasetOrder { .. }
        | ViewportCommand::SetDatasetVisible { .. }
        | ViewportCommand::SetDatasetOpacity { .. }
        | ViewportCommand::SetDatasetContrast { .. }
        | ViewportCommand::SetDatasetGamma { .. }
        | ViewportCommand::SetDatasetBlendMode { .. }
        | ViewportCommand::SetDatasetRenderMode { .. }
        | ViewportCommand::SetDatasetDetailLevelOverride { .. }
        | ViewportCommand::SetMultiChannel { .. }
        | ViewportCommand::SetChannelVisible { .. }
        | ViewportCommand::SetChannelColormap { .. }
        | ViewportCommand::SetChannelContrast { .. }
        | ViewportCommand::SetChannelGamma { .. }
        | ViewportCommand::SetChannelBlendMode { .. } => "display command",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use lucida_core::camera::{Camera, Slice};
    use lucida_core::protocol::PresenceState;
    use lucida_core::scene::{DisplayState, DocumentState};
    use lucida_core::view::ViewState;

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
        }
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
            apply_presence_command(&snapshot(), ViewportCommand::SetZ { z: 5 }, None).unwrap();
        let value = serde_json::to_value(presence_message(&result)).unwrap();

        assert_eq!(value["type"], "presence");
        assert!(value.get("command").is_none());
        assert_eq!(value["view"]["z_range"]["start"], 5);
        assert_eq!(value["view"]["z_range"]["end"], 6);
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
}
