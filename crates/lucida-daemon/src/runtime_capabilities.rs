use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::OnceCell;

use crate::dto::api::CapabilitiesGpu;

#[derive(Debug, Default)]
pub struct RuntimeCapabilitiesService {
    gpu: OnceCell<CapabilitiesGpu>,
}

impl RuntimeCapabilitiesService {
    pub async fn gpu_capabilities(&self) -> CapabilitiesGpu {
        self.gpu.get_or_init(detect_gpu_capabilities).await.clone()
    }
}

pub type SharedRuntimeCapabilitiesService = Arc<RuntimeCapabilitiesService>;

pub fn new_shared_runtime_capabilities_service() -> SharedRuntimeCapabilitiesService {
    Arc::new(RuntimeCapabilitiesService::default())
}

#[cfg(feature = "gpu")]
async fn detect_gpu_capabilities() -> CapabilitiesGpu {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    let adapter = match instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
    {
        Ok(adapter) => adapter,
        Err(error) => {
            return CapabilitiesGpu {
                available: false,
                backend: None,
                adapter_name: None,
                limits: Some(json!({
                    "reason": "adapter_request_failed",
                    "error": error.to_string(),
                })),
            };
        }
    };

    let info = adapter.get_info();
    let limits = adapter.limits();
    CapabilitiesGpu {
        available: true,
        backend: Some(format!("{:?}", info.backend).to_ascii_lowercase()),
        adapter_name: Some(info.name),
        limits: Some(gpu_limits_json(&limits)),
    }
}

#[cfg(feature = "gpu")]
fn gpu_limits_json(limits: &wgpu::Limits) -> Value {
    json!({
        "max_texture_dimension_1d": limits.max_texture_dimension_1d,
        "max_texture_dimension_2d": limits.max_texture_dimension_2d,
        "max_texture_dimension_3d": limits.max_texture_dimension_3d,
        "max_bind_groups": limits.max_bind_groups,
        "max_sampled_textures_per_shader_stage": limits.max_sampled_textures_per_shader_stage,
        "max_samplers_per_shader_stage": limits.max_samplers_per_shader_stage,
        "max_uniform_buffer_binding_size": limits.max_uniform_buffer_binding_size,
        "max_storage_buffer_binding_size": limits.max_storage_buffer_binding_size,
    })
}

#[cfg(not(feature = "gpu"))]
async fn detect_gpu_capabilities() -> CapabilitiesGpu {
    CapabilitiesGpu {
        available: false,
        backend: None,
        adapter_name: None,
        limits: Some(json!({
            "reason": "gpu_feature_disabled",
        })),
    }
}
