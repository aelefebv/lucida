/**
 * Slice render-multipass orchestration.
 *
 * Per layer: resolve member→pool→datasetId, look up descriptor + atlas,
 * compute hasDetail, update per-entity camera UV, resolve proxy
 * textures, bind, draw to offscreen. After the loop: composite + cursor.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { SliceLayerParams, SliceRenderMultiPassMessage } from "../workerProtocol.ts";
import type { CompositeLayer } from "../layerCompositor.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import { type SliceAtlasState, type LabelSlicePool } from "./atlas.ts";
import { setCameraUVForMember } from "./eviction.ts";
import { serializeTransientDescriptor } from "../descriptor/transient.ts";
import { DESCRIPTOR_ENTRY_SIZE } from "../descriptor/layout.ts";
import { packLabelPalette } from "../labelColors.ts";

const IDENTITY_4X4 = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

/** Default overlay opacity for a label layer that omits one. */
const DEFAULT_LABEL_OPACITY = 0.5;

/**
 * The persistent categorical descriptor for a label pool. Built once (and
 * refreshed only when the opacity changes) rather than allocated per frame,
 * so scrubbing stays smooth. Single-LOD (grid 1×1) covering the whole tile.
 */
function ensureLabelDescriptor(
  ctx: WorkerCtx,
  pool: LabelSlicePool,
  opacity: number,
): GPUBuffer {
  if (pool.descBuffer && pool.descOpacity === opacity) return pool.descBuffer;
  const descBytes = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
  serializeTransientDescriptor(descBytes, {
    modelMatrix: IDENTITY_4X4,
    invModelMatrix: IDENTITY_4X4,
    volumeDims: [pool.width, pool.height, 1],
    // Unused in categorical mode, but kept well-formed.
    contrastMin: 0,
    contrastMax: 1,
    gamma: 1,
    opacity: 1,
    colormapMode: 1,
    labelOpacity: opacity,
  });
  if (!pool.descBuffer) {
    pool.descBuffer = ctx.device.createBuffer({
      size: DESCRIPTOR_ENTRY_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }
  ctx.device.queue.writeBuffer(pool.descBuffer, 0, descBytes);
  pool.descOpacity = opacity;
  return pool.descBuffer;
}

/**
 * The declared-palette storage buffer for a label pool: flat [id,
 * packedRgba] pairs from `image-label.colors`, built once. `packedRgba =
 * r | g<<8 | b<<16 | a<<24`, matching `labelColorFor` in slice.wgsl.
 */
function ensureLabelPalette(
  ctx: WorkerCtx,
  pool: LabelSlicePool,
  colors: SliceLayerParams["labelColors"],
): { buffer: GPUBuffer | null; count: number } {
  // Capped so the per-fragment palette scan stays bounded (see packLabelPalette).
  const packed = colors && colors.length > 0 ? packLabelPalette(colors) : null;
  const count = packed ? packed.length / 2 : 0;
  if (pool.labelColorCount === count) {
    return { buffer: pool.labelColorBuffer ?? null, count };
  }
  pool.labelColorBuffer?.destroy();
  pool.labelColorBuffer = undefined;
  if (packed && count > 0) {
    const buffer = ctx.device.createBuffer({
      size: packed.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    ctx.device.queue.writeBuffer(buffer, 0, packed);
    pool.labelColorBuffer = buffer;
  }
  pool.labelColorCount = count;
  return { buffer: pool.labelColorBuffer ?? null, count };
}

/**
 * Draw one categorical label overlay from its r32uint slice pool.
 *
 * A label pool is a single-tile texture covering the label's 2D footprint,
 * so a single-LOD descriptor (grid 1×1) reads it directly. The quad is
 * sized to the SOURCE's voxel extent (`layer.dataW/dataH`, from
 * `labelFootprint`) and placed at the source member's `offsetX/offsetY`, so
 * a coarser label still covers the same region of the view. Declared OME colors
 * are honored via the palette buffer; the rest use the glasbey hash.
 * Returns the drawn view, or null when the pool has no resident slice yet.
 */
function renderLabelLayer(
  ctx: WorkerCtx,
  msg: SliceRenderMultiPassMessage,
  layer: SliceLayerParams,
  target: GPUTexture,
): CompositeLayer | null {
  const memberId = layer.datasetId;
  const pool = ctx.state.labelSlicePools.get(memberId);
  if (!pool) return null;

  const descBuffer = ensureLabelDescriptor(ctx, pool, layer.opacity ?? DEFAULT_LABEL_OPACITY);
  const palette = ensureLabelPalette(ctx, pool, layer.labelColors);

  const renderer = ctx.getSliceRenderer();
  const ox = layer.offsetX ?? 0;
  const oy = layer.offsetY ?? 0;
  renderer.setProxyTextures(null, null);
  renderer.setAtlas(pool.texture, pool.indirectionBuf, [1, 1]);
  // Categorical shading computes color from the id in-shader; the LUT is
  // bound (a valid gray ramp) but unread on this path.
  renderer.setColormapTexture(ctx.getOrCreateLUT("gray"));
  renderer.setTransform(msg.zoom, msg.cx - ox, msg.cy - oy, msg.canvasW, msg.canvasH, layer.dataW, layer.dataH);
  renderer.setLabelColorBuffer(palette.buffer);
  renderer.setDescriptorBinding(descBuffer, 0, palette.count);

  const encoder = ctx.device.createCommandEncoder();
  renderer.renderTo(target.createView(), encoder);
  ctx.device.queue.submit([encoder.finish()]);
  return { view: target.createView(), blendMode: layer.blendMode };
}

export function handleSliceRenderMultiPass(
  ctx: WorkerCtx,
  msg: SliceRenderMultiPassMessage,
  layerToPool: (memberId: string) => {
    detailPoolKey: string | null;
    coarsePoolKey: string | null;
    datasetId: string | null;
  } | null,
): void {
  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = msg.canvasW;
  canvas.height = msg.canvasH;

  const renderer = ctx.getSliceRenderer();
  const comp = ctx.getCompositor();
  const pool = ctx.ensureOffscreenPool(msg.layers.length, msg.canvasW, msg.canvasH);
  const atlasMap = ctx.state.sliceAtlases;

  const renderedLayers: CompositeLayer[] = [];

  for (const layer of msg.layers) {
    const memberId = layer.datasetId;

    // Categorical label overlays render from their own r32uint pool via a
    // transient descriptor, independent of the cold-state chunk pipeline.
    if (layer.isLabel) {
      const drawn = renderLabelLayer(ctx, msg, layer, pool[renderedLayers.length]);
      if (drawn) renderedLayers.push(drawn);
      continue;
    }

    const resolved = layerToPool(memberId);
    if (!resolved) continue;

    // Per-dataset descriptor + entity index (orchestrator-computed;
    // converges with the worker's descriptor build by canonical
    // iteration order).
    const descIndex = resolved.datasetId
      ? ctx.lookupEntityDescriptor(resolved.datasetId)
      : null;
    if (!descIndex) continue;
    const entityIndex = layer.entityIndex;

    // Detect "no detail" via descriptor-derived state: the canonical
    // signal that this entity has no chunks in the pool. Drives the
    // dummy chunk atlas binding + skip-render guard below.
    const detailAtlas: SliceAtlasState | null = resolved.detailPoolKey
      ? atlasMap.get(resolved.detailPoolKey) ?? null
      : null;
    const coarseAtlas: SliceAtlasState | null = resolved.coarsePoolKey
      ? atlasMap.get(resolved.coarsePoolKey) ?? null
      : null;
    const detailMetas: LodIndirectionMeta[] | null =
      detailAtlas?.entityMetas.get(memberId) ?? null;
    const coarseMetas: LodIndirectionMeta[] | null =
      coarseAtlas?.entityMetas.get(memberId) ?? null;
    const hasDetail = detailMetas != null && detailMetas.length > 0;
    const hasCoarse = coarseMetas != null && coarseMetas.length > 0;

    const ox = layer.offsetX ?? 0;
    const oy = layer.offsetY ?? 0;
    if (hasDetail || hasCoarse) {
      setCameraUVForMember(ctx.state, memberId, [
        (msg.cx - ox) / layer.dataW,
        (msg.cy - oy) / layer.dataH,
      ]);
    }

    const idx = renderedLayers.length;

    for (const atlas of [detailAtlas, coarseAtlas]) {
      if (atlas && atlas.indirectionDirty) {
        ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
        atlas.indirectionDirty = false;
      }
    }

    // Resolve proxy texture handles via the descriptor's dense pool
    // array. Slot indices + dims come from the GPU descriptor.
    const desc = descIndex.proxyDescriptorByMember.get(memberId) ?? null;
    let tileProxyTexture: GPUTexture | null = null;
    let tileProxySlotResident = false;
    let groupProxyTexture: GPUTexture | null = null;
    let groupProxySlotResident = false;

    if (desc) {
      if (desc.tileProxyHandle) {
        const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.tileProxyHandle.poolKey);
        if (poolIdx !== undefined) {
          tileProxyTexture = descIndex.proxyPoolsByIndex[poolIdx].texture;
          tileProxySlotResident = true;
        }
      }
      if (desc.groupProxyHandle) {
        const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.groupProxyHandle.poolKey);
        if (poolIdx !== undefined) {
          groupProxyTexture = descIndex.proxyPoolsByIndex[poolIdx].texture;
          groupProxySlotResident = true;
        }
      }
    }

    // Skip when the layer has nothing renderable: no detail/coarse chunks
    // AND no resident proxy. Entities with either chunk tier or a resident
    // proxy continue rendering; the shader fallback chain handles the rest.
    if (!hasDetail && !hasCoarse && !tileProxySlotResident && !groupProxySlotResident) continue;

    renderer.setProxyTextures(tileProxyTexture, groupProxyTexture);

    renderer.setTierAtlases(
      hasDetail && detailAtlas ? detailAtlas.texture : null,
      hasDetail && detailAtlas ? detailAtlas.indirectionBuf : null,
      hasDetail && detailAtlas ? [detailAtlas.slotsX, detailAtlas.slotsY] : [0, 0],
      hasCoarse && coarseAtlas ? coarseAtlas.texture : null,
      hasCoarse && coarseAtlas ? coarseAtlas.indirectionBuf : null,
      hasCoarse && coarseAtlas ? [coarseAtlas.slotsX, coarseAtlas.slotsY] : [0, 0],
    );

    // Colormap from descriptor's CPU mirror; contrast/gamma/opacity are
    // read by the shader straight from the descriptor.
    const colormapName = descIndex.colormapNameByMember.get(memberId) ?? "gray";
    const lutTex = ctx.getOrCreateLUT(colormapName);
    renderer.setColormapTexture(lutTex);
    renderer.setTransform(msg.zoom, msg.cx - ox, msg.cy - oy, msg.canvasW, msg.canvasH, layer.dataW, layer.dataH);
    // Intensity draws carry no declared palette; bind the dummy (count 0).
    renderer.setLabelColorBuffer(null);
    renderer.setDescriptorBinding(descIndex.buffer, entityIndex);
    const layerEncoder = ctx.device.createCommandEncoder();
    renderer.renderTo(pool[idx].createView(), layerEncoder);
    ctx.device.queue.submit([layerEncoder.finish()]);
    renderedLayers.push({ view: pool[idx].createView(), blendMode: layer.blendMode });
  }

  const canvasView = ctx.context.getCurrentTexture().createView();
  const compEncoder = ctx.device.createCommandEncoder();
  comp.composite(canvasView, renderedLayers, compEncoder);
  ctx.device.queue.submit([compEncoder.finish()]);

  const cr = ctx.getCursorRenderer();
  if (cr.hasData()) {
    const cursorEncoder = ctx.device.createCommandEncoder();
    cr.renderSlice(canvasView, cursorEncoder, msg.zoom, msg.cx, msg.cy, msg.canvasW, msg.canvasH);
    ctx.device.queue.submit([cursorEncoder.finish()]);
  }
}
