//! Bounded zstd decoding. The page decodes with ruzstd, which is pure Rust
//! and builds for WASM. The server, built with `native-zstd`, decodes with
//! libzstd, which is faster on the chunks only it still decodes.

use std::io::Read;

use ruzstd::decoding::errors::{FrameDecoderError, ReadFrameHeaderError};
use ruzstd::decoding::{BlockDecodingStrategy, FrameDecoder};

use super::BoundedError;

/// Decode a zstd stream of any number of frames, refused once it decodes
/// past `max_len` bytes.
pub(super) fn decode_bounded(input: &[u8], max_len: usize) -> Result<Vec<u8>, BoundedError> {
    #[cfg(feature = "native-zstd")]
    return native::decode_bounded(input, max_len);
    #[cfg(not(feature = "native-zstd"))]
    decode_pure(input, max_len)
}

/// The largest window a frame may ask the decoder to keep. A writer that
/// knows a chunk's size writes a single-segment frame whose window is the
/// chunk itself; a streaming writer's window stays at 8 MiB through level
/// 19. Past this, a hostile header would make the decoder hold its window
/// before any limit on the output could stop it.
const STREAMING_WINDOW: u64 = 8 << 20;

/// Bytes decoded between drains into the output, which bounds what the
/// decoder holds beyond its window.
const STEP: usize = 128 << 10;

#[cfg_attr(feature = "native-zstd", allow(dead_code))]
pub(super) fn decode_pure(mut input: &[u8], max_len: usize) -> Result<Vec<u8>, BoundedError> {
    let corrupt = |e: FrameDecoderError| BoundedError::Corrupt(e.to_string());
    let mut out = vec![0; max_len];
    let mut written = 0;
    let mut decoder = FrameDecoder::new();
    decoder.set_max_window_size(STREAMING_WINDOW.max(max_len as u64));
    while !input.is_empty() {
        match decoder.init(&mut input) {
            Ok(()) => {}
            Err(FrameDecoderError::ReadFrameHeaderError(ReadFrameHeaderError::SkipFrame {
                length,
                ..
            })) => {
                input = input.get(length as usize..).ok_or_else(|| {
                    BoundedError::Corrupt("a skippable frame runs past the end".into())
                })?;
                continue;
            }
            Err(e) => return Err(corrupt(e)),
        }
        loop {
            decoder
                .decode_blocks(&mut input, BlockDecodingStrategy::UptoBytes(STEP))
                .map_err(corrupt)?;
            written += decoder
                .read(&mut out[written..])
                .map_err(|e| BoundedError::Corrupt(e.to_string()))?;
            if decoder.can_collect() != 0 {
                return Err(BoundedError::TooLarge);
            }
            if decoder.is_finished() {
                break;
            }
        }
        if let (Some(recorded), Some(computed)) = (
            decoder.get_checksum_from_data(),
            decoder.get_calculated_checksum(),
        ) && recorded != computed
        {
            return Err(BoundedError::Corrupt(format!(
                "content checksum {recorded:#010x} does not match the content ({computed:#010x})"
            )));
        }
    }
    out.truncate(written);
    Ok(out)
}

#[cfg(feature = "native-zstd")]
mod native {
    use std::io::Read;

    use super::BoundedError;

    /// Read the stream to its end, stopping one byte past `max_len` so a
    /// stream that decodes larger is refused without being held whole.
    pub(super) fn decode_bounded(input: &[u8], max_len: usize) -> Result<Vec<u8>, BoundedError> {
        let io = |e: std::io::Error| BoundedError::Corrupt(e.to_string());
        let decoder = zstd::stream::read::Decoder::new(input).map_err(io)?;
        let mut out = Vec::new();
        decoder
            .take((max_len as u64).saturating_add(1))
            .read_to_end(&mut out)
            .map_err(io)?;
        if out.len() > max_len {
            return Err(BoundedError::TooLarge);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(raw: &[u8], level: i32) -> Vec<u8> {
        zstd::encode_all(std::io::Cursor::new(raw), level).unwrap()
    }

    /// Whichever decoder the build picks, the pure one runs here too, since
    /// it is the one the page ships.
    #[test]
    fn the_pure_decoder_reads_what_libzstd_writes() {
        let raw: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
        for level in [1, 3, 19] {
            assert_eq!(decode_pure(&frame(&raw, level), raw.len()).unwrap(), raw);
        }
        let two = [frame(&raw[..1000], 3), frame(&raw[1000..], 3)].concat();
        assert_eq!(decode_pure(&two, raw.len()).unwrap(), raw);
    }

    #[test]
    fn the_pure_decoder_skips_a_skippable_frame() {
        let mut stored = vec![0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3];
        stored.extend(frame(&[4u8; 64], 3));
        assert_eq!(decode_pure(&stored, 64).unwrap(), [4u8; 64]);
    }

    #[test]
    fn the_pure_decoder_stops_at_the_limit() {
        let bomb = frame(&vec![0u8; 16 << 20], 19);
        assert!(matches!(
            decode_pure(&bomb, 4096),
            Err(BoundedError::TooLarge)
        ));
        let exact = frame(&[9u8; 4096], 3);
        assert_eq!(decode_pure(&exact, 4096).unwrap(), [9u8; 4096]);
        assert!(matches!(
            decode_pure(&exact, 4095),
            Err(BoundedError::TooLarge)
        ));
    }

    #[test]
    fn the_pure_decoder_checks_the_content_checksum() {
        let mut encoder = zstd::Encoder::new(Vec::new(), 3).unwrap();
        encoder.include_checksum(true).unwrap();
        std::io::Write::write_all(&mut encoder, &[5u8; 1000]).unwrap();
        let mut stored = encoder.finish().unwrap();
        assert_eq!(decode_pure(&stored, 1000).unwrap(), [5u8; 1000]);
        let last = stored.len() - 1;
        stored[last] ^= 1;
        assert!(matches!(
            decode_pure(&stored, 1000),
            Err(BoundedError::Corrupt(_))
        ));
    }

    #[test]
    fn the_pure_decoder_refuses_a_cut_frame() {
        let stored = frame(&(0..5000u32).map(|i| i as u8).collect::<Vec<_>>(), 3);
        assert!(decode_pure(&stored[..stored.len() - 10], 5000).is_err());
    }
}
