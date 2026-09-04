/**
 * Cold-state ingestion orchestrator.
 *
 * Reads + writes per-worker registries via `ctx.state.*`:
 *   - `memberToDataset` / `memberSourcePools` — routing registries used
 *     by chunk + render handlers to look up which dataset a memberId
 *     belongs to and which pool each of its (tier, level) sections lives
 *     in.
 *   - `targetLevelByMember` — each member's target level, read by pool
 *     eviction so a chunk finer than the target leaves first.
 *   - `groupToTiles` — group → child-tile set, used so a `GroupProxy3D`
 *     upload can fan out to its child tiles' descriptors.
 *   - `groupsByDataset` — dataset → groups currently referenced in
 *     groupToTiles; tracked so `removeLayerResources` can drop a
 *     dataset's entries without scanning every group.
 *   - `currentSourcesByDataset` — per-dataset sections snapshot for the
 *     most recent cold state. The descriptor buffer build pulls from
 *     this so it doesn't pick up stale offsets from pools that belonged
 *     to earlier cold states with different levels.
 *   - `descriptorBuffersByDataset` — per-dataset descriptor buffer
 *     (rebuilt fresh each cold state).
 *
 * `proxyDescriptorsByEntity` + `proxyPoolsByDataset` are reconciled
 * against `desiredProxyKeys` when present, then read by the descriptor
 * build so evicted proxies do not leave stale handles behind.
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

/**
 * Apply a cold-state message: refresh group→tiles, register
 * member→dataset mappings, build pool groups, allocate atlases, compute
 * + write one indirection section per (member, tier, level), resize +
 * remap indirection, capture the per-dataset sections snapshot, rebuild
 * the descriptor buffer.
 *
 * Caller is responsible for posting the wanted-set after this returns
 * (kept outside so this function has a single concern).
 */
export function applyColdState(ctx: WorkerCtx, msg: ColdStateMessage): void {
  const state = ctx.state;

  // 1. Refresh group→tiles map so group-proxy uploads can fan out to
  // child tiles' descriptors. Cold state is the source of truth for
  // active set membership; we rebuild this dataset's contribution
  // fully each tick. Other datasets' entries stay untouched so the
  // worker can hold multiple datasets concurrently.
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

  // 2. Register member→dataset mappings and target levels for every
  // (entry, channel) combo. Canonical iteration walks activeSet ×
  // visibleChannels and produces the same memberId scheme used elsewhere
  // in the pipeline (imageId for tiles, entityId for group-as-proxy).
  for (const { entry, memberId } of iterateColdMembers(msg)) {
    state.memberToDataset.set(memberId, msg.datasetId);
    const target = targetLevelOf(entry);
    if (target === undefined) state.targetLevelByMember.delete(memberId);
    else state.targetLevelByMember.set(memberId, target);
  }

  // 3. Build pool groups (volume or slice) — partitions activeSet by
  // (tier, channel, chunkDims). Entries with no chunk levels
  // (group-as-proxy, with empty `levels[]`) are skipped here; they're
  // still in memberToDataset from step 2.
  const mode: "volume" | "slice" = msg.viewMode;
  const dimArity: 2 | 3 = mode === "volume" ? 3 : 2;
  const groups = groupEntriesByPool(msg, mode);

  // Capture the sections this cold state actually produces (across
  // pools), so the descriptor build sees only the offsets/dims of the
  // pool(s) this cold state populated.
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

  // 5. Rebuild per-dataset descriptor buffer. Replaces any previous
  // buffer for the same dataset (proxy pool index churn is acceptable —
  // descriptors are rebuilt fresh each cold state, same as the sections).
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
