use lucida_content::{DatasetManifest, ImageId};
use lucida_protocol::FetchSource;
use serde::{Deserialize, Serialize};

use crate::layout::ChunkByteLayout;

/// The structured result of importing a dataset from storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub manifest: DatasetManifest,
    pub fetch: FetchSource,
    pub binding_seed: ServerBindingSeed,
}

/// Everything the server needs to build its operational binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerBindingSeed {
    pub images: Vec<ImageBindingSeed>,
}

/// Per-image server-side storage metadata. `storage_codecs` and
/// `chunk_byte_layouts` are parallel arrays indexed by level (Slice 1 of
/// PRD #447 keeps them parallel for minimal churn; Slice 2 unifies them
/// into a single `LevelBindingInfo` Vec).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageBindingSeed {
    pub image_id: ImageId,
    pub axes_names: Vec<String>,
    pub store_prefix: Option<String>,
    pub storage_codecs: Vec<StorageCodecInfo>,
    /// Per-level decoded-chunk byte-layout — same length and order as
    /// `storage_codecs`. Computed at import time from the level's chunk_shape
    /// and pinned axes. The server slices each decompressed chunk down to
    /// `canonical_byte_size` when `needs_slicing` is true.
    #[serde(default)]
    pub chunk_byte_layouts: Vec<ChunkByteLayout>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageCodecInfo {
    pub level_index: u32,
    pub codecs: Vec<serde_json::Value>,
}
