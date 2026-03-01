use std::fs;
use std::path::Path;

use lucida_engine::{
    AddSourceRequest, ChunkAssetKind, ChunkKey, DataPlaneError, DataPlaneService, SessionManager,
};

fn write_minimal_rgb_tiff(path: &Path) {
    const TIFF_BYTES: [u8; 62] = [
        0x49, 0x49, 0x2A, 0x00, // II + classic TIFF marker
        0x08, 0x00, 0x00, 0x00, // first IFD offset
        0x04, 0x00, // entry count
        0x00, 0x01, // tag 256 image width
        0x04, 0x00, // type LONG
        0x01, 0x00, 0x00, 0x00, // count
        0x20, 0x00, 0x00, 0x00, // width 32
        0x01, 0x01, // tag 257 image length
        0x04, 0x00, // type LONG
        0x01, 0x00, 0x00, 0x00, // count
        0x10, 0x00, 0x00, 0x00, // height 16
        0x15, 0x01, // tag 277 samples per pixel
        0x03, 0x00, // type SHORT
        0x01, 0x00, 0x00, 0x00, // count
        0x03, 0x00, 0x00, 0x00, // 3 channels
        0x02, 0x01, // tag 258 bits per sample
        0x03, 0x00, // type SHORT
        0x01, 0x00, 0x00, 0x00, // count
        0x08, 0x00, 0x00, 0x00, // 8 bits
        0x00, 0x00, 0x00, 0x00, // next IFD offset
    ];
    fs::write(path, TIFF_BYTES).expect("TIFF fixture write should succeed");
}

#[test]
fn data_plane_service_serves_tile_preview_and_brick_payloads_by_generation() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc301_data_plane_fixture_{}_{}",
        std::process::id(),
        1_u64
    ));
    let cache_root = std::env::temp_dir().join(format!(
        "lucida_luc301_data_plane_cache_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    fs::create_dir_all(&cache_root).expect("cache root creation should succeed");

    let source_path = fixture_dir.join("dataplane-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("data-plane-session");
    let source = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "dataplane-source".to_owned(),
                uri: source_path.display().to_string(),
            },
        )
        .expect("source add should succeed");
    let detected = manager
        .detect_generation(&created.session_id, &source.source.source_id)
        .expect("generation detection should succeed");
    manager
        .start_generation(
            &created.session_id,
            &source.source.source_id,
            detected.generation_seq,
        )
        .expect("generation start should succeed");
    manager
        .build_canonical_cache_for_generation(
            &created.session_id,
            &source.source.source_id,
            detected.generation_seq,
            &cache_root,
        )
        .expect("canonical cache build should succeed");
    let tile_preview = manager
        .build_tile_preview_for_generation(
            &created.session_id,
            &source.source.source_id,
            detected.generation_seq,
        )
        .expect("tile preview build should succeed");
    manager
        .build_bricks_for_generation(
            &created.session_id,
            &source.source.source_id,
            detected.generation_seq,
            0,
            10_000,
        )
        .expect("brick build should succeed");

    let preview_lod = *tile_preview
        .availability
        .tile2d_ready_lods
        .iter()
        .max()
        .expect("preview lod should be available");
    let service = DataPlaneService::new(&cache_root);

    let tile_response = service
        .serve_get(
            &ChunkKey {
                source_id: source.source.source_id.clone(),
                generation_seq: detected.generation_seq,
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
    assert_eq!(tile_response.status_code, 200);
    assert!(!tile_response.body.is_empty());

    let preview_response = service
        .serve_get(
            &ChunkKey {
                source_id: source.source.source_id.clone(),
                generation_seq: detected.generation_seq,
                asset_kind: ChunkAssetKind::Preview2d,
                lod: preview_lod,
                t: 0,
                z: 0,
                channel_block: 0,
                y: 0,
                x: 0,
            }
            .format_path(),
        )
        .expect("preview payload should be served");
    assert_eq!(
        preview_response.headers.get("content-type"),
        Some(&"image/x-portable-graymap".to_owned())
    );

    let brick_response = service
        .serve_get(
            &ChunkKey {
                source_id: source.source.source_id.clone(),
                generation_seq: detected.generation_seq,
                asset_kind: ChunkAssetKind::Brick3d,
                lod: 0,
                t: 0,
                z: 0,
                channel_block: 0,
                y: 0,
                x: 0,
            }
            .format_path(),
        )
        .expect("brick payload should be served");
    assert_eq!(
        brick_response.headers.get("content-type"),
        Some(&"application/octet-stream".to_owned())
    );

    let missing = service.serve_get(
        &ChunkKey {
            source_id: source.source.source_id,
            generation_seq: detected.generation_seq + 5,
            asset_kind: ChunkAssetKind::Tile2d,
            lod: 0,
            t: 0,
            z: 0,
            channel_block: 0,
            y: 0,
            x: 0,
        }
        .format_path(),
    );
    assert!(matches!(missing, Err(DataPlaneError::NotFound { .. })));

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
    fs::remove_dir_all(&cache_root).expect("cache root cleanup should succeed");
}
