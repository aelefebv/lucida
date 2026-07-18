use lucida_content::url::SourceRevision;
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
    /// Semantic generation of the source metadata used to build this import.
    /// Dataset/workspace ids and the user-selected display name are excluded,
    /// so the same source generation has one revision in every workspace.
    pub source_revision: SourceRevision,
    /// Non-fatal problems encountered while importing, in the order they were
    /// discovered. Empty for a fully valid dataset. A collection whose individual
    /// groups fail to parse records one entry per skipped group here rather than
    /// aborting the whole import.
    pub warnings: Vec<ImportWarning>,
}

/// A non-fatal problem surfaced by the importer so it can reach the user
/// instead of being silently dropped or aborting the open.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportWarning {
    pub kind: ImportWarningKind,
    /// The store-relative identifier of what the warning is about, e.g. a
    /// group's collection path `"B/2"`.
    pub target: String,
    /// Human-readable description naming the affected target and the reason.
    pub message: String,
}

/// The category of an [`ImportWarning`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImportWarningKind {
    /// A collection group was dropped from the import because its metadata was
    /// missing, unreadable, or malformed. The rest of the collection still opens.
    SkippedGroup,
    /// Legacy warning retained for backward-compatible deserialization of
    /// imports created before strict all-tile collection admission. New imports
    /// fail before binding construction when any declared tile's geometry is
    /// unreadable or divergent, so they do not emit this warning.
    UnreadableTileGeometry,
    /// Label discovery on a large collection probed only a sample of tiles, so
    /// labels present only on unsampled tiles were not discovered. The message
    /// names the environment variable that forces exhaustive discovery.
    SampledLabelDiscovery,
    /// One or more label index objects (`labels/zarr.json`) were probed but
    /// could not be used — the read failed short of a clean NotFound, the
    /// bytes were not valid JSON, or the index listed no usable names — so
    /// label discovery may be incomplete. Always aggregated: one warning per
    /// import summarizes every unusable index, because a store-wide condition
    /// (throttling, or a permission configuration that answers missing keys
    /// with an error instead of NotFound) makes every index unusable at once.
    /// The message names the exhaustive-discovery override and the likely
    /// store-side causes.
    UnusableLabelIndex,
    /// Parsed label indexes collectively declared more names than the
    /// import-wide retention budget. Later names were ignored in declared tile
    /// order before their vectors could accumulate in process memory.
    LabelMetadataBudget,
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
    /// Canonical [t,c,z,y,x] voxel shape used to reject out-of-bounds t/c.
    #[serde(default = "ones_5d")]
    pub shape: [u64; 5],
    /// Canonical [t,c,z,y,x] chunk-grid shape.  z/y/x coordinates in the
    /// wire key are grid coordinates and are checked against this value.
    #[serde(default = "ones_5d")]
    pub grid_shape: [u64; 5],
    pub chunk_byte_layout: ChunkByteLayout,
}

fn ones_5d() -> [u64; 5] {
    [1; 5]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_unreadable_tile_warning_remains_wire_compatible() {
        let warning = serde_json::json!({
            "kind": "UnreadableTileGeometry",
            "target": "A/1",
            "message": "legacy import warning"
        });

        let decoded: ImportWarning = serde_json::from_value(warning.clone()).unwrap();
        assert_eq!(decoded.kind, ImportWarningKind::UnreadableTileGeometry);
        assert_eq!(serde_json::to_value(decoded).unwrap(), warning);
    }
}
