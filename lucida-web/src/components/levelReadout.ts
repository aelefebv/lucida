/** The layer panel's wording for a dataset's level readout. */

import type { LevelRange } from "../renderer/workerProtocol.ts";

/** `2` for one level, `1-3` for a range. */
export function levelNumbers(range: LevelRange): string {
  return range.min === range.max ? `${range.min}` : `${range.min}-${range.max}`;
}

function levelLabel(range: LevelRange): string {
  return `${range.min === range.max ? "level" : "levels"} ${levelNumbers(range)}`;
}

/**
 * The passive notice for a dataset whose pixels come from a coarser level
 * than the target, or `null` while the target is resident or still unknown.
 */
export function displayedLevelNotice(layer: {
  targetLevel: LevelRange | null;
  displayedLevel: LevelRange | null;
  displayedCoarserThanTarget: boolean;
}): string | null {
  if (!layer.displayedCoarserThanTarget || !layer.targetLevel || !layer.displayedLevel) return null;
  const verb = layer.targetLevel.min === layer.targetLevel.max ? "is" : "are";
  return `Displaying ${levelLabel(layer.displayedLevel)} where ${levelLabel(layer.targetLevel)} ${verb} the target.`;
}
