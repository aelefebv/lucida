use std::path::PathBuf;

use clap::Parser;
use lucida_store::tiff_reader::{DimensionHints, DimensionOrder};

/// Convert a TIFF file to an OME-Zarr v2 multiscale store.
#[derive(Parser)]
#[command(name = "lucida-store")]
struct Args {
    /// Input TIFF file
    input: PathBuf,

    /// Output .zarr directory
    output: PathBuf,

    /// Chunk size in XY (pixels)
    #[arg(long, default_value_t = 256)]
    chunk_xy: u32,

    /// Chunk size in Z (slices)
    #[arg(long, default_value_t = 1)]
    chunk_z: u32,

    /// Number of timepoints (overrides OME-XML autodetection)
    #[arg(long)]
    size_t: Option<u32>,

    /// Number of channels (overrides OME-XML autodetection)
    #[arg(long)]
    size_c: Option<u32>,

    /// Number of Z slices (overrides OME-XML autodetection)
    #[arg(long)]
    size_z: Option<u32>,

    /// Dimension order: XYZCT, XYCZT, XYZTC, XYCTZ, XYTCZ, XYTZC
    /// (overrides OME-XML autodetection)
    #[arg(long)]
    dim_order: Option<String>,
}

fn main() {
    let args = Args::parse();
    let chunk_size = [args.chunk_xy, args.chunk_xy, args.chunk_z];

    let order = args
        .dim_order
        .map(|s| DimensionOrder::parse(&s).unwrap_or_else(|e| {
            eprintln!("Error: {e}");
            std::process::exit(1);
        }));

    let hints = DimensionHints {
        size_t: args.size_t,
        size_c: args.size_c,
        size_z: args.size_z,
        order,
    };

    if let Err(e) = lucida_store::convert_tiff_to_zarr(&args.input, &args.output, chunk_size, &hints) {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}
