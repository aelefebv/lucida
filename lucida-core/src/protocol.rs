use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use lucida_content::{DatasetId, ImageId};
use lucida_protocol::{
    AssetCatalogDelta, DatasetOpenFailureDiagnostic, DatasetOpenProgressDiagnostic,
    DatasetOpenSuccessDiagnostic, DatasetSourceHealth, GeneratedAvailabilityDelta,
    GeneratedAvailabilitySnapshot, GeneratedChunkStatus, ServerTimingBatch, SourceChunkStatus,
};

use crate::camera::Camera;
use crate::command::DocumentCommand;
use crate::scene::{DatasetDisplaySettings, DisplayState, DocumentState};
use crate::view::ViewState;

pub type ClientId = u64;

/// Presentational identity of a connected peer, surfaced on their live
/// cursor in collaborative mode (issue #540). Server-authored from the
/// session's authenticated `AuthPrincipal` — clients never send this, so
/// it can't be spoofed and is only ever shown to co-present peers.
///
/// Privacy: the raw email address is NEVER carried here. Collaborator
/// emails are owner-only (the `/sharing` endpoint is `require_owner`-gated),
/// so presence — which every co-present peer receives, including non-owner
/// link-access viewers/editors — must not leak them. Only the
/// non-identifying `display_name`, `picture_url`, and a single-grapheme
/// `initial` cross the wire.
///
/// All fields are best-effort: an unauthenticated/legacy session leaves
/// `identity` as `None` on `PresenceState`, and within an identity a
/// provider may omit `picture_url`. Consumers fall back name → initial
/// chip → numeric id/color.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerIdentity {
    /// Human-facing name (`AuthPrincipal::display_name`). May be empty if
    /// the provider supplied none.
    pub display_name: String,
    /// Avatar URL (`AuthPrincipal::picture_url`). `None` for dev sessions
    /// and providers without a picture — the cursor falls back to an
    /// initial chip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture_url: Option<String>,
    /// Single-grapheme fallback glyph for the avatar chip, computed
    /// server-side from the display name (or, when blank, the email
    /// local-part) so the cursor has a stable initial WITHOUT the raw
    /// email crossing the wire. Empty only when no usable source existed.
    #[serde(default)]
    pub initial: String,
}

impl PeerIdentity {
    /// Build a wire identity from the connection's authenticated principal,
    /// computing the fallback `initial` server-side from the display name —
    /// or, when that is blank, the email local-part — so the raw `email`
    /// never crosses the wire. The returned `PeerIdentity` carries no email.
    pub fn from_principal_parts(
        display_name: String,
        picture_url: Option<String>,
        email: &str,
    ) -> Self {
        let initial = Self::compute_initial(&display_name, email);
        Self {
            display_name,
            picture_url,
            initial,
        }
    }

    /// First uppercased character of the display name, falling back to the
    /// email local-part (the bit before `@`), else empty. Only this single
    /// grapheme — never the full address — is exposed to peers.
    fn compute_initial(display_name: &str, email: &str) -> String {
        let from = |s: &str| s.trim().chars().next();
        let ch = from(display_name).or_else(|| from(email.split('@').next().unwrap_or("")));
        ch.map(|c| c.to_uppercase().to_string()).unwrap_or_default()
    }
}

/// Per-client ephemeral state broadcast to other clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceState {
    pub client_id: ClientId,
    pub camera: Camera,
    pub view: ViewState,
    pub display: DisplayState,
    /// Who this client is following (`None` = independent).
    pub following: Option<ClientId>,
    pub cursor: Option<[f64; 2]>,
    #[serde(default)]
    pub dataset_order: Vec<DatasetId>,
    #[serde(default)]
    pub dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    /// Presentational identity for the peer's cursor (#540). Server-set
    /// from the authed principal; `None` for sessions without auth (the
    /// non-workspace `/ws` path) so older/anonymous peers still render
    /// via the numeric-id fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<PeerIdentity>,
}

/// Messages sent from a client to the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// A document command (shared, sequenced).
    Command { command: DocumentCommand },
    /// Viewport presence update (ephemeral, latest-wins).
    Presence {
        camera: Camera,
        view: ViewState,
        display: DisplayState,
    },
    /// Cursor position update (null = cursor left the canvas).
    Cursor { position: Option<[f64; 2]> },
    /// Follow another client (or stop following with `target: null`).
    Follow { target: Option<ClientId> },
    /// Layer presence update (ephemeral, latest-wins).
    DatasetPresence {
        dataset_order: Vec<DatasetId>,
        dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    },
    /// Remote-control another client by making them follow the sender.
    Steer { client: ClientId },
    /// Request the server open a Dataset from a URL.
    /// The server reads metadata via a StorageBackend and broadcasts DatasetOpened.
    OpenRemoteDataset { request_id: String, url: String },
    /// Request server-authored runtime health for loaded datasets.
    DatasetHealth {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dataset_id: Option<DatasetId>,
    },
    /// Retry rebuilding a persisted workspace dataset's server binding.
    DatasetRetry {
        request_id: String,
        dataset_id: DatasetId,
    },
    /// Advisory, unsequenced scheduling hint for server-generated chunks.
    /// This is session/runtime state only; it is not a document command and
    /// must not be persisted in saved views.
    ViewerInterest { interest: ViewerInterestHint },
    /// Request a fresh authoritative [`ServerMessage::Snapshot`] for this
    /// session. Sent when the client detects a gap in the sequenced
    /// `CommandBroadcast`/`Ack` stream (the server's per-client broadcast
    /// queue overflowed and dropped messages). The server answers on the
    /// requester's connection with the same snapshot a (re)connect
    /// receives, and the client resumes seq tracking from the snapshot's
    /// `seq`. Carries no fields: the snapshot is self-describing, and the
    /// client's seq discipline makes a redundant snapshot harmless.
    RequestSnapshot,
    /// **Send report**: post a bundle to the workspace inbox, where the CLI
    /// lists and fetches it. Sent only when a person presses the action in
    /// the monitor; nothing sends it on a run's close or on any schedule.
    ///
    /// `bundle` is the bundle's JSON as text, not as a value. What the CLI
    /// fetches has to be what the page produced, so the payload crosses
    /// the wire, the store, and the fetch as the same bytes, and nothing
    /// in between re-serializes it. The server reads out only the header
    /// it needs to describe the entry: the inbox is a mailbox, not a
    /// trace store (ADR 0050 as amended). The server answers the
    /// requester with [`ServerMessage::ReportSent`] or
    /// [`ServerMessage::ReportFailed`].
    ///
    /// Variant added at the end so the serde tag positions of older
    /// variants don't shift.
    SendReport { request_id: String, bundle: String },
    /// Subscribe this connection to the workspace's watch stream (ADR 0051
    /// as amended). The server answers with the ring it keeps for late
    /// joiners and then relays every item published from that point on, each
    /// as a [`ServerMessage::WatchUpdate`].
    ///
    /// Carries no fields: a subscriber receives every publishing page's items
    /// and filters by `client_id` itself, so the server holds no per-subscriber
    /// state beyond the registration. Repeating it on a subscribed connection
    /// replays the ring again and changes nothing else.
    ///
    /// Variant added at the end so the serde tag positions of older
    /// variants don't shift.
    WatchSubscribe,
    /// One item of this page's watch stream, sent while its watch toggle is
    /// on. The server appends it to the ring and relays it to subscribers; it
    /// computes nothing over it and never writes an item of its own.
    ///
    /// Variant added at the end so the serde tag positions of older
    /// variants don't shift.
    WatchPublish { item: WatchItem },
}

/// One item on the watch stream (ADR 0051 as amended): what a page publishes
/// while its watch toggle is on, and what the server relays to subscribers.
///
/// A closed set of three, and none of them is a lifecycle row. The aggregate
/// carries the trace's per-tick sample and its newest reading, the boundary a
/// run's edge, and the provisional item the page's own provisional reading.
/// What a subscriber costs the page is bounded by the publish cadence and the
/// dataset count, never by the chunk count.
///
/// Every key of every kind is always present, `null` included, so a reader
/// can match on a fixed shape rather than on which keys survived.
///
/// Field naming: the stream's own fields follow the protocol's snake_case.
/// The objects inside `reading`, `ticks`, `cause`, and the provisional
/// reading are the trace's own, in the trace's camelCase, passed through
/// unchanged. That is deliberate — what a watcher prints for a tick is what
/// the trace document holds for it — and their vocabulary is versioned by the
/// trace's schema integer rather than by this enum.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WatchItem {
    /// What the page's per-tick aggregate did over the stretch since the
    /// previous aggregate: the process-wide totals for the whole stretch, the
    /// newest reading, and the newest planning sample per dataset.
    ///
    /// The trace keeps every tick; the stream samples them, so an aggregate's
    /// size is set by how many datasets planned, not by how often. The split
    /// below keeps that lossless. A dataset's counters are gauges of one
    /// planning pass, so the newest is the current state and the passes before
    /// it are superseded. The counted phases and the send tallies are deltas,
    /// so they are summed over every sample in the stretch and carried here
    /// rather than on a tick. Here is also where they belong: they are the
    /// page's, not any one dataset's.
    Aggregate {
        /// Wall clock at publish, so a reader can place an item the ring
        /// replayed long after it happened.
        at_epoch_ms: u64,
        /// The labelled run open at the sample, or null in the steady-state
        /// interval between runs.
        run_id: Option<String>,
        /// The newest reading taken since the previous aggregate, or null
        /// when the page did not tick in between.
        reading: Option<WatchReading>,
        /// The counted-not-timed phases over the stretch, process-wide.
        counted: BTreeMap<String, u64>,
        /// What the page sent over the session socket during the stretch, by
        /// client message type, process-wide. Sum the stream's aggregates for
        /// an interval's total.
        sent: BTreeMap<String, WatchSendTally>,
        /// At most one per dataset. Empty when nothing re-planned.
        ticks: Vec<WatchTick>,
    },
    /// A run opened or closed, or the stream itself started or stopped. A
    /// closed run carries its cause as well as its end, because a late joiner
    /// may have missed the open.
    Boundary {
        at_epoch_ms: u64,
        event: WatchBoundaryEvent,
        /// The run the boundary is of. On the stream's own start and stop,
        /// the labelled run open at that moment, or null.
        run_id: Option<String>,
        /// Why the run opened, as the trace records it. Null when no labelled
        /// run is named.
        cause: Option<WatchRunCause>,
        /// Why the run closed, on `run_closed`; null otherwise.
        end_reason: Option<String>,
        /// How long the run lasted, on `run_closed`; null otherwise.
        duration_us: Option<u64>,
    },
    /// The page's provisional reading over a trailing window of the open run,
    /// on the page's fixed interval. Labelled provisional inside, as
    /// everywhere: it is never a verdict and no gate reads it.
    Provisional {
        at_epoch_ms: u64,
        /// The diagnostic document's own object, as the trace seam's
        /// `provisional()` returned it, carried opaquely.
        ///
        /// Not restated as a Rust type on purpose. The derivation is the one
        /// seam, its schema is versioned by the diagnostic's own integer, and
        /// a mirror here would be a second definition of it that nothing on
        /// this side reads — the relay forwards the frame without parsing it
        /// and the watcher prints it. A provisional reading walks no row and
        /// has no row-bearing field, which is what keeps a row out of this
        /// variant.
        ///
        /// Named in full rather than as a bare `reading`, which the glossary
        /// reserves for one counter-track sample — the thing the aggregate's
        /// `reading` is. A subscriber that matched on the short name would
        /// get a different concept per kind.
        provisional_reading: serde_json::Value,
    },
}

/// What a boundary marks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchBoundaryEvent {
    /// The page turned its watch toggle on. Always a stream's first item, so
    /// silence after it means a page with nothing to report rather than a
    /// lost socket.
    WatchStarted,
    /// The page turned its watch toggle off. Not sent when the page loses its
    /// socket: the toggle is off after a reconnect, and the new connection is
    /// a new publisher.
    WatchStopped,
    RunOpened,
    RunClosed,
}

/// Why a run opened, as the trace's run header records it: the epoch the
/// input moved, the kind of dirty, and the input or emit site behind it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRunCause {
    pub epoch: Option<String>,
    pub dirty_kind: String,
    pub source: String,
}

/// One process-wide reading, as the trace's reading tier records it: the four
/// counter-track quantities, plus the GPU pass time when the adapter gave
/// one.
///
/// Fields the trace adds later ride through in `extra` rather than being
/// dropped on the way to the watcher.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchReading {
    /// Microseconds from the interval's start, on the page's clock.
    pub at_us: f64,
    pub queue_depth: f64,
    pub in_flight: f64,
    /// Main-thread frame time; every surface labels it that way.
    pub frame_time_us: f64,
    pub resident_bytes: f64,
    /// Absent, never zero, when the adapter offers no timestamp queries or no
    /// frame was read back since the previous reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_pass_us: Option<f64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// One dataset's planning state at one pass, as the trace's per-tick
/// aggregate records it. The process-wide deltas that ride the same sample in
/// the trace are summed onto the aggregate instead.
///
/// The counter names are the trace's closed set and ride as map keys rather
/// than being restated here, so the trace stays the one place that names
/// them. Fields the trace adds later ride through in `extra`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchTick {
    /// Microseconds from the interval's start, on the page's clock.
    pub at_us: u64,
    pub dataset_id: String,
    /// Lane counts, the culling funnel, and the active-set tallies.
    pub counters: BTreeMap<String, u64>,
    /// Only levels with a non-zero column.
    pub levels: Vec<WatchTickLevel>,
    pub levels_dropped: u64,
    pub target_level: Option<WatchLevelRange>,
    pub level_pinned: bool,
    pub displayed_level: Option<WatchLevelRange>,
    /// Whether an availability update alone woke the pass, as the trace's
    /// per-tick sample records it. A page older than that field omits it.
    #[serde(default)]
    pub availability_woken: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// How much the page sent under one client message type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchSendTally {
    pub messages: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchTickLevel {
    pub level: u32,
    pub planned: u64,
    pub cached: u64,
    pub in_flight: u64,
}

/// The finest and coarsest level a tick sample reports. `min == max` for a
/// single image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchLevelRange {
    pub min: u32,
    pub max: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewerInterestHint {
    #[serde(default)]
    pub client_id: Option<ClientId>,
    pub dataset_id: DatasetId,
    pub generation: u64,
    pub t: u32,
    pub z: u32,
    #[serde(default)]
    pub channels: Vec<u32>,
    pub mode: ViewerInterestMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<ViewerInterestViewport>,
    #[serde(default)]
    pub desired_keys: Vec<ViewerInterestChunkKey>,
    #[serde(default)]
    pub predicted_keys: Vec<ViewerInterestChunkKey>,
    pub interaction: ViewerInteractionMode,
    pub timestamp_ms: u64,
    pub ttl_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewerInterestMode {
    Slice,
    Volume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewerInteractionMode {
    Idle,
    Panning,
    Zooming,
    Scrubbing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewerInterestViewport {
    pub xy_bounds: [f64; 4],
    pub z_range: [f64; 2],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewerInterestChunkKey {
    pub image_id: ImageId,
    pub key: String,
    #[serde(default)]
    pub lane: ViewerInterestLane,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ViewerInterestLane {
    #[default]
    Visible,
    Predicted,
    Background,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// First message on connect. Full authoritative document state + peer presence.
    Snapshot {
        seq: u64,
        document: DocumentState,
        peers: Vec<PresenceState>,
        your_id: ClientId,
        /// Server-authored runtime generated-level availability, keyed by
        /// dataset. This is not part of `DocumentState` and is not sequenced as
        /// a document command.
        #[serde(default)]
        generated_availability: HashMap<DatasetId, GeneratedAvailabilitySnapshot>,
    },
    /// Command from another client, broadcast to all except sender.
    CommandBroadcast { seq: u64, command: DocumentCommand },
    /// Sent only to the command's sender confirming application.
    Ack { seq: u64 },
    /// A new client connected.
    PeerJoined {
        client_id: ClientId,
        presence: PresenceState,
    },
    /// A client disconnected.
    PeerLeft { client_id: ClientId },
    /// A peer's viewport state changed.
    PresenceUpdate {
        client_id: ClientId,
        camera: Camera,
        view: ViewState,
        display: DisplayState,
    },
    /// A peer's cursor moved (null = cursor left the canvas).
    CursorUpdate {
        client_id: ClientId,
        position: Option<[f64; 2]>,
    },
    /// A peer's follow target changed.
    FollowChanged {
        client_id: ClientId,
        target: Option<ClientId>,
    },
    /// A peer's layer presence changed.
    DatasetPresenceUpdate {
        client_id: ClientId,
        dataset_order: Vec<DatasetId>,
        dataset_settings: HashMap<DatasetId, DatasetDisplaySettings>,
    },
    /// Sent to the requester while OpenRemoteDataset is moving through
    /// coarse, stable server-authored stages.
    DatasetOpenProgress {
        request_id: String,
        url: String,
        diagnostic: DatasetOpenProgressDiagnostic,
    },
    /// Sent to the requester when OpenRemoteDataset succeeds.
    OpenDatasetSucceeded {
        request_id: String,
        url: String,
        seq: u64,
        opened: lucida_protocol::DatasetOpened,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diagnostic: Option<DatasetOpenSuccessDiagnostic>,
    },
    /// Sent to the requester when OpenRemoteDataset cannot be fulfilled.
    OpenDatasetFailed {
        request_id: String,
        url: String,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diagnostic: Option<DatasetOpenFailureDiagnostic>,
    },
    /// Sent to the requester with server-authored runtime dataset health.
    DatasetHealth {
        request_id: String,
        datasets: Vec<DatasetSourceHealth>,
    },
    /// Incremental update to a dataset's asset catalog.
    AssetCatalogUpdate {
        dataset_id: DatasetId,
        delta: AssetCatalogDelta,
    },
    /// Runtime generated-level metadata/readiness update. Server-authored and
    /// unsequenced; clients merge it into their local availability view.
    GeneratedAvailabilityUpdate {
        dataset_id: DatasetId,
        delta: GeneratedAvailabilityDelta,
    },
    /// Response to a generated chunk request when bytes are not available.
    /// Ready generated chunks still use the normal binary chunk frame.
    GeneratedChunkStatus {
        dataset_id: DatasetId,
        image_id: ImageId,
        key: String,
        status: GeneratedChunkStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// A server-stored bookmark was created, renamed, or deleted.
    /// Broadcast to clients whose session has at least one loaded dataset
    /// that overlaps `dataset_urls`. The client refetches the bookmark by
    /// id (on Created/Updated) or removes it from local state (on
    /// Deleted) — keeping the broadcast payload small.
    ///
    /// Variant added at the end so the serde tag positions of older
    /// variants don't shift.
    BookmarkChanged {
        id: String,
        action: BookmarkAction,
        dataset_urls: Vec<String>,
    },
    /// A workspace was archived while this client was connected.
    /// Workspace clients should stop reconnecting and leave the workspace route.
    WorkspaceArchived { workspace_id: String },
    /// Sent to the requester when a source chunk's store read fails with a
    /// non-not-found error (revoked access, backend failure, unreachable
    /// store). Not-found is legitimate sparse data and keeps the canonical
    /// zero-filled binary frame; successful reads keep the binary chunk
    /// frame. Without this frame the client only observes its own request
    /// timeout, which it must treat as transient — a dead source would
    /// stay invisible behind a stalling canvas.
    ///
    /// Variant added at the end so the serde tag positions of older
    /// variants don't shift.
    SourceChunkStatus {
        dataset_id: DatasetId,
        image_id: ImageId,
        key: String,
        status: SourceChunkStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// One flush window of the server's own lifecycle table, pushed to the
    /// client whose requests produced the rows (ADR 0050).
    ///
    /// Push rather than pull: a run is a client-side interval and the server
    /// has no idea runs exist, so it cannot detect "the end" a pull would
    /// wait for. Batched rather than per-row: a peak burst is thousands of
    /// chunk requests, and one message each would roughly double
    /// server-to-client traffic on the exact path the monitor exists to
    /// explain.
    ///
    /// A client receives only rows keyed to itself. There is no
    /// process-wide aggregate, no server-side trace store, and no
    /// server-side trace endpoint — the browser owns the merged trace.
    ///
    /// Variant added at the end so the serde tag positions of older
    /// variants don't shift.
    TimingBatch { batch: ServerTimingBatch },
    /// Sent to the requester when a [`ClientMessage::SendReport`] landed in
    /// the workspace inbox. `entry_id` is what `lucida trace inbox fetch`
    /// takes, and `expires_at` (RFC 3339) is when the inbox's fixed
    /// retention drops the entry.
    ///
    /// Variant added at the end so the serde tag positions of older
    /// variants don't shift.
    ReportSent {
        request_id: String,
        entry_id: String,
        expires_at: String,
    },
    /// Sent to the requester when a [`ClientMessage::SendReport`] could not
    /// be stored: no workspace on this session, a bundle without a header
    /// or over the size cap, or a store failure. Nothing was kept.
    ///
    /// Variant added at the end so the serde tag positions of older
    /// variants don't shift.
    ReportFailed { request_id: String, error: String },
    /// One item of a page's watch stream, relayed to a connection that sent
    /// [`ClientMessage::WatchSubscribe`] (ADR 0051 as amended).
    ///
    /// `client_id` is the publishing page, so a subscriber can follow one
    /// session in a workspace where several pages publish. `seq` is the
    /// workspace's running count of relayed items, from 1: the ring a late
    /// joiner receives and the live items that follow it share one sequence,
    /// so a subscriber can see a gap where the ring wrapped and never sees an
    /// item twice.
    ///
    /// The server computes nothing here. The item is the page's, as sent, and
    /// no row rides it.
    ///
    /// Variant added at the end so the serde tag positions of older
    /// variants don't shift.
    WatchUpdate {
        client_id: ClientId,
        seq: u64,
        item: WatchItem,
    },
}

/// The kind of mutation a `BookmarkChanged` describes. Wire encoding is
/// the lowercase variant name (`"created"` / `"updated"` / `"deleted"`)
/// so the JSON shape stays stable if the Rust enum is later renamed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BookmarkAction {
    Created,
    Updated,
    Deleted,
}

/// Chunk-related messages exchanged between clients and server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChunkMessage {
    /// Viewer -> Server: request a chunk from the dataset's data source.
    ChunkRequest {
        /// Correlation label: the join key between this client's lifecycle
        /// row and the server's row for the same wire request (ADR 0048).
        /// Minted by the client from one per-connection monotonic counter
        /// shared with `AssetRequest`, so `(connection, rid)` is unique.
        ///
        /// Required, not optional: `#[serde(default)]` would let a client
        /// that stopped sending it degrade silently to `rid: 0` on every
        /// row, and a join key whose failure mode is invisible is worse
        /// than no join at all. Eleven bytes on a ~95-byte message is not
        /// what anyone opts out of.
        rid: u32,
        dataset_id: DatasetId,
        image_id: ImageId,
        key: String,
    },
    /// Server -> Data source: fetch this chunk and send it to `client_id`.
    ChunkFetch {
        client_id: u64,
        /// The requesting client's correlation label, carried across the
        /// server-to-data-source hop so a permit wait behind the source-read
        /// cap can be attributed to a request rather than only to a client.
        rid: u32,
        dataset_id: DatasetId,
        image_id: ImageId,
        key: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_round_trips() {
        let doc = DocumentState::default();
        let msg = ServerMessage::Snapshot {
            seq: 1,
            document: doc,
            peers: Vec::new(),
            your_id: 42,
            generated_availability: HashMap::new(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::Snapshot { seq, your_id, .. } => {
                assert_eq!(seq, 1);
                assert_eq!(your_id, 42);
            }
            _ => panic!("expected Snapshot"),
        }
    }

    #[test]
    fn ack_round_trips() {
        let msg = ServerMessage::Ack { seq: 42 };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"ack\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::Ack { seq } => assert_eq!(seq, 42),
            _ => panic!("expected Ack"),
        }
    }

    #[test]
    fn chunk_request_round_trips() {
        let msg = ChunkMessage::ChunkRequest {
            rid: 7,
            dataset_id: DatasetId("ds1".into()),
            image_id: ImageId("img1".into()),
            key: "0/0/0/0/0/0".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"chunk_request\""));
        let parsed: ChunkMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ChunkMessage::ChunkRequest {
                rid,
                dataset_id,
                image_id,
                key,
            } => {
                assert_eq!(rid, 7);
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(image_id, ImageId("img1".into()));
                assert_eq!(key, "0/0/0/0/0/0");
            }
            _ => panic!("expected ChunkRequest"),
        }
    }

    #[test]
    fn chunk_fetch_round_trips() {
        let msg = ChunkMessage::ChunkFetch {
            client_id: 42,
            rid: 9,
            dataset_id: DatasetId("ds1".into()),
            image_id: ImageId("img1".into()),
            key: "1/0/0/2/3/4".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"chunk_fetch\""));
        let parsed: ChunkMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ChunkMessage::ChunkFetch {
                client_id,
                rid,
                dataset_id,
                image_id,
                key,
            } => {
                assert_eq!(client_id, 42);
                assert_eq!(rid, 9);
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(image_id, ImageId("img1".into()));
                assert_eq!(key, "1/0/0/2/3/4");
            }
            _ => panic!("expected ChunkFetch"),
        }
    }

    /// A missing label must be a parse failure. `#[serde(default)]` here
    /// would turn a client that stopped labelling into `rid: 0` on every
    /// row — a join that still produces rows, just wrong ones.
    #[test]
    fn chunk_request_without_label_fails_to_parse() {
        let json =
            r#"{"type":"chunk_request","dataset_id":"ds1","image_id":"img1","key":"0/0/0/0/0/0"}"#;
        assert!(serde_json::from_str::<ChunkMessage>(json).is_err());
    }

    #[test]
    fn timing_batch_round_trips_as_columns() {
        let msg = ServerMessage::TimingBatch {
            batch: ServerTimingBatch {
                dropped: 2,
                rid: vec![4, 9, 0],
                request_id: vec![None, None, Some("web-open-4c1a".into())],
                family: vec![
                    lucida_protocol::TimingRowFamily::Chunk,
                    lucida_protocol::TimingRowFamily::Asset,
                    lucida_protocol::TimingRowFamily::MetadataRead,
                ],
                metadata_phase: vec![
                    None,
                    None,
                    Some(lucida_protocol::MetadataReadPhase::BackendRead),
                ],
                dispatch_offset_us: vec![0, 0, 1_204],
                duration_us: vec![0, 0, 63_441],
                outcome: vec![
                    lucida_protocol::TimingRowOutcome::Delivered,
                    lucida_protocol::TimingRowOutcome::NotReady,
                    lucida_protocol::TimingRowOutcome::Delivered,
                ],
                arrival_us: vec![120, 340],
                handoff_us: vec![8_100, 22_000],
                coalesced_onto: vec![lucida_protocol::LABEL_NONE; 2],
                ..Default::default()
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"timing_batch\""));
        // Columns, not an array of objects.
        assert!(json.contains("\"rid\":[4,9,0]"));
        // The metadata read keys on the open, and the two keys share one
        // set of columns rather than a second table.
        assert!(json.contains("\"request_id\":[null,null,\"web-open-4c1a\"]"));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::TimingBatch { batch } => {
                assert_eq!(batch.len(), 3);
                assert_eq!(batch.dropped, 2);
                assert_eq!(batch.handoff_us, vec![8_100, 22_000]);
                // The metadata row states its span in its own two columns:
                // the phase array has no slot a metadata read can fill.
                assert_eq!(batch.duration_us, vec![0, 0, 63_441]);
                assert_eq!(
                    batch.metadata_phase[2],
                    Some(lucida_protocol::MetadataReadPhase::BackendRead)
                );
            }
            _ => panic!("expected TimingBatch"),
        }
    }

    #[test]
    fn viewer_interest_round_trips_as_unsequenced_client_message() {
        let msg = ClientMessage::ViewerInterest {
            interest: ViewerInterestHint {
                client_id: None,
                dataset_id: DatasetId("ds1".into()),
                generation: 9,
                t: 2,
                z: 3,
                channels: vec![0, 2],
                mode: ViewerInterestMode::Slice,
                viewport: Some(ViewerInterestViewport {
                    xy_bounds: [0.0, 1.0, 2.0, 3.0],
                    z_range: [3.0, 4.0],
                }),
                desired_keys: vec![ViewerInterestChunkKey {
                    image_id: ImageId("img1".into()),
                    key: "1/2/0/0/0/0".into(),
                    lane: ViewerInterestLane::Visible,
                }],
                predicted_keys: vec![ViewerInterestChunkKey {
                    image_id: ImageId("img1".into()),
                    key: "1/2/0/0/0/1".into(),
                    lane: ViewerInterestLane::Predicted,
                }],
                interaction: ViewerInteractionMode::Scrubbing,
                timestamp_ms: 1234,
                ttl_ms: 2000,
            },
        };

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"viewer_interest\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::ViewerInterest { interest } => {
                assert_eq!(interest.dataset_id, DatasetId("ds1".into()));
                assert_eq!(interest.desired_keys[0].lane, ViewerInterestLane::Visible);
                assert_eq!(
                    interest.predicted_keys[0].lane,
                    ViewerInterestLane::Predicted
                );
                assert_eq!(interest.interaction, ViewerInteractionMode::Scrubbing);
            }
            _ => panic!("expected ViewerInterest"),
        }
    }

    #[test]
    fn request_snapshot_round_trips() {
        let msg = ClientMessage::RequestSnapshot;
        let json = serde_json::to_string(&msg).unwrap();
        // Wire-stability assertion: the resync request is exactly this
        // envelope — the web client emits it as a literal.
        assert_eq!(json, r#"{"type":"request_snapshot"}"#);
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, ClientMessage::RequestSnapshot));
    }

    #[test]
    fn client_message_request_snapshot_matches_wire_envelope() {
        // The exact client->server envelope the web sends on a detected
        // seq gap.
        let json = r#"{"type":"request_snapshot"}"#;
        let parsed: ClientMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(parsed, ClientMessage::RequestSnapshot));
    }

    #[test]
    fn command_broadcast_round_trips() {
        let cmd = DocumentCommand::RemoveDataset {
            id: DatasetId("ds1".into()),
        };
        let msg = ServerMessage::CommandBroadcast {
            seq: 5,
            command: cmd,
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::CommandBroadcast { seq, command } => {
                assert_eq!(seq, 5);
                match command {
                    DocumentCommand::RemoveDataset { id } => {
                        assert_eq!(id, DatasetId("ds1".into()));
                    }
                    _ => panic!("expected RemoveDataset command"),
                }
            }
            _ => panic!("expected CommandBroadcast"),
        }
    }

    #[test]
    fn client_message_command_round_trips() {
        let reg = crate::scene::test_helpers::make_dataset_opened("ds1", "test", 1);
        let msg = ClientMessage::Command {
            command: DocumentCommand::DatasetOpened(reg),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"command\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, ClientMessage::Command { .. }));
    }

    #[test]
    fn client_message_add_annotation_matches_wire_envelope() {
        // The exact client->server envelope from the slice wire contract.
        let json = r#"{"type":"command","command":{"type":"add_annotation","dataset_id":"wds-1","id":"pin-1","position":[3.0,4.0],"author":"alice","kind":"point"}}"#;
        let parsed: ClientMessage = serde_json::from_str(json).unwrap();
        match parsed {
            ClientMessage::Command {
                command:
                    DocumentCommand::AddAnnotation {
                        dataset_id,
                        id,
                        position,
                        author,
                        ..
                    },
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(id, "pin-1");
                assert_eq!(position, [3.0, 4.0]);
                assert_eq!(author, "alice");
            }
            _ => panic!("expected Command(AddAnnotation)"),
        }
    }

    #[test]
    fn add_annotation_broadcast_is_byte_identical_to_inbound_command() {
        // Client-supplied id means the inbound command and its rebroadcast
        // carry the same command object byte-for-byte (only seq differs). The
        // depth `z` rides along unchanged, so a peer receives the pin's z.
        let cmd = DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [3.0, 4.0],
            end: None,
            z: 8.5,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
            view: None,
        };
        let inbound = ClientMessage::Command {
            command: cmd.clone(),
        };
        let broadcast = ServerMessage::CommandBroadcast {
            seq: 7,
            command: cmd,
        };

        let inbound_v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&inbound).unwrap()).unwrap();
        let broadcast_v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&broadcast).unwrap()).unwrap();
        assert_eq!(inbound_v["command"], broadcast_v["command"]);
        assert_eq!(broadcast_v["command"]["z"], 8.5);
        assert_eq!(broadcast_v["type"], "command_broadcast");
        assert_eq!(broadcast_v["seq"], 7);
    }

    #[test]
    fn add_annotation_with_multi_dataset_view_rebroadcasts_byte_identical() {
        // The companion to the test above, but for an `AddAnnotation` carrying
        // an embedded `SavedView` with >=2 datasets — and asserting byte-identity
        // of the wire STRING, not a `serde_json::Value` compare. The Value compare
        // above is order-insensitive, so it would pass even if the embedded view's
        // per-dataset maps re-serialized in a different order; THIS test would not.
        //
        // It mimics the server's exact rebroadcast: parse the inbound
        // `ClientMessage` bytes, then re-serialize the parsed command inside a
        // `CommandBroadcast` (handler.rs: `from_str::<ClientMessage>` ->
        // `to_string(CommandBroadcast { seq, command })`). The `command` substring
        // of the broadcast must be byte-identical to the `command` substring of
        // the inbound message. This holds because `SavedView`'s maps are
        // `IndexMap` (insertion/parse order preserved); with `HashMap` the >=2
        // dataset maps re-emit in randomized order and this diverges.
        use crate::saved_view::SavedView;
        use lucida_content::LayoutId;

        let mut view = SavedView::empty([1024, 768]);
        for k in ["ds-aaaa", "ds-bbbb", "ds-cccc"] {
            view.active_layouts
                .insert(DatasetId(k.into()), LayoutId(format!("L-{k}")));
            view.dataset_settings
                .insert(DatasetId(k.into()), DatasetDisplaySettings::default());
            view.auto_contrast.insert(DatasetId(k.into()), false);
            view.dataset_order.push(DatasetId(k.into()));
        }

        let cmd = DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [3.0, 4.0],
            end: None,
            z: 0.0,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
            view: Some(Box::new(view)),
        };

        // Inbound wire bytes the author broadcasts.
        let inbound_json = serde_json::to_string(&ClientMessage::Command {
            command: cmd.clone(),
        })
        .unwrap();

        // SERVER: parse the inbound message, then re-serialize the parsed command
        // inside a broadcast (the real from_str -> to_string path).
        let parsed: ClientMessage = serde_json::from_str(&inbound_json).unwrap();
        let ClientMessage::Command { command } = parsed else {
            panic!("expected Command");
        };
        let broadcast_json =
            serde_json::to_string(&ServerMessage::CommandBroadcast { seq: 7, command }).unwrap();

        // Extract the raw `command` value substring from each (NOT via Value,
        // which would normalize order). In BOTH messages `command` is the LAST
        // field, so everything from `"command":` to the message's final closing
        // brace is the command value followed by exactly one `}` — identical
        // framing for both, so comparing those suffixes compares the command
        // bytes verbatim.
        fn command_suffix(s: &str) -> &str {
            let start = s.find("\"command\":").unwrap();
            &s[start..]
        }
        let inbound_cmd = command_suffix(&inbound_json);
        let broadcast_cmd = command_suffix(&broadcast_json);
        assert_eq!(
            inbound_cmd, broadcast_cmd,
            "rebroadcast command bytes must be byte-identical to inbound for a \
             >=2-dataset embedded view"
        );
        // Guard the embedded view actually rode along with >=2 datasets.
        assert!(inbound_cmd.contains("ds-aaaa"));
        assert!(inbound_cmd.contains("ds-bbbb"));
        assert!(inbound_cmd.contains("ds-cccc"));
    }

    #[test]
    fn snapshot_carries_annotations_under_document() {
        // A late joiner loads pins from snapshot.document.annotations,
        // including each pin's depth `z`.
        let mut doc = DocumentState::default();
        doc.apply(DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [10.0, 20.0],
            end: None,
            z: 12.5,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
            view: None,
        });
        let msg = ServerMessage::Snapshot {
            seq: 3,
            document: doc,
            peers: Vec::new(),
            your_id: 1,
            generated_availability: HashMap::new(),
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
        assert_eq!(v["type"], "snapshot");
        let pin = &v["document"]["annotations"]["wds-1"][0];
        assert_eq!(pin["id"], "pin-1");
        assert_eq!(pin["position"][0], 10.0);
        assert_eq!(pin["position"][1], 20.0);
        assert_eq!(pin["z"], 12.5);
        assert_eq!(pin["author"], "alice");
        assert_eq!(pin["kind"], "point");

        // And it round-trips back into a usable DocumentState with z intact.
        let parsed: ServerMessage =
            serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
        match parsed {
            ServerMessage::Snapshot { document, .. } => {
                let pins = &document.annotations[&DatasetId("wds-1".into())];
                assert_eq!(pins.len(), 1);
                assert_eq!(pins[0].z, 12.5);
            }
            _ => panic!("expected Snapshot"),
        }
    }

    #[test]
    fn client_message_remove_annotation_matches_wire_envelope() {
        let json = r#"{"type":"command","command":{"type":"remove_annotation","dataset_id":"wds-1","id":"pin-1"}}"#;
        let parsed: ClientMessage = serde_json::from_str(json).unwrap();
        match parsed {
            ClientMessage::Command {
                command: DocumentCommand::RemoveAnnotation { dataset_id, id },
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(id, "pin-1");
            }
            _ => panic!("expected Command(RemoveAnnotation)"),
        }
    }

    #[test]
    fn client_message_move_annotation_matches_wire_envelope() {
        // The exact client->server envelope from the slice wire contract.
        let json = r#"{"type":"command","command":{"type":"move_annotation","dataset_id":"wds-1","id":"pin-1","position":[3.0,4.0],"z":5.0}}"#;
        let parsed: ClientMessage = serde_json::from_str(json).unwrap();
        match parsed {
            ClientMessage::Command {
                command:
                    DocumentCommand::MoveAnnotation {
                        dataset_id,
                        id,
                        position,
                        end,
                        z,
                    },
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(id, "pin-1");
                assert_eq!(position, [3.0, 4.0]);
                // No `end` in this slice-#776 wire payload → defaults to None.
                assert_eq!(end, None);
                assert_eq!(z, 5.0);
            }
            _ => panic!("expected Command(MoveAnnotation)"),
        }
    }

    #[test]
    fn client_message_edit_comment_matches_wire_envelope() {
        // The exact client->server envelope from the slice wire contract.
        let json = r#"{"type":"command","command":{"type":"edit_comment","dataset_id":"wds-1","annotation_id":"pin-1","id":"c-1","text":"edited"}}"#;
        let parsed: ClientMessage = serde_json::from_str(json).unwrap();
        match parsed {
            ClientMessage::Command {
                command:
                    DocumentCommand::EditComment {
                        dataset_id,
                        annotation_id,
                        id,
                        text,
                    },
            } => {
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
                assert_eq!(annotation_id, "pin-1");
                assert_eq!(id, "c-1");
                assert_eq!(text, "edited");
            }
            _ => panic!("expected Command(EditComment)"),
        }
    }

    #[test]
    fn snapshot_reflects_moved_position_and_edited_text() {
        // A late joiner loads the pin at its moved position/z and the comment at
        // its edited text, straight from snapshot.document.annotations.
        let mut doc = DocumentState::default();
        doc.apply(DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [10.0, 20.0],
            end: None,
            z: 1.0,
            t: 0,
            c: 0,
            author: "alice".into(),
            kind: crate::scene::AnnotationKind::Point,
            view: None,
        });
        doc.apply(DocumentCommand::AddComment {
            dataset_id: DatasetId("wds-1".into()),
            annotation_id: "pin-1".into(),
            id: "c-1".into(),
            author: "alice".into(),
            text: "before".into(),
        });
        // Now update both. A whole-shape move (no `end`) — the rigid #776 path.
        doc.apply(DocumentCommand::MoveAnnotation {
            dataset_id: DatasetId("wds-1".into()),
            id: "pin-1".into(),
            position: [55.0, 66.0],
            end: None,
            z: 7.5,
        });
        doc.apply(DocumentCommand::EditComment {
            dataset_id: DatasetId("wds-1".into()),
            annotation_id: "pin-1".into(),
            id: "c-1".into(),
            text: "after".into(),
        });

        let msg = ServerMessage::Snapshot {
            seq: 5,
            document: doc,
            peers: Vec::new(),
            your_id: 1,
            generated_availability: HashMap::new(),
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
        let pin = &v["document"]["annotations"]["wds-1"][0];
        assert_eq!(pin["position"][0], 55.0);
        assert_eq!(pin["position"][1], 66.0);
        assert_eq!(pin["z"], 7.5);
        assert_eq!(pin["comments"][0]["id"], "c-1");
        assert_eq!(pin["comments"][0]["text"], "after");
        // Author is preserved across the edit.
        assert_eq!(pin["comments"][0]["author"], "alice");
    }

    #[test]
    fn client_message_presence_round_trips() {
        let msg = ClientMessage::Presence {
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"presence\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, ClientMessage::Presence { .. }));
    }

    #[test]
    fn client_message_steer_round_trips() {
        let msg = ClientMessage::Steer { client: 3 };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"steer\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::Steer { client } => assert_eq!(client, 3),
            _ => panic!("expected Steer"),
        }
    }

    #[test]
    fn client_message_follow_round_trips() {
        let msg = ClientMessage::Follow { target: Some(5) };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"follow\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::Follow { target } => assert_eq!(target, Some(5)),
            _ => panic!("expected Follow"),
        }
    }

    #[test]
    fn presence_state_round_trips() {
        let ps = PresenceState {
            client_id: 1,
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: None,
            cursor: Some([100.0, 200.0]),
            dataset_order: vec![],
            dataset_settings: HashMap::new(),
            identity: None,
        };
        let json = serde_json::to_string(&ps).unwrap();
        let parsed: PresenceState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.client_id, 1);
        assert_eq!(parsed.cursor, Some([100.0, 200.0]));
        assert_eq!(parsed.following, None);
        assert_eq!(parsed.identity, None);
    }

    #[test]
    fn presence_state_carries_identity_round_trip() {
        // #540: a peer's presence carries the server-authored display name +
        // avatar URL so the cursor overlay can render them.
        let ps = PresenceState {
            client_id: 9,
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: None,
            cursor: Some([1.0, 2.0]),
            dataset_order: vec![],
            dataset_settings: HashMap::new(),
            identity: Some(PeerIdentity {
                display_name: "Ada Lovelace".into(),
                picture_url: Some("https://example.com/ada.png".into()),
                initial: "A".into(),
            }),
        };
        let json = serde_json::to_string(&ps).unwrap();
        assert!(json.contains("\"display_name\":\"Ada Lovelace\""));
        assert!(json.contains("\"picture_url\":\"https://example.com/ada.png\""));
        let parsed: PresenceState = serde_json::from_str(&json).unwrap();
        let identity = parsed.identity.expect("identity present");
        assert_eq!(identity.display_name, "Ada Lovelace");
        assert_eq!(
            identity.picture_url.as_deref(),
            Some("https://example.com/ada.png")
        );
        assert_eq!(identity.initial, "A");
    }

    #[test]
    fn peer_identity_never_carries_raw_email_on_the_wire() {
        // Privacy invariant (#540 review): collaborator emails are owner-only,
        // so the identity broadcast to every co-present peer must NOT contain
        // the raw address. The server computes a single-grapheme `initial`
        // from display-name-or-email instead; the email itself never crosses.
        let identity =
            PeerIdentity::from_principal_parts("Ada Lovelace".into(), None, "ada@example.com");
        assert_eq!(identity.initial, "A");
        let json = serde_json::to_string(&identity).unwrap();
        assert!(
            !json.contains("ada@example.com"),
            "raw email must not appear in the identity JSON: {json}"
        );
        assert!(
            !json.contains("email"),
            "no email field on the wire: {json}"
        );
        assert!(
            !json.contains('@'),
            "no address local-part@domain leaks: {json}"
        );

        // Blank display name → initial falls back to the email local-part's
        // first letter, but STILL never exposes the address.
        let blank = PeerIdentity::from_principal_parts("   ".into(), None, "zoe@example.com");
        assert_eq!(blank.initial, "Z");
        let blank_json = serde_json::to_string(&blank).unwrap();
        assert!(!blank_json.contains("zoe@example.com"));
        assert!(!blank_json.contains('@'));
    }

    #[test]
    fn presence_state_without_identity_is_backward_tolerant() {
        // A peer (older client, or the anonymous `/ws` path) sends presence
        // with no `identity` key. It must still parse, with `identity = None`,
        // so the cursor falls back to the numeric-id rendering.
        let legacy = r#"{
            "client_id": 4,
            "camera": {"mode":"slice","center":[0.0,0.0],"zoom":1.0,"viewport":[800,600]},
            "view": {"z_range":{"start":0,"end":1},"t":0,"c":0},
            "display": {"contrast_min":0.0,"contrast_max":1.0,"gamma":1.0},
            "following": null,
            "cursor": null
        }"#;
        let parsed: PresenceState = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.client_id, 4);
        assert_eq!(parsed.identity, None);
        assert!(parsed.dataset_order.is_empty());
    }

    #[test]
    fn peer_identity_without_picture_url_round_trips() {
        // Dev sessions / providers with no avatar: `picture_url` is omitted on
        // the wire (skip_serializing_if) and parses back to None.
        let identity = PeerIdentity {
            display_name: "Dev User".into(),
            picture_url: None,
            initial: "D".into(),
        };
        let json = serde_json::to_string(&identity).unwrap();
        assert!(!json.contains("picture_url"));
        let parsed: PeerIdentity = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.display_name, "Dev User");
        assert_eq!(parsed.picture_url, None);
        assert_eq!(parsed.initial, "D");
    }

    #[test]
    fn peer_joined_round_trips() {
        let presence = PresenceState {
            client_id: 3,
            camera: Camera::new_2d([800, 600]),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: None,
            cursor: None,
            dataset_order: vec![],
            dataset_settings: HashMap::new(),
            identity: None,
        };
        let msg = ServerMessage::PeerJoined {
            client_id: 3,
            presence,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"peer_joined\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            parsed,
            ServerMessage::PeerJoined { client_id: 3, .. }
        ));
    }

    #[test]
    fn fly_camera_presence_round_trips() {
        use crate::camera::{ClipMode, Fly};
        let mut fly = Fly::new([1024, 768]);
        fly.position = [1.5, 2.5, 3.5];
        fly.orientation = [0.1, 0.2, 0.3, 0.9273]; // approximately normalized
        fly.clip_distance = 0.42;
        fly.clip_mode = ClipMode::Sphere;

        let ps = PresenceState {
            client_id: 7,
            camera: Camera::Fly(fly),
            view: ViewState::new(),
            display: DisplayState::default(),
            following: Some(3),
            cursor: Some([0.5, 0.5]),
            dataset_order: vec![],
            dataset_settings: HashMap::new(),
            identity: None,
        };
        let json = serde_json::to_string(&ps).unwrap();
        assert!(
            json.contains("\"mode\":\"fly\""),
            "JSON should contain fly mode tag"
        );
        let parsed: PresenceState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.client_id, 7);
        assert_eq!(parsed.following, Some(3));
        assert_eq!(parsed.cursor, Some([0.5, 0.5]));
        // Verify camera round-tripped as Fly with correct state
        match &parsed.camera {
            Camera::Fly(v) => {
                assert_eq!(v.position, [1.5, 2.5, 3.5]);
                assert!((v.orientation[0] - 0.1).abs() < 1e-10);
                assert_eq!(v.clip_distance, 0.42);
                assert_eq!(v.clip_mode, ClipMode::Sphere);
            }
            _ => panic!("expected Camera::Fly, got {:?}", parsed.camera),
        }
    }

    #[test]
    fn fly_camera_presence_update_round_trips() {
        use crate::camera::Fly;
        let fly = Fly::new([800, 600]);
        let msg = ServerMessage::PresenceUpdate {
            client_id: 5,
            camera: Camera::Fly(fly),
            view: ViewState::new(),
            display: DisplayState::default(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"presence_update\""));
        assert!(json.contains("\"mode\":\"fly\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::PresenceUpdate {
                client_id, camera, ..
            } => {
                assert_eq!(client_id, 5);
                assert!(matches!(camera, Camera::Fly(_)));
            }
            _ => panic!("expected PresenceUpdate"),
        }
    }

    #[test]
    fn open_remote_dataset_round_trips() {
        let msg = ClientMessage::OpenRemoteDataset {
            request_id: "req-1".into(),
            url: "/mnt/data/experiment.zarr".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"open_remote_dataset\""));
        assert!(json.contains("\"request_id\":\"req-1\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::OpenRemoteDataset { request_id, url } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(url, "/mnt/data/experiment.zarr");
            }
            _ => panic!("expected OpenRemoteDataset"),
        }
    }

    #[test]
    fn dataset_open_progress_round_trips() {
        use lucida_protocol::{DatasetOpenProgressDiagnostic, DatasetOpenStage};

        let msg = ServerMessage::DatasetOpenProgress {
            request_id: "req-1".into(),
            url: "/mnt/data/experiment.zarr".into(),
            diagnostic: DatasetOpenProgressDiagnostic {
                stage: DatasetOpenStage::GeneratedCoarsePlanning,
                message: "planning generated coarse levels".into(),
                workspace_dataset_id: Some(DatasetId("wds-1".into())),
                dataset_source_id: Some("source-1".into()),
                detail: Some("2 derived levels".into()),
                warning: false,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"dataset_open_progress\""));
        assert!(json.contains("\"stage\":\"generated_coarse_planning\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::DatasetOpenProgress {
                request_id,
                url,
                diagnostic,
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(url, "/mnt/data/experiment.zarr");
                assert_eq!(diagnostic.stage, DatasetOpenStage::GeneratedCoarsePlanning);
                assert_eq!(
                    diagnostic.workspace_dataset_id,
                    Some(DatasetId("wds-1".into()))
                );
            }
            _ => panic!("expected DatasetOpenProgress"),
        }
    }

    #[test]
    fn dataset_open_progress_warning_flag_round_trips() {
        use lucida_protocol::{DatasetOpenProgressDiagnostic, DatasetOpenStage};

        let msg = ServerMessage::DatasetOpenProgress {
            request_id: "req-1".into(),
            url: "/mnt/data/experiment.zarr".into(),
            diagnostic: DatasetOpenProgressDiagnostic {
                stage: DatasetOpenStage::MetadataImport,
                message: "label discovery was sampled".into(),
                workspace_dataset_id: Some(DatasetId("wds-1".into())),
                dataset_source_id: Some("source-1".into()),
                detail: None,
                warning: true,
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"warning\":true"));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::DatasetOpenProgress { diagnostic, .. } => {
                assert!(diagnostic.warning);
            }
            _ => panic!("expected DatasetOpenProgress"),
        }

        // Payloads without the flag (every ordinary stage transition, and
        // any sender predating it) parse as non-warnings, and non-warnings
        // omit the key on the wire.
        let without_flag = serde_json::json!({
            "type": "dataset_open_progress",
            "request_id": "req-1",
            "url": "/mnt/data/experiment.zarr",
            "diagnostic": {
                "stage": "metadata_import",
                "message": "metadata import complete"
            }
        });
        let parsed: ServerMessage = serde_json::from_value(without_flag).unwrap();
        match parsed {
            ServerMessage::DatasetOpenProgress { diagnostic, .. } => {
                assert!(!diagnostic.warning);
                let json = serde_json::to_string(&diagnostic).unwrap();
                assert!(!json.contains("warning"));
            }
            _ => panic!("expected DatasetOpenProgress"),
        }
    }

    #[test]
    fn open_dataset_failed_round_trips() {
        use lucida_protocol::{
            DatasetOpenFailureDiagnostic, DatasetOpenFailureKind, DatasetOpenStage,
        };

        let msg = ServerMessage::OpenDatasetFailed {
            request_id: "req-1".into(),
            url: "gs://bucket/missing.zarr".into(),
            error: "not found".into(),
            diagnostic: Some(DatasetOpenFailureDiagnostic {
                stage: DatasetOpenStage::BackendOpen,
                kind: DatasetOpenFailureKind::MissingObject,
                retryable: false,
                message: "not found".into(),
                detail: None,
            }),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"open_dataset_failed\""));
        assert!(json.contains("\"kind\":\"missing_object\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::OpenDatasetFailed {
                request_id,
                url,
                error,
                diagnostic,
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(url, "gs://bucket/missing.zarr");
                assert_eq!(error, "not found");
                assert_eq!(
                    diagnostic.unwrap().kind,
                    DatasetOpenFailureKind::MissingObject
                );
            }
            _ => panic!("expected OpenDatasetFailed"),
        }
    }

    #[test]
    fn dataset_health_request_round_trips() {
        let msg = ClientMessage::DatasetHealth {
            request_id: "health-1".into(),
            dataset_id: Some(DatasetId("wds-1".into())),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"dataset_health\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::DatasetHealth {
                request_id,
                dataset_id,
            } => {
                assert_eq!(request_id, "health-1");
                assert_eq!(dataset_id, Some(DatasetId("wds-1".into())));
            }
            _ => panic!("expected DatasetHealth"),
        }
    }

    #[test]
    fn dataset_retry_request_round_trips() {
        let msg = ClientMessage::DatasetRetry {
            request_id: "retry-1".into(),
            dataset_id: DatasetId("wds-1".into()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"dataset_retry\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::DatasetRetry {
                request_id,
                dataset_id,
            } => {
                assert_eq!(request_id, "retry-1");
                assert_eq!(dataset_id, DatasetId("wds-1".into()));
            }
            _ => panic!("expected DatasetRetry"),
        }
    }

    #[test]
    fn asset_catalog_update_round_trips() {
        use lucida_protocol::{AssetCatalogDelta, ProxyAvailability, ProxyKind};

        let msg = ServerMessage::AssetCatalogUpdate {
            dataset_id: DatasetId("ds1".into()),
            delta: AssetCatalogDelta {
                added: vec![ProxyAvailability {
                    entity_id: lucida_content::EntityId("e1".into()),
                    kinds: vec![ProxyKind::GroupProxy3D],
                    footprints: vec![],
                }],
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"asset_catalog_update\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::AssetCatalogUpdate { dataset_id, delta } => {
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(delta.added.len(), 1);
                assert_eq!(
                    delta.added[0].entity_id,
                    lucida_content::EntityId("e1".into())
                );
                assert_eq!(delta.added[0].kinds, vec![ProxyKind::GroupProxy3D]);
            }
            _ => panic!("expected AssetCatalogUpdate"),
        }
    }

    #[test]
    fn generated_availability_update_round_trips() {
        use lucida_content::{
            GeneratedLevelInfo, GeneratedLevelProvenance, GeneratedLevelRole, LevelGeometry,
        };
        use lucida_protocol::{
            GeneratedAvailabilityDelta, GeneratedChunkStatus, GeneratedChunkStatusUpdate,
            GeneratedLevelAvailability,
        };

        let msg = ServerMessage::GeneratedAvailabilityUpdate {
            dataset_id: DatasetId("ds1".into()),
            delta: GeneratedAvailabilityDelta {
                levels: vec![GeneratedLevelAvailability {
                    image_id: ImageId("img1".into()),
                    info: GeneratedLevelInfo {
                        level_index: 2,
                        role: GeneratedLevelRole::Coarse,
                        provenance: GeneratedLevelProvenance::default(),
                    },
                    level: LevelGeometry {
                        level_index: 2,
                        shape: [1, 1, 1, 64, 64],
                        chunk_shape: [1, 1, 1, 64, 64],
                        grid_shape: [1, 1, 1, 1, 1],
                        scale: [1.0, 1.0, 1.0, 8.0, 8.0],
                    },
                    summary: None,
                }],
                chunks: vec![GeneratedChunkStatusUpdate {
                    image_id: ImageId("img1".into()),
                    level_index: 2,
                    key: "2/0/0/0/0/0".into(),
                    status: GeneratedChunkStatus::Ready,
                    message: None,
                }],
            },
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"generated_availability_update\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::GeneratedAvailabilityUpdate { dataset_id, delta } => {
                assert_eq!(dataset_id, DatasetId("ds1".into()));
                assert_eq!(delta.levels.len(), 1);
                assert_eq!(delta.chunks[0].status, GeneratedChunkStatus::Ready);
            }
            _ => panic!("expected GeneratedAvailabilityUpdate"),
        }
    }

    #[test]
    fn generated_chunk_status_round_trips() {
        let msg = ServerMessage::GeneratedChunkStatus {
            dataset_id: DatasetId("ds1".into()),
            image_id: ImageId("img1".into()),
            key: "2/0/0/0/0/0".into(),
            status: GeneratedChunkStatus::Pending,
            message: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"generated_chunk_status\""));
        assert!(json.contains("\"status\":\"pending\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::GeneratedChunkStatus { status, .. } => {
                assert_eq!(status, GeneratedChunkStatus::Pending);
            }
            _ => panic!("expected GeneratedChunkStatus"),
        }
    }

    #[test]
    fn source_chunk_status_round_trips() {
        let msg = ServerMessage::SourceChunkStatus {
            dataset_id: DatasetId("ds1".into()),
            image_id: ImageId("img1".into()),
            key: "0/0/0/0/0/0".into(),
            status: SourceChunkStatus::FailedPermanent,
            message: Some("access denied".into()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"source_chunk_status\""));
        assert!(json.contains("\"status\":\"failed_permanent\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::SourceChunkStatus {
                status, message, ..
            } => {
                assert_eq!(status, SourceChunkStatus::FailedPermanent);
                assert_eq!(message.as_deref(), Some("access denied"));
            }
            _ => panic!("expected SourceChunkStatus"),
        }
    }

    #[test]
    fn bookmark_action_serializes_lowercase() {
        // Wire-stability assertion: action names are the lowercase enum
        // variant names. The web client matches on these strings; renaming
        // a variant must not change the JSON.
        assert_eq!(
            serde_json::to_string(&BookmarkAction::Created).unwrap(),
            "\"created\"",
        );
        assert_eq!(
            serde_json::to_string(&BookmarkAction::Updated).unwrap(),
            "\"updated\"",
        );
        assert_eq!(
            serde_json::to_string(&BookmarkAction::Deleted).unwrap(),
            "\"deleted\"",
        );
        let parsed: BookmarkAction = serde_json::from_str("\"created\"").unwrap();
        assert_eq!(parsed, BookmarkAction::Created);
    }

    #[test]
    fn bookmark_changed_round_trips() {
        let msg = ServerMessage::BookmarkChanged {
            id: "abc-123".into(),
            action: BookmarkAction::Created,
            dataset_urls: vec!["gs://bucket/a.zarr".into(), "gs://bucket/b.zarr".into()],
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"bookmark_changed\""));
        assert!(json.contains("\"action\":\"created\""));
        assert!(json.contains("\"id\":\"abc-123\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::BookmarkChanged {
                id,
                action,
                dataset_urls,
            } => {
                assert_eq!(id, "abc-123");
                assert_eq!(action, BookmarkAction::Created);
                assert_eq!(
                    dataset_urls,
                    vec![
                        "gs://bucket/a.zarr".to_string(),
                        "gs://bucket/b.zarr".to_string()
                    ],
                );
            }
            _ => panic!("expected BookmarkChanged"),
        }
    }

    #[test]
    fn bookmark_changed_updated_and_deleted_actions_round_trip() {
        for action in [BookmarkAction::Updated, BookmarkAction::Deleted] {
            let msg = ServerMessage::BookmarkChanged {
                id: "id".into(),
                action,
                dataset_urls: vec![],
            };
            let json = serde_json::to_string(&msg).unwrap();
            let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
            match parsed {
                ServerMessage::BookmarkChanged { action: a, .. } => assert_eq!(a, action),
                _ => panic!("expected BookmarkChanged"),
            }
        }
    }

    #[test]
    fn workspace_archived_round_trips() {
        let msg = ServerMessage::WorkspaceArchived {
            workspace_id: "workspace-1".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"workspace_archived\""));
        let parsed: ServerMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ServerMessage::WorkspaceArchived { workspace_id } => {
                assert_eq!(workspace_id, "workspace-1");
            }
            _ => panic!("expected WorkspaceArchived"),
        }
    }

    #[test]
    fn fly_camera_client_message_presence_round_trips() {
        use crate::camera::Fly;
        let fly = Fly::new([800, 600]);
        let msg = ClientMessage::Presence {
            camera: Camera::Fly(fly),
            view: ViewState::new(),
            display: DisplayState::default(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"presence\""));
        assert!(json.contains("\"mode\":\"fly\""));
        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::Presence { camera, .. } => {
                assert!(matches!(camera, Camera::Fly(_)));
            }
            _ => panic!("expected Presence"),
        }
    }

    fn watch_cause() -> WatchRunCause {
        WatchRunCause {
            epoch: Some("view".into()),
            dirty_kind: "interactive".into(),
            source: "pan".into(),
        }
    }

    /// One item of each kind, as a page publishes them.
    fn watch_items() -> Vec<WatchItem> {
        vec![
            WatchItem::Aggregate {
                at_epoch_ms: 1_700_000_000_250,
                run_id: Some("run-1".into()),
                reading: Some(WatchReading {
                    at_us: 4_200_000.0,
                    queue_depth: 20_000.0,
                    in_flight: 24.0,
                    frame_time_us: 8_300.0,
                    resident_bytes: 402_653_184.0,
                    gpu_pass_us: Some(2_100.0),
                    extra: BTreeMap::new(),
                }),
                counted: BTreeMap::from([("cache-admission".to_string(), 48)]),
                sent: BTreeMap::from([(
                    "chunkRequest".to_string(),
                    WatchSendTally {
                        messages: 12,
                        bytes: 1_140,
                    },
                )]),
                ticks: vec![WatchTick {
                    at_us: 4_199_000,
                    dataset_id: "wds-0f3a".into(),
                    counters: BTreeMap::from([("laneDetail".to_string(), 12)]),
                    levels: vec![WatchTickLevel {
                        level: 1,
                        planned: 48,
                        cached: 40,
                        in_flight: 8,
                    }],
                    levels_dropped: 0,
                    target_level: Some(WatchLevelRange { min: 1, max: 1 }),
                    level_pinned: false,
                    displayed_level: Some(WatchLevelRange { min: 1, max: 2 }),
                    availability_woken: false,
                    extra: BTreeMap::new(),
                }],
            },
            WatchItem::Boundary {
                at_epoch_ms: 1_700_000_004_700,
                event: WatchBoundaryEvent::RunClosed,
                run_id: Some("run-1".into()),
                cause: Some(watch_cause()),
                end_reason: Some("quiescent".into()),
                duration_us: Some(4_700_000),
            },
            WatchItem::Provisional {
                at_epoch_ms: 1_700_000_002_000,
                provisional_reading: serde_json::json!({
                    "provisional": true,
                    "runId": "run-1",
                    "statement": "provisional — nothing crossed a threshold in the window",
                }),
            },
        ]
    }

    #[test]
    fn watch_items_round_trip_on_both_envelopes() {
        for (item, tag) in watch_items()
            .into_iter()
            .zip(["aggregate", "boundary", "provisional"])
        {
            let published = ClientMessage::WatchPublish { item: item.clone() };
            let json = serde_json::to_string(&published).unwrap();
            assert!(
                json.starts_with(r#"{"type":"watch_publish","item":{"kind":""#),
                "{json}"
            );
            assert!(json.contains(&format!("\"kind\":\"{tag}\"")), "{json}");
            match serde_json::from_str::<ClientMessage>(&json).unwrap() {
                ClientMessage::WatchPublish { item: parsed } => assert_eq!(parsed, item),
                other => panic!("expected WatchPublish, got {other:?}"),
            }

            let relayed = ServerMessage::WatchUpdate {
                client_id: 3,
                seq: 12,
                item: item.clone(),
            };
            let json = serde_json::to_string(&relayed).unwrap();
            assert!(
                json.starts_with(r#"{"type":"watch_update","client_id":3,"seq":12,"#),
                "{json}"
            );
            match serde_json::from_str::<ServerMessage>(&json).unwrap() {
                ServerMessage::WatchUpdate {
                    client_id,
                    seq,
                    item: parsed,
                } => {
                    assert_eq!((client_id, seq), (3, 12));
                    assert_eq!(parsed, item);
                }
                other => panic!("expected WatchUpdate, got {other:?}"),
            }
        }
    }

    #[test]
    fn watch_subscribe_is_a_bare_tag() {
        let json = serde_json::to_string(&ClientMessage::WatchSubscribe).unwrap();
        assert_eq!(json, r#"{"type":"watch_subscribe"}"#);
        assert!(matches!(
            serde_json::from_str::<ClientMessage>(&json).unwrap(),
            ClientMessage::WatchSubscribe
        ));
    }

    /// The stream's shape, held to a list: no chunk identity, no phase
    /// stamps, no outcome, no fourth kind for a row to arrive under, and an
    /// aggregate whose finest grain is a dataset rather than a chunk.
    #[test]
    fn watch_items_carry_no_lifecycle_rows() {
        let expected_keys: [&[&str]; 3] = [
            &[
                "kind",
                "at_epoch_ms",
                "run_id",
                "reading",
                "counted",
                "sent",
                "ticks",
            ],
            &[
                "kind",
                "at_epoch_ms",
                "event",
                "run_id",
                "cause",
                "end_reason",
                "duration_us",
            ],
            &["kind", "at_epoch_ms", "provisional_reading"],
        ];
        for (item, expected) in watch_items().into_iter().zip(expected_keys) {
            let value = serde_json::to_value(&item).unwrap();
            let mut keys: Vec<&str> = value
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            let mut expected: Vec<&str> = expected.to_vec();
            expected.sort_unstable();
            assert_eq!(keys, expected, "{value}");
        }

        let aggregate = serde_json::to_value(&watch_items()[0]).unwrap();
        let tick = &aggregate["ticks"][0];
        for row_field in [
            "key", "chunk", "entityId", "imageId", "phases", "outcome", "rid",
        ] {
            assert!(tick.get(row_field).is_none(), "a tick carried {row_field}");
        }

        let row = r#"{"kind":"row","key":"0/0/0/0/0/0","phases":[]}"#;
        assert!(serde_json::from_str::<WatchItem>(row).is_err());
    }

    #[test]
    fn watch_payloads_keep_fields_the_trace_adds_later() {
        let json = r#"{"kind":"aggregate","at_epoch_ms":1,"run_id":null,
            "reading":{"atUs":1,"queueDepth":2,"inFlight":3,"frameTimeUs":4,"residentBytes":5,"bytesReceived":6},
            "counted":{},"sent":{},"ticks":[]}"#;
        let item: WatchItem = serde_json::from_str(json).unwrap();
        let WatchItem::Aggregate {
            reading: Some(reading),
            ..
        } = &item
        else {
            panic!("expected an aggregate with a reading");
        };
        assert_eq!(reading.gpu_pass_us, None);
        assert_eq!(reading.extra["bytesReceived"], serde_json::json!(6));
        let out = serde_json::to_value(&item).unwrap();
        assert_eq!(out["reading"]["bytesReceived"], serde_json::json!(6));
        assert!(out["reading"].get("gpuPassUs").is_none());
    }
}
