/**
 * Cold-state ingestion orchestrator.
 *
 * Extracted from `gpu.worker.ts:506-753`. The dispatcher's `case
 * "coldState"` shrinks to: capture msg + epochs, call `applyColdState`,
 * post wanted set.
 *
 * Mutates the registries the worker hands in:
 *   - `memberToDataset` / `memberToPool` — routing registries used by
 *     chunk + render handlers to look up which dataset / pool a
 *     memberId belongs to.
 *   - `wellToFields` — well → child-field set, used so a `WellProxy3D`
 *     upload can fan out to its child fields' descriptors.
 *   - `currentEntityMetasByDataset` — per-dataset entity-metas snapshot
 *     for the most recent cold state. The descriptor buffer build pulls
 *     from this so it doesn't pick up stale offsets from pools that
 *     belonged to earlier cold states with different target LODs.
 *   - `descriptorBuffersByDataset` — per-dataset descriptor buffer
 *     (rebuilt fresh each cold state).
 *
 * `proxyDescriptorsByEntity` + `proxyPoolsByDataset` are READ (not
 * mutated) — the descriptor build resolves pool indices through them
 * but cold-state ingestion doesn't touch proxy state.
 *
 * Pool state (volume + slice atlases) lives in `volumeHandlers` /
 * `sliceHandlers` module globals today; this function calls into
 * `getOrCreateVolumePool` / `getOrCreateSlicePool` to allocate them.
 * Slice 8 will pull that state up onto a ctx-owned `RendererState`.
 */

import type { WorkerCtx, EntityProxyDescriptor } from "../workerContext.ts";
import type { ColdStateMessage } from "../workerProtocol.ts";
import type { ProxyAtlasState } from "../proxyAtlas.ts";
import {
  buildDescriptorBuffer,
  destroyDescriptorBuffer,
  iterateColdMembers,
  type EntityDescriptorIndex,
} from "../descriptorBuffer.ts";
import {
  getOrCreateVolumePool,
  resizeIndirection,
  remapIndirection,
  type LodIndirectionMeta,
} from "../volumeHandlers.ts";
import {
  getOrCreateSlicePool,
  resizeSliceIndirection,
  remapSliceIndirection,
} from "../sliceHandlers.ts";
import { groupEntriesByPool } from "./groupEntries.ts";
import { computeEntityMetas } from "./entityMetas.ts";

/**
 * The registries `applyColdState` reads + mutates. Passed in explicitly
 * so this slice doesn't depend on Slice 8 (state ownership cleanup);
 * the worker module still owns the actual Maps.
 */
export interface ColdStateRegistries {
  memberToDataset: Map<string, string>;
  memberToPool: Map<string, string>;
  wellToFields: Map<string, Set<string>>;
  currentEntityMetasByDataset: Map<string, Map<string, LodIndirectionMeta[]>>;
  proxyDescriptorsByEntity: Map<string, EntityProxyDescriptor>;
  proxyPoolsByDataset: Map<string, Map<string, ProxyAtlasState>>;
  descriptorBuffersByDataset: Map<string, EntityDescriptorIndex>;
}

/**
 * Apply a cold-state message: refresh well→fields, register
 * member→dataset mappings, build pool groups, allocate atlases, compute
 * + write entityMetas, resize + remap indirection, capture per-dataset
 * entity-metas snapshot, rebuild the descriptor buffer.
 *
 * Caller is responsible for posting the wanted-set after this returns
 * (kept outside so this function has a single concern).
 */
export function applyColdState(
  ctx: WorkerCtx,
  msg: ColdStateMessage,
  reg: ColdStateRegistries,
): void {
  // 1. Refresh well→fields map so well-proxy uploads can fan out to
  // child fields' descriptors. Cold state is the source of truth for
  // active set membership; rebuild fully each tick.
  reg.wellToFields.clear();
  for (const entry of msg.activeSet) {
    if (entry.parentWellId) {
      let set = reg.wellToFields.get(entry.parentWellId);
      if (!set) {
        set = new Set();
        reg.wellToFields.set(entry.parentWellId, set);
      }
      set.add(entry.entityId);
    }
  }

  // 2. Register member→dataset mappings for every (entry, channel)
  // combo. Canonical iteration walks activeSet × visibleChannels and
  // produces the same memberId scheme used elsewhere in the pipeline
  // (imageId for fields, entityId for well-as-proxy).
  for (const { memberId } of iterateColdMembers(msg)) {
    reg.memberToDataset.set(memberId, msg.datasetId);
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
    let offset = 0;

    for (const { entry, memberId } of group.entries) {
      reg.memberToPool.set(memberId, group.poolKey);
      const { metas, nextOffset } = computeEntityMetas(
        entry,
        group.chunkDims,
        offset,
        dimArity,
      );
      newEntityMetas.set(memberId, metas);
      offset = nextOffset;
    }

    if (mode === "volume") {
      const atlas = getOrCreateVolumePool(
        ctx, group.poolKey, pcX, pcY, pcZ, msg.currentT, group.channel,
      );
      atlas.entityMetas = newEntityMetas;
      resizeIndirection(ctx, atlas, offset);
      remapIndirection(atlas, msg.currentT, group.channel);
    } else {
      const atlas = getOrCreateSlicePool(
        ctx, group.poolKey, pcX, pcY, msg.currentZ, msg.currentT, group.channel,
      );
      atlas.entityMetas = newEntityMetas;
      resizeSliceIndirection(ctx, atlas, offset);
      remapSliceIndirection(atlas, msg.currentT, group.channel, msg.currentZ);
    }

    for (const [memberId, metas] of newEntityMetas) {
      currentEntityMetas.set(memberId, metas);
    }
  }

  // 5. Capture per-dataset entity-metas snapshot.
  reg.currentEntityMetasByDataset.set(msg.datasetId, currentEntityMetas);

  // 6. Rebuild per-dataset descriptor buffer. Replaces any previous
  // buffer for the same dataset (proxy pool index churn is acceptable —
  // descriptors are rebuilt fresh each cold state, same as entityMetas).
  const oldDesc = reg.descriptorBuffersByDataset.get(msg.datasetId);
  if (oldDesc) destroyDescriptorBuffer(oldDesc);
  reg.descriptorBuffersByDataset.set(
    msg.datasetId,
    buildDescriptorBuffer(
      ctx.device,
      msg,
      reg.proxyDescriptorsByEntity,
      reg.proxyPoolsByDataset,
      currentEntityMetas,
    ),
  );
}
