use lucida_content::{DatasetManifest, ImageId};
use lucida_protocol::FetchSource;
use serde::{Deserialize, Serialize};

use crate::codec::StorageCompression;
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

/// Per-image server-side storage metadata. `levels` is one
/// [`LevelBindingInfo`] per multiscale level, in level-index order.
///
/// Slice 2 of PRD #447 unified Slice 1's parallel `storage_codecs` /
/// `chunk_byte_layouts` Vecs into this single field so the import-time
/// codec parser is the only producer of [`StorageCompression`] values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageBindingSeed {
    pub image_id: ImageId,
    pub axes_names: Vec<String>,
    pub store_prefix: Option<String>,
    pub levels: Vec<LevelBindingInfo>,
}

/// What the chunk-fetch path needs to know about one level of one image:
/// how the bytes are compressed on disk, and whether to slice them down to
/// the canonical 5D chunk size after decompression.
///
/// Built at import time from a strict-validated codec chain
/// ([`crate::codec::parse_codec_chain`]) and the level's chunk shape
/// ([`crate::layout::compute_chunk_byte_layout`]).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct LevelBindingInfo {
    pub level_index: u32,
    pub compression: StorageCompression,
    pub chunk_byte_layout: ChunkByteLayout,
}
