/**
 * Worker bootstrap: initialize the GPU device and canvas context, build the
 * per-session {@link RendererState}, and assemble the {@link WorkerCtx}.
 *
 * Renderer singletons live in this function's closure: they are per-device,
 * outlive any session, and are recreated on `init` and when a lost device is
 * replaced. The caller supplies `post` so this module never reaches into
 * `self.postMessage`.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { WorkerToMainMessage } from "../workerProtocol.ts";
import { initGPU, requestGpuDevice } from "../gpuContext.ts";
import { fitBudgets } from "../../deviceBudget.ts";
import { SliceRenderer } from "../sliceRenderer.ts";
import { VolumeRenderer } from "../volumeRenderer.ts";
import { LayerCompositor } from "../layerCompositor.ts";
import { CursorRenderer } from "../cursorRenderer.ts";
import { computeWantedSet } from "../wantedSet.ts";
import { createInitialState, type RendererState } from "./state.ts";
import { ensureOffscreenPool, getOrCreateLUT } from "./resources.ts";
import { createFrameTiming, type FrameTiming } from "../passTiming.ts";
import { watchDevice } from "./deviceLoss.ts";
import { sourceKey } from "../poolKeys.ts";
import type { ResidencyTier } from "../../pipeline/residencyTier.ts";

/** What is built on one device and rebuilt on its replacement. */
interface DeviceRenderers {
  slice: SliceRenderer;
  compositor: LayerCompositor;
  cursor: CursorRenderer;
  volume: VolumeRenderer | null;
  passTimer: FrameTiming;
}

function createRenderers(
  device: GPUDevice,
  format: GPUTextureFormat,
  post: (msg: WorkerToMainMessage, transfer?: Transferable[]) => void,
): DeviceRenderers {
  // The slice path's three renderers are built here so their shader compile
  // overlaps the dataset open instead of delaying the first present. The
  // volume renderer is built on first need, because its compile is the
  // longest of the four and a slice open never needs it.
  return {
    slice: new SliceRenderer(device),
    compositor: new LayerCompositor(device, format),
    cursor: new CursorRenderer(device, format),
    volume: null,
    passTimer: createFrameTiming(device, (gpuPassUs) => post({ type: "gpuPassTime", gpuPassUs })),
  };
}

/**
 * Init the GPU and assemble a fresh {@link WorkerCtx}. Called once from
 * `case "init"` in `gpu.worker.ts`. `schedule` runs a task in the worker's
 * message order, which is where a lost device is replaced.
 */
export async function bootstrapWorker(
  canvas: OffscreenCanvas,
  post: (msg: WorkerToMainMessage, transfer?: Transferable[]) => void,
  deviceMemoryGiB: number | null = null,
  schedule: (task: () => Promise<void>) => void = (task) => void task(),
): Promise<WorkerCtx> {
  const { device, context, format } = await initGPU(canvas);
  const state = createInitialState(fitBudgets(deviceMemoryGiB).gpuTotalBytes);
  let renderers = createRenderers(device, format, post);
  // The page holds the minimap overlay's content draws until this report
  // (Minimap.tsx).
  Promise.all([renderers.slice.compiled, renderers.compositor.compiled, renderers.cursor.compiled]).then(
    () => post({ type: "pipelinesCompiled" }),
    (err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }),
  );

  const postWantedSet = createWantedSetPoster(state, post);

  const ctx: WorkerCtx = {
    device,
    context,
    format,
    state,
    passTimer: renderers.passTimer,
    getSliceRenderer() {
      return renderers.slice;
    },
    getVolumeRenderer() {
      if (!renderers.volume) renderers.volume = new VolumeRenderer(ctx.device);
      return renderers.volume;
    },
    getCompositor() {
      return renderers.compositor;
    },
    getCursorRenderer() {
      return renderers.cursor;
    },
    ensureOffscreenPool: (count, w, h) => ensureOffscreenPool(ctx, count, w, h),
    getOrCreateLUT: (name) => getOrCreateLUT(ctx.device, name),
    post,
    postWantedSet,
    lookupEntityDescriptor(datasetId: string) {
      return state.descriptorBuffersByDataset.get(datasetId) ?? null;
    },
  };

  watchDevice(ctx, device, {
    schedule,
    requestDevice: requestGpuDevice,
    adopt(next) {
      ctx.device = next;
      renderers = createRenderers(next, format, post);
      ctx.passTimer = renderers.passTimer;
    },
  });
  return ctx;
}

/**
 * Build {@link WorkerCtx.postWantedSet} over one worker's state. Kept apart
 * from {@link bootstrapWorker} so a test can run the real report without a GPU.
 */
export function createWantedSetPoster(
  state: RendererState,
  post: (msg: WorkerToMainMessage, transfer?: Transferable[]) => void,
): (datasetId?: string) => void {
  return function postWantedSet(datasetId?: string): void {
    const cold = datasetId === undefined
      ? state.currentColdState
      : state.coldStateByDataset.get(datasetId) ?? null;
    if (!cold) return;
    const epochs = cold === state.currentColdState ? state.currentEpochs ?? cold.epochs : cold.epochs;
    const result = computeWantedSet(
      cold,
      state.wantedByDataset.get(cold.datasetId) ?? new Map(),
      state.volumeAtlases,
      state.sliceAtlases,
      (memberId, tier, level) =>
        state.memberSourcePools.get(memberId)?.get(sourceKey(tier, level)),
    );
    // Ahead of the missing list, which names these too: the page was told
    // they were held, and a missing chunk it holds is a disagreement.
    const stale = new Map<string, { memberId: string; tier: ResidencyTier; keys: string[] }>();
    for (const { memberId, tier, chunkKey } of result.stalePlanes) {
      const id = `${tier}|${memberId}`;
      const group = stale.get(id);
      if (group) group.keys.push(chunkKey);
      else stale.set(id, { memberId, tier, keys: [chunkKey] });
    }
    for (const { memberId, tier, keys } of stale.values()) {
      post({ type: "chunkResidency", memberId, tier, change: "lost", keys, reason: "wrong-slice" });
    }
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
  };
}
