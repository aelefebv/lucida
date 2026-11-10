use wasm_bindgen::prelude::*;

use lucida_content::DatasetId;

use crate::camera::{Arcball, Camera, ClipMode, Framing};
use crate::command::{Command, ViewportCommand};
use crate::framing::PlaneBox;
use crate::placement::CameraSpace;
use crate::saved_view::SavedView;
use crate::scene::{
    DatasetDisplaySettings, DisplayState, DocumentState, FrameTarget, Scene, member_transform,
};
use crate::view::ViewState;

#[wasm_bindgen]
pub fn chunk_key(level: u32, t: u32, c: u32, z: u32, y: u32, x: u32) -> String {
    crate::chunk::chunk_key(level, t, c, z, y, x)
}

/// The chunks each query's level samples under one view, with each chunk's
/// distance from the view's focus, from [`crate::chunk::enumerate_batch`].
///
/// `region_json` is a visible region shaped as [`WasmScene::visible_region`]
/// writes it; `depth_bias` moves the focus along Z. `queries` holds
/// [`crate::chunk::QUERY_STRIDE`] numbers per query. The planner makes one
/// call per plan, so the boundary is crossed once however many entities it
/// covers.
#[wasm_bindgen]
pub fn enumerate_chunks(
    region_json: &str,
    depth_bias: f64,
    queries: &[f64],
) -> Result<Vec<f64>, JsError> {
    let view = crate::chunk::ChunkView::from_json(region_json, depth_bias)
        .map_err(|e| JsError::new(&format!("invalid visible region: {e}")))?;
    Ok(crate::chunk::enumerate_batch(&view, queries))
}

/// A chunk the server relayed still in the codecs it was stored in, decoded
/// to exactly `len` bytes, the size its level's metadata gives one chunk.
/// `codecs` is the codec list of its frame. Bytes that decode to any other
/// size are an error, never a buffer.
#[wasm_bindgen]
pub fn decode_chunk(codecs: &[u8], payload: &[u8], len: usize) -> Result<Vec<u8>, JsError> {
    let codecs =
        lucida_protocol::codec::read_codecs(codecs).map_err(|e| JsError::new(&e.to_string()))?;
    crate::chunk_codec::decode_relayed(&codecs, payload, len)
        .map_err(|e| JsError::new(&e.to_string()))
}

/// The level the screen calls for, from [`crate::target_level::target_level`],
/// the rule every record of [`WasmScene::view_query`] applies.
/// `pixels_per_sample` is device pixels per level-0 sample, `shape_ratios[L]`
/// is how many times coarser level `L` is than level 0, and `previous` is the
/// level the caller last received for the same image, or `undefined` for the
/// rule without hysteresis.
#[wasm_bindgen]
pub fn target_level(pixels_per_sample: f64, shape_ratios: &[f64], previous: Option<u32>) -> u32 {
    crate::target_level::target_level(pixels_per_sample, shape_ratios, previous)
}

/// GPU camera matrices for an off-screen render of an arbitrary camera, in the
/// 35-float layout the volume renderer wants (`invViewProj[16] + eye[3] +
/// viewProj[16]`), the first 35 floats of [`WasmScene::minimap_camera`]'s
/// output, so the worker's thumbnail path reuses the minimap's offscreen render.
///
/// `camera_json` is a serialized [`crate::camera::Camera`]; `w`/`h` size the
/// target and override the stored viewport's aspect. The matrices come from
/// [`Camera::gpu_view_matrices`]. A malformed `camera_json` returns an empty
/// `Vec` instead of panicking, which the JS caller treats as "skip this
/// thumbnail".
#[wasm_bindgen]
pub fn camera_matrices(camera_json: &str, w: f64, h: f64) -> Vec<f32> {
    let camera: Camera = match serde_json::from_str(camera_json) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let viewport = [w.max(1.0) as u32, h.max(1.0) as u32];
    let (inv_view_proj, eye, view_proj) = camera.gpu_view_matrices(viewport);
    let mut out = Vec::with_capacity(35);
    out.extend_from_slice(&inv_view_proj);
    out.extend_from_slice(&eye);
    out.extend_from_slice(&view_proj);
    out
}

/// The peer cursor palette as CSS hex colors. A peer's color is the entry at
/// its client id modulo the length, as on its GPU cursor.
#[wasm_bindgen]
pub fn peer_palette() -> Vec<String> {
    crate::cursor::peer_palette_css()
}

/// Push the JS-side enabled-category set into the WASM logger. Pass a
/// comma-separated list (matches `localStorage.debug` format). Empty
/// string disables all WASM logging.
#[wasm_bindgen]
pub fn set_debug_categories(csv: &str) {
    let cats: Vec<&str> = csv.split(',').filter(|s| !s.is_empty()).collect();
    crate::wasm_log::set_categories(&cats);
}

// `dataset_id_for_url`, `normalize_dataset_url`, and
// `is_local_dataset_url` are exported directly from `saved_view` via
// `#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]`. They delegate to
// `lucida_content::url`, shared with the server and store.

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

    // Every mutator below is a thin JSON adapter: parse, then delegate to
    // `Scene::apply` (a `ViewportCommand`/`Command`) or to a `Scene` method.
    // All mutation and epoch semantics are owned by the always-compiled
    // `Scene` (`scene/` + `command.rs`), where `cargo test` reaches them —
    // this binding never touches `epochs` itself, so a mutator can't leave
    // the renderer on a stale plan by forgetting a bump.

    /// Load only the document portion (content graphs), preserving local
    /// camera/view/display. See [`Scene::load_document`] for the settings
    /// seeding and epoch semantics.
    pub fn load_document(&mut self, json: &str) -> Result<(), JsError> {
        let doc: DocumentState =
            serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner.load_document(doc);
        Ok(())
    }

    /// Export camera + view + display as JSON for presence updates.
    pub fn export_presence(&self) -> String {
        #[derive(serde::Serialize)]
        struct Presence<'a> {
            camera: &'a Camera,
            view: &'a ViewState,
            display: &'a DisplayState,
        }
        let p = Presence {
            camera: &self.inner.camera,
            view: &self.inner.view,
            display: &self.inner.display,
        };
        serde_json::to_string(&p).unwrap()
    }

    /// The spaces the camera's numbers are in, as JSON, for a saved view to
    /// record ([`SavedView::camera_space`]). `null` until a dataset with an
    /// image fixes them.
    pub fn camera_space(&self) -> String {
        serde_json::to_string(&self.inner.camera_space()).unwrap()
    }

    /// Import another client's camera + view + display (for follow mode).
    /// The local viewport size is preserved; see [`Scene::import_presence`].
    /// A stored view's camera comes with the `camera_space` it was saved in,
    /// and is carried from it into this scene's spaces first. A follow
    /// target's camera needs none: the two scenes share one document.
    pub fn import_presence(&mut self, json: &str) -> Result<(), JsError> {
        #[derive(serde::Deserialize)]
        struct Presence {
            camera: Camera,
            view: ViewState,
            display: DisplayState,
            #[serde(default)]
            camera_space: Option<CameraSpace>,
        }
        let p: Presence = serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        let mut camera = p.camera;
        if let Some(from) = &p.camera_space {
            self.inner.carry_camera(&mut camera, from);
        }
        self.inner.import_presence(camera, p.view, p.display);
        Ok(())
    }

    pub fn apply_command(&mut self, json: &str) -> Result<(), JsError> {
        let cmd: Command = serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner.apply(cmd);
        Ok(())
    }

    /// Fit everything visible on a canvas of `width` × `height` device
    /// pixels, in the current mode, leaving the camera framed
    /// ([`Scene::frame`]). The fit key and double tap call it. Returns whether
    /// there was anything to fit; when there wasn't, the camera is unchanged.
    pub fn frame(&mut self, width: u32, height: u32) -> bool {
        self.inner.frame(&FrameTarget::Visible, [width, height])
    }

    /// Fit the slice camera to the rect `[min_x, min_y]..[max_x, max_y]` in
    /// `dataset_id`'s frame on its canvas, as a collection's group navigator
    /// does. Returns whether it moved the camera; a volume camera ignores it.
    pub fn frame_region(
        &mut self,
        dataset_id: &str,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
    ) -> bool {
        self.inner.frame_region(
            &DatasetId(dataset_id.to_string()),
            PlaneBox::new([min_x, min_y, 0.0], [max_x, max_y, 0.0]),
        )
    }

    /// Where `dataset_id`'s frame sits in the scene frame the slice camera
    /// views, as `[offset_x, offset_y, offset_z, scale_x, scale_y, scale_z]`:
    /// a frame point `p` lands at `offset + p * scale`. Empty for a dataset
    /// the scene doesn't hold.
    pub fn dataset_placement(&self, dataset_id: &str) -> Vec<f64> {
        match self.inner.placement(&DatasetId(dataset_id.to_string())) {
            Some(placed) => placed.offset.into_iter().chain(placed.scale).collect(),
            None => Vec::new(),
        }
    }

    /// Whether `dataset_id` declares physical lengths
    /// ([`Scene::has_physical_scale`]).
    pub fn dataset_has_physical_scale(&self, dataset_id: &str) -> bool {
        self.inner
            .has_physical_scale(&DatasetId(dataset_id.to_string()))
    }

    /// The camera's framing: `"placed"`, `"framed"`, or `"unframed"`. An
    /// unframed camera shows a stand-in, which a client never persists.
    pub fn camera_framing(&self) -> String {
        match self.inner.camera.framing() {
            Framing::Placed => "placed",
            Framing::Framed => "framed",
            Framing::Unframed => "unframed",
        }
        .to_string()
    }

    /// The dataset's bounds in the current camera's coordinate space as
    /// `[min_x, min_y, min_z, max_x, max_y, max_z]`; empty when it has none.
    pub fn dataset_fit_bounds(&self, dataset_id: &str) -> Vec<f64> {
        match self.inner.dataset_fit_bounds(dataset_id) {
            Some((min, max)) => vec![min[0], min[1], min[2], max[0], max[1], max[2]],
            None => Vec::new(),
        }
    }

    /// Guided exploration of `dataset_id` from the `SavedView` in
    /// `view_json`, or from the dataset's Home view on a canvas of
    /// `viewport_w` × `viewport_h` when it is absent or empty
    /// ([`crate::view_transform::explore`]). `depth` is recorded on the
    /// current node.
    ///
    /// Returns the serialized `ExplorationSidecar`, or `{"error": "<message>"}`
    /// for a malformed view or a dataset the scene can't frame.
    pub fn explore(
        &self,
        view_json: Option<String>,
        dataset_id: &str,
        viewport_w: u32,
        viewport_h: u32,
        depth: u32,
    ) -> String {
        let error = |message: String| serde_json::json!({ "error": message }).to_string();
        let view = match view_json.as_deref() {
            Some(json) if !json.is_empty() => match serde_json::from_str::<SavedView>(json) {
                Ok(view) => Some(view),
                Err(e) => return error(e.to_string()),
            },
            _ => None,
        };
        let id = DatasetId(dataset_id.to_string());
        match crate::view_transform::explore(
            &self.inner,
            &id,
            view.as_ref(),
            [viewport_w, viewport_h],
            depth,
            Vec::new(),
        ) {
            Some(sidecar) => {
                serde_json::to_string(&sidecar).unwrap_or_else(|e| error(e.to_string()))
            }
            None => error(format!("dataset '{dataset_id}' has nothing to explore")),
        }
    }

    pub fn set_mode_arcball(&mut self) {
        self.inner.apply(ViewportCommand::SetMode3D.into());
    }

    pub fn set_mode_fly(&mut self) {
        self.inner.apply(ViewportCommand::SetModeFly.into());
    }

    pub fn camera_mode(&self) -> String {
        match &self.inner.camera {
            Camera::Slice(_) => "slice".to_string(),
            Camera::Arcball(_) => "arcball".to_string(),
            Camera::Fly(_) => "fly".to_string(),
        }
    }

    /// Assert the canvas size in device pixels and the pixel ratio behind it.
    /// Called every render tick, so it relies on `Scene::apply`'s no-change
    /// guard: a same-size re-assert bumps nothing. A caller that knows the
    /// ratio passes it every time, so a ratio change keeps the view's CSS size.
    pub fn set_viewport(&mut self, width: u32, height: u32, pixel_ratio: Option<f64>) {
        self.inner.apply(
            ViewportCommand::SetViewport {
                width,
                height,
                pixel_ratio,
            }
            .into(),
        );
    }

    pub fn center(&self) -> Vec<f64> {
        if let Camera::Slice(ref v) = self.inner.camera {
            vec![v.center[0], v.center[1]]
        } else {
            vec![0.0, 0.0]
        }
    }

    // `set_z`/`set_t` are also re-asserted every render tick, so they too
    // lean on the apply-side no-change guard.

    pub fn set_z(&mut self, z: u32) {
        self.inner.apply(ViewportCommand::SetZ { z }.into());
    }

    pub fn set_t(&mut self, t: u32) {
        self.inner.apply(ViewportCommand::SetT { t }.into());
    }

    /// What every layer shows, as JSON: [`crate::scene::ResolvedLayer`]s in
    /// panel order. The renderer, the minimap, explore thumbnails and the
    /// layer panel all read this rather than derive it from the settings.
    pub fn resolved_layers(&self) -> String {
        serde_json::to_string(&self.inner.resolved_layers()).unwrap_or_else(|_| "[]".to_string())
    }

    /// What every layer would show under the saved view in `view_json`, as
    /// JSON like [`Self::resolved_layers`]; explore previews draw a candidate
    /// view through it. A view that does not parse resolves to the scene's own.
    pub fn resolved_view_layers(&self, view_json: &str) -> String {
        let layers = match serde_json::from_str::<crate::saved_view::SavedView>(view_json) {
            Ok(view) => self.inner.resolved_view_layers(&view),
            Err(_) => self.inner.resolved_layers(),
        };
        serde_json::to_string(&layers).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn contrast_min(&self) -> f64 {
        self.inner.display.contrast_min
    }

    pub fn contrast_max(&self) -> f64 {
        self.inner.display.contrast_max
    }

    pub fn gamma(&self) -> f64 {
        self.inner.display.gamma
    }

    pub fn z(&self) -> u32 {
        self.inner.view.z_range.start
    }

    pub fn t(&self) -> u32 {
        self.inner.view.t
    }

    pub fn zoom(&self) -> f64 {
        self.inner.camera.effective_zoom()
    }

    /// Project a world-space point to screen-space pixel coordinates,
    /// using whichever camera mode is active. Returns a 2-element
    /// `Vec<f64>` `[x, y]` in physical pixels (pre-DPR-divide), or an
    /// empty `Vec` if the point is behind the camera in 3D modes
    /// (slice mode never returns empty).
    ///
    /// Empty-vec is the wasm-bindgen-friendly stand-in for `Option`:
    /// JS callers should treat `result.length === 0` as "behind the
    /// camera" and otherwise use `[result[0], result[1]]`.
    pub fn project_to_screen(&self, x: f64, y: f64, z: f64) -> Vec<f64> {
        match self.inner.camera.project_to_screen([x, y, z]) {
            Some([sx, sy]) => vec![sx, sy],
            None => Vec::new(),
        }
    }

    /// Query the scene for geometric information about all entities in a dataset.
    pub fn view_query(&self, dataset_id: &str) -> String {
        let id = DatasetId(dataset_id.into());
        match self.inner.view_query(&id) {
            Some(result) => serde_json::to_string(&result).unwrap_or_default(),
            None => "null".to_string(),
        }
    }

    /// Incremental counterpart to [`Self::view_query`]: reports only what
    /// changed since this scene last answered a delta query for the dataset.
    ///
    /// The per-dataset cursor is `#[serde(skip)]`, so the first call after the
    /// scene is constructed yields a `Full` snapshot and later calls a `Delta`,
    /// serialized as `{"Full": {...}}` or `{"Delta": {...}}` (see
    /// [`crate::query::ViewQueryDelta`]). An unknown dataset returns `"null"`,
    /// as [`Self::view_query`] does. Takes `&mut self` because answering
    /// advances the cursor.
    pub fn view_query_delta(&mut self, dataset_id: &str) -> String {
        let id = DatasetId(dataset_id.into());
        match self.inner.view_query_delta(&id) {
            Some(delta) => serde_json::to_string(&delta).unwrap_or_default(),
            None => "null".to_string(),
        }
    }

    /// Debug helper: the camera's effective zoom, for the Render tab.
    pub fn debug_effective_zoom(&self) -> f64 {
        self.inner.camera.effective_zoom()
    }

    /// The visible region of a dataset as JSON, in the dataset's own frame,
    /// where member positions are ([`Scene::visible_region`]). `"null"` for a
    /// dataset with no image.
    pub fn visible_region(&self, dataset_id: &str) -> String {
        match self
            .inner
            .visible_region(&DatasetId(dataset_id.to_string()))
        {
            Some(region) => serde_json::to_string(&region).unwrap(),
            None => "null".to_string(),
        }
    }

    /// Returns member positions as JSON: `{"entity_id": [x, y], ...}`.
    /// These are the composed layout+transform positions used by chunk
    /// planning, in the dataset's own frame.
    pub fn member_positions(&self, dataset_id: &str) -> String {
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = match self.inner.derived.get(&ds_id) {
            Some(d) => d,
            None => return "{}".to_string(),
        };
        let mut map = std::collections::HashMap::new();
        for member in &derived.members {
            map.insert(&member.entity_id.0, member.position);
        }
        serde_json::to_string(&map).unwrap()
    }

    /// The levels a level pin on `dataset_id` may hold, finest first: every
    /// source level including 0, never a generated coarse level. Empty for
    /// an unknown dataset. See [`Scene::pinnable_levels`].
    pub fn pinnable_levels(&self, dataset_id: &str) -> Vec<u32> {
        self.inner
            .pinnable_levels(&DatasetId(dataset_id.to_string()))
    }

    /// Returns the full volume shape [Z, Y, X] for a dataset.
    pub fn dataset_volume_shape(&self, dataset_id: &str) -> Vec<u32> {
        let ds_id = DatasetId(dataset_id.to_string());
        self.inner
            .derived
            .get(&ds_id)
            .and_then(|d| d.members.first())
            .and_then(|m| m.levels.first())
            .map(|l| vec![l.shape[2] as u32, l.shape[3] as u32, l.shape[4] as u32])
            .unwrap_or_else(|| vec![1, 1, 1])
    }

    /// Returns the model matrix for a specific member of a dataset,
    /// with the member's position offset baked into the translation.
    ///
    /// The placement math is owned by `Scene::member_world_matrix` (non-gated, so
    /// the minimap and the camera's fit share the exact same world boxes); this
    /// only resolves the member by id (O(1) via the derived-state member index)
    /// and delegates.
    pub fn member_model_matrix(&self, dataset_id: &str, member_id: &str) -> Vec<f32> {
        let identity = vec![
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = match self.inner.derived.get(&ds_id) {
            Some(d) => d,
            None => return identity,
        };
        let member = match derived.member_by_id(member_id) {
            Some(m) => m,
            None => return identity,
        };
        self.inner.member_world_matrix(&ds_id, member).to_vec()
    }

    /// Returns the inverse model matrix for a specific member of a dataset.
    ///
    /// The placement math is owned by `Scene::rendering_transform` (the single
    /// source — what is actually drawn); this only resolves the member by id
    /// (O(1) via the derived-state member index) and returns that transform's
    /// inverse, so picking/upload can never desync from the render.
    pub fn inv_member_model_matrix(&self, dataset_id: &str, member_id: &str) -> Vec<f32> {
        let identity = vec![
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = match self.inner.derived.get(&ds_id) {
            Some(d) => d,
            None => return identity,
        };
        let member = match derived.member_by_id(member_id) {
            Some(m) => m,
            None => return identity,
        };
        self.inner
            .rendering_transform(&ds_id, member)
            .inv_model
            .to_vec()
    }

    /// All member matrices for a dataset in one call: 32 floats per member —
    /// the forward model matrix (16) followed by its inverse (16), the exact
    /// pairs [`Self::member_model_matrix`] / [`Self::inv_member_model_matrix`]
    /// return one id at a time. Ordered to match [`Self::member_render_ids`];
    /// empty for an unknown dataset. Owned by `Scene::member_render_matrices`
    /// (non-gated); callers drawing every member of a wide collection should
    /// prefer this over per-member calls, which cross the boundary twice per
    /// member.
    pub fn member_render_matrices(&self, dataset_id: &str) -> Vec<f32> {
        self.inner.member_render_matrices(dataset_id)
    }

    /// JSON array of member image ids aligned with
    /// [`Self::member_render_matrices`]: entry `i` names the member whose
    /// matrices occupy floats `i*32 .. i*32+32`. `"[]"` for an unknown dataset.
    pub fn member_render_ids(&self, dataset_id: &str) -> String {
        serde_json::to_string(&self.inner.member_render_ids(dataset_id)).unwrap()
    }

    pub fn fly_tick(
        &mut self,
        dt: f64,
        forward: f64,
        right: f64,
        up: f64,
        yaw: f64,
        pitch: f64,
        roll: f64,
    ) {
        self.inner.apply(
            ViewportCommand::FlyTick {
                dt,
                forward,
                right,
                up,
                yaw,
                pitch,
                roll,
            }
            .into(),
        );
    }

    /// Set the base movement speed for the fly camera (world units per second).
    pub fn fly_set_base_speed(&mut self, speed: f64) {
        self.inner
            .apply(ViewportCommand::FlySetBaseSpeed { speed }.into());
    }

    /// Multiply the fly camera's speed_multiplier by the given factor.
    /// Used for scroll-wheel speed adjustment.
    pub fn fly_adjust_speed(&mut self, factor: f64) {
        self.inner
            .apply(ViewportCommand::FlyAdjustSpeed { factor }.into());
    }

    /// Return the fly camera's current speed multiplier.
    pub fn fly_speed_multiplier(&self) -> f64 {
        match &self.inner.camera {
            Camera::Fly(v) => v.speed_multiplier,
            _ => 1.0,
        }
    }

    /// Compute the world-space bounding box diagonal of the volume.
    ///
    /// The placement math is owned by [`Scene::volume_diagonal`] (non-gated,
    /// alongside the rest of the global-correction plumbing); this delegates.
    pub fn volume_diagonal(&self) -> f64 {
        self.inner.volume_diagonal()
    }

    pub fn clip_distance(&self) -> f64 {
        match &self.inner.camera {
            Camera::Arcball(v) => v.clip_distance,
            Camera::Fly(v) => v.clip_distance,
            Camera::Slice(_) => 0.0,
        }
    }

    pub fn clip_mode(&self) -> String {
        match &self.inner.camera {
            Camera::Arcball(v) => match v.clip_mode {
                ClipMode::Plane => "plane".to_string(),
                ClipMode::Sphere => "sphere".to_string(),
            },
            Camera::Fly(v) => match v.clip_mode {
                ClipMode::Plane => "plane".to_string(),
                ClipMode::Sphere => "sphere".to_string(),
            },
            Camera::Slice(_) => "plane".to_string(),
        }
    }

    pub fn adjust_clip_distance(&mut self, delta: f64) {
        self.inner
            .apply(ViewportCommand::AdjustClipDistance { delta }.into());
    }

    /// Camera forward direction in world space (normalized). Returns [fx, fy, fz].
    pub fn camera_forward(&self) -> Vec<f32> {
        match &self.inner.camera {
            Camera::Arcball(v) => {
                let fwd = v.forward_direction();
                vec![fwd[0] as f32, fwd[1] as f32, fwd[2] as f32]
            }
            Camera::Fly(v) => {
                let fwd = v.forward_direction();
                vec![fwd[0] as f32, fwd[1] as f32, fwd[2] as f32]
            }
            Camera::Slice(_) => vec![0.0, 0.0, -1.0],
        }
    }

    pub fn view_proj(&self) -> Vec<f32> {
        match &self.inner.camera {
            Camera::Arcball(v) => v.view_proj().to_vec(),
            Camera::Fly(v) => v.view_proj().to_vec(),
            _ => vec![
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
        }
    }

    pub fn inv_view_proj(&self) -> Vec<f32> {
        match &self.inner.camera {
            Camera::Arcball(v) => v.inv_view_proj().to_vec(),
            Camera::Fly(v) => v.inv_view_proj().to_vec(),
            _ => vec![
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
        }
    }

    pub fn eye_position(&self) -> Vec<f32> {
        match &self.inner.camera {
            Camera::Arcball(v) => {
                let eye = v.eye_position();
                vec![eye[0] as f32, eye[1] as f32, eye[2] as f32]
            }
            Camera::Fly(v) => {
                let eye = v.eye_position();
                vec![eye[0] as f32, eye[1] as f32, eye[2] as f32]
            }
            _ => vec![0.0, 0.0, 1.0],
        }
    }

    /// Returns the ray-volume intersection point in [0,1]^3 local space for a dataset.
    pub fn ray_hit_local(&self, dataset_id: &str) -> Vec<f32> {
        let inv_model_vec = self.inv_scene_model_matrix_for(dataset_id);
        let mut im = [0.0f64; 16];
        for (i, val) in inv_model_vec.iter().enumerate() {
            im[i] = *val as f64;
        }
        match &self.inner.camera {
            Camera::Arcball(v) => {
                let hit = v.ray_hit_local(&im);
                vec![hit[0] as f32, hit[1] as f32, hit[2] as f32]
            }
            Camera::Fly(v) => {
                let hit = v.ray_hit_local(&im);
                vec![hit[0] as f32, hit[1] as f32, hit[2] as f32]
            }
            _ => vec![0.5, 0.5, 0.5],
        }
    }

    /// Like `ray_hit_local`, but flips Y from unit space (Y-up: 0=bottom)
    /// to image space (Y-down: 0=top).
    pub fn ray_hit_local_image(&self, dataset_id: &str) -> Vec<f32> {
        let hit = self.ray_hit_local(dataset_id);
        vec![hit[0], 1.0 - hit[1], hit[2]]
    }

    /// Pick the closest entity hit by a ray cast from screen coordinates.
    /// Returns a JSON-serialized `RayHit` or `"null"` if nothing was hit.
    pub fn ray_pick(&self, dataset_id: &str, screen_x: f64, screen_y: f64) -> String {
        let id = DatasetId(dataset_id.into());
        match self.inner.ray_pick(&id, screen_x, screen_y) {
            Some(hit) => serde_json::to_string(&hit).unwrap_or_default(),
            None => "null".to_string(),
        }
    }

    /// Project a pin's stored world point `(x, y, z)` (in-plane voxel position
    /// plus additive voxel depth) to screen pixels `[sx, sy]` (physical,
    /// pre-DPR-divide) through the active camera.
    ///
    /// Slice mode uses the 2D overlay's in-plane projection. Arcball and fly
    /// lift the point through the dataset's rendering transform first, so the
    /// marker tracks the volume. Returns an empty `Vec` when the point is
    /// behind the camera or the dataset has no anchorable member, which the
    /// overlay uses to hide a pin that swings behind the volume.
    pub fn project_annotation(&self, dataset_id: &str, x: f64, y: f64, z: f64) -> Vec<f64> {
        let id = DatasetId(dataset_id.into());
        match self.inner.project_annotation(&id, x, y, z) {
            Some([sx, sy]) => vec![sx, sy],
            None => Vec::new(),
        }
    }

    /// Depth pick for dropping a pin in a 3D view: ray-cast from screen
    /// coordinates into `dataset_id`'s volume and return the hit as an
    /// in-plane-voxel + voxel-depth point `[x, y, z]` — exactly the triple to
    /// store as `position = [x, y]`, `z = z`. Returns an empty `Vec` (length 0)
    /// if the ray misses the volume, so the caller can decline to drop a pin
    /// into empty space. The returned point re-projects (via
    /// `project_annotation`) back under the cursor that picked it.
    pub fn pick_annotation_voxel(
        &self,
        dataset_id: &str,
        screen_x: f64,
        screen_y: f64,
    ) -> Vec<f64> {
        let id = DatasetId(dataset_id.into());
        match self.inner.pick_annotation_voxel(&id, screen_x, screen_y) {
            Some([x, y, z]) => vec![x, y, z],
            None => Vec::new(),
        }
    }

    pub fn dataset_order(&self) -> String {
        serde_json::to_string(&self.inner.dataset_order).unwrap()
    }

    pub fn dataset_display_settings(&self, dataset_id: &str) -> String {
        let ds_id = DatasetId(dataset_id.to_string());
        match self.inner.dataset_settings.get(&ds_id) {
            Some(s) => serde_json::to_string(s).unwrap(),
            None => serde_json::to_string(&DatasetDisplaySettings::default()).unwrap(),
        }
    }

    pub fn all_dataset_settings(&self) -> String {
        serde_json::to_string(&self.inner.dataset_settings).unwrap()
    }

    pub fn export_dataset_presence(&self) -> String {
        #[derive(serde::Serialize)]
        struct DatasetPresence<'a> {
            dataset_order: &'a Vec<DatasetId>,
            dataset_settings: &'a std::collections::HashMap<DatasetId, DatasetDisplaySettings>,
        }
        let p = DatasetPresence {
            dataset_order: &self.inner.dataset_order,
            dataset_settings: &self.inner.dataset_settings,
        };
        serde_json::to_string(&p).unwrap()
    }

    /// Import another client's dataset order + per-dataset display settings
    /// (for follow mode). See [`Scene::import_dataset_presence`].
    pub fn import_dataset_presence(&mut self, json: &str) -> Result<(), JsError> {
        #[derive(serde::Deserialize)]
        struct DatasetPresence {
            dataset_order: Vec<DatasetId>,
            dataset_settings: std::collections::HashMap<DatasetId, DatasetDisplaySettings>,
        }
        let p: DatasetPresence =
            serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner
            .import_dataset_presence(p.dataset_order, p.dataset_settings);
        Ok(())
    }

    /// Returns the dataset-level model matrix (first member, layout offsets
    /// excluded) used by the minimap projection.
    ///
    /// The placement math is owned by [`Scene::dataset_model_matrix`]
    /// (non-gated, next to `rendering_transform`); this only converts to the
    /// JS-friendly `Vec<f32>`. Identity for an unknown/empty dataset.
    pub fn scene_model_matrix_for(&self, dataset_id: &str) -> Vec<f32> {
        self.inner.dataset_model_matrix(dataset_id).to_vec()
    }

    /// Inverse of [`Self::scene_model_matrix_for`] (world space → the first
    /// member's `[0,1]³` unit space); owned by
    /// [`Scene::dataset_inv_model_matrix`]. Identity for an unknown/empty
    /// dataset.
    pub fn inv_scene_model_matrix_for(&self, dataset_id: &str) -> Vec<f32> {
        self.inner.dataset_inv_model_matrix(dataset_id).to_vec()
    }

    pub fn epochs(&self) -> String {
        serde_json::to_string(&self.inner.epochs).unwrap_or_default()
    }

    pub fn dataset_ids(&self) -> String {
        let ids: Vec<&str> = self
            .inner
            .document
            .manifests
            .keys()
            .map(|id| id.0.as_str())
            .collect();
        serde_json::to_string(&ids).unwrap()
    }

    /// Dataset ids that currently have at least one annotation, in document
    /// order. Mirrors [`Self::dataset_ids`] but reads `document.annotations`,
    /// which is keyed **independently** of `manifests`: a peer's pin/comment can
    /// land for a dataset this client hasn't opened (no manifest) yet. The
    /// browser uses this to resolve a "current dataset" for the mentions-of-me
    /// indicator when nothing is explicitly selected, so an inbound mention is
    /// counted the moment it arrives rather than waiting on a dataset selection.
    /// Read-only; no document/wire change.
    pub fn annotation_dataset_ids(&self) -> String {
        let ids: Vec<&str> = self
            .inner
            .document
            .annotations
            .keys()
            .map(|id| id.0.as_str())
            .collect();
        serde_json::to_string(&ids).unwrap()
    }

    pub fn dataset_name(&self, id: &str) -> String {
        let ds_id = DatasetId(id.to_string());
        self.inner
            .document
            .manifests
            .get(&ds_id)
            .map(|g| g.name.clone())
            .unwrap_or_else(|| id.to_string())
    }

    // Layout mutations (`register_layout` / `set_active_layout`) arrive as
    // ordinary document commands through [`Self::apply_command`]; only the
    // read side lives here.

    /// A JSON array of `{id, name, active}` for a dataset's layouts, as
    /// [`Scene::available_layouts`] lists them.
    pub fn available_layouts(&self, dataset_id: &str) -> String {
        let layouts = self
            .inner
            .available_layouts(&DatasetId(dataset_id.to_string()));
        serde_json::to_string(&layouts).unwrap()
    }

    pub fn camera_theta(&self) -> f64 {
        if let Camera::Arcball(ref v) = self.inner.camera {
            v.theta
        } else {
            0.5
        }
    }

    pub fn camera_phi(&self) -> f64 {
        if let Camera::Arcball(ref v) = self.inner.camera {
            v.phi
        } else {
            0.8
        }
    }

    /// Compute peer cursor geometry for GPU rendering + screen positions for labels.
    pub fn compute_peer_cursors(
        &self,
        peers_json: &str,
        my_id: u32,
        screen_w: f64,
        screen_h: f64,
    ) -> String {
        let peers: Vec<crate::cursor::PeerInput> =
            serde_json::from_str(peers_json).unwrap_or_default();
        let output = crate::cursor::compute_peer_cursors(
            &self.inner,
            &peers,
            my_id as u64,
            screen_w,
            screen_h,
        );
        serde_json::to_string(&output).unwrap()
    }

    /// Collaborative annotations for `dataset_id` as JSON, in document order:
    /// `[{"id","position":[x,y],"end":[x,y]|null,"z","author","kind","comments"}, ...]`.
    /// Returns `"[]"` when the dataset has no pins. `position` (and `end`, for a
    /// line/box) are 2D world-space coordinates, so the caller projects each
    /// vertex to screen with the current camera each frame (mirrors the
    /// peer-cursor overlay), keeping every kind glued to the data.
    ///
    /// Each pin also carries `channels`, its
    /// [`crate::scene::Annotation::placement_channels`]. It is derived here
    /// and never rides the document wire.
    pub fn annotations(&self, dataset_id: &str) -> String {
        let key = DatasetId(dataset_id.to_string());
        let Some(list) = self.inner.document.annotations.get(&key) else {
            return "[]".to_string();
        };
        let pins: Vec<serde_json::Value> = list
            .iter()
            .filter_map(|pin| {
                let mut value = serde_json::to_value(pin).ok()?;
                if let serde_json::Value::Object(fields) = &mut value {
                    fields.insert(
                        "channels".to_string(),
                        serde_json::json!(pin.placement_channels(&key)),
                    );
                }
                Some(value)
            })
            .collect();
        serde_json::to_string(&pins).unwrap_or_else(|_| "[]".to_string())
    }

    /// Returns 36 floats: invViewProj[16] + eye[3] + viewProj[16] + topDown[1].
    ///
    /// `topDown` is `1` when every framed member has one Z plane and the camera
    /// looks straight down Z, ignoring `theta`/`phi`, and `0` for the orbit.
    /// See [`crate::minimap::minimap_framing`].
    pub fn minimap_camera(&self, theta: f64, phi: f64, w: f64, h: f64) -> Vec<f32> {
        use crate::minimap::{MinimapFraming, minimap_framing, top_down_view};

        let viewport = [w as u32, h as u32];
        let (view_proj, eye, top_down) = match minimap_framing(&self.minimap_members()) {
            MinimapFraming::Orbit { target, distance } => {
                let cam = Arcball {
                    target,
                    theta,
                    phi,
                    distance,
                    fov: std::f64::consts::FRAC_PI_4,
                    viewport,
                    near: 0.01,
                    far: (distance * 4.0_f64).max(100.0),
                    clip_distance: 0.0,
                    clip_mode: crate::camera::ClipMode::default(),
                    framing: Framing::Placed,
                };
                (cam.view_proj_f64(), cam.eye_position(), false)
            }
            MinimapFraming::TopDown { bounds } => {
                let (view_proj, eye) = top_down_view(bounds, viewport);
                (view_proj, eye, true)
            }
        };
        let mut out = Vec::with_capacity(36);
        out.extend_from_slice(&crate::mat4::invert4_f32(view_proj));
        out.extend(eye.iter().map(|&v| v as f32));
        out.extend(view_proj.iter().map(|&v| v as f32));
        out.push(if top_down { 1.0 } else { 0.0 });
        out
    }

    /// Every member's world box, visibility, and plane count, for
    /// [`crate::minimap::minimap_framing`].
    fn minimap_members(&self) -> Vec<crate::minimap::MinimapMember> {
        let mut members = Vec::new();

        for (ds_id, derived) in &self.inner.derived {
            let visible = self
                .inner
                .dataset_settings
                .get(ds_id)
                .map(|s| s.visible)
                .unwrap_or(true);
            let Some(to_world) = self.inner.frame_to_world(ds_id) else {
                continue;
            };
            for member in &derived.members {
                members.push(crate::minimap::MinimapMember {
                    // Shared with the renderer and the camera's fit, so the minimap
                    // frames the boxes that are drawn.
                    model: member_transform(&to_world, member).model,
                    visible,
                    z_planes: member.levels.first().map_or(0, |l| l.shape[2]),
                });
            }
        }

        members
    }
}
