/**
 * Slice render-multipass orchestration.
 *
 * Per layer: resolve member→pool→datasetId, look up descriptor + atlas,
 * compute hasDetail, update per-entity camera UV, resolve proxy
 * textures, bind, draw to offscreen. After the loop: composite + cursor.
 *
 * Extracted from `sliceHandlers.ts` in Slice 7. No behavior change.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { SliceRenderMultiPassMessage } from "../workerProtocol.ts";
import type { CompositeLayer } from "../layerCompositor.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import {
  type SliceAtlasState,
  getDummySliceIndirection,
} from "./atlas.ts";
import { setCameraUVForMember } from "./eviction.ts";

export function handleSliceRenderMultiPass(
  ctx: WorkerCtx,
  msg: SliceRenderMultiPassMessage,
  layerToPool: (memberId: string) => { poolKey: string | null; datasetId: string | null } | null,
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
    const atlas: SliceAtlasState | null = resolved.poolKey ? atlasMap.get(resolved.poolKey) ?? null : null;
    let entityLodMetas: LodIndirectionMeta[] | null = null;
    if (atlas) {
      entityLodMetas = atlas.entityMetas.get(memberId) ?? null;
    }
    const hasDetail = entityLodMetas != null && entityLodMetas.length > 0;

    const ox = layer.offsetX ?? 0;
    const oy = layer.offsetY ?? 0;
    if (hasDetail) {
      setCameraUVForMember(ctx.state, memberId, [
        (msg.cx - ox) / layer.dataW,
        (msg.cy - oy) / layer.dataH,
      ]);
    }

    const idx = renderedLayers.length;

    if (atlas && atlas.indirectionDirty) {
      ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
      atlas.indirectionDirty = false;
    }

    // Resolve proxy texture handles via the descriptor's dense pool
    // array. Slot indices + dims come from the GPU descriptor.
    const desc = layer.entityId
      ? ctx.lookupProxyDescriptor(layer.entityId)
      : null;
    let fieldProxyTexture: GPUTexture | null = null;
    let wellProxyTexture: GPUTexture | null = null;
    let wellProxySlotResident = false;

    if (desc) {
      if (desc.fieldProxyHandle) {
        const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.fieldProxyHandle.poolKey);
        if (poolIdx !== undefined) {
          fieldProxyTexture = descIndex.proxyPoolsByIndex[poolIdx].texture;
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
    // no resident well proxy. Entities with detail OR a resident proxy
    // continue rendering — the unified fallback chain handles the rest.
    if (!hasDetail && !wellProxySlotResident) continue;

    renderer.setProxyTextures(fieldProxyTexture, wellProxyTexture);

    if (hasDetail && atlas) {
      renderer.setAtlas(
        atlas.texture, atlas.indirectionBuf,
        [atlas.slotsX, atlas.slotsY],
      );
    } else {
      // No detail — bind the slice renderer's own dummy chunk +
      // indirection so the bind group is valid. The unified shader chain
      // falls through to the proxy via the descriptor.
      renderer.setAtlas(
        ctx.getDummyTexture(), getDummySliceIndirection(ctx.device),
        [1, 1],
      );
    }

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
