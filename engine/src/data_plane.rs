use std::collections::BTreeMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use crate::channel_block::{PayloadCodec, codec_from_packaged_payload};
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
        let payload_path = resolve_existing_payload_path(&self.cache_root, &key);
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
        headers.insert(
            "content-encoding".to_owned(),
            content_encoding_for_payload(&key.asset_kind, &body).map_err(|reason| {
                DataPlaneError::ReadFailed {
                    path: payload_path.display().to_string(),
                    reason,
                }
            })?,
        );
        headers.insert(
            "cache-control".to_owned(),
            "public, max-age=31536000, immutable".to_owned(),
        );
        headers.insert("etag".to_owned(), etag_for_bytes(&body));
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
            .join(format!("lod{}", key.lod))
            .join(format!("t{}_z{}_cb{}.pgm", key.t, key.z, key.channel_block)),
    }
}

fn resolve_existing_payload_path(cache_root: &Path, key: &ChunkKey) -> PathBuf {
    let primary = resolve_payload_path(cache_root, key);
    if primary.exists() {
        return primary;
    }

    match key.asset_kind {
        ChunkAssetKind::Preview2d => {
            let legacy = cache_root
                .join(&key.source_id)
                .join(format!("gen_{:08}", key.generation_seq))
                .join("preview2d")
                .join(format!("lod_{}.pgm", key.lod));
            if legacy.exists() {
                return legacy;
            }
            if key.t != 0 || key.z != 0 || key.channel_block != 0 {
                let base = cache_root
                    .join(&key.source_id)
                    .join(format!("gen_{:08}", key.generation_seq))
                    .join("preview2d")
                    .join(format!("lod{}", key.lod))
                    .join("t0_z0_cb0.pgm");
                if base.exists() {
                    return base;
                }
            }
        }
        ChunkAssetKind::Tile2d => {
            // Tile chunks are selection-specific. Missing non-zero T/Z/CB tiles should remain
            // missing so callers can trigger on-demand generation instead of receiving
            // mismatched fallback content.
        }
        ChunkAssetKind::Brick3d => {}
    }

    primary
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

fn content_encoding_for_payload(
    asset_kind: &ChunkAssetKind,
    body: &[u8],
) -> Result<String, String> {
    match asset_kind {
        ChunkAssetKind::Preview2d => Ok("identity".to_owned()),
        ChunkAssetKind::Tile2d | ChunkAssetKind::Brick3d => {
            let codec = codec_from_packaged_payload(body).map_err(|error| format!("{error:?}"))?;
            Ok(match codec {
                PayloadCodec::Raw => "identity".to_owned(),
                PayloadCodec::Lz4 => "x-lucida-lz4".to_owned(),
                PayloadCodec::Zstd => "zstd".to_owned(),
            })
        }
    }
}

fn etag_for_bytes(body: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    body.hash(&mut hasher);
    format!("\"lucida-{:016x}\"", hasher.finish())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::chunk_key::{ChunkAssetKind, ChunkKey};

    use super::DataPlaneService;

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
        assert_eq!(response.status_code, 200);
        assert_eq!(response.body, b"pgm".to_vec());
        assert_eq!(
            response.headers.get("content-type"),
            Some(&"image/x-portable-graymap".to_owned())
        );
        assert_eq!(
            response.headers.get("content-encoding"),
            Some(&"identity".to_owned())
        );
        assert_eq!(
            response.headers.get("cache-control"),
            Some(&"public, max-age=31536000, immutable".to_owned())
        );
        assert_eq!(
            response.headers.get("x-lucida-generation-seq"),
            Some(&"1".to_owned())
        );
        assert_eq!(
            response.headers.get("x-lucida-source-id"),
            Some(&"src_00000001".to_owned())
        );
        assert!(response.headers.contains_key("etag"));

        std::fs::remove_dir_all(cache_root).expect("fixture cleanup should succeed");
    }
}
