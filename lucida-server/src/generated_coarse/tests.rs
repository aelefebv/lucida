use super::*;
use lucida_content::{
    Axis, AxisKind, DataType, DatasetId, DatasetKind, Entity, EntityId, EntityKind, EntityLabels,
    GeneratedLevelInfo, GeneratedLevelProvenance, LevelGeometry, MultiscaleInfo,
};
use lucida_store::codec::StorageCompression;
use lucida_store::import_types::{ImageBindingSeed, LevelBindingInfo, ServerBindingSeed};
use lucida_store::layout::ChunkByteLayout;
use object_store::ObjectStoreExt;
use tokio::sync::broadcast;

use crate::outbox::{
    BroadcastItem, BroadcastKind, BroadcastReceiver, DEFAULT_BROADCAST_BYTES, broadcast_channel,
};

fn generated_broadcast_channel(capacity: usize) -> (BroadcastSender, BroadcastReceiver) {
    let sender = broadcast_channel(capacity, DEFAULT_BROADCAST_BYTES);
    let receiver = sender.subscribe();
    (sender, receiver)
}

fn generated_level() -> GeneratedLevelAvailability {
    GeneratedLevelAvailability {
        image_id: ImageId("img-1".into()),
        info: GeneratedLevelInfo {
            level_index: 1,
            role: GeneratedLevelRole::Coarse,
            provenance: GeneratedLevelProvenance::default(),
        },
        level: LevelGeometry {
            level_index: 1,
            shape: [1, 1, 1, 64, 64],
            chunk_shape: [1, 1, 1, 64, 64],
            grid_shape: [1, 1, 1, 1, 1],
            scale: [1.0, 1.0, 1.0, 4.0, 4.0],
        },
        summary: None,
    }
}

fn generated_status(
    key: impl Into<String>,
    status: GeneratedChunkStatus,
) -> GeneratedChunkStatusUpdate {
    GeneratedChunkStatusUpdate {
        image_id: ImageId("img-1".into()),
        level_index: 1,
        key: key.into(),
        status,
        failure: status.failure_descriptor(),
        message: None,
    }
}

fn read_generated_ready(handle: GeneratedChunkReadHandle) -> GeneratedReadyBytes {
    handle
        .read()
        .expect("generated ready payload read")
        .expect("generated ready payload remains current")
}

fn decode_generated_broadcast(item: BroadcastItem) -> (DatasetId, GeneratedAvailabilityDelta) {
    assert_eq!(item.kind(), BroadcastKind::GeneratedAvailabilityUpdate);
    let message: ServerMessage =
        serde_json::from_str(item.primary_json()).expect("valid server message");
    let ServerMessage::GeneratedAvailabilityUpdate { dataset_id, delta } = message else {
        panic!("expected generated-availability server message");
    };
    (dataset_id, delta)
}

#[tokio::test]
async fn completion_broadcaster_coalesces_and_deduplicates_before_flush() {
    let (tx, mut rx) = generated_broadcast_channel(16);
    let broadcasts = GeneratedDeltaBroadcaster::new(tx);
    let dataset_id = DatasetId("ds-1".into());

    for update in [
        generated_status("same", GeneratedChunkStatus::Pending),
        generated_status("same", GeneratedChunkStatus::Ready),
        generated_status("other", GeneratedChunkStatus::FailedTransient),
    ] {
        broadcasts
            .enqueue(
                dataset_id.clone(),
                GeneratedAvailabilityDelta {
                    levels: vec![],
                    chunks: vec![update],
                },
            )
            .await;
    }
    broadcasts.flush().await;

    let (broadcast_dataset, delta) =
        decode_generated_broadcast(rx.recv().await.expect("one broadcast"));
    assert_eq!(broadcast_dataset, dataset_id);
    assert_eq!(delta.chunks.len(), 2);
    assert_eq!(
        delta
            .chunks
            .iter()
            .find(|chunk| chunk.key == "same")
            .unwrap()
            .status,
        GeneratedChunkStatus::Ready,
    );
    assert!(matches!(
        rx.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn completion_broadcaster_flushes_by_hard_batch_size() {
    let (tx, mut rx) = generated_broadcast_channel(8);
    let broadcasts = GeneratedDeltaBroadcaster::new(tx);
    let updates = (0..600)
        .map(|index| generated_status(format!("key-{index}"), GeneratedChunkStatus::Ready))
        .collect();

    broadcasts
        .enqueue(
            DatasetId("ds-1".into()),
            GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: updates,
            },
        )
        .await;
    broadcasts.flush().await;

    let mut frame_sizes = Vec::new();
    while let Ok(item) = rx.try_recv() {
        let (_, delta) = decode_generated_broadcast(item);
        frame_sizes.push(delta.levels.len() + delta.chunks.len());
    }
    assert_eq!(
        frame_sizes,
        vec![GENERATED_DELTA_BATCH_SIZE, GENERATED_DELTA_BATCH_SIZE, 88]
    );
    assert!(
        frame_sizes
            .iter()
            .all(|size| *size <= GENERATED_DELTA_BATCH_SIZE)
    );
}

#[tokio::test]
async fn completion_broadcaster_flushes_without_more_completions_after_time_bound() {
    let (tx, mut rx) = generated_broadcast_channel(4);
    let broadcasts = GeneratedDeltaBroadcaster::new(tx);
    broadcasts
        .enqueue(
            DatasetId("ds-1".into()),
            GeneratedAvailabilityDelta {
                levels: vec![],
                chunks: vec![generated_status("one", GeneratedChunkStatus::Ready)],
            },
        )
        .await;

    let item = tokio::time::timeout(GENERATED_DELTA_FLUSH_INTERVAL * 10, rx.recv())
        .await
        .expect("time-bounded flush")
        .expect("broadcast channel open");
    let (_, delta) = decode_generated_broadcast(item);
    assert_eq!(delta.chunks.len(), 1);
}

fn source_manifest() -> DatasetManifest {
    source_manifest_with_levels(
        vec![LevelGeometry {
            level_index: 0,
            shape: [1, 1, 1, 256, 256],
            chunk_shape: [1, 1, 1, 128, 128],
            grid_shape: [1, 1, 1, 2, 2],
            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
        }],
        None,
        DataType::Uint16,
    )
}

fn source_manifest_with_levels(
    levels: Vec<LevelGeometry>,
    coarse_level_index: Option<u32>,
    data_type: DataType,
) -> DatasetManifest {
    let entity_id = EntityId("entity-1".into());
    DatasetManifest::new(
        DatasetId("ds-1".into()),
        "test".into(),
        DatasetKind::Single,
        vec![Entity {
            id: entity_id.clone(),
            kind: EntityKind::Image,
            parent: None,
            labels: EntityLabels::default(),
        }],
        vec![],
        vec![lucida_content::ImageSpec {
            image_id: ImageId("img-1".into()),
            owner: entity_id,
            multiscale: MultiscaleInfo {
                axes: vec![
                    Axis {
                        name: "t".into(),
                        kind: AxisKind::Time,
                    },
                    Axis {
                        name: "c".into(),
                        kind: AxisKind::Channel,
                    },
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
                levels,
                coarse_level_index,
                generated_levels: vec![],
                data_type,
                pinned_axes: vec![],
                channel_infos: vec![],
            },
        }],
        vec![],
        None,
    )
}

fn level(level_index: u32, shape: [u64; 5], chunk_shape: [u64; 5]) -> LevelGeometry {
    LevelGeometry {
        level_index,
        shape,
        chunk_shape,
        grid_shape: grid_shape(shape, chunk_shape),
        scale: [1.0, 1.0, 1.0, 1.0, 1.0],
    }
}

fn binding_seed_for(levels: &[LevelGeometry]) -> ServerBindingSeed {
    binding_seed_for_data_type(levels, DataType::Uint16)
}

fn binding_seed_for_data_type(levels: &[LevelGeometry], data_type: DataType) -> ServerBindingSeed {
    ServerBindingSeed {
        images: vec![ImageBindingSeed {
            image_id: ImageId("img-1".into()),
            axes_names: vec!["t".into(), "c".into(), "z".into(), "y".into(), "x".into()],
            store_prefix: None,
            levels: levels
                .iter()
                .map(|level| {
                    let canonical_byte_size = checked_product(&[
                        level.chunk_shape[2],
                        level.chunk_shape[3],
                        level.chunk_shape[4],
                        data_type_size(data_type),
                    ])
                    .unwrap() as usize;
                    LevelBindingInfo {
                        level_index: level.level_index,
                        compression: StorageCompression::None,
                        chunk_shape: level.chunk_shape.to_vec(),
                        shape: level.shape,
                        grid_shape: level.grid_shape,
                        chunk_byte_layout: ChunkByteLayout {
                            canonical_byte_size,
                            on_disk_byte_size: canonical_byte_size,
                            byte_stride_t: 0,
                            byte_stride_c: 0,
                            chunk_size_t: 1,
                            chunk_size_c: 1,
                        },
                    }
                })
                .collect(),
        }],
    }
}

fn service_for_plan(
    manifest: DatasetManifest,
    plan: GeneratedCoarsePlan,
    config: GeneratedSchedulingConfig,
) -> GeneratedCoarseService {
    let cache = Arc::new(DerivedChunkCache::default());
    cache.upsert_level(plan.availability.clone());
    service_for_plan_with_cache(manifest, plan, config, cache)
}

fn service_for_plan_with_cache(
    manifest: DatasetManifest,
    plan: GeneratedCoarsePlan,
    config: GeneratedSchedulingConfig,
    cache: Arc<DerivedChunkCache>,
) -> GeneratedCoarseService {
    let store =
        Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let cached = Arc::new(CachedStore::new(store, 1024 * 1024));
    let image = &manifest.images()[0];
    let resolver = Arc::new(ChunkResolver::new(&binding_seed_for_data_type(
        &image.multiscale.levels,
        image.multiscale.data_type,
    )));
    let (tx, _rx) = generated_broadcast_channel(16);
    GeneratedCoarseService::new(
        vec![plan],
        Arc::new(manifest),
        cached,
        resolver,
        cache,
        Arc::new(AsyncMutex::new(Session::new())),
        tx,
        config,
    )
}

fn interest(
    dataset_id: DatasetId,
    image_id: ImageId,
    key: &str,
    lane: ViewerInterestLane,
    timestamp_ms: u64,
) -> ViewerInterestHint {
    ViewerInterestHint {
        client_id: None,
        dataset_id,
        generation: 1,
        t: 0,
        z: 0,
        channels: vec![0],
        mode: lucida_core::protocol::ViewerInterestMode::Slice,
        viewport: None,
        desired_keys: vec![ViewerInterestChunkKey {
            image_id,
            key: key.into(),
            lane,
        }],
        predicted_keys: vec![],
        interaction: lucida_core::protocol::ViewerInteractionMode::Idle,
        timestamp_ms,
        ttl_ms: 10_000,
    }
}

#[test]
fn generated_level_without_chunk_status_is_pending() {
    let cache = DerivedChunkCache::default();
    cache.upsert_level(generated_level());

    match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
        DerivedChunkLookup::Status { status, .. } => {
            assert_eq!(status, GeneratedChunkStatus::Pending);
        }
        DerivedChunkLookup::Ready(_) => panic!("expected pending"),
    }
}

#[test]
fn seeded_ready_chunk_returns_bytes() {
    let cache = DerivedChunkCache::default();
    cache.upsert_level(generated_level());
    cache.seed_ready_chunk(
        ImageId("img-1".into()),
        1,
        "1/0/0/0/0/0".into(),
        vec![1, 2, 3, 4],
    );

    match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
        DerivedChunkLookup::Ready(ready) => {
            assert_eq!(read_generated_ready(ready), vec![1, 2, 3, 4])
        }
        DerivedChunkLookup::Status { status, .. } => {
            panic!("expected ready, got {status:?}");
        }
    }
}

#[test]
fn generated_coarse_planner_skips_images_with_source_coarse() {
    let manifest = source_manifest_with_levels(
        vec![
            level(0, [1, 1, 1, 4096, 4096], [1, 1, 1, 512, 512]),
            level(1, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256]),
        ],
        Some(1),
        DataType::Uint16,
    );

    let plans = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default());

    assert!(plans.is_empty());
}

#[test]
fn generated_coarse_planner_uses_nearest_finer_input_and_bounded_chunks() {
    let manifest = source_manifest_with_levels(
        vec![
            level(0, [1, 1, 1, 4096, 4096], [1, 1, 1, 512, 512]),
            level(1, [1, 1, 1, 1024, 1024], [1, 1, 1, 512, 512]),
            level(2, [1, 1, 1, 256, 256], [1, 1, 1, 256, 256]),
        ],
        None,
        DataType::Uint16,
    );
    let config = GeneratedCoarseConfig {
        target_long_axis: 512,
        chunk_long_axis: 512,
        max_chunk_bytes: 128,
    };

    let plans = plan_generated_coarse_for_manifest(&manifest, config);

    assert_eq!(plans.len(), 1);
    let plan = &plans[0];
    assert_eq!(plan.input_level_candidates, vec![1, 0]);
    assert_eq!(plan.availability.level.shape, [1, 1, 1, 512, 512]);
    let chunk = plan.availability.level.chunk_shape;
    assert!(
        checked_product(&[
            chunk[2],
            chunk[3],
            chunk[4],
            data_type_size(DataType::Uint16)
        ])
        .is_some_and(|bytes| bytes <= 128)
    );
    assert_eq!(
        plan.availability.info.provenance.generator,
        GENERATED_COARSE_GENERATOR_VERSION
    );
    assert_eq!(
        plan.availability.info.provenance.source_content_id,
        Some(plan.source_content_id.clone())
    );
}

#[test]
fn generated_coarse_planner_downsamples_z_and_aligns_chunks_to_source_footprint() {
    let manifest = source_manifest_with_levels(
        vec![level(0, [1, 1, 2480, 8058, 7718], [1, 1, 32, 1024, 1024])],
        None,
        DataType::Float32,
    );

    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");

    assert_eq!(plan.availability.level.shape, [1, 1, 158, 512, 490]);
    assert_eq!(plan.availability.level.chunk_shape, [1, 1, 3, 66, 66]);
    assert_eq!(plan.availability.level.grid_shape, [1, 1, 53, 8, 8]);
}

#[test]
fn generated_chunk_job_key_carries_identity_scope() {
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");

    let key = plan.job_key(2, 3, "1/2/3/0/0/0".into());

    assert_eq!(key.source_content_id, plan.source_content_id);
    assert_eq!(key.generated_level_id, plan.generated_level_id);
    assert_eq!(key.image_id, ImageId("img-1".into()));
    assert_eq!(key.t, 2);
    assert_eq!(key.c, 3);
    assert_eq!(key.chunk_key, "1/2/3/0/0/0");
    assert_eq!(key.config_id, plan.config.config_id());
}

#[test]
fn max_downsample_preserves_sparse_source_pixels() {
    let input: Vec<u16> = (0..16).collect();

    let output = downsample_u16_max(&input, [1, 4, 4], [1, 2, 2]).unwrap();

    assert_eq!(output, vec![5, 7, 13, 15]);
}

#[test]
fn generated_chunk_encoding_pads_edge_chunks_to_nominal_shape() {
    let level = LevelGeometry {
        level_index: 1,
        shape: [1, 1, 1, 3, 3],
        chunk_shape: [1, 1, 1, 2, 2],
        grid_shape: [1, 1, 1, 2, 2],
        scale: [1.0; 5],
    };
    let output: Vec<u16> = (1..=9).collect();

    let bytes = encode_generated_chunk_bytes(&output, &level, 0, 1, 1, DataType::Uint16);
    let values: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();

    assert_eq!(values, vec![9, 0, 0, 0]);
}

#[test]
fn generated_chunk_encoding_preserves_float32_wire_format() {
    let level = LevelGeometry {
        level_index: 1,
        shape: [1, 1, 1, 2, 2],
        chunk_shape: [1, 1, 1, 2, 2],
        grid_shape: [1, 1, 1, 1, 1],
        scale: [1.0; 5],
    };
    let output = vec![0, 32768, 65535, 16384];

    let bytes = encode_generated_chunk_bytes(&output, &level, 0, 0, 0, DataType::Float32);
    let values: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();

    assert_eq!(bytes.len(), 16);
    assert_eq!(values[0], 0.0);
    assert!((values[1] - 0.5).abs() < 0.00002);
    assert_eq!(values[2], 1.0);
    assert!((values[3] - 0.25).abs() < 0.00002);
}

#[test]
fn disk_cache_without_an_override_uses_the_effective_default_budget() {
    let dir = tempfile::tempdir().unwrap();
    let cache =
        DerivedChunkCache::new_on_disk_with_budget(dir.path().to_path_buf(), [0x5a; 16], None);
    assert_eq!(
        cache.telemetry().budget_bytes,
        Some(crate::DEFAULT_GENERATED_DISK_BUDGET_BYTES)
    );
}

#[tokio::test]
async fn filesystem_entry_budget_evicts_tiny_status_scopes_before_byte_exhaustion() {
    let dir = tempfile::tempdir().unwrap();
    let plan =
        plan_generated_coarse_for_manifest(&source_manifest(), GeneratedCoarseConfig::default())
            .pop()
            .expect("plan");
    let key = plan.chunk_keys_for_tc(0, 0).next().unwrap();
    let cache_a = DerivedChunkCache::new_on_disk_with_entry_budget_for_test(
        dir.path().to_path_buf(),
        [0xa1; 16],
        1024 * 1024 * 1024,
        7,
    );
    cache_a.register_generated_plan(&plan).unwrap();
    cache_a.set_chunk_status(
        plan.image_id.clone(),
        plan.level_index,
        key.clone(),
        GeneratedChunkStatus::FailedTransient,
        Some("tiny status a".into()),
    );
    cache_a
        .disk
        .as_ref()
        .unwrap()
        .maintenance_barrier(Duration::from_secs(1))
        .await
        .unwrap();
    let scope_a = cache_a
        .disk
        .as_ref()
        .unwrap()
        .index_path(&plan.cache_identity)
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    assert!(scope_a.exists());

    let cache_b = DerivedChunkCache::new_on_disk_with_entry_budget_for_test(
        dir.path().to_path_buf(),
        [0xb2; 16],
        1024 * 1024 * 1024,
        7,
    );
    cache_b.register_generated_plan(&plan).unwrap();
    cache_b.set_chunk_status(
        plan.image_id.clone(),
        plan.level_index,
        key,
        GeneratedChunkStatus::FailedTransient,
        Some("tiny status b".into()),
    );
    cache_b
        .disk
        .as_ref()
        .unwrap()
        .maintenance_barrier(Duration::from_secs(1))
        .await
        .unwrap();

    let telemetry = cache_b.telemetry();
    assert_eq!(telemetry.entry_budget, Some(7));
    assert!(telemetry.entries <= 7);
    assert!(telemetry.bytes < 1024 * 1024);
    assert!(telemetry.evictions > 0);
    assert!(
        !scope_a.exists(),
        "the oldest tiny-file scope must be evicted"
    );
    assert_eq!(
        (telemetry.bytes, telemetry.entries),
        disk_resource_usage_for_test(dir.path()).unwrap()
    );
}

#[tokio::test]
async fn rewriting_incremental_status_does_not_inflate_entry_accounting() {
    let dir = tempfile::tempdir().unwrap();
    let plan =
        plan_generated_coarse_for_manifest(&source_manifest(), GeneratedCoarseConfig::default())
            .pop()
            .expect("plan");
    let key = plan.chunk_keys_for_tc(0, 0).next().unwrap();
    let cache = DerivedChunkCache::new_on_disk_with_entry_budget_for_test(
        dir.path().to_path_buf(),
        [0xc3; 16],
        1024 * 1024 * 1024,
        100,
    );
    cache.register_generated_plan(&plan).unwrap();
    for (status, message) in [
        (GeneratedChunkStatus::FailedTransient, "first"),
        (GeneratedChunkStatus::FailedPermanent, "replacement"),
    ] {
        cache.set_chunk_status(
            plan.image_id.clone(),
            plan.level_index,
            key.clone(),
            status,
            Some(message.into()),
        );
        cache
            .disk
            .as_ref()
            .unwrap()
            .maintenance_barrier(Duration::from_secs(1))
            .await
            .unwrap();
        if message == "first" {
            assert_eq!(cache.telemetry().entries, 5);
        }
    }
    let telemetry = cache.telemetry();
    assert_eq!(telemetry.entries, 5);
    assert_eq!(
        (telemetry.bytes, telemetry.entries),
        disk_resource_usage_for_test(dir.path()).unwrap()
    );
}

#[tokio::test]
async fn initialization_reconciliation_and_write_path_share_resource_accounting() {
    let dir = tempfile::tempdir().unwrap();
    let plan =
        plan_generated_coarse_for_manifest(&source_manifest(), GeneratedCoarseConfig::default())
            .pop()
            .expect("plan");
    let cache = DerivedChunkCache::new_on_disk_with_entry_budget_for_test(
        dir.path().to_path_buf(),
        [0xd4; 16],
        1024 * 1024 * 1024,
        100,
    );
    cache.register_generated_plan(&plan).unwrap();
    let written = cache.telemetry();
    assert_eq!(
        (written.bytes, written.entries),
        disk_resource_usage_for_test(dir.path()).unwrap()
    );

    let initialized = initialized_disk_telemetry_for_test(dir.path(), 1024 * 1024 * 1024, 100);
    assert_eq!(initialized.bytes, written.bytes);
    assert_eq!(initialized.entries, written.entries);

    fs::write(
        dir.path().join("operator-created-unscoped-file"),
        b"external",
    )
    .unwrap();
    cache.reconcile_disk_accounting().unwrap();
    let reconciled = cache.telemetry();
    assert_eq!(
        (reconciled.bytes, reconciled.entries),
        disk_resource_usage_for_test(dir.path()).unwrap()
    );
    assert_eq!(reconciled.entries, written.entries + 1);
}

#[test]
fn versioned_disk_cache_scopes_same_locator_revisions_separately() {
    let dir = tempfile::tempdir().unwrap();
    let identity = lucida_content::url::SourceIdentity::parse("gs://bucket/mutable.zarr").unwrap();
    let a = SourceVersion::new(identity.clone(), SourceRevision::from_bytes(b"a"));
    let b = SourceVersion::new(identity.clone(), SourceRevision::from_bytes(b"b"));
    let resident = SharedObjectCache::new(1024, 1024);
    let cache_a = DerivedChunkCache::new_on_disk_for_source(
        dir.path().to_path_buf(),
        &a,
        None,
        Arc::clone(&resident),
    );
    let cache_b =
        DerivedChunkCache::new_on_disk_for_source(dir.path().to_path_buf(), &b, None, resident);

    let root_a = cache_a.telemetry().root_dir.unwrap();
    let root_b = cache_b.telemetry().root_dir.unwrap();
    let canonical_root = fs::canonicalize(dir.path()).unwrap();
    assert_eq!(root_a, canonical_root);
    assert_eq!(root_b, canonical_root);
    let path_a = cache_a.disk.as_ref().unwrap().chunk_path(
        "identity",
        &ImageId("img-1".into()),
        1,
        "1/0/0/0/0/0",
    );
    let path_b = cache_b.disk.as_ref().unwrap().chunk_path(
        "identity",
        &ImageId("img-1".into()),
        1,
        "1/0/0/0/0/0",
    );
    assert_ne!(path_a, path_b);
    assert!(path_a.starts_with(canonical_root.join(identity.digest_hex())));
    assert!(path_b.starts_with(canonical_root.join(identity.digest_hex())));
}

#[test]
fn disk_budget_is_shared_across_two_source_scopes() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let source_a = SourceVersion::new(
        lucida_content::url::SourceIdentity::parse("gs://bucket-a/sample.zarr").unwrap(),
        SourceRevision::from_bytes(b"a"),
    );
    let source_b = SourceVersion::new(
        lucida_content::url::SourceIdentity::parse("gs://bucket-b/sample.zarr").unwrap(),
        SourceRevision::from_bytes(b"b"),
    );
    let resident = SharedObjectCache::new(64 * 1024, 64 * 1024);
    let cache_a = DerivedChunkCache::new_on_disk_for_source(
        dir.path().to_path_buf(),
        &source_a,
        None,
        Arc::clone(&resident),
    );
    cache_a.register_generated_plan(&plan).unwrap();
    cache_a
        .put_ready_chunk_atomic(
            &plan.cache_identity,
            plan.image_id.clone(),
            plan.level_index,
            "1/0/0/0/0/0".into(),
            vec![1; 4_096],
        )
        .unwrap();
    let single_source_bytes = cache_a.telemetry().bytes;
    let root_budget = single_source_bytes.saturating_add(single_source_bytes / 2);

    let cache_b = DerivedChunkCache::new_on_disk_for_source(
        dir.path().to_path_buf(),
        &source_b,
        Some(root_budget),
        resident,
    );
    cache_b.register_generated_plan(&plan).unwrap();
    cache_b
        .put_ready_chunk_atomic(
            &plan.cache_identity,
            plan.image_id.clone(),
            plan.level_index,
            "1/0/0/0/0/0".into(),
            vec![2; 4_096],
        )
        .unwrap();

    let telemetry_a = cache_a.telemetry();
    let telemetry_b = cache_b.telemetry();
    assert_eq!(telemetry_a.root_dir, telemetry_b.root_dir);
    assert_eq!(telemetry_a.bytes, telemetry_b.bytes);
    assert_eq!(telemetry_a.budget_bytes, Some(root_budget));
    assert!(telemetry_a.bytes <= root_budget);
    assert!(telemetry_a.evictions > 0);
}

#[test]
fn root_quota_accounts_many_cross_source_writes_without_rescanning() {
    let dir = tempfile::tempdir().unwrap();
    // Enough for one active scope plus its next atomic temp reservation, but
    // not both growing scopes indefinitely. Alternating writes therefore
    // exercise pre-eviction without relying on a transient over-budget file.
    let budget = 128 * 1024;
    let cache_a = DerivedChunkCache::new_on_disk_with_budget(
        dir.path().to_path_buf(),
        [41; 16],
        Some(budget),
    );
    let cache_b = DerivedChunkCache::new_on_disk_with_budget(
        dir.path().to_path_buf(),
        [42; 16],
        Some(budget),
    );

    for offset in 0..40 {
        for (cache, value) in [(&cache_a, 1_u8), (&cache_b, 2_u8)] {
            cache
                .put_ready_chunk_atomic(
                    "identity",
                    ImageId("img-1".into()),
                    1,
                    format!("1/0/0/0/0/{offset}"),
                    vec![value; 64],
                )
                .unwrap();
        }
    }

    let disk_a = cache_a.disk.as_ref().unwrap();
    let disk_b = cache_b.disk.as_ref().unwrap();
    assert_eq!(disk_a.reconciliation_scans(), 1);
    assert_eq!(disk_b.reconciliation_scans(), 1);
    assert_eq!(cache_a.telemetry().bytes, cache_b.telemetry().bytes);
    assert!(cache_a.telemetry().bytes <= budget);
    assert!(cache_a.telemetry().evictions > 0);
}

#[test]
fn persistent_eviction_failure_latches_quota_unhealthy_and_rejects_later_writes() {
    let dir = tempfile::tempdir().unwrap();
    let budget = 48 * 1024;
    let seed_cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [46; 16]);
    seed_cache
        .put_ready_chunk_atomic(
            "seed",
            ImageId("img-seed".into()),
            1,
            "1/0/0/0/0/0".into(),
            vec![9; 8],
        )
        .unwrap();
    let cache = DerivedChunkCache::new_on_disk_with_budget(
        dir.path().to_path_buf(),
        [47; 16],
        Some(budget),
    );
    cache.inject_persistent_quota_remove_failure();

    let first_error = cache
        .put_ready_chunk_atomic(
            "identity",
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/0".into(),
            vec![1; 64 * 1024],
        )
        .expect_err("over-budget write must report the injected eviction failure");
    assert!(
        first_error
            .to_string()
            .contains("injected generated cache scope deletion failure")
    );

    let telemetry = cache.telemetry();
    assert_eq!(telemetry.storage, DerivedCacheStorage::Disk);
    assert!(!telemetry.accounting_healthy);
    assert_eq!(telemetry.budget_bytes, Some(budget));
    assert!(telemetry.bytes <= budget);
    assert_eq!(
        telemetry.bytes,
        disk_resource_usage_for_test(dir.path()).unwrap().0,
        "unhealthy telemetry must retain the last truthful root ledger"
    );

    let disk = cache.disk.as_ref().expect("disk cache");
    let later_path = disk.chunk_path("identity", &ImageId("img-1".into()), 1, "1/0/0/0/0/1");
    let later_error = cache
        .put_ready_chunk_atomic(
            "identity",
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/1".into(),
            vec![2; 8],
        )
        .expect_err("latched unhealthy accounting must reject later writes");
    assert!(
        later_error
            .to_string()
            .contains("generated cache root accounting is unavailable")
    );
    assert!(!later_path.exists());
    assert_eq!(cache.telemetry(), telemetry);

    cache.clear_persistent_quota_remove_failure();
    cache
        .reconcile_disk_accounting()
        .expect("explicit repair must rescan and enforce before reopening writes");
    let recovered = cache.telemetry();
    assert!(recovered.accounting_healthy);
    assert!(recovered.bytes <= budget);
    assert_eq!(recovered.evictions, telemetry.evictions);

    cache
        .put_ready_chunk_atomic(
            "identity",
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/1".into(),
            vec![2; 8],
        )
        .expect("writes resume only after successful explicit reconciliation");
    assert!(later_path.exists());
    assert!(cache.telemetry().accounting_healthy);
}

#[test]
fn atomic_write_failures_leave_no_unaccounted_temporary_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [46; 16]);
    let disk = cache.disk.as_ref().expect("disk cache");
    let path = disk.chunk_path(
        "fault-injection",
        &ImageId("img-1".into()),
        1,
        "1/0/0/0/0/0",
    );
    let stages = [
        AtomicWriteStage::Write,
        AtomicWriteStage::FileSync,
        AtomicWriteStage::Rename,
        AtomicWriteStage::DirectorySync,
    ];

    for (index, stage) in stages.into_iter().enumerate() {
        let error = disk
            .put_bytes_atomic_injected(&path, &[7; 128], stage)
            .expect_err("injected write must fail");
        assert!(
            error
                .to_string()
                .contains("injected generated atomic-write")
        );
        let parent = path.parent().expect("chunk parent");
        let leftovers = fs::read_dir(parent)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp."))
            .count();
        assert_eq!(leftovers, 0, "{stage:?} left a temporary file");
        let actual_bytes = disk_resource_usage_for_test(dir.path()).unwrap().0;
        assert_eq!(
            cache.telemetry().bytes,
            actual_bytes,
            "{stage:?} failure escaped root accounting"
        );
        assert_eq!(
            disk.reconciliation_scans(),
            u64::try_from(index).unwrap() + 2,
            "each failed mutation must reconcile exactly once"
        );
    }
    assert!(
        path.exists(),
        "post-rename sync failure keeps the atomic file"
    );
}

#[test]
fn atomic_temp_allocation_is_pre_evicted_and_never_crosses_root_ceilings() {
    let dir = tempfile::tempdir().unwrap();
    let cache_a = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [0x51; 16]);
    let cache_b = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [0x52; 16]);
    let disk_a = Arc::clone(cache_a.disk.as_ref().expect("disk cache A"));
    let disk_b = Arc::clone(cache_b.disk.as_ref().expect("disk cache B"));
    let path_a = disk_a.chunk_path("seed", &ImageId("img-a".into()), 1, "1/0/0/0/0/0");
    let path_b = disk_b.chunk_path("seed", &ImageId("img-b".into()), 1, "1/0/0/0/0/0");
    disk_a
        .put_bytes_atomic(&path_a, &vec![1; 512 * 1024])
        .unwrap();
    disk_b.put_bytes_atomic(&path_b, &[2; 4 * 1024]).unwrap();

    let before = disk_resource_usage_for_test(dir.path()).unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let replacement = vec![3; 128 * 1024];
    let reservation =
        super::cache::atomic_write_reservation_for_test(&root, &path_b, replacement.len()).unwrap();
    let byte_budget = before.0.saturating_add(reservation.0 / 2);
    let entry_budget = before.1;
    let _tightener = DerivedChunkCache::new_on_disk_with_entry_budget_for_test(
        dir.path().to_path_buf(),
        [0x53; 16],
        byte_budget,
        entry_budget,
    );

    let scope_a = disk_a.dataset_dir();
    let (reached_tx, reached_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let writer_path = path_b.clone();
    let writer = std::thread::spawn(move || {
        disk_b.put_bytes_atomic_with_pre_rename_barrier(
            &writer_path,
            &replacement,
            reached_tx,
            resume_rx,
        )
    });
    reached_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("writer reached the post-fsync, pre-rename barrier");

    let temp_path = fs::read_dir(path_b.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains(".tmp.")
        })
        .expect("atomic temp file is live at the barrier");
    let temp_usage = super::cache::path_resource_usage_for_test(&temp_path).unwrap();
    let live = disk_resource_usage_for_test(dir.path()).unwrap();
    assert!(
        !scope_a.exists(),
        "oldest scope must be evicted before temp write"
    );
    assert!(before.0.saturating_add(temp_usage.0) > byte_budget);
    assert!(before.1.saturating_add(1) > entry_budget);
    assert!(
        live.0 <= byte_budget,
        "live charged bytes crossed the ceiling"
    );
    assert!(live.1 <= entry_budget, "live entries crossed the ceiling");

    resume_tx.send(()).unwrap();
    writer.join().unwrap().unwrap();
    let final_usage = disk_resource_usage_for_test(dir.path()).unwrap();
    let telemetry = cache_b.telemetry();
    assert_eq!((telemetry.bytes, telemetry.entries), final_usage);
    assert!(telemetry.bytes <= byte_budget);
    assert!(telemetry.entries <= entry_budget);
}

#[test]
fn replacement_fails_closed_when_only_the_protected_scope_could_make_temp_room() {
    let dir = tempfile::tempdir().unwrap();
    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [0x61; 16]);
    let disk = cache.disk.as_ref().expect("disk cache");
    let path = disk.chunk_path("seed", &ImageId("img".into()), 1, "1/0/0/0/0/0");
    let original = vec![7; 32 * 1024];
    disk.put_bytes_atomic(&path, &original).unwrap();
    let before = disk_resource_usage_for_test(dir.path()).unwrap();
    let _tightener = DerivedChunkCache::new_on_disk_with_entry_budget_for_test(
        dir.path().to_path_buf(),
        [0x62; 16],
        before.0.saturating_add(1024 * 1024),
        before.1,
    );

    let error = disk
        .put_bytes_atomic(&path, &vec![8; 64 * 1024])
        .expect_err("replacement must not evict its own protected scope for temp headroom");
    assert!(
        error
            .to_string()
            .contains("cannot admit its temporary allocation")
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(disk_resource_usage_for_test(dir.path()).unwrap(), before);
    assert!(cache.telemetry().accounting_healthy);
}

#[test]
fn atomic_temp_cleanup_closes_the_handle_before_unlinking() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("windows-delete-order.tmp");

    assert!(
        atomic_temp_cleanup_order_probe(&path).unwrap(),
        "the cleanup callback must observe the owned file handle already closed"
    );
    assert!(!path.exists());
}

#[test]
fn on_disk_ready_chunk_reuses_across_cache_instances() {
    let dir = tempfile::tempdir().unwrap();
    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [7; 16]);
    cache
        .put_ready_chunk_atomic(
            "identity",
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/0".into(),
            vec![1, 2, 3, 4],
        )
        .unwrap();

    let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [7; 16]);
    reopened.upsert_level(generated_level());
    assert!(
        reopened
            .load_ready_chunk(
                "identity",
                ImageId("img-1".into()),
                1,
                "1/0/0/0/0/0".into(),
                4,
            )
            .unwrap()
    );
    match reopened.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
        DerivedChunkLookup::Ready(ready) => {
            assert_eq!(read_generated_ready(ready), vec![1, 2, 3, 4])
        }
        DerivedChunkLookup::Status { status, .. } => panic!("expected ready, got {status:?}"),
    }

    let chunk_dir = dir
        .path()
        .join(hex16(&[7; 16]))
        .join("identity")
        .join("img-1")
        .join("L1");
    let leftovers: Vec<_> = fs::read_dir(chunk_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp."))
        .collect();
    assert!(leftovers.is_empty());
}

#[tokio::test]
async fn chunk_beyond_runtime_status_cap_serves_validated_disk_without_regeneration() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = source_manifest();
    let mut plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let cap = lucida_protocol::MAX_GENERATED_RUNTIME_CHUNKS;
    let grid_x = u64::try_from(cap).unwrap() + 1;
    plan.availability.level.grid_shape[4] = grid_x;
    plan.availability.level.shape[4] = plan.availability.level.chunk_shape[4] * grid_x;

    let cache = Arc::new(DerivedChunkCache::new_on_disk(
        dir.path().to_path_buf(),
        [48; 16],
    ));
    cache.register_generated_plan(&plan).unwrap();
    {
        let mut state = cache.inner.lock().unwrap();
        state.availability.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![],
            chunks: (0..cap)
                .map(|offset| GeneratedChunkStatusUpdate {
                    image_id: plan.image_id.clone(),
                    level_index: plan.level_index,
                    key: format!("{}/0/0/0/0/{offset}", plan.level_index),
                    status: GeneratedChunkStatus::Pending,
                    failure: None,
                    message: None,
                })
                .collect(),
        });
    }
    assert_eq!(cache.snapshot().chunks.len(), cap);

    let overflow_key = format!("{}/0/0/0/0/{cap}", plan.level_index);
    let expected_bytes = expected_generated_chunk_bytes(&plan);
    cache
        .put_ready_chunk_atomic(
            &plan.cache_identity,
            plan.image_id.clone(),
            plan.level_index,
            overflow_key.clone(),
            vec![7; usize::try_from(expected_bytes).unwrap()],
        )
        .unwrap();
    assert!(
        cache
            .inner
            .lock()
            .unwrap()
            .availability
            .chunk(&plan.image_id, plan.level_index, &overflow_key)
            .is_none(),
        "the bounded status index must not retain the overflow identity"
    );
    match cache.lookup(&plan.image_id, plan.level_index, &overflow_key) {
        DerivedChunkLookup::Ready(ready) => {
            let bytes = read_generated_ready(ready);
            assert_eq!(u64::try_from(bytes.len()).unwrap(), expected_bytes)
        }
        DerivedChunkLookup::Status {
            status, message, ..
        } => {
            panic!("expected direct validated disk hit, got {status:?}: {message:?}")
        }
    }

    let service = service_for_plan_with_cache(
        manifest,
        plan.clone(),
        GeneratedSchedulingConfig::default(),
        Arc::clone(&cache),
    );
    service
        .enqueue_chunk_request(&plan.image_id, plan.level_index, &overflow_key)
        .await;
    let telemetry = service.telemetry().await;
    assert_eq!(telemetry.queued_visible, 0);
    assert_eq!(telemetry.running, 0);
    assert_eq!(telemetry.deduped, 1);
}

#[test]
fn shared_status_budget_bounds_all_cache_modes_and_reclaims_after_last_clone() {
    let dir = tempfile::tempdir().unwrap();
    let fallback_root = dir.path().join("not-a-directory");
    fs::write(&fallback_root, b"file blocks create_dir_all").unwrap();
    let writable_root = dir.path().join("writable");
    let resident = SharedObjectCache::new(64 * 1024 * 1024, 64 * 1024 * 1024);
    let budget = GeneratedStatusBudget::with_limits(3, 2);

    let level_for = |image_id: &str| {
        let mut level = generated_level();
        level.image_id = ImageId(image_id.into());
        level
    };
    let status_for = |image_id: &str, status| GeneratedChunkStatusUpdate {
        image_id: ImageId(image_id.into()),
        level_index: 1,
        key: "1/0/0/0/0/0".into(),
        status,
        failure: status.failure_descriptor(),
        message: None,
    };

    let memory = DerivedChunkCache::new_with_status_budget(
        GeneratedAvailabilitySnapshot::default(),
        Arc::clone(&budget),
    );
    let fallback = DerivedChunkCache::new_on_disk_with_resource_budgets(
        fallback_root,
        [60; 16],
        None,
        Arc::clone(&resident),
        Arc::clone(&budget),
    );
    assert!(fallback.disk.is_none(), "test must exercise disk fallback");
    let writable = DerivedChunkCache::new_on_disk_with_resource_budgets(
        writable_root,
        [61; 16],
        None,
        resident,
        Arc::clone(&budget),
    );
    assert!(writable.disk.is_some());

    for (cache, image_id) in [(&memory, "memory"), (&fallback, "fallback")] {
        let retained = cache.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![level_for(image_id)],
            chunks: vec![status_for(image_id, GeneratedChunkStatus::Pending)],
        });
        assert_eq!(retained.levels.len(), 1);
        assert_eq!(retained.chunks.len(), 1);
    }
    let memory_clone = memory.clone();

    let retained = writable.apply_delta(GeneratedAvailabilityDelta {
        levels: vec![level_for("writable")],
        chunks: vec![status_for("writable", GeneratedChunkStatus::Pending)],
    });
    assert_eq!(retained.levels.len(), 1, "level budget has one slot");
    assert!(retained.chunks.is_empty(), "aggregate chunk budget is full");
    assert_eq!(budget.counts(), (3, 2));

    // Existing-key transitions do not consume another permit at capacity.
    let transition = fallback.set_chunk_status(
        ImageId("fallback".into()),
        1,
        "1/0/0/0/0/0".into(),
        GeneratedChunkStatus::Ready,
        None,
    );
    assert_eq!(transition.chunks.len(), 1);
    assert_eq!(budget.counts(), (3, 2));

    drop(memory);
    assert_eq!(
        budget.counts(),
        (3, 2),
        "dropping one wrapper must not reclaim permits held by shared inner state"
    );
    assert!(
        writable
            .set_chunk_status(
                ImageId("writable".into()),
                1,
                "1/0/0/0/0/0".into(),
                GeneratedChunkStatus::Pending,
                None,
            )
            .chunks
            .is_empty()
    );

    drop(memory_clone);
    assert_eq!(budget.counts(), (2, 1));
    assert_eq!(
        writable
            .set_chunk_status(
                ImageId("writable".into()),
                1,
                "1/0/0/0/0/0".into(),
                GeneratedChunkStatus::Pending,
                None,
            )
            .chunks
            .len(),
        1,
        "last shared-inner drop must make the released slot reusable"
    );
    assert_eq!(budget.counts(), (2, 2));

    drop(fallback);
    drop(writable);
    assert_eq!(budget.counts(), (0, 0));
}

#[test]
fn standalone_cache_constructors_share_the_process_status_budget_in_every_mode() {
    let dir = tempfile::tempdir().unwrap();
    let fallback_root = dir.path().join("not-a-directory");
    fs::write(&fallback_root, b"file blocks create_dir_all").unwrap();

    let memory = DerivedChunkCache::default();
    let fallback = DerivedChunkCache::new_on_disk(fallback_root, [65; 16]);
    let writable = DerivedChunkCache::new_on_disk(dir.path().join("writable"), [66; 16]);

    assert!(fallback.disk.is_none(), "test must exercise disk fallback");
    assert!(writable.disk.is_some());
    assert!(Arc::ptr_eq(&memory.status_budget, &fallback.status_budget));
    assert!(Arc::ptr_eq(&memory.status_budget, &writable.status_budget));
}

#[test]
fn root_unwritable_ready_write_fails_truthfully_when_status_budget_is_full() {
    let dir = tempfile::tempdir().unwrap();
    let fallback_root = dir.path().join("not-a-directory");
    fs::write(&fallback_root, b"file blocks create_dir_all").unwrap();
    let budget = GeneratedStatusBudget::with_limits(1, 0);
    let cache = DerivedChunkCache::new_on_disk_with_resource_budgets(
        fallback_root,
        [62; 16],
        None,
        SharedObjectCache::new(64 * 1024 * 1024, 64 * 1024 * 1024),
        Arc::clone(&budget),
    );
    assert!(cache.disk.is_none());
    cache.upsert_level(generated_level());

    let error = cache
        .put_ready_chunk_atomic(
            "identity",
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/0".into(),
            vec![1, 2, 3, 4],
        )
        .expect_err("memory-only bytes cannot be acknowledged without a status slot");
    assert!(error.to_string().contains("status capacity"));
    assert!(cache.snapshot().chunks.is_empty());
    assert_eq!(budget.counts(), (1, 0));
    match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
        DerivedChunkLookup::Status { status, .. } => {
            assert_eq!(status, GeneratedChunkStatus::Pending)
        }
        DerivedChunkLookup::Ready(_) => panic!("denied memory-only bytes must not appear ready"),
    }
}

#[test]
fn disk_chunk_denied_a_shared_status_slot_remains_directly_servable_and_reclaimable() {
    let dir = tempfile::tempdir().unwrap();
    let resident = SharedObjectCache::new(64 * 1024 * 1024, 64 * 1024 * 1024);
    let budget = GeneratedStatusBudget::with_limits(2, 1);
    let mut plan =
        plan_generated_coarse_for_manifest(&source_manifest(), GeneratedCoarseConfig::default())
            .pop()
            .expect("plan");
    plan.availability.level.grid_shape[4] = 2;
    plan.availability.level.shape[4] = plan.availability.level.chunk_shape[4] * 2;

    let first = DerivedChunkCache::new_on_disk_with_resource_budgets(
        dir.path().to_path_buf(),
        [63; 16],
        None,
        Arc::clone(&resident),
        Arc::clone(&budget),
    );
    let second = DerivedChunkCache::new_on_disk_with_resource_budgets(
        dir.path().to_path_buf(),
        [64; 16],
        None,
        resident,
        Arc::clone(&budget),
    );
    first.register_generated_plan(&plan).unwrap();
    second.register_generated_plan(&plan).unwrap();
    let first_key = format!("{}/0/0/0/0/0", plan.level_index);
    let second_key = format!("{}/0/0/0/0/1", plan.level_index);
    first.set_chunk_status(
        plan.image_id.clone(),
        plan.level_index,
        first_key,
        GeneratedChunkStatus::Pending,
        None,
    );
    assert_eq!(budget.counts(), (2, 1));

    let expected_bytes = expected_generated_chunk_bytes(&plan);
    second
        .put_ready_chunk_atomic(
            &plan.cache_identity,
            plan.image_id.clone(),
            plan.level_index,
            second_key.clone(),
            vec![7; usize::try_from(expected_bytes).unwrap()],
        )
        .unwrap();
    assert!(second.snapshot().chunks.is_empty());
    assert!(second.is_chunk_materialized(
        &plan.image_id,
        plan.level_index,
        &second_key,
        expected_bytes
    ));
    match second.lookup(&plan.image_id, plan.level_index, &second_key) {
        DerivedChunkLookup::Ready(ready) => {
            assert_eq!(read_generated_ready(ready).len() as u64, expected_bytes)
        }
        DerivedChunkLookup::Status { status, .. } => {
            panic!("validated disk bytes must bypass the full status index: {status:?}")
        }
    }

    drop(first);
    assert_eq!(budget.counts(), (1, 0));
    assert!(
        second
            .load_ready_chunk(
                &plan.cache_identity,
                plan.image_id.clone(),
                plan.level_index,
                second_key,
                expected_bytes,
            )
            .unwrap()
    );
    assert_eq!(second.snapshot().chunks.len(), 1);
    assert_eq!(budget.counts(), (1, 1));
    drop(second);
    assert_eq!(budget.counts(), (0, 0));
}

#[test]
fn disk_ready_state_does_not_imply_unbounded_memory_residency() {
    let dir = tempfile::tempdir().unwrap();
    let resident = SharedObjectCache::new(16, 16);
    let cache = DerivedChunkCache::new_on_disk_with_budgets(
        dir.path().to_path_buf(),
        [17; 16],
        None,
        Arc::clone(&resident),
    );
    cache.upsert_level(generated_level());
    cache
        .put_ready_chunk_atomic(
            "identity",
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/0".into(),
            vec![1, 2, 3, 4],
        )
        .unwrap();
    assert_eq!(
        resident.memory_snapshot().generated_ready_bytes,
        0,
        "disk publication must release its transient resident bytes"
    );

    cache
        .load_ready_chunk(
            "identity",
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/0".into(),
            4,
        )
        .unwrap();
    let lookup = cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0");
    assert_eq!(
        resident.memory_snapshot().generated_ready_bytes,
        0,
        "readiness lookup must not charge or materialize disk payload bytes"
    );
    let DerivedChunkLookup::Ready(ready) = lookup else {
        panic!("expected disk readiness handle");
    };
    let bytes = read_generated_ready(ready);
    assert_eq!(resident.memory_snapshot().generated_ready_bytes, 4);
    drop(bytes);
    assert_eq!(resident.memory_snapshot().generated_ready_bytes, 0);
}

#[test]
fn disk_read_handle_refuses_superseded_level_identity_without_payload_read() {
    let dir = tempfile::tempdir().unwrap();
    let resident = SharedObjectCache::new(16, 16);
    let cache = DerivedChunkCache::new_on_disk_with_budgets(
        dir.path().to_path_buf(),
        [73; 16],
        None,
        Arc::clone(&resident),
    );
    cache.upsert_level(generated_level());
    cache
        .put_ready_chunk_atomic(
            "identity",
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/0".into(),
            vec![1, 2, 3, 4],
        )
        .unwrap();
    let DerivedChunkLookup::Ready(ready) = cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0")
    else {
        panic!("expected disk readiness handle");
    };

    cache.replace_snapshot(GeneratedAvailabilitySnapshot::default());
    assert!(
        ready.read().unwrap().is_none(),
        "a token from a retired generated identity must not materialize"
    );
    assert_eq!(cache.disk_payload_read_attempts(), 0);
    assert_eq!(resident.memory_snapshot().generated_ready_bytes, 0);
}

#[test]
fn disk_read_handle_rejects_grown_replacement_with_exact_bounded_buffer() {
    let dir = tempfile::tempdir().unwrap();
    let resident = SharedObjectCache::new(4, 4);
    let cache = DerivedChunkCache::new_on_disk_with_budgets(
        dir.path().to_path_buf(),
        [74; 16],
        None,
        Arc::clone(&resident),
    );
    cache.upsert_level(generated_level());
    cache
        .put_ready_chunk_atomic(
            "identity",
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/0".into(),
            vec![1, 2, 3, 4],
        )
        .unwrap();
    let DerivedChunkLookup::Ready(ready) = cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0")
    else {
        panic!("expected disk readiness handle");
    };

    let path = cache.disk.as_ref().unwrap().chunk_path(
        "identity",
        &ImageId("img-1".into()),
        1,
        "1/0/0/0/0/0",
    );
    fs::write(&path, [9_u8; 8]).unwrap();
    let error = ready
        .read()
        .expect_err("growth after readiness probe must fail closed");

    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("grew"));
    assert_eq!(cache.disk_payload_read_attempts(), 1);
    assert_eq!(
        cache.disk_payload_buffer_high_water(),
        4,
        "the payload buffer must remain pinned to the reserved expected length"
    );
    assert_eq!(
        resident.memory_snapshot().generated_ready_bytes,
        0,
        "failed reads must release their exact resident reservation"
    );
}

#[test]
fn memory_ready_chunks_are_rejected_at_the_shared_process_ceiling() {
    let resident = SharedObjectCache::new(4, 4);
    let cache = DerivedChunkCache {
        inner: Arc::new(Mutex::new(DerivedChunkState::default())),
        disk: None,
        resident: Arc::clone(&resident),
        status_budget: GeneratedStatusBudget::runtime(),
    };
    cache.upsert_level(generated_level());
    cache.seed_ready_chunk(ImageId("img-1".into()), 1, "1/0/0/0/0/0".into(), vec![0; 5]);

    match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
        DerivedChunkLookup::Status { status, .. } => {
            assert_eq!(status, GeneratedChunkStatus::Unavailable)
        }
        DerivedChunkLookup::Ready(_) => panic!("oversized ready bytes escaped the budget"),
    }
    assert_eq!(resident.memory_snapshot().total_bytes, 0);
}

#[tokio::test]
async fn incremental_status_worker_recovers_latest_key_without_full_index_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let key = plan.chunk_keys_for_tc(0, 0).next().unwrap();
    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [18; 16]);
    cache.register_generated_plan(&plan).unwrap();
    cache.set_chunk_status(
        plan.image_id.clone(),
        plan.level_index,
        key.clone(),
        GeneratedChunkStatus::FailedTransient,
        Some("retry later".into()),
    );
    cache
        .disk
        .as_ref()
        .unwrap()
        .maintenance_barrier(Duration::from_secs(1))
        .await
        .unwrap();
    assert!(
        !cache
            .disk
            .as_ref()
            .unwrap()
            .index_path(&plan.cache_identity)
            .exists(),
        "ordinary deltas must not rewrite the full readiness index"
    );

    let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [18; 16]);
    let delta = reopened.register_generated_plan(&plan).unwrap();
    let recovered = delta
        .chunks
        .iter()
        .find(|chunk| chunk.key == key)
        .expect("incremental status recovered");
    assert_eq!(recovered.status, GeneratedChunkStatus::FailedTransient);
}

#[test]
fn register_generated_plan_recovers_ready_chunks_from_readiness_index() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [9; 16]);
    cache.register_generated_plan(&plan).unwrap();
    let bytes = vec![1_u8; expected_generated_chunk_bytes(&plan) as usize];
    cache
        .put_ready_chunk_atomic(
            &plan.cache_identity,
            plan.image_id.clone(),
            plan.level_index,
            "1/0/0/0/0/0".into(),
            bytes.clone(),
        )
        .unwrap();
    cache.set_chunk_status(
        plan.image_id.clone(),
        plan.level_index,
        "1/0/0/0/0/0".into(),
        GeneratedChunkStatus::Ready,
        None,
    );

    let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [9; 16]);
    let delta = reopened.register_generated_plan(&plan).unwrap();

    assert_eq!(delta.chunks.len(), 1);
    assert_eq!(delta.chunks[0].status, GeneratedChunkStatus::Ready);
    match reopened.lookup(&plan.image_id, plan.level_index, "1/0/0/0/0/0") {
        DerivedChunkLookup::Ready(ready) => assert_eq!(read_generated_ready(ready), bytes),
        DerivedChunkLookup::Status {
            status, message, ..
        } => {
            panic!("expected recovered bytes, got {status:?}: {message:?}");
        }
    }
}

#[test]
fn register_generated_plan_scans_when_readiness_index_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [10; 16]);
    cache.register_generated_plan(&plan).unwrap();
    let bytes = vec![0_u8; expected_generated_chunk_bytes(&plan) as usize];
    cache
        .put_ready_chunk_atomic(
            &plan.cache_identity,
            plan.image_id.clone(),
            plan.level_index,
            "1/0/0/0/0/0".into(),
            bytes,
        )
        .unwrap();
    let _ = fs::remove_file(
        cache
            .disk
            .as_ref()
            .unwrap()
            .index_path(&plan.cache_identity),
    );

    let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [10; 16]);
    let delta = reopened.register_generated_plan(&plan).unwrap();

    assert_eq!(delta.chunks.len(), 1);
    assert_eq!(delta.chunks[0].key, "1/0/0/0/0/0");
    assert_eq!(delta.chunks[0].status, GeneratedChunkStatus::Ready);
}

#[test]
fn readiness_recovery_is_bounded_for_huge_theoretical_tc_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = source_manifest();
    let mut plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    plan.availability.level.shape[0] = 100_000;
    plan.availability.level.shape[1] = 100_000;
    plan.availability.level.grid_shape[0] = 100_000;
    plan.availability.level.grid_shape[1] = 100_000;

    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [19; 16]);
    cache.register_generated_plan(&plan).unwrap();
    cache
        .put_ready_chunk_atomic(
            &plan.cache_identity,
            plan.image_id.clone(),
            plan.level_index,
            "1/99999/99999/0/0/0".into(),
            vec![0; expected_generated_chunk_bytes(&plan) as usize],
        )
        .unwrap();

    let reopened = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [19; 16]);
    let delta = reopened.register_generated_plan(&plan).unwrap();
    assert_eq!(delta.chunks.len(), 1);
    assert_eq!(delta.chunks[0].key, "1/99999/99999/0/0/0");
}

#[test]
fn readiness_index_deserialization_retains_only_the_admitted_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [43; 16]);
    let disk = cache.disk.as_ref().unwrap();
    let index = DerivedReadinessIndex {
        chunks: (0..10_000)
            .map(|offset| GeneratedChunkStatusUpdate {
                image_id: ImageId("img-1".into()),
                level_index: 1,
                key: format!("1/0/0/0/0/{offset}"),
                status: GeneratedChunkStatus::Pending,
                failure: None,
                message: None,
            })
            .collect(),
    };
    let path = disk.index_path("oversized-entry-count");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, serde_json::to_vec(&index).unwrap()).unwrap();

    let recovered = disk
        .read_index("oversized-entry-count", 7)
        .unwrap()
        .unwrap();
    assert_eq!(recovered.chunks.len(), 7);
    assert_eq!(recovered.chunks[0].key, "1/0/0/0/0/0");
    assert_eq!(recovered.chunks[6].key, "1/0/0/0/0/6");
}

#[tokio::test]
async fn checkpoint_snapshot_and_serialization_are_globally_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [44; 16]);
    {
        let mut state = cache.inner.lock().unwrap();
        let image_id = ImageId("img-1".into());
        state
            .level_identities
            .insert((image_id.clone(), 1), "large-runtime-index".into());
        let mut level = generated_level();
        level.level.shape[4] = (MAX_CHECKPOINT_STATUS_ENTRIES + 1_000) as u64;
        level.level.grid_shape[4] = (MAX_CHECKPOINT_STATUS_ENTRIES + 1_000) as u64;
        state.availability.apply_delta(GeneratedAvailabilityDelta {
            levels: vec![level],
            chunks: (0..(MAX_CHECKPOINT_STATUS_ENTRIES + 1_000))
                .map(|offset| GeneratedChunkStatusUpdate {
                    image_id: image_id.clone(),
                    level_index: 1,
                    key: format!("1/0/0/0/0/{offset}"),
                    status: GeneratedChunkStatus::Pending,
                    failure: None,
                    message: None,
                })
                .collect(),
        });
    }

    cache.persist_readiness_indexes().await.unwrap();
    let disk = cache.disk.as_ref().unwrap();
    let metadata = fs::metadata(disk.index_path("large-runtime-index")).unwrap();
    assert!(metadata.len() <= MAX_READINESS_INDEX_BYTES);
    let recovered = disk
        .read_index("large-runtime-index", usize::MAX)
        .unwrap()
        .unwrap();
    assert!(!recovered.chunks.is_empty());
    assert!(recovered.chunks.len() <= MAX_CHECKPOINT_STATUS_ENTRIES);
}

#[tokio::test]
async fn corrupted_generated_chunk_is_not_recovered_reused_or_published_as_ready() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [11; 16]);
    cache.register_generated_plan(&plan).unwrap();
    let path = cache.disk.as_ref().unwrap().chunk_path(
        &plan.cache_identity,
        &plan.image_id,
        plan.level_index,
        "1/0/0/0/0/0",
    );
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, [1_u8]).unwrap();

    let reopened = Arc::new(DerivedChunkCache::new_on_disk(
        dir.path().to_path_buf(),
        [11; 16],
    ));
    let delta = reopened.register_generated_plan(&plan).unwrap();

    assert!(delta.chunks.is_empty());
    let key = "1/0/0/0/0/0";
    assert!(
        !reopened
            .load_ready_chunk(
                &plan.cache_identity,
                plan.image_id.clone(),
                plan.level_index,
                key.into(),
                expected_generated_chunk_bytes(&plan),
            )
            .unwrap(),
        "the plan-derived byte length must reject the truncated cache file"
    );

    let source_levels = manifest.images()[0].multiscale.levels.clone();
    let resolver = Arc::new(ChunkResolver::new(&binding_seed_for(&source_levels)));
    let store =
        Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let cached = Arc::new(CachedStore::new(store, 1024 * 1024));
    let session = Arc::new(AsyncMutex::new(Session::new()));
    let (tx, mut rx) = generated_broadcast_channel(4);
    let result = materialize_generated_coarse_key(
        &plan,
        parse_generated_chunk_key(key).unwrap(),
        Arc::new(manifest),
        cached,
        resolver,
        Arc::clone(&reopened),
        Arc::clone(&session),
        GeneratedDeltaBroadcaster::new(tx.clone()),
        || async { true },
    )
    .await;

    assert_eq!(result, MaterializeOneResult::Canceled);
    assert!(reopened.snapshot().chunks.is_empty());
    assert!(session.lock().await.generated_availability.is_empty());
    assert!(matches!(
        rx.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

#[test]
fn disk_budget_eviction_withdraws_missing_ready_chunks() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [12; 16]);
    cache.register_generated_plan(&plan).unwrap();
    cache
        .put_ready_chunk_atomic(
            &plan.cache_identity,
            plan.image_id.clone(),
            plan.level_index,
            "1/0/0/0/0/0".into(),
            vec![1, 2, 3, 4],
        )
        .unwrap();

    let occupied = cache.telemetry().bytes;
    let budget = occupied.saturating_add(4 * 1024);
    let evicting_cache = DerivedChunkCache::new_on_disk_with_budget(
        dir.path().to_path_buf(),
        [13; 16],
        Some(budget),
    );
    let evicting_disk = evicting_cache.disk.as_ref().expect("evicting disk cache");
    let evicting_path =
        evicting_disk.chunk_path("evictor", &ImageId("img-2".into()), 1, "1/0/0/0/0/0");
    evicting_disk
        .put_bytes_atomic(&evicting_path, &[8; 4])
        .unwrap();

    let telemetry = cache.telemetry();
    assert!(telemetry.evictions > 0);
    assert!(telemetry.bytes <= budget);

    let delta = cache.missing_ready_delta();

    assert_eq!(delta.chunks.len(), 1);
    assert_eq!(delta.chunks[0].status, GeneratedChunkStatus::Unavailable);
    assert_eq!(
        delta.chunks[0].message.as_deref(),
        Some("generated chunk was evicted from derived cache")
    );
}

#[tokio::test]
async fn generated_coarse_materializes_from_fake_source_without_mutating_source() {
    use object_store::PutPayload;
    use object_store::memory::InMemory;
    use object_store::path::Path;

    let source_level = level(0, [1, 1, 1, 4, 4], [1, 1, 1, 4, 4]);
    let manifest = source_manifest_with_levels(vec![source_level.clone()], None, DataType::Uint16);
    let plan = plan_generated_coarse_for_manifest(
        &manifest,
        GeneratedCoarseConfig {
            target_long_axis: 2,
            chunk_long_axis: 2,
            max_chunk_bytes: 64,
        },
    )
    .pop()
    .expect("plan");
    let seed = binding_seed_for(&[source_level]);
    let resolver = Arc::new(ChunkResolver::new(&seed));
    let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let source_path = Path::from("0/c/0/0/0/0/0");
    let mut source_bytes = Vec::new();
    for value in 0_u16..16 {
        source_bytes.extend_from_slice(&value.to_le_bytes());
    }
    store
        .put(&source_path, PutPayload::from(source_bytes.clone()))
        .await
        .unwrap();

    let cache = Arc::new(DerivedChunkCache::new_on_disk(
        tempfile::tempdir().unwrap().path().to_path_buf(),
        [8; 16],
    ));
    cache.upsert_level(plan.availability.clone());
    let session = Arc::new(AsyncMutex::new(Session::new()));
    let (tx, _rx) = generated_broadcast_channel(16);

    materialize_generated_coarse_plan(
        plan.clone(),
        Arc::new(manifest),
        Arc::new(CachedStore::new(store.clone(), 1024 * 1024)),
        resolver,
        cache.clone(),
        session,
        tx,
    )
    .await;

    match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
        DerivedChunkLookup::Ready(ready) => {
            let bytes = read_generated_ready(ready);
            let values: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            assert_eq!(values, vec![5, 7, 13, 15]);
        }
        DerivedChunkLookup::Status {
            status, message, ..
        } => {
            panic!("expected generated bytes, got {status:?}: {message:?}");
        }
    }
    let after = store
        .get(&source_path)
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(&after[..], &source_bytes[..]);
}

#[tokio::test]
async fn generated_coarse_materializes_one_chunk_without_fetching_full_source() {
    use object_store::PutPayload;
    use object_store::memory::InMemory;
    use object_store::path::Path;

    let source_level = level(0, [1, 1, 1, 4, 4], [1, 1, 1, 2, 2]);
    let manifest = source_manifest_with_levels(vec![source_level.clone()], None, DataType::Uint16);
    let plan = plan_generated_coarse_for_manifest(
        &manifest,
        GeneratedCoarseConfig {
            target_long_axis: 4,
            chunk_long_axis: 2,
            max_chunk_bytes: 64,
        },
    )
    .pop()
    .expect("plan");
    let seed = binding_seed_for(&[source_level]);
    let resolver = Arc::new(ChunkResolver::new(&seed));
    let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let source_path = Path::from("0/c/0/0/0/0/0");
    let mut source_bytes = Vec::new();
    for value in [10_u16, 20, 30, 40] {
        source_bytes.extend_from_slice(&value.to_le_bytes());
    }
    store
        .put(&source_path, PutPayload::from(source_bytes))
        .await
        .unwrap();

    let cache = Arc::new(DerivedChunkCache::new_on_disk(
        tempfile::tempdir().unwrap().path().to_path_buf(),
        [9; 16],
    ));
    cache.upsert_level(plan.availability.clone());
    let session = Arc::new(AsyncMutex::new(Session::new()));
    let (tx, _rx) = generated_broadcast_channel(16);
    let manifest = Arc::new(manifest);
    let cached = Arc::new(CachedStore::new(store, 1024 * 1024));

    let result = materialize_generated_coarse_key(
        &plan,
        parse_generated_chunk_key("1/0/0/0/0/0").unwrap(),
        manifest.clone(),
        cached.clone(),
        resolver.clone(),
        cache.clone(),
        session.clone(),
        GeneratedDeltaBroadcaster::new(tx.clone()),
        || async { false },
    )
    .await;
    assert_eq!(result, MaterializeOneResult::Ready);

    match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
        DerivedChunkLookup::Ready(ready) => {
            let bytes = read_generated_ready(ready);
            let values: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            assert_eq!(values, vec![10, 20, 30, 40]);
        }
        DerivedChunkLookup::Status {
            status, message, ..
        } => {
            panic!("expected generated bytes, got {status:?}: {message:?}");
        }
    }
}

#[tokio::test]
async fn generated_coarse_materializes_float32_source_chunks() {
    use object_store::PutPayload;
    use object_store::memory::InMemory;
    use object_store::path::Path;

    let source_level = level(0, [1, 1, 1, 2, 2], [1, 1, 1, 2, 2]);
    let manifest = source_manifest_with_levels(vec![source_level.clone()], None, DataType::Float32);
    let plan = plan_generated_coarse_for_manifest(
        &manifest,
        GeneratedCoarseConfig {
            target_long_axis: 2,
            chunk_long_axis: 2,
            max_chunk_bytes: 64,
        },
    )
    .pop()
    .expect("plan");
    let seed = binding_seed_for_data_type(&[source_level], DataType::Float32);
    let resolver = Arc::new(ChunkResolver::new(&seed));
    let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let source_path = Path::from("0/c/0/0/0/0/0");
    let mut source_bytes = Vec::new();
    for value in [0.0_f32, 0.5, 1.0, 2.0] {
        source_bytes.extend_from_slice(&value.to_le_bytes());
    }
    store
        .put(&source_path, PutPayload::from(source_bytes))
        .await
        .unwrap();

    let cache = Arc::new(DerivedChunkCache::new_on_disk(
        tempfile::tempdir().unwrap().path().to_path_buf(),
        [10; 16],
    ));
    cache.upsert_level(plan.availability.clone());
    let session = Arc::new(AsyncMutex::new(Session::new()));
    let (tx, _rx) = generated_broadcast_channel(16);
    let coords = parse_generated_chunk_key("1/0/0/0/0/0").unwrap();

    let result = materialize_generated_coarse_key(
        &plan,
        coords,
        Arc::new(manifest),
        Arc::new(CachedStore::new(store, 1024 * 1024)),
        resolver,
        cache.clone(),
        session,
        GeneratedDeltaBroadcaster::new(tx),
        || async { false },
    )
    .await;

    assert_eq!(result, MaterializeOneResult::Ready);
    match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
        DerivedChunkLookup::Ready(ready) => {
            let bytes = read_generated_ready(ready);
            let values: Vec<f32> = bytes
                .chunks_exact(4)
                .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect();
            assert!((values[0] - 0.0).abs() < 0.00001);
            assert!((values[1] - 0.5).abs() < 0.00002);
            assert!((values[2] - 1.0).abs() < 0.00001);
            assert!((values[3] - 1.0).abs() < 0.00001);
        }
        DerivedChunkLookup::Status {
            status, message, ..
        } => {
            panic!("expected generated bytes, got {status:?}: {message:?}");
        }
    }
}

#[tokio::test]
async fn generated_coarse_treats_missing_source_chunks_as_zero_fill() {
    use object_store::PutPayload;
    use object_store::memory::InMemory;
    use object_store::path::Path;

    let source_level = level(0, [1, 1, 1, 2, 2], [1, 1, 1, 1, 1]);
    let manifest = source_manifest_with_levels(vec![source_level.clone()], None, DataType::Uint16);
    let plan = plan_generated_coarse_for_manifest(
        &manifest,
        GeneratedCoarseConfig {
            target_long_axis: 2,
            chunk_long_axis: 2,
            max_chunk_bytes: 64,
        },
    )
    .pop()
    .expect("plan");
    let seed = binding_seed_for(&[source_level]);
    let resolver = Arc::new(ChunkResolver::new(&seed));
    let store = Arc::new(InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let source_path = Path::from("0/c/0/0/0/0/1");
    store
        .put(&source_path, PutPayload::from(7_u16.to_le_bytes().to_vec()))
        .await
        .unwrap();

    let cache = Arc::new(DerivedChunkCache::new_on_disk(
        tempfile::tempdir().unwrap().path().to_path_buf(),
        [11; 16],
    ));
    cache.upsert_level(plan.availability.clone());
    let session = Arc::new(AsyncMutex::new(Session::new()));
    let (tx, _rx) = generated_broadcast_channel(16);
    let coords = parse_generated_chunk_key("1/0/0/0/0/0").unwrap();

    let result = materialize_generated_coarse_key(
        &plan,
        coords,
        Arc::new(manifest),
        Arc::new(CachedStore::new(store, 1024 * 1024)),
        resolver,
        cache.clone(),
        session,
        GeneratedDeltaBroadcaster::new(tx),
        || async { false },
    )
    .await;

    assert_eq!(result, MaterializeOneResult::Ready);
    match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
        DerivedChunkLookup::Ready(ready) => {
            let bytes = read_generated_ready(ready);
            let values: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            assert_eq!(values, vec![0]);
        }
        DerivedChunkLookup::Status {
            status, message, ..
        } => {
            panic!("expected generated bytes, got {status:?}: {message:?}");
        }
    }
}

#[tokio::test]
async fn viewer_interest_dedupes_duplicate_chunks_to_highest_lane() {
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let key = "1/0/0/0/0/0";
    let service = service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

    service
        .apply_viewer_interest(
            1,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                key,
                ViewerInterestLane::Predicted,
                current_unix_millis(),
            ),
        )
        .await;
    service
        .apply_viewer_interest(
            2,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                key,
                ViewerInterestLane::Visible,
                current_unix_millis(),
            ),
        )
        .await;

    let item = service.pop_next_work_item().await.expect("work");
    assert_eq!(item.lane, GeneratedSchedulingLane::Visible);
    assert_eq!(item.work_key.key, key);
    assert!(service.telemetry().await.deduped > 0);
}

#[tokio::test]
async fn unique_invalid_requests_never_enter_interest_queue_or_availability_state() {
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let cache = Arc::new(DerivedChunkCache::default());
    cache.upsert_level(plan.availability.clone());
    let session = Arc::new(AsyncMutex::new(Session::new()));
    let store =
        Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let cached = Arc::new(CachedStore::new(store, 1024 * 1024));
    let resolver = Arc::new(ChunkResolver::new(&binding_seed_for(
        &manifest.images()[0].multiscale.levels,
    )));
    let (tx, mut rx) = generated_broadcast_channel(16);
    let service = GeneratedCoarseService::new(
        vec![plan.clone()],
        Arc::new(manifest),
        cached,
        resolver,
        Arc::clone(&cache),
        Arc::clone(&session),
        tx,
        GeneratedSchedulingConfig::default(),
    );

    for index in 1_000_000..1_010_000 {
        service
            .enqueue_chunk_request(
                &plan.image_id,
                plan.level_index,
                &format!("{}/0/0/0/0/{index}", plan.level_index),
            )
            .await;
    }
    let mut hint = interest(
        plan.dataset_id.clone(),
        plan.image_id.clone(),
        "malformed",
        ViewerInterestLane::Visible,
        current_unix_millis(),
    );
    hint.desired_keys = (1_000_000..1_010_000)
        .map(|index| ViewerInterestChunkKey {
            image_id: plan.image_id.clone(),
            key: format!("{}/0/0/0/0/{index}", plan.level_index),
            lane: ViewerInterestLane::Visible,
        })
        .collect();
    service.apply_viewer_interest(99, hint).await;

    let telemetry = service.telemetry().await;
    assert_eq!(telemetry.queued_visible, 0);
    assert_eq!(telemetry.queued_predicted, 0);
    assert_eq!(telemetry.running, 0);
    assert_eq!(service.retained_interest_key_count().await, 0);
    assert!(cache.snapshot().chunks.is_empty());
    assert!(session.lock().await.generated_availability.is_empty());
    assert!(matches!(
        rx.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn removed_ready_chunk_is_re_admitted_without_unbounded_completion_state() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let key = "1/0/0/0/0/0";
    let cache = Arc::new(DerivedChunkCache::new_on_disk(
        dir.path().to_path_buf(),
        [20; 16],
    ));
    cache.register_generated_plan(&plan).unwrap();
    cache
        .put_ready_chunk_atomic(
            &plan.cache_identity,
            plan.image_id.clone(),
            plan.level_index,
            key.into(),
            vec![0; expected_generated_chunk_bytes(&plan) as usize],
        )
        .unwrap();
    let service = service_for_plan_with_cache(
        manifest,
        plan.clone(),
        GeneratedSchedulingConfig::default(),
        Arc::clone(&cache),
    );

    service
        .apply_viewer_interest(
            1,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                key,
                ViewerInterestLane::Visible,
                current_unix_millis(),
            ),
        )
        .await;
    assert_eq!(service.telemetry().await.queued_visible, 0);

    let path = cache.disk.as_ref().unwrap().chunk_path(
        &plan.cache_identity,
        &plan.image_id,
        plan.level_index,
        key,
    );
    fs::remove_file(path).unwrap();
    service
        .apply_viewer_interest(
            1,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                key,
                ViewerInterestLane::Visible,
                current_unix_millis(),
            ),
        )
        .await;

    let item = service
        .pop_next_work_item()
        .await
        .expect("re-admitted work");
    assert_eq!(item.work_key.key, key);
}

#[tokio::test]
async fn latest_client_interest_replaces_stale_queued_work() {
    let manifest = source_manifest_with_levels(
        vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
        None,
        DataType::Uint16,
    );
    let plan = plan_generated_coarse_for_manifest(
        &manifest,
        GeneratedCoarseConfig {
            target_long_axis: 512,
            chunk_long_axis: 256,
            max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
        },
    )
    .pop()
    .expect("plan");
    let service = service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

    service
        .apply_viewer_interest(
            1,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                "1/0/0/0/0/0",
                ViewerInterestLane::Visible,
                current_unix_millis(),
            ),
        )
        .await;
    service
        .apply_viewer_interest(
            1,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                "1/0/0/0/0/1",
                ViewerInterestLane::Visible,
                current_unix_millis(),
            ),
        )
        .await;

    let telemetry = service.telemetry().await;
    assert_eq!(telemetry.queued_visible, 1);
    assert_eq!(telemetry.canceled, 1);
    let item = service.pop_next_work_item().await.expect("work");
    assert_eq!(item.work_key.key, "1/0/0/0/0/1");
}

#[tokio::test]
async fn expired_viewer_interest_drops_queued_jobs() {
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let service = service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());
    let mut hint = interest(
        plan.dataset_id.clone(),
        plan.image_id.clone(),
        "1/0/0/0/0/0",
        ViewerInterestLane::Visible,
        current_unix_millis().saturating_sub(60_000),
    );
    hint.ttl_ms = 1;

    service.apply_viewer_interest(1, hint).await;

    let telemetry = service.telemetry().await;
    assert_eq!(telemetry.queued_visible, 0);
    assert_eq!(telemetry.canceled, 1);
}

#[tokio::test]
async fn visible_work_yields_background_fill() {
    let manifest = source_manifest_with_levels(
        vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
        None,
        DataType::Uint16,
    );
    let plan = plan_generated_coarse_for_manifest(
        &manifest,
        GeneratedCoarseConfig {
            target_long_axis: 512,
            chunk_long_axis: 256,
            max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
        },
    )
    .pop()
    .expect("plan");
    let service = service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

    service.enqueue_background_fill().await;
    service
        .apply_viewer_interest(
            1,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                "1/0/0/0/0/1",
                ViewerInterestLane::Visible,
                current_unix_millis(),
            ),
        )
        .await;

    let item = service.pop_next_work_item().await.expect("work");
    assert_eq!(item.lane, GeneratedSchedulingLane::Visible);
    assert_eq!(item.work_key.key, "1/0/0/0/0/1");
}

#[tokio::test]
async fn background_fill_takes_bounded_prefix_of_u64_max_spatial_grid() {
    let manifest = source_manifest();
    let mut plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    plan.availability.level.shape[2] = u64::MAX;
    plan.availability.level.grid_shape = [1, 1, u64::MAX, 1, 1];
    let service = service_for_plan(
        manifest,
        plan.clone(),
        GeneratedSchedulingConfig {
            background_chunk_limit: 32,
            ..GeneratedSchedulingConfig::default()
        },
    );

    service.enqueue_background_fill().await;

    assert_eq!(service.telemetry().await.queued_background, 32);
    let first = service.pop_next_work_item().await.expect("first work");
    assert_eq!(
        first.work_key.key,
        format!("{}/0/0/0/0/0", plan.level_index)
    );
    let mut last = first;
    for _ in 1..32 {
        last = service.pop_next_work_item().await.expect("bounded work");
    }
    assert_eq!(
        last.work_key.key,
        format!("{}/0/0/31/0/0", plan.level_index)
    );
    assert!(service.pop_next_work_item().await.is_none());
}

#[tokio::test]
async fn all_plan_failure_publication_caps_u64_max_grid_at_runtime_status_bound() {
    let source = source_manifest();
    let mut plan = plan_generated_coarse_for_manifest(&source, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    plan.availability.level.shape[2] = u64::MAX;
    plan.availability.level.grid_shape = [1, 1, u64::MAX, 1, 1];
    let missing_image_manifest = DatasetManifest::new(
        plan.dataset_id.clone(),
        "missing image".into(),
        DatasetKind::Single,
        vec![],
        vec![],
        vec![],
        vec![],
        None,
    );
    let store =
        Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let cached = Arc::new(CachedStore::new(store, 1024));
    let resolver = Arc::new(ChunkResolver::new(&ServerBindingSeed { images: vec![] }));
    let cache = Arc::new(DerivedChunkCache::default());
    let session = Arc::new(AsyncMutex::new(Session::new()));
    let (tx, mut rx) = generated_broadcast_channel(4);

    tokio::time::timeout(
        Duration::from_secs(2),
        materialize_generated_coarse_plan(
            plan,
            Arc::new(missing_image_manifest),
            cached,
            resolver,
            Arc::clone(&cache),
            Arc::clone(&session),
            tx.clone(),
        ),
    )
    .await
    .expect("bounded failure publication must not enumerate the full theoretical grid");

    assert!(cache.snapshot().chunks.is_empty());
    assert!(session.lock().await.generated_availability.is_empty());
    assert!(matches!(
        rx.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn running_work_observes_cancellation_after_reprioritization() {
    let manifest = source_manifest_with_levels(
        vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
        None,
        DataType::Uint16,
    );
    let plan = plan_generated_coarse_for_manifest(
        &manifest,
        GeneratedCoarseConfig {
            target_long_axis: 512,
            chunk_long_axis: 256,
            max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
        },
    )
    .pop()
    .expect("plan");
    let service = service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

    service
        .apply_viewer_interest(
            1,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                "1/0/0/0/0/0",
                ViewerInterestLane::Visible,
                current_unix_millis(),
            ),
        )
        .await;
    let running = service.pop_next_work_item().await.expect("running");
    service
        .apply_viewer_interest(
            1,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                "1/0/0/0/0/1",
                ViewerInterestLane::Visible,
                current_unix_millis(),
            ),
        )
        .await;

    assert!(service.should_cancel(&running).await);
}

#[tokio::test]
async fn shutdown_cancels_queued_work_and_rejects_new_interest() {
    let manifest = source_manifest_with_levels(
        vec![level(0, [1, 1, 1, 512, 512], [1, 1, 1, 256, 256])],
        None,
        DataType::Uint16,
    );
    let plan = plan_generated_coarse_for_manifest(
        &manifest,
        GeneratedCoarseConfig {
            target_long_axis: 512,
            chunk_long_axis: 256,
            max_chunk_bytes: DEFAULT_MAX_CHUNK_BYTES,
        },
    )
    .pop()
    .expect("plan");
    let service = service_for_plan(manifest, plan.clone(), GeneratedSchedulingConfig::default());

    service.enqueue_background_fill().await;
    assert!(service.telemetry().await.queued_background > 0);

    let telemetry = service.shutdown("test").await;
    assert!(service.is_shutdown().await);
    assert_eq!(telemetry.queued_background, 0);
    assert!(telemetry.canceled > 0);
    assert!(service.pop_next_work_item().await.is_none());

    service
        .apply_viewer_interest(
            1,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                "1/0/0/0/0/0",
                ViewerInterestLane::Visible,
                current_unix_millis(),
            ),
        )
        .await;
    assert_eq!(service.telemetry().await.queued_visible, 0);
}

#[tokio::test(flavor = "current_thread")]
async fn shutdown_aborts_and_joins_blocked_running_worker_before_return() {
    let manifest = source_manifest();
    let plan = plan_generated_coarse_for_manifest(&manifest, GeneratedCoarseConfig::default())
        .pop()
        .expect("plan");
    let cache = Arc::new(DerivedChunkCache::default());
    cache.upsert_level(plan.availability.clone());
    let session = Arc::new(AsyncMutex::new(Session::new()));
    let store =
        Arc::new(object_store::memory::InMemory::new()) as Arc<dyn object_store::ObjectStore>;
    let cached = Arc::new(CachedStore::new(store, 1024 * 1024));
    let resolver = Arc::new(ChunkResolver::new(&binding_seed_for(
        &manifest.images()[0].multiscale.levels,
    )));
    let (tx, mut rx) = generated_broadcast_channel(16);
    let service = GeneratedCoarseService::new(
        vec![plan.clone()],
        Arc::new(manifest),
        cached,
        resolver,
        Arc::clone(&cache),
        Arc::clone(&session),
        tx,
        GeneratedSchedulingConfig::default(),
    );
    let (entered, release) = service.install_worker_barrier();
    service.start();
    service
        .apply_viewer_interest(
            1,
            interest(
                plan.dataset_id.clone(),
                plan.image_id.clone(),
                "1/0/0/0/0/0",
                ViewerInterestLane::Visible,
                current_unix_millis(),
            ),
        )
        .await;
    let entered_permit = tokio::time::timeout(Duration::from_secs(1), entered.acquire())
        .await
        .expect("worker entered deterministic barrier")
        .expect("barrier remains open");
    entered_permit.forget();
    assert_eq!(service.telemetry().await.running, 1);

    let telemetry = tokio::time::timeout(Duration::from_secs(1), service.shutdown("archive"))
        .await
        .expect("shutdown joined the blocked worker");
    assert_eq!(telemetry.running, 0);
    assert!(telemetry.canceled >= 1);
    assert_eq!(service.worker_handle_count(), 0);

    // Releasing the old gate after shutdown cannot resurrect detached work or
    // publish a readiness update after the archive barrier returned.
    release.add_permits(1);
    tokio::task::yield_now().await;
    assert!(cache.snapshot().chunks.is_empty());
    assert!(session.lock().await.generated_availability.is_empty());
    assert!(matches!(
        rx.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn checkpoint_deadline_remains_preemptible_after_worker_dequeues() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = DerivedChunkCache::new_on_disk(dir.path().to_path_buf(), [45; 16]);
    let dequeued = cache.install_stalled_maintenance_worker(Duration::from_millis(250));
    let started = Instant::now();

    let error = cache
        .checkpoint_with_timeout(Duration::from_millis(25))
        .await
        .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_millis(150));
    assert!(dequeued.load(Ordering::Acquire));
}

#[test]
fn generated_source_failures_are_classified_for_retry() {
    let transient = VolumeReadError::Fetch {
        image: ImageId("img-1".into()),
        key: "0/0/0/0/0/0".into(),
        source: object_store::Error::Generic {
            store: "test",
            source: "temporary object-store failure".into(),
        },
    };
    let permanent = VolumeReadError::ShortChunk {
        image: ImageId("img-1".into()),
        key: "0/0/0/0/0/0".into(),
        got: 1,
        expected: 4,
    };
    let permission = VolumeReadError::Fetch {
        image: ImageId("img-1".into()),
        key: "0/0/0/0/0/1".into(),
        source: object_store::Error::PermissionDenied {
            path: "secret/path".into(),
            source: "misleading: object not found".into(),
        },
    };

    assert_eq!(transient.failure().kind, FailureCode::StorageBackend);
    assert!(transient.failure().retryable);
    assert_eq!(
        generated_status_for_source_error(&transient),
        GeneratedChunkStatus::FailedTransient
    );
    assert_eq!(permanent.failure().kind, FailureCode::DecodeFailure);
    assert_eq!(
        generated_status_for_source_error(&permanent),
        GeneratedChunkStatus::FailedPermanent
    );
    assert_eq!(permission.failure().kind, FailureCode::Permission);
    assert!(!permission.failure().retryable);
    assert_eq!(
        generated_status_for_source_error(&permission),
        GeneratedChunkStatus::FailedPermanent,
        "the typed object-store variant wins over misleading display text",
    );
}

#[test]
fn explicit_statuses_are_returned() {
    let cache = DerivedChunkCache::default();
    cache.upsert_level(generated_level());
    for status in [
        GeneratedChunkStatus::Unavailable,
        GeneratedChunkStatus::FailedTransient,
        GeneratedChunkStatus::FailedPermanent,
    ] {
        cache.set_chunk_status(
            ImageId("img-1".into()),
            1,
            "1/0/0/0/0/0".into(),
            status,
            Some("status".into()),
        );
        match cache.lookup(&ImageId("img-1".into()), 1, "1/0/0/0/0/0") {
            DerivedChunkLookup::Status { status: got, .. } => assert_eq!(got, status),
            DerivedChunkLookup::Ready(_) => panic!("expected status"),
        }
    }
}

#[test]
fn availability_merges_into_client_visible_manifest() {
    let mut manifest = source_manifest();
    let snapshot = GeneratedAvailabilitySnapshot {
        levels: vec![generated_level()],
        chunks: vec![],
    };

    merge_generated_availability_into_manifest(&mut manifest, &snapshot);

    let multiscale = &manifest.images()[0].multiscale;
    assert_eq!(multiscale.levels.len(), 2);
    assert_eq!(multiscale.generated_levels.len(), 1);
    assert_eq!(multiscale.coarse_level_index, Some(1));
}
