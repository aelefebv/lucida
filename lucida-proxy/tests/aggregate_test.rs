#[path = "common/mod.rs"]
mod common;

use lucida_content::{EntityId, VoxelTransform};
use lucida_proxy::{ProxyKind, ProxySpec, generate_proxy};

use crate::common::{MockSource, TileSpec, fill_volume, group_graph_with_tiles, level5, sample};

/// Four constant-fill 16×16×4 tiles placed in a 2×2 grid (16-unit
/// spacing in X and Y, no gap). The group bounding box should span
/// 32×32×4 in group coordinates.
///
/// Tile layout in group coords (XY):
///
/// ```text
/// (0..16, 0..16)   value=10    (16..32, 0..16)  value=20
/// (0..16, 16..32)  value=30    (16..32, 16..32) value=40
/// ```
///
/// We generate a target_long_axis=32 group proxy and check each quadrant.
#[test]
fn aggregate_2x2_grid_no_gap_no_overlap() {
    let dims = [4u32, 16, 16]; // [Z, Y, X]
    let levels = vec![level5(0, [1, 1, 4, 16, 16])];

    let graph = group_graph_with_tiles(
        "group",
        &[
            TileSpec {
                tile_id: "f00",
                image_id: "img-00",
                tile_index: 0,
                translation_xy: [0.0, 0.0],
            },
            TileSpec {
                tile_id: "f01",
                image_id: "img-01",
                tile_index: 1,
                translation_xy: [16.0, 0.0],
            },
            TileSpec {
                tile_id: "f10",
                image_id: "img-10",
                tile_index: 2,
                translation_xy: [0.0, 16.0],
            },
            TileSpec {
                tile_id: "f11",
                image_id: "img-11",
                tile_index: 3,
                translation_xy: [16.0, 16.0],
            },
        ],
        levels,
    );

    let mut source = MockSource::default();
    for (img, value) in [
        ("img-00", 10u16),
        ("img-01", 20),
        ("img-10", 30),
        ("img-11", 40),
    ] {
        source.insert(
            img,
            0,
            0,
            0,
            fill_volume(dims, value),
            dims,
            VoxelTransform::identity(),
        );
    }

    let spec = ProxySpec {
        entity_id: EntityId("group".into()),
        kind: ProxyKind::GroupProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 32,
    };
    let asset = generate_proxy(&spec, &graph, &source).expect("generate ok");

    // Long axis is XY=32, scale=1.0 → output should be 4×32×32.
    assert_eq!(asset.header.dims, [4, 32, 32], "expected [Z=4, Y=32, X=32]");

    // Pick a center voxel in each quadrant and verify the value.
    // Quadrant TL  (X=0..16,  Y=0..16)  → value 10
    // Quadrant TR  (X=16..32, Y=0..16)  → value 20
    // Quadrant BL  (X=0..16,  Y=16..32) → value 30
    // Quadrant BR  (X=16..32, Y=16..32) → value 40
    let z = 2u32; // mid-z
    for &(qx, qy, expected) in &[(4u32, 4u32, 10u16), (24, 4, 20), (4, 24, 30), (24, 24, 40)] {
        let v = sample(&asset.voxels, asset.header.dims, z, qy, qx);
        assert_eq!(
            v, expected,
            "quadrant value mismatch at (z={z},y={qy},x={qx}): got {v}",
        );
    }
}

/// 2×2 grid with a 16-unit gap between tiles (so group spans 48×48 in
/// XY). The voxels in the gap region must stay zero.
#[test]
fn aggregate_2x2_grid_with_gap_zero_filled() {
    let dims = [4u32, 16, 16];
    let levels = vec![level5(0, [1, 1, 4, 16, 16])];

    // Tiles at corners of a 48×48 group with a 16-unit empty band in the middle.
    let graph = group_graph_with_tiles(
        "group",
        &[
            TileSpec {
                tile_id: "f00",
                image_id: "img-00",
                tile_index: 0,
                translation_xy: [0.0, 0.0],
            },
            TileSpec {
                tile_id: "f01",
                image_id: "img-01",
                tile_index: 1,
                translation_xy: [32.0, 0.0],
            },
            TileSpec {
                tile_id: "f10",
                image_id: "img-10",
                tile_index: 2,
                translation_xy: [0.0, 32.0],
            },
            TileSpec {
                tile_id: "f11",
                image_id: "img-11",
                tile_index: 3,
                translation_xy: [32.0, 32.0],
            },
        ],
        levels,
    );

    let mut source = MockSource::default();
    for img in ["img-00", "img-01", "img-10", "img-11"] {
        source.insert(
            img,
            0,
            0,
            0,
            fill_volume(dims, 100),
            dims,
            VoxelTransform::identity(),
        );
    }

    let spec = ProxySpec {
        entity_id: EntityId("group".into()),
        kind: ProxyKind::GroupProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 48,
    };
    let asset = generate_proxy(&spec, &graph, &source).expect("generate ok");

    // Output should be 4×48×48.
    assert_eq!(asset.header.dims, [4, 48, 48]);

    // Check a corner pixel inside f00 (top-left tile).
    let center_tl = sample(&asset.voxels, asset.header.dims, 2, 4, 4);
    assert_eq!(center_tl, 100, "TL tile should fill its region");

    // Check a pixel deep in the gap band — both X and Y in the empty 16..32 zone.
    // The gap region has no tile coverage, so it must be zero.
    let gap = sample(&asset.voxels, asset.header.dims, 2, 24, 24);
    assert_eq!(gap, 0, "gap region must be zero-filled, got {gap}");
}

/// One group with a single tile: aggregation should produce a faithful
/// downsampling of that tile.
#[test]
fn aggregate_single_tile_group_works() {
    let dims = [4u32, 32, 32];
    let levels = vec![level5(0, [1, 1, 4, 32, 32])];

    let graph = group_graph_with_tiles(
        "group",
        &[TileSpec {
            tile_id: "f0",
            image_id: "img-0",
            tile_index: 0,
            translation_xy: [0.0, 0.0],
        }],
        levels,
    );

    let mut source = MockSource::default();
    source.insert(
        "img-0",
        0,
        0,
        0,
        fill_volume(dims, 77),
        dims,
        VoxelTransform::identity(),
    );

    let spec = ProxySpec {
        entity_id: EntityId("group".into()),
        kind: ProxyKind::GroupProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 16,
    };
    let asset = generate_proxy(&spec, &graph, &source).expect("generate ok");

    // Long axis is XY=32, target=16 → scale 0.5.
    assert_eq!(asset.header.dims, [2, 16, 16]);
    assert!(
        asset.voxels.iter().all(|&v| v == 77),
        "single-tile group should be uniform fill"
    );
}

/// Two overlapping tiles should produce an averaged result in the
/// overlap zone. Outside the overlap, each region reflects its own tile.
#[test]
fn aggregate_overlapping_tiles_average() {
    let dims = [2u32, 16, 16]; // small Z, easier to reason about
    let levels = vec![level5(0, [1, 1, 2, 16, 16])];

    // Two tiles of width 16 placed at X=0 and X=8 — they overlap in X=8..16.
    let graph = group_graph_with_tiles(
        "group",
        &[
            TileSpec {
                tile_id: "fL",
                image_id: "img-L",
                tile_index: 0,
                translation_xy: [0.0, 0.0],
            },
            TileSpec {
                tile_id: "fR",
                image_id: "img-R",
                tile_index: 1,
                translation_xy: [8.0, 0.0],
            },
        ],
        levels,
    );

    let mut source = MockSource::default();
    source.insert(
        "img-L",
        0,
        0,
        0,
        fill_volume(dims, 100),
        dims,
        VoxelTransform::identity(),
    );
    source.insert(
        "img-R",
        0,
        0,
        0,
        fill_volume(dims, 200),
        dims,
        VoxelTransform::identity(),
    );

    let spec = ProxySpec {
        entity_id: EntityId("group".into()),
        kind: ProxyKind::GroupProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 24,
    };
    let asset = generate_proxy(&spec, &graph, &source).unwrap();

    // X span 0..24, Y span 0..16, Z span 0..2 (group bounding box).
    // Long axis = X = 24, target = 24, scale = 1.
    assert_eq!(asset.header.dims, [2, 16, 24]);

    // X=0..8: only fL → 100.
    let v_left = sample(&asset.voxels, asset.header.dims, 0, 8, 4);
    assert_eq!(v_left, 100);

    // X=16..24: only fR → 200.
    let v_right = sample(&asset.voxels, asset.header.dims, 0, 8, 20);
    assert_eq!(v_right, 200);

    // X=8..16: overlap → average (100 + 200) / 2 = 150.
    let v_overlap = sample(&asset.voxels, asset.header.dims, 0, 8, 12);
    assert_eq!(v_overlap, 150, "overlap region should average");
}

/// Regression for #417: when a tile's volume is read at a downsampled level,
/// the source must provide a `voxel_to_image` scale transform mapping the
/// level's voxel coords back to full-res-equivalent units. Without it, tiles
/// shrink to `full_res / 2^level` in the group-space proxy.
///
/// Setup: 2x2 grid group, tiles are 32×32×32 at full-res, served downsampled
/// to 16×16×16 (2x scale). Each tile has a unique constant fill value.
/// `tile_to_group` translations are in full-res units (32-voxel pitch, no gap).
/// With the correct `voxel_to_image = scale 2x`, the proxy's group-space AABB
/// spans 64×64×32 and each quadrant of the output is filled with the
/// corresponding tile's value. Without it, the AABB would only span 32×32×16
/// and tile content would not align to expected quadrants.
#[test]
fn aggregate_downsampled_voxel_to_image_preserves_tile_extent() {
    // Tile volumes provided at level 1 (16³), full-res is 32³ (2x scale).
    let level_dims = [16u32, 16, 16]; // [Z, Y, X] of the served downsampled volume
    let levels = vec![
        level5(0, [1, 1, 32, 32, 32]), // full-res
        level5(1, [1, 1, 16, 16, 16]), // downsampled
    ];

    // Tile translations are in full-res voxel units: 32-pitch 2x2 grid.
    let graph = group_graph_with_tiles(
        "group",
        &[
            TileSpec {
                tile_id: "f00",
                image_id: "img-00",
                tile_index: 0,
                translation_xy: [0.0, 0.0],
            },
            TileSpec {
                tile_id: "f01",
                image_id: "img-01",
                tile_index: 1,
                translation_xy: [32.0, 0.0],
            },
            TileSpec {
                tile_id: "f10",
                image_id: "img-10",
                tile_index: 2,
                translation_xy: [0.0, 32.0],
            },
            TileSpec {
                tile_id: "f11",
                image_id: "img-11",
                tile_index: 3,
                translation_xy: [32.0, 32.0],
            },
        ],
        levels,
    );

    // voxel_to_image as the lucida-server fix would produce it: shape ratio
    // (32/16 = 2.0) along each spatial axis.
    let scale_2x = VoxelTransform::from_voxel_matrix([
        2.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ]);

    // Source returns the downsampled volume at level 1 with the scale transform.
    // (Level 0 isn't inserted — pick_level should pick level 1 below.)
    let mut source = MockSource::default();
    for (img, value) in [
        ("img-00", 11u16),
        ("img-01", 22),
        ("img-10", 33),
        ("img-11", 44),
    ] {
        source.insert(
            img,
            0,
            0,
            1,
            fill_volume(level_dims, value),
            level_dims,
            scale_2x.clone(),
        );
    }

    // target_long_axis=8 → threshold=16. Level 0 min spatial=32 ✓, level 1 min=16 ✓
    // → pick_level walks both, last passing level wins → chosen=1.
    let spec = ProxySpec {
        entity_id: EntityId("group".into()),
        kind: ProxyKind::GroupProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 8,
    };
    let asset = generate_proxy(&spec, &graph, &source).expect("generate ok");

    // Expected group bounding box (in full-res-equivalent units): 64×64 in XY, 32 in Z.
    // Long axis = 64. Output scale = 8/64 = 0.125.
    // out_dims = [Z=32*0.125=4, Y=64*0.125=8, X=64*0.125=8].
    assert_eq!(
        asset.header.dims,
        [4, 8, 8],
        "group AABB should be full-res-equivalent (64×64×32), not collapsed to level dims (32×32×16)"
    );

    // Each quadrant of the [4, 8, 8] proxy should be filled with one tile's value.
    // Sample mid-quadrant voxel for each:
    //   TL  (X=0..4, Y=0..4) → f00 → 11
    //   TR  (X=4..8, Y=0..4) → f01 → 22
    //   BL  (X=0..4, Y=4..8) → f10 → 33
    //   BR  (X=4..8, Y=4..8) → f11 → 44
    let z = 2;
    for &(qx, qy, expected) in &[(1u32, 1u32, 11u16), (5, 1, 22), (1, 5, 33), (5, 5, 44)] {
        let v = sample(&asset.voxels, asset.header.dims, z, qy, qx);
        assert_eq!(v, expected, "quadrant ({qx},{qy}) value mismatch — got {v}");
    }
}
