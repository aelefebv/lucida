use lucida_content::{DatasetManifest, ImageId};
use lucida_protocol::{DatasetImportWarningKind, FetchSource};
use serde::{Deserialize, Serialize};

use crate::ChunkKeyEncoding;
use crate::codec::StorageCompression;
use crate::fill::FillValue;
use crate::layout::ChunkByteLayout;
use crate::shard::ShardLayout;

/// The structured result of importing a dataset from storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub manifest: DatasetManifest,
    pub fetch: FetchSource,
    pub binding_seed: ServerBindingSeed,
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
    /// One or more group representative tiles could not be read or parsed
    /// while selecting the collection's shared multiscale geometry, so
    /// representative-tile selection fell forward to a later readable group
    /// representative. The collection still opens over the geometry of the
    /// first readable tile. Always aggregated: one warning per import
    /// summarizes every passed-over representative, because a store-wide
    /// condition (throttling, or a permission configuration that answers a
    /// missing key with an error instead of NotFound) can make many
    /// representatives unreadable at once. The message names a few affected
    /// tiles and the likely store-side causes.
    UnreadableTileGeometry,
    /// One or more tiles' own geometry could not be used: their metadata
    /// was unreadable, or their axes, data type, or codec chain differ from
    /// the representative's. Those tiles are read as if they were stored
    /// like the representative, which is wrong wherever they differ. Always
    /// aggregated, for the same reason as [`Self::UnreadableTileGeometry`].
    UnusableTileGeometry,
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
    /// One or more declared pyramid levels have no chunks written, so they
    /// read as fill and render as an all-zero image while coarser levels of
    /// the same dataset do have data — a partially-written export. The level
    /// is kept rather than dropped: level indices double as on-disk directory
    /// names, so removing one would misalign every chunk key after it.
    /// Always aggregated: whatever stops an export short usually leaves
    /// several levels bare at once. See [`crate::unwritten`] for how a level
    /// is judged unwritten without scanning its chunk prefix.
    UnwrittenLevel,
    /// A collection's tiles differ in shape, level count, or pixel size, but
    /// the collection declares one geometry for all of them: smaller tiles
    /// are padded with fill, levels past the fewest any tile has are dropped,
    /// and every tile is shown at the representative's pixel size. One
    /// warning per kind of difference, naming the tiles.
    MismatchedTileGeometry,
    /// Tiles of one group duplicate each other: a path listed twice, two
    /// tiles at one explicit position, or more tiles than the collection's
    /// `field_count` allows. Copies are laid out as if they were different
    /// tiles. Always aggregated.
    DuplicateTile,
    /// The collection's row, column, or group entries are malformed: an
    /// entry without a name, a group without an index, a group listed twice,
    /// or two groups at one position. Labels and placement are a guess
    /// wherever this is reported. Always aggregated.
    MalformedCollectionLayout,
    /// The array has axes beyond time, channel and three spatial axes, and
    /// each was pinned to one index, so only that slice is shown. One
    /// warning names every pinned axis.
    PinnedAxis,
    /// A collection that places its tiles by translation has no usable
    /// sample scale at level 0, so the translations are read as samples
    /// rather than converted from physical units.
    InvalidScale,
}

impl ImportWarningKind {
    /// Whether the warning says the data is shown wrong, which makes the
    /// dataset's health degraded rather than healthy. Exhaustive, so a new
    /// kind has to decide.
    pub fn degrades_health(self) -> bool {
        match self {
            Self::UnusableTileGeometry
            | Self::UnwrittenLevel
            | Self::MismatchedTileGeometry
            | Self::DuplicateTile
            | Self::MalformedCollectionLayout
            | Self::InvalidScale => true,
            // The data that opened is shown right: these say what was left
            // out or which tile stood in, and the collection is complete
            // wherever they do not reach.
            Self::SkippedGroup
            | Self::UnreadableTileGeometry
            | Self::SampledLabelDiscovery
            | Self::UnusableLabelIndex
            | Self::PinnedAxis => false,
        }
    }
}

impl From<ImportWarningKind> for DatasetImportWarningKind {
    fn from(kind: ImportWarningKind) -> Self {
        match kind {
            ImportWarningKind::SkippedGroup => Self::SkippedGroup,
            ImportWarningKind::UnreadableTileGeometry => Self::UnreadableTileGeometry,
            ImportWarningKind::UnusableTileGeometry => Self::UnusableTileGeometry,
            ImportWarningKind::SampledLabelDiscovery => Self::SampledLabelDiscovery,
            ImportWarningKind::UnusableLabelIndex => Self::UnusableLabelIndex,
            ImportWarningKind::UnwrittenLevel => Self::UnwrittenLevel,
            ImportWarningKind::MismatchedTileGeometry => Self::MismatchedTileGeometry,
            ImportWarningKind::DuplicateTile => Self::DuplicateTile,
            ImportWarningKind::MalformedCollectionLayout => Self::MalformedCollectionLayout,
            ImportWarningKind::PinnedAxis => Self::PinnedAxis,
            ImportWarningKind::InvalidScale => Self::InvalidScale,
        }
    }
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
/// the on-disk compression, the on-disk chunk shape (parallels
/// `ImageBindingSeed.axes_names`), the canonical-byte slice layout, how a
/// chunk's object is named, what a chunk nobody wrote reads as, and, for a
/// sharded level, how an inner chunk is found in its shard.
///
/// On a sharded level every field describes the inner chunk, so bundled
/// timepoints and channels compose with sharding: the server cuts the
/// slice from an inner chunk exactly as from an object. Only the server's
/// resolver reads `shard`. Built at import time from a strictly validated
/// codec chain and the level's chunk shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LevelBindingInfo {
    pub level_index: u32,
    /// The level's array, relative to its image: the path its multiscale
    /// `datasets` entry gives, which need not be the level index.
    pub path: String,
    pub compression: StorageCompression,
    pub chunk_shape: Vec<u64>,
    pub chunk_byte_layout: ChunkByteLayout,
    /// How a chunk's grid coordinates name its object, or its shard's.
    #[serde(default)]
    pub chunk_key_encoding: ChunkKeyEncoding,
    /// What a chunk the object store does not hold reads as.
    #[serde(default)]
    pub fill_value: FillValue,
    /// How this level's chunks are packed into shards, or `None` when each
    /// chunk is an object of its own.
    pub shard: Option<ShardLayout>,
    /// The chunk grid this level is served at, when it is not the one it is
    /// stored in. Every other field still describes the stored chunks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regrid: Option<Regrid>,
}

/// A level whose chunk keys address a declared chunk grid rather than its
/// stored one.
///
/// A collection declares one geometry for all of its tiles, but the format
/// lets each tile have its own level shapes and chunk shapes. A tile whose
/// stored chunk shape differs from the declared one is served one declared
/// chunk at a time, assembled from the stored chunks it overlaps, with fill
/// past the tile's own extent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Regrid {
    /// The declared chunk shape a key addresses, parallel to
    /// `ImageBindingSeed.axes_names`.
    pub chunk_shape: Vec<u64>,
    /// The byte layout of one declared chunk. Only `canonical_byte_size`
    /// matters on the wire, since a served chunk is always one `t` and one
    /// `c`.
    pub chunk_byte_layout: ChunkByteLayout,
    /// The stored level's shape, parallel to `ImageBindingSeed.axes_names`.
    /// Samples past it are fill.
    pub stored_shape: Vec<u64>,
}
