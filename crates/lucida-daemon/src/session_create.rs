use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::dto::api::{SessionCreateResponse, SessionListItem, SessionListResponse};
use crate::error::ApiError;
use crate::request_validation::{
    expect_body_object, invalid_request_error, parse_schema_version,
    push_schema_version_literal_error,
};
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

pub async fn session_list(
    State(state): State<SharedAppState>,
) -> Result<Json<SessionListResponse>, ApiError> {
    let sessions = {
        let app_state = state.read().await;
        let mut items = app_state
            .sessions_by_id
            .values()
            .map(|session| {
                let mut dataset_ids = session.dataset_ids.iter().cloned().collect::<Vec<String>>();
                dataset_ids.sort_unstable();
                let mut view_ids = session.view_ids.iter().cloned().collect::<Vec<String>>();
                view_ids.sort_unstable();
                SessionListItem {
                    session_id: session.session_id.clone(),
                    created_at: session.created_at,
                    dataset_count: dataset_ids.len() as u64,
                    view_count: view_ids.len() as u64,
                    dataset_ids,
                    view_ids,
                }
            })
            .collect::<Vec<SessionListItem>>();
        items.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        items
    };

    Ok(Json(SessionListResponse {
        schema_version: 1,
        sessions,
    }))
}

fn parse_session_create_request(payload: Value) -> Result<(), ApiError> {
    let object = expect_body_object(payload)?;

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

    let schema_version = parse_schema_version(&object, &mut errors);
    if schema_version != 1 {
        push_schema_version_literal_error(&mut errors);
    }

    if !errors.is_empty() {
        return Err(invalid_request_error(errors));
    }

    Ok(())
}
