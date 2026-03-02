use std::fs;
use std::path::Path;

use lucida_engine::{
    AddSourceRequest, ChannelBlockPackaging, ChunkAssetKind, ChunkKey, DataPlaneError,
    DataPlaneService, SessionManager,
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

fn write_rgb_tiff(path: &Path, width: u32, height: u32) {
    let file = fs::File::create(path).expect("tiff fixture file should be created");
    let mut encoder =
        tiff::encoder::TiffEncoder::new(file).expect("tiff fixture encoder should be created");
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

fn parse_pgm(payload: &[u8]) -> (u64, u64, u16, Vec<u16>) {
    let mut newline_indices = payload
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b'\n').then_some(index));
    let magic_end = newline_indices
        .next()
        .expect("pgm payload should include magic line");
    let dims_end = newline_indices
        .next()
        .expect("pgm payload should include dimensions line");
    let max_value_end = newline_indices
        .next()
        .expect("pgm payload should include max-value line");

    let magic = std::str::from_utf8(&payload[..magic_end]).expect("pgm magic should be utf-8");
    assert_eq!(magic, "P5");

    let dims = std::str::from_utf8(&payload[(magic_end + 1)..dims_end])
        .expect("pgm dimensions should be utf-8");
    let mut dims_parts = dims.split_ascii_whitespace();
    let width = dims_parts
        .next()
        .expect("pgm dimensions should include width")
        .parse::<u64>()
        .expect("pgm width should parse as u64");
    let height = dims_parts
        .next()
        .expect("pgm dimensions should include height")
        .parse::<u64>()
        .expect("pgm height should parse as u64");

    let max_value = std::str::from_utf8(&payload[(dims_end + 1)..max_value_end])
        .expect("pgm max value should be utf-8");
    let max_value = max_value
        .parse::<u16>()
        .expect("pgm max value should parse as u16");

    let expected_pixel_len = (width as usize)
        .checked_mul(height as usize)
        .expect("pgm dimensions should not overflow");
    let payload_body = &payload[(max_value_end + 1)..];
    let pixels = if max_value <= 255 {
        assert_eq!(
            payload_body.len(),
            expected_pixel_len,
            "8-bit pgm payload length should match declared dimensions"
        );
        payload_body
            .iter()
            .copied()
            .map(u16::from)
            .collect::<Vec<_>>()
    } else {
        assert_eq!(
            payload_body.len(),
            expected_pixel_len * 2,
            "16-bit pgm payload length should match declared dimensions"
        );
        payload_body
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>()
    };
    (width, height, max_value, pixels)
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

#[test]
fn data_plane_service_serves_non_zero_tile_row_and_column_without_collapsing_to_origin() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc301_data_plane_nonzero_fixture_{}_{}",
        std::process::id(),
        1_u64
    ));
    let cache_root = std::env::temp_dir().join(format!(
        "lucida_luc301_data_plane_nonzero_cache_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    fs::create_dir_all(&cache_root).expect("cache root creation should succeed");

    let source_path = fixture_dir.join("dataplane-nonzero-source.tiff");
    write_rgb_tiff(&source_path, 600, 600);

    let mut manager = SessionManager::new();
    let created = manager.create_session("data-plane-nonzero-session");
    let source = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "dataplane-nonzero-source".to_owned(),
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
    manager
        .build_tile_preview_for_generation(
            &created.session_id,
            &source.source.source_id,
            detected.generation_seq,
        )
        .expect("tile preview build should succeed");

    let service = DataPlaneService::new(&cache_root);
    let row_col_response = service
        .serve_get(
            &ChunkKey {
                source_id: source.source.source_id.clone(),
                generation_seq: detected.generation_seq,
                asset_kind: ChunkAssetKind::Tile2d,
                lod: 0,
                t: 0,
                z: 0,
                channel_block: 0,
                y: 1,
                x: 1,
            }
            .format_path(),
        )
        .expect("tile payload for non-zero row/col should be served");
    assert_eq!(row_col_response.status_code, 200);
    assert_eq!(
        row_col_response.headers.get("content-encoding"),
        Some(&"identity".to_owned())
    );
    assert_eq!(
        row_col_response.headers.get("cache-control"),
        Some(&"public, max-age=31536000, immutable".to_owned())
    );
    assert!(row_col_response.headers.contains_key("etag"));

    let origin_response = service
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
        .expect("tile payload for origin tile should be served");
    let packaging = ChannelBlockPackaging::default();
    let non_zero_tile = packaging
        .decode(&row_col_response.body)
        .expect("non-zero tile payload should decode");
    let origin_tile = packaging
        .decode(&origin_response.body)
        .expect("origin tile payload should decode");
    let (non_zero_width, non_zero_height, _, _) = parse_pgm(&non_zero_tile.payload);
    let (origin_width, origin_height, _, _) = parse_pgm(&origin_tile.payload);
    assert_eq!(non_zero_width, 88);
    assert_eq!(non_zero_height, 88);
    assert_eq!(origin_width, 512);
    assert_eq!(origin_height, 512);

    let missing_non_zero = service.serve_get(
        &ChunkKey {
            source_id: source.source.source_id,
            generation_seq: detected.generation_seq,
            asset_kind: ChunkAssetKind::Tile2d,
            lod: 0,
            t: 0,
            z: 0,
            channel_block: 0,
            y: 2,
            x: 0,
        }
        .format_path(),
    );
    assert!(
        matches!(missing_non_zero, Err(DataPlaneError::NotFound { .. })),
        "missing non-zero tile rows/cols should return not found"
    );

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
    fs::remove_dir_all(&cache_root).expect("cache root cleanup should succeed");
}
