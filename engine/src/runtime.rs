use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::middleware::map_response;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify, broadcast, mpsc, oneshot};
use tokio::time::Duration;

use crate::chunk_key::{ChunkAssetKind, ChunkKey};
use crate::command_router::{
    CommandArgs, CommandEnvelope, CommandRouter, CommandScope, command_error_to_envelope,
};
use crate::data_plane::DataPlaneError;
use crate::errors::SessionError;
use crate::event_stream::{
    DatasetUpsertPayload, EventEnvelope, EventPayload, EventType, SourceGenerationPayload,
    SourceUpsertPayload,
};
use crate::model::{
    AddSourceRequest, AttachRequest, DatasetBinding, GenerationRecord, LayerState, PermissionClass,
    ReconnectRequest, SessionSnapshotEnvelope, SourceRecord, SourceStatus, WarningCode,
    WarningEntry, WarningSeverity,
};
use crate::{DataPlaneService, IdAllocator, SessionManager};

#[derive(Debug, Clone, PartialEq)]
pub struct EngineRuntimeConfig {
    pub cache_root: PathBuf,
    pub generation_worker_startup_delay_ms: u64,
    pub generation_worker_full_build_delay_ms: u64,
    pub eager_full_build_on_open: bool,
    pub generation_on_demand_build_delay_ms: u64,
}

impl Default for EngineRuntimeConfig {
    fn default() -> Self {
        Self {
            cache_root: PathBuf::from(".tmp/cache"),
            generation_worker_startup_delay_ms: 0,
            generation_worker_full_build_delay_ms: 0,
            eager_full_build_on_open: false,
            generation_on_demand_build_delay_ms: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GenerationBuildRequest {
    session_id: String,
    source_id: String,
    generation_seq: u64,
}

#[derive(Clone)]
struct RuntimeState {
    session_manager: Arc<Mutex<SessionManager>>,
    event_buses: Arc<Mutex<BTreeMap<String, broadcast::Sender<EventEnvelope>>>>,
    data_plane: DataPlaneService,
    cache_root: PathBuf,
    generation_queue: mpsc::UnboundedSender<GenerationBuildRequest>,
    inflight_tile_builds: Arc<Mutex<BTreeMap<String, Arc<Notify>>>>,
    on_demand_build_delay: Duration,
}

impl RuntimeState {
    fn new(
        config: &EngineRuntimeConfig,
        generation_queue: mpsc::UnboundedSender<GenerationBuildRequest>,
    ) -> Self {
        let allocator =
            IdAllocator::with_persistence(config.cache_root.join("id_allocator_state.json"));
        Self {
            session_manager: Arc::new(Mutex::new(SessionManager::with_id_allocator(allocator))),
            event_buses: Arc::new(Mutex::new(BTreeMap::new())),
            data_plane: DataPlaneService::new(config.cache_root.clone()),
            cache_root: config.cache_root.clone(),
            generation_queue,
            inflight_tile_builds: Arc::new(Mutex::new(BTreeMap::new())),
            on_demand_build_delay: Duration::from_millis(
                config.generation_on_demand_build_delay_ms,
            ),
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
    std::fs::create_dir_all(&config.cache_root)?;
    let (generation_queue, generation_rx) = mpsc::unbounded_channel();
    let state = RuntimeState::new(&config, generation_queue);
    tokio::spawn(generation_worker_loop(
        state.clone(),
        generation_rx,
        Duration::from_millis(config.generation_worker_startup_delay_ms),
        Duration::from_millis(config.generation_worker_full_build_delay_ms),
        config.eager_full_build_on_open,
    ));
    let app = Router::new()
        .route("/v1/info", get(runtime_info).options(cors_preflight))
        .route("/v1/sessions", post(create_session).options(cors_preflight))
        .route(
            "/v1/sessions/{session_id}/sources",
            post(add_source_endpoint).options(cors_preflight),
        )
        .route(
            "/v1/sessions/{session_id}/snapshot",
            get(snapshot_endpoint).options(cors_preflight),
        )
        .route(
            "/v1/sessions/{session_id}/connect",
            get(connect_endpoint).options(cors_preflight),
        )
        .route(
            "/v1/data/{*chunk_path}",
            get(data_get).head(data_head).options(cors_preflight),
        )
        .with_state(state)
        .layer(map_response(add_cors_headers));

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

#[derive(Debug, Clone, PartialEq, Deserialize)]
struct AddSourceRuntimeRequest {
    name: String,
    uri: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct AddSourceRuntimeResponse {
    source_id: String,
    dataset_id: String,
    generation_id: String,
    generation_seq: u64,
    source_status: &'static str,
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

async fn add_source_endpoint(
    State(state): State<RuntimeState>,
    Path(session_id): Path<String>,
    Json(request): Json<AddSourceRuntimeRequest>,
) -> Result<(StatusCode, Json<AddSourceRuntimeResponse>), (StatusCode, Json<RuntimeHttpError>)> {
    if request.name.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(RuntimeHttpError {
                code: "validation_error",
                message: "source name must be non-empty".to_owned(),
            }),
        ));
    }
    if request.uri.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(RuntimeHttpError {
                code: "validation_error",
                message: "source uri must be non-empty".to_owned(),
            }),
        ));
    }

    let (response, events, build_request) = {
        let mut manager = state.session_manager.lock().await;

        let added = manager
            .add_source(
                &session_id,
                AddSourceRequest {
                    name: request.name.trim().to_owned(),
                    uri: request.uri.trim().to_owned(),
                },
            )
            .map_err(session_error)?;
        let (session_rev_add, _) = manager
            .session_and_scene_revisions(&session_id)
            .map_err(session_error)?;

        let mut events = vec![
            EventEnvelope::scene_source_upsert(
                session_id.clone(),
                session_rev_add,
                SourceUpsertPayload::from(&added.source),
                crate::clock::rfc3339_now(),
            ),
            EventEnvelope::scene_dataset_upsert(
                session_id.clone(),
                session_rev_add,
                DatasetUpsertPayload::from(&added.dataset),
                crate::clock::rfc3339_now(),
            ),
        ];

        let detected = manager
            .detect_generation(&session_id, &added.source.source_id)
            .map_err(session_error)?;
        let (session_rev_detected, _) = manager
            .session_and_scene_revisions(&session_id)
            .map_err(session_error)?;
        events.push(EventEnvelope::source_generation_detected(
            session_id.clone(),
            session_rev_detected,
            SourceGenerationPayload::from(&detected),
            crate::clock::rfc3339_now(),
        ));

        let started = manager
            .start_generation(
                &session_id,
                &added.source.source_id,
                detected.generation_seq,
            )
            .map_err(session_error)?;
        let (session_rev_started, _) = manager
            .session_and_scene_revisions(&session_id)
            .map_err(session_error)?;
        events.push(EventEnvelope::source_generation_started(
            session_id.clone(),
            session_rev_started,
            SourceGenerationPayload::from(&started),
            crate::clock::rfc3339_now(),
        ));

        let source_state = manager
            .source_state(&session_id, &added.source.source_id)
            .map_err(session_error)?;
        let dataset_state = manager
            .dataset_for_source(&session_id, &added.source.source_id)
            .map_err(session_error)?;

        (
            AddSourceRuntimeResponse {
                source_id: source_state.source_id,
                dataset_id: dataset_state.dataset_id,
                generation_id: started.generation_id,
                generation_seq: started.generation_seq,
                source_status: source_status_name(source_state.status),
            },
            events,
            GenerationBuildRequest {
                session_id: session_id.clone(),
                source_id: added.source.source_id,
                generation_seq: detected.generation_seq,
            },
        )
    };

    state.generation_queue.send(build_request).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(RuntimeHttpError {
                code: "internal_error",
                message: "generation worker queue is unavailable".to_owned(),
            }),
        )
    })?;

    let event_bus = state.event_bus(&session_id).await;
    for event in events {
        let _ = event_bus.send(event);
    }

    Ok((StatusCode::CREATED, Json(response)))
}

async fn generation_worker_loop(
    state: RuntimeState,
    mut receiver: mpsc::UnboundedReceiver<GenerationBuildRequest>,
    startup_delay: Duration,
    full_build_delay: Duration,
    eager_full_build_on_open: bool,
) {
    while let Some(request) = receiver.recv().await {
        if !startup_delay.is_zero() {
            tokio::time::sleep(startup_delay).await;
        }
        let first_paint_events = {
            let mut manager = state.session_manager.lock().await;
            execute_generation_first_paint_phase(&mut manager, &request, state.cache_root.clone())
        };
        if first_paint_events.is_empty() {
            continue;
        }
        send_generation_events(&state, &request.session_id, first_paint_events.clone()).await;
        if has_generation_failed(&first_paint_events) {
            continue;
        }

        if !eager_full_build_on_open {
            let ready_events = {
                let mut manager = state.session_manager.lock().await;
                execute_generation_ready_phase(&mut manager, &request)
            };
            if !ready_events.is_empty() {
                send_generation_events(&state, &request.session_id, ready_events).await;
            }
            continue;
        }

        if !full_build_delay.is_zero() {
            tokio::time::sleep(full_build_delay).await;
        }

        let completion_events = {
            let mut manager = state.session_manager.lock().await;
            execute_generation_completion_phase(&mut manager, &request)
        };
        if completion_events.is_empty() {
            continue;
        }
        send_generation_events(&state, &request.session_id, completion_events).await;
    }
}

fn execute_generation_first_paint_phase(
    manager: &mut SessionManager,
    request: &GenerationBuildRequest,
    cache_root: PathBuf,
) -> Vec<EventEnvelope> {
    if let Err(error) = manager.build_canonical_cache_for_generation(
        &request.session_id,
        &request.source_id,
        request.generation_seq,
        cache_root,
    ) {
        return generation_failure_events(manager, request, &error);
    }

    let first_paint = match manager.build_first_paint_tile_preview_for_generation(
        &request.session_id,
        &request.source_id,
        request.generation_seq,
    ) {
        Ok(value) => value,
        Err(error) => return generation_failure_events(manager, request, &error),
    };
    let (session_rev_first_paint, _) =
        match manager.session_and_scene_revisions(&request.session_id) {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        };
    vec![EventEnvelope::source_generation_progress(
        request.session_id.clone(),
        session_rev_first_paint,
        SourceGenerationPayload::from(&first_paint),
        crate::clock::rfc3339_now(),
    )]
}

fn execute_generation_completion_phase(
    manager: &mut SessionManager,
    request: &GenerationBuildRequest,
) -> Vec<EventEnvelope> {
    let progressed = match manager.build_tile_preview_for_generation(
        &request.session_id,
        &request.source_id,
        request.generation_seq,
    ) {
        Ok(value) => value,
        Err(error) => return generation_failure_events(manager, request, &error),
    };
    let (session_rev_progress, _) = match manager.session_and_scene_revisions(&request.session_id) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let mut events = vec![EventEnvelope::source_generation_progress(
        request.session_id.clone(),
        session_rev_progress,
        SourceGenerationPayload::from(&progressed),
        crate::clock::rfc3339_now(),
    )];

    let ready = match manager.mark_generation_ready(
        &request.session_id,
        &request.source_id,
        request.generation_seq,
    ) {
        Ok(value) => value,
        Err(error) => return generation_failure_events(manager, request, &error),
    };
    let source_state = match manager.source_state(&request.session_id, &request.source_id) {
        Ok(value) => value,
        Err(_) => return events,
    };
    let dataset_state = match manager.dataset_for_source(&request.session_id, &request.source_id) {
        Ok(value) => value,
        Err(_) => return events,
    };
    let (session_rev_ready, _) = match manager.session_and_scene_revisions(&request.session_id) {
        Ok(value) => value,
        Err(_) => return events,
    };
    events.push(EventEnvelope::source_generation_ready(
        request.session_id.clone(),
        session_rev_ready,
        SourceGenerationPayload::from(&ready),
        crate::clock::rfc3339_now(),
    ));
    events.push(EventEnvelope::scene_source_upsert(
        request.session_id.clone(),
        session_rev_ready,
        SourceUpsertPayload::from(&source_state),
        crate::clock::rfc3339_now(),
    ));
    events.push(EventEnvelope::scene_dataset_upsert(
        request.session_id.clone(),
        session_rev_ready,
        DatasetUpsertPayload::from(&dataset_state),
        crate::clock::rfc3339_now(),
    ));
    events
}

fn execute_generation_ready_phase(
    manager: &mut SessionManager,
    request: &GenerationBuildRequest,
) -> Vec<EventEnvelope> {
    let ready = match manager.mark_generation_ready(
        &request.session_id,
        &request.source_id,
        request.generation_seq,
    ) {
        Ok(value) => value,
        Err(error) => return generation_failure_events(manager, request, &error),
    };
    let source_state = match manager.source_state(&request.session_id, &request.source_id) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let dataset_state = match manager.dataset_for_source(&request.session_id, &request.source_id) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let (session_rev_ready, _) = match manager.session_and_scene_revisions(&request.session_id) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    vec![
        EventEnvelope::source_generation_ready(
            request.session_id.clone(),
            session_rev_ready,
            SourceGenerationPayload::from(&ready),
            crate::clock::rfc3339_now(),
        ),
        EventEnvelope::scene_source_upsert(
            request.session_id.clone(),
            session_rev_ready,
            SourceUpsertPayload::from(&source_state),
            crate::clock::rfc3339_now(),
        ),
        EventEnvelope::scene_dataset_upsert(
            request.session_id.clone(),
            session_rev_ready,
            DatasetUpsertPayload::from(&dataset_state),
            crate::clock::rfc3339_now(),
        ),
    ]
}

async fn send_generation_events(
    state: &RuntimeState,
    session_id: &str,
    events: Vec<EventEnvelope>,
) {
    let event_bus = state.event_bus(session_id).await;
    for event in events {
        let _ = event_bus.send(event);
    }
}

fn has_generation_failed(events: &[EventEnvelope]) -> bool {
    events
        .iter()
        .any(|event| matches!(event.event_type, EventType::SourceGenerationFailed))
}

fn generation_failure_events(
    manager: &mut SessionManager,
    request: &GenerationBuildRequest,
    _error: &SessionError,
) -> Vec<EventEnvelope> {
    let failed = match manager.mark_generation_failed(
        &request.session_id,
        &request.source_id,
        request.generation_seq,
    ) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let (session_rev_failed, _) = match manager.session_and_scene_revisions(&request.session_id) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let mut events = vec![EventEnvelope::source_generation_failed(
        request.session_id.clone(),
        session_rev_failed,
        SourceGenerationPayload::from(&failed),
        crate::clock::rfc3339_now(),
    )];
    if let Ok(source_state) = manager.source_state(&request.session_id, &request.source_id) {
        events.push(EventEnvelope::scene_source_upsert(
            request.session_id.clone(),
            session_rev_failed,
            SourceUpsertPayload::from(&source_state),
            crate::clock::rfc3339_now(),
        ));
    }
    events
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
struct HandshakeAuth {
    mode: String,
    token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "message_type", rename_all = "snake_case")]
enum HandshakeMessage {
    Attach {
        client_label: String,
        requested_permission: String,
        auth: Option<HandshakeAuth>,
    },
    Reconnect {
        client_label: String,
        requested_permission: String,
        previous_client_id: Option<String>,
        auth: Option<HandshakeAuth>,
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
            auth,
        } => {
            validate_auth_payload(&requested_permission, auth.as_ref())?;
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
            auth,
        } => {
            validate_auth_payload(&requested_permission, auth.as_ref())?;
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

fn validate_auth_payload(
    requested_permission: &str,
    auth: Option<&HandshakeAuth>,
) -> Result<(), RuntimeWsErrorMessage> {
    let Some(auth) = auth else {
        return Ok(());
    };

    let mode = auth.mode.as_str();
    match mode {
        "open_view" => {
            if requested_permission != "view" {
                return Err(RuntimeWsErrorMessage {
                    code: "validation_error",
                    message: "requested_permission must be `view` when auth.mode is `open_view`"
                        .to_owned(),
                });
            }
            if auth
                .token
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(RuntimeWsErrorMessage {
                    code: "validation_error",
                    message: "auth.token must be empty when auth.mode is `open_view`".to_owned(),
                });
            }
        }
        "token_view" => {
            if requested_permission != "view" {
                return Err(RuntimeWsErrorMessage {
                    code: "validation_error",
                    message: "requested_permission must be `view` when auth.mode is `token_view`"
                        .to_owned(),
                });
            }
            if auth
                .token
                .as_deref()
                .map_or(true, |value| value.trim().is_empty())
            {
                return Err(RuntimeWsErrorMessage {
                    code: "validation_error",
                    message: "auth.token is required when auth.mode is `token_view`".to_owned(),
                });
            }
        }
        "control" => {
            if requested_permission != "control" && requested_permission != "admin" {
                return Err(RuntimeWsErrorMessage {
                    code: "validation_error",
                    message:
                        "requested_permission must be `control` or `admin` when auth.mode is `control`"
                            .to_owned(),
                });
            }
            if auth
                .token
                .as_deref()
                .map_or(true, |value| value.trim().is_empty())
            {
                return Err(RuntimeWsErrorMessage {
                    code: "validation_error",
                    message: "auth.token is required when auth.mode is `control`".to_owned(),
                });
            }
        }
        _ => {
            return Err(RuntimeWsErrorMessage {
                code: "validation_error",
                message: "auth.mode must be one of open_view, token_view, or control".to_owned(),
            });
        }
    }

    Ok(())
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
    dtype: String,
    size_t: u64,
    size_c: u64,
    size_z: u64,
    size_y: u64,
    size_x: u64,
}

impl From<&DatasetBinding> for RuntimeDatasetState {
    fn from(value: &DatasetBinding) -> Self {
        Self {
            dataset_id: value.dataset_id.clone(),
            source_id: value.source_id.clone(),
            resolved_generation_seq: value.resolved_generation_seq,
            dtype: value.dtype.clone(),
            size_t: value.shape.t.max(1),
            size_c: value.shape.c.max(1),
            size_z: value.shape.z.max(1),
            size_y: value.shape.y.max(1),
            size_x: value.shape.x.max(1),
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTileLodLayout {
    lod: u8,
    width: u64,
    height: u64,
    tile_width: u16,
    tile_height: u16,
    rows: u32,
    cols: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTileLayout {
    default_channel_block_size: u16,
    lods: Vec<RuntimeTileLodLayout>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSourceGenerationState {
    source_id: String,
    generation_seq: u64,
    stage: String,
    progress_percent: u8,
    preview_ready: bool,
    tile2d_ready_lods: Vec<u8>,
    brick3d_ready_lods: Vec<u8>,
    tile_layout: Option<RuntimeTileLayout>,
}

impl From<&GenerationRecord> for RuntimeSourceGenerationState {
    fn from(value: &GenerationRecord) -> Self {
        Self {
            source_id: value.source_id.clone(),
            generation_seq: value.generation_seq,
            stage: generation_stage_name(value.stage).to_owned(),
            progress_percent: value.progress_percent,
            preview_ready: value.availability.preview_ready,
            tile2d_ready_lods: value.availability.tile2d_ready_lods.clone(),
            brick3d_ready_lods: value.availability.brick3d_ready_lods.clone(),
            tile_layout: value.tile_layout.as_ref().map(|layout| RuntimeTileLayout {
                default_channel_block_size: layout.default_channel_block_size,
                lods: layout
                    .lods
                    .iter()
                    .map(|lod| RuntimeTileLodLayout {
                        lod: lod.lod,
                        width: lod.width,
                        height: lod.height,
                        tile_width: lod.tile_width,
                        tile_height: lod.tile_height,
                        rows: lod.rows,
                        cols: lod.cols,
                    })
                    .collect::<Vec<_>>(),
            }),
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
    source_generations: BTreeMap<String, RuntimeSourceGenerationState>,
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
        let source_generations = snapshot
            .snapshot
            .shared_scene
            .sources
            .values()
            .flat_map(|source| source.generations.values())
            .map(|generation| {
                (
                    format!("{}:{}", generation.source_id, generation.generation_seq),
                    RuntimeSourceGenerationState::from(generation),
                )
            })
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
                    source_generations,
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
            "resolvedGenerationSeq": value.resolved_generation_seq,
            "dtype": value.dtype.clone(),
            "sizeT": value.size_t,
            "sizeC": value.size_c,
            "sizeZ": value.size_z,
            "sizeY": value.size_y,
            "sizeX": value.size_x
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
        | EventPayload::SourceGenerationFailed(value)
        | EventPayload::SourceGenerationReady(value) => serde_json::json!({
            "sourceId": value.source_id,
            "generationSeq": value.generation_seq,
            "stage": value.stage,
            "progressPercent": value.progress_percent,
            "previewReady": value.preview_ready,
            "tile2dReadyLods": value.tile2d_ready_lods,
            "brick3dReadyLods": value.brick3d_ready_lods,
            "tileLayout": value.tile_layout.as_ref().map(|layout| serde_json::json!({
                "defaultChannelBlockSize": layout.default_channel_block_size,
                "lods": layout.lods.iter().map(|lod| serde_json::json!({
                    "lod": lod.lod,
                    "width": lod.width,
                    "height": lod.height,
                    "tileWidth": lod.tile_width,
                    "tileHeight": lod.tile_height,
                    "rows": lod.rows,
                    "cols": lod.cols
                })).collect::<Vec<_>>()
            }))
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
    data_response(state, chunk_path, false).await
}

async fn data_head(
    State(state): State<RuntimeState>,
    Path(chunk_path): Path<String>,
) -> Result<Response, (StatusCode, Json<RuntimeHttpError>)> {
    data_response(state, chunk_path, true).await
}

async fn data_response(
    state: RuntimeState,
    chunk_path: String,
    head_only: bool,
) -> Result<Response, (StatusCode, Json<RuntimeHttpError>)> {
    let canonical_path = format!("/{chunk_path}");
    let chunk_key = ChunkKey::parse_path(&canonical_path).map_err(|error| {
        data_plane_error(DataPlaneError::InvalidPath {
            message: error.to_string(),
        })
    })?;
    let served = match state.data_plane.serve_get(&canonical_path) {
        Ok(payload) => payload,
        Err(DataPlaneError::NotFound { .. })
            if matches!(chunk_key.asset_kind, ChunkAssetKind::Tile2d) =>
        {
            if ensure_tile_selection_ready_on_demand(&state, &chunk_key).await? {
                state
                    .data_plane
                    .serve_get(&canonical_path)
                    .map_err(data_plane_error)?
            } else {
                return Err(data_plane_error(DataPlaneError::NotFound {
                    path: canonical_path,
                }));
            }
        }
        Err(error) => return Err(data_plane_error(error)),
    };

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

async fn ensure_tile_selection_ready_on_demand(
    state: &RuntimeState,
    chunk_key: &ChunkKey,
) -> Result<bool, (StatusCode, Json<RuntimeHttpError>)> {
    if !matches!(chunk_key.asset_kind, ChunkAssetKind::Tile2d) {
        return Ok(false);
    }

    let inflight_key = format!(
        "{}:{}:{}:{}:{}",
        chunk_key.source_id,
        chunk_key.generation_seq,
        chunk_key.t,
        chunk_key.z,
        chunk_key.channel_block
    );
    let (notify, should_build) = {
        let mut inflight = state.inflight_tile_builds.lock().await;
        if let Some(existing) = inflight.get(&inflight_key) {
            (existing.clone(), false)
        } else {
            let created = Arc::new(Notify::new());
            inflight.insert(inflight_key.clone(), created.clone());
            (created, true)
        }
    };

    if !should_build {
        notify.notified().await;
        return Ok(true);
    }

    let build_result = build_tile_selection_for_chunk(state, chunk_key).await;
    {
        let mut inflight = state.inflight_tile_builds.lock().await;
        inflight.remove(&inflight_key);
    }
    notify.notify_waiters();
    build_result
}

async fn build_tile_selection_for_chunk(
    state: &RuntimeState,
    chunk_key: &ChunkKey,
) -> Result<bool, (StatusCode, Json<RuntimeHttpError>)> {
    if !state.on_demand_build_delay.is_zero() {
        tokio::time::sleep(state.on_demand_build_delay).await;
    }
    let (session_id, progress_event) = {
        let mut manager = state.session_manager.lock().await;
        let Some(session_id) =
            manager.session_id_for_generation(&chunk_key.source_id, chunk_key.generation_seq)
        else {
            return Ok(false);
        };
        let progressed = manager
            .build_tile_selection_for_generation(
                &session_id,
                &chunk_key.source_id,
                chunk_key.generation_seq,
                u64::from(chunk_key.t),
                u64::from(chunk_key.z),
                u64::from(chunk_key.channel_block),
            )
            .map_err(session_error)?;
        let (session_rev_progress, _) = manager
            .session_and_scene_revisions(&session_id)
            .map_err(session_error)?;
        (
            session_id.clone(),
            EventEnvelope::source_generation_progress(
                session_id,
                session_rev_progress,
                SourceGenerationPayload::from(&progressed),
                crate::clock::rfc3339_now(),
            ),
        )
    };
    let event_bus = state.event_bus(&session_id).await;
    let _ = event_bus.send(progress_event);
    Ok(true)
}

async fn add_cors_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("access-control-allow-origin"),
        HeaderValue::from_static("*"),
    );
    headers.insert(
        HeaderName::from_static("access-control-allow-methods"),
        HeaderValue::from_static("GET, HEAD, POST, OPTIONS"),
    );
    headers.insert(
        HeaderName::from_static("access-control-allow-headers"),
        HeaderValue::from_static("content-type"),
    );
    response
}

async fn cors_preflight() -> StatusCode {
    StatusCode::NO_CONTENT
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

fn session_error(error: SessionError) -> (StatusCode, Json<RuntimeHttpError>) {
    match error {
        SessionError::SessionNotFound { .. } => (
            StatusCode::NOT_FOUND,
            Json(RuntimeHttpError {
                code: "not_found",
                message: error.to_string(),
            }),
        ),
        SessionError::SourceUnavailable { .. } => (
            StatusCode::BAD_REQUEST,
            Json(RuntimeHttpError {
                code: "source_unavailable",
                message: error.to_string(),
            }),
        ),
        SessionError::CanonicalCacheBuildFailed { .. }
        | SessionError::TilePreviewBuildFailed { .. }
        | SessionError::BrickBuildFailed { .. }
        | SessionError::CacheGcFailed { .. } => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(RuntimeHttpError {
                code: "internal_error",
                message: error.to_string(),
            }),
        ),
        _ => (
            StatusCode::BAD_REQUEST,
            Json(RuntimeHttpError {
                code: "validation_error",
                message: error.to_string(),
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

fn generation_stage_name(value: crate::model::GenerationStage) -> &'static str {
    match value {
        crate::model::GenerationStage::Detected => "detected",
        crate::model::GenerationStage::Started => "started",
        crate::model::GenerationStage::Partial => "partial",
        crate::model::GenerationStage::Ready => "ready",
        crate::model::GenerationStage::Pinned => "pinned",
        crate::model::GenerationStage::GarbageCollected => "garbage_collected",
        crate::model::GenerationStage::Failed => "failed",
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
        EventType::SourceGenerationFailed => "source_generation_failed",
        EventType::SourceGenerationReady => "source_generation_ready",
    }
}
