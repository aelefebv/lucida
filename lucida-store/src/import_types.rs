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
    /// Non-fatal problems encountered while importing, in the order they were
    /// discovered. Empty for a fully valid dataset. A collection whose individual
    /// wells fail to parse records one entry per skipped well here rather than
    /// aborting the whole import.
    pub warnings: Vec<ImportWarning>,
}

/// A non-fatal problem surfaced by the importer so it can reach the user
/// instead of being silently dropped or aborting the open.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportWarning {
    pub kind: ImportWarningKind,
    /// The store-relative identifier of what the warning is about, e.g. a
    /// well's collection path `"B/2"`.
    pub target: String,
    /// Human-readable description naming the affected target and the reason.
    pub message: String,
}

/// The category of an [`ImportWarning`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImportWarningKind {
    /// A collection well was dropped from the import because its metadata was
    /// missing, unreadable, or malformed. The rest of the collection still opens.
    SkippedWell,
}

/// Everything the server needs to build its operational binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerBindingSeed {
    pub images: Vec<ImageBindingSeed>,
}

/// Per-image server-side storage metadata. `levels` is one
/// [`LevelBindingInfo`] per multiscale level, in level-index order.
///
/// Codec parsing happens once at import time so the import-time codec
/// parser is the only producer of [`StorageCompression`] values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageBindingSeed {
    pub image_id: ImageId,
    pub axes_names: Vec<String>,
    pub store_prefix: Option<String>,
    pub levels: Vec<LevelBindingInfo>,
}

/// What the chunk-fetch path needs to know about one level of one image:
/// how the bytes are compressed on disk, the on-disk chunk shape (parallels
/// `ImageBindingSeed.axes_names`), and the canonical-byte slice layout.
///
/// `chunk_shape` is needed by the resolver to divide wire `t`/`c` voxel
/// coords by the on-disk chunk size on those axes. The slice step on
/// the server uses the same shape to compute the intra-chunk `(t, c)`
/// indices passed into [`ChunkByteLayout::slice_range`].
///
/// Built at import time from a strict-validated codec chain
/// ([`crate::codec::parse_codec_chain`]) and the level's chunk shape
/// ([`crate::layout::compute_chunk_byte_layout`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LevelBindingInfo {
    pub level_index: u32,
    pub compression: StorageCompression,
    pub chunk_shape: Vec<u64>,
    pub chunk_byte_layout: ChunkByteLayout,
}
