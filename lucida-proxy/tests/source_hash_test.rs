#[path = "common/mod.rs"]
mod common;

use lucida_content::EntityId;
use lucida_proxy::source_content_hash;

use crate::common::{TileSpec, group_graph_with_tiles, level5};

fn build_two_tile_graph() -> lucida_content::DatasetManifest {
    group_graph_with_tiles(
        "group-A",
        &[
            TileSpec {
                tile_id: "tile-0",
                image_id: "img-0",
                tile_index: 0,
                translation_xy: [0.0, 0.0],
            },
            TileSpec {
                tile_id: "tile-1",
                image_id: "img-1",
                tile_index: 1,
                translation_xy: [100.0, 0.0],
            },
        ],
        vec![level5(0, [1, 1, 32, 64, 64]), level5(1, [1, 1, 16, 32, 32])],
    )
}

#[test]
fn hash_stable_under_reconstruction() {
    let g1 = build_two_tile_graph();
    let g2 = build_two_tile_graph();

    let entity = EntityId("group-A".into());
    let h1 = source_content_hash(&g1, &entity, 0, 0);
    let h2 = source_content_hash(&g2, &entity, 0, 0);
    assert_eq!(
        h1, h2,
        "hash must be stable across identical reconstruction"
    );
}

#[test]
fn hash_changes_when_transform_changes() {
    let g1 = build_two_tile_graph();
    // Same shape but with a moved tile.
    let g2 = group_graph_with_tiles(
        "group-A",
        &[
            TileSpec {
                tile_id: "tile-0",
                image_id: "img-0",
                tile_index: 0,
                translation_xy: [0.0, 0.0],
            },
            TileSpec {
                tile_id: "tile-1",
                image_id: "img-1",
                tile_index: 1,
                translation_xy: [200.0, 0.0], // changed
            },
        ],
        vec![level5(0, [1, 1, 32, 64, 64]), level5(1, [1, 1, 16, 32, 32])],
    );

    let entity = EntityId("group-A".into());
    let h1 = source_content_hash(&g1, &entity, 0, 0);
    let h2 = source_content_hash(&g2, &entity, 0, 0);
    assert_ne!(h1, h2, "transform change must change hash");
}

#[test]
fn hash_changes_when_level_geometry_changes() {
    let g1 = build_two_tile_graph();
    let g2 = group_graph_with_tiles(
        "group-A",
        &[
            TileSpec {
                tile_id: "tile-0",
                image_id: "img-0",
                tile_index: 0,
                translation_xy: [0.0, 0.0],
            },
            TileSpec {
                tile_id: "tile-1",
                image_id: "img-1",
                tile_index: 1,
                translation_xy: [100.0, 0.0],
            },
        ],
        vec![
            level5(0, [1, 1, 32, 128, 128]), // changed shape
            level5(1, [1, 1, 16, 32, 32]),
        ],
    );

    let entity = EntityId("group-A".into());
    let h1 = source_content_hash(&g1, &entity, 0, 0);
    let h2 = source_content_hash(&g2, &entity, 0, 0);
    assert_ne!(h1, h2, "level geometry change must change hash");
}

#[test]
fn hash_changes_when_t_or_c_changes() {
    let g = build_two_tile_graph();
    let entity = EntityId("group-A".into());
    let base = source_content_hash(&g, &entity, 0, 0);
    let t_changed = source_content_hash(&g, &entity, 1, 0);
    let c_changed = source_content_hash(&g, &entity, 0, 1);
    assert_ne!(base, t_changed);
    assert_ne!(base, c_changed);
}

#[test]
fn hash_invariant_under_transform_tile_order() {
    // Same effective graph but tile array order swapped — the hash
    // routine sorts contributing entities so result must match.
    let g_fwd = build_two_tile_graph();
    let g_rev = group_graph_with_tiles(
        "group-A",
        &[
            TileSpec {
                tile_id: "tile-1",
                image_id: "img-1",
                tile_index: 1,
                translation_xy: [100.0, 0.0],
            },
            TileSpec {
                tile_id: "tile-0",
                image_id: "img-0",
                tile_index: 0,
                translation_xy: [0.0, 0.0],
            },
        ],
        vec![level5(0, [1, 1, 32, 64, 64]), level5(1, [1, 1, 16, 32, 32])],
    );

    let entity = EntityId("group-A".into());
    let h1 = source_content_hash(&g_fwd, &entity, 0, 0);
    let h2 = source_content_hash(&g_rev, &entity, 0, 0);
    assert_eq!(h1, h2, "hash must be order-independent");
}

#[test]
fn hash_distinguishes_unrelated_graphs() {
    let g1 = build_two_tile_graph();
    let g2 = group_graph_with_tiles(
        "group-B", // different group id
        &[
            TileSpec {
                tile_id: "tile-0",
                image_id: "img-0",
                tile_index: 0,
                translation_xy: [0.0, 0.0],
            },
            TileSpec {
                tile_id: "tile-1",
                image_id: "img-1",
                tile_index: 1,
                translation_xy: [100.0, 0.0],
            },
        ],
        vec![level5(0, [1, 1, 32, 64, 64]), level5(1, [1, 1, 16, 32, 32])],
    );

    let h1 = source_content_hash(&g1, &EntityId("group-A".into()), 0, 0);
    let h2 = source_content_hash(&g2, &EntityId("group-B".into()), 0, 0);
    assert_ne!(h1, h2);
}
