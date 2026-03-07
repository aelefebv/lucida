use serde::Serialize;

use crate::camera::VisibleRegion;

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

impl Serialize for ChunkCoord {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("ChunkCoord", 7)?;
        s.serialize_field("level", &self.level)?;
        s.serialize_field("x", &self.x)?;
        s.serialize_field("y", &self.y)?;
        s.serialize_field("z", &self.z)?;
        s.serialize_field("t", &self.t)?;
        s.serialize_field("c", &self.c)?;
        s.serialize_field("key", &self.key())?;
        s.end()
    }
}

impl ChunkCoord {
    pub fn key(&self) -> String {
        format!(
            "{}/{}/{}/{}/{}/{}",
            self.level, self.t, self.c, self.z, self.y, self.x
        )
    }
}

pub fn chunk_key(level: u32, t: u32, c: u32, z: u32, y: u32, x: u32) -> String {
    format!("{level}/{t}/{c}/{z}/{y}/{x}")
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
/// `level_chunk_size` is [x, y, z] chunk size at the target level.
/// `level_shape` is the data shape [x, y, z] at the target level.
/// `full_shape` is the level-0 data shape [x, y, z] (for coord mapping to world space).
pub fn visible_chunks(
    region: &VisibleRegion,
    level_chunk_size: &[u32; 3],
    level: u32,
    t: u32,
    c: u32,
    level_shape: &[u32; 3],
    full_shape: &[u32; 3],
) -> Vec<ChunkCoord> {
    let [min_x, min_y, max_x, max_y] = region.xy_bounds;

    // Per-axis scale: how many full-res voxels map to one level voxel
    let scale_x = full_shape[0] as f64 / level_shape[0] as f64;
    let scale_y = full_shape[1] as f64 / level_shape[1] as f64;
    let scale_z = full_shape[2] as f64 / level_shape[2] as f64;

    let chunk_world_x = level_chunk_size[0] as f64 * scale_x;
    let chunk_world_y = level_chunk_size[1] as f64 * scale_y;
    let chunk_world_z = level_chunk_size[2] as f64 * scale_z;

    // Max chunk index (exclusive) at this level — derived from actual level shape
    let max_col = (level_shape[0] as f64 / level_chunk_size[0] as f64).ceil() as u32;
    let max_row = (level_shape[1] as f64 / level_chunk_size[1] as f64).ceil() as u32;
    let max_z = (level_shape[2] as f64 / level_chunk_size[2] as f64).ceil() as u32;

    let col_start = (min_x / chunk_world_x).floor().max(0.0) as u32;
    let col_end = ((max_x / chunk_world_x).ceil().max(0.0) as u32).min(max_col);
    let row_start = (min_y / chunk_world_y).floor().max(0.0) as u32;
    let row_end = ((max_y / chunk_world_y).ceil().max(0.0) as u32).min(max_row);

    let z_start = (region.z_range.start as f64 / chunk_world_z).floor() as u32;
    let z_end = ((region.z_range.end as f64 / chunk_world_z).ceil().max(0.0) as u32).min(max_z);

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

    // Sort center-out so the viewport center loads first.
    // Use camera-derived sort center if available, otherwise fall back to grid midpoint.
    let (center_col, center_row, center_z) = match region.sort_center {
        Some([cx, cy, cz]) => (cx / chunk_world_x, cy / chunk_world_y, cz / chunk_world_z),
        None => (
            (col_start + col_end) as f64 / 2.0,
            (row_start + row_end) as f64 / 2.0,
            (z_start + z_end) as f64 / 2.0,
        ),
    };
    chunks.sort_by(|a, b| {
        let da = (a.x as f64 + 0.5 - center_col).powi(2)
            + (a.y as f64 + 0.5 - center_row).powi(2)
            + (a.z as f64 + 0.5 - center_z).powi(2);
        let db = (b.x as f64 + 0.5 - center_col).powi(2)
            + (b.y as f64 + 0.5 - center_row).powi(2)
            + (b.z as f64 + 0.5 - center_z).powi(2);
        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
    });

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
        let shape = [4096, 4096, 256];
        let chunks = visible_chunks(&region, &[256, 256, 64], 0, 0, 0, &shape, &shape);
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
        let shape = [4096, 4096, 256];
        let chunks = visible_chunks(&region, &[256, 256, 64], 0, 0, 0, &shape, &shape);
        assert_eq!(chunks.len(), 4);
    }

    #[test]
    fn z_slab_spans_multiple_chunks() {
        let cam = Camera::new_2d([512, 512]);
        let region = cam.visible_region(&(0..128), None, None);
        let shape = [4096, 4096, 256];
        let chunks = visible_chunks(&region, &[256, 256, 64], 0, 0, 0, &shape, &shape);
        assert_eq!(chunks.len(), 2);
        let mut zs: Vec<u32> = chunks.iter().map(|c| c.z).collect();
        zs.sort();
        assert_eq!(zs, vec![0, 1]);
    }

    #[test]
    fn chunk_key_format() {
        let coord = ChunkCoord {
            level: 2,
            x: 3,
            y: 1,
            z: 0,
            t: 0,
            c: 0,
        };
        assert_eq!(coord.key(), "2/0/0/0/1/3");
        assert_eq!(chunk_key(2, 0, 0, 0, 1, 3), "2/0/0/0/1/3");
    }

    #[test]
    fn single_z_slice_maps_to_correct_chunk() {
        let cam = Camera::new_2d([512, 512]);
        let region = cam.visible_region(&(100..101), None, None);
        let shape = [4096, 4096, 256];
        let chunks = visible_chunks(&region, &[256, 256, 64], 0, 0, 0, &shape, &shape);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].z, 1);
    }

    #[test]
    fn anisotropic_level1_preserves_z_chunks() {
        // Simulates a dataset with shape 1024×1024×100, voxel spacing [1,1,10].
        // At level 1, the pyramid generator only downsamples X/Y (not Z),
        // so level_shape = [512, 512, 100], full_shape = [1024, 1024, 100].
        let cam = Camera::new_2d([512, 512]);
        // View full Z range
        let region = cam.visible_region(&(0..100), None, None);
        let full_shape = [1024, 1024, 100];
        let level_shape = [512, 512, 100]; // Z unchanged at level 1
        let level_chunk_size = [32, 32, 32];
        let chunks = visible_chunks(
            &region,
            &level_chunk_size,
            1,
            0,
            0,
            &level_shape,
            &full_shape,
        );
        // Z chunks at level 1: ceil(100/32) = 4
        let max_z_chunk = chunks.iter().map(|c| c.z).max().unwrap();
        assert_eq!(max_z_chunk, 3); // 0,1,2,3 = 4 chunks
        let z_set: std::collections::HashSet<u32> = chunks.iter().map(|c| c.z).collect();
        assert_eq!(z_set.len(), 4);
    }
}
