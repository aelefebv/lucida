/**
 * Slice chunk upload: staleness check, admission against the planner's
 * wanted keys, eviction, GPU write, and the residency report for every
 * chunk.
 *
 * Each delivery is the one plane the page cut for the current Z, written over
 * a resident chunk's slot when the slot holds another plane. Pairs with
 * `slice/zRetarget.ts`.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  ChunkFeedbackReason,
  LabelSliceChunkDataMessage,
  SliceChunkDataMessage,
} from "../workerProtocol.ts";
import { writeSliceRegion } from "../gpuContext.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import { isStaleDelivery } from "../epochCheck.ts";
import { asUint32Slice, atlasTexels, atlasTextureFormat } from "../dataTypeUtil.ts";
import { makeCompositeKey } from "../chunkKeys.ts";
import { LABEL_TIER, postChunkResidency, ResidencyBatch } from "../chunkUploadFeedback.ts";
import { mayEvict } from "../eviction.ts";
import { sliceLevelPlane } from "../slicePlane.ts";
import { wantedChunksFor } from "../wantedChunks.ts";
import { cameraUVForMember, chunkDistSq2D, findEvictionSlot2D } from "./eviction.ts";
import {
  getOrCreateLabelSlicePool,
  growSlicePoolWithin,
  labelCellKey,
  type SliceAtlasState,
} from "./atlas.ts";

/**
 * Write pre-sliced uint32 label planes into the member's r32uint label pool.
 * The delivery path already extracted the current Z-plane, so each
 * `chunk.data` is `chunkY*chunkX` ids. Ids are categorical, so they keep full
 * 32-bit width. Each cell records the plane it holds, so a frame drawing
 * another plane can hand the chunk back (`retireOtherLabelPlanes`).
 */
export function handleLabelSliceChunkData(
  ctx: WorkerCtx,
  msg: LabelSliceChunkDataMessage,
): void {
  const { memberId, datasetId, levelWidth, levelHeight, chunkX, chunkY } = msg;
  const refuseAll = (reason: ChunkFeedbackReason): void =>
    postChunkResidency(ctx, memberId, LABEL_TIER, "refused", msg.chunks.map(c => c.key), reason);

  // A previous timepoint's plane racing in must not overwrite the pool.
  if (isStaleDelivery(msg.epochs, ctx.state.currentEpochs)) {
    refuseAll("stale");
    return;
  }

  const pool = getOrCreateLabelSlicePool(ctx, memberId, datasetId, levelWidth, levelHeight, chunkX, chunkY);
  if (!pool) {
    // Nothing of the batch is resident, so the page must not count it as sent.
    refuseAll("atlas-policy");
    return;
  }

  const batch = new ResidencyBatch();
  const replaced: string[] = [];
  for (const chunk of msg.chunks) {
    const xOff = chunk.x * chunkX;
    const yOff = chunk.y * chunkY;
    // The texture may be device-limited below the level's dims.
    const chunkW = Math.min(chunkX, pool.width - xOff);
    const chunkH = Math.min(chunkY, pool.height - yOff);
    if (xOff >= pool.width || yOff >= pool.height || chunkW <= 0 || chunkH <= 0) {
      batch.refuse(chunk.key, "atlas-policy");
      continue;
    }
    const cell = labelCellKey(chunk.x, chunk.y);
    const previous = pool.keys.get(cell);
    if (previous !== undefined && previous !== chunk.key) replaced.push(previous);
    pool.keys.set(cell, chunk.key);
    pool.planes.set(cell, msg.plane);
    batch.held.push(chunk.key);
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
  batch.post(ctx, memberId, LABEL_TIER);
  // After held, so a chunk this batch wrote and then overwrote ends lost.
  postChunkResidency(ctx, memberId, LABEL_TIER, "lost", replaced, "replaced");
}

export function handleSliceChunkData(
  ctx: WorkerCtx,
  msg: SliceChunkDataMessage,
  currentEpochs: SceneEpochs | null,
  poolKey: string,
  memberId: string,
): void {
  const { level, levelWidth, levelHeight, chunkX, chunkY, chunkZ, fullResDepth, levelDepth, fullResZ } = msg;

  const { tier } = msg;
  const refuseAll = (reason: ChunkFeedbackReason): void =>
    postChunkResidency(ctx, memberId, tier, "refused", msg.chunks.map(c => c.key), reason);

  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    refuseAll("stale");
    return;
  }

  const atlas = ctx.state.sliceAtlases.get(poolKey);
  if (!atlas) {
    refuseAll("missing-pool");
    return;
  }

  if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY) {
    console.warn(`[sliceChunkData] chunkDims mismatch for ${memberId}: pool=[${atlas.chunkX},${atlas.chunkY}] msg=[${chunkX},${chunkY}] level=${level}`);
  }
  const entityLodMetas = atlas.entityMetas.get(memberId);
  if (!entityLodMetas) {
    console.warn(`[sliceChunkData] no entityMeta for ${memberId} in pool ${poolKey}`);
    refuseAll("missing-entity-meta");
    return;
  }
  const lodMeta = entityLodMetas.find(m => m.level === level);
  if (!lodMeta) {
    console.warn(`[sliceChunkData] no lodMeta for level ${level} in entity ${memberId}, has levels [${entityLodMetas.map(m => m.level).join(",")}]`);
    refuseAll("missing-lod-meta");
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

  const levelZ = sliceLevelPlane(fullResZ, fullResDepth, levelDepth);
  const targetChunkZ = Math.floor(levelZ / chunkZ);
  const wanted = wantedChunksFor(ctx.state, memberId, tier);

  const batch = new ResidencyBatch();
  let failure: unknown = null;

  for (const chunk of msg.chunks) {
    let claimed = -1;
    try {
      const compositeKey = makeCompositeKey(memberId, chunk.key);

      const existingSlot = atlas.slots.get(compositeKey);
      if (existingSlot !== undefined && atlas.slotLevelZ[existingSlot] === levelZ) {
        batch.held.push(chunk.key);
        continue;
      }
      if (!wanted?.has(chunk.key)) {
        batch.refuse(chunk.key, "unwanted");
        continue;
      }
      // The planner's keys and this cut map Z through one function, so a wanted
      // chunk holds the plane unless the sender's Z is not the cold state's.
      if (chunk.z !== targetChunkZ) {
        batch.refuse(chunk.key, "wrong-slice");
        continue;
      }

      // A pool grows only once every slot it has holds a chunk, and freely
      // only while the GPU total has room (`worker/gpuBudget.ts`).
      if (existingSlot === undefined && atlas.freeSlots.length === 0 && atlas.slots.size >= atlas.totalSlots) {
        growSlicePoolWithin(ctx, poolKey, atlas, false);
      }
      let slotIndex: number;
      if (existingSlot !== undefined) {
        slotIndex = existingSlot;
      } else if (atlas.freeSlots.length > 0) {
        slotIndex = atlas.freeSlots.pop()!;
      } else {
        const victim = findEvictionSlot2D(ctx.state, atlas, tier);
        if (
          victim?.class === "wanted" && atlas.slots.size >= atlas.totalSlots &&
          growSlicePoolWithin(ctx, poolKey, atlas, true)
        ) {
          slotIndex = atlas.freeSlots.pop()!;
        } else {
          const incomingDist = chunkDistSq2D(lodMeta, chunk.x, chunk.y, cameraUVForMember(ctx.state, memberId));
          if (!victim || !mayEvict(victim, incomingDist)) {
            batch.refuse(chunk.key, "atlas-policy");
            continue;
          }
          slotIndex = atlas.slots.get(victim.key)!;
          atlas.slots.delete(victim.key);
          batch.evicted.push(victim.key);
          const oldGridIdx = atlas.slotGridIdx[slotIndex];
          if (oldGridIdx >= 0) {
            atlas.indirectionData[oldGridIdx] = 0xFFFFFFFF;
          }
        }
      }
      if (existingSlot === undefined) claimed = slotIndex;

      const sx = slotIndex % atlas.slotsX;
      const sy = Math.floor(slotIndex / atlas.slotsX);
      const chunkW = Math.min(chunkX, levelWidth - chunk.x * chunkX);
      const chunkH = Math.min(chunkY, levelHeight - chunk.y * chunkY);
      const sliceData = atlasTexels(chunk.data, chunk.dataType, atlas.format, 0, chunkY * chunkX);

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
      batch.held.push(chunk.key);
    } catch (err) {
      // A chunk that throws goes back to the page to be sent again, and the
      // rest of the batch still lands.
      failure ??= err;
      batch.refuse(chunk.key, "upload-failed");
      // A slot taken for a chunk that never landed would hold nothing for good.
      if (claimed >= 0) releaseSlot(atlas, claimed);
    }
  }

  batch.post(ctx, memberId, tier);
  if (batch.displacedAny) ctx.postWantedSet(ctx.state.memberToDataset.get(memberId));

  if (failure !== null) throw failure;
}

function releaseSlot(atlas: SliceAtlasState, slot: number): void {
  atlas.slotGridIdx[slot] = -1;
  atlas.slotLevelZ[slot] = -1;
  atlas.freeSlots.push(slot);
}
