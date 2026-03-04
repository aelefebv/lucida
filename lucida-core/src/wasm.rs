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
}
