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

use crate::camera::{quat_from_axis_angle, quat_multiply};
use crate::slice_plane::SlicePlane;
use crate::transform::VolumeTransform;

/// A map of `[x, y, z]` points: `linear * point + offset`. `linear` is by
/// rows, so `linear[r][c]` is how far output axis `r` moves per unit along
/// input axis `c`. A dataset's placement can turn it as well as stretch and
/// move it, so nothing that maps between a frame and the scene may read one
/// axis as one axis.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Affine {
    pub linear: [[f64; 3]; 3],
    pub offset: [f64; 3],
}

const NO_TURN: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// Below this an entry off the diagonal counts as none.
const ALIGNED_EPSILON: f64 = 1e-12;

impl Affine {
    pub const IDENTITY: Affine = Affine {
        linear: NO_TURN,
        offset: [0.0; 3],
    };

    /// The map that stretches each axis by `scale` and then moves by
    /// `offset`, turning nothing.
    pub fn axis_aligned(scale: [f64; 3], offset: [f64; 3]) -> Affine {
        let mut linear = [[0.0; 3]; 3];
        for (i, row) in linear.iter_mut().enumerate() {
            row[i] = scale[i];
        }
        Affine { linear, offset }
    }

    pub fn apply(&self, point: [f64; 3]) -> [f64; 3] {
        std::array::from_fn(|r| self.offset[r] + self.apply_vector_row(r, point))
    }

    /// Where a displacement goes, the offset left out.
    pub fn apply_vector(&self, vector: [f64; 3]) -> [f64; 3] {
        std::array::from_fn(|r| self.apply_vector_row(r, vector))
    }

    fn apply_vector_row(&self, r: usize, v: [f64; 3]) -> f64 {
        self.linear[r][0] * v[0] + self.linear[r][1] * v[1] + self.linear[r][2] * v[2]
    }

    /// Whether every input axis maps onto the output axis of the same index.
    pub fn is_axis_aligned(&self) -> bool {
        (0..3).all(|r| (0..3).all(|c| r == c || self.linear[r][c].abs() < ALIGNED_EPSILON))
    }

    /// Whether axis `a` maps onto axis `a` and nothing else maps onto it, so
    /// a plane across `a` maps to a plane across `a`. A turn about `a` keeps
    /// it; a turn about any other axis tilts it.
    pub fn keeps_axis(&self, a: usize) -> bool {
        (0..3).all(|j| {
            j == a
                || (self.linear[a][j].abs() < ALIGNED_EPSILON
                    && self.linear[j][a].abs() < ALIGNED_EPSILON)
        })
    }

    /// Where a unit step along input axis `c` goes.
    pub fn column(&self, c: usize) -> [f64; 3] {
        std::array::from_fn(|r| self.linear[r][c])
    }

    /// The map back. An axis-aligned map with an axis of no extent maps
    /// everything on it to its offset, so its inverse sends the axis to zero
    /// rather than to infinity. A map that turns comes only from placements,
    /// which keep every axis, so it always has an inverse.
    pub fn inverse(&self) -> Affine {
        if self.is_axis_aligned() {
            let scale: [f64; 3] = std::array::from_fn(|i| {
                let s = self.linear[i][i];
                if s.abs() > 1e-300 { 1.0 / s } else { 0.0 }
            });
            return Affine::axis_aligned(
                scale,
                std::array::from_fn(|i| -self.offset[i] * scale[i]),
            );
        }
        let m = &self.linear;
        let cofactor = |r: usize, c: usize| {
            let (r0, r1) = ((r + 1) % 3, (r + 2) % 3);
            let (c0, c1) = ((c + 1) % 3, (c + 2) % 3);
            m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0]
        };
        let det = m[0][0] * cofactor(0, 0) + m[0][1] * cofactor(0, 1) + m[0][2] * cofactor(0, 2);
        let inv_det = if det.abs() > 1e-300 { 1.0 / det } else { 0.0 };
        // The inverse is the transposed cofactors over the determinant.
        let linear: [[f64; 3]; 3] =
            std::array::from_fn(|r| std::array::from_fn(|c| cofactor(c, r) * inv_det));
        let back = Affine {
            linear,
            offset: [0.0; 3],
        };
        let offset = back.apply_vector(self.offset).map(|v| -v);
        Affine { linear, offset }
    }

    /// This map followed by `outer`.
    pub fn then(&self, outer: &Affine) -> Affine {
        let linear: [[f64; 3]; 3] = std::array::from_fn(|r| {
            std::array::from_fn(|c| (0..3).map(|k| outer.linear[r][k] * self.linear[k][c]).sum())
        });
        Affine {
            linear,
            offset: outer.apply(self.offset),
        }
    }

    /// How far one frame sample reaches in the plane: the shorter of the
    /// lengths an X step and a Y step map to. A slice zoom times this is
    /// device pixels per sample, so a dataset with finer samples than the
    /// scene frame's calls for a coarser level, as it should. The shorter
    /// step is the densest axis, the one a volume view measures too, so the
    /// level chosen errs coarse.
    pub fn plane_sample(&self) -> f64 {
        norm(self.column(0)).min(norm(self.column(1)))
    }

    /// How long a length of one along X is once mapped. A map between two
    /// scene frames, or two world spaces, stretches every axis alike, since
    /// each of those spaces measures all three axes in one length.
    pub fn length_scale(&self) -> f64 {
        norm(self.column(0))
    }

    /// How far along output axis `a` one sample's step reaches: the
    /// distance along `a` that moves a point one sample through the input,
    /// whichever way the map turns it. An axis-aligned map steps by its
    /// scale on that axis.
    pub fn step_along(&self, a: usize) -> f64 {
        let back = norm(self.inverse().column(a));
        if back > 1e-300 { 1.0 / back } else { 0.0 }
    }

    /// The box `[min, max]` maps to: the smallest box, per axis, around all
    /// eight of its corners, since a map can turn or flip it.
    pub fn apply_box(&self, min: [f64; 3], max: [f64; 3]) -> ([f64; 3], [f64; 3]) {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for corner in 0..8 {
            let point: [f64; 3] = std::array::from_fn(|i| {
                if corner & (1 << i) == 0 {
                    min[i]
                } else {
                    max[i]
                }
            });
            let mapped = self.apply(point);
            for i in 0..3 {
                lo[i] = lo[i].min(mapped[i]);
                hi[i] = hi[i].max(mapped[i]);
            }
        }
        (lo, hi)
    }

    /// Both directions as column-major `f32` matrices, as the renderer and
    /// the cameras take them.
    pub fn volume_transform(&self) -> VolumeTransform {
        VolumeTransform {
            model: matrix(self),
            inv_model: matrix(&self.inverse()),
        }
    }

    /// This map as a column-major 4x4 matrix.
    pub fn matrix_f64(&self) -> [f64; 16] {
        let m = &self.linear;
        let o = &self.offset;
        [
            m[0][0], m[1][0], m[2][0], 0.0, m[0][1], m[1][1], m[2][1], 0.0, m[0][2], m[1][2],
            m[2][2], 0.0, o[0], o[1], o[2], 1.0,
        ]
    }
}

fn norm(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn matrix(a: &Affine) -> [f32; 16] {
    a.matrix_f64().map(|v| v as f32)
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

    #[cfg(test)]
    pub(crate) fn from_parts(
        spacing: [f64; 3],
        origin: [f64; 3],
        meters: Option<[f64; 3]>,
    ) -> Self {
        DeclaredFrame {
            spacing,
            origin,
            meters,
        }
    }

    /// One sample's extent along `[x, y, z]`, in meters when the frame
    /// measures physical lengths and in declared numbers otherwise: the
    /// lengths a turn of the dataset compares.
    fn sample_extent(&self) -> [f64; 3] {
        self.sample_meters().unwrap_or(self.spacing)
    }

    /// One sample's length in meters along `[x, y, z]`, when the frame
    /// measures physical lengths.
    pub fn sample_meters(&self) -> Option<[f64; 3]> {
        let meters = self.meters?;
        Some(std::array::from_fn(|i| self.spacing[i] * meters[i]))
    }
}

/// Where a person put a dataset by hand, on top of where its declared frame
/// places it: stretched by `scale`, turned by `rotation` and moved by
/// `translation`, about the frame's origin, the corner where its first sample
/// starts. It changes only where the scene draws the dataset, never the data
/// or what the dataset declares.
///
/// `translation` is `[x, y, z]` in the dataset's own declared numbers, so it
/// means the same whichever dataset fixes the scene frame. `rotation` is a
/// unit quaternion `[x, y, z, w]`. A person reads and sets it as angles about
/// X, then Y, then Z ([`rotation_from_degrees`]), and turns a dataset about
/// its center ([`Self::turned_to`]), while the record keeps the frame's
/// origin, so it means one thing however it was set.
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
    /// a rotation of unit length, which turns it without stretching it.
    pub fn is_valid(&self) -> bool {
        let length = self.rotation.iter().map(|v| v * v).sum::<f64>().sqrt();
        self.translation.iter().all(|v| v.is_finite())
            && self.scale.iter().all(|s| s.is_finite() && *s > 0.0)
            && (length - 1.0).abs() <= UNIT_ROTATION_TOLERANCE
    }

    /// This transform turned to `rotation` about `pivot`, a point of
    /// `frame`'s samples that stays where this transform puts it. The scale
    /// stays as it is.
    pub fn turned_to(
        &self,
        frame: &DeclaredFrame,
        rotation: [f64; 4],
        pivot: [f64; 3],
    ) -> UserTransform {
        let turned = UserTransform { rotation, ..*self };
        let held = self.in_frame(frame).apply(pivot);
        let moved = turned.in_frame(frame).apply(pivot);
        UserTransform {
            translation: std::array::from_fn(|i| {
                self.translation[i] + (held[i] - moved[i]) * frame.spacing[i]
            }),
            ..turned
        }
    }

    /// The map this transform makes of `frame`'s samples, ahead of the
    /// frame's declared placement. The scale and the turn act on the
    /// samples' physical extents, so a turned dataset whose samples are
    /// longer on one axis keeps its true shape.
    pub fn in_frame(&self, frame: &DeclaredFrame) -> Affine {
        let extent = frame.sample_extent();
        let turn = rotation_matrix(self.rotation);
        Affine {
            linear: std::array::from_fn(|r| {
                std::array::from_fn(|c| turn[r][c] * self.scale[c] * extent[c] / extent[r])
            }),
            offset: std::array::from_fn(|i| self.translation[i] / frame.spacing[i]),
        }
    }

    /// The transform with this one's rotation whose map of `frame`'s samples
    /// is `in_frame`, as near as a scale along the dataset's own axes comes:
    /// the inverse of [`Self::in_frame`].
    fn with_frame_map(&self, frame: &DeclaredFrame, in_frame: &Affine) -> UserTransform {
        let extent = frame.sample_extent();
        let turn = rotation_matrix(self.rotation);
        // The turn's inverse is its transpose, which undoes it on the
        // physical extents and leaves the scale on the diagonal.
        let scale = std::array::from_fn(|c| {
            (0..3)
                .map(|k| turn[k][c] * extent[k] * in_frame.linear[k][c] / extent[c])
                .sum()
        });
        UserTransform {
            translation: std::array::from_fn(|i| in_frame.offset[i] * frame.spacing[i]),
            rotation: self.rotation,
            scale,
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

/// How far a stored rotation's length may stray from one, as the rounding of
/// angles turned into a quaternion leaves it.
const UNIT_ROTATION_TOLERANCE: f64 = 1e-6;

/// The rotation that turns by `degrees[0]` about X, then `degrees[1]` about
/// Y, then `degrees[2]` about Z, each about the axis as the turns before it
/// left it: the order a person reads a user transform's rotation in.
pub fn rotation_from_degrees(degrees: [f64; 3]) -> [f64; 4] {
    let [x, y, z] = [0, 1, 2].map(|a| {
        let mut axis = [0.0; 3];
        axis[a] = 1.0;
        quat_from_axis_angle(axis, degrees[a].to_radians())
    });
    quat_multiply(quat_multiply(x, y), z)
}

/// The angles [`rotation_from_degrees`] takes to make `rotation`: X and Z in
/// (-180, 180], Y in [-90, 90].
///
/// At a quarter turn about Y, X and Z turn about the same line, so only their
/// sum, or their difference, is known. There Y reads exactly ±90, Z reads
/// zero and X holds the whole turn, the one reading of every such rotation.
pub fn rotation_degrees(rotation: [f64; 4]) -> [f64; 3] {
    let m = rotation_matrix(rotation);
    // Y from its sine and cosine together: an arcsine near a quarter turn
    // loses half the digits its input has.
    let cos_y = m[0][0].hypot(m[0][1]);
    let [x, y, z] = if cos_y > QUARTER_TURN_COSINE {
        [
            (-m[1][2]).atan2(m[2][2]),
            m[0][2].atan2(cos_y),
            (-m[0][1]).atan2(m[0][0]),
        ]
    } else {
        [
            m[2][1].atan2(m[1][1]),
            std::f64::consts::FRAC_PI_2.copysign(m[0][2]),
            0.0,
        ]
    };
    // A quaternion carries rounding nobody typed, so the angles keep nine
    // decimals, and adding zero reads a negative zero as zero.
    [x, y, z].map(|a| (a.to_degrees() * 1e9).round() / 1e9 + 0.0)
}

/// Below this cosine of Y, a rotation reads as a quarter turn about Y. It
/// sits far above a quaternion's rounding and far below the cosine of any
/// angle a person types short of 90.
const QUARTER_TURN_COSINE: f64 = 1e-9;

/// The turn a quaternion `[x, y, z, w]` makes, by rows. It is scaled to a
/// unit quaternion first; one with no length turns nothing.
fn rotation_matrix(q: [f64; 4]) -> [[f64; 3]; 3] {
    let length = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if !(length.is_finite() && length > 0.0) {
        return NO_TURN;
    }
    let [x, y, z, w] = q.map(|v| v / length);
    [
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y - z * w),
            2.0 * (x * z + y * w),
        ],
        [
            2.0 * (x * y + z * w),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z - x * w),
        ],
        [
            2.0 * (x * z - y * w),
            2.0 * (y * z + x * w),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ]
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
        Affine::axis_aligned(
            std::array::from_fn(|i| frame.spacing[i] * to_common[i] / unit),
            std::array::from_fn(|i| {
                (frame.origin[i] * to_common[i] - reference.origin[i] * reference_to_common[i])
                    / unit
            }),
        )
    }

    /// Where `place`, along axis `a` of this frame, lies in physical space,
    /// in meters from the origin the dataset that fixed the frame declares
    /// its place against, with the meters one unit of the frame measures.
    /// `None` when that dataset declares no length units.
    pub fn place_meters(&self, a: usize, place: f64) -> Option<(f64, f64)> {
        let meters = self.reference.meters?;
        let unit = self.reference.spacing[0] * meters[0];
        Some((self.reference.origin[a] * meters[a] + place * unit, unit))
    }

    /// The map from the frame of the dataset that fixed this one into it.
    pub fn place_reference(&self) -> Affine {
        self.place(&self.reference)
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
        Affine::axis_aligned([inv, -inv, inv], [0.0, self.top * inv, 0.0])
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
    Affine::axis_aligned([w, -h, d], [position[0], position[1] + h, 0.0])
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

    /// How far `plane` draws a sample of the tile at layout `position` from
    /// where its dataset's frame puts it, `[x, y, z]` in the dataset's
    /// samples. The tile's sample `p` draws at `p + shift` in the frame the
    /// view places: at its own place in the tile's cell on the two axes the
    /// plane draws, and along the cut at its place from the tile's own edge,
    /// where the view reads every tile. Taking it away undoes the move, so
    /// a point picked in a cell lands on the tile's own samples.
    pub fn shift(&self, plane: SlicePlane, position: [f64; 2]) -> [f64; 3] {
        let cell = plane.frame_point(self.position(plane, position));
        [cell[0] - position[0], cell[1] - position[1], cell[2]]
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

    /// The stretch an axis-aligned map makes on each axis.
    fn diagonal(a: &Affine) -> [f64; 3] {
        std::array::from_fn(|i| a.linear[i][i])
    }

    fn close(a: [f64; 3], b: [f64; 3]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
    }

    #[test]
    fn the_reference_frame_is_the_scene_frame_up_to_its_own_aspect() {
        let reference = frame([0.5, 0.5, 2.0], [10.0, 20.0, 30.0], Some(1e-6));
        let placed = SceneFrame::new(reference.clone()).place(&reference);
        assert_eq!(placed.offset, [0.0; 3]);
        assert!(close(diagonal(&placed), [1.0, 1.0, 4.0]));
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
        assert!(close(diagonal(&placed), [2.0; 3]));
        assert!(close(placed.offset, [4.0, 0.0, 0.0]));
    }

    #[test]
    fn affines_compose_and_invert() {
        let a = Affine::axis_aligned([2.0, -3.0, 0.5], [1.0, 2.0, 3.0]);
        let b = Affine::axis_aligned([0.25, 4.0, -1.0], [-5.0, 0.0, 7.0]);
        let p = [3.0, -1.5, 8.0];
        assert!(close(a.then(&b).apply(p), b.apply(a.apply(p))));
        assert!(close(a.inverse().apply(a.apply(p)), p));
    }

    /// A turn of `radians` about `axis` (0, 1 or 2) as a unit quaternion.
    fn turn(axis: usize, radians: f64) -> [f64; 4] {
        let mut q = [0.0, 0.0, 0.0, (radians / 2.0).cos()];
        q[axis] = (radians / 2.0).sin();
        q
    }

    #[test]
    fn affines_that_turn_compose_and_invert() {
        let turned = UserTransform {
            translation: [3.0, -2.0, 1.0],
            rotation: turn(1, 0.7),
            scale: [2.0, 0.5, 1.5],
        }
        .in_frame(&frame([1.0, 2.0, 3.0], [0.0; 3], None));
        let other = Affine::axis_aligned([0.25, 4.0, -1.0], [-5.0, 0.0, 7.0]);
        let p = [3.0, -1.5, 8.0];
        assert!(!turned.is_axis_aligned());
        assert!(close(
            turned.then(&other).apply(p),
            other.apply(turned.apply(p))
        ));
        assert!(close(
            other.then(&turned).apply(p),
            turned.apply(other.apply(p))
        ));
        assert!(close(turned.inverse().apply(turned.apply(p)), p));
    }

    #[test]
    fn a_turned_box_spans_all_its_corners() {
        let quarter = UserTransform {
            rotation: turn(2, std::f64::consts::FRAC_PI_4),
            ..UserTransform::IDENTITY
        }
        .in_frame(&frame([1.0; 3], [0.0; 3], None));
        let (min, max) = quarter.apply_box([0.0; 3], [2.0, 2.0, 1.0]);
        let r = 2.0 * std::f64::consts::FRAC_1_SQRT_2;
        assert!(close(min, [-r, 0.0, 0.0]), "{min:?}");
        assert!(close(max, [r, 2.0 * r, 1.0]), "{max:?}");
    }

    #[test]
    fn a_turn_keeps_its_own_axis_and_tilts_the_others() {
        let about_z = UserTransform {
            rotation: turn(2, 0.3),
            ..UserTransform::IDENTITY
        }
        .in_frame(&frame([1.0; 3], [0.0; 3], None));
        assert!(about_z.keeps_axis(2));
        assert!(!about_z.keeps_axis(0) && !about_z.keeps_axis(1));
        assert!(Affine::axis_aligned([2.0, -1.0, 3.0], [1.0; 3]).keeps_axis(0));
    }

    #[test]
    fn a_turn_acts_on_the_samples_physical_extents() {
        // Samples twice as long in Y as in X, turned a quarter about Z.
        let own = frame([1.0, 2.0, 1.0], [0.0; 3], Some(1e-6));
        let quarter = UserTransform {
            rotation: turn(2, std::f64::consts::FRAC_PI_2),
            ..UserTransform::IDENTITY
        }
        .in_frame(&own);
        // One X sample, one micrometer, turns onto Y: half a Y sample.
        assert!(
            close(quarter.column(0), [0.0, 0.5, 0.0]),
            "{:?}",
            quarter.column(0)
        );
        // One Y sample, two micrometers, turns onto minus X: two X samples.
        assert!(
            close(quarter.column(1), [-2.0, 0.0, 0.0]),
            "{:?}",
            quarter.column(1)
        );
        // Along Z it still steps a sample, and along Y half of one.
        assert!((quarter.step_along(2) - 1.0).abs() < 1e-12);
        assert!((quarter.step_along(1) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn a_scene_map_after_a_turned_user_transform_keeps_the_turn() {
        let reference = frame([1.0; 3], [0.0; 3], Some(1e-6));
        let own = frame([0.5, 0.5, 2.0], [0.0; 3], Some(1e-6));
        let declared = SceneFrame::new(reference).place(&own);
        let from = UserTransform {
            translation: [1.0, 2.0, 0.0],
            rotation: turn(2, 0.4),
            scale: [1.5, 1.5, 1.0],
        };
        // Twice the size about scene point (3, 4, 0), then 5 across.
        let map = Affine::axis_aligned([2.0, 2.0, 1.0], [-3.0 + 5.0, -4.0, 0.0]);
        let after = from.then_in_scene(&own, &declared, &map);
        let p = [7.0, 9.0, 3.0];
        let expected = map.apply(from.in_frame(&own).then(&declared).apply(p));
        assert!(close(
            after.in_frame(&own).then(&declared).apply(p),
            expected
        ));
        assert_eq!(after.rotation, from.rotation);
        assert!(close(after.scale, [3.0, 3.0, 1.0]));
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
        assert!(diagonal(&map.world).iter().all(|s| (s - k).abs() < 1e-12));
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
        assert!(close(diagonal(&placed), [1.0, 1.0, 2.0]));
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
        let map = Affine::axis_aligned([2.0, 2.0, 1.0], [-10.0 + 3.0, -20.0, 0.0]);
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
    fn a_user_transform_is_valid_only_with_a_size_and_a_unit_rotation() {
        assert!(UserTransform::IDENTITY.is_valid());
        let with = |f: fn(&mut UserTransform)| {
            let mut t = UserTransform::IDENTITY;
            f(&mut t);
            t.is_valid()
        };
        assert!(!with(|t| t.scale[1] = 0.0));
        assert!(!with(|t| t.scale[0] = -1.0));
        assert!(!with(|t| t.translation[2] = f64::NAN));
        assert!(with(|t| t.rotation = [0.0, 0.0, 1.0, 0.0]));
        assert!(with(
            |t| t.rotation = rotation_from_degrees([10.0, -20.0, 30.0])
        ));
        assert!(!with(|t| t.rotation = [0.0, 0.0, 0.5, 0.5]));
        assert!(!with(|t| t.rotation = [0.0; 4]));
        assert!(!with(|t| t.rotation = [f64::NAN, 0.0, 0.0, 1.0]));
    }

    #[test]
    fn angles_turn_about_x_then_y_then_z_and_read_back() {
        // A quarter turn about X, then one about the Y that left: X's axis
        // ends along Y, Y's along Z, and Z's along X.
        let m = rotation_matrix(rotation_from_degrees([90.0, 90.0, 0.0]));
        let column = |c: usize| [m[0][c], m[1][c], m[2][c]];
        assert!(close(column(0), [0.0, 1.0, 0.0]));
        assert!(close(column(1), [0.0, 0.0, 1.0]));
        assert!(close(column(2), [1.0, 0.0, 0.0]));
        // Away from a quarter turn about Y, the angles read back as typed.
        for degrees in [
            [30.0, 0.0, 0.0],
            [10.0, -20.0, 30.0],
            [-170.0, 45.0, 120.0],
            [20.0, 30.0, 0.0],
        ] {
            assert_eq!(rotation_degrees(rotation_from_degrees(degrees)), degrees);
        }
        assert_eq!(rotation_degrees(no_rotation()), [0.0; 3]);
        // Near one they still make the same rotation, if not the same digits.
        for degrees in [[10.0, 89.999, 30.0], [-40.0, -89.999, 75.0]] {
            let read = rotation_degrees(rotation_from_degrees(degrees));
            assert!(same_rotation(
                rotation_from_degrees(read),
                rotation_from_degrees(degrees)
            ));
            assert!((read[1] - degrees[1]).abs() < 1e-6);
        }
        // At one, X and Z share a line: Y reads exactly a quarter turn, Z
        // zero, and X their sum at +90 or their difference at -90.
        for (typed, canonical) in [
            ([20.0, 90.0, 0.0], [20.0, 90.0, 0.0]),
            ([20.0, 90.0, 15.0], [35.0, 90.0, 0.0]),
            ([20.0, -90.0, 15.0], [5.0, -90.0, 0.0]),
        ] {
            let rotation = rotation_from_degrees(typed);
            let read = rotation_degrees(rotation);
            assert_eq!(read[1], canonical[1]);
            assert_eq!(read[2], 0.0);
            assert!((read[0] - canonical[0]).abs() < 1e-6);
            assert!(same_rotation(rotation_from_degrees(read), rotation));
        }
    }

    /// Whether two unit quaternions turn alike: `q` and `-q` do.
    fn same_rotation(a: [f64; 4], b: [f64; 4]) -> bool {
        let dot: f64 = a.iter().zip(b).map(|(x, y)| x * y).sum();
        (dot.abs() - 1.0).abs() < 1e-12
    }

    #[test]
    fn a_turn_keeps_its_pivot_where_it_was_and_the_scale_as_it_was() {
        let own = frame([0.5, 0.5, 2.0], [100.0, 0.0, 0.0], Some(1e-6));
        let from = UserTransform {
            translation: [3.0, -4.0, 1.0],
            scale: [2.0, 1.0, 1.5],
            ..UserTransform::IDENTITY
        };
        let pivot = [64.0, 32.0, 8.0];
        let rotation = rotation_from_degrees([0.0, 15.0, 30.0]);
        let turned = from.turned_to(&own, rotation, pivot);
        assert!(close(
            turned.in_frame(&own).apply(pivot),
            from.in_frame(&own).apply(pivot)
        ));
        assert_eq!(turned.rotation, rotation);
        assert_eq!(turned.scale, from.scale);
        assert!(turned.is_valid());
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
    fn a_tiles_shift_puts_its_samples_in_its_cell_and_its_cut_at_its_own_edge() {
        // Tiles 100 wide, 50 tall and 20 deep, laid out with a gap of 10.
        let cells = TileCells::new([[1, 1, 20, 50, 100]; 4]);
        let position = [110.0, 60.0];
        // The tile's sample 30 across, 5 down and 7 deep.
        let sample = [140.0, 65.0, 7.0];
        let drawn = |plane| {
            let shift = cells.shift(plane, position);
            std::array::from_fn::<f64, 3, _>(|i| sample[i] + shift[i])
        };
        assert_eq!(cells.shift(SlicePlane::Xy, position), [0.0; 3]);
        for plane in [SlicePlane::Xz, SlicePlane::Yz] {
            let [across, down, cut] = plane.axes().map(|a| a.xyz());
            let cell = cells.position(plane, position);
            let local = [30.0, 5.0, 7.0];
            let at = drawn(plane);
            // On screen it is as far into its cell as into the tile.
            assert_eq!(at[across] - cell[0], local[across], "{plane}");
            assert_eq!(at[down] - cell[1], local[down], "{plane}");
            // Along the cut it is where the view reads every tile.
            assert_eq!(at[cut], local[cut], "{plane}");
        }
    }

    #[test]
    fn a_member_cube_spans_its_layout_box_with_y_up() {
        let cube = member_cube_to_frame([10.0, 20.0], [1, 1, 4, 30, 40]);
        assert!(close(cube.apply([0.0, 1.0, 0.0]), [10.0, 20.0, 0.0]));
        assert!(close(cube.apply([1.0, 0.0, 1.0]), [50.0, 50.0, 4.0]));
    }
}
