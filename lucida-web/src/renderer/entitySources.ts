/**
 * The resident-level rule for one image-bearing entity, in one place.
 *
 * A cold-state tile entry names its target level (`detailLevels[0]`). The
 * detail tier holds an indirection section for the target and for the
 * next coarser levels the pyramid has, up to {@link
 * DESCRIPTOR_MAX_LEVEL_SOURCES} levels, so chunks already resident at a
 * coarser level stay mapped and fill the screen where the target is
 * missing. Planning still requests chunks at `detailLevels` only; the
 * extra sections cost indirection entries, never fetches.
 *
 * The renderer samples those same sections finest first, then the coarse
 * tier, then blank. A level finer than the target is never a level
 * source: shown zoomed out it would be the decimated picture the target
 * level replaces (ADR 0061).
 *
 * Pure functions, no GPU coupling: `groupEntriesByPool` allocates the
 * sections {@link detailTierLevels} lists, and {@link selectEntitySources}
 * names sources from that same list, so the two cannot disagree.
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
  return entry.kind === "tile" ? entry.detailLevels[0] : undefined;
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
