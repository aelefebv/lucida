/**
 * Slice chunk upload — staleness check, Z-slice filter, LRU eviction,
 * GPU write, intensity sampling, and per-member post-message demux.
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
import { asUint16Slice, asUint32Slice } from "../dataTypeUtil.ts";
import { parseCompositeKey, makeCompositeKey } from "../chunkKeys.ts";
import { postChunksRejected, postChunksRequeued } from "../chunkUploadFeedback.ts";
import { chunkAllowedByCurrentRenderRadius } from "../chunkRadius.ts";
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

    const isU8 = chunk.dataType === "uint8" || chunk.dataType === "Uint8";
    const isLabelPool = atlas.format === "r32uint";
    // Label pools never contribute to the intensity window — a mask is tinted
    // by its LUT, not contrast-mapped — so skip intensity sampling for them.
    // Intensity pools sample as before (u8 or u16 native, never u32 here).
    if (!isLabelPool) {
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
    }

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
      // Keep the label sample cache in lockstep with atlas residency: a chunk
      // evicted from a label pool loses its CPU slice too (bounded cache).
      if (isLabelPool) ctx.state.labelSamples.evict(evictKey);
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
    // Label pools decode the Z slice as u32 (untruncated ids) and write to the
    // r32uint atlas; intensity pools stay on the u16 path.
    const sliceData = isLabelPool
      ? asUint32Slice(chunk.data, chunk.dataType, sliceOffset, chunkY * chunkX)
      : asUint16Slice(chunk.data, chunk.dataType, sliceOffset, chunkY * chunkX);

    const xOff = sx * chunkX;
    const yOff = sy * chunkY;
    writeSliceRegion(
      ctx.device, atlas.texture, sliceData, chunkX, xOff, yOff, chunkW, chunkH,
      atlas.format,
    );

    // Retain the decoded current-Z slice on the CPU for hover sampling. Only
    // label pools (r32uint) — an intensity slice is never picked for an id. The
    // slice is the same chunkY×chunkX plane just written to the atlas; the store
    // copies it and keeps exactly one plane per resident chunk (bounded by the
    // atlas slot set). Its geometry comes from the level's lodMeta.
    if (isLabelPool) {
      ctx.state.labelSamples.recordGeom(memberId, {
        level: lodMeta.level,
        levelDims: lodMeta.levelDims,
        gridDims: lodMeta.gridDims,
        chunkDims: lodMeta.chunkDims,
      });
      ctx.state.labelSamples.putSlice(
        memberId,
        chunk.key,
        level,
        chunk.x,
        chunk.y,
        chunkW,
        chunkH,
        sliceData as Uint32Array,
      );
    }

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
    ctx.postWantedSet();
  }

  if (intensityChanged) {
    ctx.post({ type: "intensityRange", datasetId: memberId, min: atlas.intensityMin, max: atlas.intensityMax });
  }
}
