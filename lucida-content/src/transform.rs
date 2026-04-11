use serde::{Deserialize, Serialize};

use crate::id::EntityId;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformEdge {
    pub from: EntityId,
    pub to: EntityId,
    pub transform: AffineTransform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AffineTransform {
    /// Column-major 4x4 matrix. Identity = no transform.
    pub matrix: [f64; 16],
}

impl AffineTransform {
    /// Identity transform (no-op).
    pub fn identity() -> Self {
        Self {
            matrix: [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        }
    }

    /// Pure 2D translation.
    pub fn translation_2d(tx: f64, ty: f64) -> Self {
        Self {
            matrix: [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                tx,  ty,  0.0, 1.0,
            ],
        }
    }
}
