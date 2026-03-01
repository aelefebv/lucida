use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::model::{AxisName, SourceKind, SourceMetadata};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalCacheBuildRequest {
    pub source_id: String,
    pub generation_id: String,
    pub generation_seq: u64,
    pub source_uri: String,
    pub source_kind: SourceKind,
    pub source_metadata: SourceMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalCacheBuildResult {
    pub canonical_root: PathBuf,
    pub multiscale_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalCacheError {
    InvalidSourceUri { uri: String, message: String },
    IoError { path: String, message: String },
    SerializationError { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalCacheBuilder {
    cache_root: PathBuf,
}

impl CanonicalCacheBuilder {
    #[must_use]
    pub fn new(cache_root: impl Into<PathBuf>) -> Self {
        Self {
            cache_root: cache_root.into(),
        }
    }

    pub fn build(
        &self,
        request: &CanonicalCacheBuildRequest,
    ) -> Result<CanonicalCacheBuildResult, CanonicalCacheError> {
        let canonical_root = self
            .cache_root
            .join(&request.source_id)
            .join(format!("gen_{:08}", request.generation_seq))
            .join("canonical.ome.zarr");
        fs::create_dir_all(&canonical_root).map_err(|error| CanonicalCacheError::IoError {
            path: canonical_root.display().to_string(),
            message: error.to_string(),
        })?;

        if matches!(request.source_kind, SourceKind::OmeZarr) {
            let source_path = source_path_from_uri(&request.source_uri)?;
            if source_path.is_dir() {
                copy_directory_contents(&source_path, &canonical_root)?;
            }
        }

        let level_zero_path = canonical_root.join("0");
        fs::create_dir_all(&level_zero_path).map_err(|error| CanonicalCacheError::IoError {
            path: level_zero_path.display().to_string(),
            message: error.to_string(),
        })?;
        write_zattrs(&canonical_root, request)?;
        write_zarray(&level_zero_path, &request.source_metadata)?;

        Ok(CanonicalCacheBuildResult {
            canonical_root,
            multiscale_paths: vec!["0".to_owned()],
        })
    }
}

fn source_path_from_uri(uri: &str) -> Result<PathBuf, CanonicalCacheError> {
    if let Some(raw_path) = uri.strip_prefix("file://") {
        if raw_path.is_empty() {
            return Err(CanonicalCacheError::InvalidSourceUri {
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
        Err(CanonicalCacheError::InvalidSourceUri {
            uri: uri.to_owned(),
            message: "source URI must not be empty".to_owned(),
        })
    } else {
        Ok(PathBuf::from(uri))
    }
}

fn copy_directory_contents(source_dir: &Path, dest_dir: &Path) -> Result<(), CanonicalCacheError> {
    let entries = fs::read_dir(source_dir).map_err(|error| CanonicalCacheError::IoError {
        path: source_dir.display().to_string(),
        message: error.to_string(),
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| CanonicalCacheError::IoError {
            path: source_dir.display().to_string(),
            message: error.to_string(),
        })?;
        let source_path = entry.path();
        let dest_path = dest_dir.join(entry.file_name());
        let metadata = entry
            .metadata()
            .map_err(|error| CanonicalCacheError::IoError {
                path: source_path.display().to_string(),
                message: error.to_string(),
            })?;

        if metadata.is_dir() {
            fs::create_dir_all(&dest_path).map_err(|error| CanonicalCacheError::IoError {
                path: dest_path.display().to_string(),
                message: error.to_string(),
            })?;
            copy_directory_contents(&source_path, &dest_path)?;
            continue;
        }

        fs::copy(&source_path, &dest_path).map_err(|error| CanonicalCacheError::IoError {
            path: source_path.display().to_string(),
            message: error.to_string(),
        })?;
    }

    Ok(())
}

fn write_zattrs(
    canonical_root: &Path,
    request: &CanonicalCacheBuildRequest,
) -> Result<(), CanonicalCacheError> {
    let axis_names = canonical_axes_with_extra(&request.source_metadata)
        .into_iter()
        .map(|axis| json!({ "name": axis }))
        .collect::<Vec<_>>();
    let zattrs = json!({
        "multiscales": [
            {
                "version": "0.4",
                "name": format!("{}-gen-{}", request.source_id, request.generation_seq),
                "axes": axis_names,
                "datasets": [{ "path": "0" }]
            }
        ],
        "lucida": {
            "source_id": request.source_id,
            "generation_id": request.generation_id,
            "generation_seq": request.generation_seq
        }
    });
    let zattrs_bytes = serde_json::to_vec_pretty(&zattrs).map_err(|error| {
        CanonicalCacheError::SerializationError {
            message: error.to_string(),
        }
    })?;
    let zattrs_path = canonical_root.join(".zattrs");
    fs::write(&zattrs_path, zattrs_bytes).map_err(|error| CanonicalCacheError::IoError {
        path: zattrs_path.display().to_string(),
        message: error.to_string(),
    })?;
    Ok(())
}

fn write_zarray(
    level_zero_path: &Path,
    source_metadata: &SourceMetadata,
) -> Result<(), CanonicalCacheError> {
    let shape = canonical_shape_with_extra(source_metadata);
    let chunks = canonical_chunk_shape(&shape);
    let zarray = json!({
        "zarr_format": 2,
        "shape": shape,
        "chunks": chunks,
        "dtype": source_metadata.dtype,
        "compressor": null,
        "fill_value": 0,
        "order": "C",
        "filters": null
    });
    let zarray_bytes = serde_json::to_vec_pretty(&zarray).map_err(|error| {
        CanonicalCacheError::SerializationError {
            message: error.to_string(),
        }
    })?;
    let zarray_path = level_zero_path.join(".zarray");
    fs::write(&zarray_path, zarray_bytes).map_err(|error| CanonicalCacheError::IoError {
        path: zarray_path.display().to_string(),
        message: error.to_string(),
    })?;
    Ok(())
}

fn canonical_axes_with_extra(source_metadata: &SourceMetadata) -> Vec<String> {
    let mut extra_axes = source_metadata
        .shape
        .extra_axes
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    extra_axes.sort();
    let mut result = extra_axes;
    result.extend(
        source_metadata
            .canonical_axis_order
            .iter()
            .map(axis_name)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
    );
    result
}

fn canonical_shape_with_extra(source_metadata: &SourceMetadata) -> Vec<u64> {
    let mut extra = source_metadata
        .shape
        .extra_axes
        .iter()
        .map(|(name, value)| (name.clone(), *value))
        .collect::<Vec<_>>();
    extra.sort_by(|left, right| left.0.cmp(&right.0));
    let mut shape = extra
        .into_iter()
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    shape.push(source_metadata.shape.t);
    shape.push(source_metadata.shape.c);
    shape.push(source_metadata.shape.z);
    shape.push(source_metadata.shape.y);
    shape.push(source_metadata.shape.x);
    shape
}

fn canonical_chunk_shape(shape: &[u64]) -> Vec<u64> {
    if shape.is_empty() {
        return vec![];
    }

    let mut chunks = vec![1; shape.len()];
    if let Some(last) = shape.last().copied() {
        let x_index = shape.len().saturating_sub(1);
        chunks[x_index] = last.clamp(1, 256);
    }
    if shape.len() >= 2 {
        let y_index = shape.len() - 2;
        chunks[y_index] = shape[y_index].clamp(1, 256);
    }
    chunks
}

fn axis_name(axis: &AxisName) -> &str {
    match axis {
        AxisName::T => "t",
        AxisName::C => "c",
        AxisName::Z => "z",
        AxisName::Y => "y",
        AxisName::X => "x",
        AxisName::Extra(name) => name.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::model::{
        AxisName, AxisShape, AxisSpacing, CalibrationMetadata, CalibrationStatus, ChannelTable,
        SourceMetadata,
    };

    use super::{CanonicalCacheBuildRequest, CanonicalCacheBuilder};

    fn unique_path(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida_luc203_{prefix}_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    fn metadata() -> SourceMetadata {
        SourceMetadata {
            original_axis_order: vec![AxisName::C, AxisName::Y, AxisName::X],
            canonical_axis_order: vec![
                AxisName::T,
                AxisName::C,
                AxisName::Z,
                AxisName::Y,
                AxisName::X,
            ],
            shape: AxisShape {
                t: 1,
                c: 3,
                z: 1,
                y: 16,
                x: 32,
                extra_axes: BTreeMap::new(),
            },
            dtype: "uint16".to_owned(),
            calibration: CalibrationMetadata {
                status: CalibrationStatus::Uncalibrated,
                spacing: AxisSpacing {
                    x: None,
                    y: None,
                    z: None,
                },
                units: None,
            },
            channel_table: ChannelTable {
                channel_count: 3,
                channels: vec![],
            },
        }
    }

    #[test]
    fn builds_canonical_ome_zarr_layout_for_non_ome_source() {
        let cache_root = unique_path("cache");
        std::fs::create_dir_all(&cache_root).expect("cache root creation should succeed");
        let builder = CanonicalCacheBuilder::new(&cache_root);
        let request = CanonicalCacheBuildRequest {
            source_id: "src_00000001".to_owned(),
            generation_id: "gen_00000001".to_owned(),
            generation_seq: 1,
            source_uri: "/tmp/non-ome-source.tiff".to_owned(),
            source_kind: crate::model::SourceKind::Tiff,
            source_metadata: metadata(),
        };

        let result = builder
            .build(&request)
            .expect("canonical build should succeed");
        assert!(result.canonical_root.join(".zattrs").exists());
        assert!(result.canonical_root.join("0").join(".zarray").exists());
        let zattrs = std::fs::read_to_string(result.canonical_root.join(".zattrs"))
            .expect(".zattrs read should succeed");
        assert!(zattrs.contains("\"multiscales\""));
        assert!(zattrs.contains("\"generation_seq\": 1"));

        std::fs::remove_dir_all(cache_root).expect("fixture cleanup should succeed");
    }

    #[test]
    fn preserves_existing_ome_zarr_contents_when_source_is_ome_zarr() {
        let source_root = unique_path("source").with_extension("ome.zarr");
        std::fs::create_dir_all(source_root.join("0")).expect("source level creation should work");
        std::fs::write(
            source_root.join(".zattrs"),
            r#"{"multiscales":[{"version":"0.4","datasets":[{"path":"0"}]}]}"#,
        )
        .expect(".zattrs write should succeed");
        std::fs::write(
            source_root.join("0").join(".zarray"),
            r#"{"shape":[1,1,1,16,32]}"#,
        )
        .expect(".zarray write should succeed");
        std::fs::write(source_root.join("0").join("marker.bin"), b"abc")
            .expect("marker write should succeed");

        let cache_root = unique_path("cache");
        std::fs::create_dir_all(&cache_root).expect("cache root creation should succeed");
        let builder = CanonicalCacheBuilder::new(&cache_root);
        let request = CanonicalCacheBuildRequest {
            source_id: "src_00000001".to_owned(),
            generation_id: "gen_00000002".to_owned(),
            generation_seq: 2,
            source_uri: source_root.display().to_string(),
            source_kind: crate::model::SourceKind::OmeZarr,
            source_metadata: metadata(),
        };

        let result = builder
            .build(&request)
            .expect("canonical build should succeed");
        assert!(result.canonical_root.join("0").join("marker.bin").exists());
        assert!(result.canonical_root.join("0").join(".zarray").exists());
        assert!(result.canonical_root.join(".zattrs").exists());

        std::fs::remove_dir_all(source_root).expect("source cleanup should succeed");
        std::fs::remove_dir_all(cache_root).expect("cache cleanup should succeed");
    }
}
