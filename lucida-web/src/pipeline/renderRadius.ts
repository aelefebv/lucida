import type { VisibleRegion } from "./viewport.ts";

export const RENDER_RADIUS_DISABLED = 2;

export type RenderRadiusTier = "detail" | "coarse";

export interface ChunkRadiusGeometry {
  /** Full-resolution dimensions in X/Y/Z order. */
  fullDims: [number, number, number];
  /** Source-level dimensions in X/Y/Z order. */
  levelDims: [number, number, number];
  /** Source-level chunk dimensions in X/Y/Z order. */
  chunkDims: [number, number, number];
}

export function renderRadiusEnabled(radiusView: number): boolean {
  return Number.isFinite(radiusView) && radiusView >= 0 && radiusView < RENDER_RADIUS_DISABLED;
}

export function visibleRegionCenterVox(region: VisibleRegion): [number, number, number] {
  if (region.sortCenterVox) return region.sortCenterVox;
  return [
    (region.xyBoundsVox[0] + region.xyBoundsVox[2]) / 2,
    (region.xyBoundsVox[1] + region.xyBoundsVox[3]) / 2,
    (region.zRangeVox[0] + region.zRangeVox[1]) / 2,
  ];
}

export function renderRadiusLimitVox(
  region: VisibleRegion,
  radiusView: number,
): number {
  if (!renderRadiusEnabled(radiusView)) return Number.POSITIVE_INFINITY;
  const radiusBasis = region.radiusBasisVox;
  if (radiusBasis !== undefined && Number.isFinite(radiusBasis) && radiusBasis > 0) {
    return Math.max(1, radiusBasis) * radiusView;
  }
  const halfX = Math.max(0, (region.xyBoundsVox[2] - region.xyBoundsVox[0]) / 2);
  const halfY = Math.max(0, (region.xyBoundsVox[3] - region.xyBoundsVox[1]) / 2);
  const halfZ = Math.max(0, (region.zRangeVox[1] - region.zRangeVox[0]) / 2);
  const halfDiagonal = Math.sqrt(halfX * halfX + halfY * halfY + halfZ * halfZ);
  return Math.max(1, halfDiagonal) * radiusView;
}

export function chunkWorldDimsForRadius(
  geometry: ChunkRadiusGeometry,
): [number, number, number] {
  const [fullX, fullY, fullZ] = geometry.fullDims;
  const [levelX, levelY, levelZ] = geometry.levelDims;
  const [chunkX, chunkY, chunkZ] = geometry.chunkDims;
  return [
    chunkX * (fullX / Math.max(1, levelX)),
    chunkY * (fullY / Math.max(1, levelY)),
    chunkZ * (fullZ / Math.max(1, levelZ)),
  ];
}

export function chunkCenterDistanceToVisibleCenterVox(args: {
  region: VisibleRegion;
  layoutPositionVox: [number, number];
  geometry: ChunkRadiusGeometry;
  chunk: { x: number; y: number; z: number };
}): number {
  const [centerX, centerY, centerZ] = visibleRegionCenterVox(args.region);
  const [chunkWorldX, chunkWorldY, chunkWorldZ] = chunkWorldDimsForRadius(args.geometry);
  const chunkCenterX = args.layoutPositionVox[0] + (args.chunk.x + 0.5) * chunkWorldX;
  const chunkCenterY = args.layoutPositionVox[1] + (args.chunk.y + 0.5) * chunkWorldY;
  const chunkCenterZ = (args.chunk.z + 0.5) * chunkWorldZ;
  const dx = chunkCenterX - centerX;
  const dy = chunkCenterY - centerY;
  const dz = chunkCenterZ - centerZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function chunkClosestDistanceToVisibleCenterVox(args: {
  region: VisibleRegion;
  layoutPositionVox: [number, number];
  geometry: ChunkRadiusGeometry;
  chunk: { x: number; y: number; z: number };
}): number {
  const [centerX, centerY, centerZ] = visibleRegionCenterVox(args.region);
  const [chunkWorldX, chunkWorldY, chunkWorldZ] = chunkWorldDimsForRadius(args.geometry);
  const minX = args.layoutPositionVox[0] + args.chunk.x * chunkWorldX;
  const minY = args.layoutPositionVox[1] + args.chunk.y * chunkWorldY;
  const minZ = args.chunk.z * chunkWorldZ;
  const maxX = Math.min(
    args.layoutPositionVox[0] + args.geometry.fullDims[0],
    minX + chunkWorldX,
  );
  const maxY = Math.min(
    args.layoutPositionVox[1] + args.geometry.fullDims[1],
    minY + chunkWorldY,
  );
  const maxZ = Math.min(args.geometry.fullDims[2], minZ + chunkWorldZ);
  const dx = distanceOutsideInterval(centerX, minX, maxX);
  const dy = distanceOutsideInterval(centerY, minY, maxY);
  const dz = distanceOutsideInterval(centerZ, minZ, maxZ);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function chunkWithinRenderRadius(args: {
  region: VisibleRegion;
  radiusView: number;
  layoutPositionVox: [number, number];
  geometry: ChunkRadiusGeometry;
  chunk: { x: number; y: number; z: number };
}): boolean {
  if (!renderRadiusEnabled(args.radiusView)) return true;
  return chunkClosestDistanceToVisibleCenterVox(args) <=
    renderRadiusLimitVox(args.region, args.radiusView);
}

function distanceOutsideInterval(value: number, min: number, max: number): number {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}
