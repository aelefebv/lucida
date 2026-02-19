//! Step 05 renderer scaffold crate.
//! This crate holds stable render configuration types that mirror Step 05 behavior
//! while the production render path is migrated from Python planning to Rust runtime.

/// Stable render modes used by Step 05 3D behavior semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolumeRenderMode {
    Mip,
    Alpha,
    Iso,
}

/// Stable per-layer 3D render controls used in Step 05.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VolumeRenderSettings {
    pub render_mode: VolumeRenderMode,
    pub iso_threshold: f32,
    pub density_scale: f32,
    pub sample_step: f32,
}

impl Default for VolumeRenderSettings {
    fn default() -> Self {
        Self {
            render_mode: VolumeRenderMode::Mip,
            iso_threshold: 0.5,
            density_scale: 1.0,
            sample_step: 1.0,
        }
    }
}

impl VolumeRenderSettings {
    /// Validate Step 05 settings contract.
    pub fn validate(self) -> Result<Self, &'static str> {
        if !(0.0..=1.0).contains(&self.iso_threshold) {
            return Err("iso_threshold must be between 0 and 1");
        }
        if self.density_scale <= 0.0 {
            return Err("density_scale must be greater than 0");
        }
        if self.sample_step <= 0.0 {
            return Err("sample_step must be greater than 0");
        }
        Ok(self)
    }
}

/// Compile-time smoke path proving this crate links against wgpu.
pub fn smoke_backend_mask() -> wgpu::Backends {
    wgpu::Backends::PRIMARY
}

#[cfg(test)]
mod tests {
    use super::{smoke_backend_mask, VolumeRenderMode, VolumeRenderSettings};

    #[test]
    fn defaults_match_step5_contract() {
        let defaults = VolumeRenderSettings::default();
        assert!(matches!(defaults.render_mode, VolumeRenderMode::Mip));
        assert_eq!(defaults.iso_threshold, 0.5);
        assert_eq!(defaults.density_scale, 1.0);
        assert_eq!(defaults.sample_step, 1.0);
    }

    #[test]
    fn validate_rejects_invalid_values() {
        let invalid = VolumeRenderSettings {
            render_mode: VolumeRenderMode::Iso,
            iso_threshold: 1.5,
            density_scale: 1.0,
            sample_step: 1.0,
        };
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn wgpu_link_smoke() {
        let backends = smoke_backend_mask();
        assert!(!backends.is_empty());
    }
}
