/**
 * Viewport-derived visible-region descriptor consumed by planning and the
 * renderer to clip / cull / sort content. Computed by WASM each tick from
 * the current camera + selection state.
 *
 * Moved from `pipeline/planning/index.ts` per ADR 0028 — the type was
 * always a viewport concept, not a planning concept; it now lives in a
 * file whose name reflects what it is.
 */
export interface VisibleRegion {
  /** [minX, minY, maxX, maxY] in voxel coordinates. */
  xyBoundsVox: [number, number, number, number];
  /** [start, end) voxel Z range. */
  zRangeVox: [number, number];
  /** Screen pixels per voxel. */
  effectiveZoom: number;
  /** Sort/focal center in voxel coordinates. */
  sortCenterVox: [number, number, number] | null;
  /** Six frustum half-planes, or null for 2-D views. */
  frustumPlanes: [number, number, number, number][] | null;
}
