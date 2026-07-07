use std::collections::HashMap;

use lucida_content::{DataType, ImageId};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

/// How a client turns logical chunk addresses into bytes for a dataset.
/// Enum by mode because the modes need different fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FetchSource {
    Proxied(ProxiedFetchDescriptor),
    Direct(DirectFetchDescriptor),
    Local(LocalFetchDescriptor),
}

/// Server-proxied fetch. Client sends logical chunk keys,
/// server resolves storage paths and returns bytes.
///
/// # Wire encoding
///
/// A wide collection registers one proxied image per tile, and every tile
/// shares the same [`WireFormat`]; repeating it per image made the descriptor
/// scale with tile count. The JSON form therefore emits any format shared by
/// two or more images once, in a top-level `wire_formats` table, with the
/// sharing images carrying a `wire_format_ref` index; unique formats stay
/// inline, so payloads with nothing shared (every single-image descriptor)
/// are byte-identical to the fully-inline form this encoding replaced. When
/// the table is present, the descriptor leads with a `format_version` marker
/// ([`COMPACT_FETCH_FORMAT_VERSION`]) so future readers can recognize the
/// format generation; decoders that predate the compact form hard-reject any
/// descriptor that uses it (see
/// `wiki/gotchas/compact-manifest-decoder-one-way-door.md`).
///
/// Decoding accepts both forms and resolves references back into the
/// in-memory model — consumers always see a populated
/// [`ProxiedImageSpec::wire_format`]. The serialization fixed point is the
/// canonical encoder output: `encode(decode(x)) == x` byte-for-byte when `x`
/// came out of this encoder, while valid non-canonical inputs (duplicate or
/// unreferenced table entries, inline duplicates) decode fine and re-encode
/// canonically. (`Direct`/`Local` descriptors keep the inline form: their
/// entries are dominated by genuinely per-image paths.)
#[derive(Debug, Clone)]
pub struct ProxiedFetchDescriptor {
    pub images: Vec<ProxiedImageSpec>,
}

/// Value of the `format_version` marker emitted whenever the descriptor uses
/// the shared `wire_formats` table. Absence means the fully-inline form,
/// which every decoder generation reads. Ignored by today's consumers and
/// not involved in reference resolution; versioned separately from the
/// manifest's marker because the two structures evolve independently.
pub const COMPACT_FETCH_FORMAT_VERSION: u32 = 2;

/// What the client needs to know about a proxied image's responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxiedImageSpec {
    pub image_id: ImageId,
    pub wire_format: WireFormat,
}

impl Serialize for ProxiedFetchDescriptor {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Formats shared by ≥ 2 images, in first-appearance order — the
        // emitted table order, so it must depend only on the image sequence,
        // never on map iteration. The index map keeps this O(images) even if
        // every format were distinct; `WireFormat` derives `Hash`
        // consistently with `Eq` (no floats), so no collision confirm is
        // needed beyond the map's own.
        let mut distinct: Vec<(&WireFormat, usize)> = Vec::new();
        let mut distinct_by_format: HashMap<&WireFormat, usize> = HashMap::new();
        let mut membership: Vec<usize> = Vec::with_capacity(self.images.len());
        for image in &self.images {
            match distinct_by_format.get(&image.wire_format) {
                Some(&index) => {
                    distinct[index].1 += 1;
                    membership.push(index);
                }
                None => {
                    distinct_by_format.insert(&image.wire_format, distinct.len());
                    distinct.push((&image.wire_format, 1));
                    membership.push(distinct.len() - 1);
                }
            }
        }
        let mut table: Vec<&WireFormat> = Vec::new();
        let mut table_index_by_distinct: Vec<Option<u32>> = Vec::with_capacity(distinct.len());
        for (format, count) in &distinct {
            if *count >= 2 {
                table.push(*format);
                table_index_by_distinct.push(Some((table.len() - 1) as u32));
            } else {
                table_index_by_distinct.push(None);
            }
        }

        struct ImagesWire<'a> {
            images: &'a [ProxiedImageSpec],
            refs: &'a [Option<u32>],
        }
        struct ImageWireRef<'a> {
            image: &'a ProxiedImageSpec,
            table_ref: &'a Option<u32>,
        }
        impl Serialize for ImagesWire<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.collect_seq(
                    self.images
                        .iter()
                        .zip(self.refs)
                        .map(|(image, table_ref)| ImageWireRef { image, table_ref }),
                )
            }
        }
        impl Serialize for ImageWireRef<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut state = serializer.serialize_struct("ProxiedImageSpec", 2)?;
                state.serialize_field("image_id", &self.image.image_id)?;
                match self.table_ref {
                    Some(index) => state.serialize_field("wire_format_ref", index)?,
                    None => state.serialize_field("wire_format", &self.image.wire_format)?,
                }
                state.end()
            }
        }

        let refs: Vec<Option<u32>> = membership
            .into_iter()
            .map(|distinct_index| table_index_by_distinct[distinct_index])
            .collect();
        let field_count = 1 + 2 * usize::from(!table.is_empty());
        let mut state = serializer.serialize_struct("ProxiedFetchDescriptor", field_count)?;
        // Marker and table travel together: a marker-less descriptor is in
        // the fully-inline form every decoder generation reads, so
        // single-image descriptors stay byte-identical to it.
        if !table.is_empty() {
            state.serialize_field("format_version", &COMPACT_FETCH_FORMAT_VERSION)?;
        }
        state.serialize_field(
            "images",
            &ImagesWire {
                images: &self.images,
                refs: &refs,
            },
        )?;
        if !table.is_empty() {
            state.serialize_field("wire_formats", &table)?;
        }
        state.end()
    }
}

/// Decode-side wire shape: inline `wire_format` (fully-inline and unique
/// entries) or `wire_format_ref` into the descriptor's `wire_formats` table.
///
/// Resolving a reference clones a [`WireFormat`] — a fixed-size value — so
/// expansion stays proportional to the image list the input already paid
/// for, and no decode-side expansion cap is needed here (unlike the
/// manifest's multiscale table, whose entries have unbounded interior).
#[derive(Deserialize)]
struct ProxiedFetchDescriptorWire {
    /// Compact-format marker ([`COMPACT_FETCH_FORMAT_VERSION`]); absent on
    /// fully-inline descriptors. Deliberately unread — decoding is driven by
    /// which fields each entry carries, not by the marker.
    #[serde(default)]
    #[allow(dead_code)]
    format_version: Option<u32>,
    images: Vec<ProxiedImageSpecWire>,
    #[serde(default)]
    wire_formats: Vec<WireFormat>,
}

#[derive(Deserialize)]
struct ProxiedImageSpecWire {
    image_id: ImageId,
    #[serde(default)]
    wire_format: Option<WireFormat>,
    #[serde(default)]
    wire_format_ref: Option<u32>,
}

impl TryFrom<ProxiedFetchDescriptorWire> for ProxiedFetchDescriptor {
    type Error = String;

    fn try_from(wire: ProxiedFetchDescriptorWire) -> Result<Self, String> {
        let formats = wire.wire_formats;
        let images = wire
            .images
            .into_iter()
            .map(|image| {
                let wire_format = match (image.wire_format, image.wire_format_ref) {
                    (Some(format), None) => format,
                    (None, Some(index)) => {
                        formats.get(index as usize).cloned().ok_or_else(|| {
                            format!(
                                "proxied image {} references shared wire format {index}, but \
                                 the descriptor declares {} shared format(s)",
                                image.image_id,
                                formats.len(),
                            )
                        })?
                    }
                    (Some(_), Some(_)) => {
                        return Err(format!(
                            "proxied image {} carries both an inline wire format and a \
                             wire_format_ref",
                            image.image_id,
                        ));
                    }
                    (None, None) => {
                        return Err(format!(
                            "proxied image {} carries neither a wire format nor a \
                             wire_format_ref",
                            image.image_id,
                        ));
                    }
                };
                Ok(ProxiedImageSpec {
                    image_id: image.image_id,
                    wire_format,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(ProxiedFetchDescriptor { images })
    }
}

impl<'de> Deserialize<'de> for ProxiedFetchDescriptor {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = ProxiedFetchDescriptorWire::deserialize(deserializer)?;
        wire.try_into().map_err(serde::de::Error::custom)
    }
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
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
        let desc = FetchSource::Proxied(ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id: ImageId("img1".into()),
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        });
        let json = serde_json::to_string(&desc).unwrap();
        let back: FetchSource = serde_json::from_str(&json).unwrap();
        match &back {
            FetchSource::Proxied(p) => {
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
        let desc = FetchSource::Direct(DirectFetchDescriptor {
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
        let back: FetchSource = serde_json::from_str(&json).unwrap();
        match &back {
            FetchSource::Direct(d) => {
                assert_eq!(d.images.len(), 1);
                assert_eq!(d.images[0].image_id, ImageId("img2".into()));
                assert_eq!(d.images[0].levels.len(), 2);
                assert_eq!(d.images[0].levels[0].level_index, 0);
                assert_eq!(d.images[0].levels[1].path, "s3://bucket/level1");
                assert_eq!(d.images[0].store_prefix, Some("s3://bucket".to_string()));
            }
            _ => panic!("expected Direct variant"),
        }
    }

    #[test]
    fn local_round_trip() {
        let desc = FetchSource::Local(LocalFetchDescriptor {
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
        let back: FetchSource = serde_json::from_str(&json).unwrap();
        match &back {
            FetchSource::Local(l) => {
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

    fn wide_proxied(image_count: usize) -> ProxiedFetchDescriptor {
        ProxiedFetchDescriptor {
            images: (0..image_count)
                .map(|i| ProxiedImageSpec {
                    image_id: ImageId(format!("wds-9c41:image:A/{}/{}", i / 4, i % 4)),
                    wire_format: WireFormat::Raw {
                        data_type: DataType::Uint16,
                    },
                })
                .collect(),
        }
    }

    #[test]
    fn proxied_wire_encodes_shared_format_once() {
        let desc = wide_proxied(50);
        let value = serde_json::to_value(&desc).unwrap();

        let formats = value["wire_formats"].as_array().unwrap();
        assert_eq!(formats.len(), 1);
        for image in value["images"].as_array().unwrap() {
            assert!(
                image.get("wire_format").is_none(),
                "sharing image must not inline its format: {image}",
            );
            assert_eq!(image["wire_format_ref"], serde_json::json!(0));
        }
    }

    #[test]
    fn proxied_wire_bytes_scale_with_structure_not_images() {
        let small = serde_json::to_string(&wide_proxied(10)).unwrap();
        let large = serde_json::to_string(&wide_proxied(110)).unwrap();
        let per_image = (large.len() - small.len()) / 100;
        assert!(
            per_image <= 80,
            "marginal fetch bytes per image too high: {per_image} > 80",
        );
    }

    #[test]
    fn proxied_wire_round_trip_is_lossless_and_stable() {
        let mut desc = wide_proxied(9);
        // One divergent format stays inline alongside the shared table.
        desc.images.push(ProxiedImageSpec {
            image_id: ImageId("wds-9c41:image:A/2/0:label:region-a".into()),
            wire_format: WireFormat::Raw {
                data_type: DataType::Uint32,
            },
        });

        let encoded = serde_json::to_string(&desc).unwrap();
        let decoded: ProxiedFetchDescriptor = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.images.len(), 10);
        for (original, back) in desc.images.iter().zip(&decoded.images) {
            assert_eq!(original.image_id, back.image_id);
            assert_eq!(original.wire_format, back.wire_format);
        }
        let re_encoded = serde_json::to_string(&decoded).unwrap();
        assert_eq!(re_encoded, encoded);
    }

    #[test]
    fn unique_formats_stay_inline_and_omit_the_table() {
        // The historical single-image shape is preserved byte-for-byte.
        let desc = ProxiedFetchDescriptor {
            images: vec![ProxiedImageSpec {
                image_id: ImageId("img1".into()),
                wire_format: WireFormat::Raw {
                    data_type: DataType::Uint16,
                },
            }],
        };
        let json = serde_json::to_string(&desc).unwrap();
        assert_eq!(
            json,
            r#"{"images":[{"image_id":"img1","wire_format":{"Raw":{"data_type":"Uint16"}}}]}"#,
        );
    }

    #[test]
    fn format_version_marker_tracks_the_shared_table() {
        // Shared table → marker leads the descriptor.
        let value = serde_json::to_value(wide_proxied(3)).unwrap();
        assert_eq!(
            value["format_version"],
            serde_json::json!(COMPACT_FETCH_FORMAT_VERSION),
        );

        // Nothing shared → no marker (locked byte-for-byte by
        // `unique_formats_stay_inline_and_omit_the_table`).
        let value = serde_json::to_value(wide_proxied(1)).unwrap();
        assert!(value.get("format_version").is_none());
    }

    #[test]
    fn format_version_marker_is_tolerated_and_ignored_on_decode() {
        // The marker plays no role in resolution: a descriptor carrying an
        // unrecognized future version still decodes from its fields.
        let back: ProxiedFetchDescriptor = serde_json::from_value(serde_json::json!({
            "format_version": 9,
            "images": [{"image_id": "img1", "wire_format": {"Raw": {"data_type": "Uint16"}}}]
        }))
        .unwrap();
        assert_eq!(back.images.len(), 1);
    }

    #[test]
    fn proxied_wire_rejects_bad_entries() {
        // Reference past the table.
        let err = serde_json::from_value::<ProxiedFetchDescriptor>(serde_json::json!({
            "images": [{"image_id": "img1", "wire_format_ref": 3}],
            "wire_formats": [{"Raw": {"data_type": "Uint16"}}]
        }))
        .unwrap_err();
        assert!(err.to_string().contains("references shared wire format 3"));

        // Neither inline nor reference.
        let err = serde_json::from_value::<ProxiedFetchDescriptor>(serde_json::json!({
            "images": [{"image_id": "img1"}]
        }))
        .unwrap_err();
        assert!(
            err.to_string()
                .contains("neither a wire format nor a wire_format_ref")
        );

        // Both at once is ambiguous.
        let err = serde_json::from_value::<ProxiedFetchDescriptor>(serde_json::json!({
            "images": [{
                "image_id": "img1",
                "wire_format": {"Raw": {"data_type": "Uint16"}},
                "wire_format_ref": 0
            }],
            "wire_formats": [{"Raw": {"data_type": "Uint16"}}]
        }))
        .unwrap_err();
        assert!(
            err.to_string()
                .contains("both an inline wire format and a wire_format_ref")
        );
    }

    #[test]
    fn json_shape_externally_tagged() {
        let desc = FetchSource::Proxied(ProxiedFetchDescriptor {
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
