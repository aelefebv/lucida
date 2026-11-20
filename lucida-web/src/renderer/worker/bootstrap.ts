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
import { DESKTOP_BUDGETS } from "../../deviceBudget.ts";
import { SliceRenderer } from "../sliceRenderer.ts";
import { VolumeRenderer } from "../volumeRenderer.ts";
import { LayerCompositor } from "../layerCompositor.ts";
import { CursorRenderer } from "../cursorRenderer.ts";
import { createInitialState } from "./state.ts";
import { drawOf } from "./draws.ts";
import { WantedSetReporter } from "./wantedSetReport.ts";
import { getOrCreateLUT } from "./resources.ts";
import { viewLayerTargets } from "./viewResources.ts";
import { ViewLander } from "../viewLander.ts";
import { createFrameTiming, type FrameTiming } from "../passTiming.ts";
import { watchDevice } from "./deviceLoss.ts";

/**
 * How long a wanted-set report asked for waits for a frame to flush it
 * before it goes out on its own: longer than a frame, so a page drawing
 * flushes it first, and short enough that a view that stopped drawing still
 * hears what it lacks.
 */
const REPORT_WAIT_MS = 100;

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
  gpuTotalBytes: number = DESKTOP_BUDGETS.gpuTotalBytes,
  schedule: (task: () => Promise<void>) => void = (task) => void task(),
): Promise<WorkerCtx> {
  const { device, context, format } = await initGPU(canvas);
  const state = createInitialState(gpuTotalBytes);
  let renderers = createRenderers(device, format, post);
  // The page holds the minimap overlay's content draws until this report
  // (Minimap.tsx).
  Promise.all([renderers.slice.compiled, renderers.compositor.compiled, renderers.cursor.compiled]).then(
    () => post({ type: "pipelinesCompiled" }),
    (err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }),
  );

  const reporter = new WantedSetReporter(state, post);
  let reportTimer: ReturnType<typeof setTimeout> | null = null;

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
    requestWantedSetReport(datasetId, mode, view) {
      reporter.request(datasetId, mode, view);
      // In message order, so it never reads the state halfway through a handler.
      reportTimer ??= setTimeout(() => {
        reportTimer = null;
        schedule(async () => reporter.flush());
      }, REPORT_WAIT_MS);
    },
    flushWantedSetReports() {
      if (reportTimer !== null) clearTimeout(reportTimer);
      reportTimer = null;
      reporter.flush();
    },
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
