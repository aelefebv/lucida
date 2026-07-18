#![no_main]

use libfuzzer_sys::fuzz_target;
use lucida_store::ingest::tiff_reader::{DimensionHints, read_tiff};

fuzz_target!(|data: &[u8]| {
    // The production source boundary is capped much higher; this harness cap
    // keeps a pull-request smoke run focused on parser/layout state space.
    if data.len() > 1 << 20 {
        return;
    }
    let path = std::env::temp_dir().join(format!(
        "lucida-fuzz-tiff-{}.tiff",
        std::process::id()
    ));
    if std::fs::write(&path, data).is_ok() {
        let _ = read_tiff(&path, &DimensionHints::default());
        let _ = std::fs::remove_file(path);
    }
});
