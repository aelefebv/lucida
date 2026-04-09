mod types;

pub use types::{
    BlendMode, ChannelSettings, Colormap, Dataset, DatasetDisplaySettings, DatasetKind,
    DatasetMember, DisplayState, DocumentState, Layer, LevelInfo, MemberChunkPlan, PlateFov,
    PlateWell, PositioningMode, RenderMode,
};

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::chunk::{self, ChunkRequestPlan};
use crate::transform::{self, VolumeTransform};
use crate::view::ViewState;

/// The complete viewer state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub camera: Camera,
    pub view: ViewState,
    /// Shared document state (datasets).
    pub document: DocumentState,
    /// Display settings (contrast window + gamma). Per-client, not part of shared document.
    #[serde(default)]
    pub display: DisplayState,
    #[serde(default)]
    pub dataset_order: Vec<String>,
    #[serde(default)]
    pub dataset_settings: HashMap<String, DatasetDisplaySettings>,
}

impl Scene {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            camera: Camera::new_2d(viewport),
            view: ViewState::new(),
            document: DocumentState {
                datasets: Vec::new(),
            },
            display: DisplayState::default(),
            dataset_order: Vec::new(),
            dataset_settings: HashMap::new(),
        }
    }

    // --- Convenience accessors for first dataset ---

    pub fn volume_transform(&self) -> Option<&VolumeTransform> {
        self.document
            .datasets
            .first()
            .and_then(|d| d.volume_transform.as_ref())
    }

    pub fn volume_shape(&self) -> Option<&[u32; 3]> {
        self.document
            .datasets
            .first()
            .and_then(|d| d.volume_shape.as_ref())
    }

    /// Switch to 2D mode, preserving the current viewport.
    pub fn set_mode_2d(&mut self) {
        if !matches!(self.camera, Camera::Slice(_)) {
            let vp = self.camera.viewport();
            self.camera = Camera::new_2d(vp);
        }
    }

    /// Switch to 3D arcball mode, preserving the current viewport.
    /// If currently in fly mode, converts to arcball preserving eye position and view direction.
    pub fn set_mode_3d(&mut self) {
        if !matches!(self.camera, Camera::Arcball(_)) {
            match &self.camera {
                Camera::Fly(v) => {
                    self.camera = Camera::Arcball(v.to_arcball());
                }
                _ => {
                    let vp = self.camera.viewport();
                    self.camera = Camera::new_3d(vp);
                }
            }
        }
    }

    /// Switch to fly mode, converting from arcball if possible.
    pub fn set_mode_fly(&mut self) {
        if !matches!(self.camera, Camera::Fly(_)) {
            match &self.camera {
                Camera::Arcball(v) => {
                    self.camera = Camera::Fly(v.to_fly());
                }
                _ => {
                    let vp = self.camera.viewport();
                    self.camera = Camera::Fly(crate::camera::Fly::new(vp));
                }
            }
        }
    }

    /// Ensure at least one dataset exists, creating a default if needed.
    fn ensure_default_dataset(&mut self) {
        if self.document.datasets.is_empty() {
            self.document.datasets.push(Dataset {
                id: "default".into(),
                name: "default".into(),
                kind: DatasetKind::default(),
                layers: Vec::new(),
                volume_transform: None,
                volume_shape: None,
                members: Vec::new(),
                client_metadata: None,
            });
        }
    }

    /// Set the volume scale for the first dataset.
    /// `shape` is [Z, Y, X], `scale` is [Z, Y, X].
    pub fn set_volume_scale(&mut self, shape: [u32; 3], scale: [f64; 3]) {
        self.ensure_default_dataset();
        let ds = &mut self.document.datasets[0];
        ds.volume_shape = Some(shape);
        ds.volume_transform = Some(transform::compute_volume_transform(shape, scale));
    }

    /// Add a layer to the first dataset (convenience for single-dataset use).
    pub fn add_layer(&mut self, layer: Layer) {
        self.ensure_default_dataset();
        self.document.datasets[0].layers.push(layer);
    }

    /// Add or replace a dataset by id.
    pub fn add_dataset(&mut self, dataset: Dataset) {
        let id = dataset.id.clone();
        self.document.add_dataset(dataset);
        if !self.dataset_order.contains(&id) {
            self.dataset_order.push(id.clone());
        }
        self.dataset_settings.entry(id).or_insert_with(Default::default);
    }

    /// Remove a dataset by id.
    pub fn remove_dataset(&mut self, id: &str) {
        self.document.remove_dataset(id);
        self.dataset_order.retain(|s| s != id);
        self.dataset_settings.remove(id);
    }

    pub fn dataset_by_id(&self, id: &str) -> Option<&Dataset> {
        self.document.datasets.iter().find(|d| d.id == id)
    }

    /// Returns the maximum `max_physical_extent` across all datasets.
    /// Used to apply a global normalization correction so multi-dataset
    /// scenes preserve relative physical sizes in 3D.
    pub fn global_max_physical_extent(&self) -> f64 {
        let max = self.document.datasets.iter()
            .filter_map(|d| d.volume_transform.as_ref())
            .map(|t| if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 })
            .fold(0.0_f64, f64::max);
        if max > 0.0 { max } else { 1.0 }
    }

    /// Returns the maximum physical Y extent across all datasets.
    /// Used to top-align datasets in 3D mode.
    pub fn global_max_physical_y(&self) -> f64 {
        let max = self.document.datasets.iter()
            .filter_map(|d| d.volume_transform.as_ref())
            .map(|t| {
                let ds_max = if t.max_physical_extent > 0.0 { t.max_physical_extent } else { 1.0 };
                t.model[5] as f64 * ds_max // phys_y = base_sy * max_physical_extent
            })
            .fold(0.0_f64, f64::max);
        if max > 0.0 { max } else { 1.0 }
    }

    /// Compute the chunk request plan for all visible layers across all datasets.
    /// Returns a flat `ChunkRequestPlan` (union of all members of the first dataset).
    pub fn chunk_plan(&self) -> ChunkRequestPlan {
        let ds_id = match self.document.datasets.first() {
            Some(d) => d.id.clone(),
            None => return ChunkRequestPlan { needed: Vec::new(), prefetch: Vec::new() },
        };
        let members = self.chunk_plan_for(&ds_id);
        // Flatten all members into a single ChunkRequestPlan for backward compat.
        let mut needed = Vec::new();
        let mut prefetch = Vec::new();
        for m in members {
            needed.extend(m.needed);
            prefetch.extend(m.prefetch);
        }
        ChunkRequestPlan { needed, prefetch }
    }

    /// Compute the chunk request plan for a specific dataset by ID.
    ///
    /// Returns one `MemberChunkPlan` per visible member. For the common
    /// single-member-at-origin case this is a single element whose
    /// `needed`/`prefetch` lists are identical to the old flat plan.
    ///
    /// For multi-member datasets (plates), each member's AABB is checked
    /// against the visible region, and chunk planning is done in
    /// member-local coordinates.
    pub fn chunk_plan_for(&self, dataset_id: &str) -> Vec<MemberChunkPlan> {
        let dataset = match self.dataset_by_id(dataset_id) {
            Some(ds) => ds,
            None => return Vec::new(),
        };

        let region = self.camera.visible_region(
            &self.view.z_range,
            dataset.volume_transform.as_ref(),
            dataset.volume_shape.as_ref(),
        );

        let is_2d = matches!(self.camera, Camera::Slice(_));
        let members = dataset.effective_members();

        // For plates, use the FOV shape (not the full plate extent) for
        // per-member AABB visibility tests.
        let fov_shape = dataset.layers.first()
            .map(|l| l.data_shape)
            .unwrap_or(dataset.volume_shape.unwrap_or([1, 1, 1]));

        let mut plans = Vec::with_capacity(members.len());

        for member in &members {
            // Check member AABB against visible region.
            // Each member occupies one FOV's worth of voxels, not the full plate.
            let pos_x = member.position[0];
            let pos_y = member.position[1];
            let member_max_x = pos_x + fov_shape[2] as f64;
            let member_max_y = pos_y + fov_shape[1] as f64;

            let [vis_min_x, vis_min_y, vis_max_x, vis_max_y] = region.xy_bounds;

            // AABB overlap test
            if member_max_x <= vis_min_x
                || pos_x >= vis_max_x
                || member_max_y <= vis_min_y
                || pos_y >= vis_max_y
            {
                continue; // member is fully outside the visible region
            }

            // Compute a member-local region by offsetting the visible bounds
            // by -position, so the chunk planner works in local coordinates.
            let local_region = crate::camera::VisibleRegion {
                xy_bounds: [
                    vis_min_x - pos_x,
                    vis_min_y - pos_y,
                    vis_max_x - pos_x,
                    vis_max_y - pos_y,
                ],
                z_range: region.z_range.clone(),
                effective_zoom: region.effective_zoom,
                sort_center: region.sort_center.map(|[cx, cy, cz]| [cx - pos_x, cy - pos_y, cz]),
                frustum_planes: region.frustum_planes.map(|planes| {
                    planes.map(|[a, b, c, d]| [a, b, c, d + a * pos_x + b * pos_y])
                }),
            };

            let mut needed = Vec::new();
            let mut prefetch = Vec::new();

            for layer in &dataset.layers {
                if !layer.visible {
                    continue;
                }
                let level = chunk::select_level(local_region.effective_zoom, layer.num_levels);
                let (level_shape, level_chunk_size) = layer.shape_at_level(level);
                if is_2d {
                    let (n, p) = chunk::visible_and_prefetch_chunks(
                        &local_region, &level_chunk_size, level,
                        self.view.t, self.view.c,
                        &level_shape, &layer.data_shape,
                    );
                    needed.extend(n);
                    prefetch.extend(p);
                } else {
                    let chunks = chunk::visible_chunks(
                        &local_region, &level_chunk_size, level,
                        self.view.t, self.view.c,
                        &level_shape, &layer.data_shape,
                    );
                    needed.extend(chunks);
                }
            }

            plans.push(MemberChunkPlan {
                member_id: member.id.clone(),
                position: member.position,
                store_prefix: member.store_prefix.clone(),
                needed,
                prefetch,
            });
        }

        plans
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_layer() -> Layer {
        Layer {
            name: "test".into(),
            visible: true,
            num_levels: 5,
            chunk_size: [64, 256, 256],
            data_shape: [256, 4096, 4096],
            level_info: vec![],
        }
    }

    #[test]
    fn empty_scene_produces_empty_plan() {
        let scene = Scene::new([800, 600]);
        let plan = scene.chunk_plan();
        assert!(plan.needed.is_empty());
    }

    #[test]
    fn hidden_layers_are_excluded() {
        let mut scene = Scene::new([800, 600]);
        let mut layer = test_layer();
        layer.visible = false;
        scene.add_layer(layer);
        let plan = scene.chunk_plan();
        assert!(plan.needed.is_empty());
    }

    #[test]
    fn visible_layer_produces_chunks() {
        let mut scene = Scene::new([512, 512]);
        scene.add_layer(test_layer());
        let plan = scene.chunk_plan();
        assert!(!plan.needed.is_empty());
    }

    #[test]
    fn changing_slice_updates_chunk_coords() {
        let mut scene = Scene::new([512, 512]);
        scene.add_layer(test_layer());

        let plan_z0 = scene.chunk_plan();
        scene.view.set_slice("z", 100).unwrap();
        let plan_z100 = scene.chunk_plan();

        assert_eq!(plan_z0.needed[0].z, 0);
        assert_eq!(plan_z100.needed[0].z, 1);
    }

    #[test]
    fn z_slab_produces_chunks_across_z() {
        let mut scene = Scene::new([512, 512]);
        scene.add_layer(test_layer());
        scene.view.set_z_range(0..128);
        let plan = scene.chunk_plan();
        let z_values: Vec<u32> = plan.needed.iter().map(|c| c.z).collect();
        assert!(z_values.contains(&0));
        assert!(z_values.contains(&1));
    }

    #[test]
    fn mode_switching_preserves_viewport() {
        let mut scene = Scene::new([800, 600]);
        assert!(matches!(scene.camera, Camera::Slice(_)));

        scene.set_mode_3d();
        assert!(matches!(scene.camera, Camera::Arcball(_)));
        assert_eq!(scene.camera.viewport(), [800, 600]);

        scene.set_mode_2d();
        assert!(matches!(scene.camera, Camera::Slice(_)));
        assert_eq!(scene.camera.viewport(), [800, 600]);
    }

    #[test]
    fn scene_2d_serialization_round_trip() {
        let mut scene = Scene::new([800, 600]);
        scene.view.set_z(5);
        scene.view.t = 2;
        scene.view.c = 1;
        scene.add_layer(test_layer());
        let json = serde_json::to_string(&scene).unwrap();
        let parsed: Scene = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.view.z_range, 5..6);
        assert_eq!(parsed.view.t, 2);
        assert_eq!(parsed.view.c, 1);
        assert_eq!(parsed.document.datasets.len(), 1);
        assert_eq!(parsed.document.datasets[0].layers.len(), 1);
        assert_eq!(parsed.document.datasets[0].layers[0].name, "test");
        if let Camera::Slice(v) = &parsed.camera {
            assert_eq!(v.viewport, [800, 600]);
        } else {
            panic!("expected Slice");
        }
    }

    #[test]
    fn scene_3d_serialization_round_trip() {
        let mut scene = Scene::new([800, 600]);
        scene.set_mode_3d();
        scene.set_volume_scale([100, 200, 300], [1.0, 1.0, 1.0]);
        scene.add_layer(test_layer());
        let json = serde_json::to_string(&scene).unwrap();
        let parsed: Scene = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed.camera, Camera::Arcball(_)));
        assert!(parsed.volume_transform().is_some());
        assert_eq!(parsed.volume_shape().copied(), Some([100, 200, 300]));
    }

    #[test]
    fn chunk_plan_3d_produces_chunks_spanning_z() {
        let mut scene = Scene::new([800, 600]);
        scene.set_mode_3d();
        scene.set_volume_scale([100, 200, 300], [1.0, 1.0, 1.0]);
        scene.add_layer(Layer {
            name: "vol".into(),
            visible: true,
            num_levels: 1,
            chunk_size: [64, 64, 64],
            data_shape: [100, 200, 300],
            level_info: vec![],
        });
        let plan = scene.chunk_plan();
        assert!(!plan.needed.is_empty());
    }

    #[test]
    fn shape_at_level_isotropic_fallback() {
        let layer = Layer {
            name: "test".into(),
            visible: true,
            num_levels: 3,
            chunk_size: [64, 256, 256],
            data_shape: [128, 1024, 1024],
            level_info: vec![],
        };
        let (shape, cs) = layer.shape_at_level(0);
        assert_eq!(shape, [128, 1024, 1024]);
        assert_eq!(cs, [64, 256, 256]);

        let (shape, cs) = layer.shape_at_level(1);
        assert_eq!(shape, [64, 512, 512]);
        assert_eq!(cs, [64, 256, 256]);

        let (shape, cs) = layer.shape_at_level(2);
        assert_eq!(shape, [32, 256, 256]);
        assert_eq!(cs, [64, 256, 256]);
    }

    #[test]
    fn shape_at_level_uses_level_info() {
        let layer = Layer {
            name: "test".into(),
            visible: true,
            num_levels: 3,
            chunk_size: [64, 256, 256],
            data_shape: [100, 1024, 1024],
            level_info: vec![
                LevelInfo { shape: [100, 1024, 1024], chunk_size: [64, 256, 256] },
                LevelInfo { shape: [100, 512, 512], chunk_size: [64, 256, 256] },  // Z unchanged
                LevelInfo { shape: [50, 256, 256], chunk_size: [50, 256, 256] },
            ],
        };
        let (shape, cs) = layer.shape_at_level(1);
        assert_eq!(shape, [100, 512, 512]); // Z not downsampled
        assert_eq!(cs, [64, 256, 256]);

        let (shape, cs) = layer.shape_at_level(2);
        assert_eq!(shape, [50, 256, 256]);
        assert_eq!(cs, [50, 256, 256]);
    }

    #[test]
    fn backward_compat_deserialization_without_level_info() {
        // JSON without "level_info" field should deserialize with empty vec
        // [Z, Y, X] ordering
        let json = r#"{
            "name": "test",
            "visible": true,
            "num_levels": 3,
            "chunk_size": [64, 256, 256],
            "data_shape": [128, 1024, 1024]
        }"#;
        let layer: Layer = serde_json::from_str(json).unwrap();
        assert!(layer.level_info.is_empty());
        // Isotropic fallback should still work
        let (shape, _) = layer.shape_at_level(1);
        assert_eq!(shape, [64, 512, 512]);
    }

    #[test]
    fn add_dataset_populates_dataset_order_and_settings() {
        let mut scene = Scene::new([800, 600]);
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "first".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            members: Vec::new(),
            client_metadata: None,
        });
        assert_eq!(scene.dataset_order, vec!["ds1"]);
        assert!(scene.dataset_settings.contains_key("ds1"));
        let settings = &scene.dataset_settings["ds1"];
        assert!(settings.visible);
        assert_eq!(settings.opacity, 1.0);
    }

    #[test]
    fn add_dataset_replace_preserves_dataset_settings() {
        let mut scene = Scene::new([800, 600]);
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "first".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            members: Vec::new(),
            client_metadata: None,
        });
        // Modify the opacity
        scene.dataset_settings.get_mut("ds1").unwrap().opacity = 0.5;
        // Re-add same ID
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "replaced".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            members: Vec::new(),
            client_metadata: None,
        });
        assert_eq!(scene.dataset_order, vec!["ds1"]);
        assert_eq!(scene.dataset_settings["ds1"].opacity, 0.5);
    }

    #[test]
    fn remove_dataset_cleans_up_layer_state() {
        let mut scene = Scene::new([800, 600]);
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "first".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            members: Vec::new(),
            client_metadata: None,
        });
        scene.add_dataset(Dataset {
            id: "ds2".into(),
            name: "second".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            members: Vec::new(),
            client_metadata: None,
        });
        scene.remove_dataset("ds1");
        assert_eq!(scene.dataset_order, vec!["ds2"]);
        assert!(!scene.dataset_settings.contains_key("ds1"));
        assert!(scene.dataset_settings.contains_key("ds2"));
    }

    #[test]
    fn scene_backward_compat_deserialization_without_layer_fields() {
        // JSON without dataset_order/dataset_settings should deserialize with defaults
        let mut scene = Scene::new([800, 600]);
        scene.add_layer(test_layer());
        // Serialize, then strip layer fields and re-deserialize
        let json = serde_json::to_string(&scene).unwrap();
        let mut val: serde_json::Value = serde_json::from_str(&json).unwrap();
        val.as_object_mut().unwrap().remove("dataset_order");
        val.as_object_mut().unwrap().remove("dataset_settings");
        let parsed: Scene = serde_json::from_value(val).unwrap();
        assert!(parsed.dataset_order.is_empty());
        assert!(parsed.dataset_settings.is_empty());
    }

    #[test]
    fn add_dataset_deduplicates_by_id() {
        let mut scene = Scene::new([800, 600]);
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "first".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            members: Vec::new(),
            client_metadata: None,
        });
        assert_eq!(scene.document.datasets.len(), 1);
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "updated".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            members: Vec::new(),
            client_metadata: None,
        });
        assert_eq!(scene.document.datasets.len(), 1);
        assert_eq!(scene.document.datasets[0].name, "updated");
    }

    #[test]
    fn remove_dataset_by_id() {
        let mut scene = Scene::new([800, 600]);
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "first".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            members: Vec::new(),
            client_metadata: None,
        });
        scene.add_dataset(Dataset {
            id: "ds2".into(),
            name: "second".into(),
            kind: DatasetKind::default(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            members: Vec::new(),
            client_metadata: None,
        });
        assert_eq!(scene.document.datasets.len(), 2);
        scene.remove_dataset("ds1");
        assert_eq!(scene.document.datasets.len(), 1);
        assert_eq!(scene.document.datasets[0].id, "ds2");
    }

    #[test]
    fn chunk_plan_for_returns_member_plans() {
        let mut scene = Scene::new([512, 512]);
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers: vec![test_layer()],
            volume_transform: None,
            volume_shape: Some([256, 4096, 4096]),
            members: Vec::new(), // backward compat: synthesize single member
            client_metadata: None,
        });
        let plans = scene.chunk_plan_for("ds1");
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].member_id, "ds1");
        assert_eq!(plans[0].position, [0.0, 0.0]);
        assert!(plans[0].store_prefix.is_none());
        assert!(!plans[0].needed.is_empty());
    }

    #[test]
    fn chunk_plan_for_single_member_matches_flat_plan() {
        // Verify that a single member at [0, 0] produces identical results
        // to the old flat chunk_plan() method.
        let mut scene = Scene::new([512, 512]);
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "test".into(),
            kind: DatasetKind::default(),
            layers: vec![test_layer()],
            volume_transform: None,
            volume_shape: Some([256, 4096, 4096]),
            members: Vec::new(),
            client_metadata: None,
        });
        let flat = scene.chunk_plan();
        let member_plans = scene.chunk_plan_for("ds1");
        assert_eq!(member_plans.len(), 1);
        assert_eq!(flat.needed.len(), member_plans[0].needed.len());
        assert_eq!(flat.prefetch.len(), member_plans[0].prefetch.len());
        for (a, b) in flat.needed.iter().zip(member_plans[0].needed.iter()) {
            assert_eq!(a.key(), b.key());
        }
    }

    #[test]
    fn chunk_plan_for_missing_dataset_returns_empty() {
        let scene = Scene::new([512, 512]);
        let plans = scene.chunk_plan_for("nonexistent");
        assert!(plans.is_empty());
    }

    #[test]
    fn multi_member_aabb_culling() {
        // Two members side-by-side, each 256x256 in XY. Camera at origin
        // should see member at [0,0] but not the one at [10000, 0].
        let mut scene = Scene::new([512, 512]);
        let layer = Layer {
            name: "img".into(),
            visible: true,
            num_levels: 1,
            chunk_size: [1, 256, 256],
            data_shape: [1, 256, 256],
            level_info: vec![],
        };
        scene.add_dataset(Dataset {
            id: "plate".into(),
            name: "plate".into(),
            kind: DatasetKind::default(),
            layers: vec![layer],
            volume_transform: None,
            volume_shape: Some([1, 256, 256]),
            members: vec![
                DatasetMember {
                    id: "m1".into(),
                    position: [0.0, 0.0],
                    store_prefix: Some("A/1/0".into()),
                },
                DatasetMember {
                    id: "m2".into(),
                    position: [10000.0, 0.0],
                    store_prefix: Some("A/2/0".into()),
                },
            ],
            client_metadata: None,
        });
        let plans = scene.chunk_plan_for("plate");
        // Only the member at origin should be visible
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].member_id, "m1");
        assert_eq!(plans[0].store_prefix.as_deref(), Some("A/1/0"));
        assert!(!plans[0].needed.is_empty());
    }

    #[test]
    fn multi_member_both_visible_when_overlapping_view() {
        // Two adjacent members within the viewport.
        let mut scene = Scene::new([1024, 512]);
        let layer = Layer {
            name: "img".into(),
            visible: true,
            num_levels: 1,
            chunk_size: [1, 256, 256],
            data_shape: [1, 256, 256],
            level_info: vec![],
        };
        // Pan camera to see both members
        if let Camera::Slice(ref mut v) = scene.camera {
            v.center = [256.0, 128.0];
        }
        scene.add_dataset(Dataset {
            id: "plate".into(),
            name: "plate".into(),
            kind: DatasetKind::default(),
            layers: vec![layer],
            volume_transform: None,
            volume_shape: Some([1, 256, 256]),
            members: vec![
                DatasetMember {
                    id: "m1".into(),
                    position: [0.0, 0.0],
                    store_prefix: Some("A/1/0".into()),
                },
                DatasetMember {
                    id: "m2".into(),
                    position: [256.0, 0.0],
                    store_prefix: Some("A/2/0".into()),
                },
            ],
            client_metadata: None,
        });
        let plans = scene.chunk_plan_for("plate");
        let ids: Vec<&str> = plans.iter().map(|p| p.member_id.as_str()).collect();
        assert!(ids.contains(&"m1"), "m1 should be visible");
        assert!(ids.contains(&"m2"), "m2 should be visible");
    }

    #[test]
    fn frustum_culling_offset_member_3d() {
        // Two plate members side by side, viewed with an Arcball camera zoomed
        // into the SECOND member. m2 is at voxel position [256, 0] — a full
        // well-width away. This exercises two fixes:
        //   1. visible_region xy_bounds must NOT be clamped to [0, shape],
        //      otherwise the AABB test rejects m2 (pos_x=256 >= shape_x=256).
        //   2. frustum planes must be offset by [pos_x, pos_y] so the
        //      per-chunk culling operates in member-local coordinates.
        let shape: [u32; 3] = [64, 256, 256];
        let scale: [f64; 3] = [1.0, 1.0, 1.0];
        let vt = crate::transform::compute_volume_transform(shape, scale);

        let layer = Layer {
            name: "img".into(),
            visible: true,
            num_levels: 1,
            chunk_size: [64, 256, 256],
            data_shape: shape,
            level_info: vec![],
        };

        let mut scene = Scene::new([800, 600]);
        // Camera aimed at m2's center in world space.
        // m2 occupies world X [1.0, 2.0] (since shape_x=256, sx=1.0, offset=256/256=1.0).
        // Center of m2 is at world [1.5, 0.5, 0.125].
        scene.camera = Camera::new_3d([800, 600]);
        if let Camera::Arcball(ref mut arc) = scene.camera {
            arc.target = [1.5, 0.5, 0.125];
            arc.distance = 1.0;
            arc.phi = std::f64::consts::FRAC_PI_2;
            arc.theta = 0.0;
        }

        scene.add_dataset(Dataset {
            id: "plate".into(),
            name: "plate".into(),
            kind: DatasetKind::default(),
            layers: vec![layer],
            volume_transform: Some(vt),
            volume_shape: Some(shape),
            members: vec![
                DatasetMember {
                    id: "m1".into(),
                    position: [0.0, 0.0],
                    store_prefix: Some("A/1/0".into()),
                },
                DatasetMember {
                    id: "m2".into(),
                    position: [256.0, 0.0],
                    store_prefix: Some("A/2/0".into()),
                },
            ],
            client_metadata: None,
        });

        scene.view.z_range = 0..64;
        let plans = scene.chunk_plan_for("plate");
        let m2_plan = plans.iter().find(|p| p.member_id == "m2");
        assert!(m2_plan.is_some(), "m2 should pass AABB (visible_region not clamped to shape)");
        assert!(
            !m2_plan.unwrap().needed.is_empty(),
            "m2 should have non-empty needed list (frustum planes offset correctly)",
        );
    }
}
