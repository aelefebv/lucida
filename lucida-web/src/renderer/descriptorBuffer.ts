/**
 * Per-dataset entity descriptor buffer.
 *
 * Holds the geometric/LOD/display fields the shader reads per
 * sample: model matrix + inverse, per-LOD chunk/grid/level dims with
 * indirection offsets and per-channel display state (contrast/gamma/opacity/
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
import type { LodIndirectionMeta } from "./volume/atlas.ts";
import type {
  GpuResourceBudget,
  TrackedGpuResource,
} from "./gpuResourceBudget.ts";
import {
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_LOD_INFO_SIZE,
  DESCRIPTOR_LODS_OFFSET,
  DESCRIPTOR_MAX_LODS,
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
  OFFSET_GAMMA,
  OFFSET_INV_MODEL_MATRIX,
  OFFSET_LABEL_OPACITY,
  OFFSET_LOD_COUNT,
  OFFSET_COARSE_SOURCE,
  OFFSET_COLORMAP_MODE,
  OFFSET_DETAIL_SOURCE,
  OFFSET_MODEL_MATRIX,
  OFFSET_OPACITY,
  SOURCE_OFFSET_CHUNK_DIMS,
  SOURCE_OFFSET_GRID_DIMS,
  SOURCE_OFFSET_INDIRECTION_OFFSET,
  SOURCE_OFFSET_LEVEL,
  SOURCE_OFFSET_LEVEL_DIMS,
  SOURCE_OFFSET_PAD0,
  SOURCE_OFFSET_VALID,
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
  bufferAllocation?: TrackedGpuResource<GPUBuffer>;
  /** memberId → entity index in {@link buffer}. */
  indexByMember: Map<string, number>;
  /**
   * Inverse of {@link indexByMember}: entity index → memberId. The
   * aggregate render path uses it to resolve each quad's member (pool
   * lookup, residency check, camera-UV recency) from the entity index
   * the quad record carries. 1:1 with `indexByMember` by construction.
   */
  memberByIndex: string[];
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
}

// Worker-local serialization scratch. `GPUQueue.writeBuffer` copies the bytes
// before returning, so one grow-only buffer is safe across sequential dataset
// rebuilds and avoids a fresh multi-megabyte ArrayBuffer on every cold state.
let descriptorScratch = new ArrayBuffer(0);

function acquireDescriptorScratch(byteLength: number): ArrayBuffer {
  if (descriptorScratch.byteLength < byteLength) {
    descriptorScratch = new ArrayBuffer(byteLength);
  }
  // A fresh ArrayBuffer was implicitly zeroed. Reuse must preserve that same
  // contract because malformed/short matrices deliberately leave fields at 0.
  new Uint8Array(descriptorScratch, 0, byteLength).fill(0);
  return descriptorScratch;
}

/** Test-only reset/inspection for the allocation-reuse contract. */
export function __resetDescriptorScratchForTest(): void {
  descriptorScratch = new ArrayBuffer(0);
}

export function __descriptorScratchCapacityForTest(): number {
  return descriptorScratch.byteLength;
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
 */
export function memberIdForColdEntry(
  entry: ColdStateActiveEntry,
  channel: number,
  multiChannel: boolean,
): string {
  const base = entry.imageId;
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
 * Colormap LUT indices are assigned densely from the active entries.
 */
export function buildDescriptorBuffer(
  device: GPUDevice,
  cold: ColdStateMessage,
  entityMetasByMember: Map<string, LodIndirectionMeta[]>,
  resources: GpuResourceBudget,
): EntityDescriptorIndex {
  const indexByMember = new Map<string, number>();
  const colormapLutIndices = new Map<string, number>();
  const colormapNameByMember = new Map<string, string>();

  // Pass 1: assign entity + pool + colormap indices in canonical order
  // (stable by construction — the orchestrator walks the same order).
  // Indices are recorded eagerly so the descriptor write below sees fully-
  // populated maps.
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
  }

  const entityCount = indexByMember.size;
  const bufferSize = Math.max(entityCount * DESCRIPTOR_ENTRY_SIZE, DESCRIPTOR_ENTRY_SIZE);
  const cpuBuffer = acquireDescriptorScratch(bufferSize);

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
      colormapLutIndices,
    );
  }

  const bufferAllocation = resources.createBuffer(
    device,
    {
      key: `descriptor:${cold.datasetId}`,
      kind: "descriptor",
      datasetId: cold.datasetId,
    },
    {
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    },
  );
  const buffer = bufferAllocation.resource;
  // Upload exactly the populated prefix. The scratch may be larger after a
  // previous wide collection; stale tail bytes must never reach this buffer.
  device.queue.writeBuffer(buffer, 0, cpuBuffer, 0, bufferSize);

  return {
    buffer,
    bufferAllocation,
    indexByMember,
    memberByIndex,
    entityCount,
    colormapLutIndices,
    colormapNameByMember,
  };
}

export function destroyDescriptorBuffer(idx: EntityDescriptorIndex): void {
  idx.bufferAllocation?.destroy();
  if (!idx.bufferAllocation) idx.buffer.destroy();
  idx.indexByMember.clear();
  idx.memberByIndex.length = 0;
  idx.colormapLutIndices.clear();
  idx.colormapNameByMember.clear();
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
  colormapLutIndices: Map<string, number>,
): void {
  const f32 = new Float32Array(target, offset, DESCRIPTOR_ENTRY_SIZE / 4);
  const u32 = new Uint32Array(target, offset, DESCRIPTOR_ENTRY_SIZE / 4);

  if (entry.modelMatrix.length === 16) f32.set(entry.modelMatrix, OFFSET_MODEL_MATRIX / 4);
  if (entry.invModelMatrix.length === 16) f32.set(entry.invModelMatrix, OFFSET_INV_MODEL_MATRIX / 4);

  const lutIdx = colormapLutIndices.get(displayState.colormapName) ?? 0;

  u32[OFFSET_CHANNEL_MASK / 4]          = displayState.channelMask >>> 0;
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
  // Categorical label overlays repurpose these two tail slots: a mode flag
  // and the overlay opacity. Intensity images leave them at 0 / 1.
  u32[OFFSET_COLORMAP_MODE / 4] = (displayState.colormapMode ?? 0) >>> 0;
  f32[OFFSET_LABEL_OPACITY / 4] = displayState.labelOpacity ?? 1;

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

  const detailLevel = entry.detailLevel;
  const coarseLevel = entry.coarseLevel;
  const hasTierSources = detailLevel !== undefined;
  const detailMeta = hasTierSources
    ? findLodMeta(lodMetas, detailLevel)
    : undefined;
  const coarseMeta = hasTierSources && coarseLevel !== undefined && coarseLevel !== null
    ? findLodMeta(lodMetas, coarseLevel, "last")
    : undefined;
  writeChunkTierSource(u32, OFFSET_DETAIL_SOURCE, detailMeta);
  writeChunkTierSource(u32, OFFSET_COARSE_SOURCE, coarseMeta);
}

function findLodMeta(
  lodMetas: LodIndirectionMeta[],
  level: number,
  preference: "first" | "last" = "first",
): LodIndirectionMeta | undefined {
  if (preference === "first") {
    return lodMetas.find((m) => m.level === level);
  }
  for (let i = lodMetas.length - 1; i >= 0; i--) {
    if (lodMetas[i].level === level) return lodMetas[i];
  }
  return undefined;
}

function writeChunkTierSource(
  u32: Uint32Array,
  offsetBytes: number,
  meta: LodIndirectionMeta | undefined,
): void {
  const base = offsetBytes / 4;
  if (!meta) {
    for (let i = 0; i < 16; i++) u32[base + i] = 0;
    return;
  }

  const [gZ, gY, gX] = meta.gridDims;
  const [cZ, cY, cX] = meta.chunkDims;
  const [lZ, lY, lX] = meta.levelDims;

  u32[base + SOURCE_OFFSET_VALID / 4] = 1;
  u32[base + SOURCE_OFFSET_LEVEL / 4] = meta.level;
  u32[base + SOURCE_OFFSET_INDIRECTION_OFFSET / 4] = meta.offset;
  u32[base + SOURCE_OFFSET_PAD0 / 4] = 0;

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
