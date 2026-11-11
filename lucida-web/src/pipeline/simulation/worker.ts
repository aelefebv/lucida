/**
 * The render worker, run in-process on a stand-in GPU device. Messages go
 * through the worker's own dispatcher, so atlas sizing, admission, eviction,
 * the residency reports and the wanted-set report are the production code.
 * Only drawing is skipped. The two things it does that residency reads, a
 * slice member's eviction reference and the label planes it hands back, are
 * done from the render message.
 *
 * Messages queue in both directions and are delivered when the harness
 * drains, which keeps the main thread and the worker as far apart as a
 * real postMessage boundary does, in an order that repeats run to run.
 */

import { dispatchMessage } from "../../renderer/worker/dispatch.ts";
import { createInitialState } from "../../renderer/worker/state.ts";
import { createWantedSetPoster } from "../../renderer/worker/bootstrap.ts";
import { UNTIMED } from "../../renderer/passTiming.ts";
import type { WorkerCtx } from "../../renderer/workerContext.ts";
import type {
  MainToWorkerMessage,
  MissingChunk,
  SliceLayerParams,
  SliceRenderMultiPassMessage,
  WorkerToMainMessage,
} from "../../renderer/workerProtocol.ts";
import { setCameraUVForMember } from "../../renderer/slice/eviction.ts";
import { memberCameraUV } from "../../renderer/slice/render.ts";
import { INDIRECTION_FAILED } from "../../renderer/remap.ts";
import { chunkPoolTier } from "../../renderer/poolKeys.ts";
import { drawOf } from "../../renderer/worker/draws.ts";
import type { ViewIndirection } from "../../renderer/viewIndirection.ts";
import { LABEL_TIER } from "../../renderer/chunkUploadFeedback.ts";
import type { ResidencyTier } from "../residencyTier.ts";

/** Messages that only draw, capture or style, so the simulation answers them without a handler. */
const DRAW_ONLY = new Set<MainToWorkerMessage["type"]>([
  "resize",
  "canvasColors",
  "sliceRenderMultiPass",
  "volumeRenderMultiPass",
  "minimapInit",
  "minimapRender",
  "minimapDestroy",
  "minimapUploadOverviewChunksForLayer",
  "thumbnailRender",
  "captureFrame",
  "updateCursorData",
  "destroy",
]);

/** The WebGPU usage flags the atlas code reads off the global scope. */
export const GPU_USAGE_GLOBALS = {
  GPUTextureUsage: {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  },
  GPUBufferUsage: {
    MAP_READ: 0x01,
    MAP_WRITE: 0x02,
    COPY_SRC: 0x04,
    COPY_DST: 0x08,
    INDEX: 0x10,
    VERTEX: 0x20,
    UNIFORM: 0x40,
    STORAGE: 0x80,
    INDIRECT: 0x100,
    QUERY_RESOLVE: 0x200,
  },
};

/** A device that accepts every allocation and write and keeps nothing, at the WebGPU minimums but for `limits`. */
function simulatedDevice(limits: Partial<GPUSupportedLimits>): GPUDevice {
  const resource = () => ({ createView: () => ({}), destroy: () => {} });
  return {
    limits,
    createTexture: resource,
    createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy: () => {} }),
    pushErrorScope: () => {},
    popErrorScope: () => Promise.resolve(null),
    createCommandEncoder: () => ({
      copyTextureToTexture: () => {},
      copyBufferToBuffer: () => {},
      finish: () => ({}),
    }),
    queue: {
      writeTexture: () => {},
      writeBuffer: () => {},
      submit: () => {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  } as unknown as GPUDevice;
}

type Listener = (event: { data: WorkerToMainMessage }) => void;

/** What the page sent the worker of one chunk in one tier. */
export interface ChunkDeliveries {
  tier: ResidencyTier;
  memberId: string;
  chunkKey: string;
  count: number;
  bytes: number;
}

/** A chunk's {@link SimulatedWorker.deliveries} key: detail and coarse share chunk keys. */
export function deliveryKey(tier: ResidencyTier, memberId: string, chunkKey: string): string {
  return `${tier}|${memberId}/${chunkKey}`;
}

export class SimulatedWorker {
  readonly ctx: WorkerCtx;
  private readonly inbox: MainToWorkerMessage[] = [];
  private readonly outbox: WorkerToMainMessage[] = [];
  private readonly listeners = new Set<Listener>();
  /** Called with every message the worker posts, before the page sees it. */
  onPost: ((msg: WorkerToMainMessage) => void) | null = null;
  /**
   * {@link deliveryKey} → how many times the page sent that chunk and the
   * bytes it sent. A chunk resident in both tiers is two entries.
   */
  readonly deliveries = new Map<string, ChunkDeliveries>();
  /** Label member id → the plane the last slice frame drew for it. */
  private readonly drawnLabelChunks = new Map<string, NonNullable<SliceLayerParams["labelChunk"]>>();
  /** How long the stand-in GPU takes over each viewport frame, one after another. */
  private readonly frameMs: number;
  /** Viewport frames on the stand-in GPU, oldest first, with when each finishes. */
  private readonly drawing: Array<{ frameSeq: number; doneAt: number }> = [];
  /** Viewport frames the page dispatched. */
  framesDispatched = 0;
  /** The most viewport frames that were ever on the GPU at once. */
  mostFramesDrawing = 0;

  /** `frameMs` 0 answers each viewport frame the moment it is handled. */
  constructor(gpuTotalBytes: number, frameMs = 0, limits: Partial<GPUSupportedLimits> = {}) {
    this.frameMs = frameMs;
    const state = createInitialState(gpuTotalBytes);
    const post = (msg: WorkerToMainMessage): void => {
      this.outbox.push(msg);
    };
    this.ctx = {
      device: simulatedDevice(limits),
      context: { canvas: { width: 0, height: 0 } } as unknown as GPUCanvasContext,
      format: "bgra8unorm",
      state,
      passTimer: UNTIMED,
      getSliceRenderer: () => { throw new Error("the simulated worker does not draw"); },
      getVolumeRenderer: () => { throw new Error("the simulated worker does not draw"); },
      getCompositor: () => { throw new Error("the simulated worker does not draw"); },
      getCursorRenderer: () => { throw new Error("the simulated worker does not draw"); },
      getViewLander: () => { throw new Error("the simulated worker does not draw"); },
      ensureOffscreenPool: () => [],
      getOrCreateLUT: () => { throw new Error("the simulated worker does not draw"); },
      post,
      postWantedSet: createWantedSetPoster(state, post),
      lookupEntityDescriptor: (datasetId, view) => drawOf(state, datasetId, view)?.descriptor ?? null,
    };
  }

  // The slice of the `Worker` interface `RenderClient` uses.

  postMessage(msg: MainToWorkerMessage, transfer?: Transferable[]): void {
    if (msg.type === "init") {
      this.outbox.push({ type: "ready" });
      return;
    }
    if (
      msg.type === "sliceChunkData" || msg.type === "volumeChunkData" ||
      msg.type === "labelSliceChunkData" || msg.type === "labelVolumeChunkData"
    ) {
      const tier = "tier" in msg ? msg.tier : LABEL_TIER;
      for (const chunk of msg.chunks) {
        const key = deliveryKey(tier, msg.memberId, chunk.key);
        const prior = this.deliveries.get(key);
        this.deliveries.set(key, {
          tier,
          memberId: msg.memberId,
          chunkKey: chunk.key,
          count: (prior?.count ?? 0) + 1,
          bytes: (prior?.bytes ?? 0) + chunk.data.byteLength,
        });
      }
    }
    // A real postMessage copies, so neither side can see the other mutate,
    // and empties the sender's copy of whatever it transfers.
    this.inbox.push(structuredClone(msg, { transfer }));
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === "message") this.listeners.delete(listener);
  }

  terminate(): void {}

  get idle(): boolean {
    return this.inbox.length === 0 && this.outbox.length === 0 && this.drawing.length === 0;
  }

  /** Whether the stand-in GPU is still drawing a frame. */
  get gpuBusy(): boolean {
    return (this.drawing.at(-1)?.doneAt ?? 0) > performance.now();
  }

  /**
   * Run every queued message, then hand the page what the worker posted,
   * until both sides are quiet. A frame still on the stand-in GPU is answered
   * by the first drain after it finishes.
   */
  async drain(): Promise<void> {
    this.finishDrawnFrames();
    while (this.inbox.length > 0 || this.outbox.length > 0) {
      while (this.inbox.length > 0) {
        const msg = this.inbox.shift()!;
        if (DRAW_ONLY.has(msg.type)) {
          if (msg.type === "sliceRenderMultiPass") this.noteSliceFrame(msg);
          const frameSeq = (msg as { frameSeq?: number }).frameSeq;
          if (frameSeq !== undefined) this.drawFrame(frameSeq);
          continue;
        }
        await dispatchMessage(this.ctx, msg);
      }
      while (this.outbox.length > 0) {
        const msg = structuredClone(this.outbox.shift()!);
        this.onPost?.(msg);
        for (const listener of [...this.listeners]) listener({ data: msg });
      }
    }
  }

  /** Put a viewport frame on the stand-in GPU, behind the frames already there. */
  private drawFrame(frameSeq: number): void {
    this.framesDispatched++;
    if (this.frameMs <= 0) {
      this.outbox.push({ type: "frameDone", frameSeq });
      return;
    }
    const startAt = Math.max(performance.now(), this.drawing.at(-1)?.doneAt ?? 0);
    this.drawing.push({ frameSeq, doneAt: startAt + this.frameMs });
    this.mostFramesDrawing = Math.max(this.mostFramesDrawing, this.drawing.length);
  }

  private finishDrawnFrames(): void {
    const now = performance.now();
    while (this.drawing.length > 0 && this.drawing[0].doneAt <= now) {
      this.outbox.push({ type: "frameDone", frameSeq: this.drawing.shift()!.frameSeq });
    }
  }

  /**
   * A slice frame moves each drawn member's eviction reference to the view
   * center, and hands back each label chunk holding another plane than the
   * frame draws, so the simulation does both from the render message as the
   * slice renderer does. Aggregate layers are left out.
   */
  private noteSliceFrame(msg: SliceRenderMultiPassMessage): void {
    for (const layer of msg.layers) {
      if (layer.isLabel) {
        if (!layer.labelChunk) continue;
        this.drawnLabelChunks.set(layer.datasetId, layer.labelChunk);
        continue;
      }
      if (layer.aggregate) continue;
      const datasetId = this.ctx.state.memberToDataset.get(layer.datasetId);
      if (!datasetId || !drawOf(this.ctx.state, datasetId, msg.view)?.routes.has(layer.datasetId)) continue;
      setCameraUVForMember(this.ctx.state, msg.view, layer.datasetId, memberCameraUV(msg, layer));
    }
  }

  /**
   * Each label slice cell whose texels are not the plane the last frame drew
   * there, or whose chunk was handed back and not sent again, as
   * `member cell x,y: …`. The cell draws them all the same.
   */
  staleLabelCells(): string[] {
    const out: string[] = [];
    for (const pool of this.ctx.state.labelSlicePools.values()) {
      const memberId = pool.memberId;
      const drawn = this.drawnLabelChunks.get(memberId);
      if (!drawn || pool.t !== drawn.t || pool.plane !== drawn.plane) continue;
      for (const [cell, plane] of pool.planes) {
        const key = pool.keys.get(cell);
        const [level, t, , z] = (key ?? "").split("/").map(Number);
        if (plane === drawn.plane && level === drawn.level && t === drawn.t && z === drawn.z) continue;
        const at = `${cell % 0x10000},${Math.floor(cell / 0x10000)}`;
        const holds = key === undefined ? "a chunk it handed back" : `chunk ${key}`;
        out.push(`${memberId} cell ${at}: plane ${plane} of ${holds}, where the frame draws plane ${drawn.plane}`);
      }
    }
    return out.sort();
  }

  /**
   * Each indirection cell of one dataset's pools that a view's shader would
   * draw as failed, as `member tier level L cell x,y[,z]`, each once however
   * many views draw it so.
   */
  failedCells(datasetId: string): string[] {
    const out = new Set<string>();
    const views: Array<readonly [string, ViewIndirection, boolean]> = [];
    for (const [key, atlas] of this.ctx.state.sliceAtlases) {
      if (atlas.datasetId === datasetId) for (const view of atlas.views.values()) views.push([key, view, false]);
    }
    for (const [key, atlas] of this.ctx.state.volumeAtlases) {
      if (atlas.datasetId === datasetId) for (const view of atlas.views.values()) views.push([key, view, true]);
    }
    for (const [poolKey, view, volume] of views) {
      for (const [memberId, metas] of view.entityMetas) {
        for (const meta of metas) {
          const [gridZ, gridY, gridX] = meta.gridDims;
          const cells = gridX * gridY * (volume ? gridZ : 1);
          for (let i = 0; i < cells; i++) {
            if (view.indirectionData[meta.offset + i] !== INDIRECTION_FAILED) continue;
            const x = i % gridX;
            const y = Math.floor(i / gridX) % gridY;
            const cell = volume ? `${x},${y},${Math.floor(i / (gridX * gridY))}` : `${x},${y}`;
            out.add(`${memberId} ${chunkPoolTier(poolKey)} level ${meta.level} cell ${cell}`);
          }
        }
      }
    }
    return [...out].sort();
  }

  /**
   * What the worker wants and does not hold for one dataset, computed now.
   * The worker reports its wanted set only after a cold state or an upload
   * that bounced, so its last report can be stale by the time a run settles.
   */
  missingNow(datasetId: string): MissingChunk[] {
    const missing: MissingChunk[] = [];
    createWantedSetPoster(this.ctx.state, (msg) => {
      if (msg.type === "wantedSetDelta") missing.push(...msg.missing);
    })(datasetId);
    return missing;
  }
}
