//! Storage-codec decode for [`crate::chunk_read::read_chunk`], so every
//! served chunk is undone by the same codec chain code.
//!
//! The codec types live in [`lucida_store::codec`], where import validates
//! each level's chain against the registry. The bytes-to-bytes decoders are
//! [`lucida_core::chunk_codec`]'s, which the page shares; this module adds
//! what only the server undoes: byte order and transposes. Every codec
//! decodes against a byte limit, so a stream that expands past what the
//! stored chunk shape holds is refused before it is held whole.

pub use lucida_core::chunk_codec::DecodeError;
use lucida_core::chunk_codec::decode_bytes_codecs;
pub use lucida_store::codec::StorageCompression;
use lucida_store::codec::{ArrayCodec, ByteOrder, CodecChain};

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
    let mut samples = decode_bytes_codecs(&chain.bytes_to_bytes, storage_bytes, max_len)?;

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

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use lucida_protocol::ChunkFailureKind;
    use lucida_store::codec::BytesCodec;

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
}
