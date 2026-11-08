//! Storage-codec decode for [`crate::chunk_read::read_chunk`], so every
//! served chunk is undone by the same codec chain code.
//!
//! The codec types live in [`lucida_store::codec`], where import validates
//! each level's chain against the registry. The decoding lives here because
//! `lucida-store` deliberately does not depend on `zstd`, `lz4_flex`, or
//! deflate. Every codec decodes against a byte limit, so a stream that
//! expands past what the stored chunk shape holds is refused before it is
//! held whole.

pub mod blosc;
mod blosclz;

use std::io::Read;

use lucida_protocol::ChunkFailureKind;
pub use lucida_store::codec::StorageCompression;
use lucida_store::codec::{ArrayCodec, ByteOrder, BytesCodec, CodecChain};

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
    /// so they describe some other chunk shape than the binding does.
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

/// Decode `storage_bytes` according to `compression` into the wire's bytes:
/// little-endian samples in C order over `chunk_shape`, the stored chunk's
/// shape in the array's axes. Refuses any stream that decodes to more than
/// `max_len` bytes before it allocates more.
pub fn decode_storage_bytes(
    storage_bytes: &[u8],
    compression: &StorageCompression,
    chunk_shape: &[u64],
    max_len: usize,
) -> Result<Vec<u8>, DecodeError> {
    match compression {
        StorageCompression::None => {
            if storage_bytes.len() > max_len {
                return Err(DecodeError::TooLarge { limit: max_len });
            }
            Ok(storage_bytes.to_vec())
        }
        StorageCompression::Codecs(chain) => {
            decode_chain(storage_bytes, chain, chunk_shape, max_len)
        }
    }
}

/// Undo a codec chain, last codec first.
fn decode_chain(
    storage_bytes: &[u8],
    chain: &CodecChain,
    chunk_shape: &[u64],
    max_len: usize,
) -> Result<Vec<u8>, DecodeError> {
    // Each bytes-to-bytes codec decodes to at most what the codecs before
    // it can have written for `max_len` bytes of samples.
    let mut limits = Vec::with_capacity(chain.bytes_to_bytes.len());
    let mut limit = max_len;
    for codec in &chain.bytes_to_bytes {
        limits.push(limit);
        limit = encoded_bound(*codec, limit);
    }
    let mut bytes: Option<Vec<u8>> = None;
    for (codec, limit) in chain.bytes_to_bytes.iter().zip(limits).rev() {
        let input = bytes.as_deref().unwrap_or(storage_bytes);
        bytes = Some(decode_bytes_codec(*codec, input, limit)?);
    }
    let mut samples = match bytes {
        Some(bytes) => bytes,
        None if storage_bytes.len() > max_len => {
            return Err(DecodeError::TooLarge { limit: max_len });
        }
        None => storage_bytes.to_vec(),
    };

    let sample_size = usize::from(chain.sample_size.max(1));
    let expected = chunk_shape.iter().try_fold(sample_size, |acc, &d| {
        acc.checked_mul(usize::try_from(d).ok()?)
    });
    if expected != Some(samples.len()) {
        return Err(DecodeError::WrongSize {
            expected: expected.unwrap_or(usize::MAX),
            actual: samples.len(),
        });
    }
    if chain.byte_order == ByteOrder::Big && sample_size > 1 {
        for sample in samples.chunks_exact_mut(sample_size) {
            sample.reverse();
        }
    }

    // The shape each array-to-array codec was handed when writing. Import
    // checked each order against the chunk's rank; a binding whose chunk
    // shape has another rank is refused rather than indexed out of bounds.
    let mut shapes = Vec::with_capacity(chain.array_to_array.len());
    let mut shape: Vec<u64> = chunk_shape.to_vec();
    for codec in &chain.array_to_array {
        let ArrayCodec::Transpose(order) = codec;
        if order.len() != shape.len() || order.iter().any(|&axis| axis >= shape.len()) {
            return Err(DecodeError::WrongRank {
                order: order.clone(),
                rank: shape.len(),
            });
        }
        shapes.push(shape.clone());
        shape = order.iter().map(|&axis| shape[axis]).collect();
    }
    for (codec, shape) in chain.array_to_array.iter().zip(&shapes).rev() {
        samples = match codec {
            ArrayCodec::Transpose(order) => untranspose(&samples, shape, order, sample_size),
        };
    }
    Ok(samples)
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
    match codec {
        BytesCodec::Lz4 => {
            let (len, block) = lz4_flex::block::uncompressed_size(input)
                .map_err(|e| DecodeError::Lz4(e.to_string()))?;
            if len > max_len {
                return Err(DecodeError::TooLarge { limit: max_len });
            }
            lz4_flex::block::decompress(block, len).map_err(|e| DecodeError::Lz4(e.to_string()))
        }
        BytesCodec::Zstd => decode_zstd_bounded(input, max_len).map_err(|e| match e {
            BoundedError::TooLarge => DecodeError::TooLarge { limit: max_len },
            BoundedError::Io(e) => DecodeError::Zstd(e.to_string()),
        }),
        BytesCodec::Gzip => read_bounded(flate2::read::MultiGzDecoder::new(input), max_len)
            .map_err(|e| match e {
                BoundedError::TooLarge => DecodeError::TooLarge { limit: max_len },
                BoundedError::Io(e) => DecodeError::Gzip(e.to_string()),
            }),
        BytesCodec::Zlib => decode_zlib_bounded(input, max_len).map_err(|e| match e {
            BoundedError::TooLarge => DecodeError::TooLarge { limit: max_len },
            BoundedError::Io(e) => DecodeError::Zlib(e.to_string()),
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
                return Err(DecodeError::TooLarge { limit: max_len });
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

/// Reorder the samples of an array that a transpose by `order` wrote back
/// into C order over `shape`, the shape it had before. Axis `i` of what was
/// written is axis `order[i]` of `shape`.
fn untranspose(input: &[u8], shape: &[u64], order: &[usize], sample_size: usize) -> Vec<u8> {
    let ndim = shape.len();
    let shape: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    // The written array's C-order strides, in samples, found per axis of
    // `shape` so the walk below can step through the input as it fills the
    // output in order.
    let mut written_stride = vec![0usize; ndim];
    let mut stride = 1;
    for &axis in order.iter().rev() {
        written_stride[axis] = stride;
        stride *= shape[axis];
    }
    let mut out = Vec::with_capacity(input.len());
    if input.is_empty() || ndim == 0 {
        out.extend_from_slice(input);
        return out;
    }
    let last = ndim - 1;
    let mut index = vec![0usize; ndim];
    loop {
        let base: usize = index.iter().zip(&written_stride).map(|(i, s)| i * s).sum();
        for i in 0..shape[last] {
            let at = (base + i * written_stride[last]) * sample_size;
            out.extend_from_slice(&input[at..at + sample_size]);
        }
        // Advance every axis but the last, as an odometer.
        let mut axis = last;
        loop {
            if axis == 0 {
                return out;
            }
            axis -= 1;
            index[axis] += 1;
            if index[axis] < shape[axis] {
                break;
            }
            index[axis] = 0;
        }
    }
}

/// Why a bounded decode stopped.
#[derive(Debug)]
pub(crate) enum BoundedError {
    TooLarge,
    Io(std::io::Error),
}

/// Read `reader` to its end, stopping one byte past `max_len` so a stream
/// that decodes larger is refused without being held whole.
fn read_bounded(reader: impl Read, max_len: usize) -> Result<Vec<u8>, BoundedError> {
    let mut out = Vec::new();
    reader
        .take((max_len as u64).saturating_add(1))
        .read_to_end(&mut out)
        .map_err(BoundedError::Io)?;
    if out.len() > max_len {
        return Err(BoundedError::TooLarge);
    }
    Ok(out)
}

/// Decode a zstd stream of any number of frames, bounded as
/// [`read_bounded`] is.
pub(crate) fn decode_zstd_bounded(input: &[u8], max_len: usize) -> Result<Vec<u8>, BoundedError> {
    let decoder = zstd::stream::read::Decoder::new(input).map_err(BoundedError::Io)?;
    read_bounded(decoder, max_len)
}

/// Decode a zlib stream, bounded as [`read_bounded`] is.
pub(crate) fn decode_zlib_bounded(input: &[u8], max_len: usize) -> Result<Vec<u8>, BoundedError> {
    read_bounded(flate2::read::ZlibDecoder::new(input), max_len)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use lucida_store::codec::{BloscCompressor, BloscConfig, BloscShuffle};

    fn compressed(codec: BytesCodec) -> StorageCompression {
        StorageCompression::compressed(codec, 1)
    }

    fn gzip(raw: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap()
    }

    fn with_crc32c(bytes: &[u8]) -> Vec<u8> {
        [bytes, &crc32c::crc32c(bytes).to_le_bytes()].concat()
    }

    #[test]
    fn none_pass_through() {
        let raw = vec![1u8, 2, 3, 4, 5];
        let out = decode_storage_bytes(&raw, &StorageCompression::None, &[5], raw.len()).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn lz4_round_trip() {
        let raw = vec![42u8; 1024];
        let compressed_bytes = lz4_flex::compress_prepend_size(&raw);
        let out = decode_storage_bytes(
            &compressed_bytes,
            &compressed(BytesCodec::Lz4),
            &[1024],
            1024,
        )
        .unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn zstd_round_trip() {
        let raw = vec![7u8; 1024];
        let bytes = zstd::encode_all(std::io::Cursor::new(&raw), 0).unwrap();
        let out =
            decode_storage_bytes(&bytes, &compressed(BytesCodec::Zstd), &[1024], 1024).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn zstd_reads_every_frame() {
        let mut bytes = zstd::encode_all(std::io::Cursor::new(&[1u8; 8][..]), 0).unwrap();
        bytes.extend(zstd::encode_all(std::io::Cursor::new(&[2u8; 8][..]), 0).unwrap());
        let out = decode_storage_bytes(&bytes, &compressed(BytesCodec::Zstd), &[16], 16).unwrap();
        assert_eq!(out, [[1u8; 8], [2u8; 8]].concat());
    }

    #[test]
    fn gzip_and_zlib_round_trip() {
        let raw: Vec<u8> = (0..4096).map(|i| (i % 251) as u8).collect();
        let out = decode_storage_bytes(&gzip(&raw), &compressed(BytesCodec::Gzip), &[4096], 4096)
            .unwrap();
        assert_eq!(out, raw);

        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(1));
        encoder.write_all(&raw).unwrap();
        let zlib = encoder.finish().unwrap();
        let out =
            decode_storage_bytes(&zlib, &compressed(BytesCodec::Zlib), &[4096], 4096).unwrap();
        assert_eq!(out, raw);
    }

    #[test]
    fn a_crc32c_checksum_is_checked_and_stripped() {
        let raw = vec![9u8; 64];
        let out = decode_storage_bytes(
            &with_crc32c(&raw),
            &compressed(BytesCodec::Crc32c),
            &[64],
            64,
        )
        .unwrap();
        assert_eq!(out, raw);

        let mut corrupt = with_crc32c(&raw);
        corrupt[3] ^= 1;
        let err =
            decode_storage_bytes(&corrupt, &compressed(BytesCodec::Crc32c), &[64], 64).unwrap_err();
        assert!(matches!(err, DecodeError::Checksum { .. }), "{err}");
        assert_eq!(err.failure_kind(), ChunkFailureKind::CorruptChunk);

        let err =
            decode_storage_bytes(&[1, 2], &compressed(BytesCodec::Crc32c), &[64], 64).unwrap_err();
        assert!(matches!(err, DecodeError::ChecksumTruncated(2)), "{err}");
    }

    #[test]
    fn lz4_bad_input_errors() {
        let bogus = vec![0u8, 0, 0, 0, 1, 2, 3];
        let result = decode_storage_bytes(&bogus, &compressed(BytesCodec::Lz4), &[1024], 1024);
        assert!(result.is_err());
    }

    /// A 2x3 array of `u16` samples 0..6, written transposed, big-endian,
    /// gzipped, and checksummed, decodes to the samples in C order and
    /// little-endian.
    #[test]
    fn a_transposed_big_endian_gzipped_checksummed_chunk_decodes_to_c_order() {
        let samples: [[u16; 3]; 2] = [[0, 1, 2], [3, 4, 5]];
        // Transposed by [1, 0], the written array is 3x2: column by column.
        let written: Vec<u8> = (0..3)
            .flat_map(|x| (0..2).map(move |y| samples[y][x]))
            .flat_map(u16::to_be_bytes)
            .collect();
        let stored = with_crc32c(&gzip(&written));
        let chain = StorageCompression::Codecs(CodecChain {
            array_to_array: vec![ArrayCodec::Transpose(vec![1, 0])],
            byte_order: ByteOrder::Big,
            sample_size: 2,
            bytes_to_bytes: vec![BytesCodec::Gzip, BytesCodec::Crc32c],
        });
        let out = decode_storage_bytes(&stored, &chain, &[2, 3], 12).unwrap();
        let expected: Vec<u8> = (0u16..6).flat_map(u16::to_le_bytes).collect();
        assert_eq!(out, expected);
    }

    /// Two transposes compose: a 3D chunk rotated twice comes back in C
    /// order.
    #[test]
    fn stacked_transposes_undo_in_reverse() {
        let shape = [2u64, 3, 4];
        let c_order: Vec<u8> = (0..24).collect();
        let index = |z: usize, y: usize, x: usize| c_order[(z * 3 + y) * 4 + x];
        // First [2, 0, 1]: written shape (4, 2, 3), element [x][z][y].
        // Then [1, 2, 0] of that: written shape (2, 3, 4), element [z][y][x].
        // The two cancel, so the stored bytes are C order again.
        let mut first = Vec::new();
        for x in 0..4 {
            for z in 0..2 {
                for y in 0..3 {
                    first.push(index(z, y, x));
                }
            }
        }
        let chain = |codecs: Vec<ArrayCodec>| {
            StorageCompression::Codecs(CodecChain {
                array_to_array: codecs,
                byte_order: ByteOrder::Little,
                sample_size: 1,
                bytes_to_bytes: Vec::new(),
            })
        };
        let once = chain(vec![ArrayCodec::Transpose(vec![2, 0, 1])]);
        assert_eq!(
            decode_storage_bytes(&first, &once, &shape, 24).unwrap(),
            c_order
        );
        let twice = chain(vec![
            ArrayCodec::Transpose(vec![2, 0, 1]),
            ArrayCodec::Transpose(vec![1, 2, 0]),
        ]);
        assert_eq!(
            decode_storage_bytes(&c_order, &twice, &shape, 24).unwrap(),
            c_order
        );
    }

    #[test]
    fn a_transpose_that_does_not_fit_the_chunk_s_rank_is_refused() {
        let chain = StorageCompression::Codecs(CodecChain {
            array_to_array: vec![ArrayCodec::Transpose(vec![1, 0])],
            byte_order: ByteOrder::Little,
            sample_size: 1,
            bytes_to_bytes: Vec::new(),
        });
        let err = decode_storage_bytes(&[0; 4], &chain, &[4], 4).unwrap_err();
        assert!(
            matches!(err, DecodeError::WrongRank { rank: 1, .. }),
            "{err}"
        );
        assert_eq!(err.failure_kind(), ChunkFailureKind::WrongSize);
    }

    #[test]
    fn a_chain_that_decodes_to_the_wrong_size_is_refused() {
        let chain = StorageCompression::Codecs(CodecChain {
            array_to_array: Vec::new(),
            byte_order: ByteOrder::Big,
            sample_size: 2,
            bytes_to_bytes: Vec::new(),
        });
        let err = decode_storage_bytes(&[0; 6], &chain, &[2, 2], 8).unwrap_err();
        assert!(
            matches!(
                err,
                DecodeError::WrongSize {
                    expected: 8,
                    actual: 6
                }
            ),
            "{err}"
        );
    }

    /// A small stream that expands far past the chunk it should hold stops
    /// at the limit, whichever codec wrote it.
    #[test]
    fn a_stream_that_decodes_past_the_chunk_size_is_refused() {
        let limit = 4096;
        let raw = vec![0u8; 16 * 1024 * 1024];
        let shape = [limit as u64];
        let refused = |stored: &[u8], codec: BytesCodec| {
            matches!(
                decode_storage_bytes(stored, &compressed(codec), &shape, limit),
                Err(DecodeError::TooLarge { limit: 4096 })
            )
        };

        let zstd = zstd::encode_all(std::io::Cursor::new(&raw), 19).unwrap();
        assert!(zstd.len() < limit);
        assert!(refused(&zstd, BytesCodec::Zstd));
        assert!(refused(
            &lz4_flex::compress_prepend_size(&raw),
            BytesCodec::Lz4
        ));
        let gz = gzip(&raw);
        assert!(gz.len() < 32 * 1024);
        assert!(refused(&gz, BytesCodec::Gzip));
        assert!(refused(&with_crc32c(&raw[..limit + 1]), BytesCodec::Crc32c));
        assert!(matches!(
            decode_storage_bytes(&raw[..limit + 1], &StorageCompression::None, &shape, limit),
            Err(DecodeError::TooLarge { limit: 4096 })
        ));
    }

    /// The limit holds inside a chain too: an outer gzip that unpacks a
    /// bomb is stopped near the inner codec's bound, not after.
    #[test]
    fn a_bomb_inside_a_chain_is_refused_at_its_own_stage() {
        let limit = 4096;
        let inner = vec![0u8; 16 * 1024 * 1024];
        let stored = gzip(&gzip(&inner));
        let chain = StorageCompression::Codecs(CodecChain {
            array_to_array: Vec::new(),
            byte_order: ByteOrder::Little,
            sample_size: 1,
            bytes_to_bytes: vec![BytesCodec::Gzip, BytesCodec::Gzip],
        });
        assert!(matches!(
            decode_storage_bytes(&stored, &chain, &[limit as u64], limit),
            Err(DecodeError::TooLarge { .. })
        ));
    }

    /// An lz4 size prefix is refused before anything is allocated for it.
    #[test]
    fn an_lz4_size_prefix_past_the_chunk_size_is_refused() {
        let mut claim = u32::MAX.to_le_bytes().to_vec();
        claim.extend_from_slice(&[0x10, 0x00]);
        assert!(matches!(
            decode_storage_bytes(&claim, &compressed(BytesCodec::Lz4), &[1024], 1024),
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
        let out =
            decode_storage_bytes(&stored, &compressed(BytesCodec::Blosc(config)), &[8], 8).unwrap();
        assert_eq!(out, raw);
    }
}
