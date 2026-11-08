//! Read a dense spatial region of one source level into memory, for
//! generated coarse levels to downsample.

use std::sync::Arc;

use lucida_content::{ChunkKey, ImageId, ImageSpec};
use lucida_store::cache::CachedStore;
use lucida_store::source_limiter::{ReaderId, RequestLabel};

use crate::binding::ChunkResolver;
use crate::chunk_read::{ChunkRead, ChunkReadError, read_chunk};
use crate::decode::DecodeError;

/// A half-open box `[z0, z1) x [y0, y1) x [x0, x1)` in one level's voxels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct VolumeRegion {
    pub z0: u64,
    pub z1: u64,
    pub y0: u64,
    pub y1: u64,
    pub x0: u64,
    pub x1: u64,
}

impl VolumeRegion {
    fn dims(self) -> Option<[u64; 3]> {
        Some([
            self.z1.checked_sub(self.z0)?,
            self.y1.checked_sub(self.y0)?,
            self.x1.checked_sub(self.x0)?,
        ])
    }
}

/// Fetch a dense spatial subregion from one `(t, c, level)` source volume.
/// The returned buffer is row-major `[Z, Y, X]` over `region`, each sample in
/// the image's own data type as little-endian bytes, so a consumer computes
/// in the source's units.
pub(crate) async fn fetch_volume_region(
    image: &ImageSpec,
    t: u32,
    c: u32,
    level: usize,
    region: VolumeRegion,
    store: &Arc<CachedStore>,
    resolver: &ChunkResolver,
) -> Result<(Vec<u8>, [u32; 3]), RegionReadError> {
    let level_geom =
        image
            .multiscale
            .levels
            .get(level)
            .ok_or_else(|| RegionReadError::BadLevel {
                image: image.image_id.clone(),
                level,
            })?;

    let level_t = level_geom.shape[0];
    let level_c = level_geom.shape[1];
    if (t as u64) >= level_t || (c as u64) >= level_c {
        return Err(RegionReadError::OutOfBounds {
            image: image.image_id.clone(),
            t,
            c,
        });
    }

    let level_z = level_geom.shape[2];
    let level_y = level_geom.shape[3];
    let level_x = level_geom.shape[4];
    if region.z0 >= region.z1
        || region.y0 >= region.y1
        || region.x0 >= region.x1
        || region.z1 > level_z
        || region.y1 > level_y
        || region.x1 > level_x
    {
        return Err(RegionReadError::SpatialOutOfBounds {
            image: image.image_id.clone(),
            level,
        });
    }

    let chunk_z = level_geom.chunk_shape[2].max(1);
    let chunk_y = level_geom.chunk_shape[3].max(1);
    let chunk_x = level_geom.chunk_shape[4].max(1);

    let grid_z0 = region.z0 / chunk_z;
    let grid_y0 = region.y0 / chunk_y;
    let grid_x0 = region.x0 / chunk_x;
    let grid_z1 = (region.z1 - 1) / chunk_z;
    let grid_y1 = (region.y1 - 1) / chunk_y;
    let grid_x1 = (region.x1 - 1) / chunk_x;

    let [region_z, region_y, region_x] = region.dims().ok_or(RegionReadError::TooLarge)?;
    let total_voxels = (region_z as usize)
        .checked_mul(region_y as usize)
        .and_then(|v| v.checked_mul(region_x as usize))
        .ok_or(RegionReadError::TooLarge)?;
    let bytes_per_voxel = image.multiscale.data_type.size_bytes();
    let mut out = vec![
        0u8;
        total_voxels
            .checked_mul(bytes_per_voxel)
            .ok_or(RegionReadError::TooLarge)?
    ];

    for gz in grid_z0..=grid_z1 {
        for gy in grid_y0..=grid_y1 {
            for gx in grid_x0..=grid_x1 {
                let key = ChunkKey {
                    level: level as u32,
                    t: u64::from(t),
                    c: u64::from(c),
                    z: gz,
                    y: gy,
                    x: gx,
                };
                // Charged to the background class, not to a client: a
                // generated chunk is built once for every client waiting on
                // it, so there is no one client whose share it should come
                // out of. It competes for one fair share against the
                // interactive readers, which is what it is — one background
                // population, however many clients are waiting on it. No
                // probe: generation has no browser bracket to nest inside, so
                // its read timing is dropped.
                let read = read_chunk(
                    resolver,
                    store,
                    &image.image_id,
                    &key,
                    ReaderId::UNATTRIBUTED,
                    RequestLabel::UNATTRIBUTED,
                    None,
                )
                .await;
                let raw = match read {
                    Ok(ChunkRead::Present(raw)) => raw,
                    // `out` is already fill, so an absent chunk has nothing
                    // to copy.
                    Ok(ChunkRead::Absent { .. }) => continue,
                    Err(ChunkReadError::UnknownImage(image)) => {
                        return Err(RegionReadError::UnknownImage(image));
                    }
                    Err(ChunkReadError::UnknownLevel { image, level }) => {
                        return Err(RegionReadError::BadLevel {
                            image,
                            level: level as usize,
                        });
                    }
                    Err(ChunkReadError::ObjectStore(e)) => {
                        return Err(RegionReadError::Fetch {
                            image: image.image_id.clone(),
                            key: key.to_string(),
                            message: e.to_string(),
                        });
                    }
                    Err(ChunkReadError::Decode(source)) => {
                        return Err(RegionReadError::Decode {
                            image: image.image_id.clone(),
                            key: key.to_string(),
                            source,
                        });
                    }
                };

                // Edge truncation: the last grid cell on each axis may be
                // partial. Compute the in-bounds extent for this chunk.
                let z0 = gz * chunk_z;
                let y0 = gy * chunk_y;
                let x0 = gx * chunk_x;
                let z_end = (z0 + chunk_z).min(level_z);
                let y_end = (y0 + chunk_y).min(level_y);
                let x_end = (x0 + chunk_x).min(level_x);

                let copy_z0 = z0.max(region.z0);
                let copy_y0 = y0.max(region.y0);
                let copy_x0 = x0.max(region.x0);
                let copy_z1 = z_end.min(region.z1);
                let copy_y1 = y_end.min(region.y1);
                let copy_x1 = x_end.min(region.x1);

                // Each chunk is stored densely as `[chunk_z, chunk_y, chunk_x]`
                // in row-major order (X varies fastest), as little-endian
                // dtype bytes, the same layout `out` holds.
                let stride_z = (chunk_y * chunk_x) as usize;
                let stride_y = chunk_x as usize;

                let out_stride_y = region_x as usize;
                let out_stride_z = (region_y as usize) * out_stride_y;

                let expected_chunk_voxels =
                    (chunk_z as usize) * (chunk_y as usize) * (chunk_x as usize);
                if raw.len() < expected_chunk_voxels * bytes_per_voxel {
                    return Err(RegionReadError::ShortChunk {
                        image: image.image_id.clone(),
                        key: key.to_string(),
                        got: raw.len() / bytes_per_voxel,
                        expected: expected_chunk_voxels,
                    });
                }

                for z in copy_z0..copy_z1 {
                    for y in copy_y0..copy_y1 {
                        let local_z = z - z0;
                        let local_y = y - y0;
                        let local_x = copy_x0 - x0;
                        let in_off = (local_z as usize) * stride_z
                            + (local_y as usize) * stride_y
                            + local_x as usize;
                        let out_off = ((z - region.z0) as usize) * out_stride_z
                            + ((y - region.y0) as usize) * out_stride_y
                            + (copy_x0 - region.x0) as usize;
                        let row_len = (copy_x1 - copy_x0) as usize * bytes_per_voxel;
                        let in_byte_off = in_off * bytes_per_voxel;
                        let out_byte_off = out_off * bytes_per_voxel;
                        out[out_byte_off..out_byte_off + row_len]
                            .copy_from_slice(&raw[in_byte_off..in_byte_off + row_len]);
                    }
                }
            }
        }
    }

    let dims = [
        u32::try_from(region_z).map_err(|_| RegionReadError::TooLarge)?,
        u32::try_from(region_y).map_err(|_| RegionReadError::TooLarge)?,
        u32::try_from(region_x).map_err(|_| RegionReadError::TooLarge)?,
    ];

    Ok((out, dims))
}

/// Why a region could not be read.
#[derive(thiserror::Error, Debug)]
pub(crate) enum RegionReadError {
    #[error("level {level} out of range for image {image}")]
    BadLevel { image: ImageId, level: usize },
    #[error("requested t={t} or c={c} out of bounds for image {image}")]
    OutOfBounds { image: ImageId, t: u32, c: u32 },
    #[error("requested spatial region out of bounds for image {image} level {level}")]
    SpatialOutOfBounds { image: ImageId, level: usize },
    #[error("unknown image in resolver: {0}")]
    UnknownImage(ImageId),
    #[error("fetch failed for image {image} chunk {key}: {message}")]
    Fetch {
        image: ImageId,
        key: String,
        message: String,
    },
    #[error("decode failed for image {image} chunk {key}: {source}")]
    Decode {
        image: ImageId,
        key: String,
        #[source]
        source: DecodeError,
    },
    #[error("chunk {key} for {image} too short: got {got}, expected {expected}")]
    ShortChunk {
        image: ImageId,
        key: String,
        got: usize,
        expected: usize,
    },
    #[error("requested region too large to fit in memory")]
    TooLarge,
}
