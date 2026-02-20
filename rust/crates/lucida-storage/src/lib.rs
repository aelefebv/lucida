use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use lucida_protocol::DatasetHandle;
use serde::Deserialize;
use serde_json::{json, Value};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("unsupported uri scheme for {0}")]
    UnsupportedUri(String),
    #[error("dataset path does not exist: {0}")]
    MissingDataset(String),
    #[error("metadata read failed at {0}: {1}")]
    MetadataRead(String, String),
    #[error("unsupported OME-Zarr version: {0}")]
    UnsupportedVersion(String),
    #[error("unsupported dtype: {0}")]
    UnsupportedDtype(String),
    #[error("unsupported compressor: {0}")]
    UnsupportedCompressor(String),
    #[error("unsupported array layout: {0}")]
    UnsupportedLayout(String),
    #[error("missing chunk file: {0}")]
    MissingChunk(String),
    #[error("invalid chunk length at {0}: expected {1} bytes, got {2}")]
    InvalidChunkLength(String, usize, usize),
}

#[derive(Clone, Debug, Default)]
pub struct OpenDatasetOptions {
    pub axis_map: BTreeMap<String, String>,
    pub read_only: bool,
}

#[derive(Clone, Debug)]
pub struct OpenedDataset {
    pub handle: DatasetHandle,
    pub compatibility_mode: Option<String>,
}

#[derive(Clone, Debug)]
pub struct U16FramePlane {
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct U16Volume {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub voxels: Vec<u16>,
}

#[derive(Debug, Deserialize)]
struct ZArrayMetadata {
    zarr_format: u8,
    shape: Vec<usize>,
    chunks: Vec<usize>,
    dtype: String,
    compressor: Option<Value>,
    #[serde(default)]
    dimension_separator: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ArrayAttrs {
    #[serde(rename = "_ARRAY_DIMENSIONS")]
    array_dimensions: Option<Vec<String>>,
}

pub fn open_dataset(uri: &str, options: &OpenDatasetOptions) -> Result<OpenedDataset, StorageError> {
    let dataset_path = uri_to_local_path(uri)?;
    if !dataset_path.exists() {
        return Err(StorageError::MissingDataset(dataset_path.display().to_string()));
    }

    let metadata = read_multiscale_metadata(&dataset_path)?;
    let ome_version = metadata
        .get("version")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            metadata
                .get("multiscales")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|entry| entry.get("version"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        });

    let compatibility_mode = match ome_version.as_deref() {
        Some("0.5") => None,
        Some("0.4") => Some("best_effort_0_4".to_string()),
        Some(other) => return Err(StorageError::UnsupportedVersion(other.to_string())),
        None => None,
    };

    let mut merged_metadata = json!({
        "multiscales": metadata.get("multiscales").cloned().unwrap_or_else(|| json!([])),
        "axis_map": options.axis_map,
        "read_only": options.read_only,
    });

    if let Some(mode) = compatibility_mode.clone() {
        merged_metadata["compatibility_mode"] = json!(mode);
    }

    Ok(OpenedDataset {
        handle: DatasetHandle {
            id: format!("dataset-{}", Uuid::new_v4()),
            uri: uri.to_string(),
            ome_version,
            multiscale_metadata: merged_metadata,
        },
        compatibility_mode,
    })
}

pub fn read_u16_plane(
    uri: &str,
    axis_indices: &BTreeMap<String, usize>,
) -> Result<U16FramePlane, StorageError> {
    let dataset_path = uri_to_local_path(uri)?;
    if !dataset_path.exists() {
        return Err(StorageError::MissingDataset(dataset_path.display().to_string()));
    }

    let array_path = dataset_path.join("0");
    let zarray_path = array_path.join(".zarray");
    let zarray: ZArrayMetadata = read_json(&zarray_path)?;

    if zarray.zarr_format != 2 {
        return Err(StorageError::UnsupportedLayout(format!(
            "zarr_format {} is not supported",
            zarray.zarr_format
        )));
    }
    if zarray.dtype != "<u2" {
        return Err(StorageError::UnsupportedDtype(zarray.dtype));
    }
    if let Some(compressor) = zarray.compressor {
        return Err(StorageError::UnsupportedCompressor(compressor.to_string()));
    }
    if zarray.shape.len() != zarray.chunks.len() {
        return Err(StorageError::UnsupportedLayout(
            "shape/chunks rank mismatch".to_string(),
        ));
    }

    let dims = read_array_dimensions(&array_path, zarray.shape.len())?;
    let t_dim = axis_dim(&dims, "t")?;
    let c_dim = axis_dim(&dims, "c")?;
    let z_dim = axis_dim(&dims, "z")?;
    let y_dim = axis_dim(&dims, "y")?;
    let x_dim = axis_dim(&dims, "x")?;

    if zarray.chunks[y_dim] != zarray.shape[y_dim] || zarray.chunks[x_dim] != zarray.shape[x_dim] {
        return Err(StorageError::UnsupportedLayout(
            "slice reading currently requires full y/x chunk coverage".to_string(),
        ));
    }

    for (dim_idx, chunk) in zarray.chunks.iter().enumerate() {
        if dim_idx != y_dim && dim_idx != x_dim && *chunk != 1 {
            return Err(StorageError::UnsupportedLayout(format!(
                "chunk rank at dim {dim_idx} must be 1 for this slice reader"
            )));
        }
    }

    let t_index = axis_indices.get("t").copied().unwrap_or(0);
    let c_index = axis_indices.get("c").copied().unwrap_or(0);
    let z_index = axis_indices.get("z").copied().unwrap_or(0);

    if t_index >= zarray.shape[t_dim] || c_index >= zarray.shape[c_dim] || z_index >= zarray.shape[z_dim] {
        return Err(StorageError::UnsupportedLayout(format!(
            "axis index out of bounds (t={t_index}, c={c_index}, z={z_index})"
        )));
    }

    let mut chunk_indices = vec![0usize; zarray.shape.len()];
    chunk_indices[t_dim] = t_index / zarray.chunks[t_dim];
    chunk_indices[c_dim] = c_index / zarray.chunks[c_dim];
    chunk_indices[z_dim] = z_index / zarray.chunks[z_dim];
    chunk_indices[y_dim] = 0;
    chunk_indices[x_dim] = 0;

    let separator = zarray.dimension_separator.as_deref().unwrap_or(".");
    let chunk_path = chunk_path_for_separator(&array_path, &chunk_indices, separator);
    if !chunk_path.exists() {
        return Err(StorageError::MissingChunk(chunk_path.display().to_string()));
    }

    let bytes = fs::read(&chunk_path).map_err(|err| {
        StorageError::MetadataRead(chunk_path.display().to_string(), err.to_string())
    })?;

    let expected_len = zarray.shape[y_dim]
        .checked_mul(zarray.shape[x_dim])
        .and_then(|value| value.checked_mul(2))
        .ok_or_else(|| StorageError::UnsupportedLayout("frame byte length overflow".to_string()))?;
    if bytes.len() != expected_len {
        return Err(StorageError::InvalidChunkLength(
            chunk_path.display().to_string(),
            expected_len,
            bytes.len(),
        ));
    }

    Ok(U16FramePlane {
        width: zarray.shape[x_dim] as u32,
        height: zarray.shape[y_dim] as u32,
        bytes,
    })
}

pub fn read_u16_volume(
    uri: &str,
    axis_indices: &BTreeMap<String, usize>,
) -> Result<U16Volume, StorageError> {
    let dataset_path = uri_to_local_path(uri)?;
    if !dataset_path.exists() {
        return Err(StorageError::MissingDataset(dataset_path.display().to_string()));
    }

    let array_path = dataset_path.join("0");
    let zarray_path = array_path.join(".zarray");
    let zarray: ZArrayMetadata = read_json(&zarray_path)?;

    if zarray.zarr_format != 2 {
        return Err(StorageError::UnsupportedLayout(format!(
            "zarr_format {} is not supported",
            zarray.zarr_format
        )));
    }
    if zarray.dtype != "<u2" {
        return Err(StorageError::UnsupportedDtype(zarray.dtype));
    }
    if let Some(compressor) = zarray.compressor {
        return Err(StorageError::UnsupportedCompressor(compressor.to_string()));
    }
    if zarray.shape.len() != zarray.chunks.len() {
        return Err(StorageError::UnsupportedLayout(
            "shape/chunks rank mismatch".to_string(),
        ));
    }

    let dims = read_array_dimensions(&array_path, zarray.shape.len())?;
    let t_dim = axis_dim(&dims, "t")?;
    let c_dim = axis_dim(&dims, "c")?;
    let z_dim = axis_dim(&dims, "z")?;
    let y_dim = axis_dim(&dims, "y")?;
    let x_dim = axis_dim(&dims, "x")?;

    if zarray.chunks[y_dim] != zarray.shape[y_dim] || zarray.chunks[x_dim] != zarray.shape[x_dim] {
        return Err(StorageError::UnsupportedLayout(
            "slice reading currently requires full y/x chunk coverage".to_string(),
        ));
    }
    for (dim_idx, chunk) in zarray.chunks.iter().enumerate() {
        if dim_idx != y_dim && dim_idx != x_dim && *chunk != 1 {
            return Err(StorageError::UnsupportedLayout(format!(
                "chunk rank at dim {dim_idx} must be 1 for this slice reader"
            )));
        }
    }

    let t_index = axis_indices.get("t").copied().unwrap_or(0);
    let c_index = axis_indices.get("c").copied().unwrap_or(0);
    if t_index >= zarray.shape[t_dim] || c_index >= zarray.shape[c_dim] {
        return Err(StorageError::UnsupportedLayout(format!(
            "axis index out of bounds (t={t_index}, c={c_index})"
        )));
    }

    let width = zarray.shape[x_dim] as u32;
    let height = zarray.shape[y_dim] as u32;
    let depth = zarray.shape[z_dim] as u32;
    let plane_len = zarray.shape[y_dim]
        .checked_mul(zarray.shape[x_dim])
        .ok_or_else(|| StorageError::UnsupportedLayout("volume plane length overflow".to_string()))?;
    let expected_chunk_len = plane_len
        .checked_mul(2)
        .ok_or_else(|| StorageError::UnsupportedLayout("volume chunk length overflow".to_string()))?;

    let separator = zarray.dimension_separator.as_deref().unwrap_or(".");
    let mut voxels = Vec::with_capacity(
        plane_len
            .checked_mul(depth as usize)
            .ok_or_else(|| StorageError::UnsupportedLayout("volume voxel count overflow".to_string()))?,
    );

    for z_index in 0..depth as usize {
        let mut chunk_indices = vec![0usize; zarray.shape.len()];
        chunk_indices[t_dim] = t_index / zarray.chunks[t_dim];
        chunk_indices[c_dim] = c_index / zarray.chunks[c_dim];
        chunk_indices[z_dim] = z_index / zarray.chunks[z_dim];
        chunk_indices[y_dim] = 0;
        chunk_indices[x_dim] = 0;

        let chunk_path = chunk_path_for_separator(&array_path, &chunk_indices, separator);
        if !chunk_path.exists() {
            return Err(StorageError::MissingChunk(chunk_path.display().to_string()));
        }
        let bytes = fs::read(&chunk_path).map_err(|err| {
            StorageError::MetadataRead(chunk_path.display().to_string(), err.to_string())
        })?;
        if bytes.len() != expected_chunk_len {
            return Err(StorageError::InvalidChunkLength(
                chunk_path.display().to_string(),
                expected_chunk_len,
                bytes.len(),
            ));
        }
        for chunk in bytes.chunks_exact(2) {
            voxels.push(u16::from_le_bytes([chunk[0], chunk[1]]));
        }
    }

    Ok(U16Volume {
        width,
        height,
        depth,
        voxels,
    })
}

pub fn uri_to_local_path(uri: &str) -> Result<PathBuf, StorageError> {
    if let Some(stripped) = uri.strip_prefix("file://") {
        return Ok(PathBuf::from(stripped));
    }

    if uri.contains("://") {
        return Err(StorageError::UnsupportedUri(uri.to_string()));
    }

    Ok(PathBuf::from(uri))
}

fn read_multiscale_metadata(dataset_path: &Path) -> Result<Value, StorageError> {
    let zarr_json = dataset_path.join("zarr.json");
    if zarr_json.exists() {
        let parsed: Value = read_json(&zarr_json)?;
        if let Some(attributes) = parsed.get("attributes") {
            return Ok(attributes.clone());
        }
        return Ok(parsed);
    }

    let legacy_attrs = dataset_path.join(".zattrs");
    if legacy_attrs.exists() {
        let parsed: Value = read_json(&legacy_attrs)?;
        return Ok(parsed);
    }

    Ok(json!({}))
}

fn read_array_dimensions(array_path: &Path, rank: usize) -> Result<Vec<String>, StorageError> {
    let attrs_path = array_path.join(".zattrs");
    if !attrs_path.exists() {
        return Ok(default_dimensions(rank));
    }

    let attrs: ArrayAttrs = read_json(&attrs_path)?;
    if let Some(dimensions) = attrs.array_dimensions {
        if dimensions.len() != rank {
            return Err(StorageError::UnsupportedLayout(format!(
                "_ARRAY_DIMENSIONS rank {} does not match shape rank {rank}",
                dimensions.len()
            )));
        }
        return Ok(dimensions);
    }

    Ok(default_dimensions(rank))
}

fn default_dimensions(rank: usize) -> Vec<String> {
    let canonical = ["t", "c", "z", "y", "x"];
    canonical
        .iter()
        .take(rank)
        .map(|label| (*label).to_string())
        .collect()
}

fn axis_dim(dimensions: &[String], axis: &str) -> Result<usize, StorageError> {
    dimensions
        .iter()
        .position(|label| label == axis)
        .ok_or_else(|| StorageError::UnsupportedLayout(format!("missing axis {axis} in dimensions")))
}

fn chunk_path_for_separator(array_path: &Path, indices: &[usize], separator: &str) -> PathBuf {
    if separator == "/" {
        let mut path = array_path.to_path_buf();
        for index in indices {
            path.push(index.to_string());
        }
        return path;
    }

    let key = indices
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<String>>()
        .join(".");
    array_path.join(key)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, StorageError> {
    let content = fs::read_to_string(path)
        .map_err(|err| StorageError::MetadataRead(path.display().to_string(), err.to_string()))?;
    serde_json::from_str(&content)
        .map_err(|err| StorageError::MetadataRead(path.display().to_string(), err.to_string()))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn opens_ome_zarr_v05_fixture() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let attrs_path = temp_dir.path().join(".zattrs");
        fs::write(
            &attrs_path,
            r#"{"multiscales":[{"version":"0.5","datasets":[{"path":"0"}]}]}"#,
        )
        .expect("write attrs");

        let result = open_dataset(
            temp_dir.path().to_str().expect("path as str"),
            &OpenDatasetOptions::default(),
        )
        .expect("open dataset");

        assert_eq!(result.handle.ome_version.as_deref(), Some("0.5"));
        assert!(result.compatibility_mode.is_none());
    }

    #[test]
    fn opens_ome_zarr_v04_in_best_effort_mode() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let attrs_path = temp_dir.path().join(".zattrs");
        fs::write(
            &attrs_path,
            r#"{"multiscales":[{"version":"0.4","datasets":[{"path":"0"}]}]}"#,
        )
        .expect("write attrs");

        let result = open_dataset(
            temp_dir.path().to_str().expect("path as str"),
            &OpenDatasetOptions::default(),
        )
        .expect("open dataset");

        assert_eq!(result.handle.ome_version.as_deref(), Some("0.4"));
        assert_eq!(result.compatibility_mode.as_deref(), Some("best_effort_0_4"));
    }

    #[test]
    fn reads_u16_plane_from_chunked_fixture() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let dataset = temp_dir.path();
        fs::create_dir_all(dataset.join("0/0/0/1/0")).expect("create chunk parent");

        fs::write(
            dataset.join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [1,1,4,8,8],
                "chunks": [1,1,1,8,8],
                "dtype": "<u2",
                "compressor": null,
                "fill_value": 0,
                "order": "C",
                "filters": null,
                "dimension_separator": "/"
            }"#,
        )
        .expect("write .zarray");
        fs::write(
            dataset.join("0/.zattrs"),
            r#"{"_ARRAY_DIMENSIONS":["t","c","z","y","x"]}"#,
        )
        .expect("write array attrs");

        let mut bytes = Vec::with_capacity(8 * 8 * 2);
        for idx in 0..64u16 {
            let value = 1000u16 + idx;
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        fs::write(dataset.join("0/0/0/1/0/0"), bytes).expect("write chunk");

        let mut axis = BTreeMap::new();
        axis.insert("t".to_string(), 0);
        axis.insert("c".to_string(), 0);
        axis.insert("z".to_string(), 1);

        let plane = read_u16_plane(dataset.to_str().expect("path str"), &axis)
            .expect("read plane should succeed");
        assert_eq!(plane.width, 8);
        assert_eq!(plane.height, 8);
        assert_eq!(plane.bytes.len(), 128);

        let first = u16::from_le_bytes([plane.bytes[0], plane.bytes[1]]);
        let last = u16::from_le_bytes([plane.bytes[126], plane.bytes[127]]);
        assert_eq!(first, 1000);
        assert_eq!(last, 1063);
    }

    #[test]
    fn rejects_unsupported_dtype() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let dataset = temp_dir.path();
        fs::create_dir_all(dataset.join("0")).expect("create array dir");
        fs::write(
            dataset.join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [1,1,1,8,8],
                "chunks": [1,1,1,8,8],
                "dtype": "<f4",
                "compressor": null,
                "dimension_separator": "/"
            }"#,
        )
        .expect("write .zarray");

        let err =
            read_u16_plane(dataset.to_str().expect("path str"), &BTreeMap::new()).expect_err("dtype should fail");
        assert!(matches!(err, StorageError::UnsupportedDtype(_)));
    }

    #[test]
    fn reads_u16_volume_from_chunked_fixture() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let dataset = temp_dir.path();
        for z in 0..4usize {
            fs::create_dir_all(dataset.join(format!("0/0/0/{z}/0"))).expect("create chunk parent");
        }

        fs::write(
            dataset.join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [1,1,4,8,8],
                "chunks": [1,1,1,8,8],
                "dtype": "<u2",
                "compressor": null,
                "fill_value": 0,
                "order": "C",
                "filters": null,
                "dimension_separator": "/"
            }"#,
        )
        .expect("write .zarray");
        fs::write(
            dataset.join("0/.zattrs"),
            r#"{"_ARRAY_DIMENSIONS":["t","c","z","y","x"]}"#,
        )
        .expect("write array attrs");

        for z in 0..4u16 {
            let mut bytes = Vec::with_capacity(8 * 8 * 2);
            for idx in 0..64u16 {
                let value = 2000u16 + z * 100 + idx;
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            fs::write(dataset.join(format!("0/0/0/{z}/0/0")), bytes).expect("write chunk");
        }

        let mut axis = BTreeMap::new();
        axis.insert("t".to_string(), 0);
        axis.insert("c".to_string(), 0);

        let volume = read_u16_volume(dataset.to_str().expect("path str"), &axis)
            .expect("read volume should succeed");
        assert_eq!(volume.width, 8);
        assert_eq!(volume.height, 8);
        assert_eq!(volume.depth, 4);
        assert_eq!(volume.voxels.len(), 4 * 8 * 8);
        assert_eq!(volume.voxels[0], 2000);
        assert_eq!(volume.voxels[64], 2100);
        assert_eq!(volume.voxels[128], 2200);
        assert_eq!(volume.voxels[192], 2300);
    }
}
