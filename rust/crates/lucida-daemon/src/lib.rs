use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use chrono::Utc;
use lucida_core::{
    apply_command, build_error_event, replay_entries, state_hash, AppState, LayerKind, SessionState,
};
use lucida_protocol::{
    now_utc, AuditEntry, AuditOutcome, EventEnvelope, ExportedCommandLog, FrameAxisIndices,
    FrameRequestHeader, FrameResponseHeader, FRAME_PROTOCOL_VERSION, LOG_SCHEMA_VERSION,
    PROTOCOL_VERSION, ReplayEntry, RpcError, RpcRequestEnvelope, RpcResponseEnvelope,
};
use lucida_render_wgpu::RendererState;
use lucida_storage::{open_dataset, read_u16_plane, OpenDatasetOptions, StorageError};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

pub trait LocalTransport {
    type Listener;

    fn remove_stale_endpoint(path: &Path) -> Result<()>;
    fn bind(path: &Path) -> Result<Self::Listener>;
}

#[cfg(unix)]
pub struct UnixSocketTransport;

#[cfg(unix)]
impl LocalTransport for UnixSocketTransport {
    type Listener = UnixListener;

    fn remove_stale_endpoint(path: &Path) -> Result<()> {
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        Ok(())
    }

    fn bind(path: &Path) -> Result<Self::Listener> {
        Ok(UnixListener::bind(path)?)
    }
}

#[cfg(windows)]
pub struct NamedPipeTransport;

#[cfg(windows)]
impl LocalTransport for NamedPipeTransport {
    type Listener = ();

    fn remove_stale_endpoint(_path: &Path) -> Result<()> {
        Ok(())
    }

    fn bind(_path: &Path) -> Result<Self::Listener> {
        Err(anyhow!(
            "windows named pipes transport scaffold exists but implementation is pending"
        ))
    }
}

#[derive(Clone, Debug)]
pub struct DaemonConfig {
    pub socket_path: PathBuf,
    pub frame_socket_path: PathBuf,
}

impl DaemonConfig {
    pub fn with_socket_path(socket_path: PathBuf) -> Self {
        Self {
            frame_socket_path: derive_frame_socket_path(&socket_path),
            socket_path,
        }
    }
}

impl Default for DaemonConfig {
    fn default() -> Self {
        #[cfg(unix)]
        let default_control_path = "/tmp/lucida.sock";
        #[cfg(windows)]
        let default_control_path = r"\\.\pipe\lucida.sock";
        #[cfg(not(any(unix, windows)))]
        let default_control_path = "lucida.sock";

        let socket_path = std::env::var("LUCIDA_SOCKET_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(default_control_path));
        let frame_socket_path = std::env::var("LUCIDA_FRAME_SOCKET_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| derive_frame_socket_path(&socket_path));
        Self {
            socket_path,
            frame_socket_path,
        }
    }
}

#[derive(Clone)]
pub struct Daemon {
    runtime: Arc<Mutex<DaemonRuntime>>,
    frame_socket_path: Arc<Mutex<PathBuf>>,
    events_tx: broadcast::Sender<EventEnvelope>,
}

#[derive(Clone, Debug)]
struct DaemonRuntime {
    app_state: AppState,
    renderer: RendererState,
    audit_log: Vec<AuditEntry>,
    replay_log: Vec<ReplayEntry>,
    frame_channels: BTreeMap<String, String>,
}

impl Default for DaemonRuntime {
    fn default() -> Self {
        Self {
            app_state: AppState::default(),
            renderer: RendererState::default(),
            audit_log: Vec::new(),
            replay_log: Vec::new(),
            frame_channels: BTreeMap::new(),
        }
    }
}

impl Daemon {
    pub fn new() -> Self {
        let (events_tx, _) = broadcast::channel(1024);
        let default_config = DaemonConfig::default();
        Self {
            runtime: Arc::new(Mutex::new(DaemonRuntime::default())),
            frame_socket_path: Arc::new(Mutex::new(default_config.frame_socket_path)),
            events_tx,
        }
    }

    pub async fn run(&self, config: DaemonConfig) -> Result<()> {
        #[cfg(unix)]
        {
            {
                let mut frame_path = self.frame_socket_path.lock().await;
                *frame_path = config.frame_socket_path.clone();
            }

            UnixSocketTransport::remove_stale_endpoint(&config.socket_path)?;
            UnixSocketTransport::remove_stale_endpoint(&config.frame_socket_path)?;
            let control_listener = UnixSocketTransport::bind(&config.socket_path)?;
            let frame_listener = UnixSocketTransport::bind(&config.frame_socket_path)?;

            info!(socket = %config.socket_path.display(), "lucida daemon control socket listening");
            info!(socket = %config.frame_socket_path.display(), "lucida daemon frame socket listening");

            let frame_daemon = self.clone();
            tokio::spawn(async move {
                if let Err(err) = frame_daemon.run_frame_server(frame_listener).await {
                    error!(error = %err, "frame server loop failed");
                }
            });

            loop {
                let (stream, _) = control_listener.accept().await?;
                let daemon = self.clone();
                tokio::spawn(async move {
                    if let Err(err) = daemon.handle_control_client(stream).await {
                        error!(error = %err, "control client handling failed");
                    }
                });
            }
        }

        #[cfg(windows)]
        {
            let _ = config;
            Err(anyhow!(
                "windows named pipes transport scaffold exists but implementation is pending"
            ))
        }

        #[cfg(not(any(unix, windows)))]
        {
            let _ = config;
            Err(anyhow!("this platform is not supported yet"))
        }
    }

    #[cfg(unix)]
    async fn handle_control_client(&self, stream: UnixStream) -> Result<()> {
        let (reader_half, mut writer_half) = stream.into_split();
        let mut reader = BufReader::new(reader_half).lines();

        let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<String>();
        let writer_task = tokio::spawn(async move {
            while let Some(line) = outgoing_rx.recv().await {
                if writer_half.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if writer_half.write_all(b"\n").await.is_err() {
                    break;
                }
            }
        });

        let mut event_forwarder: Option<tokio::task::JoinHandle<()>> = None;

        while let Some(line) = reader.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }

            let parsed_request: Result<RpcRequestEnvelope, _> = serde_json::from_str(&line);
            let request = match parsed_request {
                Ok(request) => request,
                Err(err) => {
                    let response = RpcResponseEnvelope {
                        jsonrpc: "2.0".to_string(),
                        protocol_version: PROTOCOL_VERSION.to_string(),
                        request_id: "unknown".to_string(),
                        result: None,
                        error: Some(RpcError {
                            code: -32700,
                            message: format!("parse error: {err}"),
                            data: None,
                        }),
                        timestamp: now_utc(),
                    };
                    let payload = serde_json::to_string(&response)?;
                    outgoing_tx
                        .send(payload)
                        .map_err(|_| anyhow!("failed to send parse error response"))?;
                    continue;
                }
            };

            let subscribe_request = request.method == "events.subscribe";
            let (response, outbound_events) = self.process_request(request.clone()).await;

            let response_payload = serde_json::to_string(&response)?;
            outgoing_tx
                .send(response_payload)
                .map_err(|_| anyhow!("failed to send control response"))?;

            if subscribe_request && event_forwarder.is_none() {
                let mut rx = self.events_tx.subscribe();
                let tx = outgoing_tx.clone();
                event_forwarder = Some(tokio::spawn(async move {
                    loop {
                        match rx.recv().await {
                            Ok(event) => {
                                if let Ok(payload) = serde_json::to_string(&event) {
                                    if tx.send(payload).is_err() {
                                        break;
                                    }
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                                warn!(skipped, "event subscriber lagged behind");
                            }
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }));
            }

            for event in outbound_events {
                let _ = self.events_tx.send(event);
            }
        }

        if let Some(task) = event_forwarder {
            task.abort();
        }
        writer_task.abort();
        Ok(())
    }

    #[cfg(unix)]
    async fn run_frame_server(&self, listener: UnixListener) -> Result<()> {
        loop {
            let (stream, _) = listener.accept().await?;
            let daemon = self.clone();
            tokio::spawn(async move {
                if let Err(err) = daemon.handle_frame_client(stream).await {
                    warn!(error = %err, "frame client disconnected with error");
                }
            });
        }
    }

    #[cfg(unix)]
    async fn handle_frame_client(&self, mut stream: UnixStream) -> Result<()> {
        loop {
            let header_len = match read_u32_le(&mut stream).await {
                Ok(value) => value,
                Err(err) if err.kind() == ErrorKind::UnexpectedEof => break,
                Err(err) => return Err(err.into()),
            };
            if header_len == 0 || header_len > 1_048_576 {
                return Err(anyhow!("invalid frame request header length: {header_len}"));
            }

            let mut header_bytes = vec![0u8; header_len as usize];
            stream.read_exact(&mut header_bytes).await?;
            let parsed: Result<FrameRequestHeader, _> = serde_json::from_slice(&header_bytes);

            let (response_header, payload) = match parsed {
                Ok(header) => self.process_frame_request(header).await,
                Err(err) => (
                    FrameResponseHeader {
                        request_id: "unknown".to_string(),
                        status: "error".to_string(),
                        width: 0,
                        height: 0,
                        dtype: "u16".to_string(),
                        endianness: "little".to_string(),
                        payload_len: 0,
                        state_hash: "unknown".to_string(),
                        error: Some(format!("invalid frame request header: {err}")),
                    },
                    Vec::new(),
                ),
            };

            write_frame_response(&mut stream, &response_header, &payload).await?;
        }

        Ok(())
    }

    async fn process_frame_request(
        &self,
        request: FrameRequestHeader,
    ) -> (FrameResponseHeader, Vec<u8>) {
        if request.frame_protocol_version != FRAME_PROTOCOL_VERSION {
            return frame_error_response(
                &request.request_id,
                format!(
                    "frame protocol mismatch, expected {FRAME_PROTOCOL_VERSION}, got {}",
                    request.frame_protocol_version
                ),
            );
        }

        let (session, state_hash_value, token_valid) = {
            let runtime = self.runtime.lock().await;
            let token_valid = runtime
                .frame_channels
                .get(&request.channel_token)
                .map(|session_id| session_id == &request.session_id)
                .unwrap_or(false);

            let session = runtime.app_state.sessions.get(&request.session_id).cloned();
            let hash = state_hash(&runtime.app_state)
                .unwrap_or_else(|_| "state-hash-unavailable".to_string());
            (session, hash, token_valid)
        };

        if !token_valid {
            return frame_error_response(
                &request.request_id,
                "invalid frame channel token for session".to_string(),
            );
        }

        let Some(session) = session else {
            return frame_error_response(&request.request_id, "session does not exist".to_string());
        };

        if !has_visible_image_layer(&session) {
            return frame_error_response(
                &request.request_id,
                "session has no visible image layer".to_string(),
            );
        }

        let Some(dataset) = session.dataset.as_ref() else {
            return frame_error_response(
                &request.request_id,
                "session has no opened dataset".to_string(),
            );
        };

        let axis_map = axis_indices_map(&request.axis_indices);
        let frame = match read_u16_plane(&dataset.uri, &axis_map) {
            Ok(frame) => frame,
            Err(err) => {
                return frame_error_response(&request.request_id, err.to_string());
            }
        };

        if frame.bytes.len() > MAX_FRAME_BYTES {
            return frame_error_response(
                &request.request_id,
                format!(
                    "frame payload too large: {} bytes exceeds limit {}",
                    frame.bytes.len(),
                    MAX_FRAME_BYTES
                ),
            );
        }

        let payload_len = frame.bytes.len() as u32;
        (
            FrameResponseHeader {
                request_id: request.request_id,
                status: "ok".to_string(),
                width: frame.width,
                height: frame.height,
                dtype: "u16".to_string(),
                endianness: "little".to_string(),
                payload_len,
                state_hash: state_hash_value,
                error: None,
            },
            frame.bytes,
        )
    }

    async fn process_request(
        &self,
        request: RpcRequestEnvelope,
    ) -> (RpcResponseEnvelope, Vec<EventEnvelope>) {
        if request.protocol_version != PROTOCOL_VERSION {
            let err = RpcError {
                code: -32010,
                message: format!(
                    "protocol version mismatch, expected {PROTOCOL_VERSION}, got {}",
                    request.protocol_version
                ),
                data: None,
            };
            let response = self.record_and_build_error(&request, err.clone()).await;
            let event = build_error_event(
                &request.protocol_version,
                request.session_id.clone(),
                &request.method,
                &err,
                Utc::now(),
            );
            return (response, vec![event]);
        }

        if request.method == "command_log.export" {
            let runtime = self.runtime.lock().await;
            let log = ExportedCommandLog {
                log_schema_version: LOG_SCHEMA_VERSION,
                protocol_version: PROTOCOL_VERSION.to_string(),
                audit_log: runtime.audit_log.clone(),
                replay_log: runtime.replay_log.clone(),
            };
            drop(runtime);
            return self.record_and_build_success(&request, json!(log)).await;
        }

        if request.method == "command_log.replay" {
            let replay_log_entries = match parse_replay_entries(&request.params) {
                Ok(Some(entries)) => entries,
                Ok(None) => {
                    let runtime = self.runtime.lock().await;
                    runtime.replay_log.clone()
                }
                Err(err) => {
                    let rpc_error = RpcError {
                        code: -32602,
                        message: err,
                        data: None,
                    };
                    let response = self.record_and_build_error(&request, rpc_error.clone()).await;
                    let event = build_error_event(
                        &request.protocol_version,
                        request.session_id.clone(),
                        &request.method,
                        &rpc_error,
                        Utc::now(),
                    );
                    return (response, vec![event]);
                }
            };

            match replay_entries(&replay_log_entries)
                .and_then(|state| state_hash(&state))
                .map_err(|err| err.to_rpc_error())
            {
                Ok(hash) => {
                    return self
                        .record_and_build_success(
                            &request,
                            json!({
                                "replayed_entries": replay_log_entries.len(),
                                "state_hash": hash,
                            }),
                        )
                        .await;
                }
                Err(err) => {
                    let response = self.record_and_build_error(&request, err.clone()).await;
                    let event = build_error_event(
                        &request.protocol_version,
                        request.session_id.clone(),
                        &request.method,
                        &err,
                        Utc::now(),
                    );
                    return (response, vec![event]);
                }
            }
        }

        if request.method == "session.inspect" {
            let Some(session_id) = request.session_id.clone() else {
                let rpc_error = RpcError {
                    code: -32602,
                    message: "session.inspect requires session_id".to_string(),
                    data: None,
                };
                let response = self.record_and_build_error(&request, rpc_error.clone()).await;
                let event = build_error_event(
                    &request.protocol_version,
                    request.session_id.clone(),
                    &request.method,
                    &rpc_error,
                    Utc::now(),
                );
                return (response, vec![event]);
            };

            let runtime = self.runtime.lock().await;
            let result = if let Some(session) = runtime.app_state.sessions.get(&session_id) {
                json!({
                    "exists": true,
                    "dataset": session.dataset,
                    "layers": session.layers.values().collect::<Vec<_>>(),
                    "view": session.view,
                })
            } else {
                json!({
                    "exists": false,
                    "dataset": Value::Null,
                    "layers": [],
                    "view": Value::Null,
                })
            };
            drop(runtime);
            return self.record_and_build_success(&request, result).await;
        }

        if request.method == "frame.channel.open" {
            let Some(session_id) = request.session_id.clone() else {
                let rpc_error = RpcError {
                    code: -32602,
                    message: "frame.channel.open requires session_id".to_string(),
                    data: None,
                };
                let response = self.record_and_build_error(&request, rpc_error.clone()).await;
                let event = build_error_event(
                    &request.protocol_version,
                    request.session_id.clone(),
                    &request.method,
                    &rpc_error,
                    Utc::now(),
                );
                return (response, vec![event]);
            };

            let mut runtime = self.runtime.lock().await;
            if !runtime.app_state.sessions.contains_key(&session_id) {
                let rpc_error = RpcError {
                    code: -32602,
                    message: format!("unknown session_id: {session_id}"),
                    data: None,
                };
                drop(runtime);
                let response = self.record_and_build_error(&request, rpc_error.clone()).await;
                let event = build_error_event(
                    &request.protocol_version,
                    request.session_id.clone(),
                    &request.method,
                    &rpc_error,
                    Utc::now(),
                );
                return (response, vec![event]);
            }

            let channel_token = Uuid::new_v4().to_string();
            runtime
                .frame_channels
                .insert(channel_token.clone(), session_id.clone());
            drop(runtime);

            let frame_socket_path = self.frame_socket_path.lock().await.clone();
            let result = json!({
                "frame_protocol_version": FRAME_PROTOCOL_VERSION,
                "frame_socket_path": frame_socket_path.display().to_string(),
                "channel_token": channel_token,
                "max_frame_bytes": MAX_FRAME_BYTES,
            });
            return self.record_and_build_success(&request, result).await;
        }

        let request_for_reducer = match preprocess_request(request).await {
            Ok(request) => request,
            Err((request, storage_error)) => {
                let rpc_error = storage_error_to_rpc(storage_error);
                let response = self.record_and_build_error(&request, rpc_error.clone()).await;
                let event = build_error_event(
                    &request.protocol_version,
                    request.session_id.clone(),
                    &request.method,
                    &rpc_error,
                    Utc::now(),
                );
                return (response, vec![event]);
            }
        };

        let mut runtime = self.runtime.lock().await;
        let reducer_result = apply_command(&mut runtime.app_state, &request_for_reducer);

        match reducer_result {
            Ok(outcome) => {
                if let Some(entry) = outcome.replay_entry.clone() {
                    runtime.replay_log.push(entry);
                }

                let perf_payload = runtime.renderer.mark_frame(16.0);
                let mut events = outcome.emitted_events;
                events.push(EventEnvelope {
                    jsonrpc: "2.0".to_string(),
                    protocol_version: request_for_reducer.protocol_version.clone(),
                    session_id: request_for_reducer.session_id.clone(),
                    event: "perf.frame".to_string(),
                    payload: perf_payload,
                    timestamp: now_utc(),
                });

                runtime.audit_log.push(AuditEntry {
                    received_at: now_utc(),
                    request: request_for_reducer.clone(),
                    outcome: AuditOutcome::Success {
                        result: outcome.result.clone(),
                    },
                });

                debug!(
                    method = %request_for_reducer.method,
                    "control request processed successfully"
                );

                let response = RpcResponseEnvelope {
                    jsonrpc: "2.0".to_string(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    request_id: request_for_reducer.request_id,
                    result: Some(outcome.result),
                    error: None,
                    timestamp: now_utc(),
                };
                (response, events)
            }
            Err(err) => {
                let rpc_error = err.to_rpc_error();
                runtime.audit_log.push(AuditEntry {
                    received_at: now_utc(),
                    request: request_for_reducer.clone(),
                    outcome: AuditOutcome::Error {
                        error: rpc_error.clone(),
                    },
                });

                let error_event = build_error_event(
                    &request_for_reducer.protocol_version,
                    request_for_reducer.session_id.clone(),
                    &request_for_reducer.method,
                    &rpc_error,
                    Utc::now(),
                );

                let response = RpcResponseEnvelope {
                    jsonrpc: "2.0".to_string(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    request_id: request_for_reducer.request_id,
                    result: None,
                    error: Some(rpc_error),
                    timestamp: now_utc(),
                };
                (response, vec![error_event])
            }
        }
    }

    async fn record_and_build_success(
        &self,
        request: &RpcRequestEnvelope,
        result: Value,
    ) -> (RpcResponseEnvelope, Vec<EventEnvelope>) {
        let mut runtime = self.runtime.lock().await;
        runtime.audit_log.push(AuditEntry {
            received_at: now_utc(),
            request: request.clone(),
            outcome: AuditOutcome::Success {
                result: result.clone(),
            },
        });

        (
            RpcResponseEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                request_id: request.request_id.clone(),
                result: Some(result),
                error: None,
                timestamp: now_utc(),
            },
            Vec::new(),
        )
    }

    async fn record_and_build_error(
        &self,
        request: &RpcRequestEnvelope,
        rpc_error: RpcError,
    ) -> RpcResponseEnvelope {
        let mut runtime = self.runtime.lock().await;
        runtime.audit_log.push(AuditEntry {
            received_at: now_utc(),
            request: request.clone(),
            outcome: AuditOutcome::Error {
                error: rpc_error.clone(),
            },
        });

        RpcResponseEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            request_id: request.request_id.clone(),
            result: None,
            error: Some(rpc_error),
            timestamp: now_utc(),
        }
    }
}

fn has_visible_image_layer(session: &SessionState) -> bool {
    session.layers.values().any(|layer| {
        layer.visible
            && matches!(
                layer.kind,
                LayerKind::Image {
                    dataset_id: _,
                    channel: _,
                }
            )
    })
}

fn axis_indices_map(indices: &FrameAxisIndices) -> BTreeMap<String, usize> {
    let mut map = BTreeMap::new();
    map.insert("t".to_string(), indices.t);
    map.insert("c".to_string(), indices.c);
    map.insert("z".to_string(), indices.z);
    map
}

fn derive_frame_socket_path(control_socket_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.frames", control_socket_path.display()))
}

fn frame_error_response(request_id: &str, message: String) -> (FrameResponseHeader, Vec<u8>) {
    (
        FrameResponseHeader {
            request_id: request_id.to_string(),
            status: "error".to_string(),
            width: 0,
            height: 0,
            dtype: "u16".to_string(),
            endianness: "little".to_string(),
            payload_len: 0,
            state_hash: "unavailable".to_string(),
            error: Some(message),
        },
        Vec::new(),
    )
}

fn parse_replay_entries(params: &Value) -> Result<Option<Vec<ReplayEntry>>, String> {
    let Some(value) = params.get("entries") else {
        return Ok(None);
    };

    let parsed = serde_json::from_value::<Vec<ReplayEntry>>(value.clone())
        .map_err(|err| format!("invalid replay entries: {err}"))?;
    Ok(Some(parsed))
}

fn storage_error_to_rpc(error: StorageError) -> RpcError {
    RpcError {
        code: -32020,
        message: error.to_string(),
        data: None,
    }
}

async fn preprocess_request(
    request: RpcRequestEnvelope,
) -> Result<RpcRequestEnvelope, (RpcRequestEnvelope, StorageError)> {
    if request.method != "dataset.open" {
        return Ok(request);
    }

    let uri = request
        .params
        .get("uri")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            (
                request.clone(),
                StorageError::UnsupportedUri("dataset.open requires uri".to_string()),
            )
        })?;

    let axis_map = request
        .params
        .get("axis_map")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let axis_map = serde_json::from_value::<BTreeMap<String, String>>(axis_map).unwrap_or_default();
    let options = OpenDatasetOptions {
        axis_map,
        read_only: request
            .params
            .get("read_only")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    };

    let opened = open_dataset(&uri, &options).map_err(|err| (request.clone(), err))?;

    let mut request = request;
    request.params = json!({
        "uri": uri,
        "dataset_handle": opened.handle,
        "compatibility_mode": opened.compatibility_mode,
        "read_only": options.read_only,
    });
    Ok(request)
}

#[cfg(unix)]
async fn read_u32_le(stream: &mut UnixStream) -> std::io::Result<u32> {
    stream.read_u32_le().await
}

#[cfg(unix)]
async fn write_frame_response(
    stream: &mut UnixStream,
    header: &FrameResponseHeader,
    payload: &[u8],
) -> Result<()> {
    let encoded_header = serde_json::to_vec(header)?;
    stream.write_u32_le(encoded_header.len() as u32).await?;
    stream.write_all(&encoded_header).await?;
    if !payload.is_empty() {
        stream.write_all(payload).await?;
    }
    Ok(())
}

pub fn parse_socket_path(args: &[String]) -> DaemonConfig {
    let mut socket_path: Option<PathBuf> = None;
    let mut frame_socket_path: Option<PathBuf> = None;

    let mut index = 1usize;
    while index < args.len() {
        match args[index].as_str() {
            "--socket" if index + 1 < args.len() => {
                socket_path = Some(PathBuf::from(&args[index + 1]));
                index += 2;
            }
            "--frame-socket" if index + 1 < args.len() => {
                frame_socket_path = Some(PathBuf::from(&args[index + 1]));
                index += 2;
            }
            _ => {
                index += 1;
            }
        }
    }

    let mut config = match socket_path {
        Some(path) => DaemonConfig::with_socket_path(path),
        None => DaemonConfig::default(),
    };
    if let Some(frame_path) = frame_socket_path {
        config.frame_socket_path = frame_path;
    }
    config
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn parse_socket_path_uses_flags_when_present() {
        let config = parse_socket_path(&[
            "lucida-daemon".to_string(),
            "--socket".to_string(),
            "/tmp/custom.sock".to_string(),
            "--frame-socket".to_string(),
            "/tmp/custom.frames.sock".to_string(),
        ]);
        assert_eq!(config.socket_path, PathBuf::from("/tmp/custom.sock"));
        assert_eq!(
            config.frame_socket_path,
            PathBuf::from("/tmp/custom.frames.sock")
        );
    }

    #[tokio::test]
    async fn session_inspect_returns_exists_false_for_unknown_session() {
        let daemon = Daemon::new();
        let request = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            session_id: Some("session-does-not-exist".to_string()),
            request_id: "req-inspect".to_string(),
            method: "session.inspect".to_string(),
            params: json!({}),
            timestamp: now_utc(),
        };

        let (response, _) = daemon.process_request(request).await;
        let result = response.result.expect("inspect should return result payload");
        assert_eq!(result["exists"], json!(false));
    }

    #[tokio::test]
    async fn frame_channel_open_fails_for_unknown_session() {
        let daemon = Daemon::new();
        let request = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            session_id: Some("session-does-not-exist".to_string()),
            request_id: "req-frame-open".to_string(),
            method: "frame.channel.open".to_string(),
            params: json!({}),
            timestamp: now_utc(),
        };

        let (response, _) = daemon.process_request(request).await;
        let error = response.error.expect("expected error");
        assert!(error.message.contains("unknown session_id"));
    }

    #[tokio::test]
    async fn frame_requests_return_plane_data_and_change_across_z() {
        let daemon = Daemon::new();

        let create_request = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            session_id: None,
            request_id: "req-create".to_string(),
            method: "session.create".to_string(),
            params: json!({}),
            timestamp: now_utc(),
        };
        let (create_response, _) = daemon.process_request(create_request).await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id string")
            .to_string();

        let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/ome_zarr_v05_min");
        let open_request = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            session_id: Some(session_id.clone()),
            request_id: "req-open".to_string(),
            method: "dataset.open".to_string(),
            params: json!({"uri": fixture_path.display().to_string(), "read_only": true}),
            timestamp: now_utc(),
        };
        let (open_response, _) = daemon.process_request(open_request).await;
        assert!(open_response.error.is_none(), "dataset.open should succeed");

        let layer_request = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            session_id: Some(session_id.clone()),
            request_id: "req-layer".to_string(),
            method: "layer.add_image".to_string(),
            params: json!({"layer_id":"image-1","channel":0}),
            timestamp: now_utc(),
        };
        let (layer_response, _) = daemon.process_request(layer_request).await;
        assert!(layer_response.error.is_none(), "layer.add_image should succeed");

        let frame_open_request = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            session_id: Some(session_id.clone()),
            request_id: "req-frame-open".to_string(),
            method: "frame.channel.open".to_string(),
            params: json!({}),
            timestamp: now_utc(),
        };
        let (frame_open_response, _) = daemon.process_request(frame_open_request).await;
        let frame_open_result = frame_open_response.result.expect("frame.channel.open result");
        let channel_token = frame_open_result["channel_token"]
            .as_str()
            .expect("frame token")
            .to_string();

        let (z0_header, z0_payload) = daemon
            .process_frame_request(FrameRequestHeader {
                frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
                request_id: "frame-z0".to_string(),
                channel_token: channel_token.clone(),
                session_id: session_id.clone(),
                axis_indices: FrameAxisIndices { t: 0, c: 0, z: 0 },
                viewport: lucida_protocol::FrameViewport {
                    width: 512,
                    height: 512,
                },
            })
            .await;
        assert_eq!(z0_header.status, "ok");
        assert_eq!(z0_payload.len(), 8 * 8 * 2);
        let z0_first = u16::from_le_bytes([z0_payload[0], z0_payload[1]]);
        assert_eq!(z0_first, 0);

        let (z2_header, z2_payload) = daemon
            .process_frame_request(FrameRequestHeader {
                frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
                request_id: "frame-z2".to_string(),
                channel_token,
                session_id,
                axis_indices: FrameAxisIndices { t: 0, c: 0, z: 2 },
                viewport: lucida_protocol::FrameViewport {
                    width: 512,
                    height: 512,
                },
            })
            .await;
        assert_eq!(z2_header.status, "ok");
        assert_eq!(z2_payload.len(), 8 * 8 * 2);
        let z2_first = u16::from_le_bytes([z2_payload[0], z2_payload[1]]);
        assert_eq!(z2_first, 2000);
    }

    #[tokio::test]
    async fn frame_request_rejects_invalid_token() {
        let daemon = Daemon::new();
        let (header, payload) = daemon
            .process_frame_request(FrameRequestHeader {
                frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
                request_id: "frame-invalid-token".to_string(),
                channel_token: "invalid".to_string(),
                session_id: "session-1".to_string(),
                axis_indices: FrameAxisIndices { t: 0, c: 0, z: 0 },
                viewport: lucida_protocol::FrameViewport {
                    width: 1,
                    height: 1,
                },
            })
            .await;
        assert_eq!(header.status, "error");
        assert!(payload.is_empty());
        assert!(
            header
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("invalid frame channel token")
        );
    }
}
