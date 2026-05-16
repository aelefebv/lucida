/**
 * M1+M2 (DOMAINS step 8a): per-dataset entity descriptor buffer.
 *
 * Holds the geometric/LOD/proxy fields the shader used to read out of
 * per-frame uniforms: model matrix + inverse, per-LOD chunk/grid/level
 * dims with indirection offsets, proxy handles (pool index + slot
 * index), proxy slot dims, and (M2) per-channel display state
 * (contrast/gamma/opacity/colormapLutIndex/channelMask).
 *
 * The descriptor lives entirely in worker-side state. Orchestrator and
 * worker converge on entity indices by construction — both walk
 * `cold.activeSet × cold.visibleChannels` in the same canonical order
 * (see {@link iterateColdMembers}), so no readback is needed.
 *
 * Display-state changes (contrast slider, colormap dropdown, etc.)
 * bump `epochs.selection` in the WASM scene. The orchestrator detects
 * this via its standard epoch-cache check, re-runs `plan()`, re-emits
 * cold state, and the worker rebuilds the descriptor buffer.
 * Deliberately no separate "descriptorPatch" message — display-state
 * changes flow through the same cold-state seam as everything else.
 */

import type {
  ColdStateMessage,
  ColdStateActiveEntry,
  ColdStateDisplayState,
} from "./workerProtocol.ts";
import type { EntityProxyDescriptor } from "./workerContext.ts";
import type { ProxyAtlasState } from "./proxyAtlas.ts";
import type { LodIndirectionMeta } from "./volumeHandlers.ts";

/** Maximum LOD slots packed per entity. Matches `LodInfo[8]` in WGSL. */
export const DESCRIPTOR_MAX_LODS = 8;

/**
 * Per-entity descriptor size in bytes. Mirrors the WGSL `EntityDescriptor`
 * layout in volume.wgsl / slice.wgsl.
 *
 * Layout (offsets in bytes):
 *
 *   0:   modelMatrix         mat4x4<f32>     (64)
 *   64:  invModelMatrix      mat4x4<f32>     (64)
 *   128: channelMask         u32             (4)  — placeholder M1
 *   132: fieldProxyPoolIndex u32             (4)
 *   136: fieldProxySlotIndex u32             (4)
 *   140: wellProxyPoolIndex  u32             (4)
 *   144: wellProxySlotIndex  u32             (4)
 *   148: _pad_proxy0         u32             (4)
 *   152: _pad_proxy1         u32             (4)
 *   156: _pad_proxy2         u32             (4)
 *   160: fieldProxyDims      vec3<u32>+pad   (16) — xyz=(Z,Y,X)
 *   176: wellProxyDims       vec3<u32>+pad   (16) — xyz=(Z,Y,X)
 *   192: contrastMin         f32             (4)  — placeholder M1
 *   196: contrastMax         f32             (4)  — placeholder M1
 *   200: gamma               f32             (4)  — placeholder M1
 *   204: opacity             f32             (4)  — placeholder M1
 *   208: colormapLutIndex    u32             (4)  — placeholder M1
 *   212: lodCount            u32             (4)
 *   216: _pad_tail0          u32             (4)
 *   220: _pad_tail1          u32             (4)
 *   224: lods                LodInfo[8]      (512)
 *
 *   total = 736 bytes
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
export const DESCRIPTOR_LOD_INFO_SIZE = 64;
export const DESCRIPTOR_LODS_OFFSET = 224;
export const DESCRIPTOR_ENTRY_SIZE =
  DESCRIPTOR_LODS_OFFSET + DESCRIPTOR_MAX_LODS * DESCRIPTOR_LOD_INFO_SIZE;

/** Shader-side sentinel for missing pool / slot. Matches `0xFFFFFFFFu`. */
export const DESCRIPTOR_SENTINEL_INDEX = 0xffffffff;

export interface EntityDescriptorIndex {
  buffer: GPUBuffer;
  /** memberId → entity index in {@link buffer}. */
  indexByMember: Map<string, number>;
  /** poolKey → dense pool index (matches GPU descriptor's *PoolIndex fields). */
  proxyPoolIndexByKey: Map<string, number>;
  /** Dense pool array indexed by proxy pool index, used by render handlers
   * to bind the right proxy texture without re-walking the descriptor. */
  proxyPoolsByIndex: ProxyAtlasState[];
  /** Number of populated descriptor entries (== `indexByMember.size`). */
  entityCount: number;
  /**
   * M2: colormap name → dense LUT index (matches GPU descriptor's
   * `colormapLutIndex` field). Stable across rebuilds in the
   * insertion-order they were first seen for this dataset; the GPU
   * descriptor's index is informational, with the CPU resolving
   * `colormapNameByMember` per draw to bind the right LUT texture.
   */
  colormapLutIndices: Map<string, number>;
  /** M2: memberId → colormap name. Drives per-draw LUT texture binding. */
  colormapNameByMember: Map<string, string>;
}

/**
 * Canonical memberId for a (cold-state entry, channel) pair. Both the
 * orchestrator (when assembling render messages) and the worker (when
 * building the descriptor buffer) call this so entity indices agree by
 * construction.
 *
 * Mirrors the keying in `gpu.worker.ts`'s cold-state handler:
 *   - Single-channel field: `entry.imageId`
 *   - Multi-channel field:  `${entry.imageId}:ch${channel}`
 *   - well-as-proxy single: `entry.entityId` (since `imageId === ""`)
 *   - well-as-proxy multi:  `${entry.entityId}:ch${channel}`
 */
export function memberIdForColdEntry(
  entry: ColdStateActiveEntry,
  channel: number,
  multiChannel: boolean,
): string {
  const base = entry.mode === "well-as-proxy" ? entry.entityId : entry.imageId;
  return multiChannel ? `${base}:ch${channel}` : base;
}

/**
 * Canonical iteration that yields (memberId, entry, channel) tuples in
 * the order both worker and orchestrator visit. Walks
 * `cold.activeSet × cold.visibleChannels` (channel as the inner loop —
 * matches how poolGroups are built in the cold-state handler).
 */
export function* iterateColdMembers(
  cold: ColdStateMessage,
): Generator<{ entry: ColdStateActiveEntry; channel: number; memberId: string }> {
  const multiChannel = cold.visibleChannels.length > 1;
  for (const entry of cold.activeSet) {
    for (const channel of cold.visibleChannels) {
      yield {
        entry,
        channel,
        memberId: memberIdForColdEntry(entry, channel, multiChannel),
      };
    }
  }
}

/**
 * Compute the dense memberId → entityIndex map deterministically.
 * Used by the orchestrator to thread `entityIndex` into render-message
 * layers without round-tripping through the worker. Worker derives the
 * same indices when it builds the descriptor buffer.
 */
export function computeMemberIndexMap(
  cold: ColdStateMessage,
): Map<string, number> {
  const indexByMember = new Map<string, number>();
  let next = 0;
  for (const { memberId } of iterateColdMembers(cold)) {
    if (!indexByMember.has(memberId)) {
      indexByMember.set(memberId, next++);
    }
  }
  return indexByMember;
}

/**
 * Build a per-dataset entity descriptor buffer from cold state.
 *
 * The buffer covers every (entry, channel) combination from
 * `cold.activeSet × cold.visibleChannels` in canonical iteration order.
 * Proxy pool indices and colormap LUT indices are assigned dense from
 * the set of poolKeys / colormap names referenced by the active entries.
 */
export function buildDescriptorBuffer(
  device: GPUDevice,
  cold: ColdStateMessage,
  proxyDescriptorsByEntity: Map<string, EntityProxyDescriptor>,
  proxyPoolsByDataset: Map<string, Map<string, ProxyAtlasState>>,
  entityMetasByMember: Map<string, LodIndirectionMeta[]>,
): EntityDescriptorIndex {
  const indexByMember = new Map<string, number>();
  const proxyPoolIndexByKey = new Map<string, number>();
  const proxyPoolsByIndex: ProxyAtlasState[] = [];
  const colormapLutIndices = new Map<string, number>();
  const colormapNameByMember = new Map<string, string>();
  const dsPools = proxyPoolsByDataset.get(cold.datasetId) ?? null;

  // Pass 1: assign entity + pool + colormap indices in canonical order
  // (stable by construction — the orchestrator walks the same order).
  // Indices are recorded eagerly so the descriptor write below sees fully-
  // populated maps.
  const recordPool = (poolKey: string): void => {
    if (proxyPoolIndexByKey.has(poolKey)) return;
    const pool = dsPools?.get(poolKey);
    if (!pool) return;
    proxyPoolIndexByKey.set(poolKey, proxyPoolsByIndex.length);
    proxyPoolsByIndex.push(pool);
  };
  const recordColormap = (name: string): number => {
    let idx = colormapLutIndices.get(name);
    if (idx === undefined) {
      idx = colormapLutIndices.size;
      colormapLutIndices.set(name, idx);
    }
    return idx;
  };

  let nextEntityIndex = 0;
  for (const { entry, channel, memberId } of iterateColdMembers(cold)) {
    if (!indexByMember.has(memberId)) {
      indexByMember.set(memberId, nextEntityIndex++);
    }
    const ds = displayStateForChannel(entry, channel);
    colormapNameByMember.set(memberId, ds.colormapName);
    recordColormap(ds.colormapName);
    const desc = proxyDescriptorsByEntity.get(entry.entityId);
    if (desc?.fieldProxyHandle) recordPool(desc.fieldProxyHandle.poolKey);
    if (desc?.wellProxyHandle) recordPool(desc.wellProxyHandle.poolKey);
  }

  const entityCount = indexByMember.size;
  const bufferSize = Math.max(entityCount * DESCRIPTOR_ENTRY_SIZE, DESCRIPTOR_ENTRY_SIZE);
  const cpuBuffer = new ArrayBuffer(bufferSize);

  // Pass 2: serialize each entity once.
  const written = new Set<string>();
  for (const { entry, channel, memberId } of iterateColdMembers(cold)) {
    if (written.has(memberId)) continue;
    written.add(memberId);
    const eIdx = indexByMember.get(memberId)!;
    serializeEntityDescriptor(
      cpuBuffer,
      eIdx * DESCRIPTOR_ENTRY_SIZE,
      entry,
      entityMetasByMember.get(memberId) ?? [],
      displayStateForChannel(entry, channel),
      proxyDescriptorsByEntity,
      proxyPoolIndexByKey,
      proxyPoolsByIndex,
      colormapLutIndices,
    );
  }

  const buffer = device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, cpuBuffer);

  return {
    buffer,
    indexByMember,
    proxyPoolIndexByKey,
    proxyPoolsByIndex,
    entityCount,
    colormapLutIndices,
    colormapNameByMember,
  };
}

export function destroyDescriptorBuffer(idx: EntityDescriptorIndex): void {
  idx.buffer.destroy();
  idx.indexByMember.clear();
  idx.proxyPoolIndexByKey.clear();
  idx.proxyPoolsByIndex.length = 0;
  idx.colormapLutIndices.clear();
  idx.colormapNameByMember.clear();
}

/**
 * M2: per-channel display state lookup helper. Falls back to a
 * "no-op display" default if the channel slot is missing — this should
 * not happen in normal operation (the orchestrator populates every
 * `cold.visibleChannels` entry) but defensive defaults keep the
 * descriptor well-formed if a channel index drifts during transition.
 */
export function displayStateForChannel(
  entry: ColdStateActiveEntry,
  channel: number,
): {
  contrastMin: number;
  contrastMax: number;
  gamma: number;
  opacity: number;
  colormapName: string;
  channelMask: number;
} {
  const ds = entry.displayStateByChannel[channel];
  if (ds) return ds;
  return {
    contrastMin: 0,
    contrastMax: 65535,
    gamma: 1,
    opacity: 1,
    colormapName: "gray",
    channelMask: 0,
  };
}

/**
 * Serialize one EntityDescriptor into `target` at byte offset `offset`.
 * Exposed for tests so they can verify the byte layout without a GPU.
 *
 * M2: display state (`channelMask`, `contrastMin/Max`, `gamma`,
 * `opacity`, `colormapLutIndex`) is sourced from a per-channel
 * `displayState` lookup against `entry.displayStateByChannel`. The
 * orchestrator populates this from `selection.channelSettings` (the
 * same source the old per-frame layer params used).
 */
export function serializeEntityDescriptor(
  target: ArrayBuffer,
  offset: number,
  entry: ColdStateActiveEntry,
  lodMetas: LodIndirectionMeta[],
  displayState: ColdStateDisplayState,
  proxyDescriptorsByEntity: Map<string, EntityProxyDescriptor>,
  proxyPoolIndexByKey: Map<string, number>,
  proxyPoolsByIndex: ProxyAtlasState[],
  colormapLutIndices: Map<string, number>,
): void {
  const f32 = new Float32Array(target, offset, DESCRIPTOR_ENTRY_SIZE / 4);
  const u32 = new Uint32Array(target, offset, DESCRIPTOR_ENTRY_SIZE / 4);

  if (entry.modelMatrix.length === 16) f32.set(entry.modelMatrix, 0);
  if (entry.invModelMatrix.length === 16) f32.set(entry.invModelMatrix, 16);

  // Resolve proxy handles to (poolIndex, slotIndex, dims). Sentinels for
  // any missing handle.
  const desc = proxyDescriptorsByEntity.get(entry.entityId);
  let fieldPoolIdx = DESCRIPTOR_SENTINEL_INDEX;
  let fieldSlotIdx = DESCRIPTOR_SENTINEL_INDEX;
  let fieldDims: [number, number, number] = [1, 1, 1];
  let wellPoolIdx = DESCRIPTOR_SENTINEL_INDEX;
  let wellSlotIdx = DESCRIPTOR_SENTINEL_INDEX;
  let wellDims: [number, number, number] = [1, 1, 1];
  if (desc?.fieldProxyHandle) {
    const p = proxyPoolIndexByKey.get(desc.fieldProxyHandle.poolKey);
    if (p !== undefined) {
      fieldPoolIdx = p;
      fieldSlotIdx = desc.fieldProxyHandle.slotIndex >>> 0;
      fieldDims = proxyPoolsByIndex[p].slotDims;
    }
  }
  if (desc?.wellProxyHandle) {
    const p = proxyPoolIndexByKey.get(desc.wellProxyHandle.poolKey);
    if (p !== undefined) {
      wellPoolIdx = p;
      wellSlotIdx = desc.wellProxyHandle.slotIndex >>> 0;
      wellDims = proxyPoolsByIndex[p].slotDims;
    }
  }

  const lutIdx = colormapLutIndices.get(displayState.colormapName) ?? 0;

  u32[32] = displayState.channelMask >>> 0; // 128 channelMask
  u32[33] = fieldPoolIdx;            // 132
  u32[34] = fieldSlotIdx;            // 136
  u32[35] = wellPoolIdx;             // 140
  u32[36] = wellSlotIdx;             // 144
  u32[37] = 0; u32[38] = 0; u32[39] = 0; // 148/152/156 _pad_proxy0..2
  u32[40] = fieldDims[0]; u32[41] = fieldDims[1]; u32[42] = fieldDims[2]; u32[43] = 0; // 160 fieldProxyDims
  u32[44] = wellDims[0];  u32[45] = wellDims[1];  u32[46] = wellDims[2];  u32[47] = 0; // 176 wellProxyDims

  f32[48] = displayState.contrastMin; // 192 contrastMin
  f32[49] = displayState.contrastMax; // 196 contrastMax
  f32[50] = displayState.gamma;       // 200 gamma
  f32[51] = displayState.opacity;     // 204 opacity
  u32[52] = lutIdx >>> 0;             // 208 colormapLutIndex

  // LODs and indirectionOffsets come from worker-built entityMetas — same
  // source the pool's shared indirection buffer was sized from. Computing
  // a per-entity local offset here would point every entity at entity 0's
  // range in the shared buffer, so all fields would render the same data.
  const lodCount = Math.min(lodMetas.length, DESCRIPTOR_MAX_LODS);
  u32[53] = lodCount;                // 212 lodCount
  u32[54] = 0;                       // 216 _pad_tail0
  u32[55] = 0;                       // 220 _pad_tail1

  const lodsBaseU32 = DESCRIPTOR_LODS_OFFSET / 4; // 56
  for (let i = 0; i < DESCRIPTOR_MAX_LODS; i++) {
    const slotBase = lodsBaseU32 + i * (DESCRIPTOR_LOD_INFO_SIZE / 4);
    if (i < lodCount) {
      const m = lodMetas[i];
      const [gZ, gY, gX] = m.gridDims;
      const [cZ, cY, cX] = m.chunkDims;
      const [lZ, lY, lX] = m.levelDims;
      u32[slotBase + 0]  = m.level;
      u32[slotBase + 1]  = m.offset;
      u32[slotBase + 2]  = 0;
      u32[slotBase + 3]  = 0;
      u32[slotBase + 4]  = gX; u32[slotBase + 5]  = gY; u32[slotBase + 6]  = gZ; u32[slotBase + 7]  = 0;
      u32[slotBase + 8]  = cX; u32[slotBase + 9]  = cY; u32[slotBase + 10] = cZ; u32[slotBase + 11] = 0;
      u32[slotBase + 12] = lX; u32[slotBase + 13] = lY; u32[slotBase + 14] = lZ; u32[slotBase + 15] = 0;
    } else {
      for (let s = 0; s < DESCRIPTOR_LOD_INFO_SIZE / 4; s++) {
        u32[slotBase + s] = 0;
      }
    }
  }
}
