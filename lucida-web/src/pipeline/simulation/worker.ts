/**
 * The render worker, run in-process on a stand-in GPU device. Messages go
 * through the worker's own dispatcher, so atlas sizing, admission, eviction,
 * the residency reports and the wanted-set report are the production code.
 * Only drawing is skipped. The one thing it touches that residency reads, a
 * slice member's eviction reference, is recorded from the render message.
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
  SliceRenderMultiPassMessage,
  WorkerToMainMessage,
} from "../../renderer/workerProtocol.ts";
import { setCameraUVForMember } from "../../renderer/slice/eviction.ts";
import { memberCameraUV } from "../../renderer/slice/render.ts";
import { INDIRECTION_FAILED } from "../../renderer/remap.ts";
import { chunkPoolTier } from "../../renderer/poolKeys.ts";
import type { LodIndirectionMeta } from "../../renderer/volume/atlas.ts";
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

/** A device that accepts every allocation and write and keeps nothing. */
function simulatedDevice(): GPUDevice {
  const resource = () => ({ createView: () => ({}), destroy: () => {} });
  return {
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

export class SimulatedWorker {
  readonly ctx: WorkerCtx;
  private readonly inbox: MainToWorkerMessage[] = [];
  private readonly outbox: WorkerToMainMessage[] = [];
  private readonly listeners = new Set<Listener>();
  /** Called with every message the worker posts, before the page sees it. */
  onPost: ((msg: WorkerToMainMessage) => void) | null = null;
  /** `${memberId}/${chunkKey}` → how many times the page sent that chunk, and for which tier. */
  readonly deliveries = new Map<string, { tier: ResidencyTier; count: number }>();

  constructor(gpuTotalBytes: number) {
    const state = createInitialState(gpuTotalBytes);
    const post = (msg: WorkerToMainMessage): void => {
      this.outbox.push(msg);
    };
    this.ctx = {
      device: simulatedDevice(),
      context: { canvas: { width: 0, height: 0 } } as unknown as GPUCanvasContext,
      format: "bgra8unorm",
      state,
      passTimer: UNTIMED,
      getSliceRenderer: () => { throw new Error("the simulated worker does not draw"); },
      getVolumeRenderer: () => { throw new Error("the simulated worker does not draw"); },
      getCompositor: () => { throw new Error("the simulated worker does not draw"); },
      getCursorRenderer: () => { throw new Error("the simulated worker does not draw"); },
      ensureOffscreenPool: () => [],
      getOrCreateLUT: () => { throw new Error("the simulated worker does not draw"); },
      post,
      postWantedSet: createWantedSetPoster(state, post),
      lookupEntityDescriptor: (datasetId) => state.descriptorBuffersByDataset.get(datasetId) ?? null,
    };
  }

  // The slice of the `Worker` interface `RenderClient` uses.

  postMessage(msg: MainToWorkerMessage): void {
    if (msg.type === "init") {
      this.outbox.push({ type: "ready" });
      return;
    }
    if (msg.type === "sliceChunkData" || msg.type === "volumeChunkData") {
      for (const chunk of msg.chunks) {
        const key = `${msg.memberId}/${chunk.key}`;
        const prior = this.deliveries.get(key);
        this.deliveries.set(key, { tier: msg.tier, count: (prior?.count ?? 0) + 1 });
      }
    }
    // A real postMessage copies, so neither side can see the other mutate.
    this.inbox.push(structuredClone(msg));
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === "message") this.listeners.delete(listener);
  }

  terminate(): void {}

  get idle(): boolean {
    return this.inbox.length === 0 && this.outbox.length === 0;
  }

  /** Run every queued message, then hand the page what the worker posted, until both sides are quiet. */
  async drain(): Promise<void> {
    while (!this.idle) {
      while (this.inbox.length > 0) {
        const msg = this.inbox.shift()!;
        if (DRAW_ONLY.has(msg.type)) {
          if (msg.type === "sliceRenderMultiPass") this.noteSliceCamera(msg);
          const frameSeq = (msg as { frameSeq?: number }).frameSeq;
          if (frameSeq !== undefined) this.outbox.push({ type: "frameDone", frameSeq });
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

  /**
   * A slice frame moves each drawn member's eviction reference to the view
   * center, so the simulation records it from the render message as the
   * slice renderer does. Aggregate layers are left out.
   */
  private noteSliceCamera(msg: SliceRenderMultiPassMessage): void {
    for (const layer of msg.layers) {
      if (layer.isLabel || layer.aggregate) continue;
      if (!this.ctx.state.memberSourcePools.has(layer.datasetId)) continue;
      setCameraUVForMember(this.ctx.state, layer.datasetId, memberCameraUV(msg, layer));
    }
  }

  /**
   * Each indirection cell of one dataset's pools that the shader would draw
   * as failed, as `member tier level L cell x,y[,z]`.
   */
  failedCells(datasetId: string): string[] {
    const out: string[] = [];
    type Pool = { datasetId: string; indirectionData: Uint32Array; entityMetas: Map<string, LodIndirectionMeta[]> };
    const pools: Array<readonly [string, Pool, boolean]> = [
      ...[...this.ctx.state.sliceAtlases].map(([key, atlas]) => [key, atlas, false] as const),
      ...[...this.ctx.state.volumeAtlases].map(([key, atlas]) => [key, atlas, true] as const),
    ];
    for (const [poolKey, atlas, volume] of pools) {
      if (atlas.datasetId !== datasetId) continue;
      for (const [memberId, metas] of atlas.entityMetas) {
        for (const meta of metas) {
          const [gridZ, gridY, gridX] = meta.gridDims;
          const cells = gridX * gridY * (volume ? gridZ : 1);
          for (let i = 0; i < cells; i++) {
            if (atlas.indirectionData[meta.offset + i] !== INDIRECTION_FAILED) continue;
            const x = i % gridX;
            const y = Math.floor(i / gridX) % gridY;
            const cell = volume ? `${x},${y},${Math.floor(i / (gridX * gridY))}` : `${x},${y}`;
            out.push(`${memberId} ${chunkPoolTier(poolKey)} level ${meta.level} cell ${cell}`);
          }
        }
      }
    }
    return out.sort();
  }

  /**
   * What the worker wants and does not hold for one dataset, computed now.
   * The worker reports its wanted set only after a cold state or an upload
   * that bounced, so its last report can be stale by the time a run settles.
   */
  missingNow(datasetId: string): MissingChunk[] {
    let missing: MissingChunk[] = [];
    createWantedSetPoster(this.ctx.state, (msg) => {
      if (msg.type === "wantedSetDelta") missing = msg.missing;
    })(datasetId);
    return missing;
  }
}
