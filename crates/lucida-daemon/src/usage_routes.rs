use std::convert::Infallible;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::dto::usage::{UsageEventsResponse, UsageRunDetailResponse, UsageRunsResponse};
use crate::error::ApiError;
use crate::state::SharedAppState;
use crate::usage::{invalid_usage_query_error, UsageEventsFilter, UsageRunsFilter};

#[derive(Debug, Clone, Deserialize)]
pub struct UsageEventsQuery {
    pub limit: Option<u32>,
    pub before_id: Option<i64>,
    pub run_id: Option<String>,
    pub endpoint: Option<String>,
    pub status_code: Option<u16>,
    pub from_ts: Option<String>,
    pub to_ts: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UsageRunsQuery {
    pub limit: Option<u32>,
    pub before_start_ts: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UsageStreamQuery {
    pub run_id: Option<String>,
}

pub async fn usage_events(
    Query(query): Query<UsageEventsQuery>,
    State(state): State<SharedAppState>,
) -> Result<Json<UsageEventsResponse>, ApiError> {
    let filter = parse_usage_events_filter(query)?;
    let usage = {
        let app_state = state.read().await;
        app_state.usage.clone()
    };
    let events = usage.list_events(filter).map_err(usage_query_failed)?;
    Ok(Json(UsageEventsResponse {
        schema_version: 1,
        events,
    }))
}

pub async fn usage_runs(
    Query(query): Query<UsageRunsQuery>,
    State(state): State<SharedAppState>,
) -> Result<Json<UsageRunsResponse>, ApiError> {
    let filter = parse_usage_runs_filter(query)?;
    let usage = {
        let app_state = state.read().await;
        app_state.usage.clone()
    };
    let runs = usage.list_runs(filter).map_err(usage_query_failed)?;
    Ok(Json(UsageRunsResponse {
        schema_version: 1,
        runs,
    }))
}

pub async fn usage_run_detail(
    Path(run_id): Path<String>,
    Query(query): Query<UsageEventsQuery>,
    State(state): State<SharedAppState>,
) -> Result<Json<UsageRunDetailResponse>, ApiError> {
    if run_id.trim().is_empty() {
        return Err(invalid_usage_query_error(
            "run_id",
            "run_id must be a non-empty string.",
        ));
    }
    let limit = normalize_limit(query.limit, 200, 500)?;
    let usage = {
        let app_state = state.read().await;
        app_state.usage.clone()
    };
    let maybe_run = usage.get_run(&run_id, limit).map_err(usage_query_failed)?;
    let Some((run, events)) = maybe_run else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "usage_run_not_found",
            "Usage run was not found.",
            Some(serde_json::json!({ "run_id": run_id })),
        ));
    };

    Ok(Json(UsageRunDetailResponse {
        schema_version: 1,
        run,
        events,
    }))
}

pub async fn usage_events_stream(
    Query(query): Query<UsageStreamQuery>,
    State(state): State<SharedAppState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let usage = {
        let app_state = state.read().await;
        app_state.usage.clone()
    };
    let receiver = usage.subscribe();
    let run_id_filter = query
        .run_id
        .and_then(|value| (!value.trim().is_empty()).then_some(value));

    let stream = BroadcastStream::new(receiver).filter_map(move |message| {
        let run_id_filter = run_id_filter.clone();
        match message {
            Ok(event) => {
                if let Some(run_id) = run_id_filter.as_deref() {
                    if event.agent_run_id.as_deref() != Some(run_id) {
                        return None;
                    }
                }
                let payload = serde_json::to_string(&event).ok()?;
                Some(Ok(Event::default().event("usage_event").data(payload)))
            }
            Err(_) => None,
        }
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}

fn parse_usage_events_filter(query: UsageEventsQuery) -> Result<UsageEventsFilter, ApiError> {
    let from_ts = query
        .from_ts
        .as_deref()
        .map(parse_rfc3339_utc)
        .transpose()?;
    let to_ts = query.to_ts.as_deref().map(parse_rfc3339_utc).transpose()?;

    if let (Some(from_ts_value), Some(to_ts_value)) = (from_ts.as_ref(), to_ts.as_ref()) {
        if to_ts_value < from_ts_value {
            return Err(invalid_usage_query_error(
                "to_ts",
                "to_ts must be greater than or equal to from_ts.",
            ));
        }
    }

    let run_id = query
        .run_id
        .and_then(|value| (!value.trim().is_empty()).then_some(value));
    let endpoint = query
        .endpoint
        .and_then(|value| (!value.trim().is_empty()).then_some(value));

    Ok(UsageEventsFilter {
        limit: normalize_limit(query.limit, 100, 1000)?,
        before_id: query.before_id,
        run_id,
        endpoint,
        status_code: query.status_code,
        from_ts,
        to_ts,
    })
}

fn parse_usage_runs_filter(query: UsageRunsQuery) -> Result<UsageRunsFilter, ApiError> {
    let before_start_ts = query
        .before_start_ts
        .as_deref()
        .map(parse_rfc3339_utc)
        .transpose()?;

    Ok(UsageRunsFilter {
        limit: normalize_limit(query.limit, 50, 500)?,
        before_start_ts,
    })
}

fn normalize_limit(
    value: Option<u32>,
    default_value: u32,
    max_value: u32,
) -> Result<u32, ApiError> {
    let limit = value.unwrap_or(default_value);
    if limit == 0 || limit > max_value {
        return Err(invalid_usage_query_error(
            "limit",
            &format!("limit must be between 1 and {max_value}."),
        ));
    }
    Ok(limit)
}

fn parse_rfc3339_utc(value: &str) -> Result<DateTime<Utc>, ApiError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|_| invalid_usage_query_error("timestamp", "timestamps must be RFC3339 values."))
}

fn usage_query_failed(reason: String) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "usage_query_failed",
        "Usage query failed.",
        Some(serde_json::json!({ "reason": reason })),
    )
}
