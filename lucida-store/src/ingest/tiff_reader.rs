use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use rayon::prelude::*;
use tiff::ColorType;
use tiff::decoder::ifd;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

/// Admission ceiling for one decoded TIFF volume.  Checked before allocating
/// the TCZYX output buffer on both the metadata and fallback paths.
const MAX_TIFF_DECODED_BYTES: usize = 2 * 1024 * 1024 * 1024;
const MAX_TIFF_SOURCE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Dimension ordering for multi-page TIFFs.
///
/// Describes which dimensions vary fastest after XY (which are within a page).
/// For example, XYZCT means pages iterate Z fastest, then C, then T.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DimensionOrder {
    Xyzct,
    Xyztc,
    Xyczt,
    Xyctz,
    Xytcz,
    Xytzc,
}

impl DimensionOrder {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_uppercase().as_str() {
            "XYZCT" => Ok(Self::Xyzct),
            "XYZTC" => Ok(Self::Xyztc),
            "XYCZT" => Ok(Self::Xyczt),
            "XYCTZ" => Ok(Self::Xyctz),
            "XYTCZ" => Ok(Self::Xytcz),
            "XYTZC" => Ok(Self::Xytzc),
            _ => Err(format!("unknown dimension order: {s}")),
        }
    }

    /// Given (t, c, z) and dimension sizes, return the TIFF page index.
    pub fn page_index(self, t: u32, c: u32, z: u32, size_t: u32, size_c: u32, size_z: u32) -> u32 {
        u32::try_from(
            self.checked_page_index(t, c, z, size_t, size_c, size_z)
                .expect("page coordinates and dimensions must be valid"),
        )
        .expect("legacy page_index result must fit u32")
    }

    pub fn checked_page_index(
        self,
        t: u32,
        c: u32,
        z: u32,
        size_t: u32,
        size_c: u32,
        size_z: u32,
    ) -> Result<usize, String> {
        if size_t == 0 || size_c == 0 || size_z == 0 {
            return Err("TIFF T/C/Z dimensions must be positive".to_string());
        }
        if t >= size_t || c >= size_c || z >= size_z {
            return Err(format!(
                "page coordinate t={t}, c={c}, z={z} outside T={size_t}, C={size_c}, Z={size_z}"
            ));
        }
        let t = u64::from(t);
        let c = u64::from(c);
        let z = u64::from(z);
        let size_t = u64::from(size_t);
        let size_c = u64::from(size_c);
        let size_z = u64::from(size_z);
        let mul_add = |outer: u64, middle_size: u64, middle: u64, inner_size: u64, inner: u64| {
            outer
                .checked_mul(middle_size)
                .and_then(|value| value.checked_add(middle))
                .and_then(|value| value.checked_mul(inner_size))
                .and_then(|value| value.checked_add(inner))
        };
        let index = match self {
            Self::Xyzct => mul_add(t, size_c, c, size_z, z),
            Self::Xyztc => mul_add(c, size_t, t, size_z, z),
            Self::Xyczt => mul_add(t, size_z, z, size_c, c),
            Self::Xyctz => mul_add(z, size_t, t, size_c, c),
            Self::Xytcz => mul_add(z, size_c, c, size_t, t),
            Self::Xytzc => mul_add(c, size_z, z, size_t, t),
        }
        .ok_or_else(|| "TIFF page index arithmetic overflow".to_string())?;
        usize::try_from(index).map_err(|_| "TIFF page index exceeds usize".to_string())
    }
}

/// User-provided hints for interpreting TIFF page dimensions.
#[derive(Debug, Clone, Default)]
pub struct DimensionHints {
    pub size_t: Option<u32>,
    pub size_c: Option<u32>,
    pub size_z: Option<u32>,
    pub order: Option<DimensionOrder>,
    pub voxel_size_x: Option<f64>,
    pub voxel_size_y: Option<f64>,
    pub voxel_size_z: Option<f64>,
}

/// Dimension info parsed from OME-XML.
#[derive(Debug)]
struct OmeInfo {
    size_t: u32,
    size_c: u32,
    size_z: u32,
    order: DimensionOrder,
    physical_size_x: Option<f64>,
    physical_size_y: Option<f64>,
    physical_size_z: Option<f64>,
}

use super::pyramid::VoxelSize;

/// A 5D volume of u16 pixel data read from a TIFF file.
///
/// Data is stored in TCZYX order (T outermost, X innermost).
#[derive(Debug)]
pub struct Volume {
    pub data: Vec<u16>,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub channels: u32,
    pub timepoints: u32,
    pub voxel_size: VoxelSize,
}

pub(crate) fn checked_volume_layout(
    width: u32,
    height: u32,
    size_t: u32,
    size_c: u32,
    size_z: u32,
) -> Result<(usize, usize, usize), String> {
    if width == 0 || height == 0 || size_t == 0 || size_c == 0 || size_z == 0 {
        return Err("TIFF X/Y/T/C/Z dimensions must be positive".to_string());
    }
    let pixels_per_page = usize::try_from(width)
        .ok()
        .and_then(|value| value.checked_mul(height as usize))
        .ok_or_else(|| "TIFF pixels-per-page arithmetic overflow".to_string())?;
    let num_pages = usize::try_from(size_t)
        .ok()
        .and_then(|value| value.checked_mul(size_c as usize))
        .and_then(|value| value.checked_mul(size_z as usize))
        .ok_or_else(|| "TIFF page-count arithmetic overflow".to_string())?;
    let total_pixels = num_pages
        .checked_mul(pixels_per_page)
        .ok_or_else(|| "TIFF decoded-pixel arithmetic overflow".to_string())?;
    let decoded_bytes = total_pixels
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| "TIFF decoded-byte arithmetic overflow".to_string())?;
    if decoded_bytes > MAX_TIFF_DECODED_BYTES {
        return Err(format!(
            "TIFF decoded volume requires {decoded_bytes} bytes; limit is {MAX_TIFF_DECODED_BYTES}"
        ));
    }
    Ok((pixels_per_page, num_pages, total_pixels))
}

fn count_tiff_pages(data: &[u8]) -> Result<usize, String> {
    let mut decoder = Decoder::new(Cursor::new(data))
        .map_err(|error| format!("failed to decode TIFF: {error}"))?;
    let mut count = 1usize;
    while decoder.more_images() {
        decoder
            .next_image()
            .map_err(|error| format!("failed to scan TIFF page {count}: {error}"))?;
        count = count
            .checked_add(1)
            .ok_or_else(|| "TIFF page count exceeds usize".to_string())?;
    }
    Ok(count)
}

/// Read an immutable, bounded snapshot of the TIFF source.
///
/// A live mmap can fault if another process truncates the file and can expose
/// a mixture of revisions while decoding.  Copying from one open handle keeps
/// decoder lifetimes independent of the filesystem mapping; checking metadata
/// before and after catches replacement/truncation during the read.
fn read_tiff_snapshot(path: &Path) -> Result<Vec<u8>, String> {
    let mut file =
        File::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    let before = file
        .metadata()
        .map_err(|e| format!("failed to stat {}: {e}", path.display()))?;
    if !before.is_file() {
        return Err(format!(
            "TIFF source is not a regular file: {}",
            path.display()
        ));
    }
    if before.len() > MAX_TIFF_SOURCE_BYTES {
        return Err(format!(
            "TIFF source is {} bytes; limit is {MAX_TIFF_SOURCE_BYTES}",
            before.len()
        ));
    }
    let capacity = usize::try_from(before.len())
        .map_err(|_| "TIFF source length exceeds addressable memory".to_string())?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(capacity)
        .map_err(|error| format!("failed to reserve TIFF source snapshot: {error}"))?;
    file.by_ref()
        .take(MAX_TIFF_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_TIFF_SOURCE_BYTES {
        return Err(format!(
            "TIFF source grew beyond {MAX_TIFF_SOURCE_BYTES} bytes while reading"
        ));
    }

    let after = file
        .metadata()
        .map_err(|e| format!("failed to restat {}: {e}", path.display()))?;
    let revision_changed = before.len() != after.len()
        || match (before.modified(), after.modified()) {
            (Ok(before), Ok(after)) => before != after,
            _ => false,
        };
    if revision_changed || bytes.len() as u64 != before.len() {
        return Err("TIFF source changed while its immutable ingest snapshot was read".to_string());
    }
    Ok(bytes)
}

/// Read a TIFF file into a 5D Volume.
///
/// Handles single-page (2D) and multi-page TIFFs. Supports u8 (promoted to u16)
/// and u16 grayscale. Rejects RGB.
///
/// Dimension interpretation priority: hints > OME-XML > default (all pages = Z).
pub fn read_tiff(path: &Path, hints: &DimensionHints) -> Result<Volume, String> {
    let snapshot = read_tiff_snapshot(path)?;
    let data: &[u8] = &snapshot;

    let mut decoder =
        Decoder::new(Cursor::new(data)).map_err(|e| format!("failed to decode TIFF: {e}"))?;

    // Try to read OME-XML from ImageDescription tag (before reading pixel data)
    let ome_info = try_read_ome_xml(&mut decoder)?;

    // Read first page to get dimensions
    let (width, height) = decoder
        .dimensions()
        .map_err(|e| format!("bad dimensions: {e}"))?;
    let (pixels_per_page, _, _) = checked_volume_layout(width, height, 1, 1, 1)?;

    // Resolve dimensions early if possible (OME metadata + hints)
    // so we can pre-allocate and stream pages directly into the output buffer
    let early_dims = if let Some(info) = ome_info.as_ref() {
        Some((
            hints.size_t.unwrap_or(info.size_t),
            hints.size_c.unwrap_or(info.size_c),
            hints.size_z.unwrap_or(info.size_z),
            hints.order.unwrap_or(info.order),
        ))
    } else if let (Some(size_t), Some(size_c), Some(size_z)) =
        (hints.size_t, hints.size_c, hints.size_z)
    {
        Some((
            size_t,
            size_c,
            size_z,
            hints.order.unwrap_or(DimensionOrder::Xyzct),
        ))
    } else {
        None
    };

    // Resolve voxel size: CLI hints > OME-XML > default (1,1,1)
    let voxel_size = {
        let ome_ref = ome_info.as_ref();
        VoxelSize {
            x: hints
                .voxel_size_x
                .or_else(|| ome_ref.and_then(|i| i.physical_size_x))
                .unwrap_or(1.0),
            y: hints
                .voxel_size_y
                .or_else(|| ome_ref.and_then(|i| i.physical_size_y))
                .unwrap_or(1.0),
            z: hints
                .voxel_size_z
                .or_else(|| ome_ref.and_then(|i| i.physical_size_z))
                .unwrap_or(1.0),
        }
    }
    .validate()?;

    if let Some((size_t, size_c, size_z, order)) = early_dims {
        let (_, num_pages, _) = checked_volume_layout(width, height, size_t, size_c, size_z)?;
        let actual_pages = count_tiff_pages(data)?;
        if actual_pages != num_pages {
            return Err(format!(
                "dimension mismatch: metadata selects {num_pages} pages but TIFF contains {actual_pages}; multi-series or extra-page TIFFs require explicit single-series input"
            ));
        }
        eprintln!("Reading TIFF pages ({width}x{height}), {num_pages} pages, parallel decoding...");
        // Drop the initial decoder — each thread will create its own
        drop(decoder);
        read_tiff_parallel(
            data,
            width,
            height,
            pixels_per_page,
            size_t,
            size_c,
            size_z,
            order,
            voxel_size,
        )
    } else {
        eprintln!("Reading TIFF pages ({width}x{height}), unknown page count...");
        read_tiff_collect(
            &mut decoder,
            width,
            height,
            pixels_per_page,
            hints,
            voxel_size,
        )
    }
}

/// Decode a single page from a decoder, returning pixels as u16.
fn decode_page(
    decoder: &mut Decoder<Cursor<&[u8]>>,
    page_num: usize,
    width: u32,
    height: u32,
    pixels_per_page: usize,
) -> Result<Vec<u16>, String> {
    let (w, h) = decoder
        .dimensions()
        .map_err(|e| format!("bad dimensions: {e}"))?;
    if w != width || h != height {
        return Err(format!(
            "page {page_num} has dimensions {w}x{h}, expected {width}x{height}"
        ));
    }

    let color = decoder
        .colortype()
        .map_err(|e| format!("bad color type: {e}"))?;
    match color {
        ColorType::Gray(8) | ColorType::Gray(16) => {}
        _ => {
            return Err(format!(
                "unsupported color type: {color:?} (only Gray8/Gray16)"
            ));
        }
    }

    let image = decoder
        .read_image()
        .map_err(|e| format!("failed to read image data: {e}"))?;
    match image {
        DecodingResult::U8(src) => {
            if src.len() != pixels_per_page {
                return Err(format!(
                    "page {page_num} has {} pixels, expected {pixels_per_page}",
                    src.len()
                ));
            }
            Ok(src.iter().map(|&v| v as u16).collect())
        }
        DecodingResult::U16(src) => {
            if src.len() != pixels_per_page {
                return Err(format!(
                    "page {page_num} has {} pixels, expected {pixels_per_page}",
                    src.len()
                ));
            }
            Ok(src)
        }
        _ => Err("unexpected pixel format".into()),
    }
}

/// Fast path: dimensions known upfront from OME metadata.
///
/// Splits pages across rayon threads. Each thread creates its own decoder over
/// the immutable source snapshot, walks IFDs to its starting page, then
/// decodes into a disjoint source-order slice of the pre-allocated buffer.
/// Once decoding succeeds, the source-order pages are permuted in place into
/// TCZYX order. This keeps peak memory bounded without raw-pointer writes.
// Internal helper; args reflect the raw TIFF dimensions plus dim ordering.
#[allow(clippy::too_many_arguments)]
fn read_tiff_parallel(
    mmap_data: &[u8],
    width: u32,
    height: u32,
    pixels_per_page: usize,
    size_t: u32,
    size_c: u32,
    size_z: u32,
    order: DimensionOrder,
    voxel_size: VoxelSize,
) -> Result<Volume, String> {
    let (checked_pixels_per_page, num_pages, total_pixels) =
        checked_volume_layout(width, height, size_t, size_c, size_z)?;
    if checked_pixels_per_page != pixels_per_page {
        return Err("TIFF pixels-per-page admission changed during decode".to_string());
    }

    // Build page→dst index map for reordering into TCZYX order
    let page_to_dst: Vec<usize> = if matches!(order, DimensionOrder::Xyzct) {
        // Sequential: page N goes to slot N
        (0..num_pages).collect()
    } else {
        let mut map = vec![0usize; num_pages];
        for t in 0..size_t {
            for c in 0..size_c {
                for z in 0..size_z {
                    let page_idx = order.checked_page_index(t, c, z, size_t, size_c, size_z)?;
                    let dst_idx = DimensionOrder::Xyzct
                        .checked_page_index(t, c, z, size_t, size_c, size_z)?;
                    map[page_idx] = dst_idx;
                }
            }
        }
        let mut seen = vec![false; num_pages];
        for &destination in &map {
            let slot = seen
                .get_mut(destination)
                .ok_or_else(|| "TIFF page mapping is outside admitted bounds".to_string())?;
            if std::mem::replace(slot, true) {
                return Err("TIFF dimension order produced a duplicate page mapping".to_string());
            }
        }
        map
    };

    // Pre-allocate output buffer
    let mut data: Vec<u16> = vec![0u16; total_pixels];

    // Split pages into chunks for parallel processing
    let n_threads = rayon::current_num_threads().max(1).min(num_pages);
    let chunk_size = num_pages.div_ceil(n_threads);

    let progress = AtomicUsize::new(0);

    let chunk_pixels = chunk_size
        .checked_mul(pixels_per_page)
        .ok_or_else(|| "TIFF decode-chunk arithmetic overflow".to_string())?;

    data.par_chunks_mut(chunk_pixels)
        .enumerate()
        .try_for_each(|(chunk_index, destination)| {
            let start = chunk_index
                .checked_mul(chunk_size)
                .ok_or_else(|| "TIFF decode-chunk index overflow".to_string())?;
            let end = start
                .checked_add(destination.len() / pixels_per_page)
                .ok_or_else(|| "TIFF decode-chunk end overflow".to_string())?;
            // Each thread creates its own decoder from the immutable snapshot.
            let mut decoder = Decoder::new(Cursor::new(mmap_data))
                .map_err(|e| format!("failed to create decoder: {e}"))?;

            // Walk IFDs to the starting page (fast — just reads metadata)
            for _ in 0..start {
                if !decoder.more_images() {
                    return Err(format!(
                        "TIFF has fewer pages than expected (at page {start})"
                    ));
                }
                decoder
                    .next_image()
                    .map_err(|e| format!("failed to seek to page {start}: {e}"))?;
            }

            for (offset, page_destination) in
                destination.chunks_exact_mut(pixels_per_page).enumerate()
            {
                let page_num = start
                    .checked_add(offset)
                    .ok_or_else(|| "TIFF page index overflow".to_string())?;
                let pixels = decode_page(&mut decoder, page_num, width, height, pixels_per_page)?;
                page_destination.copy_from_slice(&pixels);

                let count = progress.fetch_add(1, Ordering::Relaxed) + 1;
                if count.is_multiple_of(100) || count == num_pages {
                    eprintln!("  pages: {count}/{num_pages}");
                }

                // Advance to next page if not the last in this chunk
                if page_num + 1 < end {
                    if !decoder.more_images() {
                        return Err(format!(
                            "TIFF has only {} pages but expected {num_pages}",
                            page_num + 1
                        ));
                    }
                    decoder
                        .next_image()
                        .map_err(|e| format!("failed to advance to page {}: {e}", page_num + 1))?;
                }
            }

            Ok::<(), String>(())
        })?;

    // `data` is now in source-page order. Apply the validated source→TCZYX
    // permutation in place. Swapping the permutation entries alongside their
    // page blocks converges every cycle to identity with no second volume.
    let mut remaining_permutation = page_to_dst;
    reorder_page_blocks_in_place(&mut data, pixels_per_page, &mut remaining_permutation)?;

    eprintln!("Resolved dimensions: T={size_t}, C={size_c}, Z={size_z}, order={order:?}");

    Ok(Volume {
        data,
        width,
        height,
        depth: size_z,
        channels: size_c,
        timepoints: size_t,
        voxel_size,
    })
}

/// Fallback path: dimensions unknown, collect all pages then reorder.
fn read_tiff_collect(
    decoder: &mut Decoder<Cursor<&[u8]>>,
    width: u32,
    height: u32,
    pixels_per_page: usize,
    hints: &DimensionHints,
    voxel_size: VoxelSize,
) -> Result<Volume, String> {
    // Keep source-order pages in one contiguous volume.  The old
    // `Vec<Vec<u16>>` plus destination volume held two full decoded copies.
    let mut data: Vec<u16> = Vec::new();
    let mut page_count = 0usize;

    loop {
        let page_num = page_count;
        let next_len = data
            .len()
            .checked_add(pixels_per_page)
            .ok_or_else(|| "TIFF decoded-pixel arithmetic overflow".to_string())?;
        let next_bytes = next_len
            .checked_mul(std::mem::size_of::<u16>())
            .ok_or_else(|| "TIFF decoded-byte arithmetic overflow".to_string())?;
        if next_bytes > MAX_TIFF_DECODED_BYTES {
            return Err(format!(
                "TIFF decoded volume exceeds {MAX_TIFF_DECODED_BYTES} byte limit at page {page_num}"
            ));
        }
        data.try_reserve_exact(pixels_per_page)
            .map_err(|error| format!("failed to reserve TIFF page {page_num}: {error}"))?;
        let pixels = decode_page(decoder, page_num, width, height, pixels_per_page)?;
        data.extend_from_slice(&pixels);
        page_count = page_count
            .checked_add(1)
            .ok_or_else(|| "TIFF page count exceeds usize".to_string())?;

        let count = page_count;
        if count.is_multiple_of(100) {
            eprintln!("  pages: {count}");
        }

        if decoder.more_images() {
            decoder
                .next_image()
                .map_err(|e| format!("failed to advance to next page: {e}"))?;
        } else {
            break;
        }
    }

    let num_pages = u32::try_from(page_count)
        .map_err(|_| format!("TIFF has {page_count} pages, exceeding the u32 dimension limit"))?;
    eprintln!("  pages: {num_pages}/{num_pages} (done)");

    // Default: all pages are Z slices
    let size_t = hints.size_t.unwrap_or(1);
    let size_c = hints.size_c.unwrap_or(1);
    let size_z = hints.size_z.unwrap_or(num_pages);
    let order = hints.order.unwrap_or(DimensionOrder::Xyzct);
    eprintln!("Resolved dimensions: T={size_t}, C={size_c}, Z={size_z}, order={order:?}");

    let (checked_pixels_per_page, expected_pages, total_pixels) =
        checked_volume_layout(width, height, size_t, size_c, size_z)?;
    if checked_pixels_per_page != pixels_per_page {
        return Err("TIFF pixels-per-page admission changed during decode".to_string());
    }
    if expected_pages != page_count {
        return Err(format!(
            "dimension mismatch: T={size_t} * C={size_c} * Z={size_z} = {expected_pages} but TIFF has {num_pages} pages"
        ));
    }
    if data.len() != total_pixels {
        return Err("TIFF decoded length does not match admitted dimensions".to_string());
    }

    // Reorder page blocks into TCZYX in place using one usize per page.
    if !matches!(order, DimensionOrder::Xyzct) {
        let mut destination_of_page = vec![0usize; page_count];
        for t in 0..size_t {
            for c in 0..size_c {
                for z in 0..size_z {
                    let source = order.checked_page_index(t, c, z, size_t, size_c, size_z)?;
                    let destination = DimensionOrder::Xyzct
                        .checked_page_index(t, c, z, size_t, size_c, size_z)?;
                    destination_of_page[source] = destination;
                }
            }
        }
        reorder_page_blocks_in_place(&mut data, pixels_per_page, &mut destination_of_page)?;
    }

    Ok(Volume {
        data,
        width,
        height,
        depth: size_z,
        channels: size_c,
        timepoints: size_t,
        voxel_size,
    })
}

fn reorder_page_blocks_in_place(
    data: &mut [u16],
    pixels_per_page: usize,
    destination_of_page: &mut [usize],
) -> Result<(), String> {
    let expected_len = destination_of_page
        .len()
        .checked_mul(pixels_per_page)
        .ok_or_else(|| "TIFF page-reorder arithmetic overflow".to_string())?;
    if data.len() != expected_len {
        return Err("TIFF page-reorder data length mismatch".to_string());
    }

    let mut seen = vec![false; destination_of_page.len()];
    for &destination in destination_of_page.iter() {
        let slot = seen
            .get_mut(destination)
            .ok_or_else(|| "TIFF page-reorder destination is out of bounds".to_string())?;
        if std::mem::replace(slot, true) {
            return Err("TIFF page-reorder mapping is not a permutation".to_string());
        }
    }

    for slot in 0..destination_of_page.len() {
        while destination_of_page[slot] != slot {
            let destination = destination_of_page[slot];
            let left = slot
                .checked_mul(pixels_per_page)
                .ok_or_else(|| "TIFF page-reorder offset overflow".to_string())?;
            let right = destination
                .checked_mul(pixels_per_page)
                .ok_or_else(|| "TIFF page-reorder offset overflow".to_string())?;
            for offset in 0..pixels_per_page {
                data.swap(left + offset, right + offset);
            }
            destination_of_page.swap(slot, destination);
        }
    }
    Ok(())
}

fn try_read_ome_xml(decoder: &mut Decoder<Cursor<&[u8]>>) -> Result<Option<OmeInfo>, String> {
    let value = match decoder.find_tag(Tag::ImageDescription) {
        Ok(Some(v)) => v,
        Ok(None) => {
            eprintln!("No ImageDescription tag found");
            return Ok(None);
        }
        Err(e) => {
            return Err(format!("failed to read TIFF ImageDescription: {e}"));
        }
    };
    let desc = match value {
        ifd::Value::Ascii(s) => s,
        ifd::Value::List(ref values) => {
            // Some writers store ImageDescription as bytes
            let bytes: Vec<u8> = values
                .iter()
                .map(|value| match value {
                    ifd::Value::Byte(byte) => Ok(*byte),
                    _ => Err("TIFF ImageDescription byte list contains a non-byte value"),
                })
                .collect::<Result<_, _>>()?;
            String::from_utf8(bytes)
                .map_err(|error| format!("TIFF ImageDescription is not UTF-8: {error}"))?
        }
        other => {
            eprintln!("ImageDescription is not ASCII: {other:?}");
            return Ok(None);
        }
    };
    parse_ome_xml(&desc)
}

fn parse_ome_xml(xml: &str) -> Result<Option<OmeInfo>, String> {
    // Quick check: is this OME-XML?
    if !xml.contains("<OME") && !xml.contains("<Pixels") {
        return Ok(None);
    }

    let series_count = count_start_elements(xml, "Pixels");
    if series_count != 1 {
        return Err(format!(
            "OME metadata contains {series_count} Pixels series; ingest requires exactly one explicit series"
        ));
    }

    let required_dimension = |name: &str| -> Result<u32, String> {
        let raw = extract_attr(xml, name)
            .ok_or_else(|| format!("OME Pixels is missing required {name}"))?;
        let value = raw
            .parse::<u32>()
            .map_err(|_| format!("OME {name} is not a valid u32: {raw}"))?;
        if value == 0 {
            return Err(format!("OME {name} must be positive"));
        }
        Ok(value)
    };

    let order_raw = extract_attr(xml, "DimensionOrder")
        .ok_or_else(|| "OME Pixels is missing required DimensionOrder".to_string())?;
    let order = DimensionOrder::parse(&order_raw)?;
    let size_t = required_dimension("SizeT")?;
    let size_c = required_dimension("SizeC")?;
    let size_z = required_dimension("SizeZ")?;

    let physical_size_x = parse_physical_size_micrometers(xml, "X")?;
    let physical_size_y = parse_physical_size_micrometers(xml, "Y")?;
    let physical_size_z = parse_physical_size_micrometers(xml, "Z")?;

    Ok(Some(OmeInfo {
        size_t,
        size_c,
        size_z,
        order,
        physical_size_x,
        physical_size_y,
        physical_size_z,
    }))
}

fn count_start_elements(xml: &str, local_name: &str) -> usize {
    xml.split('<')
        .skip(1)
        .filter_map(|tail| {
            if tail.starts_with(['/', '?', '!']) {
                return None;
            }
            let qualified = tail
                .split(|ch: char| ch.is_ascii_whitespace() || ch == '/' || ch == '>')
                .next()?;
            qualified.rsplit(':').next()
        })
        .filter(|name| *name == local_name)
        .count()
}

fn parse_physical_size_micrometers(xml: &str, axis: &str) -> Result<Option<f64>, String> {
    let value_name = format!("PhysicalSize{axis}");
    let unit_name = format!("{value_name}Unit");
    let Some(raw_value) = extract_attr(xml, &value_name) else {
        if extract_attr(xml, &unit_name).is_some() {
            return Err(format!("OME {unit_name} is present without {value_name}"));
        }
        return Ok(None);
    };
    let value = raw_value
        .parse::<f64>()
        .map_err(|_| format!("OME {value_name} is not numeric: {raw_value}"))?;
    if !value.is_finite() || value <= 0.0 {
        return Err(format!(
            "OME {value_name} must be finite and positive, got {raw_value}"
        ));
    }

    let unit = extract_attr(xml, &unit_name).unwrap_or_else(|| "µm".to_string());
    let factor = unit_to_micrometers(&unit)
        .ok_or_else(|| format!("OME {unit_name} uses unsupported length unit {unit:?}"))?;
    let micrometers = value * factor;
    if !micrometers.is_finite() || micrometers <= 0.0 {
        return Err(format!("OME {value_name} conversion overflowed"));
    }
    Ok(Some(micrometers))
}

fn unit_to_micrometers(unit: &str) -> Option<f64> {
    match unit.trim().to_lowercase().as_str() {
        "µm" | "μm" | "um" | "micrometer" | "micrometers" | "micrometre" | "micrometres"
        | "&#181;m" | "&micro;m" => Some(1.0),
        "nm" | "nanometer" | "nanometers" | "nanometre" | "nanometres" => Some(1e-3),
        "pm" => Some(1e-6),
        "fm" => Some(1e-9),
        "mm" | "millimeter" | "millimeters" | "millimetre" | "millimetres" => Some(1e3),
        "cm" | "centimeter" | "centimeters" | "centimetre" | "centimetres" => Some(1e4),
        "dm" => Some(1e5),
        "m" | "meter" | "meters" | "metre" | "metres" => Some(1e6),
        "å" | "angstrom" | "angstroms" => Some(1e-4),
        "in" | "inch" | "inches" => Some(25_400.0),
        _ => None,
    }
}

/// Extract an XML attribute value by name. Simple string search, no full XML parser.
///
/// Requires a space before the attribute name to avoid matching suffixes
/// (e.g. searching for "SizeZ" must not match "PhysicalSizeZ").
fn extract_attr(xml: &str, name: &str) -> Option<String> {
    let pattern = format!(" {name}=\"");
    let start = xml.find(&pattern)? + pattern.len();
    let end = start + xml[start..].find('"')?;
    Some(xml[start..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor as IoCursor;
    use tiff::encoder::{TiffEncoder, colortype::Gray16};

    #[test]
    fn dimension_order_xyzct_page_index() {
        let order = DimensionOrder::Xyzct;
        // T=2, C=3, Z=4: page = t*12 + c*4 + z
        assert_eq!(order.page_index(0, 0, 0, 2, 3, 4), 0);
        assert_eq!(order.page_index(0, 0, 3, 2, 3, 4), 3);
        assert_eq!(order.page_index(0, 1, 0, 2, 3, 4), 4);
        assert_eq!(order.page_index(1, 0, 0, 2, 3, 4), 12);
    }

    #[test]
    fn dimension_order_xyczt_page_index() {
        let order = DimensionOrder::Xyczt;
        // T=2, C=3, Z=4: page = t*12 + z*3 + c
        assert_eq!(order.page_index(0, 0, 0, 2, 3, 4), 0);
        assert_eq!(order.page_index(0, 2, 0, 2, 3, 4), 2);
        assert_eq!(order.page_index(0, 0, 1, 2, 3, 4), 3);
        assert_eq!(order.page_index(1, 0, 0, 2, 3, 4), 12);
    }

    #[test]
    fn parse_ome_xml_extracts_dimensions() {
        let xml = r#"<?xml version="1.0"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">
  <Image ID="Image:0" Name="test">
    <Pixels DimensionOrder="XYZCT" SizeT="5" SizeC="3" SizeZ="10" SizeX="512" SizeY="512" Type="uint16">
    </Pixels>
  </Image>
</OME>"#;
        let info = parse_ome_xml(xml).unwrap().unwrap();
        assert_eq!(info.size_t, 5);
        assert_eq!(info.size_c, 3);
        assert_eq!(info.size_z, 10);
        assert_eq!(info.order, DimensionOrder::Xyzct);
    }

    #[test]
    fn parse_ome_xml_returns_none_for_non_ome() {
        assert!(parse_ome_xml("just a description").unwrap().is_none());
    }

    #[test]
    fn parse_ome_xml_extracts_physical_sizes() {
        let xml = r#"<?xml version="1.0"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">
  <Image ID="Image:0">
    <Pixels DimensionOrder="XYZCT" SizeT="1" SizeC="1" SizeZ="10" SizeX="512" SizeY="512"
            PhysicalSizeX="0.325" PhysicalSizeY="0.325" PhysicalSizeZ="1.5" Type="uint16">
    </Pixels>
  </Image>
</OME>"#;
        let info = parse_ome_xml(xml).unwrap().unwrap();
        assert!((info.physical_size_x.unwrap() - 0.325).abs() < 1e-10);
        assert!((info.physical_size_y.unwrap() - 0.325).abs() < 1e-10);
        assert!((info.physical_size_z.unwrap() - 1.5).abs() < 1e-10);
    }

    #[test]
    fn parse_ome_xml_missing_physical_sizes() {
        let xml = r#"<?xml version="1.0"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">
  <Image ID="Image:0">
    <Pixels DimensionOrder="XYZCT" SizeT="1" SizeC="1" SizeZ="5" SizeX="256" SizeY="256" Type="uint16">
    </Pixels>
  </Image>
</OME>"#;
        let info = parse_ome_xml(xml).unwrap().unwrap();
        assert!(info.physical_size_x.is_none());
        assert!(info.physical_size_y.is_none());
        assert!(info.physical_size_z.is_none());
    }

    #[test]
    fn extract_attr_finds_value() {
        assert_eq!(
            extract_attr(r#" foo="bar" baz="qux""#, "baz"),
            Some("qux".to_string())
        );
    }

    #[test]
    fn extract_attr_avoids_suffix_match() {
        // "SizeZ" must not match "PhysicalSizeZ"
        let xml = r#"<Pixels PhysicalSizeZ="0.25" SizeZ="17">"#;
        assert_eq!(extract_attr(xml, "SizeZ"), Some("17".to_string()));
    }

    #[test]
    fn resolve_defaults_to_all_z() {
        // Non-OME fallback path uses defaults: T=1, C=1, Z=num_pages
        let hints = DimensionHints::default();
        assert_eq!(hints.size_t, None);
        assert_eq!(hints.size_c, None);
        assert_eq!(hints.size_z, None);
        assert!(hints.order.is_none());
    }

    #[test]
    fn hints_override_ome() {
        // Verify that early_dims resolution in read_tiff prefers hints over OME
        let hints = DimensionHints {
            size_t: Some(2),
            size_c: None,
            size_z: Some(25),
            order: None,
            voxel_size_x: None,
            voxel_size_y: None,
            voxel_size_z: None,
        };
        let ome = OmeInfo {
            size_t: 5,
            size_c: 3,
            size_z: 10,
            order: DimensionOrder::Xyzct,
            physical_size_x: None,
            physical_size_y: None,
            physical_size_z: None,
        };
        // Simulate early_dims logic from read_tiff
        let size_t = hints.size_t.unwrap_or(ome.size_t);
        let size_c = hints.size_c.unwrap_or(ome.size_c);
        let size_z = hints.size_z.unwrap_or(ome.size_z);
        let order = hints.order.unwrap_or(ome.order);
        assert_eq!(size_t, 2);
        assert_eq!(size_c, 3); // from OME
        assert_eq!(size_z, 25); // from hint
        assert_eq!(order, DimensionOrder::Xyzct); // from OME
    }

    #[test]
    fn ome_physical_sizes_are_normalized_to_micrometers() {
        let xml = r#"<OME><Image><Pixels DimensionOrder="XYZCT" SizeT="1" SizeC="1" SizeZ="1"
            PhysicalSizeX="250" PhysicalSizeXUnit="nm"
            PhysicalSizeY="0.5" PhysicalSizeYUnit="µm"
            PhysicalSizeZ="0.002" PhysicalSizeZUnit="mm"/></Image></OME>"#;
        let info = parse_ome_xml(xml).unwrap().unwrap();
        assert_eq!(info.physical_size_x, Some(0.25));
        assert_eq!(info.physical_size_y, Some(0.5));
        assert_eq!(info.physical_size_z, Some(2.0));
    }

    #[test]
    fn ome_multiple_series_is_rejected_explicitly() {
        let xml = r#"<OME>
            <Image><Pixels DimensionOrder="XYZCT" SizeT="1" SizeC="1" SizeZ="1"/></Image>
            <Image><Pixels DimensionOrder="XYZCT" SizeT="1" SizeC="1" SizeZ="1"/></Image>
        </OME>"#;
        let error = parse_ome_xml(xml).unwrap_err();
        assert!(error.contains("2 Pixels series"));
    }

    #[test]
    fn ome_invalid_or_unknown_calibration_is_rejected() {
        let non_positive = r#"<OME><Pixels DimensionOrder="XYZCT" SizeT="1" SizeC="1" SizeZ="1" PhysicalSizeX="0"/></OME>"#;
        assert!(
            parse_ome_xml(non_positive)
                .unwrap_err()
                .contains("positive")
        );

        let unknown_unit = r#"<OME><Pixels DimensionOrder="XYZCT" SizeT="1" SizeC="1" SizeZ="1" PhysicalSizeX="1" PhysicalSizeXUnit="pixel"/></OME>"#;
        assert!(
            parse_ome_xml(unknown_unit)
                .unwrap_err()
                .contains("unsupported length unit")
        );
    }

    #[test]
    fn checked_layout_rejects_zero_and_over_budget_dimensions() {
        assert!(checked_volume_layout(0, 1, 1, 1, 1).is_err());
        let error = checked_volume_layout(u32::MAX, u32::MAX, 2, 2, 2).unwrap_err();
        assert!(error.contains("overflow") || error.contains("limit"));
    }

    #[test]
    fn checked_page_index_rejects_out_of_range_coordinates() {
        assert!(
            DimensionOrder::Xyczt
                .checked_page_index(1, 0, 0, 1, 1, 1)
                .is_err()
        );
    }

    #[test]
    fn page_reorder_uses_one_volume_and_preserves_blocks() {
        let mut data = vec![10, 11, 20, 21, 30, 31];
        // Source page 0 -> destination 1, 1 -> 2, 2 -> 0.
        let mut destinations = vec![1, 2, 0];
        reorder_page_blocks_in_place(&mut data, 2, &mut destinations).unwrap();
        assert_eq!(data, vec![30, 31, 10, 11, 20, 21]);
        assert_eq!(destinations, vec![0, 1, 2]);
    }

    #[test]
    fn parallel_decode_uses_disjoint_slices_and_reorders_pages() {
        let mut encoded = IoCursor::new(Vec::new());
        {
            let mut encoder = TiffEncoder::new(&mut encoded).unwrap();
            for source_page in 0..6u16 {
                encoder
                    .write_image::<Gray16>(2, 1, &[10 + source_page, 10 + source_page])
                    .unwrap();
            }
        }

        let volume = read_tiff_parallel(
            encoded.get_ref(),
            2,
            1,
            2,
            1,
            2,
            3,
            DimensionOrder::Xyczt,
            VoxelSize::default(),
        )
        .unwrap();

        assert_eq!(
            volume.data,
            vec![10, 10, 12, 12, 14, 14, 11, 11, 13, 13, 15, 15]
        );
    }
}
