//! Where each dataset sits in the one frame the whole scene shares.
//!
//! A dataset's *frame* is the level-0 sample grid of its first image, with a
//! collection's members at their layout positions, Y pointing down. The
//! *scene frame* is one physical frame for every dataset, also Y down. A
//! dataset's placement maps its frame there by its declared spacing, origin
//! and units, so datasets over the same physical region overlay. The slice
//! camera views the scene frame directly, and the volume cameras view it as
//! world space ([`WorldSpace`]), so both modes place datasets alike.
//!
//! A camera's numbers are in those two spaces ([`CameraSpace`]). They follow
//! the datasets the scene holds, so when they change, a camera someone placed
//! moves into the new ones ([`CameraSpace::map_to`]) to keep its region.

use lucida_content::{DatasetManifest, LevelGeometry};
use serde::{Deserialize, Serialize};

use crate::transform::VolumeTransform;

/// A per-axis scale and offset, `[x, y, z]`: `offset + point * scale`. Every
/// placement is axis-aligned, so this is all of one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Affine {
    pub scale: [f64; 3],
    pub offset: [f64; 3],
}

impl Affine {
    pub const IDENTITY: Affine = Affine {
        scale: [1.0; 3],
        offset: [0.0; 3],
    };

    pub fn apply(&self, point: [f64; 3]) -> [f64; 3] {
        std::array::from_fn(|i| self.offset[i] + point[i] * self.scale[i])
    }

    /// The map back. An axis with no extent maps everything to its offset, so
    /// its inverse sends the axis to zero rather than to infinity.
    pub fn inverse(&self) -> Affine {
        let scale: [f64; 3] = std::array::from_fn(|i| {
            if self.scale[i].abs() > 1e-300 {
                1.0 / self.scale[i]
            } else {
                0.0
            }
        });
        Affine {
            scale,
            offset: std::array::from_fn(|i| -self.offset[i] * scale[i]),
        }
    }

    /// This map followed by `outer`.
    pub fn then(&self, outer: &Affine) -> Affine {
        Affine {
            scale: std::array::from_fn(|i| self.scale[i] * outer.scale[i]),
            offset: std::array::from_fn(|i| self.offset[i] * outer.scale[i] + outer.offset[i]),
        }
    }

    /// How far one frame sample reaches in the plane: the smaller of its X
    /// and Y extents. A slice zoom times this is device pixels per sample, so
    /// a dataset with finer samples than the scene frame's calls for a
    /// coarser level, as it should. The smaller extent is the densest axis, the one a
    /// volume view measures too, so the level chosen errs coarse.
    pub fn plane_sample(&self) -> f64 {
        self.scale[0].abs().min(self.scale[1].abs())
    }

    /// How long a length of one along X is once mapped. A map between two
    /// scene frames, or two world spaces, stretches every axis alike, since
    /// each of those spaces measures all three axes in one length.
    pub fn length_scale(&self) -> f64 {
        self.scale[0].abs()
    }

    /// The box `[min, max]` maps to, sorted per axis since a scale can flip it.
    pub fn apply_box(&self, min: [f64; 3], max: [f64; 3]) -> ([f64; 3], [f64; 3]) {
        let a = self.apply(min);
        let b = self.apply(max);
        (
            std::array::from_fn(|i| a[i].min(b[i])),
            std::array::from_fn(|i| a[i].max(b[i])),
        )
    }

    /// Both directions as column-major `f32` matrices, as the renderer and
    /// the cameras take them.
    pub fn volume_transform(&self) -> VolumeTransform {
        VolumeTransform {
            model: matrix(self),
            inv_model: matrix(&self.inverse()),
        }
    }
}

fn matrix(a: &Affine) -> [f32; 16] {
    let [sx, sy, sz] = a.scale.map(|v| v as f32);
    let [ox, oy, oz] = a.offset.map(|v| v as f32);
    [
        sx, 0.0, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 0.0, sz, 0.0, ox, oy, oz, 1.0,
    ]
}

/// What a dataset's source declares about its frame, independent of every
/// other dataset: everything its placement needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeclaredFrame {
    /// One sample's extent, `[x, y, z]`, in the declared numbers.
    spacing: [f64; 3],
    /// The physical point at the frame's origin, in the declared numbers.
    origin: [f64; 3],
    /// Meters per declared number, when X and Y name length units.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    meters: Option<[f64; 3]>,
}

impl DeclaredFrame {
    /// The frame `manifest` declares: its first image's level-0 scale, and
    /// the units and origin of its physical space. A dataset with no image
    /// is one unit per sample at the origin.
    pub fn of(manifest: &DatasetManifest) -> Self {
        let level0 = manifest
            .images()
            .first()
            .and_then(|image| image.multiscale.levels.first());
        let space = manifest.space();
        let xyz = |zyx: [f64; 3]| [zyx[2], zyx[1], zyx[0]];
        DeclaredFrame {
            spacing: level0.map_or([1.0; 3], spacing_of),
            origin: space.map_or([0.0; 3], |s| xyz(s.origin.map(finite_or_zero))),
            meters: space.and_then(|s| s.meters_per_unit()).map(xyz),
        }
    }

    /// Whether the frame measures physical lengths, so it lines up with
    /// another such frame. Without one, a sample measures one unit.
    pub fn has_physical_scale(&self) -> bool {
        self.meters.is_some()
    }
}

/// A level's `[x, y, z]` sample extent. A scale that can't measure anything,
/// zero, negative or not finite, counts as one unit per sample.
fn spacing_of(level: &LevelGeometry) -> [f64; 3] {
    [level.scale[4], level.scale[3], level.scale[2]]
        .map(|s| if s.is_finite() && s > 0.0 { s } else { 1.0 })
}

fn finite_or_zero(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}

/// The scene frame, fixed by a reference dataset: one of its X samples
/// measures one unit, and its origin is the scene frame's.
///
/// The reference is the first dataset the document holds, so a scene with
/// one dataset has that dataset's frame as its scene frame, and a view of it
/// reads as it always has: the slice camera's numbers are its samples.
///
/// It is recorded as its reference's declared frame, so a record still
/// places datasets once the reference itself has gone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SceneFrame {
    reference: DeclaredFrame,
}

impl SceneFrame {
    pub fn new(reference: DeclaredFrame) -> Self {
        SceneFrame { reference }
    }

    /// The map from `frame` into the scene frame.
    ///
    /// Length units convert when both the reference and `frame` declare them.
    /// Otherwise their declared numbers compare as they stand, so a dataset
    /// without units measures one of the reference's declared units per
    /// declared unit of its own.
    pub fn place(&self, frame: &DeclaredFrame) -> Affine {
        let reference = &self.reference;
        let (to_common, reference_to_common) = match (frame.meters, reference.meters) {
            (Some(own), Some(reference)) => (own, reference),
            _ => ([1.0; 3], [1.0; 3]),
        };
        let unit = reference.spacing[0] * reference_to_common[0];
        Affine {
            scale: std::array::from_fn(|i| frame.spacing[i] * to_common[i] / unit),
            offset: std::array::from_fn(|i| {
                (frame.origin[i] * to_common[i] - reference.origin[i] * reference_to_common[i])
                    / unit
            }),
        }
    }

    /// The map from this scene frame into `to`. A point keeps its place on
    /// this frame's reference: the same physical point when both references
    /// declare length units, and the same declared numbers otherwise, as
    /// [`Self::place`] compares them.
    pub fn map_to(&self, to: &SceneFrame) -> Affine {
        self.place(&self.reference)
            .inverse()
            .then(&to.place(&self.reference))
    }
}

/// How the volume cameras see the scene frame, as world space: Y flipped to
/// point up about `top`, and every length divided by `extent`, so the largest
/// member measures one and the cameras' depth and speed ranges suit any data.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WorldSpace {
    extent: f64,
    top: f64,
}

impl WorldSpace {
    /// `extent` and `top` are in scene-frame units. An extent that can't
    /// divide counts as one.
    pub fn new(extent: f64, top: f64) -> Self {
        WorldSpace {
            extent: if extent.is_finite() && extent > 0.0 {
                extent
            } else {
                1.0
            },
            top: finite_or_zero(top),
        }
    }

    /// The map from the scene frame into world space.
    pub fn from_scene(&self) -> Affine {
        let inv = 1.0 / self.extent;
        Affine {
            scale: [inv, -inv, inv],
            offset: [0.0, self.top * inv, 0.0],
        }
    }
}

/// The spaces a camera's numbers are in: the scene frame, where the slice
/// camera looks, and world space, where the volume cameras look. Both follow
/// the datasets the scene holds, so a saved view records the ones it was
/// saved in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CameraSpace {
    pub frame: SceneFrame,
    pub world: WorldSpace,
}

impl CameraSpace {
    /// How numbers in these spaces read in `to`'s, which carries a camera's
    /// pose over so it shows the same region.
    pub fn map_to(&self, to: &CameraSpace) -> SpaceMap {
        let scene = self.frame.map_to(&to.frame);
        SpaceMap {
            scene,
            world: self
                .world
                .from_scene()
                .inverse()
                .then(&scene)
                .then(&to.world.from_scene()),
        }
    }
}

/// The maps from one [`CameraSpace`] into another: `scene` for the slice
/// camera's numbers, `world` for the volume cameras'.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpaceMap {
    pub scene: Affine,
    pub world: Affine,
}

/// The map from a member's unit cube to its box in the dataset's frame. The
/// box starts at the member's layout `position` and spans its level-0 `shape`
/// `[z, y, x]`. The cube's Y points up, so its top face is the image's first
/// row.
pub fn member_cube_to_frame(position: [f64; 2], shape: [u64; 5]) -> Affine {
    let [w, h, d] = [shape[4] as f64, shape[3] as f64, shape[2] as f64];
    Affine {
        scale: [w, -h, d],
        offset: [position[0], position[1] + h, 0.0],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(spacing: [f64; 3], origin: [f64; 3], meters: Option<f64>) -> DeclaredFrame {
        DeclaredFrame {
            spacing,
            origin,
            meters: meters.map(|m| [m; 3]),
        }
    }

    fn close(a: [f64; 3], b: [f64; 3]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
    }

    #[test]
    fn the_reference_frame_is_the_scene_frame_up_to_its_own_aspect() {
        let reference = frame([0.5, 0.5, 2.0], [10.0, 20.0, 30.0], Some(1e-6));
        let placed = SceneFrame::new(reference.clone()).place(&reference);
        assert_eq!(placed.offset, [0.0; 3]);
        assert!(close(placed.scale, [1.0, 1.0, 4.0]));
    }

    #[test]
    fn frames_over_one_physical_region_land_on_one_scene_box() {
        let coarse = frame([2.0, 2.0, 2.0], [100.0, 0.0, 0.0], Some(1e-6));
        let fine = frame([500.0, 500.0, 500.0], [100_000.0, 0.0, 0.0], Some(1e-9));
        let scene = SceneFrame::new(coarse.clone());
        // 64 coarse samples and 256 fine ones span the same 128 micrometers.
        let a = scene.place(&coarse).apply_box([0.0; 3], [64.0; 3]);
        let b = scene.place(&fine).apply_box([0.0; 3], [256.0; 3]);
        assert!(close(a.0, b.0) && close(a.1, b.1), "{a:?} vs {b:?}");
    }

    #[test]
    fn a_translation_offsets_the_frame_by_its_physical_size() {
        let reference = frame([0.5; 3], [0.0; 3], Some(1e-6));
        let moved = frame([0.5; 3], [0.0, 8.0, 0.0], Some(1e-6));
        let placed = SceneFrame::new(reference).place(&moved);
        // 8 micrometers is 16 samples of half a micrometer.
        assert!(close(placed.offset, [0.0, 16.0, 0.0]));
    }

    #[test]
    fn without_units_on_either_side_declared_numbers_compare_directly() {
        let reference = frame([1.0; 3], [0.0; 3], Some(1e-6));
        let bare = frame([2.0, 2.0, 2.0], [4.0, 0.0, 0.0], None);
        let placed = SceneFrame::new(reference).place(&bare);
        assert!(close(placed.scale, [2.0; 3]));
        assert!(close(placed.offset, [4.0, 0.0, 0.0]));
    }

    #[test]
    fn affines_compose_and_invert() {
        let a = Affine {
            scale: [2.0, -3.0, 0.5],
            offset: [1.0, 2.0, 3.0],
        };
        let b = Affine {
            scale: [0.25, 4.0, -1.0],
            offset: [-5.0, 0.0, 7.0],
        };
        let p = [3.0, -1.5, 8.0];
        assert!(close(a.then(&b).apply(p), b.apply(a.apply(p))));
        assert!(close(a.inverse().apply(a.apply(p)), p));
    }

    #[test]
    fn world_space_flips_y_about_the_top_and_divides_by_the_extent() {
        let space = WorldSpace::new(4.0, 2.0).from_scene();
        assert!(close(space.apply([4.0, 0.0, 2.0]), [1.0, 0.5, 0.5]));
        assert!(close(space.apply([0.0, 2.0, 0.0]), [0.0, 0.0, 0.0]));
        assert_eq!(WorldSpace::new(0.0, 0.0), WorldSpace::new(1.0, 0.0));
    }

    #[test]
    fn a_scene_frame_maps_into_another_by_the_physical_point() {
        let a = frame([1.0; 3], [0.0; 3], Some(1e-6));
        let b = frame([250.0; 3], [5_000.0, 2_000.0, 0.0], Some(1e-9));
        let (from, to) = (SceneFrame::new(a), SceneFrame::new(b.clone()));
        let map = from.map_to(&to);
        // B's sample (8, 4) is 2 by 1 micrometers past its origin at (5, 2),
        // so (7, 3) micrometers: A's sample (7, 3).
        let in_a = from.place(&b).apply([8.0, 4.0, 0.0]);
        assert!(close(in_a, [7.0, 3.0, 0.0]));
        assert!(close(map.apply(in_a), [8.0, 4.0, 0.0]));
        assert!((map.length_scale() - 4.0).abs() < 1e-9);
        assert!(close(to.map_to(&from).apply([8.0, 4.0, 0.0]), in_a));
    }

    #[test]
    fn a_camera_space_maps_world_through_the_scene_frames() {
        let a = frame([1.0; 3], [0.0; 3], Some(1e-6));
        let b = frame([2.0; 3], [10.0, 0.0, 0.0], Some(1e-6));
        let from = CameraSpace {
            frame: SceneFrame::new(a.clone()),
            world: WorldSpace::new(40.0, 20.0),
        };
        let to = CameraSpace {
            frame: SceneFrame::new(b),
            world: WorldSpace::new(8.0, 8.0),
        };
        let map = from.map_to(&to);
        // One sample of A, through each space's own placement of it.
        let world = |space: &CameraSpace| {
            space
                .frame
                .place(&a)
                .then(&space.world.from_scene())
                .apply([14.0, 6.0, 2.0])
        };
        assert!(close(map.world.apply(world(&from)), world(&to)));
        // Both world spaces point Y up, so the map stretches every axis alike.
        let k = map.world.length_scale();
        assert!(map.world.scale.iter().all(|s| (s - k).abs() < 1e-12));
        let same = from.map_to(&from);
        assert!(close(same.world.apply([1.0, 2.0, 3.0]), [1.0, 2.0, 3.0]));
    }

    #[test]
    fn a_scene_frame_records_as_its_references_declared_frame() {
        let physical = SceneFrame::new(frame([0.5, 0.5, 2.0], [1.0, 2.0, 3.0], Some(1e-6)));
        let json = serde_json::to_string(&physical).unwrap();
        assert_eq!(
            json,
            r#"{"spacing":[0.5,0.5,2.0],"origin":[1.0,2.0,3.0],"meters":[1e-6,1e-6,1e-6]}"#
        );
        assert_eq!(serde_json::from_str::<SceneFrame>(&json).unwrap(), physical);
        let bare = SceneFrame::new(frame([1.0; 3], [0.0; 3], None));
        let json = serde_json::to_string(&bare).unwrap();
        assert!(!json.contains("meters"), "{json}");
        assert_eq!(serde_json::from_str::<SceneFrame>(&json).unwrap(), bare);
    }

    #[test]
    fn a_member_cube_spans_its_layout_box_with_y_up() {
        let cube = member_cube_to_frame([10.0, 20.0], [1, 1, 4, 30, 40]);
        assert!(close(cube.apply([0.0, 1.0, 0.0]), [10.0, 20.0, 0.0]));
        assert!(close(cube.apply([1.0, 0.0, 1.0]), [50.0, 50.0, 4.0]));
    }
}
