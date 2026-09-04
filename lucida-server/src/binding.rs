use std::collections::HashMap;
use std::sync::Arc;

use lucida_content::ImageId;
use lucida_protocol::DatasetOpened;
use lucida_store::cache::CachedStore;
use lucida_store::import_types::{ImportWarning, LevelBindingInfo, ServerBindingSeed};
use lucida_store::shard::{ShardIndexCache, ShardLayout, ShardLocation};
use object_store::ObjectStore;
use object_store::path::Path;

use crate::generated::{DerivedChunkCache, GeneratedCoarseService};
use crate::proxy::{ProxyCache, ProxyGenerator};

/// Operational storage binding. Owns live resources.
/// Built from ServerBindingSeed + source URL + store + cache.
///
/// `dataset_opened` is retained so that subsequent opens of the same URL
/// (which now resolve to the same DatasetId) can reuse the import work and
/// rebroadcast the canonical DatasetOpened to the requesting client.
///
/// Each binding has its own per-dataset proxy cache directory keyed by
/// the URL hash, and its own bounded-concurrency generator scoped to
/// that dataset's content graph and store. They are only built once
/// per dataset, so the dedup map and semaphore live as long as the
/// binding.
pub struct ServerBinding {
    pub source_url: String,
    pub store: Arc<dyn ObjectStore>,
    pub resolver: Arc<ChunkResolver>,
    pub cache: Arc<CachedStore>,
    pub dataset_opened: DatasetOpened,
    pub derived_chunks: Arc<DerivedChunkCache>,
    pub generated_service: Arc<GeneratedCoarseService>,
    pub legacy_proxy_enabled: bool,
    pub proxy_cache: Arc<ProxyCache>,
    pub proxy_generator: Arc<ProxyGenerator>,
    /// Non-fatal problems from importing this dataset (e.g. skipped collection
    /// groups). Retained so dataset health can surface them durably after the
    /// transient open-progress trail has scrolled past. Kept as typed
    /// warnings rather than flattened messages so health can act on a kind —
    /// an unwritten level has to move the aggregate status, not just add a
    /// line nobody reads.
    pub import_warnings: Vec<ImportWarning>,
}

/// Compiled key-to-location mapper. Built once at import from per-image binding
/// seeds. Used per chunk request to resolve chunk keys to their
/// [`ChunkLocation`] and to look up the per-level compression + byte-slicing
/// info.
///
/// One per binding, and it also holds what the binding has learned about
/// its shards: the [`ShardIndexCache`] that remembers each shard's index
/// once read. That memory belongs beside the per-level shard layouts
/// because both answer the same question, where an inner chunk's bytes
/// are, and both live exactly as long as the binding does.
pub struct ChunkResolver {
    images: HashMap<ImageId, ImageResolver>,
    shard_indexes: ShardIndexCache,
}

/// Where one chunk lives in the object store.
///
/// The resolver is the only thing that builds one, so no caller formats or
/// parses object paths itself, and no caller decides whether a key names a
/// whole object or a piece of one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkLocation<'a> {
    /// The chunk is an object of its own: the object's bytes are the
    /// chunk's.
    Object(Path),
    /// The chunk is an inner chunk of a shard object. The shard's index,
    /// read with `layout` and remembered by the resolver, says which of the
    /// object's bytes are its own.
    InnerChunk {
        layout: &'a ShardLayout,
        location: ShardLocation,
    },
}

impl ChunkLocation<'_> {
    /// The object that holds the chunk: the chunk itself, or its shard.
    pub fn path(&self) -> &Path {
        match self {
            ChunkLocation::Object(path) => path,
            ChunkLocation::InnerChunk { location, .. } => &location.path,
        }
    }
}

struct ImageResolver {
    axes_names: Vec<String>,
    store_prefix: Option<String>,
    /// Per-level compression + byte layout, in level-index order. Cloned
    /// from the [`ImageBindingSeed`] at resolver build time so the
    /// chunk-fetch path doesn't need to re-validate codec chains.
    levels: Vec<LevelBindingInfo>,
}

impl ImageResolver {
    /// A collection tile's chunks live under the tile's path.
    fn prefixed(&self, store_path: impl std::fmt::Display) -> Path {
        match &self.store_prefix {
            Some(prefix) => Path::from(format!("{prefix}/{store_path}")),
            None => Path::from(store_path.to_string()),
        }
    }
}

/// Re-exported alias kept for downstream chunk-fetch call sites that
/// destructure the type by its old name.
pub type LevelInfo = LevelBindingInfo;

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
        ChunkResolver {
            images,
            shard_indexes: ShardIndexCache::new(),
        }
    }

    /// The binding's memory of its shards' indexes, for reading the bytes
    /// an [`InnerChunk`] location names.
    ///
    /// [`InnerChunk`]: ChunkLocation::InnerChunk
    pub fn shard_indexes(&self) -> &ShardIndexCache {
        &self.shard_indexes
    }

    /// Look up per-level info (compression + byte layout + chunk shape) for
    /// a given image and level. Returns `None` if either the image or the
    /// level is unknown.
    pub fn level_info(&self, image_id: &ImageId, level: u32) -> Option<LevelInfo> {
        self.images
            .get(image_id)
            .and_then(|img| img.levels.get(level as usize).cloned())
    }

    /// Resolve a canonical chunk key to where the chunk lives for a given
    /// image, or `None` if the image is not in the binding. Uses the
    /// per-level chunk_shape to translate wire `t`/`c` voxel coords into
    /// disk-grid coords. On a sharded level the key is read in the inner
    /// chunk grid the same way, and the location names the shard and the
    /// inner chunk's position in it. A level the binding does not describe,
    /// such as one named by a malformed key, is treated as one wire chunk
    /// per disk chunk, and a malformed key on a sharded level resolves the
    /// same way: to an object nothing is at, so it reads as absent.
    pub fn resolve(&self, image_id: &ImageId, key: &str) -> Option<ChunkLocation<'_>> {
        let img = self.images.get(image_id)?;
        let level = img.levels.get(parse_level_from_chunk_key(key) as usize);
        if let Some(layout) = level.and_then(|l| l.shard.as_ref())
            && let Some(mut location) = layout.locate_inner_chunk(key, &img.axes_names)
        {
            location.path = img.prefixed(location.path);
            return Some(ChunkLocation::InnerChunk { layout, location });
        }
        let chunk_shape: Vec<u64> = level
            .map(|l| l.chunk_shape.clone())
            .unwrap_or_else(|| vec![1; img.axes_names.len()]);
        let store_path = lucida_store::chunk_key_to_store_path(key, &img.axes_names, &chunk_shape);
        Some(ChunkLocation::Object(img.prefixed(store_path)))
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

/// Parse the level prefix from a canonical chunk key (`"{level}/t/c/z/y/x"`).
/// Returns 0 if the key is malformed; such a key still resolves, to a
/// location nothing is at, and reads as an absent chunk.
pub(crate) fn parse_level_from_chunk_key(key: &str) -> u32 {
    key.split('/')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// Parse the wire `(t, c)` voxel coordinates from a canonical chunk key
/// (`"{level}/t/c/z/y/x"`). Returns `(0, 0)` if the key is malformed, which
/// slices the first timepoint and channel out of whatever the key resolved
/// to.
pub(crate) fn parse_t_c_from_chunk_key(key: &str) -> (u64, u64) {
    let mut parts = key.split('/');
    let _level = parts.next();
    let t = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let c = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (t, c)
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
        ImageBindingSeed {
            image_id: ImageId(id.to_string()),
            axes_names: axes.into_iter().map(String::from).collect(),
            store_prefix: prefix.map(String::from),
            levels: vec![],
        }
    }

    /// Every level field but `chunk_shape` and `shard` is a stub: these
    /// tests exercise `resolve()`, not the slice path.
    fn make_image_seed_with_level(
        id: &str,
        axes: Vec<&str>,
        prefix: Option<&str>,
        chunk_shape: Vec<u64>,
        shard: Option<ShardLayout>,
    ) -> ImageBindingSeed {
        ImageBindingSeed {
            image_id: ImageId(id.to_string()),
            axes_names: axes.into_iter().map(String::from).collect(),
            store_prefix: prefix.map(String::from),
            levels: vec![LevelBindingInfo {
                level_index: 0,
                compression: StorageCompression::None,
                chunk_shape,
                chunk_byte_layout: ChunkByteLayout {
                    canonical_byte_size: 0,
                    on_disk_byte_size: 0,
                    byte_stride_t: 0,
                    byte_stride_c: 0,
                    chunk_size_t: 1,
                    chunk_size_c: 1,
                },
                shard,
            }],
        }
    }

    fn sharded_layout() -> ShardLayout {
        ShardLayout {
            inner_chunk_shape: vec![1, 8, 8],
            chunks_per_shard: vec![1, 2, 2],
            inner_compression: StorageCompression::None,
            index_location: lucida_store::shard::IndexLocation::End,
            index_checksum: true,
        }
    }

    #[test]
    fn resolve_on_a_sharded_level_names_the_shard_and_the_position() {
        let seed = make_seed(vec![make_image_seed_with_level(
            "tile",
            vec!["c", "y", "x"],
            Some("A/1/0"),
            vec![1, 8, 8],
            Some(sharded_layout()),
        )]);
        let resolver = ChunkResolver::new(&seed);
        // (c=1, y=2, x=3) in 1x2x2 shards: shard (1, 1, 1), position (0, 0, 1).
        let location = resolver
            .resolve(&ImageId("tile".into()), "0/0/1/0/2/3")
            .unwrap();
        assert_eq!(
            location,
            ChunkLocation::InnerChunk {
                layout: &sharded_layout(),
                location: ShardLocation {
                    path: Path::from("A/1/0/0/c/1/1/1"),
                    position: 1,
                },
            }
        );
        assert_eq!(location.path(), &Path::from("A/1/0/0/c/1/1/1"));
    }

    /// A key on a level the binding does not describe, or one too short to
    /// name a chunk, is an object nothing is at, whether or not the level it
    /// names is sharded.
    #[test]
    fn resolve_of_a_malformed_key_is_an_object_nothing_is_at() {
        let seed = make_seed(vec![make_image_seed_with_level(
            "tile",
            vec!["c", "y", "x"],
            None,
            vec![1, 8, 8],
            Some(sharded_layout()),
        )]);
        let resolver = ChunkResolver::new(&seed);
        let image = ImageId("tile".into());
        assert_eq!(
            resolver.resolve(&image, "0/0/1").unwrap(),
            ChunkLocation::Object(Path::from("0/0/1"))
        );
        assert_eq!(
            resolver.resolve(&image, "7/0/1/0/2/3").unwrap(),
            ChunkLocation::Object(Path::from("7/c/1/2/3"))
        );
    }

    #[test]
    fn resolve_5d_no_prefix() {
        let seed = make_seed(vec![make_image_seed(
            "img1",
            vec!["t", "c", "z", "y", "x"],
            None,
        )]);
        let resolver = ChunkResolver::new(&seed);
        let location = resolver
            .resolve(&ImageId("img1".into()), "2/0/1/5/3/2")
            .unwrap();
        assert_eq!(location.path(), &Path::from("2/c/0/1/5/3/2"));
    }

    #[test]
    fn resolve_3d_no_prefix() {
        let seed = make_seed(vec![make_image_seed("img1", vec!["z", "y", "x"], None)]);
        let resolver = ChunkResolver::new(&seed);
        let location = resolver
            .resolve(&ImageId("img1".into()), "2/0/0/5/3/2")
            .unwrap();
        let expected = lucida_store::chunk_key_to_store_path(
            "2/0/0/5/3/2",
            &["z".to_string(), "y".to_string(), "x".to_string()],
            &[1, 1, 1],
        );
        assert_eq!(location.path(), &Path::from(expected));
    }

    #[test]
    fn resolve_c_bundled_divides_channel() {
        // lif_test-shaped binding. Wire c=3 with chunk_c=5 → disk c=0.
        let seed = make_seed(vec![make_image_seed_with_level(
            "lif",
            vec!["t", "c", "z", "y", "x"],
            None,
            vec![1, 5, 1, 1024, 1024],
            None,
        )]);
        let resolver = ChunkResolver::new(&seed);
        let location = resolver
            .resolve(&ImageId("lif".into()), "0/0/3/0/0/0")
            .unwrap();
        assert_eq!(location.path(), &Path::from("0/c/0/0/0/0/0"));
    }

    #[test]
    fn resolve_with_store_prefix() {
        let seed = make_seed(vec![make_image_seed(
            "img1",
            vec!["t", "c", "z", "y", "x"],
            Some("A/1/0"),
        )]);
        let resolver = ChunkResolver::new(&seed);
        let location = resolver
            .resolve(&ImageId("img1".into()), "2/0/1/5/3/2")
            .unwrap();
        assert_eq!(location.path(), &Path::from("A/1/0/2/c/0/1/5/3/2"));
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

        let path_of = |image: &str| {
            resolver
                .resolve(&ImageId(image.into()), "0/0/0/0/0/0")
                .unwrap()
                .path()
                .to_string()
        };
        // img2 should have prefix
        assert!(path_of("img2").starts_with("B/2/0/"));

        // img1 and img3 should not have prefix
        assert!(!path_of("img1").contains("B/2/0"));
        assert!(!path_of("img3").contains("B/2/0"));
    }
}
