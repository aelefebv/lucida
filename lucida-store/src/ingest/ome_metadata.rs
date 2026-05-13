use serde_json::{Value, json};

use super::pyramid::LevelData;

/// Build the OME-Zarr v0.5 multiscales attributes for the root group.
///
/// `level_scales` provides per-level cumulative [x, y, z] scale factors.
/// Always writes 5D TCZYX axes. Output is wrapped in `{"ome": {...}}`.
pub fn build_multiscales_attrs(levels: &[LevelData], level_scales: &[[f64; 3]]) -> Value {
    let datasets: Vec<Value> = levels
        .iter()
        .enumerate()
        .map(|(i, _)| {
            let s = level_scales.get(i).copied().unwrap_or([1.0, 1.0, 1.0]);
            json!({
                "path": i.to_string(),
                "coordinateTransformations": [
                    {
                        "type": "scale",
                        // TCZYX order: [t, c, z, y, x]
                        "scale": [1.0, 1.0, s[2], s[1], s[0]]
                    }
                ]
            })
        })
        .collect();

    json!({
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
                "datasets": datasets,
                "type": "2x2 box average"
            }]
        }
    })
}

/// Build the Zarr v3 `zarr.json` for a single resolution level array.
///
/// `chunk_size` is [Z, Y, X] matching lucida-core convention.
/// Output shape is always 5D: [T, C, Z, Y, X].
pub fn build_array_zarr_json(level: &LevelData, chunk_size: &[u32; 3]) -> Value {
    json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [level.timepoints, level.channels, level.depth, level.height, level.width],
        "data_type": "uint16",
        "chunk_grid": {
            "name": "regular",
            "configuration": {
                "chunk_shape": [1, 1, chunk_size[0], chunk_size[1], chunk_size[2]]
            }
        },
        "chunk_key_encoding": {
            "name": "default",
            "configuration": {
                "separator": "/"
            }
        },
        "fill_value": 0,
        "codecs": [
            {
                "name": "bytes",
                "configuration": {
                    "endian": "little"
                }
            },
            {
                "name": "numcodecs/lz4",
                "configuration": {
                    "acceleration": 1
                }
            }
        ],
        "dimension_names": ["t", "c", "z", "y", "x"],
        "attributes": {}
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn array_zarr_json_shape_and_chunks() {
        let level = LevelData {
            data: vec![],
            width: 512,
            height: 512,
            depth: 20,
            channels: 3,
            timepoints: 5,
        };
        let za = build_array_zarr_json(&level, &[1, 256, 256]);
        assert_eq!(za["zarr_format"], 3);
        assert_eq!(za["node_type"], "array");
        assert_eq!(za["shape"], json!([5, 3, 20, 512, 512]));
        assert_eq!(
            za["chunk_grid"]["configuration"]["chunk_shape"],
            json!([1, 1, 1, 256, 256])
        );
        assert_eq!(za["data_type"], "uint16");
        assert_eq!(za["dimension_names"], json!(["t", "c", "z", "y", "x"]));
        assert_eq!(za["codecs"][0]["name"], "bytes");
        assert_eq!(za["codecs"][1]["name"], "numcodecs/lz4");
    }

    #[test]
    fn array_zarr_json_single_frame() {
        let level = LevelData {
            data: vec![],
            width: 1024,
            height: 768,
            depth: 1,
            channels: 1,
            timepoints: 1,
        };
        let za = build_array_zarr_json(&level, &[1, 256, 256]);
        assert_eq!(za["shape"], json!([1, 1, 1, 768, 1024]));
        assert_eq!(
            za["chunk_grid"]["configuration"]["chunk_shape"],
            json!([1, 1, 1, 256, 256])
        );
    }

    #[test]
    fn multiscales_has_5_axes() {
        let levels = vec![LevelData {
            data: vec![],
            width: 512,
            height: 512,
            depth: 1,
            channels: 1,
            timepoints: 1,
        }];
        let scales = vec![[1.0, 1.0, 1.0]];
        let attrs = build_multiscales_attrs(&levels, &scales);
        let axes = attrs["ome"]["multiscales"][0]["axes"].as_array().unwrap();
        assert_eq!(axes.len(), 5);
        assert_eq!(axes[0]["name"], "t");
        assert_eq!(axes[4]["name"], "x");
    }

    #[test]
    fn multiscales_ome_wrapper() {
        let levels = vec![LevelData {
            data: vec![],
            width: 512,
            height: 512,
            depth: 1,
            channels: 1,
            timepoints: 1,
        }];
        let scales = vec![[1.0, 1.0, 1.0]];
        let attrs = build_multiscales_attrs(&levels, &scales);
        assert_eq!(attrs["ome"]["version"], "0.5");
        assert_eq!(attrs["ome"]["multiscales"][0]["version"], "0.5");
    }

    #[test]
    fn multiscales_scale_factors() {
        let levels = vec![
            LevelData {
                data: vec![],
                width: 512,
                height: 512,
                depth: 1,
                channels: 1,
                timepoints: 1,
            },
            LevelData {
                data: vec![],
                width: 256,
                height: 256,
                depth: 1,
                channels: 1,
                timepoints: 1,
            },
        ];
        let scales = vec![[1.0, 1.0, 1.0], [2.0, 2.0, 1.0]];
        let attrs = build_multiscales_attrs(&levels, &scales);
        let ds = &attrs["ome"]["multiscales"][0]["datasets"];
        assert_eq!(ds[0]["path"], "0");
        assert_eq!(ds[1]["path"], "1");
        // Level 1 scale: [1, 1, 1, 2, 2] (TCZYX)
        assert_eq!(
            ds[1]["coordinateTransformations"][0]["scale"],
            json!([1.0, 1.0, 1.0, 2.0, 2.0])
        );
    }

    #[test]
    fn multiscales_anisotropic_scales() {
        let levels = vec![
            LevelData {
                data: vec![],
                width: 512,
                height: 512,
                depth: 100,
                channels: 1,
                timepoints: 1,
            },
            LevelData {
                data: vec![],
                width: 256,
                height: 256,
                depth: 100,
                channels: 1,
                timepoints: 1,
            },
            LevelData {
                data: vec![],
                width: 128,
                height: 128,
                depth: 50,
                channels: 1,
                timepoints: 1,
            },
        ];
        let scales = vec![[1.0, 1.0, 1.0], [2.0, 2.0, 1.0], [4.0, 4.0, 2.0]];
        let attrs = build_multiscales_attrs(&levels, &scales);
        let ds = &attrs["ome"]["multiscales"][0]["datasets"];
        // Level 1: XY only → z stays 1.0
        assert_eq!(
            ds[1]["coordinateTransformations"][0]["scale"],
            json!([1.0, 1.0, 1.0, 2.0, 2.0])
        );
        // Level 2: XY + Z → z=2.0
        assert_eq!(
            ds[2]["coordinateTransformations"][0]["scale"],
            json!([1.0, 1.0, 2.0, 4.0, 4.0])
        );
    }
}
