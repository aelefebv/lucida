/**
 * Worker bootstrap: initialize the GPU device + canvas context, build
 * the per-session {@link RendererState}, and assemble the
 * {@link WorkerCtx} that the dispatcher and per-mode handlers consume.
 *
 * Renderer-class singletons (slice/volume/cursor/compositor renderers)
 * are held in closures owned by this function — they're per-canvas
 * instances that outlive any single session but stay tied to one
 * {@link WorkerCtx}, which is also recreated only on `init`.
 *
 * Cached worker-process GPU resources (LUT cache, offscreen pool, dummy
 * textures) live in `worker/resources.ts` as module-level state; this
 * module wires the ctx accessors to those resource helpers.
 *
 * The `post` callback is supplied by the caller (the entry-point worker
 * file) so this module doesn't reach into `self.postMessage`.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { WorkerToMainMessage } from "../workerProtocol.ts";
import { initGPU } from "../gpuContext.ts";
import { SliceRenderer } from "../sliceRenderer.ts";
import { VolumeRenderer } from "../volumeRenderer.ts";
import { LayerCompositor } from "../layerCompositor.ts";
import { CursorRenderer } from "../cursorRenderer.ts";
import { computeWantedSet } from "../wantedSet.ts";
import {
  buildDescriptorBuffer,
  destroyDescriptorBuffer,
} from "../descriptorBuffer.ts";
import { createInitialState } from "./state.ts";
import {
  ensureOffscreenPool,
  getDummy3DTexture,
  getDummyTexture,
  getOrCreateLUT,
} from "./resources.ts";
import { GpuResourceBudget } from "../gpuResourceBudget.ts";
import { GPU_SESSION_BUDGET } from "../workerProtocol.ts";

/**
 * Bootstrap the worker: init the GPU, create a fresh {@link RendererState},
 * and assemble the {@link WorkerCtx} (with lazy renderer accessors +
 * lookup helpers + post wiring). Called once from `case "init"` in
 * `gpu.worker.ts`.
 */
export async function bootstrapWorker(
  canvas: OffscreenCanvas,
  post: (msg: WorkerToMainMessage, transfer?: Transferable[]) => void,
): Promise<WorkerCtx> {
  const { device, context, format } = await initGPU(canvas);
  const state = createInitialState();
  const gpuResources = new GpuResourceBudget(GPU_SESSION_BUDGET);

  // Renderer-class singletons (lazy-init on first use). Persisted across
  // messages; not per-session state, so they stay in this closure rather
  // than on RendererState.
  let sliceRenderer: SliceRenderer | null = null;
  let volumeRenderer: VolumeRenderer | null = null;
  let compositor: LayerCompositor | null = null;
  let cursorRenderer: CursorRenderer | null = null;

  /** Compute and post wanted-set delta from current cold state + atlas state. */
  function postWantedSet(): void {
    if (!state.currentColdState || !state.currentEpochs) return;
    const result = computeWantedSet(
      state.currentColdState,
      state.volumeAtlases,
      state.sliceAtlases,
      state.memberTierToPool,
    );
    post({
      type: "wantedSetDelta",
      datasetId: state.currentColdState.datasetId,
      epochs: state.currentEpochs,
      missing: result.missing,
    });
  }

  const ctx: WorkerCtx = {
    device,
    context,
    format,
    gpuResources,
    state,
    getSliceRenderer() {
      if (!sliceRenderer) sliceRenderer = new SliceRenderer(device, gpuResources);
      return sliceRenderer;
    },
    getVolumeRenderer() {
      if (!volumeRenderer) volumeRenderer = new VolumeRenderer(device, gpuResources);
      return volumeRenderer;
    },
    getCompositor() {
      if (!compositor) compositor = new LayerCompositor(device, format);
      return compositor;
    },
    getCursorRenderer() {
      if (!cursorRenderer) cursorRenderer = new CursorRenderer(device, format, gpuResources);
      return cursorRenderer;
    },
    destroyRenderers() {
      sliceRenderer?.destroy();
      volumeRenderer?.destroy();
      cursorRenderer?.destroy();
      sliceRenderer = null;
      volumeRenderer = null;
      cursorRenderer = null;
      compositor = null;
    },
    ensureOffscreenPool: (count, w, h) => ensureOffscreenPool(device, gpuResources, count, w, h),
    getDummyTexture: () => getDummyTexture(device, gpuResources),
    getDummy3DTexture: () => getDummy3DTexture(device, gpuResources),
    getOrCreateLUT: (name) => getOrCreateLUT(device, gpuResources, name),
    post,
    postWantedSet,
    lookupEntityDescriptor(datasetId: string) {
      return state.descriptorBuffersByDataset.get(datasetId) ?? null;
    },
  };

  return ctx;
}

/**
 * Rebuild the per-dataset entity descriptor buffer iff the dataset
 * matches the current cold state.
 */
export function rebuildDescriptorIfMatching(ctx: WorkerCtx, datasetId: string): void {
  const state = ctx.state;
  if (!state.currentColdState || state.currentColdState.datasetId !== datasetId) return;
  const oldDesc = state.descriptorBuffersByDataset.get(datasetId);
  if (oldDesc) destroyDescriptorBuffer(oldDesc);
  state.descriptorBuffersByDataset.set(
    datasetId,
    buildDescriptorBuffer(
      ctx.device,
      state.currentColdState,
      state.currentEntityMetasByDataset.get(datasetId) ?? new Map(),
      ctx.gpuResources,
    ),
  );
}
