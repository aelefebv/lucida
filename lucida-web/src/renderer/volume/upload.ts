/**
 * Volume chunk upload: staleness check, admission against the planner's
 * wanted keys, eviction, GPU write, and the residency report for every
 * chunk.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  ChunkFeedbackReason,
  LabelVolumeChunkDataMessage,
  VolumeChunkDataMessage,
} from "../workerProtocol.ts";
import { writeVolumeChunk } from "../gpuContext.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import { isStaleDelivery } from "../epochCheck.ts";
import { asUint32, atlasTexels, atlasTextureFormat } from "../dataTypeUtil.ts";
import { makeCompositeKey } from "../chunkKeys.ts";
import { LABEL_TIER, postChunkResidency, ResidencyBatch } from "../chunkUploadFeedback.ts";
import { mayEvict } from "../eviction.ts";
import { wantedChunksFor } from "../wantedChunks.ts";
import { chunkDistSq, findEvictionSlot, rayHitForMember } from "./eviction.ts";
import {
  acquireLabelSlot,
  getOrCreateLabelVolumePool,
  growVolumePoolWithin,
  type AtlasState,
} from "./atlas.ts";

/**
 * Write whole 3D uint32 label chunks into the member's bricked r32uint
 * volume atlas. Ids keep their full 32-bit width, because they are
 * categorical. Brick placement and edge clamping mirror
 * `handleVolumeChunkData`.
 */
export function handleLabelVolumeChunkData(
  ctx: WorkerCtx,
  msg: LabelVolumeChunkDataMessage,
): void {
  const { memberId, datasetId, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;
  const refuseAll = (reason: ChunkFeedbackReason): void =>
    postChunkResidency(ctx, memberId, "volume", LABEL_TIER, "refused", msg.chunks.map(c => c.key), reason);

  // A previous timepoint's chunk racing in must not overwrite the atlas.
  if (isStaleDelivery(msg.epochs, ctx.state.currentEpochs)) {
    refuseAll("stale");
    return;
  }

  const pool = getOrCreateLabelVolumePool(
    ctx, memberId, datasetId, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ,
  );
  if (!pool) {
    // Nothing of the batch is resident, so the page must not count it as sent.
    refuseAll("atlas-policy");
    return;
  }

  const batch = new ResidencyBatch();
  const replaced: string[] = [];
  let wrote = false;
  for (const chunk of msg.chunks) {
    // A mismatched delivery must not index past the indirection buffer.
    if (
      chunk.x < 0 || chunk.x >= pool.gridX ||
      chunk.y < 0 || chunk.y >= pool.gridY ||
      chunk.z < 0 || chunk.z >= pool.gridZ
    ) {
      batch.refuse(chunk.key, "atlas-policy");
      continue;
    }
    const gridIdx = chunk.z * pool.gridY * pool.gridX + chunk.y * pool.gridX + chunk.x;

    // Edge chunks are partial: clamp to the level extent. Do this before
    // acquiring a slot so an out-of-bounds cell never takes a slot it won't
    // write or leaves a dangling indirection entry.
    const cw = Math.min(chunkX, pool.width - chunk.x * chunkX);
    const ch = Math.min(chunkY, pool.height - chunk.y * chunkY);
    const cd = Math.min(chunkZ, pool.depth - chunk.z * chunkZ);
    if (cw <= 0 || ch <= 0 || cd <= 0) {
      batch.refuse(chunk.key, "atlas-policy");
      continue;
    }

    const acquired = acquireLabelSlot(pool, gridIdx);
    if (!acquired) {
      // Nothing evictable (only a pathological over-limit grid).
      batch.refuse(chunk.key, "atlas-policy");
      continue;
    }
    if (acquired.evictedKey !== undefined) replaced.push(acquired.evictedKey);
    const previous = pool.keys.get(gridIdx);
    if (previous !== undefined && previous !== chunk.key) replaced.push(previous);
    pool.keys.set(gridIdx, chunk.key);
    batch.held.push(chunk.key);

    const data = asUint32(chunk.data);
    writeVolumeChunk(
      ctx.device,
      pool.texture,
      data,
      chunkX,
      chunkY,
      cw,
      ch,
      cd,
      acquired.origin[0],
      acquired.origin[1],
      acquired.origin[2],
      "r32uint",
    );
    pool.indirectionData[gridIdx] = acquired.slot;
    wrote = true;
  }

  if (wrote) {
    ctx.device.queue.writeBuffer(pool.indirectionBuf, 0, pool.indirectionData);
  }
  batch.post(ctx, memberId, "volume", LABEL_TIER);
  // After held, so a chunk this batch wrote and then overwrote ends lost.
  postChunkResidency(ctx, memberId, "volume", LABEL_TIER, "lost", replaced, "replaced");
}

export function handleVolumeChunkData(
  ctx: WorkerCtx,
  msg: VolumeChunkDataMessage,
  currentEpochs: SceneEpochs | null,
  poolKey: string,
  memberId: string,
): void {
  const { tier, level, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;
  const refuseAll = (reason: ChunkFeedbackReason): void =>
    postChunkResidency(ctx, memberId, "volume", tier, "refused", msg.chunks.map(c => c.key), reason);

  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    refuseAll("stale");
    return;
  }

  const atlas = ctx.state.volumeAtlases.get(poolKey);
  if (!atlas) {
    refuseAll("missing-pool");
    return; // pool not yet created by cold state handler
  }

  if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY || atlas.chunkZ !== chunkZ) {
    console.warn(`[volumeChunkData] chunkDims mismatch for ${memberId}: pool=[${atlas.chunkX},${atlas.chunkY},${atlas.chunkZ}] msg=[${chunkX},${chunkY},${chunkZ}] level=${level}`);
  }
  const entityLodMetas = atlas.entityMetas.get(memberId);
  if (!entityLodMetas) {
    console.warn(`[volumeChunkData] no entityMeta for ${memberId} in pool ${poolKey}`);
    refuseAll("missing-entity-meta");
    return;
  }
  const lodMeta = entityLodMetas.find(m => m.level === level);
  if (!lodMeta) {
    console.warn(`[volumeChunkData] no lodMeta for level ${level} in entity ${memberId}, has levels [${entityLodMetas.map(m => m.level).join(",")}]`);
    refuseAll("missing-lod-meta");
    return;
  }

  const wanted = wantedChunksFor(ctx.state, "volume", memberId, tier);
  const batch = new ResidencyBatch();
  let failure: unknown = null;

  for (const chunk of msg.chunks) {
    let claimed = -1;
    let landed = false;
    try {
      const compositeKey = makeCompositeKey(memberId, chunk.key);
      if (atlas.slots.has(compositeKey)) {
        batch.held.push(chunk.key);
        continue;
      }
      if (!wanted?.has(chunk.key)) {
        batch.refuse(chunk.key, "unwanted");
        continue;
      }

      // A pool grows only once every slot it has holds a chunk, and freely
      // only while the GPU total has room (`worker/gpuBudget.ts`).
      if (atlas.freeSlots.length === 0 && atlas.slots.size >= atlas.totalSlots) {
        growVolumePoolWithin(ctx, poolKey, atlas, false);
      }
      let slotIndex: number;
      if (atlas.freeSlots.length > 0) {
        slotIndex = atlas.freeSlots.pop()!;
      } else {
        const victim = findEvictionSlot(ctx.state, atlas, tier);
        if (
          victim?.class === "wanted" && atlas.slots.size >= atlas.totalSlots &&
          growVolumePoolWithin(ctx, poolKey, atlas, true)
        ) {
          slotIndex = atlas.freeSlots.pop()!;
        } else {
          const incomingDist = chunkDistSq(lodMeta, chunk.x, chunk.y, chunk.z, rayHitForMember(ctx.state, memberId));
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
      claimed = slotIndex;

      const sx = slotIndex % atlas.slotsX;
      const sy = Math.floor(slotIndex / atlas.slotsX) % atlas.slotsY;
      const sz = Math.floor(slotIndex / (atlas.slotsX * atlas.slotsY));

      const data = atlasTexels(chunk.data, chunk.dataType, atlas.format);
      const xOff = sx * chunkX;
      const yOff = sy * chunkY;
      const zOff = sz * chunkZ;
      const cw = Math.min(chunkX, levelWidth - chunk.x * chunkX);
      const ch = Math.min(chunkY, levelHeight - chunk.y * chunkY);
      const cd = Math.min(chunkZ, levelDepth - chunk.z * chunkZ);

      writeVolumeChunk(
        ctx.device, atlas.texture, data, chunkX, chunkY, cw, ch, cd, xOff, yOff, zOff,
        atlasTextureFormat(atlas.format),
      );

      const [, lodGridY, lodGridX] = lodMeta.gridDims;
      const globalIdx = lodMeta.offset + chunk.z * lodGridY * lodGridX + chunk.y * lodGridX + chunk.x;
      if (globalIdx < atlas.indirectionData.length) {
        atlas.indirectionData[globalIdx] = slotIndex;
        atlas.slotGridIdx[slotIndex] = globalIdx;
      }
      atlas.slots.set(compositeKey, slotIndex);
      claimed = -1;
      atlas.indirectionDirty = true;
      batch.held.push(chunk.key);
      landed = true;
    } catch (err) {
      // A chunk that throws goes back to the page to be sent again, and the
      // rest of the batch still lands.
      failure ??= err;
      if (!landed) batch.refuse(chunk.key, "upload-failed");
      // A slot taken for a chunk that never landed would hold nothing for good.
      if (claimed >= 0) releaseSlot(atlas, claimed);
    }
  }

  batch.post(ctx, memberId, "volume", tier);
  if (batch.displacedAny) ctx.postWantedSet(ctx.state.memberToDataset.get(memberId), "volume");

  if (failure !== null) throw failure;
}

function releaseSlot(atlas: AtlasState, slot: number): void {
  atlas.slotGridIdx[slot] = -1;
  atlas.freeSlots.push(slot);
}
