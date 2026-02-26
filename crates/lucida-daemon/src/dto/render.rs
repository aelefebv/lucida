use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dto::api::ApiWarning;
use crate::dto::view_state::{AxisSelector, AxisSelectorKind, ViewState};

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

fn default_render_format() -> RenderFormat {
    RenderFormat::Png
}

fn default_render_delivery() -> RenderDelivery {
    RenderDelivery::InlineBase64
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderOutputSpec {
    #[serde(default = "default_render_format")]
    pub format: RenderFormat,
    #[serde(default = "default_render_delivery")]
    pub delivery: RenderDelivery,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    pub width_px: u64,
    pub height_px: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderImageRequest {
    pub schema_version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_state: Option<ViewState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overrides_json_patch: Option<Vec<Value>>,
    pub output: RenderOutputSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderAxisSelector {
    pub axis: String,
    pub kind: AxisSelectorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_exclusive: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indices: Option<Vec<i64>>,
    pub clamp: bool,
}

impl From<&AxisSelector> for RenderAxisSelector {
    fn from(selector: &AxisSelector) -> Self {
        Self {
            axis: selector.axis.clone(),
            kind: selector.kind.clone(),
            index: selector.index,
            start: selector.start,
            end_exclusive: selector.end_exclusive,
            indices: selector.indices.clone(),
            clamp: selector.clamp,
        }
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stages: Option<RenderTimingStagesMs>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderTimingStagesMs {
    pub chunk_fetch: f64,
    pub chunk_decode: f64,
    pub sample: f64,
    pub compose: f64,
    pub encode: f64,
    #[serde(default)]
    pub gpu_compute: f64,
    #[serde(default)]
    pub gpu_readback: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderMeta {
    pub dataset_id: String,
    pub multiscale_name: String,
    pub pyramid_level_used: u64,
    pub selectors_applied: Vec<RenderAxisSelector>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_id: Option<String>,
    pub state_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_version: Option<u64>,
    pub images: Vec<RenderImageArtifact>,
    pub meta: RenderMeta,
    pub warnings: Vec<ApiWarning>,
}
