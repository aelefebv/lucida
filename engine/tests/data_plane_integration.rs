use std::fs;
use std::path::Path;

use lucida_engine::{
    AddSourceRequest, ChunkAssetKind, ChunkKey, DataPlaneError, DataPlaneService, SessionManager,
};

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
    assert_eq!(
        tile_response.headers.get("content-encoding"),
        Some(&"identity".to_owned())
    );
    assert_eq!(
        tile_response.headers.get("cache-control"),
        Some(&"public, max-age=31536000, immutable".to_owned())
    );
    assert!(tile_response.headers.contains_key("etag"));

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
    assert_eq!(
        preview_response.headers.get("content-encoding"),
        Some(&"identity".to_owned())
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
    assert_eq!(
        brick_response.headers.get("content-encoding"),
        Some(&"zstd".to_owned())
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
