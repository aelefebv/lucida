import type { SpatialAxis } from "../renderer/slicePlane.ts";

/**
 * Viewport-derived visible-region descriptor. Computed by WASM each tick
 * from camera + selection; consumed by planning and the renderer for
 * clip / cull / sort.
 */
export interface VisibleRegion {
  /** [minX, minY, maxX, maxY] in voxel coordinates. */
  xyBoundsVox: [number, number, number, number];
  /** [start, end) voxel Z range. */
  zRangeVox: [number, number];
  /** Screen pixels per voxel. */
  effectiveZoom: number;
  /** View-relative radius basis in voxels. 3-D uses the focal plane, not the far-frustum AABB. */
  radiusBasisVox?: number;
  /** Sort/focal center in voxel coordinates. */
  sortCenterVox: [number, number, number] | null;
  /** Six frustum half-planes, or null for 2-D views. */
  frustumPlanes: [number, number, number, number][] | null;
  /**
   * A 2-D view of a dataset its placement turns in the plane: the screen's
   * four edges as half-planes in the dataset's frame. Absent otherwise.
   */
  sidePlanes?: [number, number, number, number][];
  /**
   * The axis a 2-D view cuts. Its extent here is the planes the view cuts,
   * in each image's own samples. Absent: Z.
   */
  cutAxis?: SpatialAxis;
}
