mod support;

use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use lucida_daemon::{app_with_state, state::new_shared_state};
use serde_json::{json, Value};
use support::{create_sample_omezarr, SampleDatasetOptions};
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn export_viewstate_success_and_session_guards() {
    let router = app_with_state(new_shared_state());
    let dataset_path = unique_dataset_path("export-import-export");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let session_id = create_session(&router).await;
    let dataset_id = open_dataset(&router, &dataset_path, Some(&session_id)).await;
    let view_id = create_view(&router, &dataset_id, Some(&session_id)).await;

    let exported = request_json(
        &router,
        "POST",
        "/export/viewstate",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "session_id": session_id,
        }),
    )
    .await;
    assert_eq!(exported.status(), StatusCode::OK);
    let exported_payload = read_json_body(exported).await;
    assert_eq!(exported_payload["schema_version"], 1);
    assert!(exported_payload["export_id"]
        .as_str()
        .expect("export_id")
        .starts_with("exp_"));
    assert_eq!(exported_payload["source_view_id"], view_id);
    assert_eq!(exported_payload["view_state"]["view_id"], view_id);
    assert!(exported_payload["warnings"]
        .as_array()
        .expect("warnings")
        .is_empty());

    let unknown_session = request_json(
        &router,
        "POST",
        "/export/viewstate",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "session_id": "session_missing",
        }),
    )
    .await;
    assert_eq!(unknown_session.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json_body(unknown_session).await["code"],
        "session_not_found"
    );

    let other_session_id = create_session(&router).await;
    let wrong_session = request_json(
        &router,
        "POST",
        "/export/viewstate",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "session_id": other_session_id,
        }),
    )
    .await;
    assert_eq!(wrong_session.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json_body(wrong_session).await["code"],
        "view_not_found"
    );
}

#[tokio::test]
async fn import_viewstate_rebases_identity_and_attaches_dataset() {
    let state = new_shared_state();
    let router = app_with_state(state.clone());
    let dataset_path = unique_dataset_path("export-import-import");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let source_session_id = create_session(&router).await;
    let dataset_id = open_dataset(&router, &dataset_path, Some(&source_session_id)).await;
    let source_view_id = create_view(&router, &dataset_id, Some(&source_session_id)).await;
    let exported_payload = read_json_body(
        request_json(
            &router,
            "POST",
            "/export/viewstate",
            json!({
                "schema_version": 1,
                "view_id": source_view_id,
                "session_id": source_session_id,
            }),
        )
        .await,
    )
    .await;

    let imported_same = request_json(
        &router,
        "POST",
        "/import/viewstate",
        json!({
            "schema_version": 1,
            "session_id": source_session_id,
            "view_state": exported_payload["view_state"],
        }),
    )
    .await;
    assert_eq!(imported_same.status(), StatusCode::OK);
    let imported_same_payload = read_json_body(imported_same).await;
    assert!(imported_same_payload["import_id"]
        .as_str()
        .expect("import_id")
        .starts_with("imp_"));
    assert_eq!(
        imported_same_payload["imported_from_view_id"],
        source_view_id
    );
    assert_ne!(
        imported_same_payload["view_state"]["view_id"],
        source_view_id
    );
    assert_eq!(
        imported_same_payload["view_state"]["session_id"],
        source_session_id
    );
    assert_eq!(imported_same_payload["view_state"]["state_version"], 0);
    assert!(
        imported_same_payload["view_state"]["state_hash"]
            .as_str()
            .expect("state_hash")
            .len()
            > 8
    );
    assert!(!imported_same_payload["selectors_applied"]
        .as_array()
        .expect("selectors_applied")
        .is_empty());

    let target_session_id = create_session(&router).await;
    let imported_scoped = request_json(
        &router,
        "POST",
        "/import/viewstate",
        json!({
            "schema_version": 1,
            "session_id": target_session_id,
            "view_state": exported_payload["view_state"],
        }),
    )
    .await;
    assert_eq!(imported_scoped.status(), StatusCode::OK);
    let imported_scoped_payload = read_json_body(imported_scoped).await;
    assert_eq!(
        imported_scoped_payload["view_state"]["session_id"],
        target_session_id
    );

    let imported_compat = request_json(
        &router,
        "POST",
        "/import/viewstate",
        json!({
            "schema_version": 1,
            "view_state": exported_payload["view_state"],
        }),
    )
    .await;
    assert_eq!(imported_compat.status(), StatusCode::OK);
    let imported_compat_payload = read_json_body(imported_compat).await;
    let compat_session_id = imported_compat_payload["view_state"]["session_id"]
        .as_str()
        .expect("compat session");
    assert!(compat_session_id.starts_with("compat_"));

    let app_state = state.read().await;
    let target_session = app_state
        .sessions_by_id
        .get(
            imported_scoped_payload["view_state"]["session_id"]
                .as_str()
                .expect("target session"),
        )
        .expect("target session exists");
    assert!(target_session.dataset_ids.contains(&dataset_id));
}

#[tokio::test]
async fn import_viewstate_error_contracts() {
    let router = app_with_state(new_shared_state());
    let dataset_path = unique_dataset_path("export-import-errors");
    create_sample_omezarr(&dataset_path, SampleDatasetOptions::default());

    let session_id = create_session(&router).await;
    let dataset_id = open_dataset(&router, &dataset_path, Some(&session_id)).await;
    let source_view_id = create_view(&router, &dataset_id, Some(&session_id)).await;
    let exported_payload = read_json_body(
        request_json(
            &router,
            "POST",
            "/export/viewstate",
            json!({
                "schema_version": 1,
                "view_id": source_view_id,
                "session_id": session_id,
            }),
        )
        .await,
    )
    .await;
    let source_view_state = exported_payload["view_state"].clone();

    let mut missing_dataset_state = source_view_state.clone();
    missing_dataset_state["datasets"][0]["dataset_id"] = json!("ds_missing");
    if let Some(layers) = missing_dataset_state["layers"].as_array_mut() {
        for layer in layers {
            if layer.get("dataset_id").and_then(Value::as_str).is_some() {
                layer["dataset_id"] = json!("ds_missing");
            }
        }
    }
    let missing_dataset = request_json(
        &router,
        "POST",
        "/import/viewstate",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_state": missing_dataset_state,
        }),
    )
    .await;
    assert_eq!(missing_dataset.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        read_json_body(missing_dataset).await["code"],
        "dataset_not_found"
    );

    let mut unsupported_mode_state = source_view_state.clone();
    unsupported_mode_state["mode"] = json!("3d");
    unsupported_mode_state["view_3d"] = json!({});
    let unsupported_mode = request_json(
        &router,
        "POST",
        "/import/viewstate",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_state": unsupported_mode_state,
        }),
    )
    .await;
    assert_eq!(unsupported_mode.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        read_json_body(unsupported_mode).await["code"],
        "unsupported_mode"
    );

    let mut multi_dataset_state = source_view_state.clone();
    let duplicate_dataset_ref = multi_dataset_state["datasets"][0].clone();
    let datasets = multi_dataset_state["datasets"]
        .as_array_mut()
        .expect("datasets array");
    datasets.push(duplicate_dataset_ref);
    let multi_dataset = request_json(
        &router,
        "POST",
        "/import/viewstate",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_state": multi_dataset_state,
        }),
    )
    .await;
    assert_eq!(multi_dataset.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        read_json_body(multi_dataset).await["code"],
        "invalid_viewstate_import"
    );

    let mut layer_mismatch_state = source_view_state;
    layer_mismatch_state["layers"][0]["dataset_id"] = json!("ds_other");
    let layer_mismatch = request_json(
        &router,
        "POST",
        "/import/viewstate",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "view_state": layer_mismatch_state,
        }),
    )
    .await;
    assert_eq!(layer_mismatch.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        read_json_body(layer_mismatch).await["code"],
        "invalid_viewstate_import"
    );
}

async fn create_session<S>(router: &S) -> String
where
    S: tower::Service<Request<Body>, Response = axum::response::Response> + Clone,
    S::Error: std::fmt::Debug,
    S::Future: Send,
{
    let response = request_json(
        router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    read_json_body(response).await["session_id"]
        .as_str()
        .expect("session_id")
        .to_owned()
}

async fn open_dataset<S>(router: &S, dataset_path: &PathBuf, session_id: Option<&str>) -> String
where
    S: tower::Service<Request<Body>, Response = axum::response::Response> + Clone,
    S::Error: std::fmt::Debug,
    S::Future: Send,
{
    let mut payload = json!({
        "schema_version": 1,
        "uri": dataset_path.to_string_lossy(),
    });
    if let Some(session_id) = session_id {
        payload["session_id"] = json!(session_id);
    }
    let response = request_json(router, "POST", "/dataset/open", payload).await;
    assert_eq!(response.status(), StatusCode::OK);
    read_json_body(response).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id")
        .to_owned()
}

async fn create_view<S>(router: &S, dataset_id: &str, session_id: Option<&str>) -> String
where
    S: tower::Service<Request<Body>, Response = axum::response::Response> + Clone,
    S::Error: std::fmt::Debug,
    S::Future: Send,
{
    let mut payload = json!({
        "schema_version": 1,
        "dataset_id": dataset_id,
        "mode": "2d",
    });
    if let Some(session_id) = session_id {
        payload["session_id"] = json!(session_id);
    }
    let response = request_json(router, "POST", "/view/create", payload).await;
    assert_eq!(response.status(), StatusCode::OK);
    read_json_body(response).await["view_state"]["view_id"]
        .as_str()
        .expect("view_id")
        .to_owned()
}

async fn request_json<S>(
    router: &S,
    method: &str,
    uri: &str,
    body: Value,
) -> axum::response::Response
where
    S: tower::Service<Request<Body>, Response = axum::response::Response> + Clone,
    S::Error: std::fmt::Debug,
    S::Future: Send,
{
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&body).expect("serialize body"),
        ))
        .expect("request");
    router.clone().oneshot(request).await.expect("response")
}

async fn read_json_body(response: axum::response::Response) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("collect response body")
        .to_bytes();
    serde_json::from_slice::<Value>(&bytes).expect("json response")
}

fn unique_dataset_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "lucida-daemon-{prefix}-{}",
        Uuid::new_v4().simple()
    ))
}
