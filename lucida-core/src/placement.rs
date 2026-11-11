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

use crate::slice_plane::SlicePlane;
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

/// Where a person put a dataset by hand, on top of where its declared frame
/// places it: stretched by `scale` and moved by `translation`, about the
/// frame's origin, the corner where its first sample starts. It changes only
/// where the scene draws the dataset, never the data or what the dataset
/// declares.
///
/// `translation` is `[x, y, z]` in the dataset's own declared numbers, so it
/// means the same whichever dataset fixes the scene frame. `rotation` is a
/// unit quaternion `[x, y, z, w]` applied between the two, held so a rotation
/// can join without a new record; this build places only the identity
/// ([`Self::is_valid`]).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct UserTransform {
    #[serde(default = "no_translation")]
    pub translation: [f64; 3],
    #[serde(default = "no_rotation")]
    pub rotation: [f64; 4],
    #[serde(default = "unit_scale")]
    pub scale: [f64; 3],
}

fn no_translation() -> [f64; 3] {
    [0.0; 3]
}

fn no_rotation() -> [f64; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

fn unit_scale() -> [f64; 3] {
    [1.0; 3]
}

impl Default for UserTransform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl UserTransform {
    pub const IDENTITY: UserTransform = UserTransform {
        translation: [0.0; 3],
        rotation: [0.0, 0.0, 0.0, 1.0],
        scale: [1.0; 3],
    };

    pub fn is_identity(&self) -> bool {
        *self == Self::IDENTITY
    }

    /// Whether a scene can place a dataset by it: every number finite, every
    /// scale above zero, so the dataset keeps a size and its orientation, and
    /// no rotation, which placement can't express yet.
    pub fn is_valid(&self) -> bool {
        self.translation.iter().all(|v| v.is_finite())
            && self.scale.iter().all(|s| s.is_finite() && *s > 0.0)
            && self.rotation == no_rotation()
    }

    /// The map this transform makes of `frame`'s samples, ahead of the
    /// frame's declared placement.
    pub fn in_frame(&self, frame: &DeclaredFrame) -> Affine {
        Affine {
            scale: self.scale,
            offset: std::array::from_fn(|i| self.translation[i] / frame.spacing[i]),
        }
    }

    /// The transform whose map of `frame`'s samples is `in_frame`, the
    /// inverse of [`Self::in_frame`] with this transform's rotation.
    fn with_frame_map(&self, frame: &DeclaredFrame, in_frame: &Affine) -> UserTransform {
        UserTransform {
            translation: std::array::from_fn(|i| in_frame.offset[i] * frame.spacing[i]),
            rotation: self.rotation,
            scale: in_frame.scale,
        }
    }

    /// This transform followed by `map`, a map of the scene frame, for a
    /// dataset of `frame` that `declared` places there: the transform that
    /// draws the dataset where `map` takes it from where this one draws it.
    pub fn then_in_scene(
        &self,
        frame: &DeclaredFrame,
        declared: &Affine,
        map: &Affine,
    ) -> UserTransform {
        let placed = self.in_frame(frame).then(declared).then(map);
        self.with_frame_map(frame, &placed.then(&declared.inverse()))
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

/// Whether two datasets line up in physical space, so either one shows the
/// same region wherever it is drawn.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum LineUp {
    /// Both declare length units and their placed extents overlap.
    Yes,
    /// The same dataset twice.
    Same,
    /// The scene holds no image for these.
    Missing {
        datasets: Vec<lucida_content::DatasetId>,
    },
    /// These declare no length units, so where they sit says nothing
    /// physical.
    NoPhysicalScale {
        datasets: Vec<lucida_content::DatasetId>,
    },
    /// Both declare lengths, and their extents share no region.
    Apart,
}

/// Whether two placed boxes, `[min, max]` per axis, share a region of some
/// size on every axis. Boxes that only touch don't.
pub fn boxes_overlap(a: ([f64; 3], [f64; 3]), b: ([f64; 3], [f64; 3])) -> bool {
    (0..3).all(|i| a.0[i] < b.1[i] && b.0[i] < a.1[i])
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

/// How a side view lays out the tiles of a collection.
///
/// One cut through the scene frame passes through a single row of tiles,
/// and the nearest hides the rest. So a side view cuts every tile at one
/// place measured from the tile's own first plane, and draws each tile's cut
/// in its own cell. A tile keeps its place in the layout, stretched so that
/// its cell holds the section, as tall as the tile is deep, and the grid
/// stays a grid.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TileCells {
    /// How far a layout position stretches down the screen: Z samples per Y
    /// sample of the tile deepest for its height.
    down: f64,
    /// How far it stretches across a YZ view, whose cells are as wide as a
    /// tile is tall: Y samples per X sample of the tile tallest for its width.
    across_yz: f64,
}

impl TileCells {
    /// The cells for tiles whose level-0 shapes, `[t, c, z, y, x]`, are
    /// `shapes`. Each ratio is the largest any tile needs, so every cell
    /// holds its tile's section.
    pub fn new(shapes: impl IntoIterator<Item = [u64; 5]>) -> Self {
        let mut cells = TileCells {
            down: 0.0,
            across_yz: 0.0,
        };
        for shape in shapes {
            let [z, y, x] = [shape[2], shape[3], shape[4]].map(|n| n.max(1) as f64);
            cells.down = cells.down.max(z / y);
            cells.across_yz = cells.across_yz.max(y / x);
        }
        if cells.down == 0.0 {
            cells.down = 1.0;
            cells.across_yz = 1.0;
        }
        cells
    }

    /// Where `plane` draws the tile at layout `position`, `[across, down]`
    /// in its dataset's samples. An XY view draws the layout as it is.
    pub fn position(&self, plane: SlicePlane, position: [f64; 2]) -> [f64; 2] {
        let [x, y] = position;
        match plane {
            SlicePlane::Xy => position,
            SlicePlane::Xz => [x, y * self.down],
            SlicePlane::Yz => [x * self.across_yz, y * self.down],
        }
    }

    /// The map a side view's axis position reads back through into a tile's
    /// own planes, for a dataset `to_scene` places: its scale alone, since
    /// the position is measured from the tile's first plane.
    pub fn cut_placement(to_scene: &Affine) -> Affine {
        Affine {
            scale: to_scene.scale,
            offset: [0.0; 3],
        }
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
    fn a_user_transform_moves_in_declared_numbers_and_scales_about_the_origin() {
        let reference = frame([1.0; 3], [0.0; 3], Some(1e-6));
        let own = frame([0.5, 0.5, 2.0], [10.0, 0.0, 0.0], Some(1e-6));
        let declared = SceneFrame::new(reference).place(&own);
        let moved = UserTransform {
            translation: [4.0, -2.0, 6.0],
            scale: [2.0, 2.0, 1.0],
            ..UserTransform::IDENTITY
        };
        let placed = moved.in_frame(&own).then(&declared);
        // The first sample moves by the translation, in micrometers here.
        assert!(close(placed.apply([0.0; 3]), [14.0, -2.0, 6.0]));
        // A sample spans twice its declared extent in X and Y.
        assert!(close(placed.scale, [1.0, 1.0, 2.0]));
        assert!(close(
            UserTransform::IDENTITY
                .in_frame(&own)
                .then(&declared)
                .offset,
            declared.offset
        ));
    }

    #[test]
    fn a_scene_map_after_a_user_transform_lands_where_it_says() {
        let reference = frame([2.0; 3], [0.0; 3], Some(1e-6));
        let own = frame([500.0; 3], [1_000.0, 0.0, 0.0], Some(1e-9));
        let declared = SceneFrame::new(reference).place(&own);
        let from = UserTransform {
            translation: [250.0, 0.0, 0.0],
            scale: [1.5; 3],
            ..UserTransform::IDENTITY
        };
        // Twice the size about scene point (10, 20, 0), then 3 across.
        let map = Affine {
            scale: [2.0, 2.0, 1.0],
            offset: [-10.0 + 3.0, -20.0, 0.0],
        };
        let after = from.then_in_scene(&own, &declared, &map);
        let p = [7.0, 9.0, 3.0];
        let expected = map.apply(from.in_frame(&own).then(&declared).apply(p));
        assert!(close(
            after.in_frame(&own).then(&declared).apply(p),
            expected
        ));
        assert!(close(after.scale, [3.0, 3.0, 1.5]));
        assert!(after.is_valid());
    }

    #[test]
    fn a_user_transform_is_valid_only_with_a_size_and_no_rotation() {
        assert!(UserTransform::IDENTITY.is_valid());
        let with = |f: fn(&mut UserTransform)| {
            let mut t = UserTransform::IDENTITY;
            f(&mut t);
            t.is_valid()
        };
        assert!(!with(|t| t.scale[1] = 0.0));
        assert!(!with(|t| t.scale[0] = -1.0));
        assert!(!with(|t| t.translation[2] = f64::NAN));
        assert!(!with(|t| t.rotation = [0.0, 0.0, 1.0, 0.0]));
    }

    #[test]
    fn a_user_transform_records_all_three_parts_and_defaults_what_it_lacks() {
        let t = UserTransform {
            translation: [1.5, 0.0, 0.0],
            scale: [2.0, 2.0, 2.0],
            ..UserTransform::IDENTITY
        };
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(
            json,
            r#"{"translation":[1.5,0.0,0.0],"rotation":[0.0,0.0,0.0,1.0],"scale":[2.0,2.0,2.0]}"#
        );
        assert_eq!(serde_json::from_str::<UserTransform>(&json).unwrap(), t);
        let sparse: UserTransform = serde_json::from_str(r#"{"scale":[3,3,3]}"#).unwrap();
        assert_eq!(sparse.translation, [0.0; 3]);
        assert_eq!(sparse.rotation, [0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn boxes_overlap_only_when_they_share_a_region_on_every_axis() {
        let unit = ([0.0; 3], [1.0; 3]);
        assert!(boxes_overlap(unit, ([0.5; 3], [2.0; 3])));
        assert!(!boxes_overlap(unit, ([1.0, 0.0, 0.0], [2.0, 1.0, 1.0])));
        assert!(!boxes_overlap(unit, ([0.0, 0.0, 3.0], [1.0, 1.0, 4.0])));
    }

    #[test]
    fn a_side_view_stretches_the_layout_so_each_cell_holds_its_tiles_section() {
        // Tiles 100 wide, 50 tall and 20 deep, laid out with a gap of 10.
        let cells = TileCells::new([[1, 1, 20, 50, 100]; 4]);
        let second_row = [0.0, 60.0];
        let second_column = [110.0, 0.0];
        assert_eq!(cells.position(SlicePlane::Xy, [110.0, 60.0]), [110.0, 60.0]);
        // Rows stack 20 deep with a gap of 4, the layout's gap stretched alike.
        assert_eq!(cells.position(SlicePlane::Xz, second_row), [0.0, 24.0]);
        assert_eq!(cells.position(SlicePlane::Xz, second_column), [110.0, 0.0]);
        // Across a YZ view a cell is as wide as its tile is tall.
        assert_eq!(cells.position(SlicePlane::Yz, second_column), [55.0, 0.0]);
        assert_eq!(cells.position(SlicePlane::Yz, second_row), [0.0, 24.0]);
    }

    #[test]
    fn tile_cells_take_the_room_the_largest_section_needs() {
        let cells = TileCells::new([[1, 1, 10, 50, 50], [1, 1, 40, 40, 20]]);
        assert_eq!(cells.position(SlicePlane::Xz, [0.0, 10.0]), [0.0, 10.0]);
        assert_eq!(cells.position(SlicePlane::Yz, [10.0, 0.0]), [20.0, 0.0]);
        assert_eq!(TileCells::new([]), TileCells::new([[1, 1, 1, 1, 1]]));
    }

    #[test]
    fn a_tile_cut_reads_the_position_from_the_tiles_own_edge() {
        let to_scene = Affine {
            scale: [0.5, 2.0, 1.0],
            offset: [100.0, 200.0, 0.0],
        };
        let cut = TileCells::cut_placement(&to_scene).inverse();
        assert!(close(cut.apply([3.0, 9.0, 0.0]), [6.0, 4.5, 0.0]));
    }

    #[test]
    fn a_member_cube_spans_its_layout_box_with_y_up() {
        let cube = member_cube_to_frame([10.0, 20.0], [1, 1, 4, 30, 40]);
        assert!(close(cube.apply([0.0, 1.0, 0.0]), [10.0, 20.0, 0.0]));
        assert!(close(cube.apply([1.0, 0.0, 1.0]), [50.0, 50.0, 4.0]));
    }
}
