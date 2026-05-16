/**
 * Slice chunk upload — staleness check, Z-slice filter, LRU eviction,
 * GPU write, intensity sampling, and per-member post-message demux.
 *
 * Extracted from `sliceHandlers.ts` in Slice 7. No behavior change.
 *
 * Manages `staleSliceKeys` on the atlas (cleared as fresh chunks land
 * for the new target Z). See `slice/zRetarget.ts` for the helper
 * function this module pairs with.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { SliceChunkDataMessage } from "../workerProtocol.ts";
import { writeSliceRegion } from "../gpuContext.ts";
import { sampleIntensityRange } from "../../zarr/intensitySampler.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import { isStaleDelivery } from "../epochCheck.ts";
import { asUint16Slice } from "../dataTypeUtil.ts";
import { parseCompositeKey, makeCompositeKey } from "../chunkKeys.ts";
import { getSliceAtlases } from "./atlas.ts";
import { cameraUVForMember, chunkDistSq2D, findFarthestSlot2D } from "./eviction.ts";

export function handleSliceChunkData(
  ctx: WorkerCtx,
  msg: SliceChunkDataMessage,
  currentEpochs: SceneEpochs | null,
  poolKey: string,
  memberId: string,
): void {
  const { level, levelWidth, levelHeight, chunkX, chunkY, chunkZ, fullResDepth, levelDepth, fullResZ } = msg;

  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    const skippedKeys = msg.chunks.map(c => c.key);
    if (skippedKeys.length > 0) {
      ctx.post({ type: "chunksEvicted", memberId, keys: [], skipped: skippedKeys });
    }
    return;
  }

  const atlas = getSliceAtlases().get(poolKey);
  if (!atlas) return;

  if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY) {
    console.warn(`[sliceChunkData] chunkDims mismatch for ${memberId}: pool=[${atlas.chunkX},${atlas.chunkY}] msg=[${chunkX},${chunkY}] level=${level}`);
  }
  const entityLodMetas = atlas.entityMetas.get(memberId);
  if (!entityLodMetas) {
    console.warn(`[sliceChunkData] no entityMeta for ${memberId} in pool ${poolKey}`);
    return;
  }
  const lodMeta = entityLodMetas.find(m => m.level === level);
  if (!lodMeta) {
    console.warn(`[sliceChunkData] no lodMeta for level ${level} in entity ${memberId}, has levels [${entityLodMetas.map(m => m.level).join(",")}]`);
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

  for (const chunk of msg.chunks) {
    if (chunk.z !== targetChunkZ) continue;
    const compositeKey = makeCompositeKey(memberId, chunk.key);

    const existingSlot = atlas.slots.get(compositeKey);
    if (existingSlot !== undefined) {
      if (!atlas.staleSliceKeys?.has(compositeKey)) continue;
      atlas.staleSliceKeys.delete(compositeKey);
    }

    const isU8 = chunk.dataType === "uint8" || chunk.dataType === "Uint8";
    if (!isU8 && chunk.data.byteLength % 2 !== 0) {
      throw new Error(
        `slice chunk ${chunk.key}: byteLength ${chunk.data.byteLength} is not a multiple of 2 ` +
        `(server likely returned a compressed or wrong-shape chunk)`,
      );
    }
    const rawView = isU8 ? new Uint8Array(chunk.data) : new Uint16Array(chunk.data);
    const r = sampleIntensityRange(rawView, perChunkSamples);
    if (r.min < atlas.intensityMin) { atlas.intensityMin = r.min; intensityChanged = true; }
    if (r.max > atlas.intensityMax) { atlas.intensityMax = r.max; intensityChanged = true; }

    let slotIndex: number;
    if (existingSlot !== undefined) {
      slotIndex = existingSlot;
    } else if (atlas.freeSlots.length > 0) {
      slotIndex = atlas.freeSlots.pop()!;
    } else {
      const { key: evictKey, dist: farthestDist } = findFarthestSlot2D(atlas);
      if (!evictKey) continue;
      const cam = cameraUVForMember(memberId);
      const incomingDist = chunkDistSq2D(lodMeta, chunk.x, chunk.y, cam);
      if (incomingDist >= farthestDist) continue;
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
    const sliceData = asUint16Slice(chunk.data, chunk.dataType, sliceOffset, chunkY * chunkX);

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
    const compositeKey = makeCompositeKey(memberId, chunk.key);
    if (!atlas.slots.has(compositeKey)) {
      skippedKeys.push(chunk.key);
    }
  }

  if (evictedKeys.length > 0 || skippedKeys.length > 0) {
    const evictedByMember = new Map<string, string[]>();
    for (const ck of evictedKeys) {
      const parsed = parseCompositeKey(ck);
      if (!parsed) continue;
      const arr = evictedByMember.get(parsed.memberId) ?? [];
      arr.push(parsed.chunkKey);
      evictedByMember.set(parsed.memberId, arr);
    }
    for (const [evMember, evKeys] of evictedByMember) {
      ctx.post({ type: "chunksEvicted", memberId: evMember, keys: evKeys, skipped: [] });
    }
    if (skippedKeys.length > 0) {
      ctx.post({ type: "chunksEvicted", memberId, keys: [], skipped: skippedKeys });
    }
    ctx.postWantedSet();
  }

  if (intensityChanged) {
    ctx.post({ type: "intensityRange", datasetId: memberId, min: atlas.intensityMin, max: atlas.intensityMax });
  }
}
