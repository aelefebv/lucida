use serde::{Deserialize, Serialize};

use crate::id::ImageId;
use crate::image::ImageSpec;

/// One entry of an OME `image-label` color table: the integer label value and
/// the RGBA it should render as.
///
/// `value` is an `i64` because label ids routinely exceed the 16-bit range
/// (uint32 masks are common); it is carried through without truncation. `rgba`
/// is a fixed 4-byte tuple `[r, g, b, a]` in `0..=255`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelColor {
    pub value: i64,
    pub rgba: [u8; 4],
}

/// A segmentation-mask label attached to a source intensity image, stored on
/// the [`crate::graph::DatasetManifest`] as a first-class overlay member.
///
/// A label carries its OWN multiscale image ([`ImageSpec`]) — distinct axes,
/// per-level geometry, scale, and integer dtype from the source image — so a
/// later render pass can stream and draw it as an overlay layer at the source
/// image's placement, aligned by the label's own coordinate scale rather than
/// the source's. It is deliberately kept out of
/// [`crate::graph::DatasetManifest::images`] so nothing treats a label as an
/// ordinary intensity image; consumers reach labels through the dedicated
/// accessors.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelSpec {
    /// Label-group name (e.g. `"mitochondria"`), unique within its source image.
    pub name: String,
    /// The intensity image this label overlays.
    pub source_image_id: ImageId,
    /// The label's own multiscale image (id, owning entity, geometry, dtype).
    pub image: ImageSpec,
    /// `image-label.colors`, validated; empty when the block omits colors.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub colors: Vec<LabelColor>,
    /// Whether the `image-label.source.image` back-pointer was declared.
    #[serde(default)]
    pub source_declared: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::EntityId;
    use crate::image::{Axis, AxisKind, DataType, LevelGeometry, MultiscaleInfo};

    fn label_spec(name: &str) -> LabelSpec {
        LabelSpec {
            name: name.to_string(),
            source_image_id: ImageId("img-0".to_string()),
            image: ImageSpec {
                image_id: ImageId(format!("img-0:label:{name}")),
                owner: EntityId("ent-0".to_string()),
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "z".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "y".to_string(),
                            kind: AxisKind::Space,
                        },
                        Axis {
                            name: "x".to_string(),
                            kind: AxisKind::Space,
                        },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, 1, 30, 85, 87],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, 1, 30, 1, 1],
                        scale: [1.0, 1.0, 1.0, 4.0, 4.0],
                    }],
                    coarse_level_index: None,
                    generated_levels: Vec::new(),
                    data_type: DataType::Uint32,
                    pinned_axes: Vec::new(),
                    channel_infos: Vec::new(),
                },
            },
            colors: vec![LabelColor {
                value: 92801,
                rgba: [10, 20, 30, 255],
            }],
            source_declared: true,
        }
    }

    #[test]
    fn spec_round_trips_through_serde() {
        let spec = label_spec("cells");
        let json = serde_json::to_string(&spec).unwrap();
        let back: LabelSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, spec.name);
        assert_eq!(back.image.image_id, spec.image.image_id);
        assert_eq!(back.colors, spec.colors);
        assert_eq!(back.source_declared, spec.source_declared);
    }

    #[test]
    fn empty_colors_are_omitted_on_the_wire() {
        let mut spec = label_spec("foreground");
        spec.colors.clear();
        let json = serde_json::to_value(&spec).unwrap();
        assert!(
            json.get("colors").is_none(),
            "empty colors must not serialize, got: {json}",
        );
    }
}
