use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::chunk::{self, ChunkRequestPlan};
use crate::transform::{self, VolumeTransform};
use crate::view::ViewState;

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

/// The complete viewer state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub camera: Camera,
    pub view: ViewState,
    pub layers: Vec<Layer>,
    pub volume_transform: Option<VolumeTransform>,
    /// Volume dimensions in voxels: [Z, Y, X]. Needed for 3D frustum → voxel mapping.
    pub volume_shape: Option<[u32; 3]>,
}

impl Scene {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            camera: Camera::new_2d(viewport),
            view: ViewState::new(),
            layers: Vec::new(),
            volume_transform: None,
            volume_shape: None,
        }
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

    /// Set the volume scale to account for anisotropic voxel spacing.
    /// `shape` is [Z, Y, X], `scale` is [Z, Y, X].
    pub fn set_volume_scale(&mut self, shape: [u32; 3], scale: [f64; 3]) {
        self.volume_shape = Some(shape);
        self.volume_transform = Some(transform::compute_volume_transform(shape, scale));
    }

    pub fn add_layer(&mut self, layer: Layer) {
        self.layers.push(layer);
    }

    /// Compute the chunk request plan for all visible layers.
    pub fn chunk_plan(&self) -> ChunkRequestPlan {
        let region = self.camera.visible_region(
            &self.view.z_range,
            self.volume_transform.as_ref(),
            self.volume_shape.as_ref(),
        );

        let mut needed = Vec::new();

        for layer in &self.layers {
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
        assert_eq!(parsed.layers.len(), 1);
        assert_eq!(parsed.layers[0].name, "test");
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
        assert!(parsed.volume_transform.is_some());
        assert_eq!(parsed.volume_shape, Some([100, 200, 300]));
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
        // 3D mode should produce chunks — the frustum sees the volume
        // With a default camera looking at the volume, we should get some chunks
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
}
