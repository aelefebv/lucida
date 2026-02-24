mod support;

use std::fs;
use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use lucida_daemon::app;
use lucida_daemon::uri::{generate_dataset_id, normalize_uri};
use serde_json::{json, Value};
use support::{create_invalid_zarr, create_sample_omezarr, SampleDatasetOptions};
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn dataset_open_success_matches_contract_shape() {
    let dataset_path = unique_dataset_path("dataset-open-success");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let response = request_json(
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let payload = read_json_body(response).await;
    let dataset_summary = &payload["dataset_summary"];
    let normalized_uri = normalize_uri(dataset_path.to_string_lossy().as_ref());
    assert_eq!(dataset_summary["uri"], normalized_uri);
    assert_eq!(
        dataset_summary["dataset_id"],
        generate_dataset_id(&normalized_uri)
    );
    assert_eq!(dataset_summary["dtype"], "uint16");
    assert_eq!(dataset_summary["shape"], json!([1, 2, 4, 8, 10]));
    assert_eq!(dataset_summary["multiscales"][0]["levels"][0]["path"], "0");
    assert_eq!(payload["warnings"], json!([]));
}

#[tokio::test]
async fn dataset_open_invalid_metadata_returns_invalid_omezarr() {
    let dataset_path = unique_dataset_path("dataset-open-invalid");
    create_invalid_zarr(&dataset_path);

    let response = request_json(
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let payload = read_json_body(response).await;
    assert_eq!(payload["code"], "invalid_omezarr");
    assert_eq!(
        payload["message"],
        "Dataset is missing required OME-Zarr multiscales metadata."
    );
}

#[tokio::test]
async fn dataset_open_invalid_request_empty_dataset_id_returns_invalid_request() {
    let dataset_path = unique_dataset_path("dataset-open-invalid-request");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let response = request_json(
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "dataset_id": "",
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let payload = read_json_body(response).await;
    assert_eq!(payload["code"], "invalid_request");
    assert_eq!(payload["message"], "Request validation failed.");
    assert!(payload.get("details").is_some());
}

#[tokio::test]
async fn dataset_open_unknown_session_returns_not_found() {
    let dataset_path = unique_dataset_path("dataset-open-unknown-session");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let response = request_json(
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "session_id": "session_missing",
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let payload = read_json_body(response).await;
    assert_eq!(payload["code"], "session_not_found");
    assert_eq!(payload["message"], "Session was not found.");
}

#[tokio::test]
async fn dataset_open_tolerant_metadata_emits_warnings() {
    let dataset_path = unique_dataset_path("dataset-open-tolerant");
    create_sample_omezarr(
        &dataset_path,
        SampleDatasetOptions {
            include_multiscale_name: false,
            include_level_one_scale: false,
            include_channel_indices: false,
            extra_root_attrs: serde_json::Map::new(),
        },
    );

    let response = request_json(
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let payload = read_json_body(response).await;
    let warning_codes = payload["warnings"]
        .as_array()
        .expect("warnings array")
        .iter()
        .filter_map(|item| item.get("code").and_then(Value::as_str))
        .collect::<Vec<&str>>();
    assert!(warning_codes.contains(&"multiscale_name_inferred"));
    assert!(warning_codes.contains(&"downsample_factors_inferred"));
    assert!(warning_codes.contains(&"channel_index_inferred"));
}

#[tokio::test]
async fn dataset_open_raw_metadata_policy_curated_and_full() {
    let dataset_path = unique_dataset_path("dataset-open-raw-policy");
    let mut extra_root_attrs = serde_json::Map::new();
    extra_root_attrs.insert("custom_attr".to_owned(), json!("present"));
    create_sample_omezarr(
        &dataset_path,
        SampleDatasetOptions {
            include_multiscale_name: true,
            include_level_one_scale: true,
            include_channel_indices: true,
            extra_root_attrs,
        },
    );

    let curated_response = request_json(
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "include_full_raw_metadata": false,
        }),
    )
    .await;
    assert_eq!(curated_response.status(), StatusCode::OK);
    let curated_payload = read_json_body(curated_response).await;
    let curated_root = &curated_payload["dataset_summary"]["raw_metadata"]["root"];
    assert!(curated_root.get("multiscales").is_some());
    assert!(curated_root.get("omero").is_some());
    assert!(curated_root.get("custom_attr").is_none());

    let full_response = request_json(
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "include_full_raw_metadata": true,
        }),
    )
    .await;
    assert_eq!(full_response.status(), StatusCode::OK);
    let full_payload = read_json_body(full_response).await;
    let full_root = &full_payload["dataset_summary"]["raw_metadata"]["root"];
    assert_eq!(full_root["custom_attr"], "present");
}

async fn request_json(method: &str, path: &str, payload: Value) -> axum::response::Response {
    app()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .expect("valid request"),
        )
        .await
        .expect("response")
}

async fn read_json_body(response: axum::response::Response) -> Value {
    let body_bytes = response
        .into_body()
        .collect()
        .await
        .expect("read body")
        .to_bytes();
    serde_json::from_slice(&body_bytes).expect("json")
}

fn unique_dataset_path(name: &str) -> PathBuf {
    let path = std::env::temp_dir()
        .join("lucida-daemon-tests")
        .join(format!("{name}-{}", Uuid::new_v4().simple()));
    if path.exists() {
        fs::remove_dir_all(&path).expect("cleanup old directory");
    }
    path
}
