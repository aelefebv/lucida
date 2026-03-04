use crate::camera::Camera;
use crate::chunk::{self, ChunkRequestPlan};
use crate::view::ViewState;

/// A single image layer in the scene.
#[derive(Debug, Clone)]
pub struct Layer {
    pub name: String,
    pub visible: bool,
    /// Number of multiscale levels available.
    pub num_levels: u32,
    /// Chunk size in pixels (assumed square for now).
    pub chunk_size: u32,
}

/// The complete viewer state.
#[derive(Debug)]
pub struct Scene {
    pub camera: Camera,
    pub view: ViewState,
    pub layers: Vec<Layer>,
}

impl Scene {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            camera: Camera::new(viewport),
            view: ViewState::new(),
            layers: Vec::new(),
        }
    }

    pub fn add_layer(&mut self, layer: Layer) {
        self.layers.push(layer);
    }

    /// Compute the chunk request plan for all visible layers.
    pub fn chunk_plan(&self) -> ChunkRequestPlan {
        let mut needed = Vec::new();

        for layer in &self.layers {
            if !layer.visible {
                continue;
            }
            let level = chunk::select_level(self.camera.zoom, layer.num_levels);
            let chunks = chunk::visible_chunks(
                &self.camera,
                layer.chunk_size,
                level,
                self.view.z,
                self.view.t,
                self.view.c,
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
            chunk_size: 256,
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
        scene.view.set_slice("z", 5).unwrap();
        let plan_z5 = scene.chunk_plan();

        assert_eq!(plan_z0.needed[0].z, 0);
        assert_eq!(plan_z5.needed[0].z, 5);
    }
}
