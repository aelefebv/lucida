use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use tiff::decoder::ifd;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;
use tiff::ColorType;

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
}

/// Dimension info parsed from OME-XML.
struct OmeInfo {
    size_t: u32,
    size_c: u32,
    size_z: u32,
    order: DimensionOrder,
}

/// A 5D volume of u16 pixel data read from a TIFF file.
///
/// Data is stored in TCZYX order (T outermost, X innermost).
pub struct Volume {
    pub data: Vec<u16>,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub channels: u32,
    pub timepoints: u32,
}

/// Read a TIFF file into a 5D Volume.
///
/// Handles single-page (2D) and multi-page TIFFs. Supports u8 (promoted to u16)
/// and u16 grayscale. Rejects RGB.
///
/// Dimension interpretation priority: hints > OME-XML > default (all pages = Z).
pub fn read_tiff(path: &Path, hints: &DimensionHints) -> Result<Volume, String> {
    let file = File::open(path).map_err(|e| format!("failed to open {}: {e}", path.display()))?;
    let mut decoder =
        Decoder::new(BufReader::new(file)).map_err(|e| format!("failed to decode TIFF: {e}"))?;

    // Try to read OME-XML from ImageDescription tag (before reading pixel data)
    let ome_info = try_read_ome_xml(&mut decoder);

    let mut pages: Vec<Vec<u16>> = Vec::new();
    let mut width = 0u32;
    let mut height = 0u32;

    loop {
        let (w, h) = decoder.dimensions().map_err(|e| format!("bad dimensions: {e}"))?;
        if pages.is_empty() {
            width = w;
            height = h;
        } else if w != width || h != height {
            return Err(format!(
                "page {} has dimensions {w}x{h}, expected {width}x{height}",
                pages.len()
            ));
        }

        let color = decoder.colortype().map_err(|e| format!("bad color type: {e}"))?;
        match color {
            ColorType::Gray(8) | ColorType::Gray(16) => {}
            _ => return Err(format!("unsupported color type: {color:?} (only Gray8/Gray16)")),
        }

        let image = decoder.read_image().map_err(|e| format!("failed to read image data: {e}"))?;
        let pixels = match image {
            DecodingResult::U8(data) => data.into_iter().map(|v| v as u16).collect(),
            DecodingResult::U16(data) => data,
            _ => return Err("unexpected pixel format".into()),
        };

        if pixels.len() != (width * height) as usize {
            return Err(format!(
                "page {} has {} pixels, expected {}",
                pages.len(),
                pixels.len(),
                width * height
            ));
        }

        pages.push(pixels);

        if decoder.more_images() {
            decoder.next_image().map_err(|e| format!("failed to advance to next page: {e}"))?;
        } else {
            break;
        }
    }

    let num_pages = pages.len() as u32;

    // Resolve dimensions: hints override OME-XML, which overrides defaults
    let (size_t, size_c, size_z, order) = resolve_dimensions(&ome_info, hints, num_pages)?;
    eprintln!("Resolved dimensions: T={size_t}, C={size_c}, Z={size_z}, order={order:?}");

    if size_t * size_c * size_z != num_pages {
        return Err(format!(
            "dimension mismatch: T={size_t} * C={size_c} * Z={size_z} = {} but TIFF has {num_pages} pages",
            size_t * size_c * size_z
        ));
    }

    // Reorder pages into TCZYX order
    let pixels_per_page = (width * height) as usize;
    let mut data = vec![0u16; num_pages as usize * pixels_per_page];
    for t in 0..size_t {
        for c in 0..size_c {
            for z in 0..size_z {
                let page_idx = order.page_index(t, c, z, size_t, size_c, size_z) as usize;
                let dst_idx = (t * size_c * size_z + c * size_z + z) as usize;
                data[dst_idx * pixels_per_page..(dst_idx + 1) * pixels_per_page]
                    .copy_from_slice(&pages[page_idx]);
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
    })
}

fn resolve_dimensions(
    ome: &Option<OmeInfo>,
    hints: &DimensionHints,
    num_pages: u32,
) -> Result<(u32, u32, u32, DimensionOrder), String> {
    let (base_t, base_c, base_z, base_order) = match ome {
        Some(info) => (info.size_t, info.size_c, info.size_z, info.order),
        None => (1, 1, num_pages, DimensionOrder::Xyzct),
    };

    let size_t = hints.size_t.unwrap_or(base_t);
    let size_c = hints.size_c.unwrap_or(base_c);
    let size_z = hints.size_z.unwrap_or(base_z);
    let order = hints.order.unwrap_or(base_order);

    Ok((size_t, size_c, size_z, order))
}

fn try_read_ome_xml<R: std::io::Read + std::io::Seek>(
    decoder: &mut Decoder<R>,
) -> Option<OmeInfo> {
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

    Some(OmeInfo {
        size_t,
        size_c,
        size_z,
        order,
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
        let (t, c, z, order) = resolve_dimensions(&None, &DimensionHints::default(), 30).unwrap();
        assert_eq!(t, 1);
        assert_eq!(c, 1);
        assert_eq!(z, 30);
        assert_eq!(order, DimensionOrder::Xyzct);
    }

    #[test]
    fn hints_override_ome() {
        let ome = Some(OmeInfo {
            size_t: 5,
            size_c: 3,
            size_z: 10,
            order: DimensionOrder::Xyzct,
        });
        let hints = DimensionHints {
            size_t: Some(2),
            size_c: None,
            size_z: Some(25),
            order: None,
        };
        let (t, c, z, order) = resolve_dimensions(&ome, &hints, 150).unwrap();
        assert_eq!(t, 2);
        assert_eq!(c, 3); // from OME
        assert_eq!(z, 25); // from hint
        assert_eq!(order, DimensionOrder::Xyzct); // from OME
    }
}
