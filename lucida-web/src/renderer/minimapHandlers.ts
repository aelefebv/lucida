import type { WorkerCtx } from "./workerContext.ts";
import type {
  MinimapInitMessage,
  MinimapLayerParams,
  MinimapRenderMessage,
  MinimapUploadOverviewChunksForLayerMessage,
  ThumbnailRenderMessage,
} from "./workerProtocol.ts";
import { createEmptyVolumeTexture, createOffscreenTarget, writeVolumeChunk } from "./gpuContext.ts";
import type { CompositeLayer } from "./layerCompositor.ts";
import { atlasTexels, atlasTextureFormat, bytesPerTexel, type SampleFormat } from "./dataTypeUtil.ts";
import { allocateWatched } from "./worker/gpuErrors.ts";
import { handleGpuOutOfMemory, reserveGpuBytes } from "./worker/gpuBudget.ts";
import { setGpuLedgerLine } from "./worker/gpuLedger.ts";
import { OFFSCREEN_BYTES_PER_TEXEL } from "./worker/resources.ts";
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

const minimapOverviewPerDataset = new Map<string, MinimapOverviewEntry>();
let overviewBytes = 0;

let minimapContext: GPUCanvasContext | null = null;
let minimapOffscreenPool: GPUTexture[] = [];
let minimapPoolWidth = 0;
let minimapPoolHeight = 0;

function noteOverviewBytes(): void {
  setGpuLedgerLine("minimapTextures", overviewBytes);
}

function noteMinimapTargetBytes(): void {
  setGpuLedgerLine(
    "minimapTargets",
    (minimapOffscreenPool.length * minimapPoolWidth * minimapPoolHeight +
      thumbnailOffscreenPool.length * thumbnailPoolSize * thumbnailPoolSize) * OFFSCREEN_BYTES_PER_TEXEL,
  );
}

/** Make an offscreen target that leaves `pool` when the device can't allocate it. */
function watchedTarget(ctx: WorkerCtx, w: number, h: number, pool: () => GPUTexture[]): GPUTexture {
  return allocateWatched(
    ctx,
    () => createOffscreenTarget(ctx.device, w, h),
    (lost) => {
      const targets = pool();
      const at = targets.indexOf(lost);
      if (at >= 0) {
        targets.splice(at, 1);
        lost.destroy();
        noteMinimapTargetBytes();
      }
      handleGpuOutOfMemory(ctx);
    },
  );
}

function dropOverview(datasetId: string): void {
  const entry = minimapOverviewPerDataset.get(datasetId);
  if (!entry) return;
  entry.texture.destroy();
  entry.indirectionBuf.destroy();
  overviewBytes -= entry.bytes;
  minimapOverviewPerDataset.delete(datasetId);
  noteOverviewBytes();
}

// Thumbnail render state. Thumbnails reuse the minimap's overview textures and
// renderers but draw to their own square pool and `OffscreenCanvas`, then
// `transferToImageBitmap()` back to the main thread. One render finishes before
// the next starts, so one pool entry and one canvas are enough.
let thumbnailCanvas: OffscreenCanvas | null = null;
let thumbnailContext: GPUCanvasContext | null = null;
let thumbnailOffscreenPool: GPUTexture[] = [];
let thumbnailPoolSize = 0;

function ensureThumbnailTargets(ctx: WorkerCtx, size: number, count: number) {
  if (size !== thumbnailPoolSize) {
    for (const tex of thumbnailOffscreenPool) tex.destroy();
    thumbnailOffscreenPool = [];
    thumbnailPoolSize = size;
    // The canvas is reconfigured (not just resized) so its backing store matches
    // the new size; a fresh context keeps the configure() simple.
    thumbnailCanvas = new OffscreenCanvas(size, size);
    thumbnailContext = thumbnailCanvas.getContext("webgpu") as GPUCanvasContext;
    thumbnailContext.configure({ device: ctx.device, format: ctx.format, alphaMode: "opaque" });
  }
  if (thumbnailCanvas && (thumbnailCanvas.width !== size || thumbnailCanvas.height !== size)) {
    thumbnailCanvas.width = size;
    thumbnailCanvas.height = size;
  }
  while (thumbnailOffscreenPool.length < count) {
    thumbnailOffscreenPool.push(watchedTarget(ctx, size, size, () => thumbnailOffscreenPool));
  }
  noteMinimapTargetBytes();
}

function ensureMinimapOffscreenPool(ctx: WorkerCtx, count: number, w: number, h: number) {
  if (w !== minimapPoolWidth || h !== minimapPoolHeight) {
    for (const tex of minimapOffscreenPool) tex.destroy();
    minimapOffscreenPool = [];
    minimapPoolWidth = w;
    minimapPoolHeight = h;
  }
  while (minimapOffscreenPool.length < count) {
    minimapOffscreenPool.push(watchedTarget(ctx, w, h, () => minimapOffscreenPool));
  }
  noteMinimapTargetBytes();
}

export function handleMinimapInit(ctx: WorkerCtx, msg: MinimapInitMessage): void {
  const canvas = msg.canvas;
  minimapContext = canvas.getContext("webgpu") as GPUCanvasContext;
  minimapContext.configure({ device: ctx.device, format: ctx.format, alphaMode: "opaque" });
}

/**
 * The latest overview render to arrive before the volume renderer compiled.
 * Earlier ones would only be painted over.
 */
let deferredMinimapRender: MinimapRenderMessage | null = null;

export function handleMinimapRender(ctx: WorkerCtx, msg: MinimapRenderMessage): void {
  if (!minimapContext) return;
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
  const first = deferredMinimapRender === null;
  deferredMinimapRender = msg;
  if (!first) return;
  Promise.all([renderer.compiled, comp.compiled]).then(
    () => {
      const pending = deferredMinimapRender;
      deferredMinimapRender = null;
      if (pending && minimapContext) drawMinimap(ctx, pending);
    },
    (err: unknown) => {
      deferredMinimapRender = null;
      postCompileFailure(ctx, err);
    },
  );
}

/** A compile that failed outside the message order, reported as a handler's throw is. */
function postCompileFailure(ctx: WorkerCtx, err: unknown): void {
  ctx.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
}

function drawMinimap(ctx: WorkerCtx, msg: MinimapRenderMessage): void {
  if (!minimapContext) return;
  const mmCanvas = minimapContext.canvas as OffscreenCanvas;
  mmCanvas.width = msg.canvasW;
  mmCanvas.height = msg.canvasH;

  const comp = ctx.getCompositor();
  ensureMinimapOffscreenPool(ctx, 1, msg.canvasW, msg.canvasH);
  const minimapView = minimapContext.getCurrentTexture().createView();
  const drawn = drawOverviewLayers(ctx, msg, minimapView, minimapOffscreenPool[0], msg.canvasW, msg.canvasH);

  // Drawn even with no overview resident, so the minimap shows the canvas
  // background rather than whatever it last held.
  const compEncoder = ctx.device.createCommandEncoder();
  if (drawn === 0) comp.composite(minimapView, [], compEncoder);
  comp.underlayBackground(minimapView, compEncoder);
  ctx.device.queue.submit([compEncoder.finish()]);
}

/**
 * Draw each layer's overview into `scratch`, then composite it over `view`
 * before the next layer reuses it, clearing `view` under the first. A
 * collection draws one layer per member and channel, so a target per layer
 * would hold GPU memory in proportion to the member count. Returns how many
 * layers had an overview to draw.
 */
function drawOverviewLayers(
  ctx: WorkerCtx,
  msg: Pick<MinimapRenderMessage, "layers" | "invViewProj" | "eye" | "pixelRatio">,
  view: GPUTextureView,
  scratch: GPUTexture,
  width: number,
  height: number,
): number {
  const renderer = ctx.getVolumeRenderer();
  const comp = ctx.getCompositor();
  let drawn = 0;
  for (const layer of msg.layers) {
    const overview = minimapOverviewPerDataset.get(layer.datasetId);
    if (!overview) continue;
    bindOverviewLayer(ctx, overview, layer, msg.invViewProj, msg.eye, msg.pixelRatio);
    // One submit per layer: each draw's uniforms and descriptor are written
    // to the renderer's one buffer ahead of it.
    const encoder = ctx.device.createCommandEncoder();
    renderer.renderTo(scratch.createView(), encoder, undefined, undefined, width, height);
    const composited: CompositeLayer = { view: scratch.createView(), blendMode: layer.blendMode };
    comp.composite(view, [composited], encoder, drawn === 0);
    ctx.device.queue.submit([encoder.finish()]);
    drawn++;
  }
  return drawn;
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
  const size = Math.max(1, Math.round(msg.size));
  const comp = ctx.getCompositor();
  ensureThumbnailTargets(ctx, size, 1);

  if (!msg.layers.some((layer) => minimapOverviewPerDataset.has(layer.datasetId)) || !thumbnailContext || !thumbnailCanvas) {
    // Nothing to draw. Reply anyway so the pending promise resolves and the
    // panel keeps its label-only row.
    ctx.post({ type: "thumbnailResult", id: msg.id, bitmap: null });
    return;
  }

  const thumbnailView = thumbnailContext.getCurrentTexture().createView();
  drawOverviewLayers(ctx, msg, thumbnailView, thumbnailOffscreenPool[0], size, size);
  const compEncoder = ctx.device.createCommandEncoder();
  comp.underlayBackground(thumbnailView, compEncoder);
  ctx.device.queue.submit([compEncoder.finish()]);

  // The canvas is reused for the next thumbnail, so snapshot it rather than
  // transfer the canvas itself. The next render clears what this empties.
  const bitmap = thumbnailCanvas.transferToImageBitmap();
  ctx.post({ type: "thumbnailResult", id: msg.id, bitmap }, [bitmap]);
}

export function handleMinimapUploadOverviewChunks(ctx: WorkerCtx, msg: MinimapUploadOverviewChunksForLayerMessage): void {
  const { datasetId, imageId, level, t, c, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ, sampleFormat } = msg;
  let entry = minimapOverviewPerDataset.get(datasetId);

  if (entry && (entry.level !== level || entry.t !== t || entry.c !== c || entry.format !== sampleFormat)) {
    dropOverview(datasetId);
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
      overviewBytes + bytes > ctx.state.gpuTotalBytes * MINIMAP_OVERVIEW_SHARE ||
      !reserveGpuBytes(ctx, bytes)
    ) {
      refused.set(datasetId, selection);
      return;
    }
    const texture = allocateWatched(
      ctx,
      () => createEmptyVolumeTexture(ctx.device, levelWidth, levelHeight, levelDepth, atlasTextureFormat(sampleFormat)),
      (lost) => {
        if (minimapOverviewPerDataset.get(datasetId)?.texture !== lost) return;
        dropOverview(datasetId);
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
    minimapOverviewPerDataset.set(datasetId, entry);
    overviewBytes += bytes;
    noteOverviewBytes();
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

/**
 * Bind one overview for a minimap or thumbnail draw: this channel's LUT, the
 * overview as a level laid out in place with its failed chunks marked, and a
 * transient descriptor carrying the layer's placement and contrast. The LUT
 * goes first, because binding the atlas rebuilds the bind group from it.
 */
function bindOverviewLayer(
  ctx: WorkerCtx,
  overview: MinimapOverviewEntry,
  layer: MinimapLayerParams,
  invViewProj: Float32Array,
  eye: Float32Array,
  pixelRatio: number,
): void {
  markOverviewFailed(ctx, overview);
  const renderer = ctx.getVolumeRenderer();
  renderer.setColormapTexture(ctx.getOrCreateLUT(layer.colormap));
  renderer.setTierAtlases(
    [{
      texture: overview.texture,
      indirectionBuf: overview.indirectionBuf,
      slotsX: overview.grid.x,
      slotsY: overview.grid.y,
      slotsZ: overview.grid.z,
    }],
    null,
  );
  renderer.setMatrices(invViewProj, eye);
  renderer.setPixelRatio(pixelRatio);
  // Opacity is 1: the minimap shows every layer at full strength.
  renderer.setTransientDescriptor(
    layer.modelMatrix, layer.invModelMatrix,
    [overview.width, overview.height, overview.depth],
    layer.contrastMin, layer.contrastMax, layer.gamma, 1.0, overview.format,
    {
      gridDims: [overview.grid.x, overview.grid.y, overview.grid.z],
      chunkDims: overview.chunkDims,
    },
  );
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

export function handleMinimapDestroy(): void {
  deferredMinimapRender = null;
  for (const tex of minimapOffscreenPool) tex.destroy();
  minimapOffscreenPool = [];
  minimapPoolWidth = 0;
  minimapPoolHeight = 0;
  if (minimapContext) {
    minimapContext.unconfigure();
    minimapContext = null;
  }
  // Thumbnail off-screen render state shares the overview textures + renderer
  // with the minimap, so it's torn down here too.
  for (const tex of thumbnailOffscreenPool) tex.destroy();
  thumbnailOffscreenPool = [];
  thumbnailPoolSize = 0;
  if (thumbnailContext) {
    thumbnailContext.unconfigure();
    thumbnailContext = null;
  }
  thumbnailCanvas = null;
  noteMinimapTargetBytes();
}

/**
 * Forget every texture the minimap and thumbnails built on a lost device. The
 * minimap canvas stays, for {@link rebindMinimapCanvas} to point at the next one.
 */
export function releaseMinimapDeviceResources(): void {
  deferredMinimapRender = null;
  for (const entry of minimapOverviewPerDataset.values()) {
    entry.texture.destroy();
    entry.indirectionBuf.destroy();
  }
  minimapOverviewPerDataset.clear();
  overviewBytes = 0;
  noteOverviewBytes();
  for (const tex of minimapOffscreenPool) tex.destroy();
  minimapOffscreenPool = [];
  minimapPoolWidth = 0;
  minimapPoolHeight = 0;
  for (const tex of thumbnailOffscreenPool) tex.destroy();
  thumbnailOffscreenPool = [];
  thumbnailPoolSize = 0;
  thumbnailContext = null;
  thumbnailCanvas = null;
  noteMinimapTargetBytes();
}

/** Point the minimap canvas, if there is one, at the worker's current device. */
export function rebindMinimapCanvas(ctx: WorkerCtx): void {
  minimapContext?.configure({ device: ctx.device, format: ctx.format, alphaMode: "opaque" });
}

export function removeMinimapResources(ctx: WorkerCtx, datasetId: string): void {
  dropOverview(datasetId);
  ctx.state.overviewsRefused.delete(datasetId);
}

export function destroyAllMinimapResources(): void {
  for (const mmE of minimapOverviewPerDataset.values()) {
    mmE.texture.destroy();
    mmE.indirectionBuf.destroy();
  }
  minimapOverviewPerDataset.clear();
  overviewBytes = 0;
  noteOverviewBytes();
  handleMinimapDestroy();
}
