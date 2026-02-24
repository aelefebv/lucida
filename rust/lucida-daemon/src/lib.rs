pub mod dataset_open;
pub mod dto;
pub mod error;
pub mod omezarr;
pub mod render_cpu;
pub mod render_image;
pub mod session_create;
pub mod state;
pub mod uri;
pub mod view_state_core;
pub mod view_state_routes;

use axum::{
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::dataset_open::dataset_open;
use crate::render_image::render_image;
use crate::session_create::session_create;
use crate::state::{new_shared_state, SharedAppState};
use crate::view_state_routes::{view_create, view_get, view_update};

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
    Router::new()
        .route("/healthz", get(healthz))
        .route("/dataset/open", post(dataset_open))
        .route("/session/create", post(session_create))
        .route("/view/create", post(view_create))
        .route("/view/{view_id}", get(view_get))
        .route("/view/update", post(view_update))
        .route("/render/image", post(render_image))
        .with_state(state)
}
