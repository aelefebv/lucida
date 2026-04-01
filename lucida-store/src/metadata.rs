//! Zarr v0.5 (OME-Zarr) metadata parsing.
//!
//! Reads Root Metadata and Array Metadata from a StorageBackend and constructs
//! lucida-core types (Dataset, Layer, LevelInfo, VolumeTransform).

use std::sync::Arc;

use object_store::ObjectStore;
use object_store::path::Path;
use serde::Deserialize;

use lucida_core::scene::{Dataset, Layer, LevelInfo};
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
        layers: vec![Layer {
            name: "main".to_string(),
            visible: true,
            num_levels: level_metas.len() as u32,
            chunk_size: [chunk_z, chunk_y, chunk_x],
            data_shape: [shape_z, shape_y, shape_x],
            level_info,
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

// --- Internal deserialization types for Zarr v3 Array Metadata ---

struct LevelEntry {
    path: String,
    scale: [f64; 5], // [T, C, Z, Y, X]
}

#[derive(Deserialize)]
struct ArrayMeta {
    shape: Vec<u64>,       // N-dimensional (matches axes count)
    data_type: String,
    chunk_grid: ChunkGrid,
    #[serde(default)]
    codecs: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct ChunkGrid {
    configuration: ChunkGridConfig,
}

#[derive(Deserialize)]
struct ChunkGridConfig {
    chunk_shape: Vec<u64>, // N-dimensional (matches axes count)
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
}
