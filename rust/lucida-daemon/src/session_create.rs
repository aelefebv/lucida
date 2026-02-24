use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use crate::dto::api::SessionCreateResponse;
use crate::error::ApiError;
use crate::state::{create_session_record, SharedAppState};

pub async fn session_create(
    State(state): State<SharedAppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Json<SessionCreateResponse>, ApiError> {
    let payload = match payload {
        Ok(payload) => payload.0,
        Err(rejection) => {
            return Err(invalid_request_error(vec![json!({
                "loc": ["body"],
                "msg": rejection.body_text(),
                "type": "invalid_json",
            })]));
        }
    };

    parse_session_create_request(payload)?;

    let session = {
        let mut app_state = state.write().await;
        create_session_record(&mut app_state, "session")
    };

    Ok(Json(SessionCreateResponse {
        schema_version: 1,
        session_id: session.session_id,
        created_at: session.created_at,
    }))
}

fn parse_session_create_request(payload: Value) -> Result<(), ApiError> {
    let object = payload.as_object().ok_or_else(|| {
        invalid_request_error(vec![json!({
            "loc": ["body"],
            "msg": "Input should be a valid dictionary.",
            "type": "dict_type",
        })])
    })?;

    let mut errors: Vec<Value> = Vec::new();
    for key in object.keys() {
        if key != "schema_version" {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "Extra inputs are not permitted.",
                "type": "extra_forbidden",
            }));
        }
    }

    let schema_version = match object.get("schema_version") {
        None => 1,
        Some(value) => value.as_u64().unwrap_or(0) as u8,
    };
    if schema_version != 1 {
        errors.push(json!({
            "loc": ["body", "schema_version"],
            "msg": "Input should be 1.",
            "type": "literal_error",
        }));
    }

    if !errors.is_empty() {
        return Err(invalid_request_error(errors));
    }

    Ok(())
}

fn invalid_request_error(errors: Vec<Value>) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_request",
        "Request validation failed.",
        Some(json!({ "errors": errors })),
    )
}
