/**
 * Transient single-entity descriptor serializer, for callers with no
 * cold-state-backed descriptor buffer: the minimap path and the label
 * overlay draws.
 *
 * Byte offsets come from `./layout.ts`, shared with
 * `descriptorBuffer.serializeEntityDescriptor`, and `./layout.test.ts`
 * checks them against the WGSL.
 */

import {
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_TIER_SOURCE_SIZE,
  OFFSET_COARSE_SOURCE,
  OFFSET_CONTRAST_MAX,
  OFFSET_CONTRAST_MIN,
  OFFSET_COLORMAP_MODE,
  OFFSET_GAMMA,
  OFFSET_INV_MODEL_MATRIX,
  OFFSET_LABEL_OPACITY,
  OFFSET_LEVEL_SOURCE_COUNT,
  OFFSET_MODEL_MATRIX,
  OFFSET_OPACITY,
  OFFSET_SAMPLE_FORMAT,
  SOURCE_OFFSET_CHUNK_DIMS,
  SOURCE_OFFSET_GRID_DIMS,
  SOURCE_OFFSET_INDIRECTION_OFFSET,
  SOURCE_OFFSET_LEVEL,
  SOURCE_OFFSET_LEVEL_DIMS,
  SOURCE_OFFSET_POOL_INDEX,
  SOURCE_OFFSET_VALID,
  levelSourceOffset,
} from "./layout.ts";
import { sampleFormatCode, type SampleFormat } from "../dataTypeUtil.ts";

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
  /** How the bound texture holds samples (default `u16`). */
  sampleFormat?: SampleFormat;
  /**
   * The level's chunk grid, `[X, Y, Z]` like `volumeDims`, so the shader
   * walks a slot-grid atlas via its indirection buffer. When absent the level
   * is one slot covering the whole volume.
   */
  chunkGrid?: {
    gridDims: [number, number, number];
    chunkDims: [number, number, number];
  };
}

/**
 * Serialize a transient single-entity descriptor at `byteOffset` of
 * `target`, which must hold {@link DESCRIPTOR_ENTRY_SIZE} bytes from there.
 * Only level source 0 (pool binding 0) is valid.
 */
export function serializeTransientDescriptor(
  target: ArrayBuffer,
  params: TransientDescriptorParams,
  byteOffset = 0,
): void {
  const f32 = new Float32Array(target, byteOffset, DESCRIPTOR_ENTRY_SIZE / 4);
  const u32 = new Uint32Array(target, byteOffset, DESCRIPTOR_ENTRY_SIZE / 4);

  if (params.modelMatrix.length === 16) f32.set(params.modelMatrix, OFFSET_MODEL_MATRIX / 4);
  if (params.invModelMatrix.length === 16) f32.set(params.invModelMatrix, OFFSET_INV_MODEL_MATRIX / 4);

  f32[OFFSET_CONTRAST_MIN / 4] = params.contrastMin;
  f32[OFFSET_CONTRAST_MAX / 4] = params.contrastMax;
  f32[OFFSET_GAMMA / 4]        = params.gamma;
  f32[OFFSET_OPACITY / 4]      = params.opacity;
  u32[OFFSET_COLORMAP_MODE / 4] = (params.colormapMode ?? 0) >>> 0;
  f32[OFFSET_LABEL_OPACITY / 4] = params.labelOpacity ?? 1;
  u32[OFFSET_SAMPLE_FORMAT / 4] = sampleFormatCode(params.sampleFormat ?? "u16");

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
