//! Which layers a view draws at a point of its screen, what a mark placed
//! there can land on. Each view shows its own datasets, so the same point
//! of the canvas lands on different data in different views.

use lucida_content::DatasetId;

use crate::camera::Camera;
use crate::view::ViewId;

use super::{CutReach, Scene};

impl Scene {
    /// The layers `view` draws under `at`, fractions of its width and height
    /// from its top left, topmost first: each one it shows that is visible
    /// and not set aside, that a slice view's cut passes through and its
    /// comparison shows on that side, and whose data holds the point, or in
    /// a volume view the ray meets. Empty over no data and for an unknown
    /// view.
    pub fn layers_at(&self, view: ViewId, at: [f64; 2]) -> Vec<DatasetId> {
        let Some(shown) = self.view(view) else {
            return Vec::new();
        };
        let plane = match &shown.camera {
            Camera::Slice(slice) => Some(slice.plane),
            Camera::Arcball(_) | Camera::Fly(_) => None,
        };
        let [width, height] = shown.camera.viewport().map(f64::from);
        let [x, y] = [at[0] * width, at[1] * height];
        let mut layers = self.resolved_layers(view);
        layers.reverse();
        layers
            .into_iter()
            .filter(|layer| layer.visible)
            .filter(|layer| plane.is_none_or(|plane| layer.reach(plane) != CutReach::Outside))
            .filter(|layer| {
                shown
                    .comparison
                    .as_ref()
                    .and_then(|c| c.span(&layer.dataset_id))
                    .is_none_or(|[from, to]| (from..to).contains(&at[0]))
            })
            .filter(|layer| self.ray_pick(view, &layer.dataset_id, x, y).is_some())
            .map(|layer| layer.dataset_id)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::{DatasetId, PhysicalSpace};

    use super::super::test_helpers::make_dataset_opened_with_shape;
    use super::*;
    use crate::command::{Command, DocumentCommand, ViewportCommand};
    use crate::scene::CompareMode;
    use crate::view::ViewLayout;

    /// An image of `[z, y, x]` samples, a micrometer each, at the origin.
    fn open(scene: &mut Scene, id: &str, [z, y, x]: [u64; 3]) {
        let mut opened =
            make_dataset_opened_with_shape(id, id, 1, [1, 1, z, y, x], [1, 1, 16, 64, 64], 1);
        let unit = Some("micrometer".to_string());
        opened.manifest = opened.manifest.with_space(PhysicalSpace {
            units: [unit.clone(), unit.clone(), unit],
            origin: [0.0; 3],
        });
        scene.apply(DocumentCommand::DatasetOpened(opened).into());
    }

    fn apply(scene: &mut Scene, cmd: ViewportCommand) {
        scene.apply(Command::Viewport(cmd));
    }

    fn ids(names: &[&str]) -> Vec<DatasetId> {
        names.iter().copied().map(DatasetId::from).collect()
    }

    /// The middle of a view, and a point beside its data, which a square
    /// fitted to the 800 by 600 viewport leaves bare on either side.
    const MIDDLE: [f64; 2] = [0.5, 0.5];
    const BESIDE: [f64; 2] = [0.05, 0.5];

    #[test]
    fn each_of_two_views_draws_its_own_dataset_under_one_point() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [1, 64, 64]);
        open(&mut scene, "b", [1, 32, 96]);
        let layout = ViewLayout::Columns;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let [first, second] = scene.views().iter().map(|v| v.id()).collect::<Vec<_>>()[..] else {
            panic!("two views");
        };
        let dataset_id = DatasetId::from("b");
        apply(
            &mut scene,
            ViewportCommand::MoveDatasetToView {
                view: second,
                dataset_id,
            },
        );
        apply(&mut scene, ViewportCommand::SetActiveView { view: second });

        // Whichever view is active, each answers for its own.
        assert_eq!(scene.layers_at(first, MIDDLE), ids(&["a"]));
        assert_eq!(scene.layers_at(second, MIDDLE), ids(&["b"]));
    }

    #[test]
    fn layers_that_overlap_come_topmost_first_and_none_beside_them() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [1, 64, 64]);
        open(&mut scene, "b", [1, 64, 64]);
        let view = scene.active_view().id();
        assert_eq!(scene.layers_at(view, MIDDLE), ids(&["b", "a"]));
        assert!(scene.layers_at(view, BESIDE).is_empty());
        assert!(scene.layers_at(ViewId(99), MIDDLE).is_empty());
    }

    #[test]
    fn a_hidden_layer_and_one_the_cut_misses_take_nothing() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "deep", [32, 64, 64]);
        open(&mut scene, "shallow", [8, 64, 64]);
        let view = scene.active_view().id();
        apply(&mut scene, ViewportCommand::SetZ { z: 20 });
        assert_eq!(scene.layers_at(view, MIDDLE), ids(&["deep"]));

        let dataset_id = "deep".to_string();
        let visible = false;
        apply(
            &mut scene,
            ViewportCommand::SetDatasetVisible {
                dataset_id,
                visible,
            },
        );
        assert!(scene.layers_at(view, MIDDLE).is_empty());
    }

    #[test]
    fn a_volume_view_draws_what_its_ray_meets() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [32, 64, 64]);
        apply(&mut scene, ViewportCommand::SetMode3D);
        let view = scene.active_view().id();
        assert_eq!(scene.layers_at(view, MIDDLE), ids(&["a"]));
        assert!(scene.layers_at(view, [0.01, 0.01]).is_empty());
    }

    #[test]
    fn a_swipe_draws_each_of_its_pair_on_its_own_side() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [1, 64, 64]);
        open(&mut scene, "b", [1, 64, 64]);
        let [a, b] = ["a", "b"].map(DatasetId::from);
        scene.compare(a, b, CompareMode::Swipe).unwrap();
        let view = scene.active_view().id();
        assert_eq!(scene.layers_at(view, [0.4, 0.5]), ids(&["a"]));
        assert_eq!(scene.layers_at(view, [0.6, 0.5]), ids(&["b"]));
    }
}
