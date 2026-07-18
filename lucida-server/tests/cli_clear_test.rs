//! Integration tests for the compatibility-named `clear-proxy-cache` surface,
//! which clears the generated-coarse derived-data cache.
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
//! We pre-populate a tempdir matching the generated cache's canonical
//! `{cache_dir}/{source identity digest}/{source revision}/...` layout.

use std::fs;
use std::path::{Path, PathBuf};

use lucida_content::url::{SourceIdentity, dataset_url_hash16};
use lucida_server::admin::{DerivedCacheRoots, clear_derived_cache, clear_derived_cache_roots};

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

fn clear(
    cache_dir: &Path,
    url: Option<&str>,
) -> std::io::Result<lucida_server::admin::ClearOutcome> {
    let identity = url.map(SourceIdentity::parse).transpose().unwrap();
    clear_derived_cache(cache_dir, identity.as_ref())
}

/// Drop fake chunks into a source identity/revision directory.
fn populate_dataset(cache_dir: &Path, url: &str, files: &[(&str, &str)]) -> PathBuf {
    let identity = SourceIdentity::parse(url).unwrap();
    let dataset_dir = cache_dir.join(identity.digest_hex());
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

    let dir_a = populate_dataset(&cache_dir, URL_A, &[("entity-a1", "tile3d")]);
    let dir_b = populate_dataset(&cache_dir, URL_B, &[("entity-b1", "group3d")]);
    assert!(dir_a.exists());
    assert!(dir_b.exists());

    let outcome = clear(&cache_dir, Some(URL_A)).unwrap();
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
    let dir_a = populate_dataset(&cache_dir, URL_A, &[("entity-a1", "tile3d")]);
    let outcome = clear(&cache_dir, Some(URL_B)).unwrap();
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
        &[("entity-a1", "tile3d"), ("entity-a2", "group3d")],
    );
    let dir_b = populate_dataset(&cache_dir, URL_B, &[("entity-b1", "tile3d")]);

    let outcome = clear(&cache_dir, None).unwrap();
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

    let outcome_specific = clear(&missing, Some(URL_A)).unwrap();
    assert_eq!(outcome_specific.datasets, 0);
    assert_eq!(outcome_specific.files, 0);

    let outcome_all = clear(&missing, None).unwrap();
    assert_eq!(outcome_all.datasets, 0);
    assert_eq!(outcome_all.files, 0);
}

#[test]
fn clear_all_skips_top_level_files() {
    // The layout never puts files at the top level, but if some stray
    // file appears there (e.g. a `.DS_Store`), a full clear
    // should ignore it and not count it as a dataset.
    let tmp = tempfile::tempdir().unwrap();
    let cache_dir = tmp.path().to_path_buf();
    populate_dataset(&cache_dir, URL_A, &[("entity-a1", "tile3d")]);
    fs::write(cache_dir.join(".stray"), b"junk").unwrap();

    let outcome = clear(&cache_dir, None).unwrap();
    assert_eq!(outcome.datasets, 1, "only real subdirs count as datasets");
    assert_eq!(outcome.files, 2);

    // Stray file should still be there since we only walked subdirs.
    assert!(cache_dir.join(".stray").exists());
}

#[test]
fn targeted_clear_removes_proxy_era_hash_as_migration_cleanup() {
    let tmp = tempfile::tempdir().unwrap();
    let cache_dir = tmp.path().to_path_buf();
    let expected_subdir = cache_dir.join(hex16(&dataset_url_hash16(URL_A)));
    fs::create_dir_all(expected_subdir.join("e/k")).unwrap();
    fs::write(expected_subdir.join("e/k/T00000_C000.bin"), b"x").unwrap();

    let outcome = clear(&cache_dir, Some(URL_A)).unwrap();
    assert_eq!(outcome.datasets, 1);
    assert_eq!(outcome.files, 1);
    assert!(!expected_subdir.exists());
}

#[test]
fn versioned_clear_uses_canonical_full_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let generated_dir = tmp.path().join("generated");
    let stored = SourceIdentity::parse("FILE:///C:/data/example.zarr").unwrap();
    let equivalent = SourceIdentity::parse("c:\\data\\example.zarr").unwrap();
    assert_eq!(stored, equivalent);

    let generated_identity = generated_dir.join(stored.digest_hex());
    fs::create_dir_all(generated_identity.join("revision-b")).unwrap();
    fs::write(
        generated_identity.join("revision-b/chunk.bin"),
        b"generated",
    )
    .unwrap();

    let outcome = clear_derived_cache(&generated_dir, Some(&equivalent)).unwrap();
    assert_eq!(outcome.datasets, 1);
    assert_eq!(outcome.files, 1);
    assert!(!generated_identity.exists());
}

#[test]
fn upgrade_clear_removes_genuinely_separate_active_and_legacy_roots() {
    let tmp = tempfile::tempdir().unwrap();
    let active = tmp.path().join("generated-coarse");
    let legacy = tmp.path().join("proxy-cache");
    let sqlite = tmp.path().join("lucida.db");
    fs::write(&sqlite, b"authoritative").unwrap();

    let active_dataset = populate_dataset(&active, URL_A, &[("active", "tile3d")]);
    let legacy_dataset = legacy.join(hex16(&dataset_url_hash16(URL_A)));
    fs::create_dir_all(legacy_dataset.join("legacy/tile3d")).unwrap();
    fs::write(legacy_dataset.join("legacy/tile3d/chunk.bin"), b"legacy").unwrap();

    let roots = DerivedCacheRoots::new(active.clone(), legacy.clone());
    let outcome = clear_derived_cache_roots(&roots, None).unwrap();
    assert_eq!(outcome.datasets, 2);
    assert_eq!(outcome.files, 3);
    assert!(!active_dataset.exists());
    assert!(!legacy_dataset.exists());
    assert_eq!(fs::read(sqlite).unwrap(), b"authoritative");
    assert!(active.exists());
    assert!(legacy.exists());
}

#[test]
fn upgrade_clear_rejects_overlapping_roots_before_mutation() {
    let tmp = tempfile::tempdir().unwrap();
    let active = tmp.path().join("cache");
    let legacy = active.join("legacy");
    let active_dataset = populate_dataset(&active, URL_A, &[("active", "tile3d")]);
    fs::create_dir_all(&legacy).unwrap();

    let roots = DerivedCacheRoots::new(active, legacy);
    let error = clear_derived_cache_roots(&roots, None).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert!(active_dataset.exists(), "validation must precede deletion");
}

#[cfg(unix)]
#[test]
fn targeted_clear_unlinks_cache_symlink_without_following_it() {
    use std::os::unix::fs::symlink;

    let tmp = tempfile::tempdir().unwrap();
    let active = tmp.path().join("generated-coarse");
    fs::create_dir_all(&active).unwrap();
    let outside = tmp.path().join("authoritative");
    fs::create_dir_all(&outside).unwrap();
    let sentinel = outside.join("lucida.db");
    fs::write(&sentinel, b"authoritative").unwrap();
    let identity = SourceIdentity::parse(URL_A).unwrap();
    let cache_link = active.join(identity.digest_hex());
    symlink(&outside, &cache_link).unwrap();

    let outcome = clear_derived_cache(&active, Some(&identity)).unwrap();
    assert_eq!(outcome.datasets, 1);
    assert_eq!(outcome.files, 0);
    assert!(!cache_link.exists());
    assert_eq!(fs::read(sentinel).unwrap(), b"authoritative");
}
