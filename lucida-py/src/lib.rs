use std::sync::{Arc, OnceLock};

use object_store::{ObjectStore, ObjectStoreExt};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyBytes;
use pyo3::wrap_pyfunction;

use lucida_content::DatasetId;
use lucida_core::camera::Camera;
use lucida_core::command::{Command, ViewportCommand};
use lucida_core::protocol::ClientMessage;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::{DisplayState, Scene};
use lucida_core::view::ViewState;
use lucida_core::view_transform::{ExplorationSidecar, ViewExtent, default_view};

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "lucida-cli";

#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;

fn decode_keychain_token(bytes: Vec<u8>) -> Result<Option<String>, String> {
    let token = String::from_utf8(bytes)
        .map_err(|_| "macOS Keychain token is not valid UTF-8".to_string())?;
    let token = token.trim().to_string();
    Ok((!token.is_empty()).then_some(token))
}

#[cfg(target_os = "macos")]
fn native_keychain_token(server_url: &str) -> Result<Option<String>, String> {
    let options = security_framework::passwords::PasswordOptions::new_generic_password(
        KEYCHAIN_SERVICE,
        server_url,
    );
    match security_framework::passwords::generic_password(options) {
        Ok(bytes) => decode_keychain_token(bytes),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(error) => Err(format!("failed to read token from macOS Keychain: {error}")),
    }
}

#[cfg(not(target_os = "macos"))]
fn native_keychain_token(_server_url: &str) -> Result<Option<String>, String> {
    Ok(None)
}

/// Read the CLI-compatible generic-password entry without exposing the token
/// through a subprocess argument, environment, or output stream.
#[pyfunction]
fn read_keychain_token(server_url: &str) -> PyResult<Option<String>> {
    native_keychain_token(server_url).map_err(PyRuntimeError::new_err)
}

#[pyclass]
struct PyScene {
    inner: Scene,
}

fn apply_scene_command(scene: &mut Scene, command: Command) -> PyResult<()> {
    scene
        .try_apply(command)
        .map_err(command_validation_py_error)
}

fn command_validation_py_error(error: lucida_core::scene::CommandValidationError) -> PyErr {
    PyValueError::new_err(
        serde_json::json!({
            "kind": "rejected_command",
            "category": error.category,
            "path": error.path,
            "message": error.message,
        })
        .to_string(),
    )
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
        self.inner
            .try_load_document(doc)
            .map_err(command_validation_py_error)
    }

    fn apply_command(&mut self, json: &str) -> PyResult<()> {
        let cmd: Command = serde_json::from_str(json)
            .map_err(|e| PyErr::new::<pyo3::exceptions::PyValueError, _>(e.to_string()))?;
        apply_scene_command(&mut self.inner, cmd)
    }

    fn pan(&mut self, dx: f64, dy: f64) -> PyResult<String> {
        let cmd = ViewportCommand::Pan { dx, dy };
        apply_scene_command(&mut self.inner, cmd.clone().into())?;
        Ok(serde_json::to_string(&cmd).unwrap())
    }

    fn zoom_by(&mut self, factor: f64) -> PyResult<String> {
        let cmd = ViewportCommand::ZoomBy { factor };
        apply_scene_command(&mut self.inner, cmd.clone().into())?;
        Ok(serde_json::to_string(&cmd).unwrap())
    }

    fn set_center(&mut self, x: f64, y: f64) -> PyResult<String> {
        let cmd = ViewportCommand::SetCenter { x, y };
        apply_scene_command(&mut self.inner, cmd.clone().into())?;
        Ok(serde_json::to_string(&cmd).unwrap())
    }

    fn set_zoom(&mut self, value: f64) -> PyResult<String> {
        let cmd = ViewportCommand::SetZoom { value };
        apply_scene_command(&mut self.inner, cmd.clone().into())?;
        Ok(serde_json::to_string(&cmd).unwrap())
    }

    fn set_z(&mut self, z: u32) -> PyResult<String> {
        let cmd = ViewportCommand::SetZ { z };
        apply_scene_command(&mut self.inner, cmd.clone().into())?;
        Ok(serde_json::to_string(&cmd).unwrap())
    }

    fn set_t(&mut self, t: u32) -> PyResult<String> {
        let cmd = ViewportCommand::SetT { t };
        apply_scene_command(&mut self.inner, cmd.clone().into())?;
        Ok(serde_json::to_string(&cmd).unwrap())
    }

    fn set_c(&mut self, c: u32) -> PyResult<String> {
        let cmd = ViewportCommand::SetC { c };
        apply_scene_command(&mut self.inner, cmd.clone().into())?;
        Ok(serde_json::to_string(&cmd).unwrap())
    }

    fn set_mode_slice(&mut self) -> PyResult<()> {
        apply_scene_command(&mut self.inner, ViewportCommand::SetMode2D.into())
    }

    fn set_mode_arcball(&mut self) -> PyResult<()> {
        apply_scene_command(&mut self.inner, ViewportCommand::SetMode3D.into())
    }

    fn camera_mode(&self) -> String {
        match self.inner.camera() {
            Camera::Slice(_) => "slice".to_string(),
            Camera::Arcball(_) => "arcball".to_string(),
            Camera::Fly(_) => "fly".to_string(),
        }
    }

    fn arcball_rotate(&mut self, d_theta: f64, d_phi: f64) -> PyResult<String> {
        let cmd = ViewportCommand::Rotate3D { d_theta, d_phi };
        apply_scene_command(&mut self.inner, cmd.clone().into())?;
        Ok(serde_json::to_string(&cmd).unwrap())
    }

    fn zoom(&self) -> f64 {
        self.inner.camera().effective_zoom()
    }

    fn center(&self) -> (f64, f64) {
        if let Camera::Slice(v) = self.inner.camera() {
            (v.center[0], v.center[1])
        } else {
            (0.0, 0.0)
        }
    }

    fn z(&self) -> u32 {
        self.inner.view().z_range.start
    }

    fn t(&self) -> u32 {
        self.inner.view().t
    }

    fn c(&self) -> u32 {
        self.inner.view().c
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
        serde_json::to_string(self.inner.camera()).unwrap()
    }

    fn presence_json(&self) -> String {
        let msg = ClientMessage::Presence {
            camera: self.inner.camera().clone(),
            view: self.inner.view().clone(),
            display: self.inner.display().clone(),
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
            .document()
            .manifests
            .keys()
            .map(|id| id.0.as_str())
            .collect();
        serde_json::to_string(&ids).unwrap()
    }

    fn dataset_name(&self, id: &str) -> String {
        self.inner
            .document()
            .manifests
            .get(&DatasetId(id.to_string()))
            .map(|cg| cg.name.clone())
            .unwrap_or_default()
    }
}

#[pyclass]
struct PyStore {
    store: Arc<dyn ObjectStore>,
    dataset_id: String,
}

const DEFAULT_MAX_CHUNK_BYTES: u64 = 64 * 1024 * 1024;
const STORE_RUNTIME_WORKER_THREADS: usize = 2;
static STORE_RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();

fn store_runtime() -> PyResult<&'static tokio::runtime::Runtime> {
    match STORE_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(STORE_RUNTIME_WORKER_THREADS)
            .thread_name("lucida-py-io")
            .enable_all()
            .build()
            .map_err(|error| error.to_string())
    }) {
        Ok(runtime) => Ok(runtime),
        Err(error) => Err(pyo3::exceptions::PyRuntimeError::new_err(error.clone())),
    }
}

#[pymethods]
impl PyStore {
    /// Open a StorageBackend from a URL.
    /// "/" prefix -> local filesystem, "gs://" -> GCS.
    #[staticmethod]
    fn open(url: &str) -> PyResult<Self> {
        let store = lucida_store::backend::open(url)
            .map_err(|e| pyo3::exceptions::PyValueError::new_err(e.to_string()))?;
        // Initialize once at open time so later I/O calls cannot fail because
        // a runtime was unavailable. All PyStore instances share two workers.
        let _ = store_runtime()?;
        Ok(Self {
            store,
            dataset_id: lucida_content::url::dataset_id_for_url(url),
        })
    }

    /// Stable, locator-derived identity used by metadata imports.
    fn dataset_id(&self) -> &str {
        &self.dataset_id
    }

    /// Import dataset from OME-Zarr, return JSON string of ImportResult.
    fn read_metadata(&self, py: Python<'_>, name: &str) -> PyResult<String> {
        let store = self.store.clone();
        let name = name.to_string();
        let dataset_id = self.dataset_id.clone();
        let runtime = store_runtime()?;
        let result = py
            .detach(move || {
                runtime.block_on(async {
                    lucida_store::import::import_dataset(&store, &dataset_id, &name).await
                })
            })
            .map_err(|e| pyo3::exceptions::PyValueError::new_err(e.to_string()))?;

        let json = serde_json::to_string(&result)
            .map_err(|e| pyo3::exceptions::PyValueError::new_err(e.to_string()))?;
        Ok(json)
    }

    /// Read one bounded chunk as Python `bytes` (never a list of Python ints).
    #[pyo3(signature = (path, *, max_bytes=DEFAULT_MAX_CHUNK_BYTES))]
    fn read_chunk<'py>(
        &self,
        py: Python<'py>,
        path: &str,
        max_bytes: u64,
    ) -> PyResult<Bound<'py, PyBytes>> {
        if max_bytes == 0 {
            return Err(PyValueError::new_err("max_bytes must be positive"));
        }
        let store = self.store.clone();
        let obj_path = object_store::path::Path::from(path);
        let runtime = store_runtime()?;
        let bytes = py
            .detach(move || {
                runtime.block_on(async {
                    let result = store.get(&obj_path).await?;
                    if result.meta.size > max_bytes {
                        return Err(object_store::Error::Generic {
                            store: "lucida-py",
                            source: format!(
                                "chunk is {} bytes; limit is {max_bytes}",
                                result.meta.size
                            )
                            .into(),
                        });
                    }
                    let bytes = result.bytes().await?;
                    if bytes.len() as u64 > max_bytes {
                        return Err(object_store::Error::Generic {
                            store: "lucida-py",
                            source: format!("chunk is {} bytes; limit is {max_bytes}", bytes.len())
                                .into(),
                        });
                    }
                    Ok(bytes)
                })
            })
            .map_err(|e| pyo3::exceptions::PyIOError::new_err(e.to_string()))?;
        Ok(PyBytes::new(py, &bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_runtime_is_process_shared() {
        let first = store_runtime().unwrap() as *const _;
        let second = store_runtime().unwrap() as *const _;
        assert_eq!(first, second);
        assert_eq!(STORE_RUNTIME_WORKER_THREADS, 2);
    }

    #[test]
    fn keychain_token_decoding_is_bounded_to_text_or_absence() {
        assert_eq!(
            decode_keychain_token(b"  lucida_pat_test\n".to_vec()).unwrap(),
            Some("lucida_pat_test".to_string())
        );
        assert_eq!(decode_keychain_token(b" \n".to_vec()).unwrap(), None);
        assert!(decode_keychain_token(vec![0xff]).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_keychain_read_api_compiles_without_accessing_user_credentials() {
        let _: fn(
            security_framework::passwords::PasswordOptions,
        ) -> security_framework::base::Result<Vec<u8>> =
            security_framework::passwords::generic_password;
    }

    #[test]
    fn dataset_ids_are_stable_and_locator_specific() {
        let first = lucida_content::url::dataset_id_for_url("/tmp/first.zarr");
        assert_eq!(
            first,
            lucida_content::url::dataset_id_for_url("/tmp/first.zarr")
        );
        assert_ne!(
            first,
            lucida_content::url::dataset_id_for_url("/tmp/second.zarr")
        );
    }

    #[test]
    fn two_store_import_targets_keep_distinct_stable_identities() {
        let root =
            std::env::temp_dir().join(format!("lucida-py-store-identity-{}", std::process::id()));
        let first_path = root.join("first.zarr");
        let second_path = root.join("second.zarr");
        std::fs::create_dir_all(&first_path).unwrap();
        std::fs::create_dir_all(&second_path).unwrap();

        let first = PyStore::open(first_path.to_str().unwrap()).unwrap();
        let first_again = PyStore::open(first_path.to_str().unwrap()).unwrap();
        let second = PyStore::open(second_path.to_str().unwrap()).unwrap();

        assert_eq!(first.dataset_id(), first_again.dataset_id());
        assert_ne!(first.dataset_id(), second.dataset_id());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_document_restore_is_rejected_atomically() {
        Python::initialize();
        let mut scene = PyScene::new(640, 480);
        let before = serde_json::to_value(&scene.inner).unwrap();
        let mut invalid = lucida_core::scene::DocumentState::default();
        invalid
            .registered_layouts
            .insert(lucida_core::DatasetId("missing".into()), Vec::new());

        let error = scene
            .load_document(&serde_json::to_string(&invalid).unwrap())
            .unwrap_err();

        assert!(error.to_string().contains("missing"));
        assert_eq!(serde_json::to_value(&scene.inner).unwrap(), before);
    }

    #[test]
    fn typed_nan_mutation_is_rejected_atomically() {
        Python::initialize();
        let mut scene = PyScene::new(640, 480);
        let before = serde_json::to_value(&scene.inner).unwrap();

        let error = scene.set_zoom(f64::NAN).unwrap_err();

        assert!(error.to_string().contains("invalid"));
        assert_eq!(serde_json::to_value(&scene.inner).unwrap(), before);
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
    m.add_function(wrap_pyfunction!(read_keychain_token, m)?)?;
    Ok(())
}
