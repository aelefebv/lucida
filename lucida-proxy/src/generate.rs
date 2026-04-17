//! Proxy generation algorithms.
//!
//! Two kinds:
//!
//! - [`ProxyKind::FieldProxy3D`] — pick a coarse-but-not-too-coarse level
//!   from the entity's image, read it through the source, and box-filter
//!   down to `target_long_axis` along its longest axis (others scaled
//!   proportionally, never upsampled).
//!
//! - [`ProxyKind::WellProxy3D`] — find the well's child fields, derive a
//!   common bounding box from each field's `voxel_to_image × field_to_well`
//!   transform, allocate an output volume sized so the longest axis hits
//!   `target_long_axis`, and for each output voxel sample whichever fields
//!   contain that point. When multiple fields cover a voxel we average
//!   them; gaps stay zero.

use lucida_content::{
    AffineTransform, ContentGraph, Entity, EntityId, EntityKind, ImageSpec, LevelGeometry,
};

use crate::source::{ProxySourceData, SourceError};
use crate::spec::{ALGORITHM_VERSION, ProxyAsset, ProxyDtype, ProxyHeader, ProxyKind, ProxySpec};
use crate::header::source_content_hash;

/// Errors returned by [`generate_proxy`].
#[derive(thiserror::Error, Debug)]
pub enum GenerateError {
    #[error("source error: {0}")]
    Source(#[from] SourceError),
    #[error("entity not found in content graph: {0}")]
    MissingEntity(EntityId),
    #[error("image not found for entity: {0}")]
    MissingImage(EntityId),
    #[error("image has no multiscale levels: {0}")]
    EmptyMultiscale(EntityId),
    #[error("well has no field children: {0}")]
    NoFields(EntityId),
    #[error("requested t={t} or c={c} out of bounds for image")]
    OutOfBounds { t: u32, c: u32 },
    #[error("invalid spec: target_long_axis must be > 0")]
    InvalidTarget,
}

/// Top-level entry point. Dispatches on [`ProxyKind`] and produces a
/// [`ProxyAsset`] (in-memory header + voxels).
pub fn generate_proxy(
    spec: &ProxySpec,
    content: &ContentGraph,
    source: &dyn ProxySourceData,
) -> Result<ProxyAsset, GenerateError> {
    if spec.target_long_axis == 0 {
        return Err(GenerateError::InvalidTarget);
    }

    let entity = content
        .entities()
        .iter()
        .find(|e| e.id == spec.entity_id)
        .ok_or_else(|| GenerateError::MissingEntity(spec.entity_id.clone()))?;

    match spec.kind {
        ProxyKind::FieldProxy3D => downsample_field(spec, content, entity, source),
        ProxyKind::WellProxy3D => aggregate_well(spec, content, entity, source),
    }
}

// =============================================================================
// FieldProxy3D
// =============================================================================

fn downsample_field(
    spec: &ProxySpec,
    content: &ContentGraph,
    entity: &Entity,
    source: &dyn ProxySourceData,
) -> Result<ProxyAsset, GenerateError> {
    let image = content
        .images()
        .iter()
        .find(|img| img.owner == entity.id)
        .ok_or_else(|| GenerateError::MissingImage(entity.id.clone()))?;

    let levels = &image.multiscale.levels;
    if levels.is_empty() {
        return Err(GenerateError::EmptyMultiscale(entity.id.clone()));
    }
    let level_index = pick_level(levels, spec.target_long_axis);

    let volume = source.read_field_volume(&image.image_id, spec.t, spec.c, level_index)?;
    let out = box_filter_to_target(&volume.data, volume.dims, spec.target_long_axis);

    let header = ProxyHeader {
        algorithm_version: ALGORITHM_VERSION,
        source_content_hash: source_content_hash(content, &spec.entity_id, spec.t, spec.c),
        dims: out.dims,
        dtype: ProxyDtype::U16,
    };
    Ok(ProxyAsset {
        header,
        voxels: out.data,
    })
}

/// Choose the coarsest level whose smallest spatial axis is still
/// `>= 2 × target_long_axis`. If no such level exists, fall back to the
/// coarsest available — guaranteeing we always pick *something*.
fn pick_level(levels: &[LevelGeometry], target_long_axis: u32) -> usize {
    let threshold = (target_long_axis as u64).saturating_mul(2);

    // Levels are typically ordered finest → coarsest. Walk from coarsest
    // down, stopping at the first one whose min spatial axis still clears
    // the threshold.
    let mut chosen = 0_usize;
    for (i, level) in levels.iter().enumerate() {
        // shape is [T, C, Z, Y, X]; spatial = Z, Y, X.
        let z = level.shape[2];
        let y = level.shape[3];
        let x = level.shape[4];
        let min_spatial = z.min(y).min(x);
        if min_spatial >= threshold {
            chosen = i;
        }
    }
    // If the loop never updated `chosen` (e.g., even level 0 is too small),
    // fall back to the coarsest available level (last index).
    if chosen == 0
        && levels[0].shape[2..5]
            .iter()
            .copied()
            .min()
            .unwrap_or(0)
            < threshold
    {
        chosen = levels.len() - 1;
    }
    chosen
}

/// Box-filter `data` (sized `[Z, Y, X]`) down to a target volume whose
/// longest axis is at most `target_long_axis`. Other axes scale
/// proportionally; the result is never larger than the source on any axis.
struct DownsampleOut {
    data: Vec<u16>,
    dims: [u32; 3],
}

fn box_filter_to_target(data: &[u16], dims: [u32; 3], target_long_axis: u32) -> DownsampleOut {
    let [in_z, in_y, in_x] = dims;
    let max_in = in_z.max(in_y).max(in_x);
    let target = target_long_axis.min(max_in).max(1);

    let scale = target as f64 / max_in as f64;
    let out_z = ((in_z as f64 * scale).round() as u32).clamp(1, in_z);
    let out_y = ((in_y as f64 * scale).round() as u32).clamp(1, in_y);
    let out_x = ((in_x as f64 * scale).round() as u32).clamp(1, in_x);

    let out_dims = [out_z, out_y, out_x];
    let mut out = vec![0u16; (out_z as usize) * (out_y as usize) * (out_x as usize)];

    for oz in 0..out_z {
        let (z0, z1) = box_bounds(oz, out_z, in_z);
        for oy in 0..out_y {
            let (y0, y1) = box_bounds(oy, out_y, in_y);
            for ox in 0..out_x {
                let (x0, x1) = box_bounds(ox, out_x, in_x);
                let mut acc: u64 = 0;
                let mut count: u64 = 0;
                for z in z0..z1 {
                    for y in y0..y1 {
                        let row_off = (z * in_y + y) * in_x;
                        for x in x0..x1 {
                            acc += data[(row_off + x) as usize] as u64;
                            count += 1;
                        }
                    }
                }
                let avg = if count == 0 { 0 } else { (acc / count) as u16 };
                let oi = ((oz * out_y + oy) * out_x + ox) as usize;
                out[oi] = avg;
            }
        }
    }

    DownsampleOut {
        data: out,
        dims: out_dims,
    }
}

/// Half-open input range `[lo, hi)` covered by output voxel `oi` of
/// `out_size` mapping into `in_size`.
fn box_bounds(oi: u32, out_size: u32, in_size: u32) -> (u32, u32) {
    let lo = (oi as u64 * in_size as u64) / out_size as u64;
    let hi = ((oi as u64 + 1) * in_size as u64) / out_size as u64;
    let lo = lo as u32;
    let mut hi = hi as u32;
    if hi <= lo {
        hi = (lo + 1).min(in_size);
    }
    (lo, hi)
}

// =============================================================================
// WellProxy3D
// =============================================================================

fn aggregate_well(
    spec: &ProxySpec,
    content: &ContentGraph,
    well_entity: &Entity,
    source: &dyn ProxySourceData,
) -> Result<ProxyAsset, GenerateError> {
    if !matches!(well_entity.kind, EntityKind::Well) {
        // Treat any non-Well entity dispatch as the field path.
        return downsample_field(spec, content, well_entity, source);
    }

    // Gather field children of this well.
    let fields: Vec<&Entity> = content
        .entities()
        .iter()
        .filter(|e| matches!(e.kind, EntityKind::Field))
        .filter(|e| e.parent.as_ref() == Some(&well_entity.id))
        .collect();
    if fields.is_empty() {
        return Err(GenerateError::NoFields(well_entity.id.clone()));
    }

    // Build per-field metadata: image, level chosen, field-to-well transform.
    let mut field_data: Vec<FieldEntry> = Vec::with_capacity(fields.len());
    for field in &fields {
        let image = content
            .images()
            .iter()
            .find(|img| img.owner == field.id)
            .ok_or_else(|| GenerateError::MissingImage(field.id.clone()))?;
        if image.multiscale.levels.is_empty() {
            return Err(GenerateError::EmptyMultiscale(field.id.clone()));
        }
        let level_index = pick_level(&image.multiscale.levels, spec.target_long_axis);

        let field_to_well = find_field_to_well(content, &field.id, &well_entity.id);
        let volume = source.read_field_volume(&image.image_id, spec.t, spec.c, level_index)?;

        // Compose voxel→image and image→well into voxel→well so we can
        // bound and sample in well space directly.
        let voxel_to_well = compose(&field_to_well, &volume.voxel_to_image);
        let well_to_voxel = invert(&voxel_to_well).unwrap_or_else(AffineTransform::identity);

        field_data.push(FieldEntry {
            image: image.clone(),
            volume,
            voxel_to_well,
            well_to_voxel,
        });
    }

    // Compute the well bounding box by walking each field's 8 voxel-corners
    // through `voxel_to_well` and tracking the AABB.
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for entry in &field_data {
        let [vz, vy, vx] = entry.volume.dims;
        for &z in &[0.0_f64, vz as f64] {
            for &y in &[0.0_f64, vy as f64] {
                for &x in &[0.0_f64, vx as f64] {
                    let p = transform_point(&entry.voxel_to_well, [x, y, z]);
                    for axis in 0..3 {
                        if p[axis] < min[axis] {
                            min[axis] = p[axis];
                        }
                        if p[axis] > max[axis] {
                            max[axis] = p[axis];
                        }
                    }
                }
            }
        }
    }

    let span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let mut max_span = span[0].max(span[1]).max(span[2]);
    if !max_span.is_finite() || max_span <= 0.0 {
        max_span = 1.0;
    }

    let target = spec.target_long_axis.max(1) as f64;
    let scale = target / max_span; // output voxels per well unit
    let out_x = ((span[0] * scale).round() as u32).max(1);
    let out_y = ((span[1] * scale).round() as u32).max(1);
    let out_z = ((span[2] * scale).round() as u32).max(1);
    let out_dims = [out_z, out_y, out_x];

    // Per-output-voxel size in well units.
    let voxel_w_x = span[0] / out_x as f64;
    let voxel_w_y = span[1] / out_y as f64;
    let voxel_w_z = span[2] / out_z as f64;

    let mut acc = vec![0u64; (out_z as usize) * (out_y as usize) * (out_x as usize)];
    let mut count = vec![0u32; acc.len()];

    for entry in &field_data {
        for oz in 0..out_z {
            // Center of the output voxel along Z in well coords.
            let wz = min[2] + (oz as f64 + 0.5) * voxel_w_z;
            for oy in 0..out_y {
                let wy = min[1] + (oy as f64 + 0.5) * voxel_w_y;
                for ox in 0..out_x {
                    let wx = min[0] + (ox as f64 + 0.5) * voxel_w_x;

                    // Project well point back into this field's voxel grid.
                    let v = transform_point(&entry.well_to_voxel, [wx, wy, wz]);
                    let [fz, fy, fx] =
                        [entry.volume.dims[0] as f64, entry.volume.dims[1] as f64, entry.volume.dims[2] as f64];
                    let in_x = v[0];
                    let in_y = v[1];
                    let in_z = v[2];
                    if in_x < 0.0 || in_y < 0.0 || in_z < 0.0 {
                        continue;
                    }
                    if in_x >= fx || in_y >= fy || in_z >= fz {
                        continue;
                    }

                    // Box-sample the field around (in_z, in_y, in_x). We use
                    // the per-output voxel extent in field-voxel units.
                    let scale_x = entry.volume.dims[2] as f64 / span[0] * voxel_w_x;
                    let scale_y = entry.volume.dims[1] as f64 / span[1] * voxel_w_y;
                    let scale_z = entry.volume.dims[0] as f64 / span[2] * voxel_w_z;
                    let half_x = (scale_x * 0.5).max(0.5);
                    let half_y = (scale_y * 0.5).max(0.5);
                    let half_z = (scale_z * 0.5).max(0.5);

                    let x0 = (in_x - half_x).floor().max(0.0) as u32;
                    let x1 = ((in_x + half_x).ceil() as u32).min(entry.volume.dims[2]);
                    let y0 = (in_y - half_y).floor().max(0.0) as u32;
                    let y1 = ((in_y + half_y).ceil() as u32).min(entry.volume.dims[1]);
                    let z0 = (in_z - half_z).floor().max(0.0) as u32;
                    let z1 = ((in_z + half_z).ceil() as u32).min(entry.volume.dims[0]);

                    if x1 <= x0 || y1 <= y0 || z1 <= z0 {
                        continue;
                    }

                    let in_xs = entry.volume.dims[2] as u64;
                    let in_ys = entry.volume.dims[1] as u64;
                    let mut sample_acc: u64 = 0;
                    let mut sample_count: u64 = 0;
                    for z in z0..z1 {
                        for y in y0..y1 {
                            let row_off = (z as u64 * in_ys + y as u64) * in_xs;
                            for x in x0..x1 {
                                sample_acc +=
                                    entry.volume.data[(row_off + x as u64) as usize] as u64;
                                sample_count += 1;
                            }
                        }
                    }
                    if sample_count == 0 {
                        continue;
                    }
                    let avg = sample_acc / sample_count;

                    let oi = ((oz * out_y + oy) * out_x + ox) as usize;
                    acc[oi] += avg;
                    count[oi] += 1;
                }
            }
        }
    }

    let voxels: Vec<u16> = acc
        .iter()
        .zip(count.iter())
        .map(|(a, c)| if *c == 0 { 0 } else { (a / *c as u64) as u16 })
        .collect();

    let header = ProxyHeader {
        algorithm_version: ALGORITHM_VERSION,
        source_content_hash: source_content_hash(content, &spec.entity_id, spec.t, spec.c),
        dims: out_dims,
        dtype: ProxyDtype::U16,
    };
    Ok(ProxyAsset { header, voxels })
}

struct FieldEntry {
    #[allow(dead_code)]
    image: ImageSpec,
    volume: crate::source::FieldVolume,
    voxel_to_well: AffineTransform,
    well_to_voxel: AffineTransform,
}

/// Find an `EntityKind::Field → Well` transform. Returns identity if no
/// edge exists (a well with a single field at origin behaves correctly).
fn find_field_to_well(
    content: &ContentGraph,
    field_id: &EntityId,
    well_id: &EntityId,
) -> AffineTransform {
    content
        .transforms()
        .iter()
        .find(|edge| &edge.from == field_id && &edge.to == well_id)
        .map(|edge| edge.transform.clone())
        .unwrap_or_else(AffineTransform::identity)
}

// =============================================================================
// Affine math (column-major 4×4)
// =============================================================================

/// Multiply two column-major 4x4 matrices. Returns `lhs * rhs`.
fn compose(lhs: &AffineTransform, rhs: &AffineTransform) -> AffineTransform {
    // Column-major: m[col*4 + row]
    let mut out = [0.0_f64; 16];
    for col in 0..4 {
        for row in 0..4 {
            let mut sum = 0.0;
            for k in 0..4 {
                let a = lhs.matrix[k * 4 + row];
                let b = rhs.matrix[col * 4 + k];
                sum += a * b;
            }
            out[col * 4 + row] = sum;
        }
    }
    AffineTransform { matrix: out }
}

/// Apply a column-major affine to a point `[x, y, z]` (homogeneous w = 1).
fn transform_point(m: &AffineTransform, p: [f64; 3]) -> [f64; 3] {
    // Column-major: column `c` lives at indices `[c*4 .. c*4 + 4]`.
    let mat = &m.matrix;
    let x = p[0];
    let y = p[1];
    let z = p[2];
    let rx = mat[0] * x + mat[4] * y + mat[8] * z + mat[12];
    let ry = mat[1] * x + mat[5] * y + mat[9] * z + mat[13];
    let rz = mat[2] * x + mat[6] * y + mat[10] * z + mat[14];
    [rx, ry, rz]
}

/// Invert a column-major 4×4 affine via Gauss-Jordan with partial
/// pivoting. Returns `None` for degenerate matrices.
fn invert(m: &AffineTransform) -> Option<AffineTransform> {
    // Convert column-major flat to a row-major [4][4] array.
    let mut a = [[0.0f64; 4]; 4];
    for col in 0..4 {
        for row in 0..4 {
            a[row][col] = m.matrix[col * 4 + row];
        }
    }

    // Gauss-Jordan inversion with partial pivoting.
    let mut inv = [[0.0f64; 4]; 4];
    for i in 0..4 {
        inv[i][i] = 1.0;
    }

    for col in 0..4 {
        // Find pivot.
        let mut pivot_row = col;
        let mut pivot_val = a[col][col].abs();
        for row in (col + 1)..4 {
            let v = a[row][col].abs();
            if v > pivot_val {
                pivot_row = row;
                pivot_val = v;
            }
        }
        if pivot_val < 1e-18 {
            return None;
        }
        if pivot_row != col {
            a.swap(col, pivot_row);
            inv.swap(col, pivot_row);
        }

        let pivot = a[col][col];
        for j in 0..4 {
            a[col][j] /= pivot;
            inv[col][j] /= pivot;
        }

        for row in 0..4 {
            if row == col {
                continue;
            }
            let factor = a[row][col];
            if factor == 0.0 {
                continue;
            }
            for j in 0..4 {
                a[row][j] -= factor * a[col][j];
                inv[row][j] -= factor * inv[col][j];
            }
        }
    }

    // Pack back to column-major.
    let mut out = [0.0f64; 16];
    for col in 0..4 {
        for row in 0..4 {
            out[col * 4 + row] = inv[row][col];
        }
    }
    Some(AffineTransform { matrix: out })
}
