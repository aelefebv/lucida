use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use lucida_protocol::DatasetHandle;
use serde::Deserialize;
use serde_json::{json, Value};
use thiserror::Error;
use uuid::Uuid;

const LAYOUT_VERSION: u32 = 1;

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
    #[error("invalid axis remap: {0}")]
    InvalidAxisRemap(String),
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

#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone)]
struct AxisMetadata {
    label: String,
    unit: Option<String>,
}

#[derive(Debug, Clone)]
struct CanonicalAxis {
    label: String,
    size: usize,
    unit: Option<String>,
    source_dim: Option<usize>,
    implicit_singleton: bool,
}

#[derive(Debug, Clone)]
struct DatasetLayout {
    ome_version: Option<String>,
    compatibility_mode: Option<String>,
    multiscales: Value,
    array_path: PathBuf,
    zarray: ZArrayMetadata,
    canonical_axes: BTreeMap<String, CanonicalAxis>,
    canonical_axis_order: Vec<String>,
    canonical_to_source_dim: BTreeMap<String, usize>,
    implicit_singleton_axes: Vec<String>,
    spatial_scale_zyx: [f64; 3],
}

impl DatasetLayout {
    fn axis(&self, label: &str) -> Result<&CanonicalAxis, StorageError> {
        self.canonical_axes.get(label).ok_or_else(|| {
            StorageError::UnsupportedLayout(format!("missing required axis: {label}"))
        })
    }

    fn source_dim(&self, label: &str) -> Result<usize, StorageError> {
        self.axis(label)?.source_dim.ok_or_else(|| {
            StorageError::UnsupportedLayout(format!(
                "axis {label} is implicit singleton and has no source dimension"
            ))
        })
    }
}

pub fn open_dataset(
    uri: &str,
    options: &OpenDatasetOptions,
) -> Result<OpenedDataset, StorageError> {
    let layout = resolve_dataset_layout(uri, &options.axis_map)?;

    let canonical_axes = layout
        .canonical_axis_order
        .iter()
        .filter_map(|label| layout.canonical_axes.get(label))
        .map(|axis| {
            json!({
                "label": axis.label,
                "size": axis.size,
                "unit": axis.unit,
            })
        })
        .collect::<Vec<Value>>();

    let mut merged_metadata = json!({
        "multiscales": layout.multiscales,
        "axis_map": options.axis_map,
        "read_only": options.read_only,
        "layout_version": LAYOUT_VERSION,
        "canonical_axes": canonical_axes,
        "canonical_to_source_dim": layout.canonical_to_source_dim,
        "implicit_singleton_axes": layout.implicit_singleton_axes,
        "spatial_scale_zyx": layout.spatial_scale_zyx,
    });

    if let Some(mode) = layout.compatibility_mode.clone() {
        merged_metadata["compatibility_mode"] = json!(mode);
    }

    Ok(OpenedDataset {
        handle: DatasetHandle {
            id: format!("dataset-{}", Uuid::new_v4()),
            uri: uri.to_string(),
            ome_version: layout.ome_version,
            multiscale_metadata: merged_metadata,
        },
        compatibility_mode: layout.compatibility_mode,
    })
}

pub fn read_u16_plane(
    uri: &str,
    axis_indices: &BTreeMap<String, usize>,
    axis_map: &BTreeMap<String, String>,
) -> Result<U16FramePlane, StorageError> {
    let layout = resolve_dataset_layout(uri, axis_map)?;
    validate_u16_uncompressed_zarr(&layout.zarray)?;
    validate_chunk_constraints(&layout)?;

    let t_axis = layout.axis("t")?;
    let c_axis = layout.axis("c")?;
    let z_axis = layout.axis("z")?;
    let y_axis = layout.axis("y")?;
    let x_axis = layout.axis("x")?;

    let t_index = axis_indices.get("t").copied().unwrap_or(0);
    let c_index = axis_indices.get("c").copied().unwrap_or(0);
    let z_index = axis_indices.get("z").copied().unwrap_or(0);

    if t_index >= t_axis.size || c_index >= c_axis.size || z_index >= z_axis.size {
        return Err(StorageError::UnsupportedLayout(format!(
            "axis index out of bounds (t={t_index}, c={c_index}, z={z_index})"
        )));
    }

    let rank = layout.zarray.shape.len();
    let y_dim = layout.source_dim("y")?;
    let x_dim = layout.source_dim("x")?;
    let z_dim = layout.source_dim("z")?;
    let mut plane_u16 = vec![
        0u16;
        y_axis.size.checked_mul(x_axis.size).ok_or_else(|| {
            StorageError::UnsupportedLayout("frame plane length overflow".to_string())
        })?
    ];

    let z_chunk_index = z_index / layout.zarray.chunks[z_dim];
    let z_chunk_start = z_chunk_index * layout.zarray.chunks[z_dim];
    let z_local = z_index.saturating_sub(z_chunk_start);

    let y_chunk_count = chunk_count(y_axis.size, layout.zarray.chunks[y_dim]);
    let x_chunk_count = chunk_count(x_axis.size, layout.zarray.chunks[x_dim]);
    for y_chunk in 0..y_chunk_count {
        let y_start = y_chunk * layout.zarray.chunks[y_dim];
        let y_extent = chunk_extent_for_dim(&layout.zarray, y_dim, y_chunk)?;
        for x_chunk in 0..x_chunk_count {
            let x_start = x_chunk * layout.zarray.chunks[x_dim];
            let x_extent = chunk_extent_for_dim(&layout.zarray, x_dim, x_chunk)?;

            let mut chunk_indices = vec![0usize; rank];
            set_chunk_axis_index(&mut chunk_indices, &layout, "t", t_index);
            set_chunk_axis_index(&mut chunk_indices, &layout, "c", c_index);
            chunk_indices[z_dim] = z_chunk_index;
            chunk_indices[y_dim] = y_chunk;
            chunk_indices[x_dim] = x_chunk;

            let (chunk_bytes, chunk_extents) = read_chunk_bytes(&layout, &chunk_indices)?;
            if z_local >= chunk_extents[z_dim] {
                return Err(StorageError::UnsupportedLayout(format!(
                    "z local index out of chunk bounds at z={z_index}"
                )));
            }

            let mut local_coords = vec![0usize; rank];
            set_local_axis_offset(&mut local_coords, &layout, "t", t_index, &chunk_indices)?;
            set_local_axis_offset(&mut local_coords, &layout, "c", c_index, &chunk_indices)?;
            local_coords[z_dim] = z_local;

            for local_y in 0..y_extent {
                local_coords[y_dim] = local_y;
                let global_y = y_start + local_y;
                for local_x in 0..x_extent {
                    local_coords[x_dim] = local_x;
                    let global_x = x_start + local_x;
                    let chunk_linear = linear_index_c_order(&local_coords, &chunk_extents)?;
                    let value = read_u16_at(&chunk_bytes, chunk_linear)?;
                    let out_linear = global_y
                        .checked_mul(x_axis.size)
                        .and_then(|value| value.checked_add(global_x))
                        .ok_or_else(|| {
                            StorageError::UnsupportedLayout(
                                "frame output indexing overflow".to_string(),
                            )
                        })?;
                    plane_u16[out_linear] = value;
                }
            }
        }
    }

    let mut bytes = Vec::with_capacity(plane_u16.len() * 2);
    for value in plane_u16 {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    Ok(U16FramePlane {
        width: x_axis.size as u32,
        height: y_axis.size as u32,
        bytes,
    })
}

pub fn read_u16_volume(
    uri: &str,
    axis_indices: &BTreeMap<String, usize>,
    axis_map: &BTreeMap<String, String>,
) -> Result<U16Volume, StorageError> {
    let layout = resolve_dataset_layout(uri, axis_map)?;
    validate_u16_uncompressed_zarr(&layout.zarray)?;
    validate_chunk_constraints(&layout)?;

    let t_axis = layout.axis("t")?;
    let c_axis = layout.axis("c")?;
    let z_axis = layout.axis("z")?;
    let y_axis = layout.axis("y")?;
    let x_axis = layout.axis("x")?;

    let t_index = axis_indices.get("t").copied().unwrap_or(0);
    let c_index = axis_indices.get("c").copied().unwrap_or(0);
    if t_index >= t_axis.size || c_index >= c_axis.size {
        return Err(StorageError::UnsupportedLayout(format!(
            "axis index out of bounds (t={t_index}, c={c_index})"
        )));
    }

    let width = x_axis.size as u32;
    let height = y_axis.size as u32;
    let depth = z_axis.size as u32;

    let plane_len = y_axis.size.checked_mul(x_axis.size).ok_or_else(|| {
        StorageError::UnsupportedLayout("volume plane length overflow".to_string())
    })?;
    let voxel_len = plane_len.checked_mul(depth as usize).ok_or_else(|| {
        StorageError::UnsupportedLayout("volume voxel count overflow".to_string())
    })?;
    let mut voxels = vec![0u16; voxel_len];

    let rank = layout.zarray.shape.len();
    let z_dim = layout.source_dim("z")?;
    let y_dim = layout.source_dim("y")?;
    let x_dim = layout.source_dim("x")?;
    let z_chunk_count = chunk_count(depth as usize, layout.zarray.chunks[z_dim]);
    let y_chunk_count = chunk_count(height as usize, layout.zarray.chunks[y_dim]);
    let x_chunk_count = chunk_count(width as usize, layout.zarray.chunks[x_dim]);

    for z_chunk in 0..z_chunk_count {
        let z_start = z_chunk * layout.zarray.chunks[z_dim];
        let z_extent = chunk_extent_for_dim(&layout.zarray, z_dim, z_chunk)?;
        for y_chunk in 0..y_chunk_count {
            let y_start = y_chunk * layout.zarray.chunks[y_dim];
            let y_extent = chunk_extent_for_dim(&layout.zarray, y_dim, y_chunk)?;
            for x_chunk in 0..x_chunk_count {
                let x_start = x_chunk * layout.zarray.chunks[x_dim];
                let x_extent = chunk_extent_for_dim(&layout.zarray, x_dim, x_chunk)?;

                let mut chunk_indices = vec![0usize; rank];
                set_chunk_axis_index(&mut chunk_indices, &layout, "t", t_index);
                set_chunk_axis_index(&mut chunk_indices, &layout, "c", c_index);
                chunk_indices[z_dim] = z_chunk;
                chunk_indices[y_dim] = y_chunk;
                chunk_indices[x_dim] = x_chunk;
                let (chunk_bytes, chunk_extents) = read_chunk_bytes(&layout, &chunk_indices)?;

                let mut local_coords = vec![0usize; rank];
                set_local_axis_offset(&mut local_coords, &layout, "t", t_index, &chunk_indices)?;
                set_local_axis_offset(&mut local_coords, &layout, "c", c_index, &chunk_indices)?;

                for local_z in 0..z_extent {
                    local_coords[z_dim] = local_z;
                    let global_z = z_start + local_z;
                    for local_y in 0..y_extent {
                        local_coords[y_dim] = local_y;
                        let global_y = y_start + local_y;
                        for local_x in 0..x_extent {
                            local_coords[x_dim] = local_x;
                            let global_x = x_start + local_x;

                            let chunk_linear = linear_index_c_order(&local_coords, &chunk_extents)?;
                            let value = read_u16_at(&chunk_bytes, chunk_linear)?;
                            let voxel_index = global_z
                                .checked_mul(height as usize)
                                .and_then(|value| value.checked_add(global_y))
                                .and_then(|value| value.checked_mul(width as usize))
                                .and_then(|value| value.checked_add(global_x))
                                .ok_or_else(|| {
                                    StorageError::UnsupportedLayout(
                                        "volume output indexing overflow".to_string(),
                                    )
                                })?;
                            voxels[voxel_index] = value;
                        }
                    }
                }
            }
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

fn resolve_dataset_layout(
    uri: &str,
    axis_map: &BTreeMap<String, String>,
) -> Result<DatasetLayout, StorageError> {
    let dataset_path = uri_to_local_path(uri)?;
    if !dataset_path.exists() {
        return Err(StorageError::MissingDataset(
            dataset_path.display().to_string(),
        ));
    }

    let metadata = read_multiscale_metadata(&dataset_path)?;
    let multiscales = metadata
        .get("multiscales")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let multiscale = metadata
        .get("multiscales")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .cloned();

    let ome_version = metadata
        .get("version")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .or_else(|| {
            multiscale
                .as_ref()
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

    let dataset_entry = multiscale
        .as_ref()
        .and_then(|entry| entry.get("datasets"))
        .and_then(Value::as_array)
        .and_then(|datasets| datasets.first())
        .cloned();

    let array_rel_path = dataset_entry
        .as_ref()
        .and_then(|entry| entry.get("path"))
        .and_then(Value::as_str)
        .unwrap_or("0");

    let array_path = dataset_path.join(array_rel_path);
    let zarray_path = array_path.join(".zarray");
    let zarray: ZArrayMetadata = read_json(&zarray_path)?;
    if zarray.shape.len() != zarray.chunks.len() {
        return Err(StorageError::UnsupportedLayout(
            "shape/chunks rank mismatch".to_string(),
        ));
    }

    let rank = zarray.shape.len();
    let array_dimensions = read_array_dimensions(&array_path, rank)?;
    let multiscale_axes = parse_multiscale_axes(multiscale.as_ref(), rank)?;

    if let (Some(array_dims), Some(multiscale_axes)) = (&array_dimensions, &multiscale_axes) {
        let multiscale_labels = multiscale_axes
            .iter()
            .map(|axis| axis.label.as_str())
            .collect::<Vec<&str>>();
        let array_labels = array_dims.iter().map(String::as_str).collect::<Vec<&str>>();
        if array_labels != multiscale_labels {
            return Err(StorageError::UnsupportedLayout(
                "ambiguous axis metadata: _ARRAY_DIMENSIONS conflicts with multiscales[0].axes"
                    .to_string(),
            ));
        }
    }

    let source_labels = if let Some(array_dims) = array_dimensions {
        array_dims
    } else if let Some(axes) = &multiscale_axes {
        axes.iter().map(|axis| axis.label.clone()).collect()
    } else {
        if compatibility_mode.is_some() {
            return Err(StorageError::UnsupportedLayout(
                "ambiguous axis metadata for OME-Zarr 0.4: missing _ARRAY_DIMENSIONS and multiscales[0].axes".to_string(),
            ));
        }
        default_dimensions(rank)?
    };

    if source_labels.len() != rank {
        return Err(StorageError::UnsupportedLayout(format!(
            "axis rank {} does not match array rank {rank}",
            source_labels.len()
        )));
    }

    let source_label_set = source_labels.iter().cloned().collect::<BTreeSet<String>>();
    for source_label in axis_map.keys() {
        if !source_label_set.contains(source_label) {
            return Err(StorageError::InvalidAxisRemap(format!(
                "source axis not found: {source_label}"
            )));
        }
    }

    let source_units = multiscale_axes
        .as_ref()
        .map(|axes| {
            axes.iter()
                .map(|axis| (axis.label.clone(), axis.unit.clone()))
                .collect::<BTreeMap<String, Option<String>>>()
        })
        .unwrap_or_default();

    let mut canonical_axes = BTreeMap::new();
    let mut canonical_to_source_dim = BTreeMap::new();
    let mut mapped_labels_in_source_order = Vec::with_capacity(source_labels.len());

    for (source_dim, source_label) in source_labels.iter().enumerate() {
        let mapped = axis_map
            .get(source_label)
            .cloned()
            .unwrap_or_else(|| source_label.clone());
        let canonical_label = canonical_label(&mapped)?;

        if canonical_axes.contains_key(&canonical_label) {
            return Err(StorageError::InvalidAxisRemap(format!(
                "duplicate canonical axis label: {canonical_label}"
            )));
        }

        let axis = CanonicalAxis {
            label: canonical_label.clone(),
            size: zarray.shape[source_dim],
            unit: source_units.get(source_label).cloned().unwrap_or(None),
            source_dim: Some(source_dim),
            implicit_singleton: false,
        };
        canonical_axes.insert(canonical_label.clone(), axis);
        canonical_to_source_dim.insert(canonical_label.clone(), source_dim);
        mapped_labels_in_source_order.push(canonical_label);
    }

    for required in ["z", "y", "x"] {
        if !canonical_axes.contains_key(required) {
            return Err(StorageError::UnsupportedLayout(format!(
                "missing required axis: {required}"
            )));
        }
    }

    let mut implicit_singleton_axes = Vec::new();
    for optional in ["t", "c"] {
        if canonical_axes.contains_key(optional) {
            continue;
        }
        canonical_axes.insert(
            optional.to_string(),
            CanonicalAxis {
                label: optional.to_string(),
                size: 1,
                unit: None,
                source_dim: None,
                implicit_singleton: true,
            },
        );
        implicit_singleton_axes.push(optional.to_string());
    }

    let mut canonical_axis_order = Vec::new();
    for builtin in ["t", "c", "z", "y", "x"] {
        if canonical_axes.contains_key(builtin) {
            canonical_axis_order.push(builtin.to_string());
        }
    }
    for label in mapped_labels_in_source_order {
        if is_builtin_axis(&label) {
            continue;
        }
        if !canonical_axis_order.contains(&label) {
            canonical_axis_order.push(label);
        }
    }

    let scale_values =
        parse_scale_values(dataset_entry.as_ref(), rank)?.unwrap_or_else(|| vec![1.0; rank]);

    let z_dim = *canonical_to_source_dim
        .get("z")
        .ok_or_else(|| StorageError::UnsupportedLayout("missing required axis: z".to_string()))?;
    let y_dim = *canonical_to_source_dim
        .get("y")
        .ok_or_else(|| StorageError::UnsupportedLayout("missing required axis: y".to_string()))?;
    let x_dim = *canonical_to_source_dim
        .get("x")
        .ok_or_else(|| StorageError::UnsupportedLayout("missing required axis: x".to_string()))?;

    let spatial_scale_zyx = [
        scale_values[z_dim],
        scale_values[y_dim],
        scale_values[x_dim],
    ];
    for (axis, scale) in [
        ("z", spatial_scale_zyx[0]),
        ("y", spatial_scale_zyx[1]),
        ("x", spatial_scale_zyx[2]),
    ] {
        if !scale.is_finite() || scale <= 0.0 {
            return Err(StorageError::UnsupportedLayout(format!(
                "invalid anisotropy scale for axis {axis}: {scale}"
            )));
        }
    }

    Ok(DatasetLayout {
        ome_version,
        compatibility_mode,
        multiscales,
        array_path,
        zarray,
        canonical_axes,
        canonical_axis_order,
        canonical_to_source_dim,
        implicit_singleton_axes,
        spatial_scale_zyx,
    })
}

fn validate_u16_uncompressed_zarr(zarray: &ZArrayMetadata) -> Result<(), StorageError> {
    if zarray.zarr_format != 2 {
        return Err(StorageError::UnsupportedLayout(format!(
            "zarr_format {} is not supported",
            zarray.zarr_format
        )));
    }
    if zarray.dtype != "<u2" {
        return Err(StorageError::UnsupportedDtype(zarray.dtype.clone()));
    }
    if let Some(compressor) = &zarray.compressor {
        return Err(StorageError::UnsupportedCompressor(compressor.to_string()));
    }
    Ok(())
}

fn validate_chunk_constraints(layout: &DatasetLayout) -> Result<(), StorageError> {
    for (dim_idx, chunk) in layout.zarray.chunks.iter().enumerate() {
        if *chunk == 0 {
            return Err(StorageError::UnsupportedLayout(format!(
                "chunk size at dim {dim_idx} must be > 0"
            )));
        }
        if *chunk > layout.zarray.shape[dim_idx] {
            return Err(StorageError::UnsupportedLayout(format!(
                "chunk size at dim {dim_idx} exceeds array shape"
            )));
        }
    }

    Ok(())
}

fn set_chunk_axis_index(
    chunk_indices: &mut [usize],
    layout: &DatasetLayout,
    axis_label: &str,
    axis_index: usize,
) {
    let Some(axis) = layout.canonical_axes.get(axis_label) else {
        return;
    };
    if axis.implicit_singleton {
        return;
    }
    if let Some(source_dim) = axis.source_dim {
        chunk_indices[source_dim] = axis_index / layout.zarray.chunks[source_dim];
    }
}

fn set_local_axis_offset(
    local_coords: &mut [usize],
    layout: &DatasetLayout,
    axis_label: &str,
    axis_index: usize,
    chunk_indices: &[usize],
) -> Result<(), StorageError> {
    let Some(axis) = layout.canonical_axes.get(axis_label) else {
        return Ok(());
    };
    if axis.implicit_singleton {
        return Ok(());
    }
    let Some(source_dim) = axis.source_dim else {
        return Ok(());
    };
    let chunk_size = layout.zarray.chunks[source_dim];
    let chunk_start = chunk_indices[source_dim]
        .checked_mul(chunk_size)
        .ok_or_else(|| StorageError::UnsupportedLayout("chunk start overflow".to_string()))?;
    let local = axis_index.saturating_sub(chunk_start);
    local_coords[source_dim] = local;
    Ok(())
}

fn read_chunk_bytes(
    layout: &DatasetLayout,
    chunk_indices: &[usize],
) -> Result<(Vec<u8>, Vec<usize>), StorageError> {
    let separator = layout.zarray.dimension_separator.as_deref().unwrap_or(".");
    let chunk_path = chunk_path_for_separator(&layout.array_path, chunk_indices, separator);
    if !chunk_path.exists() {
        return Err(StorageError::MissingChunk(chunk_path.display().to_string()));
    }
    let bytes = fs::read(&chunk_path).map_err(|err| {
        StorageError::MetadataRead(chunk_path.display().to_string(), err.to_string())
    })?;

    let chunk_extents = chunk_indices
        .iter()
        .enumerate()
        .map(|(dim, &chunk_index)| chunk_extent_for_dim(&layout.zarray, dim, chunk_index))
        .collect::<Result<Vec<usize>, StorageError>>()?;
    let expected_elements = chunk_extents.iter().try_fold(1usize, |acc, value| {
        acc.checked_mul(*value).ok_or_else(|| {
            StorageError::UnsupportedLayout("chunk element count overflow".to_string())
        })
    })?;
    let expected_len = expected_elements
        .checked_mul(2)
        .ok_or_else(|| StorageError::UnsupportedLayout("chunk byte length overflow".to_string()))?;
    if bytes.len() != expected_len {
        return Err(StorageError::InvalidChunkLength(
            chunk_path.display().to_string(),
            expected_len,
            bytes.len(),
        ));
    }
    Ok((bytes, chunk_extents))
}

fn chunk_extent_for_dim(
    zarray: &ZArrayMetadata,
    dim: usize,
    chunk_index: usize,
) -> Result<usize, StorageError> {
    let chunk_size = zarray.chunks[dim];
    let chunk_start = chunk_index
        .checked_mul(chunk_size)
        .ok_or_else(|| StorageError::UnsupportedLayout("chunk start overflow".to_string()))?;
    if chunk_start >= zarray.shape[dim] {
        return Err(StorageError::UnsupportedLayout(format!(
            "chunk index {chunk_index} out of bounds at dim {dim}"
        )));
    }
    Ok((zarray.shape[dim] - chunk_start).min(chunk_size))
}

fn chunk_count(size: usize, chunk_size: usize) -> usize {
    size.div_ceil(chunk_size)
}

fn linear_index_c_order(coords: &[usize], extents: &[usize]) -> Result<usize, StorageError> {
    if coords.len() != extents.len() {
        return Err(StorageError::UnsupportedLayout(
            "coordinate rank does not match chunk rank".to_string(),
        ));
    }
    let mut index = 0usize;
    for (&coord, &extent) in coords.iter().zip(extents.iter()) {
        if coord >= extent {
            return Err(StorageError::UnsupportedLayout(
                "chunk coordinate out of bounds".to_string(),
            ));
        }
        index = index
            .checked_mul(extent)
            .and_then(|value| value.checked_add(coord))
            .ok_or_else(|| StorageError::UnsupportedLayout("linear index overflow".to_string()))?;
    }
    Ok(index)
}

fn read_u16_at(bytes: &[u8], element_index: usize) -> Result<u16, StorageError> {
    let offset = element_index
        .checked_mul(2)
        .ok_or_else(|| StorageError::UnsupportedLayout("chunk byte offset overflow".to_string()))?;
    let end = offset
        .checked_add(2)
        .ok_or_else(|| StorageError::UnsupportedLayout("chunk byte slice overflow".to_string()))?;
    let pair = bytes.get(offset..end).ok_or_else(|| {
        StorageError::UnsupportedLayout("chunk byte offset out of bounds".to_string())
    })?;
    Ok(u16::from_le_bytes([pair[0], pair[1]]))
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

fn read_array_dimensions(
    array_path: &Path,
    rank: usize,
) -> Result<Option<Vec<String>>, StorageError> {
    let attrs_path = array_path.join(".zattrs");
    if !attrs_path.exists() {
        return Ok(None);
    }

    let attrs: ArrayAttrs = read_json(&attrs_path)?;
    let Some(dimensions) = attrs.array_dimensions else {
        return Ok(None);
    };

    if dimensions.len() != rank {
        return Err(StorageError::UnsupportedLayout(format!(
            "_ARRAY_DIMENSIONS rank {} does not match shape rank {rank}",
            dimensions.len()
        )));
    }

    for label in &dimensions {
        canonical_label(label)?;
    }

    Ok(Some(dimensions))
}

fn parse_multiscale_axes(
    multiscale: Option<&Value>,
    rank: usize,
) -> Result<Option<Vec<AxisMetadata>>, StorageError> {
    let Some(multiscale) = multiscale else {
        return Ok(None);
    };
    let Some(axes_value) = multiscale.get("axes") else {
        return Ok(None);
    };

    let axes = axes_value.as_array().ok_or_else(|| {
        StorageError::UnsupportedLayout(
            "ambiguous axis metadata: multiscales[0].axes is not an array".to_string(),
        )
    })?;

    if axes.len() != rank {
        return Err(StorageError::UnsupportedLayout(format!(
            "ambiguous axis metadata: multiscales[0].axes rank {} does not match array rank {rank}",
            axes.len()
        )));
    }

    let mut parsed = Vec::with_capacity(axes.len());
    for (index, axis) in axes.iter().enumerate() {
        if let Some(name) = axis.as_str() {
            parsed.push(AxisMetadata {
                label: canonical_label(name)?,
                unit: None,
            });
            continue;
        }

        let name = axis.get("name").and_then(Value::as_str).ok_or_else(|| {
            StorageError::UnsupportedLayout(format!(
                "ambiguous axis metadata: multiscales[0].axes[{index}] missing name"
            ))
        })?;

        let unit = axis
            .get("unit")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        parsed.push(AxisMetadata {
            label: canonical_label(name)?,
            unit,
        });
    }

    let mut seen = BTreeSet::new();
    for axis in &parsed {
        if !seen.insert(axis.label.clone()) {
            return Err(StorageError::UnsupportedLayout(format!(
                "ambiguous axis metadata: duplicate axis label {}",
                axis.label
            )));
        }
    }

    Ok(Some(parsed))
}

fn parse_scale_values(
    dataset_entry: Option<&Value>,
    rank: usize,
) -> Result<Option<Vec<f64>>, StorageError> {
    let Some(dataset_entry) = dataset_entry else {
        return Ok(None);
    };

    let Some(transformations) = dataset_entry.get("coordinateTransformations") else {
        return Ok(None);
    };
    let transformations = transformations.as_array().ok_or_else(|| {
        StorageError::UnsupportedLayout("coordinateTransformations must be an array".to_string())
    })?;

    for transformation in transformations {
        if transformation.get("type").and_then(Value::as_str) != Some("scale") {
            continue;
        }

        let scale = transformation
            .get("scale")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                StorageError::UnsupportedLayout(
                    "coordinateTransformations scale entry is missing scale array".to_string(),
                )
            })?;

        if scale.len() != rank {
            return Err(StorageError::UnsupportedLayout(format!(
                "coordinateTransformations scale rank {} does not match array rank {rank}",
                scale.len()
            )));
        }

        let mut parsed = Vec::with_capacity(scale.len());
        for (index, value) in scale.iter().enumerate() {
            let Some(scale_value) = value.as_f64() else {
                return Err(StorageError::UnsupportedLayout(format!(
                    "coordinateTransformations scale value at index {index} is not a number"
                )));
            };
            if !scale_value.is_finite() || scale_value <= 0.0 {
                return Err(StorageError::UnsupportedLayout(format!(
                    "coordinateTransformations scale value at index {index} must be finite and positive"
                )));
            }
            parsed.push(scale_value);
        }
        return Ok(Some(parsed));
    }

    Ok(None)
}

fn default_dimensions(rank: usize) -> Result<Vec<String>, StorageError> {
    let canonical = ["t", "c", "z", "y", "x"];
    if rank > canonical.len() {
        return Err(StorageError::UnsupportedLayout(format!(
            "ambiguous axis metadata: fallback canonical dimensions only support rank <= {}",
            canonical.len()
        )));
    }
    Ok(canonical
        .iter()
        .take(rank)
        .map(|label| (*label).to_string())
        .collect())
}

fn canonical_label(label: &str) -> Result<String, StorageError> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err(StorageError::UnsupportedLayout(
            "axis label cannot be empty".to_string(),
        ));
    }

    let lower = trimmed.to_ascii_lowercase();
    if is_builtin_axis(&lower) {
        return Ok(lower);
    }

    Ok(trimmed.to_string())
}

fn is_builtin_axis(label: &str) -> bool {
    matches!(label, "t" | "c" | "z" | "y" | "x")
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
    fn opens_ome_zarr_v05_fixture_and_enriches_layout() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let attrs_path = temp_dir.path().join(".zattrs");
        fs::write(
            &attrs_path,
            r#"{"multiscales":[{"version":"0.5","datasets":[{"path":"0"}],"axes":[{"name":"t"},{"name":"c"},{"name":"z","unit":"um"},{"name":"y","unit":"um"},{"name":"x","unit":"um"}]}]}"#,
        )
        .expect("write attrs");

        fs::create_dir_all(temp_dir.path().join("0")).expect("create array dir");
        fs::write(
            temp_dir.path().join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [1,1,4,8,8],
                "chunks": [1,1,1,8,8],
                "dtype": "<u2",
                "compressor": null,
                "dimension_separator": "/"
            }"#,
        )
        .expect("write zarray");

        let result = open_dataset(
            temp_dir.path().to_str().expect("path as str"),
            &OpenDatasetOptions::default(),
        )
        .expect("open dataset");

        assert_eq!(result.handle.ome_version.as_deref(), Some("0.5"));
        assert!(result.compatibility_mode.is_none());
        assert_eq!(
            result.handle.multiscale_metadata["layout_version"],
            json!(LAYOUT_VERSION)
        );
        assert_eq!(
            result.handle.multiscale_metadata["spatial_scale_zyx"],
            json!([1.0, 1.0, 1.0])
        );
    }

    #[test]
    fn opens_ome_zarr_v04_in_best_effort_mode() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let attrs_path = temp_dir.path().join(".zattrs");
        fs::write(
            &attrs_path,
            r#"{"multiscales":[{"version":"0.4","datasets":[{"path":"0"}],"axes":["z","y","x"]}]}"#,
        )
        .expect("write attrs");

        fs::create_dir_all(temp_dir.path().join("0")).expect("create array dir");
        fs::write(
            temp_dir.path().join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [4,8,8],
                "chunks": [1,8,8],
                "dtype": "<u2",
                "compressor": null,
                "dimension_separator": "/"
            }"#,
        )
        .expect("write zarray");

        let result = open_dataset(
            temp_dir.path().to_str().expect("path as str"),
            &OpenDatasetOptions::default(),
        )
        .expect("open dataset");

        assert_eq!(result.handle.ome_version.as_deref(), Some("0.4"));
        assert_eq!(
            result.compatibility_mode.as_deref(),
            Some("best_effort_0_4")
        );
        assert_eq!(
            result.handle.multiscale_metadata["implicit_singleton_axes"],
            json!(["t", "c"])
        );
    }

    #[test]
    fn rejects_ambiguous_ome_zarr_v04_without_axis_metadata() {
        let temp_dir = TempDir::new().expect("create temp dir");
        fs::write(
            temp_dir.path().join(".zattrs"),
            r#"{"multiscales":[{"version":"0.4","datasets":[{"path":"0"}]}]}"#,
        )
        .expect("write attrs");
        fs::create_dir_all(temp_dir.path().join("0")).expect("create array dir");
        fs::write(
            temp_dir.path().join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [4,8,8],
                "chunks": [1,8,8],
                "dtype": "<u2",
                "compressor": null,
                "dimension_separator": "/"
            }"#,
        )
        .expect("write zarray");

        let err = open_dataset(
            temp_dir.path().to_str().expect("path as str"),
            &OpenDatasetOptions::default(),
        )
        .expect_err("open should fail");

        assert!(
            matches!(err, StorageError::UnsupportedLayout(message) if message.contains("ambiguous axis metadata"))
        );
    }

    #[test]
    fn axis_remap_rejects_duplicate_canonical_labels() {
        let temp_dir = TempDir::new().expect("create temp dir");
        fs::write(
            temp_dir.path().join(".zattrs"),
            r#"{"multiscales":[{"version":"0.5","datasets":[{"path":"0"}],"axes":["t","c","z","y","x"]}]}"#,
        )
        .expect("write attrs");
        fs::create_dir_all(temp_dir.path().join("0")).expect("create array dir");
        fs::write(
            temp_dir.path().join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [1,1,4,8,8],
                "chunks": [1,1,1,8,8],
                "dtype": "<u2",
                "compressor": null,
                "dimension_separator": "/"
            }"#,
        )
        .expect("write zarray");

        let options = OpenDatasetOptions {
            axis_map: BTreeMap::from([
                ("y".to_string(), "x".to_string()),
                ("x".to_string(), "x".to_string()),
            ]),
            read_only: true,
        };

        let err = open_dataset(temp_dir.path().to_str().expect("path as str"), &options)
            .expect_err("duplicate remap should fail");

        assert!(
            matches!(err, StorageError::InvalidAxisRemap(message) if message.contains("duplicate canonical axis label"))
        );
    }

    #[test]
    fn reads_u16_plane_with_axis_remap_and_implicit_singletons() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let dataset = temp_dir.path();
        fs::create_dir_all(dataset.join("0/1/0/0")).expect("create chunk parent");

        fs::write(
            dataset.join(".zattrs"),
            r#"{"multiscales":[{"version":"0.5","datasets":[{"path":"0"}],"axes":["z","y","x","channel"]}]}"#,
        )
        .expect("write root attrs");
        fs::write(
            dataset.join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [4,8,8,1],
                "chunks": [1,8,8,1],
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
            r#"{"_ARRAY_DIMENSIONS":["z","y","x","channel"]}"#,
        )
        .expect("write array attrs");

        let mut bytes = Vec::with_capacity(8 * 8 * 2);
        for idx in 0..64u16 {
            let value = 3000u16 + idx;
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        fs::write(dataset.join("0/1/0/0/0"), bytes).expect("write chunk");

        let axis_remap = BTreeMap::from([("channel".to_string(), "c".to_string())]);
        let mut axis = BTreeMap::new();
        axis.insert("z".to_string(), 1);
        axis.insert("c".to_string(), 0);

        let plane = read_u16_plane(dataset.to_str().expect("path str"), &axis, &axis_remap)
            .expect("read plane should succeed");
        assert_eq!(plane.width, 8);
        assert_eq!(plane.height, 8);

        let first = u16::from_le_bytes([plane.bytes[0], plane.bytes[1]]);
        let last = u16::from_le_bytes([plane.bytes[126], plane.bytes[127]]);
        assert_eq!(first, 3000);
        assert_eq!(last, 3063);

        let mut bad_axis = axis;
        bad_axis.insert("t".to_string(), 1);
        let err = read_u16_plane(dataset.to_str().expect("path str"), &bad_axis, &axis_remap)
            .expect_err("implicit singleton t should reject index 1");
        assert!(
            matches!(err, StorageError::UnsupportedLayout(message) if message.contains("axis index out of bounds"))
        );
    }

    #[test]
    fn reads_u16_plane_from_tiled_zyx_chunks() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let dataset = temp_dir.path();
        fs::write(
            dataset.join(".zattrs"),
            r#"{"multiscales":[{"version":"0.5","datasets":[{"path":"0"}],"axes":["t","c","z","y","x"]}]}"#,
        )
        .expect("write root attrs");
        fs::create_dir_all(dataset.join("0")).expect("create array dir");
        fs::write(
            dataset.join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [1,1,4,8,8],
                "chunks": [1,1,2,4,4],
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

        for z_chunk in 0..2usize {
            for y_chunk in 0..2usize {
                for x_chunk in 0..2usize {
                    let mut bytes = Vec::with_capacity(2 * 4 * 4 * 2);
                    for local_z in 0..2usize {
                        for local_y in 0..4usize {
                            for local_x in 0..4usize {
                                let global_z = z_chunk * 2 + local_z;
                                let global_y = y_chunk * 4 + local_y;
                                let global_x = x_chunk * 4 + local_x;
                                let value = (global_z * 1000 + global_y * 100 + global_x) as u16;
                                bytes.extend_from_slice(&value.to_le_bytes());
                            }
                        }
                    }
                    let chunk_path = dataset
                        .join("0")
                        .join("0")
                        .join("0")
                        .join(z_chunk.to_string())
                        .join(y_chunk.to_string())
                        .join(x_chunk.to_string());
                    fs::create_dir_all(chunk_path.parent().expect("chunk parent")).expect("mkdir");
                    fs::write(chunk_path, bytes).expect("write chunk");
                }
            }
        }

        let axis = BTreeMap::from([
            ("t".to_string(), 0usize),
            ("c".to_string(), 0usize),
            ("z".to_string(), 3usize),
        ]);
        let plane = read_u16_plane(dataset.to_str().expect("path str"), &axis, &BTreeMap::new())
            .expect("read tiled plane");
        assert_eq!(plane.width, 8);
        assert_eq!(plane.height, 8);
        let first = u16::from_le_bytes([plane.bytes[0], plane.bytes[1]]);
        let center = u16::from_le_bytes([
            plane.bytes[(4 * 8 + 4) * 2],
            plane.bytes[(4 * 8 + 4) * 2 + 1],
        ]);
        let last = u16::from_le_bytes([plane.bytes[126], plane.bytes[127]]);
        assert_eq!(first, 3000);
        assert_eq!(center, 3404);
        assert_eq!(last, 3707);
    }

    #[test]
    fn rejects_unsupported_dtype() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let dataset = temp_dir.path();
        fs::create_dir_all(dataset.join("0")).expect("create array dir");
        fs::write(
            dataset.join(".zattrs"),
            r#"{"multiscales":[{"version":"0.5","datasets":[{"path":"0"}],"axes":["t","c","z","y","x"]}]}"#,
        )
        .expect("write root attrs");
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

        let err = read_u16_plane(
            dataset.to_str().expect("path str"),
            &BTreeMap::new(),
            &BTreeMap::new(),
        )
        .expect_err("dtype should fail");
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
            dataset.join(".zattrs"),
            r#"{"multiscales":[{"version":"0.5","axes":[{"name":"t"},{"name":"c"},{"name":"z"},{"name":"y"},{"name":"x"}],"datasets":[{"path":"0","coordinateTransformations":[{"type":"scale","scale":[1.0,1.0,2.5,1.0,0.5]}]}]}]}"#,
        )
        .expect("write root attrs");
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

        let volume = read_u16_volume(dataset.to_str().expect("path str"), &axis, &BTreeMap::new())
            .expect("read volume should succeed");
        assert_eq!(volume.width, 8);
        assert_eq!(volume.height, 8);
        assert_eq!(volume.depth, 4);
        assert_eq!(volume.voxels.len(), 4 * 8 * 8);
        assert_eq!(volume.voxels[0], 2000);
        assert_eq!(volume.voxels[64], 2100);
        assert_eq!(volume.voxels[128], 2200);
        assert_eq!(volume.voxels[192], 2300);

        let opened = open_dataset(
            dataset.to_str().expect("path str"),
            &OpenDatasetOptions::default(),
        )
        .expect("open dataset");
        assert_eq!(
            opened.handle.multiscale_metadata["spatial_scale_zyx"],
            json!([2.5, 1.0, 0.5])
        );
    }

    #[test]
    fn reads_u16_volume_from_tiled_zyx_chunks() {
        let temp_dir = TempDir::new().expect("create temp dir");
        let dataset = temp_dir.path();
        fs::write(
            dataset.join(".zattrs"),
            r#"{"multiscales":[{"version":"0.5","datasets":[{"path":"0"}],"axes":["t","c","z","y","x"]}]}"#,
        )
        .expect("write root attrs");
        fs::create_dir_all(dataset.join("0")).expect("create array dir");
        fs::write(
            dataset.join("0/.zarray"),
            r#"{
                "zarr_format": 2,
                "shape": [1,1,4,8,8],
                "chunks": [1,1,2,4,4],
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

        for z_chunk in 0..2usize {
            for y_chunk in 0..2usize {
                for x_chunk in 0..2usize {
                    let mut bytes = Vec::with_capacity(2 * 4 * 4 * 2);
                    for local_z in 0..2usize {
                        for local_y in 0..4usize {
                            for local_x in 0..4usize {
                                let global_z = z_chunk * 2 + local_z;
                                let global_y = y_chunk * 4 + local_y;
                                let global_x = x_chunk * 4 + local_x;
                                let value =
                                    (5000 + global_z * 1000 + global_y * 100 + global_x) as u16;
                                bytes.extend_from_slice(&value.to_le_bytes());
                            }
                        }
                    }
                    let chunk_path = dataset
                        .join("0")
                        .join("0")
                        .join("0")
                        .join(z_chunk.to_string())
                        .join(y_chunk.to_string())
                        .join(x_chunk.to_string());
                    fs::create_dir_all(chunk_path.parent().expect("chunk parent")).expect("mkdir");
                    fs::write(chunk_path, bytes).expect("write chunk");
                }
            }
        }

        let axis = BTreeMap::from([("t".to_string(), 0usize), ("c".to_string(), 0usize)]);
        let volume = read_u16_volume(dataset.to_str().expect("path str"), &axis, &BTreeMap::new())
            .expect("read tiled volume");
        assert_eq!(volume.width, 8);
        assert_eq!(volume.height, 8);
        assert_eq!(volume.depth, 4);
        assert_eq!(volume.voxels.len(), 4 * 8 * 8);
        assert_eq!(volume.voxels[0], 5000);
        assert_eq!(volume.voxels[8 * 8], 6000);
        assert_eq!(volume.voxels[2 * 8 * 8], 7000);
        assert_eq!(volume.voxels[3 * 8 * 8 + 7 * 8 + 7], 8707);
    }
}
