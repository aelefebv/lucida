/**
 * Single source of truth for the `EntityDescriptor` byte layout. Both TS
 * writers, {@link descriptorBuffer.serializeEntityDescriptor} (cold state)
 * and {@link descriptor/transient.serializeTransientDescriptor} (minimap),
 * must read offsets from here. `descriptor/layout.test.ts` parses
 * `slice.wgsl` and `volume.wgsl` and asserts their struct offsets match.
 *
 * Layout (offsets in bytes):
 *
 *   0:   modelMatrix         mat4x4<f32>     (64)
 *   64:  invModelMatrix      mat4x4<f32>     (64)
 *   128: channelMask         u32             (4)
 *   132: sampleFormat        u32             (4) — 0 = u16 integer texels, 1 = float32 bits
 *   136: contrastMin         f32             (4)
 *   140: contrastMax         f32             (4)
 *   144: gamma               f32             (4)
 *   148: opacity             f32             (4)
 *   152: colormapLutIndex    u32             (4)
 *   156: levelSourceCount    u32             (4) — populated `levelSources` slots
 *   160: colormapMode        u32             (4) — 0 = continuous ramp, 1 = categorical label
 *   164: labelOpacity        f32             (4) — overlay opacity in categorical mode
 *   168: _pad0, _pad1        u32 × 2         (8) — `ChunkTierSource` aligns to 16
 *   176: levelSources        ChunkTierSource[4] (256) — resident levels, finest first
 *   432: coarseSource        ChunkTierSource (64)
 *
 *   total = 496 bytes
 *
 * `ChunkTierSource` (64B):
 *
 *   0:  valid             u32             (4)
 *   4:  level             u32             (4)
 *   8:  indirectionOffset u32             (4)
 *   12: poolIndex         u32             (4) — draw-local pool binding slot (level sources only)
 *   16: gridDims          vec3<u32>+pad   (16) — xyz=(X,Y,Z)
 *   32: chunkDims         vec3<u32>+pad   (16) — xyz=(X,Y,Z)
 *   48: levelDims         vec3<u32>+pad   (16) — xyz=(X,Y,Z)
 */

/**
 * The bound on resident levels per entity: how many level sources the
 * descriptor carries and how many level pools one draw binds. Matches
 * `array<ChunkTierSource, 4>` in WGSL and the `levelTex0..3` /
 * `levelIndirection0..3` bindings.
 */
export const DESCRIPTOR_MAX_LEVEL_SOURCES = 4;

/** Per explicit chunk-tier source struct size in bytes. */
export const DESCRIPTOR_TIER_SOURCE_SIZE = 64;

/** Byte offset of the `levelSources: array<ChunkTierSource, 4>` field within the entry. */
export const DESCRIPTOR_LEVEL_SOURCES_OFFSET = 176;

export const DESCRIPTOR_ENTRY_SIZE =
  DESCRIPTOR_LEVEL_SOURCES_OFFSET +
  (DESCRIPTOR_MAX_LEVEL_SOURCES + 1) * DESCRIPTOR_TIER_SOURCE_SIZE;

// Top-level field offsets (bytes)
export const OFFSET_MODEL_MATRIX = 0;            // mat4x4<f32> (64)
export const OFFSET_INV_MODEL_MATRIX = 64;       // mat4x4<f32> (64)
export const OFFSET_CHANNEL_MASK = 128;          // u32
/** How the entity's texels hold samples (`sampleFormatCode` in `dataTypeUtil.ts`). */
export const OFFSET_SAMPLE_FORMAT = 132;         // u32
export const OFFSET_CONTRAST_MIN = 136;          // f32
export const OFFSET_CONTRAST_MAX = 140;          // f32
export const OFFSET_GAMMA = 144;                 // f32
export const OFFSET_OPACITY = 148;               // f32
export const OFFSET_COLORMAP_LUT_INDEX = 152;    // u32
/** Number of populated `levelSources` slots (0..4), packed finest first. */
export const OFFSET_LEVEL_SOURCE_COUNT = 156;    // u32
/** 0 = continuous colormap ramp (intensity images); 1 = categorical
 *  label overlay (id → distinct color, id 0 transparent). */
export const OFFSET_COLORMAP_MODE = 160;         // u32
/** Overlay opacity used when `colormapMode` is categorical. */
export const OFFSET_LABEL_OPACITY = 164;         // f32
export const OFFSET_PAD0 = 168;                  // u32 (pad)
export const OFFSET_PAD1 = 172;                  // u32 (pad)
export const OFFSET_LEVEL_SOURCES = DESCRIPTOR_LEVEL_SOURCES_OFFSET;
export const OFFSET_COARSE_SOURCE =
  DESCRIPTOR_LEVEL_SOURCES_OFFSET + DESCRIPTOR_MAX_LEVEL_SOURCES * DESCRIPTOR_TIER_SOURCE_SIZE;

// Per explicit chunk-tier source field offsets within a ChunkTierSource entry.
export const SOURCE_OFFSET_VALID = 0;              // u32
export const SOURCE_OFFSET_LEVEL = 4;              // u32
export const SOURCE_OFFSET_INDIRECTION_OFFSET = 8; // u32
/** Which of the draw's level pool bindings (`levelTex<i>` /
 *  `levelIndirection<i>`) this source reads. Unused by the coarse source,
 *  which has its own binding. */
export const SOURCE_OFFSET_POOL_INDEX = 12;        // u32
export const SOURCE_OFFSET_GRID_DIMS = 16;         // vec3<u32>+pad
export const SOURCE_OFFSET_CHUNK_DIMS = 32;        // vec3<u32>+pad
export const SOURCE_OFFSET_LEVEL_DIMS = 48;        // vec3<u32>+pad

/** Byte offset of level source `i` within the entry. */
export function levelSourceOffset(i: number): number {
  return OFFSET_LEVEL_SOURCES + i * DESCRIPTOR_TIER_SOURCE_SIZE;
}
