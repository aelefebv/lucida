//! Bounded decoders for the bytes-to-bytes storage codecs, shared by the
//! server, which undoes a level's whole codec chain, and the page, which
//! decodes the chunks the server relays to it still encoded.
//!
//! Every codec decodes against a byte limit, so a stream that expands past
//! what the chunk holds is refused before it is held whole. A relayed chunk
//! is untrusted bytes, and the limit is what keeps a hostile or broken source
//! from making the page allocate without bound.

pub mod blosc;
mod blosclz;
mod zstd;

use lucida_protocol::ChunkFailureKind;
use lucida_protocol::codec::BytesCodec;
use miniz_oxide::inflate::TINFLStatus;

use self::zstd::decode_bounded as decode_zstd_bounded;
use crate::gzip::{self, GunzipError};

/// Errors decoding stored bytes back to the wire's.
#[derive(thiserror::Error, Debug)]
pub enum DecodeError {
    #[error("lz4 decode failed: {0}")]
    Lz4(String),
    #[error("zstd decode failed: {0}")]
    Zstd(String),
    #[error("gzip decode failed: {0}")]
    Gzip(String),
    #[error("zlib decode failed: {0}")]
    Zlib(String),
    #[error("blosc decode failed: {0}")]
    Blosc(#[from] blosc::BloscError),
    /// The bytes end in a crc32c checksum that does not match them.
    #[error("crc32c checksum {recorded:#010x} does not match the bytes ({computed:#010x})")]
    Checksum { recorded: u32, computed: u32 },
    /// Fewer bytes than the checksum they should end in.
    #[error("{0} bytes is too short to end in a crc32c checksum")]
    ChecksumTruncated(usize),
    /// The bytes decoded, but not to the size the stored chunk shape holds,
    /// so they describe some other chunk shape than the metadata does.
    #[error("decoded {actual} bytes where the stored chunk shape holds {expected}")]
    WrongSize { expected: usize, actual: usize },
    /// A transpose's axis order does not fit the stored chunk shape's rank,
    /// so the binding describes some other array than the chain does.
    #[error("transpose order {order:?} does not fit a chunk of {rank} axes")]
    WrongRank { order: Vec<usize>, rank: usize },
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
            | DecodeError::WrongRank { .. }
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
                | BloscError::CompressorMismatch { .. }
                | BloscError::TypesizeMismatch { .. }
                | BloscError::ShuffleMismatch { .. },
            ) => ChunkFailureKind::UnsupportedCodec,
            DecodeError::Lz4(_)
            | DecodeError::Zstd(_)
            | DecodeError::Gzip(_)
            | DecodeError::Zlib(_)
            | DecodeError::Checksum { .. }
            | DecodeError::ChecksumTruncated(_)
            | DecodeError::Blosc(
                BloscError::HeaderTruncated(_)
                | BloscError::InputTruncated { .. }
                | BloscError::Decompress { .. },
            ) => ChunkFailureKind::CorruptChunk,
        }
    }
}

/// A chunk relayed in the codecs it was stored in, decoded to exactly `len`
/// bytes, the size its level's metadata gives one chunk. Anything else is an
/// error, never a buffer.
pub fn decode_relayed(
    codecs: &[BytesCodec],
    payload: &[u8],
    len: usize,
) -> Result<Vec<u8>, DecodeError> {
    let decoded = decode_bytes_codecs(codecs, payload, len)?;
    if decoded.len() != len {
        return Err(DecodeError::WrongSize {
            expected: len,
            actual: decoded.len(),
        });
    }
    Ok(decoded)
}

/// Undo bytes-to-bytes `codecs`, given in the order they were applied, last
/// first. Refuses any stream that decodes to more than `max_len` bytes before
/// it allocates more.
pub fn decode_bytes_codecs(
    codecs: &[BytesCodec],
    stored: &[u8],
    max_len: usize,
) -> Result<Vec<u8>, DecodeError> {
    // Each codec decodes to at most what the codecs before it can have
    // written for `max_len` bytes of samples.
    let mut limits = Vec::with_capacity(codecs.len());
    let mut limit = max_len;
    for codec in codecs {
        limits.push(limit);
        limit = encoded_bound(*codec, limit);
    }
    let mut bytes: Option<Vec<u8>> = None;
    for (codec, limit) in codecs.iter().zip(limits).rev() {
        let input = bytes.as_deref().unwrap_or(stored);
        bytes = Some(decode_bytes_codec(*codec, input, limit)?);
    }
    match bytes {
        Some(bytes) => Ok(bytes),
        None if stored.len() > max_len => Err(DecodeError::TooLarge { limit: max_len }),
        None => Ok(stored.to_vec()),
    }
}

/// The most bytes `codec` can write for `len` bytes of input. No compressor
/// here grows its input by more than half again plus a few KiB, so the bound
/// is loose; it only has to stop a stream that expands without limit.
fn encoded_bound(codec: BytesCodec, len: usize) -> usize {
    match codec {
        BytesCodec::Crc32c => len.saturating_add(4),
        BytesCodec::Gzip
        | BytesCodec::Zlib
        | BytesCodec::Zstd
        | BytesCodec::Lz4
        | BytesCodec::Blosc(_) => len.saturating_add(len / 2).saturating_add(4096),
    }
}

fn decode_bytes_codec(
    codec: BytesCodec,
    input: &[u8],
    max_len: usize,
) -> Result<Vec<u8>, DecodeError> {
    let too_large = DecodeError::TooLarge { limit: max_len };
    match codec {
        BytesCodec::Lz4 => {
            let (len, block) = lz4_flex::block::uncompressed_size(input)
                .map_err(|e| DecodeError::Lz4(e.to_string()))?;
            if len > max_len {
                return Err(too_large);
            }
            lz4_flex::block::decompress(block, len).map_err(|e| DecodeError::Lz4(e.to_string()))
        }
        BytesCodec::Zstd => decode_zstd_bounded(input, max_len).map_err(|e| match e {
            BoundedError::TooLarge => too_large,
            BoundedError::Corrupt(msg) => DecodeError::Zstd(msg),
        }),
        BytesCodec::Gzip => gzip::decompress_members(input, max_len).map_err(|e| match e {
            GunzipError::TooLarge => too_large,
            GunzipError::Corrupt(msg) => DecodeError::Gzip(msg),
        }),
        BytesCodec::Zlib => decode_zlib_bounded(input, max_len).map_err(|e| match e {
            BoundedError::TooLarge => too_large,
            BoundedError::Corrupt(msg) => DecodeError::Zlib(msg),
        }),
        BytesCodec::Blosc(config) => {
            blosc::decode_blosc(input, &config, max_len).map_err(DecodeError::Blosc)
        }
        BytesCodec::Crc32c => {
            let Some(split) = input.len().checked_sub(4) else {
                return Err(DecodeError::ChecksumTruncated(input.len()));
            };
            let (bytes, checksum) = input.split_at(split);
            if bytes.len() > max_len {
                return Err(too_large);
            }
            let recorded = u32::from_le_bytes(checksum.try_into().expect("four checksum bytes"));
            let computed = crc32c::crc32c(bytes);
            if recorded != computed {
                return Err(DecodeError::Checksum { recorded, computed });
            }
            Ok(bytes.to_vec())
        }
    }
}

/// Why a bounded decode stopped.
#[derive(Debug)]
pub(crate) enum BoundedError {
    TooLarge,
    Corrupt(String),
}

/// Decode a zlib stream, refused once it inflates past `max_len` bytes.
fn decode_zlib_bounded(input: &[u8], max_len: usize) -> Result<Vec<u8>, BoundedError> {
    miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(input, max_len).map_err(|e| {
        match e.status {
            TINFLStatus::HasMoreOutput => BoundedError::TooLarge,
            status => BoundedError::Corrupt(format!("{status:?}")),
        }
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use lucida_protocol::codec::{BloscCompressor, BloscConfig, BloscShuffle};

    fn gzip(raw: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap()
    }

    fn with_crc32c(bytes: &[u8]) -> Vec<u8> {
        [bytes, &crc32c::crc32c(bytes).to_le_bytes()].concat()
    }

    fn decode(codec: BytesCodec, stored: &[u8], max_len: usize) -> Result<Vec<u8>, DecodeError> {
        decode_bytes_codecs(&[codec], stored, max_len)
    }

    #[test]
    fn no_codecs_pass_the_bytes_through() {
        let raw = vec![1u8, 2, 3, 4, 5];
        assert_eq!(decode_bytes_codecs(&[], &raw, raw.len()).unwrap(), raw);
    }

    #[test]
    fn lz4_round_trip() {
        let raw = vec![42u8; 1024];
        let stored = lz4_flex::compress_prepend_size(&raw);
        assert_eq!(decode(BytesCodec::Lz4, &stored, 1024).unwrap(), raw);
    }

    #[test]
    fn zstd_round_trip() {
        let raw: Vec<u8> = (0..4096).map(|i| (i % 251) as u8).collect();
        let stored = ::zstd::encode_all(std::io::Cursor::new(&raw), 0).unwrap();
        assert_eq!(decode(BytesCodec::Zstd, &stored, 4096).unwrap(), raw);
    }

    #[test]
    fn zstd_reads_every_frame() {
        let mut stored = ::zstd::encode_all(std::io::Cursor::new(&[1u8; 8][..]), 0).unwrap();
        stored.extend(::zstd::encode_all(std::io::Cursor::new(&[2u8; 8][..]), 0).unwrap());
        assert_eq!(
            decode(BytesCodec::Zstd, &stored, 16).unwrap(),
            [[1u8; 8], [2u8; 8]].concat()
        );
    }

    #[test]
    fn gzip_and_zlib_round_trip() {
        let raw: Vec<u8> = (0..4096).map(|i| (i % 251) as u8).collect();
        assert_eq!(decode(BytesCodec::Gzip, &gzip(&raw), 4096).unwrap(), raw);

        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(1));
        encoder.write_all(&raw).unwrap();
        let zlib = encoder.finish().unwrap();
        assert_eq!(decode(BytesCodec::Zlib, &zlib, 4096).unwrap(), raw);
    }

    #[test]
    fn gzip_reads_every_member() {
        let stored = [gzip(&[1u8; 8]), gzip(&[2u8; 8])].concat();
        assert_eq!(
            decode(BytesCodec::Gzip, &stored, 16).unwrap(),
            [[1u8; 8], [2u8; 8]].concat()
        );
        let err = decode(BytesCodec::Gzip, &stored[..stored.len() - 3], 16).unwrap_err();
        assert!(matches!(err, DecodeError::Gzip(_)), "{err}");
    }

    #[test]
    fn a_crc32c_checksum_is_checked_and_stripped() {
        let raw = vec![9u8; 64];
        assert_eq!(
            decode(BytesCodec::Crc32c, &with_crc32c(&raw), 64).unwrap(),
            raw
        );

        let mut corrupt = with_crc32c(&raw);
        corrupt[3] ^= 1;
        let err = decode(BytesCodec::Crc32c, &corrupt, 64).unwrap_err();
        assert!(matches!(err, DecodeError::Checksum { .. }), "{err}");
        assert_eq!(err.failure_kind(), ChunkFailureKind::CorruptChunk);

        let err = decode(BytesCodec::Crc32c, &[1, 2], 64).unwrap_err();
        assert!(matches!(err, DecodeError::ChecksumTruncated(2)), "{err}");
    }

    #[test]
    fn lz4_bad_input_errors() {
        let bogus = vec![0u8, 0, 0, 0, 1, 2, 3];
        assert!(decode(BytesCodec::Lz4, &bogus, 1024).is_err());
    }

    /// A small stream that expands far past the chunk it should hold stops
    /// at the limit, whichever codec wrote it.
    #[test]
    fn a_stream_that_decodes_past_the_chunk_size_is_refused() {
        let limit = 4096;
        let raw = vec![0u8; 16 * 1024 * 1024];
        let refused = |stored: &[u8], codec: BytesCodec| {
            matches!(
                decode(codec, stored, limit),
                Err(DecodeError::TooLarge { limit: 4096 })
            )
        };

        let zstd = ::zstd::encode_all(std::io::Cursor::new(&raw), 19).unwrap();
        assert!(zstd.len() < limit);
        assert!(refused(&zstd, BytesCodec::Zstd));
        assert!(refused(
            &lz4_flex::compress_prepend_size(&raw),
            BytesCodec::Lz4
        ));
        let gz = gzip(&raw);
        assert!(gz.len() < 32 * 1024);
        assert!(refused(&gz, BytesCodec::Gzip));
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(9));
        encoder.write_all(&raw).unwrap();
        assert!(refused(&encoder.finish().unwrap(), BytesCodec::Zlib));
        assert!(refused(&with_crc32c(&raw[..limit + 1]), BytesCodec::Crc32c));
        assert!(matches!(
            decode_bytes_codecs(&[], &raw[..limit + 1], limit),
            Err(DecodeError::TooLarge { limit: 4096 })
        ));
    }

    /// The limit holds inside a chain too: an outer gzip that unpacks a
    /// bomb is stopped near the inner codec's bound, not after.
    #[test]
    fn a_bomb_inside_a_chain_is_refused_at_its_own_stage() {
        let limit = 4096;
        let stored = gzip(&gzip(&vec![0u8; 16 * 1024 * 1024]));
        assert!(matches!(
            decode_bytes_codecs(&[BytesCodec::Gzip, BytesCodec::Gzip], &stored, limit),
            Err(DecodeError::TooLarge { .. })
        ));
    }

    /// An lz4 size prefix is refused before anything is allocated for it.
    #[test]
    fn an_lz4_size_prefix_past_the_chunk_size_is_refused() {
        let mut claim = u32::MAX.to_le_bytes().to_vec();
        claim.extend_from_slice(&[0x10, 0x00]);
        assert!(matches!(
            decode(BytesCodec::Lz4, &claim, 1024),
            Err(DecodeError::TooLarge { limit: 1024 })
        ));
    }

    #[test]
    fn blosc_runs_inside_a_chain() {
        let config = BloscConfig {
            typesize: 1,
            cname: BloscCompressor::Zstd,
            shuffle: BloscShuffle::None,
        };
        // A memcpyed Blosc1 buffer: 16-byte header, then the bytes as is.
        let raw = [5u8; 8];
        let mut stored = vec![2, 1, 0x02 | 0x80 | 0x10, 1];
        stored.extend_from_slice(&8u32.to_le_bytes());
        stored.extend_from_slice(&8u32.to_le_bytes());
        stored.extend_from_slice(&24u32.to_le_bytes());
        stored.extend_from_slice(&raw);
        assert_eq!(
            decode_bytes_codecs(
                &[BytesCodec::Blosc(config), BytesCodec::Crc32c],
                &with_crc32c(&stored),
                8
            )
            .unwrap(),
            raw
        );
    }

    #[test]
    fn a_relayed_chunk_decodes_to_exactly_its_size_or_fails() {
        let raw = vec![3u8; 256];
        let stored = lz4_flex::compress_prepend_size(&raw);
        assert_eq!(
            decode_relayed(&[BytesCodec::Lz4], &stored, 256).unwrap(),
            raw
        );

        let err = decode_relayed(&[BytesCodec::Lz4], &stored, 512).unwrap_err();
        assert!(
            matches!(
                err,
                DecodeError::WrongSize {
                    expected: 512,
                    actual: 256
                }
            ),
            "{err}"
        );
        let err = decode_relayed(&[BytesCodec::Lz4], &stored, 128).unwrap_err();
        assert!(matches!(err, DecodeError::TooLarge { limit: 128 }), "{err}");
        assert_eq!(err.failure_kind(), ChunkFailureKind::WrongSize);
    }
}
