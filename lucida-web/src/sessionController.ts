import type { WasmScene } from "lucida-core";
import {
  Bridge,
  bridgeLog,
  type BridgeHandlers,
  type ClientId,
  type CommandRejection,
  type DatasetImportWarning,
  type DatasetOpenProgressDiagnostic,
  type PresenceState,
  workspaceSocketUrl,
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
import { readCacheKnobs } from "./pipeline/fetch/cacheKnobs.ts";
import { pageDeviceBudgets } from "./deviceBudget.ts";
import type {
  WireGeneratedAvailabilityByDataset,
  WireGeneratedAvailabilityDelta,
  WireGeneratedAvailabilitySnapshot,
} from "./pipeline/generatedAvailability.ts";
import { derivedBuildersFor } from "./pipeline/layoutBuilders.ts";
import type { WireAssetCatalog } from "./pipeline/assetCatalog.ts";
import { Session } from "./session.ts";
import type { RenderLoop } from "./renderLoop.ts";
import { AVAILABILITY_UPDATE_SOURCE, invalidateDisplaySettings, requestRender } from "./invalidation.ts";
import { shouldAutoFitOnOpen, isOpenerOf } from "./hooks/autoFit.ts";
import { classifySceneError, guardedSceneCall, observeSceneCalls } from "./sceneGuard.ts";
import { traceRecorder } from "./trace/recorder.ts";
import { watchStream } from "./trace/watchStream.ts";

/** Consecutive scene-mutation failures, from any origin, before the error
 *  becomes user-visible. One bad command only logs; the streak resets on the
 *  next successful mutation. Fatal engine errors skip the streak. */
const SCENE_APPLY_FAILURE_LIMIT = 3;

/** Cap on distinct import warnings retained in
 *  [`RemoteDatasetActivity.warnings`]. One open can emit a unique notice per
 *  malformed member (thousands for a large collection), and keeping them all
 *  stalls the tab. Past the cap, warnings are counted in
 *  [`RemoteDatasetActivity.warningsOverflow`] instead of stored. */
export const MAX_OPEN_WARNINGS = 50;

/**
 * User-visible errors competing for the single
 * [`RemoteDatasetActivity`]`.error` slot. A candidate never displaces a
 * standing error of strictly higher rank ([`SURFACED_ERROR_RANK`]). Each kind
 * retires only through its own signal:
 *
 * - `engine-fatal`: the wasm scene is dead. Never cleared; only a reload recovers.
 * - `engine`: mutations keep failing. Cleared by the next successful mutation.
 * - `open`: a dataset open failed. Cleared by a new open attempt or its progress.
 * - `data`: chunk delivery keeps failing. Cleared by the next delivered chunk.
 * - `incompatible`: inbound commands refused at the parse boundary (e.g.
 *   version skew). Advisory; cleared by the next successful mutation.
 *
 * `open`, `data`, and `incompatible` share the lowest rank and resolve
 * last-writer-wins, so a stale one-shot banner can't mask a live condition
 * that started after it.
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
  /** `true` while a saved or last view is mid-restore, through its camera step.
   * Suppresses auto-fit-on-open so the restore's camera wins. Optional so
   * older callers stay compatible. */
  isInProgress?: () => boolean;
}

/** Aggregate open-remote-dataset UI state (spinner / error banner / progress
 *  line). The controller owns the transitions; consumers only render it. */
export interface RemoteDatasetActivity {
  loading: boolean;
  error: string | null;
  progress: string | null;
  /** Non-fatal import warnings, kept after each open completes (unlike
   *  `progress`). Deduplicated across sources so datasets opened together in
   *  one pass each surface their warnings. Cleared by [`dismissOpenWarnings`]
   *  and on connection loss; a failed open clears only its own. Capped at
   *  [`MAX_OPEN_WARNINGS`]. */
  warnings: readonly string[];
  /** Distinct warnings beyond the [`MAX_OPEN_WARNINGS`] cap, so a banner can
   *  show "+N more". Retired with `warnings`. */
  warningsOverflow: number;
}

/**
 * Notifications toward the controller's owner (in the app, `useBridge`, which
 * mirrors them into React state). Values flow one way, out of the controller.
 *
 * Every callback fires synchronously from a bridge handler or controller
 * method, so listeners see events in protocol order. The exception is
 * `onRemoteDocumentChanged` for a snapshot burst; see its doc.
 *
 * `onPeersChanged` hands over a fresh `Map` each time, so the owner can rely
 * on identity inequality for change detection.
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
   *  A live command emits synchronously. A snapshot is followed by the
   *  bridge's synchronous replay of pending local commands, so the controller
   *  coalesces the whole burst into one emission from a microtask. Emitting
   *  earlier would let a listener read the scene before the replays restored
   *  the author's own edits. */
  onRemoteDocumentChanged: () => void;
  onWorkspaceArchived: () => void;
  /** The server refused one of this client's document commands; the bridge
   *  is already fetching the snapshot that undoes it. */
  onCommandRejected: (reason: CommandRejection) => void;
  /** Each dataset's import warnings, by dataset id, from the server's dataset
   *  health. A fresh map each time; datasets without warnings are absent. */
  onDatasetImportWarnings: (warnings: ReadonlyMap<string, readonly DatasetImportWarning[]>) => void;
}

/**
 * Everything the controller needs from its host. All functions must be safe
 * to call for the controller's whole lifetime; host values that change over
 * time (scene, render loop, callback registries) are reached through getters
 * so the controller always sees the current one.
 */
/** A canvas size in device pixels, and the device pixel ratio behind it. */
export interface ViewportSize {
  width: number;
  height: number;
  pixelRatio: number;
}

export interface SessionControllerDeps {
  workspaceId: string;
  /** Construct-or-return the WasmScene (see `useWasmScene.ensureScene`). */
  ensureScene: () => WasmScene;
  /** Current scene, or null before the first snapshot/open creates it. */
  getScene: () => WasmScene | null;
  /** Current render loop, or null while no viewer is mounted. */
  getLoop: () => RenderLoop | null;
  /**
   * The canvas's size in device pixels, or null before it is laid out. The
   * scene otherwise learns its size only from render ticks, and none has run
   * before the first snapshot or open, so a fit or an imported view would
   * frame the scene's construction default.
   */
  getViewportSize: () => ViewportSize | null;
  /**
   * Shared dataset registry. The host owns the Map's identity; the controller
   * is its only writer. `destroy()` clears it so a successor controller
   * re-registers every fetch pipeline against its own content source.
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
  events: SessionControllerEvents;
}

/**
 * Owner of the per-workspace collaboration stack: builds the DecodePool →
 * ProxiedContentSource → CpuCache → Bridge → Session chain, wires every bridge
 * handler, and holds the connection-scoped state they need.
 *
 * Single-shot: the constructor connects and `destroy()` (idempotent) tears it
 * all down. A host that needs a session again builds a fresh controller.
 * Framework-free so the session doesn't care how often a UI re-renders.
 *
 * Handlers run their effects inline: the bridge replays pending local commands
 * through `onCommand` synchronously right after `onSnapshot` returns, and
 * deferring anything would let a replayed command see pre-snapshot state.
 */
export class SessionController {
  readonly session: Session;

  private readonly deps: SessionControllerDeps;
  private readonly contentSource: ProxiedContentSource;

  private destroyed = false;
  /** Server-assigned id from the snapshot. 0 is a valid id, not a sentinel;
   *  the snapshot is always the first message, so the initial 0 is never used
   *  for opener matching. */
  private myId: ClientId = 0;
  private followTarget: ClientId | null = null;
  /** Co-present peers, self excluded. Replace-on-write: every mutation builds
   *  and emits a new Map. */
  private peers = new Map<ClientId, PresenceState>();
  private remoteActivity: RemoteDatasetActivity = {
    loading: false,
    error: null,
    progress: null,
    warnings: [],
    warningsOverflow: 0,
  };
  /** Last `open_remote_dataset` send time (performance.now() ms), for a
   *  round-trip on receipt. Approximate with concurrent opens, since each
   *  send overwrites it. */
  private lastOpenSendTime: number | null = null;
  /** Import warnings grouped by source url. Never reset per open, so datasets
   *  opened together in one pass each keep their warnings; grouping lets a
   *  failed open retire only its own. At most [`MAX_OPEN_WARNINGS`] distinct
   *  messages across all sources; further ones count into [`overflowByUrl`]. */
  private readonly warningsByUrl = new Map<string, string[]>();
  /** Distinct messages in [`warningsByUrl`], kept in lock-step with it. Makes
   *  the cap check O(1), and stops a message already shown via one source from
   *  counting as overflow when another source reports it. */
  private readonly retainedMessages = new Set<string>();
  /** Per-source count of distinct warnings dropped at the cap, so a failed
   *  open retires exactly its own overflow. */
  private readonly overflowByUrl = new Map<string, number>();
  /** Sum of [`overflowByUrl`], surfaced as
   *  [`RemoteDatasetActivity.warningsOverflow`]. */
  private overflowWarnings = 0;
  /** Import warnings by dataset id, as dataset health last reported them.
   *  Health is asked because open progress reaches only the opener and only
   *  on a fresh open, while a peer's open and a workspace restored after a
   *  server restart import with warnings just the same. */
  private importWarnings: ReadonlyMap<string, readonly DatasetImportWarning[]> = new Map();
  /** Datasets whose import warnings already went to the open-warning list,
   *  so a later refresh cannot bring back a notice the user dismissed. */
  private readonly announcedImportWarnings = new Set<string>();
  /** Numbers each health request, so a reply that a newer one overtook is
   *  dropped. */
  private importWarningsRequest = 0;
  /** True while a coalesced `onRemoteDocumentChanged` is scheduled for a
   *  snapshot burst. Commands applied meanwhile (replays, gap-buffer drain)
   *  are covered by that one emission. */
  private docChangedEmitPending = false;
  /** Consecutive scene-mutation failures reported by the scene-call guard;
   *  reset by each successful mutation. See [`handleSceneCallFailed`]. */
  private sceneApplyFailureStreak = 0;
  /** Kind of the displayed `remoteActivity.error`, or null. Only
   *  [`surfaceError`] and [`clearSurfacedError`] write the error field, which
   *  keeps the two in lock-step. */
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
    const budgets = pageDeviceBudgets();
    this.cpuCache = new CpuCache(this.contentSource, decodePool, {
      mainBudgetBytes: budgets.cpuMainBytes,
      overviewBudgetBytes: budgets.cpuOverviewBytes,
      proxyBudgetBytes: budgets.cpuProxyBytes,
      maxBytesInFlight: budgets.cpuBytesInFlight,
      // Knobs the trace driver left in browser storage, read once so the
      // cache starts under them.
      ...readCacheKnobs(),
      // Without this, failing deliveries present as a silently stalling
      // canvas. Store failures after a successful open (e.g. revoked access)
      // arrive as per-chunk `source_chunk_status` rejections; undecodable
      // bytes arrive via the decode boundary.
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
    const bridge = new Bridge(this.buildHandlers(), workspaceSocketUrl(deps.workspaceId));
    this.session = new Session({
      bridge,
      contentSource: this.contentSource,
      cpuCache: this.cpuCache,
      decodePool,
    });
    // Every module reports scene mutations through the guard, so a solo
    // session's engine failure surfaces like a collaborative one's. Reports
    // are scoped to this session's scene: sessions can briefly coexist during
    // a workspace switch, and another session's success must not reset this
    // one's streak or retire its banner.
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
   * Tear down the stack (via `Session.destroy`, which is idempotent and so
   * composes with the workspace-archived path) and clear the shared dataset
   * registry. Stale entries would make a successor skip registration against
   * its new content source, leaving every chunk fetch unroutable.
   *
   * Emits no events; the owner resets its own mirrors.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopObservingSceneCalls();
    // The stream's socket is going with the session, so the toggle goes off
    // rather than pointing a successor controller's watcher at a dead bridge.
    watchStream.detach();
    this.session.destroy();
    this.deps.datasets.clear();
    this.lastOpenSendTime = null;
    this.warningsByUrl.clear();
    this.retainedMessages.clear();
    this.overflowByUrl.clear();
    this.overflowWarnings = 0;
    this.importWarnings = new Map();
    this.announcedImportWarnings.clear();
  }

  // Outbound surface: user-initiated sends.

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
    // A new open supersedes a previous open's failure. Other error kinds keep
    // their own retirement signals, so an unrelated open must not mask them.
    this.clearSurfacedError(["open"]);
    // Warnings are not reset here: several opens can go out in one
    // synchronous pass, and a reset would erase earlier opens' warnings
    // before their progress frames arrive.
    this.updateRemoteActivity({
      loading: true,
      progress: "dataset open request sent",
    });
    // The open's bracket starts here, at the send, and the run with it: the
    // metadata reads the server is about to perform are most of a cold
    // open, and they all happen before the first chunk exists.
    traceRecorder.noteOpenSent(this.session.bridge.sendOpenRemoteDataset(url));
  }

  /** Clear the import warnings after the user dismissed them. No-op when
   *  nothing is collected. */
  dismissOpenWarnings(): void {
    this.clearAllOpenWarnings();
  }

  /** The scene, created on first use, sized to the canvas the user sees. */
  private ensureScene(): WasmScene {
    const scene = this.deps.ensureScene();
    this.assertViewport(scene);
    return scene;
  }

  /** Tell the scene the canvas's measured size, which it may not know until
   *  a render tick: a fit frames it, and an imported view fits its region to
   *  it. */
  private assertViewport(scene: WasmScene): void {
    const viewport = this.deps.getViewportSize();
    if (viewport) scene.set_viewport(viewport.width, viewport.height, viewport.pixelRatio);
  }

  private importPresence(scene: WasmScene, presenceJson: string): void {
    this.assertViewport(scene);
    guardedSceneCall("import_presence", scene, () => scene.import_presence(presenceJson));
  }

  breakFollow(): void {
    if (this.followTarget === null) return;
    this.setFollowTarget(null);
    this.session.bridge.sendFollow(null);
  }

  /** Start (or stop, with `null`) following a peer's camera. On start,
   *  immediately adopt what the target has reported so the switch is instant
   *  rather than waiting for their next update. A part it hasn't reported
   *  stays as it is here until its first update arrives. */
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
      if (peer.camera && peer.view && peer.display) {
        const presenceJson = JSON.stringify({
          camera: peer.camera,
          view: peer.view,
          display: peer.display,
        });
        this.importPresence(scene, presenceJson);
      }
      if (peer.dataset_order && peer.dataset_settings) {
        try {
          const layerJson = JSON.stringify({
            dataset_order: peer.dataset_order,
            dataset_settings: peer.dataset_settings,
          });
          guardedSceneCall("import_dataset_presence", scene, () =>
            scene.import_dataset_presence(layerJson));
          invalidateDisplaySettings(this.deps.getLoop(), "follow_dataset_presence");
          this.deps.bumpLayerSettingsVersion();
        } catch (e) {
          console.warn("Failed to import peer dataset presence:", e);
        }
      }
      requestRender(this.deps.getLoop(), "follow_presence");
    } catch (e) {
      console.warn("Failed to import peer presence:", e);
    }
  }

  // Connection-scoped state, mirrored out through events.

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

  /** Record one import warning under its source url. Blank messages are
   *  ignored, and a message already recorded for this source collapses (the
   *  same notice repeats across tiles and on resync).
   *
   *  Past [`MAX_OPEN_WARNINGS`] distinct messages, a new one is counted into
   *  [`overflowByUrl`] instead of stored. A message already shown via any
   *  source never counts as overflow. Both checks are O(1), so collecting N
   *  warnings stays O(N). */
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
      // The display is full; keep the count, not the text.
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

  /** Drop every warning and the overflow count recorded for `url`, when that
   *  open fails, so its notice doesn't sit beside its error. Other sources in
   *  the same batch keep theirs. */
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

  /** Drop every collected warning: on disconnect, archive, or user dismiss. */
  private clearAllOpenWarnings(): void {
    if (this.warningsByUrl.size === 0 && this.overflowWarnings === 0) return;
    this.warningsByUrl.clear();
    this.retainedMessages.clear();
    this.overflowByUrl.clear();
    this.overflowWarnings = 0;
    this.publishWarnings();
  }

  /** Recompute [`retainedMessages`] after a per-source removal, since another
   *  source may still hold a dropped message. Bounded by [`MAX_OPEN_WARNINGS`]. */
  private rebuildRetainedMessages(): void {
    this.retainedMessages.clear();
    for (const messages of this.warningsByUrl.values()) {
      for (const message of messages) this.retainedMessages.add(message);
    }
  }

  /** Rebuild [`RemoteDatasetActivity.warnings`] from [`warningsByUrl`] in
   *  insertion order, deduplicated across sources. Emits only when the list or
   *  the overflow count changed. */
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
      // Reuse the array when only the overflow count moved (the common case
      // past the cap), so nothing downstream re-derives on every flood frame.
      warnings: listUnchanged ? current : flattened,
      warningsOverflow: this.overflowWarnings,
    });
  }

  /**
   * Show `message` in the error slot unless a standing error of strictly
   * higher rank holds it. The identical kind and message is a no-op, so an
   * endlessly failing source sets the banner once.
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

  /** Retire the visible error only if its kind is in `kinds`. A recovery
   *  event can't wipe a banner it doesn't own, which keeps fatal banners up
   *  for the life of the page. */
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
   * Route a failed scene mutation to the error slot by class. A dead scene
   * leaves every JS panel healthy and the canvas blank, so it must surface.
   *
   * - fatal (trap, borrow poisoning): the engine banner, immediately.
   * - incompatible (parse-boundary rejection): an advisory that neither feeds
   *   nor resets the streak, so skewed commands from a newer peer don't read
   *   as an engine failure.
   * - recoverable: counts toward [`SCENE_APPLY_FAILURE_LIMIT`].
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

  /** Emit `onRemoteDocumentChanged` for a live command, unless a snapshot-burst
   *  emission is already scheduled to cover it. */
  private notifyRemoteDocumentChanged(): void {
    if (this.docChangedEmitPending) return;
    this.deps.events.onRemoteDocumentChanged();
  }

  /** Schedule one `onRemoteDocumentChanged` for a snapshot burst. The
   *  microtask runs after the bridge's synchronous replay of pending
   *  commands, so the emission sees post-replay state. */
  private scheduleRemoteDocumentChanged(): void {
    if (this.docChangedEmitPending) return;
    this.docChangedEmitPending = true;
    queueMicrotask(() => {
      this.docChangedEmitPending = false;
      if (this.destroyed) return;
      this.deps.events.onRemoteDocumentChanged();
    });
  }

  // Dataset registration and removal. Snapshot and live broadcast both call
  // `ensureDatasetRegistered`; the snapshot sweep and `remove_dataset` both
  // call `removeDataset`.

  private ensureDatasetRegistered(reg: {
    manifest: DatasetManifest;
    fetch: FetchSource;
    /** Initial asset catalog for the JS-side mirror (WASM already holds it
     *  via `load_document` / `apply_command`). */
    catalog: WireAssetCatalog | null | undefined;
    /**
     * How to activate a layout after registering the derived builders
     * (registration is idempotent):
     *  - `"local"` (snapshot): adopt the document's active id without
     *    broadcasting. A snapshot is a join or repair, not an edit.
     *  - `"broadcast"` (live open): `setActive` sends the command so every
     *    peer converges on the default layout.
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
    // Open warnings are keyed by source url and removal carries only the
    // dataset id, so they stay until dismiss or connection loss. Clearing
    // wholesale would drop other datasets' live warnings.
    if (this.importWarnings.has(datasetId)) {
      const next = new Map(this.importWarnings);
      next.delete(datasetId);
      this.importWarnings = next;
      this.deps.events.onDatasetImportWarnings(next);
    }
  }

  /** Ask the server's dataset health for every dataset's import warnings.
   *  The first time a dataset reports any, they also join the open-warning
   *  list, as a fresh open's do. Best-effort: a failed request leaves the
   *  last answer standing. */
  private refreshImportWarnings(): void {
    const request = ++this.importWarningsRequest;
    this.session.bridge.requestDatasetHealth().then(
      (datasets) => {
        if (this.destroyed || request !== this.importWarningsRequest) return;
        const next = new Map<string, readonly DatasetImportWarning[]>();
        for (const health of datasets) {
          const warnings = health.import_warnings ?? [];
          if (warnings.length === 0) continue;
          const datasetId = health.workspace_dataset_id;
          next.set(datasetId, warnings);
          if (this.announcedImportWarnings.has(datasetId)) continue;
          this.announcedImportWarnings.add(datasetId);
          for (const warning of warnings) {
            this.collectOpenWarning(health.source_url ?? datasetId, warning.message);
          }
        }
        this.importWarnings = next;
        this.deps.events.onDatasetImportWarnings(next);
      },
      (error: unknown) => {
        bridgeLog("dataset_health.import_warnings_failed", { error: String(error) });
      },
    );
  }

  private setupFetchPipeline(manifest: DatasetManifest, fetchDesc: FetchSource): void {
    const datasetId = manifest.dataset_id;
    const firstImage = manifest.images[0];
    const channelCount = firstImage?.multiscale.levels[0]?.shape[Axis.C] ?? 1; // [T, C, Z, Y, X]
    const fetchVariant = Object.keys(fetchDesc as object)[0] ?? "unknown";

    // Mirrors the wasm-side `analyze_manifest_shape` counts so a JS-only
    // debugger can spot Collection vs. Single anomalies without enabling the
    // wasm category.
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
      // Labels carry their own image (distinct id, integer dtype) outside
      // `images`, so register them for label overlay fetches. Wire format
      // comes from the label's declared dtype (e.g. Uint32).
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
        invalidateDisplaySettings(this.deps.getLoop(), "channel_settings_grown");
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
    this.refreshRuntimeGeneratedManifest(datasetId, snapshot);
  }

  private applyGeneratedAvailabilityDelta(
    datasetId: string,
    delta: WireGeneratedAvailabilityDelta,
  ): void {
    this.session.generatedAvailability.applyDelta(datasetId, delta);
    this.refreshRuntimeGeneratedManifest(datasetId, delta);
  }

  private refreshRuntimeGeneratedManifest(
    datasetId: string,
    change: WireGeneratedAvailabilityDelta,
  ): void {
    const entry = this.deps.datasets.get(datasetId);
    if (!entry) return;
    const loop = this.deps.getLoop();
    // Only level geometry reaches the manifest, and a replaced manifest
    // replans, so a change that carries chunk statuses alone keeps the one
    // the page has.
    if (change.levels?.length) {
      const merged = this.session.generatedAvailability.mergeManifest(datasetId, entry.manifest);
      this.deps.datasets.set(datasetId, { ...entry, manifest: merged });
      loop?.updateDatasetManifest(datasetId, merged);
    }
    this.session.cpuCache.noteGeneratedAvailability(datasetId, change.chunks ?? []);
    this.deps.events.onDatasetsChanged();
    loop?.markResidencyDirty(AVAILABILITY_UPDATE_SOURCE);
  }

  // Bridge handlers. All synchronous; see the class doc.

  private buildHandlers(): BridgeHandlers {
    return {
      onSnapshot: (_seq, documentJson, snapshotPeers, yourId, generatedAvailability) => {
        try {
          // The guarded load carries the scene as its subject, so a fatal
          // load failure still surfaces though the catch below swallows the
          // throw. Otherwise a client whose snapshot can't load is a blank shell.
          const scene = this.ensureScene();
          guardedSceneCall("load_document", scene, () => scene.load_document(documentJson));
          // Adopt the self id before any registration: a `dataset_opened`
          // replayed in this tick must not read a stale id for `isOpener`.
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
              // Resolve the wire encoding up front so everything downstream
              // sees effective per-image metadata.
              const manifest = resolveDatasetManifest(manifestWire);
              // A snapshot carries no fetch source, so synthesize a proxied
              // one. Only used when the dataset isn't registered yet.
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
            // A snapshot is authoritative for membership and also arrives
            // mid-session (reconnect, resync after broadcast loss). Drop any
            // local dataset it no longer contains; the `remove_dataset`
            // broadcast may be what was lost.
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
          // The session is established (socket open, first snapshot applied),
          // so an open sent now reaches the server. One-shot sends such as
          // the seed open gate on this signal.
          this.deps.events.onSessionReadyChanged(true);
          this.refreshImportWarnings();
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
              scene = this.ensureScene();
            } else {
              return;
            }
          }
          guardedSceneCall("apply_command", scene, () => scene.apply_command(commandJson));
          // Covers the overlay re-projecting a peer's annotation and the
          // planner re-reading a peer's layout switch.
          invalidateDisplaySettings(this.deps.getLoop(), "remote_command");
          const cmd = JSON.parse(commandJson);
          if (cmd.type === "dataset_opened") {
            this.handleDatasetOpened(cmd, scene);
          }
          if (cmd.type === "remove_dataset") {
            this.removeDataset(cmd.id);
          }
          if (cmd.type === "register_layout" || cmd.type === "set_active_layout") {
            // Refresh the mirror so peers' layout changes appear locally.
            // setActiveLocal doesn't re-broadcast; apply_command already ran.
            const registry = this.session.ensureLayoutRegistry();
            if (registry && cmd.dataset_id) {
              registry.refresh(cmd.dataset_id);
              if (cmd.type === "set_active_layout" && cmd.layout_id) {
                registry.setActiveLocal(cmd.dataset_id, cmd.layout_id);
              }
            }
          }
          this.notifyRemoteDocumentChanged();
        } catch (e) {
          let cmdType: string | undefined;
          try {
            cmdType = JSON.parse(commandJson)?.type;
          } catch {
            // commandJson wasn't valid JSON; log with an undefined type.
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
      onCommandRejected: (reason) => this.deps.events.onCommandRejected(reason),
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
              this.importPresence(scene, presenceJson);
              requestRender(this.deps.getLoop(), "follow_presence");
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
        // The server steered this client (e.g. follow set by another
        // surface): adopt the target's last known presence now.
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
              this.importPresence(scene, presenceJson);
              requestRender(this.deps.getLoop(), "follow_presence");
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
      onOpenDatasetFailed: (requestId, url, error) => {
        bridgeLog("open_remote_dataset.failed", { url, error });
        // A failed open closes its bracket like any other. Its metadata
        // rows already arrived on the timing ticker, and they are the ones
        // most worth having.
        traceRecorder.noteOpenSettled(requestId);
        // Spinner and progress stop; the error goes through the ranked slot.
        // Only this source's warnings clear, so a sibling open from the same
        // batch keeps its own.
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
          // A non-fatal concern must outlive the transient progress line.
          // Every warning frame is collected, whichever open it belongs to,
          // so datasets opened together each surface theirs.
          this.collectOpenWarning(url, diagnostic.message);
        }
        if (diagnostic.stage === "complete") {
          traceRecorder.noteOpenSettled(requestId);
          // Clear the transient spinner and progress only; warnings survive
          // completion.
          this.updateRemoteActivity({ loading: false, progress: null });
          return;
        }
        // Progress of a fresh open retires only a previous open's failure.
        // Engine and data banners have their own recovery signals.
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
      onSourceChunkStatus: (datasetId, imageId, key, status, message, failure) => {
        this.contentSource.handleSourceChunkStatus(
          datasetId,
          imageId,
          key,
          status,
          message,
          failure,
        );
      },
      onConnected: (generation) => {
        // Chunk failures accumulated against a dropped transport (or its
        // reconnect window) say nothing about the restored connection.
        this.cpuCache.resetChunkFailureStreak();
        // Correlation labels are per connection: the counter restarts here
        // and the generation goes on every row minted from now on.
        this.contentSource.resetConnection(generation);
        // A run can span two sockets and only the browser can say so. The
        // server sees a close and a stranger, and drops what it buffered.
        traceRecorder.noteConnected(generation);
        // Attaching also turns the toggle off: the server forgot this page's
        // stream when the old connection closed, and nobody has asked for one
        // on this socket.
        watchStream.attach(this.session.bridge);
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
        // Re-arm both readiness signals so a reconnect's `onopen` and fresh
        // snapshot must re-establish them before gated work (e.g. a pending
        // seed open) fires. Warnings described opens on the dead connection,
        // so they clear too.
        this.deps.events.onConnectedChanged(false);
        this.deps.events.onSessionReadyChanged(false);
        this.clearAllOpenWarnings();
        this.updateRemoteActivity({ loading: false, progress: null });
        this.contentSource.rejectAll();
        // Start of the gap the reconnect will close. Declared here rather
        // than inferred from a silence, because a silent socket and a dead
        // one look identical from the rows.
        traceRecorder.noteDisconnected();
        watchStream.detach();
      },
    };
  }

  /** The live `dataset_opened` arm: shared registration, then the policies
   *  only a live open triggers (loading clear, auto-fit, applier notification).
   *  A snapshot skips them, since a join or repair is not a user open. */
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
    // Auto-fit only on the client that opened the dataset: `dataset_opened`
    // runs on every peer, and the server stamps `opener_client_id`. Also
    // suppressed while a saved view restores its camera and while following.
    // Id 0 is a real id here since the snapshot arrives first; a missing
    // opener id fits no one. Best-effort, so a failed fit can't break the open.
    const isOpener = isOpenerOf(cmd.opener_client_id, this.myId);
    const restoreInProgress =
      this.deps.getSavedViewHooks()?.isInProgress?.() ?? false;
    const following = this.followTarget !== null;
    if (shouldAutoFitOnOpen(cmd.type, { isOpener, restoreInProgress, following })) {
      try {
        this.assertViewport(scene);
        // Untyped call: the wasm export may predate the regenerated
        // bindings, so reach it structurally rather than via the type.
        (
          scene as unknown as {
            fit_camera_to_dataset_bounds?: (id: string) => void;
          }
        ).fit_camera_to_dataset_bounds?.(datasetId);
        requestRender(this.deps.getLoop(), "auto_fit_on_open");
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
    // Resolve the saved-view applier's pending open. Safe for opens it didn't
    // start: `notifyDatasetOpened` ignores unknown ids.
    this.deps.getSavedViewHooks()?.onDatasetOpened(datasetId);
    this.refreshImportWarnings();
  }
}
