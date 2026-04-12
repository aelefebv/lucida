use wasm_bindgen::prelude::*;

use lucida_content::{DatasetId, LayoutId, LayoutSpec};

use crate::camera::{Camera, Arcball, ClipMode};
use crate::command::Command;
use crate::scene::{DisplayState, DocumentState, DatasetDisplaySettings, Scene};
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
        let mut scene: Scene =
            serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        scene.rebuild_derived();
        self.inner = scene;
        Ok(())
    }

    /// Load only the document portion (content graphs), preserving local camera/view/display.
    pub fn load_document(&mut self, json: &str) -> Result<(), JsError> {
        let doc: DocumentState =
            serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner.document = doc;
        // Rebuild derived state for all content graphs.
        self.inner.rebuild_derived();
        // Ensure dataset_order and dataset_settings are consistent.
        for id in self.inner.document.content_graphs.keys() {
            if !self.inner.dataset_order.contains(id) {
                self.inner.dataset_order.push(id.clone());
            }
            self.inner
                .dataset_settings
                .entry(id.clone())
                .or_insert_with(Default::default);
        }
        // Remove stale entries for datasets no longer in the document.
        let dataset_ids: std::collections::HashSet<&DatasetId> = self
            .inner
            .document
            .content_graphs
            .keys()
            .collect();
        self.inner
            .dataset_order
            .retain(|id| dataset_ids.contains(id));
        self.inner
            .dataset_settings
            .retain(|id, _| dataset_ids.contains(id));
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
                let vol_shape = self.inner.volume_shape();
                let vol_transform = self.inner.volume_transform();
                let region = self.inner.camera.visible_region(
                    &self.inner.view.z_range,
                    vol_transform,
                    vol_shape.as_ref(),
                );
                serde_json::to_string(&region.xy_bounds).unwrap()
            }
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

    /// Debug helper: returns [effective_zoom, zoom_per_voxel] for a dataset.
    pub fn debug_lod_info(&self, dataset_id: &str) -> Vec<f64> {
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = match self.inner.derived.get(&ds_id) {
            Some(d) => d,
            None => return vec![0.0, 0.0],
        };
        let member = match derived.members.first() {
            Some(m) => m,
            None => return vec![0.0, 0.0],
        };
        let level0 = match member.levels.first() {
            Some(l) => l,
            None => return vec![0.0, 0.0],
        };
        let vol_shape = [level0.shape[2] as u32, level0.shape[3] as u32, level0.shape[4] as u32];
        let region = self.inner.camera.visible_region(
            &self.inner.view.z_range,
            Some(&member.volume_transform),
            Some(&vol_shape),
        );
        vec![self.inner.camera.effective_zoom(), region.effective_zoom]
    }

    /// Returns the visible region for a dataset as JSON.
    /// The region is computed using the first member's volume transform and shape,
    /// giving the global viewport bounds before per-member position offsets.
    pub fn visible_region(&self, dataset_id: &str) -> String {
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = match self.inner.derived.get(&ds_id) {
            Some(d) => d,
            None => return "null".to_string(),
        };
        let member = match derived.members.first() {
            Some(m) => m,
            None => return "null".to_string(),
        };
        let level0 = match member.levels.first() {
            Some(l) => l,
            None => return "null".to_string(),
        };
        let vol_shape = [level0.shape[2] as u32, level0.shape[3] as u32, level0.shape[4] as u32];
        let region = self.inner.camera.visible_region(
            &self.inner.view.z_range,
            Some(&member.volume_transform),
            Some(&vol_shape),
        );
        serde_json::to_string(&region).unwrap()
    }

    /// Returns member positions as JSON: `{"entity_id": [x, y], ...}`.
    /// These are the composed layout+transform positions used by chunk planning.
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

    pub fn chunk_plan(&self) -> String {
        let plan = self.inner.chunk_plan();
        serde_json::to_string(&plan).unwrap()
    }

    pub fn chunk_plan_for(&self, dataset_id: &str) -> String {
        let ds_id = DatasetId(dataset_id.to_string());
        let plans = self.inner.chunk_plan_for(&ds_id).unwrap_or_default();
        serde_json::to_string(&plans).unwrap()
    }

    /// Returns the full volume shape [Z, Y, X] for a dataset.
    pub fn dataset_volume_shape(&self, dataset_id: &str) -> Vec<u32> {
        let ds_id = DatasetId(dataset_id.to_string());
        self.inner.derived.get(&ds_id)
            .and_then(|d| d.members.first())
            .and_then(|m| m.levels.first())
            .map(|l| vec![l.shape[2] as u32, l.shape[3] as u32, l.shape[4] as u32])
            .unwrap_or_else(|| vec![1, 1, 1])
    }

    /// Returns the model matrix for a specific member of a dataset,
    /// with the member's position offset baked into the translation.
    pub fn member_model_matrix(&self, dataset_id: &str, member_id: &str) -> Vec<f32> {
        let identity = vec![
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
        ];
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = match self.inner.derived.get(&ds_id) {
            Some(d) => d,
            None => return identity,
        };
        let member = match derived.members.iter().find(|m| m.image_id.0 == member_id || m.entity_id.0 == member_id) {
            Some(m) => m,
            None => return identity,
        };
        let level0 = match member.levels.first() {
            Some(l) => l,
            None => return identity,
        };

        let t = &member.volume_transform;
        let max_phys = if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 };
        let vol_shape = [level0.shape[2] as u32, level0.shape[3] as u32, level0.shape[4] as u32];
        let fov_shape = vol_shape;

        // Recover voxel scale from volume transform
        let scale_x = if fov_shape[2] > 0 { t.model[0] as f64 * max_phys / fov_shape[2] as f64 } else { 1.0 };
        let scale_y = if fov_shape[1] > 0 { t.model[5] as f64 * max_phys / fov_shape[1] as f64 } else { 1.0 };
        let scale_z = if fov_shape[0] > 0 { t.model[10] as f64 * max_phys / fov_shape[0] as f64 } else { 1.0 };

        // Flip Y offset for 3D (Y-up convention)
        let flipped_offset = [member.position[0], vol_shape[1] as f64 - member.position[1] - fov_shape[1] as f64];
        let mt = crate::transform::compute_member_transform(
            fov_shape,
            [scale_z, scale_y, scale_x],
            flipped_offset,
            max_phys,
        );

        // Apply global correction for multi-dataset scenes
        let global_max = self.inner.global_max_physical_extent();
        let correction = (max_phys / global_max) as f32;
        let mut m = mt.model;
        m[0] *= correction;
        m[5] *= correction;
        m[10] *= correction;
        m[12] *= correction;
        m[13] *= correction;
        // Top-align
        let phys_y = t.model[5] as f64 * max_phys;
        let global_max_y = self.inner.global_max_physical_y();
        m[13] += ((global_max_y - phys_y) / global_max) as f32;
        m.to_vec()
    }

    /// Returns the inverse model matrix for a specific member of a dataset.
    pub fn inv_member_model_matrix(&self, dataset_id: &str, member_id: &str) -> Vec<f32> {
        let identity = vec![
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
        ];
        let ds_id = DatasetId(dataset_id.to_string());
        let derived = match self.inner.derived.get(&ds_id) {
            Some(d) => d,
            None => return identity,
        };
        let member = match derived.members.iter().find(|m| m.image_id.0 == member_id || m.entity_id.0 == member_id) {
            Some(m) => m,
            None => return identity,
        };
        let level0 = match member.levels.first() {
            Some(l) => l,
            None => return identity,
        };

        let t = &member.volume_transform;
        let max_phys = if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 };
        let vol_shape = [level0.shape[2] as u32, level0.shape[3] as u32, level0.shape[4] as u32];
        let fov_shape = vol_shape;

        let scale_x = if fov_shape[2] > 0 { t.model[0] as f64 * max_phys / fov_shape[2] as f64 } else { 1.0 };
        let scale_y = if fov_shape[1] > 0 { t.model[5] as f64 * max_phys / fov_shape[1] as f64 } else { 1.0 };
        let scale_z = if fov_shape[0] > 0 { t.model[10] as f64 * max_phys / fov_shape[0] as f64 } else { 1.0 };

        let flipped_offset = [member.position[0], vol_shape[1] as f64 - member.position[1] - fov_shape[1] as f64];
        let mt = crate::transform::compute_member_transform(
            fov_shape,
            [scale_z, scale_y, scale_x],
            flipped_offset,
            max_phys,
        );

        let global_max = self.inner.global_max_physical_extent();
        let inv_correction = (global_max / max_phys) as f32;
        let mut m = mt.inv_model;
        m[0] *= inv_correction;
        m[5] *= inv_correction;
        m[10] *= inv_correction;
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
    pub fn volume_diagonal(&self) -> f64 {
        let first_member = self.inner.derived.values().next()
            .and_then(|d| d.members.first());
        let t = match first_member {
            Some(m) => &m.volume_transform,
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


    // --- Layer display settings ---

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

    pub fn import_dataset_presence(&mut self, json: &str) -> Result<(), JsError> {
        #[derive(serde::Deserialize)]
        struct DatasetPresence {
            dataset_order: Vec<DatasetId>,
            dataset_settings: std::collections::HashMap<DatasetId, DatasetDisplaySettings>,
        }
        let p: DatasetPresence =
            serde_json::from_str(json).map_err(|e| JsError::new(&e.to_string()))?;
        self.inner.dataset_order = p.dataset_order;
        self.inner.dataset_settings = p.dataset_settings;
        Ok(())
    }

    pub fn scene_model_matrix_for(&self, dataset_id: &str) -> Vec<f32> {
        let ds_id = DatasetId(dataset_id.to_string());
        let member = self.inner.derived.get(&ds_id)
            .and_then(|d| d.members.first());
        match member {
            Some(m) => {
                let t = &m.volume_transform;
                let global_max = self.inner.global_max_physical_extent();
                let ds_max = if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 };
                let correction = (ds_max / global_max) as f32;
                let mut mat = t.model;
                mat[0] *= correction;
                mat[5] *= correction;
                mat[10] *= correction;
                // Top-align
                let phys_y = t.model[5] as f64 * ds_max;
                let global_max_y = self.inner.global_max_physical_y();
                mat[13] = ((global_max_y - phys_y) / global_max) as f32;
                mat.to_vec()
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
        let ds_id = DatasetId(dataset_id.to_string());
        let member = self.inner.derived.get(&ds_id)
            .and_then(|d| d.members.first());
        match member {
            Some(m) => {
                let t = &m.volume_transform;
                let global_max = self.inner.global_max_physical_extent();
                let ds_max = if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 };
                let inv_correction = (global_max / ds_max) as f32;
                let mut mat = t.inv_model;
                mat[0] *= inv_correction;
                mat[5] *= inv_correction;
                mat[10] *= inv_correction;
                let phys_y = t.model[5] as f64 * ds_max;
                let global_max_y = self.inner.global_max_physical_y();
                let ty = ((global_max_y - phys_y) / global_max) as f32;
                mat[13] = -ty * mat[5];
                mat.to_vec()
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

    pub fn epochs(&self) -> String {
        serde_json::to_string(&self.inner.epochs).unwrap_or_default()
    }

    pub fn dataset_ids(&self) -> String {
        let ids: Vec<&str> = self.inner.document.content_graphs.keys().map(|id| id.0.as_str()).collect();
        serde_json::to_string(&ids).unwrap()
    }

    pub fn dataset_name(&self, id: &str) -> String {
        let ds_id = DatasetId(id.to_string());
        self.inner.document.content_graphs.get(&ds_id)
            .map(|g| g.name.clone())
            .unwrap_or_else(|| id.to_string())
    }

    // --- Layout management ---

    /// Register a new layout for a dataset. The layout is parsed from JSON.
    pub fn register_layout(&mut self, dataset_id: &str, layout_json: &str) -> Result<(), JsError> {
        let layout: LayoutSpec =
            serde_json::from_str(layout_json).map_err(|e| JsError::new(&e.to_string()))?;
        let cmd = Command::Document(crate::command::DocumentCommand::RegisterLayout {
            dataset_id: DatasetId(dataset_id.to_string()),
            layout,
        });
        self.inner.apply(cmd);
        Ok(())
    }

    /// Set the active layout for a dataset, triggering a derived state rebuild.
    pub fn set_active_layout(&mut self, dataset_id: &str, layout_id: &str) {
        let cmd = Command::Document(crate::command::DocumentCommand::SetActiveLayout {
            dataset_id: DatasetId(dataset_id.to_string()),
            layout_id: LayoutId(layout_id.to_string()),
        });
        self.inner.apply(cmd);
    }

    /// Returns a JSON array of `{id, name}` for all available layouts
    /// (source_layouts + registered_layouts) for a dataset.
    pub fn available_layouts(&self, dataset_id: &str) -> String {
        let ds_id = DatasetId(dataset_id.to_string());

        #[derive(serde::Serialize)]
        struct LayoutInfo {
            id: String,
            name: String,
        }

        let mut layouts = Vec::new();

        // Source layouts from the content graph
        if let Some(content) = self.inner.document.content_graphs.get(&ds_id) {
            for l in content.source_layouts() {
                layouts.push(LayoutInfo {
                    id: l.id.0.clone(),
                    name: l.name.clone(),
                });
            }
        }

        // Registered layouts
        if let Some(registered) = self.inner.document.registered_layouts.get(&ds_id) {
            for l in registered {
                layouts.push(LayoutInfo {
                    id: l.id.0.clone(),
                    name: l.name.clone(),
                });
            }
        }

        serde_json::to_string(&layouts).unwrap()
    }

    // --- Minimap camera ---

    pub fn camera_theta(&self) -> f64 {
        if let Camera::Arcball(ref v) = self.inner.camera { v.theta } else { 0.5 }
    }

    pub fn camera_phi(&self) -> f64 {
        if let Camera::Arcball(ref v) = self.inner.camera { v.phi } else { 0.8 }
    }

    /// Compute peer cursor geometry for GPU rendering + screen positions for labels.
    pub fn compute_peer_cursors(&self, peers_json: &str, my_id: u32, screen_w: f64, screen_h: f64) -> String {
        let peers: Vec<crate::cursor::PeerInput> =
            serde_json::from_str(peers_json).unwrap_or_default();
        let output = crate::cursor::compute_peer_cursors(&self.inner, &peers, my_id as u64, screen_w, screen_h);
        serde_json::to_string(&output).unwrap()
    }

    /// Returns 35 floats: invViewProj[16] + eye[3] + viewProj[16]
    pub fn minimap_camera(&self, theta: f64, phi: f64, w: f64, h: f64) -> Vec<f32> {
        // Compute bounding box of all members to frame the camera
        let (target, distance) = self.minimap_framing();
        let cam = Arcball {
            target,
            theta,
            phi,
            distance,
            fov: std::f64::consts::FRAC_PI_4,
            viewport: [w as u32, h as u32],
            near: 0.01,
            far: (distance * 4.0_f64).max(100.0),
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

    /// Compute minimap camera target and distance from the bounding box
    /// of all member model matrices.
    fn minimap_framing(&self) -> ([f64; 3], f64) {
        let mut min = [f64::MAX, f64::MAX, f64::MAX];
        let mut max = [f64::MIN, f64::MIN, f64::MIN];
        let mut has_any = false;

        for (ds_id, derived) in &self.inner.derived {
            for member in &derived.members {
                let mat = self.member_model_matrix(&ds_id.0, &member.entity_id.0);
                has_any = true;

                // Model matrix is scale+translate (diagonal), so corners are:
                // (0,0,0) → (tx, ty, tz) and (1,1,1) → (sx+tx, sy+ty, sz+tz)
                let sx = mat[0] as f64;
                let sy = mat[5] as f64;
                let sz = mat[10] as f64;
                let tx = mat[12] as f64;
                let ty = mat[13] as f64;
                let tz = mat[14] as f64;

                min[0] = min[0].min(tx);
                min[1] = min[1].min(ty);
                min[2] = min[2].min(tz);
                max[0] = max[0].max(tx + sx);
                max[1] = max[1].max(ty + sy);
                max[2] = max[2].max(tz + sz);
            }
        }

        if !has_any {
            return ([0.5, 0.5, 0.5], 1.8);
        }

        let center = [
            (min[0] + max[0]) / 2.0,
            (min[1] + max[1]) / 2.0,
            (min[2] + max[2]) / 2.0,
        ];
        let extent = (max[0] - min[0]).max(max[1] - min[1]).max(max[2] - min[2]);
        let distance = extent * 1.8;

        (center, distance)
    }
}
