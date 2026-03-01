use std::fs;
use std::path::Path;

use lucida_engine::{AddSourceRequest, SessionManager, validate_generation_layout};

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
