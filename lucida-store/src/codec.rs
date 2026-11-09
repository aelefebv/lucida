//! The codec registry: every storage codec lucida decodes, looked up by the
//! names Zarr v3 and numcodecs give it, and the chain a level's metadata
//! declares, validated once at import.
//!
//! The decoding lives in `lucida_core::chunk_codec`, which the server and the
//! page share, and the bytes-to-bytes codec types in
//! [`lucida_protocol::codec`], since a chunk frame names them. These types are
//! pure data that travel through `ImageBindingSeed`.
//! [`parse_codec_chain`] refuses a codec missing from [`REGISTRY`], or a chain
//! out of the order Zarr v3 fixes, with a [`StoreError::Metadata`] that names
//! the offending value.

use serde::{Deserialize, Serialize};

pub use lucida_protocol::codec::{BloscCompressor, BloscConfig, BloscShuffle, BytesCodec};

use crate::backend::StoreError;

/// How a level's stored chunk bytes decode back to the bytes the wire
/// carries: samples in little-endian byte order, in C order over the array's
/// own axes. Pinned-axis byte slicing happens after, through
/// [`crate::layout::ChunkByteLayout`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum StorageCompression {
    /// The stored bytes already are the wire's.
    None,
    /// A codec chain to undo, last codec first.
    Codecs(CodecChain),
}

impl StorageCompression {
    /// Little-endian samples of `sample_size` bytes behind one
    /// bytes-to-bytes codec: the `[bytes, compressor]` chain most writers
    /// emit.
    pub fn compressed(codec: BytesCodec, sample_size: u8) -> Self {
        StorageCompression::Codecs(CodecChain {
            array_to_array: Vec::new(),
            byte_order: ByteOrder::Little,
            sample_size,
            bytes_to_bytes: vec![codec],
        })
    }
}

/// A Zarr v3 codec chain in the order it was applied when the chunk was
/// written: array-to-array codecs, the one array-to-bytes codec, then
/// bytes-to-bytes codecs. Decoding runs it backwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodecChain {
    pub array_to_array: Vec<ArrayCodec>,
    /// The byte order the `bytes` codec wrote each sample in.
    pub byte_order: ByteOrder,
    /// Bytes per sample, the unit a byte swap and a transpose move.
    pub sample_size: u8,
    pub bytes_to_bytes: Vec<BytesCodec>,
}

/// An array-to-array codec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArrayCodec {
    /// Axis `i` of the encoded array is axis `order[i]` of the array it
    /// encodes.
    Transpose(Vec<usize>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ByteOrder {
    Little,
    Big,
}

/// What a level's chunks hold, which the codec configurations are checked
/// against.
#[derive(Debug, Clone, Copy)]
pub struct ChunkSpec {
    /// Bytes per sample of the array's data type.
    pub sample_size: u8,
    /// How many axes the chunk has.
    pub ndim: usize,
}

/// Where a codec sits in a chain.
enum Stage {
    ArrayToArray(ArrayCodec),
    ArrayToBytes(ByteOrder),
    BytesToBytes(BytesCodec),
}

type ParseCodec = fn(Option<&serde_json::Value>, ChunkSpec) -> Result<Stage, StoreError>;

/// Every codec lucida decodes, under each name Zarr v3 or numcodecs gives it.
/// Zarr v2 compressors and filters reach it by their numcodecs `id`. A name
/// missing here is refused at import as an unsupported codec.
const REGISTRY: &[(&str, ParseCodec)] = &[
    ("transpose", parse_transpose),
    ("bytes", parse_bytes),
    ("gzip", |_, _| Ok(Stage::BytesToBytes(BytesCodec::Gzip))),
    ("numcodecs.gzip", |_, _| {
        Ok(Stage::BytesToBytes(BytesCodec::Gzip))
    }),
    ("zlib", |_, _| Ok(Stage::BytesToBytes(BytesCodec::Zlib))),
    ("numcodecs.zlib", |_, _| {
        Ok(Stage::BytesToBytes(BytesCodec::Zlib))
    }),
    ("zstd", |_, _| Ok(Stage::BytesToBytes(BytesCodec::Zstd))),
    ("numcodecs.zstd", |_, _| {
        Ok(Stage::BytesToBytes(BytesCodec::Zstd))
    }),
    ("numcodecs/zstd", |_, _| {
        Ok(Stage::BytesToBytes(BytesCodec::Zstd))
    }),
    ("lz4", |_, _| Ok(Stage::BytesToBytes(BytesCodec::Lz4))),
    ("numcodecs.lz4", |_, _| {
        Ok(Stage::BytesToBytes(BytesCodec::Lz4))
    }),
    ("numcodecs/lz4", |_, _| {
        Ok(Stage::BytesToBytes(BytesCodec::Lz4))
    }),
    ("blosc", parse_blosc),
    ("numcodecs.blosc", parse_blosc),
    ("crc32c", parse_crc32c),
    ("numcodecs.crc32c", parse_crc32c),
];

/// The codec name Zarr v3 gives the sharding codec, which
/// [`crate::shard::ShardLayout`] reads before this chain is parsed.
const SHARDING_CODEC: &str = "sharding_indexed";

fn registered_names() -> String {
    REGISTRY
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| !name.contains(['.', '/']))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Validate a Zarr v3 codec chain against [`REGISTRY`] and the order Zarr v3
/// fixes: any array-to-array codecs, exactly one array-to-bytes codec, then
/// any bytes-to-bytes codecs.
///
/// A chain that changes nothing, `[bytes]` over little-endian or one-byte
/// samples, is [`StorageCompression::None`], as is an identity transpose
/// in it.
pub fn parse_codec_chain(
    codecs: &[serde_json::Value],
    spec: ChunkSpec,
) -> Result<StorageCompression, StoreError> {
    let mut array_to_array = Vec::new();
    let mut byte_order = None;
    let mut bytes_to_bytes = Vec::new();
    for (index, codec) in codecs.iter().enumerate() {
        let name = codec.get("name").and_then(|n| n.as_str()).ok_or_else(|| {
            StoreError::unsupported_codec(format!("storage codec {index} has no 'name' field"))
        })?;
        if name == SHARDING_CODEC {
            return Err(StoreError::unsupported_codec(format!(
                "the {SHARDING_CODEC} codec is read only as the first and only codec of a level's chain",
            )));
        }
        let Some((_, parse)) = REGISTRY.iter().find(|(known, _)| *known == name) else {
            return Err(StoreError::unsupported_codec(format!(
                "unsupported codec '{name}' in storage chain (supported: {})",
                registered_names(),
            )));
        };
        let stage = parse(codec.get("configuration"), spec)
            .map_err(|e| e.in_context(format!("{name} codec")))?;
        match stage {
            Stage::ArrayToArray(codec) if byte_order.is_none() => array_to_array.push(codec),
            Stage::ArrayToBytes(order) if byte_order.is_none() => byte_order = Some(order),
            Stage::BytesToBytes(codec) if byte_order.is_some() => bytes_to_bytes.push(codec),
            Stage::ArrayToArray(_) | Stage::ArrayToBytes(_) => {
                return Err(StoreError::unsupported_codec(format!(
                    "codec '{name}' comes after the array-to-bytes codec; the chain is out of order",
                )));
            }
            Stage::BytesToBytes(_) => {
                return Err(StoreError::unsupported_codec(format!(
                    "codec '{name}' comes before the array-to-bytes codec (expected 'bytes' first)",
                )));
            }
        }
    }
    let Some(mut byte_order) = byte_order else {
        return Err(StoreError::unsupported_codec(
            "storage codec chain has no array-to-bytes codec (expected 'bytes')",
        ));
    };
    if spec.sample_size == 1 {
        byte_order = ByteOrder::Little;
    }
    array_to_array.retain(|codec| match codec {
        ArrayCodec::Transpose(order) => order.iter().enumerate().any(|(i, &axis)| i != axis),
    });
    if array_to_array.is_empty() && byte_order == ByteOrder::Little && bytes_to_bytes.is_empty() {
        return Ok(StorageCompression::None);
    }
    Ok(StorageCompression::Codecs(CodecChain {
        array_to_array,
        byte_order,
        sample_size: spec.sample_size,
        bytes_to_bytes,
    }))
}

fn parse_bytes(config: Option<&serde_json::Value>, spec: ChunkSpec) -> Result<Stage, StoreError> {
    let endian = config.and_then(|c| c.get("endian"));
    let order = match endian.map(|e| e.as_str()) {
        Some(Some("little")) => ByteOrder::Little,
        Some(Some("big")) => ByteOrder::Big,
        // One-byte samples have no byte order, and writers omit it there.
        None if spec.sample_size == 1 => ByteOrder::Little,
        None => {
            return Err(StoreError::unsupported_codec(format!(
                "missing 'endian' configuration for {}-byte samples",
                spec.sample_size,
            )));
        }
        Some(_) => {
            return Err(StoreError::unsupported_codec(format!(
                "endian {} not supported (use little or big)",
                endian.map(|e| e.to_string()).unwrap_or_default(),
            )));
        }
    };
    Ok(Stage::ArrayToBytes(order))
}

fn parse_transpose(
    config: Option<&serde_json::Value>,
    spec: ChunkSpec,
) -> Result<Stage, StoreError> {
    let order = config.and_then(|c| c.get("order")).ok_or_else(|| {
        StoreError::unsupported_codec("configuration missing 'order' (a permutation of the axes)")
    })?;
    let order: Vec<usize> = match order {
        // Early Zarr v3 drafts named the two memory orders.
        serde_json::Value::String(s) if s == "C" => (0..spec.ndim).collect(),
        serde_json::Value::String(s) if s == "F" => (0..spec.ndim).rev().collect(),
        serde_json::Value::Array(axes) => axes
            .iter()
            .map(|axis| axis.as_u64().and_then(|a| usize::try_from(a).ok()))
            .collect::<Option<_>>()
            .ok_or_else(|| {
                StoreError::unsupported_codec(format!(
                    "order {order} is not a list of axis indices"
                ))
            })?,
        other => {
            return Err(StoreError::unsupported_codec(format!(
                "order {other} is not a list of axis indices"
            )));
        }
    };
    let mut seen = vec![false; spec.ndim];
    let is_permutation = order.len() == spec.ndim
        && order
            .iter()
            .all(|&axis| axis < spec.ndim && !std::mem::replace(&mut seen[axis], true));
    if !is_permutation {
        return Err(StoreError::unsupported_codec(format!(
            "order {order:?} is not a permutation of the array's {} axes",
            spec.ndim,
        )));
    }
    Ok(Stage::ArrayToArray(ArrayCodec::Transpose(order)))
}

fn parse_crc32c(config: Option<&serde_json::Value>, _: ChunkSpec) -> Result<Stage, StoreError> {
    // numcodecs can put its checksum in front; Zarr v3 and numcodecs'
    // default put it after.
    match config.and_then(|c| c.get("location")).map(|l| l.as_str()) {
        None | Some(Some("end")) => Ok(Stage::BytesToBytes(BytesCodec::Crc32c)),
        Some(other) => Err(StoreError::unsupported_codec(format!(
            "location {} not supported (only 'end')",
            other.unwrap_or("?"),
        ))),
    }
}

/// Accepts both the Zarr v3 configuration, with `shuffle` named and
/// `typesize` given, and the numcodecs one, with `shuffle` as an integer and
/// the typesize left to the sample size.
fn parse_blosc(config: Option<&serde_json::Value>, spec: ChunkSpec) -> Result<Stage, StoreError> {
    let cfg = config.ok_or_else(|| {
        StoreError::unsupported_codec("missing 'configuration' object (need cname and shuffle)")
    })?;
    let cname = cfg
        .get("cname")
        .and_then(|c| c.as_str())
        .ok_or_else(|| StoreError::unsupported_codec("configuration missing 'cname' field"))?;
    let cname = match cname {
        "blosclz" => BloscCompressor::BloscLz,
        "lz4" => BloscCompressor::Lz4,
        "lz4hc" => BloscCompressor::Lz4hc,
        "zlib" => BloscCompressor::Zlib,
        "zstd" => BloscCompressor::Zstd,
        other => {
            return Err(StoreError::unsupported_codec(format!(
                "cname '{other}' not supported (use blosclz, lz4, lz4hc, zlib, or zstd)",
            )));
        }
    };
    let typesize = match cfg.get("typesize") {
        None | Some(serde_json::Value::Null) => spec.sample_size,
        Some(value) => match value.as_u64() {
            Some(t @ 1..=255) => t as u8,
            _ => {
                return Err(StoreError::unsupported_codec(format!(
                    "typesize {value} not supported (1 to 255)",
                )));
            }
        },
    };
    let shuffle = match cfg.get("shuffle") {
        None => {
            return Err(StoreError::unsupported_codec(
                "configuration missing 'shuffle' field",
            ));
        }
        Some(serde_json::Value::String(s)) => match s.as_str() {
            "noshuffle" => BloscShuffle::None,
            "shuffle" => BloscShuffle::Byte,
            "bitshuffle" => BloscShuffle::Bit,
            other => {
                return Err(StoreError::unsupported_codec(format!(
                    "shuffle '{other}' not supported (use noshuffle, shuffle, or bitshuffle)",
                )));
            }
        },
        Some(value) => match value.as_i64() {
            Some(0) => BloscShuffle::None,
            Some(1) => BloscShuffle::Byte,
            Some(2) => BloscShuffle::Bit,
            // numcodecs' automatic choice, made from the sample size.
            Some(-1) if typesize == 1 => BloscShuffle::Bit,
            Some(-1) => BloscShuffle::Byte,
            _ => {
                return Err(StoreError::unsupported_codec(format!(
                    "shuffle {value} not supported (use 0, 1, 2, or -1)",
                )));
            }
        },
    };
    Ok(Stage::BytesToBytes(BytesCodec::Blosc(BloscConfig {
        typesize,
        cname,
        shuffle,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const U16_2D: ChunkSpec = ChunkSpec {
        sample_size: 2,
        ndim: 2,
    };

    fn bytes_little() -> serde_json::Value {
        json!({"name": "bytes", "configuration": {"endian": "little"}})
    }

    fn parse(chain: &[serde_json::Value]) -> Result<StorageCompression, StoreError> {
        parse_codec_chain(chain, U16_2D)
    }

    fn chain(compression: StorageCompression) -> CodecChain {
        match compression {
            StorageCompression::Codecs(chain) => chain,
            StorageCompression::None => panic!("expected a codec chain"),
        }
    }

    fn error(chain: &[serde_json::Value]) -> String {
        let err = parse(chain).unwrap_err();
        assert!(
            matches!(
                err,
                StoreError::Metadata {
                    fault: crate::backend::MetadataFault::UnsupportedCodec,
                    ..
                }
            ),
            "{err}"
        );
        err.to_string()
    }

    #[test]
    fn bytes_alone_changes_nothing() {
        assert_eq!(parse(&[bytes_little()]).unwrap(), StorageCompression::None);
    }

    #[test]
    fn one_byte_samples_need_no_byte_order() {
        let spec = ChunkSpec {
            sample_size: 1,
            ndim: 2,
        };
        for bytes in [
            json!({"name": "bytes"}),
            json!({"name": "bytes", "configuration": {"endian": "big"}}),
        ] {
            assert_eq!(
                parse_codec_chain(&[bytes], spec).unwrap(),
                StorageCompression::None
            );
        }
    }

    #[test]
    fn every_registered_compressor_parses_after_bytes() {
        for (name, expected) in [
            ("gzip", BytesCodec::Gzip),
            ("zlib", BytesCodec::Zlib),
            ("zstd", BytesCodec::Zstd),
            ("numcodecs/zstd", BytesCodec::Zstd),
            ("lz4", BytesCodec::Lz4),
            ("numcodecs.lz4", BytesCodec::Lz4),
            ("crc32c", BytesCodec::Crc32c),
        ] {
            let parsed = chain(parse(&[bytes_little(), json!({"name": name})]).unwrap());
            assert_eq!(parsed.bytes_to_bytes, vec![expected], "{name}");
        }
    }

    #[test]
    fn a_long_chain_keeps_its_order() {
        let parsed = chain(
            parse(&[
                json!({"name": "transpose", "configuration": {"order": [1, 0]}}),
                json!({"name": "bytes", "configuration": {"endian": "big"}}),
                json!({"name": "gzip", "configuration": {"level": 5}}),
                json!({"name": "crc32c"}),
            ])
            .unwrap(),
        );
        assert_eq!(
            parsed.array_to_array,
            vec![ArrayCodec::Transpose(vec![1, 0])]
        );
        assert_eq!(parsed.byte_order, ByteOrder::Big);
        assert_eq!(parsed.sample_size, 2);
        assert_eq!(
            parsed.bytes_to_bytes,
            vec![BytesCodec::Gzip, BytesCodec::Crc32c]
        );
    }

    #[test]
    fn an_identity_transpose_is_dropped() {
        let chain = [
            json!({"name": "transpose", "configuration": {"order": [0, 1]}}),
            bytes_little(),
        ];
        assert_eq!(parse(&chain).unwrap(), StorageCompression::None);
    }

    #[test]
    fn the_memory_order_names_are_transposes() {
        let f = json!({"name": "transpose", "configuration": {"order": "F"}});
        let parsed = chain(parse(&[f, bytes_little()]).unwrap());
        assert_eq!(
            parsed.array_to_array,
            vec![ArrayCodec::Transpose(vec![1, 0])]
        );
    }

    #[test]
    fn blosc_takes_the_zarr_v3_configuration() {
        let parsed = chain(
            parse(&[
                bytes_little(),
                json!({"name": "blosc", "configuration": {
                    "cname": "lz4", "clevel": 5, "shuffle": "bitshuffle", "typesize": 2, "blocksize": 0
                }}),
            ])
            .unwrap(),
        );
        assert_eq!(
            parsed.bytes_to_bytes,
            vec![BytesCodec::Blosc(BloscConfig {
                typesize: 2,
                cname: BloscCompressor::Lz4,
                shuffle: BloscShuffle::Bit,
            })]
        );
    }

    #[test]
    fn blosc_takes_the_numcodecs_configuration() {
        for (shuffle, sample_size, expected) in [
            (0, 2, BloscShuffle::None),
            (1, 2, BloscShuffle::Byte),
            (2, 2, BloscShuffle::Bit),
            (-1, 2, BloscShuffle::Byte),
            (-1, 1, BloscShuffle::Bit),
        ] {
            let spec = ChunkSpec {
                sample_size,
                ndim: 2,
            };
            let parsed = parse_codec_chain(
                &[
                    json!({"name": "bytes", "configuration": {"endian": "little"}}),
                    json!({"name": "blosc", "configuration": {"cname": "blosclz", "clevel": 5, "shuffle": shuffle}}),
                ],
                spec,
            )
            .unwrap();
            assert_eq!(
                chain(parsed).bytes_to_bytes,
                vec![BytesCodec::Blosc(BloscConfig {
                    typesize: sample_size,
                    cname: BloscCompressor::BloscLz,
                    shuffle: expected,
                })],
                "shuffle {shuffle} over {sample_size}-byte samples",
            );
        }
    }

    // Each refusal names the value that caused it, so the operator can find
    // it in their metadata.
    #[test]
    fn an_unknown_codec_is_refused_by_name() {
        let msg = error(&[bytes_little(), json!({"name": "bz2"})]);
        assert!(msg.contains("'bz2'"), "{msg}");
        assert!(
            msg.contains("gzip"),
            "the message lists what is supported: {msg}"
        );
    }

    #[test]
    fn a_chain_without_bytes_is_refused() {
        assert!(error(&[]).contains("bytes"));
        assert!(error(&[json!({"name": "zstd"})]).contains("bytes"));
    }

    #[test]
    fn a_chain_out_of_order_is_refused() {
        let msg = error(&[
            bytes_little(),
            json!({"name": "transpose", "configuration": {"order": [1, 0]}}),
        ]);
        assert!(msg.contains("transpose"), "{msg}");
        let msg = error(&[bytes_little(), bytes_little()]);
        assert!(msg.contains("out of order"), "{msg}");
    }

    #[test]
    fn multi_byte_samples_need_a_byte_order() {
        let msg = error(&[json!({"name": "bytes", "configuration": {}})]);
        assert!(msg.contains("endian"), "{msg}");
        let msg = error(&[json!({"name": "bytes", "configuration": {"endian": "middle"}})]);
        assert!(msg.contains("middle"), "{msg}");
    }

    #[test]
    fn a_transpose_that_is_not_a_permutation_is_refused() {
        for order in [json!([0]), json!([0, 0]), json!([0, 2]), json!("Z")] {
            let msg = error(&[
                json!({"name": "transpose", "configuration": {"order": order}}),
                bytes_little(),
            ]);
            assert!(msg.contains("order"), "{msg}");
        }
    }

    #[test]
    fn sharding_inside_a_chain_is_refused() {
        let msg = error(&[bytes_little(), json!({"name": "sharding_indexed"})]);
        assert!(msg.contains("sharding_indexed"), "{msg}");
    }

    #[test]
    fn blosc_with_snappy_is_refused() {
        let msg = error(&[
            bytes_little(),
            json!({"name": "blosc", "configuration": {"cname": "snappy", "shuffle": "shuffle", "typesize": 2}}),
        ]);
        assert!(msg.contains("snappy"), "{msg}");
    }

    #[test]
    fn blosc_with_an_unknown_shuffle_is_refused() {
        let msg = error(&[
            bytes_little(),
            json!({"name": "blosc", "configuration": {"cname": "zstd", "shuffle": "weirdshuffle", "typesize": 2}}),
        ]);
        assert!(msg.contains("weirdshuffle"), "{msg}");
        let msg = error(&[
            bytes_little(),
            json!({"name": "blosc", "configuration": {"cname": "zstd", "shuffle": 7}}),
        ]);
        assert!(msg.contains('7'), "{msg}");
    }

    #[test]
    fn blosc_with_an_impossible_typesize_is_refused() {
        let msg = error(&[
            bytes_little(),
            json!({"name": "blosc", "configuration": {"cname": "zstd", "shuffle": "shuffle", "typesize": 300}}),
        ]);
        assert!(msg.contains("300"), "{msg}");
    }

    #[test]
    fn blosc_without_configuration_is_refused() {
        let msg = error(&[bytes_little(), json!({"name": "blosc"})]);
        assert!(
            msg.contains("blosc") && msg.contains("configuration"),
            "{msg}"
        );
    }

    #[test]
    fn crc32c_in_front_is_refused() {
        let msg = error(&[
            bytes_little(),
            json!({"name": "crc32c", "configuration": {"location": "start"}}),
        ]);
        assert!(msg.contains("start"), "{msg}");
    }
}
