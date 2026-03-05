use wasm_bindgen::prelude::*;

use crate::scene::{Layer, Scene};

#[wasm_bindgen]
pub struct WasmScene {
    inner: Scene,
}

#[wasm_bindgen]
impl WasmScene {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            inner: Scene::new([width, height]),
        }
    }

    pub fn add_layer(
        &mut self,
        name: &str,
        visible: bool,
        num_levels: u32,
        chunk_x: u32,
        chunk_y: u32,
        chunk_z: u32,
    ) {
        self.inner.add_layer(Layer {
            name: name.to_string(),
            visible,
            num_levels,
            chunk_size: [chunk_x, chunk_y, chunk_z],
        });
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        self.inner.camera.pan(dx, dy);
    }

    pub fn zoom_by(&mut self, factor: f64) {
        self.inner.camera.zoom_by(factor);
    }

    pub fn set_center(&mut self, x: f64, y: f64) {
        self.inner.camera.center = [x, y];
    }

    pub fn set_z(&mut self, z: u32) {
        self.inner.view.set_z(z);
    }

    pub fn set_z_range(&mut self, start: u32, end: u32) {
        self.inner.view.set_z_range(start..end);
    }

    pub fn set_t(&mut self, t: u32) {
        self.inner.view.t = t;
    }

    pub fn set_c(&mut self, c: u32) {
        self.inner.view.c = c;
    }

    pub fn zoom(&self) -> f64 {
        self.inner.camera.zoom
    }

    pub fn world_bounds(&self) -> String {
        let bounds = self.inner.camera.world_bounds();
        serde_json::to_string(&bounds).unwrap()
    }

    pub fn chunk_plan(&self) -> String {
        let plan = self.inner.chunk_plan();
        serde_json::to_string(&plan).unwrap()
    }

    // --- 3D camera methods ---

    pub fn rotate_3d(&mut self, d_theta: f64, d_phi: f64) {
        self.inner.camera_3d.rotate(d_theta, d_phi);
    }

    pub fn zoom_3d(&mut self, delta: f64) {
        self.inner.camera_3d.zoom(delta);
    }

    pub fn pan_3d(&mut self, dx: f64, dy: f64) {
        self.inner.camera_3d.pan(dx, dy);
    }

    pub fn set_viewport_3d(&mut self, width: u32, height: u32) {
        self.inner.camera_3d.viewport = [width, height];
    }

    pub fn set_volume_scale(
        &mut self,
        shape_z: u32,
        shape_y: u32,
        shape_x: u32,
        scale_z: f64,
        scale_y: f64,
        scale_x: f64,
    ) {
        self.inner
            .set_volume_scale([shape_z, shape_y, shape_x], [scale_z, scale_y, scale_x]);
    }

    pub fn inv_view_proj_3d(&self) -> Vec<f32> {
        self.inner.camera_3d.inv_view_proj().to_vec()
    }

    pub fn eye_position_3d(&self) -> Vec<f32> {
        let eye = self.inner.camera_3d.eye_position();
        vec![eye[0] as f32, eye[1] as f32, eye[2] as f32]
    }

    pub fn model_matrix(&self) -> Vec<f32> {
        match &self.inner.volume_transform {
            Some(t) => t.model.to_vec(),
            None => {
                // Identity matrix
                vec![
                    1.0, 0.0, 0.0, 0.0,
                    0.0, 1.0, 0.0, 0.0,
                    0.0, 0.0, 1.0, 0.0,
                    0.0, 0.0, 0.0, 1.0,
                ]
            }
        }
    }

    pub fn inv_model_matrix(&self) -> Vec<f32> {
        match &self.inner.volume_transform {
            Some(t) => t.inv_model.to_vec(),
            None => {
                vec![
                    1.0, 0.0, 0.0, 0.0,
                    0.0, 1.0, 0.0, 0.0,
                    0.0, 0.0, 1.0, 0.0,
                    0.0, 0.0, 0.0, 1.0,
                ]
            }
        }
    }
}
