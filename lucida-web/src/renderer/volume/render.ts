/**
 * Volume render-multipass orchestration.
 *
 * Per layer: resolve member→pool→datasetId, look up descriptor + atlas,
 * compute chunk residency, bind detail/coarse atlases, draw to offscreen,
 * composite. After the loop: cursor draw.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { VolumeLayerParams, VolumeRenderMultiPassMessage } from "../workerProtocol.ts";
import {
  type AtlasState,
  type LabelVolumePool,
  labelVolumePoolMatchesEpochs,
  type LodIndirectionMeta,
  ensureDepthTexture,
  getDepthTexture,
} from "./atlas.ts";
import { serializeTransientDescriptor } from "../descriptor/transient.ts";
import { DESCRIPTOR_ENTRY_SIZE } from "../descriptor/layout.ts";
import { packLabelPalette } from "../labelColors.ts";
import { DEFAULT_LABEL_OPACITY } from "../../labelSettings.ts";
import {
  admitWorkerRenderSurface,
  admitWorkerRenderViewport,
} from "../worker/surface.ts";
import { labelPoolKey } from "../labelPoolKey.ts";
import { parseCompositeKey } from "../chunkKeys.ts";

/** Identity 4×4 (column-major) — the fallback model transform for a label
 *  layer that somehow arrives without matrices (defensive; a real label
 *  layer always carries the source member's matrices). */
const IDENTITY_4X4 = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

/**
 * Build the resident-member view once per atlas for this render message.
 * Cold state installs entity metadata before any remote chunk arrives, so
 * metadata alone is not evidence that a draw can contribute content.
 */
function residentMembersForAtlas(
  atlas: AtlasState,
  cache: Map<AtlasState, Set<string>>,
): Set<string> {
  const cached = cache.get(atlas);
  if (cached) return cached;
  const members = new Set<string>();
  for (const [key, slotIndex] of atlas.slots) {
    // Remapping deliberately keeps old T/C and off-region chunks cached while
    // disconnecting them from shader-visible indirection. Only a mapped slot
    // can contribute to the frame being acknowledged.
    if (atlas.slotGridIdx[slotIndex] < 0) continue;
    const parsed = parseCompositeKey(key);
    if (parsed) members.add(parsed.memberId);
  }
  cache.set(atlas, members);
  return members;
}

/**
 * Defensively clip the main-thread projection to the admitted worker surface.
 * The normal path already sends integer, in-bounds rectangles; this boundary
 * keeps malformed or stale geometry from reaching WebGPU validation.
 */
function admitLayerScissor(
  rect: [number, number, number, number],
  canvasW: number,
  canvasH: number,
): [number, number, number, number] | null {
  const [rawX, rawY, rawW, rawH] = rect;
  if (
    !Number.isFinite(rawX) ||
    !Number.isFinite(rawY) ||
    !Number.isFinite(rawW) ||
    !Number.isFinite(rawH) ||
    rawW <= 0 ||
    rawH <= 0
  ) {
    return null;
  }
  const x0 = Math.max(0, Math.floor(rawX));
  const y0 = Math.max(0, Math.floor(rawY));
  const x1 = Math.min(canvasW, Math.ceil(rawX + rawW));
  const y1 = Math.min(canvasH, Math.ceil(rawY + rawH));
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * The transient categorical descriptor for a label volume pool. The buffer
 * is allocated once and rewritten in place each frame (the model matrix can
 * change on a layout epoch, so — unlike the 2D label descriptor cached by
 * opacity — it isn't cached). Single-LOD carrying the level's chunk grid so
 * the shader walks the bricked slot-grid atlas via its indirection buffer,
 * `colormapMode == 1` to select the shader's first-hit branch.
 */
function ensureLabelVolumeDescriptor(
  ctx: WorkerCtx,
  pool: LabelVolumePool,
  opacity: number,
  modelMatrix: Float32Array,
  invModelMatrix: Float32Array,
): GPUBuffer {
  const descBytes = new ArrayBuffer(DESCRIPTOR_ENTRY_SIZE);
  serializeTransientDescriptor(descBytes, {
    modelMatrix,
    invModelMatrix,
    volumeDims: [pool.width, pool.height, pool.depth],
    // Bricked LOD 0: chunk grid + per-brick dims map each cell of the level
    // to its atlas slot via the indirection buffer.
    lod: {
      gridDims: [pool.gridX, pool.gridY, pool.gridZ],
      chunkDims: [pool.chunkX, pool.chunkY, pool.chunkZ],
    },
    // Unused in categorical mode, but kept well-formed.
    contrastMin: 0,
    contrastMax: 1,
    gamma: 1,
    opacity: 1,
    colormapMode: 1,
    labelOpacity: opacity,
  });
  if (!pool.descBuffer) {
    pool.descAllocation = ctx.gpuResources.createBuffer(
      ctx.device,
      {
        key: `label-volume:${labelPoolKey(pool.datasetId, pool.memberId)}:descriptor`,
        kind: "descriptor",
        datasetId: pool.datasetId,
      },
      {
        size: DESCRIPTOR_ENTRY_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      },
    );
    pool.descBuffer = pool.descAllocation.resource;
  }
  ctx.device.queue.writeBuffer(pool.descBuffer, 0, descBytes);
  return pool.descBuffer;
}

/**
 * The declared-palette storage buffer for a label volume pool: flat [id,
 * packedRgba] pairs from `image-label.colors`, built once (cached by pair
 * count). Mirrors the 2D label palette; `packedRgba = r | g<<8 | b<<16 |
 * a<<24`, matching `labelColorFor` in volume.wgsl.
 */
function ensureLabelVolumePalette(
  ctx: WorkerCtx,
  pool: LabelVolumePool,
  colors: VolumeLayerParams["labelColors"],
): { buffer: GPUBuffer | null; count: number } {
  const packed = colors && colors.length > 0 ? packLabelPalette(colors) : null;
  const count = packed ? packed.length / 2 : 0;
  if (pool.labelColorCount === count) {
    return { buffer: pool.labelColorBuffer ?? null, count };
  }
  pool.labelColorAllocation?.destroy();
  if (!pool.labelColorAllocation) pool.labelColorBuffer?.destroy();
  pool.labelColorAllocation = undefined;
  pool.labelColorBuffer = undefined;
  if (packed && count > 0) {
    pool.labelColorAllocation = ctx.gpuResources.createBuffer(
      ctx.device,
      {
        key: `label-volume:${labelPoolKey(pool.datasetId, pool.memberId)}:palette:${count}`,
        kind: "buffer",
        datasetId: pool.datasetId,
      },
      {
        size: packed.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      },
    );
    const buffer = pool.labelColorAllocation.resource;
    ctx.device.queue.writeBuffer(buffer, 0, packed);
    pool.labelColorBuffer = buffer;
  }
  pool.labelColorCount = count;
  return { buffer: pool.labelColorBuffer ?? null, count };
}

/**
 * Draw one categorical label overlay from its r32uint volume pool as a
 * first-hit colored surface over the intensity volume already composited.
 *
 * A label pool is a bricked slot-grid 3D atlas covering the label's chosen
 * level, so a single-LOD transient descriptor carrying the level's chunk grid
 * walks it via the indirection buffer. It is placed by the SOURCE member's
 * model matrix (a label overlays its source's physical extent), so a coarser
 * label still covers the same region of the view.
 * Declared OME colors are honored via the palette buffer; the rest use the
 * glasbey hash. Composited OVER the intensity (alpha blend, not first layer).
 * Returns true when a draw was issued, false when the pool has no resident
 * volume yet.
 */
function renderLabelVolumeLayer(
  ctx: WorkerCtx,
  msg: VolumeRenderMultiPassMessage,
  layer: VolumeLayerParams,
  target: GPUTexture,
  canvasView: GPUTextureView,
  comp: ReturnType<WorkerCtx["getCompositor"]>,
  isFirstLayer: boolean,
): boolean {
  const memberId = layer.datasetId;
  if (!layer.ownerDatasetId) return false;
  const pool = ctx.state.labelVolumePools.get(
    labelPoolKey(layer.ownerDatasetId, memberId),
  );
  if (
    !pool
    || !labelVolumePoolMatchesEpochs(pool, msg.epochs)
    || pool.slots.size === 0
  ) return false;

  const opacity = layer.opacity ?? DEFAULT_LABEL_OPACITY;
  const model = layer.modelMatrix ?? IDENTITY_4X4;
  const invModel = layer.invModelMatrix ?? IDENTITY_4X4;
  const descBuffer = ensureLabelVolumeDescriptor(ctx, pool, opacity, model, invModel);
  const palette = ensureLabelVolumePalette(ctx, pool, layer.labelColors);

  const renderer = ctx.getVolumeRenderer();
  // Categorical shading computes color from the id in-shader; the LUT is
  // bound (a valid gray ramp) but unread on this path.
  renderer.setColormapTexture(ctx.getOrCreateLUT("gray"));
  renderer.setAtlas(
    pool.texture,
    pool.indirectionBuf,
    [pool.slotsX, pool.slotsY, pool.slotsZ],
    [pool.width, pool.height, pool.depth],
  );
  renderer.setRenderMode(0);
  renderer.setMatrices(
    msg.invViewProj,
    msg.eye,
    msg.viewProj,
    msg.camForward,
    msg.clipDistance,
    msg.clipMode,
  );
  renderer.setLabelColorBuffer(palette.buffer);
  renderer.setDescriptorBinding(descBuffer, 0, palette.count);

  const depth = ensureDepthTexture(ctx, msg.canvasW, msg.canvasH);
  const depthView = depth.createView();
  const encoder = ctx.device.createCommandEncoder();
  renderer.renderTo(target.createView(), encoder, {
    depthView,
    isFirstLayer,
    scissorRect: layer.scissorRect,
    // Categorical misses discard so their reusable color target must not
    // retain pixels from the preceding layer.
    clearColor: true,
  });
  comp.composite(
    canvasView,
    [{
      view: target.createView(),
      blendMode: layer.blendMode,
      scissorRect: layer.scissorRect,
    }],
    encoder,
    isFirstLayer,
  );
  ctx.device.queue.submit([encoder.finish()]);
  return true;
}

export function handleVolumeRenderMultiPass(
  ctx: WorkerCtx,
  incoming: VolumeRenderMultiPassMessage,
  layerToPool: (memberId: string) => {
    detailPoolKey: string | null;
    coarsePoolKey: string | null;
    datasetId: string | null;
  } | null,
): { contentPresented: boolean } | null {
  const surface = admitWorkerRenderSurface(
    ctx,
    incoming.canvasW,
    incoming.canvasH,
  );
  const fullSurface = admitWorkerRenderViewport(
    incoming.fullW,
    incoming.fullH,
  );
  if (!surface || !fullSurface) return null;
  const layers: VolumeLayerParams[] = [];
  for (const layer of incoming.layers) {
    if (!layer.scissorRect) {
      layers.push(layer);
      continue;
    }
    const scissorRect = admitLayerScissor(
      layer.scissorRect,
      surface.width,
      surface.height,
    );
    if (scissorRect) layers.push({ ...layer, scissorRect });
  }
  const msg: VolumeRenderMultiPassMessage = {
    ...incoming,
    layers,
    canvasW: surface.width,
    canvasH: surface.height,
    fullW: fullSurface.width,
    fullH: fullSurface.height,
  };

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
  const residentMembersByAtlas = new Map<AtlasState, Set<string>>();

  for (const layer of msg.layers) {
    const memberId = layer.datasetId;

    // Categorical label overlays render from their own r32uint volume pool
    // via a transient descriptor (first-hit surface), independent of the
    // cold-state chunk pipeline. Composited OVER the intensity already drawn.
    if (layer.isLabel) {
      const drew = renderLabelVolumeLayer(ctx, msg, layer, pool[0], canvasView, comp, isFirstLayer);
      if (drew) isFirstLayer = false;
      continue;
    }

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
    const hasDetail = detailAtlas != null
      && detailMetas != null
      && detailMetas.length > 0
      && residentMembersForAtlas(detailAtlas, residentMembersByAtlas).has(memberId);
    const hasCoarse = coarseAtlas != null
      && coarseMetas != null
      && coarseMetas.length > 0
      && residentMembersForAtlas(coarseAtlas, residentMembersByAtlas).has(memberId);

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

    // Skip when neither chunk tier has anything renderable.
    if (!hasDetail && !hasCoarse) {
      continue;
    }

    const dimsMeta = detailMetas?.[0] ?? coarseMetas?.[0] ?? null;
    if (!dimsMeta) continue;
    const volumeDims: [number, number, number] = [
      dimsMeta.levelDims[2],
      dimsMeta.levelDims[1],
      dimsMeta.levelDims[0],
    ];
    const fallbackTexture = detailAtlas?.texture ?? coarseAtlas?.texture ?? ctx.getDummy3DTexture();
    const fallbackIndirection =
      detailAtlas?.indirectionBuf ??
      coarseAtlas!.indirectionBuf;
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
    // Intensity draws carry no declared palette; bind the dummy (count 0) so
    // a prior label draw's palette buffer never leaks into this bind group.
    renderer.setLabelColorBuffer(null);
    renderer.setDescriptorBinding(descIndex.buffer, entityIndex);
    const depth = ensureDepthTexture(ctx, msg.canvasW, msg.canvasH);
    const depthView = depth.createView();

    // Render volume to single offscreen texture, then composite onto canvas
    const encoder = ctx.device.createCommandEncoder();
    renderer.renderTo(pool[0].createView(), encoder, {
      depthView,
      isFirstLayer,
      scissorRect: layer.scissorRect,
      // The intensity shader writes a color (including transparent misses)
      // for every pixel in its scissor. Loading avoids a whole-target clear;
      // the compositor uses the same scissor so pixels outside it are ignored.
      clearColor: false,
    });
    comp.composite(
      canvasView,
      [{
        view: pool[0].createView(),
        blendMode: layer.blendMode,
        scissorRect: layer.scissorRect,
      }],
      encoder,
      isFirstLayer,
    );
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
  return { contentPresented: !isFirstLayer };
}
