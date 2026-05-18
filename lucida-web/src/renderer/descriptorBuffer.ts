/**
 * Per-dataset entity descriptor buffer.
 *
 * Holds the geometric/LOD/proxy/display fields the shader reads per
 * sample: model matrix + inverse, per-LOD chunk/grid/level dims with
 * indirection offsets, proxy handles (pool index + slot index), proxy
 * slot dims, and per-channel display state (contrast/gamma/opacity/
 * colormapLutIndex/channelMask).
 *
 * The descriptor lives entirely in worker-side state. TickCoordinator and
 * worker converge on entity indices by construction — both walk
 * `cold.activeSet × cold.visibleChannels` in the same canonical order
 * (see {@link iterateColdMembers}), so no readback is needed.
 *
 * Display-state changes (contrast slider, colormap dropdown, etc.)
 * bump `epochs.selection`. The orchestrator's epoch-cache check re-runs
 * `plan()`, re-emits cold state, and the worker rebuilds the descriptor
 * buffer — display-state changes flow through the cold-state seam
 * rather than a dedicated patch message.
 */

import type {
  ColdStateMessage,
  ColdStateActiveEntry,
  ColdStateDisplayState,
} from "./workerProtocol.ts";
import {
  proxyDescriptorKey,
  type EntityProxyDescriptor,
} from "./workerContext.ts";
import type { ProxyAtlasState } from "./proxyAtlas.ts";
import type { LodIndirectionMeta } from "./volume/atlas.ts";
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
  LOD_OFFSET_PAD0,
  LOD_OFFSET_PAD1,
  OFFSET_CHANNEL_MASK,
  OFFSET_COLORMAP_LUT_INDEX,
  OFFSET_CONTRAST_MAX,
  OFFSET_CONTRAST_MIN,
  OFFSET_FIELD_PROXY_DIMS,
  OFFSET_FIELD_PROXY_POOL_INDEX,
  OFFSET_FIELD_PROXY_SLOT_INDEX,
  OFFSET_GAMMA,
  OFFSET_INV_MODEL_MATRIX,
  OFFSET_LOD_COUNT,
  OFFSET_MODEL_MATRIX,
  OFFSET_OPACITY,
  OFFSET_PAD_PROXY0,
  OFFSET_PAD_PROXY1,
  OFFSET_PAD_PROXY2,
  OFFSET_PAD_TAIL0,
  OFFSET_PAD_TAIL1,
  OFFSET_WELL_PROXY_DIMS,
  OFFSET_WELL_PROXY_POOL_INDEX,
  OFFSET_WELL_PROXY_SLOT_INDEX,
} from "./descriptor/layout.ts";

// Re-export size/sentinel constants so existing consumers don't break.
// New code should import these from `./descriptor/layout.ts` directly.
export {
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_LOD_INFO_SIZE,
  DESCRIPTOR_LODS_OFFSET,
  DESCRIPTOR_MAX_LODS,
  DESCRIPTOR_SENTINEL_INDEX,
} from "./descriptor/layout.ts";

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
   * Colormap name → dense LUT index (matches GPU descriptor's
   * `colormapLutIndex` field). Stable across rebuilds in the
   * insertion-order they were first seen for this dataset; the GPU
   * descriptor's index is informational, with the CPU resolving
   * `colormapNameByMember` per draw to bind the right LUT texture.
   */
  colormapLutIndices: Map<string, number>;
  /** memberId → colormap name. Drives per-draw LUT texture binding. */
  colormapNameByMember: Map<string, string>;
  /** memberId → proxy descriptor for the cold state's current `(t,c)`. */
  proxyDescriptorByMember: Map<string, EntityProxyDescriptor>;
}

/**
 * Canonical memberId for a (cold-state entry, channel) pair. Both the
 * orchestrator (when assembling render messages) and the worker (when
 * building the descriptor buffer) call this so entity indices agree by
 * construction.
 *
 * Mirrors the keying in `gpu.worker.ts`'s cold-state handler:
 *   - Single-channel field:           `entry.imageId`
 *   - Multi-channel field:            `${entry.imageId}:ch${channel}`
 *   - Single-channel well-as-proxy:   `entry.entityId`
 *   - Multi-channel well-as-proxy:    `${entry.entityId}:ch${channel}`
 *
 * `ColdStateActiveEntry` is a discriminated union on `kind`; narrowing
 * through `entry.kind` makes the well-as-proxy variant TS-visible (it
 * has no `imageId`).
 */
export function memberIdForColdEntry(
  entry: ColdStateActiveEntry,
  channel: number,
  multiChannel: boolean,
): string {
  const base = entry.kind === "well-as-proxy" ? entry.entityId : entry.imageId;
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
  for (const entry of cold.activeSet) {
    for (const channel of cold.visibleChannels) {
      yield {
        entry,
        channel,
        memberId: memberIdForColdEntry(entry, channel, cold.multiChannel),
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
  const proxyDescriptorByMember = new Map<string, EntityProxyDescriptor>();
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
    const desc = proxyDescriptorsByEntity.get(
      proxyDescriptorKey(entry.entityId, cold.currentT, channel),
    );
    if (desc) proxyDescriptorByMember.set(memberId, desc);
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
      proxyDescriptorKey(entry.entityId, cold.currentT, channel),
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
    proxyDescriptorByMember,
  };
}

export function destroyDescriptorBuffer(idx: EntityDescriptorIndex): void {
  idx.buffer.destroy();
  idx.indexByMember.clear();
  idx.proxyPoolIndexByKey.clear();
  idx.proxyPoolsByIndex.length = 0;
  idx.colormapLutIndices.clear();
  idx.colormapNameByMember.clear();
  idx.proxyDescriptorByMember.clear();
}

/**
 * Per-channel display state lookup helper. Falls back to a "no-op
 * display" default if the channel slot is missing — this should not
 * happen in normal operation (the orchestrator populates every
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
 * Display state (`channelMask`, `contrastMin/Max`, `gamma`, `opacity`,
 * `colormapLutIndex`) is sourced from a per-channel `displayState`
 * lookup against `entry.displayStateByChannel`. The orchestrator
 * populates this from `selection.channelSettings`.
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
  proxyKey: string | null = null,
): void {
  const f32 = new Float32Array(target, offset, DESCRIPTOR_ENTRY_SIZE / 4);
  const u32 = new Uint32Array(target, offset, DESCRIPTOR_ENTRY_SIZE / 4);

  if (entry.modelMatrix.length === 16) f32.set(entry.modelMatrix, OFFSET_MODEL_MATRIX / 4);
  if (entry.invModelMatrix.length === 16) f32.set(entry.invModelMatrix, OFFSET_INV_MODEL_MATRIX / 4);

  // Resolve proxy handles to (poolIndex, slotIndex, dims). Sentinels for
  // any missing handle.
  const desc = proxyDescriptorsByEntity.get(proxyKey ?? entry.entityId);
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

  u32[OFFSET_CHANNEL_MASK / 4]          = displayState.channelMask >>> 0;
  u32[OFFSET_FIELD_PROXY_POOL_INDEX / 4] = fieldPoolIdx;
  u32[OFFSET_FIELD_PROXY_SLOT_INDEX / 4] = fieldSlotIdx;
  u32[OFFSET_WELL_PROXY_POOL_INDEX / 4]  = wellPoolIdx;
  u32[OFFSET_WELL_PROXY_SLOT_INDEX / 4]  = wellSlotIdx;
  u32[OFFSET_PAD_PROXY0 / 4] = 0;
  u32[OFFSET_PAD_PROXY1 / 4] = 0;
  u32[OFFSET_PAD_PROXY2 / 4] = 0;
  const fieldDimsBase = OFFSET_FIELD_PROXY_DIMS / 4;
  u32[fieldDimsBase + 0] = fieldDims[0];
  u32[fieldDimsBase + 1] = fieldDims[1];
  u32[fieldDimsBase + 2] = fieldDims[2];
  u32[fieldDimsBase + 3] = 0;
  const wellDimsBase = OFFSET_WELL_PROXY_DIMS / 4;
  u32[wellDimsBase + 0] = wellDims[0];
  u32[wellDimsBase + 1] = wellDims[1];
  u32[wellDimsBase + 2] = wellDims[2];
  u32[wellDimsBase + 3] = 0;

  f32[OFFSET_CONTRAST_MIN / 4] = displayState.contrastMin;
  f32[OFFSET_CONTRAST_MAX / 4] = displayState.contrastMax;
  f32[OFFSET_GAMMA / 4]        = displayState.gamma;
  f32[OFFSET_OPACITY / 4]      = displayState.opacity;
  u32[OFFSET_COLORMAP_LUT_INDEX / 4] = lutIdx >>> 0;

  // LODs and indirectionOffsets come from worker-built entityMetas — same
  // source the pool's shared indirection buffer was sized from. Computing
  // a per-entity local offset here would point every entity at entity 0's
  // range in the shared buffer, so all fields would render the same data.
  const lodCount = Math.min(lodMetas.length, DESCRIPTOR_MAX_LODS);
  u32[OFFSET_LOD_COUNT / 4] = lodCount;
  u32[OFFSET_PAD_TAIL0 / 4] = 0;
  u32[OFFSET_PAD_TAIL1 / 4] = 0;

  const lodsBaseU32 = DESCRIPTOR_LODS_OFFSET / 4;
  const lodStrideU32 = DESCRIPTOR_LOD_INFO_SIZE / 4;
  for (let i = 0; i < DESCRIPTOR_MAX_LODS; i++) {
    const slotBase = lodsBaseU32 + i * lodStrideU32;
    if (i < lodCount) {
      const m = lodMetas[i];
      const [gZ, gY, gX] = m.gridDims;
      const [cZ, cY, cX] = m.chunkDims;
      const [lZ, lY, lX] = m.levelDims;
      u32[slotBase + LOD_OFFSET_LEVEL / 4]              = m.level;
      u32[slotBase + LOD_OFFSET_INDIRECTION_OFFSET / 4] = m.offset;
      u32[slotBase + LOD_OFFSET_PAD0 / 4]               = 0;
      u32[slotBase + LOD_OFFSET_PAD1 / 4]               = 0;
      const gridBase = slotBase + LOD_OFFSET_GRID_DIMS / 4;
      u32[gridBase + 0] = gX;
      u32[gridBase + 1] = gY;
      u32[gridBase + 2] = gZ;
      u32[gridBase + 3] = 0;
      const chunkBase = slotBase + LOD_OFFSET_CHUNK_DIMS / 4;
      u32[chunkBase + 0] = cX;
      u32[chunkBase + 1] = cY;
      u32[chunkBase + 2] = cZ;
      u32[chunkBase + 3] = 0;
      const levelBase = slotBase + LOD_OFFSET_LEVEL_DIMS / 4;
      u32[levelBase + 0] = lX;
      u32[levelBase + 1] = lY;
      u32[levelBase + 2] = lZ;
      u32[levelBase + 3] = 0;
    } else {
      for (let s = 0; s < lodStrideU32; s++) {
        u32[slotBase + s] = 0;
      }
    }
  }
}
