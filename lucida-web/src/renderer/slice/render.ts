/**
 * Slice render-multipass orchestration.
 *
 * Per pass group, one (dataset, channel): for each layer resolve
 * member→dataset, look up the descriptor and the pools its level sources
 * and coarse source name, and update per-entity camera UV; then draw the
 * group into one offscreen target in one pass. After the loop: composite +
 * cursor.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  SliceAggregateParams,
  SliceLayerParams,
  SliceRenderMultiPassMessage,
} from "../workerProtocol.ts";
import type { CompositeLayer } from "../layerCompositor.ts";
import type {
  AggregateBatch,
  AggregateDrawParams,
  LayerGroupDraw,
  MemberDraw,
  SlicePoolBinding,
} from "../sliceRenderer.ts";
import { resolveMemberPools, type EntityDescriptorIndex } from "../descriptorBuffer.ts";
import {
  markLabelSliceFailed,
  type SliceAtlasState,
  type LabelSlicePool,
} from "./atlas.ts";
import { setCameraUVForMember } from "./eviction.ts";
import { flushViewIndirection } from "../viewIndirection.ts";
import { labelSlicePoolKey } from "../labelPools.ts";
import { serializeTransientDescriptor } from "../descriptor/transient.ts";
import { DESCRIPTOR_ENTRY_SIZE } from "../descriptor/layout.ts";
import { packLabelPalette } from "../labelColors.ts";
import { captureRenderedFrame } from "../worker/captureFrame.ts";
import { trimViewLayerTargets } from "../worker/viewResources.ts";
import { beginViewFrame } from "../worker/viewFrame.ts";

const IDENTITY_4X4 = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

/** Default overlay opacity for a label layer that omits one. */
const DEFAULT_LABEL_OPACITY = 0.5;

/** Bytes per aggregate quad record (see `SliceAggregateParams.quads`). */
const AGGREGATE_QUAD_STRIDE_BYTES = 32;

/**
 * The persistent categorical descriptor for a label pool: one level source
 * whose chunk grid is the plane's, each cell at its place in the texture.
 * Rebuilt only when the opacity changes, so scrubbing doesn't allocate per
 * frame.
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
    chunkGrid: {
      gridDims: [pool.grid.x, pool.grid.y, 1],
      chunkDims: [pool.chunkX, pool.chunkY, 1],
    },
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
 * The quad is sized to the source's voxel extent (`layer.dataW/dataH`) and
 * placed at the source member's offset, so a coarser label still covers the
 * same region. Returns null when the pool has no resident slice yet.
 */
function renderLabelLayer(
  ctx: WorkerCtx,
  msg: SliceRenderMultiPassMessage,
  layer: SliceLayerParams,
  targetFor: () => GPUTexture,
): CompositeLayer | null {
  const memberId = layer.datasetId;
  const chunk = layer.labelChunk;
  const pool = chunk && ctx.state.labelSlicePools.get(labelSlicePoolKey(memberId, chunk.t, chunk.plane));
  if (!pool || !chunk) return null;
  const target = targetFor();
  markLabelSliceFailed(ctx, memberId, pool, chunk);

  const descBuffer = ensureLabelDescriptor(ctx, pool, layer.opacity ?? DEFAULT_LABEL_OPACITY);
  const palette = ensureLabelPalette(ctx, pool, layer.labelColors);

  const renderer = ctx.getSliceRenderer();
  const ox = layer.offsetX ?? 0;
  const oy = layer.offsetY ?? 0;
  renderer.setTierAtlases(
    [{ texture: pool.texture, indirectionBuf: pool.indirectionBuf, slotsX: pool.grid.x, slotsY: pool.grid.y }],
    null,
  );
  // Categorical shading computes color from the id in-shader; the LUT is
  // bound (a valid gray ramp) but unread on this path.
  renderer.setColormapTexture(ctx.getOrCreateLUT("gray"));
  renderer.setTransform(msg.zoom, msg.cx - ox, msg.cy - oy, msg.canvasW, msg.canvasH, layer.dataW, layer.dataH);
  renderer.setLabelColorBuffer(palette.buffer);
  renderer.setDescriptorBinding(descBuffer, 0, palette.count);

  const encoder = ctx.device.createCommandEncoder();
  renderer.renderTo(target.createView(), encoder, ctx.passTimer);
  ctx.device.queue.submit([encoder.finish()]);
  return { view: target.createView(), blendMode: layer.blendMode, clip: layer.clip };
}

/**
 * An atlas as the renderer binds it for `view`: the shared texture, read
 * through the view's own indirection, written to the GPU first if it changed.
 */
function poolBinding(ctx: WorkerCtx, atlas: SliceAtlasState, view: number): SlicePoolBinding {
  const indirection = atlas.views.get(view)!;
  flushViewIndirection(ctx.device, indirection);
  return {
    texture: atlas.texture,
    indirectionBuf: indirection.indirectionBuf,
    slotsX: atlas.slotsX,
    slotsY: atlas.slotsY,
  };
}

/** Result of {@link buildAggregateBatches}. */
interface ResolvedAggregate {
  /** Kept quad records, re-packed contiguously in batch order. */
  quadData: ArrayBuffer;
  batches: AggregateBatch[];
}

/**
 * Resolve an aggregate layer's quads against current worker residency.
 *
 * Each quad gets the per-member path's skip rule and camera-UV recency
 * update, so batched members behave like per-member ones. Survivors are
 * grouped by pool binding set, one instanced draw each, because members with
 * different chunk shapes live in different pools and must never sample
 * another pool's indirection. Quads keep roster order within a batch.
 */
function buildAggregateBatches(
  ctx: WorkerCtx,
  msg: SliceRenderMultiPassMessage,
  layer: SliceLayerParams,
  agg: SliceAggregateParams,
  descIndex: EntityDescriptorIndex,
): ResolvedAggregate {
  const atlasMap = ctx.state.sliceAtlases;
  const srcF32 = new Float32Array(agg.quads);
  const srcU32 = new Uint32Array(agg.quads);
  const wordsPerRecord = AGGREGATE_QUAD_STRIDE_BYTES / 4;
  const recordCount = Math.min(
    agg.count,
    Math.floor(agg.quads.byteLength / AGGREGATE_QUAD_STRIDE_BYTES),
  );
  const aggOx = layer.offsetX ?? 0;
  const aggOy = layer.offsetY ?? 0;

  interface PendingBatch {
    levels: Array<SliceAtlasState | null>;
    coarse: SliceAtlasState | null;
    records: number[];
  }
  const batchesByKey = new Map<string, PendingBatch>();
  let kept = 0;

  for (let r = 0; r < recordCount; r++) {
    const entityIndex = srcU32[r * wordsPerRecord + 4];
    const memberId = descIndex.memberByIndex[entityIndex];
    // An index outside the current descriptor build has no defined
    // entry to sample — drop the quad rather than read a stale slot.
    if (memberId === undefined) continue;

    const pools = resolveMemberPools(atlasMap, descIndex, memberId, msg.view);
    const hasDetail = pools.levels.some((atlas) => atlas !== null);
    const hasCoarse = pools.coarse !== null;

    // Residency guard — identical to the per-member skip rule.
    if (!hasDetail && !hasCoarse) continue;

    // Camera-UV recency, as the per-member path keeps it. The member-local
    // UV of the view center follows from the quad rect: rect origin/size are
    // fractions of the layer extent.
    const rx = srcF32[r * wordsPerRecord + 0];
    const ry = srcF32[r * wordsPerRecord + 1];
    const rw = srcF32[r * wordsPerRecord + 2];
    const rh = srcF32[r * wordsPerRecord + 3];
    if (rw > 0 && rh > 0) {
      setCameraUVForMember(ctx.state, msg.view, memberId, [
        (msg.cx - (aggOx + rx * layer.dataW)) / (rw * layer.dataW),
        (msg.cy - (aggOy + ry * layer.dataH)) / (rh * layer.dataH),
      ]);
    }

    const key = [
      pools.levels.map((atlas, i) => (atlas ? pools.levelPoolKeys[i] : "")).join(","),
      pools.coarse ? pools.coarsePoolKey : "",
    ].join("|");
    let batch = batchesByKey.get(key);
    if (!batch) {
      batch = {
        levels: pools.levels,
        coarse: pools.coarse,
        records: [],
      };
      batchesByKey.set(key, batch);
    }
    batch.records.push(r);
    kept++;
  }

  // Word-wise copy is bit-exact for the f32 rect fields.
  const quadData = new ArrayBuffer(kept * AGGREGATE_QUAD_STRIDE_BYTES);
  const dstU32 = new Uint32Array(quadData);
  const batches: AggregateBatch[] = [];
  let write = 0;
  for (const b of batchesByKey.values()) {
    const firstInstance = write;
    for (const r of b.records) {
      dstU32.set(srcU32.subarray(r * wordsPerRecord, (r + 1) * wordsPerRecord), write * wordsPerRecord);
      write++;
    }
    batches.push({
      levels: b.levels.map((atlas) => (atlas ? poolBinding(ctx, atlas, msg.view) : null)),
      coarse: b.coarse ? poolBinding(ctx, b.coarse, msg.view) : null,
      firstInstance,
      count: write - firstInstance,
    });
  }
  return { quadData, batches };
}

/** The view center in a per-member layer's [0,1] coordinates: the slice eviction reference. */
export function memberCameraUV(msg: SliceRenderMultiPassMessage, layer: SliceLayerParams): [number, number] {
  return [
    (msg.cx - (layer.offsetX ?? 0)) / layer.dataW,
    (msg.cy - (layer.offsetY ?? 0)) / layer.dataH,
  ];
}

export async function handleSliceRenderMultiPass(
  ctx: WorkerCtx,
  frame: SliceRenderMultiPassMessage,
): Promise<void> {
  const renderer = ctx.getSliceRenderer();
  const comp = ctx.getCompositor();
  const cr = ctx.getCursorRenderer();
  // The wait holds every message behind this one (`worker/inOrder.ts`).
  await Promise.all([renderer.compiled, comp.compiled, cr.compiled]);

  const target = beginViewFrame(ctx, frame.view, frame.canvasW, frame.canvasH, frame.rect);
  // The view draws in its own pixels, as if its rectangle were the canvas.
  const msg = { ...frame, canvasW: frame.rect[2], canvasH: frame.rect[3] };

  // One target per drawn group, a (dataset, channel), so target memory
  // follows the channel count and not the member count. Grown per drawn
  // group, so a group with nothing resident costs no target.
  const targetFor = (idx: number): GPUTexture =>
    ctx.ensureOffscreenPool(msg.view, idx + 1, msg.canvasW, msg.canvasH)[idx];

  const timing = ctx.passTimer;
  timing.beginFrame();
  renderer.setPixelRatio(msg.pixelRatio ?? 1);

  const renderedLayers: CompositeLayer[] = [];

  for (let start = 0; start < msg.layers.length;) {
    const first = msg.layers[start];
    let end = start + 1;
    if (!first.isLabel && first.passGroup !== undefined) {
      while (
        end < msg.layers.length && !msg.layers[end].isLabel && msg.layers[end].passGroup === first.passGroup
      ) end++;
    }
    const group = msg.layers.slice(start, end);
    start = end;

    // Categorical label overlays render from their own r32uint pool via a
    // transient descriptor, independent of the cold-state chunk pipeline.
    if (first.isLabel) {
      const drawn = renderLabelLayer(ctx, msg, first, () => targetFor(renderedLayers.length));
      if (drawn) renderedLayers.push(drawn);
      continue;
    }

    const draw = buildLayerGroup(ctx, msg, group);
    if (!draw) continue;
    const target = targetFor(renderedLayers.length);
    const encoder = ctx.device.createCommandEncoder();
    renderer.renderLayerGroup(target.createView(), encoder, draw, timing);
    ctx.device.queue.submit([encoder.finish()]);
    renderedLayers.push({ view: target.createView(), blendMode: first.blendMode, clip: first.clip });
  }
  trimViewLayerTargets(ctx, msg.view, renderedLayers.length);

  const canvasView = target.texture.createView();
  const compEncoder = ctx.device.createCommandEncoder();
  comp.composite(canvasView, renderedLayers, compEncoder, true, timing);
  comp.underlayBackground(canvasView, compEncoder, timing);
  ctx.device.queue.submit([compEncoder.finish()]);

  if (cr.hasData()) {
    const cursorEncoder = ctx.device.createCommandEncoder();
    cr.renderSlice(canvasView, cursorEncoder, msg.zoom, msg.cx, msg.cy, msg.canvasW, msg.canvasH, timing);
    ctx.device.queue.submit([cursorEncoder.finish()]);
  }

  timing.endFrame();
  // The frame can be read only here, after its last pass and before the
  // texture expires with this handler. A view that covers part of the canvas
  // reaches it, and is read, when the views are presented.
  if (target.canvasTexture) captureRenderedFrame(ctx, target.canvasTexture);
}

/**
 * Resolve one group's layers against current residency: its aggregate, if
 * any, and each member with something resident. Null when nothing draws.
 */
function buildLayerGroup(
  ctx: WorkerCtx,
  msg: SliceRenderMultiPassMessage,
  layers: SliceLayerParams[],
): LayerGroupDraw | null {
  let aggregate: AggregateDrawParams | null = null;
  const members: MemberDraw[] = [];
  for (const layer of layers) {
    if (layer.aggregate) aggregate = buildAggregateDraw(ctx, msg, layer, layer.aggregate) ?? aggregate;
    else {
      const member = buildMemberDraw(ctx, msg, layer);
      if (member) members.push(member);
    }
  }
  if (!aggregate && members.length === 0) return null;
  return { blendMode: layers[0].blendMode, canvasW: msg.canvasW, canvasH: msg.canvasH, aggregate, members };
}

/**
 * Aggregate layer: every resident batched member in one instanced draw. The
 * descriptor buffer and colormap resolve at draw time, so appearance changes
 * repaint the aggregate in the same frame as per-member layers.
 */
function buildAggregateDraw(
  ctx: WorkerCtx,
  msg: SliceRenderMultiPassMessage,
  layer: SliceLayerParams,
  agg: SliceAggregateParams,
): AggregateDrawParams | null {
  const datasetId = ctx.state.memberToDataset.get(agg.poolMemberId);
  const descIndex = datasetId ? ctx.lookupEntityDescriptor(datasetId, msg.view) : null;
  if (!descIndex) return null;

  const built = buildAggregateBatches(ctx, msg, layer, agg, descIndex);
  if (built.batches.length === 0) return null;

  const colormapName = descIndex.colormapNameByMember.get(agg.poolMemberId) ?? "gray";
  return {
    descriptorBuffer: descIndex.buffer,
    quadData: built.quadData,
    batches: built.batches,
    colormap: ctx.getOrCreateLUT(colormapName),
    zoom: msg.zoom,
    cx: msg.cx - (layer.offsetX ?? 0),
    cy: msg.cy - (layer.offsetY ?? 0),
    dataW: layer.dataW,
    dataH: layer.dataH,
  };
}

/** The target pixels a per-member layer covers, `[x, y, width, height]`, or null when none. */
export function memberScissor(
  msg: SliceRenderMultiPassMessage,
  layer: SliceLayerParams,
): [number, number, number, number] | null {
  const left = ((layer.offsetX ?? 0) - msg.cx) * msg.zoom + msg.canvasW / 2;
  const top = ((layer.offsetY ?? 0) - msg.cy) * msg.zoom + msg.canvasH / 2;
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(msg.canvasW, Math.ceil(left + layer.dataW * msg.zoom));
  const y1 = Math.min(msg.canvasH, Math.ceil(top + layer.dataH * msg.zoom));
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return [x0, y0, x1 - x0, y1 - y0];
}

/** One per-member layer's draw, or null when it has nothing resident or lies off the target. */
function buildMemberDraw(
  ctx: WorkerCtx,
  msg: SliceRenderMultiPassMessage,
  layer: SliceLayerParams,
): MemberDraw | null {
  const memberId = layer.datasetId;
  // The orchestrator's entity index matches the worker's descriptor build
  // because both use canonical iteration order.
  const datasetId = ctx.state.memberToDataset.get(memberId);
  const descIndex = datasetId ? ctx.lookupEntityDescriptor(datasetId, msg.view) : null;
  if (!descIndex) return null;

  const pools = resolveMemberPools(ctx.state.sliceAtlases, descIndex, memberId, msg.view);
  const hasDetail = pools.levels.some((atlas) => atlas !== null);
  const hasCoarse = pools.coarse !== null;

  if (hasDetail || hasCoarse) {
    setCameraUVForMember(ctx.state, msg.view, memberId, memberCameraUV(msg, layer));
  }

  // Anything resident is enough to draw; the shader's sampling chain
  // covers what this member lacks.
  if (!hasDetail && !hasCoarse) return null;
  const scissor = memberScissor(msg, layer);
  if (!scissor) return null;

  // Colormap from descriptor's CPU mirror; contrast/gamma/opacity are
  // read by the shader straight from the descriptor.
  const colormapName = descIndex.colormapNameByMember.get(memberId) ?? "gray";
  return {
    levels: pools.levels.map((atlas) => (atlas ? poolBinding(ctx, atlas, msg.view) : null)),
    coarse: pools.coarse ? poolBinding(ctx, pools.coarse, msg.view) : null,
    colormap: ctx.getOrCreateLUT(colormapName),
    descriptorBuffer: descIndex.buffer,
    entityIndex: layer.entityIndex,
    zoom: msg.zoom,
    cx: msg.cx - (layer.offsetX ?? 0),
    cy: msg.cy - (layer.offsetY ?? 0),
    dataW: layer.dataW,
    dataH: layer.dataH,
    scissor,
  };
}
