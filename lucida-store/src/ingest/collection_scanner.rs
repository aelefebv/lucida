//! Scan a directory of tiled TIFF files and discover collection structure.
//!
//! Parses filenames matching `r{row}c{col}f{tile}p{plane}-ch{channel}t{timepoint}.tiff`
//! and builds a `CollectionLayout` describing groups, tiles, channels, timepoints, and Z planes.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use regex::Regex;
use tiff::decoder::Decoder;
use tiff::tags::Tag;

use super::pyramid::VoxelSize;

const MAX_COLLECTION_SCAN_DEPTH: usize = 32;
const MAX_COLLECTION_FILES: usize = 1_000_000;

/// Per-axis collection calibration overrides. `Some(1.0)` is a real override;
/// `None` means retain the value discovered in the source TIFF.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VoxelSizeOverrides {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub z: Option<f64>,
}

fn apply_voxel_overrides(
    discovered: VoxelSize,
    overrides: Option<VoxelSizeOverrides>,
) -> Result<VoxelSize, String> {
    let merged = match overrides {
        Some(overrides) => VoxelSize {
            x: overrides.x.unwrap_or(discovered.x),
            y: overrides.y.unwrap_or(discovered.y),
            z: overrides.z.unwrap_or(discovered.z),
        },
        None => discovered,
    };
    merged.validate()
}

/// Complete collection layout discovered from scanning a directory.
#[derive(Debug)]
pub struct CollectionLayout {
    pub name: String,
    pub rows: Vec<String>,
    pub columns: Vec<String>,
    pub groups: Vec<GroupLayout>,
    pub channels: u32,
    pub timepoints: u32,
    pub z_planes: u32,
    pub image_width: u32,
    pub image_height: u32,
    pub voxel_size: VoxelSize,
}

/// A single group in the collection layout.
#[derive(Debug)]
pub struct GroupLayout {
    pub row_name: String,
    pub col_name: String,
    pub row_index: u32,
    pub col_index: u32,
    pub tiles: Vec<TileLayout>,
}

/// A single tile within a group.
#[derive(Debug)]
pub struct TileLayout {
    pub index: u32,
    /// Maps (timepoint, channel, z_plane) → file path. All 0-indexed.
    pub files: HashMap<(u32, u32, u32), PathBuf>,
}

/// Parsed components from a single TIFF filename.
#[derive(Debug)]
struct ParsedFilename {
    row: u32,
    col: u32,
    tile: u32,
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

/// Scan a directory for tiled TIFF files and build a CollectionLayout.
///
/// Recursively searches for files matching the `rXXcXXfXXpXX-chXXtXX.tiff` pattern.
/// Voxel size is extracted from the first TIFF's resolution tag; `voxel_overrides`
/// take precedence if provided.
pub fn scan_collection_directory(
    dir: &Path,
    voxel_overrides: Option<VoxelSizeOverrides>,
) -> Result<CollectionLayout, String> {
    let re = Regex::new(r"(?i)r(\d+)c(\d+)f(\d+)p(\d+)-ch(\d+)t(\d+)\.tiff?$")
        .map_err(|e| format!("regex error: {e}"))?;

    // Recursively find all matching files.
    let mut parsed_files = Vec::new();
    let mut visited_entries = 0usize;
    scan_recursive(dir, &re, &mut parsed_files, 0, &mut visited_entries)?;
    parsed_files.sort_by(|left, right| left.path.cmp(&right.path));

    if parsed_files.is_empty() {
        return Err(format!(
            "no tiled TIFF files found in {}. Expected filenames like r01c01f01p01-ch01t01.tiff",
            dir.display()
        ));
    }

    eprintln!("Found {} tiled TIFF files", parsed_files.len());

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

    let channels = u32::try_from(all_channels.len())
        .map_err(|_| "collection has too many distinct channels".to_string())?;
    let timepoints = u32::try_from(all_timepoints.len())
        .map_err(|_| "collection has too many distinct timepoints".to_string())?;
    let z_planes = u32::try_from(all_planes.len())
        .map_err(|_| "collection has too many distinct planes".to_string())?;

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

    // Group files by (row, col) → (tile) → files.
    // Use BTreeMap for sorted key ordering.
    let mut group_map: BTreeMap<(u32, u32), BTreeMap<u32, Vec<&ParsedFilename>>> = BTreeMap::new();
    for pf in &parsed_files {
        group_map
            .entry((pf.row, pf.col))
            .or_default()
            .entry(pf.tile)
            .or_default()
            .push(pf);
    }

    // Build GroupLayout structs.
    let mut groups = Vec::new();
    for (&(row, col), tile_map) in &group_map {
        let row_name = row_number_to_letter(row);
        let col_name = col.to_string();
        let ri = row_index_map[&row];
        let ci = col_index_map[&col];

        let mut tiles = Vec::new();
        for (&tile, files) in tile_map {
            let tile_index = tile
                .checked_sub(1)
                .ok_or_else(|| "collection tile number must be one-based".to_string())?;
            let mut file_map = HashMap::new();
            for pf in files {
                let t = timepoint_index[&pf.timepoint];
                let c = channel_index[&pf.channel];
                let z = plane_index[&pf.plane];
                match file_map.entry((t, c, z)) {
                    Entry::Vacant(slot) => {
                        slot.insert(pf.path.clone());
                    }
                    Entry::Occupied(existing) => {
                        return Err(format!(
                            "duplicate collection slot row={row}, col={col}, tile={tile}, t={}, c={}, z={}: {} and {}",
                            pf.timepoint,
                            pf.channel,
                            pf.plane,
                            existing.get().display(),
                            pf.path.display()
                        ));
                    }
                }
            }
            tiles.push(TileLayout {
                index: tile_index,
                files: file_map,
            });
        }
        tiles.sort_by_key(|f| f.index);

        groups.push(GroupLayout {
            row_name,
            col_name,
            row_index: ri,
            col_index: ci,
            tiles,
        });
    }

    // Read image dimensions and voxel size from the first TIFF.
    let first_path = &parsed_files[0].path;
    let (image_width, image_height, tiff_voxel) = read_tiff_info(first_path)?;

    // Apply overrides.
    let voxel_size = apply_voxel_overrides(tiff_voxel, voxel_overrides)?;

    // Derive collection name from directory.
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("collection")
        .to_string();

    Ok(CollectionLayout {
        name,
        rows,
        columns,
        groups,
        channels,
        timepoints,
        z_planes,
        image_width,
        image_height,
        voxel_size,
    })
}

/// Recursively scan a directory for files matching the tiled pattern.
fn scan_recursive(
    dir: &Path,
    re: &Regex,
    results: &mut Vec<ParsedFilename>,
    depth: usize,
    visited_entries: &mut usize,
) -> Result<(), String> {
    if depth > MAX_COLLECTION_SCAN_DEPTH {
        return Err(format!(
            "collection directory nesting exceeds {MAX_COLLECTION_SCAN_DEPTH} levels"
        ));
    }
    let mut entries = fs::read_dir(dir)
        .map_err(|e| format!("failed to read directory {}: {e}", dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("directory entry error: {e}"))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        *visited_entries = visited_entries
            .checked_add(1)
            .ok_or_else(|| "collection directory entry count overflow".to_string())?;
        if *visited_entries > MAX_COLLECTION_FILES {
            return Err(format!(
                "collection scan exceeds {MAX_COLLECTION_FILES} filesystem entries"
            ));
        }
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("failed to inspect {}: {e}", path.display()))?;

        if file_type.is_symlink() {
            return Err(format!(
                "collection scan refuses symbolic link {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            scan_recursive(&path, re, results, depth + 1, visited_entries)?;
        } else if let Some(filename) = path.file_name().and_then(|n| n.to_str())
            && let Some(caps) = re.captures(filename)
        {
            let parse_one_based = |index: usize, label: &str| -> Result<u32, String> {
                let raw = &caps[index];
                let value = raw.parse::<u32>().map_err(|_| {
                    format!("{filename}: {label} value {raw:?} exceeds the u32 range")
                })?;
                if value == 0 {
                    return Err(format!("{filename}: {label} must be one-based"));
                }
                Ok(value)
            };
            let row = parse_one_based(1, "row")?;
            let col = parse_one_based(2, "column")?;
            let tile = parse_one_based(3, "tile")?;
            let plane = parse_one_based(4, "plane")?;
            let channel = parse_one_based(5, "channel")?;
            let timepoint = parse_one_based(6, "timepoint")?;

            results.push(ParsedFilename {
                row,
                col,
                tile,
                plane,
                channel,
                timepoint,
                path,
            });
            if results.len() > MAX_COLLECTION_FILES {
                return Err(format!(
                    "collection contains more than {MAX_COLLECTION_FILES} matching TIFF files"
                ));
            }
        }
    }

    Ok(())
}

/// Read image dimensions and voxel size from a TIFF file.
fn read_tiff_info(path: &Path) -> Result<(u32, u32, VoxelSize), String> {
    let file =
        fs::File::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut decoder = Decoder::new(&mut reader)
        .map_err(|e| format!("failed to decode {}: {e}", path.display()))?;

    let (width, height) = decoder
        .dimensions()
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
        if let Ok(x_res_val) = decoder.get_tag(Tag::XResolution)
            && let Ok(x_res_vec) = x_res_val.into_u32_vec()
            && x_res_vec.len() >= 2
            && x_res_vec[1] > 0
        {
            let px_per_unit = x_res_vec[0] as f64 / x_res_vec[1] as f64;
            if px_per_unit > 0.0 {
                voxel.x = match res_unit {
                    2 => 25400.0 / px_per_unit, // inch → µm
                    3 => 10000.0 / px_per_unit, // cm → µm
                    _ => 1.0,
                };
            }
        }
        if let Ok(y_res_val) = decoder.get_tag(Tag::YResolution)
            && let Ok(y_res_vec) = y_res_val.into_u32_vec()
            && y_res_vec.len() >= 2
            && y_res_vec[1] > 0
        {
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

    // Z defaults to 1.0 for collection data (no Z resolution in individual TIFFs).

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
            .join(format!("lucida_collection_scan_{}", std::process::id()))
            .join("empty");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let result = scan_collection_directory(&dir, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no tiled TIFF files found"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_logical_slot_is_rejected_deterministically() {
        let dir = std::env::temp_dir()
            .join(format!("lucida_collection_scan_{}", std::process::id()))
            .join("duplicate_slot");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("r1c1f1p1-ch1t1.tiff"), []).unwrap();
        std::fs::write(dir.join("r01c01f01p01-ch01t01.tiff"), []).unwrap();

        let error = scan_collection_directory(&dir, None).unwrap_err();
        assert!(error.contains("duplicate collection slot"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zero_based_filename_component_is_rejected_without_underflow() {
        let dir = std::env::temp_dir()
            .join(format!("lucida_collection_scan_{}", std::process::id()))
            .join("zero_component");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("r1c1f0p1-ch1t1.tiff"), []).unwrap();

        let error = scan_collection_directory(&dir, None).unwrap_err();
        assert!(error.contains("tile must be one-based"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn collection_scan_refuses_symlink_recursion() {
        use std::os::unix::fs::symlink;

        let dir = std::env::temp_dir()
            .join(format!("lucida_collection_scan_{}", std::process::id()))
            .join("symlink");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        symlink(&dir, dir.join("loop")).unwrap();

        let error = scan_collection_directory(&dir, None).unwrap_err();
        assert!(error.contains("refuses symbolic link"), "{error}");
        let _ = std::fs::remove_file(dir.join("loop"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn explicit_unit_override_is_not_treated_as_missing() {
        let discovered = VoxelSize {
            x: 0.25,
            y: 0.5,
            z: 2.0,
        };
        let merged = apply_voxel_overrides(
            discovered,
            Some(VoxelSizeOverrides {
                x: Some(1.0),
                y: None,
                z: None,
            }),
        )
        .unwrap();
        assert_eq!(merged.x, 1.0);
        assert_eq!(merged.y, 0.5);
        assert_eq!(merged.z, 2.0);
    }
}
