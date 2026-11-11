//! Minimap framing geometry: pure math for the minimap's camera, kept out of
//! the `wasm32`-only module so it can be unit tested natively.
//!
//! Bounds accumulation lives in [`crate::framing`]. This module picks the
//! projection, the policy for which members to include, and the framing for
//! each projection: the orbit's overview framing ([`orbit_overview_framing`]
//! with [`FIT_PADDING`]), looser than the main camera's containment fit, and
//! the top-down camera's 2D fit.

use crate::framing::{Aabb, FIT_MARGIN_2D, FIT_PADDING, orbit_overview_framing, slice_framing};
use crate::mat4::{look_at, mul4, orthographic};

/// One member as the minimap frames it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MinimapMember {
    /// Column-major world matrix of the member's unit cube.
    pub model: [f32; 16],
    /// Whether the owning dataset is shown.
    pub visible: bool,
    /// Z planes at level 0.
    pub z_planes: u64,
}

/// The minimap's camera for a set of members.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MinimapFraming {
    /// An orbit camera around `target` at `distance`, at the caller's angles.
    Orbit { target: [f64; 3], distance: f64 },
    /// Every framed member has one Z plane. An orbit's tilt would make the
    /// data read as 3D, so the camera looks straight down Z at `bounds`
    /// instead ([`top_down_view`]).
    TopDown { bounds: Aabb },
}

/// The minimap's camera for `members`.
///
/// Frames the **visible** members so a single shown dataset isn't dwarfed by
/// hidden ones (e.g. a large multi-tile collection left in the workspace). If
/// nothing is visible it falls back to framing all members rather than going
/// blank; with no members it returns the neutral default orbit.
///
/// The projection follows the members framed, never the main view's mode: the
/// same data keeps the same minimap in 2D and 3D, and a volume keeps its orbit
/// in the slice view, where the tilt shows the current plane's place in the
/// stack.
pub fn minimap_framing(members: &[MinimapMember]) -> MinimapFraming {
    for visible_only in [true, false] {
        let mut bounds = Aabb::empty();
        let mut flat = true;

        for member in members {
            if visible_only && !member.visible {
                continue;
            }
            accumulate_box(&member.model, &mut bounds);
            flat &= member.z_planes == 1;
        }

        if bounds.is_empty() {
            continue;
        }
        if flat {
            return MinimapFraming::TopDown { bounds };
        }
        let (target, distance) = orbit_overview_framing(bounds.min, bounds.max, FIT_PADDING);
        return MinimapFraming::Orbit { target, distance };
    }

    MinimapFraming::Orbit {
        target: [0.5, 0.5, 0.5],
        distance: FIT_PADDING,
    }
}

/// `(view_proj, eye)` for the top-down camera over `bounds` at `viewport`.
///
/// Orthographic, looking down −Z with +Y up, the slice view's orientation:
/// world +Y is the image's first row. The XY extent gets the main 2D fit
/// ([`slice_framing`] with [`FIT_MARGIN_2D`]). The eye stands back by the
/// visible half-extent so the whole slab lies between the clip planes; the
/// volume renderer starts each ray at the near plane.
pub fn top_down_view(bounds: Aabb, viewport: [u32; 2]) -> ([f64; 16], [f64; 3]) {
    let b = Aabb::sanitized(bounds.min, bounds.max);
    let viewport = [viewport[0].max(1), viewport[1].max(1)];
    let (center, zoom) = slice_framing(
        [b.min[0], b.min[1]],
        [b.max[0], b.max[1]],
        viewport,
        FIT_MARGIN_2D,
    );
    let half_w = viewport[0] as f64 / (2.0 * zoom);
    let half_h = viewport[1] as f64 / (2.0 * zoom);

    let standoff = half_w.max(half_h);
    let thickness = b.max[2] - b.min[2];
    let eye = [center[0], center[1], b.max[2] + standoff];
    let near = standoff * 0.5;
    let far = standoff + thickness + standoff * 0.5;

    let view = look_at(eye, [center[0], center[1], b.min[2]], [0.0, 1.0, 0.0]);
    (mul4(orthographic(half_w, half_h, near, far), view), eye)
}

/// Expand `bounds` by where a column-major model matrix takes the unit
/// cube: all eight corners, since the model can turn the cube.
fn accumulate_box(mat: &[f32; 16], bounds: &mut Aabb) {
    let m = mat.map(f64::from);
    for corner in 0..8 {
        let p: [f64; 3] = std::array::from_fn(|i| f64::from(corner >> i & 1));
        bounds.add_point(std::array::from_fn(|r| {
            m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::{MinimapFraming, MinimapMember, minimap_framing, top_down_view};
    use crate::framing::Aabb;

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

    fn member(model: [f32; 16], visible: bool, z_planes: u64) -> MinimapMember {
        MinimapMember {
            model,
            visible,
            z_planes,
        }
    }

    fn orbit(framing: MinimapFraming) -> ([f64; 3], f64) {
        match framing {
            MinimapFraming::Orbit { target, distance } => (target, distance),
            other => panic!("expected an orbit, got {other:?}"),
        }
    }

    fn top_down_bounds(framing: MinimapFraming) -> Aabb {
        match framing {
            MinimapFraming::TopDown { bounds } => bounds,
            other => panic!("expected top-down, got {other:?}"),
        }
    }

    /// Clip-space `[x, y, z, w]` of a world point.
    fn clip(vp: &[f64; 16], p: [f64; 3]) -> [f64; 4] {
        let mut out = [0.0; 4];
        for (row, o) in out.iter_mut().enumerate() {
            *o = vp[row] * p[0] + vp[4 + row] * p[1] + vp[8 + row] * p[2] + vp[12 + row];
        }
        out
    }

    #[test]
    fn frames_only_visible_members() {
        // A huge hidden collection far from the origin + a small visible volume at the
        // origin. The minimap must frame the visible volume, not be pulled out to
        // fit the hidden collection, which would make the visible dataset a speck.
        let collection = box_mat(100.0, 1000.0, 1000.0, 0.0);
        let volume = box_mat(2.0, 0.0, 0.0, 0.0);
        let (center, distance) = orbit(minimap_framing(&[
            member(collection, false, 1),
            member(volume, true, 64),
        ]));
        assert!(
            center[0] < 10.0 && center[1] < 10.0,
            "center pulled toward hidden collection: {center:?}"
        );
        assert!(
            distance < 20.0,
            "distance inflated by hidden collection: {distance}"
        );
    }

    #[test]
    fn falls_back_to_all_when_none_visible() {
        // Nothing visible → still frame the content rather than collapsing to the
        // empty default, so the minimap isn't gratuitously blank.
        let volume = box_mat(4.0, 10.0, 0.0, 0.0);
        let (center, distance) = orbit(minimap_framing(&[member(volume, false, 8)]));
        assert!(
            (center[0] - 12.0).abs() < 1e-6,
            "expected center on the only box: {center:?}"
        );
        assert!(distance > 0.0);
    }

    #[test]
    fn empty_returns_default_orbit() {
        let (center, distance) = orbit(minimap_framing(&[]));
        assert_eq!(center, [0.5, 0.5, 0.5]);
        assert_eq!(distance, 1.8);
    }

    #[test]
    fn single_plane_members_look_top_down() {
        let tiles = [
            member(box_mat(1.0, 0.0, 0.0, 0.0), true, 1),
            member(box_mat(1.0, 2.0, 0.0, 0.0), true, 1),
        ];
        let bounds = top_down_bounds(minimap_framing(&tiles));
        assert_eq!(bounds.min[0], 0.0);
        assert_eq!(bounds.max[0], 3.0);
    }

    #[test]
    fn a_visible_volume_keeps_the_orbit() {
        let members = [
            member(box_mat(1.0, 0.0, 0.0, 0.0), true, 1),
            member(box_mat(1.0, 2.0, 0.0, 0.0), true, 2),
        ];
        orbit(minimap_framing(&members));
    }

    #[test]
    fn a_hidden_volume_does_not_tilt_visible_flat_data() {
        let members = [
            member(box_mat(1.0, 0.0, 0.0, 0.0), true, 1),
            member(box_mat(1.0, 2.0, 0.0, 0.0), false, 128),
        ];
        let bounds = top_down_bounds(minimap_framing(&members));
        assert_eq!(bounds.max[0], 1.0, "the hidden volume joined the framing");
    }

    #[test]
    fn with_nothing_visible_the_projection_follows_all_members() {
        let flat = [member(box_mat(1.0, 0.0, 0.0, 0.0), false, 1)];
        top_down_bounds(minimap_framing(&flat));

        let mixed = [
            member(box_mat(1.0, 0.0, 0.0, 0.0), false, 1),
            member(box_mat(1.0, 2.0, 0.0, 0.0), false, 16),
        ];
        orbit(minimap_framing(&mixed));
    }

    #[test]
    fn a_member_without_levels_keeps_the_orbit() {
        orbit(minimap_framing(&[member(
            box_mat(1.0, 0.0, 0.0, 0.0),
            true,
            0,
        )]));
    }

    #[test]
    fn top_down_view_matches_the_slice_view_orientation() {
        // A wide, one-plane-thin slab: 4 × 1 in XY.
        let bounds = Aabb::from_bounds([0.0, 0.0, 0.0], [4.0, 1.0, 0.01]);
        let (vp, eye) = top_down_view(bounds, [200, 200]);

        let center = clip(&vp, [2.0, 0.5, 0.0]);
        let right = clip(&vp, [4.0, 0.5, 0.0]);
        let top = clip(&vp, [2.0, 1.0, 0.0]);

        // Orthographic: w stays 1 everywhere.
        for c in [center, right, top] {
            assert!((c[3] - 1.0).abs() < 1e-12, "perspective divide: {c:?}");
        }
        // Centered, +X to the right, +Y (the image's first row) at the top.
        assert!(center[0].abs() < 1e-9 && center[1].abs() < 1e-9);
        assert!(right[0] > 0.0 && right[1].abs() < 1e-9);
        assert!(top[1] > 0.0 && top[0].abs() < 1e-9);
        // The limiting axis gets the main 2D fit margin.
        assert!(
            (right[0] - 1.0 / 1.15).abs() < 1e-9,
            "x extent: {}",
            right[0]
        );
        // Looking straight down Z from above the slab.
        assert_eq!([eye[0], eye[1]], [2.0, 0.5]);
        assert!(eye[2] > 0.01);
    }

    #[test]
    fn top_down_view_keeps_the_slab_between_the_clip_planes() {
        let bounds = Aabb::from_bounds([0.0, 0.0, 0.2], [1.0, 1.0, 0.3]);
        let (vp, _) = top_down_view(bounds, [300, 200]);
        for z in [0.2, 0.3] {
            let depth = clip(&vp, [0.5, 0.5, z])[2];
            assert!(depth > -1.0 && depth < 1.0, "z {z} clipped: {depth}");
        }
        // The top face is nearer the camera than the bottom face.
        assert!(clip(&vp, [0.5, 0.5, 0.3])[2] < clip(&vp, [0.5, 0.5, 0.2])[2]);
    }

    #[test]
    fn top_down_view_is_finite_for_a_degenerate_box() {
        let point = Aabb::from_bounds([1.0, 1.0, 0.0], [1.0, 1.0, 0.0]);
        let (vp, eye) = top_down_view(point, [0, 0]);
        assert!(vp.iter().chain(eye.iter()).all(|v| v.is_finite()));
    }
}
