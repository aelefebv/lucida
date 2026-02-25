pub mod dataset_open;
pub mod dto;
pub mod error;
pub mod omezarr;
pub mod render_cache;
pub mod render_cpu;
pub mod render_image;
pub mod request_validation;
pub mod session_create;
pub mod state;
pub mod ui_routes;
pub mod uri;
pub mod usage;
pub mod usage_routes;
pub mod view_state_core;
pub mod view_state_routes;
pub mod view_state_transfer_routes;

use axum::{
    body::{to_bytes, Body},
    http::Request,
    middleware::{from_fn_with_state, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dataset_open::dataset_open;
use crate::render_image::render_image;
use crate::session_create::session_create;
use crate::state::{new_shared_state, SharedAppState};
use crate::ui_routes::{ui_asset, ui_index, ui_replay};
use crate::usage::{extract_agent_context, normalize_instrumented_endpoint, UsageEventInsert};
use crate::usage_routes::{usage_events, usage_events_stream, usage_run_detail, usage_runs};
use crate::view_state_routes::{view_create, view_get, view_update};
use crate::view_state_transfer_routes::{export_viewstate, import_viewstate};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HealthzResponse {
    pub status: String,
}

async fn healthz() -> Json<HealthzResponse> {
    Json(HealthzResponse {
        status: "ok".to_owned(),
    })
}

pub fn app() -> Router {
    app_with_state(new_shared_state())
}

pub fn app_with_state(state: SharedAppState) -> Router {
    let instrumented_api = Router::new()
        .route("/dataset/open", post(dataset_open))
        .route("/session/create", post(session_create))
        .route("/view/create", post(view_create))
        .route("/view/{view_id}", get(view_get))
        .route("/view/update", post(view_update))
        .route("/export/viewstate", post(export_viewstate))
        .route("/import/viewstate", post(import_viewstate))
        .route("/render/image", post(render_image))
        .route_layer(from_fn_with_state(state.clone(), usage_capture_middleware));

    Router::new()
        .route("/healthz", get(healthz))
        .merge(instrumented_api)
        .route("/usage/events", get(usage_events))
        .route("/usage/runs", get(usage_runs))
        .route("/usage/runs/{run_id}", get(usage_run_detail))
        .route("/usage/events/stream", get(usage_events_stream))
        .route("/ui", get(ui_index))
        .route("/ui/replay", get(ui_replay))
        .route("/ui/{*path}", get(ui_asset))
        .with_state(state)
}

const REQUEST_CAPTURE_LIMIT_BYTES: usize = 512 * 1024;
const RESPONSE_CAPTURE_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const MAX_CAPTURE_STRING_CHARS: usize = 4096;

async fn usage_capture_middleware(
    axum::extract::State(state): axum::extract::State<SharedAppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let Some(endpoint) = normalize_instrumented_endpoint(&method, &path) else {
        return next.run(request).await;
    };
    let agent_context = extract_agent_context(request.headers());

    let start = std::time::Instant::now();
    let (request_parts, request_body) = request.into_parts();
    let request_bytes = match to_bytes(request_body, REQUEST_CAPTURE_LIMIT_BYTES).await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(target: "lucida.usage", path = %path, error = %error, "failed to capture request body");
            Default::default()
        }
    };
    let request_json = sanitize_usage_payload(decode_json_payload(request_bytes.as_ref()));
    let request = Request::from_parts(request_parts, Body::from(request_bytes));

    let response = next.run(request).await;
    let latency_ms = start.elapsed().as_secs_f64() * 1000.0;
    let status_code = response.status().as_u16();
    let (response_parts, response_body) = response.into_parts();
    let response_bytes = match to_bytes(response_body, RESPONSE_CAPTURE_LIMIT_BYTES).await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(target: "lucida.usage", path = %path, error = %error, "failed to capture response body");
            Default::default()
        }
    };
    let response_json = sanitize_usage_payload(decode_json_payload(response_bytes.as_ref()));
    let response = Response::from_parts(response_parts, Body::from(response_bytes));

    let usage = {
        let app_state = state.read().await;
        app_state.usage.clone()
    };
    let usage_event = UsageEventInsert {
        endpoint,
        method: method.to_string(),
        status_code,
        latency_ms,
        agent_context,
        request_json,
        response_json,
    };
    usage.begin_async_insert();
    tokio::spawn({
        let usage = usage.clone();
        let path_for_log = path.clone();
        async move {
            let insert_result = tokio::task::spawn_blocking({
                let usage = usage.clone();
                move || usage.record_http_event(usage_event)
            })
            .await;
            usage.finish_async_insert();

            match insert_result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(
                        target: "lucida.usage",
                        path = %path_for_log,
                        error = %error,
                        "failed to record usage telemetry event"
                    );
                }
                Err(join_error) => {
                    tracing::warn!(
                        target: "lucida.usage",
                        path = %path_for_log,
                        error = %join_error,
                        "usage telemetry task join failed"
                    );
                }
            }
        }
    });

    response
}

fn decode_json_payload(bytes: &[u8]) -> Option<Value> {
    if bytes.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        return Some(value);
    }
    Some(serde_json::json!({
        "_raw_text": String::from_utf8_lossy(bytes),
    }))
}

fn sanitize_usage_payload(payload: Option<Value>) -> Option<Value> {
    let mut payload = payload?;
    sanitize_usage_value(&mut payload);
    Some(payload)
}

fn sanitize_usage_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                if key == "bytes_base64" {
                    *item = Value::String("<omitted>".to_owned());
                    continue;
                }
                sanitize_usage_value(item);
            }
        }
        Value::Array(items) => {
            for item in items {
                sanitize_usage_value(item);
            }
        }
        Value::String(text) => {
            let char_len = text.chars().count();
            if char_len > MAX_CAPTURE_STRING_CHARS {
                let prefix = text
                    .chars()
                    .take(MAX_CAPTURE_STRING_CHARS)
                    .collect::<String>();
                let truncated = format!(
                    "{}...[truncated {} chars]",
                    prefix,
                    char_len - MAX_CAPTURE_STRING_CHARS,
                );
                *value = Value::String(truncated);
            }
        }
        _ => {}
    }
}
