use std::collections::HashMap;
use std::sync::Arc;

use lucida_content::ImageId;
use lucida_content::url::SourceVersion;
use lucida_protocol::{DatasetOpened, FailureCode, FailureDescriptor};
use lucida_store::cache::CachedStore;
use lucida_store::import_types::{LevelBindingInfo, ServerBindingSeed};
use lucida_store::{ChunkKey, ChunkKeyError, ChunkKeyErrorCategory};
use object_store::ObjectStore;

use crate::generated_coarse::{DerivedChunkCache, GeneratedCoarseService};

/// Operational storage binding. Owns live resources.
/// Built from `ServerBindingSeed` + a typed source generation + store + cache.
///
/// `dataset_opened` is retained so that subsequent opens resolving to the
/// same source generation can reuse the live resources and rebroadcast the
/// canonical `DatasetOpened` to the requesting client.
///
/// Generated-coarse resources are scoped to the full locator identity and
/// source revision and live as long as the binding.
pub struct ServerBinding {
    pub source: SourceVersion,
    pub store: Arc<dyn ObjectStore>,
    pub resolver: Arc<ChunkResolver>,
    pub cache: Arc<CachedStore>,
    pub dataset_opened: DatasetOpened,
    pub derived_chunks: Arc<DerivedChunkCache>,
    pub generated_service: Arc<GeneratedCoarseService>,
    /// Human-readable non-fatal messages from importing this dataset (e.g.
    /// skipped collection groups). Retained so the Health tab can surface them
    /// durably after the transient open-progress trail has scrolled past.
    pub import_warnings: Vec<String>,
}

/// Compiled key-to-path mapper. Built once at import from per-image binding seeds.
/// Used per chunk request to resolve logical keys to object store paths and to
/// look up the per-level compression + byte-slicing info.
pub struct ChunkResolver {
    images: HashMap<ImageId, ImageResolver>,
}

struct ImageResolver {
    axes_names: Vec<String>,
    store_prefix: Option<String>,
    /// Per-level compression + byte layout, in level-index order. Cloned
    /// from the [`ImageBindingSeed`] at resolver build time so the
    /// chunk-fetch path doesn't need to re-validate codec chains.
    levels: Vec<LevelBindingInfo>,
}

/// Re-exported alias kept for downstream chunk-fetch call sites that
/// destructure the type by its old name.
pub type LevelInfo = LevelBindingInfo;

#[derive(thiserror::Error, Debug)]
pub enum ChunkResolveError {
    #[error("unknown image")]
    UnknownImage,
    #[error("invalid chunk key: {0}")]
    InvalidKey(#[from] ChunkKeyError),
    #[error("unknown level {0}")]
    UnknownLevel(u32),
    #[error("chunk coordinate {axis}={value} is outside bound {bound}")]
    OutOfBounds {
        axis: &'static str,
        value: u64,
        bound: u64,
    },
    #[error("invalid storage prefix")]
    InvalidPrefix,
}

impl ChunkResolveError {
    pub fn failure(&self) -> FailureDescriptor {
        let kind = match self {
            Self::UnknownImage => FailureCode::UnknownImage,
            Self::UnknownLevel(_) | Self::OutOfBounds { .. } => FailureCode::ChunkOutOfBounds,
            Self::InvalidKey(error) => match error.category {
                ChunkKeyErrorCategory::Syntax => FailureCode::InvalidChunkKey,
                ChunkKeyErrorCategory::Shape => FailureCode::MissingChunkMetadata,
                ChunkKeyErrorCategory::Bounds => FailureCode::ChunkOutOfBounds,
            },
            Self::InvalidPrefix => FailureCode::MissingChunkMetadata,
        };
        FailureDescriptor::new(kind, false)
    }

    pub fn public_message(&self) -> &'static str {
        match self {
            Self::UnknownImage => "chunk image is not present in the dataset binding",
            Self::UnknownLevel(_) => "chunk level is not present in the dataset binding",
            Self::InvalidKey(_) => "chunk key is invalid",
            Self::OutOfBounds { .. } => "chunk coordinate is outside the dataset bounds",
            Self::InvalidPrefix => "chunk storage metadata is invalid",
        }
    }
}

impl ChunkResolver {
    pub fn new(seed: &ServerBindingSeed) -> Self {
        let images = seed
            .images
            .iter()
            .map(|img| {
                let resolver = ImageResolver {
                    axes_names: img.axes_names.clone(),
                    store_prefix: img.store_prefix.clone(),
                    levels: img.levels.clone(),
                };
                (img.image_id.clone(), resolver)
            })
            .collect();
        ChunkResolver { images }
    }

    /// Look up per-level info (compression + byte layout + chunk shape) for
    /// a given image and level. Returns `None` if either the image or the
    /// level is unknown.
    pub fn level_info(&self, image_id: &ImageId, level: u32) -> Option<LevelInfo> {
        self.images.get(image_id).and_then(|img| {
            img.levels
                .iter()
                .find(|info| info.level_index == level)
                .cloned()
        })
    }

    /// Resolve a canonical chunk key to an object store path for a given
    /// image. Uses the per-level chunk_shape to translate wire `t`/`c` voxel
    /// coords into disk-grid coords. Any malformed or out-of-bounds input is
    /// rejected before object-store path construction.
    pub fn resolve(&self, image_id: &ImageId, key: &str) -> Option<String> {
        self.resolve_checked(image_id, key).ok()
    }

    pub fn resolve_checked(
        &self,
        image_id: &ImageId,
        raw_key: &str,
    ) -> Result<String, ChunkResolveError> {
        let image = self
            .images
            .get(image_id)
            .ok_or(ChunkResolveError::UnknownImage)?;
        let key: ChunkKey = raw_key.parse()?;
        let level = image
            .levels
            .iter()
            .find(|level| level.level_index == key.level)
            .ok_or(ChunkResolveError::UnknownLevel(key.level))?;

        for (axis, value, bound) in [
            ("t", key.t, level.shape[0]),
            ("c", key.c, level.shape[1]),
            ("z", key.z, level.grid_shape[2]),
            ("y", key.y, level.grid_shape[3]),
            ("x", key.x, level.grid_shape[4]),
        ] {
            if value >= bound {
                return Err(ChunkResolveError::OutOfBounds { axis, value, bound });
            }
        }

        let store_path = key.to_store_path(&image.axes_names, &level.chunk_shape)?;
        match &image.store_prefix {
            Some(prefix) if prefix_is_safe(prefix) => Ok(format!("{prefix}/{store_path}")),
            Some(_) => Err(ChunkResolveError::InvalidPrefix),
            None => Ok(store_path),
        }
    }
}

impl ServerBinding {
    pub fn is_generated_level(&self, image_id: &ImageId, level: u32) -> bool {
        self.derived_chunks.is_generated_level(image_id, level)
            || self
                .dataset_opened
                .manifest
                .images()
                .iter()
                .find(|image| image.image_id == *image_id)
                .is_some_and(|image| image.multiscale.is_generated_level(level))
    }
}

fn prefix_is_safe(prefix: &str) -> bool {
    !prefix.is_empty()
        && !prefix.starts_with('/')
        && prefix
            .split('/')
            .all(|component| !component.is_empty() && !matches!(component, "." | ".."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::ImageId;
    use lucida_store::codec::StorageCompression;
    use lucida_store::import_types::{ImageBindingSeed, ServerBindingSeed};
    use lucida_store::layout::ChunkByteLayout;

    fn make_seed(images: Vec<ImageBindingSeed>) -> ServerBindingSeed {
        ServerBindingSeed { images }
    }

    fn make_image_seed(id: &str, axes: Vec<&str>, prefix: Option<&str>) -> ImageBindingSeed {
        let rank = axes.len();
        ImageBindingSeed {
            image_id: ImageId(id.to_string()),
            axes_names: axes.into_iter().map(String::from).collect(),
            store_prefix: prefix.map(String::from),
            levels: vec![LevelBindingInfo {
                level_index: 0,
                compression: StorageCompression::None,
                chunk_shape: vec![1; rank],
                shape: [16; 5],
                grid_shape: [16; 5],
                chunk_byte_layout: ChunkByteLayout {
                    canonical_byte_size: 1,
                    on_disk_byte_size: 1,
                    byte_stride_t: 0,
                    byte_stride_c: 0,
                    chunk_size_t: 1,
                    chunk_size_c: 1,
                },
            }],
        }
    }

    /// Build an image seed with one level whose `chunk_shape` is provided.
    /// All other level fields are stub values — these tests only exercise
    /// resolve(), not the slice path.
    fn make_image_seed_with_chunk(
        id: &str,
        axes: Vec<&str>,
        chunk_shape: Vec<u64>,
    ) -> ImageBindingSeed {
        ImageBindingSeed {
            image_id: ImageId(id.to_string()),
            axes_names: axes.into_iter().map(String::from).collect(),
            store_prefix: None,
            levels: vec![LevelBindingInfo {
                level_index: 0,
                compression: StorageCompression::None,
                chunk_shape,
                shape: [8, 8, 8, 8, 8],
                grid_shape: [8, 8, 8, 8, 8],
                chunk_byte_layout: ChunkByteLayout {
                    canonical_byte_size: 0,
                    on_disk_byte_size: 0,
                    byte_stride_t: 0,
                    byte_stride_c: 0,
                    chunk_size_t: 1,
                    chunk_size_c: 1,
                },
            }],
        }
    }

    #[test]
    fn resolve_5d_no_prefix() {
        let seed = make_seed(vec![make_image_seed(
            "img1",
            vec!["t", "c", "z", "y", "x"],
            None,
        )]);
        let resolver = ChunkResolver::new(&seed);
        let path = resolver
            .resolve(&ImageId("img1".into()), "0/0/1/5/3/2")
            .unwrap();
        assert_eq!(path, "0/c/0/1/5/3/2");
    }

    #[test]
    fn resolve_3d_no_prefix() {
        let seed = make_seed(vec![make_image_seed("img1", vec!["z", "y", "x"], None)]);
        let resolver = ChunkResolver::new(&seed);
        let path = resolver
            .resolve(&ImageId("img1".into()), "0/0/0/5/3/2")
            .unwrap();
        let expected = lucida_store::chunk_key_to_store_path(
            "0/0/0/5/3/2",
            &["z".to_string(), "y".to_string(), "x".to_string()],
            &[1, 1, 1],
        );
        assert_eq!(path, expected);
    }

    #[test]
    fn resolve_c_bundled_divides_channel() {
        // lif_test-shaped binding. Wire c=3 with chunk_c=5 → disk c=0.
        let seed = make_seed(vec![make_image_seed_with_chunk(
            "lif",
            vec!["t", "c", "z", "y", "x"],
            vec![1, 5, 1, 1024, 1024],
        )]);
        let resolver = ChunkResolver::new(&seed);
        let path = resolver
            .resolve(&ImageId("lif".into()), "0/0/3/0/0/0")
            .unwrap();
        assert_eq!(path, "0/c/0/0/0/0/0");
    }

    #[test]
    fn resolve_with_store_prefix() {
        let seed = make_seed(vec![make_image_seed(
            "img1",
            vec!["t", "c", "z", "y", "x"],
            Some("A/1/0"),
        )]);
        let resolver = ChunkResolver::new(&seed);
        let path = resolver
            .resolve(&ImageId("img1".into()), "0/0/1/5/3/2")
            .unwrap();
        assert!(path.starts_with("A/1/0/"));
    }

    #[test]
    fn resolve_unknown_image() {
        let seed = make_seed(vec![make_image_seed(
            "img1",
            vec!["t", "c", "z", "y", "x"],
            None,
        )]);
        let resolver = ChunkResolver::new(&seed);
        assert!(
            resolver
                .resolve(&ImageId("unknown".into()), "2/0/1/5/3/2")
                .is_none()
        );
    }

    #[test]
    fn malformed_unknown_level_and_out_of_grid_keys_fail_closed() {
        let seed = make_seed(vec![make_image_seed(
            "img1",
            vec!["t", "c", "z", "y", "x"],
            None,
        )]);
        let resolver = ChunkResolver::new(&seed);
        for key in ["foo/bar", "0/0/0/0/../0", "9/0/0/0/0/0"] {
            assert!(resolver.resolve(&ImageId("img1".into()), key).is_none());
        }
        assert!(matches!(
            resolver.resolve_checked(&ImageId("img1".into()), "0/0/0/0/16/0"),
            Err(ChunkResolveError::OutOfBounds { axis: "y", .. })
        ));
    }

    #[test]
    fn unsafe_import_owned_prefix_fails_closed() {
        let seed = make_seed(vec![make_image_seed(
            "img1",
            vec!["y", "x"],
            Some("../secret"),
        )]);
        let resolver = ChunkResolver::new(&seed);
        assert!(matches!(
            resolver.resolve_checked(&ImageId("img1".into()), "0/0/0/0/0/0"),
            Err(ChunkResolveError::InvalidPrefix)
        ));
    }

    #[test]
    fn multi_image_resolver() {
        let seed = make_seed(vec![
            make_image_seed("img1", vec!["t", "c", "z", "y", "x"], None),
            make_image_seed("img2", vec!["z", "y", "x"], Some("B/2/0")),
            make_image_seed("img3", vec!["c", "y", "x"], None),
        ]);
        let resolver = ChunkResolver::new(&seed);

        // All three should resolve independently
        assert!(
            resolver
                .resolve(&ImageId("img1".into()), "0/0/0/0/0/0")
                .is_some()
        );
        assert!(
            resolver
                .resolve(&ImageId("img2".into()), "0/0/0/0/0/0")
                .is_some()
        );
        assert!(
            resolver
                .resolve(&ImageId("img3".into()), "0/0/0/0/0/0")
                .is_some()
        );

        // img2 should have prefix
        let path2 = resolver
            .resolve(&ImageId("img2".into()), "0/0/0/0/0/0")
            .unwrap();
        assert!(path2.starts_with("B/2/0/"));

        // img1 and img3 should not have prefix
        let path1 = resolver
            .resolve(&ImageId("img1".into()), "0/0/0/0/0/0")
            .unwrap();
        let path3 = resolver
            .resolve(&ImageId("img3".into()), "0/0/0/0/0/0")
            .unwrap();
        assert!(!path1.contains("B/2/0"));
        assert!(!path3.contains("B/2/0"));
    }
}
