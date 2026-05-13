//! Integration tests for the `clear-proxy-cache` library helper.
//!
//! These cover the synchronous logic that backs both the
//! `lucida-server clear-proxy-cache` subcommand and the
//! `POST /admin/clear-proxy-cache` endpoint:
//!
//!   - Clearing a single dataset only removes its own subdirectory.
//!   - Clearing without a dataset URL removes every dataset subdir but
//!     leaves the cache root in place.
//!   - A missing cache directory is treated as "0 cleared", not an error.
//!   - File counts in the returned `ClearOutcome` match the synthetic
//!     layout we pre-populate.
//!
//! We pre-populate a tempdir matching the on-disk layout owned by
//! `proxy::ProxyCache` —
//! `{cache_dir}/{url_hash hex}/{entity_id}/{kind}/T{t:05}_C{c:03}.bin` —
//! so we exercise the helper against the real path scheme.

use std::fs;
use std::path::{Path, PathBuf};

use lucida_server::admin::clear_proxy_cache;
use lucida_server::handler::dataset_url_hash16;

const URL_A: &str = "gs://lucida-test/datasets/dataset-a.zarr";
const URL_B: &str = "gs://lucida-test/datasets/dataset-b.zarr";

/// Hex-encode a 16-byte hash to 32 lowercase chars. Mirrors the helper
/// inside `proxy::cache` so that test paths line up with what the cache
/// would produce in production.
fn hex16(bytes: &[u8; 16]) -> String {
    let mut out = String::with_capacity(32);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Drop a couple of fake `T{t:05}_C{c:03}.bin` files into the per-dataset
/// directory, recreating the layout `ProxyCache` would create. Returns
/// the dataset directory path.
fn populate_dataset(cache_dir: &Path, url: &str, files: &[(&str, &str)]) -> PathBuf {
    let hash = dataset_url_hash16(url);
    let dataset_dir = cache_dir.join(hex16(&hash));
    for (entity, kind) in files {
        let dir = dataset_dir.join(entity).join(kind);
        fs::create_dir_all(&dir).unwrap();
        // Two synthetic chunks per (entity, kind) so file counts > 1.
        for (t, c) in [(0u32, 0u32), (1, 0)] {
            let path = dir.join(format!("T{t:05}_C{c:03}.bin"));
            fs::write(&path, b"fake-proxy-bytes").unwrap();
        }
    }
    dataset_dir
}

#[test]
fn clear_specific_dataset_removes_only_that_subdir() {
    let tmp = tempfile::tempdir().unwrap();
    let cache_dir = tmp.path().to_path_buf();

    let dir_a = populate_dataset(&cache_dir, URL_A, &[("entity-a1", "field3d")]);
    let dir_b = populate_dataset(&cache_dir, URL_B, &[("entity-b1", "well3d")]);
    assert!(dir_a.exists());
    assert!(dir_b.exists());

    let outcome = clear_proxy_cache(&cache_dir, Some(URL_A)).unwrap();
    assert_eq!(outcome.datasets, 1);
    assert_eq!(
        outcome.files, 2,
        "should have counted the two synthetic chunks"
    );

    assert!(!dir_a.exists(), "URL_A's data should be gone");
    assert!(dir_b.exists(), "URL_B's data should be untouched");
}

#[test]
fn clear_unknown_dataset_is_zero_outcome() {
    let tmp = tempfile::tempdir().unwrap();
    let cache_dir = tmp.path().to_path_buf();

    // Populate one dataset, then clear a different URL that was never
    // written. Should be a no-op with `datasets = 0`.
    let dir_a = populate_dataset(&cache_dir, URL_A, &[("entity-a1", "field3d")]);
    let outcome = clear_proxy_cache(&cache_dir, Some(URL_B)).unwrap();
    assert_eq!(outcome.datasets, 0);
    assert_eq!(outcome.files, 0);
    assert!(dir_a.exists(), "URL_A's data should still be present");
}

#[test]
fn clear_all_datasets_removes_every_subdir_but_keeps_root() {
    let tmp = tempfile::tempdir().unwrap();
    let cache_dir = tmp.path().to_path_buf();

    let dir_a = populate_dataset(
        &cache_dir,
        URL_A,
        &[("entity-a1", "field3d"), ("entity-a2", "well3d")],
    );
    let dir_b = populate_dataset(&cache_dir, URL_B, &[("entity-b1", "field3d")]);

    let outcome = clear_proxy_cache(&cache_dir, None).unwrap();
    assert_eq!(outcome.datasets, 2);
    // 2 entities x 2 chunks for A + 1 entity x 2 chunks for B = 6
    assert_eq!(outcome.files, 6);

    assert!(!dir_a.exists());
    assert!(!dir_b.exists());
    assert!(cache_dir.exists(), "cache root itself should remain");
}

#[test]
fn clear_missing_cache_dir_is_ok() {
    // Path that has never existed.
    let tmp = tempfile::tempdir().unwrap();
    let missing = tmp.path().join("does-not-exist");
    assert!(!missing.exists());

    let outcome_specific = clear_proxy_cache(&missing, Some(URL_A)).unwrap();
    assert_eq!(outcome_specific.datasets, 0);
    assert_eq!(outcome_specific.files, 0);

    let outcome_all = clear_proxy_cache(&missing, None).unwrap();
    assert_eq!(outcome_all.datasets, 0);
    assert_eq!(outcome_all.files, 0);
}

#[test]
fn clear_all_skips_top_level_files() {
    // The layout never puts files at the top level, but if some stray
    // file appears there (e.g. a `.DS_Store`), `clear_proxy_cache(None)`
    // should ignore it and not count it as a dataset.
    let tmp = tempfile::tempdir().unwrap();
    let cache_dir = tmp.path().to_path_buf();
    populate_dataset(&cache_dir, URL_A, &[("entity-a1", "field3d")]);
    fs::write(cache_dir.join(".stray"), b"junk").unwrap();

    let outcome = clear_proxy_cache(&cache_dir, None).unwrap();
    assert_eq!(outcome.datasets, 1, "only real subdirs count as datasets");
    assert_eq!(outcome.files, 2);

    // Stray file should still be there since we only walked subdirs.
    assert!(cache_dir.join(".stray").exists());
}

#[test]
fn clear_specific_dataset_url_hash_matches_proxy_cache_layout() {
    // Sanity check: the helper walks the *exact* directory the
    // `ProxyCache` would have created for the same URL. If S4's hashing
    // scheme changes, this test surfaces the drift.
    let tmp = tempfile::tempdir().unwrap();
    let cache_dir = tmp.path().to_path_buf();
    let expected_subdir = cache_dir.join(hex16(&dataset_url_hash16(URL_A)));
    fs::create_dir_all(expected_subdir.join("e/k")).unwrap();
    fs::write(expected_subdir.join("e/k/T00000_C000.bin"), b"x").unwrap();

    let outcome = clear_proxy_cache(&cache_dir, Some(URL_A)).unwrap();
    assert_eq!(outcome.datasets, 1);
    assert_eq!(outcome.files, 1);
    assert!(!expected_subdir.exists());
}
