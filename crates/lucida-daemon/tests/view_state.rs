mod support;

use std::fs;
use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use lucida_daemon::app;
use serde_json::{json, Value};
use support::{create_sample_omezarr, SampleDatasetOptions};
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn session_create_returns_unique_ids() {
    let router = app();
    let first = request_json(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
    )
    .await;
    assert_eq!(first.status(), StatusCode::OK);
    let first_payload = read_json_body(first).await;

    let second = request_json(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
    )
    .await;
    assert_eq!(second.status(), StatusCode::OK);
    let second_payload = read_json_body(second).await;

    assert_eq!(first_payload["schema_version"], 1);
    assert_eq!(second_payload["schema_version"], 1);
    assert_ne!(first_payload["session_id"], second_payload["session_id"]);
    assert!(first_payload["created_at"].as_str().is_some());
    assert!(second_payload["created_at"].as_str().is_some());
}

#[tokio::test]
async fn view_end_to_end_create_update_get() {
    let router = app();
    let dataset_path = unique_dataset_path("view-state-e2e");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let session = request_json(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
    )
    .await;
    assert_eq!(session.status(), StatusCode::OK);
    let session_payload = read_json_body(session).await;
    let session_id = session_payload["session_id"].as_str().expect("session_id");

    let opened = request_json(
        &router,
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "session_id": session_id,
        }),
    )
    .await;
    assert_eq!(opened.status(), StatusCode::OK);
    let opened_payload = read_json_body(opened).await;
    let dataset_id = opened_payload["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id");

    let created = request_json(
        &router,
        "POST",
        "/view/create",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "dataset_id": dataset_id,
            "mode": "2d",
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let create_payload = read_json_body(created).await;
    let view_id = create_payload["view_state"]["view_id"]
        .as_str()
        .expect("view_id");
    let first_hash = create_payload["view_state"]["state_hash"]
        .as_str()
        .expect("state_hash")
        .to_owned();

    let updated = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 2, "clamp": true}],
                }
            ],
        }),
    )
    .await;
    assert_eq!(updated.status(), StatusCode::OK);
    let update_payload = read_json_body(updated).await;
    assert_eq!(update_payload["view_state"]["state_version"], 1);
    assert_ne!(update_payload["view_state"]["state_hash"], first_hash);
    assert_eq!(update_payload["selectors_applied"][0]["index"], 2);

    let fetched = request_get(
        &router,
        &format!("/view/{view_id}"),
        Some(&[("session_id", session_id)]),
    )
    .await;
    assert_eq!(fetched.status(), StatusCode::OK);
    let fetched_payload = read_json_body(fetched).await;
    assert_eq!(fetched_payload["view_state"]["view_id"], view_id);
    assert_eq!(fetched_payload["view_state"]["state_version"], 1);
}

#[tokio::test]
async fn view_update_expected_state_version_conflict() {
    let router = app();
    let dataset_path = unique_dataset_path("view-state-conflict");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let opened = request_json(
        &router,
        "POST",
        "/dataset/open",
        json!({"schema_version": 1, "uri": dataset_path.to_string_lossy()}),
    )
    .await;
    assert_eq!(opened.status(), StatusCode::OK);
    let dataset_id = read_json_body(opened).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id")
        .to_owned();

    let created = request_json(
        &router,
        "POST",
        "/view/create",
        json!({"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let view_id = read_json_body(created).await["view_state"]["view_id"]
        .as_str()
        .expect("view_id")
        .to_owned();

    let first_update = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "expected_state_version": 0,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 1, "clamp": true}],
                }
            ],
        }),
    )
    .await;
    assert_eq!(first_update.status(), StatusCode::OK);

    let conflict_update = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "expected_state_version": 0,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 2, "clamp": true}],
                }
            ],
        }),
    )
    .await;
    assert_eq!(conflict_update.status(), StatusCode::CONFLICT);
    let payload = read_json_body(conflict_update).await;
    assert_eq!(payload["code"], "state_conflict");
    assert_eq!(payload["details"]["expected_state_version"], 0);
    assert_eq!(payload["details"]["actual_state_version"], 1);
}

#[tokio::test]
async fn view_create_unknown_dataset_error() {
    let router = app();
    let response = request_json(
        &router,
        "POST",
        "/view/create",
        json!({
            "schema_version": 1,
            "dataset_id": "ds_missing",
            "mode": "2d",
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let payload = read_json_body(response).await;
    assert_eq!(payload["code"], "dataset_not_found");
}

#[tokio::test]
async fn view_create_unsupported_mode_error() {
    let router = app();
    let dataset_path = unique_dataset_path("view-create-unsupported");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let opened = request_json(
        &router,
        "POST",
        "/dataset/open",
        json!({"schema_version": 1, "uri": dataset_path.to_string_lossy()}),
    )
    .await;
    assert_eq!(opened.status(), StatusCode::OK);
    let opened_payload = read_json_body(opened).await;
    let dataset_id = opened_payload["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id");

    let response = request_json(
        &router,
        "POST",
        "/view/create",
        json!({
            "schema_version": 1,
            "dataset_id": dataset_id,
            "mode": "3d",
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let payload = read_json_body(response).await;
    assert_eq!(payload["code"], "unsupported_mode");
}

#[tokio::test]
async fn selector_clamp_and_strict_modes() {
    let router = app();
    let dataset_path = unique_dataset_path("selector-clamp");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let session = request_json(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
    )
    .await;
    assert_eq!(session.status(), StatusCode::OK);
    let session_payload = read_json_body(session).await;
    let session_id = session_payload["session_id"].as_str().expect("session_id");

    let opened = request_json(
        &router,
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "session_id": session_id,
        }),
    )
    .await;
    assert_eq!(opened.status(), StatusCode::OK);
    let dataset_id = read_json_body(opened).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id")
        .to_owned();

    let created = request_json(
        &router,
        "POST",
        "/view/create",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "dataset_id": dataset_id,
            "mode": "2d",
        }),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let view_id = read_json_body(created).await["view_state"]["view_id"]
        .as_str()
        .expect("view_id")
        .to_owned();

    let index_clamped = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 999, "clamp": true}],
                }
            ],
        }),
    )
    .await;
    assert_eq!(index_clamped.status(), StatusCode::OK);
    let index_payload = read_json_body(index_clamped).await;
    assert_eq!(index_payload["selectors_applied"][0]["index"], 3);

    let range_clamped = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "range", "start": 100, "end_exclusive": 200, "clamp": true}],
                }
            ],
        }),
    )
    .await;
    assert_eq!(range_clamped.status(), StatusCode::OK);
    let range_payload = read_json_body(range_clamped).await;
    assert_eq!(range_payload["selectors_applied"][0]["start"], 3);
    assert_eq!(range_payload["selectors_applied"][0]["end_exclusive"], 4);

    let set_clamped = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "set", "indices": [-1, 2, 200, 2], "clamp": true}],
                }
            ],
        }),
    )
    .await;
    assert_eq!(set_clamped.status(), StatusCode::OK);
    let set_payload = read_json_body(set_clamped).await;
    assert_eq!(
        set_payload["selectors_applied"][0]["indices"],
        json!([0, 2, 3])
    );

    let strict_index = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "index", "index": 999, "clamp": false}],
                }
            ],
        }),
    )
    .await;
    assert_eq!(strict_index.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        read_json_body(strict_index).await["code"],
        "selector_out_of_bounds"
    );

    let strict_range = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "range", "start": 5, "end_exclusive": 6, "clamp": false}],
                }
            ],
        }),
    )
    .await;
    assert_eq!(strict_range.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        read_json_body(strict_range).await["code"],
        "selector_out_of_bounds"
    );

    let strict_set = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [{"axis": "z", "kind": "set", "indices": [999], "clamp": false}],
                }
            ],
        }),
    )
    .await;
    assert_eq!(strict_set.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        read_json_body(strict_set).await["code"],
        "selector_out_of_bounds"
    );
}

#[tokio::test]
async fn view_update_invalid_patch_error() {
    let router = app();
    let dataset_path = unique_dataset_path("view-update-invalid-patch");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let opened = request_json(
        &router,
        "POST",
        "/dataset/open",
        json!({"schema_version": 1, "uri": dataset_path.to_string_lossy()}),
    )
    .await;
    assert_eq!(opened.status(), StatusCode::OK);
    let dataset_id = read_json_body(opened).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id")
        .to_owned();

    let created = request_json(
        &router,
        "POST",
        "/view/create",
        json!({"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let view_id = read_json_body(created).await["view_state"]["view_id"]
        .as_str()
        .expect("view_id")
        .to_owned();

    let response = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "patch": [{"op": "replace", "path": "/selectors/100/index", "value": 1}],
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let payload = read_json_body(response).await;
    assert_eq!(payload["code"], "invalid_patch");
}

#[tokio::test]
async fn duplicate_selector_axes_are_rejected() {
    let router = app();
    let dataset_path = unique_dataset_path("view-duplicate-selectors");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let opened = request_json(
        &router,
        "POST",
        "/dataset/open",
        json!({"schema_version": 1, "uri": dataset_path.to_string_lossy()}),
    )
    .await;
    assert_eq!(opened.status(), StatusCode::OK);
    let dataset_id = read_json_body(opened).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id")
        .to_owned();

    let created = request_json(
        &router,
        "POST",
        "/view/create",
        json!({"schema_version": 1, "dataset_id": dataset_id, "mode": "2d"}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let view_id = read_json_body(created).await["view_state"]["view_id"]
        .as_str()
        .expect("view_id")
        .to_owned();

    let response = request_json(
        &router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "patch": [
                {
                    "op": "replace",
                    "path": "/selectors",
                    "value": [
                        {"axis": "z", "kind": "index", "index": 1, "clamp": true},
                        {"axis": "z", "kind": "index", "index": 2, "clamp": true}
                    ],
                }
            ],
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let payload = read_json_body(response).await;
    assert_eq!(payload["code"], "selector_out_of_bounds");
    assert_eq!(payload["details"]["axis"], "z");
}

#[tokio::test]
async fn session_list_returns_active_sessions() {
    let router = app();

    let first = request_json(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
    )
    .await;
    assert_eq!(first.status(), StatusCode::OK);
    let first_session_id = read_json_body(first).await["session_id"]
        .as_str()
        .expect("first session_id")
        .to_owned();

    let second = request_json(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
    )
    .await;
    assert_eq!(second.status(), StatusCode::OK);
    let second_session_id = read_json_body(second).await["session_id"]
        .as_str()
        .expect("second session_id")
        .to_owned();

    let listed = request_get(&router, "/session/list", None).await;
    assert_eq!(listed.status(), StatusCode::OK);
    let payload = read_json_body(listed).await;
    assert_eq!(payload["schema_version"], 1);
    let sessions = payload["sessions"].as_array().expect("sessions array");
    assert!(sessions
        .iter()
        .any(|item| item["session_id"] == first_session_id));
    assert!(sessions
        .iter()
        .any(|item| item["session_id"] == second_session_id));
}

#[tokio::test]
async fn view_list_returns_active_views_and_supports_session_filter() {
    let router = app();
    let dataset_path = unique_dataset_path("view-list-filter");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let session_one = request_json(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
    )
    .await;
    assert_eq!(session_one.status(), StatusCode::OK);
    let session_one_id = read_json_body(session_one).await["session_id"]
        .as_str()
        .expect("session one id")
        .to_owned();

    let session_two = request_json(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
    )
    .await;
    assert_eq!(session_two.status(), StatusCode::OK);
    let session_two_id = read_json_body(session_two).await["session_id"]
        .as_str()
        .expect("session two id")
        .to_owned();

    let opened_one = request_json(
        &router,
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "session_id": session_one_id,
        }),
    )
    .await;
    assert_eq!(opened_one.status(), StatusCode::OK);
    let dataset_id = read_json_body(opened_one).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id")
        .to_owned();

    let opened_two = request_json(
        &router,
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "session_id": session_two_id,
        }),
    )
    .await;
    assert_eq!(opened_two.status(), StatusCode::OK);

    let created_one = request_json(
        &router,
        "POST",
        "/view/create",
        json!({
            "schema_version": 1,
            "session_id": session_one_id,
            "dataset_id": dataset_id,
            "mode": "2d",
        }),
    )
    .await;
    assert_eq!(created_one.status(), StatusCode::OK);
    let view_one_id = read_json_body(created_one).await["view_state"]["view_id"]
        .as_str()
        .expect("view one id")
        .to_owned();

    let created_two = request_json(
        &router,
        "POST",
        "/view/create",
        json!({
            "schema_version": 1,
            "session_id": session_two_id,
            "dataset_id": dataset_id,
            "mode": "2d",
        }),
    )
    .await;
    assert_eq!(created_two.status(), StatusCode::OK);
    let view_two_id = read_json_body(created_two).await["view_state"]["view_id"]
        .as_str()
        .expect("view two id")
        .to_owned();

    let listed = request_get(&router, "/view/list", None).await;
    assert_eq!(listed.status(), StatusCode::OK);
    let listed_payload = read_json_body(listed).await;
    let views = listed_payload["views"].as_array().expect("views array");
    assert!(views.iter().any(|item| item["view_id"] == view_one_id));
    assert!(views.iter().any(|item| item["view_id"] == view_two_id));

    let filtered = request_get(
        &router,
        "/view/list",
        Some(&[("session_id", session_one_id.as_str())]),
    )
    .await;
    assert_eq!(filtered.status(), StatusCode::OK);
    let filtered_payload = read_json_body(filtered).await;
    let filtered_views = filtered_payload["views"]
        .as_array()
        .expect("filtered views");
    assert!(filtered_views
        .iter()
        .all(|item| item["session_id"] == session_one_id));
    assert!(filtered_views
        .iter()
        .any(|item| item["view_id"] == view_one_id));
    assert!(!filtered_views
        .iter()
        .any(|item| item["view_id"] == view_two_id));

    let missing_session = request_get(
        &router,
        "/view/list",
        Some(&[("session_id", "session_missing")]),
    )
    .await;
    assert_eq!(missing_session.status(), StatusCode::NOT_FOUND);
}

async fn request_json(
    router: &axum::Router,
    method: &str,
    path: &str,
    payload: Value,
) -> axum::response::Response {
    router
        .clone()
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

async fn request_get(
    router: &axum::Router,
    path: &str,
    params: Option<&[(&str, &str)]>,
) -> axum::response::Response {
    let uri = if let Some(params) = params {
        let query = params
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<String>>()
            .join("&");
        format!("{path}?{query}")
    } else {
        path.to_owned()
    };

    router
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
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
