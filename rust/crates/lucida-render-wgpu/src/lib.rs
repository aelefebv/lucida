use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderMode {
    TwoD,
    ThreeDStub,
    GraphStub,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RendererState {
    pub mode: RenderMode,
    pub pan: [f64; 2],
    pub zoom: f64,
    pub axis_indices: BTreeMap<String, usize>,
    pub last_frame_ms: f64,
    pub last_frame_at: Option<DateTime<Utc>>,
}

impl Default for RendererState {
    fn default() -> Self {
        Self {
            mode: RenderMode::TwoD,
            pan: [0.0, 0.0],
            zoom: 1.0,
            axis_indices: BTreeMap::new(),
            last_frame_ms: 0.0,
            last_frame_at: None,
        }
    }
}

impl RendererState {
    pub fn set_mode(&mut self, mode: RenderMode) {
        self.mode = mode;
    }

    pub fn pan_zoom(&mut self, dx: f64, dy: f64, zoom_multiplier: f64) {
        self.pan[0] += dx;
        self.pan[1] += dy;
        self.zoom *= zoom_multiplier.max(0.01);
    }

    pub fn set_axis(&mut self, axis: &str, index: usize) {
        self.axis_indices.insert(axis.to_string(), index);
    }

    pub fn mark_frame(&mut self, frame_time_ms: f64) -> Value {
        self.last_frame_ms = frame_time_ms;
        self.last_frame_at = Some(Utc::now());
        json!({
            "mode": self.mode,
            "frame_ms": frame_time_ms,
            "pan": self.pan,
            "zoom": self.zoom,
            "axis_indices": self.axis_indices,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_mode_switches_are_stable() {
        let mut renderer = RendererState::default();
        renderer.set_mode(RenderMode::ThreeDStub);
        assert_eq!(renderer.mode, RenderMode::ThreeDStub);

        renderer.set_mode(RenderMode::GraphStub);
        assert_eq!(renderer.mode, RenderMode::GraphStub);
    }

    #[test]
    fn pan_zoom_updates_state() {
        let mut renderer = RendererState::default();
        renderer.pan_zoom(3.0, -2.0, 1.5);
        assert_eq!(renderer.pan, [3.0, -2.0]);
        assert_eq!(renderer.zoom, 1.5);
    }
}
