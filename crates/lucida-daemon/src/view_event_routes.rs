use std::convert::Infallible;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use serde::Deserialize;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::error::ApiError;
use crate::state::SharedAppState;

#[derive(Debug, Clone, Deserialize)]
pub struct ViewEventsStreamQuery {
    pub view_id: Option<String>,
    pub session_id: Option<String>,
}

pub async fn view_events_stream(
    Query(query): Query<ViewEventsStreamQuery>,
    State(state): State<SharedAppState>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let view_id = query
        .view_id
        .and_then(|value| (!value.trim().is_empty()).then_some(value))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_view_events_query",
                "view_id must be a non-empty string.",
                Some(serde_json::json!({ "field": "view_id" })),
            )
        })?;
    let session_id_filter = query
        .session_id
        .and_then(|value| (!value.trim().is_empty()).then_some(value));

    let view_events = {
        let app_state = state.read().await;
        app_state.view_events.clone()
    };
    let receiver = view_events.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(move |message| {
        let required_view_id = view_id.clone();
        let session_id_filter = session_id_filter.clone();
        match message {
            Ok(event) => {
                if event.view_id != required_view_id {
                    return None;
                }
                if let Some(expected_session_id) = session_id_filter.as_deref() {
                    if event.session_id.as_deref() != Some(expected_session_id) {
                        return None;
                    }
                }
                let payload = serde_json::to_string(&event).ok()?;
                Some(Ok(Event::default().event("view_event").data(payload)))
            }
            Err(_) => None,
        }
    });

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    ))
}
