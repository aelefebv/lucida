use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::http::StatusCode;
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use serde_json::{json, Value};

use crate::dto::api::ApiWarning;
use crate::dto::dataset_summary::{
    AxisRole, DatasetSummary, MultiscaleImageDef, MultiscaleLevelDef,
};
use crate::dto::render::{RenderOutputSpec, RenderTimingMs};
use crate::dto::view_state::{
    AxisSelector, AxisSelectorKind, ChannelContrast, ChannelContrastPolicy, ChannelMode,
    InterpolationMode, LayerState, LayerType, SlabMode, SlabSettings, ViewState,
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

#[derive(Debug, Clone)]
pub struct RenderCpuResult {
    pub png_bytes: Vec<u8>,
    pub pyramid_level_used: u64,
    pub warnings: Vec<ApiWarning>,
    pub timing_ms: Option<RenderTimingMs>,
}

#[derive(Debug, Clone)]
struct PlaneData {
    width: usize,
    height: usize,
    data: Vec<f32>,
}

#[derive(Debug, Clone)]
struct LoadedArray {
    shape: Vec<usize>,
    data: Vec<f32>,
}

impl LoadedArray {
    fn value_at(&self, indices: &[usize]) -> f32 {
        let linear = linear_index(indices, &c_order_strides(&self.shape));
        self.data[linear]
    }
}

#[derive(Debug, Clone)]
struct ArrayStorageMetadata {
    chunk_shape: Vec<usize>,
    dtype: String,
    separator: String,
    codecs: Vec<String>,
}

pub fn render_view_to_png(
    dataset_summary: &DatasetSummary,
    view_state: &ViewState,
    output: &RenderOutputSpec,
    cache_registry: &mut RenderCacheRegistry,
    cache_session_id: &str,
    cache_budgets: EffectiveCacheBudgets,
) -> Result<RenderCpuResult, ApiError> {
    cache_registry.ensure_session_budgets(cache_session_id, cache_budgets);

    let Some(view_2d) = view_state.view_2d.as_ref() else {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_mode",
            "Only mode=2d is supported for this renderer.",
            Some(json!({ "mode": "3d" })),
        ));
    };

    let start_total = Instant::now();
    let mut warnings: Vec<ApiWarning> = Vec::new();

    let io_start = Instant::now();
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
    let io_after_open = Instant::now();

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

    let mut slice_index: i64 = 0;
    if let Some(slice) = view_2d.slice.as_ref() {
        if let Some(index) = slice.index {
            slice_index = index;
        }
    }

    let background = resolve_background_rgba(view_state);
    let pixel_count = usize::try_from(output.width_px)
        .unwrap_or(0)
        .saturating_mul(usize::try_from(output.height_px).unwrap_or(0));
    let mut canvas_rgb = vec![0.0_f32; pixel_count * 3];
    let mut canvas_alpha = vec![0.0_f32; pixel_count];
    for pixel in 0..pixel_count {
        canvas_rgb[pixel * 3] = background[0];
        canvas_rgb[pixel * 3 + 1] = background[1];
        canvas_rgb[pixel * 3 + 2] = background[2];
        canvas_alpha[pixel] = background[3];
    }

    let mut rendered_layer_count: usize = 0;
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
        let (level, level_warnings) = choose_level(multiscale, view_state, u_axis, v_axis);
        warnings.extend(level_warnings);

        let loaded_array = load_level_array(
            &dataset_root,
            level,
            cache_registry,
            cache_session_id,
            &format!(
                "{}|{}|{}",
                dataset_summary.dataset_id, multiscale.name, level.path
            ),
        )
        .map_err(|reason| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "render_failed",
                "Failed to open multiscale level array.",
                Some(json!({
                    "multiscale_name": multiscale.name,
                    "path": level.path,
                    "reason": reason,
                })),
            )
        })?;

        let slab = view_2d
            .slice
            .as_ref()
            .and_then(|slice| slice.slab.clone())
            .unwrap_or(SlabSettings {
                thickness_vox: 1,
                mode: SlabMode::Single,
            });
        let (channel_stack, layer_warnings) = extract_channel_stack(
            &loaded_array,
            dataset_summary,
            multiscale,
            level,
            u_axis,
            v_axis,
            orth_axis,
            &selectors_by_axis,
            slice_index,
            &slab,
        )?;
        warnings.extend(layer_warnings);

        let axis_index: HashMap<&str, usize> = multiscale
            .axes_order
            .iter()
            .enumerate()
            .map(|(index, name)| (name.as_str(), index))
            .collect();
        let level_factors = level_factors(multiscale, level);
        let f_u = level_factors[*axis_index.get(u_axis.as_str()).ok_or_else(|| {
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
        })?];
        let f_v = level_factors[*axis_index.get(v_axis.as_str()).ok_or_else(|| {
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
        })?];

        let (sampled_stack, sample_alpha) = sample_channel_stack(
            &channel_stack,
            view_2d.camera.center_world.0,
            view_2d.camera.center_world.1,
            view_2d.camera.zoom,
            view_state.viewport.pixel_ratio,
            f_u,
            f_v,
            usize::try_from(output.width_px).unwrap_or(0),
            usize::try_from(output.height_px).unwrap_or(0),
            layer
                .image
                .as_ref()
                .map(|settings| settings.interpolation.clone())
                .unwrap_or(InterpolationMode::Linear),
        );

        let (layer_rgb, layer_alpha) = compose_layer(&sampled_stack, &sample_alpha, layer);
        for index in 0..pixel_count {
            let src_alpha = layer_alpha[index].clamp(0.0, 1.0);
            canvas_rgb[index * 3] =
                layer_rgb[index * 3].clamp(0.0, 1.0) + (canvas_rgb[index * 3] * (1.0 - src_alpha));
            canvas_rgb[index * 3 + 1] = layer_rgb[index * 3 + 1].clamp(0.0, 1.0)
                + (canvas_rgb[index * 3 + 1] * (1.0 - src_alpha));
            canvas_rgb[index * 3 + 2] = layer_rgb[index * 3 + 2].clamp(0.0, 1.0)
                + (canvas_rgb[index * 3 + 2] * (1.0 - src_alpha));
            canvas_alpha[index] = src_alpha + (canvas_alpha[index] * (1.0 - src_alpha));
        }

        rendered_layer_count += 1;
        if primary_level_used.is_none() {
            primary_level_used = Some(level.level);
        }
    }

    if rendered_layer_count == 0 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "No renderable image layers were available.",
            Some(json!({ "view_id": view_state.view_id })),
        ));
    }

    let mut rgba_u8 = vec![0_u8; pixel_count * 4];
    for index in 0..pixel_count {
        rgba_u8[index * 4] = (canvas_rgb[index * 3].clamp(0.0, 1.0) * 255.0).round() as u8;
        rgba_u8[index * 4 + 1] = (canvas_rgb[index * 3 + 1].clamp(0.0, 1.0) * 255.0).round() as u8;
        rgba_u8[index * 4 + 2] = (canvas_rgb[index * 3 + 2].clamp(0.0, 1.0) * 255.0).round() as u8;
        rgba_u8[index * 4 + 3] = (canvas_alpha[index].clamp(0.0, 1.0) * 255.0).round() as u8;
    }

    let encode_start = Instant::now();
    let mut png_bytes: Vec<u8> = Vec::new();
    let encoder = PngEncoder::new(&mut png_bytes);
    encoder
        .write_image(
            &rgba_u8,
            output.width_px as u32,
            output.height_px as u32,
            ColorType::Rgba8.into(),
        )
        .map_err(|error| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "render_failed",
                "Failed to encode PNG image.",
                Some(json!({ "reason": error.to_string() })),
            )
        })?;
    let end_total = Instant::now();

    Ok(RenderCpuResult {
        png_bytes,
        pyramid_level_used: primary_level_used.unwrap_or(0),
        warnings,
        timing_ms: Some(RenderTimingMs {
            total: (end_total - start_total).as_secs_f64() * 1000.0,
            io: (io_after_open - io_start).as_secs_f64() * 1000.0,
            decode: 0.0,
            gpu_upload: 0.0,
            render: (end_total - encode_start).as_secs_f64() * 1000.0,
        }),
    })
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
    view_state: &ViewState,
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

    let performance = view_state.performance.as_ref();
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

    let zoom = view_state
        .view_2d
        .as_ref()
        .map(|item| item.camera.zoom)
        .unwrap_or(1.0);
    let pixel_ratio = view_state.viewport.pixel_ratio;

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

    let mut fixed_indices_level: HashMap<&str, usize> = HashMap::new();
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
        fixed_indices_level.insert(axis_name, level_index);
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

    let mut slab_planes: Vec<Vec<PlaneData>> = Vec::new();
    for orth_index in orth_indices_level {
        let mut channels: Vec<PlaneData> = Vec::new();
        for channel_index in 0..channel_count {
            let mut plane_values = vec![0.0_f32; v_size * u_size];
            for v in 0..v_size {
                for u in 0..u_size {
                    let mut indices = vec![0_usize; multiscale.axes_order.len()];
                    for (axis_pos, axis_name) in multiscale.axes_order.iter().enumerate() {
                        if axis_name == u_axis {
                            indices[axis_pos] = u;
                        } else if axis_name == v_axis {
                            indices[axis_pos] = v;
                        } else if axis_name == orth_axis {
                            indices[axis_pos] = orth_index;
                        } else if c_axis_name.as_ref() == Some(axis_name) {
                            indices[axis_pos] = channel_index;
                        } else {
                            indices[axis_pos] =
                                *fixed_indices_level.get(axis_name.as_str()).unwrap_or(&0);
                        }
                    }
                    plane_values[v * u_size + u] = array.value_at(&indices);
                }
            }
            channels.push(PlaneData {
                width: u_size,
                height: v_size,
                data: plane_values,
            });
        }
        slab_planes.push(channels);
    }

    if slab_planes.is_empty() {
        slab_planes.push(vec![PlaneData {
            width: u_size,
            height: v_size,
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
        for (index, value) in alpha.iter().enumerate() {
            sample_alpha[index] = sample_alpha[index].max(*value);
        }
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

    let center_u_level = center_u / f_u_safe;
    let center_v_level = center_v / f_v_safe;

    let start_u = center_u_level - (span_u / 2.0);
    let start_v = center_v_level - (span_v / 2.0);

    let step_u = span_u / (output_width as f64);
    let step_v = span_v / (output_height as f64);

    match interpolation {
        InterpolationMode::Nearest => {
            for y in 0..output_height {
                let v_coord = start_v + ((y as f64) + 0.5) * step_v;
                let v_idx = v_coord.floor() as i64;
                let valid_v = v_idx >= 0 && v_idx < src_h;
                let v_clamped = clamp_index_i64(v_idx, src_h) as usize;
                for x in 0..output_width {
                    let u_coord = start_u + ((x as f64) + 0.5) * step_u;
                    let u_idx = u_coord.floor() as i64;
                    let valid_u = u_idx >= 0 && u_idx < src_w;
                    let pixel = y * output_width + x;
                    if valid_u && valid_v {
                        let u_clamped = clamp_index_i64(u_idx, src_w) as usize;
                        sampled[pixel] = plane.data[v_clamped * plane.width + u_clamped];
                        alpha[pixel] = 1.0;
                    }
                }
            }
        }
        InterpolationMode::Linear => {
            for y in 0..output_height {
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

                    let pixel = y * output_width + x;
                    sampled[pixel] = (s00 * w00) + (s01 * w01) + (s10 * w10) + (s11 * w11);
                    alpha[pixel] = 1.0;
                }
            }
        }
    }

    (sampled, alpha)
}

fn compose_layer(
    sampled_stack: &[Vec<f32>],
    sample_alpha: &[f32],
    layer: &LayerState,
) -> (Vec<f32>, Vec<f32>) {
    let pixel_count = sample_alpha.len();
    let mut layer_rgb = vec![0.0_f32; pixel_count * 3];
    let mut layer_alpha = vec![0.0_f32; pixel_count];

    let Some(image_settings) = layer.image.as_ref() else {
        return (layer_rgb, layer_alpha);
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
            for value in &mut normalized {
                *value = value.clamp(0.0, 1.0).powf((1.0 / setting.gamma) as f32);
            }
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

        for pixel in 0..pixel_count {
            let strength =
                normalized[pixel] * (layer.opacity as f32) * sample_alpha[pixel] * color[3];
            layer_rgb[pixel * 3] += strength * color[0];
            layer_rgb[pixel * 3 + 1] += strength * color[1];
            layer_rgb[pixel * 3 + 2] += strength * color[2];
            layer_alpha[pixel] += strength;
        }
    }

    for pixel in 0..pixel_count {
        layer_rgb[pixel * 3] = layer_rgb[pixel * 3].clamp(0.0, 1.0);
        layer_rgb[pixel * 3 + 1] = layer_rgb[pixel * 3 + 1].clamp(0.0, 1.0);
        layer_rgb[pixel * 3 + 2] = layer_rgb[pixel * 3 + 2].clamp(0.0, 1.0);
        layer_alpha[pixel] = layer_alpha[pixel].clamp(0.0, 1.0);
    }

    (layer_rgb, layer_alpha)
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
        .iter()
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

fn load_level_array(
    root_path: &Path,
    level: &MultiscaleLevelDef,
    cache_registry: &mut RenderCacheRegistry,
    cache_session_id: &str,
    cache_scope: &str,
) -> Result<LoadedArray, String> {
    let level_path = root_path.join(&level.path);
    let metadata_path = level_path.join("zarr.json");
    let metadata_raw = fs::read_to_string(&metadata_path).map_err(|error| error.to_string())?;
    let metadata_json: Value =
        serde_json::from_str(&metadata_raw).map_err(|error| error.to_string())?;
    let storage_meta = parse_array_storage_metadata(&metadata_json)?;

    let shape: Vec<usize> = level
        .shape
        .iter()
        .map(|value| usize::try_from(*value).map_err(|_| "shape value too large".to_owned()))
        .collect::<Result<Vec<usize>, String>>()?;

    if shape.len() != storage_meta.chunk_shape.len() {
        return Err("shape/chunk rank mismatch".to_owned());
    }

    let bytes_per_value = dtype_bytes(&storage_meta.dtype)?;
    let total_values = shape
        .iter()
        .fold(1usize, |acc, item| acc.saturating_mul(*item));
    let mut full = vec![0.0_f32; total_values];

    let chunk_counts: Vec<usize> = shape
        .iter()
        .zip(storage_meta.chunk_shape.iter())
        .map(|(axis_size, chunk_size)| {
            if *chunk_size == 0 {
                1
            } else {
                (*axis_size + *chunk_size - 1) / *chunk_size
            }
        })
        .collect();

    for_each_index(&chunk_counts, |chunk_index| {
        let chunk_path = level_path.join(chunk_key(chunk_index, &storage_meta.separator));
        let cache_key = format!(
            "{cache_scope}|{}|{}|{}",
            storage_meta.dtype,
            storage_meta.codecs.join(","),
            chunk_path.to_string_lossy(),
        );

        let decoded_chunk: Arc<[u8]> =
            if let Some(hit) = cache_registry.get_cpu_chunk(cache_session_id, &cache_key) {
                hit
            } else {
                let decoded = if chunk_path.exists() {
                    match fs::File::open(&chunk_path).and_then(|mut file| {
                        let mut bytes = Vec::new();
                        file.read_to_end(&mut bytes)?;
                        Ok(bytes)
                    }) {
                        Ok(raw_bytes) => {
                            decode_chunk(raw_bytes, &storage_meta.codecs).unwrap_or_default()
                        }
                        Err(_) => Vec::new(),
                    }
                } else {
                    Vec::new()
                };

                let payload = Arc::<[u8]>::from(decoded.into_boxed_slice());
                cache_registry.put_cpu_chunk(cache_session_id, cache_key, payload.clone());
                payload
            };

        let full_strides = c_order_strides(&shape);
        let chunk_strides = c_order_strides(&storage_meta.chunk_shape);

        let mut actual_shape: Vec<usize> = Vec::with_capacity(shape.len());
        let mut start: Vec<usize> = Vec::with_capacity(shape.len());
        for axis in 0..shape.len() {
            let axis_start = chunk_index[axis] * storage_meta.chunk_shape[axis];
            start.push(axis_start);
            actual_shape
                .push(storage_meta.chunk_shape[axis].min(shape[axis].saturating_sub(axis_start)));
        }

        for_each_index(&actual_shape, |local_index| {
            let mut global_index = vec![0usize; shape.len()];
            for axis in 0..shape.len() {
                global_index[axis] = start[axis] + local_index[axis];
            }
            let global_linear = linear_index(&global_index, &full_strides);
            let chunk_linear = linear_index(local_index, &chunk_strides);
            let byte_offset = chunk_linear.saturating_mul(bytes_per_value);
            let value =
                decode_value(&decoded_chunk, &storage_meta.dtype, byte_offset).unwrap_or(0.0);
            full[global_linear] = value;
        });
    });

    Ok(LoadedArray { shape, data: full })
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

fn linear_index(indices: &[usize], strides: &[usize]) -> usize {
    indices
        .iter()
        .zip(strides.iter())
        .fold(0usize, |acc, (index, stride)| {
            acc.saturating_add(index.saturating_mul(*stride))
        })
}
