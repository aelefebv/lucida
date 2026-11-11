/**
 * Volume render-multipass orchestration.
 *
 * Per layer: resolve member→dataset and look up the descriptor and the
 * pools its level sources and coarse source name. Then per batch of layers
 * that do not overlap: draw them to offscreen in one pass, composite. After
 * the batches: cursor draw.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { VolumeLayerParams, VolumeRenderMultiPassMessage } from "../workerProtocol.ts";
import type { RowBand, VolumeMemberDraw, VolumePoolBinding } from "../volumeRenderer.ts";
import { batchLayers, type BatchLayer } from "../layerBatches.ts";
import { resolveMemberPools } from "../descriptorBuffer.ts";
import { flushViewIndirection } from "../viewIndirection.ts";
import { labelVolumePoolKey } from "../labelPools.ts";

import {
  type AtlasState,
  type LabelVolumePool,
  markLabelVolumeFailed,
} from "./atlas.ts";
import { serializeTransientDescriptor } from "../descriptor/transient.ts";
import { DESCRIPTOR_ENTRY_SIZE } from "../descriptor/layout.ts";
import { packLabelPalette } from "../labelColors.ts";
import { captureRenderedFrame } from "../worker/captureFrame.ts";
import { heldViewDepth, trimViewLayerTargets, viewDepth } from "../worker/viewResources.ts";
import { beginViewFrame } from "../worker/viewFrame.ts";

/** Defensive fallback model transform. A real label layer always carries its source member's matrices. */
/** The pool of the label form a volume layer draws, its chunk-T. */
function labelVolumePoolOf(ctx: WorkerCtx, layer: VolumeLayerParams): LabelVolumePool | undefined {
  return layer.labelChunk && ctx.state.labelVolumePools.get(labelVolumePoolKey(layer.datasetId, layer.labelChunk.t));
}

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
  const pool = labelVolumePoolOf(ctx, layer);
  if (!pool) return false;
  if (layer.labelChunk) markLabelVolumeFailed(ctx, memberId, pool, layer.labelChunk);

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

  const depth = viewDepth(ctx, msg.view, msg.canvasW, msg.canvasH);
  const depthView = depth.createView();
  const timing = ctx.passTimer;
  const encoder = ctx.device.createCommandEncoder();
  renderer.renderTo(target.createView(), encoder, depthView, isFirstLayer, undefined, undefined, layer.scissorRect, timing);
  comp.composite(canvasView, [{ view: target.createView(), blendMode: layer.blendMode }], encoder, isFirstLayer, timing);
  ctx.device.queue.submit([encoder.finish()]);
  return true;
}

/**
 * An atlas as the renderer binds it for `view`: the shared texture, read
 * through the view's own indirection, written to the GPU first if it changed.
 */
export function volumePoolBinding(ctx: WorkerCtx, atlas: AtlasState, view: number): VolumePoolBinding {
  const indirection = atlas.views.get(view)!;
  flushViewIndirection(ctx.device, indirection);
  return {
    texture: atlas.texture,
    indirectionBuf: indirection.indirectionBuf,
    slotsX: atlas.slotsX,
    slotsY: atlas.slotsY,
    slotsZ: atlas.slotsZ,
  };
}

/** The member draw set the viewport's frames use. */
const VIEW_DRAWS = "view";

/**
 * March each batch's member draws into an offscreen texture of its own, a
 * row band at a time, each band its own submission. Between bands the GPU
 * is free for the browser and the page, and the page can give the frame up
 * for one that answers input; then this returns null. The march's pixels
 * are the whole frame's, band by band, so the composite after it draws the
 * frame the unbanded path would. The bands split only the rows the draws
 * cover: a row with no draw costs nothing to march.
 */
async function marchInBands(
  ctx: WorkerCtx,
  msg: VolumeRenderMultiPassMessage,
  draws: readonly VolumeMemberDraw[],
  batches: readonly (readonly number[])[],
  depthView: GPUTextureView,
  bandsWanted: number,
): Promise<GPUTextureView[] | null> {
  const renderer = ctx.getVolumeRenderer();
  const targets = ctx.ensureOffscreenPool(msg.view, batches.length, msg.canvasW, msg.canvasH)
    .slice(0, batches.length)
    .map((texture) => texture.createView());
  let top = msg.canvasH;
  let bottom = 0;
  for (const draw of draws) {
    const [, y, , h] = draw.scissor ?? [0, 0, msg.canvasW, msg.canvasH];
    top = Math.min(top, Math.max(0, y));
    bottom = Math.max(bottom, Math.min(msg.canvasH, y + h));
  }
  const covered = Math.max(0, bottom - top);
  const bands = Math.max(1, Math.min(bandsWanted, covered));
  for (let band = 0; band < bands; band++) {
    const y = top + Math.floor((band * covered) / bands);
    const rows: RowBand = { y, height: top + Math.floor(((band + 1) * covered) / bands) - y, first: band === 0 };
    const encoder = ctx.device.createCommandEncoder();
    for (const [at, indices] of batches.entries()) {
      renderer.renderMembers(
        VIEW_DRAWS, indices, targets[at], msg.canvasW, msg.canvasH, depthView, at === 0 && band === 0, encoder, ctx.passTimer, rows,
      );
    }
    ctx.device.queue.submit([encoder.finish()]);
    if (band === bands - 1) break;
    await ctx.device.queue.onSubmittedWorkDone();
    if (msg.frameSeq !== undefined && msg.frameSeq <= ctx.state.abandonedFrameSeq) return null;
  }
  return targets;
}

export async function handleVolumeRenderMultiPass(
  ctx: WorkerCtx,
  frame: VolumeRenderMultiPassMessage,
): Promise<void> {
  // The view draws in its own pixels, as if its rectangle were the canvas.
  const msg = { ...frame, canvasW: frame.rect[2], canvasH: frame.rect[3] };
  const renderer = ctx.getVolumeRenderer();
  const comp = ctx.getCompositor();
  const cr = ctx.getCursorRenderer();
  // The volume renderer is built on first need, so an open's first volume
  // frame usually waits here. The wait holds every message behind this one
  // (`worker/inOrder.ts`).
  await Promise.all([renderer.compiled, comp.compiled, cr.compiled]);

  // One offscreen texture: each batch of layers is rendered and composited in turn.
  const pool = ctx.ensureOffscreenPool(msg.view, 1, msg.canvasW, msg.canvasH);
  // A slice frame or a banded frame before this one may have left more.
  trimViewLayerTargets(ctx, msg.view, 1);

  const atlasMap = ctx.state.volumeAtlases;

  const timing = ctx.passTimer;
  timing.beginFrame();
  renderer.setPixelRatio(msg.pixelRatio ?? 1);
  renderer.setMarchStepScale(msg.marchStepScale ?? 1);
  renderer.setMatrices(msg.invViewProj, msg.eye, msg.viewProj, msg.camForward, msg.clipDistance, msg.clipMode);

  // What each drawn layer is, in message order: an intensity layer's index
  // among the member draws, or a label layer drawn on its own.
  const draws: VolumeMemberDraw[] = [];
  const drawn: Array<{ draw: number } | { label: VolumeLayerParams }> = [];
  const batchInput: BatchLayer[] = [];
  // The minimap draws in the mode the last layer drawn left set.
  let lastMode: number | null = null;

  for (const layer of msg.layers) {
    const memberId = layer.datasetId;

    // Label overlays render from their own r32uint pool, independent of the
    // cold-state chunk pipeline.
    if (layer.isLabel) {
      if (!labelVolumePoolOf(ctx, layer)) continue;
      drawn.push({ label: layer });
      batchInput.push({ rect: layer.scissorRect, blendMode: layer.blendMode, alone: true });
      lastMode = 0;
      continue;
    }

    // The orchestrator's entity index matches the worker's descriptor build
    // by construction.
    const datasetId = ctx.state.memberToDataset.get(memberId);
    const descIndex = datasetId ? ctx.lookupEntityDescriptor(datasetId, msg.view) : null;
    if (!descIndex) continue;

    const pools = resolveMemberPools(atlasMap, descIndex, memberId, msg.view);
    const hasDetail = pools.levels.some((atlas) => atlas !== null);
    const hasCoarse = pools.coarse !== null;
    // Anything resident is enough to draw; the shader's sampling chain
    // covers what this member lacks.
    if (!hasDetail && !hasCoarse) continue;

    const renderMode = layer.renderMode === "max_intensity" ? 1 : 0;
    drawn.push({ draw: draws.length });
    draws.push({
      levels: pools.levels.map((atlas) => (atlas ? volumePoolBinding(ctx, atlas, msg.view) : null)),
      coarse: pools.coarse ? volumePoolBinding(ctx, pools.coarse, msg.view) : null,
      colormap: ctx.getOrCreateLUT(descIndex.colormapNameByMember.get(memberId) ?? "gray"),
      renderMode,
      descriptorBuffer: descIndex.buffer,
      entityIndex: layer.entityIndex,
      scissor: layer.scissorRect,
    });
    batchInput.push({ rect: layer.scissorRect, blendMode: layer.blendMode });
    lastMode = renderMode;
  }

  renderer.prepareMembers(VIEW_DRAWS, draws);
  const depth = viewDepth(ctx, msg.view, msg.canvasW, msg.canvasH);
  const depthView = depth.createView();
  const batches = batchLayers(batchInput, msg.canvasW, msg.canvasH);
  const memberBatches = batches.map((batch) => batch.layers.map((at) => drawn[at]));
  const bands = Math.floor(msg.bands ?? 1);
  let marched: GPUTextureView[] | null = null;
  if (bands > 1 && batches.length > 0 && memberBatches.every((batch) => batch.every((d) => "draw" in d))) {
    const batchDraws = memberBatches.map((batch) => batch.map((d) => (d as { draw: number }).draw));
    marched = await marchInBands(ctx, msg, draws, batchDraws, depthView, bands);
    if (marched === null) {
      // Given up between bands: the canvas keeps the frame it shows.
      if (lastMode !== null) renderer.setRenderMode(lastMode);
      renderer.setMarchStepScale(1);
      timing.endFrame();
      return;
    }
  }

  // Only after the bands: the canvas presents the texture it hands out once
  // this handler yields, so a band's wait would present a blank frame.
  const target = beginViewFrame(ctx, frame.view, frame.canvasW, frame.canvasH, frame.rect);
  const canvasView = target.texture.createView();
  const scratchView = pool[0].createView();

  // One submit for every batch between label layers, which draw through the
  // renderer's own buffers and submit on their own.
  let encoder = ctx.device.createCommandEncoder();
  let isFirstLayer = true;
  for (const [at, batch] of batches.entries()) {
    const lead = drawn[batch.layers[0]];
    if ("label" in lead) {
      ctx.device.queue.submit([encoder.finish()]);
      if (renderLabelVolumeLayer(ctx, msg, lead.label, pool[0], canvasView, comp, isFirstLayer)) isFirstLayer = false;
      encoder = ctx.device.createCommandEncoder();
      continue;
    }
    let source = scratchView;
    if (marched) {
      source = marched[at];
    } else {
      const indices = batch.layers.map((layer) => (drawn[layer] as { draw: number }).draw);
      renderer.renderMembers(
        VIEW_DRAWS, indices, scratchView, msg.canvasW, msg.canvasH, depthView, isFirstLayer, encoder, timing,
      );
    }
    comp.composite(canvasView, [{ view: source, blendMode: batch.blendMode }], encoder, isFirstLayer, timing);
    isFirstLayer = false;
  }
  if (lastMode !== null) renderer.setRenderMode(lastMode);

  // With no layer drawn, nothing has cleared the canvas yet.
  if (isFirstLayer) comp.composite(canvasView, [], encoder, true, timing);
  comp.underlayBackground(canvasView, encoder, timing);
  ctx.device.queue.submit([encoder.finish()]);

  const depthTex = heldViewDepth(ctx, msg.view);
  if (cr.hasData() && msg.viewProj && depthTex) {
    const cursorEncoder = ctx.device.createCommandEncoder();
    cr.renderVolume(canvasView, depthTex.createView(), cursorEncoder, msg.viewProj, msg.fullW, msg.fullH, timing);
    ctx.device.queue.submit([cursorEncoder.finish()]);
  }

  // The minimap and thumbnails draw with this renderer too, at full quality.
  renderer.setMarchStepScale(1);
  timing.endFrame();
  // The frame can be read only here, after its last pass and before the
  // texture expires with this handler. A view that covers part of the canvas
  // reaches it, and is read, when the views are presented.
  if (target.canvasTexture) captureRenderedFrame(ctx, target.canvasTexture);
}
