/** Pull-based render loop: coalesces chunk arrivals into a single RAF tick. */
import type { ContentGraph } from "./contentTypes.ts";
import type { SharedChunkQueue } from "./zarr/chunkStore.ts";
import type { TickContext, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";
import { DATA_RENDER_INTERVAL_MS } from "./renderLoopTypes.ts";
import { debugStats, resetFrameStats } from "./debug/debugStats.ts";
import { type SliceState, createSliceState, tickSlice, clearSliceForDataset, clearSliceForMembers } from "./slicePath.ts";
import { type VolumeState, createVolumeState, tickVolume, clearVolumeForDataset, clearVolumeForMembers, resetVolumeState } from "./volumePath.ts";
import { Orchestrator } from "./pipeline/orchestrator.ts";
import type { CpuCache } from "./pipeline/cpuCache.ts";
import { type MinimapState, createMinimapState, tickMinimapOverview, tickMinimap, markMinimapOverviewSeeded, clearMinimapForDataset } from "./minimapPath.ts";

// Re-export types so downstream imports stay unchanged
export type { DatasetEntry, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";

export class RenderLoop {
  private scene: RenderLoopOptions["scene"];
  private datasets: Map<string, { sharedQueue: SharedChunkQueue; content: ContentGraph }>;
  private client: RenderLoopOptions["client"];
  private canvas: HTMLCanvasElement;
  private mode: "slice" | "volume";

  private viewDirty = true;
  private dataDirty = false;
  private lastDataRenderTime = 0;
  private rafId: number | null = null;
  private unsubs = new Map<string, () => void>();

  private sliceState: SliceState = createSliceState();
  private volumeState: VolumeState = createVolumeState();
  private minimapState: MinimapState = createMinimapState();
  private orchestrator = new Orchestrator();
  private cpuCache: CpuCache | null = null;
  private cpuCacheUnsub: (() => void) | null = null;

  private _renderScale = 1.0;

  /** Track previous multi_channel state to detect transitions and clean up. */
  private prevMultiChannel = false;

  // Slice-specific params
  private sliceZ = 0;
  private sliceT = 0;
  private sliceC = 0;

  constructor(opts: RenderLoopOptions) {
    this.scene = opts.scene;
    this.datasets = new Map();
    for (const [id, entry] of opts.datasets) {
      this.datasets.set(id, { sharedQueue: entry.sharedQueue, content: entry.content });
    }
    this.client = opts.client;
    this.canvas = opts.canvas;
    this.mode = opts.mode;
  }

  start(): void {
    // Subscribe to each dataset's shared queue
    for (const [id, ds] of this.datasets) {
      this.unsubs.set(id, ds.sharedQueue.subscribe(() => {
        this.dataDirty = true;
        this.scheduleIfNeeded();
      }));
    }

    // When the worker evicts or skips chunks, update the orchestrator's delivery
    // tracking so they can be re-sent. Evictions trigger a new tick.
    this.client.onChunksEvicted = (datasetId: string, evicted: string[], skipped: string[]) => {
      this.orchestrator.handleChunksEvicted(datasetId, evicted, skipped);
      if (evicted.length > 0) {
        this.dataDirty = true;
        this.scheduleIfNeeded();
      }
    };

    this.viewDirty = true;
    this.scheduleIfNeeded();
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.client.onChunksEvicted = null;
    this.cpuCacheUnsub?.();
    this.cpuCacheUnsub = null;
    this.cpuCache = null;
    for (const unsub of this.unsubs.values()) {
      unsub();
    }
    this.unsubs.clear();
  }

  setCpuCache(cache: CpuCache): void {
    if (this.cpuCache === cache) return;
    // Unsubscribe from previous cache
    this.cpuCacheUnsub?.();
    this.cpuCache = cache;
    this.cpuCacheUnsub = cache.subscribe(() => {
      this.dataDirty = true;
      this.scheduleIfNeeded();
    });
  }

  addDataset(id: string, sharedQueue: SharedChunkQueue, content: ContentGraph): void {
    this.datasets.set(id, { sharedQueue, content });
    this.unsubs.set(id, sharedQueue.subscribe(() => {
      this.dataDirty = true;
      this.scheduleIfNeeded();
    }));
    this.viewDirty = true;
    this.scheduleIfNeeded();
  }

  removeDataset(id: string): void {
    const unsub = this.unsubs.get(id);
    if (unsub) {
      unsub();
      this.unsubs.delete(id);
    }
    this.datasets.delete(id);

    // Collect member IDs that were keyed under this dataset.
    // For single datasets image_id === dataset_id, but for plates
    // member IDs may differ (e.g. "plateId:A/1/0").
    const memberIds = this.collectMemberIds(id);

    clearVolumeForDataset(this.volumeState, id);
    clearSliceForDataset(this.sliceState, id);
    clearVolumeForMembers(this.volumeState, memberIds);
    clearSliceForMembers(this.sliceState, memberIds);
    clearMinimapForDataset(this.minimapState, id);

    // Remove GPU + orchestrator resources for this dataset's members
    this.client.removeLayerResources(id);
    this.orchestrator.clearMemberResources(id);
    for (const mid of memberIds) {
      this.orchestrator.clearMemberResources(mid);
      this.client.removeLayerResources(mid);
    }

    // If no datasets remain, clear the canvas by rendering empty layers
    if (this.datasets.size === 0) {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      this.client.resize(w, h);
      if (this.mode === "slice") {
        this.client.sliceRenderMultiPass([], 1, 0, 0, w, h);
      } else {
        const identity = new Float32Array(16);
        identity[0] = identity[5] = identity[10] = identity[15] = 1;
        this.client.volumeRenderMultiPass([], identity, new Float32Array([0, 0, 1]), w, h, w, h, identity, new Float32Array([0, 0, -1]), 0, 0);
      }
    }

    this.viewDirty = true;
    this.scheduleIfNeeded();
  }

  /**
   * Handle multi-channel mode transitions. When switching from multi-channel
   * to single-channel (or vice versa), clean up resources keyed with the
   * old naming convention so they don't leak on the worker.
   */
  private handleMultiChannelTransition(): void {
    const mc = this.scene.multi_channel();
    if (mc === this.prevMultiChannel) return;
    this.prevMultiChannel = mc;

    const trackedIds = this.orchestrator.getTrackedMemberIds();
    for (const key of trackedIds) {
      const isComposite = /:ch\d+$/.test(key);
      if ((mc && !isComposite) || (!mc && isComposite)) {
        this.client.removeLayerResources(key);
        this.orchestrator.clearMemberResources(key);
      }
    }
  }

  /** Collect member IDs associated with a dataset from orchestrator tracking. */
  private collectMemberIds(dsId: string): string[] {
    const ids = new Set<string>();
    const prefix = dsId + ":";
    for (const key of this.orchestrator.getTrackedMemberIds()) {
      if (key === dsId || key.startsWith(prefix)) ids.add(key);
    }
    ids.delete(dsId);
    return [...ids];
  }

  markViewDirty(): void {
    this.viewDirty = true;
    this.scheduleIfNeeded();
  }

  markDataDirty(): void {
    this.dataDirty = true;
    this.scheduleIfNeeded();
  }

  resetVolumeCache(): void {
    resetVolumeState(this.volumeState);
  }

  setSliceParams(z: number, t: number, c: number): void {
    if (z !== this.sliceZ || t !== this.sliceT || c !== this.sliceC) {
      this.sliceZ = z;
      this.sliceT = t;
      this.sliceC = c;
      this.viewDirty = true;
      this.scheduleIfNeeded();
    }
  }

  setRenderScale(s: number): void {
    this._renderScale = s;
    this.viewDirty = true;
    this.scheduleIfNeeded();
  }

  setMinimap(enabled: boolean, size?: number, overlayCallback?: ((data: MinimapOverlayData) => void) | null): void {
    this.minimapState.enabled = enabled;
    if (size !== undefined) this.minimapState.size = size;
    this.minimapState.overlayCallback = overlayCallback ?? null;
    if (enabled) {
      this.viewDirty = true;
      this.scheduleIfNeeded();
    }
  }

  markMinimapOverviewSeeded(datasetId: string, t: number, c: number): void {
    const ctx = this.buildContext();
    markMinimapOverviewSeeded(ctx, this.minimapState, datasetId, t, c);
  }

  private scheduleIfNeeded(): void {
    if ((this.viewDirty || this.dataDirty) && this.rafId === null) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private buildContext(): TickContext {
    return {
      scene: this.scene,
      datasets: this.datasets,
      client: this.client,
      canvas: this.canvas,
      mode: this.mode,
      renderScale: this._renderScale,
      cpuCache: this.cpuCache ?? undefined,
    };
  }

  private tick = (): void => {
    this.rafId = null;  // clear so scheduleIfNeeded can re-schedule

    if (!this.viewDirty && !this.dataDirty) return;

    const now = performance.now();
    if (debugStats.enabled) {
      resetFrameStats();
      debugStats.mode = this.mode;
    }
    let shouldRender = false;

    if (this.viewDirty) {
      // View changed — render immediately
      this.viewDirty = false;
      this.dataDirty = false;
      this.lastDataRenderTime = now;
      shouldRender = true;
    } else if (this.dataDirty) {
      if (now - this.lastDataRenderTime >= DATA_RENDER_INTERVAL_MS) {
        // Enough time elapsed since last data render — render now
        this.dataDirty = false;
        this.lastDataRenderTime = now;
        shouldRender = true;
      }
      // else: data dirty but debounce not elapsed — still run tick for uploads, skip render
    }

    const ctx = this.buildContext();

    // Detect multi-channel mode transitions and clean up stale resources
    this.handleMultiChannelTransition();

    // Tick always runs (drives chunk uploads). shouldRender gates the expensive render pass.
    if (this.mode === "slice") {
      if (tickSlice(ctx, this.orchestrator, this.sliceZ, this.sliceT, this.sliceC, this.minimapState.pendingFetch, shouldRender)) {
        this.dataDirty = true;
      }
    } else {
      if (tickVolume(ctx, this.orchestrator, this.minimapState.pendingFetch, shouldRender)) {
        this.dataDirty = true;
      }
    }

    if (debugStats.enabled) {
      debugStats.frameTimeMs = performance.now() - now;
    }

    if (tickMinimapOverview(ctx, this.minimapState)) this.dataDirty = true;
    if (shouldRender) tickMinimap(ctx, this.minimapState, this.sliceZ);

    // If work remains (budget exhausted or chunks pending), schedule another frame
    this.scheduleIfNeeded();
  };
}
