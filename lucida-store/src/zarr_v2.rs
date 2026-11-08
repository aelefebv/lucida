//! Zarr v2 metadata, rewritten into the Zarr v3 form the rest of the import
//! reads.
//!
//! A v2 hierarchy keeps a group's attributes in `.zattrs` and an array's
//! metadata in `.zarray`. Each is rewritten here into what its v3
//! `zarr.json` would say, so parsing, the codec registry, and everything after
//! them see one format and never branch on the version. OME-NGFF 0.4 puts its
//! blocks at the top of `.zattrs`, the placement [`crate::parse`] already
//! reads for v3 writers that predate OME-Zarr 0.5.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::parse::{ArrayMeta, ChunkGrid, ChunkGridConfig};

/// The group a `.zattrs` object describes, as a v3 group's `zarr.json`.
pub(crate) fn group(attributes: Value) -> Value {
    json!({"zarr_format": 2, "node_type": "group", "attributes": attributes})
}

/// A `.zarray` object as written. `filters` and `dimension_separator` are
/// often left out, and a missing `fill_value` reads as Zarr v2's `null`.
#[derive(Debug, Deserialize)]
struct ZArray {
    zarr_format: u64,
    shape: Vec<u64>,
    chunks: Vec<u64>,
    dtype: Value,
    compressor: Option<Value>,
    #[serde(default)]
    fill_value: Value,
    order: String,
    #[serde(default)]
    filters: Option<Vec<Value>>,
    #[serde(default)]
    dimension_separator: Option<String>,
}

/// An array's `.zarray`, as the [`ArrayMeta`] its v3 `zarr.json` would give.
///
/// Fortran order becomes a transpose that reverses the axes, the data type's
/// byte order becomes the `bytes` codec's, and the filters and compressor,
/// in that order, become bytes-to-bytes codecs named by their numcodecs
/// `id`. Whether the registry decodes them is its decision, not this one's.
pub(crate) fn array_meta(bytes: &[u8]) -> Result<ArrayMeta, String> {
    let zarray: ZArray = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if zarray.zarr_format != 2 {
        return Err(format!(
            "zarr_format {} in .zarray (expected 2)",
            zarray.zarr_format
        ));
    }
    if zarray.chunks.len() != zarray.shape.len() {
        return Err(format!(
            "chunks {:?} and shape {:?} have different numbers of axes",
            zarray.chunks, zarray.shape
        ));
    }
    let (data_type, endian) = data_type(&zarray.dtype)?;

    let ndim = zarray.shape.len();
    let mut codecs = Vec::new();
    match zarray.order.as_str() {
        "C" => {}
        "F" => codecs.push(json!({
            "name": "transpose",
            "configuration": {"order": (0..ndim).rev().collect::<Vec<_>>()}
        })),
        other => return Err(format!("order {other:?} (expected \"C\" or \"F\")")),
    }
    codecs.push(match endian {
        Some(endian) => json!({"name": "bytes", "configuration": {"endian": endian}}),
        None => json!({"name": "bytes"}),
    });
    for numcodec in zarray.filters.iter().flatten().chain(&zarray.compressor) {
        codecs.push(codec(numcodec)?);
    }

    let separator = match zarray.dimension_separator.as_deref() {
        None | Some(".") => ".",
        Some("/") => "/",
        Some(other) => {
            return Err(format!(
                "dimension_separator {other:?} (expected \".\" or \"/\")"
            ));
        }
    };
    Ok(ArrayMeta {
        shape: zarray.shape,
        data_type,
        chunk_grid: ChunkGrid {
            configuration: ChunkGridConfig {
                chunk_shape: zarray.chunks,
            },
        },
        codecs,
        fill_value: zarray.fill_value,
        chunk_key_encoding: Some(json!({"name": "v2", "configuration": {"separator": separator}})),
    })
}

/// A NumPy type string such as `"<u2"`, as a Zarr v3 data type name and the
/// byte order its samples are stored in. One-byte types have no byte order.
/// A type with no v3 name keeps its NumPy spelling, so the import's refusal
/// names it as written.
fn data_type(dtype: &Value) -> Result<(String, Option<&'static str>), String> {
    let Some(text) = dtype.as_str() else {
        return Err(format!("dtype {dtype} is a structured type"));
    };
    let mut chars = text.chars();
    let endian = match chars.next() {
        Some('<') | Some('=') => Some("little"),
        Some('>') => Some("big"),
        Some('|') => None,
        _ => return Err(format!("dtype {text:?} has no byte order")),
    };
    let name = match chars.as_str() {
        "b1" => "bool",
        "u1" => "uint8",
        "u2" => "uint16",
        "u4" => "uint32",
        "u8" => "uint64",
        "i1" => "int8",
        "i2" => "int16",
        "i4" => "int32",
        "i8" => "int64",
        "f2" => "float16",
        "f4" => "float32",
        "f8" => "float64",
        _ => return Ok((text.to_string(), endian)),
    };
    let one_byte = matches!(name, "bool" | "uint8" | "int8");
    Ok((name.to_string(), if one_byte { None } else { endian }))
}

/// A numcodecs configuration, `{"id": ..., <settings>}`, as a Zarr v3 codec,
/// `{"name": ..., "configuration": {<settings>}}`.
fn codec(numcodec: &Value) -> Result<Value, String> {
    let mut settings = numcodec
        .as_object()
        .cloned()
        .ok_or_else(|| format!("codec {numcodec} is not an object"))?;
    let id = settings
        .remove("id")
        .and_then(|id| id.as_str().map(str::to_string))
        .ok_or_else(|| format!("codec {numcodec} has no 'id'"))?;
    Ok(json!({"name": id, "configuration": settings}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(zarray: Value) -> Result<ArrayMeta, String> {
        array_meta(zarray.to_string().as_bytes())
    }

    fn zarray(overrides: Value) -> Value {
        let mut base = json!({
            "zarr_format": 2,
            "shape": [2, 40, 40],
            "chunks": [1, 8, 8],
            "dtype": "<u2",
            "compressor": {"id": "blosc", "cname": "lz4", "clevel": 5, "shuffle": 1, "blocksize": 0},
            "fill_value": 0,
            "order": "C",
            "filters": null,
            "dimension_separator": "/"
        });
        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    }

    #[test]
    fn a_c_order_array_becomes_bytes_and_its_compressor() {
        let meta = meta(zarray(json!({}))).unwrap();
        assert_eq!(meta.shape, [2, 40, 40]);
        assert_eq!(meta.data_type, "uint16");
        assert_eq!(meta.chunk_grid.configuration.chunk_shape, [1, 8, 8]);
        assert_eq!(
            meta.codecs,
            [
                json!({"name": "bytes", "configuration": {"endian": "little"}}),
                json!({"name": "blosc", "configuration": {"cname": "lz4", "clevel": 5, "shuffle": 1, "blocksize": 0}}),
            ]
        );
        assert_eq!(
            meta.chunk_key_encoding,
            Some(json!({"name": "v2", "configuration": {"separator": "/"}}))
        );
    }

    #[test]
    fn fortran_order_and_big_endian_become_a_transpose_and_the_byte_order() {
        let meta = meta(zarray(
            json!({"order": "F", "dtype": ">f4", "compressor": null}),
        ))
        .unwrap();
        assert_eq!(meta.data_type, "float32");
        assert_eq!(
            meta.codecs,
            [
                json!({"name": "transpose", "configuration": {"order": [2, 1, 0]}}),
                json!({"name": "bytes", "configuration": {"endian": "big"}}),
            ]
        );
    }

    #[test]
    fn filters_run_before_the_compressor() {
        let meta = meta(zarray(json!({
            "dtype": "|u1",
            "filters": [{"id": "crc32c"}],
            "compressor": {"id": "zstd", "level": 3}
        })))
        .unwrap();
        assert_eq!(meta.data_type, "uint8");
        assert_eq!(
            meta.codecs,
            [
                json!({"name": "bytes"}),
                json!({"name": "crc32c", "configuration": {}}),
                json!({"name": "zstd", "configuration": {"level": 3}}),
            ]
        );
    }

    #[test]
    fn the_separator_defaults_to_a_dot() {
        let mut zarray = zarray(json!({}));
        zarray
            .as_object_mut()
            .unwrap()
            .remove("dimension_separator");
        assert_eq!(
            meta(zarray).unwrap().chunk_key_encoding,
            Some(json!({"name": "v2", "configuration": {"separator": "."}}))
        );
    }

    #[test]
    fn an_unmapped_numpy_type_keeps_its_spelling() {
        assert_eq!(
            meta(zarray(json!({"dtype": "<M8[ns]"}))).unwrap().data_type,
            "<M8[ns]"
        );
    }

    #[test]
    fn malformed_metadata_is_refused_with_what_was_wrong() {
        for (overrides, expected) in [
            (json!({"zarr_format": 3}), "zarr_format 3"),
            (json!({"chunks": [8, 8]}), "different numbers of axes"),
            (json!({"order": "K"}), "\"K\""),
            (json!({"dimension_separator": "-"}), "\"-\""),
            (json!({"dtype": [["a", "<u2"]]}), "structured"),
            (json!({"compressor": {"level": 1}}), "no 'id'"),
        ] {
            let err = meta(zarray(overrides.clone())).unwrap_err();
            assert!(err.contains(expected), "{overrides}: {err}");
        }
    }
}
