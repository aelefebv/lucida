use serde::{Deserialize, Serialize};

use crate::transform::VolumeTransform;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BlendMode {
    Alpha,
    Additive,
    Max,
}

impl Default for BlendMode {
    fn default() -> Self {
        BlendMode::Alpha
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerDisplaySettings {
    pub visible: bool,
    pub opacity: f32,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
    pub blend_mode: BlendMode,
}

impl Default for LayerDisplaySettings {
    fn default() -> Self {
        Self {
            visible: true,
            opacity: 1.0,
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
            blend_mode: BlendMode::Alpha,
        }
    }
}

/// Display settings (contrast window + gamma).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayState {
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
}

impl Default for DisplayState {
    fn default() -> Self {
        Self {
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
        }
    }
}

/// Shared document state — datasets and structural data that are synced across all clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentState {
    pub datasets: Vec<Dataset>,
}

impl DocumentState {
    /// Add or replace a dataset by id.
    pub fn add_dataset(&mut self, dataset: Dataset) {
        if let Some(existing) = self.datasets.iter_mut().find(|d| d.id == dataset.id) {
            *existing = dataset;
        } else {
            self.datasets.push(dataset);
        }
    }

    /// Remove a dataset by id.
    pub fn remove_dataset(&mut self, id: &str) {
        self.datasets.retain(|d| d.id != id);
    }
}

/// Per-level shape and chunk size metadata for anisotropic pyramids.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelInfo {
    /// Data shape at this level: [x, y, z].
    pub shape: [u32; 3],
    /// Chunk size at this level: [x, y, z].
    pub chunk_size: [u32; 3],
}

/// A single image layer in the scene.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layer {
    pub name: String,
    pub visible: bool,
    /// Number of multiscale levels available.
    pub num_levels: u32,
    /// Chunk size in pixels: [x, y, z].
    pub chunk_size: [u32; 3],
    /// Full-resolution data shape in voxels: [x, y, z].
    pub data_shape: [u32; 3],
    /// Per-level shape and chunk size. When empty, isotropic 2^level downsampling is assumed.
    #[serde(default)]
    pub level_info: Vec<LevelInfo>,
}

impl Layer {
    /// Returns `(level_shape, level_chunk_size)` for the given level.
    ///
    /// Uses `level_info` when available; falls back to isotropic `data_shape / 2^level`.
    pub fn shape_at_level(&self, level: u32) -> ([u32; 3], [u32; 3]) {
        if let Some(info) = self.level_info.get(level as usize) {
            (info.shape, info.chunk_size)
        } else {
            let scale = 1u32 << level;
            let shape = [
                (self.data_shape[0] + scale - 1) / scale,
                (self.data_shape[1] + scale - 1) / scale,
                (self.data_shape[2] + scale - 1) / scale,
            ];
            (shape, self.chunk_size)
        }
    }
}

/// A single dataset in the scene, containing its layers and spatial metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dataset {
    pub id: String,
    pub name: String,
    pub layers: Vec<Layer>,
    pub volume_transform: Option<VolumeTransform>,
    /// Volume dimensions in voxels: [Z, Y, X].
    pub volume_shape: Option<[u32; 3]>,
    /// Opaque client metadata (dtype, codecs, level paths).
    /// Server passes through without interpretation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_metadata: Option<serde_json::Value>,
}
