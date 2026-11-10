import type { WorkerCtx } from "./workerContext.ts";
import type {
  MinimapInitMessage,
  MinimapLayerParams,
  MinimapRenderMessage,
  MinimapUploadOverviewChunksForLayerMessage,
  ThumbnailRenderMessage,
} from "./workerProtocol.ts";
import { createEmptyVolumeTexture, createOffscreenTarget, writeVolumeChunk } from "./gpuContext.ts";
import { batchLayers } from "./layerBatches.ts";
import type { VolumeMemberDraw } from "./volumeRenderer.ts";
import { computeScissorRect } from "../pipeline/upload/scissor.ts";
import { atlasTexels, atlasTextureFormat, bytesPerTexel, type SampleFormat } from "./dataTypeUtil.ts";
import { allocateWatched } from "./worker/gpuErrors.ts";
import { handleGpuOutOfMemory, reserveGpuBytes } from "./worker/gpuBudget.ts";
import { setGpuLedgerLine } from "./worker/gpuLedger.ts";
import { OFFSCREEN_BYTES_PER_TEXEL } from "./worker/viewResources.ts";
import {
  applyFailedMarks,
  cellIndex,
  emptyIndirection,
  failedCellsAt,
  failedKeysForImage,
  type CellGrid,
} from "./failedCells.ts";
import { INDIRECTION_MISS } from "./remap.ts";

interface MinimapOverviewEntry {
  texture: GPUTexture;
  format: SampleFormat;
  uploaded: Set<string>;
  imageId: string;
  level: number;
  t: number;
  c: number;
  width: number;
  height: number;
  depth: number;
  chunkDims: [number, number, number];
  grid: CellGrid;
  /**
   * Each chunk cell maps to itself once its chunk is written, so a cell
   * whose chunk never arrived misses rather than reading the texture's zeros,
   * and one whose chunk failed for good reads FAILED.
   */
  indirection: Uint32Array<ArrayBuffer>;
  indirectionBuf: GPUBuffer;
  markedFailed: Set<number>;
  /** What the texture and indirection hold, counted against the GPU total. */
  bytes: number;
}

/**
 * The share of the GPU total the minimap's overview textures may hold
 * together. One texture per member, so a collection of thousands of members
 * would otherwise take the bytes the view's own chunks need.
 */
export const MINIMAP_OVERVIEW_SHARE = 1 / 16;

/**
 * What the minimap and the explore thumbnails hold on the worker: the
 * overview textures both sample, and each one's canvas and targets. The
 * worker's renderer state holds one, as it holds each view's frames.
 */
export interface MinimapRendererState {
  overviews: Map<string, MinimapOverviewEntry>;
  overviewBytes: number;
  context: GPUCanvasContext | null;
  targets: GPUTexture[];
  targetW: number;
  targetH: number;
  /**
   * Thumbnails reuse the overview textures and renderers but draw to their
   * own square targets and `OffscreenCanvas`, then `transferToImageBitmap()`
   * back to the main thread. One render finishes before the next starts, so
   * one target and one canvas are enough.
   */
  thumbnailCanvas: OffscreenCanvas | null;
  thumbnailContext: GPUCanvasContext | null;
  thumbnailTargets: GPUTexture[];
  thumbnailSize: number;
  /**
   * The latest overview render to arrive before the volume renderer
   * compiled. Earlier ones would only be painted over.
   */
  deferredRender: MinimapRenderMessage | null;
}

export function createMinimapRendererState(): MinimapRendererState {
  return {
    overviews: new Map(),
    overviewBytes: 0,
    context: null,
    targets: [],
    targetW: 0,
    targetH: 0,
    thumbnailCanvas: null,
    thumbnailContext: null,
    thumbnailTargets: [],
    thumbnailSize: 0,
    deferredRender: null,
  };
}

function noteOverviewBytes(m: MinimapRendererState): void {
  setGpuLedgerLine("minimapTextures", m.overviewBytes);
}

function noteMinimapTargetBytes(m: MinimapRendererState): void {
  setGpuLedgerLine(
    "minimapTargets",
    (m.targets.length * m.targetW * m.targetH +
      m.thumbnailTargets.length * m.thumbnailSize * m.thumbnailSize) * OFFSCREEN_BYTES_PER_TEXEL,
  );
}

/** Make an offscreen target that leaves `pool` when the device can't allocate it. */
function watchedTarget(ctx: WorkerCtx, w: number, h: number, pool: () => GPUTexture[]): GPUTexture {
  const m = ctx.state.minimap;
  return allocateWatched(
    ctx,
    () => createOffscreenTarget(ctx.device, w, h),
    (lost) => {
      const targets = pool();
      const at = targets.indexOf(lost);
      if (at >= 0) {
        targets.splice(at, 1);
        lost.destroy();
        noteMinimapTargetBytes(m);
      }
      handleGpuOutOfMemory(ctx);
    },
  );
}

function dropOverview(m: MinimapRendererState, datasetId: string): void {
  const entry = m.overviews.get(datasetId);
  if (!entry) return;
  entry.texture.destroy();
  entry.indirectionBuf.destroy();
  m.overviewBytes -= entry.bytes;
  m.overviews.delete(datasetId);
  noteOverviewBytes(m);
}


function ensureThumbnailTargets(ctx: WorkerCtx, size: number, count: number) {
  const m = ctx.state.minimap;
  if (size !== m.thumbnailSize) {
    for (const tex of m.thumbnailTargets) tex.destroy();
    m.thumbnailTargets = [];
    m.thumbnailSize = size;
    // The canvas is reconfigured (not just resized) so its backing store matches
    // the new size; a fresh context keeps the configure() simple.
    m.thumbnailCanvas = new OffscreenCanvas(size, size);
    m.thumbnailContext = m.thumbnailCanvas.getContext("webgpu") as GPUCanvasContext;
    m.thumbnailContext.configure({ device: ctx.device, format: ctx.format, alphaMode: "opaque" });
  }
  if (m.thumbnailCanvas && (m.thumbnailCanvas.width !== size || m.thumbnailCanvas.height !== size)) {
    m.thumbnailCanvas.width = size;
    m.thumbnailCanvas.height = size;
  }
  while (m.thumbnailTargets.length < count) {
    m.thumbnailTargets.push(watchedTarget(ctx, size, size, () => m.thumbnailTargets));
  }
  noteMinimapTargetBytes(m);
}

function ensureMinimapOffscreenPool(ctx: WorkerCtx, count: number, w: number, h: number) {
  const m = ctx.state.minimap;
  if (w !== m.targetW || h !== m.targetH) {
    for (const tex of m.targets) tex.destroy();
    m.targets = [];
    m.targetW = w;
    m.targetH = h;
  }
  while (m.targets.length < count) {
    m.targets.push(watchedTarget(ctx, w, h, () => m.targets));
  }
  noteMinimapTargetBytes(m);
}

export function handleMinimapInit(ctx: WorkerCtx, msg: MinimapInitMessage): void {
  const m = ctx.state.minimap;
  const canvas = msg.canvas;
  m.context = canvas.getContext("webgpu") as GPUCanvasContext;
  m.context.configure({ device: ctx.device, format: ctx.format, alphaMode: "opaque" });
}


export function handleMinimapRender(ctx: WorkerCtx, msg: MinimapRenderMessage): void {
  const m = ctx.state.minimap;
  if (!m.context) return;
  const renderer = ctx.getVolumeRenderer();
  const comp = ctx.getCompositor();
  if (renderer.isCompiled && comp.isCompiled) {
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
  Promise.all([renderer.compiled, comp.compiled]).then(
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

function drawMinimap(ctx: WorkerCtx, msg: MinimapRenderMessage): void {
  const m = ctx.state.minimap;
  if (!m.context) return;
  const mmCanvas = m.context.canvas as OffscreenCanvas;
  mmCanvas.width = msg.canvasW;
  mmCanvas.height = msg.canvasH;

  const comp = ctx.getCompositor();
  ensureMinimapOffscreenPool(ctx, 1, msg.canvasW, msg.canvasH);
  const minimapView = m.context.getCurrentTexture().createView();
  const encoder = ctx.device.createCommandEncoder();
  const drawn = drawOverviewLayers(
    ctx, MINIMAP_DRAWS, msg, minimapView, m.targets[0], msg.canvasW, msg.canvasH, encoder,
  );

  // Drawn even with no overview resident, so the minimap shows the canvas
  // background rather than whatever it last held.
  if (drawn === 0) comp.composite(minimapView, [], encoder);
  comp.underlayBackground(minimapView, encoder);
  ctx.device.queue.submit([encoder.finish()]);
}

/** The volume renderer's member draw sets the minimap and the thumbnails draw through. */
const MINIMAP_DRAWS = "minimap";
const THUMBNAIL_DRAWS = "thumbnail";

/**
 * Draw the layers' overviews into `scratch` and composite them over `view`,
 * clearing `view` under the first. Layers whose places on the canvas do not
 * meet share one pass and one composite (`layerBatches.ts`), so a collection
 * costs a few passes, not two per member and channel, and one target serves
 * them all. Each overview binds as a level laid out in place, with its failed
 * chunks marked, and a descriptor carrying the layer's placement and
 * contrast. Returns how many layers had an overview to draw.
 */
function drawOverviewLayers(
  ctx: WorkerCtx,
  drawSet: string,
  msg: Pick<MinimapRenderMessage, "layers" | "invViewProj" | "viewProj" | "eye" | "pixelRatio">,
  view: GPUTextureView,
  scratch: GPUTexture,
  width: number,
  height: number,
  encoder: GPUCommandEncoder,
): number {
  const m = ctx.state.minimap;
  const renderer = ctx.getVolumeRenderer();
  const comp = ctx.getCompositor();
  const shown: Array<{ layer: MinimapLayerParams; overview: MinimapOverviewEntry }> = [];
  for (const layer of msg.layers) {
    const overview = m.overviews.get(layer.datasetId);
    if (!overview) continue;
    markOverviewFailed(ctx, overview);
    shown.push({ layer, overview });
  }
  if (shown.length === 0) return 0;

  renderer.setMatrices(msg.invViewProj, msg.eye);
  renderer.setPixelRatio(msg.pixelRatio);
  const descriptors = renderer.writeDescriptorTable(drawSet, shown.map(({ layer, overview }) => ({
    modelMatrix: layer.modelMatrix,
    invModelMatrix: layer.invModelMatrix,
    volumeDims: [overview.width, overview.height, overview.depth],
    contrastMin: layer.contrastMin,
    contrastMax: layer.contrastMax,
    gamma: layer.gamma,
    // Opacity is 1: the minimap shows every layer at full strength.
    opacity: 1,
    sampleFormat: overview.format,
    chunkGrid: {
      gridDims: [overview.grid.x, overview.grid.y, overview.grid.z],
      chunkDims: overview.chunkDims,
    },
  })));
  const draws: VolumeMemberDraw[] = shown.map(({ layer, overview }, i) => ({
    levels: [{
      texture: overview.texture,
      indirectionBuf: overview.indirectionBuf,
      slotsX: overview.grid.x,
      slotsY: overview.grid.y,
      slotsZ: overview.grid.z,
    }],
    coarse: null,
    colormap: ctx.getOrCreateLUT(layer.colormap),
    descriptorBuffer: descriptors,
    entityIndex: i,
    // A layer off the canvas draws nothing, as its rays would miss.
    scissor: computeScissorRect(layer.modelMatrix, msg.viewProj, width, height) ?? [0, 0, 0, 0],
  }));
  renderer.prepareMembers(drawSet, draws);

  const scratchView = scratch.createView();
  const depthView = renderer.transientDepthView(width, height);
  const batches = batchLayers(
    shown.map(({ layer }, i) => ({ rect: draws[i].scissor, blendMode: layer.blendMode })),
    width,
    height,
  );
  batches.forEach((batch, i) => {
    renderer.renderMembers(drawSet, batch.layers, scratchView, width, height, depthView, true, encoder);
    comp.composite(view, [{ view: scratchView, blendMode: batch.blendMode }], encoder, i === 0);
  });
  return shown.length;
}

/**
 * Render one Explore-panel thumbnail off-screen as an `ImageBitmap`. Same draw
 * as `handleMinimapRender`, at the overview level only, so off-axis cameras
 * cost no streaming. Replies `bitmap: null` when no overview is resident.
 */
export function handleThumbnailRender(ctx: WorkerCtx, msg: ThumbnailRenderMessage): void {
  const renderer = ctx.getVolumeRenderer();
  const comp = ctx.getCompositor();
  if (renderer.isCompiled && comp.isCompiled) {
    drawThumbnail(ctx, msg);
    return;
  }
  // Waits outside the message order for the same reason the overview render
  // does. Replies carry their request's id, so their order is free. A request
  // whose compile failed gets a reply with no bitmap, so the panel's wait
  // settles.
  Promise.all([renderer.compiled, comp.compiled]).then(
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
  ensureThumbnailTargets(ctx, size, 1);

  if (!msg.layers.some((layer) => m.overviews.has(layer.datasetId)) || !m.thumbnailContext || !m.thumbnailCanvas) {
    // Nothing to draw. Reply anyway so the pending promise resolves and the
    // panel keeps its label-only row.
    ctx.post({ type: "thumbnailResult", id: msg.id, bitmap: null });
    return;
  }

  const thumbnailView = m.thumbnailContext.getCurrentTexture().createView();
  const encoder = ctx.device.createCommandEncoder();
  drawOverviewLayers(ctx, THUMBNAIL_DRAWS, msg, thumbnailView, m.thumbnailTargets[0], size, size, encoder);
  comp.underlayBackground(thumbnailView, encoder);
  ctx.device.queue.submit([encoder.finish()]);

  // The canvas is reused for the next thumbnail, so snapshot it rather than
  // transfer the canvas itself. The next render clears what this empties.
  const bitmap = m.thumbnailCanvas.transferToImageBitmap();
  ctx.post({ type: "thumbnailResult", id: msg.id, bitmap }, [bitmap]);
}

export function handleMinimapUploadOverviewChunks(ctx: WorkerCtx, msg: MinimapUploadOverviewChunksForLayerMessage): void {
  const m = ctx.state.minimap;
  const { datasetId, imageId, level, t, c, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ, sampleFormat } = msg;
  let entry = m.overviews.get(datasetId);

  if (entry && (entry.level !== level || entry.t !== t || entry.c !== c || entry.format !== sampleFormat)) {
    dropOverview(m, datasetId);
    entry = undefined;
  }

  if (!entry) {
    // A refused overview stays refused for its selection: taking it later
    // would draw only the chunks that arrived after, which the page counts as
    // sent.
    const selection = `${level}/${t}/${c}/${sampleFormat}`;
    const refused = ctx.state.overviewsRefused;
    if (refused.get(datasetId) === selection) return;
    refused.delete(datasetId);
    const grid: CellGrid = {
      x: Math.ceil(levelWidth / chunkX),
      y: Math.ceil(levelHeight / chunkY),
      z: Math.ceil(levelDepth / chunkZ),
    };
    const indirection = emptyIndirection(grid.x * grid.y * grid.z);
    const bytes = levelWidth * levelHeight * levelDepth * bytesPerTexel(sampleFormat) + indirection.byteLength;
    if (
      m.overviewBytes + bytes > ctx.state.gpuTotalBytes * MINIMAP_OVERVIEW_SHARE ||
      !reserveGpuBytes(ctx, bytes)
    ) {
      refused.set(datasetId, selection);
      return;
    }
    const texture = allocateWatched(
      ctx,
      () => createEmptyVolumeTexture(ctx.device, levelWidth, levelHeight, levelDepth, atlasTextureFormat(sampleFormat)),
      (lost) => {
        if (m.overviews.get(datasetId)?.texture !== lost) return;
        dropOverview(m, datasetId);
        // Under a halved total the page sends it again; at the floor it
        // would only fail again, so it is refused.
        if (handleGpuOutOfMemory(ctx)) ctx.post({ type: "minimapOverviewsLost", memberIds: [datasetId] });
        else refused.set(datasetId, selection);
      },
    );
    const indirectionBuf = ctx.device.createBuffer({
      size: indirection.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    entry = {
      texture, format: sampleFormat, uploaded: new Set(),
      imageId, level, t, c,
      width: levelWidth, height: levelHeight, depth: levelDepth,
      chunkDims: [chunkX, chunkY, chunkZ],
      grid, indirection, indirectionBuf, markedFailed: new Set(),
      bytes,
    };
    m.overviews.set(datasetId, entry);
    m.overviewBytes += bytes;
    noteOverviewBytes(m);
  }

  for (const chunk of msg.chunks) {
    if (entry.uploaded.has(chunk.key)) continue;
    const cell = cellIndex(entry.grid, chunk.x, chunk.y, chunk.z);
    if (cell < entry.indirection.length) entry.indirection[cell] = cell;
    const data = atlasTexels(chunk.data, chunk.dataType, entry.format);
    const xOff = chunk.x * chunkX;
    const yOff = chunk.y * chunkY;
    const zOff = chunk.z * chunkZ;
    const cw = Math.min(chunkX, levelWidth - xOff);
    const ch = Math.min(chunkY, levelHeight - yOff);
    const cd = Math.min(chunkZ, levelDepth - zOff);

    writeVolumeChunk(
      ctx.device, entry.texture, data, chunkX, chunkY, cw, ch, cd, xOff, yOff, zOff,
      atlasTextureFormat(entry.format),
    );
    entry.uploaded.add(chunk.key);
  }
  ctx.device.queue.writeBuffer(entry.indirectionBuf, 0, entry.indirection);
}

/** Mark the overview's chunks that failed for good, as the page last listed them. */
function markOverviewFailed(ctx: WorkerCtx, overview: MinimapOverviewEntry): void {
  const failed = failedCellsAt(
    failedKeysForImage(ctx.state, overview.imageId),
    overview.grid,
    { level: overview.level, t: overview.t, c: overview.c },
  );
  const changed = applyFailedMarks(
    overview.indirection,
    overview.markedFailed,
    failed,
    (_cell, key) => overview.uploaded.has(key),
    () => INDIRECTION_MISS,
  );
  if (changed) ctx.device.queue.writeBuffer(overview.indirectionBuf, 0, overview.indirection);
}

export function handleMinimapDestroy(m: MinimapRendererState): void {
  m.deferredRender = null;
  for (const tex of m.targets) tex.destroy();
  m.targets = [];
  m.targetW = 0;
  m.targetH = 0;
  if (m.context) {
    m.context.unconfigure();
    m.context = null;
  }
  // Thumbnail off-screen render state shares the overview textures + renderer
  // with the minimap, so it's torn down here too.
  for (const tex of m.thumbnailTargets) tex.destroy();
  m.thumbnailTargets = [];
  m.thumbnailSize = 0;
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
  for (const entry of m.overviews.values()) {
    entry.texture.destroy();
    entry.indirectionBuf.destroy();
  }
  m.overviews.clear();
  m.overviewBytes = 0;
  noteOverviewBytes(m);
  for (const tex of m.targets) tex.destroy();
  m.targets = [];
  m.targetW = 0;
  m.targetH = 0;
  for (const tex of m.thumbnailTargets) tex.destroy();
  m.thumbnailTargets = [];
  m.thumbnailSize = 0;
  m.thumbnailContext = null;
  m.thumbnailCanvas = null;
  noteMinimapTargetBytes(m);
}

/** Point the minimap canvas, if there is one, at the worker's current device. */
export function rebindMinimapCanvas(ctx: WorkerCtx): void {
  const m = ctx.state.minimap;
  m.context?.configure({ device: ctx.device, format: ctx.format, alphaMode: "opaque" });
}

export function removeMinimapResources(ctx: WorkerCtx, datasetId: string): void {
  const m = ctx.state.minimap;
  dropOverview(m, datasetId);
  ctx.state.overviewsRefused.delete(datasetId);
}

export function destroyAllMinimapResources(m: MinimapRendererState): void {
  for (const mmE of m.overviews.values()) {
    mmE.texture.destroy();
    mmE.indirectionBuf.destroy();
  }
  m.overviews.clear();
  m.overviewBytes = 0;
  noteOverviewBytes(m);
  handleMinimapDestroy(m);
}
