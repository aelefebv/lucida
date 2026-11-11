//! The four-up layout: one set of datasets as an XY, an XZ and a YZ slice
//! and a volume, crossing at one point. YZ is drawn transposed, Z across and
//! Y down, so that it shares XY's rows as XZ shares its columns. The point is the views' axis
//! positions, which every view holds on all three axes, so the four share
//! them: each slice view cuts where the other two draw their lines, and a
//! move of one view's position moves them all. Their cameras stay their own.
//!
//! A collection is cut at one place from every tile's own edge, so the lines
//! stand on one tile, the one the client names, and a drag there moves the
//! cut of every tile.

use lucida_content::{DatasetId, EntityId, SpatialAxis};
use serde::{Deserialize, Serialize};

use super::placement::{frame_box, placing_plane};
use super::{MemberState, Scene};
use crate::camera::{Arcball, Camera, Framing, Slice};
use crate::slice_plane::SlicePlane;
use crate::view::{AxisPositions, ViewId, ViewLayout};

/// Where one of four-up's planes crosses a view, as the view draws it: a
/// slice view the other two planes as lines, the volume each plane's
/// outline over the data.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlaneLine {
    /// The axis the plane stands at a place along, the one its view cuts.
    pub axis: SpatialAxis,
    /// The segment's ends, as fractions of the view's width and height from
    /// its top left.
    pub from: [f64; 2],
    pub to: [f64; 2],
}

/// A tile of a collection, by its dataset and its entity there: the one
/// four-up draws its planes on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaneTile {
    pub dataset: DatasetId,
    pub entity: EntityId,
}

/// The tile a view draws four-up's planes on, as the view places it.
struct OnTile {
    /// From where the view draws its collection's first planes to where it
    /// draws the tile's, in the scene frame: how far the tile's planes stand
    /// from the place the view cuts.
    shift: [f64; 3],
    /// The tile's box in the scene frame, as a volume view draws it.
    extent: ([f64; 3], [f64; 3]),
}

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

    /// The tile of a collection `view` shows under `at`, fractions of its
    /// width and height from its top left; in a volume view, the nearest
    /// one the ray meets. `None` over no tile.
    pub fn tile_at(&self, view: ViewId, at: [f64; 2]) -> Option<PlaneTile> {
        let [width, height] = self.view(view)?.camera.viewport().map(f64::from);
        let [x, y] = [at[0] * width, at[1] * height];
        self.shown_collections(view)
            .filter_map(|id| Some((id, self.ray_pick(view, id, x, y)?)))
            .min_by(|a, b| a.1.distance.total_cmp(&b.1.distance))
            .map(|(id, hit)| PlaneTile {
                dataset: id.clone(),
                entity: hit.entity_id,
            })
    }

    /// The visible collections `view` shows, in layer order.
    fn shown_collections(&self, view: ViewId) -> impl Iterator<Item = &DatasetId> {
        self.layer_ids().filter(move |id| {
            self.derived
                .get(*id)
                .is_some_and(|d| d.tile_cells.is_some())
                && self.shown_dataset_ids(view).any(|shown| shown == *id)
        })
    }

    /// The tile `view` draws four-up's planes on: `tile` where the view
    /// shows its collection, or else the first tile of the first collection
    /// it shows. `None` where it shows none, so the planes stand where the
    /// scene frame places the cut.
    fn on_tile(&self, view: ViewId, tile: Option<&PlaneTile>) -> Option<OnTile> {
        let named = tile.and_then(|tile| {
            let id = self
                .shown_collections(view)
                .find(|id| **id == tile.dataset)?;
            Some((id, self.derived.get(id)?.member_by_id(&tile.entity.0)?))
        });
        let (id, member) = named.or_else(|| {
            let id = self.shown_collections(view).next()?;
            Some((id, self.derived.get(id)?.members.first()?))
        })?;
        self.tile_placed(view, id, member)
    }

    /// Where `view` draws `member` of the collection `dataset_id`.
    fn tile_placed(
        &self,
        view: ViewId,
        dataset_id: &DatasetId,
        member: &MemberState,
    ) -> Option<OnTile> {
        let derived = self.derived.get(dataset_id)?;
        let to_scene = self.placement(dataset_id)?;
        let plane = placing_plane(self.view(view)?, &to_scene);
        let on_plane = plane.frame_point(derived.plane_position(plane, member));
        let (lo, hi) = frame_box(member)?;
        Some(OnTile {
            shift: to_scene.apply_vector(on_plane),
            extent: to_scene.apply_box(lo, hi),
        })
    }

    /// Where four-up's planes cross `view`: in a slice view, a line across
    /// it for each plane whose axis it draws; in the volume, each plane's
    /// outline over the data the view draws. In a collection they stand on
    /// `tile` ([`Self::tile_at`] names one), or on the first tile without
    /// one. None in any other layout.
    pub fn plane_lines(&self, view: ViewId, tile: Option<&PlaneTile>) -> Vec<PlaneLine> {
        if self.layout != ViewLayout::FourUp {
            return Vec::new();
        }
        let Some(shown) = self.view(view) else {
            return Vec::new();
        };
        let on_tile = self.on_tile(view, tile);
        let shift = on_tile.as_ref().map_or([0.0; 3], |on| on.shift);
        match &shown.camera {
            Camera::Slice(slice) => slice
                .screen_axes()
                .into_iter()
                .enumerate()
                .map(|(on_screen, axis)| {
                    let place = self.cut_place(view, axis) + shift[axis.xyz()];
                    let at = slice_screen_at(slice, axis, place);
                    let [width, height] = slice.viewport.map(f64::from);
                    match on_screen {
                        0 => PlaneLine {
                            axis,
                            from: [at / width, 0.0],
                            to: [at / width, 1.0],
                        },
                        _ => PlaneLine {
                            axis,
                            from: [0.0, at / height],
                            to: [1.0, at / height],
                        },
                    }
                })
                .collect(),
            camera => self.plane_outlines(view, camera, on_tile),
        }
    }

    /// Each plane's outline over the data `view` draws, or over `on_tile`
    /// alone, projected by its volume camera.
    fn plane_outlines(
        &self,
        view: ViewId,
        camera: &Camera,
        on_tile: Option<OnTile>,
    ) -> Vec<PlaneLine> {
        let (span, shift) = match on_tile {
            Some(OnTile {
                shift,
                extent: (min, max),
            }) => (std::array::from_fn(|a| (min[a], max[a])), shift),
            None => {
                let extents = SpatialAxis::ALL.map(|axis| {
                    self.layer_ids()
                        .filter(|id| self.draws(view, id))
                        .filter_map(|id| self.scene_extent(id, axis))
                        .reduce(|(lo, hi), (min, max)| (lo.min(min), hi.max(max)))
                });
                let [Some(x), Some(y), Some(z)] = extents else {
                    return Vec::new();
                };
                ([x, y, z], [0.0; 3])
            }
        };
        let to_world = self.world_space().from_scene();
        let [width, height] = camera.viewport().map(f64::from);
        let on_screen = |point: [f64; 3]| {
            let [sx, sy] = camera.project_to_screen(to_world.apply(point))?;
            Some([sx / width, sy / height])
        };
        let mut lines = Vec::new();
        for axis in SpatialAxis::ALL {
            let a = axis.xyz();
            let [b, c] = [(a + 1) % 3, (a + 2) % 3];
            let corner = |sb: usize, sc: usize| {
                let mut point = [0.0; 3];
                point[a] = self.cut_place(view, axis) + shift[a];
                point[b] = if sb == 0 { span[b].0 } else { span[b].1 };
                point[c] = if sc == 0 { span[c].0 } else { span[c].1 };
                on_screen(point)
            };
            let corners = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
            for i in 0..4 {
                if let (Some(from), Some(to)) = (corners[i], corners[(i + 1) % 4]) {
                    lines.push(PlaneLine { axis, from, to });
                }
            }
        }
        lines
    }

    /// The position on `view`'s grid along `axis` under `fraction` of the
    /// way across the view, along the screen axis that draws `axis`, as a
    /// drag of its plane's line on `tile` sets it ([`Self::plane_lines`]).
    /// `None` for a view that doesn't draw the axis.
    pub fn plane_line_position(
        &self,
        view: ViewId,
        axis: SpatialAxis,
        fraction: f64,
        tile: Option<&PlaneTile>,
    ) -> Option<u32> {
        let Camera::Slice(slice) = &self.view(view)?.camera else {
            return None;
        };
        let on_screen = slice.screen_axes().iter().position(|a| *a == axis)?;
        let [width, height] = slice.viewport.map(f64::from);
        let screen = match on_screen {
            0 => [fraction * width, height / 2.0],
            _ => [width / 2.0, fraction * height],
        };
        let point = slice.from_screen(screen);
        let along = slice.plane.axes().iter().position(|a| *a == axis)?;
        let shift = self
            .on_tile(view, tile)
            .map_or(0.0, |on| on.shift[axis.xyz()]);
        Some(self.cut_grid(view, axis).index_of(point[along] - shift))
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

/// Where `place` along `axis`, one the slice camera draws, falls on the
/// screen along the screen axis that draws it, in device pixels.
fn slice_screen_at(slice: &Slice, axis: SpatialAxis, place: f64) -> f64 {
    let mut point = slice.center;
    if let Some(along) = slice.plane.axes()[..2].iter().position(|a| *a == axis) {
        point[along] = place;
    }
    let screen = slice.to_screen(point);
    match slice.screen_axes().iter().position(|a| *a == axis) {
        Some(0) => screen[0],
        _ => screen[1],
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
    fn home_fits_a_view_at_the_shared_zoom_and_leaves_the_crossing() {
        let mut scene = four_up();
        let ids: Vec<ViewId> = scene.views().iter().map(|v| v.id()).collect();
        apply(&mut scene, ViewportCommand::SetActiveView { view: ids[2] });
        apply(&mut scene, ViewportCommand::SetY { y: 30 });
        let framed = scene.active_view().camera.clone();
        let crossing: Vec<AxisPositions> = scene.views().iter().map(|v| v.axes.clone()).collect();
        apply(
            &mut scene,
            ViewportCommand::Pan {
                dx: 120.0,
                dy: 40.0,
            },
        );
        apply(&mut scene, ViewportCommand::ZoomBy { factor: 3.0 });
        assert!(scene.home([800, 600]));
        assert_eq!(scene.active_view().camera, framed);
        let now: Vec<AxisPositions> = scene.views().iter().map(|v| v.axes.clone()).collect();
        assert_eq!(now, crossing);
        // The volume turns back to the first orbit without moving it either.
        apply(&mut scene, ViewportCommand::SetActiveView { view: ids[3] });
        let first = scene.active_view().camera.clone();
        let (d_theta, d_phi) = (0.7, 0.2);
        apply(&mut scene, ViewportCommand::Rotate3D { d_theta, d_phi });
        assert!(scene.home([800, 600]));
        assert_eq!(scene.active_view().camera, first);
        let now: Vec<AxisPositions> = scene.views().iter().map(|v| v.axes.clone()).collect();
        assert_eq!(now, crossing);
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
    fn each_slice_view_draws_the_other_two_planes_where_they_cross_it() {
        let mut scene = four_up();
        apply(&mut scene, ViewportCommand::SetZ { z: 7 });
        let xy = scene.views()[0].id();
        let lines = scene.plane_lines(xy, None);
        // XY draws X across and Y down: X's plane is a vertical line, Y's a
        // horizontal one, through the middle where both stand.
        assert_eq!(
            lines.iter().map(|l| l.axis).collect::<Vec<_>>(),
            vec![SpatialAxis::X, SpatialAxis::Y]
        );
        assert_eq!(lines[0].from[0], lines[0].to[0]);
        assert_eq!((lines[0].from[1], lines[0].to[1]), (0.0, 1.0));
        assert_eq!(lines[1].from[1], lines[1].to[1]);
        // YZ, transposed, draws Z across, standing at Z 7 near its left.
        let yz = scene.views()[1].id();
        let lines = scene.plane_lines(yz, None);
        assert_eq!(
            lines.iter().map(|l| l.axis).collect::<Vec<_>>(),
            vec![SpatialAxis::Z, SpatialAxis::Y]
        );
        assert!(lines[0].from[0] < 0.5);
        // The same Y lands on one height of XY and YZ.
        assert_eq!(scene.plane_lines(xy, None)[1].from[1], lines[1].from[1]);
        // The volume outlines all three planes, four edges each.
        let volume = scene.views()[3].id();
        let outlines = scene.plane_lines(volume, None);
        assert_eq!(outlines.len(), 12);
        let layout = ViewLayout::Grid;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        assert!(scene.plane_lines(xy, None).is_empty());
    }

    #[test]
    fn dragging_a_line_names_the_position_under_the_pointer() {
        let mut scene = four_up();
        let xy = scene.views()[0].id();
        let line = scene.plane_lines(xy, None)[0].clone();
        assert_eq!(
            scene.plane_line_position(xy, SpatialAxis::X, line.from[0], None),
            Some(48)
        );
        let left = scene
            .plane_line_position(xy, SpatialAxis::X, 0.2, None)
            .unwrap();
        let right = scene
            .plane_line_position(xy, SpatialAxis::X, 0.8, None)
            .unwrap();
        assert!(left < 48 && right > 48);
        // XY draws no Z to drag.
        assert_eq!(
            scene.plane_line_position(xy, SpatialAxis::Z, 0.5, None),
            None
        );
        // Set from a drag, the place moves every view and every line.
        apply(&mut scene, ViewportCommand::SetX { x: right });
        let xz = scene.views()[2].id();
        let moved = scene.plane_lines(xz, None)[0].from[0];
        assert!(moved > line.from[0]);
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

    /// Six tiles of a collection 64 wide, 32 tall and 16 deep, three across
    /// and two down with a gap of 8, four-up.
    fn four_up_tiles() -> Scene {
        use super::super::test_helpers::make_collection_dataset_opened;
        let ids = ["t0", "t1", "t2", "t3", "t4", "t5"];
        let members = ids
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, [(i % 3) as f64 * 72.0, (i / 3) as f64 * 40.0]))
            .collect();
        let mut scene = Scene::new([800, 600]);
        let opened = make_collection_dataset_opened(
            "tiles",
            "tiles",
            members,
            [1, 1, 16, 32, 64],
            [1, 1, 8, 8, 32],
        );
        scene.apply(DocumentCommand::DatasetOpened(opened).into());
        let layout = ViewLayout::FourUp;
        apply(&mut scene, ViewportCommand::SetViewLayout { layout });
        scene
    }

    fn tile(index: usize) -> PlaneTile {
        PlaneTile {
            dataset: DatasetId::from("tiles"),
            entity: lucida_content::EntityId(format!("t{index}")),
        }
    }

    /// Where a slice view's two lines cross, as fractions of the view.
    fn crossing(lines: &[PlaneLine]) -> [f64; 2] {
        [lines[0].from[0], lines[1].from[1]]
    }

    /// The middle of the outline of the plane across Z, as fractions of the
    /// view.
    fn z_outline_middle(lines: &[PlaneLine]) -> [f64; 2] {
        let z: Vec<&PlaneLine> = lines.iter().filter(|l| l.axis == SpatialAxis::Z).collect();
        let n = z.len() as f64;
        [0, 1].map(|i| z.iter().map(|l| l.from[i]).sum::<f64>() / n)
    }

    fn slice_of(scene: &Scene, index: usize) -> Slice {
        match &scene.views()[index].camera {
            Camera::Slice(slice) => slice.clone(),
            other => panic!("a slice camera, not {other:?}"),
        }
    }

    #[test]
    fn the_lines_stand_on_the_named_tile_and_on_the_first_without_one() {
        let scene = four_up_tiles();
        for (index, view) in scene.views().iter().enumerate() {
            let id = view.id();
            assert_eq!(
                scene.plane_lines(id, None),
                scene.plane_lines(id, Some(&tile(0))),
                "view {index}"
            );
            for k in 0..6 {
                let lines = scene.plane_lines(id, Some(&tile(k)));
                // Where they cross, or the middle of the volume's outline,
                // is over the tile they stand on.
                let at = match index {
                    3 => z_outline_middle(&lines),
                    _ => crossing(&lines),
                };
                assert_eq!(
                    scene.tile_at(id, at),
                    Some(tile(k)),
                    "view {index}, tile {k}"
                );
            }
        }
        // A tile no view shows leaves the lines on the first.
        let elsewhere = PlaneTile {
            dataset: DatasetId::from("gone"),
            entity: lucida_content::EntityId("t4".into()),
        };
        let xy = scene.views()[0].id();
        assert_eq!(
            scene.plane_lines(xy, Some(&elsewhere)),
            scene.plane_lines(xy, None)
        );
    }

    #[test]
    fn every_tile_draws_its_lines_at_one_place_from_its_own_edge() {
        let scene = four_up_tiles();
        let [width, height] = [400.0, 300.0];
        // XY places the tiles by their layout: the middle tile of the second
        // row is one column and one row from the first.
        let xy = slice_of(&scene, 0);
        let on_xy = |k| crossing(&scene.plane_lines(scene.views()[0].id(), Some(&tile(k))));
        let step = |slice: &Slice, by: [f64; 2]| {
            let [a, b] = [slice.to_screen([0.0, 0.0]), slice.to_screen(by)];
            [(b[0] - a[0]) / width, (b[1] - a[1]) / height]
        };
        let [first, middle] = [on_xy(0), on_xy(4)];
        let moved = step(&xy, [72.0, 40.0]);
        for i in 0..2 {
            assert!((middle[i] - first[i] - moved[i]).abs() < 1e-9, "{middle:?}");
        }
        // XZ stacks rows as deep as a tile, so a row down is 20 along Z.
        let xz = slice_of(&scene, 2);
        let on_xz = |k| crossing(&scene.plane_lines(scene.views()[2].id(), Some(&tile(k))));
        let [first, middle] = [on_xz(0), on_xz(4)];
        let moved = step(&xz, [72.0, 20.0]);
        for i in 0..2 {
            assert!((middle[i] - first[i] - moved[i]).abs() < 1e-9, "{middle:?}");
        }
    }

    #[test]
    fn a_drag_on_any_tile_moves_the_cut_of_every_tile() {
        let mut scene = four_up_tiles();
        let xy = scene.views()[0].id();
        let before = scene.axis_index(xy, SpatialAxis::X);
        let [first, middle] = [0, 4].map(|k| scene.plane_lines(xy, Some(&tile(k)))[0].from[0]);
        let drag = |scene: &Scene, k: usize, fraction: f64| {
            scene.plane_line_position(xy, SpatialAxis::X, fraction, Some(&tile(k)))
        };
        // Taking a line where it stands keeps the cut where it is.
        assert_eq!(drag(&scene, 4, middle), Some(before));
        // The same move on either tile sets the same position.
        let to = drag(&scene, 4, middle + 0.02).unwrap();
        assert!(to > before);
        assert_eq!(drag(&scene, 0, first + 0.02), Some(to));
        apply(&mut scene, ViewportCommand::SetX { x: to });
        let [first_now, middle_now] =
            [0, 4].map(|k| scene.plane_lines(xy, Some(&tile(k)))[0].from[0]);
        assert!(first_now > first);
        assert!((middle_now - middle - (first_now - first)).abs() < 1e-9);
    }

    #[test]
    fn no_tile_lies_between_tiles_or_in_a_single_image() {
        let scene = four_up_tiles();
        let xy = scene.views()[0].id();
        // The gap between the first two tiles, on the first row.
        let xy_slice = slice_of(&scene, 0);
        let [gx, gy] = xy_slice.to_screen([68.0, 16.0]);
        assert_eq!(scene.tile_at(xy, [gx / 400.0, gy / 300.0]), None);
        let single = four_up();
        for view in single.views() {
            assert_eq!(single.tile_at(view.id(), [0.5, 0.5]), None);
            assert_eq!(
                single.plane_lines(view.id(), Some(&tile(4))),
                single.plane_lines(view.id(), None)
            );
        }
    }
}
