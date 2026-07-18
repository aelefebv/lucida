use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use rayon::prelude::*;
use serde_json::json;

use super::AtomicOutput;
use super::ome_metadata;
use super::pyramid::LevelData;

const MAX_ZARR_CHUNKS_PER_LEVEL: usize = 10_000_000;

/// Write a complete OME-Zarr v0.5 (Zarr v3) store to disk.
///
/// `chunk_size` is [Z, Y, X] matching lucida-core convention.
/// Always writes 5D TCZYX with chunk paths `t/c/z/y/x`.
pub fn write_zarr(
    output: &Path,
    levels: &[LevelData],
    chunk_size: &[u32; 3],
) -> Result<(), String> {
    if levels.is_empty() || levels.len() > 64 {
        return Err("Zarr pyramid must contain between 1 and 64 levels".to_string());
    }
    let publication = AtomicOutput::begin(output)?;
    let output = publication.path();
    // Default: assume each level is 2x in XY only (legacy behavior)
    let scales: Vec<[f64; 3]> = (0..levels.len())
        .map(|i| {
            let exponent = i32::try_from(i)
                .map_err(|_| "Zarr pyramid level exponent exceeds i32".to_string())?;
            let f = 2_f64.powi(exponent);
            if !f.is_finite() {
                return Err("Zarr pyramid scale overflow".to_string());
            }
            Ok([f, f, 1.0])
        })
        .collect::<Result<_, String>>()?;
    write_root_metadata(output, levels, &scales)?;

    for (i, level) in levels.iter().enumerate() {
        write_zarr_level(output, i, level, chunk_size)?;
    }

    publication.commit()
}

/// Write root group zarr.json with OME multiscales attributes.
///
/// Call this once before writing individual levels.
/// `level_scales` provides per-level cumulative [x, y, z] scale factors.
pub fn write_root_metadata(
    output: &Path,
    levels: &[LevelData],
    level_scales: &[[f64; 3]],
) -> Result<(), String> {
    if levels.is_empty() || levels.len() != level_scales.len() {
        return Err("Zarr root metadata requires one scale per non-empty level".to_string());
    }
    if level_scales
        .iter()
        .flatten()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err("Zarr root metadata scales must be finite and positive".to_string());
    }
    fs::create_dir_all(output).map_err(|e| format!("failed to create output dir: {e}"))?;

    let ome_attrs = ome_metadata::build_multiscales_attrs(levels, level_scales);
    let root_meta = json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": ome_attrs
    });
    write_json(output, "zarr.json", &root_meta)
}

/// Write a single pyramid level (array metadata + chunks) to disk.
pub fn write_zarr_level(
    output: &Path,
    level_index: usize,
    level: &LevelData,
    chunk_size: &[u32; 3],
) -> Result<(), String> {
    validate_level(level, chunk_size)?;
    let level_dir = output.join(level_index.to_string());
    fs::create_dir_all(&level_dir).map_err(|e| format!("failed to create level dir: {e}"))?;

    let array_meta = ome_metadata::build_array_zarr_json(level, chunk_size);
    write_json(&level_dir, "zarr.json", &array_meta)?;

    write_chunks(&level_dir, level_index, level, chunk_size)
}

/// Write chunk files for a single level.
///
/// Chunk path: `c/{t}/{c}/{z}/{y}/{x}`
fn write_chunks(
    level_dir: &Path,
    level_index: usize,
    level: &LevelData,
    chunk_size: &[u32; 3],
) -> Result<(), String> {
    // chunk_size is [Z, Y, X]
    let cz = chunk_size[0];
    let cy = chunk_size[1];
    let cx = chunk_size[2];

    let nx = level.width.div_ceil(cx);
    let ny = level.height.div_ceil(cy);
    let nz = level.depth.div_ceil(cz);
    let total = [level.timepoints, level.channels, nz, ny, nx]
        .into_iter()
        .try_fold(1usize, |product, dimension| {
            product.checked_mul(dimension as usize)
        })
        .ok_or_else(|| "Zarr chunk-count arithmetic overflow".to_string())?;
    if total > MAX_ZARR_CHUNKS_PER_LEVEL {
        return Err(format!(
            "Zarr level requires {total} chunks; limit is {MAX_ZARR_CHUNKS_PER_LEVEL}"
        ));
    }

    // Collect all chunk indices
    let mut indices = Vec::new();
    indices
        .try_reserve_exact(total)
        .map_err(|error| format!("failed to reserve Zarr chunk index: {error}"))?;
    for ti in 0..level.timepoints {
        for ci in 0..level.channels {
            for zi in 0..nz {
                for yi in 0..ny {
                    for xi in 0..nx {
                        indices.push((ti, ci, zi, yi, xi));
                    }
                }
            }
        }
    }

    debug_assert_eq!(indices.len(), total);
    if total == 0 {
        return Ok(());
    }

    // Pre-create all unique parent directories to avoid racing on create_dir_all
    let mut dirs = HashSet::new();
    for &(ti, ci, zi, yi, _xi) in &indices {
        let parent = level_dir
            .join("c")
            .join(ti.to_string())
            .join(ci.to_string())
            .join(zi.to_string())
            .join(yi.to_string());
        dirs.insert(parent);
    }
    for dir in &dirs {
        fs::create_dir_all(dir).map_err(|e| format!("failed to create chunk dir: {e}"))?;
    }

    // Progress counter
    let completed = AtomicUsize::new(0);

    // Write chunks in parallel
    indices.par_iter().try_for_each(|&(ti, ci, zi, yi, xi)| {
        let chunk_path = level_dir
            .join("c")
            .join(ti.to_string())
            .join(ci.to_string())
            .join(zi.to_string())
            .join(yi.to_string())
            .join(xi.to_string());

        let raw = extract_chunk(level, cx, cy, cz, xi, yi, zi, ti, ci)?;
        let compressed = lz4_flex::compress_prepend_size(&raw);

        fs::write(&chunk_path, &compressed).map_err(|e| format!("failed to write chunk: {e}"))?;

        let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
        if done.is_multiple_of(100) || done == total {
            eprintln!("  level {level_index}: writing chunks {done}/{total}");
        }

        Ok::<(), String>(())
    })?;

    Ok(())
}

/// Extract a single chunk as raw little-endian u16 bytes, zero-padded at edges.
///
/// Data is indexed in TCZYX order.
// Internal helper; args are chunk shape (cx,cy,cz) plus chunk index (xi,yi,zi,ti,ci).
#[allow(clippy::too_many_arguments)]
fn extract_chunk(
    level: &LevelData,
    cx: u32,
    cy: u32,
    cz: u32,
    xi: u32,
    yi: u32,
    zi: u32,
    ti: u32,
    ci: u32,
) -> Result<Vec<u8>, String> {
    if cx == 0 || cy == 0 || cz == 0 {
        return Err("Zarr chunk dimensions must be positive".to_string());
    }
    if ti >= level.timepoints || ci >= level.channels {
        return Err("Zarr chunk T/C coordinate is outside level bounds".to_string());
    }
    let chunk_bytes = usize::try_from(cx)
        .ok()
        .and_then(|value| value.checked_mul(cy as usize))
        .and_then(|value| value.checked_mul(cz as usize))
        .and_then(|value| value.checked_mul(std::mem::size_of::<u16>()))
        .ok_or_else(|| "Zarr chunk-byte arithmetic overflow".to_string())?;
    let mut buf = vec![0u8; chunk_bytes];

    let x_start = xi
        .checked_mul(cx)
        .ok_or_else(|| "Zarr X chunk offset overflow".to_string())?;
    let y_start = yi
        .checked_mul(cy)
        .ok_or_else(|| "Zarr Y chunk offset overflow".to_string())?;
    let z_start = zi
        .checked_mul(cz)
        .ok_or_else(|| "Zarr Z chunk offset overflow".to_string())?;

    let plane_size = usize::try_from(level.width)
        .ok()
        .and_then(|value| value.checked_mul(level.height as usize))
        .ok_or_else(|| "Zarr plane-size arithmetic overflow".to_string())?;
    let tc_plane = usize::try_from(ti)
        .ok()
        .and_then(|value| value.checked_mul(level.channels as usize))
        .and_then(|value| value.checked_add(ci as usize))
        .and_then(|value| value.checked_mul(level.depth as usize))
        .ok_or_else(|| "Zarr T/C offset arithmetic overflow".to_string())?;
    let tc_offset = tc_plane
        .checked_mul(plane_size)
        .ok_or_else(|| "Zarr T/C pixel offset overflow".to_string())?;

    for lz in 0..cz {
        let gz = z_start + lz;
        if gz >= level.depth {
            break;
        }
        for ly in 0..cy {
            let gy = y_start + ly;
            if gy >= level.height {
                break;
            }

            let row_len = cx.min(level.width.saturating_sub(x_start));
            let src_offset = usize::try_from(gz)
                .ok()
                .and_then(|value| value.checked_mul(plane_size))
                .and_then(|value| {
                    usize::try_from(gy)
                        .ok()
                        .and_then(|gy| gy.checked_mul(level.width as usize))
                        .and_then(|row| value.checked_add(row))
                })
                .and_then(|value| value.checked_add(x_start as usize))
                .and_then(|value| tc_offset.checked_add(value))
                .ok_or_else(|| "Zarr source offset arithmetic overflow".to_string())?;
            let dst_offset = usize::try_from(lz)
                .ok()
                .and_then(|value| value.checked_mul(cy as usize))
                .and_then(|value| value.checked_add(ly as usize))
                .and_then(|value| value.checked_mul(cx as usize))
                .and_then(|value| value.checked_mul(std::mem::size_of::<u16>()))
                .ok_or_else(|| "Zarr destination offset arithmetic overflow".to_string())?;

            for lx in 0..row_len {
                let source = src_offset
                    .checked_add(lx as usize)
                    .ok_or_else(|| "Zarr source index overflow".to_string())?;
                let val = *level
                    .data
                    .get(source)
                    .ok_or_else(|| "Zarr source index escaped validated level data".to_string())?;
                let d = dst_offset
                    .checked_add((lx as usize) * 2)
                    .ok_or_else(|| "Zarr destination index overflow".to_string())?;
                if d + 1 >= buf.len() {
                    return Err("Zarr destination index escaped chunk buffer".to_string());
                }
                buf[d] = val as u8;
                buf[d + 1] = (val >> 8) as u8;
            }
        }
    }

    Ok(buf)
}

fn validate_level(level: &LevelData, chunk_size: &[u32; 3]) -> Result<(), String> {
    if level.width == 0
        || level.height == 0
        || level.depth == 0
        || level.channels == 0
        || level.timepoints == 0
    {
        return Err("Zarr level dimensions must be positive".to_string());
    }
    if chunk_size.contains(&0) {
        return Err("Zarr chunk dimensions must be positive".to_string());
    }
    let expected = [
        level.timepoints,
        level.channels,
        level.depth,
        level.height,
        level.width,
    ]
    .into_iter()
    .try_fold(1usize, |product, dimension| {
        product.checked_mul(dimension as usize)
    })
    .ok_or_else(|| "Zarr level-size arithmetic overflow".to_string())?;
    if level.data.len() != expected {
        return Err(format!(
            "Zarr level data has {} pixels; dimensions require {expected}",
            level.data.len()
        ));
    }
    Ok(())
}

fn write_json(dir: &Path, name: &str, value: &serde_json::Value) -> Result<(), String> {
    let path = dir.join(name);
    let content = serde_json::to_string_pretty(value)
        .map_err(|e| format!("failed to serialize JSON: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("lucida_test_{}", std::process::id()))
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn extract_chunk_zero_pads_edges() {
        let level = LevelData {
            data: vec![1, 2, 3, 4, 5, 6, 7, 8, 9],
            width: 3,
            height: 3,
            depth: 1,
            channels: 1,
            timepoints: 1,
        };
        let bytes = extract_chunk(&level, 4, 4, 1, 0, 0, 0, 0, 0).unwrap();
        assert_eq!(bytes.len(), 32);
        assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), 1);
        assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 0);
        assert_eq!(u16::from_le_bytes([bytes[24], bytes[25]]), 0);
    }

    #[test]
    fn extract_chunk_selects_correct_tc() {
        // T=1, C=2, Z=1, 2x2 each
        let level = LevelData {
            data: vec![1, 2, 3, 4, 10, 20, 30, 40],
            width: 2,
            height: 2,
            depth: 1,
            channels: 2,
            timepoints: 1,
        };
        let bytes_c0 = extract_chunk(&level, 2, 2, 1, 0, 0, 0, 0, 0).unwrap();
        assert_eq!(u16::from_le_bytes([bytes_c0[0], bytes_c0[1]]), 1);

        let bytes_c1 = extract_chunk(&level, 2, 2, 1, 0, 0, 0, 0, 1).unwrap();
        assert_eq!(u16::from_le_bytes([bytes_c1[0], bytes_c1[1]]), 10);
    }

    #[test]
    fn write_zarr_creates_expected_structure() {
        let dir = temp_dir("zarr");
        let levels = vec![LevelData {
            data: vec![0u16; 4 * 4],
            width: 4,
            height: 4,
            depth: 1,
            channels: 1,
            timepoints: 1,
        }];
        write_zarr(&dir, &levels, &[1, 4, 4]).unwrap();

        assert!(dir.join("zarr.json").exists());
        assert!(dir.join("0/zarr.json").exists());
        assert!(dir.join("0/c/0/0/0/0/0").exists()); // c/t/c/z/y/x

        // Verify root zarr.json content
        let root: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("zarr.json")).unwrap()).unwrap();
        assert_eq!(root["zarr_format"], 3);
        assert_eq!(root["node_type"], "group");
        assert!(root["attributes"]["ome"]["multiscales"].is_array());

        // Verify level zarr.json content
        let arr: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("0/zarr.json")).unwrap()).unwrap();
        assert_eq!(arr["zarr_format"], 3);
        assert_eq!(arr["node_type"], "array");
        assert_eq!(arr["data_type"], "uint16");

        // Verify LZ4 codec in metadata
        assert_eq!(arr["codecs"][1]["name"], "numcodecs/lz4");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_zarr_multichannel() {
        let dir = temp_dir("zarr_mc");
        let levels = vec![LevelData {
            data: vec![0u16; 2 * 2 * 4 * 4],
            width: 4,
            height: 4,
            depth: 1,
            channels: 2,
            timepoints: 2,
        }];
        write_zarr(&dir, &levels, &[1, 4, 4]).unwrap();

        assert!(dir.join("0/c/0/0/0/0/0").exists()); // t=0, c=0
        assert!(dir.join("0/c/1/1/0/0/0").exists()); // t=1, c=1

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn chunks_are_lz4_compressed() {
        let dir = temp_dir("zarr_lz4");
        let data: Vec<u16> = (0..16).collect();
        let levels = vec![LevelData {
            data,
            width: 4,
            height: 4,
            depth: 1,
            channels: 1,
            timepoints: 1,
        }];
        write_zarr(&dir, &levels, &[1, 4, 4]).unwrap();

        let chunk_bytes = fs::read(dir.join("0/c/0/0/0/0/0")).unwrap();
        // Should be LZ4 compressed — decompress and verify
        let decompressed = lz4_flex::decompress_size_prepended(&chunk_bytes).unwrap();
        assert_eq!(decompressed.len(), (4 * 4) * 2); // 4x4x1 u16
        assert_eq!(u16::from_le_bytes([decompressed[0], decompressed[1]]), 0);
        assert_eq!(u16::from_le_bytes([decompressed[2], decompressed[3]]), 1);

        let _ = fs::remove_dir_all(&dir);
    }
}
