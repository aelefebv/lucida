/** The layer panel's wording for a dataset's level readout. */

import type { LevelRange } from "../renderer/workerProtocol.ts";

/** `2` for one level, `1-3` for a range. */
export function levelNumbers(range: LevelRange): string {
  return range.min === range.max ? `${range.min}` : `${range.min}-${range.max}`;
}

function levelLabel(range: LevelRange): string {
  return `${range.min === range.max ? "level" : "levels"} ${levelNumbers(range)}`;
}

function verb(range: LevelRange): string {
  return range.min === range.max ? "is" : "are";
}

function sameRange(a: LevelRange, b: LevelRange): boolean {
  return a.min === b.min && a.max === b.max;
}

/**
 * The passive notice for a dataset whose pixels come from a coarser level
 * than the target, or `null` while the target is resident or still unknown.
 * It says whether the coarser levels are what the memory budget holds, or
 * stand in while the chosen ones load.
 */
export function displayedLevelNotice(layer: {
  targetLevel: LevelRange | null;
  selectedLevel: LevelRange | null;
  displayedLevel: LevelRange | null;
  displayedCoarserThanTarget: boolean;
  selectedCoarserThanTarget: boolean;
}): string | null {
  const { targetLevel: target, selectedLevel: selected, displayedLevel: displayed } = layer;
  if (!target) return null;
  if (layer.selectedCoarserThanTarget && selected) {
    const targetIs = `${levelLabel(target)} ${verb(target)} the target`;
    if (displayed && !sameRange(displayed, selected) && displayed.max > selected.max) {
      return `Displaying ${levelLabel(displayed)} while ${levelLabel(selected)}, the finest that fit in memory, load. ` +
        `${targetIs.charAt(0).toUpperCase()}${targetIs.slice(1)}.`;
    }
    return `Displaying ${levelLabel(selected)}, the finest that fit in memory, where ${targetIs}.`;
  }
  if (!layer.displayedCoarserThanTarget || !displayed) return null;
  return `Displaying ${levelLabel(displayed)} where ${levelLabel(target)} ${verb(target)} the target.`;
}
