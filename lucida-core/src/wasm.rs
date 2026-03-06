use wasm_bindgen::prelude::*;

use crate::camera::Camera;
use crate::command::Command;
use crate::scene::{Layer, Scene};

#[wasm_bindgen]
pub fn chunk_key(level: u32, t: u32, c: u32, z: u32, y: u32, x: u32) -> String {
    crate::chunk::chunk_key(level, t, c, z, y, x)
}

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

    // --- Command protocol ---

    pub fn apply_command(&mut self, json: &str) -> Result<(), JsError> {
        let cmd: Command = serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner.apply(cmd);
        Ok(())
    }

    // --- Mode switching ---

    pub fn set_mode_2d(&mut self) {
        self.inner.set_mode_2d();
    }

    pub fn set_mode_3d(&mut self) {
        self.inner.set_mode_3d();
    }

    pub fn is_3d(&self) -> bool {
        matches!(self.inner.camera, Camera::View3D(_))
    }

    // --- Shared viewport ---

    pub fn set_viewport(&mut self, width: u32, height: u32) {
        self.inner.camera.set_viewport(width, height);
    }

    // --- Layer management ---

    pub fn add_layer(
        &mut self,
        name: &str,
        visible: bool,
        num_levels: u32,
        chunk_x: u32,
        chunk_y: u32,
        chunk_z: u32,
        shape_x: u32,
        shape_y: u32,
        shape_z: u32,
    ) {
        self.inner.add_layer(Layer {
            name: name.to_string(),
            visible,
            num_levels,
            chunk_size: [chunk_x, chunk_y, chunk_z],
            data_shape: [shape_x, shape_y, shape_z],
        });
    }

    // --- 2D camera methods ---

    pub fn pan(&mut self, dx: f64, dy: f64) {
        if let Camera::View2D(ref mut v) = self.inner.camera {
            v.pan(dx, dy);
        }
    }

    pub fn zoom_by(&mut self, factor: f64) {
        if let Camera::View2D(ref mut v) = self.inner.camera {
            v.zoom_by(factor);
        }
    }

    pub fn set_center(&mut self, x: f64, y: f64) {
        if let Camera::View2D(ref mut v) = self.inner.camera {
            v.center = [x, y];
        }
    }

    pub fn center(&self) -> Vec<f64> {
        if let Camera::View2D(ref v) = self.inner.camera {
            vec![v.center[0], v.center[1]]
        } else {
            vec![0.0, 0.0]
        }
    }

    pub fn set_zoom(&mut self, value: f64) {
        if let Camera::View2D(ref mut v) = self.inner.camera {
            v.zoom = value;
        }
    }

    // --- View state ---

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

    // --- View state getters ---

    pub fn z(&self) -> u32 {
        self.inner.view.z_range.start
    }

    pub fn t(&self) -> u32 {
        self.inner.view.t
    }

    pub fn c(&self) -> u32 {
        self.inner.view.c
    }

    // --- Queries ---

    pub fn zoom(&self) -> f64 {
        self.inner.camera.effective_zoom()
    }

    pub fn world_bounds(&self) -> String {
        match &self.inner.camera {
            Camera::View2D(v) => {
                let bounds = v.world_bounds();
                serde_json::to_string(&bounds).unwrap()
            }
            Camera::View3D(_) => {
                // Return the visible region xy_bounds for 3D
                let region = self.inner.camera.visible_region(
                    &self.inner.view.z_range,
                    self.inner.volume_transform.as_ref(),
                    self.inner.volume_shape.as_ref(),
                );
                serde_json::to_string(&region.xy_bounds).unwrap()
            }
        }
    }

    pub fn chunk_plan(&self) -> String {
        let plan = self.inner.chunk_plan();
        serde_json::to_string(&plan).unwrap()
    }

    // --- 3D camera methods ---

    pub fn rotate_3d(&mut self, d_theta: f64, d_phi: f64) {
        if let Camera::View3D(ref mut v) = self.inner.camera {
            v.rotate(d_theta, d_phi);
        }
    }

    pub fn zoom_3d(&mut self, delta: f64) {
        if let Camera::View3D(ref mut v) = self.inner.camera {
            v.zoom(delta);
        }
    }

    pub fn pan_3d(&mut self, dx: f64, dy: f64) {
        if let Camera::View3D(ref mut v) = self.inner.camera {
            v.pan(dx, dy);
        }
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
        if let Camera::View3D(ref v) = self.inner.camera {
            v.inv_view_proj().to_vec()
        } else {
            vec![
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ]
        }
    }

    pub fn eye_position_3d(&self) -> Vec<f32> {
        if let Camera::View3D(ref v) = self.inner.camera {
            let eye = v.eye_position();
            vec![eye[0] as f32, eye[1] as f32, eye[2] as f32]
        } else {
            vec![0.0, 0.0, 1.0]
        }
    }

    pub fn model_matrix(&self) -> Vec<f32> {
        match &self.inner.volume_transform {
            Some(t) => t.model.to_vec(),
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
