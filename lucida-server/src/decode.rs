//! Storage-compression decode helpers.
//!
//! Factored out of [`crate::handler::serve_chunk_from_store`] (originally
//! at handler.rs lines 486-523) so the proxy generator can reuse the
//! same lz4/zstd/blosc handling.
//!
//! The compression *types* live in [`lucida_store::codec`] because that's
//! where the import-time codec-chain validator runs (PRD #447 Slice 2 /
//! issue #449). This module owns the actual decompression logic that needs
//! the `zstd` / `lz4_flex` crate dependencies, which `lucida-store`
//! deliberately does not pull in.

pub mod blosc;

pub use lucida_store::codec::StorageCompression;

/// Errors decoding compressed storage bytes back to raw voxel bytes.
#[derive(thiserror::Error, Debug)]
pub enum DecodeError {
    #[error("lz4 decode failed: {0}")]
    Lz4(String),
    #[error("zstd decode failed: {0}")]
    Zstd(String),
    #[error("blosc decode failed: {0}")]
    Blosc(#[from] blosc::BloscError),
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
        StorageCompression::None => Ok(storage_bytes.to_vec()),
        StorageCompression::Lz4 => lz4_flex::decompress_size_prepended(storage_bytes)
            .map_err(|e| DecodeError::Lz4(e.to_string())),
        StorageCompression::Zstd => zstd::stream::decode_all(std::io::Cursor::new(storage_bytes))
            .map_err(|e| DecodeError::Zstd(e.to_string())),
        StorageCompression::Blosc(config) => {
            blosc::decode_blosc(storage_bytes, &config).map_err(DecodeError::Blosc)
        }
    }
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
}
