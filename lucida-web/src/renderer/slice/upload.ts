/**
 * Slice chunk upload: staleness check, Z-slice filter, eviction, GPU write,
 * and per-member feedback messages.
 *
 * Re-cuts a resident chunk in place when the plane the current Z maps to is
 * not the one its slot holds. Pairs with `slice/zRetarget.ts`.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  LabelSliceChunkDataMessage,
  SliceChunkDataMessage,
} from "../workerProtocol.ts";
import { writeSliceRegion } from "../gpuContext.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import { isStaleDelivery } from "../epochCheck.ts";
import { asUint32Slice, atlasTexels, atlasTextureFormat } from "../dataTypeUtil.ts";
import { parseCompositeKey, makeCompositeKey } from "../chunkKeys.ts";
import { postChunksRejected, postChunksRequeued } from "../chunkUploadFeedback.ts";
import { chunkAllowedByCurrentRenderRadius } from "../chunkRadius.ts";
import { sliceLevelZ } from "../slicePlane.ts";
import { cameraUVForMember, chunkDistSq2D, findFarthestSlot2D } from "./eviction.ts";
import { getOrCreateLabelSlicePool, type SliceAtlasState } from "./atlas.ts";

/**
 * Write pre-sliced uint32 label planes into the member's r32uint label pool.
 * The delivery path already extracted the current Z-plane, so each
 * `chunk.data` is `chunkY*chunkX` ids. Ids are categorical, so they keep full
 * 32-bit width.
 */
export function handleLabelSliceChunkData(
  ctx: WorkerCtx,
  msg: LabelSliceChunkDataMessage,
): void {
  // A previous timepoint's plane racing in must not overwrite the pool.
  if (isStaleDelivery(msg.epochs, ctx.state.currentEpochs)) return;

  const { memberId, datasetId, levelWidth, levelHeight, chunkX, chunkY } = msg;

  const pool = getOrCreateLabelSlicePool(ctx, memberId, datasetId, levelWidth, levelHeight);
  if (!pool) {
    // Nothing of the batch is resident, so the page must not count it as sent.
    postChunksRejected(ctx, memberId, msg.chunks);
    return;
  }

  for (const chunk of msg.chunks) {
    const xOff = chunk.x * chunkX;
    const yOff = chunk.y * chunkY;
    // The texture may be device-limited below the level's dims.
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

  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    postChunksRequeued(ctx, memberId, msg.chunks, "stale");
    return;
  }

  const atlas = ctx.state.sliceAtlases.get(poolKey);
  if (!atlas) {
    postChunksRequeued(ctx, memberId, msg.chunks, "missing-pool");
    return;
  }

  if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY) {
    console.warn(`[sliceChunkData] chunkDims mismatch for ${memberId}: pool=[${atlas.chunkX},${atlas.chunkY}] msg=[${chunkX},${chunkY}] level=${level}`);
  }
  const entityLodMetas = atlas.entityMetas.get(memberId);
  if (!entityLodMetas) {
    console.warn(`[sliceChunkData] no entityMeta for ${memberId} in pool ${poolKey}`);
    postChunksRequeued(ctx, memberId, msg.chunks, "missing-entity-meta");
    return;
  }
  const lodMeta = entityLodMetas.find(m => m.level === level);
  if (!lodMeta) {
    console.warn(`[sliceChunkData] no lodMeta for level ${level} in entity ${memberId}, has levels [${entityLodMetas.map(m => m.level).join(",")}]`);
    postChunksRequeued(ctx, memberId, msg.chunks, "missing-lod-meta");
    return;
  }

  // Record this level's Z geometry on first arrival so the remap can
  // retarget its chunks on a Z scrub.
  let zInfoByLevel = atlas.entityZInfo.get(memberId);
  if (!zInfoByLevel) {
    zInfoByLevel = new Map();
    atlas.entityZInfo.set(memberId, zInfoByLevel);
  }
  if (!zInfoByLevel.has(level)) {
    zInfoByLevel.set(level, { chunkZ, fullResDepth, levelDepth });
  }

  const levelZ = sliceLevelZ(fullResZ, fullResDepth, levelDepth);
  const targetChunkZ = Math.floor(levelZ / chunkZ);
  const localZ = levelZ - targetChunkZ * chunkZ;

  const evictedKeys: string[] = [];
  const requeueKeys: string[] = [];
  const requeueKeySet = new Set<string>();
  const radiusFilteredKeys: string[] = [];
  const radiusFilteredKeySet = new Set<string>();
  // A chunk that throws goes back to the page to be sent again, and the rest
  // of the batch still lands.
  const failedKeys: string[] = [];
  const failedKeySet = new Set<string>();
  let failure: unknown = null;

  for (const chunk of msg.chunks) {
    let claimed = -1;
    try {
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
      if (existingSlot !== undefined && atlas.slotLevelZ[existingSlot] === levelZ) continue;

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
        // A tie keeps the resident. Mirror-image chunks sit at one distance, and
        // letting either displace the other turns their re-sends into a loop. A
        // T or C scrub still replaces in place: the remap unmaps the old
        // selection's slots, and an unmapped slot ranks at infinite distance.
        if (incomingDist >= farthestDist) continue;
        slotIndex = atlas.slots.get(evictKey)!;
        atlas.slots.delete(evictKey);
        evictedKeys.push(evictKey);
        const oldGridIdx = atlas.slotGridIdx[slotIndex];
        if (oldGridIdx >= 0) {
          atlas.indirectionData[oldGridIdx] = 0xFFFFFFFF;
        }
      }
      if (existingSlot === undefined) claimed = slotIndex;

      const sx = slotIndex % atlas.slotsX;
      const sy = Math.floor(slotIndex / atlas.slotsX);
      const chunkW = Math.min(chunkX, levelWidth - chunk.x * chunkX);
      const chunkH = Math.min(chunkY, levelHeight - chunk.y * chunkY);
      const sliceOffset = localZ * chunkY * chunkX;
      const sliceData = atlasTexels(chunk.data, chunk.dataType, atlas.format, sliceOffset, chunkY * chunkX);

      const xOff = sx * chunkX;
      const yOff = sy * chunkY;
      writeSliceRegion(
        ctx.device, atlas.texture, sliceData, chunkX, xOff, yOff, chunkW, chunkH,
        atlasTextureFormat(atlas.format),
      );

      const [, , lodGridX] = lodMeta.gridDims;
      const globalIdx = lodMeta.offset + chunk.y * lodGridX + chunk.x;
      if (globalIdx < atlas.indirectionData.length) {
        atlas.indirectionData[globalIdx] = slotIndex;
        atlas.slotGridIdx[slotIndex] = globalIdx;
      }
      atlas.slots.set(compositeKey, slotIndex);
      atlas.slotLevelZ[slotIndex] = levelZ;
      atlas.indirectionDirty = true;
    } catch (err) {
      failure ??= err;
      failedKeys.push(chunk.key);
      failedKeySet.add(chunk.key);
      // A slot taken for a chunk that never landed would hold nothing for good.
      if (claimed >= 0) releaseSlot(atlas, claimed);
    }
  }

  const skippedKeys: string[] = [];
  for (const chunk of msg.chunks) {
    if (requeueKeySet.has(chunk.key)) continue;
    if (radiusFilteredKeySet.has(chunk.key)) continue;
    if (failedKeySet.has(chunk.key)) continue;
    const compositeKey = makeCompositeKey(memberId, chunk.key);
    if (!atlas.slots.has(compositeKey)) {
      skippedKeys.push(chunk.key);
    }
  }

  if (
    evictedKeys.length > 0 || requeueKeys.length > 0 || skippedKeys.length > 0 ||
    radiusFilteredKeys.length > 0 || failedKeys.length > 0
  ) {
    const evictedByMember = new Map<string, string[]>();
    for (const ck of evictedKeys) {
      const parsed = parseCompositeKey(ck);
      if (!parsed) continue;
      const arr = evictedByMember.get(parsed.memberId) ?? [];
      arr.push(parsed.chunkKey);
      evictedByMember.set(parsed.memberId, arr);
    }
    for (const [evMember, evKeys] of evictedByMember) {
      ctx.post({ type: "chunksEvicted", memberId: evMember, keys: evKeys, skipped: [], reason: "evicted" });
    }
    if (requeueKeys.length > 0) {
      postChunksRequeued(
        ctx,
        memberId,
        requeueKeys.map(key => ({ key })),
        "wrong-slice",
      );
    }
    if (radiusFilteredKeys.length > 0) {
      postChunksRequeued(
        ctx,
        memberId,
        radiusFilteredKeys.map(key => ({ key })),
        "radius-filter",
      );
    }
    if (skippedKeys.length > 0) {
      postChunksRejected(
        ctx,
        memberId,
        skippedKeys.map(key => ({ key })),
      );
    }
    postChunksRequeued(ctx, memberId, failedKeys.map(key => ({ key })), "upload-failed");
    ctx.postWantedSet(ctx.state.memberToDataset.get(memberId));
  }

  if (failure !== null) throw failure;
}

function releaseSlot(atlas: SliceAtlasState, slot: number): void {
  atlas.slotGridIdx[slot] = -1;
  atlas.slotLevelZ[slot] = -1;
  atlas.freeSlots.push(slot);
}
