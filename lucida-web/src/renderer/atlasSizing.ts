/**
 * Shared slot-grid math for renderer atlas pools.
 *
 * Both `volume/atlas.ts` and `slice/atlas.ts` need to decide how many
 * fixed-size slots fit in their texture given a byte budget and the
 * device's max texture dimension. Device limits live in `getDeviceLimits`
 * (`gpuContext.ts`); slot-grid math lives here.
 *
 * Dimension-order convention
 * --------------------------
 * `chunkDims` here is `[X, Y]` for 2D atlases and `[X, Y, Z]` for 3D
 * atlases. This matches the WebGPU `size` tuple convention and the
 * existing positional parameter order of `createVolumeAtlas` /
 * `createSliceAtlas` (which both took `chunkX, chunkY[, chunkZ]`).
 *
 * NOTE: This is the OPPOSITE order from `LodIndirectionMeta.chunkDims`,
 * which is stored as `[Z, Y, X]`. Don't mix them.
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
 * Compute slot grid dimensions for an atlas given a per-slot voxel
 * footprint and a byte budget. Honors the device's max texture
 * dimension for the relevant arity (2D or 3D).
 *
 * Assumes 2 bytes per voxel (the `r16uint` format used by both the
 * volume and slice atlases). Slot count is bounded BOTH by the byte
 * budget (slots-per-axis = floor(cbrt or sqrt of maxSlots)) AND by the
 * texture-dimension limit (slots-per-axis <= floor(limit / chunkN)).
 *
 * @param chunkDims `[X, Y]` for 2D, `[X, Y, Z]` for 3D. Matches the
 *   WebGPU `size` tuple order — NOT `LodIndirectionMeta.chunkDims`.
 */
export function computeAtlasGeometry(
  limits: DeviceLimits,
  chunkDims: [number, number] | [number, number, number],
  budgetBytes: number,
  dimArity: "2d" | "3d",
): AtlasGeometry {
  const chunkTexels = chunkDims.reduce((a, b) => a * b, 1);
  // 2 bytes per voxel (r16uint).
  const maxSlots = Math.floor(budgetBytes / (chunkTexels * 2));

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
