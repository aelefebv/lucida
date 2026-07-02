use serde::{Deserialize, Serialize};

use crate::entity::Entity;
use crate::id::{DatasetId, LayoutId};
use crate::image::ImageSpec;
use crate::kind::DatasetKind;
use crate::label::{LabelAttachment, LabelSpec};
use crate::layout::LayoutSpec;
use crate::transform::TransformEdge;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetManifest {
    pub dataset_id: DatasetId,
    pub name: String,
    pub kind: DatasetKind,
    entities: Vec<Entity>,
    transforms: Vec<TransformEdge>,
    images: Vec<ImageSpec>,
    source_layouts: Vec<LayoutSpec>,
    pub default_layout_id: Option<LayoutId>,
    /// Segmentation labels attached to images in this dataset. Kept separate
    /// from `images` so labels never render as ordinary intensity images.
    /// `#[serde(default)]` keeps manifests written before labels existed
    /// deserializable; `skip_serializing_if` keeps label-less datasets' wire
    /// form byte-identical to the pre-labels output.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    labels: Vec<LabelSpec>,
}

impl DatasetManifest {
    // All eight args are required identity fields; the manifest is built once
    // per dataset, so a builder for a single constructor would only add noise.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        dataset_id: DatasetId,
        name: String,
        kind: DatasetKind,
        entities: Vec<Entity>,
        transforms: Vec<TransformEdge>,
        images: Vec<ImageSpec>,
        source_layouts: Vec<LayoutSpec>,
        default_layout_id: Option<LayoutId>,
    ) -> Self {
        Self {
            dataset_id,
            name,
            kind,
            entities,
            transforms,
            images,
            source_layouts,
            default_layout_id,
            labels: Vec::new(),
        }
    }

    /// Attach segmentation labels discovered during import. A consuming builder
    /// so the freshly constructed manifest can be enriched in one expression
    /// without widening the constructor (which has many call sites).
    pub fn with_labels(mut self, labels: Vec<LabelSpec>) -> Self {
        self.labels = labels;
        self
    }

    pub fn entities(&self) -> &[Entity] {
        &self.entities
    }

    pub fn transforms(&self) -> &[TransformEdge] {
        &self.transforms
    }

    pub fn images(&self) -> &[ImageSpec] {
        &self.images
    }

    pub fn images_mut(&mut self) -> &mut [ImageSpec] {
        &mut self.images
    }

    pub fn source_layouts(&self) -> &[LayoutSpec] {
        &self.source_layouts
    }

    /// The stored label specs, each carrying the label's own multiscale image
    /// and color table. This is the rich view a streaming/render path uses to
    /// reach a label's full per-level geometry.
    pub fn label_specs(&self) -> &[LabelSpec] {
        &self.labels
    }

    /// Every label attached to any image in this dataset (standalone or plate),
    /// projected into the lean [`LabelAttachment`] read-view.
    pub fn labels(&self) -> Vec<LabelAttachment> {
        self.labels.iter().map(LabelAttachment::from_spec).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity::{EntityKind, EntityLabels};
    use crate::id::{EntityId, ImageId};
    use crate::image::{Axis, AxisKind, DataType, LevelGeometry, MultiscaleInfo};
    use crate::transform::VoxelTransform;

    fn make_single_image_graph() -> DatasetManifest {
        let entity_id = EntityId("img-0".to_string());
        let image_id = ImageId("multiscale-0".to_string());

        DatasetManifest::new(
            DatasetId("ds-test".to_string()),
            "test dataset".to_string(),
            DatasetKind::Single,
            vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some("image.tiff".to_string()),
                    ..Default::default()
                },
            }],
            vec![TransformEdge {
                from: entity_id.clone(),
                to: entity_id.clone(),
                transform: VoxelTransform::identity(),
            }],
            vec![ImageSpec {
                image_id,
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis {
                            name: "t".to_string(),
                            kind: AxisKind::Time,
                        },
                        Axis {
                            name: "c".to_string(),
                            kind: AxisKind::Channel,
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
                        shape: [1, 1, 10, 256, 256],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, 1, 10, 2, 2],
                        scale: [1.0, 1.0, 1.0, 0.5, 0.5],
                    }],
                    coarse_level_index: None,
                    generated_levels: vec![],
                    data_type: DataType::Uint16,
                    pinned_axes: vec![],
                    channel_infos: vec![],
                },
            }],
            vec![],
            None,
        )
    }

    #[test]
    fn serde_round_trip() {
        let graph = make_single_image_graph();
        let json = serde_json::to_string_pretty(&graph).unwrap();
        let back: DatasetManifest = serde_json::from_str(&json).unwrap();

        assert_eq!(graph.dataset_id, back.dataset_id);
        assert_eq!(graph.name, back.name);
        assert_eq!(graph.entities().len(), back.entities().len());
        assert_eq!(graph.entities()[0].id, back.entities()[0].id);
        assert_eq!(graph.entities()[0].kind, back.entities()[0].kind);
        assert_eq!(graph.images().len(), back.images().len());
        assert_eq!(graph.images()[0].image_id, back.images()[0].image_id);
        assert_eq!(
            graph.images()[0].multiscale.data_type,
            back.images()[0].multiscale.data_type
        );
        assert_eq!(
            graph.images()[0].multiscale.levels[0].shape,
            back.images()[0].multiscale.levels[0].shape
        );
        assert_eq!(graph.transforms().len(), back.transforms().len());
        assert_eq!(graph.transforms()[0].from, back.transforms()[0].from);
        assert_eq!(graph.default_layout_id, back.default_layout_id);
    }

    fn sample_label_spec() -> crate::label::LabelSpec {
        crate::label::LabelSpec {
            name: "mitochondria".to_string(),
            source_image_id: ImageId("multiscale-0".to_string()),
            image: ImageSpec {
                image_id: ImageId("multiscale-0:label:mitochondria".to_string()),
                // Shares the source image's owning entity for placement.
                owner: EntityId("img-0".to_string()),
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
                    generated_levels: vec![],
                    data_type: DataType::Uint32,
                    pinned_axes: vec![],
                    channel_infos: vec![],
                },
            },
            colors: vec![crate::label::LabelColor {
                value: 92801,
                rgba: [1, 2, 3, 255],
            }],
            source_declared: true,
        }
    }

    #[test]
    fn serde_round_trip_with_labels() {
        let graph = make_single_image_graph().with_labels(vec![sample_label_spec()]);
        let json = serde_json::to_string_pretty(&graph).unwrap();
        let back: DatasetManifest = serde_json::from_str(&json).unwrap();

        // The stored spec (label's own image + colors) survives intact.
        assert_eq!(back.label_specs().len(), 1);
        let spec = &back.label_specs()[0];
        assert_eq!(spec.name, "mitochondria");
        assert_eq!(spec.source_image_id, ImageId("multiscale-0".to_string()));
        assert_eq!(spec.image.multiscale.data_type, DataType::Uint32);
        assert_eq!(
            spec.image.multiscale.levels[0].scale,
            [1.0, 1.0, 1.0, 4.0, 4.0]
        );
        assert_eq!(spec.colors.len(), 1);
        // A label value beyond u16 survives the JSON round trip untouched.
        assert_eq!(spec.colors[0].value, 92801);
        assert!(spec.source_declared);

        // The projected read-view is intact, including the source entity used
        // for placement.
        let labels = back.labels();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].source_entity_id, EntityId("img-0".to_string()));
        assert_eq!(labels[0].data_type, DataType::Uint32);
        assert_eq!(labels[0].level0_scale, [1.0, 1.0, 1.0, 4.0, 4.0]);
    }

    #[test]
    fn label_less_manifest_omits_labels_and_defaults() {
        let graph = make_single_image_graph();
        let value = serde_json::to_value(&graph).unwrap();
        // skip_serializing_if keeps the wire byte-identical to pre-labels output.
        assert!(
            value.get("labels").is_none(),
            "label-less manifest must not emit a `labels` key, got: {value}",
        );

        // A manifest JSON written before labels existed (no `labels` key) still
        // deserializes, defaulting to no labels.
        let back: DatasetManifest = serde_json::from_value(value).unwrap();
        assert!(back.label_specs().is_empty());
        assert!(back.labels().is_empty());
    }
}
