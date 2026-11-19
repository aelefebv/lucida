/**
 * The resident-level rule for one image-bearing entity, in one place.
 *
 * The detail tier holds sections for the finest level the level selection
 * chose and the next coarser levels, so the selection's coarser chunks draw
 * where it chose them, and resident coarser chunks fill the screen where a
 * finer one is missing. Planning requests the selection's chunks only, so
 * the extra sections cost indirection entries, never fetches. A level finer
 * than the finest chosen is never a source: zoomed out it would show the
 * decimated picture the selection replaced.
 */

import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { ColdStateActiveEntry, LevelRange } from "./workerProtocol.ts";
import type { LodIndirectionMeta } from "./volume/atlas.ts";
import { DESCRIPTOR_MAX_LEVEL_SOURCES } from "./descriptor/layout.ts";

/**
 * One indirection section a member holds: the tier it serves, the pool
 * it lives in, and the section's geometry and absolute offset.
 */
export interface EntitySource {
  tier: ResidencyTier;
  poolKey: string;
  meta: LodIndirectionMeta;
}

/**
 * The finest level an entry draws from: its first detail-tier level.
 * `undefined` for an entry with no detail levels.
 */
export function finestLevelOf(entry: ColdStateActiveEntry): number | undefined {
  return entry.detailLevels[0];
}

/**
 * The levels the detail tier holds sections for: the finest level and the
 * next coarser levels the pyramid has, finest first, at most
 * {@link DESCRIPTOR_MAX_LEVEL_SOURCES}. The level selection keeps its
 * levels within that many of its finest. Empty for entries without chunks.
 */
export function detailTierLevels(entry: ColdStateActiveEntry): number[] {
  const finest = finestLevelOf(entry);
  if (finest === undefined) return [];
  return entry.levels
    .map((l) => l.level)
    .filter((level) => level >= finest)
    .sort((a, b) => a - b)
    .slice(0, DESCRIPTOR_MAX_LEVEL_SOURCES);
}

/**
 * The levels the level selection chose for an entry, the coarse tier's
 * included when it kept some there, or `null` when it chose none.
 */
export function selectedLevels(entry: ColdStateActiveEntry): LevelRange | null {
  const levels = [...entry.detailLevels];
  if (entry.keepsCoarse && entry.coarseLevel !== null) levels.push(entry.coarseLevel);
  if (levels.length === 0) return null;
  return { min: Math.min(...levels), max: Math.max(...levels) };
}

/** One level source of a descriptor: the section it reads and the draw-local pool slot. */
export interface LevelSource {
  source: EntitySource;
  /** Index into {@link EntitySourceSelection.levelPoolKeys}: which level pool binding the shader reads. */
  poolIndex: number;
}

/** What one entity's descriptor names, and what a draw for it binds. */
export interface EntitySourceSelection {
  /** Level sources finest first: the finest chosen level, then the coarser ones. */
  levels: LevelSource[];
  /** Distinct pool keys the level sources use, in binding-slot order (index = `poolIndex`). */
  levelPoolKeys: string[];
  /** The coarse tier's section, or `null` when the entry has no coarse level. */
  coarse: EntitySource | null;
}

/**
 * Choose the level sources and the coarse source for an entry from the
 * sections the worker allocated for it: one per level of
 * {@link detailTierLevels}, in that order, skipping a level with no
 * section. Each distinct pool among them gets a dense binding slot so a
 * draw binds every pool the entity samples.
 */
export function selectEntitySources(
  entry: ColdStateActiveEntry,
  sources: readonly EntitySource[],
): EntitySourceSelection {
  const coarse = sources.find((s) => s.tier === "coarse") ?? null;
  const levelPoolKeys: string[] = [];
  const levels: LevelSource[] = [];
  for (const level of detailTierLevels(entry)) {
    const source = sources.find((s) => s.tier === "detail" && s.meta.level === level);
    if (!source) continue;
    let poolIndex = levelPoolKeys.indexOf(source.poolKey);
    if (poolIndex < 0) {
      poolIndex = levelPoolKeys.length;
      levelPoolKeys.push(source.poolKey);
    }
    levels.push({ source, poolIndex });
  }
  return { levels, levelPoolKeys, coarse };
}
