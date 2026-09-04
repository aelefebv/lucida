/**
 * Slice render-multipass orchestration.
 *
 * Per layer: resolve member→dataset, look up the descriptor and the
 * pools its level sources and coarse source name, update per-entity
 * camera UV, resolve proxy textures, bind, draw to offscreen. After the
 * loop: composite + cursor.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  SliceAggregateParams,
  SliceLayerParams,
  SliceRenderMultiPassMessage,
} from "../workerProtocol.ts";
import type { CompositeLayer } from "../layerCompositor.ts";
import type { AggregateBatch, SlicePoolBinding } from "../sliceRenderer.ts";
import { resolveMemberPools, type EntityDescriptorIndex } from "../descriptorBuffer.ts";
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

/** Bytes per aggregate quad record (see `SliceAggregateParams.quads`). */
const AGGREGATE_QUAD_STRIDE_BYTES = 32;

/**
 * The persistent categorical descriptor for a label pool. Built once (and
 * refreshed only when the opacity changes) rather than allocated per frame,
 * so scrubbing stays smooth. One level source (grid 1×1) covering the whole
 * tile.
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
 * so a descriptor with one level source (grid 1×1) reads it directly. The
 * quad is sized to the SOURCE's voxel extent (`layer.dataW/dataH`, from
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
  renderer.setTierAtlases(
    [{ texture: pool.texture, indirectionBuf: pool.indirectionBuf, slotsX: 1, slotsY: 1 }],
    null,
  );
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

/** An atlas as the renderer binds it. */
function poolBinding(atlas: SliceAtlasState): SlicePoolBinding {
  return {
    texture: atlas.texture,
    indirectionBuf: atlas.indirectionBuf,
    slotsX: atlas.slotsX,
    slotsY: atlas.slotsY,
  };
}

/** Result of {@link buildAggregateBatches}. */
interface ResolvedAggregate {
  /** Kept quad records, re-packed contiguously in batch order. */
  quadData: ArrayBuffer;
  batches: AggregateBatch[];
  /** Chunk atlases any batch binds — for pre-draw indirection flushes. */
  atlases: Set<SliceAtlasState>;
}

/**
 * Resolve an aggregate layer's quads against CURRENT worker residency.
 *
 * Per quad (via the record's entity index → memberId through the
 * descriptor index):
 *   - apply the SAME skip rule as the per-member path — a member with no
 *     level pool holding a section for it, no coarse section, and no
 *     resident proxy draws nothing (its quad is dropped), so an empty
 *     store renders empty instead of a grid of border frames;
 *   - update the member's camera-UV eviction recency exactly as the
 *     per-member path does for chunk-backed members, so batched members'
 *     resident chunks age fairly under eviction pressure;
 *   - group the survivors by their pool BINDING SET (level pools in slot
 *     order, coarse pool, tile-proxy pool, group-proxy pool). One
 *     instanced draw per distinct binding set gives every member the
 *     same resources the per-member pass would have bound — members of
 *     heterogeneous chunk shapes/pyramid depths live in different pools
 *     and must never sample another pool's indirection ranges.
 *
 * Batch count is bounded by the number of distinct pool-binding sets in
 * the dataset (few — pools are keyed by (tier, channel, chunk dims)),
 * not by member count. Quads keep their incoming (roster) order within
 * each batch; batches are emitted in first-seen roster order.
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
    tileProxyTexture: GPUTexture | null;
    groupProxyTexture: GPUTexture | null;
    records: number[];
  }
  const batchesByKey = new Map<string, PendingBatch>();
  const atlases = new Set<SliceAtlasState>();
  let kept = 0;

  for (let r = 0; r < recordCount; r++) {
    const entityIndex = srcU32[r * wordsPerRecord + 4];
    const memberId = descIndex.memberByIndex[entityIndex];
    // An index outside the current descriptor build has no defined
    // entry to sample — drop the quad rather than read a stale slot.
    if (memberId === undefined) continue;

    const pools = resolveMemberPools(atlasMap, descIndex, memberId);
    const hasDetail = pools.levels.some((atlas) => atlas !== null);
    const hasCoarse = pools.coarse !== null;

    const desc = descIndex.proxyDescriptorByMember.get(memberId) ?? null;
    let tileProxyTexture: GPUTexture | null = null;
    let tileProxyPoolKey: string | null = null;
    let groupProxyTexture: GPUTexture | null = null;
    let groupProxyPoolKey: string | null = null;
    if (desc?.tileProxyHandle) {
      const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.tileProxyHandle.poolKey);
      if (poolIdx !== undefined) {
        tileProxyTexture = descIndex.proxyPoolsByIndex[poolIdx].texture;
        tileProxyPoolKey = desc.tileProxyHandle.poolKey;
      }
    }
    if (desc?.groupProxyHandle) {
      const poolIdx = descIndex.proxyPoolIndexByKey.get(desc.groupProxyHandle.poolKey);
      if (poolIdx !== undefined) {
        groupProxyTexture = descIndex.proxyPoolsByIndex[poolIdx].texture;
        groupProxyPoolKey = desc.groupProxyHandle.poolKey;
      }
    }

    // Residency guard — identical to the per-member skip rule.
    if (!hasDetail && !hasCoarse && !tileProxyTexture && !groupProxyTexture) continue;

    // Camera-UV recency, chunk-backed members only (per-member parity).
    // The member-local UV of the view center follows from the quad rect:
    // rect origin/size are fractions of the layer extent.
    if (hasDetail || hasCoarse) {
      const rx = srcF32[r * wordsPerRecord + 0];
      const ry = srcF32[r * wordsPerRecord + 1];
      const rw = srcF32[r * wordsPerRecord + 2];
      const rh = srcF32[r * wordsPerRecord + 3];
      if (rw > 0 && rh > 0) {
        setCameraUVForMember(ctx.state, memberId, [
          (msg.cx - (aggOx + rx * layer.dataW)) / (rw * layer.dataW),
          (msg.cy - (aggOy + ry * layer.dataH)) / (rh * layer.dataH),
        ]);
      }
    }

    for (const atlas of pools.levels) if (atlas) atlases.add(atlas);
    if (pools.coarse) atlases.add(pools.coarse);
    const key = [
      pools.levels.map((atlas, i) => (atlas ? pools.levelPoolKeys[i] : "")).join(","),
      pools.coarse ? pools.coarsePoolKey : "",
      tileProxyPoolKey ?? "",
      groupProxyPoolKey ?? "",
    ].join("|");
    let batch = batchesByKey.get(key);
    if (!batch) {
      batch = {
        levels: pools.levels,
        coarse: pools.coarse,
        tileProxyTexture,
        groupProxyTexture,
        records: [],
      };
      batchesByKey.set(key, batch);
    }
    batch.records.push(r);
    kept++;
  }

  // Re-pack kept records contiguously in batch order (word-wise copy is
  // bit-exact for the f32 rect fields).
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
      levels: b.levels.map((atlas) => (atlas ? poolBinding(atlas) : null)),
      coarse: b.coarse ? poolBinding(b.coarse) : null,
      tileProxyTexture: b.tileProxyTexture,
      groupProxyTexture: b.groupProxyTexture,
      firstInstance,
      count: write - firstInstance,
    });
  }
  return { quadData, batches, atlases };
}

export function handleSliceRenderMultiPass(
  ctx: WorkerCtx,
  msg: SliceRenderMultiPassMessage,
): void {
  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = msg.canvasW;
  canvas.height = msg.canvasH;

  const renderer = ctx.getSliceRenderer();
  const comp = ctx.getCompositor();
  // Offscreen targets are canvas-sized; grow the pool per RENDERED
  // layer, not per posted layer, so skipped layers never cost a target
  // allocation. (Growing one at a time re-checks dims only — cheap.)
  const targetFor = (idx: number): GPUTexture =>
    ctx.ensureOffscreenPool(idx + 1, msg.canvasW, msg.canvasH)[idx];
  const atlasMap = ctx.state.sliceAtlases;

  const renderedLayers: CompositeLayer[] = [];

  for (const layer of msg.layers) {
    const memberId = layer.datasetId;

    // Categorical label overlays render from their own r32uint pool via a
    // transient descriptor, independent of the cold-state chunk pipeline.
    if (layer.isLabel) {
      const drawn = renderLabelLayer(ctx, msg, layer, targetFor(renderedLayers.length));
      if (drawn) renderedLayers.push(drawn);
      continue;
    }

    // Aggregate layer: every RESIDENT batched member, drawn in ONE
    // render pass with one instanced draw per pool-binding sub-batch.
    // The descriptor buffer + colormap resolve at DRAW time from the
    // current worker state, so appearance changes (contrast, gamma,
    // opacity, colormap) repaint the aggregate the same frame they
    // repaint per-member layers; each quad samples its own descriptor
    // entry in-shader.
    if (layer.aggregate) {
      const agg = layer.aggregate;
      const datasetId = ctx.state.memberToDataset.get(agg.poolMemberId);
      const descIndex = datasetId ? ctx.lookupEntityDescriptor(datasetId) : null;
      if (!descIndex) continue;

      const built = buildAggregateBatches(ctx, msg, layer, agg, descIndex);
      // Nothing resident for any batched member: skip the layer, the
      // same way the per-member guard skips each member.
      if (built.batches.length === 0) continue;

      for (const atlas of built.atlases) {
        if (atlas.indirectionDirty) {
          ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
          atlas.indirectionDirty = false;
        }
      }

      const colormapName = descIndex.colormapNameByMember.get(agg.poolMemberId) ?? "gray";
      renderer.setColormapTexture(ctx.getOrCreateLUT(colormapName));

      const aggIdx = renderedLayers.length;
      const aggTarget = targetFor(aggIdx);
      const aggEncoder = ctx.device.createCommandEncoder();
      renderer.renderAggregateBatches(aggTarget.createView(), aggEncoder, {
        descriptorBuffer: descIndex.buffer,
        quadData: built.quadData,
        batches: built.batches,
        blendMode: layer.blendMode,
        zoom: msg.zoom,
        cx: msg.cx - (layer.offsetX ?? 0),
        cy: msg.cy - (layer.offsetY ?? 0),
        canvasW: msg.canvasW,
        canvasH: msg.canvasH,
        dataW: layer.dataW,
        dataH: layer.dataH,
      });
      ctx.device.queue.submit([aggEncoder.finish()]);
      renderedLayers.push({ view: aggTarget.createView(), blendMode: layer.blendMode });
      continue;
    }

    // Per-dataset descriptor + entity index (orchestrator-computed;
    // converges with the worker's descriptor build by canonical
    // iteration order).
    const datasetId = ctx.state.memberToDataset.get(memberId);
    const descIndex = datasetId ? ctx.lookupEntityDescriptor(datasetId) : null;
    if (!descIndex) continue;
    const entityIndex = layer.entityIndex;

    const pools = resolveMemberPools(atlasMap, descIndex, memberId);
    const hasDetail = pools.levels.some((atlas) => atlas !== null);
    const hasCoarse = pools.coarse !== null;

    const ox = layer.offsetX ?? 0;
    const oy = layer.offsetY ?? 0;
    if (hasDetail || hasCoarse) {
      setCameraUVForMember(ctx.state, memberId, [
        (msg.cx - ox) / layer.dataW,
        (msg.cy - oy) / layer.dataH,
      ]);
    }

    const idx = renderedLayers.length;

    for (const atlas of [...pools.levels, pools.coarse]) {
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

    // Anything resident is enough to draw; the shader's sampling chain
    // covers what this member lacks.
    if (!hasDetail && !hasCoarse && !tileProxySlotResident && !groupProxySlotResident) continue;

    renderer.setProxyTextures(tileProxyTexture, groupProxyTexture);

    renderer.setTierAtlases(
      pools.levels.map((atlas) => (atlas ? poolBinding(atlas) : null)),
      pools.coarse ? poolBinding(pools.coarse) : null,
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
    const layerTarget = targetFor(idx);
    const layerEncoder = ctx.device.createCommandEncoder();
    renderer.renderTo(layerTarget.createView(), layerEncoder);
    ctx.device.queue.submit([layerEncoder.finish()]);
    renderedLayers.push({ view: layerTarget.createView(), blendMode: layer.blendMode });
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
