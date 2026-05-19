/**
 * Slice render-multipass orchestration.
 *
 * Per layer: resolve member→pool→datasetId, look up descriptor + atlas,
 * compute hasDetail, update per-entity camera UV, resolve proxy
 * textures, bind, draw to offscreen. After the loop: composite + cursor.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { SliceRenderMultiPassMessage } from "../workerProtocol.ts";
import type { CompositeLayer } from "../layerCompositor.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import { type SliceAtlasState } from "./atlas.ts";
import { setCameraUVForMember } from "./eviction.ts";

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
    let fieldProxyTexture: GPUTexture | null = null;
    let fieldProxySlotResident = false;
    let wellProxyTexture: GPUTexture | null = null;
    let wellProxySlotResident = false;

    if (desc) {
      if (desc.fieldProxyHandle) {
        const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.fieldProxyHandle.poolKey);
        if (poolIdx !== undefined) {
          fieldProxyTexture = descIndex.proxyPoolsByIndex[poolIdx].texture;
          fieldProxySlotResident = true;
        }
      }
      if (desc.wellProxyHandle) {
        const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.wellProxyHandle.poolKey);
        if (poolIdx !== undefined) {
          wellProxyTexture = descIndex.proxyPoolsByIndex[poolIdx].texture;
          wellProxySlotResident = true;
        }
      }
    }

    // Skip when the layer has nothing renderable: no detail chunks AND
    // no resident proxy. Entities with detail OR a resident proxy
    // continue rendering — the unified fallback chain handles the rest.
    if (!hasDetail && !hasCoarse && !fieldProxySlotResident && !wellProxySlotResident) continue;

    renderer.setProxyTextures(fieldProxyTexture, wellProxyTexture);

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
