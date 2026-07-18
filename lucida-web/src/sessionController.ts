import type { WasmScene } from "lucida-core";
import {
  Bridge,
  bridgeLog,
  type BridgeHandlers,
  type ClientId,
  type DatasetOpenProgressDiagnostic,
  type PresenceState,
} from "./bridge.ts";
import type { DatasetState } from "./types.ts";
import { Axis } from "./axes.ts";
import {
  resolveDatasetManifest,
  resolveFetchSource,
  type DatasetManifest,
  type DatasetManifestWire,
  type FetchSource,
  type FetchSourceWire,
} from "./manifestTypes.ts";
import type { ViewportCommand } from "./commands.ts";
import { DecodePool, ProxiedContentSource, CpuCache } from "./pipeline/fetch/index.ts";
import type {
  WireGeneratedAvailabilityByDataset,
  WireGeneratedAvailabilityDelta,
  WireGeneratedAvailabilitySnapshot,
} from "./pipeline/generatedAvailability.ts";
import { derivedBuildersFor } from "./pipeline/layoutBuilders.ts";
import { Session } from "./session.ts";
import type { RenderLoop } from "./renderLoop.ts";
import { bumpSettingsGeneration } from "./tickCommon.ts";
import { invalidateDisplaySettings } from "./invalidation.ts";
import { syncSceneViewState, type SceneViewStateSetters } from "./hooks/sceneViewState.ts";
import { shouldAutoFitOnOpen, isOpenerOf } from "./hooks/autoFit.ts";
import { classifySceneError, guardedSceneCall, observeSceneCalls } from "./sceneGuard.ts";
import { validateDatasetChunkAdmission } from "./chunkContract.ts";

/** Consecutive scene-mutation failures (local, remote, or snapshot — every
 *  mutation reports through the scene-call guard) before the scene is
 *  treated as unable to apply updates and the error becomes user-visible.
 *  A single bad command stays in the log (the streak resets on the next
 *  successful mutation, again from any origin); fatal-class engine errors
 *  skip the streak entirely. */
const SCENE_APPLY_FAILURE_LIMIT = 3;

/** Upper bound on how many distinct import-warning messages are retained in
 *  the store and surfaced through [`RemoteDatasetActivity.warnings`]. A single
 *  open can emit one distinct notice per malformed member (thousands for a
 *  large collection), each unique so dedup never collapses them; retaining and
 *  re-projecting all of them would grow the observable list without bound and
 *  stall the tab. Past this many, further distinct warnings are counted (see
 *  [`RemoteDatasetActivity.warningsOverflow`]) rather than stored — the list
 *  stays bounded while the FACT that more warnings occurred is never lost. */
export const MAX_OPEN_WARNINGS = 50;

/** Hard bounds for warning bookkeeping beyond the visible list. Once either
 * index saturates, the controller keeps a conservative occurrence count
 * without retaining another source or message identity. */
export const MAX_TRACKED_OPEN_WARNING_SOURCES = 128;
export const MAX_OPEN_WARNING_FINGERPRINTS = 4096;
export const MAX_OPEN_WARNING_MESSAGE_CHARS = 2048;

/** Maximum dataset-open lifecycle entries retained, including one slot reserved
 * for a local admission/transport failure. Server admission stops before this
 * boundary instead of evicting an unresolved sibling: every accepted request
 * therefore remains retryable/dismissible until its own terminal callback or
 * user action. */
export const MAX_TRACKED_OPEN_REQUESTS = 128;
const LOCAL_OPEN_CAPACITY_REQUEST_PREFIX = "local-open-capacity:";
const LOCAL_OPEN_TRANSPORT_REQUEST_PREFIX = "local-open-transport:";

interface PendingOpenRequest {
  status: "pending";
  requestId: string;
  url: string;
  sentAt: number | null;
  progress: string | null;
  progressOrder: number;
}

interface FailedOpenRequest {
  status: "failed";
  requestId: string;
  url: string;
  error: string;
  failureOrder: number;
}

type TrackedOpenRequest = PendingOpenRequest | FailedOpenRequest;

function boundedWarningMessage(message: string): string {
  if (message.length <= MAX_OPEN_WARNING_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_OPEN_WARNING_MESSAGE_CHARS - 1)}…`;
}

function boundedWarningIdentity(value: string): string {
  // Warning text and request ids are untrusted. Hash a bounded head/tail
  // sample plus the original length so identity remains distinct when long
  // values share a display prefix, without retaining or scanning an
  // arbitrarily large string.
  const half = MAX_OPEN_WARNING_MESSAGE_CHARS / 2;
  const bounded = value.length <= MAX_OPEN_WARNING_MESSAGE_CHARS
    ? value
    : `${value.slice(0, half)}:${value.length}:${value.slice(-half)}`;
  return warningFingerprint(bounded);
}

interface RetainedOpenWarning {
  identity: string;
  display: string;
}

/**
 * Fixed-size identity for overflow deduplication. Warning text is untrusted
 * source metadata and can be arbitrarily large, so retaining every over-cap
 * string would defeat the display cap's memory-safety purpose. Two independent
 * 32-bit FNV-1a lanes plus length make accidental collisions negligible while
 * keeping each seen entry bounded. Callers pass bounded text.
 */
function warningFingerprint(message: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < message.length; i++) {
    const code = message.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${message.length}:${first >>> 0}:${second >>> 0}`;
}

/**
 * The kinds of user-visible errors competing for the single
 * [`RemoteDatasetActivity`]`.error` slot. There is one banner, so
 * collisions are resolved by rank ([`SURFACED_ERROR_RANK`]): a candidate
 * never displaces a standing error of strictly higher rank, equal-or-lower
 * standing errors yield to it. Each kind also has its own retirement
 * signal — see [`clearSurfacedError`] call sites:
 *
 * - `engine-fatal`: the wasm scene is unrecoverably dead. Outranks
 *   everything and is never cleared — only a reload recovers.
 * - `engine`: scene mutations keep failing (non-fatal streak). Cleared by
 *   the next successful mutation, which disproves persistent apply death.
 * - `open`: one or more dataset opens failed. The visible newest failure is
 *   retired only by its own retry/dismiss (or a deliberate manual retry of the
 *   same URL); unrelated progress/success leaves the failure backlog intact.
 * - `data`: chunk delivery keeps failing. Cleared by the next delivered
 *   (fetched AND decoded) chunk.
 * - `command`: the server rejected an optimistic document mutation. Cleared
 *   by the next accepted command; the Bridge independently requests an
 *   authoritative snapshot to roll the rejected local state back.
 * - `incompatible`: inbound commands were refused at the parse boundary
 *   (e.g. version skew with a peer) while the scene stays healthy.
 *   Advisory only; cleared by the next successful mutation.
 *
 * `open`, `data`, `command`, and `incompatible` share the lowest rank and resolve by
 * last-writer-wins. Ranking any of them above the others would let a stale
 * one-shot banner mask a live, ongoing condition — e.g. a standing open
 * failure hiding a delivery-failure streak that began afterwards, leaving
 * the stalling canvas unexplained. Each kind still retires only through
 * its own signal, and `data`/`incompatible` re-emit while their condition
 * persists, so the newest actionable signal wins the slot without losing
 * anything durable.
 */
export type RemoteDatasetErrorKind =
  | "engine-fatal"
  | "engine"
  | "open"
  | "data"
  | "command"
  | "incompatible";

type SurfacedErrorKind = RemoteDatasetErrorKind;

const SURFACED_ERROR_RANK: Record<SurfacedErrorKind, number> = {
  "engine-fatal": 3,
  "engine": 2,
  "open": 1,
  "data": 1,
  "command": 1,
  "incompatible": 1,
};

/** Callback surface the SavedView applier registers into so it sees the
 * relevant lifecycle events without the session layer importing applier
 * types directly. Optional: when absent, the controller skips the call. */
export interface SavedViewBridgeHooks {
  onDatasetOpened: (datasetId: string) => void;
  onOpenDatasetFailed: (url: string, error: string) => void;
  /** Correlates an arriving dataset with the active saved-view generation. The
   * controller suppresses auto-fit only for an open the restore actually owns,
   * never because an unrelated global "busy" flag happened to be true. */
  ownsDatasetOpen?: (datasetId: string) => boolean;
}

/** Aggregate open-remote-dataset UI state (spinner / error banner / progress
 *  line). The controller owns the transitions; consumers only render it. */
export interface RemoteDatasetActivity {
  loading: boolean;
  error: string | null;
  /** Typed owner of the visible error slot. UI actions branch on this instead
   *  of parsing user-facing text (an `open` error can be retried/dismissed;
   *  engine/data/command failures have different recovery signals). */
  errorKind: RemoteDatasetErrorKind | null;
  progress: string | null;
  /** Non-fatal import warnings collected across the session, kept durably
   *  after each open completes (unlike `progress`, which is transient). This
   *  is the flattened, order-preserving, deduplicated projection of every
   *  source's collected warnings, so datasets opened together in one pass
   *  (multi-seed workspace creation, source-url view restores) each surface
   *  their warnings — not just the last open's. Cleared wholesale by
   *  [`dismissOpenWarnings`] and on connection loss; a single failed open
   *  clears only its own. Capped at [`MAX_OPEN_WARNINGS`] distinct messages —
   *  see `warningsOverflow` for what the cap elides. */
  warnings: readonly string[];
  /** How many further warnings occurred beyond the ones retained in
   *  `warnings` (the [`MAX_OPEN_WARNINGS`] cap). This is an exact distinct
   *  count while the bounded fingerprint/source indexes have capacity; after
   *  either saturates it conservatively counts reports. That trade keeps the
   *  signal and memory both bounded. */
  warningsOverflow: number;
}

/**
 * Notifications the controller emits toward its owner (in the app, the
 * `useBridge` adapter, which mirrors them into React state). Deliberately
 * narrow: values flow one way, out of the controller — the owner never has
 * to reach back in to keep its mirrors consistent.
 *
 * Every callback fires synchronously from within a bridge handler (or a
 * controller method), never from a deferred task, so a listener that mirrors
 * into React state observes events in exactly the order the protocol
 * delivered them. One deliberate exception: `onRemoteDocumentChanged` for a
 * snapshot burst — see its doc below.
 *
 * `onPeersChanged` hands over a freshly built `Map` on every change (the
 * controller never mutates a map it has emitted), so the owner may store the
 * reference directly and rely on identity inequality for change detection.
 */
export interface SessionControllerEvents {
  /** WebSocket OPEN / closed (see the readiness notes on [`useBridge`]'s
   *  `connected` return). */
  onConnectedChanged: (connected: boolean) => void;
  /** First snapshot applied (session fully established) / connection lost. */
  onSessionReadyChanged: (ready: boolean) => void;
  /** Server-assigned id for this client, from the snapshot's `your_id`. */
  onSelfIdChanged: (id: ClientId) => void;
  onPeersChanged: (peers: Map<ClientId, PresenceState>) => void;
  onFollowTargetChanged: (target: ClientId | null) => void;
  onRemoteDatasetActivity: (activity: RemoteDatasetActivity) => void;
  /** The scene adopted new authoritative content (snapshot load or a
   *  `dataset_opened` apply). Owners holding the scene as state re-publish. */
  onSceneChanged: (scene: WasmScene) => void;
  /** Dataset registry membership or manifests changed (version-counter tick). */
  onDatasetsChanged: () => void;
  /** The shared document changed (any applied command or snapshot).
   *
   *  Emission timing: a live command emits synchronously from its handler.
   *  A snapshot is different — the bridge synchronously replays pending
   *  local commands (and drains gap-buffered ones) right after `onSnapshot`
   *  returns, so per-change emission would fire 1 + N times for one document
   *  adoption, and the early emissions would let a synchronous listener read
   *  the scene BEFORE the replays restored the author's own edits. The
   *  controller therefore coalesces the whole burst into ONE emission,
   *  delivered from a microtask after the burst completes — post-replay
   *  state, exactly once. */
  onRemoteDocumentChanged: () => void;
  onWorkspaceArchived: () => void;
}

/**
 * Everything the controller needs from its host. All functions must be safe
 * to call for the controller's whole lifetime; host values that change over
 * time (scene, render loop, callback registries) are reached through getters
 * so the controller always sees the current one.
 */
export interface SessionControllerDeps {
  workspaceId: string;
  /** Construct-or-return the WasmScene (see `useWasmScene.ensureScene`). */
  ensureScene: () => WasmScene;
  /** Current scene, or null before the first snapshot/open creates it. */
  getScene: () => WasmScene | null;
  /** Current render loop, or null while no viewer is mounted. */
  getLoop: () => RenderLoop | null;
  /**
   * Shared dataset registry. The host owns the Map's *identity* (other
   * consumers hold the same reference); the controller owns its *contents* —
   * it is the only writer, and `destroy()` clears it so a successor
   * controller re-registers every fetch pipeline against its own content
   * source (stale entries would leave chunk fetches unroutable).
   */
  datasets: Map<string, DatasetState>;
  /** Tear down host-side per-dataset state (layer maps, selection, …). */
  removeDatasetLocal: (id: string) => void;
  /** SavedView applier hooks, when registered (see [`SavedViewBridgeHooks`]). */
  getSavedViewHooks: () => SavedViewBridgeHooks | null;
  bumpLayerSettingsVersion: () => void;
  initLayerMaps: (id: string) => void;
  /** Auto-select the first dataset registered into an empty registry. */
  setSelectedDatasetId: (id: string) => void;
  /** Z/T/C/view-mode/multi-channel sinks for presence-follow imports. */
  viewState: SceneViewStateSetters;
  events: SessionControllerEvents;
}

/**
 * Owner of the per-workspace collaboration stack: constructs the
 * DecodePool → ProxiedContentSource → CpuCache → Bridge → Session chain,
 * wires every bridge handler, and holds the connection-scoped state those
 * handlers need (self id, peers, follow target, open-in-flight bookkeeping,
 * the dataset registry contents).
 *
 * Lifecycle is explicit and single-shot: `new SessionController(deps)`
 * connects; `destroy()` (idempotent) tears the whole stack down — WebSocket
 * plus reconnect/throttle timers, in-flight fetches, pending request
 * timeouts, decode workers — and clears the dataset registry. A host that
 * needs a session again constructs a fresh controller; nothing here is
 * re-armable (the instance-per-mount resolution in
 * wiki/gotchas/strict-mode-destroyable-classes.md).
 *
 * This module is framework-free on purpose: the session must not care how
 * often a UI re-renders or re-runs effects. React (or a test) adapts via
 * [`SessionControllerDeps`] / [`SessionControllerEvents`].
 *
 * Handler timing contract: the bridge re-feeds pending local commands
 * through `onCommand` *synchronously* right after `onSnapshot` returns, and
 * drains gap-buffered messages the same way — so every handler here runs its
 * effects inline. Deferring any of this (microtask, RAF, state batch) would
 * let a replayed command observe pre-snapshot state.
 */
export class SessionController {
  readonly session: Session;

  private readonly deps: SessionControllerDeps;
  private readonly contentSource: ProxiedContentSource;

  private destroyed = false;
  /** Server-assigned id, from the snapshot. Id 0 is a legitimate first-client
   *  id, not a sentinel — but until the first snapshot no `dataset_opened`
   *  can arrive either (the snapshot is always the connection's first
   *  message), so the initial 0 is never consulted for opener matching. */
  private myId: ClientId = 0;
  private followTarget: ClientId | null = null;
  /** Co-present peers (self excluded). Replace-on-write: every mutation
   *  builds a new Map and emits it — see [`SessionControllerEvents`]. */
  private peers = new Map<ClientId, PresenceState>();
  private remoteActivity: RemoteDatasetActivity = {
    loading: false,
    error: null,
    errorKind: null,
    progress: null,
    warnings: [],
    warningsOverflow: 0,
  };
  /** Request-correlated open lifecycle. The map contains only pending opens
   *  and unresolved failures; success, retry, and dismiss remove exactly their
   *  own entry. It is admission-bounded by [`MAX_TRACKED_OPEN_REQUESTS`], so we
   *  never trade memory safety for silently evicting an accepted sibling.
   *
   *  `remoteActivity` is merely the projection: loading is ANY pending request,
   *  progress is the most recently updated pending request, and the one banner
   *  shows the most recently failed unresolved request. */
  private readonly openRequests = new Map<string, TrackedOpenRequest>();
  private openActivityOrder = 0;
  private localOpenCapacityFailureId = 0;
  /** Non-fatal import warnings grouped by the request that produced them.
   *  Collection is
   *  session-level and never reset per open, so datasets opened together in
   *  one synchronous pass (multi-seed workspace creation, source-url view
   *  restores) each contribute their warnings instead of the last open's reset
   *  erasing the rest. Grouping by request lets a failed open retire only its
   *  own warnings while sibling opens — including the same URL opened twice —
   *  stand. The observable
   *  [`RemoteDatasetActivity.warnings`] is the flattened, deduplicated
   *  projection of this map (see [`publishWarnings`]). Bounded: no more than
   *  [`MAX_OPEN_WARNINGS`] distinct messages are retained across all sources.
   *  Source keys, displayed text, and overflow identities all have independent
   *  hard caps; after those caps the observable counter becomes a conservative
   *  occurrence count rather than an exact distinct count. */
  private readonly warningsByUrl = new Map<string, RetainedOpenWarning[]>();
  /** The distinct warning identities currently retained in [`warningsByUrl`] (its
   *  cross-source dedup, materialized). Consulted on collect for O(1)
   *  membership and size so the cap decision does not rescan the store, and so
   *  a message already shown via one source is never miscounted as overflow
   *  when a second source reports it. Kept in lock-step with the store. */
  private readonly retainedMessages = new Set<string>();
  /** Bounded display lines currently visible. Two long warnings may have the
   * same truncated display but different identities; the later one becomes an
   * overflow fact instead of rendering a duplicate-looking line. */
  private readonly retainedWarningDisplays = new Set<string>();
  /**
   * Per-source holds on fixed-size fingerprints for messages dropped once the
   * retention cap was reached. The sets make replay idempotent and let a failed
   * source retire only its own hold without retaining unbounded warning text.
   */
  private readonly overflowMessagesByUrl = new Map<string, Set<string>>();
  /**
   * Cross-source reference count for each overflow fingerprint. This mirrors the
   * retained-message dedup contract: the same warning reported by two sources
   * is one observable warning, but either source can fail without erasing the
   * other's hold.
   */
  private readonly overflowMessageRefCounts = new Map<string, number>();
  /** Bounded source identity index. Keys are fixed-size URL fingerprints. */
  private readonly trackedWarningSources = new Set<string>();
  /** Per-tracked-source overflow occurrences after the fingerprint index
   * saturates. Scalars preserve source cleanup without retaining identities. */
  private readonly saturatedOverflowByUrl = new Map<string, number>();
  /** Exact distinct overflow count until a safety index saturates, then a
   * conservative report count. Surfaced through `warningsOverflow`. */
  private overflowWarnings = 0;
  /** True while a coalesced `onRemoteDocumentChanged` emission is scheduled
   *  for the current snapshot burst (see the event's doc). Commands applied
   *  while it is set — the bridge's synchronous pending-command replays and
   *  gap-buffer drain — are covered by that one emission. */
  private docChangedEmitPending = false;
  /** Consecutive scene-mutation failures reported by the scene-call guard;
   *  reset by each successful mutation. See [`handleSceneCallFailed`]. */
  private sceneApplyFailureStreak = 0;
  /** Kind of the currently displayed `remoteActivity.error`, or null when
   *  no error is showing. Kept in lock-step with the error string by
   *  [`surfaceError`] / [`clearSurfacedError`] — never write the error
   *  field around them. */
  private surfacedErrorKind: SurfacedErrorKind | null = null;
  /** Unsubscribes this controller from the scene-call guard on destroy. */
  private readonly stopObservingSceneCalls: () => void;
  private readonly cpuCache: CpuCache;

  constructor(deps: SessionControllerDeps) {
    this.deps = deps;
    const decodePool = new DecodePool();
    decodePool.onFailure = (error, terminal) => {
      if (this.destroyed || !terminal) return;
      this.surfaceError(
        "data",
        `Data decoding stopped after worker recovery was exhausted: ${error.message}. ` +
          "Reload the viewer to retry.",
      );
    };
    this.contentSource = new ProxiedContentSource(
      (json) => this.session?.bridge.send(json),
    );
    this.cpuCache = new CpuCache(this.contentSource, decodePool, {
      // Chunk deliveries failing without interruption would otherwise
      // present as a silently stalling canvas; route the cache's
      // aggregated, throttled signal to the visible error banner, and
      // retire it when delivery recovers. Access revoked after a
      // successful open lands here because the server reports store
      // failures as per-chunk `source_chunk_status` frames (permanent
      // rejections); a source serving undecodable bytes lands here via
      // the decode boundary.
      onChunkFailureStreak: (consecutiveFailures, lastError) => {
        if (this.destroyed) return;
        this.surfaceError(
          "data",
          `Data loading is failing repeatedly (${consecutiveFailures} chunks ` +
            `in a row; last error: ${lastError}). ` +
            "Check your connection and access.",
        );
      },
      onChunkFailureRecovered: () => {
        if (this.destroyed) return;
        this.clearSurfacedError(["data"]);
      },
    });
    const bridge = new Bridge(this.buildHandlers(), undefined, deps.workspaceId);
    this.session = new Session({
      bridge,
      contentSource: this.contentSource,
      cpuCache: this.cpuCache,
      decodePool,
    });
    // Scene mutations report their outcome through the guard from every
    // module (the remote handlers here, but also local UI paths, saved-view
    // restores, registries), so a solo session's engine failure surfaces
    // exactly like a collaborative one's. Reports are scoped to THIS
    // session's scene via the guard's subject: sessions can coexist
    // transiently (overlapping mounts during a workspace switch), and
    // another session's successful apply on its own scene must not reset
    // this one's failure streak or retire its banner.
    this.stopObservingSceneCalls = observeSceneCalls({
      onSceneCallApplied: (_context, subject) => {
        if (subject !== this.deps.getScene()) return;
        this.handleSceneCallApplied();
      },
      onSceneCallFailed: (e, _context, subject) => {
        if (subject !== this.deps.getScene()) return;
        this.handleSceneCallFailed(e);
      },
    });
  }

  get bridge(): Bridge {
    return this.session.bridge;
  }

  /**
   * Tear down the whole stack this controller constructed: the WebSocket +
   * reconnect/throttle timers, in-flight fetches, pending request timeouts,
   * and the decode workers (all via `Session.destroy`, itself idempotent —
   * this composes safely with the workspace-archived path, which already
   * destroyed the bridge). Also clears the shared dataset registry: a
   * successor session must rebuild fetch pipelines from its own snapshot,
   * and stale entries would make the exists-checks skip registration
   * against the new content source, leaving every chunk fetch unroutable.
   *
   * Emits no events — the owner resets its own mirrors on teardown.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopObservingSceneCalls();
    this.session.destroy();
    this.deps.datasets.clear();
    this.openRequests.clear();
    this.warningsByUrl.clear();
    this.retainedMessages.clear();
    this.retainedWarningDisplays.clear();
    this.overflowMessagesByUrl.clear();
    this.overflowMessageRefCounts.clear();
    this.trackedWarningSources.clear();
    this.saturatedOverflowByUrl.clear();
    this.overflowWarnings = 0;
  }

  // ---------------------------------------------------------------------
  // Outbound surface (user-initiated sends).
  // ---------------------------------------------------------------------

  sendCommand(json: string): void {
    this.session.bridge.sendCommand(json);
  }

  sendCursor(position: [number, number] | null, datasetId: string | null): void {
    this.session.bridge.sendCursor(position, datasetId);
  }

  emitPresence(): void {
    const scene = this.deps.getScene();
    if (!scene) return;
    this.session.bridge.sendPresence(scene.export_presence());
  }

  emitDatasetPresence(): void {
    const scene = this.deps.getScene();
    if (!scene) return;
    this.session.bridge.sendDatasetPresence(scene.export_dataset_presence());
  }

  openRemoteDataset(url: string): void {
    // A deliberate new attempt for the same source supersedes that source's
    // old failures, but never retires failures belonging to sibling URLs.
    this.removeFailedOpenRequestsForUrl(url);
    this.refreshVisibleOpenFailure();
    this.beginOpenRequest(url);
  }

  private beginOpenRequest(url: string): void {
    // The final slot is reserved for an actionable local admission failure.
    // Replace an older capacity notice with the user's latest attempt; it was
    // never sent, so this does not discard an in-flight server request.
    for (const requestId of this.openRequests.keys()) {
      if (requestId.startsWith(LOCAL_OPEN_CAPACITY_REQUEST_PREFIX)) {
        this.openRequests.delete(requestId);
      }
    }
    // Preserve every ACCEPTED request until its own terminal signal. Refusing
    // admission at the hard cap is safer than evicting an unresolved request,
    // which would make loading and retry state lie about work still in flight.
    if (this.openRequests.size >= MAX_TRACKED_OPEN_REQUESTS - 1) {
      const requestId =
        `${LOCAL_OPEN_CAPACITY_REQUEST_PREFIX}${++this.localOpenCapacityFailureId}`;
      const error =
        `Too many dataset opens are waiting (limit ${MAX_TRACKED_OPEN_REQUESTS - 1}). ` +
        "Retry after another open finishes, or dismiss an earlier failure.";
      this.openRequests.set(requestId, {
        status: "failed",
        requestId,
        url,
        error,
        failureOrder: ++this.openActivityOrder,
      });
      bridgeLog("open_remote_dataset.tracking_limit", {
        requestId,
        url,
        limit: MAX_TRACKED_OPEN_REQUESTS - 1,
      });
      this.surfaceError("open", error);
      this.deps.getSavedViewHooks()?.onOpenDatasetFailed(url, error);
      return;
    }

    const sentAt = performance.now();
    // Bridge's admission contract is nullable: an id means the OPEN socket
    // accepted the frame; null means it was not transmitted. Never create a
    // pending request for a dropped send, or reconnect races leave a permanent
    // spinner with no callback capable of retiring it.
    const requestId: string | null = this.session.bridge.sendOpenRemoteDataset(url);
    if (requestId === null) {
      const failureId =
        `${LOCAL_OPEN_TRANSPORT_REQUEST_PREFIX}${++this.localOpenCapacityFailureId}`;
      const error =
        "The dataset open was not sent because the workspace connection is not ready. " +
        "Retry after the connection is restored.";
      this.openRequests.set(failureId, {
        status: "failed",
        requestId: failureId,
        url,
        error,
        failureOrder: ++this.openActivityOrder,
      });
      bridgeLog("open_remote_dataset.transport_not_ready", { url });
      this.surfaceError("open", error);
      this.deps.getSavedViewHooks()?.onOpenDatasetFailed(url, error);
      return;
    }
    const progressOrder = ++this.openActivityOrder;
    this.openRequests.set(requestId, {
      status: "pending",
      requestId,
      url,
      sentAt,
      progress: "dataset open request sent",
      progressOrder,
    });
    bridgeLog("open_remote_dataset.loading_start", { requestId, url });
    // Collected warnings are NOT reset here: several opens can be issued in one
    // synchronous pass (multi-seed workspace creation, source-url view
    // restores), and resetting per open would erase every earlier open's
    // warnings before its progress frames arrived. Each source's warnings are
    // retired by their own signal instead — that open failing, or a dismiss /
    // connection loss.
    this.publishOpenRequestActivity();
  }

  /** Clear the durable import warnings (the user dismissed the surface). Emits
   *  through the same activity path so listeners re-render without the notice.
   *  A no-op when nothing is collected. */
  dismissOpenWarnings(): void {
    this.clearAllOpenWarnings();
  }

  /** Retry the exact source URL owned by the visible dataset-open failure.
   *  Reading/removal stay atomic inside the controller; only that request is
   *  retired before the replacement is sent. */
  retryFailedOpen(): void {
    if (this.surfacedErrorKind !== "open") return;
    const failed = this.latestFailedOpenRequest();
    if (!failed) return;
    this.openRequests.delete(failed.requestId);
    this.refreshVisibleOpenFailure();
    // A retry retires ONLY the visible failed request. Unlike a fresh manual
    // open, it must not erase an older same-URL sibling that is now revealed.
    this.beginOpenRequest(failed.url);
  }

  /** Dismiss only a dataset-open failure. Other error kinds have independent
   *  recovery signals and must never be hidden by this UI action. */
  dismissFailedOpen(): void {
    if (this.surfacedErrorKind !== "open") return;
    const failed = this.latestFailedOpenRequest();
    if (!failed) return;
    this.openRequests.delete(failed.requestId);
    this.refreshVisibleOpenFailure();
  }

  breakFollow(): void {
    if (this.followTarget === null) return;
    this.setFollowTarget(null);
    this.session.bridge.sendFollow(null);
  }

  /** Start (or stop, with `null`) following a peer's camera. On start,
   *  immediately adopt the target's last known presence so the switch is
   *  instant rather than waiting for their next update. */
  follow(targetId: ClientId | null): void {
    if (targetId === this.myId) return;
    this.setFollowTarget(targetId);
    this.session.bridge.sendFollow(targetId);
    if (targetId === null) return;
    const peer = this.peers.get(targetId);
    if (!peer) return;
    const scene = this.deps.getScene();
    if (!scene) return;
    try {
      const presenceJson = JSON.stringify({
        camera: peer.camera,
        view: peer.view,
        display: peer.display,
      });
      guardedSceneCall("import_presence", scene, () => scene.import_presence(presenceJson));
      if (peer.dataset_order && peer.dataset_settings) {
        try {
          const layerJson = JSON.stringify({
            dataset_order: peer.dataset_order,
            dataset_settings: peer.dataset_settings,
          });
          guardedSceneCall("import_dataset_presence", scene, () =>
            scene.import_dataset_presence(layerJson));
          bumpSettingsGeneration();
          this.deps.bumpLayerSettingsVersion();
        } catch (e) {
          console.warn("Failed to import peer dataset presence:", e);
        }
      }
      syncSceneViewState(scene, this.deps.viewState);
      this.deps.getLoop()?.markInteractiveDirty();
    } catch (e) {
      console.warn("Failed to import peer presence:", e);
    }
  }

  // ---------------------------------------------------------------------
  // Connection-scoped state, mirrored out through events.
  // ---------------------------------------------------------------------

  private setMyId(id: ClientId): void {
    this.myId = id;
    this.deps.events.onSelfIdChanged(id);
  }

  private setFollowTarget(target: ClientId | null): void {
    this.followTarget = target;
    this.deps.events.onFollowTargetChanged(target);
  }

  private setPeersMap(next: Map<ClientId, PresenceState>): void {
    this.peers = next;
    this.deps.events.onPeersChanged(next);
  }

  private updateRemoteActivity(patch: Partial<RemoteDatasetActivity>): void {
    this.remoteActivity = { ...this.remoteActivity, ...patch };
    this.deps.events.onRemoteDatasetActivity(this.remoteActivity);
  }

  /** Publish the bounded request map's aggregate spinner/progress projection.
   * A sibling terminal event cannot clear loading while another request is
   * pending, and progress is deterministic even when callbacks interleave. */
  private publishOpenRequestActivity(): void {
    let latest: PendingOpenRequest | null = null;
    for (const request of this.openRequests.values()) {
      if (request.status !== "pending" || request.progress === null) continue;
      if (latest === null || request.progressOrder > latest.progressOrder) {
        latest = request;
      }
    }
    const loading = Array.from(this.openRequests.values()).some(
      (request) => request.status === "pending",
    );
    const progress = latest?.progress ?? null;
    if (
      this.remoteActivity.loading === loading &&
      this.remoteActivity.progress === progress
    ) return;
    this.updateRemoteActivity({ loading, progress });
  }

  private latestFailedOpenRequest(): FailedOpenRequest | null {
    let latest: FailedOpenRequest | null = null;
    for (const request of this.openRequests.values()) {
      if (request.status !== "failed") continue;
      if (latest === null || request.failureOrder > latest.failureOrder) {
        latest = request;
      }
    }
    return latest;
  }

  private removeFailedOpenRequestsForUrl(url: string): void {
    for (const [requestId, request] of this.openRequests) {
      if (request.status === "failed" && request.url === url) {
        this.openRequests.delete(requestId);
      }
    }
  }

  /** Keep the single banner aligned with the newest unresolved open failure
   * after retry/dismiss/manual supersession. A different active error kind is
   * left alone; if it later recovers, [`clearSurfacedError`] reveals the newest
   * retained open failure rather than losing it. */
  private refreshVisibleOpenFailure(): void {
    if (this.surfacedErrorKind !== "open") return;
    const latest = this.latestFailedOpenRequest();
    if (latest) {
      this.surfaceError("open", latest.error);
    } else {
      this.clearSurfacedError(["open"]);
    }
  }

  private ensurePendingOpenRequest(
    requestId: string,
    url: string,
  ): PendingOpenRequest | null {
    const existing = this.openRequests.get(requestId);
    if (existing) return existing.status === "pending" ? existing : null;
    // Progress frames normally correlate to an outbound request registered in
    // `beginOpenRequest`. Tolerate a reconnect/legacy caller that reaches the
    // handler first, but subject it to the same hard cardinality bound.
    if (this.openRequests.size >= MAX_TRACKED_OPEN_REQUESTS - 1) return null;
    const pending: PendingOpenRequest = {
      status: "pending",
      requestId,
      url,
      sentAt: null,
      progress: null,
      progressOrder: ++this.openActivityOrder,
    };
    this.openRequests.set(requestId, pending);
    return pending;
  }

  private roundTripMs(request: PendingOpenRequest | undefined): number | null {
    if (!request || request.sentAt === null) return null;
    return +(performance.now() - request.sentAt).toFixed(1);
  }

  private resetOpenRequests(): void {
    if (this.openRequests.size === 0) return;
    this.openRequests.clear();
    this.publishOpenRequestActivity();
    this.refreshVisibleOpenFailure();
  }

  /** Record one import warning under the source url that produced it,
   *  preserving every warning already collected (for this source and for
   *  others). An empty/whitespace-only message is ignored (no blank bullet),
   *  and a message already recorded for this source collapses to the existing
   *  entry (identical notices — the same skipped-group notice repeated across
   *  tiles, or replayed on resync — never stack).
   *
   *  Retention is capped at [`MAX_OPEN_WARNINGS`] distinct messages: once the
   *  cap is reached, a further NEW distinct message is not stored but is
   *  counted into [`overflowMessagesByUrl`]. Both source cardinality and exact
   *  overflow identities are capped too. Beyond either safety cap, each report
   *  increments a scalar occurrence count; this deliberately relaxes exact
   *  deduplication rather than allowing hostile metadata to grow memory without
   *  bound. Republishes only when something observable changed. */
  private collectOpenWarning(requestId: string, message: string): void {
    const boundedMessage = boundedWarningMessage(message);
    if (boundedMessage.trim() === "") return;
    const sourceKey = boundedWarningIdentity(requestId);
    if (!this.trackedWarningSources.has(sourceKey)) {
      if (
        this.trackedWarningSources.size >=
        MAX_TRACKED_OPEN_WARNING_SOURCES
      ) {
        // The source itself cannot be retained safely. Preserve a conservative
        // signal, unattributed until the next wholesale dismiss/session reset.
        this.overflowWarnings = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.overflowWarnings + 1,
        );
        this.publishWarnings();
        return;
      }
      this.trackedWarningSources.add(sourceKey);
    }

    const existing = this.warningsByUrl.get(sourceKey);
    const fingerprint = boundedWarningIdentity(message);
    if (existing?.some((warning) => warning.identity === fingerprint)) return;
    let sourceOverflow = this.overflowMessagesByUrl.get(sourceKey);
    if (sourceOverflow?.has(fingerprint)) return;
    if (this.retainedMessages.has(fingerprint)) {
      // Already displayed via another source. Keep a per-source copy so a
      // failed open retires only its own hold on the shared notice, but do not
      // grow the distinct set or the overflow count.
      const retained = { identity: fingerprint, display: boundedMessage };
      if (existing) existing.push(retained);
      else this.warningsByUrl.set(sourceKey, [retained]);
      return;
    }
    const overflowRefs = this.overflowMessageRefCounts.get(fingerprint);
    if (overflowRefs !== undefined) {
      // The text is already counted as overflow via another source. Record
      // this source's hold for correct failure cleanup, without inflating the
      // user-visible distinct-warning total.
      sourceOverflow ??= new Set();
      sourceOverflow.add(fingerprint);
      this.overflowMessagesByUrl.set(sourceKey, sourceOverflow);
      this.overflowMessageRefCounts.set(fingerprint, overflowRefs + 1);
      return;
    }
    if (
      this.retainedMessages.size >= MAX_OPEN_WARNINGS ||
      this.retainedWarningDisplays.has(boundedMessage)
    ) {
      if (
        this.overflowMessageRefCounts.size >=
        MAX_OPEN_WARNING_FINGERPRINTS
      ) {
        // Exact unbounded-stream dedup and a hard memory bound are mutually
        // exclusive. Once the bounded identity index is full, count reports
        // per tracked source without retaining another fingerprint.
        const previous = this.saturatedOverflowByUrl.get(sourceKey) ?? 0;
        const next = Math.min(Number.MAX_SAFE_INTEGER, previous + 1);
        this.saturatedOverflowByUrl.set(sourceKey, next);
        this.overflowWarnings = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.overflowWarnings + (next > previous ? 1 : 0),
        );
        this.publishWarnings();
        return;
      }
      // The display is full of distinct notices; retain the FACT, not the text.
      sourceOverflow ??= new Set();
      sourceOverflow.add(fingerprint);
      this.overflowMessagesByUrl.set(sourceKey, sourceOverflow);
      this.overflowMessageRefCounts.set(fingerprint, 1);
      this.overflowWarnings += 1;
      this.publishWarnings();
      return;
    }
    const retained = { identity: fingerprint, display: boundedMessage };
    if (existing) existing.push(retained);
    else this.warningsByUrl.set(sourceKey, [retained]);
    this.retainedMessages.add(fingerprint);
    this.retainedWarningDisplays.add(boundedMessage);
    this.publishWarnings();
  }

  /** Drop every warning recorded for `requestId` — used when that specific open
   *  fails, so its own notice does not sit beside its error, WITHOUT touching
   *  warnings collected for other sources opened in the same batch. Retires the
   *  source's overflow count too. Republishes only when something was removed. */
  private clearOpenWarningsForRequest(requestId: string): void {
    const sourceKey = boundedWarningIdentity(requestId);
    const removedWarnings = this.warningsByUrl.delete(sourceKey);
    const removedOverflow = this.overflowMessagesByUrl.get(sourceKey);
    if (removedOverflow) {
      for (const fingerprint of removedOverflow) {
        const refs = this.overflowMessageRefCounts.get(fingerprint);
        if (refs === undefined) continue;
        if (refs <= 1) {
          this.overflowMessageRefCounts.delete(fingerprint);
          this.overflowWarnings -= 1;
        } else {
          this.overflowMessageRefCounts.set(fingerprint, refs - 1);
        }
      }
      this.overflowMessagesByUrl.delete(sourceKey);
    }
    const removedSaturated = this.saturatedOverflowByUrl.get(sourceKey) ?? 0;
    if (removedSaturated > 0) {
      this.saturatedOverflowByUrl.delete(sourceKey);
      this.overflowWarnings = Math.max(
        0,
        this.overflowWarnings - removedSaturated,
      );
    }
    const removedSource = this.trackedWarningSources.delete(sourceKey);
    if (!removedWarnings && !removedOverflow && !removedSaturated && !removedSource) return;
    if (removedWarnings) this.rebuildRetainedMessages();
    this.publishWarnings();
  }

  /** Drop every collected warning across all sources — used when the whole
   *  session/connection is gone (disconnect, workspace archived) or the user
   *  dismissed the surface. Republishes only when something was cleared. */
  private clearAllOpenWarnings(): void {
    if (this.warningsByUrl.size === 0 && this.overflowWarnings === 0) return;
    this.warningsByUrl.clear();
    this.retainedMessages.clear();
    this.retainedWarningDisplays.clear();
    this.overflowMessagesByUrl.clear();
    this.overflowMessageRefCounts.clear();
    this.trackedWarningSources.clear();
    this.saturatedOverflowByUrl.clear();
    this.overflowWarnings = 0;
    this.publishWarnings();
  }

  /** Recompute [`retainedMessages`] as the distinct identities currently in
   *  [`warningsByUrl`]. Called after a per-source removal, whose dropped
   *  messages may or may not still be held by another source. Bounded work:
   *  the store never holds more than [`MAX_OPEN_WARNINGS`] distinct messages. */
  private rebuildRetainedMessages(): void {
    this.retainedMessages.clear();
    this.retainedWarningDisplays.clear();
    for (const warnings of this.warningsByUrl.values()) {
      for (const warning of warnings) {
        this.retainedMessages.add(warning.identity);
        this.retainedWarningDisplays.add(warning.display);
      }
    }
  }

  /** Rebuild [`RemoteDatasetActivity.warnings`] from [`warningsByUrl`]: every
   *  source's messages in insertion order, deduplicated across sources so a
   *  notice reported by two opens shows once. The store is bounded to
   *  [`MAX_OPEN_WARNINGS`] distinct display lines, so this projection is bounded
   *  work per call rather than growing with the number of warnings seen. Emits
   *  only when the flattened list OR the overflow count actually changed, so a
   *  duplicate collect or a no-op clear stays silent. */
  private publishWarnings(): void {
    const flattened: string[] = [];
    const seen = new Set<string>();
    for (const warnings of this.warningsByUrl.values()) {
      for (const warning of warnings) {
        if (seen.has(warning.identity)) continue;
        seen.add(warning.identity);
        flattened.push(warning.display);
      }
    }
    const current = this.remoteActivity.warnings;
    const listUnchanged =
      flattened.length === current.length &&
      flattened.every((message, index) => message === current[index]);
    if (listUnchanged && this.overflowWarnings === this.remoteActivity.warningsOverflow) {
      return;
    }
    this.updateRemoteActivity({
      // Reuse the existing array when only the overflow count moved (the common
      // case past the cap): keeps the list's identity stable so nothing
      // downstream re-derives from an unchanged list on every flood frame.
      warnings: listUnchanged ? current : flattened,
      warningsOverflow: this.overflowWarnings,
    });
  }

  /**
   * Show `message` in the single visible error slot, unless a standing
   * error of strictly higher rank holds it (see [`SurfacedErrorKind`] for
   * the ranking rationale). Re-surfacing the identical kind+message is a
   * no-op so an endlessly failing source sets the banner once, not once
   * per failure.
   */
  private surfaceError(
    kind: SurfacedErrorKind,
    message: string,
  ): void {
    if (
      this.surfacedErrorKind !== null &&
      SURFACED_ERROR_RANK[kind] < SURFACED_ERROR_RANK[this.surfacedErrorKind]
    ) {
      return;
    }
    if (
      this.surfacedErrorKind === kind &&
      this.remoteActivity.error === message
    ) return;
    this.surfacedErrorKind = kind;
    this.updateRemoteActivity({ error: message, errorKind: kind });
  }

  /** Retire the visible error if (and only if) its kind is one of `kinds`.
   *  Every kind has exactly one retirement signal wired to this — a
   *  recovery event can never wipe a banner it doesn't own, which is what
   *  keeps fatal banners standing for the life of the page. */
  private clearSurfacedError(kinds: readonly SurfacedErrorKind[]): void {
    if (this.surfacedErrorKind === null) return;
    if (!kinds.includes(this.surfacedErrorKind)) return;
    const fallback = this.latestFailedOpenRequest();
    if (fallback) {
      this.surfacedErrorKind = "open";
      this.updateRemoteActivity({ error: fallback.error, errorKind: "open" });
      return;
    }
    this.surfacedErrorKind = null;
    this.updateRemoteActivity({ error: null, errorKind: null });
  }

  /** Any successful scene mutation (local, remote, or snapshot) disproves
   *  persistent apply death and retires the parse-boundary advisory. A
   *  fatal banner stays: one call slipping through does not un-poison a
   *  trapped wasm instance. */
  private handleSceneCallApplied(): void {
    this.sceneApplyFailureStreak = 0;
    this.clearSurfacedError(["engine", "incompatible"]);
  }

  /**
   * Route a failed scene mutation to the visible error slot by consequence
   * class. A dead scene keeps every JS panel healthy while the canvas stays
   * blank, so silence here would leave nothing for the user to act on:
   *
   * - fatal (trap / borrow poisoning): the engine banner, immediately.
   * - incompatible (parse-boundary rejection, e.g. version skew): a softer
   *   advisory. The scene never executed the command, so this neither
   *   feeds nor resets the death streak — three skewed commands from a
   *   newer peer must not read as an engine failure.
   * - recoverable: counts toward the consecutive-failure streak; the
   *   engine banner appears only once the scene evidently cannot apply
   *   anything (no success since [`SCENE_APPLY_FAILURE_LIMIT`] failures).
   */
  private handleSceneCallFailed(e: unknown): void {
    const cls = classifySceneError(e);
    const message = e instanceof Error ? e.message : String(e);
    if (cls === "incompatible") {
      this.surfaceError(
        "incompatible",
        `Some updates could not be applied because this viewer did not ` +
          `recognize them (${message}). They may come from a newer app ` +
          `version; everything else keeps working.`,
      );
      return;
    }
    this.sceneApplyFailureStreak += 1;
    if (cls !== "fatal" && this.sceneApplyFailureStreak < SCENE_APPLY_FAILURE_LIMIT) {
      return;
    }
    this.surfaceError(
      cls === "fatal" ? "engine-fatal" : "engine",
      `Viewer engine failure: scene updates are no longer being applied ` +
        `(${message}). Reload the page to recover.`,
    );
  }

  /**
   * Emit `onRemoteDocumentChanged` for a live command: synchronous, unless a
   * snapshot-burst emission is already scheduled (the bridge replays pending
   * commands and drains its gap buffer synchronously after `onSnapshot`, all
   * within the flag's window) — then the scheduled emission covers this
   * change too, keeping the whole burst at exactly one signal.
   */
  private notifyRemoteDocumentChanged(): void {
    if (this.docChangedEmitPending) return;
    this.deps.events.onRemoteDocumentChanged();
  }

  /**
   * Schedule ONE `onRemoteDocumentChanged` for a snapshot burst. The bridge
   * hands over the snapshot and then synchronously replays every pending
   * local command through `onCommand`; emitting per change would signal
   * 1 + N times and expose pre-replay document state to the early listeners.
   * A microtask runs after that entire synchronous burst, so the single
   * emission observes post-replay state.
   */
  private scheduleRemoteDocumentChanged(): void {
    if (this.docChangedEmitPending) return;
    this.docChangedEmitPending = true;
    queueMicrotask(() => {
      this.docChangedEmitPending = false;
      if (this.destroyed) return;
      this.deps.events.onRemoteDocumentChanged();
    });
  }

  // ---------------------------------------------------------------------
  // Dataset registration/removal — the single home for `dataset_opened`
  // setup. Both arrival paths (join/resync snapshot, live broadcast) call
  // `ensureDatasetRegistered`; both removal paths (snapshot membership
  // sweep, `remove_dataset` broadcast) call `removeDataset`.
  // ---------------------------------------------------------------------

  private ensureDatasetRegistered(reg: {
    manifest: DatasetManifest;
    fetch: FetchSource;
    /**
     * How to activate a layout after registering the browser-authored
     * derived builders (registration itself is idempotent via lucida-core's
     * RegisterLayout dedupe):
     *  - `"local"` (snapshot): refresh the mirror and adopt the document's
     *    active id without re-broadcasting — a snapshot is a join/repair,
     *    not an edit, so it must not emit commands on behalf of this client.
     *  - `"broadcast"` (live open): `setActive` sends the command so every
     *    peer converges on the opened dataset's default layout.
     */
    layoutActivation:
      | { kind: "local"; activeId: string | null | undefined }
      | { kind: "broadcast" };
  }): void {
    const manifest = reg.manifest;
    const datasetId = manifest.dataset_id;
    validateDatasetChunkAdmission(manifest, reg.fetch);
    if (!this.deps.datasets.has(datasetId)) {
      this.setupFetchPipeline(manifest, reg.fetch);
    } else {
      bridgeLog("setup_fetch_pipeline.skipped_existing", { datasetId });
    }
    const registry = this.session.ensureLayoutRegistry();
    if (!registry) return;
    const sendCmd = (json: string) => this.session.bridge.sendCommand(json);
    for (const spec of derivedBuildersFor(manifest)) {
      registry.register(datasetId, spec, sendCmd);
    }
    if (reg.layoutActivation.kind === "local") {
      registry.refresh(datasetId);
      const activeId = reg.layoutActivation.activeId ?? manifest.default_layout_id;
      if (activeId) registry.setActiveLocal(datasetId, activeId);
    } else {
      const activeId = manifest.default_layout_id ?? manifest.source_layouts[0]?.id;
      if (activeId) registry.setActive(datasetId, activeId, sendCmd);
    }
  }

  private removeDataset(datasetId: string): void {
    this.deps.removeDatasetLocal(datasetId);
    this.session.generatedAvailability.removeDataset(datasetId);
    this.session.ensureLayoutRegistry()?.removeDataset(datasetId);
    // Warnings are collected by source url, not by workspace dataset id, and
    // both removal paths here (the `remove_dataset` broadcast and the snapshot
    // membership sweep) carry only the dataset id — there is no clean mapping
    // back to the source that warned. Clearing wholesale on any removal would
    // drop unrelated datasets' live warnings (and warnings swept in during a
    // resync), so removal leaves the collected warnings alone; they retire on
    // dismiss or connection loss. A warning about a just-removed dataset
    // lingering until dismissed is the accepted, bounded cost.
  }

  private setupFetchPipeline(manifest: DatasetManifest, fetchDesc: FetchSource): void {
    const datasetId = manifest.dataset_id;
    const firstImage = manifest.images[0];
    const channelCount = firstImage?.multiscale.levels[0]?.shape[Axis.C] ?? 1; // [T, C, Z, Y, X]
    const fetchVariant = "Proxied";

    // Shape summary — mirrors the WASM-side `analyze_manifest_shape`
    // counts so a JS-only debugger can spot Collection vs. Single anomalies
    // without enabling the wasm category.
    const entityIds = new Set(manifest.entities.map(e => e.id));
    let nGroups = 0;
    let nTiles = 0;
    let nOrphans = 0;
    for (const e of manifest.entities) {
      if (e.kind === "Group") nGroups++;
      else if (e.kind === "Tile") {
        nTiles++;
        if (e.parent !== null && !entityIds.has(e.parent)) nOrphans++;
      }
    }

    bridgeLog("setup_fetch_pipeline.start", {
      datasetId,
      kind: typeof manifest.kind === "string" ? manifest.kind : Object.keys(manifest.kind ?? {})[0] ?? "unknown",
      fetchVariant,
      nImages: manifest.images.length,
      channelCount,
      nGroups,
      nTiles,
      nOrphans,
      nLayouts: manifest.source_layouts.length,
      defaultLayoutId: manifest.default_layout_id,
    });

    const t0 = performance.now();

    let registeredImages = 0;
    for (const spec of fetchDesc.Proxied.images) {
      this.contentSource.registerImage(spec.image_id, spec.wire_format);
      registeredImages++;
    }
    const t1 = performance.now();

    this.deps.datasets.set(datasetId, {
      id: datasetId,
      name: manifest.name,
      manifest,
      fetch: fetchDesc,
    });
    const t2 = performance.now();

    this.deps.initLayerMaps(datasetId);
    const t3 = performance.now();

    // Ensure per-channel settings exist for all channels.
    // DatasetOpened may only create 1 channel setting (layers.len() = 1),
    // but the real channel count is in the data shape.
    if (channelCount > 1) {
      const scene = this.deps.getScene();
      if (scene) {
        // Touch the last channel to grow the vec via ensure_channel
        const cmd: ViewportCommand = {
          type: "set_channel_visible",
          dataset_id: datasetId,
          channel: channelCount - 1,
          visible: true,
        };
        guardedSceneCall("apply_command", scene, () => scene.apply_command(JSON.stringify(cmd)));
        bumpSettingsGeneration();
      }
    }
    const t4 = performance.now();

    const loop = this.deps.getLoop();
    if (loop) {
      loop.addDataset(datasetId, manifest);
    } else {
      bridgeLog("setup_fetch_pipeline.loop_not_ready", { datasetId });
    }
    const t5 = performance.now();

    if (this.deps.datasets.size === 1) {
      this.deps.setSelectedDatasetId(datasetId);
    }

    this.deps.events.onDatasetsChanged();

    bridgeLog("setup_fetch_pipeline.complete", {
      datasetId,
      registeredImages,
      channelCount,
      totalMs: +(t5 - t0).toFixed(1),
      stepsMs: {
        registerImages: +(t1 - t0).toFixed(2),
        datasetsRefSet: +(t2 - t1).toFixed(2),
        initLayerMaps: +(t3 - t2).toFixed(2),
        setChannelVisible: +(t4 - t3).toFixed(2),
        addDataset: +(t5 - t4).toFixed(2),
      },
    });
  }

  // ---------------------------------------------------------------------
  // Generated-availability bookkeeping.
  // ---------------------------------------------------------------------

  private applyGeneratedAvailabilitySnapshots(
    snapshots: WireGeneratedAvailabilityByDataset,
  ): void {
    for (const [datasetId, snapshot] of Object.entries(snapshots)) {
      this.applyGeneratedAvailabilitySnapshot(datasetId, snapshot);
    }
  }

  private applyGeneratedAvailabilitySnapshot(
    datasetId: string,
    snapshot: WireGeneratedAvailabilitySnapshot,
  ): void {
    this.session.generatedAvailability.applySnapshot(datasetId, snapshot);
    this.refreshRuntimeGeneratedManifest(datasetId);
  }

  private applyGeneratedAvailabilityDelta(
    datasetId: string,
    delta: WireGeneratedAvailabilityDelta,
  ): void {
    this.session.generatedAvailability.applyDelta(datasetId, delta);
    // Per-chunk readiness lives in the generated-availability catalog and the
    // content source. It does not alter dataset geometry. Rebuilding/cloning
    // the full manifest, notifying React, and invalidating renderer residency
    // for every completion made N generated chunks cost O(N * manifest size).
    // Only a level-metadata delta can change the runtime manifest.
    if ((delta.levels?.length ?? 0) > 0) {
      this.refreshRuntimeGeneratedManifest(datasetId);
    }
  }

  private refreshRuntimeGeneratedManifest(datasetId: string): void {
    const entry = this.deps.datasets.get(datasetId);
    if (!entry) return;
    const merged = this.session.generatedAvailability.mergeManifest(datasetId, entry.manifest);
    this.deps.datasets.set(datasetId, { ...entry, manifest: merged });
    const loop = this.deps.getLoop();
    loop?.updateDatasetManifest(datasetId, merged);
    this.deps.events.onDatasetsChanged();
    loop?.markResidencyDirty("generated_availability_update");
  }

  // ---------------------------------------------------------------------
  // Bridge handlers. All synchronous — see the class docs for why.
  // ---------------------------------------------------------------------

  private buildHandlers(): BridgeHandlers {
    return {
      onSnapshot: (_seq, documentJson, snapshotPeers, yourId, generatedAvailability) => {
        try {
          // The scene is obtained first so the guarded load carries it as
          // its subject; the guard makes a fatal load failure (trap,
          // borrow poisoning) surface even though the enclosing catch
          // swallows the throw — a client whose snapshot cannot load is a
          // blank shell otherwise.
          const scene = this.deps.ensureScene();
          guardedSceneCall("load_document", scene, () => scene.load_document(documentJson));
          // Adopt the self id BEFORE any registration work: a
          // `dataset_opened` replayed in the same tick as this snapshot
          // must never read a stale self-id when deriving `isOpener`.
          this.setMyId(yourId);

          const peerMap = new Map<ClientId, PresenceState>();
          for (const peer of snapshotPeers) {
            if (peer.client_id !== yourId) {
              peerMap.set(peer.client_id, peer);
            }
          }
          this.setPeersMap(peerMap);

          this.session.setScene(scene);

          const doc = JSON.parse(documentJson);
          if (doc.manifests) {
            for (const [dsId, manifestWire] of Object.entries(doc.manifests as Record<string, DatasetManifestWire>)) {
              // Resolve the wire encoding (shared multiscale table etc.) up
              // front so everything downstream sees effective per-image
              // metadata.
              const manifest = resolveDatasetManifest(manifestWire);
              // A snapshot carries no fetch source; synthesize a proxied one
              // from the manifest's images. Only consulted when the dataset
              // isn't registered yet — an existing registration keeps the
              // fetch source it was created with.
              const fetchDesc: FetchSource = {
                Proxied: {
                  images: manifest.images.map(img => ({
                    image_id: img.image_id,
                    wire_format: { Raw: { data_type: img.multiscale.data_type } },
                  })),
                },
              };
              this.ensureDatasetRegistered({
                manifest,
                fetch: fetchDesc,
                layoutActivation: {
                  kind: "local",
                  activeId:
                    (doc.active_layout_ids as Record<string, string> | undefined)?.[dsId],
                },
              });
            }
            // A snapshot is authoritative for membership, and this handler
            // also runs mid-session (reconnect, or a server-pushed /
            // requested resync after broadcast loss). Drop any local dataset
            // the document no longer contains — its `remove_dataset`
            // broadcast may be exactly what was lost. A first snapshot sees
            // an empty registry and this is a no-op.
            for (const dsId of Array.from(this.deps.datasets.keys())) {
              if (!(dsId in doc.manifests)) {
                bridgeLog("snapshot.stale_dataset_removed", { datasetId: dsId });
                this.removeDataset(dsId);
              }
            }
          }
          this.applyGeneratedAvailabilitySnapshots(generatedAvailability);

          this.scheduleRemoteDocumentChanged();
          this.deps.events.onDatasetsChanged();
          this.deps.events.onSceneChanged(scene);
          // The session is fully established (WS open + first snapshot
          // applied): an open sent now reliably reaches the server. One-shot
          // sends (the #697 seed open) gate on this signal.
          this.deps.events.onSessionReadyChanged(true);
        } catch (e) {
          console.warn("[Bridge] bad snapshot:", e);
        }
      },
      onCommand: (_seq, commandJson) => {
        try {
          let scene = this.deps.getScene();
          if (!scene) {
            const cmd = JSON.parse(commandJson);
            if (cmd.type === "dataset_opened") {
              scene = this.deps.ensureScene();
            } else {
              return;
            }
          }
          guardedSceneCall("apply_command", scene, () => scene.apply_command(commandJson));
          bumpSettingsGeneration();
          const cmd = JSON.parse(commandJson);
          if (cmd.type === "dataset_opened") {
            this.handleDatasetOpened(cmd, scene);
          }
          if (cmd.type === "remove_dataset") {
            this.removeDataset(cmd.id);
          }
          if (
            cmd.type === "add_annotation" ||
            cmd.type === "remove_annotation" ||
            cmd.type === "add_comment" ||
            cmd.type === "remove_comment"
          ) {
            // A peer dropped/removed a pin, or added/removed a comment on one.
            // WASM authoritative state (pins and their nested threads) was
            // already updated by apply_command above; mark the canvas dirty so
            // the overlay re-projects. The onRemoteDocumentChanged below
            // re-renders the overlay with the new annotation/thread set.
            this.deps.getLoop()?.markInteractiveDirty();
          }
          if (cmd.type === "register_layout" || cmd.type === "set_active_layout") {
            // Inbound layout broadcast: refresh the mirror so peers' changes
            // appear locally. setActiveLocal updates the active id without
            // re-broadcasting (the WASM side already applied via apply_command
            // above). markInteractiveDirty so the GPU canvas re-renders without
            // requiring local user interaction.
            const registry = this.session.ensureLayoutRegistry();
            if (registry && cmd.dataset_id) {
              registry.refresh(cmd.dataset_id);
              if (cmd.type === "set_active_layout" && cmd.layout_id) {
                registry.setActiveLocal(cmd.dataset_id, cmd.layout_id);
              }
              this.deps.getLoop()?.markInteractiveDirty();
            }
          }
          this.notifyRemoteDocumentChanged();
        } catch (e) {
          let cmdType: string | undefined;
          try {
            cmdType = JSON.parse(commandJson)?.type;
          } catch {
            // commandJson itself wasn't valid JSON — fall through with undefined
          }
          // Surfacing already happened through the scene-call guard (the
          // controller observes every guarded mutation); this log adds the
          // command type, which the guard cannot know.
          bridgeLog("apply_command.failed", {
            commandType: cmdType,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
      onAck: () => {
        this.clearSurfacedError(["command"]);
      },
      onNack: ({ code, message, retryable }) => {
        bridgeLog("command.nack", { code, message, retryable });
        this.surfaceError(
          "command",
          `Change was not saved (${code}): ${message}${retryable ? " Try again." : ""}`,
        );
      },
      onBinary: (key, data) => {
        this.contentSource.handleBinary(key, data);
      },
      onPeerJoined: (clientId, presence) => {
        const next = new Map(this.peers);
        next.set(clientId, presence);
        this.setPeersMap(next);
      },
      onPeerLeft: (clientId) => {
        const next = new Map(this.peers);
        next.delete(clientId);
        this.setPeersMap(next);
        if (this.followTarget === clientId) {
          this.setFollowTarget(null);
        }
      },
      onPresenceUpdate: (clientId, camera, view, display) => {
        const existing = this.peers.get(clientId);
        if (existing) {
          const next = new Map(this.peers);
          next.set(clientId, { ...existing, camera, view, display });
          this.setPeersMap(next);
        }
        if (this.followTarget === clientId) {
          const scene = this.deps.getScene();
          if (scene) {
            try {
              const presenceJson = JSON.stringify({ camera, view, display });
              guardedSceneCall("import_presence", scene, () => scene.import_presence(presenceJson));
              syncSceneViewState(scene, this.deps.viewState);
              this.deps.getLoop()?.markInteractiveDirty();
              this.session.bridge.sendPresence(scene.export_presence());
            } catch (e) {
              console.warn("[Bridge] failed to import presence:", e);
            }
          }
        }
      },
      onCursorUpdate: (clientId, position, datasetId) => {
        const existing = this.peers.get(clientId);
        if (!existing) return;
        const next = new Map(this.peers);
        next.set(clientId, {
          ...existing,
          cursor: position,
          cursor_dataset_id: position === null ? null : datasetId,
        });
        this.setPeersMap(next);
      },
      onFollowChanged: (clientId, target) => {
        const existing = this.peers.get(clientId);
        if (existing) {
          const next = new Map(this.peers);
          next.set(clientId, { ...existing, following: target });
          this.setPeersMap(next);
        }
        if (clientId !== this.myId) return;
        // The server steered US (e.g. follow set by another surface):
        // adopt the target's last known presence immediately.
        if (target !== null) {
          const peer = this.peers.get(target);
          const scene = this.deps.getScene();
          if (peer && scene && peer.camera && peer.view && peer.display) {
            try {
              const presenceJson = JSON.stringify({
                camera: peer.camera,
                view: peer.view,
                display: peer.display,
              });
              guardedSceneCall("import_presence", scene, () => scene.import_presence(presenceJson));
              syncSceneViewState(scene, this.deps.viewState);
              this.deps.getLoop()?.markInteractiveDirty();
              this.session.bridge.sendPresence(scene.export_presence());
            } catch (e) {
              console.warn("[Bridge] failed to import presence on steer:", e);
            }
          }
        }
        this.setFollowTarget(target);
      },
      onDatasetPresenceUpdate: (clientId, datasetOrder, datasetSettings) => {
        const existing = this.peers.get(clientId);
        if (existing) {
          const next = new Map(this.peers);
          next.set(clientId, {
            ...existing,
            dataset_order: datasetOrder,
            dataset_settings: datasetSettings,
          });
          this.setPeersMap(next);
        }
        if (this.followTarget === clientId) {
          const scene = this.deps.getScene();
          if (scene) {
            try {
              const json = JSON.stringify({ dataset_order: datasetOrder, dataset_settings: datasetSettings });
              guardedSceneCall("import_dataset_presence", scene, () =>
                scene.import_dataset_presence(json));
              invalidateDisplaySettings(this.deps.getLoop(), "peer_dataset_presence");
              this.deps.bumpLayerSettingsVersion();
            } catch (e) {
              console.warn("[Bridge] failed to import dataset presence:", e);
            }
          }
        }
      },
      onOpenDatasetFailed: (requestId, url, error, diagnostic) => {
        const existing = this.openRequests.get(requestId);
        const pending = existing?.status === "pending" ? existing : undefined;
        const roundTripMs = this.roundTripMs(pending);
        bridgeLog("open_remote_dataset.failed", {
          requestId,
          url,
          error,
          roundTripMs,
          category: diagnostic?.category ?? null,
          code: diagnostic?.code ?? null,
          retryable: diagnostic?.retryable ?? null,
        });
        // This request stops contributing to the aggregate spinner/progress;
        // pending siblings keep it active. The error surfaces through the
        // ranked slot (a fatal engine banner outranks an open failure). Only
        // THIS request's warnings clear — a failed open must not leave its own
        // "opened with a warning" notice beside its error, but a sibling open
        // from the same batch keeps its warnings.
        this.clearOpenWarningsForRequest(requestId);
        if (existing?.status === "failed") return;
        if (
          !existing &&
          this.openRequests.size >= MAX_TRACKED_OPEN_REQUESTS - 1
        ) {
          return;
        }
        const failed: FailedOpenRequest = {
          status: "failed",
          requestId,
          url: pending?.url ?? url,
          error,
          failureOrder: ++this.openActivityOrder,
        };
        this.openRequests.set(requestId, failed);
        this.publishOpenRequestActivity();
        // A newly arrived failure competes for the ranked banner, but sibling
        // success/progress never calls the error retirement path.
        this.surfaceError("open", error);
        this.deps.getSavedViewHooks()?.onOpenDatasetFailed(failed.url, error);
      },
      onDatasetOpenProgress: (requestId: string, url: string, diagnostic: DatasetOpenProgressDiagnostic) => {
        bridgeLog("open_remote_dataset.progress_state", {
          url,
          requestId,
          stage: diagnostic.stage,
          message: diagnostic.message,
          warning: diagnostic.warning === true,
        });
        const existing = this.openRequests.get(requestId);
        // A terminal failure wins over any delayed progress frame for the same
        // request. In particular, it must not be resurrected as pending.
        if (existing?.status === "failed") return;
        if (diagnostic.warning === true) {
          // A non-fatal import concern (e.g. the sampled-label-discovery
          // notice) must outlive the transient progress line, so record it in
          // the durable list keyed by its request id. EVERY warning frame is
          // collected regardless of which open it belongs to — datasets opened
          // together in one pass must each surface their warnings, and a frame
          // arriving after a later open began must not be dropped.
          this.collectOpenWarning(requestId, diagnostic.message);
        }
        if (diagnostic.stage === "complete") {
          // Complete is request-correlated and immediately precedes the
          // success envelope on the ordered socket. Retire only THIS pending
          // request; durable warnings survive completion.
          const pending = existing?.status === "pending" ? existing : undefined;
          if (pending) this.openRequests.delete(requestId);
          bridgeLog("open_remote_dataset.completed", {
            requestId,
            url: pending?.url ?? url,
            roundTripMs: this.roundTripMs(pending),
          });
          this.publishOpenRequestActivity();
          return;
        }
        const pending = this.ensurePendingOpenRequest(requestId, url);
        if (!pending) return;
        pending.progress = diagnostic.message;
        pending.progressOrder = ++this.openActivityOrder;
        this.publishOpenRequestActivity();
      },
      onOpenDatasetSucceeded: (requestId, url, seq, summary) => {
        // Bridge has already normalized this requester's compatibility
        // `opened` payload into the sequenced DatasetOpened handler above.
        // This callback owns only request completion/status, so registration
        // remains a single path and the large payload is never applied twice.
        const existing = this.openRequests.get(requestId);
        const pending = existing?.status === "pending" ? existing : undefined;
        bridgeLog("open_remote_dataset.succeeded", {
          requestId,
          url,
          seq,
          roundTripMs: this.roundTripMs(pending),
          datasetId: summary.workspace_dataset_id,
          imageCount: summary.image_count,
          entityCount: summary.entity_count,
        });
        // First terminal callback wins. A stale success must not erase a
        // failure already recorded for this request, and success for one open
        // never touches any sibling failure.
        if (pending) {
          this.openRequests.delete(requestId);
          this.publishOpenRequestActivity();
        }
      },
      onGeneratedAvailabilityUpdate: (datasetId, deltaJson) => {
        try {
          const delta = JSON.parse(deltaJson) as WireGeneratedAvailabilityDelta;
          this.applyGeneratedAvailabilityDelta(datasetId, delta);
        } catch (e) {
          console.warn("[Bridge] bad generated_availability_update:", e);
        }
      },
      onGeneratedChunkStatus: (datasetId, imageId, key, status, failure, message) => {
        this.contentSource.handleChunkStatus(datasetId, imageId, key, status, failure, message);
      },
      onSourceChunkStatus: (datasetId, imageId, key, status, failure, message) => {
        this.contentSource.handleSourceChunkStatus(
          datasetId,
          imageId,
          key,
          status,
          failure,
          message,
        );
      },
      onConnected: () => {
        // Chunk failures accumulated against a dropped transport (or its
        // reconnect window) say nothing about the restored connection.
        this.cpuCache.resetChunkFailureStreak();
        this.deps.events.onConnectedChanged(true);
      },
      onWorkspaceArchived: () => {
        this.deps.events.onConnectedChanged(false);
        this.deps.events.onSessionReadyChanged(false);
        // The workspace is gone: drop every collected warning with the spinner
        // so no notice about the archived workspace's opens lingers.
        this.clearAllOpenWarnings();
        this.resetOpenRequests();
        this.contentSource.rejectAll();
        this.deps.events.onWorkspaceArchived();
      },
      onDisconnect: () => {
        // The transport dropped: re-arm both readiness signals so a
        // reconnect's `onopen` + fresh snapshot must re-establish them before
        // gated work (e.g. a still-pending seed open) fires. Every collected
        // warning clears too — they described opens on the dead connection, and
        // the reconnect's snapshot is the fresh truth.
        this.deps.events.onConnectedChanged(false);
        this.deps.events.onSessionReadyChanged(false);
        this.clearAllOpenWarnings();
        this.resetOpenRequests();
        this.contentSource.rejectAll();
      },
    };
  }

  /** The `dataset_opened` document arm: registration via the shared path,
   *  then the auto-fit/applier policies that only a LIVE open triggers — a
   *  snapshot registration deliberately skips these (a join/repair is not a
   *  user-initiated open). Request completion is intentionally absent here:
   *  the requester and peers share this path, while only requester callbacks
   *  carry the request id needed to retire pending state. */
  private handleDatasetOpened(
    cmd: {
      type: string;
      manifest: DatasetManifestWire;
      fetch: FetchSourceWire;
      opener_client_id?: number | null;
    },
    scene: WasmScene,
  ): void {
    const fetchVariant = "Proxied";
    const kind = typeof cmd.manifest?.kind === "string"
      ? cmd.manifest.kind
      : Object.keys(cmd.manifest?.kind ?? {})[0] ?? "unknown";
    bridgeLog("open_remote_dataset.received", {
      datasetId: cmd.manifest?.dataset_id,
      kind,
      fetchVariant,
      nImages: cmd.manifest?.images?.length ?? 0,
    });
    this.session.setScene(scene);
    // Resolve the wire encoding (shared multiscale/wire-format tables) up
    // front so everything downstream sees effective per-image metadata.
    const manifest = resolveDatasetManifest(cmd.manifest);
    const fetch = resolveFetchSource(cmd.fetch);
    const datasetId = manifest.dataset_id;
    this.ensureDatasetRegistered({
      manifest,
      fetch,
      layoutActivation: { kind: "broadcast" },
    });

    // DatasetOpened is shared document traffic: peers receive it without
    // owning the request, and the requester receives it before the correlated
    // success callback. It must never mutate local pending/failure state.
    this.deps.events.onSceneChanged(scene);
    // Auto-fit the camera to the freshly-opened dataset so it lands
    // centered and fully in view (2D + 3D). `dataset_opened` is a
    // BROADCAST that runs on every co-present peer, so we frame ONLY for
    // the client that opened it: the server stamps the broadcast with
    // `opener_client_id` and we fit only when it matches our own id.
    // (See `shouldAutoFitOnOpen` for the full gate.) We additionally
    // suppress the two camera-owning cases:
    //   - !restoreOwnsDatasetOpen: a saved/last view that requested THIS dataset
    //     owns the camera (#700);
    //   - !following: a follower stays glued to the leader's camera.
    // The server sends the `your_id` snapshot as a client's FIRST message,
    // before any CommandBroadcast, so by the time a `dataset_opened` is
    // handled `myId` holds our real id — id 0 is a legitimate first-client
    // id here, NOT a sentinel to exclude (the single-user opener is often
    // client 0). When the broadcast carries no opener id (older server),
    // `isOpener` is false and no one fits — fail-safe, never a stray
    // reframe. The fit itself is best-effort and wrapped so a failure
    // (e.g. a dataset with no bounds yet) can never break the open.
    const isOpener = isOpenerOf(cmd.opener_client_id, this.myId);
    const restoreOwnsDatasetOpen =
      this.deps.getSavedViewHooks()?.ownsDatasetOpen?.(datasetId) ?? false;
    const following = this.followTarget !== null;
    if (shouldAutoFitOnOpen(cmd.type, { isOpener, restoreOwnsDatasetOpen, following })) {
      try {
        // Untyped call: the wasm export may predate the regenerated
        // bindings, so reach it structurally rather than via the type.
        (
          scene as unknown as {
            fit_camera_to_dataset_bounds?: (id: string) => void;
          }
        ).fit_camera_to_dataset_bounds?.(datasetId);
        this.deps.getLoop()?.markInteractiveDirty("auto_fit_on_open");
        bridgeLog("auto_fit_on_open.applied", { datasetId });
      } catch (e) {
        bridgeLog("auto_fit_on_open.failed", {
          datasetId,
          error: String(e),
        });
      }
    } else {
      bridgeLog("auto_fit_on_open.suppressed", {
        datasetId,
        isOpener,
        restoreOwnsDatasetOpen,
        following,
      });
    }
    // Notify the saved-view applier (if registered) so its pending-open
    // promise resolves. Safe even when the open wasn't applier-initiated —
    // `notifyDatasetOpened` is a no-op for ids it doesn't know.
    this.deps.getSavedViewHooks()?.onDatasetOpened(datasetId);
  }
}
