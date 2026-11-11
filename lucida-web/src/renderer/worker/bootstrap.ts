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
import type { PoolMode, WorkerToMainMessage } from "../workerProtocol.ts";
import { initGPU, requestGpuDevice } from "../gpuContext.ts";
import { fitBudgets } from "../../deviceBudget.ts";
import { SliceRenderer } from "../sliceRenderer.ts";
import { VolumeRenderer } from "../volumeRenderer.ts";
import { LayerCompositor } from "../layerCompositor.ts";
import { CursorRenderer } from "../cursorRenderer.ts";
import { computeWantedSet, type AtlasSnapshot } from "../wantedSet.ts";
import { createInitialState, type RendererState, type ViewDraw } from "./state.ts";
import { drawOf, drawsOf } from "./draws.ts";
import type { SliceAtlasState } from "../slice/atlas.ts";
import type { AtlasState } from "../volume/atlas.ts";
import { getOrCreateLUT } from "./resources.ts";
import { viewLayerTargets } from "./viewResources.ts";
import { ViewLander } from "../viewLander.ts";
import { createFrameTiming, type FrameTiming } from "../passTiming.ts";
import { watchDevice } from "./deviceLoss.ts";
import { sourceKey } from "../poolKeys.ts";

/** What is built on one device and rebuilt on its replacement. */
interface DeviceRenderers {
  slice: SliceRenderer;
  compositor: LayerCompositor;
  cursor: CursorRenderer;
  volume: VolumeRenderer | null;
  lander: ViewLander | null;
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
    lander: null,
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
    getViewLander() {
      // Built on first need: one view across the canvas never lands any.
      if (!renderers.lander) renderers.lander = new ViewLander(ctx.device, ctx.format);
      return renderers.lander;
    },
    ensureOffscreenPool: (view, count, w, h) => viewLayerTargets(ctx, view, count, w, h),
    getOrCreateLUT: (name) => getOrCreateLUT(ctx.device, name),
    post,
    postWantedSet,
    lookupEntityDescriptor(datasetId: string, view: number) {
      return drawOf(state, datasetId, view)?.descriptor ?? null;
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
): (datasetId?: string, mode?: PoolMode, view?: number) => void {
  return function postWantedSet(datasetId?: string, mode?: PoolMode, view?: number): void {
    if (datasetId === undefined) {
      const cold = state.currentColdState;
      const draw = cold ? drawOf(state, cold.datasetId, cold.view) : undefined;
      if (draw) postFor(draw);
      return;
    }
    for (const draw of drawsOf(state, datasetId, mode)) {
      if (view === undefined || draw.view === view) postFor(draw);
    }
  };

  function postFor(draw: ViewDraw): void {
    const { cold, mode } = draw;
    const epochs = cold === state.currentColdState ? state.currentEpochs ?? cold.epochs : cold.epochs;
    const result = computeWantedSet(
      cold,
      draw.wanted,
      mode === "volume" ? viewSnapshots(state.volumeAtlases, draw) : new Map(),
      mode === "slice" ? viewSnapshots(state.sliceAtlases, draw) : new Map(),
      (memberId, tier, level) => draw.routes.get(memberId)?.get(sourceKey(tier, level)),
    );
    post({
      type: "wantedSetDelta",
      datasetId: cold.datasetId,
      viewMode: mode,
      epochs,
      missing: result.missing,
    });
    post({
      type: "entityLevels",
      datasetId: cold.datasetId,
      view: draw.view,
      entities: result.levels,
    });
  }
}

/**
 * The pools `draw`'s view draws from, each as that view samples it: the
 * shared slots, read through the view's sections at the view's Z.
 */
function viewSnapshots(
  atlases: ReadonlyMap<string, SliceAtlasState | AtlasState>,
  draw: ViewDraw,
): Map<string, AtlasSnapshot> {
  const out = new Map<string, AtlasSnapshot>();
  for (const [poolKey, atlas] of atlases) {
    const view = atlas.views.get(draw.view);
    if (!view || atlas.datasetId !== draw.datasetId) continue;
    out.set(poolKey, {
      z: draw.cold.currentZ,
      slots: atlas.slots,
      planesByChunk: "planesByChunk" in atlas ? atlas.planesByChunk : undefined,
      entityMetas: view.entityMetas,
    });
  }
  return out;
}
