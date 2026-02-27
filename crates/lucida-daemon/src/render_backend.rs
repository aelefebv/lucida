use std::env;

use serde_json::json;

use crate::dto::api::ApiWarning;
use crate::dto::view_state::PerformanceHints;

pub const ENV_RENDER_BACKEND: &str = "LUCIDA_RENDER_BACKEND";
const ADAPTIVE_MIN_CPU_SAMPLES: u64 = 3;
const ADAPTIVE_MIN_GPU_SAMPLES: u64 = 1;
const ADAPTIVE_GPU_SLOW_FACTOR: f64 = 1.05;

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

#[derive(Debug, Clone, Copy)]
pub struct BackendPerfSnapshot {
    pub cpu_samples: u64,
    pub cpu_mean_ms: f64,
    pub gpu_samples: u64,
    pub gpu_mean_ms: f64,
}

pub fn select_render_backend(
    performance: Option<&PerformanceHints>,
    gpu_hardware_available: bool,
    gpu_adapter_name: Option<&str>,
    perf_snapshot: Option<BackendPerfSnapshot>,
) -> RenderBackendSelection {
    let override_value = env::var(ENV_RENDER_BACKEND).ok();
    select_render_backend_with_override(
        override_value.as_deref(),
        performance,
        gpu_hardware_available,
        gpu_adapter_name,
        perf_snapshot,
    )
}

fn select_render_backend_with_override(
    override_value: Option<&str>,
    performance: Option<&PerformanceHints>,
    gpu_hardware_available: bool,
    gpu_adapter_name: Option<&str>,
    perf_snapshot: Option<BackendPerfSnapshot>,
) -> RenderBackendSelection {
    let (backend_override, mut warnings) = parse_backend_override(override_value);
    let explicit_prefer_gpu = performance.is_some_and(|hints| hints.prefer_gpu);
    let prefer_gpu = performance.map(|hints| hints.prefer_gpu).unwrap_or(true);
    let (mut backend, fallback_warning) = match backend_override {
        RenderBackendOverride::Cpu => (RenderBackend::Cpu, None),
        RenderBackendOverride::Gpu => {
            choose_gpu_or_cpu_fallback(gpu_hardware_available, Some("env_override"), None)
        }
        RenderBackendOverride::Auto => {
            if prefer_gpu {
                let reason = if explicit_prefer_gpu {
                    Some("view_state")
                } else {
                    None
                };
                if is_software_adapter(gpu_adapter_name) {
                    (
                        RenderBackend::Cpu,
                        Some(ApiWarning {
                            code: "gpu_software_adapter_fallback_cpu".to_owned(),
                            message:
                                "Automatic backend selection avoided a software GPU adapter and used CPU renderer."
                                    .to_owned(),
                            details: Some(json!({
                                "requested_by": reason.unwrap_or("auto_default"),
                                "gpu_hardware_available": gpu_hardware_available,
                                "gpu_adapter_name": gpu_adapter_name,
                            })),
                        }),
                    )
                } else {
                    choose_gpu_or_cpu_fallback(gpu_hardware_available, reason, gpu_adapter_name)
                }
            } else {
                (RenderBackend::Cpu, None)
            }
        }
    };

    if let Some(warning) = fallback_warning {
        warnings.push(warning);
    }

    if backend_override == RenderBackendOverride::Auto
        && prefer_gpu
        && !explicit_prefer_gpu
        && backend == RenderBackend::Gpu
    {
        if let Some(snapshot) = perf_snapshot {
            if snapshot.cpu_samples < ADAPTIVE_MIN_CPU_SAMPLES
                && snapshot.gpu_samples >= ADAPTIVE_MIN_GPU_SAMPLES
            {
                backend = RenderBackend::Cpu;
                warnings.push(ApiWarning {
                    code: "gpu_adaptive_cpu_probe".to_owned(),
                    message: "Automatic backend selection routed this render to CPU to collect latency baseline samples.".to_owned(),
                    details: Some(json!({
                        "cpu_samples": snapshot.cpu_samples,
                        "gpu_samples": snapshot.gpu_samples,
                        "min_cpu_samples": ADAPTIVE_MIN_CPU_SAMPLES,
                    })),
                });
            } else if snapshot.cpu_samples >= ADAPTIVE_MIN_CPU_SAMPLES
                && snapshot.gpu_samples >= ADAPTIVE_MIN_GPU_SAMPLES
                && snapshot.gpu_mean_ms > (snapshot.cpu_mean_ms * ADAPTIVE_GPU_SLOW_FACTOR)
            {
                backend = RenderBackend::Cpu;
                warnings.push(ApiWarning {
                    code: "gpu_slower_than_cpu_fallback".to_owned(),
                    message: "Automatic backend selection detected slower GPU latency and used CPU renderer.".to_owned(),
                    details: Some(json!({
                        "cpu_samples": snapshot.cpu_samples,
                        "gpu_samples": snapshot.gpu_samples,
                        "cpu_mean_ms": snapshot.cpu_mean_ms,
                        "gpu_mean_ms": snapshot.gpu_mean_ms,
                        "threshold_factor": ADAPTIVE_GPU_SLOW_FACTOR,
                    })),
                });
            }
        }
    }

    RenderBackendSelection { backend, warnings }
}

fn choose_gpu_or_cpu_fallback(
    gpu_hardware_available: bool,
    fallback_reason: Option<&str>,
    gpu_adapter_name: Option<&str>,
) -> (RenderBackend, Option<ApiWarning>) {
    if gpu_hardware_available {
        return (RenderBackend::Gpu, None);
    }

    let warning = fallback_reason.map(|reason| ApiWarning {
        code: "gpu_unavailable_fallback_cpu".to_owned(),
        message:
            "GPU rendering was requested but no GPU adapter is available; CPU renderer was used."
                .to_owned(),
        details: Some(json!({
            "requested_by": reason,
            "gpu_hardware_available": false,
            "gpu_adapter_name": gpu_adapter_name,
        })),
    });
    (RenderBackend::Cpu, warning)
}

fn is_software_adapter(gpu_adapter_name: Option<&str>) -> bool {
    let Some(adapter_name) = gpu_adapter_name else {
        return false;
    };
    let normalized = adapter_name.to_ascii_lowercase();
    ["swiftshader", "llvmpipe", "lavapipe", "software", "cpu"]
        .iter()
        .any(|needle| normalized.contains(needle))
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
    use super::{select_render_backend_with_override, BackendPerfSnapshot, RenderBackend};
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
        let selection = select_render_backend_with_override(None, None, false, None, None);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection.warnings.is_empty());
    }

    #[test]
    fn explicit_view_state_gpu_preference_falls_back_with_warning() {
        let hints = performance(true);
        let selection = select_render_backend_with_override(None, Some(&hints), false, None, None);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection
            .warnings
            .iter()
            .any(|warning| warning.code == "gpu_unavailable_fallback_cpu"));
    }

    #[test]
    fn env_override_cpu_forces_cpu_without_warning() {
        let hints = performance(true);
        let selection =
            select_render_backend_with_override(Some("cpu"), Some(&hints), true, None, None);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection.warnings.is_empty());
    }

    #[test]
    fn env_override_gpu_selects_gpu_when_hardware_available() {
        let selection = select_render_backend_with_override(Some("gpu"), None, true, None, None);
        assert_eq!(selection.backend, RenderBackend::Gpu);
        assert!(selection.warnings.is_empty());
    }

    #[test]
    fn env_override_gpu_falls_back_when_hardware_unavailable() {
        let selection = select_render_backend_with_override(Some("gpu"), None, false, None, None);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection
            .warnings
            .iter()
            .any(|warning| warning.code == "gpu_unavailable_fallback_cpu"));
    }

    #[test]
    fn auto_prefers_cpu_for_software_adapter() {
        let hints = performance(true);
        let selection =
            select_render_backend_with_override(None, Some(&hints), true, Some("llvmpipe"), None);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection
            .warnings
            .iter()
            .any(|warning| warning.code == "gpu_software_adapter_fallback_cpu"));
    }

    #[test]
    fn env_override_gpu_can_force_software_adapter() {
        let hints = performance(true);
        let selection = select_render_backend_with_override(
            Some("gpu"),
            Some(&hints),
            true,
            Some("swiftshader"),
            None,
        );
        assert_eq!(selection.backend, RenderBackend::Gpu);
        assert!(selection.warnings.is_empty());
    }

    #[test]
    fn invalid_env_override_emits_warning_and_uses_auto() {
        let selection =
            select_render_backend_with_override(Some("invalid"), None, false, None, None);
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection
            .warnings
            .iter()
            .any(|warning| warning.code == "invalid_render_backend_override"));
    }

    #[test]
    fn adaptive_policy_falls_back_to_cpu_when_gpu_is_slower() {
        let snapshot = BackendPerfSnapshot {
            cpu_samples: 8,
            cpu_mean_ms: 10.0,
            gpu_samples: 8,
            gpu_mean_ms: 16.0,
        };
        let selection =
            select_render_backend_with_override(None, None, true, Some("metal"), Some(snapshot));
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection
            .warnings
            .iter()
            .any(|warning| warning.code == "gpu_slower_than_cpu_fallback"));
    }

    #[test]
    fn adaptive_policy_collects_cpu_probe_samples_until_minimum() {
        let snapshot = BackendPerfSnapshot {
            cpu_samples: 2,
            cpu_mean_ms: 10.0,
            gpu_samples: 2,
            gpu_mean_ms: 16.0,
        };
        let selection =
            select_render_backend_with_override(None, None, true, Some("metal"), Some(snapshot));
        assert_eq!(selection.backend, RenderBackend::Cpu);
        assert!(selection
            .warnings
            .iter()
            .any(|warning| warning.code == "gpu_adaptive_cpu_probe"));
    }

    #[test]
    fn adaptive_policy_does_not_probe_when_gpu_has_no_samples() {
        let snapshot = BackendPerfSnapshot {
            cpu_samples: 0,
            cpu_mean_ms: 0.0,
            gpu_samples: 0,
            gpu_mean_ms: 0.0,
        };
        let selection =
            select_render_backend_with_override(None, None, true, Some("metal"), Some(snapshot));
        assert_eq!(selection.backend, RenderBackend::Gpu);
        assert!(selection
            .warnings
            .iter()
            .all(|warning| warning.code != "gpu_adaptive_cpu_probe"));
    }

    #[test]
    fn adaptive_policy_does_not_override_explicit_gpu_env() {
        let hints = performance(true);
        let snapshot = BackendPerfSnapshot {
            cpu_samples: 8,
            cpu_mean_ms: 10.0,
            gpu_samples: 8,
            gpu_mean_ms: 16.0,
        };
        let selection = select_render_backend_with_override(
            Some("gpu"),
            Some(&hints),
            true,
            Some("metal"),
            Some(snapshot),
        );
        assert_eq!(selection.backend, RenderBackend::Gpu);
        assert!(selection
            .warnings
            .iter()
            .all(|warning| warning.code != "gpu_slower_than_cpu_fallback"));
    }
}
