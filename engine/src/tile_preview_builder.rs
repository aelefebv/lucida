use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::channel_block::{
    ChannelBlockPackaging, ChannelBlockWriteRequest, PayloadCodec, PayloadKind,
};
use crate::model::AxisShape;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TilePreviewBuildRequest {
    pub source_id: String,
    pub generation_seq: u64,
    pub generation_root: PathBuf,
    pub shape: AxisShape,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TilePreviewBuildResult {
    pub preview_path: PathBuf,
    pub tile_manifest_path: PathBuf,
    pub available_lods: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TilePreviewBuildError {
    IoError { path: String, message: String },
    SerializationError { message: String },
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
            payload_codec: PayloadCodec::Lz4,
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
        write_manifest(
            &tile_root,
            &request.source_id,
            request.generation_seq,
            &lod_descriptors,
            self.channel_packaging.default_block_size(),
        )?;
        write_placeholder_tiles(
            &tile_root,
            &lod_descriptors,
            request.shape.c.min(u64::from(u16::MAX)) as u16,
            self.payload_codec,
            &self.channel_packaging,
        )?;

        let coarsest_lod = *lods
            .iter()
            .max()
            .expect("lod list should always contain at least one value");
        let preview_descriptor = lod_descriptor(
            coarsest_lod,
            &request.shape,
            self.tile_width,
            self.tile_height,
        );
        let preview_path = preview_root.join(format!("lod_{coarsest_lod}.pgm"));
        write_preview_image(
            &preview_path,
            preview_descriptor.width,
            preview_descriptor.height,
        )?;

        Ok(TilePreviewBuildResult {
            preview_path,
            tile_manifest_path: tile_root.join("manifest.json"),
            available_lods: lods,
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

fn write_placeholder_tiles(
    tile_root: &Path,
    lods: &[LodDescriptor],
    channel_count: u16,
    codec: PayloadCodec,
    packaging: &ChannelBlockPackaging,
) -> Result<(), TilePreviewBuildError> {
    for descriptor in lods {
        let lod_dir = tile_root.join(format!("lod{}", descriptor.lod));
        fs::create_dir_all(&lod_dir).map_err(|error| TilePreviewBuildError::IoError {
            path: lod_dir.display().to_string(),
            message: error.to_string(),
        })?;
        let tile_path = lod_dir.join("t0_z0_c0_r0_c0.tileblk");
        let tile_payload = format!(
            "placeholder tile source for lod={} {}x{}",
            descriptor.lod, descriptor.width, descriptor.height
        )
        .into_bytes();
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
        fs::write(&tile_path, encoded_payload).map_err(|error| TilePreviewBuildError::IoError {
            path: tile_path.display().to_string(),
            message: error.to_string(),
        })?;
    }
    Ok(())
}

fn write_preview_image(
    preview_path: &Path,
    width: u64,
    height: u64,
) -> Result<(), TilePreviewBuildError> {
    let width_u16 = width.min(u64::from(u16::MAX)) as u16;
    let height_u16 = height.min(u64::from(u16::MAX)) as u16;
    let mut bytes = format!("P5\n{} {}\n255\n", width_u16, height_u16).into_bytes();
    for y in 0..height_u16 {
        for x in 0..width_u16 {
            bytes.push(((u32::from(x) + u32::from(y)) % 256) as u8);
        }
    }

    fs::write(preview_path, bytes).map_err(|error| TilePreviewBuildError::IoError {
        path: preview_path.display().to_string(),
        message: error.to_string(),
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::channel_block::ChannelBlockPackaging;
    use crate::model::AxisShape;

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

    #[test]
    fn builds_preview_and_tile_manifest_for_progressive_2d_refinement() {
        let generation_root = unique_path("generation");
        std::fs::create_dir_all(&generation_root).expect("generation root should be created");
        let builder = TilePreviewBuilder::new();

        let result = builder
            .build(&TilePreviewBuildRequest {
                source_id: "src_00000001".to_owned(),
                generation_seq: 1,
                generation_root: generation_root.clone(),
                shape: AxisShape {
                    t: 1,
                    c: 3,
                    z: 1,
                    y: 1024,
                    x: 2048,
                    extra_axes: BTreeMap::new(),
                },
            })
            .expect("tile/preview build should succeed");

        assert!(result.preview_path.exists());
        assert!(result.tile_manifest_path.exists());
        assert!(result.available_lods.len() > 1);
        let channel_packaging = ChannelBlockPackaging::default();
        let tile_payload_path = generation_root
            .join("tile2d")
            .join("lod0")
            .join("t0_z0_c0_r0_c0.tileblk");
        let tile_bytes =
            std::fs::read(&tile_payload_path).expect("tile payload read should succeed");
        let decoded_tile = channel_packaging
            .decode(&tile_bytes)
            .expect("tile payload decode should succeed");
        assert_eq!(decoded_tile.channel_block_size, 3);
        let manifest = std::fs::read_to_string(&result.tile_manifest_path)
            .expect("manifest read should succeed");
        assert!(manifest.contains("\"lods\""));
        assert!(manifest.contains("\"default_channel_block_size\""));
        assert!(generation_root.join("tile2d").join("lod0").exists());

        std::fs::remove_dir_all(generation_root).expect("fixture cleanup should succeed");
    }
}
