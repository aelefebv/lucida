//! Neutral source-volume reads shared by generated-coarse materialization and
//! any compatibility adapters.
//!
//! This module owns the storage/decode boundary for one dense spatial region.
//! It deliberately knows nothing about proxy catalogs, proxy generation, or
//! generated-coarse scheduling so those higher-level features can evolve or
//! retire independently.

use std::sync::Arc;

use lucida_content::{DataType, ImageId, ImageSpec};
use lucida_protocol::{FailureCode, FailureDescriptor};
use lucida_store::budget::{MemoryCategory, MemoryReservation};
use lucida_store::cache::CachedStore;
use object_store::path::Path;

use crate::binding::ChunkResolver;
use crate::decode::{DecodeError, decode_storage_bytes_exact};

/// Dense u16 working data whose lifetime holds its decoded-memory reservation.
pub(crate) struct BudgetedVolume {
    data: Vec<u16>,
    _reservation: Option<MemoryReservation>,
}

impl std::ops::Deref for BudgetedVolume {
    type Target = [u16];

    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

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
/// The returned buffer is row-major `[Z, Y, X]` over `region`, normalized to
/// the generator/proxy u16 working representation.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fetch_volume_region(
    image: &ImageSpec,
    t: u32,
    c: u32,
    level: usize,
    region: VolumeRegion,
    store: &Arc<CachedStore>,
    resolver: &ChunkResolver,
) -> Result<(BudgetedVolume, [u32; 3]), VolumeReadError> {
    let level_geom =
        image
            .multiscale
            .levels
            .get(level)
            .ok_or_else(|| VolumeReadError::BadLevel {
                image: image.image_id.clone(),
                level,
            })?;

    let level_t = level_geom.shape[0];
    let level_c = level_geom.shape[1];
    if (t as u64) >= level_t || (c as u64) >= level_c {
        return Err(VolumeReadError::OutOfBounds {
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
        return Err(VolumeReadError::SpatialOutOfBounds {
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

    let [region_z, region_y, region_x] = region.dims().ok_or(VolumeReadError::TooLarge)?;
    let total_voxels = (region_z as usize)
        .checked_mul(region_y as usize)
        .and_then(|v| v.checked_mul(region_x as usize))
        .ok_or(VolumeReadError::TooLarge)?;
    // `ProxySourceData` returns an owned `TileVolume`, so proxy generation
    // temporarily holds both this assembled volume and one clone. Reserve for
    // that worst case; generated-chunk callers are conservatively covered too.
    let resident_bytes = total_voxels
        .checked_mul(std::mem::size_of::<u16>())
        .and_then(|bytes| bytes.checked_mul(2))
        .ok_or(VolumeReadError::TooLarge)?;
    let output_reservation = store
        .reserve_resident(MemoryCategory::Decoded, resident_bytes)
        .ok_or(VolumeReadError::MemoryBudget {
            requested: resident_bytes,
        })?;
    let mut out = vec![0u16; total_voxels];

    // Per-level compression + byte-slicing layout was validated at import.
    // Missing binding metadata is an error; guessing would discard the byte
    // bound used by the decoder.
    let level_info = resolver
        .level_info(&image.image_id, level as u32)
        .ok_or_else(|| VolumeReadError::BadLevel {
            image: image.image_id.clone(),
            level,
        })?;

    for gz in grid_z0..=grid_z1 {
        for gy in grid_y0..=grid_y1 {
            for gx in grid_x0..=grid_x1 {
                // Canonical 5D chunk key: "{level}/{t}/{c}/{z}/{y}/{x}".
                let key = format!("{level}/{t}/{c}/{gz}/{gy}/{gx}");
                let object_path = resolver
                    .resolve(&image.image_id, &key)
                    .ok_or_else(|| VolumeReadError::UnknownImage(image.image_id.clone()))?;
                let storage_bytes = match store.get_bytes(&Path::from(object_path.as_str())).await {
                    Ok(bytes) => bytes,
                    Err(e) if is_not_found(&e) => {
                        continue;
                    }
                    Err(e) => {
                        return Err(VolumeReadError::Fetch {
                            image: image.image_id.clone(),
                            key: key.clone(),
                            source: e,
                        });
                    }
                };

                let decoded_bytes = level_info.chunk_byte_layout.on_disk_byte_size;
                let _decode_reservation = store
                    .reserve_resident(MemoryCategory::Decoded, decoded_bytes)
                    .ok_or(VolumeReadError::MemoryBudget {
                        requested: decoded_bytes,
                    })?;

                let raw = decode_storage_bytes_exact(
                    &storage_bytes,
                    level_info.compression,
                    level_info.chunk_byte_layout.on_disk_byte_size,
                )
                .map_err(|e| VolumeReadError::Decode {
                    image: image.image_id.clone(),
                    key: key.clone(),
                    source: e,
                })?;
                // Slice down to the canonical (1 t × 1 c × all z × all y × all x)
                // byte range — see [`lucida_store::layout`]. The proxy
                // generator iterates one (t, c) at a time, so wire t/c are the
                // values it just wrote into the chunk key.
                let slice = level_info
                    .chunk_byte_layout
                    .checked_slice_range(t as u64, c as u64)
                    .map_err(|error| VolumeReadError::Layout {
                        image: image.image_id.clone(),
                        key: key.clone(),
                        message: error.to_string(),
                    })?;
                let raw = &raw[slice];

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
                // dtype bytes. We normalize into the proxy/generator's u16
                // working representation while copying into the dense volume.
                let stride_z = (chunk_y * chunk_x) as usize;
                let stride_y = chunk_x as usize;
                let bytes_per_voxel = data_type_size(image.multiscale.data_type);

                let out_stride_y = region_x as usize;
                let out_stride_z = (region_y as usize) * out_stride_y;

                let expected_chunk_voxels =
                    (chunk_z as usize) * (chunk_y as usize) * (chunk_x as usize);
                if raw.len() < expected_chunk_voxels * bytes_per_voxel {
                    return Err(VolumeReadError::ShortChunk {
                        image: image.image_id.clone(),
                        key,
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
                        let len = (copy_x1 - copy_x0) as usize;
                        let in_byte_off = in_off * bytes_per_voxel;
                        let row_bytes = &raw[in_byte_off..in_byte_off + len * bytes_per_voxel];
                        for i in 0..len {
                            let start = i * bytes_per_voxel;
                            out[out_off + i] = sample_to_u16(
                                image.multiscale.data_type,
                                &row_bytes[start..start + bytes_per_voxel],
                            );
                        }
                    }
                }
            }
        }
    }

    let dims = [
        u32::try_from(region_z).map_err(|_| VolumeReadError::TooLarge)?,
        u32::try_from(region_y).map_err(|_| VolumeReadError::TooLarge)?,
        u32::try_from(region_x).map_err(|_| VolumeReadError::TooLarge)?,
    ];

    Ok((
        BudgetedVolume {
            data: out,
            _reservation: Some(output_reservation),
        },
        dims,
    ))
}

fn data_type_size(data_type: DataType) -> usize {
    match data_type {
        DataType::Uint8 => 1,
        DataType::Uint16 => 2,
        DataType::Uint32 | DataType::Float32 => 4,
        DataType::Float64 => 8,
    }
}

fn sample_to_u16(data_type: DataType, bytes: &[u8]) -> u16 {
    match data_type {
        DataType::Uint8 => bytes[0] as u16,
        DataType::Uint16 => u16::from_le_bytes([bytes[0], bytes[1]]),
        DataType::Uint32 => {
            let value = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            value.min(u16::MAX as u32) as u16
        }
        DataType::Float32 => {
            let value = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            unit_float_to_u16(value as f64)
        }
        DataType::Float64 => {
            let value = f64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ]);
            unit_float_to_u16(value)
        }
    }
}

fn unit_float_to_u16(value: f64) -> u16 {
    if !value.is_finite() {
        return 0;
    }
    (value.clamp(0.0, 1.0) * u16::MAX as f64).round() as u16
}

fn is_not_found(error: &object_store::Error) -> bool {
    matches!(error, object_store::Error::NotFound { .. })
}

/// Structural failures while reading and decoding a source-volume region.
#[derive(thiserror::Error, Debug)]
pub(crate) enum VolumeReadError {
    #[error("level {level} out of range for image {image}")]
    BadLevel { image: ImageId, level: usize },
    #[error("requested t={t} or c={c} out of bounds for image {image}")]
    OutOfBounds { image: ImageId, t: u32, c: u32 },
    #[error("requested spatial region out of bounds for image {image} level {level}")]
    SpatialOutOfBounds { image: ImageId, level: usize },
    #[error("unknown image in resolver: {0}")]
    UnknownImage(ImageId),
    #[error("fetch failed for image {image} chunk {key}: {source}")]
    Fetch {
        image: ImageId,
        key: String,
        #[source]
        source: object_store::Error,
    },
    #[error("decode failed for image {image} chunk {key}: {source}")]
    Decode {
        image: ImageId,
        key: String,
        #[source]
        source: DecodeError,
    },
    #[error("invalid byte layout for image {image} chunk {key}: {message}")]
    Layout {
        image: ImageId,
        key: String,
        message: String,
    },
    #[error("chunk {key} for {image} too short: got {got}, expected {expected}")]
    ShortChunk {
        image: ImageId,
        key: String,
        got: usize,
        expected: usize,
    },
    #[error("requested level too large to fit in memory")]
    TooLarge,
    #[error("process memory budget cannot reserve {requested} decoded bytes")]
    MemoryBudget { requested: usize },
}

impl VolumeReadError {
    /// Preserve the structural source/decode/bounds cause all the way to the
    /// generated-chunk terminal response. No display text participates.
    pub(crate) fn failure(&self) -> FailureDescriptor {
        match self {
            Self::UnknownImage(_) => FailureDescriptor::new(FailureCode::UnknownImage, false),
            Self::BadLevel { .. } | Self::OutOfBounds { .. } | Self::SpatialOutOfBounds { .. } => {
                FailureDescriptor::new(FailureCode::ChunkOutOfBounds, false)
            }
            Self::Fetch { source, .. } => lucida_store::backend::object_store_failure(source),
            Self::Decode { source, .. } => source.failure(),
            Self::Layout { .. } => FailureDescriptor::new(FailureCode::UnsupportedLayout, false),
            Self::ShortChunk { .. } => FailureDescriptor::new(FailureCode::DecodeFailure, false),
            Self::TooLarge => FailureDescriptor::new(FailureCode::ResourceLimit, false),
            Self::MemoryBudget { .. } => FailureDescriptor::new(FailureCode::ResourceLimit, true),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_objects_are_identified_by_variant_not_display_text() {
        let typed = object_store::Error::NotFound {
            path: "chunk".into(),
            source: "backend response".into(),
        };
        let misleading = object_store::Error::Generic {
            store: "test",
            source: "not found: No such file or directory".into(),
        };

        assert!(is_not_found(&typed));
        assert!(!is_not_found(&misleading));
    }

    #[test]
    fn normalizes_float32_samples_to_u16_unit_range() {
        let values = [-1.0_f32, 0.0, 0.5, 1.0, 2.0, f32::NAN];
        let out: Vec<u16> = values
            .iter()
            .map(|value| sample_to_u16(DataType::Float32, &value.to_le_bytes()))
            .collect();

        assert_eq!(out, vec![0, 0, 32768, 65535, 65535, 0]);
    }
}
