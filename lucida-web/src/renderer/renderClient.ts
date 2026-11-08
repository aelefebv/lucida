/** Main-thread API wrapping the GPU render worker. */
import type {
  CanvasColors,
  Chunk,
  InitMessage,
  VolumeLayerParams,
  SliceLayerParams,
  MinimapLayerParams,
  MinimapRenderMessage,
  ThumbnailRenderMessage,
  WorkerToMainMessage,
  CaptureFailure,
  FrameCaptureResult,
  GpuCapacityReport,
  GpuMemoryReport,
  ColdStateMessage,
  ColdStateDisplayMessage,
  ColdStateSelectionMessage,
  ColdStateDeltaMessage,
  FailedChunksMessage,
  ViewHotStateMessage,
  RgbaColor,
  MinimapUploadOverviewChunksForLayerMessage,
  GpuErrorMessage,
  GpuDeviceRestoredMessage,
  GpuFailedMessage,
  ProbeMessage,
  ProbeSample,
} from "./workerProtocol.ts";
import type { SampleFormat } from "./dataTypeUtil.ts";
import { summarizeDatasetLevels, type DatasetLevels } from "../pipeline/datasetLevels.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type {
  UploadClient,
  ChunkResidencyHandler,
  WantedSetHandler,
} from "../pipeline/upload/uploadClient.ts";
import { tokenColor } from "../theme/tokenColors.ts";
import type { ResolvedColor } from "../theme/tokens.ts";
import { readDeviceMemoryGiB } from "../deviceBudget.ts";
import { hearWorkerErrors } from "../pageErrors.ts";

/** The page's device pixels per CSS pixel, or 1 where there is no window. */
function pagePixelRatio(): number {
  return typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
}

/** What the render worker says about its GPU device. */
export type GpuStatus = GpuErrorMessage | GpuDeviceRestoredMessage | GpuFailedMessage;

/**
 * How much of the canvas stroke the tile frame takes. Members sit edge to
 * edge, so the frame is a faint line that shows where one ends and does not
 * compete with the data.
 */
const TILE_BORDER_ALPHA = 0.35;

function rgba(color: ResolvedColor, alpha = 1): RgbaColor {
  return [color.r, color.g, color.b, color.a * alpha];
}

/** The renderer's colors from the current theme tokens. */
export function readCanvasColors(): CanvasColors {
  return {
    background: rgba(tokenColor("--lc-canvas-bg")),
    tileBorder: rgba(tokenColor("--lc-canvas-stroke"), TILE_BORDER_ALPHA),
  };
}

/** How long `destroy()` waits for the worker to process its `destroy`
 *  message (which ends in `self.close()`) before terminating it. Terminating
 *  at once would drop the queued message and skip worker-side GPU cleanup;
 *  the fallback is for a wedged worker or one that never finished init. */
const DESTROY_TERMINATE_FALLBACK_MS = 1000;

function failureText(failure: CaptureFailure | null): string {
  return failure ? `${failure.name}: ${failure.message}` : "no reason was given";
}

const DESTROYED_BEFORE_ANSWER = "the render client was destroyed before the worker answered";

/** Frames in flight past which the oldest is taken as lost. */
const MAX_FRAMES_AWAITING_DONE = 64;

/** One viewport frame, timed from dispatch until its GPU work was done. */
export interface FrameLatency {
  frameSeq: number;
  ms: number;
}

export class RenderClient implements UploadClient {
  private worker: Worker;
  private readyPromise: Promise<void>;
  private readyReject: (err: Error) => void = () => {};
  /** The worker drops a message posted before `ready` if its init failed, so `captureFrame` waits for it. */
  private workerReady = false;
  private bootstrapCompiled = false;
  private destroyed = false;

  /** Pending `thumbnailRender` requests, keyed by the id sent to the worker.
   *  Resolved when the matching `thumbnailResult` arrives. */
  private thumbnailPending = new Map<number, (bitmap: ImageBitmap | null) => void>();
  private thumbnailSeq = 0;

  /** Pending `captureFrame` requests, keyed by the id sent to the worker.
   *  Resolved when the matching `frameCaptured` arrives. */
  private framePending = new Map<number, (capture: FrameCaptureResult) => void>();
  private frameSeq = 0;

  /** Pending `probe` requests, keyed by the id sent to the worker. */
  private probePending = new Map<number, (samples: ProbeSample[]) => void>();
  private probeSeq = 0;

  onChunkResidency: ChunkResidencyHandler | null = null;
  /** Missing entries cover chunks and proxies; match on `kind`. */
  onWantedSetDelta: WantedSetHandler | null = null;
  /**
   * The worker's level readout for one dataset changed: its target level
   * and the level on screen, summarised across its entities. Null when the
   * dataset reports no image-bearing entity.
   */
  onEntityLevels: ((datasetId: string, levels: DatasetLevels | null) => void) | null = null;

  private readonly pipelinesCompiledHandlers = new Set<() => void>();

  /** Whether the worker has reported its bootstrap pipelines compiled. */
  get pipelinesCompiled(): boolean {
    return this.bootstrapCompiled;
  }

  /**
   * Call `handler` once, when the worker reports that the pipelines it
   * builds at bootstrap have compiled, or at once if it already has. Returns
   * the function that withdraws the handler. The minimap holds its overlay's
   * content draws on this report.
   */
  oncePipelinesCompiled(handler: () => void): () => void {
    if (this.bootstrapCompiled) {
      handler();
      return () => {};
    }
    this.pipelinesCompiledHandlers.add(handler);
    return () => {
      this.pipelinesCompiledHandlers.delete(handler);
    };
  }

  private notePipelinesCompiled(): void {
    this.bootstrapCompiled = true;
    const handlers = [...this.pipelinesCompiledHandlers];
    this.pipelinesCompiledHandlers.clear();
    for (const handler of handlers) handler();
  }

  /**
   * Summarised once per worker report, so the layer panel and the trace's
   * per-tick aggregate read the same numbers without each walking the
   * entities.
   */
  private readonly levelsByDataset = new Map<string, DatasetLevels>();

  private gpuPassUs: number | null = null;
  /** Null until the worker's first report; it posts only changes after that. */
  private gpuMemoryReport: GpuMemoryReport | null = null;
  private gpuCapacityReport: GpuCapacityReport | null = null;
  /** Hears minimap overviews the worker lost to an out-of-memory failure. */
  onMinimapOverviewsLost: ((memberIds: string[]) => void) | null = null;

  /** The last viewport frame dispatched. */
  private viewportFrameSeq = 0;
  /** When each frame still awaiting its `frameDone` was dispatched. */
  private readonly frameDispatchedAt = new Map<number, number>();
  private frameLatency: FrameLatency | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const offscreen = canvas.transferControlToOffscreen();
    this.worker = new Worker(
      new URL("./gpu.worker.ts", import.meta.url),
      { type: "module" },
    );
    hearWorkerErrors(this.worker);

    this.readyPromise = new Promise<void>((resolve, reject) => {
      // Kept so destroy() can settle a still-pending init (settling an
      // already-resolved promise is a no-op).
      this.readyReject = reject;
      const handler = (e: MessageEvent<WorkerToMainMessage>) => {
        if (e.data.type === "ready") {
          this.workerReady = true;
          resolve();
          this.worker.removeEventListener("message", handler);
          this.worker.addEventListener("message", this.onMessage);
        } else if (e.data.type === "pipelinesCompiled") {
          // Follows `ready` in practice. Taken here too, so nothing depends
          // on that order.
          this.notePipelinesCompiled();
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

    const init: InitMessage = { type: "init", canvas: offscreen, deviceMemoryGiB: readDeviceMemoryGiB() };
    this.worker.postMessage(init, [offscreen]);
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

  /** What the worker last reported holding on the GPU, or null before its first report. */
  gpuMemory(): GpuMemoryReport | null {
    return this.gpuMemoryReport;
  }

  /** The chunk pools' capacities the worker last reported, which planning admits against, or null before. */
  gpuCapacity(): GpuCapacityReport | null {
    return this.gpuCapacityReport;
  }

  /**
   * The newest frame finished since the last call, timed from dispatch to its
   * GPU work done on this thread's clock, or null when none finished. Taking
   * it clears it.
   */
  takeFrameLatency(): FrameLatency | null {
    const latency = this.frameLatency;
    this.frameLatency = null;
    return latency;
  }

  /** The sequence number of the last viewport frame dispatched. */
  lastFrameSeq(): number {
    return this.viewportFrameSeq;
  }

  /** Number the next viewport frame and note when it left. */
  private nextFrameSeq(): number {
    this.viewportFrameSeq += 1;
    this.frameDispatchedAt.set(this.viewportFrameSeq, performance.now());
    // A frame whose report never comes (the worker dropped it) must not
    // hold its entry forever.
    if (this.frameDispatchedAt.size > MAX_FRAMES_AWAITING_DONE) {
      const oldest = this.frameDispatchedAt.keys().next().value;
      if (oldest !== undefined) this.frameDispatchedAt.delete(oldest);
    }
    return this.viewportFrameSeq;
  }

  /** Viewport frames dispatched whose GPU work has not yet finished. */
  framesAwaitingDone(): number {
    return this.frameDispatchedAt.size;
  }

  /**
   * Called after each finished viewport frame is noted, with when its GPU
   * work finished on this thread's clock.
   */
  onFrameDone: ((frameSeq: number, doneAtMs: number) => void) | null = null;

  private noteFrameDone(frameSeq: number, workerDoneAtMs: number | undefined): void {
    const now = performance.now();
    const dispatchedAt = this.frameDispatchedAt.get(frameSeq);
    for (const seq of this.frameDispatchedAt.keys()) {
      if (seq > frameSeq) break;
      this.frameDispatchedAt.delete(seq);
    }
    if (dispatchedAt !== undefined) {
      this.frameLatency = { frameSeq, ms: now - dispatchedAt };
    }
    // Held between the dispatch and the report, so a skew between the two
    // contexts' time origins can never put the frame outside what this
    // thread saw.
    const doneAtMs =
      workerDoneAtMs === undefined
        ? now
        : Math.min(now, Math.max(dispatchedAt ?? -Infinity, workerDoneAtMs - performance.timeOrigin));
    this.onFrameDone?.(frameSeq, doneAtMs);
  }

  private onMessage = (e: MessageEvent<WorkerToMainMessage>) => {
    const msg = e.data;
    if (this.destroyed) {
      // The worker may still flush messages between destroy() and its own
      // exit; the only obligation left is releasing any GPU-backed bitmap.
      if (msg.type === "thumbnailResult" && msg.bitmap) msg.bitmap.close();
      return;
    }
    if (msg.type === "chunkResidency" && this.onChunkResidency) {
      this.onChunkResidency(msg);
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
    } else if (msg.type === "gpuMemory") {
      const { type: _type, ...report } = msg;
      this.gpuMemoryReport = report;
    } else if (msg.type === "gpuCapacity") {
      const { type: _type, ...report } = msg;
      this.gpuCapacityReport = report;
    } else if (msg.type === "minimapOverviewsLost") {
      this.onMinimapOverviewsLost?.(msg.memberIds);
    } else if (msg.type === "frameDone") {
      this.noteFrameDone(msg.frameSeq, msg.doneAtMs);
    } else if (msg.type === "pipelinesCompiled") {
      this.notePipelinesCompiled();
    } else if (msg.type === "thumbnailResult") {
      const resolve = this.thumbnailPending.get(msg.id);
      if (resolve) {
        this.thumbnailPending.delete(msg.id);
        resolve(msg.bitmap);
      } else if (msg.bitmap) {
        // No waiter, so release the GPU-backed bitmap rather than leak it.
        msg.bitmap.close();
      }
    } else if (msg.type === "probeResult") {
      const resolve = this.probePending.get(msg.id);
      this.probePending.delete(msg.id);
      resolve?.(msg.samples);
    } else if (msg.type === "frameCaptured") {
      const resolve = this.framePending.get(msg.id);
      if (resolve) {
        this.framePending.delete(msg.id);
        resolve(
          msg.png
            ? { frame: { png: msg.png, width: msg.width, height: msg.height }, reason: null }
            : { frame: null, reason: `the render worker could not read its canvas: ${failureText(msg.failure)}` },
        );
      }
    } else if (msg.type === "gpuError") {
      console.warn(`GPU ${msg.kind}${msg.count > 1 ? ` (x${msg.count})` : ""}: ${msg.message}`);
      this.noteGpuStatus(msg);
    } else if (msg.type === "gpuDeviceRestored") {
      // Frames sent to the lost device may never be answered, and the page
      // holds its next frame while one is outstanding.
      this.frameDispatchedAt.clear();
      this.noteGpuStatus(msg);
    } else if (msg.type === "gpuFailed") {
      console.error(msg.message);
      this.noteGpuStatus(msg);
    } else if (msg.type === "error") {
      console.error("Render worker error:", msg.message);
    }
  };

  private readonly gpuStatusListeners = new Set<(status: GpuStatus) => void>();

  /**
   * Hear what the worker says about its GPU device: an error, a lost device
   * replaced, or one that could not be. Returns the function that stops it.
   */
  onGpuStatus(listener: (status: GpuStatus) => void): () => void {
    this.gpuStatusListeners.add(listener);
    return () => {
      this.gpuStatusListeners.delete(listener);
    };
  }

  private noteGpuStatus(status: GpuStatus): void {
    for (const listener of [...this.gpuStatusListeners]) listener(status);
  }

  /** Destroy the worker's GPU device, as a test of its recovery. */
  loseDevice(): void {
    if (this.destroyed) return;
    this.worker.postMessage({ type: "loseDevice" });
  }

  /** Make the worker's device raise a validation error, as a test of how one is reported. Development builds only. */
  raiseValidationError(): void {
    if (this.destroyed) return;
    this.worker.postMessage({ type: "raiseValidationError" });
  }

  resize(width: number, height: number) {
    this.worker.postMessage({ type: "resize", width, height });
  }

  /** Takes effect from the next frame drawn. */
  setCanvasColors(colors: CanvasColors) {
    this.worker.postMessage({ type: "canvasColors", colors });
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
      // Copy: the CpuCache keeps `chunk.data` for re-delivery after
      // worker-side eviction, and transferring it would detach that copy.
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
      // Copy before transfer, as in `volumeChunkData`.
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
    // Each buffer is a plane the caller cut for the worker, so it moves
    // without a second copy.
    const transferList = chunks.map(chunk => chunk.data);
    const workerChunks: Chunk[] = chunks.map(chunk => (
      { data: chunk.data, dataType: chunk.dataType, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key }
    ));
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
    plane: number,
    epochs: SceneEpochs,
  ) {
    // As in `sliceChunkData`, each buffer is a plane cut for the worker.
    const transferList = chunks.map(chunk => chunk.data);
    const workerChunks: Chunk[] = chunks.map(chunk => (
      { data: chunk.data, dataType: chunk.dataType, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key }
    ));
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
        plane,
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

  failedChunks(msg: FailedChunksMessage) {
    this.worker.postMessage(msg);
  }

  /**
   * Post a viewEpoch hot-state message. Sent before the corresponding
   * render message so chunk eviction has the latest ray-pick coords.
   */
  viewHotState(msg: ViewHotStateMessage) {
    this.worker.postMessage(msg);
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
    pixelRatio?: number,
  ): number {
    const frameSeq = this.nextFrameSeq();
    this.worker.postMessage({
      type: "volumeRenderMultiPass",
      epochs,
      layers, invViewProj, eye,
      canvasW, canvasH, fullW, fullH, viewProj,
      camForward, clipDistance, clipMode, pixelRatio,
      frameSeq,
    });
    return frameSeq;
  }

  sliceRenderMultiPass(
    layers: SliceLayerParams[],
    zoom: number,
    cx: number,
    cy: number,
    canvasW: number,
    canvasH: number,
    epochs: SceneEpochs,
    pixelRatio?: number,
  ): number {
    // Aggregate quad buffers are rebuilt per render tick on the main
    // thread; transferring them avoids structured-cloning what can be
    // hundreds of KB on a wide collection.
    const transfer: Transferable[] = [];
    for (const layer of layers) {
      if (layer.aggregate) transfer.push(layer.aggregate.quads);
    }
    const frameSeq = this.nextFrameSeq();
    this.worker.postMessage({
      type: "sliceRenderMultiPass",
      epochs,
      layers, zoom, cx, cy,
      canvasW, canvasH, pixelRatio,
      frameSeq,
    }, transfer);
    return frameSeq;
  }

  minimapInit(canvas: HTMLCanvasElement) {
    const offscreen = canvas.transferControlToOffscreen();
    this.worker.postMessage({ type: "minimapInit", canvas: offscreen }, [offscreen]);
  }

  minimapRender(layers: MinimapLayerParams[], invViewProj: Float32Array, eye: Float32Array, canvasW: number, canvasH: number) {
    this.worker.postMessage({
      type: "minimapRender", layers, invViewProj, eye, canvasW, canvasH, pixelRatio: pagePixelRatio(),
    } satisfies MinimapRenderMessage);
  }

  /**
   * Render one Explore-panel thumbnail off-screen with the minimap's overview
   * textures. Resolves `null` when no coarse overview is resident yet, so the
   * caller can fall back to a label-only row. `size` is in device pixels.
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
      this.worker.postMessage({
        type: "thumbnailRender", id, layers, invViewProj, eye, size, pixelRatio: pagePixelRatio(),
      } satisfies ThumbnailRenderMessage);
    });
  }

  /**
   * The frame on the worker's canvas as a PNG, for the trace bundle. The
   * worker takes it inside the next frame it renders. Resolves with a reason
   * when no frame could be read, and at once after destroy, so a bundle never
   * hangs on a dead client.
   *
   * A starting worker drops every message and a failed one answers none, so
   * a capture asked for before `ready` waits for it and a failed start
   * becomes the reason.
   */
  captureFrame(): Promise<FrameCaptureResult> {
    if (this.destroyed) {
      return Promise.resolve({ frame: null, reason: "the render client was destroyed, so there was no canvas to read" });
    }
    if (this.workerReady) return this.postCaptureFrame();
    return this.readyPromise.then(
      () => this.postCaptureFrame(),
      // destroy() rejects the same promise, and that is not a failed start.
      (error: unknown) => ({
        frame: null,
        reason: this.destroyed
          ? DESTROYED_BEFORE_ANSWER
          : `the render worker did not start: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }

  private postCaptureFrame(): Promise<FrameCaptureResult> {
    if (this.destroyed) return Promise.resolve({ frame: null, reason: DESTROYED_BEFORE_ANSWER });
    const id = this.frameSeq++;
    return new Promise<FrameCaptureResult>((resolve) => {
      this.framePending.set(id, resolve);
      this.worker.postMessage({ type: "captureFrame", id });
    });
  }

  minimapUploadOverviewChunksForLayer(
    datasetId: string,
    chunks: { data: ArrayBuffer; dataType: string; x: number; y: number; z: number; key: string }[],
    imageId: string,
    level: number,
    t: number,
    c: number,
    levelWidth: number,
    levelHeight: number,
    levelDepth: number,
    chunkX: number,
    chunkY: number,
    chunkZ: number,
    sampleFormat: SampleFormat,
  ) {
    const transferList: ArrayBuffer[] = [];
    const workerChunks: Chunk[] = chunks.map(chunk => {
      // A copy: the cache keeps the decoded chunk, so it can't be transferred.
      const buf = chunk.data.slice(0);
      transferList.push(buf);
      return { data: buf, dataType: chunk.dataType, x: chunk.x, y: chunk.y, z: chunk.z, key: chunk.key };
    });
    this.worker.postMessage(
      {
        type: "minimapUploadOverviewChunksForLayer",
        datasetId,
        chunks: workerChunks,
        imageId, level,
        t, c,
        levelWidth, levelHeight, levelDepth,
        chunkX, chunkY, chunkZ,
        sampleFormat,
      } satisfies MinimapUploadOverviewChunksForLayerMessage,
      transferList,
    );
  }

  /**
   * The samples the last frame drew under a canvas point, given as fractions
   * of the canvas: per visible channel of each entity there, the resident
   * value and its level. Empty when nothing is drawn there, before the worker
   * is ready, and after destroy.
   */
  probe(x: number, y: number): Promise<ProbeSample[]> {
    if (this.destroyed || !this.workerReady) return Promise.resolve([]);
    const id = this.probeSeq++;
    return new Promise((resolve) => {
      this.probePending.set(id, resolve);
      this.worker.postMessage({ type: "probe", id, x, y } satisfies ProbeMessage);
    });
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

  /** Idempotent. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // Settle any in-flight thumbnail requests so their promises don't hang
    // after the worker is gone (the id-correlated path has no fire-and-forget).
    for (const resolve of this.thumbnailPending.values()) resolve(null);
    this.thumbnailPending.clear();
    for (const resolve of this.framePending.values()) {
      resolve({ frame: null, reason: DESTROYED_BEFORE_ANSWER });
    }
    this.framePending.clear();
    for (const resolve of this.probePending.values()) resolve([]);
    this.probePending.clear();
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
