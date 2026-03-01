use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::chunk_key::{ChunkAssetKind, ChunkKey};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataPlaneError {
    InvalidPath { message: String },
    NotFound { path: String },
    ReadFailed { path: String, reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpDataPlaneResponse {
    pub status_code: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataPlaneService {
    cache_root: PathBuf,
}

impl DataPlaneService {
    #[must_use]
    pub fn new(cache_root: impl Into<PathBuf>) -> Self {
        Self {
            cache_root: cache_root.into(),
        }
    }

    pub fn serve_get(&self, path: &str) -> Result<HttpDataPlaneResponse, DataPlaneError> {
        let key = ChunkKey::parse_path(path).map_err(|error| DataPlaneError::InvalidPath {
            message: error.to_string(),
        })?;
        let payload_path = resolve_payload_path(&self.cache_root, &key);
        if !payload_path.exists() {
            return Err(DataPlaneError::NotFound {
                path: payload_path.display().to_string(),
            });
        }

        let body = fs::read(&payload_path).map_err(|error| DataPlaneError::ReadFailed {
            path: payload_path.display().to_string(),
            reason: error.to_string(),
        })?;

        let mut headers = BTreeMap::new();
        headers.insert(
            "content-type".to_owned(),
            content_type_for_path(&payload_path),
        );
        headers.insert("x-lucida-source-id".to_owned(), key.source_id.clone());
        headers.insert(
            "x-lucida-generation-seq".to_owned(),
            key.generation_seq.to_string(),
        );

        Ok(HttpDataPlaneResponse {
            status_code: 200,
            headers,
            body,
        })
    }
}

fn resolve_payload_path(cache_root: &Path, key: &ChunkKey) -> PathBuf {
    let generation_root = cache_root
        .join(&key.source_id)
        .join(format!("gen_{:08}", key.generation_seq));

    match key.asset_kind {
        ChunkAssetKind::Tile2d => generation_root
            .join("tile2d")
            .join(format!("lod{}", key.lod))
            .join(format!(
                "t{}_z{}_cb{}_r{}_c{}.tileblk",
                key.t, key.z, key.channel_block, key.y, key.x
            )),
        ChunkAssetKind::Brick3d => generation_root
            .join("brick3d")
            .join(format!("lod{}", key.lod))
            .join(format!("brick_{:08}.blkpkg", key.y)),
        ChunkAssetKind::Preview2d => generation_root
            .join("preview2d")
            .join(format!("lod_{}.pgm", key.lod)),
    }
}

fn content_type_for_path(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    match extension {
        "pgm" => "image/x-portable-graymap".to_owned(),
        "tileblk" | "blkpkg" => "application/octet-stream".to_owned(),
        _ => "application/octet-stream".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::chunk_key::{ChunkAssetKind, ChunkKey};

    use super::{DataPlaneService, HttpDataPlaneResponse};

    fn unique_path(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida_luc301_{prefix}_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn serves_preview_payload_from_canonical_chunk_path() {
        let cache_root = unique_path("service");
        let payload_path = cache_root
            .join("src_00000001")
            .join("gen_00000001")
            .join("preview2d")
            .join("lod_0.pgm");
        std::fs::create_dir_all(
            payload_path
                .parent()
                .expect("preview parent should be present"),
        )
        .expect("preview parent creation should succeed");
        std::fs::write(&payload_path, b"pgm").expect("preview payload write should succeed");

        let service = DataPlaneService::new(&cache_root);
        let response = service
            .serve_get(
                &ChunkKey {
                    source_id: "src_00000001".to_owned(),
                    generation_seq: 1,
                    asset_kind: ChunkAssetKind::Preview2d,
                    lod: 0,
                    t: 0,
                    z: 0,
                    channel_block: 0,
                    y: 0,
                    x: 0,
                }
                .format_path(),
            )
            .expect("preview request should succeed");
        assert_eq!(
            response,
            HttpDataPlaneResponse {
                status_code: 200,
                headers: BTreeMap::from([
                    (
                        "content-type".to_owned(),
                        "image/x-portable-graymap".to_owned(),
                    ),
                    ("x-lucida-generation-seq".to_owned(), "1".to_owned()),
                    ("x-lucida-source-id".to_owned(), "src_00000001".to_owned())
                ]),
                body: b"pgm".to_vec()
            }
        );

        std::fs::remove_dir_all(cache_root).expect("fixture cleanup should succeed");
    }
}
