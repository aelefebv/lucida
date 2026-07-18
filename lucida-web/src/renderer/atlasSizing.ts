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

import { Axis } from "../axes.ts";
import type { DeviceLimits } from "./gpuContext.ts";
import { computeTextureAtlasLayout } from "./atlasLayout.ts";

/** WebGPU's guaranteed floor for `maxTextureDimension3D`. */
export const WEBGPU_MIN_MAX_TEXTURE_DIMENSION_3D = 2048;

/** Bytes one categorical label voxel occupies in an `r32uint` atlas. */
export const LABEL_VOLUME_BYTES_PER_VOXEL = 4;

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
 * Slot count is bounded BOTH by the byte budget (slots-per-axis =
 * floor(cbrt or sqrt of maxSlots)) AND by the texture-dimension limit
 * (slots-per-axis <= floor(limit / chunkN)).
 *
 * @param chunkDims `[X, Y]` for 2D, `[X, Y, Z]` for 3D. Matches the
 *   WebGPU `size` tuple order — NOT `LodIndirectionMeta.chunkDims`.
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

/** Ceil-divide a level extent into its chunk-grid cell count (>= 1). */
function gridCells(extent: number, chunk: number): number {
  return chunk > 0 ? Math.max(1, Math.ceil(extent / chunk)) : 1;
}

interface LabelBrickGrid {
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  gridX: number;
  gridY: number;
  gridZ: number;
  gridCellCount: number;
}

/** Pure normalized brick/grid geometry shared by sizing and byte accounting. */
function labelBrickGrid(
  width: number,
  height: number,
  depth: number,
  chunkX: number,
  chunkY: number,
  chunkZ: number,
): LabelBrickGrid {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const d = Math.max(1, Math.floor(depth));
  const cx = Math.max(1, Math.min(Math.floor(chunkX), w));
  const cy = Math.max(1, Math.min(Math.floor(chunkY), h));
  const cz = Math.max(1, Math.min(Math.floor(chunkZ), d));
  const gridX = gridCells(w, cx);
  const gridY = gridCells(h, cy);
  const gridZ = gridCells(d, cz);
  return {
    chunkX: cx,
    chunkY: cy,
    chunkZ: cz,
    gridX,
    gridY,
    gridZ,
    gridCellCount: gridX * gridY * gridZ,
  };
}

/** Pure slot-grid geometry for one bricked categorical volume atlas. */
export interface LabelVolumeSizing {
  chunkX: number;
  chunkY: number;
  chunkZ: number;
  gridX: number;
  gridY: number;
  gridZ: number;
  gridCellCount: number;
  slotsX: number;
  slotsY: number;
  slotsZ: number;
  capacity: number;
  totalSlots: number;
  textureSize: [number, number, number];
}

/**
 * Size a label atlas to retain a level's complete brick grid. Capacity is
 * bounded only by the device dimension; admission owns the byte/chunk caps.
 */
export function computeLabelVolumeSizing(
  width: number,
  height: number,
  depth: number,
  chunkX: number,
  chunkY: number,
  chunkZ: number,
  maxTextureDimension3D: number,
): LabelVolumeSizing {
  const grid = labelBrickGrid(
    width,
    height,
    depth,
    chunkX,
    chunkY,
    chunkZ,
  );
  const layout = computeTextureAtlasLayout(
    [grid.chunkZ, grid.chunkY, grid.chunkX],
    grid.gridCellCount,
    maxTextureDimension3D,
  );
  return {
    ...grid,
    slotsX: layout.slotsX,
    slotsY: layout.slotsY,
    slotsZ: layout.slotsZ,
    capacity: layout.capacity,
    totalSlots: layout.slotsX * layout.slotsY * layout.slotsZ,
    textureSize: layout.textureSize,
  };
}

/**
 * Upper-bound bytes reserved by a label level's padded rectangular slot grid.
 * Packing at the WebGPU guaranteed floor can only be looser than a device with
 * a larger limit, so admission never under-counts the eventual allocation.
 */
export function labelPaddedVolumeBytes(
  levelShape: readonly number[],
  chunkShape: readonly number[],
): number {
  const sizing = computeLabelVolumeSizing(
    levelShape[Axis.X],
    levelShape[Axis.Y],
    levelShape[Axis.Z],
    chunkShape[Axis.X],
    chunkShape[Axis.Y],
    chunkShape[Axis.Z],
    WEBGPU_MIN_MAX_TEXTURE_DIMENSION_3D,
  );
  const [texW, texH, texD] = sizing.textureSize;
  return texW * texH * texD * LABEL_VOLUME_BYTES_PER_VOXEL;
}
