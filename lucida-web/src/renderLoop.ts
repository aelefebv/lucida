/** Pull-based render loop: coalesces chunk arrivals into a single RAF tick. */
import type { DatasetInfo } from "./zarr/metadata.ts";
import type { SharedChunkQueue } from "./zarr/chunkStore.ts";
import type { TickContext, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";
import { UPLOAD_BUDGET_BYTES } from "./renderLoopTypes.ts";
import { type SliceState, createSliceState, tickSlice, clearSliceForDataset, clearSliceForMembers } from "./slicePath.ts";
import { type VolumeState, createVolumeState, tickVolume, clearVolumeForDataset, clearVolumeForMembers, resetVolumeState } from "./volumePath.ts";
import { type MinimapState, createMinimapState, tickMinimapOverview, tickMinimap, markMinimapOverviewSeeded, clearMinimapForDataset } from "./minimapPath.ts";
import { bufferToUint16 } from "./zarr/dtypeConvert.ts";

// Re-export types so downstream imports stay unchanged
export type { DatasetEntry, RenderLoopOptions, MinimapOverlayData } from "./renderLoopTypes.ts";

export class RenderLoop {
  private scene: RenderLoopOptions["scene"];
  private datasets: Map<string, { sharedQueue: SharedChunkQueue; info: DatasetInfo }>;
  private client: RenderLoopOptions["client"];
  private canvas: HTMLCanvasElement;
  private mode: "slice" | "volume";

  private dirty = true;
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
        this.dirty = true;
        this.scheduleIfNeeded();
      }));
    }

    // Handle chunk data requests from the worker
    this.client.onChunkDataRequest = (
      datasetId, keys, mode,
      level, t, c,
      levelWidth, levelHeight, levelDepth,
      chunkX, chunkY, chunkZ,
      hitLocal,
      z, fullResDepth, fullResZ,
    ) => {
      this.handleChunkDataRequest(
        datasetId, keys, mode,
        level, t, c,
        levelWidth, levelHeight, levelDepth,
        chunkX, chunkY, chunkZ,
        hitLocal,
        z, fullResDepth, fullResZ,
      );
    };

    this.dirty = true;
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
    this.client.onChunkDataRequest = null;
  }

  /** Fulfill a chunk data request from the worker within upload budget. */
  private handleChunkDataRequest(
    datasetId: string,
    keys: string[],
    mode: "slice" | "volume",
    level: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    levelDepth: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    hitLocal: [number, number, number],
    z?: number,
    fullResDepth?: number,
    fullResZ?: number,
  ): void {
    // Find the SharedChunkQueue and DatasetInfo for this member
    let queue: SharedChunkQueue | null = null;
    let dsInfo: DatasetInfo | null = null;
    for (const [, ds] of this.datasets) {
      if (ds.sharedQueue.hasMember(datasetId)) {
        queue = ds.sharedQueue;
        dsInfo = ds.info;
        break;
      }
    }
    if (!queue || !dsInfo) return;

    const levelMeta = dsInfo.levels[level];
    if (!levelMeta) return;

    let budget = UPLOAD_BUDGET_BYTES;
    const chunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
    for (const key of keys) {
      const buf = queue.get(datasetId, key);
      if (!buf || buf.byteLength === 0) continue;
      // Parse key to get coords: "level/t/c/z/y/x"
      const parts = key.split("/").map(Number);
      const [, , , kz, ky, kx] = parts;
      chunks.push({ data: bufferToUint16(buf, levelMeta.dataType), x: kx, y: ky, z: kz, key });
      budget -= buf.byteLength;
      if (budget <= 0) break;
    }

    if (chunks.length > 0) {
      if (mode === "volume") {
        this.client.volumeChunkData(
          datasetId, chunks,
          level, t, c,
          levelWidth, levelHeight, levelDepth,
          chunkX, chunkY, chunkZ,
          hitLocal,
        );
      } else if (mode === "slice") {
        this.client.sliceChunkData(
          datasetId, chunks,
          level, z!, t, c,
          levelWidth, levelHeight,
          chunkX, chunkY, chunkZ,
          fullResDepth!, levelDepth, fullResZ!,
        );
      }
    }

    if (budget <= 0) {
      this.dirty = true;
      this.scheduleIfNeeded();
    }
  }

  addDataset(id: string, sharedQueue: SharedChunkQueue, info: DatasetInfo): void {
    this.datasets.set(id, { sharedQueue, info });
    this.unsubs.set(id, sharedQueue.subscribe(() => {
      this.dirty = true;
      this.scheduleIfNeeded();
    }));
    this.dirty = true;
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

    this.dirty = true;
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

  markDirty(): void {
    this.dirty = true;
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
      this.dirty = true;
      this.scheduleIfNeeded();
    }
  }

  setRenderScale(s: number): void {
    this._renderScale = s;
    this.dirty = true;
    this.scheduleIfNeeded();
  }

  setMinimap(enabled: boolean, size?: number, overlayCallback?: ((data: MinimapOverlayData) => void) | null): void {
    this.minimapState.enabled = enabled;
    if (size !== undefined) this.minimapState.size = size;
    this.minimapState.overlayCallback = overlayCallback ?? null;
    if (enabled) {
      this.dirty = true;
      this.scheduleIfNeeded();
    }
  }

  markMinimapOverviewSeeded(datasetId: string, t: number, c: number): void {
    const ctx = this.buildContext();
    markMinimapOverviewSeeded(ctx, this.minimapState, datasetId, t, c);
  }

  private scheduleIfNeeded(): void {
    if (this.dirty && this.rafId === null) {
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
    if (!this.dirty) return;  // quiesce — no reschedule
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

    // If work remains (budget exhausted or chunks pending), schedule another frame
    this.scheduleIfNeeded();
  };
}
