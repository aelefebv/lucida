/**
 * Per-dataset entity descriptor buffer.
 *
 * Holds the geometric/level/proxy/display fields the shader reads per
 * sample: model matrix + inverse, up to four level sources (chunk/grid/
 * level dims, indirection offset, and the level pool binding each reads)
 * plus the coarse source, proxy handles (pool index + slot index), proxy
 * slot dims, and per-channel display state (contrast/gamma/opacity/
 * colormapLutIndex/channelMask).
 *
 * The descriptor lives entirely in worker-side state. TickCoordinator and
 * worker converge on entity indices by construction — both walk
 * `cold.activeSet × cold.visibleChannels` in the same canonical order
 * (see {@link iterateColdMembers}), so no readback is needed.
 *
 * Display-state changes (contrast slider, colormap dropdown, etc.) bump
 * `epochs.selection`. When only the per-channel intensity display changed,
 * the orchestrator sends a dedicated {@link ColdStateDisplayMessage}: the
 * worker rebuilds just this descriptor buffer from the dataset's most
 * recent cold state with the new display values swapped in, skipping the
 * pool/atlas/active-set work. Any other change (geometry, active set, label
 * overlays, z-range, …) re-runs `plan()` and re-emits full cold state,
 * which rebuilds the descriptor the same way.
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
  selectEntitySources,
  type EntitySource,
  type EntitySourceSelection,
} from "./entitySources.ts";
import {
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_MAX_LEVEL_SOURCES,
  DESCRIPTOR_SENTINEL_INDEX,
  DESCRIPTOR_TIER_SOURCE_SIZE,
  OFFSET_CHANNEL_MASK,
  OFFSET_COLORMAP_LUT_INDEX,
  OFFSET_CONTRAST_MAX,
  OFFSET_CONTRAST_MIN,
  OFFSET_TILE_PROXY_DIMS,
  OFFSET_TILE_PROXY_POOL_INDEX,
  OFFSET_TILE_PROXY_SLOT_INDEX,
  OFFSET_GAMMA,
  OFFSET_INV_MODEL_MATRIX,
  OFFSET_LABEL_OPACITY,
  OFFSET_LEVEL_SOURCE_COUNT,
  OFFSET_COARSE_SOURCE,
  OFFSET_COLORMAP_MODE,
  OFFSET_MODEL_MATRIX,
  OFFSET_OPACITY,
  OFFSET_PAD_PROXY0,
  OFFSET_PAD_PROXY1,
  OFFSET_PAD_PROXY2,
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
} from "./descriptor/layout.ts";

/**
 * The pools a draw for one member binds: one level pool per binding slot
 * (index = the `poolIndex` its level sources carry) and the coarse pool.
 * The CPU mirror of what the member's descriptor entry names.
 */
export interface MemberSourceBinding {
  levelPoolKeys: string[];
  coarsePoolKey: string | null;
}

export interface EntityDescriptorIndex {
  buffer: GPUBuffer;
  /** memberId → entity index in {@link buffer}. */
  indexByMember: Map<string, number>;
  /**
   * Inverse of {@link indexByMember}: entity index → memberId. The
   * aggregate render path uses it to resolve each quad's member (pool
   * lookup, residency check, camera-UV recency) from the entity index
   * the quad record carries. 1:1 with `indexByMember` by construction.
   */
  memberByIndex: string[];
  /** memberId → the level and coarse pools its descriptor entry samples. */
  sourceBindingByMember: Map<string, MemberSourceBinding>;
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
 *   - Single-channel group-as-proxy:   `entry.entityId`
 *   - Multi-channel group-as-proxy:    `${entry.entityId}:ch${channel}`
 *
 * `ColdStateActiveEntry` is a discriminated union on `kind`; narrowing
 * through `entry.kind` makes the group-as-proxy variant TS-visible (it
 * has no `imageId`).
 */
export function memberIdForColdEntry(
  entry: ColdStateActiveEntry,
  channel: number,
  multiChannel: boolean,
): string {
  const base = entry.kind === "group-as-proxy" ? entry.entityId : entry.imageId;
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
 * `sourcesByMember` holds the indirection sections the worker allocated
 * for each member in this cold state; {@link selectEntitySources} picks
 * the level sources and the coarse source from them.
 */
export function buildDescriptorBuffer(
  device: GPUDevice,
  cold: ColdStateMessage,
  proxyDescriptorsByEntity: Map<string, EntityProxyDescriptor>,
  proxyPoolsByDataset: Map<string, Map<string, ProxyAtlasState>>,
  sourcesByMember: Map<string, EntitySource[]>,
): EntityDescriptorIndex {
  const indexByMember = new Map<string, number>();
  const sourceBindingByMember = new Map<string, MemberSourceBinding>();
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

  const memberByIndex: string[] = [];
  let nextEntityIndex = 0;
  for (const { entry, channel, memberId } of iterateColdMembers(cold)) {
    if (!indexByMember.has(memberId)) {
      indexByMember.set(memberId, nextEntityIndex++);
      memberByIndex.push(memberId);
    }
    const ds = displayStateForChannel(entry, channel);
    colormapNameByMember.set(memberId, ds.colormapName);
    recordColormap(ds.colormapName);
    const desc = proxyDescriptorsByEntity.get(
      proxyDescriptorKey(entry.entityId, cold.currentT, channel),
    );
    if (desc) proxyDescriptorByMember.set(memberId, desc);
    if (desc?.tileProxyHandle) recordPool(desc.tileProxyHandle.poolKey);
    if (desc?.groupProxyHandle) recordPool(desc.groupProxyHandle.poolKey);
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
    const selection = selectEntitySources(entry, sourcesByMember.get(memberId) ?? []);
    sourceBindingByMember.set(memberId, {
      levelPoolKeys: selection.levelPoolKeys,
      coarsePoolKey: selection.coarse?.poolKey ?? null,
    });
    serializeEntityDescriptor(
      cpuBuffer,
      eIdx * DESCRIPTOR_ENTRY_SIZE,
      entry,
      selection,
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
    memberByIndex,
    sourceBindingByMember,
    proxyPoolIndexByKey,
    proxyPoolsByIndex,
    entityCount,
    colormapLutIndices,
    colormapNameByMember,
    proxyDescriptorByMember,
  };
}

/** A member's pools resolved against current residency, ready to bind. */
export interface ResolvedMemberPools<A> {
  /** Level pools in binding-slot order; a slot is `null` when its pool holds no section for the member. */
  levels: Array<A | null>;
  /** The pool key behind each slot of {@link levels}. */
  levelPoolKeys: string[];
  coarse: A | null;
  coarsePoolKey: string | null;
}

/**
 * Resolve the pools a member's descriptor entry samples against the
 * atlases the worker holds right now. A pool that exists but holds no
 * section for the member resolves to `null`, so the draw binds a dummy
 * there and the shader reads a miss.
 */
export function resolveMemberPools<A extends { entityMetas: Map<string, unknown[]> }>(
  atlasMap: Map<string, A>,
  descIndex: EntityDescriptorIndex,
  memberId: string,
): ResolvedMemberPools<A> {
  const binding = descIndex.sourceBindingByMember.get(memberId);
  const resident = (key: string | null): A | null => {
    const atlas = key ? atlasMap.get(key) ?? null : null;
    return atlas && (atlas.entityMetas.get(memberId)?.length ?? 0) > 0 ? atlas : null;
  };
  const levelPoolKeys = binding?.levelPoolKeys ?? [];
  const coarsePoolKey = binding?.coarsePoolKey ?? null;
  return {
    levels: levelPoolKeys.map(resident),
    levelPoolKeys,
    coarse: resident(coarsePoolKey),
    coarsePoolKey,
  };
}

export function destroyDescriptorBuffer(idx: EntityDescriptorIndex): void {
  idx.buffer.destroy();
  idx.indexByMember.clear();
  idx.memberByIndex.length = 0;
  idx.sourceBindingByMember.clear();
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
): ColdStateDisplayState {
  const ds = entry.displayStateByChannel[channel];
  if (ds) return ds;
  return {
    contrastMin: 0,
    contrastMax: 65535,
    gamma: 1,
    opacity: 1,
    colormapName: "gray",
    channelMask: 0,
    colormapMode: 0,
    labelOpacity: 1,
  };
}

/**
 * Serialize one EntityDescriptor into `target` at byte offset `offset`.
 * Exposed for tests so they can verify the byte layout without a GPU.
 *
 * `selection` is what {@link selectEntitySources} chose for the entry:
 * the level sources are written finest first into `levelSources[0..n)`
 * with their pool binding slots, the remaining slots are zeroed, and the
 * coarse section lands in `coarseSource`.
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
  selection: EntitySourceSelection,
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
  let tilePoolIdx = DESCRIPTOR_SENTINEL_INDEX;
  let tileSlotIdx = DESCRIPTOR_SENTINEL_INDEX;
  let tileDims: [number, number, number] = [1, 1, 1];
  let groupPoolIdx = DESCRIPTOR_SENTINEL_INDEX;
  let groupSlotIdx = DESCRIPTOR_SENTINEL_INDEX;
  let groupDims: [number, number, number] = [1, 1, 1];
  if (desc?.tileProxyHandle) {
    const p = proxyPoolIndexByKey.get(desc.tileProxyHandle.poolKey);
    if (p !== undefined) {
      tilePoolIdx = p;
      tileSlotIdx = desc.tileProxyHandle.slotIndex >>> 0;
      tileDims = proxyPoolsByIndex[p].slotDims;
    }
  }
  if (desc?.groupProxyHandle) {
    const p = proxyPoolIndexByKey.get(desc.groupProxyHandle.poolKey);
    if (p !== undefined) {
      groupPoolIdx = p;
      groupSlotIdx = desc.groupProxyHandle.slotIndex >>> 0;
      groupDims = proxyPoolsByIndex[p].slotDims;
    }
  }

  const lutIdx = colormapLutIndices.get(displayState.colormapName) ?? 0;

  u32[OFFSET_CHANNEL_MASK / 4]          = displayState.channelMask >>> 0;
  u32[OFFSET_TILE_PROXY_POOL_INDEX / 4] = tilePoolIdx;
  u32[OFFSET_TILE_PROXY_SLOT_INDEX / 4] = tileSlotIdx;
  u32[OFFSET_GROUP_PROXY_POOL_INDEX / 4]  = groupPoolIdx;
  u32[OFFSET_GROUP_PROXY_SLOT_INDEX / 4]  = groupSlotIdx;
  u32[OFFSET_PAD_PROXY0 / 4] = 0;
  u32[OFFSET_PAD_PROXY1 / 4] = 0;
  u32[OFFSET_PAD_PROXY2 / 4] = 0;
  const tileDimsBase = OFFSET_TILE_PROXY_DIMS / 4;
  u32[tileDimsBase + 0] = tileDims[0];
  u32[tileDimsBase + 1] = tileDims[1];
  u32[tileDimsBase + 2] = tileDims[2];
  u32[tileDimsBase + 3] = 0;
  const groupDimsBase = OFFSET_GROUP_PROXY_DIMS / 4;
  u32[groupDimsBase + 0] = groupDims[0];
  u32[groupDimsBase + 1] = groupDims[1];
  u32[groupDimsBase + 2] = groupDims[2];
  u32[groupDimsBase + 3] = 0;

  f32[OFFSET_CONTRAST_MIN / 4] = displayState.contrastMin;
  f32[OFFSET_CONTRAST_MAX / 4] = displayState.contrastMax;
  f32[OFFSET_GAMMA / 4]        = displayState.gamma;
  f32[OFFSET_OPACITY / 4]      = displayState.opacity;
  u32[OFFSET_COLORMAP_LUT_INDEX / 4] = lutIdx >>> 0;

  // Categorical label overlays repurpose these two tail slots: a mode flag
  // and the overlay opacity. Intensity images leave them at 0 / 1.
  u32[OFFSET_COLORMAP_MODE / 4] = (displayState.colormapMode ?? 0) >>> 0;
  f32[OFFSET_LABEL_OPACITY / 4] = displayState.labelOpacity ?? 1;

  // Offsets come from the worker-built sections, the same source the
  // pool's shared indirection buffer was sized from. A per-entity local
  // offset computed here would point every entity at entity 0's range in
  // the shared buffer, so all members would render the same data.
  const levelCount = Math.min(selection.levels.length, DESCRIPTOR_MAX_LEVEL_SOURCES);
  u32[OFFSET_LEVEL_SOURCE_COUNT / 4] = levelCount;
  for (let i = 0; i < DESCRIPTOR_MAX_LEVEL_SOURCES; i++) {
    const levelSource = i < levelCount ? selection.levels[i] : undefined;
    writeChunkTierSource(
      u32,
      levelSourceOffset(i),
      levelSource?.source.meta,
      levelSource?.poolIndex ?? 0,
    );
  }
  writeChunkTierSource(u32, OFFSET_COARSE_SOURCE, selection.coarse?.meta, 0);
}

function writeChunkTierSource(
  u32: Uint32Array,
  offsetBytes: number,
  meta: LodIndirectionMeta | undefined,
  poolIndex: number,
): void {
  const base = offsetBytes / 4;
  if (!meta) {
    for (let i = 0; i < DESCRIPTOR_TIER_SOURCE_SIZE / 4; i++) u32[base + i] = 0;
    return;
  }

  const [gZ, gY, gX] = meta.gridDims;
  const [cZ, cY, cX] = meta.chunkDims;
  const [lZ, lY, lX] = meta.levelDims;

  u32[base + SOURCE_OFFSET_VALID / 4] = 1;
  u32[base + SOURCE_OFFSET_LEVEL / 4] = meta.level;
  u32[base + SOURCE_OFFSET_INDIRECTION_OFFSET / 4] = meta.offset;
  u32[base + SOURCE_OFFSET_POOL_INDEX / 4] = poolIndex >>> 0;

  const gridBase = base + SOURCE_OFFSET_GRID_DIMS / 4;
  u32[gridBase + 0] = gX;
  u32[gridBase + 1] = gY;
  u32[gridBase + 2] = gZ;
  u32[gridBase + 3] = 0;

  const chunkBase = base + SOURCE_OFFSET_CHUNK_DIMS / 4;
  u32[chunkBase + 0] = cX;
  u32[chunkBase + 1] = cY;
  u32[chunkBase + 2] = cZ;
  u32[chunkBase + 3] = 0;

  const levelBase = base + SOURCE_OFFSET_LEVEL_DIMS / 4;
  u32[levelBase + 0] = lX;
  u32[levelBase + 1] = lY;
  u32[levelBase + 2] = lZ;
  u32[levelBase + 3] = 0;
}
