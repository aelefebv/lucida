/** Pull-based render loop: coalesces chunk arrivals into a single RAF tick. */
import type { DatasetInfo } from "./zarr/metadata.ts";
import type { SharedChunkQueue } from "./zarr/chunkStore.ts";
import type { TickContext, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";
import { DATA_RENDER_INTERVAL_MS } from "./renderLoopTypes.ts";
import { type SliceState, createSliceState, tickSlice, clearSliceForDataset, clearSliceForMembers } from "./slicePath.ts";
import { type VolumeState, createVolumeState, tickVolume, clearVolumeForDataset, clearVolumeForMembers, resetVolumeState } from "./volumePath.ts";
import { type MinimapState, createMinimapState, tickMinimapOverview, tickMinimap, markMinimapOverviewSeeded, clearMinimapForDataset } from "./minimapPath.ts";

// Re-export types so downstream imports stay unchanged
export type { DatasetEntry, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";

export class RenderLoop {
  private scene: RenderLoopOptions["scene"];
  private datasets: Map<string, { sharedQueue: SharedChunkQueue; info: DatasetInfo }>;
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

  private _renderScale = 1.0;

  // Slice-specific params
  private sliceZ = 0;
  private sliceT = 0;
  private sliceC = 0;

  constructor(opts: RenderLoopOptions) {
    this.scene = opts.scene;
    this.datasets = new Map();
    for (const [id, entry] of opts.datasets) {
      this.datasets.set(id, { sharedQueue: entry.sharedQueue, info: entry.info });
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

    // When the worker skips/rejects chunks, remove them from sentToWorker
    // so they can be re-sent when the camera moves closer.
    this.viewDirty = true;
    this.scheduleIfNeeded();
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    for (const unsub of this.unsubs.values()) {
      unsub();
    }
    this.unsubs.clear();
  }

  addDataset(id: string, sharedQueue: SharedChunkQueue, info: DatasetInfo): void {
    this.datasets.set(id, { sharedQueue, info });
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
    // For single datasets member_id === dataset_id, but for plates
    // member IDs may differ (e.g. "plateId:A/1/0").
    const memberIds = this.collectMemberIds(id);

    clearVolumeForDataset(this.volumeState, id);
    clearSliceForDataset(this.sliceState, id);
    clearVolumeForMembers(this.volumeState, memberIds);
    clearSliceForMembers(this.sliceState, memberIds);
    clearMinimapForDataset(this.minimapState, id);

    this.viewDirty = true;
    this.scheduleIfNeeded();
  }

  /** Collect member IDs associated with a dataset from state maps. */
  private collectMemberIds(dsId: string): string[] {
    const ids = new Set<string>();
    // Check volume and slice state maps for keys that belong to this dataset.
    // For single datasets, member_id === dataset_id (already cleaned by clearFor*Dataset).
    // For plates, member IDs are prefixed with the dataset ID (e.g. "dsId:A/1/0").
    const prefix = dsId + ":";
    for (const key of this.volumeState.prevTC.keys()) {
      if (key === dsId || key.startsWith(prefix)) ids.add(key);
    }
    for (const key of this.sliceState.prevTCZ.keys()) {
      if (key === dsId || key.startsWith(prefix)) ids.add(key);
    }
    // Remove the dsId itself since clearFor*Dataset already handles it
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
    };
  }

  private tick = (): void => {
    this.rafId = null;  // clear so scheduleIfNeeded can re-schedule

    if (!this.viewDirty && !this.dataDirty) return;

    const now = performance.now();
    let shouldRender = false;
    let isDataRender = false;

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
        isDataRender = true;
      }
      // else: data dirty but debounce not elapsed — still run tick for uploads, skip render
    }

    const ctx = this.buildContext();

    // Tick always runs (drives chunk uploads). shouldRender gates the expensive render pass.
    // isDataRender (data-dirty, not view-dirty) triggers sentToWorker clear for atlas reconvergence.
    if (this.mode === "slice") {
      if (tickSlice(ctx, this.sliceState, this.sliceZ, this.sliceT, this.sliceC, this.minimapState.pendingFetch, shouldRender, isDataRender)) {
        this.dataDirty = true;
      }
    } else {
      if (tickVolume(ctx, this.volumeState, this.minimapState.pendingFetch, shouldRender, isDataRender)) {
        this.dataDirty = true;
      }
    }

    if (tickMinimapOverview(ctx, this.minimapState)) this.dataDirty = true;
    if (shouldRender) tickMinimap(ctx, this.minimapState, this.sliceZ);

    // If work remains (budget exhausted or chunks pending), schedule another frame
    this.scheduleIfNeeded();
  };
}
