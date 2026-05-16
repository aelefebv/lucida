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
  layerToPool: (memberId: string) => { poolKey: string | null; datasetId: string | null } | null,
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
    const atlas: AtlasState | null = resolved.poolKey ? atlasMap.get(resolved.poolKey) ?? null : null;
    let entityLodMetas: LodIndirectionMeta[] | null = null;
    if (atlas) {
      entityLodMetas = atlas.entityMetas.get(memberId) ?? null;
    }
    const hasDetail = entityLodMetas != null && entityLodMetas.length > 0;

    // Colormap name lives in the descriptor's CPU mirror (set by cold
    // state). Resolve it per draw to bind the right LUT texture.
    const colormapName = descIndex.colormapNameByMember.get(memberId) ?? "gray";
    const lutTex = ctx.getOrCreateLUT(colormapName);
    renderer.setColormapTexture(lutTex);

    if (atlas && atlas.indirectionDirty) {
      ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
      atlas.indirectionDirty = false;
    }

    // Pool index + slot index live in the descriptor; CPU side only
    // needs the texture handle for binding. Read the pool by walking
    // the dense `proxyPoolsByIndex` array (resolved via the entity's
    // CPU-side proxy descriptor mirror).
    const desc = layer.entityId
      ? ctx.lookupProxyDescriptor(layer.entityId)
      : null;
    let fieldProxyTexture: GPUTexture | null = null;
    let wellProxyTexture: GPUTexture | null = null;
    let wellProxySlotResident = false;
    let wellSlotDimsForVolumeFallback: [number, number, number] = [1, 1, 1];

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
          const pool = descIndex.proxyPoolsByIndex[poolIdx];
          wellProxyTexture = pool.texture;
          wellProxySlotResident = true;
          wellSlotDimsForVolumeFallback = pool.slotDims;
        }
      }
    }

    // Skip when the layer has nothing renderable: no detail chunks AND
    // no resident well proxy. Entities with detail OR a resident proxy
    // continue rendering — the unified fallback chain handles the rest.
    if (!hasDetail && !wellProxySlotResident) {
      isFirstLayer = false;
      continue;
    }

    renderer.setProxyTextures(fieldProxyTexture, wellProxyTexture);

    if (hasDetail && atlas && entityLodMetas) {
      // Detail path: real chunk atlas + LOD metadata.
      const targetMeta = entityLodMetas[0]; // first is target (finest)
      const [tLevelD, tLevelH, tLevelW] = targetMeta.levelDims;
      renderer.setAtlas(
        atlas.texture, atlas.indirectionBuf,
        [atlas.slotsX, atlas.slotsY, atlas.slotsZ],
        [tLevelW, tLevelH, tLevelD],
        entityLodMetas,
      );
    } else {
      // No detail — bind dummies for the chunk path (the unified shader
      // chain falls through to the well proxy via the descriptor).
      // volumeDims must reflect the proxy's voxel resolution: the volume
      // renderer derives ray-march stepSize from it, and [1,1,1] yields
      // ~3 samples/ray → alpha barely accumulates in translucent
      // compositing → proxy renders dim/desaturated.
      const dummyChunk = ctx.getDummy3DTexture();
      // wellSlotDimsForVolumeFallback is [Z, Y, X]; setAtlas takes
      // volumeDims as [X, Y, Z].
      const proxyVolumeDims: [number, number, number] = [
        wellSlotDimsForVolumeFallback[2],
        wellSlotDimsForVolumeFallback[1],
        wellSlotDimsForVolumeFallback[0],
      ];
      renderer.setAtlas(
        dummyChunk, getDummyIndirection(ctx.device),
        [1, 1, 1], proxyVolumeDims,
        [],
      );
    }

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
