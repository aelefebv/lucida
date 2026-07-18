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
 * delivering through `onSnapshot`/`onCommand`/`onAck`/`onNack` — and could compose as
 * a separate documentSync module the Bridge owns. It stays in-file
 * deliberately: its resets are interleaved with the connection lifecycle
 * (`onclose`, `destroy`, per-connection re-seeding) and its send-side hook
 * (`sendCommand`'s pending tracking) with transport readiness, so extracting
 * it would churn the client's most delicate reliability code for zero
 * behavioral gain. Take the split if and when the sequenced layer next
 * changes behavior.
 */
import { isDebugEnabled } from "./debug/logging.ts";
import { decodeChunkFrame } from "./chunkFrame.ts";
import { parseFailureDescriptor, type FailureDescriptor } from "./failureContract.ts";
import type { SourceChunkStatus } from "./pipeline/fetch/contentSource.ts";
import type {
  GeneratedChunkStatus,
  WireGeneratedAvailabilityByDataset,
} from "./pipeline/generatedAvailability.ts";
import type { FetchSourceWire } from "./manifestTypes.ts";

export type ClientId = number;

const MAX_CLIENT_ID = 0xffff_ffff;

function isClientId(value: unknown): value is ClientId {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_CLIENT_ID;
}

export { parseFailureDescriptor } from "./failureContract.ts";
export type {
  FailureCategory,
  FailureCode,
  FailureDescriptor,
} from "./failureContract.ts";

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
}

export interface DatasetGeneratedCoarseCacheStats {
  storage: string;
  current_bytes: number;
  max_bytes?: number | null;
  used_percent?: number | null;
  entry_count?: number;
  max_entries?: number | null;
  entry_used_percent?: number | null;
  evictions: number;
  root?: string | null;
  accounting_healthy?: boolean;
}

export interface DatasetGeneratedCoarseFailure {
  image_id: string;
  level_index: number;
  key: string;
  status: GeneratedChunkStatus;
  failure?: FailureDescriptor | null;
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

export interface DatasetOpenFailureDiagnostic extends FailureDescriptor {
  stage: DatasetOpenStage;
  message: string;
  detail?: string | null;
}

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

/** Lightweight requester-only confirmation. The full manifest/fetch payload
 * arrives exactly once: in this requester's success envelope, or in a
 * `dataset_opened` command broadcast for peers. Bridge normalizes both shapes
 * into the same sequenced command path before publishing this summary. */
export interface OpenedDatasetSummary {
  workspace_dataset_id: string;
  name: string;
  image_count: number;
  entity_count: number;
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
 *  transmitted, whose correlated `Ack`/`Nack` has not arrived yet. A
 *  mid-session snapshot's
 *  full-replace would silently erase its local effect — usually because
 *  the server built the snapshot before applying this command — so these
 *  are replayed locally after snapshot adoption. That premise is not
 *  airtight: acks ride the broadcast queue while snapshots ride the
 *  unicast queue, so a snapshot whose seq already covers this command can
 *  arrive BEFORE its ack, and the replay then re-applies this value over
 *  any newer peer edit the snapshot carried. Accepted tradeoff: that
 *  divergence is local-only and bounded by the next edit or snapshot,
 *  whereas skipping the replay would erase the author's own edit in the
 *  common case. Entries are retired by request id, so out-of-order outcomes
 *  and explicit rejections cannot retire or replay an unrelated command. */
interface PendingLocalCommand {
  requestId: string;
  commandJson: string;
  commandType?: string;
  datasetId?: string;
  /** `Date.now()` at transmission. A stale entry is still unsafe to replay
   *  forever if its outcome was lost with a dying transport, so age remains
   *  a structural cleanup signal — see [`PENDING_LOCAL_COMMAND_TTL_MS`]. */
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

/** Maximum age of a pending local command. A healthy outcome round-trips in
 *  well under a second; an entry without an Ack/Nack for this long was lost
 *  with a dying connection or orphaned by a cap shed. Expired entries are
 *  pruned at every retirement/replay/send sweep — without expiry, a stale
 *  pending `remove_dataset` replayed by a much-later snapshot would
 *  delete a re-opened dataset and poison the membership mirror. */
const PENDING_LOCAL_COMMAND_TTL_MS = 10_000;

/** Server-side request-id validation is intentionally strict and bounded. */
const MAX_COMMAND_REQUEST_ID_BYTES = 128;
const VALID_COMMAND_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;

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
 * fields are best-effort: `display_name` may be empty and `picture_url` may be
 * absent (dev sessions, providers without avatars). The whole object remains
 * optional so a current client can render snapshots from before peer identity
 * was added; current workspace connections always provide it.
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
  cursor_dataset_id?: string | null;
  dataset_order: string[];
  dataset_settings: Record<string, unknown>;
  /** Presentational identity for this peer's cursor (#540). Optional:
   *  absent for peers from a session without auth. */
  identity?: PeerIdentity | null;
}

/** A server-rejected document command, correlated to the exact optimistic
 * local mutation that must be retired and reconciled. */
export interface CommandNack {
  requestId: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface BridgeHandlers {
  onSnapshot: (
    seq: number,
    documentJson: string,
    peers: PresenceState[],
    yourId: ClientId,
    generatedAvailability: WireGeneratedAvailabilityByDataset,
    datasetFetch: Record<string, FetchSourceWire>,
  ) => void;
  onCommand: (seq: number, commandJson: string) => void;
  onAck: (seq: number, requestId: string) => void;
  onNack?: (nack: CommandNack) => void;
  /**
   * Binary frame received from the WebSocket. The bridge parses the
   * envelope (client_id + keyLen + key + payload) and forwards the decoded
   * chunk payload to the application layer.
   */
  onBinary?: (key: string, payload: ArrayBuffer) => void;
  onPeerJoined?: (clientId: ClientId, presence: PresenceState) => void;
  onPeerLeft?: (clientId: ClientId) => void;
  onPresenceUpdate?: (clientId: ClientId, camera: unknown, view: PresenceState["view"], display: PresenceState["display"]) => void;
  onCursorUpdate?: (
    clientId: ClientId,
    position: [number, number] | null,
    datasetId: string | null,
  ) => void;
  onFollowChanged?: (clientId: ClientId, target: ClientId | null) => void;
  onDatasetPresenceUpdate?: (clientId: ClientId, datasetOrder: string[], datasetSettings: Record<string, unknown>) => void;
  onDatasetOpenProgress?: (
    requestId: string,
    url: string,
    diagnostic: DatasetOpenProgressDiagnostic,
  ) => void;
  onOpenDatasetSucceeded?: (
    requestId: string,
    url: string,
    seq: number,
    summary: OpenedDatasetSummary,
  ) => void;
  onOpenDatasetFailed?: (
    requestId: string,
    url: string,
    error: string,
    diagnostic?: DatasetOpenFailureDiagnostic | null,
  ) => void;
  onGeneratedAvailabilityUpdate?: (datasetId: string, deltaJson: string) => void;
  onGeneratedChunkStatus?: (
    datasetId: string,
    imageId: string,
    key: string,
    status: GeneratedChunkStatus,
    failure?: FailureDescriptor | null,
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
    failure: FailureDescriptor,
    message?: string | null,
  ) => void;
  onWorkspaceArchived?: (workspaceId: string) => void;
  /**
   * The underlying WebSocket transitioned to OPEN — the transport can now
   * carry frames (before this, [`Bridge.send`] silently drops). Distinct
   * from `onSnapshot` (the application-level "session established" signal):
   * a frame sent between `onConnected` and the first snapshot still reaches
   * the server. Fires on every (re)connect's `onopen`.
   */
  onConnected?: () => void;
  onDisconnect?: () => void;
}

export class Bridge {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: BridgeHandlers;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPresence: string | null = null;
  private datasetPresenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDatasetPresence: string | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: string | null = null;
  private pendingDatasetHealth = new Map<string, PendingDatasetHealthRequest>();
  /** Recipient id established by this connection's authoritative snapshot.
   * Binary frames are ignored until it is known and whenever their header
   * names a different client. */
  private clientId: ClientId | null = null;
  /** Highest contiguously-applied document `seq` on this connection —
   *  advanced by snapshots, in-order `command_broadcast`s, and `ack`s of
   *  our own commands (which the server sequences but never rebroadcasts
   *  to us). `null` until the connection's first snapshot. */
  private lastAppliedSeq: number | null = null;
  /** True while a `request_snapshot` is outstanding; cleared by the next
   *  snapshot (or a disconnect — a reconnect's snapshot re-seeds). */
  private resyncInFlight = false;
  private lastResyncRequestAt = 0;
  /** A rejected optimistic command needs an authoritative snapshot even when
   *  the sequenced stream has no gap. Kept separate from `resyncInFlight` so
   *  a stale snapshot cannot falsely settle the reconciliation. */
  private authoritativeSnapshotRequired = false;
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
   *  applies; retired by correlated request id; cleared on disconnect. */
  private pendingLocalCommands = new Map<string, PendingLocalCommand>();
  private commandRequestCounter = 0;
  private readonly commandRequestIdFactory?: () => string;

  constructor(
    handlers: BridgeHandlers,
    urlOverride?: string,
    workspaceId?: string,
    commandRequestIdFactory?: () => string,
  ) {
    // Same-origin WebSocket so the lucida_session cookie is sent on
    // the upgrade handshake (browsers refuse cross-origin cookies on
    // WS upgrades with SameSite=Lax). Vite dev server proxies the workspace
    // WebSocket prefix to the backend; production serves both from one origin.
    if (urlOverride) {
      this.url = urlOverride;
    } else {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      if (!workspaceId) {
        throw new Error("Bridge requires a workspace id when no URL override is provided");
      }
      const path = `/ws/workspaces/${encodeURIComponent(workspaceId)}`;
      this.url = `${proto}//${window.location.host}${path}`;
    }
    this.handlers = handlers;
    this.commandRequestIdFactory = commandRequestIdFactory;
    this.connect();
  }

  private connect() {
    if (this.destroyed) return;

    this.clientId = null;

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
      this.handlers.onConnected?.();
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
            const snapshotClientId = msg.your_id;
            if (!isClientId(snapshotClientId)) {
              bridgeLog("snapshot.invalid_client_id", { clientId: snapshotClientId });
              break;
            }
            if (this.clientId !== null && snapshotClientId !== this.clientId) {
              bridgeLog("snapshot.client_id_changed", {
                expectedClientId: this.clientId,
                receivedClientId: snapshotClientId,
              });
              ws.close();
              break;
            }
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
              if (this.authoritativeSnapshotRequired) this.armRetryTimer();
              break;
            }
            // A snapshot (join, reconnect, or resync) is authoritative
            // through its seq: adopt it as the tracking baseline and settle
            // any outstanding resync before handing it to the app.
            this.lastAppliedSeq = snapshotSeq;
            this.clientId = snapshotClientId;
            this.resyncInFlight = false;
            this.authoritativeSnapshotRequired = false;
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
              const replay = [...this.pendingLocalCommands.values()];
              this.handlers.onSnapshot(
                msg.seq,
                JSON.stringify(msg.document),
                msg.peers ?? [],
                snapshotClientId,
                msg.generated_availability ?? {},
                msg.dataset_fetch ?? {},
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
                  requestId: entry.requestId,
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
          case "ack": {
            // An ack means the server sequenced OUR command (which we
            // applied optimistically before sending), so it advances seq
            // tracking exactly like a broadcast — with nothing to apply.
            // Correlation retires exactly this command even when outcomes
            // arrive out of order or another command was explicitly rejected.
            const requestId = typeof msg.request_id === "string" ? msg.request_id : "";
            this.prunePendingLocalCommands();
            this.pendingLocalCommands.delete(requestId);
            this.handleSequenced(msg.seq, null);
            this.handlers.onAck(msg.seq, requestId);
            break;
          }
          case "nack": {
            const nack: CommandNack = {
              requestId: typeof msg.request_id === "string" ? msg.request_id : "",
              code: typeof msg.code === "string" ? msg.code : "command_rejected",
              message:
                typeof msg.message === "string"
                  ? msg.message
                  : "The server rejected this command.",
              retryable: msg.retryable === true,
            };
            this.prunePendingLocalCommands();
            this.pendingLocalCommands.delete(nack.requestId);
            this.handlers.onNack?.(nack);
            // The caller applied the command optimistically. A Nack carries no
            // inverse operation, so replace from an authoritative snapshot and
            // replay only the still-pending (non-rejected) local commands.
            this.authoritativeSnapshotRequired = true;
            this.requestResync(this.lastAppliedSeq ?? 0, "command_nack");
            break;
          }
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
            this.handlers.onCursorUpdate?.(
              msg.client_id,
              msg.position,
              typeof msg.dataset_id === "string" ? msg.dataset_id : null,
            );
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
          case "open_dataset_succeeded":
            this.handleOpenDatasetSucceeded(msg);
            break;
          case "open_dataset_failed":
            this.handleOpenDatasetFailed(msg);
            break;
          case "dataset_health":
            this.handleDatasetHealth(msg);
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
              parseFailureDescriptor(msg.failure),
              msg.message ?? null,
            );
            break;
          case "source_chunk_status":
            this.handlers.onSourceChunkStatus?.(
              msg.dataset_id,
              msg.image_id,
              msg.key,
              msg.status,
              parseFailureDescriptor(msg) ?? {
                category: "source",
                code: "storage_backend",
                retryable: msg.status !== "failed_permanent",
              },
              msg.message ?? null,
            );
            break;
          case "workspace_archived":
            this.handlers.onWorkspaceArchived?.(msg.workspace_id ?? "");
            this.destroy();
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
      this.pendingLocalCommands.clear();
      this.documentDatasetIds = null;
      this.clientId = null;
      this.authoritativeSnapshotRequired = false;
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
    const decoded = decodeChunkFrame(buffer);
    if (!decoded.ok) return;
    const { clientId, key, payload } = decoded.frame;
    if (this.clientId === null || clientId !== this.clientId) {
      bridgeLog("chunk.recipient_mismatch", {
        expectedClientId: this.clientId,
        receivedClientId: clientId,
      }, this.ws?.readyState);
      return;
    }
    // Forward the decoded chunk payload to the application dispatcher.
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

  private handleOpenDatasetFailed(msg: unknown) {
    if (!msg || typeof msg !== "object") return;
    const obj = msg as Record<string, unknown>;
    const requestId = typeof obj.request_id === "string" ? obj.request_id : "";
    const url = typeof obj.url === "string" ? obj.url : "";
    const error = typeof obj.error === "string" ? obj.error : "dataset open failed";
    const rawDiagnostic = obj.diagnostic;
    const failure = parseFailureDescriptor(rawDiagnostic);
    let diagnostic: DatasetOpenFailureDiagnostic | null = null;
    if (failure && rawDiagnostic && typeof rawDiagnostic === "object") {
      const raw = rawDiagnostic as Record<string, unknown>;
      if (typeof raw.stage === "string" && typeof raw.message === "string") {
        diagnostic = {
          ...failure,
          stage: raw.stage as DatasetOpenStage,
          message: raw.message,
          detail: typeof raw.detail === "string" ? raw.detail : null,
        };
      }
    }
    this.handlers.onOpenDatasetFailed?.(requestId, url, error, diagnostic);
  }

  private handleOpenDatasetSucceeded(msg: unknown) {
    if (!msg || typeof msg !== "object") return;
    const obj = msg as Record<string, unknown>;
    const requestId = typeof obj.request_id === "string" ? obj.request_id : "";
    const url = typeof obj.url === "string" ? obj.url : "";
    const seq = typeof obj.seq === "number" ? obj.seq : -1;

    // The server sends the requester the full DatasetOpened payload inside
    // this success envelope and excludes that socket from the peer broadcast.
    // Normalize the envelope at the transport boundary so SessionController
    // has exactly one registration path, with the same ordering, gap repair,
    // membership tracking, and stale-dedup behavior as a command broadcast.
    const rawOpened = obj.opened;
    if (seq >= 0 && rawOpened && typeof rawOpened === "object") {
      const opened = rawOpened as Record<string, unknown>;
      const command = { ...opened, type: "dataset_opened" };
      const datasetId = membershipDatasetId(
        command as { type?: string; manifest?: { dataset_id?: unknown } },
      );
      if (datasetId) {
        this.handleSequenced(
          seq,
          JSON.stringify(command),
          "dataset_opened",
          datasetId,
        );
      } else {
        bridgeLog("open_remote_dataset.malformed_opened", { requestId, url, seq });
      }
    }

    const raw = obj.summary;
    if (!requestId || !url || seq < 0 || !raw || typeof raw !== "object") return;
    const summary = raw as Record<string, unknown>;
    if (
      typeof summary.workspace_dataset_id !== "string"
      || typeof summary.name !== "string"
      || !Number.isSafeInteger(summary.image_count)
      || !Number.isSafeInteger(summary.entity_count)
    ) return;
    this.handlers.onOpenDatasetSucceeded?.(requestId, url, seq, {
      workspace_dataset_id: summary.workspace_dataset_id,
      name: summary.name,
      image_count: summary.image_count as number,
      entity_count: summary.entity_count as number,
    });
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
      if (!this.authoritativeSnapshotRequired) this.clearRetryTimer();
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
  private requestResync(gapSeq: number, reason = "sequence_gap") {
    const now = Date.now();
    if (this.resyncInFlight && now - this.lastResyncRequestAt < RESYNC_RETRY_MS) {
      return;
    }
    this.resyncInFlight = true;
    this.lastResyncRequestAt = now;
    bridgeLog(
      "snapshot.requested",
      { lastAppliedSeq: this.lastAppliedSeq, gapSeq, reason },
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
      if (this.pendingSequenced.length === 0 && !this.authoritativeSnapshotRequired) return;
      this.requestResync(
        this.pendingSequenced[0]?.seq ?? this.lastAppliedSeq ?? 0,
        this.authoritativeSnapshotRequired ? "command_nack_retry" : "sequence_gap_retry",
      );
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

  /** Drop pending local commands older than the TTL. Even with exact outcome
   *  correlation, a dead transport may lose both Ack/Nack; age prevents that
   *  orphan from being replayed forever. Runs before every retirement,
   *  replay, and send. */
  private prunePendingLocalCommands() {
    if (this.pendingLocalCommands.size === 0) return;
    const cutoff = Date.now() - PENDING_LOCAL_COMMAND_TTL_MS;
    let dropped = 0;
    for (const [requestId, entry] of this.pendingLocalCommands) {
      if (entry.sentAt < cutoff) {
        this.pendingLocalCommands.delete(requestId);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      bridgeLog("pending_command.expired", {
        dropped,
      });
    }
  }

  /** Produce a server-valid, bounded correlation id. The optional factory is
   *  a deterministic test seam; production ids combine an instance counter
   *  with UUID entropy (or a bounded random fallback). */
  private nextCommandRequestId(): string {
    this.commandRequestCounter += 1;
    const generated = this.commandRequestIdFactory?.() ?? (() => {
      const entropy = globalThis.crypto?.randomUUID?.()
        ?? Math.random().toString(36).slice(2);
      return `web-command-${this.commandRequestCounter.toString(36)}-${entropy}`;
    })();
    if (
      generated.length === 0
      || generated.length > MAX_COMMAND_REQUEST_ID_BYTES
      || !VALID_COMMAND_REQUEST_ID.test(generated)
    ) {
      throw new Error("Command request id must be 1-128 ASCII letters, digits, '.', '_', ':', or '-'");
    }
    if (!this.pendingLocalCommands.has(generated)) return generated;
    const suffix = `:${this.commandRequestCounter.toString(36)}`;
    const deduplicated = `${generated.slice(0, MAX_COMMAND_REQUEST_ID_BYTES - suffix.length)}${suffix}`;
    if (this.pendingLocalCommands.has(deduplicated)) {
      throw new Error("Command request id factory produced a duplicate pending id");
    }
    return deduplicated;
  }

  /** Send a document command wrapped in the ClientMessage envelope.
   *
   *  By repo convention every `sendCommand` is paired with an optimistic
   *  local apply (see wiki/flows/document-command-application.md), so a
   *  command actually handed to an OPEN socket is tracked as pending until
   *  its ack: a mid-session snapshot built before the server applied it
   *  would otherwise erase its local effect on full-replace. A frame the
   *  socket drops (CONNECTING/closed/destroyed) is NOT tracked — it never
   *  reaches the server, and the next snapshot rightfully reverts it. */
  sendCommand(json: string): string {
    const cmd = JSON.parse(json) as {
      type?: string;
      id?: unknown;
      manifest?: { dataset_id?: unknown };
    };
    const requestId = this.nextCommandRequestId();
    const sent = this.send(JSON.stringify({
      type: "command",
      request_id: requestId,
      command: cmd,
    }));
    if (sent) {
      this.prunePendingLocalCommands();
      this.pendingLocalCommands.set(requestId, {
        requestId,
        commandJson: JSON.stringify(cmd),
        commandType: cmd?.type,
        datasetId: membershipDatasetId(cmd),
        sentAt: Date.now(),
      });
      while (this.pendingLocalCommands.size > MAX_PENDING_LOCAL_COMMANDS) {
        // Map insertion order gives a deterministic oldest-first cap without
        // compromising later Ack/Nack correlation for the retained entries.
        const oldestRequestId = this.pendingLocalCommands.keys().next().value;
        if (oldestRequestId === undefined) break;
        this.pendingLocalCommands.delete(oldestRequestId);
      }
    }
    return requestId;
  }

  /** Request an authoritative collaborative inverse. Unlike `sendCommand`,
   * this is not applied optimistically: the server rechecks authorship,
   * permission, revision, and semantic preconditions, then sends the concrete
   * inverse back through `command_broadcast` to this client and every peer. */
  sendInverseCommand(targetOperationId: number, expectedRevision: number): string {
    if (!Number.isSafeInteger(targetOperationId) || targetOperationId < 0) {
      throw new Error("Target operation id must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("Expected revision must be a non-negative safe integer");
    }
    const requestId = this.nextCommandRequestId();
    this.send(JSON.stringify({
      type: "inverse_command",
      request_id: requestId,
      target_operation_id: targetOperationId,
      expected_revision: expectedRevision,
    }));
    return requestId;
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
   *  open they initiated (and ignore stragglers from a superseded one).
   *
   *  `null` is an explicit transport-admission failure: the bridge did not
   *  hand the frame to an OPEN socket. Callers must not create pending state
   *  for that case because no correlated terminal response can ever arrive. */
  sendOpenRemoteDataset(url: string): string | null {
    const requestId = makeOpenDatasetRequestId();
    const willTransmit =
      !this.destroyed && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    bridgeLog("open_remote_dataset.send", { url, requestId }, this.ws?.readyState);
    if (!willTransmit) return null;
    const sent = this.send(JSON.stringify({
      type: "open_remote_dataset",
      request_id: requestId,
      url,
    }));
    return sent ? requestId : null;
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

  /** Send a cursor position plus its dataset coordinate space, throttled to
   *  [`PRESENCE_THROTTLE_MS`]. Null sends immediately and clears identity. */
  sendCursor(position: [number, number] | null, datasetId: string | null = null) {
    if (position === null) {
      if (this.cursorTimer !== null) {
        clearTimeout(this.cursorTimer);
        this.cursorTimer = null;
      }
      this.pendingCursor = null;
      this.send(JSON.stringify({ type: "cursor", position: null, dataset_id: null }));
      return;
    }
    this.pendingCursor = JSON.stringify({
      type: "cursor",
      position,
      dataset_id: datasetId,
    });
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

  /** Low-level send (raw JSON string). Returns whether this socket epoch
   *  accepted the frame; callers that own request state must not infer a send
   *  from invocation alone. */
  send(json: string): boolean {
    if (this.destroyed) return false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(json);
        return true;
      } catch {
        // OPEN can race a native close between the readyState check and send.
        // Drive the ordinary disconnect/reconnect terminal rather than
        // claiming transmission for a frame the browser rejected.
        this.ws.close();
      }
    }
    return false;
  }

  /**
   * End the current socket epoch. Used when an acknowledged request has no
   * response/status by its protocol deadline: only disconnect makes it safe
   * to release that response credit and retry without overlapping a late
   * frame from the old epoch.
   */
  resetTransport(): void {
    if (this.destroyed) return;
    this.ws?.close();
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
    this.pendingLocalCommands.clear();
    this.documentDatasetIds = null;
    this.clientId = null;
    this.resyncInFlight = false;
    this.authoritativeSnapshotRequired = false;
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
