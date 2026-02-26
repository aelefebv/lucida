use axum::extract::State;
use axum::Json;

use crate::dto::api::{CapabilitiesPreset, CapabilitiesResponse};
use crate::state::SharedAppState;

const API_VERSION: &str = env!("CARGO_PKG_VERSION");

pub async fn capabilities(State(state): State<SharedAppState>) -> Json<CapabilitiesResponse> {
    let runtime_capabilities = {
        let app_state = state.read().await;
        app_state.runtime_capabilities.clone()
    };
    let gpu = runtime_capabilities.gpu_capabilities().await;

    Json(CapabilitiesResponse {
        schema_version: 1,
        api_version: API_VERSION.to_owned(),
        render_modes: vec!["2d".to_owned()],
        output_formats: vec!["png".to_owned(), "raw_rgba".to_owned()],
        gpu,
        presets: vec![
            CapabilitiesPreset {
                name: "overview_2d".to_owned(),
                description: "Orthogonal 2D overview render pack (planned).".to_owned(),
            },
            CapabilitiesPreset {
                name: "channels_grid".to_owned(),
                description: "Per-channel 2D render pack (planned).".to_owned(),
            },
        ],
    })
}
