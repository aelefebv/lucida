/** Pull-based render loop: coalesces chunk arrivals into a single RAF tick. */
import type { DatasetManifest } from "./manifestTypes.ts";
import type { TickContext, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";
import { RESIDENCY_RENDER_INTERVAL_MS } from "./renderLoopTypes.ts";
import { TickWake } from "./invalidation.ts";
import type { SceneEpochs } from "./pipeline/epochs.ts";
import { debugLog } from "./debug/logging.ts";
import { type SliceState, createSliceState, tickSlice, clearSliceForDataset, clearSliceForMembers } from "./slicePath.ts";
import { type VolumeState, createVolumeState, tickVolume, clearVolumeForDataset, clearVolumeForMembers, resetVolumeState } from "./volumePath.ts";
import { TickCoordinator } from "./pipeline/tickCoordinator.ts";
import { Uploader } from "./pipeline/upload/uploader.ts";
import { configStore } from "./pipeline/planning/configStore.ts";

import { identityMatrix } from "./pipeline/upload/coldState/identity.ts";
import type { Session } from "./session.ts";
import { type MinimapState, createMinimapState, tickMinimapOverview, tickMinimap, clearMinimapForDataset, invalidateMinimapOverview, forgetMinimapOverviewUploads, forgetMinimapOverviewsOf } from "./minimapPath.ts";
import { traceRecorder, type TraceEnvironment } from "./trace/recorder.ts";
import { createSettleState, evaluateSettle, settleSignal, type SettleOutcome, type SettleState } from "./pipeline/settle.ts";
import { failedChunkReport, summarizeFailedChunks } from "./pipeline/failedChunks.ts";
import { PointEvent, type CacheWarmth, type InputKind, type Outstanding, type RunConditions } from "./trace/types.ts";
import type { FrameCaptureResult } from "./renderer/workerProtocol.ts";
import { readCanvasColors } from "./renderer/renderClient.ts";
import { subscribeAppearance } from "./theme/appearance.ts";
import { AdaptiveResolution, cappedPixelRatioScale } from "./renderResolution.ts";
import { wakeFrames } from "./frameClock.ts";
import { AutoContrastFitter, type AutoContrastListener } from "./pipeline/autoContrast.ts";

// Re-exported so imports of these types from the render loop keep working.
export type { DatasetEntry, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";

export interface LucidaCaptureReadyState {
  ready: boolean;
  reason: string;
  /** What a capture waits for: a settled or stalled view, never one still settling. */
  settle: SettleOutcome;
  frameCount: number;
  at: number;
  mode: "slice" | "volume";
  datasetCount: number;
  canvasWidth: number;
  canvasHeight: number;
}

declare global {
  interface Window {
    __lucidaCaptureReady?: LucidaCaptureReadyState;
  }
}

/**
 * The ids the CPU cache holds a dataset's entries under: each entity's, and
 * each label's image id, which a label's chunks are requested under. Worker
 * member ids add a channel suffix, so they reach neither. An entry left
 * behind outlives the dataset, and a reopened dataset, which keeps its ids,
 * finds it marked as delivered.
 */
export function cacheIdsOf(manifest: DatasetManifest | undefined, memberIds: readonly string[]): string[] {
  const ids = new Set(memberIds);
  for (const entity of manifest?.entities ?? []) ids.add(entity.id);
  for (const label of manifest?.labels ?? []) ids.add(label.image.image_id);
  return [...ids];
}

export class RenderLoop implements TraceEnvironment {
  private session: Session;
  private datasets: Map<string, { manifest: DatasetManifest }>;
  private client: RenderLoopOptions["client"];
  private canvas: HTMLCanvasElement;
  private mode: "slice" | "volume";

  private interactiveDirty = true;
  private residencyDirty = false;
  /** What has dirtied the loop since the tick before; the tick tells the recorder. */
  private readonly wake = new TickWake();
  private lastResidencyRenderTime = 0;
  private rafId: number | null = null;
  private unsubs = new Map<string, () => void>();

  // Debug instrumentation (gated on the "render" category).
  // Per-(kind,source) emit throttling for `render_loop.dirty_set`. A
  // burst of identical calls within DIRTY_EMIT_INTERVAL_MS collapses to
  // one log + a `suppressedSince` count.
  private dirtyEmitState = new Map<string, { lastEmit: number; pending: number }>();
  private static readonly DIRTY_EMIT_INTERVAL_MS = 1000;
  // `render_loop.residency_throttled` aggregation. Counts how many
  // residency renders the throttle gate suppressed since the last emit.
  private throttleSkipPending = 0;
  private lastThrottleEmit = Number.NEGATIVE_INFINITY;
  private static readonly THROTTLE_EMIT_INTERVAL_MS = 1000;
  private renderedFrameCount = 0;
  /** Main-thread time of the last tick, for the trace's frame-time reading. */
  private lastFrameTimeUs = 0;
  /**
   * Reused across every publication. The predicate is evaluated once per
   * tick, and steady-state allocation would show in the trace as GC stalls.
   */
  private settleState: SettleState = createSettleState();

  private sliceState: SliceState = createSliceState();
  private volumeState: VolumeState = createVolumeState();
  private minimapState: MinimapState = createMinimapState();
  /**
   * Upload coordinator. Owns telemetry, cold/hot-state emission,
   * dispatch, worker-feedback parsing, and worker resource cleanup.
   * Constructed alongside the TickCoordinator so `client.onChunkResidency`
   * / `client.onWantedSetDelta` callbacks wire directly here.
   */
  private uploader = new Uploader();
  private tickCoordinator = new TickCoordinator(this.uploader);
  private readonly autoContrast = new AutoContrastFitter();
  private autoContrastListener: AutoContrastListener | null = null;
  private cpuCacheUnsub: () => void;
  private gpuStatusUnsub: () => void = () => {};
  private configStoreUnsub: () => void;
  private appearanceUnsub: () => void;
  private settleUnsub: () => void;

  private _renderScale = 1.0;
  /** Lowers the render resolution while a gesture's frames run long. */
  private readonly resolution = new AdaptiveResolution();
  private resolutionRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RenderLoopOptions) {
    this.session = opts.session;
    this.datasets = new Map();
    for (const [id, entry] of opts.datasets) {
      this.datasets.set(id, { manifest: entry.manifest });
    }
    this.client = opts.client;
    this.canvas = opts.canvas;
    this.mode = opts.mode;
    this.cpuCacheUnsub = this.session.cpuCache.subscribe(() => {
      this.setDirty("residency", "cache_subscribe");
    });
    // Bridge planning-config tweaks (the dev-controls surface) into the
    // render loop. The orchestrator separately invalidates its own
    // epoch cache from a configStore subscription; this listener just
    // ensures a frame happens promptly so the user sees the change.
    this.configStoreUnsub = configStore.subscribe(() => {
      this.setDirty("interactive", "planning_config_changed");
    });
    // The worker cannot read styles, so the loop sends it the canvas colors
    // before its first frame and again after every appearance change.
    this.client.setCanvasColors(readCanvasColors());
    this.appearanceUnsub = subscribeAppearance(() => {
      this.client.setCanvasColors(readCanvasColors());
      // The minimap caches its overview and overlay until their inputs
      // change, and the colors are not among those inputs.
      invalidateMinimapOverview(this.minimapState);
      this.setDirty("interactive", "appearance_changed");
    });
    this.publishCaptureReady(false, "initializing");
    // A capture reads the outcome off the capture-ready state, and a run that
    // stops making progress ends as stalled, with what the page waits on.
    this.settleUnsub = settleSignal.subscribe((outcome) => {
      if (typeof window !== "undefined" && window.__lucidaCaptureReady) {
        window.__lucidaCaptureReady.settle = outcome;
      }
      if (outcome === "stalled") traceRecorder.closeRun("stalled", settleSignal.stallReason);
    });
    // The render loop is the one place that holds the canvas, the mode, the
    // dataset set and the CPU cache at once, so it is what the recorder asks
    // for a run's conditions.
    traceRecorder.setEnvironment(this);
    // A workspace reload hands the loop its datasets up front rather than
    // through `addDataset`. That is the cold open the monitor exists to
    // explain, so it opens a run too, under its own cause.
    if (this.datasets.size > 0) this.openDatasetRun("loop_start");
    this.publishSettle();
  }

  /**
   * Open a dataset-open run. The cause is drawn from the vocabulary the code
   * already has: a `content` epoch, and the render loop's own typed
   * dirty-set attribution for the source. A no-op while a run is open, so a
   * collection's members are one run rather than one run each.
   */
  private openDatasetRun(source: string): void {
    traceRecorder.openRun({ epoch: "content", dirtyKind: "interactive", source });
  }

  start(): void {
    // The worker's residency reports keep the cache's mirror of its slots.
    // A tick runs only when one makes a chunk sendable again.
    this.client.onChunkResidency = (msg) => {
      const resend = this.uploader.handleChunkResidency(
        msg.memberId, msg.tier, msg.change, msg.keys, this.session.cpuCache, msg.reason,
      );
      if (resend) {
        this.setDirty("residency", "chunk_residency");
      } else if (this.session.cpuCache.deliveryState.chunksUnanswered === 0) {
        this.republishSettle();
      }
    };
    this.client.onFrameDone = () => {
      if (this.client.framesAwaitingDone() === 0) this.republishSettle();
    };

    this.client.onWantedSetDelta = (datasetId, _epochs, missing) => {
      if (this.uploader.handleWantedSetDelta(datasetId, missing, this.session.cpuCache)) {
        this.setDirty("residency", "wanted_set_delta");
      }
    };

    this.client.onMinimapOverviewsLost = (memberIds) => {
      forgetMinimapOverviewsOf(this.minimapState, memberIds);
      this.setDirty("residency", "minimap_overviews_lost");
    };

    this.gpuStatusUnsub = this.client.onGpuStatus((status) => {
      if (status.type === "gpuError") {
        // Recovering a lost device sends everything again, so the recovery
        // is a run of its own, and the loss is recorded inside it.
        if (status.kind === "device-lost" && this.datasets.size > 0) {
          traceRecorder.openRun({ epoch: null, dirtyKind: "residency", source: "gpu_device_lost" });
        }
        traceRecorder.recordPointEvent(PointEvent.GpuError, status.kind);
      } else if (status.type === "gpuDeviceRestored") {
        // A replaced device holds nothing the old one did, so everything is
        // sent again and the frame redrawn.
        this.uploader.handleDeviceRestored(this.session.cpuCache);
        forgetMinimapOverviewUploads(this.minimapState);
        this.setDirty("interactive", "gpu_device_restored");
      }
    });

    this.setDirty("interactive", "loop_start");
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.resolutionRestoreTimer !== null) {
      clearTimeout(this.resolutionRestoreTimer);
      this.resolutionRestoreTimer = null;
    }
    this.client.onChunkResidency = null;
    this.client.onWantedSetDelta = null;
    this.client.onMinimapOverviewsLost = null;
    this.gpuStatusUnsub();
    this.cpuCacheUnsub();
    this.configStoreUnsub();
    this.appearanceUnsub();
    this.settleUnsub();
    failedChunkReport.publish(new Map());
    for (const unsub of this.unsubs.values()) {
      unsub();
    }
    this.unsubs.clear();
  }

  /** For the debug overlays and the simulation harness, which read its last plans. */
  getTickCoordinator(): TickCoordinator {
    return this.tickCoordinator;
  }

  addDataset(id: string, manifest: DatasetManifest): void {
    this.datasets.set(id, { manifest });
    settleSignal.restart();
    this.publishCaptureReady(false, "dataset_added_waiting_for_render");
    this.openDatasetRun("dataset_added");
    this.setDirty("interactive", "dataset_added");
  }

  updateDatasetManifest(id: string, manifest: DatasetManifest): void {
    if (!this.datasets.has(id)) return;
    this.datasets.set(id, { manifest });
    this.setDirty("interactive", "dataset_manifest_updated");
  }

  removeDataset(id: string): void {
    const unsub = this.unsubs.get(id);
    if (unsub) {
      unsub();
      this.unsubs.delete(id);
    }
    // Capture image IDs before deleting the dataset entry so the cache
    // cleanup can pair with a wire-format unregistration on the content
    // source (see contentSource.unregisterDataset).
    const manifest = this.datasets.get(id)?.manifest;
    const imageIds = manifest ? manifest.images.map(img => img.image_id) : [];
    this.datasets.delete(id);

    // Collect member IDs that were keyed under this dataset.
    // For single datasets image_id === dataset_id, but for collections
    // member IDs may differ (e.g. "collectionId:A/1/0").
    const memberIds = this.collectMemberIds(id);

    this.session.cpuCache.cancelDataset(id, cacheIdsOf(manifest, memberIds));
    this.session.contentSource.unregisterDataset(imageIds);

    clearVolumeForDataset(this.volumeState, id);
    clearSliceForDataset(this.sliceState, id);
    clearVolumeForMembers(this.volumeState, memberIds);
    clearSliceForMembers(this.sliceState, memberIds);
    clearMinimapForDataset(this.minimapState, id);
    this.autoContrast.forgetDataset(id);

    // Remove GPU + orchestrator + uploader resources for this dataset's
    // members. The orchestrator owns planner-side per-dataset state; the
    // uploader owns delivery tracking / per-dataset request snapshots /
    // last-view-epoch entries. Both need their own cleanup pass.
    this.client.removeLayerResources(id);
    this.tickCoordinator.clearMemberResources(id);
    this.uploader.clearDataset(id);
    for (const mid of memberIds) {
      this.tickCoordinator.clearMemberResources(mid);
      this.uploader.clearMember(mid);
      this.client.removeLayerResources(mid);
    }

    // If no datasets remain, clear the canvas by rendering empty layers
    if (this.datasets.size === 0) {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      const zeroEpochs: SceneEpochs = { content: 0, layout: 0, view: 0, selection: 0, request: 0 };
      this.client.resize(w, h);
      if (this.mode === "slice") {
        this.client.sliceRenderMultiPass([], 1, 0, 0, w, h, zeroEpochs);
      } else {
        const identity = identityMatrix();
        this.client.volumeRenderMultiPass([], identity, new Float32Array([0, 0, 1]), w, h, w, h, zeroEpochs, identity, new Float32Array([0, 0, -1]), 0, 0);
      }
      this.publishCaptureReady(false, "no_datasets");
    }

    this.setDirty("interactive", "dataset_removed");
  }

  private publishCaptureReady(ready: boolean, reason: string): void {
    if (typeof window === "undefined") return;
    window.__lucidaCaptureReady = {
      ready,
      reason,
      settle: settleSignal.outcome,
      frameCount: this.renderedFrameCount,
      at: performance.now(),
      mode: this.mode,
      datasetCount: this.datasets.size,
      canvasWidth: this.canvas.width || Math.round(this.canvas.clientWidth),
      canvasHeight: this.canvas.height || Math.round(this.canvas.clientHeight),
    };
  }

  /**
   * Publish the settle predicate. Called at the end of every
   * tick, which is also the only moment it can change: every arrival,
   * eviction and view change dirties a flag, and a dirty flag schedules a
   * tick. Nothing polls: an idle viewer publishes nothing because it does
   * not tick.
   *
   * `frameInFlight` reads the RAF handle after the tick has had its chance
   * to reschedule, so a loop with work left to do never looks settled.
   */
  private publishSettle(): void {
    const state = this.evaluateAndPublishSettle();

    // The reading tier rides the same moment. Queue depth and in-flight
    // come off the reading just taken rather than a second scan, and both
    // include speculative prefetch: the queue is as deep as it is, whatever
    // the settle predicate chooses to ignore. The GPU pass time is whatever
    // the render worker read back since the last tick, usually the previous
    // tick's frame. GPU memory is the worker's latest report.
    const gpu = this.client.gpuMemory();
    traceRecorder.noteReading(
      state.pending + state.speculativePending,
      state.inFlight + state.speculativeInFlight,
      this.lastFrameTimeUs,
      this.session.cpuCache.residentBytes(),
      this.client.takeGpuPassUs(),
      gpu && { bytes: gpu.bytes, budgetBytes: gpu.budgetBytes, slotsHeld: gpu.slotsHeld, slots: gpu.slots },
    );
  }

  private evaluateAndPublishSettle(): SettleState {
    const state = this.settleState;
    this.session.cpuCache.settleInputs(state);
    state.interactiveDirty = this.interactiveDirty;
    state.residencyDirty = this.residencyDirty;
    // A frame the worker is still drawing counts: until it lands, the canvas
    // does not show what the view settled on, and a capture would catch it.
    state.frameInFlight = this.rafId !== null || this.client.framesAwaitingDone() > 0;
    evaluateSettle(state, performance.now());
    settleSignal.publish(state);
    traceRecorder.noteQuiescence(state);
    return state;
  }

  /**
   * Publish the predicate between ticks, once the render worker has answered
   * the last thing the view waited on: an upload or a frame. The answer
   * changes nothing the loop would draw, so it asks for no tick, and a tick
   * already scheduled publishes anyway.
   */
  private republishSettle(): void {
    if (this.rafId === null) this.evaluateAndPublishSettle();
  }

  /** {@link TraceEnvironment}: what was already resident when the run opened. */
  captureWarmth(): CacheWarmth {
    const telemetry = this.session.cpuCache.telemetry();
    const tiers = telemetry.tierResidency;
    return {
      detailChunks: tiers.activeDetail.count + tiers.demotedDetail.count + tiers.prefetch.count,
      detailBytes: telemetry.mainBytes,
      coarseChunks: tiers.overview.count,
      coarseBytes: telemetry.overviewBytes,
    };
  }

  /**
   * {@link TraceEnvironment}: the conditions a run happened under, read at
   * close. At open the canvas still carries its default backing-store size
   * and a collection's members have not all arrived, so an at-open reading
   * would describe a page that does not exist yet.
   */
  captureConditions(): RunConditions {
    const location = typeof window === "undefined" ? null : window.location;
    return {
      datasetIds: [...this.datasets.keys()],
      composedView: {
        url: location ? `${location.pathname}${location.search}${location.hash}` : "",
        mode: this.mode,
      },
      devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
      viewport: {
        cssWidth: this.canvas.clientWidth,
        cssHeight: this.canvas.clientHeight,
        deviceWidth: this.canvas.width,
        deviceHeight: this.canvas.height,
      },
    };
  }

  /**
   * {@link TraceEnvironment}: what was still outstanding when the run closed.
   * Read fresh rather than off the last publication: a run can be closed
   * explicitly between ticks, and a stale reading would understate it.
   */
  captureOutstanding(): Outstanding {
    const s = this.session.cpuCache.settleInputs(createSettleState());
    return {
      pending: s.pending,
      inFlight: s.inFlight,
      speculativePending: s.speculativePending,
      speculativeInFlight: s.speculativeInFlight,
      desiredDetailChunks: s.desiredDetailChunks,
      residentDetailChunks: s.residentDetailChunks,
      desiredCoarseChunks: s.desiredCoarseChunks,
      residentCoarseChunks: s.residentCoarseChunks,
      detailBytes: s.detailBytes,
      detailBudgetBytes: s.detailBudgetBytes,
      coarseBytes: s.coarseBytes,
      coarseBudgetBytes: s.coarseBudgetBytes,
    };
  }

  private publishRenderedCaptureReady(): void {
    if (this.datasets.size === 0) {
      this.publishCaptureReady(false, "no_datasets");
      return;
    }
    this.renderedFrameCount += 1;
    this.publishCaptureReady(true, "rendered");
  }

  /** Collect member IDs associated with a dataset from uploader tracking. */
  private collectMemberIds(dsId: string): string[] {
    const ids = new Set<string>();
    const prefix = dsId + ":";
    for (const key of this.uploader.getTrackedResourceMemberIds()) {
      if (key === dsId || key.startsWith(prefix)) ids.add(key);
    }
    ids.delete(dsId);
    return [...ids];
  }

  markInteractiveDirty(source: string = "external"): void {
    this.setDirty("interactive", source);
  }

  /**
   * The frame on the canvas as a PNG, for the trace bundle. The worker takes
   * it from inside the next frame it renders, so this asks for one under a
   * name the trace records as what woke the tick. A loop that renders no
   * frame leaves the worker to answer after its own wait.
   */
  captureFrame(): Promise<FrameCaptureResult> {
    const capture = this.client.captureFrame();
    this.setDirty("interactive", "frame_capture");
    return capture;
  }

  /**
   * One of the five inputs landed: pan, zoom, orbit, scrub, or select. The
   * recorder hears it by name, so the run it opens or extends carries the
   * input as its cause, and the loop is dirtied under the same name.
   *
   * An input on a page with nothing open moves nothing through the pipeline
   * and opens no run. The next thing that happens on such a page is a
   * dataset open, and that run has to carry its own cause rather than
   * inherit the label of a gesture made over an empty canvas.
   */
  markInput(input: InputKind): void {
    if (this.datasets.size > 0) traceRecorder.noteInput(input);
    settleSignal.restart();
    this.resolution.noteInput();
    this.setDirty("interactive", input);
  }

  /**
   * Feed the newest finished frame to the adaptive resolution, and arrange
   * for a lowered resolution to come back once input stops, with a frame to
   * show it.
   */
  private adaptResolution(): void {
    const frame = this.client.takeFrameLatency();
    if (frame) this.resolution.noteFrame(frame.frameSeq, frame.ms, this.client.lastFrameSeq());
    const wait = this.resolution.msUntilRestore();
    if (wait === null || this.resolutionRestoreTimer !== null) return;
    this.resolutionRestoreTimer = setTimeout(() => {
      this.resolutionRestoreTimer = null;
      if (this.resolution.restoreIfIdle()) this.setDirty("interactive", "resolution_restored");
      else this.adaptResolution();
    }, wait);
  }

  markResidencyDirty(source: string = "external"): void {
    this.setDirty("residency", source);
  }

  resetVolumeCache(): void {
    resetVolumeState(this.volumeState);
  }

  /**
   * Hand each channel's auto-contrast fit to `listener` as the view's chunks
   * become resident. A new listener gets the current fits on the next tick:
   * a loop that starts on a warm cache fits on its first tick, before its
   * owner can attach.
   */
  setAutoContrastListener(listener: AutoContrastListener | null): void {
    this.autoContrastListener = listener;
    this.autoContrast.reset();
    if (listener) this.setDirty("residency", "auto_contrast_listener");
  }

  setRenderScale(s: number): void {
    this._renderScale = s;
    this.setDirty("interactive", "render_scale");
  }

  setMinimap(enabled: boolean, size?: number, overlayCallback?: ((data: MinimapOverlayData) => void) | null): void {
    this.minimapState.enabled = enabled;
    if (size !== undefined) this.minimapState.size = size;
    this.minimapState.overlayCallback = overlayCallback ?? null;
    if (enabled) {
      this.setDirty("interactive", "minimap_enabled");
    }
  }

  /**
   * Tell the loop the Explore panel wants the per-dataset coarse overview
   * textures uploaded (for thumbnail rendering) even while the minimap is
   * hidden. Enabling schedules a residency tick so the upload starts promptly;
   * the upload itself is the minimap overview path (`tickMinimapOverview`),
   * shared so a thumbnail and the minimap draw the exact same texture.
   */
  setThumbnailOverview(enabled: boolean): void {
    if (this.minimapState.overviewActive === enabled) return;
    this.minimapState.overviewActive = enabled;
    if (enabled) this.setDirty("residency", "thumbnail_overview");
  }

  // Its own frame request, not the frame clock's: the loop runs only while
  // dirty, so it idles by itself, and each dirty also wakes the clock.
  private scheduleIfNeeded(): void {
    if ((this.interactiveDirty || this.residencyDirty) && this.rafId === null) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  /**
   * Set a dirty flag with attribution. The `source` string flows into
   * the gated `render_loop.dirty_set` event so a debugger can answer
   * "what woke up the loop just now?". Identical (kind, source) calls
   * within DIRTY_EMIT_INTERVAL_MS collapse into one log + a count.
   */
  private setDirty(kind: "interactive" | "residency", source: string): void {
    if (kind === "interactive") {
      this.interactiveDirty = true;
    } else {
      this.residencyDirty = true;
    }
    this.wake.note(source);
    settleSignal.disturb();
    this.scheduleIfNeeded();
    // Whatever dirties the frame can move what the overlays show.
    wakeFrames();

    const key = `${kind}:${source}`;
    const now = performance.now();
    const entry = this.dirtyEmitState.get(key);
    if (!entry) {
      debugLog("render", "dirty_set", { kind, source });
      this.dirtyEmitState.set(key, { lastEmit: now, pending: 0 });
      return;
    }
    if (now - entry.lastEmit > RenderLoop.DIRTY_EMIT_INTERVAL_MS) {
      debugLog("render", "dirty_set", {
        kind,
        source,
        suppressedSince: entry.pending,
      });
      entry.lastEmit = now;
      entry.pending = 0;
    } else {
      entry.pending++;
    }
  }

  private buildContext(): TickContext {
    return {
      scene: this.session.scene!,
      datasets: this.datasets,
      client: this.client,
      canvas: this.canvas,
      mode: this.mode,
      renderScale: this._renderScale,
      resolutionScale: cappedPixelRatioScale(devicePixelRatio) * this.resolution.scale,
      cpuCache: this.session.cpuCache,
      sendViewerInterest: (interest) => this.session.bridge.sendViewerInterest(interest),
    };
  }

  private tick = (): void => {
    this.rafId = null;  // clear so scheduleIfNeeded can re-schedule

    if (!this.interactiveDirty && !this.residencyDirty) return;

    // No scene yet (the brief window before the first server snapshot sets
    // it on Session). Once it appears, the next
    // markInteractiveDirty/markResidencyDirty triggers a tick.
    if (!this.session.scene) {
      this.scheduleIfNeeded();
      return;
    }

    // Before anything in this tick can dirty the loop again: what woke this
    // one is what the samples it publishes carry.
    traceRecorder.noteTickWake(this.wake.take());
    this.adaptResolution();

    const now = performance.now();
    let shouldRender = false;

    if (this.interactiveDirty) {
      // View changed: render immediately.
      this.interactiveDirty = false;
      this.residencyDirty = false;
      this.lastResidencyRenderTime = now;
      shouldRender = true;
    } else if (this.residencyDirty) {
      if (now - this.lastResidencyRenderTime >= RESIDENCY_RENDER_INTERVAL_MS) {
        // Enough time elapsed since the last data render: render now.
        this.residencyDirty = false;
        this.lastResidencyRenderTime = now;
        shouldRender = true;
      } else {
        // Residency dirty but debounce not elapsed: the tick still runs for
        // uploads and only the render is suppressed. Skip counts aggregate
        // into one log per second so chunk bursts don't flood the console.
        this.throttleSkipPending++;
        if (now - this.lastThrottleEmit > RenderLoop.THROTTLE_EMIT_INTERVAL_MS) {
          debugLog("render", "residency_throttled", {
            skipCount: this.throttleSkipPending,
            windowMs: this.lastThrottleEmit === Number.NEGATIVE_INFINITY
              ? null
              : Math.round(now - this.lastThrottleEmit),
            nextRenderInMs: Math.max(
              0,
              Math.round(RESIDENCY_RENDER_INTERVAL_MS - (now - this.lastResidencyRenderTime)),
            ),
          });
          this.throttleSkipPending = 0;
          this.lastThrottleEmit = now;
        }
      }
    }

    const ctx = this.buildContext();

    // Ahead of this tick's frame, so the frame draws the failures hatched.
    const failed = this.uploader.syncFailedChunks(ctx);
    if (failed) failedChunkReport.publish(summarizeFailedChunks(failed));

    // Tick always runs (drives chunk uploads). shouldRender gates the expensive render pass.
    if (this.mode === "slice") {
      if (tickSlice(ctx, this.tickCoordinator, this.uploader, this.minimapState.pendingFetch, shouldRender)) {
        this.setDirty("residency", "tick_slice_continuation");
      }
    } else {
      if (tickVolume(ctx, this.tickCoordinator, this.uploader, this.minimapState.pendingFetch, shouldRender)) {
        this.setDirty("residency", "tick_volume_continuation");
      }
    }

    // A coalesced view/selection change still owes a trailing rebuild. Mark
    // interactive so it renders once the coalescing window elapses;
    // otherwise the change is lost when the user stops moving.
    if (this.tickCoordinator.hasPendingRebuild()) {
      this.setDirty("interactive", "pending_residency_rebuild");
    }

    // Recording is unconditional, and one subtraction is not a cost worth
    // gating.
    this.lastFrameTimeUs = (performance.now() - now) * 1000;

    if (shouldRender) {
      this.publishRenderedCaptureReady();
    }

    if (tickMinimapOverview(ctx, this.minimapState, now)) this.setDirty("residency", "minimap_overview_continuation");
    if (shouldRender) tickMinimap(ctx, this.minimapState, ctx.scene.z());

    // Before quiescence is published: limits the listener sets dirty the
    // loop, so a settled frame is never one drawn with the limits before.
    if (this.autoContrastListener) {
      this.autoContrast.update(
        this.tickCoordinator.getLastPlans(),
        this.datasets,
        this.session.cpuCache,
        this.session.generatedAvailability,
        this.autoContrastListener,
      );
    }

    // If work remains (budget exhausted or chunks pending), schedule another frame
    this.scheduleIfNeeded();

    this.publishSettle();
  };
}
