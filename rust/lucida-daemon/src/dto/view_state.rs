use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn default_schema_version() -> u8 {
    1
}

fn default_true() -> bool {
    true
}

fn default_pixel_ratio() -> f64 {
    1.0
}

fn default_thickness_vox() -> u64 {
    1
}

fn default_gamma() -> f64 {
    1.0
}

fn default_p_low() -> f64 {
    1.0
}

fn default_p_high() -> f64 {
    99.0
}

fn default_target_frame_ms() -> u64 {
    200
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AxisSelectorKind {
    Index,
    Range,
    Set,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RenderMode {
    #[serde(rename = "2d")]
    TwoD,
    #[serde(rename = "3d")]
    ThreeD,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DatasetRef {
    pub dataset_id: String,
    pub multiscale_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub width_px: u64,
    pub height_px: u64,
    #[serde(default = "default_pixel_ratio")]
    pub pixel_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AxisSelector {
    pub axis: String,
    pub kind: AxisSelectorKind,
    pub index: Option<i64>,
    pub start: Option<i64>,
    pub end_exclusive: Option<i64>,
    pub indices: Option<Vec<i64>>,
    #[serde(default = "default_true")]
    pub clamp: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SlabMode {
    Single,
    Mip,
    Mean,
}

impl Default for SlabMode {
    fn default() -> Self {
        Self::Single
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SlabSettings {
    #[serde(default = "default_thickness_vox")]
    pub thickness_vox: u64,
    #[serde(default)]
    pub mode: SlabMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SliceSettings {
    pub axis: Option<String>,
    pub index: Option<i64>,
    pub slab: Option<SlabSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Camera2D {
    pub center_world: (f64, f64),
    pub zoom: f64,
    pub rotation_deg: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Plane2D {
    Xy,
    Xz,
    Yz,
}

impl Default for Plane2D {
    fn default() -> Self {
        Self::Xy
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct View2D {
    #[serde(default)]
    pub plane: Plane2D,
    pub slice: Option<SliceSettings>,
    pub camera: Camera2D,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LayerSource {
    pub multiscale_name: Option<String>,
    pub array_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelContrastPolicy {
    Fixed,
    Percentile,
}

impl Default for ChannelContrastPolicy {
    fn default() -> Self {
        Self::Percentile
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChannelContrast {
    #[serde(default)]
    pub policy: ChannelContrastPolicy,
    pub min: Option<f64>,
    pub max: Option<f64>,
    #[serde(default = "default_p_low")]
    pub p_low: f64,
    #[serde(default = "default_p_high")]
    pub p_high: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ImageChannelSettings {
    pub index: u64,
    pub enabled: bool,
    pub color_rgba: Option<[f64; 4]>,
    pub contrast: Option<ChannelContrast>,
    #[serde(default = "default_gamma")]
    pub gamma: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelMode {
    Single,
    Rgb,
    Composite,
}

impl Default for ChannelMode {
    fn default() -> Self {
        Self::Composite
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum InterpolationMode {
    Nearest,
    Linear,
}

impl Default for InterpolationMode {
    fn default() -> Self {
        Self::Linear
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ImageLayerSettings {
    #[serde(default)]
    pub channel_mode: ChannelMode,
    pub channels: Vec<ImageChannelSettings>,
    #[serde(default)]
    pub interpolation: InterpolationMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LabelLayerSettings {
    #[serde(default = "default_true")]
    pub outline: bool,
    #[serde(default = "default_thickness_vox")]
    pub outline_width_px: u64,
    #[serde(default = "default_true")]
    pub show_fill: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LayerType {
    Image,
    Labels,
    Annotations,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LayerState {
    pub layer_id: String,
    #[serde(rename = "type")]
    pub layer_type: LayerType,
    pub dataset_id: Option<String>,
    pub source: Option<LayerSource>,
    pub visible: bool,
    pub opacity: f64,
    pub image: Option<ImageLayerSettings>,
    pub labels: Option<LabelLayerSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderSettings {
    pub background_rgba: Option<[f64; 4]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RenderQuality {
    Draft,
    Final,
}

impl Default for RenderQuality {
    fn default() -> Self {
        Self::Draft
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LodMode {
    Auto,
    Fixed,
}

impl Default for LodMode {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PerformanceHints {
    #[serde(default)]
    pub quality: RenderQuality,
    #[serde(default = "default_target_frame_ms")]
    pub target_frame_ms: u64,
    #[serde(default = "default_true")]
    pub progressive: bool,
    #[serde(default)]
    pub lod_mode: LodMode,
    pub fixed_level: Option<u64>,
    pub max_cpu_cache_bytes: Option<u64>,
    pub max_gpu_cache_bytes: Option<u64>,
    #[serde(default = "default_true")]
    pub prefer_gpu: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ViewState {
    #[serde(default = "default_schema_version")]
    pub schema_version: u8,
    pub view_id: String,
    pub session_id: String,
    pub created_at: Option<DateTime<Utc>>,
    pub mode: RenderMode,
    pub datasets: Vec<DatasetRef>,
    pub viewport: Viewport,
    pub selectors: Vec<AxisSelector>,
    pub view_2d: Option<View2D>,
    pub view_3d: Option<Value>,
    pub layers: Vec<LayerState>,
    pub render_settings: Option<RenderSettings>,
    pub performance: Option<PerformanceHints>,
    pub state_hash: Option<String>,
    #[serde(default)]
    pub state_version: u64,
}
