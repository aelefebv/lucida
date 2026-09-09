/** Main-thread API wrapping the GPU render worker. */
import type {
  Chunk,
  VolumeLayerParams,
  SliceLayerParams,
  MinimapLayerParams,
  WorkerToMainMessage,
  CapturedFrame,
  ColdStateMessage,
  ColdStateDisplayMessage,
  ColdStateSelectionMessage,
  ColdStateDeltaMessage,
  ViewHotStateMessage,
} from "./workerProtocol.ts";
import { summarizeDatasetLevels, type DatasetLevels } from "../pipeline/datasetLevels.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type {
  UploadClient,
  ChunksEvictedHandler,
  WantedSetHandler,
} from "../pipeline/upload/uploadClient.ts";

/** How long `destroy()` waits for the worker to process its `destroy`
 *  message (which ends in `self.close()`) before hard-terminating it.
 *  Calling `terminate()` immediately would discard the queued message and
 *  skip the worker-side GPU cleanup entirely; the fallback only matters for
 *  a wedged worker or one that never finished init (pre-init workers ignore
 *  `destroy`). `terminate()` on an already-closed worker is a no-op. */
const DESTROY_TERMINATE_FALLBACK_MS = 1000;

export class RenderClient implements UploadClient {
  private worker: Worker;
  private readyPromise: Promise<void>;
  private readyReject: (err: Error) => void = () => {};
  private destroyed = false;

  /** Pending `thumbnailRender` requests, keyed by the id sent to the worker.
   *  Resolved when the matching `thumbnailResult` arrives. */
  private thumbnailPending = new Map<number, (bitmap: ImageBitmap | null) => void>();
  private thumbnailSeq = 0;

  /** Pending `captureFrame` requests, keyed by the id sent to the worker.
   *  Resolved when the matching `frameCaptured` arrives. */
  private framePending = new Map<number, (frame: CapturedFrame | null) => void>();
  private frameSeq = 0;

  onIntensityRange: ((datasetId: string, min: number, max: number) => void) | null = null;
  onChunksEvicted: ChunksEvictedHandler | null = null;
  /**
   * Missing entries are a discriminated union over chunks and proxies.
   * Consumers should match on `kind === "chunk"` to handle chunk gaps.
   */
  onWantedSetDelta: WantedSetHandler | null = null;
  /**
   * The worker's level readout for one dataset changed: its target level
   * and the level on screen, summarised across its entities. Null when the
   * dataset reports no image-bearing entity.
   */
  onEntityLevels: ((datasetId: string, levels: DatasetLevels | null) => void) | null = null;

  /**
   * Summarised once per worker report, so the layer panel and the trace's
   * per-tick aggregate read the same numbers without each walking the
   * entities.
   */
  private readonly levelsByDataset = new Map<string, DatasetLevels>();

  private gpuPassUs: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const offscreen = canvas.transferControlToOffscreen();
    this.worker = new Worker(
      new URL("./gpu.worker.ts", import.meta.url),
      { type: "module" },
    );

    this.readyPromise = new Promise<void>((resolve, reject) => {
      // Kept so destroy() can settle a still-pending init (settling an
      // already-resolved promise is a no-op).
      this.readyReject = reject;
      const handler = (e: MessageEvent<WorkerToMainMessage>) => {
        if (e.data.type === "ready") {
          resolve();
          this.worker.removeEventListener("message", handler);
          this.worker.addEventListener("message", this.onMessage);
        } else if (e.data.type === "error") {
          reject(new Error(e.data.message));
          this.worker.removeEventListener("message", handler);
        }
      };
      this.worker.addEventListener("message", handler);
    });

    // Pre-attach a no-op rejection handler: the promise can reject with no
    // consumer listening (destroy() before init, or a worker init error, on
    // a client whose ready() was never awaited), and that must not surface
    // as an unhandled rejection. ready() hands out the original promise, so
    // awaiting callers still observe the rejection themselves.
    this.readyPromise.catch(() => {});

    this.worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
  }

  /** Resolves when the worker finishes init; rejects if `destroy()` runs
   *  first, so awaiting callers always settle. Safe to ignore: rejection
   *  never escapes as an unhandled rejection (see constructor). */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * The GPU pass time that arrived since the last call, in microseconds, or
   * null when none did. Taking it clears it, so each frame's figure lands on
   * one reading and a tick that drew nothing carries no GPU figure rather
   * than repeating the last one.
   */
  takeGpuPassUs(): number | null {
    const gpuPassUs = this.gpuPassUs;
    this.gpuPassUs = null;
    return gpuPassUs;
  }

  private onMessage = (e: MessageEvent<WorkerToMainMessage>) => {
    const msg = e.data;
    if (this.destroyed) {
      // The worker may still flush messages between destroy() and its own
      // exit; the only obligation left is releasing any GPU-backed bitmap.
      if (msg.type === "thumbnailResult" && msg.bitmap) msg.bitmap.close();
      return;
    }
    if (msg.type === "intensityRange" && this.onIntensityRange) {
      this.onIntensityRange(msg.datasetId, msg.min, msg.max);
    } else if (msg.type === "chunksEvicted" && this.onChunksEvicted) {
      this.onChunksEvicted(msg.memberId, msg.keys, msg.skipped ?? [], msg.reason);
    } else if (msg.type === "wantedSetDelta" && this.onWantedSetDelta) {
      this.onWantedSetDelta(msg.datasetId, msg.epochs, msg.missing);
    } else if (msg.type === "entityLevels") {
      const levels = summarizeDatasetLevels(msg.entities);
      if (levels === null) this.levelsByDataset.delete(msg.datasetId);
      else this.levelsByDataset.set(msg.datasetId, levels);
      this.onEntityLevels?.(msg.datasetId, levels);
    } else if (msg.type === "gpuPassTime") {
      // Latest wins: when two frames land between ticks, the newer one is
      // the frame on screen.
      this.gpuPassUs = msg.gpuPassUs;
    } else if (msg.type === "thumbnailResult") {
      const resolve = this.thumbnailPending.get(msg.id);
      if (resolve) {
        this.thumbnailPending.delete(msg.id);
        resolve(msg.bitmap);
      } else if (msg.bitmap) {
        // No waiter (e.g. the request was already settled/abandoned) — release
        // the GPU-backed bitmap rather than leak it.
        msg.bitmap.close();
      }
    } else if (msg.type === "frameCaptured") {
      const resolve = this.framePending.get(msg.id);
      if (resolve) {
        this.framePending.delete(msg.id);
        resolve(msg.png ? { png: msg.png, width: msg.width, height: msg.height } : null);
      }
    } else if (msg.type === "error") {
      console.error("Render worker error:", msg.message);
    }
  };

  resize(width: number, height: number) {
    this.worker.postMessage({ type: "resize", width, height });
  }

  volumeChunkData(
    memberId: string,
    chunks: { data: ArrayBuffer; dataType: string; x: number; y: number; z: number; key: string }[],
    level: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    levelDepth: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    epochs: SceneEpochs,
    tier: ResidencyTier,
  ) {
    const transferList: ArrayBuffer[] = [];
    const workerChunks: Chunk[] = chunks.map(chunk => {
      // Copy: the upstream `chunk.data` is owned by the CpuCache (see
      // `CacheEntry.data` in pipeline/fetch/types.ts). The cache holds
      // the buffer indefinitely for re-delivery after worker-side
      // eviction (`getCachedChunk`); transferring it directly would
      // detach the cache's copy and break later resends. Copy + transfer
      // keeps both sides alive.
      const buf = chunk.data.slice(0);
      transferList.push(buf);
      return { data: buf, dataType: chunk.dataType, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.worker.postMessage(
      {
        type: "volumeChunkData",
        epochs,
        tier,
        memberId,
        chunks: workerChunks,
        level, t, c,
        levelWidth, levelHeight, levelDepth,
        chunkX, chunkY, chunkZ,
      },
      transferList,
    );
  }

  labelVolumeChunkData(
    memberId: string,
    datasetId: string,
    chunks: { data: ArrayBuffer; dataType: string; x: number; y: number; z: number; key: string }[],
    level: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    levelDepth: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    epochs: SceneEpochs,
  ) {
    const transferList: ArrayBuffer[] = [];
    const workerChunks: Chunk[] = chunks.map(chunk => {
      // See note on `volumeChunkData` above — the cache reuses `chunk.data`
      // across deliveries, so we copy before transfer.
      const buf = chunk.data.slice(0);
      transferList.push(buf);
      return { data: buf, dataType: chunk.dataType, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.worker.postMessage(
      {
        type: "labelVolumeChunkData",
        epochs,
        memberId,
        datasetId,
        chunks: workerChunks,
        level, t, c,
        levelWidth, levelHeight, levelDepth,
        chunkX, chunkY, chunkZ,
      },
      transferList,
    );
  }

  sliceChunkData(
    memberId: string,
    chunks: { data: ArrayBuffer; dataType: string; x: number; y: number; z: number; key: string }[],
    level: number,
    z: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    fullResDepth: number,
    levelDepth: number,
    fullResZ: number,
    epochs: SceneEpochs,
    tier: ResidencyTier,
  ) {
    const transferList: ArrayBuffer[] = [];
    const workerChunks: Chunk[] = chunks.map(chunk => {
      // See note on `volumeChunkData` above — the cache reuses
      // `chunk.data` across deliveries, so we copy before transfer.
      const buf = chunk.data.slice(0);
      transferList.push(buf);
      return { data: buf, dataType: chunk.dataType, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.worker.postMessage(
      {
        type: "sliceChunkData",
        epochs,
        tier,
        memberId,
        chunks: workerChunks,
        level, z, t, c,
        levelWidth, levelHeight,
        chunkX, chunkY, chunkZ,
        fullResDepth, levelDepth, fullResZ,
      },
      transferList,
    );
  }

  labelSliceChunkData(
    memberId: string,
    datasetId: string,
    chunks: { data: ArrayBuffer; dataType: string; x: number; y: number; z: number; key: string }[],
    level: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    chunkX: number,
    chunkY: number,
    epochs: SceneEpochs,
  ) {
    const transferList: ArrayBuffer[] = [];
    const workerChunks: Chunk[] = chunks.map(chunk => {
      // The delivery path extracted a fresh per-plane buffer, but copy +
      // transfer keeps the API uniform with the other chunk senders.
      const buf = chunk.data.slice(0);
      transferList.push(buf);
      return { data: buf, dataType: chunk.dataType, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.worker.postMessage(
      {
        type: "labelSliceChunkData",
        epochs,
        memberId,
        datasetId,
        chunks: workerChunks,
        level,
        t, c,
        levelWidth, levelHeight,
        chunkX, chunkY,
      },
      transferList,
    );
  }

  coldState(msg: ColdStateMessage) {
    this.worker.postMessage(msg);
  }

  coldStateDisplay(msg: ColdStateDisplayMessage) {
    this.worker.postMessage(msg);
  }

  coldStateSelection(msg: ColdStateSelectionMessage) {
    this.worker.postMessage(msg);
  }

  coldStateDelta(msg: ColdStateDeltaMessage) {
    this.worker.postMessage(msg);
  }

  /**
   * Post a viewEpoch hot-state message. Sent before the corresponding
   * render message so chunk eviction has the latest ray-pick coords.
   */
  viewHotState(msg: ViewHotStateMessage) {
    this.worker.postMessage(msg);
  }

  /**
   * Forward a proxy asset to the worker. Copies the buffer before
   * transferring — the upstream `data` is owned by the CpuCache
   * (`ProxyCacheEntry.data` in pipeline/fetch/cpuCache.ts), which
   * retains it for re-delivery (`getCachedProxy`) after worker-side
   * eviction. Transferring directly would detach the cache's copy and
   * break later resends.
   */
  proxyAssetData(
    datasetId: string,
    entityId: string,
    imageId: string,
    kind: "GroupProxy3D" | "TileProxy3D",
    t: number,
    c: number,
    dims: [number, number, number],
    data: ArrayBuffer,
    epochs: SceneEpochs,
  ) {
    // Copy before transfer — see method docstring above.
    const buf = data.slice(0);
    this.worker.postMessage(
      {
        type: "proxyAssetData",
        epochs,
        datasetId,
        entityId,
        imageId,
        kind,
        t,
        c,
        dims,
        dataType: "u16",
        data: buf,
      },
      [buf],
    );
  }

  volumeRenderMultiPass(
    layers: VolumeLayerParams[],
    invViewProj: Float32Array,
    eye: Float32Array,
    canvasW: number,
    canvasH: number,
    fullW: number,
    fullH: number,
    epochs: SceneEpochs,
    viewProj?: Float32Array,
    camForward?: Float32Array,
    clipDistance?: number,
    clipMode?: number,
  ) {
    this.worker.postMessage({
      type: "volumeRenderMultiPass",
      epochs,
      layers, invViewProj, eye,
      canvasW, canvasH, fullW, fullH, viewProj,
      camForward, clipDistance, clipMode,
    });
  }

  sliceRenderMultiPass(
    layers: SliceLayerParams[],
    zoom: number,
    cx: number,
    cy: number,
    canvasW: number,
    canvasH: number,
    epochs: SceneEpochs,
  ) {
    // Aggregate quad buffers are rebuilt per render tick on the main
    // thread; transferring them avoids structured-cloning what can be
    // hundreds of KB on a wide collection.
    const transfer: Transferable[] = [];
    for (const layer of layers) {
      if (layer.aggregate) transfer.push(layer.aggregate.quads);
    }
    this.worker.postMessage({
      type: "sliceRenderMultiPass",
      epochs,
      layers, zoom, cx, cy,
      canvasW, canvasH,
    }, transfer);
  }

  minimapInit(canvas: HTMLCanvasElement) {
    const offscreen = canvas.transferControlToOffscreen();
    this.worker.postMessage({ type: "minimapInit", canvas: offscreen }, [offscreen]);
  }

  minimapRender(layers: MinimapLayerParams[], invViewProj: Float32Array, eye: Float32Array, canvasW: number, canvasH: number) {
    this.worker.postMessage({ type: "minimapRender", layers, invViewProj, eye, canvasW, canvasH });
  }

  /**
   * Render one Explore-panel candidate thumbnail off-screen and resolve with the
   * returned `ImageBitmap` (or `null` when no coarse overview is resident yet,
   * so the caller can fall back to a label-only row). Reuses the minimap's
   * overview textures + renderer; `layers` are the minimap per-member params and
   * `invViewProj`/`eye` come from the child view's camera
   * (`lucida-core::camera_matrices`). `size` is the square edge in device pixels.
   */
  thumbnailRender(
    layers: MinimapLayerParams[],
    invViewProj: Float32Array,
    eye: Float32Array,
    size: number,
  ): Promise<ImageBitmap | null> {
    if (this.destroyed) {
      // The worker can no longer answer; settle immediately (same `null`
      // that destroy() hands to in-flight requests) so callers awaiting a
      // sequence of thumbnails never hang on a dead client.
      return Promise.resolve(null);
    }
    const id = this.thumbnailSeq++;
    return new Promise<ImageBitmap | null>((resolve) => {
      this.thumbnailPending.set(id, resolve);
      this.worker.postMessage({ type: "thumbnailRender", id, layers, invViewProj, eye, size });
    });
  }

  /**
   * The frame on the worker's canvas as a PNG, for the trace bundle (#1055).
   * Resolves null when the worker could not read its canvas, and immediately
   * after destroy, so a bundle never hangs on a dead client.
   */
  captureFrame(): Promise<CapturedFrame | null> {
    if (this.destroyed) return Promise.resolve(null);
    const id = this.frameSeq++;
    return new Promise<CapturedFrame | null>((resolve) => {
      this.framePending.set(id, resolve);
      this.worker.postMessage({ type: "captureFrame", id });
    });
  }

  minimapUploadOverviewChunksForLayer(
    datasetId: string,
    chunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[],
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    levelDepth: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
  ) {
    const transferList: ArrayBuffer[] = [];
    const workerChunks: Chunk[] = chunks.map(chunk => {
      // Cast: typed-array .buffer is ArrayBufferLike under TS5.4+ lib defs;
      // runtime is always ArrayBuffer here (no SharedArrayBuffer in this app).
      const buf = chunk.data.buffer.slice(chunk.data.byteOffset, chunk.data.byteOffset + chunk.data.byteLength) as ArrayBuffer;
      transferList.push(buf);
      return { data: buf, dataType: "uint16", x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.worker.postMessage(
      {
        type: "minimapUploadOverviewChunksForLayer",
        datasetId,
        chunks: workerChunks,
        t, c,
        levelWidth, levelHeight, levelDepth,
        chunkX, chunkY, chunkZ,
      },
      transferList,
    );
  }

  updateCursorData(data: Float32Array, count: number) {
    if (count === 0) {
      this.worker.postMessage({ type: "updateCursorData", data: new ArrayBuffer(0), count: 0 });
      return;
    }
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + count * 16 * 4);
    this.worker.postMessage({ type: "updateCursorData", data: buf, count }, [buf]);
  }

  minimapDestroy() {
    this.worker.postMessage({ type: "minimapDestroy" });
  }

  removeLayerResources(datasetId: string) {
    this.levelsByDataset.delete(datasetId);
    this.worker.postMessage({ type: "removeLayerResources", datasetId });
  }

  /**
   * The worker's latest level readout for a dataset, or null before its first
   * report. What the planning tick records as the displayed level, since the
   * worker is the only side that knows which resident level each visible
   * position samples from.
   */
  datasetLevels(datasetId: string): DatasetLevels | null {
    return this.levelsByDataset.get(datasetId) ?? null;
  }

  /** Idempotent — a second call is a no-op. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // Settle any in-flight thumbnail requests so their promises don't hang
    // after the worker is gone (the id-correlated path has no fire-and-forget).
    for (const resolve of this.thumbnailPending.values()) resolve(null);
    this.thumbnailPending.clear();
    for (const resolve of this.framePending.values()) resolve(null);
    this.framePending.clear();
    // Settle a still-pending init so `ready()` awaiters don't hang (no-op
    // once the worker has reported ready).
    this.readyReject(new Error("RenderClient destroyed"));
    // The worker's destroy handler releases its GPU resources and ends with
    // `self.close()`, so the thread exits on its own once the message is
    // processed; terminate() is only the fallback for a worker that can't
    // get there (see DESTROY_TERMINATE_FALLBACK_MS).
    this.worker.postMessage({ type: "destroy" });
    setTimeout(() => this.worker.terminate(), DESTROY_TERMINATE_FALLBACK_MS);
  }
}
