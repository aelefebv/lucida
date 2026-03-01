use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, broadcast, mpsc, oneshot};

use crate::command_router::{
    CommandArgs, CommandEnvelope, CommandRouter, CommandScope, command_error_to_envelope,
};
use crate::data_plane::DataPlaneError;
use crate::event_stream::{EventEnvelope, EventPayload, EventType};
use crate::model::{
    AttachRequest, DatasetBinding, LayerState, PermissionClass, ReconnectRequest,
    SessionSnapshotEnvelope, SourceRecord, SourceStatus, WarningCode, WarningEntry,
    WarningSeverity,
};
use crate::{DataPlaneService, SessionManager};

#[derive(Debug, Clone, PartialEq)]
pub struct EngineRuntimeConfig {
    pub cache_root: PathBuf,
}

impl Default for EngineRuntimeConfig {
    fn default() -> Self {
        Self {
            cache_root: PathBuf::from(".tmp/cache"),
        }
    }
}

#[derive(Clone)]
struct RuntimeState {
    session_manager: Arc<Mutex<SessionManager>>,
    event_buses: Arc<Mutex<BTreeMap<String, broadcast::Sender<EventEnvelope>>>>,
    data_plane: DataPlaneService,
}

impl RuntimeState {
    fn new(config: &EngineRuntimeConfig) -> Self {
        Self {
            session_manager: Arc::new(Mutex::new(SessionManager::new())),
            event_buses: Arc::new(Mutex::new(BTreeMap::new())),
            data_plane: DataPlaneService::new(config.cache_root.clone()),
        }
    }

    async fn event_bus(&self, session_id: &str) -> broadcast::Sender<EventEnvelope> {
        let mut buses = self.event_buses.lock().await;
        if let Some(existing) = buses.get(session_id) {
            return existing.clone();
        }
        let (sender, _) = broadcast::channel(256);
        buses.insert(session_id.to_owned(), sender.clone());
        sender
    }
}

pub async fn run_runtime_server(
    listener: TcpListener,
    config: EngineRuntimeConfig,
    shutdown: oneshot::Receiver<()>,
) -> std::io::Result<()> {
    let state = RuntimeState::new(&config);
    let app = Router::new()
        .route("/v1/info", get(runtime_info))
        .route("/v1/sessions", post(create_session))
        .route("/v1/sessions/{session_id}/snapshot", get(snapshot_endpoint))
        .route("/v1/sessions/{session_id}/connect", get(connect_endpoint))
        .route("/v1/data/{*chunk_path}", get(data_get).head(data_head))
        .with_state(state);

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown.await;
        })
        .await
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct RuntimeInfo {
    engine_runtime: &'static str,
    control_plane_transport: &'static str,
    data_plane_transport: &'static str,
}

async fn runtime_info() -> Json<RuntimeInfo> {
    Json(RuntimeInfo {
        engine_runtime: "lucida-engine",
        control_plane_transport: "websocket",
        data_plane_transport: "http",
    })
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
struct CreateSessionRequest {
    name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct CreateSessionResponse {
    session_id: String,
}

async fn create_session(
    State(state): State<RuntimeState>,
    Json(request): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<CreateSessionResponse>), (StatusCode, Json<RuntimeHttpError>)> {
    if request.name.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(RuntimeHttpError {
                code: "validation_error",
                message: "session name must be non-empty".to_owned(),
            }),
        ));
    }

    let session_id = {
        let mut manager = state.session_manager.lock().await;
        manager.create_session(request.name).session_id
    };
    let _ = state.event_bus(&session_id).await;

    Ok((
        StatusCode::CREATED,
        Json(CreateSessionResponse { session_id }),
    ))
}

async fn snapshot_endpoint(
    State(state): State<RuntimeState>,
    Path(session_id): Path<String>,
) -> Result<Json<RuntimeSnapshotEnvelope>, (StatusCode, Json<RuntimeHttpError>)> {
    let snapshot = {
        let mut manager = state.session_manager.lock().await;
        let attached = manager.attach_client(AttachRequest {
            session_id: session_id.clone(),
            client_label: "http-snapshot".to_owned(),
            requested_permission: PermissionClass::View,
        });
        let attached = match attached {
            Ok(value) => value,
            Err(error) => {
                return Err((
                    StatusCode::NOT_FOUND,
                    Json(RuntimeHttpError {
                        code: "not_found",
                        message: error.to_string(),
                    }),
                ));
            }
        };
        let client_id = attached.snapshot.client_view.client_id.clone();
        let _ = manager.detach_client(&session_id, &client_id);
        attached
    };

    Ok(Json(RuntimeSnapshotEnvelope::from_snapshot(&snapshot)))
}

async fn connect_endpoint(
    ws: WebSocketUpgrade,
    State(state): State<RuntimeState>,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(state, session_id, socket))
}

async fn handle_socket(state: RuntimeState, session_id: String, socket: WebSocket) {
    let (mut writer, mut reader) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(64);

    let write_task = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            if writer.send(Message::Text(message.into())).await.is_err() {
                break;
            }
        }
    });

    let initial_frame = match reader.next().await {
        Some(Ok(Message::Text(text))) => text,
        _ => {
            write_task.abort();
            return;
        }
    };

    let handshake = match serde_json::from_str::<HandshakeMessage>(&initial_frame) {
        Ok(value) => value,
        Err(error) => {
            let _ = outbound_tx
                .send(runtime_ws_error("validation_error", &error.to_string()))
                .await;
            drop(outbound_tx);
            let _ = write_task.await;
            return;
        }
    };

    let attach_outcome = match attach_or_reconnect(&state, &session_id, handshake).await {
        Ok(value) => value,
        Err(error) => {
            let _ = outbound_tx
                .send(runtime_ws_error(error.code, &error.message))
                .await;
            drop(outbound_tx);
            let _ = write_task.await;
            return;
        }
    };

    let initial_snapshot = RuntimeSnapshotEnvelope::from_snapshot(&attach_outcome.snapshot);
    let snapshot_text = match serde_json::to_string(&initial_snapshot) {
        Ok(value) => value,
        Err(error) => {
            let _ = outbound_tx
                .send(runtime_ws_error("internal_error", &error.to_string()))
                .await;
            drop(outbound_tx);
            let _ = write_task.await;
            return;
        }
    };
    let _ = outbound_tx.send(snapshot_text).await;

    let mut event_rx = state.event_bus(&session_id).await.subscribe();
    let event_forward_tx = outbound_tx.clone();
    let event_forward_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(event) => {
                    let runtime_event = RuntimeEventEnvelope::from_event(&event);
                    let text = match serde_json::to_string(&runtime_event) {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                    if event_forward_tx.send(text).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let router = CommandRouter::new();
    let attached_client_id = attach_outcome.client_id;
    while let Some(frame) = reader.next().await {
        match frame {
            Ok(Message::Text(text)) => {
                let parse = parse_command_message(&text);
                let command = match parse {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = outbound_tx
                            .send(runtime_ws_error("validation_error", &error))
                            .await;
                        continue;
                    }
                };

                let outcome = {
                    let mut manager = state.session_manager.lock().await;
                    router.route(&mut manager, command.clone())
                };
                match outcome {
                    Ok(command_outcome) => {
                        if let Ok(ack_text) =
                            serde_json::to_string(&RuntimeCommandAck::from(&command_outcome.ack))
                        {
                            let _ = outbound_tx.send(ack_text).await;
                        }
                        let event_bus = state.event_bus(&command_outcome.ack.session_id).await;
                        for event in command_outcome.events {
                            let _ = event_bus.send(event);
                        }
                    }
                    Err(error) => {
                        let runtime_error = command_error_to_envelope(&command, &error);
                        if let Ok(text) = serde_json::to_string(&runtime_error) {
                            let _ = outbound_tx.send(text).await;
                        }
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Binary(_)) | Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => continue,
            Err(_) => break,
        }
    }

    {
        let mut manager = state.session_manager.lock().await;
        let _ = manager.detach_client(&session_id, &attached_client_id);
    }

    event_forward_task.abort();
    drop(outbound_tx);
    let _ = write_task.await;
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "message_type", rename_all = "snake_case")]
enum HandshakeMessage {
    Attach {
        client_label: String,
        requested_permission: String,
    },
    Reconnect {
        client_label: String,
        requested_permission: String,
        previous_client_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
struct AttachOutcome {
    snapshot: SessionSnapshotEnvelope,
    client_id: String,
}

#[derive(Debug, Clone, PartialEq)]
struct RuntimeWsErrorMessage {
    code: &'static str,
    message: String,
}

async fn attach_or_reconnect(
    state: &RuntimeState,
    session_id: &str,
    handshake: HandshakeMessage,
) -> Result<AttachOutcome, RuntimeWsErrorMessage> {
    match handshake {
        HandshakeMessage::Attach {
            client_label,
            requested_permission,
        } => {
            let permission = permission_from_wire(&requested_permission).ok_or_else(|| {
                RuntimeWsErrorMessage {
                    code: "validation_error",
                    message: "requested_permission must be one of view/control/admin".to_owned(),
                }
            })?;
            let snapshot = {
                let mut manager = state.session_manager.lock().await;
                manager
                    .attach_client(AttachRequest {
                        session_id: session_id.to_owned(),
                        client_label,
                        requested_permission: permission,
                    })
                    .map_err(|error| RuntimeWsErrorMessage {
                        code: "not_found",
                        message: error.to_string(),
                    })?
            };
            let client_id = snapshot.snapshot.client_view.client_id.clone();
            Ok(AttachOutcome {
                snapshot,
                client_id,
            })
        }
        HandshakeMessage::Reconnect {
            client_label,
            requested_permission,
            previous_client_id,
        } => {
            let permission = permission_from_wire(&requested_permission).ok_or_else(|| {
                RuntimeWsErrorMessage {
                    code: "validation_error",
                    message: "requested_permission must be one of view/control/admin".to_owned(),
                }
            })?;
            let snapshot = {
                let mut manager = state.session_manager.lock().await;
                manager
                    .reconnect_client(ReconnectRequest {
                        session_id: session_id.to_owned(),
                        previous_client_id,
                        client_label,
                        requested_permission: permission,
                    })
                    .map_err(|error| RuntimeWsErrorMessage {
                        code: "not_found",
                        message: error.to_string(),
                    })?
            };
            let client_id = snapshot.snapshot.client_view.client_id.clone();
            Ok(AttachOutcome {
                snapshot,
                client_id,
            })
        }
    }
}

fn runtime_ws_error(code: &'static str, message: &str) -> String {
    serde_json::json!({
        "message_type": "error",
        "code": code,
        "message": message
    })
    .to_string()
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
struct RuntimeCommandMessage {
    message_type: String,
    schema_version: String,
    session_id: String,
    request_id: String,
    client_id: String,
    client_seq: u64,
    op: String,
    scope: String,
    requires_lease: bool,
    args: serde_json::Value,
}

fn parse_command_message(raw: &str) -> Result<CommandEnvelope, String> {
    let wire: RuntimeCommandMessage =
        serde_json::from_str(raw).map_err(|error| format!("invalid command JSON: {error}"))?;

    let scope = match wire.scope.as_str() {
        "client_view" => CommandScope::ClientView,
        "scene_shared" => CommandScope::SceneShared,
        "admin" => CommandScope::Admin,
        _ => {
            return Err("scope must be one of client_view/scene_shared/admin".to_owned());
        }
    };

    let args = parse_command_args(&wire.op, wire.args)?;

    Ok(CommandEnvelope {
        message_type: wire.message_type,
        schema_version: wire.schema_version,
        session_id: wire.session_id,
        request_id: wire.request_id,
        client_id: wire.client_id,
        client_seq: wire.client_seq,
        op: wire.op,
        scope,
        requires_lease: wire.requires_lease,
        args,
    })
}

fn parse_command_args(op: &str, args: serde_json::Value) -> Result<CommandArgs, String> {
    match op {
        "view.set_active_layer" => {
            let active_layer_id = args
                .get("active_layer_id")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned);
            Ok(CommandArgs::ViewSetActiveLayer { active_layer_id })
        }
        "view.pan" => {
            let dx = args
                .get("dx")
                .and_then(serde_json::Value::as_f64)
                .ok_or_else(|| "view.pan args.dx must be a number".to_owned())?;
            let dy = args
                .get("dy")
                .and_then(serde_json::Value::as_f64)
                .ok_or_else(|| "view.pan args.dy must be a number".to_owned())?;
            let gesture_id = args
                .get("gesture_id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "view.pan args.gesture_id must be a string".to_owned())?;
            Ok(CommandArgs::ViewPan {
                dx,
                dy,
                gesture_id: gesture_id.to_owned(),
            })
        }
        "view.zoom" => {
            let zoom = args
                .get("zoom")
                .and_then(serde_json::Value::as_f64)
                .ok_or_else(|| "view.zoom args.zoom must be a number".to_owned())?;
            let anchor_x = args
                .get("anchor_x")
                .and_then(serde_json::Value::as_f64)
                .ok_or_else(|| "view.zoom args.anchor_x must be a number".to_owned())?;
            let anchor_y = args
                .get("anchor_y")
                .and_then(serde_json::Value::as_f64)
                .ok_or_else(|| "view.zoom args.anchor_y must be a number".to_owned())?;
            let gesture_id = args
                .get("gesture_id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "view.zoom args.gesture_id must be a string".to_owned())?;
            Ok(CommandArgs::ViewZoom {
                zoom,
                anchor_x,
                anchor_y,
                gesture_id: gesture_id.to_owned(),
            })
        }
        "view.set_z" => {
            let z_index = args
                .get("z_index")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| "view.set_z args.z_index must be an integer".to_owned())?;
            let z_index = u32::try_from(z_index)
                .map_err(|_| "view.set_z args.z_index exceeds u32 range".to_owned())?;
            Ok(CommandArgs::ViewSetZ { z_index })
        }
        "view.set_t" => {
            let t_index = args
                .get("t_index")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| "view.set_t args.t_index must be an integer".to_owned())?;
            let t_index = u32::try_from(t_index)
                .map_err(|_| "view.set_t args.t_index exceeds u32 range".to_owned())?;
            Ok(CommandArgs::ViewSetT { t_index })
        }
        "view.set_channels" => {
            let channels = args
                .get("channels")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| "view.set_channels args.channels must be an array".to_owned())?
                .iter()
                .map(|value| {
                    let as_u64 = value.as_u64().ok_or_else(|| {
                        "view.set_channels channels entries must be integers".to_owned()
                    })?;
                    u32::try_from(as_u64)
                        .map_err(|_| "view.set_channels channel id exceeds u32 range".to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(CommandArgs::ViewSetChannels { channels })
        }
        "scene.add_source" => {
            let name = args
                .get("name")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "scene.add_source args.name must be a string".to_owned())?;
            let uri = args
                .get("uri")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "scene.add_source args.uri must be a string".to_owned())?;
            Ok(CommandArgs::SceneAddSource {
                name: name.to_owned(),
                uri: uri.to_owned(),
            })
        }
        "scene.layer_add" => {
            let name = args
                .get("name")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "scene.layer_add args.name must be a string".to_owned())?;
            Ok(CommandArgs::SceneLayerAdd {
                name: name.to_owned(),
            })
        }
        "lease.request" => Ok(CommandArgs::LeaseRequest),
        "lease.steal" => Ok(CommandArgs::LeaseSteal),
        _ => Ok(CommandArgs::LeaseRequest),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct RuntimeWarningEntry {
    #[serde(rename = "warningCode")]
    warning_code: String,
    severity: String,
    message: String,
}

impl From<&WarningEntry> for RuntimeWarningEntry {
    fn from(value: &WarningEntry) -> Self {
        Self {
            warning_code: warning_code_name(value.warning_code).to_owned(),
            severity: warning_severity_name(value.severity).to_owned(),
            message: value.message.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSourceState {
    source_id: String,
    name: String,
    status: String,
    latest_working_generation_seq: u64,
}

impl From<&SourceRecord> for RuntimeSourceState {
    fn from(value: &SourceRecord) -> Self {
        Self {
            source_id: value.source_id.clone(),
            name: value.name.clone(),
            status: source_status_name(value.status).to_owned(),
            latest_working_generation_seq: value.latest_working_generation_seq,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDatasetState {
    dataset_id: String,
    source_id: Option<String>,
    resolved_generation_seq: u64,
}

impl From<&DatasetBinding> for RuntimeDatasetState {
    fn from(value: &DatasetBinding) -> Self {
        Self {
            dataset_id: value.dataset_id.clone(),
            source_id: value.source_id.clone(),
            resolved_generation_seq: value.resolved_generation_seq,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLayerState {
    layer_id: String,
    name: String,
    layer_rev: u64,
    metadata_rev: u64,
    write_rev: u64,
}

impl From<&LayerState> for RuntimeLayerState {
    fn from(value: &LayerState) -> Self {
        Self {
            layer_id: value.layer_id.clone(),
            name: value.name.clone(),
            layer_rev: value.layer_rev,
            metadata_rev: value.metadata_rev,
            write_rev: value.write_rev,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct RuntimeSessionState {
    session_id: String,
    session_rev: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct RuntimeSharedSceneState {
    scene_rev: u64,
    sources: BTreeMap<String, RuntimeSourceState>,
    datasets: BTreeMap<String, RuntimeDatasetState>,
    layers: BTreeMap<String, RuntimeLayerState>,
    warnings: Vec<RuntimeWarningEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct RuntimeClientViewState {
    client_id: String,
    view_rev: u64,
    active_layer_id: Option<String>,
    center_x: f64,
    center_y: f64,
    zoom: f64,
    z_index: u32,
    t_index: u32,
    selected_channels: Vec<u32>,
    warnings: Vec<RuntimeWarningEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct RuntimeSnapshotPayload {
    session: RuntimeSessionState,
    shared_scene: RuntimeSharedSceneState,
    client_view: RuntimeClientViewState,
    warnings: Vec<RuntimeWarningEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct RuntimeSnapshotEnvelope {
    message_type: String,
    schema_version: String,
    session_id: String,
    session_rev: u64,
    permission_class: String,
    is_lease_holder: bool,
    snapshot: RuntimeSnapshotPayload,
    emitted_at: String,
}

impl RuntimeSnapshotEnvelope {
    fn from_snapshot(snapshot: &SessionSnapshotEnvelope) -> Self {
        let sources = snapshot
            .snapshot
            .shared_scene
            .sources
            .iter()
            .map(|(key, value)| (key.clone(), RuntimeSourceState::from(value)))
            .collect::<BTreeMap<_, _>>();
        let datasets = snapshot
            .snapshot
            .shared_scene
            .datasets
            .iter()
            .map(|(key, value)| (key.clone(), RuntimeDatasetState::from(value)))
            .collect::<BTreeMap<_, _>>();
        let layers = snapshot
            .snapshot
            .shared_scene
            .layers
            .iter()
            .map(|(key, value)| (key.clone(), RuntimeLayerState::from(value)))
            .collect::<BTreeMap<_, _>>();

        Self {
            message_type: snapshot.message_type.clone(),
            schema_version: snapshot.schema_version.clone(),
            session_id: snapshot.session_id.clone(),
            session_rev: snapshot.session_rev,
            permission_class: permission_class_name(snapshot.snapshot.permissions.permission_class)
                .to_owned(),
            is_lease_holder: snapshot.snapshot.permissions.is_lease_holder,
            snapshot: RuntimeSnapshotPayload {
                session: RuntimeSessionState {
                    session_id: snapshot.snapshot.session.session_id.clone(),
                    session_rev: snapshot.snapshot.session.session_rev,
                },
                shared_scene: RuntimeSharedSceneState {
                    scene_rev: snapshot.snapshot.shared_scene.scene_rev,
                    sources,
                    datasets,
                    layers,
                    warnings: snapshot
                        .snapshot
                        .shared_scene
                        .warnings
                        .iter()
                        .map(RuntimeWarningEntry::from)
                        .collect::<Vec<_>>(),
                },
                client_view: RuntimeClientViewState {
                    client_id: snapshot.snapshot.client_view.client_id.clone(),
                    view_rev: snapshot.snapshot.client_view.view_rev,
                    active_layer_id: snapshot.snapshot.client_view.active_layer_id.clone(),
                    center_x: snapshot.snapshot.client_view.center_x,
                    center_y: snapshot.snapshot.client_view.center_y,
                    zoom: snapshot.snapshot.client_view.zoom,
                    z_index: snapshot.snapshot.client_view.z_index,
                    t_index: snapshot.snapshot.client_view.t_index,
                    selected_channels: snapshot.snapshot.client_view.selected_channels.clone(),
                    warnings: snapshot
                        .snapshot
                        .client_view
                        .warnings
                        .iter()
                        .map(RuntimeWarningEntry::from)
                        .collect::<Vec<_>>(),
                },
                warnings: snapshot
                    .snapshot
                    .warnings
                    .iter()
                    .map(RuntimeWarningEntry::from)
                    .collect::<Vec<_>>(),
            },
            emitted_at: snapshot.emitted_at.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct RuntimeEventEnvelope {
    message_type: String,
    schema_version: String,
    session_id: String,
    session_rev: u64,
    event_type: String,
    payload: serde_json::Value,
    emitted_at: String,
}

impl RuntimeEventEnvelope {
    fn from_event(event: &EventEnvelope) -> Self {
        Self {
            message_type: event.message_type.clone(),
            schema_version: event.schema_version.clone(),
            session_id: event.session_id.clone(),
            session_rev: event.session_rev,
            event_type: event_type_name(event.event_type).to_owned(),
            payload: event_payload_json(&event.payload),
            emitted_at: event.emitted_at.clone(),
        }
    }
}

fn event_payload_json(payload: &EventPayload) -> serde_json::Value {
    match payload {
        EventPayload::SessionClientJoined(value) => serde_json::json!({
            "client_id": value.client_id,
            "label": value.label,
            "permission_class": value.permission_class,
            "connected_at": value.connected_at,
            "last_seen_at": value.last_seen_at,
            "is_lease_holder": value.is_lease_holder
        }),
        EventPayload::LeaseChanged(value) => serde_json::json!({
            "lease_state": value.lease_state,
            "change_kind": value.change_kind,
            "changed_by_client_id": value.changed_by_client_id,
            "changed_by_label": value.changed_by_label,
            "previous_lease_holder_client_id": value.previous_lease_holder_client_id,
            "previous_lease_holder_label": value.previous_lease_holder_label,
            "audit_event_kind": value.audit_event_kind,
            "audit_recorded_at": value.audit_recorded_at
        }),
        EventPayload::WarningsUpdated(value) => serde_json::json!({
            "client_id": value.client_id,
            "warnings": value.warnings.iter().map(|warning| {
                serde_json::json!({
                    "warningCode": warning.warning_code,
                    "severity": warning.severity,
                    "message": warning.message
                })
            }).collect::<Vec<_>>()
        }),
        EventPayload::ViewUpdated(value) => serde_json::json!({
            "client_id": value.client_id,
            "view_rev": value.view_rev,
            "active_layer_id": value.active_layer_id,
            "center_x": value.center_x,
            "center_y": value.center_y,
            "zoom": value.zoom,
            "z_index": value.z_index,
            "t_index": value.t_index,
            "selected_channels": value.selected_channels
        }),
        EventPayload::SceneSourceUpsert(value) => serde_json::json!({
            "sourceId": value.source_id,
            "name": value.name,
            "status": value.status,
            "latestWorkingGenerationSeq": value.latest_working_generation_seq
        }),
        EventPayload::SceneDatasetUpsert(value) => serde_json::json!({
            "datasetId": value.dataset_id,
            "sourceId": value.source_id,
            "resolvedGenerationSeq": value.resolved_generation_seq
        }),
        EventPayload::SceneLayerUpsert(value) => serde_json::json!({
            "layerId": value.layer_id,
            "name": value.name,
            "layerRev": value.layer_rev,
            "metadataRev": value.metadata_rev,
            "writeRev": value.write_rev
        }),
        EventPayload::SourceGenerationDetected(value)
        | EventPayload::SourceGenerationStarted(value)
        | EventPayload::SourceGenerationProgress(value)
        | EventPayload::SourceGenerationReady(value) => serde_json::json!({
            "sourceId": value.source_id,
            "generationSeq": value.generation_seq,
            "stage": value.stage,
            "progressPercent": value.progress_percent,
            "previewReady": value.preview_ready,
            "tile2dReadyLods": value.tile2d_ready_lods,
            "brick3dReadyLods": value.brick3d_ready_lods
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct RuntimeCommandAck {
    message_type: String,
    schema_version: String,
    session_id: String,
    request_id: String,
    client_id: String,
    client_seq: u64,
    accepted: bool,
    resulting_session_rev: u64,
    resulting_scene_rev: Option<u64>,
    resulting_view_rev: Option<u64>,
    created_object_id: Option<String>,
}

impl From<&crate::CommandAck> for RuntimeCommandAck {
    fn from(value: &crate::CommandAck) -> Self {
        Self {
            message_type: value.message_type.clone(),
            schema_version: value.schema_version.clone(),
            session_id: value.session_id.clone(),
            request_id: value.request_id.clone(),
            client_id: value.client_id.clone(),
            client_seq: value.client_seq,
            accepted: value.accepted,
            resulting_session_rev: value.resulting_session_rev,
            resulting_scene_rev: value.resulting_scene_rev,
            resulting_view_rev: value.resulting_view_rev,
            created_object_id: value.created_object_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct RuntimeHttpError {
    code: &'static str,
    message: String,
}

async fn data_get(
    State(state): State<RuntimeState>,
    Path(chunk_path): Path<String>,
) -> Result<Response, (StatusCode, Json<RuntimeHttpError>)> {
    data_response(state, chunk_path, false)
}

async fn data_head(
    State(state): State<RuntimeState>,
    Path(chunk_path): Path<String>,
) -> Result<Response, (StatusCode, Json<RuntimeHttpError>)> {
    data_response(state, chunk_path, true)
}

fn data_response(
    state: RuntimeState,
    chunk_path: String,
    head_only: bool,
) -> Result<Response, (StatusCode, Json<RuntimeHttpError>)> {
    let canonical_path = format!("/{chunk_path}");
    let served = state
        .data_plane
        .serve_get(&canonical_path)
        .map_err(data_plane_error)?;

    let mut response = Response::new(if head_only {
        axum::body::Body::empty()
    } else {
        axum::body::Body::from(served.body)
    });
    *response.status_mut() = StatusCode::from_u16(served.status_code).unwrap_or(StatusCode::OK);

    let headers = response.headers_mut();
    for (key, value) in served.headers {
        let Ok(name) = HeaderName::try_from(key) else {
            continue;
        };
        let Ok(value) = HeaderValue::try_from(value) else {
            continue;
        };
        headers.insert(name, value);
    }

    Ok(response)
}

fn data_plane_error(error: DataPlaneError) -> (StatusCode, Json<RuntimeHttpError>) {
    match error {
        DataPlaneError::InvalidPath { message } => (
            StatusCode::BAD_REQUEST,
            Json(RuntimeHttpError {
                code: "validation_error",
                message,
            }),
        ),
        DataPlaneError::NotFound { path } => (
            StatusCode::NOT_FOUND,
            Json(RuntimeHttpError {
                code: "not_found",
                message: format!("payload not found at {path}"),
            }),
        ),
        DataPlaneError::ReadFailed { path, reason } => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(RuntimeHttpError {
                code: "internal_error",
                message: format!("failed to read payload at {path}: {reason}"),
            }),
        ),
    }
}

fn permission_from_wire(value: &str) -> Option<PermissionClass> {
    match value {
        "view" => Some(PermissionClass::View),
        "control" => Some(PermissionClass::Control),
        "admin" => Some(PermissionClass::Admin),
        _ => None,
    }
}

fn permission_class_name(value: PermissionClass) -> &'static str {
    match value {
        PermissionClass::View => "view",
        PermissionClass::Control => "control",
        PermissionClass::Admin => "admin",
    }
}

fn source_status_name(value: SourceStatus) -> &'static str {
    match value {
        SourceStatus::Idle => "idle",
        SourceStatus::Watching => "watching",
        SourceStatus::Building => "building",
        SourceStatus::Error => "error",
    }
}

fn warning_code_name(value: WarningCode) -> &'static str {
    match value {
        WarningCode::UncalibratedOverlay => "uncalibrated_overlay",
        WarningCode::StaleDerivedLayer => "stale_derived_layer",
        WarningCode::IncompleteLabelIndex => "incomplete_label_index",
        WarningCode::ComputedAtLod => "computed_at_lod",
        WarningCode::GenerationBuildIncomplete => "generation_build_incomplete",
        WarningCode::MissingActiveLayer => "missing_active_layer",
    }
}

fn warning_severity_name(value: WarningSeverity) -> &'static str {
    match value {
        WarningSeverity::Info => "info",
        WarningSeverity::Warning => "warning",
        WarningSeverity::Error => "error",
    }
}

fn event_type_name(value: EventType) -> &'static str {
    match value {
        EventType::SessionClientJoined => "session_client_joined",
        EventType::LeaseChanged => "lease_changed",
        EventType::WarningsUpdated => "warnings_updated",
        EventType::ViewUpdated => "view_updated",
        EventType::SceneSourceUpsert => "scene_source_upsert",
        EventType::SceneDatasetUpsert => "scene_dataset_upsert",
        EventType::SceneLayerUpsert => "scene_layer_upsert",
        EventType::SourceGenerationDetected => "source_generation_detected",
        EventType::SourceGenerationStarted => "source_generation_started",
        EventType::SourceGenerationProgress => "source_generation_progress",
        EventType::SourceGenerationReady => "source_generation_ready",
    }
}
