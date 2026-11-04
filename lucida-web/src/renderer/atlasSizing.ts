/**
 * Slot-grid math for the volume and slice atlas pools: how many fixed-size
 * slots fit a byte budget under the device's max texture dimension.
 *
 * `chunkDims` here is `[X, Y]` or `[X, Y, Z]`, the WebGPU `size` order. That
 * is the opposite of `LodIndirectionMeta.chunkDims` (`[Z, Y, X]`), so don't
 * mix them.
 */

import type { DeviceLimits } from "./gpuContext.ts";

export interface AtlasGeometry {
  slotsX: number;
  slotsY: number;
  /** Only populated when `dimArity === "3d"`. */
  slotsZ?: number;
  totalSlots: number;
  atlasW: number;
  atlasH: number;
  /** Only populated when `dimArity === "3d"`. */
  atlasD?: number;
}

/**
 * Slot grid for an atlas given a per-slot footprint and a byte budget.
 * Slots per axis are bounded by both the budget and the device's texture
 * dimension limit.
 *
 * @param chunkDims `[X, Y]` for 2D, `[X, Y, Z]` for 3D.
 * @param bytesPerVoxel Storage per voxel: `2` for the `r16uint`
 *   intensity atlas (default), `4` for the `r32uint` label atlas.
 */
export function computeAtlasGeometry(
  limits: DeviceLimits,
  chunkDims: [number, number] | [number, number, number],
  budgetBytes: number,
  dimArity: "2d" | "3d",
  bytesPerVoxel: number = 2,
): AtlasGeometry {
  const chunkTexels = chunkDims.reduce((a, b) => a * b, 1);
  const maxSlots = Math.floor(budgetBytes / (chunkTexels * bytesPerVoxel));

  if (dimArity === "3d") {
    const [chunkX, chunkY, chunkZ] = chunkDims as [number, number, number];
    const slotsPerAxis = Math.floor(Math.cbrt(maxSlots));
    const limit3D = limits.maxTextureDimension3D;
    const slotsX = Math.min(slotsPerAxis, Math.floor(limit3D / chunkX));
    const slotsY = Math.min(slotsPerAxis, Math.floor(limit3D / chunkY));
    const slotsZ = Math.min(slotsPerAxis, Math.floor(limit3D / chunkZ));
    const totalSlots = slotsX * slotsY * slotsZ;
    return {
      slotsX,
      slotsY,
      slotsZ,
      totalSlots,
      atlasW: slotsX * chunkX,
      atlasH: slotsY * chunkY,
      atlasD: slotsZ * chunkZ,
    };
  }

  // 2D
  const [chunkX, chunkY] = chunkDims as [number, number];
  const slotsPerAxis = Math.floor(Math.sqrt(maxSlots));
  const limit2D = limits.maxTextureDimension2D;
  const slotsX = Math.min(slotsPerAxis, Math.floor(limit2D / chunkX));
  const slotsY = Math.min(slotsPerAxis, Math.floor(limit2D / chunkY));
  const totalSlots = slotsX * slotsY;
  return {
    slotsX,
    slotsY,
    totalSlots,
    atlasW: slotsX * chunkX,
    atlasH: slotsY * chunkY,
  };
}
