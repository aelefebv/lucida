use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use rayon::prelude::*;
use serde_json::json;

use super::ome_metadata;
use super::pyramid::LevelData;

/// Write a complete OME-Zarr v0.5 (Zarr v3) store to disk.
///
/// `chunk_size` is [Z, Y, X] matching lucida-core convention.
/// Always writes 5D TCZYX with chunk paths `t/c/z/y/x`.
pub fn write_zarr(
    output: &Path,
    levels: &[LevelData],
    chunk_size: &[u32; 3],
) -> Result<(), String> {
    // Default: assume each level is 2x in XY only (legacy behavior)
    let scales: Vec<[f64; 3]> = (0..levels.len())
        .map(|i| {
            let f = (1u32 << i) as f64;
            [f, f, 1.0]
        })
        .collect();
    write_root_metadata(output, levels, &scales)?;

    for (i, level) in levels.iter().enumerate() {
        write_zarr_level(output, i, level, chunk_size)?;
    }

    Ok(())
}

/// Write root group zarr.json with OME multiscales attributes.
///
/// Call this once before writing individual levels.
/// `level_scales` provides per-level cumulative [x, y, z] scale factors.
pub fn write_root_metadata(output: &Path, levels: &[LevelData], level_scales: &[[f64; 3]]) -> Result<(), String> {
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

    let nx = (level.width + cx - 1) / cx;
    let ny = (level.height + cy - 1) / cy;
    let nz = (level.depth + cz - 1) / cz;

    // Collect all chunk indices
    let mut indices = Vec::new();
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

    let total = indices.len();
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
    indices
        .par_iter()
        .try_for_each(|&(ti, ci, zi, yi, xi)| {
            let chunk_path = level_dir
                .join("c")
                .join(ti.to_string())
                .join(ci.to_string())
                .join(zi.to_string())
                .join(yi.to_string())
                .join(xi.to_string());

            let raw = extract_chunk(level, cx, cy, cz, xi, yi, zi, ti, ci);
            let compressed = lz4_flex::compress_prepend_size(&raw);

            fs::write(&chunk_path, &compressed)
                .map_err(|e| format!("failed to write chunk: {e}"))?;

            let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
            if done % 100 == 0 || done == total {
                eprintln!("  level {level_index}: writing chunks {done}/{total}");
            }

            Ok::<(), String>(())
        })?;

    Ok(())
}

/// Extract a single chunk as raw little-endian u16 bytes, zero-padded at edges.
///
/// Data is indexed in TCZYX order.
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
) -> Vec<u8> {
    let mut buf = vec![0u8; (cx * cy * cz * 2) as usize];

    let x_start = xi * cx;
    let y_start = yi * cy;
    let z_start = zi * cz;

    let plane_size = (level.width * level.height) as usize;
    let tc_offset =
        (ti * level.channels * level.depth + ci * level.depth) as usize * plane_size;

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
            let src_offset = tc_offset
                + (gz * level.width * level.height + gy * level.width + x_start) as usize;
            let dst_offset = (lz * cy * cx + ly * cx) as usize * 2;

            for lx in 0..row_len {
                let val = level.data[src_offset + lx as usize];
                let d = dst_offset + (lx as usize) * 2;
                buf[d] = val as u8;
                buf[d + 1] = (val >> 8) as u8;
            }
        }
    }

    buf
}

fn write_json(dir: &Path, name: &str, value: &serde_json::Value) -> Result<(), String> {
    let path = dir.join(name);
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("failed to serialize JSON: {e}"))?;
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
        let bytes = extract_chunk(&level, 4, 4, 1, 0, 0, 0, 0, 0);
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
        let bytes_c0 = extract_chunk(&level, 2, 2, 1, 0, 0, 0, 0, 0);
        assert_eq!(u16::from_le_bytes([bytes_c0[0], bytes_c0[1]]), 1);

        let bytes_c1 = extract_chunk(&level, 2, 2, 1, 0, 0, 0, 0, 1);
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
        assert_eq!(decompressed.len(), 4 * 4 * 1 * 2); // 4x4x1 u16
        assert_eq!(u16::from_le_bytes([decompressed[0], decompressed[1]]), 0);
        assert_eq!(u16::from_le_bytes([decompressed[2], decompressed[3]]), 1);

        let _ = fs::remove_dir_all(&dir);
    }
}
