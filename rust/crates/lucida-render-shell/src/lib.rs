//! Minimal Step 05 renderer shell helpers.

use lucida_render_wgpu::{smoke_backend_mask, VolumeRenderSettings};

/// Return a deterministic startup summary string for shell smoke tests.
pub fn startup_summary() -> String {
    let defaults = VolumeRenderSettings::default();
    let backends = smoke_backend_mask();
    format!(
        "mode={:?} iso={} density={} step={} backends={:?}",
        defaults.render_mode,
        defaults.iso_threshold,
        defaults.density_scale,
        defaults.sample_step,
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
