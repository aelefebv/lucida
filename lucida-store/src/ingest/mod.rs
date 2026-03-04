pub mod ome_metadata;
pub mod pyramid;
pub mod tiff_reader;
pub mod zarr_writer;

use std::path::Path;

use tiff_reader::DimensionHints;

/// Convert a TIFF file to an OME-Zarr v2 store with a multiscale pyramid.
///
/// `chunk_size` is [x, y, z] matching lucida-core convention.
/// Output is always 5D TCZYX.
pub fn convert_tiff_to_zarr(
    input: &Path,
    output: &Path,
    chunk_size: [u32; 3],
    hints: &DimensionHints,
) -> Result<(), String> {
    let volume = tiff_reader::read_tiff(input, hints)?;
    eprintln!(
        "Read TIFF: {}x{}x{}, {} channel(s), {} timepoint(s)",
        volume.width, volume.height, volume.depth, volume.channels, volume.timepoints,
    );

    let levels = pyramid::build_pyramid(
        volume.data,
        volume.width,
        volume.height,
        volume.depth,
        volume.channels,
        volume.timepoints,
        256,
    );
    eprintln!("Built {} pyramid levels", levels.len());
    for (i, level) in levels.iter().enumerate() {
        eprintln!(
            "  level {i}: {}x{}x{}",
            level.width, level.height, level.depth
        );
    }

    zarr_writer::write_zarr(output, &levels, &chunk_size)?;
    eprintln!("Wrote OME-Zarr to {}", output.display());

    Ok(())
}
