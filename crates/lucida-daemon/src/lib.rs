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
pub mod view_event_routes;
pub mod view_events;
pub mod view_state_core;
pub mod view_state_routes;
pub mod view_state_transfer_routes;

use std::path::PathBuf;

use axum::{
    body::{to_bytes, Body},
    http::Request,
    middleware::{from_fn_with_state, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::Utc;
use image::imageops::FilterType;
use image::{GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::dataset_open::dataset_open;
use crate::render_image::render_image;
use crate::session_create::{session_create, session_list};
use crate::state::{new_shared_state, SharedAppState};
use crate::ui_routes::{ui_asset, ui_index, ui_live, ui_replay};
use crate::usage::{
    extract_agent_context, normalize_instrumented_endpoint, usage_thumbnail_root, UsageEventInsert,
};
use crate::usage_routes::{
    usage_events, usage_events_stream, usage_run_detail, usage_runs, usage_thumbnail_asset,
};
use crate::view_event_routes::view_events_stream;
use crate::view_events::{ViewEvent, ViewEventThumbnail, ViewEventType};
use crate::view_state_routes::{view_create, view_get, view_list, view_update};
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
        .route("/session/list", get(session_list))
        .route("/view/create", post(view_create))
        .route("/view/list", get(view_list))
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
        .route("/usage/thumbs/{*path}", get(usage_thumbnail_asset))
        .route("/view/events/stream", get(view_events_stream))
        .route("/ui", get(ui_index))
        .route("/ui/live", get(ui_live))
        .route("/ui/replay", get(ui_replay))
        .route("/ui/{*path}", get(ui_asset))
        .with_state(state)
}

const REQUEST_CAPTURE_LIMIT_BYTES: usize = 512 * 1024;
const RESPONSE_CAPTURE_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const MAX_CAPTURE_STRING_CHARS: usize = 4096;
const THUMBNAIL_MAX_EDGE_PX: u32 = 320;

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
    let request_json_raw = decode_json_payload(request_bytes.as_ref());
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
    let mut response_json_raw = decode_json_payload(response_bytes.as_ref());
    let thumbnail = if endpoint == "/render/image" && status_code < 400 {
        create_thumbnail_from_render_response(response_json_raw.as_ref())
    } else {
        None
    };
    if let Some(thumbnail_metadata) = thumbnail.as_ref() {
        attach_usage_thumbnail(&mut response_json_raw, thumbnail_metadata);
    }
    let request_json = sanitize_usage_payload(request_json_raw.clone());
    let response_json = sanitize_usage_payload(response_json_raw.clone());
    let response = Response::from_parts(response_parts, Body::from(response_bytes));

    let (usage, view_events) = {
        let app_state = state.read().await;
        (app_state.usage.clone(), app_state.view_events.clone())
    };
    if let Some(event) = build_view_event(
        &endpoint,
        status_code,
        request_json_raw.as_ref(),
        response_json_raw.as_ref(),
        thumbnail
            .as_ref()
            .map(UsageThumbnailMetadata::to_view_event_thumbnail),
    ) {
        view_events.publish(event);
    }
    let usage_event = UsageEventInsert {
        endpoint: endpoint.clone(),
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

#[derive(Debug, Clone)]
struct UsageThumbnailMetadata {
    url: String,
    sha256: String,
    width_px: u64,
    height_px: u64,
}

impl UsageThumbnailMetadata {
    fn to_json_value(&self) -> Value {
        serde_json::json!({
            "url": self.url,
            "sha256": self.sha256,
            "width_px": self.width_px,
            "height_px": self.height_px,
        })
    }

    fn to_view_event_thumbnail(&self) -> ViewEventThumbnail {
        ViewEventThumbnail {
            url: self.url.clone(),
            sha256: self.sha256.clone(),
            width_px: self.width_px,
            height_px: self.height_px,
        }
    }
}

fn create_thumbnail_from_render_response(
    response_json: Option<&Value>,
) -> Option<UsageThumbnailMetadata> {
    let payload = response_json?;
    let render_id = value_string(payload, &["render_id"])?;
    if !render_id
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-')
    {
        return None;
    }
    let bytes_base64 = value_string(payload, &["images", "0", "bytes_base64"])?;
    let decoded = BASE64_STANDARD.decode(bytes_base64).ok()?;
    let image = image::load_from_memory(&decoded).ok()?;
    let resized = if image.width().max(image.height()) > THUMBNAIL_MAX_EDGE_PX {
        image.resize(
            THUMBNAIL_MAX_EDGE_PX,
            THUMBNAIL_MAX_EDGE_PX,
            FilterType::Triangle,
        )
    } else {
        image
    };
    let (width_px, height_px) = resized.dimensions();

    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    if resized.write_to(&mut cursor, ImageFormat::Png).is_err() {
        return None;
    }
    let encoded_png = cursor.into_inner();

    let date_folder = Utc::now().format("%Y-%m-%d").to_string();
    let target_path = usage_thumbnail_root()
        .join(&date_folder)
        .join(format!("{render_id}.png"));
    if persist_thumbnail(&target_path, &encoded_png).is_err() {
        return None;
    }

    let mut hasher = Sha256::new();
    hasher.update(&encoded_png);
    let sha256 = format!("{:x}", hasher.finalize());
    Some(UsageThumbnailMetadata {
        url: format!("/usage/thumbs/{date_folder}/{render_id}.png"),
        sha256,
        width_px: u64::from(width_px),
        height_px: u64::from(height_px),
    })
}

fn persist_thumbnail(path: &PathBuf, bytes: &[u8]) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)?;
    Ok(())
}

fn attach_usage_thumbnail(response_json: &mut Option<Value>, thumbnail: &UsageThumbnailMetadata) {
    let Some(Value::Object(payload)) = response_json.as_mut() else {
        return;
    };
    payload.insert("usage_thumbnail".to_owned(), thumbnail.to_json_value());
}

fn build_view_event(
    endpoint: &str,
    status_code: u16,
    request_json: Option<&Value>,
    response_json: Option<&Value>,
    thumbnail: Option<ViewEventThumbnail>,
) -> Option<ViewEvent> {
    if status_code >= 400 {
        return None;
    }
    match endpoint {
        "/view/create" | "/view/update" | "/import/viewstate" => {
            let response = response_json?;
            let view_id = value_string(response, &["view_state", "view_id"])?;
            Some(ViewEvent {
                schema_version: 1,
                event_type: ViewEventType::ViewStateCommitted,
                occurred_at_utc: Utc::now(),
                endpoint: endpoint.to_owned(),
                view_id,
                session_id: first_non_empty_string(vec![
                    value_string(response, &["view_state", "session_id"]),
                    request_json.and_then(|value| value_string(value, &["session_id"])),
                ]),
                state_hash: first_non_empty_string(vec![
                    value_string(response, &["view_state", "state_hash"]),
                    value_string(response, &["state_hash"]),
                ]),
                state_version: first_some_u64(vec![
                    value_u64(response, &["view_state", "state_version"]),
                    value_u64(response, &["state_version"]),
                ]),
                render_id: None,
                thumbnail: None,
            })
        }
        "/render/image" => {
            let response = response_json?;
            let view_id = first_non_empty_string(vec![
                value_string(response, &["view_id"]),
                request_json.and_then(|value| value_string(value, &["view_id"])),
                request_json.and_then(|value| value_string(value, &["view_state", "view_id"])),
            ])?;
            Some(ViewEvent {
                schema_version: 1,
                event_type: ViewEventType::RenderCompleted,
                occurred_at_utc: Utc::now(),
                endpoint: endpoint.to_owned(),
                view_id,
                session_id: first_non_empty_string(vec![
                    request_json.and_then(|value| value_string(value, &["session_id"])),
                    request_json
                        .and_then(|value| value_string(value, &["view_state", "session_id"])),
                ]),
                state_hash: first_non_empty_string(vec![
                    value_string(response, &["state_hash"]),
                    value_string(response, &["view_state", "state_hash"]),
                ]),
                state_version: first_some_u64(vec![
                    value_u64(response, &["state_version"]),
                    value_u64(response, &["view_state", "state_version"]),
                ]),
                render_id: value_string(response, &["render_id"]),
                thumbnail,
            })
        }
        _ => None,
    }
}

fn first_non_empty_string(values: Vec<Option<String>>) -> Option<String> {
    for value in values {
        if let Some(item) = value {
            if !item.trim().is_empty() {
                return Some(item);
            }
        }
    }
    None
}

fn first_some_u64(values: Vec<Option<u64>>) -> Option<u64> {
    values.into_iter().flatten().next()
}

fn value_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for segment in path {
        current = match current {
            Value::Object(map) => map.get(*segment)?,
            Value::Array(items) => {
                let index = segment.parse::<usize>().ok()?;
                items.get(index)?
            }
            _ => return None,
        };
    }
    Some(current)
}

fn value_string(value: &Value, path: &[&str]) -> Option<String> {
    value_at_path(value, path)
        .and_then(Value::as_str)
        .map(str::trim)
        .and_then(|text| (!text.is_empty()).then_some(text.to_owned()))
}

fn value_u64(value: &Value, path: &[&str]) -> Option<u64> {
    value_at_path(value, path).and_then(Value::as_u64)
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
