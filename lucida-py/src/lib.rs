use pyo3::prelude::*;

use lucida_core::command::Command;
use lucida_core::scene::{Layer, Scene};

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

    fn apply_command(&mut self, json: &str) -> PyResult<()> {
        let cmd: Command =
            serde_json::from_str(json).map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        self.inner.apply(cmd);
        Ok(())
    }

    fn pan(&mut self, dx: f64, dy: f64) -> String {
        let cmd = Command::Pan { dx, dy };
        self.inner.apply(cmd.clone());
        serde_json::to_string(&cmd).unwrap()
    }

    fn zoom_by(&mut self, factor: f64) -> String {
        let cmd = Command::ZoomBy { factor };
        self.inner.apply(cmd.clone());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_center(&mut self, x: f64, y: f64) -> String {
        let cmd = Command::SetCenter { x, y };
        self.inner.apply(cmd.clone());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_zoom(&mut self, value: f64) -> String {
        let cmd = Command::SetZoom { value };
        self.inner.apply(cmd.clone());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_z(&mut self, z: u32) -> String {
        let cmd = Command::SetZ { z };
        self.inner.apply(cmd.clone());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_t(&mut self, t: u32) -> String {
        let cmd = Command::SetT { t };
        self.inner.apply(cmd.clone());
        serde_json::to_string(&cmd).unwrap()
    }

    fn set_c(&mut self, c: u32) -> String {
        let cmd = Command::SetC { c };
        self.inner.apply(cmd.clone());
        serde_json::to_string(&cmd).unwrap()
    }

    fn zoom(&self) -> f64 {
        self.inner.camera.effective_zoom()
    }

    fn center(&self) -> (f64, f64) {
        use lucida_core::camera::Camera;
        if let Camera::View2D(ref v) = self.inner.camera {
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

    fn chunk_plan(&self) -> String {
        let plan = self.inner.chunk_plan();
        serde_json::to_string(&plan).unwrap()
    }

    #[pyo3(signature = (name, visible, num_levels, chunk_x, chunk_y, chunk_z, shape_x, shape_y, shape_z))]
    fn add_layer(
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
}

#[pymodule]
fn lucida(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyScene>()?;
    Ok(())
}
