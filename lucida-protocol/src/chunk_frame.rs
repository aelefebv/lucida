use std::fmt;

use lucida_content::{DatasetId, ImageId};

use crate::ClientId;

/// Bytes before the UTF-8 composite key in a server-to-client chunk frame.
pub const CHUNK_FRAME_HEADER_BYTES: usize = 6;

/// A decoded view over one server-to-client chunk frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedChunkFrame<'a> {
    pub client_id: ClientId,
    pub key: &'a str,
    pub payload: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkFrameError {
    KeyTooLong(usize),
    FrameLengthOverflow,
    TruncatedHeader { actual: usize },
    TruncatedKey { declared: usize, available: usize },
    InvalidUtf8Key,
}

impl fmt::Display for ChunkFrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::KeyTooLong(length) => {
                write!(
                    formatter,
                    "chunk-frame key is {length} bytes; maximum is {}",
                    u16::MAX
                )
            }
            Self::FrameLengthOverflow => formatter.write_str("chunk-frame length overflow"),
            Self::TruncatedHeader { actual } => write!(
                formatter,
                "chunk frame has {actual} bytes; header requires {CHUNK_FRAME_HEADER_BYTES}"
            ),
            Self::TruncatedKey {
                declared,
                available,
            } => write!(
                formatter,
                "chunk frame declares a {declared}-byte key but only {available} bytes remain"
            ),
            Self::InvalidUtf8Key => formatter.write_str("chunk-frame key is not valid UTF-8"),
        }
    }
}

impl std::error::Error for ChunkFrameError {}

/// Return the exact encoded length of a server-to-client chunk frame without
/// allocating the frame. Transport implementations use this to reserve their
/// complete outbound-memory charge before copying the payload.
pub fn chunk_frame_len(
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    payload_len: usize,
) -> Result<usize, ChunkFrameError> {
    let key_len = dataset_id
        .0
        .len()
        .checked_add(1)
        .and_then(|length| length.checked_add(image_id.0.len()))
        .and_then(|length| length.checked_add(1))
        .and_then(|length| length.checked_add(chunk_key.len()))
        .ok_or(ChunkFrameError::FrameLengthOverflow)?;
    u16::try_from(key_len).map_err(|_| ChunkFrameError::KeyTooLong(key_len))?;
    CHUNK_FRAME_HEADER_BYTES
        .checked_add(key_len)
        .and_then(|length| length.checked_add(payload_len))
        .ok_or(ChunkFrameError::FrameLengthOverflow)
}

/// Encode the sole binary WebSocket frame that Lucida still emits.
///
/// Layout: `[client_id: u32 LE][key_len: u16 LE][UTF-8 composite key][payload]`,
/// where the key is `{dataset_id}/{image_id}/{chunk_key}`. `ClientId` has the
/// same canonical `u32` domain as this header, and every variable-length
/// narrowing conversion is checked.
pub fn encode_chunk_frame(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    payload: &[u8],
) -> Result<Vec<u8>, ChunkFrameError> {
    let key_len = dataset_id
        .0
        .len()
        .checked_add(1)
        .and_then(|length| length.checked_add(image_id.0.len()))
        .and_then(|length| length.checked_add(1))
        .and_then(|length| length.checked_add(chunk_key.len()))
        .ok_or(ChunkFrameError::FrameLengthOverflow)?;
    let wire_key_len = u16::try_from(key_len).map_err(|_| ChunkFrameError::KeyTooLong(key_len))?;
    let frame_len = chunk_frame_len(dataset_id, image_id, chunk_key, payload.len())?;

    let mut frame = Vec::with_capacity(frame_len);
    frame.extend_from_slice(&client_id.to_le_bytes());
    frame.extend_from_slice(&wire_key_len.to_le_bytes());
    frame.extend_from_slice(dataset_id.0.as_bytes());
    frame.push(b'/');
    frame.extend_from_slice(image_id.0.as_bytes());
    frame.push(b'/');
    frame.extend_from_slice(chunk_key.as_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn decode_chunk_frame(frame: &[u8]) -> Result<DecodedChunkFrame<'_>, ChunkFrameError> {
    if frame.len() < CHUNK_FRAME_HEADER_BYTES {
        return Err(ChunkFrameError::TruncatedHeader {
            actual: frame.len(),
        });
    }
    let client_id = u32::from_le_bytes(frame[..4].try_into().expect("four-byte header"));
    let key_len = u16::from_le_bytes(frame[4..6].try_into().expect("two-byte header")) as usize;
    let key_end = CHUNK_FRAME_HEADER_BYTES
        .checked_add(key_len)
        .ok_or(ChunkFrameError::FrameLengthOverflow)?;
    if frame.len() < key_end {
        return Err(ChunkFrameError::TruncatedKey {
            declared: key_len,
            available: frame.len() - CHUNK_FRAME_HEADER_BYTES,
        });
    }
    let key = std::str::from_utf8(&frame[CHUNK_FRAME_HEADER_BYTES..key_end])
        .map_err(|_| ChunkFrameError::InvalidUtf8Key)?;
    Ok(DecodedChunkFrame {
        client_id,
        key,
        payload: &frame[key_end..],
    })
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct GoldenChunkFrame {
        client_id: ClientId,
        dataset_id: String,
        image_id: String,
        chunk_key: String,
        payload_hex: String,
        frame_hex: String,
    }

    fn from_hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0);
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(pair, 16).unwrap()
            })
            .collect()
    }

    #[test]
    fn shared_chunk_frame_golden_locks_encoder_and_decoder() {
        let golden: GoldenChunkFrame =
            serde_json::from_str(include_str!("../../wire-fixtures/binary/chunk_frame.json"))
                .unwrap();
        let payload = from_hex(&golden.payload_hex);
        let expected = from_hex(&golden.frame_hex);
        let encoded = encode_chunk_frame(
            golden.client_id,
            &DatasetId(golden.dataset_id),
            &ImageId(golden.image_id),
            &golden.chunk_key,
            &payload,
        )
        .unwrap();
        assert_eq!(encoded, expected);

        let decoded = decode_chunk_frame(&expected).unwrap();
        assert_eq!(decoded.client_id, golden.client_id);
        assert_eq!(decoded.key, "ds1/img1/2/0/0/0/0/0");
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn encoder_rejects_variable_length_overflow() {
        assert!(matches!(
            encode_chunk_frame(
                1,
                &DatasetId("d".repeat(usize::from(u16::MAX))),
                &ImageId("i".into()),
                "0",
                &[]
            ),
            Err(ChunkFrameError::KeyTooLong(_))
        ));
    }

    #[test]
    fn exact_length_preflight_matches_encoder() {
        let dataset_id = DatasetId("dataset".into());
        let image_id = ImageId("image".into());
        let payload = [1_u8; 19];
        let expected = chunk_frame_len(&dataset_id, &image_id, "2/0/1", payload.len()).unwrap();
        let encoded = encode_chunk_frame(7, &dataset_id, &image_id, "2/0/1", &payload).unwrap();
        assert_eq!(expected, encoded.len());
    }

    #[test]
    fn length_preflight_rejects_key_and_total_length_overflow() {
        assert!(matches!(
            chunk_frame_len(
                &DatasetId("d".repeat(usize::from(u16::MAX))),
                &ImageId("i".into()),
                "0",
                0,
            ),
            Err(ChunkFrameError::KeyTooLong(_))
        ));
        assert!(matches!(
            chunk_frame_len(
                &DatasetId("d".into()),
                &ImageId("i".into()),
                "0",
                usize::MAX,
            ),
            Err(ChunkFrameError::FrameLengthOverflow)
        ));
    }

    #[test]
    fn decoder_rejects_truncation_and_non_utf8_keys() {
        assert!(matches!(
            decode_chunk_frame(&[0; 5]),
            Err(ChunkFrameError::TruncatedHeader { .. })
        ));
        assert!(matches!(
            decode_chunk_frame(&[0, 0, 0, 0, 2, 0, b'a']),
            Err(ChunkFrameError::TruncatedKey { .. })
        ));
        assert!(matches!(
            decode_chunk_frame(&[0, 0, 0, 0, 1, 0, 0xff]),
            Err(ChunkFrameError::InvalidUtf8Key)
        ));
    }
}
