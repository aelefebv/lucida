//! The scene's placement of each dataset in the scene frame and world space.
//! None of it depends on a camera, so every view of the scene shares it.

use lucida_content::{DatasetId, SpatialAxis};

use crate::camera::{Camera, VisibleRegion};
use crate::placement::{
    Affine, CameraSpace, SceneFrame, SpaceMap, WorldSpace, member_cube_to_frame,
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
    /// slice camera looks. `None` for a dataset the scene doesn't hold.
    pub fn placement(&self, dataset_id: &DatasetId) -> Option<Affine> {
        let derived = self.derived.get(dataset_id)?;
        Some(
            self.scene_frame()
                .map_or(Affine::IDENTITY, |scene| scene.place(&derived.frame)),
        )
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

    /// The extent along `axis` in the scene frame of the datasets `view`
    /// shows, as `(min, max)`, or `None` with nothing shown.
    fn shown_scene_extent(&self, view: ViewId, axis: SpatialAxis) -> Option<(f64, f64)> {
        let a = axis.xyz();
        self.shown_dataset_ids(view)
            .filter_map(|id| Some((self.placement(id)?, self.derived.get(id)?)))
            .flat_map(|(to_scene, derived)| {
                derived.members.iter().filter_map(move |member| {
                    let (lo, hi) = frame_box(member)?;
                    let (min, max) = to_scene.apply_box(lo, hi);
                    Some((min[a], max[a]))
                })
            })
            .reduce(|(lo, hi), (min, max)| (lo.min(min), hi.max(max)))
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
