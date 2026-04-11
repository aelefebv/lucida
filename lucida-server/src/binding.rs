use std::collections::HashMap;
use std::sync::Arc;

use lucida_content::ImageId;
use lucida_store::cache::CachedStore;
use lucida_store::import_types::ServerBindingSeed;
use object_store::ObjectStore;

/// Operational storage binding. Owns live resources.
/// Built from ServerBindingSeed + source URL + store + cache.
pub struct ServerBinding {
    pub source_url: String,
    pub store: Arc<dyn ObjectStore>,
    pub resolver: ChunkResolver,
    pub cache: Arc<CachedStore>,
}

/// Compiled key-to-path mapper. Built once at import from per-image binding seeds.
/// Used per chunk request to resolve logical keys to object store paths.
pub struct ChunkResolver {
    images: HashMap<ImageId, ImageResolver>,
}

/// What storage compression an image uses (detected at import from codec chain).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageCompression {
    None,
    Lz4,
    Zstd,
}

struct ImageResolver {
    axes_names: Vec<String>,
    store_prefix: Option<String>,
    storage_compression: StorageCompression,
}

impl ChunkResolver {
    /// Build from a ServerBindingSeed.
    pub fn new(seed: &ServerBindingSeed) -> Self {
        let images = seed
            .images
            .iter()
            .map(|img| {
                // Detect storage compression from the codec chain of level 0.
                let storage_compression = img.storage_codecs.first()
                    .map(|sc| detect_compression(&sc.codecs))
                    .unwrap_or(StorageCompression::None);

                let resolver = ImageResolver {
                    axes_names: img.axes_names.clone(),
                    store_prefix: img.store_prefix.clone(),
                    storage_compression,
                };
                (img.image_id.clone(), resolver)
            })
            .collect();
        ChunkResolver { images }
    }

    /// What storage compression does this image use?
    pub fn storage_compression(&self, image_id: &ImageId) -> StorageCompression {
        self.images.get(image_id)
            .map(|img| img.storage_compression)
            .unwrap_or(StorageCompression::None)
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

/// Detect storage compression from a Zarr v3 codec chain.
fn detect_compression(codecs: &[serde_json::Value]) -> StorageCompression {
    for codec in codecs {
        if let Some(name) = codec.get("name").and_then(|n| n.as_str()) {
            match name {
                "numcodecs/lz4" | "lz4" => return StorageCompression::Lz4,
                "numcodecs/zstd" | "zstd" => return StorageCompression::Zstd,
                _ => {}
            }
        }
    }
    StorageCompression::None
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
            storage_codecs: vec![],
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
