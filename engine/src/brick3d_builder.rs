use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::channel_block::{
    ChannelBlockPackaging, ChannelBlockWriteRequest, PayloadCodec, PayloadKind,
};
use crate::model::AxisShape;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrickBuildRequest {
    pub source_id: String,
    pub generation_seq: u64,
    pub generation_root: PathBuf,
    pub shape: AxisShape,
    pub lod: u8,
    pub max_new_bricks: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrickBuildResult {
    pub brick_manifest_path: PathBuf,
    pub lod: u8,
    pub brick_shape: [u16; 3],
    pub total_bricks: u32,
    pub built_bricks: u32,
    pub completed_lod: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrickBuildError {
    IoError { path: String, message: String },
    SerializationError { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Brick3dBuilder {
    channel_packaging: ChannelBlockPackaging,
}

impl Brick3dBuilder {
    #[must_use]
    pub fn new() -> Self {
        Self {
            channel_packaging: ChannelBlockPackaging::new(4),
        }
    }

    pub fn build_lazy(
        &self,
        request: &BrickBuildRequest,
    ) -> Result<BrickBuildResult, BrickBuildError> {
        let brick_root = request.generation_root.join("brick3d");
        let lod_root = brick_root.join(format!("lod{}", request.lod));
        fs::create_dir_all(&lod_root).map_err(|error| BrickBuildError::IoError {
            path: lod_root.display().to_string(),
            message: error.to_string(),
        })?;

        let dims = lod_dimensions(&request.shape, request.lod);
        let brick_shape = world_space_ish_brick_shape(dims);
        let total_bricks = brick_count(dims, brick_shape);
        let existing = existing_bricks(&lod_root)?;
        let remaining = total_bricks.saturating_sub(existing);
        let to_build = remaining.min(request.max_new_bricks.max(1));

        for index in 0..to_build {
            let brick_index = existing + index;
            let brick_path = lod_root.join(format!("brick_{brick_index:08}.blkpkg"));
            let payload = format!(
                "brick index={} lod={} dims={:?} brick_shape={:?}",
                brick_index, request.lod, dims, brick_shape
            );
            let encoded_payload = self
                .channel_packaging
                .encode(&ChannelBlockWriteRequest {
                    payload_kind: PayloadKind::Image,
                    codec: PayloadCodec::Zstd,
                    channel_count: request.shape.c.min(u64::from(u16::MAX)) as u16,
                    channel_block_size_override: None,
                    payload: payload.into_bytes(),
                })
                .map_err(|error| BrickBuildError::SerializationError {
                    message: format!("channel block encoding failed: {error:?}"),
                })?;
            fs::write(&brick_path, encoded_payload).map_err(|error| BrickBuildError::IoError {
                path: brick_path.display().to_string(),
                message: error.to_string(),
            })?;
        }

        let built_bricks = existing.saturating_add(to_build);
        let completed_lod = built_bricks >= total_bricks;
        let manifest_path = brick_root.join("manifest.json");
        let manifest = BrickManifest {
            source_id: request.source_id.clone(),
            generation_seq: request.generation_seq,
            lod: request.lod,
            dims,
            brick_shape,
            total_bricks,
            built_bricks,
            completed_lod,
        };
        write_manifest(&manifest_path, &manifest)?;

        Ok(BrickBuildResult {
            brick_manifest_path: manifest_path,
            lod: request.lod,
            brick_shape,
            total_bricks,
            built_bricks,
            completed_lod,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct BrickManifest {
    source_id: String,
    generation_seq: u64,
    lod: u8,
    dims: [u64; 3],
    brick_shape: [u16; 3],
    total_bricks: u32,
    built_bricks: u32,
    completed_lod: bool,
}

fn write_manifest(manifest_path: &Path, manifest: &BrickManifest) -> Result<(), BrickBuildError> {
    let manifest = json!(manifest);
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| {
        BrickBuildError::SerializationError {
            message: error.to_string(),
        }
    })?;
    fs::write(manifest_path, bytes).map_err(|error| BrickBuildError::IoError {
        path: manifest_path.display().to_string(),
        message: error.to_string(),
    })?;
    Ok(())
}

fn lod_dimensions(shape: &AxisShape, lod: u8) -> [u64; 3] {
    [
        downsample_dimension(shape.z.max(1), lod),
        downsample_dimension(shape.y.max(1), lod),
        downsample_dimension(shape.x.max(1), lod),
    ]
}

fn world_space_ish_brick_shape(dims: [u64; 3]) -> [u16; 3] {
    let z = dims[0];
    if z <= 8 {
        [16, 64, 64]
    } else if z <= 32 {
        [32, 64, 64]
    } else {
        [64, 64, 64]
    }
}

fn brick_count(dims: [u64; 3], brick_shape: [u16; 3]) -> u32 {
    let z = dims[0].div_ceil(u64::from(brick_shape[0]));
    let y = dims[1].div_ceil(u64::from(brick_shape[1]));
    let x = dims[2].div_ceil(u64::from(brick_shape[2]));
    z.saturating_mul(y).saturating_mul(x) as u32
}

fn existing_bricks(lod_root: &Path) -> Result<u32, BrickBuildError> {
    let entries = fs::read_dir(lod_root).map_err(|error| BrickBuildError::IoError {
        path: lod_root.display().to_string(),
        message: error.to_string(),
    })?;
    let count = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "blkpkg"))
        .count() as u32;
    Ok(count)
}

fn downsample_dimension(value: u64, lod: u8) -> u64 {
    let mut current = value.max(1);
    for _ in 0..lod {
        current = current.div_ceil(2).max(1);
    }
    current
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::channel_block::ChannelBlockPackaging;
    use crate::model::AxisShape;

    use super::{Brick3dBuilder, BrickBuildRequest};

    fn unique_path(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida_luc205_{prefix}_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn lazily_builds_bricks_in_incremental_batches() {
        let generation_root = unique_path("generation");
        std::fs::create_dir_all(&generation_root).expect("generation root creation should succeed");

        let builder = Brick3dBuilder::new();
        let request = BrickBuildRequest {
            source_id: "src_00000001".to_owned(),
            generation_seq: 1,
            generation_root: generation_root.clone(),
            shape: AxisShape {
                t: 1,
                c: 1,
                z: 96,
                y: 256,
                x: 256,
                extra_axes: BTreeMap::new(),
            },
            lod: 0,
            max_new_bricks: 2,
        };

        let first = builder
            .build_lazy(&request)
            .expect("first lazy build should succeed");
        assert!(first.built_bricks <= first.total_bricks);
        assert!(first.built_bricks >= 1);
        assert!(!first.completed_lod || first.built_bricks == first.total_bricks);

        let second = builder
            .build_lazy(&request)
            .expect("second lazy build should succeed");
        assert!(second.built_bricks >= first.built_bricks);
        assert!(second.brick_manifest_path.exists());
        let first_brick_path = generation_root
            .join("brick3d")
            .join("lod0")
            .join("brick_00000000.blkpkg");
        let brick_bytes =
            std::fs::read(first_brick_path).expect("brick payload read should succeed");
        let decoded = ChannelBlockPackaging::default()
            .decode(&brick_bytes)
            .expect("brick payload decode should succeed");
        assert_eq!(decoded.channel_block_size, 1);

        std::fs::remove_dir_all(generation_root).expect("fixture cleanup should succeed");
    }
}
