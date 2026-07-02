/**
 * Volume chunk upload — staleness check, LRU eviction, GPU write,
 * intensity sampling, and per-member post-message demux.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  LabelVolumeChunkDataMessage,
  VolumeChunkDataMessage,
} from "../workerProtocol.ts";
import { writeVolumeChunk } from "../gpuContext.ts";
import { sampleIntensityRange } from "../../zarr/intensitySampler.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import { isStaleDelivery } from "../epochCheck.ts";
import { asUint16, asUint32 } from "../dataTypeUtil.ts";
import {
  parseCompositeKey,
  makeCompositeKey,
} from "../chunkKeys.ts";
import { postChunksRejected, postChunksRequeued } from "../chunkUploadFeedback.ts";
import { chunkAllowedByCurrentRenderRadius } from "../chunkRadius.ts";
import { chunkDistSq, findFarthestSlot, rayHitForMember } from "./eviction.ts";
import { getOrCreateLabelVolumePool } from "./atlas.ts";

/**
 * Write WHOLE uint32 label chunks into the member's r32uint label VOLUME
 * pool. The delivery path (`dispatchLabelVolumeChunkDelivery`) forwards the
 * entire 3D chunk (no plane extraction), so each `chunk.data` is a full
 * `chunkZ*chunkY*chunkX` block of ids placed at the chunk's `(x, y, z)`
 * grid offset. The pool is a single tile reused in place, so a T scrub
 * overwrites resident voxels without blanking. Ids stay at full 32-bit
 * width — no intensity-range sampling (categorical, not scalar). Writes are
 * clamped to the (possibly device-limited) texture. Mirrors
 * `handleLabelSliceChunkData` in 3D and the intensity `handleVolumeChunkData`
 * edge clamping.
 */
export function handleLabelVolumeChunkData(
  ctx: WorkerCtx,
  msg: LabelVolumeChunkDataMessage,
): void {
  // Drop an out-of-date delivery (e.g. a previous timepoint's chunk racing
  // in after the view moved on) so it can't overwrite the pool with the
  // wrong T — same stale guard the intensity path uses.
  if (isStaleDelivery(msg.epochs, ctx.state.currentEpochs)) return;

  const { memberId, datasetId, levelWidth, levelHeight, levelDepth, chunkX, chunkY, chunkZ } = msg;

  // Returns null if the texture can't be allocated — skip the label rather
  // than throw through the upload path (defense in depth; level selection
  // already bounds the size).
  const pool = getOrCreateLabelVolumePool(ctx, memberId, datasetId, levelWidth, levelHeight, levelDepth);
  if (!pool) return;

  for (const chunk of msg.chunks) {
    const xOff = chunk.x * chunkX;
    const yOff = chunk.y * chunkY;
    const zOff = chunk.z * chunkZ;
    // Clamp to the resident texture (dims may be device-limited below the
    // requested level); skip tiles that fall entirely outside it.
    if (xOff >= pool.width || yOff >= pool.height || zOff >= pool.depth) continue;
    const cw = Math.min(chunkX, pool.width - xOff);
    const ch = Math.min(chunkY, pool.height - yOff);
    const cd = Math.min(chunkZ, pool.depth - zOff);
    if (cw <= 0 || ch <= 0 || cd <= 0) continue;
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
      xOff,
      yOff,
      zOff,
      "r32uint",
    );
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

  // Drop entire batch if stale
  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    postChunksRequeued(ctx, memberId, msg.chunks, "stale");
    return;
  }

  const atlas = ctx.state.volumeAtlases.get(poolKey);
  if (!atlas) {
    postChunksRequeued(ctx, memberId, msg.chunks, "missing-pool");
    return; // pool not yet created by cold state handler
  }

  // Debug: detect chunk dims mismatch (pool created for different chunk size)
  if (atlas.chunkX !== chunkX || atlas.chunkY !== chunkY || atlas.chunkZ !== chunkZ) {
    console.warn(`[volumeChunkData] chunkDims mismatch for ${memberId}: pool=[${atlas.chunkX},${atlas.chunkY},${atlas.chunkZ}] msg=[${chunkX},${chunkY},${chunkZ}] level=${level}`);
  }
  // Look up entity's lodMetas
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

  let intensityChanged = false;
  const totalChunks = msg.chunks.length;
  const evictedKeys: string[] = [];
  const insertedKeys: string[] = []; // composite keys we successfully inserted
  const radiusFilteredKeys: string[] = [];
  const radiusFilteredKeySet = new Set<string>();

  for (const chunk of msg.chunks) {
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

    let slotIndex: number;
    if (atlas.freeSlots.length > 0) {
      slotIndex = atlas.freeSlots.pop()!;
    } else {
      const { key: evictKey, dist: farthestDist } = findFarthestSlot(ctx.state, atlas);
      if (!evictKey) continue;
      const cam = rayHitForMember(ctx.state, memberId);
      const incomingDist = chunkDistSq(lodMeta, chunk.x, chunk.y, chunk.z, cam);
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
    const sy = Math.floor(slotIndex / atlas.slotsX) % atlas.slotsY;
    const sz = Math.floor(slotIndex / (atlas.slotsX * atlas.slotsY));

    const data = asUint16(chunk.data, chunk.dataType);
    const xOff = sx * chunkX;
    const yOff = sy * chunkY;
    const zOff = sz * chunkZ;
    const cw = Math.min(chunkX, levelWidth - chunk.x * chunkX);
    const ch = Math.min(chunkY, levelHeight - chunk.y * chunkY);
    const cd = Math.min(chunkZ, levelDepth - chunk.z * chunkZ);

    writeVolumeChunk(ctx.device, atlas.texture, data, chunkX, chunkY, cw, ch, cd, xOff, yOff, zOff);

    // Write to entity's per-LOD indirection section (absolute offset)
    const [, lodGridY, lodGridX] = lodMeta.gridDims;
    const globalIdx = lodMeta.offset + chunk.z * lodGridY * lodGridX + chunk.y * lodGridX + chunk.x;
    if (globalIdx < atlas.indirectionData.length) {
      atlas.indirectionData[globalIdx] = slotIndex;
      atlas.slotGridIdx[slotIndex] = globalIdx;
    }
    atlas.slots.set(compositeKey, slotIndex);
    insertedKeys.push(compositeKey);
    atlas.indirectionDirty = true;

    const perChunkSamples = Math.floor(100000 / Math.max(1, totalChunks));
    const { min, max } = sampleIntensityRange(data, perChunkSamples);
    if (min < atlas.intensityMin) { atlas.intensityMin = min; intensityChanged = true; }
    if (max > atlas.intensityMax) { atlas.intensityMax = max; intensityChanged = true; }
  }

  // Report chunks from the batch that the pool did not keep
  const skippedKeys: string[] = [];
  for (const chunk of msg.chunks) {
    if (radiusFilteredKeySet.has(chunk.key)) continue;
    const compositeKey = makeCompositeKey(memberId, chunk.key);
    if (!atlas.slots.has(compositeKey)) {
      skippedKeys.push(chunk.key); // report bare chunk key (not composite) for orchestrator
    }
  }

  // Report evicted/skipped chunks. Convert composite eviction keys back to (memberId, chunkKey)
  // so the orchestrator can clear the right delivery tracking.
  if (evictedKeys.length > 0 || skippedKeys.length > 0 || radiusFilteredKeys.length > 0) {
    // Group evicted keys by memberId (each entity has its own delivery tracking)
    const evictedByMember = new Map<string, string[]>();
    for (const ck of evictedKeys) {
      const parsed = parseCompositeKey(ck);
      if (!parsed) continue;
      const arr = evictedByMember.get(parsed.memberId) ?? [];
      arr.push(parsed.chunkKey);
      evictedByMember.set(parsed.memberId, arr);
    }
    // Report evictions per member
    for (const [evMember, evKeys] of evictedByMember) {
      ctx.post({ type: "chunksEvicted", memberId: evMember, keys: evKeys, skipped: [], reason: "evicted" });
    }
    // Report skipped (this batch's member only)
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
    ctx.postWantedSet();
  }

  if (intensityChanged) {
    ctx.post({ type: "intensityRange", datasetId: memberId, min: atlas.intensityMin, max: atlas.intensityMax });
  }
}
