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
 *   132: tileProxyPoolIndex u32             (4)
 *   136: tileProxySlotIndex u32             (4)
 *   140: groupProxyPoolIndex  u32             (4)
 *   144: groupProxySlotIndex  u32             (4)
 *   148: _pad_proxy0         u32             (4)
 *   152: _pad_proxy1         u32             (4)
 *   156: _pad_proxy2         u32             (4)
 *   160: tileProxyDims      vec3<u32>+pad   (16) — xyz=(Z,Y,X)
 *   176: groupProxyDims       vec3<u32>+pad   (16) — xyz=(Z,Y,X)
 *   192: contrastMin         f32             (4)
 *   196: contrastMax         f32             (4)
 *   200: gamma               f32             (4)
 *   204: opacity             f32             (4)
 *   208: colormapLutIndex    u32             (4)
 *   212: lodCount            u32             (4)
 *   216: colormapMode        u32             (4) — 0 = continuous ramp, 1 = categorical label
 *   220: labelOpacity        f32             (4) — overlay opacity in categorical mode
 *   224: lods                LodInfo[8]      (512)
 *
 *   736: detailSource        ChunkTierSource (64)
 *   800: coarseSource        ChunkTierSource (64)
 *
 *   total = 864 bytes
 *
 * `LodInfo` (64B):
 *
 *   0:  level             u32             (4)
 *   4:  indirectionOffset u32             (4)
 *   8:  _pad0             u32             (4)
 *   12: _pad1             u32             (4)
 *   16: gridDims          vec3<u32>+pad   (16) — xyz=(X,Y,Z)
 *   32: chunkDims         vec3<u32>+pad   (16) — xyz=(X,Y,Z)
 *   48: levelDims         vec3<u32>+pad   (16) — xyz=(X,Y,Z)
 */

/** Maximum LOD slots packed per entity. Matches `LodInfo[8]` in WGSL. */
export const DESCRIPTOR_MAX_LODS = 8;

/** Per-LOD struct size in bytes (matches WGSL `LodInfo`). */
export const DESCRIPTOR_LOD_INFO_SIZE = 64;

/** Per explicit chunk-tier source struct size in bytes. */
export const DESCRIPTOR_TIER_SOURCE_SIZE = 64;

/** Byte offset of the `lods: array<LodInfo, 8>` field within the entry. */
export const DESCRIPTOR_LODS_OFFSET = 224;

export const DESCRIPTOR_ENTRY_SIZE =
  DESCRIPTOR_LODS_OFFSET +
  DESCRIPTOR_MAX_LODS * DESCRIPTOR_LOD_INFO_SIZE +
  2 * DESCRIPTOR_TIER_SOURCE_SIZE;

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
export const OFFSET_LOD_COUNT = 212;             // u32
/** 0 = continuous colormap ramp (intensity images); 1 = categorical
 *  label overlay (id → distinct color, id 0 transparent). */
export const OFFSET_COLORMAP_MODE = 216;         // u32
/** Overlay opacity used when `colormapMode` is categorical. */
export const OFFSET_LABEL_OPACITY = 220;         // f32
/** Alias for {@link DESCRIPTOR_LODS_OFFSET}, kept for symmetry with the
 *  other `OFFSET_*` constants when reading layout side-by-side with the
 *  WGSL struct. */
export const OFFSET_LODS = DESCRIPTOR_LODS_OFFSET;
export const OFFSET_DETAIL_SOURCE =
  DESCRIPTOR_LODS_OFFSET + DESCRIPTOR_MAX_LODS * DESCRIPTOR_LOD_INFO_SIZE;
export const OFFSET_COARSE_SOURCE = OFFSET_DETAIL_SOURCE + DESCRIPTOR_TIER_SOURCE_SIZE;

// Per-LOD field offsets within a LodInfo entry (relative to LodInfo start)
export const LOD_OFFSET_LEVEL = 0;                // u32
export const LOD_OFFSET_INDIRECTION_OFFSET = 4;   // u32
export const LOD_OFFSET_PAD0 = 8;                 // u32 (pad)
export const LOD_OFFSET_PAD1 = 12;                // u32 (pad)
export const LOD_OFFSET_GRID_DIMS = 16;           // vec3<u32>+pad
export const LOD_OFFSET_CHUNK_DIMS = 32;          // vec3<u32>+pad
export const LOD_OFFSET_LEVEL_DIMS = 48;          // vec3<u32>+pad

// Per explicit chunk-tier source field offsets within a ChunkTierSource entry.
export const SOURCE_OFFSET_VALID = 0;              // u32
export const SOURCE_OFFSET_LEVEL = 4;              // u32
export const SOURCE_OFFSET_INDIRECTION_OFFSET = 8; // u32
export const SOURCE_OFFSET_PAD0 = 12;              // u32 (pad)
export const SOURCE_OFFSET_GRID_DIMS = 16;         // vec3<u32>+pad
export const SOURCE_OFFSET_CHUNK_DIMS = 32;        // vec3<u32>+pad
export const SOURCE_OFFSET_LEVEL_DIMS = 48;        // vec3<u32>+pad
