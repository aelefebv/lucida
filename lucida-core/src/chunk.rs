use std::ops::Range;

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

/// Compute which chunk grid cells intersect the camera's visible region and z range.
///
/// `chunk_size` is [x, y, z] in pixels per chunk at level 0.
/// `z_range` is the visible z slab in full-resolution voxel coordinates.
pub fn visible_chunks(
    camera: &Camera,
    chunk_size: &[u32; 3],
    level: u32,
    z_range: &Range<u32>,
    t: u32,
    c: u32,
) -> Vec<ChunkCoord> {
    let [min_x, min_y, max_x, max_y] = camera.world_bounds();
    let scale = (1u32 << level) as f64;

    let chunk_world_x = chunk_size[0] as f64 * scale;
    let chunk_world_y = chunk_size[1] as f64 * scale;
    let chunk_world_z = chunk_size[2] as f64 * scale;

    let col_start = (min_x / chunk_world_x).floor().max(0.0) as u32;
    let col_end = (max_x / chunk_world_x).ceil().max(0.0) as u32;
    let row_start = (min_y / chunk_world_y).floor().max(0.0) as u32;
    let row_end = (max_y / chunk_world_y).ceil().max(0.0) as u32;

    let z_start = (z_range.start as f64 / chunk_world_z).floor() as u32;
    let z_end = (z_range.end as f64 / chunk_world_z).ceil().max(0.0) as u32;

    let mut chunks = Vec::new();
    for z in z_start..z_end {
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
        // Negative coords clamp to 0, so x: 0..1, y: 0..1, z: single chunk.
        let chunks = visible_chunks(&cam, &[256, 256, 64], 0, &(0..1), 0, 0);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].x, 0);
        assert_eq!(chunks[0].y, 0);
        assert_eq!(chunks[0].z, 0);
    }

    #[test]
    fn panning_reveals_more_chunks() {
        let mut cam = Camera::new([512, 512]);
        cam.center = [512.0, 512.0];
        let chunks = visible_chunks(&cam, &[256, 256, 64], 0, &(0..1), 0, 0);
        // Visible world: 256..768 in x and y.
        // x chunks: 1..3, y chunks: 1..3 → 4 chunks, 1 z chunk.
        assert_eq!(chunks.len(), 4);
    }

    #[test]
    fn z_slab_spans_multiple_chunks() {
        let cam = Camera::new([512, 512]);
        // z_range 0..128 with chunk_size_z=64 → z chunks 0 and 1.
        let chunks = visible_chunks(&cam, &[256, 256, 64], 0, &(0..128), 0, 0);
        // 1 x chunk * 1 y chunk * 2 z chunks = 2
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].z, 0);
        assert_eq!(chunks[1].z, 1);
    }

    #[test]
    fn single_z_slice_maps_to_correct_chunk() {
        let cam = Camera::new([512, 512]);
        // z=100 with chunk_size_z=64 → chunk z=1 (100/64 = 1.56, floor=1)
        let chunks = visible_chunks(&cam, &[256, 256, 64], 0, &(100..101), 0, 0);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].z, 1);
    }
}
