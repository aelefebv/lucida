mod support;

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use lucida_daemon::state::{new_shared_state, new_shared_state_with_usage};
use lucida_daemon::usage::{new_shared_usage_telemetry_with_config, UsageConfig};
use lucida_daemon::view_events::ViewEventType;
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

    let events_payload = wait_for_usage_events(&router, &run_id, 5).await;
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
    let successful_render = events
        .iter()
        .find(|event| event["endpoint"] == "/render/image" && event["status_code"] == 200)
        .expect("successful render event");
    let thumbnail_url = successful_render["response_json"]["usage_thumbnail"]["url"]
        .as_str()
        .expect("thumbnail url");
    assert!(thumbnail_url.starts_with("/usage/thumbs/"));
    let thumbnail_response = request_get(&router, thumbnail_url, None).await;
    assert_eq!(thumbnail_response.status(), StatusCode::OK);
    assert_eq!(content_type(&thumbnail_response), "image/png");
    let thumbnail_body = thumbnail_response
        .into_body()
        .collect()
        .await
        .expect("read thumbnail")
        .to_bytes();
    assert!(!thumbnail_body.is_empty());

    let failed_render = events
        .iter()
        .find(|event| event["endpoint"] == "/render/image" && event["status_code"] == 422)
        .expect("failed render event");
    assert!(failed_render["response_json"]["usage_thumbnail"].is_null());

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
async fn view_events_stream_emits_view_update_and_render_events() {
    let router = app();
    let run_id = format!("view-stream-{}", Uuid::new_v4().simple());
    let dataset_path = unique_dataset_path("view-events-stream");
    create_render_omezarr(&dataset_path);

    let session_response = request_json_with_agent(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
        &run_id,
        "view-stream-session",
    )
    .await;
    assert_eq!(session_response.status(), StatusCode::OK);
    let session_id = read_json_body(session_response).await["session_id"]
        .as_str()
        .expect("session_id")
        .to_owned();

    let open_response = request_json_with_agent(
        &router,
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "session_id": session_id,
        }),
        &run_id,
        "view-stream-open",
    )
    .await;
    assert_eq!(open_response.status(), StatusCode::OK);
    let dataset_id = read_json_body(open_response).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id")
        .to_owned();

    let create_response = request_json_with_agent(
        &router,
        "POST",
        "/view/create",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "dataset_id": dataset_id,
            "mode": "2d",
        }),
        &run_id,
        "view-stream-create",
    )
    .await;
    assert_eq!(create_response.status(), StatusCode::OK);
    let view_id = read_json_body(create_response).await["view_state"]["view_id"]
        .as_str()
        .expect("view_id")
        .to_owned();

    let stream_response = request_get(
        &router,
        "/view/events/stream",
        Some(&[
            ("view_id", view_id.as_str()),
            ("session_id", session_id.as_str()),
        ]),
    )
    .await;
    assert_eq!(stream_response.status(), StatusCode::OK);
    let mut stream_body = stream_response.into_body();

    let update_response = request_json_with_agent(
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
                    "value": [{"axis": "z", "kind": "index", "index": 1, "clamp": true}],
                }
            ],
        }),
        &run_id,
        "view-stream-update",
    )
    .await;
    assert_eq!(update_response.status(), StatusCode::OK);
    let update_event = wait_for_sse_event(&mut stream_body, Duration::from_secs(5), |event| {
        event["event_type"] == "view_state_committed" && event["endpoint"] == "/view/update"
    })
    .await
    .expect("view update stream event");
    assert_eq!(update_event["view_id"], view_id);
    assert_eq!(update_event["session_id"], session_id);
    assert!(update_event["state_hash"].as_str().is_some());
    assert!(update_event["state_version"].as_u64().is_some());

    let render_response = request_json_with_agent(
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
                "width_px": 96,
                "height_px": 72,
            },
        }),
        &run_id,
        "view-stream-render",
    )
    .await;
    assert_eq!(render_response.status(), StatusCode::OK);
    let render_event = wait_for_sse_event(&mut stream_body, Duration::from_secs(5), |event| {
        event["event_type"] == "render_completed" && event["endpoint"] == "/render/image"
    })
    .await
    .expect("render stream event");
    assert_eq!(render_event["view_id"], view_id);
    assert_eq!(render_event["session_id"], session_id);
    assert!(render_event["render_id"].as_str().is_some());
    assert!(render_event["state_hash"].as_str().is_some());
    assert!(render_event["thumbnail"]["url"]
        .as_str()
        .expect("thumbnail url")
        .starts_with("/usage/thumbs/"));
}

#[tokio::test]
async fn view_event_bus_emits_create_and_update_commits() {
    let state = new_shared_state();
    let view_events = {
        let app_state = state.read().await;
        app_state.view_events.clone()
    };
    let mut receiver = view_events.subscribe();
    let router = app_with_state(state.clone());
    let run_id = format!("view-bus-{}", Uuid::new_v4().simple());
    let dataset_path = unique_dataset_path("view-events-bus");
    create_render_omezarr(&dataset_path);

    let session_response = request_json_with_agent(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
        &run_id,
        "view-bus-session",
    )
    .await;
    assert_eq!(session_response.status(), StatusCode::OK);
    let session_id = read_json_body(session_response).await["session_id"]
        .as_str()
        .expect("session_id")
        .to_owned();

    let open_response = request_json_with_agent(
        &router,
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "session_id": session_id,
        }),
        &run_id,
        "view-bus-open",
    )
    .await;
    assert_eq!(open_response.status(), StatusCode::OK);
    let dataset_id = read_json_body(open_response).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id")
        .to_owned();

    let create_response = request_json_with_agent(
        &router,
        "POST",
        "/view/create",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "dataset_id": dataset_id,
            "mode": "2d",
        }),
        &run_id,
        "view-bus-create",
    )
    .await;
    assert_eq!(create_response.status(), StatusCode::OK);
    let view_id = read_json_body(create_response).await["view_state"]["view_id"]
        .as_str()
        .expect("view_id")
        .to_owned();

    let create_event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = receiver.recv().await.ok()?;
            if event.event_type == ViewEventType::ViewStateCommitted
                && event.endpoint == "/view/create"
            {
                return Some(event);
            }
        }
    })
    .await
    .expect("create event timeout")
    .expect("create event");
    assert_eq!(create_event.view_id, view_id);
    assert_eq!(
        create_event.session_id.as_deref(),
        Some(session_id.as_str())
    );

    let update_response = request_json_with_agent(
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
                    "value": [{"axis": "z", "kind": "index", "index": 3, "clamp": true}],
                }
            ],
        }),
        &run_id,
        "view-bus-update",
    )
    .await;
    assert_eq!(update_response.status(), StatusCode::OK);

    let update_event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = receiver.recv().await.ok()?;
            if event.event_type == ViewEventType::ViewStateCommitted
                && event.endpoint == "/view/update"
            {
                return Some(event);
            }
        }
    })
    .await
    .expect("update event timeout")
    .expect("update event");
    assert_eq!(update_event.view_id, view_id);
    assert_eq!(
        update_event.session_id.as_deref(),
        Some(session_id.as_str())
    );
}

#[tokio::test]
async fn view_events_stream_filters_by_session_id() {
    let router = app();
    let run_id = format!("view-filter-{}", Uuid::new_v4().simple());
    let dataset_path = unique_dataset_path("view-events-filter");
    create_render_omezarr(&dataset_path);

    let session_response = request_json_with_agent(
        &router,
        "POST",
        "/session/create",
        json!({"schema_version": 1}),
        &run_id,
        "view-filter-session",
    )
    .await;
    assert_eq!(session_response.status(), StatusCode::OK);
    let session_id = read_json_body(session_response).await["session_id"]
        .as_str()
        .expect("session_id")
        .to_owned();

    let open_response = request_json_with_agent(
        &router,
        "POST",
        "/dataset/open",
        json!({
            "schema_version": 1,
            "uri": dataset_path.to_string_lossy(),
            "session_id": session_id,
        }),
        &run_id,
        "view-filter-open",
    )
    .await;
    assert_eq!(open_response.status(), StatusCode::OK);
    let dataset_id = read_json_body(open_response).await["dataset_summary"]["dataset_id"]
        .as_str()
        .expect("dataset_id")
        .to_owned();

    let create_response = request_json_with_agent(
        &router,
        "POST",
        "/view/create",
        json!({
            "schema_version": 1,
            "session_id": session_id,
            "dataset_id": dataset_id,
            "mode": "2d",
        }),
        &run_id,
        "view-filter-create",
    )
    .await;
    assert_eq!(create_response.status(), StatusCode::OK);
    let view_id = read_json_body(create_response).await["view_state"]["view_id"]
        .as_str()
        .expect("view_id")
        .to_owned();

    let stream_response = request_get(
        &router,
        "/view/events/stream",
        Some(&[
            ("view_id", view_id.as_str()),
            ("session_id", "session_missing"),
        ]),
    )
    .await;
    assert_eq!(stream_response.status(), StatusCode::OK);
    let mut stream_body = stream_response.into_body();

    let update_response = request_json_with_agent(
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
        &run_id,
        "view-filter-update",
    )
    .await;
    assert_eq!(update_response.status(), StatusCode::OK);

    let maybe_event =
        wait_for_sse_event(&mut stream_body, Duration::from_millis(450), |_| true).await;
    assert!(maybe_event.is_none());
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

    let replay = request_get(&router, "/ui/replay", None).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert!(content_type(&replay).contains("text/html"));
    let replay_body = read_body(replay).await;
    assert!(replay_body.contains("Agent Visual Replay"));

    let replay_css = request_get(&router, "/ui/replay.css", None).await;
    assert_eq!(replay_css.status(), StatusCode::OK);
    assert!(content_type(&replay_css).contains("text/css"));

    let replay_js = request_get(&router, "/ui/replay.js", None).await;
    assert_eq!(replay_js.status(), StatusCode::OK);
    assert!(content_type(&replay_js).contains("application/javascript"));

    let live = request_get(&router, "/ui/live", None).await;
    assert_eq!(live.status(), StatusCode::OK);
    assert!(content_type(&live).contains("text/html"));
    let live_body = read_body(live).await;
    assert!(live_body.contains("Live View Mirror"));

    let live_css = request_get(&router, "/ui/live.css", None).await;
    assert_eq!(live_css.status(), StatusCode::OK);
    assert!(content_type(&live_css).contains("text/css"));

    let live_js = request_get(&router, "/ui/live.js", None).await;
    assert_eq!(live_js.status(), StatusCode::OK);
    assert!(content_type(&live_js).contains("application/javascript"));

    let traversal = request_get(&router, "/usage/thumbs/../escape.png", None).await;
    assert_eq!(traversal.status(), StatusCode::NOT_FOUND);
}

async fn wait_for_sse_event<F>(
    stream_body: &mut Body,
    timeout: Duration,
    predicate: F,
) -> Option<Value>
where
    F: Fn(&Value) -> bool,
{
    tokio::time::timeout(timeout, async {
        loop {
            match stream_body.frame().await {
                None => return None,
                Some(Ok(frame)) => {
                    let Some(data) = frame.data_ref() else {
                        continue;
                    };
                    let text = String::from_utf8_lossy(data);
                    if let Some(event) = parse_sse_json_payload(&text) {
                        if predicate(&event) {
                            return Some(event);
                        }
                    }
                }
                Some(Err(_)) => return None,
            }
        }
    })
    .await
    .ok()
    .flatten()
}

fn parse_sse_json_payload(chunk: &str) -> Option<Value> {
    for line in chunk.lines() {
        let Some(payload) = line.strip_prefix("data: ") else {
            continue;
        };
        if let Ok(parsed) = serde_json::from_str::<Value>(payload) {
            return Some(parsed);
        }
    }
    None
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

async fn wait_for_usage_events(router: &axum::Router, run_id: &str, min_events: usize) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let events_response = request_get(
            router,
            "/usage/events",
            Some(&[("run_id", run_id), ("limit", "200")]),
        )
        .await;
        assert_eq!(events_response.status(), StatusCode::OK);
        let payload = read_json_body(events_response).await;
        let event_count = payload["events"]
            .as_array()
            .map(|events| events.len())
            .unwrap_or(0);
        if event_count >= min_events {
            return payload;
        }
        if tokio::time::Instant::now() >= deadline {
            return payload;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
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
