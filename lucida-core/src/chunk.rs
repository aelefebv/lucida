use serde::Serialize;

use crate::camera::VisibleRegion;

/// A chunk coordinate in the multiscale grid.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct ChunkCoord {
    pub level: u32,
    pub x: u32,
    pub y: u32,
    pub z: u32,
    pub t: u32,
    pub c: u32,
}

/// The result of chunk planning: what to fetch now and what to prefetch.
#[derive(Debug, Clone, Serialize)]
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

/// Compute which chunk grid cells intersect the visible region's bounds and z range.
///
/// `chunk_size` is [x, y, z] in pixels per chunk at level 0.
pub fn visible_chunks(
    region: &VisibleRegion,
    chunk_size: &[u32; 3],
    level: u32,
    t: u32,
    c: u32,
) -> Vec<ChunkCoord> {
    let [min_x, min_y, max_x, max_y] = region.xy_bounds;
    let scale = (1u32 << level) as f64;

    let chunk_world_x = chunk_size[0] as f64 * scale;
    let chunk_world_y = chunk_size[1] as f64 * scale;
    let chunk_world_z = chunk_size[2] as f64 * scale;

    let col_start = (min_x / chunk_world_x).floor().max(0.0) as u32;
    let col_end = (max_x / chunk_world_x).ceil().max(0.0) as u32;
    let row_start = (min_y / chunk_world_y).floor().max(0.0) as u32;
    let row_end = (max_y / chunk_world_y).ceil().max(0.0) as u32;

    let z_start = (region.z_range.start as f64 / chunk_world_z).floor() as u32;
    let z_end = (region.z_range.end as f64 / chunk_world_z).ceil().max(0.0) as u32;

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
    use crate::camera::Camera;

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
        let cam = Camera::new_2d([512, 512]);
        let region = cam.visible_region(&(0..1), None, None);
        let chunks = visible_chunks(&region, &[256, 256, 64], 0, 0, 0);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].x, 0);
        assert_eq!(chunks[0].y, 0);
        assert_eq!(chunks[0].z, 0);
    }

    #[test]
    fn panning_reveals_more_chunks() {
        let mut cam = Camera::new_2d([512, 512]);
        if let Camera::View2D(ref mut v) = cam {
            v.center = [512.0, 512.0];
        }
        let region = cam.visible_region(&(0..1), None, None);
        let chunks = visible_chunks(&region, &[256, 256, 64], 0, 0, 0);
        assert_eq!(chunks.len(), 4);
    }

    #[test]
    fn z_slab_spans_multiple_chunks() {
        let cam = Camera::new_2d([512, 512]);
        let region = cam.visible_region(&(0..128), None, None);
        let chunks = visible_chunks(&region, &[256, 256, 64], 0, 0, 0);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].z, 0);
        assert_eq!(chunks[1].z, 1);
    }

    #[test]
    fn single_z_slice_maps_to_correct_chunk() {
        let cam = Camera::new_2d([512, 512]);
        let region = cam.visible_region(&(100..101), None, None);
        let chunks = visible_chunks(&region, &[256, 256, 64], 0, 0, 0);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].z, 1);
    }
}
