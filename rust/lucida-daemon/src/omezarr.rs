use std::fs;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use serde_json::{json, Map, Value};

use crate::dto::api::ApiWarning;
use crate::dto::dataset_summary::{
    AxisDef, AxisRole, ChannelDef, ContrastPolicy, MultiscaleImageDef, MultiscaleLevelDef,
    SuggestedContrast,
};
use crate::error::ApiError;
use crate::uri::file_uri_to_path;

#[derive(Debug, Clone)]
pub struct OmezarrReadResult {
    pub axes: Vec<AxisDef>,
    pub shape: Vec<u64>,
    pub dtype: String,
    pub channels: Vec<ChannelDef>,
    pub multiscales: Vec<MultiscaleImageDef>,
    pub raw_metadata: Value,
    pub recommended_tile_px: Option<(u64, u64)>,
}

pub fn read_omezarr(
    uri: &str,
    include_full_raw_metadata: bool,
) -> Result<(OmezarrReadResult, Vec<ApiWarning>), ApiError> {
    let root_path = file_uri_to_path(uri).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "dataset_open_failed",
            "Failed to open dataset store.",
            Some(json!({
                "uri": uri,
                "reason": "Unsupported URI scheme for dataset open.",
            })),
        )
    })?;
    let root_path = if root_path.is_absolute() {
        root_path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(root_path)
    };

    let root_attrs = read_group_attrs(&root_path).map_err(|reason| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "dataset_open_failed",
            "Failed to open dataset store.",
            Some(json!({
                "uri": uri,
                "reason": reason,
            })),
        )
    })?;

    let mut warnings: Vec<ApiWarning> = Vec::new();
    let multiscales_raw = root_attrs
        .get("multiscales")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_omezarr_missing_multiscales(uri))?;
    if multiscales_raw.is_empty() {
        return Err(invalid_omezarr_missing_multiscales(uri));
    }

    let mut parsed_multiscales: Vec<MultiscaleImageDef> = Vec::new();
    let mut first_axes: Option<Vec<AxisDef>> = None;
    let mut first_shape: Option<Vec<u64>> = None;
    let mut first_dtype: Option<String> = None;
    let mut level_metadata: Vec<Value> = Vec::new();

    for (multiscale_index, multiscale_raw) in multiscales_raw.iter().enumerate() {
        let multiscale_obj = multiscale_raw.as_object().ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_omezarr",
                "Invalid multiscale metadata entry.",
                Some(json!({"multiscale_index": multiscale_index})),
            )
        })?;

        let multiscale_name = if let Some(name) = multiscale_obj.get("name").and_then(Value::as_str)
        {
            if name.is_empty() {
                let inferred = format!("multiscale_{multiscale_index}");
                warnings.push(ApiWarning {
                    code: "multiscale_name_inferred".to_owned(),
                    message: "Multiscale name was missing; generated fallback name.".to_owned(),
                    details: Some(json!({
                        "multiscale_index": multiscale_index,
                        "name": inferred,
                    })),
                });
                inferred
            } else {
                name.to_owned()
            }
        } else {
            let inferred = format!("multiscale_{multiscale_index}");
            warnings.push(ApiWarning {
                code: "multiscale_name_inferred".to_owned(),
                message: "Multiscale name was missing; generated fallback name.".to_owned(),
                details: Some(json!({
                    "multiscale_index": multiscale_index,
                    "name": inferred,
                })),
            });
            inferred
        };

        let datasets_raw = multiscale_obj
            .get("datasets")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_omezarr",
                    "Multiscale metadata is missing datasets.",
                    Some(json!({"multiscale_index": multiscale_index})),
                )
            })?;
        if datasets_raw.is_empty() {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_omezarr",
                "Multiscale metadata is missing datasets.",
                Some(json!({"multiscale_index": multiscale_index})),
            ));
        }

        let mut level_defs: Vec<MultiscaleLevelDef> = Vec::new();
        let mut base_shape: Option<Vec<u64>> = None;
        let mut base_scale: Option<Vec<f64>> = None;
        let mut base_translation: Option<Vec<f64>> = None;

        for (level_index, dataset_raw) in datasets_raw.iter().enumerate() {
            let dataset_obj = dataset_raw.as_object().ok_or_else(|| {
                ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_omezarr",
                    "Invalid multiscale dataset entry.",
                    Some(json!({
                        "multiscale_index": multiscale_index,
                        "level": level_index,
                    })),
                )
            })?;

            let path = dataset_obj
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "invalid_omezarr",
                        "Multiscale dataset entry is missing path.",
                        Some(json!({
                            "multiscale_index": multiscale_index,
                            "level": level_index,
                        })),
                    )
                })?;
            if path.is_empty() {
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_omezarr",
                    "Multiscale dataset entry is missing path.",
                    Some(json!({
                        "multiscale_index": multiscale_index,
                        "level": level_index,
                    })),
                ));
            }

            let (shape, chunks, dtype, array_attrs) = read_array_metadata(&root_path, path)
                .map_err(|reason| {
                    ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "invalid_omezarr",
                        "Dataset level path could not be opened.",
                        Some(json!({
                            "multiscale_index": multiscale_index,
                            "level": level_index,
                            "path": path,
                            "reason": reason,
                        })),
                    )
                })?;

            let transformations = dataset_obj.get("coordinateTransformations").cloned();
            let level_scale = extract_transform_values(transformations.as_ref(), "scale");
            let level_translation =
                extract_transform_values(transformations.as_ref(), "translation");

            if level_index == 0 {
                base_shape = Some(shape.clone());
                base_scale = level_scale.clone();
                base_translation = level_translation.clone();
            }

            let (downsample_factors, used_fallback) = compute_downsample_factors(
                base_shape.as_ref(),
                &shape,
                base_scale.as_ref(),
                level_scale.as_ref(),
                level_index,
            );
            if used_fallback {
                warnings.push(ApiWarning {
                    code: "downsample_factors_inferred".to_owned(),
                    message: "Downsample factors were inferred from level shape.".to_owned(),
                    details: Some(json!({
                        "multiscale_index": multiscale_index,
                        "level": level_index,
                        "path": path,
                    })),
                });
            }

            level_defs.push(MultiscaleLevelDef {
                level: level_index as u64,
                path: path.to_owned(),
                shape: shape.clone(),
                chunks: chunks.clone(),
                downsample_factors: Some(downsample_factors),
                dtype: Some(dtype.clone()),
            });

            level_metadata.push(json!({
                "multiscale_name": multiscale_name,
                "multiscale_index": multiscale_index,
                "level": level_index,
                "path": path,
                "coordinate_transformations": transformations.unwrap_or(Value::Null),
                "array_attrs": collect_array_attrs(array_attrs, include_full_raw_metadata),
            }));
        }

        let base_shape_value = base_shape.clone().ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_omezarr",
                "Failed to parse OME-Zarr metadata.",
                Some(json!({"uri": uri})),
            )
        })?;

        let (axes_order, axis_defs) = parse_axes(
            multiscale_obj.get("axes"),
            &base_shape_value,
            base_scale.as_ref(),
            base_translation.as_ref(),
            &mut warnings,
            multiscale_index,
        );

        parsed_multiscales.push(MultiscaleImageDef {
            name: multiscale_name.clone(),
            axes_order,
            levels: level_defs.clone(),
        });

        if first_axes.is_none() {
            first_axes = Some(axis_defs);
            first_shape = Some(level_defs[0].shape.clone());
            first_dtype = level_defs[0].dtype.clone();
        }
    }

    let axes = first_axes.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_omezarr",
            "Failed to parse OME-Zarr metadata.",
            Some(json!({"uri": uri})),
        )
    })?;
    let shape = first_shape.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_omezarr",
            "Failed to parse OME-Zarr metadata.",
            Some(json!({"uri": uri})),
        )
    })?;
    let dtype = first_dtype.unwrap_or_else(|| "unknown".to_owned());

    let channels = parse_channels(root_attrs.get("omero"), &mut warnings);
    let recommended_tile_px =
        infer_recommended_tile_px(&axes, &parsed_multiscales[0].levels[0].chunks);

    let curated_root = if include_full_raw_metadata {
        Value::Object(root_attrs.clone())
    } else {
        let mut subset = Map::new();
        if let Some(multiscales) = root_attrs.get("multiscales") {
            subset.insert("multiscales".to_owned(), multiscales.clone());
        }
        if let Some(omero) = root_attrs.get("omero") {
            subset.insert("omero".to_owned(), omero.clone());
        }
        Value::Object(subset)
    };

    let raw_metadata = json!({
        "root": curated_root,
        "levels": level_metadata,
    });

    Ok((
        OmezarrReadResult {
            axes,
            shape,
            dtype,
            channels,
            multiscales: parsed_multiscales,
            raw_metadata,
            recommended_tile_px,
        },
        warnings,
    ))
}

fn invalid_omezarr_missing_multiscales(uri: &str) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_omezarr",
        "Dataset is missing required OME-Zarr multiscales metadata.",
        Some(json!({"uri": uri})),
    )
}

fn read_group_attrs(root_path: &Path) -> Result<Map<String, Value>, String> {
    if root_path.is_file() {
        return Err("Dataset URI must point to a directory store.".to_owned());
    }
    if !root_path.exists() {
        return Err("Dataset path does not exist.".to_owned());
    }

    let zarr_json_path = root_path.join("zarr.json");
    if zarr_json_path.exists() {
        let root_payload = read_json_file(&zarr_json_path)?;
        if let Some(attrs) = root_payload.get("attributes").and_then(Value::as_object) {
            return Ok(attrs.clone());
        }
        return Ok(Map::new());
    }

    let zattrs_path = root_path.join(".zattrs");
    if zattrs_path.exists() {
        let attrs_payload = read_json_file(&zattrs_path)?;
        if let Some(attrs) = attrs_payload.as_object() {
            return Ok(attrs.clone());
        }
        return Err("Invalid .zattrs payload.".to_owned());
    }

    Err("Could not locate zarr metadata files.".to_owned())
}

fn read_array_metadata(
    root_path: &Path,
    dataset_path: &str,
) -> Result<(Vec<u64>, Vec<u64>, String, Map<String, Value>), String> {
    let array_root = root_path.join(dataset_path);
    if !array_root.exists() {
        return Err("Dataset level path does not exist.".to_owned());
    }
    let zarr_json_path = array_root.join("zarr.json");
    if zarr_json_path.exists() {
        let payload = read_json_file(&zarr_json_path)?;
        let shape = payload
            .get("shape")
            .and_then(Value::as_array)
            .ok_or_else(|| "Array metadata missing shape.".to_owned())
            .and_then(parse_positive_u64_list)?;
        let dtype = payload
            .get("data_type")
            .and_then(Value::as_str)
            .or_else(|| payload.get("dtype").and_then(Value::as_str))
            .ok_or_else(|| "Array metadata missing data_type.".to_owned())?
            .to_owned();

        let chunks = payload
            .get("chunk_grid")
            .and_then(Value::as_object)
            .and_then(|chunk_grid| chunk_grid.get("configuration"))
            .and_then(Value::as_object)
            .and_then(|configuration| configuration.get("chunk_shape"))
            .and_then(Value::as_array)
            .map(parse_positive_u64_list)
            .transpose()?
            .unwrap_or_else(|| shape.clone());

        let attrs = payload
            .get("attributes")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        return Ok((shape, chunks, dtype, attrs));
    }

    let zarray_path = array_root.join(".zarray");
    if zarray_path.exists() {
        let payload = read_json_file(&zarray_path)?;
        let shape = payload
            .get("shape")
            .and_then(Value::as_array)
            .ok_or_else(|| "Array metadata missing shape.".to_owned())
            .and_then(parse_positive_u64_list)?;
        let chunks = payload
            .get("chunks")
            .and_then(Value::as_array)
            .map(parse_positive_u64_list)
            .transpose()?
            .unwrap_or_else(|| shape.clone());
        let dtype = payload
            .get("dtype")
            .and_then(Value::as_str)
            .ok_or_else(|| "Array metadata missing dtype.".to_owned())?
            .to_owned();
        let attrs = if array_root.join(".zattrs").exists() {
            let attrs_payload = read_json_file(&array_root.join(".zattrs"))?;
            attrs_payload.as_object().cloned().unwrap_or_default()
        } else {
            Map::new()
        };
        return Ok((shape, chunks, dtype, attrs));
    }

    Err("Could not locate level zarr metadata files.".to_owned())
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())
}

fn parse_positive_u64_list(values: &Vec<Value>) -> Result<Vec<u64>, String> {
    let mut parsed: Vec<u64> = Vec::with_capacity(values.len());
    for value in values {
        let parsed_value =
            value_to_u64(value).ok_or_else(|| "Invalid numeric list value.".to_owned())?;
        if parsed_value < 1 {
            return Err("Numeric list values must be >= 1.".to_owned());
        }
        parsed.push(parsed_value);
    }
    Ok(parsed)
}

fn value_to_u64(value: &Value) -> Option<u64> {
    if let Some(value) = value.as_u64() {
        return Some(value);
    }
    if let Some(value) = value.as_i64() {
        if value >= 0 {
            return Some(value as u64);
        }
    }
    if let Some(value) = value.as_f64() {
        if value.is_finite() && value >= 0.0 {
            return Some(value as u64);
        }
    }
    None
}

fn extract_transform_values(
    transformations: Option<&Value>,
    transform_type: &str,
) -> Option<Vec<f64>> {
    let transformations = transformations.and_then(Value::as_array)?;
    for transformation in transformations {
        let object = transformation.as_object()?;
        if object.get("type").and_then(Value::as_str) != Some(transform_type) {
            continue;
        }
        let values = object.get(transform_type)?.as_array()?;
        let mut parsed: Vec<f64> = Vec::with_capacity(values.len());
        for value in values {
            if let Some(float_value) = value.as_f64() {
                parsed.push(float_value);
            } else if let Some(int_value) = value.as_i64() {
                parsed.push(int_value as f64);
            } else if let Some(uint_value) = value.as_u64() {
                parsed.push(uint_value as f64);
            } else {
                return None;
            }
        }
        return Some(parsed);
    }
    None
}

fn compute_downsample_factors(
    base_shape: Option<&Vec<u64>>,
    level_shape: &Vec<u64>,
    base_scale: Option<&Vec<f64>>,
    level_scale: Option<&Vec<f64>>,
    level_index: usize,
) -> (Vec<f64>, bool) {
    if level_index == 0 {
        return (vec![1.0; level_shape.len()], false);
    }

    if let (Some(base_scale), Some(level_scale)) = (base_scale, level_scale) {
        if base_scale.len() == level_scale.len() && level_scale.len() == level_shape.len() {
            let factors = base_scale
                .iter()
                .zip(level_scale.iter())
                .map(|(base, level)| {
                    if *base == 0.0 {
                        1.0
                    } else {
                        f64::max(1.0, level / base)
                    }
                })
                .collect::<Vec<f64>>();
            return (factors, false);
        }
    }

    if let Some(base_shape) = base_shape {
        if base_shape.len() == level_shape.len() {
            let factors = base_shape
                .iter()
                .zip(level_shape.iter())
                .map(|(base, level)| {
                    if *level == 0 {
                        1.0
                    } else {
                        f64::max(1.0, (*base as f64) / (*level as f64))
                    }
                })
                .collect::<Vec<f64>>();
            return (factors, true);
        }
    }

    (vec![1.0; level_shape.len()], true)
}

fn parse_axes(
    axes_raw: Option<&Value>,
    shape: &Vec<u64>,
    base_scale: Option<&Vec<f64>>,
    base_translation: Option<&Vec<f64>>,
    warnings: &mut Vec<ApiWarning>,
    multiscale_index: usize,
) -> (Vec<String>, Vec<AxisDef>) {
    let mut normalized_axes: Vec<Value> = Vec::new();
    let mut inferred_axes_metadata = false;
    if let Some(raw_axes) = axes_raw.and_then(Value::as_array) {
        if raw_axes.len() == shape.len() {
            normalized_axes = raw_axes.clone();
        } else {
            inferred_axes_metadata = true;
        }
    } else {
        inferred_axes_metadata = true;
    }
    if inferred_axes_metadata {
        warnings.push(ApiWarning {
            code: "axes_metadata_inferred".to_owned(),
            message: "Axes metadata is missing or incompatible; generated generic axes.".to_owned(),
            details: Some(json!({"multiscale_index": multiscale_index})),
        });
        normalized_axes = (0..shape.len())
            .map(|index| Value::String(format!("axis_{index}")))
            .collect();
    }

    let mut axes_order: Vec<String> = Vec::new();
    let mut axis_defs: Vec<AxisDef> = Vec::new();
    for (index, axis_raw) in normalized_axes.iter().enumerate() {
        let axis_name: String;
        let mut axis_type: Option<String> = None;
        let mut unit: Option<String> = None;
        let mut direction_value: Option<i8> = Some(1);

        if let Some(axis_object) = axis_raw.as_object() {
            let fallback_name = format!("axis_{index}");
            axis_name = axis_object
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or(fallback_name);

            if let Some(axis_type_value) = axis_object.get("type").and_then(Value::as_str) {
                axis_type = Some(axis_type_value.to_ascii_lowercase());
            }
            unit = axis_object
                .get("unit")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            if let Some(direction) = axis_object.get("direction").and_then(Value::as_i64) {
                if direction == -1 || direction == 1 {
                    direction_value = Some(direction as i8);
                }
            }
        } else if let Some(axis_name_raw) = axis_raw.as_str() {
            axis_name = axis_name_raw.to_owned();
        } else {
            axis_name = format!("axis_{index}");
        }

        let axis_role = resolve_axis_role(axis_type.as_deref(), &axis_name);
        if matches!(axis_role, AxisRole::Other) {
            warnings.push(ApiWarning {
                code: "axis_role_inferred".to_owned(),
                message: "Axis role could not be determined and was set to 'other'.".to_owned(),
                details: Some(json!({
                    "multiscale_index": multiscale_index,
                    "axis": axis_name,
                })),
            });
        }
        let scale = base_scale.and_then(|values| values.get(index)).copied();
        let translation = base_translation
            .and_then(|values| values.get(index))
            .copied();

        axes_order.push(axis_name.clone());
        axis_defs.push(AxisDef {
            name: axis_name,
            role: axis_role,
            size: shape[index],
            unit,
            scale,
            translation,
            direction: direction_value,
        });
    }

    (axes_order, axis_defs)
}

fn resolve_axis_role(axis_type: Option<&str>, axis_name: &str) -> AxisRole {
    if let Some(axis_type) = axis_type {
        match axis_type {
            "x" => return AxisRole::X,
            "y" => return AxisRole::Y,
            "z" => return AxisRole::Z,
            "c" => return AxisRole::C,
            "t" => return AxisRole::T,
            _ => {}
        }
    }
    match axis_name.to_ascii_lowercase().as_str() {
        "x" | "width" => AxisRole::X,
        "y" | "height" => AxisRole::Y,
        "z" | "depth" => AxisRole::Z,
        "c" | "ch" | "channel" | "channels" => AxisRole::C,
        "t" | "time" => AxisRole::T,
        _ => AxisRole::Other,
    }
}

fn parse_channels(omero: Option<&Value>, warnings: &mut Vec<ApiWarning>) -> Vec<ChannelDef> {
    let Some(omero_object) = omero.and_then(Value::as_object) else {
        return Vec::new();
    };
    let Some(channels_raw) = omero_object.get("channels").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut channels: Vec<ChannelDef> = Vec::new();
    for (index, channel_raw) in channels_raw.iter().enumerate() {
        let Some(channel_object) = channel_raw.as_object() else {
            warnings.push(ApiWarning {
                code: "channel_metadata_skipped".to_owned(),
                message: "Invalid channel metadata entry was skipped.".to_owned(),
                details: Some(json!({"channel_position": index})),
            });
            continue;
        };

        let channel_index =
            if let Some(raw_index) = channel_object.get("index").and_then(Value::as_i64) {
                if raw_index >= 0 {
                    raw_index as u64
                } else {
                    warnings.push(ApiWarning {
                        code: "channel_index_inferred".to_owned(),
                        message: "Channel index missing; inferred from channel order.".to_owned(),
                        details: Some(json!({"channel_position": index, "index": index})),
                    });
                    index as u64
                }
            } else if let Some(raw_index) = channel_object.get("index").and_then(Value::as_u64) {
                raw_index
            } else {
                warnings.push(ApiWarning {
                    code: "channel_index_inferred".to_owned(),
                    message: "Channel index missing; inferred from channel order.".to_owned(),
                    details: Some(json!({"channel_position": index, "index": index})),
                });
                index as u64
            };

        let color_value = channel_object.get("color");
        let color_rgba = color_value.and_then(parse_color);
        if color_value.is_some() && color_rgba.is_none() {
            warnings.push(ApiWarning {
                code: "channel_color_invalid".to_owned(),
                message: "Channel color was not parseable and was omitted.".to_owned(),
                details: Some(json!({"channel_index": channel_index})),
            });
        }

        let suggested_contrast =
            parse_suggested_contrast(channel_object.get("window").and_then(Value::as_object));

        let suggested_gamma = if let Some(raw_gamma) = channel_object.get("gamma") {
            if let Some(parsed) = raw_gamma.as_f64() {
                Some(parsed)
            } else if let Some(parsed) = raw_gamma.as_i64() {
                Some(parsed as f64)
            } else if let Some(parsed) = raw_gamma.as_u64() {
                Some(parsed as f64)
            } else {
                warnings.push(ApiWarning {
                    code: "channel_gamma_invalid".to_owned(),
                    message: "Channel gamma was not parseable and was omitted.".to_owned(),
                    details: Some(json!({"channel_index": channel_index})),
                });
                None
            }
        } else {
            None
        };

        let channel_name = channel_object
            .get("label")
            .or_else(|| channel_object.get("name"))
            .map(value_to_string);

        channels.push(ChannelDef {
            index: channel_index,
            name: channel_name,
            color_rgba,
            suggested_contrast,
            suggested_gamma,
        });
    }
    channels
}

fn value_to_string(value: &Value) -> String {
    if let Some(as_str) = value.as_str() {
        as_str.to_owned()
    } else {
        value.to_string()
    }
}

fn parse_color(raw_color: &Value) -> Option<[f64; 4]> {
    let mut color = raw_color.as_str()?.trim().to_ascii_lowercase();
    if let Some(stripped) = color.strip_prefix("0x") {
        color = stripped.to_owned();
    }
    if let Some(stripped) = color.strip_prefix('#') {
        color = stripped.to_owned();
    }
    if color.len() == 6 {
        color.push_str("ff");
    }
    if color.len() != 8 {
        return None;
    }
    let red = u8::from_str_radix(&color[0..2], 16).ok()?;
    let green = u8::from_str_radix(&color[2..4], 16).ok()?;
    let blue = u8::from_str_radix(&color[4..6], 16).ok()?;
    let alpha = u8::from_str_radix(&color[6..8], 16).ok()?;
    Some([
        red as f64 / 255.0,
        green as f64 / 255.0,
        blue as f64 / 255.0,
        alpha as f64 / 255.0,
    ])
}

fn parse_suggested_contrast(window: Option<&Map<String, Value>>) -> Option<SuggestedContrast> {
    let window = window?;
    let min_value = first_float(window.get("min"), window.get("start"));
    let max_value = first_float(window.get("max"), window.get("end"));
    if min_value.is_none() && max_value.is_none() {
        return None;
    }
    Some(SuggestedContrast {
        min: min_value,
        max: max_value,
        policy: Some(ContrastPolicy::Fixed),
        p_low: None,
        p_high: None,
    })
}

fn first_float(first: Option<&Value>, second: Option<&Value>) -> Option<f64> {
    [first, second].into_iter().flatten().find_map(|value| {
        value
            .as_f64()
            .or_else(|| value.as_i64().map(|v| v as f64))
            .or_else(|| value.as_u64().map(|v| v as f64))
    })
}

fn infer_recommended_tile_px(axes: &Vec<AxisDef>, chunks: &Vec<u64>) -> Option<(u64, u64)> {
    let x_index = axes
        .iter()
        .position(|axis| matches!(axis.role, AxisRole::X))?;
    let y_index = axes
        .iter()
        .position(|axis| matches!(axis.role, AxisRole::Y))?;
    if x_index >= chunks.len() || y_index >= chunks.len() {
        return None;
    }
    Some((u64::max(64, chunks[x_index]), u64::max(64, chunks[y_index])))
}

fn collect_array_attrs(attrs: Map<String, Value>, include_full: bool) -> Value {
    if include_full {
        return Value::Object(attrs);
    }
    let mut subset = Map::new();
    if let Some(value) = attrs.get("_ARRAY_DIMENSIONS") {
        subset.insert("_ARRAY_DIMENSIONS".to_owned(), value.clone());
    }
    if let Some(value) = attrs.get("dimension_separator") {
        subset.insert("dimension_separator".to_owned(), value.clone());
    }
    Value::Object(subset)
}
