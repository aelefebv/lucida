use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dto::dataset_summary::DatasetSummary;
use crate::dto::view_state::{AxisSelector, View2D, ViewState, Viewport};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ApiWarning {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DatasetOpenRequest {
    pub schema_version: u8,
    pub uri: String,
    pub dataset_id: Option<String>,
    pub session_id: Option<String>,
    pub include_full_raw_metadata: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DatasetOpenResponse {
    pub schema_version: u8,
    pub dataset_summary: DatasetSummary,
    pub warnings: Vec<ApiWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SessionCreateRequest {
    pub schema_version: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SessionCreateResponse {
    pub schema_version: u8,
    pub session_id: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ViewMode {
    #[serde(rename = "2d")]
    TwoD,
    #[serde(rename = "3d")]
    ThreeD,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewCreateRequest {
    pub schema_version: u8,
    pub session_id: Option<String>,
    pub dataset_id: String,
    pub mode: ViewMode,
    pub multiscale_name: Option<String>,
    pub viewport: Option<Viewport>,
    pub selectors: Option<Vec<AxisSelector>>,
    pub view_2d: Option<View2D>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewCreateResponse {
    pub schema_version: u8,
    pub view_state: ViewState,
    pub warnings: Vec<ApiWarning>,
    pub selectors_applied: Vec<AxisSelector>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewGetResponse {
    pub schema_version: u8,
    pub view_state: ViewState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewUpdateRequest {
    pub schema_version: u8,
    pub session_id: Option<String>,
    pub view_id: String,
    pub expected_state_version: Option<u64>,
    pub patch: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewUpdateResponse {
    pub schema_version: u8,
    pub view_state: ViewState,
    pub warnings: Vec<ApiWarning>,
    pub selectors_applied: Vec<AxisSelector>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewStateExportRequest {
    pub schema_version: u8,
    pub view_id: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewStateExportResponse {
    pub schema_version: u8,
    pub export_id: String,
    pub exported_at: DateTime<Utc>,
    pub source_view_id: String,
    pub view_state: ViewState,
    pub warnings: Vec<ApiWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewStateImportRequest {
    pub schema_version: u8,
    pub session_id: Option<String>,
    pub view_state: ViewState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewStateImportResponse {
    pub schema_version: u8,
    pub import_id: String,
    pub imported_from_view_id: Option<String>,
    pub view_state: ViewState,
    pub warnings: Vec<ApiWarning>,
    pub selectors_applied: Vec<AxisSelector>,
}
