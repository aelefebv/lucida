use serde::{Deserialize, Serialize};

use lucida_content::LevelGeometry;

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

/// The plane at a level `level_depth` planes deep that holds the center of the
/// full-resolution plane `full_res_z`, the plane nearest-sample filtering
/// reads. The render worker maps a plane with the same arithmetic
/// (`lucida-web/src/renderer/slicePlane.ts`): a slice delivery lands only in
/// the chunk the worker maps its plane to.
pub fn slice_level_z(full_res_z: u64, full_res_depth: u64, level_depth: u64) -> u64 {
    let last = level_depth.saturating_sub(1);
    if level_depth == full_res_depth || full_res_depth == 0 {
        return full_res_z.min(last);
    }
    ((2 * full_res_z + 1) * level_depth / (2 * full_res_depth)).min(last)
}

/// A render radius at or past this keeps every chunk: the planner's radius
/// knobs switch the filter off at their top.
pub const RENDER_RADIUS_DISABLED: f64 = 2.0;

/// The view as chunk enumeration reads it, in layout coordinates: level-0
/// samples, with each entity offset by its place in the layout.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkView {
    xy_bounds: [f64; 4],
    z_range: [f64; 2],
    /// A 3-D view culls chunks against its frustum. A 2-D view has none, and
    /// samples the one chunk along Z that holds each of its planes.
    frustum_planes: Option<Vec<[f64; 4]>>,
    /// The region's sort center, else its middle: where the render radius is
    /// measured from.
    center: [f64; 3],
    /// What a render radius of 1 spans, in samples.
    radius_basis: f64,
    /// Where chunks are scored from: `center`, moved along Z by the depth bias.
    focus: [f64; 3],
}

/// A visible region as a client holds it. Z may be fractional, and a region
/// without a radius basis measures the render radius by its half-diagonal.
#[derive(Debug, Clone, Deserialize)]
struct RegionInput {
    xy_bounds: [f64; 4],
    z_range: [f64; 2],
    #[serde(default)]
    radius_basis_vox: Option<f64>,
    #[serde(default)]
    sort_center: Option<[f64; 3]>,
    #[serde(default)]
    frustum_planes: Option<Vec<[f64; 4]>>,
}

impl ChunkView {
    /// `depth_bias` moves the focus along Z by a share of the region's
    /// half-depth: `-1` is the near end of the Z range, `1` the far end.
    pub fn new(region: &VisibleRegion, depth_bias: f64) -> Self {
        Self::from_input(
            RegionInput {
                xy_bounds: region.xy_bounds,
                z_range: [region.z_range.start as f64, region.z_range.end as f64],
                radius_basis_vox: Some(region.radius_basis_vox),
                sort_center: region.sort_center,
                frustum_planes: region.frustum_planes.map(Vec::from),
            },
            depth_bias,
        )
    }

    /// A view from a region serialized as [`VisibleRegion`] is.
    pub fn from_json(json: &str, depth_bias: f64) -> Result<Self, serde_json::Error> {
        Ok(Self::from_input(serde_json::from_str(json)?, depth_bias))
    }

    fn from_input(region: RegionInput, depth_bias: f64) -> Self {
        let [min_x, min_y, max_x, max_y] = region.xy_bounds;
        let [z_min, z_max] = region.z_range;
        let center = region.sort_center.unwrap_or([
            (min_x + max_x) / 2.0,
            (min_y + max_y) / 2.0,
            (z_min + z_max) / 2.0,
        ]);
        let radius_basis = match region.radius_basis_vox {
            Some(basis) if basis.is_finite() && basis > 0.0 => basis,
            _ => {
                let half = |lo: f64, hi: f64| ((hi - lo) / 2.0).max(0.0);
                let (hx, hy, hz) = (half(min_x, max_x), half(min_y, max_y), half(z_min, z_max));
                (hx * hx + hy * hy + hz * hz).sqrt()
            }
        }
        .max(1.0);
        // An unbiased focus is the center exactly, unclamped, so the default
        // scores chunks around the sort center the camera reports.
        let focus_z = if depth_bias == 0.0 {
            center[2]
        } else {
            let shifted = center[2] + depth_bias.clamp(-1.0, 1.0) * (z_max - z_min) / 2.0;
            shifted.max(z_min).min(z_max)
        };
        Self {
            xy_bounds: region.xy_bounds,
            z_range: region.z_range,
            frustum_planes: region.frustum_planes,
            center,
            radius_basis,
            focus: [center[0], center[1], focus_z],
        }
    }
}

/// One level of one entity, placed in the layout, to enumerate.
#[derive(Debug, Clone, Copy)]
pub struct ChunkQuery {
    /// The entity's place in the layout, in level-0 samples.
    position: [f64; 2],
    /// Level-0 shape, X, Y, Z.
    full: [f64; 3],
    /// The level's shape, chunk shape and chunk grid, X, Y, Z.
    shape: [f64; 3],
    chunk: [f64; 3],
    grid: [u32; 3],
    /// The render radius, as a multiple of the view's radius basis.
    radius_view: f64,
}

impl ChunkQuery {
    pub fn new(
        level: &LevelGeometry,
        full_res: &LevelGeometry,
        position: [f64; 2],
        radius_view: f64,
    ) -> Self {
        let xyz = |dims: &[u64; 5]| [dims[4] as f64, dims[3] as f64, dims[2] as f64];
        let grid = |axis: usize| u32::try_from(level.grid_shape[axis]).unwrap_or(u32::MAX);
        Self {
            position,
            full: xyz(&full_res.shape),
            shape: xyz(&level.shape),
            chunk: xyz(&level.chunk_shape),
            grid: [grid(4), grid(3), grid(2)],
            radius_view,
        }
    }

    /// A chunk's extent in level-0 samples along each axis.
    fn chunk_world(&self) -> [f64; 3] {
        std::array::from_fn(|a| self.chunk[a] * (self.full[a] / self.shape[a].max(1.0)))
    }
}

/// A chunk the view samples, by grid cell, and how far its center lies from
/// the view's focus, in level-0 samples. Planning orders by the distance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoredChunk {
    pub x: u32,
    pub y: u32,
    pub z: u32,
    pub distance: f64,
}

/// How many grid cells each culling stage kept, for the planner's counters.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CullCounts {
    /// Every cell of the level.
    pub considered: u64,
    /// The cells inside the region's XY bounds, at every Z.
    pub after_xy_bounds: u64,
    /// Those inside its Z range too.
    pub after_z_range: u64,
    /// Those not wholly outside the frustum. The render radius drops chunks
    /// after this count.
    pub after_frustum: u64,
}

/// Append the chunks of `query` that `view` samples to `out`, in grid order,
/// and add what each culling stage kept to `counts`.
///
/// A chunk is kept when its cell overlaps the region's XY bounds and Z
/// range, is not wholly outside a 3-D view's frustum, and lies within the
/// query's render radius of the view's center. A 2-D view keeps, along Z,
/// only the chunk each of its planes maps to at this level.
pub fn enumerate_chunks(
    view: &ChunkView,
    query: &ChunkQuery,
    counts: &mut CullCounts,
    out: &mut Vec<ScoredChunk>,
) {
    let [grid_x, grid_y, grid_z] = query.grid;
    counts.considered += grid_x as u64 * grid_y as u64 * grid_z as u64;

    let [px, py] = query.position;
    let [min_x, min_y, max_x, max_y] = view.xy_bounds;
    let (min_x, min_y, max_x, max_y) = (min_x - px, min_y - py, max_x - px, max_y - py);
    if max_x <= 0.0 || max_y <= 0.0 || min_x >= query.full[0] || min_y >= query.full[1] {
        return;
    }

    let world = query.chunk_world();
    let (col_start, col_end) = cell_range(min_x, max_x, world[0], grid_x);
    let (row_start, row_end) = cell_range(min_y, max_y, world[1], grid_y);
    let (z_start, z_end) = if view.frustum_planes.is_some() {
        cell_range(view.z_range[0], view.z_range[1], world[2], grid_z)
    } else {
        slice_cell_range(view.z_range, query, grid_z)
    };
    let cols = col_end.saturating_sub(col_start) as u64;
    let rows = row_end.saturating_sub(row_start) as u64;
    counts.after_xy_bounds += cols * rows * grid_z as u64;
    counts.after_z_range += cols * rows * z_end.saturating_sub(z_start) as u64;

    let radius = (query.radius_view.is_finite()
        && query.radius_view >= 0.0
        && query.radius_view < RENDER_RADIUS_DISABLED)
        .then_some(view.radius_basis * query.radius_view);
    let local = |p: [f64; 3]| [p[0] - px, p[1] - py, p[2]];
    let (center, focus) = (local(view.center), local(view.focus));

    for z in z_start..z_end {
        for row in row_start..row_end {
            for col in col_start..col_end {
                let cell = [col as f64, row as f64, z as f64];
                let lo: [f64; 3] = std::array::from_fn(|a| cell[a] * world[a]);
                let hi: [f64; 3] = std::array::from_fn(|a| (cell[a] + 1.0) * world[a]);
                if let Some(planes) = &view.frustum_planes {
                    let placed = |p: [f64; 3]| [p[0] + px, p[1] + py, p[2]];
                    if chunk_outside_frustum(&placed(lo), &placed(hi), planes) {
                        continue;
                    }
                }
                counts.after_frustum += 1;
                if let Some(radius) = radius {
                    // An edge chunk's samples stop at the image's edge.
                    let gap: [f64; 3] = std::array::from_fn(|a| {
                        outside(center[a], lo[a], hi[a].min(query.full[a]))
                    });
                    if norm(gap) > radius {
                        continue;
                    }
                }
                let offset: [f64; 3] =
                    std::array::from_fn(|a| (cell[a] + 0.5) * world[a] - focus[a]);
                out.push(ScoredChunk {
                    x: col,
                    y: row,
                    z,
                    distance: norm(offset),
                });
            }
        }
    }
}

/// The half-open run of cells, `size` samples each, that `[min, max)` overlaps.
fn cell_range(min: f64, max: f64, size: f64, count: u32) -> (u32, u32) {
    let clamp = |cell: f64| cell.max(0.0).min(count as f64) as u32;
    (clamp((min / size).floor()), clamp((max / size).ceil()))
}

/// The half-open run of chunks along Z that a 2-D view of the planes
/// `[start, end)` samples: from the chunk holding the first plane's mapped
/// level plane to the one holding the last's.
fn slice_cell_range(z_range: [f64; 2], query: &ChunkQuery, grid_z: u32) -> (u32, u32) {
    let first = z_range[0].floor();
    let last = z_range[1].ceil() - 1.0;
    if last < first {
        return (0, 0);
    }
    let chunk_of = |plane: f64| {
        let level_plane = slice_level_z(
            plane.max(0.0) as u64,
            query.full[2] as u64,
            query.shape[2] as u64,
        );
        level_plane / (query.chunk[2] as u64).max(1)
    };
    let end = u32::try_from(chunk_of(last) + 1)
        .unwrap_or(u32::MAX)
        .min(grid_z);
    (
        u32::try_from(chunk_of(first)).unwrap_or(u32::MAX).min(end),
        end,
    )
}

/// How far `value` lies outside `[min, max]`.
fn outside(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min - value
    } else if value > max {
        value - max
    } else {
        0.0
    }
}

fn norm(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

/// Test whether a chunk AABB is fully outside any frustum plane.
/// Uses the p-vertex method: for each plane, test the corner most in the direction
/// of the plane normal. If that corner is outside, the entire chunk is outside.
fn chunk_outside_frustum(min: &[f64; 3], max: &[f64; 3], planes: &[[f64; 4]]) -> bool {
    for plane in planes {
        // p-vertex: the corner most in the direction of the plane normal
        let px = if plane[0] >= 0.0 { max[0] } else { min[0] };
        let py = if plane[1] >= 0.0 { max[1] } else { min[1] };
        let pz = if plane[2] >= 0.0 { max[2] } else { min[2] };
        if plane[0] * px + plane[1] * py + plane[2] * pz + plane[3] < 0.0 {
            return true; // fully outside this plane
        }
    }
    false
}

/// Numbers per query in [`enumerate_batch`]'s input: the layout position X,
/// Y; then X, Y, Z of the level-0 shape, of the level's shape, of its chunk
/// shape, and of its chunk grid; then the render radius.
pub const QUERY_STRIDE: usize = 15;

/// Numbers per query at the head of [`enumerate_batch`]'s output: the four
/// [`CullCounts`] in field order, then how many chunks the query found.
pub const QUERY_HEADER: usize = 5;

/// Numbers per chunk in [`enumerate_batch`]'s output, after every query's
/// header: X, Y, Z, distance.
pub const CHUNK_STRIDE: usize = 4;

/// [`enumerate_chunks`] for many queries against one view, in the flat
/// numeric layout the strides above describe, so a client crosses into the
/// core once per plan. Chunks follow the headers query by query.
pub fn enumerate_batch(view: &ChunkView, queries: &[f64]) -> Vec<f64> {
    let (queries, _) = queries.as_chunks::<QUERY_STRIDE>();
    let mut out = vec![0.0; queries.len() * QUERY_HEADER];
    let mut found = Vec::new();
    for (index, q) in queries.iter().enumerate() {
        let grid = |v: f64| {
            if v.is_finite() && v > 0.0 {
                v.min(u32::MAX as f64) as u32
            } else {
                0
            }
        };
        let query = ChunkQuery {
            position: [q[0], q[1]],
            full: [q[2], q[3], q[4]],
            shape: [q[5], q[6], q[7]],
            chunk: [q[8], q[9], q[10]],
            grid: [grid(q[11]), grid(q[12]), grid(q[13])],
            radius_view: q[14],
        };
        let mut counts = CullCounts::default();
        found.clear();
        enumerate_chunks(view, &query, &mut counts, &mut found);
        out[index * QUERY_HEADER..(index + 1) * QUERY_HEADER].copy_from_slice(&[
            counts.considered as f64,
            counts.after_xy_bounds as f64,
            counts.after_z_range as f64,
            counts.after_frustum as f64,
            found.len() as f64,
        ]);
        out.reserve(found.len() * CHUNK_STRIDE);
        for chunk in &found {
            out.extend_from_slice(&[
                chunk.x as f64,
                chunk.y as f64,
                chunk.z as f64,
                chunk.distance,
            ]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::Camera;

    /// A level from `[Z, Y, X]` shapes, one timepoint and one channel.
    fn geo(level: u32, shape_zyx: [u64; 3], chunk_zyx: [u64; 3]) -> LevelGeometry {
        let shape = [1, 1, shape_zyx[0], shape_zyx[1], shape_zyx[2]];
        let chunk_shape = [1, 1, chunk_zyx[0], chunk_zyx[1], chunk_zyx[2]];
        let grid_shape = std::array::from_fn(|d| shape[d].div_ceil(chunk_shape[d]));
        LevelGeometry {
            level_index: level,
            shape,
            chunk_shape,
            grid_shape,
            scale: [1.0; 5],
        }
    }

    /// A view from the fields a client sends.
    fn view(json: &str) -> ChunkView {
        ChunkView::from_json(json, 0.0).unwrap()
    }

    fn enumerate(view: &ChunkView, query: &ChunkQuery) -> (Vec<ScoredChunk>, CullCounts) {
        let mut counts = CullCounts::default();
        let mut out = Vec::new();
        enumerate_chunks(view, query, &mut counts, &mut out);
        (out, counts)
    }

    fn cells(found: &[ScoredChunk]) -> Vec<(u32, u32, u32)> {
        found.iter().map(|c| (c.x, c.y, c.z)).collect()
    }

    fn whole(level: &LevelGeometry) -> ChunkQuery {
        ChunkQuery::new(level, level, [0.0, 0.0], RENDER_RADIUS_DISABLED)
    }

    /// A 4 × 4 × 4 grid of 256 × 256 × 1 chunks.
    fn cube() -> LevelGeometry {
        geo(0, [4, 1024, 1024], [1, 256, 256])
    }

    #[test]
    fn a_slice_view_at_the_origin_samples_one_chunk() {
        let region = Camera::new_2d([512, 512]).visible_region(&(0..1), None, None);
        let g = geo(0, [256, 4096, 4096], [64, 256, 256]);
        let (found, _) = enumerate(&ChunkView::new(&region, 0.0), &whole(&g));
        assert_eq!(cells(&found), [(0, 0, 0)]);
    }

    #[test]
    fn panning_reveals_more_chunks() {
        let mut cam = Camera::new_2d([512, 512]);
        if let Camera::Slice(ref mut v) = cam {
            v.center = [512.0, 512.0];
        }
        let region = cam.visible_region(&(0..1), None, None);
        let g = geo(0, [256, 4096, 4096], [64, 256, 256]);
        let (found, _) = enumerate(&ChunkView::new(&region, 0.0), &whole(&g));
        assert_eq!(found.len(), 4);
    }

    #[test]
    fn the_region_clips_the_grid() {
        let g = geo(0, [1, 1024, 1024], [1, 256, 256]);
        let v = view(r#"{"xy_bounds":[0,0,512,512],"z_range":[0,1]}"#);
        let (found, _) = enumerate(&v, &whole(&g));
        assert_eq!(cells(&found), [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0)]);
    }

    #[test]
    fn the_layout_position_offsets_the_region() {
        // The region [400, 600) lands on the entity's first 100 samples.
        let g = geo(0, [1, 1024, 1024], [1, 256, 256]);
        let v = view(r#"{"xy_bounds":[400,400,600,600],"z_range":[0,1]}"#);
        let query = ChunkQuery::new(&g, &g, [500.0, 500.0], RENDER_RADIUS_DISABLED);
        assert_eq!(cells(&enumerate(&v, &query).0), [(0, 0, 0)]);
    }

    #[test]
    fn the_frustum_culls_chunks() {
        // The plane keeps chunks whose low X corner is at most 256.
        let v = view(
            r#"{"xy_bounds":[0,0,1024,1024],"z_range":[0,4],"frustum_planes":[[-1,0,0,256]]}"#,
        );
        let (found, counts) = enumerate(&v, &whole(&cube()));
        assert_eq!(found.len(), 32);
        assert!(found.iter().all(|c| c.x < 2));
        assert_eq!(counts.after_frustum, 32);
    }

    #[test]
    fn the_frustum_is_tested_where_the_entity_sits() {
        let v = view(
            r#"{"xy_bounds":[0,0,2048,1024],"z_range":[0,4],"frustum_planes":[[-1,0,0,1280]]}"#,
        );
        let query = ChunkQuery::new(&cube(), &cube(), [1024.0, 0.0], RENDER_RADIUS_DISABLED);
        let found = enumerate(&v, &query).0;
        assert_eq!(found.len(), 32);
        assert!(found.iter().all(|c| c.x < 2));
    }

    #[test]
    fn the_frustum_test_keeps_a_chunk_that_straddles_a_plane() {
        let planes = [[1.0, 0.0, 0.0, -2.0]];
        assert!(!chunk_outside_frustum(&[0.0; 3], &[3.0; 3], &planes));
        assert!(chunk_outside_frustum(&[0.0; 3], &[1.0; 3], &planes));
        assert!(!chunk_outside_frustum(&[2.5; 3], &[3.0; 3], &planes));
    }

    #[test]
    fn counts_follow_each_culling_stage() {
        let full = view(r#"{"xy_bounds":[0,0,1024,1024],"z_range":[0,4]}"#);
        assert_eq!(
            enumerate(&full, &whole(&cube())).1,
            CullCounts {
                considered: 64,
                after_xy_bounds: 64,
                after_z_range: 64,
                after_frustum: 64
            }
        );

        let quadrant = view(r#"{"xy_bounds":[0,0,512,512],"z_range":[0,4]}"#);
        assert_eq!(enumerate(&quadrant, &whole(&cube())).1.after_xy_bounds, 16);

        let one_plane = view(r#"{"xy_bounds":[0,0,1024,1024],"z_range":[0,1]}"#);
        let (_, counts) = enumerate(&one_plane, &whole(&cube()));
        assert_eq!((counts.after_xy_bounds, counts.after_z_range), (64, 16));
    }

    #[test]
    fn a_region_off_the_entity_counts_only_what_it_considered() {
        let v = view(r#"{"xy_bounds":[-2000,-2000,-1000,-1000],"z_range":[0,4]}"#);
        let (found, counts) = enumerate(&v, &whole(&cube()));
        assert!(found.is_empty());
        assert_eq!(
            counts,
            CullCounts {
                considered: 64,
                ..CullCounts::default()
            }
        );
    }

    #[test]
    fn a_frustum_that_culls_everything_still_counts_the_earlier_stages() {
        let v = view(
            r#"{"xy_bounds":[0,0,1024,1024],"z_range":[0,1],"frustum_planes":[[-1,0,0,-2000]]}"#,
        );
        let (found, counts) = enumerate(&v, &whole(&cube()));
        assert!(found.is_empty());
        assert_eq!(
            counts,
            CullCounts {
                considered: 64,
                after_xy_bounds: 64,
                after_z_range: 16,
                after_frustum: 0
            }
        );
    }

    #[test]
    fn a_volume_z_range_spans_every_chunk_it_overlaps() {
        let g = geo(0, [256, 4096, 4096], [64, 256, 256]);
        let v =
            view(r#"{"xy_bounds":[0,0,256,256],"z_range":[0,128],"frustum_planes":[[0,0,1,0]]}"#);
        let zs: Vec<u32> = enumerate(&v, &whole(&g)).0.iter().map(|c| c.z).collect();
        assert_eq!(zs, [0, 1]);
    }

    #[test]
    fn slice_level_z_takes_the_level_plane_under_the_plane_center() {
        assert_eq!(slice_level_z(16, 100, 50), 8);
        assert_eq!(slice_level_z(17, 100, 50), 8);
        assert_eq!(slice_level_z(99, 100, 50), 49);
        assert_eq!(slice_level_z(2, 10, 4), 1);
        assert_eq!(slice_level_z(15, 23, 23), 15);
        assert_eq!(slice_level_z(40, 32, 16), 15);
    }

    #[test]
    fn a_slice_view_samples_the_chunk_its_plane_maps_to() {
        // 100 planes halved to 50, in chunks 8 deep: plane 16 is the first of
        // level 1's chunk 1, where a proportional mapping lands one short.
        let full = geo(0, [100, 256, 256], [8, 256, 256]);
        let half = geo(1, [50, 128, 128], [8, 128, 128]);
        let query = ChunkQuery::new(&half, &full, [0.0, 0.0], RENDER_RADIUS_DISABLED);
        for z in 0..100u64 {
            let v = view(&format!(
                r#"{{"xy_bounds":[0,0,256,256],"z_range":[{z},{}]}}"#,
                z + 1
            ));
            let zs: Vec<u32> = enumerate(&v, &query).0.iter().map(|c| c.z).collect();
            assert_eq!(zs, [(slice_level_z(z, 100, 50) / 8) as u32], "plane {z}");
        }
    }

    #[test]
    fn a_slice_view_samples_one_chunk_where_its_plane_spans_two_level_planes() {
        // Plane 2 of 10 spans level planes 0 and 1 of 4. Its center is in
        // plane 1, so only the chunk holding plane 1 is wanted.
        let region = Camera::new_2d([512, 512]).visible_region(&(2..3), None, None);
        let full = geo(0, [10, 512, 512], [1, 512, 512]);
        let level1 = geo(1, [4, 256, 256], [1, 256, 256]);
        let query = ChunkQuery::new(&level1, &full, [0.0, 0.0], RENDER_RADIUS_DISABLED);
        let (found, _) = enumerate(&ChunkView::new(&region, 0.0), &query);
        assert!(!found.is_empty());
        assert!(found.iter().all(|c| c.z == 1));
    }

    #[test]
    fn a_slice_slab_samples_the_chunks_of_its_first_and_last_planes() {
        // A level that keeps all 100 planes, in chunks 32 deep.
        let full = geo(0, [100, 1024, 1024], [32, 32, 32]);
        let level1 = geo(1, [100, 512, 512], [32, 32, 32]);
        let v = view(r#"{"xy_bounds":[0,0,64,64],"z_range":[0,100]}"#);
        let query = ChunkQuery::new(&level1, &full, [0.0, 0.0], RENDER_RADIUS_DISABLED);
        let zs: Vec<u32> = enumerate(&v, &query).0.iter().map(|c| c.z).collect();
        assert_eq!(zs, [0, 1, 2, 3]);
    }

    #[test]
    fn the_distance_runs_from_the_sort_center_to_the_chunk_center() {
        let g = geo(0, [1, 256, 1024], [1, 256, 256]);
        let v = view(r#"{"xy_bounds":[0,0,1024,256],"z_range":[0,1],"sort_center":[896,128,0.5]}"#);
        let distances: Vec<f64> = enumerate(&v, &whole(&g))
            .0
            .iter()
            .map(|c| c.distance)
            .collect();
        assert_eq!(distances, [768.0, 512.0, 256.0, 0.0]);
    }

    #[test]
    fn the_distance_is_measured_where_the_entity_sits() {
        let g = geo(0, [1, 256, 256], [1, 256, 256]);
        let v = view(r#"{"xy_bounds":[0,0,1024,256],"z_range":[0,1],"sort_center":[128,128,0.5]}"#);
        let query = ChunkQuery::new(&g, &g, [512.0, 0.0], RENDER_RADIUS_DISABLED);
        assert_eq!(enumerate(&v, &query).0[0].distance, 512.0);
    }

    #[test]
    fn the_depth_bias_moves_the_focus_along_z_within_the_range() {
        // Eight chunks along Z, the region's Z range [0, 8) centered at 4.
        let g = geo(0, [8, 256, 256], [1, 256, 256]);
        let json = r#"{"xy_bounds":[0,0,256,256],"z_range":[0,8],"frustum_planes":[[0,0,1,0]]}"#;
        let nearest = |bias: f64| {
            let v = ChunkView::from_json(json, bias).unwrap();
            let found = enumerate(&v, &whole(&g)).0;
            let min = found
                .iter()
                .map(|c| c.distance)
                .fold(f64::INFINITY, f64::min);
            found
                .iter()
                .filter(|c| c.distance == min)
                .map(|c| c.z)
                .collect::<Vec<_>>()
        };
        assert_eq!(nearest(0.0), [3, 4]);
        assert_eq!(nearest(-0.5), [1, 2]);
        assert_eq!(nearest(-1.0), [0]);
        assert_eq!(nearest(1.0), [7]);
        // Past either end, the bias holds at that end.
        assert_eq!(nearest(-4.0), [0]);
    }

    #[test]
    fn the_render_radius_keeps_chunks_near_the_center() {
        // A 4 × 4 grid in a 1024-sample view: a radius basis of 100 at a
        // radius of 1 reaches only the four chunks touching the center.
        let g = geo(0, [1, 1024, 1024], [1, 256, 256]);
        let v = view(r#"{"xy_bounds":[0,0,1024,1024],"z_range":[0,1],"radius_basis_vox":100}"#);
        let query = |radius| ChunkQuery::new(&g, &g, [0.0, 0.0], radius);
        let (near, counts) = enumerate(&v, &query(1.0));
        assert_eq!(cells(&near), [(1, 1, 0), (2, 1, 0), (1, 2, 0), (2, 2, 0)]);
        // The radius drops chunks after the frustum's count.
        assert_eq!(counts.after_frustum, 16);
        assert_eq!(enumerate(&v, &query(RENDER_RADIUS_DISABLED)).0.len(), 16);
        assert_eq!(enumerate(&v, &query(f64::NAN)).0.len(), 16);
    }

    #[test]
    fn the_render_radius_falls_back_to_the_half_diagonal() {
        // A region 1024 samples wide and almost no height: at 0.4 of its
        // 512-sample half-diagonal, the radius reaches the two middle chunks.
        let g = geo(0, [1, 256, 1024], [1, 256, 256]);
        let v = view(r#"{"xy_bounds":[0,0,1024,0.0001],"z_range":[0,1]}"#);
        let query = ChunkQuery::new(&g, &g, [0.0, 0.0], 0.4);
        assert_eq!(cells(&enumerate(&v, &query).0), [(1, 0, 0), (2, 0, 0)]);
    }

    #[test]
    fn the_render_radius_measures_an_edge_chunk_to_the_image_edge() {
        // A 300-sample image in 256-sample chunks: the second chunk's samples
        // stop at 300, 100 short of the center at 400.
        let g = geo(0, [1, 256, 300], [1, 256, 256]);
        let v = view(
            r#"{"xy_bounds":[0,0,800,256],"z_range":[0,1],"sort_center":[400,128,0.5],"radius_basis_vox":100}"#,
        );
        let query = |radius| ChunkQuery::new(&g, &g, [0.0, 0.0], radius);
        assert!(enumerate(&v, &query(0.99)).0.is_empty());
        assert_eq!(cells(&enumerate(&v, &query(1.01)).0), [(1, 0, 0)]);
    }

    #[test]
    fn a_view_reads_the_region_the_scene_writes() {
        let mut cam = Camera::new_2d([512, 512]);
        if let Camera::Slice(ref mut v) = cam {
            v.center = [300.0, 200.0];
        }
        let region = cam.visible_region(&(3..4), None, None);
        let json = serde_json::to_string(&region).unwrap();
        let (read, held) = (
            ChunkView::from_json(&json, 0.25).unwrap(),
            ChunkView::new(&region, 0.25),
        );
        let g = geo(0, [8, 1024, 1024], [1, 64, 64]);
        let query = ChunkQuery::new(&g, &g, [0.0, 0.0], 0.75);
        let ((a, a_counts), (b, b_counts)) = (enumerate(&read, &query), enumerate(&held, &query));
        assert!(!a.is_empty());
        assert_eq!((cells(&a), a_counts), (cells(&b), b_counts));
        for (a, b) in a.iter().zip(&b) {
            assert!((a.distance - b.distance).abs() < 1e-9);
        }
    }

    #[test]
    fn a_batch_lays_out_each_query_as_enumerate_chunks_finds_it() {
        let v = view(r#"{"xy_bounds":[0,0,600,512],"z_range":[0,1],"sort_center":[100,100,0]}"#);
        let full = geo(0, [1, 1024, 1024], [1, 256, 256]);
        let half = geo(1, [1, 512, 512], [1, 256, 256]);
        let queries = [
            ChunkQuery::new(&full, &full, [0.0, 0.0], RENDER_RADIUS_DISABLED),
            ChunkQuery::new(&half, &full, [512.0, 0.0], 1.5),
        ];
        let mut input = Vec::new();
        for q in &queries {
            input.extend_from_slice(&q.position);
            input.extend_from_slice(&q.full);
            input.extend_from_slice(&q.shape);
            input.extend_from_slice(&q.chunk);
            input.extend(q.grid.map(f64::from));
            input.push(q.radius_view);
        }
        assert_eq!(input.len(), queries.len() * QUERY_STRIDE);
        let out = enumerate_batch(&v, &input);

        let mut at = queries.len() * QUERY_HEADER;
        for (index, q) in queries.iter().enumerate() {
            let (found, counts) = enumerate(&v, q);
            assert!(!found.is_empty());
            assert_eq!(
                out[index * QUERY_HEADER..(index + 1) * QUERY_HEADER],
                [
                    counts.considered as f64,
                    counts.after_xy_bounds as f64,
                    counts.after_z_range as f64,
                    counts.after_frustum as f64,
                    found.len() as f64
                ]
            );
            for chunk in found {
                assert_eq!(
                    out[at..at + CHUNK_STRIDE],
                    [
                        chunk.x as f64,
                        chunk.y as f64,
                        chunk.z as f64,
                        chunk.distance
                    ]
                );
                at += CHUNK_STRIDE;
            }
        }
        assert_eq!(at, out.len());
    }
}
