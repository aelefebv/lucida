/** Pull-based render loop: coalesces chunk arrivals into a single RAF tick. */
import type { DatasetManifest } from "./manifestTypes.ts";
import type { TickContext, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";
import { RESIDENCY_RENDER_INTERVAL_MS } from "./renderLoopTypes.ts";
import type { SceneEpochs } from "./pipeline/epochs.ts";
import { debugStats, resetFrameStats } from "./debug/debugStats.ts";
import { debugLog } from "./debug/logging.ts";
import { type SliceState, createSliceState, tickSlice, clearSliceForDataset, clearSliceForMembers } from "./slicePath.ts";
import { type VolumeState, createVolumeState, tickVolume, clearVolumeForDataset, clearVolumeForMembers, resetVolumeState } from "./volumePath.ts";
import { TickCoordinator } from "./pipeline/tickCoordinator.ts";
import { Uploader } from "./pipeline/upload/uploader.ts";
import { configStore } from "./pipeline/planning/configStore.ts";
import type { CpuCache } from "./pipeline/fetch/index.ts";
import { identityMatrix } from "./pipeline/upload/coldState/identity.ts";
import type { Session } from "./session.ts";
import { type MinimapState, createMinimapState, tickMinimapOverview, tickMinimap, markMinimapOverviewSeeded, clearMinimapForDataset } from "./minimapPath.ts";

// Re-export types so downstream imports stay unchanged
export type { DatasetEntry, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";

export class RenderLoop {
  private session: Session;
  private datasets: Map<string, { manifest: DatasetManifest }>;
  private client: RenderLoopOptions["client"];
  private canvas: HTMLCanvasElement;
  private mode: "slice" | "volume";

  private interactiveDirty = true;
  private residencyDirty = false;
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
  // Ring buffer of recent ticks. Powers FPS, sticky-max times, and the
  // "ms since last render" indicator on the DebugPanel. Bounded to
  // SAMPLE_BUFFER_LIMIT entries; oldest evicted on push.
  private frameSamples: Array<{ t: number; frame: number; plan: number; upload: number; passes: number; rendered: boolean }> = [];
  private static readonly SAMPLE_BUFFER_LIMIT = 120;
  // Last-set timestamps for each dirty flag. Lets the panel show a brief
  // "afterglow" so transient flips (e.g. an interactive flag that gets
  // cleared within one RAF) are visible at the 200ms polling rate.
  private lastInteractiveDirtyAt: number | null = null;
  private lastResidencyDirtyAt: number | null = null;

  private sliceState: SliceState = createSliceState();
  private volumeState: VolumeState = createVolumeState();
  private minimapState: MinimapState = createMinimapState();
  /**
   * Upload coordinator. Owns telemetry, cold/hot-state emission,
   * dispatch, worker-feedback parsing, and worker resource cleanup.
   * Constructed alongside the TickCoordinator so `client.onChunksEvicted`
   * / `client.onWantedSetDelta` callbacks wire directly here.
   */
  private uploader = new Uploader();
  private tickCoordinator = new TickCoordinator(this.uploader);
  private cpuCacheUnsub: () => void;
  private configStoreUnsub: () => void;

  private _renderScale = 1.0;

  /** Track previous multi_channel state to detect transitions and clean up. */
  private prevMultiChannel = false;

  // Slice-specific params
  private sliceZ = 0;
  private sliceT = 0;
  private sliceC = 0;

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
    // Bridge planning-config tweaks (Config tab in DebugPanel) into the
    // render loop. The orchestrator separately invalidates its own
    // epoch cache from a configStore subscription; this listener just
    // ensures a frame happens promptly so the user sees the change.
    this.configStoreUnsub = configStore.subscribe(() => {
      this.setDirty("interactive", "planning_config_changed");
    });
  }

  start(): void {
    // When the worker evicts or skips chunks, update the uploader's
    // delivery tracking so they can be re-sent. Evictions trigger a new
    // tick.
    this.client.onChunksEvicted = (memberId: string, evicted: string[], skipped: string[], reason) => {
      this.uploader.handleChunksEvicted(memberId, evicted, skipped, this.session.cpuCache, reason);
      if (evicted.length > 0) {
        this.setDirty("residency", "chunks_evicted");
      }
    };

    // When the worker reports its wanted-set, update the uploader and
    // schedule a tick so wanted chunks can be delivered from CpuCache.
    this.client.onWantedSetDelta = (_epochs, missing) => {
      this.uploader.handleWantedSetDelta(missing, this.session.cpuCache);
      if (missing.length > 0) {
        this.setDirty("residency", "wanted_set_delta");
      }
    };

    this.setDirty("interactive", "loop_start");
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.client.onChunksEvicted = null;
    this.client.onWantedSetDelta = null;
    this.cpuCacheUnsub();
    this.configStoreUnsub();
    for (const unsub of this.unsubs.values()) {
      unsub();
    }
    this.unsubs.clear();
  }

  /**
   * Expose the tickCoordinator + cpuCache for HITL debugging via
   * `window.__lucidaOrch`. The full chain is needed because
   * `TickCoordinator.requestTestProxy(...)` submits through CpuCache and
   * the normal subscribe → tick → `deliverToWorker` path forwards the
   * result to the GPU worker.
   */
  getTickCoordinator(): TickCoordinator {
    return this.tickCoordinator;
  }
  getCpuCache(): CpuCache {
    return this.session.cpuCache;
  }

  addDataset(id: string, manifest: DatasetManifest): void {
    this.datasets.set(id, { manifest });
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
    // Capture image IDs from the manifest BEFORE deleting the dataset
    // entry so we can pair the cache cleanup with a wire-format
    // unregistration on the content source (closes the
    // imageWireFormats leak; see contentSource.unregisterDataset).
    const manifest = this.datasets.get(id)?.manifest;
    const imageIds = manifest ? manifest.images.map(img => img.image_id) : [];
    this.datasets.delete(id);

    // Collect member IDs that were keyed under this dataset.
    // For single datasets image_id === dataset_id, but for plates
    // member IDs may differ (e.g. "plateId:A/1/0").
    const memberIds = this.collectMemberIds(id);

    this.session.cpuCache.cancelDataset(id, memberIds);
    this.session.contentSource.unregisterDataset(imageIds);

    clearVolumeForDataset(this.volumeState, id);
    clearSliceForDataset(this.sliceState, id);
    clearVolumeForMembers(this.volumeState, memberIds);
    clearSliceForMembers(this.sliceState, memberIds);
    clearMinimapForDataset(this.minimapState, id);

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
      const zeroEpochs: SceneEpochs = { content: 0, layout: 0, view: 0, selection: 0, asset: 0, request: 0 };
      this.client.resize(w, h);
      if (this.mode === "slice") {
        this.client.sliceRenderMultiPass([], 1, 0, 0, w, h, zeroEpochs);
      } else {
        const identity = identityMatrix();
        this.client.volumeRenderMultiPass([], identity, new Float32Array([0, 0, 1]), w, h, w, h, zeroEpochs, identity, new Float32Array([0, 0, -1]), 0, 0);
      }
    }

    this.setDirty("interactive", "dataset_removed");
  }

  /**
   * On multi-channel ↔ single-channel transitions, clear members whose
   * key shape (composite `:chN` vs plain) no longer matches the new mode,
   * so they don't leak on the worker.
   */
  private handleMultiChannelTransition(): void {
    const mc = this.session.scene!.multi_channel();
    if (mc === this.prevMultiChannel) return;
    this.prevMultiChannel = mc;

    const trackedIds = this.uploader.getTrackedResourceMemberIds();
    for (const key of trackedIds) {
      const isComposite = /:ch\d+$/.test(key);
      if ((mc && !isComposite) || (!mc && isComposite)) {
        this.client.removeLayerResources(key);
        this.tickCoordinator.clearMemberResources(key);
        this.uploader.clearMember(key);
      }
    }
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

  markResidencyDirty(source: string = "external"): void {
    this.setDirty("residency", source);
  }

  resetVolumeCache(): void {
    resetVolumeState(this.volumeState);
  }

  setSliceParams(z: number, t: number, c: number): void {
    if (z !== this.sliceZ || t !== this.sliceT || c !== this.sliceC) {
      this.sliceZ = z;
      this.sliceT = t;
      this.sliceC = c;
      this.setDirty("interactive", "slice_params");
    }
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

  markMinimapOverviewSeeded(datasetId: string, t: number, c: number): void {
    const ctx = this.buildContext();
    markMinimapOverviewSeeded(ctx, this.minimapState, datasetId, t, c);
  }

  private scheduleIfNeeded(): void {
    if ((this.interactiveDirty || this.residencyDirty) && this.rafId === null) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private recordFrameSample(t: number, frame: number, plan: number, upload: number, passes: number, rendered: boolean): void {
    this.frameSamples.push({ t, frame, plan, upload, passes, rendered });
    if (this.frameSamples.length > RenderLoop.SAMPLE_BUFFER_LIMIT) {
      this.frameSamples.shift();
    }
  }

  /**
   * Snapshot of render-loop internals for the DebugPanel "Render" tab.
   * Computed on demand from the ring buffer; cheap (O(SAMPLE_BUFFER_LIMIT)).
   */
  getDebugSnapshot(): {
    interactiveDirty: boolean;
    residencyDirty: boolean;
    msSinceInteractiveDirty: number | null;
    msSinceResidencyDirty: number | null;
    throttleSkipsPending: number;
    msSinceLastThrottleEmit: number | null;
    msSinceLastRender: number | null;
    fps: number | null;
    sampleWindowMs: number | null;
    maxFrameMs: number;
    maxPlanMs: number;
    maxUploadMs: number;
    maxPasses: number;
  } {
    const now = performance.now();
    const samples = this.frameSamples;
    // Window FPS / max stats to the last ~2 seconds. Otherwise FPS keeps
    // reporting "60" long after the loop has gone idle, because the ring
    // buffer still holds samples from earlier active bursts.
    const FPS_WINDOW_MS = 2000;
    const windowCutoff = now - FPS_WINDOW_MS;
    const recent = samples.filter(s => s.t >= windowCutoff);
    const rendered = recent.filter(s => s.rendered);

    let fps: number | null = null;
    let sampleWindowMs: number | null = null;
    if (rendered.length >= 2) {
      const first = rendered[0].t;
      const last = rendered[rendered.length - 1].t;
      const span = last - first;
      if (span > 0) {
        fps = +((rendered.length - 1) / (span / 1000)).toFixed(1);
        sampleWindowMs = Math.round(span);
      }
    }

    // For "last render age" use the full buffer (not windowed) so a 5s
    // idle period still tells you how long it's been.
    const lastRenderedFull = samples.filter(s => s.rendered).pop();
    const msSinceLastRender = lastRenderedFull ? Math.round(now - lastRenderedFull.t) : null;

    // If we couldn't compute fps from the window AND it's been >1s since
    // the last render, the loop is genuinely idle — report 0 instead of
    // null so the panel shows "FPS: 0" instead of "—".
    if (fps === null && (msSinceLastRender === null || msSinceLastRender > 1000)) {
      fps = 0;
    }

    let maxFrameMs = 0, maxPlanMs = 0, maxUploadMs = 0, maxPasses = 0;
    for (const s of recent) {
      if (s.frame > maxFrameMs) maxFrameMs = s.frame;
      if (s.plan > maxPlanMs) maxPlanMs = s.plan;
      if (s.upload > maxUploadMs) maxUploadMs = s.upload;
      if (s.passes > maxPasses) maxPasses = s.passes;
    }

    return {
      interactiveDirty: this.interactiveDirty,
      residencyDirty: this.residencyDirty,
      msSinceInteractiveDirty: this.lastInteractiveDirtyAt === null
        ? null
        : Math.round(now - this.lastInteractiveDirtyAt),
      msSinceResidencyDirty: this.lastResidencyDirtyAt === null
        ? null
        : Math.round(now - this.lastResidencyDirtyAt),
      throttleSkipsPending: this.throttleSkipPending,
      msSinceLastThrottleEmit: this.lastThrottleEmit === Number.NEGATIVE_INFINITY
        ? null
        : Math.round(now - this.lastThrottleEmit),
      msSinceLastRender,
      fps,
      sampleWindowMs,
      maxFrameMs: +maxFrameMs.toFixed(1),
      maxPlanMs: +maxPlanMs.toFixed(1),
      maxUploadMs: +maxUploadMs.toFixed(1),
      maxPasses,
    };
  }

  /**
   * Set a dirty flag with attribution. The `source` string flows into
   * the gated `render_loop.dirty_set` event so a debugger can answer
   * "what woke up the loop just now?". Identical (kind, source) calls
   * within DIRTY_EMIT_INTERVAL_MS collapse into one log + a count.
   */
  private setDirty(kind: "interactive" | "residency", source: string): void {
    const tNow = performance.now();
    if (kind === "interactive") {
      this.interactiveDirty = true;
      this.lastInteractiveDirtyAt = tNow;
    } else {
      this.residencyDirty = true;
      this.lastResidencyDirtyAt = tNow;
    }
    this.scheduleIfNeeded();

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
      cpuCache: this.session.cpuCache,
      sendViewerInterest: (interest) => this.session.bridge.sendViewerInterest(interest),
      assetCatalog: this.session.assetCatalog!,
    };
  }

  private tick = (): void => {
    this.rafId = null;  // clear so scheduleIfNeeded can re-schedule

    if (!this.interactiveDirty && !this.residencyDirty) return;

    // AssetCatalog not yet wired (brief window before the first server
    // snapshot lazily constructs it on Session). Reschedule — once the
    // catalog appears, the next markInteractiveDirty/markResidencyDirty triggers a tick.
    if (!this.session.assetCatalog) {
      this.scheduleIfNeeded();
      return;
    }

    const now = performance.now();
    if (debugStats.enabled) {
      resetFrameStats();
      debugStats.mode = this.mode;
    }
    let shouldRender = false;

    if (this.interactiveDirty) {
      // View changed — render immediately
      this.interactiveDirty = false;
      this.residencyDirty = false;
      this.lastResidencyRenderTime = now;
      shouldRender = true;
    } else if (this.residencyDirty) {
      if (now - this.lastResidencyRenderTime >= RESIDENCY_RENDER_INTERVAL_MS) {
        // Enough time elapsed since last data render — render now
        this.residencyDirty = false;
        this.lastResidencyRenderTime = now;
        shouldRender = true;
      } else {
        // Residency dirty but debounce not elapsed — tick still runs for
        // uploads; only the render is suppressed. Aggregate skip counts
        // and emit one log per second so chunk-burst loading doesn't
        // flood the console.
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

    // Detect multi-channel mode transitions and clean up stale resources
    this.handleMultiChannelTransition();

    // Tick always runs (drives chunk uploads). shouldRender gates the expensive render pass.
    if (this.mode === "slice") {
      if (tickSlice(ctx, this.tickCoordinator, this.uploader, this.sliceZ, this.sliceT, this.sliceC, this.minimapState.pendingFetch, shouldRender)) {
        this.setDirty("residency", "tick_slice_continuation");
      }
    } else {
      if (tickVolume(ctx, this.tickCoordinator, this.uploader, this.minimapState.pendingFetch, shouldRender)) {
        this.setDirty("residency", "tick_volume_continuation");
      }
    }

    if (debugStats.enabled) {
      debugStats.frameTimeMs = performance.now() - now;
      this.recordFrameSample(now, debugStats.frameTimeMs, debugStats.planTimeMs, debugStats.uploadTimeMs, debugStats.renderPasses.total, shouldRender);
    }

    if (tickMinimapOverview(ctx, this.minimapState)) this.setDirty("residency", "minimap_overview_continuation");
    if (shouldRender) tickMinimap(ctx, this.minimapState, this.sliceZ);

    // If work remains (budget exhausted or chunks pending), schedule another frame
    this.scheduleIfNeeded();
  };
}
