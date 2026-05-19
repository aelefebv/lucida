/**
 * Cold-state ingestion orchestrator.
 *
 * Reads + writes per-worker registries via `ctx.state.*`:
 *   - `memberToDataset` / `memberToPool` — routing registries used by
 *     chunk + render handlers to look up which dataset / pool a
 *     memberId belongs to.
 *   - `wellToFields` — well → child-field set, used so a `WellProxy3D`
 *     upload can fan out to its child fields' descriptors.
 *   - `wellsByDataset` — dataset → wells currently referenced in
 *     wellToFields; tracked so `removeLayerResources` can drop a
 *     dataset's entries without scanning every well.
 *   - `currentEntityMetasByDataset` — per-dataset entity-metas snapshot
 *     for the most recent cold state. The descriptor buffer build pulls
 *     from this so it doesn't pick up stale offsets from pools that
 *     belonged to earlier cold states with different target LODs.
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
import { memberTierKey } from "../poolKeys.ts";

/**
 * Apply a cold-state message: refresh well→fields, register
 * member→dataset mappings, build pool groups, allocate atlases, compute
 * + write entityMetas, resize + remap indirection, capture per-dataset
 * entity-metas snapshot, rebuild the descriptor buffer.
 *
 * Caller is responsible for posting the wanted-set after this returns
 * (kept outside so this function has a single concern).
 */
export function applyColdState(ctx: WorkerCtx, msg: ColdStateMessage): void {
  const state = ctx.state;

  // 1. Refresh well→fields map so well-proxy uploads can fan out to
  // child fields' descriptors. Cold state is the source of truth for
  // active set membership; we rebuild this dataset's contribution
  // fully each tick. Other datasets' entries stay untouched so the
  // worker can hold multiple datasets concurrently.
  const prevWells = state.wellsByDataset.get(msg.datasetId);
  if (prevWells) {
    for (const wellId of prevWells) state.wellToFields.delete(wellId);
  }
  const wellsForDataset = new Set<string>();
  for (const entry of msg.activeSet) {
    if (entry.parentWellId) {
      let set = state.wellToFields.get(entry.parentWellId);
      if (!set) {
        set = new Set();
        state.wellToFields.set(entry.parentWellId, set);
      }
      set.add(entry.entityId);
      wellsForDataset.add(entry.parentWellId);
    }
  }
  if (wellsForDataset.size > 0) {
    state.wellsByDataset.set(msg.datasetId, wellsForDataset);
  } else {
    state.wellsByDataset.delete(msg.datasetId);
  }

  if (msg.desiredProxyKeys !== undefined) {
    const evicted = reconcileProxyResidency(state, msg.datasetId, msg.desiredProxyKeys);
    state.proxyStats.evicted += evicted;
    state.proxyStats.evictedPolicy += evicted;
  }

  for (const [memberId, datasetId] of state.memberToDataset) {
    if (datasetId !== msg.datasetId) continue;
    state.memberToPool.delete(memberId);
    state.memberTierToPool.delete(memberTierKey(memberId, "detail"));
    state.memberTierToPool.delete(memberTierKey(memberId, "coarse"));
  }

  // 2. Register member→dataset mappings for every (entry, channel)
  // combo. Canonical iteration walks activeSet × visibleChannels and
  // produces the same memberId scheme used elsewhere in the pipeline
  // (imageId for fields, entityId for well-as-proxy).
  for (const { memberId } of iterateColdMembers(msg)) {
    state.memberToDataset.set(memberId, msg.datasetId);
  }

  // 3. Build pool groups (volume or slice) — partitions activeSet by
  // (channel, chunkDims). Entries without a targetLevel (e.g.
  // well-as-proxy with empty `levels[]`) are skipped here; they're
  // still in memberToDataset from step 2.
  const mode: "volume" | "slice" = msg.viewMode;
  const dimArity: 2 | 3 = mode === "volume" ? 3 : 2;
  const groups = groupEntriesByPool(msg, mode);

  // Capture the entityMetas this cold state actually produces (across
  // pools), so the descriptor build sees only the offsets/dims of the
  // pool(s) this cold state populated.
  const currentEntityMetas = new Map<string, LodIndirectionMeta[]>();

  // 4. For each group: register memberToPool, alloc pool, compute
  // entityMetas with sequential offsets within the group, resize +
  // remap the pool's indirection buffer.
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
      state.memberTierToPool.set(memberTierKey(memberId, tier), group.poolKey);
      if (tier === "detail") state.memberToPool.set(memberId, group.poolKey);
      const { meta, nextOffset } = computeEntityTierMeta(
        entry,
        level,
        group.chunkDims,
        offset,
        dimArity,
      );
      if (meta) {
        newEntityMetas.set(memberId, [meta]);
        const existing = currentEntityMetas.get(memberId) ?? [];
        currentEntityMetas.set(memberId, [...existing, meta]);
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

    // `currentEntityMetas` was populated above so one member can carry both
    // detail and coarse source metadata from different tier pools.
  }

  // 5. Capture per-dataset entity-metas snapshot.
  state.currentEntityMetasByDataset.set(msg.datasetId, currentEntityMetas);

  // 6. Rebuild per-dataset descriptor buffer. Replaces any previous
  // buffer for the same dataset (proxy pool index churn is acceptable —
  // descriptors are rebuilt fresh each cold state, same as entityMetas).
  const oldDesc = state.descriptorBuffersByDataset.get(msg.datasetId);
  if (oldDesc) destroyDescriptorBuffer(oldDesc);
  state.descriptorBuffersByDataset.set(
    msg.datasetId,
    buildDescriptorBuffer(
      ctx.device,
      msg,
      state.proxyDescriptorsByEntity,
      state.proxyPoolsByDataset,
      currentEntityMetas,
    ),
  );
}
