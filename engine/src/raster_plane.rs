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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterPlaneLoadRequest {
    pub source_uri: String,
    pub source_kind: SourceKind,
    pub dtype: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterPlane {
    pub width: u64,
    pub height: u64,
    pub pixels: Vec<u8>,
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
        SourceKind::Tiff | SourceKind::BigTiff => load_tiff_plane(&request.source_uri),
        SourceKind::OmeZarr | SourceKind::Zarr => load_zarr_plane(&request.source_uri, &request.dtype),
        SourceKind::Other => Err(RasterPlaneLoadError::UnsupportedSourceKind {
            source_kind: request.source_kind,
        }),
    }
}

fn load_tiff_plane(uri: &str) -> Result<RasterPlane, RasterPlaneLoadError> {
    let path = source_path_from_uri(uri)?;
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
    let (width_u32, height_u32) =
        decoder
            .dimensions()
            .map_err(|error| RasterPlaneLoadError::DecodeFailed {
                path: path.display().to_string(),
                message: error.to_string(),
            })?;
    let width = u64::from(width_u32);
    let height = u64::from(height_u32);
    let color_type = decoder.colortype().map_err(|error| {
        RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: error.to_string(),
        }
    })?;
    let channel_count = channels_for_color_type(color_type);
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
    let pixels = match image {
        TiffDecodingResult::U8(samples) => interleaved_to_u8(
            &samples,
            channel_count,
            expected_pixels,
            |value| value,
            &path,
        )?,
        TiffDecodingResult::U16(samples) => interleaved_to_u8(
            &samples,
            channel_count,
            expected_pixels,
            |value| (value >> 8) as u8,
            &path,
        )?,
        TiffDecodingResult::I8(samples) => interleaved_to_u8(
            &samples,
            channel_count,
            expected_pixels,
            |value| value.max(0) as u8,
            &path,
        )?,
        TiffDecodingResult::I16(samples) => interleaved_to_u8(
            &samples,
            channel_count,
            expected_pixels,
            |value| (value / 256).clamp(0, 255) as u8,
            &path,
        )?,
        TiffDecodingResult::U32(samples) => interleaved_to_u8(
            &samples,
            channel_count,
            expected_pixels,
            |value| (value >> 24) as u8,
            &path,
        )?,
        TiffDecodingResult::I32(samples) => interleaved_to_u8(
            &samples,
            channel_count,
            expected_pixels,
            |value| (value / 16_777_216).clamp(0, 255) as u8,
            &path,
        )?,
        TiffDecodingResult::F32(samples) => interleaved_to_u8(
            &samples,
            channel_count,
            expected_pixels,
            |value| normalize_float(value as f64),
            &path,
        )?,
        TiffDecodingResult::F64(samples) => interleaved_to_u8(
            &samples,
            channel_count,
            expected_pixels,
            normalize_float,
            &path,
        )?,
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
        pixels,
    })
}

fn load_zarr_plane(uri: &str, dtype: &str) -> Result<RasterPlane, RasterPlaneLoadError> {
    let path = source_path_from_uri(uri)?;
    let store: ReadableWritableListableStorage = Arc::new(
        FilesystemStore::new(&path).map_err(|error| RasterPlaneLoadError::ReadFailed {
            path: path.display().to_string(),
            message: error.to_string(),
        })?,
    );

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
    let ranges = plane_ranges(&shape);
    let subset = ArraySubset::new_with_ranges(&ranges);

    let pixels = match dtype {
        "uint8" => array
            .retrieve_array_subset::<Vec<u8>>(&subset)
            .map_err(|error| RasterPlaneLoadError::DecodeFailed {
                path: path.display().to_string(),
                message: error.to_string(),
            })?,
        "uint16" => array_to_u8::<u16, _>(&array, &subset, &path, |value| (value >> 8) as u8)?,
        "uint32" => {
            array_to_u8::<u32, _>(&array, &subset, &path, |value| (value >> 24) as u8)?
        }
        "int8" => array_to_u8::<i8, _>(&array, &subset, &path, |value| value.max(0_i8) as u8)?,
        "int16" => array_to_u8::<i16, _>(&array, &subset, &path, |value| {
            (value / 256_i16).clamp(0_i16, 255_i16) as u8
        })?,
        "int32" => array_to_u8::<i32, _>(&array, &subset, &path, |value| {
            (value / 16_777_216_i32).clamp(0_i32, 255_i32) as u8
        })?,
        "float32" => array_to_u8::<f32, _>(&array, &subset, &path, |value| {
            normalize_float(value as f64)
        })?,
        "float64" => array_to_u8::<f64, _>(&array, &subset, &path, normalize_float)?,
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

fn plane_ranges(shape: &[u64]) -> Vec<Range<u64>> {
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

fn interleaved_to_u8<T: Copy>(
    samples: &[T],
    channel_count: usize,
    expected_pixels: usize,
    to_u8: fn(T) -> u8,
    path: &Path,
) -> Result<Vec<u8>, RasterPlaneLoadError> {
    let expected_samples =
        expected_pixels
            .checked_mul(channel_count)
            .ok_or_else(|| RasterPlaneLoadError::DecodeFailed {
                path: path.display().to_string(),
                message: "sample count overflow".to_owned(),
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
        let sample_index = pixel_index * channel_count;
        let sample = samples[sample_index];
        pixels.push(to_u8(sample));
    }
    Ok(pixels)
}

fn array_to_u8<T, TStorage>(
    array: &Array<TStorage>,
    subset: &ArraySubset,
    path: &Path,
    to_u8: fn(T) -> u8,
) -> Result<Vec<u8>, RasterPlaneLoadError>
where
    TStorage: ?Sized + zarrs::storage::ReadableStorageTraits + 'static,
    T: zarrs::array::ElementOwned,
{
    let values = array
        .retrieve_array_subset::<Vec<T>>(subset)
        .map_err(|error| RasterPlaneLoadError::DecodeFailed {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
    Ok(values.into_iter().map(to_u8).collect())
}

fn normalize_float(value: f64) -> u8 {
    if !value.is_finite() {
        return 0;
    }
    if (0.0..=1.0).contains(&value) {
        return (value * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    value.round().clamp(0.0, 255.0) as u8
}
