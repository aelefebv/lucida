/// A single resolution level of the image pyramid.
///
/// Data is stored in TCZYX order (T outermost, X innermost).
pub struct Level {
    pub data: Vec<u16>,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub channels: u32,
    pub timepoints: u32,
}

/// Downsample a level by 2x in XY using box averaging. T, C, Z stay the same.
pub fn downsample_xy(src: &Level) -> Level {
    let dst_w = (src.width + 1) / 2;
    let dst_h = (src.height + 1) / 2;
    let src_plane = (src.width * src.height) as usize;
    let dst_plane = (dst_w * dst_h) as usize;
    let num_planes = (src.timepoints * src.channels * src.depth) as usize;

    let mut data = vec![0u16; num_planes * dst_plane];

    for p in 0..num_planes {
        let src_off = p * src_plane;
        let dst_off = p * dst_plane;

        for dy in 0..dst_h {
            for dx in 0..dst_w {
                let sx = dx * 2;
                let sy = dy * 2;

                let mut sum = 0u32;
                let mut count = 0u32;
                for ky in 0..2 {
                    for kx in 0..2 {
                        let x = sx + kx;
                        let y = sy + ky;
                        if x < src.width && y < src.height {
                            sum += src.data[src_off + (y * src.width + x) as usize] as u32;
                            count += 1;
                        }
                    }
                }

                data[dst_off + (dy * dst_w + dx) as usize] = (sum / count) as u16;
            }
        }
    }

    Level {
        data,
        width: dst_w,
        height: dst_h,
        depth: src.depth,
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
) -> Vec<Level> {
    let mut levels = vec![Level {
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
        let src = Level {
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
        let src = Level {
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
        let src = Level {
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
        let src = Level {
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
        assert_eq!(dst.data[0], 25);  // channel 0
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
}
