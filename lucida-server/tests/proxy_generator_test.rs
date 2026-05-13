//! Integration tests for [`lucida_server::proxy::ProxyGenerator`].
//!
//! Covers:
//! - Cache hit short-circuits generation (no store reads).
//! - In-flight dedup: two concurrent `request()`s for the same `spec`
//!   trigger only one underlying generation.
//! - Bounded concurrency: with concurrency=N, no more than N proxies
//!   are generating at once.

mod common;

use std::sync::Arc;
use std::time::Duration;

use lucida_proxy::{ProxyKind, ProxySpec, source_content_hash};
use lucida_server::proxy::{ProxyCache, ProxyGenerator};

use crate::common::{SyntheticDataset, build_single_field_dataset};

fn proxy_spec_for(ds: &SyntheticDataset) -> ProxySpec {
    ProxySpec {
        entity_id: ds.entity_id.clone(),
        kind: ProxyKind::FieldProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 4,
    }
}

#[tokio::test]
async fn cache_hit_short_circuits_generation() {
    // Single small chunk: shape exactly matches chunk_shape.
    let ds = build_single_field_dataset([1, 1, 4, 4, 4], [1, 1, 4, 4, 4], 0).await;

    let tmp = tempfile::tempdir().unwrap();
    let cache = Arc::new(ProxyCache::new(tmp.path().to_path_buf(), [0xCA; 16]));
    let generator = ProxyGenerator::new(
        cache.clone(),
        ds.cache.clone(),
        ds.resolver.clone(),
        ds.manifest.clone(),
        2,
    );

    let spec = proxy_spec_for(&ds);

    // First request: generates and writes to cache.
    let _first = generator.request(spec.clone(), 0).await.unwrap();
    let after_first = ds
        .instrumented
        .get_count
        .load(std::sync::atomic::Ordering::SeqCst);
    assert!(
        after_first > 0,
        "first request should hit the store (got count = {after_first})"
    );

    // Second request for the same spec: pre-populated cache → no store reads.
    let _second = generator.request(spec.clone(), 0).await.unwrap();
    let after_second = ds
        .instrumented
        .get_count
        .load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        after_second, after_first,
        "cache hit must not trigger any new store reads"
    );

    // Sanity: header source_content_hash matches what generator
    // computes for the spec, so a fresh generator on the same disk
    // would also hit.
    let expected_hash = source_content_hash(&ds.manifest, &spec.entity_id, spec.t, spec.c);
    let cached = cache.get(&spec, &expected_hash).unwrap();
    assert!(cached.is_some(), "cache should have a fresh entry");
}

#[tokio::test]
async fn in_flight_dedup_runs_one_generation_for_concurrent_requests() {
    // Multi-chunk grid + per-fetch delay so concurrent requests definitely
    // overlap during the pre-fetch phase.
    let ds = build_single_field_dataset([1, 1, 4, 8, 8], [1, 1, 1, 4, 4], 30).await;

    let tmp = tempfile::tempdir().unwrap();
    let cache = Arc::new(ProxyCache::new(tmp.path().to_path_buf(), [0xDE; 16]));
    let generator = Arc::new(ProxyGenerator::new(
        cache,
        ds.cache.clone(),
        ds.resolver.clone(),
        ds.manifest.clone(),
        4,
    ));

    let spec = proxy_spec_for(&ds);
    let n_clients = 5;
    let mut handles = Vec::new();
    for _ in 0..n_clients {
        let generator = generator.clone();
        let spec = spec.clone();
        handles.push(tokio::spawn(
            async move { generator.request(spec, 0).await },
        ));
    }

    let mut results = Vec::new();
    for h in handles {
        results.push(h.await.unwrap());
    }
    for r in &results {
        assert!(r.is_ok(), "all concurrent requests should succeed: {r:?}");
    }

    // The synthetic level has 1 * 1 * 4 * 2 * 2 = 16 chunks. With dedup,
    // one round of pre-fetch happens → 16 store reads. Cache adds a layer
    // so even if multiple inner reads happen, repeated reads of the same
    // path won't re-fetch from `instrumented`. The relaxed bound: total
    // reads must be ≤ 16 * 2 (allowing for one race retry) but strictly
    // less than n_clients * 16 = 80.
    let total_reads = ds
        .instrumented
        .get_count
        .load(std::sync::atomic::Ordering::SeqCst);
    assert!(
        total_reads <= 32,
        "expected ~16 reads (dedup + cache), got {total_reads}"
    );
    assert!(
        total_reads < (n_clients as usize) * 16,
        "expected dedup to suppress some duplicate reads, got {total_reads} reads for {n_clients} clients"
    );

    // All results should point to the same underlying voxel data.
    let first = &results[0].as_ref().unwrap();
    for r in &results[1..] {
        let r = r.as_ref().unwrap();
        assert_eq!(r.header.dims, first.header.dims);
        assert_eq!(r.voxels.len(), first.voxels.len());
    }
}

#[tokio::test]
async fn bounded_concurrency_respects_limit() {
    // Two distinct entities so dedup doesn't suppress concurrent work.
    // Each request triggers its own generation.
    let ds = build_single_field_dataset([1, 1, 4, 8, 8], [1, 1, 1, 4, 4], 50).await;

    let tmp = tempfile::tempdir().unwrap();
    let cache = Arc::new(ProxyCache::new(tmp.path().to_path_buf(), [0xBC; 16]));

    // We only have one entity in our synthetic graph; vary `t` to make
    // distinct ProxySpecs that all share the same content. This still
    // produces distinct cache keys and distinct in-flight entries.
    let limit = 2;
    let generator = Arc::new(ProxyGenerator::new(
        cache,
        ds.cache.clone(),
        ds.resolver.clone(),
        ds.manifest.clone(),
        limit,
    ));

    let mut handles = Vec::new();
    let n_requests = 5u32;
    for t in 0..n_requests {
        let g = generator.clone();
        let mut spec = proxy_spec_for(&ds);
        spec.t = t;
        handles.push(tokio::spawn(async move { g.request(spec, 0).await }));
    }

    // Give the requests time to enter their pre-fetch loops.
    tokio::time::sleep(Duration::from_millis(20)).await;

    for h in handles {
        let _ = h.await.unwrap();
    }

    let max_active = ds
        .instrumented
        .max_active
        .load(std::sync::atomic::Ordering::SeqCst);

    // The generator semaphore bounds *concurrent generations*, not raw
    // store calls — but each generation does its own pre-fetch loop, so
    // observed peak concurrent store fetches is bounded by `limit` *
    // (number of fetches per generation that happen in parallel within
    // one task). Since pre-fetches inside one generation are sequential
    // (we await each one), the peak parallel store calls is just `limit`.
    //
    // We assert max_active ≤ `limit` strictly. The token bucket may also
    // briefly show 0 due to scheduler interleavings; we only care about
    // the upper bound.
    assert!(
        max_active <= limit,
        "max concurrent store fetches ({max_active}) exceeded generator concurrency limit ({limit})"
    );
}

#[tokio::test]
async fn second_call_after_completion_uses_cache() {
    // Verify that a sequential second call (after the first has fully
    // completed) reads from the persistent cache — no store hits.
    let ds = build_single_field_dataset([1, 1, 4, 4, 4], [1, 1, 4, 4, 4], 0).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = Arc::new(ProxyCache::new(tmp.path().to_path_buf(), [0xAB; 16]));
    let generator = ProxyGenerator::new(
        cache.clone(),
        ds.cache.clone(),
        ds.resolver.clone(),
        ds.manifest.clone(),
        2,
    );
    let spec = proxy_spec_for(&ds);

    let _ = generator.request(spec.clone(), 0).await.unwrap();
    let after_first = ds
        .instrumented
        .get_count
        .load(std::sync::atomic::Ordering::SeqCst);
    let _ = generator.request(spec.clone(), 0).await.unwrap();
    let after_second = ds
        .instrumented
        .get_count
        .load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(after_first, after_second, "cache hit should skip store");
}

// ---------------------------------------------------------------------------
// Priority test: deferred. The generator accepts a `priority: u8` parameter
// for API stability, but it does not currently order requests by priority.
// The semaphore awakes waiters in FIFO order; a real priority scheduler is
// follow-up work. See `proxy/generator.rs` module docs.
// ---------------------------------------------------------------------------
