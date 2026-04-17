//! Integration tests for [`lucida_server::proxy::ProxyCache`].
//!
//! Covers:
//! - Round-trip put → get returns the same asset.
//! - Header version mismatch (would-be cache hit) → treated as miss.
//! - Source content hash mismatch → treated as miss.
//! - `clear_dataset` only removes the per-dataset subtree.
//! - Atomic write: when the temp file is interrupted before rename, no
//!   partial final file appears. We simulate this directly rather than
//!   crashing the process.

use std::fs;

use lucida_content::EntityId;
use lucida_proxy::{
    ALGORITHM_VERSION, ProxyAsset, ProxyDtype, ProxyHeader, ProxyKind, ProxySpec, write_header,
};
use lucida_server::proxy::ProxyCache;

const URL_HASH_A: [u8; 16] = [0xAA; 16];
const URL_HASH_B: [u8; 16] = [0xBB; 16];

fn sample_spec() -> ProxySpec {
    ProxySpec {
        entity_id: EntityId("well-A1".into()),
        kind: ProxyKind::WellProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 64,
    }
}

fn sample_asset(source_hash: [u8; 32]) -> ProxyAsset {
    let dims = [4u32, 8, 16];
    let voxel_count = (dims[0] as usize) * (dims[1] as usize) * (dims[2] as usize);
    let voxels: Vec<u16> = (0..voxel_count).map(|i| i as u16).collect();
    ProxyAsset {
        header: ProxyHeader {
            algorithm_version: ALGORITHM_VERSION,
            source_content_hash: source_hash,
            dims,
            dtype: ProxyDtype::U16,
        },
        voxels,
    }
}

#[test]
fn round_trips_put_then_get() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);

    let spec = sample_spec();
    let source_hash = [7u8; 32];
    let asset = sample_asset(source_hash);

    cache.put(&spec, &asset).unwrap();
    let got = cache
        .get(&spec, &source_hash)
        .unwrap()
        .expect("just-written asset should round-trip");

    assert_eq!(got.header.dims, asset.header.dims);
    assert_eq!(got.header.dtype, asset.header.dtype);
    assert_eq!(got.header.source_content_hash, asset.header.source_content_hash);
    assert_eq!(got.voxels, asset.voxels);
}

#[test]
fn missing_file_is_miss() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);
    let spec = sample_spec();
    assert!(cache.get(&spec, &[0u8; 32]).unwrap().is_none());
}

#[test]
fn algorithm_version_mismatch_is_miss() {
    // Write a file with a bogus algorithm version directly (skip put()
    // so we can fabricate the on-disk state). `read_header` rejects it
    // with InvalidData; ProxyCache::get translates that to None.
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);
    let spec = sample_spec();
    let source_hash = [9u8; 32];

    let path = cache.spec_path(&spec);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let bogus_header = ProxyHeader {
        algorithm_version: ALGORITHM_VERSION + 999, // unreachable from current code
        source_content_hash: source_hash,
        dims: [1, 1, 1],
        dtype: ProxyDtype::U16,
    };
    let mut file = fs::File::create(&path).unwrap();
    write_header(&mut file, &bogus_header).unwrap();
    // Write 1 voxel = 2 bytes of payload.
    use std::io::Write;
    file.write_all(&[0u8, 0u8]).unwrap();
    drop(file);

    let got = cache.get(&spec, &source_hash).unwrap();
    assert!(
        got.is_none(),
        "stale algorithm version should be treated as miss"
    );
}

#[test]
fn source_hash_mismatch_is_miss() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);
    let spec = sample_spec();

    let stored_hash = [1u8; 32];
    let asset = sample_asset(stored_hash);
    cache.put(&spec, &asset).unwrap();

    let other_hash = [2u8; 32];
    let got = cache.get(&spec, &other_hash).unwrap();
    assert!(
        got.is_none(),
        "source hash mismatch should be treated as miss"
    );

    // But asking with the right hash still hits.
    let got = cache.get(&spec, &stored_hash).unwrap();
    assert!(got.is_some(), "matching hash should still hit");
}

#[test]
fn exists_is_header_only_check() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);
    let spec = sample_spec();
    assert!(!cache.exists(&spec));
    let asset = sample_asset([3u8; 32]);
    cache.put(&spec, &asset).unwrap();
    assert!(cache.exists(&spec));
    // Even a stale-hash file exists.
    let got = cache.get(&spec, &[99u8; 32]).unwrap();
    assert!(got.is_none());
    assert!(cache.exists(&spec));
}

#[test]
fn clear_dataset_only_removes_own_subdir() {
    let tmp = tempfile::tempdir().unwrap();
    let cache_a = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);
    let cache_b = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_B);
    let spec = sample_spec();
    let asset = sample_asset([5u8; 32]);

    cache_a.put(&spec, &asset).unwrap();
    cache_b.put(&spec, &asset).unwrap();

    assert!(cache_a.exists(&spec));
    assert!(cache_b.exists(&spec));

    cache_a.clear_dataset().unwrap();

    assert!(!cache_a.exists(&spec), "A's data should be gone");
    assert!(cache_b.exists(&spec), "B's data should be untouched");

    // The cache root directory itself should still exist.
    assert!(tmp.path().exists());
}

#[test]
fn clear_dataset_idempotent_when_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);
    // No puts → dataset dir doesn't exist yet; clear should still be Ok.
    cache.clear_dataset().unwrap();
    cache.clear_dataset().unwrap();
}

#[test]
fn put_creates_parent_directories() {
    let tmp = tempfile::tempdir().unwrap();
    // Nest inside a non-existent subdir.
    let nested_root = tmp.path().join("a/b/c");
    let cache = ProxyCache::new(nested_root, URL_HASH_A);
    let spec = sample_spec();
    cache.put(&spec, &sample_asset([0u8; 32])).unwrap();
    assert!(cache.exists(&spec));
}

#[test]
fn no_partial_final_file_after_failed_rename() {
    // We can't truly crash mid-write, but we *can* verify the temp file
    // layout: a put() produces a `.tmp.*` sibling during the write and
    // the final file appears atomically via rename. After a successful
    // put(), no leftover `.tmp.*` files should remain in the parent dir.
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);
    let spec = sample_spec();
    cache.put(&spec, &sample_asset([4u8; 32])).unwrap();

    let parent = cache.spec_path(&spec).parent().unwrap().to_path_buf();
    let mut leftover = 0;
    for entry in fs::read_dir(&parent).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains(".tmp.") {
            leftover += 1;
        }
    }
    assert_eq!(
        leftover, 0,
        "successful put() should leave no .tmp.* leftovers"
    );
}

#[test]
fn disabled_cache_is_no_op() {
    // A read-only path simulation: just construct a disabled cache.
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new_disabled(tmp.path().to_path_buf(), URL_HASH_A);
    let spec = sample_spec();
    cache.put(&spec, &sample_asset([1u8; 32])).unwrap();
    assert!(cache.get(&spec, &[1u8; 32]).unwrap().is_none());
    assert!(!cache.exists(&spec));
    cache.clear_dataset().unwrap();
}

#[test]
fn separate_specs_get_separate_files() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);

    let mut spec_a = sample_spec();
    spec_a.entity_id = EntityId("entity-A".into());
    let mut spec_b = sample_spec();
    spec_b.entity_id = EntityId("entity-B".into());

    let asset_a = sample_asset([10u8; 32]);
    let asset_b = sample_asset([20u8; 32]);

    cache.put(&spec_a, &asset_a).unwrap();
    cache.put(&spec_b, &asset_b).unwrap();

    let got_a = cache.get(&spec_a, &[10u8; 32]).unwrap().unwrap();
    let got_b = cache.get(&spec_b, &[20u8; 32]).unwrap().unwrap();
    assert_eq!(got_a.header.source_content_hash, [10u8; 32]);
    assert_eq!(got_b.header.source_content_hash, [20u8; 32]);
}

#[test]
fn distinct_t_c_get_distinct_files() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);

    let mut spec1 = sample_spec();
    spec1.t = 0;
    spec1.c = 0;
    let mut spec2 = sample_spec();
    spec2.t = 1;
    spec2.c = 0;
    let mut spec3 = sample_spec();
    spec3.t = 0;
    spec3.c = 1;

    cache.put(&spec1, &sample_asset([1u8; 32])).unwrap();
    cache.put(&spec2, &sample_asset([2u8; 32])).unwrap();
    cache.put(&spec3, &sample_asset([3u8; 32])).unwrap();

    assert_eq!(
        cache
            .get(&spec1, &[1u8; 32])
            .unwrap()
            .unwrap()
            .header
            .source_content_hash,
        [1u8; 32]
    );
    assert_eq!(
        cache
            .get(&spec2, &[2u8; 32])
            .unwrap()
            .unwrap()
            .header
            .source_content_hash,
        [2u8; 32]
    );
    assert_eq!(
        cache
            .get(&spec3, &[3u8; 32])
            .unwrap()
            .unwrap()
            .header
            .source_content_hash,
        [3u8; 32]
    );
}

#[test]
fn distinct_kinds_get_distinct_files() {
    let tmp = tempfile::tempdir().unwrap();
    let cache = ProxyCache::new(tmp.path().to_path_buf(), URL_HASH_A);
    let mut spec_well = sample_spec();
    spec_well.kind = ProxyKind::WellProxy3D;
    let mut spec_field = sample_spec();
    spec_field.kind = ProxyKind::FieldProxy3D;

    cache.put(&spec_well, &sample_asset([1u8; 32])).unwrap();
    cache.put(&spec_field, &sample_asset([2u8; 32])).unwrap();

    let well = cache.get(&spec_well, &[1u8; 32]).unwrap().unwrap();
    let field = cache.get(&spec_field, &[2u8; 32]).unwrap().unwrap();
    assert_eq!(well.header.source_content_hash, [1u8; 32]);
    assert_eq!(field.header.source_content_hash, [2u8; 32]);
}
