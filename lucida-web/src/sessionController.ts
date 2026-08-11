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
import type { WireAssetCatalog } from "./pipeline/assetCatalog.ts";
import { Session } from "./session.ts";
import type { RenderLoop } from "./renderLoop.ts";
import { bumpSettingsGeneration } from "./tickCommon.ts";
import { invalidateDisplaySettings } from "./invalidation.ts";
import { syncSceneViewState, type SceneViewStateSetters } from "./hooks/sceneViewState.ts";
import { shouldAutoFitOnOpen, isOpenerOf } from "./hooks/autoFit.ts";
import { classifySceneError, guardedSceneCall, observeSceneCalls } from "./sceneGuard.ts";
import { traceRecorder } from "./trace/recorder.ts";

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
 * - `open`: a dataset open failed. Cleared when a new open attempt (or its
 *   progress) supersedes it.
 * - `data`: chunk delivery keeps failing. Cleared by the next delivered
 *   (fetched AND decoded) chunk.
 * - `incompatible`: inbound commands were refused at the parse boundary
 *   (e.g. version skew with a peer) while the scene stays healthy.
 *   Advisory only; cleared by the next successful mutation.
 *
 * `open`, `data`, and `incompatible` share the lowest rank and resolve by
 * last-writer-wins. Ranking any of them above the others would let a stale
 * one-shot banner mask a live, ongoing condition — e.g. a standing open
 * failure hiding a delivery-failure streak that began afterwards, leaving
 * the stalling canvas unexplained. Each kind still retires only through
 * its own signal, and `data`/`incompatible` re-emit while their condition
 * persists, so the newest actionable signal wins the slot without losing
 * anything durable.
 */
type SurfacedErrorKind = "engine-fatal" | "engine" | "open" | "data" | "incompatible";

const SURFACED_ERROR_RANK: Record<SurfacedErrorKind, number> = {
  "engine-fatal": 3,
  "engine": 2,
  "open": 1,
  "data": 1,
  "incompatible": 1,
};

/** Callback surface the SavedView applier registers into so it sees the
 * relevant lifecycle events without the session layer importing applier
 * types directly. Optional: when absent, the controller skips the call. */
export interface SavedViewBridgeHooks {
  onDatasetOpened: (datasetId: string) => void;
  onOpenDatasetFailed: (url: string, error: string) => void;
  /** `true` while a saved/last view is mid-restore (start of apply through its
   * camera step). The controller consults this to suppress auto-fit-on-open so
   * a restore's camera wins (#700). Optional so older callers stay compatible. */
  isInProgress?: () => boolean;
}

/** Aggregate open-remote-dataset UI state (spinner / error banner / progress
 *  line). The controller owns the transitions; consumers only render it. */
export interface RemoteDatasetActivity {
  loading: boolean;
  error: string | null;
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
  /** How many further distinct warnings occurred beyond the ones retained in
   *  `warnings` (the [`MAX_OPEN_WARNINGS`] cap). Zero unless a flood exceeded
   *  the cap; lets a banner render a "+N more" affordance so a bounded display
   *  never hides that more warnings happened. Retired by the same signals as
   *  `warnings`. */
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
 * re-armable (the instance-per-mount resolution).
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
    progress: null,
    warnings: [],
    warningsOverflow: 0,
  };
  /** Last `open_remote_dataset` send timestamp (performance.now() ms). Used
   *  to derive a round-trip on receipt. Approximate when concurrent opens
   *  are in flight — overwritten by each send. */
  private lastOpenSendTime: number | null = null;
  /** Non-fatal import warnings grouped by the source url that produced them
   *  (the `url` every `onDatasetOpenProgress` frame carries). Collection is
   *  session-level and never reset per open, so datasets opened together in
   *  one synchronous pass (multi-seed workspace creation, source-url view
   *  restores) each contribute their warnings instead of the last open's reset
   *  erasing the rest. Grouping by source lets a failed open retire only its
   *  own warnings while sibling opens' warnings stand. The observable
   *  [`RemoteDatasetActivity.warnings`] is the flattened, deduplicated
   *  projection of this map (see [`publishWarnings`]). Bounded: no more than
   *  [`MAX_OPEN_WARNINGS`] distinct messages are retained across all sources —
   *  further distinct ones are counted into [`overflowByUrl`] instead. */
  private readonly warningsByUrl = new Map<string, string[]>();
  /** The distinct messages currently retained in [`warningsByUrl`] (its
   *  cross-source dedup, materialized). Consulted on collect for O(1)
   *  membership and size so the cap decision does not rescan the store, and so
   *  a message already shown via one source is never miscounted as overflow
   *  when a second source reports it. Kept in lock-step with the store. */
  private readonly retainedMessages = new Set<string>();
  /** Per-source count of distinct warnings dropped once the retention cap was
   *  reached (the source produced them but they are not stored). Keyed by
   *  source url so a failed open retires exactly its own overflow alongside its
   *  retained warnings, leaving siblings' counts intact. Summed into
   *  [`overflowWarnings`]. */
  private readonly overflowByUrl = new Map<string, number>();
  /** Running total of [`overflowByUrl`] — how many distinct warnings occurred
   *  beyond the retained cap. Surfaced as
   *  [`RemoteDatasetActivity.warningsOverflow`] so the cap bounds the DISPLAY
   *  without ever dropping the fact that more warnings happened. */
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
    this.lastOpenSendTime = null;
    this.warningsByUrl.clear();
    this.retainedMessages.clear();
    this.overflowByUrl.clear();
    this.overflowWarnings = 0;
  }

  // ---------------------------------------------------------------------
  // Outbound surface (user-initiated sends).
  // ---------------------------------------------------------------------

  sendCommand(json: string): void {
    this.session.bridge.sendCommand(json);
  }

  sendCursor(position: [number, number] | null): void {
    this.session.bridge.sendCursor(position);
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
    this.lastOpenSendTime = performance.now();
    bridgeLog("open_remote_dataset.loading_start", { url });
    // A new open attempt supersedes a previous open's failure. Other error
    // kinds keep their own retirement signals (delivery recovery, apply
    // recovery, never for fatal) — an unrelated open must not mask them.
    this.clearSurfacedError(["open"]);
    // Collected warnings are NOT reset here: several opens can be issued in one
    // synchronous pass (multi-seed workspace creation, source-url view
    // restores), and resetting per open would erase every earlier open's
    // warnings before its progress frames arrived. Each source's warnings are
    // retired by their own signal instead — that open failing, or a dismiss /
    // connection loss.
    this.updateRemoteActivity({
      loading: true,
      progress: "dataset open request sent",
    });
    this.session.bridge.sendOpenRemoteDataset(url);
  }

  /** Clear the durable import warnings (the user dismissed the surface). Emits
   *  through the same activity path so listeners re-render without the notice.
   *  A no-op when nothing is collected. */
  dismissOpenWarnings(): void {
    this.clearAllOpenWarnings();
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

  /** Record one import warning under the source url that produced it,
   *  preserving every warning already collected (for this source and for
   *  others). An empty/whitespace-only message is ignored (no blank bullet),
   *  and a message already recorded for this source collapses to the existing
   *  entry (identical notices — the same skipped-group notice repeated across
   *  tiles, or replayed on resync — never stack).
   *
   *  Retention is capped at [`MAX_OPEN_WARNINGS`] distinct messages: once the
   *  cap is reached, a further NEW distinct message is not stored but is
   *  counted into [`overflowByUrl`], so a flood (one distinct notice per
   *  malformed member of a large collection) leaves the store bounded and the
   *  observable list capped while the overflow count preserves the fact that
   *  more warnings occurred. A message already shown (via this or another
   *  source) is never counted as overflow — it collapses as before. Both the
   *  store growth and the cap decision are O(1) here, so collecting N warnings
   *  is O(N), never O(N²). Republishes only when something observable changed. */
  private collectOpenWarning(url: string, message: string): void {
    if (message.trim() === "") return;
    const existing = this.warningsByUrl.get(url);
    if (existing?.includes(message)) return;
    if (this.retainedMessages.has(message)) {
      // Already displayed via another source. Keep a per-source copy so a
      // failed open retires only its own hold on the shared notice, but do not
      // grow the distinct set or the overflow count.
      if (existing) existing.push(message);
      else this.warningsByUrl.set(url, [message]);
      return;
    }
    if (this.retainedMessages.size >= MAX_OPEN_WARNINGS) {
      // The display is full of distinct notices; retain the FACT, not the text.
      this.overflowByUrl.set(url, (this.overflowByUrl.get(url) ?? 0) + 1);
      this.overflowWarnings += 1;
      this.publishWarnings();
      return;
    }
    if (existing) existing.push(message);
    else this.warningsByUrl.set(url, [message]);
    this.retainedMessages.add(message);
    this.publishWarnings();
  }

  /** Drop every warning recorded for `url` — used when that specific open
   *  fails, so its own notice does not sit beside its error, WITHOUT touching
   *  warnings collected for other sources opened in the same batch. Retires the
   *  source's overflow count too. Republishes only when something was removed. */
  private clearOpenWarningsForUrl(url: string): void {
    const removedWarnings = this.warningsByUrl.delete(url);
    const removedOverflow = this.overflowByUrl.get(url);
    if (removedOverflow !== undefined) {
      this.overflowWarnings -= removedOverflow;
      this.overflowByUrl.delete(url);
    }
    if (!removedWarnings && removedOverflow === undefined) return;
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
    this.overflowByUrl.clear();
    this.overflowWarnings = 0;
    this.publishWarnings();
  }

  /** Recompute [`retainedMessages`] as the distinct messages currently in
   *  [`warningsByUrl`]. Called after a per-source removal, whose dropped
   *  messages may or may not still be held by another source. Bounded work:
   *  the store never holds more than [`MAX_OPEN_WARNINGS`] distinct messages. */
  private rebuildRetainedMessages(): void {
    this.retainedMessages.clear();
    for (const messages of this.warningsByUrl.values()) {
      for (const message of messages) this.retainedMessages.add(message);
    }
  }

  /** Rebuild [`RemoteDatasetActivity.warnings`] from [`warningsByUrl`]: every
   *  source's messages in insertion order, deduplicated across sources so a
   *  notice reported by two opens shows once. The store is bounded to
   *  [`MAX_OPEN_WARNINGS`] distinct messages, so this projection is bounded
   *  work per call rather than growing with the number of warnings seen. Emits
   *  only when the flattened list OR the overflow count actually changed, so a
   *  duplicate collect or a no-op clear stays silent. */
  private publishWarnings(): void {
    const flattened: string[] = [];
    const seen = new Set<string>();
    for (const messages of this.warningsByUrl.values()) {
      for (const message of messages) {
        if (seen.has(message)) continue;
        seen.add(message);
        flattened.push(message);
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
    extra?: Partial<Omit<RemoteDatasetActivity, "error">>,
  ): void {
    if (
      this.surfacedErrorKind !== null &&
      SURFACED_ERROR_RANK[kind] < SURFACED_ERROR_RANK[this.surfacedErrorKind]
    ) {
      return;
    }
    if (this.surfacedErrorKind === kind && this.remoteActivity.error === message) return;
    this.surfacedErrorKind = kind;
    this.updateRemoteActivity({ ...extra, error: message });
  }

  /** Retire the visible error if (and only if) its kind is one of `kinds`.
   *  Every kind has exactly one retirement signal wired to this — a
   *  recovery event can never wipe a banner it doesn't own, which is what
   *  keeps fatal banners standing for the life of the page. */
  private clearSurfacedError(kinds: readonly SurfacedErrorKind[]): void {
    if (this.surfacedErrorKind === null) return;
    if (!kinds.includes(this.surfacedErrorKind)) return;
    this.surfacedErrorKind = null;
    this.updateRemoteActivity({ error: null });
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
      { loading: false, progress: null },
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
    /** Initial asset catalog for the JS-side mirror (WASM already holds it
     *  via `load_document` / `apply_command`). */
    catalog: WireAssetCatalog | null | undefined;
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
    if (!this.deps.datasets.has(datasetId)) {
      this.setupFetchPipeline(manifest, reg.fetch);
    } else {
      bridgeLog("setup_fetch_pipeline.skipped_existing", { datasetId });
    }
    // Mirror the initial catalog into the JS-side AssetCatalog so Planning's
    // snapshot view stays consistent with WASM.
    this.session.ensureAssetCatalog()?.applyInitial(datasetId, reg.catalog ?? { entries: [] });

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
    this.session.ensureAssetCatalog()?.removeDataset(datasetId);
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
    const fetchVariant = Object.keys(fetchDesc as object)[0] ?? "unknown";

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
    if ("Proxied" in fetchDesc) {
      for (const spec of fetchDesc.Proxied.images) {
        this.contentSource.registerImage(spec.image_id, spec.wire_format);
        registeredImages++;
      }
      // Labels carry their OWN image (distinct id + integer dtype) and are
      // kept out of `images`, so register them separately so their chunks
      // are fetchable when a label overlay requests them. The server serves
      // a label image by its own id; wire format is derived from the
      // label's declared dtype (e.g. Uint32).
      for (const label of manifest.labels ?? []) {
        this.contentSource.registerImage(label.image.image_id, {
          Raw: { data_type: label.image.multiscale.data_type },
        });
        registeredImages++;
      }
    } else {
      bridgeLog("setup_fetch_pipeline.fetch_variant_unsupported", {
        datasetId,
        fetchVariant,
      });
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
    this.refreshRuntimeGeneratedManifest(datasetId);
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
                catalog: doc.asset_catalogs?.[dsId] ?? { entries: [] },
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
      onAck: () => {},
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
      onCursorUpdate: (clientId, position) => {
        const existing = this.peers.get(clientId);
        if (!existing) return;
        const next = new Map(this.peers);
        next.set(clientId, { ...existing, cursor: position });
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
      onOpenDatasetFailed: (url, error) => {
        bridgeLog("open_remote_dataset.failed", { url, error });
        // Spinner/progress always stop; the error surfaces through the ranked
        // slot (a fatal engine banner outranks an open failure). Only THIS
        // source's warnings clear — a failed open must not leave its own
        // "opened with a warning" notice beside its error, but a sibling open
        // from the same batch keeps its warnings.
        this.clearOpenWarningsForUrl(url);
        this.updateRemoteActivity({ loading: false, progress: null });
        this.surfaceError("open", error);
        this.deps.getSavedViewHooks()?.onOpenDatasetFailed(url, error);
      },
      onDatasetOpenProgress: (requestId: string, url: string, diagnostic: DatasetOpenProgressDiagnostic) => {
        bridgeLog("open_remote_dataset.progress_state", {
          url,
          requestId,
          stage: diagnostic.stage,
          message: diagnostic.message,
          warning: diagnostic.warning === true,
        });
        if (diagnostic.warning === true) {
          // A non-fatal import concern (e.g. the sampled-label-discovery
          // notice) must outlive the transient progress line, so record it in
          // the durable list keyed by its source url. EVERY warning frame is
          // collected regardless of which open it belongs to — datasets opened
          // together in one pass must each surface their warnings, and a frame
          // arriving after a later open began must not be dropped.
          this.collectOpenWarning(url, diagnostic.message);
        }
        if (diagnostic.stage === "complete") {
          // Clear the transient spinner/progress only; the durable warnings
          // survive completion — that is the whole point of collecting them.
          this.updateRemoteActivity({ loading: false, progress: null });
          return;
        }
        // Progress of a fresh open retires only a previous open's failure.
        // Engine/data banners have their own recovery signals — and a
        // fatal banner in particular must never be wiped by an unrelated
        // open making progress.
        this.clearSurfacedError(["open"]);
        this.updateRemoteActivity({
          loading: true,
          progress: diagnostic.message,
        });
      },
      onAssetCatalogUpdate: (datasetId, deltaJson) => {
        try {
          const delta = JSON.parse(deltaJson);
          this.session.ensureAssetCatalog()?.applyDelta(datasetId, delta);
        } catch (e) {
          console.warn("[Bridge] bad asset_catalog_update:", e);
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
      onGeneratedChunkStatus: (datasetId, imageId, key, status, message) => {
        this.contentSource.handleChunkStatus(datasetId, imageId, key, status, message);
      },
      onSourceChunkStatus: (datasetId, imageId, key, status, message) => {
        this.contentSource.handleSourceChunkStatus(datasetId, imageId, key, status, message);
      },
      onConnected: (generation) => {
        // Chunk failures accumulated against a dropped transport (or its
        // reconnect window) say nothing about the restored connection.
        this.cpuCache.resetChunkFailureStreak();
        // Correlation labels are per connection: the counter restarts here
        // and the generation goes on every row minted from now on.
        this.contentSource.resetConnection(generation);
        this.deps.events.onConnectedChanged(true);
      },
      onTimingBatch: (batch, generation) => {
        traceRecorder.ingestServerBatch(batch, generation);
      },
      onWorkspaceArchived: () => {
        this.deps.events.onConnectedChanged(false);
        this.deps.events.onSessionReadyChanged(false);
        // The workspace is gone: drop every collected warning with the spinner
        // so no notice about the archived workspace's opens lingers.
        this.clearAllOpenWarnings();
        this.updateRemoteActivity({ loading: false, progress: null });
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
        this.updateRemoteActivity({ loading: false, progress: null });
        this.contentSource.rejectAll();
      },
    };
  }

  /** The `dataset_opened` broadcast arm: registration via the shared path,
   *  then the open-reaction policies (loading clear, auto-fit, applier
   *  notification) that only a LIVE open triggers — a snapshot registration
   *  deliberately skips these (a join/repair is not a user-initiated open). */
  private handleDatasetOpened(
    cmd: {
      type: string;
      manifest: DatasetManifestWire;
      fetch: FetchSourceWire;
      catalog?: WireAssetCatalog | null;
      opener_client_id?: number | null;
    },
    scene: WasmScene,
  ): void {
    const fetchVariant = typeof cmd.fetch === "string"
      ? cmd.fetch
      : Object.keys(cmd.fetch ?? {})[0] ?? "unknown";
    const kind = typeof cmd.manifest?.kind === "string"
      ? cmd.manifest.kind
      : Object.keys(cmd.manifest?.kind ?? {})[0] ?? "unknown";
    const sendTime = this.lastOpenSendTime;
    const roundTripMs = sendTime !== null
      ? +(performance.now() - sendTime).toFixed(1)
      : null;
    this.lastOpenSendTime = null;
    bridgeLog("open_remote_dataset.received", {
      datasetId: cmd.manifest?.dataset_id,
      kind,
      fetchVariant,
      nImages: cmd.manifest?.images?.length ?? 0,
      roundTripMs,
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
      catalog: cmd.catalog ?? { entries: [] },
      layoutActivation: { kind: "broadcast" },
    });

    this.updateRemoteActivity({ loading: false, progress: null });
    bridgeLog("open_remote_dataset.loading_clear", {
      datasetId,
      reason: "success",
    });
    this.deps.events.onSceneChanged(scene);
    // Auto-fit the camera to the freshly-opened dataset so it lands
    // centered and fully in view (2D + 3D). `dataset_opened` is a
    // BROADCAST that runs on every co-present peer, so we frame ONLY for
    // the client that opened it: the server stamps the broadcast with
    // `opener_client_id` and we fit only when it matches our own id.
    // (See `shouldAutoFitOnOpen` for the full gate.) We additionally
    // suppress the two camera-owning cases:
    //   - !restoreInProgress: a saved/last view restoring its camera
    //     wins (#700);
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
    const restoreInProgress =
      this.deps.getSavedViewHooks()?.isInProgress?.() ?? false;
    const following = this.followTarget !== null;
    if (shouldAutoFitOnOpen(cmd.type, { isOpener, restoreInProgress, following })) {
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
        restoreInProgress,
        following,
      });
    }
    // Notify the saved-view applier (if registered) so its pending-open
    // promise resolves. Safe even when the open wasn't applier-initiated —
    // `notifyDatasetOpened` is a no-op for ids it doesn't know.
    this.deps.getSavedViewHooks()?.onDatasetOpened(datasetId);
  }
}
