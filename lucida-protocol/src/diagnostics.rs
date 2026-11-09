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
    InvalidLocation,
    SourceNotAllowed,
    LocalPath,
    MissingObject,
    Permission,
    CloudConfiguration,
    Http,
    StorageBackend,
    UnsupportedCodec,
    UnsupportedLayout,
    UnsupportedDataType,
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
/// the connection, not within a family, so the family is an attribute of the
/// row and not part of its identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimingRowFamily {
    Chunk,
    /// One object read performed while opening a dataset. Keyed on the open's
    /// `request_id` rather than on a correlation label: the open already has
    /// a parent identifier and these reads are its children.
    MetadataRead,
}

/// Where a dataset-open metadata read spent its time.
///
/// Short on purpose, and its own enum rather than a slice of the chunk
/// enum: a metadata read has no dispatch, no decompress and no encode, and
/// reusing the wider vocabulary would ship slots that can never be filled.
///
/// Every phase carries the same two numbers — where the read sits inside
/// the open, and how long it took — and the phase says what that time was:
///
/// - [`CacheHit`](Self::CacheHit) — answered from the resident cache or the
///   absent memo, with no backend work. Its duration is a local lookup and
///   is below anything worth reading as a duration; the row is worth having
///   for the count, because an open whose reads are mostly hits is a
///   different open from one whose reads are mostly round trips.
/// - [`CoalescedWait`](Self::CoalescedWait) — this read attached to another
///   reader's in-flight read and performed none of its own. The round trip
///   belongs to the leader's row, so counting an open's round trips means
///   counting its [`BackendRead`](Self::BackendRead) rows. Note what that
///   number is: the trips *this open* performed. A leader can be another
///   open, or a caller that is no open at all, in which case a wait here
///   has no trip anywhere in this open's rows — the read still happened,
///   it was simply not this open that paid for it.
/// - [`BackendRead`](Self::BackendRead) — this read performed the round
///   trip, and waited behind the metadata-read cap to do it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetadataReadPhase {
    CacheHit,
    CoalescedWait,
    BackendRead,
}

/// How the server's work for a labelled request ended.
///
/// `NotReady` is the asymmetry to hold onto: a generated chunk that is still
/// being produced gets an honest status answer and no binary frame, so the
/// browser's bracket for that label never closes. A reader must not spend
/// that open bracket on the server.
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

/// The server's phase enum: the stages a served request passes through,
/// each delimited by a handoff.
///
/// This is finer than the browser's enum on purpose. The browser's rule that a
/// phase earns a slot only above the 100 µs clock floor comes from a *browser
/// platform* measurement. Rust's `Instant` has no such floor, so the rule is
/// clock-relative and the server can name stages the browser could only
/// count.
///
/// The stages are sequential and contiguous from arrival to handoff, so a
/// row's durations sum to its life on the server. Inapplicable stages are
/// left [`PHASE_UNSET`] rather than zero — a stage that did not happen and a
/// stage that took no measurable time are different facts.
///
/// The discriminants are the column order and the row's slot indices, which
/// is why they are written out: a phase's position is data, not an accident
/// of declaration order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum ServerPhase {
    /// Frame off the socket → the request is recognised and its binding
    /// lookup begins. Routing a text frame tries each message shape in turn,
    /// and under a burst of thousands of chunk requests that parse is a real
    /// cost.
    Arrival = 0,
    /// Resolving the dataset's server binding. It earns a slot despite
    /// looking free: it takes the shared session mutex, so every chunk
    /// request from every client in the workspace serialises there.
    BindingLookup = 1,
    /// Binding in hand → the serve task is running and about to do its work.
    /// Covers the task spawn and whatever the runtime made it wait.
    Dispatch = 2,
    /// Deciding what the serve can answer locally: the source cache's LRU
    /// probe and its single-flight election, or the generated-chunk cache's
    /// lookup.
    CacheLookup = 3,
    /// Queued behind the source-read cap. Leader rows only — a follower
    /// performs no read and takes no permit.
    PermitWait = 4,
    /// The backend round trip itself. Leader rows only, so a sum over this
    /// column counts each round trip exactly once.
    BackendRead = 5,
    /// Parked on another request's in-flight read of the same object. This
    /// is the follower's whole wait, and naming it apart is what stops a
    /// coalesced 400 ms reading as a slow backend.
    CoalescedWait = 6,
    /// Queued for one of the server's decode threads, which a burst of
    /// requests shares. Kept apart from the decode itself so a short pool
    /// reads as a queue, not as slow decompression.
    DecodeWait = 7,
    /// Storage codec decode.
    Decompress = 8,
    /// Turning the stored bytes into the wire frame: the (t, c) slice and
    /// the frame envelope.
    SliceEncode = 9,
    /// Handing the frame to this connection's outbound queue. Terminal:
    /// socket write time happens in a separate task behind an unbounded
    /// queue and is not observable from the serve path.
    Handoff = 10,
}

/// Every phase, in the order a request passes through them.
pub const SERVER_PHASES: [ServerPhase; 11] = [
    ServerPhase::Arrival,
    ServerPhase::BindingLookup,
    ServerPhase::Dispatch,
    ServerPhase::CacheLookup,
    ServerPhase::PermitWait,
    ServerPhase::BackendRead,
    ServerPhase::CoalescedWait,
    ServerPhase::DecodeWait,
    ServerPhase::Decompress,
    ServerPhase::SliceEncode,
    ServerPhase::Handoff,
];

/// A phase this row never entered. Durations are microseconds in a `u32`, and
/// zero is a legitimate duration, so the sentinel is the top of the range —
/// the same choice the browser's stamp slots make.
pub const PHASE_UNSET: u32 = u32::MAX;

/// The longest duration a slot can hold: one below the sentinel, so a phase
/// that ran for over ~71 minutes reports as very long rather than as never
/// having happened. Saturating onto the sentinel would turn the worst stall
/// in the trace into a blank.
pub const PHASE_MAX_US: u32 = PHASE_UNSET - 1;

/// The label column's "this row led its own read" value. Followers carry the
/// label of the read they waited on; everyone else carries this.
pub const LABEL_NONE: u32 = u32::MAX;

/// One flush window of the server's lifecycle table, pushed to the client
/// that caused the rows. Parallel column arrays rather than an
/// array of objects: the receiving recorder copies columns straight into its
/// own table, where an array of objects would hand it thousands of
/// short-lived objects to parse and discard.
///
/// Every column has the same length; `dropped` is the batch header.
///
/// No absolute wall clock appears anywhere here, and nothing about any other
/// client. Each row's numbers are relative to that row's own arrival at the
/// server, and the browser places them by nesting inside the bracket it
/// measured on its own clock — so the server's clock is never trusted and
/// skew cannot produce a wrong picture. A client learns how long *it* waited
/// for a read permit, never the queue depth it waited behind, who else was
/// reading, or what they were reading.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerTimingBatch {
    /// Rows the server refused to buffer since the previous batch, because
    /// the pre-flush buffer was full. Declared rather than silently absorbed:
    /// a monitor that under-reports its own losses overstates its coverage.
    pub dropped: u32,
    /// The correlation label each row belongs to. Zero on a metadata-read
    /// row, which is keyed by `request_id` instead — the family column says
    /// which key to read, and an unused slot is what a fixed-width row is
    /// for.
    pub rid: Vec<u32>,
    /// The dataset-open request each metadata-read row belongs to, and
    /// `None` on every other family. The exporter's second join path: an
    /// open already owns an identifier and its reads are its children, so
    /// nothing here mints a second one.
    pub request_id: Vec<Option<String>>,
    pub family: Vec<TimingRowFamily>,
    /// Where a metadata read spent its time, and `None` on every other
    /// family. Metadata reads get their own short enum because the chunk
    /// enum's slots do not apply to them.
    pub metadata_phase: Vec<Option<MetadataReadPhase>>,
    /// Microseconds from the request's arrival to the start of its serve.
    /// On a metadata-read row, from the *open's* arrival to the start of
    /// that read — which is what places the read inside the open rather
    /// than merely inside it somewhere.
    pub dispatch_offset_us: Vec<u32>,
    /// Microseconds the serve itself took, ending at handoff to the outbound
    /// queue. Socket write time is deliberately excluded. On a
    /// metadata-read row, the read itself, including its wait behind the
    /// metadata-read cap.
    pub duration_us: Vec<u32>,
    pub outcome: Vec<TimingRowOutcome>,
    /// One column per [`ServerPhase`], in microseconds, [`PHASE_UNSET`] where
    /// the row never entered that phase.
    pub arrival_us: Vec<u32>,
    pub binding_lookup_us: Vec<u32>,
    pub dispatch_us: Vec<u32>,
    pub cache_lookup_us: Vec<u32>,
    pub permit_wait_us: Vec<u32>,
    pub backend_read_us: Vec<u32>,
    pub coalesced_wait_us: Vec<u32>,
    pub decode_wait_us: Vec<u32>,
    pub decompress_us: Vec<u32>,
    pub slice_encode_us: Vec<u32>,
    pub handoff_us: Vec<u32>,
    /// The bytes the row's own backend round trips returned, and `None` on
    /// a row that performed none: a follower, a cache hit, a generated
    /// chunk, a metadata read. Set exactly when `backend_read_us` is, so a
    /// sum over this column is the bytes the backend moved for this client
    /// and a follower adds nothing to it. An inner chunk read out of a shard
    /// reports the range it asked for, or every range a merged read carried,
    /// plus the shard's index when that was this row's read too, which is
    /// what lets a trace show a shard was read by the inner chunk and never
    /// downloaded whole.
    pub backend_bytes: Vec<Option<u32>>,
    /// For a single-flight follower, the label of the read it waited on;
    /// [`LABEL_NONE`] for every other row. This is what turns a coalesced
    /// wait from "it waited" into "it waited on that read", and it makes the
    /// server-side coalescing count a group-by rather than a new counter.
    ///
    /// Labels are per connection, so a leader on another connection joins to
    /// nothing here — the honest answer, and the reason this reveals no peer
    /// identity, rate or dataset.
    pub coalesced_onto: Vec<u32>,
}

impl ServerTimingBatch {
    pub fn len(&self) -> usize {
        self.rid.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rid.is_empty()
    }

    /// The column a phase's durations live in. One `match` in one place, so
    /// widening the enum is a compile error here rather than a column that
    /// silently never fills.
    pub fn column_mut(&mut self, phase: ServerPhase) -> &mut Vec<u32> {
        match phase {
            ServerPhase::Arrival => &mut self.arrival_us,
            ServerPhase::BindingLookup => &mut self.binding_lookup_us,
            ServerPhase::Dispatch => &mut self.dispatch_us,
            ServerPhase::CacheLookup => &mut self.cache_lookup_us,
            ServerPhase::PermitWait => &mut self.permit_wait_us,
            ServerPhase::BackendRead => &mut self.backend_read_us,
            ServerPhase::CoalescedWait => &mut self.coalesced_wait_us,
            ServerPhase::DecodeWait => &mut self.decode_wait_us,
            ServerPhase::Decompress => &mut self.decompress_us,
            ServerPhase::SliceEncode => &mut self.slice_encode_us,
            ServerPhase::Handoff => &mut self.handoff_us,
        }
    }

    /// Read-only counterpart to [`Self::column_mut`].
    pub fn column(&self, phase: ServerPhase) -> &[u32] {
        match phase {
            ServerPhase::Arrival => &self.arrival_us,
            ServerPhase::BindingLookup => &self.binding_lookup_us,
            ServerPhase::Dispatch => &self.dispatch_us,
            ServerPhase::CacheLookup => &self.cache_lookup_us,
            ServerPhase::PermitWait => &self.permit_wait_us,
            ServerPhase::BackendRead => &self.backend_read_us,
            ServerPhase::CoalescedWait => &self.coalesced_wait_us,
            ServerPhase::DecodeWait => &self.decode_wait_us,
            ServerPhase::Decompress => &self.decompress_us,
            ServerPhase::SliceEncode => &self.slice_encode_us,
            ServerPhase::Handoff => &self.handoff_us,
        }
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
    /// What the import found, in the order found. Each message is also in
    /// `messages`; this keeps them apart from cache and binding notes so a
    /// client can show them beside the dataset.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub import_warnings: Vec<DatasetImportWarning>,
}

/// One import warning, as dataset health reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetImportWarning {
    pub kind: DatasetImportWarningKind,
    /// What the warning is about, such as a group's collection path.
    pub target: String,
    /// The importer's account, with the paths, causes and settings a
    /// developer or agent needs. A client showing the warning to people
    /// words it from `kind`.
    pub message: String,
    /// The warning says the data is shown wrong, so it degrades `status`.
    pub degrades: bool,
}

/// What an import warning is about. The importer's own kinds, one for one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetImportWarningKind {
    SkippedGroup,
    UnreadableTileGeometry,
    UnusableTileGeometry,
    SampledLabelDiscovery,
    UnusableLabelIndex,
    UnwrittenLevel,
    MismatchedTileGeometry,
    DuplicateTile,
    MalformedCollectionLayout,
    PinnedAxis,
    InvalidScale,
}

/// The throttle a server puts on its own source reads, so a local source
/// loads the way a remote one does. A dev setting, off unless an operator
/// sets it, and reported wherever the server reports its health, because a
/// run measured under it is not comparable with one measured without it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceThrottleReport {
    /// The named profile, absent when the values are not a profile's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Added to every source request.
    pub latency_ms: u64,
    /// The most added on top of `latency_ms`, drawn per request.
    pub jitter_ms: u64,
    /// The cap on all source reads together, absent when uncapped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_per_sec: Option<u64>,
}

impl SourceThrottleReport {
    /// One line naming the profile and its numbers. Two reports with the
    /// same settings have the same label, so it is also what a comparison
    /// of two runs matches on.
    pub fn label(&self) -> String {
        let latency = if self.jitter_ms == 0 {
            format!("{} ms", self.latency_ms)
        } else {
            format!(
                "{}-{} ms",
                self.latency_ms,
                self.latency_ms.saturating_add(self.jitter_ms)
            )
        };
        let bandwidth = match self.bytes_per_sec {
            Some(rate) => {
                let mib = rate as f64 / (1024.0 * 1024.0);
                let mib = (mib * 10.0).round() / 10.0;
                format!("{mib} MiB/s across all reads")
            }
            None => "no bandwidth cap".to_string(),
        };
        format!(
            "{}: {latency} per request, {bandwidth}",
            self.profile.as_deref().unwrap_or("custom")
        )
    }
}

/// The throttle a server puts on the link to its clients, so a page on the
/// same machine waits for its messages the way a page across a network
/// does. A dev setting like [`SourceThrottleReport`], and reported beside
/// it for the same reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkThrottleReport {
    /// The named profile, absent when the values are not a profile's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Added to every round trip on the session socket, half each way.
    pub latency_ms: u64,
    /// The cap on what the server sends one connection, absent when
    /// uncapped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_per_sec: Option<u64>,
}

impl LinkThrottleReport {
    /// One line naming the profile and its numbers, and what a comparison
    /// of two runs matches on, as [`SourceThrottleReport::label`] is.
    pub fn label(&self) -> String {
        let bandwidth = match self.bytes_per_sec {
            Some(rate) => {
                let mbit = rate as f64 * 8.0 / 1_000_000.0;
                let mbit = (mbit * 10.0).round() / 10.0;
                format!("{mbit} Mbit/s to each client")
            }
            None => "no bandwidth cap".to_string(),
        };
        format!(
            "{}: {} ms round trip, {bandwidth}",
            self.profile.as_deref().unwrap_or("custom"),
            self.latency_ms
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_throttle_label_names_the_profile_and_its_numbers() {
        let profiled = LinkThrottleReport {
            profile: Some("broadband".into()),
            latency_ms: 40,
            bytes_per_sec: Some(12_500_000),
        };
        assert_eq!(
            profiled.label(),
            "broadband: 40 ms round trip, 100 Mbit/s to each client"
        );
        let custom = LinkThrottleReport {
            profile: None,
            latency_ms: 0,
            bytes_per_sec: Some(3_000_000),
        };
        assert_eq!(
            custom.label(),
            "custom: 0 ms round trip, 24 Mbit/s to each client"
        );
    }

    #[test]
    fn a_throttle_label_names_the_profile_and_its_numbers() {
        let profiled = SourceThrottleReport {
            profile: Some("remote".into()),
            latency_ms: 180,
            jitter_ms: 100,
            bytes_per_sec: Some(18 * 1024 * 1024),
        };
        assert_eq!(
            profiled.label(),
            "remote: 180-280 ms per request, 18 MiB/s across all reads"
        );
        let custom = SourceThrottleReport {
            profile: None,
            latency_ms: 50,
            jitter_ms: 0,
            bytes_per_sec: None,
        };
        assert_eq!(
            custom.label(),
            "custom: 50 ms per request, no bandwidth cap"
        );
    }
}
