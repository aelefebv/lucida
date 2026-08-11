use lucida_content::DatasetId;
use serde::{Deserialize, Serialize};

use crate::generated::GeneratedChunkStatus;

/// Coarse stages for a dataset-open request.
///
/// These names are intentionally user/API-facing. Server internals may have
/// finer steps, but every open result should map to one of these stable stages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetOpenStage {
    RequestReceived,
    Authorization,
    SourceLookup,
    BackendOpen,
    MetadataImport,
    BindingBuild,
    GeneratedCoarsePlanning,
    WorkspacePersist,
    Broadcast,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetOpenFailureKind {
    Authorization,
    SessionClosed,
    WorkspaceLookup,
    UnsupportedScheme,
    LocalPath,
    MissingObject,
    Permission,
    CloudConfiguration,
    Http,
    StorageBackend,
    UnsupportedCodec,
    UnsupportedLayout,
    MalformedMetadata,
    MissingMetadata,
    Import,
    Persistence,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetOpenFailureDiagnostic {
    pub stage: DatasetOpenStage,
    pub kind: DatasetOpenFailureKind,
    pub retryable: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetOpenProgressDiagnostic {
    pub stage: DatasetOpenStage,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_dataset_id: Option<DatasetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// `true` when this entry reports a non-fatal problem (e.g. an import
    /// warning) rather than an ordinary stage transition, so clients can keep
    /// it visible after the open completes instead of treating it as
    /// transient progress. Absent on the wire when `false`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub warning: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetOpenSuccessDiagnostic {
    pub stage: DatasetOpenStage,
    pub source_url: String,
    pub workspace_dataset_id: DatasetId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_source_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetHealthStatus {
    Healthy,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetHealthComponent {
    pub status: DatasetHealthStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetSourceCacheStats {
    pub max_bytes: usize,
    pub current_bytes: usize,
    pub used_percent: u8,
    pub entry_count: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub backend_errors: u64,
    /// Backend round trips this source has performed, across metadata import
    /// and chunk reads alike.
    pub source_reads: u64,
    /// Cumulative time in those round trips, including queueing behind the
    /// source-read concurrency cap. Reads overlap, so this is a sum of
    /// per-read latencies rather than elapsed wall time.
    pub source_read_millis: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetGeneratedCoarseCacheStats {
    pub storage: String,
    pub current_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<u8>,
    pub evictions: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetGeneratedCoarseFailure {
    pub image_id: String,
    pub level_index: u32,
    pub key: String,
    pub status: GeneratedChunkStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetGeneratedCoarseHealth {
    pub status: DatasetHealthStatus,
    pub level_count: usize,
    pub ready_chunks: u64,
    pub pending_chunks: u64,
    pub failed_chunks: u64,
    pub unavailable_chunks: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<DatasetGeneratedCoarseCacheStats>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent_failures: Vec<DatasetGeneratedCoarseFailure>,
}

/// Which labelled request family a server timing row describes. One column
/// rather than one table per family: a correlation label is unique across
/// the connection, not within a family (ADR 0048), so the family is an
/// attribute of the row and not part of its identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimingRowFamily {
    Chunk,
    Asset,
}

/// How the server's work for a labelled request ended.
///
/// `NotReady` is the asymmetry to hold onto: a generated chunk that is still
/// being produced gets an honest status answer and no binary frame, so the
/// browser's bracket for that label never closes. A reader must not spend
/// that open bracket on the server (ADR 0050).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimingRowOutcome {
    /// Bytes were handed to this client's outbound queue.
    Delivered,
    /// The server answered with a status instead of bytes; nothing will arrive.
    NotReady,
    /// The serve failed; the client was told, or the request was dropped.
    Failed,
}

/// One flush window of the server's lifecycle table, pushed to the client
/// that caused the rows (ADR 0050). Parallel column arrays rather than an
/// array of objects: the receiving recorder copies columns straight into its
/// own table, where an array of objects would hand it thousands of
/// short-lived objects to parse and discard.
///
/// Every column has the same length; `dropped` is the batch header.
///
/// No absolute wall clock appears anywhere here. Each row's numbers are
/// relative to that row's own arrival at the server, and the browser places
/// them by nesting inside the bracket it measured on its own clock — so the
/// server's clock is never trusted and skew cannot produce a wrong picture.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerTimingBatch {
    /// Rows the server refused to buffer since the previous batch, because
    /// the pre-flush buffer was full. Declared rather than silently absorbed:
    /// a monitor that under-reports its own losses overstates its coverage.
    pub dropped: u32,
    /// The correlation label each row belongs to.
    pub rid: Vec<u32>,
    pub family: Vec<TimingRowFamily>,
    /// Microseconds from the request's arrival to the start of its serve.
    pub dispatch_offset_us: Vec<u32>,
    /// Microseconds the serve itself took, ending at handoff to the outbound
    /// queue. Socket write time is deliberately excluded (ADR 0047).
    pub duration_us: Vec<u32>,
    pub outcome: Vec<TimingRowOutcome>,
}

impl ServerTimingBatch {
    pub fn len(&self) -> usize {
        self.rid.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rid.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetSourceHealth {
    pub workspace_dataset_id: DatasetId,
    pub name: String,
    pub status: DatasetHealthStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    pub binding: DatasetHealthComponent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_cache: Option<DatasetSourceCacheStats>,
    pub generated_coarse: DatasetGeneratedCoarseHealth,
    #[serde(default)]
    pub messages: Vec<String>,
}
