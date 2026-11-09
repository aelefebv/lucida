//! Zarr v2 / OME-NGFF 0.4 datasets and Zarr v3 codec chains, opened and read
//! through the server's own open and chunk-read paths.
//!
//! Each committed fixture here is the twin of a Zarr v3 one written with the
//! same options and seed, so it holds the same samples. Every chunk key must
//! then be served byte for byte as its twin serves it, whatever the format,
//! codec chain, byte order, or memory order on disk.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::workspace_rig::WorkspaceRig;
use lucida_content::{ChunkKey, DataType, DatasetManifest, ImageId};
use lucida_protocol::DatasetOpenFailureKind;
use lucida_server::GeneratedConfig;
use lucida_server::binding::ChunkResolver;
use lucida_server::chunk_read::{ChunkRead, read_chunk};
use lucida_server::dataset_open::{DatasetOpenContext, DatasetOpenOutcome, open_dataset};
use lucida_store::cache::{CachedStore, DEFAULT_SOURCE_CACHE_BYTES};
use lucida_store::import::import_dataset;
use lucida_store::import_types::ImportResult;
use lucida_store::source_limiter::{ReaderId, RequestLabel};
use tokio::sync::mpsc;

fn fixture_dir(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join("ome-zarr")
        .join(name)
}

struct Imported {
    store: Arc<CachedStore>,
    result: ImportResult,
    resolver: ChunkResolver,
}

async fn import_dir(dir: &Path) -> Imported {
    let store = Arc::new(CachedStore::new(
        lucida_store::backend::open(&dir.to_str().unwrap().parse().unwrap()).unwrap(),
        DEFAULT_SOURCE_CACHE_BYTES,
    ));
    let result = import_dataset(&store, "ds", "ds")
        .await
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
    assert!(
        result.warnings.is_empty(),
        "{}: {:?}",
        dir.display(),
        result.warnings
    );
    let resolver = ChunkResolver::new(&result.binding_seed);
    Imported {
        store,
        result,
        resolver,
    }
}

async fn served(imported: &Imported, image_id: &ImageId, key: &str) -> ChunkRead {
    read_chunk(
        &imported.resolver,
        &imported.store,
        image_id,
        &key.parse::<ChunkKey>().unwrap(),
        ReaderId(1),
        RequestLabel(1),
    )
    .await
    .unwrap_or_else(|e| panic!("{image_id}/{key}: {e}"))
}

/// Every chunk key of every source image, at every level, timepoint, and
/// channel.
fn chunk_keys(manifest: &DatasetManifest) -> Vec<(ImageId, String)> {
    let mut keys = Vec::new();
    for image in manifest.images() {
        for level in &image.multiscale.levels {
            let [times, channels, depth, rows, columns] = level.grid_shape;
            for t in 0..times {
                for c in 0..channels {
                    for z in 0..depth {
                        for y in 0..rows {
                            for x in 0..columns {
                                keys.push((
                                    image.image_id.clone(),
                                    format!("{}/{t}/{c}/{z}/{y}/{x}", level.level_index),
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    keys
}

/// The two fixtures declare the same images and levels, and every chunk key
/// reads as the same bytes from both. Returns how many keys held samples.
async fn assert_served_identically(name: &str, twin: &str) -> usize {
    let dataset = import_dir(&fixture_dir(name)).await;
    let reference = import_dir(&fixture_dir(twin)).await;
    let images = |imported: &Imported| {
        imported
            .result
            .manifest
            .images()
            .iter()
            .map(|image| (image.image_id.clone(), image.multiscale.levels.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(images(&dataset), images(&reference), "{name}");

    let mut present = 0;
    for (image_id, key) in chunk_keys(&reference.result.manifest) {
        let from_dataset = served(&dataset, &image_id, &key).await;
        let from_twin = served(&reference, &image_id, &key).await;
        assert!(
            matches!(from_dataset, ChunkRead::Present(_)),
            "{name}: {image_id}/{key} read as absent"
        );
        assert_eq!(from_dataset, from_twin, "{name}: {image_id}/{key}");
        present += 1;
    }
    present
}

/// Blosc with lz4 and byte shuffle, numcodecs' default compressor, with `/`
/// between chunk coordinates.
#[tokio::test]
async fn a_zarr_v2_image_serves_the_same_chunks_as_its_v3_twin() {
    let present = assert_served_identically("v2-twin.ome.zarr", "twin-unsharded.ome.zarr").await;
    assert_eq!(present, 2 * (25 + 9 + 4));
}

/// Fortran order, big-endian samples, zstd, and `.` between chunk
/// coordinates, in a collection of three tiles.
#[tokio::test]
async fn a_zarr_v2_collection_serves_the_same_chunks_as_its_v3_twin() {
    let present =
        assert_served_identically("v2-collection.ome.zarr", "collection-unsharded.ome.zarr").await;
    assert_eq!(present, 3 * (9 + 2));
}

/// Shards of levels whose arrays are `s0`, `s1`, and `s2`, not the level
/// index.
#[tokio::test]
async fn level_arrays_named_other_than_their_index_serve_their_twin_s_chunks() {
    let present =
        assert_served_identically("v3-level-paths.ome.zarr", "twin-unsharded.ome.zarr").await;
    assert_eq!(present, 2 * (25 + 9 + 4));
}

/// A Zarr v2 collection whose levels are named `s0` and `s1`, with every
/// metadata document consolidated into its root `.zmetadata`.
#[tokio::test]
async fn a_consolidated_zarr_v2_collection_with_named_levels_serves_its_twin_s_chunks() {
    let present =
        assert_served_identically("v2-consolidated.ome.zarr", "collection-unsharded.ome.zarr")
            .await;
    assert_eq!(present, 3 * (9 + 2));
}

/// Opening a consolidated hierarchy reads its root and nothing else that
/// metadata holds: the groups, tiles, levels, and absent label groups all
/// come from `.zmetadata`. The same collection unconsolidated reads every
/// one of them.
#[tokio::test]
async fn a_consolidated_zarr_v2_open_reads_only_its_root_metadata() {
    let reads = |name: &'static str| async move {
        import_dir(&fixture_dir(name))
            .await
            .store
            .stats()
            .source_reads
    };
    let consolidated = reads("v2-consolidated.ome.zarr").await;
    let unconsolidated = reads("v2-collection.ome.zarr").await;
    // zarr.json (absent), .zattrs, and .zmetadata, then one origin-chunk
    // probe per level for the unwritten-level check.
    assert_eq!(consolidated, 3 + 2, "consolidated open");
    assert!(
        unconsolidated > consolidated + 3 * 3,
        "unconsolidated open read {unconsolidated} objects, consolidated {consolidated}"
    );
}

/// A Zarr v3 collection whose levels are named `s0` and `s1`, with every
/// metadata document consolidated inline in its root `zarr.json`.
#[tokio::test]
async fn a_consolidated_zarr_v3_collection_with_named_levels_serves_its_twin_s_chunks() {
    let present =
        assert_served_identically("v3-consolidated.ome.zarr", "collection-unsharded.ome.zarr")
            .await;
    assert_eq!(present, 3 * (9 + 2));
}

/// Opening a consolidated v3 hierarchy reads its root `zarr.json` and nothing
/// else that metadata holds, though every group and level still has its own
/// `zarr.json` beside the copy.
#[tokio::test]
async fn a_consolidated_zarr_v3_open_reads_only_its_root_metadata() {
    let reads = |name: &'static str| async move {
        import_dir(&fixture_dir(name))
            .await
            .store
            .stats()
            .source_reads
    };
    let consolidated = reads("v3-consolidated.ome.zarr").await;
    let unconsolidated = reads("collection-unsharded.ome.zarr").await;
    // zarr.json, then one origin-chunk probe per level for the
    // unwritten-level check.
    assert_eq!(consolidated, 1 + 2, "consolidated open");
    assert!(
        unconsolidated > consolidated + 3 * 3,
        "unconsolidated open read {unconsolidated} objects, consolidated {consolidated}"
    );
}

/// The samples of every chunk of a single-image fixture, at every level, as
/// the server serves them: little-endian, `size` bytes each.
async fn served_samples(name: &str, size: usize) -> Vec<Vec<u8>> {
    let imported = import_dir(&fixture_dir(name)).await;
    let mut samples = Vec::new();
    for (image_id, key) in chunk_keys(&imported.result.manifest) {
        let ChunkRead::Present(bytes) = served(&imported, &image_id, &key).await else {
            panic!("{name}: {image_id}/{key} read as absent");
        };
        assert_eq!(bytes.len() % size, 0, "{name}: {key}");
        samples.extend(bytes.chunks_exact(size).map(<[u8]>::to_vec));
    }
    samples
}

/// 64-bit integers and halves are imported as their own types and served
/// whole, so values only those types hold arrive intact.
#[tokio::test]
async fn data_types_past_32_bits_and_below_float32_serve_their_own_values() {
    for (name, data_type) in [
        ("dtype-int64.ome.zarr", DataType::Int64),
        ("dtype-uint64.ome.zarr", DataType::Uint64),
        ("dtype-float16.ome.zarr", DataType::Float16),
    ] {
        let imported = import_dir(&fixture_dir(name)).await;
        let image = &imported.result.manifest.images()[0];
        assert_eq!(image.multiscale.data_type, data_type, "{name}");
    }

    let int64: Vec<i64> = served_samples("dtype-int64.ome.zarr", 8)
        .await
        .iter()
        .map(|b| i64::from_le_bytes(b.as_slice().try_into().unwrap()))
        .collect();
    assert!(int64.iter().any(|&v| v < -(1 << 31)), "{int64:?}");
    assert!(int64.iter().any(|&v| v > 1 << 31), "{int64:?}");
    assert!(int64.iter().all(|v| v.abs() <= 6_000_000_000));

    let uint64: Vec<u64> = served_samples("dtype-uint64.ome.zarr", 8)
        .await
        .iter()
        .map(|b| u64::from_le_bytes(b.as_slice().try_into().unwrap()))
        .collect();
    assert!(uint64.iter().any(|&v| v > 1 << 63), "{uint64:?}");

    let halves: Vec<u16> = served_samples("dtype-float16.ome.zarr", 2)
        .await
        .iter()
        .map(|b| u16::from_le_bytes(b.as_slice().try_into().unwrap()))
        .collect();
    let negative = |h: u16| h & 0x8000 != 0;
    // Every sample is finite and within the range written, which a byte
    // swap or a misread width would scatter.
    assert!(halves.iter().all(|&h| h & 0x7c00 != 0x7c00), "{halves:?}");
    assert!(halves.iter().all(|&h| (h & 0x7fff) <= 0x63d0), "{halves:?}");
    assert!(halves.iter().any(|&h| negative(h)) && halves.iter().any(|&h| !negative(h)));
}

/// `[transpose, bytes(big), gzip, crc32c]`.
#[tokio::test]
async fn a_zarr_v3_chain_of_transpose_big_endian_gzip_and_crc32c_serves_its_twin_s_chunks() {
    let present =
        assert_served_identically("v3-codec-chain.ome.zarr", "twin-unsharded.ome.zarr").await;
    assert_eq!(present, 2 * (25 + 9 + 4));
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("lucida_zarr_formats_{}", std::process::id()))
        .join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

async fn open(
    dir: &Path,
) -> Result<DatasetOpenOutcome, lucida_protocol::DatasetOpenFailureDiagnostic> {
    let root = dir.parent().unwrap().join(format!(
        "{}-caches",
        dir.file_name().unwrap().to_string_lossy()
    ));
    let generated_config = GeneratedConfig {
        generated_enabled: false,
        generated_cache_dir: root.join("generated"),
        ..GeneratedConfig::defaults()
    };
    let rig = WorkspaceRig::start(generated_config.clone()).await;
    let (progress, _progress_rx) = mpsc::unbounded_channel();
    open_dataset(
        1,
        &dir.to_str().unwrap().parse().unwrap(),
        &DatasetOpenContext {
            generated_config,
            source_policy: Arc::default(),
            workspace: rig.scope(),
        },
        &progress,
    )
    .await
}

#[tokio::test]
async fn every_committed_fixture_of_another_format_or_layout_opens_through_the_server() {
    for name in [
        "v2-twin.ome.zarr",
        "v2-collection.ome.zarr",
        "v2-consolidated.ome.zarr",
        "v3-level-paths.ome.zarr",
        "v3-consolidated.ome.zarr",
        "dtype-int64.ome.zarr",
        "dtype-uint64.ome.zarr",
        "dtype-float16.ome.zarr",
    ] {
        let outcome = open(&fixture_dir(name))
            .await
            .unwrap_or_else(|failure| panic!("{name}: {failure:?}"));
        assert!(
            matches!(outcome, DatasetOpenOutcome::Opened { .. }),
            "{name}"
        );
    }
}

/// One Zarr v2 image of one 2x4 `<u2` chunk, with `zarray` overriding the
/// array metadata and `chunk` written as the chunk's object when given.
fn write_v2_image(dir: &Path, zarray: serde_json::Value, chunk: Option<&[u8]>) {
    fs::write(dir.join(".zgroup"), r#"{"zarr_format": 2}"#).unwrap();
    let attributes = serde_json::json!({
        "multiscales": [{
            "version": "0.4",
            "axes": [{"name": "y", "type": "space"}, {"name": "x", "type": "space"}],
            "datasets": [{
                "path": "0",
                "coordinateTransformations": [{"type": "scale", "scale": [1.0, 1.0]}]
            }]
        }],
        "omero": {"channels": [{"label": "only", "color": "FF0000"}]}
    });
    fs::write(dir.join(".zattrs"), attributes.to_string()).unwrap();
    let level = dir.join("0");
    fs::create_dir_all(&level).unwrap();
    let mut meta = serde_json::json!({
        "zarr_format": 2,
        "shape": [2, 4],
        "chunks": [2, 4],
        "dtype": "<u2",
        "compressor": null,
        "fill_value": 0,
        "order": "C",
        "filters": null
    });
    for (key, value) in zarray.as_object().unwrap() {
        meta[key] = value.clone();
    }
    fs::write(level.join(".zarray"), meta.to_string()).unwrap();
    if let Some(chunk) = chunk {
        fs::write(level.join("0.0"), chunk).unwrap();
    }
}

/// The open fails at import, typed as an unsupported codec, and the message
/// names the codec so it can be found in the metadata.
#[tokio::test]
async fn a_zarr_v2_compressor_lucida_does_not_decode_fails_the_open_by_name() {
    let dir = temp_dir("unsupported_compressor");
    write_v2_image(
        &dir,
        serde_json::json!({"compressor": {"id": "bz2", "level": 9}}),
        None,
    );
    let failure = match open(&dir).await {
        Ok(_) => panic!("a bz2 compressor must not open"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.kind,
        DatasetOpenFailureKind::UnsupportedCodec,
        "{failure:?}"
    );
    assert!(failure.message.contains("bz2"), "{}", failure.message);
    assert!(failure.message.contains("level 0"), "{}", failure.message);

    let _ = fs::remove_dir_all(&dir);
}

/// A chunk nobody wrote reads as the array's fill value, here a `<u2` 300.
#[tokio::test]
async fn an_unwritten_zarr_v2_chunk_reads_as_the_fill_value() {
    let dir = temp_dir("fill_value");
    write_v2_image(&dir, serde_json::json!({"fill_value": 300}), None);
    let imported = import_dir(&dir).await;
    let image = &imported.result.manifest.images()[0];
    assert_eq!(image.multiscale.channel_infos[0].label, "only");

    let bytes = served(&imported, &image.image_id, "0/0/0/0/0/0")
        .await
        .into_bytes();
    assert_eq!(bytes, 300u16.to_le_bytes().repeat(8));

    let _ = fs::remove_dir_all(&dir);
}

/// A one-byte array needs no byte order, and its chunk is read raw when the
/// array has no compressor.
#[tokio::test]
async fn an_uncompressed_one_byte_zarr_v2_array_reads_its_chunk_as_stored() {
    let dir = temp_dir("one_byte");
    let stored: Vec<u8> = (10..18).collect();
    write_v2_image(&dir, serde_json::json!({"dtype": "|u1"}), Some(&stored));
    let imported = import_dir(&dir).await;
    let image_id = imported.result.manifest.images()[0].image_id.clone();

    let read = served(&imported, &image_id, "0/0/0/0/0/0").await;
    assert_eq!(read, ChunkRead::Present(stored));

    let _ = fs::remove_dir_all(&dir);
}

/// A label group under a Zarr v2 image is found through `labels/.zattrs`,
/// and its own `.zarray` levels are read like the image's, under the path
/// its own multiscale gives each one.
#[tokio::test]
async fn a_zarr_v2_label_attaches_to_its_image_and_serves_its_chunk() {
    let dir = temp_dir("label");
    write_v2_image(&dir, serde_json::json!({}), None);
    let labels = dir.join("labels");
    let mask = labels.join("mask");
    fs::create_dir_all(mask.join("s0")).unwrap();
    fs::write(labels.join(".zattrs"), r#"{"labels": ["mask"]}"#).unwrap();
    let attributes = serde_json::json!({
        "multiscales": [{
            "version": "0.4",
            "axes": [{"name": "y", "type": "space"}, {"name": "x", "type": "space"}],
            "datasets": [{
                "path": "s0",
                "coordinateTransformations": [{"type": "scale", "scale": [1.0, 1.0]}]
            }]
        }],
        "image-label": {"version": "0.4", "colors": [{"label-value": 1, "rgba": [255, 0, 0, 255]}]}
    });
    fs::write(mask.join(".zattrs"), attributes.to_string()).unwrap();
    let zarray = serde_json::json!({
        "zarr_format": 2,
        "shape": [2, 4],
        "chunks": [2, 4],
        "dtype": "|u1",
        "compressor": {"id": "zlib", "level": 1},
        "fill_value": 0,
        "order": "C",
        "filters": null,
        "dimension_separator": "/"
    });
    fs::write(mask.join("s0").join(".zarray"), zarray.to_string()).unwrap();
    let samples = [0u8, 1, 1, 0, 1, 0, 0, 1];
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(1));
    std::io::Write::write_all(&mut encoder, &samples).unwrap();
    fs::create_dir_all(mask.join("s0").join("0")).unwrap();
    fs::write(
        mask.join("s0").join("0").join("0"),
        encoder.finish().unwrap(),
    )
    .unwrap();

    let imported = import_dir(&dir).await;
    let attached = imported.result.manifest.labels();
    assert_eq!(attached.len(), 1);
    assert_eq!(attached[0].name, "mask");
    let read = served(&imported, &attached[0].label_image_id, "0/0/0/0/0/0").await;
    assert_eq!(read, ChunkRead::Present(samples.to_vec()));

    let _ = fs::remove_dir_all(&dir);
}
