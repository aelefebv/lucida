pub mod dataset_open;
pub mod dto;
pub mod error;
pub mod omezarr;
pub mod render_cache;
pub mod render_cpu;
pub mod render_image;
pub mod request_validation;
pub mod session_create;
pub mod state;
pub mod ui_routes;
pub mod uri;
pub mod usage;
pub mod usage_capture;
pub mod usage_routes;
pub mod view_event_routes;
pub mod view_events;
pub mod view_state_core;
pub mod view_state_routes;
pub mod view_state_transfer_routes;

use axum::{
    middleware::from_fn_with_state,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::dataset_open::dataset_open;
use crate::render_image::render_image;
use crate::session_create::{session_create, session_list};
use crate::state::{new_shared_state, SharedAppState};
use crate::ui_routes::{ui_asset, ui_index, ui_live, ui_replay};
use crate::usage_capture::usage_capture_middleware;
use crate::usage_routes::{
    usage_events, usage_events_stream, usage_run_detail, usage_runs, usage_thumbnail_asset,
};
use crate::view_event_routes::view_events_stream;
use crate::view_state_routes::{view_create, view_get, view_list, view_update};
use crate::view_state_transfer_routes::{export_viewstate, import_viewstate};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HealthzResponse {
    pub status: String,
}

async fn healthz() -> Json<HealthzResponse> {
    Json(HealthzResponse {
        status: "ok".to_owned(),
    })
}

pub fn app() -> Router {
    app_with_state(new_shared_state())
}

pub fn app_with_state(state: SharedAppState) -> Router {
    let instrumented_api = Router::new()
        .route("/dataset/open", post(dataset_open))
        .route("/session/create", post(session_create))
        .route("/session/list", get(session_list))
        .route("/view/create", post(view_create))
        .route("/view/list", get(view_list))
        .route("/view/{view_id}", get(view_get))
        .route("/view/update", post(view_update))
        .route("/export/viewstate", post(export_viewstate))
        .route("/import/viewstate", post(import_viewstate))
        .route("/render/image", post(render_image))
        .route_layer(from_fn_with_state(state.clone(), usage_capture_middleware));

    Router::new()
        .route("/healthz", get(healthz))
        .merge(instrumented_api)
        .route("/usage/events", get(usage_events))
        .route("/usage/runs", get(usage_runs))
        .route("/usage/runs/{run_id}", get(usage_run_detail))
        .route("/usage/events/stream", get(usage_events_stream))
        .route("/usage/thumbs/{*path}", get(usage_thumbnail_asset))
        .route("/view/events/stream", get(view_events_stream))
        .route("/ui", get(ui_index))
        .route("/ui/live", get(ui_live))
        .route("/ui/replay", get(ui_replay))
        .route("/ui/{*path}", get(ui_asset))
        .with_state(state)
}
