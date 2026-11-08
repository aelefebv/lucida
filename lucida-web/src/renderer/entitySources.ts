/**
 * The resident-level rule for one image-bearing entity, in one place.
 *
 * The detail tier holds sections for the target level and the next coarser
 * levels, so resident coarser chunks fill the screen where the target is
 * missing. Planning still requests `detailLevels` only, so the extra
 * sections cost indirection entries, never fetches. A level finer than the
 * target is never a source: zoomed out it would show the decimated picture
 * the target replaces.
 */

import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { ColdStateActiveEntry } from "./workerProtocol.ts";
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
 * The target level of an entry: the first detail-tier level, which is
 * the level pin or the level the screen calls for. `undefined` for an
 * entry with no detail levels.
 */
export function targetLevelOf(entry: ColdStateActiveEntry): number | undefined {
  return entry.detailLevels[0];
}

/**
 * The levels the detail tier holds sections for: the target level and
 * the next coarser levels the pyramid has, finest first, at most
 * {@link DESCRIPTOR_MAX_LEVEL_SOURCES}. Empty for entries without chunks.
 */
export function detailTierLevels(entry: ColdStateActiveEntry): number[] {
  const target = targetLevelOf(entry);
  if (target === undefined) return [];
  return entry.levels
    .map((l) => l.level)
    .filter((level) => level >= target)
    .sort((a, b) => a - b)
    .slice(0, DESCRIPTOR_MAX_LEVEL_SOURCES);
}

/** One level source of a descriptor: the section it reads and the draw-local pool slot. */
export interface LevelSource {
  source: EntitySource;
  /** Index into {@link EntitySourceSelection.levelPoolKeys}: which level pool binding the shader reads. */
  poolIndex: number;
}

/** What one entity's descriptor names, and what a draw for it binds. */
export interface EntitySourceSelection {
  /** Level sources finest first: the target level, then coarser resident levels. */
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
