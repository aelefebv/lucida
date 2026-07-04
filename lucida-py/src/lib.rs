use std::sync::Arc;

use object_store::ObjectStore;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::wrap_pyfunction;

use lucida_content::DatasetId;
use lucida_core::camera::Camera;
use lucida_core::command::{Command, ViewportCommand};
use lucida_core::protocol::ClientMessage;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::{DisplayState, Scene};
use lucida_core::view::ViewState;
use lucida_core::view_transform::{ExplorationSidecar, ViewExtent, default_view};

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
        self.inner.load_document(doc);
        Ok(())
    }

    fn apply_command(&mut self, json: &str) -> PyResult<()> {
        let cmd: Command = serde_json::from_str(json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
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
        self.inner.import_presence(p.camera, p.view, p.display);
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
        let id = DatasetId(dataset_id.to_string());
        let plan = self.inner.chunk_plan_for(&id);
        serde_json::to_string(&plan).unwrap()
    }

    fn dataset_ids(&self) -> String {
        let ids: Vec<&str> = self
            .inner
            .document
            .manifests
            .keys()
            .map(|id| id.0.as_str())
            .collect();
        serde_json::to_string(&ids).unwrap()
    }

    fn dataset_name(&self, id: &str) -> String {
        self.inner
            .document
            .manifests
            .get(&DatasetId(id.to_string()))
            .map(|cg| cg.name.clone())
            .unwrap_or_default()
    }
}

#[pyclass]
struct PyStore {
    store: Arc<dyn ObjectStore>,
    runtime: tokio::runtime::Runtime,
}

#[pymethods]
impl PyStore {
    /// Open a StorageBackend from a URL.
    /// "/" prefix -> local filesystem, "gs://" -> GCS.
    #[staticmethod]
    fn open(url: &str) -> PyResult<Self> {
        let store = lucida_store::backend::open(url)
            .map_err(|e| pyo3::exceptions::PyValueError::new_err(e.to_string()))?;
        let runtime = tokio::runtime::Runtime::new()
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;
        Ok(Self { store, runtime })
    }

    /// Import dataset from OME-Zarr, return JSON string of ImportResult.
    fn read_metadata(&self, name: &str) -> PyResult<String> {
        let store = self.store.clone();
        let name = name.to_string();
        let result = self
            .runtime
            .block_on(async {
                lucida_store::import::import_dataset(&store, "temp-id", &name).await
            })
            .map_err(|e| pyo3::exceptions::PyValueError::new_err(e.to_string()))?;

        let json = serde_json::to_string(&result)
            .map_err(|e| pyo3::exceptions::PyValueError::new_err(e.to_string()))?;
        Ok(json)
    }

    /// Read a single chunk by path (e.g., "0/c/0/0/0/0/0"), return raw bytes.
    fn read_chunk(&self, path: &str) -> PyResult<Vec<u8>> {
        let store = self.store.clone();
        let obj_path = object_store::path::Path::from(path);
        let bytes = self
            .runtime
            .block_on(async { store.get(&obj_path).await?.bytes().await })
            .map_err(|e| pyo3::exceptions::PyIOError::new_err(e.to_string()))?;
        Ok(bytes.to_vec())
    }
}

/// Plan a guided-exploration step for a dataset, returning a serialized
/// `ExplorationSidecar` (JSON string).
///
/// `dims` is the dataset shape `(T, C, Z, Y, X)`; `viewport` is `(width,
/// height)`. With `view_json = None` the exploration starts from the dataset's
/// Home view (a 3D Arcball for a volume, a 2D Slice for a flat image, framed to
/// the full extent); pass a `SavedView` JSON string to descend from an explicit
/// view (e.g. a child cell's `view` from a previous call). `depth` and
/// `breadcrumb` are stamped on the returned current node so a stateless caller
/// can keep an honest trail across calls.
///
/// This is the same pure engine the CLI's `dataset explore` and the web panel
/// use; the cells carry full `view` objects (URLs are deferred to higher tiers).
#[pyfunction]
#[pyo3(signature = (ds_id, dims, viewport, view_json=None, depth=0, breadcrumb=None))]
fn explore(
    ds_id: &str,
    dims: (u64, u64, u64, u64, u64),
    viewport: (u32, u32),
    view_json: Option<&str>,
    depth: u32,
    breadcrumb: Option<Vec<String>>,
) -> PyResult<String> {
    let dims = [dims.0, dims.1, dims.2, dims.3, dims.4];
    let vp = [viewport.0, viewport.1];
    let extent = ViewExtent::from_dims(dims);
    let current = match view_json {
        Some(j) => serde_json::from_str::<SavedView>(j)
            .map_err(|e| PyValueError::new_err(e.to_string()))?,
        None => default_view(ds_id, dims, vp),
    };
    let sidecar =
        ExplorationSidecar::build(&current, &extent, depth, breadcrumb.unwrap_or_default());
    serde_json::to_string(&sidecar).map_err(|e| PyValueError::new_err(e.to_string()))
}

#[pymodule]
fn lucida(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyScene>()?;
    m.add_class::<PyStore>()?;
    m.add_function(wrap_pyfunction!(explore, m)?)?;
    Ok(())
}
