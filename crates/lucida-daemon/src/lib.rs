pub mod dataset_open;
pub mod dto;
pub mod error;
pub mod omezarr;
pub mod render_cache;
pub mod render_cpu;
pub mod render_image;
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
use crate::ui_routes::{ui_asset, ui_index};
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
        .route("/ui/{*path}", get(ui_asset))
        .with_state(state)
}

const REQUEST_CAPTURE_LIMIT_BYTES: usize = usize::MAX;
const RESPONSE_CAPTURE_LIMIT_BYTES: usize = usize::MAX;

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
    let request_json = decode_json_payload(request_bytes.as_ref());
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
    let response_json = decode_json_payload(response_bytes.as_ref());
    let response = Response::from_parts(response_parts, Body::from(response_bytes));

    let usage = {
        let app_state = state.read().await;
        app_state.usage.clone()
    };
    if let Err(error) = usage.record_http_event(UsageEventInsert {
        endpoint,
        method: method.to_string(),
        status_code,
        latency_ms,
        agent_context,
        request_json,
        response_json,
    }) {
        tracing::warn!(target: "lucida.usage", path = %path, error = %error, "failed to record usage telemetry event");
    }

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
