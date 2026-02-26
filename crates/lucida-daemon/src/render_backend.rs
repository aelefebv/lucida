use std::env;

use serde_json::json;

use crate::dto::api::ApiWarning;
use crate::dto::view_state::PerformanceHints;

pub const ENV_RENDER_BACKEND: &str = "LUCIDA_RENDER_BACKEND";

const GPU_RENDERER_IMPLEMENTED: bool = false;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderBackend {
    Cpu,
    Gpu,
}

impl RenderBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Gpu => "gpu",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RenderBackendOverride {
    Auto,
    Cpu,
    Gpu,
}

#[derive(Debug, Clone)]
pub struct RenderBackendSelection {
    pub backend: RenderBackend,
    pub warnings: Vec<ApiWarning>,
}

pub fn select_render_backend(
    performance: Option<&PerformanceHints>,
    gpu_hardware_available: bool,
) -> RenderBackendSelection {
    let override_value = env::var(ENV_RENDER_BACKEND).ok();
    select_render_backend_with_override(
        override_value.as_deref(),
        performance,
        gpu_hardware_available,
    )
}

fn select_render_backend_with_override(
    override_value: Option<&str>,
    performance: Option<&PerformanceHints>,
    gpu_hardware_available: bool,
) -> RenderBackendSelection {
    let (backend_override, mut warnings) = parse_backend_override(override_value);
    let explicit_prefer_gpu = performance.is_some_and(|hints| hints.prefer_gpu);
    let prefer_gpu = performance.map(|hints| hints.prefer_gpu).unwrap_or(true);

    let (backend, fallback_warning) = match backend_override {
        RenderBackendOverride::Cpu => (RenderBackend::Cpu, None),
        RenderBackendOverride::Gpu => {
            choose_gpu_or_cpu_fallback(gpu_hardware_available, Some("env_override"))
        }
        RenderBackendOverride::Auto => {
            if prefer_gpu {
                let reason = if explicit_prefer_gpu {
                    Some("view_state")
                } else {
                    None
                };
                choose_gpu_or_cpu_fallback(gpu_hardware_available, reason)
            } else {
                (RenderBackend::Cpu, None)
            }
        }
    };

    if let Some(warning) = fallback_warning {
        warnings.push(warning);
    }

    RenderBackendSelection { backend, warnings }
}

fn choose_gpu_or_cpu_fallback(
    gpu_hardware_available: bool,
    fallback_reason: Option<&str>,
) -> (RenderBackend, Option<ApiWarning>) {
    if gpu_hardware_available && GPU_RENDERER_IMPLEMENTED {
        return (RenderBackend::Gpu, None);
    }

    let warning = fallback_reason.map(|reason| {
        if !gpu_hardware_available {
            ApiWarning {
                code: "gpu_unavailable_fallback_cpu".to_owned(),
                message: "GPU rendering was requested but no GPU adapter is available; CPU renderer was used.".to_owned(),
                details: Some(json!({
                    "requested_by": reason,
                    "gpu_hardware_available": false,
                })),
            }
        } else {
            ApiWarning {
                code: "gpu_renderer_unavailable_fallback_cpu".to_owned(),
                message: "GPU rendering was requested but GPU rendering is not implemented for this slice; CPU renderer was used.".to_owned(),
                details: Some(json!({
                    "requested_by": reason,
                    "gpu_hardware_available": true,
                    "gpu_renderer_implemented": GPU_RENDERER_IMPLEMENTED,
                })),
            }
        }
    });
    (RenderBackend::Cpu, warning)
}

fn parse_backend_override(value: Option<&str>) -> (RenderBackendOverride, Vec<ApiWarning>) {
    let Some(raw_value) = value else {
        return (RenderBackendOverride::Auto, Vec::new());
    };

    match raw_value.trim().to_ascii_lowercase().as_str() {
        "auto" => (RenderBackendOverride::Auto, Vec::new()),
        "cpu" => (RenderBackendOverride::Cpu, Vec::new()),
        "gpu" => (RenderBackendOverride::Gpu, Vec::new()),
        invalid => (
            RenderBackendOverride::Auto,
            vec![ApiWarning {
                code: "invalid_render_backend_override".to_owned(),
                message: "Invalid render backend override was ignored; using automatic backend selection.".to_owned(),
                details: Some(json!({
                    "env_var": ENV_RENDER_BACKEND,
                    "value": invalid,
                    "allowed_values": ["auto", "cpu", "gpu"],
                })),
            }],
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{select_render_backend_with_override, RenderBackend};
    use crate::dto::view_state::{LodMode, PerformanceHints, RenderQuality};

    fn performance(prefer_gpu: bool) -> PerformanceHints {
        PerformanceHints {
            quality: RenderQuality::Draft,
            target_frame_ms: 200,
            progressive: true,
            lod_mode: LodMode::Auto,
            fixed_level: None,
            max_cpu_cache_bytes: None,
            max_gpu_cache_bytes: None,
            prefer_gpu,
        }
    }

    #[test]
    fn auto_without_explicit_preference_is_silent() {
        let selection = select_render_backend_with_override(None, None, false);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection.warnings.is_empty());
    }

    #[test]
    fn explicit_view_state_gpu_preference_falls_back_with_warning() {
        let hints = performance(true);
        let selection = select_render_backend_with_override(None, Some(&hints), false);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection
            .warnings
            .iter()
            .any(|warning| warning.code == "gpu_unavailable_fallback_cpu"));
    }

    #[test]
    fn env_override_cpu_forces_cpu_without_warning() {
        let hints = performance(true);
        let selection = select_render_backend_with_override(Some("cpu"), Some(&hints), true);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection.warnings.is_empty());
    }

    #[test]
    fn env_override_gpu_falls_back_when_renderer_missing() {
        let selection = select_render_backend_with_override(Some("gpu"), None, true);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection
            .warnings
            .iter()
            .any(|warning| warning.code == "gpu_renderer_unavailable_fallback_cpu"));
    }

    #[test]
    fn invalid_env_override_emits_warning_and_uses_auto() {
        let selection = select_render_backend_with_override(Some("invalid"), None, false);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection
            .warnings
            .iter()
            .any(|warning| warning.code == "invalid_render_backend_override"));
    }
}
