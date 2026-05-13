//! Read individual TIFF files for one FOV and assemble into a Volume.
//!
//! Each file in `FovLayout::files` is a single-page TIFF representing one
//! (timepoint, channel, z_plane) slot. Files are decoded in parallel using
//! rayon and copied into the correct position in a pre-allocated TCZYX buffer.

use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicUsize, Ordering};

use rayon::prelude::*;
use tiff::ColorType;
use tiff::decoder::{Decoder, DecodingResult};

use super::plate_scanner::FovLayout;
use super::pyramid::VoxelSize;
use super::tiff_reader::Volume;

/// Read individual TIFF files for one FOV and assemble into a Volume.
///
/// The output buffer is zero-initialized, so any missing `(t, c, z)` slots
/// (not present in `fov.files`) will contain zeros.
///
/// # Errors
///
/// Returns an error if any file has mismatched dimensions or an unsupported
/// color type (anything other than Gray8 or Gray16).
pub fn read_fov_tiffs(
    fov: &FovLayout,
    channels: u32,
    timepoints: u32,
    z_planes: u32,
    image_width: u32,
    image_height: u32,
    voxel_size: VoxelSize,
) -> Result<Volume, String> {
    let pixels_per_plane = (image_width as usize) * (image_height as usize);
    let total_pixels =
        (timepoints as usize) * (channels as usize) * (z_planes as usize) * pixels_per_plane;

    // Pre-allocate zero-initialized buffer in TCZYX order.
    let mut data: Vec<u16> = vec![0u16; total_pixels];

    let entries: Vec<_> = fov.files.iter().collect();
    let total_files = entries.len();
    let progress = AtomicUsize::new(0);

    // Use a raw pointer to allow non-overlapping parallel writes into the buffer.
    let data_ptr = data.as_mut_ptr() as usize;

    let errors: Vec<String> = entries
        .par_iter()
        .filter_map(|((t, c, z), path)| {
            let (t, c, z) = (*t, *c, *z);
            let data_ptr = data_ptr as *mut u16;

            // Open and decode the TIFF file.
            let file = match File::open(path) {
                Ok(f) => f,
                Err(e) => {
                    return Some(format!("failed to open {}: {e}", path.display()));
                }
            };
            let mut decoder = match Decoder::new(BufReader::new(file)) {
                Ok(d) => d,
                Err(e) => {
                    return Some(format!("failed to decode {}: {e}", path.display()));
                }
            };

            // Validate dimensions.
            let (w, h) = match decoder.dimensions() {
                Ok(dims) => dims,
                Err(e) => {
                    return Some(format!(
                        "failed to read dimensions from {}: {e}",
                        path.display()
                    ));
                }
            };
            if w != image_width || h != image_height {
                return Some(format!(
                    "{}: dimensions {w}x{h} do not match expected {image_width}x{image_height}",
                    path.display()
                ));
            }

            // Validate color type.
            let color = match decoder.colortype() {
                Ok(ct) => ct,
                Err(e) => {
                    return Some(format!(
                        "failed to read color type from {}: {e}",
                        path.display()
                    ));
                }
            };
            match color {
                ColorType::Gray(8) | ColorType::Gray(16) => {}
                _ => {
                    return Some(format!(
                        "{}: unsupported color type {color:?} (only Gray8/Gray16)",
                        path.display()
                    ));
                }
            }

            // Read pixel data.
            let image = match decoder.read_image() {
                Ok(img) => img,
                Err(e) => {
                    return Some(format!(
                        "failed to read image data from {}: {e}",
                        path.display()
                    ));
                }
            };

            // Compute buffer offset: t * (C*Z*H*W) + c * (Z*H*W) + z * (H*W)
            let offset =
                (t as usize) * (channels as usize) * (z_planes as usize) * pixels_per_plane
                    + (c as usize) * (z_planes as usize) * pixels_per_plane
                    + (z as usize) * pixels_per_plane;

            match image {
                DecodingResult::U16(pixels) => {
                    if pixels.len() != pixels_per_plane {
                        return Some(format!(
                            "{}: got {} pixels, expected {pixels_per_plane}",
                            path.display(),
                            pixels.len()
                        ));
                    }
                    unsafe {
                        std::ptr::copy_nonoverlapping(
                            pixels.as_ptr(),
                            data_ptr.add(offset),
                            pixels_per_plane,
                        );
                    }
                }
                DecodingResult::U8(pixels) => {
                    if pixels.len() != pixels_per_plane {
                        return Some(format!(
                            "{}: got {} pixels, expected {pixels_per_plane}",
                            path.display(),
                            pixels.len()
                        ));
                    }
                    // Promote u8 to u16: multiply by 257 to map 0..255 → 0..65535.
                    let dst = unsafe {
                        std::slice::from_raw_parts_mut(data_ptr.add(offset), pixels_per_plane)
                    };
                    for (d, &s) in dst.iter_mut().zip(pixels.iter()) {
                        *d = (s as u16) * 257;
                    }
                }
                _ => {
                    return Some(format!("{}: unexpected pixel format", path.display()));
                }
            }

            let count = progress.fetch_add(1, Ordering::Relaxed) + 1;
            if count.is_multiple_of(100) || count == total_files {
                eprintln!("  FOV files: {count}/{total_files}");
            }

            None
        })
        .collect();

    if let Some(err) = errors.into_iter().next() {
        return Err(err);
    }

    Ok(Volume {
        data,
        width: image_width,
        height: image_height,
        depth: z_planes,
        channels,
        timepoints,
        voxel_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::BufWriter;
    use std::path::PathBuf;
    use tiff::encoder::TiffEncoder;
    use tiff::encoder::colortype::Gray16;

    /// Create a single-page Gray16 TIFF file with the given pixel data.
    fn write_test_tiff(path: &PathBuf, width: u32, height: u32, pixels: &[u16]) {
        let file = File::create(path).expect("create test tiff");
        let mut encoder = TiffEncoder::new(BufWriter::new(file)).expect("create tiff encoder");
        encoder
            .write_image::<Gray16>(width, height, pixels)
            .expect("write tiff image");
    }

    #[test]
    fn read_fov_single_plane() {
        let dir = std::env::temp_dir()
            .join(format!("lucida_plate_reader_{}", std::process::id()))
            .join("single");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let width = 4u32;
        let height = 4u32;
        let pixels: Vec<u16> = (1..=16).collect();

        let path = dir.join("t0c0z0.tiff");
        write_test_tiff(&path, width, height, &pixels);

        let mut files = HashMap::new();
        files.insert((0, 0, 0), path);

        let fov = FovLayout { index: 0, files };
        let vol = read_fov_tiffs(&fov, 1, 1, 1, width, height, VoxelSize::default())
            .expect("read_fov_tiffs");

        assert_eq!(vol.width, 4);
        assert_eq!(vol.height, 4);
        assert_eq!(vol.depth, 1);
        assert_eq!(vol.channels, 1);
        assert_eq!(vol.timepoints, 1);
        assert_eq!(vol.data.len(), 16);
        assert_eq!(vol.data, pixels);
    }

    #[test]
    fn read_fov_multiple_planes() {
        let dir = std::env::temp_dir()
            .join(format!("lucida_plate_reader_{}", std::process::id()))
            .join("multi");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let width = 4u32;
        let height = 4u32;
        let channels = 2u32;
        let z_planes = 3u32;
        let timepoints = 1u32;

        let mut files = HashMap::new();

        // Create test files for each (t, c, z) with a distinct fill value.
        for c in 0..channels {
            for z in 0..z_planes {
                let fill_value = (c * z_planes + z + 1) as u16 * 100;
                let pixels: Vec<u16> = vec![fill_value; (width * height) as usize];
                let path = dir.join(format!("t0c{c}z{z}.tiff"));
                write_test_tiff(&path, width, height, &pixels);
                files.insert((0, c, z), path);
            }
        }

        let fov = FovLayout { index: 0, files };
        let vol = read_fov_tiffs(
            &fov,
            channels,
            timepoints,
            z_planes,
            width,
            height,
            VoxelSize::default(),
        )
        .expect("read_fov_tiffs");

        assert_eq!(vol.width, 4);
        assert_eq!(vol.height, 4);
        assert_eq!(vol.depth, 3);
        assert_eq!(vol.channels, 2);
        assert_eq!(vol.timepoints, 1);

        let ppp = (width * height) as usize;
        // Verify each plane has the expected fill value.
        for c in 0..channels {
            for z in 0..z_planes {
                let expected = (c * z_planes + z + 1) as u16 * 100;
                let offset = (c as usize) * (z_planes as usize) * ppp + (z as usize) * ppp;
                let plane = &vol.data[offset..offset + ppp];
                assert!(
                    plane.iter().all(|&v| v == expected),
                    "c={c} z={z}: expected {expected}, got {:?}",
                    &plane[..4]
                );
            }
        }
    }

    #[test]
    fn read_fov_missing_slot_is_zero() {
        let dir = std::env::temp_dir()
            .join(format!("lucida_plate_reader_{}", std::process::id()))
            .join("missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let width = 4u32;
        let height = 4u32;

        // Only provide z=0, leave z=1 missing.
        let pixels: Vec<u16> = vec![42; 16];
        let path = dir.join("t0c0z0.tiff");
        write_test_tiff(&path, width, height, &pixels);

        let mut files = HashMap::new();
        files.insert((0, 0, 0), path);

        let fov = FovLayout { index: 0, files };
        let vol = read_fov_tiffs(&fov, 1, 1, 2, width, height, VoxelSize::default())
            .expect("read_fov_tiffs");

        assert_eq!(vol.depth, 2);
        assert_eq!(vol.data.len(), 32);

        // z=0 should be 42s.
        assert!(vol.data[..16].iter().all(|&v| v == 42));
        // z=1 should be zeros (missing file).
        assert!(vol.data[16..].iter().all(|&v| v == 0));
    }

    #[test]
    fn read_fov_wrong_dimensions_errors() {
        let dir = std::env::temp_dir()
            .join(format!("lucida_plate_reader_{}", std::process::id()))
            .join("wrong_dims");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Write a 2x2 image but tell read_fov_tiffs to expect 4x4.
        let pixels: Vec<u16> = vec![1, 2, 3, 4];
        let path = dir.join("t0c0z0.tiff");
        write_test_tiff(&path, 2, 2, &pixels);

        let mut files = HashMap::new();
        files.insert((0, 0, 0), path);

        let fov = FovLayout { index: 0, files };
        let result = read_fov_tiffs(&fov, 1, 1, 1, 4, 4, VoxelSize::default());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("do not match"));
    }
}
