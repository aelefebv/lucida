/**
 * Volume render-multipass orchestration.
 *
 * Per layer: resolve member→dataset, look up the descriptor and the
 * pools its level sources and coarse source name, bind, draw to
 * offscreen, composite. After the loop: cursor draw.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { VolumeLayerParams, VolumeRenderMultiPassMessage } from "../workerProtocol.ts";
import type { VolumePoolBinding } from "../volumeRenderer.ts";
import { resolveMemberPools } from "../descriptorBuffer.ts";
import {
  type AtlasState,
  type LabelVolumePool,
  ensureDepthTexture,
  getDepthTexture,
} from "./atlas.ts";
import { serializeTransientDescriptor } from "../descriptor/transient.ts";
import { DESCRIPTOR_ENTRY_SIZE } from "../descriptor/layout.ts";
import { packLabelPalette } from "../labelColors.ts";
import { captureRenderedFrame } from "../worker/captureFrame.ts";
import { trimOffscreenPool } from "../worker/resources.ts";

/** Defensive fallback model transform. A real label layer always carries its source member's matrices. */
const IDENTITY_4X4 = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

/** Default overlay opacity for a label layer that omits one. */
const DEFAULT_LABEL_OPACITY = 0.5;

/**
 * The categorical descriptor for a label volume pool, rewritten every frame
 * because the model matrix can change on a layout epoch. One level source
 * carries the chunk grid; `colormapMode == 1` selects the first-hit branch.
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
    chunkGrid: {
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
    pool.descBuffer = ctx.device.createBuffer({
      size: DESCRIPTOR_ENTRY_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }
  ctx.device.queue.writeBuffer(pool.descBuffer, 0, descBytes);
  return pool.descBuffer;
}

/**
 * The declared-palette storage buffer for a label volume pool: flat [id,
 * packedRgba] pairs from `image-label.colors`, cached by pair count.
 * `packedRgba = r | g<<8 | b<<16 | a<<24`, matching `labelColorFor` in volume.wgsl.
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
 * Draw one categorical label overlay from its r32uint volume pool as a
 * first-hit surface composited over the intensity already drawn. It is placed
 * by the source member's model matrix, so a coarser label still covers the
 * same region. Returns false when the pool has no resident volume yet.
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
  const pool = ctx.state.labelVolumePools.get(memberId);
  if (!pool) return false;

  const opacity = layer.opacity ?? DEFAULT_LABEL_OPACITY;
  const model = layer.modelMatrix ?? IDENTITY_4X4;
  const invModel = layer.invModelMatrix ?? IDENTITY_4X4;
  const descBuffer = ensureLabelVolumeDescriptor(ctx, pool, opacity, model, invModel);
  const palette = ensureLabelVolumePalette(ctx, pool, layer.labelColors);

  const renderer = ctx.getVolumeRenderer();
  // Categorical shading computes color from the id in-shader; the LUT is
  // bound (a valid gray ramp) but unread on this path.
  renderer.setColormapTexture(ctx.getOrCreateLUT("gray"));
  renderer.setTierAtlases(
    [{ texture: pool.texture, indirectionBuf: pool.indirectionBuf, slotsX: pool.slotsX, slotsY: pool.slotsY, slotsZ: pool.slotsZ }],
    null,
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

  const depth = ensureDepthTexture(ctx.device, msg.canvasW, msg.canvasH);
  const depthView = depth.createView();
  const timing = ctx.passTimer;
  const encoder = ctx.device.createCommandEncoder();
  renderer.renderTo(target.createView(), encoder, depthView, isFirstLayer, undefined, undefined, layer.scissorRect, timing);
  comp.composite(canvasView, [{ view: target.createView(), blendMode: layer.blendMode }], encoder, isFirstLayer, timing);
  ctx.device.queue.submit([encoder.finish()]);
  return true;
}

/** An atlas as the renderer binds it. */
function poolBinding(atlas: AtlasState): VolumePoolBinding {
  return {
    texture: atlas.texture,
    indirectionBuf: atlas.indirectionBuf,
    slotsX: atlas.slotsX,
    slotsY: atlas.slotsY,
    slotsZ: atlas.slotsZ,
  };
}

export async function handleVolumeRenderMultiPass(
  ctx: WorkerCtx,
  msg: VolumeRenderMultiPassMessage,
): Promise<void> {
  const renderer = ctx.getVolumeRenderer();
  const comp = ctx.getCompositor();
  const cr = ctx.getCursorRenderer();
  // The volume renderer is built on first need, so an open's first volume
  // frame usually waits here. The wait holds every message behind this one
  // (`worker/inOrder.ts`).
  await Promise.all([renderer.compiled, comp.compiled, cr.compiled]);

  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = msg.canvasW;
  canvas.height = msg.canvasH;

  // One offscreen texture: each layer is rendered and composited in turn.
  const pool = ctx.ensureOffscreenPool(1, msg.canvasW, msg.canvasH);
  // A slice frame before this one may have left more.
  trimOffscreenPool(1);

  const canvasTexture = ctx.context.getCurrentTexture();
  const canvasView = canvasTexture.createView();
  let isFirstLayer = true;
  const atlasMap = ctx.state.volumeAtlases;

  const timing = ctx.passTimer;
  timing.beginFrame();
  renderer.setPixelRatio(msg.pixelRatio ?? 1);

  for (const layer of msg.layers) {
    const memberId = layer.datasetId;

    // Label overlays render from their own r32uint pool, independent of the
    // cold-state chunk pipeline.
    if (layer.isLabel) {
      const drew = renderLabelVolumeLayer(ctx, msg, layer, pool[0], canvasView, comp, isFirstLayer);
      if (drew) isFirstLayer = false;
      continue;
    }

    // The orchestrator's entity index matches the worker's descriptor build
    // by construction.
    const datasetId = ctx.state.memberToDataset.get(memberId);
    const descIndex = datasetId ? ctx.lookupEntityDescriptor(datasetId) : null;
    if (!descIndex) continue;
    const entityIndex = layer.entityIndex;

    const pools = resolveMemberPools(atlasMap, descIndex, memberId);
    const hasDetail = pools.levels.some((atlas) => atlas !== null);
    const hasCoarse = pools.coarse !== null;
    // Anything resident is enough to draw; the shader's sampling chain
    // covers what this member lacks.
    if (!hasDetail && !hasCoarse) continue;

    const colormapName = descIndex.colormapNameByMember.get(memberId) ?? "gray";
    const lutTex = ctx.getOrCreateLUT(colormapName);
    renderer.setColormapTexture(lutTex);

    for (const atlas of [...pools.levels, pools.coarse]) {
      if (atlas && atlas.indirectionDirty) {
        ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
        atlas.indirectionDirty = false;
      }
    }

    renderer.setTierAtlases(
      pools.levels.map((atlas) => (atlas ? poolBinding(atlas) : null)),
      pools.coarse ? poolBinding(pools.coarse) : null,
    );

    renderer.setRenderMode(layer.renderMode === "max_intensity" ? 1 : 0);
    renderer.setMatrices(msg.invViewProj, msg.eye, msg.viewProj, msg.camForward, msg.clipDistance, msg.clipMode);
    // Intensity draws carry no declared palette; bind the dummy (count 0) so
    // a prior label draw's palette buffer never leaks into this bind group.
    renderer.setLabelColorBuffer(null);
    renderer.setDescriptorBinding(descIndex.buffer, entityIndex);
    const depth = ensureDepthTexture(ctx.device, msg.canvasW, msg.canvasH);
    const depthView = depth.createView();

    const encoder = ctx.device.createCommandEncoder();
    renderer.renderTo(pool[0].createView(), encoder, depthView, isFirstLayer, undefined, undefined, layer.scissorRect, timing);
    comp.composite(canvasView, [{ view: pool[0].createView(), blendMode: layer.blendMode }], encoder, isFirstLayer, timing);
    ctx.device.queue.submit([encoder.finish()]);

    isFirstLayer = false;
  }

  const backgroundEncoder = ctx.device.createCommandEncoder();
  // With no layer drawn, nothing has cleared the canvas yet.
  if (isFirstLayer) comp.composite(canvasView, [], backgroundEncoder, true, timing);
  comp.underlayBackground(canvasView, backgroundEncoder, timing);
  ctx.device.queue.submit([backgroundEncoder.finish()]);

  const depthTex = getDepthTexture();
  if (cr.hasData() && msg.viewProj && depthTex) {
    const cursorEncoder = ctx.device.createCommandEncoder();
    cr.renderVolume(canvasView, depthTex.createView(), cursorEncoder, msg.viewProj, msg.fullW, msg.fullH, timing);
    ctx.device.queue.submit([cursorEncoder.finish()]);
  }

  timing.endFrame();
  // The frame can be read only here, after its last pass and before the
  // texture expires with this handler.
  captureRenderedFrame(ctx, canvasTexture);
}
