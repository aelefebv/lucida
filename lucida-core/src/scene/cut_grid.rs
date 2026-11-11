//! The positions a view steps through along an axis it cuts. One grid over
//! the scene frame serves every layer the view shows, at the finest spacing
//! among them, so a position names one place for all of them and each layer
//! reads its own plane there.

use std::ops::Range;

use lucida_content::{DatasetId, SpatialAxis};
use serde::Serialize;

use super::placement::plane_span;
use super::{LayerExtent, Scene};
use crate::view::{AxisPositions, ViewId};

/// The positions along one axis of a view: `count` of them, each `step`
/// long in the scene frame's units, from `min`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CutGrid {
    pub min: f64,
    pub step: f64,
    pub count: u32,
}

impl CutGrid {
    /// One position at the origin, for a view showing nothing.
    pub const EMPTY: CutGrid = CutGrid {
        min: 0.0,
        step: 1.0,
        count: 1,
    };

    /// The places position `index` covers.
    pub fn cell(&self, index: u32) -> Range<f64> {
        let start = self.min + f64::from(index) * self.step;
        start..start + self.step
    }

    /// The place in the middle of position `index`, where a cut through it
    /// reads each layer.
    pub fn center(&self, index: u32) -> f64 {
        self.min + (f64::from(index) + 0.5) * self.step
    }

    /// The cell of this grid's spacing that holds `place`, counted on past
    /// either end, so a place past the grid stays past it.
    pub fn cell_at(&self, place: f64) -> Range<f64> {
        let start = self.min + ((place - self.min) / self.step).floor() * self.step;
        start..start + self.step
    }

    /// The position holding `place`, or the nearest end for a place past
    /// either.
    pub fn index_of(&self, place: f64) -> u32 {
        let index = ((place - self.min) / self.step).floor();
        index.clamp(0.0, f64::from(self.count - 1)) as u32
    }
}

/// Where a view stands along one axis, as a person reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AxisReading {
    /// The axis the view stands along.
    pub axis: SpatialAxis,
    /// The position on the view's grid, from 0.
    pub position: u32,
    /// How many positions the grid has.
    pub count: u32,
    /// The place in the scene frame, the middle of the position's cell.
    pub place: f64,
    /// The place as a physical coordinate, such as `48.5 \u{b5}m`, when the
    /// scene frame measures lengths.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<String>,
    /// The characters the longer of the grid's two end coordinates takes, so
    /// a readout can hold one width as the position moves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_width: Option<usize>,
}

impl Scene {
    /// Where `view` stands along the axis its slice plane cuts.
    pub fn cut_reading(&self, view: ViewId) -> AxisReading {
        let axis = self
            .view(view)
            .map_or(SpatialAxis::Z, |v| v.slice_plane().cut());
        self.axis_reading(view, axis)
    }

    /// Where `view` stands along `axis`: its position on its grid and the
    /// place, in the scene frame's units and, when the frame measures them,
    /// as a physical coordinate against the origins datasets declare.
    pub fn axis_reading(&self, view: ViewId, axis: SpatialAxis) -> AxisReading {
        let grid = self.cut_grid(view, axis);
        let place = self.cut_place(view, axis);
        let frame = self.scene_frame();
        let label = |place: f64| {
            let (meters, unit) = frame.as_ref()?.place_meters(axis.xyz(), place)?;
            Some(super::scale_bar::coordinate_label(meters, grid.step * unit))
        };
        let ends = [grid.center(0), grid.center(grid.count - 1)];
        AxisReading {
            axis,
            position: grid.index_of(place),
            count: grid.count,
            place,
            length: label(place),
            length_width: ends
                .into_iter()
                .filter_map(label)
                .map(|end| end.chars().count())
                .max(),
        }
    }

    /// The positions `view` steps through cutting `axis`: a grid at the
    /// finest placed sample spacing among the visible layers it shows, over
    /// the union of where they lie, so it reaches before the first dataset's
    /// origin as well as past it. Along Z a layer one plane deep is left out
    /// while a deeper one shows, since it draws at every Z. A view showing
    /// nothing has one position at the origin.
    pub fn cut_grid(&self, view: ViewId, axis: SpatialAxis) -> CutGrid {
        let a = axis.xyz();
        let mut layers: Vec<(f64, (f64, f64), u32)> = self
            .shown_dataset_ids(view)
            .filter_map(|id| {
                let spacing = self.placement(id)?.step_along(a);
                let span = self.cut_span(id, axis)?;
                let planes = LayerExtent::of(self.document.manifests.get(id)?).along(axis);
                (spacing.is_finite() && spacing > 0.0).then_some((spacing, span, planes))
            })
            .collect();
        if axis.is_z() && layers.iter().any(|(_, _, planes)| *planes > 1) {
            layers.retain(|(_, _, planes)| *planes > 1);
        }
        let Some(step) = layers
            .iter()
            .map(|(spacing, _, _)| *spacing)
            .reduce(f64::min)
        else {
            return CutGrid::EMPTY;
        };
        let (min, max) = layers
            .iter()
            .map(|(_, span, _)| *span)
            .reduce(|(lo, hi), (min, max)| (lo.min(min), hi.max(max)))
            .expect("a step means a layer");
        // An edge a rounding error puts just past a whole step stays on it.
        let steps = (max - min) / step;
        let count = (steps - steps.abs() * 1e-12).ceil();
        CutGrid {
            min,
            step,
            count: count.clamp(1.0, f64::from(u32::MAX)) as u32,
        }
    }

    /// `dataset_id`'s own planes along `axis` as positions of the scene
    /// frame, one each, for a view of it alone. `None` for a dataset the
    /// scene doesn't hold.
    pub fn plane_grid(&self, dataset_id: &DatasetId, axis: SpatialAxis) -> Option<CutGrid> {
        let a = axis.xyz();
        let to_scene = self.placement(dataset_id)?;
        let step = to_scene.step_along(a);
        let planes = LayerExtent::of(self.document.manifests.get(dataset_id)?).along(axis);
        if let Some((min, _)) = plane_span(&to_scene, a, planes) {
            return Some(CutGrid {
                min,
                step,
                count: planes,
            });
        }
        // A dataset turned off the axis has no planes across it, so a view
        // of it alone steps through its extent at its sample's reach.
        let (min, max) = self.scene_extent(dataset_id, axis)?;
        let steps = if step > 0.0 {
            ((max - min) / step).ceil()
        } else {
            1.0
        };
        Some(CutGrid {
            min,
            step,
            count: steps.clamp(1.0, f64::from(u32::MAX)) as u32,
        })
    }

    /// The place `view` cuts `axis` at: its axis position, or with none yet,
    /// the middle of the grid's first position.
    pub fn cut_place(&self, view: ViewId, axis: SpatialAxis) -> f64 {
        let placed = self.view(view).and_then(|v| v.axes.place(axis));
        placed.unwrap_or_else(|| self.cut_grid(view, axis).center(0))
    }

    /// The places along `axis` `view` reads, `(start, end)`: its Z slab, or
    /// across another axis the position of its grid it stands at.
    pub(crate) fn cut_slab(&self, view: ViewId, axis: SpatialAxis) -> (f64, f64) {
        if axis.is_z() {
            let z = self.view(view).map_or_else(
                || self.cut_grid(view, axis).cell(0),
                |shown| self.z_cut(view, &shown.axes),
            );
            return (z.start, z.end);
        }
        let place = self.cut_place(view, axis);
        let half = self.cut_grid(view, axis).step / 2.0;
        (place - half, place + half)
    }

    /// The places `view` cuts along Z: its slab, or with none yet, the
    /// grid's first position.
    pub(crate) fn z_cut(&self, view: ViewId, axes: &AxisPositions) -> Range<f64> {
        axes.z
            .clone()
            .unwrap_or_else(|| self.cut_grid(view, SpatialAxis::Z).cell(0))
    }

    /// Where `view` stands along its slice plane's cut axis, on its grid.
    pub fn cut_index(&self, view: ViewId) -> u32 {
        self.view(view)
            .map_or(0, |shown| self.axis_index(view, shown.slice_plane().cut()))
    }

    /// Where `view` stands along `axis`, on its grid.
    pub fn axis_index(&self, view: ViewId, axis: SpatialAxis) -> u32 {
        self.cut_grid(view, axis)
            .index_of(self.cut_place(view, axis))
    }

    /// Stand `view` at position `index` of its grid along `axis`, as one
    /// cut. A position past the grid is a place past every layer, which
    /// each says it is outside.
    pub(crate) fn set_cut_position(&mut self, view: ViewId, axis: SpatialAxis, index: u32) {
        let grid = self.cut_grid(view, axis);
        let Some(shown) = self.view_mut(view) else {
            return;
        };
        match axis {
            SpatialAxis::Z => shown.axes.z = Some(grid.cell(index)),
            SpatialAxis::Y => shown.axes.y = Some(grid.center(index)),
            SpatialAxis::X => shown.axes.x = Some(grid.center(index)),
        }
    }

    /// Stand `view` across positions `indices` of its Z grid, a slab.
    pub(crate) fn set_z_positions(&mut self, view: ViewId, indices: Range<u32>) {
        let grid = self.cut_grid(view, SpatialAxis::Z);
        let last = indices.end.max(indices.start.saturating_add(1)) - 1;
        if let Some(shown) = self.view_mut(view) {
            shown.axes.z = Some(grid.cell(indices.start).start..grid.cell(last).end);
        }
    }

    /// The place in the middle of what `view` shows along `axis`: the middle
    /// of its grid's middle position.
    pub(crate) fn cut_middle(&self, view: ViewId, axis: SpatialAxis) -> f64 {
        let grid = self.cut_grid(view, axis);
        grid.center(grid.count / 2)
    }

    /// `axes` with a slab recorded before positions were places turned into
    /// the places it named in this scene's frame. Without a frame there is
    /// nothing it can name, and the view stands at the grid's first
    /// position.
    pub(crate) fn place_legacy_axes(&self, axes: &mut AxisPositions) {
        match self.scene_frame() {
            Some(frame) => axes.place_legacy_z(&frame),
            None => axes.legacy_z_range = None,
        }
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::PhysicalSpace;

    use super::super::test_helpers::{
        make_collection_dataset_opened, make_dataset_opened_with_shape,
    };
    use super::*;
    use crate::command::{Command, DocumentCommand, ViewportCommand};
    use crate::scene::CutReach;
    use crate::slice_plane::SlicePlane;

    /// An image of `shape` `[z, y, x]` samples, each `spacing` `[z, y, x]`
    /// micrometers long, with its origin at `origin` `[z, y, x]`.
    fn open(scene: &mut Scene, id: &str, shape: [u64; 3], spacing: [f64; 3], origin: [f64; 3]) {
        let [z, y, x] = shape;
        let mut opened =
            make_dataset_opened_with_shape(id, id, 1, [1, 1, z, y, x], [1, 1, 16, 64, 64], 1);
        for image in opened.manifest.images_mut() {
            image.multiscale.levels[0].scale = [1.0, 1.0, spacing[0], spacing[1], spacing[2]];
        }
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

    /// The plane `id` draws where the active view stands along `plane`'s cut,
    /// or `None` where the cut misses it.
    fn drawn(scene: &Scene, id: &str, plane: SlicePlane) -> Option<u32> {
        let layer = scene
            .resolved_layer(scene.active_view().id(), &DatasetId::from(id))
            .unwrap();
        (layer.reach(plane) != CutReach::Outside).then(|| layer.cut(plane).start)
    }

    fn grid(scene: &Scene, axis: SpatialAxis) -> CutGrid {
        scene.cut_grid(scene.active_view().id(), axis)
    }

    #[test]
    fn a_grid_names_each_position_by_its_places() {
        let grid = CutGrid {
            min: -4.0,
            step: 2.0,
            count: 5,
        };
        assert_eq!(grid.cell(0), -4.0..-2.0);
        assert_eq!(grid.center(2), 1.0);
        assert_eq!(grid.index_of(1.0), 2);
        assert_eq!(grid.index_of(grid.center(4)), 4);
        // A place past either end reads as the nearest position.
        assert_eq!(grid.index_of(-100.0), 0);
        assert_eq!(grid.index_of(100.0), 4);
    }

    #[test]
    fn a_reading_names_the_position_and_the_physical_place() {
        // The second dataset starts 1 mm down; the first fixes the frame.
        let mut scene = Scene::new([800, 600]);
        open(
            &mut scene,
            "a",
            [40, 64, 64],
            [2.0, 1.0, 1.0],
            [1000.0, 0.0, 0.0],
        );
        apply(&mut scene, ViewportCommand::SetZ { z: 3 });
        let reading = scene.axis_reading(scene.active_view().id(), SpatialAxis::Z);
        assert_eq!(
            (reading.position, reading.count, reading.place),
            (3, 40, 7.0)
        );
        assert_eq!(reading.length.as_deref(), Some("1.0070 mm"));
        assert_eq!(reading.length_width, Some(9));
        let plane = SlicePlane::Xz;
        apply(&mut scene, ViewportCommand::SetSlicePlane { plane });
        let reading = scene.axis_reading(scene.active_view().id(), SpatialAxis::Y);
        assert_eq!(reading.length.as_deref(), Some("32.5 \u{b5}m"));
    }

    #[test]
    fn a_frame_without_lengths_reads_no_physical_place() {
        let mut scene = Scene::new([800, 600]);
        let image =
            make_dataset_opened_with_shape("i", "i", 1, [1, 1, 8, 8, 8], [1, 1, 8, 8, 8], 1);
        scene.apply(DocumentCommand::DatasetOpened(image).into());
        let reading = scene.axis_reading(scene.active_view().id(), SpatialAxis::Z);
        assert_eq!(
            (reading.position, reading.count, reading.length),
            (0, 8, None)
        );
    }

    #[test]
    fn one_dataset_steps_through_its_own_planes() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [40, 64, 64], [2.0, 1.0, 1.0], [0.0; 3]);
        let z = grid(&scene, SpatialAxis::Z);
        assert_eq!((z.min, z.step, z.count), (0.0, 2.0, 40));
        apply(&mut scene, ViewportCommand::SetZ { z: 17 });
        assert_eq!(drawn(&scene, "a", SlicePlane::Xy), Some(17));
        assert_eq!(
            scene.axis_index(scene.active_view().id(), SpatialAxis::Z),
            17
        );
        // With nothing placed, the first plane.
        apply(&mut scene, ViewportCommand::SetT { t: 0 });
        let mut fresh = Scene::new([800, 600]);
        open(&mut fresh, "a", [40, 64, 64], [2.0, 1.0, 1.0], [0.0; 3]);
        assert_eq!(drawn(&fresh, "a", SlicePlane::Xy), Some(0));
    }

    #[test]
    fn volumes_offset_in_z_cut_one_depth_and_say_where_they_are_missed() {
        // Each 40 micrometers deep, the second starting half way down the first.
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [40, 64, 64], [1.0; 3], [0.0; 3]);
        open(&mut scene, "b", [40, 64, 64], [1.0; 3], [20.0, 0.0, 0.0]);
        let z = grid(&scene, SpatialAxis::Z);
        assert_eq!((z.min, z.step, z.count), (0.0, 1.0, 60));
        apply(&mut scene, ViewportCommand::SetZ { z: 10 });
        assert_eq!(drawn(&scene, "a", SlicePlane::Xy), Some(10));
        assert_eq!(drawn(&scene, "b", SlicePlane::Xy), None);
        // 30.5 micrometers down: plane 30 of the first, plane 10 of the second.
        apply(&mut scene, ViewportCommand::SetZ { z: 30 });
        assert_eq!(drawn(&scene, "a", SlicePlane::Xy), Some(30));
        assert_eq!(drawn(&scene, "b", SlicePlane::Xy), Some(10));
        apply(&mut scene, ViewportCommand::SetZ { z: 50 });
        assert_eq!(drawn(&scene, "a", SlicePlane::Xy), None);
        assert_eq!(drawn(&scene, "b", SlicePlane::Xy), Some(30));
    }

    #[test]
    fn the_grid_steps_at_the_finest_spacing_and_a_coarse_layer_reads_one_plane() {
        let mut scene = Scene::new([800, 600]);
        open(
            &mut scene,
            "coarse",
            [20, 64, 64],
            [2.0, 1.0, 1.0],
            [0.0; 3],
        );
        open(&mut scene, "fine", [40, 64, 64], [1.0; 3], [0.0; 3]);
        let z = grid(&scene, SpatialAxis::Z);
        assert_eq!((z.step, z.count), (1.0, 40));
        apply(&mut scene, ViewportCommand::SetZ { z: 21 });
        assert_eq!(drawn(&scene, "fine", SlicePlane::Xy), Some(21));
        let coarse = scene
            .resolved_layer(scene.active_view().id(), &DatasetId::from("coarse"))
            .unwrap();
        assert_eq!(coarse.z_range, 10..11);
        // A slab across four fine planes takes the two coarse planes in it.
        apply(
            &mut scene,
            ViewportCommand::SetZRange { start: 20, end: 24 },
        );
        let layer = |id: &str| {
            scene
                .resolved_layer(scene.active_view().id(), &DatasetId::from(id))
                .unwrap()
                .z_range
        };
        assert_eq!((layer("fine"), layer("coarse")), (20..24, 10..12));
    }

    #[test]
    fn a_side_view_cuts_a_dataset_placed_before_the_first_ones_origin() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [8, 64, 64], [1.0; 3], [0.0; 3]);
        open(
            &mut scene,
            "before",
            [8, 64, 64],
            [1.0; 3],
            [0.0, -64.0, 0.0],
        );
        let plane = SlicePlane::Xz;
        apply(&mut scene, ViewportCommand::SetSlicePlane { plane });
        let y = grid(&scene, SpatialAxis::Y);
        assert_eq!((y.min, y.count), (-64.0, 128));
        apply(&mut scene, ViewportCommand::SetY { y: 3 });
        assert_eq!(scene.active_view().axes.y, Some(-60.5));
        assert_eq!(drawn(&scene, "before", plane), Some(3));
        assert_eq!(drawn(&scene, "a", plane), None);
    }

    #[test]
    fn a_collection_reads_a_side_view_place_from_where_it_is_placed() {
        // An image fixes the frame; a collection placed 32 units down lies
        // over its lower half. One place cuts the same row of both.
        let mut scene = Scene::new([800, 600]);
        let image = make_dataset_opened_with_shape(
            "image",
            "image",
            1,
            [1, 1, 16, 64, 64],
            [1, 1, 8, 32, 32],
            1,
        );
        scene.apply(DocumentCommand::DatasetOpened(image).into());
        let mut tiles = make_collection_dataset_opened(
            "tiles",
            "tiles",
            vec![("t0", [0.0, 0.0]), ("t1", [72.0, 0.0])],
            [1, 1, 16, 32, 64],
            [1, 1, 8, 8, 32],
        );
        tiles.manifest = tiles.manifest.with_space(PhysicalSpace {
            units: [None, None, None],
            origin: [0.0, 32.0, 0.0],
        });
        scene.apply(DocumentCommand::DatasetOpened(tiles).into());
        let plane = SlicePlane::Xz;
        apply(&mut scene, ViewportCommand::SetSlicePlane { plane });
        let y = grid(&scene, SpatialAxis::Y);
        assert_eq!((y.min, y.count), (0.0, 64));
        apply(&mut scene, ViewportCommand::SetY { y: 37 });
        assert_eq!(scene.active_view().axes.y, Some(37.5));
        assert_eq!(drawn(&scene, "image", plane), Some(37));
        assert_eq!(drawn(&scene, "tiles", plane), Some(5));
        // Above the collection, only the image is cut.
        apply(&mut scene, ViewportCommand::SetY { y: 10 });
        assert_eq!(drawn(&scene, "tiles", plane), None);
    }

    #[test]
    fn a_new_reference_carries_every_place_and_keeps_the_planes_cut() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "first", [40, 64, 64], [1.0; 3], [0.0; 3]);
        open(
            &mut scene,
            "second",
            [20, 64, 64],
            [2.0, 2.0, 2.0],
            [10.0, 0.0, 0.0],
        );
        apply(&mut scene, ViewportCommand::SetZ { z: 25 });
        assert_eq!(drawn(&scene, "second", SlicePlane::Xy), Some(7));
        // The second dataset fixes the frame once the first goes.
        let id = DatasetId::from("first");
        scene.apply(DocumentCommand::RemoveDataset { id }.into());
        assert_eq!(drawn(&scene, "second", SlicePlane::Xy), Some(7));
    }

    #[test]
    fn a_view_saved_with_plane_numbers_restores_the_planes_of_the_frames_dataset() {
        let mut scene = Scene::new([800, 600]);
        open(&mut scene, "a", [40, 64, 64], [2.0, 1.0, 1.0], [0.0; 3]);
        let mut legacy = AxisPositions::new();
        legacy.legacy_z_range = Some(12..13);
        scene.import_presence(
            scene.active_view().camera.clone(),
            legacy,
            Default::default(),
        );
        assert_eq!(scene.active_view().axes.z, Some(24.0..26.0));
        assert_eq!(drawn(&scene, "a", SlicePlane::Xy), Some(12));
    }
}
