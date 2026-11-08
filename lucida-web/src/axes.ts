/**
 * Axis indexes for the canonical 5D TCZYX layout of `LevelGeometry.shape`,
 * `chunk_shape`, and `grid_shape`. Index with `shape[Axis.X]`, not `shape[4]`,
 * so a swapped axis is visible at the access site.
 */
export const Axis = { T: 0, C: 1, Z: 2, Y: 3, X: 4 } as const;

/**
 * The number a person sees for a 0-based axis index. People count positions
 * from 1; the wire, URLs, and CLI flags carry the 0-based index. A fractional
 * index, such as a depth picked in 3D, rounds to its slice.
 */
export function positionNumber(index: number): number {
  return Math.round(index) + 1;
}

/**
 * A position as a person reads it: `Z 5`, or `Z 5/40` with the axis length.
 * Every surface that shows a position formats it here, so a person and an
 * agent mean the same slice by the same words.
 */
export function positionLabel(axis: string, index: number, count?: number): string {
  const shown = positionNumber(index);
  return count === undefined ? `${axis} ${shown}` : `${axis} ${shown}/${count}`;
}
