/**
 * Transient single-entity descriptor serializer.
 *
 * Used by callers that don't have a cold-state-backed descriptor buffer
 * (currently just the minimap path — see `volumeRenderer.setTransientDescriptor`).
 * Writes `modelMatrix` + `invModelMatrix`, sentinel proxy handles, unit
 * proxy dims, display state, and a single LOD slot covering the full
 * volume (single-slot atlas).
 *
 * Reads byte offsets from `./layout.ts` — the same source of truth used
 * by the canonical `descriptorBuffer.serializeEntityDescriptor`. The
 * WGSL ↔ TS agreement test in `./layout.test.ts` covers both writers.
 */

import {
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_LOD_INFO_SIZE,
  DESCRIPTOR_LODS_OFFSET,
  DESCRIPTOR_MAX_LODS,
  DESCRIPTOR_SENTINEL_INDEX,
  LOD_OFFSET_CHUNK_DIMS,
  LOD_OFFSET_GRID_DIMS,
  LOD_OFFSET_INDIRECTION_OFFSET,
  LOD_OFFSET_LEVEL,
  LOD_OFFSET_LEVEL_DIMS,
  OFFSET_CONTRAST_MAX,
  OFFSET_CONTRAST_MIN,
  OFFSET_TILE_PROXY_DIMS,
  OFFSET_TILE_PROXY_POOL_INDEX,
  OFFSET_TILE_PROXY_SLOT_INDEX,
  OFFSET_COLORMAP_MODE,
  OFFSET_GAMMA,
  OFFSET_INV_MODEL_MATRIX,
  OFFSET_LABEL_OPACITY,
  OFFSET_LOD_COUNT,
  OFFSET_MODEL_MATRIX,
  OFFSET_OPACITY,
  OFFSET_GROUP_PROXY_DIMS,
  OFFSET_GROUP_PROXY_POOL_INDEX,
  OFFSET_GROUP_PROXY_SLOT_INDEX,
} from "./layout.ts";

export interface TransientDescriptorParams {
  modelMatrix: Float32Array;
  invModelMatrix: Float32Array;
  volumeDims: [number, number, number];
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  opacity: number;
  /**
   * `0` (default) = continuous colormap ramp; `1` = categorical label
   * overlay (integer id → distinct color, id 0 transparent).
   */
  colormapMode?: number;
  /** Overlay opacity used in categorical mode (default `1`). */
  labelOpacity?: number;
  /**
   * Bricked LOD 0: when present, the single LOD is written with these
   * chunk-grid dims and per-brick voxel dims (`[X, Y, Z]` order, matching
   * `volumeDims`), so the shader walks a slot-grid atlas via its indirection
   * buffer. `levelDims` is `volumeDims`, `indirectionOffset` 0, `lodCount` 1.
   *
   * When ABSENT, LOD 0 covers the whole volume in a single slot
   * (`gridDims = [1,1,1]`, `chunkDims = volumeDims`) — the byte-identical
   * single-tile layout the minimap/thumbnail path relies on.
   */
  lod?: {
    gridDims: [number, number, number];
    chunkDims: [number, number, number];
  };
}

/**
 * Serialize a transient single-entity descriptor into `target`.
 *
 * `target` must be at least {@link DESCRIPTOR_ENTRY_SIZE} bytes. The
 * descriptor is written starting at byte 0 — callers wanting an offset
 * should pass a subarray.
 *
 * The descriptor:
 *   - sets sentinel pool / slot indices (no proxy fallback)
 *   - sets unit (1×1×1) proxy dims (defensive; ignored when slot is sentinel)
 *   - encodes one LOD covering the full volume with `chunkDims == levelDims`
 *     and `gridDims = [1, 1, 1]`, matching the single-slot atlas layout
 *     used by `volumeRenderer.setVolume`
 *   - zeroes the remaining LOD slots
 */
export function serializeTransientDescriptor(
  target: ArrayBuffer,
  params: TransientDescriptorParams,
): void {
  const f32 = new Float32Array(target, 0, DESCRIPTOR_ENTRY_SIZE / 4);
  const u32 = new Uint32Array(target, 0, DESCRIPTOR_ENTRY_SIZE / 4);

  if (params.modelMatrix.length === 16) f32.set(params.modelMatrix, OFFSET_MODEL_MATRIX / 4);
  if (params.invModelMatrix.length === 16) f32.set(params.invModelMatrix, OFFSET_INV_MODEL_MATRIX / 4);

  // Sentinel proxy handles — the unified fallback chain in the shader
  // short-circuits the proxy steps when the slot index is sentinel.
  u32[OFFSET_TILE_PROXY_POOL_INDEX / 4] = DESCRIPTOR_SENTINEL_INDEX;
  u32[OFFSET_TILE_PROXY_SLOT_INDEX / 4] = DESCRIPTOR_SENTINEL_INDEX;
  u32[OFFSET_GROUP_PROXY_POOL_INDEX / 4]  = DESCRIPTOR_SENTINEL_INDEX;
  u32[OFFSET_GROUP_PROXY_SLOT_INDEX / 4]  = DESCRIPTOR_SENTINEL_INDEX;

  // Unit proxy dims (defensive — proxy slot is sentinel, so dims are unread).
  const tileDimsBase = OFFSET_TILE_PROXY_DIMS / 4;
  u32[tileDimsBase + 0] = 1;
  u32[tileDimsBase + 1] = 1;
  u32[tileDimsBase + 2] = 1;
  const groupDimsBase = OFFSET_GROUP_PROXY_DIMS / 4;
  u32[groupDimsBase + 0] = 1;
  u32[groupDimsBase + 1] = 1;
  u32[groupDimsBase + 2] = 1;

  f32[OFFSET_CONTRAST_MIN / 4] = params.contrastMin;
  f32[OFFSET_CONTRAST_MAX / 4] = params.contrastMax;
  f32[OFFSET_GAMMA / 4]        = params.gamma;
  f32[OFFSET_OPACITY / 4]      = params.opacity;
  u32[OFFSET_COLORMAP_MODE / 4] = (params.colormapMode ?? 0) >>> 0;
  f32[OFFSET_LABEL_OPACITY / 4] = params.labelOpacity ?? 1;

  // Single LOD covering the volume. Either one slot for the whole volume
  // (default) or the bricked grid supplied in `params.lod`.
  u32[OFFSET_LOD_COUNT / 4] = 1;

  const lodsBaseU32 = DESCRIPTOR_LODS_OFFSET / 4;
  const lodStrideU32 = DESCRIPTOR_LOD_INFO_SIZE / 4;

  // LOD 0: level=0, offset=0. gridDims + chunkDims come from `params.lod` when
  // present (bricked slot-grid atlas), else (1,1,1) + volumeDims (single slot).
  // levelDims is always the volume extent.
  const grid = params.lod?.gridDims ?? [1, 1, 1];
  const chunk = params.lod?.chunkDims ?? params.volumeDims;
  u32[lodsBaseU32 + LOD_OFFSET_LEVEL / 4]              = 0;
  u32[lodsBaseU32 + LOD_OFFSET_INDIRECTION_OFFSET / 4] = 0;
  const gridBase = lodsBaseU32 + LOD_OFFSET_GRID_DIMS / 4;
  u32[gridBase + 0] = grid[0];
  u32[gridBase + 1] = grid[1];
  u32[gridBase + 2] = grid[2];
  const chunkBase = lodsBaseU32 + LOD_OFFSET_CHUNK_DIMS / 4;
  u32[chunkBase + 0] = chunk[0];
  u32[chunkBase + 1] = chunk[1];
  u32[chunkBase + 2] = chunk[2];
  const levelBase = lodsBaseU32 + LOD_OFFSET_LEVEL_DIMS / 4;
  u32[levelBase + 0] = params.volumeDims[0];
  u32[levelBase + 1] = params.volumeDims[1];
  u32[levelBase + 2] = params.volumeDims[2];

  // Zero out the remaining LOD slots.
  for (let i = 1; i < DESCRIPTOR_MAX_LODS; i++) {
    const base = lodsBaseU32 + i * lodStrideU32;
    for (let s = 0; s < lodStrideU32; s++) u32[base + s] = 0;
  }
}
