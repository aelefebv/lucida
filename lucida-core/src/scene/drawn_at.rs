//! Which layers a view draws at a point of its screen, what a mark placed
//! there can land on, and where a view draws a mark. Each view shows its own
//! datasets, so the same point of the canvas lands on different data in
//! different views. A side view of a collection draws each tile in a cell of
//! its own, so it draws a mark moved into its tile's cell.

use lucida_content::{DatasetId, EntityId};

use crate::camera::Camera;
use crate::slice_plane::SlicePlane;
use crate::view::ViewId;

use super::placement::placing_plane;
use super::{CutReach, DatasetDerivedState, MemberState, Scene};

/// A mark, as what says which tile it is drawn on: the tile it is glued to,
/// or for one with no anchor, such as a shape still being drawn, the tile its
/// first vertex lies on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MarkOn<'a> {
    /// The mark's first vertex, a point of its dataset's frame.
    pub start: [f64; 3],
    /// The tile it is glued to, its [`super::Annotation::anchor`].
    pub anchor: Option<&'a EntityId>,
}

impl MarkOn<'_> {
    /// A mark with no anchor yet, whose first vertex is `start`.
    pub fn at(start: [f64; 3]) -> MarkOn<'static> {
        MarkOn {
            start,
            anchor: None,
        }
    }
}

impl DatasetDerivedState {
    /// The member `mark` is drawn on: the tile it is glued to, found by id,
    /// or else the one its first vertex lies on ([`Self::member_holding`]).
    /// A mark drawn every frame is glued to its tile, so finding it costs
    /// the same however many tiles the collection has.
    fn member_of(&self, mark: MarkOn) -> Option<&MemberState> {
        mark.anchor
            .and_then(|anchor| self.member_by_id(&anchor.0))
            .or_else(|| self.member_holding(mark.start))
    }
}

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

    /// How far `view` draws `mark`, of `dataset_id`, from where the
    /// dataset's placement puts it, `[x, y, z]` in its samples. A side view
    /// of a collection draws the mark in the cell of its tile
    /// ([`MarkOn`]), and every vertex by the same shift, so a shape stays
    /// whole. Every other view draws the frame in place, and an unknown view
    /// or dataset moves nothing.
    pub fn annotation_shift(&self, view: ViewId, dataset_id: &DatasetId, mark: MarkOn) -> [f64; 3] {
        self.cell_plane(view, dataset_id)
            .and_then(|(derived, plane)| Some(derived.plane_shift(plane, derived.member_of(mark)?)))
            .unwrap_or([0.0; 3])
    }

    /// The shift of the tile `view` draws at `drawn`, a point of
    /// `dataset_id`'s frame as the view places it: what a mark started
    /// there takes. Nothing where the view draws the frame in place, and
    /// `None` where a side view of a collection draws no tile there.
    pub(super) fn shift_drawn_at(
        &self,
        view: ViewId,
        dataset_id: &DatasetId,
        drawn: [f64; 3],
    ) -> Option<[f64; 3]> {
        let Some((derived, plane)) = self.cell_plane(view, dataset_id) else {
            return Some([0.0; 3]);
        };
        let member = derived.member_drawn_at(plane, drawn)?;
        Some(derived.plane_shift(plane, member))
    }

    /// The plane `view` lays `dataset_id`'s tiles out on, each in a cell of
    /// its own, with the dataset's derived state: a side view's, of a
    /// collection whose placement keeps the cut. `None` where the view draws
    /// the frame in place.
    fn cell_plane(
        &self,
        view: ViewId,
        dataset_id: &DatasetId,
    ) -> Option<(&DatasetDerivedState, SlicePlane)> {
        let derived = self.derived.get(dataset_id)?;
        derived.tile_cells?;
        let plane = placing_plane(self.view(view)?, &self.placement(dataset_id)?);
        (!plane.is_xy()).then_some((derived, plane))
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::{DatasetId, PhysicalSpace, SpatialAxis};

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

    /// Six tiles of a collection 64 wide, 32 tall and 16 deep, three across
    /// and two down with a gap of 8, in one view cutting `plane`, a side
    /// view standing at each tile's plane 10.
    fn tiles(plane: SlicePlane) -> Scene {
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
        apply(&mut scene, ViewportCommand::SetSlicePlane { plane });
        match plane {
            SlicePlane::Xy => {}
            SlicePlane::Xz => apply(&mut scene, ViewportCommand::SetY { y: 10 }),
            SlicePlane::Yz => apply(&mut scene, ViewportCommand::SetX { x: 10 }),
        }
        scene
    }

    fn tiles_id() -> DatasetId {
        DatasetId::from("tiles")
    }

    /// Where the active slice view draws the sample `local`, `[x, y, z]`
    /// from the corner of the tile `entity`, in screen pixels: in the tile's
    /// cell, as the renderer places it, its place along the cut ignored.
    fn drawn(scene: &Scene, entity: &str, local: [f64; 3]) -> [f64; 2] {
        let view = scene.active_view();
        let Camera::Slice(slice) = &view.camera else {
            panic!("a slice view");
        };
        let id = tiles_id();
        let (_, cell) = scene
            .plane_positions(view.id(), &id)
            .into_iter()
            .find(|(e, _)| e.0 == entity)
            .unwrap();
        let [across, down, _] = slice.plane.axes().map(SpatialAxis::xyz);
        let mut point = [0.0; 3];
        point[across] = cell[0] + local[across];
        point[down] = cell[1] + local[down];
        let placed = scene.placement(&id).unwrap().apply(point);
        slice.to_screen([placed[across], placed[down]])
    }

    /// The tile of the collection under screen pixels `at` in the active view.
    fn tile_under(scene: &Scene, at: [f64; 2]) -> Option<String> {
        let view = scene.active_view().id();
        let tile = scene.tile_at(view, [at[0] / 800.0, at[1] / 600.0])?;
        Some(tile.entity.0)
    }

    fn close(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(a, b)| (a - b).abs() < 1e-6)
    }

    #[test]
    fn a_mark_placed_on_a_tile_in_a_side_view_lands_on_its_samples() {
        for plane in [SlicePlane::Xz, SlicePlane::Yz] {
            let mut scene = tiles(plane);
            let (view, id) = (scene.active_view().id(), tiles_id());
            // The middle tile of the second row starts at (72, 40). Placed
            // 20 across, 12 down and 5 deep into it, on the plane the view
            // cuts, the middle of the tile's plane 10.
            let at = drawn(&scene, "t4", [20.5, 12.5, 5.5]);
            assert_eq!(tile_under(&scene, at).as_deref(), Some("t4"), "{plane}");
            let point = scene
                .pick_annotation_voxel(view, &id, at[0], at[1], None)
                .unwrap();
            let expected = match plane {
                SlicePlane::Xz => [92.5, 50.5, 5.5],
                _ => [82.5, 52.5, 5.5],
            };
            assert!(close(&point, &expected), "{plane}: {point:?}");
            let holder = scene.derived[&id].member_holding(point).unwrap();
            assert_eq!(holder.entity_id.0, "t4", "{plane}");
            // It draws where it was placed, and going to it stands here.
            let back = scene
                .project_annotation(view, &id, point[0], point[1], point[2])
                .unwrap();
            assert!(close(&back, &at), "{plane}: {back:?} against {at:?}");
            let cut = scene.annotation_cut(view, &id, MarkOn::at(point)).unwrap();
            assert_eq!(cut.position, scene.axis_index(view, plane.cut()), "{plane}");

            // XY draws it over the same tile, as does the volume.
            apply(
                &mut scene,
                ViewportCommand::SetSlicePlane {
                    plane: SlicePlane::Xy,
                },
            );
            let on_xy = scene
                .project_annotation(view, &id, point[0], point[1], point[2])
                .unwrap();
            let local = [point[0] - 72.0, point[1] - 40.0, point[2]];
            assert!(
                close(&on_xy, &drawn(&scene, "t4", local)),
                "{plane}: {on_xy:?}"
            );
            assert_eq!(tile_under(&scene, on_xy).as_deref(), Some("t4"), "{plane}");
            let again = scene
                .pick_annotation_voxel(view, &id, on_xy[0], on_xy[1], None)
                .unwrap();
            assert!(close(&again[..2], &point[..2]), "{plane}: {again:?}");
            scene.set_mode_3d();
            let in_volume = scene
                .project_annotation(view, &id, point[0], point[1], point[2])
                .unwrap();
            assert_eq!(
                tile_under(&scene, in_volume).as_deref(),
                Some("t4"),
                "{plane}"
            );
        }
    }

    #[test]
    fn a_shape_in_a_side_view_keeps_every_vertex_on_its_first_vertexs_tile() {
        let scene = tiles(SlicePlane::Xz);
        let (view, id) = (scene.active_view().id(), tiles_id());
        // Started on the second tile, which a side view draws above the
        // middle tile of the second row, and dragged down into that one's
        // cell, 25 deep from the second tile's top, past its 16 planes.
        let from = drawn(&scene, "t1", [10.5, 0.0, 3.5]);
        let to = drawn(&scene, "t1", [40.5, 0.0, 25.5]);
        assert_eq!(tile_under(&scene, to).as_deref(), Some("t4"));
        let start = scene
            .pick_annotation_voxel(view, &id, from[0], from[1], None)
            .unwrap();
        let end = scene
            .pick_annotation_voxel(view, &id, to[0], to[1], Some(MarkOn::at(start)))
            .unwrap();
        assert!(close(&start, &[82.5, 10.5, 3.5]), "{start:?}");
        assert!(close(&end, &[112.5, 10.5, 25.5]), "{end:?}");
        // Both draw by the first vertex's shift, so the shape stays whole.
        let shift = scene.annotation_shift(view, &id, MarkOn::at(start));
        assert_eq!(shift, scene.annotation_shift(view, &id, MarkOn::at(end)));
        for (vertex, pointer) in [(start, from), (end, to)] {
            let back = scene
                .project_annotation(view, &id, vertex[0], vertex[1], vertex[2])
                .unwrap();
            assert!(close(&back, &pointer), "{back:?} against {pointer:?}");
        }
        // The same pointer starting a mark lands on the tile under it.
        let fresh = scene
            .pick_annotation_voxel(view, &id, to[0], to[1], None)
            .unwrap();
        assert!(close(&fresh, &[112.5, 50.5, 5.5]), "{fresh:?}");
    }

    #[test]
    fn a_mark_placed_in_xy_draws_in_its_tiles_cell_in_each_side_view() {
        let mut scene = tiles(SlicePlane::Xy);
        let (view, id) = (scene.active_view().id(), tiles_id());
        let at = drawn(&scene, "t4", [30.5, 12.5, 0.0]);
        let placed = scene
            .pick_annotation_voxel(view, &id, at[0], at[1], None)
            .unwrap();
        assert!(close(&placed[..2], &[102.5, 52.5]), "{placed:?}");
        for plane in [SlicePlane::Xz, SlicePlane::Yz] {
            apply(&mut scene, ViewportCommand::SetSlicePlane { plane });
            // Going to it stands the view on the tile's plane it lies on.
            let cut = scene.annotation_cut(view, &id, MarkOn::at(placed)).unwrap();
            let position = cut.position;
            apply(
                &mut scene,
                match plane {
                    SlicePlane::Xz => ViewportCommand::SetY { y: position },
                    _ => ViewportCommand::SetX { x: position },
                },
            );
            let layer = scene.resolved_layer(view, &id).unwrap();
            assert_eq!(
                layer.cut(plane),
                [12..13, 30..31][usize::from(plane == SlicePlane::Yz)]
            );
            // There it draws in the tile's cell, and a pick there finds it.
            let screen = scene
                .project_annotation(view, &id, placed[0], placed[1], placed[2])
                .unwrap();
            let expected = drawn(&scene, "t4", [30.5, 12.5, placed[2]]);
            assert!(
                close(&screen, &expected),
                "{plane}: {screen:?} against {expected:?}"
            );
            assert_eq!(tile_under(&scene, screen).as_deref(), Some("t4"), "{plane}");
            let again = scene
                .pick_annotation_voxel(view, &id, screen[0], screen[1], None)
                .unwrap();
            assert!(
                close(&again, &placed),
                "{plane}: {again:?} against {placed:?}"
            );
        }
    }

    #[test]
    fn a_pick_between_cells_lands_only_on_a_mark_it_belongs_to() {
        let scene = tiles(SlicePlane::Xz);
        let (view, id) = (scene.active_view().id(), tiles_id());
        // Between the first two cells of the first row.
        let gap = drawn(&scene, "t0", [68.0, 0.0, 4.0]);
        assert_eq!(tile_under(&scene, gap), None);
        assert_eq!(
            scene.pick_annotation_voxel(view, &id, gap[0], gap[1], None),
            None
        );
        let start = [10.5, 10.5, 2.5];
        let end = scene
            .pick_annotation_voxel(view, &id, gap[0], gap[1], Some(MarkOn::at(start)))
            .unwrap();
        assert!(close(&end, &[68.0, 10.5, 4.0]), "{end:?}");
    }

    #[test]
    fn a_mark_draws_on_the_tile_it_is_glued_to() {
        let scene = tiles(SlicePlane::Xz);
        let (view, id) = (scene.active_view().id(), tiles_id());
        // A first vertex on the second tile, of a mark glued to the middle
        // tile of the second row, as a mark in a gap can be after a layout
        // switch.
        let start = [82.5, 10.5, 3.5];
        let t4 = lucida_content::EntityId("t4".into());
        let glued = MarkOn {
            start,
            anchor: Some(&t4),
        };
        let on_t4 = scene.annotation_shift(view, &id, MarkOn::at([92.5, 50.5, 0.5]));
        assert_eq!(scene.annotation_shift(view, &id, glued), on_t4);
        assert_ne!(scene.annotation_shift(view, &id, MarkOn::at(start)), on_t4);
        // A pick for it lands through the same tile.
        let at = drawn(&scene, "t4", [40.5, 0.0, 9.5]);
        let point = scene
            .pick_annotation_voxel(view, &id, at[0], at[1], Some(glued))
            .unwrap();
        assert!(close(&point, &[112.5, 50.5, 9.5]), "{point:?}");
        // An anchor that names no tile falls back to the tile under the start.
        let gone = lucida_content::EntityId("gone".into());
        let lost = MarkOn {
            start,
            anchor: Some(&gone),
        };
        assert_eq!(
            scene.annotation_shift(view, &id, lost),
            scene.annotation_shift(view, &id, MarkOn::at(start))
        );
    }

    #[test]
    fn only_a_side_view_of_a_collection_moves_a_mark() {
        let point = [102.5, 52.5, 3.5];
        let mut scene = tiles(SlicePlane::Xy);
        let (view, id) = (scene.active_view().id(), tiles_id());
        assert_eq!(
            scene.annotation_shift(view, &id, MarkOn::at(point)),
            [0.0; 3]
        );
        scene.set_mode_3d();
        assert_eq!(
            scene.annotation_shift(view, &id, MarkOn::at(point)),
            [0.0; 3]
        );
        let mut single = Scene::new([800, 600]);
        open(&mut single, "a", [16, 64, 64]);
        let plane = SlicePlane::Xz;
        apply(&mut single, ViewportCommand::SetSlicePlane { plane });
        let view = single.active_view().id();
        assert_eq!(
            single.annotation_shift(view, &DatasetId::from("a"), MarkOn::at(point)),
            [0.0; 3]
        );
        assert_eq!(
            single.annotation_shift(ViewId(99), &id, MarkOn::at(point)),
            [0.0; 3]
        );
    }
}
