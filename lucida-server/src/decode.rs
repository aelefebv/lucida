//! Storage-compression decode for [`crate::chunk_read::read_chunk`], so
//! every served chunk gets the same lz4/zstd/blosc handling.
//!
//! The compression types live in [`lucida_store::codec`], where import
//! validates the codec chain. The decompression lives here because
//! `lucida-store` deliberately does not depend on `zstd` or `lz4_flex`.

pub mod blosc;

use std::io::Read;

use lucida_protocol::ChunkFailureKind;
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
    /// The bytes decoded, but not to the size the stored chunk shape holds,
    /// so they describe some other chunk shape than the binding does.
    #[error("decoded {actual} bytes where the stored chunk shape holds {expected}")]
    WrongSize { expected: usize, actual: usize },
    /// The stream decodes, or says it decodes, to more bytes than the
    /// stored chunk shape holds. Decoding stops at the limit.
    #[error("the chunk decodes to more than the {limit} bytes its stored chunk shape holds")]
    TooLarge { limit: usize },
}

impl DecodeError {
    /// Which of the stored bytes' failures this is, as a client is told it.
    pub fn failure_kind(&self) -> ChunkFailureKind {
        use blosc::BloscError;
        match self {
            DecodeError::WrongSize { .. }
            | DecodeError::TooLarge { .. }
            | DecodeError::Blosc(
                BloscError::TooLarge { .. }
                | BloscError::BlockTooLarge { .. }
                | BloscError::BlockSizeMismatch { .. }
                | BloscError::NotElementAligned { .. },
            ) => ChunkFailureKind::WrongSize,
            DecodeError::Blosc(
                BloscError::UnsupportedVersion(_)
                | BloscError::UnsupportedCompressor { .. }
                | BloscError::TypesizeMismatch { .. }
                | BloscError::ShuffleMismatch { .. },
            ) => ChunkFailureKind::UnsupportedCodec,
            DecodeError::Lz4(_)
            | DecodeError::Zstd(_)
            | DecodeError::Blosc(
                BloscError::HeaderTruncated(_)
                | BloscError::InputTruncated { .. }
                | BloscError::ZstdDecode { .. },
            ) => ChunkFailureKind::CorruptChunk,
        }
    }
}

/// Decode `storage_bytes` according to `compression`, returning the raw
/// voxel byte buffer, and refuse any stream that decodes to more than
/// `max_len` bytes before it allocates more.
///
/// - `None` → returns a copy of the input.
/// - `Lz4` → the size-prepended lz4 block format.
/// - `Zstd` → a zstd stream, possibly of several frames.
/// - `Blosc(config)` → [`blosc::decode_blosc`] with the validated config.
pub fn decode_storage_bytes(
    storage_bytes: &[u8],
    compression: StorageCompression,
    max_len: usize,
) -> Result<Vec<u8>, DecodeError> {
    match compression {
        StorageCompression::None => {
            if storage_bytes.len() > max_len {
                return Err(DecodeError::TooLarge { limit: max_len });
            }
            Ok(storage_bytes.to_vec())
        }
        StorageCompression::Lz4 => {
            let (len, block) = lz4_flex::block::uncompressed_size(storage_bytes)
                .map_err(|e| DecodeError::Lz4(e.to_string()))?;
            if len > max_len {
                return Err(DecodeError::TooLarge { limit: max_len });
            }
            lz4_flex::block::decompress(block, len).map_err(|e| DecodeError::Lz4(e.to_string()))
        }
        StorageCompression::Zstd => {
            decode_zstd_bounded(storage_bytes, max_len).map_err(|e| match e {
                BoundedError::TooLarge => DecodeError::TooLarge { limit: max_len },
                BoundedError::Io(e) => DecodeError::Zstd(e.to_string()),
            })
        }
        StorageCompression::Blosc(config) => {
            blosc::decode_blosc(storage_bytes, &config, max_len).map_err(DecodeError::Blosc)
        }
    }
}

/// Why a bounded zstd decode stopped.
#[derive(Debug)]
pub(crate) enum BoundedError {
    TooLarge,
    Io(std::io::Error),
}

/// Decode a zstd stream of any number of frames, stopping one byte past
/// `max_len` so a stream that decodes larger is refused without being
/// held whole.
pub(crate) fn decode_zstd_bounded(input: &[u8], max_len: usize) -> Result<Vec<u8>, BoundedError> {
    let decoder = zstd::stream::read::Decoder::new(input).map_err(BoundedError::Io)?;
    let mut out = Vec::new();
    decoder
        .take((max_len as u64).saturating_add(1))
        .read_to_end(&mut out)
        .map_err(BoundedError::Io)?;
    if out.len() > max_len {
        return Err(BoundedError::TooLarge);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_pass_through() {
        let raw = vec![1u8, 2, 3, 4, 5];
        let out = decode_storage_bytes(&raw, StorageCompression::None, raw.len()).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn lz4_round_trip() {
        let raw = vec![42u8; 1024];
        let compressed = lz4_flex::compress_prepend_size(&raw);
        let out = decode_storage_bytes(&compressed, StorageCompression::Lz4, 1024).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn zstd_round_trip() {
        let raw = vec![7u8; 1024];
        let compressed = zstd::encode_all(std::io::Cursor::new(&raw), 0).unwrap();
        let out = decode_storage_bytes(&compressed, StorageCompression::Zstd, 1024).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn zstd_reads_every_frame() {
        let mut compressed = zstd::encode_all(std::io::Cursor::new(&[1u8; 8][..]), 0).unwrap();
        compressed.extend(zstd::encode_all(std::io::Cursor::new(&[2u8; 8][..]), 0).unwrap());
        let out = decode_storage_bytes(&compressed, StorageCompression::Zstd, 16).unwrap();
        assert_eq!(out, [[1u8; 8], [2u8; 8]].concat());
    }

    #[test]
    fn lz4_bad_input_errors() {
        let bogus = vec![0u8, 0, 0, 0, 1, 2, 3];
        let result = decode_storage_bytes(&bogus, StorageCompression::Lz4, 1024);
        assert!(result.is_err());
    }

    /// A small stream that expands far past the chunk it should hold stops
    /// at the limit.
    #[test]
    fn a_stream_that_decodes_past_the_chunk_size_is_refused() {
        let limit = 4096;
        let raw = vec![0u8; 16 * 1024 * 1024];

        let zstd = zstd::encode_all(std::io::Cursor::new(&raw), 19).unwrap();
        assert!(zstd.len() < limit);
        assert!(matches!(
            decode_storage_bytes(&zstd, StorageCompression::Zstd, limit),
            Err(DecodeError::TooLarge { limit: 4096 })
        ));

        let lz4 = lz4_flex::compress_prepend_size(&raw);
        assert!(matches!(
            decode_storage_bytes(&lz4, StorageCompression::Lz4, limit),
            Err(DecodeError::TooLarge { limit: 4096 })
        ));

        assert!(matches!(
            decode_storage_bytes(&raw[..limit + 1], StorageCompression::None, limit),
            Err(DecodeError::TooLarge { limit: 4096 })
        ));
    }

    /// An lz4 size prefix is refused before anything is allocated for it.
    #[test]
    fn an_lz4_size_prefix_past_the_chunk_size_is_refused() {
        let mut claim = u32::MAX.to_le_bytes().to_vec();
        claim.extend_from_slice(&[0x10, 0x00]);
        assert!(matches!(
            decode_storage_bytes(&claim, StorageCompression::Lz4, 1024),
            Err(DecodeError::TooLarge { limit: 1024 })
        ));
    }
}
