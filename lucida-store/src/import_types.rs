use lucida_content::{ContentGraph, ImageId};
use lucida_protocol::ClientFetchDescriptor;
use serde::{Deserialize, Serialize};

/// The structured result of importing a dataset from storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub content: ContentGraph,
    pub fetch: ClientFetchDescriptor,
    pub binding_seed: ServerBindingSeed,
}

/// Everything the server needs to build its operational binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerBindingSeed {
    pub images: Vec<ImageBindingSeed>,
}

/// Per-image server-side storage metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageBindingSeed {
    pub image_id: ImageId,
    pub axes_names: Vec<String>,
    pub store_prefix: Option<String>,
    pub storage_codecs: Vec<StorageCodecInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageCodecInfo {
    pub level_index: u32,
    pub codecs: Vec<serde_json::Value>,
}
