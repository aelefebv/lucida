/**
 * Slice chunk upload: staleness check, admission against the planner's
 * wanted keys, eviction, GPU write, and the residency report for every
 * chunk.
 *
 * Each delivery is the one plane the page cut for a view's Z. It is written
 * once, into the pool every view of the dataset shares, and mapped into each
 * view that draws that plane. It takes the slot of another plane of the same
 * chunk that no view draws any more, so a move through one chunk re-cuts it
 * in place. Pairs with `slice/zRetarget.ts`.
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
import { makeSliceSlotKey } from "../chunkKeys.ts";
import { LABEL_TIER, postChunkResidency, ResidencyBatch } from "../chunkUploadFeedback.ts";
import { incomingDistSq, mayEvict } from "../eviction.ts";
import type { PoolCut } from "../slicePlane.ts";
import { anyViewWants } from "../worker/draws.ts";
import { GpuRoom } from "../worker/gpuBudget.ts";
import { anySection, anyViewHolds, mapSlot, sectionOf, unmapSlot } from "../viewIndirection.ts";
import { sliceEvictionParams } from "./eviction.ts";
import {
  dropSliceSlot,
  getOrCreateLabelSlicePool,
  growSlicePoolWithin,
  heldPlanesOf,
  holdSliceSlot,
  labelCellKey,
  type SliceAtlasState,
} from "./atlas.ts";
import { drawsPlane, viewDrawsPlane } from "./zRetarget.ts";

/**
 * Write pre-sliced uint32 label planes into the r32uint pool of the label's
 * form they were cut for, its plane along its axis at its chunk-T. The
 * delivery path already extracted the plane, so each `chunk.data` is
 * `chunkY*chunkX` ids, in the frame of the plane drawn. Ids are categorical,
 * so they keep full 32-bit width. Each cell records the plane it holds, which
 * it keeps drawing when the pool moves to another plane.
 */
export function handleLabelSliceChunkData(
  ctx: WorkerCtx,
  msg: LabelSliceChunkDataMessage,
): void {
  const { memberId, datasetId, levelWidth, levelHeight, chunkX, chunkY } = msg;
  const cut: PoolCut = { axis: msg.sliceAxis ?? "z", plane: msg.plane };
  const refuseAll = (reason: ChunkFeedbackReason): void =>
    postChunkResidency(ctx, memberId, "slice", LABEL_TIER, "refused", msg.chunks.map(c => c.key), reason, cut);

  // A previous timepoint's plane racing in must not overwrite the pool.
  if (isStaleDelivery(msg.epochs, ctx.state.currentEpochs)) {
    refuseAll("stale");
    return;
  }

  const pool = getOrCreateLabelSlicePool(
    ctx, memberId, datasetId, msg.t, msg.plane, levelWidth, levelHeight, chunkX, chunkY, cut.axis,
  );
  if (!pool) {
    // Nothing of the batch is resident, so the page must not count it as sent.
    refuseAll("atlas-policy");
    return;
  }

  const batch = new ResidencyBatch(cut);
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
  batch.post(ctx, memberId, "slice", LABEL_TIER);
  // After held, so a chunk this batch wrote and then overwrote ends lost.
  postChunkResidency(ctx, memberId, "slice", LABEL_TIER, "lost", replaced, "replaced", cut);
}

export function handleSliceChunkData(
  ctx: WorkerCtx,
  msg: SliceChunkDataMessage,
  currentEpochs: SceneEpochs | null,
  poolKey: string,
  memberId: string,
): void {
  const { level, levelWidth, levelHeight, chunkX, chunkY, chunkZ, fullResDepth, levelDepth } = msg;

  const { tier } = msg;
  const cut: PoolCut = { axis: msg.sliceAxis ?? "z", plane: msg.plane };
  const refuseAll = (reason: ChunkFeedbackReason): void =>
    postChunkResidency(ctx, memberId, "slice", tier, "refused", msg.chunks.map(c => c.key), reason, cut);

  if (isStaleDelivery(msg.epochs, currentEpochs)) {
    refuseAll("stale");
    return;
  }

  const atlas = ctx.state.sliceAtlases.get(poolKey);
  if (!atlas) {
    refuseAll("missing-pool");
    return;
  }

  // The page cuts a plane for the view as it stands, which can run ahead of
  // the cold state that routes it here. A plane cut along another axis, or
  // for other chunk dims, belongs to another pool: written here it would read
  // as this pool's plane, or reach past its texture. The page sends it again
  // once the cold state catches up.
  if ((msg.sliceAxis ?? "z") !== atlas.axis || atlas.chunkX !== chunkX || atlas.chunkY !== chunkY) {
    refuseAll("wrong-slice");
    return;
  }
  if (!anyViewHolds(atlas, memberId)) {
    console.warn(`[sliceChunkData] no view lays out ${memberId} in pool ${poolKey}`);
    refuseAll("missing-entity-meta");
    return;
  }
  if (!anySection(atlas, memberId, level)) {
    console.warn(`[sliceChunkData] no view lays out level ${level} of ${memberId} in pool ${poolKey}`);
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

  const levelZ = msg.plane;
  const targetChunkZ = Math.floor(levelZ / chunkZ);

  const batch = new ResidencyBatch(cut);
  // Planes of the batch's chunks whose slots it took, by plane: no view draws
  // them, and the page counts them held until it hears they are gone.
  const replaced = new Map<number, string[]>();
  const room = new GpuRoom(ctx.state);
  let failure: unknown = null;

  for (const chunk of msg.chunks) {
    let claimed = -1;
    try {
      if (atlas.slots.has(makeSliceSlotKey(memberId, chunk.key, levelZ))) {
        batch.held.push(chunk.key);
        continue;
      }
      if (!anyViewWants(atlas, memberId, tier, chunk.key)) {
        batch.refuse(chunk.key, "unwanted");
        continue;
      }
      // The planner's keys and this cut map Z through one function, so a wanted
      // chunk holds the plane unless the sender's Z is not the cold state's.
      if (chunk.z !== targetChunkZ) {
        batch.refuse(chunk.key, "wrong-slice");
        continue;
      }

      const taken = takeUndrawnPlane(atlas, memberId, chunk.key, level, msg.t);
      const existingSlot = taken?.slot;
      if (taken) {
        const keys = replaced.get(taken.plane);
        if (keys) keys.push(chunk.key);
        else replaced.set(taken.plane, [chunk.key]);
      }
      // A pool grows only once every slot it has holds a chunk, and freely
      // only while the GPU total has room (`worker/gpuBudget.ts`).
      if (existingSlot === undefined && atlas.freeSlots.length === 0 && atlas.slots.size >= atlas.totalSlots) {
        growSlicePoolWithin(ctx, poolKey, atlas, false, room);
      }
      let slotIndex: number;
      if (existingSlot !== undefined) {
        slotIndex = existingSlot;
      } else if (atlas.freeSlots.length > 0) {
        slotIndex = atlas.freeSlots.pop()!;
      } else {
        const params = sliceEvictionParams(ctx.state, atlas, tier);
        const victim = atlas.order.next(params);
        if (
          victim?.class === "wanted" && atlas.slots.size >= atlas.totalSlots &&
          growSlicePoolWithin(ctx, poolKey, atlas, true, room)
        ) {
          slotIndex = atlas.freeSlots.pop()!;
        } else {
          const incomingDist = () => incomingDistSq(params, memberId, { level, x: chunk.x, y: chunk.y, z: chunk.z });
          if (!victim || !mayEvict(victim, incomingDist)) {
            batch.refuse(chunk.key, "atlas-policy");
            continue;
          }
          slotIndex = atlas.slots.get(victim.key)!;
          dropSliceSlot(atlas, victim.key);
          batch.evicted.push(victim.key);
          unmapSlot(atlas, slotIndex);
        }
      }
      claimed = slotIndex;

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

      // Each view that draws this plane maps it. A plane cut ahead of a
      // view's cold state is held, but its cell keeps showing the plane the
      // view draws until a remap moves it.
      for (const view of atlas.views.values()) {
        if (!viewDrawsPlane(atlas, view, memberId, level, msg.t, levelZ)) continue;
        const meta = sectionOf(view, memberId, level)!;
        mapSlot(view, meta.offset + chunk.y * meta.gridDims[2] + chunk.x, slotIndex);
      }
      holdSliceSlot(atlas, memberId, chunk.key, levelZ, slotIndex);
      claimed = -1;
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

  batch.post(ctx, memberId, "slice", tier);
  for (const [plane, keys] of replaced) {
    postChunkResidency(ctx, memberId, "slice", tier, "lost", keys, "replaced", { axis: atlas.axis, plane });
  }
  if (batch.displacedAny) ctx.postWantedSet(ctx.state.memberToDataset.get(memberId), "slice");

  if (failure !== null) throw failure;
}

/**
 * Free the slot of a plane of `chunkKey` that no view draws, and return it
 * and the plane it held for the arriving plane, or undefined when there is
 * none.
 */
function takeUndrawnPlane(
  atlas: SliceAtlasState,
  memberId: string,
  chunkKey: string,
  level: number,
  t: number,
): { slot: number; plane: number } | undefined {
  const held = heldPlanesOf(atlas, memberId, chunkKey);
  if (!held) return undefined;
  for (const [plane, slot] of held) {
    if (drawsPlane(atlas, memberId, level, t, plane)) continue;
    dropSliceSlot(atlas, makeSliceSlotKey(memberId, chunkKey, plane));
    unmapSlot(atlas, slot);
    return { slot, plane };
  }
  return undefined;
}

function releaseSlot(atlas: SliceAtlasState, slot: number): void {
  unmapSlot(atlas, slot);
  atlas.freeSlots.push(slot);
}
