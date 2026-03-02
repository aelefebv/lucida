// file-path startup validation
use std::path::PathBuf;

use server::config::{DEFAULT_PORT, StartupArgs, validate_startup_file_path};


#[test]
fn rejects_missing_startup_file_path() {
    let args = StartupArgs {
        file: PathBuf::from("/definitely/not/a/real/file.ome.zarr"),
        port: DEFAULT_PORT,
    };
    
    let result = validate_startup_file_path(&args);
    
    assert!(result.is_err());
}


#[test]
fn accepts_existing_startup_file_path() {
    let temp = tempfile::NamedTempFile::new().expect("should create temp file");

    let args = StartupArgs {
        file: temp.path().to_path_buf(),
        port: DEFAULT_PORT,
    };

    let result = validate_startup_file_path(&args);

    assert!(result.is_ok());
}
