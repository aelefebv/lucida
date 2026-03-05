pub mod ome_metadata;
pub mod pyramid;
pub mod tiff_reader;
pub mod zarr_writer;

use std::path::Path;
use std::time::Instant;

use tiff_reader::DimensionHints;

/// Convert a TIFF file to an OME-Zarr v2 store with a multiscale pyramid.
///
/// `chunk_size` is [x, y, z] matching lucida-core convention.
/// Output is always 5D TCZYX.
///
/// Pyramid levels are built and written one at a time, pipelining I/O with
/// downsampling to reduce peak memory and wall-clock time.
pub fn convert_tiff_to_zarr(
    input: &Path,
    output: &Path,
    chunk_size: [u32; 3],
    hints: &DimensionHints,
) -> Result<(), String> {
    let volume = tiff_reader::read_tiff(input, hints)?;
    eprintln!(
        "Read TIFF: {}x{}x{}, {} channel(s), {} timepoint(s), voxel size: ({}, {}, {})",
        volume.width, volume.height, volume.depth, volume.channels, volume.timepoints,
        volume.voxel_size.x, volume.voxel_size.y, volume.voxel_size.z,
    );

    let min_size = 256u32;

    // Compute anisotropy-aware downsample schedule.
    let schedule = pyramid::compute_downsample_schedule(
        volume.width,
        volume.height,
        volume.depth,
        volume.voxel_size,
        min_size,
    );

    // Build lightweight Level structs (no data) for root metadata.
    let meta_levels: Vec<pyramid::Level> = schedule
        .iter()
        .map(|spec| pyramid::Level {
            data: vec![],
            width: spec.width,
            height: spec.height,
            depth: spec.depth,
            channels: volume.channels,
            timepoints: volume.timepoints,
        })
        .collect();

    let level_scales: Vec<[f64; 3]> = schedule.iter().map(|s| s.scale).collect();

    eprintln!("Building {} pyramid levels", schedule.len());
    for (i, spec) in schedule.iter().enumerate() {
        let ds_info = if i == 0 {
            String::new()
        } else {
            format!(
                " ({})",
                match (spec.downsample_xy, spec.downsample_z) {
                    (true, true) => "XYZ",
                    (true, false) => "XY",
                    (false, true) => "Z",
                    (false, false) => "none",
                }
            )
        };
        eprintln!("  level {i}: {}x{}x{}{ds_info}", spec.width, spec.height, spec.depth);
    }

    zarr_writer::write_root_metadata(output, &meta_levels, &level_scales)?;

    // Level-by-level pipeline: write current level (possibly in background)
    // while downsampling to the next level.
    let mut current = pyramid::Level {
        data: volume.data,
        width: volume.width,
        height: volume.height,
        depth: volume.depth,
        channels: volume.channels,
        timepoints: volume.timepoints,
    };

    let num_levels = schedule.len();
    let output_owned = output.to_path_buf();

    for i in 0..num_levels {
        let is_last = i == num_levels - 1;

        if is_last {
            // Last level: just write it directly, no more downsampling needed.
            let t0 = Instant::now();
            zarr_writer::write_zarr_level(&output_owned, i, &current, &chunk_size)?;
            eprintln!("  level {i}: wrote in {}ms", t0.elapsed().as_millis());
        } else {
            // Write current level in a background thread while downsampling.
            let write_level = std::sync::Arc::new(current);
            let write_output = output_owned.clone();
            let write_chunk = chunk_size;
            let write_idx = i;
            let write_ref = write_level.clone();

            let write_handle = std::thread::spawn(move || {
                let t0 = Instant::now();
                let result =
                    zarr_writer::write_zarr_level(&write_output, write_idx, &write_ref, &write_chunk);
                let elapsed = t0.elapsed().as_millis();
                (result, elapsed)
            });

            // Downsample to next level while writing happens.
            let next_spec = &schedule[i + 1];
            let t0 = Instant::now();
            let next = pyramid::downsample(&write_level, next_spec.downsample_xy, next_spec.downsample_z);
            let ds_elapsed = t0.elapsed().as_millis();
            eprintln!("  level {}: downsampled in {}ms", i + 1, ds_elapsed);

            // Wait for the write to finish.
            let (write_result, write_elapsed) = write_handle
                .join()
                .map_err(|_| format!("write thread for level {i} panicked"))?;
            write_result?;
            eprintln!("  level {i}: wrote in {write_elapsed}ms");

            // Drop the Arc; if the write thread is done, current level data is freed.
            drop(write_level);
            current = next;
        }
    }

    eprintln!("Wrote OME-Zarr to {}", output.display());
    Ok(())
}
