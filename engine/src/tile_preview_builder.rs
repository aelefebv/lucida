use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::channel_block::{
    ChannelBlockPackaging, ChannelBlockWriteRequest, PayloadCodec, PayloadKind,
};
use crate::model::{AxisName, AxisShape, SourceKind, TileLayout, TileLodLayout};
use crate::raster_plane::{RasterPlane, RasterPlaneLoadRequest, load_raster_plane};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TilePreviewBuildRequest {
    pub source_id: String,
    pub source_uri: String,
    pub source_kind: SourceKind,
    pub source_dtype: String,
    pub generation_seq: u64,
    pub generation_root: PathBuf,
    pub shape: AxisShape,
    pub axis_order: Vec<AxisName>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TilePreviewBuildResult {
    pub preview_path: PathBuf,
    pub tile_manifest_path: PathBuf,
    pub available_lods: Vec<u8>,
    pub tile_layout: TileLayout,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TilePreviewBuildError {
    IoError { path: String, message: String },
    SerializationError { message: String },
    DecodeError { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TilePreviewBuilder {
    tile_width: u16,
    tile_height: u16,
    payload_codec: PayloadCodec,
    channel_packaging: ChannelBlockPackaging,
}

impl Default for TilePreviewBuilder {
    fn default() -> Self {
        Self {
            tile_width: 512,
            tile_height: 512,
            payload_codec: PayloadCodec::Raw,
            channel_packaging: ChannelBlockPackaging::new(4),
        }
    }
}

impl TilePreviewBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn build(
        &self,
        request: &TilePreviewBuildRequest,
    ) -> Result<TilePreviewBuildResult, TilePreviewBuildError> {
        let tile_root = request.generation_root.join("tile2d");
        let preview_root = request.generation_root.join("preview2d");
        fs::create_dir_all(&tile_root).map_err(|error| TilePreviewBuildError::IoError {
            path: tile_root.display().to_string(),
            message: error.to_string(),
        })?;
        fs::create_dir_all(&preview_root).map_err(|error| TilePreviewBuildError::IoError {
            path: preview_root.display().to_string(),
            message: error.to_string(),
        })?;

        let lods = compute_lods(request.shape.y.max(1), request.shape.x.max(1));
        let lod_descriptors = lods
            .iter()
            .copied()
            .map(|lod| lod_descriptor(lod, &request.shape, self.tile_width, self.tile_height))
            .collect::<Vec<_>>();
        let default_channel_block_size = self.channel_packaging.default_block_size();
        let selections = plane_selections(&request.shape);
        write_manifest(
            &tile_root,
            &request.source_id,
            request.generation_seq,
            &lod_descriptors,
            default_channel_block_size,
        )?;
        for selection in &selections {
            let base_plane = load_raster_plane(&RasterPlaneLoadRequest {
                source_uri: request.source_uri.clone(),
                source_kind: request.source_kind,
                dtype: request.source_dtype.clone(),
                axis_order: request.axis_order.clone(),
                shape: request.shape.clone(),
                t_index: selection.t,
                z_index: selection.z,
                channel_index: selection.channel_index,
            })
            .map_err(|error| TilePreviewBuildError::DecodeError {
                message: format!("{error:?}"),
            })?;
            let lod_planes = build_lod_planes(&base_plane, &lods);
            write_tiles_for_selection(
                &tile_root,
                &lod_descriptors,
                &lod_planes,
                request.shape.c.max(1).min(u64::from(u16::MAX)) as u16,
                self.payload_codec,
                &self.channel_packaging,
                selection.t,
                selection.z,
                selection.channel_block,
            )?;
            write_preview_images_for_selection(
                &preview_root,
                &lod_descriptors,
                &lod_planes,
                selection.t,
                selection.z,
                selection.channel_block,
            )?;
            if selection.t == 0 && selection.z == 0 && selection.channel_block == 0 {
                write_legacy_preview_images(&preview_root, &lod_descriptors, &lod_planes)?;
            }
        }

        let coarsest_lod = *lods
            .iter()
            .max()
            .expect("lod list should always contain at least one value");
        let preview_path = preview_root.join(format!("lod_{coarsest_lod}.pgm"));

        Ok(TilePreviewBuildResult {
            preview_path,
            tile_manifest_path: tile_root.join("manifest.json"),
            available_lods: lods,
            tile_layout: TileLayout {
                default_channel_block_size,
                lods: lod_descriptors
                    .iter()
                    .map(|descriptor| TileLodLayout {
                        lod: descriptor.lod,
                        width: descriptor.width,
                        height: descriptor.height,
                        tile_width: descriptor.tile_width,
                        tile_height: descriptor.tile_height,
                        rows: descriptor.rows,
                        cols: descriptor.cols,
                    })
                    .collect::<Vec<_>>(),
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct LodDescriptor {
    lod: u8,
    width: u64,
    height: u64,
    tile_width: u16,
    tile_height: u16,
    rows: u32,
    cols: u32,
}

fn compute_lods(height: u64, width: u64) -> Vec<u8> {
    let mut lods = vec![0_u8];
    let mut lod = 0_u8;
    let mut y = height.max(1);
    let mut x = width.max(1);
    while y > 1 || x > 1 {
        lod = lod.saturating_add(1);
        y = y.div_ceil(2).max(1);
        x = x.div_ceil(2).max(1);
        lods.push(lod);
    }
    lods
}

fn lod_descriptor(lod: u8, shape: &AxisShape, tile_width: u16, tile_height: u16) -> LodDescriptor {
    let width = downsample_dimension(shape.x.max(1), lod);
    let height = downsample_dimension(shape.y.max(1), lod);
    let cols = width.div_ceil(u64::from(tile_width)) as u32;
    let rows = height.div_ceil(u64::from(tile_height)) as u32;
    LodDescriptor {
        lod,
        width,
        height,
        tile_width,
        tile_height,
        rows,
        cols,
    }
}

fn downsample_dimension(value: u64, lod: u8) -> u64 {
    let mut current = value.max(1);
    for _ in 0..lod {
        current = current.div_ceil(2).max(1);
    }
    current
}

fn write_manifest(
    tile_root: &Path,
    source_id: &str,
    generation_seq: u64,
    lods: &[LodDescriptor],
    default_channel_block_size: u16,
) -> Result<(), TilePreviewBuildError> {
    let manifest_path = tile_root.join("manifest.json");
    let manifest = json!({
        "source_id": source_id,
        "generation_seq": generation_seq,
        "tile_shape": [lods.first().map_or(512, |lod| lod.tile_height), lods.first().map_or(512, |lod| lod.tile_width)],
        "default_channel_block_size": default_channel_block_size,
        "lods": lods
    });
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| {
        TilePreviewBuildError::SerializationError {
            message: error.to_string(),
        }
    })?;
    fs::write(&manifest_path, bytes).map_err(|error| TilePreviewBuildError::IoError {
        path: manifest_path.display().to_string(),
        message: error.to_string(),
    })?;
    Ok(())
}

fn write_tiles_for_selection(
    tile_root: &Path,
    lods: &[LodDescriptor],
    lod_planes: &std::collections::BTreeMap<u8, RasterPlane>,
    channel_count: u16,
    codec: PayloadCodec,
    packaging: &ChannelBlockPackaging,
    t_index: u64,
    z_index: u64,
    channel_block: u64,
) -> Result<(), TilePreviewBuildError> {
    for descriptor in lods {
        let lod_dir = tile_root.join(format!("lod{}", descriptor.lod));
        fs::create_dir_all(&lod_dir).map_err(|error| TilePreviewBuildError::IoError {
            path: lod_dir.display().to_string(),
            message: error.to_string(),
        })?;
        let plane = lod_planes
            .get(&descriptor.lod)
            .expect("every lod descriptor should have raster pixels");
        for row in 0..descriptor.rows {
            for col in 0..descriptor.cols {
                let tile_plane = tile_plane_for_cell(
                    plane,
                    row,
                    col,
                    descriptor.tile_height,
                    descriptor.tile_width,
                )?;
                let tile_path = lod_dir.join(format!(
                    "t{t_index}_z{z_index}_cb{channel_block}_r{row}_c{col}.tileblk"
                ));
                let tile_payload = encode_pgm(
                    tile_plane.width,
                    tile_plane.height,
                    tile_plane.max_value,
                    &tile_plane.pixels,
                )?;
                let encoded_payload = packaging
                    .encode(&ChannelBlockWriteRequest {
                        payload_kind: PayloadKind::Image,
                        codec,
                        channel_count,
                        channel_block_size_override: None,
                        payload: tile_payload,
                    })
                    .map_err(|error| TilePreviewBuildError::SerializationError {
                        message: format!("channel block encoding failed: {error:?}"),
                    })?;
                fs::write(&tile_path, encoded_payload).map_err(|error| {
                    TilePreviewBuildError::IoError {
                        path: tile_path.display().to_string(),
                        message: error.to_string(),
                    }
                })?;
            }
        }
    }
    Ok(())
}

fn tile_plane_for_cell(
    plane: &RasterPlane,
    row: u32,
    col: u32,
    tile_height: u16,
    tile_width: u16,
) -> Result<RasterPlane, TilePreviewBuildError> {
    let source_width =
        usize::try_from(plane.width).map_err(|_| TilePreviewBuildError::SerializationError {
            message: "source plane width overflows usize".to_owned(),
        })?;
    let source_height =
        usize::try_from(plane.height).map_err(|_| TilePreviewBuildError::SerializationError {
            message: "source plane height overflows usize".to_owned(),
        })?;
    let tile_start_y = (row as usize).saturating_mul(tile_height as usize);
    let tile_start_x = (col as usize).saturating_mul(tile_width as usize);
    let tile_end_y = tile_start_y
        .saturating_add(tile_height as usize)
        .min(source_height);
    let tile_end_x = tile_start_x
        .saturating_add(tile_width as usize)
        .min(source_width);

    if tile_start_y >= source_height || tile_start_x >= source_width {
        return Err(TilePreviewBuildError::SerializationError {
            message: format!(
                "tile coordinates out of bounds: row={row} col={col} source={source_width}x{source_height}"
            ),
        });
    }

    let tile_width_px = tile_end_x.saturating_sub(tile_start_x);
    let tile_height_px = tile_end_y.saturating_sub(tile_start_y);
    let mut pixels = Vec::with_capacity(tile_width_px.saturating_mul(tile_height_px));
    for y in tile_start_y..tile_end_y {
        let row_start = y
            .checked_mul(source_width)
            .and_then(|offset| offset.checked_add(tile_start_x))
            .ok_or_else(|| TilePreviewBuildError::SerializationError {
                message: "source row start overflow while slicing tile".to_owned(),
            })?;
        let row_end = row_start.checked_add(tile_width_px).ok_or_else(|| {
            TilePreviewBuildError::SerializationError {
                message: "source row end overflow while slicing tile".to_owned(),
            }
        })?;
        pixels.extend_from_slice(plane.pixels.get(row_start..row_end).ok_or_else(|| {
            TilePreviewBuildError::SerializationError {
                message: "source row slice out of bounds while slicing tile".to_owned(),
            }
        })?);
    }

    Ok(RasterPlane {
        width: tile_width_px as u64,
        height: tile_height_px as u64,
        max_value: plane.max_value,
        pixels,
    })
}

fn write_preview_images_for_selection(
    preview_root: &Path,
    lods: &[LodDescriptor],
    lod_planes: &std::collections::BTreeMap<u8, RasterPlane>,
    t_index: u64,
    z_index: u64,
    channel_block: u64,
) -> Result<(), TilePreviewBuildError> {
    for descriptor in lods {
        let lod_dir = preview_root.join(format!("lod{}", descriptor.lod));
        fs::create_dir_all(&lod_dir).map_err(|error| TilePreviewBuildError::IoError {
            path: lod_dir.display().to_string(),
            message: error.to_string(),
        })?;
        let preview_path = lod_dir.join(format!("t{t_index}_z{z_index}_cb{channel_block}.pgm"));
        let plane = lod_planes
            .get(&descriptor.lod)
            .expect("lod plane should be available for every descriptor");
        write_preview_image(&preview_path, plane)?;
    }
    Ok(())
}

fn write_legacy_preview_images(
    preview_root: &Path,
    lods: &[LodDescriptor],
    lod_planes: &std::collections::BTreeMap<u8, RasterPlane>,
) -> Result<(), TilePreviewBuildError> {
    for descriptor in lods {
        let preview_path = preview_root.join(format!("lod_{}.pgm", descriptor.lod));
        let plane = lod_planes
            .get(&descriptor.lod)
            .expect("lod plane should be available for every descriptor");
        write_preview_image(&preview_path, plane)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PlaneSelection {
    t: u64,
    z: u64,
    channel_index: u64,
    channel_block: u64,
}

fn plane_selections(shape: &AxisShape) -> Vec<PlaneSelection> {
    let mut selections = Vec::new();
    for t in 0..shape.t.max(1) {
        for z in 0..shape.z.max(1) {
            for channel_index in 0..shape.c.max(1) {
                selections.push(PlaneSelection {
                    t,
                    z,
                    channel_index,
                    channel_block: channel_index,
                });
            }
        }
    }
    selections
}

fn write_preview_image(
    preview_path: &Path,
    plane: &RasterPlane,
) -> Result<(), TilePreviewBuildError> {
    let bytes = encode_pgm(plane.width, plane.height, plane.max_value, &plane.pixels)?;

    fs::write(preview_path, bytes).map_err(|error| TilePreviewBuildError::IoError {
        path: preview_path.display().to_string(),
        message: error.to_string(),
    })?;
    Ok(())
}

fn build_lod_planes(
    base: &RasterPlane,
    lods: &[u8],
) -> std::collections::BTreeMap<u8, RasterPlane> {
    let mut planes = std::collections::BTreeMap::new();
    planes.insert(0, base.clone());

    let max_lod = *lods.iter().max().unwrap_or(&0);
    for lod in 1..=max_lod {
        let previous = planes
            .get(&(lod - 1))
            .expect("previous lod must exist before building next lod");
        planes.insert(lod, downsample_half(previous));
    }

    planes
}

fn downsample_half(source: &RasterPlane) -> RasterPlane {
    let source_width = source.width as usize;
    let source_height = source.height as usize;
    let target_width = source_width.div_ceil(2).max(1);
    let target_height = source_height.div_ceil(2).max(1);
    let mut pixels = vec![0_u16; target_width * target_height];

    for target_y in 0..target_height {
        for target_x in 0..target_width {
            let source_x = target_x * 2;
            let source_y = target_y * 2;
            let mut sum = 0_u64;
            let mut count = 0_u64;

            for offset_y in 0..2 {
                for offset_x in 0..2 {
                    let sample_x = source_x + offset_x;
                    let sample_y = source_y + offset_y;
                    if sample_x >= source_width || sample_y >= source_height {
                        continue;
                    }
                    let index = sample_y * source_width + sample_x;
                    sum += u64::from(source.pixels[index]);
                    count += 1;
                }
            }

            let target_index = target_y * target_width + target_x;
            pixels[target_index] = if count == 0 { 0 } else { (sum / count) as u16 };
        }
    }

    RasterPlane {
        width: target_width as u64,
        height: target_height as u64,
        max_value: source.max_value,
        pixels,
    }
}

fn encode_pgm(
    width: u64,
    height: u64,
    max_value: u16,
    pixels: &[u16],
) -> Result<Vec<u8>, TilePreviewBuildError> {
    let expected_pixels = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| TilePreviewBuildError::SerializationError {
            message: "PGM dimensions overflow".to_owned(),
        })?;
    if pixels.len() != expected_pixels {
        return Err(TilePreviewBuildError::SerializationError {
            message: format!(
                "PGM payload length mismatch: expected {expected_pixels}, got {}",
                pixels.len()
            ),
        });
    }

    if max_value == 0 {
        return Err(TilePreviewBuildError::SerializationError {
            message: "PGM max value must be greater than zero".to_owned(),
        });
    }
    let mut bytes = format!("P5\n{width} {height}\n{max_value}\n").into_bytes();
    if max_value <= 255 {
        for pixel in pixels {
            bytes.push((*pixel).min(max_value) as u8);
        }
    } else {
        for pixel in pixels {
            let clamped = (*pixel).min(max_value);
            bytes.extend_from_slice(&clamped.to_be_bytes());
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs::File;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::channel_block::ChannelBlockPackaging;
    use crate::model::{AxisName, AxisShape, SourceKind};

    use super::{TilePreviewBuildRequest, TilePreviewBuilder};

    fn unique_path(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida_luc204_{prefix}_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    fn write_test_tiff(path: &Path, width: u32, height: u32, pixels: &[u8]) {
        let file = File::create(path).expect("test tiff file should be created");
        let mut encoder =
            tiff::encoder::TiffEncoder::new(file).expect("tiff encoder creation should succeed");
        let image = encoder
            .new_image::<tiff::encoder::colortype::Gray8>(width, height)
            .expect("tiff image creation should succeed");
        image
            .write_data(pixels)
            .expect("tiff pixel payload write should succeed");
    }

    fn write_test_tiff_u16(path: &Path, width: u32, height: u32, pixels: &[u16]) {
        let file = File::create(path).expect("test tiff file should be created");
        let mut encoder =
            tiff::encoder::TiffEncoder::new(file).expect("tiff encoder creation should succeed");
        let image = encoder
            .new_image::<tiff::encoder::colortype::Gray16>(width, height)
            .expect("tiff image creation should succeed");
        image
            .write_data(pixels)
            .expect("tiff pixel payload write should succeed");
    }

    fn write_test_omezarr(path: &Path, width: u64, height: u64, pixels: &[u8]) {
        std::fs::create_dir_all(path.join("0")).expect("ome-zarr data group should be created");
        std::fs::write(
            path.join(".zattrs"),
            r#"{"multiscales":[{"version":"0.4","axes":[{"name":"t"},{"name":"c"},{"name":"z"},{"name":"y"},{"name":"x"}],"datasets":[{"path":"0"}]}]}"#,
        )
        .expect("ome-zarr attrs should be written");
        std::fs::write(
            path.join("0").join(".zarray"),
            format!(
                "{{\"zarr_format\":2,\"shape\":[1,1,1,{height},{width}],\"chunks\":[1,1,1,{height},{width}],\"dtype\":\"|u1\",\"compressor\":null,\"fill_value\":0,\"order\":\"C\",\"filters\":null}}"
            ),
        )
        .expect("ome-zarr array descriptor should be written");
        std::fs::write(path.join("0").join("0.0.0.0.0"), pixels)
            .expect("ome-zarr chunk should be written");
    }

    fn parse_pgm_u16(payload: &[u8]) -> (u64, u64, u16, Vec<u16>) {
        let mut newline_indices = payload
            .iter()
            .enumerate()
            .filter_map(|(index, byte)| (*byte == b'\n').then_some(index));
        let magic_end = newline_indices
            .next()
            .expect("pgm payload should include magic line");
        let dims_end = newline_indices
            .next()
            .expect("pgm payload should include dimensions line");
        let max_value_end = newline_indices
            .next()
            .expect("pgm payload should include max-value line");

        let magic = std::str::from_utf8(&payload[..magic_end]).expect("pgm magic should be utf-8");
        assert_eq!(magic, "P5");

        let dims = std::str::from_utf8(&payload[(magic_end + 1)..dims_end])
            .expect("pgm dimensions should be utf-8");
        let mut dims_parts = dims.split_ascii_whitespace();
        let width = dims_parts
            .next()
            .expect("pgm dimensions should include width")
            .parse::<u64>()
            .expect("pgm width should parse as u64");
        let height = dims_parts
            .next()
            .expect("pgm dimensions should include height")
            .parse::<u64>()
            .expect("pgm height should parse as u64");
        let max_value = std::str::from_utf8(&payload[(dims_end + 1)..max_value_end])
            .expect("pgm max value should be utf-8")
            .parse::<u16>()
            .expect("pgm max value should parse as u16");

        let body = &payload[(max_value_end + 1)..];
        let expected_pixels = (width as usize)
            .checked_mul(height as usize)
            .expect("pgm dimensions should not overflow");
        let pixels = if max_value <= 255 {
            assert_eq!(body.len(), expected_pixels);
            body.iter().copied().map(u16::from).collect::<Vec<_>>()
        } else {
            assert_eq!(body.len(), expected_pixels * 2);
            body.chunks_exact(2)
                .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
                .collect::<Vec<_>>()
        };
        (width, height, max_value, pixels)
    }

    #[test]
    fn builds_preview_and_tile_manifest_from_source_pixels() {
        let generation_root = unique_path("generation");
        let fixture_root = unique_path("fixture");
        std::fs::create_dir_all(&generation_root).expect("generation root should be created");
        std::fs::create_dir_all(&fixture_root).expect("fixture root should be created");
        let source_path = fixture_root.join("source.tiff");
        let source_pixels: Vec<u8> = vec![
            0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240,
        ];
        write_test_tiff(&source_path, 4, 4, &source_pixels);
        let builder = TilePreviewBuilder::new();

        let result = builder
            .build(&TilePreviewBuildRequest {
                source_id: "src_00000001".to_owned(),
                source_uri: source_path.display().to_string(),
                source_kind: SourceKind::Tiff,
                source_dtype: "uint8".to_owned(),
                generation_seq: 1,
                generation_root: generation_root.clone(),
                shape: AxisShape {
                    t: 1,
                    c: 3,
                    z: 1,
                    y: 4,
                    x: 4,
                    extra_axes: BTreeMap::new(),
                },
                axis_order: vec![
                    AxisName::T,
                    AxisName::C,
                    AxisName::Z,
                    AxisName::Y,
                    AxisName::X,
                ],
            })
            .expect("tile/preview build should succeed");

        assert!(result.preview_path.exists());
        assert!(result.tile_manifest_path.exists());
        assert!(result.available_lods.len() > 1);
        let channel_packaging = ChannelBlockPackaging::default();
        let tile_payload_path = generation_root
            .join("tile2d")
            .join("lod0")
            .join("t0_z0_cb0_r0_c0.tileblk");
        let tile_bytes =
            std::fs::read(&tile_payload_path).expect("tile payload read should succeed");
        let decoded_tile = channel_packaging
            .decode(&tile_bytes)
            .expect("tile payload decode should succeed");
        assert_eq!(decoded_tile.channel_block_size, 3);
        assert!(decoded_tile.payload.starts_with(b"P5\n4 4\n255\n"));
        assert!(decoded_tile.payload.ends_with(&source_pixels));
        let manifest = std::fs::read_to_string(&result.tile_manifest_path)
            .expect("manifest read should succeed");
        assert!(manifest.contains("\"lods\""));
        assert!(manifest.contains("\"default_channel_block_size\""));
        assert!(generation_root.join("tile2d").join("lod0").exists());
        let preview_bytes =
            std::fs::read(&result.preview_path).expect("preview should be readable");
        assert!(preview_bytes.starts_with(b"P5\n1 1\n255\n"));

        std::fs::remove_dir_all(generation_root).expect("fixture cleanup should succeed");
        std::fs::remove_dir_all(fixture_root).expect("fixture cleanup should succeed");
    }

    #[test]
    fn builds_preview_and_tiles_from_omezarr_pixels() {
        let generation_root = unique_path("generation_omezarr");
        let fixture_root = unique_path("fixture_omezarr").with_extension("ome.zarr");
        std::fs::create_dir_all(&generation_root).expect("generation root should be created");
        let source_pixels: Vec<u8> = vec![10, 20, 30, 40, 50, 60];
        write_test_omezarr(&fixture_root, 3, 2, &source_pixels);

        let builder = TilePreviewBuilder::new();
        let result = builder
            .build(&TilePreviewBuildRequest {
                source_id: "src_omezarr".to_owned(),
                source_uri: fixture_root.display().to_string(),
                source_kind: SourceKind::OmeZarr,
                source_dtype: "uint8".to_owned(),
                generation_seq: 1,
                generation_root: generation_root.clone(),
                shape: AxisShape {
                    t: 1,
                    c: 1,
                    z: 1,
                    y: 2,
                    x: 3,
                    extra_axes: BTreeMap::new(),
                },
                axis_order: vec![
                    AxisName::T,
                    AxisName::C,
                    AxisName::Z,
                    AxisName::Y,
                    AxisName::X,
                ],
            })
            .expect("tile/preview build should succeed");

        let preview_lod0 = std::fs::read(generation_root.join("preview2d").join("lod_0.pgm"))
            .expect("lod0 preview should be readable");
        assert!(preview_lod0.starts_with(b"P5\n3 2\n255\n"));
        assert!(preview_lod0.ends_with(&source_pixels));
        assert!(result.preview_path.exists());

        std::fs::remove_dir_all(generation_root).expect("generation cleanup should succeed");
        std::fs::remove_dir_all(fixture_root).expect("fixture cleanup should succeed");
    }

    #[test]
    fn builds_preview_and_tiles_from_uint16_tiff_without_8bit_clamping() {
        let generation_root = unique_path("generation_uint16");
        let fixture_root = unique_path("fixture_uint16");
        std::fs::create_dir_all(&generation_root).expect("generation root should be created");
        std::fs::create_dir_all(&fixture_root).expect("fixture root should be created");

        let source_path = fixture_root.join("source_uint16.tiff");
        let source_pixels: Vec<u16> = vec![87, 98, 109, 121];
        write_test_tiff_u16(&source_path, 2, 2, &source_pixels);
        let builder = TilePreviewBuilder::new();
        let result = builder
            .build(&TilePreviewBuildRequest {
                source_id: "src_uint16".to_owned(),
                source_uri: source_path.display().to_string(),
                source_kind: SourceKind::Tiff,
                source_dtype: "uint16".to_owned(),
                generation_seq: 1,
                generation_root: generation_root.clone(),
                shape: AxisShape {
                    t: 1,
                    c: 1,
                    z: 1,
                    y: 2,
                    x: 2,
                    extra_axes: BTreeMap::new(),
                },
                axis_order: vec![
                    AxisName::T,
                    AxisName::C,
                    AxisName::Z,
                    AxisName::Y,
                    AxisName::X,
                ],
            })
            .expect("tile/preview build should succeed");

        let channel_packaging = ChannelBlockPackaging::default();
        let tile_payload_path = generation_root
            .join("tile2d")
            .join("lod0")
            .join("t0_z0_cb0_r0_c0.tileblk");
        let tile_bytes =
            std::fs::read(&tile_payload_path).expect("tile payload read should succeed");
        let decoded_tile = channel_packaging
            .decode(&tile_bytes)
            .expect("tile payload decode should succeed");
        let (tile_width, tile_height, tile_max, tile_pixels) = parse_pgm_u16(&decoded_tile.payload);
        assert_eq!(tile_width, 2);
        assert_eq!(tile_height, 2);
        assert_eq!(tile_max, u16::MAX);
        assert_eq!(tile_pixels, source_pixels);

        let preview_lod0 = std::fs::read(generation_root.join("preview2d").join("lod_0.pgm"))
            .expect("lod0 preview should be readable");
        let (preview_width, preview_height, preview_max, preview_pixels) =
            parse_pgm_u16(&preview_lod0);
        assert_eq!(preview_width, 2);
        assert_eq!(preview_height, 2);
        assert_eq!(preview_max, u16::MAX);
        assert_eq!(preview_pixels, source_pixels);
        assert!(result.preview_path.exists());

        std::fs::remove_dir_all(generation_root).expect("generation cleanup should succeed");
        std::fs::remove_dir_all(fixture_root).expect("fixture cleanup should succeed");
    }

    #[test]
    fn builds_multiple_tiles_when_plane_exceeds_tile_dimensions() {
        let generation_root = unique_path("generation_multitile");
        let fixture_root = unique_path("fixture_multitile");
        std::fs::create_dir_all(&generation_root).expect("generation root should be created");
        std::fs::create_dir_all(&fixture_root).expect("fixture root should be created");

        let source_path = fixture_root.join("source_multitile.tiff");
        let width = 600_u32;
        let height = 600_u32;
        let source_pixels = vec![127_u8; (width as usize) * (height as usize)];
        write_test_tiff(&source_path, width, height, &source_pixels);

        let builder = TilePreviewBuilder::new();
        let _result = builder
            .build(&TilePreviewBuildRequest {
                source_id: "src_multitile".to_owned(),
                source_uri: source_path.display().to_string(),
                source_kind: SourceKind::Tiff,
                source_dtype: "uint8".to_owned(),
                generation_seq: 1,
                generation_root: generation_root.clone(),
                shape: AxisShape {
                    t: 1,
                    c: 1,
                    z: 1,
                    y: u64::from(height),
                    x: u64::from(width),
                    extra_axes: BTreeMap::new(),
                },
                axis_order: vec![
                    AxisName::T,
                    AxisName::C,
                    AxisName::Z,
                    AxisName::Y,
                    AxisName::X,
                ],
            })
            .expect("tile/preview build should succeed");

        let channel_packaging = ChannelBlockPackaging::default();
        let lod0_dir = generation_root.join("tile2d").join("lod0");
        let tile00_path = lod0_dir.join("t0_z0_cb0_r0_c0.tileblk");
        let tile01_path = lod0_dir.join("t0_z0_cb0_r0_c1.tileblk");
        let tile10_path = lod0_dir.join("t0_z0_cb0_r1_c0.tileblk");
        let tile11_path = lod0_dir.join("t0_z0_cb0_r1_c1.tileblk");
        assert!(tile00_path.exists(), "tile r0 c0 should exist");
        assert!(tile01_path.exists(), "tile r0 c1 should exist");
        assert!(tile10_path.exists(), "tile r1 c0 should exist");
        assert!(tile11_path.exists(), "tile r1 c1 should exist");

        let tile00 = channel_packaging
            .decode(&std::fs::read(&tile00_path).expect("tile 00 payload should be readable"))
            .expect("tile 00 payload should decode");
        let tile01 = channel_packaging
            .decode(&std::fs::read(&tile01_path).expect("tile 01 payload should be readable"))
            .expect("tile 01 payload should decode");
        let tile10 = channel_packaging
            .decode(&std::fs::read(&tile10_path).expect("tile 10 payload should be readable"))
            .expect("tile 10 payload should decode");
        let tile11 = channel_packaging
            .decode(&std::fs::read(&tile11_path).expect("tile 11 payload should be readable"))
            .expect("tile 11 payload should decode");

        let (w00, h00, _, _) = parse_pgm_u16(&tile00.payload);
        let (w01, h01, _, _) = parse_pgm_u16(&tile01.payload);
        let (w10, h10, _, _) = parse_pgm_u16(&tile10.payload);
        let (w11, h11, _, _) = parse_pgm_u16(&tile11.payload);
        assert_eq!((w00, h00), (512, 512));
        assert_eq!((w01, h01), (88, 512));
        assert_eq!((w10, h10), (512, 88));
        assert_eq!((w11, h11), (88, 88));

        std::fs::remove_dir_all(generation_root).expect("generation cleanup should succeed");
        std::fs::remove_dir_all(fixture_root).expect("fixture cleanup should succeed");
    }
}
