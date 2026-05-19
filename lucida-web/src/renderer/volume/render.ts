/**
 * Volume render-multipass orchestration.
 *
 * Per layer: resolve member→pool→datasetId, look up descriptor + atlas,
 * compute hasDetail, resolve proxy textures, bind, draw to offscreen,
 * composite. After the loop: cursor draw.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { VolumeRenderMultiPassMessage } from "../workerProtocol.ts";
import {
  type AtlasState,
  type LodIndirectionMeta,
  ensureDepthTexture,
  getDepthTexture,
  getDummyIndirection,
} from "./atlas.ts";

export function handleVolumeRenderMultiPass(
  ctx: WorkerCtx,
  msg: VolumeRenderMultiPassMessage,
  layerToPool: (memberId: string) => {
    detailPoolKey: string | null;
    coarsePoolKey: string | null;
    datasetId: string | null;
  } | null,
): void {
  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = msg.canvasW;
  canvas.height = msg.canvasH;

  const renderer = ctx.getVolumeRenderer();
  const comp = ctx.getCompositor();
  // Only 1 offscreen texture needed — render and composite each layer incrementally
  const pool = ctx.ensureOffscreenPool(1, msg.canvasW, msg.canvasH);

  const canvasView = ctx.context.getCurrentTexture().createView();
  let isFirstLayer = true;
  const atlasMap = ctx.state.volumeAtlases;

  for (const layer of msg.layers) {
    const memberId = layer.datasetId;
    const resolved = layerToPool(memberId);
    if (!resolved) continue;

    // Descriptor buffer covers all members for this dataset; entity
    // index is computed by the orchestrator (and threaded into the
    // layer params) — both sides converge by construction.
    const descIndex = resolved.datasetId
      ? ctx.lookupEntityDescriptor(resolved.datasetId)
      : null;
    if (!descIndex) continue;
    const entityIndex = layer.entityIndex;

    // Detect "no detail" via descriptor-derived state: the canonical
    // signal that this entity has no chunks in the pool. Drives the
    // dummy chunk atlas binding + skip-render guard below.
    const detailAtlas: AtlasState | null = resolved.detailPoolKey
      ? atlasMap.get(resolved.detailPoolKey) ?? null
      : null;
    const coarseAtlas: AtlasState | null = resolved.coarsePoolKey
      ? atlasMap.get(resolved.coarsePoolKey) ?? null
      : null;
    const detailMetas: LodIndirectionMeta[] | null =
      detailAtlas?.entityMetas.get(memberId) ?? null;
    const coarseMetas: LodIndirectionMeta[] | null =
      coarseAtlas?.entityMetas.get(memberId) ?? null;
    const hasDetail = detailMetas != null && detailMetas.length > 0;
    const hasCoarse = coarseMetas != null && coarseMetas.length > 0;

    // Colormap name lives in the descriptor's CPU mirror (set by cold
    // state). Resolve it per draw to bind the right LUT texture.
    const colormapName = descIndex.colormapNameByMember.get(memberId) ?? "gray";
    const lutTex = ctx.getOrCreateLUT(colormapName);
    renderer.setColormapTexture(lutTex);

    for (const atlas of [detailAtlas, coarseAtlas]) {
      if (atlas && atlas.indirectionDirty) {
        ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
        atlas.indirectionDirty = false;
      }
    }

    // Pool index + slot index live in the descriptor; CPU side only
    // needs the texture handle for binding. Read the pool by walking
    // the dense `proxyPoolsByIndex` array (resolved via the member's
    // time/channel-specific proxy descriptor mirror).
    const desc = descIndex.proxyDescriptorByMember.get(memberId) ?? null;
    let fieldProxyTexture: GPUTexture | null = null;
    let fieldProxySlotResident = false;
    let wellProxyTexture: GPUTexture | null = null;
    let wellProxySlotResident = false;
    let proxySlotDimsForVolumeFallback: [number, number, number] = [1, 1, 1];

    if (desc) {
      if (desc.fieldProxyHandle) {
        const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.fieldProxyHandle.poolKey);
        if (poolIdx !== undefined) {
          const pool = descIndex.proxyPoolsByIndex[poolIdx];
          fieldProxyTexture = pool.texture;
          fieldProxySlotResident = true;
          proxySlotDimsForVolumeFallback = pool.slotDims;
        }
      }
      if (desc.wellProxyHandle) {
        const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.wellProxyHandle.poolKey);
        if (poolIdx !== undefined) {
          const pool = descIndex.proxyPoolsByIndex[poolIdx];
          wellProxyTexture = pool.texture;
          wellProxySlotResident = true;
          if (!fieldProxySlotResident) {
            proxySlotDimsForVolumeFallback = pool.slotDims;
          }
        }
      }
    }

    // Skip when the layer has nothing renderable: no detail/coarse chunks
    // AND no resident proxy. Entities with either chunk tier or a resident
    // proxy continue rendering; the shader fallback chain handles the rest.
    if (!hasDetail && !hasCoarse && !fieldProxySlotResident && !wellProxySlotResident) {
      continue;
    }

    renderer.setProxyTextures(fieldProxyTexture, wellProxyTexture);

    const dimsMeta = detailMetas?.[0] ?? coarseMetas?.[0] ?? null;
    const volumeDims: [number, number, number] = dimsMeta
      ? [dimsMeta.levelDims[2], dimsMeta.levelDims[1], dimsMeta.levelDims[0]]
      : [
          proxySlotDimsForVolumeFallback[2],
          proxySlotDimsForVolumeFallback[1],
          proxySlotDimsForVolumeFallback[0],
        ];
    const fallbackTexture = detailAtlas?.texture ?? coarseAtlas?.texture ?? ctx.getDummy3DTexture();
    const fallbackIndirection =
      detailAtlas?.indirectionBuf ??
      coarseAtlas?.indirectionBuf ??
      getDummyIndirection(ctx.device);
    renderer.setTierAtlases(
      hasDetail && detailAtlas ? detailAtlas.texture : fallbackTexture,
      hasDetail && detailAtlas ? detailAtlas.indirectionBuf : fallbackIndirection,
      hasDetail && detailAtlas ? [detailAtlas.slotsX, detailAtlas.slotsY, detailAtlas.slotsZ] : [0, 0, 0],
      hasCoarse && coarseAtlas ? coarseAtlas.texture : null,
      hasCoarse && coarseAtlas ? coarseAtlas.indirectionBuf : null,
      hasCoarse && coarseAtlas ? [coarseAtlas.slotsX, coarseAtlas.slotsY, coarseAtlas.slotsZ] : [0, 0, 0],
      volumeDims,
    );

    renderer.setRenderMode(layer.renderMode === "max_intensity" ? 1 : 0);
    renderer.setMatrices(msg.invViewProj, msg.eye, msg.viewProj, msg.camForward, msg.clipDistance, msg.clipMode);
    renderer.setDescriptorBinding(descIndex.buffer, entityIndex);
    const depth = ensureDepthTexture(ctx.device, msg.canvasW, msg.canvasH);
    const depthView = depth.createView();

    // Render volume to single offscreen texture, then composite onto canvas
    const encoder = ctx.device.createCommandEncoder();
    renderer.renderTo(pool[0].createView(), encoder, depthView, isFirstLayer, undefined, undefined, layer.scissorRect);
    comp.composite(canvasView, [{ view: pool[0].createView(), blendMode: layer.blendMode }], encoder, isFirstLayer);
    ctx.device.queue.submit([encoder.finish()]);

    isFirstLayer = false;
  }

  // If no layers were rendered, clear the canvas
  if (isFirstLayer) {
    const clearEncoder = ctx.device.createCommandEncoder();
    comp.composite(canvasView, [], clearEncoder);
    ctx.device.queue.submit([clearEncoder.finish()]);
  }

  const cr = ctx.getCursorRenderer();
  const depthTex = getDepthTexture();
  if (cr.hasData() && msg.viewProj && depthTex) {
    const cursorEncoder = ctx.device.createCommandEncoder();
    cr.renderVolume(canvasView, depthTex.createView(), cursorEncoder, msg.viewProj, msg.fullW, msg.fullH);
    ctx.device.queue.submit([cursorEncoder.finish()]);
  }
}
