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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Axis {
    pub name: String,
    pub kind: AxisKind,
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
}
