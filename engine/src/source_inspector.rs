use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::model::{
    AxisName, AxisShape, AxisSpacing, CalibrationMetadata, CalibrationStatus, ChannelDescription,
    ChannelTable, SourceKind, SourceMetadata,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceInspectionError {
    InvalidSourceUri { uri: String, message: String },
    SourceNotFound { uri: String },
    ReadFailed { uri: String, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedSource {
    pub source_kind: SourceKind,
    pub source_metadata: SourceMetadata,
}

pub fn inspect_source(uri: &str) -> Result<InspectedSource, SourceInspectionError> {
    let path = source_path_from_uri(uri)?;
    let metadata = fs::metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            SourceInspectionError::SourceNotFound {
                uri: uri.to_owned(),
            }
        } else {
            SourceInspectionError::ReadFailed {
                uri: uri.to_owned(),
                message: error.to_string(),
            }
        }
    })?;

    if metadata.is_file() {
        inspect_file(uri, &path)
    } else if metadata.is_dir() {
        inspect_directory(uri, &path)
    } else {
        Ok(InspectedSource {
            source_kind: SourceKind::Other,
            source_metadata: default_metadata(),
        })
    }
}

fn source_path_from_uri(uri: &str) -> Result<PathBuf, SourceInspectionError> {
    if let Some(raw_path) = uri.strip_prefix("file://") {
        if raw_path.is_empty() {
            return Err(SourceInspectionError::InvalidSourceUri {
                uri: uri.to_owned(),
                message: "file URI must include a path".to_owned(),
            });
        }

        if cfg!(windows) {
            Ok(PathBuf::from(raw_path.trim_start_matches('/')))
        } else {
            Ok(PathBuf::from(raw_path))
        }
    } else if uri.is_empty() {
        Err(SourceInspectionError::InvalidSourceUri {
            uri: uri.to_owned(),
            message: "source URI must not be empty".to_owned(),
        })
    } else {
        Ok(PathBuf::from(uri))
    }
}

fn inspect_file(uri: &str, path: &Path) -> Result<InspectedSource, SourceInspectionError> {
    let bytes = fs::read(path).map_err(|error| SourceInspectionError::ReadFailed {
        uri: uri.to_owned(),
        message: error.to_string(),
    })?;

    if is_bigtiff_signature(&bytes) {
        let metadata = infer_bigtiff_metadata(&bytes).unwrap_or_else(default_metadata);
        return Ok(InspectedSource {
            source_kind: SourceKind::BigTiff,
            source_metadata: metadata,
        });
    }

    if is_tiff_signature(&bytes) {
        let metadata = infer_classic_tiff_metadata(&bytes).unwrap_or_else(default_metadata);
        return Ok(InspectedSource {
            source_kind: SourceKind::Tiff,
            source_metadata: metadata,
        });
    }

    Ok(InspectedSource {
        source_kind: SourceKind::Other,
        source_metadata: default_metadata(),
    })
}

fn inspect_directory(uri: &str, path: &Path) -> Result<InspectedSource, SourceInspectionError> {
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");

    if extension.eq_ignore_ascii_case("zarr") {
        let source_kind = if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".ome.zarr"))
            || ome_multiscales_present(path)
        {
            SourceKind::OmeZarr
        } else {
            SourceKind::Zarr
        };
        return Ok(InspectedSource {
            source_kind,
            source_metadata: infer_zarr_metadata(uri, path)?,
        });
    }

    if ome_multiscales_present(path) {
        return Ok(InspectedSource {
            source_kind: SourceKind::OmeZarr,
            source_metadata: infer_zarr_metadata(uri, path)?,
        });
    }

    Ok(InspectedSource {
        source_kind: SourceKind::Other,
        source_metadata: default_metadata(),
    })
}

fn ome_multiscales_present(path: &Path) -> bool {
    let attrs_path = path.join(".zattrs");
    if !attrs_path.exists() {
        return false;
    }

    let Ok(raw) = fs::read_to_string(attrs_path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };

    value
        .get("multiscales")
        .and_then(Value::as_array)
        .is_some_and(|entries| !entries.is_empty())
}

#[derive(Debug, Clone, Copy)]
enum Endianness {
    Little,
    Big,
}

fn is_tiff_signature(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && (bytes.starts_with(&[0x49, 0x49, 0x2A, 0x00])
            || bytes.starts_with(&[0x4D, 0x4D, 0x00, 0x2A]))
}

fn is_bigtiff_signature(bytes: &[u8]) -> bool {
    bytes.len() >= 8
        && (bytes.starts_with(&[0x49, 0x49, 0x2B, 0x00, 0x08, 0x00, 0x00, 0x00])
            || bytes.starts_with(&[0x4D, 0x4D, 0x00, 0x2B, 0x00, 0x08, 0x00, 0x00]))
}

fn infer_classic_tiff_metadata(bytes: &[u8]) -> Option<SourceMetadata> {
    if bytes.len() < 8 {
        return None;
    }

    let endianness = if bytes.starts_with(&[0x49, 0x49]) {
        Endianness::Little
    } else if bytes.starts_with(&[0x4D, 0x4D]) {
        Endianness::Big
    } else {
        return None;
    };
    let first_ifd_offset = read_u32(bytes, 4, endianness)? as usize;
    if first_ifd_offset + 2 > bytes.len() {
        return None;
    }

    let entry_count = read_u16(bytes, first_ifd_offset, endianness)? as usize;
    let mut width = None;
    let mut height = None;
    let mut samples_per_pixel = None;
    let mut bits_per_sample = None;
    let mut sample_format = None;
    let mut image_description = None;

    for index in 0..entry_count {
        let entry_offset = first_ifd_offset + 2 + index * 12;
        if entry_offset + 12 > bytes.len() {
            break;
        }

        let tag = read_u16(bytes, entry_offset, endianness)?;
        let value_type = read_u16(bytes, entry_offset + 2, endianness)?;
        let count = read_u32(bytes, entry_offset + 4, endianness)?;
        let value_or_offset = read_u32(bytes, entry_offset + 8, endianness)?;
        let value =
            first_tiff_value(bytes, value_type, count, value_or_offset, endianness).unwrap_or(0);

        match tag {
            256 => width = Some(value),
            257 => height = Some(value),
            258 => bits_per_sample = Some(value as u16),
            277 => samples_per_pixel = Some(value as u16),
            339 => sample_format = Some(value as u16),
            270 => {
                image_description =
                    first_tiff_ascii(bytes, value_type, count, value_or_offset, endianness)
            }
            _ => {}
        }
    }

    if let Some(description) = image_description.as_deref()
        && let Some(ome_metadata) = infer_ome_tiff_metadata(description)
    {
        return Some(ome_metadata);
    }

    let resolved_width = width.unwrap_or(1);
    let resolved_height = height.unwrap_or(1);
    let resolved_channels = samples_per_pixel.unwrap_or(1);
    let resolved_bits = bits_per_sample.unwrap_or(16);
    let resolved_sample_format = sample_format.unwrap_or(1);
    let dtype = dtype_from_bits(resolved_bits, resolved_sample_format);

    Some(metadata_from_raster(
        resolved_width,
        resolved_height,
        resolved_channels,
        dtype.to_owned(),
    ))
}

fn infer_bigtiff_metadata(bytes: &[u8]) -> Option<SourceMetadata> {
    if bytes.len() < 16 {
        return None;
    }

    let endianness = if bytes.starts_with(&[0x49, 0x49]) {
        Endianness::Little
    } else if bytes.starts_with(&[0x4D, 0x4D]) {
        Endianness::Big
    } else {
        return None;
    };
    let first_ifd_offset = read_u64(bytes, 8, endianness)? as usize;
    if first_ifd_offset + 8 > bytes.len() {
        return Some(default_metadata());
    }

    let entry_count = read_u64(bytes, first_ifd_offset, endianness)? as usize;
    let mut width = None;
    let mut height = None;
    let mut samples_per_pixel = None;
    let mut bits_per_sample = None;
    let mut sample_format = None;
    let mut image_description = None;

    for index in 0..entry_count {
        let entry_offset = first_ifd_offset + 8 + index * 20;
        if entry_offset + 20 > bytes.len() {
            break;
        }

        let tag = read_u16(bytes, entry_offset, endianness)?;
        let value_type = read_u16(bytes, entry_offset + 2, endianness)?;
        let count = read_u64(bytes, entry_offset + 4, endianness)?;
        let value_or_offset = read_u64(bytes, entry_offset + 12, endianness)?;
        let value =
            first_bigtiff_value(bytes, value_type, count, value_or_offset, endianness).unwrap_or(0);

        match tag {
            256 => width = Some(value),
            257 => height = Some(value),
            258 => bits_per_sample = Some(value as u16),
            277 => samples_per_pixel = Some(value as u16),
            339 => sample_format = Some(value as u16),
            270 => {
                image_description =
                    first_bigtiff_ascii(bytes, value_type, count, value_or_offset, endianness)
            }
            _ => {}
        }
    }

    if let Some(description) = image_description.as_deref()
        && let Some(ome_metadata) = infer_ome_tiff_metadata(description)
    {
        return Some(ome_metadata);
    }

    let resolved_width = width.unwrap_or(1);
    let resolved_height = height.unwrap_or(1);
    let resolved_channels = samples_per_pixel.unwrap_or(1);
    let resolved_bits = bits_per_sample.unwrap_or(16);
    let resolved_sample_format = sample_format.unwrap_or(1);
    let dtype = dtype_from_bits(resolved_bits, resolved_sample_format);

    Some(metadata_from_raster(
        resolved_width,
        resolved_height,
        resolved_channels,
        dtype.to_owned(),
    ))
}

fn infer_zarr_metadata(uri: &str, path: &Path) -> Result<SourceMetadata, SourceInspectionError> {
    let mut original_axes = None;
    let mut descriptor_path: Option<PathBuf> = None;

    let attrs_path = path.join(".zattrs");
    if attrs_path.exists() {
        let attrs_raw =
            fs::read_to_string(&attrs_path).map_err(|error| SourceInspectionError::ReadFailed {
                uri: uri.to_owned(),
                message: error.to_string(),
            })?;
        if let Ok(attrs) = serde_json::from_str::<Value>(&attrs_raw)
            && let Some(multiscales) = attrs.get("multiscales").and_then(Value::as_array)
            && let Some(first_scale) = multiscales.first()
        {
            original_axes = first_scale
                .get("axes")
                .and_then(parse_ome_axes)
                .filter(|axes| !axes.is_empty());
            if let Some(dataset_path) = first_scale
                .get("datasets")
                .and_then(Value::as_array)
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.get("path"))
                .and_then(Value::as_str)
            {
                descriptor_path = Some(path.join(dataset_path).join(".zarray"));
            }
        }
    }

    let fallback_paths = [
        path.join(".zarray"),
        path.join("zarr.json"),
        path.join("0").join(".zarray"),
        path.join("0").join("zarr.json"),
    ];

    let descriptor = descriptor_path
        .into_iter()
        .chain(fallback_paths)
        .find_map(|candidate| {
            if !candidate.exists() {
                return None;
            }
            read_array_descriptor(&candidate).ok()
        });

    let Some(descriptor) = descriptor else {
        return Ok(default_metadata());
    };

    let inferred_axes =
        original_axes.unwrap_or_else(|| infer_axes_from_dimensionality(descriptor.shape.len()));
    let shape = shape_from_axis_order(&inferred_axes, &descriptor.shape);
    let channels = shape.c.max(1) as u32;

    Ok(SourceMetadata {
        original_axis_order: inferred_axes,
        canonical_axis_order: canonical_axes(),
        shape,
        dtype: normalize_dtype(&descriptor.dtype),
        calibration: default_calibration(),
        channel_table: channel_table(channels),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ArrayDescriptor {
    shape: Vec<u64>,
    dtype: String,
}

#[derive(Debug, Deserialize)]
struct ZarrV2ArrayDescriptor {
    shape: Vec<u64>,
    dtype: String,
}

fn read_array_descriptor(path: &Path) -> Result<ArrayDescriptor, ()> {
    let raw = fs::read_to_string(path).map_err(|_| ())?;
    if path.file_name().and_then(|name| name.to_str()) == Some(".zarray") {
        let parsed = serde_json::from_str::<ZarrV2ArrayDescriptor>(&raw).map_err(|_| ())?;
        return Ok(ArrayDescriptor {
            shape: parsed.shape,
            dtype: parsed.dtype,
        });
    }

    let value = serde_json::from_str::<Value>(&raw).map_err(|_| ())?;
    let shape = value
        .get("shape")
        .and_then(Value::as_array)
        .ok_or(())?
        .iter()
        .map(|item| item.as_u64().ok_or(()))
        .collect::<Result<Vec<_>, _>>()?;

    let dtype = value
        .get("data_type")
        .and_then(Value::as_str)
        .or_else(|| value.get("dtype").and_then(Value::as_str))
        .ok_or(())?
        .to_owned();

    Ok(ArrayDescriptor { shape, dtype })
}

fn parse_ome_axes(value: &Value) -> Option<Vec<AxisName>> {
    let axes = value.as_array()?;
    let parsed = axes
        .iter()
        .filter_map(|axis| {
            axis.as_str()
                .map(map_axis_name)
                .or_else(|| axis.get("name").and_then(Value::as_str).map(map_axis_name))
        })
        .collect::<Vec<_>>();

    if parsed.is_empty() {
        None
    } else {
        Some(parsed)
    }
}

fn map_axis_name(name: &str) -> AxisName {
    match name.to_ascii_lowercase().as_str() {
        "t" | "time" => AxisName::T,
        "c" | "channel" => AxisName::C,
        "z" => AxisName::Z,
        "y" => AxisName::Y,
        "x" => AxisName::X,
        other => AxisName::Extra(other.to_owned()),
    }
}

fn infer_axes_from_dimensionality(rank: usize) -> Vec<AxisName> {
    match rank {
        5 => vec![
            AxisName::T,
            AxisName::C,
            AxisName::Z,
            AxisName::Y,
            AxisName::X,
        ],
        4 => vec![AxisName::C, AxisName::Z, AxisName::Y, AxisName::X],
        3 => vec![AxisName::C, AxisName::Y, AxisName::X],
        2 => vec![AxisName::Y, AxisName::X],
        1 => vec![AxisName::X],
        _ => canonical_axes(),
    }
}

fn shape_from_axis_order(axis_order: &[AxisName], dims: &[u64]) -> AxisShape {
    let mut shape = AxisShape {
        t: 1,
        c: 1,
        z: 1,
        y: 1,
        x: 1,
        extra_axes: BTreeMap::new(),
    };

    for (axis, value) in axis_order.iter().zip(dims.iter().copied()) {
        match axis {
            AxisName::T => shape.t = value,
            AxisName::C => shape.c = value,
            AxisName::Z => shape.z = value,
            AxisName::Y => shape.y = value,
            AxisName::X => shape.x = value,
            AxisName::Extra(name) => {
                shape.extra_axes.insert(name.clone(), value);
            }
        }
    }

    shape
}

fn canonical_axes() -> Vec<AxisName> {
    vec![
        AxisName::T,
        AxisName::C,
        AxisName::Z,
        AxisName::Y,
        AxisName::X,
    ]
}

fn metadata_from_raster(width: u64, height: u64, channels: u16, dtype: String) -> SourceMetadata {
    let channel_count = channels.max(1);
    let original_axis_order = if channel_count > 1 {
        vec![AxisName::C, AxisName::Y, AxisName::X]
    } else {
        vec![AxisName::Y, AxisName::X]
    };

    SourceMetadata {
        original_axis_order,
        canonical_axis_order: canonical_axes(),
        shape: AxisShape {
            t: 1,
            c: u64::from(channel_count),
            z: 1,
            y: height.max(1),
            x: width.max(1),
            extra_axes: BTreeMap::new(),
        },
        dtype,
        calibration: default_calibration(),
        channel_table: channel_table(u32::from(channel_count)),
    }
}

fn default_calibration() -> CalibrationMetadata {
    CalibrationMetadata {
        status: CalibrationStatus::Uncalibrated,
        spacing: AxisSpacing {
            x: None,
            y: None,
            z: None,
        },
        units: None,
    }
}

fn default_metadata() -> SourceMetadata {
    SourceMetadata {
        original_axis_order: vec![AxisName::Y, AxisName::X],
        canonical_axis_order: canonical_axes(),
        shape: AxisShape {
            t: 1,
            c: 1,
            z: 1,
            y: 1,
            x: 1,
            extra_axes: BTreeMap::new(),
        },
        dtype: "unknown".to_owned(),
        calibration: default_calibration(),
        channel_table: channel_table(1),
    }
}

fn channel_table(channel_count: u32) -> ChannelTable {
    let channels = (0..channel_count)
        .map(|index| ChannelDescription {
            index,
            name: format!("ch{index}"),
        })
        .collect::<Vec<_>>();

    ChannelTable {
        channel_count,
        channels,
    }
}

fn first_tiff_value(
    bytes: &[u8],
    value_type: u16,
    count: u32,
    value_or_offset: u32,
    endianness: Endianness,
) -> Option<u64> {
    if count == 0 {
        return None;
    }

    let type_width = usize::from(type_width(value_type)?);
    let byte_count = type_width * count as usize;
    if byte_count <= 4 {
        return match value_type {
            3 => Some(match endianness {
                Endianness::Little => u64::from((value_or_offset & 0xFFFF) as u16),
                Endianness::Big => u64::from(((value_or_offset >> 16) & 0xFFFF) as u16),
            }),
            _ => Some(u64::from(value_or_offset)),
        };
    }

    let offset = value_or_offset as usize;
    read_value_at(bytes, offset, value_type, endianness)
}

fn first_tiff_ascii(
    bytes: &[u8],
    value_type: u16,
    count: u32,
    value_or_offset: u32,
    _endianness: Endianness,
) -> Option<String> {
    if value_type != 2 || count == 0 {
        return None;
    }
    let byte_count = count as usize;
    if byte_count <= 4 {
        return None;
    }
    let offset = value_or_offset as usize;
    read_ascii_at(bytes, offset, byte_count)
}

fn first_bigtiff_value(
    bytes: &[u8],
    value_type: u16,
    count: u64,
    value_or_offset: u64,
    endianness: Endianness,
) -> Option<u64> {
    if count == 0 {
        return None;
    }

    let type_width = u64::from(type_width(value_type)?);
    let byte_count = type_width.saturating_mul(count);
    if byte_count <= 8 {
        return match value_type {
            3 => Some(match endianness {
                Endianness::Little => u64::from((value_or_offset & 0xFFFF) as u16),
                Endianness::Big => u64::from(((value_or_offset >> 48) & 0xFFFF) as u16),
            }),
            _ => Some(value_or_offset),
        };
    }

    let offset = value_or_offset as usize;
    read_value_at(bytes, offset, value_type, endianness)
}

fn first_bigtiff_ascii(
    bytes: &[u8],
    value_type: u16,
    count: u64,
    value_or_offset: u64,
    _endianness: Endianness,
) -> Option<String> {
    if value_type != 2 || count == 0 {
        return None;
    }
    let byte_count = usize::try_from(count).ok()?;
    if byte_count <= 8 {
        return None;
    }
    let offset = usize::try_from(value_or_offset).ok()?;
    read_ascii_at(bytes, offset, byte_count)
}

fn read_value_at(
    bytes: &[u8],
    offset: usize,
    value_type: u16,
    endianness: Endianness,
) -> Option<u64> {
    match value_type {
        3 => read_u16(bytes, offset, endianness).map(u64::from),
        4 => read_u32(bytes, offset, endianness).map(u64::from),
        16 => read_u64(bytes, offset, endianness),
        _ => None,
    }
}

fn read_ascii_at(bytes: &[u8], offset: usize, byte_count: usize) -> Option<String> {
    let raw = bytes.get(offset..offset.saturating_add(byte_count))?;
    let end = raw
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(raw.len());
    if end == 0 {
        return None;
    }
    let text = std::str::from_utf8(&raw[..end]).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_owned())
}

fn infer_ome_tiff_metadata(image_description: &str) -> Option<SourceMetadata> {
    let size_t = xml_attr_u64(image_description, "SizeT").unwrap_or(1);
    let size_c = xml_attr_u64(image_description, "SizeC").unwrap_or(1);
    let size_z = xml_attr_u64(image_description, "SizeZ").unwrap_or(1);
    let size_y = xml_attr_u64(image_description, "SizeY")?;
    let size_x = xml_attr_u64(image_description, "SizeX")?;
    let dimension_order = xml_attr_value(image_description, "DimensionOrder")?;
    let dtype = normalize_ome_type(&xml_attr_value(image_description, "Type")?);

    let original_axis_order = parse_dimension_order_axes(&dimension_order)?;
    let shape = shape_from_axis_order(
        &original_axis_order,
        &dims_for_axis_order(&original_axis_order, size_t, size_c, size_z, size_y, size_x),
    );

    Some(SourceMetadata {
        original_axis_order,
        canonical_axis_order: canonical_axes(),
        shape,
        dtype,
        calibration: default_calibration(),
        channel_table: channel_table(size_c as u32),
    })
}

fn dims_for_axis_order(
    axis_order: &[AxisName],
    size_t: u64,
    size_c: u64,
    size_z: u64,
    size_y: u64,
    size_x: u64,
) -> Vec<u64> {
    axis_order
        .iter()
        .map(|axis| match axis {
            AxisName::T => size_t,
            AxisName::C => size_c,
            AxisName::Z => size_z,
            AxisName::Y => size_y,
            AxisName::X => size_x,
            AxisName::Extra(_) => 1,
        })
        .collect()
}

fn parse_dimension_order_axes(value: &str) -> Option<Vec<AxisName>> {
    let normalized = value.trim().to_ascii_uppercase();
    if normalized.len() != 5 {
        return None;
    }
    let mut axes = Vec::with_capacity(5);
    for ch in normalized.chars() {
        let axis = match ch {
            'T' => AxisName::T,
            'C' => AxisName::C,
            'Z' => AxisName::Z,
            'Y' => AxisName::Y,
            'X' => AxisName::X,
            _ => return None,
        };
        axes.push(axis);
    }
    Some(axes)
}

fn xml_attr_u64(text: &str, name: &str) -> Option<u64> {
    xml_attr_value(text, name)?.parse::<u64>().ok()
}

fn xml_attr_value(text: &str, name: &str) -> Option<String> {
    let needle_double = format!("{name}=\"");
    if let Some(start) = text.find(&needle_double) {
        let value_start = start + needle_double.len();
        let value_end = text[value_start..].find('"')?;
        return Some(text[value_start..(value_start + value_end)].to_owned());
    }
    let needle_single = format!("{name}='");
    if let Some(start) = text.find(&needle_single) {
        let value_start = start + needle_single.len();
        let value_end = text[value_start..].find('\'')?;
        return Some(text[value_start..(value_start + value_end)].to_owned());
    }
    None
}

fn normalize_ome_type(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "uint8" => "uint8".to_owned(),
        "uint16" => "uint16".to_owned(),
        "uint32" => "uint32".to_owned(),
        "uint64" => "uint64".to_owned(),
        "int8" => "int8".to_owned(),
        "int16" => "int16".to_owned(),
        "int32" => "int32".to_owned(),
        "int64" => "int64".to_owned(),
        "float" | "float32" => "float32".to_owned(),
        "double" | "float64" => "float64".to_owned(),
        other => other.to_owned(),
    }
}

fn type_width(value_type: u16) -> Option<u8> {
    match value_type {
        3 => Some(2),
        4 => Some(4),
        16 => Some(8),
        _ => None,
    }
}

fn dtype_from_bits(bits_per_sample: u16, sample_format: u16) -> &'static str {
    match (sample_format, bits_per_sample) {
        (1, 8) => "uint8",
        (1, 16) => "uint16",
        (1, 32) => "uint32",
        (1, 64) => "uint64",
        (2, 8) => "int8",
        (2, 16) => "int16",
        (2, 32) => "int32",
        (2, 64) => "int64",
        (3, 32) => "float32",
        (3, 64) => "float64",
        _ => "unknown",
    }
}

fn normalize_dtype(raw_dtype: &str) -> String {
    match raw_dtype {
        "|u1" | "<u1" | ">u1" | "u1" | "uint8" => "uint8".to_owned(),
        "<u2" | ">u2" | "u2" | "uint16" => "uint16".to_owned(),
        "<u4" | ">u4" | "u4" | "uint32" => "uint32".to_owned(),
        "<u8" | ">u8" | "u8" | "uint64" => "uint64".to_owned(),
        "<i1" | ">i1" | "i1" | "int8" => "int8".to_owned(),
        "<i2" | ">i2" | "i2" | "int16" => "int16".to_owned(),
        "<i4" | ">i4" | "i4" | "int32" => "int32".to_owned(),
        "<i8" | ">i8" | "i8" | "int64" => "int64".to_owned(),
        "<f4" | ">f4" | "f4" | "float32" => "float32".to_owned(),
        "<f8" | ">f8" | "f8" | "float64" => "float64".to_owned(),
        _ => raw_dtype.to_owned(),
    }
}

fn read_u16(bytes: &[u8], offset: usize, endianness: Endianness) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(match endianness {
        Endianness::Little => u16::from_le_bytes([slice[0], slice[1]]),
        Endianness::Big => u16::from_be_bytes([slice[0], slice[1]]),
    })
}

fn read_u32(bytes: &[u8], offset: usize, endianness: Endianness) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(match endianness {
        Endianness::Little => u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]),
        Endianness::Big => u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]),
    })
}

fn read_u64(bytes: &[u8], offset: usize, endianness: Endianness) -> Option<u64> {
    let slice = bytes.get(offset..offset + 8)?;
    Some(match endianness {
        Endianness::Little => u64::from_le_bytes([
            slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
        ]),
        Endianness::Big => u64::from_be_bytes([
            slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
        ]),
    })
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::inspect_source;
    use crate::model::{AxisName, SourceKind};
    use tiff::tags::Tag;

    fn unique_path(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida_luc200_{prefix}_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    fn write_minimal_rgb_tiff(path: &std::path::Path) {
        const TIFF_BYTES: [u8; 62] = [
            0x49, 0x49, 0x2A, 0x00, // II + classic TIFF marker
            0x08, 0x00, 0x00, 0x00, // first IFD offset
            0x04, 0x00, // entry count
            0x00, 0x01, // tag 256 image width
            0x04, 0x00, // type LONG
            0x01, 0x00, 0x00, 0x00, // count
            0x20, 0x00, 0x00, 0x00, // width 32
            0x01, 0x01, // tag 257 image length
            0x04, 0x00, // type LONG
            0x01, 0x00, 0x00, 0x00, // count
            0x10, 0x00, 0x00, 0x00, // height 16
            0x15, 0x01, // tag 277 samples per pixel
            0x03, 0x00, // type SHORT
            0x01, 0x00, 0x00, 0x00, // count
            0x03, 0x00, 0x00, 0x00, // 3 channels
            0x02, 0x01, // tag 258 bits per sample
            0x03, 0x00, // type SHORT
            0x01, 0x00, 0x00, 0x00, // count
            0x08, 0x00, 0x00, 0x00, // 8 bits
            0x00, 0x00, 0x00, 0x00, // next IFD offset
        ];
        std::fs::write(path, TIFF_BYTES).expect("TIFF fixture write should succeed");
    }

    fn write_ome_tiff_with_description(path: &std::path::Path) {
        let file = std::fs::File::create(path).expect("OME-TIFF fixture should be created");
        let mut encoder =
            tiff::encoder::TiffEncoder::new(file).expect("tiff encoder creation should succeed");
        let mut image = encoder
            .new_image::<tiff::encoder::colortype::Gray16>(2, 2)
            .expect("tiff image creation should succeed");
        image
            .encoder()
            .write_tag(
                Tag::ImageDescription,
                r#"<?xml version="1.0" encoding="UTF-8"?>
<OME>
  <Image ID="Image:0">
    <Pixels DimensionOrder="TCZYX" SizeT="30" SizeC="2" SizeZ="17" SizeY="2" SizeX="2" Type="uint16"/>
  </Image>
</OME>"#,
            )
            .expect("image description write should succeed");
        image
            .write_data(&[100_u16, 110_u16, 120_u16, 130_u16])
            .expect("pixel payload write should succeed");
    }

    #[test]
    fn inspects_classic_tiff_and_infers_shape_and_channels() {
        let file_path = unique_path("tiff").with_extension("tiff");
        write_minimal_rgb_tiff(&file_path);

        let inspected = inspect_source(&file_path.display().to_string())
            .expect("TIFF source inspection should succeed");

        assert_eq!(inspected.source_kind, SourceKind::Tiff);
        assert_eq!(inspected.source_metadata.shape.x, 32);
        assert_eq!(inspected.source_metadata.shape.y, 16);
        assert_eq!(inspected.source_metadata.shape.c, 3);
        assert_eq!(inspected.source_metadata.dtype, "uint8");
        assert_eq!(inspected.source_metadata.channel_table.channel_count, 3);
        assert_eq!(
            inspected.source_metadata.original_axis_order,
            vec![AxisName::C, AxisName::Y, AxisName::X]
        );

        std::fs::remove_file(file_path).expect("fixture cleanup should succeed");
    }

    #[test]
    fn detects_bigtiff_signature() {
        let file_path = unique_path("bigtiff").with_extension("btf");
        let bigtiff_bytes: [u8; 16] = [
            0x49, 0x49, 0x2B, 0x00, // II + BigTIFF marker
            0x08, 0x00, 0x00, 0x00, // offset size and reserved
            0x10, 0x00, 0x00, 0x00, // first IFD offset (16)
            0x00, 0x00, 0x00, 0x00, // first IFD offset high bytes
        ];
        std::fs::write(&file_path, bigtiff_bytes).expect("BigTIFF fixture write should succeed");

        let inspected = inspect_source(&file_path.display().to_string())
            .expect("BigTIFF source inspection should succeed");
        assert_eq!(inspected.source_kind, SourceKind::BigTiff);

        std::fs::remove_file(file_path).expect("fixture cleanup should succeed");
    }

    #[test]
    fn detects_ome_zarr_and_reads_axis_and_shape_metadata() {
        let root = unique_path("omezarr").with_extension("ome.zarr");
        let level_zero = root.join("0");
        std::fs::create_dir_all(&level_zero).expect("fixture directory creation should succeed");

        std::fs::write(
            root.join(".zattrs"),
            r#"{
              "multiscales": [
                {
                  "axes": ["t", "c", "z", "y", "x"],
                  "datasets": [{"path": "0"}]
                }
              ]
            }"#,
        )
        .expect(".zattrs fixture write should succeed");
        std::fs::write(
            level_zero.join(".zarray"),
            r#"{
              "shape": [2, 3, 4, 5, 6],
              "dtype": "<u2"
            }"#,
        )
        .expect(".zarray fixture write should succeed");

        let inspected =
            inspect_source(&root.display().to_string()).expect("OME-Zarr inspection should work");
        assert_eq!(inspected.source_kind, SourceKind::OmeZarr);
        assert_eq!(inspected.source_metadata.shape.t, 2);
        assert_eq!(inspected.source_metadata.shape.c, 3);
        assert_eq!(inspected.source_metadata.shape.z, 4);
        assert_eq!(inspected.source_metadata.shape.y, 5);
        assert_eq!(inspected.source_metadata.shape.x, 6);
        assert_eq!(inspected.source_metadata.dtype, "uint16");

        std::fs::remove_dir_all(root).expect("fixture cleanup should succeed");
    }

    #[test]
    fn inspects_ome_tiff_and_reads_axis_and_shape_metadata() {
        let file_path = unique_path("ome_tiff").with_extension("ome.tif");
        write_ome_tiff_with_description(&file_path);

        let inspected = inspect_source(&file_path.display().to_string())
            .expect("OME-TIFF source inspection should succeed");

        assert_eq!(inspected.source_kind, SourceKind::Tiff);
        assert_eq!(
            inspected.source_metadata.original_axis_order,
            vec![
                AxisName::T,
                AxisName::C,
                AxisName::Z,
                AxisName::Y,
                AxisName::X
            ]
        );
        assert_eq!(inspected.source_metadata.shape.t, 30);
        assert_eq!(inspected.source_metadata.shape.c, 2);
        assert_eq!(inspected.source_metadata.shape.z, 17);
        assert_eq!(inspected.source_metadata.shape.y, 2);
        assert_eq!(inspected.source_metadata.shape.x, 2);
        assert_eq!(inspected.source_metadata.dtype, "uint16");

        std::fs::remove_file(file_path).expect("fixture cleanup should succeed");
    }
}
