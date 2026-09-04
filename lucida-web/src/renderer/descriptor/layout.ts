/**
 * Single source of truth for the `EntityDescriptor` byte layout.
 *
 * Both TS writers — the canonical {@link
 * descriptorBuffer.serializeEntityDescriptor} (cold-state path) and the
 * transient {@link descriptor/transient.serializeTransientDescriptor}
 * (minimap path) — must read offsets from this file. The WGSL struct
 * declarations in `slice.wgsl` and `volume.wgsl` must agree with these
 * offsets; the cross-check is enforced by `descriptor/layout.test.ts`,
 * which parses both shaders and asserts WGSL std140 / host-shareable
 * offsets match the constants below.
 *
 * Layout (offsets in bytes):
 *
 *   0:   modelMatrix         mat4x4<f32>     (64)
 *   64:  invModelMatrix      mat4x4<f32>     (64)
 *   128: channelMask         u32             (4)
 *   132: tileProxyPoolIndex  u32             (4)
 *   136: tileProxySlotIndex  u32             (4)
 *   140: groupProxyPoolIndex u32             (4)
 *   144: groupProxySlotIndex u32             (4)
 *   148: _pad_proxy0         u32             (4)
 *   152: _pad_proxy1         u32             (4)
 *   156: _pad_proxy2         u32             (4)
 *   160: tileProxyDims       vec3<u32>+pad   (16) — xyz=(Z,Y,X)
 *   176: groupProxyDims      vec3<u32>+pad   (16) — xyz=(Z,Y,X)
 *   192: contrastMin         f32             (4)
 *   196: contrastMax         f32             (4)
 *   200: gamma               f32             (4)
 *   204: opacity             f32             (4)
 *   208: colormapLutIndex    u32             (4)
 *   212: levelSourceCount    u32             (4) — populated `levelSources` slots
 *   216: colormapMode        u32             (4) — 0 = continuous ramp, 1 = categorical label
 *   220: labelOpacity        f32             (4) — overlay opacity in categorical mode
 *   224: levelSources        ChunkTierSource[4] (256) — resident levels, finest first
 *   480: coarseSource        ChunkTierSource (64)
 *
 *   total = 544 bytes
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
export const DESCRIPTOR_LEVEL_SOURCES_OFFSET = 224;

export const DESCRIPTOR_ENTRY_SIZE =
  DESCRIPTOR_LEVEL_SOURCES_OFFSET +
  (DESCRIPTOR_MAX_LEVEL_SOURCES + 1) * DESCRIPTOR_TIER_SOURCE_SIZE;

/** Shader-side sentinel for missing pool / slot. Matches `0xFFFFFFFFu`. */
export const DESCRIPTOR_SENTINEL_INDEX = 0xffffffff;

// Top-level field offsets (bytes)
export const OFFSET_MODEL_MATRIX = 0;            // mat4x4<f32> (64)
export const OFFSET_INV_MODEL_MATRIX = 64;       // mat4x4<f32> (64)
export const OFFSET_CHANNEL_MASK = 128;          // u32
export const OFFSET_TILE_PROXY_POOL_INDEX = 132; // u32
export const OFFSET_TILE_PROXY_SLOT_INDEX = 136; // u32
export const OFFSET_GROUP_PROXY_POOL_INDEX = 140;  // u32
export const OFFSET_GROUP_PROXY_SLOT_INDEX = 144;  // u32
export const OFFSET_PAD_PROXY0 = 148;            // u32 (pad)
export const OFFSET_PAD_PROXY1 = 152;            // u32 (pad)
export const OFFSET_PAD_PROXY2 = 156;            // u32 (pad)
export const OFFSET_TILE_PROXY_DIMS = 160;      // vec3<u32>+pad (16) — xyz=(Z,Y,X)
export const OFFSET_GROUP_PROXY_DIMS = 176;       // vec3<u32>+pad (16) — xyz=(Z,Y,X)
export const OFFSET_CONTRAST_MIN = 192;          // f32
export const OFFSET_CONTRAST_MAX = 196;          // f32
export const OFFSET_GAMMA = 200;                 // f32
export const OFFSET_OPACITY = 204;               // f32
export const OFFSET_COLORMAP_LUT_INDEX = 208;    // u32
/** Number of populated `levelSources` slots (0..4), packed finest first. */
export const OFFSET_LEVEL_SOURCE_COUNT = 212;    // u32
/** 0 = continuous colormap ramp (intensity images); 1 = categorical
 *  label overlay (id → distinct color, id 0 transparent). */
export const OFFSET_COLORMAP_MODE = 216;         // u32
/** Overlay opacity used when `colormapMode` is categorical. */
export const OFFSET_LABEL_OPACITY = 220;         // f32
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
