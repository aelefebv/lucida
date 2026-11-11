//! The cursor crosshair: the point under the pointer in one view, marked
//! where it lands in each other view that looks at the same place. Four-up's
//! views share one scene frame, and two views a link joins carry the point
//! through the link's basis. A view whose data doesn't hold the point says
//! so, rather than marking a place where it draws nothing.

use lucida_content::{DatasetId, SpatialAxis};
use serde::Serialize;

use super::Scene;
use super::placement::frame_box;
use crate::camera::Camera;
use crate::placement::Affine;
use crate::view::{ViewId, ViewLayout};

/// How far past its box a point still counts as in a member, as a share of
/// the box: a point picked on a volume's face comes back through the scene
/// frame a rounding error off it.
const HOLD_SLACK: f64 = 1e-9;

/// How long a step along each axis measures the axes' screen directions, in
/// world units, where the scene spans about one: short enough that a
/// perspective camera bends nothing across it.
const ARM_STEP_WORLD: f64 = 1e-3;

/// What one view shows of the point under the pointer in another.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CrosshairMark {
    /// The point lies in data the view draws, here on its screen.
    At {
        /// As fractions of the view's width and height from its top left.
        at: [f64; 2],
        /// Which way the scene frame's X, Y and Z run on the screen at the
        /// point, in device pixels scaled so the longest is 1. An axis the
        /// view looks straight along has none.
        arms: [[f64; 2]; 3],
        /// The point in world space, in a volume view: its readout reads
        /// the samples there, where the mark is, rather than the first along
        /// the ray, which may lie in front of it.
        #[serde(skip_serializing_if = "Option::is_none")]
        world: Option<[f64; 3]>,
    },
    /// No data the view draws holds the point.
    Outside,
}

/// One view's mark of the point under the pointer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ViewCrosshair {
    pub view: ViewId,
    #[serde(flatten)]
    pub mark: CrosshairMark,
}

impl Scene {
    /// Where the point under `at` in `hovered`, as fractions of its width
    /// and height, lands in each other view on the canvas that looks at the
    /// same place: every view of a four-up layout, and the other of two views
    /// a link of where they look joins. A view that holds the point off its
    /// screen or behind its camera gets no mark. Empty where `hovered` has no
    /// point under `at`: a volume view's ray that meets no data.
    pub fn crosshairs(&self, hovered: ViewId, at: [f64; 2]) -> Vec<ViewCrosshair> {
        let Some(point) = self.point_under(hovered, at) else {
            return Vec::new();
        };
        self.shown_views()
            .map(|view| view.id())
            .filter(|view| *view != hovered)
            .filter_map(|view| {
                let point = self.crosshair_map(hovered, view)?.apply(point);
                let mark = if self.holds_point(view, point) {
                    self.mark_at(view, point)?
                } else {
                    CrosshairMark::Outside
                };
                Some(ViewCrosshair { view, mark })
            })
            .collect()
    }

    /// The point of the scene frame under `at` in `view`: on a slice view's
    /// plane, at the place it cuts; in a volume view, where the ray first
    /// meets data the view draws.
    fn point_under(&self, view: ViewId, at: [f64; 2]) -> Option<[f64; 3]> {
        let shown = self.view(view)?;
        let [width, height] = shown.camera.viewport().map(f64::from);
        let [sx, sy] = [at[0] * width, at[1] * height];
        match &shown.camera {
            Camera::Slice(slice) => {
                let [across, down, cut] = slice.plane.axes().map(SpatialAxis::xyz);
                let on_plane = slice.from_screen([sx, sy]);
                let mut point = [0.0; 3];
                point[across] = on_plane[0];
                point[down] = on_plane[1];
                point[cut] = self.cut_place(view, slice.plane.cut());
                Some(point)
            }
            Camera::Arcball(_) | Camera::Fly(_) => {
                let hit = self
                    .drawn_layers(view)
                    .filter_map(|id| self.ray_pick(view, id, sx, sy))
                    .min_by(|a, b| a.distance.total_cmp(&b.distance))?;
                let to_scene = self.world_space().from_scene().inverse();
                Some(to_scene.apply(hit.world_position))
            }
        }
    }

    /// The map from where `from` looks into where `to` does, for two views
    /// that look at the same place.
    fn crosshair_map(&self, from: ViewId, to: ViewId) -> Option<Affine> {
        if self.layout == ViewLayout::FourUp {
            return Some(Affine::IDENTITY);
        }
        self.linked_place_map(from, to)
    }

    /// The visible layers `view` draws.
    fn drawn_layers(&self, view: ViewId) -> impl Iterator<Item = &DatasetId> {
        self.layer_ids().filter(move |id| {
            self.draws(view, id) && self.dataset_settings.get(*id).is_none_or(|s| s.visible)
        })
    }

    /// Whether data `view` draws holds `point`. Read back into each member's
    /// own box, so a turned dataset, or the gaps between a collection's
    /// tiles, count as they are drawn.
    fn holds_point(&self, view: ViewId, point: [f64; 3]) -> bool {
        self.drawn_layers(view).any(|id| {
            let (Some(to_scene), Some(derived)) = (self.placement(id), self.derived.get(id)) else {
                return false;
            };
            let in_frame = to_scene.inverse().apply(point);
            let mut members = derived.members.iter().filter_map(frame_box);
            members.any(|member| box_holds(member, in_frame))
        })
    }

    /// Where `point` falls on `view`'s screen, and which way the scene
    /// frame's axes run there. `None` off the screen or behind the camera.
    fn mark_at(&self, view: ViewId, point: [f64; 3]) -> Option<CrosshairMark> {
        let camera = &self.view(view)?.camera;
        let to_world = self.world_space().from_scene();
        let on_screen = |point: [f64; 3]| match camera {
            Camera::Slice(slice) => {
                let [across, down, _] = slice.plane.axes().map(SpatialAxis::xyz);
                Some(slice.to_screen([point[across], point[down]]))
            }
            Camera::Arcball(_) | Camera::Fly(_) => camera.project_to_screen(to_world.apply(point)),
        };
        let center = on_screen(point)?;
        let [width, height] = camera.viewport().map(f64::from);
        let at = [center[0] / width, center[1] / height];
        if !at.iter().all(|f| (0.0..=1.0).contains(f)) {
            return None;
        }
        let step = ARM_STEP_WORLD / to_world.length_scale();
        let mut arms = [[0.0; 2]; 3];
        for (a, arm) in arms.iter_mut().enumerate() {
            let mut along = point;
            along[a] += step;
            if let Some(end) = on_screen(along) {
                *arm = [end[0] - center[0], end[1] - center[1]];
            }
        }
        let longest = arms.iter().map(|[x, y]| x.hypot(*y)).fold(0.0, f64::max);
        if longest > 0.0 {
            for arm in &mut arms {
                *arm = arm.map(|d| d / longest);
            }
        }
        let world = camera.is_volume().then(|| to_world.apply(point));
        Some(CrosshairMark::At { at, arms, world })
    }
}

/// Whether the box `(lo, hi)` holds `point`, give or take [`HOLD_SLACK`].
fn box_holds((lo, hi): ([f64; 3], [f64; 3]), point: [f64; 3]) -> bool {
    (0..3).all(|a| {
        let slack = (hi[a] - lo[a]) * HOLD_SLACK;
        point[a] >= lo[a] - slack && point[a] <= hi[a] + slack
    })
}

#[cfg(test)]
mod tests {
    use lucida_content::PhysicalSpace;

    use super::super::test_helpers::{make_dataset_opened_with_shape, unlink};
    use super::*;
    use crate::command::{Command, DocumentCommand, ViewportCommand};
    use crate::scene::{LinkMode, LinkProperty};

    /// An image of `[z, y, x]` samples, each `spacing` long, in micrometers
    /// when `physical` and in no unit otherwise, its origin at `origin`.
    fn open(
        scene: &mut Scene,
        id: &str,
        [z, y, x]: [u64; 3],
        spacing: f64,
        physical: bool,
        origin: [f64; 3],
    ) {
        let mut opened =
            make_dataset_opened_with_shape(id, id, 1, [1, 1, z, y, x], [1, 1, 16, 64, 64], 1);
        for image in opened.manifest.images_mut() {
            image.multiscale.levels[0].scale = [1.0, 1.0, spacing, spacing, spacing];
        }
        let unit = physical.then(|| "micrometer".to_string());
        opened.manifest = opened.manifest.with_space(PhysicalSpace {
            units: [unit.clone(), unit.clone(), unit],
            origin,
        });
        scene.apply(DocumentCommand::DatasetOpened(opened).into());
    }

    fn apply(scene: &mut Scene, cmd: ViewportCommand) {
        scene.apply(Command::Viewport(cmd));
    }

    fn ids(scene: &Scene) -> Vec<ViewId> {
        scene.views().iter().map(|view| view.id()).collect()
    }

    /// `a` in the first of two columns and `b` in the second, the first
    /// active.
    fn columns(scene: &mut Scene, b: &str) -> [ViewId; 2] {
        let layout = ViewLayout::Columns;
        apply(scene, ViewportCommand::SetViewLayout { layout });
        let [first, second] = ids(scene)[..] else {
            panic!("two views");
        };
        let dataset_id = DatasetId::from(b);
        apply(
            scene,
            ViewportCommand::MoveDatasetToView {
                view: second,
                dataset_id,
            },
        );
        apply(scene, ViewportCommand::SetActiveView { view: first });
        [first, second]
    }

    /// A and B over the same 64 micrometers, B in samples half as long, in
    /// two linked views.
    fn one_place() -> (Scene, [ViewId; 2]) {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [32, 64, 64], 1.0, true, [0.0; 3]);
        open(&mut scene, "b", [64, 128, 128], 0.5, true, [0.0; 3]);
        let views = columns(&mut scene, "b");
        (scene, views)
    }

    fn at(marks: &[ViewCrosshair], view: ViewId) -> Option<([f64; 2], [[f64; 2]; 3])> {
        marks
            .iter()
            .find(|mark| mark.view == view)
            .and_then(|mark| match mark.mark {
                CrosshairMark::At { at, arms, .. } => Some((at, arms)),
                CrosshairMark::Outside => None,
            })
    }

    fn close(a: [f64; 2], b: [f64; 2]) -> bool {
        (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9
    }

    fn arms_are(arms: [[f64; 2]; 3], expected: [[f64; 2]; 3]) -> bool {
        arms.iter()
            .zip(expected)
            .all(|(arm, expected)| close(*arm, expected))
    }

    /// The point of the scene frame under `at` in a slice view.
    fn under(scene: &Scene, view: ViewId, at: [f64; 2]) -> [f64; 3] {
        scene.point_under(view, at).expect("a point")
    }

    #[test]
    fn two_linked_views_over_one_region_mark_the_same_physical_point() {
        let (scene, [first, second]) = one_place();
        let marks = scene.crosshairs(first, [0.3, 0.6]);
        assert_eq!(marks.len(), 1, "the hovered view marks nothing itself");
        let (at, arms) = at(&marks, second).expect("a mark in the other view");
        // Pan and zoom link, and the views are one size, so one point of
        // the region sits at one place in each, whatever their samples.
        assert!(close(at, [0.3, 0.6]), "{at:?}");
        assert!(
            arms_are(arms, [[1.0, 0.0], [0.0, 1.0], [0.0, 0.0]]),
            "{arms:?}"
        );
        // And back the other way.
        let back = scene.crosshairs(second, [0.7, 0.4]);
        assert!(close(at_of(&back, first), [0.7, 0.4]));
    }

    fn at_of(marks: &[ViewCrosshair], view: ViewId) -> [f64; 2] {
        at(marks, view).expect("a mark").0
    }

    #[test]
    fn a_view_whose_data_misses_the_point_says_it_is_outside() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [32, 64, 64], 1.0, true, [0.0; 3]);
        // B covers only the right half of A.
        open(&mut scene, "b", [32, 64, 32], 1.0, true, [0.0, 0.0, 32.0]);
        let [first, second] = columns(&mut scene, "b");
        // Past A's right edge, B holds the point; over A's left half, it doesn't.
        let left = (0..100)
            .map(|i| [f64::from(i) / 100.0, 0.5])
            .find(|at| under(&scene, first, *at)[0] > 2.0 && under(&scene, first, *at)[0] < 30.0)
            .expect("a point over the left half");
        let right = (0..100)
            .map(|i| [f64::from(i) / 100.0, 0.5])
            .find(|at| under(&scene, first, *at)[0] > 34.0 && under(&scene, first, *at)[0] < 62.0)
            .expect("a point over the right half");
        assert_eq!(
            scene.crosshairs(first, left),
            vec![ViewCrosshair {
                view: second,
                mark: CrosshairMark::Outside
            }]
        );
        assert!(at(&scene.crosshairs(first, right), second).is_some());
    }

    #[test]
    fn views_with_every_link_of_where_they_look_off_mark_nothing() {
        let (mut scene, [first, _]) = one_place();
        unlink(&mut scene);
        assert!(scene.crosshairs(first, [0.5, 0.5]).is_empty());
        // Depth alone links them again.
        let (property, mode) = (LinkProperty::Z, LinkMode::Linked);
        apply(&mut scene, ViewportCommand::SetViewLink { property, mode });
        assert_eq!(scene.crosshairs(first, [0.5, 0.5]).len(), 1);
        // The timepoint says nothing of where they look.
        unlink(&mut scene);
        let (property, mode) = (LinkProperty::T, LinkMode::Linked);
        apply(&mut scene, ViewportCommand::SetViewLink { property, mode });
        assert!(scene.crosshairs(first, [0.5, 0.5]).is_empty());
    }

    #[test]
    fn the_voxel_basis_carries_the_point_to_the_same_sample() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [32, 64, 64], 1.0, false, [0.0; 3]);
        open(&mut scene, "b", [32, 64, 64], 0.5, false, [0.0; 3]);
        let [first, second] = columns(&mut scene, "b");
        unlink(&mut scene);
        let (property, mode) = (LinkProperty::Pan, LinkMode::Linked);
        apply(&mut scene, ViewportCommand::SetViewLink { property, mode });
        let point = under(&scene, first, [0.5, 0.5]);
        let Some(Camera::Slice(slice)) = scene.view(second).map(|v| v.camera.clone()) else {
            panic!("a slice view");
        };
        let [sx, sy] = slice.to_screen([point[0] * 0.5, point[1] * 0.5]);
        let [width, height] = slice.viewport.map(f64::from);
        let mark = at_of(&scene.crosshairs(first, [0.5, 0.5]), second);
        assert!(close(mark, [sx / width, sy / height]), "{mark:?}");
    }

    fn four_up() -> Scene {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [32, 128, 96], 1.0, true, [0.0; 3]);
        let layout = ViewLayout::FourUp;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        scene
    }

    #[test]
    fn four_up_marks_the_point_in_its_other_three_views() {
        let scene = four_up();
        let [xy, yz, xz, volume] = ids(&scene)[..] else {
            panic!("four views");
        };
        let marks = scene.crosshairs(xy, [0.4, 0.45]);
        assert_eq!(marks.len(), 3);
        let point = under(&scene, xy, [0.4, 0.45]);
        // XZ draws X across and Z down, and the point stands at XY's cut, so
        // its mark sits on XZ's line of the Z plane.
        let (on_xz, arms) = at(&marks, xz).expect("a mark in XZ");
        let z_line = scene
            .plane_lines(xz)
            .into_iter()
            .find(|line| line.axis == SpatialAxis::Z)
            .expect("XZ draws Z");
        assert!((on_xz[1] - z_line.from[1]).abs() < 1e-9);
        assert_eq!(arms[1], [0.0, 0.0], "XZ looks along Y");
        // YZ is drawn transposed: Z across, Y down.
        let (on_yz, arms) = at(&marks, yz).expect("a mark in YZ");
        assert!(
            arms_are(arms, [[0.0, 0.0], [0.0, 1.0], [1.0, 0.0]]),
            "{arms:?}"
        );
        let back = under(&scene, yz, on_yz);
        assert!((back[1] - point[1]).abs() < 1e-6 && (back[2] - point[2]).abs() < 1e-6);
        // The volume marks the point in 3D, each axis some way across it,
        // and reads it where it lies; a slice view reads its own plane.
        let (_, arms) = at(&marks, volume).expect("a mark in the volume");
        assert!(arms.iter().filter(|[x, y]| x.hypot(*y) > 0.0).count() == 3);
        let world = |view| match marks.iter().find(|mark| mark.view == view).map(|m| &m.mark) {
            Some(CrosshairMark::At { world, .. }) => *world,
            _ => None,
        };
        assert_eq!(
            world(volume),
            Some(scene.world_space().from_scene().apply(point))
        );
        assert_eq!(world(xz), None);
    }

    #[test]
    fn a_volume_view_gives_a_point_only_where_its_ray_meets_data() {
        let scene = four_up();
        let [xy, _, _, volume] = ids(&scene)[..] else {
            panic!("four views");
        };
        let marks = scene.crosshairs(volume, [0.5, 0.5]);
        assert_eq!(marks.len(), 3);
        // The point is where the ray enters the data, which XY holds.
        let point = scene.point_under(volume, [0.5, 0.5]).expect("a hit");
        let (on_xy, _) = at(&marks, xy).expect("a mark in XY");
        let back = under(&scene, xy, on_xy);
        assert!((back[0] - point[0]).abs() < 1e-6 && (back[1] - point[1]).abs() < 1e-6);
        assert!(scene.crosshairs(volume, [0.0, 0.0]).is_empty());
    }

    #[test]
    fn a_grid_of_unlinked_views_and_one_view_mark_nothing() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [32, 64, 64], 1.0, true, [0.0; 3]);
        assert!(scene.crosshairs(ViewId(0), [0.5, 0.5]).is_empty());
        let layout = ViewLayout::Grid;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let first = scene.views()[0].id();
        assert!(scene.crosshairs(first, [0.5, 0.5]).is_empty());
    }

    #[test]
    fn a_view_holding_the_point_off_its_screen_marks_nothing() {
        let (mut scene, [first, second]) = one_place();
        unlink(&mut scene);
        let (property, mode) = (LinkProperty::Z, LinkMode::Linked);
        apply(&mut scene, ViewportCommand::SetViewLink { property, mode });
        // The second view zooms in on its top left corner alone.
        apply(&mut scene, ViewportCommand::SetActiveView { view: second });
        apply(&mut scene, ViewportCommand::SetZoom { value: 40.0 });
        apply(&mut scene, ViewportCommand::SetCenter { x: 2.0, y: 2.0 });
        assert!(scene.crosshairs(first, [0.9, 0.5]).is_empty());
    }
}
