//! Shared test helpers: synthetic content graphs and a hash-map backed
//! `ProxySourceData` mock.

#![allow(dead_code)]

use std::collections::HashMap;

use lucida_content::{
    Axis, AxisKind, DatasetManifest, DataType, DatasetId, DatasetKind, Entity, EntityId, EntityKind,
    EntityLabels, ImageId, ImageSpec, LevelGeometry, MultiscaleInfo, TransformEdge, VoxelTransform,
};
use lucida_proxy::{FieldVolume, ProxySourceData, SourceError};

/// Mock source: maps `(image_id, t, c, level) → FieldVolume`.
#[derive(Default)]
pub struct MockSource {
    pub volumes: HashMap<(String, u32, u32, usize), StoredVolume>,
}

#[derive(Clone)]
pub struct StoredVolume {
    pub data: Vec<u16>,
    pub dims: [u32; 3],
    pub voxel_to_image: VoxelTransform,
}

impl MockSource {
    pub fn insert(
        &mut self,
        image_id: &str,
        t: u32,
        c: u32,
        level: usize,
        data: Vec<u16>,
        dims: [u32; 3],
        voxel_to_image: VoxelTransform,
    ) {
        self.volumes.insert(
            (image_id.to_string(), t, c, level),
            StoredVolume {
                data,
                dims,
                voxel_to_image,
            },
        );
    }
}

impl ProxySourceData for MockSource {
    fn read_field_volume(
        &self,
        image_id: &ImageId,
        t: u32,
        c: u32,
        level: usize,
    ) -> Result<FieldVolume, SourceError> {
        self.volumes
            .get(&(image_id.0.clone(), t, c, level))
            .map(|v| FieldVolume {
                data: v.data.clone(),
                dims: v.dims,
                voxel_to_image: v.voxel_to_image.clone(),
            })
            .ok_or(SourceError::NotFound)
    }
}

/// 5D shape `[T, C, Z, Y, X]` for tests.
pub fn level5(level_index: u32, shape: [u64; 5]) -> LevelGeometry {
    LevelGeometry {
        level_index,
        shape,
        chunk_shape: [1, 1, 1, 1, 1],
        grid_shape: [
            shape[0],
            shape[1],
            shape[2],
            shape[3],
            shape[4],
        ],
        scale: [1.0; 5],
    }
}

pub fn standard_axes() -> Vec<Axis> {
    vec![
        Axis { name: "t".into(), kind: AxisKind::Time },
        Axis { name: "c".into(), kind: AxisKind::Channel },
        Axis { name: "z".into(), kind: AxisKind::Space },
        Axis { name: "y".into(), kind: AxisKind::Space },
        Axis { name: "x".into(), kind: AxisKind::Space },
    ]
}

/// Build a single-image content graph (no plate). `levels` is the
/// pyramid; the entity owns one ImageSpec.
pub fn single_image_graph(
    entity_id: &str,
    image_id: &str,
    levels: Vec<LevelGeometry>,
) -> DatasetManifest {
    let eid = EntityId(entity_id.into());
    DatasetManifest::new(
        DatasetId("ds-test".into()),
        "test".into(),
        DatasetKind::Single,
        vec![Entity {
            id: eid.clone(),
            kind: EntityKind::Image,
            parent: None,
            labels: EntityLabels { name: Some(entity_id.into()), ..Default::default() },
        }],
        vec![],
        vec![ImageSpec {
            image_id: ImageId(image_id.into()),
            owner: eid,
            multiscale: MultiscaleInfo {
                axes: standard_axes(),
                levels,
                data_type: DataType::Uint16,
                pinned_axes: vec![],
            },
        }],
        vec![],
        None,
    )
}

/// Build a well content graph: one well + N field children. Each field
/// gets an ImageSpec and a `field → well` translation transform.
pub fn well_graph_with_fields(
    well_id: &str,
    fields: &[FieldSpec],
    levels: Vec<LevelGeometry>,
) -> DatasetManifest {
    let well_eid = EntityId(well_id.into());

    let mut entities = vec![Entity {
        id: well_eid.clone(),
        kind: EntityKind::Well,
        parent: None,
        labels: EntityLabels {
            name: Some(well_id.into()),
            row_index: Some(0),
            column_index: Some(0),
            ..Default::default()
        },
    }];

    let mut transforms = Vec::new();
    let mut images = Vec::new();

    for f in fields {
        let fid = EntityId(f.field_id.into());
        let img_id = ImageId(f.image_id.into());

        entities.push(Entity {
            id: fid.clone(),
            kind: EntityKind::Field,
            parent: Some(well_eid.clone()),
            labels: EntityLabels {
                name: Some(f.field_id.into()),
                field_index: Some(f.field_index),
                ..Default::default()
            },
        });

        transforms.push(TransformEdge {
            from: fid.clone(),
            to: well_eid.clone(),
            transform: VoxelTransform::from_voxel_translation_2d(f.translation_xy[0], f.translation_xy[1]),
        });

        images.push(ImageSpec {
            image_id: img_id,
            owner: fid,
            multiscale: MultiscaleInfo {
                axes: standard_axes(),
                levels: levels.clone(),
                data_type: DataType::Uint16,
                pinned_axes: vec![],
            },
        });
    }

    DatasetManifest::new(
        DatasetId("ds-test".into()),
        "test plate".into(),
        DatasetKind::Single,
        entities,
        transforms,
        images,
        vec![],
        None,
    )
}

#[derive(Clone, Copy)]
pub struct FieldSpec<'a> {
    pub field_id: &'a str,
    pub image_id: &'a str,
    pub field_index: u32,
    /// XY translation in well coordinate space.
    pub translation_xy: [f64; 2],
}

/// Build a packed `[Z, Y, X]` u16 buffer of size `dims` filled with
/// `value` everywhere.
pub fn fill_volume(dims: [u32; 3], value: u16) -> Vec<u16> {
    vec![value; (dims[0] as usize) * (dims[1] as usize) * (dims[2] as usize)]
}

/// Build a packed `[Z, Y, X]` u16 buffer with a linear gradient along X
/// (so we can verify averaging behavior).
pub fn gradient_volume_x(dims: [u32; 3]) -> Vec<u16> {
    let mut out = vec![0u16; (dims[0] as usize) * (dims[1] as usize) * (dims[2] as usize)];
    for z in 0..dims[0] {
        for y in 0..dims[1] {
            for x in 0..dims[2] {
                let idx = ((z * dims[1] + y) * dims[2] + x) as usize;
                out[idx] = x as u16;
            }
        }
    }
    out
}

/// Sample a packed `[Z, Y, X]` volume by index.
pub fn sample(buf: &[u16], dims: [u32; 3], z: u32, y: u32, x: u32) -> u16 {
    let idx = ((z * dims[1] + y) * dims[2] + x) as usize;
    buf[idx]
}
