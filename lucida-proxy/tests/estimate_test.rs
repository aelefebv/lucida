mod common;

use lucida_content::{EntityId, VoxelTransform};
use lucida_proxy::{ProxyKind, ProxySpec, estimate_proxy_dims, generate_proxy};

use crate::common::{
    FieldSpec, MockSource, fill_volume, level5, single_image_graph, well_graph_with_fields,
};

#[test]
fn field_estimate_matches_generated_proxy_dims() {
    let content = single_image_graph("field-1", "img-1", vec![level5(0, [1, 1, 4, 16, 32])]);
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
        entity_id: EntityId("field-1".into()),
        kind: ProxyKind::FieldProxy3D,
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
fn well_estimate_matches_generated_proxy_dims() {
    let content = well_graph_with_fields(
        "well-A1",
        &[
            FieldSpec {
                field_id: "field-1",
                image_id: "img-1",
                field_index: 0,
                translation_xy: [0.0, 0.0],
            },
            FieldSpec {
                field_id: "field-2",
                image_id: "img-2",
                field_index: 1,
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
        entity_id: EntityId("well-A1".into()),
        kind: ProxyKind::WellProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 8,
    };

    let estimate = estimate_proxy_dims(&spec, &content).unwrap();
    let generated = generate_proxy(&spec, &content, &source).unwrap();

    assert_eq!(estimate, [1, 4, 8]);
    assert_eq!(generated.header.dims, estimate);
}
