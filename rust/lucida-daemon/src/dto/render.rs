use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dto::api::ApiWarning;
use crate::dto::view_state::{AxisSelector, ViewState};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RenderFormat {
    Png,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RenderDelivery {
    InlineBase64,
    FilePath,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderOutputSpec {
    pub format: RenderFormat,
    pub delivery: RenderDelivery,
    pub file_path: Option<String>,
    pub width_px: u64,
    pub height_px: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderImageRequest {
    pub schema_version: u8,
    pub view_id: Option<String>,
    pub view_state: Option<ViewState>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub overrides_json_patch: Option<Vec<Value>>,
    pub output: RenderOutputSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RenderArtifactRole {
    #[serde(rename = "main")]
    Main,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RenderMimeType {
    #[serde(rename = "image/png")]
    Png,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderImageArtifact {
    pub role: RenderArtifactRole,
    pub mime: RenderMimeType,
    pub width_px: u64,
    pub height_px: u64,
    pub delivery: RenderDelivery,
    pub bytes_base64: Option<String>,
    pub file_path: Option<String>,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderTimingMs {
    pub total: f64,
    pub io: f64,
    pub decode: f64,
    pub gpu_upload: f64,
    pub render: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderMeta {
    pub dataset_id: String,
    pub multiscale_name: String,
    pub pyramid_level_used: u64,
    pub selectors_applied: Vec<AxisSelector>,
    pub timing_ms: RenderTimingMs,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RenderStatus {
    #[serde(rename = "ok")]
    Ok,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderImageResponse {
    pub schema_version: u8,
    pub request_id: String,
    pub render_id: String,
    pub status: RenderStatus,
    pub completion: f64,
    pub view_id: Option<String>,
    pub state_hash: String,
    pub state_version: Option<u64>,
    pub images: Vec<RenderImageArtifact>,
    pub meta: RenderMeta,
    pub warnings: Vec<ApiWarning>,
}
