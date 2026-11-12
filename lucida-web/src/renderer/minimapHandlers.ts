import type { WorkerCtx } from "./workerContext.ts";
import type {
  MinimapInitMessage,
  MinimapLayersMessage,
  MinimapRenderMessage,
  MinimapUploadOverviewChunksForLayerMessage,
  OverviewLayers,
  ThumbnailRenderMessage,
} from "./workerProtocol.ts";
import { createOffscreenTarget } from "./gpuContext.ts";
import { createMemberIdTarget, MEMBER_ID_BYTES_PER_TEXEL } from "./volumeRenderer.ts";
import { allocateWatched } from "./worker/gpuErrors.ts";
import { handleGpuOutOfMemory } from "./worker/gpuBudget.ts";
import { setGpuLedgerLine } from "./worker/gpuLedger.ts";
import { OFFSCREEN_BYTES_PER_TEXEL } from "./worker/viewResources.ts";
import {
  createOverviewAtlases,
  dropAllOverviews,
  dropDatasetOverviews,
  dropMemberOverviews,
  dropOverview,
  openOverview,
  overviewHolds,
  overviewSelection,
  writeOverviewChunks,
  type OverviewAtlases,
  type OverviewSpec,
} from "./overviewAtlas.ts";
import { createOverviewDrawCache, drawOverviews, resetOverviewDrawCache, type OverviewDrawCache } from "./overviewDraw.ts";

/** A target to draw into and the id target its member batches mark, of one size. */
interface DrawTargets {
  scratch: GPUTexture | null;
  memberIds: GPUTexture | null;
  width: number;
  height: number;
}

function noTargets(): DrawTargets {
  return { scratch: null, memberIds: null, width: 0, height: 0 };
}

/**
 * What the minimap and the explore thumbnails hold on the worker: the
 * overview atlases both draw from, the overviews the minimap draws, and each
 * one's canvas and targets. The worker's renderer state holds one, as it
 * holds each view's frames.
 */
export interface MinimapRendererState {
  atlases: OverviewAtlases;
  /** The overviews the minimap draws, as the page last sent them. */
  layers: OverviewLayers | null;
  draw: OverviewDrawCache;
  context: GPUCanvasContext | null;
  targets: DrawTargets;
  /**
   * Thumbnails draw the same overviews to their own square targets and
   * `OffscreenCanvas`, then `transferToImageBitmap()` back to the main
   * thread. One render finishes before the next starts, so one target and
   * one canvas are enough.
   */
  thumbnailCanvas: OffscreenCanvas | null;
  thumbnailContext: GPUCanvasContext | null;
  thumbnailTargets: DrawTargets;
  thumbnailDraw: OverviewDrawCache;
  /**
   * The latest overview render to arrive before the volume renderer
   * compiled. Earlier ones would only be painted over.
   */
  deferredRender: MinimapRenderMessage | null;
}

export function createMinimapRendererState(): MinimapRendererState {
  return {
    atlases: createOverviewAtlases(),
    layers: null,
    draw: createOverviewDrawCache(),
    context: null,
    targets: noTargets(),
    thumbnailCanvas: null,
    thumbnailContext: null,
    thumbnailTargets: noTargets(),
    thumbnailDraw: createOverviewDrawCache(),
    deferredRender: null,
  };
}

function targetBytes(targets: DrawTargets): number {
  const texels = targets.width * targets.height;
  return (targets.scratch ? texels * OFFSCREEN_BYTES_PER_TEXEL : 0) + (targets.memberIds ? texels * MEMBER_ID_BYTES_PER_TEXEL : 0);
}

function noteMinimapTargetBytes(m: MinimapRendererState): void {
  setGpuLedgerLine("minimapTargets", targetBytes(m.targets) + targetBytes(m.thumbnailTargets));
}

function releaseTargets(targets: DrawTargets): void {
  targets.scratch?.destroy();
  targets.memberIds?.destroy();
  Object.assign(targets, noTargets());
}

/**
 * `targets`, made `w` by `h`. A target the device can't allocate leaves
 * them, so the next render makes it again under the halved total.
 */
function ensureTargets(ctx: WorkerCtx, targets: DrawTargets, w: number, h: number): { scratch: GPUTexture; memberIds: GPUTexture } {
  const m = ctx.state.minimap;
  if (w !== targets.width || h !== targets.height) {
    releaseTargets(targets);
    targets.width = w;
    targets.height = h;
  }
  const watched = (make: () => GPUTexture, slot: "scratch" | "memberIds") =>
    allocateWatched(ctx, make, (lost) => {
      if (targets[slot] !== lost) return;
      targets[slot] = null;
      lost.destroy();
      noteMinimapTargetBytes(m);
      handleGpuOutOfMemory(ctx);
    });
  targets.scratch ??= watched(() => createOffscreenTarget(ctx.device, w, h), "scratch");
  targets.memberIds ??= watched(() => createMemberIdTarget(ctx.device, w, h), "memberIds");
  noteMinimapTargetBytes(m);
  return { scratch: targets.scratch, memberIds: targets.memberIds };
}

function ensureThumbnailCanvas(ctx: WorkerCtx, size: number): void {
  const m = ctx.state.minimap;
  if (size !== m.thumbnailTargets.width || !m.thumbnailCanvas) {
    // The canvas is reconfigured (not just resized) so its backing store matches
    // the new size; a fresh context keeps the configure() simple.
    m.thumbnailCanvas = new OffscreenCanvas(size, size);
    m.thumbnailContext = m.thumbnailCanvas.getContext("webgpu") as GPUCanvasContext;
    m.thumbnailContext.configure({ device: ctx.device, format: ctx.format, alphaMode: "opaque" });
  }
  if (m.thumbnailCanvas.width !== size || m.thumbnailCanvas.height !== size) {
    m.thumbnailCanvas.width = size;
    m.thumbnailCanvas.height = size;
  }
}

export function handleMinimapInit(ctx: WorkerCtx, msg: MinimapInitMessage): void {
  const m = ctx.state.minimap;
  const canvas = msg.canvas;
  m.context = canvas.getContext("webgpu") as GPUCanvasContext;
  m.context.configure({ device: ctx.device, format: ctx.format, alphaMode: "opaque" });
}

export function handleMinimapLayers(ctx: WorkerCtx, msg: MinimapLayersMessage): void {
  const m = ctx.state.minimap;
  m.layers = msg.layers;
  // A render still waiting on the compile names the old layers' displays,
  // which index other groups. The page renders the new layers itself.
  m.deferredRender = null;
}

/** Whether every pipeline an overview draw takes has compiled. */
function overviewPipelinesReady(ctx: WorkerCtx): boolean {
  return ctx.getVolumeRenderer().isCompiled && ctx.getCompositor().isCompiled;
}

/** Resolves once every pipeline an overview draw takes has compiled. */
function overviewPipelinesCompiled(ctx: WorkerCtx): Promise<unknown> {
  return Promise.all([ctx.getVolumeRenderer().compiled, ctx.getCompositor().compiled]);
}

export function handleMinimapRender(ctx: WorkerCtx, msg: MinimapRenderMessage): void {
  const m = ctx.state.minimap;
  if (!m.context) return;
  if (overviewPipelinesReady(ctx)) {
    drawMinimap(ctx, msg);
    return;
  }

  // The volume renderer is built on first need, often by this render, and
  // its compile is the longest of the four. An await here would hold every
  // viewport frame and upload behind it in the message order, so the draw
  // waits outside that order instead (`pipelineCompile.ts`).
  const first = m.deferredRender === null;
  m.deferredRender = msg;
  if (!first) return;
  overviewPipelinesCompiled(ctx).then(
    () => {
      const pending = m.deferredRender;
      m.deferredRender = null;
      if (pending && m.context) drawMinimap(ctx, pending);
    },
    (err: unknown) => {
      m.deferredRender = null;
      postCompileFailure(ctx, err);
    },
  );
}

/** A compile that failed outside the message order, reported as a handler's throw is. */
function postCompileFailure(ctx: WorkerCtx, err: unknown): void {
  ctx.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
}

/** The volume renderer's member draw sets the minimap and the thumbnails draw through. */
const MINIMAP_DRAWS = "minimap";
const THUMBNAIL_DRAWS = "thumbnail";

function drawMinimap(ctx: WorkerCtx, msg: MinimapRenderMessage): void {
  const m = ctx.state.minimap;
  if (!m.context) return;
  const mmCanvas = m.context.canvas as OffscreenCanvas;
  mmCanvas.width = msg.canvasW;
  mmCanvas.height = msg.canvasH;

  const comp = ctx.getCompositor();
  const { scratch, memberIds } = ensureTargets(ctx, m.targets, msg.canvasW, msg.canvasH);
  const minimapView = m.context.getCurrentTexture().createView();
  const encoder = ctx.device.createCommandEncoder();
  const drawn = m.layers
    ? drawOverviews(ctx, m.draw, MINIMAP_DRAWS, m.layers, msg.displays, msg, {
      view: minimapView, scratch, memberIds, width: msg.canvasW, height: msg.canvasH,
    }, encoder)
    : 0;

  // Drawn even with no overview resident, so the minimap shows the canvas
  // background rather than whatever it last held.
  if (drawn === 0) comp.composite(minimapView, [], encoder);
  comp.underlayBackground(minimapView, encoder);
  ctx.device.queue.submit([encoder.finish()]);
}

/**
 * Render one Explore-panel thumbnail off-screen as an `ImageBitmap`. Same draw
 * as `handleMinimapRender`, at the overview level only, so off-axis cameras
 * cost no streaming. Replies `bitmap: null` when no overview is resident.
 */
export function handleThumbnailRender(ctx: WorkerCtx, msg: ThumbnailRenderMessage): void {
  if (overviewPipelinesReady(ctx)) {
    drawThumbnail(ctx, msg);
    return;
  }
  // Waits outside the message order for the same reason the overview render
  // does. Replies carry their request's id, so their order is free. A request
  // whose compile failed gets a reply with no bitmap, so the panel's wait
  // settles.
  overviewPipelinesCompiled(ctx).then(
    () => drawThumbnail(ctx, msg),
    (err: unknown) => {
      ctx.post({ type: "thumbnailResult", id: msg.id, bitmap: null });
      postCompileFailure(ctx, err);
    },
  );
}

function drawThumbnail(ctx: WorkerCtx, msg: ThumbnailRenderMessage): void {
  const m = ctx.state.minimap;
  const size = Math.max(1, Math.round(msg.size));
  const comp = ctx.getCompositor();
  ensureThumbnailCanvas(ctx, size);
  const { scratch, memberIds } = ensureTargets(ctx, m.thumbnailTargets, size, size);

  if (!msg.layers.keys.some((key) => m.atlases.overviews.has(key)) || !m.thumbnailContext || !m.thumbnailCanvas) {
    // Nothing to draw. Reply anyway so the pending promise resolves and the
    // panel keeps its label-only row.
    ctx.post({ type: "thumbnailResult", id: msg.id, bitmap: null });
    return;
  }

  const thumbnailView = m.thumbnailContext.getCurrentTexture().createView();
  const encoder = ctx.device.createCommandEncoder();
  drawOverviews(ctx, m.thumbnailDraw, THUMBNAIL_DRAWS, msg.layers, msg.displays, msg, {
    view: thumbnailView, scratch, memberIds, width: size, height: size,
  }, encoder);
  comp.underlayBackground(thumbnailView, encoder);
  ctx.device.queue.submit([encoder.finish()]);

  // The canvas is reused for the next thumbnail, so snapshot it rather than
  // transfer the canvas itself. The next render clears what this empties.
  const bitmap = m.thumbnailCanvas.transferToImageBitmap();
  ctx.post({ type: "thumbnailResult", id: msg.id, bitmap }, [bitmap]);
}

export function handleMinimapUploadOverviewChunks(ctx: WorkerCtx, msg: MinimapUploadOverviewChunksForLayerMessage): void {
  const { atlases } = ctx.state.minimap;
  const spec: OverviewSpec = {
    datasetId: msg.datasetId,
    imageId: msg.imageId,
    level: msg.level,
    t: msg.t,
    c: msg.c,
    levelDims: [msg.levelWidth, msg.levelHeight, msg.levelDepth],
    chunkDims: [msg.chunkX, msg.chunkY, msg.chunkZ],
    format: msg.sampleFormat,
  };
  let overview = atlases.overviews.get(msg.overviewKey);
  if (overview && !overviewHolds(overview, spec)) {
    dropOverview(atlases, msg.overviewKey);
    overview = undefined;
  }

  if (!overview) {
    // A refused overview stays refused for its selection: taking it later
    // would draw only the chunks that arrived after, which the page counts as
    // sent.
    const selection = overviewSelection(spec);
    const refused = ctx.state.overviewsRefused;
    if (refused.get(msg.overviewKey)?.selection === selection) return;
    refused.delete(msg.overviewKey);
    const opened = openOverview(ctx, atlases, msg.overviewKey, spec);
    if (!opened) {
      refused.set(msg.overviewKey, { selection, datasetId: spec.datasetId, imageId: spec.imageId });
      return;
    }
    overview = opened;
  }
  writeOverviewChunks(ctx, overview, msg.chunks);
}

export function handleMinimapDestroy(m: MinimapRendererState): void {
  m.deferredRender = null;
  releaseTargets(m.targets);
  if (m.context) {
    m.context.unconfigure();
    m.context = null;
  }
  // Thumbnail off-screen render state shares the overview atlases + renderer
  // with the minimap, so it's torn down here too.
  releaseTargets(m.thumbnailTargets);
  if (m.thumbnailContext) {
    m.thumbnailContext.unconfigure();
    m.thumbnailContext = null;
  }
  m.thumbnailCanvas = null;
  noteMinimapTargetBytes(m);
}

/**
 * Forget every texture the minimap and thumbnails built on a lost device. The
 * minimap canvas stays, for {@link rebindMinimapCanvas} to point at the next one.
 */
export function releaseMinimapDeviceResources(m: MinimapRendererState): void {
  m.deferredRender = null;
  dropAllOverviews(m.atlases);
  releaseTargets(m.targets);
  releaseTargets(m.thumbnailTargets);
  resetOverviewDrawCache(m.draw);
  resetOverviewDrawCache(m.thumbnailDraw);
  m.thumbnailContext = null;
  m.thumbnailCanvas = null;
  noteMinimapTargetBytes(m);
}

/** Point the minimap canvas, if there is one, at the worker's current device. */
export function rebindMinimapCanvas(ctx: WorkerCtx): void {
  const m = ctx.state.minimap;
  m.context?.configure({ device: ctx.device, format: ctx.format, alphaMode: "opaque" });
}

/**
 * Free a removed dataset's overview atlases, or a removed member's overviews,
 * and forget their refusals: a dataset reopened under its id is new.
 */
export function removeMinimapResources(ctx: WorkerCtx, id: string): void {
  const { atlases } = ctx.state.minimap;
  dropDatasetOverviews(atlases, id);
  dropMemberOverviews(atlases, id);
  for (const [key, refused] of ctx.state.overviewsRefused) {
    if (refused.datasetId === id || refused.imageId === id) ctx.state.overviewsRefused.delete(key);
  }
}

export function destroyAllMinimapResources(m: MinimapRendererState): void {
  dropAllOverviews(m.atlases);
  handleMinimapDestroy(m);
}
