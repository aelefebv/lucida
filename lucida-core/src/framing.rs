//! Shared "fit the data to the view" framing geometry.
//!
//! Pure, camera-agnostic math for turning a world-space axis-aligned bounding
//! box into the values a camera needs to frame it. Two callers share this:
//!
//! - the **minimap** orbit camera ([`crate::minimap`]) — an *overview* inset
//!   that frames the limiting axis with [`FIT_PADDING`] slack via
//!   [`orbit_overview_framing`];
//! - the **main viewport** camera ([`crate::camera`]) — which must put the
//!   *whole* dataset in view, so it uses true bounding-sphere containment via
//!   [`slice_framing`] (2D) and [`arcball_containment`] (3D).
//!
//! What the two share is the bounds **accumulation** and **center**
//! computation ([`Aabb`]) plus the input normalization/sanitization, so an
//! offset, inverted, or degenerate box is handled the same way everywhere.
//!
//! Everything is native-testable (no wasm, no GPU).

/// Padding factor for the minimap's *overview* framing: the visible region is
/// `FIT_PADDING ×` the data's limiting extent.
///
/// This is the minimap's inset heuristic (see #836) and is deliberately looser
/// than the main camera's margins — it is **not** the main fit factor. Kept as
/// the single source of that constant for the minimap.
pub const FIT_PADDING: f64 = 1.8;

/// Margin for the **main 2D fit**: the data fills `1 / FIT_MARGIN_2D` (~87%) of
/// the limiting viewport axis — most of the view, with a little breathing room.
pub const FIT_MARGIN_2D: f64 = 1.15;

/// Margin for the **main 3D fit**: 10% slack around the data's bounding sphere
/// so every corner of the box clears the frustum edges.
pub const FIT_MARGIN_3D: f64 = 1.10;

/// A small floor for extents/divisors so a degenerate (zero-thickness) box —
/// a single plane, a line, or a point — never produces a zero or non-finite
/// camera distance/zoom. Chosen well below any meaningful world extent.
const MIN_EXTENT: f64 = 1e-9;

/// An axis-aligned bounding box accumulator in world space.
///
/// Start [`Aabb::empty`], fold in points or sub-boxes with [`Aabb::add_point`] /
/// [`Aabb::add_box`], then read the framing back with [`Aabb::center`] etc.
/// `min > max` while empty, so a fresh accumulator is detectable via
/// [`Aabb::is_empty`].
///
/// [`Aabb::sanitized`] is the normalizing entry point callers should prefer for
/// raw `[min, max]` pairs: it sorts each axis (so inverted bounds work) and
/// replaces any non-finite coordinate with a finite fallback.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Aabb {
    /// Per-axis minimum corner.
    pub min: [f64; 3],
    /// Per-axis maximum corner.
    pub max: [f64; 3],
}

impl Aabb {
    /// An empty box: `min = +inf`, `max = -inf`, so the first `add_*` adopts
    /// the incoming bounds exactly.
    pub fn empty() -> Self {
        Self {
            min: [f64::MAX; 3],
            max: [f64::MIN; 3],
        }
    }

    /// A box spanning `[min, max]` directly (no normalization — prefer
    /// [`Aabb::sanitized`] for raw input that might be inverted or non-finite).
    pub fn from_bounds(min: [f64; 3], max: [f64; 3]) -> Self {
        Self { min, max }
    }

    /// Build a well-formed box from raw `[min, max]` that may be **inverted**
    /// (`min[i] > max[i]`) or contain **non-finite** values.
    ///
    /// Each axis is sorted into `(lo, hi)`; any non-finite coordinate is dropped
    /// to `0.0` first, so `center` and the extents are always finite. This is the
    /// shared front door for the 2D and 3D fits.
    pub fn sanitized(min: [f64; 3], max: [f64; 3]) -> Self {
        let mut lo = [0.0; 3];
        let mut hi = [0.0; 3];
        for axis in 0..3 {
            let a = finite_or_zero(min[axis]);
            let b = finite_or_zero(max[axis]);
            lo[axis] = a.min(b);
            hi[axis] = a.max(b);
        }
        Self { min: lo, max: hi }
    }

    /// True until at least one point/box has been folded in.
    pub fn is_empty(&self) -> bool {
        self.min[0] > self.max[0] || self.min[1] > self.max[1] || self.min[2] > self.max[2]
    }

    /// Expand to include a single world-space point.
    pub fn add_point(&mut self, p: [f64; 3]) {
        for (axis, &v) in p.iter().enumerate() {
            self.min[axis] = self.min[axis].min(v);
            self.max[axis] = self.max[axis].max(v);
        }
    }

    /// Expand to include another box.
    pub fn add_box(&mut self, min: [f64; 3], max: [f64; 3]) {
        self.add_point(min);
        self.add_point(max);
    }

    /// Center of the box (midpoint of each axis).
    pub fn center(&self) -> [f64; 3] {
        [
            (self.min[0] + self.max[0]) / 2.0,
            (self.min[1] + self.max[1]) / 2.0,
            (self.min[2] + self.max[2]) / 2.0,
        ]
    }

    /// The largest per-axis extent (`max[i] - min[i]`), floored to stay strictly
    /// positive and finite so it is safe to divide a distance/zoom by it. A
    /// zero-thickness box therefore yields `MIN_EXTENT`, not `0`.
    pub fn max_extent(&self) -> f64 {
        let ex = self.max[0] - self.min[0];
        let ey = self.max[1] - self.min[1];
        let ez = self.max[2] - self.min[2];
        ex.max(ey).max(ez).max(MIN_EXTENT)
    }

    /// Radius of the sphere that circumscribes the box (half the space
    /// diagonal). Every corner is within this radius of [`Aabb::center`] at
    /// **any** viewing angle, which is what makes 3D containment
    /// angle-independent. Floored so a degenerate box still yields `> 0`.
    pub fn bounding_radius(&self) -> f64 {
        let dx = self.max[0] - self.min[0];
        let dy = self.max[1] - self.min[1];
        let dz = self.max[2] - self.min[2];
        (0.5 * (dx * dx + dy * dy + dz * dz).sqrt()).max(MIN_EXTENT)
    }
}

/// 3D **overview** framing for the minimap: `(center, max_axis_extent ·
/// padding)`.
///
/// This is the minimap's inset heuristic — it frames the limiting axis with
/// `padding` slack, *not* the whole bounding sphere. The main camera does not
/// use this; it uses [`arcball_containment`]. Inputs are sanitized/normalized so
/// an inverted or non-finite box is handled. Kept here so the minimap and the
/// main camera still share the `Aabb` accumulation + center.
pub fn orbit_overview_framing(min: [f64; 3], max: [f64; 3], padding: f64) -> ([f64; 3], f64) {
    let aabb = Aabb::sanitized(min, max);
    let distance = aabb.max_extent() * sane_factor(padding, FIT_PADDING);
    (aabb.center(), distance)
}

/// 3D **containment** framing for the main camera.
///
/// Returns `(target, distance, near, far)` that put the *entire* box in view at
/// any orbit angle and keep the depth-clip range tight around it:
///
/// - `target` = box center.
/// - `R` = bounding-sphere radius (half the space diagonal).
/// - `distance = (R / sin(limiting)) · margin`, where `limiting = min(fov/2,
///   atan(tan(fov/2) · aspect))` is the half-angle of the narrower frustum axis
///   — so the sphere fits **both** the vertical and horizontal field of view.
/// - `near = max(distance − R, distance · 1e-3, 1e-4)` and
///   `far = (distance + R) · 1.05`, with `0 < near < far` guaranteed, so the box
///   is neither clipped by the near plane nor lost beyond the far plane.
///
/// `fov` is the vertical field of view in radians; `viewport` is `[vw, vh]`.
/// Inputs are sanitized so every returned value is finite, `distance > 0`, and
/// `0 < near < far`.
pub fn arcball_containment(
    min: [f64; 3],
    max: [f64; 3],
    viewport: [u32; 2],
    fov: f64,
    margin: f64,
) -> ([f64; 3], f64, f64, f64) {
    let aabb = Aabb::sanitized(min, max);
    let target = aabb.center();
    let radius = aabb.bounding_radius();
    let margin = sane_factor(margin, FIT_MARGIN_3D);

    // A sane vertical half-angle in (0, π/2): guard a non-finite or out-of-range
    // fov so `sin(limiting)` is well away from 0.
    let half_v = if fov.is_finite() && fov > 0.0 {
        (fov * 0.5).min(MAX_HALF_ANGLE)
    } else {
        (std::f64::consts::FRAC_PI_4 * 0.5).min(MAX_HALF_ANGLE)
    };

    // Horizontal half-angle from the aspect ratio: half_h = atan(tan(half_v) ·
    // aspect). The limiting (narrower) axis decides how far back to sit so the
    // sphere fits both axes.
    let vw = viewport[0] as f64;
    let vh = viewport[1] as f64;
    let aspect = if vw.is_finite() && vh.is_finite() && vw > 0.0 && vh > 0.0 {
        vw / vh
    } else {
        1.0
    };
    let half_h = (half_v.tan() * aspect).atan();
    let limiting = half_v.min(half_h).clamp(MIN_HALF_ANGLE, MAX_HALF_ANGLE);

    let distance = (radius / limiting.sin() * margin).max(MIN_EXTENT);

    // Depth clip around the sphere. near clears the front face and stays > 0;
    // far clears the back face with a little slack.
    let near = (distance - radius)
        .max(distance * 1e-3)
        .max(1e-4)
        .max(MIN_EXTENT);
    let far = ((distance + radius) * 1.05).max(near * (1.0 + 1e-6));

    (target, distance, near, far)
}

/// 2D framing for the main camera: the point to center on and the zoom that puts
/// the whole rect in view with `margin` slack, tight in the limiting axis.
///
/// `viewport` is `[vw, vh]` in pixels. With the slice camera's convention
/// (`project = (world − center)·zoom + viewport/2`) the data fills `1 / margin`
/// of the viewport in whichever axis is the binding constraint. Inverted bounds
/// are normalized per-axis and non-finite inputs are sanitized; both axes are
/// floored against a degenerate (zero-width or zero-height) rect so `zoom` stays
/// finite and strictly positive — for a line/plane the camera fits the
/// non-degenerate axis.
pub fn slice_framing(
    min: [f64; 2],
    max: [f64; 2],
    viewport: [u32; 2],
    margin: f64,
) -> ([f64; 2], f64) {
    // Normalize + sanitize each axis (sort lo/hi, drop non-finite to 0).
    let mut lo = [0.0; 2];
    let mut hi = [0.0; 2];
    for axis in 0..2 {
        let a = finite_or_zero(min[axis]);
        let b = finite_or_zero(max[axis]);
        lo[axis] = a.min(b);
        hi[axis] = a.max(b);
    }
    let center = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0];

    let m = sane_factor(margin, FIT_MARGIN_2D);
    let data_w = (hi[0] - lo[0]).max(MIN_EXTENT);
    let data_h = (hi[1] - lo[1]).max(MIN_EXTENT);
    let vw = viewport[0] as f64;
    let vh = viewport[1] as f64;

    // Largest zoom that still fits `m × data` in *both* axes → the whole rect is
    // visible with `m` slack and tight in the limiting axis. `min` of the two
    // per-axis fits picks the binding constraint.
    let zoom_w = vw / (m * data_w);
    let zoom_h = vh / (m * data_h);
    let zoom = zoom_w.min(zoom_h);

    // Final guard: a zero/negative/non-finite viewport must not leak a bad zoom
    // out to a camera (world_bounds divides by it).
    let zoom = if zoom.is_finite() && zoom > 0.0 {
        zoom
    } else {
        1.0
    };

    (center, zoom)
}

/// Largest sphere/orbit half-angle we will fit at: just under 90° so
/// `sin(limiting)` ≈ 1 and `distance` ≈ `R · margin` (sphere fills the frustum).
const MAX_HALF_ANGLE: f64 = std::f64::consts::FRAC_PI_2 - 1e-3;
/// Smallest half-angle we will divide by, so a pathological tiny fov can't blow
/// `distance` up to non-finite.
const MIN_HALF_ANGLE: f64 = 1e-3;

/// `v` if finite, else `0.0`.
fn finite_or_zero(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}

/// Clamp a fit factor to something sane: at least 1.0 (never crop the data) and
/// finite (a `NaN`/`inf` knob falls back to `default`).
fn sane_factor(factor: f64, default: f64) -> f64 {
    if factor.is_finite() {
        factor.max(1.0)
    } else {
        default
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aabb_accumulates_points_and_boxes() {
        let mut b = Aabb::empty();
        assert!(b.is_empty());
        b.add_point([1.0, 2.0, 3.0]);
        assert!(!b.is_empty());
        b.add_point([-1.0, 5.0, 0.0]);
        b.add_box([0.0, 0.0, -2.0], [2.0, 2.0, 2.0]);
        assert_eq!(b.min, [-1.0, 0.0, -2.0]);
        assert_eq!(b.max, [2.0, 5.0, 3.0]);
    }

    #[test]
    fn aabb_center_is_midpoint() {
        let b = Aabb::from_bounds([0.0, 0.0, 0.0], [10.0, 4.0, 2.0]);
        assert_eq!(b.center(), [5.0, 2.0, 1.0]);
    }

    #[test]
    fn aabb_max_extent_picks_largest_axis() {
        let b = Aabb::from_bounds([0.0, 0.0, 0.0], [3.0, 10.0, 1.0]);
        assert_eq!(b.max_extent(), 10.0);
    }

    #[test]
    fn aabb_max_extent_floors_degenerate_box() {
        let b = Aabb::from_bounds([5.0, 5.0, 5.0], [5.0, 5.0, 5.0]);
        let e = b.max_extent();
        assert!(e.is_finite() && e > 0.0, "extent: {e}");
    }

    #[test]
    fn aabb_sanitized_normalizes_inverted_axes() {
        let b = Aabb::sanitized([10.0, 0.0, 5.0], [0.0, 8.0, -5.0]);
        assert_eq!(b.min, [0.0, 0.0, -5.0]);
        assert_eq!(b.max, [10.0, 8.0, 5.0]);
        assert_eq!(b.center(), [5.0, 4.0, 0.0]);
    }

    #[test]
    fn aabb_sanitized_drops_non_finite() {
        let b = Aabb::sanitized([f64::NAN, 0.0, 0.0], [10.0, f64::INFINITY, 2.0]);
        for v in b.min.iter().chain(b.max.iter()) {
            assert!(v.is_finite(), "non-finite leaked: {v}");
        }
    }

    #[test]
    fn aabb_bounding_radius_is_half_diagonal() {
        let b = Aabb::from_bounds([0.0, 0.0, 0.0], [2.0, 0.0, 0.0]);
        // diagonal length 2 → radius 1
        assert!((b.bounding_radius() - 1.0).abs() < 1e-12);
        let cube = Aabb::from_bounds([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
        assert!((cube.bounding_radius() - 0.5 * 3.0_f64.sqrt()).abs() < 1e-12);
    }

    #[test]
    fn orbit_overview_framing_matches_minimap_heuristic() {
        let (center, distance) =
            orbit_overview_framing([0.0, 0.0, 0.0], [2.0, 4.0, 1.0], FIT_PADDING);
        assert_eq!(center, [1.0, 2.0, 0.5]);
        assert!(
            (distance - 4.0 * FIT_PADDING).abs() < 1e-12,
            "distance: {distance}"
        );
    }

    #[test]
    fn orbit_overview_framing_degenerate_box_finite_positive() {
        let (_, distance) = orbit_overview_framing([7.0, 7.0, 7.0], [7.0, 7.0, 7.0], FIT_PADDING);
        assert!(
            distance.is_finite() && distance > 0.0,
            "distance: {distance}"
        );
    }

    #[test]
    fn arcball_containment_centers_and_clips_around_box() {
        let (target, distance, near, far) = arcball_containment(
            [0.0, 0.0, 0.0],
            [2.0, 2.0, 2.0],
            [800, 600],
            std::f64::consts::FRAC_PI_4,
            FIT_MARGIN_3D,
        );
        assert_eq!(target, [1.0, 1.0, 1.0]);
        let r = 0.5 * (12.0_f64).sqrt(); // half diagonal of a 2-cube
        // near must clear the front face and stay positive
        assert!(near > 0.0 && near < far, "near {near} far {far}");
        assert!(near <= distance - r + 1e-9 || near >= 1e-4);
        // far must clear the back face
        assert!(far >= distance + r, "far {far} < dist+R {}", distance + r);
        assert!(distance > r, "camera must sit outside the sphere");
    }

    #[test]
    fn arcball_containment_fits_both_axes_in_wide_viewport() {
        // Very wide viewport: vertical half-angle is the limiting one, so the
        // distance must be at least R / sin(fov/2) · margin.
        let fov = std::f64::consts::FRAC_PI_4;
        let (_, distance, _, _) = arcball_containment(
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [4000, 500],
            fov,
            FIT_MARGIN_3D,
        );
        let r = 0.5 * 3.0_f64.sqrt();
        let expected_min = r / (fov * 0.5).sin();
        assert!(
            distance >= expected_min,
            "distance {distance} < vertical-limited {expected_min}"
        );
    }

    #[test]
    fn arcball_containment_handles_inverted_and_non_finite() {
        let (target, distance, near, far) = arcball_containment(
            [10.0, f64::NAN, 5.0],
            [0.0, 8.0, f64::NEG_INFINITY],
            [800, 600],
            std::f64::consts::FRAC_PI_4,
            FIT_MARGIN_3D,
        );
        for v in target {
            assert!(v.is_finite(), "target non-finite: {v}");
        }
        assert!(
            distance.is_finite() && distance > 0.0,
            "distance {distance}"
        );
        assert!(near.is_finite() && near > 0.0, "near {near}");
        assert!(far.is_finite() && far > near, "far {far} near {near}");
    }

    #[test]
    fn arcball_containment_degenerate_box_finite() {
        let (_, distance, near, far) = arcball_containment(
            [3.0, 3.0, 3.0],
            [3.0, 3.0, 3.0],
            [800, 600],
            std::f64::consts::FRAC_PI_4,
            FIT_MARGIN_3D,
        );
        assert!(distance.is_finite() && distance > 0.0);
        assert!(near.is_finite() && near > 0.0 && near < far);
    }

    #[test]
    fn slice_framing_centers_and_fits_limiting_axis() {
        // Wide rect in an 800x600 viewport: width is the limiting axis.
        let (center, zoom) = slice_framing([0.0, 0.0], [100.0, 10.0], [800, 600], FIT_MARGIN_2D);
        assert_eq!(center, [50.0, 5.0]);
        let expected = 800.0 / (FIT_MARGIN_2D * 100.0);
        assert!((zoom - expected).abs() < 1e-12, "zoom {zoom} vs {expected}");
    }

    #[test]
    fn slice_framing_normalizes_inverted_bounds() {
        let (center, zoom) = slice_framing([100.0, 10.0], [0.0, 0.0], [800, 600], FIT_MARGIN_2D);
        assert_eq!(center, [50.0, 5.0]);
        let expected = 800.0 / (FIT_MARGIN_2D * 100.0);
        assert!((zoom - expected).abs() < 1e-12, "zoom {zoom} vs {expected}");
    }

    #[test]
    fn slice_framing_sanitizes_non_finite() {
        let (center, zoom) = slice_framing(
            [f64::NAN, 0.0],
            [100.0, f64::INFINITY],
            [800, 600],
            FIT_MARGIN_2D,
        );
        for v in center {
            assert!(v.is_finite(), "center non-finite: {v}");
        }
        assert!(zoom.is_finite() && zoom > 0.0, "zoom: {zoom}");
    }

    #[test]
    fn slice_framing_degenerate_axis_finite_positive() {
        let (_, zoom) = slice_framing([0.0, 5.0], [100.0, 5.0], [800, 600], FIT_MARGIN_2D);
        assert!(zoom.is_finite() && zoom > 0.0, "zoom: {zoom}");
        let expected = 800.0 / (FIT_MARGIN_2D * 100.0);
        assert!((zoom - expected).abs() < 1e-12, "zoom {zoom} vs {expected}");
    }

    #[test]
    fn slice_framing_fully_degenerate_box_finite_positive() {
        let (_, zoom) = slice_framing([3.0, 3.0], [3.0, 3.0], [800, 600], FIT_MARGIN_2D);
        assert!(zoom.is_finite() && zoom > 0.0, "zoom: {zoom}");
    }

    #[test]
    fn sane_factor_clamps_below_one_and_non_finite() {
        assert_eq!(sane_factor(0.0, FIT_MARGIN_2D), 1.0);
        assert_eq!(sane_factor(-5.0, FIT_MARGIN_2D), 1.0);
        assert_eq!(sane_factor(2.5, FIT_MARGIN_2D), 2.5);
        assert_eq!(sane_factor(f64::NAN, FIT_MARGIN_3D), FIT_MARGIN_3D);
        assert_eq!(sane_factor(f64::INFINITY, FIT_PADDING), FIT_PADDING);
    }
}
