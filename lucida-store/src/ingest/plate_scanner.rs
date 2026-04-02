/// Scan a directory of HCS TIFF files and discover plate structure.
///
/// Parses filenames matching `r{row}c{col}f{field}p{plane}-ch{channel}t{timepoint}.tiff`
/// and builds a `PlateLayout` describing wells, FOVs, channels, timepoints, and Z planes.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use regex::Regex;
use tiff::decoder::Decoder;
use tiff::tags::Tag;

use super::pyramid::VoxelSize;

/// Complete plate layout discovered from scanning a directory.
#[derive(Debug)]
pub struct PlateLayout {
    pub name: String,
    pub rows: Vec<String>,
    pub columns: Vec<String>,
    pub wells: Vec<WellLayout>,
    pub channels: u32,
    pub timepoints: u32,
    pub z_planes: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub voxel_size: VoxelSize,
}

/// A single well in the plate layout.
#[derive(Debug)]
pub struct WellLayout {
    pub row_name: String,
    pub col_name: String,
    pub row_index: u32,
    pub col_index: u32,
    pub fovs: Vec<FovLayout>,
}

/// A single FOV within a well.
#[derive(Debug)]
pub struct FovLayout {
    pub index: u32,
    /// Maps (timepoint, channel, z_plane) → file path. All 0-indexed.
    pub files: HashMap<(u32, u32, u32), PathBuf>,
}

/// Parsed components from a single TIFF filename.
#[derive(Debug)]
struct ParsedFilename {
    row: u32,
    col: u32,
    field: u32,
    plane: u32,
    channel: u32,
    timepoint: u32,
    path: PathBuf,
}

/// Convert a 1-based row number to a letter (1→A, 2→B, ..., 26→Z).
pub fn row_number_to_letter(n: u32) -> String {
    if n == 0 || n > 26 {
        return format!("R{n}");
    }
    char::from(b'A' + (n - 1) as u8).to_string()
}

/// Scan a directory for HCS TIFF files and build a PlateLayout.
///
/// Recursively searches for files matching the `rXXcXXfXXpXX-chXXtXX.tiff` pattern.
/// Voxel size is extracted from the first TIFF's resolution tag; `voxel_overrides`
/// take precedence if provided.
pub fn scan_plate_directory(
    dir: &Path,
    voxel_overrides: Option<VoxelSize>,
) -> Result<PlateLayout, String> {
    let re = Regex::new(r"(?i)r(\d+)c(\d+)f(\d+)p(\d+)-ch(\d+)t(\d+)\.tiff?$")
        .map_err(|e| format!("regex error: {e}"))?;

    // Recursively find all matching files.
    let mut parsed_files = Vec::new();
    scan_recursive(dir, &re, &mut parsed_files)?;

    if parsed_files.is_empty() {
        return Err(format!(
            "no HCS TIFF files found in {}. Expected filenames like r01c01f01p01-ch01t01.tiff",
            dir.display()
        ));
    }

    eprintln!("Found {} HCS TIFF files", parsed_files.len());

    // Discover unique values for each dimension.
    let mut all_rows = BTreeSet::new();
    let mut all_cols = BTreeSet::new();
    let mut all_channels = BTreeSet::new();
    let mut all_timepoints = BTreeSet::new();
    let mut all_planes = BTreeSet::new();

    for pf in &parsed_files {
        all_rows.insert(pf.row);
        all_cols.insert(pf.col);
        all_channels.insert(pf.channel);
        all_timepoints.insert(pf.timepoint);
        all_planes.insert(pf.plane);
    }

    let channels = all_channels.len() as u32;
    let timepoints = all_timepoints.len() as u32;
    let z_planes = all_planes.len() as u32;

    // Build row/column name lists.
    let rows: Vec<String> = all_rows.iter().map(|&r| row_number_to_letter(r)).collect();
    let columns: Vec<String> = all_cols.iter().map(|&c| c.to_string()).collect();

    // Build index maps for row/column → list index.
    let row_index_map: HashMap<u32, u32> = all_rows
        .iter()
        .enumerate()
        .map(|(i, &r)| (r, i as u32))
        .collect();
    let col_index_map: HashMap<u32, u32> = all_cols
        .iter()
        .enumerate()
        .map(|(i, &c)| (c, i as u32))
        .collect();

    // Build 0-indexed maps for channels, timepoints, planes.
    let channel_index: HashMap<u32, u32> = all_channels
        .iter()
        .enumerate()
        .map(|(i, &c)| (c, i as u32))
        .collect();
    let timepoint_index: HashMap<u32, u32> = all_timepoints
        .iter()
        .enumerate()
        .map(|(i, &t)| (t, i as u32))
        .collect();
    let plane_index: HashMap<u32, u32> = all_planes
        .iter()
        .enumerate()
        .map(|(i, &p)| (p, i as u32))
        .collect();

    // Group files by (row, col) → (field) → files.
    // Use BTreeMap for sorted key ordering.
    let mut well_map: BTreeMap<(u32, u32), BTreeMap<u32, Vec<&ParsedFilename>>> = BTreeMap::new();
    for pf in &parsed_files {
        well_map
            .entry((pf.row, pf.col))
            .or_default()
            .entry(pf.field)
            .or_default()
            .push(pf);
    }

    // Build WellLayout structs.
    let mut wells = Vec::new();
    for (&(row, col), fov_map) in &well_map {
        let row_name = row_number_to_letter(row);
        let col_name = col.to_string();
        let ri = row_index_map[&row];
        let ci = col_index_map[&col];

        let mut fovs = Vec::new();
        for (&field, files) in fov_map {
            let fov_index = field - 1; // 1-indexed → 0-indexed
            let mut file_map = HashMap::new();
            for pf in files {
                let t = timepoint_index[&pf.timepoint];
                let c = channel_index[&pf.channel];
                let z = plane_index[&pf.plane];
                file_map.insert((t, c, z), pf.path.clone());
            }
            fovs.push(FovLayout {
                index: fov_index,
                files: file_map,
            });
        }
        fovs.sort_by_key(|f| f.index);

        wells.push(WellLayout {
            row_name,
            col_name,
            row_index: ri,
            col_index: ci,
            fovs,
        });
    }

    // Read image dimensions and voxel size from the first TIFF.
    let first_path = &parsed_files[0].path;
    let (image_width, image_height, tiff_voxel) = read_tiff_info(first_path)?;

    // Apply overrides.
    let voxel_size = match voxel_overrides {
        Some(v) => VoxelSize {
            x: if v.x != 1.0 { v.x } else { tiff_voxel.x },
            y: if v.y != 1.0 { v.y } else { tiff_voxel.y },
            z: if v.z != 1.0 { v.z } else { tiff_voxel.z },
        },
        None => tiff_voxel,
    };

    // Derive plate name from directory.
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("plate")
        .to_string();

    Ok(PlateLayout {
        name,
        rows,
        columns,
        wells,
        channels,
        timepoints,
        z_planes,
        image_width,
        image_height,
        voxel_size,
    })
}

/// Recursively scan a directory for files matching the HCS pattern.
fn scan_recursive(
    dir: &Path,
    re: &Regex,
    results: &mut Vec<ParsedFilename>,
) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("failed to read directory {}: {e}", dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("directory entry error: {e}"))?;
        let path = entry.path();

        if path.is_dir() {
            scan_recursive(&path, re, results)?;
        } else if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
            if let Some(caps) = re.captures(filename) {
                let row: u32 = caps[1].parse().unwrap();
                let col: u32 = caps[2].parse().unwrap();
                let field: u32 = caps[3].parse().unwrap();
                let plane: u32 = caps[4].parse().unwrap();
                let channel: u32 = caps[5].parse().unwrap();
                let timepoint: u32 = caps[6].parse().unwrap();

                results.push(ParsedFilename {
                    row,
                    col,
                    field,
                    plane,
                    channel,
                    timepoint,
                    path,
                });
            }
        }
    }

    Ok(())
}

/// Read image dimensions and voxel size from a TIFF file.
fn read_tiff_info(path: &Path) -> Result<(u32, u32, VoxelSize), String> {
    let file = fs::File::open(path)
        .map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut decoder = Decoder::new(&mut reader)
        .map_err(|e| format!("failed to decode {}: {e}", path.display()))?;

    let (width, height) = decoder.dimensions()
        .map_err(|e| format!("failed to read dimensions from {}: {e}", path.display()))?;

    // Try to extract resolution for voxel size.
    let mut voxel = VoxelSize::default();

    // Read resolution unit and X/Y resolution tags.
    // ResolutionUnit: 1=no unit, 2=inch, 3=cm
    let res_unit = decoder
        .get_tag(Tag::ResolutionUnit)
        .ok()
        .and_then(|v| v.into_u32().ok())
        .unwrap_or(1);

    if res_unit > 1 {
        // Try to read XResolution (rational: numerator/denominator).
        if let Ok(x_res_val) = decoder.get_tag(Tag::XResolution) {
            if let Ok(x_res_vec) = x_res_val.into_u32_vec() {
                if x_res_vec.len() >= 2 && x_res_vec[1] > 0 {
                    let px_per_unit = x_res_vec[0] as f64 / x_res_vec[1] as f64;
                    if px_per_unit > 0.0 {
                        voxel.x = match res_unit {
                            2 => 25400.0 / px_per_unit, // inch → µm
                            3 => 10000.0 / px_per_unit, // cm → µm
                            _ => 1.0,
                        };
                    }
                }
            }
        }
        if let Ok(y_res_val) = decoder.get_tag(Tag::YResolution) {
            if let Ok(y_res_vec) = y_res_val.into_u32_vec() {
                if y_res_vec.len() >= 2 && y_res_vec[1] > 0 {
                    let px_per_unit = y_res_vec[0] as f64 / y_res_vec[1] as f64;
                    if px_per_unit > 0.0 {
                        voxel.y = match res_unit {
                            2 => 25400.0 / px_per_unit,
                            3 => 10000.0 / px_per_unit,
                            _ => 1.0,
                        };
                    }
                }
            }
        }
    }

    // Z defaults to 1.0 for plate data (no Z resolution in individual TIFFs).

    // Seek back to start for potential reuse.
    let _ = reader.seek(SeekFrom::Start(0));

    Ok((width, height, voxel))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_number_conversion() {
        assert_eq!(row_number_to_letter(1), "A");
        assert_eq!(row_number_to_letter(5), "E");
        assert_eq!(row_number_to_letter(26), "Z");
        assert_eq!(row_number_to_letter(0), "R0");
        assert_eq!(row_number_to_letter(27), "R27");
    }

    #[test]
    fn regex_matches_expected_filenames() {
        let re = Regex::new(r"(?i)r(\d+)c(\d+)f(\d+)p(\d+)-ch(\d+)t(\d+)\.tiff?$").unwrap();
        assert!(re.is_match("r05c04f01p01-ch01t01.tiff"));
        assert!(re.is_match("r05c04f01p01-ch01t01.TIFF"));
        assert!(re.is_match("r05c04f01p01-ch01t01.tif"));
        assert!(re.is_match("r1c1f1p1-ch1t1.tiff"));
        assert!(!re.is_match("image.tiff"));
        assert!(!re.is_match("r05c04.tiff"));
    }

    #[test]
    fn regex_captures_values() {
        let re = Regex::new(r"(?i)r(\d+)c(\d+)f(\d+)p(\d+)-ch(\d+)t(\d+)\.tiff?$").unwrap();
        let caps = re.captures("r05c10f02p01-ch03t112.tiff").unwrap();
        assert_eq!(&caps[1], "05");
        assert_eq!(&caps[2], "10");
        assert_eq!(&caps[3], "02");
        assert_eq!(&caps[4], "01");
        assert_eq!(&caps[5], "03");
        assert_eq!(&caps[6], "112");
    }

    #[test]
    fn scan_empty_directory() {
        let dir = std::env::temp_dir()
            .join(format!("lucida_plate_scan_{}", std::process::id()))
            .join("empty");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let result = scan_plate_directory(&dir, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no HCS TIFF files found"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
