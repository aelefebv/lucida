//! Pluggable source for in-memory voxel data.
//!
//! `lucida-proxy` is pure compute and never reads from a file or network.
//! Callers (the server, tests, future PyO3 wrapper) provide voxel data
//! through the [`ProxySourceData`] trait.

use lucida_content::{ImageId, VoxelTransform};

/// A single tile's voxel data plus the transform that places its voxel
/// grid into image / tile coordinates.
pub struct TileVolume {
    /// Densely-packed `u16` voxels in `[Z, Y, X]` row-major order
    /// (X varies fastest).
    pub data: Vec<u16>,
    /// `[Z, Y, X]` voxel counts.
    pub dims: [u32; 3],
    /// Maps voxel-index space `(x, y, z)` to image / tile-local space.
    /// Used by the group aggregator to find a sample location after
    /// transforming a target group coordinate back into the tile.
    pub voxel_to_image: VoxelTransform,
}

/// Source for proxy generation. Implementors return decoded `u16` volumes
/// for an `(image, time, channel, level)` tuple.
///
/// The trait is intentionally minimal: it owns no async runtime and no
/// caching policy. Production callers wrap their store in an adapter; tests
/// implement it inline against synthetic data.
pub trait ProxySourceData {
    /// Read the requested level for the requested image at `(t, c)`.
    fn read_tile_volume(
        &self,
        image_id: &ImageId,
        t: u32,
        c: u32,
        level: usize,
    ) -> Result<TileVolume, SourceError>;
}

/// Errors a source can return. These propagate up through
/// [`crate::generate::GenerateError::Source`].
#[derive(thiserror::Error, Debug)]
pub enum SourceError {
    #[error("source data not found")]
    NotFound,
    #[error("io error: {0}")]
    Io(String),
}
