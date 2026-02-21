use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{anyhow, Result};
use chrono::Utc;
use lucida_core::{
    apply_command, build_error_event, replay_entries, state_hash, AppState, CameraMode, LayerKind,
    SessionState,
};
use lucida_protocol::{
    now_utc, AuditEntry, AuditOutcome, EventEnvelope, ExportedCommandLog, FrameAxisIndices,
    FrameRequestHeader, FrameResponseHeader, RenderMode, ReplayEntry, RpcError, RpcRequestEnvelope,
    RpcResponseEnvelope, FRAME_PROTOCOL_VERSION, LOG_SCHEMA_VERSION, PROTOCOL_VERSION,
};
use lucida_render_wgpu::RendererState;
use lucida_storage::{
    open_dataset, read_u16_plane, read_u16_volume, OpenDatasetOptions, StorageError, U16FramePlane,
    U16Volume,
};
use rayon::prelude::*;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
const BRICK_SIZE_VOXELS: u32 = 8;

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
    volume_cache: BTreeMap<VolumeCacheKey, Arc<AcceleratedVolume>>,
}

impl Default for DaemonRuntime {
    fn default() -> Self {
        Self {
            app_state: AppState::default(),
            renderer: RendererState::default(),
            audit_log: Vec::new(),
            replay_log: Vec::new(),
            frame_channels: BTreeMap::new(),
            volume_cache: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct VolumeCacheKey {
    session_id: String,
    dataset_uri: String,
    t: usize,
    c: usize,
}

#[derive(Clone, Debug)]
struct AcceleratedVolume {
    volume: Arc<U16Volume>,
    brick_size: u32,
    grid: [u32; 3],
    brick_max: Vec<u16>,
}

#[derive(Clone, Debug, Default)]
struct FramePerfMetrics {
    protocol_version: String,
    session_id: String,
    request_id: String,
    render_mode: String,
    viewport_width: u32,
    viewport_height: u32,
    cache_lookup_ms: f64,
    cache_load_ms: f64,
    raymarch_ms: f64,
    response_prep_ms: f64,
    encode_write_ms: f64,
    total_ms: f64,
    sample_count: usize,
    cache_hit: bool,
    bricks_traversed: u64,
    bricks_sampled: u64,
    samples_taken: u64,
    skip_ratio: f64,
    raymarch_parallel: bool,
    raymarch_workers: usize,
    rows_parallelized: u32,
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

            let (response_header, payload, perf) = match parsed {
                Ok(header) => self.process_frame_request_with_metrics(header).await,
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
                    None,
                ),
            };

            let encode_write_started = Instant::now();
            write_frame_response(&mut stream, &response_header, &payload).await?;
            if let Some(mut perf) = perf {
                perf.encode_write_ms = encode_write_started.elapsed().as_secs_f64() * 1_000.0;
                perf.total_ms += perf.encode_write_ms;
                self.emit_frame_perf_event(&perf, &response_header);
            }
        }

        Ok(())
    }

    #[cfg(test)]
    async fn process_frame_request(
        &self,
        request: FrameRequestHeader,
    ) -> (FrameResponseHeader, Vec<u8>) {
        let (header, payload, _) = self.process_frame_request_with_metrics(request).await;
        (header, payload)
    }

    async fn process_frame_request_with_metrics(
        &self,
        request: FrameRequestHeader,
    ) -> (FrameResponseHeader, Vec<u8>, Option<FramePerfMetrics>) {
        let overall_started = Instant::now();
        if request.frame_protocol_version != FRAME_PROTOCOL_VERSION {
            let (header, payload) = frame_error_response(
                &request.request_id,
                format!(
                    "frame protocol mismatch, expected {FRAME_PROTOCOL_VERSION}, got {}",
                    request.frame_protocol_version
                ),
            );
            return (header, payload, None);
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
            let (header, payload) = frame_error_response(
                &request.request_id,
                "invalid frame channel token for session".to_string(),
            );
            return (header, payload, None);
        }

        let Some(session) = session else {
            let (header, payload) =
                frame_error_response(&request.request_id, "session does not exist".to_string());
            return (header, payload, None);
        };

        let mut perf = FramePerfMetrics {
            protocol_version: PROTOCOL_VERSION.to_string(),
            session_id: request.session_id.clone(),
            request_id: request.request_id.clone(),
            render_mode: match session.render_mode {
                RenderMode::TwoD => "2d",
                RenderMode::TwoDStub => "2d_stub",
                RenderMode::ThreeD => "3d",
                RenderMode::GraphStub => "graph_stub",
            }
            .to_string(),
            viewport_width: request.viewport.width,
            viewport_height: request.viewport.height,
            ..FramePerfMetrics::default()
        };

        let frame = match session.render_mode {
            RenderMode::TwoD => {
                let Some(image_layer) = resolve_visible_image_layer(&session) else {
                    let (header, payload) = frame_error_response(
                        &request.request_id,
                        "session has no visible image layer".to_string(),
                    );
                    return (header, payload, None);
                };

                let Some(dataset) = session.dataset.as_ref() else {
                    let (header, payload) = frame_error_response(
                        &request.request_id,
                        "session has no opened dataset".to_string(),
                    );
                    return (header, payload, None);
                };

                let axis_indices =
                    axis_indices_map_with_channel(&request.axis_indices, image_layer.channel);
                let axis_remap = dataset_axis_remap(dataset);
                match read_u16_plane(&dataset.uri, &axis_indices, &axis_remap) {
                    Ok(frame) => FramePayload {
                        width: frame.width,
                        height: frame.height,
                        bytes: frame.bytes,
                    },
                    Err(err) => {
                        let (header, payload) =
                            frame_error_response(&request.request_id, err.to_string());
                        return (header, payload, None);
                    }
                }
            }
            RenderMode::TwoDStub => build_synthetic_2d_slice_frame(
                &request.viewport,
                &request.axis_indices,
                &session.camera,
            ),
            RenderMode::ThreeD => {
                let Some(image_layer) = resolve_visible_image_layer(&session) else {
                    let (header, payload) = frame_error_response(
                        &request.request_id,
                        "session has no visible image layer".to_string(),
                    );
                    return (header, payload, None);
                };
                let Some(dataset) = session.dataset.as_ref() else {
                    let (header, payload) = frame_error_response(
                        &request.request_id,
                        "session has no opened dataset".to_string(),
                    );
                    return (header, payload, None);
                };
                let t_index = request.axis_indices.t;
                let c_index = image_layer.channel.unwrap_or(request.axis_indices.c);
                let axis_remap = dataset_axis_remap(dataset);
                let spatial_scale_zyx = dataset_spatial_scale_zyx(dataset);
                let cache_key = VolumeCacheKey {
                    session_id: request.session_id.clone(),
                    dataset_uri: dataset.uri.clone(),
                    t: t_index,
                    c: c_index,
                };

                let cache_lookup_started = Instant::now();
                let volume = {
                    let runtime = self.runtime.lock().await;
                    runtime.volume_cache.get(&cache_key).cloned()
                };
                perf.cache_lookup_ms = cache_lookup_started.elapsed().as_secs_f64() * 1_000.0;

                let volume = match volume {
                    Some(volume) => {
                        perf.cache_hit = true;
                        volume
                    }
                    None => {
                        let axis_indices = BTreeMap::from([
                            ("t".to_string(), t_index),
                            ("c".to_string(), c_index),
                        ]);
                        let cache_load_started = Instant::now();
                        let loaded = match read_u16_volume(&dataset.uri, &axis_indices, &axis_remap)
                        {
                            Ok(volume) => volume,
                            Err(err) => {
                                let (header, payload) =
                                    frame_error_response(&request.request_id, err.to_string());
                                return (header, payload, None);
                            }
                        };
                        let loaded =
                            match build_accelerated_volume(Arc::new(loaded), BRICK_SIZE_VOXELS) {
                                Ok(volume) => Arc::new(volume),
                                Err(err) => {
                                    let (header, payload) =
                                        frame_error_response(&request.request_id, err.to_string());
                                    return (header, payload, None);
                                }
                            };
                        perf.cache_load_ms = cache_load_started.elapsed().as_secs_f64() * 1_000.0;
                        let mut runtime = self.runtime.lock().await;
                        runtime
                            .volume_cache
                            .insert(cache_key.clone(), loaded.clone());
                        loaded
                    }
                };

                let sample_count = compute_3d_sample_count(volume.volume.depth);
                perf.sample_count = sample_count;
                let raymarch_started = Instant::now();
                let (frame, stats) = build_real_3d_frame(
                    &request.viewport,
                    &session.camera,
                    volume.as_ref(),
                    sample_count,
                    spatial_scale_zyx,
                );
                perf.raymarch_ms = raymarch_started.elapsed().as_secs_f64() * 1_000.0;
                perf.bricks_traversed = stats.bricks_traversed;
                perf.bricks_sampled = stats.bricks_sampled;
                perf.samples_taken = stats.samples_taken;
                if stats.bricks_traversed > 0 {
                    perf.skip_ratio = ((stats.bricks_traversed - stats.bricks_sampled) as f64)
                        / stats.bricks_traversed as f64;
                }
                perf.raymarch_parallel = true;
                perf.raymarch_workers = rayon::current_num_threads();
                perf.rows_parallelized = request.viewport.height.max(1);
                frame
            }
            RenderMode::GraphStub => build_synthetic_graph_frame(
                &request.viewport,
                &request.axis_indices,
                &session.camera,
            ),
        };

        let response_prep_started = Instant::now();
        if frame.bytes.len() > MAX_FRAME_BYTES {
            let (header, payload) = frame_error_response(
                &request.request_id,
                format!(
                    "frame payload too large: {} bytes exceeds limit {}",
                    frame.bytes.len(),
                    MAX_FRAME_BYTES
                ),
            );
            return (header, payload, None);
        }

        let payload_len = frame.bytes.len() as u32;
        let response_header = FrameResponseHeader {
            request_id: request.request_id,
            status: "ok".to_string(),
            width: frame.width,
            height: frame.height,
            dtype: "u16".to_string(),
            endianness: "little".to_string(),
            payload_len,
            state_hash: state_hash_value,
            error: None,
        };
        perf.response_prep_ms = response_prep_started.elapsed().as_secs_f64() * 1_000.0;
        perf.total_ms = overall_started.elapsed().as_secs_f64() * 1_000.0;
        (response_header, frame.bytes, Some(perf))
    }

    fn emit_frame_perf_event(
        &self,
        perf: &FramePerfMetrics,
        response_header: &FrameResponseHeader,
    ) {
        let payload = json!({
            "source": "frame_socket",
            "request_id": perf.request_id,
            "render_mode": perf.render_mode,
            "viewport": {"width": perf.viewport_width, "height": perf.viewport_height},
            "status": response_header.status,
            "payload_len": response_header.payload_len,
            "frame_total_ms": perf.total_ms,
            "cache_lookup_ms": perf.cache_lookup_ms,
            "cache_load_ms": perf.cache_load_ms,
            "raymarch_ms": perf.raymarch_ms,
            "response_prep_ms": perf.response_prep_ms,
            "encode_write_ms": perf.encode_write_ms,
            "sample_count": perf.sample_count,
            "cache_hit": perf.cache_hit,
            "bricks_traversed": perf.bricks_traversed,
            "bricks_sampled": perf.bricks_sampled,
            "samples_taken": perf.samples_taken,
            "skip_ratio": perf.skip_ratio,
            "raymarch_parallel": perf.raymarch_parallel,
            "raymarch_workers": perf.raymarch_workers,
            "rows_parallelized": perf.rows_parallelized,
        });
        let _ = self.events_tx.send(EventEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: perf.protocol_version.clone(),
            session_id: Some(perf.session_id.clone()),
            event: "perf.frame".to_string(),
            payload,
            timestamp: now_utc(),
        });
        debug!(
            request_id = %perf.request_id,
            render_mode = %perf.render_mode,
            frame_total_ms = perf.total_ms,
            raymarch_ms = perf.raymarch_ms,
            cache_lookup_ms = perf.cache_lookup_ms,
            cache_load_ms = perf.cache_load_ms,
            response_prep_ms = perf.response_prep_ms,
            encode_write_ms = perf.encode_write_ms,
            sample_count = perf.sample_count,
            cache_hit = perf.cache_hit,
            bricks_traversed = perf.bricks_traversed,
            bricks_sampled = perf.bricks_sampled,
            samples_taken = perf.samples_taken,
            skip_ratio = perf.skip_ratio,
            raymarch_parallel = perf.raymarch_parallel,
            raymarch_workers = perf.raymarch_workers,
            rows_parallelized = perf.rows_parallelized,
            "frame performance metrics"
        );
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
                    let response = self
                        .record_and_build_error(&request, rpc_error.clone())
                        .await;
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
                let response = self
                    .record_and_build_error(&request, rpc_error.clone())
                    .await;
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
                    "camera": session.camera,
                    "render_mode": session.render_mode,
                })
            } else {
                json!({
                    "exists": false,
                    "dataset": Value::Null,
                    "layers": [],
                    "view": Value::Null,
                    "camera": Value::Null,
                    "render_mode": Value::Null,
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
                let response = self
                    .record_and_build_error(&request, rpc_error.clone())
                    .await;
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
                let response = self
                    .record_and_build_error(&request, rpc_error.clone())
                    .await;
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

        let app_state_snapshot = {
            let runtime = self.runtime.lock().await;
            runtime.app_state.clone()
        };
        let request_for_reducer = match preprocess_request(request, &app_state_snapshot).await {
            Ok(request) => request,
            Err((request, storage_error)) => {
                let rpc_error = storage_error_to_rpc(storage_error);
                let response = self
                    .record_and_build_error(&request, rpc_error.clone())
                    .await;
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
                maybe_invalidate_volume_cache(
                    &mut runtime,
                    &request_for_reducer.method,
                    request_for_reducer.session_id.as_deref(),
                );

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

struct FramePayload {
    width: u32,
    height: u32,
    bytes: Vec<u8>,
}

#[derive(Clone, Copy)]
struct ActiveImageLayer {
    channel: Option<usize>,
}

fn resolve_visible_image_layer(session: &SessionState) -> Option<ActiveImageLayer> {
    for layer in session.layers.values() {
        if !layer.visible {
            continue;
        }
        if let LayerKind::Image { channel, .. } = &layer.kind {
            return Some(ActiveImageLayer { channel: *channel });
        }
    }
    None
}

fn axis_indices_map_with_channel(
    indices: &FrameAxisIndices,
    channel_override: Option<usize>,
) -> BTreeMap<String, usize> {
    let mut map = BTreeMap::new();
    map.insert("t".to_string(), indices.t);
    map.insert("c".to_string(), channel_override.unwrap_or(indices.c));
    map.insert("z".to_string(), indices.z);
    map
}

fn build_synthetic_2d_slice_frame(
    viewport: &lucida_protocol::FrameViewport,
    axis: &FrameAxisIndices,
    camera: &CameraMode,
) -> FramePayload {
    let width = viewport.width.max(1);
    let height = viewport.height.max(1);
    let mut bytes = Vec::with_capacity(width as usize * height as usize * 2);

    let camera = camera_influence(camera);
    let zoom = camera.z.abs().max(0.25);
    let aspect = width as f32 / height as f32;
    let slice_z = axis.z as f32 * 0.32 + axis.t as f32 * 0.07;

    for y in 0..height {
        let ny = 1.0 - ((y as f32 + 0.5) / height as f32) * 2.0;
        for x in 0..width {
            let nx = ((x as f32 + 0.5) / width as f32) * 2.0 - 1.0;

            let wx = nx * aspect / zoom + camera.x * 0.12;
            let wy = ny / zoom + camera.y * 0.12;

            let mut intensity = 0.0f32;
            intensity += slice_blob(wx, wy, slice_z, [0.0, 0.0, 0.0], 1.15, 0.78);
            intensity += slice_blob(wx, wy, slice_z, [1.5, -0.5, 0.9], 0.65, 0.52);
            intensity += slice_blob(wx, wy, slice_z, [-1.25, 0.85, -0.45], 0.72, 0.46);
            intensity += slice_box(
                wx,
                wy,
                slice_z,
                [-1.95, -0.55, 0.25],
                [-1.05, 0.35, 1.15],
                0.38,
            );

            let ring_r = ((wx - 0.75).powi(2) + (wy + 1.1).powi(2)).sqrt();
            let ring = (1.0 - ((ring_r - 0.45).abs() * 7.0 + (slice_z + 0.2).abs() * 1.8)).max(0.0);
            intensity += ring * 0.25;

            let grid_x = ((wx * 2.8 + 64.0).fract() - 0.5).abs();
            let grid_y = ((wy * 2.8 + 64.0).fract() - 0.5).abs();
            let grid = (0.02 - grid_x.min(grid_y)).max(0.0) * 6.0;
            intensity += grid * 0.06;

            let channel_mod = 1.0 + (axis.c as f32) * 0.05;
            intensity = (intensity * channel_mod).clamp(0.0, 1.0);
            let value = (intensity * u16::MAX as f32).round() as u16;
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }

    FramePayload {
        width,
        height,
        bytes,
    }
}

fn slice_blob(x: f32, y: f32, z: f32, center: [f32; 3], radius: f32, weight: f32) -> f32 {
    let dx = x - center[0];
    let dy = y - center[1];
    let dz = z - center[2];
    if dz.abs() >= radius {
        return 0.0;
    }
    let slice_radius = (radius * radius - dz * dz).sqrt();
    let radial = (dx * dx + dy * dy).sqrt();
    if radial >= slice_radius {
        return 0.0;
    }
    let edge_falloff = 1.0 - radial / slice_radius;
    edge_falloff.powf(1.6) * weight
}

fn slice_box(x: f32, y: f32, z: f32, min: [f32; 3], max: [f32; 3], weight: f32) -> f32 {
    if x < min[0] || x > max[0] || y < min[1] || y > max[1] || z < min[2] || z > max[2] {
        return 0.0;
    }
    let edge_x = (x - min[0]).min(max[0] - x);
    let edge_y = (y - min[1]).min(max[1] - y);
    let edge_z = (z - min[2]).min(max[2] - z);
    let edge = edge_x.min(edge_y).min(edge_z);
    (0.2 + edge * 0.5).min(1.0) * weight
}

type Vec3 = [f32; 3];

#[derive(Clone, Copy)]
struct CameraBasis {
    origin: Vec3,
    forward: Vec3,
    right: Vec3,
    up: Vec3,
}

#[derive(Clone, Copy, Debug, Default)]
struct RaymarchStats {
    bricks_traversed: u64,
    bricks_sampled: u64,
    samples_taken: u64,
}

fn build_real_3d_frame(
    viewport: &lucida_protocol::FrameViewport,
    camera: &CameraMode,
    volume: &AcceleratedVolume,
    samples: usize,
    spatial_scale_zyx: [f32; 3],
) -> (FramePayload, RaymarchStats) {
    let width = viewport.width.max(1);
    let height = viewport.height.max(1);
    let row_bytes = width as usize * 2;
    let mut bytes = vec![0u8; row_bytes * height as usize];

    let basis = camera_basis_for_volume(camera);
    let aspect = width as f32 / height as f32;
    let fov = 0.9f32;
    let half_extents = normalized_volume_half_extents(volume.volume.as_ref(), spatial_scale_zyx);
    let box_min = [-half_extents[0], -half_extents[1], -half_extents[2]];
    let box_max = [half_extents[0], half_extents[1], half_extents[2]];
    let stats = bytes
        .par_chunks_mut(row_bytes)
        .enumerate()
        .map(|(y, row)| {
            let mut row_stats = RaymarchStats::default();
            let y = y as u32;
            let ny = 1.0 - ((y as f32 + 0.5) / height as f32) * 2.0;
            for x in 0..width {
                let nx = ((x as f32 + 0.5) / width as f32) * 2.0 - 1.0;
                let ray_dir = v_normalize(v_add(
                    basis.forward,
                    v_add(
                        v_scale(basis.right, nx * aspect * fov),
                        v_scale(basis.up, ny * fov),
                    ),
                ));

                let value = if let Some((t_start, t_end)) =
                    ray_aabb_interval(basis.origin, ray_dir, box_min, box_max)
                {
                    let (peak, ray_stats) = raymarch_mip_brick_skip(
                        volume,
                        basis.origin,
                        ray_dir,
                        t_start,
                        t_end,
                        samples,
                        half_extents,
                    );
                    row_stats.bricks_traversed += ray_stats.bricks_traversed;
                    row_stats.bricks_sampled += ray_stats.bricks_sampled;
                    row_stats.samples_taken += ray_stats.samples_taken;
                    peak
                } else {
                    0u16
                };
                let pixel_offset = x as usize * 2;
                let value_bytes = value.to_le_bytes();
                row[pixel_offset] = value_bytes[0];
                row[pixel_offset + 1] = value_bytes[1];
            }
            row_stats
        })
        .reduce(RaymarchStats::default, merge_raymarch_stats);

    (
        FramePayload {
            width,
            height,
            bytes,
        },
        stats,
    )
}

fn merge_raymarch_stats(left: RaymarchStats, right: RaymarchStats) -> RaymarchStats {
    RaymarchStats {
        bricks_traversed: left.bricks_traversed + right.bricks_traversed,
        bricks_sampled: left.bricks_sampled + right.bricks_sampled,
        samples_taken: left.samples_taken + right.samples_taken,
    }
}

fn compute_3d_sample_count(depth: u32) -> usize {
    depth.clamp(48, 192) as usize
}

fn compute_intersection_step(t_start: f32, t_end: f32, samples: usize) -> f32 {
    let span = (t_end - t_start).max(1e-5);
    span / samples.max(1) as f32
}

fn build_accelerated_volume(volume: Arc<U16Volume>, brick_size: u32) -> Result<AcceleratedVolume> {
    let brick_size = brick_size.max(1);
    let grid_x = volume.width.div_ceil(brick_size);
    let grid_y = volume.height.div_ceil(brick_size);
    let grid_z = volume.depth.div_ceil(brick_size);
    let brick_count = (grid_x as usize)
        .checked_mul(grid_y as usize)
        .and_then(|value| value.checked_mul(grid_z as usize))
        .ok_or_else(|| anyhow!("accelerated volume brick grid overflow"))?;
    let mut brick_max = vec![0u16; brick_count];
    let width = volume.width as usize;
    let height = volume.height as usize;

    for z in 0..volume.depth as usize {
        let bz = z as u32 / brick_size;
        for y in 0..volume.height as usize {
            let by = y as u32 / brick_size;
            let row_offset = (z * height + y) * width;
            for x in 0..volume.width as usize {
                let value = volume.voxels[row_offset + x];
                if value == 0 {
                    continue;
                }
                let bx = x as u32 / brick_size;
                let brick_idx = brick_linear_index([bx, by, bz], [grid_x, grid_y, grid_z]);
                if value > brick_max[brick_idx] {
                    brick_max[brick_idx] = value;
                }
            }
        }
    }

    Ok(AcceleratedVolume {
        volume,
        brick_size,
        grid: [grid_x, grid_y, grid_z],
        brick_max,
    })
}

fn raymarch_mip_brick_skip(
    volume: &AcceleratedVolume,
    origin_world: Vec3,
    dir_world: Vec3,
    t_start: f32,
    t_end: f32,
    samples: usize,
    half_extents: Vec3,
) -> (u16, RaymarchStats) {
    let mut stats = RaymarchStats::default();
    let total_span = (t_end - t_start).max(1e-5);
    let sample_density = samples.max(1) as f32 / total_span;
    let volume_dims = [
        volume.volume.width.max(1) as f32,
        volume.volume.height.max(1) as f32,
        volume.volume.depth.max(1) as f32,
    ];
    let origin_voxel = world_to_voxel_space(origin_world, volume_dims, half_extents);
    let dir_voxel = [
        dir_world[0] * volume_dims[0] / (2.0 * half_extents[0].max(1e-6)),
        dir_world[1] * volume_dims[1] / (2.0 * half_extents[1].max(1e-6)),
        dir_world[2] * volume_dims[2] / (2.0 * half_extents[2].max(1e-6)),
    ];
    let start_t = (t_start + 1e-5).min(t_end);
    let start_pos = [
        origin_voxel[0] + dir_voxel[0] * start_t,
        origin_voxel[1] + dir_voxel[1] * start_t,
        origin_voxel[2] + dir_voxel[2] * start_t,
    ];
    let mut brick = [
        voxel_to_brick_index(start_pos[0], volume.brick_size, volume.grid[0]),
        voxel_to_brick_index(start_pos[1], volume.brick_size, volume.grid[1]),
        voxel_to_brick_index(start_pos[2], volume.brick_size, volume.grid[2]),
    ];
    let traversal = init_brick_traversal(
        origin_voxel,
        dir_voxel,
        brick,
        volume.brick_size,
        volume.grid,
        volume_dims,
    );
    let mut t_curr = t_start;
    let mut t_next = traversal.t_next;
    let mut t_delta = traversal.t_delta;
    let steps = traversal.steps;
    let mut peak = 0u16;

    while t_curr < t_end {
        if brick[0] < 0
            || brick[1] < 0
            || brick[2] < 0
            || brick[0] >= volume.grid[0] as i32
            || brick[1] >= volume.grid[1] as i32
            || brick[2] >= volume.grid[2] as i32
        {
            break;
        }

        let seg_end = t_end.min(t_next[0].min(t_next[1].min(t_next[2])));
        if seg_end > t_curr + 1e-6 {
            stats.bricks_traversed += 1;
            let brick_idx = brick_linear_index(
                [brick[0] as u32, brick[1] as u32, brick[2] as u32],
                volume.grid,
            );
            let brick_peak = volume.brick_max[brick_idx];
            if brick_peak > peak {
                stats.bricks_sampled += 1;
                let seg_samples = ((seg_end - t_curr) * sample_density).ceil() as usize;
                let seg_samples = seg_samples.max(1);
                let step = compute_intersection_step(t_curr, seg_end, seg_samples);
                let mut sample_t = t_curr;
                for _ in 0..seg_samples {
                    peak = peak.max(sample_volume_nearest(
                        volume.volume.as_ref(),
                        v_add(origin_world, v_scale(dir_world, sample_t)),
                        half_extents,
                    ));
                    stats.samples_taken += 1;
                    if peak == u16::MAX {
                        return (peak, stats);
                    }
                    sample_t += step;
                }
            }
        }

        if seg_end >= t_end - 1e-6 {
            break;
        }

        let advance_eps = 1e-6;
        t_curr = seg_end.max(t_curr + advance_eps);
        for axis in 0..3 {
            if (t_next[axis] - seg_end).abs() <= 1e-5 {
                brick[axis] += steps[axis];
                t_next[axis] += t_delta[axis];
            }
        }
        for axis in 0..3 {
            if t_next[axis] < t_curr {
                t_next[axis] = t_curr + 1e-5;
            }
            if !t_delta[axis].is_finite() {
                t_delta[axis] = f32::INFINITY;
            }
        }
    }

    (peak, stats)
}

struct BrickTraversalInit {
    steps: [i32; 3],
    t_next: [f32; 3],
    t_delta: [f32; 3],
}

fn init_brick_traversal(
    origin_voxel: Vec3,
    dir_voxel: Vec3,
    brick: [i32; 3],
    brick_size: u32,
    grid: [u32; 3],
    volume_dims: [f32; 3],
) -> BrickTraversalInit {
    let mut steps = [0i32; 3];
    let mut t_next = [f32::INFINITY; 3];
    let mut t_delta = [f32::INFINITY; 3];
    let brick_size = brick_size as f32;
    for axis in 0..3 {
        let dir = dir_voxel[axis];
        if dir.abs() < 1e-6 {
            continue;
        }
        let current_brick = brick[axis].clamp(0, grid[axis] as i32 - 1);
        if dir > 0.0 {
            steps[axis] = 1;
            let next_boundary = ((current_brick + 1) as f32 * brick_size).min(volume_dims[axis]);
            t_next[axis] = (next_boundary - origin_voxel[axis]) / dir;
            t_delta[axis] = brick_size / dir;
        } else {
            steps[axis] = -1;
            let next_boundary = (current_brick as f32 * brick_size).max(0.0);
            t_next[axis] = (next_boundary - origin_voxel[axis]) / dir;
            t_delta[axis] = -brick_size / dir;
        }
        if t_next[axis] < 0.0 {
            t_next[axis] = 0.0;
        }
    }
    BrickTraversalInit {
        steps,
        t_next,
        t_delta,
    }
}

fn brick_linear_index(brick: [u32; 3], grid: [u32; 3]) -> usize {
    ((brick[2] as usize * grid[1] as usize + brick[1] as usize) * grid[0] as usize)
        + brick[0] as usize
}

fn world_to_voxel_space(world: Vec3, dims: [f32; 3], half_extents: [f32; 3]) -> Vec3 {
    [
        ((world[0] + half_extents[0]) / (2.0 * half_extents[0].max(1e-6))) * dims[0],
        ((world[1] + half_extents[1]) / (2.0 * half_extents[1].max(1e-6))) * dims[1],
        ((world[2] + half_extents[2]) / (2.0 * half_extents[2].max(1e-6))) * dims[2],
    ]
}

fn voxel_to_brick_index(voxel: f32, brick_size: u32, grid_len: u32) -> i32 {
    let brick = (voxel.max(0.0) / brick_size.max(1) as f32).floor() as i32;
    brick.clamp(0, grid_len.saturating_sub(1) as i32)
}

fn sample_volume_nearest(volume: &U16Volume, world: Vec3, half_extents: [f32; 3]) -> u16 {
    if world[0] < -half_extents[0]
        || world[0] > half_extents[0]
        || world[1] < -half_extents[1]
        || world[1] > half_extents[1]
        || world[2] < -half_extents[2]
        || world[2] > half_extents[2]
    {
        return 0;
    }
    let nx = (world[0] + half_extents[0]) / (2.0 * half_extents[0].max(1e-6));
    let ny = (world[1] + half_extents[1]) / (2.0 * half_extents[1].max(1e-6));
    let nz = (world[2] + half_extents[2]) / (2.0 * half_extents[2].max(1e-6));
    let x = (nx * (volume.width.saturating_sub(1) as f32)).round() as i32;
    let y = (ny * (volume.height.saturating_sub(1) as f32)).round() as i32;
    let z = (nz * (volume.depth.saturating_sub(1) as f32)).round() as i32;
    if x < 0
        || y < 0
        || z < 0
        || x >= volume.width as i32
        || y >= volume.height as i32
        || z >= volume.depth as i32
    {
        return 0;
    }
    let idx =
        ((z as usize * volume.height as usize + y as usize) * volume.width as usize) + x as usize;
    volume.voxels[idx]
}

fn normalized_volume_half_extents(volume: &U16Volume, spatial_scale_zyx: [f32; 3]) -> Vec3 {
    let sx = spatial_scale_zyx[2].max(1e-6);
    let sy = spatial_scale_zyx[1].max(1e-6);
    let sz = spatial_scale_zyx[0].max(1e-6);
    let extent_x = volume.width.max(1) as f32 * sx;
    let extent_y = volume.height.max(1) as f32 * sy;
    let extent_z = volume.depth.max(1) as f32 * sz;
    let max_extent = extent_x.max(extent_y).max(extent_z).max(1e-6);
    [
        (extent_x / max_extent).max(1e-3),
        (extent_y / max_extent).max(1e-3),
        (extent_z / max_extent).max(1e-3),
    ]
}

fn ray_aabb_interval(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3) -> Option<(f32, f32)> {
    let mut t_min = -f32::INFINITY;
    let mut t_max = f32::INFINITY;

    for axis in 0..3 {
        let o = origin[axis];
        let d = dir[axis];
        if d.abs() < 1e-6 {
            if o < min[axis] || o > max[axis] {
                return None;
            }
            continue;
        }

        let inv = 1.0 / d;
        let mut t1 = (min[axis] - o) * inv;
        let mut t2 = (max[axis] - o) * inv;
        if t1 > t2 {
            std::mem::swap(&mut t1, &mut t2);
        }
        t_min = t_min.max(t1);
        t_max = t_max.min(t2);
        if t_min > t_max {
            return None;
        }
    }

    if t_max <= 1e-5 {
        return None;
    }
    Some((t_min.max(0.0), t_max))
}

fn camera_basis_for_volume(camera: &CameraMode) -> CameraBasis {
    match camera {
        CameraMode::PanZoom(state) => CameraBasis {
            origin: [
                state.center[0] as f32,
                state.center[1] as f32,
                (3.0f64 / state.zoom.max(0.1)) as f32,
            ],
            forward: [0.0, 0.0, -1.0],
            right: [1.0, 0.0, 0.0],
            up: [0.0, 1.0, 0.0],
        },
        CameraMode::Arcball(state) => {
            let influence = CameraInfluence {
                x: state.target[0] as f32,
                y: state.target[1] as f32,
                z: state.target[2] as f32,
                yaw: state.yaw_pitch[0] as f32,
                pitch: state.yaw_pitch[1] as f32,
                roll: 0.0,
            };
            let mut basis = camera_basis(&influence);
            basis.origin = v_sub(
                [
                    state.target[0] as f32,
                    state.target[1] as f32,
                    state.target[2] as f32,
                ],
                v_scale(basis.forward, state.distance.max(0.05) as f32),
            );
            basis
        }
        CameraMode::Freefly(state) => camera_basis(&CameraInfluence {
            x: state.position[0] as f32,
            y: state.position[1] as f32,
            z: state.position[2] as f32,
            yaw: state.yaw_pitch_roll[0] as f32,
            pitch: state.yaw_pitch_roll[1] as f32,
            roll: state.yaw_pitch_roll[2] as f32,
        }),
    }
}

fn camera_basis(camera: &CameraInfluence) -> CameraBasis {
    let yaw = camera.yaw;
    let pitch = camera.pitch.clamp(-1.45, 1.45);
    let roll = camera.roll;

    let forward = v_normalize([
        yaw.sin() * pitch.cos(),
        pitch.sin(),
        -yaw.cos() * pitch.cos(),
    ]);

    let world_up = [0.0, 1.0, 0.0];
    let mut right = v_cross(forward, world_up);
    if v_length(right) < 1e-6 {
        right = [1.0, 0.0, 0.0];
    }
    right = v_normalize(right);
    let mut up = v_normalize(v_cross(right, forward));

    let (sin_roll, cos_roll) = roll.sin_cos();
    let rolled_right = v_normalize(v_add(v_scale(right, cos_roll), v_scale(up, sin_roll)));
    up = v_normalize(v_sub(v_scale(up, cos_roll), v_scale(right, sin_roll)));

    CameraBasis {
        origin: [camera.x, camera.y, camera.z],
        forward,
        right: rolled_right,
        up,
    }
}

fn v_add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn v_sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn v_scale(v: Vec3, scalar: f32) -> Vec3 {
    [v[0] * scalar, v[1] * scalar, v[2] * scalar]
}

fn v_dot(a: Vec3, b: Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn v_cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn v_length(v: Vec3) -> f32 {
    v_dot(v, v).sqrt()
}

fn v_normalize(v: Vec3) -> Vec3 {
    let length = v_length(v).max(1e-9);
    [v[0] / length, v[1] / length, v[2] / length]
}

fn build_synthetic_graph_frame(
    viewport: &lucida_protocol::FrameViewport,
    axis: &FrameAxisIndices,
    camera: &CameraMode,
) -> FramePayload {
    let width = viewport.width.max(1);
    let height = viewport.height.max(1);
    let mut grid = vec![0u32; width as usize * height as usize];
    let camera = camera_influence(camera);
    let mut seed =
        ((axis.t as u64) << 42) ^ ((axis.c as u64) << 21) ^ (axis.z as u64) ^ 0x9E37_79B9_7F4A_7C15;
    seed ^= (camera.x.to_bits() as u64)
        ^ ((camera.y.to_bits() as u64) << 1)
        ^ ((camera.yaw.to_bits() as u64) << 2);
    let point_count = 256 + ((axis.t + axis.c + axis.z) % 128);
    let x_bias = (camera.x * 3.0) as i32;
    let y_bias = (camera.y * 3.0) as i32;

    for _ in 0..point_count {
        seed = lcg_next(seed);
        let px = ((seed as u32 % width) as i32 + x_bias).rem_euclid(width as i32);
        seed = lcg_next(seed);
        let py = ((seed as u32 % height) as i32 + y_bias).rem_euclid(height as i32);

        accumulate_point(&mut grid, width, height, px, py, 12000);
        accumulate_point(&mut grid, width, height, px - 1, py, 4000);
        accumulate_point(&mut grid, width, height, px + 1, py, 4000);
        accumulate_point(&mut grid, width, height, px, py - 1, 4000);
        accumulate_point(&mut grid, width, height, px, py + 1, 4000);
    }

    let mut bytes = Vec::with_capacity(width as usize * height as usize * 2);
    for y in 0..height {
        for x in 0..width {
            let idx = y as usize * width as usize + x as usize;
            let baseline = ((x + y) % 23) as u32 * 30;
            let value = (grid[idx] + baseline).min(u16::MAX as u32) as u16;
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }

    FramePayload {
        width,
        height,
        bytes,
    }
}

struct CameraInfluence {
    x: f32,
    y: f32,
    z: f32,
    yaw: f32,
    pitch: f32,
    roll: f32,
}

fn camera_influence(camera: &CameraMode) -> CameraInfluence {
    match camera {
        CameraMode::PanZoom(state) => CameraInfluence {
            x: state.center[0] as f32,
            y: state.center[1] as f32,
            z: state.zoom as f32,
            yaw: 0.0,
            pitch: 0.0,
            roll: 0.0,
        },
        CameraMode::Arcball(state) => CameraInfluence {
            x: state.target[0] as f32,
            y: state.target[1] as f32,
            z: state.target[2] as f32,
            yaw: state.yaw_pitch[0] as f32,
            pitch: state.yaw_pitch[1] as f32,
            roll: 0.0,
        },
        CameraMode::Freefly(state) => CameraInfluence {
            x: state.position[0] as f32,
            y: state.position[1] as f32,
            z: state.position[2] as f32,
            yaw: state.yaw_pitch_roll[0] as f32,
            pitch: state.yaw_pitch_roll[1] as f32,
            roll: state.yaw_pitch_roll[2] as f32,
        },
    }
}

fn lcg_next(seed: u64) -> u64 {
    seed.wrapping_mul(6364136223846793005).wrapping_add(1)
}

fn accumulate_point(grid: &mut [u32], width: u32, height: u32, x: i32, y: i32, weight: u32) {
    if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
        return;
    }
    let idx = y as usize * width as usize + x as usize;
    grid[idx] = grid[idx].saturating_add(weight);
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

fn maybe_invalidate_volume_cache(
    runtime: &mut DaemonRuntime,
    method: &str,
    session_id: Option<&str>,
) {
    if !matches!(method, "dataset.open" | "dataset.close" | "session.close") {
        return;
    }
    let Some(session_id) = session_id else {
        return;
    };
    runtime
        .volume_cache
        .retain(|key, _| key.session_id != session_id);
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

fn dataset_axis_remap(dataset: &lucida_protocol::DatasetHandle) -> BTreeMap<String, String> {
    dataset
        .multiscale_metadata
        .get("axis_map")
        .cloned()
        .and_then(|value| serde_json::from_value::<BTreeMap<String, String>>(value).ok())
        .unwrap_or_default()
}

fn dataset_spatial_scale_zyx(dataset: &lucida_protocol::DatasetHandle) -> [f32; 3] {
    let Some(values) = dataset
        .multiscale_metadata
        .get("spatial_scale_zyx")
        .and_then(Value::as_array)
    else {
        return [1.0, 1.0, 1.0];
    };
    if values.len() != 3 {
        return [1.0, 1.0, 1.0];
    }

    let mut scales = [1.0f32; 3];
    for (index, value) in values.iter().enumerate() {
        let Some(scale) = value.as_f64() else {
            return [1.0, 1.0, 1.0];
        };
        if !scale.is_finite() || scale <= 0.0 {
            return [1.0, 1.0, 1.0];
        }
        scales[index] = scale as f32;
    }
    scales
}

async fn preprocess_request(
    request: RpcRequestEnvelope,
    app_state: &AppState,
) -> Result<RpcRequestEnvelope, (RpcRequestEnvelope, StorageError)> {
    match request.method.as_str() {
        "dataset.open" => preprocess_dataset_open_request(request),
        "layer.auto_contrast" => preprocess_layer_auto_contrast_request(request, app_state),
        _ => Ok(request),
    }
}

fn preprocess_dataset_open_request(
    request: RpcRequestEnvelope,
) -> Result<RpcRequestEnvelope, (RpcRequestEnvelope, StorageError)> {
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

fn preprocess_layer_auto_contrast_request(
    request: RpcRequestEnvelope,
    app_state: &AppState,
) -> Result<RpcRequestEnvelope, (RpcRequestEnvelope, StorageError)> {
    let Some(session_id) = request.session_id.as_deref() else {
        return Err((
            request.clone(),
            StorageError::UnsupportedLayout("layer.auto_contrast requires session_id".to_string()),
        ));
    };
    let session = app_state.sessions.get(session_id).ok_or_else(|| {
        (
            request.clone(),
            StorageError::MissingDataset(format!("unknown session_id: {session_id}")),
        )
    })?;
    let dataset = session.dataset.as_ref().ok_or_else(|| {
        (
            request.clone(),
            StorageError::MissingDataset(format!("session {session_id} has no opened dataset")),
        )
    })?;
    let dataset_uri = dataset.uri.clone();
    let layer_id = request
        .params
        .get("layer_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            (
                request.clone(),
                StorageError::UnsupportedLayout(
                    "layer.auto_contrast requires layer_id".to_string(),
                ),
            )
        })?;
    let layer = session.layers.get(&layer_id).ok_or_else(|| {
        (
            request.clone(),
            StorageError::UnsupportedLayout(format!("unknown layer_id: {layer_id}")),
        )
    })?;
    let channel_override = match &layer.kind {
        LayerKind::Image { channel, .. } => *channel,
        _ => {
            return Err((
                request.clone(),
                StorageError::UnsupportedLayout(format!("layer {layer_id} is not an image layer")),
            ))
        }
    };
    let method = request
        .params
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("robust_percentile_1_99")
        .to_string();
    let axis_indices = &session.view.axis_indices;
    let axis_map = BTreeMap::from([
        ("t".to_string(), *axis_indices.get("t").unwrap_or(&0)),
        (
            "c".to_string(),
            channel_override.unwrap_or(*axis_indices.get("c").unwrap_or(&0)),
        ),
        ("z".to_string(), *axis_indices.get("z").unwrap_or(&0)),
    ]);
    let dataset_axis_remap = dataset_axis_remap(dataset);
    let plane = read_u16_plane(&dataset_uri, &axis_map, &dataset_axis_remap)
        .map_err(|err| (request.clone(), err))?;
    let contrast_limits = match method.as_str() {
        "robust_percentile_1_99" => robust_percentile_limits(&plane, 0.01, 0.99),
        "full_range" => [0, u16::MAX],
        other => {
            return Err((
                request.clone(),
                StorageError::UnsupportedLayout(format!(
                    "unsupported auto contrast method: {other}"
                )),
            ))
        }
    };

    let mut request = request;
    if !request.params.is_object() {
        request.params = json!({});
    }
    let params = request.params.as_object_mut().expect("params object");
    params.insert("layer_id".to_string(), json!(layer_id));
    params.insert("method".to_string(), json!(method));
    params.insert("min".to_string(), json!(contrast_limits[0]));
    params.insert("max".to_string(), json!(contrast_limits[1]));
    Ok(request)
}

fn robust_percentile_limits(plane: &U16FramePlane, low: f64, high: f64) -> [u16; 2] {
    let mut hist = vec![0u32; (u16::MAX as usize) + 1];
    let mut count: u64 = 0;
    for chunk in plane.bytes.chunks_exact(2) {
        let value = u16::from_le_bytes([chunk[0], chunk[1]]);
        hist[value as usize] += 1;
        count += 1;
    }
    if count == 0 {
        return [0, u16::MAX];
    }

    let low_rank = ((count - 1) as f64 * low)
        .round()
        .clamp(0.0, (count - 1) as f64) as u64;
    let high_rank = ((count - 1) as f64 * high)
        .round()
        .clamp(low_rank as f64, (count - 1) as f64) as u64;

    let mut cumulative: u64 = 0;
    let mut min_value: u16 = 0;
    let mut max_value: u16 = u16::MAX;
    let mut min_found = false;
    for (value, bin_count) in hist.iter().enumerate() {
        cumulative += *bin_count as u64;
        if !min_found && cumulative > low_rank {
            min_value = value as u16;
            min_found = true;
        }
        if cumulative > high_rank {
            max_value = value as u16;
            break;
        }
    }
    if min_value >= max_value {
        max_value = min_value.saturating_add(1).max(min_value);
    }
    [min_value.min(max_value.saturating_sub(1)), max_value]
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
    use std::{path::PathBuf, sync::Arc};

    use serde_json::json;

    use super::*;

    #[test]
    fn sample_budget_is_depth_based_and_bounded() {
        assert_eq!(compute_3d_sample_count(1), 48);
        assert_eq!(compute_3d_sample_count(47), 48);
        assert_eq!(compute_3d_sample_count(48), 48);
        assert_eq!(compute_3d_sample_count(128), 128);
        assert_eq!(compute_3d_sample_count(192), 192);
        assert_eq!(compute_3d_sample_count(512), 192);
    }

    #[test]
    fn merge_raymarch_stats_accumulates_all_counters() {
        let left = RaymarchStats {
            bricks_traversed: 2,
            bricks_sampled: 1,
            samples_taken: 32,
        };
        let right = RaymarchStats {
            bricks_traversed: 3,
            bricks_sampled: 2,
            samples_taken: 64,
        };
        let merged = merge_raymarch_stats(left, right);
        assert_eq!(merged.bricks_traversed, 5);
        assert_eq!(merged.bricks_sampled, 3);
        assert_eq!(merged.samples_taken, 96);
    }

    #[test]
    fn accelerated_volume_tracks_brick_maxima() {
        let width = 9usize;
        let height = 8usize;
        let depth = 8usize;
        let mut voxels = vec![0u16; width * height * depth];
        let voxel_idx = |x: usize, y: usize, z: usize| ((z * height + y) * width) + x;
        voxels[voxel_idx(1, 2, 3)] = 1200;
        voxels[voxel_idx(8, 6, 7)] = 48000;
        let volume = Arc::new(U16Volume {
            width: width as u32,
            height: height as u32,
            depth: depth as u32,
            voxels,
        });

        let accelerated = build_accelerated_volume(volume, 8).expect("accelerated volume");
        assert_eq!(accelerated.grid, [2, 1, 1]);
        assert_eq!(accelerated.brick_max.len(), 2);
        assert_eq!(accelerated.brick_max[0], 1200);
        assert_eq!(accelerated.brick_max[1], 48000);
    }

    #[test]
    fn raymarch_skips_empty_bricks_for_sparse_volume() {
        let width = 16usize;
        let height = 16usize;
        let depth = 16usize;
        let mut voxels = vec![0u16; width * height * depth];
        let voxel_idx = |x: usize, y: usize, z: usize| ((z * height + y) * width) + x;
        for z in 0..8usize {
            voxels[voxel_idx(8, 8, z)] = 42000;
        }
        let volume = Arc::new(U16Volume {
            width: width as u32,
            height: height as u32,
            depth: depth as u32,
            voxels,
        });
        let accelerated =
            build_accelerated_volume(volume, BRICK_SIZE_VOXELS).expect("accelerated volume");
        let origin = [0.0, 0.0, 3.2];
        let dir = [0.0, 0.0, -1.0];
        let (t_start, t_end) = ray_aabb_interval(origin, dir, [-1.0, -1.0, -1.0], [1.0, 1.0, 1.0])
            .expect("ray intersects volume");
        let (peak, stats) =
            raymarch_mip_brick_skip(&accelerated, origin, dir, t_start, t_end, 128, [1.0; 3]);
        assert!(peak > 0);
        assert!(stats.bricks_traversed > 0);
        assert!(stats.bricks_sampled > 0);
        assert!(stats.bricks_sampled < stats.bricks_traversed);
        assert!(stats.samples_taken > 0);
    }

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
        let result = response
            .result
            .expect("inspect should return result payload");
        assert_eq!(result["exists"], json!(false));
        assert_eq!(result["camera"], Value::Null);
        assert_eq!(result["render_mode"], Value::Null);
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
    async fn capabilities_include_3d_and_exclude_3d_stub() {
        let daemon = Daemon::new();
        let request = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            session_id: None,
            request_id: "req-capabilities".to_string(),
            method: "server.capabilities".to_string(),
            params: json!({}),
            timestamp: now_utc(),
        };
        let (response, _) = daemon.process_request(request).await;
        let result = response.result.expect("capabilities result");
        let render_modes = result["render_modes"]
            .as_array()
            .expect("render_modes array")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        assert!(render_modes.contains(&"3d"));
        assert!(!render_modes.contains(&"3d_stub"));
    }

    #[tokio::test]
    async fn render_mode_rejects_legacy_3d_stub() {
        let daemon = Daemon::new();
        let (create_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: None,
                request_id: "req-create".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id")
            .to_string();

        let (response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id),
                request_id: "req-mode".to_string(),
                method: "view.set_render_mode".to_string(),
                params: json!({"mode": "3d_stub"}),
                timestamp: now_utc(),
            })
            .await;
        let err = response.error.expect("legacy mode should fail");
        assert!(err.message.contains("invalid render mode: 3d_stub"));
    }

    #[tokio::test]
    async fn render_mode_falls_back_to_2d_without_dataset_or_layer() {
        let daemon = Daemon::new();
        let (create_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: None,
                request_id: "req-create".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id")
            .to_string();

        let (response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-mode".to_string(),
                method: "view.set_render_mode".to_string(),
                params: json!({"mode": "3d"}),
                timestamp: now_utc(),
            })
            .await;
        let result = response.result.expect("view.set_render_mode result");
        assert_eq!(result["requested_mode"], json!("3d"));
        assert_eq!(result["mode"], json!("2d"));
        assert_eq!(
            result["fallback_reason"],
            json!("missing dataset or visible image layer")
        );

        let (inspect_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id),
                request_id: "req-inspect".to_string(),
                method: "session.inspect".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let inspect = inspect_response.result.expect("session.inspect");
        assert_eq!(inspect["render_mode"], json!("2d"));
    }

    #[tokio::test]
    async fn volume_cache_invalidates_on_dataset_close() {
        let daemon = Daemon::new();
        let (create_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: None,
                request_id: "req-create".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id")
            .to_string();

        let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/ome_zarr_v05_structured_3d");
        let (open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-open".to_string(),
                method: "dataset.open".to_string(),
                params: json!({"uri": fixture_path.display().to_string(), "read_only": true}),
                timestamp: now_utc(),
            })
            .await;
        assert!(open_response.error.is_none());

        let (layer_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-layer".to_string(),
                method: "layer.add_image".to_string(),
                params: json!({"layer_id":"image-1","channel":0}),
                timestamp: now_utc(),
            })
            .await;
        assert!(layer_response.error.is_none());

        let (mode_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-mode".to_string(),
                method: "view.set_render_mode".to_string(),
                params: json!({"mode":"3d"}),
                timestamp: now_utc(),
            })
            .await;
        assert!(mode_response.error.is_none());

        let (frame_open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-frame-open".to_string(),
                method: "frame.channel.open".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let frame_open_result = frame_open_response
            .result
            .expect("frame.channel.open result");
        let channel_token = frame_open_result["channel_token"]
            .as_str()
            .expect("channel token")
            .to_string();

        let (frame_header, _) = daemon
            .process_frame_request(FrameRequestHeader {
                frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
                request_id: "req-frame".to_string(),
                channel_token,
                session_id: session_id.clone(),
                axis_indices: FrameAxisIndices { t: 0, c: 0, z: 0 },
                viewport: lucida_protocol::FrameViewport {
                    width: 32,
                    height: 24,
                },
            })
            .await;
        assert_eq!(frame_header.status, "ok");

        {
            let runtime = daemon.runtime.lock().await;
            assert!(
                runtime
                    .volume_cache
                    .keys()
                    .any(|key| key.session_id == session_id),
                "expected cache entry for session"
            );
        }

        let (close_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-dataset-close".to_string(),
                method: "dataset.close".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        assert!(close_response.error.is_none());

        let runtime = daemon.runtime.lock().await;
        assert!(
            !runtime
                .volume_cache
                .keys()
                .any(|key| key.session_id == session_id),
            "cache should be cleared for closed dataset session"
        );
    }

    #[tokio::test]
    async fn inspect_includes_camera_and_image_render_settings() {
        let daemon = Daemon::new();

        let (create_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: None,
                request_id: "req-create".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id")
            .to_string();

        let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/ome_zarr_v05_structured_3d");
        let (open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-open".to_string(),
                method: "dataset.open".to_string(),
                params: json!({"uri": fixture_path.display().to_string(), "read_only": true}),
                timestamp: now_utc(),
            })
            .await;
        assert!(open_response.error.is_none());

        let (add_layer_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-add-layer".to_string(),
                method: "layer.add_image".to_string(),
                params: json!({"layer_id":"image-1","channel":0}),
                timestamp: now_utc(),
            })
            .await;
        assert!(add_layer_response.error.is_none());

        let (set_sampling_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-sampling".to_string(),
                method: "layer.set_sampling".to_string(),
                params: json!({"layer_id":"image-1","sampling_mode":"linear"}),
                timestamp: now_utc(),
            })
            .await;
        assert!(set_sampling_response.error.is_none());

        let (set_contrast_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-contrast".to_string(),
                method: "layer.set_contrast_limits".to_string(),
                params: json!({"layer_id":"image-1","min":128,"max":8192}),
                timestamp: now_utc(),
            })
            .await;
        assert!(set_contrast_response.error.is_none());

        let (inspect_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id),
                request_id: "req-inspect".to_string(),
                method: "session.inspect".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let inspect = inspect_response.result.expect("inspect result");
        assert_eq!(inspect["camera"]["mode"], json!("pan_zoom"));
        let image_layer = inspect["layers"]
            .as_array()
            .expect("layers array")
            .iter()
            .find(|layer| layer["id"] == json!("image-1"))
            .expect("image-1 layer exists");
        assert_eq!(
            image_layer["kind"]["render_state"]["sampling_mode"],
            json!("linear")
        );
        assert_eq!(
            image_layer["kind"]["render_state"]["contrast_limits"],
            json!([128, 8192])
        );
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

        let fixture_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/ome_zarr_v05_min");
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
        assert!(
            layer_response.error.is_none(),
            "layer.add_image should succeed"
        );

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
        let frame_open_result = frame_open_response
            .result
            .expect("frame.channel.open result");
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
    async fn frame_requests_change_with_render_mode_and_stay_deterministic() {
        let daemon = Daemon::new();

        let (create_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: None,
                request_id: "req-create".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id")
            .to_string();

        let fixture_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/ome_zarr_v05_min");
        let (open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-open".to_string(),
                method: "dataset.open".to_string(),
                params: json!({"uri": fixture_path.display().to_string(), "read_only": true}),
                timestamp: now_utc(),
            })
            .await;
        assert!(open_response.error.is_none());

        let (layer_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-layer".to_string(),
                method: "layer.add_image".to_string(),
                params: json!({"layer_id":"image-1","channel":0}),
                timestamp: now_utc(),
            })
            .await;
        assert!(layer_response.error.is_none());

        let (frame_open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-frame-open".to_string(),
                method: "frame.channel.open".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let frame_open_result = frame_open_response
            .result
            .expect("frame.channel.open result");
        let channel_token = frame_open_result["channel_token"]
            .as_str()
            .expect("channel token")
            .to_string();

        let request_frame = |request_id: &str,
                             axis: FrameAxisIndices,
                             channel_token: String,
                             session_id: String| FrameRequestHeader {
            frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
            request_id: request_id.to_string(),
            channel_token,
            session_id,
            axis_indices: axis,
            viewport: lucida_protocol::FrameViewport {
                width: 64,
                height: 48,
            },
        };

        let (frame_2d_header, frame_2d_payload) = daemon
            .process_frame_request(request_frame(
                "frame-2d",
                FrameAxisIndices { t: 0, c: 0, z: 1 },
                channel_token.clone(),
                session_id.clone(),
            ))
            .await;
        assert_eq!(frame_2d_header.status, "ok");

        let (camera_pose_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-panzoom-zoom".to_string(),
                method: "camera.set_pose".to_string(),
                params: json!({"pose":{"center":[0.0,0.0],"zoom":2.0}}),
                timestamp: now_utc(),
            })
            .await;
        assert!(camera_pose_response.error.is_none());

        let (frame_2d_zoom_header, frame_2d_zoom_payload) = daemon
            .process_frame_request(request_frame(
                "frame-2d-zoom",
                FrameAxisIndices { t: 0, c: 0, z: 1 },
                channel_token.clone(),
                session_id.clone(),
            ))
            .await;
        assert_eq!(frame_2d_zoom_header.status, "ok");
        assert_eq!(frame_2d_payload, frame_2d_zoom_payload);

        let (mode_2d_stub_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-mode-2d-stub".to_string(),
                method: "view.set_render_mode".to_string(),
                params: json!({"mode":"2d_stub"}),
                timestamp: now_utc(),
            })
            .await;
        assert!(mode_2d_stub_response.error.is_none());

        let (frame_2d_stub_header_a, frame_2d_stub_payload_a) = daemon
            .process_frame_request(request_frame(
                "frame-2d-stub-a",
                FrameAxisIndices { t: 0, c: 0, z: 1 },
                channel_token.clone(),
                session_id.clone(),
            ))
            .await;
        let (frame_2d_stub_header_b, frame_2d_stub_payload_b) = daemon
            .process_frame_request(request_frame(
                "frame-2d-stub-b",
                FrameAxisIndices { t: 0, c: 0, z: 3 },
                channel_token.clone(),
                session_id.clone(),
            ))
            .await;
        assert_eq!(frame_2d_stub_header_a.status, "ok");
        assert_eq!(frame_2d_stub_header_b.status, "ok");
        assert_ne!(frame_2d_stub_payload_a, frame_2d_stub_payload_b);
        assert_ne!(frame_2d_payload, frame_2d_stub_payload_a);

        let (mode_3d_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-mode-3d".to_string(),
                method: "view.set_render_mode".to_string(),
                params: json!({"mode":"3d"}),
                timestamp: now_utc(),
            })
            .await;
        assert!(mode_3d_response.error.is_none());

        let (inspect_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-inspect".to_string(),
                method: "session.inspect".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let inspect = inspect_response.result.expect("session.inspect result");
        assert_eq!(inspect["render_mode"], json!("3d"));

        let (frame_3d_header_a, frame_3d_payload_a) = daemon
            .process_frame_request(request_frame(
                "frame-3d-a",
                FrameAxisIndices { t: 0, c: 0, z: 2 },
                channel_token.clone(),
                session_id.clone(),
            ))
            .await;
        let (frame_3d_header_b, frame_3d_payload_b) = daemon
            .process_frame_request(request_frame(
                "frame-3d-b",
                FrameAxisIndices { t: 0, c: 0, z: 2 },
                channel_token.clone(),
                session_id.clone(),
            ))
            .await;
        assert_eq!(frame_3d_header_a.status, "ok");
        assert_eq!(frame_3d_header_b.status, "ok");
        assert_eq!(frame_3d_payload_a, frame_3d_payload_b);
        assert_ne!(frame_2d_payload, frame_3d_payload_a);

        let (set_3d_contrast_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-set-3d-contrast".to_string(),
                method: "layer.set_contrast_limits".to_string(),
                params: json!({"layer_id":"image-1","min":32000,"max":40000}),
                timestamp: now_utc(),
            })
            .await;
        assert!(set_3d_contrast_response.error.is_none());

        let (frame_3d_header_contrast, frame_3d_payload_contrast) = daemon
            .process_frame_request(request_frame(
                "frame-3d-contrast",
                FrameAxisIndices { t: 0, c: 0, z: 2 },
                channel_token.clone(),
                session_id.clone(),
            ))
            .await;
        assert_eq!(frame_3d_header_contrast.status, "ok");
        assert_eq!(frame_3d_payload_contrast, frame_3d_payload_a);

        let (frame_3d_large_header, frame_3d_large_payload) = daemon
            .process_frame_request(FrameRequestHeader {
                frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
                request_id: "frame-3d-large".to_string(),
                channel_token: channel_token.clone(),
                session_id: session_id.clone(),
                axis_indices: FrameAxisIndices { t: 0, c: 0, z: 2 },
                viewport: lucida_protocol::FrameViewport {
                    width: 96,
                    height: 72,
                },
            })
            .await;
        assert_eq!(frame_3d_large_header.status, "ok");
        assert_eq!(frame_3d_large_header.width, 96);
        assert_eq!(frame_3d_large_header.height, 72);
        assert_eq!(frame_3d_large_payload.len(), 96 * 72 * 2);
        assert_ne!(frame_3d_large_payload, frame_3d_payload_a);

        let (camera_mode_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-camera-freefly".to_string(),
                method: "camera.set_mode".to_string(),
                params: json!({"mode":"freefly"}),
                timestamp: now_utc(),
            })
            .await;
        assert!(camera_mode_response.error.is_none());

        let (camera_pose_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-camera-pose".to_string(),
                method: "camera.set_pose".to_string(),
                params: json!({
                    "pose": {
                        "position": [1.0, -2.0, 4.5],
                        "yaw_pitch_roll": [0.4, -0.2, 0.1],
                        "speed": 1.5
                    }
                }),
                timestamp: now_utc(),
            })
            .await;
        assert!(camera_pose_response.error.is_none());

        let (frame_3d_header_c, frame_3d_payload_c) = daemon
            .process_frame_request(request_frame(
                "frame-3d-c",
                FrameAxisIndices { t: 0, c: 0, z: 2 },
                channel_token.clone(),
                session_id.clone(),
            ))
            .await;
        assert_eq!(frame_3d_header_c.status, "ok");
        assert_ne!(frame_3d_payload_c, frame_3d_payload_a);

        let (mode_graph_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-mode-graph".to_string(),
                method: "view.set_render_mode".to_string(),
                params: json!({"mode":"graph_stub"}),
                timestamp: now_utc(),
            })
            .await;
        assert!(mode_graph_response.error.is_none());

        let (frame_graph_header, frame_graph_payload) = daemon
            .process_frame_request(request_frame(
                "frame-graph",
                FrameAxisIndices { t: 0, c: 0, z: 2 },
                channel_token,
                session_id,
            ))
            .await;
        assert_eq!(frame_graph_header.status, "ok");
        assert_ne!(frame_graph_payload, frame_3d_payload_a);
    }

    #[tokio::test]
    async fn three_d_perf_reports_brick_skip_metrics() {
        let daemon = Daemon::new();
        let (create_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: None,
                request_id: "req-create".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id")
            .to_string();

        let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/ome_zarr_v05_structured_3d");
        let (open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-open".to_string(),
                method: "dataset.open".to_string(),
                params: json!({"uri": fixture_path.display().to_string(), "read_only": true}),
                timestamp: now_utc(),
            })
            .await;
        assert!(open_response.error.is_none());

        let (layer_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-layer".to_string(),
                method: "layer.add_image".to_string(),
                params: json!({"layer_id":"image-1","channel":0}),
                timestamp: now_utc(),
            })
            .await;
        assert!(layer_response.error.is_none());

        let (mode_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-mode".to_string(),
                method: "view.set_render_mode".to_string(),
                params: json!({"mode":"3d"}),
                timestamp: now_utc(),
            })
            .await;
        assert!(mode_response.error.is_none());

        let (frame_open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-frame-open".to_string(),
                method: "frame.channel.open".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let frame_open_result = frame_open_response
            .result
            .expect("frame.channel.open result");
        let channel_token = frame_open_result["channel_token"]
            .as_str()
            .expect("channel token")
            .to_string();
        let request = FrameRequestHeader {
            frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
            request_id: "frame-3d-perf".to_string(),
            channel_token,
            session_id,
            axis_indices: FrameAxisIndices { t: 0, c: 0, z: 0 },
            viewport: lucida_protocol::FrameViewport {
                width: 64,
                height: 48,
            },
        };
        let (header, _payload, perf) = daemon.process_frame_request_with_metrics(request).await;
        assert_eq!(header.status, "ok");
        let perf = perf.expect("3d perf metrics");
        assert!(perf.sample_count > 0);
        assert!(perf.bricks_traversed > 0);
        assert!(perf.bricks_sampled > 0);
        assert!(perf.bricks_sampled <= perf.bricks_traversed);
        assert!(perf.samples_taken > 0);
        assert!((0.0..=1.0).contains(&perf.skip_ratio));
        assert!(perf.raymarch_parallel);
        assert!(perf.raymarch_workers > 0);
        assert_eq!(perf.rows_parallelized, header.height);

        let theoretical_full_samples =
            perf.sample_count as u64 * header.width as u64 * header.height as u64;
        assert!(perf.samples_taken < theoretical_full_samples);
    }

    #[tokio::test]
    async fn dataset_open_with_axis_remap_surfaces_normalized_layout() {
        let daemon = Daemon::new();
        let (create_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: None,
                request_id: "req-create".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id")
            .to_string();

        let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/ome_zarr_v05_axis_remap");
        let (open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id),
                request_id: "req-open".to_string(),
                method: "dataset.open".to_string(),
                params: json!({
                    "uri": fixture_path.display().to_string(),
                    "read_only": true,
                    "axis_map": {"channel": "c"}
                }),
                timestamp: now_utc(),
            })
            .await;

        assert!(open_response.error.is_none(), "dataset.open should succeed");
        let result = open_response.result.expect("dataset.open result");
        let metadata = &result["dataset"]["multiscale_metadata"];
        assert_eq!(metadata["layout_version"], json!(1));
        assert_eq!(metadata["canonical_to_source_dim"]["z"], json!(0));
        assert_eq!(metadata["canonical_to_source_dim"]["c"], json!(3));
        assert_eq!(metadata["implicit_singleton_axes"], json!(["t"]));
        assert_eq!(metadata["spatial_scale_zyx"], json!([1.8, 0.5, 0.5]));
    }

    #[tokio::test]
    async fn ome_zarr_v04_smoke_opens_and_reads_frame() {
        let daemon = Daemon::new();
        let (create_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: None,
                request_id: "req-create".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id")
            .to_string();

        let fixture_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/ome_zarr_v04_smoke");
        let (open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-open".to_string(),
                method: "dataset.open".to_string(),
                params: json!({"uri": fixture_path.display().to_string(), "read_only": true}),
                timestamp: now_utc(),
            })
            .await;
        assert!(open_response.error.is_none(), "dataset.open should succeed");
        let result = open_response.result.expect("dataset.open result");
        assert_eq!(
            result["dataset"]["multiscale_metadata"]["compatibility_mode"],
            json!("best_effort_0_4")
        );

        let (layer_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-layer".to_string(),
                method: "layer.add_image".to_string(),
                params: json!({"layer_id":"image-1","channel":0}),
                timestamp: now_utc(),
            })
            .await;
        assert!(layer_response.error.is_none());

        let (frame_open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-frame-open".to_string(),
                method: "frame.channel.open".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let frame_open_result = frame_open_response
            .result
            .expect("frame.channel.open result");
        let channel_token = frame_open_result["channel_token"]
            .as_str()
            .expect("channel token")
            .to_string();

        let (header, payload) = daemon
            .process_frame_request(FrameRequestHeader {
                frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
                request_id: "frame-v04".to_string(),
                channel_token,
                session_id,
                axis_indices: FrameAxisIndices { t: 0, c: 0, z: 2 },
                viewport: lucida_protocol::FrameViewport {
                    width: 64,
                    height: 64,
                },
            })
            .await;
        assert_eq!(header.status, "ok");
        assert_eq!(header.width, 16);
        assert_eq!(header.height, 16);
        assert_eq!(payload.len(), 16 * 16 * 2);
        let first = u16::from_le_bytes([payload[0], payload[1]]);
        assert_eq!(first, 3000);
    }

    #[tokio::test]
    async fn unsupported_ome_zarr_v04_ambiguity_returns_explicit_error() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(
            temp_dir.path().join(".zattrs"),
            r#"{"multiscales":[{"version":"0.4","datasets":[{"path":"0"}]}]}"#,
        )
        .expect("write root attrs");
        std::fs::create_dir_all(temp_dir.path().join("0")).expect("create array dir");
        std::fs::write(
            temp_dir.path().join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [4,8,8],
                "chunks": [1,8,8],
                "dtype": "<u2",
                "compressor": null,
                "dimension_separator": "/"
            }"#,
        )
        .expect("write zarray");

        let daemon = Daemon::new();
        let (create_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: None,
                request_id: "req-create".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id")
            .to_string();

        let (open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id),
                request_id: "req-open".to_string(),
                method: "dataset.open".to_string(),
                params: json!({"uri": temp_dir.path().display().to_string(), "read_only": true}),
                timestamp: now_utc(),
            })
            .await;
        let error = open_response.error.expect("expected error");
        assert!(error.message.contains("ambiguous axis metadata"));
    }

    #[tokio::test]
    async fn anisotropic_fixture_changes_three_d_payload_vs_isotropic() {
        let daemon = Daemon::new();

        async fn open_three_d_session(
            daemon: &Daemon,
            fixture: PathBuf,
            session_suffix: &str,
        ) -> (String, String) {
            let (create_response, _) = daemon
                .process_request(RpcRequestEnvelope {
                    jsonrpc: "2.0".to_string(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    session_id: None,
                    request_id: format!("req-create-{session_suffix}"),
                    method: "session.create".to_string(),
                    params: json!({}),
                    timestamp: now_utc(),
                })
                .await;
            let session_id = create_response.result.expect("session.create result")["session_id"]
                .as_str()
                .expect("session id")
                .to_string();

            let (open_response, _) = daemon
                .process_request(RpcRequestEnvelope {
                    jsonrpc: "2.0".to_string(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    session_id: Some(session_id.clone()),
                    request_id: format!("req-open-{session_suffix}"),
                    method: "dataset.open".to_string(),
                    params: json!({"uri": fixture.display().to_string(), "read_only": true}),
                    timestamp: now_utc(),
                })
                .await;
            assert!(open_response.error.is_none());

            let (layer_response, _) = daemon
                .process_request(RpcRequestEnvelope {
                    jsonrpc: "2.0".to_string(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    session_id: Some(session_id.clone()),
                    request_id: format!("req-layer-{session_suffix}"),
                    method: "layer.add_image".to_string(),
                    params: json!({"layer_id":"image-1","channel":0}),
                    timestamp: now_utc(),
                })
                .await;
            assert!(layer_response.error.is_none());

            let (mode_response, _) = daemon
                .process_request(RpcRequestEnvelope {
                    jsonrpc: "2.0".to_string(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    session_id: Some(session_id.clone()),
                    request_id: format!("req-mode-{session_suffix}"),
                    method: "view.set_render_mode".to_string(),
                    params: json!({"mode":"3d"}),
                    timestamp: now_utc(),
                })
                .await;
            assert!(mode_response.error.is_none());

            let (camera_mode_response, _) = daemon
                .process_request(RpcRequestEnvelope {
                    jsonrpc: "2.0".to_string(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    session_id: Some(session_id.clone()),
                    request_id: format!("req-camera-mode-{session_suffix}"),
                    method: "camera.set_mode".to_string(),
                    params: json!({"mode":"freefly"}),
                    timestamp: now_utc(),
                })
                .await;
            assert!(camera_mode_response.error.is_none());

            let (camera_pose_response, _) = daemon
                .process_request(RpcRequestEnvelope {
                    jsonrpc: "2.0".to_string(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    session_id: Some(session_id.clone()),
                    request_id: format!("req-camera-pose-{session_suffix}"),
                    method: "camera.set_pose".to_string(),
                    params: json!({"pose":{"position":[0.0,0.0,3.2],"yaw_pitch_roll":[0.0,0.0,0.0],"speed":1.5}}),
                    timestamp: now_utc(),
                })
                .await;
            assert!(camera_pose_response.error.is_none());

            let (frame_open_response, _) = daemon
                .process_request(RpcRequestEnvelope {
                    jsonrpc: "2.0".to_string(),
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    session_id: Some(session_id.clone()),
                    request_id: format!("req-frame-open-{session_suffix}"),
                    method: "frame.channel.open".to_string(),
                    params: json!({}),
                    timestamp: now_utc(),
                })
                .await;
            let frame_open_result = frame_open_response
                .result
                .expect("frame.channel.open result");
            let channel_token = frame_open_result["channel_token"]
                .as_str()
                .expect("channel token")
                .to_string();
            (session_id, channel_token)
        }

        let isotropic_fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/ome_zarr_v05_isotropic_3d");
        let anisotropic_fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/ome_zarr_v05_anisotropic_3d");

        let (iso_session, iso_token) =
            open_three_d_session(&daemon, isotropic_fixture, "iso").await;
        let (aniso_session, aniso_token) =
            open_three_d_session(&daemon, anisotropic_fixture, "aniso").await;

        let (iso_header, iso_payload) = daemon
            .process_frame_request(FrameRequestHeader {
                frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
                request_id: "frame-iso".to_string(),
                channel_token: iso_token,
                session_id: iso_session,
                axis_indices: FrameAxisIndices { t: 0, c: 0, z: 0 },
                viewport: lucida_protocol::FrameViewport {
                    width: 96,
                    height: 72,
                },
            })
            .await;
        let (aniso_header, aniso_payload) = daemon
            .process_frame_request(FrameRequestHeader {
                frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
                request_id: "frame-aniso".to_string(),
                channel_token: aniso_token,
                session_id: aniso_session,
                axis_indices: FrameAxisIndices { t: 0, c: 0, z: 0 },
                viewport: lucida_protocol::FrameViewport {
                    width: 96,
                    height: 72,
                },
            })
            .await;

        assert_eq!(iso_header.status, "ok");
        assert_eq!(aniso_header.status, "ok");
        assert_ne!(iso_payload, aniso_payload);
    }

    #[tokio::test]
    async fn three_d_payload_changes_across_t_and_c_axes() {
        let daemon = Daemon::new();
        let (create_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: None,
                request_id: "req-create".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let session_id = create_response.result.expect("session.create result")["session_id"]
            .as_str()
            .expect("session id")
            .to_string();

        let fixture_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/ome_zarr_v05_tc_3d");
        let (open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-open".to_string(),
                method: "dataset.open".to_string(),
                params: json!({"uri": fixture_path.display().to_string(), "read_only": true}),
                timestamp: now_utc(),
            })
            .await;
        assert!(open_response.error.is_none());

        let (layer_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-layer".to_string(),
                method: "layer.add_image".to_string(),
                params: json!({"layer_id":"image-1"}),
                timestamp: now_utc(),
            })
            .await;
        assert!(layer_response.error.is_none());

        let (mode_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-mode".to_string(),
                method: "view.set_render_mode".to_string(),
                params: json!({"mode":"3d"}),
                timestamp: now_utc(),
            })
            .await;
        assert!(mode_response.error.is_none());

        let (camera_mode_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-camera-mode".to_string(),
                method: "camera.set_mode".to_string(),
                params: json!({"mode":"freefly"}),
                timestamp: now_utc(),
            })
            .await;
        assert!(camera_mode_response.error.is_none());

        let (camera_pose_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-camera-pose".to_string(),
                method: "camera.set_pose".to_string(),
                params: json!({"pose":{"position":[0.0,0.0,3.2],"yaw_pitch_roll":[0.0,0.0,0.0],"speed":1.5}}),
                timestamp: now_utc(),
            })
            .await;
        assert!(camera_pose_response.error.is_none());

        let (frame_open_response, _) = daemon
            .process_request(RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: PROTOCOL_VERSION.to_string(),
                session_id: Some(session_id.clone()),
                request_id: "req-frame-open".to_string(),
                method: "frame.channel.open".to_string(),
                params: json!({}),
                timestamp: now_utc(),
            })
            .await;
        let frame_open_result = frame_open_response
            .result
            .expect("frame.channel.open result");
        let channel_token = frame_open_result["channel_token"]
            .as_str()
            .expect("channel token")
            .to_string();

        let request = |request_id: &str, t: usize, c: usize| FrameRequestHeader {
            frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
            request_id: request_id.to_string(),
            channel_token: channel_token.clone(),
            session_id: session_id.clone(),
            axis_indices: FrameAxisIndices { t, c, z: 12 },
            viewport: lucida_protocol::FrameViewport {
                width: 96,
                height: 72,
            },
        };

        let (header_a, payload_a) = daemon.process_frame_request(request("frame-a", 0, 0)).await;
        let (header_b, payload_b) = daemon.process_frame_request(request("frame-b", 1, 0)).await;
        let (header_c, payload_c) = daemon.process_frame_request(request("frame-c", 1, 2)).await;
        assert_eq!(header_a.status, "ok");
        assert_eq!(header_b.status, "ok");
        assert_eq!(header_c.status, "ok");
        assert_ne!(payload_a, payload_b);
        assert_ne!(payload_b, payload_c);
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
        assert!(header
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("invalid frame channel token"));
    }
}
