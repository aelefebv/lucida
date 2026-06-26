//! Pure, mode-aware parametric view-transform generator — the shared engine
//! behind the "guided exploration" feature (later driven by the CLI, Python,
//! and web surfaces).
//!
//! Guided exploration asks a simple question: from *this* view of a dataset,
//! what are the small, sensible moves a user might want to take next — and what
//! does each one land on? This module answers that as a pure function over
//! [`SavedView`]: given a view and the dataset's [`ViewExtent`], it enumerates a
//! fixed *move-set* ([`ViewTransform`]) and returns the resulting child views,
//! each with a stable [`view_handle`] and a plain-language label.
//!
//! ## Design constraints (load-bearing)
//!
//! - **Pure.** [`apply`] and [`children`] never mutate their inputs — they clone
//!   the [`SavedView`] and mutate the copy. Callers can fan out across the
//!   move-set without disturbing the current view.
//! - **Mode-aware.** A move that makes no sense in the current camera mode is
//!   simply not offered: a 2D [`Slice`](crate::camera::Slice) view yields no
//!   azimuth (rotate) cells, a [`Fly`](crate::camera::Fly) camera yields no zoom
//!   cell, and a flat (`z_count <= 1`) dataset yields no slice-step cells. All of
//!   that filtering lives in [`ViewTransform::applies_to`] + [`apply`], so
//!   [`children`] stays a dumb "try them all, keep what sticks" loop.
//! - **No camera math here.** Every spatial move delegates to an existing
//!   [`Camera`] primitive ([`Camera::fit_to_bounds`],
//!   [`Arcball::rotate`](crate::camera::Arcball::rotate),
//!   [`Slice::zoom_by`](crate::camera::Slice::zoom_by)). This module is wiring +
//!   policy, never geometry.
//! - **Fail-safe.** No panics on degenerate input — a zero-count extent, an
//!   equal-min/max box, or a [`Fly`](crate::camera::Fly) camera all resolve to
//!   "that move isn't available" ([`None`]) rather than an error.
//!
//! It deliberately does **not** touch `ViewportCommand` or the `dataset montage`
//! code: those are separate surfaces. The output here is a plain data structure
//! ([`ExplorationSidecar`]) the higher tiers serialize and render.

use serde::{Deserialize, Serialize};

use crate::camera::Camera;
use crate::saved_view::SavedView;
use crate::scene::DatasetDisplaySettings;
use crate::view::ViewState;
use lucida_content::DatasetId;

/// The spatial + dimensional extent of the dataset(s) a view is exploring.
///
/// `min`/`max` are the world-space bounding box (the same coordinate space
/// [`Camera::fit_to_bounds`] expects); the `*_count` fields are the sizes of the
/// non-spatial axes. The counts gate dimensional moves — `z_count <= 1` means a
/// flat dataset with no slices to step through. Supplied by the caller, which
/// owns dataset geometry; this module treats it as read-only context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewExtent {
    /// World-space minimum corner `[x, y, z]`.
    pub min: [f64; 3],
    /// World-space maximum corner `[x, y, z]`.
    pub max: [f64; 3],
    /// Number of Z slices in the dataset.
    pub z_count: u32,
    /// Number of timepoints.
    pub t_count: u32,
    /// Number of channels.
    pub c_count: u32,
}

impl ViewExtent {
    /// Build a [`ViewExtent`] from a dataset shape `dims = [T, C, Z, Y, X]`.
    ///
    /// The world-space box spans the full image in X/Y and the Z stack in depth
    /// (`min` at the origin, `max` at `[X, Y, Z]`); the `*_count` fields carry
    /// the non-spatial axis sizes the move-set gates on (a flat `z_count <= 1`
    /// dataset offers no slice-step cells). This is the single source of the
    /// `[T,C,Z,Y,X]` → extent mapping shared by the CLI, Python, and web tiers.
    pub fn from_dims(dims: [u64; 5]) -> Self {
        let [t, c, z, y, x] = dims;
        ViewExtent {
            min: [0.0, 0.0, 0.0],
            max: [x as f64, y as f64, z as f64],
            z_count: z as u32,
            t_count: t as u32,
            c_count: c as u32,
        }
    }
}

/// Synthesize a dataset's "Home" view — the exploration root when a caller gives
/// no explicit view.
///
/// A volume (`z_count > 1`) opens in a 3D [`Camera::Arcball`] so the
/// orbit/azimuth cells are offered; a flat image opens in a 2D
/// [`Camera::Slice`]. Either way the camera is framed to the dataset's full
/// extent ([`Camera::fit_to_bounds`] is mode-preserving), the dataset is made
/// visible (auto-contrast on, with a default display-settings entry — an absent
/// entry would otherwise reset the colormap), and the view sits on the mid-Z
/// single slice (so a [`StepZ`](ViewTransform::StepZ) in either direction is in
/// range on a volume; a flat dataset collapses to `z 0..1`).
///
/// `dims = [T, C, Z, Y, X]`. Pure — the single source of the exploration root,
/// shared by the CLI, the pyo3 binding, and the web tier.
pub fn default_view(ds_id: &str, dims: [u64; 5], viewport: [u32; 2]) -> SavedView {
    let extent = ViewExtent::from_dims(dims);
    let z_count = extent.z_count;

    let mut view = SavedView::empty(viewport);
    let id = DatasetId(ds_id.to_string());
    view.dataset_order = vec![id.clone()];
    // Make the dataset visible: a default display-settings entry (an absent
    // entry would otherwise reset the colormap) plus auto-contrast on.
    view.dataset_settings
        .insert(id.clone(), DatasetDisplaySettings::default());
    view.auto_contrast.insert(id, true);

    // Start on a single mid-stack slice (so a StepZ in either direction is in
    // range on a volume); a flat dataset collapses to z 0..1 anyway.
    let z0 = z_count / 2;
    view.view = ViewState {
        z_range: z0..z0 + 1,
        ..ViewState::new()
    };

    // Volume → 3D Arcball Home (rotate cells appear); flat → 2D Slice Home.
    view.camera = if z_count > 1 {
        Camera::new_3d(viewport)
    } else {
        Camera::new_2d(viewport)
    };
    view.camera.fit_to_bounds(extent.min, extent.max);

    view
}

/// One parametric move in the guided-exploration move-set.
///
/// Each variant is a *family* of move parameterized by its payload, kept
/// camera-agnostic: whether it actually applies to a given view is decided by
/// [`ViewTransform::applies_to`] and [`apply`], not by the variant itself. This
/// is what lets [`children`] enumerate one flat list and let the per-mode
/// filtering fall out.
#[derive(Debug, Clone, PartialEq)]
pub enum ViewTransform {
    /// Frame the whole dataset (mode-preserving fit). Available in every mode.
    Home,
    /// Orbit the arcball by a signed azimuth, in **degrees**. Arcball-only.
    AzimuthDelta(f64),
    /// Multiply zoom by a factor (`> 1` zooms *in*). Slice + arcball, not fly.
    Zoom(f64),
    /// Step the current Z slice by a signed offset. Available in every mode, but
    /// no-ops away on a flat (`z_count <= 1`) or out-of-range move.
    StepZ(i32),
}

impl ViewTransform {
    /// Whether this move is even *meaningful* for `cam`'s mode, independent of
    /// the current parameter values (range / no-op checks happen later, in
    /// [`apply`]).
    ///
    /// - [`Home`](ViewTransform::Home) and [`StepZ`](ViewTransform::StepZ):
    ///   every camera (a Z step is a dimensional move, not a camera move).
    /// - [`AzimuthDelta`](ViewTransform::AzimuthDelta): only
    ///   [`Camera::Arcball`] — slice has no orbit, and rotating a free-fly
    ///   camera by an "azimuth" is undefined.
    /// - [`Zoom`](ViewTransform::Zoom): [`Camera::Slice`] and
    ///   [`Camera::Arcball`], but **not** [`Camera::Fly`] (a fly camera moves by
    ///   flying, not by a zoom factor).
    pub fn applies_to(&self, cam: &Camera) -> bool {
        match self {
            ViewTransform::Home => true,
            ViewTransform::AzimuthDelta(_) => matches!(cam, Camera::Arcball(_)),
            ViewTransform::Zoom(_) => matches!(cam, Camera::Slice(_) | Camera::Arcball(_)),
            ViewTransform::StepZ(_) => true,
        }
    }

    /// Stable machine id for this move — the `transform` field on a [`Child`] /
    /// [`ExplorationCell`]. Encodes the parameter so two distinct moves in the
    /// same family (e.g. rotate-left vs rotate-right) never collide.
    ///
    /// The numeric formatting is sign-explicit and integer for the canonical
    /// move-set (`"azimuth:+45"`, `"stepz:-1"`); a non-canonical fractional
    /// payload still renders deterministically (e.g. `"zoom:0.5"`).
    pub fn id(&self) -> String {
        match self {
            ViewTransform::Home => "home".to_string(),
            ViewTransform::AzimuthDelta(deg) => format!("azimuth:{}", signed_deg(*deg)),
            ViewTransform::Zoom(factor) => {
                // The canonical move-set is in/out (2.0 / 0.5); name those by
                // direction, and fall back to the raw factor for anything else.
                if *factor > 1.0 {
                    "zoom:in".to_string()
                } else if *factor < 1.0 {
                    "zoom:out".to_string()
                } else {
                    format!("zoom:{}", trim_float(*factor))
                }
            }
            ViewTransform::StepZ(d) => format!("stepz:{}", signed_int(*d)),
        }
    }

    /// Plain-language label for this move — what a person reads in the UI.
    ///
    /// Phrased from the user's point of view ("Rotate right", "Next slice
    /// (deeper)"), not in camera jargon. The canonical 45°/single-step moves get
    /// hand-written copy; off-menu parameters degrade to a generic-but-correct
    /// phrasing rather than panicking.
    pub fn label(&self) -> String {
        match self {
            ViewTransform::Home => "Home (fit dataset)".to_string(),
            ViewTransform::AzimuthDelta(deg) => {
                // Positive azimuth orbits the camera to the right; negative to
                // the left.
                let mag = trim_float(deg.abs());
                if *deg > 0.0 {
                    format!("Rotate right {mag}°")
                } else if *deg < 0.0 {
                    format!("Rotate left {mag}°")
                } else {
                    "Rotate (no change)".to_string()
                }
            }
            ViewTransform::Zoom(factor) => {
                if *factor > 1.0 {
                    "Zoom in".to_string()
                } else if *factor < 1.0 {
                    "Zoom out".to_string()
                } else {
                    "Zoom (no change)".to_string()
                }
            }
            ViewTransform::StepZ(d) => {
                if *d > 0 {
                    "Next slice (deeper)".to_string()
                } else if *d < 0 {
                    "Previous slice".to_string()
                } else {
                    "Stay on slice".to_string()
                }
            }
        }
    }
}

/// Apply one move to `view`, returning the resulting child view — or [`None`]
/// when the move isn't available from here.
///
/// Purity: `view` is never mutated; the result is a fresh clone with exactly the
/// one field the move touches changed.
///
/// [`None`] is returned when:
/// - the move doesn't apply to the camera's mode
///   ([`ViewTransform::applies_to`] is `false`), or
/// - a [`StepZ`](ViewTransform::StepZ) lands off the dataset (flat dataset, or
///   target slice `< 0` / past the last slice), or
/// - the move would be a **no-op** — the child ends up byte-for-byte equal to
///   the input. Offering a cell that goes nowhere is just noise, so it's
///   omitted.
pub fn apply(view: &SavedView, t: &ViewTransform, extent: &ViewExtent) -> Option<SavedView> {
    // Mode gate first — a move that doesn't apply to this camera never produces
    // a child, regardless of parameters.
    if !t.applies_to(&view.camera) {
        return None;
    }

    let mut child = view.clone();

    match t {
        ViewTransform::Home => {
            // Mode-preserving fit: a Slice stays 2D, an Arcball stays 3D. We
            // wrap the camera's own framing math rather than reimplementing it.
            child.camera.fit_to_bounds(extent.min, extent.max);
        }
        ViewTransform::AzimuthDelta(deg) => match &mut child.camera {
            Camera::Arcball(a) => a.rotate(deg.to_radians(), 0.0),
            // applies_to already filtered non-arcball, but stay total.
            _ => return None,
        },
        ViewTransform::Zoom(factor) => {
            // A zoom factor must be finite and strictly positive. `apply` and
            // `ViewTransform::Zoom` are public, so guard here rather than trust the
            // caller: a 0 / negative / NaN / inf factor would otherwise leak a
            // degenerate camera (zoom = 0/NaN, distance = inf) into a SavedView.
            // The canonical move-set only ever uses 2.0 / 0.5, but the contract
            // must hold for any caller, so reject the rest as "not available".
            if !factor.is_finite() || *factor <= 0.0 {
                return None;
            }
            match &mut child.camera {
                Camera::Slice(s) => s.zoom_by(*factor),
                Camera::Arcball(a) => {
                    // factor > 1 means zoom IN, i.e. move the eye closer: shrink
                    // distance, but never inside the near plane.
                    a.distance = (a.distance / *factor).max(a.near);
                }
                // Fly has no zoom-by-factor; applies_to filtered it, but stay total.
                Camera::Fly(_) => return None,
            }
        }
        ViewTransform::StepZ(d) => {
            // A flat dataset has no slices to step through.
            if extent.z_count <= 1 {
                return None;
            }
            // Step the *start* of the current slab and collapse to a single
            // slice at the destination. i64 math so a negative step from slice 0
            // is caught by the range check rather than underflowing.
            let z0 = view.view.z_range.start as i64 + *d as i64;
            let last = extent.z_count as i64 - 1;
            if z0 < 0 || z0 > last {
                return None;
            }
            let z0 = z0 as u32;
            child.view.z_range = z0..z0 + 1;
        }
    }

    // No-op omission: if the move changed nothing observable, don't offer it.
    // `SavedView: PartialEq` makes this an exact structural comparison.
    if child == *view {
        return None;
    }

    Some(child)
}

/// A single offered next-step from a view: the child view plus the metadata a UI
/// needs to render and address it.
#[derive(Debug, Clone, PartialEq)]
pub struct Child {
    /// Stable, content-derived handle of `view` — see [`view_handle`].
    pub handle: String,
    /// Machine id of the move that produced this child ([`ViewTransform::id`]).
    pub transform: String,
    /// Plain-language label of the move ([`ViewTransform::label`]).
    pub label: String,
    /// The resulting saved view.
    pub view: SavedView,
}

/// The canonical guided-exploration move-set, in display order.
///
/// One flat list of the "trivial" single-step moves we always *try* from any
/// view. The per-mode / no-op / range filtering all lives in [`apply`], so a
/// move that doesn't fit the current view simply drops out of [`children`] — a
/// 2D Slice node yields no azimuth cells, a flat dataset yields no Z-step cells,
/// and so on. Keeping the list here (rather than inlining it) makes the offered
/// menu one obvious, ordered thing.
const MOVE_SET: [ViewTransform; 7] = [
    ViewTransform::Home,
    ViewTransform::AzimuthDelta(45.0),
    ViewTransform::AzimuthDelta(-45.0),
    ViewTransform::Zoom(2.0),
    ViewTransform::Zoom(0.5),
    ViewTransform::StepZ(1),
    ViewTransform::StepZ(-1),
];

/// Enumerate the available next-steps from `view`.
///
/// Walks the canonical [`MOVE_SET`] in order, applies each via [`apply`], and
/// keeps the ones that produced a child. Because all filtering is in [`apply`],
/// the returned [`Vec`] already excludes moves that don't fit this view's mode,
/// would step off the dataset, or would be no-ops — no extra logic here.
///
/// Pure: `view` is not mutated.
pub fn children(view: &SavedView, extent: &ViewExtent) -> Vec<Child> {
    let mut out = Vec::new();
    for t in MOVE_SET.iter() {
        if let Some(child_view) = apply(view, t, extent) {
            out.push(Child {
                handle: view_handle(&child_view),
                transform: t.id(),
                label: t.label(),
                view: child_view,
            });
        }
    }
    out
}

/// Deterministic, process-stable handle for a saved view: `"vh-<16 lowercase
/// hex>"`.
///
/// The same [`SavedView`] always maps to the same handle, in this run and any
/// other — so a handle minted on one surface (say the CLI) addresses the same
/// view on another (the web). We hash the view's canonical JSON
/// ([`SavedView`]'s serialization is order-stable; see its type doc) with an
/// inline FNV-1a 64-bit hash. FNV is used deliberately rather than
/// [`std::hash::DefaultHasher`], whose output is **not** guaranteed stable
/// across Rust versions or builds — process-stability is a contract here.
///
/// (FNV is not cryptographic; this is a content address, not a security token.)
pub fn view_handle(view: &SavedView) -> String {
    // Canonical bytes of the view. serde_json on a SavedView is total (no
    // non-serializable fields), so the unwrap can't fire in practice; if it
    // somehow did we'd still rather not panic in a pure helper, so fall back to
    // an empty string (which simply yields the FNV offset basis — a fixed,
    // valid handle) than crash an exploration build.
    let json = serde_json::to_string(view).unwrap_or_default();
    let h = fnv1a_64(json.as_bytes());
    format!("vh-{h:016x}")
}

/// FNV-1a 64-bit hash. Inlined (no external crate) so the handle scheme is
/// self-contained and identical everywhere this code runs.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET_BASIS;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

/// Wire-format version of the [`ExplorationSidecar`]. Bump on any breaking
/// change to the sidecar shape; a reader checks this against what it understands.
pub const EXPLORATION_SIDECAR_VERSION: u32 = 1;

/// The "you are here" node of an exploration: the current view, its handle, and
/// where it sits in the walk (depth + breadcrumb of move labels taken to reach
/// it).
///
/// `depth` and `breadcrumb` are `#[serde(default)]` so an older sidecar that
/// predates them still deserializes (they fall back to `0` / empty).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplorationNode {
    /// Stable handle of `view` ([`view_handle`]).
    pub handle: String,
    /// How many moves deep this node is from the exploration root.
    #[serde(default)]
    pub depth: u32,
    /// Human-readable trail of move labels taken to reach this node.
    #[serde(default)]
    pub breadcrumb: Vec<String>,
    /// The current saved view.
    pub view: SavedView,
}

/// One offered next-step in a serialized sidecar — a [`Child`] plus optional
/// presentation/annotation fields the higher tiers fill in later.
///
/// `url` (a deep link), `stat` (some scalar the surface attaches, e.g. a
/// score), and `incomplete` (the child view couldn't be fully realized — e.g.
/// data still loading) are all *optional embellishments*: this module emits them
/// empty (`None` / `false`) and never reads them. `url`/`stat` are skipped on
/// serialization when absent to keep the wire lean.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplorationCell {
    /// Stable handle of the child view ([`view_handle`]).
    pub handle: String,
    /// Machine id of the move ([`ViewTransform::id`]).
    pub transform: String,
    /// Plain-language label of the move ([`ViewTransform::label`]).
    pub label: String,
    /// The child saved view.
    pub view: SavedView,
    /// Optional deep link to this child view (filled in by a higher tier).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Optional scalar a surface attaches to this child (filled in later).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stat: Option<f64>,
    /// Whether this child view couldn't be fully realized (e.g. data pending).
    #[serde(default)]
    pub incomplete: bool,
}

/// A self-contained guided-exploration snapshot: the current node plus the menu
/// of next-steps. This is the data structure the CLI / Python / web tiers
/// serialize, ship, and render.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplorationSidecar {
    /// Wire-format version ([`EXPLORATION_SIDECAR_VERSION`]).
    pub v: u32,
    /// The current "you are here" node.
    pub current: ExplorationNode,
    /// The available next-steps from `current`.
    pub cells: Vec<ExplorationCell>,
}

impl ExplorationSidecar {
    /// Build a sidecar for `current`: stamp the version, wrap `current` as the
    /// node (carrying `depth` + `breadcrumb` from the caller's walk), and expand
    /// its [`children`] into cells with the optional fields left empty.
    ///
    /// Pure with respect to `current` — it is cloned into the node, never
    /// mutated.
    pub fn build(
        current: &SavedView,
        extent: &ViewExtent,
        depth: u32,
        breadcrumb: Vec<String>,
    ) -> Self {
        let cells = children(current, extent)
            .into_iter()
            .map(|c| ExplorationCell {
                handle: c.handle,
                transform: c.transform,
                label: c.label,
                view: c.view,
                url: None,
                stat: None,
                incomplete: false,
            })
            .collect();

        ExplorationSidecar {
            v: EXPLORATION_SIDECAR_VERSION,
            current: ExplorationNode {
                handle: view_handle(current),
                depth,
                breadcrumb,
                view: current.clone(),
            },
            cells,
        }
    }
}

// --- small formatting helpers -------------------------------------------------

/// Render an integer-valued float with an explicit sign (`+45`, `-45`), falling
/// back to a trimmed fractional form for non-integer values.
fn signed_deg(deg: f64) -> String {
    if deg.fract() == 0.0 && deg.is_finite() {
        format!("{:+}", deg as i64)
    } else {
        // Non-canonical fractional azimuth — keep the sign, keep it readable.
        let body = trim_float(deg.abs());
        if deg < 0.0 {
            format!("-{body}")
        } else {
            format!("+{body}")
        }
    }
}

/// Render a signed integer with an explicit leading sign (`+1`, `-1`).
fn signed_int(d: i32) -> String {
    format!("{d:+}")
}

/// Render an `f64` without a trailing `.0` for whole numbers (so `2.0` -> `"2"`,
/// `0.5` -> `"0.5"`). Keeps generated ids/labels tidy for the common
/// whole-number parameters while staying lossless for fractions.
fn trim_float(x: f64) -> String {
    if x.fract() == 0.0 && x.is_finite() {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::{Arcball, Camera, Fly, Slice};

    fn extent_3d() -> ViewExtent {
        ViewExtent {
            min: [0.0, 0.0, 0.0],
            max: [100.0, 80.0, 40.0],
            z_count: 40,
            t_count: 5,
            c_count: 2,
        }
    }

    fn slice_view() -> SavedView {
        let mut v = SavedView::empty([1024, 768]);
        v.camera = Camera::Slice(Slice::new([1024, 768]));
        v
    }

    fn arcball_view() -> SavedView {
        let mut v = SavedView::empty([1024, 768]);
        v.camera = Camera::Arcball(Arcball::new([1024, 768]));
        v
    }

    fn fly_view() -> SavedView {
        let mut v = SavedView::empty([1024, 768]);
        v.camera = Camera::Fly(Fly::new([1024, 768]));
        v
    }

    // --- applies_to mode gating ---

    #[test]
    fn applies_to_modes() {
        let s = Camera::Slice(Slice::new([10, 10]));
        let a = Camera::Arcball(Arcball::new([10, 10]));
        let f = Camera::Fly(Fly::new([10, 10]));

        assert!(ViewTransform::Home.applies_to(&s));
        assert!(ViewTransform::Home.applies_to(&a));
        assert!(ViewTransform::Home.applies_to(&f));

        assert!(!ViewTransform::AzimuthDelta(45.0).applies_to(&s));
        assert!(ViewTransform::AzimuthDelta(45.0).applies_to(&a));
        assert!(!ViewTransform::AzimuthDelta(45.0).applies_to(&f));

        assert!(ViewTransform::Zoom(2.0).applies_to(&s));
        assert!(ViewTransform::Zoom(2.0).applies_to(&a));
        assert!(!ViewTransform::Zoom(2.0).applies_to(&f));

        assert!(ViewTransform::StepZ(1).applies_to(&s));
        assert!(ViewTransform::StepZ(1).applies_to(&a));
        assert!(ViewTransform::StepZ(1).applies_to(&f));
    }

    // --- ids + labels ---

    #[test]
    fn canonical_ids() {
        assert_eq!(ViewTransform::Home.id(), "home");
        assert_eq!(ViewTransform::AzimuthDelta(45.0).id(), "azimuth:+45");
        assert_eq!(ViewTransform::AzimuthDelta(-45.0).id(), "azimuth:-45");
        assert_eq!(ViewTransform::Zoom(2.0).id(), "zoom:in");
        assert_eq!(ViewTransform::Zoom(0.5).id(), "zoom:out");
        assert_eq!(ViewTransform::StepZ(1).id(), "stepz:+1");
        assert_eq!(ViewTransform::StepZ(-1).id(), "stepz:-1");
    }

    #[test]
    fn canonical_labels() {
        assert_eq!(ViewTransform::Home.label(), "Home (fit dataset)");
        assert_eq!(
            ViewTransform::AzimuthDelta(45.0).label(),
            "Rotate right 45°"
        );
        assert_eq!(
            ViewTransform::AzimuthDelta(-45.0).label(),
            "Rotate left 45°"
        );
        assert_eq!(ViewTransform::Zoom(2.0).label(), "Zoom in");
        assert_eq!(ViewTransform::Zoom(0.5).label(), "Zoom out");
        assert_eq!(ViewTransform::StepZ(1).label(), "Next slice (deeper)");
        assert_eq!(ViewTransform::StepZ(-1).label(), "Previous slice");
    }

    // --- apply: mode gating returns None ---

    #[test]
    fn apply_azimuth_on_slice_is_none() {
        let v = slice_view();
        assert!(apply(&v, &ViewTransform::AzimuthDelta(45.0), &extent_3d()).is_none());
    }

    #[test]
    fn apply_zoom_on_fly_is_none() {
        let v = fly_view();
        assert!(apply(&v, &ViewTransform::Zoom(2.0), &extent_3d()).is_none());
    }

    // --- apply: Home fits, mode-preserving ---

    #[test]
    fn apply_home_on_slice_stays_slice_and_changes() {
        let v = slice_view();
        let child = apply(&v, &ViewTransform::Home, &extent_3d()).expect("home applies");
        assert!(matches!(child.camera, Camera::Slice(_)));
        assert_ne!(child, v, "home should reframe (not a no-op here)");
    }

    #[test]
    fn apply_home_on_arcball_stays_arcball() {
        let v = arcball_view();
        let child = apply(&v, &ViewTransform::Home, &extent_3d()).expect("home applies");
        assert!(matches!(child.camera, Camera::Arcball(_)));
    }

    // --- apply: azimuth rotates the arcball ---

    #[test]
    fn apply_azimuth_rotates_theta() {
        let v = arcball_view();
        let theta0 = match &v.camera {
            Camera::Arcball(a) => a.theta,
            _ => unreachable!(),
        };
        let child = apply(&v, &ViewTransform::AzimuthDelta(45.0), &extent_3d()).unwrap();
        match &child.camera {
            Camera::Arcball(a) => {
                assert!((a.theta - (theta0 + 45.0_f64.to_radians())).abs() < 1e-12);
            }
            _ => unreachable!(),
        }
        // purity
        assert!(matches!(&v.camera, Camera::Arcball(a) if a.theta == theta0));
    }

    // --- apply: zoom ---

    #[test]
    fn apply_zoom_in_slice_doubles_zoom() {
        let v = slice_view();
        let child = apply(&v, &ViewTransform::Zoom(2.0), &extent_3d()).unwrap();
        match (&v.camera, &child.camera) {
            (Camera::Slice(a), Camera::Slice(b)) => assert_eq!(b.zoom, a.zoom * 2.0),
            _ => unreachable!(),
        }
    }

    #[test]
    fn apply_zoom_in_arcball_reduces_distance() {
        let v = arcball_view();
        let child = apply(&v, &ViewTransform::Zoom(2.0), &extent_3d()).unwrap();
        match (&v.camera, &child.camera) {
            (Camera::Arcball(a), Camera::Arcball(b)) => assert!(b.distance < a.distance),
            _ => unreachable!(),
        }
    }

    #[test]
    fn apply_zoom_arcball_never_crosses_near() {
        // A huge zoom-in factor must clamp distance to >= near, not go negative.
        let mut v = arcball_view();
        if let Camera::Arcball(a) = &mut v.camera {
            a.distance = 1.0;
            a.near = 0.5;
        }
        let child = apply(&v, &ViewTransform::Zoom(1000.0), &extent_3d()).unwrap();
        match &child.camera {
            Camera::Arcball(b) => assert!(b.distance >= b.near),
            _ => unreachable!(),
        }
    }

    // --- apply: StepZ ---

    #[test]
    fn apply_stepz_forward() {
        let mut v = slice_view();
        v.view.z_range = 10..11;
        let child = apply(&v, &ViewTransform::StepZ(1), &extent_3d()).unwrap();
        assert_eq!(child.view.z_range, 11..12);
    }

    #[test]
    fn apply_stepz_back() {
        let mut v = slice_view();
        v.view.z_range = 10..11;
        let child = apply(&v, &ViewTransform::StepZ(-1), &extent_3d()).unwrap();
        assert_eq!(child.view.z_range, 9..10);
    }

    #[test]
    fn apply_stepz_below_zero_is_none() {
        let mut v = slice_view();
        v.view.z_range = 0..1;
        assert!(apply(&v, &ViewTransform::StepZ(-1), &extent_3d()).is_none());
    }

    #[test]
    fn apply_stepz_past_last_is_none() {
        let mut v = slice_view();
        v.view.z_range = 39..40; // last slice (z_count = 40)
        assert!(apply(&v, &ViewTransform::StepZ(1), &extent_3d()).is_none());
    }

    #[test]
    fn apply_stepz_flat_dataset_is_none() {
        let mut flat = extent_3d();
        flat.z_count = 1;
        let v = slice_view();
        assert!(apply(&v, &ViewTransform::StepZ(1), &flat).is_none());
        assert!(apply(&v, &ViewTransform::StepZ(-1), &flat).is_none());
    }

    #[test]
    fn apply_stepz_zero_count_is_none() {
        // Degenerate: a dataset reporting z_count = 0 must not panic.
        let mut zero = extent_3d();
        zero.z_count = 0;
        let v = slice_view();
        assert!(apply(&v, &ViewTransform::StepZ(1), &zero).is_none());
    }

    // --- apply: no-op omission ---

    #[test]
    fn apply_zero_azimuth_is_noop_none() {
        let v = arcball_view();
        assert!(apply(&v, &ViewTransform::AzimuthDelta(0.0), &extent_3d()).is_none());
    }

    #[test]
    fn apply_unit_zoom_is_noop_none() {
        let v = slice_view();
        assert!(apply(&v, &ViewTransform::Zoom(1.0), &extent_3d()).is_none());
    }

    #[test]
    fn apply_does_not_mutate_input() {
        let v = arcball_view();
        let before = serde_json::to_string(&v).unwrap();
        let _ = apply(&v, &ViewTransform::Home, &extent_3d());
        let _ = apply(&v, &ViewTransform::AzimuthDelta(45.0), &extent_3d());
        let _ = apply(&v, &ViewTransform::Zoom(2.0), &extent_3d());
        let _ = apply(&v, &ViewTransform::StepZ(1), &extent_3d());
        let after = serde_json::to_string(&v).unwrap();
        assert_eq!(before, after, "apply must be pure");
    }

    // --- children: mode-dependent menus ---

    #[test]
    fn children_slice_3d_dataset() {
        // Slice + 3D dataset: Home, Zoom in, Zoom out, StepZ +/- (no azimuth).
        let mut v = slice_view();
        v.view.z_range = 10..11; // mid-stack so both Z steps are in range
        let kids = children(&v, &extent_3d());
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert_eq!(
            ids,
            vec!["home", "zoom:in", "zoom:out", "stepz:+1", "stepz:-1"]
        );
    }

    #[test]
    fn children_arcball_3d_dataset() {
        // Arcball + 3D: Home, azimuth +/-, Zoom in/out, StepZ +/-.
        let mut v = arcball_view();
        v.view.z_range = 10..11;
        let kids = children(&v, &extent_3d());
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "home",
                "azimuth:+45",
                "azimuth:-45",
                "zoom:in",
                "zoom:out",
                "stepz:+1",
                "stepz:-1",
            ]
        );
    }

    #[test]
    fn children_slice_flat_dataset_no_stepz() {
        let mut flat = extent_3d();
        flat.z_count = 1;
        let v = slice_view();
        let kids = children(&v, &flat);
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert_eq!(ids, vec!["home", "zoom:in", "zoom:out"]);
    }

    #[test]
    fn children_handles_match_view_handle() {
        let v = arcball_view();
        let kids = children(&v, &extent_3d());
        for c in &kids {
            assert_eq!(c.handle, view_handle(&c.view));
        }
    }

    #[test]
    fn children_does_not_mutate_input() {
        let v = arcball_view();
        let before = serde_json::to_string(&v).unwrap();
        let _ = children(&v, &extent_3d());
        let after = serde_json::to_string(&v).unwrap();
        assert_eq!(before, after);
    }

    // --- view_handle ---

    #[test]
    fn view_handle_shape() {
        let v = slice_view();
        let h = view_handle(&v);
        assert!(h.starts_with("vh-"));
        assert_eq!(h.len(), 3 + 16);
        assert!(
            h[3..]
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "handle hex must be lowercase: {h}"
        );
    }

    #[test]
    fn view_handle_is_deterministic() {
        let v = arcball_view();
        assert_eq!(view_handle(&v), view_handle(&v.clone()));
    }

    #[test]
    fn view_handle_changes_with_view() {
        let a = slice_view();
        let mut b = slice_view();
        b.view.t = 7;
        assert_ne!(view_handle(&a), view_handle(&b));
    }

    // --- ExplorationSidecar ---

    #[test]
    fn sidecar_build_shape() {
        let mut v = arcball_view();
        v.view.z_range = 10..11;
        let side =
            ExplorationSidecar::build(&v, &extent_3d(), 2, vec!["Home (fit dataset)".into()]);
        assert_eq!(side.v, EXPLORATION_SIDECAR_VERSION);
        assert_eq!(side.current.handle, view_handle(&v));
        assert_eq!(side.current.depth, 2);
        assert_eq!(
            side.current.breadcrumb,
            vec!["Home (fit dataset)".to_string()]
        );
        // Cells mirror children().
        let kids = children(&v, &extent_3d());
        assert_eq!(side.cells.len(), kids.len());
        for (cell, kid) in side.cells.iter().zip(kids.iter()) {
            assert_eq!(cell.handle, kid.handle);
            assert_eq!(cell.transform, kid.transform);
            assert_eq!(cell.label, kid.label);
            assert!(cell.url.is_none());
            assert!(cell.stat.is_none());
            assert!(!cell.incomplete);
        }
    }

    #[test]
    fn sidecar_round_trips_json() {
        let v = arcball_view();
        let side = ExplorationSidecar::build(&v, &extent_3d(), 0, Vec::new());
        let json = serde_json::to_string(&side).unwrap();
        let back: ExplorationSidecar = serde_json::from_str(&json).unwrap();
        assert_eq!(back.v, side.v);
        assert_eq!(back.current.handle, side.current.handle);
        assert_eq!(back.cells.len(), side.cells.len());
    }

    #[test]
    fn sidecar_cell_skips_empty_url_and_stat() {
        let v = slice_view();
        let side = ExplorationSidecar::build(&v, &extent_3d(), 0, Vec::new());
        let json = serde_json::to_string(&side).unwrap();
        assert!(!json.contains("\"url\""), "absent url should be skipped");
        assert!(!json.contains("\"stat\""), "absent stat should be skipped");
        // incomplete is not skip_serializing_if, so it's present.
        assert!(json.contains("\"incomplete\""));
    }

    #[test]
    fn sidecar_node_defaults_on_decode() {
        // An older node without depth/breadcrumb still decodes.
        let v = slice_view();
        let view_json = serde_json::to_string(&v).unwrap();
        let node_json = format!(r#"{{"handle":"vh-0000000000000000","view":{view_json}}}"#);
        let node: ExplorationNode = serde_json::from_str(&node_json).unwrap();
        assert_eq!(node.depth, 0);
        assert!(node.breadcrumb.is_empty());
    }

    #[test]
    fn degenerate_extent_no_panic() {
        // Equal min/max (a single point) must not panic anywhere in the
        // pipeline — Home just fits a degenerate box, the camera sanitizes it.
        let point = ViewExtent {
            min: [5.0, 5.0, 5.0],
            max: [5.0, 5.0, 5.0],
            z_count: 0,
            t_count: 0,
            c_count: 0,
        };
        let v = slice_view();
        let _ = children(&v, &point);
        let _ = ExplorationSidecar::build(&v, &point, 0, Vec::new());
        // Fly camera + degenerate extent: still no panic.
        let f = fly_view();
        let _ = children(&f, &point);
    }

    // --- ViewExtent::from_dims ---

    #[test]
    fn from_dims_maps_tczyx_to_extent() {
        // dims = [T, C, Z, Y, X]: the box spans X/Y/Z, counts carry T/C/Z.
        let extent = ViewExtent::from_dims([1, 2, 340, 512, 768]);
        assert_eq!(extent.min, [0.0, 0.0, 0.0]);
        assert_eq!(extent.max, [768.0, 512.0, 340.0]);
        assert_eq!(extent.z_count, 340);
        assert_eq!(extent.t_count, 1);
        assert_eq!(extent.c_count, 2);
    }

    #[test]
    fn from_dims_flat_dataset() {
        // A flat (Z = 1) multichannel image: z_count = 1 gates out slice steps.
        let extent = ViewExtent::from_dims([3, 4, 1, 1024, 2048]);
        assert_eq!(extent.max, [2048.0, 1024.0, 1.0]);
        assert_eq!(extent.z_count, 1);
        assert_eq!(extent.t_count, 3);
        assert_eq!(extent.c_count, 4);
    }

    #[test]
    fn view_extent_round_trips_json() {
        let extent = ViewExtent::from_dims([5, 2, 40, 80, 100]);
        let json = serde_json::to_string(&extent).unwrap();
        let back: ViewExtent = serde_json::from_str(&json).unwrap();
        assert_eq!(back, extent);
    }

    // --- default_view ---

    #[test]
    fn default_view_is_arcball_for_volume() {
        let view = default_view("wds-1", [1, 1, 340, 512, 512], [800, 600]);
        assert!(
            matches!(view.camera, Camera::Arcball(_)),
            "a volume (z_count > 1) should open in a 3D Arcball Home"
        );
        // dataset_order names the dataset so it renders.
        assert_eq!(view.dataset_order, vec![DatasetId("wds-1".to_string())]);
        // Mid-stack single slice (340 / 2 = 170).
        assert_eq!(view.view.z_range, 170..171);
        // Dataset is made visible: auto-contrast on + default settings present.
        assert_eq!(
            view.auto_contrast.get(&DatasetId("wds-1".to_string())),
            Some(&true)
        );
        assert!(
            view.dataset_settings
                .contains_key(&DatasetId("wds-1".to_string()))
        );
    }

    #[test]
    fn default_view_is_slice_for_flat() {
        let view = default_view("wds-2", [1, 3, 1, 1024, 1024], [800, 600]);
        assert!(
            matches!(view.camera, Camera::Slice(_)),
            "a flat image (z_count <= 1) should open in a 2D Slice Home"
        );
        // A flat dataset has a single slice at z 0.
        assert_eq!(view.view.z_range, 0..1);
        assert_eq!(view.dataset_order, vec![DatasetId("wds-2".to_string())]);
    }

    #[test]
    fn default_view_feeds_children() {
        // The Home view a volume yields should offer azimuth cells (it's an
        // Arcball) and Z-step cells (mid-stack, in range both ways).
        let dims = [1, 1, 40, 80, 100];
        let view = default_view("wds-3", dims, [800, 600]);
        let kids = children(&view, &ViewExtent::from_dims(dims));
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert!(ids.iter().any(|id| id.starts_with("azimuth:")));
        assert!(ids.contains(&"stepz:+1"));
        assert!(ids.contains(&"stepz:-1"));
    }
}
