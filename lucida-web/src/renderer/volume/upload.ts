/**
 * Volume chunk upload: staleness check, eviction, GPU write, and per-member
 * feedback messages.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  LabelVolumeChunkDataMessage,
  VolumeChunkDataMessage,
} from "../workerProtocol.ts";
import { writeVolumeChunk } from "../gpuContext.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import { isStaleDelivery } from "../epochCheck.ts";
import { asUint32, atlasTexels, atlasTextureFormat } from "../dataTypeUtil.ts";
import {
  parseCompositeKey,
  makeCompositeKey,
} from "../chunkKeys.ts";
import { postChunksRejected, postChunksRequeued } from "../chunkUploadFeedback.ts";
import { chunkAllowedByCurrentRenderRadius } from "../chunkRadius.ts";
import { chunkDistSq, findFarthestSlot, rayHitForMember } from "./eviction.ts";
import {
  acquireLabelSlot,
  getOrCreateLabelVolumePool,
  growVolumeAtlasWatched,
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
  // A previous timepoint's chunk racing in must not overwrite the atlas.
  if (isStaleDelivery(msg.epochs, ctx.state.currentEpochs)) return;

  const { memberId, datasetId, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;

  const pool = getOrCreateLabelVolumePool(
    ctx, memberId, datasetId, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ,
  );
  if (!pool) {
    // Nothing of the batch is resident, so the page must not count it as sent.
    postChunksRejected(ctx, memberId, msg.chunks);
    return;
  }

  let wrote = false;
  for (const chunk of msg.chunks) {
    // A mismatched delivery must not index past the indirection buffer.
    if (
      chunk.x < 0 || chunk.x >= pool.gridX ||
      chunk.y < 0 || chunk.y >= pool.gridY ||
      chunk.z < 0 || chunk.z >= pool.gridZ
    ) continue;
    const gridIdx = chunk.z * pool.gridY * pool.gridX + chunk.y * pool.gridX + chunk.x;

    // Edge chunks are partial: clamp to the level extent. Do this before
    // acquiring a slot so an out-of-bounds cell never takes a slot it won't
    // write or leaves a dangling indirection entry.
    const cw = Math.min(chunkX, pool.width - chunk.x * chunkX);
    const ch = Math.min(chunkY, pool.height - chunk.y * chunkY);
    const cd = Math.min(chunkZ, pool.depth - chunk.z * chunkZ);
    if (cw <= 0 || ch <= 0 || cd <= 0) continue;

    const acquired = acquireLabelSlot(pool, gridIdx);
    if (!acquired) continue; // nothing evictable (only a pathological over-limit grid)

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
}

export function handleVolumeChunkData(
  ctx: WorkerCtx,
  msg: VolumeChunkDataMessage,
  currentEpochs: SceneEpochs | null,
  poolKey: string,
  memberId: string,
): void {
  const { level, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;

  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    postChunksRequeued(ctx, memberId, msg.chunks, "stale");
    return;
  }

  const atlas = ctx.state.volumeAtlases.get(poolKey);
  if (!atlas) {
    postChunksRequeued(ctx, memberId, msg.chunks, "missing-pool");
    return; // pool not yet created by cold state handler
  }

  if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY || atlas.chunkZ !== chunkZ) {
    console.warn(`[volumeChunkData] chunkDims mismatch for ${memberId}: pool=[${atlas.chunkX},${atlas.chunkY},${atlas.chunkZ}] msg=[${chunkX},${chunkY},${chunkZ}] level=${level}`);
  }
  const entityLodMetas = atlas.entityMetas.get(memberId);
  if (!entityLodMetas) {
    console.warn(`[volumeChunkData] no entityMeta for ${memberId} in pool ${poolKey}`);
    postChunksRequeued(ctx, memberId, msg.chunks, "missing-entity-meta");
    return;
  }
  const lodMeta = entityLodMetas.find(m => m.level === level);
  if (!lodMeta) {
    console.warn(`[volumeChunkData] no lodMeta for level ${level} in entity ${memberId}, has levels [${entityLodMetas.map(m => m.level).join(",")}]`);
    postChunksRequeued(ctx, memberId, msg.chunks, "missing-lod-meta");
    return;
  }

  const evictedKeys: string[] = [];
  const insertedKeys: string[] = []; // composite keys we successfully inserted
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
      if (atlas.slots.has(compositeKey)) continue;

      // A pool grows only once every slot it has holds a chunk.
      if (atlas.freeSlots.length === 0 && atlas.slots.size >= atlas.totalSlots) {
        growVolumeAtlasWatched(ctx, poolKey, atlas);
      }
      let slotIndex: number;
      if (atlas.freeSlots.length > 0) {
        slotIndex = atlas.freeSlots.pop()!;
      } else {
        const { key: evictKey, dist: farthestDist } = findFarthestSlot(ctx.state, atlas);
        if (!evictKey) continue;
        const cam = rayHitForMember(ctx.state, memberId);
        const incomingDist = chunkDistSq(lodMeta, chunk.x, chunk.y, chunk.z, cam);
        // A tie keeps the resident, or mirror-image chunks displace each other
        // on every re-send. A T or C scrub still replaces in place, because the
        // remap unmaps the old selection's slots and they rank at infinite distance.
        if (incomingDist >= farthestDist) continue;
        slotIndex = atlas.slots.get(evictKey)!;
        atlas.slots.delete(evictKey);
        evictedKeys.push(evictKey);
        const oldGridIdx = atlas.slotGridIdx[slotIndex];
        if (oldGridIdx >= 0) {
          atlas.indirectionData[oldGridIdx] = 0xFFFFFFFF;
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
      insertedKeys.push(compositeKey);
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
    if (radiusFilteredKeySet.has(chunk.key)) continue;
    if (failedKeySet.has(chunk.key)) continue;
    const compositeKey = makeCompositeKey(memberId, chunk.key);
    if (!atlas.slots.has(compositeKey)) {
      skippedKeys.push(chunk.key); // report bare chunk key (not composite) for orchestrator
    }
  }

  if (evictedKeys.length > 0 || skippedKeys.length > 0 || radiusFilteredKeys.length > 0 || failedKeys.length > 0) {
    // Eviction keys are composite; each member has its own delivery tracking.
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
    if (skippedKeys.length > 0) {
      postChunksRejected(
        ctx,
        memberId,
        skippedKeys.map(key => ({ key })),
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
    postChunksRequeued(ctx, memberId, failedKeys.map(key => ({ key })), "upload-failed");
    ctx.postWantedSet(ctx.state.memberToDataset.get(memberId));
  }

  if (failure !== null) throw failure;
}

function releaseSlot(atlas: AtlasState, slot: number): void {
  atlas.slotGridIdx[slot] = -1;
  atlas.freeSlots.push(slot);
}
