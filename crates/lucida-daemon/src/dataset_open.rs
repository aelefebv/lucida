use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::dto::api::{DatasetOpenRequest, DatasetOpenResponse};
use crate::dto::dataset_summary::{DatasetHints, DatasetSummary};
use crate::error::ApiError;
use crate::omezarr::read_omezarr;
use crate::request_validation::{
    expect_body_object, invalid_request_error, parse_optional_bool,
    parse_optional_non_empty_string, parse_required_non_empty_string, parse_schema_version,
    push_extra_forbidden_errors, push_schema_version_literal_error,
};
use crate::state::{ensure_dataset_attached, resolve_session_id, DatasetRecord, SharedAppState};
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
        ensure_dataset_attached(&mut app_state, &resolved_dataset_id, &session_id);
    }

    Ok(Json(DatasetOpenResponse {
        schema_version: 1,
        dataset_summary,
        warnings,
    }))
}

fn parse_dataset_open_request(payload: Value) -> Result<DatasetOpenRequest, ApiError> {
    let object = expect_body_object(payload)?;

    let mut errors: Vec<Value> = Vec::new();
    let allowed_keys = [
        "schema_version",
        "uri",
        "dataset_id",
        "session_id",
        "include_full_raw_metadata",
    ];
    push_extra_forbidden_errors(&object, &allowed_keys, &mut errors);

    let schema_version = parse_schema_version(&object, &mut errors);
    if schema_version != 1 {
        push_schema_version_literal_error(&mut errors);
    }

    let uri = parse_required_non_empty_string(&object, "uri", &mut errors);
    let dataset_id = parse_optional_non_empty_string(&object, "dataset_id", &mut errors);
    let session_id = parse_optional_non_empty_string(&object, "session_id", &mut errors);
    let include_full_raw_metadata =
        parse_optional_bool(&object, "include_full_raw_metadata", &mut errors).unwrap_or(false);

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
