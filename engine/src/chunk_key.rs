use std::fmt::{Display, Formatter};
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkAssetKind {
    Tile2d,
    Brick3d,
    Preview2d,
}

impl ChunkAssetKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Tile2d => "tile2d",
            Self::Brick3d => "brick3d",
            Self::Preview2d => "preview2d",
        }
    }
}

impl Display for ChunkAssetKind {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ChunkAssetKind {
    type Err = ChunkKeyError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "tile2d" => Ok(Self::Tile2d),
            "brick3d" => Ok(Self::Brick3d),
            "preview2d" => Ok(Self::Preview2d),
            _ => Err(ChunkKeyError::ParseError {
                message: format!("unsupported chunk asset kind `{value}`"),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkKey {
    pub source_id: String,
    pub generation_seq: u64,
    pub asset_kind: ChunkAssetKind,
    pub lod: u8,
    pub t: u32,
    pub z: u32,
    pub channel_block: u16,
    pub y: u32,
    pub x: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkKeyError {
    ParseError { message: String },
}

impl Display for ChunkKeyError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ParseError { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for ChunkKeyError {}

impl ChunkKey {
    #[must_use]
    pub fn format_canonical(&self) -> String {
        format!(
            "asset={};source={};gen={};lod={};t={};z={};cb={};y={};x={}",
            self.asset_kind,
            self.source_id,
            self.generation_seq,
            self.lod,
            self.t,
            self.z,
            self.channel_block,
            self.y,
            self.x
        )
    }

    pub fn parse_canonical(value: &str) -> Result<Self, ChunkKeyError> {
        let mut asset_kind = None;
        let mut source_id = None;
        let mut generation_seq = None;
        let mut lod = None;
        let mut t = None;
        let mut z = None;
        let mut channel_block = None;
        let mut y = None;
        let mut x = None;

        for part in value.split(';') {
            let Some((key, raw_value)) = part.split_once('=') else {
                return Err(ChunkKeyError::ParseError {
                    message: "chunk key part must be key=value".to_owned(),
                });
            };
            match key {
                "asset" => asset_kind = Some(raw_value.parse()?),
                "source" => source_id = Some(raw_value.to_owned()),
                "gen" => generation_seq = Some(parse_u64("gen", raw_value)?),
                "lod" => lod = Some(parse_u8("lod", raw_value)?),
                "t" => t = Some(parse_u32("t", raw_value)?),
                "z" => z = Some(parse_u32("z", raw_value)?),
                "cb" => channel_block = Some(parse_u16("cb", raw_value)?),
                "y" => y = Some(parse_u32("y", raw_value)?),
                "x" => x = Some(parse_u32("x", raw_value)?),
                _ => {
                    return Err(ChunkKeyError::ParseError {
                        message: format!("unknown chunk key field `{key}`"),
                    });
                }
            }
        }

        Ok(Self {
            source_id: required("source", source_id)?,
            generation_seq: required("gen", generation_seq)?,
            asset_kind: required("asset", asset_kind)?,
            lod: required("lod", lod)?,
            t: required("t", t)?,
            z: required("z", z)?,
            channel_block: required("cb", channel_block)?,
            y: required("y", y)?,
            x: required("x", x)?,
        })
    }

    #[must_use]
    pub fn format_path(&self) -> String {
        format!(
            "/v1/{}/{}/gen/{}/lod/{}/t/{}/z/{}/cb/{}/y/{}/x/{}",
            self.asset_kind,
            self.source_id,
            self.generation_seq,
            self.lod,
            self.t,
            self.z,
            self.channel_block,
            self.y,
            self.x
        )
    }

    pub fn parse_path(path: &str) -> Result<Self, ChunkKeyError> {
        let trimmed = path.trim_start_matches('/');
        let parts = trimmed.split('/').collect::<Vec<_>>();
        if parts.len() != 17 {
            return Err(ChunkKeyError::ParseError {
                message: format!("chunk path must have 17 segments but had {}", parts.len()),
            });
        }

        if parts[0] != "v1"
            || parts[3] != "gen"
            || parts[5] != "lod"
            || parts[7] != "t"
            || parts[9] != "z"
            || parts[11] != "cb"
            || parts[13] != "y"
            || parts[15] != "x"
        {
            return Err(ChunkKeyError::ParseError {
                message: "chunk path segments do not match canonical layout".to_owned(),
            });
        }

        Ok(Self {
            asset_kind: parts[1].parse()?,
            source_id: parts[2].to_owned(),
            generation_seq: parse_u64("gen", parts[4])?,
            lod: parse_u8("lod", parts[6])?,
            t: parse_u32("t", parts[8])?,
            z: parse_u32("z", parts[10])?,
            channel_block: parse_u16("cb", parts[12])?,
            y: parse_u32("y", parts[14])?,
            x: parse_u32("x", parts[16])?,
        })
    }
}

fn required<T>(field: &str, value: Option<T>) -> Result<T, ChunkKeyError> {
    value.ok_or_else(|| ChunkKeyError::ParseError {
        message: format!("missing chunk key field `{field}`"),
    })
}

fn parse_u8(label: &str, value: &str) -> Result<u8, ChunkKeyError> {
    value.parse::<u8>().map_err(|_| ChunkKeyError::ParseError {
        message: format!("chunk key field `{label}` must be u8"),
    })
}

fn parse_u16(label: &str, value: &str) -> Result<u16, ChunkKeyError> {
    value.parse::<u16>().map_err(|_| ChunkKeyError::ParseError {
        message: format!("chunk key field `{label}` must be u16"),
    })
}

fn parse_u32(label: &str, value: &str) -> Result<u32, ChunkKeyError> {
    value.parse::<u32>().map_err(|_| ChunkKeyError::ParseError {
        message: format!("chunk key field `{label}` must be u32"),
    })
}

fn parse_u64(label: &str, value: &str) -> Result<u64, ChunkKeyError> {
    value.parse::<u64>().map_err(|_| ChunkKeyError::ParseError {
        message: format!("chunk key field `{label}` must be u64"),
    })
}

#[cfg(test)]
mod tests {
    use super::{ChunkAssetKind, ChunkKey};

    #[test]
    fn canonical_string_round_trips() {
        let key = ChunkKey {
            source_id: "src_00000001".to_owned(),
            generation_seq: 12,
            asset_kind: ChunkAssetKind::Tile2d,
            lod: 3,
            t: 1,
            z: 2,
            channel_block: 0,
            y: 14,
            x: 19,
        };

        let encoded = key.format_canonical();
        let decoded =
            ChunkKey::parse_canonical(&encoded).expect("canonical chunk key should parse");
        assert_eq!(decoded, key);
    }

    #[test]
    fn canonical_path_round_trips() {
        let key = ChunkKey {
            source_id: "src_00000009".to_owned(),
            generation_seq: 3,
            asset_kind: ChunkAssetKind::Brick3d,
            lod: 1,
            t: 0,
            z: 7,
            channel_block: 2,
            y: 99,
            x: 8,
        };

        let path = key.format_path();
        let decoded = ChunkKey::parse_path(&path).expect("chunk path should parse");
        assert_eq!(decoded, key);
    }

    #[test]
    fn parse_path_rejects_non_canonical_layout() {
        let error = ChunkKey::parse_path("/v1/tile2d/src_0001/wrong/1/lod/2")
            .expect_err("invalid path should fail");
        assert!(
            format!("{error}").contains("17 segments"),
            "error should describe expected segment count"
        );
    }
}
