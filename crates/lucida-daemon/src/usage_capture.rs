use std::path::Path;
use std::sync::mpsc::{Receiver, SendError, Sender};
use std::sync::Arc;
use std::thread;

use axum::{
    body::{to_bytes, Body},
    http::Request,
    middleware::Next,
    response::Response,
};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::Utc;
use image::imageops::FilterType;
use image::{GenericImageView, ImageFormat};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::state::SharedAppState;
use crate::usage::{
    extract_agent_context, normalize_instrumented_endpoint, usage_thumbnail_root, AgentContext,
    SharedUsageTelemetry, UsageEventInsert,
};
use crate::view_events::{SharedViewEventBus, ViewEvent, ViewEventThumbnail, ViewEventType};

const REQUEST_CAPTURE_LIMIT_BYTES: usize = 512 * 1024;
const RESPONSE_CAPTURE_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const MAX_CAPTURE_STRING_CHARS: usize = 4096;
const THUMBNAIL_MAX_EDGE_PX: u32 = 320;

pub const ENV_USAGE_THUMBNAIL_SAMPLE_RATE: &str = "LUCIDA_USAGE_THUMBNAIL_SAMPLE_RATE";
pub const ENV_USAGE_THUMBNAIL_MAX_PER_MINUTE: &str = "LUCIDA_USAGE_THUMBNAIL_MAX_PER_MINUTE";

const DEFAULT_THUMBNAIL_SAMPLE_RATE: f64 = 1.0;
const DEFAULT_THUMBNAIL_MAX_PER_MINUTE: u32 = u32::MAX;

#[derive(Debug)]
pub struct UsageCaptureWorker {
    sender: Sender<UsageCaptureJob>,
}

pub type SharedUsageCaptureWorker = Arc<UsageCaptureWorker>;

#[derive(Debug, Clone)]
struct UsageCaptureJob {
    endpoint: String,
    path_for_log: String,
    method: String,
    status_code: u16,
    latency_ms: f64,
    agent_context: AgentContext,
    request_json_raw: Option<Value>,
    response_json_raw: Option<Value>,
}

#[derive(Debug, Clone)]
struct ThumbnailPolicy {
    sample_rate: f64,
    max_per_minute: u32,
}

impl ThumbnailPolicy {
    fn from_env() -> Self {
        let sample_rate = parse_env_f64(
            ENV_USAGE_THUMBNAIL_SAMPLE_RATE,
            DEFAULT_THUMBNAIL_SAMPLE_RATE,
        )
        .clamp(0.0, 1.0);
        let max_per_minute = parse_env_u32(
            ENV_USAGE_THUMBNAIL_MAX_PER_MINUTE,
            DEFAULT_THUMBNAIL_MAX_PER_MINUTE,
        );
        Self {
            sample_rate,
            max_per_minute,
        }
    }

    fn allows_render(
        &self,
        render_id: &str,
        now_minute_bucket: i64,
        rate_window: &mut ThumbnailRateWindow,
    ) -> bool {
        if self.max_per_minute == 0 {
            return false;
        }
        if !should_sample_render(render_id, self.sample_rate) {
            return false;
        }
        rate_window.try_acquire(now_minute_bucket, self.max_per_minute)
    }
}

#[derive(Debug, Default)]
struct ThumbnailRateWindow {
    minute_bucket: Option<i64>,
    generated_count: u32,
}

impl ThumbnailRateWindow {
    fn try_acquire(&mut self, minute_bucket: i64, max_per_minute: u32) -> bool {
        if self.minute_bucket != Some(minute_bucket) {
            self.minute_bucket = Some(minute_bucket);
            self.generated_count = 0;
        }
        if self.generated_count >= max_per_minute {
            return false;
        }
        self.generated_count = self.generated_count.saturating_add(1);
        true
    }
}

pub fn new_shared_usage_capture_worker(
    usage: SharedUsageTelemetry,
    view_events: SharedViewEventBus,
) -> SharedUsageCaptureWorker {
    let (sender, receiver) = std::sync::mpsc::channel::<UsageCaptureJob>();
    spawn_usage_capture_worker(receiver, usage, view_events);
    Arc::new(UsageCaptureWorker { sender })
}

impl UsageCaptureWorker {
    fn enqueue(&self, job: UsageCaptureJob) -> Result<(), SendError<UsageCaptureJob>> {
        self.sender.send(job)
    }
}

fn spawn_usage_capture_worker(
    receiver: Receiver<UsageCaptureJob>,
    usage: SharedUsageTelemetry,
    view_events: SharedViewEventBus,
) {
    let spawn_result = thread::Builder::new()
        .name("lucida-usage-capture".to_owned())
        .spawn(move || {
            let policy = ThumbnailPolicy::from_env();
            let mut rate_window = ThumbnailRateWindow::default();
            while let Ok(job) = receiver.recv() {
                let path_for_log = job.path_for_log.clone();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    process_usage_capture_job(job, &usage, &view_events, &policy, &mut rate_window)
                }));
                usage.finish_async_insert();

                if result.is_err() {
                    tracing::warn!(
                        target: "lucida.usage",
                        path = %path_for_log,
                        "usage capture worker panicked while processing telemetry event"
                    );
                }
            }
        });

    if let Err(error) = spawn_result {
        tracing::warn!(
            target: "lucida.usage",
            error = %error,
            "failed to spawn usage capture worker thread"
        );
    }
}

fn process_usage_capture_job(
    job: UsageCaptureJob,
    usage: &SharedUsageTelemetry,
    view_events: &SharedViewEventBus,
    policy: &ThumbnailPolicy,
    rate_window: &mut ThumbnailRateWindow,
) {
    let mut response_json_raw = job.response_json_raw;
    let thumbnail = maybe_create_thumbnail_from_render_response(
        &job.endpoint,
        job.status_code,
        response_json_raw.as_ref(),
        policy,
        rate_window,
    );
    if let Some(thumbnail_metadata) = thumbnail.as_ref() {
        attach_usage_thumbnail(&mut response_json_raw, thumbnail_metadata);
    }

    if let Some(event) = build_view_event(
        &job.endpoint,
        job.status_code,
        job.request_json_raw.as_ref(),
        response_json_raw.as_ref(),
        thumbnail
            .as_ref()
            .map(UsageThumbnailMetadata::to_view_event_thumbnail),
    ) {
        view_events.publish(event);
    }

    let usage_event = UsageEventInsert {
        endpoint: job.endpoint.clone(),
        method: job.method,
        status_code: job.status_code,
        latency_ms: job.latency_ms,
        agent_context: job.agent_context,
        request_json: sanitize_usage_payload(job.request_json_raw),
        response_json: sanitize_usage_payload(response_json_raw),
    };
    if let Err(error) = usage.record_http_event(usage_event) {
        tracing::warn!(
            target: "lucida.usage",
            path = %job.path_for_log,
            error = %error,
            "failed to record usage telemetry event"
        );
    }
}

pub async fn usage_capture_middleware(
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
    let response_json_raw = decode_json_payload(response_bytes.as_ref());
    let response = Response::from_parts(response_parts, Body::from(response_bytes));

    let (usage, usage_capture_worker) = {
        let app_state = state.read().await;
        (
            app_state.usage.clone(),
            app_state.usage_capture_worker.clone(),
        )
    };
    let usage_job = UsageCaptureJob {
        endpoint,
        path_for_log: path.clone(),
        method: method.to_string(),
        status_code,
        latency_ms,
        agent_context,
        request_json_raw,
        response_json_raw,
    };
    usage.begin_async_insert();
    if let Err(error) = usage_capture_worker.enqueue(usage_job) {
        usage.finish_async_insert();
        tracing::warn!(
            target: "lucida.usage",
            path = %path,
            error = %error,
            "failed to enqueue usage telemetry event"
        );
    }

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

fn maybe_create_thumbnail_from_render_response(
    endpoint: &str,
    status_code: u16,
    response_json: Option<&Value>,
    policy: &ThumbnailPolicy,
    rate_window: &mut ThumbnailRateWindow,
) -> Option<UsageThumbnailMetadata> {
    if endpoint != "/render/image" || status_code >= 400 {
        return None;
    }
    let payload = response_json?;
    if !is_inline_base64_delivery(payload) {
        return None;
    }

    let render_id = value_string(payload, &["render_id"])?;
    if !is_safe_render_id(&render_id) {
        return None;
    }

    let now = Utc::now();
    if !policy.allows_render(&render_id, now.timestamp() / 60, rate_window) {
        return None;
    }
    create_thumbnail_from_render_payload(payload, &render_id, now)
}

fn create_thumbnail_from_render_payload(
    payload: &Value,
    render_id: &str,
    now: chrono::DateTime<Utc>,
) -> Option<UsageThumbnailMetadata> {
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

    let date_folder = now.format("%Y-%m-%d").to_string();
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

fn should_sample_render(render_id: &str, sample_rate: f64) -> bool {
    if sample_rate <= 0.0 {
        return false;
    }
    if sample_rate >= 1.0 {
        return true;
    }
    let mut hasher = Sha256::new();
    hasher.update(render_id.as_bytes());
    let digest = hasher.finalize();
    let mut head_bytes = [0_u8; 8];
    head_bytes.copy_from_slice(&digest[..8]);
    let scaled = u64::from_be_bytes(head_bytes) as f64 / u64::MAX as f64;
    scaled < sample_rate
}

fn is_inline_base64_delivery(payload: &Value) -> bool {
    matches!(
        value_string(payload, &["images", "0", "delivery"]).as_deref(),
        Some("inline_base64")
    )
}

fn is_safe_render_id(render_id: &str) -> bool {
    render_id
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-')
}

fn persist_thumbnail(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
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

fn parse_env_f64(name: &str, fallback: f64) -> f64 {
    match std::env::var(name) {
        Ok(raw) => raw.parse::<f64>().unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn parse_env_u32(name: &str, fallback: u32) -> u32 {
    match std::env::var(name) {
        Ok(raw) => raw.parse::<u32>().unwrap_or(fallback),
        Err(_) => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_inline_base64_delivery, should_sample_render, ThumbnailPolicy, ThumbnailRateWindow,
    };
    use serde_json::json;

    #[test]
    fn thumbnail_policy_rate_limit_applies_per_minute_bucket() {
        let policy = ThumbnailPolicy {
            sample_rate: 1.0,
            max_per_minute: 2,
        };
        let mut rate_window = ThumbnailRateWindow::default();

        assert!(policy.allows_render("ren_a", 10, &mut rate_window));
        assert!(policy.allows_render("ren_b", 10, &mut rate_window));
        assert!(!policy.allows_render("ren_c", 10, &mut rate_window));
        assert!(policy.allows_render("ren_d", 11, &mut rate_window));
    }

    #[test]
    fn sampling_gate_respects_zero_and_full_rates() {
        assert!(!should_sample_render("ren_sample", 0.0));
        assert!(should_sample_render("ren_sample", 1.0));
    }

    #[test]
    fn delivery_gate_requires_inline_base64_payloads() {
        let inline_payload = json!({
            "images": [{"delivery": "inline_base64"}]
        });
        let file_payload = json!({
            "images": [{"delivery": "file_path"}]
        });
        let missing_payload = json!({
            "images": [{}]
        });

        assert!(is_inline_base64_delivery(&inline_payload));
        assert!(!is_inline_base64_delivery(&file_payload));
        assert!(!is_inline_base64_delivery(&missing_payload));
    }
}
