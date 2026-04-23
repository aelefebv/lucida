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
    InputTruncated { what: &'static str, need: usize, have: usize },
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

    if typesize as usize != 0 && nbytes % typesize as usize != 0 {
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
        let compressed_len = u32::from_le_bytes(
            input[block_offset..block_offset + 4]
                .try_into()
                .unwrap(),
        ) as usize;

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
        let block_bytes = zstd::stream::decode_all(std::io::Cursor::new(
            &input[payload_start..payload_end],
        ))
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

        let unshuffled = match config.shuffle {
            BloscShuffle::None => block_bytes,
            BloscShuffle::Byte => byte_unshuffle(&block_bytes, typesize as usize),
            BloscShuffle::Bit => bit_unshuffle(&block_bytes, typesize as usize),
        };
        decompressed.extend_from_slice(&unshuffled);
    }

    Ok(decompressed)
}

/// Inverse of Blosc byte-shuffle. The shuffled layout for a block of N
/// elements (each `typesize` bytes) is `typesize` consecutive groups of N
/// bytes; group j carries byte j of every element. Returns the original
/// element-major layout.
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
        assert_eq!(
            out,
            vec![0x10, 0x11, 0x20, 0x21, 0x30, 0x31, 0x40, 0x41]
        );
    }
}
