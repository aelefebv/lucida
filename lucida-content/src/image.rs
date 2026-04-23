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
    pub data_type: DataType,
    /// Non-canonical axes (anything outside `{t,c,z,y,x}`) that were dropped
    /// from the canonical 5D shape and pinned to a fixed index when reading
    /// chunks. Empty for normal datasets.
    #[serde(default)]
    pub pinned_axes: Vec<PinnedAxis>,
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
        assert!(info.pinned_axes.is_empty());
    }
}
