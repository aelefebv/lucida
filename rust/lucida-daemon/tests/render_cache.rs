mod support;

use std::fs;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use lucida_daemon::app_with_state;
use lucida_daemon::render_cache::{DEFAULT_CPU_CACHE_BYTES, DEFAULT_GPU_CACHE_BYTES};
use lucida_daemon::state::{new_shared_state, SharedAppState};
use serde_json::{json, Value};
use support::create_render_omezarr;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn render_cache_respects_budget_and_records_hits() {
    let state = new_shared_state();
    let router = app_with_state(state.clone());
    let dataset_path = unique_dataset_path("cache-hits");
    create_render_omezarr(&dataset_path);

    let session_id = create_session(&router).await;
    let (_dataset_id, view_id) = open_view_for_session(&router, &dataset_path, &session_id).await;
    set_view_performance_budget(&router, &view_id, 4_096, None).await;

    let first = render_inline(&router, &view_id).await;
    assert_eq!(first.status(), StatusCode::OK);
    let second = render_inline(&router, &view_id).await;
    assert_eq!(second.status(), StatusCode::OK);

    let snapshot = session_cache_snapshot(&state, &session_id)
        .await
        .expect("cache snapshot");
    assert_eq!(snapshot.cpu.max_bytes, 4_096);
    assert!(snapshot.cpu.current_bytes <= snapshot.cpu.max_bytes);
    assert!(snapshot.cpu.misses > 0);
    assert!(snapshot.cpu.hits > 0);
    assert_eq!(snapshot.gpu.max_bytes, DEFAULT_GPU_CACHE_BYTES);
}

#[tokio::test]
async fn render_cache_is_isolated_per_session() {
    let state = new_shared_state();
    let router = app_with_state(state.clone());
    let dataset_path = unique_dataset_path("cache-isolation");
    create_render_omezarr(&dataset_path);

    let session_a = create_session(&router).await;
    let (_dataset_a, view_a) = open_view_for_session(&router, &dataset_path, &session_a).await;
    set_view_performance_budget(&router, &view_a, 4_096, None).await;

    let session_b = create_session(&router).await;
    let (_dataset_b, view_b) = open_view_for_session(&router, &dataset_path, &session_b).await;
    set_view_performance_budget(&router, &view_b, 4_096, None).await;

    assert_eq!(
        render_inline(&router, &view_a).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        render_inline(&router, &view_a).await.status(),
        StatusCode::OK
    );
    let before_b = session_cache_snapshot(&state, &session_b).await;
    assert!(before_b.is_none());

    let snapshot_a_before = session_cache_snapshot(&state, &session_a)
        .await
        .expect("session a snapshot");
    assert!(snapshot_a_before.cpu.hits > 0);
    assert!(snapshot_a_before.cpu.misses > 0);

    assert_eq!(
        render_inline(&router, &view_b).await.status(),
        StatusCode::OK
    );
    let snapshot_b = session_cache_snapshot(&state, &session_b)
        .await
        .expect("session b snapshot");
    assert!(snapshot_b.cpu.misses > 0);
    assert_eq!(snapshot_b.cpu.hits, 0);

    let snapshot_a_after = session_cache_snapshot(&state, &session_a)
        .await
        .expect("session a snapshot");
    assert_eq!(snapshot_a_after.cpu.hits, snapshot_a_before.cpu.hits);
    assert_eq!(snapshot_a_after.cpu.misses, snapshot_a_before.cpu.misses);
}

#[tokio::test]
async fn render_cache_budget_precedence_and_gpu_placeholder_stats() {
    let state = new_shared_state();
    let router = app_with_state(state.clone());
    let dataset_path = unique_dataset_path("cache-budget-precedence");
    create_render_omezarr(&dataset_path);

    let session_id = create_session(&router).await;
    let (_dataset_id, view_id) = open_view_for_session(&router, &dataset_path, &session_id).await;

    assert_eq!(
        render_inline(&router, &view_id).await.status(),
        StatusCode::OK
    );
    let default_snapshot = session_cache_snapshot(&state, &session_id)
        .await
        .expect("default snapshot");
    assert_eq!(default_snapshot.cpu.max_bytes, DEFAULT_CPU_CACHE_BYTES);
    assert_eq!(default_snapshot.gpu.max_bytes, DEFAULT_GPU_CACHE_BYTES);

    set_view_performance_budget(&router, &view_id, 8_192, Some(16_384)).await;
    assert_eq!(
        render_inline(&router, &view_id).await.status(),
        StatusCode::OK
    );

    let overridden_snapshot = session_cache_snapshot(&state, &session_id)
        .await
        .expect("overridden snapshot");
    assert_eq!(overridden_snapshot.cpu.max_bytes, 8_192);
    assert_eq!(overridden_snapshot.gpu.max_bytes, 16_384);
    assert_eq!(overridden_snapshot.gpu.current_bytes, 0);
    assert_eq!(overridden_snapshot.gpu.inserts, 0);
    assert_eq!(overridden_snapshot.gpu.hits, 0);
    assert_eq!(overridden_snapshot.gpu.misses, 0);
}

async fn create_session(router: &axum::Router) -> String {
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

async fn open_view_for_session(
    router: &axum::Router,
    dataset_path: &Path,
    session_id: &str,
) -> (String, String) {
    let opened = request_json(
        router,
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
        router,
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
    (dataset_id, view_id)
}

async fn set_view_performance_budget(
    router: &axum::Router,
    view_id: &str,
    max_cpu_bytes: u64,
    max_gpu_bytes: Option<u64>,
) {
    let mut performance = json!({"max_cpu_cache_bytes": max_cpu_bytes});
    if let Some(max_gpu_bytes) = max_gpu_bytes {
        performance["max_gpu_cache_bytes"] = json!(max_gpu_bytes);
    }

    let response = request_json(
        router,
        "POST",
        "/view/update",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "patch": [{
                "op": "replace",
                "path": "/performance",
                "value": performance,
            }],
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

async fn render_inline(router: &axum::Router, view_id: &str) -> axum::response::Response {
    request_json(
        router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
    )
    .await
}

async fn session_cache_snapshot(
    state: &SharedAppState,
    session_id: &str,
) -> Option<lucida_daemon::render_cache::SessionCacheSnapshot> {
    let cache_registry = {
        let app_state = state.read().await;
        app_state.render_caches.clone()
    };
    let guard = cache_registry.read().await;
    guard.session_snapshot(session_id)
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
