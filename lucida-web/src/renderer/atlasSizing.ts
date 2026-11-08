/**
 * Slot-grid math for the volume and slice atlas pools: how many fixed-size
 * slots fit a byte cap under the device's max texture dimension.
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
 * The widest grid a pool may grow to under `capBytes`. A pool starts one row
 * (2D) or one layer (3D) deep and grows along its last axis, so the last axis
 * is the one this keeps longest.
 *
 * The grid holds as many slots as the cap allows, not a square or cube root of
 * it rounded down per axis, which could drop most of them: 16 slots' worth of
 * `256³` chunks rounds to a `2×2×2` cube of 8. At least one slot, even when
 * one slot alone is over the cap.
 *
 * @param chunkDims `[X, Y]` for 2D, `[X, Y, Z]` for 3D.
 * @param bytesPerVoxel Storage per voxel: `2` for the `r16uint`
 *   intensity atlas (default), `4` for the `r32uint` label atlas.
 */
export function computeAtlasGeometry(
  limits: DeviceLimits,
  chunkDims: [number, number] | [number, number, number],
  capBytes: number,
  dimArity: "2d" | "3d",
  bytesPerVoxel: number = 2,
): AtlasGeometry {
  const chunkTexels = chunkDims.reduce((a, b) => a * b, 1);
  const maxSlots = Math.max(1, Math.floor(capBytes / (chunkTexels * bytesPerVoxel)));

  if (dimArity === "3d") {
    const [chunkX, chunkY, chunkZ] = chunkDims as [number, number, number];
    const limit = limits.maxTextureDimension3D;
    const capX = slotsAlong(limit, chunkX);
    const capY = slotsAlong(limit, chunkY);
    const capZ = slotsAlong(limit, chunkZ);
    let best = { x: 1, y: 1, z: 1 };
    for (let z = 1; z <= Math.min(capZ, maxSlots); z++) {
      const [x, y] = squarestGrid(Math.floor(maxSlots / z), capX, capY);
      // `>=`: among equal totals the deepest grid has the smallest layers,
      // so the pool grows in the finest steps.
      if (x * y * z >= best.x * best.y * best.z) best = { x, y, z };
    }
    return {
      slotsX: best.x,
      slotsY: best.y,
      slotsZ: best.z,
      totalSlots: best.x * best.y * best.z,
      atlasW: best.x * chunkX,
      atlasH: best.y * chunkY,
      atlasD: best.z * chunkZ,
    };
  }

  const [chunkX, chunkY] = chunkDims as [number, number];
  const limit = limits.maxTextureDimension2D;
  const [slotsX, slotsY] = squarestGrid(maxSlots, slotsAlong(limit, chunkX), slotsAlong(limit, chunkY));
  return {
    slotsX,
    slotsY,
    totalSlots: slotsX * slotsY,
    atlasW: slotsX * chunkX,
    atlasH: slotsY * chunkY,
  };
}

/**
 * The most one chunk pool may grow to: the GPU total, and no more than the
 * adapter's largest buffer, since a device that can't allocate a buffer that
 * size has no room for a texture that size beside everything else.
 */
export function poolCapBytes(limits: DeviceLimits, gpuTotalBytes: number): number {
  return Math.min(gpuTotalBytes, limits.maxBufferSize);
}

/** Slots of `chunk` texels that fit along a texture axis of `limit`, at least one. */
function slotsAlong(limit: number, chunk: number): number {
  return Math.max(1, Math.floor(limit / Math.max(1, chunk)));
}

/** The `[x, y]` with the most cells, at most `n`, inside the caps; the squarest among equals. */
function squarestGrid(n: number, capX: number, capY: number): [number, number] {
  let bestX = 1;
  let bestY = 1;
  for (let y = 1; y <= Math.min(capY, Math.max(1, n)); y++) {
    const x = Math.max(1, Math.min(capX, Math.floor(n / y)));
    const cells = x * y;
    const best = bestX * bestY;
    if (cells > best || (cells === best && Math.abs(x - y) < Math.abs(bestX - bestY))) {
      bestX = x;
      bestY = y;
    }
  }
  return [bestX, bestY];
}
