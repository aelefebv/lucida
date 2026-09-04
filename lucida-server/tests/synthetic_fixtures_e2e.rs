//! The committed synthetic fixtures, read through the same import, resolve,
//! and decode path the server serves chunks with.
//!
//! `fixtures/ome-zarr/` is written by `extras/synthetic_ome_zarr.py`, with
//! the exact commands in `fixtures/ome-zarr/regenerate.sh`. These tests pin
//! what the fixtures promise, so a regeneration that changed them fails here
//! rather than in a test that trusts them.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use lucida_content::ImageId;
use lucida_server::binding::ChunkResolver;
use lucida_server::decode::decode_storage_bytes;
use lucida_store::cache::{CachedStore, DEFAULT_SOURCE_CACHE_BYTES};
use lucida_store::import::import_dataset;
use lucida_store::import_types::ImportResult;

fn fixture_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("ome-zarr")
        .join(name)
}

async fn import_fixture(name: &str, id: &str) -> (PathBuf, ImportResult) {
    let dir = fixture_dir(name);
    let store = Arc::new(CachedStore::new(
        lucida_store::backend::open(dir.to_str().unwrap()).unwrap(),
        DEFAULT_SOURCE_CACHE_BYTES,
    ));
    let result = import_dataset(&store, id, id).await.unwrap();
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    (dir, result)
}

/// Resolve a chunk key and decode the object it names, as the handler does
/// before slicing.
fn decode_chunk(dir: &Path, resolver: &ChunkResolver, image_id: &ImageId, key: &str) -> Vec<u8> {
    let level: u32 = key.split('/').next().unwrap().parse().unwrap();
    let info = resolver.level_info(image_id, level).unwrap();
    let path = resolver.resolve(image_id, key).unwrap();
    let bytes = fs::read(dir.join(&path)).unwrap_or_else(|e| panic!("{path}: {e}"));
    decode_storage_bytes(&bytes, info.compression).unwrap()
}

fn samples(bytes: &[u8]) -> Vec<u16> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    assert!(rest.is_empty(), "odd byte count for uint16 samples");
    pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect()
}

/// Level 0 is all zeros, equal to the fill value, so reading its chunk from
/// disk is itself an assertion that the chunk exists rather than being inferred.
#[tokio::test]
async fn level_index_pyramid_reads_back_its_level_number_at_every_level() {
    let (dir, result) = import_fixture("level-index.ome.zarr", "level-index").await;
    let image = &result.manifest.images()[0];
    assert_eq!(image.multiscale.levels.len(), 4);

    let resolver = ChunkResolver::new(&result.binding_seed);
    let image_id = ImageId("level-index".to_string());
    for level in 0..4u32 {
        let key = format!("{level}/0/0/0/0/0");
        let decoded = decode_chunk(&dir, &resolver, &image_id, &key);
        // Edge chunks are stored whole, so every level decodes to a full
        // 16x16x16 chunk with fill past the level's extent.
        assert_eq!(decoded.len(), 16 * 16 * 16 * 2, "level {level}");
        let extent = [32usize >> level, 64 >> level, 64 >> level].map(|e| e.min(16));
        let values = samples(&decoded);
        for (i, &value) in values.iter().enumerate() {
            let (z, y, x) = (i / 256, (i / 16) % 16, i % 16);
            let inside = z < extent[0] && y < extent[1] && x < extent[2];
            let expected = if inside { level as u16 } else { 0 };
            assert_eq!(value, expected, "level {level} sample ({z}, {y}, {x})");
        }
    }
}

/// Guards the reference half of the twin pair: an equivalence test that
/// compared against constant or duplicated channels could pass on fill bytes.
#[tokio::test]
async fn unsharded_twin_channels_decode_to_distinct_pictures() {
    let (dir, result) = import_fixture("twin-unsharded.ome.zarr", "twin").await;
    let image = &result.manifest.images()[0];
    assert_eq!(image.multiscale.levels.len(), 3);
    assert_eq!(image.multiscale.levels[0].shape, [1, 2, 1, 40, 40]);

    let resolver = ChunkResolver::new(&result.binding_seed);
    let image_id = ImageId("twin".to_string());
    let channel0 = samples(&decode_chunk(&dir, &resolver, &image_id, "0/0/0/0/0/0"));
    let channel1 = samples(&decode_chunk(&dir, &resolver, &image_id, "0/0/1/0/0/0"));
    assert_eq!(channel0.len(), 8 * 8);
    assert_eq!(channel1.len(), 8 * 8);
    assert_ne!(channel0, channel1, "the channels carry one picture twice");
    for (channel, values) in [(0, &channel0), (1, &channel1)] {
        assert!(
            values.iter().any(|&v| v != values[0]),
            "channel {channel} is constant",
        );
    }
}
