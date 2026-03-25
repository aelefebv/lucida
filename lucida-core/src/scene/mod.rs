mod types;

pub use types::{
    BlendMode, Dataset, DisplayState, DocumentState, Layer, DatasetDisplaySettings, LevelInfo,
    RenderMode,
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
                layers: Vec::new(),
                volume_transform: None,
                volume_shape: None,
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
    pub fn chunk_plan(&self) -> ChunkRequestPlan {
        let region = self.camera.visible_region(
            &self.view.z_range,
            self.volume_transform(),
            self.volume_shape(),
        );

        let is_2d = matches!(self.camera, Camera::Slice(_));
        let mut needed = Vec::new();
        let mut prefetch = Vec::new();

        for dataset in &self.document.datasets {
            for layer in &dataset.layers {
                if !layer.visible {
                    continue;
                }
                let level = chunk::select_level(region.effective_zoom, layer.num_levels);
                let (level_shape, level_chunk_size) = layer.shape_at_level(level);
                if is_2d {
                    let (n, p) = chunk::visible_and_prefetch_chunks(
                        &region, &level_chunk_size, level,
                        self.view.t, self.view.c,
                        &level_shape, &layer.data_shape,
                    );
                    needed.extend(n);
                    prefetch.extend(p);
                } else {
                    let chunks = chunk::visible_chunks(
                        &region, &level_chunk_size, level,
                        self.view.t, self.view.c,
                        &level_shape, &layer.data_shape,
                    );
                    needed.extend(chunks);
                }
            }
        }

        ChunkRequestPlan { needed, prefetch }
    }

    /// Compute the chunk request plan for a specific dataset by ID.
    pub fn chunk_plan_for(&self, dataset_id: &str) -> ChunkRequestPlan {
        let dataset = match self.dataset_by_id(dataset_id) {
            Some(ds) => ds,
            None => return ChunkRequestPlan { needed: Vec::new(), prefetch: Vec::new() },
        };

        let region = self.camera.visible_region(
            &self.view.z_range,
            dataset.volume_transform.as_ref(),
            dataset.volume_shape.as_ref(),
        );

        let is_2d = matches!(self.camera, Camera::Slice(_));
        let mut needed = Vec::new();
        let mut prefetch = Vec::new();

        for layer in &dataset.layers {
            if !layer.visible {
                continue;
            }
            let level = chunk::select_level(region.effective_zoom, layer.num_levels);
            let (level_shape, level_chunk_size) = layer.shape_at_level(level);
            if is_2d {
                let (n, p) = chunk::visible_and_prefetch_chunks(
                    &region, &level_chunk_size, level,
                    self.view.t, self.view.c,
                    &level_shape, &layer.data_shape,
                );
                needed.extend(n);
                prefetch.extend(p);
            } else {
                let chunks = chunk::visible_chunks(
                    &region, &level_chunk_size, level,
                    self.view.t, self.view.c,
                    &level_shape, &layer.data_shape,
                );
                needed.extend(chunks);
            }
        }

        ChunkRequestPlan { needed, prefetch }
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
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
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
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            client_metadata: None,
        });
        // Modify the opacity
        scene.dataset_settings.get_mut("ds1").unwrap().opacity = 0.5;
        // Re-add same ID
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "replaced".into(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
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
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            client_metadata: None,
        });
        scene.add_dataset(Dataset {
            id: "ds2".into(),
            name: "second".into(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
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
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            client_metadata: None,
        });
        assert_eq!(scene.document.datasets.len(), 1);
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "updated".into(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
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
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            client_metadata: None,
        });
        scene.add_dataset(Dataset {
            id: "ds2".into(),
            name: "second".into(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            client_metadata: None,
        });
        assert_eq!(scene.document.datasets.len(), 2);
        scene.remove_dataset("ds1");
        assert_eq!(scene.document.datasets.len(), 1);
        assert_eq!(scene.document.datasets[0].id, "ds2");
    }
}
