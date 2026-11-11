//! The scene's placement of each dataset in the scene frame and world space.
//! None of it depends on a camera, so every view of the scene shares it.

use lucida_content::{DatasetId, SpatialAxis};

use crate::camera::{Camera, Framing, VisibleRegion};
use crate::placement::{
    Affine, CameraSpace, LineUp, SceneFrame, SpaceMap, UserTransform, WorldSpace, boxes_overlap,
    member_cube_to_frame,
};
use crate::slice_plane::SlicePlane;
use crate::transform::VolumeTransform;
use crate::view::{AxisPositions, ViewId};

use super::{LayerExtent, MemberState, Scene};

impl Scene {
    /// The scene frame, fixed by the first dataset in the document with an
    /// image. Document order is the same for every client and on every load,
    /// so placement is too. `None` with no such dataset.
    pub fn scene_frame(&self) -> Option<SceneFrame> {
        self.document.manifests.keys().find_map(|id| {
            let derived = self.derived.get(id)?;
            derived
                .members
                .iter()
                .any(|m| !m.levels.is_empty())
                .then(|| SceneFrame::new(derived.frame.clone()))
        })
    }

    /// The map from `dataset_id`'s frame into the scene frame, where the
    /// slice camera looks: its user transform, then the placement its
    /// declared frame makes. Every view, plan, pick and readout goes
    /// through this one map. `None` for a dataset the scene doesn't hold.
    pub fn placement(&self, dataset_id: &DatasetId) -> Option<Affine> {
        let derived = self.derived.get(dataset_id)?;
        let declared = self.declared_placement(dataset_id)?;
        Some(match self.user_transform(dataset_id) {
            Some(user) => user.in_frame(&derived.frame).then(&declared),
            None => declared,
        })
    }

    /// Where `dataset_id`'s declared frame alone puts it in the scene frame.
    fn declared_placement(&self, dataset_id: &DatasetId) -> Option<Affine> {
        let derived = self.derived.get(dataset_id)?;
        Some(
            self.scene_frame()
                .map_or(Affine::IDENTITY, |scene| scene.place(&derived.frame)),
        )
    }

    /// How a person placed `dataset_id` by hand, or `None` where they
    /// haven't.
    pub fn user_transform(&self, dataset_id: &DatasetId) -> Option<&UserTransform> {
        self.document.user_transforms.get(dataset_id)
    }

    /// `from`, a user transform of `dataset_id`, followed by `map`, a map of
    /// the scene frame: the transform that draws the dataset where `map`
    /// takes it from where `from` draws it. A gesture builds `map` from the
    /// pointer, a move or a scale about a fixed point, and this keeps the
    /// numbers in the dataset's own terms. `None` for a dataset the scene
    /// doesn't hold.
    pub fn user_transform_after(
        &self,
        dataset_id: &DatasetId,
        from: &UserTransform,
        map: &Affine,
    ) -> Option<UserTransform> {
        let derived = self.derived.get(dataset_id)?;
        let declared = self.declared_placement(dataset_id)?;
        Some(from.then_in_scene(&derived.frame, &declared, map))
    }

    /// Follow a dataset a person moved by hand. Where they put it is what
    /// they chose to look at, so a camera fitted to everything holds its
    /// pose, placed, rather than chasing the dataset across the canvas. The
    /// camera spaces don't move: the scene frame and world space follow the
    /// declared frames alone. A comparison that no longer lines up ends.
    pub(crate) fn dataset_moved(&mut self) {
        self.epochs.layout += 1;
        let mut held = false;
        for view in &mut self.views {
            if view.camera.framing() == Framing::Framed {
                view.camera.set_framing(Framing::Placed);
                held = true;
            }
        }
        if held {
            self.epochs.view += 1;
        }
        self.keep_comparison_lined_up();
    }

    /// The volume cameras' view of the scene frame. Lengths divide by the
    /// largest member extent of any dataset, and Y flips about the tallest
    /// member, so a scene of one image has the world space it always had.
    pub fn world_space(&self) -> WorldSpace {
        let Some(scene) = self.scene_frame() else {
            return WorldSpace::new(1.0, 0.0);
        };
        let mut extent = 0.0_f64;
        let mut top = 0.0_f64;
        for derived in self.derived.values() {
            let scale = scene.place(&derived.frame).scale;
            let size: [f64; 3] =
                std::array::from_fn(|i| derived.max_member_shape[i] * scale[i].abs());
            extent = extent.max(size[0]).max(size[1]).max(size[2]);
            top = top.max(size[1]);
        }
        WorldSpace::new(extent, top)
    }

    /// The spaces this scene's cameras' numbers are in. `None` until a
    /// dataset with an image fixes the scene frame.
    pub fn camera_space(&self) -> Option<CameraSpace> {
        Some(CameraSpace {
            frame: self.scene_frame()?,
            world: self.world_space(),
        })
    }

    /// The map from `from` into this scene's spaces. `None` when they are the
    /// same, so a camera already in them stays bit for bit, or when this scene
    /// has none yet.
    fn map_from(&self, from: &CameraSpace) -> Option<SpaceMap> {
        let to = self.camera_space()?;
        (*from != to).then(|| from.map_to(&to))
    }

    /// Carry `camera`, recorded in `from`, into this scene's spaces, so it
    /// shows the region it showed there.
    pub fn carry_camera(&self, camera: &mut Camera, from: &CameraSpace) {
        if let Some(map) = self.map_from(from) {
            camera.change_space(&map);
        }
    }

    /// Carry side-view axis positions, recorded in `from`, into this scene's
    /// spaces, so they cut the planes they cut there.
    pub fn carry_axes(&self, axes: &mut AxisPositions, from: &CameraSpace) {
        if let Some(map) = self.map_from(from) {
            axes.map_cut_positions(&map.scene);
        }
    }

    /// Carry every view's placed cameras, the active one and the parked one,
    /// from `from`, the scene's spaces before its datasets changed, into its
    /// spaces now. Says whether an active camera moved. A framed camera is
    /// the scene's own fit, which it fits again, and an unframed one is a
    /// stand-in, so neither is carried.
    pub(crate) fn carry_placed_cameras(&mut self, from: &CameraSpace) -> bool {
        let Some(map) = self.map_from(from) else {
            return false;
        };
        let mut moved = false;
        let mut axes_moved = false;
        for view in &mut self.views {
            let before = view.camera.clone();
            for camera in view.cameras_mut() {
                if camera.framing().is_placed() {
                    camera.change_space(&map);
                }
            }
            moved |= view.camera != before;
            // A side view's axis positions are places in the scene frame too.
            let axes_before = view.axes.clone();
            view.axes.map_cut_positions(&map.scene);
            axes_moved |= view.axes != axes_before;
        }
        if axes_moved {
            self.epochs.selection += 1;
        }
        moved
    }

    /// The map from `dataset_id`'s frame into world space, where the volume
    /// cameras look.
    pub fn frame_to_world(&self, dataset_id: &DatasetId) -> Option<Affine> {
        Some(self.placed(dataset_id)?.to_world)
    }

    /// `dataset_id`'s placement in both spaces, worked out once for a pass
    /// over its members.
    pub(crate) fn placed(&self, dataset_id: &DatasetId) -> Option<Placed> {
        let to_scene = self.placement(dataset_id)?;
        Some(Placed {
            to_scene,
            to_world: to_scene.then(&self.world_space().from_scene()),
        })
    }

    /// The box the renderer draws for `member` of `dataset_id`: its unit
    /// cube in world space, with both directions filled in. The camera
    /// projects and measures against it, so what is planned, picked and
    /// framed is what is drawn. A member with no levels gets the identity.
    pub fn rendering_transform(
        &self,
        dataset_id: &DatasetId,
        member: &MemberState,
    ) -> VolumeTransform {
        match self.frame_to_world(dataset_id) {
            Some(to_world) => member_transform(&to_world, member),
            None => Affine::IDENTITY.volume_transform(),
        }
    }

    /// `dataset_id`'s extent along `axis` in the scene frame, as `(min,
    /// max)` over its members, or `None` with no member to place.
    pub(crate) fn scene_extent(
        &self,
        dataset_id: &DatasetId,
        axis: SpatialAxis,
    ) -> Option<(f64, f64)> {
        let a = axis.xyz();
        let to_scene = self.placement(dataset_id)?;
        self.derived
            .get(dataset_id)?
            .members
            .iter()
            .filter_map(|member| {
                let (lo, hi) = frame_box(member)?;
                let (min, max) = to_scene.apply_box(lo, hi);
                Some((min[a], max[a]))
            })
            .reduce(union)
    }

    /// The extent along `axis` in the scene frame of the datasets `view`
    /// shows, as `(min, max)`, or `None` with nothing shown.
    fn shown_scene_extent(&self, view: ViewId, axis: SpatialAxis) -> Option<(f64, f64)> {
        self.shown_dataset_ids(view)
            .filter_map(|id| self.scene_extent(id, axis))
            .reduce(union)
    }

    /// How many axis positions `view` steps through cutting `axis`, at least
    /// one. Z counts the planes of the deepest layer it shows, since each
    /// layer steps through its own. A side view's position is a place in the
    /// scene frame, so datasets over one region cut the same plane, and it
    /// counts the frame's whole units up to the far edge of what it shows.
    pub fn cut_extent(&self, view: ViewId, axis: SpatialAxis) -> u32 {
        if axis.is_z() {
            return self
                .shown_dataset_ids(view)
                .filter_map(|id| self.document.manifests.get(id))
                .map(|manifest| LayerExtent::of(manifest).z)
                .max()
                .unwrap_or(1);
        }
        // An edge a rounding error puts just past a whole unit stays on it.
        self.shown_scene_extent(view, axis).map_or(1, |(_, max)| {
            (max - max.abs() * 1e-12).ceil().clamp(1.0, u32::MAX as f64) as u32
        })
    }

    /// The axis position in the middle of what `view` shows along `axis`.
    pub(crate) fn cut_middle(&self, view: ViewId, axis: SpatialAxis) -> u32 {
        self.shown_scene_extent(view, axis).map_or(0, |(min, max)| {
            ((min + max) / 2.0).floor().clamp(0.0, u32::MAX as f64) as u32
        })
    }

    /// Whether `dataset_id` declares physical lengths, so it lines up with
    /// other datasets that do. One without is placed by its declared numbers
    /// alone, which the layer panel says.
    pub fn has_physical_scale(&self, dataset_id: &DatasetId) -> bool {
        self.derived
            .get(dataset_id)
            .is_some_and(|d| d.frame.has_physical_scale())
    }

    /// The box `dataset_id`'s members fill in the scene frame, on all three
    /// axes. `None` for a dataset the scene doesn't hold or one with no image.
    fn placed_extent(&self, dataset_id: &DatasetId) -> Option<([f64; 3], [f64; 3])> {
        let to_scene = self.placement(dataset_id)?;
        self.derived
            .get(dataset_id)?
            .members
            .iter()
            .filter_map(|member| {
                let shape = member.levels.first()?.shape;
                let [x, y] = member.position;
                Some(to_scene.apply_box(
                    [x, y, 0.0],
                    [x + shape[4] as f64, y + shape[3] as f64, shape[2] as f64],
                ))
            })
            .reduce(|a, b| {
                (
                    std::array::from_fn(|i| a.0[i].min(b.0[i])),
                    std::array::from_fn(|i| a.1[i].max(b.1[i])),
                )
            })
    }

    /// Whether `dataset_id` is placed by length or by a person: it declares
    /// length units, or someone gave it a user transform, which says where
    /// it sits and how large it is whatever it declares.
    fn placed_by_length_or_hand(&self, dataset_id: &DatasetId) -> bool {
        self.has_physical_scale(dataset_id) || self.user_transform(dataset_id).is_some()
    }

    /// Of a pair that lines up, the datasets a person placed by hand, which
    /// the compare and link controls name as why. Empty for a pair that
    /// doesn't line up.
    pub fn line_up_by_hand(&self, a: &DatasetId, b: &DatasetId) -> Vec<DatasetId> {
        if self.line_up(a, b) != LineUp::Yes {
            return Vec::new();
        }
        [a, b]
            .into_iter()
            .filter(|id| self.user_transform(id).is_some())
            .cloned()
            .collect()
    }

    /// Whether `a` and `b` line up in physical space: each declares length
    /// units or was placed by hand, and their placed extents overlap. Only
    /// such a pair can stand in for each other on one region of the screen.
    pub fn line_up(&self, a: &DatasetId, b: &DatasetId) -> LineUp {
        if a == b {
            return LineUp::Same;
        }
        let (Some(a_box), Some(b_box)) = (self.placed_extent(a), self.placed_extent(b)) else {
            let datasets = [a, b]
                .into_iter()
                .filter(|id| self.placed_extent(id).is_none())
                .cloned()
                .collect();
            return LineUp::Missing { datasets };
        };
        let unscaled: Vec<DatasetId> = [a, b]
            .into_iter()
            .filter(|id| !self.placed_by_length_or_hand(id))
            .cloned()
            .collect();
        if !unscaled.is_empty() {
            return LineUp::NoPhysicalScale { datasets: unscaled };
        }
        if boxes_overlap(a_box, b_box) {
            LineUp::Yes
        } else {
            LineUp::Apart
        }
    }

    /// What of `dataset_id` `view`'s camera shows, in the dataset's own
    /// frame: the samples planning enumerates. A slice view re-expresses its
    /// region of the scene frame there. A volume view culls against the box
    /// of the dataset's first member set at the frame's origin, so a member's
    /// frustum test is a shift by its layout position. `None` for a dataset
    /// with no image, or an unknown view.
    pub fn visible_region(&self, view: ViewId, dataset_id: &DatasetId) -> Option<VisibleRegion> {
        let view = self.view(view)?;
        let member = self.derived.get(dataset_id)?.members.first()?;
        let level0 = member.levels.first()?;
        let placed = self.placed(dataset_id)?;
        // A layer shallower than the view's slab plans its nearest plane.
        let z_range = self.layer_z_range(&view.axes, dataset_id);
        Some(match &view.camera {
            Camera::Slice(slice) => slice.visible_region(
                &placed.to_scene,
                &self.layer_cut(&view.axes, dataset_id, slice.plane),
            ),
            Camera::Arcball(_) | Camera::Fly(_) => {
                let cube = member_cube_to_frame([0.0, 0.0], level0.shape)
                    .then(&placed.to_world)
                    .volume_transform();
                let shape = [
                    level0.shape[2] as u32,
                    level0.shape[3] as u32,
                    level0.shape[4] as u32,
                ];
                view.camera
                    .visible_region(&z_range, Some(&cube), Some(&shape))
            }
        })
    }
}

/// The extent covering two along one axis.
fn union((lo, hi): (f64, f64), (min, max): (f64, f64)) -> (f64, f64) {
    (lo.min(min), hi.max(max))
}

/// One dataset's frame mapped into the scene frame and into world space.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Placed {
    pub to_scene: Affine,
    pub to_world: Affine,
}

/// `member`'s box in its dataset's frame, as `[x, y, z]` minima and maxima:
/// its level-0 shape from its layout position. `None` without levels.
pub(crate) fn frame_box(member: &MemberState) -> Option<([f64; 3], [f64; 3])> {
    let level0 = member.levels.first()?;
    let [x0, y0] = member.position;
    Some((
        [x0, y0, 0.0],
        [
            x0 + level0.shape[4] as f64,
            y0 + level0.shape[3] as f64,
            level0.shape[2] as f64,
        ],
    ))
}

/// `member`'s box in the slice camera's space, as `[across, down, cut]`
/// minima and maxima: the axes `plane` draws as `to_scene` places them, and
/// along the cut its own planes, which an axis position steps through.
/// `None` without levels.
pub(crate) fn slice_box(
    plane: SlicePlane,
    to_scene: &Affine,
    member: &MemberState,
) -> Option<([f64; 3], [f64; 3])> {
    let (lo, hi) = frame_box(member)?;
    let (min, max) = to_scene.apply_box(lo, hi);
    let [across, down, cut] = plane.axes().map(SpatialAxis::xyz);
    Some((
        [min[across], min[down], 0.0],
        [max[across], max[down], hi[cut] - lo[cut]],
    ))
}

/// `member`'s unit cube in the space `frame_to_space` maps its dataset's
/// frame into. A member with no levels gets the identity.
pub fn member_transform(frame_to_space: &Affine, member: &MemberState) -> VolumeTransform {
    match member.levels.first() {
        Some(level0) => member_cube_to_frame(member.position, level0.shape)
            .then(frame_to_space)
            .volume_transform(),
        None => Affine::IDENTITY.volume_transform(),
    }
}

#[cfg(test)]
mod tests {
    use lucida_content::{DatasetId, PhysicalSpace};

    use super::super::test_helpers::make_dataset_opened_with_shape;
    use crate::camera::{Camera, Framing};
    use crate::command::{DocumentCommand, ViewportCommand};
    use crate::framing::PlaneBox;
    use crate::placement::{Affine, LineUp, UserTransform};
    use crate::saved_view::SavedView;
    use crate::scene::{FrameTarget, Scene};

    /// A single image of `shape` `[z, y, x]` samples, each `spacing` long in
    /// `unit`, its origin at `origin`. All three are `[z, y, x]`.
    fn open(
        scene: &mut Scene,
        id: &str,
        shape: [u64; 3],
        spacing: [f64; 3],
        origin: [f64; 3],
        unit: Option<&str>,
    ) {
        let mut opened = make_dataset_opened_with_shape(
            id,
            id,
            1,
            [1, 1, shape[0], shape[1], shape[2]],
            [1, 1, 16, 64, 64],
            2,
        );
        for image in opened.manifest.images_mut() {
            for (level, geometry) in image.multiscale.levels.iter_mut().enumerate() {
                let factor = (1u64 << level) as f64;
                geometry.scale = [
                    1.0,
                    1.0,
                    spacing[0],
                    spacing[1] * factor,
                    spacing[2] * factor,
                ];
            }
        }
        opened.manifest = opened.manifest.with_space(PhysicalSpace {
            units: [unit, unit, unit].map(|u| u.map(str::to_string)),
            origin,
        });
        scene.apply(DocumentCommand::DatasetOpened(opened).into());
    }

    fn close(a: [f64; 3], b: [f64; 3]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
    }

    /// The same 128 x 128 x 32 micrometer region at two sample sizes, one in
    /// micrometers and one in nanometers.
    fn two_over_one_region() -> Scene {
        let mut scene = Scene::new([800, 600]);
        open(
            &mut scene,
            "coarse",
            [16, 64, 64],
            [2.0, 2.0, 2.0],
            [0.0; 3],
            Some("micrometer"),
        );
        open(
            &mut scene,
            "fine",
            [64, 256, 256],
            [500.0; 3],
            [0.0; 3],
            Some("nanometer"),
        );
        scene
    }

    #[test]
    fn datasets_over_one_physical_region_overlay_in_both_spaces() {
        let scene = two_over_one_region();
        let [coarse, fine] = ["coarse", "fine"]
            .map(|id| scene.dataset_bounds(scene.active_view().id(), id).unwrap());
        assert!(close(coarse.plane.min, fine.plane.min));
        // Z counts each dataset's own planes, so only X and Y match.
        assert!(close(
            [coarse.plane.max[0], coarse.plane.max[1], 0.0],
            [fine.plane.max[0], fine.plane.max[1], 0.0]
        ));
        assert!(close(coarse.world.min, fine.world.min));
        assert!(close(coarse.world.max, fine.world.max));
        // The first dataset fixes the scene frame: its samples are its units.
        assert!(close(coarse.plane.max, [64.0, 64.0, 16.0]));
    }

    #[test]
    fn datasets_over_one_region_cut_the_same_plane_in_a_side_view() {
        let mut scene = two_over_one_region();
        scene.apply(
            ViewportCommand::SetSlicePlane {
                plane: crate::slice_plane::SlicePlane::Xz,
            }
            .into(),
        );
        // The middle of the region along Y, in the coarse dataset's samples.
        assert_eq!(scene.active_view().axes.y, Some(32));
        let plane = crate::slice_plane::SlicePlane::Xz;
        let [coarse, fine] = ["coarse", "fine"]
            .map(|id| scene.layer_cut(&scene.active_view().axes, &DatasetId::from(id), plane));
        // Coarse sample 32 spans 64 to 66 micrometers, which fine samples
        // 128 to 131 cover; the fine plane is one of them.
        assert_eq!(coarse, 32..33);
        assert!((128..132).contains(&fine.start), "{fine:?}");
        // Both draw over the same X and Z of the scene frame.
        let [a, b] = ["coarse", "fine"].map(|id| {
            scene
                .dataset_plane_bounds(scene.active_view().id(), id)
                .unwrap()
        });
        assert!(close([a.min[0], a.min[1], 0.0], [b.min[0], b.min[1], 0.0]));
        assert!(close([a.max[0], a.max[1], 0.0], [b.max[0], b.max[1], 0.0]));
        assert_eq!(
            scene.cut_extent(scene.active_view().id(), lucida_content::SpatialAxis::Y),
            64
        );
    }

    #[test]
    fn a_side_view_cut_past_a_dataset_misses_it() {
        use crate::scene::CutReach;
        use crate::slice_plane::SlicePlane;
        let mut scene = Scene::new([800, 600]);
        let unit = Some("micrometer");
        open(&mut scene, "a", [16, 64, 64], [1.0; 3], [0.0; 3], unit);
        // B starts 48 micrometers down and 32 across, past most of A.
        open(
            &mut scene,
            "b",
            [16, 64, 64],
            [1.0; 3],
            [0.0, 48.0, 32.0],
            unit,
        );
        // A flat image across the same Y as A.
        open(&mut scene, "flat", [1, 64, 64], [1.0; 3], [0.0; 3], unit);
        scene.apply(
            ViewportCommand::SetSlicePlane {
                plane: SlicePlane::Xz,
            }
            .into(),
        );
        let reach = |scene: &Scene, id: &str| {
            scene
                .layer_reach(scene.active_view().id(), &DatasetId::from(id))
                .unwrap()
        };
        let at_y = |scene: &mut Scene, y: u32| scene.apply(ViewportCommand::SetY { y }.into());

        at_y(&mut scene, 20);
        assert_eq!(reach(&scene, "a"), CutReach::Through);
        assert_eq!(reach(&scene, "b"), CutReach::Outside);
        // A flat image is a line in a side view, cut like any other layer.
        assert_eq!(reach(&scene, "flat"), CutReach::Through);
        assert!(
            scene
                .chunk_plan_for(scene.active_view().id(), &DatasetId::from("b"))
                .unwrap()
                .is_empty()
        );

        at_y(&mut scene, 50);
        assert_eq!(reach(&scene, "a"), CutReach::Through);
        assert_eq!(reach(&scene, "b"), CutReach::Through);

        // Y 63 is A's last unit, and Y 64 the first past it.
        at_y(&mut scene, 63);
        assert_eq!(reach(&scene, "a"), CutReach::Through);
        at_y(&mut scene, 64);
        assert_eq!(reach(&scene, "a"), CutReach::Outside);
        assert_eq!(reach(&scene, "flat"), CutReach::Outside);
        assert_eq!(reach(&scene, "b"), CutReach::Through);
        assert!(
            !scene
                .chunk_plan_for(scene.active_view().id(), &DatasetId::from("b"))
                .unwrap()
                .is_empty()
        );

        // A YZ view cuts along X, where B starts at 32.
        scene.apply(
            ViewportCommand::SetSlicePlane {
                plane: SlicePlane::Yz,
            }
            .into(),
        );
        scene.apply(ViewportCommand::SetX { x: 10 }.into());
        assert_eq!(reach(&scene, "a"), CutReach::Through);
        assert_eq!(reach(&scene, "b"), CutReach::Outside);
        // The Y cut is kept for the XZ view, and the XY view's Z is unmoved.
        let b = scene
            .resolved_layer(scene.active_view().id(), &DatasetId::from("b"))
            .unwrap();
        assert_eq!(b.reach(SlicePlane::Xz), CutReach::Through);
        assert_eq!(b.reach(SlicePlane::Xy), CutReach::Through);
    }

    #[test]
    fn a_declared_translation_offsets_the_dataset() {
        let mut scene = Scene::new([800, 600]);
        open(
            &mut scene,
            "a",
            [1, 64, 64],
            [1.0; 3],
            [0.0; 3],
            Some("micrometer"),
        );
        open(
            &mut scene,
            "b",
            [1, 64, 64],
            [1.0; 3],
            [0.0, 10.0, 32.0],
            Some("micrometer"),
        );
        let a = scene
            .dataset_plane_bounds(scene.active_view().id(), "a")
            .unwrap();
        let b = scene
            .dataset_plane_bounds(scene.active_view().id(), "b")
            .unwrap();
        assert!(close(b.min, [a.min[0] + 32.0, a.min[1] + 10.0, 0.0]));

        // In world space Y points up, so a dataset further down sits lower.
        let a = scene.dataset_world_bounds("a").unwrap();
        let b = scene.dataset_world_bounds("b").unwrap();
        assert!(b.min[0] > a.min[0] && b.max[1] < a.max[1]);
    }

    #[test]
    fn the_first_dataset_keeps_its_own_frame_whatever_its_origin() {
        let mut moved = Scene::new([800, 600]);
        open(
            &mut moved,
            "a",
            [8, 64, 96],
            [1.0, 0.5, 0.5],
            [3.0, 40.0, -7.0],
            Some("micrometer"),
        );
        // The same aspect, declared without units or an origin.
        let mut bare = Scene::new([800, 600]);
        open(&mut bare, "a", [8, 64, 96], [2.0, 1.0, 1.0], [0.0; 3], None);
        let id = DatasetId::from("a");
        assert_eq!(
            moved.dataset_bounds(moved.active_view().id(), "a"),
            bare.dataset_bounds(bare.active_view().id(), "a")
        );
        assert_eq!(moved.active_view().camera, bare.active_view().camera);
        assert_ne!(moved.placement(&id), None);
    }

    #[test]
    fn a_slice_region_reads_in_each_datasets_own_samples() {
        let mut scene = two_over_one_region();
        assert!(scene.frame(&FrameTarget::Visible, [800, 600]));
        let coarse = scene
            .visible_region(scene.active_view().id(), &DatasetId::from("coarse"))
            .unwrap();
        let fine = scene
            .visible_region(scene.active_view().id(), &DatasetId::from("fine"))
            .unwrap();
        // A fine sample is a quarter of a coarse one, so the same view spans
        // four times the samples at a quarter of the pixels each.
        for i in 0..4 {
            assert!((fine.xy_bounds[i] - 4.0 * coarse.xy_bounds[i]).abs() < 1e-6);
        }
        assert!((fine.effective_zoom * 4.0 - coarse.effective_zoom).abs() < 1e-9);
    }

    #[test]
    fn a_dataset_without_units_has_no_physical_scale() {
        let mut scene = Scene::new([800, 600]);
        open(
            &mut scene,
            "a",
            [1, 64, 64],
            [1.0; 3],
            [0.0; 3],
            Some("micrometer"),
        );
        open(&mut scene, "b", [1, 64, 64], [2.0; 3], [0.0; 3], None);
        assert!(scene.has_physical_scale(&DatasetId::from("a")));
        assert!(!scene.has_physical_scale(&DatasetId::from("b")));
        // Its declared numbers compare with the reference's as they stand.
        let b = scene
            .dataset_plane_bounds(scene.active_view().id(), "b")
            .unwrap();
        assert!(close([b.max[0], b.max[1], 0.0], [128.0, 128.0, 0.0]));
    }

    #[test]
    fn datasets_line_up_when_both_declare_lengths_and_overlap() {
        let scene = two_over_one_region();
        let [coarse, fine] = ["coarse", "fine"].map(DatasetId::from);
        assert_eq!(scene.line_up(&coarse, &fine), LineUp::Yes);
        assert_eq!(scene.line_up(&fine, &coarse), LineUp::Yes);
        assert_eq!(scene.line_up(&coarse, &coarse), LineUp::Same);
        let gone = DatasetId::from("gone");
        assert_eq!(
            scene.line_up(&coarse, &gone),
            LineUp::Missing {
                datasets: vec![gone]
            }
        );
    }

    #[test]
    fn datasets_side_by_side_or_without_units_do_not_line_up() {
        let mut scene = Scene::new([800, 600]);
        let unit = Some("micrometer");
        open(&mut scene, "a", [1, 64, 64], [1.0; 3], [0.0; 3], unit);
        // Starts where A ends, so the two only touch.
        open(
            &mut scene,
            "b",
            [1, 64, 64],
            [1.0; 3],
            [0.0, 0.0, 64.0],
            unit,
        );
        open(&mut scene, "bare", [1, 64, 64], [1.0; 3], [0.0; 3], None);
        let [a, b, bare] = ["a", "b", "bare"].map(DatasetId::from);
        assert_eq!(scene.line_up(&a, &b), LineUp::Apart);
        assert_eq!(
            scene.line_up(&a, &bare),
            LineUp::NoPhysicalScale {
                datasets: vec![bare]
            }
        );
        // A plane deeper than the other's is apart too, though the two fill
        // one rectangle on screen.
        open(
            &mut scene,
            "deep",
            [1, 64, 64],
            [1.0; 3],
            [5.0, 0.0, 0.0],
            unit,
        );
        assert_eq!(scene.line_up(&a, &DatasetId::from("deep")), LineUp::Apart);
    }

    fn place_by_hand(scene: &mut Scene, id: &str, translation: [f64; 3], scale: [f64; 3]) {
        scene.apply(
            DocumentCommand::SetUserTransform {
                dataset_id: DatasetId::from(id),
                transform: UserTransform {
                    translation,
                    scale,
                    ..UserTransform::IDENTITY
                },
            }
            .into(),
        );
    }

    #[test]
    fn a_user_transform_moves_and_scales_a_dataset_on_its_declared_placement() {
        let mut scene = Scene::new([800, 600]);
        let unit = Some("micrometer");
        open(&mut scene, "a", [8, 64, 64], [1.0; 3], [0.0; 3], unit);
        // Half-micrometer samples, so 64 of them span 32 micrometers.
        open(
            &mut scene,
            "b",
            [8, 64, 64],
            [1.0, 0.5, 0.5],
            [0.0; 3],
            unit,
        );
        let view = scene.active_view().id();
        let before = scene.dataset_plane_bounds(view, "b").unwrap();
        assert!(close(before.max, [32.0, 32.0, 8.0]));
        let epoch = scene.epochs.layout;

        // 10 micrometers across and twice the size in X and Y.
        place_by_hand(&mut scene, "b", [10.0, 0.0, 0.0], [2.0, 2.0, 1.0]);
        assert!(scene.epochs.layout > epoch);
        let after = scene.dataset_plane_bounds(view, "b").unwrap();
        assert!(close(after.min, [10.0, 0.0, 0.0]), "{after:?}");
        assert!(close(after.max, [74.0, 64.0, 8.0]), "{after:?}");
        // The volume cameras see the same move, and A stays where it was.
        let world = scene.dataset_world_bounds("b").unwrap();
        let a = scene.dataset_world_bounds("a").unwrap();
        assert!(world.min[0] > a.min[0] && (world.max[1] - a.max[1]).abs() < 1e-9);
        assert!(close(
            scene.dataset_plane_bounds(view, "a").unwrap().max,
            [64.0, 64.0, 8.0]
        ));
        // What a view shows of B still reads in B's own samples.
        assert!(scene.frame(&FrameTarget::Visible, [800, 600]));
        let region = scene.visible_region(view, &DatasetId::from("b")).unwrap();
        assert!(region.xy_bounds[0] <= 0.0 && region.xy_bounds[2] >= 64.0);
    }

    #[test]
    fn moving_the_first_dataset_keeps_the_scene_frame_and_camera_spaces() {
        let mut scene = a_then_b();
        let spaces = scene.camera_space();
        let b = scene
            .dataset_plane_bounds(scene.active_view().id(), "b")
            .unwrap();
        place_by_hand(&mut scene, "a", [5.0, 5.0, 0.0], [3.0; 3]);
        assert_eq!(scene.camera_space(), spaces);
        assert_eq!(
            scene.dataset_plane_bounds(scene.active_view().id(), "b"),
            Some(b)
        );
        let a = scene
            .dataset_plane_bounds(scene.active_view().id(), "a")
            .unwrap();
        assert!(close(a.min, [5.0, 5.0, 0.0]));
    }

    #[test]
    fn a_framed_camera_holds_its_pose_when_a_dataset_moves() {
        for volume in [false, true] {
            let mut scene = a_then_b();
            if volume {
                scene.set_mode_3d();
            }
            assert!(scene.frame(&FrameTarget::Visible, [800, 600]));
            assert_eq!(scene.active_view().camera.framing(), Framing::Framed);
            let camera = scene.active_view().camera.clone();
            place_by_hand(&mut scene, "b", [40.0, 0.0, 0.0], [1.0; 3]);
            let held = &scene.active_view().camera;
            assert_eq!(held.framing(), Framing::Placed);
            let mut pose = held.clone();
            pose.set_framing(Framing::Framed);
            assert_eq!(pose, camera);
        }
    }

    #[test]
    fn a_volume_view_frames_and_flies_by_the_extent_as_moved() {
        let mut scene = a_then_b();
        scene.set_mode_3d();
        let view = scene.active_view().id();
        let diagonal = scene.volume_diagonal(view);
        place_by_hand(&mut scene, "b", [0.0; 3], [4.0; 3]);
        // Fly speed follows the visible extent, which grows with B.
        assert!(scene.volume_diagonal(view) > 2.0 * diagonal);
        assert!(scene.frame(&FrameTarget::Visible, [800, 600]));
        let b = scene.dataset_world_bounds("b").unwrap();
        // The fit keeps all of B on screen.
        for corner in [b.min, b.max] {
            let [x, y] = scene
                .active_view()
                .camera
                .project_to_screen(corner)
                .unwrap();
            assert!((0.0..=800.0).contains(&x) && (0.0..=600.0).contains(&y));
        }
    }

    #[test]
    fn the_identity_and_removal_clear_a_user_transform_and_bad_ones_change_nothing() {
        let mut scene = a_then_b();
        let b = DatasetId::from("b");
        place_by_hand(&mut scene, "b", [1.0, 0.0, 0.0], [1.0; 3]);
        assert!(scene.user_transform(&b).is_some());
        let placed = scene.placement(&b);
        let epoch = scene.epochs.layout;
        // No size, or a dataset the scene doesn't hold, is refused.
        place_by_hand(&mut scene, "b", [0.0; 3], [0.0, 1.0, 1.0]);
        place_by_hand(&mut scene, "gone", [9.0; 3], [1.0; 3]);
        assert_eq!(scene.placement(&b), placed);
        assert_eq!(scene.epochs.layout, epoch);
        assert!(
            !scene
                .document
                .user_transforms
                .contains_key(&DatasetId::from("gone"))
        );

        place_by_hand(&mut scene, "b", [0.0; 3], [1.0; 3]);
        assert!(scene.user_transform(&b).is_none());
        place_by_hand(&mut scene, "b", [1.0, 0.0, 0.0], [1.0; 3]);
        remove(&mut scene, "b");
        assert!(scene.document.user_transforms.is_empty());
    }

    #[test]
    fn a_dataset_placed_by_hand_lines_up_whatever_it_declares() {
        let mut scene = Scene::new([800, 600]);
        let unit = Some("micrometer");
        open(&mut scene, "a", [1, 64, 64], [1.0; 3], [0.0; 3], unit);
        open(&mut scene, "bare", [1, 32, 32], [1.0; 3], [0.0; 3], None);
        // Starts where A ends, so the two only touch.
        let beside_origin = [0.0, 0.0, 64.0];
        open(
            &mut scene,
            "beside",
            [1, 64, 64],
            [1.0; 3],
            beside_origin,
            unit,
        );
        let [a, bare, beside] = ["a", "bare", "beside"].map(DatasetId::from);
        assert!(matches!(
            scene.line_up(&a, &bare),
            LineUp::NoPhysicalScale { .. }
        ));
        assert_eq!(scene.line_up(&a, &beside), LineUp::Apart);
        assert!(scene.line_up_by_hand(&a, &bare).is_empty());

        // Given a size, the bare dataset sits where its user put it.
        place_by_hand(&mut scene, "bare", [0.0; 3], [2.0; 3]);
        assert_eq!(scene.line_up(&a, &bare), LineUp::Yes);
        assert_eq!(scene.line_up_by_hand(&a, &bare), vec![bare.clone()]);
        // Moved over A, the other lines up by its moved extent.
        place_by_hand(&mut scene, "beside", [-32.0, 0.0, 0.0], [1.0; 3]);
        assert_eq!(scene.line_up(&a, &beside), LineUp::Yes);
        assert_eq!(scene.line_up_by_hand(&beside, &a), vec![beside]);
        // A pair placed only by what it declares names no one.
        open(&mut scene, "same", [1, 64, 64], [1.0; 3], [0.0; 3], unit);
        let same = DatasetId::from("same");
        assert!(scene.line_up_by_hand(&a, &same).is_empty());
    }

    #[test]
    fn a_move_that_takes_a_pair_apart_ends_its_comparison() {
        use crate::scene::CompareMode;
        let mut scene = two_over_one_region();
        let [coarse, fine] = ["coarse", "fine"].map(DatasetId::from);
        scene.compare(coarse, fine, CompareMode::Swipe).unwrap();
        place_by_hand(&mut scene, "fine", [10_000.0, 0.0, 0.0], [1.0; 3]);
        assert!(scene.comparison().is_some());
        place_by_hand(&mut scene, "fine", [500_000.0, 0.0, 0.0], [1.0; 3]);
        assert!(scene.comparison().is_none());
    }

    #[test]
    fn a_scene_map_after_a_user_transform_draws_the_dataset_where_it_says() {
        let mut scene = a_then_b();
        let b = DatasetId::from("b");
        place_by_hand(&mut scene, "b", [1_000.0, 0.0, 0.0], [1.5; 3]);
        let from = *scene.user_transform(&b).unwrap();
        // Twice the size about scene point (20, 10), then 4 down.
        let map = Affine {
            scale: [2.0, 2.0, 2.0],
            offset: [-20.0, -10.0 + 4.0, 0.0],
        };
        let p = [100.0, 30.0, 4.0];
        let expected = map.apply(scene.placement(&b).unwrap().apply(p));
        let after = scene.user_transform_after(&b, &from, &map).unwrap();
        scene.apply(
            DocumentCommand::SetUserTransform {
                dataset_id: b.clone(),
                transform: after,
            }
            .into(),
        );
        assert!(close(scene.placement(&b).unwrap().apply(p), expected));
        let gone = DatasetId::from("gone");
        assert!(scene.user_transform_after(&gone, &from, &map).is_none());
    }

    #[test]
    fn framing_two_datasets_is_the_same_on_every_load() {
        let fit = || {
            let mut scene = two_over_one_region();
            scene.set_mode_3d();
            (
                scene.active_view().camera.clone(),
                scene.volume_diagonal(scene.active_view().id()).to_bits(),
            )
        };
        let first = fit();
        // Each scene's maps hash with their own random state, so twenty loads
        // walk the datasets in different orders.
        for _ in 0..20 {
            assert_eq!(fit(), first);
        }
        assert!(matches!(first.0, Camera::Arcball(_)));
    }

    /// A, 64 micrometers square in 1 micrometer samples, then B, 64
    /// micrometers square in 250 nanometer samples from (16, 8) micrometers.
    /// A fixes the scene frame until it goes.
    fn a_then_b() -> Scene {
        let mut scene = Scene::new([800, 600]);
        open_a(&mut scene);
        open_b(&mut scene);
        scene
    }

    fn open_a(scene: &mut Scene) {
        let unit = Some("micrometer");
        open(scene, "a", [8, 64, 64], [1.0; 3], [0.0; 3], unit);
    }

    fn open_b(scene: &mut Scene) {
        let origin = [0.0, 8_000.0, 16_000.0];
        open(
            scene,
            "b",
            [32, 256, 256],
            [250.0; 3],
            origin,
            Some("nanometer"),
        );
    }

    fn remove(scene: &mut Scene, id: &str) {
        let id = DatasetId::from(id);
        scene.apply(DocumentCommand::RemoveDataset { id }.into());
    }

    /// Where samples of `id` land on the canvas, so two scenes show the same
    /// region of it exactly when these match.
    fn on_screen(scene: &Scene, id: &str) -> Vec<[f64; 2]> {
        let id = DatasetId::from(id);
        let to_view = if scene.active_view().camera.is_volume() {
            scene.frame_to_world(&id)
        } else {
            scene.placement(&id)
        }
        .unwrap();
        let samples = [
            [64.0, 64.0, 8.0],
            [192.0, 80.0, 16.0],
            [100.0, 200.0, 24.0],
            [150.0, 120.0, 4.0],
        ];
        samples
            .iter()
            .map(|p| {
                scene
                    .active_view()
                    .camera
                    .project_to_screen(to_view.apply(*p))
                    .unwrap()
            })
            .collect()
    }

    fn assert_same_region(after: Vec<[f64; 2]>, before: Vec<[f64; 2]>) {
        for (a, b) in after.iter().zip(&before) {
            assert!(
                (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6,
                "{after:?} vs {before:?}"
            );
        }
    }

    /// Fit a part of B in 2D, which leaves the camera placed.
    fn place_slice_on_b(scene: &mut Scene) {
        let region = PlaneBox::new([100.0, 60.0, 0.0], [180.0, 140.0, 1.0]);
        assert!(scene.frame_region(&DatasetId::from("b"), region));
        assert!(scene.active_view().camera.framing().is_placed());
    }

    /// Turn, zoom and pan the arcball, which leaves it placed.
    fn place_arcball(scene: &mut Scene) {
        scene.set_mode_3d();
        for command in [
            ViewportCommand::Rotate3D {
                d_theta: 0.4,
                d_phi: -0.2,
            },
            ViewportCommand::Zoom3D { delta: -0.5 },
            ViewportCommand::Pan3D {
                dx: 40.0,
                dy: -25.0,
            },
        ] {
            scene.apply(command.into());
        }
        assert!(scene.active_view().camera.framing().is_placed());
    }

    #[test]
    fn removing_the_first_dataset_keeps_a_placed_slice_on_its_region() {
        let mut scene = a_then_b();
        place_slice_on_b(&mut scene);
        let before = on_screen(&scene, "b");
        let epoch = scene.epochs.view;
        remove(&mut scene, "a");
        assert_same_region(on_screen(&scene, "b"), before);
        assert!(scene.active_view().camera.framing().is_placed());
        assert!(scene.epochs.view > epoch);
        // B now fixes the scene frame: its samples are its units.
        let b = scene
            .dataset_plane_bounds(scene.active_view().id(), "b")
            .unwrap();
        assert!(close(b.max, [256.0, 256.0, 32.0]));
    }

    #[test]
    fn removing_the_first_dataset_keeps_a_placed_volume_camera_on_its_region() {
        for fly in [false, true] {
            let mut scene = a_then_b();
            place_arcball(&mut scene);
            if fly {
                scene.set_mode_fly();
                scene.apply(
                    ViewportCommand::FlyTick {
                        dt: 0.1,
                        forward: 1.0,
                        right: 0.5,
                        up: 0.0,
                        yaw: 0.1,
                        pitch: 0.0,
                        roll: 0.0,
                    }
                    .into(),
                );
            }
            let before = on_screen(&scene, "b");
            remove(&mut scene, "a");
            assert_same_region(on_screen(&scene, "b"), before);
            assert!(scene.active_view().camera.framing().is_placed());
        }
    }

    #[test]
    fn the_parked_camera_keeps_its_region_too() {
        let mut scene = a_then_b();
        place_slice_on_b(&mut scene);
        let slice = on_screen(&scene, "b");
        place_arcball(&mut scene);
        remove(&mut scene, "a");
        scene.set_mode_2d();
        assert_same_region(on_screen(&scene, "b"), slice);
    }

    #[test]
    fn opening_a_larger_dataset_keeps_a_placed_volume_camera_on_its_region() {
        let mut scene = Scene::new([800, 600]);
        open_b(&mut scene);
        place_arcball(&mut scene);
        let before = on_screen(&scene, "b");
        // Twice B's size, so world space shrinks every length by half.
        let unit = Some("micrometer");
        open(&mut scene, "c", [16, 128, 128], [1.0; 3], [0.0; 3], unit);
        assert_same_region(on_screen(&scene, "b"), before);
    }

    #[test]
    fn a_framed_camera_fits_what_is_left() {
        for volume in [false, true] {
            let fit = |scene: &mut Scene| {
                if volume {
                    scene.set_mode_3d();
                }
                assert!(scene.frame(&FrameTarget::Visible, [800, 600]));
            };
            let mut scene = a_then_b();
            fit(&mut scene);
            remove(&mut scene, "a");
            let mut alone = Scene::new([800, 600]);
            open_b(&mut alone);
            fit(&mut alone);
            assert_eq!(scene.active_view().camera, alone.active_view().camera);
            assert_eq!(scene.active_view().camera.framing(), Framing::Framed);
        }
    }

    #[test]
    fn a_document_load_with_another_first_dataset_keeps_a_placed_camera_on_its_region() {
        let mut scene = a_then_b();
        place_slice_on_b(&mut scene);
        let before = on_screen(&scene, "b");
        let mut document = scene.document.clone();
        document.remove_dataset(&DatasetId::from("a"));
        scene.load_document(document);
        assert_same_region(on_screen(&scene, "b"), before);
    }

    #[test]
    fn a_side_view_keeps_its_plane_cut_and_region_when_the_scene_frame_changes() {
        use crate::slice_plane::SlicePlane;
        let mut scene = a_then_b();
        scene.apply(
            ViewportCommand::SetSlicePlane {
                plane: SlicePlane::Xz,
            }
            .into(),
        );
        scene.apply(
            ViewportCommand::Pan {
                dx: 30.0,
                dy: -20.0,
            }
            .into(),
        );
        assert!(scene.active_view().camera.framing().is_placed());
        let b = DatasetId::from("b");
        // B's samples where an XZ view draws them: X across, Z down.
        let side = |scene: &Scene| -> Vec<[f64; 2]> {
            let to_scene = scene.placement(&b).unwrap();
            [[64.0, 64.0, 8.0], [192.0, 80.0, 16.0], [100.0, 200.0, 24.0]]
                .iter()
                .map(|p| {
                    let at = to_scene.apply(*p);
                    scene
                        .active_view()
                        .camera
                        .project_to_screen([at[0], at[2], 0.0])
                        .unwrap()
                })
                .collect()
        };
        let (cut, before) = (
            scene.layer_cut(&scene.active_view().axes, &b, SlicePlane::Xz),
            side(&scene),
        );

        // A's going makes B the scene frame's reference.
        let mut document = scene.document.clone();
        document.remove_dataset(&DatasetId::from("a"));
        scene.load_document(document);
        assert_eq!(scene.active_view().slice_plane(), SlicePlane::Xz);
        assert_same_region(side(&scene), before);
        assert_eq!(
            scene.layer_cut(&scene.active_view().axes, &b, SlicePlane::Xz),
            cut
        );
    }

    #[test]
    fn a_saved_view_shows_its_region_whichever_dataset_the_document_holds_first() {
        for volume in [false, true] {
            let mut saved_from = a_then_b();
            if volume {
                place_arcball(&mut saved_from);
            } else {
                place_slice_on_b(&mut saved_from);
            }
            let before = on_screen(&saved_from, "b");
            let view = SavedView {
                camera: saved_from.active_view().camera.clone(),
                camera_space: saved_from.camera_space(),
                ..SavedView::empty([800, 600])
            };
            let restore = |scene: &mut Scene, view: &SavedView| {
                let camera = view.camera_in(scene);
                scene.import_presence(camera, view.view.clone(), view.display.clone());
            };

            let mut b_alone = Scene::new([800, 600]);
            open_b(&mut b_alone);
            let mut b_then_a = Scene::new([800, 600]);
            open_b(&mut b_then_a);
            open_a(&mut b_then_a);
            for mut scene in [b_alone, b_then_a] {
                restore(&mut scene, &view);
                assert_same_region(on_screen(&scene, "b"), before.clone());
            }

            // A view saved before the record existed reads in the restoring
            // scene's own spaces, right while its first dataset is the same.
            let legacy = SavedView {
                camera_space: None,
                ..view
            };
            let mut same = a_then_b();
            restore(&mut same, &legacy);
            assert_same_region(on_screen(&same, "b"), before);
        }
    }
}
