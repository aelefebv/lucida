/**
 * Axis-index constants for the canonical 5D TCZYX layout used across
 * Lucida's manifest-shape arrays (`LevelGeometry.shape`,
 * `LevelGeometry.chunk_shape`, `LevelGeometry.grid_shape`).
 *
 * Use `shape[Axis.X]` rather than `shape[4]` at every indexed access
 * site — the type system catches mis-axis swaps because the surrounding
 * semantics get type-checked.
 *
 * JS-side only; the Rust side mostly uses destructuring (`let [t, c, z, y, x] = arr`).
 *
 * PRD #578 / Slice 2 (ADR 0030).
 */
export const Axis = { T: 0, C: 1, Z: 2, Y: 3, X: 4 } as const;
