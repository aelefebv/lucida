use std::fs;
use std::path::Path;

use lucida_engine::{AddSourceRequest, SessionManager, validate_generation_layout};

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
fn validator_accepts_generated_s1_layout() {
    let fixture_dir = std::env::temp_dir().join(format!(
        "lucida_luc305_validator_fixture_{}_{}",
        std::process::id(),
        1_u64
    ));
    let cache_root = std::env::temp_dir().join(format!(
        "lucida_luc305_validator_cache_{}_{}",
        std::process::id(),
        1_u64
    ));
    fs::create_dir_all(&fixture_dir).expect("fixture dir creation should succeed");
    fs::create_dir_all(&cache_root).expect("cache root creation should succeed");
    let source_path = fixture_dir.join("validator-source.tiff");
    write_minimal_rgb_tiff(&source_path);

    let mut manager = SessionManager::new();
    let created = manager.create_session("validator-session");
    let source = manager
        .add_source(
            &created.session_id,
            AddSourceRequest {
                name: "validator-source".to_owned(),
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
        .expect("tile/preview build should succeed");
    manager
        .build_bricks_for_generation(
            &created.session_id,
            &source.source.source_id,
            detected.generation_seq,
            0,
            10_000,
        )
        .expect("brick build should succeed");

    let report = validate_generation_layout(
        &cache_root,
        &source.source.source_id,
        detected.generation_seq,
    )
    .expect("validation should succeed");
    assert!(report.valid, "report issues: {:?}", report.issues);

    fs::remove_dir_all(&fixture_dir).expect("fixture cleanup should succeed");
    fs::remove_dir_all(&cache_root).expect("cache root cleanup should succeed");
}
