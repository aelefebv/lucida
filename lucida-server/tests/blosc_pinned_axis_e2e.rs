//! End-to-end test: open a synthesized 6D OME-Zarr with a blosc-
//! compressed chunk, resolve the canonical chunk key to the on-disk
//! path (which has a `0` injected at the pinned `m` position),
//! decompress, and verify the resulting bytes are the canonical-5D
//! `m=0` slice.
//!
//! Fixture is built inline with `serde_json::json!` + `fs::write` (matching
//! the `lucida-store::import` test pattern). The chunk's blosc bytes are
//! a hardcoded `&[u8]` literal generated once via:
//!
//! ```sh
//! python3 -c "
//! import blosc
//! plain = bytearray()
//! for m in range(2):
//!     for y in range(4):
//!         for x in range(4):
//!             plain += (m*100 + y*4 + x).to_bytes(2, 'little')
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

/// Single chunk for shape `[1,1,1,2,4,4]` uint16: 64 plaintext bytes (m=0
/// has values 0..15, m=1 has 100..115). Compresses through blosc-zstd-
/// bitshuffle to 80 bytes (MEMCPYED — the input is too small / regular for
/// zstd to beat; the code path is identical for the slice logic since blosc
/// memcpy preserves the original element-major layout).
const ENC_6D_BLOSC: &[u8] = &[
    0x02, 0x01, 0x96, 0x02, 0x40, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06, 0x00, 0x07, 0x00,
    0x08, 0x00, 0x09, 0x00, 0x0a, 0x00, 0x0b, 0x00, 0x0c, 0x00, 0x0d, 0x00, 0x0e, 0x00, 0x0f, 0x00,
    0x64, 0x00, 0x65, 0x00, 0x66, 0x00, 0x67, 0x00, 0x68, 0x00, 0x69, 0x00, 0x6a, 0x00, 0x6b, 0x00,
    0x6c, 0x00, 0x6d, 0x00, 0x6e, 0x00, 0x6f, 0x00, 0x70, 0x00, 0x71, 0x00, 0x72, 0x00, 0x73, 0x00,
];

/// Expected canonical 5D `m=0` slice: the first 32 bytes of the plaintext
/// (16 uint16 values 0..15, little-endian).
const EXPECTED_M0_BYTES: &[u8] = &[
    0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06, 0x00, 0x07, 0x00,
    0x08, 0x00, 0x09, 0x00, 0x0a, 0x00, 0x0b, 0x00, 0x0c, 0x00, 0x0d, 0x00, 0x0e, 0x00, 0x0f, 0x00,
];

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("lucida_blosc_e2e_{}", std::process::id()))
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    dir
}

#[tokio::test]
async fn six_d_with_m_blosc_decodes_to_canonical_m0_slice() {
    let dir = temp_dir("six_d_m_blosc");
    fs::create_dir_all(&dir).unwrap();

    // Root group metadata: 6D OME-Zarr v0.5 with axes [t, c, z, m, y, x].
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
                        {"name": "m", "type": "space"},
                        {"name": "y", "type": "space"},
                        {"name": "x", "type": "space"}
                    ],
                    "datasets": [{
                        "path": "0",
                        "coordinateTransformations": [{
                            "type": "scale",
                            "scale": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
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

    // Level 0 array metadata: shape and chunk_shape both [1,1,1,2,4,4]
    // (single chunk, m=2 so the on-disk chunk holds both m=0 and m=1).
    let level_dir = dir.join("0");
    fs::create_dir_all(&level_dir).unwrap();
    let arr = serde_json::json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [1, 1, 1, 2, 4, 4],
        "data_type": "uint16",
        "chunk_grid": {
            "name": "regular",
            "configuration": { "chunk_shape": [1, 1, 1, 2, 4, 4] }
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

    // Single on-disk chunk path: 0/c/{t}/{c}/{z}/{m}/{y}/{x} = 0/c/0/0/0/0/0/0.
    let chunk_dir = level_dir
        .join("c")
        .join("0")
        .join("0")
        .join("0")
        .join("0")
        .join("0");
    fs::create_dir_all(&chunk_dir).unwrap();
    fs::write(chunk_dir.join("0"), ENC_6D_BLOSC).unwrap();

    // Open via the import pipeline.
    let store = std::sync::Arc::new(lucida_store::cache::CachedStore::new(
        lucida_store::backend::open(dir.to_str().unwrap()).unwrap(),
        lucida_store::cache::DEFAULT_SOURCE_CACHE_BYTES,
    ));
    let result = import_dataset(&store, "blosc-e2e", "Blosc E2E")
        .await
        .unwrap();

    // Sanity: the binding seed records blosc + a non-trivial slice
    // (canonical_byte_size != on_disk_byte_size means slicing is needed).
    let img_seed = &result.binding_seed.images[0];
    let level0 = &img_seed.levels[0];
    let layout = level0.chunk_byte_layout;
    assert_ne!(
        layout.canonical_byte_size, layout.on_disk_byte_size,
        "m=2 chunk must require slicing",
    );
    assert_eq!(layout.canonical_byte_size, EXPECTED_M0_BYTES.len());
    assert_eq!(layout.on_disk_byte_size, 2 * EXPECTED_M0_BYTES.len());

    // Read through `read_chunk` rather than the WebSocket layer, which needs
    // a full session harness; the served bytes are what matter.
    let resolver = Arc::new(ChunkResolver::new(&result.binding_seed));
    let image_id = ImageId("blosc-e2e".to_string());
    let canonical_key = "0/0/0/0/0/0";
    let location = resolver.resolve(&image_id, canonical_key).unwrap();
    assert_eq!(
        location.path().clone(),
        Path::from("0/c/0/0/0/0/0/0"),
        "chunk path should have a 0 injected at the m position",
    );
    assert_eq!(
        fs::read(dir.join(location.path().as_ref())).unwrap(),
        ENC_6D_BLOSC
    );

    let read = read_chunk(
        &resolver,
        &store,
        &image_id,
        canonical_key,
        ReaderId::UNATTRIBUTED,
        RequestLabel::UNATTRIBUTED,
        None,
    )
    .await
    .unwrap();
    let ChunkRead::Present(decoded) = read else {
        panic!("the chunk is on disk");
    };

    assert_eq!(
        decoded.len(),
        EXPECTED_M0_BYTES.len(),
        "after slicing, bytes must match canonical 5D chunk size",
    );
    assert_eq!(
        decoded, EXPECTED_M0_BYTES,
        "sliced bytes must equal the m=0 plaintext slice",
    );

    let _ = fs::remove_dir_all(&dir);
}
