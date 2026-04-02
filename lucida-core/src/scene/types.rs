use serde::{Deserialize, Serialize};

use crate::chunk::ChunkCoord;
use crate::command::DocumentCommand;
use crate::transform::{self, VolumeTransform};

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RenderMode {
    Translucent,
    MaxIntensity,
}

impl Default for RenderMode {
    fn default() -> Self {
        RenderMode::Translucent
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetDisplaySettings {
    pub visible: bool,
    pub opacity: f32,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub render_mode: RenderMode,
}

impl Default for DatasetDisplaySettings {
    fn default() -> Self {
        Self {
            visible: true,
            opacity: 1.0,
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
            blend_mode: BlendMode::Alpha,
            render_mode: RenderMode::Translucent,
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

    /// Apply a document command directly. Used by the server to avoid
    /// constructing a full Scene for document mutations.
    pub fn apply(&mut self, cmd: DocumentCommand) {
        match cmd {
            DocumentCommand::AddDataset {
                id,
                name,
                kind,
                layers,
                volume_shape,
                volume_scale,
                members,
                client_metadata,
            } => {
                let volume_transform =
                    if let (Some(shape), Some(scale)) = (volume_shape, volume_scale) {
                        Some(transform::compute_volume_transform(shape, scale))
                    } else {
                        None
                    };
                self.add_dataset(Dataset {
                    id,
                    name,
                    kind,
                    layers,
                    volume_transform,
                    volume_shape,
                    members,
                    client_metadata,
                });
            }
            DocumentCommand::RemoveDataset { id } => {
                self.remove_dataset(&id);
            }
            DocumentCommand::SetVolumeScale { shape, scale } => {
                if self.datasets.is_empty() {
                    self.datasets.push(Dataset {
                        id: "default".into(),
                        name: "default".into(),
                        kind: DatasetKind::default(),
                        layers: Vec::new(),
                        volume_transform: None,
                        volume_shape: None,
                        members: Vec::new(),
                        client_metadata: None,
                    });
                }
                let ds = &mut self.datasets[0];
                ds.volume_shape = Some(shape);
                ds.volume_transform = Some(transform::compute_volume_transform(shape, scale));
            }
        }
    }
}

/// Per-level shape and chunk size metadata for anisotropic pyramids.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelInfo {
    /// Data shape at this level: [Z, Y, X].
    pub shape: [u32; 3],
    /// Chunk size at this level: [Z, Y, X].
    pub chunk_size: [u32; 3],
}

/// A single image layer in the scene.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layer {
    pub name: String,
    pub visible: bool,
    /// Number of multiscale levels available.
    pub num_levels: u32,
    /// Chunk size in voxels: [Z, Y, X].
    pub chunk_size: [u32; 3],
    /// Full-resolution data shape in voxels: [Z, Y, X].
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

/// Discriminant for dataset variants. Single datasets have one member at the
/// origin; plates have many positioned members.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DatasetKind {
    Single,
    Plate {
        rows: Vec<String>,
        columns: Vec<String>,
        wells: Vec<PlateWell>,
        positioning_mode: PositioningMode,
        has_stage_positions: bool,
    },
}

impl Default for DatasetKind {
    fn default() -> Self {
        DatasetKind::Single
    }
}

/// A well within a plate, identified by row/column path and indices.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlateWell {
    /// Well path, e.g. "A/1".
    pub path: String,
    /// Zero-based row index.
    pub row_index: u32,
    /// Zero-based column index.
    pub column_index: u32,
    /// FOVs within this well.
    #[serde(default)]
    pub fovs: Vec<PlateFov>,
}

/// A single field of view within a plate well.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlateFov {
    /// FOV path within the well, e.g. "0".
    pub path: String,
    /// Store path prefix for chunk routing, e.g. "A/1/0".
    pub store_prefix: String,
    /// Position offset in voxel space: [X, Y].
    #[serde(default)]
    pub position: [f64; 2],
    /// Stage translation coordinates from OME metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation: Option<Vec<f64>>,
}

/// How FOVs within a plate are positioned.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PositioningMode {
    Stage,
    Grid,
}

impl Default for PositioningMode {
    fn default() -> Self {
        PositioningMode::Grid
    }
}

/// A positioned sub-volume within a dataset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetMember {
    /// Unique ID across all members of all datasets.
    pub id: String,
    /// Position offset in voxel space: [X, Y].
    #[serde(default)]
    pub position: [f64; 2],
    /// Store path prefix for chunk routing (e.g. "A/1/0" for plate FOVs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_prefix: Option<String>,
}

/// Per-member output of chunk planning.
#[derive(Debug, Clone, Serialize)]
pub struct MemberChunkPlan {
    pub member_id: String,
    pub position: [f64; 2],
    pub store_prefix: Option<String>,
    pub needed: Vec<ChunkCoord>,
    pub prefetch: Vec<ChunkCoord>,
}

/// A single dataset in the scene, containing its layers and spatial metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dataset {
    pub id: String,
    pub name: String,
    /// Dataset variant discriminant.
    #[serde(default)]
    pub kind: DatasetKind,
    pub layers: Vec<Layer>,
    pub volume_transform: Option<VolumeTransform>,
    /// Volume dimensions in voxels: [Z, Y, X].
    pub volume_shape: Option<[u32; 3]>,
    /// Positioned sub-volumes. For single datasets, one member at [0, 0].
    /// Empty means "synthesize a single member from the dataset ID" (backward compat).
    #[serde(default)]
    pub members: Vec<DatasetMember>,
    /// Opaque client metadata (dtype, codecs, level paths).
    /// Server passes through without interpretation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_metadata: Option<serde_json::Value>,
}

impl Dataset {
    /// Returns the effective member list. If `members` is empty (backward compat),
    /// synthesizes a single member from the dataset ID at position [0, 0].
    pub fn effective_members(&self) -> Vec<DatasetMember> {
        if self.members.is_empty() {
            vec![DatasetMember {
                id: self.id.clone(),
                position: [0.0, 0.0],
                store_prefix: None,
            }]
        } else {
            self.members.clone()
        }
    }
}
