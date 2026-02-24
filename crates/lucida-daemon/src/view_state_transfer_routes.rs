use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::dto::api::{ViewStateExportResponse, ViewStateImportResponse};
use crate::dto::view_state::{RenderMode, ViewState};
use crate::error::ApiError;
use crate::state::{require_session, resolve_session_id, SharedAppState, ViewRecord};
use crate::view_state_core::{
    normalize_selectors, normalize_view_2d, rebase_imported_view_identity, render_mode_name,
    resolve_primary_dataset_for_view, validate_import_dataset_scope, validate_view_state,
    with_state_hash,
};

#[derive(Debug, Clone)]
struct ParsedViewStateExportRequest {
    view_id: String,
    session_id: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedViewStateImportRequest {
    session_id: Option<String>,
    view_state: ViewState,
}

pub async fn export_viewstate(
    State(state): State<SharedAppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Json<ViewStateExportResponse>, ApiError> {
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

    let request = parse_export_request(payload)?;
    let response = {
        let app_state = state.read().await;
        let view_record = app_state.views_by_id.get(&request.view_id).ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "view_not_found",
                "View was not found.",
                Some(json!({ "view_id": request.view_id })),
            )
        })?;

        if let Some(session_id) = request.session_id.as_deref() {
            let session = require_session(&app_state, session_id)?;
            if !session.view_ids.contains(&request.view_id) {
                return Err(ApiError::new(
                    StatusCode::NOT_FOUND,
                    "view_not_found",
                    "View was not found in session.",
                    Some(json!({
                        "view_id": request.view_id,
                        "session_id": session_id,
                    })),
                ));
            }
        }

        ViewStateExportResponse {
            schema_version: 1,
            export_id: format!("exp_{}", &Uuid::new_v4().simple().to_string()[..16]),
            exported_at: chrono::Utc::now(),
            source_view_id: request.view_id.clone(),
            view_state: view_record.view_state.clone(),
            warnings: Vec::new(),
        }
    };

    Ok(Json(response))
}

pub async fn import_viewstate(
    State(state): State<SharedAppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Json<ViewStateImportResponse>, ApiError> {
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

    let request = parse_import_request(payload)?;
    let response = {
        let mut app_state = state.write().await;
        let session_id = resolve_session_id(&mut app_state, request.session_id.as_deref())?;

        if request.view_state.mode != RenderMode::TwoD {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unsupported_mode",
                "Only mode=2d is supported in this slice.",
                Some(json!({ "mode": render_mode_name(&request.view_state.mode) })),
            ));
        }

        validate_import_dataset_scope(&request.view_state)?;

        let primary_dataset_summary =
            resolve_primary_dataset_for_view(&mut app_state, &request.view_state, &session_id)?;

        let (selectors, selector_warnings) = normalize_selectors(
            &request.view_state.selectors,
            &primary_dataset_summary,
            "import_viewstate",
        )?;
        let mut normalized_view = request.view_state.clone();
        normalized_view.selectors = selectors.clone();

        let candidate_view_2d = normalized_view.view_2d.clone().ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_viewstate_import",
                "Imported view state did not validate.",
                Some(json!({ "reason": "mode=2d requires view_2d." })),
            )
        })?;
        let (normalized_view_2d, view_warnings) =
            normalize_view_2d(candidate_view_2d, &primary_dataset_summary, &selectors)?;
        normalized_view.view_2d = Some(normalized_view_2d);

        let rebased_view = rebase_imported_view_identity(&normalized_view, &session_id);
        validate_view_state(&rebased_view).map_err(|reason| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_viewstate_import",
                "Imported view state did not validate.",
                Some(json!({ "reason": reason })),
            )
        })?;
        let finalized_view = with_state_hash(&rebased_view, 0);

        app_state.views_by_id.insert(
            finalized_view.view_id.clone(),
            ViewRecord {
                session_id: session_id.clone(),
                view_state: finalized_view.clone(),
            },
        );
        if let Some(session) = app_state.sessions_by_id.get_mut(&session_id) {
            session.view_ids.insert(finalized_view.view_id.clone());
        }

        let mut warnings = selector_warnings;
        warnings.extend(view_warnings);

        ViewStateImportResponse {
            schema_version: 1,
            import_id: format!("imp_{}", &Uuid::new_v4().simple().to_string()[..16]),
            imported_from_view_id: Some(request.view_state.view_id.clone()),
            view_state: finalized_view,
            warnings,
            selectors_applied: selectors,
        }
    };

    Ok(Json(response))
}

fn parse_export_request(payload: Value) -> Result<ParsedViewStateExportRequest, ApiError> {
    let object = payload.as_object().ok_or_else(|| {
        invalid_request_error(vec![json!({
            "loc": ["body"],
            "msg": "Input should be a valid dictionary.",
            "type": "dict_type",
        })])
    })?;

    let mut errors: Vec<Value> = Vec::new();
    let allowed_keys = ["schema_version", "view_id", "session_id"];
    for key in object.keys() {
        if !allowed_keys.contains(&key.as_str()) {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "Extra inputs are not permitted.",
                "type": "extra_forbidden",
            }));
        }
    }

    let schema_version = parse_schema_version(object, &mut errors);
    if schema_version != 1 {
        errors.push(json!({
            "loc": ["body", "schema_version"],
            "msg": "Input should be 1.",
            "type": "literal_error",
        }));
    }

    let view_id = parse_required_non_empty_string(object, "view_id", &mut errors);
    let session_id = parse_optional_non_empty_string(object, "session_id", &mut errors);

    if !errors.is_empty() {
        return Err(invalid_request_error(errors));
    }

    Ok(ParsedViewStateExportRequest {
        view_id: view_id.unwrap_or_default(),
        session_id,
    })
}

fn parse_import_request(payload: Value) -> Result<ParsedViewStateImportRequest, ApiError> {
    let object = payload.as_object().ok_or_else(|| {
        invalid_request_error(vec![json!({
            "loc": ["body"],
            "msg": "Input should be a valid dictionary.",
            "type": "dict_type",
        })])
    })?;

    let mut errors: Vec<Value> = Vec::new();
    let allowed_keys = ["schema_version", "session_id", "view_state"];
    for key in object.keys() {
        if !allowed_keys.contains(&key.as_str()) {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "Extra inputs are not permitted.",
                "type": "extra_forbidden",
            }));
        }
    }

    let schema_version = parse_schema_version(object, &mut errors);
    if schema_version != 1 {
        errors.push(json!({
            "loc": ["body", "schema_version"],
            "msg": "Input should be 1.",
            "type": "literal_error",
        }));
    }

    let session_id = parse_optional_non_empty_string(object, "session_id", &mut errors);
    let view_state = parse_required_typed::<ViewState>(object, "view_state", &mut errors);

    if !errors.is_empty() {
        return Err(invalid_request_error(errors));
    }

    Ok(ParsedViewStateImportRequest {
        session_id,
        view_state: view_state.expect("view_state validated"),
    })
}

fn parse_schema_version(object: &serde_json::Map<String, Value>, errors: &mut Vec<Value>) -> u8 {
    match object.get("schema_version") {
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
    }
}

fn parse_required_non_empty_string(
    object: &serde_json::Map<String, Value>,
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
    object: &serde_json::Map<String, Value>,
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

fn parse_required_typed<T>(
    object: &serde_json::Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<T>
where
    T: for<'de> Deserialize<'de>,
{
    let value = match object.get(key) {
        Some(value) => value,
        None => {
            errors.push(json!({
                "loc": ["body", key],
                "msg": "Field required.",
                "type": "missing",
            }));
            return None;
        }
    };
    match serde_json::from_value::<T>(value.clone()) {
        Ok(parsed) => Some(parsed),
        Err(error) => {
            errors.push(json!({
                "loc": ["body", key],
                "msg": error.to_string(),
                "type": "value_error",
            }));
            None
        }
    }
}

fn invalid_request_error(errors: Vec<Value>) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_request",
        "Request validation failed.",
        Some(json!({ "errors": errors })),
    )
}
