/**
 * Failed-chunk marks for the pools that hold one level whole: label overlays
 * and minimap overviews. Their texture keeps every chunk at its place in the
 * level, so their indirection maps each chunk cell to itself, and a cell can
 * read as FAILED, which the shaders draw hatched, without moving a texel.
 */

import { parseChunkKey } from "./chunkKeys.ts";
import { INDIRECTION_FAILED, INDIRECTION_MISS } from "./remap.ts";
import type { RendererState } from "./worker/state.ts";

/** Chunk cells per axis. A plane has `z: 1`. */
export interface CellGrid {
  x: number;
  y: number;
  z: number;
}

/** The flat index of cell `(x, y, z)`, as the shaders' `gridIdx`. */
export function cellIndex(grid: CellGrid, x: number, y: number, z: number): number {
  return (z * grid.y + y) * grid.x + x;
}

/** The failed chunk keys the page listed for `imageId`, whichever dataset holds it. */
export function failedKeysForImage(
  state: Pick<RendererState, "failedByDataset">,
  imageId: string,
): ReadonlySet<string> | undefined {
  for (const byImage of state.failedByDataset.values()) {
    const keys = byImage.get(imageId);
    if (keys) return keys;
  }
  return undefined;
}

/**
 * The cells of `grid` whose chunk failed, keyed by cell index, with the chunk
 * key that failed there. Only keys at `at`'s level, T and C count. With
 * `at.z` the grid is that one plane, so every cell sits at z 0.
 */
export function failedCellsAt(
  failed: ReadonlySet<string> | undefined,
  grid: CellGrid,
  at: { level: number; t: number; c: number; z?: number },
): Map<number, string> {
  const out = new Map<number, string>();
  if (!failed) return out;
  const plane = typeof at.z === "number" ? at.z : undefined;
  for (const key of failed) {
    const k = parseChunkKey(key);
    if (!k || k.level !== at.level || k.t !== at.t || k.c !== at.c) continue;
    if (plane !== undefined && k.z !== plane) continue;
    const z = plane !== undefined ? 0 : k.z;
    if (!(k.x >= 0 && k.x < grid.x && k.y >= 0 && k.y < grid.y && z >= 0 && z < grid.z)) continue;
    out.set(cellIndex(grid, k.x, k.y, z), key);
  }
  return out;
}

/**
 * Bring a pool's FAILED marks in line with `failed`. A failed cell reads
 * FAILED unless `holds` says the pool has that very chunk there, since data
 * that arrived wins. A cell marked before that no longer should be takes
 * `cleared(cell)`, what the pool would read there without the mark.
 * `marked` is updated in place. Returns whether `indirection` changed.
 */
export function applyFailedMarks(
  indirection: Uint32Array,
  marked: Set<number>,
  failed: ReadonlyMap<number, string>,
  holds: (cell: number, key: string) => boolean,
  cleared: (cell: number) => number,
): boolean {
  let changed = false;
  const next = new Set<number>();
  for (const [cell, key] of failed) {
    if (cell >= indirection.length || holds(cell, key)) continue;
    next.add(cell);
    if (indirection[cell] !== INDIRECTION_FAILED) {
      indirection[cell] = INDIRECTION_FAILED;
      changed = true;
    }
  }
  for (const cell of marked) {
    if (next.has(cell) || cell >= indirection.length) continue;
    if (indirection[cell] === INDIRECTION_FAILED) {
      indirection[cell] = cleared(cell);
      changed = true;
    }
  }
  marked.clear();
  for (const cell of next) marked.add(cell);
  return changed;
}

/** An in-place pool's indirection with every cell mapped to itself. */
export function identityIndirection(cells: number): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(Math.max(1, cells));
  for (let i = 0; i < out.length; i++) out[i] = i;
  return out;
}

/** An in-place pool's indirection with nothing in it yet. */
export function emptyIndirection(cells: number): Uint32Array<ArrayBuffer> {
  return new Uint32Array(Math.max(1, cells)).fill(INDIRECTION_MISS);
}
