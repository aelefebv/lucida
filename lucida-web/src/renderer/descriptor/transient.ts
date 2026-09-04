/**
 * Transient single-entity descriptor serializer.
 *
 * Used by callers that don't have a cold-state-backed descriptor buffer
 * (the minimap path via `volumeRenderer.setTransientDescriptor`, and the
 * label overlay draws). Writes `modelMatrix` + `invModelMatrix`, sentinel
 * proxy handles, unit proxy dims, display state, and one level source
 * covering the full volume from level pool binding 0 (a single-slot or
 * chunk-grid atlas bound there).
 *
 * Reads byte offsets from `./layout.ts` — the same source of truth used
 * by the canonical `descriptorBuffer.serializeEntityDescriptor`. The
 * WGSL ↔ TS agreement test in `./layout.test.ts` covers both writers.
 */

import {
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_SENTINEL_INDEX,
  DESCRIPTOR_TIER_SOURCE_SIZE,
  OFFSET_COARSE_SOURCE,
  OFFSET_CONTRAST_MAX,
  OFFSET_CONTRAST_MIN,
  OFFSET_TILE_PROXY_DIMS,
  OFFSET_TILE_PROXY_POOL_INDEX,
  OFFSET_TILE_PROXY_SLOT_INDEX,
  OFFSET_COLORMAP_MODE,
  OFFSET_GAMMA,
  OFFSET_INV_MODEL_MATRIX,
  OFFSET_LABEL_OPACITY,
  OFFSET_LEVEL_SOURCE_COUNT,
  OFFSET_MODEL_MATRIX,
  OFFSET_OPACITY,
  OFFSET_GROUP_PROXY_DIMS,
  OFFSET_GROUP_PROXY_POOL_INDEX,
  OFFSET_GROUP_PROXY_SLOT_INDEX,
  SOURCE_OFFSET_CHUNK_DIMS,
  SOURCE_OFFSET_GRID_DIMS,
  SOURCE_OFFSET_INDIRECTION_OFFSET,
  SOURCE_OFFSET_LEVEL,
  SOURCE_OFFSET_LEVEL_DIMS,
  SOURCE_OFFSET_POOL_INDEX,
  SOURCE_OFFSET_VALID,
  levelSourceOffset,
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
   * Chunk grid of the level: when present, the level source is written
   * with these grid dims and per-chunk voxel dims (`[X, Y, Z]` order,
   * matching `volumeDims`), so the shader walks a slot-grid atlas via its
   * indirection buffer. `levelDims` is `volumeDims`, `indirectionOffset` 0.
   *
   * When ABSENT, the level covers the whole volume in a single slot
   * (`gridDims = [1,1,1]`, `chunkDims = volumeDims`) — the single-tile
   * layout the minimap/thumbnail path relies on.
   */
  chunkGrid?: {
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
 *   - encodes one level source (level 0, pool binding 0) covering the
 *     full volume with `chunkDims == levelDims` and `gridDims = [1, 1, 1]`,
 *     matching the single-slot atlas layout used by `volumeRenderer.setVolume`
 *   - zeroes the remaining level sources and the coarse source
 */
export function serializeTransientDescriptor(
  target: ArrayBuffer,
  params: TransientDescriptorParams,
): void {
  const f32 = new Float32Array(target, 0, DESCRIPTOR_ENTRY_SIZE / 4);
  const u32 = new Uint32Array(target, 0, DESCRIPTOR_ENTRY_SIZE / 4);

  if (params.modelMatrix.length === 16) f32.set(params.modelMatrix, OFFSET_MODEL_MATRIX / 4);
  if (params.invModelMatrix.length === 16) f32.set(params.invModelMatrix, OFFSET_INV_MODEL_MATRIX / 4);

  // Sentinel proxy handles — the shader's proxy steps short-circuit when
  // the slot index is sentinel (and are only reached with no chunk tier).
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

  u32[OFFSET_LEVEL_SOURCE_COUNT / 4] = 1;

  const grid = params.chunkGrid?.gridDims ?? [1, 1, 1];
  const chunk = params.chunkGrid?.chunkDims ?? params.volumeDims;
  const base = levelSourceOffset(0) / 4;
  u32[base + SOURCE_OFFSET_VALID / 4] = 1;
  u32[base + SOURCE_OFFSET_LEVEL / 4] = 0;
  u32[base + SOURCE_OFFSET_INDIRECTION_OFFSET / 4] = 0;
  u32[base + SOURCE_OFFSET_POOL_INDEX / 4] = 0;
  const gridBase = base + SOURCE_OFFSET_GRID_DIMS / 4;
  u32[gridBase + 0] = grid[0];
  u32[gridBase + 1] = grid[1];
  u32[gridBase + 2] = grid[2];
  const chunkBase = base + SOURCE_OFFSET_CHUNK_DIMS / 4;
  u32[chunkBase + 0] = chunk[0];
  u32[chunkBase + 1] = chunk[1];
  u32[chunkBase + 2] = chunk[2];
  const levelBase = base + SOURCE_OFFSET_LEVEL_DIMS / 4;
  u32[levelBase + 0] = params.volumeDims[0];
  u32[levelBase + 1] = params.volumeDims[1];
  u32[levelBase + 2] = params.volumeDims[2];

  const wordsPerSource = DESCRIPTOR_TIER_SOURCE_SIZE / 4;
  const tailStart = levelSourceOffset(1) / 4;
  const tailEnd = OFFSET_COARSE_SOURCE / 4 + wordsPerSource;
  for (let i = tailStart; i < tailEnd; i++) u32[i] = 0;
}
