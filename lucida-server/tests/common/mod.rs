//! Shared helpers for proxy-related integration tests.
//!
//! Provides:
//! - [`InstrumentedStore`]: an `ObjectStore` wrapper that counts `get`
//!   calls and can introduce per-call delays to make timing-sensitive
//!   tests deterministic.
//! - [`build_single_tile_dataset`]: builds a `DatasetManifest`, a
//!   `ChunkResolver`, and a populated `CachedStore` for a single
//!   TileProxy3D-shaped image with a configurable level grid.

#![allow(dead_code)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::BoxStream;
use lucida_content::{
    Axis, AxisKind, DataType, DatasetId, DatasetKind, DatasetManifest, Entity, EntityId,
    EntityKind, EntityLabels, ImageId, ImageSpec, LevelGeometry, MultiscaleInfo,
};
use lucida_server::binding::ChunkResolver;
use lucida_store::cache::CachedStore;
use lucida_store::import_types::{ImageBindingSeed, ServerBindingSeed};
use object_store::path::Path;
use object_store::{
    GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta, ObjectStore,
    PutMultipartOptions, PutOptions, PutPayload, PutResult,
};

/// `ObjectStore` decorator that counts `get_opts` calls and optionally
/// sleeps before each fetch. Used to verify in-flight dedup and bounded
/// concurrency in proxy generator tests.
#[derive(Debug)]
pub struct InstrumentedStore {
    inner: Arc<dyn ObjectStore>,
    pub get_count: Arc<AtomicUsize>,
    pub active_count: Arc<AtomicUsize>,
    pub max_active: Arc<AtomicUsize>,
    pub delay_ms: u64,
}

impl InstrumentedStore {
    pub fn new(inner: Arc<dyn ObjectStore>, delay_ms: u64) -> Self {
        Self {
            inner,
            get_count: Arc::new(AtomicUsize::new(0)),
            active_count: Arc::new(AtomicUsize::new(0)),
            max_active: Arc::new(AtomicUsize::new(0)),
            delay_ms,
        }
    }
}

impl std::fmt::Display for InstrumentedStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "InstrumentedStore({})", self.inner)
    }
}

#[async_trait::async_trait]
impl ObjectStore for InstrumentedStore {
    async fn put_opts(
        &self,
        location: &Path,
        payload: PutPayload,
        opts: PutOptions,
    ) -> object_store::Result<PutResult> {
        self.inner.put_opts(location, payload, opts).await
    }

    async fn put_multipart_opts(
        &self,
        location: &Path,
        opts: PutMultipartOptions,
    ) -> object_store::Result<Box<dyn MultipartUpload>> {
        self.inner.put_multipart_opts(location, opts).await
    }

    async fn get_opts(
        &self,
        location: &Path,
        options: GetOptions,
    ) -> object_store::Result<GetResult> {
        self.get_count.fetch_add(1, Ordering::SeqCst);
        let active = self.active_count.fetch_add(1, Ordering::SeqCst) + 1;
        let mut prev_max = self.max_active.load(Ordering::SeqCst);
        while active > prev_max {
            match self.max_active.compare_exchange(
                prev_max,
                active,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(p) => prev_max = p,
            }
        }
        if self.delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
        }
        let result = self.inner.get_opts(location, options).await;
        self.active_count.fetch_sub(1, Ordering::SeqCst);
        result
    }

    async fn delete(&self, location: &Path) -> object_store::Result<()> {
        self.inner.delete(location).await
    }

    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, object_store::Result<ObjectMeta>> {
        self.inner.list(prefix)
    }

    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> object_store::Result<ListResult> {
        self.inner.list_with_delimiter(prefix).await
    }

    async fn copy(&self, from: &Path, to: &Path) -> object_store::Result<()> {
        self.inner.copy(from, to).await
    }

    async fn copy_if_not_exists(&self, from: &Path, to: &Path) -> object_store::Result<()> {
        self.inner.copy_if_not_exists(from, to).await
    }
}

/// Bundle of state for a synthetic single-field dataset suitable for
/// `TileProxy3D` generation. The store is populated with one chunk per
/// `(z, y, x)` cell in `level_grid_shape`; each chunk holds
/// `level_chunk_shape` worth of u16s where every voxel equals
/// `(z * 100 + y * 10 + x) % u16::MAX`. The exact contents don't matter
/// for the generator tests — only that decode/assembly succeed.
pub struct SyntheticDataset {
    pub manifest: Arc<DatasetManifest>,
    pub resolver: Arc<ChunkResolver>,
    pub instrumented: Arc<InstrumentedStore>,
    pub cache: Arc<CachedStore>,
    pub image_id: ImageId,
    pub entity_id: EntityId,
}

/// Build a synthetic single-image dataset with one level. `level_shape`
/// is `[T, C, Z, Y, X]`; `chunk_shape` is the per-chunk voxel count.
/// Grid shape is computed via `ceil(shape / chunk_shape)`.
pub async fn build_single_tile_dataset(
    level_shape: [u64; 5],
    chunk_shape: [u64; 5],
    delay_ms: u64,
) -> SyntheticDataset {
    let entity_id = EntityId("entity-0".into());
    let image_id = ImageId("image-0".into());

    let grid_shape = [
        ceil_div(level_shape[0], chunk_shape[0].max(1)),
        ceil_div(level_shape[1], chunk_shape[1].max(1)),
        ceil_div(level_shape[2], chunk_shape[2].max(1)),
        ceil_div(level_shape[3], chunk_shape[3].max(1)),
        ceil_div(level_shape[4], chunk_shape[4].max(1)),
    ];

    let manifest = DatasetManifest::new(
        DatasetId("ds-test".into()),
        "test".into(),
        DatasetKind::Single,
        vec![Entity {
            id: entity_id.clone(),
            kind: EntityKind::Image,
            parent: None,
            labels: EntityLabels {
                name: Some("entity".into()),
                ..Default::default()
            },
        }],
        vec![],
        vec![ImageSpec {
            image_id: image_id.clone(),
            owner: entity_id.clone(),
            multiscale: MultiscaleInfo {
                axes: vec![
                    Axis {
                        name: "t".into(),
                        kind: AxisKind::Time,
                    },
                    Axis {
                        name: "c".into(),
                        kind: AxisKind::Channel,
                    },
                    Axis {
                        name: "z".into(),
                        kind: AxisKind::Space,
                    },
                    Axis {
                        name: "y".into(),
                        kind: AxisKind::Space,
                    },
                    Axis {
                        name: "x".into(),
                        kind: AxisKind::Space,
                    },
                ],
                levels: vec![LevelGeometry {
                    level_index: 0,
                    shape: level_shape,
                    chunk_shape,
                    grid_shape,
                    scale: [1.0; 5],
                }],
                coarse_level_index: None,
                generated_levels: vec![],
                data_type: DataType::Uint16,
                pinned_axes: vec![],
                downsampling_method: None,
                channel_infos: vec![],
            },
        }],
        vec![],
        None,
    );

    let resolver = Arc::new(ChunkResolver::new(&ServerBindingSeed {
        images: vec![ImageBindingSeed {
            image_id: image_id.clone(),
            axes_names: vec!["t".into(), "c".into(), "z".into(), "y".into(), "x".into()],
            store_prefix: None,
            // No per-level info → ChunkResolver::level_info returns None for
            // every level lookup; the chunk-fetch path then falls back to
            // StorageCompression::None and no slicing, matching the raw
            // bytes we put into the store below.
            levels: vec![],
        }],
    }));

    let mem: Arc<dyn ObjectStore> = Arc::new(object_store::memory::InMemory::new());
    let chunk_voxels =
        (chunk_shape[2] as usize) * (chunk_shape[3] as usize) * (chunk_shape[4] as usize);

    // Populate the store with a chunk for each (t, c, z, y, x) grid cell.
    // Even if we only ever request t=0,c=0 we put everything for sanity.
    for t in 0..grid_shape[0] {
        for c in 0..grid_shape[1] {
            for z in 0..grid_shape[2] {
                for y in 0..grid_shape[3] {
                    for x in 0..grid_shape[4] {
                        let key = format!("0/{t}/{c}/{z}/{y}/{x}");
                        let location = resolver
                            .resolve(&image_id, &key)
                            .expect("resolver should map all keys");
                        let bytes = make_chunk_bytes(chunk_voxels, t, c, z, y, x);
                        mem.put(location.path(), PutPayload::from(bytes))
                            .await
                            .expect("put");
                    }
                }
            }
        }
    }

    let instrumented = Arc::new(InstrumentedStore::new(mem.clone(), delay_ms));
    let cache = Arc::new(CachedStore::new(instrumented.clone(), 16 * 1024 * 1024));

    SyntheticDataset {
        manifest: Arc::new(manifest),
        resolver,
        instrumented,
        cache,
        image_id,
        entity_id,
    }
}

/// `(level / chunk_size).ceil()` — used to compute `grid_shape` from
/// `level_shape` and `chunk_shape` without f64 round-trip.
fn ceil_div(n: u64, d: u64) -> u64 {
    if d == 0 { n } else { n.div_ceil(d) }
}

fn make_chunk_bytes(voxel_count: usize, t: u64, c: u64, z: u64, y: u64, x: u64) -> Bytes {
    // Tag every voxel with the chunk's grid coords so a reassembled
    // volume has identifiable values; chunks deeper into the grid pick
    // up larger values. The exact pattern doesn't matter — generator
    // tests only check call counts / timing.
    let stamp = ((t * 31 + c * 29 + z * 23 + y * 19 + x * 17) & 0xFFFF) as u16;
    let mut bytes = Vec::with_capacity(voxel_count * 2);
    for _ in 0..voxel_count {
        bytes.extend_from_slice(&stamp.to_le_bytes());
    }
    Bytes::from(bytes)
}
