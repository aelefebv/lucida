#[path = "common/mod.rs"]
mod common;

use lucida_content::EntityId;
use lucida_proxy::source_content_hash;

use crate::common::{FieldSpec, level5, well_graph_with_fields};

fn build_two_field_graph() -> lucida_content::DatasetManifest {
    well_graph_with_fields(
        "well-A",
        &[
            FieldSpec {
                field_id: "field-0",
                image_id: "img-0",
                field_index: 0,
                translation_xy: [0.0, 0.0],
            },
            FieldSpec {
                field_id: "field-1",
                image_id: "img-1",
                field_index: 1,
                translation_xy: [100.0, 0.0],
            },
        ],
        vec![level5(0, [1, 1, 32, 64, 64]), level5(1, [1, 1, 16, 32, 32])],
    )
}

#[test]
fn hash_stable_under_reconstruction() {
    let g1 = build_two_field_graph();
    let g2 = build_two_field_graph();

    let entity = EntityId("well-A".into());
    let h1 = source_content_hash(&g1, &entity, 0, 0);
    let h2 = source_content_hash(&g2, &entity, 0, 0);
    assert_eq!(
        h1, h2,
        "hash must be stable across identical reconstruction"
    );
}

#[test]
fn hash_changes_when_transform_changes() {
    let g1 = build_two_field_graph();
    // Same shape but with a moved field.
    let g2 = well_graph_with_fields(
        "well-A",
        &[
            FieldSpec {
                field_id: "field-0",
                image_id: "img-0",
                field_index: 0,
                translation_xy: [0.0, 0.0],
            },
            FieldSpec {
                field_id: "field-1",
                image_id: "img-1",
                field_index: 1,
                translation_xy: [200.0, 0.0], // changed
            },
        ],
        vec![level5(0, [1, 1, 32, 64, 64]), level5(1, [1, 1, 16, 32, 32])],
    );

    let entity = EntityId("well-A".into());
    let h1 = source_content_hash(&g1, &entity, 0, 0);
    let h2 = source_content_hash(&g2, &entity, 0, 0);
    assert_ne!(h1, h2, "transform change must change hash");
}

#[test]
fn hash_changes_when_level_geometry_changes() {
    let g1 = build_two_field_graph();
    let g2 = well_graph_with_fields(
        "well-A",
        &[
            FieldSpec {
                field_id: "field-0",
                image_id: "img-0",
                field_index: 0,
                translation_xy: [0.0, 0.0],
            },
            FieldSpec {
                field_id: "field-1",
                image_id: "img-1",
                field_index: 1,
                translation_xy: [100.0, 0.0],
            },
        ],
        vec![
            level5(0, [1, 1, 32, 128, 128]), // changed shape
            level5(1, [1, 1, 16, 32, 32]),
        ],
    );

    let entity = EntityId("well-A".into());
    let h1 = source_content_hash(&g1, &entity, 0, 0);
    let h2 = source_content_hash(&g2, &entity, 0, 0);
    assert_ne!(h1, h2, "level geometry change must change hash");
}

#[test]
fn hash_changes_when_t_or_c_changes() {
    let g = build_two_field_graph();
    let entity = EntityId("well-A".into());
    let base = source_content_hash(&g, &entity, 0, 0);
    let t_changed = source_content_hash(&g, &entity, 1, 0);
    let c_changed = source_content_hash(&g, &entity, 0, 1);
    assert_ne!(base, t_changed);
    assert_ne!(base, c_changed);
}

#[test]
fn hash_invariant_under_transform_field_order() {
    // Same effective graph but field array order swapped — the hash
    // routine sorts contributing entities so result must match.
    let g_fwd = build_two_field_graph();
    let g_rev = well_graph_with_fields(
        "well-A",
        &[
            FieldSpec {
                field_id: "field-1",
                image_id: "img-1",
                field_index: 1,
                translation_xy: [100.0, 0.0],
            },
            FieldSpec {
                field_id: "field-0",
                image_id: "img-0",
                field_index: 0,
                translation_xy: [0.0, 0.0],
            },
        ],
        vec![level5(0, [1, 1, 32, 64, 64]), level5(1, [1, 1, 16, 32, 32])],
    );

    let entity = EntityId("well-A".into());
    let h1 = source_content_hash(&g_fwd, &entity, 0, 0);
    let h2 = source_content_hash(&g_rev, &entity, 0, 0);
    assert_eq!(h1, h2, "hash must be order-independent");
}

#[test]
fn hash_distinguishes_unrelated_graphs() {
    let g1 = build_two_field_graph();
    let g2 = well_graph_with_fields(
        "well-B", // different well id
        &[
            FieldSpec {
                field_id: "field-0",
                image_id: "img-0",
                field_index: 0,
                translation_xy: [0.0, 0.0],
            },
            FieldSpec {
                field_id: "field-1",
                image_id: "img-1",
                field_index: 1,
                translation_xy: [100.0, 0.0],
            },
        ],
        vec![level5(0, [1, 1, 32, 64, 64]), level5(1, [1, 1, 16, 32, 32])],
    );

    let h1 = source_content_hash(&g1, &EntityId("well-A".into()), 0, 0);
    let h2 = source_content_hash(&g2, &EntityId("well-B".into()), 0, 0);
    assert_ne!(h1, h2);
}
