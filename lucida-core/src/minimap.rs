//! Minimap framing geometry.
//!
//! Pure, target-agnostic math for the minimap's orbit camera so it can be unit
//! tested natively (the `wasm` module that calls this is `wasm32`-only). The
//! wasm layer collects each member's model matrix plus whether its dataset is
//! visible; this decides where the minimap camera looks and how far back it sits.
//!
//! The bounds **accumulation** and **center** computation live in
//! [`crate::framing`] (shared with the main viewport camera via [`Aabb`]); this
//! module keeps the minimap's own *overview* framing — frame the limiting axis
//! with [`FIT_PADDING`] slack ([`orbit_overview_framing`]) — which is looser
//! than the main camera's full-containment fit, plus the minimap-specific
//! "which members to include" policy.

use crate::framing::{Aabb, FIT_PADDING, orbit_overview_framing};

/// Minimap orbit-camera target (center) and distance for a set of members.
///
/// Each member is `(model_matrix, visible)` where `model_matrix` is the
/// column-major scale+translate matrix (mat[0]/[5]/[10] = scale,
/// mat[12]/[13]/[14] = translate) and `visible` is whether the owning dataset is
/// currently shown.
///
/// Frames the **visible** members so a single shown dataset isn't dwarfed by
/// hidden ones (e.g. a large multi-field plate left in the workspace). If
/// nothing is visible it falls back to framing all members rather than going
/// blank; with no members it returns the neutral default.
pub fn minimap_framing_boxes(members: &[([f32; 16], bool)]) -> ([f64; 3], f64) {
    // Prefer framing only the visible members; fall back to all members when
    // nothing is visible so the minimap still frames content instead of going
    // blank/neutral.
    for visible_only in [true, false] {
        let mut bounds = Aabb::empty();

        for (mat, visible) in members {
            if visible_only && !visible {
                continue;
            }
            accumulate_box(mat, &mut bounds);
        }

        if !bounds.is_empty() {
            // The minimap's overview framing: limiting axis + FIT_PADDING slack.
            // (Distinct from the main camera's full-containment fit; see #836.)
            return orbit_overview_framing(bounds.min, bounds.max, FIT_PADDING);
        }
    }

    ([0.5, 0.5, 0.5], FIT_PADDING)
}

/// Expand `bounds` by the world-space box of one scale+translate matrix
/// (column-major: `mat[0]/[5]/[10]` = scale, `mat[12]/[13]/[14]` = translate).
fn accumulate_box(mat: &[f32; 16], bounds: &mut Aabb) {
    let sx = mat[0] as f64;
    let sy = mat[5] as f64;
    let sz = mat[10] as f64;
    let tx = mat[12] as f64;
    let ty = mat[13] as f64;
    let tz = mat[14] as f64;
    bounds.add_box([tx, ty, tz], [tx + sx, ty + sy, tz + sz]);
}

#[cfg(test)]
mod tests {
    use super::minimap_framing_boxes;

    /// A scale+translate model matrix (column-major): unit box scaled by `scale`,
    /// translated by `(tx, ty, tz)`.
    fn box_mat(scale: f32, tx: f32, ty: f32, tz: f32) -> [f32; 16] {
        let mut m = [0.0f32; 16];
        m[0] = scale;
        m[5] = scale;
        m[10] = scale;
        m[15] = 1.0;
        m[12] = tx;
        m[13] = ty;
        m[14] = tz;
        m
    }

    #[test]
    fn frames_only_visible_members() {
        // A huge hidden plate far from the origin + a small visible volume at the
        // origin. The minimap must frame the visible volume, not be pulled out to
        // fit the hidden plate (the bug that made an isolated dataset a speck).
        let plate = box_mat(100.0, 1000.0, 1000.0, 0.0);
        let volume = box_mat(2.0, 0.0, 0.0, 0.0);
        let (center, distance) = minimap_framing_boxes(&[(plate, false), (volume, true)]);
        assert!(
            center[0] < 10.0 && center[1] < 10.0,
            "center pulled toward hidden plate: {center:?}"
        );
        assert!(
            distance < 20.0,
            "distance inflated by hidden plate: {distance}"
        );
    }

    #[test]
    fn falls_back_to_all_when_none_visible() {
        // Nothing visible → still frame the content rather than collapsing to the
        // empty default, so the minimap isn't gratuitously blank.
        let volume = box_mat(4.0, 10.0, 0.0, 0.0);
        let (center, distance) = minimap_framing_boxes(&[(volume, false)]);
        assert!(
            (center[0] - 12.0).abs() < 1e-6,
            "expected center on the only box: {center:?}"
        );
        assert!(distance > 0.0);
    }

    #[test]
    fn empty_returns_default() {
        let (center, distance) = minimap_framing_boxes(&[]);
        assert_eq!(center, [0.5, 0.5, 0.5]);
        assert_eq!(distance, 1.8);
    }
}
