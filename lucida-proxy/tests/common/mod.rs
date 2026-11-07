//! Shared test helpers: synthetic content graphs and a hash-map backed
//! `ProxySourceData` mock.

#![allow(dead_code)]

use std::collections::HashMap;

use lucida_content::{
    Axis, AxisKind, DataType, DatasetId, DatasetKind, DatasetManifest, Entity, EntityId,
    EntityKind, EntityLabels, ImageId, ImageSpec, LevelGeometry, MultiscaleInfo, TransformEdge,
    VoxelTransform,
};
use lucida_proxy::{ProxySourceData, SourceError, TileVolume};

/// Mock source: maps `(image_id, t, c, level) → TileVolume`.
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
    // Test fixture inserter; bundling the (t, c, level) and (data, dims, transform)
    // tuples would just push the same noise into the call sites.
    #[allow(clippy::too_many_arguments)]
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
    fn read_tile_volume(
        &self,
        image_id: &ImageId,
        t: u32,
        c: u32,
        level: usize,
    ) -> Result<TileVolume, SourceError> {
        self.volumes
            .get(&(image_id.0.clone(), t, c, level))
            .map(|v| TileVolume {
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
        grid_shape: [shape[0], shape[1], shape[2], shape[3], shape[4]],
        scale: [1.0; 5],
    }
}

pub fn standard_axes() -> Vec<Axis> {
    vec![
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
    ]
}

/// Build a single-image content graph (no collection). `levels` is the
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
            labels: EntityLabels {
                name: Some(entity_id.into()),
                ..Default::default()
            },
        }],
        vec![],
        vec![ImageSpec {
            image_id: ImageId(image_id.into()),
            owner: eid,
            multiscale: MultiscaleInfo {
                axes: standard_axes(),
                levels,
                coarse_level_index: None,
                generated_levels: vec![],
                data_type: DataType::Uint16,
                pinned_axes: vec![],
                downsampling_method: None,
                channel_infos: vec![],
            },
        }],
        vec![],
        None,
    )
}

/// Build a group content graph: one group + N tile children. Each tile
/// gets an ImageSpec and a `tile → group` translation transform.
pub fn group_graph_with_tiles(
    group_id: &str,
    tiles: &[TileSpec],
    levels: Vec<LevelGeometry>,
) -> DatasetManifest {
    let group_eid = EntityId(group_id.into());

    let mut entities = vec![Entity {
        id: group_eid.clone(),
        kind: EntityKind::Group,
        parent: None,
        labels: EntityLabels {
            name: Some(group_id.into()),
            row_index: Some(0),
            column_index: Some(0),
            ..Default::default()
        },
    }];

    let mut transforms = Vec::new();
    let mut images = Vec::new();

    for f in tiles {
        let fid = EntityId(f.tile_id.into());
        let img_id = ImageId(f.image_id.into());

        entities.push(Entity {
            id: fid.clone(),
            kind: EntityKind::Tile,
            parent: Some(group_eid.clone()),
            labels: EntityLabels {
                name: Some(f.tile_id.into()),
                tile_index: Some(f.tile_index),
                ..Default::default()
            },
        });

        transforms.push(TransformEdge {
            from: fid.clone(),
            to: group_eid.clone(),
            transform: VoxelTransform::from_voxel_translation_2d(
                f.translation_xy[0],
                f.translation_xy[1],
            ),
        });

        images.push(ImageSpec {
            image_id: img_id,
            owner: fid,
            multiscale: MultiscaleInfo {
                axes: standard_axes(),
                levels: levels.clone(),
                coarse_level_index: None,
                generated_levels: vec![],
                data_type: DataType::Uint16,
                pinned_axes: vec![],
                downsampling_method: None,
                channel_infos: vec![],
            },
        });
    }

    DatasetManifest::new(
        DatasetId("ds-test".into()),
        "test collection".into(),
        DatasetKind::Single,
        entities,
        transforms,
        images,
        vec![],
        None,
    )
}

#[derive(Clone, Copy)]
pub struct TileSpec<'a> {
    pub tile_id: &'a str,
    pub image_id: &'a str,
    pub tile_index: u32,
    /// XY translation in group coordinate space.
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
