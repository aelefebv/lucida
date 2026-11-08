/**
 * Slice chunk upload: staleness check, admission against the planner's
 * wanted keys, eviction, GPU write, intensity sampling, and the residency
 * report for every chunk.
 *
 * Re-cuts a resident chunk in place when the plane the current Z maps to is
 * not the one its slot holds. Pairs with `slice/zRetarget.ts`.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type {
  ChunkFeedbackReason,
  LabelSliceChunkDataMessage,
  SliceChunkDataMessage,
} from "../workerProtocol.ts";
import { writeSliceRegion } from "../gpuContext.ts";
import { sampleIntensityRange } from "../../zarr/intensitySampler.ts";
import type { SceneEpochs } from "../../pipeline/epochs.ts";
import { isStaleDelivery } from "../epochCheck.ts";
import { asUint16Slice, asUint32Slice } from "../dataTypeUtil.ts";
import { makeCompositeKey } from "../chunkKeys.ts";
import { postChunkResidency, ResidencyBatch } from "../chunkUploadFeedback.ts";
import { mayEvict } from "../eviction.ts";
import { sliceLevelZ } from "../slicePlane.ts";
import { wantedChunksFor } from "../wantedChunks.ts";
import { cameraUVForMember, chunkDistSq2D, findEvictionSlot2D } from "./eviction.ts";
import { getOrCreateLabelSlicePool } from "./atlas.ts";

/**
 * Write pre-sliced uint32 label planes into the member's r32uint label pool.
 * The delivery path already extracted the current Z-plane, so each
 * `chunk.data` is `chunkY*chunkX` ids. Ids are categorical, so they keep full
 * 32-bit width and get no intensity sampling.
 */
export function handleLabelSliceChunkData(
  ctx: WorkerCtx,
  msg: LabelSliceChunkDataMessage,
): void {
  // A previous timepoint's plane racing in must not overwrite the pool.
  if (isStaleDelivery(msg.epochs, ctx.state.currentEpochs)) return;

  const { memberId, datasetId, levelWidth, levelHeight, chunkX, chunkY } = msg;

  const pool = getOrCreateLabelSlicePool(ctx, memberId, datasetId, levelWidth, levelHeight);
  if (!pool) return;

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

  const levelZ = sliceLevelZ(fullResZ, fullResDepth, levelDepth);
  const targetChunkZ = Math.floor(levelZ / chunkZ);
  const localZ = levelZ - targetChunkZ * chunkZ;
  const wanted = wantedChunksFor(ctx.state, memberId, tier);

  let intensityChanged = false;
  const perChunkSamples = Math.floor(10000 / Math.max(1, msg.chunks.length));
  const batch = new ResidencyBatch();

  for (const chunk of msg.chunks) {
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
      const victim = findEvictionSlot2D(ctx.state, atlas, tier);
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

    const sx = slotIndex % atlas.slotsX;
    const sy = Math.floor(slotIndex / atlas.slotsX);
    const chunkW = Math.min(chunkX, levelWidth - chunk.x * chunkX);
    const chunkH = Math.min(chunkY, levelHeight - chunk.y * chunkY);
    const sliceOffset = localZ * chunkY * chunkX;
    const sliceData = asUint16Slice(chunk.data, chunk.dataType, sliceOffset, chunkY * chunkX);

    const xOff = sx * chunkX;
    const yOff = sy * chunkY;
    writeSliceRegion(ctx.device, atlas.texture, sliceData, chunkX, xOff, yOff, chunkW, chunkH);

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
  }

  batch.post(ctx, memberId, tier);
  if (batch.displacedAny) ctx.postWantedSet(ctx.state.memberToDataset.get(memberId));

  if (intensityChanged) {
    ctx.post({ type: "intensityRange", datasetId: memberId, min: atlas.intensityMin, max: atlas.intensityMax });
  }
}
