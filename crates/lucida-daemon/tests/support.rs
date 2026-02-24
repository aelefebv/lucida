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

pub fn create_render_omezarr(path: &Path) {
    fs::create_dir_all(path).expect("create dataset root");
    fs::create_dir_all(path.join("0")).expect("create level 0");
    fs::create_dir_all(path.join("1")).expect("create level 1");

    let shape_level0 = vec![1_usize, 3, 4, 5, 6];
    let shape_level1 = vec![1_usize, 3, 2, 3, 3];
    let chunk_level0 = vec![1_usize, 1, 2, 3, 3];
    let chunk_level1 = vec![1_usize, 1, 1, 2, 2];

    let mut data_level0 = vec![0_u16; shape_level0.iter().product()];
    for t in 0..shape_level0[0] {
        for c in 0..shape_level0[1] {
            for z in 0..shape_level0[2] {
                for y in 0..shape_level0[3] {
                    for x in 0..shape_level0[4] {
                        let linear =
                            linear_index(&[t, c, z, y, x], &c_order_strides(&shape_level0));
                        data_level0[linear] = ((c * 1000) + (z * 100) + (y * 10) + x) as u16;
                    }
                }
            }
        }
    }

    let mut data_level1 = vec![0_u16; shape_level1.iter().product()];
    for t in 0..shape_level1[0] {
        for c in 0..shape_level1[1] {
            for z in 0..shape_level1[2] {
                for y in 0..shape_level1[3] {
                    for x in 0..shape_level1[4] {
                        let src = [t, c, z * 2, y * 2, x * 2];
                        let dst = [t, c, z, y, x];
                        let src_linear = linear_index(&src, &c_order_strides(&shape_level0));
                        let dst_linear = linear_index(&dst, &c_order_strides(&shape_level1));
                        data_level1[dst_linear] = data_level0[src_linear];
                    }
                }
            }
        }
    }

    let root_metadata = json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "multiscales": [
                {
                    "name": "primary",
                    "axes": [
                        {"name": "t", "type": "t"},
                        {"name": "c", "type": "c"},
                        {"name": "z", "type": "z"},
                        {"name": "y", "type": "y"},
                        {"name": "x", "type": "x"},
                    ],
                    "datasets": [
                        {"path": "0", "coordinateTransformations": [{"type": "scale", "scale": [1, 1, 1, 1, 1]}]},
                        {"path": "1", "coordinateTransformations": [{"type": "scale", "scale": [1, 1, 2, 2, 2]}]},
                    ],
                }
            ],
            "omero": {
                "channels": [
                    {"index": 0, "label": "c0", "color": "ffffff", "window": {"start": 0, "end": 500}},
                    {"index": 1, "label": "c1", "color": "ff0000", "window": {"start": 0, "end": 1500}},
                    {"index": 2, "label": "c2", "color": "00ff00", "window": {"start": 0, "end": 2500}},
                ]
            }
        }
    });
    let level0_metadata = json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": shape_level0,
        "data_type": "uint16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": chunk_level0}},
        "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
        "fill_value": 0,
        "codecs": [
            {"name": "bytes", "configuration": {"endian": "little"}},
            {"name": "zstd", "configuration": {"level": 0, "checksum": false}},
        ],
        "attributes": {},
        "storage_transformers": [],
    });
    let level1_metadata = json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": shape_level1,
        "data_type": "uint16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": chunk_level1}},
        "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
        "fill_value": 0,
        "codecs": [
            {"name": "bytes", "configuration": {"endian": "little"}},
            {"name": "zstd", "configuration": {"level": 0, "checksum": false}},
        ],
        "attributes": {},
        "storage_transformers": [],
    });

    write_json(path.join("zarr.json"), &root_metadata);
    write_json(path.join("0").join("zarr.json"), &level0_metadata);
    write_json(path.join("1").join("zarr.json"), &level1_metadata);

    write_u16_chunks(&path.join("0"), &shape_level0, &chunk_level0, &data_level0);
    write_u16_chunks(&path.join("1"), &shape_level1, &chunk_level1, &data_level1);
}

fn write_json(path: impl AsRef<Path>, payload: &Value) {
    let path = path.as_ref();
    let serialized = serde_json::to_string_pretty(payload).expect("serialize json");
    fs::write(path, serialized).expect("write file");
}

fn write_u16_chunks(level_path: &Path, shape: &[usize], chunk_shape: &[usize], data: &[u16]) {
    let chunk_counts: Vec<usize> = shape
        .iter()
        .zip(chunk_shape.iter())
        .map(|(axis_size, chunk_size)| (*axis_size + *chunk_size - 1) / *chunk_size)
        .collect();
    let shape_strides = c_order_strides(shape);
    let chunk_strides = c_order_strides(chunk_shape);

    for_each_index(&chunk_counts, |chunk_index| {
        let mut chunk_values = vec![0_u16; chunk_shape.iter().product()];

        let mut actual_shape = Vec::new();
        let mut start = Vec::new();
        for axis in 0..shape.len() {
            let axis_start = chunk_index[axis] * chunk_shape[axis];
            start.push(axis_start);
            actual_shape.push(chunk_shape[axis].min(shape[axis] - axis_start));
        }

        for_each_index(&actual_shape, |local_index| {
            let mut global = vec![0usize; shape.len()];
            for axis in 0..shape.len() {
                global[axis] = start[axis] + local_index[axis];
            }
            let src_linear = linear_index(&global, &shape_strides);
            let dst_linear = linear_index(local_index, &chunk_strides);
            chunk_values[dst_linear] = data[src_linear];
        });

        let mut raw_bytes = Vec::with_capacity(chunk_values.len() * 2);
        for value in chunk_values {
            raw_bytes.extend_from_slice(&value.to_le_bytes());
        }
        let compressed = zstd::stream::encode_all(&raw_bytes[..], 0).expect("compress zarr chunk");

        let mut chunk_path = level_path.join("c");
        for index in chunk_index {
            chunk_path = chunk_path.join(index.to_string());
        }
        if let Some(parent) = chunk_path.parent() {
            fs::create_dir_all(parent).expect("create chunk parent");
        }
        fs::write(chunk_path, compressed).expect("write chunk");
    });
}

fn for_each_index<F>(shape: &[usize], mut callback: F)
where
    F: FnMut(&[usize]),
{
    if shape.is_empty() {
        callback(&[]);
        return;
    }
    if shape.contains(&0) {
        return;
    }
    let mut index = vec![0usize; shape.len()];
    loop {
        callback(&index);

        let mut axis = shape.len();
        loop {
            axis -= 1;
            index[axis] += 1;
            if index[axis] < shape[axis] {
                break;
            }
            index[axis] = 0;
            if axis == 0 {
                return;
            }
        }
    }
}

fn c_order_strides(shape: &[usize]) -> Vec<usize> {
    if shape.is_empty() {
        return Vec::new();
    }
    let mut strides = vec![1usize; shape.len()];
    for axis in (0..shape.len() - 1).rev() {
        strides[axis] = strides[axis + 1].saturating_mul(shape[axis + 1]);
    }
    strides
}

fn linear_index(indices: &[usize], strides: &[usize]) -> usize {
    indices
        .iter()
        .zip(strides.iter())
        .fold(0usize, |acc, (index, stride)| acc + (index * stride))
}
