//! Minimal Step 05 renderer shell helpers.

use lucida_render_wgpu::{smoke_backend_mask, PointsLayerStyle, VolumeRenderSettings};

/// Return a deterministic startup summary string for shell smoke tests.
pub fn startup_summary() -> String {
    let defaults = VolumeRenderSettings::default();
    let points = PointsLayerStyle::default();
    let backends = smoke_backend_mask();
    format!(
        "mode={:?} iso={} density={} step={} points_cell={} points_max={} points_size={} backends={:?}",
        defaults.render_mode,
        defaults.iso_threshold,
        defaults.density_scale,
        defaults.sample_step,
        points.lod_cell_px,
        points.lod_max_points,
        points.point_size,
        backends
    )
}

#[cfg(test)]
mod tests {
    use super::startup_summary;

    #[test]
    fn startup_summary_is_non_empty() {
        assert!(!startup_summary().is_empty());
    }

    #[test]
    fn winit_type_smoke() {
        let size = winit::dpi::PhysicalSize::<u32>::new(800, 600);
        assert_eq!(size.width, 800);
        assert_eq!(size.height, 600);
    }
}
