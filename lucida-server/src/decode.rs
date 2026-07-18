//! Storage-compression decode helpers.
//!
//! Shared by [`crate::handler::serve_chunk_from_store`] and the proxy
//! generator so both paths use the same lz4/zstd/blosc handling.
//!
//! The compression *types* live in [`lucida_store::codec`] because
//! that's where the import-time codec-chain validator runs. This module
//! owns the actual decompression logic that needs the `zstd` /
//! `lz4_flex` crate dependencies, which `lucida-store` deliberately
//! does not pull in.

pub mod blosc;

use lucida_protocol::{FailureCode, FailureDescriptor};
pub use lucida_store::codec::StorageCompression;
use lucida_store::layout::MAX_DECODED_CHUNK_BYTES;
use std::io::Read;

/// Errors decoding compressed storage bytes back to raw voxel bytes.
#[derive(thiserror::Error, Debug)]
pub enum DecodeError {
    #[error("decoded size {expected} exceeds hard limit {limit}")]
    SizeLimit { expected: usize, limit: usize },
    #[error("decoded size mismatch: expected {expected}, got {actual}")]
    SizeMismatch { expected: usize, actual: usize },
    #[error("malformed {codec} header: {message}")]
    Header {
        codec: &'static str,
        message: &'static str,
    },
    #[error("lz4 decode failed: {0}")]
    Lz4(String),
    #[error("zstd decode failed: {0}")]
    Zstd(String),
    #[error("blosc decode failed: {0}")]
    Blosc(#[from] blosc::BloscError),
}

impl DecodeError {
    pub fn failure(&self) -> FailureDescriptor {
        let kind = match self {
            Self::SizeLimit { .. } => FailureCode::ResourceLimit,
            Self::SizeMismatch { .. }
            | Self::Header { .. }
            | Self::Lz4(_)
            | Self::Zstd(_)
            | Self::Blosc(_) => FailureCode::DecodeFailure,
        };
        FailureDescriptor::new(kind, false)
    }
}

/// Decode `storage_bytes` according to `compression`, returning the raw
/// voxel byte buffer.
///
/// - `None` → returns a copy of the input.
/// - `Lz4` → `lz4_flex::decompress_size_prepended`.
/// - `Zstd` → `zstd::stream::decode_all`.
/// - `Blosc(config)` → [`blosc::decode_blosc`] with the validated config.
pub fn decode_storage_bytes(
    storage_bytes: &[u8],
    compression: StorageCompression,
) -> Result<Vec<u8>, DecodeError> {
    match compression {
        StorageCompression::None => {
            decode_storage_bytes_exact(storage_bytes, StorageCompression::None, storage_bytes.len())
        }
        StorageCompression::Lz4 => {
            let expected = declared_u32_size(storage_bytes, "lz4")?;
            decode_storage_bytes_exact(storage_bytes, StorageCompression::Lz4, expected)
        }
        StorageCompression::Zstd => decode_zstd_bounded(storage_bytes, MAX_DECODED_CHUNK_BYTES),
        StorageCompression::Blosc(config) => {
            let expected = declared_blosc_size(storage_bytes)?;
            decode_storage_bytes_exact(storage_bytes, StorageCompression::Blosc(config), expected)
        }
    }
}

/// Decode one storage chunk to its import-admitted exact byte size.
///
/// The expected size comes from checked shape × dtype arithmetic, never from
/// the compressed payload.  Header-bearing codecs must agree with it before
/// allocating, and streaming codecs are stopped after `expected + 1` bytes so
/// bombs and excess output are rejected with bounded memory.
pub fn decode_storage_bytes_exact(
    storage_bytes: &[u8],
    compression: StorageCompression,
    expected: usize,
) -> Result<Vec<u8>, DecodeError> {
    validate_expected(expected)?;
    let decoded = match compression {
        StorageCompression::None => {
            if storage_bytes.len() != expected {
                return Err(DecodeError::SizeMismatch {
                    expected,
                    actual: storage_bytes.len(),
                });
            }
            storage_bytes.to_vec()
        }
        StorageCompression::Lz4 => {
            let declared = declared_u32_size(storage_bytes, "lz4")?;
            if declared != expected {
                return Err(DecodeError::SizeMismatch {
                    expected,
                    actual: declared,
                });
            }
            lz4_flex::block::decompress(&storage_bytes[4..], expected)
                .map_err(|error| DecodeError::Lz4(error.to_string()))?
        }
        StorageCompression::Zstd => decode_zstd_bounded(storage_bytes, expected)?,
        StorageCompression::Blosc(config) => {
            let declared = declared_blosc_size(storage_bytes)?;
            if declared != expected {
                return Err(DecodeError::SizeMismatch {
                    expected,
                    actual: declared,
                });
            }
            blosc::decode_blosc(storage_bytes, &config).map_err(DecodeError::Blosc)?
        }
    };
    if decoded.len() != expected {
        return Err(DecodeError::SizeMismatch {
            expected,
            actual: decoded.len(),
        });
    }
    Ok(decoded)
}

fn validate_expected(expected: usize) -> Result<(), DecodeError> {
    if expected > MAX_DECODED_CHUNK_BYTES {
        return Err(DecodeError::SizeLimit {
            expected,
            limit: MAX_DECODED_CHUNK_BYTES,
        });
    }
    Ok(())
}

fn declared_u32_size(input: &[u8], codec: &'static str) -> Result<usize, DecodeError> {
    let header = input.get(..4).ok_or(DecodeError::Header {
        codec,
        message: "missing 4-byte decoded-size field",
    })?;
    Ok(u32::from_le_bytes(header.try_into().expect("four bytes")) as usize)
}

fn declared_blosc_size(input: &[u8]) -> Result<usize, DecodeError> {
    let header = input.get(4..8).ok_or(DecodeError::Header {
        codec: "blosc",
        message: "missing nbytes field",
    })?;
    Ok(u32::from_le_bytes(header.try_into().expect("four bytes")) as usize)
}

fn decode_zstd_bounded(input: &[u8], limit: usize) -> Result<Vec<u8>, DecodeError> {
    validate_expected(limit)?;
    let decoder = zstd::stream::read::Decoder::new(std::io::Cursor::new(input))
        .map_err(|error| DecodeError::Zstd(error.to_string()))?;
    let read_limit = limit.checked_add(1).ok_or(DecodeError::SizeLimit {
        expected: limit,
        limit: MAX_DECODED_CHUNK_BYTES,
    })?;
    let mut output = Vec::with_capacity(limit.min(1024 * 1024));
    decoder
        .take(read_limit as u64)
        .read_to_end(&mut output)
        .map_err(|error| DecodeError::Zstd(error.to_string()))?;
    if output.len() > limit {
        return Err(DecodeError::SizeLimit {
            expected: output.len(),
            limit,
        });
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_pass_through() {
        let raw = vec![1u8, 2, 3, 4, 5];
        let out = decode_storage_bytes(&raw, StorageCompression::None).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn lz4_round_trip() {
        let raw = vec![42u8; 1024];
        let compressed = lz4_flex::compress_prepend_size(&raw);
        let out = decode_storage_bytes(&compressed, StorageCompression::Lz4).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn zstd_round_trip() {
        let raw = vec![7u8; 1024];
        let compressed = zstd::encode_all(std::io::Cursor::new(&raw), 0).unwrap();
        let out = decode_storage_bytes(&compressed, StorageCompression::Zstd).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn lz4_bad_input_errors() {
        let bogus = vec![0u8, 0, 0, 0, 1, 2, 3];
        let result = decode_storage_bytes(&bogus, StorageCompression::Lz4);
        assert!(result.is_err());
    }

    #[test]
    fn exact_decoders_reject_short_excess_and_header_disagreement() {
        assert!(matches!(
            decode_storage_bytes_exact(&[1, 2], StorageCompression::None, 3),
            Err(DecodeError::SizeMismatch { .. })
        ));
        assert!(matches!(
            decode_storage_bytes_exact(&[1, 2, 3, 4], StorageCompression::None, 3),
            Err(DecodeError::SizeMismatch { .. })
        ));

        let compressed = lz4_flex::compress_prepend_size(&[9u8; 32]);
        assert!(matches!(
            decode_storage_bytes_exact(&compressed, StorageCompression::Lz4, 31),
            Err(DecodeError::SizeMismatch { .. })
        ));

        let short_zstd = zstd::encode_all(std::io::Cursor::new([5u8; 8]), 0).unwrap();
        assert!(matches!(
            decode_storage_bytes_exact(&short_zstd, StorageCompression::Zstd, 16),
            Err(DecodeError::SizeMismatch { .. })
        ));
    }

    #[test]
    fn header_codecs_reject_truncated_headers_before_allocation() {
        assert!(matches!(
            decode_storage_bytes_exact(&[1, 2, 3], StorageCompression::Lz4, 16),
            Err(DecodeError::Header { codec: "lz4", .. })
        ));
        assert!(matches!(
            decode_storage_bytes_exact(
                &[2, 1, 0, 2, 16, 0, 0],
                StorageCompression::Blosc(lucida_store::codec::BloscConfig {
                    typesize: 2,
                    cname: lucida_store::codec::BloscCompressor::Zstd,
                    shuffle: lucida_store::codec::BloscShuffle::None,
                }),
                16,
            ),
            Err(DecodeError::Header { codec: "blosc", .. })
        ));
    }

    #[test]
    fn zstd_output_is_bounded_and_exact() {
        let raw = vec![3u8; 4096];
        let compressed = zstd::encode_all(std::io::Cursor::new(&raw), 0).unwrap();
        assert!(matches!(
            decode_storage_bytes_exact(&compressed, StorageCompression::Zstd, 1024),
            Err(DecodeError::SizeLimit { .. })
        ));
        assert_eq!(
            decode_storage_bytes_exact(&compressed, StorageCompression::Zstd, raw.len()).unwrap(),
            raw
        );
    }

    #[test]
    fn expected_size_above_global_ceiling_is_rejected_before_decode() {
        assert!(matches!(
            decode_storage_bytes_exact(&[], StorageCompression::None, MAX_DECODED_CHUNK_BYTES + 1),
            Err(DecodeError::SizeLimit { .. })
        ));
    }
}
