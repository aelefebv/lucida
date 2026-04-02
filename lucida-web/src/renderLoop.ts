/** Pull-based render loop: coalesces chunk arrivals into a single RAF tick. */
import type { DatasetInfo } from "./zarr/metadata.ts";
import { ChunkStore } from "./zarr/chunkStore.ts";
import type { TickContext, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";
import { type SliceState, createSliceState, tickSlice, clearSliceForDataset, clearSliceForMembers } from "./slicePath.ts";
import { type VolumeState, createVolumeState, tickVolume, clearVolumeForDataset, clearVolumeForMembers, resetVolumeState } from "./volumePath.ts";
import { type MinimapState, createMinimapState, tickMinimapOverview, tickMinimap, markMinimapOverviewSeeded, clearMinimapForDataset } from "./minimapPath.ts";

// Re-export types so downstream imports stay unchanged
export type { DatasetEntry, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";

export class RenderLoop {
  private scene: RenderLoopOptions["scene"];
  private datasets: Map<string, { memberStores: Map<string, ChunkStore>; info: DatasetInfo }>;
  private client: RenderLoopOptions["client"];
  private canvas: HTMLCanvasElement;
  private mode: "slice" | "volume";

  private dirty = true;
  private rafId: number | null = null;
  private unsubs = new Map<string, (() => void)[]>();

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
      this.datasets.set(id, { memberStores: entry.memberStores, info: entry.info });
    }
    this.client = opts.client;
    this.canvas = opts.canvas;
    this.mode = opts.mode;
  }

  start(): void {
    // Subscribe to all member stores in all datasets
    for (const [id, ds] of this.datasets) {
      const unsubs: (() => void)[] = [];
      for (const store of ds.memberStores.values()) {
        unsubs.push(store.subscribe(() => {
          this.dirty = true;
        }));
      }
      this.unsubs.set(id, unsubs);
    }
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    for (const unsubs of this.unsubs.values()) {
      for (const unsub of unsubs) unsub();
    }
    this.unsubs.clear();
  }

  addDataset(id: string, memberStores: Map<string, ChunkStore>, info: DatasetInfo): void {
    this.datasets.set(id, { memberStores, info });
    const unsubs: (() => void)[] = [];
    for (const store of memberStores.values()) {
      unsubs.push(store.subscribe(() => {
        this.dirty = true;
      }));
    }
    this.unsubs.set(id, unsubs);
    this.dirty = true;
  }

  removeDataset(id: string): void {
    const unsubs = this.unsubs.get(id);
    if (unsubs) {
      for (const unsub of unsubs) unsub();
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

    this.dirty = true;
  }

  /** Collect member IDs associated with a dataset from state maps. */
  private collectMemberIds(dsId: string): string[] {
    const ids = new Set<string>();
    // Check volume and slice state maps for keys that belong to this dataset.
    // For single datasets, member_id === dataset_id (already cleaned by clearFor*Dataset).
    // For plates, member IDs are prefixed with the dataset ID (e.g. "dsId:A/1/0").
    const prefix = dsId + ":";
    for (const key of this.volumeState.uploaded.keys()) {
      if (key === dsId || key.startsWith(prefix)) ids.add(key);
    }
    for (const key of this.volumeState.lodKeys.keys()) {
      if (key === dsId || key.startsWith(prefix)) ids.add(key);
    }
    for (const key of this.sliceState.uploaded.keys()) {
      if (key === dsId || key.startsWith(prefix)) ids.add(key);
    }
    for (const key of this.sliceState.currentLod.keys()) {
      if (key === dsId || key.startsWith(prefix)) ids.add(key);
    }
    // Remove the dsId itself since clearFor*Dataset already handles it
    ids.delete(dsId);
    return [...ids];
  }

  markDirty(): void {
    this.dirty = true;
  }

  resetVolumeCache(): void {
    resetVolumeState(this.volumeState);
  }

  setSliceParams(z: number, t: number, c: number): void {
    if (z !== this.sliceZ || t !== this.sliceT || c !== this.sliceC) {
      this.sliceZ = z;
      this.sliceT = t;
      this.sliceC = c;
      this.dirty = true;
    }
  }

  setRenderScale(s: number): void {
    this._renderScale = s;
    this.dirty = true;
  }

  setMinimap(enabled: boolean, size?: number, overlayCallback?: ((data: MinimapOverlayData) => void) | null): void {
    this.minimapState.enabled = enabled;
    if (size !== undefined) this.minimapState.size = size;
    this.minimapState.overlayCallback = overlayCallback ?? null;
    if (enabled) this.dirty = true;
  }

  markMinimapOverviewSeeded(datasetId: string, t: number, c: number): void {
    const ctx = this.buildContext();
    markMinimapOverviewSeeded(ctx, this.minimapState, datasetId, t, c);
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
    if (!this.dirty) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    this.dirty = false;

    const ctx = this.buildContext();

    if (this.mode === "slice") {
      if (tickSlice(ctx, this.sliceState, this.sliceZ, this.sliceT, this.sliceC, this.minimapState.pendingFetch)) {
        this.dirty = true;
      }
    } else {
      if (tickVolume(ctx, this.volumeState, this.minimapState.pendingFetch)) {
        this.dirty = true;
      }
    }

    if (tickMinimapOverview(ctx, this.minimapState)) this.dirty = true;
    tickMinimap(ctx, this.minimapState, this.sliceZ);

    this.rafId = requestAnimationFrame(this.tick);
  };
}
