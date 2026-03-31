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
                        for (i, val) in s.iter().enumerate().take(5) {
                            if let Some(f) = val.as_f64() {
                                scale[i] = f;
                            }
                        }
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

    // Shape is [T, C, Z, Y, X] in Zarr metadata
    let shape_z = full_res.shape[2] as u32;
    let shape_y = full_res.shape[3] as u32;
    let shape_x = full_res.shape[4] as u32;

    let chunk_z = full_res.chunk_grid.configuration.chunk_shape[2] as u32;
    let chunk_y = full_res.chunk_grid.configuration.chunk_shape[3] as u32;
    let chunk_x = full_res.chunk_grid.configuration.chunk_shape[4] as u32;

    // Build LevelInfo for each level
    let level_info: Vec<LevelInfo> = level_metas
        .iter()
        .map(|lm| {
            let lz = lm.shape[2] as u32;
            let ly = lm.shape[3] as u32;
            let lx = lm.shape[4] as u32;
            let cz = lm.chunk_grid.configuration.chunk_shape[2] as u32;
            let cy = lm.chunk_grid.configuration.chunk_shape[3] as u32;
            let cx = lm.chunk_grid.configuration.chunk_shape[4] as u32;
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
    let axes_json: Vec<serde_json::Value> = ms
        .get("axes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.clone())
        .unwrap_or_default();

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
    })
}

// --- Internal deserialization types for Zarr v3 Array Metadata ---

struct LevelEntry {
    path: String,
    scale: [f64; 5], // [T, C, Z, Y, X]
}

#[derive(Deserialize)]
struct ArrayMeta {
    shape: Vec<u64>,       // [T, C, Z, Y, X]
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
    chunk_shape: Vec<u64>, // [T, C, Z, Y, X]
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
        fs::create_dir_all(dir).unwrap();

        // Build root zarr.json with multiscales
        let mut datasets = Vec::new();
        for i in 0..levels {
            let scale_factor = (1u64 << i) as f64;
            datasets.push(serde_json::json!({
                "path": i.to_string(),
                "coordinateTransformations": [{
                    "type": "scale",
                    "scale": [1.0, 1.0, scale_factor, scale_factor, scale_factor]
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
                        "axes": [
                            {"name": "t", "type": "time", "unit": "second"},
                            {"name": "c", "type": "channel"},
                            {"name": "z", "type": "space", "unit": "micrometer"},
                            {"name": "y", "type": "space", "unit": "micrometer"},
                            {"name": "x", "type": "space", "unit": "micrometer"}
                        ],
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
            let level_shape = [
                shape[0],
                shape[1],
                (shape[2] + scale - 1) / scale,
                (shape[3] + scale - 1) / scale,
                (shape[4] + scale - 1) / scale,
            ];
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
        // Should have axes and levels arrays
        assert!(cm.get("axes").unwrap().is_array());
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
}
