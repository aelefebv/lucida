use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ErrorEnvelope {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl ErrorEnvelope {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status_code: StatusCode,
    pub envelope: ErrorEnvelope,
}

impl ApiError {
    pub fn new(
        status_code: StatusCode,
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<Value>,
    ) -> Self {
        Self {
            status_code,
            envelope: ErrorEnvelope::new(code, message, details),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status_code, Json(self.envelope)).into_response()
    }
}
