/**
 * Worker bootstrap: initialize the GPU device and canvas context, build the
 * per-session {@link RendererState}, and assemble the {@link WorkerCtx}.
 *
 * Renderer singletons live in this function's closure: they are per-canvas,
 * outlive any session, and are recreated only on `init`. The caller supplies
 * `post` so this module never reaches into `self.postMessage`.
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
import { ensureOffscreenPool, getOrCreateLUT } from "./resources.ts";
import { createFrameTiming } from "../passTiming.ts";
import { proxyDescriptorKey } from "../workerContext.ts";
import { sourceKey } from "../poolKeys.ts";

/** Init the GPU and assemble a fresh {@link WorkerCtx}. Called once from `case "init"` in `gpu.worker.ts`. */
export async function bootstrapWorker(
  canvas: OffscreenCanvas,
  post: (msg: WorkerToMainMessage, transfer?: Transferable[]) => void,
): Promise<WorkerCtx> {
  const { device, context, format } = await initGPU(canvas);
  const state = createInitialState();
  const passTimer = createFrameTiming(device, (gpuPassUs) =>
    post({ type: "gpuPassTime", gpuPassUs }),
  );

  // The slice path's three renderers are built here so their shader compile
  // overlaps the dataset open instead of delaying the first present. The
  // volume renderer is built on first need, because its compile is the
  // longest of the four and a slice open never needs it.
  const sliceRenderer = new SliceRenderer(device);
  const compositor = new LayerCompositor(device, format);
  const cursorRenderer = new CursorRenderer(device, format);
  let volumeRenderer: VolumeRenderer | null = null;
  // The page holds the minimap overlay's content draws until this report
  // (Minimap.tsx).
  Promise.all([sliceRenderer.compiled, compositor.compiled, cursorRenderer.compiled]).then(
    () => post({ type: "pipelinesCompiled" }),
    (err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }),
  );

  /** A flat snapshot of a dataset's proxy pools, in the shape `computeWantedSet()` expects. */
  function buildProxyAtlasSnapshot(datasetId: string): Map<string, ProxyAtlasSnapshot> {
    const snap = new Map<string, ProxyAtlasSnapshot>();
    const pools = state.proxyPoolsByDataset.get(datasetId);
    if (!pools) return snap;
    for (const [poolKey, pool] of pools) {
      snap.set(poolKey, { kind: pool.kind, slots: pool.slots });
    }
    return snap;
  }

  /** See `WorkerCtx.postWantedSet`. */
  function postWantedSet(datasetId?: string): void {
    const cold = datasetId === undefined
      ? state.currentColdState
      : state.coldStateByDataset.get(datasetId) ?? null;
    if (!cold) return;
    const epochs = cold === state.currentColdState ? state.currentEpochs ?? cold.epochs : cold.epochs;
    const proxySnap = buildProxyAtlasSnapshot(cold.datasetId);
    const result = computeWantedSet(
      cold,
      state.volumeAtlases,
      state.sliceAtlases,
      (memberId, tier, level) =>
        state.memberSourcePools.get(memberId)?.get(sourceKey(tier, level)),
      proxySnap,
    );
    post({
      type: "wantedSetDelta",
      datasetId: cold.datasetId,
      epochs,
      missing: result.missing,
    });
    post({
      type: "entityLevels",
      datasetId: cold.datasetId,
      entities: result.levels,
    });
  }

  const ctx: WorkerCtx = {
    device,
    context,
    format,
    state,
    passTimer,
    getSliceRenderer() {
      return sliceRenderer;
    },
    getVolumeRenderer() {
      if (!volumeRenderer) volumeRenderer = new VolumeRenderer(device);
      return volumeRenderer;
    },
    getCompositor() {
      return compositor;
    },
    getCursorRenderer() {
      return cursorRenderer;
    },
    ensureOffscreenPool: (count, w, h) => ensureOffscreenPool(device, count, w, h),
    getOrCreateLUT: (name) => getOrCreateLUT(device, name),
    post,
    postWantedSet,
    lookupProxyDescriptor(entityId: string, t: number, c: number) {
      return state.proxyDescriptorsByEntity.get(proxyDescriptorKey(entityId, t, c)) ?? null;
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
 * Rebuild the entity descriptor buffer iff `datasetId` is the current cold
 * state. Other datasets' proxy uploads stay resident, but their descriptor
 * waits for their own cold state.
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
      state.currentSourcesByDataset.get(datasetId) ?? new Map(),
    ),
  );
}
