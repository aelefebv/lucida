use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const JSONRPC_VERSION: &str = "2.0";
pub const PROTOCOL_VERSION: &str = "0.1.0";
pub const LOG_SCHEMA_VERSION: u32 = 1;
pub const FRAME_PROTOCOL_VERSION: &str = "0.1.0";

fn default_jsonrpc() -> String {
    JSONRPC_VERSION.to_string()
}

fn default_protocol_version() -> String {
    PROTOCOL_VERSION.to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RpcRequestEnvelope {
    #[serde(default = "default_jsonrpc")]
    pub jsonrpc: String,
    #[serde(default = "default_protocol_version")]
    pub protocol_version: String,
    pub session_id: Option<String>,
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    pub timestamp: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RpcResponseEnvelope {
    #[serde(default = "default_jsonrpc")]
    pub jsonrpc: String,
    #[serde(default = "default_protocol_version")]
    pub protocol_version: String,
    pub request_id: String,
    pub result: Option<Value>,
    pub error: Option<RpcError>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EventEnvelope {
    #[serde(default = "default_jsonrpc")]
    pub jsonrpc: String,
    #[serde(default = "default_protocol_version")]
    pub protocol_version: String,
    pub session_id: Option<String>,
    pub event: String,
    #[serde(default)]
    pub payload: Value,
    pub timestamp: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AxisLabel(pub String);

impl AxisLabel {
    pub fn canonical(value: &str) -> Self {
        Self(value.to_string())
    }

    pub fn is_builtin(&self) -> bool {
        matches!(self.0.as_str(), "t" | "c" | "z" | "y" | "x")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AxisSpec {
    pub label: AxisLabel,
    pub size: usize,
    pub unit: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Transform {
    pub scale: Vec<f64>,
    pub translate: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DatasetHandle {
    pub id: String,
    pub uri: String,
    pub ome_version: Option<String>,
    #[serde(default)]
    pub multiscale_metadata: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CameraState2D {
    pub center: [f64; 2],
    pub zoom: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CameraStateArcball {
    pub target: [f64; 3],
    pub distance: f64,
    pub yaw_pitch: [f64; 2],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CameraStateFreefly {
    pub position: [f64; 3],
    pub yaw_pitch_roll: [f64; 3],
    pub speed: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderMode {
    #[serde(rename = "2d")]
    TwoD,
    #[serde(rename = "2d_stub")]
    TwoDStub,
    #[serde(rename = "3d")]
    ThreeD,
    GraphStub,
}

impl RenderMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TwoD => "2d",
            Self::TwoDStub => "2d_stub",
            Self::ThreeD => "3d",
            Self::GraphStub => "graph_stub",
        }
    }
}

impl Default for RenderMode {
    fn default() -> Self {
        Self::TwoD
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SamplingMode {
    Nearest,
    Linear,
}

impl SamplingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nearest => "nearest",
            Self::Linear => "linear",
        }
    }
}

impl Default for SamplingMode {
    fn default() -> Self {
        Self::Nearest
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImageRenderState {
    #[serde(default)]
    pub sampling_mode: SamplingMode,
    #[serde(default = "default_contrast_limits")]
    pub contrast_limits: [u16; 2],
}

impl Default for ImageRenderState {
    fn default() -> Self {
        Self {
            sampling_mode: SamplingMode::Nearest,
            contrast_limits: default_contrast_limits(),
        }
    }
}

fn default_contrast_limits() -> [u16; 2] {
    [0, u16::MAX]
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PointsLayer {
    pub positions: Vec<[f32; 3]>,
    #[serde(default)]
    pub attributes: Value,
    pub lod_policy: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommandEnvelope {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    pub timestamp: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuditEntry {
    pub received_at: DateTime<Utc>,
    pub request: RpcRequestEnvelope,
    pub outcome: AuditOutcome,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AuditOutcome {
    Success { result: Value },
    Error { error: RpcError },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReplayEntry {
    pub entry_id: String,
    pub session_id: Option<String>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    pub timestamp: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportedCommandLog {
    pub log_schema_version: u32,
    pub protocol_version: String,
    pub audit_log: Vec<AuditEntry>,
    pub replay_log: Vec<ReplayEntry>,
}

pub fn now_utc() -> DateTime<Utc> {
    Utc::now()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FrameViewport {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FrameAxisIndices {
    pub t: usize,
    pub c: usize,
    pub z: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FrameRequestHeader {
    pub frame_protocol_version: String,
    pub request_id: String,
    pub channel_token: String,
    pub session_id: String,
    pub axis_indices: FrameAxisIndices,
    pub viewport: FrameViewport,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FrameResponseHeader {
    pub request_id: String,
    pub status: String,
    pub width: u32,
    pub height: u32,
    pub dtype: String,
    pub endianness: String,
    pub payload_len: u32,
    pub state_hash: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_envelope_roundtrip_preserves_contract_fields() {
        let request = RpcRequestEnvelope {
            jsonrpc: JSONRPC_VERSION.to_string(),
            protocol_version: PROTOCOL_VERSION.to_string(),
            session_id: Some("session-1".to_string()),
            request_id: "req-1".to_string(),
            method: "health.ping".to_string(),
            params: json!({"ping": true}),
            timestamp: now_utc(),
        };

        let serialized = serde_json::to_string(&request).expect("serialize request envelope");
        let roundtrip: RpcRequestEnvelope =
            serde_json::from_str(&serialized).expect("deserialize request envelope");

        assert_eq!(roundtrip.protocol_version, PROTOCOL_VERSION);
        assert_eq!(roundtrip.request_id, "req-1");
        assert_eq!(roundtrip.method, "health.ping");
        assert_eq!(roundtrip.params["ping"], json!(true));
    }

    #[test]
    fn exported_log_uses_expected_schema_version() {
        let log = ExportedCommandLog {
            log_schema_version: LOG_SCHEMA_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            audit_log: Vec::new(),
            replay_log: Vec::new(),
        };
        assert_eq!(log.log_schema_version, 1);
    }

    #[test]
    fn axis_labels_allow_builtin_and_extra_axes() {
        let builtin = AxisLabel::canonical("z");
        let extra = AxisLabel::canonical("phase");

        assert!(builtin.is_builtin());
        assert!(!extra.is_builtin());
    }

    #[test]
    fn frame_header_roundtrip_is_stable() {
        let request = FrameRequestHeader {
            frame_protocol_version: FRAME_PROTOCOL_VERSION.to_string(),
            request_id: "frame-1".to_string(),
            channel_token: "token-1".to_string(),
            session_id: "session-1".to_string(),
            axis_indices: FrameAxisIndices { t: 0, c: 0, z: 2 },
            viewport: FrameViewport {
                width: 800,
                height: 600,
            },
        };

        let encoded = serde_json::to_string(&request).expect("serialize frame request");
        let decoded: FrameRequestHeader =
            serde_json::from_str(&encoded).expect("deserialize frame request");

        assert_eq!(decoded.frame_protocol_version, FRAME_PROTOCOL_VERSION);
        assert_eq!(decoded.axis_indices.z, 2);
        assert_eq!(decoded.viewport.width, 800);
    }

    #[test]
    fn render_mode_roundtrip_uses_contract_strings() {
        let mode = RenderMode::ThreeD;
        let encoded = serde_json::to_string(&mode).expect("serialize render mode");
        let decoded: RenderMode = serde_json::from_str(&encoded).expect("deserialize render mode");

        assert_eq!(encoded, "\"3d\"");
        assert_eq!(decoded, RenderMode::ThreeD);
        assert_eq!(RenderMode::TwoD.as_str(), "2d");
        assert_eq!(RenderMode::TwoDStub.as_str(), "2d_stub");
    }

    #[test]
    fn sampling_mode_roundtrip_uses_contract_strings() {
        let mode = SamplingMode::Nearest;
        let encoded = serde_json::to_string(&mode).expect("serialize sampling mode");
        let decoded: SamplingMode =
            serde_json::from_str(&encoded).expect("deserialize sampling mode");

        assert_eq!(encoded, "\"nearest\"");
        assert_eq!(decoded, SamplingMode::Nearest);
        assert_eq!(SamplingMode::Nearest.as_str(), "nearest");
        assert_eq!(SamplingMode::Linear.as_str(), "linear");
    }
}
