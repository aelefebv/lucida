/**
 * WebSocket client for the workspace session: the raw transport (connect /
 * reconnect, throttled presence/cursor/dataset-presence sends, the binary
 * chunk envelope) together with the sequenced-document layer (last-applied-
 * seq tracking, gap grace/retry buffering with snapshot resync, the document
 * membership mirror, pending local-command replay across mid-session
 * snapshots).
 *
 * The sequenced-document layer is a nameable internal seam — `handleSequenced`
 * / `drainPendingSequenced` / `deliverStale`, the `pendingSequenced` /
 * `pendingLocalCommands` / `documentDatasetIds` state, and the resync timers,
 * delivering through `onSnapshot`/`onCommand`/`onAck` — and could compose as
 * a separate documentSync module the Bridge owns. It stays in-file
 * deliberately: its resets are interleaved with the connection lifecycle
 * (`onclose`, `destroy`, per-connection re-seeding) and its send-side hook
 * (`sendCommand`'s pending tracking) with transport readiness, so extracting
 * it would churn the client's most delicate reliability code for zero
 * behavioral gain. Take the split if and when the sequenced layer next
 * changes behavior.
 */
import { isDebugEnabled } from "./debug/logging.ts";
import type { SourceChunkStatus } from "./pipeline/fetch/contentSource.ts";
import type { ServerTimingBatch } from "./trace/serverRowTable.ts";
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
}

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
  /** A non-fatal import concern that must stay visible after the open
   *  completes instead of clearing with the transient progress line. Omitted
   *  on the wire when false; the bridge coerces it to a clean boolean so
   *  every consumer can rely on `diagnostic.warning === true`/`=== false`. */
  warning?: boolean;
}

interface PendingDatasetHealthRequest {
  resolve: (datasets: DatasetSourceHealth[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A sequenced message (`command_broadcast` or `ack`) held back while a
 * snapshot resync is in flight. `commandJson` is `null` for acks — an ack
 * only advances seq tracking (the sender already applied its own command
 * optimistically); there is nothing to re-apply.
 */
interface PendingSequenced {
  seq: number;
  commandJson: string | null;
  commandType?: string;
  /** Document-membership key, when the command changes membership:
   *  `manifest.dataset_id` for `dataset_opened`, `id` for `remove_dataset`. */
  datasetId?: string;
}

/** A document command this client applied locally (optimistic apply) and
 *  transmitted, whose `Ack` has not arrived yet. A mid-session snapshot's
 *  full-replace would silently erase its local effect — usually because
 *  the server built the snapshot before applying this command — so these
 *  are replayed locally after snapshot adoption. That premise is not
 *  airtight: acks ride the broadcast queue while snapshots ride the
 *  unicast queue, so a snapshot whose seq already covers this command can
 *  arrive BEFORE its ack, and the replay then re-applies this value over
 *  any newer peer edit the snapshot carried. Accepted tradeoff: that
 *  divergence is local-only and bounded by the next edit or snapshot,
 *  whereas skipping the replay would erase the author's own edit in the
 *  common case. The ack retires entries FIFO: the server processes one
 *  client's commands in send order and acks each exactly once. */
interface PendingLocalCommand {
  commandJson: string;
  commandType?: string;
  datasetId?: string;
  /** `Date.now()` at transmission. Acks carry only a seq (no command id),
   *  so retirement is FIFO and staleness must be structural — see
   *  [`PENDING_LOCAL_COMMAND_TTL_MS`]. */
  sentAt: number;
}

/** One resync request may be outstanding at a time; if the server hasn't
 *  answered after this long, another goes out — from a new gapped arrival
 *  OR from the standing retry timer armed with every request, so a
 *  residual hole in an idle workspace (zero further inbound traffic)
 *  still recovers, and a request eaten by the server's per-client
 *  throttle (~1s) is re-issued group outside that window. Keeps a gap
 *  storm at worst one request per interval instead of one per message. */
const RESYNC_RETRY_MS = 5000;

/** Maximum age of a pending local command. A healthy ack round-trips in
 *  well under a second; an entry unacked for this long is a server-side
 *  rejection (rejections are log-only — no ack ever comes), was orphaned
 *  by a cap shed, or sits on a dying connection. Expired entries are
 *  pruned at every retirement/replay/send sweep, so one ack-less command
 *  cannot misalign FIFO retirement indefinitely — without expiry, a stale
 *  pending `remove_dataset` replayed by a much-later snapshot would
 *  delete a re-opened dataset and poison the membership mirror. */
const PENDING_LOCAL_COMMAND_TTL_MS = 10_000;

/** How long a seq hole may stand before it is treated as loss. A hole is
 *  NOT proof of loss: the server applies commands under the session lock
 *  but sends the broadcast after releasing it, so concurrent editors
 *  routinely deliver seq out of order with nothing lost. A late arrival
 *  fills the hole within this window (the buffer drains it) and no
 *  snapshot is requested; only a hole that persists is treated as loss. */
const RESYNC_GRACE_MS = 200;

/** Upper bound on messages buffered while a resync is in flight. Overflow
 *  drops the lowest-seq entries — the ones most likely already covered by
 *  the snapshot being produced; a residual gap after the drain simply
 *  triggers another resync. */
const MAX_PENDING_SEQUENCED = 4096;

/** Upper bound on tracked locally-applied-but-unacked commands. A command
 *  the server rejects never acks (a pre-existing divergence class — the
 *  optimistic apply is never rolled back), so the list is capped (oldest
 *  shed) and cleared on disconnect rather than trusted to drain. */
const MAX_PENDING_LOCAL_COMMANDS = 64;

/** Throttle for presence and cursor updates — the high-frequency ephemeral
 *  channel (camera/view/display state and pointer position fire per mouse
 *  move). Presence sends leading+trailing edge; cursor sends trailing. */
const PRESENCE_THROTTLE_MS = 50;

/** Throttle for dataset-presence updates (dataset order + per-dataset
 *  settings) — lower frequency and heavier than camera presence, so it
 *  coalesces over a longer window (trailing edge only). */
const DATASET_PRESENCE_THROTTLE_MS = 200;

/** Delay before attempting to reconnect a closed WebSocket. */
const RECONNECT_DELAY_MS = 2000;

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
 * Gated debug logger for bridge events. Toggle via the DebugPanel "Logging"
 * tab, or from the console via `localStorage.setItem("debug", "bridge")`
 * followed by `refreshDebugCategories()` (the gate is cached at module
 * init; a raw same-tab setItem alone isn't seen until reload). See
 * `wiki/decisions/0012-logging-conventions.md`.
 */
export function bridgeLog(event: string, data: Record<string, unknown> = {}, wsReadyState?: number) {
  if (!isDebugEnabled("bridge")) return;
  const payload = wsReadyState !== undefined ? { wsReadyState, ...data } : data;
  console.log(`[bridge] ${event}`, payload);
}

/**
 * Mirror of `lucida_core::protocol::PeerIdentity`. Server-authored from the
 * connecting principal and surfaced on the peer's live cursor (#540). All
 * fields are best-effort: `display_name` may be empty, `picture_url` may be
 * absent (dev sessions, providers without avatars). The whole object is
 * absent for sessions without auth (the non-workspace `/ws` path), so peer
 * rendering must tolerate a missing `identity`.
 *
 * Privacy: the raw email is deliberately NOT here — collaborator emails are
 * owner-only, so presence (seen by every co-present peer, including non-owner
 * viewers/editors) must not carry it. The server precomputes a single-char
 * `initial` for the avatar chip from display-name-or-email so no address
 * crosses the wire.
 */
export interface PeerIdentity {
  display_name: string;
  picture_url?: string | null;
  /** Single-grapheme fallback glyph for the avatar chip, computed
   *  server-side (display name, else email local-part). Never the raw
   *  email. May be absent/empty for legacy peers. */
  initial?: string;
}

export interface PresenceState {
  client_id: ClientId;
  camera: unknown;
  view: { z_range: { start: number; end: number }; t: number; c: number };
  display: { contrast_min: number; contrast_max: number; gamma: number };
  following: ClientId | null;
  cursor: [number, number] | null;
  dataset_order: string[];
  dataset_settings: Record<string, unknown>;
  /** Presentational identity for this peer's cursor (#540). Optional:
   *  absent for peers from a session without auth. */
  identity?: PeerIdentity | null;
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
   * Binary frame received from the WebSocket. The bridge parses the
   * envelope (client_id + keyLen + key + payload) and forwards
   * (key, payload) here. The chunk-vs-proxy routing decision lives
   * in the application layer (the content source) so the bridge stays
   * a generic binary transport.
   */
  onBinary?: (key: string, payload: ArrayBuffer) => void;
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
  onOpenDatasetFailed?: (url: string, error: string) => void;
  /**
   * The server may emit an empty `delta.added` as a sanity check (no-op).
   */
  onAssetCatalogUpdate?: (datasetId: string, deltaJson: string) => void;
  onGeneratedAvailabilityUpdate?: (datasetId: string, deltaJson: string) => void;
  onGeneratedChunkStatus?: (
    datasetId: string,
    imageId: string,
    key: string,
    status: GeneratedChunkStatus,
    message?: string | null,
  ) => void;
  /**
   * The server could not serve a source chunk because its store read
   * failed with a non-not-found error (revoked access, backend fault,
   * unreachable store). Routed into the fetch pipeline so the pending
   * request fails permanently instead of timing out as a transient.
   */
  onSourceChunkStatus?: (
    datasetId: string,
    imageId: string,
    key: string,
    status: SourceChunkStatus,
    message?: string | null,
  ) => void;
  /**
   * Cross-peer bookmark-sidebar updates. Fired when the server
   * broadcasts a `bookmark_changed` message because some client
   * mutated a bookmark whose dataset URLs overlap a loaded dataset
   * in this session. `useBookmarks` uses this to refetch
   * (Created/Updated) or remove from local state (Deleted) without
   * waiting for a manual refresh.
   */
  onBookmarkChanged?: (
    id: string,
    action: BookmarkAction,
    datasetUrls: string[],
  ) => void;
  onWorkspaceArchived?: (workspaceId: string) => void;
  /**
   * The underlying WebSocket transitioned to OPEN — the transport can now
   * carry frames (before this, [`Bridge.send`] silently drops). Distinct
   * from `onSnapshot` (the application-level "session established" signal):
   * a frame sent between `onConnected` and the first snapshot still reaches
   * the server. Fires on every (re)connect's `onopen`.
   *
   * `generation` counts this bridge's connections from 1. Correlation
   * labels restart at zero on each one, so only `(generation, rid)` is
   * unique across a run that outlived a socket.
   */
  onConnected?: (generation: number) => void;
  /**
   * One flush window of the server's lifecycle rows for this client's own
   * requests. Pushed on the server's ticker; nothing here is polled and
   * there is no server-side trace store to poll.
   */
  onTimingBatch?: (batch: ServerTimingBatch, generation: number) => void;
  onDisconnect?: () => void;
}

/** Mirror of `lucida_core::protocol::BookmarkAction` (lowercase wire form). */
export type BookmarkAction = "created" | "updated" | "deleted";

/** Listener for cross-peer `bookmark_changed` broadcasts. Subscribed to
 *  via [`Bridge.subscribeBookmarkChanged`] — the WS handler invokes
 *  every registered listener in registration order. Fan-out lives on
 *  the bridge so feature code (e.g. `useBookmarks`) doesn't have to
 *  thread a pub-sub through React props. */
export type BookmarkChangedListener = (
  id: string,
  action: BookmarkAction,
  datasetUrls: string[],
) => void;

export class Bridge {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: BridgeHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /** Sockets this bridge has opened. The other half of the trace's join key. */
  private connectionGeneration = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPresence: string | null = null;
  private datasetPresenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDatasetPresence: string | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: string | null = null;
  private pendingDatasetHealth = new Map<string, PendingDatasetHealthRequest>();
  /** Bookmark-sidebar cross-peer subscribers. Owned on the bridge so
   *  feature code subscribes via a stable handle instead of wiring
   *  callbacks through React props. */
  private bookmarkChangedListeners: BookmarkChangedListener[] = [];
  /** Highest contiguously-applied document `seq` on this connection —
   *  advanced by snapshots, in-order `command_broadcast`s, and `ack`s of
   *  our own commands (which the server sequences but never rebroadcasts
   *  to us). `null` until the connection's first snapshot. */
  private lastAppliedSeq: number | null = null;
  /** True while a `request_snapshot` is outstanding; cleared by the next
   *  snapshot (or a disconnect — a reconnect's snapshot re-seeds). */
  private resyncInFlight = false;
  private lastResyncRequestAt = 0;
  /** Armed when a seq hole appears; fires after [`RESYNC_GRACE_MS`] and
   *  requests a snapshot only if the hole still stands (a late arrival
   *  filling it empties the buffer and the callback no-ops). */
  private resyncGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Armed with every transmitted `request_snapshot`; fires after
   *  [`RESYNC_RETRY_MS`] and re-requests if the hole still stands — so
   *  recovery never depends on further inbound traffic (an idle workspace
   *  with a residual hole, or a request eaten by the server's per-client
   *  throttle, still converges). Cleared on hole resolution, snapshot
   *  adoption, disconnect, and destroy. */
  private resyncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sequenced messages seen past a gap, held until the repairing snapshot
   *  arrives (then drained in seq order; entries the snapshot already
   *  covers are dropped — no double-apply). */
  private pendingSequenced: PendingSequenced[] = [];
  /** Dataset ids present in the shared document, per the last adopted
   *  snapshot and every membership command delivered since. Gates the
   *  stale-`dataset_opened` delivery exception: a dedup rebroadcast for a
   *  still-present dataset passes through, but a retained rebroadcast for
   *  a dataset the snapshot no longer contains must NOT resurrect it (its
   *  `remove_dataset` may be exactly what the snapshot repaired). */
  private documentDatasetIds: Set<string> | null = null;
  /** Locally-applied document commands awaiting their ack (see
   *  [`PendingLocalCommand`]). Replayed after snapshot adoption so a
   *  mid-session full-replace can't erase the author's own optimistic
   *  applies; retired FIFO on ack; cleared on disconnect. */
  private pendingLocalCommands: PendingLocalCommand[] = [];

  constructor(handlers: BridgeHandlers, urlOverride?: string, workspaceId?: string) {
    // Same-origin WebSocket so the lucida_session cookie is sent on
    // the upgrade handshake (browsers refuse cross-origin cookies on
    // WS upgrades with SameSite=Lax). Vite dev server proxies `/ws`
    // to the backend; production serves both from one origin.
    if (urlOverride) {
      this.url = urlOverride;
    } else {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const path = workspaceId
        ? `/ws/workspaces/${encodeURIComponent(workspaceId)}`
        : "/ws";
      this.url = `${proto}//${window.location.host}${path}`;
    }
    this.handlers = handlers;
    this.connect();
  }

  private connect() {
    if (this.destroyed) return;

    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      // A CONNECTING socket can complete after destroy(); a dead bridge
      // must not announce connectivity.
      if (this.destroyed) return;
      bridgeLog("ws.connected", { url: this.url }, ws.readyState);
      // The socket is OPEN: `send` will no longer silently drop. Notify the
      // app so readiness-gated work (e.g. the #697 seed open) can fire against
      // a transport that actually carries it, instead of a CONNECTING socket.
      this.connectionGeneration += 1;
      this.handlers.onConnected?.(this.connectionGeneration);
    };

    ws.onmessage = (event) => {
      // A message task can already be queued when destroy() runs; nothing
      // received afterwards may reach the handler chain (e.g. a late
      // `workspace_archived` would navigate state outside this bridge's
      // owner).
      if (this.destroyed) return;
      // Binary message: chunk data relay
      if (event.data instanceof ArrayBuffer) {
        this.handleBinary(event.data);
        return;
      }

      if (typeof event.data !== "string") return;
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "snapshot": {
            // A requested snapshot travels on the per-client unicast queue
            // while broadcasts keep flowing on the broadcast queue, so it
            // can arrive AFTER late out-of-order broadcasts already caught
            // tracking up past its seq (that ordering race is one way a
            // "gap" appears with no actual loss). Adopting it then would
            // rewind the document; skip it — our applied state is strictly
            // newer — but still settle the resync and drain, so a real
            // residual gap can ask again.
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
              this.drainPendingSequenced();
              break;
            }
            // A snapshot (join, reconnect, or resync) is authoritative
            // through its seq: adopt it as the tracking baseline and settle
            // any outstanding resync before handing it to the app.
            this.lastAppliedSeq = snapshotSeq;
            this.resyncInFlight = false;
            // A hole this snapshot repaired must not leave its timers
            // running: a NEW hole appearing inside a leftover grace window
            // would get short grace and fire a premature request straight
            // into the server's throttle. Drain re-arms as needed.
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
            // Snapshot the replay list BEFORE the handler runs: commands
            // sent during onSnapshot processing (e.g. layout registration)
            // are born after the full-replace and need no replay. Expired
            // entries (ack never came — rejected or shed-orphaned) are
            // pruned first so a stale command cannot be replayed onto a
            // much-later snapshot.
            {
              this.prunePendingLocalCommands();
              const replay = [...this.pendingLocalCommands];
              this.handlers.onSnapshot(
                msg.seq,
                JSON.stringify(msg.document),
                msg.peers ?? [],
                msg.your_id ?? 0,
                msg.generated_availability ?? {},
              );
              // Replay our own locally-applied-but-unacked commands:
              // usually the server built this snapshot before applying
              // them (their acks are still in flight), so the full-replace
              // just erased their optimistic local effect and re-applying
              // restores the author's view. If the snapshot in fact
              // already covered a pending command (its ack lost the
              // unicast-vs-broadcast queue race), the replay stomps any
              // newer peer value with our own — see [`PendingLocalCommand`]
              // for why that is accepted. The pending entry retires when
              // its ack lands.
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
            // An ack means the server sequenced OUR command (which we
            // applied optimistically before sending), so it advances seq
            // tracking exactly like a broadcast — with nothing to apply.
            // It also retires the oldest FRESH pending local command:
            // acks come back one per command in send order, but an
            // ack-less entry (rejected, or shed) would misalign FIFO
            // retirement forever — expired entries are pruned first so
            // retirement realigns onto the entry this ack belongs to.
            this.prunePendingLocalCommands();
            this.pendingLocalCommands.shift();
            this.handleSequenced(msg.seq, null);
            this.handlers.onAck(msg.seq);
            break;
          case "peer_joined":
            this.handlers.onPeerJoined?.(msg.client_id, msg.presence);
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
            this.handlers.onOpenDatasetFailed?.(msg.url, msg.error);
            break;
          case "dataset_health":
            this.handleDatasetHealth(msg);
            break;
          case "asset_catalog_update":
            this.handlers.onAssetCatalogUpdate?.(
              msg.dataset_id,
              JSON.stringify(msg.delta ?? { added: [] }),
            );
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
            );
            break;
          case "bookmark_changed": {
            const action = msg.action as BookmarkAction;
            const datasetUrls: string[] = Array.isArray(msg.dataset_urls)
              ? msg.dataset_urls
              : [];
            const id: string = typeof msg.id === "string" ? msg.id : "";
            this.handlers.onBookmarkChanged?.(id, action, datasetUrls);
            for (const cb of this.bookmarkChangedListeners) {
              try {
                cb(id, action, datasetUrls);
              } catch (e) {
                bridgeLog("bookmark_changed.listener_threw", {
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
            break;
          }
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

    ws.onclose = () => {
      // The close event fires asynchronously after destroy()'s close();
      // a dead bridge must not report a disconnect (or reconnect).
      if (this.destroyed) return;
      this.ws = null;
      // Seq tracking is per-connection: the reconnect's snapshot re-seeds
      // it, so nothing from the dead transport may carry over. Pending
      // local commands are dropped too — an unacked command may never have
      // reached the server, and the reconnect snapshot is the truth.
      this.lastAppliedSeq = null;
      this.resyncInFlight = false;
      this.pendingSequenced = [];
      this.pendingLocalCommands = [];
      this.documentDatasetIds = null;
      this.clearGraceTimer();
      this.clearRetryTimer();
      this.handlers.onDisconnect?.();
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.destroyed) return;
      ws.close();
    };

    this.ws = ws;
  }

  private handleBinary(buffer: ArrayBuffer) {
    if (buffer.byteLength < 6) return;
    const view = new DataView(buffer);
    // Skip client_id (4 bytes) — we are the target
    const keyLen = view.getUint16(4, true);
    if (buffer.byteLength < 6 + keyLen) return;
    const keyBytes = new Uint8Array(buffer, 6, keyLen);
    const key = new TextDecoder().decode(keyBytes);
    const payload = buffer.slice(6 + keyLen);
    // The transport doesn't know the application's chunk-vs-proxy
    // taxonomy — forward the (key, payload) pair and let the
    // application layer dispatch.
    this.handlers.onBinary?.(key, payload);
  }

  private handleDatasetHealth(msg: unknown) {
    const obj = msg as { request_id?: unknown; datasets?: unknown };
    const requestId = typeof obj.request_id === "string" ? obj.request_id : "";
    if (!requestId) return;

    const pending = this.pendingDatasetHealth.get(requestId);
    if (!pending) return;
    this.pendingDatasetHealth.delete(requestId);
    clearTimeout(pending.timer);

    const datasets = Array.isArray(obj.datasets)
      ? (obj.datasets as DatasetSourceHealth[])
      : [];
    bridgeLog("dataset_health.received", {
      requestId,
      datasetCount: datasets.length,
    }, this.ws?.readyState);
    pending.resolve(datasets);
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
   * Seq discipline for the sequenced document stream (`command_broadcast`
   * and `ack` share one seq space; the server assigns each applied command
   * exactly one seq and sends the sender an ack instead of a broadcast):
   *
   * - `seq == last + 1` — in order: deliver and advance.
   * - `seq <= last` — stale/duplicate (e.g. retained messages replayed
   *   around a resync snapshot): dropped, EXCEPT `dataset_opened` command
   *   bodies for a dataset the document still contains, which are
   *   delivered without advancing — the server legitimately rebroadcasts
   *   an already-applied `DatasetOpened` at the current seq when an open
   *   dedups onto an existing binding, and its apply is an idempotent
   *   full-replace (the rebroadcast carries the re-stamped opener for
   *   auto-fit). The membership gate keeps a retained rebroadcast from
   *   resurrecting a dataset whose `remove_dataset` the repairing snapshot
   *   already covered.
   * - `seq > last + 1` — a hole. NOT proof of loss: the server applies
   *   under the session lock but sends after releasing it, so concurrent
   *   editors routinely deliver seq out of order with nothing lost. The
   *   message is buffered and a grace timer is armed
   *   ([`RESYNC_GRACE_MS`]); a late arrival filling the hole drains the
   *   buffer and the timer no-ops. Only a hole that persists sends
   *   `request_snapshot` (at most one in flight; see
   *   [`RESYNC_RETRY_MS`]) — real loss (broadcast-queue overflow, or a
   *   command applied-but-never-broadcast such as a workspace persist
   *   failure). The snapshot that answers re-baselines tracking and
   *   drains the buffer.
   */
  private handleSequenced(
    seq: unknown,
    commandJson: string | null,
    commandType?: string,
    datasetId?: string,
  ) {
    if (typeof seq !== "number") {
      // Malformed / unsequenced frame — deliver as before rather than
      // silently eating it; tracking is untouched.
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
      // Shed the lowest seqs — the snapshot in flight covers those first.
      this.pendingSequenced.sort((a, b) => a.seq - b.seq);
      this.pendingSequenced.splice(0, this.pendingSequenced.length - MAX_PENDING_SEQUENCED);
    }
  }

  /** Apply buffered sequenced messages that the current baseline makes
   *  applicable: entries at/below `lastAppliedSeq` are dropped (the
   *  snapshot already reflects them — no double-apply; a `dataset_opened`
   *  for a still-present dataset passes through per the dedup-rebroadcast
   *  rule), contiguous entries apply in order, and a residual gap
   *  re-schedules a snapshot request. */
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
      // Still a hole below the buffered tail — schedule another request.
      this.scheduleResync();
      break;
    }
    if (this.pendingSequenced.length === 0) {
      // Hole fully resolved: nothing left to wait for or retry.
      this.clearGraceTimer();
      this.clearRetryTimer();
    }
  }

  /** Arm the grace timer for a detected hole. When it fires, a snapshot is
   *  requested only if the hole still stands — a late out-of-order arrival
   *  drains the buffer in the meantime and the callback no-ops, so benign
   *  reordering never costs a full-document round-trip. */
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
        // landed) — nothing was lost, nothing to request.
        return;
      }
      this.requestResync(this.pendingSequenced[0].seq);
    }, RESYNC_GRACE_MS);
  }

  /** Ask the server for a fresh snapshot, at most one outstanding request
   *  at a time. Every transmitted request arms the retry timer, so a hole
   *  that outlives [`RESYNC_RETRY_MS`] is re-requested even with zero
   *  further inbound traffic (idle workspace) and even if this request was
   *  eaten by the server's per-client throttle or lost on the wire. A gap
   *  storm therefore produces one request per interval, not one per
   *  message. */
  private requestResync(gapSeq: number) {
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

  /** (Re)arm the traffic-independent retry: if the hole still stands when
   *  it fires, request again (`requestResync` passes its own rate limit at
   *  exactly this interval and re-arms, so a standing hole keeps retrying
   *  once per interval until a snapshot resolves it). */
  private armRetryTimer() {
    this.clearRetryTimer();
    this.resyncRetryTimer = setTimeout(() => {
      this.resyncRetryTimer = null;
      if (this.destroyed) return;
      if (this.pendingSequenced.length === 0) return;
      this.requestResync(this.pendingSequenced[0].seq);
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
   *  id, so an entry whose ack never comes (server-side rejection is
   *  log-only; a cap shed orphans the ack that DOES come) would misalign
   *  FIFO retirement indefinitely — age is the structural staleness
   *  signal. Runs before every retirement, replay, and send. */
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
   *  By repo convention every `sendCommand` is paired with an optimistic
   *  local apply, so a
   *  command actually handed to an OPEN socket is tracked as pending until
   *  its ack: a mid-session snapshot built before the server applied it
   *  would otherwise erase its local effect on full-replace. A frame the
   *  socket drops (CONNECTING/closed/destroyed) is NOT tracked — it never
   *  reaches the server, and the next snapshot rightfully reverts it. */
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
        // Shed the oldest rather than grow unbounded. Most likely these
        // are rejection-orphans (their ack will never come), but a shed
        // entry may also be a transmitted command whose ack WILL come —
        // that ack then retires the wrong (newer) entry. The TTL prune
        // bounds how long any such misalignment can survive.
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
    // Merge type field into the presence object
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

  /** Send an open-remote-dataset request and return the `request_id` stamped
   *  on it. The server echoes this id on every `dataset_open_progress` frame
   *  for this open, so a caller can attribute progress/warnings to the exact
   *  open they initiated (and ignore stragglers from a superseded one). The id
   *  is returned even when the frame is dropped (socket not OPEN) — no progress
   *  can arrive for a dropped send, so the returned id is simply never matched. */
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

  /** Subscribe to cross-peer `bookmark_changed` broadcasts. Returns
   *  an unsubscribe function. Listeners run in registration order;
   *  exceptions in a listener are logged but don't break the chain. */
  subscribeBookmarkChanged(cb: BookmarkChangedListener): () => void {
    this.bookmarkChangedListeners.push(cb);
    return () => {
      const idx = this.bookmarkChangedListeners.indexOf(cb);
      if (idx >= 0) this.bookmarkChangedListeners.splice(idx, 1);
    };
  }

  /** Low-level send (raw JSON string). Drops the frame unless the socket is
   *  OPEN; a destroyed bridge never transmits. */
  send(json: string) {
    if (this.destroyed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
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
