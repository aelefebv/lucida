//! Write OME-Zarr v0.5 collection and group metadata files.
//!
//! Generates the Zarr v3 group metadata for the collection hierarchy:
//! - Root `zarr.json` with `ome.plate` attributes
//! - Per-row group `zarr.json`
//! - Per-group `zarr.json` with `ome.well` attributes

use std::fs;
use std::path::Path;

use serde_json::json;

use super::collection_scanner::{CollectionLayout, GroupLayout};

/// Write the root collection `zarr.json` metadata file.
///
/// Creates the output directory and writes a Zarr v3 group with OME collection
/// attributes describing rows, columns, groups, and tile count.
pub fn write_collection_metadata(output: &Path, layout: &CollectionLayout) -> Result<(), String> {
    fs::create_dir_all(output).map_err(|e| format!("failed to create output dir: {e}"))?;

    let rows: Vec<serde_json::Value> = layout.rows.iter().map(|r| json!({"name": r})).collect();

    let columns: Vec<serde_json::Value> =
        layout.columns.iter().map(|c| json!({"name": c})).collect();

    let groups: Vec<serde_json::Value> = layout
        .groups
        .iter()
        .map(|w| {
            json!({
                "path": format!("{}/{}", w.row_name, w.col_name),
                "rowIndex": w.row_index,
                "columnIndex": w.col_index,
            })
        })
        .collect();

    // tile_count is the max number of tiles across all groups.
    let tile_count = layout
        .groups
        .iter()
        .map(|w| w.tiles.len())
        .max()
        .unwrap_or(0);

    let root_meta = json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "ome": {
                "version": "0.5",
                "plate": {
                    "version": "0.5",
                    "name": layout.name,
                    "rows": rows,
                    "columns": columns,
                    "wells": groups,
                    "field_count": tile_count,
                }
            }
        }
    });

    let content = serde_json::to_string_pretty(&root_meta)
        .map_err(|e| format!("failed to serialize collection metadata: {e}"))?;
    let path = output.join("zarr.json");
    fs::write(&path, content).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Write the group-level `zarr.json` metadata files.
///
/// Creates the row directory with a minimal group `zarr.json`, then creates
/// the group directory with an OME group listing tile image paths.
pub fn write_group_metadata(output: &Path, group: &GroupLayout) -> Result<(), String> {
    // Create row directory and write minimal group metadata.
    let row_dir = output.join(&group.row_name);
    fs::create_dir_all(&row_dir).map_err(|e| format!("failed to create row dir: {e}"))?;

    let row_meta = json!({
        "zarr_format": 3,
        "node_type": "group",
    });
    let row_content = serde_json::to_string_pretty(&row_meta)
        .map_err(|e| format!("failed to serialize row metadata: {e}"))?;
    let row_zarr_path = row_dir.join("zarr.json");
    fs::write(&row_zarr_path, row_content)
        .map_err(|e| format!("failed to write {}: {e}", row_zarr_path.display()))?;

    // Create group directory and write group metadata.
    let group_dir = row_dir.join(&group.col_name);
    fs::create_dir_all(&group_dir).map_err(|e| format!("failed to create group dir: {e}"))?;

    let images: Vec<serde_json::Value> = group
        .tiles
        .iter()
        .enumerate()
        .map(|(i, _)| json!({"path": i.to_string()}))
        .collect();

    let group_meta = json!({
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

    let group_content = serde_json::to_string_pretty(&group_meta)
        .map_err(|e| format!("failed to serialize group metadata: {e}"))?;
    let group_zarr_path = group_dir.join("zarr.json");
    fs::write(&group_zarr_path, group_content)
        .map_err(|e| format!("failed to write {}: {e}", group_zarr_path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    use crate::ingest::collection_scanner::TileLayout;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!(
                "lucida_collection_meta_test_{}",
                std::process::id()
            ))
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// Build a CollectionLayout with given groups for testing.
    fn make_layout(
        name: &str,
        rows: Vec<&str>,
        columns: Vec<&str>,
        groups: Vec<GroupLayout>,
    ) -> CollectionLayout {
        CollectionLayout {
            name: name.to_string(),
            rows: rows.into_iter().map(String::from).collect(),
            columns: columns.into_iter().map(String::from).collect(),
            groups,
            channels: 1,
            timepoints: 1,
            z_planes: 1,
            image_width: 256,
            image_height: 256,
            voxel_size: crate::ingest::pyramid::VoxelSize::default(),
        }
    }

    /// Build a GroupLayout with n tiles (no actual file mappings).
    fn make_group(row: &str, col: &str, row_idx: u32, col_idx: u32, num_tiles: u32) -> GroupLayout {
        let tiles = (0..num_tiles)
            .map(|i| TileLayout {
                index: i,
                files: HashMap::new(),
            })
            .collect();
        GroupLayout {
            row_name: row.to_string(),
            col_name: col.to_string(),
            row_index: row_idx,
            col_index: col_idx,
            tiles,
        }
    }

    #[test]
    fn collection_metadata_json_structure() {
        let dir = temp_dir("collection_json");
        let layout = make_layout(
            "my_collection",
            vec!["A", "B"],
            vec!["1", "3"],
            vec![make_group("A", "1", 0, 0, 2), make_group("B", "3", 1, 1, 2)],
        );

        write_collection_metadata(&dir, &layout).unwrap();

        let content = std::fs::read_to_string(dir.join("zarr.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();

        assert_eq!(json["zarr_format"], 3);
        assert_eq!(json["node_type"], "group");
        assert_eq!(json["attributes"]["ome"]["version"], "0.5");

        let collection = &json["attributes"]["ome"]["plate"];
        assert_eq!(collection["version"], "0.5");
        assert_eq!(collection["name"], "my_collection");
        assert_eq!(collection["field_count"], 2);

        let rows = collection["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["name"], "A");
        assert_eq!(rows[1]["name"], "B");

        let columns = collection["columns"].as_array().unwrap();
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0]["name"], "1");
        assert_eq!(columns[1]["name"], "3");

        let groups = collection["wells"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["path"], "A/1");
        assert_eq!(groups[0]["rowIndex"], 0);
        assert_eq!(groups[0]["columnIndex"], 0);
        assert_eq!(groups[1]["path"], "B/3");
        assert_eq!(groups[1]["rowIndex"], 1);
        assert_eq!(groups[1]["columnIndex"], 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn group_metadata_json_structure() {
        let dir = temp_dir("group_json");
        std::fs::create_dir_all(&dir).unwrap();

        let group = make_group("A", "1", 0, 0, 4);
        write_group_metadata(&dir, &group).unwrap();

        // Row directory zarr.json should be a minimal group.
        let row_content = std::fs::read_to_string(dir.join("A/zarr.json")).unwrap();
        let row_json: serde_json::Value = serde_json::from_str(&row_content).unwrap();
        assert_eq!(row_json["zarr_format"], 3);
        assert_eq!(row_json["node_type"], "group");
        assert!(row_json.get("attributes").is_none());

        // Group directory zarr.json should have ome.well.images.
        let group_content = std::fs::read_to_string(dir.join("A/1/zarr.json")).unwrap();
        let group_json: serde_json::Value = serde_json::from_str(&group_content).unwrap();
        assert_eq!(group_json["zarr_format"], 3);
        assert_eq!(group_json["node_type"], "group");
        assert_eq!(group_json["attributes"]["ome"]["version"], "0.5");

        let images = group_json["attributes"]["ome"]["well"]["images"]
            .as_array()
            .unwrap();
        assert_eq!(images.len(), 4);
        assert_eq!(images[0]["path"], "0");
        assert_eq!(images[1]["path"], "1");
        assert_eq!(images[2]["path"], "2");
        assert_eq!(images[3]["path"], "3");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn group_metadata_correct_tile_count() {
        let dir = temp_dir("group_tile_count");
        std::fs::create_dir_all(&dir).unwrap();

        // Test with various tile counts.
        for n in [1, 3, 8, 16] {
            let sub = dir.join(format!("n{n}"));
            let group = make_group("A", "1", 0, 0, n);
            write_group_metadata(&sub, &group).unwrap();

            let content = std::fs::read_to_string(sub.join("A/1/zarr.json")).unwrap();
            let json: serde_json::Value = serde_json::from_str(&content).unwrap();
            let images = json["attributes"]["ome"]["well"]["images"]
                .as_array()
                .unwrap();
            assert_eq!(images.len(), n as usize, "tile count mismatch for n={n}");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sparse_collection_generates_correct_groups() {
        let dir = temp_dir("sparse");
        // Collection with 3 rows and 3 columns but only 2 groups filled (sparse).
        let layout = make_layout(
            "sparse_collection",
            vec!["A", "B", "C"],
            vec!["1", "2", "3"],
            vec![make_group("A", "3", 0, 2, 2), make_group("C", "1", 2, 0, 1)],
        );

        write_collection_metadata(&dir, &layout).unwrap();

        let content = std::fs::read_to_string(dir.join("zarr.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();

        let collection = &json["attributes"]["ome"]["plate"];

        // All 3 rows and 3 columns should be listed.
        let rows = collection["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 3);
        let columns = collection["columns"].as_array().unwrap();
        assert_eq!(columns.len(), 3);

        // Only 2 groups should be listed.
        let groups = collection["wells"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["path"], "A/3");
        assert_eq!(groups[0]["rowIndex"], 0);
        assert_eq!(groups[0]["columnIndex"], 2);
        assert_eq!(groups[1]["path"], "C/1");
        assert_eq!(groups[1]["rowIndex"], 2);
        assert_eq!(groups[1]["columnIndex"], 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Write a minimal tile directory with multiscales metadata so read_collection_info
    /// can parse it. Currently unused; preserved for future collection-metadata tests
    /// that exercise read_collection_info against synthesized fixtures.
    #[allow(dead_code)]
    fn write_tile_fixture(tile_dir: &std::path::Path) {
        use crate::ingest::ome_metadata;
        use crate::ingest::pyramid::LevelData;

        std::fs::create_dir_all(tile_dir).unwrap();

        let level = LevelData {
            data: vec![],
            width: 256,
            height: 256,
            depth: 1,
            channels: 1,
            timepoints: 1,
        };
        let scales = vec![[1.0, 1.0, 1.0]];
        let ome_attrs = ome_metadata::build_multiscales_attrs(&[level], &scales);

        let tile_root = serde_json::json!({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": ome_attrs
        });
        std::fs::write(
            tile_dir.join("zarr.json"),
            serde_json::to_string_pretty(&tile_root).unwrap(),
        )
        .unwrap();

        // Write level 0 array metadata.
        let level_dir = tile_dir.join("0");
        std::fs::create_dir_all(&level_dir).unwrap();
        let level_data = LevelData {
            data: vec![],
            width: 256,
            height: 256,
            depth: 1,
            channels: 1,
            timepoints: 1,
        };
        let arr = ome_metadata::build_array_zarr_json(&level_data, &[1, 64, 64]);
        std::fs::write(
            level_dir.join("zarr.json"),
            serde_json::to_string_pretty(&arr).unwrap(),
        )
        .unwrap();
    }
}
