/**
 * One dataset's level readout, summarized from the worker's per-entity
 * reports. The layer panel shows a dataset, not an entity, so a collection
 * reads as a range across its visible tiles.
 */

import type { EntityLevelReport, LevelRange } from "../renderer/workerProtocol.ts";

export interface DatasetLevels {
  /**
   * The target level across the dataset's visible entities, or across every
   * reported entity when none is in view (the pin still has a value to show).
   */
  target: LevelRange;
  /**
   * The finest and coarsest level on screen across the visible entities, or
   * `null` while no visible entity has a resident level yet.
   */
  displayed: LevelRange | null;
  /** True while some visible entity draws any pixel from a level coarser than its own target. */
  coarserThanTarget: boolean;
}

/** `null` when the dataset reports no image-bearing entity. */
export function summarizeDatasetLevels(
  entities: readonly EntityLevelReport[],
): DatasetLevels | null {
  if (entities.length === 0) return null;
  const visible = entities.filter((e) => e.visible);
  const targetScope = visible.length > 0 ? visible : entities;

  const displayed = visible
    .map((e) => e.displayed)
    .filter((d) => d !== null);
  return {
    target: rangeOf(targetScope.map((e) => e.targetLevel)),
    displayed: displayed.length === 0
      ? null
      : rangeOf(displayed.flatMap((d) => [d.min, d.max])),
    coarserThanTarget: visible.some(
      (e) => e.displayed !== null && e.displayed.max > e.targetLevel,
    ),
  };
}

function rangeOf(levels: readonly number[]): LevelRange {
  return { min: Math.min(...levels), max: Math.max(...levels) };
}

/** Structural equality, so a store can skip publishing an unchanged readout. */
export function sameDatasetLevels(a: DatasetLevels | null, b: DatasetLevels | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return sameRange(a.target, b.target)
    && sameRange(a.displayed, b.displayed)
    && a.coarserThanTarget === b.coarserThanTarget;
}

function sameRange(a: LevelRange | null, b: LevelRange | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.min === b.min && a.max === b.max;
}
