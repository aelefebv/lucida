/**
 * Axis indexes for the canonical 5D TCZYX layout of `LevelGeometry.shape`,
 * `chunk_shape`, and `grid_shape`. Index with `shape[Axis.X]`, not `shape[4]`,
 * so a swapped axis is visible at the access site.
 */
export const Axis = { T: 0, C: 1, Z: 2, Y: 3, X: 4 } as const;
