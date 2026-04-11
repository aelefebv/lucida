use serde::{Deserialize, Serialize};

use crate::entity::Entity;
use crate::id::{DatasetId, LayoutId};
use crate::image::ImageSpec;
use crate::kind::DatasetKind;
use crate::layout::LayoutSpec;
use crate::transform::TransformEdge;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentGraph {
    pub dataset_id: DatasetId,
    pub name: String,
    pub kind: DatasetKind,
    pub entities: Vec<Entity>,
    pub transforms: Vec<TransformEdge>,
    pub images: Vec<ImageSpec>,
    pub source_layouts: Vec<LayoutSpec>,
    pub default_layout_id: Option<LayoutId>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entity::{EntityKind, EntityLabels};
    use crate::id::{EntityId, ImageId};
    use crate::image::{
        Axis, AxisKind, DataType, LevelGeometry, MultiscaleInfo,
    };
    use crate::transform::AffineTransform;

    fn make_single_image_graph() -> ContentGraph {
        let entity_id = EntityId("img-0".to_string());
        let image_id = ImageId("multiscale-0".to_string());

        ContentGraph {
            dataset_id: DatasetId("ds-test".to_string()),
            name: "test dataset".to_string(),
            kind: DatasetKind::Single,
            entities: vec![Entity {
                id: entity_id.clone(),
                kind: EntityKind::Image,
                parent: None,
                labels: EntityLabels {
                    name: Some("image.tiff".to_string()),
                    ..Default::default()
                },
            }],
            transforms: vec![TransformEdge {
                from: entity_id.clone(),
                to: entity_id.clone(),
                transform: AffineTransform::identity(),
            }],
            images: vec![ImageSpec {
                image_id,
                owner: entity_id,
                multiscale: MultiscaleInfo {
                    axes: vec![
                        Axis { name: "t".to_string(), kind: AxisKind::Time },
                        Axis { name: "c".to_string(), kind: AxisKind::Channel },
                        Axis { name: "z".to_string(), kind: AxisKind::Space },
                        Axis { name: "y".to_string(), kind: AxisKind::Space },
                        Axis { name: "x".to_string(), kind: AxisKind::Space },
                    ],
                    levels: vec![LevelGeometry {
                        level_index: 0,
                        shape: [1, 1, 10, 256, 256],
                        chunk_shape: [1, 1, 1, 128, 128],
                        grid_shape: [1, 1, 10, 2, 2],
                        scale: [1.0, 1.0, 1.0, 0.5, 0.5],
                    }],
                    data_type: DataType::Uint16,
                },
            }],
            source_layouts: vec![],
            default_layout_id: None,
        }
    }

    #[test]
    fn serde_round_trip() {
        let graph = make_single_image_graph();
        let json = serde_json::to_string_pretty(&graph).unwrap();
        let back: ContentGraph = serde_json::from_str(&json).unwrap();

        assert_eq!(graph.dataset_id, back.dataset_id);
        assert_eq!(graph.name, back.name);
        assert_eq!(graph.entities.len(), back.entities.len());
        assert_eq!(graph.entities[0].id, back.entities[0].id);
        assert_eq!(graph.entities[0].kind, back.entities[0].kind);
        assert_eq!(graph.images.len(), back.images.len());
        assert_eq!(graph.images[0].image_id, back.images[0].image_id);
        assert_eq!(
            graph.images[0].multiscale.data_type,
            back.images[0].multiscale.data_type
        );
        assert_eq!(
            graph.images[0].multiscale.levels[0].shape,
            back.images[0].multiscale.levels[0].shape
        );
        assert_eq!(graph.transforms.len(), back.transforms.len());
        assert_eq!(graph.transforms[0].from, back.transforms[0].from);
        assert_eq!(graph.default_layout_id, back.default_layout_id);
    }
}
