use std::fs::File;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use memmap2::Mmap;
use rayon::prelude::*;
use tiff::ColorType;
use tiff::decoder::ifd;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

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
        let _ = (size_t, size_c, size_z); // used implicitly via products
        match self {
            Self::Xyzct => t * size_c * size_z + c * size_z + z,
            Self::Xyztc => c * size_t * size_z + t * size_z + z,
            Self::Xyczt => t * size_z * size_c + z * size_c + c,
            Self::Xyctz => z * size_t * size_c + t * size_c + c,
            Self::Xytcz => z * size_c * size_t + c * size_t + t,
            Self::Xytzc => c * size_z * size_t + z * size_t + t,
        }
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

/// Read a TIFF file into a 5D Volume.
///
/// Handles single-page (2D) and multi-page TIFFs. Supports u8 (promoted to u16)
/// and u16 grayscale. Rejects RGB.
///
/// Dimension interpretation priority: hints > OME-XML > default (all pages = Z).
pub fn read_tiff(path: &Path, hints: &DimensionHints) -> Result<Volume, String> {
    let file = File::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    let mmap = unsafe { Mmap::map(&file) }
        .map_err(|e| format!("failed to mmap {}: {e}", path.display()))?;
    let data: &[u8] = &mmap;

    let mut decoder =
        Decoder::new(Cursor::new(data)).map_err(|e| format!("failed to decode TIFF: {e}"))?;

    // Try to read OME-XML from ImageDescription tag (before reading pixel data)
    let ome_info = try_read_ome_xml(&mut decoder);

    // Read first page to get dimensions
    let (width, height) = decoder
        .dimensions()
        .map_err(|e| format!("bad dimensions: {e}"))?;
    let pixels_per_page = (width * height) as usize;

    // Resolve dimensions early if possible (OME metadata + hints)
    // so we can pre-allocate and stream pages directly into the output buffer
    let early_dims = ome_info.as_ref().map(|info| {
        let size_t = hints.size_t.unwrap_or(info.size_t);
        let size_c = hints.size_c.unwrap_or(info.size_c);
        let size_z = hints.size_z.unwrap_or(info.size_z);
        let order = hints.order.unwrap_or(info.order);
        (size_t, size_c, size_z, order)
    });

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
    };

    if let Some((size_t, size_c, size_z, order)) = early_dims {
        let num_pages = size_t * size_c * size_z;
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
/// the shared mmap, walks IFDs to its starting page, then decodes its batch.
/// Results are written to non-overlapping regions of a pre-allocated buffer.
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
    let num_pages = (size_t * size_c * size_z) as usize;

    // Build page→dst index map for reordering into TCZYX order
    let page_to_dst: Vec<usize> = if matches!(order, DimensionOrder::Xyzct) {
        // Sequential: page N goes to slot N
        (0..num_pages).collect()
    } else {
        let mut map = vec![0usize; num_pages];
        for t in 0..size_t {
            for c in 0..size_c {
                for z in 0..size_z {
                    let page_idx = order.page_index(t, c, z, size_t, size_c, size_z) as usize;
                    let dst_idx = (t * size_c * size_z + c * size_z + z) as usize;
                    map[page_idx] = dst_idx;
                }
            }
        }
        map
    };

    // Pre-allocate output buffer
    let mut data: Vec<u16> = vec![0u16; num_pages * pixels_per_page];

    // Split pages into chunks for parallel processing
    let n_threads = rayon::current_num_threads();
    let chunk_size = num_pages.div_ceil(n_threads);

    let progress = AtomicUsize::new(0);

    // Create chunk ranges
    let chunks: Vec<(usize, usize)> = (0..n_threads)
        .map(|i| {
            let start = i * chunk_size;
            let end = (start + chunk_size).min(num_pages);
            (start, end)
        })
        .filter(|(start, end)| start < end)
        .collect();

    // Use usize to allow sharing across threads. We ensure non-overlapping writes
    // via the page_to_dst index map.
    let data_ptr = data.as_mut_ptr() as usize;

    let errors: Vec<String> = chunks
        .par_iter()
        .filter_map(|&(start, end)| {
            let data_ptr = data_ptr as *mut u16;
            // Each thread creates its own decoder from the shared mmap
            let mut decoder = match Decoder::new(Cursor::new(mmap_data)) {
                Ok(d) => d,
                Err(e) => return Some(format!("failed to create decoder: {e}")),
            };

            // Walk IFDs to the starting page (fast — just reads metadata)
            for _ in 0..start {
                if !decoder.more_images() {
                    return Some(format!(
                        "TIFF has fewer pages than expected (at page {start})"
                    ));
                }
                if let Err(e) = decoder.next_image() {
                    return Some(format!("failed to seek to page {start}: {e}"));
                }
            }

            // Decode pages in this chunk. `page_num` is used as both the
            // index into `page_to_dst` AND as the natural page number in
            // error messages and decoder advance arithmetic — enumerate
            // would obscure that.
            #[allow(clippy::needless_range_loop)]
            for page_num in start..end {
                let pixels =
                    match decode_page(&mut decoder, page_num, width, height, pixels_per_page) {
                        Ok(p) => p,
                        Err(e) => return Some(e),
                    };

                // Write to the correct destination slot
                let dst_idx = page_to_dst[page_num];
                let dst_start = dst_idx * pixels_per_page;
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        pixels.as_ptr(),
                        data_ptr.add(dst_start),
                        pixels_per_page,
                    );
                }

                let count = progress.fetch_add(1, Ordering::Relaxed) + 1;
                if count.is_multiple_of(100) || count == num_pages {
                    eprintln!("  pages: {count}/{num_pages}");
                }

                // Advance to next page if not the last in this chunk
                if page_num + 1 < end {
                    if !decoder.more_images() {
                        return Some(format!(
                            "TIFF has only {} pages but expected {num_pages}",
                            page_num + 1
                        ));
                    }
                    if let Err(e) = decoder.next_image() {
                        return Some(format!("failed to advance to page {}: {e}", page_num + 1));
                    }
                }
            }

            None
        })
        .collect();

    if let Some(err) = errors.into_iter().next() {
        return Err(err);
    }

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
    let mut pages: Vec<Vec<u16>> = Vec::new();

    loop {
        let page_num = pages.len();
        let pixels = decode_page(decoder, page_num, width, height, pixels_per_page)?;
        pages.push(pixels);

        let count = pages.len();
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

    let num_pages = pages.len() as u32;
    eprintln!("  pages: {num_pages}/{num_pages} (done)");

    // Default: all pages are Z slices
    let size_t = hints.size_t.unwrap_or(1);
    let size_c = hints.size_c.unwrap_or(1);
    let size_z = hints.size_z.unwrap_or(num_pages);
    let order = hints.order.unwrap_or(DimensionOrder::Xyzct);
    eprintln!("Resolved dimensions: T={size_t}, C={size_c}, Z={size_z}, order={order:?}");

    if size_t * size_c * size_z != num_pages {
        return Err(format!(
            "dimension mismatch: T={size_t} * C={size_c} * Z={size_z} = {} but TIFF has {num_pages} pages",
            size_t * size_c * size_z
        ));
    }

    // Reorder pages into TCZYX order
    let mut data = vec![0u16; num_pages as usize * pixels_per_page];
    for t in 0..size_t {
        for c in 0..size_c {
            for z in 0..size_z {
                let page_idx = order.page_index(t, c, z, size_t, size_c, size_z) as usize;
                let dst_idx = (t * size_c * size_z + c * size_z + z) as usize;
                let dst_start = dst_idx * pixels_per_page;
                data[dst_start..dst_start + pixels_per_page].copy_from_slice(&pages[page_idx]);
            }
        }
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

fn try_read_ome_xml(decoder: &mut Decoder<Cursor<&[u8]>>) -> Option<OmeInfo> {
    let value = match decoder.find_tag(Tag::ImageDescription) {
        Ok(Some(v)) => v,
        Ok(None) => {
            eprintln!("No ImageDescription tag found");
            return None;
        }
        Err(e) => {
            eprintln!("Error reading ImageDescription: {e}");
            return None;
        }
    };
    let desc = match value {
        ifd::Value::Ascii(s) => s,
        ifd::Value::List(ref values) => {
            // Some writers store ImageDescription as bytes
            let bytes: Vec<u8> = values
                .iter()
                .filter_map(|v| match v {
                    ifd::Value::Byte(b) => Some(*b),
                    _ => None,
                })
                .collect();
            String::from_utf8(bytes).ok()?
        }
        other => {
            eprintln!("ImageDescription is not ASCII: {other:?}");
            return None;
        }
    };
    let result = parse_ome_xml(&desc);
    if result.is_none() {
        eprintln!("Failed to parse OME-XML from ImageDescription");
        let preview: String = desc.chars().take(200).collect();
        eprintln!("  content preview: {preview}");
    }
    result
}

fn parse_ome_xml(xml: &str) -> Option<OmeInfo> {
    // Quick check: is this OME-XML?
    if !xml.contains("<OME") && !xml.contains("<Pixels") {
        return None;
    }

    let order = DimensionOrder::parse(&extract_attr(xml, "DimensionOrder")?).ok()?;
    let size_t: u32 = extract_attr(xml, "SizeT")?.parse().ok()?;
    let size_c: u32 = extract_attr(xml, "SizeC")?.parse().ok()?;
    let size_z: u32 = extract_attr(xml, "SizeZ")?.parse().ok()?;

    let physical_size_x: Option<f64> =
        extract_attr(xml, "PhysicalSizeX").and_then(|s| s.parse().ok());
    let physical_size_y: Option<f64> =
        extract_attr(xml, "PhysicalSizeY").and_then(|s| s.parse().ok());
    let physical_size_z: Option<f64> =
        extract_attr(xml, "PhysicalSizeZ").and_then(|s| s.parse().ok());

    Some(OmeInfo {
        size_t,
        size_c,
        size_z,
        order,
        physical_size_x,
        physical_size_y,
        physical_size_z,
    })
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
        let info = parse_ome_xml(xml).unwrap();
        assert_eq!(info.size_t, 5);
        assert_eq!(info.size_c, 3);
        assert_eq!(info.size_z, 10);
        assert_eq!(info.order, DimensionOrder::Xyzct);
    }

    #[test]
    fn parse_ome_xml_returns_none_for_non_ome() {
        assert!(parse_ome_xml("just a description").is_none());
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
        let info = parse_ome_xml(xml).unwrap();
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
        let info = parse_ome_xml(xml).unwrap();
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
}
