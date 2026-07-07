mod common;

use lucida_content::{EntityId, VoxelTransform};
use lucida_proxy::{ProxyKind, ProxySpec, estimate_proxy_dims, generate_proxy};

use crate::common::{
    MockSource, TileSpec, fill_volume, group_graph_with_tiles, level5, single_image_graph,
};

#[test]
fn tile_estimate_matches_generated_proxy_dims() {
    let content = single_image_graph("tile-1", "img-1", vec![level5(0, [1, 1, 4, 16, 32])]);
    let mut source = MockSource::default();
    source.insert(
        "img-1",
        0,
        0,
        0,
        fill_volume([4, 16, 32], 7),
        [4, 16, 32],
        VoxelTransform::identity(),
    );
    let spec = ProxySpec {
        entity_id: EntityId("tile-1".into()),
        kind: ProxyKind::TileProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 8,
    };

    let estimate = estimate_proxy_dims(&spec, &content).unwrap();
    let generated = generate_proxy(&spec, &content, &source).unwrap();

    assert_eq!(estimate, [1, 4, 8]);
    assert_eq!(generated.header.dims, estimate);
}

#[test]
fn group_estimate_matches_generated_proxy_dims() {
    let content = group_graph_with_tiles(
        "group-A1",
        &[
            TileSpec {
                tile_id: "tile-1",
                image_id: "img-1",
                tile_index: 0,
                translation_xy: [0.0, 0.0],
            },
            TileSpec {
                tile_id: "tile-2",
                image_id: "img-2",
                tile_index: 1,
                translation_xy: [16.0, 0.0],
            },
        ],
        vec![level5(0, [1, 1, 1, 16, 16])],
    );
    let mut source = MockSource::default();
    for image_id in ["img-1", "img-2"] {
        source.insert(
            image_id,
            0,
            0,
            0,
            fill_volume([1, 16, 16], 7),
            [1, 16, 16],
            VoxelTransform::identity(),
        );
    }
    let spec = ProxySpec {
        entity_id: EntityId("group-A1".into()),
        kind: ProxyKind::GroupProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 8,
    };

    let estimate = estimate_proxy_dims(&spec, &content).unwrap();
    let generated = generate_proxy(&spec, &content, &source).unwrap();

    assert_eq!(estimate, [1, 4, 8]);
    assert_eq!(generated.header.dims, estimate);
}
