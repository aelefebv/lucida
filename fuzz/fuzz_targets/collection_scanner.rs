#![no_main]

use libfuzzer_sys::fuzz_target;
use lucida_store::ingest::collection_scanner::scan_collection_directory;

fuzz_target!(|data: &[u8]| {
    if data.len() > 64 * 1024 {
        return;
    }
    let root = std::env::temp_dir().join(format!(
        "lucida-fuzz-collection-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    if std::fs::create_dir_all(&root).is_err() {
        return;
    }

    // Newline-delimited fuzz bytes become bounded path-safe file names. Seed
    // inputs include valid, duplicate, zero-based, and overflow-like names;
    // mutation explores the scanner's positional arithmetic and error paths.
    for (index, raw) in data.split(|byte| *byte == b'\n').take(32).enumerate() {
        let mut name = String::with_capacity(raw.len().min(96));
        for byte in raw.iter().copied().take(96) {
            let character = if byte.is_ascii_alphanumeric() || b"-_.".contains(&byte) {
                char::from(byte)
            } else {
                '_'
            };
            name.push(character);
        }
        if name.is_empty() {
            name = format!("empty-{index}");
        }
        let _ = std::fs::write(root.join(name), &data[..data.len().min(4096)]);
    }

    let _ = scan_collection_directory(&root, None);
    let _ = std::fs::remove_dir_all(root);
});
