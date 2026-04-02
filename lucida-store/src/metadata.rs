//! Zarr v0.5 (OME-Zarr) metadata parsing.
//!
//! Reads Root Metadata and Array Metadata from a StorageBackend and constructs
//! lucida-core types (Dataset, Layer, LevelInfo, VolumeTransform).

use std::sync::Arc;

use object_store::ObjectStore;
use object_store::path::Path;
use serde::Deserialize;

use lucida_core::plate;
use lucida_core::scene::{
    Dataset, DatasetKind, DatasetMember, Layer, LevelInfo, PlateFov, PlateWell, PositioningMode,
};
use lucida_core::transform;

use crate::backend::StoreError;

/// Parsed dataset metadata ready for constructing an AddDataset command.
pub struct DatasetMetadata {
    /// The lucida-core Dataset (without id — caller assigns it).
    pub dataset: Dataset,
    /// Per-level paths (e.g., ["0", "1", "2"]) for chunk key construction.
    pub level_paths: Vec<String>,
    /// The original axis names from the OME metadata (e.g., ["t","c","z","y","x"]
    /// or ["c","y","x"] for a 3D dataset).
    pub axes_names: Vec<String>,
}

/// Map an OME axis name to its canonical 5D position: T=0, C=1, Z=2, Y=3, X=4.
pub fn axis_index(name: &str) -> Option<usize> {
    match name {
        "t" => Some(0),
        "c" => Some(1),
        "z" => Some(2),
        "y" => Some(3),
        "x" => Some(4),
        _ => None,
    }
}

/// Pad an N-dimensional u64 array to 5D `[T, C, Z, Y, X]`, filling missing
/// axes with `fill`.
pub fn normalize_to_5d(values: &[u64], axes: &[String], fill: u64) -> [u64; 5] {
    let mut result = [fill; 5];
    for (i, axis_name) in axes.iter().enumerate() {
        if let Some(pos) = axis_index(axis_name) {
            if i < values.len() {
                result[pos] = values[i];
            }
        }
    }
    result
}

/// Pad an N-dimensional f64 array to 5D `[T, C, Z, Y, X]`, filling missing
/// axes with `fill`.
pub fn normalize_f64_to_5d(values: &[f64], axes: &[String], fill: f64) -> [f64; 5] {
    let mut result = [fill; 5];
    for (i, axis_name) in axes.iter().enumerate() {
        if let Some(pos) = axis_index(axis_name) {
            if i < values.len() {
                result[pos] = values[i];
            }
        }
    }
    result
}

/// Read OME-Zarr v0.5 metadata from a Store and construct a DatasetMetadata.
///
/// `store` is an opened ObjectStore pointing at the Store root.
/// `name` is the human-readable dataset name.
/// `id` is the dataset identifier (typically a UUID).
///
/// Detects whether the root zarr.json describes a plate (`ome.plate`) or a
/// single image (`ome.multiscales`). For plates, delegates to `read_plate_info`
/// and wraps the result in a `DatasetMetadata`.
pub async fn read_dataset_info(
    store: &Arc<dyn ObjectStore>,
    id: &str,
    name: &str,
) -> Result<DatasetMetadata, StoreError> {
    // Read root zarr.json
    let root_bytes = store
        .get(&Path::from("zarr.json"))
        .await?
        .bytes()
        .await?;
    let root_json: serde_json::Value =
        serde_json::from_slice(&root_bytes).map_err(|e| StoreError::Metadata(e.to_string()))?;

    // Detect plate: if root has ome.plate, delegate to plate reader.
    if root_json.pointer("/attributes/ome/plate").is_some() {
        let plate = read_plate_info_from_root(store, &root_json, name).await?;
        return Ok(plate.into_dataset_metadata(id));
    }

    // Parse OME multiscales
    let multiscales = root_json
        .pointer("/attributes/ome/multiscales")
        .and_then(|v| v.as_array())
        .ok_or_else(|| StoreError::Metadata("no ome.multiscales in root zarr.json".into()))?;

    let ms = multiscales
        .first()
        .ok_or_else(|| StoreError::Metadata("multiscales array is empty".into()))?;

    // Extract axis names from the OME metadata axes array.
    // Each axis is an object like {"name": "c", "type": "channel"}.
    let axes_json: Vec<serde_json::Value> = ms
        .get("axes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.clone())
        .unwrap_or_default();

    let axes_names: Vec<String> = axes_json
        .iter()
        .filter_map(|a| a.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .collect();

    let datasets_arr = ms
        .get("datasets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| StoreError::Metadata("no datasets in multiscales".into()))?;

    // Parse per-level scale factors from coordinateTransformations
    let mut level_entries: Vec<LevelEntry> = Vec::new();
    for ds in datasets_arr {
        let path = ds
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| StoreError::Metadata("dataset entry missing path".into()))?
            .to_string();

        let mut scale = [1.0_f64; 5]; // [T, C, Z, Y, X]
        if let Some(transforms) = ds.get("coordinateTransformations").and_then(|v| v.as_array()) {
            for ct in transforms {
                if ct.get("type").and_then(|v| v.as_str()) == Some("scale") {
                    if let Some(s) = ct.get("scale").and_then(|v| v.as_array()) {
                        let raw: Vec<f64> = s.iter().filter_map(|v| v.as_f64()).collect();
                        scale = normalize_f64_to_5d(&raw, &axes_names, 1.0);
                    }
                }
            }
        }

        level_entries.push(LevelEntry { path, scale });
    }

    if level_entries.is_empty() {
        return Err(StoreError::Metadata("no levels found".into()));
    }

    // Read each level's zarr.json in sequence (metadata files are small)
    let mut level_metas: Vec<ArrayMeta> = Vec::new();
    for entry in &level_entries {
        let level_path = Path::from(format!("{}/zarr.json", entry.path));
        let level_bytes = store.get(&level_path).await?.bytes().await?;
        let meta: ArrayMeta = serde_json::from_slice(&level_bytes)
            .map_err(|e| StoreError::Metadata(format!("{}: {e}", entry.path)))?;
        level_metas.push(meta);
    }

    // Construct lucida-core types from parsed metadata
    let full_res = &level_metas[0];
    let full_res_scale = &level_entries[0].scale;

    // Normalize shapes and chunk shapes to 5D [T, C, Z, Y, X]
    let full_shape_5d = normalize_to_5d(&full_res.shape, &axes_names, 1);
    let full_chunk_5d = normalize_to_5d(&full_res.chunk_grid.configuration.chunk_shape, &axes_names, 1);

    let shape_z = full_shape_5d[2] as u32;
    let shape_y = full_shape_5d[3] as u32;
    let shape_x = full_shape_5d[4] as u32;

    let chunk_z = full_chunk_5d[2] as u32;
    let chunk_y = full_chunk_5d[3] as u32;
    let chunk_x = full_chunk_5d[4] as u32;

    // Build LevelInfo for each level
    let level_info: Vec<LevelInfo> = level_metas
        .iter()
        .map(|lm| {
            let norm_shape = normalize_to_5d(&lm.shape, &axes_names, 1);
            let norm_chunk = normalize_to_5d(&lm.chunk_grid.configuration.chunk_shape, &axes_names, 1);
            let lz = norm_shape[2] as u32;
            let ly = norm_shape[3] as u32;
            let lx = norm_shape[4] as u32;
            let cz = norm_chunk[2] as u32;
            let cy = norm_chunk[3] as u32;
            let cx = norm_chunk[4] as u32;
            LevelInfo {
                shape: [lz, ly, lx],
                chunk_size: [cz, cy, cx],
            }
        })
        .collect();

    // Volume scale: [Z, Y, X] physical spacing from level 0 coordinateTransformations
    let volume_scale = [full_res_scale[2], full_res_scale[3], full_res_scale[4]];
    let volume_shape = [shape_z, shape_y, shape_x];

    let volume_transform = transform::compute_volume_transform(volume_shape, volume_scale);

    // Build client_metadata matching what lucida-web expects (DatasetInfo format)
    let levels_json: Vec<serde_json::Value> = level_entries
        .iter()
        .zip(level_metas.iter())
        .map(|(entry, meta)| {
            serde_json::json!({
                "path": entry.path,
                "shape": meta.shape,
                "chunkShape": meta.chunk_grid.configuration.chunk_shape,
                "dataType": meta.data_type,
                "scale": entry.scale,
                "codecs": meta.codecs,
            })
        })
        .collect();

    let client_metadata = serde_json::json!({
        "axes": axes_json,
        "axes_names": axes_names,
        "levels": levels_json,
    });

    let level_paths = level_entries.iter().map(|e| e.path.clone()).collect();

    let dataset = Dataset {
        id: id.to_string(),
        name: name.to_string(),
        kind: lucida_core::scene::DatasetKind::default(),
        layers: vec![Layer {
            name: "main".to_string(),
            visible: true,
            num_levels: level_metas.len() as u32,
            chunk_size: [chunk_z, chunk_y, chunk_x],
            data_shape: [shape_z, shape_y, shape_x],
            level_info,
        }],
        members: vec![DatasetMember {
            id: id.to_string(),
            position: [0.0, 0.0],
            store_prefix: None,
        }],
        volume_transform: Some(volume_transform),
        volume_shape: Some(volume_shape),
        client_metadata: Some(client_metadata),
    };

    Ok(DatasetMetadata {
        dataset,
        level_paths,
        axes_names,
    })
}

// --- Plate metadata reading ---

/// Parsed plate metadata, ready for conversion to a `DatasetMetadata`.
#[derive(Debug)]
pub struct PlateInfo {
    /// Human-readable plate name.
    pub name: String,
    /// Row labels (e.g. ["A", "B"]).
    pub rows: Vec<String>,
    /// Column labels (e.g. ["1", "2"]).
    pub columns: Vec<String>,
    /// Wells with populated FOV lists and positions.
    pub wells: Vec<PlateWell>,
    /// Number of multiscale levels (from representative FOV).
    pub num_levels: u32,
    /// Per-FOV voxel shape [Z, Y, X] (uniform across the plate).
    pub fov_shape: [u32; 3],
    /// Per-FOV chunk size [Z, Y, X] (from representative FOV, level 0).
    pub fov_chunk_size: [u32; 3],
    /// Per-level info from the representative FOV.
    pub level_info: Vec<LevelInfo>,
    /// Level paths (e.g. ["0", "1", "2"]) from the representative FOV.
    pub level_paths: Vec<String>,
    /// Original axis names from the representative FOV.
    pub axes_names: Vec<String>,
    /// Axes JSON from the representative FOV (for client_metadata).
    pub axes_json: Vec<serde_json::Value>,
    /// Per-level entries from the representative FOV (for client_metadata).
    pub level_entries: Vec<LevelEntry>,
    /// Per-level array metadata from the representative FOV (for client_metadata).
    pub level_metas: Vec<ArrayMeta>,
    /// Volume scale [Z, Y, X] from the representative FOV.
    pub volume_scale: [f64; 3],
    /// Whether any FOV has stage position translations.
    pub has_stage_positions: bool,
    /// Positioning mode used.
    pub positioning_mode: PositioningMode,
}

impl PlateInfo {
    /// Convert this PlateInfo into a DatasetMetadata for server integration.
    pub fn into_dataset_metadata(self, id: &str) -> DatasetMetadata {
        // Compute plate extent from positioned wells.
        let extent = plate::plate_extent(&self.wells, self.fov_shape);
        let plate_width = extent[0].ceil() as u32;
        let plate_height = extent[1].ceil() as u32;
        let plate_z = self.fov_shape[0];
        let volume_shape = [plate_z, plate_height, plate_width];

        let volume_transform =
            transform::compute_volume_transform(volume_shape, self.volume_scale);

        // Build DatasetMember entries from positioned FOVs.
        let mut members = Vec::new();
        for well in &self.wells {
            for fov in &well.fovs {
                members.push(DatasetMember {
                    id: fov.store_prefix.clone(),
                    position: fov.position,
                    store_prefix: Some(fov.store_prefix.clone()),
                });
            }
        }

        // Build client_metadata from representative FOV.
        let levels_json: Vec<serde_json::Value> = self
            .level_entries
            .iter()
            .zip(self.level_metas.iter())
            .map(|(entry, meta)| {
                serde_json::json!({
                    "path": entry.path,
                    "shape": meta.shape,
                    "chunkShape": meta.chunk_grid.configuration.chunk_shape,
                    "dataType": meta.data_type,
                    "scale": entry.scale,
                    "codecs": meta.codecs,
                })
            })
            .collect();

        let client_metadata = serde_json::json!({
            "axes": self.axes_json,
            "axes_names": self.axes_names,
            "levels": levels_json,
        });

        let kind = DatasetKind::Plate {
            rows: self.rows,
            columns: self.columns,
            wells: self.wells,
            positioning_mode: self.positioning_mode,
            has_stage_positions: self.has_stage_positions,
        };

        let dataset = Dataset {
            id: id.to_string(),
            name: self.name,
            kind,
            layers: vec![Layer {
                name: "main".to_string(),
                visible: true,
                num_levels: self.num_levels,
                chunk_size: self.fov_chunk_size,
                data_shape: self.fov_shape,
                level_info: self.level_info,
            }],
            members,
            volume_transform: Some(volume_transform),
            volume_shape: Some(volume_shape),
            client_metadata: Some(client_metadata),
        };

        DatasetMetadata {
            dataset,
            level_paths: self.level_paths,
            axes_names: self.axes_names,
        }
    }
}

/// Read plate metadata from a Store, returning a `PlateInfo`.
///
/// This is the public entry point for plate reading. It reads the root
/// zarr.json, verifies it is a plate, and delegates to the internal parser.
pub async fn read_plate_info(
    store: &Arc<dyn ObjectStore>,
    name: &str,
) -> Result<PlateInfo, StoreError> {
    let root_bytes = store
        .get(&Path::from("zarr.json"))
        .await?
        .bytes()
        .await?;
    let root_json: serde_json::Value =
        serde_json::from_slice(&root_bytes).map_err(|e| StoreError::Metadata(e.to_string()))?;

    if root_json.pointer("/attributes/ome/plate").is_none() {
        return Err(StoreError::Metadata("not a plate: no ome.plate in root zarr.json".into()));
    }

    read_plate_info_from_root(store, &root_json, name).await
}

/// Internal plate parser that works from an already-parsed root JSON.
async fn read_plate_info_from_root(
    store: &Arc<dyn ObjectStore>,
    root_json: &serde_json::Value,
    name: &str,
) -> Result<PlateInfo, StoreError> {
    let plate_json = root_json
        .pointer("/attributes/ome/plate")
        .ok_or_else(|| StoreError::Metadata("no ome.plate in root zarr.json".into()))?;

    // Parse plate name (fall back to caller-provided name).
    let plate_name = plate_json
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| name.to_string());

    // Parse rows: [{"name": "A"}, {"name": "B"}]
    let rows: Vec<String> = plate_json
        .get("rows")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| r.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Parse columns: [{"name": "1"}, {"name": "2"}]
    let columns: Vec<String> = plate_json
        .get("columns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Parse wells: [{"path": "A/1", "rowIndex": 0, "columnIndex": 0}, ...]
    let wells_json = plate_json
        .get("wells")
        .and_then(|v| v.as_array())
        .ok_or_else(|| StoreError::Metadata("plate has no wells array".into()))?;

    // Collect well paths and indices, then read each well's metadata.
    let mut plate_wells: Vec<PlateWell> = Vec::new();
    let mut representative_fov_path: Option<String> = None;
    let mut has_stage_positions = false;

    for well_entry in wells_json {
        let well_path = well_entry
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| StoreError::Metadata("well entry missing path".into()))?;
        let row_index = well_entry
            .get("rowIndex")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let column_index = well_entry
            .get("columnIndex")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        // Read well zarr.json to get FOV image list.
        let well_meta_path = Path::from(format!("{well_path}/zarr.json"));
        let well_bytes = store.get(&well_meta_path).await?.bytes().await?;
        let well_json: serde_json::Value = serde_json::from_slice(&well_bytes)
            .map_err(|e| StoreError::Metadata(format!("{well_path}: {e}")))?;

        let images = well_json
            .pointer("/attributes/ome/well/images")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                StoreError::Metadata(format!("{well_path}: no ome.well.images"))
            })?;

        let mut fovs: Vec<PlateFov> = Vec::new();
        for image_entry in images {
            let fov_path = image_entry
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .to_string();
            let store_prefix = format!("{well_path}/{fov_path}");

            // Optionally extract translation from coordinateTransformations.
            let translation = image_entry
                .get("coordinateTransformations")
                .and_then(|v| v.as_array())
                .and_then(|transforms| {
                    transforms.iter().find_map(|ct| {
                        if ct.get("type").and_then(|v| v.as_str()) == Some("translation") {
                            ct.get("translation")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect())
                        } else {
                            None
                        }
                    })
                });

            if translation.is_some() {
                has_stage_positions = true;
            }

            // Use the first FOV as the representative for reading multiscales.
            if representative_fov_path.is_none() {
                representative_fov_path = Some(store_prefix.clone());
            }

            fovs.push(PlateFov {
                path: fov_path,
                store_prefix,
                position: [0.0, 0.0], // Will be computed below.
                translation,
            });
        }

        plate_wells.push(PlateWell {
            path: well_path.to_string(),
            row_index,
            column_index,
            fovs,
        });
    }

    // Read representative FOV's multiscales metadata for shape, chunks, scale, codecs.
    let rep_path = representative_fov_path
        .ok_or_else(|| StoreError::Metadata("plate has no FOVs".into()))?;

    let rep_root_path = Path::from(format!("{rep_path}/zarr.json"));
    let rep_bytes = store.get(&rep_root_path).await?.bytes().await?;
    let rep_json: serde_json::Value = serde_json::from_slice(&rep_bytes)
        .map_err(|e| StoreError::Metadata(format!("{rep_path}: {e}")))?;

    let multiscales = rep_json
        .pointer("/attributes/ome/multiscales")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            StoreError::Metadata(format!("{rep_path}: no ome.multiscales"))
        })?;

    let ms = multiscales
        .first()
        .ok_or_else(|| StoreError::Metadata(format!("{rep_path}: multiscales empty")))?;

    let axes_json: Vec<serde_json::Value> = ms
        .get("axes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.clone())
        .unwrap_or_default();

    let axes_names: Vec<String> = axes_json
        .iter()
        .filter_map(|a| a.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .collect();

    let datasets_arr = ms
        .get("datasets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| StoreError::Metadata(format!("{rep_path}: no datasets")))?;

    // Parse level entries from the representative FOV.
    let mut level_entries: Vec<LevelEntry> = Vec::new();
    for ds in datasets_arr {
        let path = ds
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| StoreError::Metadata("FOV dataset entry missing path".into()))?
            .to_string();

        let mut scale = [1.0_f64; 5];
        if let Some(transforms) = ds.get("coordinateTransformations").and_then(|v| v.as_array()) {
            for ct in transforms {
                if ct.get("type").and_then(|v| v.as_str()) == Some("scale") {
                    if let Some(s) = ct.get("scale").and_then(|v| v.as_array()) {
                        let raw: Vec<f64> = s.iter().filter_map(|v| v.as_f64()).collect();
                        scale = normalize_f64_to_5d(&raw, &axes_names, 1.0);
                    }
                }
            }
        }

        level_entries.push(LevelEntry { path, scale });
    }

    if level_entries.is_empty() {
        return Err(StoreError::Metadata(format!("{rep_path}: no levels")));
    }

    // Read each level's array metadata from the representative FOV.
    let mut level_metas: Vec<ArrayMeta> = Vec::new();
    for entry in &level_entries {
        let level_path = Path::from(format!("{rep_path}/{}/zarr.json", entry.path));
        let level_bytes = store.get(&level_path).await?.bytes().await?;
        let meta: ArrayMeta = serde_json::from_slice(&level_bytes)
            .map_err(|e| StoreError::Metadata(format!("{rep_path}/{}: {e}", entry.path)))?;
        level_metas.push(meta);
    }

    // Compute FOV shape and chunk size from the representative FOV (level 0).
    let full_res = &level_metas[0];
    let full_shape_5d = normalize_to_5d(&full_res.shape, &axes_names, 1);
    let full_chunk_5d =
        normalize_to_5d(&full_res.chunk_grid.configuration.chunk_shape, &axes_names, 1);

    let fov_shape = [
        full_shape_5d[2] as u32,
        full_shape_5d[3] as u32,
        full_shape_5d[4] as u32,
    ];
    let fov_chunk_size = [
        full_chunk_5d[2] as u32,
        full_chunk_5d[3] as u32,
        full_chunk_5d[4] as u32,
    ];

    // Build per-level info.
    let level_info: Vec<LevelInfo> = level_metas
        .iter()
        .map(|lm| {
            let norm_shape = normalize_to_5d(&lm.shape, &axes_names, 1);
            let norm_chunk =
                normalize_to_5d(&lm.chunk_grid.configuration.chunk_shape, &axes_names, 1);
            LevelInfo {
                shape: [
                    norm_shape[2] as u32,
                    norm_shape[3] as u32,
                    norm_shape[4] as u32,
                ],
                chunk_size: [
                    norm_chunk[2] as u32,
                    norm_chunk[3] as u32,
                    norm_chunk[4] as u32,
                ],
            }
        })
        .collect();

    let full_res_scale = &level_entries[0].scale;
    let volume_scale = [full_res_scale[2], full_res_scale[3], full_res_scale[4]];

    let level_paths = level_entries.iter().map(|e| e.path.clone()).collect();

    // Determine positioning mode and compute FOV positions.
    let positioning_mode = if has_stage_positions {
        PositioningMode::Stage
    } else {
        PositioningMode::Grid
    };
    plate::compute_fov_positions(&mut plate_wells, fov_shape, positioning_mode);

    Ok(PlateInfo {
        name: plate_name,
        rows,
        columns,
        wells: plate_wells,
        num_levels: level_metas.len() as u32,
        fov_shape,
        fov_chunk_size,
        level_info,
        level_paths,
        axes_names,
        axes_json,
        level_entries,
        level_metas,
        volume_scale,
        has_stage_positions,
        positioning_mode,
    })
}

// --- Internal deserialization types for Zarr v3 Array Metadata ---

#[derive(Debug)]
pub struct LevelEntry {
    pub path: String,
    pub scale: [f64; 5], // [T, C, Z, Y, X]
}

#[derive(Debug, Deserialize)]
pub struct ArrayMeta {
    pub shape: Vec<u64>,       // N-dimensional (matches axes count)
    pub data_type: String,
    pub chunk_grid: ChunkGrid,
    #[serde(default)]
    pub codecs: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ChunkGrid {
    pub configuration: ChunkGridConfig,
}

#[derive(Debug, Deserialize)]
pub struct ChunkGridConfig {
    pub chunk_shape: Vec<u64>, // N-dimensional (matches axes count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("lucida_meta_test_{}", std::process::id()))
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// Create a minimal OME-Zarr v0.5 fixture with known dimensions.
    fn create_fixture(dir: &std::path::Path, levels: usize, shape: [u64; 5], chunk: [u64; 5]) {
        create_fixture_with_axes(
            dir,
            levels,
            &shape,
            &chunk,
            &["t", "c", "z", "y", "x"],
        );
    }

    /// Create a fixture with a custom set of axes.
    fn create_fixture_with_axes(
        dir: &std::path::Path,
        levels: usize,
        shape: &[u64],
        chunk: &[u64],
        axes: &[&str],
    ) {
        fs::create_dir_all(dir).unwrap();

        // Build axes JSON
        let axes_json: Vec<serde_json::Value> = axes
            .iter()
            .map(|name| {
                let atype = match *name {
                    "t" => "time",
                    "c" => "channel",
                    _ => "space",
                };
                serde_json::json!({"name": name, "type": atype})
            })
            .collect();

        // Build root zarr.json with multiscales
        let mut datasets = Vec::new();
        for i in 0..levels {
            let scale_factor = (1u64 << i) as f64;
            // Build per-axis scale: spatial axes get scale_factor, others get 1.0
            let scale_vals: Vec<f64> = axes
                .iter()
                .map(|name| match *name {
                    "z" | "y" | "x" => scale_factor,
                    _ => 1.0,
                })
                .collect();
            datasets.push(serde_json::json!({
                "path": i.to_string(),
                "coordinateTransformations": [{
                    "type": "scale",
                    "scale": scale_vals
                }]
            }));
        }

        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "multiscales": [{
                        "version": "0.5",
                        "name": "image",
                        "axes": axes_json,
                        "datasets": datasets
                    }]
                }
            }
        });
        fs::write(dir.join("zarr.json"), serde_json::to_string_pretty(&root).unwrap()).unwrap();

        // Write per-level zarr.json
        for i in 0..levels {
            let level_dir = dir.join(i.to_string());
            fs::create_dir_all(&level_dir).unwrap();
            let scale = 1u64 << i;
            let level_shape: Vec<u64> = axes
                .iter()
                .enumerate()
                .map(|(idx, name)| {
                    if matches!(*name, "z" | "y" | "x") {
                        (shape[idx] + scale - 1) / scale
                    } else {
                        shape[idx]
                    }
                })
                .collect();
            let arr = serde_json::json!({
                "zarr_format": 3,
                "node_type": "array",
                "shape": level_shape,
                "data_type": "uint16",
                "chunk_grid": {
                    "name": "regular",
                    "configuration": {
                        "chunk_shape": chunk
                    }
                },
                "codecs": [
                    {"name": "bytes", "configuration": {"endian": "little"}},
                    {"name": "numcodecs/lz4", "configuration": {"acceleration": 1}}
                ],
                "fill_value": 0
            });
            fs::write(level_dir.join("zarr.json"), serde_json::to_string_pretty(&arr).unwrap()).unwrap();
        }
    }

    #[tokio::test]
    async fn read_single_level_dataset() {
        let dir = temp_dir("single_level");
        create_fixture(&dir, 1, [1, 1, 20, 512, 512], [1, 1, 1, 128, 128]);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let meta = read_dataset_info(&store, "test-id", "test").await.unwrap();

        assert_eq!(meta.dataset.id, "test-id");
        assert_eq!(meta.dataset.name, "test");
        assert_eq!(meta.dataset.volume_shape, Some([20, 512, 512]));
        assert_eq!(meta.dataset.layers.len(), 1);

        let layer = &meta.dataset.layers[0];
        assert_eq!(layer.num_levels, 1);
        assert_eq!(layer.data_shape, [20, 512, 512]);
        assert_eq!(layer.chunk_size, [1, 128, 128]);
        assert_eq!(layer.level_info.len(), 1);
        assert_eq!(layer.level_info[0].shape, [20, 512, 512]);

        assert_eq!(meta.level_paths, vec!["0"]);
        assert!(meta.dataset.volume_transform.is_some());
        assert!(meta.dataset.client_metadata.is_some());
        assert_eq!(meta.axes_names, vec!["t", "c", "z", "y", "x"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_multi_level_dataset() {
        let dir = temp_dir("multi_level");
        create_fixture(&dir, 3, [1, 2, 100, 256, 256], [1, 1, 32, 64, 64]);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let meta = read_dataset_info(&store, "ds1", "multi").await.unwrap();

        let layer = &meta.dataset.layers[0];
        assert_eq!(layer.num_levels, 3);
        assert_eq!(layer.data_shape, [100, 256, 256]);
        assert_eq!(layer.chunk_size, [32, 64, 64]);
        assert_eq!(layer.level_info.len(), 3);

        // Level 0: full res
        assert_eq!(layer.level_info[0].shape, [100, 256, 256]);
        // Level 1: half
        assert_eq!(layer.level_info[1].shape, [50, 128, 128]);
        // Level 2: quarter
        assert_eq!(layer.level_info[2].shape, [25, 64, 64]);

        assert_eq!(meta.level_paths, vec!["0", "1", "2"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn client_metadata_matches_web_format() {
        let dir = temp_dir("client_meta");
        create_fixture(&dir, 2, [1, 1, 10, 64, 64], [1, 1, 10, 32, 32]);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let meta = read_dataset_info(&store, "ds1", "test").await.unwrap();

        let cm = meta.dataset.client_metadata.as_ref().unwrap();
        // Should have axes, axes_names, and levels arrays
        assert!(cm.get("axes").unwrap().is_array());
        assert!(cm.get("axes_names").unwrap().is_array());
        let levels = cm.get("levels").unwrap().as_array().unwrap();
        assert_eq!(levels.len(), 2);

        // Each level should have path, shape, chunkShape, dataType, scale, codecs
        let l0 = &levels[0];
        assert_eq!(l0["path"], "0");
        assert_eq!(l0["dataType"], "uint16");
        assert!(l0["shape"].is_array());
        assert!(l0["chunkShape"].is_array());
        assert!(l0["scale"].is_array());
        assert!(l0["codecs"].is_array());

        // axes_names should be a flat string list
        let axes_names = cm.get("axes_names").unwrap().as_array().unwrap();
        let names: Vec<&str> = axes_names.iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(names, vec!["t", "c", "z", "y", "x"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_zarr_json_returns_error() {
        let dir = temp_dir("missing_root");
        fs::create_dir_all(&dir).unwrap();

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = read_dataset_info(&store, "ds1", "test").await;
        assert!(result.is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn volume_transform_computed_correctly() {
        let dir = temp_dir("transform");
        // Anisotropic: Z spacing = 5.0, XY spacing = 1.0
        // shape = [1, 1, 20, 100, 200]
        {
            fs::create_dir_all(&dir).unwrap();
            let root = serde_json::json!({
                "zarr_format": 3, "node_type": "group",
                "attributes": { "ome": { "version": "0.5", "multiscales": [{
                    "version": "0.5", "name": "image",
                    "axes": [
                        {"name": "t", "type": "time"},
                        {"name": "c", "type": "channel"},
                        {"name": "z", "type": "space"},
                        {"name": "y", "type": "space"},
                        {"name": "x", "type": "space"}
                    ],
                    "datasets": [{"path": "0", "coordinateTransformations": [
                        {"type": "scale", "scale": [1.0, 1.0, 5.0, 1.0, 1.0]}
                    ]}]
                }]}}
            });
            fs::write(dir.join("zarr.json"), serde_json::to_string(&root).unwrap()).unwrap();
            let level_dir = dir.join("0");
            fs::create_dir_all(&level_dir).unwrap();
            let arr = serde_json::json!({
                "zarr_format": 3, "node_type": "array",
                "shape": [1, 1, 20, 100, 200],
                "data_type": "uint16",
                "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, 1, 1, 64, 64]}},
                "codecs": [], "fill_value": 0
            });
            fs::write(level_dir.join("zarr.json"), serde_json::to_string(&arr).unwrap()).unwrap();
        }

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let meta = read_dataset_info(&store, "ds1", "aniso").await.unwrap();

        // volume_scale = [5.0, 1.0, 1.0] (Z, Y, X)
        // volume_shape = [20, 100, 200]
        // Physical extents: Z=100, Y=100, X=200 → max=200
        let vt = meta.dataset.volume_transform.as_ref().unwrap();
        // X is longest: sx = 200/200 = 1.0
        assert!((vt.model[0] - 1.0).abs() < 1e-4);
        // Y: 100/200 = 0.5
        assert!((vt.model[5] - 0.5).abs() < 1e-4);
        // Z: 100/200 = 0.5
        assert!((vt.model[10] - 0.5).abs() < 1e-4);
        assert!((vt.max_physical_extent - 200.0).abs() < 1e-4);

        let _ = fs::remove_dir_all(&dir);
    }

    // --- Tests for normalization helpers ---

    #[test]
    fn normalize_to_5d_full_axes() {
        let axes: Vec<String> = vec!["t", "c", "z", "y", "x"]
            .into_iter()
            .map(String::from)
            .collect();
        let vals = &[1u64, 2, 30, 512, 512];
        let result = normalize_to_5d(vals, &axes, 1);
        assert_eq!(result, [1, 2, 30, 512, 512]);
    }

    #[test]
    fn normalize_to_5d_3d_axes() {
        let axes: Vec<String> = vec!["c", "y", "x"]
            .into_iter()
            .map(String::from)
            .collect();
        let vals = &[3u64, 256, 256];
        let result = normalize_to_5d(vals, &axes, 1);
        // T=1 (fill), C=3, Z=1 (fill), Y=256, X=256
        assert_eq!(result, [1, 3, 1, 256, 256]);
    }

    #[test]
    fn normalize_to_5d_zy_x_only() {
        let axes: Vec<String> = vec!["z", "y", "x"]
            .into_iter()
            .map(String::from)
            .collect();
        let vals = &[20u64, 100, 200];
        let result = normalize_to_5d(vals, &axes, 1);
        assert_eq!(result, [1, 1, 20, 100, 200]);
    }

    #[test]
    fn normalize_f64_to_5d_partial_axes() {
        let axes: Vec<String> = vec!["c", "y", "x"]
            .into_iter()
            .map(String::from)
            .collect();
        let vals = &[1.0_f64, 0.5, 0.5];
        let result = normalize_f64_to_5d(vals, &axes, 1.0);
        assert_eq!(result, [1.0, 1.0, 1.0, 0.5, 0.5]);
    }

    #[test]
    fn axis_index_known_names() {
        assert_eq!(axis_index("t"), Some(0));
        assert_eq!(axis_index("c"), Some(1));
        assert_eq!(axis_index("z"), Some(2));
        assert_eq!(axis_index("y"), Some(3));
        assert_eq!(axis_index("x"), Some(4));
        assert_eq!(axis_index("q"), None);
    }

    // --- Tests for 3D datasets (fewer than 5 axes) ---

    #[tokio::test]
    async fn read_3d_dataset_cyx() {
        let dir = temp_dir("3d_cyx");
        // 3D dataset with axes [c, y, x], shape [3, 256, 256], chunk [1, 64, 64]
        create_fixture_with_axes(
            &dir,
            1,
            &[3, 256, 256],
            &[1, 64, 64],
            &["c", "y", "x"],
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let meta = read_dataset_info(&store, "ds-3d", "3d-test").await.unwrap();

        assert_eq!(meta.axes_names, vec!["c", "y", "x"]);
        // After normalization: Z=1, Y=256, X=256
        assert_eq!(meta.dataset.volume_shape, Some([1, 256, 256]));

        let layer = &meta.dataset.layers[0];
        assert_eq!(layer.data_shape, [1, 256, 256]);
        assert_eq!(layer.chunk_size, [1, 64, 64]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_3d_dataset_zyx() {
        let dir = temp_dir("3d_zyx");
        create_fixture_with_axes(
            &dir,
            2,
            &[20, 100, 200],
            &[10, 64, 64],
            &["z", "y", "x"],
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let meta = read_dataset_info(&store, "ds-zyx", "zyx-test").await.unwrap();

        assert_eq!(meta.axes_names, vec!["z", "y", "x"]);
        assert_eq!(meta.dataset.volume_shape, Some([20, 100, 200]));

        let layer = &meta.dataset.layers[0];
        assert_eq!(layer.data_shape, [20, 100, 200]);
        assert_eq!(layer.chunk_size, [10, 64, 64]);
        assert_eq!(layer.level_info[0].shape, [20, 100, 200]);
        assert_eq!(layer.level_info[1].shape, [10, 50, 100]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_4d_dataset_czyx() {
        let dir = temp_dir("4d_czyx");
        create_fixture_with_axes(
            &dir,
            1,
            &[2, 30, 128, 128],
            &[1, 10, 64, 64],
            &["c", "z", "y", "x"],
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let meta = read_dataset_info(&store, "ds-czyx", "czyx-test").await.unwrap();

        assert_eq!(meta.axes_names, vec!["c", "z", "y", "x"]);
        assert_eq!(meta.dataset.volume_shape, Some([30, 128, 128]));

        let layer = &meta.dataset.layers[0];
        assert_eq!(layer.data_shape, [30, 128, 128]);
        assert_eq!(layer.chunk_size, [10, 64, 64]);

        let _ = fs::remove_dir_all(&dir);
    }

    // --- Tests for plate detection and reading ---

    /// Create a minimal OME-Zarr plate fixture with the given wells and FOV shapes.
    fn create_plate_fixture(
        dir: &std::path::Path,
        plate_name: &str,
        rows: &[&str],
        columns: &[&str],
        wells: &[(/*row*/&str, /*col*/&str, /*row_idx*/u32, /*col_idx*/u32, /*num_fovs*/u32)],
        fov_shape: [u64; 5],
        fov_chunk: [u64; 5],
    ) {
        fs::create_dir_all(dir).unwrap();

        // Build plate root zarr.json.
        let rows_json: Vec<serde_json::Value> = rows
            .iter()
            .map(|r| serde_json::json!({"name": r}))
            .collect();
        let cols_json: Vec<serde_json::Value> = columns
            .iter()
            .map(|c| serde_json::json!({"name": c}))
            .collect();
        let wells_json: Vec<serde_json::Value> = wells
            .iter()
            .map(|(row, col, ri, ci, _)| {
                serde_json::json!({
                    "path": format!("{row}/{col}"),
                    "rowIndex": ri,
                    "columnIndex": ci,
                })
            })
            .collect();

        let root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "ome": {
                    "version": "0.5",
                    "plate": {
                        "version": "0.5",
                        "name": plate_name,
                        "rows": rows_json,
                        "columns": cols_json,
                        "wells": wells_json,
                        "field_count": wells.iter().map(|w| w.4).max().unwrap_or(1),
                    }
                }
            }
        });
        fs::write(
            dir.join("zarr.json"),
            serde_json::to_string_pretty(&root).unwrap(),
        )
        .unwrap();

        // Write well and FOV metadata for each well.
        for (row, col, _ri, _ci, num_fovs) in wells {
            let well_dir = dir.join(row).join(col);
            fs::create_dir_all(&well_dir).unwrap();

            // Write row group zarr.json.
            let row_dir = dir.join(row);
            let row_meta = serde_json::json!({"zarr_format": 3, "node_type": "group"});
            fs::write(
                row_dir.join("zarr.json"),
                serde_json::to_string_pretty(&row_meta).unwrap(),
            )
            .unwrap();

            // Build well images list.
            let images: Vec<serde_json::Value> = (0..*num_fovs)
                .map(|i| serde_json::json!({"path": i.to_string()}))
                .collect();

            let well_meta = serde_json::json!({
                "zarr_format": 3,
                "node_type": "group",
                "attributes": {
                    "ome": {
                        "version": "0.5",
                        "well": {
                            "images": images,
                        }
                    }
                }
            });
            fs::write(
                well_dir.join("zarr.json"),
                serde_json::to_string_pretty(&well_meta).unwrap(),
            )
            .unwrap();

            // Write FOV metadata for each FOV.
            for i in 0..*num_fovs {
                let fov_dir = well_dir.join(i.to_string());
                fs::create_dir_all(&fov_dir).unwrap();

                // FOV root: multiscales with one level.
                let fov_root = serde_json::json!({
                    "zarr_format": 3,
                    "node_type": "group",
                    "attributes": {
                        "ome": {
                            "version": "0.5",
                            "multiscales": [{
                                "version": "0.5",
                                "name": "image",
                                "axes": [
                                    {"name": "t", "type": "time"},
                                    {"name": "c", "type": "channel"},
                                    {"name": "z", "type": "space"},
                                    {"name": "y", "type": "space"},
                                    {"name": "x", "type": "space"}
                                ],
                                "datasets": [{
                                    "path": "0",
                                    "coordinateTransformations": [{
                                        "type": "scale",
                                        "scale": [1.0, 1.0, 1.0, 1.0, 1.0]
                                    }]
                                }]
                            }]
                        }
                    }
                });
                fs::write(
                    fov_dir.join("zarr.json"),
                    serde_json::to_string_pretty(&fov_root).unwrap(),
                )
                .unwrap();

                // Level 0 array metadata.
                let level_dir = fov_dir.join("0");
                fs::create_dir_all(&level_dir).unwrap();
                let arr = serde_json::json!({
                    "zarr_format": 3,
                    "node_type": "array",
                    "shape": fov_shape,
                    "data_type": "uint16",
                    "chunk_grid": {
                        "name": "regular",
                        "configuration": {
                            "chunk_shape": fov_chunk
                        }
                    },
                    "codecs": [
                        {"name": "bytes", "configuration": {"endian": "little"}}
                    ],
                    "fill_value": 0
                });
                fs::write(
                    level_dir.join("zarr.json"),
                    serde_json::to_string_pretty(&arr).unwrap(),
                )
                .unwrap();
            }
        }
    }

    #[tokio::test]
    async fn read_dataset_info_detects_plate() {
        let dir = temp_dir("plate_detect");
        create_plate_fixture(
            &dir,
            "test_plate",
            &["A", "B"],
            &["1", "2"],
            &[("A", "1", 0, 0, 2), ("B", "2", 1, 1, 1)],
            [1, 1, 10, 256, 256],
            [1, 1, 1, 128, 128],
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let meta = read_dataset_info(&store, "plate-id", "test_plate").await.unwrap();

        // Should have detected a plate.
        match &meta.dataset.kind {
            DatasetKind::Plate {
                rows, columns, wells, positioning_mode, has_stage_positions,
            } => {
                assert_eq!(rows, &vec!["A", "B"]);
                assert_eq!(columns, &vec!["1", "2"]);
                assert_eq!(wells.len(), 2);
                assert_eq!(*positioning_mode, PositioningMode::Grid);
                assert!(!has_stage_positions);

                // Well A/1 has 2 FOVs.
                assert_eq!(wells[0].path, "A/1");
                assert_eq!(wells[0].fovs.len(), 2);
                assert_eq!(wells[0].fovs[0].store_prefix, "A/1/0");
                assert_eq!(wells[0].fovs[1].store_prefix, "A/1/1");

                // Well B/2 has 1 FOV.
                assert_eq!(wells[1].path, "B/2");
                assert_eq!(wells[1].fovs.len(), 1);
                assert_eq!(wells[1].fovs[0].store_prefix, "B/2/0");
            }
            DatasetKind::Single => panic!("expected Plate, got Single"),
        }

        // Members should be created for each FOV (3 total: 2 + 1).
        assert_eq!(meta.dataset.members.len(), 3);

        // Each member should have a store_prefix.
        for member in &meta.dataset.members {
            assert!(member.store_prefix.is_some());
        }

        // Layers should have FOV shape, not plate extent.
        let layer = &meta.dataset.layers[0];
        assert_eq!(layer.data_shape, [10, 256, 256]);
        assert_eq!(layer.chunk_size, [1, 128, 128]);
        assert_eq!(layer.num_levels, 1);

        // Volume shape should be the plate extent (larger than a single FOV).
        let shape = meta.dataset.volume_shape.unwrap();
        assert!(shape[1] >= 256, "plate height should be >= FOV height");
        assert!(shape[2] >= 256, "plate width should be >= FOV width");
        assert_eq!(shape[0], 10); // Z comes from FOV

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_plate_info_directly() {
        let dir = temp_dir("plate_direct");
        create_plate_fixture(
            &dir,
            "direct_plate",
            &["A"],
            &["1"],
            &[("A", "1", 0, 0, 4)],
            [1, 1, 1, 512, 512],
            [1, 1, 1, 128, 128],
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let plate = read_plate_info(&store, "direct_plate").await.unwrap();

        assert_eq!(plate.name, "direct_plate");
        assert_eq!(plate.rows, vec!["A"]);
        assert_eq!(plate.columns, vec!["1"]);
        assert_eq!(plate.wells.len(), 1);
        assert_eq!(plate.wells[0].fovs.len(), 4);
        assert_eq!(plate.fov_shape, [1, 512, 512]);
        assert_eq!(plate.fov_chunk_size, [1, 128, 128]);
        assert_eq!(plate.num_levels, 1);
        assert!(!plate.has_stage_positions);
        assert_eq!(plate.positioning_mode, PositioningMode::Grid);

        // FOV positions should have been computed (grid mode).
        // With 4 FOVs in a 2x2 grid, positions should not all be [0, 0].
        let positions: Vec<[f64; 2]> = plate.wells[0].fovs.iter().map(|f| f.position).collect();
        assert!(
            positions.iter().any(|p| p[0] != 0.0 || p[1] != 0.0),
            "not all FOV positions should be at origin",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_plate_info_not_a_plate_returns_error() {
        let dir = temp_dir("not_plate");
        create_fixture(&dir, 1, [1, 1, 10, 64, 64], [1, 1, 10, 32, 32]);

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let result = read_plate_info(&store, "test").await;
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("not a plate"),
            "error should mention 'not a plate': {err_msg}",
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn plate_into_dataset_metadata_populates_members() {
        let dir = temp_dir("plate_members");
        create_plate_fixture(
            &dir,
            "member_plate",
            &["A"],
            &["1", "2"],
            &[("A", "1", 0, 0, 2), ("A", "2", 0, 1, 3)],
            [1, 1, 1, 128, 128],
            [1, 1, 1, 64, 64],
        );

        let store = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let plate = read_plate_info(&store, "member_plate").await.unwrap();
        let meta = plate.into_dataset_metadata("ds-plate");

        // 5 total members: 2 from A/1 + 3 from A/2.
        assert_eq!(meta.dataset.members.len(), 5);

        // All members should have store prefixes.
        let prefixes: Vec<&str> = meta
            .dataset
            .members
            .iter()
            .map(|m| m.store_prefix.as_deref().unwrap())
            .collect();
        assert!(prefixes.contains(&"A/1/0"));
        assert!(prefixes.contains(&"A/1/1"));
        assert!(prefixes.contains(&"A/2/0"));
        assert!(prefixes.contains(&"A/2/1"));
        assert!(prefixes.contains(&"A/2/2"));

        // Volume transform and shape should be set.
        assert!(meta.dataset.volume_transform.is_some());
        assert!(meta.dataset.volume_shape.is_some());
        assert!(meta.dataset.client_metadata.is_some());

        let _ = fs::remove_dir_all(&dir);
    }
}
