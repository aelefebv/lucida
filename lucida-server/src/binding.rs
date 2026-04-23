use std::collections::HashMap;
use std::sync::Arc;

use lucida_content::ImageId;
use lucida_protocol::DatasetOpened;
use lucida_store::cache::CachedStore;
use lucida_store::import_types::{LevelBindingInfo, ServerBindingSeed};
use object_store::ObjectStore;

use crate::proxy::{ProxyCache, ProxyGenerator};

/// Operational storage binding. Owns live resources.
/// Built from ServerBindingSeed + source URL + store + cache.
///
/// `dataset_opened` is retained so that subsequent opens of the same URL
/// (which now resolve to the same DatasetId) can reuse the import work and
/// rebroadcast the canonical DatasetOpened to the requesting client.
///
/// `proxy_cache` and `proxy_generator` were added by S4 (PRD #397):
/// each binding has its own per-dataset cache directory keyed by the URL
/// hash, and its own bounded-concurrency generator scoped to that
/// dataset's content graph and store. They are only built once per
/// dataset, so the dedup map and semaphore live as long as the binding.
pub struct ServerBinding {
    pub source_url: String,
    pub store: Arc<dyn ObjectStore>,
    pub resolver: Arc<ChunkResolver>,
    pub cache: Arc<CachedStore>,
    pub dataset_opened: DatasetOpened,
    pub proxy_cache: Arc<ProxyCache>,
    pub proxy_generator: Arc<ProxyGenerator>,
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

/// Re-exported alias preserved from Slice 1's API. The chunk-fetch path
/// destructures this struct exactly as before; Slice 2 just changed where
/// the type is defined and how it's populated.
pub type LevelInfo = LevelBindingInfo;

impl ChunkResolver {
    /// Build from a ServerBindingSeed.
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

    /// Look up per-level info (compression + byte layout) for a given image
    /// and level. Returns `None` if either the image or the level is unknown.
    pub fn level_info(&self, image_id: &ImageId, level: u32) -> Option<LevelInfo> {
        self.images
            .get(image_id)
            .and_then(|img| img.levels.get(level as usize).copied())
    }

    /// Resolve a canonical chunk key to an object store path for a given image.
    pub fn resolve(&self, image_id: &ImageId, key: &str) -> Option<String> {
        let img = self.images.get(image_id)?;
        let store_path = lucida_store::chunk_key_to_store_path(key, &img.axes_names);
        Some(match &img.store_prefix {
            Some(prefix) => format!("{prefix}/{store_path}"),
            None => store_path,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::ImageId;
    use lucida_store::import_types::{ImageBindingSeed, ServerBindingSeed};

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

    #[test]
    fn resolve_5d_no_prefix() {
        let seed = make_seed(vec![make_image_seed(
            "img1",
            vec!["t", "c", "z", "y", "x"],
            None,
        )]);
        let resolver = ChunkResolver::new(&seed);
        let path = resolver
            .resolve(&ImageId("img1".into()), "2/0/1/5/3/2")
            .unwrap();
        assert_eq!(path, "2/c/0/1/5/3/2");
    }

    #[test]
    fn resolve_3d_no_prefix() {
        let seed = make_seed(vec![make_image_seed("img1", vec!["z", "y", "x"], None)]);
        let resolver = ChunkResolver::new(&seed);
        let path = resolver
            .resolve(&ImageId("img1".into()), "2/0/0/5/3/2")
            .unwrap();
        let expected = lucida_store::chunk_key_to_store_path(
            "2/0/0/5/3/2",
            &["z".to_string(), "y".to_string(), "x".to_string()],
        );
        assert_eq!(path, expected);
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
            .resolve(&ImageId("img1".into()), "2/0/1/5/3/2")
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
        assert!(resolver
            .resolve(&ImageId("unknown".into()), "2/0/1/5/3/2")
            .is_none());
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
        assert!(resolver
            .resolve(&ImageId("img1".into()), "0/0/0/0/0/0")
            .is_some());
        assert!(resolver
            .resolve(&ImageId("img2".into()), "0/0/0/0/0/0")
            .is_some());
        assert!(resolver
            .resolve(&ImageId("img3".into()), "0/0/0/0/0/0")
            .is_some());

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
