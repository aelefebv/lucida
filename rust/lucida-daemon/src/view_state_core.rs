use std::collections::{BTreeMap, HashMap};

use axum::http::StatusCode;
use serde_json::{json, Number, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::dto::api::ApiWarning;
use crate::dto::dataset_summary::{AxisDef, AxisRole, ChannelDef, ContrastPolicy, DatasetSummary};
use crate::dto::view_state::{
    AxisSelector, AxisSelectorKind, Camera2D, ChannelContrast, ChannelContrastPolicy, ChannelMode,
    ImageChannelSettings, ImageLayerSettings, InterpolationMode, LayerSource, LayerState,
    LayerType, Plane2D, RenderMode, SlabMode, SlabSettings, SliceSettings, View2D, ViewState,
    Viewport,
};
use crate::error::ApiError;
use crate::state::ensure_dataset_attached;

pub fn validate_viewport(viewport: &Viewport) -> Result<(), ApiError> {
    if viewport.width_px == 0 || viewport.height_px == 0 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request",
            "Request validation failed.",
            Some(json!({
                "errors": [
                    {
                        "loc": ["body", "viewport"],
                        "msg": "Viewport dimensions must be >= 1.",
                        "type": "greater_than_equal",
                    }
                ]
            })),
        ));
    }
    if viewport.pixel_ratio < 0.5 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_request",
            "Request validation failed.",
            Some(json!({
                "errors": [
                    {
                        "loc": ["body", "viewport", "pixel_ratio"],
                        "msg": "Input should be greater than or equal to 0.5.",
                        "type": "greater_than_equal",
                    }
                ]
            })),
        ));
    }
    Ok(())
}

pub fn resolve_dataset_for_session(
    app_state: &mut crate::state::AppState,
    dataset_id: &str,
    session_id: &str,
    attach_if_missing: bool,
) -> Result<DatasetSummary, ApiError> {
    let dataset_summary = app_state
        .datasets_by_id
        .get(dataset_id)
        .map(|record| record.dataset_summary.clone())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "dataset_not_found",
                "Dataset was not found.",
                Some(json!({ "dataset_id": dataset_id })),
            )
        })?;

    if attach_if_missing {
        ensure_dataset_attached(app_state, dataset_id, session_id);
    }

    Ok(dataset_summary)
}

pub fn resolve_primary_dataset_for_view(
    app_state: &mut crate::state::AppState,
    view_state: &ViewState,
    session_id: &str,
) -> Result<DatasetSummary, ApiError> {
    let dataset_ref = view_state.datasets.first().ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_patch",
            "Patched view state did not validate.",
            Some(json!({ "reason": "View state must include at least one dataset reference." })),
        )
    })?;
    let dataset_summary =
        resolve_dataset_for_session(app_state, &dataset_ref.dataset_id, session_id, true)?;
    validate_multiscale_name(&dataset_summary, &dataset_ref.multiscale_name)?;
    Ok(dataset_summary)
}

pub fn validate_multiscale_name(
    dataset_summary: &DatasetSummary,
    multiscale_name: &str,
) -> Result<(), ApiError> {
    if dataset_summary
        .multiscales
        .iter()
        .any(|multiscale| multiscale.name == multiscale_name)
    {
        return Ok(());
    }

    let mut available: Vec<String> = dataset_summary
        .multiscales
        .iter()
        .map(|item| item.name.clone())
        .collect();
    available.sort();

    Err(ApiError::new(
        StatusCode::NOT_FOUND,
        "dataset_not_found",
        "Requested multiscale was not found in dataset.",
        Some(json!({
            "dataset_id": dataset_summary.dataset_id,
            "multiscale_name": multiscale_name,
            "available_multiscales": available,
        })),
    ))
}

pub fn default_viewport() -> Viewport {
    Viewport {
        width_px: 1024,
        height_px: 1024,
        pixel_ratio: 1.0,
    }
}

pub fn default_selectors(dataset_summary: &DatasetSummary) -> Vec<AxisSelector> {
    let mut selectors: Vec<AxisSelector> = dataset_summary
        .axes
        .iter()
        .filter(|axis| !matches!(axis.role, AxisRole::X | AxisRole::Y))
        .map(|axis| AxisSelector {
            axis: axis.name.clone(),
            kind: AxisSelectorKind::Index,
            index: Some(0),
            start: None,
            end_exclusive: None,
            indices: None,
            clamp: true,
        })
        .collect();

    if selectors.is_empty() {
        selectors.push(AxisSelector {
            axis: dataset_summary.axes[0].name.clone(),
            kind: AxisSelectorKind::Index,
            index: Some(0),
            start: None,
            end_exclusive: None,
            indices: None,
            clamp: true,
        });
    }
    selectors
}

pub fn default_view_2d(
    dataset_summary: &DatasetSummary,
    selectors: &[AxisSelector],
) -> Result<View2D, ApiError> {
    let (u_role, v_role, orth_role) = plane_role_triplet(&Plane2D::Xy);
    let u_axis_name = axis_name_for_role(dataset_summary, u_role, &Plane2D::Xy)?;
    let v_axis_name = axis_name_for_role(dataset_summary, v_role, &Plane2D::Xy)?;
    let slice_axis_name = axis_name_for_role(dataset_summary, orth_role, &Plane2D::Xy)?;

    let axis_sizes: HashMap<String, i64> = dataset_summary
        .axes
        .iter()
        .map(|axis| {
            (
                axis.name.clone(),
                i64::try_from(axis.size).unwrap_or(i64::MAX),
            )
        })
        .collect();

    let slice_index = selector_index_for_axis(selectors, &slice_axis_name);
    let u_size = *axis_sizes.get(&u_axis_name).unwrap_or(&1);
    let v_size = *axis_sizes.get(&v_axis_name).unwrap_or(&1);

    Ok(View2D {
        plane: Plane2D::Xy,
        slice: Some(SliceSettings {
            axis: Some(slice_axis_name),
            index: Some(slice_index),
            slab: Some(SlabSettings {
                thickness_vox: 1,
                mode: SlabMode::Single,
            }),
        }),
        camera: Camera2D {
            center_world: (u_size as f64 / 2.0, v_size as f64 / 2.0),
            zoom: 1.0,
            rotation_deg: 0.0,
        },
    })
}

pub fn default_image_layer(dataset_summary: &DatasetSummary, multiscale_name: &str) -> LayerState {
    let channels = default_image_channels(dataset_summary);
    let channel_mode = if channels.len() <= 1 {
        ChannelMode::Single
    } else {
        ChannelMode::Composite
    };

    LayerState {
        layer_id: "image_0".to_owned(),
        layer_type: LayerType::Image,
        dataset_id: Some(dataset_summary.dataset_id.clone()),
        source: Some(LayerSource {
            multiscale_name: Some(multiscale_name.to_owned()),
            array_path: None,
        }),
        visible: true,
        opacity: 1.0,
        image: Some(ImageLayerSettings {
            channel_mode,
            channels,
            interpolation: InterpolationMode::Linear,
        }),
        labels: None,
    }
}

pub fn normalize_view_2d(
    view_2d: View2D,
    dataset_summary: &DatasetSummary,
    selectors: &[AxisSelector],
) -> Result<(View2D, Vec<ApiWarning>), ApiError> {
    let mut warnings: Vec<ApiWarning> = Vec::new();

    let (_, _, orth_role) = plane_role_triplet(&view_2d.plane);
    let slice_axis = axis_name_for_role(dataset_summary, orth_role, &view_2d.plane)?;
    let requested_slice_axis = view_2d.slice.as_ref().and_then(|slice| slice.axis.clone());
    if let Some(requested) = requested_slice_axis {
        if requested != slice_axis {
            warnings.push(ApiWarning {
                code: "slice_axis_forced_to_plane".to_owned(),
                message: "Slice axis was replaced to match plane orthogonal axis.".to_owned(),
                details: Some(json!({
                    "plane": plane_name(&view_2d.plane),
                    "requested_axis": requested,
                    "applied_axis": slice_axis,
                })),
            });
        }
    }

    let axis_sizes: HashMap<String, i64> = dataset_summary
        .axes
        .iter()
        .map(|axis| {
            (
                axis.name.clone(),
                i64::try_from(axis.size).unwrap_or(i64::MAX),
            )
        })
        .collect();

    let requested_slice_index = view_2d
        .slice
        .as_ref()
        .and_then(|slice| slice.index)
        .unwrap_or_else(|| selector_index_for_axis(selectors, &slice_axis));

    let axis_size = *axis_sizes.get(&slice_axis).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_plane",
            "Requested plane is unsupported for dataset axes.",
            Some(json!({
                "plane": plane_name(&view_2d.plane),
                "dataset_id": dataset_summary.dataset_id,
            })),
        )
    })?;

    let clamped_slice_index = clamp_index(requested_slice_index, axis_size);
    if clamped_slice_index != requested_slice_index {
        warnings.push(ApiWarning {
            code: "slice_index_clamped".to_owned(),
            message: "Slice index exceeded axis bounds and was clamped.".to_owned(),
            details: Some(json!({
                "axis": slice_axis,
                "requested_index": requested_slice_index,
                "applied_index": clamped_slice_index,
            })),
        });
    }

    let slab = view_2d
        .slice
        .as_ref()
        .and_then(|slice| slice.slab.clone())
        .unwrap_or(SlabSettings {
            thickness_vox: 1,
            mode: SlabMode::Single,
        });

    Ok((
        View2D {
            plane: view_2d.plane,
            camera: view_2d.camera,
            slice: Some(SliceSettings {
                axis: Some(slice_axis),
                index: Some(clamped_slice_index),
                slab: Some(slab),
            }),
        },
        warnings,
    ))
}

pub fn normalize_selectors(
    selectors: &[AxisSelector],
    dataset_summary: &DatasetSummary,
    operation: &str,
) -> Result<(Vec<AxisSelector>, Vec<ApiWarning>), ApiError> {
    if selectors.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "At least one selector is required.",
            Some(json!({ "operation": operation })),
        ));
    }

    let axis_sizes: HashMap<String, i64> = dataset_summary
        .axes
        .iter()
        .map(|axis| {
            (
                axis.name.clone(),
                i64::try_from(axis.size).unwrap_or(i64::MAX),
            )
        })
        .collect();

    let mut normalized: Vec<AxisSelector> = Vec::new();
    let mut warnings: Vec<ApiWarning> = Vec::new();

    for selector in selectors {
        let axis_size = axis_sizes.get(&selector.axis).copied().ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "selector_out_of_bounds",
                "Selector axis does not exist in dataset.",
                Some(json!({
                    "axis": selector.axis,
                    "dataset_id": dataset_summary.dataset_id,
                })),
            )
        })?;

        let (normalized_selector, warning) = match selector.kind {
            AxisSelectorKind::Index => normalize_index_selector(selector, axis_size)?,
            AxisSelectorKind::Range => normalize_range_selector(selector, axis_size)?,
            AxisSelectorKind::Set => normalize_set_selector(selector, axis_size)?,
        };

        if let Some(warning) = warning {
            warnings.push(warning);
        }
        normalized.push(normalized_selector);
    }

    Ok((normalized, warnings))
}

pub fn render_mode_name(mode: &RenderMode) -> &'static str {
    match mode {
        RenderMode::TwoD => "2d",
        RenderMode::ThreeD => "3d",
    }
}

pub fn validate_immutable_view_fields(
    current: &ViewState,
    candidate: &ViewState,
) -> Result<(), ApiError> {
    if current.view_id != candidate.view_id {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_patch",
            "view_id is immutable.",
            Some(json!({
                "expected": current.view_id,
                "actual": candidate.view_id,
            })),
        ));
    }
    if current.session_id != candidate.session_id {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_patch",
            "session_id is immutable.",
            Some(json!({
                "expected": current.session_id,
                "actual": candidate.session_id,
            })),
        ));
    }
    if current.created_at != candidate.created_at {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_patch",
            "created_at is immutable.",
            Some(json!({ "view_id": current.view_id })),
        ));
    }
    Ok(())
}

pub fn validate_view_state(view_state: &ViewState) -> Result<(), String> {
    if view_state.schema_version != 1 {
        return Err("schema_version must be 1.".to_owned());
    }
    if view_state.view_id.is_empty() {
        return Err("view_id must not be empty.".to_owned());
    }
    if view_state.session_id.is_empty() {
        return Err("session_id must not be empty.".to_owned());
    }
    if view_state.datasets.is_empty() {
        return Err("datasets must contain at least one item.".to_owned());
    }
    if view_state.selectors.is_empty() {
        return Err("selectors must contain at least one item.".to_owned());
    }
    if view_state.layers.is_empty() {
        return Err("layers must contain at least one item.".to_owned());
    }
    if view_state.viewport.width_px == 0 || view_state.viewport.height_px == 0 {
        return Err("viewport dimensions must be >= 1.".to_owned());
    }
    if view_state.viewport.pixel_ratio < 0.5 {
        return Err("viewport pixel_ratio must be >= 0.5.".to_owned());
    }

    match view_state.mode {
        RenderMode::TwoD if view_state.view_2d.is_none() => {
            return Err("mode=2d requires view_2d.".to_owned())
        }
        RenderMode::ThreeD if view_state.view_3d.is_none() => {
            return Err("mode=3d requires view_3d.".to_owned())
        }
        _ => {}
    }

    for dataset in &view_state.datasets {
        if dataset.dataset_id.is_empty() || dataset.multiscale_name.is_empty() {
            return Err("dataset references must be non-empty.".to_owned());
        }
    }

    for selector in &view_state.selectors {
        if selector.axis.is_empty() {
            return Err("selector axis must be non-empty.".to_owned());
        }
        match selector.kind {
            AxisSelectorKind::Index if selector.index.is_none() => {
                return Err("index selector requires index.".to_owned())
            }
            AxisSelectorKind::Range
                if selector.start.is_none() || selector.end_exclusive.is_none() =>
            {
                return Err("range selector requires start and end_exclusive.".to_owned())
            }
            AxisSelectorKind::Set if selector.indices.is_none() => {
                return Err("set selector requires indices.".to_owned())
            }
            _ => {}
        }
    }

    Ok(())
}

pub fn with_state_hash(view_state: &ViewState, state_version: u64) -> ViewState {
    let mut base_state = view_state.clone();
    base_state.state_version = state_version;
    base_state.state_hash = None;

    let computed_hash = compute_state_hash(&base_state);
    base_state.state_hash = Some(computed_hash);
    base_state
}

pub fn compute_state_hash(view_state: &ViewState) -> String {
    let mut payload = serde_json::to_value(view_state).expect("serialize state for hashing");
    if let Value::Object(ref mut map) = payload {
        map.remove("state_hash");
        map.remove("state_version");
    }

    let canonical = canonicalize_for_hash(payload);
    let serialized = serde_json::to_string(&canonical).expect("serialize canonical state");

    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn generate_view_id() -> String {
    format!("view_{}", &Uuid::new_v4().simple().to_string()[..16])
}

pub fn invalid_patch_error(view_id: Option<&str>, message: &str, reason: &str) -> ApiError {
    let details = if let Some(view_id) = view_id {
        json!({ "view_id": view_id, "reason": reason })
    } else {
        json!({ "reason": reason })
    };
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_patch",
        message,
        Some(details),
    )
}

pub fn plane_name(plane: &Plane2D) -> &'static str {
    match plane {
        Plane2D::Xy => "xy",
        Plane2D::Xz => "xz",
        Plane2D::Yz => "yz",
    }
}

fn default_image_channels(dataset_summary: &DatasetSummary) -> Vec<ImageChannelSettings> {
    if let Some(channels) = dataset_summary.channels.as_ref() {
        if !channels.is_empty() {
            return channels.iter().map(default_channel_from_metadata).collect();
        }
    }

    let channel_count = dataset_summary
        .axes
        .iter()
        .find(|axis| matches!(axis.role, AxisRole::C))
        .map(|axis| axis.size)
        .unwrap_or(1);

    let mut channels: Vec<ImageChannelSettings> = Vec::new();
    for index in 0..channel_count {
        channels.push(ImageChannelSettings {
            index,
            enabled: true,
            color_rgba: None,
            contrast: None,
            gamma: 1.0,
        });
    }
    channels
}

fn default_channel_from_metadata(channel: &ChannelDef) -> ImageChannelSettings {
    let contrast = channel.suggested_contrast.as_ref().map(|suggested| {
        let policy = match suggested.policy {
            Some(ContrastPolicy::Fixed) => ChannelContrastPolicy::Fixed,
            Some(ContrastPolicy::Percentile) => ChannelContrastPolicy::Percentile,
            None if suggested.min.is_some() => ChannelContrastPolicy::Fixed,
            None => ChannelContrastPolicy::Percentile,
        };
        ChannelContrast {
            policy,
            min: suggested.min,
            max: suggested.max,
            p_low: suggested.p_low.unwrap_or(1.0),
            p_high: suggested.p_high.unwrap_or(99.0),
        }
    });

    ImageChannelSettings {
        index: channel.index,
        enabled: true,
        color_rgba: channel.color_rgba,
        contrast,
        gamma: channel.suggested_gamma.unwrap_or(1.0),
    }
}

fn normalize_index_selector(
    selector: &AxisSelector,
    axis_size: i64,
) -> Result<(AxisSelector, Option<ApiWarning>), ApiError> {
    let requested = selector.index.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Index selector requires index.",
            Some(json!({ "axis": selector.axis })),
        )
    })?;

    if !selector.clamp && !(0 <= requested && requested < axis_size) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Selector index is out of bounds and clamp is disabled.",
            Some(json!({
                "axis": selector.axis,
                "index": requested,
                "size": axis_size,
            })),
        ));
    }

    let applied = clamp_index(requested, axis_size);
    let warning = if applied != requested {
        Some(ApiWarning {
            code: "selector_clamped".to_owned(),
            message: "Selector index was clamped to fit axis bounds.".to_owned(),
            details: Some(json!({
                "axis": selector.axis,
                "requested": requested,
                "applied": applied,
            })),
        })
    } else {
        None
    };

    Ok((
        AxisSelector {
            axis: selector.axis.clone(),
            kind: AxisSelectorKind::Index,
            index: Some(applied),
            start: None,
            end_exclusive: None,
            indices: None,
            clamp: selector.clamp,
        },
        warning,
    ))
}

fn normalize_range_selector(
    selector: &AxisSelector,
    axis_size: i64,
) -> Result<(AxisSelector, Option<ApiWarning>), ApiError> {
    let requested_start = selector.start.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Range selector requires start and end_exclusive.",
            Some(json!({ "axis": selector.axis })),
        )
    })?;
    let requested_end = selector.end_exclusive.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Range selector requires start and end_exclusive.",
            Some(json!({ "axis": selector.axis })),
        )
    })?;

    if !selector.clamp
        && !(0 <= requested_start && requested_start < requested_end && requested_end <= axis_size)
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Selector range is out of bounds and clamp is disabled.",
            Some(json!({
                "axis": selector.axis,
                "start": requested_start,
                "end_exclusive": requested_end,
                "size": axis_size,
            })),
        ));
    }

    let mut start = clamp_index(requested_start, axis_size);
    let mut end = requested_end.max(1).min(axis_size);
    if start >= end {
        end = (start + 1).min(axis_size);
        if start >= end {
            start = (end - 1).max(0);
        }
    }

    let warning = if start != requested_start || end != requested_end {
        Some(ApiWarning {
            code: "selector_clamped".to_owned(),
            message: "Selector range was clamped to fit axis bounds.".to_owned(),
            details: Some(json!({
                "axis": selector.axis,
                "requested": {
                    "start": requested_start,
                    "end_exclusive": requested_end,
                },
                "applied": {
                    "start": start,
                    "end_exclusive": end,
                },
            })),
        })
    } else {
        None
    };

    Ok((
        AxisSelector {
            axis: selector.axis.clone(),
            kind: AxisSelectorKind::Range,
            index: None,
            start: Some(start),
            end_exclusive: Some(end),
            indices: None,
            clamp: selector.clamp,
        },
        warning,
    ))
}

fn normalize_set_selector(
    selector: &AxisSelector,
    axis_size: i64,
) -> Result<(AxisSelector, Option<ApiWarning>), ApiError> {
    let requested_indices = selector.indices.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "selector_out_of_bounds",
            "Set selector requires indices.",
            Some(json!({ "axis": selector.axis })),
        )
    })?;

    if !selector.clamp {
        if requested_indices.is_empty() {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "selector_out_of_bounds",
                "Selector set cannot be empty when clamp is disabled.",
                Some(json!({ "axis": selector.axis })),
            ));
        }
        if requested_indices
            .iter()
            .any(|index| *index < 0 || *index >= axis_size)
        {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "selector_out_of_bounds",
                "Selector set contains out-of-bounds values and clamp is disabled.",
                Some(json!({
                    "axis": selector.axis,
                    "indices": requested_indices,
                    "size": axis_size,
                })),
            ));
        }

        let mut normalized = requested_indices.clone();
        normalized.sort_unstable();
        normalized.dedup();

        return Ok((
            AxisSelector {
                axis: selector.axis.clone(),
                kind: AxisSelectorKind::Set,
                index: None,
                start: None,
                end_exclusive: None,
                indices: Some(normalized),
                clamp: false,
            },
            None,
        ));
    }

    let mut clamped: Vec<i64> = requested_indices
        .iter()
        .map(|index| clamp_index(*index, axis_size))
        .collect();
    clamped.sort_unstable();
    clamped.dedup();
    if clamped.is_empty() {
        clamped.push(0);
    }

    let mut requested_unique = requested_indices.clone();
    requested_unique.sort_unstable();
    requested_unique.dedup();

    let warning = if clamped != requested_unique {
        Some(ApiWarning {
            code: "selector_clamped".to_owned(),
            message: "Selector set was normalized to fit axis bounds.".to_owned(),
            details: Some(json!({
                "axis": selector.axis,
                "requested": requested_indices,
                "applied": clamped,
            })),
        })
    } else {
        None
    };

    Ok((
        AxisSelector {
            axis: selector.axis.clone(),
            kind: AxisSelectorKind::Set,
            index: None,
            start: None,
            end_exclusive: None,
            indices: Some(clamped),
            clamp: true,
        },
        warning,
    ))
}

fn clamp_index(value: i64, axis_size: i64) -> i64 {
    value.max(0).min(axis_size - 1)
}

fn selector_index_for_axis(selectors: &[AxisSelector], axis_name: &str) -> i64 {
    let selector = selectors.iter().find(|selector| selector.axis == axis_name);
    match selector {
        None => 0,
        Some(selector) => match selector.kind {
            AxisSelectorKind::Index => selector.index.unwrap_or(0),
            AxisSelectorKind::Range => selector.start.unwrap_or(0),
            AxisSelectorKind::Set => selector
                .indices
                .as_ref()
                .and_then(|indices| indices.first().copied())
                .unwrap_or(0),
        },
    }
}

pub fn plane_role_triplet(plane: &Plane2D) -> (&'static str, &'static str, &'static str) {
    match plane {
        Plane2D::Xy => ("x", "y", "z"),
        Plane2D::Xz => ("x", "z", "y"),
        Plane2D::Yz => ("y", "z", "x"),
    }
}

pub fn axis_name_for_role(
    dataset_summary: &DatasetSummary,
    role: &str,
    plane: &Plane2D,
) -> Result<String, ApiError> {
    if let Some(axis) = dataset_summary
        .axes
        .iter()
        .find(|axis| axis_role_name(axis) == role)
    {
        return Ok(axis.name.clone());
    }

    let (role_a, role_b, role_c) = plane_role_triplet(plane);
    let missing_roles: Vec<&str> = [role_a, role_b, role_c]
        .into_iter()
        .filter(|required_role| {
            !dataset_summary
                .axes
                .iter()
                .any(|axis| axis_role_name(axis) == *required_role)
        })
        .collect();

    Err(ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "unsupported_plane",
        "Requested plane is unsupported for dataset axes.",
        Some(json!({
            "plane": plane_name(plane),
            "missing_roles": missing_roles,
            "dataset_id": dataset_summary.dataset_id,
        })),
    ))
}

pub fn axis_role_name(axis: &AxisDef) -> &'static str {
    match axis.role {
        AxisRole::X => "x",
        AxisRole::Y => "y",
        AxisRole::Z => "z",
        AxisRole::C => "c",
        AxisRole::T => "t",
        AxisRole::Other => "other",
    }
}

fn canonicalize_for_hash(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: BTreeMap<String, Value> = BTreeMap::new();
            for (key, item) in map {
                sorted.insert(key, canonicalize_for_hash(item));
            }
            let normalized = sorted
                .into_iter()
                .collect::<serde_json::Map<String, Value>>();
            Value::Object(normalized)
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(canonicalize_for_hash)
                .collect::<Vec<Value>>(),
        ),
        Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                Value::Number(number)
            } else {
                let mut quantized =
                    (number.as_f64().unwrap_or(0.0) * 1_000_000.0).round() / 1_000_000.0;
                if quantized == -0.0 {
                    quantized = 0.0;
                }
                Value::Number(Number::from_f64(quantized).unwrap_or_else(|| Number::from(0)))
            }
        }
        other => other,
    }
}
