/** Main-thread API wrapping the GPU render worker. */
import type {
  Chunk,
  VolumeLayerParams,
  SliceLayerParams,
  MinimapLayerParams,
  WorkerToMainMessage,
  ColdStateMessage,
  ViewHotStateMessage,
} from "./workerProtocol.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";
import type {
  UploadClient,
  ChunksEvictedHandler,
  WantedSetHandler,
} from "../pipeline/upload/uploadClient.ts";

export class RenderClient implements UploadClient {
  private worker: Worker;
  private readyPromise: Promise<void>;

  /** Pending `thumbnailRender` requests, keyed by the id sent to the worker.
   *  Resolved when the matching `thumbnailResult` arrives. */
  private thumbnailPending = new Map<number, (bitmap: ImageBitmap | null) => void>();
  private thumbnailSeq = 0;

  onIntensityRange: ((datasetId: string, min: number, max: number) => void) | null = null;
  onChunksEvicted: ChunksEvictedHandler | null = null;
  /**
   * Missing entries are a discriminated union over chunks and proxies.
   * Consumers should match on `kind === "chunk"` to handle chunk gaps.
   */
  onWantedSetDelta: WantedSetHandler | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const offscreen = canvas.transferControlToOffscreen();
    this.worker = new Worker(
      new URL("./gpu.worker.ts", import.meta.url),
      { type: "module" },
    );

    this.readyPromise = new Promise<void>((resolve, reject) => {
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

    this.worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  private onMessage = (e: MessageEvent<WorkerToMainMessage>) => {
    const msg = e.data;
    if (msg.type === "intensityRange" && this.onIntensityRange) {
      this.onIntensityRange(msg.datasetId, msg.min, msg.max);
    } else if (msg.type === "chunksEvicted" && this.onChunksEvicted) {
      this.onChunksEvicted(msg.memberId, msg.keys, msg.skipped ?? [], msg.reason);
    } else if (msg.type === "wantedSetDelta" && this.onWantedSetDelta) {
      this.onWantedSetDelta(msg.datasetId, msg.epochs, msg.missing);
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
    tier?: "detail" | "coarse",
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
    tier?: "detail" | "coarse",
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
    kind: "WellProxy3D" | "FieldProxy3D",
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
    this.worker.postMessage({
      type: "sliceRenderMultiPass",
      epochs,
      layers, zoom, cx, cy,
      canvasW, canvasH,
    });
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
    const id = this.thumbnailSeq++;
    return new Promise<ImageBitmap | null>((resolve) => {
      this.thumbnailPending.set(id, resolve);
      this.worker.postMessage({ type: "thumbnailRender", id, layers, invViewProj, eye, size });
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
    this.worker.postMessage({ type: "removeLayerResources", datasetId });
  }

  destroy() {
    // Settle any in-flight thumbnail requests so their promises don't hang
    // after the worker is gone (the id-correlated path has no fire-and-forget).
    for (const resolve of this.thumbnailPending.values()) resolve(null);
    this.thumbnailPending.clear();
    this.worker.postMessage({ type: "destroy" });
    this.worker.terminate();
  }
}
