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
use crate::scene::{DatasetDisplaySettings, RenderMode};
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

/// Build a guided-exploration sidecar for the web (and any other wasm) surface,
/// as a JSON string.
///
/// This is the single wasm entry point the browser calls to ask "from this view,
/// what are the next moves?". It wraps the pure generator so the SPA never has to
/// reconstruct a [`ViewExtent`] or a Home view in TypeScript:
///
/// - `view_json` is the current [`SavedView`] as JSON, or `None`/empty to start
///   from the dataset's Home ([`default_view`]).
/// - `t, c, z, y, x` are the dataset shape `[T, C, Z, Y, X]`; `viewport_w` /
///   `viewport_h` size the synthesized Home camera; `depth` is recorded on the
///   sidecar node (the caller's walk depth).
///
/// Returns the serialized [`ExplorationSidecar`] on success. On a malformed
/// `view_json` it returns a JSON object string `{"error": "<message>"}` rather
/// than panicking, so the caller can `JSON.parse` the result and branch on an
/// `.error` field. Mirrors the `#[cfg_attr(target_arch = "wasm32", …)]` pattern
/// used by [`dataset_id_for_url`](crate::saved_view::dataset_id_for_url): the
/// function compiles on every target, but only wasm gets the `#[wasm_bindgen]`
/// export.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
#[allow(clippy::too_many_arguments)]
pub fn explore_view(
    view_json: Option<String>,
    ds_id: &str,
    t: u32,
    c: u32,
    z: u32,
    y: u32,
    x: u32,
    viewport_w: u32,
    viewport_h: u32,
    depth: u32,
) -> String {
    let dims = [t as u64, c as u64, z as u64, y as u64, x as u64];
    let extent = ViewExtent::from_dims(dims);
    let current = match view_json {
        Some(j) if !j.is_empty() => match serde_json::from_str::<SavedView>(&j) {
            Ok(v) => v,
            Err(e) => {
                return format!(
                    "{{\"error\":{}}}",
                    serde_json::to_string(&e.to_string()).unwrap()
                );
            }
        },
        _ => default_view(ds_id, dims, [viewport_w, viewport_h]),
    };
    let sidecar = ExplorationSidecar::build(&current, &extent, depth, Vec::new());
    serde_json::to_string(&sidecar).unwrap_or_else(|_| "{\"error\":\"serialize\"}".to_string())
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
    /// Tilt the arcball up/down by a signed elevation, in **degrees**.
    /// Arcball-only — it changes the 3D camera's `phi` and is clamped away from
    /// the poles so it can't flip the view over.
    ElevationDelta(f64),
    /// Step the current timepoint (T) by a signed offset. Available in every
    /// mode, but no-ops away on a single-timepoint (`t_count <= 1`) or
    /// out-of-range move.
    StepT(i32),
    /// Step the active channel (C) by a signed offset. Available in every mode,
    /// but no-ops away on a single-channel (`c_count <= 1`) or out-of-range move.
    StepC(i32),
    /// Flip volume rendering between translucent and max-intensity projection.
    /// Arcball-only — it changes how the 3D volume is rendered.
    ToggleProjection,
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
    /// - [`ElevationDelta`](ViewTransform::ElevationDelta) and
    ///   [`ToggleProjection`](ViewTransform::ToggleProjection): only
    ///   [`Camera::Arcball`] — a 2D slice has no up/down tilt, and the
    ///   projection toggle changes 3D volume rendering.
    /// - [`StepT`](ViewTransform::StepT) and [`StepC`](ViewTransform::StepC):
    ///   every camera (a T/C step is a dimensional move, not a camera move),
    ///   exactly like [`StepZ`](ViewTransform::StepZ).
    pub fn applies_to(&self, cam: &Camera) -> bool {
        match self {
            ViewTransform::Home => true,
            ViewTransform::AzimuthDelta(_) => matches!(cam, Camera::Arcball(_)),
            ViewTransform::Zoom(_) => matches!(cam, Camera::Slice(_) | Camera::Arcball(_)),
            ViewTransform::StepZ(_) => true,
            ViewTransform::ElevationDelta(_) => matches!(cam, Camera::Arcball(_)),
            ViewTransform::StepT(_) => true,
            ViewTransform::StepC(_) => true,
            ViewTransform::ToggleProjection => matches!(cam, Camera::Arcball(_)),
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
            ViewTransform::ElevationDelta(deg) => format!("elevation:{}", signed_deg(*deg)),
            ViewTransform::StepT(d) => format!("stept:{}", signed_int(*d)),
            ViewTransform::StepC(d) => format!("stepc:{}", signed_int(*d)),
            ViewTransform::ToggleProjection => "projection:toggle".to_string(),
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
            ViewTransform::ElevationDelta(deg) => {
                // Positive elevation tilts the camera up; negative tilts down.
                let mag = trim_float(deg.abs());
                if *deg > 0.0 {
                    format!("Tilt up {mag}°")
                } else if *deg < 0.0 {
                    format!("Tilt down {mag}°")
                } else {
                    "Tilt (no change)".to_string()
                }
            }
            ViewTransform::StepT(d) => {
                if *d > 0 {
                    "Next timepoint".to_string()
                } else if *d < 0 {
                    "Previous timepoint".to_string()
                } else {
                    "Stay on timepoint".to_string()
                }
            }
            ViewTransform::StepC(d) => {
                if *d > 0 {
                    "Next channel".to_string()
                } else if *d < 0 {
                    "Previous channel".to_string()
                } else {
                    "Stay on channel".to_string()
                }
            }
            ViewTransform::ToggleProjection => "Toggle max-intensity projection".to_string(),
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
/// - a [`StepZ`](ViewTransform::StepZ) / [`StepT`](ViewTransform::StepT) /
///   [`StepC`](ViewTransform::StepC) lands off the dataset (a flat / single-T /
///   single-C dataset, or a target index `< 0` / past the last index), or
/// - the move would be a **no-op** — the child ends up byte-for-byte equal to
///   the input. Offering a cell that goes nowhere is just noise, so it's
///   omitted. (An [`ElevationDelta`](ViewTransform::ElevationDelta) clamped to a
///   pole and a [`ToggleProjection`](ViewTransform::ToggleProjection) on an
///   empty display-settings map both fall out here.)
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
        ViewTransform::ElevationDelta(deg) => match &mut child.camera {
            Camera::Arcball(a) => {
                // Tilt up/down, clamped just shy of the poles so the orbit can't
                // flip over the top/bottom (which would invert the view). A clamp
                // that lands back on the same phi makes this a no-op, dropped by
                // the `child == *view` check below.
                a.phi = (a.phi + deg.to_radians()).clamp(0.05, std::f64::consts::PI - 0.05);
            }
            // applies_to already filtered non-arcball, but stay total.
            _ => return None,
        },
        ViewTransform::StepT(d) => {
            // A single-timepoint dataset has no frames to step through.
            if extent.t_count <= 1 {
                return None;
            }
            // i64 math so a negative step from t 0 is caught by the range check
            // rather than underflowing.
            let t0 = view.view.t as i64 + *d as i64;
            let last = extent.t_count as i64 - 1;
            if t0 < 0 || t0 > last {
                return None;
            }
            child.view.t = t0 as u32;
        }
        ViewTransform::StepC(d) => {
            // A single-channel dataset has no channels to step through.
            if extent.c_count <= 1 {
                return None;
            }
            let c0 = view.view.c as i64 + *d as i64;
            let last = extent.c_count as i64 - 1;
            if c0 < 0 || c0 > last {
                return None;
            }
            child.view.c = c0 as u32;
        }
        ViewTransform::ToggleProjection => {
            // Nothing to toggle if no dataset has display settings yet.
            if child.dataset_settings.is_empty() {
                return None;
            }
            // Flip every dataset's volume render mode. If nothing actually
            // changes the `child == *view` check below drops the move.
            for settings in child.dataset_settings.values_mut() {
                settings.render_mode = match settings.render_mode {
                    RenderMode::Translucent => RenderMode::MaxIntensity,
                    RenderMode::MaxIntensity => RenderMode::Translucent,
                };
            }
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
/// view, grouped into coherent families so a reader scans them in one sweep:
/// **reframe** (Home) → **orient** (rotate/tilt) → **scale** (zoom) →
/// **render** (projection) → **step** through the Z/T/C dimensions. The
/// per-mode / no-op / range filtering all lives in [`apply`], so a move that
/// doesn't fit the current view simply drops out of [`children`] — a 2D Slice
/// node yields no azimuth/elevation/projection cells, a flat dataset yields no
/// Z-step cells, and so on. Keeping the list here (rather than inlining it)
/// makes the offered menu one obvious, ordered thing.
const MOVE_SET: [ViewTransform; 14] = [
    // Reframe.
    ViewTransform::Home,
    // Orient: rotate (azimuth) then tilt (elevation).
    ViewTransform::AzimuthDelta(45.0),
    ViewTransform::AzimuthDelta(-45.0),
    ViewTransform::ElevationDelta(30.0),
    ViewTransform::ElevationDelta(-30.0),
    // Scale.
    ViewTransform::Zoom(2.0),
    ViewTransform::Zoom(0.5),
    // Render mode.
    ViewTransform::ToggleProjection,
    // Step through the non-spatial / depth dimensions: Z, then T, then C.
    ViewTransform::StepZ(1),
    ViewTransform::StepZ(-1),
    ViewTransform::StepT(1),
    ViewTransform::StepT(-1),
    ViewTransform::StepC(1),
    ViewTransform::StepC(-1),
];

/// Enumerate the available next-steps from `view`.
///
/// Walks the canonical [`MOVE_SET`] in order, applies each via [`apply`], and
/// keeps the ones that produced a child. Because all filtering is in [`apply`],
/// the returned [`Vec`] already excludes moves that don't fit this view's mode,
/// would step off the dataset, or would be no-ops — no extra logic here.
///
/// Labels are [`ViewTransform::label`] except for the **projection** cell, whose
/// copy is made *state-aware* here ([`projection_label`]): a toggle should tell
/// the user the destination, not just "toggle". The static label remains the
/// fallback (no display settings to read).
///
/// Pure: `view` is not mutated.
pub fn children(view: &SavedView, extent: &ViewExtent) -> Vec<Child> {
    let mut out = Vec::new();
    for t in MOVE_SET.iter() {
        if let Some(child_view) = apply(view, t, extent) {
            // The projection cell's label depends on the CURRENT render mode
            // (what the toggle lands on); every other move uses its static label.
            let label = match t {
                ViewTransform::ToggleProjection => projection_label(view),
                _ => t.label(),
            };
            out.push(Child {
                handle: view_handle(&child_view),
                transform: t.id(),
                label,
                view: child_view,
            });
        }
    }
    out
}

/// State-aware label for the [`ToggleProjection`](ViewTransform::ToggleProjection)
/// cell: name the mode the toggle would switch *to*, read from the view's
/// primary (first) [`dataset_settings`](SavedView::dataset_settings) entry.
///
/// - currently [`Translucent`](RenderMode::Translucent) → `"Max-intensity
///   projection"` (the toggle turns MIP on),
/// - currently [`MaxIntensity`](RenderMode::MaxIntensity) → `"Volume rendering
///   (translucent)"` (the toggle turns MIP off).
///
/// Falls back to the static [`ViewTransform::label`] text when there is no
/// settings entry to read (the toggle wouldn't apply in that case anyway, so
/// this is belt-and-braces).
fn projection_label(view: &SavedView) -> String {
    match view.dataset_settings.values().next() {
        Some(settings) => match settings.render_mode {
            RenderMode::Translucent => "Max-intensity projection".to_string(),
            RenderMode::MaxIntensity => "Volume rendering (translucent)".to_string(),
        },
        None => ViewTransform::ToggleProjection.label(),
    }
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

/// One offered next-step in a serialized sidecar — a [`Child`] plus the
/// destination's dimensional indices and optional presentation/annotation fields
/// the higher tiers fill in later.
///
/// `z`/`t`/`c` are the child view's destination indices (`z` is the start of the
/// view's Z slab, `t`/`c` the active timepoint/channel). They mirror the values a
/// reader would otherwise have to dig out of `view.view`, so EVERY surface (CLI,
/// pyo3, web) gets the same orientation a ranking agent needs without re-deriving
/// it — see [`ExplorationSidecar::build`].
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
    /// Destination Z slice index (the start of the child view's Z slab).
    pub z: u32,
    /// Destination timepoint index.
    pub t: u32,
    /// Destination channel index.
    pub c: u32,
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

/// A self-contained guided-exploration snapshot: the current node, the dataset's
/// extent, plus the menu of next-steps. This is the data structure the CLI /
/// Python / web tiers serialize, ship, and render.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplorationSidecar {
    /// Wire-format version ([`EXPLORATION_SIDECAR_VERSION`]).
    pub v: u32,
    /// The current "you are here" node.
    pub current: ExplorationNode,
    /// The dataset's spatial + dimensional extent (the same context `build` used
    /// to gate the moves). Carried so every surface can show the dataset's bounds
    /// and per-axis counts without re-deriving them.
    pub extent: ViewExtent,
    /// The available next-steps from `current`.
    pub cells: Vec<ExplorationCell>,
}

impl ExplorationSidecar {
    /// Build a sidecar for `current`: stamp the version, wrap `current` as the
    /// node (carrying `depth` + `breadcrumb` from the caller's walk), record the
    /// dataset `extent`, and expand its [`children`] into cells (each carrying its
    /// destination `z`/`t`/`c`) with the optional fields left empty.
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
                // Destination indices, read off the child view so every surface
                // gets the same orientation without re-deriving it.
                z: c.view.view.z_range.start,
                t: c.view.view.t,
                c: c.view.view.c,
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
            extent: extent.clone(),
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

    // --- ids + labels for the enriched move-set ---

    #[test]
    fn enriched_ids() {
        assert_eq!(ViewTransform::ElevationDelta(30.0).id(), "elevation:+30");
        assert_eq!(ViewTransform::ElevationDelta(-30.0).id(), "elevation:-30");
        assert_eq!(ViewTransform::StepT(1).id(), "stept:+1");
        assert_eq!(ViewTransform::StepT(-1).id(), "stept:-1");
        assert_eq!(ViewTransform::StepC(1).id(), "stepc:+1");
        assert_eq!(ViewTransform::StepC(-1).id(), "stepc:-1");
        assert_eq!(ViewTransform::ToggleProjection.id(), "projection:toggle");
    }

    #[test]
    fn enriched_labels() {
        assert_eq!(ViewTransform::ElevationDelta(30.0).label(), "Tilt up 30°");
        assert_eq!(
            ViewTransform::ElevationDelta(-30.0).label(),
            "Tilt down 30°"
        );
        assert_eq!(ViewTransform::StepT(1).label(), "Next timepoint");
        assert_eq!(ViewTransform::StepT(-1).label(), "Previous timepoint");
        assert_eq!(ViewTransform::StepC(1).label(), "Next channel");
        assert_eq!(ViewTransform::StepC(-1).label(), "Previous channel");
        assert_eq!(
            ViewTransform::ToggleProjection.label(),
            "Toggle max-intensity projection"
        );
    }

    // --- apply: ElevationDelta (Arcball-only, tilts/clamps phi) ---

    #[test]
    fn apply_elevation_on_slice_is_none() {
        let v = slice_view();
        assert!(apply(&v, &ViewTransform::ElevationDelta(30.0), &extent_3d()).is_none());
    }

    #[test]
    fn apply_elevation_tilts_phi() {
        let v = arcball_view();
        let phi0 = match &v.camera {
            Camera::Arcball(a) => a.phi,
            _ => unreachable!(),
        };
        let child = apply(&v, &ViewTransform::ElevationDelta(30.0), &extent_3d()).unwrap();
        match &child.camera {
            Camera::Arcball(a) => {
                assert!((a.phi - (phi0 + 30.0_f64.to_radians())).abs() < 1e-12);
            }
            _ => unreachable!(),
        }
        // purity
        assert!(matches!(&v.camera, Camera::Arcball(a) if a.phi == phi0));
    }

    #[test]
    fn apply_elevation_clamps_at_pole() {
        // phi already at the top clamp: tilting further up clamps back to the
        // same value -> no-op -> None.
        let mut v = arcball_view();
        if let Camera::Arcball(a) = &mut v.camera {
            a.phi = std::f64::consts::PI - 0.05;
        }
        assert!(apply(&v, &ViewTransform::ElevationDelta(30.0), &extent_3d()).is_none());
        // Tilting DOWN from the same pole IS in range (phi decreases).
        let child = apply(&v, &ViewTransform::ElevationDelta(-30.0), &extent_3d()).unwrap();
        match &child.camera {
            Camera::Arcball(a) => {
                assert!(a.phi < std::f64::consts::PI - 0.05);
                assert!(a.phi >= 0.05);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn apply_elevation_clamp_stays_in_range_near_bottom() {
        // A large downward tilt clamps to the lower bound (0.05), never below.
        let mut v = arcball_view();
        if let Camera::Arcball(a) = &mut v.camera {
            a.phi = 0.2;
        }
        let child = apply(&v, &ViewTransform::ElevationDelta(-90.0), &extent_3d()).unwrap();
        match &child.camera {
            Camera::Arcball(a) => assert!((a.phi - 0.05).abs() < 1e-12),
            _ => unreachable!(),
        }
    }

    // --- apply: StepT (gated on t_count > 1, clamps at ends) ---

    #[test]
    fn apply_stept_forward() {
        let mut v = slice_view();
        v.view.t = 2;
        let child = apply(&v, &ViewTransform::StepT(1), &extent_3d()).unwrap();
        assert_eq!(child.view.t, 3);
    }

    #[test]
    fn apply_stept_back() {
        let mut v = slice_view();
        v.view.t = 2;
        let child = apply(&v, &ViewTransform::StepT(-1), &extent_3d()).unwrap();
        assert_eq!(child.view.t, 1);
    }

    #[test]
    fn apply_stept_below_zero_is_none() {
        let mut v = slice_view();
        v.view.t = 0;
        assert!(apply(&v, &ViewTransform::StepT(-1), &extent_3d()).is_none());
    }

    #[test]
    fn apply_stept_past_last_is_none() {
        let mut v = slice_view();
        v.view.t = 4; // last timepoint (t_count = 5)
        assert!(apply(&v, &ViewTransform::StepT(1), &extent_3d()).is_none());
    }

    #[test]
    fn apply_stept_single_timepoint_is_none() {
        let mut single = extent_3d();
        single.t_count = 1;
        let v = slice_view();
        assert!(apply(&v, &ViewTransform::StepT(1), &single).is_none());
        assert!(apply(&v, &ViewTransform::StepT(-1), &single).is_none());
    }

    #[test]
    fn apply_stept_zero_count_is_none() {
        // Degenerate: a dataset reporting t_count = 0 must not panic.
        let mut zero = extent_3d();
        zero.t_count = 0;
        let v = slice_view();
        assert!(apply(&v, &ViewTransform::StepT(1), &zero).is_none());
    }

    // --- apply: StepC (gated on c_count > 1, clamps at ends) ---

    #[test]
    fn apply_stepc_forward() {
        let mut v = slice_view();
        v.view.c = 0;
        let child = apply(&v, &ViewTransform::StepC(1), &extent_3d()).unwrap();
        assert_eq!(child.view.c, 1);
    }

    #[test]
    fn apply_stepc_back() {
        let mut v = slice_view();
        v.view.c = 1;
        let child = apply(&v, &ViewTransform::StepC(-1), &extent_3d()).unwrap();
        assert_eq!(child.view.c, 0);
    }

    #[test]
    fn apply_stepc_below_zero_is_none() {
        let mut v = slice_view();
        v.view.c = 0;
        assert!(apply(&v, &ViewTransform::StepC(-1), &extent_3d()).is_none());
    }

    #[test]
    fn apply_stepc_past_last_is_none() {
        let mut v = slice_view();
        v.view.c = 1; // last channel (c_count = 2)
        assert!(apply(&v, &ViewTransform::StepC(1), &extent_3d()).is_none());
    }

    #[test]
    fn apply_stepc_single_channel_is_none() {
        let mut single = extent_3d();
        single.c_count = 1;
        let v = slice_view();
        assert!(apply(&v, &ViewTransform::StepC(1), &single).is_none());
        assert!(apply(&v, &ViewTransform::StepC(-1), &single).is_none());
    }

    #[test]
    fn apply_stepc_zero_count_is_none() {
        // Degenerate: a dataset reporting c_count = 0 must not panic.
        let mut zero = extent_3d();
        zero.c_count = 0;
        let v = slice_view();
        assert!(apply(&v, &ViewTransform::StepC(1), &zero).is_none());
    }

    // --- apply: ToggleProjection (Arcball-only, flips render_mode) ---

    #[test]
    fn apply_toggle_projection_on_slice_is_none() {
        // Slice (2D) view with a settings entry: projection toggle is still
        // Arcball-only, so it doesn't apply.
        let mut v = default_view("wds-flat", [1, 1, 1, 512, 512], [800, 600]);
        assert!(matches!(v.camera, Camera::Slice(_)));
        // Force a settings entry to exist (default_view already adds one).
        assert!(!v.dataset_settings.is_empty());
        v.view.z_range = 0..1;
        assert!(
            apply(
                &v,
                &ViewTransform::ToggleProjection,
                &ViewExtent::from_dims([1, 1, 1, 512, 512])
            )
            .is_none()
        );
    }

    #[test]
    fn apply_toggle_projection_flips_render_mode() {
        // A volume Home view (Arcball) has a default dataset_settings entry whose
        // render_mode starts Translucent; toggling flips it to MaxIntensity.
        let dims = [1, 1, 40, 80, 100];
        let v = default_view("wds-vol", dims, [800, 600]);
        assert!(matches!(v.camera, Camera::Arcball(_)));
        // Sanity: starts translucent.
        assert!(
            v.dataset_settings
                .values()
                .all(|s| s.render_mode == RenderMode::Translucent)
        );
        let child = apply(
            &v,
            &ViewTransform::ToggleProjection,
            &ViewExtent::from_dims(dims),
        )
        .unwrap();
        assert!(
            child
                .dataset_settings
                .values()
                .all(|s| s.render_mode == RenderMode::MaxIntensity),
            "toggle should flip every entry to max-intensity"
        );
        // Toggling the child back returns to translucent.
        let back = apply(
            &child,
            &ViewTransform::ToggleProjection,
            &ViewExtent::from_dims(dims),
        )
        .unwrap();
        assert!(
            back.dataset_settings
                .values()
                .all(|s| s.render_mode == RenderMode::Translucent)
        );
        // purity: original untouched.
        assert!(
            v.dataset_settings
                .values()
                .all(|s| s.render_mode == RenderMode::Translucent)
        );
    }

    #[test]
    fn apply_toggle_projection_empty_settings_is_none() {
        // An Arcball view with NO dataset_settings entries has nothing to flip.
        let v = arcball_view();
        assert!(v.dataset_settings.is_empty());
        assert!(apply(&v, &ViewTransform::ToggleProjection, &extent_3d()).is_none());
    }

    // --- children: mode-dependent menus ---

    /// A rich 3D extent with room on EVERY dimensional axis (z/t/c all > 2), so
    /// an interior view offers each step in both directions. Distinct from the
    /// shared `extent_3d` (c_count = 2), which can't sit a channel between two
    /// neighbours.
    fn extent_rich() -> ViewExtent {
        ViewExtent {
            min: [0.0, 0.0, 0.0],
            max: [100.0, 80.0, 40.0],
            z_count: 40,
            t_count: 5,
            c_count: 3,
        }
    }

    #[test]
    fn children_slice_3d_dataset() {
        // Slice + 3D multichannel-timeseries dataset: Home, Zoom in/out, StepZ
        // +/-, StepT +/-, StepC +/- — but NO azimuth/elevation/projection (those
        // are Arcball-only). Mid-stack/mid-t/mid-c so each dimensional step is in
        // range both ways.
        let mut v = slice_view();
        v.view.z_range = 10..11;
        v.view.t = 2; // t_count = 5
        v.view.c = 1; // c_count = 3 -> 1 is interior
        let kids = children(&v, &extent_rich());
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "home", "zoom:in", "zoom:out", "stepz:+1", "stepz:-1", "stept:+1", "stept:-1",
                "stepc:+1", "stepc:-1",
            ]
        );
        // No 3D-camera-only cells on a 2D slice.
        assert!(!ids.iter().any(|id| id.starts_with("azimuth:")));
        assert!(!ids.iter().any(|id| id.starts_with("elevation:")));
        assert!(!ids.iter().any(|id| id.starts_with("projection:")));
    }

    #[test]
    fn children_arcball_3d_dataset() {
        // Arcball + 3D multichannel-timeseries, in the grouped MOVE_SET order:
        // Home, orient (azimuth +/- then elevation +/-), scale (zoom in/out),
        // then dimensional steps (StepZ +/-, StepT +/-, StepC +/-).
        // (ToggleProjection needs a dataset_settings entry, which a bare
        // arcball_view lacks — see children_arcball_full_extent_has_all_enriched_cells.)
        let mut v = arcball_view();
        v.view.z_range = 10..11;
        v.view.t = 2; // t_count = 5
        v.view.c = 1; // c_count = 3 -> 1 is interior
        let kids = children(&v, &extent_rich());
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "home",
                "azimuth:+45",
                "azimuth:-45",
                "elevation:+30",
                "elevation:-30",
                "zoom:in",
                "zoom:out",
                "stepz:+1",
                "stepz:-1",
                "stept:+1",
                "stept:-1",
                "stepc:+1",
                "stepc:-1",
            ]
        );
    }

    #[test]
    fn children_slice_flat_dataset_no_stepz() {
        // A truly flat single-slice, single-timepoint, single-channel image:
        // none of the dimensional steps (stepz/stept/stepc) are offered, only
        // Home + zoom.
        let mut flat = extent_3d();
        flat.z_count = 1;
        flat.t_count = 1;
        flat.c_count = 1;
        let v = slice_view();
        let kids = children(&v, &flat);
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert_eq!(ids, vec!["home", "zoom:in", "zoom:out"]);
        assert!(!ids.iter().any(|id| id.starts_with("stepz:")));
        assert!(!ids.iter().any(|id| id.starts_with("stept:")));
        assert!(!ids.iter().any(|id| id.starts_with("stepc:")));
    }

    #[test]
    fn children_arcball_full_extent_has_all_enriched_cells() {
        // A rich volume built by default_view (which seeds a dataset_settings
        // entry, so ToggleProjection is live) on a 3D multichannel-timeseries
        // extent offers the full enriched menu: elevation, stept, stepc, AND
        // projection:toggle.
        let dims = [40, 3, 340, 512, 512]; // [T, C, Z, Y, X]
        let mut view = default_view("wds-rich", dims, [800, 600]);
        assert!(matches!(view.camera, Camera::Arcball(_)));
        // default_view mid-points Z but leaves t/c at 0; sit them in the interior
        // so the reverse T/C steps are in range too.
        view.view.t = 20; // t_count = 40
        view.view.c = 1; // c_count = 3
        let kids = children(&view, &ViewExtent::from_dims(dims));
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        // Every applicable cell is offered, in the grouped MOVE_SET order:
        // orient → scale → render → step (Z/T/C). `home` is intentionally absent:
        // `default_view` already fits the camera to the extent, so re-applying
        // Home is a no-op and is dropped — this view still locks the relative
        // order of the rest.
        assert_eq!(
            ids,
            vec![
                "azimuth:+45",
                "azimuth:-45",
                "elevation:+30",
                "elevation:-30",
                "zoom:in",
                "zoom:out",
                "projection:toggle",
                "stepz:+1",
                "stepz:-1",
                "stept:+1",
                "stept:-1",
                "stepc:+1",
                "stepc:-1",
            ]
        );
    }

    #[test]
    fn children_projection_label_is_state_aware() {
        // The projection cell names the mode it switches TO, flipping with the
        // current render mode — not the static "Toggle ..." copy.
        let dims = [1, 1, 40, 80, 100];
        let mut view = default_view("wds-vol", dims, [800, 600]);
        let extent = ViewExtent::from_dims(dims);

        // Currently translucent -> the toggle offers max-intensity.
        let translucent_label = children(&view, &extent)
            .into_iter()
            .find(|c| c.transform == "projection:toggle")
            .expect("projection cell present on a volume")
            .label;
        assert_eq!(translucent_label, "Max-intensity projection");

        // Flip the view to max-intensity -> the toggle now offers volume rendering.
        for settings in view.dataset_settings.values_mut() {
            settings.render_mode = RenderMode::MaxIntensity;
        }
        let mip_label = children(&view, &extent)
            .into_iter()
            .find(|c| c.transform == "projection:toggle")
            .expect("projection cell present on a volume")
            .label;
        assert_eq!(mip_label, "Volume rendering (translucent)");

        // Neither dynamic label is the static fallback.
        assert_ne!(translucent_label, ViewTransform::ToggleProjection.label());
        assert_ne!(mip_label, ViewTransform::ToggleProjection.label());
    }

    #[test]
    fn children_slice_has_no_elevation_or_projection() {
        // A 2D Slice node never offers the Arcball-only enriched cells, even
        // with a dataset_settings entry present.
        let dims = [5, 3, 1, 512, 512]; // flat -> Slice Home, but multi-T/C
        let view = default_view("wds-2d", dims, [800, 600]);
        assert!(matches!(view.camera, Camera::Slice(_)));
        let kids = children(&view, &ViewExtent::from_dims(dims));
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert!(!ids.iter().any(|id| id.starts_with("elevation:")));
        assert!(!ids.iter().any(|id| id.starts_with("projection:")));
        // It DOES still offer dimensional T/C steps (it's multi-T/C).
        assert!(ids.contains(&"stept:+1"));
        assert!(ids.contains(&"stepc:+1"));
    }

    #[test]
    fn children_flat_single_channel_single_t_has_no_dimensional_steps() {
        // A genuinely flat single-channel single-timepoint image: no stepz,
        // stept, or stepc cells at all.
        let dims = [1, 1, 1, 1024, 1024]; // [T, C, Z, Y, X]
        let view = default_view("wds-flat", dims, [800, 600]);
        let kids = children(&view, &ViewExtent::from_dims(dims));
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert!(!ids.iter().any(|id| id.starts_with("stept:")));
        assert!(!ids.iter().any(|id| id.starts_with("stepc:")));
        assert!(!ids.iter().any(|id| id.starts_with("stepz:")));
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
    fn sidecar_carries_extent() {
        // The sidecar records the dataset extent it was built against, so every
        // surface gets the bounds/counts without re-deriving them.
        let v = arcball_view();
        let extent = extent_3d();
        let side = ExplorationSidecar::build(&v, &extent, 0, Vec::new());
        assert_eq!(side.extent, extent);
    }

    #[test]
    fn sidecar_cell_ztc_match_child_view() {
        // Each cell's z/t/c are the destination indices of its child view, so a
        // reader can orient on any surface without digging into `view.view`.
        let mut v = arcball_view();
        v.view.z_range = 10..11;
        v.view.t = 2; // t_count = 5
        v.view.c = 1; // c_count = 2 -> 1 is interior in one direction
        let extent = extent_3d();
        let side = ExplorationSidecar::build(&v, &extent, 0, Vec::new());
        for cell in &side.cells {
            assert_eq!(cell.z, cell.view.view.z_range.start);
            assert_eq!(cell.t, cell.view.view.t);
            assert_eq!(cell.c, cell.view.view.c);
        }
        // Sanity: a StepZ cell actually moved Z off the parent's 10.
        let stepz = side
            .cells
            .iter()
            .find(|c| c.transform == "stepz:+1")
            .expect("stepz:+1 present mid-stack");
        assert_eq!(stepz.z, 11);
        // ... while leaving t/c at the parent's values.
        assert_eq!(stepz.t, 2);
        assert_eq!(stepz.c, 1);
    }

    #[test]
    fn sidecar_round_trips_json() {
        let v = arcball_view();
        let extent = extent_3d();
        let side = ExplorationSidecar::build(&v, &extent, 0, Vec::new());
        let json = serde_json::to_string(&side).unwrap();
        let back: ExplorationSidecar = serde_json::from_str(&json).unwrap();
        assert_eq!(back.v, side.v);
        assert_eq!(back.current.handle, side.current.handle);
        // extent + per-cell z/t/c survive the round-trip.
        assert_eq!(back.extent, extent);
        assert_eq!(back.cells.len(), side.cells.len());
        for (cell, orig) in back.cells.iter().zip(side.cells.iter()) {
            assert_eq!(cell.z, orig.z);
            assert_eq!(cell.t, orig.t);
            assert_eq!(cell.c, orig.c);
        }
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

    // --- explore_view (the wasm-exported wrapper, exercised on the host) ---

    #[test]
    fn explore_view_home_volume_has_azimuth_cells() {
        // No view_json -> synthesize the Home view for a volume (z_count > 1),
        // which opens in an Arcball and so offers azimuth (rotate) cells.
        let json = explore_view(None, "wds-1", 1, 1, 40, 80, 100, 800, 600, 0);
        let sidecar: ExplorationSidecar = serde_json::from_str(&json).unwrap();
        assert_eq!(sidecar.v, EXPLORATION_SIDECAR_VERSION);
        assert!(
            sidecar
                .cells
                .iter()
                .any(|c| c.transform.starts_with("azimuth:")),
            "a volume Home should offer azimuth cells: {json}"
        );
    }

    #[test]
    fn explore_view_passes_depth_through() {
        // The caller's walk depth is recorded on the current node.
        let json = explore_view(None, "wds-1", 1, 1, 40, 80, 100, 800, 600, 3);
        let sidecar: ExplorationSidecar = serde_json::from_str(&json).unwrap();
        assert_eq!(sidecar.current.depth, 3);
    }

    #[test]
    fn explore_view_explicit_view_json_round_trips() {
        // A provided (well-formed) view_json is used verbatim as the current
        // node rather than synthesizing Home.
        let mut v = arcball_view();
        v.view.z_range = 10..11;
        let view_json = serde_json::to_string(&v).unwrap();
        let json = explore_view(Some(view_json), "wds-1", 1, 1, 40, 80, 100, 800, 600, 0);
        let sidecar: ExplorationSidecar = serde_json::from_str(&json).unwrap();
        assert_eq!(sidecar.current.handle, view_handle(&v));
    }

    #[test]
    fn explore_view_malformed_json_returns_error_string() {
        // Malformed view_json must not panic — it returns an {"error": ...} blob.
        let json = explore_view(
            Some("{not valid json".to_string()),
            "wds-1",
            1,
            1,
            40,
            80,
            100,
            800,
            600,
            0,
        );
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            value.get("error").is_some(),
            "malformed view_json should yield an error object: {json}"
        );
    }
}
