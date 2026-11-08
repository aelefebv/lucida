//! Pure, mode-aware parametric view-transform generator: the engine behind
//! guided exploration on the CLI, Python, and web surfaces.
//!
//! Given a [`SavedView`] and the dataset's [`ViewExtent`], it enumerates a
//! fixed move-set ([`ViewTransform`]) and returns the child views, each with a
//! stable [`view_handle`] and a plain-language label. [`apply`] and
//! [`children`] never mutate their input. A move that makes no sense for the
//! camera mode or the dataset is simply not offered, never an error or a
//! panic. Every spatial move delegates to a [`Camera`] primitive: this module
//! is policy, never geometry.

use serde::{Deserialize, Serialize};

use crate::camera::{Camera, Framing};
use crate::framing::{FitBounds, VoxBox, WorldBox};
use crate::saved_view::SavedView;
use crate::scene::{DatasetDisplaySettings, RenderMode, Scene};
use crate::view::ViewState;
use lucida_content::DatasetId;

/// The spatial + dimensional extent of the dataset a view is exploring,
/// read off a [`Scene`] by [`ViewExtent::of`].
///
/// The box is held in both spaces, so the Home move fits whichever camera the
/// view has. Only the voxel box goes on the wire, as `min` and `max`. The
/// `*_count` fields are the sizes of the non-spatial axes and gate the
/// dimensional moves: `z_count <= 1` means a flat dataset with no slices to
/// step through.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ViewExtent {
    /// The dataset's box in voxel space.
    #[serde(flatten)]
    pub voxels: VoxBox,
    /// The same box in world space, where a volume camera frames it.
    #[serde(skip)]
    pub world: WorldBox,
    /// What a fit of the box leaves the camera: framed when the dataset is
    /// everything visible, as [`Scene::frame`] decides.
    #[serde(skip)]
    pub fit_framing: Framing,
    /// Number of Z slices in the dataset.
    pub z_count: u32,
    /// Number of timepoints.
    pub t_count: u32,
    /// Number of channels.
    pub c_count: u32,
    /// The dataset in hand. Channels are shown per layer, so the channel
    /// moves step this layer's solo and leave the others as they are; without
    /// it they step every layer together.
    #[serde(skip)]
    pub dataset_id: Option<DatasetId>,
}

impl ViewExtent {
    /// The soloed channel of the dataset in hand, or of the first soloed
    /// layer when the extent names none.
    pub fn solo_in(&self, view: &SavedView) -> Option<u32> {
        match &self.dataset_id {
            Some(id) => view.dataset_settings.get(id).and_then(|s| s.solo),
            None => view.dataset_settings.values().find_map(|s| s.solo),
        }
    }

    /// The extent of `dataset_id` in `scene`: its whole box, every member of
    /// a collection included, and the axis counts of its first image at
    /// level 0. `None` when the scene doesn't hold the dataset or it has no
    /// bounds.
    pub fn of(scene: &Scene, dataset_id: &DatasetId) -> Option<Self> {
        let bounds = scene.dataset_bounds(&dataset_id.0)?;
        let [t, c, z, _, _] = scene
            .document
            .manifests
            .get(dataset_id)?
            .images()
            .first()?
            .multiscale
            .levels
            .first()?
            .shape;
        let mut visible = scene.visible_dataset_ids();
        let alone = visible.next() == Some(dataset_id) && visible.next().is_none();
        Some(ViewExtent {
            voxels: bounds.vox,
            world: bounds.world,
            fit_framing: if alone {
                Framing::Framed
            } else {
                Framing::Placed
            },
            z_count: z as u32,
            t_count: t as u32,
            c_count: c as u32,
            dataset_id: Some(dataset_id.clone()),
        })
    }

    /// The box in both spaces, for [`Camera::fit`].
    pub fn bounds(&self) -> FitBounds {
        FitBounds {
            vox: self.voxels,
            world: self.world,
        }
    }
}

/// A dataset's "Home" view on a canvas of `viewport` device pixels, the
/// exploration root when a caller gives no explicit view.
///
/// A volume (`z_count > 1`) opens in a 3D [`Camera::Arcball`] and a flat
/// image in a 2D [`Camera::Slice`]: a new camera fitted to the dataset as
/// [`Scene::frame`] fits one, so every client gets the same Home. The dataset
/// is visible with a default display-settings entry, since an absent entry
/// would reset the colormap. The view sits on the mid-Z slice so a
/// [`StepZ`](ViewTransform::StepZ) is in range both ways.
///
/// `None` when the scene doesn't hold the dataset or it has no bounds.
pub fn home_view(scene: &Scene, dataset_id: &DatasetId, viewport: [u32; 2]) -> Option<SavedView> {
    let extent = ViewExtent::of(scene, dataset_id)?;
    let mut camera = if extent.z_count > 1 {
        Camera::new_3d(viewport)
    } else {
        Camera::new_2d(viewport)
    };
    camera.fit(&extent.bounds());
    camera.set_framing(extent.fit_framing);

    let mut view = SavedView::empty(viewport);
    view.camera = camera;
    view.dataset_order = vec![dataset_id.clone()];
    // Make the dataset visible: a default display-settings entry (an absent
    // entry would otherwise reset the colormap) plus auto-contrast on.
    view.dataset_settings
        .insert(dataset_id.clone(), DatasetDisplaySettings::default());
    view.auto_contrast.insert(dataset_id.clone(), true);

    // Start on a single mid-stack slice (so a StepZ in either direction is in
    // range on a volume); a flat dataset collapses to z 0..1 anyway.
    let z0 = extent.z_count / 2;
    view.view = ViewState {
        z_range: z0..z0 + 1,
        ..ViewState::new()
    };
    Some(view)
}

/// Guided exploration of `dataset_id` in `scene`, from `view` or, without
/// one, from the dataset's [`home_view`] on a canvas of `viewport`. The web,
/// the CLI and the Python client all call this, so they share one Home and
/// one extent.
///
/// `depth` and `breadcrumb` are the caller's walk, stamped on the current
/// node. `None` when the scene doesn't hold the dataset or it has no bounds.
pub fn explore(
    scene: &Scene,
    dataset_id: &DatasetId,
    view: Option<&SavedView>,
    viewport: [u32; 2],
    depth: u32,
    breadcrumb: Vec<String>,
) -> Option<ExplorationSidecar> {
    let extent = ViewExtent::of(scene, dataset_id)?;
    let current = match view {
        Some(view) => view.clone(),
        None => home_view(scene, dataset_id, viewport)?,
    };
    Some(ExplorationSidecar::build(
        &current, &extent, depth, breadcrumb,
    ))
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
    /// Step the solo by a signed offset, the composite counting as the
    /// position before channel 0. Available in every mode, but no-ops away
    /// on a single-channel (`c_count <= 1`) or out-of-range move.
    StepC(i32),
    /// Flip volume rendering between translucent and max-intensity projection.
    /// Arcball-only — it changes how the 3D volume is rendered.
    ToggleProjection,
}

impl ViewTransform {
    /// Whether this move is meaningful for `cam`'s mode at all. Range and
    /// no-op checks happen later, in [`apply`].
    ///
    /// - [`Home`](ViewTransform::Home), [`StepZ`](ViewTransform::StepZ),
    ///   [`StepT`](ViewTransform::StepT), [`StepC`](ViewTransform::StepC):
    ///   every camera, since a dimensional step is not a camera move.
    /// - [`Zoom`](ViewTransform::Zoom): not [`Camera::Fly`], which moves by
    ///   flying.
    /// - [`AzimuthDelta`](ViewTransform::AzimuthDelta),
    ///   [`ElevationDelta`](ViewTransform::ElevationDelta),
    ///   [`ToggleProjection`](ViewTransform::ToggleProjection): only
    ///   [`Camera::Arcball`].
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

/// Apply one move to `view`, returning the child view, or [`None`] when the
/// move is not available from here. `view` is never mutated.
///
/// [`None`] when [`ViewTransform::applies_to`] is `false`, when a dimensional
/// step lands off the dataset, or when the child would equal the input. A
/// cell that goes nowhere is noise, so it is omitted.
pub fn apply(view: &SavedView, t: &ViewTransform, extent: &ViewExtent) -> Option<SavedView> {
    // Mode gate first — a move that doesn't apply to this camera never produces
    // a child, regardless of parameters.
    if !t.applies_to(&view.camera) {
        return None;
    }

    let mut child = view.clone();

    match t {
        ViewTransform::Home => {
            // Mode-preserving fit: a Slice stays 2D, an Arcball stays 3D, each
            // taking the box in its own space.
            child.camera.fit(&extent.bounds());
            child.camera.set_framing(extent.fit_framing);
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
                // The interactive zoom path, which carries the clip planes
                // along with the eye.
                Camera::Arcball(a) => a.zoom(1.0 / *factor - 1.0),
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
            // The composite sits one step before the first channel, so a step
            // forward from it solos channel 0 and a step back from channel 0
            // returns to it.
            let current = extent.solo_in(view).map_or(-1, i64::from);
            let next = current + *d as i64;
            if next < -1 || next >= extent.c_count as i64 {
                return None;
            }
            if let Some(id) = &extent.dataset_id
                && !child.dataset_settings.contains_key(id)
            {
                return None;
            }
            let solo = u32::try_from(next).ok();
            for (id, settings) in child.dataset_settings.iter_mut() {
                if extent.dataset_id.as_ref().is_some_and(|hand| hand != id) {
                    continue;
                }
                // Home's entry lists no channels; the extent counts them.
                let count = match settings.channel_settings.len() {
                    0 => extent.c_count,
                    n => n as u32,
                };
                settings.solo = solo.filter(|&c| c < count);
            }
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

    // A rotated or zoomed fit is a chosen view: left framed, the page showing
    // it would fit it again and undo the move.
    let steered = matches!(
        t,
        ViewTransform::AzimuthDelta(_) | ViewTransform::ElevationDelta(_) | ViewTransform::Zoom(_)
    );
    if steered && child.camera != view.camera {
        child.camera.set_framing(Framing::Placed);
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

/// The canonical guided-exploration move-set, in display order: reframe,
/// orient, scale, render, then step through Z/T/C. All filtering lives in
/// [`apply`], so a move that does not fit the current view drops out of
/// [`children`].
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

/// Enumerate the available next steps from `view`: every [`MOVE_SET`] entry
/// that [`apply`] turns into a child, in order. `view` is not mutated.
///
/// Labels are [`ViewTransform::label`], except the projection cell's, which
/// [`projection_label`] makes name the destination mode.
pub fn children(view: &SavedView, extent: &ViewExtent) -> Vec<Child> {
    let mut out = Vec::new();
    for t in MOVE_SET.iter() {
        if let Some(child_view) = apply(view, t, extent) {
            // The projection cell's label depends on the current render mode
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
/// cell: name the mode the toggle switches to, read from the view's first
/// [`dataset_settings`](SavedView::dataset_settings) entry. Falls back to the
/// static [`ViewTransform::label`] when there is no entry.
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
/// The same [`SavedView`] maps to the same handle in any run, so a handle
/// minted on one surface addresses the same view on another. It is FNV-1a
/// 64-bit over the view's order-stable JSON, not
/// [`std::hash::DefaultHasher`], whose output can change across Rust
/// versions. A content address, not a security token.
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

/// One offered next step in a serialized sidecar: a [`Child`] plus the
/// destination's indices and optional fields the higher tiers fill in.
///
/// `z`/`t`/`c` are the child view's destination indices (`z` is the start of
/// the Z slab), carried so every surface gets the same orientation without
/// re-deriving it; see [`ExplorationSidecar::build`]. `url` (a deep link),
/// `stat` (a scalar such as a score), and `incomplete` are emitted empty here
/// and never read; `url` and `stat` are skipped on serialization when absent.
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
    /// Destination soloed channel, absent for the composite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub c: Option<u32>,
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
/// Python / web tiers serialize, ship, and render. Never read back: the
/// extent's world box exists only in the scene that built it.
#[derive(Debug, Clone, Serialize)]
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
                c: extent.solo_in(&c.view),
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
    use crate::command::DocumentCommand;
    use crate::scene::test_helpers::make_dataset_opened_with_shape;

    /// A scene holding one image of shape `dims` (`[T, C, Z, Y, X]`) as `id`.
    fn scene_of(id: &str, dims: [u64; 5]) -> Scene {
        let chunk = [1, 1, dims[2].min(64), dims[3].min(256), dims[4].min(256)];
        let mut scene = Scene::new([800, 600]);
        scene.apply(
            DocumentCommand::DatasetOpened(make_dataset_opened_with_shape(
                id, id, dims[1], dims, chunk, 1,
            ))
            .into(),
        );
        scene
    }

    fn extent_of(dims: [u64; 5]) -> ViewExtent {
        ViewExtent::of(&scene_of("ds", dims), &DatasetId("ds".into())).unwrap()
    }

    fn home_of(id: &str, dims: [u64; 5], viewport: [u32; 2]) -> SavedView {
        home_view(&scene_of(id, dims), &DatasetId(id.into()), viewport).unwrap()
    }

    fn extent_3d() -> ViewExtent {
        ViewExtent {
            voxels: VoxBox::new([0.0, 0.0, 0.0], [100.0, 80.0, 40.0]),
            world: WorldBox::new([0.0, 0.0, 0.0], [100.0, 80.0, 40.0]),
            fit_framing: Framing::Framed,
            z_count: 40,
            t_count: 5,
            c_count: 2,
            dataset_id: None,
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

    /// `v` with one layer entry soloed on `solo`, or showing its composite.
    fn soloed(mut v: SavedView, solo: Option<u32>) -> SavedView {
        v.dataset_settings.insert(
            DatasetId("ds".into()),
            DatasetDisplaySettings {
                solo,
                ..Default::default()
            },
        );
        v
    }

    fn solo_of(v: &SavedView) -> Option<u32> {
        v.dataset_settings[&DatasetId("ds".into())].solo
    }

    fn fly_view() -> SavedView {
        let mut v = SavedView::empty([1024, 768]);
        v.camera = Camera::Fly(Fly::new([1024, 768]));
        v
    }

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
        // Tilting down from the same pole is in range (phi decreases).
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

    #[test]
    fn apply_stepc_forward() {
        let v = soloed(slice_view(), Some(0));
        let child = apply(&v, &ViewTransform::StepC(1), &extent_3d()).unwrap();
        assert_eq!(solo_of(&child), Some(1));
    }

    #[test]
    fn apply_stepc_from_the_composite_solos_the_first_channel() {
        let v = soloed(slice_view(), None);
        let child = apply(&v, &ViewTransform::StepC(1), &extent_3d()).unwrap();
        assert_eq!(solo_of(&child), Some(0));
        assert!(apply(&v, &ViewTransform::StepC(-1), &extent_3d()).is_none());
    }

    #[test]
    fn apply_stepc_steps_only_the_dataset_in_hand() {
        let mut v = soloed(slice_view(), None);
        v.dataset_settings.insert(
            DatasetId("other".into()),
            DatasetDisplaySettings {
                solo: Some(1),
                ..Default::default()
            },
        );
        let extent = ViewExtent {
            dataset_id: Some(DatasetId("ds".into())),
            ..extent_3d()
        };
        let solo_of_other = |v: &SavedView| v.dataset_settings[&DatasetId("other".into())].solo;

        // The other layer's solo is not the dataset in hand's position.
        assert!(apply(&v, &ViewTransform::StepC(-1), &extent).is_none());
        let child = apply(&v, &ViewTransform::StepC(1), &extent).unwrap();
        assert_eq!(solo_of(&child), Some(0));
        assert_eq!(solo_of_other(&child), Some(1));

        let cells = ExplorationSidecar::build(&v, &extent, 0, Vec::new()).cells;
        let step = cells.iter().find(|c| c.transform == "stepc:+1").unwrap();
        assert_eq!(step.c, Some(0));
    }

    #[test]
    fn apply_stepc_back() {
        let v = soloed(slice_view(), Some(1));
        let child = apply(&v, &ViewTransform::StepC(-1), &extent_3d()).unwrap();
        assert_eq!(solo_of(&child), Some(0));
    }

    #[test]
    fn apply_stepc_back_from_the_first_channel_returns_to_the_composite() {
        let v = soloed(slice_view(), Some(0));
        let child = apply(&v, &ViewTransform::StepC(-1), &extent_3d()).unwrap();
        assert_eq!(solo_of(&child), None);
    }

    #[test]
    fn apply_stepc_past_last_is_none() {
        let v = soloed(slice_view(), Some(1)); // last channel (c_count = 2)
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

    #[test]
    fn apply_toggle_projection_on_slice_is_none() {
        // Slice (2D) view with a settings entry: projection toggle is still
        // Arcball-only, so it doesn't apply.
        let mut v = home_of("wds-flat", [1, 1, 1, 512, 512], [800, 600]);
        assert!(matches!(v.camera, Camera::Slice(_)));
        // Force a settings entry to exist (the Home view already adds one).
        assert!(!v.dataset_settings.is_empty());
        v.view.z_range = 0..1;
        assert!(
            apply(
                &v,
                &ViewTransform::ToggleProjection,
                &extent_of([1, 1, 1, 512, 512])
            )
            .is_none()
        );
    }

    #[test]
    fn apply_toggle_projection_flips_render_mode() {
        // A volume Home view (Arcball) has a default dataset_settings entry whose
        // render_mode starts Translucent; toggling flips it to MaxIntensity.
        let dims = [1, 1, 40, 80, 100];
        let v = home_of("wds-vol", dims, [800, 600]);
        assert!(matches!(v.camera, Camera::Arcball(_)));
        // Sanity: starts translucent.
        assert!(
            v.dataset_settings
                .values()
                .all(|s| s.render_mode == RenderMode::Translucent)
        );
        let child = apply(&v, &ViewTransform::ToggleProjection, &extent_of(dims)).unwrap();
        assert!(
            child
                .dataset_settings
                .values()
                .all(|s| s.render_mode == RenderMode::MaxIntensity),
            "toggle should flip every entry to max-intensity"
        );
        // Toggling the child back returns to translucent.
        let back = apply(&child, &ViewTransform::ToggleProjection, &extent_of(dims)).unwrap();
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
        // An Arcball view with no dataset_settings entries has nothing to flip.
        let v = arcball_view();
        assert!(v.dataset_settings.is_empty());
        assert!(apply(&v, &ViewTransform::ToggleProjection, &extent_3d()).is_none());
    }

    /// A rich 3D extent with room on every dimensional axis (z/t/c all > 2), so
    /// an interior view offers each step in both directions. Distinct from the
    /// shared `extent_3d` (c_count = 2), which can't sit a channel between two
    /// neighbours.
    fn extent_rich() -> ViewExtent {
        ViewExtent {
            voxels: VoxBox::new([0.0, 0.0, 0.0], [100.0, 80.0, 40.0]),
            world: WorldBox::new([0.0, 0.0, 0.0], [100.0, 80.0, 40.0]),
            fit_framing: Framing::Framed,
            z_count: 40,
            t_count: 5,
            c_count: 3,
            dataset_id: None,
        }
    }

    #[test]
    fn children_slice_3d_dataset() {
        // Slice + 3D multichannel-timeseries dataset: Home, Zoom in/out, StepZ
        // +/-, StepT +/-, StepC +/- — but no azimuth/elevation/projection (those
        // are Arcball-only). Mid-stack/mid-t/mid-c so each dimensional step is in
        // range both ways.
        let mut v = soloed(slice_view(), Some(1)); // c_count = 3 -> 1 is interior
        v.view.z_range = 10..11;
        v.view.t = 2; // t_count = 5
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
        // render (projection), then dimensional steps (StepZ +/-, StepT +/-,
        // StepC +/-).
        let mut v = arcball_view();
        v.view.z_range = 10..11;
        v.view.t = 2; // t_count = 5
        // c_count = 3 -> 1 is interior. The solo needs a layer entry, which
        // also offers the projection toggle.
        v = soloed(v, Some(1));
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
        // A rich volume built by home_of (which seeds a dataset_settings
        // entry, so ToggleProjection is live) on a 3D multichannel-timeseries
        // extent offers the full enriched menu: elevation, stept, stepc, and
        // projection:toggle.
        let dims = [40, 3, 340, 512, 512]; // [T, C, Z, Y, X]
        let mut view = home_of("ds", dims, [800, 600]);
        assert!(matches!(view.camera, Camera::Arcball(_)));
        // home_of mid-points Z but leaves t at 0 and the composite on; sit
        // both in the interior so the reverse T/C steps are in range too.
        view.view.t = 20; // t_count = 40
        for settings in view.dataset_settings.values_mut() {
            settings.solo = Some(1); // c_count = 3
        }
        let kids = children(&view, &extent_of(dims));
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        // Every applicable cell is offered, in the grouped MOVE_SET order:
        // orient → scale → render → step (Z/T/C). `home` is intentionally absent:
        // `home_of` already fits the camera to the extent, so re-applying
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
        let mut view = home_of("wds-vol", dims, [800, 600]);
        let extent = extent_of(dims);

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
        let view = home_of("ds", dims, [800, 600]);
        assert!(matches!(view.camera, Camera::Slice(_)));
        let kids = children(&view, &extent_of(dims));
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert!(!ids.iter().any(|id| id.starts_with("elevation:")));
        assert!(!ids.iter().any(|id| id.starts_with("projection:")));
        // It does still offer dimensional T/C steps (it's multi-T/C).
        assert!(ids.contains(&"stept:+1"));
        assert!(ids.contains(&"stepc:+1"));
    }

    #[test]
    fn children_flat_single_channel_single_t_has_no_dimensional_steps() {
        // A genuinely flat single-channel single-timepoint image: no stepz,
        // stept, or stepc cells at all.
        let dims = [1, 1, 1, 1024, 1024]; // [T, C, Z, Y, X]
        let view = home_of("wds-flat", dims, [800, 600]);
        let kids = children(&view, &extent_of(dims));
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
        let mut v = soloed(arcball_view(), Some(1)); // c_count = 2
        v.view.z_range = 10..11;
        v.view.t = 2; // t_count = 5
        let extent = extent_3d();
        let side = ExplorationSidecar::build(&v, &extent, 0, Vec::new());
        for cell in &side.cells {
            assert_eq!(cell.z, cell.view.view.z_range.start);
            assert_eq!(cell.t, cell.view.view.t);
            assert_eq!(cell.c, solo_of(&cell.view));
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
        assert_eq!(stepz.c, Some(1));
    }

    #[test]
    fn sidecar_serializes_extent_and_cell_indices() {
        let v = arcball_view();
        let extent = extent_3d();
        let side = ExplorationSidecar::build(&v, &extent, 0, Vec::new());
        let back = serde_json::to_value(&side).unwrap();
        assert_eq!(back["v"], side.v);
        assert_eq!(back["current"]["handle"], side.current.handle);
        assert_eq!(back["extent"], serde_json::to_value(&extent).unwrap());
        let cells = back["cells"].as_array().unwrap();
        assert_eq!(cells.len(), side.cells.len());
        for (cell, orig) in cells.iter().zip(side.cells.iter()) {
            assert_eq!(cell["z"], orig.z);
            assert_eq!(cell["t"], orig.t);
            assert_eq!(cell["c"], serde_json::to_value(orig.c).unwrap());
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
            voxels: VoxBox::new([5.0, 5.0, 5.0], [5.0, 5.0, 5.0]),
            world: WorldBox::new([5.0, 5.0, 5.0], [5.0, 5.0, 5.0]),
            fit_framing: Framing::Framed,
            z_count: 0,
            t_count: 0,
            c_count: 0,
            dataset_id: None,
        };
        let v = slice_view();
        let _ = children(&v, &point);
        let _ = ExplorationSidecar::build(&v, &point, 0, Vec::new());
        // Fly camera + degenerate extent: still no panic.
        let f = fly_view();
        let _ = children(&f, &point);
    }

    #[test]
    fn extent_maps_tczyx_to_the_voxel_box_and_counts() {
        // dims = [T, C, Z, Y, X]: the box spans X/Y/Z, counts carry T/C/Z.
        let extent = extent_of([1, 2, 340, 512, 768]);
        assert_eq!(extent.voxels.min, [0.0, 0.0, 0.0]);
        assert_eq!(extent.voxels.max, [768.0, 512.0, 340.0]);
        assert_eq!(extent.z_count, 340);
        assert_eq!(extent.t_count, 1);
        assert_eq!(extent.c_count, 2);
    }

    #[test]
    fn extent_of_a_flat_dataset() {
        // A flat (Z = 1) multichannel image: z_count = 1 gates out slice steps.
        let extent = extent_of([3, 4, 1, 1024, 2048]);
        assert_eq!(extent.voxels.max, [2048.0, 1024.0, 1.0]);
        assert_eq!(extent.z_count, 1);
        assert_eq!(extent.t_count, 3);
        assert_eq!(extent.c_count, 4);
    }

    #[test]
    fn extent_holds_the_world_box_the_scene_frames() {
        let scene = scene_of("ds", [1, 1, 40, 80, 100]);
        let extent = ViewExtent::of(&scene, &DatasetId("ds".into())).unwrap();
        assert_eq!(Some(extent.world), scene.dataset_world_bounds("ds"));
        assert!(
            extent.world.max[0] < 2.0,
            "the world box is the normalized one, not the voxel box: {:?}",
            extent.world
        );
    }

    #[test]
    fn extent_puts_only_the_voxel_box_on_the_wire() {
        let extent = extent_of([5, 2, 40, 80, 100]);
        let value = serde_json::to_value(&extent).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "min": [0.0, 0.0, 0.0],
                "max": [100.0, 80.0, 40.0],
                "z_count": 40,
                "t_count": 5,
                "c_count": 2,
            })
        );
    }

    #[test]
    fn home_is_arcball_for_volume() {
        let view = home_of("wds-1", [1, 1, 340, 512, 512], [800, 600]);
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
    fn home_is_slice_for_flat() {
        let view = home_of("wds-2", [1, 3, 1, 1024, 1024], [800, 600]);
        assert!(
            matches!(view.camera, Camera::Slice(_)),
            "a flat image (z_count <= 1) should open in a 2D Slice Home"
        );
        // A flat dataset has a single slice at z 0.
        assert_eq!(view.view.z_range, 0..1);
        assert_eq!(view.dataset_order, vec![DatasetId("wds-2".to_string())]);
    }

    #[test]
    fn home_matches_the_scenes_own_fit() {
        // Every client's Home is the camera the scene fits on open, so the
        // CLI, Python and the viewer agree on it.
        let dims = [1, 1, 40, 80, 100];
        let mut scene = scene_of("ds", dims);
        scene.set_mode_3d();
        let home = home_view(&scene, &DatasetId("ds".into()), [800, 600]).unwrap();
        assert_eq!(home.camera, scene.camera);
        assert_eq!(home.camera.framing(), Framing::Framed);
    }

    #[test]
    fn home_of_one_dataset_among_others_is_placed() {
        // A fit of one dataset is a choice when others are visible, so a page
        // keeps its region instead of fitting everything.
        let mut scene = scene_of("a", [1, 1, 1, 64, 64]);
        scene.apply(
            DocumentCommand::DatasetOpened(make_dataset_opened_with_shape(
                "b",
                "b",
                1,
                [1, 1, 1, 512, 512],
                [1, 1, 1, 256, 256],
                1,
            ))
            .into(),
        );
        let home = home_view(&scene, &DatasetId("a".into()), [800, 600]).unwrap();
        assert_eq!(home.camera.framing(), Framing::Placed);
    }

    #[test]
    fn home_feeds_children() {
        // The Home view a volume yields should offer azimuth cells (it's an
        // Arcball) and Z-step cells (mid-stack, in range both ways).
        let dims = [1, 1, 40, 80, 100];
        let view = home_of("wds-3", dims, [800, 600]);
        let kids = children(&view, &extent_of(dims));
        let ids: Vec<&str> = kids.iter().map(|c| c.transform.as_str()).collect();
        assert!(ids.iter().any(|id| id.starts_with("azimuth:")));
        assert!(ids.contains(&"stepz:+1"));
        assert!(ids.contains(&"stepz:-1"));
    }

    #[test]
    fn explore_from_home_offers_azimuth_cells_for_a_volume() {
        let scene = scene_of("wds-1", [1, 1, 40, 80, 100]);
        let id = DatasetId("wds-1".into());
        let sidecar = explore(&scene, &id, None, [800, 600], 3, Vec::new()).unwrap();
        assert_eq!(sidecar.v, EXPLORATION_SIDECAR_VERSION);
        assert_eq!(sidecar.current.depth, 3);
        assert!(
            sidecar
                .cells
                .iter()
                .any(|c| c.transform.starts_with("azimuth:")),
            "a volume Home should offer azimuth cells"
        );
    }

    #[test]
    fn explore_uses_a_given_view_as_the_current_node() {
        let scene = scene_of("wds-1", [1, 1, 40, 80, 100]);
        let mut v = arcball_view();
        v.view.z_range = 10..11;
        let sidecar = explore(
            &scene,
            &DatasetId("wds-1".into()),
            Some(&v),
            [800, 600],
            0,
            Vec::new(),
        )
        .unwrap();
        assert_eq!(sidecar.current.handle, view_handle(&v));
    }

    #[test]
    fn explore_home_move_frames_the_world_box_from_an_arcball() {
        // A 3D camera works in normalized world space, not the voxel box the
        // shape implies, so Home centers on the world box.
        let scene = scene_of("wds-1", [1, 1, 40, 80, 100]);
        let id = DatasetId("wds-1".into());
        let mut start = arcball_view();
        if let Camera::Arcball(a) = &mut start.camera {
            a.target = [9.0, 9.0, 9.0];
        }
        let sidecar = explore(&scene, &id, Some(&start), [800, 600], 0, Vec::new()).unwrap();
        let home = sidecar
            .cells
            .iter()
            .find(|c| c.transform == "home")
            .expect("a home cell");
        let world = scene.dataset_world_bounds("wds-1").unwrap();
        let Camera::Arcball(a) = &home.view.camera else {
            panic!("home kept the arcball, got {:?}", home.view.camera);
        };
        for axis in 0..3 {
            let mid = (world.min[axis] + world.max[axis]) / 2.0;
            assert!(
                (a.target[axis] - mid).abs() < 1e-9,
                "home target {:?}",
                a.target
            );
        }
    }

    #[test]
    fn a_move_from_a_fitted_view_is_placed_and_a_step_stays_framed() {
        // A page fits a framed view again on its canvas, which would undo a
        // rotation or a zoom; a step through Z leaves the fit as it was.
        let home = home_of("wds-1", [1, 1, 40, 80, 100], [800, 600]);
        assert_eq!(home.camera.framing(), Framing::Framed);
        for child in children(&home, &extent_of([1, 1, 40, 80, 100])) {
            let want = if child.transform.starts_with("azimuth:")
                || child.transform.starts_with("elevation:")
                || child.transform.starts_with("zoom:")
            {
                Framing::Placed
            } else {
                Framing::Framed
            };
            assert_eq!(child.view.camera.framing(), want, "{}", child.transform);
        }
    }

    #[test]
    fn explore_of_an_unknown_dataset_is_none() {
        let scene = scene_of("wds-1", [1, 1, 40, 80, 100]);
        let ghost = DatasetId("ghost".into());
        assert!(explore(&scene, &ghost, None, [800, 600], 0, Vec::new()).is_none());
    }
}
