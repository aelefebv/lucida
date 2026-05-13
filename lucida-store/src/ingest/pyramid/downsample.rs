use rayon::prelude::*;

/// A single resolution level of the image pyramid.
///
/// Data is stored in TCZYX order (T outermost, X innermost).
pub struct LevelData {
    pub data: Vec<u16>,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub channels: u32,
    pub timepoints: u32,
}

/// Generalized downsample dispatcher.
pub fn downsample(src: &LevelData, do_xy: bool, do_z: bool) -> LevelData {
    match (do_xy, do_z) {
        (true, false) => downsample_xy(src),
        (false, true) => downsample_z_only(src),
        (true, true) => downsample_xyz(src),
        (false, false) => panic!("downsample called with no axes to downsample"),
    }
}

/// Downsample a level by 2x in XY using box averaging. T, C, Z stay the same.
pub fn downsample_xy(src: &LevelData) -> LevelData {
    let dst_w = src.width.div_ceil(2);
    let dst_h = src.height.div_ceil(2);
    let src_plane = (src.width * src.height) as usize;
    let dst_plane = (dst_w * dst_h) as usize;
    let num_planes = (src.timepoints * src.channels * src.depth) as usize;

    let mut data = vec![0u16; num_planes * dst_plane];

    // Precompute edge boundaries: for even src dimensions, bulk covers everything.
    let bulk_dx_end = if src.width.is_multiple_of(2) {
        dst_w
    } else {
        dst_w - 1
    };
    let bulk_dy_end = if src.height.is_multiple_of(2) {
        dst_h
    } else {
        dst_h - 1
    };
    let src_w = src.width;

    data.par_chunks_mut(dst_plane)
        .enumerate()
        .for_each(|(p, dst_slice)| {
            let src_off = p * src_plane;
            let src = &src.data[src_off..src_off + src_plane];

            // Bulk path: all 4 pixels always valid, no bounds checks
            for dy in 0..bulk_dy_end {
                let sy = (dy * 2) as usize;
                let row0 = sy * src_w as usize;
                let row1 = row0 + src_w as usize;
                for dx in 0..bulk_dx_end {
                    let sx = (dx * 2) as usize;
                    let sum = src[row0 + sx] as u32
                        + src[row0 + sx + 1] as u32
                        + src[row1 + sx] as u32
                        + src[row1 + sx + 1] as u32;
                    dst_slice[(dy * dst_w + dx) as usize] = (sum / 4) as u16;
                }
                // Right edge column (odd width): average 2 pixels vertically
                if bulk_dx_end < dst_w {
                    let sx = (bulk_dx_end * 2) as usize;
                    let sum = src[row0 + sx] as u32 + src[row1 + sx] as u32;
                    dst_slice[(dy * dst_w + bulk_dx_end) as usize] = (sum / 2) as u16;
                }
            }

            // Bottom edge row (odd height)
            if bulk_dy_end < dst_h {
                let sy = (bulk_dy_end * 2) as usize;
                let row0 = sy * src_w as usize;
                for dx in 0..bulk_dx_end {
                    let sx = (dx * 2) as usize;
                    let sum = src[row0 + sx] as u32 + src[row0 + sx + 1] as u32;
                    dst_slice[(bulk_dy_end * dst_w + dx) as usize] = (sum / 2) as u16;
                }
                // Bottom-right corner (odd width AND odd height): single pixel
                if bulk_dx_end < dst_w {
                    let sx = (bulk_dx_end * 2) as usize;
                    dst_slice[(bulk_dy_end * dst_w + bulk_dx_end) as usize] = src[row0 + sx];
                }
            }
        });

    LevelData {
        data,
        width: dst_w,
        height: dst_h,
        depth: src.depth,
        channels: src.channels,
        timepoints: src.timepoints,
    }
}

/// Downsample a level by 2x in Z only, averaging pairs of z-planes.
/// T, C, XY stay the same.
pub fn downsample_z_only(src: &LevelData) -> LevelData {
    let dst_d = src.depth.div_ceil(2);
    let plane_size = (src.width * src.height) as usize;
    let tc_count = (src.timepoints * src.channels) as usize;
    let dst_total = tc_count * dst_d as usize * plane_size;

    let mut data = vec![0u16; dst_total];

    // Parallel over (tc, dz) pairs
    let dst_planes: usize = tc_count * dst_d as usize;
    data.par_chunks_mut(plane_size)
        .enumerate()
        .for_each(|(idx, dst_slice)| {
            let tc = idx / dst_d as usize;
            let dz = idx % dst_d as usize;
            let sz0 = dz * 2;
            let sz1 = sz0 + 1;

            let tc_base = tc * src.depth as usize * plane_size;
            let src0 =
                &src.data[tc_base + sz0 * plane_size..tc_base + sz0 * plane_size + plane_size];

            if sz1 < src.depth as usize {
                let src1 =
                    &src.data[tc_base + sz1 * plane_size..tc_base + sz1 * plane_size + plane_size];
                for i in 0..plane_size {
                    dst_slice[i] = ((src0[i] as u32 + src1[i] as u32) / 2) as u16;
                }
            } else {
                // Odd depth: last plane is unpaired, copy as-is
                dst_slice.copy_from_slice(src0);
            }
        });

    let _ = dst_planes; // used implicitly above

    LevelData {
        data,
        width: src.width,
        height: src.height,
        depth: dst_d,
        channels: src.channels,
        timepoints: src.timepoints,
    }
}

/// Downsample a level by 2x in all three spatial axes (XYZ) using 2x2x2 box averaging.
pub fn downsample_xyz(src: &LevelData) -> LevelData {
    let dst_w = src.width.div_ceil(2);
    let dst_h = src.height.div_ceil(2);
    let dst_d = src.depth.div_ceil(2);
    let src_plane = (src.width * src.height) as usize;
    let dst_plane = (dst_w * dst_h) as usize;
    let tc_count = (src.timepoints * src.channels) as usize;

    let mut data = vec![0u16; tc_count * dst_d as usize * dst_plane];

    let bulk_dx_end = if src.width.is_multiple_of(2) {
        dst_w
    } else {
        dst_w - 1
    };
    let bulk_dy_end = if src.height.is_multiple_of(2) {
        dst_h
    } else {
        dst_h - 1
    };
    let src_w = src.width;

    // Parallel over (tc, dz) output planes
    data.par_chunks_mut(dst_plane)
        .enumerate()
        .for_each(|(idx, dst_slice)| {
            let tc = idx / dst_d as usize;
            let dz = idx % dst_d as usize;
            let sz0 = dz * 2;
            let sz1 = sz0 + 1;
            let has_z1 = sz1 < src.depth as usize;

            let tc_base = tc * src.depth as usize * src_plane;
            let plane0_off = tc_base + sz0 * src_plane;
            let plane0 = &src.data[plane0_off..plane0_off + src_plane];

            if has_z1 {
                let plane1_off = tc_base + sz1 * src_plane;
                let plane1 = &src.data[plane1_off..plane1_off + src_plane];

                // Bulk: 2x2x2 box average
                for dy in 0..bulk_dy_end {
                    let sy = (dy * 2) as usize;
                    let r0_0 = sy * src_w as usize;
                    let r1_0 = r0_0 + src_w as usize;

                    for dx in 0..bulk_dx_end {
                        let sx = (dx * 2) as usize;
                        let sum = plane0[r0_0 + sx] as u32
                            + plane0[r0_0 + sx + 1] as u32
                            + plane0[r1_0 + sx] as u32
                            + plane0[r1_0 + sx + 1] as u32
                            + plane1[r0_0 + sx] as u32
                            + plane1[r0_0 + sx + 1] as u32
                            + plane1[r1_0 + sx] as u32
                            + plane1[r1_0 + sx + 1] as u32;
                        dst_slice[(dy * dst_w + dx) as usize] = (sum / 8) as u16;
                    }
                    // Right edge (odd width): 1x2x2
                    if bulk_dx_end < dst_w {
                        let sx = (bulk_dx_end * 2) as usize;
                        let sum = plane0[r0_0 + sx] as u32
                            + plane0[r1_0 + sx] as u32
                            + plane1[r0_0 + sx] as u32
                            + plane1[r1_0 + sx] as u32;
                        dst_slice[(dy * dst_w + bulk_dx_end) as usize] = (sum / 4) as u16;
                    }
                }
                // Bottom edge (odd height)
                if bulk_dy_end < dst_h {
                    let sy = (bulk_dy_end * 2) as usize;
                    let r0_0 = sy * src_w as usize;
                    for dx in 0..bulk_dx_end {
                        let sx = (dx * 2) as usize;
                        let sum = plane0[r0_0 + sx] as u32
                            + plane0[r0_0 + sx + 1] as u32
                            + plane1[r0_0 + sx] as u32
                            + plane1[r0_0 + sx + 1] as u32;
                        dst_slice[(bulk_dy_end * dst_w + dx) as usize] = (sum / 4) as u16;
                    }
                    // Bottom-right corner (odd w AND odd h): 1x1x2
                    if bulk_dx_end < dst_w {
                        let sx = (bulk_dx_end * 2) as usize;
                        let sum = plane0[r0_0 + sx] as u32 + plane1[r0_0 + sx] as u32;
                        dst_slice[(bulk_dy_end * dst_w + bulk_dx_end) as usize] = (sum / 2) as u16;
                    }
                }
            } else {
                // Unpaired z-plane: fall back to 2x2 XY-only averaging
                for dy in 0..bulk_dy_end {
                    let sy = (dy * 2) as usize;
                    let r0 = sy * src_w as usize;
                    let r1 = r0 + src_w as usize;
                    for dx in 0..bulk_dx_end {
                        let sx = (dx * 2) as usize;
                        let sum = plane0[r0 + sx] as u32
                            + plane0[r0 + sx + 1] as u32
                            + plane0[r1 + sx] as u32
                            + plane0[r1 + sx + 1] as u32;
                        dst_slice[(dy * dst_w + dx) as usize] = (sum / 4) as u16;
                    }
                    if bulk_dx_end < dst_w {
                        let sx = (bulk_dx_end * 2) as usize;
                        let sum = plane0[r0 + sx] as u32 + plane0[r1 + sx] as u32;
                        dst_slice[(dy * dst_w + bulk_dx_end) as usize] = (sum / 2) as u16;
                    }
                }
                if bulk_dy_end < dst_h {
                    let sy = (bulk_dy_end * 2) as usize;
                    let r0 = sy * src_w as usize;
                    for dx in 0..bulk_dx_end {
                        let sx = (dx * 2) as usize;
                        let sum = plane0[r0 + sx] as u32 + plane0[r0 + sx + 1] as u32;
                        dst_slice[(bulk_dy_end * dst_w + dx) as usize] = (sum / 2) as u16;
                    }
                    if bulk_dx_end < dst_w {
                        let sx = (bulk_dx_end * 2) as usize;
                        dst_slice[(bulk_dy_end * dst_w + bulk_dx_end) as usize] = plane0[r0 + sx];
                    }
                }
            }
        });

    LevelData {
        data,
        width: dst_w,
        height: dst_h,
        depth: dst_d,
        channels: src.channels,
        timepoints: src.timepoints,
    }
}

/// Build a full image pyramid. Returns all levels starting from level 0 (full res).
/// Stops when both XY dimensions are <= min_size.
pub fn build_pyramid(
    data: Vec<u16>,
    width: u32,
    height: u32,
    depth: u32,
    channels: u32,
    timepoints: u32,
    min_size: u32,
) -> Vec<LevelData> {
    let mut levels = vec![LevelData {
        data,
        width,
        height,
        depth,
        channels,
        timepoints,
    }];

    loop {
        let prev = levels.last().unwrap();
        if prev.width <= min_size && prev.height <= min_size {
            break;
        }
        let next = downsample_xy(prev);
        levels.push(next);
    }

    levels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsample_2x2_to_1x1() {
        let src = LevelData {
            data: vec![10, 20, 30, 40],
            width: 2,
            height: 2,
            depth: 1,
            channels: 1,
            timepoints: 1,
        };
        let dst = downsample_xy(&src);
        assert_eq!(dst.width, 1);
        assert_eq!(dst.height, 1);
        assert_eq!(dst.data, vec![25]); // (10+20+30+40)/4
    }

    #[test]
    fn downsample_odd_dimensions() {
        // 3x3 → 2x2
        let src = LevelData {
            data: vec![1, 2, 3, 4, 5, 6, 7, 8, 9],
            width: 3,
            height: 3,
            depth: 1,
            channels: 1,
            timepoints: 1,
        };
        let dst = downsample_xy(&src);
        assert_eq!(dst.width, 2);
        assert_eq!(dst.height, 2);
        assert_eq!(dst.data[0], 3); // (1+2+4+5)/4
        assert_eq!(dst.data[1], 4); // (3+6)/2
        assert_eq!(dst.data[2], 7); // (7+8)/2
        assert_eq!(dst.data[3], 9); // (9)/1
    }

    #[test]
    fn downsample_preserves_depth() {
        let src = LevelData {
            data: vec![10, 20, 30, 40, 50, 60, 70, 80],
            width: 2,
            height: 2,
            depth: 2,
            channels: 1,
            timepoints: 1,
        };
        let dst = downsample_xy(&src);
        assert_eq!(dst.depth, 2);
        assert_eq!(dst.width, 1);
        assert_eq!(dst.height, 1);
        assert_eq!(dst.data[0], 25); // z=0: (10+20+30+40)/4
        assert_eq!(dst.data[1], 65); // z=1: (50+60+70+80)/4
    }

    #[test]
    fn downsample_preserves_channels_and_timepoints() {
        // T=1, C=2, Z=1, 2x2 each
        let src = LevelData {
            data: vec![10, 20, 30, 40, 100, 200, 300, 400],
            width: 2,
            height: 2,
            depth: 1,
            channels: 2,
            timepoints: 1,
        };
        let dst = downsample_xy(&src);
        assert_eq!(dst.channels, 2);
        assert_eq!(dst.timepoints, 1);
        assert_eq!(dst.data[0], 25); // channel 0
        assert_eq!(dst.data[1], 250); // channel 1
    }

    #[test]
    fn build_pyramid_stops_at_min_size() {
        let data = vec![0u16; 512 * 512];
        let levels = build_pyramid(data, 512, 512, 1, 1, 1, 256);
        assert_eq!(levels.len(), 2);
        assert_eq!(levels[0].width, 512);
        assert_eq!(levels[1].width, 256);
    }

    // --- downsample_z_only tests ---

    #[test]
    fn downsample_z_even_depth() {
        // 2x2, depth=2 → depth=1, averaging z-planes
        let src = LevelData {
            data: vec![10, 20, 30, 40, 50, 60, 70, 80],
            width: 2,
            height: 2,
            depth: 2,
            channels: 1,
            timepoints: 1,
        };
        let dst = downsample_z_only(&src);
        assert_eq!(dst.depth, 1);
        assert_eq!(dst.width, 2);
        assert_eq!(dst.height, 2);
        assert_eq!(dst.data, vec![30, 40, 50, 60]); // (10+50)/2, (20+60)/2, ...
    }

    #[test]
    fn downsample_z_odd_depth() {
        // depth=3 → depth=2: first pair averaged, last plane copied
        let src = LevelData {
            data: vec![
                10, 20, // z=0
                30, 40, // z=1
                50, 60, // z=2
            ],
            width: 2,
            height: 1,
            depth: 3,
            channels: 1,
            timepoints: 1,
        };
        let dst = downsample_z_only(&src);
        assert_eq!(dst.depth, 2);
        assert_eq!(dst.data[0], 20); // (10+30)/2
        assert_eq!(dst.data[1], 30); // (20+40)/2
        assert_eq!(dst.data[2], 50); // unpaired, copy
        assert_eq!(dst.data[3], 60);
    }

    #[test]
    fn downsample_z_preserves_tc() {
        // T=1, C=2, Z=2, 1x1 each
        let src = LevelData {
            data: vec![10, 20, 100, 200],
            width: 1,
            height: 1,
            depth: 2,
            channels: 2,
            timepoints: 1,
        };
        let dst = downsample_z_only(&src);
        assert_eq!(dst.depth, 1);
        assert_eq!(dst.channels, 2);
        assert_eq!(dst.data[0], 15); // c0: (10+20)/2
        assert_eq!(dst.data[1], 150); // c1: (100+200)/2
    }

    // --- downsample_xyz tests ---

    #[test]
    fn downsample_xyz_2x2x2() {
        // 2x2x2 → 1x1x1: 8-voxel box average
        let src = LevelData {
            data: vec![10, 20, 30, 40, 50, 60, 70, 80],
            width: 2,
            height: 2,
            depth: 2,
            channels: 1,
            timepoints: 1,
        };
        let dst = downsample_xyz(&src);
        assert_eq!(dst.width, 1);
        assert_eq!(dst.height, 1);
        assert_eq!(dst.depth, 1);
        assert_eq!(dst.data, vec![45]); // (10+20+30+40+50+60+70+80)/8
    }

    #[test]
    fn downsample_xyz_odd_z() {
        // 2x2x3 → 1x1x2: first pair uses 2x2x2, last plane uses 2x2 XY-only
        let src = LevelData {
            data: vec![
                10, 20, 30, 40, // z=0 (2x2)
                50, 60, 70, 80, // z=1 (2x2)
                90, 100, 110, 120, // z=2 (2x2)
            ],
            width: 2,
            height: 2,
            depth: 3,
            channels: 1,
            timepoints: 1,
        };
        let dst = downsample_xyz(&src);
        assert_eq!(dst.depth, 2);
        assert_eq!(dst.width, 1);
        assert_eq!(dst.height, 1);
        // dz=0: avg of z=0 and z=1 → (10+20+30+40+50+60+70+80)/8 = 45
        assert_eq!(dst.data[0], 45);
        // dz=1: z=2 only (unpaired) → (90+100+110+120)/4 = 105
        assert_eq!(dst.data[1], 105);
    }

    #[test]
    fn downsample_xyz_preserves_tc() {
        // T=1, C=2, Z=2, 2x2
        let src = LevelData {
            data: vec![
                // C=0: z=0, z=1
                10, 20, 30, 40, 50, 60, 70, 80, // C=1: z=0, z=1
                100, 200, 300, 400, 500, 600, 700, 800,
            ],
            width: 2,
            height: 2,
            depth: 2,
            channels: 2,
            timepoints: 1,
        };
        let dst = downsample_xyz(&src);
        assert_eq!(dst.channels, 2);
        assert_eq!(dst.depth, 1);
        assert_eq!(dst.data[0], 45); // c0
        assert_eq!(dst.data[1], 450); // c1
    }

    // --- downsample dispatcher test ---

    #[test]
    fn downsample_dispatcher() {
        let src = LevelData {
            data: vec![10, 20, 30, 40, 50, 60, 70, 80],
            width: 2,
            height: 2,
            depth: 2,
            channels: 1,
            timepoints: 1,
        };
        let xy = downsample(&src, true, false);
        assert_eq!(xy.depth, 2); // Z unchanged
        assert_eq!(xy.width, 1);

        let z = downsample(&src, false, true);
        assert_eq!(z.depth, 1); // Z halved
        assert_eq!(z.width, 2); // XY unchanged

        let xyz = downsample(&src, true, true);
        assert_eq!(xyz.depth, 1);
        assert_eq!(xyz.width, 1);
    }
}
