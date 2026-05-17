//! Shared OME-Zarr parsing helpers.
//!
//! Low-level functions for reading and parsing Zarr v3 / OME-Zarr metadata
//! from an object store. Consumed by [`crate::import`].

use std::sync::Arc;

use object_store::ObjectStore;
use object_store::path::Path;
use serde::Deserialize;

use lucida_content::normalize::{normalize_f64_to_5d, normalize_to_5d};

use crate::backend::StoreError;

/// Intermediate per-level metadata parsed from OME multiscales.
#[derive(Debug, Clone)]
pub struct LevelEntry {
    pub path: String,
    pub scale: [f64; 5], // [T, C, Z, Y, X]
}

/// Deserialized from a level's zarr.json.
#[derive(Debug, Deserialize)]
pub struct ArrayMeta {
    pub shape: Vec<u64>, // N-dimensional (matches axes count)
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

/// Read and parse a zarr.json file from the object store.
pub(crate) async fn read_zarr_json(
    store: &Arc<dyn ObjectStore>,
    path: &str,
) -> Result<serde_json::Value, StoreError> {
    let bytes = store.get(&Path::from(path)).await?.bytes().await?;
    serde_json::from_slice(&bytes).map_err(|e| StoreError::Metadata(e.to_string()))
}

/// Parsed OME multiscales metadata.
#[derive(Debug)]
pub(crate) struct ParsedMultiscales {
    pub axes_names: Vec<String>,
    pub level_entries: Vec<LevelEntry>,
}

/// Parse OME multiscales from a root zarr.json value.
/// `error_prefix` is prepended to error messages (e.g., "A/1/0: " for plates).
pub(crate) fn parse_multiscales(
    root_json: &serde_json::Value,
    error_prefix: &str,
) -> Result<ParsedMultiscales, StoreError> {
    let multiscales = root_json
        .pointer("/attributes/ome/multiscales")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            StoreError::Metadata(format!(
                "{error_prefix}no ome.multiscales in root zarr.json"
            ))
        })?;

    let ms = multiscales
        .first()
        .ok_or_else(|| StoreError::Metadata(format!("{error_prefix}multiscales array is empty")))?;

    let axes_json: Vec<serde_json::Value> = ms
        .get("axes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let axes_names: Vec<String> = axes_json
        .iter()
        .filter_map(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
        })
        .collect();

    let datasets_arr = ms
        .get("datasets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| StoreError::Metadata(format!("{error_prefix}no datasets in multiscales")))?;

    let mut level_entries: Vec<LevelEntry> = Vec::new();
    for ds in datasets_arr {
        let path = ds
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                StoreError::Metadata(format!("{error_prefix}dataset entry missing path"))
            })?
            .to_string();

        let mut scale = [1.0_f64; 5]; // [T, C, Z, Y, X]
        if let Some(transforms) = ds
            .get("coordinateTransformations")
            .and_then(|v| v.as_array())
        {
            for ct in transforms {
                if ct.get("type").and_then(|v| v.as_str()) == Some("scale")
                    && let Some(s) = ct.get("scale").and_then(|v| v.as_array())
                {
                    let raw: Vec<f64> = s.iter().filter_map(|v| v.as_f64()).collect();
                    scale = normalize_f64_to_5d(&raw, &axes_names, 1.0);
                }
            }
        }

        level_entries.push(LevelEntry { path, scale });
    }

    if level_entries.is_empty() {
        return Err(StoreError::Metadata(format!(
            "{error_prefix}no levels found"
        )));
    }

    Ok(ParsedMultiscales {
        axes_names,
        level_entries,
    })
}

/// Read ArrayMeta for each level in the multiscale pyramid.
/// `base_prefix` is prepended to level paths (empty for root, "A/1/0" for plate FOVs).
pub(crate) async fn read_level_metas(
    store: &Arc<dyn ObjectStore>,
    base_prefix: &str,
    level_entries: &[LevelEntry],
) -> Result<Vec<ArrayMeta>, StoreError> {
    let mut level_metas: Vec<ArrayMeta> = Vec::new();
    for entry in level_entries {
        let level_path = if base_prefix.is_empty() {
            Path::from(format!("{}/zarr.json", entry.path))
        } else {
            Path::from(format!("{base_prefix}/{}/zarr.json", entry.path))
        };
        let level_bytes = store.get(&level_path).await?.bytes().await?;
        let error_ctx = if base_prefix.is_empty() {
            entry.path.clone()
        } else {
            format!("{base_prefix}/{}", entry.path)
        };
        let meta: ArrayMeta = serde_json::from_slice(&level_bytes)
            .map_err(|e| StoreError::Metadata(format!("{error_ctx}: {e}")))?;
        level_metas.push(meta);
    }
    Ok(level_metas)
}

/// Extract and normalize the full-resolution (level 0) shape and chunk shape to 5D.
/// Returns `(shape_5d, chunk_5d)`.
pub(crate) fn extract_full_res(
    level_metas: &[ArrayMeta],
    axes_names: &[String],
) -> ([u64; 5], [u64; 5]) {
    let full_res = &level_metas[0];
    let full_shape_5d = normalize_to_5d(&full_res.shape, axes_names, 1);
    let full_chunk_5d = normalize_to_5d(
        &full_res.chunk_grid.configuration.chunk_shape,
        axes_names,
        1,
    );
    (full_shape_5d, full_chunk_5d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_multiscales_extracts_axes_and_levels() {
        let root_json = serde_json::json!({
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
                        "datasets": [
                            {
                                "path": "0",
                                "coordinateTransformations": [{
                                    "type": "scale",
                                    "scale": [1.0, 1.0, 2.0, 0.5, 0.5]
                                }]
                            },
                            {
                                "path": "1",
                                "coordinateTransformations": [{
                                    "type": "scale",
                                    "scale": [1.0, 1.0, 4.0, 1.0, 1.0]
                                }]
                            }
                        ]
                    }]
                }
            }
        });

        let parsed = parse_multiscales(&root_json, "").unwrap();

        assert_eq!(parsed.axes_names, vec!["t", "c", "z", "y", "x"]);
        assert_eq!(parsed.level_entries.len(), 2);
        assert_eq!(parsed.level_entries[0].path, "0");
        assert_eq!(parsed.level_entries[0].scale, [1.0, 1.0, 2.0, 0.5, 0.5]);
        assert_eq!(parsed.level_entries[1].path, "1");
        assert_eq!(parsed.level_entries[1].scale, [1.0, 1.0, 4.0, 1.0, 1.0]);
    }

    #[test]
    fn parse_multiscales_error_prefix() {
        let root_json =
            serde_json::json!({"zarr_format": 3, "node_type": "group", "attributes": {}});
        let err = parse_multiscales(&root_json, "A/1/0: ").unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("A/1/0: "),
            "error should contain prefix: {msg}",
        );
    }

    #[test]
    fn extract_full_res_normalizes_to_5d() {
        let axes = vec!["z", "y", "x"]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();

        let level_metas = vec![ArrayMeta {
            shape: vec![20, 100, 200],
            data_type: "uint16".to_string(),
            chunk_grid: ChunkGrid {
                configuration: ChunkGridConfig {
                    chunk_shape: vec![10, 64, 64],
                },
            },
            codecs: vec![],
        }];

        let (shape_5d, chunk_5d) = extract_full_res(&level_metas, &axes);

        // T=1, C=1, Z=20, Y=100, X=200
        assert_eq!(shape_5d, [1, 1, 20, 100, 200]);
        // T=1, C=1, Z=10, Y=64, X=64
        assert_eq!(chunk_5d, [1, 1, 10, 64, 64]);
    }
}
