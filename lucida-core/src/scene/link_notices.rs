//! Where a link takes a view past what it shows. A linked view follows the
//! other wherever it goes, so its depth, timepoint or position can land
//! outside its own data, and then it says so instead of looking broken.

use serde::Serialize;

use super::{CutReach, ResolvedLayer, Scene};
use crate::camera::{Camera, Slice};
use crate::scene::LinkProperty;
use crate::view::ViewId;

/// What a link left a view showing none of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LinkNotice {
    /// The linked position leaves every layer the view draws off screen.
    Position,
    /// The linked depth misses every layer the view draws, so it draws
    /// nothing.
    Depth,
    /// The linked timepoint is past every layer's last, so each shows its
    /// last. `last` is the latest of those, from 0.
    Time { last: u32 },
}

/// One view's notices, in the order the link properties come.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ViewLinkNotices {
    pub view: ViewId,
    pub notices: Vec<LinkNotice>,
}

impl Scene {
    /// Where the links take `view` past every layer it draws. Nothing for
    /// the active view, which goes where it is steered, nor while it draws
    /// nothing, since then there is nothing to miss.
    pub(super) fn link_notices(&self, view: ViewId) -> Vec<LinkNotice> {
        if view == self.active {
            return Vec::new();
        }
        let Some(shown) = self.view(view) else {
            return Vec::new();
        };
        let layers: Vec<ResolvedLayer> = self
            .resolved_layers(view)
            .into_iter()
            .filter(|layer| layer.visible)
            .collect();
        if layers.is_empty() {
            return Vec::new();
        }
        let mut notices = Vec::new();
        if let Camera::Slice(slice) = &shown.camera {
            if self.link_applies(LinkProperty::Pan) && !self.frames_any(slice, &layers) {
                notices.push(LinkNotice::Position);
            }
            if self.link_applies(LinkProperty::Z)
                && layers
                    .iter()
                    .all(|layer| layer.reach(slice.plane) == CutReach::Outside)
            {
                notices.push(LinkNotice::Depth);
            }
        }
        if self.link_applies(LinkProperty::T) && layers.iter().all(|layer| layer.t_clamped) {
            let last = layers.iter().map(|layer| layer.t).max().unwrap_or(0);
            notices.push(LinkNotice::Time { last });
        }
        notices
    }

    /// Whether `slice` shows any part of `layers` in its plane.
    fn frames_any(&self, slice: &Slice, layers: &[ResolvedLayer]) -> bool {
        let [min_across, min_down, max_across, max_down] = slice.world_bounds();
        let [across, down, _] = slice.plane.axes();
        layers.iter().any(|layer| {
            let meets = |axis, min: f64, max: f64| {
                self.scene_extent(&layer.dataset_id, axis)
                    .is_some_and(|(lo, hi)| lo < max && min < hi)
            };
            meets(across, min_across, max_across) && meets(down, min_down, max_down)
        })
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::{DatasetId, PhysicalSpace};

    use super::super::test_helpers::make_dataset_opened_with_shape;
    use super::*;
    use crate::command::{Command, DocumentCommand, ViewportCommand};
    use crate::scene::LinkMode;
    use crate::view::{ViewDatasets, ViewLayout};

    /// A micrometer image of `shape` `[t, z, y, x]` one-micrometer samples
    /// with its origin at `origin` `[z, y, x]`.
    fn open(scene: &mut Scene, id: &str, shape: [u64; 4], origin: [f64; 3]) {
        let [t, z, y, x] = shape;
        let mut opened =
            make_dataset_opened_with_shape(id, id, 1, [t, 1, z, y, x], [1, 1, 16, 64, 64], 1);
        let unit = Some("micrometer".to_string());
        opened.manifest = opened.manifest.with_space(PhysicalSpace {
            units: [unit.clone(), unit.clone(), unit],
            origin,
        });
        scene.apply(DocumentCommand::DatasetOpened(opened).into());
    }

    fn apply(scene: &mut Scene, cmd: ViewportCommand) {
        scene.apply(Command::Viewport(cmd));
    }

    /// A over the first 32 planes and four timepoints, B over the next 32
    /// and two, each in its own view, with every property linked.
    fn stacked() -> (Scene, [ViewId; 2]) {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [4, 32, 64, 64], [0.0; 3]);
        open(&mut scene, "b", [2, 32, 64, 64], [32.0, 0.0, 0.0]);
        let layout = ViewLayout::Columns;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let views = [scene.views[0].id(), scene.views[1].id()];
        for (view, id) in views.into_iter().zip(["a", "b"]) {
            let datasets = ViewDatasets::Only(vec![DatasetId::from(id)]);
            apply(
                &mut scene,
                ViewportCommand::SetViewDatasets { view, datasets },
            );
        }
        apply(
            &mut scene,
            ViewportCommand::SetActiveView { view: views[0] },
        );
        for property in LinkProperty::ALL {
            let mode = LinkMode::Linked;
            apply(&mut scene, ViewportCommand::SetViewLink { property, mode });
        }
        (scene, views)
    }

    fn notices(scene: &Scene, view: ViewId) -> Vec<LinkNotice> {
        let links = scene.links().expect("two views");
        let shown = links.notices.into_iter().find(|n| n.view == view);
        shown.expect("a view's notices").notices
    }

    #[test]
    fn a_linked_depth_past_a_views_data_says_so_in_that_view() {
        let (mut scene, [first, second]) = stacked();
        assert_eq!(notices(&scene, second), vec![LinkNotice::Depth]);
        apply(&mut scene, ViewportCommand::SetZ { z: 31 });
        assert_eq!(notices(&scene, second), vec![LinkNotice::Depth]);
        apply(&mut scene, ViewportCommand::SetActiveView { view: second });
        apply(&mut scene, ViewportCommand::SetZ { z: 4 });
        assert!(notices(&scene, second).is_empty());
        assert_eq!(notices(&scene, first), vec![LinkNotice::Depth]);
        let mode = LinkMode::Off;
        let property = LinkProperty::Z;
        apply(&mut scene, ViewportCommand::SetViewLink { property, mode });
        assert!(notices(&scene, first).is_empty());
    }

    #[test]
    fn a_linked_timepoint_past_every_layer_names_the_last() {
        let (mut scene, [_, second]) = stacked();
        apply(&mut scene, ViewportCommand::SetT { t: 3 });
        assert!(notices(&scene, second).contains(&LinkNotice::Time { last: 1 }));
    }

    #[test]
    fn a_linked_position_off_a_views_data_says_so() {
        let (mut scene, [first, second]) = stacked();
        let (x, y) = (5000.0, 5000.0);
        apply(&mut scene, ViewportCommand::SetCenter { x, y });
        assert_eq!(
            notices(&scene, second),
            vec![LinkNotice::Position, LinkNotice::Depth]
        );
        // The view steered off its data went where it was taken.
        assert!(notices(&scene, first).is_empty());
    }
}
