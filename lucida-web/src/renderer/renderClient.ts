/** Main-thread API wrapping the GPU render worker. */
import type {
  Chunk,
  VolumeLayerParams,
  SliceLayerParams,
  MinimapLayerParams,
  WorkerToMainMessage,
  ColdStateMessage,
  ColdStateDisplayMessage,
  ColdStateSelectionMessage,
  ColdStateDeltaMessage,
  ViewHotStateMessage,
  MainToWorkerMessage,
  AggregateCacheMissMessage,
} from "./workerProtocol.ts";
import type { RenderWorkerErrorCode } from "./workerProtocol.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";
import type { ChunkContract } from "../chunkContract.ts";
import type {
  UploadClient,
  ChunksEvictedHandler,
  WantedSetHandler,
} from "../pipeline/upload/uploadClient.ts";
import {
  FRAME_STARVATION_TIMEOUT_MS,
  FrameStarvationWatchdog,
} from "./frameStarvationWatchdog.ts";
import {
  DEFAULT_MAX_RENDER_SURFACE_DIMENSION,
  validateRenderSurfaceSize,
  validateRenderViewportSize,
  type RenderSurfaceRejectionReason,
  type RenderSurfaceSize,
} from "./renderSurfaceContract.ts";

/** How long `destroy()` waits for the worker to process its `destroy`
 *  message (which ends in `self.close()`) before hard-terminating it.
 *  Calling `terminate()` immediately would discard the queued message and
 *  skip the worker-side GPU cleanup entirely; the fallback only matters for
 *  a wedged worker or one that never finished init (pre-init workers ignore
 *  `destroy`). `terminate()` on an already-closed worker is a no-op. */
const DESTROY_TERMINATE_FALLBACK_MS = 1000;
const EMPTY_AGGREGATE_QUADS = new ArrayBuffer(0);

export interface PresentedFrame {
  frameId: number;
  receivedAt: number;
  /** True only when the worker actually drew at least one main-view layer. */
  contentPresented?: boolean;
}

export type RenderSurfaceMode = "slice" | "volume" | "unspecified";
export type RenderSurfaceSource = "resize" | "slice-render" | "volume-render";

export interface RenderSurfaceAttemptSnapshot {
  readonly source: RenderSurfaceSource;
  readonly mode: RenderSurfaceMode;
  readonly width: number;
  readonly height: number;
  readonly fullWidth?: number;
  readonly fullHeight?: number;
  readonly at: number;
  readonly rejection?: RenderSurfaceRejectionReason;
}

interface RenderSurfaceModeCounters {
  readonly attempts: number;
  readonly forwarded: number;
  readonly suppressed: number;
}

export interface RenderClientRuntimeSnapshot {
  readonly frames: {
    readonly posted: number;
    readonly presented: number;
    readonly pending: number;
    readonly lastPostedFrameId: number | null;
    readonly lastPresentedFrameId: number | null;
  };
  readonly worker: {
    readonly messages: number;
    readonly lastMessageType: WorkerToMainMessage["type"] | null;
    readonly lastMessageAt: number | null;
  };
  readonly surface: {
    readonly maxDimension: number;
    readonly attempts: number;
    readonly forwarded: number;
    readonly suppressed: number;
    readonly byMode: Readonly<Record<RenderSurfaceMode, RenderSurfaceModeCounters>>;
    readonly lastAttempt: RenderSurfaceAttemptSnapshot | null;
    readonly lastForwarded: RenderSurfaceAttemptSnapshot | null;
    readonly lastSuppressed: RenderSurfaceAttemptSnapshot | null;
  };
}

export class FrameStarvationError extends Error {
  readonly code = "frame_starvation";

  constructor(ageMs: number) {
    super(
      `Renderer stopped presenting frames for ${Math.round(ageMs / 1000)} seconds ` +
      "while a view update was waiting.",
    );
    this.name = "FrameStarvationError";
  }
}

export class RenderWorkerError extends Error {
  readonly code?: RenderWorkerErrorCode;

  constructor(
    message: string,
    code?: RenderWorkerErrorCode,
  ) {
    super(message);
    this.name = "RenderWorkerError";
    this.code = code;
  }
}

export class RenderClient implements UploadClient {
  private worker: Worker;
  private readyPromise: Promise<void>;
  private readyReject: (err: Error) => void = () => {};
  private destroyed = false;
  private failure: Error | null = null;
  /** Terminal failures are visible to the hook/UI, which can recreate the one-shot canvas. */
  onFailure: ((error: Error) => void) | null = null;
  /** Recoverable worker-cache desync; the render loop schedules republish. */
  onAggregateCacheMiss: ((message: AggregateCacheMissMessage) => void) | null = null;

  /** Pending `thumbnailRender` requests, keyed by the id sent to the worker.
   *  Resolved when the matching `thumbnailResult` arrives. */
  private thumbnailPending = new Map<number, {
    resolve: (bitmap: ImageBitmap | null) => void;
    reject: (error: Error) => void;
  }>();
  private thumbnailSeq = 0;
  private frameSeq = 0;
  private postedFrameCount = 0;
  private presentedFrameCount = 0;
  private pendingFrameCount = 0;
  private lastPostedFrameId: number | null = null;
  private lastPresentedFrameId: number | null = null;
  private workerMessageCount = 0;
  private lastWorkerMessageType: WorkerToMainMessage["type"] | null = null;
  private lastWorkerMessageAt: number | null = null;
  private maxSurfaceDimension = DEFAULT_MAX_RENDER_SURFACE_DIMENSION;
  private surfaceAttempts = 0;
  private surfaceForwarded = 0;
  private surfaceSuppressed = 0;
  private readonly surfaceByMode: Record<RenderSurfaceMode, {
    attempts: number;
    forwarded: number;
    suppressed: number;
  }> = {
    slice: { attempts: 0, forwarded: 0, suppressed: 0 },
    volume: { attempts: 0, forwarded: 0, suppressed: 0 },
    unspecified: { attempts: 0, forwarded: 0, suppressed: 0 },
  };
  private lastSurfaceAttempt: RenderSurfaceAttemptSnapshot | null = null;
  private lastSurfaceForwarded: RenderSurfaceAttemptSnapshot | null = null;
  private lastSurfaceSuppressed: RenderSurfaceAttemptSnapshot | null = null;
  /** Aggregate geometry already resident in this worker instance. */
  private readonly publishedAggregateKeys = new Set<string>();
  private readonly aggregateOwnerByKey = new Map<string, string>();
  /** Current key for each worker-owned dataset/channel cache slot. */
  private readonly aggregateKeyByOwner = new Map<string, string>();
  private presentedListeners = new Set<(frame: PresentedFrame) => void>();
  private readonly frameStarvationWatchdog: FrameStarvationWatchdog;
  private readonly onVisibilityChange = (): void => {
    this.frameStarvationWatchdog.visibilityChanged();
  };

  onIntensityRange: ((datasetId: string, channel: number, min: number, max: number) => void) | null = null;
  onChunksEvicted: ChunksEvictedHandler | null = null;
  /**
   * Missing entries are a discriminated union over chunks and proxies.
   * Consumers should match on `kind === "chunk"` to handle chunk gaps.
   */
  onWantedSetDelta: WantedSetHandler | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.frameStarvationWatchdog = new FrameStarvationWatchdog({
      timeoutMs: FRAME_STARVATION_TIMEOUT_MS,
      onStarved: ({ ageMs }) => this.enterFailure(new FrameStarvationError(ageMs)),
    });
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }

    // Acquiring the one-shot canvas and constructing a module worker are both
    // synchronous browser boundaries. They can throw (unsupported/blocked
    // OffscreenCanvas, CSP, worker resource exhaustion) before `ready()` and
    // `onFailure` exist. Roll back the main-thread resources installed above;
    // the React owner will surface the exception and retry with a fresh canvas.
    let offscreen: OffscreenCanvas;
    try {
      offscreen = canvas.transferControlToOffscreen();
      this.worker = new Worker(
        new URL("./gpu.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (error) {
      this.stopFrameStarvationWatchdog();
      throw error;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      // Kept so destroy() can settle a still-pending init (settling an
      // already-resolved promise is a no-op).
      this.readyReject = reject;
      const handler = (e: MessageEvent<WorkerToMainMessage>) => {
        this.recordWorkerMessage(e.data);
        if (e.data.type === "ready") {
          const maxDimension = e.data.maxTextureDimension2D;
          if (
            maxDimension !== undefined &&
            Number.isSafeInteger(maxDimension) &&
            maxDimension > 0
          ) {
            this.maxSurfaceDimension = maxDimension;
          }
          resolve();
          this.worker.removeEventListener("message", handler);
          this.worker.addEventListener("message", this.onMessage);
        } else if (e.data.type === "error") {
          this.worker.removeEventListener("message", handler);
          this.enterFailure(new RenderWorkerError(e.data.message, e.data.code));
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

    // Module-load/runtime crashes and structured-clone failures do not produce
    // normal worker messages. Observe both from construction onward so startup
    // and steady-state requests share the same exactly-once settle path.
    this.worker.addEventListener("error", this.onWorkerError);
    this.worker.addEventListener("messageerror", this.onWorkerMessageError);

    this.post({ type: "init", canvas: offscreen }, [offscreen]);
  }

  /** Resolves when the worker finishes init; rejects if `destroy()` runs
   *  first, so awaiting callers always settle. Safe to ignore: rejection
   *  never escapes as an unhandled rejection (see constructor). */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private onMessage = (e: MessageEvent<WorkerToMainMessage>) => {
    const msg = e.data;
    this.recordWorkerMessage(msg);
    if (this.destroyed) {
      // The worker may still flush messages between destroy() and its own
      // exit; the only obligation left is releasing any GPU-backed bitmap.
      if (msg.type === "thumbnailResult" && msg.bitmap) msg.bitmap.close();
      return;
    }
    if (msg.type === "intensityRange" && this.onIntensityRange) {
      this.onIntensityRange(msg.datasetId, msg.channel, msg.min, msg.max);
    } else if (msg.type === "chunksEvicted" && this.onChunksEvicted) {
      this.onChunksEvicted(
        msg.datasetId,
        msg.memberId,
        msg.tier,
        msg.keys,
        msg.skipped ?? [],
        msg.reason,
      );
    } else if (msg.type === "wantedSetDelta" && this.onWantedSetDelta) {
      this.onWantedSetDelta(msg.datasetId, msg.epochs, msg.missing);
    } else if (msg.type === "thumbnailResult") {
      const pending = this.thumbnailPending.get(msg.id);
      if (pending) {
        this.thumbnailPending.delete(msg.id);
        pending.resolve(msg.bitmap);
      } else if (msg.bitmap) {
        // No waiter (e.g. the request was already settled/abandoned) — release
        // the GPU-backed bitmap rather than leak it.
        msg.bitmap.close();
      }
    } else if (msg.type === "framePresented") {
      const frame = {
        frameId: msg.frameId,
        receivedAt: performance.now(),
        contentPresented: msg.contentPresented === true,
      };
      this.presentedFrameCount++;
      this.pendingFrameCount = Math.max(0, this.pendingFrameCount - 1);
      this.lastPresentedFrameId = msg.frameId;
      this.frameStarvationWatchdog.presented(msg.frameId);
      for (const listener of this.presentedListeners) listener(frame);
    } else if (msg.type === "aggregateCacheMiss") {
      this.pendingFrameCount = Math.max(0, this.pendingFrameCount - 1);
      // Forget only the missed generation. A delayed miss from a superseded
      // frame must not evict a newer key already occupying the same owner slot.
      this.publishedAggregateKeys.delete(msg.cacheKey);
      this.aggregateOwnerByKey.delete(msg.cacheKey);
      if (this.aggregateKeyByOwner.get(msg.cacheOwnerKey) === msg.cacheKey) {
        this.aggregateKeyByOwner.delete(msg.cacheOwnerKey);
      }
      this.onAggregateCacheMiss?.(msg);
    } else if (msg.type === "error") {
      this.enterFailure(new RenderWorkerError(msg.message, msg.code));
    }
  };

  private onWorkerError = (event: ErrorEvent): void => {
    event.preventDefault?.();
    this.enterFailure(new Error(event.message || "Render worker crashed"));
  };

  private onWorkerMessageError = (): void => {
    this.enterFailure(new Error("Render worker message could not be deserialized"));
  };

  private recordWorkerMessage(message: WorkerToMainMessage): void {
    this.workerMessageCount++;
    this.lastWorkerMessageType = message.type;
    this.lastWorkerMessageAt = performance.now();
  }

  /** Settle all promises/callbacks once and enter a retryable terminal state. */
  private enterFailure(error: Error): void {
    if (this.destroyed || this.failure) return;
    this.failure = error;
    this.stopFrameStarvationWatchdog();
    this.readyReject(error);
    for (const pending of this.thumbnailPending.values()) pending.reject(error);
    this.thumbnailPending.clear();
    this.presentedListeners.clear();
    this.onFailure?.(error);
    // A failed worker cannot be trusted to run its normal cleanup message.
    // terminate() is the browser's terminal recovery boundary; device-lost
    // cleanup is also performed worker-side before its fatal error is posted.
    this.worker.terminate();
  }

  /** Post only while the worker is live; synchronous clone failures become terminal. */
  private post(message: MainToWorkerMessage, transfer?: Transferable[]): boolean {
    if (this.destroyed || this.failure) return false;
    try {
      this.worker.postMessage(message, transfer ?? []);
      return true;
    } catch (err) {
      this.enterFailure(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  subscribeFramePresented(listener: (frame: PresentedFrame) => void): () => void {
    this.presentedListeners.add(listener);
    return () => this.presentedListeners.delete(listener);
  }

  /**
   * Arm end-to-end progress detection before the render loop enters RAF. The
   * next main-view frame adopts this id when submitted, so scheduling and GPU
   * completion share one deadline. Repeated dirty signals coalesce on the
   * same next frame without resetting its age.
   */
  expectNextMainFrame(): number {
    const frameId = this.frameSeq + 1;
    this.frameStarvationWatchdog.expected(frameId);
    return frameId;
  }

  /** Cancel only pre-submission expectations during intentional loop pauses. */
  cancelUnsubmittedFrameExpectations(): void {
    this.frameStarvationWatchdog.cancelUnsubmitted();
  }

  /**
   * Bounded, read-only acceptance telemetry. Counters and the last observation
   * are sufficient for idle/resize deltas without retaining frame history or
   * dataset/user content.
   */
  getRuntimeSnapshot(): RenderClientRuntimeSnapshot {
    return {
      frames: {
        posted: this.postedFrameCount,
        presented: this.presentedFrameCount,
        pending: this.pendingFrameCount,
        lastPostedFrameId: this.lastPostedFrameId,
        lastPresentedFrameId: this.lastPresentedFrameId,
      },
      worker: {
        messages: this.workerMessageCount,
        lastMessageType: this.lastWorkerMessageType,
        lastMessageAt: this.lastWorkerMessageAt,
      },
      surface: {
        maxDimension: this.maxSurfaceDimension,
        attempts: this.surfaceAttempts,
        forwarded: this.surfaceForwarded,
        suppressed: this.surfaceSuppressed,
        byMode: {
          slice: { ...this.surfaceByMode.slice },
          volume: { ...this.surfaceByMode.volume },
          unspecified: { ...this.surfaceByMode.unspecified },
        },
        lastAttempt: this.lastSurfaceAttempt && { ...this.lastSurfaceAttempt },
        lastForwarded: this.lastSurfaceForwarded && { ...this.lastSurfaceForwarded },
        lastSuppressed: this.lastSurfaceSuppressed && { ...this.lastSurfaceSuppressed },
      },
    };
  }

  private admitSurface(args: {
    source: RenderSurfaceSource;
    mode: RenderSurfaceMode;
    width: number;
    height: number;
    fullWidth?: number;
    fullHeight?: number;
  }): {
    attempt: RenderSurfaceAttemptSnapshot;
    canvas: RenderSurfaceSize;
    full?: RenderSurfaceSize;
  } | null {
    this.surfaceAttempts++;
    this.surfaceByMode[args.mode].attempts++;
    const at = performance.now();
    const canvas = validateRenderSurfaceSize(
      args.width,
      args.height,
      this.maxSurfaceDimension,
    );
    const full = args.fullWidth === undefined || args.fullHeight === undefined
      ? null
      : validateRenderViewportSize(args.fullWidth, args.fullHeight);
    const rejection = !canvas.ok
      ? canvas.reason
      : full !== null && !full.ok
        ? full.reason
        : undefined;
    const attempt: RenderSurfaceAttemptSnapshot = {
      source: args.source,
      mode: args.mode,
      width: args.width,
      height: args.height,
      ...(args.fullWidth === undefined ? {} : { fullWidth: args.fullWidth }),
      ...(args.fullHeight === undefined ? {} : { fullHeight: args.fullHeight }),
      at,
      ...(rejection ? { rejection } : {}),
    };
    this.lastSurfaceAttempt = attempt;
    if (rejection || !canvas.ok || (full !== null && !full.ok)) {
      this.surfaceSuppressed++;
      this.surfaceByMode[args.mode].suppressed++;
      this.lastSurfaceSuppressed = attempt;
      // A dirty RenderLoop may already have armed the next frame. No worker
      // submission will retire it, so cancel only that pre-submission promise.
      this.frameStarvationWatchdog.cancelUnsubmitted();
      return null;
    }
    return {
      attempt,
      canvas: canvas.size,
      ...(full?.ok ? { full: full.size } : {}),
    };
  }

  private markSurfaceForwarded(attempt: RenderSurfaceAttemptSnapshot): void {
    this.surfaceForwarded++;
    this.surfaceByMode[attempt.mode].forwarded++;
    this.lastSurfaceForwarded = attempt;
  }

  private recordPostedFrame(frameId: number): void {
    this.postedFrameCount++;
    this.pendingFrameCount++;
    this.lastPostedFrameId = frameId;
  }

  resize(
    width: number,
    height: number,
    mode: RenderSurfaceMode = "unspecified",
  ): boolean {
    const admitted = this.admitSurface({
      source: "resize",
      mode,
      width,
      height,
    });
    if (!admitted) return false;
    const posted = this.post({
      type: "resize",
      width: admitted.canvas.width,
      height: admitted.canvas.height,
    });
    if (posted) this.markSurfaceForwarded(admitted.attempt);
    return posted;
  }

  volumeChunkData(
    memberId: string,
    datasetId: string,
    chunks: Chunk[],
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
      return { data: buf, contract: chunk.contract, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.post(
      {
        type: "volumeChunkData",
        epochs,
        tier,
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

  labelVolumeChunkData(
    memberId: string,
    datasetId: string,
    chunks: Chunk[],
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
      return { data: buf, contract: chunk.contract, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.post(
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
    datasetId: string,
    chunks: Chunk[],
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
      return { data: buf, contract: chunk.contract, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.post(
      {
        type: "sliceChunkData",
        epochs,
        tier,
        memberId,
        datasetId,
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
    chunks: Chunk[],
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
      return { data: buf, contract: chunk.contract, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.post(
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
    this.post(msg);
  }

  coldStateDisplay(msg: ColdStateDisplayMessage) {
    this.post(msg);
  }

  coldStateSelection(msg: ColdStateSelectionMessage) {
    this.post(msg);
  }

  coldStateDelta(msg: ColdStateDeltaMessage) {
    this.post(msg);
  }

  /**
   * Post a viewEpoch hot-state message. Sent before the corresponding
   * render message so chunk eviction has the latest ray-pick coords.
   */
  viewHotState(msg: ViewHotStateMessage) {
    this.post(msg);
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
  ): boolean {
    const admitted = this.admitSurface({
      source: "volume-render",
      mode: "volume",
      width: canvasW,
      height: canvasH,
      fullWidth: fullW,
      fullHeight: fullH,
    });
    if (!admitted?.full) return false;
    const frameId = ++this.frameSeq;
    const posted = this.post({
      type: "volumeRenderMultiPass",
      frameId,
      epochs,
      layers, invViewProj, eye,
      canvasW: admitted.canvas.width,
      canvasH: admitted.canvas.height,
      fullW: admitted.full.width,
      fullH: admitted.full.height,
      viewProj,
      camForward, clipDistance, clipMode,
    });
    if (posted) {
      this.markSurfaceForwarded(admitted.attempt);
      this.recordPostedFrame(frameId);
    }
    if (posted && layers.length > 0) {
      this.frameStarvationWatchdog.submitted(frameId);
    }
    return posted;
  }

  sliceRenderMultiPass(
    layers: SliceLayerParams[],
    zoom: number,
    cx: number,
    cy: number,
    canvasW: number,
    canvasH: number,
    epochs: SceneEpochs,
  ): boolean {
    const admitted = this.admitSurface({
      source: "slice-render",
      mode: "slice",
      width: canvasW,
      height: canvasH,
    });
    if (!admitted) return false;
    const frameId = ++this.frameSeq;
    // Cached aggregate geometry is copied + transferred exactly once to this
    // worker. The canonical main-thread buffer stays intact so a renderer
    // restart can republish it; later camera-only frames carry only the key.
    const transfer: Transferable[] = [];
    const publishing = new Set<string>();
    let wireLayers: SliceLayerParams[] | null = null;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const aggregate = layer.aggregate;
      if (!aggregate) continue;
      if (!aggregate.cacheKey) {
        // Uncached callers retain the historical transfer contract.
        transfer.push(aggregate.quads);
        continue;
      }
      wireLayers ??= layers.slice();
      if (
        this.publishedAggregateKeys.has(aggregate.cacheKey) ||
        publishing.has(aggregate.cacheKey)
      ) {
        wireLayers[i] = {
          ...layer,
          aggregate: { ...aggregate, quads: EMPTY_AGGREGATE_QUADS },
        };
        continue;
      }
      const publishedQuads = aggregate.quads.slice(0);
      wireLayers[i] = {
        ...layer,
        aggregate: { ...aggregate, quads: publishedQuads },
      };
      transfer.push(publishedQuads);
      publishing.add(aggregate.cacheKey);
    }
    const posted = this.post({
      type: "sliceRenderMultiPass",
      frameId,
      epochs,
      layers: wireLayers ?? layers, zoom, cx, cy,
      canvasW: admitted.canvas.width,
      canvasH: admitted.canvas.height,
    }, transfer);
    if (posted) {
      this.markSurfaceForwarded(admitted.attempt);
      this.recordPostedFrame(frameId);
      for (const key of publishing) {
        const aggregate = layers.find(
          (layer) => layer.aggregate?.cacheKey === key,
        )?.aggregate;
        const ownerKey = aggregate?.cacheOwnerKey ?? key;
        const superseded = this.aggregateKeyByOwner.get(ownerKey);
        if (superseded && superseded !== key) {
          // The worker replaces this same owner slot atomically when it sees
          // the new geometry. Mirror that lifecycle so main-thread residency
          // knowledge stays bounded to one key per dataset/channel too.
          this.publishedAggregateKeys.delete(superseded);
          this.aggregateOwnerByKey.delete(superseded);
        }
        this.publishedAggregateKeys.add(key);
        this.aggregateKeyByOwner.set(ownerKey, key);
        const owner = aggregate?.ownerDatasetId;
        if (owner) this.aggregateOwnerByKey.set(key, owner);
      }
    }
    if (posted && layers.length > 0) {
      this.frameStarvationWatchdog.submitted(frameId);
    }
    return posted;
  }

  minimapInit(canvas: HTMLCanvasElement) {
    const offscreen = canvas.transferControlToOffscreen();
    this.post({ type: "minimapInit", canvas: offscreen }, [offscreen]);
  }

  minimapRender(layers: MinimapLayerParams[], invViewProj: Float32Array, eye: Float32Array, canvasW: number, canvasH: number) {
    this.post({ type: "minimapRender", layers, invViewProj, eye, canvasW, canvasH });
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
    if (this.failure) return Promise.reject(this.failure);
    const id = this.thumbnailSeq++;
    return new Promise<ImageBitmap | null>((resolve, reject) => {
      this.thumbnailPending.set(id, { resolve, reject });
      this.post({ type: "thumbnailRender", id, layers, invViewProj, eye, size });
    });
  }

  minimapUploadOverviewChunksForLayer(
    datasetId: string,
    chunks: {
      data: Uint16Array;
      contract: ChunkContract;
      x: number;
      y: number;
      z: number;
      key: string;
    }[],
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
      return {
        data: buf,
        contract: chunk.contract,
        x: chunk.x,
        y: chunk.y,
        z: chunk.z,
        key: chunk.key,
      };
    });
    this.post(
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
      this.post({ type: "updateCursorData", data: new ArrayBuffer(0), count: 0 });
      return;
    }
    const buf = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + count * 16 * 4,
    ) as ArrayBuffer;
    this.post({ type: "updateCursorData", data: buf, count }, [buf]);
  }

  minimapDestroy() {
    this.post({ type: "minimapDestroy" });
  }

  removeLayerResources(datasetId: string) {
    for (const [key, owner] of this.aggregateOwnerByKey) {
      if (owner !== datasetId) continue;
      this.aggregateOwnerByKey.delete(key);
      this.publishedAggregateKeys.delete(key);
      for (const [ownerKey, currentKey] of this.aggregateKeyByOwner) {
        if (currentKey === key) this.aggregateKeyByOwner.delete(ownerKey);
      }
    }
    this.post({ type: "removeLayerResources", datasetId });
  }

  /** Idempotent — a second call is a no-op. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // Settle any in-flight thumbnail requests so their promises don't hang
    // after the worker is gone (the id-correlated path has no fire-and-forget).
    for (const pending of this.thumbnailPending.values()) pending.resolve(null);
    this.thumbnailPending.clear();
    this.presentedListeners.clear();
    this.stopFrameStarvationWatchdog();
    this.onFailure = null;
    this.onAggregateCacheMiss = null;
    this.worker.removeEventListener("error", this.onWorkerError);
    this.worker.removeEventListener("messageerror", this.onWorkerMessageError);
    // Settle a still-pending init so `ready()` awaiters don't hang (no-op
    // once the worker has reported ready).
    this.readyReject(new Error("RenderClient destroyed"));
    // The worker's destroy handler releases its GPU resources and ends with
    // `self.close()`, so the thread exits on its own once the message is
    // processed; terminate() is only the fallback for a worker that can't
    // get there (see DESTROY_TERMINATE_FALLBACK_MS).
    if (!this.failure) {
      this.worker.postMessage({ type: "destroy" });
      setTimeout(() => this.worker.terminate(), DESTROY_TERMINATE_FALLBACK_MS);
    }
  }

  private stopFrameStarvationWatchdog(): void {
    this.frameStarvationWatchdog.stop();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
  }
}
