#[path = "common/mod.rs"]
mod common;

use lucida_content::{AffineTransform, EntityId};
use lucida_proxy::{ProxyKind, ProxySpec, generate_proxy};

use crate::common::{FieldSpec, MockSource, fill_volume, level5, sample, well_graph_with_fields};

/// Four constant-fill 16×16×4 fields placed in a 2×2 grid (16-unit
/// spacing in X and Y, no gap). The well bounding box should span
/// 32×32×4 in well coordinates.
///
/// Field layout in well coords (XY):
///
/// ```text
/// (0..16, 0..16)   value=10    (16..32, 0..16)  value=20
/// (0..16, 16..32)  value=30    (16..32, 16..32) value=40
/// ```
///
/// We generate a target_long_axis=32 well proxy and check each quadrant.
#[test]
fn aggregate_2x2_grid_no_gap_no_overlap() {
    let dims = [4u32, 16, 16]; // [Z, Y, X]
    let levels = vec![level5(0, [1, 1, 4, 16, 16])];

    let graph = well_graph_with_fields(
        "well",
        &[
            FieldSpec {
                field_id: "f00", image_id: "img-00",
                field_index: 0, translation_xy: [0.0, 0.0],
            },
            FieldSpec {
                field_id: "f01", image_id: "img-01",
                field_index: 1, translation_xy: [16.0, 0.0],
            },
            FieldSpec {
                field_id: "f10", image_id: "img-10",
                field_index: 2, translation_xy: [0.0, 16.0],
            },
            FieldSpec {
                field_id: "f11", image_id: "img-11",
                field_index: 3, translation_xy: [16.0, 16.0],
            },
        ],
        levels,
    );

    let mut source = MockSource::default();
    for (img, value) in [("img-00", 10u16), ("img-01", 20), ("img-10", 30), ("img-11", 40)] {
        source.insert(
            img, 0, 0, 0,
            fill_volume(dims, value),
            dims,
            AffineTransform::identity(),
        );
    }

    let spec = ProxySpec {
        entity_id: EntityId("well".into()),
        kind: ProxyKind::WellProxy3D,
        t: 0, c: 0,
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
    for &(qx, qy, expected) in &[
        (4u32, 4u32, 10u16),
        (24, 4, 20),
        (4, 24, 30),
        (24, 24, 40),
    ] {
        let v = sample(&asset.voxels, asset.header.dims, z, qy, qx);
        assert_eq!(
            v, expected,
            "quadrant value mismatch at (z={z},y={qy},x={qx}): got {v}",
        );
    }
}

/// 2×2 grid with a 16-unit gap between fields (so well spans 48×48 in
/// XY). The voxels in the gap region must stay zero.
#[test]
fn aggregate_2x2_grid_with_gap_zero_filled() {
    let dims = [4u32, 16, 16];
    let levels = vec![level5(0, [1, 1, 4, 16, 16])];

    // Fields at corners of a 48×48 well with a 16-unit empty band in the middle.
    let graph = well_graph_with_fields(
        "well",
        &[
            FieldSpec {
                field_id: "f00", image_id: "img-00",
                field_index: 0, translation_xy: [0.0, 0.0],
            },
            FieldSpec {
                field_id: "f01", image_id: "img-01",
                field_index: 1, translation_xy: [32.0, 0.0],
            },
            FieldSpec {
                field_id: "f10", image_id: "img-10",
                field_index: 2, translation_xy: [0.0, 32.0],
            },
            FieldSpec {
                field_id: "f11", image_id: "img-11",
                field_index: 3, translation_xy: [32.0, 32.0],
            },
        ],
        levels,
    );

    let mut source = MockSource::default();
    for img in ["img-00", "img-01", "img-10", "img-11"] {
        source.insert(
            img, 0, 0, 0,
            fill_volume(dims, 100),
            dims,
            AffineTransform::identity(),
        );
    }

    let spec = ProxySpec {
        entity_id: EntityId("well".into()),
        kind: ProxyKind::WellProxy3D,
        t: 0, c: 0,
        target_long_axis: 48,
    };
    let asset = generate_proxy(&spec, &graph, &source).expect("generate ok");

    // Output should be 4×48×48.
    assert_eq!(asset.header.dims, [4, 48, 48]);

    // Check a corner pixel inside f00 (top-left field).
    let center_tl = sample(&asset.voxels, asset.header.dims, 2, 4, 4);
    assert_eq!(center_tl, 100, "TL field should fill its region");

    // Check a pixel deep in the gap band — both X and Y in the empty 16..32 zone.
    // The gap region has no field coverage, so it must be zero.
    let gap = sample(&asset.voxels, asset.header.dims, 2, 24, 24);
    assert_eq!(gap, 0, "gap region must be zero-filled, got {gap}");
}

/// One well with a single field: aggregation should produce a faithful
/// downsampling of that field.
#[test]
fn aggregate_single_field_well_works() {
    let dims = [4u32, 32, 32];
    let levels = vec![level5(0, [1, 1, 4, 32, 32])];

    let graph = well_graph_with_fields(
        "well",
        &[FieldSpec {
            field_id: "f0", image_id: "img-0",
            field_index: 0, translation_xy: [0.0, 0.0],
        }],
        levels,
    );

    let mut source = MockSource::default();
    source.insert(
        "img-0", 0, 0, 0,
        fill_volume(dims, 77),
        dims,
        AffineTransform::identity(),
    );

    let spec = ProxySpec {
        entity_id: EntityId("well".into()),
        kind: ProxyKind::WellProxy3D,
        t: 0, c: 0,
        target_long_axis: 16,
    };
    let asset = generate_proxy(&spec, &graph, &source).expect("generate ok");

    // Long axis is XY=32, target=16 → scale 0.5.
    assert_eq!(asset.header.dims, [2, 16, 16]);
    assert!(
        asset.voxels.iter().all(|&v| v == 77),
        "single-field well should be uniform fill"
    );
}

/// Two overlapping fields should produce an averaged result in the
/// overlap zone. Outside the overlap, each region reflects its own field.
#[test]
fn aggregate_overlapping_fields_average() {
    let dims = [2u32, 16, 16]; // small Z, easier to reason about
    let levels = vec![level5(0, [1, 1, 2, 16, 16])];

    // Two fields of width 16 placed at X=0 and X=8 — they overlap in X=8..16.
    let graph = well_graph_with_fields(
        "well",
        &[
            FieldSpec {
                field_id: "fL", image_id: "img-L",
                field_index: 0, translation_xy: [0.0, 0.0],
            },
            FieldSpec {
                field_id: "fR", image_id: "img-R",
                field_index: 1, translation_xy: [8.0, 0.0],
            },
        ],
        levels,
    );

    let mut source = MockSource::default();
    source.insert("img-L", 0, 0, 0, fill_volume(dims, 100), dims, AffineTransform::identity());
    source.insert("img-R", 0, 0, 0, fill_volume(dims, 200), dims, AffineTransform::identity());

    let spec = ProxySpec {
        entity_id: EntityId("well".into()),
        kind: ProxyKind::WellProxy3D,
        t: 0, c: 0,
        target_long_axis: 24,
    };
    let asset = generate_proxy(&spec, &graph, &source).unwrap();

    // X span 0..24, Y span 0..16, Z span 0..2 (well bounding box).
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
