use crate::chunk_key::ChunkKey;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectUrlError {
    InvalidBaseUrl { base_url: String },
}

pub trait ObjectUrlResolver {
    fn resolve_chunk_url(&self, key: &ChunkKey) -> Result<String, ObjectUrlError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineDataPlaneResolver {
    pub base_url: String,
}

impl EngineDataPlaneResolver {
    #[must_use]
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: normalize_base_url(base_url.into()),
        }
    }
}

impl ObjectUrlResolver for EngineDataPlaneResolver {
    fn resolve_chunk_url(&self, key: &ChunkKey) -> Result<String, ObjectUrlError> {
        if self.base_url.is_empty() {
            return Err(ObjectUrlError::InvalidBaseUrl {
                base_url: self.base_url.clone(),
            });
        }
        Ok(format!("{}{}", self.base_url, key.format_path()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticObjectResolver {
    pub base_url: String,
    pub path_prefix: String,
}

impl StaticObjectResolver {
    #[must_use]
    pub fn new(base_url: impl Into<String>, path_prefix: impl Into<String>) -> Self {
        let base = normalize_base_url(base_url.into());
        let prefix = path_prefix.into().trim_matches('/').to_owned();
        Self {
            base_url: base,
            path_prefix: prefix,
        }
    }
}

impl ObjectUrlResolver for StaticObjectResolver {
    fn resolve_chunk_url(&self, key: &ChunkKey) -> Result<String, ObjectUrlError> {
        if self.base_url.is_empty() {
            return Err(ObjectUrlError::InvalidBaseUrl {
                base_url: self.base_url.clone(),
            });
        }
        let path = key.format_path().trim_start_matches('/').to_owned();
        if self.path_prefix.is_empty() {
            return Ok(format!("{}/{}", self.base_url, path));
        }
        Ok(format!("{}/{}/{}", self.base_url, self.path_prefix, path))
    }
}

fn normalize_base_url(base_url: String) -> String {
    base_url.trim_end_matches('/').to_owned()
}

#[cfg(test)]
mod tests {
    use crate::chunk_key::{ChunkAssetKind, ChunkKey};

    use super::{EngineDataPlaneResolver, ObjectUrlResolver, StaticObjectResolver};

    fn sample_key() -> ChunkKey {
        ChunkKey {
            source_id: "src_00000001".to_owned(),
            generation_seq: 4,
            asset_kind: ChunkAssetKind::Tile2d,
            lod: 1,
            t: 0,
            z: 0,
            channel_block: 0,
            y: 3,
            x: 5,
        }
    }

    #[test]
    fn engine_resolver_maps_to_local_data_plane_path() {
        let resolver = EngineDataPlaneResolver::new("http://localhost:9090/");
        let url = resolver
            .resolve_chunk_url(&sample_key())
            .expect("URL resolution should succeed");
        assert_eq!(
            url,
            "http://localhost:9090/v1/tile2d/src_00000001/gen/4/lod/1/t/0/z/0/cb/0/y/3/x/5"
        );
    }

    #[test]
    fn static_resolver_maps_to_object_storage_prefix() {
        let resolver = StaticObjectResolver::new("https://cdn.example.com/", "lucida-cache");
        let url = resolver
            .resolve_chunk_url(&sample_key())
            .expect("URL resolution should succeed");
        assert_eq!(
            url,
            "https://cdn.example.com/lucida-cache/v1/tile2d/src_00000001/gen/4/lod/1/t/0/z/0/cb/0/y/3/x/5"
        );
    }
}
