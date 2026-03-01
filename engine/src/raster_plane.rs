use std::fs::File;
use std::io::BufReader;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tiff::ColorType;
use tiff::decoder::{Decoder as TiffDecoder, DecodingResult as TiffDecodingResult};
use zarrs::array::Array;
use zarrs::array::ArraySubset;
use zarrs::filesystem::FilesystemStore;
use zarrs::storage::ReadableWritableListableStorage;

use crate::model::SourceKind;
use crate::model::{AxisName, AxisShape};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterPlaneLoadRequest {
    pub source_uri: String,
    pub source_kind: SourceKind,
    pub dtype: String,
    pub axis_order: Vec<AxisName>,
    pub shape: AxisShape,
    pub t_index: u64,
    pub z_index: u64,
    pub channel_index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterPlane {
    pub width: u64,
    pub height: u64,
    pub max_value: u16,
    pub pixels: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RasterPlaneLoadError {
    InvalidSourceUri { uri: String, message: String },
    UnsupportedSourceKind { source_kind: SourceKind },
    ReadFailed { path: String, message: String },
    DecodeFailed { path: String, message: String },
    UnsupportedDtype { dtype: String },
}

pub fn load_raster_plane(
    request: &RasterPlaneLoadRequest,
) -> Result<RasterPlane, RasterPlaneLoadError> {
    match request.source_kind {
        SourceKind::Tiff | SourceKind::BigTiff => load_tiff_plane(request),
        SourceKind::OmeZarr | SourceKind::Zarr => load_zarr_plane(
            &request.source_uri,
            &request.dtype,
            &request.axis_order,
            request.t_index,
            request.z_index,
            request.channel_index,
        ),
        SourceKind::Other => Err(RasterPlaneLoadError::UnsupportedSourceKind {
            source_kind: request.source_kind,
        }),
    }
}

fn load_tiff_plane(request: &RasterPlaneLoadRequest) -> Result<RasterPlane, RasterPlaneLoadError> {
    let path = source_path_from_uri(&request.source_uri)?;
    let file = File::open(&path).map_err(|error| RasterPlaneLoadError::ReadFailed {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    let mut decoder = TiffDecoder::new(BufReader::new(file)).map_err(|error| {
        RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: error.to_string(),
        }
    })?;

    let target_page = tiff_page_index(
        &request.shape,
        &request.axis_order,
        request.t_index,
        request.z_index,
        request.channel_index,
    );
    let mut current_page = 0_u64;
    while current_page < target_page {
        let has_more = decoder.more_images();
        if !has_more {
            break;
        }
        decoder
            .next_image()
            .map_err(|error| RasterPlaneLoadError::DecodeFailed {
                path: path.display().to_string(),
                message: error.to_string(),
            })?;
        current_page += 1;
    }

    let (width_u32, height_u32) =
        decoder
            .dimensions()
            .map_err(|error| RasterPlaneLoadError::DecodeFailed {
                path: path.display().to_string(),
                message: error.to_string(),
            })?;
    let width = u64::from(width_u32);
    let height = u64::from(height_u32);
    let color_type = decoder
        .colortype()
        .map_err(|error| RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
    let channel_count = channels_for_color_type(color_type);
    let selected_channel = if channel_count == 0 {
        0
    } else {
        let requested = usize::try_from(request.channel_index).unwrap_or(0);
        requested.min(channel_count.saturating_sub(1))
    };
    let expected_pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: "image dimensions overflow".to_owned(),
        })?;

    let image = decoder
        .read_image()
        .map_err(|error| RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
    let (pixels, max_value) = match image {
        TiffDecodingResult::U8(samples) => {
            let first_channel = interleaved_channel(
                &samples,
                channel_count,
                selected_channel,
                expected_pixels,
                &path,
            )?;
            (
                first_channel
                    .iter()
                    .copied()
                    .map(u16::from)
                    .collect::<Vec<_>>(),
                255,
            )
        }
        TiffDecodingResult::U16(samples) => {
            let first_channel = interleaved_channel(
                &samples,
                channel_count,
                selected_channel,
                expected_pixels,
                &path,
            )?;
            (first_channel, u16::MAX)
        }
        TiffDecodingResult::I8(samples) => {
            let first_channel = interleaved_channel(
                &samples,
                channel_count,
                selected_channel,
                expected_pixels,
                &path,
            )?;
            (
                normalize_dynamic_range_to_u16(&first_channel, |value| f64::from(value)),
                u16::MAX,
            )
        }
        TiffDecodingResult::I16(samples) => {
            let first_channel = interleaved_channel(
                &samples,
                channel_count,
                selected_channel,
                expected_pixels,
                &path,
            )?;
            (
                normalize_dynamic_range_to_u16(&first_channel, |value| f64::from(value)),
                u16::MAX,
            )
        }
        TiffDecodingResult::U32(samples) => {
            let first_channel = interleaved_channel(
                &samples,
                channel_count,
                selected_channel,
                expected_pixels,
                &path,
            )?;
            (
                normalize_dynamic_range_to_u16(&first_channel, |value| value as f64),
                u16::MAX,
            )
        }
        TiffDecodingResult::I32(samples) => {
            let first_channel = interleaved_channel(
                &samples,
                channel_count,
                selected_channel,
                expected_pixels,
                &path,
            )?;
            (
                normalize_dynamic_range_to_u16(&first_channel, |value| value as f64),
                u16::MAX,
            )
        }
        TiffDecodingResult::F32(samples) => {
            let first_channel = interleaved_channel(
                &samples,
                channel_count,
                selected_channel,
                expected_pixels,
                &path,
            )?;
            (
                normalize_dynamic_range_to_u16(&first_channel, |value| value as f64),
                u16::MAX,
            )
        }
        TiffDecodingResult::F64(samples) => {
            let first_channel = interleaved_channel(
                &samples,
                channel_count,
                selected_channel,
                expected_pixels,
                &path,
            )?;
            (
                normalize_dynamic_range_to_u16(&first_channel, |value| value),
                u16::MAX,
            )
        }
        _ => {
            return Err(RasterPlaneLoadError::DecodeFailed {
                path: path.display().to_string(),
                message: "unsupported TIFF decoding result type".to_owned(),
            });
        }
    };

    Ok(RasterPlane {
        width,
        height,
        max_value,
        pixels,
    })
}

fn load_zarr_plane(
    uri: &str,
    dtype: &str,
    axis_order: &[AxisName],
    t_index: u64,
    z_index: u64,
    channel_index: u64,
) -> Result<RasterPlane, RasterPlaneLoadError> {
    let path = source_path_from_uri(uri)?;
    let store: ReadableWritableListableStorage =
        Arc::new(FilesystemStore::new(&path).map_err(|error| {
            RasterPlaneLoadError::ReadFailed {
                path: path.display().to_string(),
                message: error.to_string(),
            }
        })?);

    let array = Array::open(store.clone(), "/0")
        .or_else(|_| Array::open(store, "/"))
        .map_err(|error| RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;

    let shape = array.shape().to_vec();
    if shape.len() < 2 {
        return Err(RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: "zarr array must have at least two dimensions".to_owned(),
        });
    }

    let width = *shape.last().unwrap_or(&1);
    let height = *shape.get(shape.len().saturating_sub(2)).unwrap_or(&1);
    let ranges = plane_ranges(&shape, axis_order, t_index, z_index, channel_index);
    let subset = ArraySubset::new_with_ranges(&ranges);

    let (pixels, max_value) = match dtype {
        "uint8" => array
            .retrieve_array_subset::<Vec<u8>>(&subset)
            .map_err(|error| RasterPlaneLoadError::DecodeFailed {
                path: path.display().to_string(),
                message: error.to_string(),
            })
            .map(|values| {
                (
                    values.iter().copied().map(u16::from).collect::<Vec<_>>(),
                    255,
                )
            })?,
        "uint16" => {
            let values = array_values::<u16, _>(&array, &subset, &path)?;
            (values, u16::MAX)
        }
        "uint32" => {
            let values = array_values::<u32, _>(&array, &subset, &path)?;
            (
                normalize_dynamic_range_to_u16(&values, |value| value as f64),
                u16::MAX,
            )
        }
        "int8" => {
            let values = array_values::<i8, _>(&array, &subset, &path)?;
            (
                normalize_dynamic_range_to_u16(&values, |value| f64::from(value)),
                u16::MAX,
            )
        }
        "int16" => {
            let values = array_values::<i16, _>(&array, &subset, &path)?;
            (
                normalize_dynamic_range_to_u16(&values, |value| f64::from(value)),
                u16::MAX,
            )
        }
        "int32" => {
            let values = array_values::<i32, _>(&array, &subset, &path)?;
            (
                normalize_dynamic_range_to_u16(&values, |value| value as f64),
                u16::MAX,
            )
        }
        "float32" => {
            let values = array_values::<f32, _>(&array, &subset, &path)?;
            (
                normalize_dynamic_range_to_u16(&values, |value| value as f64),
                u16::MAX,
            )
        }
        "float64" => {
            let values = array_values::<f64, _>(&array, &subset, &path)?;
            (
                normalize_dynamic_range_to_u16(&values, |value| value),
                u16::MAX,
            )
        }
        other => {
            return Err(RasterPlaneLoadError::UnsupportedDtype {
                dtype: other.to_owned(),
            });
        }
    };

    let expected_pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: "zarr plane dimensions overflow".to_owned(),
        })?;
    if pixels.len() != expected_pixels {
        return Err(RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: format!(
                "decoded zarr plane length mismatch: expected {expected_pixels} bytes, got {}",
                pixels.len()
            ),
        });
    }

    Ok(RasterPlane {
        width,
        height,
        max_value,
        pixels,
    })
}

fn source_path_from_uri(uri: &str) -> Result<PathBuf, RasterPlaneLoadError> {
    if let Some(raw_path) = uri.strip_prefix("file://") {
        if raw_path.is_empty() {
            return Err(RasterPlaneLoadError::InvalidSourceUri {
                uri: uri.to_owned(),
                message: "file URI must include a path".to_owned(),
            });
        }
        if cfg!(windows) {
            return Ok(PathBuf::from(raw_path.trim_start_matches('/')));
        }
        return Ok(PathBuf::from(raw_path));
    }
    if uri.trim().is_empty() {
        return Err(RasterPlaneLoadError::InvalidSourceUri {
            uri: uri.to_owned(),
            message: "source URI must not be empty".to_owned(),
        });
    }
    Ok(PathBuf::from(uri))
}

fn channels_for_color_type(color_type: ColorType) -> usize {
    match color_type {
        ColorType::Gray(_) | ColorType::Palette(_) => 1,
        ColorType::GrayA(_) => 2,
        ColorType::RGB(_) | ColorType::YCbCr(_) => 3,
        ColorType::CMYK(_) | ColorType::RGBA(_) => 4,
        _ => 1,
    }
}

fn plane_ranges(
    shape: &[u64],
    axis_order: &[AxisName],
    t_index: u64,
    z_index: u64,
    channel_index: u64,
) -> Vec<Range<u64>> {
    if axis_order.len() == shape.len() {
        return axis_order
            .iter()
            .zip(shape.iter().copied())
            .map(|(axis, dimension)| {
                if dimension == 0 {
                    return 0..0;
                }
                match axis {
                    AxisName::Y | AxisName::X => 0..dimension,
                    AxisName::T => {
                        let start = t_index.min(dimension - 1);
                        start..(start + 1)
                    }
                    AxisName::Z => {
                        let start = z_index.min(dimension - 1);
                        start..(start + 1)
                    }
                    AxisName::C => {
                        let start = channel_index.min(dimension - 1);
                        start..(start + 1)
                    }
                    AxisName::Extra(_) => 0..1,
                }
            })
            .collect();
    }

    let mut ranges = Vec::with_capacity(shape.len());
    for (index, dimension) in shape.iter().copied().enumerate() {
        if index >= shape.len().saturating_sub(2) {
            ranges.push(0..dimension);
        } else {
            ranges.push(0..1);
        }
    }
    ranges
}

fn interleaved_channel<T: Copy>(
    samples: &[T],
    channel_count: usize,
    channel_index: usize,
    expected_pixels: usize,
    path: &Path,
) -> Result<Vec<T>, RasterPlaneLoadError> {
    let expected_samples = expected_pixels.checked_mul(channel_count).ok_or_else(|| {
        RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: "sample count overflow".to_owned(),
        }
    })?;
    if samples.len() < expected_samples {
        return Err(RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: format!(
                "decoded TIFF samples are truncated: expected {expected_samples}, got {}",
                samples.len()
            ),
        });
    }

    let mut pixels = Vec::with_capacity(expected_pixels);
    if channel_count == 0 {
        return Err(RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: "TIFF channel count must be non-zero".to_owned(),
        });
    }
    for pixel_index in 0..expected_pixels {
        let sample_index = pixel_index * channel_count + channel_index;
        let sample = samples[sample_index];
        pixels.push(sample);
    }
    Ok(pixels)
}

fn tiff_page_index(
    shape: &AxisShape,
    axis_order: &[AxisName],
    t_index: u64,
    z_index: u64,
    channel_index: u64,
) -> u64 {
    let mut plane_axes = axis_order
        .iter()
        .filter(|axis| !matches!(axis, AxisName::Y | AxisName::X))
        .collect::<Vec<_>>();
    if plane_axes.is_empty() {
        return 0;
    }

    let mut index = 0_u64;
    let mut stride = 1_u64;
    plane_axes.reverse();
    for axis in plane_axes {
        let (dimension, coordinate) = match axis {
            AxisName::T => (shape.t.max(1), t_index),
            AxisName::C => (shape.c.max(1), channel_index),
            AxisName::Z => (shape.z.max(1), z_index),
            AxisName::Extra(name) => {
                let dimension = shape.extra_axes.get(name).copied().unwrap_or(1).max(1);
                (dimension, 0)
            }
            AxisName::Y | AxisName::X => continue,
        };
        let clamped = coordinate.min(dimension.saturating_sub(1));
        index = index.saturating_add(clamped.saturating_mul(stride));
        stride = stride.saturating_mul(dimension);
    }
    index
}

fn array_values<T, TStorage>(
    array: &Array<TStorage>,
    subset: &ArraySubset,
    path: &Path,
) -> Result<Vec<T>, RasterPlaneLoadError>
where
    TStorage: ?Sized + zarrs::storage::ReadableStorageTraits + 'static,
    T: zarrs::array::ElementOwned,
{
    array
        .retrieve_array_subset::<Vec<T>>(subset)
        .map_err(|error| RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: error.to_string(),
        })
}

fn normalize_dynamic_range_to_u16<T: Copy>(values: &[T], to_f64: fn(T) -> f64) -> Vec<u16> {
    let mut min_value = f64::INFINITY;
    let mut max_value = f64::NEG_INFINITY;

    for value in values {
        let scalar = to_f64(*value);
        if !scalar.is_finite() {
            continue;
        }
        if scalar < min_value {
            min_value = scalar;
        }
        if scalar > max_value {
            max_value = scalar;
        }
    }

    if !min_value.is_finite() || !max_value.is_finite() {
        return vec![0_u16; values.len()];
    }

    let span = max_value - min_value;
    if span <= f64::EPSILON {
        return vec![0_u16; values.len()];
    }

    values
        .iter()
        .map(|value| {
            let scalar = to_f64(*value);
            if !scalar.is_finite() {
                return 0_u16;
            }
            (((scalar - min_value) / span) * f64::from(u16::MAX))
                .round()
                .clamp(0.0, f64::from(u16::MAX)) as u16
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs::File;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::model::{AxisName, AxisShape, SourceKind};

    use super::{RasterPlaneLoadRequest, load_raster_plane, normalize_dynamic_range_to_u16};

    fn unique_path(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida_raster_plane_{prefix}_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    fn write_gray16_tiff(path: &Path, width: u32, height: u32, pixels: &[u16]) {
        let file = File::create(path).expect("test tiff file should be created");
        let mut encoder =
            tiff::encoder::TiffEncoder::new(file).expect("tiff encoder creation should succeed");
        let image = encoder
            .new_image::<tiff::encoder::colortype::Gray16>(width, height)
            .expect("tiff image creation should succeed");
        image
            .write_data(pixels)
            .expect("tiff pixel payload write should succeed");
    }

    #[test]
    fn normalizes_dynamic_range_to_visible_uint16_span() {
        let values = vec![87_u16, 98_u16, 109_u16, 121_u16];
        let normalized = normalize_dynamic_range_to_u16(&values, |value| f64::from(value));
        assert_eq!(normalized.len(), values.len());
        assert_eq!(normalized.first().copied(), Some(0));
        assert_eq!(normalized.last().copied(), Some(u16::MAX));
        assert!(normalized[1] > normalized[0]);
        assert!(normalized[2] > normalized[1]);
    }

    #[test]
    fn loads_uint16_tiff_without_loss_of_source_dynamic_range() {
        let source_path = unique_path("uint16_tiff").with_extension("tif");
        write_gray16_tiff(&source_path, 2, 2, &[87, 98, 109, 121]);

        let plane = load_raster_plane(&RasterPlaneLoadRequest {
            source_uri: source_path.display().to_string(),
            source_kind: SourceKind::Tiff,
            dtype: "uint16".to_owned(),
            axis_order: vec![
                AxisName::T,
                AxisName::C,
                AxisName::Z,
                AxisName::Y,
                AxisName::X,
            ],
            shape: AxisShape {
                t: 1,
                c: 1,
                z: 1,
                y: 2,
                x: 2,
                extra_axes: BTreeMap::new(),
            },
            t_index: 0,
            z_index: 0,
            channel_index: 0,
        })
        .expect("uint16 tiff raster load should succeed");

        assert_eq!(plane.width, 2);
        assert_eq!(plane.height, 2);
        assert_eq!(plane.max_value, u16::MAX);
        assert_eq!(plane.pixels, vec![87, 98, 109, 121]);

        std::fs::remove_file(source_path).expect("fixture cleanup should succeed");
    }
}
