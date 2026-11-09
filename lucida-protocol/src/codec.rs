//! The bytes-to-bytes storage codecs, as a level's codec chain declares them
//! and as a chunk frame names the codecs its payload is still encoded in.
//!
//! A client that declares the codecs it decodes ([`ChunkCodec`]) can be sent
//! a chunk's stored bytes as they are, in an encoded frame. Every other frame
//! carries decoded bytes, so a client that declares nothing reads the frames
//! it always has.

use serde::{Deserialize, Serialize};

/// A bytes-to-bytes codec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BytesCodec {
    /// An RFC 1952 gzip stream.
    Gzip,
    /// An RFC 1950 zlib stream.
    Zlib,
    /// A zstd stream of one or more frames.
    Zstd,
    /// An lz4 block behind its decoded length as a little-endian `u32`, as
    /// numcodecs writes it.
    Lz4,
    Blosc(BloscConfig),
    /// A crc32c checksum of the bytes, as a little-endian `u32` after them.
    Crc32c,
}

impl BytesCodec {
    /// The name a client declares to be sent bytes still in this codec.
    pub fn name(self) -> ChunkCodec {
        match self {
            BytesCodec::Gzip => ChunkCodec::Gzip,
            BytesCodec::Zlib => ChunkCodec::Zlib,
            BytesCodec::Zstd => ChunkCodec::Zstd,
            BytesCodec::Lz4 => ChunkCodec::Lz4,
            BytesCodec::Blosc(_) => ChunkCodec::Blosc,
            BytesCodec::Crc32c => ChunkCodec::Crc32c,
        }
    }
}

/// The Blosc1 configuration a codec chain declares. The decoder checks each
/// chunk's own header against it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BloscConfig {
    pub typesize: u8,
    pub cname: BloscCompressor,
    pub shuffle: BloscShuffle,
}

/// The compressor inside Blosc1. Snappy is the one Blosc1 offers that
/// lucida does not decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BloscCompressor {
    BloscLz,
    Lz4,
    Lz4hc,
    Zlib,
    Zstd,
}

impl BloscCompressor {
    /// The format code a Blosc1 header carries for this compressor. `lz4`
    /// and `lz4hc` write one format.
    pub fn format_code(self) -> u8 {
        match self {
            BloscCompressor::BloscLz => 0,
            BloscCompressor::Lz4 | BloscCompressor::Lz4hc => 1,
            BloscCompressor::Zlib => 3,
            BloscCompressor::Zstd => 4,
        }
    }
}

/// Blosc1 shuffle filter. Matches the Blosc1 header flag bits we recognize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BloscShuffle {
    None,
    Byte,
    Bit,
}

/// A codec a client declares it decodes, by name. Declaring `blosc` means
/// every compressor and shuffle inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkCodec {
    Gzip,
    Zlib,
    Zstd,
    Lz4,
    Blosc,
    Crc32c,
}

/// The codecs one connection declared it decodes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CodecSet(u8);

impl CodecSet {
    fn bit(codec: ChunkCodec) -> u8 {
        1 << codec as u8
    }

    pub fn contains(self, codec: ChunkCodec) -> bool {
        self.0 & Self::bit(codec) != 0
    }

    /// Whether every codec of a chain is one this connection decodes.
    pub fn decodes(self, codecs: &[BytesCodec]) -> bool {
        codecs.iter().all(|codec| self.contains(codec.name()))
    }
}

impl FromIterator<ChunkCodec> for CodecSet {
    fn from_iter<I: IntoIterator<Item = ChunkCodec>>(codecs: I) -> Self {
        CodecSet(
            codecs
                .into_iter()
                .fold(0, |bits, codec| bits | Self::bit(codec)),
        )
    }
}

/// When the server sends a connection's chunks still encoded, as a server
/// setting.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkRelaySetting {
    /// To a connection that does not come from this machine, or to any while
    /// a link throttle stands in for a network.
    #[default]
    Auto,
    Always,
    Never,
}

impl std::str::FromStr for ChunkRelaySetting {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, String> {
        match value {
            "auto" => Ok(ChunkRelaySetting::Auto),
            "always" => Ok(ChunkRelaySetting::Always),
            "never" => Ok(ChunkRelaySetting::Never),
            other => Err(format!(
                "chunk relay {other:?} is not one of auto, always, never"
            )),
        }
    }
}

/// The relay setting and what it resolved to for the connection that asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRelayReport {
    pub setting: ChunkRelaySetting,
    /// Whether this connection is sent chunks still encoded once it declares
    /// the codecs it decodes.
    pub relays: bool,
}

/// Bit 15 of a chunk frame's key length marks an encoded frame. A key never
/// comes near 16 KiB, so this bit and [`PLANES_FRAME_FLAG`] are free, and a
/// frame with neither is laid out as every client has always read it.
pub const ENCODED_FRAME_FLAG: u16 = 0x8000;

/// Bit 14 of a chunk frame's key length marks a plane frame: the payload is
/// some planes of the chunk, not all of it.
pub const PLANES_FRAME_FLAG: u16 = 0x4000;

/// A binary chunk frame: `[client_id: u32 LE][key_len: u16 LE][key][payload]`,
/// the key being `{dataset_id}/{image_id}/{chunk_key}`.
///
/// A plane frame sets [`PLANES_FRAME_FLAG`] in `key_len` and puts the planes
/// its payload holds right after the key: `[first: u32 LE][end: u32 LE]`,
/// half-open along the chunk's own Z, as the client asked for them. A frame
/// without it holds the whole chunk.
///
/// An encoded frame sets [`ENCODED_FRAME_FLAG`] in `key_len` and puts the
/// codecs its payload is encoded in before the payload, after the planes when
/// there are any: `[codecs_len: u8][codecs]`, as [`write_codecs`] writes them.
/// The length comes first so a client can find the payload without reading
/// the codecs.
pub fn encode_chunk_frame(
    client_id: u32,
    composite_key: &str,
    planes: Option<[u32; 2]>,
    codecs: &[BytesCodec],
    payload: &[u8],
) -> Vec<u8> {
    let key = composite_key.as_bytes();
    let key_len = u16::try_from(key.len())
        .ok()
        .filter(|len| len & (ENCODED_FRAME_FLAG | PLANES_FRAME_FLAG) == 0)
        .expect("a composite chunk key is shorter than 16 KiB");
    let mut flags = 0;
    if planes.is_some() {
        flags |= PLANES_FRAME_FLAG;
    }
    if !codecs.is_empty() {
        flags |= ENCODED_FRAME_FLAG;
    }
    let mut buf = Vec::with_capacity(4 + 2 + key.len() + 8 + 1 + 4 * codecs.len() + payload.len());
    buf.extend_from_slice(&client_id.to_le_bytes());
    buf.extend_from_slice(&(key_len | flags).to_le_bytes());
    buf.extend_from_slice(key);
    if let Some([first, end]) = planes {
        buf.extend_from_slice(&first.to_le_bytes());
        buf.extend_from_slice(&end.to_le_bytes());
    }
    if !codecs.is_empty() {
        let mut list = Vec::with_capacity(4 * codecs.len());
        write_codecs(codecs, &mut list);
        buf.push(u8::try_from(list.len()).expect("a codec chain is a few codecs long"));
        buf.extend_from_slice(&list);
    }
    buf.extend_from_slice(payload);
    buf
}

/// The parts of a chunk frame.
#[derive(Debug, PartialEq, Eq)]
pub struct ChunkFrame<'a> {
    pub client_id: u32,
    pub composite_key: &'a str,
    /// The planes the payload holds, `None` for the whole chunk.
    pub planes: Option<[u32; 2]>,
    /// The codecs the payload is encoded in, empty for decoded bytes.
    pub codecs: Vec<BytesCodec>,
    pub payload: &'a [u8],
}

/// Read a frame [`encode_chunk_frame`] wrote.
pub fn parse_chunk_frame(frame: &[u8]) -> Result<ChunkFrame<'_>, CodecListError> {
    let short = || CodecListError::Truncated;
    let (client_id, rest) = frame.split_first_chunk::<4>().ok_or_else(short)?;
    let (key_len, rest) = rest.split_first_chunk::<2>().ok_or_else(short)?;
    let key_len = u16::from_le_bytes(*key_len);
    let (key, rest) = rest
        .split_at_checked(usize::from(
            key_len & !(ENCODED_FRAME_FLAG | PLANES_FRAME_FLAG),
        ))
        .ok_or_else(short)?;
    let composite_key = std::str::from_utf8(key).map_err(|_| CodecListError::Key)?;
    let (planes, rest) = if key_len & PLANES_FRAME_FLAG == 0 {
        (None, rest)
    } else {
        let (first, rest) = rest.split_first_chunk::<4>().ok_or_else(short)?;
        let (end, rest) = rest.split_first_chunk::<4>().ok_or_else(short)?;
        (
            Some([u32::from_le_bytes(*first), u32::from_le_bytes(*end)]),
            rest,
        )
    };
    let (codecs, payload) = if key_len & ENCODED_FRAME_FLAG == 0 {
        (Vec::new(), rest)
    } else {
        let (&len, rest) = rest.split_first().ok_or_else(short)?;
        let (list, payload) = rest.split_at_checked(usize::from(len)).ok_or_else(short)?;
        (read_codecs(list)?, payload)
    };
    Ok(ChunkFrame {
        client_id: u32::from_le_bytes(*client_id),
        composite_key,
        planes,
        codecs,
        payload,
    })
}

const GZIP: u8 = 1;
const ZLIB: u8 = 2;
const ZSTD: u8 = 3;
const LZ4: u8 = 4;
const BLOSC: u8 = 5;
const CRC32C: u8 = 6;

/// Append `codecs` in the order they were applied, one byte each, and a
/// Blosc codec's typesize, compressor and shuffle in three bytes after it.
pub fn write_codecs(codecs: &[BytesCodec], out: &mut Vec<u8>) {
    for codec in codecs {
        match codec {
            BytesCodec::Gzip => out.push(GZIP),
            BytesCodec::Zlib => out.push(ZLIB),
            BytesCodec::Zstd => out.push(ZSTD),
            BytesCodec::Lz4 => out.push(LZ4),
            BytesCodec::Crc32c => out.push(CRC32C),
            BytesCodec::Blosc(config) => {
                let cname = match config.cname {
                    BloscCompressor::BloscLz => 0,
                    BloscCompressor::Lz4 => 1,
                    BloscCompressor::Lz4hc => 2,
                    BloscCompressor::Zlib => 3,
                    BloscCompressor::Zstd => 4,
                };
                let shuffle = match config.shuffle {
                    BloscShuffle::None => 0,
                    BloscShuffle::Byte => 1,
                    BloscShuffle::Bit => 2,
                };
                out.extend_from_slice(&[BLOSC, config.typesize, cname, shuffle]);
            }
        }
    }
}

/// Why a chunk frame or its codec list did not read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodecListError {
    #[error("the chunk frame ends early")]
    Truncated,
    #[error("the chunk frame's key is not UTF-8")]
    Key,
    #[error("unknown codec {0} in the chunk frame")]
    UnknownCodec(u8),
    #[error("unknown blosc {what} {value} in the chunk frame")]
    UnknownBlosc { what: &'static str, value: u8 },
}

/// The codecs [`write_codecs`] wrote.
pub fn read_codecs(mut bytes: &[u8]) -> Result<Vec<BytesCodec>, CodecListError> {
    let mut codecs = Vec::new();
    while let Some((&tag, rest)) = bytes.split_first() {
        bytes = rest;
        codecs.push(match tag {
            GZIP => BytesCodec::Gzip,
            ZLIB => BytesCodec::Zlib,
            ZSTD => BytesCodec::Zstd,
            LZ4 => BytesCodec::Lz4,
            CRC32C => BytesCodec::Crc32c,
            BLOSC => {
                let ([typesize, cname, shuffle], rest) = bytes
                    .split_first_chunk::<3>()
                    .map(|(head, rest)| (*head, rest))
                    .ok_or(CodecListError::Truncated)?;
                bytes = rest;
                let cname = match cname {
                    0 => BloscCompressor::BloscLz,
                    1 => BloscCompressor::Lz4,
                    2 => BloscCompressor::Lz4hc,
                    3 => BloscCompressor::Zlib,
                    4 => BloscCompressor::Zstd,
                    value => {
                        return Err(CodecListError::UnknownBlosc {
                            what: "compressor",
                            value,
                        });
                    }
                };
                let shuffle = match shuffle {
                    0 => BloscShuffle::None,
                    1 => BloscShuffle::Byte,
                    2 => BloscShuffle::Bit,
                    value => {
                        return Err(CodecListError::UnknownBlosc {
                            what: "shuffle",
                            value,
                        });
                    }
                };
                BytesCodec::Blosc(BloscConfig {
                    typesize,
                    cname,
                    shuffle,
                })
            }
            other => return Err(CodecListError::UnknownCodec(other)),
        });
    }
    Ok(codecs)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVERY_CODEC: [BytesCodec; 6] = [
        BytesCodec::Blosc(BloscConfig {
            typesize: 2,
            cname: BloscCompressor::Lz4hc,
            shuffle: BloscShuffle::Bit,
        }),
        BytesCodec::Gzip,
        BytesCodec::Zlib,
        BytesCodec::Zstd,
        BytesCodec::Lz4,
        BytesCodec::Crc32c,
    ];

    #[test]
    fn a_codec_list_reads_back_as_written() {
        let mut list = Vec::new();
        write_codecs(&EVERY_CODEC, &mut list);
        assert_eq!(list, [5, 2, 2, 2, 1, 2, 3, 4, 6]);
        assert_eq!(read_codecs(&list).unwrap(), EVERY_CODEC);
    }

    #[test]
    fn an_unknown_or_cut_codec_list_is_refused() {
        assert_eq!(read_codecs(&[9]), Err(CodecListError::UnknownCodec(9)));
        assert_eq!(read_codecs(&[5, 2, 1]), Err(CodecListError::Truncated));
        assert!(matches!(
            read_codecs(&[5, 2, 7, 0]),
            Err(CodecListError::UnknownBlosc { .. })
        ));
    }

    #[test]
    fn a_decoded_frame_keeps_the_layout_clients_have_always_read() {
        let frame = encode_chunk_frame(9, "ds/img/2/0/0/0/0/0", None, &[], &[1, 2, 3]);
        let mut expected = 9u32.to_le_bytes().to_vec();
        expected.extend_from_slice(&18u16.to_le_bytes());
        expected.extend_from_slice(b"ds/img/2/0/0/0/0/0");
        expected.extend_from_slice(&[1, 2, 3]);
        assert_eq!(frame, expected);
        let parsed = parse_chunk_frame(&frame).unwrap();
        assert!(parsed.codecs.is_empty());
        assert_eq!(parsed.planes, None);
        assert_eq!(parsed.payload, [1, 2, 3]);
    }

    #[test]
    fn an_encoded_frame_names_its_codecs_after_the_key() {
        let frame = encode_chunk_frame(9, "ds/img/0/0/0/0/0/0", None, &[BytesCodec::Zstd], &[7, 8]);
        assert_eq!(&frame[4..6], &(18u16 | ENCODED_FRAME_FLAG).to_le_bytes());
        assert_eq!(&frame[24..], &[1, ZSTD, 7, 8]);
        assert_eq!(
            parse_chunk_frame(&frame).unwrap(),
            ChunkFrame {
                client_id: 9,
                composite_key: "ds/img/0/0/0/0/0/0",
                planes: None,
                codecs: vec![BytesCodec::Zstd],
                payload: &[7, 8],
            }
        );
    }

    #[test]
    fn a_plane_frame_names_its_planes_after_the_key_and_before_any_codecs() {
        let frame = encode_chunk_frame(9, "ds/img/0/0/0/1/0/0", Some([3, 5]), &[], &[7, 8]);
        assert_eq!(&frame[4..6], &(18u16 | PLANES_FRAME_FLAG).to_le_bytes());
        assert_eq!(&frame[24..], &[3, 0, 0, 0, 5, 0, 0, 0, 7, 8]);
        assert_eq!(parse_chunk_frame(&frame).unwrap().planes, Some([3, 5]));
        assert_eq!(
            parse_chunk_frame(&frame[..27]),
            Err(CodecListError::Truncated)
        );

        let encoded = encode_chunk_frame(
            9,
            "ds/img/0/0/0/1/0/0",
            Some([0, 1]),
            &[BytesCodec::Lz4],
            &[7, 8],
        );
        assert_eq!(
            &encoded[4..6],
            &(18u16 | PLANES_FRAME_FLAG | ENCODED_FRAME_FLAG).to_le_bytes()
        );
        assert_eq!(&encoded[24..], &[0, 0, 0, 0, 1, 0, 0, 0, 1, LZ4, 7, 8]);
        assert_eq!(
            parse_chunk_frame(&encoded).unwrap(),
            ChunkFrame {
                client_id: 9,
                composite_key: "ds/img/0/0/0/1/0/0",
                planes: Some([0, 1]),
                codecs: vec![BytesCodec::Lz4],
                payload: &[7, 8],
            }
        );
    }

    #[test]
    fn a_codec_set_decodes_a_chain_only_when_it_holds_every_codec() {
        let set: CodecSet = [ChunkCodec::Zstd, ChunkCodec::Crc32c].into_iter().collect();
        assert!(set.decodes(&[BytesCodec::Zstd, BytesCodec::Crc32c]));
        assert!(!set.decodes(&[BytesCodec::Gzip, BytesCodec::Crc32c]));
        assert!(CodecSet::default().decodes(&[]));
        assert!(!CodecSet::default().contains(ChunkCodec::Lz4));
    }

    #[test]
    fn a_relay_setting_reads_its_three_names_and_refuses_others() {
        for (name, setting) in [
            ("auto", ChunkRelaySetting::Auto),
            ("always", ChunkRelaySetting::Always),
            ("never", ChunkRelaySetting::Never),
        ] {
            assert_eq!(name.parse::<ChunkRelaySetting>(), Ok(setting));
            assert_eq!(
                serde_json::to_string(&setting).unwrap(),
                format!("\"{name}\"")
            );
        }
        assert!(
            "sometimes"
                .parse::<ChunkRelaySetting>()
                .unwrap_err()
                .contains("sometimes")
        );
    }

    #[test]
    fn a_declared_name_is_snake_case() {
        let names: Vec<ChunkCodec> = EVERY_CODEC.iter().map(|c| c.name()).collect();
        assert_eq!(
            serde_json::to_string(&names).unwrap(),
            r#"["blosc","gzip","zlib","zstd","lz4","crc32c"]"#
        );
    }
}
