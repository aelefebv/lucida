#[path = "common/mod.rs"]
mod common;

use lucida_content::{EntityId, VoxelTransform};
use lucida_proxy::{ALGORITHM_VERSION, ProxyDtype, ProxyKind, ProxySpec, generate_proxy};

use crate::common::{MockSource, gradient_volume_x, level5, sample, single_image_graph};

/// 256³ source volume with linear-X gradient → 128³ proxy.
/// Verify dims and that each output voxel is roughly the box-filter
/// average of the corresponding input region.
#[test]
fn downsample_256_to_128_x_gradient() {
    // Build a graph with a single image whose level 0 is 256³.
    let graph = single_image_graph(
        "img-entity",
        "img-id",
        vec![level5(0, [1, 1, 256, 256, 256])],
    );

    // The mock source returns a synthetic 256³ gradient volume.
    let dims_in: [u32; 3] = [256, 256, 256];
    let mut source = MockSource::default();
    source.insert(
        "img-id",
        0,
        0,
        0, // level 0 chosen because no smaller level exists; also picks here
        gradient_volume_x(dims_in),
        dims_in,
        VoxelTransform::identity(),
    );

    let spec = ProxySpec {
        entity_id: EntityId("img-entity".into()),
        kind: ProxyKind::TileProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 128,
    };

    let asset = generate_proxy(&spec, &graph, &source).expect("generate ok");
    assert_eq!(asset.header.algorithm_version, ALGORITHM_VERSION);
    assert_eq!(asset.header.dtype, ProxyDtype::U16);
    assert_eq!(asset.header.dims, [128, 128, 128]);
    assert_eq!(asset.voxels.len(), 128 * 128 * 128);

    // Each output X voxel covers two input X voxels: x=0 covers in 0..2,
    // x=1 covers 2..4, etc. Mean of (2k, 2k+1) is 2k + 0.5 => floor truncates
    // to 2k (because we accumulate u64 then divide).
    // Verify a handful.
    for &(ox, expected_lo, expected_hi) in &[
        (0u32, 0u16, 1u16),
        (1u32, 2u16, 3u16),
        (10u32, 20u16, 21u16),
        (63u32, 126u16, 127u16),
        (127u32, 254u16, 255u16),
    ] {
        let v = sample(&asset.voxels, asset.header.dims, 0, 0, ox);
        assert!(
            v == expected_lo || v == expected_hi,
            "x={ox}: got {v}, expected {expected_lo} or {expected_hi}"
        );
    }

    // Same gradient should hold across Z and Y (gradient is X-only, so
    // every Z/Y row should look the same as row 0).
    for &(z, y) in &[(0u32, 0u32), (37, 99), (127, 127)] {
        let row0 = sample(&asset.voxels, asset.header.dims, 0, 0, 64);
        let rowzy = sample(&asset.voxels, asset.header.dims, z, y, 64);
        assert_eq!(rowzy, row0, "X gradient should be Z/Y invariant: ({z},{y})");
    }
}

/// Anisotropic input: longest axis caps to target, others scale
/// proportionally; never upsamples.
#[test]
fn downsample_anisotropic_proportional_scaling() {
    let graph = single_image_graph(
        "img-entity",
        "img-id",
        vec![level5(0, [1, 1, 64, 256, 128])],
    );

    let dims_in: [u32; 3] = [64, 256, 128];
    let mut source = MockSource::default();
    source.insert(
        "img-id",
        0,
        0,
        0,
        vec![42u16; (64 * 256 * 128) as usize],
        dims_in,
        VoxelTransform::identity(),
    );

    let spec = ProxySpec {
        entity_id: EntityId("img-entity".into()),
        kind: ProxyKind::TileProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 128,
    };

    let asset = generate_proxy(&spec, &graph, &source).expect("generate ok");
    // Long axis is Y=256, target=128 → scale factor 0.5.
    // Z=64 → 32, Y=256 → 128, X=128 → 64.
    assert_eq!(asset.header.dims, [32, 128, 64]);
    // Constant fill stays constant.
    assert!(asset.voxels.iter().all(|&v| v == 42));
}

/// `target_long_axis` larger than the source must not upsample.
#[test]
fn downsample_target_larger_than_source_clamps() {
    let graph = single_image_graph("img-entity", "img-id", vec![level5(0, [1, 1, 16, 32, 32])]);
    let mut source = MockSource::default();
    source.insert(
        "img-id",
        0,
        0,
        0,
        vec![7u16; (16 * 32 * 32) as usize],
        [16, 32, 32],
        VoxelTransform::identity(),
    );

    let spec = ProxySpec {
        entity_id: EntityId("img-entity".into()),
        kind: ProxyKind::TileProxy3D,
        t: 0,
        c: 0,
        target_long_axis: 256, // larger than source
    };

    let asset = generate_proxy(&spec, &graph, &source).unwrap();
    // Should clamp to source dims.
    assert_eq!(asset.header.dims, [16, 32, 32]);
    assert!(asset.voxels.iter().all(|&v| v == 7));
}
