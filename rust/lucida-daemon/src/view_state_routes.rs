use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::dto::api::{ViewCreateResponse, ViewGetResponse, ViewUpdateResponse};
use crate::dto::view_state::{AxisSelector, DatasetRef, RenderMode, View2D, ViewState, Viewport};
use crate::error::ApiError;
use crate::state::{require_session, resolve_session_id, SharedAppState, ViewRecord};
use crate::view_state_core::{
    default_image_layer, default_selectors, default_view_2d, default_viewport, generate_view_id,
    invalid_patch_error, normalize_selectors, normalize_view_2d, render_mode_name,
    resolve_dataset_for_session, resolve_primary_dataset_for_view, validate_immutable_view_fields,
    validate_multiscale_name, validate_view_state, validate_viewport, with_state_hash,
};

#[derive(Debug, Clone, Deserialize)]
pub struct ViewGetQuery {
    pub session_id: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedViewCreateRequest {
    session_id: Option<String>,
    dataset_id: String,
    mode: RenderMode,
    multiscale_name: Option<String>,
    viewport: Option<Viewport>,
    selectors: Option<Vec<AxisSelector>>,
    view_2d: Option<View2D>,
}

#[derive(Debug, Clone)]
struct ParsedViewUpdateRequest {
    session_id: Option<String>,
    view_id: String,
    patch: Vec<Value>,
}

pub async fn view_create(
    State(state): State<SharedAppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Json<ViewCreateResponse>, ApiError> {
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

    let request = parse_view_create_request(payload)?;

    let response = {
        let mut app_state = state.write().await;
        let session_id = resolve_session_id(&mut app_state, request.session_id.as_deref())?;
        let dataset_summary =
            resolve_dataset_for_session(&mut app_state, &request.dataset_id, &session_id, true)?;

        if request.mode != RenderMode::TwoD {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unsupported_mode",
                "Only mode=2d is supported in this slice.",
                Some(json!({ "mode": render_mode_name(&request.mode) })),
            ));
        }

        let selected_multiscale_name = request
            .multiscale_name
            .clone()
            .unwrap_or_else(|| dataset_summary.multiscales[0].name.clone());
        validate_multiscale_name(&dataset_summary, &selected_multiscale_name)?;

        let selector_input = request
            .selectors
            .clone()
            .unwrap_or_else(|| default_selectors(&dataset_summary));
        let (normalized_selectors, selector_warnings) =
            normalize_selectors(&selector_input, &dataset_summary, "create_view")?;

        let resolved_viewport = request.viewport.clone().unwrap_or_else(default_viewport);
        validate_viewport(&resolved_viewport)?;

        let resolved_view_2d = request.view_2d.clone().unwrap_or_else(|| {
            default_view_2d(&dataset_summary, &normalized_selectors)
                .expect("default view_2d must be derivable from dataset axes")
        });
        let (normalized_view_2d, view_warnings) = normalize_view_2d(
            request.view_2d.clone().unwrap_or(resolved_view_2d),
            &dataset_summary,
            &normalized_selectors,
        )?;

        let view_state = ViewState {
            schema_version: 1,
            view_id: generate_view_id(),
            session_id: session_id.clone(),
            created_at: Some(Utc::now()),
            mode: RenderMode::TwoD,
            datasets: vec![DatasetRef {
                dataset_id: dataset_summary.dataset_id.clone(),
                multiscale_name: selected_multiscale_name.clone(),
            }],
            viewport: resolved_viewport,
            selectors: normalized_selectors.clone(),
            view_2d: Some(normalized_view_2d),
            view_3d: None,
            layers: vec![default_image_layer(
                &dataset_summary,
                &selected_multiscale_name,
            )],
            render_settings: None,
            performance: None,
            state_hash: None,
            state_version: 0,
        };

        validate_view_state(&view_state).map_err(|reason| {
            invalid_patch_error(None, "Patched view state did not validate.", &reason)
        })?;

        let finalized_view = with_state_hash(&view_state, 0);
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

        ViewCreateResponse {
            schema_version: 1,
            view_state: finalized_view,
            warnings,
            selectors_applied: normalized_selectors,
        }
    };

    Ok(Json(response))
}

pub async fn view_get(
    Path(view_id): Path<String>,
    Query(query): Query<ViewGetQuery>,
    State(state): State<SharedAppState>,
) -> Result<Json<ViewGetResponse>, ApiError> {
    let app_state = state.read().await;
    let view_record = app_state.views_by_id.get(&view_id).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "view_not_found",
            "View was not found.",
            Some(json!({ "view_id": view_id })),
        )
    })?;

    if let Some(session_id) = query.session_id.as_deref() {
        let session = require_session(&app_state, session_id)?;
        if !session.view_ids.contains(&view_id) {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "view_not_found",
                "View was not found in session.",
                Some(json!({
                    "view_id": view_id,
                    "session_id": session_id,
                })),
            ));
        }
    }

    Ok(Json(ViewGetResponse {
        schema_version: 1,
        view_state: view_record.view_state.clone(),
    }))
}

pub async fn view_update(
    State(state): State<SharedAppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Json<ViewUpdateResponse>, ApiError> {
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

    let request = parse_view_update_request(payload)?;

    let response = {
        let mut app_state = state.write().await;

        let current_view_state = app_state
            .views_by_id
            .get(&request.view_id)
            .map(|record| record.view_state.clone())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::NOT_FOUND,
                    "view_not_found",
                    "View was not found.",
                    Some(json!({ "view_id": request.view_id })),
                )
            })?;

        let scoped_session_id = if let Some(session_id) = request.session_id.as_deref() {
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
            session_id.to_owned()
        } else {
            current_view_state.session_id.clone()
        };
        require_session(&app_state, &scoped_session_id)?;

        let current_payload =
            serde_json::to_value(&current_view_state).expect("serialize current view");
        let mut patched_payload = current_payload;
        let patch: json_patch::Patch = serde_json::from_value(Value::Array(request.patch.clone()))
            .map_err(|error| {
                invalid_patch_error(
                    Some(&request.view_id),
                    "Failed to apply JSON patch.",
                    &error.to_string(),
                )
            })?;
        json_patch::patch(&mut patched_payload, &patch).map_err(|error| {
            invalid_patch_error(
                Some(&request.view_id),
                "Failed to apply JSON patch.",
                &error.to_string(),
            )
        })?;

        let mut candidate: ViewState =
            serde_json::from_value(patched_payload).map_err(|error| {
                invalid_patch_error(
                    Some(&request.view_id),
                    "Patched view state did not validate.",
                    &error.to_string(),
                )
            })?;

        validate_view_state(&candidate).map_err(|reason| {
            invalid_patch_error(
                Some(&request.view_id),
                "Patched view state did not validate.",
                &reason,
            )
        })?;

        if candidate.mode != RenderMode::TwoD {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unsupported_mode",
                "Only mode=2d is supported in this slice.",
                Some(json!({ "mode": render_mode_name(&candidate.mode) })),
            ));
        }

        validate_immutable_view_fields(&current_view_state, &candidate)?;

        let primary_dataset_summary =
            resolve_primary_dataset_for_view(&mut app_state, &candidate, &scoped_session_id)?;

        let (selectors, selector_warnings) = normalize_selectors(
            &candidate.selectors,
            &primary_dataset_summary,
            "update_view",
        )?;
        candidate.selectors = selectors.clone();

        let candidate_view_2d = candidate.view_2d.clone().ok_or_else(|| {
            invalid_patch_error(
                Some(&request.view_id),
                "Patched view state did not validate.",
                "mode=2d requires view_2d.",
            )
        })?;
        let (normalized_view_2d, view_warnings) =
            normalize_view_2d(candidate_view_2d, &primary_dataset_summary, &selectors)?;
        candidate.view_2d = Some(normalized_view_2d);

        let next_state_version = current_view_state.state_version + 1;
        let finalized = with_state_hash(&candidate, next_state_version);

        app_state.views_by_id.insert(
            request.view_id.clone(),
            ViewRecord {
                session_id: scoped_session_id,
                view_state: finalized.clone(),
            },
        );

        let mut warnings = selector_warnings;
        warnings.extend(view_warnings);

        ViewUpdateResponse {
            schema_version: 1,
            view_state: finalized,
            warnings,
            selectors_applied: selectors,
        }
    };

    Ok(Json(response))
}

fn parse_view_create_request(payload: Value) -> Result<ParsedViewCreateRequest, ApiError> {
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
        "session_id",
        "dataset_id",
        "mode",
        "multiscale_name",
        "viewport",
        "selectors",
        "view_2d",
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

    let schema_version = parse_schema_version(object, &mut errors);
    if schema_version != 1 {
        errors.push(json!({
            "loc": ["body", "schema_version"],
            "msg": "Input should be 1.",
            "type": "literal_error",
        }));
    }

    let session_id = parse_optional_non_empty_string(object, "session_id", &mut errors);
    let dataset_id = parse_required_non_empty_string(object, "dataset_id", &mut errors);
    let multiscale_name = parse_optional_non_empty_string(object, "multiscale_name", &mut errors);

    let mode = match object.get("mode") {
        None => RenderMode::TwoD,
        Some(value) if value.is_null() => {
            errors.push(json!({
                "loc": ["body", "mode"],
                "msg": "Input should be '2d' or '3d'.",
                "type": "literal_error",
            }));
            RenderMode::TwoD
        }
        Some(value) => match value.as_str() {
            Some("2d") => RenderMode::TwoD,
            Some("3d") => RenderMode::ThreeD,
            _ => {
                errors.push(json!({
                    "loc": ["body", "mode"],
                    "msg": "Input should be '2d' or '3d'.",
                    "type": "literal_error",
                }));
                RenderMode::TwoD
            }
        },
    };

    let viewport = parse_optional_typed::<Viewport>(object, "viewport", &mut errors);
    let selectors = parse_optional_typed::<Vec<AxisSelector>>(object, "selectors", &mut errors);
    let view_2d = parse_optional_typed::<View2D>(object, "view_2d", &mut errors);

    if !errors.is_empty() {
        return Err(invalid_request_error(errors));
    }

    Ok(ParsedViewCreateRequest {
        session_id,
        dataset_id: dataset_id.unwrap_or_default(),
        mode,
        multiscale_name,
        viewport,
        selectors,
        view_2d,
    })
}

fn parse_view_update_request(payload: Value) -> Result<ParsedViewUpdateRequest, ApiError> {
    let object = payload.as_object().ok_or_else(|| {
        invalid_request_error(vec![json!({
            "loc": ["body"],
            "msg": "Input should be a valid dictionary.",
            "type": "dict_type",
        })])
    })?;

    let mut errors: Vec<Value> = Vec::new();
    let allowed_keys = ["schema_version", "session_id", "view_id", "patch"];
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
    let view_id = parse_required_non_empty_string(object, "view_id", &mut errors);

    let patch = match object.get("patch") {
        None => {
            errors.push(json!({
                "loc": ["body", "patch"],
                "msg": "Field required.",
                "type": "missing",
            }));
            Vec::new()
        }
        Some(value) => match value.as_array() {
            Some(items) if items.is_empty() => {
                errors.push(json!({
                    "loc": ["body", "patch"],
                    "msg": "List should have at least 1 item after validation, not 0.",
                    "type": "too_short",
                }));
                Vec::new()
            }
            Some(items) => items.clone(),
            None => {
                errors.push(json!({
                    "loc": ["body", "patch"],
                    "msg": "Input should be a valid list.",
                    "type": "list_type",
                }));
                Vec::new()
            }
        },
    };

    if !errors.is_empty() {
        return Err(invalid_request_error(errors));
    }

    Ok(ParsedViewUpdateRequest {
        session_id,
        view_id: view_id.unwrap_or_default(),
        patch,
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

fn parse_optional_typed<T>(
    object: &serde_json::Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<T>
where
    T: for<'de> Deserialize<'de>,
{
    let value = object.get(key)?;
    if value.is_null() {
        return None;
    }
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
