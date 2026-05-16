//! Storage-codec types and import-time codec-chain validation.
//!
//! Hosts the codec definitions so the import pipeline can run strict
//! validation over the codec chain before the binding ever reaches the
//! chunk-fetch path.
//!
//! The actual decompression implementations live in
//! [`lucida_server::decode`] because they pull in `zstd` / `lz4_flex` /
//! Blosc1, which `lucida-store` deliberately does not depend on. The types
//! here are pure data and travel through `ImageBindingSeed` so the resolver
//! can dispatch on them without re-parsing the codec chain.
//!
//! Validation behavior (see [`parse_codec_chain`]):
//! - Length 1 (`[bytes(little)]`) → [`StorageCompression::None`].
//! - Length 2 (`[bytes(little), compressor]`) → matching variant.
//! - Anything else (empty chain, length > 2, missing `bytes`, `endian: big`,
//!   missing `endian`, unknown second-codec name, blosc with unsupported
//!   `cname`/`shuffle`/`typesize`, blosc with missing config) is rejected
//!   with a [`StoreError::Metadata`] whose message names the offending value
//!   so the operator can find it in their OME-Zarr metadata.

use serde::{Deserialize, Serialize};

use crate::backend::StoreError;

/// What storage compression an image uses (detected at import from the codec
/// chain). Pinned-axis byte slicing is handled separately via
/// [`crate::layout::ChunkByteLayout`]; this enum only describes how to turn
/// the on-disk bytes back into raw voxel bytes.
///
/// `Blosc` carries a validated [`BloscConfig`] so the decoder can cross-check
/// the on-disk header (typesize, shuffle, compressor code) against what the
/// codec chain promised.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StorageCompression {
    None,
    Lz4,
    Zstd,
    Blosc(BloscConfig),
}

/// Subset of the Blosc1 configuration we accept. Matches what
/// [`lucida_server::decode::blosc::decode_blosc`] can decompress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BloscConfig {
    pub typesize: u8,
    pub cname: BloscCompressor,
    pub shuffle: BloscShuffle,
}

/// Inner compressor for Blosc1. Today only `zstd` is supported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BloscCompressor {
    Zstd,
}

/// Blosc1 shuffle filter. Matches the Blosc1 header flag bits we recognize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BloscShuffle {
    None,
    Byte,
    Bit,
}

/// Validate a Zarr v3 codec chain and return the corresponding
/// [`StorageCompression`].
///
/// Rules (see module docs for context):
/// - **Length 1**: must be `[bytes]` with `endian: "little"` →
///   [`StorageCompression::None`].
/// - **Length 2**: must be `[bytes(little), <compressor>]`. The compressor is
///   one of `lz4` / `numcodecs/lz4` / `zstd` / `numcodecs/zstd` / `blosc` with
///   a validated config.
/// - All other shapes are rejected with a [`StoreError::Metadata`] whose
///   message contains the offending value verbatim.
pub fn parse_codec_chain(codecs: &[serde_json::Value]) -> Result<StorageCompression, StoreError> {
    if codecs.is_empty() {
        return Err(StoreError::Metadata(
            "storage codec chain is empty (expected [bytes] or [bytes, compressor])".into(),
        ));
    }
    if codecs.len() > 2 {
        return Err(StoreError::Metadata(format!(
            "storage codec chain too long: got {} codecs (expected 1 or 2)",
            codecs.len(),
        )));
    }

    // First codec must be `bytes` with `endian: "little"`.
    let first = &codecs[0];
    let first_name = first.get("name").and_then(|n| n.as_str()).ok_or_else(|| {
        StoreError::Metadata("first storage codec missing 'name' field (expected 'bytes')".into())
    })?;
    if first_name != "bytes" {
        return Err(StoreError::Metadata(format!(
            "first storage codec must be 'bytes', got '{first_name}'",
        )));
    }
    let first_config = first.get("configuration").ok_or_else(|| {
        StoreError::Metadata(
            "bytes codec missing 'configuration' object (need endian: little)".into(),
        )
    })?;
    let endian = first_config
        .get("endian")
        .and_then(|e| e.as_str())
        .ok_or_else(|| StoreError::Metadata("bytes codec missing 'endian' configuration".into()))?;
    if endian != "little" {
        return Err(StoreError::Metadata(format!(
            "bytes codec endian must be 'little', got '{endian}'",
        )));
    }

    if codecs.len() == 1 {
        return Ok(StorageCompression::None);
    }

    // Second codec is a compressor.
    let second = &codecs[1];
    let second_name = second.get("name").and_then(|n| n.as_str()).ok_or_else(|| {
        StoreError::Metadata(
            "second storage codec missing 'name' field (expected lz4/zstd/blosc)".into(),
        )
    })?;
    match second_name {
        "lz4" | "numcodecs/lz4" => Ok(StorageCompression::Lz4),
        "zstd" | "numcodecs/zstd" => Ok(StorageCompression::Zstd),
        "blosc" => {
            let cfg = second.get("configuration").ok_or_else(|| {
                StoreError::Metadata(
                    "blosc codec missing 'configuration' object (need cname/shuffle/typesize)"
                        .into(),
                )
            })?;
            let blosc = parse_blosc_config(cfg)?;
            Ok(StorageCompression::Blosc(blosc))
        }
        other => Err(StoreError::Metadata(format!(
            "unsupported codec '{other}' in storage chain (supported: lz4, zstd, blosc)",
        ))),
    }
}

/// Validate a blosc codec's `configuration` object against the supported
/// subset. Each error message includes the offending value verbatim so the
/// caller can find it in their OME-Zarr metadata.
fn parse_blosc_config(cfg: &serde_json::Value) -> Result<BloscConfig, StoreError> {
    let cname = cfg
        .get("cname")
        .and_then(|c| c.as_str())
        .ok_or_else(|| StoreError::Metadata("blosc configuration missing 'cname' field".into()))?;
    let shuffle_str = cfg.get("shuffle").and_then(|s| s.as_str()).ok_or_else(|| {
        StoreError::Metadata("blosc configuration missing 'shuffle' field".into())
    })?;
    let typesize_raw = cfg
        .get("typesize")
        .and_then(|t| t.as_u64())
        .ok_or_else(|| {
            StoreError::Metadata("blosc configuration missing 'typesize' field".into())
        })?;

    let cname = match cname {
        "zstd" => BloscCompressor::Zstd,
        other => {
            return Err(StoreError::Metadata(format!(
                "blosc cname '{other}' not supported (only 'zstd')",
            )));
        }
    };
    let shuffle = match shuffle_str {
        "noshuffle" => BloscShuffle::None,
        "shuffle" => BloscShuffle::Byte,
        "bitshuffle" => BloscShuffle::Bit,
        other => {
            return Err(StoreError::Metadata(format!(
                "blosc shuffle '{other}' not supported (use noshuffle, shuffle, or bitshuffle)",
            )));
        }
    };
    let typesize = match typesize_raw {
        1 | 2 | 4 => typesize_raw as u8,
        other => {
            return Err(StoreError::Metadata(format!(
                "blosc typesize {other} not supported (only 1, 2, or 4)",
            )));
        }
    };

    Ok(BloscConfig {
        typesize,
        cname,
        shuffle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bytes_little() -> serde_json::Value {
        json!({"name": "bytes", "configuration": {"endian": "little"}})
    }

    // ---------------------------------------------------------------------
    // Accept matrix
    // ---------------------------------------------------------------------

    #[test]
    fn accepts_bytes_only_as_none() {
        let chain = vec![bytes_little()];
        assert_eq!(parse_codec_chain(&chain).unwrap(), StorageCompression::None);
    }

    #[test]
    fn accepts_lz4() {
        let chain = vec![bytes_little(), json!({"name": "lz4"})];
        assert_eq!(parse_codec_chain(&chain).unwrap(), StorageCompression::Lz4);
    }

    #[test]
    fn accepts_numcodecs_lz4() {
        let chain = vec![bytes_little(), json!({"name": "numcodecs/lz4"})];
        assert_eq!(parse_codec_chain(&chain).unwrap(), StorageCompression::Lz4);
    }

    #[test]
    fn accepts_zstd() {
        let chain = vec![bytes_little(), json!({"name": "zstd"})];
        assert_eq!(parse_codec_chain(&chain).unwrap(), StorageCompression::Zstd);
    }

    #[test]
    fn accepts_numcodecs_zstd() {
        let chain = vec![bytes_little(), json!({"name": "numcodecs/zstd"})];
        assert_eq!(parse_codec_chain(&chain).unwrap(), StorageCompression::Zstd);
    }

    #[test]
    fn accepts_blosc_zstd_noshuffle_typesize_1() {
        let chain = vec![
            bytes_little(),
            json!({
                "name": "blosc",
                "configuration": {
                    "cname": "zstd",
                    "shuffle": "noshuffle",
                    "typesize": 1
                }
            }),
        ];
        let result = parse_codec_chain(&chain).unwrap();
        match result {
            StorageCompression::Blosc(cfg) => {
                assert_eq!(cfg.cname, BloscCompressor::Zstd);
                assert_eq!(cfg.shuffle, BloscShuffle::None);
                assert_eq!(cfg.typesize, 1);
            }
            other => panic!("expected Blosc, got {other:?}"),
        }
    }

    #[test]
    fn accepts_blosc_zstd_byteshuffle_typesize_2() {
        let chain = vec![
            bytes_little(),
            json!({
                "name": "blosc",
                "configuration": {
                    "cname": "zstd",
                    "shuffle": "shuffle",
                    "typesize": 2
                }
            }),
        ];
        let result = parse_codec_chain(&chain).unwrap();
        match result {
            StorageCompression::Blosc(cfg) => {
                assert_eq!(cfg.cname, BloscCompressor::Zstd);
                assert_eq!(cfg.shuffle, BloscShuffle::Byte);
                assert_eq!(cfg.typesize, 2);
            }
            other => panic!("expected Blosc, got {other:?}"),
        }
    }

    #[test]
    fn accepts_blosc_zstd_bitshuffle_typesize_4() {
        let chain = vec![
            bytes_little(),
            json!({
                "name": "blosc",
                "configuration": {
                    "cname": "zstd",
                    "shuffle": "bitshuffle",
                    "typesize": 4,
                    "blocksize": 0,
                    "clevel": 3
                }
            }),
        ];
        let result = parse_codec_chain(&chain).unwrap();
        match result {
            StorageCompression::Blosc(cfg) => {
                assert_eq!(cfg.cname, BloscCompressor::Zstd);
                assert_eq!(cfg.shuffle, BloscShuffle::Bit);
                assert_eq!(cfg.typesize, 4);
            }
            other => panic!("expected Blosc, got {other:?}"),
        }
    }

    // ---------------------------------------------------------------------
    // Reject matrix — each test asserts the message contains the verbatim
    // offending value so the operator can find it in their metadata.
    // ---------------------------------------------------------------------

    #[test]
    fn rejects_empty_chain() {
        let err = parse_codec_chain(&[]).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("empty"), "expected 'empty' in: {msg}");
    }

    #[test]
    fn rejects_chain_too_long() {
        let chain = vec![
            bytes_little(),
            json!({"name": "lz4"}),
            json!({"name": "zstd"}),
        ];
        let err = parse_codec_chain(&chain).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("too long") || msg.contains('3'),
            "expected length error in: {msg}",
        );
    }

    #[test]
    fn rejects_missing_bytes_codec() {
        let chain = vec![json!({"name": "lz4"})];
        let err = parse_codec_chain(&chain).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("bytes"), "expected 'bytes' in: {msg}");
    }

    #[test]
    fn rejects_bytes_with_big_endian() {
        let chain = vec![json!({"name": "bytes", "configuration": {"endian": "big"}})];
        let err = parse_codec_chain(&chain).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("big"), "expected 'big' in: {msg}");
    }

    #[test]
    fn rejects_bytes_missing_endian() {
        let chain = vec![json!({"name": "bytes", "configuration": {}})];
        let err = parse_codec_chain(&chain).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("endian"), "expected 'endian' in: {msg}");
    }

    #[test]
    fn rejects_unknown_second_codec_name() {
        let chain = vec![bytes_little(), json!({"name": "gzip"})];
        let err = parse_codec_chain(&chain).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("gzip"), "expected 'gzip' in: {msg}");
    }

    #[test]
    fn rejects_blosc_with_lz4_cname() {
        let chain = vec![
            bytes_little(),
            json!({
                "name": "blosc",
                "configuration": {
                    "cname": "lz4",
                    "shuffle": "bitshuffle",
                    "typesize": 2
                }
            }),
        ];
        let err = parse_codec_chain(&chain).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("lz4"), "expected 'lz4' in: {msg}");
    }

    #[test]
    fn rejects_blosc_with_weirdshuffle() {
        let chain = vec![
            bytes_little(),
            json!({
                "name": "blosc",
                "configuration": {
                    "cname": "zstd",
                    "shuffle": "weirdshuffle",
                    "typesize": 2
                }
            }),
        ];
        let err = parse_codec_chain(&chain).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("weirdshuffle"),
            "expected 'weirdshuffle' in: {msg}"
        );
    }

    #[test]
    fn rejects_blosc_with_typesize_8() {
        let chain = vec![
            bytes_little(),
            json!({
                "name": "blosc",
                "configuration": {
                    "cname": "zstd",
                    "shuffle": "bitshuffle",
                    "typesize": 8
                }
            }),
        ];
        let err = parse_codec_chain(&chain).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains('8'), "expected '8' in: {msg}");
    }

    #[test]
    fn rejects_blosc_with_missing_configuration() {
        let chain = vec![bytes_little(), json!({"name": "blosc"})];
        let err = parse_codec_chain(&chain).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("blosc") && (msg.contains("configuration") || msg.contains("missing")),
            "expected blosc-config error in: {msg}",
        );
    }
}
