use lucida_daemon::uri::{generate_dataset_id, is_remote_uri, normalize_uri};

#[test]
fn normalize_uri_local_path_and_file_uri_match_python_contract() {
    let local = normalize_uri("./tmp/../tmp/sample.zarr");
    assert!(local.starts_with("file://"));
    assert!(local.ends_with("/tmp/sample.zarr"));

    let file_uri = normalize_uri("file:///tmp/sample.zarr");
    assert_eq!(file_uri, "file:///tmp/sample.zarr");
}

#[test]
fn generate_dataset_id_matches_sha256_prefix_contract() {
    let dataset_id = generate_dataset_id("file:///tmp/lucida/sample.zarr");
    assert_eq!(dataset_id, "ds_05cd8452bb88f5e5");
}

#[test]
fn remote_uri_detection_matches_python_contract() {
    assert!(!is_remote_uri("file:///tmp/sample.zarr"));
    assert!(!is_remote_uri("/tmp/sample.zarr"));
    assert!(is_remote_uri("s3://bucket/sample.zarr"));
}
