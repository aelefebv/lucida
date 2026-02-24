use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AxisRole {
    X,
    Y,
    Z,
    C,
    T,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ContrastPolicy {
    Fixed,
    Percentile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AxisDef {
    pub name: String,
    pub role: AxisRole,
    pub size: u64,
    pub unit: Option<String>,
    pub scale: Option<f64>,
    pub translation: Option<f64>,
    pub direction: Option<i8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SuggestedContrast {
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub policy: Option<ContrastPolicy>,
    pub p_low: Option<f64>,
    pub p_high: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChannelDef {
    pub index: u64,
    pub name: Option<String>,
    pub color_rgba: Option<[f64; 4]>,
    pub suggested_contrast: Option<SuggestedContrast>,
    pub suggested_gamma: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MultiscaleLevelDef {
    pub level: u64,
    pub path: String,
    pub shape: Vec<u64>,
    pub chunks: Vec<u64>,
    pub downsample_factors: Option<Vec<f64>>,
    pub dtype: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MultiscaleImageDef {
    pub name: String,
    pub axes_order: Vec<String>,
    pub levels: Vec<MultiscaleLevelDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DatasetHints {
    pub recommended_tile_px: Option<(u64, u64)>,
    pub is_remote: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DatasetSummary {
    pub schema_version: u8,
    pub dataset_id: String,
    pub uri: String,
    pub opened_at: Option<DateTime<Utc>>,
    pub axes: Vec<AxisDef>,
    pub shape: Vec<u64>,
    pub dtype: String,
    pub world_units: Option<String>,
    pub channels: Option<Vec<ChannelDef>>,
    pub multiscales: Vec<MultiscaleImageDef>,
    pub hints: Option<DatasetHints>,
    pub raw_metadata: Option<Value>,
}
