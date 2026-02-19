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

/// Stable points layer style controls used in Step 06.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointsLayerStyle {
    pub lod_cell_px: u32,
    pub lod_max_points: u32,
    pub point_size: f32,
}

impl Default for PointsLayerStyle {
    fn default() -> Self {
        Self {
            lod_cell_px: 2,
            lod_max_points: 250_000,
            point_size: 1.0,
        }
    }
}

impl PointsLayerStyle {
    /// Validate Step 06 points style contract.
    pub fn validate(self) -> Result<Self, &'static str> {
        if self.lod_cell_px == 0 {
            return Err("lod_cell_px must be greater than 0");
        }
        if self.lod_max_points == 0 {
            return Err("lod_max_points must be greater than 0");
        }
        if self.point_size <= 0.0 {
            return Err("point_size must be greater than 0");
        }
        Ok(self)
    }
}

/// Minimal Step 06 points layer descriptor carried in renderer scaffolding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PointsLayerDescriptor {
    pub point_count: u64,
    pub edge_count: u64,
}

impl PointsLayerDescriptor {
    pub fn has_edges(self) -> bool {
        self.edge_count > 0
    }
}

/// Selection payload mode used by Step 06 (`inline` or `DataRef`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointsSelectionEncoding {
    Inline,
    DataRef,
}

/// Deterministic selection summary primitive for points renderer handoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PointsSelectionSummary {
    pub resolved_count: u64,
    pub inline_cap: u32,
}

impl PointsSelectionSummary {
    pub fn encoding(self) -> PointsSelectionEncoding {
        if self.resolved_count > self.inline_cap as u64 {
            PointsSelectionEncoding::DataRef
        } else {
            PointsSelectionEncoding::Inline
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
    use super::{
        smoke_backend_mask, PointsLayerDescriptor, PointsLayerStyle, PointsSelectionEncoding,
        PointsSelectionSummary, VolumeRenderMode, VolumeRenderSettings,
    };

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

    #[test]
    fn step6_points_defaults_match_contract() {
        let defaults = PointsLayerStyle::default();
        assert_eq!(defaults.lod_cell_px, 2);
        assert_eq!(defaults.lod_max_points, 250_000);
        assert_eq!(defaults.point_size, 1.0);
        assert!(defaults.validate().is_ok());
    }

    #[test]
    fn step6_points_validate_rejects_invalid_values() {
        let invalid = PointsLayerStyle {
            lod_cell_px: 0,
            lod_max_points: 100,
            point_size: 1.0,
        };
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn points_descriptor_reports_edge_presence() {
        let no_edges = PointsLayerDescriptor {
            point_count: 10,
            edge_count: 0,
        };
        let with_edges = PointsLayerDescriptor {
            point_count: 10,
            edge_count: 2,
        };
        assert!(!no_edges.has_edges());
        assert!(with_edges.has_edges());
    }

    #[test]
    fn selection_encoding_switches_to_dataref_above_cap() {
        let inline = PointsSelectionSummary {
            resolved_count: 128,
            inline_cap: 4096,
        };
        let dataref = PointsSelectionSummary {
            resolved_count: 5000,
            inline_cap: 4096,
        };
        assert!(matches!(inline.encoding(), PointsSelectionEncoding::Inline));
        assert!(matches!(dataref.encoding(), PointsSelectionEncoding::DataRef));
    }
}
