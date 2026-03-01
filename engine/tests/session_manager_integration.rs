use lucida_engine::{
    AddSourceRequest, AttachRequest, AxisName, ChunkAssetKind, ChunkKey, ClientViewMode,
    DataPlaneService, GenerationAvailability, GenerationStage, PermissionClass, ReconnectRequest,
    SessionManager, SourceKind,
};
use std::fs;
use std::path::Path;

fn write_minimal_rgb_tiff(path: &Path) {
    let file = fs::File::create(path).expect("tiff fixture file should be created");
    let mut encoder =
        tiff::encoder::TiffEncoder::new(file).expect("tiff fixture encoder should be created");
    let width = 32_u32;
    let height = 16_u32;
    let mut pixels = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for y in 0..height {
        for x in 0..width {
            pixels.push((x as u8).wrapping_mul(7));
            pixels.push((y as u8).wrapping_mul(9));
            pixels.push((x as u8).wrapping_add(y as u8));
        }
    }
    encoder
        .new_image::<tiff::encoder::colortype::RGB8>(width, height)
        .expect("tiff fixture image should be created")
        .write_data(&pixels)
        .expect("tiff fixture pixels should be written");
}

fn write_revision_rgb_tiff(path: &Path, revision: u8) {
    let file = fs::File::create(path).expect("tiff fixture file should be created");
    let mut encoder =
        tiff::encoder::TiffEncoder::new(file).expect("tiff fixture encoder should be created");
    let width = 32_u32;
    let height = 16_u32;
    let mut pixels = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for y in 0..height {
        for x in 0..width {
            pixels.push((x as u8).wrapping_mul(7).wrapping_add(revision));
            pixels.push(
                (y as u8)
                    .wrapping_mul(9)
                    .wrapping_add(revision.wrapping_mul(2)),
            );
            pixels.push(
                (x as u8)
                    .wrapping_add(y as u8)
                    .wrapping_add(revision.wrapping_mul(3)),
            );
        }
    }
    encoder
        .new_image::<tiff::encoder::colortype::RGB8>(width, height)
        .expect("tiff fixture image should be created")
        .write_data(&pixels)
        .expect("tiff fixture pixels should be written");
}

fn overwrite_file(path: &Path, data: &[u8]) {
    fs::write(path, data).expect("fixture overwrite should succeed");
}

#[test]
fn session_manager_public_api_allocates_ids_and_revisions() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc200_session_manager_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    let source_path = fixture_dir.join("integration-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-session");

    let attached = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "integration-client".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("attach should succeed");

    let registered = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "integration-source".to_owned(),
                uri: source_path.display().to_string(),
            },
        )
        .expect("source add should succeed");
    let layer = manager
        .add_layer(&created.session_id, "integration-layer")
        .expect("layer add should succeed");

    let generation_seq = manager
        .bump_source_generation_seq(&created.session_id, &registered.source.source_id)
        .expect("generation bump should succeed");
    let metadata_rev = manager
        .bump_layer_metadata_revision(&created.session_id, &layer.layer_id)
        .expect("metadata rev bump should succeed");
    let write_rev = manager
        .bump_layer_write_revision(&created.session_id, &layer.layer_id)
        .expect("write rev bump should succeed");
    let view_rev = manager
        .update_client_view_mode(
            &created.session_id,
            &attached.snapshot.client_view.client_id,
            ClientViewMode::ThreeD,
        )
        .expect("view rev bump should succeed");

    assert!(created.session_id.starts_with("sess_"));
    assert!(attached.snapshot.client_view.client_id.starts_with("cli_"));
    assert!(registered.source.source_id.starts_with("src_"));
    assert!(registered.dataset.dataset_id.starts_with("ds_"));
    assert_eq!(registered.source.source_kind, SourceKind::Tiff);
    assert_eq!(registered.source.source_metadata.shape.x, 32);
    assert_eq!(registered.source.source_metadata.shape.y, 16);
    assert_eq!(registered.source.source_metadata.shape.c, 3);
    assert_eq!(
        registered.dataset.canonical_axes,
        vec![
            AxisName::T,
            AxisName::C,
            AxisName::Z,
            AxisName::Y,
            AxisName::X
        ]
    );
    assert!(layer.layer_id.starts_with("lay_"));
    assert_eq!(generation_seq, 1);
    assert_eq!(metadata_rev, 1);
    assert_eq!(write_rev, 1);
    assert_eq!(view_rev, 1);

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
}

#[test]
fn session_manager_supports_heartbeat_idle_disconnect_and_reconnect() {
    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-reconnect");

    let first = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "first".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("first attach should succeed");
    let second = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "second".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("second attach should succeed");

    manager
        .heartbeat(&created.session_id, &second.snapshot.client_view.client_id)
        .expect("heartbeat should succeed");
    let removed = manager
        .disconnect_idle_clients(&created.session_id, 0)
        .expect("disconnect should succeed");

    assert_eq!(removed, vec![first.snapshot.client_view.client_id.clone()]);

    let reconnected = manager
        .reconnect_client(ReconnectRequest {
            session_id: created.session_id,
            previous_client_id: Some(first.snapshot.client_view.client_id),
            client_label: "first".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("reconnect should succeed");

    assert_eq!(reconnected.snapshot.client_roster.len(), 2);
}

#[test]
fn session_manager_watcher_stability_gate_requires_debounce_before_generation_bump() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc201_session_manager_watch_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    let source_path = fixture_dir.join("watch-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-watch");
    let attached = manager
        .attach_client(AttachRequest {
            session_id: created.session_id.clone(),
            client_label: "integration-client".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("attach should succeed");
    let added = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "watch-source".to_owned(),
                uri: source_path.display().to_string(),
            },
        )
        .expect("source add should succeed");

    assert_eq!(
        manager
            .poll_source_watch(&created.session_id, &added.source.source_id, 0)
            .expect("initial poll should succeed"),
        None
    );
    overwrite_file(&source_path, b"changed");
    assert_eq!(
        manager
            .poll_source_watch(&created.session_id, &added.source.source_id, 1000)
            .expect("change poll should succeed"),
        None
    );
    assert_eq!(
        manager
            .poll_source_watch(&created.session_id, &added.source.source_id, 3000)
            .expect("verify start should succeed"),
        None
    );
    assert_eq!(
        manager
            .poll_source_watch(&created.session_id, &added.source.source_id, 3200)
            .expect("stable poll should succeed"),
        Some(1)
    );

    let reconnected = manager
        .reconnect_client(ReconnectRequest {
            session_id: created.session_id,
            previous_client_id: Some(attached.snapshot.client_view.client_id),
            client_label: "integration-client".to_owned(),
            requested_permission: PermissionClass::Control,
        })
        .expect("reconnect should succeed");
    let source = reconnected
        .snapshot
        .shared_scene
        .sources
        .get(&added.source.source_id)
        .expect("source should remain present");
    assert_eq!(source.latest_working_generation_seq, 1);

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
}

#[test]
fn session_manager_generation_state_machine_updates_dataset_resolution() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc202_generation_sm_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    let source_path = fixture_dir.join("generation-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-generation-sm");
    let added = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "generation-source".to_owned(),
                uri: source_path.display().to_string(),
            },
        )
        .expect("source add should succeed");
    let detected = manager
        .detect_generation(&created.session_id, &added.source.source_id)
        .expect("generation detection should succeed");
    assert_eq!(detected.stage, GenerationStage::Detected);
    manager
        .start_generation(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
        )
        .expect("start transition should succeed");
    manager
        .report_generation_partial(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
            70,
            GenerationAvailability {
                preview_ready: true,
                tile2d_ready_lods: vec![4, 3],
                brick3d_ready_lods: vec![],
            },
        )
        .expect("partial transition should succeed");
    let ready = manager
        .mark_generation_ready(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
        )
        .expect("ready transition should succeed");

    let snapshot = manager
        .attach_client(AttachRequest {
            session_id: created.session_id,
            client_label: "observer".to_owned(),
            requested_permission: PermissionClass::View,
        })
        .expect("observer attach should succeed");
    let dataset = snapshot
        .snapshot
        .shared_scene
        .datasets
        .values()
        .find(|dataset| dataset.source_id.as_deref() == Some(added.source.source_id.as_str()))
        .expect("dataset should exist for source");
    assert_eq!(dataset.resolved_generation_seq, detected.generation_seq);
    assert_eq!(
        dataset.resolved_generation_id.as_deref(),
        Some(ready.generation_id.as_str())
    );

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
}

#[test]
fn session_manager_builds_canonical_cache_for_generation_and_records_location() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc203_generation_cache_{}_{}",
        std::process::id(),
        1_u64
    ));
    let cache_root = std::env::temp_dir().join(format!(
        "lucida_luc203_generation_cache_root_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    fs::create_dir_all(&cache_root).expect("cache root creation should succeed");
    let source_path = fixture_dir.join("canonical-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-generation-cache");
    let added = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "canonical-source".to_owned(),
                uri: source_path.display().to_string(),
            },
        )
        .expect("source add should succeed");
    let detected = manager
        .detect_generation(&created.session_id, &added.source.source_id)
        .expect("generation detection should succeed");
    manager
        .start_generation(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
        )
        .expect("generation start should succeed");
    manager
        .mark_generation_ready(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
        )
        .expect("generation ready should succeed");
    let built = manager
        .build_canonical_cache_for_generation(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
            &cache_root,
        )
        .expect("canonical cache build should succeed");

    let canonical_cache_path = built
        .canonical_cache_path
        .expect("canonical cache path should be present");
    assert!(Path::new(&canonical_cache_path).join(".zattrs").exists());
    assert!(
        Path::new(&canonical_cache_path)
            .join("0")
            .join(".zarray")
            .exists()
    );

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
    fs::remove_dir_all(&cache_root).expect("cache root cleanup should succeed");
}

#[test]
fn session_manager_builds_preview_and_tile_manifest_for_generation() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc204_generation_preview_{}_{}",
        std::process::id(),
        1_u64
    ));
    let cache_root = std::env::temp_dir().join(format!(
        "lucida_luc204_generation_preview_root_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    fs::create_dir_all(&cache_root).expect("cache root creation should succeed");
    let source_path = fixture_dir.join("preview-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-generation-preview");
    let added = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "preview-source".to_owned(),
                uri: source_path.display().to_string(),
            },
        )
        .expect("source add should succeed");
    let detected = manager
        .detect_generation(&created.session_id, &added.source.source_id)
        .expect("generation detection should succeed");
    manager
        .start_generation(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
        )
        .expect("generation start should succeed");
    manager
        .build_canonical_cache_for_generation(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
            &cache_root,
        )
        .expect("canonical cache build should succeed");
    let built = manager
        .build_tile_preview_for_generation(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
        )
        .expect("tile/preview build should succeed");

    assert!(built.availability.preview_ready);
    assert!(!built.availability.tile2d_ready_lods.is_empty());
    assert!(Path::new(&built.preview_path.expect("preview path should be present")).exists());
    assert!(
        Path::new(
            &built
                .tile_manifest_path
                .expect("tile manifest path should be present")
        )
        .exists()
    );

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
    fs::remove_dir_all(&cache_root).expect("cache root cleanup should succeed");
}

#[test]
fn session_manager_builds_lazy_bricks_for_generation_and_marks_completed_lod() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc205_generation_bricks_{}_{}",
        std::process::id(),
        1_u64
    ));
    let cache_root = std::env::temp_dir().join(format!(
        "lucida_luc205_generation_bricks_root_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    fs::create_dir_all(&cache_root).expect("cache root creation should succeed");
    let source_path = fixture_dir.join("brick-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-generation-bricks");
    let added = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "brick-source".to_owned(),
                uri: source_path.display().to_string(),
            },
        )
        .expect("source add should succeed");
    let detected = manager
        .detect_generation(&created.session_id, &added.source.source_id)
        .expect("generation detection should succeed");
    manager
        .start_generation(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
        )
        .expect("generation start should succeed");
    manager
        .build_canonical_cache_for_generation(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
            &cache_root,
        )
        .expect("canonical cache build should succeed");
    manager
        .build_bricks_for_generation(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
            0,
            1,
        )
        .expect("initial lazy brick build should succeed");
    let completed = manager
        .build_bricks_for_generation(
            &created.session_id,
            &added.source.source_id,
            detected.generation_seq,
            0,
            10_000,
        )
        .expect("completion lazy brick build should succeed");

    assert!(completed.availability.brick3d_ready_lods.contains(&0));
    assert!(
        Path::new(
            &completed
                .brick_manifest_path
                .expect("brick manifest path should be present")
        )
        .exists()
    );

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
    fs::remove_dir_all(&cache_root).expect("cache root cleanup should succeed");
}

#[test]
fn session_manager_garbage_collect_source_cache_keeps_latest_and_pinned_generations() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc206_generation_gc_{}_{}",
        std::process::id(),
        1_u64
    ));
    let cache_root = std::env::temp_dir().join(format!(
        "lucida_luc206_generation_gc_root_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    fs::create_dir_all(&cache_root).expect("cache root creation should succeed");
    let source_path = fixture_dir.join("gc-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-generation-gc");
    let added = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "gc-source".to_owned(),
                uri: source_path.display().to_string(),
            },
        )
        .expect("source add should succeed");

    let mut generation_seqs = Vec::new();
    for _ in 0..3 {
        let detected = manager
            .detect_generation(&created.session_id, &added.source.source_id)
            .expect("generation detection should succeed");
        manager
            .start_generation(
                &created.session_id,
                &added.source.source_id,
                detected.generation_seq,
            )
            .expect("generation start should succeed");
        manager
            .build_canonical_cache_for_generation(
                &created.session_id,
                &added.source.source_id,
                detected.generation_seq,
                &cache_root,
            )
            .expect("canonical cache build should succeed");
        manager
            .mark_generation_ready(
                &created.session_id,
                &added.source.source_id,
                detected.generation_seq,
            )
            .expect("generation ready should succeed");
        generation_seqs.push(detected.generation_seq);
    }
    manager
        .pin_generation(
            &created.session_id,
            &added.source.source_id,
            generation_seqs[0],
        )
        .expect("pin should succeed");

    let removed = manager
        .garbage_collect_source_cache(
            &created.session_id,
            &added.source.source_id,
            &cache_root,
            1_772_281_600,
            0,
        )
        .expect("cache gc should succeed");

    assert_eq!(removed, vec![generation_seqs[1]]);
    let source_cache_root = cache_root.join(&added.source.source_id);
    assert!(source_cache_root.join("gen_00000001").exists());
    assert!(!source_cache_root.join("gen_00000002").exists());
    assert!(source_cache_root.join("gen_00000003").exists());

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
    fs::remove_dir_all(&cache_root).expect("cache root cleanup should succeed");
}

#[test]
fn source_churn_generations_do_not_mix_data_plane_payloads_across_generation_paths() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc1102_source_churn_{}_{}",
        std::process::id(),
        1_u64
    ));
    let cache_root = std::env::temp_dir().join(format!(
        "lucida_luc1102_source_churn_cache_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    fs::create_dir_all(&cache_root).expect("cache root creation should succeed");
    let source_path = fixture_dir.join("churn-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("integration-source-churn");
    let source = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "churn-source".to_owned(),
                uri: source_path.display().to_string(),
            },
        )
        .expect("source add should succeed");
    assert_eq!(
        manager
            .poll_source_watch(&created.session_id, &source.source.source_id, 0)
            .expect("initial poll should succeed"),
        None
    );

    let mut generation_seqs = Vec::new();
    for revision in 1_u64..=3 {
        write_revision_rgb_tiff(&source_path, revision as u8);
        let base = revision * 10_000;
        assert_eq!(
            manager
                .poll_source_watch(&created.session_id, &source.source.source_id, base + 1_000)
                .expect("churn poll should succeed"),
            None
        );
        assert_eq!(
            manager
                .poll_source_watch(&created.session_id, &source.source.source_id, base + 3_000)
                .expect("verify start poll should succeed"),
            None
        );
        let generation_seq = manager
            .poll_source_watch(&created.session_id, &source.source.source_id, base + 3_200)
            .expect("stable poll should succeed")
            .expect("stable poll should produce generation");
        generation_seqs.push(generation_seq);
        manager
            .build_canonical_cache_for_generation(
                &created.session_id,
                &source.source.source_id,
                generation_seq,
                &cache_root,
            )
            .expect("canonical cache build should succeed");
        manager
            .build_tile_preview_for_generation(
                &created.session_id,
                &source.source.source_id,
                generation_seq,
            )
            .expect("tile/preview build should succeed");
    }

    let data_plane = DataPlaneService::new(&cache_root);
    let mut payloads = Vec::new();
    for generation_seq in &generation_seqs {
        let response = data_plane
            .serve_get(
                &ChunkKey {
                    source_id: source.source.source_id.clone(),
                    generation_seq: *generation_seq,
                    asset_kind: ChunkAssetKind::Tile2d,
                    lod: 0,
                    t: 0,
                    z: 0,
                    channel_block: 0,
                    y: 0,
                    x: 0,
                }
                .format_path(),
            )
            .expect("tile payload should be served");
        assert_eq!(
            response.headers.get("x-lucida-generation-seq"),
            Some(&generation_seq.to_string())
        );
        payloads.push(response.body);
    }

    assert_eq!(generation_seqs, vec![1, 2, 3]);
    assert_ne!(payloads[0], payloads[1]);
    assert_ne!(payloads[1], payloads[2]);

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
    fs::remove_dir_all(&cache_root).expect("cache root cleanup should succeed");
}
