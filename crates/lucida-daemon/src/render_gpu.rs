use std::sync::mpsc;
#[cfg(feature = "gpu")]
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use image::codecs::png::{
    CompressionType as PngCompressionType, FilterType as PngFilterType, PngEncoder,
};
use image::{ColorType, ImageEncoder};
use serde_json::json;

use crate::dto::dataset_summary::DatasetSummary;
use crate::dto::render::{RenderOutputSpec, RenderTimingMs, RenderTimingStagesMs};
use crate::dto::view_state::ViewState;
use crate::error::ApiError;
use crate::render_cache::{EffectiveCacheBudgets, RenderCacheRegistry};
use crate::render_cpu::{render_view_to_rgba, RenderCpuResult};

#[cfg(feature = "gpu")]
const GPU_COPY_SHADER_WGSL: &str = r#"
struct Pixels {
    data: array<u32>,
};

struct Params {
    pixel_count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<storage, read> src_pixels: Pixels;
@group(0) @binding(1) var<storage, read_write> dst_pixels: Pixels;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.pixel_count) {
        return;
    }
    dst_pixels.data[idx] = src_pixels.data[idx];
}
"#;

#[derive(Debug, Clone, Copy)]
#[cfg(feature = "gpu")]
struct GpuProcessTimingMs {
    upload: f64,
    compute: f64,
    readback: f64,
}

#[derive(Debug)]
#[cfg(feature = "gpu")]
struct GpuRuntimeInitError {
    code: &'static str,
    message: String,
}

#[derive(Debug)]
#[cfg(feature = "gpu")]
struct GpuCopyRuntime {
    device: wgpu::Device,
    queue: wgpu::Queue,
    bind_group_layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

#[cfg(feature = "gpu")]
pub fn render_view_to_png_gpu(
    dataset_summary: &DatasetSummary,
    view_state: &ViewState,
    output: &RenderOutputSpec,
    cache_registry: &mut RenderCacheRegistry,
    cache_session_id: &str,
    cache_budgets: EffectiveCacheBudgets,
) -> Result<RenderCpuResult, ApiError> {
    let start_total = Instant::now();
    let rgba_result = render_view_to_rgba(
        dataset_summary,
        view_state,
        output,
        cache_registry,
        cache_session_id,
        cache_budgets,
    )?;

    let (gpu_processed_rgba, gpu_timing_ms) = run_gpu_copy_pipeline(&rgba_result.rgba_bytes)?;

    let mut png_bytes: Vec<u8> = Vec::new();
    let encode_start = Instant::now();
    encode_png_fast(
        &mut png_bytes,
        &gpu_processed_rgba,
        output.width_px as u32,
        output.height_px as u32,
    )?;
    let encode_end = Instant::now();
    let end_total = Instant::now();

    Ok(RenderCpuResult {
        png_bytes,
        pyramid_level_used: rgba_result.pyramid_level_used,
        warnings: rgba_result.warnings,
        timing_ms: Some(RenderTimingMs {
            total: (end_total - start_total).as_secs_f64() * 1000.0,
            io: rgba_result.chunk_fetch_ms,
            decode: rgba_result.chunk_decode_ms,
            gpu_upload: gpu_timing_ms.upload + rgba_result.gpu_upload_ms,
            render: rgba_result.sample_ms
                + rgba_result.compose_ms
                + gpu_timing_ms.compute
                + rgba_result.gpu_compute_ms,
            stages: Some(RenderTimingStagesMs {
                chunk_fetch: rgba_result.chunk_fetch_ms,
                chunk_decode: rgba_result.chunk_decode_ms,
                sample: rgba_result.sample_ms,
                compose: rgba_result.compose_ms,
                encode: (encode_end - encode_start).as_secs_f64() * 1000.0,
                gpu_compute: gpu_timing_ms.compute + rgba_result.gpu_compute_ms,
                gpu_readback: gpu_timing_ms.readback + rgba_result.gpu_readback_ms,
            }),
        }),
    })
}

#[cfg(feature = "gpu")]
fn run_gpu_copy_pipeline(rgba_bytes: &[u8]) -> Result<(Vec<u8>, GpuProcessTimingMs), ApiError> {
    if rgba_bytes.is_empty() {
        return Ok((
            Vec::new(),
            GpuProcessTimingMs {
                upload: 0.0,
                compute: 0.0,
                readback: 0.0,
            },
        ));
    }
    if rgba_bytes.len() % 4 != 0 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "GPU render pipeline requires RGBA input length to be divisible by 4.",
            Some(json!({
                "rgba_len": rgba_bytes.len(),
            })),
        ));
    }

    let pixel_count = rgba_bytes.len() / 4;
    let byte_len = u64::try_from(rgba_bytes.len()).map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Rendered image buffer exceeds GPU pipeline limits.",
            Some(json!({
                "rgba_len": rgba_bytes.len(),
            })),
        )
    })?;

    let runtime = gpu_copy_runtime()?;
    let device = &runtime.device;
    let queue = &runtime.queue;

    let input_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("lucida-gpu-copy-input"),
        size: byte_len,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("lucida-gpu-copy-output"),
        size: byte_len,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("lucida-gpu-copy-readback"),
        size: byte_len,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("lucida-gpu-copy-params"),
        size: 16,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("lucida-gpu-copy-bind-group"),
        layout: &runtime.bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: input_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: output_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: params_buffer.as_entire_binding(),
            },
        ],
    });

    let upload_start = Instant::now();
    queue.write_buffer(&input_buffer, 0, rgba_bytes);
    let mut params_bytes = [0_u8; 16];
    params_bytes[0..4].copy_from_slice(&(pixel_count as u32).to_le_bytes());
    queue.write_buffer(&params_buffer, 0, &params_bytes);
    let upload_end = Instant::now();

    let compute_start = Instant::now();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("lucida-gpu-copy-command-encoder"),
    });
    {
        let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("lucida-gpu-copy-compute-pass"),
            timestamp_writes: None,
        });
        compute_pass.set_pipeline(&runtime.pipeline);
        compute_pass.set_bind_group(0, &bind_group, &[]);
        let workgroup_count = (u32::try_from(pixel_count).unwrap_or(u32::MAX)).div_ceil(64);
        compute_pass.dispatch_workgroups(workgroup_count.max(1), 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output_buffer, 0, &readback_buffer, 0, byte_len);
    queue.submit(Some(encoder.finish()));
    let readback_start = Instant::now();

    let slice = readback_buffer.slice(..);
    let (tx, rx) = mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = tx.send(result);
    });
    let _ = device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|error| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "gpu_render_failed",
                "GPU device poll failed during readback.",
                Some(json!({ "reason": error.to_string() })),
            )
        })?;
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "gpu_render_failed",
                "GPU map_async failed during readback.",
                Some(json!({ "reason": error.to_string() })),
            ))
        }
        Err(error) => {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "gpu_render_failed",
                "Timed out waiting for GPU readback.",
                Some(json!({ "reason": error.to_string() })),
            ))
        }
    }
    let mapped_range = slice.get_mapped_range();
    let mut rgba_out = vec![0_u8; rgba_bytes.len()];
    rgba_out.copy_from_slice(&mapped_range[..rgba_bytes.len()]);
    drop(mapped_range);
    readback_buffer.unmap();
    let readback_end = Instant::now();

    Ok((
        rgba_out,
        GpuProcessTimingMs {
            upload: (upload_end - upload_start).as_secs_f64() * 1000.0,
            compute: (readback_start - compute_start).as_secs_f64() * 1000.0,
            readback: (readback_end - readback_start).as_secs_f64() * 1000.0,
        },
    ))
}

fn encode_png_fast(
    out: &mut Vec<u8>,
    rgba: &[u8],
    width: u32,
    height: u32,
) -> Result<(), ApiError> {
    let encoder =
        PngEncoder::new_with_quality(out, PngCompressionType::Fast, PngFilterType::NoFilter);
    encoder
        .write_image(rgba, width, height, ColorType::Rgba8.into())
        .map_err(|error| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "render_failed",
                "Failed to encode PNG image.",
                Some(json!({ "reason": error.to_string() })),
            )
        })
}

#[cfg(feature = "gpu")]
fn gpu_copy_runtime() -> Result<&'static GpuCopyRuntime, ApiError> {
    static GPU_COPY_RUNTIME: OnceLock<Result<GpuCopyRuntime, GpuRuntimeInitError>> =
        OnceLock::new();

    match GPU_COPY_RUNTIME.get_or_init(initialize_gpu_copy_runtime) {
        Ok(runtime) => Ok(runtime),
        Err(error) => Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            error.code,
            "Failed to initialize GPU renderer runtime.",
            Some(json!({
                "reason": error.message,
            })),
        )),
    }
}

#[cfg(feature = "gpu")]
fn initialize_gpu_copy_runtime() -> Result<GpuCopyRuntime, GpuRuntimeInitError> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .map_err(|error| GpuRuntimeInitError {
        code: "gpu_render_failed",
        message: format!("GPU adapter request failed: {error}"),
    })?;

    let adapter_limits = adapter.limits();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("lucida-gpu-render-device"),
        required_features: wgpu::Features::empty(),
        required_limits: adapter_limits,
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
    }))
    .map_err(|error| GpuRuntimeInitError {
        code: "gpu_render_failed",
        message: format!("GPU device request failed: {error}"),
    })?;

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("lucida-gpu-copy-shader"),
        source: wgpu::ShaderSource::Wgsl(GPU_COPY_SHADER_WGSL.into()),
    });

    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("lucida-gpu-copy-bind-group-layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("lucida-gpu-copy-pipeline-layout"),
        bind_group_layouts: &[&bind_group_layout],
        immediate_size: 0,
    });

    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("lucida-gpu-copy-pipeline"),
        layout: Some(&pipeline_layout),
        module: &shader,
        entry_point: Some("main"),
        compilation_options: wgpu::PipelineCompilationOptions::default(),
        cache: None,
    });

    Ok(GpuCopyRuntime {
        device,
        queue,
        bind_group_layout,
        pipeline,
    })
}

#[cfg(not(feature = "gpu"))]
pub fn render_view_to_png_gpu(
    _dataset_summary: &DatasetSummary,
    _view_state: &ViewState,
    _output: &RenderOutputSpec,
    _cache_registry: &mut RenderCacheRegistry,
    _cache_session_id: &str,
    _cache_budgets: EffectiveCacheBudgets,
) -> Result<RenderCpuResult, ApiError> {
    Err(ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "gpu_render_failed",
        "GPU rendering is unavailable because the daemon was built without the gpu feature.",
        None,
    ))
}
