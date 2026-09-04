//! The committed sharded fixture, read inner chunk by inner chunk through
//! the store's shard reader and decoded with the same decode the server
//! serves chunks with.
//!
//! Import does not accept the sharding codec yet, so the sharded twin's
//! layout is read from its own array metadata here. The unsharded twin goes
//! through import, as it does when served.

use std::sync::Arc;

use lucida_server::decode::decode_storage_bytes;
use lucida_store::cache::{CachedStore, DEFAULT_SOURCE_CACHE_BYTES};
use lucida_store::chunk_key_to_store_path;
use lucida_store::import::import_dataset;
use lucida_store::shard::{ShardIndexCache, ShardLayout};
use lucida_store::source_limiter::{ReaderId, RequestLabel};
use object_store::path::Path;

const READER: ReaderId = ReaderId(3);
const LABEL: RequestLabel = RequestLabel(5);

fn fixture_dir(name: &str) -> String {
    format!("{}/../fixtures/ome-zarr/{name}", env!("CARGO_MANIFEST_DIR"))
}

fn cached_store(name: &str) -> Arc<CachedStore> {
    Arc::new(CachedStore::new(
        lucida_store::backend::open(&fixture_dir(name)).unwrap(),
        DEFAULT_SOURCE_CACHE_BYTES,
    ))
}

/// One level of the sharded twin as its metadata declares it: the shard
/// layout and the inner chunk grid.
fn sharded_level(level: u32) -> (ShardLayout, Vec<u64>) {
    let path = format!("{}/{level}/zarr.json", fixture_dir("twin-sharded.ome.zarr"));
    let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let as_u64s = |value: &serde_json::Value| -> Vec<u64> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect()
    };
    let shard_shape = as_u64s(&meta["chunk_grid"]["configuration"]["chunk_shape"]);
    let layout = ShardLayout::from_codec_chain(meta["codecs"].as_array().unwrap(), &shard_shape)
        .unwrap()
        .expect("the fixture is sharded");
    let grid = as_u64s(&meta["shape"])
        .iter()
        .zip(&layout.inner_chunk_shape)
        .map(|(extent, inner)| extent.div_ceil(*inner))
        .collect();
    (layout, grid)
}

fn samples(bytes: &[u8]) -> Vec<u16> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    assert!(rest.is_empty(), "odd byte count for uint16 samples");
    pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect()
}

/// Every chunk key of the twin pair decodes to the same samples whether
/// the bytes came out of a shard or out of an object of their own. The
/// decoded chunks are full 8x8 sample blocks and the two channels differ,
/// so the equality is between two pictures rather than two runs of fill.
#[tokio::test]
async fn every_chunk_key_decodes_identically_from_the_sharded_and_the_unsharded_twin() {
    let unsharded_store = cached_store("twin-unsharded.ome.zarr");
    let unsharded = import_dataset(&unsharded_store, "twin", "twin")
        .await
        .unwrap();
    let seed = &unsharded.binding_seed.images[0];
    let sharded = ShardIndexCache::new(cached_store("twin-sharded.ome.zarr"));

    let mut compared = 0;
    for level in 0..3u32 {
        let (layout, grid) = sharded_level(level);
        let unsharded_level = &seed.levels[level as usize];
        assert_eq!(layout.inner_chunk_shape, unsharded_level.chunk_shape);

        let mut channel_pictures: Vec<Vec<u16>> = Vec::new();
        for c in 0..grid[0] {
            for y in 0..grid[1] {
                for x in 0..grid[2] {
                    let key = format!("{level}/0/{c}/0/{y}/{x}");

                    let location = layout.locate_inner_chunk(&key, &seed.axes_names).unwrap();
                    let from_shard = sharded
                        .read_inner_chunk(&layout, &location, READER, LABEL)
                        .await
                        .result
                        .unwrap();
                    let from_shard =
                        decode_storage_bytes(&from_shard, layout.inner_compression).unwrap();

                    let object = chunk_key_to_store_path(
                        &key,
                        &seed.axes_names,
                        &unsharded_level.chunk_shape,
                    );
                    let from_object = unsharded_store
                        .get_bytes(&Path::from(object), READER, LABEL)
                        .await
                        .result
                        .unwrap();
                    let from_object =
                        decode_storage_bytes(&from_object, unsharded_level.compression).unwrap();

                    assert_eq!(from_shard, from_object, "chunk key {key}");
                    assert_eq!(from_shard.len(), 8 * 8 * 2, "chunk key {key}");
                    if y == 0 && x == 0 {
                        channel_pictures.push(samples(&from_shard));
                    }
                    compared += 1;
                }
            }
        }
        assert_ne!(
            channel_pictures[0], channel_pictures[1],
            "level {level}: the channels carry one picture twice"
        );
    }
    assert_eq!(compared, 2 * (25 + 9 + 4));
}
