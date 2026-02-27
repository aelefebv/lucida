use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::dto::api::ApiWarning;
use crate::dto::render::{
    RenderArtifactRole, RenderAxisSelector, RenderBackendUsed, RenderDelivery, RenderFormat,
    RenderImageArtifact, RenderImageResponse, RenderMeta, RenderMimeType, RenderOutputSpec,
    RenderPixelFormat, RenderStatus, RenderTimingMs, RenderTimingStagesMs,
};
use crate::dto::view_state::{RenderMode, ViewState};
use crate::error::ApiError;
use crate::render_backend::{select_render_backend, RenderBackend};
use crate::render_cache::SessionCacheSnapshot;
use crate::render_cpu::{render_view_to_png, render_view_to_rgba, RenderRgbaResult};
use crate::render_gpu::{render_view_to_png_gpu, render_view_to_rgba_gpu};
use crate::request_validation::{
    expect_body_object, invalid_request_error, parse_optional_non_empty_string,
    parse_optional_patch_list, parse_optional_typed, parse_required_positive_u64,
    parse_schema_version, push_extra_forbidden_errors, push_schema_version_literal_error,
};
use crate::state::{require_session, SharedAppState};
use crate::view_state_core::{
    compute_state_hash, invalid_patch_error, normalize_selectors, normalize_view_2d,
    resolve_primary_dataset_for_view, validate_immutable_view_fields, validate_multiscale_name,
    validate_view_state,
};

#[derive(Debug, Clone)]
struct ParsedRenderImageRequest {
    view_id: Option<String>,
    view_state: Option<ViewState>,
    session_id: Option<String>,
    request_id: Option<String>,
    overrides_json_patch: Option<Vec<Value>>,
    output: RenderOutputSpec,
}

#[derive(Debug, Clone)]
struct EncodedRenderArtifact {
    bytes: Vec<u8>,
    mime: RenderMimeType,
    pixel_format: Option<RenderPixelFormat>,
    bytes_per_pixel: Option<u8>,
    row_stride_bytes: Option<u64>,
    pyramid_level_used: u64,
    warnings: Vec<ApiWarning>,
    timing_ms: Option<RenderTimingMs>,
}

fn rgba_timing_ms(total_ms: f64, rgba_result: &RenderRgbaResult) -> RenderTimingMs {
    RenderTimingMs {
        total: total_ms,
        io: rgba_result.chunk_fetch_ms,
        decode: rgba_result.chunk_decode_ms,
        gpu_upload: rgba_result.gpu_upload_ms,
        render: rgba_result.sample_ms + rgba_result.compose_ms + rgba_result.gpu_compute_ms,
        stages: Some(RenderTimingStagesMs {
            chunk_fetch: rgba_result.chunk_fetch_ms,
            chunk_decode: rgba_result.chunk_decode_ms,
            sample: rgba_result.sample_ms,
            compose: rgba_result.compose_ms,
            encode: 0.0,
            gpu_compute: rgba_result.gpu_compute_ms,
            gpu_readback: rgba_result.gpu_readback_ms,
        }),
    }
}

fn backend_used_for(backend: RenderBackend) -> RenderBackendUsed {
    match backend {
        RenderBackend::Cpu => RenderBackendUsed::Cpu,
        RenderBackend::Gpu => RenderBackendUsed::Gpu,
    }
}

pub async fn render_image(
    State(state): State<SharedAppState>,
    payload: Result<Json<Value>, JsonRejection>,
) -> Result<Json<RenderImageResponse>, ApiError> {
    let payload = match payload {
        Ok(payload) => payload.0,
        Err(rejection) => {
            return Err(invalid_request_error(vec![json!({
                "loc": ["body"],
                "msg": rejection.body_text(),
                "type": "invalid_json",
            })]));
        }
    };

    let request = parse_render_image_request(payload)?;
    let has_view_id = request.view_id.is_some();
    let has_view_state = request.view_state.is_some();
    if has_view_id == has_view_state {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_render_request",
            "Render request must provide exactly one of view_id or view_state.",
            Some(json!({
                "has_view_id": has_view_id,
                "has_view_state": has_view_state,
            })),
        ));
    }

    if request.output.width_px > 4096
        || request.output.height_px > 4096
        || request
            .output
            .width_px
            .saturating_mul(request.output.height_px)
            > 16_777_216
    {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_output_too_large",
            "Requested render output exceeds configured limits.",
            Some(json!({
                "width_px": request.output.width_px,
                "height_px": request.output.height_px,
                "max_width_px": 4096,
                "max_height_px": 4096,
                "max_pixels": 16_777_216,
            })),
        ));
    }

    let resolved_request_id = request
        .request_id
        .clone()
        .unwrap_or_else(|| format!("req_{}", &Uuid::new_v4().simple().to_string()[..16]));
    let render_id = format!("ren_{}", &Uuid::new_v4().simple().to_string()[..16]);

    let (
        effective_view,
        dataset_summary,
        response_view_id,
        response_state_version,
        selectors,
        selector_warnings,
        view_warnings,
        state_hash,
        cache_registry,
        cache_session_id,
        runtime_capabilities,
    ) = {
        let mut app_state = state.write().await;
        let cache_registry = app_state.render_caches.clone();
        let runtime_capabilities = app_state.runtime_capabilities.clone();

        let scoped_session_id = if let Some(session_id) = request.session_id.as_deref() {
            require_session(&app_state, session_id)?;
            Some(session_id.to_owned())
        } else {
            None
        };

        let mut stored_view_state: Option<ViewState> = None;
        let mut response_view_id: Option<String> = None;
        let mut response_state_version: Option<u64> = None;
        let mut effective_payload = if let Some(view_id) = request.view_id.as_deref() {
            let view_record = app_state.views_by_id.get(view_id).ok_or_else(|| {
                ApiError::new(
                    StatusCode::NOT_FOUND,
                    "view_not_found",
                    "View was not found.",
                    Some(json!({ "view_id": view_id })),
                )
            })?;

            if let Some(session_id) = scoped_session_id.as_deref() {
                let session = require_session(&app_state, session_id)?;
                if !session.view_ids.contains(view_id) {
                    return Err(ApiError::new(
                        StatusCode::NOT_FOUND,
                        "view_not_found",
                        "View was not found in session.",
                        Some(json!({
                            "view_id": view_id,
                            "session_id": session_id,
                        })),
                    ));
                }
            }

            stored_view_state = Some(view_record.view_state.clone());
            response_view_id = Some(view_record.view_state.view_id.clone());
            response_state_version = Some(view_record.view_state.state_version);
            serde_json::to_value(&view_record.view_state).expect("serialize view state")
        } else {
            serde_json::to_value(request.view_state.as_ref().expect("view_state present"))
                .expect("serialize view state")
        };

        if let Some(patch_items) = request.overrides_json_patch.as_ref() {
            let patch: json_patch::Patch =
                serde_json::from_value(Value::Array(patch_items.clone())).map_err(|error| {
                    invalid_patch_error(
                        request.view_id.as_deref(),
                        "Failed to apply render-time JSON patch overrides.",
                        &error.to_string(),
                    )
                })?;
            json_patch::patch(&mut effective_payload, &patch).map_err(|error| {
                invalid_patch_error(
                    request.view_id.as_deref(),
                    "Failed to apply render-time JSON patch overrides.",
                    &error.to_string(),
                )
            })?;
        }

        let mut effective_view: ViewState =
            serde_json::from_value(effective_payload).map_err(|error| {
                if request.view_id.is_some() {
                    invalid_patch_error(
                        request.view_id.as_deref(),
                        "Render-time patched view state did not validate.",
                        &error.to_string(),
                    )
                } else {
                    ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "invalid_render_request",
                        "Provided view_state did not validate.",
                        Some(json!({
                            "view_id": request.view_id,
                            "reason": error.to_string(),
                        })),
                    )
                }
            })?;

        validate_view_state(&effective_view).map_err(|reason| {
            if request.view_id.is_some() {
                invalid_patch_error(
                    request.view_id.as_deref(),
                    "Render-time patched view state did not validate.",
                    &reason,
                )
            } else {
                ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_render_request",
                    "Provided view_state did not validate.",
                    Some(json!({
                        "view_id": request.view_id,
                        "reason": reason,
                    })),
                )
            }
        })?;

        if effective_view.mode != RenderMode::TwoD {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unsupported_mode",
                "Only mode=2d is supported in this slice.",
                Some(json!({ "mode": "3d" })),
            ));
        }

        let dataset_summary = if let Some(current_view_state) = stored_view_state.as_ref() {
            validate_immutable_view_fields(current_view_state, &effective_view)?;
            let session_id = scoped_session_id
                .clone()
                .unwrap_or_else(|| current_view_state.session_id.clone());
            require_session(&app_state, &session_id)?;
            resolve_primary_dataset_for_view(&mut app_state, &effective_view, &session_id)?
        } else {
            let dataset_ref = effective_view.datasets.first().ok_or_else(|| {
                ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_render_request",
                    "Provided view_state did not validate.",
                    Some(json!({"reason": "View state must include at least one dataset reference." })),
                )
            })?;
            let dataset_summary = app_state
                .datasets_by_id
                .get(&dataset_ref.dataset_id)
                .map(|record| record.dataset_summary.clone())
                .ok_or_else(|| {
                    ApiError::new(
                        StatusCode::NOT_FOUND,
                        "dataset_not_found",
                        "Dataset was not found.",
                        Some(json!({ "dataset_id": dataset_ref.dataset_id })),
                    )
                })?;
            validate_multiscale_name(&dataset_summary, &dataset_ref.multiscale_name)?;
            dataset_summary
        };

        let (selectors, selector_warnings) =
            normalize_selectors(&effective_view.selectors, &dataset_summary, "render_image")?;
        effective_view.selectors = selectors.clone();

        let view_2d = effective_view.view_2d.clone().ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_render_request",
                "Provided view_state did not validate.",
                Some(json!({ "reason": "mode=2d requires view_2d." })),
            )
        })?;
        let (normalized_view_2d, view_warnings) =
            normalize_view_2d(view_2d, &dataset_summary, &selectors)?;
        effective_view.view_2d = Some(normalized_view_2d);

        let state_hash = compute_state_hash(&effective_view);
        let cache_session_id = scoped_session_id
            .clone()
            .unwrap_or_else(|| effective_view.session_id.clone());

        (
            effective_view,
            dataset_summary,
            response_view_id,
            response_state_version,
            selectors,
            selector_warnings,
            view_warnings,
            state_hash,
            cache_registry,
            cache_session_id,
            runtime_capabilities,
        )
    };

    let gpu_capabilities = runtime_capabilities.gpu_capabilities().await;
    let backend_selection = select_render_backend(
        effective_view.performance.as_ref(),
        gpu_capabilities.available,
        gpu_capabilities.adapter_name.as_deref(),
    );
    tracing::debug!(
        selected_backend = backend_selection.backend.as_str(),
        gpu_hardware_available = gpu_capabilities.available,
        gpu_adapter_name = gpu_capabilities.adapter_name.as_deref().unwrap_or(""),
        gpu_backend = gpu_capabilities.backend.as_deref().unwrap_or(""),
        "render backend selection"
    );

    let (rendered_artifact, cache_snapshot, cache_budgets, backend_warnings, actual_backend) = {
        let mut cache_state = cache_registry.write().await;
        let cache_budgets =
            cache_state.resolve_effective_budgets(effective_view.performance.as_ref());
        let mut backend_warnings = backend_selection.warnings;
        let (rendered_artifact, actual_backend) = match request.output.format.clone() {
            RenderFormat::Png => {
                let (render_result, actual_backend) = match backend_selection.backend {
                    RenderBackend::Cpu => (
                        render_view_to_png(
                            &dataset_summary,
                            &effective_view,
                            &request.output,
                            &mut cache_state,
                            &cache_session_id,
                            cache_budgets,
                        )?,
                        RenderBackend::Cpu,
                    ),
                    RenderBackend::Gpu => match render_view_to_png_gpu(
                        &dataset_summary,
                        &effective_view,
                        &request.output,
                        &mut cache_state,
                        &cache_session_id,
                        cache_budgets,
                    ) {
                        Ok(result) => (result, RenderBackend::Gpu),
                        Err(error) => {
                            tracing::warn!(
                                error_code = %error.envelope.code,
                                error_message = %error.envelope.message,
                                "gpu render failed; falling back to cpu renderer"
                            );
                            backend_warnings.push(ApiWarning {
                                code: "gpu_render_failed_fallback_cpu".to_owned(),
                                message:
                                    "GPU rendering failed at runtime; CPU renderer was used for this request."
                                        .to_owned(),
                                details: Some(json!({
                                    "error_code": error.envelope.code,
                                    "error_message": error.envelope.message,
                                    "error_details": error.envelope.details,
                                    "requested_backend": "gpu",
                                    "fallback_backend": "cpu",
                                    "gpu_hardware_available": gpu_capabilities.available,
                                    "gpu_adapter_name": gpu_capabilities.adapter_name.as_deref(),
                                    "gpu_backend": gpu_capabilities.backend.as_deref(),
                                })),
                            });
                            (
                                render_view_to_png(
                                    &dataset_summary,
                                    &effective_view,
                                    &request.output,
                                    &mut cache_state,
                                    &cache_session_id,
                                    cache_budgets,
                                )?,
                                RenderBackend::Cpu,
                            )
                        }
                    },
                };
                (
                    EncodedRenderArtifact {
                        bytes: render_result.png_bytes,
                        mime: RenderMimeType::Png,
                        pixel_format: None,
                        bytes_per_pixel: None,
                        row_stride_bytes: None,
                        pyramid_level_used: render_result.pyramid_level_used,
                        warnings: render_result.warnings,
                        timing_ms: render_result.timing_ms,
                    },
                    actual_backend,
                )
            }
            RenderFormat::RawRgba => {
                let render_start = Instant::now();
                let (rgba_result, actual_backend) = match backend_selection.backend {
                    RenderBackend::Cpu => (
                        render_view_to_rgba(
                            &dataset_summary,
                            &effective_view,
                            &request.output,
                            &mut cache_state,
                            &cache_session_id,
                            cache_budgets,
                        )?,
                        RenderBackend::Cpu,
                    ),
                    RenderBackend::Gpu => match render_view_to_rgba_gpu(
                        &dataset_summary,
                        &effective_view,
                        &request.output,
                        &mut cache_state,
                        &cache_session_id,
                        cache_budgets,
                    ) {
                        Ok(result) => (result, RenderBackend::Gpu),
                        Err(error) => {
                            tracing::warn!(
                                error_code = %error.envelope.code,
                                error_message = %error.envelope.message,
                                "gpu render failed; falling back to cpu renderer"
                            );
                            backend_warnings.push(ApiWarning {
                                code: "gpu_render_failed_fallback_cpu".to_owned(),
                                message:
                                    "GPU rendering failed at runtime; CPU renderer was used for this request."
                                        .to_owned(),
                                details: Some(json!({
                                    "error_code": error.envelope.code,
                                    "error_message": error.envelope.message,
                                    "error_details": error.envelope.details,
                                    "requested_backend": "gpu",
                                    "fallback_backend": "cpu",
                                    "gpu_hardware_available": gpu_capabilities.available,
                                    "gpu_adapter_name": gpu_capabilities.adapter_name.as_deref(),
                                    "gpu_backend": gpu_capabilities.backend.as_deref(),
                                })),
                            });
                            (
                                render_view_to_rgba(
                                    &dataset_summary,
                                    &effective_view,
                                    &request.output,
                                    &mut cache_state,
                                    &cache_session_id,
                                    cache_budgets,
                                )?,
                                RenderBackend::Cpu,
                            )
                        }
                    },
                };
                let total_ms = (Instant::now() - render_start).as_secs_f64() * 1000.0;
                let timing_ms = Some(rgba_timing_ms(total_ms, &rgba_result));
                (
                    EncodedRenderArtifact {
                        bytes: rgba_result.rgba_bytes,
                        mime: RenderMimeType::RawRgba,
                        pixel_format: Some(RenderPixelFormat::Rgba8),
                        bytes_per_pixel: Some(4),
                        row_stride_bytes: Some(request.output.width_px.saturating_mul(4)),
                        pyramid_level_used: rgba_result.pyramid_level_used,
                        warnings: rgba_result.warnings,
                        timing_ms,
                    },
                    actual_backend,
                )
            }
        };
        let cache_snapshot = cache_state.session_snapshot(&cache_session_id);
        (
            rendered_artifact,
            cache_snapshot,
            cache_budgets,
            backend_warnings,
            actual_backend,
        )
    };

    log_cache_snapshot(&cache_session_id, cache_snapshot.as_ref(), cache_budgets);

    let payload_sha256 = {
        let mut hasher = Sha256::new();
        hasher.update(&rendered_artifact.bytes);
        format!("{:x}", hasher.finalize())
    };

    let mut warnings = selector_warnings;
    warnings.extend(view_warnings);
    warnings.extend(backend_warnings);
    warnings.extend(rendered_artifact.warnings.clone());

    let artifact = match request.output.delivery {
        RenderDelivery::InlineBase64 => RenderImageArtifact {
            role: RenderArtifactRole::Main,
            mime: rendered_artifact.mime.clone(),
            pixel_format: rendered_artifact.pixel_format.clone(),
            bytes_per_pixel: rendered_artifact.bytes_per_pixel,
            row_stride_bytes: rendered_artifact.row_stride_bytes,
            width_px: request.output.width_px,
            height_px: request.output.height_px,
            delivery: RenderDelivery::InlineBase64,
            bytes_base64: Some(BASE64_STANDARD.encode(&rendered_artifact.bytes)),
            file_path: None,
            sha256: payload_sha256,
        },
        RenderDelivery::FilePath => {
            let output_path =
                resolve_snapshot_output_path(request.output.file_path.as_deref(), &render_id)?;
            ensure_output_parent_within_root(&output_path)?;
            std::fs::write(&output_path, &rendered_artifact.bytes).map_err(|error| {
                ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "render_failed",
                    "Failed to write rendered image artifact.",
                    Some(json!({ "reason": error.to_string() })),
                )
            })?;

            RenderImageArtifact {
                role: RenderArtifactRole::Main,
                mime: rendered_artifact.mime.clone(),
                pixel_format: rendered_artifact.pixel_format.clone(),
                bytes_per_pixel: rendered_artifact.bytes_per_pixel,
                row_stride_bytes: rendered_artifact.row_stride_bytes,
                width_px: request.output.width_px,
                height_px: request.output.height_px,
                delivery: RenderDelivery::FilePath,
                bytes_base64: None,
                file_path: Some(output_path.to_string_lossy().to_string()),
                sha256: payload_sha256,
            }
        }
    };

    Ok(Json(RenderImageResponse {
        schema_version: 1,
        request_id: resolved_request_id,
        render_id,
        status: RenderStatus::Ok,
        completion: 1.0,
        view_id: response_view_id,
        state_hash,
        state_version: response_state_version,
        images: vec![artifact],
        meta: RenderMeta {
            dataset_id: dataset_summary.dataset_id.clone(),
            multiscale_name: effective_view.datasets[0].multiscale_name.clone(),
            pyramid_level_used: rendered_artifact.pyramid_level_used,
            selectors_applied: selectors.iter().map(RenderAxisSelector::from).collect(),
            backend_used: backend_used_for(actual_backend),
            timing_ms: rendered_artifact.timing_ms.unwrap_or(RenderTimingMs {
                total: 0.0,
                io: 0.0,
                decode: 0.0,
                gpu_upload: 0.0,
                render: 0.0,
                stages: None,
            }),
        },
        warnings,
    }))
}

fn log_cache_snapshot(
    session_id: &str,
    cache_snapshot: Option<&SessionCacheSnapshot>,
    cache_budgets: crate::render_cache::EffectiveCacheBudgets,
) {
    if let Some(snapshot) = cache_snapshot {
        tracing::debug!(
            target: "lucida.cache",
            session_id = session_id,
            cpu_hits = snapshot.cpu.hits,
            cpu_misses = snapshot.cpu.misses,
            cpu_inserts = snapshot.cpu.inserts,
            cpu_evictions = snapshot.cpu.evictions,
            cpu_current_bytes = snapshot.cpu.current_bytes,
            cpu_max_bytes = snapshot.cpu.max_bytes,
            gpu_hits = snapshot.gpu.hits,
            gpu_misses = snapshot.gpu.misses,
            gpu_inserts = snapshot.gpu.inserts,
            gpu_evictions = snapshot.gpu.evictions,
            gpu_current_bytes = snapshot.gpu.current_bytes,
            gpu_max_bytes = snapshot.gpu.max_bytes,
            configured_cpu_budget = cache_budgets.max_cpu_cache_bytes,
            configured_gpu_budget = cache_budgets.max_gpu_cache_bytes,
            "render cache snapshot"
        );
    }
}

fn parse_render_image_request(payload: Value) -> Result<ParsedRenderImageRequest, ApiError> {
    let object = expect_body_object(payload)?;

    let mut errors: Vec<Value> = Vec::new();
    let allowed_keys = [
        "schema_version",
        "view_id",
        "view_state",
        "session_id",
        "request_id",
        "overrides_json_patch",
        "output",
    ];
    push_extra_forbidden_errors(&object, &allowed_keys, &mut errors);

    let schema_version = parse_schema_version(&object, &mut errors);
    if schema_version != 1 {
        push_schema_version_literal_error(&mut errors);
    }

    let view_id = parse_optional_non_empty_string(&object, "view_id", &mut errors);
    let session_id = parse_optional_non_empty_string(&object, "session_id", &mut errors);
    let request_id = parse_optional_non_empty_string(&object, "request_id", &mut errors);

    let view_state = parse_optional_typed::<ViewState>(&object, "view_state", &mut errors);
    let output = parse_required_output(&object, &mut errors);
    let overrides_json_patch =
        parse_optional_patch_list(&object, "overrides_json_patch", &mut errors, &["body"]);

    if !errors.is_empty() {
        return Err(invalid_request_error(errors));
    }

    Ok(ParsedRenderImageRequest {
        view_id,
        view_state,
        session_id,
        request_id,
        overrides_json_patch,
        output: output.expect("validated output"),
    })
}

fn parse_required_output(
    object: &serde_json::Map<String, Value>,
    errors: &mut Vec<Value>,
) -> Option<RenderOutputSpec> {
    let value = match object.get("output") {
        Some(value) => value,
        None => {
            errors.push(json!({
                "loc": ["body", "output"],
                "msg": "Field required.",
                "type": "missing",
            }));
            return None;
        }
    };
    let Some(output_obj) = value.as_object() else {
        errors.push(json!({
            "loc": ["body", "output"],
            "msg": "Input should be a valid dictionary.",
            "type": "dict_type",
        }));
        return None;
    };

    let allowed = ["format", "delivery", "file_path", "width_px", "height_px"];
    for key in output_obj.keys() {
        if !allowed.contains(&key.as_str()) {
            errors.push(json!({
                "loc": ["body", "output", key],
                "msg": "Extra inputs are not permitted.",
                "type": "extra_forbidden",
            }));
        }
    }

    let format = match output_obj.get("format") {
        None => RenderFormat::Png,
        Some(value) => match value.as_str() {
            Some("png") => RenderFormat::Png,
            Some("raw_rgba") => RenderFormat::RawRgba,
            _ => {
                errors.push(json!({
                    "loc": ["body", "output", "format"],
                    "msg": "Input should be 'png' or 'raw_rgba'.",
                    "type": "literal_error",
                }));
                RenderFormat::Png
            }
        },
    };
    let delivery = match output_obj.get("delivery") {
        None => RenderDelivery::InlineBase64,
        Some(value) => match value.as_str() {
            Some("inline_base64") => RenderDelivery::InlineBase64,
            Some("file_path") => RenderDelivery::FilePath,
            _ => {
                errors.push(json!({
                    "loc": ["body", "output", "delivery"],
                    "msg": "Input should be 'inline_base64' or 'file_path'.",
                    "type": "literal_error",
                }));
                RenderDelivery::InlineBase64
            }
        },
    };

    let width_px = parse_required_positive_u64(output_obj, "width_px", errors, &["body", "output"]);
    let height_px =
        parse_required_positive_u64(output_obj, "height_px", errors, &["body", "output"]);
    let file_path = parse_optional_non_empty_string_nested(output_obj, "file_path", errors);

    if format == RenderFormat::RawRgba && delivery == RenderDelivery::FilePath {
        errors.push(json!({
            "loc": ["body", "output", "delivery"],
            "msg": "raw_rgba format supports only inline_base64 delivery.",
            "type": "literal_error",
        }));
    }

    if width_px.is_none() || height_px.is_none() {
        return None;
    }

    Some(RenderOutputSpec {
        format,
        delivery,
        file_path,
        width_px: width_px.unwrap_or(1),
        height_px: height_px.unwrap_or(1),
    })
}

fn parse_optional_non_empty_string_nested(
    object: &serde_json::Map<String, Value>,
    key: &str,
    errors: &mut Vec<Value>,
) -> Option<String> {
    let value = object.get(key)?;
    if value.is_null() {
        return None;
    }
    if let Some(as_str) = value.as_str() {
        if as_str.is_empty() {
            errors.push(json!({
                "loc": ["body", "output", key],
                "msg": "String should have at least 1 character.",
                "type": "string_too_short",
                "ctx": {"min_length": 1},
            }));
            return None;
        }
        return Some(as_str.to_owned());
    }
    errors.push(json!({
        "loc": ["body", "output", key],
        "msg": "Input should be a valid string.",
        "type": "string_type",
    }));
    None
}

fn resolve_snapshot_output_path(
    requested_path: Option<&str>,
    render_id: &str,
) -> Result<PathBuf, ApiError> {
    let output_root = output_root_dir();
    let target = if let Some(requested_path) = requested_path {
        let requested = PathBuf::from(requested_path).expand_tilde();
        if requested.is_absolute() {
            requested
        } else {
            output_root.join(requested)
        }
    } else {
        output_root
            .join("snapshots")
            .join(format!("{render_id}.png"))
    };
    let resolved_target = normalize_path_lexical(&target);
    if !resolved_target.starts_with(&output_root) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_output_path_invalid",
            "Requested render output path must be under the output directory.",
            Some(json!({
                "requested_path": requested_path,
                "output_root": output_root.to_string_lossy(),
            })),
        ));
    }
    Ok(resolved_target)
}

fn ensure_output_parent_within_root(output_path: &Path) -> Result<(), ApiError> {
    let output_root = output_root_dir();
    let Some(parent) = output_path.parent() else {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_output_path_invalid",
            "Requested render output path has no parent directory.",
            Some(json!({
                "requested_path": output_path.to_string_lossy(),
            })),
        ));
    };

    std::fs::create_dir_all(parent).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_failed",
            "Failed to write rendered image artifact.",
            Some(json!({ "reason": error.to_string() })),
        )
    })?;

    let canonical_output_root = std::fs::canonicalize(&output_root).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_output_path_invalid",
            "Failed to resolve output root.",
            Some(json!({
                "output_root": output_root.to_string_lossy(),
                "reason": error.to_string(),
            })),
        )
    })?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_output_path_invalid",
            "Failed to resolve output parent directory.",
            Some(json!({
                "parent": parent.to_string_lossy(),
                "reason": error.to_string(),
            })),
        )
    })?;
    if !canonical_parent.starts_with(&canonical_output_root) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "render_output_path_invalid",
            "Requested render output path must be under the output directory.",
            Some(json!({
                "requested_path": output_path.to_string_lossy(),
                "output_root": canonical_output_root.to_string_lossy(),
            })),
        ));
    }
    Ok(())
}

fn output_root_dir() -> PathBuf {
    normalize_path_lexical(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("output"),
    )
}

fn normalize_path_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    if normalized.as_os_str().is_empty() {
        PathBuf::from("/")
    } else {
        normalized
    }
}

trait ExpandTilde {
    fn expand_tilde(self) -> PathBuf;
}

impl ExpandTilde for PathBuf {
    fn expand_tilde(self) -> PathBuf {
        let raw = self.to_string_lossy().to_string();
        if raw == "~" {
            if let Some(home) = std::env::var_os("HOME") {
                return PathBuf::from(home);
            }
        }
        if let Some(rest) = raw.strip_prefix("~/") {
            if let Some(home) = std::env::var_os("HOME") {
                return PathBuf::from(home).join(rest);
            }
        }
        self
    }
}
