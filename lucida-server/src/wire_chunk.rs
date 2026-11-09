//! What a chunk frame carries to a client that declared the codecs it
//! decodes: a source chunk's stored bytes as they are, or a chunk the server
//! made itself compressed for the link. Every other client, and every chunk
//! that does not qualify, gets decoded bytes.

use lucida_protocol::codec::{BytesCodec, ChunkCodec, CodecSet};

/// Whether `wire` bytes in place of `decoded` ones save enough of the link
/// to be worth the client decoding them. The page's zstd decodes about
/// 160 MB/s on one core, so a chunk that barely compresses would only move
/// its decode from the server to the page. A quarter saved is several
/// milliseconds of transfer per chunk on a link of a few hundred Mbit/s.
pub fn saves_enough(wire: usize, decoded: usize) -> bool {
    wire.saturating_mul(4) <= decoded.saturating_mul(3)
}

/// The one codec the server compresses its own chunks with. lz4 is the
/// fastest to write here and to undo in the page's decode worker.
pub const PRODUCED_CODEC: BytesCodec = BytesCodec::Lz4;

/// A chunk the server made itself, a generated coarse-tier chunk or the fill
/// of an absent one, compressed for a client that decodes
/// [`PRODUCED_CODEC`] when that saves enough.
pub fn compress_produced(codecs: CodecSet, decoded: &[u8]) -> Option<Vec<u8>> {
    if !codecs.contains(ChunkCodec::Lz4) {
        return None;
    }
    let compressed = lz4_flex::compress_prepend_size(decoded);
    saves_enough(compressed.len(), decoded.len()).then_some(compressed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lz4() -> CodecSet {
        [ChunkCodec::Lz4].into_iter().collect()
    }

    #[test]
    fn a_quarter_saved_is_enough_and_less_is_not() {
        assert!(saves_enough(768, 1024));
        assert!(!saves_enough(769, 1024));
    }

    #[test]
    fn a_produced_chunk_is_compressed_only_for_a_client_that_decodes_lz4() {
        let fill = vec![0u8; 64 * 1024];
        let compressed = compress_produced(lz4(), &fill).unwrap();
        assert!(compressed.len() < 1024);
        assert_eq!(
            lz4_flex::decompress_size_prepended(&compressed).unwrap(),
            fill
        );
        assert_eq!(compress_produced(CodecSet::default(), &fill), None);
    }

    #[test]
    fn a_produced_chunk_that_barely_compresses_goes_decoded() {
        let mut x = 0x9e37_79b9_u32;
        let noise: Vec<u8> = (0..64 * 1024)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect();
        assert_eq!(compress_produced(lz4(), &noise), None);
    }
}
