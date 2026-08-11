//! Adapter from the server's async `CachedStore` to the synchronous
//! [`ProxySourceData`] trait expected by `lucida-proxy`.
//!
//! The trick: rather than block_on inside the trait impl, we **pre-fetch
//! all chunks** the requested proxy needs (under a tokio task) into an
//! in-memory `ServerProxySource`, then call `generate_proxy()` against
//! that. The trait impl just looks up the pre-loaded volume by
//! `(image_id, t, c, level)`.
//!
//! For the MVP this means each `ProxyGenerator::request` does one full
//! read of the source data per generation. That's fine: we only generate
//! once per `(spec, source_hash)` and the result is cached on disk.

use std::collections::HashMap;
use std::sync::Arc;

use lucida_content::{
    DataType, DatasetManifest, EntityId, EntityKind, ImageId, ImageSpec, VoxelTransform,
};
use lucida_proxy::{ProxyKind, ProxySourceData, ProxySpec, SourceError, TileVolume};
use lucida_store::cache::CachedStore;
use lucida_store::source_limiter::ReaderId;
use object_store::path::Path;

use crate::binding::ChunkResolver;
use crate::decode::{DecodeError, decode_storage_bytes};

/// In-memory pre-fetched volumes for a single `ProxyGenerator::request`.
/// Implements [`ProxySourceData`] by lookup; never performs I/O.
pub struct ServerProxySource {
    /// Keyed by `(image_id.0, t, c, level)`.
    volumes: HashMap<VolumeKey, OwnedTileVolume>,
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct VolumeKey {
    image_id: String,
    t: u32,
    c: u32,
    level: usize,
}

struct OwnedTileVolume {
    data: Vec<u16>,
    dims: [u32; 3],
    voxel_to_image: VoxelTransform,
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

impl ServerProxySource {
    /// Construct an empty source. Tests use this; production callers go
    /// through [`build_server_proxy_source`].
    pub fn empty() -> Self {
        Self {
            volumes: HashMap::new(),
        }
    }

    /// Insert a pre-decoded volume.
    #[allow(clippy::too_many_arguments)]
    pub fn insert(
        &mut self,
        image_id: &ImageId,
        t: u32,
        c: u32,
        level: usize,
        data: Vec<u16>,
        dims: [u32; 3],
        voxel_to_image: VoxelTransform,
    ) {
        self.volumes.insert(
            VolumeKey {
                image_id: image_id.0.clone(),
                t,
                c,
                level,
            },
            OwnedTileVolume {
                data,
                dims,
                voxel_to_image,
            },
        );
    }
}

impl ProxySourceData for ServerProxySource {
    fn read_tile_volume(
        &self,
        image_id: &ImageId,
        t: u32,
        c: u32,
        level: usize,
    ) -> Result<TileVolume, SourceError> {
        let key = VolumeKey {
            image_id: image_id.0.clone(),
            t,
            c,
            level,
        };
        self.volumes
            .get(&key)
            .map(|v| TileVolume {
                data: v.data.clone(),
                dims: v.dims,
                voxel_to_image: v.voxel_to_image.clone(),
            })
            .ok_or(SourceError::NotFound)
    }
}

/// Pre-fetch all chunks needed to satisfy `spec` from `store`, decode
/// them, and assemble dense `(Z, Y, X)` u16 volumes per image.
///
/// For a `TileProxy3D` this fetches one image (the entity's image). For
/// a `GroupProxy3D` it fetches one image per tile child. For each image
/// we pick the same level [`lucida_proxy`] would (`pick_level`) and read
/// every chunk in that level's grid for `(t, c)`, decompressing per
/// `ChunkResolver::storage_compression`.
pub async fn build_server_proxy_source(
    spec: &ProxySpec,
    content: &DatasetManifest,
    store: &Arc<CachedStore>,
    resolver: &ChunkResolver,
) -> Result<ServerProxySource, BuildSourceError> {
    let entity = content
        .entities()
        .iter()
        .find(|e| e.id == spec.entity_id)
        .ok_or_else(|| BuildSourceError::MissingEntity(spec.entity_id.clone()))?;

    // Determine which images contribute to this proxy.
    let image_ids: Vec<&ImageSpec> = match spec.kind {
        ProxyKind::TileProxy3D => {
            // Single image owned by the entity.
            let img = content
                .images()
                .iter()
                .find(|i| i.owner == entity.id)
                .ok_or_else(|| BuildSourceError::MissingImage(entity.id.clone()))?;
            vec![img]
        }
        ProxyKind::GroupProxy3D => {
            if !matches!(entity.kind, EntityKind::Group) {
                // Treat non-group entities the same way `aggregate_group`
                // does: fall back to TileProxy semantics. This keeps the
                // pre-fetch consistent with `generate_proxy`'s dispatch.
                let img = content
                    .images()
                    .iter()
                    .find(|i| i.owner == entity.id)
                    .ok_or_else(|| BuildSourceError::MissingImage(entity.id.clone()))?;
                vec![img]
            } else {
                let mut imgs: Vec<&ImageSpec> = Vec::new();
                for child in content.entities().iter().filter(|c| {
                    matches!(c.kind, EntityKind::Tile) && c.parent.as_ref() == Some(&entity.id)
                }) {
                    let img = content
                        .images()
                        .iter()
                        .find(|i| i.owner == child.id)
                        .ok_or_else(|| BuildSourceError::MissingImage(child.id.clone()))?;
                    imgs.push(img);
                }
                if imgs.is_empty() {
                    return Err(BuildSourceError::NoTiles(entity.id.clone()));
                }
                imgs
            }
        }
    };

    let mut source = ServerProxySource::empty();
    for image in image_ids {
        let level_index = pick_level(image, spec.target_long_axis);
        let (data, dims, voxel_to_image) =
            fetch_dense_volume(content, image, spec.t, spec.c, level_index, store, resolver)
                .await?;
        source.insert(
            &image.image_id,
            spec.t,
            spec.c,
            level_index,
            data,
            dims,
            voxel_to_image,
        );
    }

    Ok(source)
}

/// Mirrors `lucida_proxy::generate::pick_level`. We can't reach that
/// private fn directly; reproducing it here is short and stable (the
/// algorithm version bumps if it ever changes).
fn pick_level(image: &ImageSpec, target_long_axis: u32) -> usize {
    let levels = &image.multiscale.levels;
    if levels.is_empty() {
        return 0;
    }
    let threshold = (target_long_axis as u64).saturating_mul(2);
    let mut chosen = 0usize;
    for (i, level) in levels.iter().enumerate() {
        let z = level.shape[2];
        let y = level.shape[3];
        let x = level.shape[4];
        let min_spatial = z.min(y).min(x);
        if min_spatial >= threshold {
            chosen = i;
        }
    }
    if chosen == 0 && levels[0].shape[2..5].iter().copied().min().unwrap_or(0) < threshold {
        chosen = levels.len() - 1;
    }
    chosen
}

/// Fetch every chunk in `image`'s `level` grid for `(t, c)`, decompress
/// each, and assemble a dense `[Z, Y, X]` u16 buffer of the level's
/// spatial shape. Returns `(data, dims, voxel_to_image)`.
pub(crate) async fn fetch_dense_volume(
    content: &DatasetManifest,
    image: &ImageSpec,
    t: u32,
    c: u32,
    level: usize,
    store: &Arc<CachedStore>,
    resolver: &ChunkResolver,
) -> Result<(Vec<u16>, [u32; 3], VoxelTransform), BuildSourceError> {
    let level_geom =
        image
            .multiscale
            .levels
            .get(level)
            .ok_or_else(|| BuildSourceError::BadLevel {
                image: image.image_id.clone(),
                level,
            })?;

    let level_z = level_geom.shape[2];
    let level_y = level_geom.shape[3];
    let level_x = level_geom.shape[4];
    let region = VolumeRegion {
        z0: 0,
        z1: level_z,
        y0: 0,
        y1: level_y,
        x0: 0,
        x1: level_x,
    };
    let (out, dims) =
        fetch_volume_region(content, image, t, c, level, region, store, resolver).await?;

    // voxel_to_image: maps level-`level` voxel coords to full-res image-space
    // (= level-0 voxel space). The aggregator composes this with tile_to_group
    // (in full-res voxel units) to compute the group's AABB. Without this scale,
    // a level-k voxel is treated as 1 full-res voxel and tiles shrink to
    // `full_res / 2^k` in the proxy — see #417.
    //
    // Shape ratio is more robust than OME-Zarr per-level `scale` metadata
    // (which may be missing or incorrect) and gives the downsampling factor
    // the aggregator actually needs.
    let level0 = &image.multiscale.levels[0];
    let scale_axis = |full: u64, lvl: u64| -> f64 {
        if lvl == 0 {
            1.0
        } else {
            full as f64 / lvl as f64
        }
    };
    let sx = scale_axis(level0.shape[4], level_x);
    let sy = scale_axis(level0.shape[3], level_y);
    let sz = scale_axis(level0.shape[2], level_z);
    let level_voxel_to_image = VoxelTransform::from_voxel_matrix([
        sx, 0.0, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 0.0, sz, 0.0, 0.0, 0.0, 0.0, 1.0,
    ]);

    // Compose with any explicit owner→owner self-edge if present (none today,
    // but preserves forward-compatibility with future content-graph emitters).
    let owner_self = find_voxel_to_image(content, &image.owner);
    let voxel_to_image = compose_self_edge(&owner_self, &level_voxel_to_image);

    Ok((out, dims, voxel_to_image))
}

/// Fetch a dense spatial subregion from one `(t, c, level)` source volume.
/// The returned buffer is row-major `[Z, Y, X]` over `region`, normalized to
/// the generator/proxy u16 working representation.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fetch_volume_region(
    _content: &DatasetManifest,
    image: &ImageSpec,
    t: u32,
    c: u32,
    level: usize,
    region: VolumeRegion,
    store: &Arc<CachedStore>,
    resolver: &ChunkResolver,
) -> Result<(Vec<u16>, [u32; 3]), BuildSourceError> {
    let level_geom =
        image
            .multiscale
            .levels
            .get(level)
            .ok_or_else(|| BuildSourceError::BadLevel {
                image: image.image_id.clone(),
                level,
            })?;

    let level_t = level_geom.shape[0];
    let level_c = level_geom.shape[1];
    if (t as u64) >= level_t || (c as u64) >= level_c {
        return Err(BuildSourceError::OutOfBounds {
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
        return Err(BuildSourceError::SpatialOutOfBounds {
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

    let [region_z, region_y, region_x] = region.dims().ok_or(BuildSourceError::TooLarge)?;
    let total_voxels = (region_z as usize)
        .checked_mul(region_y as usize)
        .and_then(|v| v.checked_mul(region_x as usize))
        .ok_or(BuildSourceError::TooLarge)?;
    let mut out = vec![0u16; total_voxels];

    // Per-level compression + byte-slicing layout. Defensive: a missing
    // level_info (older snapshot or test fixture without per-level info)
    // falls back to no compression and no slicing.
    let level_info = resolver
        .level_info(&image.image_id, level as u32)
        .unwrap_or(crate::binding::LevelInfo {
            level_index: level as u32,
            compression: crate::decode::StorageCompression::None,
            chunk_shape: Vec::new(),
            chunk_byte_layout: lucida_store::layout::ChunkByteLayout {
                canonical_byte_size: 0,
                on_disk_byte_size: 0,
                byte_stride_t: 0,
                byte_stride_c: 0,
                chunk_size_t: 1,
                chunk_size_c: 1,
            },
        });

    for gz in grid_z0..=grid_z1 {
        for gy in grid_y0..=grid_y1 {
            for gx in grid_x0..=grid_x1 {
                // Canonical 5D chunk key: "{level}/{t}/{c}/{z}/{y}/{x}".
                let key = format!("{level}/{t}/{c}/{gz}/{gy}/{gx}");
                let object_path = resolver
                    .resolve(&image.image_id, &key)
                    .ok_or_else(|| BuildSourceError::UnknownImage(image.image_id.clone()))?;
                // Charged to the background class, not to a client: proxy
                // generation is coalesced across every client that asked for
                // the same spec, so there is no one client whose share it
                // should come out of. It competes for one fair share against
                // the interactive readers, which is what it is — one
                // background population, however many clients are waiting on
                // it.
                let storage_bytes = match store
                    .get_bytes(&Path::from(object_path.as_str()), ReaderId::UNATTRIBUTED)
                    .await
                {
                    Ok(bytes) => bytes,
                    Err(e) if is_not_found(&e) => {
                        continue;
                    }
                    Err(e) => {
                        return Err(BuildSourceError::Fetch {
                            image: image.image_id.clone(),
                            key: key.clone(),
                            message: e.to_string(),
                        });
                    }
                };

                let mut raw = decode_storage_bytes(&storage_bytes, level_info.compression)
                    .map_err(|e| BuildSourceError::Decode {
                        image: image.image_id.clone(),
                        key: key.clone(),
                        source: e,
                    })?;
                // Slice down to the canonical (1 t × 1 c × all z × all y × all x)
                // byte range — see [`lucida_store::layout`]. The proxy
                // generator iterates one (t, c) at a time, so wire t/c are the
                // values it just wrote into the chunk key.
                let (offset, size) = level_info.chunk_byte_layout.slice_range(t as u64, c as u64);
                if size > 0 && offset.checked_add(size).is_some_and(|end| end <= raw.len()) {
                    raw = raw[offset..offset + size].to_vec();
                }

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
                    return Err(BuildSourceError::ShortChunk {
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
        u32::try_from(region_z).map_err(|_| BuildSourceError::TooLarge)?,
        u32::try_from(region_y).map_err(|_| BuildSourceError::TooLarge)?,
        u32::try_from(region_x).map_err(|_| BuildSourceError::TooLarge)?,
    ];

    Ok((out, dims))
}

/// Compose `owner_self ∘ level_scale` (apply level scale first, then any
/// self-edge transform). Returns just `level_scale` if `owner_self` is identity.
fn compose_self_edge(owner_self: &VoxelTransform, level_scale: &VoxelTransform) -> VoxelTransform {
    if is_identity(owner_self) {
        return level_scale.clone();
    }
    // 4x4 column-major: result[col][row] = sum_k owner_self[k][row] * level_scale[col][k]
    let owner_m = owner_self.matrix();
    let level_m = level_scale.matrix();
    let mut out = [0.0f64; 16];
    for col in 0..4 {
        for row in 0..4 {
            let mut acc = 0.0;
            for k in 0..4 {
                acc += owner_m[k * 4 + row] * level_m[col * 4 + k];
            }
            out[col * 4 + row] = acc;
        }
    }
    VoxelTransform::from_voxel_matrix(out)
}

fn is_identity(t: &VoxelTransform) -> bool {
    t.matrix() == VoxelTransform::identity().matrix()
}

/// Try to find a `voxel → image-local` transform. The current import
/// pipeline does not emit such an edge per se; we look for a `image-owner →
/// image-owner` self-edge (used elsewhere in the graph) and fall back to
/// identity. Identity is the right behavior for single-tile datasets and
/// matches the test fixtures.
fn find_voxel_to_image(content: &DatasetManifest, owner: &EntityId) -> VoxelTransform {
    content
        .transforms()
        .iter()
        .find(|edge| &edge.from == owner && &edge.to == owner)
        .map(|edge| edge.transform.clone())
        .unwrap_or_else(VoxelTransform::identity)
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
        || error.to_string().contains("not found")
        || error.to_string().contains("No such file or directory")
}

/// Errors from [`build_server_proxy_source`]. Mapped onto
/// `GenerateError::Source` by the generator.
#[derive(thiserror::Error, Debug)]
pub enum BuildSourceError {
    #[error("entity not found in content graph: {0}")]
    MissingEntity(EntityId),
    #[error("image not found for entity: {0}")]
    MissingImage(EntityId),
    #[error("group has no tile children: {0}")]
    NoTiles(EntityId),
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
    #[error("requested level too large to fit in memory")]
    TooLarge,
}

impl From<BuildSourceError> for SourceError {
    fn from(e: BuildSourceError) -> Self {
        match e {
            BuildSourceError::MissingEntity(_)
            | BuildSourceError::MissingImage(_)
            | BuildSourceError::NoTiles(_)
            | BuildSourceError::OutOfBounds { .. }
            | BuildSourceError::SpatialOutOfBounds { .. }
            | BuildSourceError::BadLevel { .. } => SourceError::NotFound,
            other => SourceError::Io(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
