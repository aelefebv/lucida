/**
 * Slice chunk upload — staleness check, Z-slice filter, LRU eviction,
 * GPU write, intensity sampling, and per-member post-message demux.
 *
 * Manages `staleSliceKeys` on the atlas (cleared as fresh chunks land
 * for the new target Z). See `slice/zRetarget.ts` for the helper
 * function this module pairs with.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  LabelSliceChunkDataMessage,
  SliceChunkDataMessage,
} from "../workerProtocol.ts";
import { writeSliceRegion } from "../gpuContext.ts";
import { sampleIntensityRange } from "../../zarr/intensitySampler.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import { isStaleDelivery } from "../epochCheck.ts";
import { asUint16Slice, asUint32Slice } from "../dataTypeUtil.ts";
import { parseCompositeKey, makeCompositeKey } from "../chunkKeys.ts";
import { postChunksRejected, postChunksRequeued } from "../chunkUploadFeedback.ts";
import { chunkAllowedByCurrentRenderRadius } from "../chunkRadius.ts";
import { cameraUVForMember, chunkDistSq2D, findFarthestSlot2D } from "./eviction.ts";
import { getOrCreateLabelSlicePool } from "./atlas.ts";
import { assertChunkBufferLength } from "../../chunkContract.ts";

/**
 * Write pre-sliced uint32 label planes into the member's r32uint label
 * pool. The delivery path (`dispatchLabelChunkDelivery`) already extracted
 * the single Z-plane for the current view, so each `chunk.data` is a 2D
 * plane of `chunkY*chunkX` ids (~64 KB, not the full ~8 MB 3D chunk) — this
 * just places it at the chunk's `(x, y)` offset. The allocation is reused in
 * place across Z/T scrubs, while epoch ownership keeps old pixels hidden and
 * clears stale coverage before a partial refresh. Ids stay at full 32-bit
 * width — no intensity-range sampling (categorical, not scalar). Writes are
 * clamped to the (possibly device-limited) texture.
 */
export function handleLabelSliceChunkData(
  ctx: WorkerCtx,
  msg: LabelSliceChunkDataMessage,
): void {
  // Drop an out-of-date delivery (e.g. a previous timepoint's plane racing
  // in after the view moved on) so it can't overwrite the pool with the
  // wrong T/Z — same stale guard the intensity path uses.
  if (isStaleDelivery(msg.epochs, ctx.state.currentEpochs)) return;

  const { memberId, datasetId, levelWidth, levelHeight, chunkX, chunkY } = msg;

  // Returns null if the texture can't be allocated — skip the label rather
  // than throw through the upload path (defense in depth; level selection
  // already bounds the size).
  const pool = getOrCreateLabelSlicePool(ctx, memberId, datasetId, levelWidth, levelHeight);
  if (!pool) return;

  const selectionChanged =
    pool.residentContentEpoch !== msg.epochs.content ||
    pool.residentSelectionEpoch !== msg.epochs.selection;
  if (selectionChanged) {
    // A label slice uses one monolithic texture rather than per-chunk
    // indirection. Clear only the regions the prior selection wrote before a
    // partial current delivery lands, otherwise untouched tiles would retain
    // categorical ids from the old T/Z.
    for (const region of pool.writtenRegions.values()) {
      writeSliceRegion(
        ctx.device,
        pool.texture,
        new Uint32Array(region.width * region.height),
        region.width,
        region.x,
        region.y,
        region.width,
        region.height,
        "r32uint",
      );
    }
    pool.writtenRegions.clear();
    pool.residentContentEpoch = undefined;
    pool.residentSelectionEpoch = undefined;
  }

  let wrote = false;
  for (const chunk of msg.chunks) {
    assertChunkBufferLength(chunk.data, chunk.contract, "worker");
    if (chunk.contract.role !== "label" || chunk.contract.dtype !== "uint32") {
      throw new Error(`label slice chunk ${chunk.key} has a non-label contract`);
    }
    if (chunk.contract.datasetId !== datasetId || chunk.contract.channel !== msg.c) {
      throw new Error(`label slice chunk ${chunk.key} contract identity mismatch`);
    }
    const xOff = chunk.x * chunkX;
    const yOff = chunk.y * chunkY;
    // Clamp to the resident texture (dims may be device-limited below the
    // requested level); skip tiles that fall entirely outside it.
    if (xOff >= pool.width || yOff >= pool.height) continue;
    const chunkW = Math.min(chunkX, pool.width - xOff);
    const chunkH = Math.min(chunkY, pool.height - yOff);
    if (chunkW <= 0 || chunkH <= 0) continue;
    const plane = asUint32Slice(chunk.data, 0, chunkY * chunkX);
    writeSliceRegion(
      ctx.device,
      pool.texture,
      plane,
      chunkX,
      xOff,
      yOff,
      chunkW,
      chunkH,
      "r32uint",
    );
    pool.writtenRegions.set(`${chunk.x}/${chunk.y}`, {
      x: xOff,
      y: yOff,
      width: chunkW,
      height: chunkH,
    });
    wrote = true;
  }
  if (wrote) {
    pool.residentContentEpoch = msg.epochs.content;
    pool.residentSelectionEpoch = msg.epochs.selection;
  }
}

export function handleSliceChunkData(
  ctx: WorkerCtx,
  msg: SliceChunkDataMessage,
  currentEpochs: SceneEpochs | null,
  poolKey: string,
  memberId: string,
): void {
  const { level, levelWidth, levelHeight, chunkX, chunkY, chunkZ, fullResDepth, levelDepth, fullResZ } = msg;
  const tier = msg.tier ?? "detail";

  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    postChunksRequeued(ctx, msg.datasetId, memberId, tier, msg.chunks, "stale");
    return;
  }

  const atlas = ctx.state.sliceAtlases.get(poolKey);
  if (!atlas) {
    postChunksRequeued(ctx, msg.datasetId, memberId, tier, msg.chunks, "missing-pool");
    return;
  }

  if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY) {
    console.warn(`[sliceChunkData] chunkDims mismatch for ${memberId}: pool=[${atlas.chunkX},${atlas.chunkY}] msg=[${chunkX},${chunkY}] level=${level}`);
  }
  const entityLodMetas = atlas.entityMetas.get(memberId);
  if (!entityLodMetas) {
    console.warn(`[sliceChunkData] no entityMeta for ${memberId} in pool ${poolKey}`);
    postChunksRequeued(ctx, msg.datasetId, memberId, tier, msg.chunks, "missing-entity-meta");
    return;
  }
  const lodMeta = entityLodMetas.find(m => m.level === level);
  if (!lodMeta) {
    console.warn(`[sliceChunkData] no lodMeta for level ${level} in entity ${memberId}, has levels [${entityLodMetas.map(m => m.level).join(",")}]`);
    postChunksRequeued(ctx, msg.datasetId, memberId, tier, msg.chunks, "missing-lod-meta");
    return;
  }

  // Store per-entity Z metadata on first arrival
  if (!atlas.entityZInfo.has(memberId)) {
    atlas.entityZInfo.set(memberId, { chunkZ, fullResDepth, levelDepth });
  }

  const levelZ = Math.min(
    Math.floor((fullResZ / Math.max(fullResDepth - 1, 1)) * Math.max(levelDepth - 1, 1)),
    levelDepth - 1,
  );
  const targetChunkZ = Math.floor(levelZ / chunkZ);
  const localZ = levelZ - targetChunkZ * chunkZ;

  let intensityChanged = false;
  const perChunkSamples = Math.floor(10000 / Math.max(1, msg.chunks.length));
  const evictedKeys: string[] = [];
  const requeueKeys: string[] = [];
  const requeueKeySet = new Set<string>();
  const radiusFilteredKeys: string[] = [];
  const radiusFilteredKeySet = new Set<string>();

  for (const chunk of msg.chunks) {
    assertChunkBufferLength(chunk.data, chunk.contract, "worker");
    if (chunk.contract.role !== "intensity" || chunk.contract.dtype !== "uint16") {
      throw new Error(`slice chunk ${chunk.key} has a non-intensity contract`);
    }
    if (chunk.contract.channel !== msg.c) {
      throw new Error(`slice chunk ${chunk.key} channel contract mismatch`);
    }
    if (chunk.z !== targetChunkZ) {
      if (!requeueKeySet.has(chunk.key)) {
        requeueKeySet.add(chunk.key);
        requeueKeys.push(chunk.key);
      }
      continue;
    }
    if (
      !chunkAllowedByCurrentRenderRadius(
        ctx.state,
        memberId,
        msg.tier,
        { ...chunk, level },
      )
    ) {
      radiusFilteredKeys.push(chunk.key);
      radiusFilteredKeySet.add(chunk.key);
      continue;
    }
    const compositeKey = makeCompositeKey(memberId, chunk.key);

    const existingSlot = atlas.slots.get(compositeKey);
    if (existingSlot !== undefined) {
      if (!atlas.staleSliceKeys?.has(compositeKey)) continue;
      atlas.staleSliceKeys.delete(compositeKey);
    }

    const rawView = new Uint16Array(chunk.data);
    const r = sampleIntensityRange(rawView, perChunkSamples);
    if (r.min < atlas.intensityMin) { atlas.intensityMin = r.min; intensityChanged = true; }
    if (r.max > atlas.intensityMax) { atlas.intensityMax = r.max; intensityChanged = true; }

    let slotIndex: number;
    if (existingSlot !== undefined) {
      slotIndex = existingSlot;
    } else if (atlas.freeSlots.length > 0) {
      slotIndex = atlas.freeSlots.pop()!;
    } else {
      const { key: evictKey, dist: farthestDist } = findFarthestSlot2D(ctx.state, atlas);
      if (!evictKey) continue;
      const cam = cameraUVForMember(ctx.state, memberId);
      const incomingDist = chunkDistSq2D(lodMeta, chunk.x, chunk.y, cam);
      // Equal-distance replacement matters for T/C scrubbing: the new
      // timepoint often maps to the same spatial cell as the old one.
      if (incomingDist > farthestDist) continue;
      slotIndex = atlas.slots.get(evictKey)!;
      atlas.slots.delete(evictKey);
      evictedKeys.push(evictKey);
      const oldGridIdx = atlas.slotGridIdx[slotIndex];
      if (oldGridIdx >= 0) {
        atlas.indirectionData[oldGridIdx] = 0xFFFFFFFF;
      }
    }

    const sx = slotIndex % atlas.slotsX;
    const sy = Math.floor(slotIndex / atlas.slotsX);
    const chunkW = Math.min(chunkX, levelWidth - chunk.x * chunkX);
    const chunkH = Math.min(chunkY, levelHeight - chunk.y * chunkY);
    const sliceOffset = localZ * chunkY * chunkX;
    const sliceData = asUint16Slice(
      chunk.data,
      chunk.contract.dtype,
      sliceOffset,
      chunkY * chunkX,
    );

    const xOff = sx * chunkX;
    const yOff = sy * chunkY;
    writeSliceRegion(ctx.device, atlas.texture, sliceData, chunkX, xOff, yOff, chunkW, chunkH);

    // Write to entity's per-LOD section
    const [, , lodGridX] = lodMeta.gridDims;
    const globalIdx = lodMeta.offset + chunk.y * lodGridX + chunk.x;
    if (globalIdx < atlas.indirectionData.length) {
      atlas.indirectionData[globalIdx] = slotIndex;
      atlas.slotGridIdx[slotIndex] = globalIdx;
    }
    atlas.slots.set(compositeKey, slotIndex);
    atlas.indirectionDirty = true;
  }

  // Report evicted/skipped, demuxed by member
  const skippedKeys: string[] = [];
  for (const chunk of msg.chunks) {
    if (requeueKeySet.has(chunk.key)) continue;
    if (radiusFilteredKeySet.has(chunk.key)) continue;
    const compositeKey = makeCompositeKey(memberId, chunk.key);
    if (!atlas.slots.has(compositeKey)) {
      skippedKeys.push(chunk.key);
    }
  }

  if (evictedKeys.length > 0 || requeueKeys.length > 0 || skippedKeys.length > 0 || radiusFilteredKeys.length > 0) {
    const evictedByMember = new Map<string, string[]>();
    for (const ck of evictedKeys) {
      const parsed = parseCompositeKey(ck);
      if (!parsed) continue;
      const arr = evictedByMember.get(parsed.memberId) ?? [];
      arr.push(parsed.chunkKey);
      evictedByMember.set(parsed.memberId, arr);
    }
    for (const [evMember, evKeys] of evictedByMember) {
      ctx.post({ type: "chunksEvicted", datasetId: atlas.datasetId ?? msg.datasetId, memberId: evMember, tier, keys: evKeys, skipped: [], reason: "evicted" });
    }
    if (requeueKeys.length > 0) {
      postChunksRequeued(
        ctx,
        msg.datasetId,
        memberId,
        tier,
        requeueKeys.map(key => ({ key })),
        "wrong-slice",
      );
    }
    if (radiusFilteredKeys.length > 0) {
      postChunksRequeued(
        ctx,
        msg.datasetId,
        memberId,
        tier,
        radiusFilteredKeys.map(key => ({ key })),
        "radius-filter",
      );
    }
    if (skippedKeys.length > 0) {
      postChunksRejected(
        ctx,
        msg.datasetId,
        memberId,
        tier,
        skippedKeys.map(key => ({ key })),
      );
    }
    ctx.postWantedSet();
  }

  if (intensityChanged) {
    const contract = msg.chunks[0]?.contract;
    if (contract) {
      ctx.post({
        type: "intensityRange",
        datasetId: contract.datasetId,
        channel: contract.channel,
        min: atlas.intensityMin,
        max: atlas.intensityMax,
      });
    }
  }
}
