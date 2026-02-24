use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use lucida_daemon::error::{ApiError, ErrorEnvelope};
use serde_json::json;

#[test]
fn error_envelope_serializes_shape() {
    let envelope = ErrorEnvelope::new(
        "invalid_request",
        "Request validation failed.",
        Some(json!({"field": "value"})),
    );
    let payload = serde_json::to_value(&envelope).expect("serialize");
    assert_eq!(payload["code"], "invalid_request");
    assert_eq!(payload["message"], "Request validation failed.");
    assert_eq!(payload["details"]["field"], "value");
}

#[tokio::test]
async fn api_error_into_response_uses_status_and_envelope() {
    let error = ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_patch",
        "Failed to apply JSON patch.",
        Some(json!({"view_id": "view_123"})),
    );
    let response = error.into_response();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let body = response
        .into_body()
        .collect()
        .await
        .expect("read body")
        .to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(payload["code"], "invalid_patch");
    assert_eq!(payload["message"], "Failed to apply JSON patch.");
    assert_eq!(payload["details"]["view_id"], "view_123");
}
