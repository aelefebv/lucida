pub mod dto;
pub mod error;

use axum::{routing::get, Json, Router};
use serde::{Deserialize, Serialize};

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
    Router::new().route("/healthz", get(healthz))
}
