use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use lucida_protocol::{
    now_utc, AxisLabel, CameraState2D, CameraStateArcball, CameraStateFreefly, DatasetHandle,
    EventEnvelope, ImageRenderState, RenderMode, ReplayEntry, RpcError, RpcRequestEnvelope,
    SamplingMode, Transform,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("missing required session_id for method {0}")]
    MissingSession(String),
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("invalid params: {0}")]
    InvalidParams(String),
    #[error("unknown method: {0}")]
    UnknownMethod(String),
    #[error("serialization error: {0}")]
    Serialization(String),
}

impl CoreError {
    pub fn to_rpc_error(&self) -> RpcError {
        RpcError {
            code: -32602,
            message: self.to_string(),
            data: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppState {
    pub sessions: BTreeMap<String, SessionState>,
    pub session_counter: u64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: BTreeMap::new(),
            session_counter: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionState {
    pub id: String,
    pub dataset: Option<DatasetHandle>,
    pub layers: BTreeMap<String, LayerState>,
    pub view: ViewState,
    pub camera: CameraMode,
    pub render_mode: RenderMode,
}

impl SessionState {
    fn new(id: String) -> Self {
        Self {
            id,
            dataset: None,
            layers: BTreeMap::new(),
            view: ViewState::default(),
            camera: CameraMode::PanZoom(CameraState2D {
                center: [0.0, 0.0],
                zoom: 1.0,
            }),
            render_mode: RenderMode::TwoD,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LayerState {
    pub id: String,
    pub kind: LayerKind,
    pub visible: bool,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LayerKind {
    Image {
        dataset_id: Option<String>,
        channel: Option<usize>,
        #[serde(default)]
        render_state: ImageRenderState,
    },
    Points {
        points_count: usize,
        color_by: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ViewState {
    pub axis_indices: BTreeMap<String, usize>,
    pub axis_order: Vec<String>,
    pub channel_order: Vec<usize>,
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            axis_indices: BTreeMap::new(),
            axis_order: vec!["t".to_string(), "c".to_string(), "z".to_string(), "y".to_string(), "x".to_string()],
            channel_order: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum CameraMode {
    PanZoom(CameraState2D),
    Arcball(CameraStateArcball),
    Freefly(CameraStateFreefly),
}

#[derive(Clone, Debug)]
pub struct ReducerOutcome {
    pub result: Value,
    pub replay_entry: Option<ReplayEntry>,
    pub emitted_events: Vec<EventEnvelope>,
}

pub fn remap_axes(
    source_order: &[String],
    axis_map: &BTreeMap<String, String>,
) -> Result<Vec<AxisLabel>, CoreError> {
    let mut seen = BTreeSet::new();
    let mut remapped = Vec::with_capacity(source_order.len());

    for source in source_order {
        let mapped = axis_map
            .get(source)
            .cloned()
            .unwrap_or_else(|| source.clone());

        if !seen.insert(mapped.clone()) {
            return Err(CoreError::InvalidParams(format!(
                "axis remap produces duplicate label: {mapped}"
            )));
        }

        remapped.push(AxisLabel::canonical(&mapped));
    }

    Ok(remapped)
}

pub fn transform_point(transform: &Transform, point: &[f64]) -> Result<Vec<f64>, CoreError> {
    if transform.scale.len() != point.len() || transform.translate.len() != point.len() {
        return Err(CoreError::InvalidParams(
            "transform dimensions must match point dimensions".to_string(),
        ));
    }

    Ok(point
        .iter()
        .enumerate()
        .map(|(idx, value)| value * transform.scale[idx] + transform.translate[idx])
        .collect())
}

pub fn state_hash(state: &AppState) -> Result<String, CoreError> {
    let serialized = serde_json::to_vec(state)
        .map_err(|err| CoreError::Serialization(format!("unable to serialize state: {err}")))?;
    let digest = Sha256::digest(serialized);
    Ok(format!("{digest:x}"))
}

fn mutating_method(method: &str) -> bool {
    matches!(
        method,
        "session.create"
            | "session.close"
            | "dataset.open"
            | "dataset.close"
            | "layer.add_image"
            | "layer.add_points"
            | "layer.update"
            | "layer.set_sampling"
            | "layer.set_contrast_limits"
            | "layer.auto_contrast"
            | "layer.remove"
            | "view.set_axis"
            | "view.reorder_axes"
            | "view.set_channel_order"
            | "view.set_render_mode"
            | "camera.set_mode"
            | "camera.set_pose"
    )
}

fn require_session_id<'a>(request: &'a RpcRequestEnvelope) -> Result<&'a str, CoreError> {
    request
        .session_id
        .as_deref()
        .ok_or_else(|| CoreError::MissingSession(request.method.clone()))
}

fn get_session_mut<'a>(
    state: &'a mut AppState,
    request: &RpcRequestEnvelope,
) -> Result<&'a mut SessionState, CoreError> {
    let session_id = require_session_id(request)?;
    state
        .sessions
        .get_mut(session_id)
        .ok_or_else(|| CoreError::SessionNotFound(session_id.to_string()))
}

pub fn apply_command(
    state: &mut AppState,
    request: &RpcRequestEnvelope,
) -> Result<ReducerOutcome, CoreError> {
    let mut emitted_events = Vec::new();

    let result = match request.method.as_str() {
        "server.capabilities" => json!({
            "protocol_version": request.protocol_version,
            "events": ["state.changed", "perf.frame", "error.raised", "selection.changed"],
            "modes": ["panzoom", "arcball", "freefly"],
            "render_modes": ["2d", "2d_stub", "3d", "graph_stub"],
            "sampling_modes": ["nearest", "linear"],
            "transports": ["ipc"],
            "storage": ["file"]
        }),
        "health.ping" => json!({"status": "ok"}),
        "session.create" => {
            state.session_counter += 1;
            let session_id = format!("session-{}", state.session_counter);
            state
                .sessions
                .insert(session_id.clone(), SessionState::new(session_id.clone()));
            json!({"session_id": session_id})
        }
        "session.close" => {
            let session_id = require_session_id(request)?;
            state.sessions.remove(session_id);
            json!({"closed": session_id})
        }
        "dataset.open" => {
            let session = get_session_mut(state, request)?;
            let handle_value = request
                .params
                .get("dataset_handle")
                .cloned()
                .ok_or_else(|| CoreError::InvalidParams("dataset_handle is required".to_string()))?;
            let handle: DatasetHandle = serde_json::from_value(handle_value)
                .map_err(|err| CoreError::InvalidParams(format!("invalid dataset_handle: {err}")))?;
            session.dataset = Some(handle.clone());
            json!({"dataset": handle})
        }
        "dataset.close" => {
            let session = get_session_mut(state, request)?;
            session.dataset = None;
            json!({"closed": true})
        }
        "layer.add_image" => {
            let session = get_session_mut(state, request)?;
            let layer_id = request
                .params
                .get("layer_id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("layer-{}", Uuid::new_v4()));
            let channel = request
                .params
                .get("channel")
                .and_then(Value::as_u64)
                .map(|value| value as usize);
            let dataset_id = session.dataset.as_ref().map(|dataset| dataset.id.clone());
            let layer = LayerState {
                id: layer_id.clone(),
                kind: LayerKind::Image {
                    dataset_id,
                    channel,
                    render_state: ImageRenderState::default(),
                },
                visible: true,
                metadata: request
                    .params
                    .get("metadata")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            };
            session.layers.insert(layer_id.clone(), layer);
            json!({"layer_id": layer_id})
        }
        "layer.add_points" => {
            let session = get_session_mut(state, request)?;
            let layer_id = request
                .params
                .get("layer_id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("layer-{}", Uuid::new_v4()));
            let positions = request
                .params
                .get("positions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let color_by = request
                .params
                .get("color_by")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let layer = LayerState {
                id: layer_id.clone(),
                kind: LayerKind::Points {
                    points_count: positions.len(),
                    color_by,
                },
                visible: true,
                metadata: request
                    .params
                    .get("metadata")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            };
            session.layers.insert(layer_id.clone(), layer);
            emitted_events.push(EventEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: request.protocol_version.clone(),
                session_id: request.session_id.clone(),
                event: "selection.changed".to_string(),
                payload: json!({"selection": [], "reason": "points_layer_added"}),
                timestamp: now_utc(),
            });
            json!({"layer_id": layer_id})
        }
        "layer.update" => {
            let session = get_session_mut(state, request)?;
            let layer_id = request
                .params
                .get("layer_id")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::InvalidParams("layer_id is required".to_string()))?;
            let layer = session
                .layers
                .get_mut(layer_id)
                .ok_or_else(|| CoreError::InvalidParams(format!("unknown layer_id: {layer_id}")))?;
            if let Some(visible) = request.params.get("visible").and_then(Value::as_bool) {
                layer.visible = visible;
            }
            if let Some(metadata) = request.params.get("metadata") {
                layer.metadata = metadata.clone();
            }
            json!({"updated": layer_id})
        }
        "layer.set_sampling" => {
            let session = get_session_mut(state, request)?;
            let layer_id = request
                .params
                .get("layer_id")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::InvalidParams("layer_id is required".to_string()))?;
            let sampling_mode = request
                .params
                .get("sampling_mode")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::InvalidParams("sampling_mode is required".to_string()))?;
            let sampling_mode = parse_sampling_mode(sampling_mode)?;
            let render_state = image_layer_render_state_mut(session, layer_id)?;
            render_state.sampling_mode = sampling_mode;
            json!({
                "layer_id": layer_id,
                "sampling_mode": sampling_mode.as_str(),
            })
        }
        "layer.set_contrast_limits" => {
            let session = get_session_mut(state, request)?;
            let layer_id = request
                .params
                .get("layer_id")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::InvalidParams("layer_id is required".to_string()))?;
            let min = request
                .params
                .get("min")
                .and_then(Value::as_u64)
                .ok_or_else(|| CoreError::InvalidParams("min is required".to_string()))?;
            let max = request
                .params
                .get("max")
                .and_then(Value::as_u64)
                .ok_or_else(|| CoreError::InvalidParams("max is required".to_string()))?;
            let contrast_limits = parse_contrast_limits(min, max)?;
            let render_state = image_layer_render_state_mut(session, layer_id)?;
            render_state.contrast_limits = contrast_limits;
            json!({
                "layer_id": layer_id,
                "contrast_limits": contrast_limits,
            })
        }
        "layer.auto_contrast" => {
            let session = get_session_mut(state, request)?;
            let layer_id = request
                .params
                .get("layer_id")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::InvalidParams("layer_id is required".to_string()))?;
            let min = request
                .params
                .get("min")
                .and_then(Value::as_u64)
                .ok_or_else(|| CoreError::InvalidParams("min is required".to_string()))?;
            let max = request
                .params
                .get("max")
                .and_then(Value::as_u64)
                .ok_or_else(|| CoreError::InvalidParams("max is required".to_string()))?;
            let method = request
                .params
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("robust_percentile_1_99");
            let contrast_limits = parse_contrast_limits(min, max)?;
            let render_state = image_layer_render_state_mut(session, layer_id)?;
            render_state.contrast_limits = contrast_limits;
            json!({
                "layer_id": layer_id,
                "method": method,
                "contrast_limits": contrast_limits,
            })
        }
        "layer.remove" => {
            let session = get_session_mut(state, request)?;
            let layer_id = request
                .params
                .get("layer_id")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::InvalidParams("layer_id is required".to_string()))?;
            session.layers.remove(layer_id);
            json!({"removed": layer_id})
        }
        "view.set_axis" => {
            let session = get_session_mut(state, request)?;
            let axis = request
                .params
                .get("axis")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::InvalidParams("axis is required".to_string()))?;
            let index = request
                .params
                .get("index")
                .and_then(Value::as_u64)
                .ok_or_else(|| CoreError::InvalidParams("index is required".to_string()))?
                as usize;
            session.view.axis_indices.insert(axis.to_string(), index);
            json!({"axis": axis, "index": index})
        }
        "view.reorder_axes" => {
            let session = get_session_mut(state, request)?;
            let order = request
                .params
                .get("order")
                .and_then(Value::as_array)
                .ok_or_else(|| CoreError::InvalidParams("order is required".to_string()))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(ToString::to_string)
                        .ok_or_else(|| CoreError::InvalidParams("order entries must be strings".to_string()))
                })
                .collect::<Result<Vec<String>, CoreError>>()?;
            session.view.axis_order = order.clone();
            json!({"order": order})
        }
        "view.set_channel_order" => {
            let session = get_session_mut(state, request)?;
            let order = request
                .params
                .get("order")
                .and_then(Value::as_array)
                .ok_or_else(|| CoreError::InvalidParams("order is required".to_string()))?
                .iter()
                .map(|value| {
                    value.as_u64().map(|item| item as usize).ok_or_else(|| {
                        CoreError::InvalidParams("order entries must be integers".to_string())
                    })
                })
                .collect::<Result<Vec<usize>, CoreError>>()?;
            session.view.channel_order = order.clone();
            json!({"order": order})
        }
        "view.set_render_mode" => {
            let session = get_session_mut(state, request)?;
            let mode_value = request
                .params
                .get("mode")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::InvalidParams("mode is required".to_string()))?;
            let requested_mode = parse_render_mode(mode_value)?;
            let (applied_mode, fallback_reason) = if requested_mode == RenderMode::ThreeD
                && !session_can_render_real_3d(session)
            {
                (
                    RenderMode::TwoD,
                    Some("missing dataset or visible image layer".to_string()),
                )
            } else {
                (requested_mode, None)
            };
            session.render_mode = applied_mode;
            json!({
                "mode": applied_mode.as_str(),
                "requested_mode": requested_mode.as_str(),
                "fallback_reason": fallback_reason,
            })
        }
        "camera.set_mode" => {
            let session = get_session_mut(state, request)?;
            let mode = request
                .params
                .get("mode")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::InvalidParams("mode is required".to_string()))?;
            session.camera = next_camera_mode(mode)?;
            json!({"mode": mode})
        }
        "camera.set_pose" => {
            let session = get_session_mut(state, request)?;
            let pose = request
                .params
                .get("pose")
                .ok_or_else(|| CoreError::InvalidParams("pose is required".to_string()))?
                .clone();
            session.camera = apply_pose(&session.camera, pose)?;
            json!({"updated": true})
        }
        "events.subscribe" => {
            json!({"subscribed": ["state.changed", "perf.frame", "error.raised", "selection.changed"]})
        }
        other => return Err(CoreError::UnknownMethod(other.to_string())),
    };

    if mutating_method(&request.method) {
        let render_mode = request
            .session_id
            .as_deref()
            .and_then(|session_id| state.sessions.get(session_id))
            .map(|session| session.render_mode.as_str().to_string());
        emitted_events.push(EventEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: request.protocol_version.clone(),
            session_id: request.session_id.clone(),
            event: "state.changed".to_string(),
            payload: json!({
                "method": request.method,
                "request_id": request.request_id,
                "render_mode": render_mode,
            }),
            timestamp: now_utc(),
        });
    }

    let replay_entry = if mutating_method(&request.method) {
        Some(ReplayEntry {
            entry_id: request.request_id.clone(),
            session_id: request.session_id.clone(),
            method: request.method.clone(),
            params: request.params.clone(),
            timestamp: request.timestamp,
        })
    } else {
        None
    };

    Ok(ReducerOutcome {
        result,
        replay_entry,
        emitted_events,
    })
}

pub fn replay_entries(entries: &[ReplayEntry]) -> Result<AppState, CoreError> {
    let mut replay_state = AppState::default();

    for entry in entries {
        let request = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: "0.1.0".to_string(),
            session_id: entry.session_id.clone(),
            request_id: entry.entry_id.clone(),
            method: entry.method.clone(),
            params: entry.params.clone(),
            timestamp: entry.timestamp,
        };
        apply_command(&mut replay_state, &request)?;
    }

    Ok(replay_state)
}

fn next_camera_mode(mode: &str) -> Result<CameraMode, CoreError> {
    match mode {
        "panzoom" => Ok(CameraMode::PanZoom(CameraState2D {
            center: [0.0, 0.0],
            zoom: 1.0,
        })),
        "arcball" => Ok(CameraMode::Arcball(CameraStateArcball {
            target: [0.0, 0.0, 0.0],
            distance: 5.0,
            yaw_pitch: [0.0, 0.0],
        })),
        "freefly" => Ok(CameraMode::Freefly(CameraStateFreefly {
            position: [0.0, 0.0, 5.0],
            yaw_pitch_roll: [0.0, 0.0, 0.0],
            speed: 1.0,
        })),
        _ => Err(CoreError::InvalidParams(format!(
            "unsupported camera mode: {mode}"
        ))),
    }
}

fn image_layer_render_state_mut<'a>(
    session: &'a mut SessionState,
    layer_id: &str,
) -> Result<&'a mut ImageRenderState, CoreError> {
    let layer = session
        .layers
        .get_mut(layer_id)
        .ok_or_else(|| CoreError::InvalidParams(format!("unknown layer_id: {layer_id}")))?;
    match &mut layer.kind {
        LayerKind::Image { render_state, .. } => Ok(render_state),
        _ => Err(CoreError::InvalidParams(format!(
            "layer {layer_id} is not an image layer"
        ))),
    }
}

fn parse_sampling_mode(mode: &str) -> Result<SamplingMode, CoreError> {
    match mode {
        "nearest" => Ok(SamplingMode::Nearest),
        "linear" => Ok(SamplingMode::Linear),
        _ => Err(CoreError::InvalidParams(format!(
            "unsupported sampling mode: {mode}"
        ))),
    }
}

fn parse_contrast_limits(min: u64, max: u64) -> Result<[u16; 2], CoreError> {
    if min >= max {
        return Err(CoreError::InvalidParams(
            "contrast limits must satisfy min < max".to_string(),
        ));
    }
    if max > u16::MAX as u64 {
        return Err(CoreError::InvalidParams(format!(
            "contrast limit max exceeds u16 range: {max}"
        )));
    }
    Ok([min as u16, max as u16])
}

fn parse_render_mode(mode: &str) -> Result<RenderMode, CoreError> {
    match mode {
        "2d" => Ok(RenderMode::TwoD),
        "2d_stub" => Ok(RenderMode::TwoDStub),
        "3d" => Ok(RenderMode::ThreeD),
        "graph_stub" => Ok(RenderMode::GraphStub),
        _ => Err(CoreError::InvalidParams(format!("invalid render mode: {mode}"))),
    }
}

fn session_can_render_real_3d(session: &SessionState) -> bool {
    session.dataset.is_some()
        && session.layers.values().any(|layer| {
            layer.visible
                && matches!(
                    layer.kind,
                    LayerKind::Image {
                        dataset_id: _,
                        channel: _,
                        render_state: _,
                    }
                )
        })
}

fn apply_pose(current: &CameraMode, pose: Value) -> Result<CameraMode, CoreError> {
    match current {
        CameraMode::PanZoom(_) => {
            let parsed: CameraState2D = serde_json::from_value(pose)
                .map_err(|err| CoreError::InvalidParams(format!("invalid 2d pose: {err}")))?;
            Ok(CameraMode::PanZoom(parsed))
        }
        CameraMode::Arcball(_) => {
            let parsed: CameraStateArcball = serde_json::from_value(pose)
                .map_err(|err| CoreError::InvalidParams(format!("invalid arcball pose: {err}")))?;
            Ok(CameraMode::Arcball(parsed))
        }
        CameraMode::Freefly(_) => {
            let parsed: CameraStateFreefly = serde_json::from_value(pose)
                .map_err(|err| CoreError::InvalidParams(format!("invalid freefly pose: {err}")))?;
            Ok(CameraMode::Freefly(parsed))
        }
    }
}

pub fn build_error_event(
    protocol_version: &str,
    session_id: Option<String>,
    method: &str,
    error: &RpcError,
    timestamp: DateTime<Utc>,
) -> EventEnvelope {
    EventEnvelope {
        jsonrpc: "2.0".to_string(),
        protocol_version: protocol_version.to_string(),
        session_id,
        event: "error.raised".to_string(),
        payload: json!({
            "method": method,
            "code": error.code,
            "message": error.message,
            "data": error.data,
        }),
        timestamp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axis_remap_rejects_duplicates() {
        let source = vec!["y".to_string(), "x".to_string()];
        let mut axis_map = BTreeMap::new();
        axis_map.insert("y".to_string(), "x".to_string());

        let err = remap_axes(&source, &axis_map).expect_err("duplicate remap should fail");
        assert!(err.to_string().contains("duplicate"));
    }

    #[test]
    fn transform_math_handles_scale_translate() {
        let transform = Transform {
            scale: vec![2.0, 0.5, 1.0],
            translate: vec![1.0, -1.0, 3.0],
        };
        let point = vec![4.0, 2.0, 10.0];
        let mapped = transform_point(&transform, &point).expect("transform should succeed");
        assert_eq!(mapped, vec![9.0, 0.0, 13.0]);
    }

    #[test]
    fn camera_state_transitions_roundtrip() {
        let arcball = next_camera_mode("arcball").expect("arcball mode should exist");
        assert!(matches!(arcball, CameraMode::Arcball(_)));

        let freefly = next_camera_mode("freefly").expect("freefly mode should exist");
        assert!(matches!(freefly, CameraMode::Freefly(_)));

        let panzoom = next_camera_mode("panzoom").expect("panzoom mode should exist");
        assert!(matches!(panzoom, CameraMode::PanZoom(_)));
    }

    #[test]
    fn replay_produces_identical_state_hash() {
        let mut state = AppState::default();
        let timestamp = now_utc();
        let mut replay_log = Vec::new();

        let commands = vec![
            RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: "0.1.0".to_string(),
                session_id: None,
                request_id: "req-1".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp,
            },
            RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: "0.1.0".to_string(),
                session_id: Some("session-1".to_string()),
                request_id: "req-2".to_string(),
                method: "view.set_axis".to_string(),
                params: json!({"axis": "z", "index": 3}),
                timestamp,
            },
        ];

        for command in commands {
            let outcome = apply_command(&mut state, &command).expect("command should apply");
            if let Some(entry) = outcome.replay_entry {
                replay_log.push(entry);
            }
        }

        let original_hash = state_hash(&state).expect("hash current state");
        let replayed = replay_entries(&replay_log).expect("replay should succeed");
        let replayed_hash = state_hash(&replayed).expect("hash replayed state");

        assert_eq!(original_hash, replayed_hash);
    }

    #[test]
    fn set_render_mode_validates_and_replays() {
        let timestamp = now_utc();
        let mut state = AppState::default();

        let create = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: "0.1.0".to_string(),
            session_id: None,
            request_id: "req-1".to_string(),
            method: "session.create".to_string(),
            params: json!({}),
            timestamp,
        };
        let create_outcome = apply_command(&mut state, &create).expect("session.create should succeed");
        assert_eq!(create_outcome.result["session_id"], json!("session-1"));

        let set_mode = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: "0.1.0".to_string(),
            session_id: Some("session-1".to_string()),
            request_id: "req-2".to_string(),
            method: "view.set_render_mode".to_string(),
            params: json!({"mode": "graph_stub"}),
            timestamp,
        };
        let mode_outcome = apply_command(&mut state, &set_mode).expect("set_render_mode should succeed");
        assert_eq!(mode_outcome.result["mode"], json!("graph_stub"));
        assert_eq!(
            mode_outcome.emitted_events[0].payload["render_mode"],
            json!("graph_stub")
        );

        let bad_mode = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: "0.1.0".to_string(),
            session_id: Some("session-1".to_string()),
            request_id: "req-3".to_string(),
            method: "view.set_render_mode".to_string(),
            params: json!({"mode": "3d_stub"}),
            timestamp,
        };
        let err = apply_command(&mut state, &bad_mode).expect_err("invalid render mode should fail");
        assert!(err.to_string().contains("invalid render mode: 3d_stub"));
    }

    #[test]
    fn set_render_mode_falls_back_to_2d_without_dataset_or_image_layer() {
        let timestamp = now_utc();
        let mut state = AppState::default();

        apply_command(
            &mut state,
            &RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: "0.1.0".to_string(),
                session_id: None,
                request_id: "req-1".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp,
            },
        )
        .expect("session.create should succeed");

        let set_mode = RpcRequestEnvelope {
            jsonrpc: "2.0".to_string(),
            protocol_version: "0.1.0".to_string(),
            session_id: Some("session-1".to_string()),
            request_id: "req-2".to_string(),
            method: "view.set_render_mode".to_string(),
            params: json!({"mode": "3d"}),
            timestamp,
        };
        let outcome = apply_command(&mut state, &set_mode).expect("set_render_mode should succeed");
        assert_eq!(outcome.result["requested_mode"], json!("3d"));
        assert_eq!(outcome.result["mode"], json!("2d"));
        assert_eq!(
            outcome.result["fallback_reason"],
            json!("missing dataset or visible image layer")
        );
    }

    #[test]
    fn image_render_state_methods_validate_and_mutate() {
        let timestamp = now_utc();
        let mut state = AppState::default();

        apply_command(
            &mut state,
            &RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: "0.1.0".to_string(),
                session_id: None,
                request_id: "req-1".to_string(),
                method: "session.create".to_string(),
                params: json!({}),
                timestamp,
            },
        )
        .expect("session.create");

        apply_command(
            &mut state,
            &RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: "0.1.0".to_string(),
                session_id: Some("session-1".to_string()),
                request_id: "req-2".to_string(),
                method: "layer.add_image".to_string(),
                params: json!({"layer_id":"image-1","channel":0}),
                timestamp,
            },
        )
        .expect("layer.add_image");

        let sampling = apply_command(
            &mut state,
            &RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: "0.1.0".to_string(),
                session_id: Some("session-1".to_string()),
                request_id: "req-3".to_string(),
                method: "layer.set_sampling".to_string(),
                params: json!({"layer_id":"image-1","sampling_mode":"linear"}),
                timestamp,
            },
        )
        .expect("layer.set_sampling");
        assert_eq!(sampling.result["sampling_mode"], json!("linear"));

        let contrast = apply_command(
            &mut state,
            &RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: "0.1.0".to_string(),
                session_id: Some("session-1".to_string()),
                request_id: "req-4".to_string(),
                method: "layer.set_contrast_limits".to_string(),
                params: json!({"layer_id":"image-1","min":128,"max":4096}),
                timestamp,
            },
        )
        .expect("layer.set_contrast_limits");
        assert_eq!(contrast.result["contrast_limits"], json!([128, 4096]));

        let auto = apply_command(
            &mut state,
            &RpcRequestEnvelope {
                jsonrpc: "2.0".to_string(),
                protocol_version: "0.1.0".to_string(),
                session_id: Some("session-1".to_string()),
                request_id: "req-5".to_string(),
                method: "layer.auto_contrast".to_string(),
                params: json!({"layer_id":"image-1","min":64,"max":8192}),
                timestamp,
            },
        )
        .expect("layer.auto_contrast");
        assert_eq!(auto.result["contrast_limits"], json!([64, 8192]));
    }
}
