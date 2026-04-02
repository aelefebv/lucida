use std::path::PathBuf;

use clap::{Parser, Subcommand};
use lucida_store::ingest::pyramid::VoxelSize;
use lucida_store::ingest::tiff_reader::{DimensionHints, DimensionOrder};

/// Convert microscopy data to OME-Zarr v2 multiscale stores.
#[derive(Parser)]
#[command(name = "lucida-store")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Convert a TIFF file to an OME-Zarr multiscale store.
    Convert {
        /// Input TIFF file
        input: PathBuf,

        /// Output .zarr directory
        output: PathBuf,

        /// Chunk size in XY (pixels)
        #[arg(long, default_value_t = 128)]
        chunk_xy: u32,

        /// Chunk size in Z (slices)
        #[arg(long, default_value_t = 128)]
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

        /// Physical voxel size in X (overrides OME-XML)
        #[arg(long)]
        voxel_x: Option<f64>,

        /// Physical voxel size in Y (overrides OME-XML)
        #[arg(long)]
        voxel_y: Option<f64>,

        /// Physical voxel size in Z (overrides OME-XML)
        #[arg(long)]
        voxel_z: Option<f64>,
    },

    /// Convert an HCS TIFF directory to an OME-Zarr plate store.
    Plate {
        /// Input directory containing HCS TIFF files
        /// (filenames like r01c01f01p01-ch01t01.tiff)
        input_dir: PathBuf,

        /// Output .zarr directory
        output: PathBuf,

        /// Chunk size in XY (pixels)
        #[arg(long, default_value_t = 128)]
        chunk_xy: u32,

        /// Chunk size in Z (slices)
        #[arg(long, default_value_t = 128)]
        chunk_z: u32,

        /// Physical voxel size in X (overrides TIFF header)
        #[arg(long)]
        voxel_x: Option<f64>,

        /// Physical voxel size in Y (overrides TIFF header)
        #[arg(long)]
        voxel_y: Option<f64>,

        /// Physical voxel size in Z (overrides TIFF header)
        #[arg(long)]
        voxel_z: Option<f64>,
    },
}

fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Convert {
            input,
            output,
            chunk_xy,
            chunk_z,
            size_t,
            size_c,
            size_z,
            dim_order,
            voxel_x,
            voxel_y,
            voxel_z,
        } => {
            let chunk_size = [chunk_z, chunk_xy, chunk_xy];

            let order = dim_order.map(|s| {
                DimensionOrder::parse(&s).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                })
            });

            let hints = DimensionHints {
                size_t,
                size_c,
                size_z,
                order,
                voxel_size_x: voxel_x,
                voxel_size_y: voxel_y,
                voxel_size_z: voxel_z,
            };

            if let Err(e) =
                lucida_store::ingest::convert_tiff_to_zarr(&input, &output, chunk_size, &hints)
            {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }

        Commands::Plate {
            input_dir,
            output,
            chunk_xy,
            chunk_z,
            voxel_x,
            voxel_y,
            voxel_z,
        } => {
            let chunk_size = [chunk_z, chunk_xy, chunk_xy];

            let voxel_overrides = if voxel_x.is_some() || voxel_y.is_some() || voxel_z.is_some() {
                Some(VoxelSize {
                    x: voxel_x.unwrap_or(1.0),
                    y: voxel_y.unwrap_or(1.0),
                    z: voxel_z.unwrap_or(1.0),
                })
            } else {
                None
            };

            if let Err(e) = lucida_store::ingest::convert_plate_to_zarr(
                &input_dir,
                &output,
                chunk_size,
                voxel_overrides,
            ) {
                eprintln!("Error: {e}");
                std::process::exit(1);
            }
        }
    }
}
