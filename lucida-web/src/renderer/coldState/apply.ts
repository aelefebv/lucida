/**
 * Cold-state ingestion orchestrator: rebuilds the worker's routing
 * registries, pools, indirection sections, and descriptor buffer for one
 * dataset's pools of one mode from a cold-state message. The dataset's pools
 * of the other mode are another cold state's, and this one leaves them be.
 *
 * The descriptor build reads the sections this cold state produced rather
 * than the pools, so it never picks up stale offsets from pools an earlier
 * cold state laid out with different levels.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ColdStateMessage, PoolMode } from "../workerProtocol.ts";
import { destroyDescriptorBuffer, iterateColdMembers, rebuildDescriptorBuffer } from "../descriptorBuffer.ts";
import { targetLevelOf, type EntitySource } from "../entitySources.ts";
import {
  getOrCreateVolumePool,
  removeLabelVolumePoolsForDataset,
  removeVolumeAtlasesForDataset,
  resizeIndirection,
  remapIndirection,
  type LodIndirectionMeta,
} from "../volume/index.ts";
import {
  getOrCreateSlicePool,
  removeLabelSlicePoolsForDataset,
  removeSliceAtlasesForDataset,
  resizeSliceIndirection,
  remapSliceIndirection,
} from "../slice/index.ts";
import { groupEntriesByPool, type PoolGroup } from "./groupEntries.ts";
import { computeEntityTierMeta } from "./entityMetas.ts";
import { datasetModeKey, sourceKey } from "../poolKeys.ts";
import { postFreedPools } from "../chunkUploadFeedback.ts";
import { indexWantedChunks, wantedEntryKey, type WantedChunkIndex } from "../wantedChunks.ts";
import { renderRadiusEnabled } from "../../pipeline/renderRadius.ts";
import type { RemapInputs } from "../worker/state.ts";

/**
 * The failed chunks a pool's members want in its tier, by member. Only wanted
 * ones are marked: the detail tier wants its target level and the coarse tier
 * its coarse level, so a failed chunk at a coarser stand-in level stays a
 * miss and the chain falls through it. The wanted set is this cold state's,
 * so a list from before a scrub never marks the new plane.
 */
function failedInGroup(
  state: WorkerCtx["state"],
  datasetId: string,
  wanted: WantedChunkIndex,
  group: PoolGroup,
): Map<string, Set<string>> | undefined {
  const failedByImage = state.failedByDataset.get(datasetId);
  if (!failedByImage) return undefined;
  const out = new Map<string, Set<string>>();
  for (const { entry, memberId } of group.entries) {
    if (out.has(memberId)) continue;
    const failed = failedByImage.get(entry.imageId);
    const want = wanted.get(wantedEntryKey(group.tier, memberId));
    if (!failed || !want) continue;
    const keys = new Set<string>();
    for (const key of failed) if (want.has(key)) keys.add(key);
    if (keys.size > 0) out.set(memberId, keys);
  }
  return out;
}

/** Whether two pool layouts give every member the same sections at the same offsets. */
function sameSections(
  held: ReadonlyMap<string, readonly LodIndirectionMeta[]>,
  next: ReadonlyMap<string, readonly LodIndirectionMeta[]>,
): boolean {
  if (held.size !== next.size) return false;
  for (const [memberId, metas] of next) {
    const was = held.get(memberId);
    if (!was || was.length !== metas.length) return false;
    for (let i = 0; i < metas.length; i++) {
      const a = was[i];
      const b = metas[i];
      if (
        a.level !== b.level || a.offset !== b.offset ||
        a.gridDims[0] !== b.gridDims[0] || a.gridDims[1] !== b.gridDims[1] || a.gridDims[2] !== b.gridDims[2]
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Whether a pool's indirection already says what a remap would write. A remap
 * walks every resident slot, and uploads and evictions keep the indirection
 * current between cold states, so a pool whose sections, T and plane are the
 * ones it was last remapped for, with no render radius or failed marks either
 * time, would only rebuild what it holds. On a view move that is every pool
 * whose members stayed put, such as a collection's coarse pools.
 */
function remapHolds(
  state: WorkerCtx["state"],
  atlas: { entityMetas: Map<string, LodIndirectionMeta[]>; indirectionData: Uint32Array },
  metas: Map<string, LodIndirectionMeta[]>,
  totalEntries: number,
  inputs: RemapInputs,
): boolean {
  const last = state.remappedFor.get(atlas);
  return last !== undefined &&
    !last.viewDependent && !inputs.viewDependent &&
    last.t === inputs.t && last.z === inputs.z &&
    atlas.indirectionData.length === totalEntries &&
    sameSections(atlas.entityMetas, metas);
}

/** Apply a cold-state message. The caller posts the wanted-set afterward. */
export function applyColdState(ctx: WorkerCtx, msg: ColdStateMessage): void {
  const state = ctx.state;
  const mode = msg.viewMode;
  const key = datasetModeKey(msg.datasetId, mode);
  const routes = state.memberSourcePools[mode];
  const targetLevels = state.targetLevelByMember[mode];

  const wanted = indexWantedChunks(msg.wantedChunks);
  state.wantedByDatasetMode.set(key, wanted);

  for (const [memberId, datasetId] of state.memberToDataset) {
    if (datasetId !== msg.datasetId) continue;
    routes.delete(memberId);
  }

  // 1. Register member→dataset mappings and target levels. Canonical
  // iteration produces the same memberId scheme as the rest of the pipeline.
  for (const { entry, memberId } of iterateColdMembers(msg)) {
    state.memberToDataset.set(memberId, msg.datasetId);
    const target = targetLevelOf(entry);
    if (target === undefined) targetLevels.delete(memberId);
    else targetLevels.set(memberId, target);
  }

  // 2. Partition activeSet by (tier, channel, chunkDims). Entries with no
  // chunk levels are skipped here but stay in memberToDataset from step 2.
  const dimArity: 2 | 3 = mode === "volume" ? 3 : 2;
  const groups = groupEntriesByPool(msg, mode);

  const currentSources = new Map<string, EntitySource[]>();

  // 3. Per group: allocate the pool, lay out one section per (member,
  // level) at sequential offsets, resize + remap its indirection.
  for (const group of groups.values()) {
    const [pcZ, pcY, pcX] = group.chunkDims;
    const newEntityMetas = new Map<string, LodIndirectionMeta[]>();
    const entryByMember = new Map<string, {
      layoutPositionVox?: [number, number];
      levels: Array<{
        level: number;
        chunkShape: [number, number, number];
        levelDims: [number, number, number];
      }>;
    }>();
    let offset = 0;

    for (const { entry, memberId, tier, level } of group.entries) {
      entryByMember.set(memberId, {
        layoutPositionVox: entry.layoutPositionVox,
        levels: entry.levels,
      });
      const { meta, nextOffset } = computeEntityTierMeta(
        entry,
        level,
        group.chunkDims,
        offset,
        dimArity,
      );
      if (meta) {
        let pools = routes.get(memberId);
        if (!pools) {
          pools = new Map();
          routes.set(memberId, pools);
        }
        pools.set(sourceKey(tier, level), group.poolKey);
        const metas = newEntityMetas.get(memberId);
        if (metas) metas.push(meta);
        else newEntityMetas.set(memberId, [meta]);
        const sources = currentSources.get(memberId);
        const source: EntitySource = { tier, poolKey: group.poolKey, meta };
        if (sources) sources.push(source);
        else currentSources.set(memberId, [source]);
      }
      offset = nextOffset;
    }

    const failed = failedInGroup(state, msg.datasetId, wanted, group);
    const radius = msg.renderRadiusView?.[group.tier];
    const viewDependent = (radius !== undefined && renderRadiusEnabled(radius)) || (failed?.size ?? 0) > 0;
    if (mode === "volume") {
      const atlas = getOrCreateVolumePool(
        ctx, group.poolKey, msg.datasetId, pcX, pcY, pcZ, msg.currentT, group.channel, msg.sampleFormat,
      );
      const inputs: RemapInputs = { t: msg.currentT, z: 0, viewDependent };
      const holds = remapHolds(state, atlas, newEntityMetas, offset, inputs);
      atlas.entityMetas = newEntityMetas;
      if (!holds) {
        resizeIndirection(ctx, atlas, offset);
        remapIndirection(atlas, msg.currentT, group.channel, {
          visibleRegion: msg.visibleRegion,
          renderRadiusView: radius,
          entryByMember,
          failed,
        });
        state.remappedFor.set(atlas, inputs);
      }
    } else {
      const atlas = getOrCreateSlicePool(
        ctx, group.poolKey, msg.datasetId, pcX, pcY, msg.currentZ, msg.currentT, group.channel,
        msg.sampleFormat,
      );
      atlas.axis = msg.sliceAxis ?? "z";
      const inputs: RemapInputs = { t: msg.currentT, z: msg.currentZ, viewDependent };
      const holds = remapHolds(state, atlas, newEntityMetas, offset, inputs);
      atlas.entityMetas = newEntityMetas;
      if (!holds) {
        resizeSliceIndirection(ctx, atlas, offset);
        remapSliceIndirection(atlas, msg.currentT, group.channel, msg.currentZ, {
          visibleRegion: msg.visibleRegion,
          renderRadiusView: radius,
          entryByMember,
          failed,
        });
        state.remappedFor.set(atlas, inputs);
      }
    }
  }

  // 4. Free this dataset's pools of this mode that no group above names: a
  // hidden channel, another slice axis, or a chunk shape no resident level
  // uses. Nothing routes to them now, so nothing would sample them again.
  // Their chunks are reported lost, so the page resends what a recreated pool
  // needs. The other mode's pools belong to its own cold state, and go once
  // no view draws the dataset in that mode (`releaseUndrawnPools`).
  const referenced = new Set(groups.keys());
  postFreedPools(ctx, msg.datasetId, mode, referenced);
  if (mode === "volume") removeVolumeAtlasesForDataset(ctx, msg.datasetId, referenced);
  else removeSliceAtlasesForDataset(ctx, msg.datasetId, referenced);
  // A side view draws no label overlay. Its chunks are reported lost, so a
  // return to an XY cut sends them again.
  if (mode === "slice" && msg.sliceAxis) removeLabelSlicePoolsForDataset(ctx, msg.datasetId, "freed");

  state.currentSourcesByDatasetMode.set(key, currentSources);

  // 5. Rebuild the descriptor buffer's contents from scratch, like the sections.
  state.descriptorBuffersByDatasetMode.set(
    key,
    rebuildDescriptorBuffer(ctx.device, state.descriptorBuffersByDatasetMode.get(key), msg, currentSources),
  );
}

/**
 * Free the dataset's pools of each mode no view draws it in, as
 * {@link releasePools} does. A cold state names the modes that draw it, so a
 * page that starts over with another view still frees what an earlier one
 * left.
 */
export function releaseUndrawnPools(ctx: WorkerCtx, datasetId: string, drawn: readonly PoolMode[]): void {
  for (const mode of ["slice", "volume"] as const) {
    if (!drawn.includes(mode)) releasePools(ctx, datasetId, mode);
  }
}

/**
 * Free a dataset's pools of `mode`, its label pools of that mode included,
 * and what the worker kept to lay them out, once no view draws the dataset
 * from them. Their chunks are reported lost, so a view that draws from them
 * again has them sent again.
 */
function releasePools(ctx: WorkerCtx, datasetId: string, mode: PoolMode): void {
  const state = ctx.state;
  const key = datasetModeKey(datasetId, mode);
  const none = new Set<string>();
  postFreedPools(ctx, datasetId, mode, none);
  if (mode === "volume") {
    removeVolumeAtlasesForDataset(ctx, datasetId, none);
    removeLabelVolumePoolsForDataset(ctx, datasetId, "freed");
  } else {
    removeSliceAtlasesForDataset(ctx, datasetId, none);
    removeLabelSlicePoolsForDataset(ctx, datasetId, "freed");
  }
  const desc = state.descriptorBuffersByDatasetMode.get(key);
  if (desc) destroyDescriptorBuffer(desc);
  state.descriptorBuffersByDatasetMode.delete(key);
  state.currentSourcesByDatasetMode.delete(key);
  state.coldStateByDatasetMode.delete(key);
  state.wantedByDatasetMode.delete(key);
  for (const [memberId, owner] of state.memberToDataset) {
    if (owner !== datasetId) continue;
    state.memberSourcePools[mode].delete(memberId);
    state.targetLevelByMember[mode].delete(memberId);
  }
  if (state.currentColdState?.datasetId === datasetId && state.currentColdState.viewMode === mode) {
    state.currentColdState = null;
  }
}
