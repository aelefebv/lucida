use pyo3::prelude::*;

use lucida_core::camera::Camera;
use lucida_core::command::{Command, ViewportCommand};
use lucida_core::protocol::ClientMessage;
use lucida_core::scene::{DisplayState, Layer, LevelInfo, Scene};
use lucida_core::view::ViewState;

#[pyclass]
struct PyScene {
    inner: Scene,
}

#[pymethods]
impl PyScene {
    #[new]
    fn new(width: u32, height: u32) -> Self {
        Self {
            inner: Scene::new([width, height]),
        }
    }

    fn load_document(&mut self, json: &str) -> PyResult<()> {
        let doc: lucida_core::scene::DocumentState = serde_json::from_str(json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        self.inner.document = doc;
        Ok(())
    }

    fn apply_command(&mut self, json: &str) -> PyResult<()> {
        let cmd: Command =
            serde_json::from_str(json).map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        self.inner.apply(cmd);
        Ok(())
    }

    fn pan(&mut self, dx: f64, dy: f64) -> String {
        let cmd = ViewportCommand::Pan { dx, dy };
        self.inner.apply(cmd.clone().into());
        serde_json::to_string(&cmd).unwrap()
    }

    fn zoom_by(&mut self, factor: f64) -> String {
        let cmd = ViewportCommand::ZoomBy { factor };
        self.inner.apply(cmd.clone().into());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_center(&mut self, x: f64, y: f64) -> String {
        let cmd = ViewportCommand::SetCenter { x, y };
        self.inner.apply(cmd.clone().into());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_zoom(&mut self, value: f64) -> String {
        let cmd = ViewportCommand::SetZoom { value };
        self.inner.apply(cmd.clone().into());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_z(&mut self, z: u32) -> String {
        let cmd = ViewportCommand::SetZ { z };
        self.inner.apply(cmd.clone().into());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_t(&mut self, t: u32) -> String {
        let cmd = ViewportCommand::SetT { t };
        self.inner.apply(cmd.clone().into());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_c(&mut self, c: u32) -> String {
        let cmd = ViewportCommand::SetC { c };
        self.inner.apply(cmd.clone().into());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_mode_slice(&mut self) {
        self.inner.apply(ViewportCommand::SetMode2D.into());
    }

    fn set_mode_arcball(&mut self) {
        self.inner.apply(ViewportCommand::SetMode3D.into());
    }

    fn camera_mode(&self) -> String {
        match &self.inner.camera {
            Camera::Slice(_) => "slice".to_string(),
            Camera::Arcball(_) => "arcball".to_string(),
            Camera::Fly(_) => "fly".to_string(),
        }
    }

    fn arcball_rotate(&mut self, d_theta: f64, d_phi: f64) -> String {
        let cmd = ViewportCommand::Rotate3D { d_theta, d_phi };
        self.inner.apply(cmd.clone().into());
        serde_json::to_string(&cmd).unwrap()
    }

    fn zoom(&self) -> f64 {
        self.inner.camera.effective_zoom()
    }

    fn center(&self) -> (f64, f64) {
        if let Camera::Slice(ref v) = self.inner.camera {
            (v.center[0], v.center[1])
        } else {
            (0.0, 0.0)
        }
    }

    fn z(&self) -> u32 {
        self.inner.view.z_range.start
    }

    fn t(&self) -> u32 {
        self.inner.view.t
    }

    fn c(&self) -> u32 {
        self.inner.view.c
    }

    fn import_presence(&mut self, json: &str) -> PyResult<()> {
        #[derive(serde::Deserialize)]
        struct Presence {
            camera: Camera,
            view: ViewState,
            display: DisplayState,
        }
        let p: Presence = serde_json::from_str(json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        let viewport = self.inner.camera.viewport();
        self.inner.camera = p.camera;
        self.inner.camera.set_viewport(viewport[0], viewport[1]);
        self.inner.view = p.view;
        self.inner.display = p.display;
        Ok(())
    }

    fn camera_json(&self) -> String {
        serde_json::to_string(&self.inner.camera).unwrap()
    }

    fn presence_json(&self) -> String {
        let msg = ClientMessage::Presence {
            camera: self.inner.camera.clone(),
            view: self.inner.view.clone(),
            display: self.inner.display.clone(),
        };
        serde_json::to_string(&msg).unwrap()
    }

    fn chunk_plan(&self) -> String {
        let plan = self.inner.chunk_plan();
        serde_json::to_string(&plan).unwrap()
    }

    fn chunk_plan_for(&self, dataset_id: &str) -> String {
        let plan = self.inner.chunk_plan_for(dataset_id);
        serde_json::to_string(&plan).unwrap()
    }

    fn dataset_ids(&self) -> String {
        let ids: Vec<&str> = self.inner.document.datasets.iter().map(|d| d.id.as_str()).collect();
        serde_json::to_string(&ids).unwrap()
    }

    fn dataset_name(&self, id: &str) -> String {
        self.inner.document.datasets.iter()
            .find(|d| d.id == id)
            .map(|d| d.name.clone())
            .unwrap_or_default()
    }

    #[pyo3(signature = (name, visible, num_levels, chunk_x, chunk_y, chunk_z, shape_x, shape_y, shape_z))]
    fn add_layer(
        &mut self,
        name: &str,
        visible: bool,
        num_levels: u32,
        chunk_z: u32,
        chunk_y: u32,
        chunk_x: u32,
        shape_z: u32,
        shape_y: u32,
        shape_x: u32,
    ) {
        self.inner.add_layer(Layer {
            name: name.to_string(),
            visible,
            num_levels,
            chunk_size: [chunk_z, chunk_y, chunk_x],
            data_shape: [shape_z, shape_y, shape_x],
            level_info: Vec::new(),
        });
    }

    /// Set per-level shape and chunk size metadata for anisotropic pyramids.
    ///
    /// `shapes_flat` is `[z0,y0,x0, z1,y1,x1, ...]` — one [Z,Y,X] triple per level.
    /// `chunks_flat` is the same layout for chunk sizes.
    #[pyo3(signature = (layer_index, shapes_flat, chunks_flat))]
    fn set_level_info(
        &mut self,
        layer_index: usize,
        shapes_flat: Vec<u32>,
        chunks_flat: Vec<u32>,
    ) {
        let layers = match self.inner.document.datasets.first_mut() {
            Some(ds) => &mut ds.layers,
            None => return,
        };
        if let Some(layer) = layers.get_mut(layer_index) {
            let num_levels = shapes_flat.len() / 3;
            let mut info = Vec::with_capacity(num_levels);
            for i in 0..num_levels {
                info.push(LevelInfo {
                    shape: [shapes_flat[i * 3], shapes_flat[i * 3 + 1], shapes_flat[i * 3 + 2]],
                    chunk_size: [chunks_flat[i * 3], chunks_flat[i * 3 + 1], chunks_flat[i * 3 + 2]],
                });
            }
            layer.level_info = info;
        }
    }
}

#[pymodule]
fn lucida(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyScene>()?;
    Ok(())
}
