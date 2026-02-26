#[cfg(feature = "gpu")]
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::mpsc;
#[cfg(feature = "gpu")]
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use image::codecs::png::{
    CompressionType as PngCompressionType, FilterType as PngFilterType, PngEncoder,
};
use image::{ColorType, ImageEncoder};
use serde_json::json;
#[cfg(feature = "gpu")]
use sha2::{Digest, Sha256};

use crate::dto::dataset_summary::DatasetSummary;
use crate::dto::render::{RenderOutputSpec, RenderTimingMs, RenderTimingStagesMs};
use crate::dto::view_state::{
    ChannelContrast, ChannelContrastPolicy, ChannelMode, ImageChannelSettings, InterpolationMode,
    LayerState, ViewState,
};
use crate::error::ApiError;
use crate::render_cache::{EffectiveCacheBudgets, RenderCacheRegistry};
use crate::render_cpu::{
    prepare_single_plane_for_external_renderer, PlaneData, PreparedLayerSamplingInput,
    RenderCpuResult, RenderRgbaResult,
};

#[cfg(feature = "gpu")]
const GPU_LAYER_COMPOSITE_SHADER_WGSL: &str = r#"
struct Values {
    data: array<f32>,
};

struct Meta {
    data: array<f32>,
};

struct Canvas {
    data: array<vec4<f32>>,
};

struct Params {
    dims: vec4<u32>,
    sampling_a: vec4<f32>,
    sampling_b: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> channel_values: Values;
@group(0) @binding(1) var<storage, read> channel_meta: Meta;
@group(0) @binding(2) var<storage, read_write> canvas: Canvas;
@group(0) @binding(3) var<uniform> params: Params;

const META_STRIDE: u32 = 16u;

fn meta_value(channel: u32, slot: u32) -> f32 {
    return channel_meta.data[channel * META_STRIDE + slot];
}

fn sample_channel(channel: u32, px_x: u32, px_y: u32) -> vec2<f32> {
    let width = u32(max(meta_value(channel, 1u), 0.0));
    let height = u32(max(meta_value(channel, 2u), 0.0));
    if (width == 0u || height == 0u) {
        return vec2<f32>(0.0, 0.0);
    }

    let origin_u = meta_value(channel, 3u);
    let origin_v = meta_value(channel, 4u);

    let zoom_safe = max(params.sampling_a.z, 1e-6);
    let pixel_ratio_safe = max(params.sampling_a.w, 0.5);
    let f_u_safe = max(params.sampling_b.x, 1e-6);
    let f_v_safe = max(params.sampling_b.y, 1e-6);

    let span_u = f32(params.dims.x) / (zoom_safe * pixel_ratio_safe * f_u_safe);
    let span_v = f32(params.dims.y) / (zoom_safe * pixel_ratio_safe * f_v_safe);

    let center_u_level = (params.sampling_a.x / f_u_safe) - origin_u;
    let center_v_level = (params.sampling_a.y / f_v_safe) - origin_v;

    let start_u = center_u_level - (span_u / 2.0);
    let start_v = center_v_level - (span_v / 2.0);
    let step_u = span_u / max(f32(params.dims.x), 1.0);
    let step_v = span_v / max(f32(params.dims.y), 1.0);

    let u_coord = start_u + (f32(px_x) + 0.5) * step_u;
    let v_coord = start_v + (f32(px_y) + 0.5) * step_v;

    let offset = u32(max(meta_value(channel, 0u), 0.0));
    let src_w = i32(width);
    let src_h = i32(height);

    if (params.dims.w == 0u) {
        let u_idx = i32(floor(u_coord));
        let v_idx = i32(floor(v_coord));
        let valid_u = u_idx >= 0 && u_idx < src_w;
        let valid_v = v_idx >= 0 && v_idx < src_h;
        if (!(valid_u && valid_v)) {
            return vec2<f32>(0.0, 0.0);
        }
        let u_clamped = u32(clamp(u_idx, 0, src_w - 1));
        let v_clamped = u32(clamp(v_idx, 0, src_h - 1));
        let sample_idx = offset + (v_clamped * width) + u_clamped;
        return vec2<f32>(channel_values.data[sample_idx], 1.0);
    }

    let valid_u = u_coord >= 0.0 && u_coord <= f32(src_w - 1);
    let valid_v = v_coord >= 0.0 && v_coord <= f32(src_h - 1);
    if (!(valid_u && valid_v)) {
        return vec2<f32>(0.0, 0.0);
    }

    let u0 = i32(floor(u_coord));
    let u1 = u0 + 1;
    let v0 = i32(floor(v_coord));
    let v1 = v0 + 1;

    let du = u_coord - f32(u0);
    let dv = v_coord - f32(v0);

    let u0c = u32(clamp(u0, 0, src_w - 1));
    let u1c = u32(clamp(u1, 0, src_w - 1));
    let v0c = u32(clamp(v0, 0, src_h - 1));
    let v1c = u32(clamp(v1, 0, src_h - 1));

    let s00 = channel_values.data[offset + (v0c * width) + u0c];
    let s01 = channel_values.data[offset + (v0c * width) + u1c];
    let s10 = channel_values.data[offset + (v1c * width) + u0c];
    let s11 = channel_values.data[offset + (v1c * width) + u1c];

    let w00 = (1.0 - dv) * (1.0 - du);
    let w01 = (1.0 - dv) * du;
    let w10 = dv * (1.0 - du);
    let w11 = dv * du;

    return vec2<f32>((s00 * w00) + (s01 * w01) + (s10 * w10) + (s11 * w11), 1.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.dims.x || gid.y >= params.dims.y) {
        return;
    }

    let pixel_index = gid.y * params.dims.x + gid.x;

    var layer_rgb = vec3<f32>(0.0, 0.0, 0.0);
    var layer_alpha = 0.0;
    var sample_alpha = 0.0;

    for (var channel = 0u; channel < params.dims.z; channel = channel + 1u) {
        let sampled = sample_channel(channel, gid.x, gid.y);
        sample_alpha = max(sample_alpha, sampled.y);

        if (meta_value(channel, 5u) < 0.5) {
            continue;
        }

        let min_value = meta_value(channel, 6u);
        let max_value = meta_value(channel, 7u);
        let range = max_value - min_value;

        var normalized = 0.0;
        if (range > 0.0 && min_value <= max_value) {
            normalized = clamp((sampled.x - min_value) / range, 0.0, 1.0);
        }

        let gamma = meta_value(channel, 8u);
        if (gamma > 0.0) {
            normalized = pow(clamp(normalized, 0.0, 1.0), 1.0 / gamma);
        }

        let color = vec4<f32>(
            meta_value(channel, 9u),
            meta_value(channel, 10u),
            meta_value(channel, 11u),
            meta_value(channel, 12u),
        );

        let strength = normalized * params.sampling_b.z * sample_alpha * color.a;
        layer_rgb = layer_rgb + (strength * color.xyz);
        layer_alpha = layer_alpha + strength;
    }

    layer_rgb = clamp(layer_rgb, vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(1.0, 1.0, 1.0));
    layer_alpha = clamp(layer_alpha, 0.0, 1.0);

    let dst = canvas.data[pixel_index];
    let src_alpha = layer_alpha;
    let out_rgb = clamp(
        layer_rgb + (dst.xyz * (1.0 - src_alpha)),
        vec3<f32>(0.0, 0.0, 0.0),
        vec3<f32>(1.0, 1.0, 1.0),
    );
    let out_alpha = clamp(src_alpha + (dst.w * (1.0 - src_alpha)), 0.0, 1.0);
    canvas.data[pixel_index] = vec4<f32>(out_rgb, out_alpha);
}
"#;

#[cfg(feature = "gpu")]
const LAYER_META_STRIDE_FLOATS: usize = 16;
#[cfg(feature = "gpu")]
const PARAM_BYTES_LEN: usize = 48;
#[cfg(feature = "gpu")]
const DEFAULT_CHANNEL_COLORS: [[f32; 4]; 6] = [
    [1.0, 0.0, 0.0, 1.0],
    [0.0, 1.0, 0.0, 1.0],
    [0.0, 0.0, 1.0, 1.0],
    [1.0, 1.0, 0.0, 1.0],
    [1.0, 0.0, 1.0, 1.0],
    [0.0, 1.0, 1.0, 1.0],
];

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

#[derive(Debug, Clone)]
#[cfg(feature = "gpu")]
struct GpuCachedLayerBuffers {
    values_buffer: wgpu::Buffer,
    meta_buffer: wgpu::Buffer,
    channel_count: u32,
    size_bytes: u64,
}

#[derive(Debug, Clone, Copy)]
#[cfg(feature = "gpu")]
struct GpuBufferCacheSnapshot {
    hits: u64,
    misses: u64,
    inserts: u64,
    evictions: u64,
    current_bytes: u64,
    max_bytes: u64,
}

#[derive(Debug, Default)]
#[cfg(feature = "gpu")]
struct GpuBufferCache {
    entries: HashMap<String, GpuCachedLayerBuffers>,
    order: VecDeque<String>,
    current_bytes: u64,
    max_bytes: u64,
    hits: u64,
    misses: u64,
    inserts: u64,
    evictions: u64,
}

#[cfg(feature = "gpu")]
impl GpuBufferCache {
    fn configure_budget(&mut self, max_bytes: u64) {
        self.max_bytes = max_bytes;
        self.evict_to_fit();
    }

    fn snapshot(&self) -> GpuBufferCacheSnapshot {
        GpuBufferCacheSnapshot {
            hits: self.hits,
            misses: self.misses,
            inserts: self.inserts,
            evictions: self.evictions,
            current_bytes: self.current_bytes,
            max_bytes: self.max_bytes,
        }
    }

    fn get(&mut self, key: &str) -> Option<GpuCachedLayerBuffers> {
        if let Some(entry) = self.entries.get(key) {
            let cloned = entry.clone();
            self.hits = self.hits.saturating_add(1);
            self.touch_key(key);
            return Some(cloned);
        }
        self.misses = self.misses.saturating_add(1);
        None
    }

    fn insert(&mut self, key: String, entry: GpuCachedLayerBuffers) {
        if self.max_bytes == 0 || entry.size_bytes > self.max_bytes {
            return;
        }

        if let Some(previous) = self.entries.remove(&key) {
            self.current_bytes = self.current_bytes.saturating_sub(previous.size_bytes);
            self.order.retain(|stored| stored != &key);
        }

        self.current_bytes = self.current_bytes.saturating_add(entry.size_bytes);
        self.entries.insert(key.clone(), entry);
        self.order.push_back(key);
        self.inserts = self.inserts.saturating_add(1);
        self.evict_to_fit();
    }

    fn touch_key(&mut self, key: &str) {
        if self.order.back().is_some_and(|tail| tail == key) {
            return;
        }
        self.order.retain(|stored| stored != key);
        self.order.push_back(key.to_owned());
    }

    fn evict_to_fit(&mut self) {
        while self.current_bytes > self.max_bytes {
            let Some(oldest) = self.order.pop_front() else {
                self.current_bytes = 0;
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.current_bytes = self.current_bytes.saturating_sub(removed.size_bytes);
                self.evictions = self.evictions.saturating_add(1);
            }
        }
    }
}

#[derive(Debug)]
#[cfg(feature = "gpu")]
struct GpuLayerCompositeRuntime {
    device: wgpu::Device,
    queue: wgpu::Queue,
    bind_group_layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
    layer_cache: Mutex<GpuBufferCache>,
}

#[derive(Debug, Clone)]
#[cfg(feature = "gpu")]
struct GpuLayerPayload {
    key: String,
    values_bytes: Vec<u8>,
    meta_bytes: Vec<u8>,
    channel_count: u32,
}

#[derive(Debug, Clone, Copy)]
#[cfg(feature = "gpu")]
struct GpuLayerChannelConfig {
    active: bool,
    min_value: f32,
    max_value: f32,
    gamma: f32,
    color: [f32; 4],
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
    let rgba_result = render_view_to_rgba_gpu(
        dataset_summary,
        view_state,
        output,
        cache_registry,
        cache_session_id,
        cache_budgets,
    )?;

    let mut png_bytes: Vec<u8> = Vec::new();
    let encode_start = Instant::now();
    encode_png_fast(
        &mut png_bytes,
        &rgba_result.rgba_bytes,
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
            gpu_upload: rgba_result.gpu_upload_ms,
            render: rgba_result.sample_ms + rgba_result.compose_ms + rgba_result.gpu_compute_ms,
            stages: Some(RenderTimingStagesMs {
                chunk_fetch: rgba_result.chunk_fetch_ms,
                chunk_decode: rgba_result.chunk_decode_ms,
                sample: rgba_result.sample_ms,
                compose: rgba_result.compose_ms,
                encode: (encode_end - encode_start).as_secs_f64() * 1000.0,
                gpu_compute: rgba_result.gpu_compute_ms,
                gpu_readback: rgba_result.gpu_readback_ms,
            }),
        }),
    })
}

#[cfg(feature = "gpu")]
pub fn render_view_to_rgba_gpu(
    dataset_summary: &DatasetSummary,
    view_state: &ViewState,
    output: &RenderOutputSpec,
    cache_registry: &mut RenderCacheRegistry,
    cache_session_id: &str,
    cache_budgets: EffectiveCacheBudgets,
) -> Result<RenderRgbaResult, ApiError> {
    let Some(view_2d) = view_state.view_2d.as_ref() else {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_mode",
            "Only mode=2d is supported for this renderer.",
            Some(json!({ "mode": "3d" })),
        ));
    };

    if view_2d.orthogonal_views_enabled {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "gpu_render_failed",
            "GPU sampling/compositing does not yet support orthogonal triptych rendering.",
            Some(json!({
                "orthogonal_views_enabled": true,
            })),
        ));
    }

    let output_width = usize::try_from(output.width_px).unwrap_or(0);
    let output_height = usize::try_from(output.height_px).unwrap_or(0);
    let prepared = prepare_single_plane_for_external_renderer(
        dataset_summary,
        view_state,
        view_2d,
        output_width,
        output_height,
        cache_registry,
        cache_session_id,
    )?;

    let (rgba_bytes, gpu_timing_ms) = run_gpu_layer_pipeline(
        &prepared.background,
        prepared.center_world,
        prepared.zoom,
        prepared.pixel_ratio,
        &prepared.layers,
        output_width,
        output_height,
        cache_budgets.max_gpu_cache_bytes,
        cache_session_id,
    )?;

    Ok(RenderRgbaResult {
        rgba_bytes,
        pyramid_level_used: prepared.primary_level_used,
        warnings: prepared.warnings,
        chunk_fetch_ms: prepared.chunk_fetch_ms,
        chunk_decode_ms: prepared.chunk_decode_ms,
        sample_ms: 0.0,
        compose_ms: 0.0,
        gpu_upload_ms: gpu_timing_ms.upload,
        gpu_compute_ms: gpu_timing_ms.compute,
        gpu_readback_ms: gpu_timing_ms.readback,
    })
}

#[cfg(feature = "gpu")]
#[allow(clippy::too_many_arguments)]
fn run_gpu_layer_pipeline(
    background: &[f32; 4],
    center_world: (f64, f64),
    zoom: f64,
    pixel_ratio: f64,
    layers: &[PreparedLayerSamplingInput],
    output_width: usize,
    output_height: usize,
    max_gpu_cache_bytes: u64,
    cache_session_id: &str,
) -> Result<(Vec<u8>, GpuProcessTimingMs), ApiError> {
    let runtime = gpu_layer_runtime()?;
    let device = &runtime.device;
    let queue = &runtime.queue;

    let pixel_count = output_width.saturating_mul(output_height);
    let canvas_byte_len = u64::try_from(pixel_count.saturating_mul(16)).map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Rendered image buffer exceeds GPU pipeline limits.",
            Some(json!({
                "pixel_count": pixel_count,
            })),
        )
    })?;

    {
        let mut cache = runtime.layer_cache.lock().map_err(|_| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "gpu_render_failed",
                "Failed to lock GPU resource cache.",
                None,
            )
        })?;
        cache.configure_budget(max_gpu_cache_bytes);
    }

    let canvas_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("lucida-gpu-canvas"),
        size: canvas_byte_len,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("lucida-gpu-readback"),
        size: canvas_byte_len,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut upload_ms = 0.0;
    let upload_start = Instant::now();
    let canvas_init = initial_canvas_f32_bytes(background, pixel_count);
    queue.write_buffer(&canvas_buffer, 0, &canvas_init);
    upload_ms += (Instant::now() - upload_start).as_secs_f64() * 1000.0;

    let compute_start = Instant::now();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("lucida-gpu-layer-composite-encoder"),
    });

    for layer in layers {
        let payload = layer_payload(layer);
        let cache_key = format!("{cache_session_id}|{}", payload.key);
        let (values_buffer, meta_buffer, channel_count, layer_upload_ms) =
            get_or_upload_layer_buffers(runtime, &cache_key, &payload, max_gpu_cache_bytes)?;
        upload_ms += layer_upload_ms;

        let params_bytes = encode_params_bytes(
            u32::try_from(output_width).unwrap_or(u32::MAX),
            u32::try_from(output_height).unwrap_or(u32::MAX),
            channel_count,
            if matches!(layer.interpolation, InterpolationMode::Nearest) {
                0
            } else {
                1
            },
            center_world.0 as f32,
            center_world.1 as f32,
            zoom as f32,
            pixel_ratio as f32,
            layer.f_u as f32,
            layer.f_v as f32,
            layer.layer.opacity as f32,
        );

        let params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("lucida-gpu-layer-params"),
            size: u64::try_from(PARAM_BYTES_LEN).unwrap_or(48),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let params_upload_start = Instant::now();
        queue.write_buffer(&params_buffer, 0, &params_bytes);
        upload_ms += (Instant::now() - params_upload_start).as_secs_f64() * 1000.0;

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lucida-gpu-layer-bind-group"),
            layout: &runtime.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: values_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: meta_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: canvas_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: params_buffer.as_entire_binding(),
                },
            ],
        });

        {
            let mut compute_pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("lucida-gpu-layer-composite-pass"),
                timestamp_writes: None,
            });
            compute_pass.set_pipeline(&runtime.pipeline);
            compute_pass.set_bind_group(0, &bind_group, &[]);
            let wg_x = u32::try_from(output_width)
                .unwrap_or(u32::MAX)
                .div_ceil(8)
                .max(1);
            let wg_y = u32::try_from(output_height)
                .unwrap_or(u32::MAX)
                .div_ceil(8)
                .max(1);
            compute_pass.dispatch_workgroups(wg_x, wg_y, 1);
        }
    }

    encoder.copy_buffer_to_buffer(&canvas_buffer, 0, &readback_buffer, 0, canvas_byte_len);
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

    let mapped = slice.get_mapped_range();
    let rgba_out = rgba_u8_from_canvas_f32_bytes(&mapped, pixel_count)?;
    drop(mapped);
    readback_buffer.unmap();
    let readback_end = Instant::now();

    if let Ok(cache) = runtime.layer_cache.lock() {
        let snapshot = cache.snapshot();
        tracing::debug!(
            target: "lucida.gpu_cache",
            hits = snapshot.hits,
            misses = snapshot.misses,
            inserts = snapshot.inserts,
            evictions = snapshot.evictions,
            current_bytes = snapshot.current_bytes,
            max_bytes = snapshot.max_bytes,
            "gpu layer cache snapshot"
        );
    }

    Ok((
        rgba_out,
        GpuProcessTimingMs {
            upload: upload_ms,
            compute: (readback_start - compute_start).as_secs_f64() * 1000.0,
            readback: (readback_end - readback_start).as_secs_f64() * 1000.0,
        },
    ))
}

#[cfg(feature = "gpu")]
fn initial_canvas_f32_bytes(background: &[f32; 4], pixel_count: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(pixel_count.saturating_mul(16));
    for _ in 0..pixel_count {
        bytes.extend_from_slice(&background[0].to_le_bytes());
        bytes.extend_from_slice(&background[1].to_le_bytes());
        bytes.extend_from_slice(&background[2].to_le_bytes());
        bytes.extend_from_slice(&background[3].to_le_bytes());
    }
    bytes
}

#[cfg(feature = "gpu")]
fn rgba_u8_from_canvas_f32_bytes(
    canvas_bytes: &[u8],
    pixel_count: usize,
) -> Result<Vec<u8>, ApiError> {
    if canvas_bytes.len() < pixel_count.saturating_mul(16) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "gpu_render_failed",
            "GPU readback payload was smaller than expected.",
            Some(json!({
                "expected_bytes": pixel_count.saturating_mul(16),
                "actual_bytes": canvas_bytes.len(),
            })),
        ));
    }

    let mut rgba_u8 = vec![0_u8; pixel_count.saturating_mul(4)];
    for pixel in 0..pixel_count {
        let base = pixel * 16;
        let r = f32::from_le_bytes([
            canvas_bytes[base],
            canvas_bytes[base + 1],
            canvas_bytes[base + 2],
            canvas_bytes[base + 3],
        ]);
        let g = f32::from_le_bytes([
            canvas_bytes[base + 4],
            canvas_bytes[base + 5],
            canvas_bytes[base + 6],
            canvas_bytes[base + 7],
        ]);
        let b = f32::from_le_bytes([
            canvas_bytes[base + 8],
            canvas_bytes[base + 9],
            canvas_bytes[base + 10],
            canvas_bytes[base + 11],
        ]);
        let a = f32::from_le_bytes([
            canvas_bytes[base + 12],
            canvas_bytes[base + 13],
            canvas_bytes[base + 14],
            canvas_bytes[base + 15],
        ]);

        let out = pixel * 4;
        rgba_u8[out] = (r.clamp(0.0, 1.0) * 255.0).round() as u8;
        rgba_u8[out + 1] = (g.clamp(0.0, 1.0) * 255.0).round() as u8;
        rgba_u8[out + 2] = (b.clamp(0.0, 1.0) * 255.0).round() as u8;
        rgba_u8[out + 3] = (a.clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    Ok(rgba_u8)
}

#[cfg(feature = "gpu")]
fn encode_params_bytes(
    output_width: u32,
    output_height: u32,
    channel_count: u32,
    interpolation_mode: u32,
    center_u: f32,
    center_v: f32,
    zoom: f32,
    pixel_ratio: f32,
    f_u: f32,
    f_v: f32,
    layer_opacity: f32,
) -> [u8; PARAM_BYTES_LEN] {
    let mut bytes = [0_u8; PARAM_BYTES_LEN];
    bytes[0..4].copy_from_slice(&output_width.to_le_bytes());
    bytes[4..8].copy_from_slice(&output_height.to_le_bytes());
    bytes[8..12].copy_from_slice(&channel_count.to_le_bytes());
    bytes[12..16].copy_from_slice(&interpolation_mode.to_le_bytes());

    bytes[16..20].copy_from_slice(&center_u.to_le_bytes());
    bytes[20..24].copy_from_slice(&center_v.to_le_bytes());
    bytes[24..28].copy_from_slice(&zoom.to_le_bytes());
    bytes[28..32].copy_from_slice(&pixel_ratio.to_le_bytes());

    bytes[32..36].copy_from_slice(&f_u.to_le_bytes());
    bytes[36..40].copy_from_slice(&f_v.to_le_bytes());
    bytes[40..44].copy_from_slice(&layer_opacity.to_le_bytes());
    bytes[44..48].copy_from_slice(&0_f32.to_le_bytes());
    bytes
}

#[cfg(feature = "gpu")]
fn layer_payload(prepared_layer: &PreparedLayerSamplingInput) -> GpuLayerPayload {
    let channel_count = prepared_layer.channel_stack.len();
    let channel_configs =
        build_channel_configs(&prepared_layer.layer, &prepared_layer.channel_stack);

    let mut values_f32: Vec<f32> = Vec::new();
    let mut meta_f32: Vec<f32> =
        Vec::with_capacity(channel_count.saturating_mul(LAYER_META_STRIDE_FLOATS));

    for (channel_index, plane) in prepared_layer.channel_stack.iter().enumerate() {
        let value_offset = values_f32.len();
        values_f32.extend_from_slice(&plane.data);

        let config = channel_configs
            .get(channel_index)
            .copied()
            .unwrap_or(GpuLayerChannelConfig {
                active: false,
                min_value: 0.0,
                max_value: 0.0,
                gamma: 1.0,
                color: [0.0, 0.0, 0.0, 0.0],
            });

        meta_f32.push(value_offset as f32);
        meta_f32.push(plane.width as f32);
        meta_f32.push(plane.height as f32);
        meta_f32.push(plane.origin_u as f32);
        meta_f32.push(plane.origin_v as f32);
        meta_f32.push(if config.active { 1.0 } else { 0.0 });
        meta_f32.push(config.min_value);
        meta_f32.push(config.max_value);
        meta_f32.push(config.gamma);
        meta_f32.push(config.color[0]);
        meta_f32.push(config.color[1]);
        meta_f32.push(config.color[2]);
        meta_f32.push(config.color[3]);
        meta_f32.push(0.0);
        meta_f32.push(0.0);
        meta_f32.push(0.0);
    }

    let mut values_bytes = Vec::with_capacity(values_f32.len().saturating_mul(4));
    for value in values_f32 {
        values_bytes.extend_from_slice(&value.to_le_bytes());
    }

    let mut meta_bytes = Vec::with_capacity(meta_f32.len().saturating_mul(4));
    for value in meta_f32 {
        meta_bytes.extend_from_slice(&value.to_le_bytes());
    }

    let mut hasher = Sha256::new();
    hasher.update(&values_bytes);
    hasher.update(&meta_bytes);
    let key = format!("{:x}", hasher.finalize());

    GpuLayerPayload {
        key,
        values_bytes,
        meta_bytes,
        channel_count: u32::try_from(channel_count).unwrap_or(u32::MAX),
    }
}

#[cfg(feature = "gpu")]
fn build_channel_configs(
    layer: &LayerState,
    channel_stack: &[PlaneData],
) -> Vec<GpuLayerChannelConfig> {
    let mut settings_by_index: BTreeMap<usize, ImageChannelSettings> = layer
        .image
        .as_ref()
        .map(|settings| {
            settings
                .channels
                .iter()
                .filter(|channel| channel.enabled)
                .map(|channel| (usize::try_from(channel.index).unwrap_or(0), channel.clone()))
                .collect()
        })
        .unwrap_or_default();

    if settings_by_index.is_empty() {
        for index in 0..channel_stack.len() {
            settings_by_index.insert(
                index,
                ImageChannelSettings {
                    index: index as u64,
                    enabled: true,
                    color_rgba: None,
                    contrast: Some(ChannelContrast {
                        policy: ChannelContrastPolicy::Percentile,
                        min: None,
                        max: None,
                        p_low: 1.0,
                        p_high: 99.0,
                    }),
                    gamma: 1.0,
                },
            );
        }
    }

    let channel_mode = layer
        .image
        .as_ref()
        .map(|settings| settings.channel_mode.clone())
        .unwrap_or(ChannelMode::Composite);

    let selected: Vec<usize> = match channel_mode {
        ChannelMode::Single => settings_by_index.keys().copied().take(1).collect(),
        ChannelMode::Rgb => settings_by_index.keys().copied().take(3).collect(),
        ChannelMode::Composite => settings_by_index.keys().copied().collect(),
    };
    let selected_set: HashSet<usize> = selected.iter().copied().collect();

    let mut rgb_overrides: HashMap<usize, [f32; 4]> = HashMap::new();
    if matches!(channel_mode, ChannelMode::Rgb) {
        let rgb_colors = [
            [1.0, 0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0, 1.0],
            [0.0, 0.0, 1.0, 1.0],
        ];
        for (position, channel_index) in selected.iter().enumerate() {
            if let Some(color) = rgb_colors.get(position) {
                rgb_overrides.insert(*channel_index, *color);
            }
        }
    }

    let mut configs = Vec::with_capacity(channel_stack.len());
    for (channel_index, plane) in channel_stack.iter().enumerate() {
        let Some(setting) = settings_by_index.get(&channel_index) else {
            configs.push(GpuLayerChannelConfig {
                active: false,
                min_value: 0.0,
                max_value: 0.0,
                gamma: 1.0,
                color: [0.0, 0.0, 0.0, 0.0],
            });
            continue;
        };

        let (min_value, max_value) = normalization_bounds(&plane.data, setting.contrast.as_ref());
        let color = rgb_overrides
            .get(&channel_index)
            .copied()
            .or_else(|| {
                setting.color_rgba.map(|value| {
                    [
                        value[0] as f32,
                        value[1] as f32,
                        value[2] as f32,
                        value[3] as f32,
                    ]
                })
            })
            .unwrap_or(DEFAULT_CHANNEL_COLORS[channel_index % DEFAULT_CHANNEL_COLORS.len()]);

        configs.push(GpuLayerChannelConfig {
            active: selected_set.contains(&channel_index),
            min_value,
            max_value,
            gamma: setting.gamma as f32,
            color,
        });
    }
    configs
}

#[cfg(feature = "gpu")]
fn normalization_bounds(channel_data: &[f32], contrast: Option<&ChannelContrast>) -> (f32, f32) {
    let (mut min_value, mut max_value) = match contrast {
        None => min_max(channel_data),
        Some(contrast) => match contrast.policy {
            ChannelContrastPolicy::Fixed => (
                contrast
                    .min
                    .unwrap_or_else(|| min_max(channel_data).0 as f64) as f32,
                contrast
                    .max
                    .unwrap_or_else(|| min_max(channel_data).1 as f64) as f32,
            ),
            ChannelContrastPolicy::Percentile => (
                percentile(channel_data, contrast.p_low as f32),
                percentile(channel_data, contrast.p_high as f32),
            ),
        },
    };

    if !min_value.is_finite() || !max_value.is_finite() || max_value <= min_value {
        (min_value, max_value) = min_max(channel_data);
    }
    if !min_value.is_finite() || !max_value.is_finite() || max_value <= min_value {
        return (0.0, 0.0);
    }
    (min_value, max_value)
}

#[cfg(feature = "gpu")]
fn min_max(values: &[f32]) -> (f32, f32) {
    let mut min_value = f32::INFINITY;
    let mut max_value = f32::NEG_INFINITY;
    for value in values {
        if value.is_finite() {
            min_value = min_value.min(*value);
            max_value = max_value.max(*value);
        }
    }
    (min_value, max_value)
}

#[cfg(feature = "gpu")]
fn percentile(values: &[f32], percentile: f32) -> f32 {
    let mut finite: Vec<f32> = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect();
    if finite.is_empty() {
        return f32::NAN;
    }
    finite.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let p = percentile.clamp(0.0, 100.0);
    let rank = (p / 100.0) * ((finite.len() - 1) as f32);
    let low = rank.floor() as usize;
    let high = rank.ceil() as usize;
    if low == high {
        return finite[low];
    }
    let weight = rank - (low as f32);
    (finite[low] * (1.0 - weight)) + (finite[high] * weight)
}

#[cfg(feature = "gpu")]
fn get_or_upload_layer_buffers(
    runtime: &GpuLayerCompositeRuntime,
    cache_key: &str,
    payload: &GpuLayerPayload,
    max_gpu_cache_bytes: u64,
) -> Result<(wgpu::Buffer, wgpu::Buffer, u32, f64), ApiError> {
    {
        let mut cache = runtime.layer_cache.lock().map_err(|_| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "gpu_render_failed",
                "Failed to lock GPU resource cache.",
                None,
            )
        })?;
        cache.configure_budget(max_gpu_cache_bytes);
        if let Some(hit) = cache.get(cache_key) {
            return Ok((hit.values_buffer, hit.meta_buffer, hit.channel_count, 0.0));
        }
    }

    let values_size = u64::try_from(payload.values_bytes.len()).map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "GPU values payload exceeded supported limits.",
            None,
        )
    })?;
    let meta_size = u64::try_from(payload.meta_bytes.len()).map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "GPU metadata payload exceeded supported limits.",
            None,
        )
    })?;

    let values_buffer = runtime.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("lucida-gpu-layer-values"),
        size: values_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let meta_buffer = runtime.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("lucida-gpu-layer-meta"),
        size: meta_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let upload_start = Instant::now();
    runtime
        .queue
        .write_buffer(&values_buffer, 0, &payload.values_bytes);
    runtime
        .queue
        .write_buffer(&meta_buffer, 0, &payload.meta_bytes);
    let upload_ms = (Instant::now() - upload_start).as_secs_f64() * 1000.0;

    let cached = GpuCachedLayerBuffers {
        values_buffer: values_buffer.clone(),
        meta_buffer: meta_buffer.clone(),
        channel_count: payload.channel_count,
        size_bytes: values_size.saturating_add(meta_size),
    };

    let mut cache = runtime.layer_cache.lock().map_err(|_| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "gpu_render_failed",
            "Failed to lock GPU resource cache.",
            None,
        )
    })?;
    cache.configure_budget(max_gpu_cache_bytes);
    cache.insert(cache_key.to_owned(), cached);

    Ok((values_buffer, meta_buffer, payload.channel_count, upload_ms))
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
fn gpu_layer_runtime() -> Result<&'static GpuLayerCompositeRuntime, ApiError> {
    static GPU_LAYER_RUNTIME: OnceLock<Result<GpuLayerCompositeRuntime, GpuRuntimeInitError>> =
        OnceLock::new();

    match GPU_LAYER_RUNTIME.get_or_init(initialize_gpu_layer_runtime) {
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
fn initialize_gpu_layer_runtime() -> Result<GpuLayerCompositeRuntime, GpuRuntimeInitError> {
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
        label: Some("lucida-gpu-layer-composite-shader"),
        source: wgpu::ShaderSource::Wgsl(GPU_LAYER_COMPOSITE_SHADER_WGSL.into()),
    });

    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("lucida-gpu-layer-bind-group-layout"),
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
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 3,
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
        label: Some("lucida-gpu-layer-pipeline-layout"),
        bind_group_layouts: &[&bind_group_layout],
        immediate_size: 0,
    });

    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("lucida-gpu-layer-pipeline"),
        layout: Some(&pipeline_layout),
        module: &shader,
        entry_point: Some("main"),
        compilation_options: wgpu::PipelineCompilationOptions::default(),
        cache: None,
    });

    Ok(GpuLayerCompositeRuntime {
        device,
        queue,
        bind_group_layout,
        pipeline,
        layer_cache: Mutex::new(GpuBufferCache::default()),
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

#[cfg(not(feature = "gpu"))]
pub fn render_view_to_rgba_gpu(
    _dataset_summary: &DatasetSummary,
    _view_state: &ViewState,
    _output: &RenderOutputSpec,
    _cache_registry: &mut RenderCacheRegistry,
    _cache_session_id: &str,
    _cache_budgets: EffectiveCacheBudgets,
) -> Result<RenderRgbaResult, ApiError> {
    Err(ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "gpu_render_failed",
        "GPU rendering is unavailable because the daemon was built without the gpu feature.",
        None,
    ))
}
