use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Map, Value};

use crate::dto::api::{DatasetOpenRequest, DatasetOpenResponse};
use crate::dto::dataset_summary::{DatasetHints, DatasetSummary};
use crate::error::ApiError;
use crate::omezarr::read_omezarr;
use crate::state::{create_session_record, DatasetRecord, SharedAppState};
use crate::uri::{generate_dataset_id, is_remote_uri, normalize_uri};

pub async fn dataset_open(
    State(state): State<SharedAppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Json<DatasetOpenResponse>, ApiError> {
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

    let request = parse_dataset_open_request(payload)?;
    let normalized_uri = normalize_uri(&request.uri);
    let resolved_dataset_id = request
        .dataset_id
        .clone()
        .unwrap_or_else(|| generate_dataset_id(&normalized_uri));

    let (read_result, warnings) = read_omezarr(&normalized_uri, request.include_full_raw_metadata)?;

    let hints = DatasetHints {
        recommended_tile_px: read_result.recommended_tile_px,
        is_remote: Some(is_remote_uri(&normalized_uri)),
    };

    let dataset_summary = DatasetSummary {
        schema_version: 1,
        dataset_id: resolved_dataset_id.clone(),
        uri: normalized_uri,
        opened_at: Some(chrono::Utc::now()),
        axes: read_result.axes,
        shape: read_result.shape,
        dtype: read_result.dtype,
        world_units: Some("micron".to_owned()),
        channels: Some(read_result.channels),
        multiscales: read_result.multiscales,
        hints: Some(hints),
        raw_metadata: Some(read_result.raw_metadata),
    };

    {
        let mut app_state = state.write().await;
        let session_id = resolve_session_id(&mut app_state, request.session_id.as_deref())?;
        let dataset_record = app_state
            .datasets_by_id
            .entry(resolved_dataset_id.clone())
            .or_insert_with(|| DatasetRecord {
                dataset_summary: dataset_summary.clone(),
                session_ids: std::collections::HashSet::new(),
            });
        dataset_record.dataset_summary = dataset_summary.clone();
        dataset_record.session_ids.insert(session_id.clone());
        if let Some(session) = app_state.sessions_by_id.get_mut(&session_id) {
            session.dataset_ids.insert(resolved_dataset_id);
        }
    }

    Ok(Json(DatasetOpenResponse {
        schema_version: 1,
        dataset_summary,
        warnings,
    }))
}

fn resolve_session_id(
    state: &mut crate::state::AppState,
    session_id: Option<&str>,
) -> Result<String, ApiError> {
    if let Some(session_id) = session_id {
        if state.sessions_by_id.contains_key(session_id) {
            return Ok(session_id.to_owned());
        }
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "session_not_found",
            "Session was not found.",
            Some(json!({ "session_id": session_id })),
        ));
    }
    if state.compat_session_id.is_none() {
        let compat_session = create_session_record(state, "compat");
        state.compat_session_id = Some(compat_session.session_id.clone());
    }
    Ok(state
        .compat_session_id
        .clone()
        .expect("compat session id must be initialized"))
}

fn parse_dataset_open_request(payload: Value) -> Result<DatasetOpenRequest, ApiError> {
    let object = payload.as_object().ok_or_else(|| {
        invalid_request_error(vec![json!({
            "loc": ["body"],
            "msg": "Input should be a valid dictionary.",
            "type": "dict_type",
        })])
    })?;

    let mut errors: Vec<Value> = Vec::new();
    let allowed_keys = [
        "schema_version",
        "uri",
        "dataset_id",
        "session_id",
        "include_full_raw_metadata",
    ];
    for key in object.keys() {
        if !allowed_keys.contains(&key.as_str()) {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "Extra inputs are not permitted.",
                "type": "extra_forbidden",
            }));
        }
    }

    let schema_version = match object.get("schema_version") {
        None => 1,
        Some(value) => {
            if let Some(raw) = value.as_u64() {
                raw as u8
            } else if let Some(raw) = value.as_i64() {
                if raw >= 0 {
                    raw as u8
                } else {
                    errors.push(json!({
                        "loc": ["body", "schema_version"],
                        "msg": "Input should be 1.",
                        "type": "literal_error",
                    }));
                    0
                }
            } else {
                errors.push(json!({
                    "loc": ["body", "schema_version"],
                    "msg": "Input should be 1.",
                    "type": "literal_error",
                }));
                0
            }
        }
    };
    if schema_version != 1 {
        errors.push(json!({
            "loc": ["body", "schema_version"],
            "msg": "Input should be 1.",
            "type": "literal_error",
        }));
    }

    let uri = parse_required_non_empty_string(object, "uri", &mut errors);
    let dataset_id = parse_optional_non_empty_string(object, "dataset_id", &mut errors);
    let session_id = parse_optional_non_empty_string(object, "session_id", &mut errors);
    let include_full_raw_metadata =
        parse_optional_bool(object, "include_full_raw_metadata", &mut errors).unwrap_or(false);

    if !errors.is_empty() {
        return Err(invalid_request_error(errors));
    }

    Ok(DatasetOpenRequest {
        schema_version: 1,
        uri: uri.unwrap_or_default(),
        dataset_id,
        session_id,
        include_full_raw_metadata,
    })
}

fn parse_required_non_empty_string(
    object: &Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<String> {
    match object.get(key) {
        Some(value) => {
            if let Some(as_str) = value.as_str() {
                if as_str.is_empty() {
                    errors.push(json!({
                        "loc": ["body", key],
                        "msg": "String should have at least 1 character.",
                        "type": "string_too_short",
                        "ctx": {"min_length": 1},
                    }));
                    None
                } else {
                    Some(as_str.to_owned())
                }
            } else {
                errors.push(json!({
                    "loc": ["body", key],
                    "msg": "Input should be a valid string.",
                    "type": "string_type",
                }));
                None
            }
        }
        None => {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "Field required.",
                "type": "missing",
            }));
            None
        }
    }
}

fn parse_optional_non_empty_string(
    object: &Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<String> {
    let value = object.get(key)?;
    if value.is_null() {
        return None;
    }
    if let Some(as_str) = value.as_str() {
        if as_str.is_empty() {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "String should have at least 1 character.",
                "type": "string_too_short",
                "ctx": {"min_length": 1},
            }));
            return None;
        }
        return Some(as_str.to_owned());
    }
    errors.push(json!({
        "loc": ["body", key],
        "msg": "Input should be a valid string.",
        "type": "string_type",
    }));
    None
}

fn parse_optional_bool(
    object: &Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<bool> {
    let value = object.get(key)?;
    if value.is_null() {
        return None;
    }
    if let Some(as_bool) = value.as_bool() {
        return Some(as_bool);
    }
    errors.push(json!({
        "loc": ["body", key],
        "msg": "Input should be a valid boolean.",
        "type": "bool_type",
    }));
    None
}

fn invalid_request_error(errors: Vec<Value>) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_request",
        "Request validation failed.",
        Some(json!({ "errors": errors })),
    )
}
