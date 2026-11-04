/**
 * Cold-state ingestion orchestrator: rebuilds the worker's routing
 * registries, pools, indirection sections, and descriptor buffer for one
 * dataset from a cold-state message.
 *
 * The descriptor build reads `currentSourcesByDataset`, the sections this
 * cold state produced, rather than the pools, so it never picks up stale
 * offsets from pools an earlier cold state laid out with different levels.
 */

import type { WorkerCtx } from "../workerContext.ts";
import type { ColdStateMessage } from "../workerProtocol.ts";
import {
  buildDescriptorBuffer,
  destroyDescriptorBuffer,
  iterateColdMembers,
} from "../descriptorBuffer.ts";
import { targetLevelOf, type EntitySource } from "../entitySources.ts";
import {
  getOrCreateVolumePool,
  resizeIndirection,
  remapIndirection,
  type LodIndirectionMeta,
} from "../volume/index.ts";
import {
  getOrCreateSlicePool,
  resizeSliceIndirection,
  remapSliceIndirection,
} from "../slice/index.ts";
import { reconcileProxyResidency } from "../proxy/residency.ts";
import { groupEntriesByPool } from "./groupEntries.ts";
import { computeEntityTierMeta } from "./entityMetas.ts";
import { sourceKey } from "../poolKeys.ts";

/** Apply a cold-state message. The caller posts the wanted-set afterward. */
export function applyColdState(ctx: WorkerCtx, msg: ColdStateMessage): void {
  const state = ctx.state;

  // 1. Rebuild this dataset's group→tiles entries so group-proxy uploads can
  // fan out to child tiles. Other datasets' entries stay untouched.
  const prevGroups = state.groupsByDataset.get(msg.datasetId);
  if (prevGroups) {
    for (const groupId of prevGroups) state.groupToTiles.delete(groupId);
  }
  const groupsForDataset = new Set<string>();
  for (const entry of msg.activeSet) {
    if (entry.parentGroupId) {
      let set = state.groupToTiles.get(entry.parentGroupId);
      if (!set) {
        set = new Set();
        state.groupToTiles.set(entry.parentGroupId, set);
      }
      set.add(entry.entityId);
      groupsForDataset.add(entry.parentGroupId);
    }
  }
  if (groupsForDataset.size > 0) {
    state.groupsByDataset.set(msg.datasetId, groupsForDataset);
  } else {
    state.groupsByDataset.delete(msg.datasetId);
  }

  if (msg.desiredProxyKeys !== undefined) {
    const evicted = reconcileProxyResidency(state, msg.datasetId, msg.desiredProxyKeys);
    state.proxyStats.evicted += evicted;
    state.proxyStats.evictedPolicy += evicted;
  }

  for (const [memberId, datasetId] of state.memberToDataset) {
    if (datasetId !== msg.datasetId) continue;
    state.memberSourcePools.delete(memberId);
  }

  // 2. Register member→dataset mappings and target levels. Canonical
  // iteration produces the same memberId scheme as the rest of the pipeline.
  for (const { entry, memberId } of iterateColdMembers(msg)) {
    state.memberToDataset.set(memberId, msg.datasetId);
    const target = targetLevelOf(entry);
    if (target === undefined) state.targetLevelByMember.delete(memberId);
    else state.targetLevelByMember.set(memberId, target);
  }

  // 3. Partition activeSet by (tier, channel, chunkDims). Entries with no
  // chunk levels are skipped here but stay in memberToDataset from step 2.
  const mode: "volume" | "slice" = msg.viewMode;
  const dimArity: 2 | 3 = mode === "volume" ? 3 : 2;
  const groups = groupEntriesByPool(msg, mode);

  const currentSources = new Map<string, EntitySource[]>();

  // 4. Per group: allocate the pool, lay out one section per (member,
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
        let pools = state.memberSourcePools.get(memberId);
        if (!pools) {
          pools = new Map();
          state.memberSourcePools.set(memberId, pools);
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

    if (mode === "volume") {
      const atlas = getOrCreateVolumePool(
        ctx, group.poolKey, pcX, pcY, pcZ, msg.currentT, group.channel,
      );
      atlas.entityMetas = newEntityMetas;
      resizeIndirection(ctx, atlas, offset);
      remapIndirection(atlas, msg.currentT, group.channel, {
        visibleRegion: msg.visibleRegion,
        renderRadiusView: msg.renderRadiusView?.[group.tier],
        entryByMember,
      });
    } else {
      const atlas = getOrCreateSlicePool(
        ctx, group.poolKey, pcX, pcY, msg.currentZ, msg.currentT, group.channel,
      );
      atlas.entityMetas = newEntityMetas;
      resizeSliceIndirection(ctx, atlas, offset);
      remapSliceIndirection(atlas, msg.currentT, group.channel, msg.currentZ, {
        visibleRegion: msg.visibleRegion,
        renderRadiusView: msg.renderRadiusView?.[group.tier],
        entryByMember,
      });
    }
  }

  state.currentSourcesByDataset.set(msg.datasetId, currentSources);

  // 5. Rebuild the descriptor buffer from scratch, like the sections.
  const oldDesc = state.descriptorBuffersByDataset.get(msg.datasetId);
  if (oldDesc) destroyDescriptorBuffer(oldDesc);
  state.descriptorBuffersByDataset.set(
    msg.datasetId,
    buildDescriptorBuffer(
      ctx.device,
      msg,
      state.proxyDescriptorsByEntity,
      state.proxyPoolsByDataset,
      currentSources,
    ),
  );
}
