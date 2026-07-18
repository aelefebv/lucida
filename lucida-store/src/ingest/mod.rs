pub mod collection_metadata;
pub mod collection_reader;
pub mod collection_scanner;
pub mod ome_metadata;
pub mod pyramid;
pub mod tiff_reader;
pub mod zarr_writer;

use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use tiff_reader::DimensionHints;

static STAGING_COUNTER: AtomicU64 = AtomicU64::new(0);

trait PublicationOps {
    fn sync_tree(&self, root: &Path) -> std::io::Result<()>;
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    fn sync_directory(&self, directory: &Path) -> std::io::Result<()>;
}

struct RealPublicationOps;

impl PublicationOps for RealPublicationOps {
    fn sync_tree(&self, root: &Path) -> std::io::Result<()> {
        sync_tree(root)
    }

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)
    }

    fn sync_directory(&self, directory: &Path) -> std::io::Result<()> {
        std::fs::File::open(directory)?.sync_all()
    }
}

/// Flush every staged file and directory before the publication rename.
/// Writers own the staging tree, so symlinks are rejected instead of followed.
fn sync_tree(root: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "staging output contains unexpected symlink {}",
                    entry.path().display()
                ),
            ));
        }
        if file_type.is_dir() {
            sync_tree(&entry.path())?;
        } else if file_type.is_file() {
            std::fs::File::open(entry.path())?.sync_all()?;
        }
    }
    std::fs::File::open(root)?.sync_all()
}

/// Same-filesystem staging directory for atomic dataset publication.
/// Incomplete metadata/chunks are never visible at the requested output path;
/// dropping after any error removes the private staging tree.
pub(super) struct AtomicOutput {
    final_path: PathBuf,
    staging_path: PathBuf,
    committed: bool,
}

impl AtomicOutput {
    pub(super) fn begin(final_path: &Path) -> Result<Self, String> {
        if final_path.exists() {
            return Err(format!(
                "refusing to replace existing output {}",
                final_path.display()
            ));
        }
        let parent = final_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create output parent {}: {e}", parent.display()))?;
        let name = final_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "output path must have a UTF-8 file name".to_string())?;

        for _ in 0..100 {
            let counter = STAGING_COUNTER.fetch_add(1, Ordering::Relaxed);
            let staging_path = parent.join(format!(
                ".{name}.lucida-staging.{}.{}",
                std::process::id(),
                counter
            ));
            match std::fs::create_dir(&staging_path) {
                Ok(()) => {
                    return Ok(Self {
                        final_path: final_path.to_path_buf(),
                        staging_path,
                        committed: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "failed to create staging output {}: {error}",
                        staging_path.display()
                    ));
                }
            }
        }
        Err("failed to allocate a unique staging output directory".to_string())
    }

    pub(super) fn path(&self) -> &Path {
        &self.staging_path
    }

    pub(super) fn commit(self) -> Result<(), String> {
        self.commit_with(&RealPublicationOps)
    }

    fn commit_with(mut self, operations: &impl PublicationOps) -> Result<(), String> {
        operations.sync_tree(&self.staging_path).map_err(|error| {
            format!(
                "failed to durably flush staged output {}: {error}",
                self.staging_path.display()
            )
        })?;
        operations
            .rename(&self.staging_path, &self.final_path)
            .map_err(|error| {
                format!(
                    "failed to publish {} atomically: {error}",
                    self.final_path.display()
                )
            })?;
        // From this point on the complete final tree is public. A parent
        // directory sync failure must be reported, but Drop must not try to
        // remove a staging path that was already renamed.
        self.committed = true;
        if let Some(parent) = self.final_path.parent() {
            operations.sync_directory(parent).map_err(|error| {
                format!(
                    "published {} atomically but failed to durably sync parent directory: {error}",
                    self.final_path.display()
                )
            })?;
        }
        Ok(())
    }
}

impl Drop for AtomicOutput {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_dir_all(&self.staging_path);
        }
    }
}

/// Convert a TIFF file to an OME-Zarr v2 store with a multiscale pyramid.
///
/// `chunk_size` is [Z, Y, X] matching lucida-core convention.
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
    let publication = AtomicOutput::begin(output)?;
    let staged_output = publication.path();
    let volume = tiff_reader::read_tiff(input, hints)?;
    volume.voxel_size.validate()?;
    eprintln!(
        "Read TIFF: {}x{}x{}, {} channel(s), {} timepoint(s), voxel size: ({}, {}, {})",
        volume.width,
        volume.height,
        volume.depth,
        volume.channels,
        volume.timepoints,
        volume.voxel_size.x,
        volume.voxel_size.y,
        volume.voxel_size.z,
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

    // Build lightweight LevelData structs (no data) for root metadata.
    let meta_levels: Vec<pyramid::LevelData> = schedule
        .iter()
        .map(|spec| pyramid::LevelData {
            data: vec![],
            width: spec.width,
            height: spec.height,
            depth: spec.depth,
            channels: volume.channels,
            timepoints: volume.timepoints,
        })
        .collect();

    let level_scales: Vec<[f64; 3]> = schedule
        .iter()
        .map(|spec| volume.voxel_size.physical_scale(spec.scale))
        .collect::<Result<_, _>>()?;

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
        eprintln!(
            "  level {i}: {}x{}x{}{ds_info}",
            spec.width, spec.height, spec.depth
        );
    }

    zarr_writer::write_root_metadata(staged_output, &meta_levels, &level_scales)?;

    // Level-by-level pipeline: write current level (possibly in background)
    // while downsampling to the next level.
    let mut current = pyramid::LevelData {
        data: volume.data,
        width: volume.width,
        height: volume.height,
        depth: volume.depth,
        channels: volume.channels,
        timepoints: volume.timepoints,
    };

    let num_levels = schedule.len();
    let output_owned = staged_output.to_path_buf();

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
                let result = zarr_writer::write_zarr_level(
                    &write_output,
                    write_idx,
                    &write_ref,
                    &write_chunk,
                );
                let elapsed = t0.elapsed().as_millis();
                (result, elapsed)
            });

            // Downsample to next level while writing happens.
            let next_spec = &schedule[i + 1];
            let t0 = Instant::now();
            let next = pyramid::downsample(
                &write_level,
                next_spec.downsample_xy,
                next_spec.downsample_z,
            );
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

    publication.commit()?;
    eprintln!("Wrote OME-Zarr to {}", output.display());
    Ok(())
}

/// Convert a tiled TIFF directory to an OME-Zarr v0.5 store.
///
/// Scans `input_dir` for TIFF files matching `rXXcXXfXXpXX-chXXtXX.tiff`,
/// discovers the collection structure, then converts each tile into a multiscale
/// pyramid under the standard collection hierarchy: `{row}/{col}/{tile}/`.
///
/// `chunk_size` is [Z, Y, X] matching lucida-core convention.
/// `voxel_overrides` optionally overrides voxel sizes read from TIFF headers.
pub fn convert_collection_to_zarr(
    input_dir: &Path,
    output: &Path,
    chunk_size: [u32; 3],
    voxel_overrides: Option<collection_scanner::VoxelSizeOverrides>,
) -> Result<(), String> {
    let publication = AtomicOutput::begin(output)?;
    let staged_output = publication.path();
    let layout = collection_scanner::scan_collection_directory(input_dir, voxel_overrides)?;
    layout.voxel_size.validate()?;

    eprintln!(
        "Collection: {} ({} rows x {} cols, {} groups)",
        layout.name,
        layout.rows.len(),
        layout.columns.len(),
        layout.groups.len(),
    );
    eprintln!(
        "  Image: {}x{}, {} channel(s), {} timepoint(s), {} Z plane(s)",
        layout.image_width,
        layout.image_height,
        layout.channels,
        layout.timepoints,
        layout.z_planes,
    );
    eprintln!(
        "  Voxel size: ({}, {}, {})",
        layout.voxel_size.x, layout.voxel_size.y, layout.voxel_size.z,
    );

    // Write collection-level metadata.
    collection_metadata::write_collection_metadata(staged_output, &layout)?;

    let total_tiles: usize = layout.groups.iter().map(|w| w.tiles.len()).sum();
    let mut tile_count = 0usize;

    for group in &layout.groups {
        eprintln!(
            "Processing group {}/{} ({} tiles)",
            group.row_name,
            group.col_name,
            group.tiles.len(),
        );

        // Write group-level metadata.
        collection_metadata::write_group_metadata(staged_output, group)?;

        for (tile_idx, tile) in group.tiles.iter().enumerate() {
            tile_count += 1;
            eprintln!(
                "  tile {tile_idx} ({tile_count}/{total_tiles}): reading {} files...",
                tile.files.len(),
            );

            // Read all TIFF files for this tile into a Volume.
            let volume = collection_reader::read_tile_tiffs(
                tile,
                layout.channels,
                layout.timepoints,
                layout.z_planes,
                layout.image_width,
                layout.image_height,
                layout.voxel_size,
            )?;

            // Build tile output path: {output}/{row}/{col}/{tile_idx}/
            let tile_output = staged_output
                .join(&group.row_name)
                .join(&group.col_name)
                .join(tile_idx.to_string());

            // Build pyramid and write as a standalone OME-Zarr image.
            write_volume_pyramid(&tile_output, volume, &chunk_size)?;
        }
    }

    publication.commit()?;
    eprintln!(
        "Wrote OME-Zarr collection to {} ({} groups, {} tiles)",
        output.display(),
        layout.groups.len(),
        tile_count,
    );
    Ok(())
}

/// Write a Volume as a multiscale pyramid OME-Zarr store.
///
/// This is a shared helper used by both single-TIFF and collection pipelines.
fn write_volume_pyramid(
    output: &Path,
    volume: tiff_reader::Volume,
    chunk_size: &[u32; 3],
) -> Result<(), String> {
    volume.voxel_size.validate()?;
    let min_size = 256u32;

    let schedule = pyramid::compute_downsample_schedule(
        volume.width,
        volume.height,
        volume.depth,
        volume.voxel_size,
        min_size,
    );

    let meta_levels: Vec<pyramid::LevelData> = schedule
        .iter()
        .map(|spec| pyramid::LevelData {
            data: vec![],
            width: spec.width,
            height: spec.height,
            depth: spec.depth,
            channels: volume.channels,
            timepoints: volume.timepoints,
        })
        .collect();

    let level_scales: Vec<[f64; 3]> = schedule
        .iter()
        .map(|spec| volume.voxel_size.physical_scale(spec.scale))
        .collect::<Result<_, _>>()?;

    zarr_writer::write_root_metadata(output, &meta_levels, &level_scales)?;

    let mut current = pyramid::LevelData {
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
            let t0 = Instant::now();
            zarr_writer::write_zarr_level(&output_owned, i, &current, chunk_size)?;
            eprintln!("    level {i}: wrote in {}ms", t0.elapsed().as_millis());
        } else {
            let write_level = std::sync::Arc::new(current);
            let write_output = output_owned.clone();
            let write_chunk = *chunk_size;
            let write_idx = i;
            let write_ref = write_level.clone();

            let write_handle = std::thread::spawn(move || {
                let t0 = Instant::now();
                let result = zarr_writer::write_zarr_level(
                    &write_output,
                    write_idx,
                    &write_ref,
                    &write_chunk,
                );
                let elapsed = t0.elapsed().as_millis();
                (result, elapsed)
            });

            let next_spec = &schedule[i + 1];
            let t0 = Instant::now();
            let next = pyramid::downsample(
                &write_level,
                next_spec.downsample_xy,
                next_spec.downsample_z,
            );
            let ds_elapsed = t0.elapsed().as_millis();
            eprintln!("    level {}: downsampled in {}ms", i + 1, ds_elapsed);

            let (write_result, write_elapsed) = write_handle
                .join()
                .map_err(|_| format!("write thread for level {i} panicked"))?;
            write_result?;
            eprintln!("    level {i}: wrote in {write_elapsed}ms");

            drop(write_level);
            current = next;
        }
    }

    Ok(())
}

#[cfg(test)]
mod atomic_output_tests {
    use super::*;

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum InjectedFault {
        StagingSync,
        Rename,
        ParentSync,
    }

    struct FaultingPublicationOps(InjectedFault);

    impl FaultingPublicationOps {
        fn injected() -> std::io::Error {
            std::io::Error::other("injected publication fault")
        }
    }

    impl PublicationOps for FaultingPublicationOps {
        fn sync_tree(&self, root: &Path) -> std::io::Result<()> {
            if self.0 == InjectedFault::StagingSync {
                Err(Self::injected())
            } else {
                RealPublicationOps.sync_tree(root)
            }
        }

        fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
            if self.0 == InjectedFault::Rename {
                Err(Self::injected())
            } else {
                RealPublicationOps.rename(from, to)
            }
        }

        fn sync_directory(&self, directory: &Path) -> std::io::Result<()> {
            if self.0 == InjectedFault::ParentSync {
                Err(Self::injected())
            } else {
                RealPublicationOps.sync_directory(directory)
            }
        }
    }

    fn temp_output(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("lucida_atomic_output_{}", std::process::id()))
            // Rust runs these tests concurrently. Give each fault scenario an
            // independent parent so one test's cleanup cannot delete another
            // test's staging directory between begin and commit.
            .join(name.trim_end_matches(".zarr"))
            .join(name)
    }

    #[test]
    fn failed_publication_removes_staging_and_never_exposes_final_path() {
        let output = temp_output("failed.zarr");
        let _ = std::fs::remove_dir_all(output.parent().unwrap());
        let staging = {
            let publication = AtomicOutput::begin(&output).unwrap();
            let staging = publication.path().to_path_buf();
            std::fs::write(staging.join("partial"), b"partial").unwrap();
            staging
        };
        assert!(!output.exists());
        assert!(!staging.exists());
    }

    #[test]
    fn commit_renames_complete_staging_tree_to_final_path() {
        let output = temp_output("complete.zarr");
        let _ = std::fs::remove_dir_all(output.parent().unwrap());
        let publication = AtomicOutput::begin(&output).unwrap();
        std::fs::write(publication.path().join("complete"), b"complete").unwrap();
        publication.commit().unwrap();
        assert_eq!(std::fs::read(output.join("complete")).unwrap(), b"complete");
        let _ = std::fs::remove_dir_all(output.parent().unwrap());
    }

    #[test]
    fn staging_fsync_failure_never_exposes_final_path() {
        let output = temp_output("sync-fault.zarr");
        let _ = std::fs::remove_dir_all(output.parent().unwrap());
        let publication = AtomicOutput::begin(&output).unwrap();
        let staging = publication.path().to_path_buf();
        std::fs::write(staging.join("complete"), b"complete").unwrap();

        let error = publication
            .commit_with(&FaultingPublicationOps(InjectedFault::StagingSync))
            .unwrap_err();
        assert!(error.contains("durably flush staged output"));
        assert!(!output.exists());
        assert!(!staging.exists());
    }

    #[test]
    fn rename_failure_never_exposes_final_path_and_cleans_staging() {
        let output = temp_output("rename-fault.zarr");
        let _ = std::fs::remove_dir_all(output.parent().unwrap());
        let publication = AtomicOutput::begin(&output).unwrap();
        let staging = publication.path().to_path_buf();
        std::fs::write(staging.join("complete"), b"complete").unwrap();

        let error = publication
            .commit_with(&FaultingPublicationOps(InjectedFault::Rename))
            .unwrap_err();
        assert!(error.contains("failed to publish"));
        assert!(!output.exists());
        assert!(!staging.exists());
    }

    #[test]
    fn parent_fsync_failure_reports_uncertain_durability_but_keeps_atomic_output() {
        let output = temp_output("parent-sync-fault.zarr");
        let _ = std::fs::remove_dir_all(output.parent().unwrap());
        let publication = AtomicOutput::begin(&output).unwrap();
        let staging = publication.path().to_path_buf();
        std::fs::write(staging.join("complete"), b"complete").unwrap();

        let error = publication
            .commit_with(&FaultingPublicationOps(InjectedFault::ParentSync))
            .unwrap_err();
        assert!(error.contains("published"));
        assert!(error.contains("failed to durably sync parent directory"));
        assert_eq!(std::fs::read(output.join("complete")).unwrap(), b"complete");
        assert!(!staging.exists());
        let _ = std::fs::remove_dir_all(output.parent().unwrap());
    }
}

#[cfg(test)]
mod calibrated_tiff_integration_tests {
    use super::*;
    use std::fs;
    use std::io::BufWriter;
    use tiff::encoder::{TiffEncoder, colortype::Gray16};
    use tiff::tags::Tag;

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir()
            .join(format!("lucida_calibrated_tiff_{}", std::process::id()))
            .join(name);
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_ome_tiff(path: &Path, declared_pages: u32, actual_pages: u32) {
        write_ome_tiff_shape(path, 2, 2, declared_pages, actual_pages);
    }

    fn write_ome_tiff_shape(
        path: &Path,
        width: u32,
        height: u32,
        declared_pages: u32,
        actual_pages: u32,
    ) {
        let file = fs::File::create(path).unwrap();
        let mut encoder = TiffEncoder::new(BufWriter::new(file)).unwrap();
        let description = format!(
            r#"<?xml version="1.0"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">
  <Image ID="Image:0"><Pixels DimensionOrder="XYZCT" Type="uint16"
    SizeX="{width}" SizeY="{height}" SizeZ="{declared_pages}" SizeC="1" SizeT="1"
    PhysicalSizeX="250" PhysicalSizeXUnit="nm"
    PhysicalSizeY="0.5" PhysicalSizeYUnit="um"
    PhysicalSizeZ="0.002" PhysicalSizeZUnit="mm"/></Image>
</OME>"#
        );
        let pixels_per_page = usize::try_from(width)
            .unwrap()
            .checked_mul(height as usize)
            .unwrap();

        for page in 0..actual_pages {
            let mut image = encoder.new_image::<Gray16>(width, height).unwrap();
            if page == 0 {
                image
                    .encoder()
                    .write_tag(Tag::ImageDescription, description.as_str())
                    .unwrap();
            }
            image
                .write_data(&vec![page as u16 + 1; pixels_per_page])
                .unwrap();
        }
    }

    #[cfg(unix)]
    fn peak_rss_bytes() -> u64 {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        // SAFETY: `usage` points to writable storage for exactly one `rusage`;
        // `getrusage` initializes it on a successful return before `assume_init`.
        let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
        assert_eq!(result, 0, "getrusage failed");
        // SAFETY: guarded by the successful `getrusage` return above.
        let kib_or_bytes = unsafe { usage.assume_init() }.ru_maxrss as u64;
        #[cfg(target_os = "macos")]
        {
            kib_or_bytes
        }
        #[cfg(not(target_os = "macos"))]
        {
            kib_or_bytes.saturating_mul(1024)
        }
    }

    #[tokio::test]
    async fn calibrated_tiff_ingest_round_trips_physical_scale_through_import() {
        let root = temp_dir("round_trip");
        let input = root.join("calibrated.ome.tiff");
        let output = root.join("calibrated.ome.zarr");
        write_ome_tiff(&input, 2, 2);

        convert_tiff_to_zarr(&input, &output, [1, 2, 2], &DimensionHints::default()).unwrap();

        let store = crate::backend::open(output.to_str().unwrap()).unwrap();
        let imported = crate::import::import_dataset(&store, "calibrated", "Calibrated")
            .await
            .unwrap();
        let level = &imported.manifest.images()[0].multiscale.levels[0];
        assert_eq!(level.scale, [1.0, 1.0, 2.0, 0.5, 0.25]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn real_extra_page_tiff_is_rejected_before_volume_allocation() {
        let root = temp_dir("extra_page");
        let input = root.join("extra-page.ome.tiff");
        write_ome_tiff(&input, 2, 3);

        let error = tiff_reader::read_tiff(&input, &DimensionHints::default()).unwrap_err();
        assert!(
            error.contains("selects 2 pages but TIFF contains 3"),
            "unexpected error: {error}"
        );
        assert!(error.contains("explicit single-series input"));

        let _ = fs::remove_dir_all(root);
    }

    /// Run the memory probe in an isolated test process so its high-water mark
    /// cannot be inherited from unrelated parallel tests. The fixture decodes
    /// 16 MiB of voxels and builds three pyramid levels; the 256 MiB ceiling
    /// leaves room for the immutable TIFF snapshot, one decoded volume, the
    /// current/next level pipeline, compression buffers, and runtime overhead,
    /// while catching a return to unbounded page accumulation or multi-volume
    /// fallback copies.
    #[cfg(unix)]
    #[test]
    fn multipage_ingest_peak_rss_stays_within_budget() {
        const CHILD_ENV: &str = "LUCIDA_INGEST_RSS_PROBE_CHILD";
        const TEST_NAME: &str = "ingest::calibrated_tiff_integration_tests::multipage_ingest_peak_rss_stays_within_budget";
        const MAX_PEAK_RSS_BYTES: u64 = 256 * 1024 * 1024;

        if std::env::var_os(CHILD_ENV).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST_NAME, "--nocapture", "--test-threads=1"])
                .env(CHILD_ENV, "1")
                .status()
                .unwrap();
            assert!(status.success(), "isolated peak-RSS probe failed");
            return;
        }

        let root = temp_dir("peak_rss");
        let input = root.join("bounded.ome.tiff");
        let output = root.join("bounded.ome.zarr");
        write_ome_tiff_shape(&input, 1024, 1024, 8, 8);
        convert_tiff_to_zarr(&input, &output, [1, 128, 128], &DimensionHints::default()).unwrap();

        let peak = peak_rss_bytes();
        eprintln!("isolated ingest peak RSS: {peak} bytes");
        assert!(
            peak <= MAX_PEAK_RSS_BYTES,
            "isolated ingest peak RSS was {peak} bytes; budget is {MAX_PEAK_RSS_BYTES}"
        );
        let _ = fs::remove_dir_all(root);
    }
}
