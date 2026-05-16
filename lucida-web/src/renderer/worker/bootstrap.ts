/**
 * Worker bootstrap: initialize the GPU device + canvas context, build
 * the per-session {@link RendererState}, and assemble the
 * {@link WorkerCtx} that the dispatcher and per-mode handlers consume.
 *
 * Extracted from the `case "init"` body of `gpu.worker.ts` in Slice 9 so
 * the entry point shrinks to a thin event listener. Renderer-class
 * singletons (slice/volume/cursor/compositor renderers) are held in
 * closures owned by this function — they're per-canvas instances that
 * outlive any single session but stay tied to one {@link WorkerCtx},
 * which is also recreated only on `init`.
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
import { computeWantedSet, type ProxyAtlasSnapshot } from "../wantedSet.ts";
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

/**
 * Bootstrap the worker: init the GPU, create a fresh {@link RendererState},
 * and assemble the {@link WorkerCtx} (with lazy renderer accessors +
 * lookup helpers + post wiring). Called once from `case "init"` in
 * `gpu.worker.ts`.
 */
export async function bootstrapWorker(
  canvas: OffscreenCanvas,
  post: (msg: WorkerToMainMessage) => void,
): Promise<WorkerCtx> {
  const { device, context, format } = await initGPU(canvas);
  const state = createInitialState();

  // Renderer-class singletons (lazy-init on first use). Persisted across
  // messages; not per-session state, so they stay in this closure rather
  // than on RendererState.
  let sliceRenderer: SliceRenderer | null = null;
  let volumeRenderer: VolumeRenderer | null = null;
  let compositor: LayerCompositor | null = null;
  let cursorRenderer: CursorRenderer | null = null;

  /**
   * Build a flat snapshot of all proxy pools for a dataset, in the shape
   * `computeWantedSet()` expects. Cheap — pool maps are small.
   */
  function buildProxyAtlasSnapshot(datasetId: string): Map<string, ProxyAtlasSnapshot> {
    const snap = new Map<string, ProxyAtlasSnapshot>();
    const pools = state.proxyPoolsByDataset.get(datasetId);
    if (!pools) return snap;
    for (const [poolKey, pool] of pools) {
      snap.set(poolKey, { kind: pool.kind, slots: pool.slots });
    }
    return snap;
  }

  /** Compute and post wanted-set delta from current cold state + atlas state. */
  function postWantedSet(): void {
    if (!state.currentColdState || !state.currentEpochs) return;
    const proxySnap = buildProxyAtlasSnapshot(state.currentColdState.datasetId);
    const result = computeWantedSet(
      state.currentColdState,
      state.volumeAtlases,
      state.sliceAtlases,
      state.memberToPool,
      proxySnap,
    );
    post({ type: "wantedSetDelta", epochs: state.currentEpochs, missing: result.missing });
  }

  const ctx: WorkerCtx = {
    device,
    context,
    format,
    state,
    getSliceRenderer() {
      if (!sliceRenderer) sliceRenderer = new SliceRenderer(device);
      return sliceRenderer;
    },
    getVolumeRenderer() {
      if (!volumeRenderer) volumeRenderer = new VolumeRenderer(device);
      return volumeRenderer;
    },
    getCompositor() {
      if (!compositor) compositor = new LayerCompositor(device, format);
      return compositor;
    },
    getCursorRenderer() {
      if (!cursorRenderer) cursorRenderer = new CursorRenderer(device, format);
      return cursorRenderer;
    },
    ensureOffscreenPool: (count, w, h) => ensureOffscreenPool(device, count, w, h),
    getDummyTexture: () => getDummyTexture(device),
    getDummy3DTexture: () => getDummy3DTexture(device),
    getOrCreateLUT: (name) => getOrCreateLUT(device, name),
    post,
    postWantedSet,
    lookupProxyDescriptor(entityId: string) {
      return state.proxyDescriptorsByEntity.get(entityId) ?? null;
    },
    lookupProxyPool(datasetId: string, poolKey: string) {
      const dsPools = state.proxyPoolsByDataset.get(datasetId);
      if (!dsPools) return null;
      return dsPools.get(poolKey) ?? null;
    },
    lookupEntityDescriptor(datasetId: string) {
      return state.descriptorBuffersByDataset.get(datasetId) ?? null;
    },
  };

  return ctx;
}

/**
 * Rebuild the per-dataset entity descriptor buffer iff the upload's
 * dataset matches the current cold state. Proxy uploads for other
 * datasets stay resident in their pools, but their descriptor buffer
 * isn't refreshed until cold state lands for that dataset.
 *
 * Lives here (not in `dispatch.ts`) because it's a small helper that
 * binds together cold-state, proxy, and descriptor concerns — the same
 * mix that `bootstrap` already imports.
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
      state.proxyDescriptorsByEntity,
      state.proxyPoolsByDataset,
      state.currentEntityMetasByDataset.get(datasetId) ?? new Map(),
    ),
  );
}
