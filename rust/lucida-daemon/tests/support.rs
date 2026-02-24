use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};

#[derive(Debug, Clone)]
pub struct SampleDatasetOptions {
    pub include_multiscale_name: bool,
    pub include_level_one_scale: bool,
    pub include_channel_indices: bool,
    pub extra_root_attrs: Map<String, Value>,
}

impl Default for SampleDatasetOptions {
    fn default() -> Self {
        Self {
            include_multiscale_name: true,
            include_level_one_scale: true,
            include_channel_indices: true,
            extra_root_attrs: Map::new(),
        }
    }
}

pub fn create_sample_omezarr(path: &Path, options: SampleDatasetOptions) {
    fs::create_dir_all(path).expect("create dataset root");
    fs::create_dir_all(path.join("0")).expect("create level 0");
    fs::create_dir_all(path.join("1")).expect("create level 1");

    let level0_transformations = vec![
        json!({"type": "scale", "scale": [1, 1, 1, 1, 1]}),
        json!({"type": "translation", "translation": [0, 0, 0, 0, 0]}),
    ];
    let mut level1 = json!({
        "path": "1",
    });
    if options.include_level_one_scale {
        level1["coordinateTransformations"] = json!([{"type": "scale", "scale": [1, 1, 2, 2, 2]}]);
    }

    let mut multiscale = json!({
        "axes": [
            {"name": "t", "type": "t"},
            {"name": "c", "type": "c"},
            {"name": "z", "type": "z", "unit": "micron"},
            {"name": "y", "type": "y", "unit": "micron"},
            {"name": "x", "type": "x", "unit": "micron"}
        ],
        "datasets": [
            {
                "path": "0",
                "coordinateTransformations": level0_transformations,
            },
            level1
        ]
    });
    if options.include_multiscale_name {
        multiscale["name"] = json!("primary");
    }

    let mut channels = vec![
        json!({
            "label": "DNA",
            "color": "FF0000",
            "window": {"start": 10, "end": 400},
        }),
        json!({
            "label": "RNA",
            "color": "00FF00",
            "window": {"start": 20, "end": 200},
        }),
    ];
    if options.include_channel_indices {
        channels[0]["index"] = json!(0);
        channels[1]["index"] = json!(1);
    }

    let mut attributes = Map::new();
    attributes.insert("multiscales".to_owned(), json!([multiscale]));
    attributes.insert("omero".to_owned(), json!({"channels": channels}));
    for (key, value) in options.extra_root_attrs {
        attributes.insert(key, value);
    }

    let root_metadata = json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": attributes,
    });
    let level0_metadata = json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [1, 2, 4, 8, 10],
        "data_type": "uint16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, 1, 2, 4, 5]}},
        "attributes": {}
    });
    let level1_metadata = json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [1, 2, 2, 4, 5],
        "data_type": "uint16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, 1, 1, 2, 3]}},
        "attributes": {}
    });

    write_json(path.join("zarr.json"), &root_metadata);
    write_json(path.join("0").join("zarr.json"), &level0_metadata);
    write_json(path.join("1").join("zarr.json"), &level1_metadata);
}

pub fn create_invalid_zarr(path: &Path) {
    fs::create_dir_all(path).expect("create dataset root");
    fs::create_dir_all(path.join("0")).expect("create level 0");
    let root_metadata = json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {"description": "missing multiscales metadata"},
    });
    let level0_metadata = json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [4, 4],
        "data_type": "uint8",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [2, 2]}},
        "attributes": {}
    });
    write_json(path.join("zarr.json"), &root_metadata);
    write_json(path.join("0").join("zarr.json"), &level0_metadata);
}

fn write_json(path: impl AsRef<Path>, payload: &Value) {
    let path = path.as_ref();
    let serialized = serde_json::to_string_pretty(payload).expect("serialize json");
    fs::write(path, serialized).expect("write file");
}
