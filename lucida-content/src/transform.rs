use serde::{Deserialize, Serialize};

use crate::id::EntityId;

/// An entity-to-entity affine transform expressed in **voxel units** of the
/// `from` entity's full-resolution image.
///
/// Translations and scales in the `transform` matrix are interpreted as
/// counts of source-entity full-res voxels. Producers reading from
/// physical-unit metadata (e.g., OME-Zarr coordinate translations in physical units)
/// **must** convert at the call site before constructing the
/// [`VoxelTransform`]. The canonical constructor is
/// [`VoxelTransform::from_voxel_translation_2d`].
///
/// This contract is enforced by the type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransformEdge {
    pub from: EntityId,
    pub to: EntityId,
    pub transform: VoxelTransform,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AffineTransform {
    /// Column-major 4x4 matrix. Identity = no transform.
    pub matrix: [f64; 16],
}

impl AffineTransform {
    /// Identity transform (no-op).
    pub fn identity() -> Self {
        Self {
            matrix: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
        }
    }

    /// Pure 2D translation.
    pub fn translation_2d(tx: f64, ty: f64) -> Self {
        Self {
            matrix: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, tx, ty, 0.0, 1.0,
            ],
        }
    }
}

/// A column-major 4x4 affine transform whose translations and scales are
/// expressed in **voxel units** of the source entity's full-resolution image.
///
/// `VoxelTransform` is a unit-tagged newtype around [`AffineTransform`].
/// The inner matrix is private — construction goes through one of the
/// dedicated `from_voxel_*` constructors so that callers must explicitly
/// acknowledge the unit. A previous bug (issues #408 / #409) had a
/// producer construct an edge with physical units where
/// consumers expected voxel units; this newtype prevents that class of
/// bug at compile time.
///
/// The serde representation is `#[serde(transparent)]` so the wire format
/// is byte-compatible with `AffineTransform`: `{ "matrix": [16 floats] }`.
///
/// ```compile_fail
/// use lucida_content::{VoxelTransform, AffineTransform};
/// let _: VoxelTransform = AffineTransform::identity();
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VoxelTransform {
    inner: AffineTransform,
}

impl VoxelTransform {
    /// Identity transform (no-op).
    pub fn identity() -> Self {
        Self {
            inner: AffineTransform::identity(),
        }
    }

    /// Pure 2D translation in voxel units of the source entity's
    /// full-resolution image.
    pub fn from_voxel_translation_2d(tx: f64, ty: f64) -> Self {
        Self {
            inner: AffineTransform::translation_2d(tx, ty),
        }
    }

    /// Construct from a raw column-major 4x4 matrix whose components are
    /// already expressed in voxel units of the source entity's full-resolution
    /// image. Use this when building scale or composed transforms from math
    /// you've already done in the right unit.
    pub fn from_voxel_matrix(matrix: [f64; 16]) -> Self {
        Self {
            inner: AffineTransform { matrix },
        }
    }

    /// Borrow the underlying column-major 4x4 matrix.
    pub fn matrix(&self) -> &[f64; 16] {
        &self.inner.matrix
    }

    /// If this transform is exactly a pure 2D translation — the matrix
    /// [`AffineTransform::translation_2d`] builds, identity everywhere except
    /// `matrix[12]` (tx) and `matrix[13]` (ty) — return `[tx, ty]`.
    ///
    /// [`DatasetManifest`](crate::DatasetManifest) uses this to encode
    /// tile-placement edges (grid or explicit 2D positions) as a two-number
    /// `translation` on the wire instead of 16 matrix elements, which is what
    /// keeps wide-collection manifests from repeating near-identity matrices
    /// tens of thousands of times. Comparisons are exact (`==`, including
    /// `tx`/`ty` sign-of-zero-insensitively via IEEE equality), so any scale,
    /// rotation, z component, or non-affine bottom row falls back to the full
    /// matrix form and the reconstruction
    /// `from_voxel_translation_2d(tx, ty)` is bit-lossless.
    pub fn as_voxel_translation_2d(&self) -> Option<[f64; 2]> {
        let m = &self.inner.matrix;
        let reference = AffineTransform::translation_2d(m[12], m[13]).matrix;
        if *m == reference {
            Some([m[12], m[13]])
        } else {
            None
        }
    }
}
