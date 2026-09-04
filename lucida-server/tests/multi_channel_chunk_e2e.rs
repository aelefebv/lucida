//! End-to-end test: open a synthesized OME-Zarr where all 5 channels
//! live in one on-disk chunk (`chunk_shape[c] = 5`), resolve each
//! channel's wire chunk key to the same on-disk path, decompress, and
//! verify the per-channel slice picks out the correct bytes.
//!
//! Fixture: axes `[t, c, z, y, x]`, shape `[1, 5, 1, 4, 4]`,
//! chunk_shape `[1, 5, 1, 4, 4]`, dtype uint16, blosc-zstd-bitshuffle.
//! Each channel C is filled with the 16-bit pattern `(C+1) * 0x1111`
//! (so ch0=0x1111×16, ch1=0x2222×16, …, ch4=0x5555×16). The 160-byte
//! plaintext compresses to 56 bytes.
//!
//! The chunk's blosc bytes are a hardcoded `&[u8]` literal generated via:
//!
//! ```sh
//! python3 -c "
//! import blosc
//! plain = bytearray()
//! for c in range(5):
//!     pattern = (c + 1) * 0x1111
//!     for _ in range(16):
//!         plain += pattern.to_bytes(2, 'little')
//! print(blosc.compress(bytes(plain), typesize=2, cname='zstd', shuffle=blosc.BITSHUFFLE).hex())
//! "
//! ```

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use lucida_content::ImageId;
use lucida_server::binding::ChunkResolver;
use lucida_server::chunk_read::{ChunkRead, read_chunk};
use lucida_store::import::import_dataset;
use lucida_store::source_limiter::{ReaderId, RequestLabel};
use object_store::path::Path;

/// Single chunk for shape `[1,5,1,4,4]` uint16: 5 channels × 16 elements
/// × 2 bytes = 160 plaintext bytes. Encoded with blosc-zstd-bitshuffle to
/// 56 bytes.
const ENC_5CH_BLOSC: &[u8] = &[
    0x02, 0x01, 0x94, 0x02, 0xa0, 0x00, 0x00, 0x00, 0xa0, 0x00, 0x00, 0x00, 0x38, 0x00, 0x00, 0x00,
    0x14, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x20, 0xa0, 0xbd, 0x00,
    0x00, 0x82, 0xc1, 0x02, 0x06, 0xe0, 0x0f, 0x00, 0x60, 0x4c, 0x0a, 0x00, 0xcf, 0xcc, 0x01, 0x02,
    0x00, 0x75, 0xa9, 0x14, 0x10, 0xc8, 0x1c, 0x03,
];

/// Per-channel canonical bytes: 32 bytes each, filled with `(c+1) * 0x1111`
/// repeated 16 times little-endian.
fn expected_channel_bytes(c: u16) -> Vec<u8> {
    let pattern: u16 = (c + 1) * 0x1111;
    let mut out = Vec::with_capacity(32);
    for _ in 0..16 {
        out.extend_from_slice(&pattern.to_le_bytes());
    }
    out
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("lucida_multi_c_e2e_{}", std::process::id()))
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    dir
}

#[tokio::test]
async fn five_channels_per_chunk_resolve_and_slice_independently() {
    let dir = temp_dir("five_c_per_chunk");
    fs::create_dir_all(&dir).unwrap();

    // Root group metadata: 5D OME-Zarr v0.5 with axes [t, c, z, y, x].
    let root = serde_json::json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "ome": {
                "version": "0.5",
                "multiscales": [{
                    "version": "0.5",
                    "name": "img",
                    "axes": [
                        {"name": "t", "type": "time"},
                        {"name": "c", "type": "channel"},
                        {"name": "z", "type": "space"},
                        {"name": "y", "type": "space"},
                        {"name": "x", "type": "space"}
                    ],
                    "datasets": [{
                        "path": "0",
                        "coordinateTransformations": [{
                            "type": "scale",
                            "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                        }]
                    }]
                }]
            }
        }
    });
    fs::write(
        dir.join("zarr.json"),
        serde_json::to_string_pretty(&root).unwrap(),
    )
    .unwrap();

    // Level 0 array metadata: shape and chunk_shape both [1,5,1,4,4]
    // (single chunk, 5 channels bundled along c).
    let level_dir = dir.join("0");
    fs::create_dir_all(&level_dir).unwrap();
    let arr = serde_json::json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [1, 5, 1, 4, 4],
        "data_type": "uint16",
        "chunk_grid": {
            "name": "regular",
            "configuration": { "chunk_shape": [1, 5, 1, 4, 4] }
        },
        "codecs": [
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
        ],
        "fill_value": 0
    });
    fs::write(
        level_dir.join("zarr.json"),
        serde_json::to_string_pretty(&arr).unwrap(),
    )
    .unwrap();

    // Single on-disk chunk path: 0/c/{t}/{c}/{z}/{y}/{x} = 0/c/0/0/0/0/0.
    let chunk_dir = level_dir.join("c").join("0").join("0").join("0").join("0");
    fs::create_dir_all(&chunk_dir).unwrap();
    fs::write(chunk_dir.join("0"), ENC_5CH_BLOSC).unwrap();

    // Open via the import pipeline.
    let store = std::sync::Arc::new(lucida_store::cache::CachedStore::new(
        lucida_store::backend::open(dir.to_str().unwrap()).unwrap(),
        lucida_store::cache::DEFAULT_SOURCE_CACHE_BYTES,
    ));
    let result = import_dataset(&store, "multi-c-e2e", "Multi-C E2E")
        .await
        .unwrap();

    // Sanity: the binding seed records the per-axis chunk_shape and the
    // canonical-vs-on-disk size split.
    let img_seed = &result.binding_seed.images[0];
    assert_eq!(img_seed.levels.len(), 1);
    let level0 = &img_seed.levels[0];
    let layout = level0.chunk_byte_layout;
    assert_eq!(level0.chunk_shape, vec![1, 5, 1, 4, 4]);
    assert_eq!(layout.canonical_byte_size, 4 * 4 * 2);
    assert_eq!(layout.on_disk_byte_size, 5 * 4 * 4 * 2);
    assert_eq!(layout.byte_stride_c, 4 * 4 * 2);
    assert_eq!(layout.chunk_size_c, 5);

    let resolver = Arc::new(ChunkResolver::new(&result.binding_seed));
    let image_id = ImageId("multi-c-e2e".to_string());

    let mut all_channels_bytes = Vec::with_capacity(5);
    for c in 0..5u16 {
        let canonical_key = format!("0/0/{c}/0/0/0");
        let location = resolver.resolve(&image_id, &canonical_key).unwrap();
        // All 5 channels resolve to the same on-disk chunk file
        // (chunk_shape[c] = 5 means c-axis-grid has only 1 chunk).
        assert_eq!(
            location.path,
            Path::from("0/c/0/0/0/0/0"),
            "wire c={c} should resolve to disk c-coord 0 (5 channels per chunk)",
        );
        assert_eq!(
            fs::read(dir.join(location.path.as_ref())).unwrap(),
            ENC_5CH_BLOSC
        );

        let read = read_chunk(
            &resolver,
            &store,
            &image_id,
            &canonical_key,
            ReaderId::UNATTRIBUTED,
            RequestLabel::UNATTRIBUTED,
            None,
        )
        .await
        .unwrap();
        let ChunkRead::Present(sliced) = read else {
            panic!("chunk {canonical_key} is on disk");
        };
        assert_eq!(sliced.len(), 32, "each channel slice should be 32 bytes");
        assert_eq!(
            sliced,
            expected_channel_bytes(c),
            "channel {c} bytes must match expected pattern (0x{:04x} × 16)",
            (c + 1) * 0x1111,
        );

        all_channels_bytes.push(sliced);
    }

    // Cross-check: all 5 channels return distinct bytes (catches "always
    // returns offset 0" regressions).
    for i in 0..5 {
        for j in (i + 1)..5 {
            assert_ne!(
                all_channels_bytes[i], all_channels_bytes[j],
                "channels {i} and {j} must return distinct bytes",
            );
        }
    }

    let _ = fs::remove_dir_all(&dir);
}

/// A non-prefix axis order with both a kept axis (z) and an indexed
/// axis (c) carrying chunk_size > 1 should be rejected at import time
/// with a clear error naming the offending axis.
#[tokio::test]
async fn rejects_canonical_indexed_after_kept_canonical() {
    let dir = temp_dir("non_prefix_t_z_c_y_x");
    fs::create_dir_all(&dir).unwrap();

    // Axes [t, z, c, y, x] — z (kept, chunk=3) precedes c (indexed, chunk=5).
    let root = serde_json::json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "ome": {
                "version": "0.5",
                "multiscales": [{
                    "version": "0.5",
                    "name": "img",
                    "axes": [
                        {"name": "t", "type": "time"},
                        {"name": "z", "type": "space"},
                        {"name": "c", "type": "channel"},
                        {"name": "y", "type": "space"},
                        {"name": "x", "type": "space"}
                    ],
                    "datasets": [{
                        "path": "0",
                        "coordinateTransformations": [{
                            "type": "scale",
                            "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                        }]
                    }]
                }]
            }
        }
    });
    fs::write(
        dir.join("zarr.json"),
        serde_json::to_string_pretty(&root).unwrap(),
    )
    .unwrap();

    let level_dir = dir.join("0");
    fs::create_dir_all(&level_dir).unwrap();
    let arr = serde_json::json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [1, 3, 5, 64, 64],
        "data_type": "uint16",
        "chunk_grid": {
            "name": "regular",
            "configuration": { "chunk_shape": [1, 3, 5, 64, 64] }
        },
        "codecs": [
            {"name": "bytes", "configuration": {"endian": "little"}}
        ],
        "fill_value": 0
    });
    fs::write(
        level_dir.join("zarr.json"),
        serde_json::to_string_pretty(&arr).unwrap(),
    )
    .unwrap();

    let store = std::sync::Arc::new(lucida_store::cache::CachedStore::new(
        lucida_store::backend::open(dir.to_str().unwrap()).unwrap(),
        lucida_store::cache::DEFAULT_SOURCE_CACHE_BYTES,
    ));
    let err = import_dataset(&store, "non-prefix-e2e", "Non-prefix E2E")
        .await
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains('c'),
        "error should name the offending canonical-indexed axis 'c': {msg}"
    );
    assert!(
        msg.contains("non-prefix"),
        "error should mention non-prefix: {msg}"
    );

    let _ = fs::remove_dir_all(&dir);
}
