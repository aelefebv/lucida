/**
 * Slice render-multipass orchestration.
 *
 * Per layer: resolve member→pool→datasetId, look up descriptor + atlas,
 * compute residency, update per-entity camera UV, bind the detail/coarse
 * atlases, and draw to offscreen. After the loop: composite + cursor.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  SliceAggregateParams,
  SliceLayerParams,
  SliceRenderMultiPassMessage,
} from "../workerProtocol.ts";
import type { CompositeLayer } from "../layerCompositor.ts";
import type { LodIndirectionMeta } from "../volume/atlas.ts";
import type { AggregateBatch } from "../sliceRenderer.ts";
import type { EntityDescriptorIndex } from "../descriptorBuffer.ts";
import {
  type SliceAtlasState,
  type LabelSlicePool,
  labelSlicePoolMatchesEpochs,
} from "./atlas.ts";
import { setCameraUVForMember } from "./eviction.ts";
import {
  aggregateTopologyGeneration,
  type AggregateCameraView,
  type AggregateQuadCacheEntry,
  type ResolvedAggregateTopology,
} from "../worker/state.ts";
import { serializeTransientDescriptor } from "../descriptor/transient.ts";
import { DESCRIPTOR_ENTRY_SIZE } from "../descriptor/layout.ts";
import { packLabelPalette } from "../labelColors.ts";
import { DEFAULT_LABEL_OPACITY } from "../../labelSettings.ts";
import { admitWorkerRenderSurface } from "../worker/surface.ts";
import { labelPoolKey } from "../labelPoolKey.ts";

const IDENTITY_4X4 = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

/** Bytes per aggregate quad record (see `SliceAggregateParams.quads`). */
const AGGREGATE_QUAD_STRIDE_BYTES = 32;

/**
 * Resolve publish-once aggregate geometry. A non-empty keyed buffer replaces
 * the prior entry in the same dataset/channel slot; an empty keyed buffer is a
 * reference to the already-published entry. Unkeyed buffers keep the legacy
 * one-message lifetime used by focused callers/tests.
 */
interface ResolvedAggregateGeometry {
  quads: ArrayBuffer;
  cacheKey: string | null;
  entry: AggregateQuadCacheEntry | null;
}

function clearResolvedAggregateCameraMappings(
  ctx: WorkerCtx,
  cacheKey: string,
  entry: AggregateQuadCacheEntry,
): void {
  const resolved = entry.resolved;
  if (!resolved) return;
  for (const memberId of resolved.cameraMemberIds) {
    if (ctx.state.aggregateCameraByMember.get(memberId)?.cacheKey === cacheKey) {
      ctx.state.aggregateCameraByMember.delete(memberId);
    }
  }
  entry.resolved = undefined;
}

function deleteAggregateQuadCacheEntry(ctx: WorkerCtx, cacheKey: string): void {
  const entry = ctx.state.aggregateQuadCache.get(cacheKey);
  if (!entry) return;
  clearResolvedAggregateCameraMappings(ctx, cacheKey, entry);
  ctx.state.aggregateQuadCache.delete(cacheKey);
  if (ctx.state.aggregateKeyByOwner.get(entry.ownerKey) === cacheKey) {
    ctx.state.aggregateKeyByOwner.delete(entry.ownerKey);
  }
}

function resolveAggregateGeometry(
  ctx: WorkerCtx,
  aggregate: SliceAggregateParams,
): ResolvedAggregateGeometry | null {
  const key = aggregate.cacheKey;
  if (!key) {
    return { quads: aggregate.quads, cacheKey: null, entry: null };
  }
  if (aggregate.quads.byteLength === 0) {
    const entry = ctx.state.aggregateQuadCache.get(key);
    return entry ? { quads: entry.quads, cacheKey: key, entry } : null;
  }

  const ownerKey = aggregate.cacheOwnerKey;
  const ownerDatasetId = aggregate.ownerDatasetId;
  const superseded = ctx.state.aggregateKeyByOwner.get(ownerKey);
  if (superseded && superseded !== key) {
    deleteAggregateQuadCacheEntry(ctx, superseded);
  }
  // Republishing a key replaces its old topology as well as its raw bytes.
  deleteAggregateQuadCacheEntry(ctx, key);
  const entry: AggregateQuadCacheEntry = {
    ownerDatasetId,
    ownerKey,
    quads: aggregate.quads,
  };
  ctx.state.aggregateQuadCache.set(key, entry);
  ctx.state.aggregateKeyByOwner.set(ownerKey, key);
  return { quads: aggregate.quads, cacheKey: key, entry };
}

export function removeAggregateQuadCacheForDataset(
  ctx: WorkerCtx,
  datasetId: string,
): void {
  for (const [key, cached] of [...ctx.state.aggregateQuadCache]) {
    if (cached.ownerDatasetId === datasetId) {
      deleteAggregateQuadCacheEntry(ctx, key);
    }
  }
  ctx.state.aggregateTopologyGenerationByDataset.delete(datasetId);
}

export function clearAggregateQuadCache(ctx: WorkerCtx): void {
  for (const key of [...ctx.state.aggregateQuadCache.keys()]) {
    deleteAggregateQuadCacheEntry(ctx, key);
  }
  ctx.state.aggregateKeyByOwner.clear();
  ctx.state.aggregateTopologyGenerationByDataset.clear();
}

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
    pool.descAllocation = ctx.gpuResources.createBuffer(
      ctx.device,
      {
        key: `label-slice:${labelPoolKey(pool.datasetId, pool.memberId)}:descriptor`,
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
  pool.labelColorAllocation?.destroy();
  if (!pool.labelColorAllocation) pool.labelColorBuffer?.destroy();
  pool.labelColorAllocation = undefined;
  pool.labelColorBuffer = undefined;
  if (packed && count > 0) {
    pool.labelColorAllocation = ctx.gpuResources.createBuffer(
      ctx.device,
      {
        key: `label-slice:${labelPoolKey(pool.datasetId, pool.memberId)}:palette:${count}`,
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
  if (!layer.ownerDatasetId) return null;
  const pool = ctx.state.labelSlicePools.get(
    labelPoolKey(layer.ownerDatasetId, memberId),
  );
  if (!pool || !labelSlicePoolMatchesEpochs(pool, msg.epochs)) return null;

  const descBuffer = ensureLabelDescriptor(ctx, pool, layer.opacity ?? DEFAULT_LABEL_OPACITY);
  const palette = ensureLabelPalette(ctx, pool, layer.labelColors);

  const renderer = ctx.getSliceRenderer();
  const ox = layer.offsetX ?? 0;
  const oy = layer.offsetY ?? 0;
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

interface AggregateCameraRecord {
  memberId: string;
  rect: readonly [x: number, y: number, width: number, height: number];
}

/** Result of {@link buildAggregateBatches}. */
interface BuiltAggregate {
  /** Kept quad records, re-packed contiguously in batch order. */
  quadData: ArrayBuffer;
  batches: AggregateBatch[];
  /** Chunk atlases any batch binds — for pre-draw indirection flushes. */
  atlases: Set<SliceAtlasState>;
  /** Resident members used to install lazy camera lookups on cache rebuild. */
  cameraRecords: AggregateCameraRecord[];
}

/**
 * Resolve an aggregate layer's quads against CURRENT worker residency.
 *
 * Per quad (via the record's entity index → memberId through the
 * descriptor index):
 *   - apply the SAME skip rule as the per-member path — a member with no
 *     detail metas and no coarse metas draws nothing
 *     (its quad is dropped), so an empty store renders empty instead of
 *     a grid of border frames;
 *   - update the member's camera-UV eviction recency exactly as the
 *     per-member path does for chunk-backed members, so batched members'
 *     resident chunks age fairly under eviction pressure;
 *   - group the survivors by their pool BINDING SET (detail and coarse
 *     pools). One instanced draw per
 *     distinct binding set gives every member the same resources the
 *     per-member pass would have bound — members of heterogeneous chunk
 *     shapes/pyramid depths live in different pools and must never
 *     sample another pool's indirection ranges.
 *
 * Batch count is bounded by the number of distinct pool-binding sets in
 * the dataset (few — pools are keyed by (tier, channel, chunk dims)),
 * not by member count. Quads keep their incoming (roster) order within
 * each batch; batches are emitted in first-seen roster order.
 */
function buildAggregateBatches(
  ctx: WorkerCtx,
  agg: SliceAggregateParams,
  quads: ArrayBuffer,
  descIndex: EntityDescriptorIndex,
  layerToPool: (memberId: string) => {
    detailPoolKey: string | null;
    coarsePoolKey: string | null;
    datasetId: string | null;
  } | null,
): BuiltAggregate {
  const atlasMap = ctx.state.sliceAtlases;
  const srcF32 = new Float32Array(quads);
  const srcU32 = new Uint32Array(quads);
  const wordsPerRecord = AGGREGATE_QUAD_STRIDE_BYTES / 4;
  const recordCount = Math.min(
    agg.count,
    Math.floor(quads.byteLength / AGGREGATE_QUAD_STRIDE_BYTES),
  );

  interface PendingBatch {
    detail: SliceAtlasState | null;
    detailPoolKey: string | null;
    coarse: SliceAtlasState | null;
    coarsePoolKey: string | null;
    records: number[];
  }
  const batchesByKey = new Map<string, PendingBatch>();
  const atlases = new Set<SliceAtlasState>();
  const cameraRecords: AggregateCameraRecord[] = [];
  let kept = 0;

  for (let r = 0; r < recordCount; r++) {
    const entityIndex = srcU32[r * wordsPerRecord + 4];
    const memberId = descIndex.memberByIndex[entityIndex];
    // An index outside the current descriptor build has no defined
    // entry to sample — drop the quad rather than read a stale slot.
    if (memberId === undefined) continue;
    const resolved = layerToPool(memberId);
    if (!resolved) continue;

    const detailAtlas = resolved.detailPoolKey
      ? atlasMap.get(resolved.detailPoolKey) ?? null
      : null;
    const coarseAtlas = resolved.coarsePoolKey
      ? atlasMap.get(resolved.coarsePoolKey) ?? null
      : null;
    const detailMetas: LodIndirectionMeta[] | null =
      detailAtlas?.entityMetas.get(memberId) ?? null;
    const coarseMetas: LodIndirectionMeta[] | null =
      coarseAtlas?.entityMetas.get(memberId) ?? null;
    const hasDetail = detailMetas != null && detailMetas.length > 0;
    const hasCoarse = coarseMetas != null && coarseMetas.length > 0;

    // Residency guard — identical to the per-member skip rule.
    if (!hasDetail && !hasCoarse) continue;

    const rx = srcF32[r * wordsPerRecord + 0];
    const ry = srcF32[r * wordsPerRecord + 1];
    const rw = srcF32[r * wordsPerRecord + 2];
    const rh = srcF32[r * wordsPerRecord + 3];
    if (rw > 0 && rh > 0) {
      cameraRecords.push({ memberId, rect: [rx, ry, rw, rh] });
    }

    const effDetail = hasDetail ? detailAtlas : null;
    const effCoarse = hasCoarse ? coarseAtlas : null;
    if (effDetail) atlases.add(effDetail);
    if (effCoarse) atlases.add(effCoarse);
    const key = [
      effDetail ? resolved.detailPoolKey : "",
      effCoarse ? resolved.coarsePoolKey : "",
    ].join("|");
    let batch = batchesByKey.get(key);
    if (!batch) {
      batch = {
        detail: effDetail,
        detailPoolKey: effDetail ? resolved.detailPoolKey : null,
        coarse: effCoarse,
        coarsePoolKey: effCoarse ? resolved.coarsePoolKey : null,
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
    const toBinding = (atlas: SliceAtlasState | null) =>
      atlas
        ? {
            texture: atlas.texture,
            indirectionBuf: atlas.indirectionBuf,
            slotsX: atlas.slotsX,
            slotsY: atlas.slotsY,
          }
        : null;
    batches.push({
      detail: toBinding(b.detail),
      coarse: toBinding(b.coarse),
      firstInstance,
      count: write - firstInstance,
    });
  }
  return { quadData, batches, atlases, cameraRecords };
}

function updateAggregateCameraView(
  view: AggregateCameraView,
  msg: SliceRenderMultiPassMessage,
  layer: SliceLayerParams,
): void {
  view.cx = msg.cx;
  view.cy = msg.cy;
  view.offsetX = layer.offsetX ?? 0;
  view.offsetY = layer.offsetY ?? 0;
  view.dataW = layer.dataW;
  view.dataH = layer.dataH;
}

function installResolvedAggregateTopology(
  ctx: WorkerCtx,
  cacheKey: string,
  entry: AggregateQuadCacheEntry,
  generation: number,
  descriptor: EntityDescriptorIndex,
  built: BuiltAggregate,
  msg: SliceRenderMultiPassMessage,
  layer: SliceLayerParams,
): ResolvedAggregateTopology {
  clearResolvedAggregateCameraMappings(ctx, cacheKey, entry);
  const cameraView: AggregateCameraView = {
    cx: 0,
    cy: 0,
    offsetX: 0,
    offsetY: 0,
    dataW: 0,
    dataH: 0,
  };
  updateAggregateCameraView(cameraView, msg, layer);
  const cameraMemberIds: string[] = [];
  for (const record of built.cameraRecords) {
    ctx.state.aggregateCameraByMember.set(record.memberId, {
      cacheKey,
      rect: record.rect,
      view: cameraView,
    });
    cameraMemberIds.push(record.memberId);
  }
  const resolved: ResolvedAggregateTopology = {
    generation,
    descriptor,
    quadData: built.quadData,
    batches: built.batches,
    atlases: built.atlases,
    cameraView,
    cameraMemberIds,
  };
  entry.resolved = resolved;
  return resolved;
}

function updateUncachedAggregateCameraUVs(
  ctx: WorkerCtx,
  records: AggregateCameraRecord[],
  msg: SliceRenderMultiPassMessage,
  layer: SliceLayerParams,
): void {
  const offsetX = layer.offsetX ?? 0;
  const offsetY = layer.offsetY ?? 0;
  for (const { memberId, rect: [rx, ry, rw, rh] } of records) {
    setCameraUVForMember(ctx.state, memberId, [
      (msg.cx - (offsetX + rx * layer.dataW)) / (rw * layer.dataW),
      (msg.cy - (offsetY + ry * layer.dataH)) / (rh * layer.dataH),
    ]);
  }
}

export function handleSliceRenderMultiPass(
  ctx: WorkerCtx,
  incoming: SliceRenderMultiPassMessage,
  layerToPool: (memberId: string) => {
    detailPoolKey: string | null;
    coarsePoolKey: string | null;
    datasetId: string | null;
  } | null,
): boolean {
  const surface = admitWorkerRenderSurface(
    ctx,
    incoming.canvasW,
    incoming.canvasH,
  );
  if (!surface) return false;
  const msg: SliceRenderMultiPassMessage = {
    ...incoming,
    canvasW: surface.width,
    canvasH: surface.height,
  };

  // Resolve every aggregate reference before touching the canvas. A cache miss
  // aborts the whole frame so consumers never observe or acknowledge a partial
  // composition; the main thread drops its stale residency belief and retries
  // with the canonical geometry buffer.
  const aggregateGeometryByLayer = new Map<SliceLayerParams, ResolvedAggregateGeometry>();
  const reportedMisses = new Set<string>();
  let complete = true;
  for (const layer of msg.layers) {
    const aggregate = layer.aggregate;
    if (!aggregate) continue;
    const geometry = resolveAggregateGeometry(ctx, aggregate);
    if (geometry) {
      aggregateGeometryByLayer.set(layer, geometry);
      continue;
    }
    // Uncached geometry is returned directly above, so only the cached arm of
    // the protocol union can reach a miss.
    if (!aggregate.cacheKey) continue;
    complete = false;
    if (!reportedMisses.has(aggregate.cacheKey)) {
      reportedMisses.add(aggregate.cacheKey);
      ctx.post({
        type: "aggregateCacheMiss",
        frameId: msg.frameId,
        cacheKey: aggregate.cacheKey,
        cacheOwnerKey: aggregate.cacheOwnerKey,
        ownerDatasetId: aggregate.ownerDatasetId,
      });
    }
  }
  if (!complete) return false;

  const canvas = ctx.context.canvas as OffscreenCanvas;
  canvas.width = msg.canvasW;
  canvas.height = msg.canvasH;

  const renderer = ctx.getSliceRenderer();
  const comp = ctx.getCompositor();
  // Render and composite one layer at a time into the canvas. A previous
  // implementation retained one full-canvas rgba16float target per rendered
  // layer (8 bytes/pixel each), so a 256-layer view could request tens of GiB.
  // Incremental compositing preserves draw order/blend semantics while keeping
  // the reusable target pool bounded at exactly one texture.
  const target = ctx.ensureOffscreenPool(1, msg.canvasW, msg.canvasH)[0];
  const canvasView = ctx.context.getCurrentTexture().createView();
  let isFirstLayer = true;
  const compositeLayer = (layer: CompositeLayer): void => {
    const encoder = ctx.device.createCommandEncoder();
    comp.composite(canvasView, [layer], encoder, isFirstLayer);
    ctx.device.queue.submit([encoder.finish()]);
    isFirstLayer = false;
  };
  const atlasMap = ctx.state.sliceAtlases;

  for (const layer of msg.layers) {
    const memberId = layer.datasetId;

    // Categorical label overlays render from their own r32uint pool via a
    // transient descriptor, independent of the cold-state chunk pipeline.
    if (layer.isLabel) {
      const drawn = renderLabelLayer(ctx, msg, layer, target);
      if (drawn) compositeLayer(drawn);
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
      const geometry = aggregateGeometryByLayer.get(layer)!;
      const resolved = layerToPool(agg.poolMemberId);
      if (!resolved || !resolved.datasetId) continue;
      const descIndex = ctx.lookupEntityDescriptor(resolved.datasetId);
      if (!descIndex) continue;

      let topology: Pick<ResolvedAggregateTopology, "quadData" | "batches" | "atlases">;
      const cached = geometry.entry?.resolved;
      const generation = geometry.entry
        ? aggregateTopologyGeneration(ctx.state, geometry.entry.ownerDatasetId)
        : 0;
      if (
        cached &&
        cached.generation === generation &&
        cached.descriptor === descIndex
      ) {
        // Camera-only frames mutate one shared transform. Per-member eviction
        // UV is derived lazily when upload pressure asks for it.
        updateAggregateCameraView(cached.cameraView, msg, layer);
        topology = cached;
      } else {
        const built = buildAggregateBatches(
          ctx,
          agg,
          geometry.quads,
          descIndex,
          layerToPool,
        );
        if (geometry.entry && geometry.cacheKey) {
          topology = installResolvedAggregateTopology(
            ctx,
            geometry.cacheKey,
            geometry.entry,
            generation,
            descIndex,
            built,
            msg,
            layer,
          );
        } else {
          updateUncachedAggregateCameraUVs(ctx, built.cameraRecords, msg, layer);
          topology = built;
        }
      }
      // Nothing resident for any batched member: skip the layer, the
      // same way the per-member guard skips each member.
      if (topology.batches.length === 0) continue;

      for (const atlas of topology.atlases) {
        if (atlas.indirectionDirty) {
          ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
          atlas.indirectionDirty = false;
        }
      }

      const colormapName = descIndex.colormapNameByMember.get(agg.poolMemberId) ?? "gray";
      renderer.setColormapTexture(ctx.getOrCreateLUT(colormapName));

      const aggEncoder = ctx.device.createCommandEncoder();
      renderer.renderAggregateBatches(target.createView(), aggEncoder, {
        descriptorBuffer: descIndex.buffer,
        quadData: topology.quadData,
        batches: topology.batches,
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
      compositeLayer({ view: target.createView(), blendMode: layer.blendMode });
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

    for (const atlas of [detailAtlas, coarseAtlas]) {
      if (atlas && atlas.indirectionDirty) {
        ctx.device.queue.writeBuffer(atlas.indirectionBuf, 0, atlas.indirectionData);
        atlas.indirectionDirty = false;
      }
    }

    // Skip when neither chunk tier has anything renderable.
    if (!hasDetail && !hasCoarse) continue;

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
    renderer.renderTo(target.createView(), layerEncoder);
    ctx.device.queue.submit([layerEncoder.finish()]);
    compositeLayer({ view: target.createView(), blendMode: layer.blendMode });
  }

  // Even an empty view must clear stale pixels from the previous frame.
  if (isFirstLayer) {
    const clearEncoder = ctx.device.createCommandEncoder();
    comp.composite(canvasView, [], clearEncoder);
    ctx.device.queue.submit([clearEncoder.finish()]);
  }

  const cr = ctx.getCursorRenderer();
  if (cr.hasData()) {
    const cursorEncoder = ctx.device.createCommandEncoder();
    cr.renderSlice(canvasView, cursorEncoder, msg.zoom, msg.cx, msg.cy, msg.canvasW, msg.canvasH);
    ctx.device.queue.submit([cursorEncoder.finish()]);
  }
  return true;
}
