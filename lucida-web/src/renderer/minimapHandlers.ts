import type { WorkerCtx } from "./workerContext.ts";
import type {
  MinimapInitMessage,
  MinimapRenderMessage,
  MinimapSetOverviewForLayerMessage,
  MinimapUploadOverviewChunksForLayerMessage,
} from "./workerProtocol.ts";
import { createEmptyVolumeTexture, createOffscreenTarget, writeVolumeChunk } from "./gpuContext.ts";
import type { CompositeLayer } from "./layerCompositor.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";

interface MinimapOverviewEntry {
  texture: GPUTexture;
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
let minimapPoolWidth = 0;
let minimapPoolHeight = 0;

function ensureMinimapOffscreenPool(device: GPUDevice, count: number, w: number, h: number) {
  if (w !== minimapPoolWidth || h !== minimapPoolHeight) {
    for (const tex of minimapOffscreenPool) tex.destroy();
    minimapOffscreenPool = [];
    minimapPoolWidth = w;
    minimapPoolHeight = h;
  }
  while (minimapOffscreenPool.length < count) {
    minimapOffscreenPool.push(createOffscreenTarget(device, w, h));
  }
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
  ensureMinimapOffscreenPool(ctx.device, msg.layers.length, msg.canvasW, msg.canvasH);

  const renderedLayers: CompositeLayer[] = [];

  for (const layer of msg.layers) {
    const overview = minimapOverviewPerDataset.get(layer.datasetId);
    if (!overview) continue;

    const idx = renderedLayers.length;
    renderer.setVolume(overview.texture, overview.width, overview.height, overview.depth);
    renderer.setDisplayParams(layer.contrastMin, layer.contrastMax, layer.gamma);
    renderer.setOpacity(1.0);
    renderer.setMatrices(msg.invViewProj, layer.modelMatrix, layer.invModelMatrix, msg.eye);
    const layerEncoder = ctx.device.createCommandEncoder();
    renderer.renderTo(minimapOffscreenPool[idx].createView(), layerEncoder, undefined, undefined, msg.canvasW, msg.canvasH);
    ctx.device.queue.submit([layerEncoder.finish()]);
    renderedLayers.push({ view: minimapOffscreenPool[idx].createView(), blendMode: "alpha" });
  }

  if (renderedLayers.length > 0) {
    const compEncoder = ctx.device.createCommandEncoder();
    comp.composite(minimapContext.getCurrentTexture().createView(), renderedLayers, compEncoder);
    ctx.device.queue.submit([compEncoder.finish()]);
  }
}

export function handleMinimapSetOverview(ctx: WorkerCtx, msg: MinimapSetOverviewForLayerMessage): void {
  const existing = minimapOverviewPerDataset.get(msg.datasetId);
  if (existing) existing.texture.destroy();

  const texture = createEmptyVolumeTexture(ctx.device, msg.width, msg.height, msg.depth);
  for (let z = 0; z < msg.depth; z++) {
    ctx.device.queue.writeTexture(
      { texture, origin: [0, 0, z] },
      msg.data,
      {
        offset: z * msg.width * msg.height * 2,
        bytesPerRow: msg.width * 2,
        rowsPerImage: msg.height,
      },
      [msg.width, msg.height, 1],
    );
  }
  const data = new Uint16Array(msg.data);
  const { min, max } = sampleIntensityRange(data);
  minimapOverviewPerDataset.set(msg.datasetId, {
    texture, uploaded: new Set(["full"]),
    t: msg.t, c: msg.c,
    width: msg.width, height: msg.height, depth: msg.depth,
    intensityMin: min, intensityMax: max,
  });
}

export function handleMinimapUploadOverviewChunks(ctx: WorkerCtx, msg: MinimapUploadOverviewChunksForLayerMessage): void {
  const { datasetId, t, c, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;
  let entry = minimapOverviewPerDataset.get(datasetId);

  if (entry && (entry.t !== t || entry.c !== c)) {
    entry.texture.destroy();
    entry = undefined;
    minimapOverviewPerDataset.delete(datasetId);
  }

  if (!entry) {
    const texture = createEmptyVolumeTexture(ctx.device, levelWidth, levelHeight, levelDepth);
    entry = {
      texture, uploaded: new Set(),
      t, c,
      width: levelWidth, height: levelHeight, depth: levelDepth,
      intensityMin: 65535, intensityMax: 0,
    };
    minimapOverviewPerDataset.set(datasetId, entry);
  }

  let intensityChanged = false;
  const totalChunks = msg.chunks.length;
  for (const chunk of msg.chunks) {
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
    ctx.post({ type: "intensityRange", datasetId, min: entry.intensityMin, max: entry.intensityMax });
  }
}

export function handleMinimapDestroy(): void {
  for (const tex of minimapOffscreenPool) tex.destroy();
  minimapOffscreenPool = [];
  minimapPoolWidth = 0;
  minimapPoolHeight = 0;
  if (minimapContext) {
    minimapContext.unconfigure();
    minimapContext = null;
  }
}

export function removeMinimapResources(datasetId: string): void {
  const mmEntry = minimapOverviewPerDataset.get(datasetId);
  if (mmEntry) {
    mmEntry.texture.destroy();
    minimapOverviewPerDataset.delete(datasetId);
  }
}

export function destroyAllMinimapResources(): void {
  for (const mmE of minimapOverviewPerDataset.values()) mmE.texture.destroy();
  minimapOverviewPerDataset.clear();
  handleMinimapDestroy();
}
