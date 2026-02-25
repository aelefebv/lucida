mod support;

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use lucida_daemon::state::new_shared_state_with_usage;
use lucida_daemon::usage::{new_shared_usage_telemetry_with_config, UsageConfig};
use lucida_daemon::{app, app_with_state};
use serde_json::{json, Value};
use support::create_render_omezarr;
use tower::ServiceExt;
use uuid::Uuid;

const HEADER_AGENT_RUN_ID: &str = "x-lucida-agent-run-id";
const HEADER_AGENT_STEP_ID: &str = "x-lucida-agent-step-id";
const HEADER_AGENT_NAME: &str = "x-lucida-agent-name";

#[tokio::test]
async fn usage_events_runs_and_error_capture_work_end_to_end() {
    let router = app();
    let dataset_path = unique_dataset_path("usage-e2e");
    create_render_omezarr(&dataset_path);
    let run_id = format!("run_{}", Uuid::new_v4().simple());

    let session_response = request_json_with_agent(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
        &run_id,
        "step-session",
    )
    .await;
    assert_eq!(session_response.status(), StatusCode::OK);
    let session_id = read_json_body(session_response).await["session_id"]
        .as_str()
        .expect("session_id")
        .to_owned();

    let opened = request_json_with_agent(
        &router,
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "session_id": session_id,
        }),
        &run_id,
        "step-open",
    )
    .await;
    assert_eq!(opened.status(), StatusCode::OK);
    let dataset_id = read_json_body(opened).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset id")
        .to_owned();

    let created = request_json_with_agent(
        &router,
        "POST",
        "/view/create",
        json!({
            "schema_version": 1,
            "dataset_id": dataset_id,
            "session_id": session_id,
            "mode": "2d",
        }),
        &run_id,
        "step-create-view",
    )
    .await;
    assert_eq!(created.status(), StatusCode::OK);
    let view_id = read_json_body(created).await["view_state"]["view_id"]
        .as_str()
        .expect("view id")
        .to_owned();

    let rendered = request_json_with_agent(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "session_id": session_id,
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
        &run_id,
        "step-render",
    )
    .await;
    assert_eq!(rendered.status(), StatusCode::OK);

    let failing = request_json_with_agent(
        &router,
        "POST",
        "/render/image",
        json!({
            "schema_version": 1,
            "view_id": view_id,
            "view_state": {},
            "output": {
                "format": "png",
                "delivery": "inline_base64",
                "width_px": 64,
                "height_px": 48,
            },
        }),
        &run_id,
        "step-invalid",
    )
    .await;
    assert_eq!(failing.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let events_response = request_get(
        &router,
        "/usage/events",
        Some(&[("run_id", run_id.as_str()), ("limit", "200")]),
    )
    .await;
    assert_eq!(events_response.status(), StatusCode::OK);
    let events_payload = read_json_body(events_response).await;
    let events = events_payload["events"].as_array().expect("events array");
    assert!(events.len() >= 5);
    assert!(events.iter().all(|event| event["agent_run_id"] == run_id));
    assert!(events
        .iter()
        .any(|event| event["endpoint"] == "/render/image"));
    assert!(events
        .iter()
        .any(|event| event["agent_step_id"] == "step-render"));
    assert!(events
        .iter()
        .any(|event| event["status_code"] == 422 && !event["error_code"].is_null()));

    let runs_response = request_get(&router, "/usage/runs", Some(&[("limit", "200")])).await;
    assert_eq!(runs_response.status(), StatusCode::OK);
    let runs_payload = read_json_body(runs_response).await;
    let run = runs_payload["runs"]
        .as_array()
        .expect("runs array")
        .iter()
        .find(|candidate| candidate["agent_run_id"] == run_id)
        .expect("run should exist");
    assert!(run["event_count"].as_u64().expect("event_count") >= 5);
    assert!(run["render_count"].as_u64().expect("render_count") >= 1);
    assert!(run["error_count"].as_u64().expect("error_count") >= 1);

    let run_detail = request_get(
        &router,
        &format!("/usage/runs/{run_id}"),
        Some(&[("limit", "200")]),
    )
    .await;
    assert_eq!(run_detail.status(), StatusCode::OK);
    let detail_payload = read_json_body(run_detail).await;
    assert_eq!(detail_payload["run"]["agent_run_id"], run_id);
    assert!(detail_payload["events"].as_array().expect("events").len() >= 5);
}

#[tokio::test]
async fn usage_events_stream_emits_new_events() {
    let router = app();
    let run_id = format!("stream_{}", Uuid::new_v4().simple());

    let stream_response = request_get(
        &router,
        "/usage/events/stream",
        Some(&[("run_id", run_id.as_str())]),
    )
    .await;
    assert_eq!(stream_response.status(), StatusCode::OK);

    let mut stream_body = stream_response.into_body();
    let create_response = request_json_with_agent(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
        &run_id,
        "stream-step",
    )
    .await;
    assert_eq!(create_response.status(), StatusCode::OK);

    let chunk = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match stream_body.frame().await {
                None => return None,
                Some(Ok(frame)) => {
                    if let Some(data) = frame.data_ref() {
                        let text = String::from_utf8_lossy(data);
                        if text.contains("usage_event") || text.contains("agent_run_id") {
                            return Some(text.to_string());
                        }
                    }
                }
                Some(Err(_)) => return None,
            }
        }
    })
    .await
    .expect("stream timeout");
    let chunk = chunk.expect("stream should emit at least one event chunk");
    assert!(chunk.contains("usage_event") || chunk.contains("agent_run_id"));
}

#[tokio::test]
async fn usage_retention_prunes_by_count_and_age() {
    let db_root = unique_dataset_path("usage-retention");
    let db_path = db_root.join("usage.sqlite");
    let usage = new_shared_usage_telemetry_with_config(UsageConfig {
        db_path: db_path.clone(),
        retention_days: 1,
        max_events: 3,
        max_db_bytes: 1_073_741_824,
    })
    .expect("usage telemetry init");
    let state = new_shared_state_with_usage(usage.clone());
    let router = app_with_state(state);
    let run_id = format!("retention_{}", Uuid::new_v4().simple());

    for step in 0..6 {
        let response = request_json_with_agent(
            &router,
            "POST",
            "/session/create",
            json!({"schema_version": 1}),
            &run_id,
            &format!("step-{step}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    let bounded = request_get(
        &router,
        "/usage/events",
        Some(&[("run_id", run_id.as_str()), ("limit", "100")]),
    )
    .await;
    assert_eq!(bounded.status(), StatusCode::OK);
    let bounded_payload = read_json_body(bounded).await;
    assert!(bounded_payload["events"].as_array().expect("events").len() <= 3);

    let conn = rusqlite::Connection::open(&db_path).expect("open usage db");
    conn.execute(
        "UPDATE usage_events SET occurred_at_utc = '2000-01-01T00:00:00+00:00' WHERE agent_run_id = ?1",
        [&run_id],
    )
    .expect("update usage rows");
    usage.prune_retention().expect("prune retention");

    let aged = request_get(
        &router,
        "/usage/events",
        Some(&[("run_id", run_id.as_str()), ("limit", "100")]),
    )
    .await;
    assert_eq!(aged.status(), StatusCode::OK);
    let aged_payload = read_json_body(aged).await;
    assert!(aged_payload["events"]
        .as_array()
        .expect("events")
        .is_empty());
}

#[tokio::test]
async fn ui_assets_are_served() {
    let router = app();

    let index = request_get(&router, "/ui", None).await;
    assert_eq!(index.status(), StatusCode::OK);
    assert!(content_type(&index).contains("text/html"));
    let index_body = read_body(index).await;
    assert!(index_body.contains("Lucida Agent Usage"));

    let css = request_get(&router, "/ui/styles.css", None).await;
    assert_eq!(css.status(), StatusCode::OK);
    assert!(content_type(&css).contains("text/css"));

    let js = request_get(&router, "/ui/app.js", None).await;
    assert_eq!(js.status(), StatusCode::OK);
    assert!(content_type(&js).contains("application/javascript"));
}

async fn request_json_with_agent(
    router: &axum::Router,
    method: &str,
    path: &str,
    payload: Value,
    run_id: &str,
    step_id: &str,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header(HEADER_AGENT_RUN_ID, run_id)
                .header(HEADER_AGENT_STEP_ID, step_id)
                .header(HEADER_AGENT_NAME, "usage-test-agent")
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

fn content_type(response: &axum::response::Response) -> String {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned()
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

async fn read_body(response: axum::response::Response) -> String {
    let body_bytes = response
        .into_body()
        .collect()
        .await
        .expect("read body")
        .to_bytes();
    String::from_utf8_lossy(&body_bytes).to_string()
}

fn unique_dataset_path(name: &str) -> PathBuf {
    let path = std::env::temp_dir()
        .join("lucida-daemon-tests")
        .join(format!("{name}-{}", Uuid::new_v4().simple()));
    if path.exists() {
        fs::remove_dir_all(&path).expect("cleanup old directory");
    }
    fs::create_dir_all(&path).expect("create path");
    path
}
