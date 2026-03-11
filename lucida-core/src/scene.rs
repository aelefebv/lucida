use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::chunk::{self, ChunkRequestPlan};
use crate::transform::{self, VolumeTransform};
use crate::view::ViewState;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BlendMode {
    Alpha,
    Additive,
    Max,
}

impl Default for BlendMode {
    fn default() -> Self {
        BlendMode::Alpha
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerDisplaySettings {
    pub visible: bool,
    pub opacity: f32,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
    pub blend_mode: BlendMode,
}

impl Default for LayerDisplaySettings {
    fn default() -> Self {
        Self {
            visible: true,
            opacity: 1.0,
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
            blend_mode: BlendMode::Alpha,
        }
    }
}

/// Display settings (contrast window + gamma).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayState {
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
}

impl Default for DisplayState {
    fn default() -> Self {
        Self {
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
        }
    }
}

/// Shared document state — datasets and structural data that are synced across all clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentState {
    pub datasets: Vec<Dataset>,
}

impl DocumentState {
    /// Add or replace a dataset by id.
    pub fn add_dataset(&mut self, dataset: Dataset) {
        if let Some(existing) = self.datasets.iter_mut().find(|d| d.id == dataset.id) {
            *existing = dataset;
        } else {
            self.datasets.push(dataset);
        }
    }

    /// Remove a dataset by id.
    pub fn remove_dataset(&mut self, id: &str) {
        self.datasets.retain(|d| d.id != id);
    }
}

/// Per-level shape and chunk size metadata for anisotropic pyramids.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelInfo {
    /// Data shape at this level: [x, y, z].
    pub shape: [u32; 3],
    /// Chunk size at this level: [x, y, z].
    pub chunk_size: [u32; 3],
}

/// A single image layer in the scene.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layer {
    pub name: String,
    pub visible: bool,
    /// Number of multiscale levels available.
    pub num_levels: u32,
    /// Chunk size in pixels: [x, y, z].
    pub chunk_size: [u32; 3],
    /// Full-resolution data shape in voxels: [x, y, z].
    pub data_shape: [u32; 3],
    /// Per-level shape and chunk size. When empty, isotropic 2^level downsampling is assumed.
    #[serde(default)]
    pub level_info: Vec<LevelInfo>,
}

impl Layer {
    /// Returns `(level_shape, level_chunk_size)` for the given level.
    ///
    /// Uses `level_info` when available; falls back to isotropic `data_shape / 2^level`.
    pub fn shape_at_level(&self, level: u32) -> ([u32; 3], [u32; 3]) {
        if let Some(info) = self.level_info.get(level as usize) {
            (info.shape, info.chunk_size)
        } else {
            let scale = 1u32 << level;
            let shape = [
                (self.data_shape[0] + scale - 1) / scale,
                (self.data_shape[1] + scale - 1) / scale,
                (self.data_shape[2] + scale - 1) / scale,
            ];
            (shape, self.chunk_size)
        }
    }
}

/// A single dataset in the scene, containing its layers and spatial metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dataset {
    pub id: String,
    pub name: String,
    pub layers: Vec<Layer>,
    pub volume_transform: Option<VolumeTransform>,
    /// Volume dimensions in voxels: [Z, Y, X].
    pub volume_shape: Option<[u32; 3]>,
    /// Opaque client metadata (dtype, codecs, level paths).
    /// Server passes through without interpretation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_metadata: Option<serde_json::Value>,
}

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
    pub layer_order: Vec<String>,
    #[serde(default)]
    pub layer_settings: HashMap<String, LayerDisplaySettings>,
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
            layer_order: Vec::new(),
            layer_settings: HashMap::new(),
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
        if !matches!(self.camera, Camera::View2D(_)) {
            let vp = self.camera.viewport();
            self.camera = Camera::new_2d(vp);
        }
    }

    /// Switch to 3D mode, preserving the current viewport.
    pub fn set_mode_3d(&mut self) {
        if !matches!(self.camera, Camera::View3D(_)) {
            let vp = self.camera.viewport();
            self.camera = Camera::new_3d(vp);
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
        if !self.layer_order.contains(&id) {
            self.layer_order.push(id.clone());
        }
        self.layer_settings.entry(id).or_insert_with(Default::default);
    }

    /// Remove a dataset by id.
    pub fn remove_dataset(&mut self, id: &str) {
        self.document.remove_dataset(id);
        self.layer_order.retain(|s| s != id);
        self.layer_settings.remove(id);
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

        let mut needed = Vec::new();

        for dataset in &self.document.datasets {
            for layer in &dataset.layers {
                if !layer.visible {
                    continue;
                }
                let level = chunk::select_level(region.effective_zoom, layer.num_levels);
                let (level_shape, level_chunk_size) = layer.shape_at_level(level);
                let chunks = chunk::visible_chunks(
                    &region,
                    &level_chunk_size,
                    level,
                    self.view.t,
                    self.view.c,
                    &level_shape,
                    &layer.data_shape,
                );
                needed.extend(chunks);
            }
        }

        ChunkRequestPlan {
            needed,
            prefetch: Vec::new(),
        }
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

        let mut needed = Vec::new();

        for layer in &dataset.layers {
            if !layer.visible {
                continue;
            }
            let level = chunk::select_level(region.effective_zoom, layer.num_levels);
            let (level_shape, level_chunk_size) = layer.shape_at_level(level);
            let chunks = chunk::visible_chunks(
                &region,
                &level_chunk_size,
                level,
                self.view.t,
                self.view.c,
                &level_shape,
                &layer.data_shape,
            );
            needed.extend(chunks);
        }

        ChunkRequestPlan {
            needed,
            prefetch: Vec::new(),
        }
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
            chunk_size: [256, 256, 64],
            data_shape: [4096, 4096, 256],
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
        assert!(matches!(scene.camera, Camera::View2D(_)));

        scene.set_mode_3d();
        assert!(matches!(scene.camera, Camera::View3D(_)));
        assert_eq!(scene.camera.viewport(), [800, 600]);

        scene.set_mode_2d();
        assert!(matches!(scene.camera, Camera::View2D(_)));
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
        if let Camera::View2D(v) = &parsed.camera {
            assert_eq!(v.viewport, [800, 600]);
        } else {
            panic!("expected View2D");
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
        assert!(matches!(parsed.camera, Camera::View3D(_)));
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
            data_shape: [300, 200, 100],
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
            chunk_size: [256, 256, 64],
            data_shape: [1024, 1024, 128],
            level_info: vec![],
        };
        let (shape, cs) = layer.shape_at_level(0);
        assert_eq!(shape, [1024, 1024, 128]);
        assert_eq!(cs, [256, 256, 64]);

        let (shape, cs) = layer.shape_at_level(1);
        assert_eq!(shape, [512, 512, 64]);
        assert_eq!(cs, [256, 256, 64]);

        let (shape, cs) = layer.shape_at_level(2);
        assert_eq!(shape, [256, 256, 32]);
        assert_eq!(cs, [256, 256, 64]);
    }

    #[test]
    fn shape_at_level_uses_level_info() {
        let layer = Layer {
            name: "test".into(),
            visible: true,
            num_levels: 3,
            chunk_size: [256, 256, 64],
            data_shape: [1024, 1024, 100],
            level_info: vec![
                LevelInfo { shape: [1024, 1024, 100], chunk_size: [256, 256, 64] },
                LevelInfo { shape: [512, 512, 100], chunk_size: [256, 256, 64] },  // Z unchanged
                LevelInfo { shape: [256, 256, 50], chunk_size: [256, 256, 50] },
            ],
        };
        let (shape, cs) = layer.shape_at_level(1);
        assert_eq!(shape, [512, 512, 100]); // Z not downsampled
        assert_eq!(cs, [256, 256, 64]);

        let (shape, cs) = layer.shape_at_level(2);
        assert_eq!(shape, [256, 256, 50]);
        assert_eq!(cs, [256, 256, 50]);
    }

    #[test]
    fn backward_compat_deserialization_without_level_info() {
        // JSON without "level_info" field should deserialize with empty vec
        let json = r#"{
            "name": "test",
            "visible": true,
            "num_levels": 3,
            "chunk_size": [256, 256, 64],
            "data_shape": [1024, 1024, 128]
        }"#;
        let layer: Layer = serde_json::from_str(json).unwrap();
        assert!(layer.level_info.is_empty());
        // Isotropic fallback should still work
        let (shape, _) = layer.shape_at_level(1);
        assert_eq!(shape, [512, 512, 64]);
    }

    #[test]
    fn add_dataset_populates_layer_order_and_settings() {
        let mut scene = Scene::new([800, 600]);
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "first".into(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            client_metadata: None,
        });
        assert_eq!(scene.layer_order, vec!["ds1"]);
        assert!(scene.layer_settings.contains_key("ds1"));
        let settings = &scene.layer_settings["ds1"];
        assert!(settings.visible);
        assert_eq!(settings.opacity, 1.0);
    }

    #[test]
    fn add_dataset_replace_preserves_layer_settings() {
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
        scene.layer_settings.get_mut("ds1").unwrap().opacity = 0.5;
        // Re-add same ID
        scene.add_dataset(Dataset {
            id: "ds1".into(),
            name: "replaced".into(),
            layers: vec![],
            volume_transform: None,
            volume_shape: None,
            client_metadata: None,
        });
        assert_eq!(scene.layer_order, vec!["ds1"]);
        assert_eq!(scene.layer_settings["ds1"].opacity, 0.5);
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
        assert_eq!(scene.layer_order, vec!["ds2"]);
        assert!(!scene.layer_settings.contains_key("ds1"));
        assert!(scene.layer_settings.contains_key("ds2"));
    }

    #[test]
    fn scene_backward_compat_deserialization_without_layer_fields() {
        // JSON without layer_order/layer_settings should deserialize with defaults
        let mut scene = Scene::new([800, 600]);
        scene.add_layer(test_layer());
        // Serialize, then strip layer fields and re-deserialize
        let json = serde_json::to_string(&scene).unwrap();
        let mut val: serde_json::Value = serde_json::from_str(&json).unwrap();
        val.as_object_mut().unwrap().remove("layer_order");
        val.as_object_mut().unwrap().remove("layer_settings");
        let parsed: Scene = serde_json::from_value(val).unwrap();
        assert!(parsed.layer_order.is_empty());
        assert!(parsed.layer_settings.is_empty());
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
