//! The scene's placement of each dataset in the scene frame and world space.
//! None of it depends on a camera, so every view of the scene shares it.

use lucida_content::DatasetId;

use crate::camera::{Camera, VisibleRegion};
use crate::placement::{Affine, SceneFrame, WorldSpace, member_cube_to_frame};
use crate::transform::VolumeTransform;

use super::{MemberState, Scene};

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

    /// Whether `dataset_id` declares physical lengths, so it lines up with
    /// other datasets that do. One without is placed by its declared numbers
    /// alone, which the layer panel says.
    pub fn has_physical_scale(&self, dataset_id: &DatasetId) -> bool {
        self.derived
            .get(dataset_id)
            .is_some_and(|d| d.frame.has_physical_scale())
    }

    /// What of `dataset_id` the camera shows, in the dataset's own frame:
    /// the samples planning enumerates. A slice view re-expresses its region
    /// of the scene frame there. A volume view culls against the box of the
    /// dataset's first member set at the frame's origin, so a member's
    /// frustum test is a shift by its layout position. `None` for a dataset
    /// with no image.
    pub fn visible_region(&self, dataset_id: &DatasetId) -> Option<VisibleRegion> {
        let member = self.derived.get(dataset_id)?.members.first()?;
        let level0 = member.levels.first()?;
        let placed = self.placed(dataset_id)?;
        // A layer shallower than the scene's slab plans its nearest plane.
        let z_range = self.layer_z_range(dataset_id);
        Some(match self.camera {
            Camera::Slice(_) => self
                .camera
                .visible_region(&z_range, None, None)
                .in_frame(&placed.to_scene),
            Camera::Arcball(_) | Camera::Fly(_) => {
                let cube = member_cube_to_frame([0.0, 0.0], level0.shape)
                    .then(&placed.to_world)
                    .volume_transform();
                let shape = [
                    level0.shape[2] as u32,
                    level0.shape[3] as u32,
                    level0.shape[4] as u32,
                ];
                self.camera
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
    use crate::camera::Camera;
    use crate::command::DocumentCommand;
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
        let [coarse, fine] = ["coarse", "fine"].map(|id| scene.dataset_bounds(id).unwrap());
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
        let a = scene.dataset_plane_bounds("a").unwrap();
        let b = scene.dataset_plane_bounds("b").unwrap();
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
        assert_eq!(moved.dataset_bounds("a"), bare.dataset_bounds("a"));
        assert_eq!(moved.camera, bare.camera);
        assert_ne!(moved.placement(&id), None);
    }

    #[test]
    fn a_slice_region_reads_in_each_datasets_own_samples() {
        let mut scene = two_over_one_region();
        assert!(scene.frame(&FrameTarget::Visible, [800, 600]));
        let coarse = scene.visible_region(&DatasetId::from("coarse")).unwrap();
        let fine = scene.visible_region(&DatasetId::from("fine")).unwrap();
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
        let b = scene.dataset_plane_bounds("b").unwrap();
        assert!(close([b.max[0], b.max[1], 0.0], [128.0, 128.0, 0.0]));
    }

    #[test]
    fn framing_two_datasets_is_the_same_on_every_load() {
        let fit = || {
            let mut scene = two_over_one_region();
            scene.set_mode_3d();
            (scene.camera.clone(), scene.volume_diagonal().to_bits())
        };
        let first = fit();
        // Each scene's maps hash with their own random state, so twenty loads
        // walk the datasets in different orders.
        for _ in 0..20 {
            assert_eq!(fit(), first);
        }
        assert!(matches!(first.0, Camera::Arcball(_)));
    }
}
