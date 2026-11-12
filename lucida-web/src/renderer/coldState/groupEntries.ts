/**
 * Partition a cold state's active set into per-(tier, channel, chunkDims)
 * pool groups. Pure; `mode` only changes the chunk-dim arity.
 *
 * Each tile entry contributes one detail section per level in
 * {@link detailTierLevels} plus one for its coarse level, and each level
 * lands in the pool matching its own chunk shape, so one entity's levels can
 * spread across pools.
 */

import type { ResidencyTier } from "../../pipeline/residencyTier.ts";
import type {
  ColdStateMessage,
  ColdStateActiveEntry,
} from "../workerProtocol.ts";
import { memberIdForColdEntry } from "../descriptorBuffer.ts";
import { detailTierLevels } from "../entitySources.ts";
import { chunkTierPoolKey } from "../poolKeys.ts";

/**
 * One pool's worth of entries from a cold state. `chunkDims` is `[Z, Y, X]`
 * in both modes to match `lm.chunkShape`; slice mode sets `Z = 1`.
 */
export interface PoolGroup {
  poolKey: string;
  tier: ResidencyTier;
  channel: number;
  chunkDims: [number, number, number];
  /** One entry per (member, level) section the pool holds. */
  entries: Array<{ entry: ColdStateActiveEntry; memberId: string; tier: ResidencyTier; level: number }>;
}

/** One section an entry holds in one channel, and the pool it goes to. */
export interface PoolSource {
  poolKey: string;
  tier: ResidencyTier;
  level: number;
  /** `[Z, Y, X]`; slice mode sets `Z = 1`. */
  chunkDims: [number, number, number];
}

/** The sections one entry holds in one channel, each with its pool, in {@link tierSourcesForEntry} order. */
export function entryPoolSources(
  cold: Pick<ColdStateMessage, "datasetId" | "sliceAxis">,
  mode: "volume" | "slice",
  entry: ColdStateActiveEntry,
  channel: number,
): PoolSource[] {
  const out: PoolSource[] = [];
  for (const source of tierSourcesForEntry(entry)) {
    const levelMeta = entry.levels.find(l => l.level === source.level);
    if (!levelMeta) continue;
    const [chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
    // `chunkTierPoolKey` takes `[X, Y, Z]` or `[X, Y]`; the group keeps `[Z, Y, X]`.
    const poolKey =
      mode === "volume"
        ? chunkTierPoolKey(cold.datasetId, source.tier, channel, [chunkX, chunkY, chunkZ])
        : chunkTierPoolKey(cold.datasetId, source.tier, channel, [chunkX, chunkY], cold.sliceAxis);
    const chunkDims: [number, number, number] = mode === "volume" ? [chunkZ, chunkY, chunkX] : [1, chunkY, chunkX];
    out.push({ poolKey, tier: source.tier, level: source.level, chunkDims });
  }
  return out;
}

/**
 * Partition `cold.activeSet × cold.visibleChannels` into pool groups,
 * channel outer and entry inner.
 */
export function groupEntriesByPool(
  cold: ColdStateMessage,
  mode: "volume" | "slice",
): Map<string, PoolGroup> {
  const groups = new Map<string, PoolGroup>();

  for (const channel of cold.visibleChannels) {
    for (const entry of cold.activeSet) {
      const memberId = memberIdForColdEntry(entry, channel);
      for (const { poolKey, tier, level, chunkDims } of entryPoolSources(cold, mode, entry, channel)) {
        let group = groups.get(poolKey);
        if (!group) {
          group = { poolKey, tier, channel, chunkDims, entries: [] };
          groups.set(poolKey, group);
        }
        group.entries.push({ entry, memberId, tier, level });
      }
    }
  }
  return groups;
}

/** The (tier, level) sections a tile entry holds: detail levels finest first, then the coarse level. */
function tierSourcesForEntry(
  entry: ColdStateActiveEntry,
): Array<{ tier: ResidencyTier; level: number }> {
  const sources: Array<{ tier: ResidencyTier; level: number }> =
    detailTierLevels(entry).map(level => ({ tier: "detail", level }));
  if (entry.coarseLevel !== null) {
    sources.push({ tier: "coarse", level: entry.coarseLevel });
  }
  return sources;
}
