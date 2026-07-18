import type { WorkerCtx } from "./workerContext.ts";
import type {
  MinimapInitMessage,
  MinimapRenderMessage,
  MinimapUploadOverviewChunksForLayerMessage,
  ThumbnailRenderMessage,
} from "./workerProtocol.ts";
import { OFFSCREEN_FORMAT, writeVolumeChunk } from "./gpuContext.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";
import type { TrackedGpuResource } from "./gpuResourceBudget.ts";
import { assertChunkBufferLength } from "../chunkContract.ts";

interface MinimapOverviewEntry {
  texture: GPUTexture;
  allocation?: TrackedGpuResource<GPUTexture>;
  uploaded: Set<string>;
  t: number;
  c: number;
  width: number;
  height: number;
  depth: number;
  intensityMin: number;
  intensityMax: number;
}

const minimapOverviewPerDataset = new Map<string, MinimapOverviewEntry>();

let minimapContext: GPUCanvasContext | null = null;
let minimapOffscreenPool: GPUTexture[] = [];
let minimapOffscreenAllocations: TrackedGpuResource<GPUTexture>[] = [];
let minimapPoolWidth = 0;
let minimapPoolHeight = 0;

// --- Thumbnail (Explore-panel contact-sheet) off-screen render state ---
//
// Thumbnails reuse the minimap's per-dataset coarse overview textures
// (`minimapOverviewPerDataset`) + the shared volume renderer/compositor, but
// draw to their own small pool and own `OffscreenCanvas`. We composite a single
// thumbnail's layers onto that canvas, then `transferToImageBitmap()` to hand a
// transferable image back to the main thread (the minimap, by contrast, owns a
// canvas transferred from the DOM and never ships pixels back).
//
// The pool + canvas are square (one `size`); a size change rebuilds them. One
// render is fully submitted + read back before the next, so a single-entry pool
// and one canvas are enough — thumbnails are requested with a small concurrency
// cap on the main thread and serviced one message at a time here.
let thumbnailCanvas: OffscreenCanvas | null = null;
let thumbnailContext: GPUCanvasContext | null = null;
let thumbnailOffscreenPool: GPUTexture[] = [];
let thumbnailOffscreenAllocations: TrackedGpuResource<GPUTexture>[] = [];
let thumbnailPoolSize = 0;

function destroyTexture(
  texture: GPUTexture,
  allocation?: TrackedGpuResource<GPUTexture>,
): void {
  if (allocation) allocation.destroy();
  else texture.destroy();
}

function destroyOffscreenPool(
  textures: GPUTexture[],
  allocations: TrackedGpuResource<GPUTexture>[],
): void {
  if (allocations.length > 0) {
    for (const allocation of allocations) allocation.destroy();
  } else {
    for (const texture of textures) texture.destroy();
  }
}

function ensureThumbnailTarget(ctx: WorkerCtx, size: number): GPUTexture {
  if (size !== thumbnailPoolSize) {
    destroyOffscreenPool(thumbnailOffscreenPool, thumbnailOffscreenAllocations);
    thumbnailOffscreenPool = [];
    thumbnailOffscreenAllocations = [];
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
  if (thumbnailOffscreenPool.length === 0) {
    const allocation = ctx.gpuResources.createTexture(
      ctx.device,
      { key: "session:thumbnail-offscreen:0", kind: "offscreen" },
      {
        size: [size, size],
        format: OFFSCREEN_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      },
    );
    const texture = allocation.resource;
    thumbnailOffscreenPool.push(texture);
    thumbnailOffscreenAllocations.push(allocation);
  }
  return thumbnailOffscreenPool[0];
}

function ensureMinimapOffscreenTarget(ctx: WorkerCtx, w: number, h: number): GPUTexture {
  if (w !== minimapPoolWidth || h !== minimapPoolHeight) {
    destroyOffscreenPool(minimapOffscreenPool, minimapOffscreenAllocations);
    minimapOffscreenPool = [];
    minimapOffscreenAllocations = [];
    minimapPoolWidth = w;
    minimapPoolHeight = h;
  }
  if (minimapOffscreenPool.length === 0) {
    const allocation = ctx.gpuResources.createTexture(
      ctx.device,
      { key: "session:minimap-offscreen:0", kind: "offscreen" },
      {
        size: [w, h],
        format: OFFSCREEN_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      },
    );
    const texture = allocation.resource;
    minimapOffscreenPool.push(texture);
    minimapOffscreenAllocations.push(allocation);
  }
  return minimapOffscreenPool[0];
}

export function handleMinimapInit(ctx: WorkerCtx, msg: MinimapInitMessage): void {
  const canvas = msg.canvas;
  minimapContext = canvas.getContext("webgpu") as GPUCanvasContext;
  minimapContext.configure({ device: ctx.device, format: ctx.format, alphaMode: "opaque" });
}

export function handleMinimapRender(ctx: WorkerCtx, msg: MinimapRenderMessage): void {
  if (!minimapContext) return;
  const mmCanvas = minimapContext.canvas as OffscreenCanvas;
  mmCanvas.width = msg.canvasW;
  mmCanvas.height = msg.canvasH;

  const renderer = ctx.getVolumeRenderer();
  const comp = ctx.getCompositor();
  const target = ensureMinimapOffscreenTarget(ctx, msg.canvasW, msg.canvasH);
  const canvasView = minimapContext.getCurrentTexture().createView();
  let isFirstLayer = true;

  for (const layer of msg.layers) {
    const overview = minimapOverviewPerDataset.get(layer.datasetId);
    if (!overview) continue;

    // Minimap renders the overview as a single-LOD volume.
    // Bind the active channel's colormap LUT for the minimap's own draw. Without
    // this the minimap reuses whatever LUT the volume renderer last had — set by
    // the 3D main view (so 3D looks right) but left at the default gray in 2D
    // mode (where the main view is the slice renderer). Set it BEFORE setVolume,
    // since setVolume rebuilds the bind group from the current LUT.
    renderer.setColormapTexture(ctx.getOrCreateLUT(layer.colormap));
    renderer.setVolume(overview.texture, overview.width, overview.height, overview.depth);
    renderer.setMatrices(msg.invViewProj, msg.eye);
    // Bind a transient single-entity descriptor so the shader's
    // descriptor reads return the minimap layer's model matrix, single
    // LOD over the full overview volume, plus the minimap layer's
    // contrast/gamma (opacity hard-wired to 1.0 for minimap).
    renderer.setTransientDescriptor(
      layer.modelMatrix, layer.invModelMatrix,
      [overview.width, overview.height, overview.depth],
      layer.contrastMin, layer.contrastMax, layer.gamma, 1.0,
    );
    const layerEncoder = ctx.device.createCommandEncoder();
    renderer.renderTo(target.createView(), layerEncoder, undefined, undefined, msg.canvasW, msg.canvasH);
    ctx.device.queue.submit([layerEncoder.finish()]);
    const compEncoder = ctx.device.createCommandEncoder();
    comp.composite(
      canvasView,
      [{ view: target.createView(), blendMode: "alpha" }],
      compEncoder,
      isFirstLayer,
    );
    ctx.device.queue.submit([compEncoder.finish()]);
    isFirstLayer = false;
  }

  if (isFirstLayer) {
    const clearEncoder = ctx.device.createCommandEncoder();
    comp.composite(canvasView, [], clearEncoder);
    ctx.device.queue.submit([clearEncoder.finish()]);
  }
}

/**
 * Render one Explore-panel candidate thumbnail off-screen and ship it back as an
 * `ImageBitmap`. This is `handleMinimapRender` specialized for a small,
 * read-back target: same coarse overview texture, same transient single-entity
 * descriptor, same `renderTo` per layer + `composite`, but the destination is a
 * private `OffscreenCanvas` we `transferToImageBitmap()` from.
 *
 * Renders only at the coarse overview LOD (the overview is the single resident,
 * angle-independent volume), so off-axis child cameras cost no streaming. If no
 * layer has a resident overview yet, replies with `bitmap: null` and the panel
 * falls back to its label-only row.
 */
export function handleThumbnailRender(ctx: WorkerCtx, msg: ThumbnailRenderMessage): void {
  const size = Math.max(1, Math.round(msg.size));

  const renderer = ctx.getVolumeRenderer();
  const comp = ctx.getCompositor();
  const target = ensureThumbnailTarget(ctx, size);

  const canvasView = thumbnailContext?.getCurrentTexture().createView() ?? null;
  let renderedLayerCount = 0;
  for (const layer of msg.layers) {
    const overview = minimapOverviewPerDataset.get(layer.datasetId);
    if (!overview) continue;

    // Same single-LOD overview draw as the minimap: bind the active channel's
    // LUT before setVolume (setVolume rebuilds the bind
    // group from the current LUT), then a transient descriptor so the shader
    // reads this layer's model matrix + contrast/gamma over the full overview.
    renderer.setColormapTexture(ctx.getOrCreateLUT(layer.colormap));
    renderer.setVolume(overview.texture, overview.width, overview.height, overview.depth);
    renderer.setMatrices(msg.invViewProj, msg.eye);
    renderer.setTransientDescriptor(
      layer.modelMatrix, layer.invModelMatrix,
      [overview.width, overview.height, overview.depth],
      layer.contrastMin, layer.contrastMax, layer.gamma, 1.0,
    );
    const layerEncoder = ctx.device.createCommandEncoder();
    renderer.renderTo(target.createView(), layerEncoder, undefined, undefined, size, size);
    ctx.device.queue.submit([layerEncoder.finish()]);
    if (canvasView) {
      const compEncoder = ctx.device.createCommandEncoder();
      comp.composite(
        canvasView,
        [{ view: target.createView(), blendMode: "alpha" }],
        compEncoder,
        renderedLayerCount === 0,
      );
      ctx.device.queue.submit([compEncoder.finish()]);
    }
    renderedLayerCount++;
  }

  if (renderedLayerCount === 0 || !thumbnailContext || !thumbnailCanvas) {
    // No resident overview for any layer → nothing to draw; let the panel keep
    // the label-only row. (Reply is required so the pending promise resolves.)
    ctx.post({ type: "thumbnailResult", id: msg.id, bitmap: null });
    return;
  }

  // Snapshot the composited canvas into a transferable ImageBitmap. The canvas
  // is reused for the next thumbnail, so we must capture now (not transfer the
  // canvas). transferToImageBitmap empties the canvas, which is fine — the next
  // render clears it again.
  const bitmap = thumbnailCanvas.transferToImageBitmap();
  ctx.post({ type: "thumbnailResult", id: msg.id, bitmap }, [bitmap]);
}

export function handleMinimapUploadOverviewChunks(ctx: WorkerCtx, msg: MinimapUploadOverviewChunksForLayerMessage): void {
  const { datasetId, t, c, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;
  let entry = minimapOverviewPerDataset.get(datasetId);

  if (entry && (entry.t !== t || entry.c !== c)) {
    destroyTexture(entry.texture, entry.allocation);
    entry = undefined;
    minimapOverviewPerDataset.delete(datasetId);
  }

  if (!entry) {
    const allocation = ctx.gpuResources.createTexture(
      ctx.device,
      {
        key: `minimap:overview:${datasetId}`,
        kind: "minimap",
        datasetId,
      },
      {
        size: [levelWidth, levelHeight, levelDepth],
        format: "r16uint",
        dimension: "3d",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      },
    );
    const texture = allocation.resource;
    entry = {
      texture, allocation, uploaded: new Set(),
      t, c,
      width: levelWidth, height: levelHeight, depth: levelDepth,
      intensityMin: 65535, intensityMax: 0,
    };
    minimapOverviewPerDataset.set(datasetId, entry);
  }

  let intensityChanged = false;
  const totalChunks = msg.chunks.length;
  for (const chunk of msg.chunks) {
    assertChunkBufferLength(chunk.data, chunk.contract, "worker");
    if (chunk.contract.role !== "intensity" || chunk.contract.dtype !== "uint16") {
      throw new Error(`minimap chunk ${chunk.key} has a non-intensity contract`);
    }
    if (chunk.contract.channel !== c) {
      throw new Error(`minimap chunk ${chunk.key} channel contract mismatch`);
    }
    if (entry.uploaded.has(chunk.key)) continue;
    const data = new Uint16Array(chunk.data);
    const xOff = chunk.x * chunkX;
    const yOff = chunk.y * chunkY;
    const zOff = chunk.z * chunkZ;
    const cw = Math.min(chunkX, levelWidth - xOff);
    const ch = Math.min(chunkY, levelHeight - yOff);
    const cd = Math.min(chunkZ, levelDepth - zOff);

    writeVolumeChunk(ctx.device, entry.texture, data, chunkX, chunkY, cw, ch, cd, xOff, yOff, zOff);
    entry.uploaded.add(chunk.key);

    const perChunkSamples = Math.floor(100000 / Math.max(1, totalChunks));
    const { min, max } = sampleIntensityRange(data, perChunkSamples);
    if (min < entry.intensityMin) { entry.intensityMin = min; intensityChanged = true; }
    if (max > entry.intensityMax) { entry.intensityMax = max; intensityChanged = true; }
  }

  if (intensityChanged) {
    const contract = msg.chunks[0]?.contract;
    if (contract) {
      ctx.post({
        type: "intensityRange",
        datasetId: contract.datasetId,
        channel: contract.channel,
        min: entry.intensityMin,
        max: entry.intensityMax,
      });
    }
  }
}

export function handleMinimapDestroy(): void {
  destroyOffscreenPool(minimapOffscreenPool, minimapOffscreenAllocations);
  minimapOffscreenPool = [];
  minimapOffscreenAllocations = [];
  minimapPoolWidth = 0;
  minimapPoolHeight = 0;
  if (minimapContext) {
    minimapContext.unconfigure();
    minimapContext = null;
  }
  // Thumbnail off-screen render state shares the overview textures + renderer
  // with the minimap, so it's torn down here too.
  destroyOffscreenPool(thumbnailOffscreenPool, thumbnailOffscreenAllocations);
  thumbnailOffscreenPool = [];
  thumbnailOffscreenAllocations = [];
  thumbnailPoolSize = 0;
  if (thumbnailContext) {
    thumbnailContext.unconfigure();
    thumbnailContext = null;
  }
  thumbnailCanvas = null;
}

export function removeMinimapResources(datasetId: string): void {
  const mmEntry = minimapOverviewPerDataset.get(datasetId);
  if (mmEntry) {
    destroyTexture(mmEntry.texture, mmEntry.allocation);
    minimapOverviewPerDataset.delete(datasetId);
  }
}

export function destroyAllMinimapResources(): void {
  for (const mmE of minimapOverviewPerDataset.values()) {
    destroyTexture(mmE.texture, mmE.allocation);
  }
  minimapOverviewPerDataset.clear();
  handleMinimapDestroy();
}
