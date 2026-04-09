use wasm_bindgen::prelude::*;

use crate::camera::{Camera, Arcball, ClipMode};
use crate::command::Command;
use crate::scene::{DisplayState, DocumentState, Layer, DatasetDisplaySettings, LevelInfo, Scene};
use crate::view::ViewState;

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

    pub fn load_snapshot(&mut self, json: &str) -> Result<(), JsError> {
        let scene: crate::scene::Scene =
            serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner = scene;
        Ok(())
    }

    /// Load only the document portion (datasets), preserving local camera/view/display.
    pub fn load_document(&mut self, json: &str) -> Result<(), JsError> {
        let doc: DocumentState =
            serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner.document = doc;
        // Ensure dataset_order and dataset_settings are consistent with loaded datasets.
        // add_dataset() does this automatically, but load_document() bypasses it.
        for ds in &self.inner.document.datasets {
            let id = ds.id.clone();
            if !self.inner.dataset_order.contains(&id) {
                self.inner.dataset_order.push(id.clone());
            }
            self.inner
                .dataset_settings
                .entry(id)
                .or_insert_with(Default::default);
        }
        // Remove stale entries for datasets no longer in the document.
        let dataset_ids: std::collections::HashSet<&str> = self
            .inner
            .document
            .datasets
            .iter()
            .map(|d| d.id.as_str())
            .collect();
        self.inner
            .dataset_order
            .retain(|id| dataset_ids.contains(id.as_str()));
        self.inner
            .dataset_settings
            .retain(|id, _| dataset_ids.contains(id.as_str()));
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

    /// Import another client's camera + view + display (for follow mode).
    pub fn import_presence(&mut self, json: &str) -> Result<(), JsError> {
        #[derive(serde::Deserialize)]
        struct Presence {
            camera: Camera,
            view: ViewState,
            display: DisplayState,
        }
        let p: Presence =
            serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        // Preserve local viewport size
        let viewport = self.inner.camera.viewport();
        self.inner.camera = p.camera;
        self.inner.camera.set_viewport(viewport[0], viewport[1]);
        self.inner.view = p.view;
        self.inner.display = p.display;
        Ok(())
    }

    pub fn apply_command(&mut self, json: &str) -> Result<(), JsError> {
        let cmd: Command = serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner.apply(cmd);
        Ok(())
    }

    // --- Mode switching ---

    pub fn set_mode_slice(&mut self) {
        self.inner.set_mode_2d();
    }

    pub fn set_mode_arcball(&mut self) {
        self.inner.set_mode_3d();
    }

    pub fn set_mode_fly(&mut self) {
        self.inner.set_mode_fly();
    }

    pub fn camera_mode(&self) -> String {
        match &self.inner.camera {
            Camera::Slice(_) => "slice".to_string(),
            Camera::Arcball(_) => "arcball".to_string(),
            Camera::Fly(_) => "fly".to_string(),
        }
    }

    // --- Shared viewport ---

    pub fn set_viewport(&mut self, width: u32, height: u32) {
        self.inner.camera.set_viewport(width, height);
    }

    // --- Layer management ---

    /// Add a layer with chunk size and data shape in [Z, Y, X] order.
    pub fn add_layer(
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
    pub fn set_level_info(
        &mut self,
        layer_index: usize,
        shapes_flat: &[u32],
        chunks_flat: &[u32],
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

    // --- 2D camera methods ---

    pub fn pan(&mut self, dx: f64, dy: f64) {
        if let Camera::Slice(ref mut v) = self.inner.camera {
            v.pan(dx, dy);
        }
    }

    pub fn zoom_by(&mut self, factor: f64) {
        if let Camera::Slice(ref mut v) = self.inner.camera {
            v.zoom_by(factor);
        }
    }

    pub fn set_center(&mut self, x: f64, y: f64) {
        if let Camera::Slice(ref mut v) = self.inner.camera {
            v.center = [x, y];
        }
    }

    pub fn center(&self) -> Vec<f64> {
        if let Camera::Slice(ref v) = self.inner.camera {
            vec![v.center[0], v.center[1]]
        } else {
            vec![0.0, 0.0]
        }
    }

    pub fn set_zoom(&mut self, value: f64) {
        if let Camera::Slice(ref mut v) = self.inner.camera {
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

    // --- Multi-channel ---

    pub fn multi_channel(&self) -> bool {
        self.inner.view.multi_channel
    }

    pub fn set_multi_channel(&mut self, enabled: bool) {
        self.inner.view.multi_channel = enabled;
    }

    // --- Display state ---

    pub fn contrast_min(&self) -> f64 {
        self.inner.display.contrast_min
    }

    pub fn contrast_max(&self) -> f64 {
        self.inner.display.contrast_max
    }

    pub fn gamma(&self) -> f64 {
        self.inner.display.gamma
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
            Camera::Slice(v) => {
                let bounds = v.world_bounds();
                serde_json::to_string(&bounds).unwrap()
            }
            Camera::Arcball(_) | Camera::Fly(_) => {
                // Return the visible region xy_bounds for 3D
                let region = self.inner.camera.visible_region(
                    &self.inner.view.z_range,
                    self.inner.volume_transform(),
                    self.inner.volume_shape(),
                );
                serde_json::to_string(&region.xy_bounds).unwrap()
            }
        }
    }

    /// Debug helper: returns [effective_zoom, zoom_per_voxel] for a dataset.
    pub fn debug_lod_info(&self, dataset_id: &str) -> Vec<f64> {
        let ds = match self.inner.dataset_by_id(dataset_id) {
            Some(d) => d,
            None => return vec![0.0, 0.0],
        };
        let region = self.inner.camera.visible_region(
            &self.inner.view.z_range,
            ds.volume_transform.as_ref(),
            ds.volume_shape.as_ref(),
        );
        vec![self.inner.camera.effective_zoom(), region.effective_zoom]
    }

    pub fn chunk_plan(&self) -> String {
        let plan = self.inner.chunk_plan();
        serde_json::to_string(&plan).unwrap()
    }

    pub fn chunk_plan_for(&self, dataset_id: &str) -> String {
        let plans = self.inner.chunk_plan_for(dataset_id);
        serde_json::to_string(&plans).unwrap()
    }

    /// Returns the full volume shape [Z, Y, X] for a dataset.
    /// For plates, this is the full plate extent; for single datasets, the layer shape.
    pub fn dataset_volume_shape(&self, dataset_id: &str) -> Vec<u32> {
        self.inner.dataset_by_id(dataset_id)
            .and_then(|d| d.volume_shape)
            .map(|s| s.to_vec())
            .unwrap_or_else(|| {
                self.inner.dataset_by_id(dataset_id)
                    .and_then(|d| d.layers.first())
                    .map(|l| l.data_shape.to_vec())
                    .unwrap_or_else(|| vec![1, 1, 1])
            })
    }

    /// Returns the model matrix for a specific member of a dataset,
    /// with the member's position offset baked into the translation.
    pub fn member_model_matrix(&self, dataset_id: &str, member_id: &str) -> Vec<f32> {
        let dataset = match self.inner.dataset_by_id(dataset_id) {
            Some(ds) => ds,
            None => return vec![
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        };
        let member = dataset.effective_members().into_iter()
            .find(|m| m.id == member_id);
        let offset = match member {
            Some(m) => m.position,
            None => [0.0, 0.0],
        };
        let vol_shape = dataset.volume_shape.unwrap_or([1, 1, 1]);
        let t = match dataset.volume_transform.as_ref() {
            Some(t) => t,
            None => return vec![
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        };
        // Recover the original voxel scale from the volume transform.
        // model[0] = phys_x / max_phys = (scale_x * vol_shape_x) / max_phys
        // So scale_x = model[0] * max_phys / vol_shape_x
        let max_phys = if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 };
        let scale_x = if vol_shape[2] > 0 { t.model[0] as f64 * max_phys / vol_shape[2] as f64 } else { 1.0 };
        let scale_y = if vol_shape[1] > 0 { t.model[5] as f64 * max_phys / vol_shape[1] as f64 } else { 1.0 };
        let scale_z = if vol_shape[0] > 0 { t.model[10] as f64 * max_phys / vol_shape[0] as f64 } else { 1.0 };
        // Use the FOV shape (layer data_shape) for member transforms, not the
        // plate extent (volume_shape). Each FOV renders at its actual size.
        let fov_shape = dataset.layers.first()
            .map(|l| l.data_shape)
            .unwrap_or(vol_shape);
        // Flip Y offset: member positions are in voxel space (Y=0 at top),
        // but the 3D model matrix uses Y-up convention (Y=0 at bottom).
        let flipped_offset = [offset[0], vol_shape[1] as f64 - offset[1] - fov_shape[1] as f64];
        let mt = crate::transform::compute_member_transform(
            fov_shape,
            [scale_z, scale_y, scale_x],
            flipped_offset,
            max_phys,
        );
        // Apply global correction for multi-dataset scenes (same as scene_model_matrix_for).
        let global_max = self.inner.global_max_physical_extent();
        let correction = (max_phys / global_max) as f32;
        let mut m = mt.model;
        m[0] *= correction;
        m[5] *= correction;
        m[10] *= correction;
        m[12] *= correction;
        m[13] *= correction;
        // Top-align: shift smaller datasets up so top edges match.
        let phys_y = t.model[5] as f64 * max_phys;
        let global_max_y = self.inner.global_max_physical_y();
        m[13] += ((global_max_y - phys_y) / global_max) as f32;
        m.to_vec()
    }

    /// Returns the inverse model matrix for a specific member of a dataset.
    pub fn inv_member_model_matrix(&self, dataset_id: &str, member_id: &str) -> Vec<f32> {
        let dataset = match self.inner.dataset_by_id(dataset_id) {
            Some(ds) => ds,
            None => return vec![
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        };
        let member = dataset.effective_members().into_iter()
            .find(|m| m.id == member_id);
        let offset = match member {
            Some(m) => m.position,
            None => [0.0, 0.0],
        };
        let vol_shape = dataset.volume_shape.unwrap_or([1, 1, 1]);
        let t = match dataset.volume_transform.as_ref() {
            Some(t) => t,
            None => return vec![
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        };
        let max_phys = if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 };
        let scale_x = if vol_shape[2] > 0 { t.model[0] as f64 * max_phys / vol_shape[2] as f64 } else { 1.0 };
        let scale_y = if vol_shape[1] > 0 { t.model[5] as f64 * max_phys / vol_shape[1] as f64 } else { 1.0 };
        let scale_z = if vol_shape[0] > 0 { t.model[10] as f64 * max_phys / vol_shape[0] as f64 } else { 1.0 };
        let fov_shape = dataset.layers.first()
            .map(|l| l.data_shape)
            .unwrap_or(vol_shape);
        // Flip Y offset (same as member_model_matrix).
        let flipped_offset = [offset[0], vol_shape[1] as f64 - offset[1] - fov_shape[1] as f64];
        let mt = crate::transform::compute_member_transform(
            fov_shape,
            [scale_z, scale_y, scale_x],
            flipped_offset,
            max_phys,
        );
        // Apply inverse global correction for multi-dataset scenes.
        let global_max = self.inner.global_max_physical_extent();
        let inv_correction = (global_max / max_phys) as f32;
        let mut m = mt.inv_model;
        m[0] *= inv_correction;
        m[5] *= inv_correction;
        m[10] *= inv_correction;
        // The member inv_model already contains -tx/sx and -ty/sy in m[12], m[13].
        // After scaling the diagonal by inv_correction, the translation entries
        // (which encode -offset/scale) are unchanged because the offset was
        // already in the pre-correction coordinate system.
        // Add inverse of Y-translation (top-align): -ta * corrected_inv_sy.
        let phys_y = t.model[5] as f64 * max_phys;
        let global_max_y = self.inner.global_max_physical_y();
        let ta = ((global_max_y - phys_y) / global_max) as f32;
        m[13] -= ta * m[5];
        m.to_vec()
    }

    // --- 3D camera methods ---

    pub fn arcball_rotate(&mut self, d_theta: f64, d_phi: f64) {
        if let Camera::Arcball(ref mut v) = self.inner.camera {
            v.rotate(d_theta, d_phi);
        }
    }

    pub fn arcball_zoom(&mut self, delta: f64) {
        if let Camera::Arcball(ref mut v) = self.inner.camera {
            v.zoom(delta);
        }
    }

    pub fn arcball_pan(&mut self, dx: f64, dy: f64) {
        if let Camera::Arcball(ref mut v) = self.inner.camera {
            v.pan(dx, dy);
        }
    }

    // --- Fly camera methods ---

    pub fn fly_tick(&mut self, dt: f64, forward: f64, right: f64, up: f64, yaw: f64, pitch: f64, roll: f64) {
        if let Camera::Fly(ref mut v) = self.inner.camera {
            v.fly_tick(dt, forward, right, up, yaw, pitch, roll);
        }
    }

    /// Set the base movement speed for the fly camera (world units per second).
    pub fn fly_set_base_speed(&mut self, speed: f64) {
        if let Camera::Fly(ref mut v) = self.inner.camera {
            v.base_speed = speed;
        }
    }

    /// Multiply the fly camera's speed_multiplier by the given factor.
    /// Used for scroll-wheel speed adjustment.
    pub fn fly_adjust_speed(&mut self, factor: f64) {
        if let Camera::Fly(ref mut v) = self.inner.camera {
            v.speed_multiplier = (v.speed_multiplier * factor).clamp(0.01, 100.0);
        }
    }

    /// Return the fly camera's current speed multiplier.
    pub fn fly_speed_multiplier(&self) -> f64 {
        match &self.inner.camera {
            Camera::Fly(v) => v.speed_multiplier,
            _ => 1.0,
        }
    }

    /// Compute the world-space bounding box diagonal of the volume.
    /// This is sqrt(sx^2 + sy^2 + sz^2) where sx/sy/sz are the model matrix
    /// scale factors (corrected for multi-dataset normalization).
    /// Returns 1.0 if no volume transform is available.
    pub fn volume_diagonal(&self) -> f64 {
        // Use the first dataset's scene model matrix (same as scene_model_matrix_for)
        let ds = match self.inner.document.datasets.first() {
            Some(d) => d,
            None => return 1.0,
        };
        let t = match ds.volume_transform.as_ref() {
            Some(t) => t,
            None => return 1.0,
        };
        let global_max = self.inner.global_max_physical_extent();
        let ds_max = if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 };
        let correction = ds_max / global_max;
        let sx = t.model[0] as f64 * correction;
        let sy = t.model[5] as f64 * correction;
        let sz = t.model[10] as f64 * correction;
        (sx * sx + sy * sy + sz * sz).sqrt()
    }

    // --- Clip distance methods ---

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

    pub fn set_clip_distance(&mut self, distance: f64) {
        let d = distance.max(0.0);
        match &mut self.inner.camera {
            Camera::Arcball(v) => v.clip_distance = d,
            Camera::Fly(v) => v.clip_distance = d,
            Camera::Slice(_) => {}
        }
    }

    pub fn set_clip_mode(&mut self, mode: &str) {
        let m = match mode {
            "sphere" => ClipMode::Sphere,
            _ => ClipMode::Plane,
        };
        match &mut self.inner.camera {
            Camera::Arcball(v) => v.clip_mode = m,
            Camera::Fly(v) => v.clip_mode = m,
            Camera::Slice(_) => {}
        }
    }

    pub fn adjust_clip_distance(&mut self, delta: f64) {
        match &mut self.inner.camera {
            Camera::Arcball(v) => v.clip_distance = (v.clip_distance + delta).max(0.0),
            Camera::Fly(v) => v.clip_distance = (v.clip_distance + delta).max(0.0),
            Camera::Slice(_) => {}
        }
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

    pub fn view_proj(&self) -> Vec<f32> {
        match &self.inner.camera {
            Camera::Arcball(v) => v.view_proj().to_vec(),
            Camera::Fly(v) => v.view_proj().to_vec(),
            _ => vec![
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
            ],
        }
    }

    pub fn inv_view_proj(&self) -> Vec<f32> {
        match &self.inner.camera {
            Camera::Arcball(v) => v.inv_view_proj().to_vec(),
            Camera::Fly(v) => v.inv_view_proj().to_vec(),
            _ => vec![
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                0.0, 0.0, 0.0, 1.0,
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
    /// This is where the center-screen ray hits the volume bounding box.
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

    // --- Layer display settings ---

    pub fn dataset_order(&self) -> String {
        serde_json::to_string(&self.inner.dataset_order).unwrap()
    }

    pub fn dataset_display_settings(&self, dataset_id: &str) -> String {
        match self.inner.dataset_settings.get(dataset_id) {
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
            dataset_order: &'a Vec<String>,
            dataset_settings: &'a std::collections::HashMap<String, DatasetDisplaySettings>,
        }
        let p = DatasetPresence {
            dataset_order: &self.inner.dataset_order,
            dataset_settings: &self.inner.dataset_settings,
        };
        serde_json::to_string(&p).unwrap()
    }

    pub fn import_dataset_presence(&mut self, json: &str) -> Result<(), JsError> {
        #[derive(serde::Deserialize)]
        struct DatasetPresence {
            dataset_order: Vec<String>,
            dataset_settings: std::collections::HashMap<String, DatasetDisplaySettings>,
        }
        let p: DatasetPresence =
            serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner.dataset_order = p.dataset_order;
        self.inner.dataset_settings = p.dataset_settings;
        Ok(())
    }

    pub fn scene_model_matrix_for(&self, dataset_id: &str) -> Vec<f32> {
        match self.inner.dataset_by_id(dataset_id).and_then(|d| d.volume_transform.as_ref()) {
            Some(t) => {
                let global_max = self.inner.global_max_physical_extent();
                let ds_max = if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 };
                let correction = (ds_max / global_max) as f32;
                let mut m = t.model;
                m[0] *= correction;
                m[5] *= correction;
                m[10] *= correction;
                // Top-align: shift smaller datasets up so top edges match
                let phys_y = t.model[5] as f64 * ds_max;
                let global_max_y = self.inner.global_max_physical_y();
                m[13] = ((global_max_y - phys_y) / global_max) as f32;
                m.to_vec()
            }
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

    pub fn inv_scene_model_matrix_for(&self, dataset_id: &str) -> Vec<f32> {
        match self.inner.dataset_by_id(dataset_id).and_then(|d| d.volume_transform.as_ref()) {
            Some(t) => {
                let global_max = self.inner.global_max_physical_extent();
                let ds_max = if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 };
                let inv_correction = (global_max / ds_max) as f32;
                let mut m = t.inv_model;
                m[0] *= inv_correction;
                m[5] *= inv_correction;
                m[10] *= inv_correction;
                // Inverse of Y-translation: -ty * corrected_inv_sy
                let phys_y = t.model[5] as f64 * ds_max;
                let global_max_y = self.inner.global_max_physical_y();
                let ty = ((global_max_y - phys_y) / global_max) as f32;
                m[13] = -ty * m[5];
                m.to_vec()
            }
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

    pub fn dataset_ids(&self) -> String {
        let ids: Vec<&str> = self.inner.document.datasets.iter().map(|d| d.id.as_str()).collect();
        serde_json::to_string(&ids).unwrap()
    }

    pub fn dataset_name(&self, id: &str) -> String {
        self.inner.document.datasets.iter()
            .find(|d| d.id == id)
            .map(|d| d.name.clone())
            .unwrap_or_else(|| id.to_string())
    }

    // --- Minimap camera ---

    pub fn camera_theta(&self) -> f64 {
        if let Camera::Arcball(ref v) = self.inner.camera { v.theta } else { 0.5 }
    }

    pub fn camera_phi(&self) -> f64 {
        if let Camera::Arcball(ref v) = self.inner.camera { v.phi } else { 0.8 }
    }

    /// Compute peer cursor geometry for GPU rendering + screen positions for labels.
    ///
    /// Input `peers_json`: array of `{"id": u64, "cursor": [f64,f64]|null, "mode": "slice"|"arcball"|"fly"}`
    /// Returns JSON: `{"gpu": [[f32;8]], "labels": [{"id":u64,"sx":f64,"sy":f64}]}`
    pub fn compute_peer_cursors(&self, peers_json: &str, my_id: u32, screen_w: f64, screen_h: f64) -> String {
        let peers: Vec<crate::cursor::PeerInput> =
            serde_json::from_str(peers_json).unwrap_or_default();
        let output = crate::cursor::compute_peer_cursors(&self.inner, &peers, my_id as u64, screen_w, screen_h);
        serde_json::to_string(&output).unwrap()
    }

    /// Returns 35 floats: invViewProj[16] + eye[3] + viewProj[16]
    pub fn minimap_camera(&self, theta: f64, phi: f64, w: f64, h: f64) -> Vec<f32> {
        let cam = Arcball {
            target: [0.5, 0.5, 0.5],
            theta,
            phi,
            distance: 1.8,
            fov: std::f64::consts::FRAC_PI_4,
            viewport: [w as u32, h as u32],
            near: 0.01,
            far: 100.0,
            clip_distance: 0.0,
            clip_mode: crate::camera::ClipMode::default(),
        };
        let mut out = Vec::with_capacity(35);
        out.extend_from_slice(&cam.inv_view_proj());
        let eye = cam.eye_position();
        out.push(eye[0] as f32);
        out.push(eye[1] as f32);
        out.push(eye[2] as f32);
        out.extend_from_slice(&cam.view_proj());
        out
    }
}
