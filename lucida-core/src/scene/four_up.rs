//! The four-up layout: one set of datasets as an XY, an XZ and a YZ slice
//! and a volume, crossing at one point. YZ is drawn transposed, Z across and
//! Y down, so that it shares XY's rows as XZ shares its columns. The point is the views' axis
//! positions, which every view holds on all three axes, so the four share
//! them: each slice view cuts where the other two draw their lines, and a
//! move of one view's position moves them all. Their cameras stay their own.

use lucida_content::SpatialAxis;

use super::Scene;
use crate::camera::{Arcball, Camera, Framing};
use crate::slice_plane::SlicePlane;
use crate::view::{AxisPositions, ViewLayout};

/// What each view of a four-up layout shows, in the layout's order: XY at
/// the top left, YZ at its right so the two share Y, XZ under it so the two
/// share X, and the volume at the bottom right.
pub const FOUR_UP: [Option<SlicePlane>; 4] = [
    Some(SlicePlane::Xy),
    Some(SlicePlane::Yz),
    Some(SlicePlane::Xz),
    None,
];

/// The slot of a four-up layout that shows what `camera` shows.
fn slot_of(camera: &Camera) -> usize {
    let shows = match camera {
        Camera::Slice(slice) => Some(slice.plane),
        Camera::Arcball(_) | Camera::Fly(_) => None,
    };
    FOUR_UP.iter().position(|role| *role == shows).unwrap_or(0)
}

impl Scene {
    /// Give each of four views its part of a four-up layout. The active
    /// view takes the slot its camera already shows, so it keeps its pose;
    /// the others show what it shows, each in its own plane or in 3D, to be
    /// fitted. All four stand at the active view's axis positions, with a
    /// side view's place in the middle where it had none, as switching to
    /// that plane gives one.
    pub(super) fn arrange_four_up(&mut self) {
        let Some(at) = self.views.iter().position(|v| v.id() == self.active) else {
            return;
        };
        if self.views.len() != FOUR_UP.len() {
            return;
        }
        let slot = slot_of(&self.views[at].camera);
        self.views.swap(at, slot);
        let mut axes = self.views[slot].axes.clone();
        for axis in [SpatialAxis::Y, SpatialAxis::X] {
            if axes.place(axis).is_none() {
                let middle = self.cut_middle(self.active, axis);
                match axis {
                    SpatialAxis::Y => axes.y = Some(middle),
                    _ => axes.x = Some(middle),
                }
            }
        }
        let datasets = self.views[slot].datasets.clone();
        for (index, (view, role)) in self.views.iter_mut().zip(FOUR_UP).enumerate() {
            view.axes = axes.clone();
            if index == slot {
                if let Camera::Slice(slice) = &mut view.camera {
                    slice.transposed = slice.plane == SlicePlane::Yz;
                }
                continue;
            }
            let viewport = view.camera.viewport();
            view.camera = match role {
                Some(plane) => {
                    let mut camera = Camera::new_2d(viewport);
                    if let Camera::Slice(slice) = &mut camera {
                        slice.plane = plane;
                        slice.transposed = plane == SlicePlane::Yz;
                    }
                    camera
                }
                None => Camera::Arcball(Arcball::new(viewport)),
            };
            view.parked_camera = None;
            view.datasets = datasets.clone();
            view.comparison = None;
        }
    }

    /// Line the slice views of a new four-up layout up with the active view
    /// where it is a slice view someone placed: each takes its scale, and
    /// its center along every axis the two draw, staying centered on the
    /// data along the other. A fitted active view, or a volume, leaves them
    /// at the layout's fit, which lines them up already.
    pub(super) fn align_four_up(&mut self) {
        let leader = match &self.active_view().camera {
            Camera::Slice(slice) if slice.framing == Framing::Placed => slice.clone(),
            _ => return,
        };
        let active = self.active;
        let shown = leader.plane.axes();
        for view in self.views.iter_mut().filter(|view| view.id() != active) {
            let Camera::Slice(slice) = &mut view.camera else {
                continue;
            };
            let axes = slice.plane.axes();
            let mut center = slice.center;
            for (at, axis) in axes[..2].iter().enumerate() {
                if let Some(from) = shown[..2].iter().position(|a| a == axis) {
                    center[at] = leader.center[from];
                }
            }
            slice.set_zoom(leader.zoom);
            slice.set_center(center[0], center[1]);
            slice.framing = Framing::Placed;
        }
    }

    /// Draw every slice view the way its plane stands alone again, as a
    /// layout other than four-up does. A transposed view keeps its region.
    pub(super) fn leave_four_up(&mut self) {
        for view in &mut self.views {
            for camera in view.cameras_mut() {
                if let Camera::Slice(slice) = camera {
                    slice.transposed = false;
                }
            }
        }
    }

    /// Stand every view of a four-up layout at the active view's axis
    /// positions, when they moved from `before`. Says whether another view
    /// moved.
    pub(crate) fn share_crossing(&mut self, before: &AxisPositions) -> bool {
        if self.layout != ViewLayout::FourUp {
            return false;
        }
        let axes = self.active_view().axes.clone();
        if axes == *before {
            return false;
        }
        let active = self.active;
        let mut moved = false;
        for view in self.views.iter_mut().filter(|view| view.id() != active) {
            if view.axes != axes {
                view.axes = axes.clone();
                moved = true;
            }
        }
        moved
    }

    /// The zoom a four-up layout fits its slice views at: the closest of
    /// their own fits, so the three draw one length at one size and XY and
    /// XZ, each centered on the same data, line up along X. `None` in any
    /// other layout.
    pub(super) fn four_up_fit_zoom(&self) -> Option<f64> {
        if self.layout != ViewLayout::FourUp {
            return None;
        }
        self.views
            .iter()
            .filter_map(|view| {
                let bounds = self.visible_bounds(view.id())?;
                let mut camera = view.camera.clone();
                camera.fit(&bounds);
                match camera {
                    Camera::Slice(slice) => Some(slice.zoom),
                    Camera::Arcball(_) | Camera::Fly(_) => None,
                }
            })
            .reduce(f64::min)
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::{DatasetId, PhysicalSpace};

    use super::super::test_helpers::make_dataset_opened_with_shape;
    use super::*;
    use crate::command::{Command, DocumentCommand, ViewportCommand};
    use crate::view::{ViewDatasets, ViewId};

    /// A micrometer volume of `[z, y, x]` samples, each one micrometer.
    fn open(scene: &mut Scene, id: &str, [z, y, x]: [u64; 3]) {
        let mut opened =
            make_dataset_opened_with_shape(id, id, 1, [2, 1, z, y, x], [1, 1, 16, 64, 64], 1);
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

    fn four_up() -> Scene {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [32, 128, 96]);
        let layout = ViewLayout::FourUp;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        scene
    }

    fn shows(scene: &Scene) -> Vec<Option<SlicePlane>> {
        scene
            .views()
            .iter()
            .map(|view| match &view.camera {
                Camera::Slice(slice) => Some(slice.plane),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn four_up_shows_the_three_planes_and_the_volume_of_the_same_datasets() {
        let scene = four_up();
        assert_eq!(shows(&scene), FOUR_UP.to_vec());
        assert_eq!(scene.active_view().id(), ViewId(0));
        for view in scene.views() {
            assert_eq!(view.datasets, ViewDatasets::All);
            assert!(scene.draws(view.id(), &DatasetId::from("a")));
        }
        // A side view stands in the middle, as switching to it does.
        let axes = &scene.active_view().axes;
        assert_eq!((axes.y, axes.x), (Some(64.5), Some(48.5)));
        assert!(scene.links().is_none(), "links join two views");
    }

    #[test]
    fn the_active_view_keeps_its_slot_and_pose() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [32, 128, 96]);
        apply(&mut scene, ViewportCommand::SetMode3D);
        let (d_theta, d_phi) = (0.2, 0.1);
        apply(&mut scene, ViewportCommand::Rotate3D { d_theta, d_phi });
        let pose = scene.active_view().camera.clone();
        let layout = ViewLayout::FourUp;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        assert_eq!(shows(&scene), FOUR_UP.to_vec());
        assert_eq!(scene.views()[3].id(), scene.active_view().id());
        match (&scene.active_view().camera, &pose) {
            (Camera::Arcball(now), Camera::Arcball(was)) => {
                assert_eq!((now.theta, now.phi), (was.theta, was.phi));
            }
            other => panic!("an orbit camera, not {other:?}"),
        }
    }

    #[test]
    fn a_move_of_one_views_position_moves_them_all() {
        let mut scene = four_up();
        let ids: Vec<ViewId> = scene.views().iter().map(|v| v.id()).collect();
        let epoch = scene.epochs.selection;
        apply(&mut scene, ViewportCommand::SetZ { z: 7 });
        assert_eq!(scene.epochs.selection, epoch + 1, "one move of the epoch");
        // The XZ view cuts Y; it steers it, and every view stands there.
        apply(&mut scene, ViewportCommand::SetActiveView { view: ids[2] });
        apply(&mut scene, ViewportCommand::SetY { y: 20 });
        apply(&mut scene, ViewportCommand::SetT { t: 1 });
        for id in ids {
            let axes = &scene.view(id).unwrap().axes;
            assert_eq!(axes.place(SpatialAxis::Z), Some(7.5));
            assert_eq!(axes.y, Some(20.5));
            assert_eq!(axes.t, 1);
        }
    }

    #[test]
    fn the_slice_views_fit_at_one_zoom_so_xy_and_xz_line_up_along_x() {
        let scene = four_up();
        let slice = |index: usize| match &scene.views()[index].camera {
            Camera::Slice(slice) => (slice.center, slice.zoom),
            other => panic!("a slice camera, not {other:?}"),
        };
        let (xy, xz, yz) = (slice(0), slice(2), slice(1));
        assert_eq!(xy.1, xz.1);
        assert_eq!(xy.1, yz.1);
        assert_eq!(xy.0[0], xz.0[0]);
    }

    #[test]
    fn side_views_take_a_placed_views_scale_and_its_place_on_the_axes_they_share() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [32, 128, 96]);
        apply(&mut scene, ViewportCommand::SetZoom { value: 9.0 });
        apply(&mut scene, ViewportCommand::SetCenter { x: 20.0, y: 70.0 });
        let layout = ViewLayout::FourUp;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let slice = |index: usize| match &scene.views()[index].camera {
            Camera::Slice(slice) => (slice.center, slice.zoom),
            other => panic!("a slice camera, not {other:?}"),
        };
        let (xy, yz, xz) = (slice(0), slice(1), slice(2));
        assert_eq!(xy.1, xz.1);
        assert_eq!(xy.1, yz.1);
        // XZ shares X, and YZ draws Y across; each stays on the middle of Z.
        assert_eq!(xz.0, [xy.0[0], 16.0]);
        assert_eq!(yz.0, [xy.0[1], 16.0]);
    }

    #[test]
    fn yz_is_drawn_transposed_so_it_shares_xys_rows() {
        let scene = four_up();
        let slice = |index: usize| match &scene.views()[index].camera {
            Camera::Slice(slice) => slice.clone(),
            other => panic!("a slice camera, not {other:?}"),
        };
        let (xy, yz, xz) = (slice(0), slice(1), slice(2));
        assert!(yz.transposed && !xy.transposed && !xz.transposed);
        assert_eq!(yz.screen_axes(), [SpatialAxis::Z, SpatialAxis::Y]);
        // Any Y lands on one screen row in both, and any X on one column of
        // XY and XZ, the views being alike in size.
        for y in [10.0, 64.0, 101.5] {
            assert_eq!(xy.to_screen([20.0, y])[1], yz.to_screen([y, 3.0])[1]);
        }
        for x in [5.0, 48.0, 90.0] {
            assert_eq!(xy.to_screen([x, 30.0])[0], xz.to_screen([x, 3.0])[0]);
        }
    }

    #[test]
    fn a_transposed_and_a_standalone_yz_at_one_cut_plan_the_same_chunks() {
        // Square views, so the two cover the same region of the plane.
        let mut scene = Scene::new([800, 400]);
        open(&mut scene, "a", [32, 128, 96]);
        let layout = ViewLayout::Columns;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        let ids: Vec<ViewId> = scene.views().iter().map(|v| v.id()).collect();
        let datasets = ViewDatasets::All;
        let second = ids[1];
        apply(
            &mut scene,
            ViewportCommand::SetViewDatasets {
                view: second,
                datasets,
            },
        );
        for id in &ids {
            apply(&mut scene, ViewportCommand::SetActiveView { view: *id });
            let plane = SlicePlane::Yz;
            apply(&mut scene, ViewportCommand::SetSlicePlane { plane });
            apply(&mut scene, ViewportCommand::SetX { x: 40 });
        }
        if let Camera::Slice(slice) = &mut scene.views[1].camera {
            slice.transposed = true;
        }
        let a = DatasetId::from("a");
        let plan = |view: ViewId| format!("{:?}", scene.chunk_plan_for(view, &a));
        assert_eq!(plan(ids[0]), plan(ids[1]));
    }

    #[test]
    fn another_layout_or_another_plane_draws_a_plane_as_it_stands_alone() {
        let mut scene = four_up();
        let yz = scene.views()[1].id();
        apply(&mut scene, ViewportCommand::SetActiveView { view: yz });
        let plane = SlicePlane::Xy;
        apply(&mut scene, ViewportCommand::SetSlicePlane { plane });
        let transposed = |scene: &Scene, index: usize| match &scene.views()[index].camera {
            Camera::Slice(slice) => slice.transposed,
            _ => false,
        };
        assert!(!transposed(&scene, 1));
        let mut scene = four_up();
        let layout = ViewLayout::Grid;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        assert!((0..4).all(|index| !transposed(&scene, index)));
    }

    #[test]
    fn another_layout_ends_the_crossing_and_two_by_two_keeps_four_free_views() {
        let mut scene = four_up();
        let layout = ViewLayout::Grid;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        assert_eq!(shows(&scene), FOUR_UP.to_vec());
        apply(&mut scene, ViewportCommand::SetZ { z: 3 });
        let others = scene.views()[1].axes.place(SpatialAxis::Z);
        assert_ne!(others, Some(3.5));
        let layout = ViewLayout::Single;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        assert_eq!(scene.views().len(), 1);
    }
}
