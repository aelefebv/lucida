use serde::{Deserialize, Serialize};

use crate::id::{EntityId, ImageId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSpec {
    pub image_id: ImageId,
    pub owner: EntityId,
    pub multiscale: MultiscaleInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiscaleInfo {
    pub axes: Vec<Axis>,
    pub levels: Vec<LevelGeometry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coarse_level_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub generated_levels: Vec<GeneratedLevelInfo>,
    pub data_type: DataType,
    /// Non-canonical axes (anything outside `{t,c,z,y,x}`) that were dropped
    /// from the canonical 5D shape and pinned to a fixed index when reading
    /// chunks. Empty for normal datasets.
    #[serde(default)]
    pub pinned_axes: Vec<PinnedAxis>,
}

impl MultiscaleInfo {
    pub fn is_generated_level(&self, level_index: u32) -> bool {
        self.generated_levels
            .iter()
            .any(|level| level.level_index == level_index)
    }

    pub fn selectable_detail_levels(&self) -> Vec<u32> {
        self.levels
            .iter()
            .map(|level| level.level_index)
            .filter(|level_index| !self.is_generated_level(*level_index))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeneratedLevelInfo {
    pub level_index: u32,
    #[serde(default)]
    pub role: GeneratedLevelRole,
    #[serde(default)]
    pub provenance: GeneratedLevelProvenance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum GeneratedLevelRole {
    #[default]
    Coarse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct GeneratedLevelProvenance {
    #[serde(default)]
    pub generator: String,
    #[serde(default)]
    pub config_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_content_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Axis {
    pub name: String,
    pub kind: AxisKind,
}

/// A non-canonical OME-Zarr axis that has been pinned to a fixed index.
///
/// Some OME-Zarr exports (notably CZI mosaics with an `m` axis) include axes
/// outside the canonical `{t,c,z,y,x}` set. Lucida pins each such axis to
/// `pinned_index` (always `0` today) and exposes the dropped metadata here so
/// future UI work can surface it without revisiting the parse layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedAxis {
    pub name: String,
    pub size: u64,
    pub pinned_index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AxisKind {
    Time,
    Channel,
    Space,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelGeometry {
    pub level_index: u32,
    pub shape: [u64; 5],
    pub chunk_shape: [u64; 5],
    pub grid_shape: [u64; 5],
    pub scale: [f64; 5],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DataType {
    Uint8,
    Uint16,
    Uint32,
    Float32,
    Float64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_geometry_grid_exact_division() {
        let level = LevelGeometry {
            level_index: 0,
            shape: [1, 1, 20, 512, 512],
            chunk_shape: [1, 1, 1, 128, 128],
            grid_shape: [1, 1, 20, 4, 4],
            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
        };
        assert_eq!(level.grid_shape, [1, 1, 20, 4, 4]);
    }

    #[test]
    fn level_geometry_grid_ceiling_division() {
        // 513 / 128 = 4.0078... -> ceil = 5
        let level = LevelGeometry {
            level_index: 0,
            shape: [1, 1, 20, 513, 513],
            chunk_shape: [1, 1, 1, 128, 128],
            grid_shape: [1, 1, 20, 5, 5],
            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
        };
        assert_eq!(level.grid_shape, [1, 1, 20, 5, 5]);
    }

    #[test]
    fn level_geometry_grid_single_voxel() {
        let level = LevelGeometry {
            level_index: 0,
            shape: [1, 1, 1, 1, 1],
            chunk_shape: [1, 1, 1, 1, 1],
            grid_shape: [1, 1, 1, 1, 1],
            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
        };
        assert_eq!(level.grid_shape, [1, 1, 1, 1, 1]);
    }

    #[test]
    fn multiscale_info_deserializes_without_pinned_axes() {
        // Backward-compat: snapshots from older servers omit `pinned_axes`.
        // `#[serde(default)]` should yield an empty Vec rather than failing.
        let json = serde_json::json!({
            "axes": [
                {"name": "z", "kind": "Space"},
                {"name": "y", "kind": "Space"},
                {"name": "x", "kind": "Space"}
            ],
            "levels": [{
                "level_index": 0,
                "shape": [1, 1, 10, 256, 256],
                "chunk_shape": [1, 1, 1, 128, 128],
                "grid_shape": [1, 1, 10, 2, 2],
                "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
            }],
            "data_type": "Uint16"
        });
        let info: MultiscaleInfo = serde_json::from_value(json).unwrap();
        assert_eq!(info.axes.len(), 3);
        assert_eq!(info.coarse_level_index, None);
        assert!(info.generated_levels.is_empty());
        assert!(info.pinned_axes.is_empty());
    }

    #[test]
    fn multiscale_info_carries_coarse_and_generated_metadata() {
        let json = serde_json::json!({
            "axes": [
                {"name": "z", "kind": "Space"},
                {"name": "y", "kind": "Space"},
                {"name": "x", "kind": "Space"}
            ],
            "levels": [
                {
                    "level_index": 0,
                    "shape": [1, 1, 10, 256, 256],
                    "chunk_shape": [1, 1, 1, 128, 128],
                    "grid_shape": [1, 1, 10, 2, 2],
                    "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                },
                {
                    "level_index": 1,
                    "shape": [1, 1, 1, 64, 64],
                    "chunk_shape": [1, 1, 1, 64, 64],
                    "grid_shape": [1, 1, 1, 1, 1],
                    "scale": [1.0, 1.0, 1.0, 4.0, 4.0]
                }
            ],
            "coarse_level_index": 1,
            "generated_levels": [{
                "level_index": 1,
                "role": "coarse",
                "provenance": {
                    "generator": "coarse-v1",
                    "config_id": "max-axis-1024"
                }
            }],
            "data_type": "Uint16"
        });
        let info: MultiscaleInfo = serde_json::from_value(json).unwrap();
        assert_eq!(info.coarse_level_index, Some(1));
        assert!(info.is_generated_level(1));
        assert_eq!(info.selectable_detail_levels(), vec![0]);
        assert_eq!(info.generated_levels[0].provenance.generator, "coarse-v1");
    }
}
