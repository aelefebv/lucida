use std::collections::{BTreeMap, HashMap};

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Number, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::dto::api::{ApiWarning, ViewCreateResponse, ViewGetResponse, ViewUpdateResponse};
use crate::dto::dataset_summary::{AxisDef, AxisRole, ChannelDef, ContrastPolicy, DatasetSummary};
use crate::dto::view_state::{
    AxisSelector, AxisSelectorKind, Camera2D, ChannelContrast, ChannelContrastPolicy, ChannelMode,
    DatasetRef, ImageChannelSettings, ImageLayerSettings, InterpolationMode, LayerSource,
    LayerState, LayerType, Plane2D, RenderMode, SlabMode, SlabSettings, SliceSettings, View2D,
    ViewState, Viewport,
};
use crate::error::ApiError;
use crate::state::{
    ensure_dataset_attached, require_session, resolve_session_id, SharedAppState, ViewRecord,
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

fn validate_viewport(viewport: &Viewport) -> Result<(), ApiError> {
    if viewport.width_px == 0 || viewport.height_px == 0 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request",
            "Request validation failed.",
            Some(json!({
                "errors": [
                    {
                        "loc": ["body", "viewport"],
                        "msg": "Viewport dimensions must be >= 1.",
                        "type": "greater_than_equal",
                    }
                ]
            })),
        ));
    }
    if viewport.pixel_ratio < 0.5 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request",
            "Request validation failed.",
            Some(json!({
                "errors": [
                    {
                        "loc": ["body", "viewport", "pixel_ratio"],
                        "msg": "Input should be greater than or equal to 0.5.",
                        "type": "greater_than_equal",
                    }
                ]
            })),
        ));
    }
    Ok(())
}

fn resolve_dataset_for_session(
    app_state: &mut crate::state::AppState,
    dataset_id: &str,
    session_id: &str,
    attach_if_missing: bool,
) -> Result<DatasetSummary, ApiError> {
    let dataset_summary = app_state
        .datasets_by_id
        .get(dataset_id)
        .map(|record| record.dataset_summary.clone())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "dataset_not_found",
                "Dataset was not found.",
                Some(json!({ "dataset_id": dataset_id })),
            )
        })?;

    if attach_if_missing {
        ensure_dataset_attached(app_state, dataset_id, session_id);
    }

    Ok(dataset_summary)
}

fn resolve_primary_dataset_for_view(
    app_state: &mut crate::state::AppState,
    view_state: &ViewState,
    session_id: &str,
) -> Result<DatasetSummary, ApiError> {
    let dataset_ref = view_state.datasets.first().ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_patch",
            "Patched view state did not validate.",
            Some(json!({ "reason": "View state must include at least one dataset reference." })),
        )
    })?;
    let dataset_summary =
        resolve_dataset_for_session(app_state, &dataset_ref.dataset_id, session_id, true)?;
    validate_multiscale_name(&dataset_summary, &dataset_ref.multiscale_name)?;
    Ok(dataset_summary)
}

fn validate_multiscale_name(
    dataset_summary: &DatasetSummary,
    multiscale_name: &str,
) -> Result<(), ApiError> {
    if dataset_summary
        .multiscales
        .iter()
        .any(|multiscale| multiscale.name == multiscale_name)
    {
        return Ok(());
    }

    let mut available: Vec<String> = dataset_summary
        .multiscales
        .iter()
        .map(|item| item.name.clone())
        .collect();
    available.sort();

    Err(ApiError::new(
        StatusCode::NOT_FOUND,
        "dataset_not_found",
        "Requested multiscale was not found in dataset.",
        Some(json!({
            "dataset_id": dataset_summary.dataset_id,
            "multiscale_name": multiscale_name,
            "available_multiscales": available,
        })),
    ))
}

fn default_viewport() -> Viewport {
    Viewport {
        width_px: 1024,
        height_px: 1024,
        pixel_ratio: 1.0,
    }
}

fn default_selectors(dataset_summary: &DatasetSummary) -> Vec<AxisSelector> {
    let mut selectors: Vec<AxisSelector> = dataset_summary
        .axes
        .iter()
        .filter(|axis| !matches!(axis.role, AxisRole::X | AxisRole::Y))
        .map(|axis| AxisSelector {
            axis: axis.name.clone(),
            kind: AxisSelectorKind::Index,
            index: Some(0),
            start: None,
            end_exclusive: None,
            indices: None,
            clamp: true,
        })
        .collect();

    if selectors.is_empty() {
        selectors.push(AxisSelector {
            axis: dataset_summary.axes[0].name.clone(),
            kind: AxisSelectorKind::Index,
            index: Some(0),
            start: None,
            end_exclusive: None,
            indices: None,
            clamp: true,
        });
    }
    selectors
}

fn default_view_2d(
    dataset_summary: &DatasetSummary,
    selectors: &[AxisSelector],
) -> Result<View2D, ApiError> {
    let (u_role, v_role, orth_role) = plane_role_triplet(&Plane2D::Xy);
    let u_axis_name = axis_name_for_role(dataset_summary, u_role, &Plane2D::Xy)?;
    let v_axis_name = axis_name_for_role(dataset_summary, v_role, &Plane2D::Xy)?;
    let slice_axis_name = axis_name_for_role(dataset_summary, orth_role, &Plane2D::Xy)?;

    let axis_sizes: HashMap<String, i64> = dataset_summary
        .axes
        .iter()
        .map(|axis| {
            (
                axis.name.clone(),
                i64::try_from(axis.size).unwrap_or(i64::MAX),
            )
        })
        .collect();

    let slice_index = selector_index_for_axis(selectors, &slice_axis_name);
    let u_size = *axis_sizes.get(&u_axis_name).unwrap_or(&1);
    let v_size = *axis_sizes.get(&v_axis_name).unwrap_or(&1);

    Ok(View2D {
        plane: Plane2D::Xy,
        slice: Some(SliceSettings {
            axis: Some(slice_axis_name),
            index: Some(slice_index),
            slab: Some(SlabSettings {
                thickness_vox: 1,
                mode: SlabMode::Single,
            }),
        }),
        camera: Camera2D {
            center_world: (u_size as f64 / 2.0, v_size as f64 / 2.0),
            zoom: 1.0,
            rotation_deg: 0.0,
        },
    })
}

fn default_image_layer(dataset_summary: &DatasetSummary, multiscale_name: &str) -> LayerState {
    let channels = default_image_channels(dataset_summary);
    let channel_mode = if channels.len() <= 1 {
        ChannelMode::Single
    } else {
        ChannelMode::Composite
    };

    LayerState {
        layer_id: "image_0".to_owned(),
        layer_type: LayerType::Image,
        dataset_id: Some(dataset_summary.dataset_id.clone()),
        source: Some(LayerSource {
            multiscale_name: Some(multiscale_name.to_owned()),
            array_path: None,
        }),
        visible: true,
        opacity: 1.0,
        image: Some(ImageLayerSettings {
            channel_mode,
            channels,
            interpolation: InterpolationMode::Linear,
        }),
        labels: None,
    }
}

fn default_image_channels(dataset_summary: &DatasetSummary) -> Vec<ImageChannelSettings> {
    if let Some(channels) = dataset_summary.channels.as_ref() {
        if !channels.is_empty() {
            return channels.iter().map(default_channel_from_metadata).collect();
        }
    }

    let channel_count = dataset_summary
        .axes
        .iter()
        .find(|axis| matches!(axis.role, AxisRole::C))
        .map(|axis| axis.size)
        .unwrap_or(1);

    let mut channels: Vec<ImageChannelSettings> = Vec::new();
    for index in 0..channel_count {
        channels.push(ImageChannelSettings {
            index,
            enabled: true,
            color_rgba: None,
            contrast: None,
            gamma: 1.0,
        });
    }
    channels
}

fn default_channel_from_metadata(channel: &ChannelDef) -> ImageChannelSettings {
    let contrast = channel.suggested_contrast.as_ref().map(|suggested| {
        let policy = match suggested.policy {
            Some(ContrastPolicy::Fixed) => ChannelContrastPolicy::Fixed,
            Some(ContrastPolicy::Percentile) => ChannelContrastPolicy::Percentile,
            None if suggested.min.is_some() => ChannelContrastPolicy::Fixed,
            None => ChannelContrastPolicy::Percentile,
        };
        ChannelContrast {
            policy,
            min: suggested.min,
            max: suggested.max,
            p_low: suggested.p_low.unwrap_or(1.0),
            p_high: suggested.p_high.unwrap_or(99.0),
        }
    });

    ImageChannelSettings {
        index: channel.index,
        enabled: true,
        color_rgba: channel.color_rgba,
        contrast,
        gamma: channel.suggested_gamma.unwrap_or(1.0),
    }
}

fn normalize_view_2d(
    view_2d: View2D,
    dataset_summary: &DatasetSummary,
    selectors: &[AxisSelector],
) -> Result<(View2D, Vec<ApiWarning>), ApiError> {
    let mut warnings: Vec<ApiWarning> = Vec::new();

    let (_, _, orth_role) = plane_role_triplet(&view_2d.plane);
    let slice_axis = axis_name_for_role(dataset_summary, orth_role, &view_2d.plane)?;
    let requested_slice_axis = view_2d.slice.as_ref().and_then(|slice| slice.axis.clone());
    if let Some(requested) = requested_slice_axis {
        if requested != slice_axis {
            warnings.push(ApiWarning {
                code: "slice_axis_forced_to_plane".to_owned(),
                message: "Slice axis was replaced to match plane orthogonal axis.".to_owned(),
                details: Some(json!({
                    "plane": plane_name(&view_2d.plane),
                    "requested_axis": requested,
                    "applied_axis": slice_axis,
                })),
            });
        }
    }

    let axis_sizes: HashMap<String, i64> = dataset_summary
        .axes
        .iter()
        .map(|axis| {
            (
                axis.name.clone(),
                i64::try_from(axis.size).unwrap_or(i64::MAX),
            )
        })
        .collect();

    let requested_slice_index = view_2d
        .slice
        .as_ref()
        .and_then(|slice| slice.index)
        .unwrap_or_else(|| selector_index_for_axis(selectors, &slice_axis));

    let axis_size = *axis_sizes.get(&slice_axis).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_plane",
            "Requested plane is unsupported for dataset axes.",
            Some(json!({
                "plane": plane_name(&view_2d.plane),
                "dataset_id": dataset_summary.dataset_id,
            })),
        )
    })?;

    let clamped_slice_index = clamp_index(requested_slice_index, axis_size);
    if clamped_slice_index != requested_slice_index {
        warnings.push(ApiWarning {
            code: "slice_index_clamped".to_owned(),
            message: "Slice index exceeded axis bounds and was clamped.".to_owned(),
            details: Some(json!({
                "axis": slice_axis,
                "requested_index": requested_slice_index,
                "applied_index": clamped_slice_index,
            })),
        });
    }

    let slab = view_2d
        .slice
        .as_ref()
        .and_then(|slice| slice.slab.clone())
        .unwrap_or(SlabSettings {
            thickness_vox: 1,
            mode: SlabMode::Single,
        });

    Ok((
        View2D {
            plane: view_2d.plane,
            camera: view_2d.camera,
            slice: Some(SliceSettings {
                axis: Some(slice_axis),
                index: Some(clamped_slice_index),
                slab: Some(slab),
            }),
        },
        warnings,
    ))
}

fn normalize_selectors(
    selectors: &[AxisSelector],
    dataset_summary: &DatasetSummary,
    operation: &str,
) -> Result<(Vec<AxisSelector>, Vec<ApiWarning>), ApiError> {
    if selectors.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "At least one selector is required.",
            Some(json!({ "operation": operation })),
        ));
    }

    let axis_sizes: HashMap<String, i64> = dataset_summary
        .axes
        .iter()
        .map(|axis| {
            (
                axis.name.clone(),
                i64::try_from(axis.size).unwrap_or(i64::MAX),
            )
        })
        .collect();

    let mut normalized: Vec<AxisSelector> = Vec::new();
    let mut warnings: Vec<ApiWarning> = Vec::new();

    for selector in selectors {
        let axis_size = axis_sizes.get(&selector.axis).copied().ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "selector_out_of_bounds",
                "Selector axis does not exist in dataset.",
                Some(json!({
                    "axis": selector.axis,
                    "dataset_id": dataset_summary.dataset_id,
                })),
            )
        })?;

        let (normalized_selector, warning) = match selector.kind {
            AxisSelectorKind::Index => normalize_index_selector(selector, axis_size)?,
            AxisSelectorKind::Range => normalize_range_selector(selector, axis_size)?,
            AxisSelectorKind::Set => normalize_set_selector(selector, axis_size)?,
        };

        if let Some(warning) = warning {
            warnings.push(warning);
        }
        normalized.push(normalized_selector);
    }

    Ok((normalized, warnings))
}

fn normalize_index_selector(
    selector: &AxisSelector,
    axis_size: i64,
) -> Result<(AxisSelector, Option<ApiWarning>), ApiError> {
    let requested = selector.index.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Index selector requires index.",
            Some(json!({ "axis": selector.axis })),
        )
    })?;

    if !selector.clamp && !(0 <= requested && requested < axis_size) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Selector index is out of bounds and clamp is disabled.",
            Some(json!({
                "axis": selector.axis,
                "index": requested,
                "size": axis_size,
            })),
        ));
    }

    let applied = clamp_index(requested, axis_size);
    let warning = if applied != requested {
        Some(ApiWarning {
            code: "selector_clamped".to_owned(),
            message: "Selector index was clamped to fit axis bounds.".to_owned(),
            details: Some(json!({
                "axis": selector.axis,
                "requested": requested,
                "applied": applied,
            })),
        })
    } else {
        None
    };

    Ok((
        AxisSelector {
            axis: selector.axis.clone(),
            kind: AxisSelectorKind::Index,
            index: Some(applied),
            start: None,
            end_exclusive: None,
            indices: None,
            clamp: selector.clamp,
        },
        warning,
    ))
}

fn normalize_range_selector(
    selector: &AxisSelector,
    axis_size: i64,
) -> Result<(AxisSelector, Option<ApiWarning>), ApiError> {
    let requested_start = selector.start.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Range selector requires start and end_exclusive.",
            Some(json!({ "axis": selector.axis })),
        )
    })?;
    let requested_end = selector.end_exclusive.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Range selector requires start and end_exclusive.",
            Some(json!({ "axis": selector.axis })),
        )
    })?;

    if !selector.clamp
        && !(0 <= requested_start && requested_start < requested_end && requested_end <= axis_size)
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Selector range is out of bounds and clamp is disabled.",
            Some(json!({
                "axis": selector.axis,
                "start": requested_start,
                "end_exclusive": requested_end,
                "size": axis_size,
            })),
        ));
    }

    let mut start = clamp_index(requested_start, axis_size);
    let mut end = requested_end.max(1).min(axis_size);
    if start >= end {
        end = (start + 1).min(axis_size);
        if start >= end {
            start = (end - 1).max(0);
        }
    }

    let warning = if start != requested_start || end != requested_end {
        Some(ApiWarning {
            code: "selector_clamped".to_owned(),
            message: "Selector range was clamped to fit axis bounds.".to_owned(),
            details: Some(json!({
                "axis": selector.axis,
                "requested": {
                    "start": requested_start,
                    "end_exclusive": requested_end,
                },
                "applied": {
                    "start": start,
                    "end_exclusive": end,
                },
            })),
        })
    } else {
        None
    };

    Ok((
        AxisSelector {
            axis: selector.axis.clone(),
            kind: AxisSelectorKind::Range,
            index: None,
            start: Some(start),
            end_exclusive: Some(end),
            indices: None,
            clamp: selector.clamp,
        },
        warning,
    ))
}

fn normalize_set_selector(
    selector: &AxisSelector,
    axis_size: i64,
) -> Result<(AxisSelector, Option<ApiWarning>), ApiError> {
    let requested_indices = selector.indices.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Set selector requires indices.",
            Some(json!({ "axis": selector.axis })),
        )
    })?;

    if !selector.clamp {
        if requested_indices.is_empty() {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "selector_out_of_bounds",
                "Selector set cannot be empty when clamp is disabled.",
                Some(json!({ "axis": selector.axis })),
            ));
        }
        if requested_indices
            .iter()
            .any(|index| *index < 0 || *index >= axis_size)
        {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "selector_out_of_bounds",
                "Selector set contains out-of-bounds values and clamp is disabled.",
                Some(json!({
                    "axis": selector.axis,
                    "indices": requested_indices,
                    "size": axis_size,
                })),
            ));
        }

        let mut normalized = requested_indices.clone();
        normalized.sort_unstable();
        normalized.dedup();

        return Ok((
            AxisSelector {
                axis: selector.axis.clone(),
                kind: AxisSelectorKind::Set,
                index: None,
                start: None,
                end_exclusive: None,
                indices: Some(normalized),
                clamp: false,
            },
            None,
        ));
    }

    let mut clamped: Vec<i64> = requested_indices
        .iter()
        .map(|index| clamp_index(*index, axis_size))
        .collect();
    clamped.sort_unstable();
    clamped.dedup();
    if clamped.is_empty() {
        clamped.push(0);
    }

    let mut requested_unique = requested_indices.clone();
    requested_unique.sort_unstable();
    requested_unique.dedup();

    let warning = if clamped != requested_unique {
        Some(ApiWarning {
            code: "selector_clamped".to_owned(),
            message: "Selector set was normalized to fit axis bounds.".to_owned(),
            details: Some(json!({
                "axis": selector.axis,
                "requested": requested_indices,
                "applied": clamped,
            })),
        })
    } else {
        None
    };

    Ok((
        AxisSelector {
            axis: selector.axis.clone(),
            kind: AxisSelectorKind::Set,
            index: None,
            start: None,
            end_exclusive: None,
            indices: Some(clamped),
            clamp: true,
        },
        warning,
    ))
}

fn clamp_index(value: i64, axis_size: i64) -> i64 {
    value.max(0).min(axis_size - 1)
}

fn selector_index_for_axis(selectors: &[AxisSelector], axis_name: &str) -> i64 {
    let selector = selectors.iter().find(|selector| selector.axis == axis_name);
    match selector {
        None => 0,
        Some(selector) => match selector.kind {
            AxisSelectorKind::Index => selector.index.unwrap_or(0),
            AxisSelectorKind::Range => selector.start.unwrap_or(0),
            AxisSelectorKind::Set => selector
                .indices
                .as_ref()
                .and_then(|indices| indices.first().copied())
                .unwrap_or(0),
        },
    }
}

fn plane_role_triplet(plane: &Plane2D) -> (&'static str, &'static str, &'static str) {
    match plane {
        Plane2D::Xy => ("x", "y", "z"),
        Plane2D::Xz => ("x", "z", "y"),
        Plane2D::Yz => ("y", "z", "x"),
    }
}

fn axis_name_for_role(
    dataset_summary: &DatasetSummary,
    role: &str,
    plane: &Plane2D,
) -> Result<String, ApiError> {
    if let Some(axis) = dataset_summary
        .axes
        .iter()
        .find(|axis| axis_role_name(axis) == role)
    {
        return Ok(axis.name.clone());
    }

    let (role_a, role_b, role_c) = plane_role_triplet(plane);
    let missing_roles: Vec<&str> = [role_a, role_b, role_c]
        .into_iter()
        .filter(|required_role| {
            !dataset_summary
                .axes
                .iter()
                .any(|axis| axis_role_name(axis) == *required_role)
        })
        .collect();

    Err(ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "unsupported_plane",
        "Requested plane is unsupported for dataset axes.",
        Some(json!({
            "plane": plane_name(plane),
            "missing_roles": missing_roles,
            "dataset_id": dataset_summary.dataset_id,
        })),
    ))
}

fn axis_role_name(axis: &AxisDef) -> &'static str {
    match axis.role {
        AxisRole::X => "x",
        AxisRole::Y => "y",
        AxisRole::Z => "z",
        AxisRole::C => "c",
        AxisRole::T => "t",
        AxisRole::Other => "other",
    }
}

fn plane_name(plane: &Plane2D) -> &'static str {
    match plane {
        Plane2D::Xy => "xy",
        Plane2D::Xz => "xz",
        Plane2D::Yz => "yz",
    }
}

fn render_mode_name(mode: &RenderMode) -> &'static str {
    match mode {
        RenderMode::TwoD => "2d",
        RenderMode::ThreeD => "3d",
    }
}

fn validate_immutable_view_fields(
    current: &ViewState,
    candidate: &ViewState,
) -> Result<(), ApiError> {
    if current.view_id != candidate.view_id {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_patch",
            "view_id is immutable.",
            Some(json!({
                "expected": current.view_id,
                "actual": candidate.view_id,
            })),
        ));
    }
    if current.session_id != candidate.session_id {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_patch",
            "session_id is immutable.",
            Some(json!({
                "expected": current.session_id,
                "actual": candidate.session_id,
            })),
        ));
    }
    if current.created_at != candidate.created_at {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_patch",
            "created_at is immutable.",
            Some(json!({ "view_id": current.view_id })),
        ));
    }
    Ok(())
}

fn validate_view_state(view_state: &ViewState) -> Result<(), String> {
    if view_state.schema_version != 1 {
        return Err("schema_version must be 1.".to_owned());
    }
    if view_state.view_id.is_empty() {
        return Err("view_id must not be empty.".to_owned());
    }
    if view_state.session_id.is_empty() {
        return Err("session_id must not be empty.".to_owned());
    }
    if view_state.datasets.is_empty() {
        return Err("datasets must contain at least one item.".to_owned());
    }
    if view_state.selectors.is_empty() {
        return Err("selectors must contain at least one item.".to_owned());
    }
    if view_state.layers.is_empty() {
        return Err("layers must contain at least one item.".to_owned());
    }
    if view_state.viewport.width_px == 0 || view_state.viewport.height_px == 0 {
        return Err("viewport dimensions must be >= 1.".to_owned());
    }
    if view_state.viewport.pixel_ratio < 0.5 {
        return Err("viewport pixel_ratio must be >= 0.5.".to_owned());
    }

    match view_state.mode {
        RenderMode::TwoD if view_state.view_2d.is_none() => {
            return Err("mode=2d requires view_2d.".to_owned())
        }
        RenderMode::ThreeD if view_state.view_3d.is_none() => {
            return Err("mode=3d requires view_3d.".to_owned())
        }
        _ => {}
    }

    for dataset in &view_state.datasets {
        if dataset.dataset_id.is_empty() || dataset.multiscale_name.is_empty() {
            return Err("dataset references must be non-empty.".to_owned());
        }
    }

    for selector in &view_state.selectors {
        if selector.axis.is_empty() {
            return Err("selector axis must be non-empty.".to_owned());
        }
        match selector.kind {
            AxisSelectorKind::Index if selector.index.is_none() => {
                return Err("index selector requires index.".to_owned())
            }
            AxisSelectorKind::Range
                if selector.start.is_none() || selector.end_exclusive.is_none() =>
            {
                return Err("range selector requires start and end_exclusive.".to_owned())
            }
            AxisSelectorKind::Set if selector.indices.is_none() => {
                return Err("set selector requires indices.".to_owned())
            }
            _ => {}
        }
    }

    Ok(())
}

fn with_state_hash(view_state: &ViewState, state_version: u64) -> ViewState {
    let mut base_state = view_state.clone();
    base_state.state_version = state_version;
    base_state.state_hash = None;

    let computed_hash = compute_state_hash(&base_state);
    base_state.state_hash = Some(computed_hash);
    base_state
}

fn compute_state_hash(view_state: &ViewState) -> String {
    let mut payload = serde_json::to_value(view_state).expect("serialize state for hashing");
    if let Value::Object(ref mut map) = payload {
        map.remove("state_hash");
        map.remove("state_version");
    }

    let canonical = canonicalize_for_hash(payload);
    let serialized = serde_json::to_string(&canonical).expect("serialize canonical state");

    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn canonicalize_for_hash(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: BTreeMap<String, Value> = BTreeMap::new();
            for (key, item) in map {
                sorted.insert(key, canonicalize_for_hash(item));
            }
            let normalized = sorted
                .into_iter()
                .collect::<serde_json::Map<String, Value>>();
            Value::Object(normalized)
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(canonicalize_for_hash)
                .collect::<Vec<Value>>(),
        ),
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                Value::Number(number)
            } else {
                let mut quantized =
                    (number.as_f64().unwrap_or(0.0) * 1_000_000.0).round() / 1_000_000.0;
                if quantized == -0.0 {
                    quantized = 0.0;
                }
                Value::Number(Number::from_f64(quantized).unwrap_or_else(|| Number::from(0)))
            }
        }
        other => other,
    }
}

fn generate_view_id() -> String {
    format!("view_{}", &Uuid::new_v4().simple().to_string()[..16])
}

fn invalid_request_error(errors: Vec<Value>) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_request",
        "Request validation failed.",
        Some(json!({ "errors": errors })),
    )
}

fn invalid_patch_error(view_id: Option<&str>, message: &str, reason: &str) -> ApiError {
    let details = if let Some(view_id) = view_id {
        json!({ "view_id": view_id, "reason": reason })
    } else {
        json!({ "reason": reason })
    };
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_patch",
        message,
        Some(details),
    )
}
