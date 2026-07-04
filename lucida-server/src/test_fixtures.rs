//! Shared manifest fixture for server-side unit tests: one 5D uint16
//! image, single level, 2×2 grid.
use lucida_content::{
    Axis, AxisKind, DataType, DatasetId, DatasetKind, DatasetManifest, Entity, EntityId,
    EntityKind, EntityLabels, ImageId, ImageSpec, LevelGeometry, MultiscaleInfo,
};

pub(crate) fn single_image_manifest() -> DatasetManifest {
    let entity_id = EntityId("entity-1".into());
    DatasetManifest::new(
        DatasetId("ds-1".into()),
        "test".into(),
        DatasetKind::Single,
        vec![Entity {
            id: entity_id.clone(),
            kind: EntityKind::Image,
            parent: None,
            labels: EntityLabels::default(),
        }],
        vec![],
        vec![ImageSpec {
            image_id: ImageId("img-1".into()),
            owner: entity_id,
            multiscale: MultiscaleInfo {
                axes: vec![
                    Axis {
                        name: "t".into(),
                        kind: AxisKind::Time,
                    },
                    Axis {
                        name: "c".into(),
                        kind: AxisKind::Channel,
                    },
                    Axis {
                        name: "z".into(),
                        kind: AxisKind::Space,
                    },
                    Axis {
                        name: "y".into(),
                        kind: AxisKind::Space,
                    },
                    Axis {
                        name: "x".into(),
                        kind: AxisKind::Space,
                    },
                ],
                levels: vec![LevelGeometry {
                    level_index: 0,
                    shape: [1, 1, 1, 256, 256],
                    chunk_shape: [1, 1, 1, 128, 128],
                    grid_shape: [1, 1, 1, 2, 2],
                    scale: [1.0, 1.0, 1.0, 1.0, 1.0],
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
