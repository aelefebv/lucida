import type { VoxelRect } from "../pipeline/layoutBuilders.ts";

/** The smallest rectangle containing every non-null rect, or null if none. */
export function unionRects(rects: Iterable<VoxelRect | null>): VoxelRect | null {
  let out: VoxelRect | null = null;
  for (const r of rects) {
    if (!r) continue;
    out = out
      ? {
          min: [Math.min(out.min[0], r.min[0]), Math.min(out.min[1], r.min[1])],
          max: [Math.max(out.max[0], r.max[0]), Math.max(out.max[1], r.max[1])],
        }
      : { min: [r.min[0], r.min[1]], max: [r.max[0], r.max[1]] };
  }
  return out;
}

/**
 * The key of the group whose bounds contain `point`, or null when it falls
 * between groups. Where bounds overlap, the smallest group wins, being the one
 * the point is most specifically on.
 */
export function groupAt<K>(
  groups: Iterable<{ key: K; bounds: VoxelRect }>,
  point: readonly [number, number],
): K | null {
  const [x, y] = point;
  let best: K | null = null;
  let bestArea = Infinity;
  for (const { key, bounds } of groups) {
    if (x < bounds.min[0] || x > bounds.max[0] || y < bounds.min[1] || y > bounds.max[1]) continue;
    const area = (bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]);
    if (area < bestArea) {
      best = key;
      bestArea = area;
    }
  }
  return best;
}
