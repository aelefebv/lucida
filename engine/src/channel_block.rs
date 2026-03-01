#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadKind {
    Image,
    Label,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadCodec {
    Raw,
    Lz4,
    Zstd,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelBlockWriteRequest {
    pub payload_kind: PayloadKind,
    pub codec: PayloadCodec,
    pub channel_count: u16,
    pub channel_block_size_override: Option<u16>,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelBlockReadResult {
    pub payload_kind: PayloadKind,
    pub codec: PayloadCodec,
    pub channel_count: u16,
    pub channel_block_size: u16,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelBlockPackaging {
    default_channel_block_size: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelBlockError {
    InvalidHeader { reason: String },
    DecodeFailed { reason: String },
}

const MAGIC: &[u8; 4] = b"LCBK";
const HEADER_LEN: usize = 20;

impl Default for ChannelBlockPackaging {
    fn default() -> Self {
        Self {
            default_channel_block_size: 4,
        }
    }
}

impl ChannelBlockPackaging {
    #[must_use]
    pub fn new(default_channel_block_size: u16) -> Self {
        Self {
            default_channel_block_size: default_channel_block_size.max(1),
        }
    }

    #[must_use]
    pub fn default_block_size(&self) -> u16 {
        self.default_channel_block_size
    }

    pub fn encode(&self, request: &ChannelBlockWriteRequest) -> Result<Vec<u8>, ChannelBlockError> {
        let channel_count = request.channel_count.max(1);
        let effective_block_size = effective_channel_block_size(
            request.payload_kind,
            channel_count,
            request.channel_block_size_override,
            self.default_channel_block_size,
        );
        let encoded_payload = encode_bytes(request.codec, &request.payload)?;
        let encoded_len =
            u32::try_from(encoded_payload.len()).map_err(|_| ChannelBlockError::InvalidHeader {
                reason: "encoded payload exceeds 32-bit length".to_owned(),
            })?;
        let decoded_len =
            u32::try_from(request.payload.len()).map_err(|_| ChannelBlockError::InvalidHeader {
                reason: "decoded payload exceeds 32-bit length".to_owned(),
            })?;

        let mut bytes = Vec::with_capacity(HEADER_LEN + encoded_payload.len());
        bytes.extend_from_slice(MAGIC);
        bytes.push(1); // format version
        bytes.push(payload_kind_code(request.payload_kind));
        bytes.push(payload_codec_code(request.codec));
        bytes.push(0); // reserved
        bytes.extend_from_slice(&channel_count.to_le_bytes());
        bytes.extend_from_slice(&effective_block_size.to_le_bytes());
        bytes.extend_from_slice(&encoded_len.to_le_bytes());
        bytes.extend_from_slice(&decoded_len.to_le_bytes());
        bytes.extend_from_slice(&encoded_payload);
        Ok(bytes)
    }

    pub fn decode(&self, bytes: &[u8]) -> Result<ChannelBlockReadResult, ChannelBlockError> {
        let metadata = read_metadata(bytes)?;
        if bytes.len() < HEADER_LEN {
            return Err(ChannelBlockError::InvalidHeader {
                reason: "payload is shorter than channel-block header".to_owned(),
            });
        }
        let payload_kind = metadata.payload_kind;
        let codec = metadata.codec;
        let channel_count = metadata.channel_count;
        let channel_block_size = metadata.channel_block_size;
        let encoded_len = metadata.encoded_len;
        let decoded_len = metadata.decoded_len;

        if bytes.len() != HEADER_LEN + encoded_len {
            return Err(ChannelBlockError::InvalidHeader {
                reason: "encoded payload length does not match header".to_owned(),
            });
        }

        let encoded_payload = &bytes[HEADER_LEN..];
        let payload = decode_bytes(codec, encoded_payload, decoded_len)?;
        if payload.len() != decoded_len {
            return Err(ChannelBlockError::DecodeFailed {
                reason: "decoded payload length mismatch".to_owned(),
            });
        }

        Ok(ChannelBlockReadResult {
            payload_kind,
            codec,
            channel_count,
            channel_block_size,
            payload,
        })
    }
}

pub fn codec_from_packaged_payload(bytes: &[u8]) -> Result<PayloadCodec, ChannelBlockError> {
    Ok(read_metadata(bytes)?.codec)
}

struct ChannelBlockMetadata {
    payload_kind: PayloadKind,
    codec: PayloadCodec,
    channel_count: u16,
    channel_block_size: u16,
    encoded_len: usize,
    decoded_len: usize,
}

fn read_metadata(bytes: &[u8]) -> Result<ChannelBlockMetadata, ChannelBlockError> {
    if bytes.len() < HEADER_LEN {
        return Err(ChannelBlockError::InvalidHeader {
            reason: "payload is shorter than channel-block header".to_owned(),
        });
    }
    if &bytes[0..4] != MAGIC {
        return Err(ChannelBlockError::InvalidHeader {
            reason: "channel-block magic mismatch".to_owned(),
        });
    }
    let version = bytes[4];
    if version != 1 {
        return Err(ChannelBlockError::InvalidHeader {
            reason: format!("unsupported channel-block version `{version}`"),
        });
    }

    Ok(ChannelBlockMetadata {
        payload_kind: parse_payload_kind(bytes[5])?,
        codec: parse_payload_codec(bytes[6])?,
        channel_count: u16::from_le_bytes([bytes[8], bytes[9]]),
        channel_block_size: u16::from_le_bytes([bytes[10], bytes[11]]),
        encoded_len: u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize,
        decoded_len: u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) as usize,
    })
}

fn effective_channel_block_size(
    payload_kind: PayloadKind,
    channel_count: u16,
    override_size: Option<u16>,
    default_size: u16,
) -> u16 {
    if matches!(payload_kind, PayloadKind::Label) {
        return 1;
    }

    let candidate = override_size.unwrap_or(default_size).max(1);
    candidate.min(channel_count)
}

fn payload_kind_code(kind: PayloadKind) -> u8 {
    match kind {
        PayloadKind::Image => 0,
        PayloadKind::Label => 1,
    }
}

fn parse_payload_kind(value: u8) -> Result<PayloadKind, ChannelBlockError> {
    match value {
        0 => Ok(PayloadKind::Image),
        1 => Ok(PayloadKind::Label),
        _ => Err(ChannelBlockError::InvalidHeader {
            reason: format!("unsupported payload kind `{value}`"),
        }),
    }
}

fn payload_codec_code(codec: PayloadCodec) -> u8 {
    match codec {
        PayloadCodec::Raw => 0,
        PayloadCodec::Lz4 => 1,
        PayloadCodec::Zstd => 2,
    }
}

fn parse_payload_codec(value: u8) -> Result<PayloadCodec, ChannelBlockError> {
    match value {
        0 => Ok(PayloadCodec::Raw),
        1 => Ok(PayloadCodec::Lz4),
        2 => Ok(PayloadCodec::Zstd),
        _ => Err(ChannelBlockError::InvalidHeader {
            reason: format!("unsupported payload codec `{value}`"),
        }),
    }
}

fn encode_bytes(codec: PayloadCodec, payload: &[u8]) -> Result<Vec<u8>, ChannelBlockError> {
    match codec {
        PayloadCodec::Raw => Ok(payload.to_vec()),
        PayloadCodec::Lz4 => Ok(lz4_flex::compress_prepend_size(payload)),
        PayloadCodec::Zstd => {
            zstd::stream::encode_all(payload, 3).map_err(|error| ChannelBlockError::DecodeFailed {
                reason: error.to_string(),
            })
        }
    }
}

fn decode_bytes(
    codec: PayloadCodec,
    encoded: &[u8],
    decoded_len: usize,
) -> Result<Vec<u8>, ChannelBlockError> {
    match codec {
        PayloadCodec::Raw => Ok(encoded.to_vec()),
        PayloadCodec::Lz4 => lz4_flex::decompress_size_prepended(encoded).map_err(|error| {
            ChannelBlockError::DecodeFailed {
                reason: error.to_string(),
            }
        }),
        PayloadCodec::Zstd => {
            let decoded = zstd::stream::decode_all(encoded).map_err(|error| {
                ChannelBlockError::DecodeFailed {
                    reason: error.to_string(),
                }
            })?;
            if decoded.len() != decoded_len {
                return Err(ChannelBlockError::DecodeFailed {
                    reason: "zstd decoded length does not match header".to_owned(),
                });
            }
            Ok(decoded)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ChannelBlockPackaging, ChannelBlockWriteRequest, PayloadCodec, PayloadKind};

    #[test]
    fn image_payload_round_trips_with_lz4_and_default_block_size() {
        let packaging = ChannelBlockPackaging::new(4);
        let payload = (0_u8..=255).cycle().take(4096).collect::<Vec<_>>();
        let encoded = packaging
            .encode(&ChannelBlockWriteRequest {
                payload_kind: PayloadKind::Image,
                codec: PayloadCodec::Lz4,
                channel_count: 6,
                channel_block_size_override: None,
                payload: payload.clone(),
            })
            .expect("encoding should succeed");
        let decoded = packaging.decode(&encoded).expect("decoding should succeed");

        assert_eq!(decoded.payload_kind, PayloadKind::Image);
        assert_eq!(decoded.channel_block_size, 4);
        assert_eq!(decoded.channel_count, 6);
        assert_eq!(decoded.codec, PayloadCodec::Lz4);
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn labels_force_single_channel_blocks_even_with_overrides() {
        let packaging = ChannelBlockPackaging::new(4);
        let payload = vec![7_u8; 128];
        let encoded = packaging
            .encode(&ChannelBlockWriteRequest {
                payload_kind: PayloadKind::Label,
                codec: PayloadCodec::Zstd,
                channel_count: 8,
                channel_block_size_override: Some(8),
                payload: payload.clone(),
            })
            .expect("encoding should succeed");
        let decoded = packaging.decode(&encoded).expect("decoding should succeed");

        assert_eq!(decoded.channel_block_size, 1);
        assert_eq!(decoded.codec, PayloadCodec::Zstd);
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn decoder_rejects_invalid_magic() {
        let packaging = ChannelBlockPackaging::default();
        let invalid_payload = vec![0_u8; 20];
        let error = packaging
            .decode(&invalid_payload)
            .expect_err("invalid payload should fail");
        assert!(
            format!("{error:?}").contains("magic"),
            "error should mention header magic"
        );
    }
}
