//! Stable, content-derived DatasetId behavior.
//!
//! The DatasetId for a given URL must be stable across server restarts
//! and across multiple `OpenRemoteDataset` commands, and a second open
//! of the same URL must reuse the existing `ServerBinding` rather than
//! re-importing.
//!
//! These are integration tests against the public surface of
//! `lucida_server`. They cover:
//!
//!   1. Stability: two computations of the ID for URL `X` agree, even
//!      across freshly-constructed `Session`s (the server-restart proxy).
//!   2. Distinctness: distinct URLs yield distinct IDs.
//!   3. Reuse: when a `ServerBinding` for URL `X` is already present, a
//!      lookup at `dataset_id_for_url("X")` finds it (i.e. the second
//!      open would short-circuit and reuse the cached state, rather than
//!      re-importing). We assert on observable binding state
//!      (`source_url`, `dataset_opened`, and the `Arc<CachedStore>`
//!      pointer identity) to confirm the same binding is reused.
//!
//! Running an actual end-to-end `handle_open_remote_dataset` requires a
//! WebSocket client and a populated Zarr store, so we instead exercise
//! the underlying invariants the handler relies on: a pure ID function
//! and `Session::server_bindings.contains_key` keyed by that ID.

use std::sync::Arc;

use lucida_content::url::{
    SourceIdentity, SourceRevision, SourceVersion, dataset_id_for_url, normalize_dataset_url,
};
use lucida_content::{
    Axis, AxisKind, DataType, DatasetId, DatasetKind, DatasetManifest, Entity, EntityId,
    EntityKind, EntityLabels, ImageSpec, LevelGeometry, MultiscaleInfo,
};
use lucida_protocol::{
    DatasetOpened, FetchSource, ProxiedFetchDescriptor, ProxiedImageSpec, WireFormat,
};
use lucida_server::binding::{ChunkResolver, ServerBinding};
use lucida_server::generated_coarse::DerivedChunkCache;
use lucida_server::session::Session;
use lucida_store::cache::CachedStore;
use lucida_store::import_types::ServerBindingSeed;
use object_store::ObjectStore;
use object_store::memory::InMemory;

const URL_X: &str = "gs://lucida-test/datasets/dataset-x.zarr";
const URL_Y: &str = "gs://lucida-test/datasets/dataset-y.zarr";

#[test]
fn id_is_stable_across_repeat_invocations() {
    let a = dataset_id_for_url(URL_X);
    let b = dataset_id_for_url(URL_X);
    assert_eq!(a, b, "ID must be deterministic in URL");
    assert!(a.starts_with("ds-"), "ID should use 'ds-' prefix; got {a}");
    assert_eq!(a.len(), "ds-".len() + 64, "ID should be ds- + 64 hex chars");
}

#[test]
fn id_is_stable_across_windows_spelling_variants() {
    // ADR-0042: a single Windows file has many legal spellings
    // (`C:\foo`, `c:/foo`, `file:///C:/foo`). The server normalizes
    // every incoming URL via `normalize_dataset_url` before deriving
    // the `DatasetId`, so all spellings dedup to the same id — which
    // is what makes the `handle_open_remote_dataset` short-circuit
    // re-bind the existing dataset on second open instead of
    // re-importing the (multi-GB) backing store.
    //
    // This test mirrors the handler's normalize-then-hash pipeline at
    // the same boundary the handler does (after the URL is in hand,
    // before `dataset_id_for_url`). Each group is a set of equivalent
    // spellings; every spelling in the group must produce the same id.
    let groups: Vec<Vec<&str>> = vec![
        vec![
            "C:\\foo",
            "c:/foo",
            "C:/foo",
            "file:///C:/foo",
            "file://C:\\foo",
        ],
        vec!["\\\\server\\share\\foo", "//server/share/foo"],
    ];
    for group in groups {
        let ids: Vec<String> = group
            .iter()
            .map(|s| dataset_id_for_url(&normalize_dataset_url(s)))
            .collect();
        let first = &ids[0];
        for (i, id) in ids.iter().enumerate().skip(1) {
            assert_eq!(
                id, first,
                "spelling {:?} produced id {id}, expected {first} (same as {:?})",
                group[i], group[0]
            );
        }
    }
}

#[test]
fn second_open_reuses_binding_across_windows_spelling_variants() {
    // Operational property: after URL X is opened in one spelling
    // (`C:\foo`), an open of an equivalent spelling (`c:/foo`,
    // `file:///C:/foo`) must resolve to the same `DatasetId` and find
    // the existing binding — the handler's dedup short-circuit.
    let mut session = Session::new();

    let canonical = normalize_dataset_url("C:\\data\\foo.zarr");
    let dataset_id = DatasetId(dataset_id_for_url(&canonical));
    let cache = Arc::new(CachedStore::new(in_memory_store(), 1024));
    let register = sample_register(&dataset_id);
    let binding = make_binding(&canonical, &register, in_memory_store(), cache.clone());
    session.server_bindings.insert(dataset_id.clone(), binding);

    for variant in [
        "c:/data/foo.zarr",
        "C:/data/foo.zarr",
        "file:///C:/data/foo.zarr",
        "file://C:\\data\\foo.zarr",
    ] {
        let canonical_variant = normalize_dataset_url(variant);
        let recomputed = DatasetId(dataset_id_for_url(&canonical_variant));
        assert_eq!(
            recomputed, dataset_id,
            "variant {variant:?} (canonical {canonical_variant:?}) must produce \
             the same id as canonical {canonical:?}"
        );
        let recovered = session
            .server_bindings
            .get(&recomputed)
            .unwrap_or_else(|| panic!("variant {variant:?} should find existing binding"));
        assert_eq!(recovered.source.identity.locator.as_str(), canonical);
        assert!(
            Arc::ptr_eq(&recovered.cache, &cache),
            "variant {variant:?} must reuse the same CachedStore Arc"
        );
    }
}

#[test]
fn id_is_stable_across_fresh_sessions() {
    // The "server restart" proxy: a freshly constructed Session must see
    // the same ID for URL X as a prior session would have computed.
    let _session_a = Session::new();
    let id_from_a = dataset_id_for_url(URL_X);

    let _session_b = Session::new();
    let id_from_b = dataset_id_for_url(URL_X);

    assert_eq!(id_from_a, id_from_b);
}

#[test]
fn distinct_urls_yield_distinct_ids() {
    let id_x = dataset_id_for_url(URL_X);
    let id_y = dataset_id_for_url(URL_Y);
    assert_ne!(id_x, id_y, "different URLs must produce different IDs");
}

#[test]
fn id_unaffected_by_wall_clock() {
    // Sanity: a tight loop produces the same ID. (The previous
    // implementation mixed `SystemTime::now().as_nanos()` into the hash,
    // so two opens microseconds apart produced different IDs.)
    let mut ids = Vec::with_capacity(32);
    for _ in 0..32 {
        ids.push(dataset_id_for_url(URL_X));
    }
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    assert_eq!(
        unique.len(),
        1,
        "ID must not depend on wall clock, got {unique:?}"
    );
}

#[test]
fn second_open_reuses_existing_binding() {
    // Simulates the body of `handle_open_remote_dataset`'s reuse
    // shortcut: after URL X has been opened once and a binding is
    // registered, a second open for URL X resolves to the same key and
    // finds the same binding — *without* constructing a new one.
    let mut session = Session::new();

    // First open: install a binding under the stable ID for URL X.
    let dataset_id = DatasetId(dataset_id_for_url(URL_X));
    let original_cache = Arc::new(CachedStore::new(in_memory_store(), 1024));
    let original_register = sample_register(&dataset_id);
    let original_binding = make_binding(
        URL_X,
        &original_register,
        in_memory_store(),
        original_cache.clone(),
    );
    session
        .server_bindings
        .insert(dataset_id.clone(), original_binding);

    // Second open: recompute the ID and look it up. The lookup must
    // succeed (so the handler short-circuits and skips re-import) and
    // the recovered binding must be the same one we installed —
    // observable via `source_url`, the preserved `dataset_opened`,
    // and Arc-identity on the CachedStore (which would be a fresh
    // allocation if a re-import occurred).
    let recomputed = DatasetId(dataset_id_for_url(URL_X));
    assert_eq!(recomputed, dataset_id, "ID must be stable for URL X");

    let recovered = session
        .server_bindings
        .get(&recomputed)
        .expect("second open must find the existing binding");

    assert_eq!(recovered.source.identity.locator.as_str(), URL_X);
    assert_eq!(
        recovered.dataset_opened.manifest.dataset_id, original_register.manifest.dataset_id,
        "dataset_opened (replayed to the second-opening client) must be preserved"
    );
    assert!(
        Arc::ptr_eq(&recovered.cache, &original_cache),
        "cache must be the same Arc — if it were re-allocated, in-flight \
         reads from the first open would not benefit the second"
    );
}

#[test]
fn third_open_of_distinct_url_does_not_collide() {
    // After installing a binding for URL X, looking up the ID for URL Y
    // must miss — so the handler proceeds with a fresh import for Y.
    let mut session = Session::new();
    let id_x = DatasetId(dataset_id_for_url(URL_X));
    let id_y = DatasetId(dataset_id_for_url(URL_Y));

    let cache = Arc::new(CachedStore::new(in_memory_store(), 1024));
    let register = sample_register(&id_x);
    session.server_bindings.insert(
        id_x.clone(),
        make_binding(URL_X, &register, in_memory_store(), cache),
    );

    assert!(session.server_bindings.contains_key(&id_x));
    assert!(
        !session.server_bindings.contains_key(&id_y),
        "URL Y must not collide with URL X's binding"
    );
}

fn in_memory_store() -> Arc<dyn ObjectStore> {
    Arc::new(InMemory::new())
}

/// Build a `ServerBinding` with inert generated-coarse infrastructure.
fn make_binding(
    url: &str,
    register: &DatasetOpened,
    store: Arc<dyn ObjectStore>,
    cache: Arc<CachedStore>,
) -> ServerBinding {
    let resolver = Arc::new(ChunkResolver::new(&ServerBindingSeed { images: vec![] }));
    let derived_chunks = Arc::new(DerivedChunkCache::default());
    ServerBinding {
        source: SourceVersion::new(
            SourceIdentity::parse(url).unwrap(),
            SourceRevision::from_bytes(b"stable-id-test"),
        ),
        store,
        resolver,
        cache,
        dataset_opened: register.clone(),
        derived_chunks: derived_chunks.clone(),
        generated_service: Arc::new(
            lucida_server::generated_coarse::GeneratedCoarseService::inert(derived_chunks),
        ),
        import_warnings: Vec::new(),
    }
}

fn sample_register(dataset_id: &DatasetId) -> DatasetOpened {
    let entity_id = EntityId(format!("{}-entity", dataset_id.0));
    let image_id = lucida_content::ImageId(format!("{}-image", dataset_id.0));
    let manifest = DatasetManifest::new(
        dataset_id.clone(),
        format!("test:{}", dataset_id.0),
        DatasetKind::Single,
        vec![Entity {
            id: entity_id.clone(),
            kind: EntityKind::Image,
            parent: None,
            labels: EntityLabels {
                name: Some(dataset_id.0.clone()),
                ..Default::default()
            },
        }],
        vec![],
        vec![ImageSpec {
            image_id: image_id.clone(),
            owner: entity_id,
            multiscale: MultiscaleInfo {
                axes: vec![
                    Axis {
                        name: "z".into(),
                        kind: AxisKind::Space,
                    },
                    Axis {
                        name: "y".into(),
                        kind: AxisKind::Space,
                    },
                    Axis {
                        name: "x".into(),
                        kind: AxisKind::Space,
                    },
                ],
                levels: vec![LevelGeometry {
                    level_index: 0,
                    shape: [1, 1, 8, 64, 64],
                    chunk_shape: [1, 1, 1, 32, 32],
                    grid_shape: [1, 1, 8, 2, 2],
                    scale: [1.0, 1.0, 1.0, 1.0, 1.0],
                }],
                coarse_level_index: None,
                generated_levels: vec![],
                data_type: DataType::Uint16,
                pinned_axes: vec![],
                channel_infos: vec![],
            },
        }],
        vec![],
        None,
    );
    let fetch = FetchSource::Proxied(ProxiedFetchDescriptor {
        images: vec![ProxiedImageSpec {
            image_id,
            wire_format: WireFormat::Raw {
                data_type: DataType::Uint16,
            },
        }],
    });
    DatasetOpened {
        manifest,
        fetch,
        opener_client_id: None,
    }
}
