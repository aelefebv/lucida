use std::sync::Arc;

use object_store::{ObjectStore, ObjectStoreExt};
use pyo3::exceptions::{PyLookupError, PyValueError};
use pyo3::prelude::*;
use pyo3::wrap_pyfunction;

use lucida_content::DatasetId;
use lucida_core::camera::Camera;
use lucida_core::command::{Command, ViewportCommand};
use lucida_core::protocol::ClientMessage;
use lucida_core::saved_view::{self, SavedView};
use lucida_core::scene::{DisplayState, DocumentState, Scene};
use lucida_core::view::{AxisPositions, ViewLayout};
use lucida_core::view_transform;
use lucida_core::viewer_profile::{ProfileCommandError, ProfileScene};

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

    /// Show one channel of a layer alone, or its composite with `None`.
    #[pyo3(signature = (dataset_id, channel=None))]
    fn set_channel_solo(&mut self, dataset_id: &str, channel: Option<u32>) -> String {
        let cmd = ViewportCommand::SetChannelSolo {
            dataset_id: dataset_id.to_string(),
            channel,
        };
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
        match &self.inner.active_view().camera {
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
        self.inner.active_view().camera.effective_zoom()
    }

    fn center(&self) -> (f64, f64) {
        if let Camera::Slice(ref v) = self.inner.active_view().camera {
            (v.center[0], v.center[1])
        } else {
            (0.0, 0.0)
        }
    }

    /// The active view's position on its Z grid.
    fn z(&self) -> u32 {
        let view = self.inner.active_view().id();
        self.inner.axis_index(view, lucida_content::SpatialAxis::Z)
    }

    fn t(&self) -> u32 {
        self.inner.active_view().axes.t
    }

    /// What every layer shows, as JSON: which channels, through which
    /// colormap and window, at which z and t.
    fn resolved_layers(&self) -> String {
        serde_json::to_string(&self.inner.resolved_layers(self.inner.active_view().id())).unwrap()
    }

    fn import_presence(&mut self, json: &str) -> PyResult<()> {
        #[derive(serde::Deserialize)]
        struct Presence {
            camera: Camera,
            view: AxisPositions,
            display: DisplayState,
        }
        let p: Presence = serde_json::from_str(json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        self.inner.import_presence(p.camera, p.view, p.display);
        Ok(())
    }

    fn camera_json(&self) -> String {
        serde_json::to_string(&self.inner.active_view().camera).unwrap()
    }

    fn presence_json(&self) -> String {
        let msg = ClientMessage::Presence {
            camera: self.inner.active_view().camera.clone(),
            view: self.inner.active_view().axes.clone(),
            display: self.inner.display.clone(),
            views: self.inner.record_views(false),
        };
        serde_json::to_string(&msg).unwrap()
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

impl PyProfileScene {
    fn steer(&mut self, view: Option<usize>) -> PyResult<()> {
        let Some(index) = view else {
            return Ok(());
        };
        let view = self.inner.view_id(index).map_err(refusal)?;
        self.inner
            .apply(ViewportCommand::SetActiveView { view })
            .map_err(refusal)
    }
}

/// A refused command as Python raises it: `LookupError` for something the
/// workspace or layout lacks, `ValueError` for anything else.
fn refusal(error: ProfileCommandError) -> PyErr {
    if error.is_missing_resource() {
        PyLookupError::new_err(error.to_string())
    } else {
        PyValueError::new_err(error.to_string())
    }
}

/// A viewer profile's view opened over the workspace document, changed by the
/// same commands the viewer's controls apply.
///
/// `document_json` is the workspace document from a snapshot, and `view_json`
/// the profile's `SavedView`. Without `view_json` the view starts as a new
/// profile does, with the visible datasets framed in 2D.
#[pyclass(name = "ProfileScene")]
struct PyProfileScene {
    inner: ProfileScene,
}

#[pymethods]
impl PyProfileScene {
    #[new]
    #[pyo3(signature = (document_json, view_json=None))]
    fn new(document_json: &str, view_json: Option<&str>) -> PyResult<Self> {
        let document: DocumentState = serde_json::from_str(document_json)
            .map_err(|e| PyValueError::new_err(format!("invalid workspace document: {e}")))?;
        let inner = match view_json {
            Some(json) => {
                let view: SavedView = serde_json::from_str(json)
                    .map_err(|e| PyValueError::new_err(format!("invalid saved view: {e}")))?;
                ProfileScene::open(&document, &view)
            }
            None => ProfileScene::fitted(&document),
        };
        Ok(Self { inner })
    }

    /// Apply one viewport command, given as its tagged JSON, in the view at
    /// `view`'s place in the layout, which becomes the active view first, or
    /// in the active view. Raises `LookupError` when it names a dataset,
    /// channel, label or view the workspace or layout lacks, and `ValueError`
    /// for any other refusal. A refused command changes nothing.
    #[pyo3(signature = (command_json, view=None))]
    fn apply(&mut self, command_json: &str, view: Option<usize>) -> PyResult<()> {
        let command: ViewportCommand = serde_json::from_str(command_json)
            .map_err(|e| PyValueError::new_err(format!("invalid view command: {e}")))?;
        self.inner.apply_in(view, command).map_err(refusal)
    }

    /// Divide the canvas as `layout` (`"single"`, `"columns"`, `"rows"`,
    /// `"grid"` or `"four_up"`) does, each of `dataset_ids` moved into the
    /// view at its place; four-up shows them all in every view.
    #[pyo3(signature = (layout, dataset_ids, view=None))]
    fn lay_out(
        &mut self,
        layout: &str,
        dataset_ids: Vec<String>,
        view: Option<usize>,
    ) -> PyResult<()> {
        let layout: ViewLayout = serde_json::from_value(serde_json::Value::from(layout))
            .map_err(|e| PyValueError::new_err(format!("invalid view layout: {e}")))?;
        let ids: Vec<DatasetId> = dataset_ids.into_iter().map(DatasetId).collect();
        self.steer(view)?;
        self.inner.lay_out(layout, &ids).map_err(refusal)
    }

    /// Show `dataset_ids` in the view at `view`'s place, which becomes the
    /// active view: moved there and out of every other view, or with `keep`
    /// as well as wherever they show.
    #[pyo3(signature = (view, dataset_ids, keep=false))]
    fn show_in(&mut self, view: usize, dataset_ids: Vec<String>, keep: bool) -> PyResult<()> {
        let ids: Vec<DatasetId> = dataset_ids.into_iter().map(DatasetId).collect();
        self.steer(Some(view))?;
        self.inner.show_in(view, &ids, keep).map_err(refusal)
    }

    /// The id of the view at `index` in the layout's order, for a command
    /// that names a view.
    fn view_id(&self, index: usize) -> PyResult<u32> {
        self.inner.view_id(index).map(|id| id.0).map_err(refusal)
    }

    /// Every view as a saved view records them, one view of every dataset
    /// included, as JSON.
    fn views_json(&self) -> PyResult<String> {
        serde_json::to_string(&self.inner.scene.views_record(true))
            .map_err(|e| PyValueError::new_err(e.to_string()))
    }

    /// How the two views of a layout of two link, each view by its place, as
    /// JSON, or `None` with other than two views.
    fn links_json(&self) -> PyResult<Option<String>> {
        self.inner
            .links()
            .map(|links| serde_json::to_string(&links))
            .transpose()
            .map_err(|e| PyValueError::new_err(e.to_string()))
    }

    /// The view as the profile stores it, a `SavedView` JSON string.
    fn saved_view_json(&self) -> PyResult<String> {
        serde_json::to_string(&self.inner.saved_view())
            .map_err(|e| PyValueError::new_err(e.to_string()))
    }

    /// What every layer shows, as JSON: which channels, through which
    /// colormap and window, at which z and t.
    fn resolved_layers(&self) -> PyResult<String> {
        serde_json::to_string(
            &self
                .inner
                .scene
                .resolved_layers(self.inner.scene.active_view().id()),
        )
        .map_err(|e| PyValueError::new_err(e.to_string()))
    }
}

#[pyclass]
struct PyStore {
    store: Arc<dyn ObjectStore>,
    runtime: tokio::runtime::Runtime,
}

#[pymethods]
impl PyStore {
    /// Open a StorageBackend from an absolute path or a gs://, s3://,
    /// http://, or https:// URL.
    #[staticmethod]
    fn open(url: &str) -> PyResult<Self> {
        let location = lucida_content::url::DatasetLocation::parse(url)
            .map_err(|e| pyo3::exceptions::PyValueError::new_err(e.to_string()))?;
        let store = lucida_store::backend::open(&location)
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
                let store = std::sync::Arc::new(lucida_store::cache::CachedStore::new(
                    store,
                    lucida_store::cache::DEFAULT_SOURCE_CACHE_BYTES,
                ));
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
/// `document_json` is the workspace document as a snapshot carries it, and
/// `ds_id` names the dataset in it; `viewport` is `(width, height)`. With
/// `view_json = None` the exploration starts from the dataset's Home view (a
/// 3D Arcball for a volume, a 2D Slice for a flat image, fitted to the whole
/// dataset as any client fits it); pass a `SavedView` JSON string to descend
/// from an explicit view (e.g. a child cell's `view` from a previous call).
/// `depth` and `breadcrumb` are stamped on the returned current node so a
/// stateless caller can keep an honest trail across calls.
///
/// This is the same engine the CLI's `dataset explore` and the web panel
/// use; the cells carry full `view` objects, not URLs.
#[pyfunction]
#[pyo3(signature = (document_json, ds_id, viewport, view_json=None, depth=0, breadcrumb=None))]
fn explore(
    document_json: &str,
    ds_id: &str,
    viewport: (u32, u32),
    view_json: Option<&str>,
    depth: u32,
    breadcrumb: Option<Vec<String>>,
) -> PyResult<String> {
    let document: DocumentState =
        serde_json::from_str(document_json).map_err(|e| PyValueError::new_err(e.to_string()))?;
    let vp = [viewport.0, viewport.1];
    let mut scene = Scene::new(vp);
    scene.load_document(document);
    let current = view_json
        .map(serde_json::from_str::<SavedView>)
        .transpose()
        .map_err(|e| PyValueError::new_err(e.to_string()))?;
    let sidecar = view_transform::explore(
        &scene,
        &DatasetId(ds_id.to_string()),
        current.as_ref(),
        vp,
        depth,
        breadcrumb.unwrap_or_default(),
    )
    .ok_or_else(|| PyValueError::new_err(format!("dataset {ds_id:?} has nothing to explore")))?;
    serde_json::to_string(&sidecar).map_err(|e| PyValueError::new_err(e.to_string()))
}

/// Encode a `SavedView` JSON string as the `#view=` payload of a viewer URL,
/// the same payload the viewer and the CLI write for the same view.
#[pyfunction]
fn encode_view_payload(view_json: &str) -> PyResult<String> {
    let view: serde_json::Value =
        serde_json::from_str(view_json).map_err(|e| PyValueError::new_err(e.to_string()))?;
    saved_view::encode_payload(&view).map_err(|e| PyValueError::new_err(e.to_string()))
}

/// Decode a viewer URL's `#view=` payload into a `SavedView` JSON string.
#[pyfunction]
fn decode_view_payload(payload: &str) -> PyResult<String> {
    saved_view::decode_payload(payload)
        .map(|view| view.to_string())
        .map_err(|e| PyValueError::new_err(e.to_string()))
}

#[pymodule]
fn lucida(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyScene>()?;
    m.add_class::<PyStore>()?;
    m.add_class::<PyProfileScene>()?;
    m.add_function(wrap_pyfunction!(explore, m)?)?;
    m.add_function(wrap_pyfunction!(encode_view_payload, m)?)?;
    m.add_function(wrap_pyfunction!(decode_view_payload, m)?)?;
    Ok(())
}
