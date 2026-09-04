//! The target level: the pyramid level the screen calls for.
//!
//! One rule, owned by the core so the browser, the CLI, and the Python client
//! cannot disagree. Let the screen show `z` device pixels per level-0 sample
//! and let level `L` be `r` times coarser than level 0. The target is the
//! coarsest level that still places at least one sample under every device
//! pixel, that is the largest `L` with `z × r ≤ 1`. When even level 0 spreads
//! its samples more than a pixel apart the target is 0. When even the coarsest
//! level packs more than one sample into a pixel the target is the coarsest
//! level. The rule reads the camera and the level geometry and nothing else.
//! Memory pressure changes coverage, never resolution. ADR 0061 records the
//! decision and the alternative it rejected.
//!
//! [`target_level`] is the rule. [`level_shape_ratios`] turns a pyramid's
//! level geometries into the per-level ratio the rule consumes, along the axes
//! the view resolves.

use lucida_content::LevelGeometry;

/// Fraction of an octave the measure must move past a level boundary before
/// the target follows it. A slow zoom that hovers at a boundary would otherwise
/// flap between two levels every frame. A quarter octave, a factor of about
/// 1.19, absorbs wheel-step jitter and still lets the level track the zoom
/// closely.
pub const HYSTERESIS_OCTAVES: f64 = 0.25;

/// Axis indices into a 5D `[t, c, z, y, x]` shape.
pub const AXIS_Z: usize = 2;
pub const AXIS_Y: usize = 3;
pub const AXIS_X: usize = 4;

/// The axes a slice view resolves: a slice shows one plane, so a level that
/// only downsamples `z` is no coarser on screen than level 0.
pub const IN_PLANE_AXES: [usize; 2] = [AXIS_Y, AXIS_X];

/// The axes a volume view resolves.
pub const VOLUME_AXES: [usize; 3] = [AXIS_Z, AXIS_Y, AXIS_X];

/// The level the screen calls for.
///
/// `pixels_per_sample` is the number of device pixels one level-0 sample
/// spans on screen. `shape_ratios[L]` is how many times coarser level `L` is
/// than level 0 along the axes the view resolves (see
/// [`level_shape_ratios`]); `shape_ratios[0]` is 1. The result is the largest
/// `L` with `pixels_per_sample × shape_ratios[L] ≤ 1`, or level 0 when no
/// level satisfies it. That is the coarsest level that still places at least
/// one sample under every device pixel.
///
/// `previous` is the target this same rule last reported for the entity, if
/// any. With a previous target the rule applies hysteresis. The target moves
/// only once the measure has crossed the boundary between the two levels by
/// [`HYSTERESIS_OCTAVES`], so a measure that hovers at a boundary keeps the
/// level it had. A caller without history passes `None` and gets the raw rule.
///
/// The rule takes no input about memory, residency, or budgets.
pub fn target_level(pixels_per_sample: f64, shape_ratios: &[f64], previous: Option<u32>) -> u32 {
    let raw = |pixels_per_sample: f64| -> u32 {
        shape_ratios
            .iter()
            .rposition(|ratio| pixels_per_sample * ratio <= 1.0)
            .map_or(0, |level| level as u32)
    };

    let wanted = raw(pixels_per_sample);
    let Some(previous) = previous else {
        return wanted;
    };
    if wanted == previous {
        return previous;
    }

    // Judge the move against a measure nudged back toward the previous level
    // by the hysteresis band. If the nudged measure still asks to leave the
    // previous level, the boundary has been crossed by more than the band.
    let band = 2f64.powf(HYSTERESIS_OCTAVES);
    let crossed = if wanted > previous {
        raw(pixels_per_sample * band) > previous
    } else {
        raw(pixels_per_sample / band) < previous
    };
    if crossed { wanted } else { previous }
}

/// How many times coarser each level is than level 0 along `axes`, as the
/// per-level ratio [`target_level`] consumes.
///
/// Uses the real shapes, so a pyramid whose levels are not each half the
/// previous one is described as it is. Each level's ratio is the largest
/// ratio across the resolved axes. The most-downsampled axis is the first to
/// spread its samples more than a pixel apart, so it decides when the level
/// stops filling every pixel. A level that is no coarser than the level before
/// it along the resolved axes offers the view nothing, so it gets an infinite
/// ratio and is never the target. In a slice view that is a level that only
/// downsamples `z`.
pub fn level_shape_ratios(levels: &[LevelGeometry], axes: &[usize]) -> Vec<f64> {
    let resolved: Vec<Vec<u64>> = levels
        .iter()
        .map(|level| axes.iter().map(|&axis| level.shape[axis]).collect())
        .collect();
    let Some(level0) = resolved.first() else {
        return Vec::new();
    };
    resolved
        .iter()
        .enumerate()
        .map(|(index, level)| {
            let coarser_than_finer_neighbor = index == 0
                || level
                    .iter()
                    .zip(&resolved[index - 1])
                    .any(|(here, finer)| here < finer);
            if !coarser_than_finer_neighbor {
                return f64::INFINITY;
            }
            level
                .iter()
                .zip(level0)
                .map(|(&here, &full)| full as f64 / (here as f64).max(1.0))
                .fold(0.0, f64::max)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(index: u32, shape_zyx: [u64; 3]) -> LevelGeometry {
        let shape = [1, 1, shape_zyx[0], shape_zyx[1], shape_zyx[2]];
        LevelGeometry {
            level_index: index,
            shape,
            chunk_shape: [1, 1, 1, 64, 64],
            grid_shape: shape,
            scale: [1.0; 5],
        }
    }

    /// A regular pyramid: each level halves every axis.
    fn regular(depth: u32, base: u64) -> Vec<LevelGeometry> {
        (0..depth)
            .map(|i| level(i, [base >> i, base >> i, base >> i]))
            .collect()
    }

    /// The raw rule on a regular pyramid, as a caller with no history sees it.
    fn raw(pixels_per_sample: f64, levels: u32) -> u32 {
        let ratios = level_shape_ratios(&regular(levels, 1024), &VOLUME_AXES);
        target_level(pixels_per_sample, &ratios, None)
    }

    // ---- the rule ----

    #[test]
    fn zoomed_in_reaches_level_0() {
        assert_eq!(raw(1.0, 5), 0);
        assert_eq!(raw(1.01, 5), 0);
        assert_eq!(raw(4.0, 5), 0);
        assert_eq!(raw(f64::INFINITY, 5), 0);
        // Nothing qualifies for a measure that is not a number either.
        assert_eq!(raw(f64::NAN, 5), 0);
    }

    #[test]
    fn zooming_out_walks_toward_the_coarsest_level() {
        assert_eq!(raw(0.51, 5), 0);
        assert_eq!(raw(0.5, 5), 1);
        assert_eq!(raw(0.26, 5), 1);
        assert_eq!(raw(0.25, 5), 2);
        assert_eq!(raw(0.13, 5), 2);
        assert_eq!(raw(0.125, 5), 3);
    }

    #[test]
    fn zoomed_out_past_the_coarsest_level_clamps_to_it() {
        assert_eq!(raw(0.001, 3), 2);
        assert_eq!(raw(0.0, 3), 2);
    }

    #[test]
    fn a_single_level_image_is_always_level_0() {
        assert_eq!(raw(0.001, 1), 0);
        assert_eq!(raw(8.0, 1), 0);
        assert_eq!(target_level(0.5, &[], None), 0);
    }

    #[test]
    fn irregular_pyramid_uses_the_real_shape_ratios() {
        // Level 1 is four times coarser than level 0. A rule that assumed a
        // factor of two per level would pick level 2 at 0.25 pixels per sample.
        let levels = vec![
            level(0, [1, 4096, 4096]),
            level(1, [1, 1024, 1024]),
            level(2, [1, 512, 512]),
            level(3, [1, 128, 128]),
        ];
        let ratios = level_shape_ratios(&levels, &IN_PLANE_AXES);
        assert_eq!(ratios, vec![1.0, 4.0, 8.0, 32.0]);
        assert_eq!(target_level(0.26, &ratios, None), 0);
        assert_eq!(target_level(0.25, &ratios, None), 1);
        assert_eq!(target_level(0.125, &ratios, None), 2);
        assert_eq!(target_level(0.03, &ratios, None), 3);
    }

    #[test]
    fn anisotropic_pyramid_in_slice_mode_chooses_by_the_in_plane_axes() {
        let levels = vec![
            level(0, [64, 2048, 2048]),
            level(1, [16, 1024, 1024]),
            level(2, [4, 512, 512]),
        ];
        let in_plane = level_shape_ratios(&levels, &IN_PLANE_AXES);
        assert_eq!(in_plane, vec![1.0, 2.0, 4.0]);
        assert_eq!(target_level(0.5, &in_plane, None), 1);

        let volume = level_shape_ratios(&levels, &VOLUME_AXES);
        assert_eq!(volume, vec![1.0, 4.0, 16.0]);
        assert_eq!(target_level(0.5, &volume, None), 0);
        assert_eq!(target_level(0.25, &volume, None), 1);
    }

    #[test]
    fn a_level_that_only_downsamples_z_is_never_the_target_of_a_slice_view() {
        let levels = vec![
            level(0, [64, 2048, 2048]),
            level(1, [32, 2048, 2048]),
            level(2, [32, 1024, 1024]),
        ];
        let in_plane = level_shape_ratios(&levels, &IN_PLANE_AXES);
        assert_eq!(in_plane, vec![1.0, f64::INFINITY, 2.0]);
        assert_eq!(target_level(0.9, &in_plane, None), 0);
        assert_eq!(target_level(0.5, &in_plane, None), 2);

        let volume = level_shape_ratios(&levels, &VOLUME_AXES);
        assert_eq!(volume, vec![1.0, 2.0, 2.0]);
    }

    #[test]
    fn in_plane_axes_that_differ_are_judged_by_the_more_downsampled_one() {
        let levels = vec![
            level(0, [1, 1024, 1024]),
            level(1, [1, 1024, 512]),
            level(2, [1, 512, 256]),
        ];
        let ratios = level_shape_ratios(&levels, &IN_PLANE_AXES);
        assert_eq!(ratios, vec![1.0, 2.0, 4.0]);
        assert_eq!(target_level(0.6, &ratios, None), 0);
        assert_eq!(target_level(0.5, &ratios, None), 1);
    }

    #[test]
    fn an_axis_that_stops_shrinking_does_not_hold_the_coarser_levels_back() {
        // z bottoms out at 2 while y and x keep halving. A level counts as
        // coarser when any resolved axis shrinks, so levels 3 and 4 stay
        // reachable.
        let levels = vec![
            level(0, [8, 1024, 1024]),
            level(1, [4, 512, 512]),
            level(2, [2, 256, 256]),
            level(3, [2, 128, 128]),
            level(4, [2, 64, 64]),
        ];
        let ratios = level_shape_ratios(&levels, &VOLUME_AXES);
        assert_eq!(ratios, vec![1.0, 2.0, 4.0, 8.0, 16.0]);
        assert_eq!(target_level(0.2, &ratios, None), 2);
        assert_eq!(target_level(0.05, &ratios, None), 4);
    }

    #[test]
    fn a_flat_image_viewed_as_a_volume_ignores_its_singleton_axis() {
        let levels = vec![
            level(0, [1, 1024, 1024]),
            level(1, [1, 512, 512]),
            level(2, [1, 256, 256]),
        ];
        let ratios = level_shape_ratios(&levels, &VOLUME_AXES);
        assert_eq!(ratios, vec![1.0, 2.0, 4.0]);
        assert_eq!(target_level(0.5, &ratios, None), 1);
    }

    // ---- hysteresis ----

    #[test]
    fn hysteresis_holds_the_previous_level_on_either_side_of_a_boundary() {
        let ratios = level_shape_ratios(&regular(4, 1024), &VOLUME_AXES);
        let band = 2f64.powf(HYSTERESIS_OCTAVES);
        // Level 1 becomes the raw target at half a pixel per sample.
        let boundary = 0.5;
        assert_eq!(target_level(boundary / band * 1.02, &ratios, Some(0)), 0);
        assert_eq!(target_level(boundary * band * 0.98, &ratios, Some(1)), 1);
        assert_eq!(target_level(boundary / band * 0.98, &ratios, Some(0)), 1);
        assert_eq!(target_level(boundary * band * 1.02, &ratios, Some(1)), 0);
        assert_eq!(target_level(boundary, &ratios, Some(0)), 0);
        assert_eq!(target_level(boundary, &ratios, Some(1)), 1);
    }

    #[test]
    fn hysteresis_does_not_stop_a_move_across_several_levels() {
        let ratios = level_shape_ratios(&regular(5, 1024), &VOLUME_AXES);
        assert_eq!(target_level(0.1, &ratios, Some(0)), 3);
        assert_eq!(target_level(3.0, &ratios, Some(4)), 0);
    }

    #[test]
    fn hysteresis_without_history_is_the_raw_rule() {
        let ratios = level_shape_ratios(&regular(4, 1024), &VOLUME_AXES);
        assert_eq!(target_level(0.49, &ratios, None), 1);
        assert_eq!(target_level(0.51, &ratios, None), 0);
    }

    #[test]
    fn a_previous_level_beyond_the_pyramid_does_not_pin_the_target() {
        let ratios = level_shape_ratios(&regular(3, 1024), &VOLUME_AXES);
        assert_eq!(target_level(0.01, &ratios, Some(9)), 2);
        assert_eq!(target_level(4.0, &ratios, Some(9)), 0);
    }
}
