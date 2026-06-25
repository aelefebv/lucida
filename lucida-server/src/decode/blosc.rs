//! Minimal Blosc1 decoder for the subset of configurations Lucida supports.
//!
//! Only `cname: zstd` with `shuffle ∈ {none, byte, bit}` and `typesize ∈ {1, 2, 4}`
//! is recognized — anything else should be rejected upstream at codec-chain
//! parse time. Blosc2 frames are not supported.
//!
//! Format reference: <https://github.com/Blosc/c-blosc/blob/main/README_HEADER.rst>.
//!
//! Layout: 16-byte header, then `nblocks` u32-LE offsets pointing at each
//! block's start, then per block a u32-LE compressed length followed by the
//! zstd-compressed payload. When the `MEMCPYED` flag (0x02) is set, bytes
//! `[16..16+nbytes]` are the original buffer and no decompress/unshuffle runs.
//!
//! Bitshuffle algorithm matches the libbitshuffle C reference: per 8-element
//! block, byte-transpose into `typesize` planes of 8 bytes, then bit-transpose
//! each plane as an 8×8 bit matrix. Trailing elements (N % 8) are left raw.
//!
//! Per-block filter gating matches upstream c-blosc's `shuffle`/`bitshuffle`
//! wrappers: the filter is applied to a block all-or-nothing, and only when the
//! block is filter-aligned (see [`unshuffle_block`]). Non-aligned blocks — in
//! practice the trailing block of a buffer — are stored RAW by the encoder, so
//! the decoder must pass them through verbatim rather than (mis)unshuffling them.

use std::borrow::Cow;

use lucida_store::codec::{BloscConfig, BloscShuffle};

/// Errors decoding a Blosc-compressed buffer.
#[derive(thiserror::Error, Debug)]
pub enum BloscError {
    #[error("blosc: input shorter than 16-byte header (got {0})")]
    HeaderTruncated(usize),
    #[error("blosc: unsupported version {0} (expected 2)")]
    UnsupportedVersion(u8),
    #[error("blosc: header typesize {header} does not match config typesize {config}")]
    TypesizeMismatch { header: u8, config: u8 },
    #[error("blosc: header shuffle flags 0x{flags:02x} do not match config {expected:?}")]
    ShuffleMismatch { flags: u8, expected: BloscShuffle },
    #[error("blosc: header compressor code {code} not supported (expected 4 = zstd)")]
    UnsupportedCompressor { code: u8 },
    #[error("blosc: input truncated reading {what} (need {need}, have {have})")]
    InputTruncated {
        what: &'static str,
        need: usize,
        have: usize,
    },
    #[error("blosc: zstd decode failed at block {block}: {msg}")]
    ZstdDecode { block: usize, msg: String },
    #[error("blosc: block {block} decoded to {got} bytes, expected {expected}")]
    BlockSizeMismatch {
        block: usize,
        got: usize,
        expected: usize,
    },
    #[error("blosc: nbytes {nbytes} is not a multiple of typesize {typesize}")]
    NotElementAligned { nbytes: usize, typesize: usize },
}

const FLAG_BYTE_SHUFFLE: u8 = 0x01;
const FLAG_MEMCPYED: u8 = 0x02;
const FLAG_BIT_SHUFFLE: u8 = 0x04;
const COMPRESSOR_CODE_ZSTD: u8 = 4;

/// Decode a Blosc1-compressed buffer, returning the raw uncompressed bytes.
///
/// `config` is the codec-chain-validated description from the dataset's
/// metadata; the function cross-checks the on-disk header against it and
/// errors on any mismatch.
pub fn decode_blosc(input: &[u8], config: &BloscConfig) -> Result<Vec<u8>, BloscError> {
    if input.len() < 16 {
        return Err(BloscError::HeaderTruncated(input.len()));
    }

    let version = input[0];
    if version != 2 {
        return Err(BloscError::UnsupportedVersion(version));
    }

    let flags = input[2];
    let typesize = input[3];
    let nbytes = u32::from_le_bytes([input[4], input[5], input[6], input[7]]) as usize;
    let blocksize = u32::from_le_bytes([input[8], input[9], input[10], input[11]]) as usize;
    let _cbytes = u32::from_le_bytes([input[12], input[13], input[14], input[15]]) as usize;

    if typesize != config.typesize {
        return Err(BloscError::TypesizeMismatch {
            header: typesize,
            config: config.typesize,
        });
    }

    let shuffle_bits = flags & (FLAG_BYTE_SHUFFLE | FLAG_BIT_SHUFFLE);
    let header_shuffle = match shuffle_bits {
        0 => BloscShuffle::None,
        FLAG_BYTE_SHUFFLE => BloscShuffle::Byte,
        FLAG_BIT_SHUFFLE => BloscShuffle::Bit,
        _ => {
            return Err(BloscError::ShuffleMismatch {
                flags,
                expected: config.shuffle,
            });
        }
    };
    if header_shuffle != config.shuffle {
        return Err(BloscError::ShuffleMismatch {
            flags,
            expected: config.shuffle,
        });
    }

    let compressor_code = (flags & 0xE0) >> 5;
    if compressor_code != COMPRESSOR_CODE_ZSTD {
        return Err(BloscError::UnsupportedCompressor {
            code: compressor_code,
        });
    }

    let memcpyed = (flags & FLAG_MEMCPYED) != 0;

    if memcpyed {
        let need = 16 + nbytes;
        if input.len() < need {
            return Err(BloscError::InputTruncated {
                what: "memcpy payload",
                need,
                have: input.len(),
            });
        }
        let mut out = vec![0u8; nbytes];
        out.copy_from_slice(&input[16..need]);
        return Ok(out);
    }

    if blocksize == 0 {
        return Err(BloscError::InputTruncated {
            what: "blocksize",
            need: 1,
            have: 0,
        });
    }

    let nblocks = nbytes.div_ceil(blocksize);
    let offsets_end = 16 + nblocks * 4;
    if input.len() < offsets_end {
        return Err(BloscError::InputTruncated {
            what: "offsets table",
            need: offsets_end,
            have: input.len(),
        });
    }

    if typesize as usize != 0 && !nbytes.is_multiple_of(typesize as usize) {
        return Err(BloscError::NotElementAligned {
            nbytes,
            typesize: typesize as usize,
        });
    }

    let mut decompressed = Vec::with_capacity(nbytes);
    for b in 0..nblocks {
        let off_start = 16 + b * 4;
        let block_offset =
            u32::from_le_bytes(input[off_start..off_start + 4].try_into().unwrap()) as usize;

        if input.len() < block_offset + 4 {
            return Err(BloscError::InputTruncated {
                what: "block compressed-length",
                need: block_offset + 4,
                have: input.len(),
            });
        }
        let compressed_len =
            u32::from_le_bytes(input[block_offset..block_offset + 4].try_into().unwrap()) as usize;

        let payload_start = block_offset + 4;
        let payload_end = payload_start + compressed_len;
        if input.len() < payload_end {
            return Err(BloscError::InputTruncated {
                what: "block payload",
                need: payload_end,
                have: input.len(),
            });
        }

        let block_uncompressed_size = blocksize.min(nbytes - decompressed.len());
        let block_bytes =
            zstd::stream::decode_all(std::io::Cursor::new(&input[payload_start..payload_end]))
                .map_err(|e| BloscError::ZstdDecode {
                    block: b,
                    msg: e.to_string(),
                })?;
        if block_bytes.len() != block_uncompressed_size {
            return Err(BloscError::BlockSizeMismatch {
                block: b,
                got: block_bytes.len(),
                expected: block_uncompressed_size,
            });
        }

        // Single, exhaustive (filter, alignment) decision per block. Whether the
        // encoder shuffled this particular block lives entirely in
        // `unshuffle_block` so the loop stays a straight decode-then-append.
        let unshuffled = unshuffle_block(config.shuffle, &block_bytes, typesize as usize);
        decompressed.extend_from_slice(&unshuffled);
    }

    Ok(decompressed)
}

/// Reverse one block's Blosc filter, centralizing BOTH the filter choice and
/// upstream c-blosc's per-block alignment rule in a single auditable match.
///
/// c-blosc applies its (bit)shuffle filter to a block all-or-nothing, and only
/// when the block is *filter-aligned*; otherwise it stores the block's bytes RAW
/// (a plain memcpy with no shuffle). The alignment predicates mirror the guards
/// in c-blosc's `shuffle()` / `bitshuffle()` wrappers:
///
/// - `None` → never filtered; bytes are already raw.
/// - `Byte` → filtered iff `block_len` is a multiple of `typesize`.
/// - `Bit` → filtered iff `block_len` is a multiple of `typesize` *and* the
///   element count `block_len / typesize` is a multiple of 8.
///
/// Because c-blosc rounds `blocksize` down to a multiple of `typesize` and
/// `decode_blosc` already enforces `nbytes % typesize == 0`, every block is in
/// practice byte-aligned — so the *byte* filter is always applied. The *bit*
/// filter is the one that genuinely falls back: the trailing block's element
/// count `(nbytes - k*blocksize)/typesize` need not be a multiple of 8 even
/// though each full block's is, and c-blosc leaves that block unshuffled. We
/// still evaluate both predicates so the dispatch is exhaustive and correct for
/// any block we are handed. Raw (non-aligned) blocks borrow rather than copy.
///
/// Note `typesize == 1` is NOT a blanket no-op: byte-shuffle is the identity at
/// typesize 1, but *bit*-shuffle still bit-transposes each aligned group of 8
/// bytes, so it must go through [`bit_unshuffle`]. Only the zero-typesize case
/// (defensive — rejected upstream; would divide by zero) is short-circuited.
fn unshuffle_block(shuffle: BloscShuffle, block: &[u8], typesize: usize) -> Cow<'_, [u8]> {
    // Guard the degenerate typesize that would divide by zero in the predicates
    // below. None never filters, so it also needs no per-element reasoning.
    if typesize == 0 || matches!(shuffle, BloscShuffle::None) {
        return Cow::Borrowed(block);
    }
    let byte_aligned = block.len().is_multiple_of(typesize);
    match shuffle {
        // typesize == 1 makes byte-shuffle the identity; `byte_unshuffle` returns
        // a copy of the input in that case, so borrowing here is equivalent and
        // cheaper.
        BloscShuffle::Byte if typesize == 1 => Cow::Borrowed(block),
        BloscShuffle::Byte if byte_aligned => Cow::Owned(byte_unshuffle(block, typesize)),
        BloscShuffle::Bit if byte_aligned && (block.len() / typesize).is_multiple_of(8) => {
            Cow::Owned(bit_unshuffle(block, typesize))
        }
        // Non-filter-aligned block: c-blosc stored it raw, so we must too. (None
        // is handled by the early return above; this arm covers Byte/Bit only.)
        BloscShuffle::None | BloscShuffle::Byte | BloscShuffle::Bit => Cow::Borrowed(block),
    }
}

/// Inverse of Blosc byte-shuffle. The shuffled layout for a block of N
/// elements (each `typesize` bytes) is `typesize` consecutive groups of N
/// bytes; group j carries byte j of every element. Returns the original
/// element-major layout.
///
/// Callers gate this on `block_len % typesize == 0` (see [`unshuffle_block`]),
/// so the block is element-aligned in normal operation.
fn byte_unshuffle(input: &[u8], typesize: usize) -> Vec<u8> {
    if typesize <= 1 {
        return input.to_vec();
    }
    let total = input.len();
    let n = total / typesize;
    let mut out = vec![0u8; total];
    for j in 0..typesize {
        for i in 0..n {
            out[i * typesize + j] = input[j * n + i];
        }
    }
    // Trailing bytes that don't fit a full element (n*typesize..total) are
    // copied through unchanged. Should not occur for valid blosc inputs since
    // nbytes is element-aligned, but kept for defensive symmetry.
    if n * typesize < total {
        out[n * typesize..].copy_from_slice(&input[n * typesize..]);
    }
    out
}

/// Inverse of libbitshuffle's bit-shuffle. The forward shuffle treats each of
/// the `typesize` byte-planes (one byte per element per plane, `n_elements`
/// bytes total) as a `(n_elements, 8)` bit matrix and transposes it to
/// `(8, n_elements)`. We invert that: for each output byte (one element's
/// `j`-th byte) gather its 8 bits from across the `(8, n_elements)` plane.
///
/// Callers gate this on the element count being a multiple of 8 (see
/// [`unshuffle_block`]), so in normal operation `aligned_elements == n_elements`
/// and there is no remainder. The tail handling below is retained for defensive
/// symmetry only.
///
/// Tail handling: libbitshuffle truncates the bit-transposed region to the
/// largest multiple-of-8 element count and stores the remainder bytes
/// element-major after the aligned planes. We copy that tail through.
fn bit_unshuffle(input: &[u8], typesize: usize) -> Vec<u8> {
    if typesize == 0 || input.is_empty() {
        return input.to_vec();
    }
    let total = input.len();
    let n_elements = total / typesize;
    let aligned_elements = (n_elements / 8) * 8;
    let plane_bytes = aligned_elements; // 1 byte per element per plane
    let row_bytes = aligned_elements / 8; // each transposed-plane row is N/8 bytes

    let mut out = vec![0u8; total];

    for w in 0..typesize {
        let plane_offset = w * plane_bytes;
        for i in 0..aligned_elements {
            let mut val: u8 = 0;
            for b in 0..8 {
                let src = input[plane_offset + b * row_bytes + i / 8];
                let bit = (src >> (i % 8)) & 1;
                val |= bit << b;
            }
            out[i * typesize + w] = val;
        }
    }

    // Tail elements (n_elements % 8 != 0) live at the end of the input as
    // straight element-major bytes — copy them through unchanged.
    let aligned_byte_total = typesize * aligned_elements;
    if aligned_byte_total < total {
        out[aligned_byte_total..].copy_from_slice(&input[aligned_byte_total..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(typesize: u8, shuffle: BloscShuffle) -> BloscConfig {
        BloscConfig {
            typesize,
            cname: lucida_store::codec::BloscCompressor::Zstd,
            shuffle,
        }
    }

    // --- Generated test vectors. Regenerate any vector with the python3
    // command in the comment above its constant. All compressible vectors
    // share PLAINTEXT (256 bytes of [i % 8 for i in 0..256]) so any decode
    // failure is easy to bisect against the expected pattern.

    /// Canonical test plaintext: 256 bytes, [i % 8 for i in 0..256].
    /// Each typesize-N test interprets these bytes as 256/N elements.
    const PLAINTEXT: &[u8] = &[
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
        0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
        0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04,
        0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03,
        0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02,
        0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01,
        0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00,
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
        0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
        0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04,
        0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03,
        0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02,
        0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01,
        0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00,
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
        0x07,
    ];

    /// shuffle=NONE, typesize=1.
    /// `python3 -c "import blosc; print(blosc.compress(bytes([i%8 for i in range(256)]), typesize=1, cname='zstd', shuffle=blosc.NOSHUFFLE))"`
    const ENC_NONE_TS1: &[u8] = &[
        0x02, 0x01, 0x90, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x32, 0x00, 0x00,
        0x00, 0x14, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x00,
        0x00, 0x85, 0x00, 0x00, 0x48, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01,
        0x00, 0xf4, 0xd4, 0x3d, 0x02,
    ];

    /// shuffle=NONE, typesize=2.
    /// `python3 -c "import blosc; print(blosc.compress(bytes([i%8 for i in range(256)]), typesize=2, cname='zstd', shuffle=blosc.NOSHUFFLE))"`
    const ENC_NONE_TS2: &[u8] = &[
        0x02, 0x01, 0x90, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x32, 0x00, 0x00,
        0x00, 0x14, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x00,
        0x00, 0x85, 0x00, 0x00, 0x48, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01,
        0x00, 0xf4, 0xd4, 0x3d, 0x02,
    ];

    /// shuffle=NONE, typesize=4.
    /// `python3 -c "import blosc; print(blosc.compress(bytes([i%8 for i in range(256)]), typesize=4, cname='zstd', shuffle=blosc.NOSHUFFLE))"`
    const ENC_NONE_TS4: &[u8] = &[
        0x02, 0x01, 0x90, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x32, 0x00, 0x00,
        0x00, 0x14, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x00,
        0x00, 0x85, 0x00, 0x00, 0x48, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01,
        0x00, 0xf4, 0xd4, 0x3d, 0x02,
    ];

    /// shuffle=BYTE, typesize=1. (Equivalent to NOSHUFFLE since typesize=1.)
    /// `python3 -c "import blosc; print(blosc.compress(bytes([i%8 for i in range(256)]), typesize=1, cname='zstd', shuffle=blosc.SHUFFLE))"`
    const ENC_BYTE_TS1: &[u8] = &[
        0x02, 0x01, 0x91, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x32, 0x00, 0x00,
        0x00, 0x14, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x00,
        0x00, 0x85, 0x00, 0x00, 0x48, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x00, 0x01,
        0x00, 0xf4, 0xd4, 0x3d, 0x02,
    ];

    /// shuffle=BYTE, typesize=2.
    /// `python3 -c "import blosc; print(blosc.compress(bytes([i%8 for i in range(256)]), typesize=2, cname='zstd', shuffle=blosc.SHUFFLE))"`
    const ENC_BYTE_TS2: &[u8] = &[
        0x02, 0x01, 0x91, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x34, 0x00, 0x00,
        0x00, 0x14, 0x00, 0x00, 0x00, 0x1c, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x00,
        0x00, 0x95, 0x00, 0x00, 0x48, 0x00, 0x02, 0x04, 0x06, 0x01, 0x03, 0x05, 0x07, 0x01, 0x02,
        0x00, 0x18, 0xa4, 0x3a, 0x4b, 0x2f, 0x11,
    ];

    /// shuffle=BYTE, typesize=4.
    /// `python3 -c "import blosc; print(blosc.compress(bytes([i%8 for i in range(256)]), typesize=4, cname='zstd', shuffle=blosc.SHUFFLE))"`
    const ENC_BYTE_TS4: &[u8] = &[
        0x02, 0x01, 0x91, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x36, 0x00, 0x00,
        0x00, 0x14, 0x00, 0x00, 0x00, 0x1e, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x00,
        0x00, 0xa5, 0x00, 0x00, 0x48, 0x00, 0x04, 0x01, 0x05, 0x02, 0x06, 0x03, 0x07, 0x03, 0x04,
        0x04, 0x27, 0x02, 0x63, 0x00, 0x0f, 0xe0, 0xe5, 0xb0,
    ];

    /// shuffle=BIT, typesize=1.
    /// `python3 -c "import blosc; print(blosc.compress(bytes([i%8 for i in range(256)]), typesize=1, cname='zstd', shuffle=blosc.BITSHUFFLE))"`
    const ENC_BIT_TS1: &[u8] = &[
        0x02, 0x01, 0x94, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x32, 0x00, 0x00,
        0x00, 0x14, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x00,
        0x00, 0x85, 0x00, 0x00, 0x28, 0xaa, 0xcc, 0xf0, 0x00, 0x00, 0x04, 0x10, 0x00, 0x1b, 0x0a,
        0x1b, 0xd6, 0x48, 0x73, 0x05,
    ];

    /// shuffle=BIT, typesize=2.
    /// `python3 -c "import blosc; print(blosc.compress(bytes([i%8 for i in range(256)]), typesize=2, cname='zstd', shuffle=blosc.BITSHUFFLE))"`
    const ENC_BIT_TS2: &[u8] = &[
        0x02, 0x01, 0x94, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x37, 0x00, 0x00,
        0x00, 0x14, 0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x00,
        0x00, 0xad, 0x00, 0x00, 0x30, 0x00, 0xaa, 0xcc, 0x00, 0xff, 0xaa, 0x06, 0x60, 0x01, 0xc0,
        0xb3, 0x07, 0x6c, 0x90, 0x76, 0x8c, 0xea, 0xba, 0x8e, 0x05,
    ];

    /// shuffle=BIT, typesize=4.
    /// `python3 -c "import blosc; print(blosc.compress(bytes([i%8 for i in range(256)]), typesize=4, cname='zstd', shuffle=blosc.BITSHUFFLE))"`
    const ENC_BIT_TS4: &[u8] = &[
        0x02, 0x01, 0x94, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x3b, 0x00, 0x00,
        0x00, 0x14, 0x00, 0x00, 0x00, 0x23, 0x00, 0x00, 0x00, 0x28, 0xb5, 0x2f, 0xfd, 0x60, 0x00,
        0x00, 0xcd, 0x00, 0x00, 0x20, 0x00, 0xaa, 0x00, 0xff, 0x08, 0x80, 0xe0, 0x3e, 0x75, 0xa7,
        0x0e, 0xfe, 0x74, 0x89, 0xf2, 0x10, 0x30, 0xe0, 0x02, 0x4a, 0xe0, 0x76, 0x60, 0x07,
    ];

    /// MEMCPYED test: 64 bytes pseudo-random (Python random.seed(42)),
    /// typesize=2, bitshuffle requested but blosc fell back to memcpy because
    /// random data didn't compress.
    const PLAINTEXT_MEMCPY: &[u8] = &[
        0x39, 0x0c, 0x8c, 0x7d, 0x72, 0x47, 0x34, 0x2c, 0xd8, 0x10, 0x0f, 0x2f, 0x6f, 0x77, 0x0d,
        0x65, 0xd6, 0x70, 0xe5, 0x8e, 0x03, 0x51, 0xd8, 0xae, 0x8e, 0x4f, 0x6e, 0xac, 0x34, 0x2f,
        0xc2, 0x31, 0xb7, 0xb0, 0x87, 0x16, 0xeb, 0x3f, 0xc1, 0x28, 0x96, 0xb9, 0x62, 0x23, 0x17,
        0x74, 0x94, 0x28, 0x77, 0x33, 0xc2, 0x8e, 0xe8, 0xba, 0x53, 0xbd, 0xb5, 0x6b, 0x88, 0x24,
        0x57, 0x7d, 0x53, 0xec,
    ];

    /// `import blosc, random; random.seed(42); plain = bytes([random.randint(0,255) for _ in range(64)]); print(blosc.compress(plain, typesize=2, cname='zstd', shuffle=blosc.BITSHUFFLE))`
    const ENC_MEMCPY: &[u8] = &[
        0x02, 0x01, 0x96, 0x02, 0x40, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x50, 0x00, 0x00,
        0x00, 0x39, 0x0c, 0x8c, 0x7d, 0x72, 0x47, 0x34, 0x2c, 0xd8, 0x10, 0x0f, 0x2f, 0x6f, 0x77,
        0x0d, 0x65, 0xd6, 0x70, 0xe5, 0x8e, 0x03, 0x51, 0xd8, 0xae, 0x8e, 0x4f, 0x6e, 0xac, 0x34,
        0x2f, 0xc2, 0x31, 0xb7, 0xb0, 0x87, 0x16, 0xeb, 0x3f, 0xc1, 0x28, 0x96, 0xb9, 0x62, 0x23,
        0x17, 0x74, 0x94, 0x28, 0x77, 0x33, 0xc2, 0x8e, 0xe8, 0xba, 0x53, 0xbd, 0xb5, 0x6b, 0x88,
        0x24, 0x57, 0x7d, 0x53, 0xec,
    ];

    // --- Tests ---

    macro_rules! roundtrip_case {
        ($name:ident, $vec:ident, $shuffle:expr, $ts:expr) => {
            #[test]
            fn $name() {
                let out = decode_blosc($vec, &cfg($ts, $shuffle)).unwrap();
                assert_eq!(out, PLAINTEXT, "decoded bytes did not match plaintext");
            }
        };
    }

    roundtrip_case!(decode_none_ts1, ENC_NONE_TS1, BloscShuffle::None, 1);
    roundtrip_case!(decode_none_ts2, ENC_NONE_TS2, BloscShuffle::None, 2);
    roundtrip_case!(decode_none_ts4, ENC_NONE_TS4, BloscShuffle::None, 4);
    roundtrip_case!(decode_byte_ts1, ENC_BYTE_TS1, BloscShuffle::Byte, 1);
    roundtrip_case!(decode_byte_ts2, ENC_BYTE_TS2, BloscShuffle::Byte, 2);
    roundtrip_case!(decode_byte_ts4, ENC_BYTE_TS4, BloscShuffle::Byte, 4);
    roundtrip_case!(decode_bit_ts1, ENC_BIT_TS1, BloscShuffle::Bit, 1);
    roundtrip_case!(decode_bit_ts2, ENC_BIT_TS2, BloscShuffle::Bit, 2);
    roundtrip_case!(decode_bit_ts4, ENC_BIT_TS4, BloscShuffle::Bit, 4);

    #[test]
    fn decode_memcpyed_passes_through() {
        let out = decode_blosc(ENC_MEMCPY, &cfg(2, BloscShuffle::Bit)).unwrap();
        assert_eq!(out, PLAINTEXT_MEMCPY);
    }

    #[test]
    fn rejects_short_header() {
        let err = decode_blosc(&[0u8; 8], &cfg(2, BloscShuffle::Bit)).unwrap_err();
        assert!(matches!(err, BloscError::HeaderTruncated(8)));
    }

    #[test]
    fn rejects_unsupported_version() {
        let mut bad = ENC_BIT_TS2.to_vec();
        bad[0] = 99;
        let err = decode_blosc(&bad, &cfg(2, BloscShuffle::Bit)).unwrap_err();
        assert!(matches!(err, BloscError::UnsupportedVersion(99)));
    }

    #[test]
    fn rejects_typesize_mismatch() {
        let err = decode_blosc(ENC_BIT_TS2, &cfg(4, BloscShuffle::Bit)).unwrap_err();
        match err {
            BloscError::TypesizeMismatch { header, config } => {
                assert_eq!(header, 2);
                assert_eq!(config, 4);
            }
            other => panic!("wrong error: {other:?}"),
        }
    }

    #[test]
    fn rejects_shuffle_mismatch() {
        let err = decode_blosc(ENC_BIT_TS2, &cfg(2, BloscShuffle::Byte)).unwrap_err();
        assert!(matches!(err, BloscError::ShuffleMismatch { .. }));
    }

    #[test]
    fn rejects_unsupported_compressor() {
        let mut bad = ENC_BIT_TS2.to_vec();
        // Wipe the compressor bits (bits 5-7) to encode lz4 (=1)
        bad[2] = (bad[2] & 0x1F) | (1 << 5);
        let err = decode_blosc(&bad, &cfg(2, BloscShuffle::Bit)).unwrap_err();
        assert!(matches!(err, BloscError::UnsupportedCompressor { code: 1 }));
    }

    #[test]
    fn rejects_truncated_payload() {
        let truncated = &ENC_BIT_TS2[..ENC_BIT_TS2.len() - 4];
        let err = decode_blosc(truncated, &cfg(2, BloscShuffle::Bit)).unwrap_err();
        assert!(matches!(err, BloscError::InputTruncated { .. }));
    }

    #[test]
    fn byte_unshuffle_typesize_1_is_identity() {
        let input = vec![0x10, 0x20, 0x30, 0x40];
        let out = byte_unshuffle(&input, 1);
        assert_eq!(out, input);
    }

    #[test]
    fn byte_unshuffle_typesize_2_round_trip() {
        // shuffled layout for 4 elements of 2 bytes each:
        // [b0_e0, b0_e1, b0_e2, b0_e3, b1_e0, b1_e1, b1_e2, b1_e3]
        let shuffled = vec![0x10, 0x20, 0x30, 0x40, 0x11, 0x21, 0x31, 0x41];
        let out = byte_unshuffle(&shuffled, 2);
        assert_eq!(out, vec![0x10, 0x11, 0x20, 0x21, 0x30, 0x31, 0x40, 0x41]);
    }
}

// FROZEN ORACLE — generated; do not edit by hand. Covers blosc partial-trailing-block
// decode across shuffle x typesize, plus aligned/memcpy/single-block CONTROLS.
#[cfg(test)]
mod partial_block_oracle {
    use super::decode_blosc;
    use lucida_store::codec::{BloscCompressor, BloscConfig, BloscShuffle};
    fn ocfg(ts: u8, s: BloscShuffle) -> BloscConfig {
        BloscConfig {
            typesize: ts,
            cname: BloscCompressor::Zstd,
            shuffle: s,
        }
    }
    fn pat(n: usize, ts: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(n * ts);
        for i in 0..n {
            let e = (i % 251) as u64;
            v.extend_from_slice(&e.to_le_bytes()[..ts]);
        }
        v
    }
    const ENC_BIT_TS2_PARTIAL: &[u8] = &[
        2, 1, 148, 2, 22, 39, 0, 0, 0, 16, 0, 0, 195, 3, 0, 0, 131, 1, 0, 0, 161, 2, 0, 0, 28, 0,
        0, 0, 99, 1, 0, 0, 40, 181, 47, 253, 96, 22, 6, 205, 10, 0, 102, 159, 83, 13, 16, 248, 108,
        7, 255, 255, 191, 3, 41, 165, 148, 50, 5, 79, 0, 79, 0, 78, 0, 15, 53, 180, 80, 66, 7, 21,
        52, 80, 64, 255, 244, 179, 79, 62, 247, 212, 51, 79, 60, 239, 180, 179, 78, 58, 231, 148,
        51, 78, 56, 223, 116, 179, 77, 54, 215, 84, 51, 77, 52, 207, 52, 179, 76, 50, 199, 20, 51,
        76, 48, 191, 244, 178, 75, 46, 183, 212, 50, 75, 44, 175, 180, 178, 74, 42, 167, 148, 50,
        74, 40, 159, 116, 178, 73, 38, 151, 84, 50, 73, 141, 45, 150, 216, 97, 133, 13, 22, 216,
        95, 125, 237, 149, 215, 93, 117, 205, 21, 215, 91, 109, 173, 149, 214, 89, 101, 141, 21,
        214, 87, 93, 109, 149, 213, 85, 85, 77, 21, 213, 83, 77, 45, 149, 212, 81, 69, 13, 21, 212,
        79, 61, 237, 148, 211, 77, 53, 205, 20, 211, 75, 45, 173, 148, 210, 73, 37, 141, 20, 210,
        71, 29, 109, 148, 209, 69, 21, 77, 20, 81, 21, 76, 16, 193, 3, 13, 44, 144, 192, 1, 5, 12,
        16, 192, 191, 126, 251, 242, 221, 171, 247, 121, 229, 141, 23, 222, 119, 221, 109, 151,
        221, 117, 213, 77, 23, 221, 115, 205, 45, 151, 220, 113, 197, 13, 23, 220, 111, 189, 237,
        150, 219, 109, 181, 205, 22, 219, 107, 173, 173, 150, 218, 105, 165, 141, 22, 218, 103,
        157, 109, 150, 217, 101, 149, 77, 22, 217, 99, 1, 145, 60, 210, 200, 34, 137, 28, 82, 200,
        32, 129, 252, 209, 199, 30, 121, 220, 81, 199, 28, 113, 188, 209, 198, 26, 105, 156, 81,
        198, 24, 97, 124, 209, 197, 22, 89, 92, 81, 197, 20, 81, 60, 209, 196, 18, 73, 28, 81, 196,
        16, 65, 252, 208, 195, 14, 57, 220, 80, 195, 12, 49, 188, 208, 194, 10, 41, 156, 80, 194,
        8, 33, 124, 208, 193, 6, 25, 92, 16, 1, 0, 246, 29, 229, 255, 107, 10, 26, 1, 0, 0, 40,
        181, 47, 253, 96, 0, 15, 133, 8, 0, 66, 203, 35, 38, 144, 41, 173, 6, 210, 170, 111, 199,
        152, 45, 191, 232, 38, 215, 62, 12, 19, 169, 127, 240, 245, 205, 58, 33, 198, 46, 43, 39,
        234, 181, 108, 219, 161, 13, 66, 250, 78, 1, 247, 157, 42, 55, 101, 175, 194, 81, 231, 165,
        110, 213, 248, 233, 75, 210, 176, 5, 209, 44, 78, 197, 211, 251, 254, 36, 127, 83, 246,
        175, 194, 31, 205, 191, 212, 253, 42, 254, 167, 239, 36, 55, 101, 175, 194, 209, 188, 212,
        173, 226, 167, 253, 244, 0, 164, 89, 140, 1, 193, 197, 44, 202, 21, 196, 211, 97, 128, 153,
        112, 13, 168, 84, 60, 131, 227, 192, 96, 210, 120, 56, 8, 24, 8, 9, 69, 227, 16, 96, 44,
        36, 13, 57, 104, 18, 200, 64, 139, 64, 20, 26, 4, 146, 208, 2, 95, 168, 80, 210, 219, 28,
        160, 195, 180, 114, 18, 160, 80, 72, 56, 130, 51, 34, 65, 40, 2, 132, 160, 34, 72, 72, 8,
        133, 243, 253, 63, 3, 1, 104, 206, 20, 252, 231, 170, 132, 142, 108, 22, 160, 176, 114, 48,
        215, 201, 81, 66, 81, 88, 39, 131, 36, 170, 100, 202, 241, 96, 172, 147, 81, 82, 100, 166,
        41, 11, 59, 98, 246, 96, 210, 200, 147, 116, 9, 100, 72, 0, 168, 53, 52, 27, 110, 65, 122,
        152, 5, 52, 117, 239, 36, 180, 157, 8, 72, 111, 49, 201, 0, 134, 166, 165, 15, 208, 121,
        19, 131, 235, 68, 104, 141, 76, 7, 77, 43, 34, 101, 28, 13, 45, 160, 98, 103, 30, 1, 0, 0,
        40, 181, 47, 253, 96, 0, 15, 165, 8, 0, 82, 10, 34, 39, 160, 39, 173, 6, 178, 58, 27, 141,
        63, 151, 197, 123, 59, 207, 87, 183, 141, 209, 29, 251, 78, 242, 32, 173, 248, 103, 88, 30,
        141, 152, 188, 49, 109, 129, 57, 149, 176, 157, 2, 175, 62, 183, 211, 230, 53, 58, 42, 122,
        92, 147, 169, 26, 184, 38, 218, 248, 43, 250, 159, 117, 127, 91, 249, 167, 250, 155, 133,
        255, 154, 63, 250, 221, 184, 162, 159, 117, 183, 149, 167, 186, 89, 248, 154, 163, 87, 69,
        4, 61, 205, 17, 36, 121, 168, 102, 193, 198, 68, 175, 76, 156, 5, 88, 144, 76, 67, 116, 32,
        3, 39, 23, 229, 0, 97, 36, 0, 11, 131, 130, 40, 146, 129, 229, 177, 199, 83, 96, 139, 151,
        192, 4, 30, 2, 11, 120, 1, 102, 160, 144, 16, 83, 7, 176, 131, 180, 114, 6, 240, 62, 94,
        100, 206, 87, 249, 227, 133, 196, 249, 146, 115, 188, 72, 62, 95, 114, 142, 151, 35, 193,
        58, 23, 82, 180, 112, 174, 51, 197, 75, 182, 98, 214, 36, 98, 37, 19, 117, 67, 153, 173,
        206, 56, 7, 12, 201, 84, 94, 126, 118, 7, 187, 98, 187, 112, 115, 128, 157, 108, 105, 39,
        75, 178, 165, 157, 170, 237, 26, 90, 237, 210, 205, 77, 204, 50, 132, 217, 194, 101, 8,
        179, 149, 177, 85, 98, 115, 231, 118, 231, 77, 76, 247, 238, 234, 61, 32, 45, 145, 251, 98,
        241, 155, 226, 91, 75, 5, 209, 27, 177, 59, 49, 145, 247, 235, 98, 226, 59, 209, 173, 27,
        177, 187, 197, 98, 69,
    ];
    const ENC_BIT_TS1_PARTIAL: &[u8] = &[
        2, 1, 148, 1, 41, 35, 0, 0, 0, 16, 0, 0, 169, 3, 0, 0, 47, 1, 0, 0, 84, 2, 0, 0, 28, 0, 0,
        0, 15, 1, 0, 0, 40, 181, 47, 253, 96, 41, 2, 45, 8, 0, 180, 15, 160, 161, 162, 163, 164,
        165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182,
        183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200,
        201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218,
        219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236,
        237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 0, 1, 2, 3, 4, 5, 6,
        7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
        30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
        53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75,
        76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98,
        99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116,
        117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134,
        135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152,
        153, 154, 155, 156, 157, 158, 159, 1, 0, 251, 21, 254, 202, 72, 1, 33, 1, 0, 0, 40, 181,
        47, 253, 96, 0, 15, 189, 8, 0, 2, 203, 34, 36, 160, 169, 88, 13, 178, 58, 27, 150, 154,
        225, 240, 222, 78, 222, 232, 191, 137, 231, 152, 59, 233, 65, 173, 217, 25, 126, 104, 185,
        220, 232, 23, 24, 179, 136, 217, 41, 125, 163, 202, 75, 217, 171, 240, 211, 57, 169, 59,
        53, 110, 126, 72, 22, 182, 224, 153, 196, 165, 104, 218, 247, 35, 249, 151, 178, 127, 21,
        254, 103, 254, 164, 238, 79, 241, 55, 109, 223, 72, 94, 202, 94, 133, 159, 57, 169, 59,
        197, 77, 71, 15, 64, 150, 197, 24, 14, 92, 76, 146, 92, 65, 52, 61, 160, 76, 184, 134, 67,
        42, 158, 129, 113, 96, 208, 241, 192, 32, 104, 32, 60, 40, 28, 12, 129, 198, 194, 163, 169,
        131, 38, 161, 6, 90, 132, 82, 104, 16, 42, 161, 5, 98, 168, 112, 208, 155, 14, 160, 3, 181,
        26, 18, 64, 32, 72, 48, 130, 132, 32, 195, 33, 132, 34, 64, 8, 42, 130, 132, 68, 88, 56,
        155, 127, 121, 2, 215, 3, 141, 111, 115, 59, 87, 73, 38, 131, 60, 143, 9, 190, 119, 239,
        223, 25, 156, 122, 68, 47, 23, 125, 195, 33, 186, 133, 152, 8, 88, 107, 248, 134, 67, 244,
        88, 140, 142, 29, 90, 44, 70, 224, 167, 233, 146, 75, 103, 250, 9, 37, 166, 138, 210, 8,
        40, 63, 3, 38, 208, 160, 27, 155, 108, 107, 119, 203, 29, 255, 119, 96, 128, 55, 41, 182,
        137, 198, 17, 24, 14, 34, 19, 54, 240, 16, 72, 207, 154, 1, 91, 252, 223, 177, 31, 137,
        166, 152, 116, 73, 188, 214, 4, 81, 1, 0, 0, 40, 181, 47, 253, 96, 0, 15, 61, 10, 0, 34,
        75, 35, 38, 144, 41, 173, 6, 210, 116, 237, 50, 152, 89, 126, 209, 77, 174, 125, 24, 38,
        82, 255, 224, 235, 155, 53, 99, 132, 213, 91, 53, 234, 181, 108, 219, 161, 13, 66, 250, 78,
        1, 189, 240, 84, 185, 105, 155, 53, 142, 58, 47, 125, 171, 38, 159, 97, 146, 166, 177, 136,
        102, 121, 234, 194, 63, 201, 223, 180, 253, 172, 241, 71, 243, 47, 125, 191, 74, 254, 83,
        120, 146, 155, 182, 89, 227, 104, 94, 250, 86, 201, 231, 219, 4, 1, 164, 97, 141, 1, 197,
        197, 44, 234, 21, 36, 167, 199, 0, 51, 241, 26, 80, 169, 128, 6, 199, 161, 69, 164, 241,
        112, 16, 48, 16, 16, 138, 198, 33, 192, 88, 64, 220, 58, 112, 18, 107, 192, 69, 44, 5, 7,
        177, 18, 92, 128, 140, 168, 240, 76, 167, 3, 176, 131, 180, 26, 18, 64, 48, 48, 40, 2, 132,
        33, 64, 49, 150, 131, 41, 2, 20, 19, 24, 33, 97, 196, 145, 45, 255, 30, 109, 255, 201, 9,
        48, 169, 209, 190, 165, 163, 123, 90, 75, 51, 40, 22, 6, 87, 155, 198, 253, 207, 132, 20,
        186, 73, 165, 11, 96, 127, 134, 165, 64, 194, 73, 100, 7, 184, 251, 4, 21, 33, 48, 52, 231,
        167, 18, 158, 230, 32, 105, 63, 12, 93, 25, 217, 4, 43, 91, 217, 4, 43, 27, 72, 119, 167,
        62, 9, 201, 75, 70, 50, 153, 82, 229, 214, 26, 4, 192, 18, 47, 32, 123, 115, 62, 21, 152,
        23, 240, 130, 69, 94, 193, 45, 109, 129, 173, 118, 183, 216, 122, 218, 6, 118, 250, 155,
        93, 95, 229, 160, 246, 17, 61, 20, 207, 10, 50, 218, 49, 14, 26, 173, 142, 187, 98, 35,
        214, 46, 31, 45, 227, 181, 89, 42, 141, 249, 109, 63, 199, 220, 25, 246, 120, 7, 108, 162,
        54, 7,
    ];
    const ENC_BIT_TS4_PARTIAL: &[u8] = &[
        2, 1, 148, 4, 236, 46, 0, 0, 0, 16, 0, 0, 33, 3, 0, 0, 115, 2, 0, 0, 28, 0, 0, 0, 202, 0,
        0, 0, 170, 0, 0, 0, 40, 181, 47, 253, 96, 0, 15, 5, 5, 0, 242, 133, 19, 30, 176, 39, 141,
        1, 160, 103, 113, 233, 172, 129, 166, 82, 64, 4, 185, 240, 104, 200, 66, 175, 11, 78, 162,
        85, 53, 213, 26, 128, 79, 1, 111, 211, 119, 243, 20, 251, 223, 252, 237, 252, 84, 252, 239,
        106, 107, 190, 253, 230, 118, 166, 226, 103, 174, 110, 121, 28, 58, 60, 148, 1, 80, 131,
        129, 168, 68, 145, 24, 8, 12, 133, 164, 32, 132, 178, 64, 2, 37, 54, 160, 176, 78, 55, 237,
        6, 176, 195, 100, 56, 1, 244, 222, 175, 100, 199, 123, 201, 243, 78, 2, 220, 69, 190, 99,
        70, 141, 131, 232, 33, 88, 17, 75, 120, 182, 105, 151, 201, 45, 155, 66, 32, 182, 108, 239,
        96, 203, 125, 201, 80, 198, 130, 233, 65, 43, 220, 223, 69, 247, 99, 21, 16, 185, 41, 150,
        13, 40, 114, 35, 34, 178, 42, 190, 101, 177, 132, 86, 4, 165, 1, 0, 0, 40, 181, 47, 253,
        96, 236, 13, 221, 12, 0, 102, 126, 99, 13, 16, 248, 108, 7, 255, 255, 191, 3, 41, 165, 148,
        50, 5, 95, 0, 94, 0, 95, 0, 191, 220, 203, 187, 156, 203, 183, 92, 203, 179, 28, 203, 175,
        220, 202, 171, 156, 202, 167, 92, 202, 163, 28, 202, 159, 220, 201, 155, 156, 201, 151, 92,
        201, 147, 28, 201, 143, 220, 200, 139, 156, 200, 135, 92, 200, 131, 28, 200, 127, 220, 199,
        123, 156, 199, 119, 92, 199, 115, 28, 199, 111, 220, 198, 107, 156, 198, 103, 92, 198, 99,
        28, 198, 95, 220, 197, 91, 156, 197, 87, 92, 197, 83, 28, 197, 79, 220, 196, 75, 156, 196,
        71, 92, 196, 67, 4, 239, 116, 78, 223, 116, 77, 207, 116, 76, 191, 116, 75, 175, 116, 74,
        159, 116, 73, 143, 116, 72, 127, 116, 71, 111, 116, 70, 95, 116, 69, 79, 116, 68, 63, 116,
        67, 47, 116, 66, 31, 116, 65, 15, 116, 64, 255, 115, 63, 239, 115, 62, 223, 115, 61, 207,
        115, 60, 191, 115, 59, 175, 115, 58, 159, 115, 57, 143, 115, 56, 127, 115, 55, 111, 115,
        54, 95, 115, 53, 79, 115, 52, 63, 115, 51, 47, 115, 50, 31, 115, 49, 15, 115, 48, 7, 185,
        125, 219, 181, 61, 219, 177, 253, 218, 173, 189, 218, 169, 125, 218, 165, 61, 218, 161,
        253, 217, 157, 189, 217, 153, 125, 217, 149, 61, 217, 145, 253, 216, 141, 189, 216, 137,
        125, 216, 133, 61, 216, 129, 253, 215, 125, 189, 215, 121, 125, 215, 117, 61, 215, 113,
        253, 214, 109, 189, 214, 105, 125, 214, 101, 61, 214, 97, 253, 213, 93, 189, 213, 89, 125,
        213, 85, 61, 213, 81, 253, 212, 77, 189, 212, 73, 125, 212, 69, 61, 212, 65, 253, 211, 61,
        5, 7, 241, 15, 247, 240, 14, 231, 240, 13, 215, 240, 12, 199, 240, 11, 183, 240, 10, 167,
        240, 9, 151, 240, 8, 135, 240, 7, 119, 240, 6, 103, 240, 5, 87, 240, 4, 71, 240, 3, 55,
        240, 2, 39, 240, 1, 23, 240, 0, 7, 240, 191, 251, 189, 239, 124, 223, 187, 222, 121, 151,
        247, 120, 135, 247, 119, 119, 247, 118, 103, 247, 117, 87, 247, 116, 71, 247, 115, 55, 247,
        114, 39, 247, 113, 23, 247, 112, 7, 247, 111, 247, 246, 110, 7, 2, 0, 156, 126, 189, 23,
        94, 82, 10, 230, 210, 170, 0, 0, 0, 40, 181, 47, 253, 96, 0, 15, 5, 5, 0, 194, 69, 20, 30,
        176, 39, 141, 1, 23, 111, 153, 121, 37, 120, 96, 48, 88, 97, 58, 73, 115, 77, 20, 204, 23,
        73, 116, 96, 14, 4, 62, 166, 203, 20, 77, 197, 102, 83, 97, 73, 235, 151, 254, 42, 254, 37,
        127, 123, 244, 165, 171, 120, 201, 173, 253, 67, 72, 170, 130, 130, 180, 126, 87, 15, 199,
        192, 18, 8, 116, 78, 99, 17, 0, 28, 12, 199, 24, 70, 82, 48, 138, 132, 96, 2, 50, 160, 144,
        142, 110, 117, 160, 3, 101, 56, 237, 243, 73, 60, 146, 137, 75, 158, 111, 143, 4, 130, 145,
        211, 158, 131, 56, 138, 153, 179, 138, 151, 89, 213, 47, 99, 246, 55, 139, 66, 118, 179,
        229, 218, 140, 124, 175, 52, 180, 172, 102, 144, 177, 97, 226, 97, 239, 185, 225, 189, 222,
        221, 139, 220, 46, 94, 156, 248, 118, 113, 119, 98, 113, 3, 177, 153,
    ];
    const ENC_BYTE_TS2_PARTIAL: &[u8] = &[
        2, 1, 145, 2, 22, 39, 0, 0, 0, 16, 0, 0, 97, 3, 0, 0, 28, 0, 0, 0, 51, 1, 0, 0, 74, 2, 0,
        0, 19, 1, 0, 0, 40, 181, 47, 253, 96, 0, 15, 77, 8, 0, 196, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8,
        9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
        32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54,
        55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77,
        78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
        100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117,
        118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135,
        136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153,
        154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171,
        172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189,
        190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207,
        208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225,
        226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243,
        244, 245, 246, 247, 248, 249, 250, 0, 2, 0, 252, 227, 191, 216, 11, 236, 255, 141, 20, 19,
        1, 0, 0, 40, 181, 47, 253, 96, 0, 15, 77, 8, 0, 196, 15, 40, 41, 42, 43, 44, 45, 46, 47,
        48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70,
        71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93,
        94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112,
        113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130,
        131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148,
        149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166,
        167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184,
        185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202,
        203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220,
        221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238,
        239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
        10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
        33, 34, 35, 36, 37, 38, 39, 0, 2, 0, 252, 227, 191, 216, 11, 236, 255, 141, 20, 19, 1, 0,
        0, 40, 181, 47, 253, 96, 22, 6, 77, 8, 0, 196, 15, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
        90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
        110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127,
        128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145,
        146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163,
        164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181,
        182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199,
        200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217,
        218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235,
        236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 0, 1, 2, 3, 4,
        5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
        29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51,
        52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74,
        75, 76, 77, 78, 79, 0, 2, 0, 135, 241, 74, 236, 27, 249, 43, 35, 5,
    ];
    const ENC_BYTE_TS4_PARTIAL: &[u8] = &[
        2, 1, 145, 4, 236, 46, 0, 0, 0, 16, 0, 0, 97, 3, 0, 0, 28, 0, 0, 0, 51, 1, 0, 0, 74, 2, 0,
        0, 19, 1, 0, 0, 40, 181, 47, 253, 96, 0, 15, 77, 8, 0, 196, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8,
        9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
        32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54,
        55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77,
        78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
        100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117,
        118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135,
        136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153,
        154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171,
        172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189,
        190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207,
        208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225,
        226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243,
        244, 245, 246, 247, 248, 249, 250, 0, 2, 0, 252, 195, 125, 177, 23, 232, 175, 140, 20, 19,
        1, 0, 0, 40, 181, 47, 253, 96, 0, 15, 77, 8, 0, 196, 15, 20, 21, 22, 23, 24, 25, 26, 27,
        28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
        51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73,
        74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96,
        97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115,
        116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133,
        134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151,
        152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169,
        170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187,
        188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205,
        206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223,
        224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241,
        242, 243, 244, 245, 246, 247, 248, 249, 250, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
        14, 15, 16, 17, 18, 19, 0, 2, 0, 252, 195, 125, 177, 23, 232, 175, 140, 20, 19, 1, 0, 0,
        40, 181, 47, 253, 96, 236, 13, 77, 8, 0, 196, 15, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
        50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72,
        73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95,
        96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114,
        115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132,
        133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150,
        151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168,
        169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186,
        187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204,
        205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222,
        223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240,
        241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
        36, 37, 38, 39, 0, 2, 0, 45, 195, 125, 177, 239, 229, 175, 140, 20,
    ];
    const ENC_NONE_TS2_PARTIAL: &[u8] = &[
        2, 1, 144, 2, 22, 39, 0, 0, 0, 16, 0, 0, 80, 4, 0, 0, 28, 0, 0, 0, 131, 1, 0, 0, 233, 2, 0,
        0, 99, 1, 0, 0, 40, 181, 47, 253, 96, 0, 15, 205, 10, 0, 102, 159, 83, 13, 16, 248, 108, 7,
        255, 255, 191, 3, 41, 165, 148, 50, 5, 78, 0, 79, 0, 79, 0, 111, 180, 177, 70, 26, 103,
        148, 49, 70, 24, 95, 116, 177, 69, 22, 87, 84, 49, 69, 20, 79, 52, 177, 68, 18, 71, 20, 49,
        68, 16, 63, 244, 176, 67, 14, 55, 212, 48, 67, 12, 47, 180, 176, 66, 10, 39, 148, 48, 66,
        8, 31, 116, 176, 65, 6, 23, 84, 48, 65, 4, 15, 52, 176, 64, 2, 7, 20, 48, 64, 0, 255, 250,
        237, 203, 119, 175, 222, 1, 237, 172, 147, 206, 57, 229, 140, 19, 206, 55, 221, 108, 147,
        205, 53, 213, 76, 19, 205, 51, 205, 44, 147, 204, 49, 197, 12, 19, 204, 47, 189, 236, 146,
        203, 45, 181, 204, 18, 203, 43, 173, 172, 146, 202, 41, 165, 140, 18, 202, 39, 157, 108,
        146, 201, 37, 149, 76, 18, 201, 35, 141, 44, 146, 200, 33, 133, 12, 18, 200, 31, 125, 236,
        145, 199, 29, 117, 204, 17, 71, 107, 165, 117, 86, 89, 99, 133, 245, 85, 87, 91, 101, 117,
        85, 85, 83, 69, 245, 84, 83, 75, 37, 117, 84, 81, 67, 5, 245, 83, 79, 59, 229, 116, 83, 77,
        51, 197, 244, 82, 75, 43, 165, 116, 82, 73, 35, 133, 244, 81, 71, 27, 101, 116, 81, 69, 19,
        69, 244, 80, 67, 11, 37, 116, 80, 65, 3, 5, 244, 79, 63, 251, 228, 115, 79, 61, 243, 196,
        243, 78, 231, 149, 55, 94, 120, 223, 117, 183, 93, 118, 215, 85, 55, 93, 116, 207, 53, 183,
        92, 114, 199, 21, 55, 92, 112, 191, 245, 182, 91, 110, 183, 213, 54, 91, 108, 175, 181,
        182, 90, 106, 167, 149, 54, 90, 104, 159, 117, 182, 89, 102, 151, 85, 54, 89, 100, 143, 53,
        182, 88, 98, 135, 21, 54, 88, 96, 127, 245, 181, 87, 94, 119, 213, 53, 87, 92, 111, 181,
        21, 1, 0, 246, 7, 206, 247, 215, 20, 98, 1, 0, 0, 40, 181, 47, 253, 96, 0, 15, 197, 10, 0,
        102, 95, 83, 13, 16, 248, 108, 7, 255, 255, 191, 3, 41, 165, 148, 50, 5, 79, 0, 79, 0, 79,
        0, 191, 244, 178, 75, 46, 183, 212, 50, 75, 44, 175, 180, 178, 74, 42, 167, 148, 50, 74,
        40, 159, 116, 178, 73, 38, 151, 84, 50, 73, 36, 143, 52, 178, 72, 34, 135, 20, 50, 72, 32,
        127, 244, 177, 71, 30, 119, 212, 49, 71, 28, 111, 180, 177, 70, 26, 103, 148, 49, 70, 24,
        95, 116, 177, 69, 22, 87, 84, 49, 69, 20, 79, 52, 177, 68, 18, 71, 20, 49, 68, 61, 237,
        148, 211, 77, 53, 205, 20, 211, 75, 45, 173, 148, 210, 73, 37, 141, 20, 210, 71, 29, 109,
        148, 209, 69, 21, 77, 20, 209, 67, 13, 45, 148, 208, 65, 5, 13, 20, 208, 63, 253, 236, 147,
        207, 61, 245, 204, 19, 207, 59, 237, 172, 147, 206, 57, 229, 140, 19, 206, 55, 221, 108,
        147, 205, 53, 213, 76, 19, 205, 51, 205, 44, 147, 204, 49, 197, 12, 19, 76, 187, 229, 118,
        91, 109, 179, 197, 246, 90, 107, 171, 165, 118, 90, 105, 163, 133, 246, 89, 103, 155, 101,
        118, 89, 101, 147, 69, 246, 88, 99, 139, 37, 118, 88, 97, 131, 5, 246, 87, 95, 123, 229,
        117, 87, 93, 115, 197, 245, 86, 91, 107, 165, 117, 86, 89, 99, 133, 245, 85, 87, 91, 101,
        117, 85, 85, 83, 69, 245, 84, 83, 75, 37, 117, 84, 81, 67, 5, 245, 83, 65, 252, 208, 195,
        14, 57, 220, 80, 195, 12, 49, 188, 208, 194, 10, 41, 156, 80, 194, 8, 33, 124, 208, 193, 6,
        25, 92, 80, 193, 4, 17, 60, 208, 192, 2, 9, 28, 80, 192, 0, 1, 252, 235, 183, 47, 223, 189,
        122, 159, 87, 222, 120, 225, 125, 215, 221, 118, 217, 93, 87, 221, 116, 209, 61, 215, 220,
        114, 201, 29, 87, 220, 112, 193, 253, 214, 91, 1, 0, 246, 7, 206, 247, 215, 20, 99, 1, 0,
        0, 40, 181, 47, 253, 96, 22, 6, 205, 10, 0, 102, 159, 83, 13, 16, 248, 108, 7, 255, 255,
        191, 3, 41, 165, 148, 50, 5, 79, 0, 79, 0, 78, 0, 15, 53, 180, 80, 66, 7, 21, 52, 80, 64,
        255, 244, 179, 79, 62, 247, 212, 51, 79, 60, 239, 180, 179, 78, 58, 231, 148, 51, 78, 56,
        223, 116, 179, 77, 54, 215, 84, 51, 77, 52, 207, 52, 179, 76, 50, 199, 20, 51, 76, 48, 191,
        244, 178, 75, 46, 183, 212, 50, 75, 44, 175, 180, 178, 74, 42, 167, 148, 50, 74, 40, 159,
        116, 178, 73, 38, 151, 84, 50, 73, 141, 45, 150, 216, 97, 133, 13, 22, 216, 95, 125, 237,
        149, 215, 93, 117, 205, 21, 215, 91, 109, 173, 149, 214, 89, 101, 141, 21, 214, 87, 93,
        109, 149, 213, 85, 85, 77, 21, 213, 83, 77, 45, 149, 212, 81, 69, 13, 21, 212, 79, 61, 237,
        148, 211, 77, 53, 205, 20, 211, 75, 45, 173, 148, 210, 73, 37, 141, 20, 210, 71, 29, 109,
        148, 209, 69, 21, 77, 20, 81, 21, 76, 16, 193, 3, 13, 44, 144, 192, 1, 5, 12, 16, 192, 191,
        126, 251, 242, 221, 171, 247, 121, 229, 141, 23, 222, 119, 221, 109, 151, 221, 117, 213,
        77, 23, 221, 115, 205, 45, 151, 220, 113, 197, 13, 23, 220, 111, 189, 237, 150, 219, 109,
        181, 205, 22, 219, 107, 173, 173, 150, 218, 105, 165, 141, 22, 218, 103, 157, 109, 150,
        217, 101, 149, 77, 22, 217, 99, 1, 145, 60, 210, 200, 34, 137, 28, 82, 200, 32, 129, 252,
        209, 199, 30, 121, 220, 81, 199, 28, 113, 188, 209, 198, 26, 105, 156, 81, 198, 24, 97,
        124, 209, 197, 22, 89, 92, 81, 197, 20, 81, 60, 209, 196, 18, 73, 28, 81, 196, 16, 65, 252,
        208, 195, 14, 57, 220, 80, 195, 12, 49, 188, 208, 194, 10, 41, 156, 80, 194, 8, 33, 124,
        208, 193, 6, 25, 92, 16, 1, 0, 246, 29, 229, 255, 107, 10,
    ];
    const ENC_BIT_TS2_ALIGNED_MULTIBLOCK: &[u8] = &[
        2, 1, 148, 2, 0, 32, 0, 0, 0, 16, 0, 0, 88, 2, 0, 0, 24, 0, 0, 0, 54, 1, 0, 0, 26, 1, 0, 0,
        40, 181, 47, 253, 96, 0, 15, 133, 8, 0, 66, 203, 35, 38, 144, 41, 173, 6, 210, 170, 111,
        199, 152, 45, 191, 232, 38, 215, 62, 12, 19, 169, 127, 240, 245, 205, 58, 33, 198, 46, 43,
        39, 234, 181, 108, 219, 161, 13, 66, 250, 78, 1, 247, 157, 42, 55, 101, 175, 194, 81, 231,
        165, 110, 213, 248, 233, 75, 210, 176, 5, 209, 44, 78, 197, 211, 251, 254, 36, 127, 83,
        246, 175, 194, 31, 205, 191, 212, 253, 42, 254, 167, 239, 36, 55, 101, 175, 194, 209, 188,
        212, 173, 226, 167, 253, 244, 0, 164, 89, 140, 1, 193, 197, 44, 202, 21, 196, 211, 97, 128,
        153, 112, 13, 168, 84, 60, 131, 227, 192, 96, 210, 120, 56, 8, 24, 8, 9, 69, 227, 16, 96,
        44, 36, 13, 57, 104, 18, 200, 64, 139, 64, 20, 26, 4, 146, 208, 2, 95, 168, 80, 210, 219,
        28, 160, 195, 180, 114, 18, 160, 80, 72, 56, 130, 51, 34, 65, 40, 2, 132, 160, 34, 72, 72,
        8, 133, 243, 253, 63, 3, 1, 104, 206, 20, 252, 231, 170, 132, 142, 108, 22, 160, 176, 114,
        48, 215, 201, 81, 66, 81, 88, 39, 131, 36, 170, 100, 202, 241, 96, 172, 147, 81, 82, 100,
        166, 41, 11, 59, 98, 246, 96, 210, 200, 147, 116, 9, 100, 72, 0, 168, 53, 52, 27, 110, 65,
        122, 152, 5, 52, 117, 239, 36, 180, 157, 8, 72, 111, 49, 201, 0, 134, 166, 165, 15, 208,
        121, 19, 131, 235, 68, 104, 141, 76, 7, 77, 43, 34, 101, 28, 13, 45, 160, 98, 103, 30, 1,
        0, 0, 40, 181, 47, 253, 96, 0, 15, 165, 8, 0, 82, 10, 34, 39, 160, 39, 173, 6, 178, 58, 27,
        141, 63, 151, 197, 123, 59, 207, 87, 183, 141, 209, 29, 251, 78, 242, 32, 173, 248, 103,
        88, 30, 141, 152, 188, 49, 109, 129, 57, 149, 176, 157, 2, 175, 62, 183, 211, 230, 53, 58,
        42, 122, 92, 147, 169, 26, 184, 38, 218, 248, 43, 250, 159, 117, 127, 91, 249, 167, 250,
        155, 133, 255, 154, 63, 250, 221, 184, 162, 159, 117, 183, 149, 167, 186, 89, 248, 154,
        163, 87, 69, 4, 61, 205, 17, 36, 121, 168, 102, 193, 198, 68, 175, 76, 156, 5, 88, 144, 76,
        67, 116, 32, 3, 39, 23, 229, 0, 97, 36, 0, 11, 131, 130, 40, 146, 129, 229, 177, 199, 83,
        96, 139, 151, 192, 4, 30, 2, 11, 120, 1, 102, 160, 144, 16, 83, 7, 176, 131, 180, 114, 6,
        240, 62, 94, 100, 206, 87, 249, 227, 133, 196, 249, 146, 115, 188, 72, 62, 95, 114, 142,
        151, 35, 193, 58, 23, 82, 180, 112, 174, 51, 197, 75, 182, 98, 214, 36, 98, 37, 19, 117,
        67, 153, 173, 206, 56, 7, 12, 201, 84, 94, 126, 118, 7, 187, 98, 187, 112, 115, 128, 157,
        108, 105, 39, 75, 178, 165, 157, 170, 237, 26, 90, 237, 210, 205, 77, 204, 50, 132, 217,
        194, 101, 8, 179, 149, 177, 85, 98, 115, 231, 118, 231, 77, 76, 247, 238, 234, 61, 32, 45,
        145, 251, 98, 241, 155, 226, 91, 75, 5, 209, 27, 177, 59, 49, 145, 247, 235, 98, 226, 59,
        209, 173, 27, 177, 187, 197, 98, 69,
    ];
    const ENC_BIT_TS2_MEMCPY_RANDOM: &[u8] = &[
        2, 1, 150, 2, 128, 0, 0, 0, 128, 0, 0, 0, 144, 0, 0, 0, 93, 25, 165, 33, 248, 189, 11, 204,
        32, 57, 123, 30, 198, 149, 201, 119, 71, 220, 2, 209, 121, 136, 146, 77, 132, 82, 114, 87,
        161, 230, 69, 71, 239, 62, 46, 184, 30, 34, 62, 65, 145, 197, 141, 253, 80, 133, 239, 113,
        29, 247, 102, 122, 30, 19, 41, 129, 140, 136, 32, 149, 160, 0, 177, 141, 106, 35, 106, 130,
        71, 27, 216, 254, 98, 13, 194, 206, 58, 228, 234, 202, 182, 47, 68, 179, 81, 35, 70, 159,
        109, 121, 76, 87, 2, 126, 43, 253, 232, 225, 89, 119, 136, 120, 29, 55, 32, 165, 86, 216,
        228, 167, 2, 41, 108, 203, 128, 219, 62, 101, 206, 156, 26, 220, 92, 29, 142, 200, 62, 11,
    ];
    const PLAIN_BIT_TS2_MEMCPY_RANDOM: &[u8] = &[
        93, 25, 165, 33, 248, 189, 11, 204, 32, 57, 123, 30, 198, 149, 201, 119, 71, 220, 2, 209,
        121, 136, 146, 77, 132, 82, 114, 87, 161, 230, 69, 71, 239, 62, 46, 184, 30, 34, 62, 65,
        145, 197, 141, 253, 80, 133, 239, 113, 29, 247, 102, 122, 30, 19, 41, 129, 140, 136, 32,
        149, 160, 0, 177, 141, 106, 35, 106, 130, 71, 27, 216, 254, 98, 13, 194, 206, 58, 228, 234,
        202, 182, 47, 68, 179, 81, 35, 70, 159, 109, 121, 76, 87, 2, 126, 43, 253, 232, 225, 89,
        119, 136, 120, 29, 55, 32, 165, 86, 216, 228, 167, 2, 41, 108, 203, 128, 219, 62, 101, 206,
        156, 26, 220, 92, 29, 142, 200, 62, 11,
    ];
    const ENC_BIT_TS2_SINGLEBLOCK_SMALL: &[u8] = &[
        2, 1, 148, 2, 200, 0, 0, 0, 200, 0, 0, 0, 165, 0, 0, 0, 20, 0, 0, 0, 141, 0, 0, 0, 40, 181,
        47, 253, 32, 200, 37, 4, 0, 130, 12, 32, 18, 16, 184, 222, 13, 252, 255, 255, 255, 223,
        153, 85, 85, 85, 85, 85, 197, 150, 2, 139, 18, 29, 42, 52, 40, 208, 159, 62, 123, 242, 220,
        169, 51, 39, 206, 155, 54, 107, 210, 156, 41, 51, 38, 204, 151, 46, 91, 178, 92, 169, 50,
        37, 202, 147, 38, 75, 146, 28, 41, 50, 36, 200, 143, 30, 59, 114, 220, 168, 49, 35, 198,
        139, 22, 43, 82, 156, 40, 49, 34, 196, 135, 14, 27, 50, 92, 168, 48, 33, 194, 131, 6, 11,
        18, 28, 40, 48, 32, 192, 95, 223, 94, 222, 93, 221, 92, 220, 91, 219, 90, 218, 89, 217, 88,
        216, 87, 215, 86, 214, 85, 213, 84, 212, 83, 211, 82, 210, 209, 1, 0,
    ];
    #[test]
    fn oracle_bit_ts2_partial() {
        let got = decode_blosc(ENC_BIT_TS2_PARTIAL, &ocfg(2, BloscShuffle::Bit)).unwrap();
        assert_eq!(
            got,
            pat(5003, 2),
            "bit_ts2_partial: decode must match upstream blosc"
        );
    }
    #[test]
    fn oracle_bit_ts1_partial() {
        let got = decode_blosc(ENC_BIT_TS1_PARTIAL, &ocfg(1, BloscShuffle::Bit)).unwrap();
        assert_eq!(
            got,
            pat(9001, 1),
            "bit_ts1_partial: decode must match upstream blosc"
        );
    }
    #[test]
    fn oracle_bit_ts4_partial() {
        let got = decode_blosc(ENC_BIT_TS4_PARTIAL, &ocfg(4, BloscShuffle::Bit)).unwrap();
        assert_eq!(
            got,
            pat(3003, 4),
            "bit_ts4_partial: decode must match upstream blosc"
        );
    }
    #[test]
    fn oracle_byte_ts2_partial() {
        let got = decode_blosc(ENC_BYTE_TS2_PARTIAL, &ocfg(2, BloscShuffle::Byte)).unwrap();
        assert_eq!(
            got,
            pat(5003, 2),
            "byte_ts2_partial: decode must match upstream blosc"
        );
    }
    #[test]
    fn oracle_byte_ts4_partial() {
        let got = decode_blosc(ENC_BYTE_TS4_PARTIAL, &ocfg(4, BloscShuffle::Byte)).unwrap();
        assert_eq!(
            got,
            pat(3003, 4),
            "byte_ts4_partial: decode must match upstream blosc"
        );
    }
    #[test]
    fn oracle_none_ts2_partial() {
        let got = decode_blosc(ENC_NONE_TS2_PARTIAL, &ocfg(2, BloscShuffle::None)).unwrap();
        assert_eq!(
            got,
            pat(5003, 2),
            "none_ts2_partial: decode must match upstream blosc"
        );
    }
    #[test]
    fn oracle_bit_ts2_aligned_multiblock() {
        let got =
            decode_blosc(ENC_BIT_TS2_ALIGNED_MULTIBLOCK, &ocfg(2, BloscShuffle::Bit)).unwrap();
        assert_eq!(
            got,
            pat(4096, 2),
            "bit_ts2_aligned_multiblock: decode must match upstream blosc"
        );
    }
    #[test]
    fn oracle_bit_ts2_memcpy_random() {
        let got = decode_blosc(ENC_BIT_TS2_MEMCPY_RANDOM, &ocfg(2, BloscShuffle::Bit)).unwrap();
        assert_eq!(
            got,
            PLAIN_BIT_TS2_MEMCPY_RANDOM.to_vec(),
            "bit_ts2_memcpy_random: decode must match upstream blosc"
        );
    }
    #[test]
    fn oracle_bit_ts2_singleblock_small() {
        let got = decode_blosc(ENC_BIT_TS2_SINGLEBLOCK_SMALL, &ocfg(2, BloscShuffle::Bit)).unwrap();
        assert_eq!(
            got,
            pat(100, 2),
            "bit_ts2_singleblock_small: decode must match upstream blosc"
        );
    }
}
