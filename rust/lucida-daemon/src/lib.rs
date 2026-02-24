pub mod dataset_open;
pub mod dto;
pub mod error;
pub mod omezarr;
pub mod state;
pub mod uri;

use axum::{
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::dataset_open::dataset_open;
use crate::state::{new_shared_state, SharedAppState};

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
        .with_state(state)
}
