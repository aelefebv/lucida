use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::http::StatusCode;
use image::codecs::png::{
    CompressionType as PngCompressionType, FilterType as PngFilterType, PngEncoder,
};
use image::{ColorType, ImageEncoder};
use rayon::prelude::*;
use serde_json::{json, Value};

use crate::dto::api::ApiWarning;
use crate::dto::dataset_summary::{
    AxisRole, DatasetSummary, MultiscaleImageDef, MultiscaleLevelDef,
};
use crate::dto::render::{RenderOutputSpec, RenderTimingMs, RenderTimingStagesMs};
use crate::dto::view_state::{
    AxisSelector, AxisSelectorKind, Camera2D, ChannelContrast, ChannelContrastPolicy, ChannelMode,
    InterpolationMode, LayerState, LayerType, PerformanceHints, Plane2D, SlabMode, SlabSettings,
    SliceSettings, View2D, ViewState,
};
use crate::error::ApiError;
use crate::render_cache::{EffectiveCacheBudgets, RenderCacheRegistry};
use crate::uri::file_uri_to_path;
use crate::view_state_core::plane_name;

const EPSILON: f64 = 1e-9;
const DEFAULT_CHANNEL_COLORS: [[f32; 4]; 6] = [
    [1.0, 0.0, 0.0, 1.0],
    [0.0, 1.0, 0.0, 1.0],
    [0.0, 0.0, 1.0, 1.0],
    [1.0, 1.0, 0.0, 1.0],
    [1.0, 0.0, 1.0, 1.0],
    [0.0, 1.0, 1.0, 1.0],
];
const TRIPTYCH_SIDE_RATIO_DIVISOR: usize = 5;
const TRIPTYCH_MIN_PANEL_PX: usize = 16;
const OVERLAY_TEXT_SCALE: usize = 2;

#[derive(Debug, Clone)]
pub struct RenderCpuResult {
    pub png_bytes: Vec<u8>,
    pub pyramid_level_used: u64,
    pub warnings: Vec<ApiWarning>,
    pub timing_ms: Option<RenderTimingMs>,
}

#[derive(Debug, Clone)]
pub struct RenderRgbaResult {
    pub rgba_bytes: Vec<u8>,
    pub pyramid_level_used: u64,
    pub warnings: Vec<ApiWarning>,
    pub chunk_fetch_ms: f64,
    pub chunk_decode_ms: f64,
    pub sample_ms: f64,
    pub compose_ms: f64,
    pub gpu_upload_ms: f64,
    pub gpu_compute_ms: f64,
    pub gpu_readback_ms: f64,
}

#[derive(Debug, Clone, Copy, Default)]
struct CpuStageTiming {
    chunk_fetch_ms: f64,
    chunk_decode_ms: f64,
    sample_ms: f64,
    compose_ms: f64,
    gpu_upload_ms: f64,
    gpu_compute_ms: f64,
    gpu_readback_ms: f64,
}

#[derive(Debug, Clone, Copy, Default)]
struct ChunkIoDecodeTiming {
    chunk_fetch_ms: f64,
    chunk_decode_ms: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct PlaneData {
    pub width: usize,
    pub height: usize,
    pub origin_u: i64,
    pub origin_v: i64,
    pub data: Vec<f32>,
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct LoadedArray {
    data: Vec<f32>,
    strides: Vec<usize>,
}

#[derive(Debug, Clone)]
struct ArrayStorageMetadata {
    chunk_shape: Vec<usize>,
    dtype: String,
    separator: String,
    codecs: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct SampleWindow {
    u_start: usize,
    v_start: usize,
    width: usize,
    height: usize,
}

#[derive(Debug, Clone)]
struct LevelChunkSource {
    level_path: PathBuf,
    storage_meta: ArrayStorageMetadata,
    bytes_per_value: usize,
    chunk_strides: Vec<usize>,
    cache_scope: String,
}

#[derive(Debug, Clone, Copy)]
struct PanelRect {
    x: usize,
    y: usize,
    width: usize,
    height: usize,
}

#[derive(Debug, Clone, Copy)]
struct TriptychLayout {
    xy: PanelRect,
    yz: PanelRect,
    xz: PanelRect,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TriptychPanelLayout {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TriptychLayoutDescriptor {
    pub xy: TriptychPanelLayout,
    pub yz: TriptychPanelLayout,
    pub xz: TriptychPanelLayout,
}

impl From<PanelRect> for TriptychPanelLayout {
    fn from(value: PanelRect) -> Self {
        Self {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        }
    }
}

impl From<TriptychPanelLayout> for PanelRect {
    fn from(value: TriptychPanelLayout) -> Self {
        Self {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        }
    }
}

impl From<TriptychLayout> for TriptychLayoutDescriptor {
    fn from(value: TriptychLayout) -> Self {
        Self {
            xy: value.xy.into(),
            yz: value.yz.into(),
            xz: value.xz.into(),
        }
    }
}

impl From<TriptychLayoutDescriptor> for TriptychLayout {
    fn from(value: TriptychLayoutDescriptor) -> Self {
        Self {
            xy: value.xy.into(),
            yz: value.yz.into(),
            xz: value.xz.into(),
        }
    }
}

#[derive(Debug, Clone)]
struct SinglePlaneRgbaResult {
    rgba_bytes: Vec<u8>,
    pyramid_level_used: u64,
    warnings: Vec<ApiWarning>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedLayerSamplingInput {
    pub layer: LayerState,
    pub channel_stack: Vec<PlaneData>,
    pub interpolation: InterpolationMode,
    pub f_u: f64,
    pub f_v: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedSinglePlaneLayerBatch {
    pub layers: Vec<PreparedLayerSamplingInput>,
    pub primary_level_used: Option<u64>,
    pub warnings: Vec<ApiWarning>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedSinglePlaneForExternalRenderer {
    pub background: [f32; 4],
    pub center_world: (f64, f64),
    pub zoom: f64,
    pub pixel_ratio: f64,
    pub layers: Vec<PreparedLayerSamplingInput>,
    pub primary_level_used: u64,
    pub warnings: Vec<ApiWarning>,
    pub chunk_fetch_ms: f64,
    pub chunk_decode_ms: f64,
}

#[derive(Debug, Clone)]
struct TriptychRenderResult {
    rgba_bytes: Vec<u8>,
    pyramid_level_used: u64,
    warnings: Vec<ApiWarning>,
}

#[derive(Debug, Clone, Copy)]
struct FocalPoint3D {
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Debug, Clone)]
enum TriptychRenderOutcome {
    Rendered(TriptychRenderResult),
    Fallback(TriptychFallbackReason),
}

#[derive(Debug, Clone)]
enum TriptychFallbackReason {
    MissingRoles(Vec<&'static str>),
    OutputTooSmall { width_px: usize, height_px: usize },
}

pub fn render_view_to_png(
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

pub fn render_view_to_rgba(
    dataset_summary: &DatasetSummary,
    view_state: &ViewState,
    output: &RenderOutputSpec,
    cache_registry: &mut RenderCacheRegistry,
    cache_session_id: &str,
    cache_budgets: EffectiveCacheBudgets,
) -> Result<RenderRgbaResult, ApiError> {
    cache_registry.ensure_session_budgets(cache_session_id, cache_budgets);

    let Some(view_2d) = view_state.view_2d.as_ref() else {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_mode",
            "Only mode=2d is supported for this renderer.",
            Some(json!({ "mode": "3d" })),
        ));
    };

    let mut warnings: Vec<ApiWarning> = Vec::new();
    let mut stage_timing = CpuStageTiming::default();
    let dataset_resolve_start = Instant::now();
    let dataset_root = resolve_dataset_root(&dataset_summary.uri).map_err(|reason| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "render_failed",
            "Failed to open dataset for rendering.",
            Some(json!({
                "dataset_id": dataset_summary.dataset_id,
                "reason": reason,
            })),
        )
    })?;
    stage_timing.chunk_fetch_ms += (Instant::now() - dataset_resolve_start).as_secs_f64() * 1000.0;
    let output_width = usize::try_from(output.width_px).unwrap_or(0);
    let output_height = usize::try_from(output.height_px).unwrap_or(0);

    let (rgba_u8, pyramid_level_used) = if view_2d.orthogonal_views_enabled {
        match render_triptych_rgba(
            dataset_summary,
            view_state,
            &dataset_root,
            output_width,
            output_height,
            cache_registry,
            cache_session_id,
            &mut stage_timing,
        )? {
            TriptychRenderOutcome::Rendered(result) => {
                warnings.push(ApiWarning {
                    code: "orthogonal_triptych_enabled".to_owned(),
                    message:
                        "Orthogonal tri-planar projections were rendered with fixed xy/yz/xz layout."
                            .to_owned(),
                    details: Some(json!({
                        "layout": "xy_center_yz_right_xz_top",
                    })),
                });
                warnings.extend(result.warnings);
                (result.rgba_bytes, result.pyramid_level_used)
            }
            TriptychRenderOutcome::Fallback(reason) => {
                warnings.push(triptych_fallback_warning(&reason));
                let single = render_single_plane_to_rgba(
                    dataset_summary,
                    view_state,
                    view_2d,
                    &dataset_root,
                    output_width,
                    output_height,
                    cache_registry,
                    cache_session_id,
                    &mut stage_timing,
                )?;
                warnings.extend(single.warnings);
                (single.rgba_bytes, single.pyramid_level_used)
            }
        }
    } else {
        let single = render_single_plane_to_rgba(
            dataset_summary,
            view_state,
            view_2d,
            &dataset_root,
            output_width,
            output_height,
            cache_registry,
            cache_session_id,
            &mut stage_timing,
        )?;
        warnings.extend(single.warnings);
        (single.rgba_bytes, single.pyramid_level_used)
    };

    Ok(RenderRgbaResult {
        rgba_bytes: rgba_u8,
        pyramid_level_used,
        warnings,
        chunk_fetch_ms: stage_timing.chunk_fetch_ms,
        chunk_decode_ms: stage_timing.chunk_decode_ms,
        sample_ms: stage_timing.sample_ms,
        compose_ms: stage_timing.compose_ms,
        gpu_upload_ms: stage_timing.gpu_upload_ms,
        gpu_compute_ms: stage_timing.gpu_compute_ms,
        gpu_readback_ms: stage_timing.gpu_readback_ms,
    })
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

#[allow(clippy::too_many_arguments)]
fn render_single_plane_to_rgba(
    dataset_summary: &DatasetSummary,
    view_state: &ViewState,
    view_2d: &View2D,
    dataset_root: &Path,
    output_width: usize,
    output_height: usize,
    cache_registry: &mut RenderCacheRegistry,
    cache_session_id: &str,
    stage_timing: &mut CpuStageTiming,
) -> Result<SinglePlaneRgbaResult, ApiError> {
    let role_to_axis = roles_to_axis(dataset_summary);
    let (u_role, v_role, orth_role) = plane_roles(&view_2d.plane);
    let missing_roles: Vec<&str> = [u_role, v_role, orth_role]
        .into_iter()
        .filter(|role| !role_to_axis.contains_key(*role))
        .collect();
    if !missing_roles.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_plane",
            "Requested plane is unsupported for dataset axes.",
            Some(json!({
                "plane": plane_name(&view_2d.plane),
                "missing_roles": missing_roles,
            })),
        ));
    }

    let u_axis = role_to_axis.get(u_role).expect("u axis present");
    let v_axis = role_to_axis.get(v_role).expect("v axis present");
    let orth_axis = role_to_axis.get(orth_role).expect("orth axis present");

    let selectors_by_axis: HashMap<String, &AxisSelector> = view_state
        .selectors
        .iter()
        .map(|selector| (selector.axis.clone(), selector))
        .collect();

    let slice_index = view_2d
        .slice
        .as_ref()
        .and_then(|slice| slice.index)
        .unwrap_or(0);

    let background = resolve_background_rgba(view_state);
    let pixel_count = output_width.saturating_mul(output_height);
    let mut canvas_rgb = vec![0.0_f32; pixel_count * 3];
    let mut canvas_alpha = vec![0.0_f32; pixel_count];
    canvas_rgb
        .par_chunks_mut(3)
        .zip(canvas_alpha.par_iter_mut())
        .for_each(|(rgb, alpha)| {
            rgb[0] = background[0];
            rgb[1] = background[1];
            rgb[2] = background[2];
            *alpha = background[3];
        });
    let mut layer_rgb_scratch = vec![0.0_f32; pixel_count * 3];
    let mut layer_alpha_scratch = vec![0.0_f32; pixel_count];

    let prepared_batch = prepare_single_plane_layer_batch(
        dataset_summary,
        view_state,
        view_2d,
        dataset_root,
        output_width,
        output_height,
        u_axis,
        v_axis,
        orth_axis,
        slice_index,
        &selectors_by_axis,
        cache_registry,
        cache_session_id,
        stage_timing,
    )?;
    let warnings = prepared_batch.warnings;

    for prepared_layer in &prepared_batch.layers {
        let sample_start = Instant::now();
        let (sampled_stack, sample_alpha) = sample_channel_stack(
            &prepared_layer.channel_stack,
            view_2d.camera.center_world.0,
            view_2d.camera.center_world.1,
            view_2d.camera.zoom,
            view_state.viewport.pixel_ratio,
            prepared_layer.f_u,
            prepared_layer.f_v,
            output_width,
            output_height,
            prepared_layer.interpolation.clone(),
        );
        stage_timing.sample_ms += (Instant::now() - sample_start).as_secs_f64() * 1000.0;

        compose_layer_into(
            &sampled_stack,
            &sample_alpha,
            &prepared_layer.layer,
            &mut layer_rgb_scratch,
            &mut layer_alpha_scratch,
            stage_timing,
        );
        canvas_rgb
            .par_chunks_mut(3)
            .zip(canvas_alpha.par_iter_mut())
            .zip(
                layer_rgb_scratch
                    .par_chunks(3)
                    .zip(layer_alpha_scratch.par_iter()),
            )
            .for_each(
                |((canvas_rgb_px, canvas_alpha_px), (layer_rgb_px, layer_alpha_px))| {
                    let src_alpha = (*layer_alpha_px).clamp(0.0, 1.0);
                    canvas_rgb_px[0] =
                        layer_rgb_px[0].clamp(0.0, 1.0) + (canvas_rgb_px[0] * (1.0 - src_alpha));
                    canvas_rgb_px[1] =
                        layer_rgb_px[1].clamp(0.0, 1.0) + (canvas_rgb_px[1] * (1.0 - src_alpha));
                    canvas_rgb_px[2] =
                        layer_rgb_px[2].clamp(0.0, 1.0) + (canvas_rgb_px[2] * (1.0 - src_alpha));
                    *canvas_alpha_px = src_alpha + (*canvas_alpha_px * (1.0 - src_alpha));
                },
            );
    }

    let mut rgba_u8 = vec![0_u8; pixel_count * 4];
    rgba_u8
        .par_chunks_mut(4)
        .enumerate()
        .for_each(|(index, rgba)| {
            rgba[0] = (canvas_rgb[index * 3].clamp(0.0, 1.0) * 255.0).round() as u8;
            rgba[1] = (canvas_rgb[index * 3 + 1].clamp(0.0, 1.0) * 255.0).round() as u8;
            rgba[2] = (canvas_rgb[index * 3 + 2].clamp(0.0, 1.0) * 255.0).round() as u8;
            rgba[3] = (canvas_alpha[index].clamp(0.0, 1.0) * 255.0).round() as u8;
        });

    Ok(SinglePlaneRgbaResult {
        rgba_bytes: rgba_u8,
        pyramid_level_used: prepared_batch.primary_level_used.unwrap_or(0),
        warnings,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_single_plane_for_external_renderer(
    dataset_summary: &DatasetSummary,
    view_state: &ViewState,
    view_2d: &View2D,
    output_width: usize,
    output_height: usize,
    cache_registry: &mut RenderCacheRegistry,
    cache_session_id: &str,
) -> Result<PreparedSinglePlaneForExternalRenderer, ApiError> {
    let role_to_axis = roles_to_axis(dataset_summary);
    let (u_role, v_role, orth_role) = plane_roles(&view_2d.plane);
    let missing_roles: Vec<&str> = [u_role, v_role, orth_role]
        .into_iter()
        .filter(|role| !role_to_axis.contains_key(*role))
        .collect();
    if !missing_roles.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_plane",
            "Requested plane is unsupported for dataset axes.",
            Some(json!({
                "plane": plane_name(&view_2d.plane),
                "missing_roles": missing_roles,
            })),
        ));
    }

    let u_axis = role_to_axis.get(u_role).expect("u axis present");
    let v_axis = role_to_axis.get(v_role).expect("v axis present");
    let orth_axis = role_to_axis.get(orth_role).expect("orth axis present");

    let selectors_by_axis: HashMap<String, &AxisSelector> = view_state
        .selectors
        .iter()
        .map(|selector| (selector.axis.clone(), selector))
        .collect();

    let slice_index = view_2d
        .slice
        .as_ref()
        .and_then(|slice| slice.index)
        .unwrap_or(0);
    let mut stage_timing = CpuStageTiming::default();
    let dataset_root = resolve_dataset_root(&dataset_summary.uri).map_err(|reason| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "render_failed",
            "Failed to open dataset for rendering.",
            Some(json!({
                "dataset_id": dataset_summary.dataset_id,
                "reason": reason,
            })),
        )
    })?;
    let prepared_batch = prepare_single_plane_layer_batch(
        dataset_summary,
        view_state,
        view_2d,
        &dataset_root,
        output_width,
        output_height,
        u_axis,
        v_axis,
        orth_axis,
        slice_index,
        &selectors_by_axis,
        cache_registry,
        cache_session_id,
        &mut stage_timing,
    )?;
    Ok(PreparedSinglePlaneForExternalRenderer {
        background: resolve_background_rgba(view_state),
        center_world: view_2d.camera.center_world,
        zoom: view_2d.camera.zoom,
        pixel_ratio: view_state.viewport.pixel_ratio,
        layers: prepared_batch.layers,
        primary_level_used: prepared_batch.primary_level_used.unwrap_or(0),
        warnings: prepared_batch.warnings,
        chunk_fetch_ms: stage_timing.chunk_fetch_ms,
        chunk_decode_ms: stage_timing.chunk_decode_ms,
    })
}

#[allow(clippy::too_many_arguments)]
fn prepare_single_plane_layer_batch(
    dataset_summary: &DatasetSummary,
    view_state: &ViewState,
    view_2d: &View2D,
    dataset_root: &Path,
    output_width: usize,
    output_height: usize,
    u_axis: &str,
    v_axis: &str,
    orth_axis: &str,
    slice_index: i64,
    selectors_by_axis: &HashMap<String, &AxisSelector>,
    cache_registry: &mut RenderCacheRegistry,
    cache_session_id: &str,
    stage_timing: &mut CpuStageTiming,
) -> Result<PreparedSinglePlaneLayerBatch, ApiError> {
    let mut warnings: Vec<ApiWarning> = Vec::new();
    let mut prepared_layers: Vec<PreparedLayerSamplingInput> = Vec::new();
    let mut primary_level_used: Option<u64> = None;

    for layer in &view_state.layers {
        if !layer.visible || layer.opacity <= 0.0 {
            continue;
        }

        if !matches!(layer.layer_type, LayerType::Image) {
            warnings.push(ApiWarning {
                code: "non_image_layer_ignored".to_owned(),
                message: "Only image layers are rendered in this slice.".to_owned(),
                details: Some(json!({
                    "layer_id": layer.layer_id,
                    "layer_type": layer_type_name(&layer.layer_type),
                })),
            });
            continue;
        }

        let layer_dataset_id = layer
            .dataset_id
            .clone()
            .unwrap_or_else(|| dataset_summary.dataset_id.clone());
        if layer_dataset_id != dataset_summary.dataset_id {
            warnings.push(ApiWarning {
                code: "non_image_layer_ignored".to_owned(),
                message: "Image layer dataset is not active for this render and was ignored."
                    .to_owned(),
                details: Some(json!({
                    "layer_id": layer.layer_id,
                    "dataset_id": layer_dataset_id,
                })),
            });
            continue;
        }

        let multiscale_name = resolve_layer_multiscale_name(view_state, layer);
        let multiscale = find_multiscale(dataset_summary, &multiscale_name)?;
        let (level, level_warnings) = choose_level(
            multiscale,
            view_state.performance.as_ref(),
            view_2d.camera.zoom,
            view_state.viewport.pixel_ratio,
            u_axis,
            v_axis,
        );
        warnings.extend(level_warnings);

        let open_level_start = Instant::now();
        let chunk_source = open_level_chunk_source(
            dataset_root,
            level,
            &format!(
                "{}|{}|{}",
                dataset_summary.dataset_id, multiscale.name, level.path
            ),
        )
        .map_err(|reason| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "render_failed",
                "Failed to open multiscale level source.",
                Some(json!({
                    "multiscale_name": multiscale.name,
                    "path": level.path,
                    "reason": reason,
                })),
            )
        })?;
        stage_timing.chunk_fetch_ms += (Instant::now() - open_level_start).as_secs_f64() * 1000.0;

        let slab = view_2d
            .slice
            .as_ref()
            .and_then(|slice| slice.slab.clone())
            .unwrap_or(SlabSettings {
                thickness_vox: 1,
                mode: SlabMode::Single,
            });
        let axis_index: HashMap<&str, usize> = multiscale
            .axes_order
            .iter()
            .enumerate()
            .map(|(index, name)| (name.as_str(), index))
            .collect();
        let level_factors = level_factors(multiscale, level);
        let u_idx = *axis_index.get(u_axis).ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "render_failed",
                "Display axes are missing from multiscale axes order.",
                Some(json!({
                    "multiscale_name": multiscale.name,
                    "axes_order": multiscale.axes_order,
                    "u_axis": u_axis,
                    "v_axis": v_axis,
                })),
            )
        })?;
        let v_idx = *axis_index.get(v_axis).ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "render_failed",
                "Display axes are missing from multiscale axes order.",
                Some(json!({
                    "multiscale_name": multiscale.name,
                    "axes_order": multiscale.axes_order,
                    "u_axis": u_axis,
                    "v_axis": v_axis,
                })),
            )
        })?;
        let f_u = level_factors[u_idx];
        let f_v = level_factors[v_idx];
        let interpolation = layer
            .image
            .as_ref()
            .map(|settings| settings.interpolation.clone())
            .unwrap_or(InterpolationMode::Linear);
        let sample_window = compute_sample_window(
            view_2d.camera.center_world.0,
            view_2d.camera.center_world.1,
            view_2d.camera.zoom,
            view_state.viewport.pixel_ratio,
            f_u,
            f_v,
            output_width,
            output_height,
            usize::try_from(level.shape[u_idx]).unwrap_or(0),
            usize::try_from(level.shape[v_idx]).unwrap_or(0),
        );
        let (channel_stack, layer_warnings) = extract_channel_stack(
            &chunk_source,
            cache_registry,
            cache_session_id,
            dataset_summary,
            multiscale,
            level,
            u_axis,
            v_axis,
            orth_axis,
            selectors_by_axis,
            slice_index,
            &slab,
            sample_window,
            stage_timing,
        )?;
        warnings.extend(layer_warnings);

        prepared_layers.push(PreparedLayerSamplingInput {
            layer: layer.clone(),
            channel_stack,
            interpolation,
            f_u,
            f_v,
        });
        if primary_level_used.is_none() {
            primary_level_used = Some(level.level);
        }
    }

    if prepared_layers.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "No renderable image layers were available.",
            Some(json!({ "view_id": view_state.view_id })),
        ));
    }

    Ok(PreparedSinglePlaneLayerBatch {
        layers: prepared_layers,
        primary_level_used,
        warnings,
    })
}

#[allow(clippy::too_many_arguments)]
fn render_triptych_rgba(
    dataset_summary: &DatasetSummary,
    view_state: &ViewState,
    dataset_root: &Path,
    output_width: usize,
    output_height: usize,
    cache_registry: &mut RenderCacheRegistry,
    cache_session_id: &str,
    stage_timing: &mut CpuStageTiming,
) -> Result<TriptychRenderOutcome, ApiError> {
    let Some(base_view_2d) = view_state.view_2d.as_ref() else {
        return Ok(TriptychRenderOutcome::Fallback(
            TriptychFallbackReason::MissingRoles(vec!["x", "y", "z"]),
        ));
    };

    let role_to_axis = roles_to_axis(dataset_summary);
    let missing_roles: Vec<&'static str> = ["x", "y", "z"]
        .into_iter()
        .filter(|role| !role_to_axis.contains_key(*role))
        .collect();
    if !missing_roles.is_empty() {
        return Ok(TriptychRenderOutcome::Fallback(
            TriptychFallbackReason::MissingRoles(missing_roles),
        ));
    }

    let Some(layout) = compute_triptych_layout(output_width, output_height) else {
        return Ok(TriptychRenderOutcome::Fallback(
            TriptychFallbackReason::OutputTooSmall {
                width_px: output_width,
                height_px: output_height,
            },
        ));
    };

    let selectors_by_axis: HashMap<String, &AxisSelector> = view_state
        .selectors
        .iter()
        .map(|selector| (selector.axis.clone(), selector))
        .collect();
    let focus = focal_point_from_view(base_view_2d, &role_to_axis, &selectors_by_axis);

    let xy_view = view_for_plane(base_view_2d, Plane2D::Xy, focus);
    let xz_view = view_for_plane(base_view_2d, Plane2D::Xz, focus);
    let yz_view = view_for_plane(base_view_2d, Plane2D::Yz, focus);

    let xy = render_single_plane_to_rgba(
        dataset_summary,
        view_state,
        &xy_view,
        dataset_root,
        layout.xy.width,
        layout.xy.height,
        cache_registry,
        cache_session_id,
        stage_timing,
    )?;
    let xz_raw = render_single_plane_to_rgba(
        dataset_summary,
        view_state,
        &xz_view,
        dataset_root,
        layout.xz.width,
        layout.xz.height,
        cache_registry,
        cache_session_id,
        stage_timing,
    )?;
    let yz_raw = render_single_plane_to_rgba(
        dataset_summary,
        view_state,
        &yz_view,
        dataset_root,
        layout.yz.height,
        layout.yz.width,
        cache_registry,
        cache_session_id,
        stage_timing,
    )?;

    let xz_flipped = flip_rgba_vertically(&xz_raw.rgba_bytes, layout.xz.width, layout.xz.height);
    let yz_oriented = orient_yz_panel_right(&yz_raw.rgba_bytes, layout.yz.height, layout.yz.width);

    let background = resolve_background_rgba(view_state);
    let mut canvas = rgba_canvas_with_background(output_width, output_height, background);
    blit_rgba_panel(
        &mut canvas,
        output_width,
        output_height,
        layout.xy,
        &xy.rgba_bytes,
    );
    blit_rgba_panel(
        &mut canvas,
        output_width,
        output_height,
        layout.xz,
        &xz_flipped,
    );
    blit_rgba_panel(
        &mut canvas,
        output_width,
        output_height,
        layout.yz,
        &yz_oriented,
    );
    draw_triptych_overlays(&mut canvas, output_width, output_height, layout);

    let mut warnings = xy.warnings;
    warnings.extend(xz_raw.warnings);
    warnings.extend(yz_raw.warnings);

    Ok(TriptychRenderOutcome::Rendered(TriptychRenderResult {
        rgba_bytes: canvas,
        pyramid_level_used: xy.pyramid_level_used,
        warnings,
    }))
}

fn triptych_fallback_warning(reason: &TriptychFallbackReason) -> ApiWarning {
    match reason {
        TriptychFallbackReason::MissingRoles(missing_roles) => ApiWarning {
            code: "orthogonal_triptych_fallback_single_plane".to_owned(),
            message:
                "Orthogonal tri-planar rendering was requested but required dataset roles are missing."
                    .to_owned(),
            details: Some(json!({
                "reason": "missing_roles",
                "missing_roles": missing_roles,
            })),
        },
        TriptychFallbackReason::OutputTooSmall {
            width_px,
            height_px,
        } => ApiWarning {
            code: "orthogonal_triptych_fallback_single_plane".to_owned(),
            message:
                "Orthogonal tri-planar rendering was requested but output dimensions are too small."
                    .to_owned(),
            details: Some(json!({
                "reason": "output_too_small",
                "width_px": width_px,
                "height_px": height_px,
                "minimum_panel_px": TRIPTYCH_MIN_PANEL_PX,
            })),
        },
    }
}

fn compute_triptych_layout(width: usize, height: usize) -> Option<TriptychLayout> {
    if width == 0 || height == 0 {
        return None;
    }
    let side_w = width / TRIPTYCH_SIDE_RATIO_DIVISOR;
    let side_h = height / TRIPTYCH_SIDE_RATIO_DIVISOR;
    if side_w < TRIPTYCH_MIN_PANEL_PX || side_h < TRIPTYCH_MIN_PANEL_PX {
        return None;
    }
    let xy_width = width.saturating_sub(side_w.saturating_mul(2));
    let xy_height = height.saturating_sub(side_h.saturating_mul(2));
    if xy_width < TRIPTYCH_MIN_PANEL_PX || xy_height < TRIPTYCH_MIN_PANEL_PX {
        return None;
    }

    let xy = PanelRect {
        x: side_w,
        y: side_h,
        width: xy_width,
        height: xy_height,
    };
    let yz = PanelRect {
        x: side_w + xy_width,
        y: side_h,
        width: side_w,
        height: xy_height,
    };
    let xz = PanelRect {
        x: side_w,
        y: 0,
        width: xy_width,
        height: side_h,
    };
    Some(TriptychLayout { xy, yz, xz })
}

pub(crate) fn compute_triptych_layout_descriptor(
    width: usize,
    height: usize,
) -> Option<TriptychLayoutDescriptor> {
    compute_triptych_layout(width, height).map(Into::into)
}

pub(crate) fn triptych_min_panel_px() -> usize {
    TRIPTYCH_MIN_PANEL_PX
}

fn focal_point_from_view(
    view_2d: &View2D,
    role_to_axis: &BTreeMap<&'static str, String>,
    selectors_by_axis: &HashMap<String, &AxisSelector>,
) -> FocalPoint3D {
    let (u_role, v_role, orth_role) = plane_roles(&view_2d.plane);
    let mut values: HashMap<&'static str, f64> = HashMap::new();
    values.insert(u_role, view_2d.camera.center_world.0);
    values.insert(v_role, view_2d.camera.center_world.1);

    let slice_value = view_2d
        .slice
        .as_ref()
        .and_then(|slice| slice.index)
        .map(|value| value as f64)
        .or_else(|| {
            role_to_axis
                .get(orth_role)
                .map(|axis| selector_index_for_axis(selectors_by_axis, axis) as f64)
        })
        .unwrap_or(0.0);
    values.insert(orth_role, slice_value);

    let x = values.get("x").copied().unwrap_or_else(|| {
        role_to_axis
            .get("x")
            .map(|axis| selector_index_for_axis(selectors_by_axis, axis) as f64)
            .unwrap_or(0.0)
    });
    let y = values.get("y").copied().unwrap_or_else(|| {
        role_to_axis
            .get("y")
            .map(|axis| selector_index_for_axis(selectors_by_axis, axis) as f64)
            .unwrap_or(0.0)
    });
    let z = values.get("z").copied().unwrap_or_else(|| {
        role_to_axis
            .get("z")
            .map(|axis| selector_index_for_axis(selectors_by_axis, axis) as f64)
            .unwrap_or(0.0)
    });

    FocalPoint3D { x, y, z }
}

fn selector_index_for_axis(
    selectors_by_axis: &HashMap<String, &AxisSelector>,
    axis_name: &str,
) -> i64 {
    let Some(selector) = selectors_by_axis.get(axis_name).copied() else {
        return 0;
    };
    match selector.kind {
        AxisSelectorKind::Index => selector.index.unwrap_or(0),
        AxisSelectorKind::Range => selector.start.unwrap_or(0),
        AxisSelectorKind::Set => selector
            .indices
            .as_ref()
            .and_then(|indices| indices.first().copied())
            .unwrap_or(0),
    }
}

fn view_for_plane(base: &View2D, plane: Plane2D, focus: FocalPoint3D) -> View2D {
    let (u_role, v_role, orth_role) = plane_roles(&plane);
    let slab = base.slice.as_ref().and_then(|slice| slice.slab.clone());
    View2D {
        plane,
        slice: Some(SliceSettings {
            axis: None,
            index: Some(role_value(focus, orth_role).round() as i64),
            slab,
        }),
        camera: Camera2D {
            center_world: (role_value(focus, u_role), role_value(focus, v_role)),
            zoom: base.camera.zoom,
            rotation_deg: 0.0,
        },
        orthogonal_views_enabled: base.orthogonal_views_enabled,
    }
}

fn role_value(focus: FocalPoint3D, role: &'static str) -> f64 {
    match role {
        "x" => focus.x,
        "y" => focus.y,
        "z" => focus.z,
        _ => 0.0,
    }
}

fn rgba_canvas_with_background(width: usize, height: usize, background: [f32; 4]) -> Vec<u8> {
    let pixel_count = width.saturating_mul(height);
    let mut rgba = vec![0_u8; pixel_count * 4];
    for index in 0..pixel_count {
        rgba[index * 4] = (background[0].clamp(0.0, 1.0) * 255.0).round() as u8;
        rgba[index * 4 + 1] = (background[1].clamp(0.0, 1.0) * 255.0).round() as u8;
        rgba[index * 4 + 2] = (background[2].clamp(0.0, 1.0) * 255.0).round() as u8;
        rgba[index * 4 + 3] = (background[3].clamp(0.0, 1.0) * 255.0).round() as u8;
    }
    rgba
}

fn blit_rgba_panel(
    target: &mut [u8],
    target_width: usize,
    target_height: usize,
    rect: PanelRect,
    source: &[u8],
) {
    if rect.width == 0 || rect.height == 0 {
        return;
    }
    for row in 0..rect.height {
        if rect.y + row >= target_height {
            continue;
        }
        for col in 0..rect.width {
            if rect.x + col >= target_width {
                continue;
            }
            let src_pixel = row * rect.width + col;
            let dst_pixel = (rect.y + row) * target_width + (rect.x + col);
            let src_offset = src_pixel * 4;
            let dst_offset = dst_pixel * 4;
            target[dst_offset..dst_offset + 4].copy_from_slice(&source[src_offset..src_offset + 4]);
        }
    }
}

fn flip_rgba_vertically(source: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut output = vec![0_u8; source.len()];
    for row in 0..height {
        for col in 0..width {
            let src_pixel = row * width + col;
            let dst_pixel = (height - 1 - row) * width + col;
            let src_offset = src_pixel * 4;
            let dst_offset = dst_pixel * 4;
            output[dst_offset..dst_offset + 4].copy_from_slice(&source[src_offset..src_offset + 4]);
        }
    }
    output
}

fn orient_yz_panel_right(source: &[u8], raw_width: usize, raw_height: usize) -> Vec<u8> {
    // Raw yz is rendered as (u=y, v=z). Re-orient to (horizontal=z rightward, vertical=y downward).
    let output_width = raw_height;
    let output_height = raw_width;
    let mut output = vec![0_u8; output_width.saturating_mul(output_height).saturating_mul(4)];

    for y_raw in 0..raw_height {
        for x_raw in 0..raw_width {
            let out_x = y_raw;
            let out_y = x_raw;
            let src_pixel = y_raw * raw_width + x_raw;
            let dst_pixel = out_y * output_width + out_x;
            let src_offset = src_pixel * 4;
            let dst_offset = dst_pixel * 4;
            output[dst_offset..dst_offset + 4].copy_from_slice(&source[src_offset..src_offset + 4]);
        }
    }

    output
}

fn draw_triptych_overlays(
    canvas: &mut [u8],
    canvas_width: usize,
    canvas_height: usize,
    layout: TriptychLayout,
) {
    draw_panel_overlay(
        canvas,
        canvas_width,
        canvas_height,
        layout.xy,
        "XY",
        [('X', 1, 0), ('Y', 0, -1)],
    );
    draw_panel_overlay(
        canvas,
        canvas_width,
        canvas_height,
        layout.xz,
        "XZ",
        [('X', 1, 0), ('Z', 0, -1)],
    );
    draw_panel_overlay(
        canvas,
        canvas_width,
        canvas_height,
        layout.yz,
        "YZ",
        [('Z', 1, 0), ('Y', 0, -1)],
    );
}

pub(crate) fn draw_triptych_overlays_rgba(
    canvas: &mut [u8],
    canvas_width: usize,
    canvas_height: usize,
    layout: TriptychLayoutDescriptor,
) {
    draw_triptych_overlays(canvas, canvas_width, canvas_height, layout.into());
}

fn draw_panel_overlay(
    canvas: &mut [u8],
    canvas_width: usize,
    canvas_height: usize,
    panel: PanelRect,
    panel_label: &str,
    axes: [(char, i32, i32); 2],
) {
    let border_color = [232, 232, 232, 255];
    draw_rect_outline(canvas, canvas_width, canvas_height, panel, border_color);

    let label_x = panel.x.saturating_add(4);
    let label_y = panel.y.saturating_add(4);
    draw_text(
        canvas,
        canvas_width,
        canvas_height,
        label_x,
        label_y,
        panel_label,
        border_color,
    );

    let min_dim = panel.width.min(panel.height);
    let axis_len = ((min_dim / 4).max(12)).min(36) as i32;
    let origin_x = panel.x.saturating_add(10).min(panel.x + panel.width - 2) as i32;
    let origin_y = panel
        .y
        .saturating_add(panel.height.saturating_sub(10))
        .max(panel.y + 1) as i32;

    for (axis_name, dx, dy) in axes {
        let axis_color = axis_color(axis_name);
        let tip_x = origin_x + (axis_len * dx);
        let tip_y = origin_y + (axis_len * dy);
        draw_line(
            canvas,
            canvas_width,
            canvas_height,
            origin_x,
            origin_y,
            tip_x,
            tip_y,
            axis_color,
        );
        draw_arrow_head(
            canvas,
            canvas_width,
            canvas_height,
            tip_x,
            tip_y,
            dx,
            dy,
            axis_color,
        );

        let label_w = (3 * OVERLAY_TEXT_SCALE) as i32;
        let label_h = (5 * OVERLAY_TEXT_SCALE) as i32;
        let label_x = tip_x
            + if dx > 0 {
                2
            } else if dx < 0 {
                -(label_w + 2)
            } else {
                2
            };
        let label_y = if dy < 0 {
            tip_y - (label_h + 2)
        } else if dy > 0 {
            tip_y + 2
        } else {
            // Keep horizontal-axis labels above the axis line to avoid border overlap.
            tip_y - (label_h + 1)
        };
        let pad = 3_i32;
        let min_x = panel.x as i32 + pad;
        let min_y = panel.y as i32 + pad;
        let max_x = (panel.x + panel.width) as i32 - label_w - pad;
        let max_y = (panel.y + panel.height) as i32 - label_h - pad;
        let text_x = label_x.clamp(min_x, max_x.max(min_x)) as usize;
        let text_y = label_y.clamp(min_y, max_y.max(min_y)) as usize;
        let label = match axis_name {
            'X' => "X",
            'Y' => "Y",
            'Z' => "Z",
            _ => "",
        };
        draw_text(
            canvas,
            canvas_width,
            canvas_height,
            text_x,
            text_y,
            label,
            axis_color,
        );
    }
}

fn draw_rect_outline(
    canvas: &mut [u8],
    canvas_width: usize,
    canvas_height: usize,
    rect: PanelRect,
    color: [u8; 4],
) {
    if rect.width < 2 || rect.height < 2 {
        return;
    }
    let x0 = rect.x;
    let y0 = rect.y;
    let x1 = rect.x + rect.width - 1;
    let y1 = rect.y + rect.height - 1;
    for x in x0..=x1 {
        set_rgba_pixel(
            canvas,
            canvas_width,
            canvas_height,
            x as i32,
            y0 as i32,
            color,
        );
        set_rgba_pixel(
            canvas,
            canvas_width,
            canvas_height,
            x as i32,
            y1 as i32,
            color,
        );
    }
    for y in y0..=y1 {
        set_rgba_pixel(
            canvas,
            canvas_width,
            canvas_height,
            x0 as i32,
            y as i32,
            color,
        );
        set_rgba_pixel(
            canvas,
            canvas_width,
            canvas_height,
            x1 as i32,
            y as i32,
            color,
        );
    }
}

fn axis_color(axis_name: char) -> [u8; 4] {
    match axis_name {
        'X' => [250, 90, 90, 255],
        'Y' => [90, 250, 110, 255],
        'Z' => [110, 160, 255, 255],
        _ => [232, 232, 232, 255],
    }
}

fn draw_arrow_head(
    canvas: &mut [u8],
    canvas_width: usize,
    canvas_height: usize,
    tip_x: i32,
    tip_y: i32,
    dx: i32,
    dy: i32,
    color: [u8; 4],
) {
    let head = 4;
    if dx != 0 {
        let back_x = tip_x - (dx * head);
        draw_line(
            canvas,
            canvas_width,
            canvas_height,
            tip_x,
            tip_y,
            back_x,
            tip_y - head,
            color,
        );
        draw_line(
            canvas,
            canvas_width,
            canvas_height,
            tip_x,
            tip_y,
            back_x,
            tip_y + head,
            color,
        );
        return;
    }

    let back_y = tip_y - (dy * head);
    draw_line(
        canvas,
        canvas_width,
        canvas_height,
        tip_x,
        tip_y,
        tip_x - head,
        back_y,
        color,
    );
    draw_line(
        canvas,
        canvas_width,
        canvas_height,
        tip_x,
        tip_y,
        tip_x + head,
        back_y,
        color,
    );
}

fn draw_line(
    canvas: &mut [u8],
    canvas_width: usize,
    canvas_height: usize,
    mut x0: i32,
    mut y0: i32,
    x1: i32,
    y1: i32,
    color: [u8; 4],
) {
    let dx = (x1 - x0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;

    loop {
        set_rgba_pixel(canvas, canvas_width, canvas_height, x0, y0, color);
        if x0 == x1 && y0 == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x0 += sx;
        }
        if e2 <= dx {
            err += dx;
            y0 += sy;
        }
    }
}

fn draw_text(
    canvas: &mut [u8],
    canvas_width: usize,
    canvas_height: usize,
    x: usize,
    y: usize,
    text: &str,
    color: [u8; 4],
) {
    let mut cursor_x = x;
    for ch in text.chars() {
        draw_glyph(
            canvas,
            canvas_width,
            canvas_height,
            cursor_x,
            y,
            ch.to_ascii_uppercase(),
            color,
        );
        cursor_x += (4 * OVERLAY_TEXT_SCALE) + 1;
    }
}

fn draw_glyph(
    canvas: &mut [u8],
    canvas_width: usize,
    canvas_height: usize,
    x: usize,
    y: usize,
    ch: char,
    color: [u8; 4],
) {
    let Some(rows) = glyph_rows(ch) else {
        return;
    };
    for (row_index, row_bits) in rows.iter().enumerate() {
        for col in 0..3 {
            if (row_bits & (1 << (2 - col))) == 0 {
                continue;
            }
            for sy in 0..OVERLAY_TEXT_SCALE {
                for sx in 0..OVERLAY_TEXT_SCALE {
                    let px = x + (col * OVERLAY_TEXT_SCALE) + sx;
                    let py = y + (row_index * OVERLAY_TEXT_SCALE) + sy;
                    set_rgba_pixel(
                        canvas,
                        canvas_width,
                        canvas_height,
                        px as i32,
                        py as i32,
                        color,
                    );
                }
            }
        }
    }
}

fn glyph_rows(ch: char) -> Option<[u8; 5]> {
    match ch {
        'X' => Some([0b101, 0b101, 0b010, 0b101, 0b101]),
        'Y' => Some([0b101, 0b101, 0b010, 0b010, 0b010]),
        'Z' => Some([0b111, 0b001, 0b010, 0b100, 0b111]),
        _ => None,
    }
}

fn set_rgba_pixel(
    canvas: &mut [u8],
    canvas_width: usize,
    canvas_height: usize,
    x: i32,
    y: i32,
    color: [u8; 4],
) {
    if x < 0 || y < 0 {
        return;
    }
    let x = x as usize;
    let y = y as usize;
    if x >= canvas_width || y >= canvas_height {
        return;
    }
    let offset = (y * canvas_width + x) * 4;
    canvas[offset..offset + 4].copy_from_slice(&color);
}

fn resolve_dataset_root(uri: &str) -> Result<PathBuf, String> {
    let path = file_uri_to_path(uri).ok_or_else(|| "Unsupported dataset URI scheme.".to_owned())?;
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    };
    Ok(absolute)
}

fn roles_to_axis(dataset_summary: &DatasetSummary) -> BTreeMap<&'static str, String> {
    let mut mapping: BTreeMap<&'static str, String> = BTreeMap::new();
    for axis in &dataset_summary.axes {
        let role = axis_role(axis.role.clone());
        mapping.entry(role).or_insert_with(|| axis.name.clone());
    }
    mapping
}

fn axis_role(role: AxisRole) -> &'static str {
    match role {
        AxisRole::X => "x",
        AxisRole::Y => "y",
        AxisRole::Z => "z",
        AxisRole::C => "c",
        AxisRole::T => "t",
        AxisRole::Other => "other",
    }
}

fn plane_roles(
    view_2d: &crate::dto::view_state::Plane2D,
) -> (&'static str, &'static str, &'static str) {
    match view_2d {
        crate::dto::view_state::Plane2D::Xy => ("x", "y", "z"),
        crate::dto::view_state::Plane2D::Xz => ("x", "z", "y"),
        crate::dto::view_state::Plane2D::Yz => ("y", "z", "x"),
    }
}

fn layer_type_name(layer_type: &LayerType) -> &'static str {
    match layer_type {
        LayerType::Image => "image",
        LayerType::Labels => "labels",
        LayerType::Annotations => "annotations",
    }
}

fn resolve_layer_multiscale_name(view_state: &ViewState, layer: &LayerState) -> String {
    layer
        .source
        .as_ref()
        .and_then(|source| source.multiscale_name.clone())
        .unwrap_or_else(|| view_state.datasets[0].multiscale_name.clone())
}

fn find_multiscale<'a>(
    dataset_summary: &'a DatasetSummary,
    multiscale_name: &str,
) -> Result<&'a MultiscaleImageDef, ApiError> {
    dataset_summary
        .multiscales
        .iter()
        .find(|multiscale| multiscale.name == multiscale_name)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "render_failed",
                "Multiscale for layer source was not found.",
                Some(json!({
                    "dataset_id": dataset_summary.dataset_id,
                    "multiscale_name": multiscale_name,
                })),
            )
        })
}

fn choose_level<'a>(
    multiscale: &'a MultiscaleImageDef,
    performance: Option<&PerformanceHints>,
    zoom: f64,
    pixel_ratio: f64,
    u_axis: &str,
    v_axis: &str,
) -> (&'a MultiscaleLevelDef, Vec<ApiWarning>) {
    let mut warnings: Vec<ApiWarning> = Vec::new();
    let axis_index: HashMap<&str, usize> = multiscale
        .axes_order
        .iter()
        .enumerate()
        .map(|(index, axis_name)| (axis_name.as_str(), index))
        .collect();

    let lod_mode = performance.map(|item| item.lod_mode.clone());
    let fixed_level = performance.and_then(|item| item.fixed_level);

    if let Some(lod_mode) = lod_mode {
        if matches!(lod_mode, crate::dto::view_state::LodMode::Fixed) {
            if let Some(fixed_level) = fixed_level {
                if let Some(level) = multiscale
                    .levels
                    .iter()
                    .find(|level| level.level == fixed_level)
                {
                    return (level, warnings);
                }
            }
            warnings.push(ApiWarning {
                code: "lod_level_fallback_auto".to_owned(),
                message: "Fixed LOD level was invalid; auto LOD selection was used.".to_owned(),
                details: Some(json!({
                    "requested_level": fixed_level,
                    "available_levels": multiscale.levels.iter().map(|item| item.level).collect::<Vec<u64>>(),
                    "multiscale_name": multiscale.name,
                })),
            });
        }
    }

    let mut best_level = &multiscale.levels[0];
    let mut best_metric = f64::INFINITY;
    for level in &multiscale.levels {
        let factors = level_factors(multiscale, level);
        let f_u = *axis_index
            .get(u_axis)
            .and_then(|index| factors.get(*index))
            .unwrap_or(&1.0);
        let f_v = *axis_index
            .get(v_axis)
            .and_then(|index| factors.get(*index))
            .unwrap_or(&1.0);
        let f_uv = (f_u * f_v).max(EPSILON).sqrt();
        let metric = (f_uv * zoom * pixel_ratio).max(EPSILON).log2().abs();
        if metric < best_metric {
            best_metric = metric;
            best_level = level;
        }
    }

    (best_level, warnings)
}

fn level_factors(multiscale: &MultiscaleImageDef, level: &MultiscaleLevelDef) -> Vec<f64> {
    if let Some(downsample_factors) = level.downsample_factors.as_ref() {
        if downsample_factors.len() == multiscale.axes_order.len() {
            return downsample_factors
                .iter()
                .map(|value| value.max(1.0))
                .collect::<Vec<f64>>();
        }
    }

    let base_shape = &multiscale.levels[0].shape;
    base_shape
        .iter()
        .zip(level.shape.iter())
        .map(|(base_size, level_size)| {
            if *level_size == 0 {
                1.0
            } else {
                ((*base_size as f64) / (*level_size as f64)).max(1.0)
            }
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn extract_channel_stack(
    source: &LevelChunkSource,
    cache_registry: &mut RenderCacheRegistry,
    cache_session_id: &str,
    dataset_summary: &DatasetSummary,
    multiscale: &MultiscaleImageDef,
    level: &MultiscaleLevelDef,
    u_axis: &str,
    v_axis: &str,
    orth_axis: &str,
    selectors_by_axis: &HashMap<String, &AxisSelector>,
    slice_index: i64,
    slab: &SlabSettings,
    sample_window: SampleWindow,
    stage_timing: &mut CpuStageTiming,
) -> Result<(Vec<PlaneData>, Vec<ApiWarning>), ApiError> {
    let mut warnings: Vec<ApiWarning> = Vec::new();
    let axis_index: HashMap<&str, usize> = multiscale
        .axes_order
        .iter()
        .enumerate()
        .map(|(index, axis_name)| (axis_name.as_str(), index))
        .collect();
    let axes_by_name: HashMap<&str, u64> = dataset_summary
        .axes
        .iter()
        .map(|axis| (axis.name.as_str(), axis.size))
        .collect();
    let c_axis_name = dataset_summary
        .axes
        .iter()
        .find(|axis| matches!(axis.role, AxisRole::C))
        .map(|axis| axis.name.clone());

    let orth_size = *axes_by_name.get(orth_axis).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Orthogonal axis is missing from dataset summary.",
            Some(json!({ "axis": orth_axis })),
        )
    })?;
    let orth_selector = selectors_by_axis.get(orth_axis).copied();
    let (orth_indices_base, explicit_span, orth_warnings) =
        orthogonal_indices(orth_axis, orth_size, orth_selector, slice_index, slab);
    warnings.extend(orth_warnings);

    let orth_idx = *axis_index.get(orth_axis).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Display axes are missing from multiscale axes order.",
            Some(json!({
                "multiscale_name": multiscale.name,
                "axes_order": multiscale.axes_order,
                "u_axis": u_axis,
                "v_axis": v_axis,
            })),
        )
    })?;
    let factors = level_factors(multiscale, level);
    let orth_factor = factors[orth_idx];
    let mut orth_indices_level: Vec<usize> = orth_indices_base
        .into_iter()
        .map(|value| clamp_index_usize(to_level_index(value, orth_factor), level.shape[orth_idx]))
        .collect();
    orth_indices_level.sort_unstable();
    orth_indices_level.dedup();
    if orth_indices_level.is_empty() {
        orth_indices_level.push(0);
    }

    if explicit_span {
        warnings.push(ApiWarning {
            code: "slab_thickness_ignored".to_owned(),
            message:
                "Slab thickness was ignored because orthogonal selector explicitly defines span."
                    .to_owned(),
            details: Some(json!({
                "axis": orth_axis,
                "thickness_vox": slab.thickness_vox,
            })),
        });
    }

    let mut fixed_indices_level: Vec<usize> = vec![0; multiscale.axes_order.len()];
    for axis_name in &multiscale.axes_order {
        if axis_name == u_axis || axis_name == v_axis || axis_name == orth_axis {
            continue;
        }
        if let Some(c_axis_name) = c_axis_name.as_ref() {
            if axis_name == c_axis_name {
                continue;
            }
        }

        let selector = selectors_by_axis.get(axis_name).copied();
        let base_index = if let Some(selector) = selector {
            match selector.kind {
                AxisSelectorKind::Index => selector.index.unwrap_or(0),
                AxisSelectorKind::Range => {
                    let index = selector.start.unwrap_or(0);
                    warnings.push(ApiWarning {
                        code: "selector_reduced_to_index".to_owned(),
                        message:
                            "Range selector was reduced to its first index for non-display axis."
                                .to_owned(),
                        details: Some(json!({
                            "axis": axis_name,
                            "kind": "range",
                            "index": index,
                        })),
                    });
                    index
                }
                AxisSelectorKind::Set => {
                    let index = selector
                        .indices
                        .as_ref()
                        .and_then(|indices| indices.first().copied())
                        .unwrap_or(0);
                    warnings.push(ApiWarning {
                        code: "selector_reduced_to_index".to_owned(),
                        message:
                            "Set selector was reduced to its first index for non-display axis."
                                .to_owned(),
                        details: Some(json!({
                            "axis": axis_name,
                            "kind": "set",
                            "index": index,
                        })),
                    });
                    index
                }
            }
        } else {
            0
        };

        let axis_idx = *axis_index.get(axis_name.as_str()).ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "render_failed",
                "Display axes are missing from multiscale axes order.",
                Some(json!({
                    "multiscale_name": multiscale.name,
                    "axes_order": multiscale.axes_order,
                    "u_axis": u_axis,
                    "v_axis": v_axis,
                })),
            )
        })?;
        let level_index = clamp_index_usize(
            to_level_index(base_index, factors[axis_idx]),
            level.shape[axis_idx],
        );
        fixed_indices_level[axis_idx] = level_index;
    }

    let u_idx = *axis_index.get(u_axis).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Display axes are missing from multiscale axes order.",
            Some(json!({
                "multiscale_name": multiscale.name,
                "axes_order": multiscale.axes_order,
                "u_axis": u_axis,
                "v_axis": v_axis,
            })),
        )
    })?;
    let v_idx = *axis_index.get(v_axis).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Display axes are missing from multiscale axes order.",
            Some(json!({
                "multiscale_name": multiscale.name,
                "axes_order": multiscale.axes_order,
                "u_axis": u_axis,
                "v_axis": v_axis,
            })),
        )
    })?;
    let u_size = usize::try_from(level.shape[u_idx]).unwrap_or(0);
    let v_size = usize::try_from(level.shape[v_idx]).unwrap_or(0);
    let u_origin = sample_window.u_start.min(u_size.saturating_sub(1));
    let v_origin = sample_window.v_start.min(v_size.saturating_sub(1));
    let u_window = sample_window
        .width
        .max(1)
        .min(u_size.saturating_sub(u_origin));
    let v_window = sample_window
        .height
        .max(1)
        .min(v_size.saturating_sub(v_origin));
    let origin_u_i64 = i64::try_from(u_origin).unwrap_or(i64::MAX);
    let origin_v_i64 = i64::try_from(v_origin).unwrap_or(i64::MAX);

    let c_axis_idx = c_axis_name
        .as_ref()
        .and_then(|axis_name| axis_index.get(axis_name.as_str()).copied());
    let channel_count = c_axis_idx
        .and_then(|index| level.shape.get(index).copied())
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(1);

    let mut base_indices = vec![0_usize; multiscale.axes_order.len()];
    for (axis_pos, axis_name) in multiscale.axes_order.iter().enumerate() {
        if axis_name == u_axis || axis_name == v_axis || axis_name == orth_axis {
            continue;
        }
        if c_axis_name.as_ref() == Some(axis_name) {
            continue;
        }
        base_indices[axis_pos] = fixed_indices_level[axis_pos];
    }

    let rank = multiscale.axes_order.len();
    let mut fixed_chunk_indices = vec![0_usize; rank];
    let mut fixed_local_indices = vec![0_usize; rank];
    for axis_pos in 0..rank {
        let chunk_size = source.storage_meta.chunk_shape[axis_pos].max(1);
        let axis_value = base_indices[axis_pos];
        fixed_chunk_indices[axis_pos] = axis_value / chunk_size;
        fixed_local_indices[axis_pos] = axis_value % chunk_size;
    }

    let chunk_u = source.storage_meta.chunk_shape[u_idx].max(1);
    let chunk_v = source.storage_meta.chunk_shape[v_idx].max(1);
    let chunk_orth = source.storage_meta.chunk_shape[orth_idx].max(1);
    let chunk_c = if let Some(c_axis_idx) = c_axis_idx {
        source.storage_meta.chunk_shape[c_axis_idx].max(1)
    } else {
        1
    };
    let u_stride = source.chunk_strides[u_idx];
    let v_stride = source.chunk_strides[v_idx];

    let mut slab_planes: Vec<Vec<PlaneData>> = Vec::with_capacity(orth_indices_level.len());
    for orth_index in orth_indices_level {
        let mut channels: Vec<PlaneData> = Vec::with_capacity(channel_count);
        let orth_chunk_index = orth_index / chunk_orth;
        let orth_local = orth_index % chunk_orth;
        for channel_index in 0..channel_count {
            let mut plane_values = vec![0.0_f32; v_window * u_window];
            let c_chunk_index = if c_axis_idx.is_some() {
                channel_index / chunk_c
            } else {
                0
            };
            let c_local = if c_axis_idx.is_some() {
                channel_index % chunk_c
            } else {
                0
            };

            let u_chunk_start = u_origin / chunk_u;
            let u_chunk_end = (u_origin + u_window - 1) / chunk_u;
            let v_chunk_start = v_origin / chunk_v;
            let v_chunk_end = (v_origin + v_window - 1) / chunk_v;

            for v_chunk_index in v_chunk_start..=v_chunk_end {
                for u_chunk_index in u_chunk_start..=u_chunk_end {
                    let mut chunk_index = fixed_chunk_indices.clone();
                    chunk_index[orth_idx] = orth_chunk_index;
                    chunk_index[u_idx] = u_chunk_index;
                    chunk_index[v_idx] = v_chunk_index;
                    if let Some(c_axis_idx) = c_axis_idx {
                        chunk_index[c_axis_idx] = c_chunk_index;
                    }

                    let mut io_timing = ChunkIoDecodeTiming::default();
                    let decoded_chunk = source
                        .decoded_chunk(
                            &chunk_index,
                            cache_registry,
                            cache_session_id,
                            &mut io_timing,
                        )
                        .map_err(|reason| {
                            ApiError::new(
                                StatusCode::UNPROCESSABLE_ENTITY,
                                "render_failed",
                                "Failed to decode required chunk data.",
                                Some(json!({
                                    "multiscale_name": multiscale.name,
                                    "path": level.path,
                                    "reason": reason,
                                })),
                            )
                        })?;
                    stage_timing.chunk_fetch_ms += io_timing.chunk_fetch_ms;
                    stage_timing.chunk_decode_ms += io_timing.chunk_decode_ms;

                    if decoded_chunk.is_empty() {
                        continue;
                    }

                    let chunk_u_start = u_chunk_index * chunk_u;
                    let chunk_u_end_exclusive = (chunk_u_start + chunk_u)
                        .min(usize::try_from(level.shape[u_idx]).unwrap_or(0));
                    let chunk_v_start = v_chunk_index * chunk_v;
                    let chunk_v_end_exclusive = (chunk_v_start + chunk_v)
                        .min(usize::try_from(level.shape[v_idx]).unwrap_or(0));
                    let copy_u_start = u_origin.max(chunk_u_start);
                    let copy_u_end_exclusive = (u_origin + u_window).min(chunk_u_end_exclusive);
                    let copy_v_start = v_origin.max(chunk_v_start);
                    let copy_v_end_exclusive = (v_origin + v_window).min(chunk_v_end_exclusive);
                    if copy_u_start >= copy_u_end_exclusive || copy_v_start >= copy_v_end_exclusive
                    {
                        continue;
                    }

                    let mut linear_base = 0usize;
                    for axis_pos in 0..rank {
                        if axis_pos == u_idx || axis_pos == v_idx {
                            continue;
                        }
                        let local_index = if axis_pos == orth_idx {
                            orth_local
                        } else if Some(axis_pos) == c_axis_idx {
                            c_local
                        } else {
                            fixed_local_indices[axis_pos]
                        };
                        linear_base = linear_base.saturating_add(
                            local_index.saturating_mul(source.chunk_strides[axis_pos]),
                        );
                    }

                    for global_v in copy_v_start..copy_v_end_exclusive {
                        let local_v = global_v - chunk_v_start;
                        let row_linear =
                            linear_base.saturating_add(local_v.saturating_mul(v_stride));
                        let dst_row = (global_v - v_origin) * u_window;
                        for global_u in copy_u_start..copy_u_end_exclusive {
                            let local_u = global_u - chunk_u_start;
                            let linear =
                                row_linear.saturating_add(local_u.saturating_mul(u_stride));
                            let byte_offset = linear.saturating_mul(source.bytes_per_value);
                            let value = decode_value(
                                &decoded_chunk,
                                &source.storage_meta.dtype,
                                byte_offset,
                            )
                            .unwrap_or(0.0);
                            let dst_index = dst_row + (global_u - u_origin);
                            plane_values[dst_index] = value;
                        }
                    }
                }
            }
            channels.push(PlaneData {
                width: u_window,
                height: v_window,
                origin_u: origin_u_i64,
                origin_v: origin_v_i64,
                data: plane_values,
            });
        }
        slab_planes.push(channels);
    }

    if slab_planes.is_empty() {
        slab_planes.push(vec![PlaneData {
            width: u_window,
            height: v_window,
            origin_u: origin_u_i64,
            origin_v: origin_v_i64,
            data: vec![0.0; u_window * v_window],
        }]);
    }

    let combined = match slab.mode {
        SlabMode::Single => slab_planes[0].clone(),
        SlabMode::Mip => reduce_slab_max(&slab_planes),
        SlabMode::Mean => reduce_slab_mean(&slab_planes),
    };

    Ok((combined, warnings))
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn extract_channel_stack_loaded_array(
    array: &LoadedArray,
    dataset_summary: &DatasetSummary,
    multiscale: &MultiscaleImageDef,
    level: &MultiscaleLevelDef,
    u_axis: &str,
    v_axis: &str,
    orth_axis: &str,
    selectors_by_axis: &HashMap<String, &AxisSelector>,
    slice_index: i64,
    slab: &SlabSettings,
) -> Result<(Vec<PlaneData>, Vec<ApiWarning>), ApiError> {
    let mut warnings: Vec<ApiWarning> = Vec::new();
    let axis_index: HashMap<&str, usize> = multiscale
        .axes_order
        .iter()
        .enumerate()
        .map(|(index, axis_name)| (axis_name.as_str(), index))
        .collect();
    let axes_by_name: HashMap<&str, u64> = dataset_summary
        .axes
        .iter()
        .map(|axis| (axis.name.as_str(), axis.size))
        .collect();
    let c_axis_name = dataset_summary
        .axes
        .iter()
        .find(|axis| matches!(axis.role, AxisRole::C))
        .map(|axis| axis.name.clone());

    let orth_size = *axes_by_name.get(orth_axis).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Orthogonal axis is missing from dataset summary.",
            Some(json!({ "axis": orth_axis })),
        )
    })?;
    let orth_selector = selectors_by_axis.get(orth_axis).copied();
    let (orth_indices_base, explicit_span, orth_warnings) =
        orthogonal_indices(orth_axis, orth_size, orth_selector, slice_index, slab);
    warnings.extend(orth_warnings);

    let orth_idx = *axis_index.get(orth_axis).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Display axes are missing from multiscale axes order.",
            Some(json!({
                "multiscale_name": multiscale.name,
                "axes_order": multiscale.axes_order,
                "u_axis": u_axis,
                "v_axis": v_axis,
            })),
        )
    })?;
    let factors = level_factors(multiscale, level);
    let orth_factor = factors[orth_idx];
    let mut orth_indices_level: Vec<usize> = orth_indices_base
        .into_iter()
        .map(|value| clamp_index_usize(to_level_index(value, orth_factor), level.shape[orth_idx]))
        .collect();
    orth_indices_level.sort_unstable();
    orth_indices_level.dedup();
    if orth_indices_level.is_empty() {
        orth_indices_level.push(0);
    }

    if explicit_span {
        warnings.push(ApiWarning {
            code: "slab_thickness_ignored".to_owned(),
            message:
                "Slab thickness was ignored because orthogonal selector explicitly defines span."
                    .to_owned(),
            details: Some(json!({
                "axis": orth_axis,
                "thickness_vox": slab.thickness_vox,
            })),
        });
    }

    let mut fixed_indices_level: Vec<usize> = vec![0; multiscale.axes_order.len()];
    for axis_name in &multiscale.axes_order {
        if axis_name == u_axis || axis_name == v_axis || axis_name == orth_axis {
            continue;
        }
        if let Some(c_axis_name) = c_axis_name.as_ref() {
            if axis_name == c_axis_name {
                continue;
            }
        }

        let selector = selectors_by_axis.get(axis_name).copied();
        let base_index = if let Some(selector) = selector {
            match selector.kind {
                AxisSelectorKind::Index => selector.index.unwrap_or(0),
                AxisSelectorKind::Range => {
                    let index = selector.start.unwrap_or(0);
                    warnings.push(ApiWarning {
                        code: "selector_reduced_to_index".to_owned(),
                        message:
                            "Range selector was reduced to its first index for non-display axis."
                                .to_owned(),
                        details: Some(json!({
                            "axis": axis_name,
                            "kind": "range",
                            "index": index,
                        })),
                    });
                    index
                }
                AxisSelectorKind::Set => {
                    let index = selector
                        .indices
                        .as_ref()
                        .and_then(|indices| indices.first().copied())
                        .unwrap_or(0);
                    warnings.push(ApiWarning {
                        code: "selector_reduced_to_index".to_owned(),
                        message:
                            "Set selector was reduced to its first index for non-display axis."
                                .to_owned(),
                        details: Some(json!({
                            "axis": axis_name,
                            "kind": "set",
                            "index": index,
                        })),
                    });
                    index
                }
            }
        } else {
            0
        };

        let axis_idx = *axis_index.get(axis_name.as_str()).ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "render_failed",
                "Display axes are missing from multiscale axes order.",
                Some(json!({
                    "multiscale_name": multiscale.name,
                    "axes_order": multiscale.axes_order,
                    "u_axis": u_axis,
                    "v_axis": v_axis,
                })),
            )
        })?;
        let level_index = clamp_index_usize(
            to_level_index(base_index, factors[axis_idx]),
            level.shape[axis_idx],
        );
        fixed_indices_level[axis_idx] = level_index;
    }

    let u_idx = *axis_index.get(u_axis).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Display axes are missing from multiscale axes order.",
            Some(json!({
                "multiscale_name": multiscale.name,
                "axes_order": multiscale.axes_order,
                "u_axis": u_axis,
                "v_axis": v_axis,
            })),
        )
    })?;
    let v_idx = *axis_index.get(v_axis).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Display axes are missing from multiscale axes order.",
            Some(json!({
                "multiscale_name": multiscale.name,
                "axes_order": multiscale.axes_order,
                "u_axis": u_axis,
                "v_axis": v_axis,
            })),
        )
    })?;
    let u_size = usize::try_from(level.shape[u_idx]).unwrap_or(0);
    let v_size = usize::try_from(level.shape[v_idx]).unwrap_or(0);

    let c_axis_idx = c_axis_name
        .as_ref()
        .and_then(|axis_name| axis_index.get(axis_name.as_str()).copied());
    let channel_count = c_axis_idx
        .and_then(|index| level.shape.get(index).copied())
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(1);

    let u_stride = array.strides[u_idx];
    let v_stride = array.strides[v_idx];
    let orth_stride = array.strides[orth_idx];
    let c_stride = c_axis_idx.map(|index| array.strides[index]);

    let fixed_offset = fixed_indices_level
        .iter()
        .enumerate()
        .filter(|(axis_pos, _)| {
            *axis_pos != u_idx
                && *axis_pos != v_idx
                && *axis_pos != orth_idx
                && Some(*axis_pos) != c_axis_idx
        })
        .fold(0usize, |acc, (axis_pos, fixed_index)| {
            acc.saturating_add(fixed_index.saturating_mul(array.strides[axis_pos]))
        });

    let mut slab_planes: Vec<Vec<PlaneData>> = Vec::with_capacity(orth_indices_level.len());
    for orth_index in orth_indices_level {
        let orth_offset = orth_index.saturating_mul(orth_stride);
        let mut channels: Vec<PlaneData> = Vec::with_capacity(channel_count);
        for channel_index in 0..channel_count {
            let channel_offset = c_stride
                .map(|stride| channel_index.saturating_mul(stride))
                .unwrap_or(0);
            let base_offset = fixed_offset
                .saturating_add(orth_offset)
                .saturating_add(channel_offset);
            let mut plane_values = vec![0.0_f32; v_size * u_size];
            for v in 0..v_size {
                let row_offset = base_offset.saturating_add(v.saturating_mul(v_stride));
                for u in 0..u_size {
                    let linear = row_offset.saturating_add(u.saturating_mul(u_stride));
                    plane_values[v * u_size + u] = array.data[linear];
                }
            }
            channels.push(PlaneData {
                width: u_size,
                height: v_size,
                origin_u: 0,
                origin_v: 0,
                data: plane_values,
            });
        }
        slab_planes.push(channels);
    }

    if slab_planes.is_empty() {
        slab_planes.push(vec![PlaneData {
            width: u_size,
            height: v_size,
            origin_u: 0,
            origin_v: 0,
            data: vec![0.0; u_size * v_size],
        }]);
    }

    let combined = match slab.mode {
        SlabMode::Single => slab_planes[0].clone(),
        SlabMode::Mip => reduce_slab_max(&slab_planes),
        SlabMode::Mean => reduce_slab_mean(&slab_planes),
    };

    Ok((combined, warnings))
}

fn reduce_slab_max(slab_planes: &[Vec<PlaneData>]) -> Vec<PlaneData> {
    let mut out = slab_planes[0].clone();
    for planes in slab_planes.iter().skip(1) {
        for (channel_index, plane) in planes.iter().enumerate() {
            for pixel in 0..plane.data.len() {
                out[channel_index].data[pixel] =
                    out[channel_index].data[pixel].max(plane.data[pixel]);
            }
        }
    }
    out
}

fn reduce_slab_mean(slab_planes: &[Vec<PlaneData>]) -> Vec<PlaneData> {
    let mut out = slab_planes[0].clone();
    for channel in &mut out {
        for pixel in &mut channel.data {
            *pixel = 0.0;
        }
    }
    let divisor = slab_planes.len() as f32;
    for planes in slab_planes {
        for (channel_index, plane) in planes.iter().enumerate() {
            for pixel in 0..plane.data.len() {
                out[channel_index].data[pixel] += plane.data[pixel] / divisor;
            }
        }
    }
    out
}

fn orthogonal_indices(
    _axis_name: &str,
    axis_size: u64,
    selector: Option<&AxisSelector>,
    slice_index: i64,
    slab: &SlabSettings,
) -> (Vec<i64>, bool, Vec<ApiWarning>) {
    let warnings: Vec<ApiWarning> = Vec::new();
    let mut explicit_span = false;
    let axis_size_i64 = i64::try_from(axis_size).unwrap_or(i64::MAX);

    if selector.is_none() {
        return (
            vec![clamp_index_i64(slice_index, axis_size_i64)],
            explicit_span,
            warnings,
        );
    }

    let selector = selector.expect("selector present");
    let mut base_indices = match selector.kind {
        AxisSelectorKind::Index => {
            vec![clamp_index_i64(selector.index.unwrap_or(0), axis_size_i64)]
        }
        AxisSelectorKind::Range => {
            explicit_span = true;
            let start = selector.start.unwrap_or(0);
            let end = selector.end_exclusive.unwrap_or(start + 1);
            (start..end).collect::<Vec<i64>>()
        }
        AxisSelectorKind::Set => {
            explicit_span = true;
            let mut values = selector.indices.clone().unwrap_or_default();
            values.sort_unstable();
            values.dedup();
            values
        }
    };

    if base_indices.is_empty() {
        base_indices.push(0);
    }

    if explicit_span {
        if matches!(slab.mode, SlabMode::Single) {
            return (vec![base_indices[0]], explicit_span, warnings);
        }
        return (base_indices, explicit_span, warnings);
    }

    if matches!(slab.mode, SlabMode::Single) {
        return (base_indices, explicit_span, warnings);
    }

    (
        centered_window(
            base_indices[0],
            i64::try_from(slab.thickness_vox).unwrap_or(1).max(1),
            axis_size_i64,
        ),
        explicit_span,
        warnings,
    )
}

fn centered_window(center: i64, thickness: i64, axis_size: i64) -> Vec<i64> {
    if thickness <= 1 {
        return vec![clamp_index_i64(center, axis_size)];
    }

    let mut start = center - ((thickness - 1) / 2);
    let mut end = start + thickness;

    if start < 0 {
        end += -start;
        start = 0;
    }
    if end > axis_size {
        start -= end - axis_size;
        end = axis_size;
    }
    if start < 0 {
        start = 0;
    }

    if start >= end {
        return vec![clamp_index_i64(center, axis_size)];
    }

    (start..end).collect::<Vec<i64>>()
}

fn clamp_index_i64(index: i64, axis_size: i64) -> i64 {
    if axis_size <= 1 {
        return 0;
    }
    index.max(0).min(axis_size - 1)
}

fn clamp_index_usize(index: i64, axis_size: u64) -> usize {
    if axis_size <= 1 {
        return 0;
    }
    usize::try_from(clamp_index_i64(
        index,
        i64::try_from(axis_size).unwrap_or(i64::MAX),
    ))
    .unwrap_or(0)
}

fn to_level_index(index: i64, factor: f64) -> i64 {
    if factor <= 0.0 {
        return index;
    }
    ((index as f64) / factor).round() as i64
}

#[allow(clippy::too_many_arguments)]
fn compute_sample_window(
    center_u: f64,
    center_v: f64,
    zoom: f64,
    pixel_ratio: f64,
    f_u: f64,
    f_v: f64,
    output_width: usize,
    output_height: usize,
    level_u_size: usize,
    level_v_size: usize,
) -> SampleWindow {
    if level_u_size == 0 || level_v_size == 0 {
        return SampleWindow {
            u_start: 0,
            v_start: 0,
            width: 0,
            height: 0,
        };
    }

    let zoom_safe = zoom.max(1e-6);
    let pixel_ratio_safe = pixel_ratio.max(0.5);
    let f_u_safe = f_u.max(1e-6);
    let f_v_safe = f_v.max(1e-6);

    let span_u = (output_width as f64) / (zoom_safe * pixel_ratio_safe * f_u_safe);
    let span_v = (output_height as f64) / (zoom_safe * pixel_ratio_safe * f_v_safe);
    let center_u_level = center_u / f_u_safe;
    let center_v_level = center_v / f_v_safe;
    let start_u = center_u_level - (span_u / 2.0);
    let start_v = center_v_level - (span_v / 2.0);
    let end_u = start_u + span_u;
    let end_v = start_v + span_v;

    let min_u = (start_u.floor() as i64).saturating_sub(1);
    let min_v = (start_v.floor() as i64).saturating_sub(1);
    let max_u = (end_u.ceil() as i64).saturating_add(1);
    let max_v = (end_v.ceil() as i64).saturating_add(1);

    let u_axis_size_i64 = i64::try_from(level_u_size).unwrap_or(i64::MAX);
    let v_axis_size_i64 = i64::try_from(level_v_size).unwrap_or(i64::MAX);
    let u_start = usize::try_from(clamp_index_i64(min_u, u_axis_size_i64)).unwrap_or(0);
    let v_start = usize::try_from(clamp_index_i64(min_v, v_axis_size_i64)).unwrap_or(0);
    let u_end = usize::try_from(clamp_index_i64(max_u, u_axis_size_i64)).unwrap_or(u_start);
    let v_end = usize::try_from(clamp_index_i64(max_v, v_axis_size_i64)).unwrap_or(v_start);

    SampleWindow {
        u_start,
        v_start,
        width: u_end.saturating_sub(u_start).saturating_add(1),
        height: v_end.saturating_sub(v_start).saturating_add(1),
    }
}

#[allow(clippy::too_many_arguments)]
fn sample_channel_stack(
    stack: &[PlaneData],
    center_u: f64,
    center_v: f64,
    zoom: f64,
    pixel_ratio: f64,
    f_u: f64,
    f_v: f64,
    output_width: usize,
    output_height: usize,
    interpolation: InterpolationMode,
) -> (Vec<Vec<f32>>, Vec<f32>) {
    let mut sampled_channels: Vec<Vec<f32>> = Vec::new();
    let mut sample_alpha = vec![0.0_f32; output_width * output_height];

    for plane in stack {
        let (sampled, alpha) = sample_plane(
            plane,
            center_u,
            center_v,
            zoom,
            pixel_ratio,
            f_u,
            f_v,
            output_width,
            output_height,
            interpolation.clone(),
        );
        sample_alpha
            .par_iter_mut()
            .zip(alpha.par_iter())
            .for_each(|(dst, src)| {
                *dst = (*dst).max(*src);
            });
        sampled_channels.push(sampled);
    }

    (sampled_channels, sample_alpha)
}

#[allow(clippy::too_many_arguments)]
fn sample_plane(
    plane: &PlaneData,
    center_u: f64,
    center_v: f64,
    zoom: f64,
    pixel_ratio: f64,
    f_u: f64,
    f_v: f64,
    output_width: usize,
    output_height: usize,
    interpolation: InterpolationMode,
) -> (Vec<f32>, Vec<f32>) {
    let src_h = plane.height as i64;
    let src_w = plane.width as i64;
    let mut sampled = vec![0.0_f32; output_width * output_height];
    let mut alpha = vec![0.0_f32; output_width * output_height];

    let zoom_safe = zoom.max(1e-6);
    let pixel_ratio_safe = pixel_ratio.max(0.5);
    let f_u_safe = f_u.max(1e-6);
    let f_v_safe = f_v.max(1e-6);

    let span_u = (output_width as f64) / (zoom_safe * pixel_ratio_safe * f_u_safe);
    let span_v = (output_height as f64) / (zoom_safe * pixel_ratio_safe * f_v_safe);

    let center_u_level = (center_u / f_u_safe) - (plane.origin_u as f64);
    let center_v_level = (center_v / f_v_safe) - (plane.origin_v as f64);

    let start_u = center_u_level - (span_u / 2.0);
    let start_v = center_v_level - (span_v / 2.0);

    let step_u = span_u / (output_width as f64);
    let step_v = span_v / (output_height as f64);

    match interpolation {
        InterpolationMode::Nearest => {
            sampled
                .par_chunks_mut(output_width)
                .zip(alpha.par_chunks_mut(output_width))
                .enumerate()
                .for_each(|(y, (sampled_row, alpha_row))| {
                    let v_coord = start_v + ((y as f64) + 0.5) * step_v;
                    let v_idx = v_coord.floor() as i64;
                    let valid_v = v_idx >= 0 && v_idx < src_h;
                    let v_clamped = clamp_index_i64(v_idx, src_h) as usize;
                    for x in 0..output_width {
                        let u_coord = start_u + ((x as f64) + 0.5) * step_u;
                        let u_idx = u_coord.floor() as i64;
                        let valid_u = u_idx >= 0 && u_idx < src_w;
                        if valid_u && valid_v {
                            let u_clamped = clamp_index_i64(u_idx, src_w) as usize;
                            sampled_row[x] = plane.data[v_clamped * plane.width + u_clamped];
                            alpha_row[x] = 1.0;
                        }
                    }
                });
        }
        InterpolationMode::Linear => {
            sampled
                .par_chunks_mut(output_width)
                .zip(alpha.par_chunks_mut(output_width))
                .enumerate()
                .for_each(|(y, (sampled_row, alpha_row))| {
                    let v_coord = start_v + ((y as f64) + 0.5) * step_v;
                    let v0 = v_coord.floor() as i64;
                    let v1 = v0 + 1;
                    let dv = (v_coord - (v0 as f64)) as f32;
                    let valid_v = v_coord >= 0.0 && v_coord <= ((src_h - 1) as f64);
                    let v0c = clamp_index_i64(v0, src_h) as usize;
                    let v1c = clamp_index_i64(v1, src_h) as usize;

                    for x in 0..output_width {
                        let u_coord = start_u + ((x as f64) + 0.5) * step_u;
                        let u0 = u_coord.floor() as i64;
                        let u1 = u0 + 1;
                        let du = (u_coord - (u0 as f64)) as f32;
                        let valid_u = u_coord >= 0.0 && u_coord <= ((src_w - 1) as f64);
                        if !(valid_u && valid_v) {
                            continue;
                        }

                        let u0c = clamp_index_i64(u0, src_w) as usize;
                        let u1c = clamp_index_i64(u1, src_w) as usize;

                        let s00 = plane.data[v0c * plane.width + u0c];
                        let s01 = plane.data[v0c * plane.width + u1c];
                        let s10 = plane.data[v1c * plane.width + u0c];
                        let s11 = plane.data[v1c * plane.width + u1c];

                        let w00 = (1.0 - dv) * (1.0 - du);
                        let w01 = (1.0 - dv) * du;
                        let w10 = dv * (1.0 - du);
                        let w11 = dv * du;

                        sampled_row[x] = (s00 * w00) + (s01 * w01) + (s10 * w10) + (s11 * w11);
                        alpha_row[x] = 1.0;
                    }
                });
        }
    }

    (sampled, alpha)
}

fn compose_layer_into(
    sampled_stack: &[Vec<f32>],
    sample_alpha: &[f32],
    layer: &LayerState,
    layer_rgb: &mut [f32],
    layer_alpha: &mut [f32],
    stage_timing: &mut CpuStageTiming,
) {
    let compose_start = Instant::now();
    let pixel_count = sample_alpha.len();
    if layer_rgb.len() != pixel_count * 3 || layer_alpha.len() != pixel_count {
        stage_timing.compose_ms += (Instant::now() - compose_start).as_secs_f64() * 1000.0;
        return;
    }
    layer_rgb.par_iter_mut().for_each(|value| *value = 0.0);
    layer_alpha.par_iter_mut().for_each(|value| *value = 0.0);

    let Some(image_settings) = layer.image.as_ref() else {
        stage_timing.compose_ms += (Instant::now() - compose_start).as_secs_f64() * 1000.0;
        return;
    };

    let mut settings_by_index: BTreeMap<usize, crate::dto::view_state::ImageChannelSettings> =
        image_settings
            .channels
            .iter()
            .filter(|channel| channel.enabled)
            .map(|channel| (usize::try_from(channel.index).unwrap_or(0), channel.clone()))
            .collect();
    if settings_by_index.is_empty() {
        for index in 0..sampled_stack.len() {
            settings_by_index.insert(
                index,
                crate::dto::view_state::ImageChannelSettings {
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

    let selected: Vec<usize> = match image_settings.channel_mode {
        ChannelMode::Single => settings_by_index.keys().copied().take(1).collect(),
        ChannelMode::Rgb => settings_by_index.keys().copied().take(3).collect(),
        ChannelMode::Composite => settings_by_index.keys().copied().collect(),
    };

    let mut rgb_overrides: HashMap<usize, [f32; 4]> = HashMap::new();
    if matches!(image_settings.channel_mode, ChannelMode::Rgb) {
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

    for channel_index in selected {
        if channel_index >= sampled_stack.len() {
            continue;
        }
        let Some(setting) = settings_by_index.get(&channel_index) else {
            continue;
        };
        let mut normalized =
            normalize_channel(&sampled_stack[channel_index], setting.contrast.as_ref());
        if setting.gamma > 0.0 {
            normalized.par_iter_mut().for_each(|value| {
                *value = value.clamp(0.0, 1.0).powf((1.0 / setting.gamma) as f32);
            });
        }

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
            .unwrap_or_else(|| {
                DEFAULT_CHANNEL_COLORS[channel_index % DEFAULT_CHANNEL_COLORS.len()]
            });

        layer_rgb
            .par_chunks_mut(3)
            .zip(layer_alpha.par_iter_mut())
            .enumerate()
            .for_each(|(pixel, (rgb, alpha))| {
                let strength =
                    normalized[pixel] * (layer.opacity as f32) * sample_alpha[pixel] * color[3];
                rgb[0] += strength * color[0];
                rgb[1] += strength * color[1];
                rgb[2] += strength * color[2];
                *alpha += strength;
            });
    }

    layer_rgb
        .par_chunks_mut(3)
        .zip(layer_alpha.par_iter_mut())
        .for_each(|(rgb, alpha)| {
            rgb[0] = rgb[0].clamp(0.0, 1.0);
            rgb[1] = rgb[1].clamp(0.0, 1.0);
            rgb[2] = rgb[2].clamp(0.0, 1.0);
            *alpha = (*alpha).clamp(0.0, 1.0);
        });

    stage_timing.compose_ms += (Instant::now() - compose_start).as_secs_f64() * 1000.0;
}

fn normalize_channel(channel_data: &[f32], contrast: Option<&ChannelContrast>) -> Vec<f32> {
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
        return vec![0.0_f32; channel_data.len()];
    }

    let range = max_value - min_value;
    channel_data
        .par_iter()
        .map(|value| ((*value - min_value) / range).clamp(0.0, 1.0))
        .collect()
}

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

fn resolve_background_rgba(view_state: &ViewState) -> [f32; 4] {
    if let Some(render_settings) = view_state.render_settings.as_ref() {
        if let Some(background) = render_settings.background_rgba {
            return [
                background[0] as f32,
                background[1] as f32,
                background[2] as f32,
                background[3] as f32,
            ];
        }
    }
    [0.0, 0.0, 0.0, 1.0]
}

fn open_level_chunk_source(
    root_path: &Path,
    level: &MultiscaleLevelDef,
    cache_scope: &str,
) -> Result<LevelChunkSource, String> {
    let level_path = root_path.join(&level.path);
    let metadata_path = level_path.join("zarr.json");
    let metadata_raw = fs::read_to_string(&metadata_path).map_err(|error| error.to_string())?;
    let metadata_json: Value =
        serde_json::from_str(&metadata_raw).map_err(|error| error.to_string())?;
    let mut storage_meta = parse_array_storage_metadata(&metadata_json)?;
    for chunk_size in &mut storage_meta.chunk_shape {
        if *chunk_size == 0 {
            *chunk_size = 1;
        }
    }

    let shape: Vec<usize> = level
        .shape
        .iter()
        .map(|value| usize::try_from(*value).map_err(|_| "shape value too large".to_owned()))
        .collect::<Result<Vec<usize>, String>>()?;

    if shape.len() != storage_meta.chunk_shape.len() {
        return Err("shape/chunk rank mismatch".to_owned());
    }

    let bytes_per_value = dtype_bytes(&storage_meta.dtype)?;
    let chunk_strides = c_order_strides(&storage_meta.chunk_shape);

    Ok(LevelChunkSource {
        level_path,
        storage_meta,
        bytes_per_value,
        chunk_strides,
        cache_scope: cache_scope.to_owned(),
    })
}

impl LevelChunkSource {
    fn decoded_chunk(
        &self,
        chunk_index: &[usize],
        cache_registry: &mut RenderCacheRegistry,
        cache_session_id: &str,
        timing: &mut ChunkIoDecodeTiming,
    ) -> Result<Arc<[u8]>, String> {
        let chunk_path = self
            .level_path
            .join(chunk_key(chunk_index, &self.storage_meta.separator));
        let cache_key = format!(
            "{}|{}|{}|{}",
            self.cache_scope,
            self.storage_meta.dtype,
            self.storage_meta.codecs.join(","),
            chunk_path.to_string_lossy(),
        );

        if let Some(hit) = cache_registry.get_cpu_chunk(cache_session_id, &cache_key) {
            return Ok(hit);
        }

        let decoded = if chunk_path.exists() {
            let read_start = Instant::now();
            let raw_bytes = fs::File::open(&chunk_path)
                .and_then(|mut file| {
                    let mut bytes = Vec::new();
                    file.read_to_end(&mut bytes)?;
                    Ok(bytes)
                })
                .map_err(|error| {
                    format!("failed to read chunk '{}': {error}", chunk_path.display())
                })?;
            timing.chunk_fetch_ms += (Instant::now() - read_start).as_secs_f64() * 1000.0;
            let decode_start = Instant::now();
            let decoded_chunk =
                decode_chunk(raw_bytes, &self.storage_meta.codecs).map_err(|reason| {
                    format!(
                        "failed to decode chunk '{}': {reason}",
                        chunk_path.display()
                    )
                })?;
            timing.chunk_decode_ms += (Instant::now() - decode_start).as_secs_f64() * 1000.0;
            decoded_chunk
        } else {
            Vec::new()
        };

        let payload = Arc::<[u8]>::from(decoded.into_boxed_slice());
        cache_registry.put_cpu_chunk(cache_session_id, cache_key, payload.clone());
        Ok(payload)
    }
}

fn parse_array_storage_metadata(metadata_json: &Value) -> Result<ArrayStorageMetadata, String> {
    let chunk_shape = metadata_json
        .get("chunk_grid")
        .and_then(Value::as_object)
        .and_then(|chunk_grid| chunk_grid.get("configuration"))
        .and_then(Value::as_object)
        .and_then(|configuration| configuration.get("chunk_shape"))
        .and_then(Value::as_array)
        .ok_or_else(|| "missing chunk_shape metadata".to_owned())?
        .iter()
        .map(|value| {
            value
                .as_u64()
                .or_else(|| {
                    value
                        .as_i64()
                        .and_then(|value| (value >= 0).then_some(value as u64))
                })
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| "invalid chunk_shape value".to_owned())
        })
        .collect::<Result<Vec<usize>, String>>()?;

    let dtype = metadata_json
        .get("data_type")
        .or_else(|| metadata_json.get("dtype"))
        .and_then(Value::as_str)
        .ok_or_else(|| "missing array dtype metadata".to_owned())?
        .to_ascii_lowercase();

    let separator = metadata_json
        .get("chunk_key_encoding")
        .and_then(Value::as_object)
        .and_then(|encoding| encoding.get("configuration"))
        .and_then(Value::as_object)
        .and_then(|configuration| configuration.get("separator"))
        .and_then(Value::as_str)
        .unwrap_or("/")
        .to_owned();

    let codecs = metadata_json
        .get("codecs")
        .and_then(Value::as_array)
        .map(|codecs| {
            codecs
                .iter()
                .filter_map(|codec| {
                    codec
                        .get("name")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    Ok(ArrayStorageMetadata {
        chunk_shape,
        dtype,
        separator,
        codecs,
    })
}

fn decode_chunk(raw_bytes: Vec<u8>, codecs: &[String]) -> Result<Vec<u8>, String> {
    let mut payload = raw_bytes;
    for codec in codecs.iter().rev() {
        match codec.as_str() {
            "zstd" => {
                payload =
                    zstd::stream::decode_all(&payload[..]).map_err(|error| error.to_string())?;
            }
            "bytes" => {}
            _ => {
                return Err(format!("unsupported codec: {codec}"));
            }
        }
    }
    Ok(payload)
}

fn dtype_bytes(dtype: &str) -> Result<usize, String> {
    match dtype {
        "uint8" | "|u1" => Ok(1),
        "int8" | "|i1" => Ok(1),
        "uint16" | "<u2" | "|u2" => Ok(2),
        "int16" | "<i2" | "|i2" => Ok(2),
        "uint32" | "<u4" | "|u4" => Ok(4),
        "int32" | "<i4" | "|i4" => Ok(4),
        "float32" | "<f4" | "|f4" => Ok(4),
        "float64" | "<f8" | "|f8" => Ok(8),
        _ => Err(format!("unsupported dtype: {dtype}")),
    }
}

fn decode_value(bytes: &[u8], dtype: &str, offset: usize) -> Option<f32> {
    match dtype {
        "uint8" | "|u1" => bytes.get(offset).copied().map(|value| value as f32),
        "int8" | "|i1" => bytes.get(offset).copied().map(|value| (value as i8) as f32),
        "uint16" | "<u2" | "|u2" => bytes
            .get(offset..offset + 2)
            .and_then(|slice| <[u8; 2]>::try_from(slice).ok())
            .map(u16::from_le_bytes)
            .map(|value| value as f32),
        "int16" | "<i2" | "|i2" => bytes
            .get(offset..offset + 2)
            .and_then(|slice| <[u8; 2]>::try_from(slice).ok())
            .map(i16::from_le_bytes)
            .map(|value| value as f32),
        "uint32" | "<u4" | "|u4" => bytes
            .get(offset..offset + 4)
            .and_then(|slice| <[u8; 4]>::try_from(slice).ok())
            .map(u32::from_le_bytes)
            .map(|value| value as f32),
        "int32" | "<i4" | "|i4" => bytes
            .get(offset..offset + 4)
            .and_then(|slice| <[u8; 4]>::try_from(slice).ok())
            .map(i32::from_le_bytes)
            .map(|value| value as f32),
        "float32" | "<f4" | "|f4" => bytes
            .get(offset..offset + 4)
            .and_then(|slice| <[u8; 4]>::try_from(slice).ok())
            .map(f32::from_le_bytes),
        "float64" | "<f8" | "|f8" => bytes
            .get(offset..offset + 8)
            .and_then(|slice| <[u8; 8]>::try_from(slice).ok())
            .map(f64::from_le_bytes)
            .map(|value| value as f32),
        _ => None,
    }
}

fn chunk_key(indices: &[usize], separator: &str) -> PathBuf {
    if separator == "/" {
        let mut path = PathBuf::from("c");
        for index in indices {
            path.push(index.to_string());
        }
        return path;
    }

    let mut key = String::from("c");
    for index in indices {
        key.push_str(separator);
        key.push_str(&index.to_string());
    }
    PathBuf::from(key)
}

#[cfg(test)]
fn for_each_index<F>(shape: &[usize], mut callback: F)
where
    F: FnMut(&[usize]),
{
    if shape.is_empty() {
        callback(&[]);
        return;
    }
    if shape.contains(&0) {
        return;
    }
    let mut index = vec![0usize; shape.len()];
    loop {
        callback(&index);

        let mut axis = shape.len();
        loop {
            axis -= 1;
            index[axis] += 1;
            if index[axis] < shape[axis] {
                break;
            }
            index[axis] = 0;
            if axis == 0 {
                return;
            }
        }
    }
}

fn c_order_strides(shape: &[usize]) -> Vec<usize> {
    if shape.is_empty() {
        return Vec::new();
    }
    let mut strides = vec![1usize; shape.len()];
    for axis in (0..shape.len() - 1).rev() {
        strides[axis] = strides[axis + 1].saturating_mul(shape[axis + 1]);
    }
    strides
}

#[cfg(test)]
fn linear_index(indices: &[usize], strides: &[usize]) -> usize {
    indices
        .iter()
        .zip(strides.iter())
        .fold(0usize, |acc, (index, stride)| {
            acc.saturating_add(index.saturating_mul(*stride))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_axis(name: &str, role: AxisRole, size: u64) -> crate::dto::dataset_summary::AxisDef {
        crate::dto::dataset_summary::AxisDef {
            name: name.to_owned(),
            role,
            size,
            unit: None,
            scale: None,
            translation: None,
            direction: None,
        }
    }

    fn make_dataset_summary(
        axes: Vec<crate::dto::dataset_summary::AxisDef>,
        shape: Vec<u64>,
    ) -> DatasetSummary {
        DatasetSummary {
            schema_version: 1,
            dataset_id: "ds_test".to_owned(),
            uri: "file:///tmp/ds_test".to_owned(),
            opened_at: None,
            axes,
            shape,
            dtype: "float32".to_owned(),
            world_units: None,
            channels: None,
            multiscales: Vec::new(),
            hints: None,
            raw_metadata: None,
        }
    }

    fn make_loaded_array(shape: &[usize], encode: impl Fn(&[usize]) -> f32) -> LoadedArray {
        let strides = c_order_strides(shape);
        let total_values = shape.iter().product();
        let mut data = vec![0.0; total_values];
        for_each_index(shape, |index| {
            let linear = linear_index(index, &strides);
            data[linear] = encode(index);
        });
        LoadedArray { data, strides }
    }

    #[test]
    fn extract_channel_stack_uses_stride_offsets_for_non_contiguous_axes() {
        let shape_usize = vec![3usize, 2, 4, 2, 2];
        let shape_u64 = shape_usize
            .iter()
            .map(|value| *value as u64)
            .collect::<Vec<u64>>();
        let dataset_summary = make_dataset_summary(
            vec![
                make_axis("z", AxisRole::Z, shape_u64[0]),
                make_axis("y", AxisRole::Y, shape_u64[1]),
                make_axis("x", AxisRole::X, shape_u64[2]),
                make_axis("c", AxisRole::C, shape_u64[3]),
                make_axis("t", AxisRole::T, shape_u64[4]),
            ],
            shape_u64.clone(),
        );

        let level = MultiscaleLevelDef {
            level: 0,
            path: "0".to_owned(),
            shape: shape_u64.clone(),
            chunks: vec![1, 1, 1, 1, 1],
            downsample_factors: Some(vec![1.0; 5]),
            dtype: Some("float32".to_owned()),
        };
        let multiscale = MultiscaleImageDef {
            name: "primary".to_owned(),
            axes_order: vec![
                "z".to_owned(),
                "y".to_owned(),
                "x".to_owned(),
                "c".to_owned(),
                "t".to_owned(),
            ],
            levels: vec![level.clone()],
        };

        let array = make_loaded_array(&shape_usize, |index| {
            ((index[0] * 10_000)
                + (index[1] * 1_000)
                + (index[2] * 100)
                + (index[3] * 10)
                + index[4]) as f32
        });

        let t_selector = AxisSelector {
            axis: "t".to_owned(),
            kind: AxisSelectorKind::Index,
            index: Some(1),
            start: None,
            end_exclusive: None,
            indices: None,
            clamp: true,
        };
        let selectors = HashMap::from([("t".to_owned(), &t_selector)]);

        let slab = SlabSettings {
            thickness_vox: 1,
            mode: SlabMode::Single,
        };
        let (planes, warnings) = extract_channel_stack_loaded_array(
            &array,
            &dataset_summary,
            &multiscale,
            &level,
            "x",
            "y",
            "z",
            &selectors,
            1,
            &slab,
        )
        .expect("extract channel stack");

        assert!(warnings.is_empty());
        assert_eq!(planes.len(), 2);
        assert_eq!(planes[0].width, 4);
        assert_eq!(planes[0].height, 2);
        assert_eq!(planes[0].data[0], 10_001.0);
        assert_eq!(planes[0].data[3], 10_301.0);
        assert_eq!(planes[0].data[4], 11_001.0);
        assert_eq!(planes[1].data[5], 11_111.0);
        assert_eq!(planes[1].data[7], 11_311.0);
    }

    #[test]
    fn extract_channel_stack_reduces_non_display_selector_and_respects_explicit_slab_span() {
        let shape_usize = vec![2usize, 2, 3, 2, 4];
        let shape_u64 = shape_usize
            .iter()
            .map(|value| *value as u64)
            .collect::<Vec<u64>>();
        let dataset_summary = make_dataset_summary(
            vec![
                make_axis("t", AxisRole::T, shape_u64[0]),
                make_axis("c", AxisRole::C, shape_u64[1]),
                make_axis("z", AxisRole::Z, shape_u64[2]),
                make_axis("y", AxisRole::Y, shape_u64[3]),
                make_axis("x", AxisRole::X, shape_u64[4]),
            ],
            shape_u64.clone(),
        );

        let level = MultiscaleLevelDef {
            level: 0,
            path: "0".to_owned(),
            shape: shape_u64.clone(),
            chunks: vec![1, 1, 1, 1, 1],
            downsample_factors: Some(vec![1.0; 5]),
            dtype: Some("float32".to_owned()),
        };
        let multiscale = MultiscaleImageDef {
            name: "primary".to_owned(),
            axes_order: vec![
                "t".to_owned(),
                "c".to_owned(),
                "z".to_owned(),
                "y".to_owned(),
                "x".to_owned(),
            ],
            levels: vec![level.clone()],
        };
        let array = make_loaded_array(&shape_usize, |index| {
            ((index[0] * 10_000)
                + (index[1] * 1_000)
                + (index[2] * 100)
                + (index[3] * 10)
                + index[4]) as f32
        });

        let z_selector = AxisSelector {
            axis: "z".to_owned(),
            kind: AxisSelectorKind::Range,
            index: None,
            start: Some(0),
            end_exclusive: Some(2),
            indices: None,
            clamp: true,
        };
        let t_selector = AxisSelector {
            axis: "t".to_owned(),
            kind: AxisSelectorKind::Range,
            index: None,
            start: Some(1),
            end_exclusive: Some(2),
            indices: None,
            clamp: true,
        };
        let selectors =
            HashMap::from([("z".to_owned(), &z_selector), ("t".to_owned(), &t_selector)]);
        let slab = SlabSettings {
            thickness_vox: 5,
            mode: SlabMode::Single,
        };

        let (planes, warnings) = extract_channel_stack_loaded_array(
            &array,
            &dataset_summary,
            &multiscale,
            &level,
            "x",
            "y",
            "z",
            &selectors,
            0,
            &slab,
        )
        .expect("extract channel stack");

        assert_eq!(planes.len(), 2);
        assert_eq!(planes[0].width, 4);
        assert_eq!(planes[0].height, 2);
        assert_eq!(planes[0].data[0], 10_000.0);
        assert_eq!(planes[0].data[7], 10_013.0);
        assert_eq!(planes[1].data[0], 11_000.0);
        assert_eq!(planes[1].data[7], 11_013.0);

        let warning_codes: Vec<&str> = warnings.iter().map(|item| item.code.as_str()).collect();
        assert!(warning_codes.contains(&"slab_thickness_ignored"));
        assert!(warning_codes.contains(&"selector_reduced_to_index"));
    }
}
