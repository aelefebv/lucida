use lucida_content::{DataType, ImageId};
use serde::{Deserialize, Serialize};

/// How a client turns logical chunk addresses into bytes for a dataset.
/// Enum by mode because the modes need different fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClientFetchDescriptor {
    Proxied(ProxiedFetchDescriptor),
    Direct(DirectFetchDescriptor),
    Local(LocalFetchDescriptor),
}

/// Server-proxied fetch. Client sends logical chunk keys,
/// server resolves storage paths and returns bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxiedFetchDescriptor {
    pub images: Vec<ProxiedImageSpec>,
}

/// What the client needs to know about a proxied image's responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxiedImageSpec {
    pub image_id: ImageId,
    pub wire_format: WireFormat,
}

/// Client fetches directly from storage (future).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectFetchDescriptor {
    pub images: Vec<DirectImageSpec>,
}

/// Local filesystem access (Python headless).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalFetchDescriptor {
    pub images: Vec<DirectImageSpec>,
}

/// Per-image fetch metadata for modes where the client resolves storage paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectImageSpec {
    pub image_id: ImageId,
    pub wire_format: WireFormat,
    pub levels: Vec<LevelAddress>,
    pub store_prefix: Option<String>,
}

/// How to address a specific level within an image's multiscale pyramid.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LevelAddress {
    pub level_index: u32,
    pub path: String,
}

/// What byte format the client should expect from chunk responses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WireFormat {
    Raw { data_type: DataType },
    Lz4 { data_type: DataType },
    Zstd { data_type: DataType },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxied_round_trip() {
        let desc = ClientFetchDescriptor::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id: ImageId("img1".into()),
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });
        let json = serde_json::to_string(&desc).unwrap();
        let back: ClientFetchDescriptor = serde_json::from_str(&json).unwrap();
        match &back {
            ClientFetchDescriptor::Proxied(p) => {
                assert_eq!(p.images.len(), 1);
                assert_eq!(p.images[0].image_id, ImageId("img1".into()));
                assert_eq!(
                    p.images[0].wire_format,
                    WireFormat::Raw {
                        data_type: DataType::Uint16,
                    }
                );
            }
            _ => panic!("expected Proxied variant"),
        }
    }

    #[test]
    fn direct_round_trip() {
        let desc = ClientFetchDescriptor::Direct(DirectFetchDescriptor {
            images: vec![DirectImageSpec {
                image_id: ImageId("img2".into()),
                wire_format: WireFormat::Lz4 {
                    data_type: DataType::Float32,
                },
                levels: vec![
                    LevelAddress {
                        level_index: 0,
                        path: "s3://bucket/level0".into(),
                    },
                    LevelAddress {
                        level_index: 1,
                        path: "s3://bucket/level1".into(),
                    },
                ],
                store_prefix: Some("s3://bucket".into()),
            }],
        });
        let json = serde_json::to_string(&desc).unwrap();
        let back: ClientFetchDescriptor = serde_json::from_str(&json).unwrap();
        match &back {
            ClientFetchDescriptor::Direct(d) => {
                assert_eq!(d.images.len(), 1);
                assert_eq!(d.images[0].image_id, ImageId("img2".into()));
                assert_eq!(d.images[0].levels.len(), 2);
                assert_eq!(d.images[0].levels[0].level_index, 0);
                assert_eq!(d.images[0].levels[1].path, "s3://bucket/level1");
                assert_eq!(
                    d.images[0].store_prefix,
                    Some("s3://bucket".to_string())
                );
            }
            _ => panic!("expected Direct variant"),
        }
    }

    #[test]
    fn local_round_trip() {
        let desc = ClientFetchDescriptor::Local(LocalFetchDescriptor {
            images: vec![DirectImageSpec {
                image_id: ImageId("local-img".into()),
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint8,
                },
                levels: vec![LevelAddress {
                    level_index: 0,
                    path: "/data/level0".into(),
                }],
                store_prefix: None,
            }],
        });
        let json = serde_json::to_string(&desc).unwrap();
        let back: ClientFetchDescriptor = serde_json::from_str(&json).unwrap();
        match &back {
            ClientFetchDescriptor::Local(l) => {
                assert_eq!(l.images.len(), 1);
                assert_eq!(l.images[0].image_id, ImageId("local-img".into()));
                assert!(l.images[0].store_prefix.is_none());
            }
            _ => panic!("expected Local variant"),
        }
    }

    #[test]
    fn wire_format_raw_round_trip() {
        let wf = WireFormat::Raw {
            data_type: DataType::Uint16,
        };
        let json = serde_json::to_string(&wf).unwrap();
        let back: WireFormat = serde_json::from_str(&json).unwrap();
        assert_eq!(wf, back);
    }

    #[test]
    fn wire_format_lz4_round_trip() {
        let wf = WireFormat::Lz4 {
            data_type: DataType::Float32,
        };
        let json = serde_json::to_string(&wf).unwrap();
        let back: WireFormat = serde_json::from_str(&json).unwrap();
        assert_eq!(wf, back);
    }

    #[test]
    fn wire_format_zstd_round_trip() {
        let wf = WireFormat::Zstd {
            data_type: DataType::Uint32,
        };
        let json = serde_json::to_string(&wf).unwrap();
        let back: WireFormat = serde_json::from_str(&json).unwrap();
        assert_eq!(wf, back);
    }

    #[test]
    fn json_shape_externally_tagged() {
        let desc = ClientFetchDescriptor::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id: ImageId("img1".into()),
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });
        let json = serde_json::to_string(&desc).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();

        // Serde's default externally-tagged representation
        assert!(value.is_object());
        assert!(value.get("Proxied").is_some());
        let proxied = value.get("Proxied").unwrap();
        assert!(proxied.get("images").is_some());
        assert!(proxied["images"].is_array());
    }
}
