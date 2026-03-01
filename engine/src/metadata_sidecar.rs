use std::collections::{BTreeMap, hash_map::DefaultHasher};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterCompression {
    Identity,
    Lz4,
    Zstd,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataEntry {
    pub label_id: u32,
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataSidecarDocument {
    pub layer_id: String,
    pub generation_seq: u64,
    pub entries: Vec<MetadataEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataSidecarError {
    InvalidPath { message: String },
    NotFound { path: String },
    IoError { path: String, reason: String },
    SerializationError { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataEndpointResponse {
    pub status_code: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterQueryResult {
    pub filter_id: String,
    pub endpoint_path: String,
    pub match_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataSidecarService {
    root: PathBuf,
}

impl MetadataSidecarService {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn upsert_document(
        &self,
        document: &MetadataSidecarDocument,
    ) -> Result<PathBuf, MetadataSidecarError> {
        let doc_path = metadata_doc_path(&self.root, &document.layer_id, document.generation_seq);
        fs::create_dir_all(
            doc_path
                .parent()
                .expect("metadata document path should have parent"),
        )
        .map_err(|error| MetadataSidecarError::IoError {
            path: doc_path.display().to_string(),
            reason: error.to_string(),
        })?;
        let bytes = serde_json::to_vec_pretty(document).map_err(|error| {
            MetadataSidecarError::SerializationError {
                message: error.to_string(),
            }
        })?;
        fs::write(&doc_path, bytes).map_err(|error| MetadataSidecarError::IoError {
            path: doc_path.display().to_string(),
            reason: error.to_string(),
        })?;
        Ok(doc_path)
    }

    pub fn query_equals(
        &self,
        layer_id: &str,
        generation_seq: u64,
        field: &str,
        value: &str,
        compression: FilterCompression,
    ) -> Result<FilterQueryResult, MetadataSidecarError> {
        let document = self.load_document(layer_id, generation_seq)?;
        let mut bitset = Vec::with_capacity(document.entries.len());
        let mut match_count = 0_usize;
        for entry in &document.entries {
            let is_match = entry
                .fields
                .get(field)
                .is_some_and(|field_value| field_value == value);
            if is_match {
                match_count = match_count.saturating_add(1);
                bitset.push(1_u8);
            } else {
                bitset.push(0_u8);
            }
        }

        let filter_id = filter_id(layer_id, generation_seq, field, value);
        let payload_bytes = encode_filter_payload(&bitset, compression).map_err(|error| {
            MetadataSidecarError::SerializationError {
                message: error.to_string(),
            }
        })?;
        let payload_path = filter_payload_path(
            &self.root,
            layer_id,
            generation_seq,
            &filter_id,
            compression_extension(compression),
        );
        fs::create_dir_all(
            payload_path
                .parent()
                .expect("filter payload path should have parent"),
        )
        .map_err(|error| MetadataSidecarError::IoError {
            path: payload_path.display().to_string(),
            reason: error.to_string(),
        })?;
        fs::write(&payload_path, payload_bytes).map_err(|error| MetadataSidecarError::IoError {
            path: payload_path.display().to_string(),
            reason: error.to_string(),
        })?;

        let meta_path = filter_metadata_path(&self.root, layer_id, generation_seq, &filter_id);
        let meta = serde_json::json!({
            "filter_id": filter_id,
            "compression": compression_encoding(compression),
            "field": field,
            "value": value,
            "entry_count": document.entries.len(),
            "match_count": match_count
        });
        let meta_bytes = serde_json::to_vec_pretty(&meta).map_err(|error| {
            MetadataSidecarError::SerializationError {
                message: error.to_string(),
            }
        })?;
        fs::write(&meta_path, meta_bytes).map_err(|error| MetadataSidecarError::IoError {
            path: meta_path.display().to_string(),
            reason: error.to_string(),
        })?;

        Ok(FilterQueryResult {
            endpoint_path: format!(
                "/v1/metadata/{}/gen/{}/filters/{}",
                layer_id, generation_seq, filter_id
            ),
            filter_id,
            match_count,
        })
    }

    pub fn serve_get(&self, path: &str) -> Result<MetadataEndpointResponse, MetadataSidecarError> {
        let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
        if parts.len() < 5 || parts[0] != "v1" || parts[1] != "metadata" {
            return Err(MetadataSidecarError::InvalidPath {
                message: "metadata path must start with /v1/metadata".to_owned(),
            });
        }
        let layer_id = parts[2];
        if parts[3] != "gen" {
            return Err(MetadataSidecarError::InvalidPath {
                message: "metadata path must contain /gen/{generation_seq}".to_owned(),
            });
        }
        let generation_seq =
            parts[4]
                .parse::<u64>()
                .map_err(|_| MetadataSidecarError::InvalidPath {
                    message: "generation sequence must be an integer".to_owned(),
                })?;

        if parts.len() == 5 {
            return self.serve_document(layer_id, generation_seq);
        }
        if parts.len() == 7 && parts[5] == "filters" {
            return self.serve_filter(layer_id, generation_seq, parts[6]);
        }

        Err(MetadataSidecarError::InvalidPath {
            message: "unsupported metadata endpoint path".to_owned(),
        })
    }

    fn load_document(
        &self,
        layer_id: &str,
        generation_seq: u64,
    ) -> Result<MetadataSidecarDocument, MetadataSidecarError> {
        let doc_path = metadata_doc_path(&self.root, layer_id, generation_seq);
        let raw = fs::read_to_string(&doc_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                MetadataSidecarError::NotFound {
                    path: doc_path.display().to_string(),
                }
            } else {
                MetadataSidecarError::IoError {
                    path: doc_path.display().to_string(),
                    reason: error.to_string(),
                }
            }
        })?;
        serde_json::from_str(&raw).map_err(|error| MetadataSidecarError::SerializationError {
            message: error.to_string(),
        })
    }

    fn serve_document(
        &self,
        layer_id: &str,
        generation_seq: u64,
    ) -> Result<MetadataEndpointResponse, MetadataSidecarError> {
        let path = metadata_doc_path(&self.root, layer_id, generation_seq);
        let body = fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                MetadataSidecarError::NotFound {
                    path: path.display().to_string(),
                }
            } else {
                MetadataSidecarError::IoError {
                    path: path.display().to_string(),
                    reason: error.to_string(),
                }
            }
        })?;
        Ok(MetadataEndpointResponse {
            status_code: 200,
            headers: BTreeMap::from([
                ("content-type".to_owned(), "application/json".to_owned()),
                ("content-encoding".to_owned(), "identity".to_owned()),
            ]),
            body,
        })
    }

    fn serve_filter(
        &self,
        layer_id: &str,
        generation_seq: u64,
        filter_id: &str,
    ) -> Result<MetadataEndpointResponse, MetadataSidecarError> {
        let meta_path = filter_metadata_path(&self.root, layer_id, generation_seq, filter_id);
        let meta_bytes = fs::read(&meta_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                MetadataSidecarError::NotFound {
                    path: meta_path.display().to_string(),
                }
            } else {
                MetadataSidecarError::IoError {
                    path: meta_path.display().to_string(),
                    reason: error.to_string(),
                }
            }
        })?;
        let meta_value: serde_json::Value =
            serde_json::from_slice(&meta_bytes).map_err(|error| {
                MetadataSidecarError::SerializationError {
                    message: error.to_string(),
                }
            })?;
        let compression = meta_value
            .get("compression")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| MetadataSidecarError::SerializationError {
                message: "filter metadata missing compression".to_owned(),
            })?;
        let payload_path = filter_payload_path(
            &self.root,
            layer_id,
            generation_seq,
            filter_id,
            compression_extension_from_encoding(compression),
        );
        let body = fs::read(&payload_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                MetadataSidecarError::NotFound {
                    path: payload_path.display().to_string(),
                }
            } else {
                MetadataSidecarError::IoError {
                    path: payload_path.display().to_string(),
                    reason: error.to_string(),
                }
            }
        })?;

        Ok(MetadataEndpointResponse {
            status_code: 200,
            headers: BTreeMap::from([
                (
                    "content-type".to_owned(),
                    "application/vnd.lucida.filter-bitset".to_owned(),
                ),
                ("content-encoding".to_owned(), compression.to_owned()),
            ]),
            body,
        })
    }
}

fn metadata_doc_path(root: &Path, layer_id: &str, generation_seq: u64) -> PathBuf {
    root.join(layer_id)
        .join(format!("gen_{generation_seq:08}"))
        .join("metadata.json")
}

fn filter_payload_path(
    root: &Path,
    layer_id: &str,
    generation_seq: u64,
    filter_id: &str,
    extension: &str,
) -> PathBuf {
    root.join(layer_id)
        .join(format!("gen_{generation_seq:08}"))
        .join("filters")
        .join(format!("{filter_id}.bitset.{extension}"))
}

fn filter_metadata_path(
    root: &Path,
    layer_id: &str,
    generation_seq: u64,
    filter_id: &str,
) -> PathBuf {
    root.join(layer_id)
        .join(format!("gen_{generation_seq:08}"))
        .join("filters")
        .join(format!("{filter_id}.meta.json"))
}

fn filter_id(layer_id: &str, generation_seq: u64, field: &str, value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    layer_id.hash(&mut hasher);
    generation_seq.hash(&mut hasher);
    field.hash(&mut hasher);
    value.hash(&mut hasher);
    format!("flt_{:016x}", hasher.finish())
}

fn encode_filter_payload(
    payload: &[u8],
    compression: FilterCompression,
) -> Result<Vec<u8>, std::io::Error> {
    match compression {
        FilterCompression::Identity => Ok(payload.to_vec()),
        FilterCompression::Lz4 => Ok(lz4_flex::compress_prepend_size(payload)),
        FilterCompression::Zstd => zstd::stream::encode_all(payload, 3),
    }
}

fn compression_encoding(compression: FilterCompression) -> &'static str {
    match compression {
        FilterCompression::Identity => "identity",
        FilterCompression::Lz4 => "x-lucida-lz4",
        FilterCompression::Zstd => "zstd",
    }
}

fn compression_extension(compression: FilterCompression) -> &'static str {
    match compression {
        FilterCompression::Identity => "raw",
        FilterCompression::Lz4 => "lz4",
        FilterCompression::Zstd => "zst",
    }
}

fn compression_extension_from_encoding(encoding: &str) -> &'static str {
    match encoding {
        "identity" => "raw",
        "x-lucida-lz4" => "lz4",
        "zstd" => "zst",
        _ => "raw",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        FilterCompression, MetadataEntry, MetadataSidecarDocument, MetadataSidecarService,
    };

    fn unique_path(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida_luc304_{prefix}_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn serves_metadata_and_compressed_filter_bitset_endpoints() {
        let root = unique_path("sidecar");
        let service = MetadataSidecarService::new(&root);
        let document = MetadataSidecarDocument {
            layer_id: "lay_00000001".to_owned(),
            generation_seq: 3,
            entries: vec![
                MetadataEntry {
                    label_id: 1,
                    fields: BTreeMap::from([
                        ("class".to_owned(), "cell".to_owned()),
                        ("state".to_owned(), "alive".to_owned()),
                    ]),
                },
                MetadataEntry {
                    label_id: 2,
                    fields: BTreeMap::from([
                        ("class".to_owned(), "cell".to_owned()),
                        ("state".to_owned(), "dead".to_owned()),
                    ]),
                },
            ],
        };
        service
            .upsert_document(&document)
            .expect("document upsert should succeed");

        let query = service
            .query_equals(
                &document.layer_id,
                document.generation_seq,
                "state",
                "alive",
                FilterCompression::Zstd,
            )
            .expect("query should succeed");
        assert_eq!(query.match_count, 1);

        let metadata_response = service
            .serve_get("/v1/metadata/lay_00000001/gen/3")
            .expect("metadata endpoint should succeed");
        assert_eq!(
            metadata_response.headers.get("content-type"),
            Some(&"application/json".to_owned())
        );

        let filter_response = service
            .serve_get(&query.endpoint_path)
            .expect("filter endpoint should succeed");
        assert_eq!(
            filter_response.headers.get("content-encoding"),
            Some(&"zstd".to_owned())
        );
        assert!(!filter_response.body.is_empty());

        std::fs::remove_dir_all(root).expect("fixture cleanup should succeed");
    }
}
