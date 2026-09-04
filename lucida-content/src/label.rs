use serde::{Deserialize, Serialize};

use crate::id::{EntityId, ImageId};
use crate::image::{DataType, ImageSpec};

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
    /// Label-group name (e.g. `"region-b"`), unique within its source image.
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

/// Read-view of a label attachment, projected from a [`LabelSpec`].
///
/// This is the lean shape consumers use to discover what labels exist and how
/// they align: the label's identity, its source image, its integer dtype, the
/// label's own axes and normalized level-0 scale (the alignment foundation),
/// and its color table. Full per-level geometry lives on the backing
/// [`LabelSpec`] for the streaming path.
#[derive(Debug, Clone)]
pub struct LabelAttachment {
    pub name: String,
    /// The intensity image this label overlays.
    pub source_image_id: ImageId,
    /// The entity that owns the source image. This is the entity to resolve in
    /// the active layout to position the label overlay, so discovery via
    /// `labels()` needs nothing beyond this read-view for placement.
    pub source_entity_id: EntityId,
    /// The label's own image id (distinct from the source image).
    pub label_image_id: ImageId,
    pub data_type: DataType,
    /// The label's own axis names, in declared order (e.g. `["t","z","y","x"]`).
    pub axis_names: Vec<String>,
    /// The label's level-0 scale in fixed canonical 5D order
    /// `[T=0, C=1, Z=2, Y=3, X=4]`, with any axis the label omits filled with
    /// `1.0`. This ordering is independent of `axis_names`: index `i` of
    /// `level0_scale` is always the canonical axis above, NOT `axis_names[i]`.
    /// A label with axes `["t","z","y","x"]` still reports its Z scale at index
    /// `2` and carries `1.0` at index `1` (the absent channel axis).
    pub level0_scale: [f64; 5],
    pub colors: Vec<LabelColor>,
    pub source_declared: bool,
}

impl LabelAttachment {
    /// Project a stored [`LabelSpec`] into the read-view. `axis_names` and
    /// `level0_scale` are taken from the label's own multiscale so they stay
    /// consistent with each other; a label with no levels degrades to a unit
    /// scale rather than panicking.
    pub(crate) fn from_spec(spec: &LabelSpec) -> Self {
        let axis_names = spec
            .image
            .multiscale
            .axes
            .iter()
            .map(|axis| axis.name.clone())
            .collect();
        let level0_scale = spec
            .image
            .multiscale
            .levels
            .first()
            .map(|level| level.scale)
            .unwrap_or([1.0; 5]);
        LabelAttachment {
            name: spec.name.clone(),
            source_image_id: spec.source_image_id.clone(),
            source_entity_id: spec.image.owner.clone(),
            label_image_id: spec.image.image_id.clone(),
            data_type: spec.image.multiscale.data_type,
            axis_names,
            level0_scale,
            colors: spec.colors.clone(),
            source_declared: spec.source_declared,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::EntityId;
    use crate::image::{Axis, AxisKind, LevelGeometry, MultiscaleInfo};

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
                    downsampling_method: None,
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
    fn projection_preserves_dtype_axes_and_scale() {
        let spec = label_spec("region-b");
        let att = LabelAttachment::from_spec(&spec);

        assert_eq!(att.name, "region-b");
        assert_eq!(att.source_image_id, ImageId("img-0".to_string()));
        // The read-view is self-contained for placement: it exposes the source
        // image's owning entity directly.
        assert_eq!(att.source_entity_id, EntityId("ent-0".to_string()));
        assert_eq!(
            att.label_image_id,
            ImageId("img-0:label:region-b".to_string())
        );
        // dtype must survive projection exactly (no 16-bit truncation).
        assert_eq!(att.data_type, DataType::Uint32);
        assert_eq!(att.axis_names, vec!["t", "z", "y", "x"]);
        // The label's own level-0 scale, normalized to 5D with c filled to 1.
        // Index 1 (channel) is 1.0 even though axis_names has no "c".
        assert_eq!(att.level0_scale, [1.0, 1.0, 1.0, 4.0, 4.0]);
        assert!(att.source_declared);
    }

    #[test]
    fn projection_carries_large_color_values() {
        let att = LabelAttachment::from_spec(&label_spec("region-b"));
        assert_eq!(att.colors.len(), 1);
        // A value well past u16::MAX round-trips untouched.
        assert_eq!(att.colors[0].value, 92801);
        assert_eq!(att.colors[0].rgba, [10, 20, 30, 255]);
    }

    #[test]
    fn spec_round_trips_through_serde() {
        let spec = label_spec("region-c");
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
