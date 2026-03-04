use crate::camera::Camera;

/// A chunk coordinate in the multiscale grid.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ChunkCoord {
    pub level: u32,
    pub x: u32,
    pub y: u32,
    pub z: u32,
    pub t: u32,
    pub c: u32,
}

/// The result of chunk planning: what to fetch now and what to prefetch.
#[derive(Debug, Clone)]
pub struct ChunkRequestPlan {
    pub needed: Vec<ChunkCoord>,
    pub prefetch: Vec<ChunkCoord>,
}

/// Pick the best multiscale level for a given zoom.
///
/// `num_levels` is the total number of resolution levels (level 0 = full res).
/// Returns the level index where one chunk pixel ≈ one screen pixel.
pub fn select_level(zoom: f64, num_levels: u32) -> u32 {
    if num_levels == 0 {
        return 0;
    }
    // Each level halves the resolution, so level L has scale 1/2^L.
    // We want the coarsest level where the data resolution still exceeds screen resolution.
    let level = (-zoom.log2()).floor().max(0.0) as u32;
    level.min(num_levels - 1)
}

/// Compute which chunk grid cells intersect the camera's visible region.
pub fn visible_chunks(
    camera: &Camera,
    chunk_size: u32,
    level: u32,
    z: u32,
    t: u32,
    c: u32,
) -> Vec<ChunkCoord> {
    let [min_x, min_y, max_x, max_y] = camera.world_bounds();
    let scale = (1u32 << level) as f64;
    let chunk_world = chunk_size as f64 * scale;

    let col_start = (min_x / chunk_world).floor().max(0.0) as u32;
    let col_end = (max_x / chunk_world).ceil().max(0.0) as u32;
    let row_start = (min_y / chunk_world).floor().max(0.0) as u32;
    let row_end = (max_y / chunk_world).ceil().max(0.0) as u32;

    let mut chunks = Vec::new();
    for row in row_start..row_end {
        for col in col_start..col_end {
            chunks.push(ChunkCoord {
                level,
                x: col,
                y: row,
                z,
                t,
                c,
            });
        }
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_0_at_full_zoom() {
        assert_eq!(select_level(1.0, 5), 0);
    }

    #[test]
    fn zoomed_out_selects_coarser_level() {
        assert_eq!(select_level(0.25, 5), 2);
    }

    #[test]
    fn never_exceeds_max_level() {
        assert_eq!(select_level(0.001, 3), 2);
    }

    #[test]
    fn zoomed_in_past_native_stays_at_level_0() {
        assert_eq!(select_level(4.0, 5), 0);
    }

    #[test]
    fn visible_chunks_at_origin() {
        let cam = Camera::new([512, 512]);
        // Camera centered at origin, zoom 1, viewport 512x512.
        // With chunk_size=256, level=0, visible world is -256..256 in each axis.
        // That's chunks (0,0) through ... but negative coords clamp to 0.
        // x: floor(-256/256)=clamped to 0 .. ceil(256/256)=1
        // y: same
        let chunks = visible_chunks(&cam, 256, 0, 0, 0, 0);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].x, 0);
        assert_eq!(chunks[0].y, 0);
    }

    #[test]
    fn panning_reveals_more_chunks() {
        let mut cam = Camera::new([512, 512]);
        cam.center = [512.0, 512.0];
        let chunks = visible_chunks(&cam, 256, 0, 0, 0, 0);
        // Visible world: 256..768 in x, 256..768 in y.
        // x chunks: floor(256/256)=1 .. ceil(768/256)=3 → cols 1,2
        // y chunks: same → rows 1,2
        assert_eq!(chunks.len(), 4);
    }
}
