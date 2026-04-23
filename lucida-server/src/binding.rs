use std::collections::HashMap;
use std::sync::Arc;

use lucida_content::ImageId;
use lucida_protocol::DatasetOpened;
use lucida_store::cache::CachedStore;
use lucida_store::import_types::ServerBindingSeed;
use lucida_store::layout::ChunkByteLayout;
use object_store::ObjectStore;

use crate::decode::{BloscCompressor, BloscConfig, BloscShuffle, StorageCompression};
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
    /// Per-level compression + byte layout. Indexed by level index.
    levels: Vec<LevelInfo>,
}

/// What the chunk-fetch path needs to know about one level of one image:
/// how the bytes are compressed on disk, and whether to slice them down to
/// the canonical 5D chunk size after decompression.
#[derive(Debug, Clone, Copy)]
pub struct LevelInfo {
    pub compression: StorageCompression,
    pub chunk_byte_layout: ChunkByteLayout,
}

impl ChunkResolver {
    /// Build from a ServerBindingSeed.
    pub fn new(seed: &ServerBindingSeed) -> Self {
        let images = seed
            .images
            .iter()
            .map(|img| {
                // Detect storage compression per level. Codec slots that fall
                // through to `None` (unknown codec name) preserve the existing
                // pre-#447 behavior; Slice 2 of #447 will turn that into a
                // hard import error so unknown codecs cannot reach this point.
                let levels: Vec<LevelInfo> = img
                    .storage_codecs
                    .iter()
                    .enumerate()
                    .map(|(i, sc)| {
                        let compression = detect_compression(&sc.codecs);
                        // Defensive: chunk_byte_layouts is in lock-step with
                        // storage_codecs at import time. If it isn't (e.g.
                        // older snapshot), fall back to a no-slice canonical
                        // layout so we don't truncate.
                        let chunk_byte_layout = img
                            .chunk_byte_layouts
                            .get(i)
                            .copied()
                            .unwrap_or(ChunkByteLayout {
                                canonical_byte_size: 0,
                                on_disk_byte_size: 0,
                                needs_slicing: false,
                            });
                        LevelInfo {
                            compression,
                            chunk_byte_layout,
                        }
                    })
                    .collect();

                let resolver = ImageResolver {
                    axes_names: img.axes_names.clone(),
                    store_prefix: img.store_prefix.clone(),
                    levels,
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

/// Detect storage compression from a Zarr v3 codec chain.
///
/// Recognized:
/// - `lz4` / `numcodecs/lz4` → [`StorageCompression::Lz4`]
/// - `zstd` / `numcodecs/zstd` → [`StorageCompression::Zstd`]
/// - `blosc` with cname=zstd, shuffle ∈ {noshuffle, shuffle, bitshuffle},
///   typesize ∈ {1, 2, 4} → [`StorageCompression::Blosc`]
///
/// Falls back to [`StorageCompression::None`] for unrecognized codecs (will
/// become a hard import-time error in Slice 2 of PRD #447).
pub fn detect_compression(codecs: &[serde_json::Value]) -> StorageCompression {
    for codec in codecs {
        if let Some(name) = codec.get("name").and_then(|n| n.as_str()) {
            match name {
                "numcodecs/lz4" | "lz4" => return StorageCompression::Lz4,
                "numcodecs/zstd" | "zstd" => return StorageCompression::Zstd,
                "blosc" => {
                    if let Some(config) = parse_blosc_config(codec.get("configuration")) {
                        return StorageCompression::Blosc(config);
                    }
                }
                _ => {}
            }
        }
    }
    StorageCompression::None
}

/// Validate a blosc codec's `configuration` object against the supported
/// subset. Returns `None` if any field is missing, malformed, or outside the
/// supported subset — caller treats that as `StorageCompression::None`
/// (Slice 1 behavior; Slice 2 of #447 turns it into a hard error).
fn parse_blosc_config(config: Option<&serde_json::Value>) -> Option<BloscConfig> {
    let cfg = config?;
    let cname = cfg.get("cname")?.as_str()?;
    let shuffle_str = cfg.get("shuffle")?.as_str()?;
    let typesize = cfg.get("typesize")?.as_u64()?;

    let cname = match cname {
        "zstd" => BloscCompressor::Zstd,
        _ => return None,
    };
    let shuffle = match shuffle_str {
        "noshuffle" => BloscShuffle::None,
        "shuffle" => BloscShuffle::Byte,
        "bitshuffle" => BloscShuffle::Bit,
        _ => return None,
    };
    let typesize = match typesize {
        1 | 2 | 4 => typesize as u8,
        _ => return None,
    };

    Some(BloscConfig {
        typesize,
        cname,
        shuffle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_content::ImageId;
    use lucida_store::import_types::{ImageBindingSeed, ServerBindingSeed};
    use serde_json::json;

    fn make_seed(images: Vec<ImageBindingSeed>) -> ServerBindingSeed {
        ServerBindingSeed { images }
    }

    fn make_image_seed(id: &str, axes: Vec<&str>, prefix: Option<&str>) -> ImageBindingSeed {
        ImageBindingSeed {
            image_id: ImageId(id.to_string()),
            axes_names: axes.into_iter().map(String::from).collect(),
            store_prefix: prefix.map(String::from),
            storage_codecs: vec![],
            chunk_byte_layouts: vec![],
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

    // --- detect_compression / parse_blosc_config tests ---

    #[test]
    fn detect_lz4_variants() {
        let lz4_codec = json!([
            {"name": "bytes", "configuration": {"endian": "little"}},
            {"name": "lz4"}
        ]);
        let nc_lz4_codec = json!([
            {"name": "bytes", "configuration": {"endian": "little"}},
            {"name": "numcodecs/lz4"}
        ]);
        assert_eq!(
            detect_compression(lz4_codec.as_array().unwrap()),
            StorageCompression::Lz4
        );
        assert_eq!(
            detect_compression(nc_lz4_codec.as_array().unwrap()),
            StorageCompression::Lz4
        );
    }

    #[test]
    fn detect_blosc_zstd_bitshuffle_typesize_2() {
        let codec = json!([
            {"name": "bytes", "configuration": {"endian": "little"}},
            {
                "name": "blosc",
                "configuration": {
                    "typesize": 2,
                    "cname": "zstd",
                    "shuffle": "bitshuffle",
                    "blocksize": 0,
                    "clevel": 3
                }
            }
        ]);
        let comp = detect_compression(codec.as_array().unwrap());
        match comp {
            StorageCompression::Blosc(cfg) => {
                assert_eq!(cfg.typesize, 2);
                assert_eq!(cfg.cname, BloscCompressor::Zstd);
                assert_eq!(cfg.shuffle, BloscShuffle::Bit);
            }
            other => panic!("expected Blosc, got {other:?}"),
        }
    }

    #[test]
    fn detect_blosc_unknown_cname_falls_through() {
        // blosclz as inner cname not yet supported → falls through to None
        // (Slice 2 of #447 will reject this at import time).
        let codec = json!([
            {"name": "bytes", "configuration": {"endian": "little"}},
            {
                "name": "blosc",
                "configuration": {
                    "typesize": 2,
                    "cname": "blosclz",
                    "shuffle": "bitshuffle"
                }
            }
        ]);
        assert_eq!(
            detect_compression(codec.as_array().unwrap()),
            StorageCompression::None
        );
    }

    #[test]
    fn detect_blosc_unsupported_typesize_falls_through() {
        let codec = json!([
            {"name": "bytes", "configuration": {"endian": "little"}},
            {
                "name": "blosc",
                "configuration": {
                    "typesize": 8,
                    "cname": "zstd",
                    "shuffle": "bitshuffle"
                }
            }
        ]);
        assert_eq!(
            detect_compression(codec.as_array().unwrap()),
            StorageCompression::None
        );
    }

    #[test]
    fn detect_unknown_codec_falls_through() {
        let codec = json!([
            {"name": "bytes", "configuration": {"endian": "little"}},
            {"name": "gzip"}
        ]);
        assert_eq!(
            detect_compression(codec.as_array().unwrap()),
            StorageCompression::None
        );
    }
}
