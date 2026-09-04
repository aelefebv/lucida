//! Shared fixtures for server-side unit tests.
use futures_util::StreamExt as _;
use lucida_content::{
    Axis, AxisKind, DataType, DatasetId, DatasetKind, DatasetManifest, Entity, EntityId,
    EntityKind, EntityLabels, ImageId, ImageSpec, LevelGeometry, MultiscaleInfo,
};
use lucida_store::import_types::{ImageBindingSeed, ServerBindingSeed};
use lucida_store::layout::ChunkByteLayout;
use object_store::path::Path;

use crate::binding::LevelInfo;
use crate::decode::StorageCompression;

pub(crate) fn four_byte_level() -> LevelInfo {
    LevelInfo {
        level_index: 0,
        compression: StorageCompression::None,
        chunk_shape: vec![1, 1, 1, 1, 2],
        chunk_byte_layout: ChunkByteLayout {
            canonical_byte_size: 4,
            on_disk_byte_size: 4,
            byte_stride_t: 0,
            byte_stride_c: 0,
            chunk_size_t: 1,
            chunk_size_c: 1,
        },
        shard: None,
    }
}

/// An in-memory `ObjectStore` that sleeps `delay` before every read, so a
/// test can tell one backend round trip from two by the time a row reports.
#[derive(Debug)]
pub(crate) struct DelayedStore {
    inner: object_store::memory::InMemory,
    delay: std::time::Duration,
}

impl DelayedStore {
    pub(crate) fn new(delay: std::time::Duration) -> Self {
        DelayedStore {
            inner: object_store::memory::InMemory::new(),
            delay,
        }
    }
}

impl std::fmt::Display for DelayedStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DelayedStore({:?})", self.delay)
    }
}

#[async_trait::async_trait]
impl object_store::ObjectStore for DelayedStore {
    async fn put_opts(
        &self,
        location: &Path,
        payload: object_store::PutPayload,
        opts: object_store::PutOptions,
    ) -> object_store::Result<object_store::PutResult> {
        self.inner.put_opts(location, payload, opts).await
    }

    async fn put_multipart_opts(
        &self,
        location: &Path,
        opts: object_store::PutMultipartOptions,
    ) -> object_store::Result<Box<dyn object_store::MultipartUpload>> {
        self.inner.put_multipart_opts(location, opts).await
    }

    async fn get_opts(
        &self,
        location: &Path,
        options: object_store::GetOptions,
    ) -> object_store::Result<object_store::GetResult> {
        tokio::time::sleep(self.delay).await;
        self.inner.get_opts(location, options).await
    }

    async fn delete(&self, location: &Path) -> object_store::Result<()> {
        self.inner.delete(location).await
    }

    fn list(
        &self,
        prefix: Option<&Path>,
    ) -> futures_util::stream::BoxStream<'static, object_store::Result<object_store::ObjectMeta>>
    {
        self.inner.list(prefix)
    }

    async fn list_with_delimiter(
        &self,
        prefix: Option<&Path>,
    ) -> object_store::Result<object_store::ListResult> {
        self.inner.list_with_delimiter(prefix).await
    }

    async fn copy(&self, from: &Path, to: &Path) -> object_store::Result<()> {
        self.inner.copy(from, to).await
    }

    async fn copy_if_not_exists(&self, from: &Path, to: &Path) -> object_store::Result<()> {
        self.inner.copy_if_not_exists(from, to).await
    }
}

pub(crate) fn image_seed(image: &str, levels: Vec<LevelInfo>) -> ServerBindingSeed {
    ServerBindingSeed {
        images: vec![ImageBindingSeed {
            image_id: ImageId(image.into()),
            axes_names: ["t", "c", "z", "y", "x"].map(String::from).to_vec(),
            store_prefix: None,
            levels,
        }],
    }
}

/// Which error class [`FailingStore`] fabricates for every read.
#[derive(Debug, Clone, Copy)]
pub(crate) enum StoreFailure {
    PermissionDenied,
    Backend,
}

/// An `ObjectStore` whose reads always fail with the configured error
/// class, standing in for a source whose credentials were revoked or
/// whose backend is down after a successful open.
#[derive(Debug)]
pub(crate) struct FailingStore(pub(crate) StoreFailure);

impl FailingStore {
    fn error(&self) -> object_store::Error {
        match self.0 {
            StoreFailure::PermissionDenied => object_store::Error::PermissionDenied {
                path: "chunk".into(),
                source: "403 Forbidden".to_string().into(),
            },
            StoreFailure::Backend => object_store::Error::Generic {
                store: "failing-store",
                source: "503 Service Unavailable".to_string().into(),
            },
        }
    }
}

impl std::fmt::Display for FailingStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "FailingStore({:?})", self.0)
    }
}

#[async_trait::async_trait]
impl object_store::ObjectStore for FailingStore {
    async fn put_opts(
        &self,
        _location: &Path,
        _payload: object_store::PutPayload,
        _opts: object_store::PutOptions,
    ) -> object_store::Result<object_store::PutResult> {
        Err(self.error())
    }

    async fn put_multipart_opts(
        &self,
        _location: &Path,
        _opts: object_store::PutMultipartOptions,
    ) -> object_store::Result<Box<dyn object_store::MultipartUpload>> {
        Err(self.error())
    }

    async fn get_opts(
        &self,
        _location: &Path,
        _options: object_store::GetOptions,
    ) -> object_store::Result<object_store::GetResult> {
        Err(self.error())
    }

    async fn delete(&self, _location: &Path) -> object_store::Result<()> {
        Err(self.error())
    }

    fn list(
        &self,
        _prefix: Option<&Path>,
    ) -> futures_util::stream::BoxStream<'static, object_store::Result<object_store::ObjectMeta>>
    {
        futures_util::stream::empty().boxed()
    }

    async fn list_with_delimiter(
        &self,
        _prefix: Option<&Path>,
    ) -> object_store::Result<object_store::ListResult> {
        Err(self.error())
    }

    async fn copy(&self, _from: &Path, _to: &Path) -> object_store::Result<()> {
        Err(self.error())
    }

    async fn copy_if_not_exists(&self, _from: &Path, _to: &Path) -> object_store::Result<()> {
        Err(self.error())
    }
}

pub(crate) fn single_image_manifest() -> DatasetManifest {
    let entity_id = EntityId("entity-1".into());
    DatasetManifest::new(
        DatasetId("ds-1".into()),
        "test".into(),
        DatasetKind::Single,
        vec![Entity {
            id: entity_id.clone(),
            kind: EntityKind::Image,
            parent: None,
            labels: EntityLabels::default(),
        }],
        vec![],
        vec![ImageSpec {
            image_id: ImageId("img-1".into()),
            owner: entity_id,
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
                    shape: [1, 1, 1, 256, 256],
                    chunk_shape: [1, 1, 1, 128, 128],
                    grid_shape: [1, 1, 1, 2, 2],
                    scale: [1.0, 1.0, 1.0, 1.0, 1.0],
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
    )
}
