/**
 * WebSocket client for the workspace session: the transport (connect,
 * reconnect, throttled presence sends, the binary chunk envelope) and the
 * sequenced-document layer (seq tracking, gap buffering with snapshot resync,
 * the membership mirror, pending local-command replay across snapshots).
 *
 * The sequenced layer stays in this file on purpose: its resets interleave
 * with the connection lifecycle and transport readiness, so extracting it
 * would churn the most delicate reliability code for no behavior change.
 */
import { isDebugEnabled } from "./debug/logging.ts";
import type { ChunkFailureKind, SourceChunkStatus } from "./pipeline/fetch/contentSource.ts";
import { traceRecorder } from "./trace/recorder.ts";
import { classifyClientMessage, utf8ByteLength } from "./trace/sendAccounting.ts";
import type { ServerTimingBatch } from "./trace/serverRowTable.ts";
import type { SocketClose } from "./trace/types.ts";
import type {
  GeneratedChunkStatus,
  WireGeneratedAvailabilityByDataset,
} from "./pipeline/generatedAvailability.ts";

export type ClientId = number;

export type DatasetHealthStatus = "healthy" | "degraded" | "unavailable";

export interface DatasetHealthComponent {
  status: DatasetHealthStatus;
  message?: string | null;
}

export interface DatasetSourceCacheStats {
  max_bytes: number;
  current_bytes: number;
  used_percent: number;
  entry_count: number;
  hits: number;
  misses: number;
  evictions: number;
  backend_errors: number;
  source_reads: number;
  source_read_millis: number;
}

export interface DatasetGeneratedCoarseCacheStats {
  storage: string;
  current_bytes: number;
  max_bytes?: number | null;
  used_percent?: number | null;
  evictions: number;
  root?: string | null;
}

export interface DatasetGeneratedCoarseFailure {
  image_id: string;
  level_index: number;
  key: string;
  status: GeneratedChunkStatus;
  message?: string | null;
}

export interface DatasetGeneratedCoarseHealth {
  status: DatasetHealthStatus;
  level_count: number;
  ready_chunks: number;
  pending_chunks: number;
  failed_chunks: number;
  unavailable_chunks: number;
  message?: string | null;
  cache?: DatasetGeneratedCoarseCacheStats | null;
  recent_failures?: DatasetGeneratedCoarseFailure[];
}

export interface DatasetSourceHealth {
  workspace_dataset_id: string;
  name: string;
  status: DatasetHealthStatus;
  source_url?: string | null;
  backend?: string | null;
  binding: DatasetHealthComponent;
  source_cache?: DatasetSourceCacheStats | null;
  generated_coarse: DatasetGeneratedCoarseHealth;
  messages?: string[];
  /** What the import found. Omitted on the wire when empty. */
  import_warnings?: DatasetImportWarning[];
}

/** Mirror of `lucida_protocol::SourceThrottleReport`. */
export interface SourceThrottleReport {
  /** Absent when the values are not a named profile's. */
  profile?: string | null;
  latency_ms: number;
  jitter_ms: number;
  /** The cap on all source reads together. Absent when uncapped. */
  bytes_per_sec?: number | null;
}

/**
 * One dataset health reply. The throttle is the server's, on every source
 * read, and null when it reads sources unthrottled.
 */
export interface DatasetHealthReply {
  datasets: DatasetSourceHealth[];
  sourceThrottle: SourceThrottleReport | null;
}

export interface DatasetImportWarning {
  kind: DatasetImportWarningKind;
  target: string;
  /** The importer's account, for developers and agents. People see the warning worded from `kind`. */
  message: string;
  /** The warning says the data is shown wrong, so it degrades `status`. */
  degrades: boolean;
}

/** Mirror of `lucida_protocol::DatasetImportWarningKind`. */
export type DatasetImportWarningKind =
  | "skipped_group"
  | "unreadable_tile_geometry"
  | "unusable_tile_geometry"
  | "sampled_label_discovery"
  | "unusable_label_index"
  | "unwritten_level"
  | "mismatched_tile_geometry"
  | "duplicate_tile"
  | "malformed_collection_layout"
  | "pinned_axis"
  | "invalid_scale";

export type DatasetOpenStage =
  | "request_received"
  | "authorization"
  | "source_lookup"
  | "backend_open"
  | "metadata_import"
  | "binding_build"
  | "generated_coarse_planning"
  | "workspace_persist"
  | "broadcast"
  | "complete";

export interface DatasetOpenProgressDiagnostic {
  stage: DatasetOpenStage;
  message: string;
  workspace_dataset_id?: string | null;
  dataset_source_id?: string | null;
  detail?: string | null;
  /** A non-fatal import concern that stays visible after the open completes,
   *  unlike the transient progress line. Omitted on the wire when false; the
   *  bridge coerces it to a boolean for consumers. */
  warning?: boolean;
}

/**
 * Why the server did not act on a client message. Mirror of
 * `lucida_core::protocol::MessageRejection`.
 */
export type MessageRejection =
  | "malformed"
  | "unknown_type"
  | "binary_frame"
  | "throttled"
  | "unknown_dataset";

/** Mirror of `ServerMessage::MessageRejected`. */
export interface MessageRejectedWire {
  type: "message_rejected";
  request_id?: string;
  rid?: number;
  message_type?: string;
  reason: MessageRejection;
  message: string;
}

interface PendingDatasetHealthRequest {
  resolve: (reply: DatasetHealthReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * What the server answers a **Send report** with: where the bundle landed
 * in the workspace inbox, and when the inbox's fixed retention drops it.
 * `entryId` is what `lucida trace inbox fetch` takes.
 */
export interface InboxReceipt {
  entryId: string;
  /** RFC 3339. */
  expiresAt: string;
}

interface PendingSendReport {
  resolve: (receipt: InboxReceipt) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * How long a **Send report** waits for the server's receipt. A bundle is
 * megabytes, and the socket carries it behind whatever else is queued, so
 * this is longer than the health request's wait.
 */
const SEND_REPORT_TIMEOUT_MS = 60_000;

/**
 * A sequenced message (`command_broadcast` or `ack`) held back while a
 * snapshot resync is in flight. `commandJson` is `null` for acks: an ack only
 * advances seq tracking, since the sender already applied its own command.
 */
interface PendingSequenced {
  seq: number;
  commandJson: string | null;
  commandType?: string;
  /** Document-membership key, when the command changes membership:
   *  `manifest.dataset_id` for `dataset_opened`, `id` for `remove_dataset`. */
  datasetId?: string;
}

/** A document command applied locally and sent, awaiting its `Ack`. A
 *  mid-session snapshot's full-replace would erase its local effect, so these
 *  replay after snapshot adoption. Acks ride the broadcast queue and
 *  snapshots the unicast queue, so a snapshot can cover a command before its
 *  ack arrives, and the replay then briefly overwrites a newer peer edit.
 *  Accepted: that divergence is local and ends at the next edit or snapshot,
 *  while skipping the replay would erase the author's own edit. Acks retire
 *  entries FIFO, since the server acks one client's commands in send order. */
interface PendingLocalCommand {
  commandJson: string;
  commandType?: string;
  datasetId?: string;
  /** `Date.now()` at transmission. Acks carry only a seq, so retirement is
   *  FIFO and staleness must be structural; see
   *  [`PENDING_LOCAL_COMMAND_TTL_MS`]. */
  sentAt: number;
}

/** One resync request may be outstanding at a time. If the server hasn't
 *  answered after this long, another goes out, from a new gapped arrival or
 *  from the retry timer armed with every request. The timer recovers an idle
 *  workspace's residual hole and a request eaten by the server's per-client
 *  throttle (~1s). A gap storm costs at most one request per interval. */
const RESYNC_RETRY_MS = 5000;

/** Maximum age of a pending local command. A healthy answer takes well
 *  under a second; an entry this old lost its ack or rejection to broadcast
 *  lag, was shed by the cap, or sits on a dying connection. Without expiry, a
 *  stale pending `remove_dataset` replayed by a later snapshot would delete a
 *  re-opened dataset and poison the membership mirror. */
const PENDING_LOCAL_COMMAND_TTL_MS = 10_000;

/** How long a seq hole may stand before it counts as loss. A late arrival
 *  that fills the hole in this window drains the buffer with no snapshot. */
const RESYNC_GRACE_MS = 200;

/** Upper bound on messages buffered while a resync is in flight. Overflow
 *  drops the lowest-seq entries, the ones most likely covered by the
 *  snapshot being produced; a residual gap triggers another resync. */
const MAX_PENDING_SEQUENCED = 4096;

/** Upper bound on tracked unacked local commands. Broadcast lag can drop
 *  the answer to a command, so the list is capped (oldest shed) and cleared
 *  on disconnect rather than trusted to drain. */
const MAX_PENDING_LOCAL_COMMANDS = 64;

/** Throttle for presence and cursor updates, which fire per mouse move.
 *  Presence sends leading and trailing edge; cursor sends trailing. */
const PRESENCE_THROTTLE_MS = 50;

/** Throttle for dataset-presence updates: heavier and less frequent than
 *  camera presence, so a longer trailing-edge window. */
const DATASET_PRESENCE_THROTTLE_MS = 200;

const RECONNECT_DELAY_MS = 2000;

/** The server's close code for a socket whose principal lost access to the
 *  workspace (`CLOSE_ACCESS_REVOKED`, 1008 "policy violation"). */
const CLOSE_ACCESS_REVOKED = 1008;

/**
 * Bit 15 of a chunk frame's key length marks an encoded frame, whose codec
 * list sits between the key and the payload as `[codecs_len: u8][codecs]`.
 * Mirror of `lucida_protocol::codec::ENCODED_FRAME_FLAG`.
 */
const ENCODED_FRAME_FLAG = 0x8000;

/** Membership key of a document command, for the datasets-present mirror:
 *  `dataset_opened` adds `manifest.dataset_id`, `remove_dataset` removes
 *  `id`; every other command leaves membership untouched. */
function membershipDatasetId(
  command: { type?: string; id?: unknown; manifest?: { dataset_id?: unknown } } | null | undefined,
): string | undefined {
  if (!command) return undefined;
  if (command.type === "dataset_opened") {
    const id = command.manifest?.dataset_id;
    return typeof id === "string" ? id : undefined;
  }
  if (command.type === "remove_dataset") {
    return typeof command.id === "string" ? command.id : undefined;
  }
  return undefined;
}

/**
 * Gated debug logger for bridge events. Toggle from the console with
 * `localStorage.setItem("debug", "bridge")` and a reload (see debug/logging.ts).
 */
export function bridgeLog(event: string, data: Record<string, unknown> = {}, wsReadyState?: number) {
  if (!isDebugEnabled("bridge")) return;
  const payload = wsReadyState !== undefined ? { wsReadyState, ...data } : data;
  console.log(`[bridge] ${event}`, payload);
}

/**
 * Mirror of `lucida_core::protocol::PeerIdentity`, server-authored from the
 * connecting principal and shown on the peer's live cursor. Best-effort:
 * `display_name` may be empty, `picture_url` absent, and the whole object is
 * absent for sessions without auth, so peer rendering must tolerate that.
 *
 * No email: collaborator emails are owner-only and every co-present peer sees
 * presence. The server precomputes `initial` so no address crosses the wire.
 */
export interface PeerIdentity {
  display_name: string;
  picture_url?: string | null;
  /** Single-grapheme fallback for the avatar chip, computed server-side
   *  (display name, else email local-part). Never the raw email. May be
   *  absent or empty for legacy peers. */
  initial?: string;
}

/** Mirror of `lucida_core::protocol::PresenceState`. A field the peer has not
 *  reported yet is absent, so a follower adopts nothing for it. */
export interface PresenceState {
  client_id: ClientId;
  /** Camera, view and display arrive together in one `presence` message. */
  camera?: unknown;
  view?: { z_range: { start: number; end: number }; t: number };
  display?: { contrast_min: number; contrast_max: number; gamma: number };
  following: ClientId | null;
  cursor: [number, number] | null;
  /** Order and settings arrive together in one `dataset_presence` message. */
  dataset_order?: string[];
  dataset_settings?: Record<string, unknown>;
  /** Presentational identity for this peer's cursor. Absent for peers from a
   *  session without auth. */
  identity?: PeerIdentity | null;
}

/** `PresenceState` as the server sends it. A peer that has not reported a
 *  camera still carries `camera`, `view` and `display` for readers that
 *  predate `camera_reported`, so those values are not the peer's. */
type PresenceStateWire = Omit<PresenceState, "camera" | "view" | "display"> & {
  camera: unknown;
  view: NonNullable<PresenceState["view"]>;
  display: NonNullable<PresenceState["display"]>;
  camera_reported?: boolean;
};

function readPresence(wire: PresenceStateWire): PresenceState {
  const { camera_reported, ...presence } = wire;
  if (camera_reported !== false) return presence;
  const { camera: _camera, view: _view, display: _display, ...unreported } = presence;
  return unreported;
}

export interface BridgeHandlers {
  onSnapshot: (
    seq: number,
    documentJson: string,
    peers: PresenceState[],
    yourId: ClientId,
    generatedAvailability: WireGeneratedAvailabilityByDataset,
  ) => void;
  onCommand: (seq: number, commandJson: string) => void;
  onAck: (seq: number) => void;
  /**
   * Binary frame, forwarded as (key, payload, codecs) after the bridge parses
   * the envelope (client_id, keyLen, key, payload). `codecs` is an encoded
   * frame's codec list, null for decoded bytes. Routing by key and decoding
   * live in the fetch pipeline, so the bridge stays a generic binary
   * transport.
   */
  onBinary?: (key: string, payload: ArrayBuffer, codecs: Uint8Array | null) => void;
  onPeerJoined?: (clientId: ClientId, presence: PresenceState) => void;
  onPeerLeft?: (clientId: ClientId) => void;
  onPresenceUpdate?: (clientId: ClientId, camera: unknown, view: PresenceState["view"], display: PresenceState["display"]) => void;
  onCursorUpdate?: (clientId: ClientId, position: [number, number] | null) => void;
  onFollowChanged?: (clientId: ClientId, target: ClientId | null) => void;
  onDatasetPresenceUpdate?: (clientId: ClientId, datasetOrder: string[], datasetSettings: Record<string, unknown>) => void;
  onDatasetOpenProgress?: (
    requestId: string,
    url: string,
    diagnostic: DatasetOpenProgressDiagnostic,
  ) => void;
  /**
   * `requestId` is the open's own id, echoed back: the trace brackets an
   * open by it, and a failed open's bracket has to close as surely as a
   * successful one's.
   */
  onOpenDatasetFailed?: (requestId: string, url: string, error: string) => void;
  onGeneratedAvailabilityUpdate?: (datasetId: string, deltaJson: string) => void;
  onGeneratedChunkStatus?: (
    datasetId: string,
    imageId: string,
    key: string,
    status: GeneratedChunkStatus,
    message?: string | null,
  ) => void;
  /**
   * The server answered a source chunk request without bytes, and `failure`
   * says why. Routed into the fetch pipeline so the pending request fails
   * with that reason instead of timing out as a transient.
   */
  onSourceChunkStatus?: (
    datasetId: string,
    imageId: string,
    key: string,
    status: SourceChunkStatus,
    message?: string | null,
    failure?: ChunkFailureKind | null,
  ) => void;
  onWorkspaceArchived?: (workspaceId: string) => void;
  /**
   * The server closed the socket because this person no longer has access
   * to the workspace. The bridge is already destroyed: reconnecting would
   * only be refused.
   */
  onAccessRevoked?: () => void;
  /**
   * The server refused one of this client's document commands and applied
   * nothing. The bridge has already asked for the snapshot that undoes the
   * optimistic apply; this is for telling the person.
   */
  onCommandRejected?: (reason: CommandRejection) => void;
  /**
   * The WebSocket reached OPEN; before this, [`Bridge.send`] silently drops.
   * Distinct from `onSnapshot`, the session-established signal: a frame sent
   * between the two still reaches the server. Fires on every (re)connect.
   *
   * `generation` counts this bridge's connections from 1. Correlation labels
   * restart at zero on each, so only `(generation, rid)` is unique across a
   * run that outlived a socket.
   */
  onConnected?: (generation: number) => void;
  /**
   * One flush window of the server's lifecycle rows for this client's own
   * requests. Pushed on the server's ticker; nothing here is polled and
   * there is no server-side trace store to poll.
   */
  onTimingBatch?: (batch: ServerTimingBatch, generation: number) => void;
  /** The connection dropped, or closed because the page went into the
   *  back-forward cache or froze. A reconnect follows, once the page is back
   *  if it went away. */
  onDisconnect?: (close: SocketClose) => void;
}

/** Mirror of `lucida_core::protocol::CommandRejection`. */
export type CommandRejection = "forbidden" | "invalid" | "unavailable";

/** The socket for one workspace, on the page's own origin. Same-origin so
 *  the session cookie rides the upgrade handshake: browsers withhold
 *  SameSite=Lax cookies from a cross-origin WebSocket upgrade. The Vite dev
 *  server proxies `/ws` to the backend; production serves both from one
 *  origin. */
export function workspaceSocketUrl(workspaceId: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/workspaces/${encodeURIComponent(workspaceId)}`;
}

export class Bridge {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: BridgeHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /** True while the page sits in the back-forward cache or is frozen. Its
   *  socket stays closed until the page is back. */
  private suspended = false;
  private readonly stopListeningToPage: () => void;
  /** Sockets this bridge has opened. The other half of the trace's join key. */
  private connectionGeneration = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPresence: string | null = null;
  private datasetPresenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDatasetPresence: string | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: string | null = null;
  private pendingDatasetHealth = new Map<string, PendingDatasetHealthRequest>();
  private pendingSendReports = new Map<string, PendingSendReport>();
  /** Highest contiguously applied document `seq` on this connection,
   *  advanced by snapshots, in-order broadcasts, and acks of our own
   *  commands (which the server never rebroadcasts to us). `null` until the
   *  first snapshot. */
  private lastAppliedSeq: number | null = null;
  /** True while a `request_snapshot` is outstanding; cleared by the next
   *  snapshot or a disconnect. */
  private resyncInFlight = false;
  private lastResyncRequestAt = 0;
  /** Armed when a seq hole appears; fires after [`RESYNC_GRACE_MS`] and
   *  requests a snapshot only if the hole still stands (a late arrival
   *  filling it empties the buffer and the callback no-ops). */
  private resyncGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Armed with every `request_snapshot`; re-requests after
   *  [`RESYNC_RETRY_MS`] if the hole still stands, so recovery never waits on
   *  further inbound traffic. */
  private resyncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sequenced messages past a gap, held until the repairing snapshot
   *  arrives, then drained in seq order. Entries the snapshot covers are
   *  dropped. */
  private pendingSequenced: PendingSequenced[] = [];
  /** Dataset ids in the shared document, per the last snapshot and every
   *  membership command since. A stale `dataset_opened` passes only for a
   *  still-present dataset; one the snapshot dropped must not come back, since
   *  its `remove_dataset` may be what the snapshot repaired. */
  private documentDatasetIds: Set<string> | null = null;
  /** Locally-applied document commands awaiting their ack (see
   *  [`PendingLocalCommand`]). Replayed after snapshot adoption so a
   *  mid-session full-replace can't erase the author's own optimistic
   *  applies; retired FIFO on ack; cleared on disconnect. */
  private pendingLocalCommands: PendingLocalCommand[] = [];
  /** Set when the server refuses a command we applied optimistically, and
   *  cleared by the next adopted snapshot, which no longer holds it. Keeps
   *  the retry timer asking until that snapshot lands. */
  private revertOwed = false;

  /** `url` is a workspace socket; see {@link workspaceSocketUrl}. */
  constructor(handlers: BridgeHandlers, url: string) {
    this.url = url;
    this.handlers = handlers;
    this.stopListeningToPage = this.listenToPageLifecycle();
    this.connect();
  }

  /**
   * Leave the session while the page is in the back-forward cache or frozen,
   * and rejoin when it is back. Such a page can't move, report or follow, yet
   * its open socket keeps it in the session, and beside the same page opened
   * again it shows as a second peer.
   */
  private listenToPageLifecycle(): () => void {
    if (typeof window === "undefined" || typeof document === "undefined") return () => {};
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) this.suspend();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) this.resume();
    };
    const onFreeze = () => this.suspend();
    const onResume = () => this.resume();
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("freeze", onFreeze);
    document.addEventListener("resume", onResume);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
    };
  }

  /** Close the socket as a drop would, but schedule no reconnect. */
  private suspend() {
    if (this.destroyed || this.suspended) return;
    this.suspended = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    // No socket means a drop already reported the disconnect.
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    this.connectionLost({ code: 1000, reason: "page suspended" });
  }

  private resume() {
    if (this.destroyed || !this.suspended) return;
    this.suspended = false;
    this.connect();
  }

  private connect() {
    if (this.destroyed || this.suspended) return;

    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      // A CONNECTING socket can complete after destroy(); a dead bridge
      // must not announce connectivity.
      if (this.destroyed) return;
      bridgeLog("ws.connected", { url: this.url }, ws.readyState);
      // The socket is OPEN, so `send` stops dropping. Readiness-gated work
      // (e.g. the seed open) can now fire against a transport that carries it.
      this.connectionGeneration += 1;
      this.handlers.onConnected?.(this.connectionGeneration);
    };

    ws.onmessage = (event) => {
      // A message task can already be queued when destroy() runs; nothing
      // received afterwards may reach the handler chain (e.g. a late
      // `workspace_archived` would navigate state outside this bridge's
      // owner).
      if (this.destroyed) return;
      // Counted at the bytes the socket carried, mirroring `send`, so the
      // received rate is comparable with a network monitor.
      if (event.data instanceof ArrayBuffer) {
        traceRecorder.countReceive(event.data.byteLength);
        this.handleBinary(event.data);
        return;
      }

      if (typeof event.data !== "string") return;
      traceRecorder.countReceive(utf8ByteLength(event.data));
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "snapshot": {
            // A requested snapshot rides the unicast queue while broadcasts
            // keep flowing, so it can arrive after out-of-order broadcasts
            // already moved tracking past its seq. Adopting it would rewind
            // the document, so skip it, but still settle the resync and drain
            // so a real residual gap can ask again.
            const snapshotSeq = typeof msg.seq === "number" ? msg.seq : 0;
            if (this.lastAppliedSeq !== null && snapshotSeq < this.lastAppliedSeq) {
              bridgeLog("snapshot.stale_skipped", {
                snapshotSeq,
                lastAppliedSeq: this.lastAppliedSeq,
              });
              this.resyncInFlight = false;
              // The resync this snapshot answered is settled either way:
              // a leftover grace/retry window must not carry into whatever
              // hole appears next (drain re-arms with full windows).
              this.clearGraceTimer();
              this.clearRetryTimer();
              // Too old to adopt, so it cannot undo a refused command
              // either; ask again once the server's throttle has passed.
              if (this.revertOwed) this.armRetryTimer();
              this.drainPendingSequenced();
              break;
            }
            // A snapshot (join, reconnect, or resync) is authoritative
            // through its seq: adopt it as the tracking baseline and settle
            // any outstanding resync before handing it to the app.
            this.lastAppliedSeq = snapshotSeq;
            this.resyncInFlight = false;
            this.revertOwed = false;
            // A hole this snapshot repaired must not leave its timers
            // running: a new hole inside a leftover grace window would get
            // short grace and fire a premature request into the server's
            // throttle. Drain re-arms as needed.
            this.clearGraceTimer();
            this.clearRetryTimer();
            // Membership mirror for the stale-`dataset_opened` gate: seed
            // from the snapshot document, then keep it live via delivered
            // membership commands.
            this.documentDatasetIds = new Set(
              Object.keys(
                (msg.document as { manifests?: Record<string, unknown> } | null)?.manifests ?? {},
              ),
            );
            // Copy the replay list before the handler runs: commands sent
            // during onSnapshot (e.g. layout registration) postdate the
            // full-replace and need no replay. Expired entries are pruned
            // first so a stale command can't replay onto a later snapshot.
            {
              this.prunePendingLocalCommands();
              const replay = [...this.pendingLocalCommands];
              this.handlers.onSnapshot(
                msg.seq,
                JSON.stringify(msg.document),
                ((msg.peers ?? []) as PresenceStateWire[]).map(readPresence),
                msg.your_id ?? 0,
                msg.generated_availability ?? {},
              );
              // Replay our own unacked commands: the server usually built
              // this snapshot before applying them, so the full-replace just
              // erased their local effect. See [`PendingLocalCommand`] for
              // the race where the snapshot already covered one.
              for (const entry of replay) {
                bridgeLog("snapshot.replayed_pending_command", {
                  commandType: entry.commandType ?? null,
                });
                this.handlers.onCommand(snapshotSeq, entry.commandJson);
                this.noteDeliveredMembership(entry.commandType, entry.datasetId);
              }
            }
            // Messages buffered past the gap this snapshot repaired:
            // entries with seq <= the snapshot's are already reflected in
            // it and are dropped; newer ones apply in order.
            this.drainPendingSequenced();
            break;
          }
          case "command_broadcast": {
            const command = msg.command as
              | { type?: string; id?: unknown; manifest?: { dataset_id?: unknown } }
              | null;
            this.handleSequenced(
              msg.seq,
              JSON.stringify(msg.command),
              command?.type,
              membershipDatasetId(command),
            );
            break;
          }
          case "ack":
            // The server sequenced our own command, already applied
            // optimistically, so the ack advances seq tracking with nothing
            // to apply. It also retires the oldest pending local command;
            // expired entries go first so an ack-less one can't misalign
            // FIFO retirement.
            this.prunePendingLocalCommands();
            this.pendingLocalCommands.shift();
            this.handleSequenced(msg.seq, null);
            this.handlers.onAck(msg.seq);
            break;
          case "command_rejected":
            // The server answers one client's commands in send order, with
            // an ack or a rejection each, so this one is the oldest pending
            // command. Its optimistic apply stays until a snapshot replaces
            // the document; the pending commands after it replay on top.
            this.prunePendingLocalCommands();
            this.pendingLocalCommands.shift();
            this.revertOwed = true;
            bridgeLog("command.rejected", { reason: msg.reason ?? null }, ws.readyState);
            this.requestResync(null);
            this.handlers.onCommandRejected?.(msg.reason);
            break;
          case "peer_joined":
            this.handlers.onPeerJoined?.(msg.client_id, readPresence(msg.presence));
            break;
          case "peer_left":
            this.handlers.onPeerLeft?.(msg.client_id);
            break;
          case "presence_update":
            this.handlers.onPresenceUpdate?.(msg.client_id, msg.camera, msg.view, msg.display);
            break;
          case "cursor_update":
            this.handlers.onCursorUpdate?.(msg.client_id, msg.position);
            break;
          case "follow_changed":
            this.handlers.onFollowChanged?.(msg.client_id, msg.target);
            break;
          case "dataset_presence_update":
            this.handlers.onDatasetPresenceUpdate?.(msg.client_id, msg.dataset_order, msg.dataset_settings);
            break;
          case "dataset_open_progress":
            this.handleDatasetOpenProgress(msg);
            break;
          case "open_dataset_failed":
            this.handlers.onOpenDatasetFailed?.(msg.request_id, msg.url, msg.error);
            break;
          case "dataset_health":
            this.handleDatasetHealth(msg);
            break;
          case "report_sent":
          case "report_failed":
            this.handleReportReceipt(msg);
            break;

          case "generated_availability_update":
            this.handlers.onGeneratedAvailabilityUpdate?.(
              msg.dataset_id,
              JSON.stringify(msg.delta ?? { levels: [], chunks: [] }),
            );
            break;
          case "generated_chunk_status":
            this.handlers.onGeneratedChunkStatus?.(
              msg.dataset_id,
              msg.image_id,
              msg.key,
              msg.status,
              msg.message ?? null,
            );
            break;
          case "source_chunk_status":
            this.handlers.onSourceChunkStatus?.(
              msg.dataset_id,
              msg.image_id,
              msg.key,
              msg.status,
              msg.message ?? null,
              msg.kind ?? null,
            );
            break;
          case "message_rejected":
            this.handleMessageRejected(msg as MessageRejectedWire);
            break;
          case "workspace_archived":
            this.handlers.onWorkspaceArchived?.(msg.workspace_id ?? "");
            this.destroy();
            break;
          case "timing_batch":
            // Stamped with the generation it arrived on, not the one it was
            // requested under: rows buffered for a dead connection are
            // discarded server-side, so anything arriving here belongs to
            // the socket it came in on.
            this.handlers.onTimingBatch?.(
              msg.batch as ServerTimingBatch,
              this.connectionGeneration,
            );
            break;
        }
      } catch (e) {
        bridgeLog("ws.bad_message", {
          error: e instanceof Error ? e.message : String(e),
        }, ws.readyState);
      }
    };

    ws.onclose = (event: CloseEvent) => {
      // The close event fires asynchronously after destroy()'s close();
      // a dead bridge must not report a disconnect (or reconnect).
      if (this.destroyed) return;
      if (event.code === CLOSE_ACCESS_REVOKED) {
        bridgeLog("ws.access_revoked", { reason: event.reason }, ws.readyState);
        this.handlers.onAccessRevoked?.();
        this.destroy();
        return;
      }
      this.connectionLost({ code: event.code, reason: event.reason });
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.destroyed) return;
      ws.close();
    };

    this.ws = ws;
  }

  private connectionLost(close: SocketClose) {
    this.ws = null;
    // Seq tracking is per-connection; the reconnect's snapshot re-seeds
    // it. Pending local commands drop too: one may never have reached the
    // server, and the reconnect snapshot is the truth.
    this.lastAppliedSeq = null;
    this.resyncInFlight = false;
    this.pendingSequenced = [];
    this.pendingLocalCommands = [];
    this.revertOwed = false;
    this.documentDatasetIds = null;
    this.clearGraceTimer();
    this.clearRetryTimer();
    this.handlers.onDisconnect?.(close);
  }

  private handleBinary(buffer: ArrayBuffer) {
    if (buffer.byteLength < 6) return;
    const view = new DataView(buffer);
    // Skip client_id (4 bytes); this client is the target.
    const keyField = view.getUint16(4, true);
    const keyLen = keyField & ~ENCODED_FRAME_FLAG;
    let at = 6 + keyLen;
    if (buffer.byteLength < at) return;
    const keyBytes = new Uint8Array(buffer, 6, keyLen);
    const key = new TextDecoder().decode(keyBytes);
    let codecs: Uint8Array | null = null;
    if (keyField & ENCODED_FRAME_FLAG) {
      if (buffer.byteLength < at + 1) return;
      const codecsLen = view.getUint8(at);
      at += 1;
      if (buffer.byteLength < at + codecsLen) return;
      codecs = new Uint8Array(buffer.slice(at, at + codecsLen));
      at += codecsLen;
    }
    const payload = buffer.slice(at);
    this.handlers.onBinary?.(key, payload, codecs);
  }

  /**
   * The server did not act on a message this page sent. The page sends only
   * messages the server reads, so this is drift between the two and is
   * logged whatever the debug setting. A request still waiting on its answer
   * fails now with the server's reason instead of at its timeout.
   */
  private handleMessageRejected(msg: MessageRejectedWire) {
    console.warn(
      `[bridge] the server did not act on a ${msg.message_type ?? "message"} (${msg.reason}): ${msg.message}`,
    );
    const requestId = msg.request_id;
    if (!requestId) return;
    const error = new Error(`the server refused the request (${msg.reason}): ${msg.message}`);
    const health = this.pendingDatasetHealth.get(requestId);
    if (health) {
      this.pendingDatasetHealth.delete(requestId);
      clearTimeout(health.timer);
      health.reject(error);
    }
    const report = this.pendingSendReports.get(requestId);
    if (report) {
      this.pendingSendReports.delete(requestId);
      clearTimeout(report.timer);
      report.reject(error);
    }
  }

  private handleDatasetHealth(msg: unknown) {
    const obj = msg as { request_id?: unknown; datasets?: unknown; source_throttle?: unknown };
    const requestId = typeof obj.request_id === "string" ? obj.request_id : "";
    if (!requestId) return;

    const pending = this.pendingDatasetHealth.get(requestId);
    if (!pending) return;
    this.pendingDatasetHealth.delete(requestId);
    clearTimeout(pending.timer);

    const datasets = Array.isArray(obj.datasets)
      ? (obj.datasets as DatasetSourceHealth[])
      : [];
    const sourceThrottle =
      typeof obj.source_throttle === "object" && obj.source_throttle !== null
        ? (obj.source_throttle as SourceThrottleReport)
        : null;
    bridgeLog("dataset_health.received", {
      requestId,
      datasetCount: datasets.length,
    }, this.ws?.readyState);
    pending.resolve({ datasets, sourceThrottle });
  }

  /**
   * Settle the **Send report** the server is answering. `report_sent`
   * carries the inbox entry; `report_failed` carries why nothing was kept.
   */
  private handleReportReceipt(msg: unknown) {
    const obj = msg as {
      type?: unknown;
      request_id?: unknown;
      entry_id?: unknown;
      expires_at?: unknown;
      error?: unknown;
    };
    const requestId = typeof obj.request_id === "string" ? obj.request_id : "";
    if (!requestId) return;

    const pending = this.pendingSendReports.get(requestId);
    if (!pending) return;
    this.pendingSendReports.delete(requestId);
    clearTimeout(pending.timer);

    if (obj.type === "report_sent" && typeof obj.entry_id === "string") {
      const receipt: InboxReceipt = {
        entryId: obj.entry_id,
        expiresAt: typeof obj.expires_at === "string" ? obj.expires_at : "",
      };
      bridgeLog("send_report.sent", { requestId, entryId: receipt.entryId }, this.ws?.readyState);
      pending.resolve(receipt);
      return;
    }
    const error = typeof obj.error === "string" ? obj.error : "the server did not keep the report";
    bridgeLog("send_report.failed", { requestId, error }, this.ws?.readyState);
    pending.reject(new Error(error));
  }

  private handleDatasetOpenProgress(msg: unknown) {
    const obj = msg as {
      request_id?: unknown;
      url?: unknown;
      diagnostic?: unknown;
    };
    const requestId = typeof obj.request_id === "string" ? obj.request_id : "";
    const url = typeof obj.url === "string" ? obj.url : "";
    const raw = obj.diagnostic as
      | (DatasetOpenProgressDiagnostic & { warning?: unknown })
      | undefined;
    if (!requestId || !raw || typeof raw.message !== "string") return;
    // `warning` is absent on the wire when false; coerce it to a clean
    // boolean here so downstream never has to distinguish missing from false.
    const diagnostic: DatasetOpenProgressDiagnostic = {
      ...raw,
      warning: raw.warning === true,
    };
    bridgeLog("open_remote_dataset.progress", {
      requestId,
      url,
      stage: diagnostic.stage,
      message: diagnostic.message,
      warning: diagnostic.warning,
      datasetId: diagnostic.workspace_dataset_id ?? null,
    }, this.ws?.readyState);
    this.handlers.onDatasetOpenProgress?.(requestId, url, diagnostic);
  }

  private scheduleReconnect() {
    if (this.destroyed) return;
    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  /**
   * Seq discipline. `command_broadcast` and `ack` share one seq space; the
   * server acks the sender instead of broadcasting to it.
   *
   * - `seq == last + 1`: deliver and advance.
   * - `seq <= last`: stale or duplicate, dropped, except a `dataset_opened`
   *   for a dataset the document still contains. The server rebroadcasts an
   *   applied open at the current seq when it dedups onto an existing
   *   binding, carrying the re-stamped opener; the apply is an idempotent
   *   full-replace.
   * - `seq > last + 1`: a hole, which is not proof of loss (see
   *   [`RESYNC_GRACE_MS`]). The message is buffered; only a hole that
   *   outlives the grace sends `request_snapshot`, at most one in flight.
   */
  private handleSequenced(
    seq: unknown,
    commandJson: string | null,
    commandType?: string,
    datasetId?: string,
  ) {
    if (typeof seq !== "number") {
      // Unsequenced frame: deliver rather than silently eat it; tracking is
      // untouched.
      if (commandJson !== null) this.handlers.onCommand(seq as number, commandJson);
      return;
    }
    if (this.lastAppliedSeq === null) {
      // No snapshot yet on this connection. The server always sends the
      // snapshot as the first message, so this is unreachable in practice;
      // deliver and adopt the seq as the baseline.
      if (commandJson !== null) this.handlers.onCommand(seq, commandJson);
      this.lastAppliedSeq = seq;
      return;
    }
    if (seq <= this.lastAppliedSeq) {
      this.deliverStale(seq, commandJson, commandType, datasetId);
      return;
    }
    if (seq === this.lastAppliedSeq + 1) {
      this.lastAppliedSeq = seq;
      if (commandJson !== null) {
        this.handlers.onCommand(seq, commandJson);
        this.noteDeliveredMembership(commandType, datasetId);
      }
      // A buffered successor may now be contiguous (out-of-order arrival
      // around a gap); apply what we can without waiting for the snapshot.
      this.drainPendingSequenced();
      return;
    }
    this.bufferSequenced({ seq, commandJson, commandType, datasetId });
    this.scheduleResync();
  }

  /** The stale-seq (`seq <= last`) arm, shared by the live path and the
   *  buffer drain: everything is dropped except a `dataset_opened` whose
   *  dataset the document still contains (the open-dedup rebroadcast). */
  private deliverStale(
    seq: number,
    commandJson: string | null,
    commandType?: string,
    datasetId?: string,
  ) {
    if (commandJson === null) return;
    if (commandType === "dataset_opened") {
      if (datasetId !== undefined && this.documentDatasetIds?.has(datasetId)) {
        this.handlers.onCommand(seq, commandJson);
      } else {
        // A retained rebroadcast for a dataset the document no longer
        // contains (or whose membership we cannot confirm): delivering it
        // would resurrect a deleted dataset with dead bindings.
        bridgeLog("seq.stale_dataset_opened_dropped", {
          seq,
          datasetId: datasetId ?? null,
          lastAppliedSeq: this.lastAppliedSeq,
        });
      }
      return;
    }
    bridgeLog("seq.stale_dropped", { seq, lastAppliedSeq: this.lastAppliedSeq });
  }

  /** Keep the datasets-present mirror aligned with what was delivered. */
  private noteDeliveredMembership(commandType?: string, datasetId?: string) {
    if (!this.documentDatasetIds || datasetId === undefined) return;
    if (commandType === "dataset_opened") {
      this.documentDatasetIds.add(datasetId);
    } else if (commandType === "remove_dataset") {
      this.documentDatasetIds.delete(datasetId);
    }
  }

  private bufferSequenced(entry: PendingSequenced) {
    this.pendingSequenced.push(entry);
    if (this.pendingSequenced.length > MAX_PENDING_SEQUENCED) {
      // Shed the lowest seqs; the snapshot in flight covers those first.
      this.pendingSequenced.sort((a, b) => a.seq - b.seq);
      this.pendingSequenced.splice(0, this.pendingSequenced.length - MAX_PENDING_SEQUENCED);
    }
  }

  /** Apply what the current baseline makes applicable: entries at or below
   *  `lastAppliedSeq` go through the stale rule, contiguous entries apply in
   *  order, and a residual gap re-schedules a snapshot request. */
  private drainPendingSequenced() {
    if (this.pendingSequenced.length === 0) return;
    this.pendingSequenced.sort((a, b) => a.seq - b.seq);
    while (this.pendingSequenced.length > 0) {
      const last = this.lastAppliedSeq;
      const next = this.pendingSequenced[0];
      if (last === null || next.seq <= last) {
        this.pendingSequenced.shift();
        this.deliverStale(next.seq, next.commandJson, next.commandType, next.datasetId);
        continue;
      }
      if (next.seq === last + 1) {
        this.pendingSequenced.shift();
        this.lastAppliedSeq = next.seq;
        if (next.commandJson !== null) {
          this.handlers.onCommand(next.seq, next.commandJson);
          this.noteDeliveredMembership(next.commandType, next.datasetId);
        }
        continue;
      }
      // Still a hole below the buffered tail; schedule another request.
      this.scheduleResync();
      break;
    }
    if (this.pendingSequenced.length === 0) {
      // Hole fully resolved: nothing left to wait for or retry.
      this.clearGraceTimer();
      this.clearRetryTimer();
    }
  }

  /** Arm the grace timer for a detected hole. It requests a snapshot only if
   *  the hole still stands, so benign reordering never costs a full-document
   *  round-trip. */
  private scheduleResync() {
    if (this.resyncGraceTimer !== null) return;
    if (this.resyncInFlight && Date.now() - this.lastResyncRequestAt < RESYNC_RETRY_MS) {
      // A request is already outstanding; its retry timer (armed at send)
      // re-requests if the hole outlives it, independent of traffic.
      return;
    }
    this.resyncGraceTimer = setTimeout(() => {
      this.resyncGraceTimer = null;
      if (this.destroyed) return;
      if (this.pendingSequenced.length === 0) {
        // The hole filled itself (out-of-order delivery, or a snapshot
        // landed); nothing was lost.
        return;
      }
      this.requestResync(this.pendingSequenced[0].seq);
    }, RESYNC_GRACE_MS);
  }

  /** Ask the server for a fresh snapshot, at most one outstanding request at
   *  a time, to repair a seq hole (`gapSeq`) or undo a refused command
   *  (`null`). Every request arms the retry timer, so a hole or a refused
   *  command that outlives [`RESYNC_RETRY_MS`] is re-requested even in an
   *  idle workspace or after the server's throttle ate this request. */
  private requestResync(gapSeq: number | null) {
    const now = Date.now();
    if (this.resyncInFlight && now - this.lastResyncRequestAt < RESYNC_RETRY_MS) {
      return;
    }
    this.resyncInFlight = true;
    this.lastResyncRequestAt = now;
    bridgeLog(
      "seq.gap_requesting_snapshot",
      { lastAppliedSeq: this.lastAppliedSeq, gapSeq },
      this.ws?.readyState,
    );
    this.send(JSON.stringify({ type: "request_snapshot" }));
    this.armRetryTimer();
  }

  /** (Re)arm the traffic-independent retry. A standing hole or an owed
   *  revert keeps retrying once per interval until a snapshot resolves it. */
  private armRetryTimer() {
    this.clearRetryTimer();
    this.resyncRetryTimer = setTimeout(() => {
      this.resyncRetryTimer = null;
      if (this.destroyed) return;
      if (this.pendingSequenced.length === 0 && !this.revertOwed) return;
      this.requestResync(this.pendingSequenced[0]?.seq ?? null);
    }, RESYNC_RETRY_MS);
  }

  private clearGraceTimer() {
    if (this.resyncGraceTimer !== null) {
      clearTimeout(this.resyncGraceTimer);
      this.resyncGraceTimer = null;
    }
  }

  private clearRetryTimer() {
    if (this.resyncRetryTimer !== null) {
      clearTimeout(this.resyncRetryTimer);
      this.resyncRetryTimer = null;
    }
  }

  /** Drop pending local commands older than the TTL. Acks carry no command
   *  id, so an entry whose ack never comes would misalign FIFO retirement
   *  forever; age is the staleness signal. Runs before every retirement,
   *  replay, and send. */
  private prunePendingLocalCommands() {
    if (this.pendingLocalCommands.length === 0) return;
    const cutoff = Date.now() - PENDING_LOCAL_COMMAND_TTL_MS;
    const fresh = this.pendingLocalCommands.filter((entry) => entry.sentAt >= cutoff);
    if (fresh.length !== this.pendingLocalCommands.length) {
      bridgeLog("pending_command.expired", {
        dropped: this.pendingLocalCommands.length - fresh.length,
      });
      this.pendingLocalCommands = fresh;
    }
  }

  /** Send a document command wrapped in the ClientMessage envelope.
   *
   *  Every `sendCommand` is paired with an optimistic local apply, so a
   *  command handed to an open socket is tracked as pending until its ack
   *  (see [`PendingLocalCommand`]). A frame the socket drops is not tracked:
   *  it never reaches the server, and the next snapshot rightly reverts it. */
  sendCommand(json: string) {
    const cmd = JSON.parse(json) as {
      type?: string;
      id?: unknown;
      manifest?: { dataset_id?: unknown };
    };
    const willTransmit =
      !this.destroyed && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    if (willTransmit) {
      this.prunePendingLocalCommands();
      this.pendingLocalCommands.push({
        commandJson: JSON.stringify(cmd),
        commandType: cmd?.type,
        datasetId: membershipDatasetId(cmd),
        sentAt: Date.now(),
      });
      if (this.pendingLocalCommands.length > MAX_PENDING_LOCAL_COMMANDS) {
        // Shed the oldest. Most lost their answer, but a shed entry may
        // be a sent command whose ack will come and retire a newer entry.
        // The TTL prune bounds that misalignment.
        this.pendingLocalCommands.splice(
          0,
          this.pendingLocalCommands.length - MAX_PENDING_LOCAL_COMMANDS,
        );
      }
    }
    this.send(JSON.stringify({ type: "command", command: cmd }));
  }

  /** Send presence update, throttled to [`PRESENCE_THROTTLE_MS`]
   *  (leading+trailing edge). */
  sendPresence(presenceJson: string) {
    const obj = JSON.parse(presenceJson);
    const json = JSON.stringify({ type: "presence", ...obj });
    if (!this.presenceTimer) {
      // Leading edge: send immediately, start cooldown
      this.send(json);
      this.pendingPresence = null;
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = null;
        if (this.pendingPresence) {
          this.send(this.pendingPresence);
          this.pendingPresence = null;
        }
      }, PRESENCE_THROTTLE_MS);
    } else {
      // During cooldown: store latest for trailing edge
      this.pendingPresence = json;
    }
  }

  /** Send dataset presence update, throttled to
   *  [`DATASET_PRESENCE_THROTTLE_MS`]. */
  sendDatasetPresence(json: string) {
    const obj = JSON.parse(json);
    this.pendingDatasetPresence = JSON.stringify({ type: "dataset_presence", ...obj });
    if (!this.datasetPresenceTimer) {
      this.datasetPresenceTimer = setTimeout(() => {
        this.datasetPresenceTimer = null;
        if (this.pendingDatasetPresence) {
          this.send(this.pendingDatasetPresence);
          this.pendingDatasetPresence = null;
        }
      }, DATASET_PRESENCE_THROTTLE_MS);
    }
  }

  /** Send an open-remote-dataset request and return its `request_id`. The
   *  server echoes it on every `dataset_open_progress` frame for this open,
   *  so callers can attribute progress to their own open. A dropped send
   *  still returns an id, which simply never matches. */
  sendOpenRemoteDataset(url: string): string {
    const requestId = makeOpenDatasetRequestId();
    bridgeLog("open_remote_dataset.send", { url, requestId }, this.ws?.readyState);
    this.send(JSON.stringify({
      type: "open_remote_dataset",
      request_id: requestId,
      url,
    }));
    return requestId;
  }

  sendViewerInterest(interest: unknown) {
    this.send(JSON.stringify({ type: "viewer_interest", interest }));
  }

  requestDatasetHealth(datasetId?: string | null, timeoutMs = 5000): Promise<DatasetSourceHealth[]> {
    return this.requestDatasetHealthReply(datasetId, timeoutMs).then((reply) => reply.datasets);
  }

  /** {@link requestDatasetHealth} with the server's source throttle beside the datasets. */
  requestDatasetHealthReply(datasetId?: string | null, timeoutMs = 5000): Promise<DatasetHealthReply> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket is not connected"));
    }
    const requestId = makeBridgeRequestId("web-health");
    const payload: Record<string, unknown> = {
      type: "dataset_health",
      request_id: requestId,
    };
    if (datasetId) payload.dataset_id = datasetId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDatasetHealth.delete(requestId);
        reject(new Error("Timed out waiting for dataset health"));
      }, timeoutMs);
      this.pendingDatasetHealth.set(requestId, { resolve, reject, timer });
      bridgeLog("dataset_health.send", {
        requestId,
        datasetId: datasetId ?? null,
      }, this.ws?.readyState);
      this.send(JSON.stringify(payload));
    });
  }

  /**
   * **Send report**: post a bundle to the workspace inbox and resolve with
   * the entry the server kept. Rejects with the server's reason, or when the
   * socket isn't open, because a report that silently went nowhere is the one
   * outcome this action must not have. Nothing calls this on a run's close.
   *
   * `bundleJson` travels as text; the server stores those bytes and the CLI
   * fetches them back, so nothing re-encodes it.
   */
  sendReport(bundleJson: string, timeoutMs = SEND_REPORT_TIMEOUT_MS): Promise<InboxReceipt> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket is not connected"));
    }
    const requestId = makeBridgeRequestId("web-report");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSendReports.delete(requestId);
        reject(new Error("Timed out waiting for the inbox to confirm the report"));
      }, timeoutMs);
      this.pendingSendReports.set(requestId, { resolve, reject, timer });
      bridgeLog("send_report.send", { requestId, bytes: bundleJson.length }, this.ws?.readyState);
      this.send(
        JSON.stringify({ type: "send_report", request_id: requestId, bundle: bundleJson }),
      );
    });
  }

  sendDatasetRetry(datasetId: string) {
    const requestId = makeBridgeRequestId("web-retry");
    bridgeLog("dataset_retry.send", {
      requestId,
      datasetId,
    }, this.ws?.readyState);
    this.send(JSON.stringify({
      type: "dataset_retry",
      request_id: requestId,
      dataset_id: datasetId,
    }));
  }

  sendFollow(target: ClientId | null) {
    this.send(JSON.stringify({ type: "follow", target }));
  }

  /** Send a cursor position update, throttled to [`PRESENCE_THROTTLE_MS`].
   *  Null sends immediately. */
  sendCursor(position: [number, number] | null) {
    if (position === null) {
      if (this.cursorTimer !== null) {
        clearTimeout(this.cursorTimer);
        this.cursorTimer = null;
      }
      this.pendingCursor = null;
      this.send(JSON.stringify({ type: "cursor", position: null }));
      return;
    }
    this.pendingCursor = JSON.stringify({ type: "cursor", position });
    if (!this.cursorTimer) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null;
        if (this.pendingCursor) {
          this.send(this.pendingCursor);
          this.pendingCursor = null;
        }
      }, PRESENCE_THROTTLE_MS);
    }
  }

  /** Low-level send. Drops the frame unless the socket is OPEN; a destroyed
   *  bridge never transmits.
   *
   *  Every client message passes here, including the content source's chunk
   *  requests, so each frame that goes out is counted on the trace
   *  once, at the bytes the socket carries. A frame dropped here was never a
   *  send. */
  send(json: string) {
    if (this.destroyed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
      traceRecorder.countSend(classifyClientMessage(json), utf8ByteLength(json));
    }
  }

  /**
   * Permanently shut this bridge down. After this returns, no handler
   * callback fires again (the socket's event handlers are detached and
   * every callback is additionally gated on `destroyed`, covering event
   * tasks already queued), no frame is transmitted, no reconnect is
   * attempted, and every pending request promise is settled. Idempotent.
   */
  destroy() {
    this.destroyed = true;
    this.stopListeningToPage();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.presenceTimer !== null) {
      clearTimeout(this.presenceTimer);
    }
    if (this.datasetPresenceTimer !== null) {
      clearTimeout(this.datasetPresenceTimer);
    }
    if (this.cursorTimer !== null) {
      clearTimeout(this.cursorTimer);
    }
    for (const pending of this.pendingDatasetHealth.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge destroyed"));
    }
    this.pendingDatasetHealth.clear();
    for (const pending of this.pendingSendReports.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bridge destroyed"));
    }
    this.pendingSendReports.clear();
    this.pendingSequenced = [];
    this.pendingLocalCommands = [];
    this.documentDatasetIds = null;
    this.resyncInFlight = false;
    this.clearGraceTimer();
    this.clearRetryTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // Detach before closing: close() only queues the close event, and a
      // received-message task may already be queued ahead of it. Detaching
      // (plus the `destroyed` gates in each handler) guarantees neither
      // dispatches into the handler chain after this point.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
  }
}

function makeOpenDatasetRequestId(): string {
  return makeBridgeRequestId("web");
}

function makeBridgeRequestId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
