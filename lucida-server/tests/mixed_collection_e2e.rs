//! A collection whose tiles disagree on level geometry, from import to the
//! bytes served for each chunk key.
//!
//! `collection-mixed.ome.zarr` holds three tiles: 14×12, 16×16, and 12×10.
//! Level 1 is one chunk the size of each tile's own level, 7×6, 8×8, or 6×5,
//! so the first tile, the one import reads first, is neither the largest nor
//! the smallest. See `fixtures/ome-zarr/regenerate.sh`.

use std::path::PathBuf;
use std::sync::Arc;

use lucida_content::LevelGeometry;
use lucida_server::binding::ChunkResolver;
use lucida_server::chunk_read::read_chunk;
use lucida_server::decode::{StorageCompression, decode_storage_bytes};
use lucida_store::cache::{CachedStore, DEFAULT_SOURCE_CACHE_BYTES};
use lucida_store::import::import_dataset;
use lucida_store::import_types::ImportResult;
use lucida_store::source_limiter::{ReaderId, RequestLabel};

const READER: ReaderId = ReaderId(3);
const LABEL: RequestLabel = RequestLabel(5);

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("ome-zarr")
        .join("collection-mixed.ome.zarr")
}

struct Opened {
    store: Arc<CachedStore>,
    result: ImportResult,
    resolver: ChunkResolver,
}

async fn open() -> Opened {
    let store = Arc::new(CachedStore::new(
        lucida_store::backend::open(&fixture_dir().to_str().unwrap().parse().unwrap()).unwrap(),
        DEFAULT_SOURCE_CACHE_BYTES,
    ));
    let result = import_dataset(&store, "mixed", "mixed").await.unwrap();
    let resolver = ChunkResolver::new(&result.binding_seed);
    Opened {
        store,
        result,
        resolver,
    }
}

fn samples(bytes: &[u8]) -> Vec<u16> {
    let (pairs, rest) = bytes.as_chunks::<2>();
    assert!(rest.is_empty(), "odd byte count for uint16 samples");
    pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect()
}

async fn served(opened: &Opened, image: &lucida_content::ImageId, key: &str) -> Vec<u8> {
    read_chunk(
        &opened.resolver,
        &opened.store,
        image,
        key,
        READER,
        LABEL,
        None,
    )
    .await
    .unwrap_or_else(|e| panic!("{image:?} {key}: {e}"))
    .into_bytes()
}

/// The samples of one tile's own level-1 chunk, read straight off disk.
fn native_level1_plane(tile: &str, channel: u32) -> Vec<u16> {
    let path = fixture_dir()
        .join(tile)
        .join("1")
        .join("c")
        .join(channel.to_string())
        .join("0")
        .join("0");
    let raw = std::fs::read(&path).unwrap();
    samples(&decode_storage_bytes(&raw, StorageCompression::Zstd).unwrap())
}

#[tokio::test]
async fn the_declared_geometry_covers_every_tile() {
    let opened = open().await;
    let images = opened.result.manifest.images();
    assert_eq!(images.len(), 3);
    let expected = [
        LevelGeometry {
            level_index: 0,
            shape: [1, 2, 1, 16, 16],
            chunk_shape: [1, 1, 1, 8, 8],
            grid_shape: [1, 2, 1, 2, 2],
            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
        },
        LevelGeometry {
            level_index: 1,
            shape: [1, 2, 1, 8, 8],
            chunk_shape: [1, 1, 1, 8, 8],
            grid_shape: [1, 2, 1, 1, 1],
            scale: [1.0, 1.0, 1.0, 2.0, 2.0],
        },
    ];
    for image in images {
        assert_eq!(
            image.multiscale.levels, expected,
            "{:?} declares one geometry for every tile",
            image.image_id
        );
    }
}

#[tokio::test]
async fn every_chunk_key_of_every_tile_serves_one_declared_chunk() {
    let opened = open().await;
    for image in opened.result.manifest.images() {
        for level in &image.multiscale.levels {
            let [_, channels, _, rows, columns] = level.grid_shape;
            let declared_bytes = (level.chunk_shape[3] * level.chunk_shape[4] * 2) as usize;
            for c in 0..channels {
                for y in 0..rows {
                    for x in 0..columns {
                        let key = format!("{}/0/{c}/0/{y}/{x}", level.level_index);
                        let bytes = served(&opened, &image.image_id, &key).await;
                        assert_eq!(bytes.len(), declared_bytes, "{:?} {key}", image.image_id);
                    }
                }
            }
        }
    }
}

/// A smaller tile's own chunk lands in the top-left of the declared 8×8
/// chunk, and the rest reads as fill.
#[tokio::test]
async fn a_smaller_tile_is_padded_into_the_declared_chunk() {
    let opened = open().await;
    for (tile, rows, columns) in [("A/1/0", 7, 6), ("B/1/0", 6, 5)] {
        let image = opened
            .result
            .manifest
            .images()
            .iter()
            .find(|image| image.image_id.0.ends_with(tile))
            .unwrap()
            .image_id
            .clone();
        for c in 0..2 {
            let native = native_level1_plane(tile, c);
            assert_eq!(native.len(), rows * columns);
            let picture = samples(&served(&opened, &image, &format!("1/0/{c}/0/0/0")).await);
            for y in 0..8 {
                for x in 0..8 {
                    let expected = if y < rows && x < columns {
                        native[y * columns + x]
                    } else {
                        0
                    };
                    assert_eq!(picture[y * 8 + x], expected, "{tile} c={c} y={y} x={x}");
                }
            }
            assert!(native.iter().any(|&v| v != 0), "{tile} c={c} is all fill");
        }
    }
}

/// The largest tile matches the declared chunk, so it is served as stored.
#[tokio::test]
async fn the_largest_tile_is_served_as_stored() {
    let opened = open().await;
    let image = opened
        .result
        .manifest
        .images()
        .iter()
        .find(|image| image.image_id.0.ends_with("A/2/0"))
        .unwrap()
        .image_id
        .clone();
    for c in 0..2 {
        let picture = samples(&served(&opened, &image, &format!("1/0/{c}/0/0/0")).await);
        assert_eq!(picture, native_level1_plane("A/2/0", c));
    }
}
