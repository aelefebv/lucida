import type { WorkerCtx } from "./workerContext.ts";
import type {
  SliceSetFallbackForLayerMessage,
  SliceUploadTilesForLayerMessage,
  SliceRenderMultiPassMessage,
} from "./workerProtocol.ts";
import { createSliceTexture, writeSliceRegion } from "./gpuContext.ts";
import type { CompositeLayer } from "./layerCompositor.ts";
import { sampleIntensityRange } from "../zarr/intensitySampler.ts";

interface TileState {
  texture: GPUTexture;
  level: number;
  z: number;
  t: number;
  c: number;
  uploaded: Set<string>;
  intensityMin: number;
  intensityMax: number;
}

const tileStatePerDataset = new Map<string, TileState>();
const fallbackPerDataset = new Map<string, GPUTexture>();

export function handleSliceSetFallback(ctx: WorkerCtx, msg: SliceSetFallbackForLayerMessage): void {
  const slice = new Uint16Array(msg.data);
  const { min, max } = sampleIntensityRange(slice);
  const texture = createSliceTexture(ctx.device, msg.width, msg.height, slice);
  fallbackPerDataset.set(msg.datasetId, texture);
  ctx.post({ type: "intensityRange", datasetId: msg.datasetId, min, max });
}

export function handleSliceUploadTiles(ctx: WorkerCtx, msg: SliceUploadTilesForLayerMessage): void {
  const { datasetId, level, z, t, c, levelWidth, levelHeight, chunkX, chunkY, chunkZ, fullResDepth, levelDepth, fullResZ } = msg;

  let ts = tileStatePerDataset.get(datasetId);
  if (!ts || ts.level !== level || ts.z !== z || ts.t !== t || ts.c !== c) {
    if (ts) ts.texture.destroy();
    const texture = createSliceTexture(ctx.device, levelWidth, levelHeight, null);
    ts = { texture, level, z, t, c, uploaded: new Set(), intensityMin: 65535, intensityMax: 0 };
    tileStatePerDataset.set(datasetId, ts);
  }

  // Map full-res Z to level Z
  const levelZ = Math.min(
    Math.floor((fullResZ / Math.max(fullResDepth - 1, 1)) * Math.max(levelDepth - 1, 1)),
    levelDepth - 1,
  );
  const targetChunkZ = Math.floor(levelZ / chunkZ);
  const localZ = levelZ - targetChunkZ * chunkZ;

  if (msg.tiles.length > 0) {
    let intensityChanged = false;
    const perChunkSamples = Math.floor(10000 / Math.max(1, msg.tiles.length));

    for (const tile of msg.tiles) {
      if (ts.uploaded.has(tile.key)) continue;
      if (tile.z !== targetChunkZ) continue;
      const data = new Uint16Array(tile.data);

      const r = sampleIntensityRange(data, perChunkSamples);
      if (r.min < ts.intensityMin) { ts.intensityMin = r.min; intensityChanged = true; }
      if (r.max > ts.intensityMax) { ts.intensityMax = r.max; intensityChanged = true; }

      const xOff = tile.x * chunkX;
      const yOff = tile.y * chunkY;
      const tileW = Math.min(chunkX, levelWidth - xOff);
      const tileH = Math.min(chunkY, levelHeight - yOff);
      const sliceOffset = localZ * chunkY * chunkX;
      const sliceData = data.subarray(sliceOffset, sliceOffset + chunkY * chunkX);
      writeSliceRegion(ctx.device, ts.texture, sliceData, chunkX, xOff, yOff, tileW, tileH);
      ts.uploaded.add(tile.key);
    }

    if (intensityChanged) {
      ctx.post({ type: "intensityRange", datasetId, min: ts.intensityMin, max: ts.intensityMax });
    }
  }
}

export function handleSliceRenderMultiPass(ctx: WorkerCtx, msg: SliceRenderMultiPassMessage): void {
  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = msg.canvasW;
  canvas.height = msg.canvasH;

  const renderer = ctx.getSliceRenderer();
  const comp = ctx.getCompositor();
  const pool = ctx.ensureOffscreenPool(msg.layers.length, msg.canvasW, msg.canvasH);

  const renderedLayers: CompositeLayer[] = [];

  for (const layer of msg.layers) {
    const fb = fallbackPerDataset.get(layer.datasetId);
    const ts = tileStatePerDataset.get(layer.datasetId);
    if (!fb && !ts) continue;

    const idx = renderedLayers.length;
    renderer.setFallback(fb ?? ctx.getDummyTexture());
    renderer.setTileTexture(ts?.texture ?? ctx.getDummyTexture());
    renderer.setDisplayParams(layer.contrastMin, layer.contrastMax, layer.gamma);
    renderer.setOpacity(layer.opacity);
    renderer.setTransform(msg.zoom, msg.cx, msg.cy, msg.canvasW, msg.canvasH, layer.dataW, layer.dataH);
    const layerEncoder = ctx.device.createCommandEncoder();
    renderer.renderTo(pool[idx].createView(), layerEncoder);
    ctx.device.queue.submit([layerEncoder.finish()]);
    renderedLayers.push({ view: pool[idx].createView(), blendMode: layer.blendMode });
  }

  const compEncoder = ctx.device.createCommandEncoder();
  comp.composite(ctx.context.getCurrentTexture().createView(), renderedLayers, compEncoder);
  ctx.device.queue.submit([compEncoder.finish()]);
}

export function removeSliceResources(datasetId: string): void {
  const ts = tileStatePerDataset.get(datasetId);
  if (ts) {
    ts.texture.destroy();
    tileStatePerDataset.delete(datasetId);
  }
  const fb = fallbackPerDataset.get(datasetId);
  if (fb) {
    fb.destroy();
    fallbackPerDataset.delete(datasetId);
  }
}

export function destroyAllSliceResources(): void {
  for (const ts of tileStatePerDataset.values()) ts.texture.destroy();
  tileStatePerDataset.clear();
  for (const fb of fallbackPerDataset.values()) fb.destroy();
  fallbackPerDataset.clear();
}
