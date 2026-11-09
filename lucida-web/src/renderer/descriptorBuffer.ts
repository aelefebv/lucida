/**
 * Per-dataset entity descriptor buffer: the geometry, level sources, and
 * display state the shaders read per member.
 *
 * The orchestrator and the worker agree on entity indices without a
 * readback because both walk `cold.activeSet × cold.visibleChannels` in the
 * same order (see {@link iterateColdMembers}). A display-only change
 * rebuilds just this buffer from the last cold state.
 */

import type {
  ColdStateMessage,
  ColdStateActiveEntry,
  ColdStateDisplayState,
} from "./workerProtocol.ts";
import { sampleFormatCode, type SampleFormat } from "./dataTypeUtil.ts";
import type { LodIndirectionMeta } from "./volume/atlas.ts";
import {
  selectEntitySources,
  type EntitySource,
  type EntitySourceSelection,
} from "./entitySources.ts";
import {
  DESCRIPTOR_ENTRY_SIZE,
  DESCRIPTOR_MAX_LEVEL_SOURCES,
  DESCRIPTOR_TIER_SOURCE_SIZE,
  OFFSET_CHANNEL_MASK,
  OFFSET_COLORMAP_LUT_INDEX,
  OFFSET_CONTRAST_MAX,
  OFFSET_CONTRAST_MIN,
  OFFSET_GAMMA,
  OFFSET_INV_MODEL_MATRIX,
  OFFSET_LABEL_OPACITY,
  OFFSET_LEVEL_SOURCE_COUNT,
  OFFSET_COARSE_SOURCE,
  OFFSET_COLORMAP_MODE,
  OFFSET_MODEL_MATRIX,
  OFFSET_OPACITY,
  OFFSET_PAD0,
  OFFSET_PAD1,
  OFFSET_SAMPLE_FORMAT,
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
   * Inverse of {@link indexByMember}. The aggregate path resolves each
   * quad's member from the entity index its record carries.
   */
  memberByIndex: string[];
  /** memberId → the level and coarse pools its descriptor entry samples. */
  sourceBindingByMember: Map<string, MemberSourceBinding>;
  /** Number of populated descriptor entries (== `indexByMember.size`). */
  entityCount: number;
  /**
   * Colormap name → dense LUT index, in first-seen order. The GPU field is
   * informational; the CPU binds each draw's LUT from `colormapNameByMember`.
   */
  colormapLutIndices: Map<string, number>;
  /** memberId → colormap name. Drives per-draw LUT texture binding. */
  colormapNameByMember: Map<string, string>;
}

/**
 * Canonical memberId for a (cold-state entry, channel) pair. The
 * orchestrator and the worker both call this so entity indices agree.
 */
export function memberIdForColdEntry(
  entry: ColdStateActiveEntry,
  channel: number,
): string {
  return `${entry.imageId}:ch${channel}`;
}

/**
 * Yields members in the order both worker and orchestrator visit. Channel
 * is the inner loop, matching how the cold-state handler builds pool groups.
 */
export function* iterateColdMembers(
  cold: ColdStateMessage,
): Generator<{ entry: ColdStateActiveEntry; channel: number; memberId: string }> {
  for (const entry of cold.activeSet) {
    for (const channel of cold.visibleChannels) {
      yield {
        entry,
        channel,
        memberId: memberIdForColdEntry(entry, channel),
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
 * Build a per-dataset descriptor buffer from cold state, one entry per
 * member in canonical order, with dense colormap indices. Writes into
 * `reuse` when it is big enough.
 */
export function buildDescriptorBuffer(
  device: GPUDevice,
  cold: ColdStateMessage,
  sourcesByMember: Map<string, EntitySource[]>,
  reuse?: GPUBuffer,
): EntityDescriptorIndex {
  const indexByMember = new Map<string, number>();
  const sourceBindingByMember = new Map<string, MemberSourceBinding>();
  const colormapLutIndices = new Map<string, number>();
  const colormapNameByMember = new Map<string, string>();

  // Pass 1: assign entity and colormap indices in the order the
  // orchestrator also walks, so the serialize pass sees complete maps.
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
      colormapLutIndices,
      cold.sampleFormat,
    );
  }

  const buffer = reuse && reuse.size >= bufferSize
    ? reuse
    : device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  device.queue.writeBuffer(buffer, 0, cpuBuffer);

  return {
    buffer,
    indexByMember,
    memberByIndex,
    sourceBindingByMember,
    entityCount,
    colormapLutIndices,
    colormapNameByMember,
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

/**
 * Replace a dataset's descriptor buffer with one built from `cold`, written
 * into the buffer it had when that is big enough. Every member draw's bind
 * group names the buffer, so a new one on each view move or display edit
 * would remake one per member on the next frame.
 */
export function rebuildDescriptorBuffer(
  device: GPUDevice,
  previous: EntityDescriptorIndex | undefined,
  cold: ColdStateMessage,
  sourcesByMember: Map<string, EntitySource[]>,
): EntityDescriptorIndex {
  const next = buildDescriptorBuffer(device, cold, sourcesByMember, previous?.buffer);
  if (previous && previous.buffer !== next.buffer) destroyDescriptorBuffer(previous);
  return next;
}

export function destroyDescriptorBuffer(idx: EntityDescriptorIndex): void {
  idx.buffer.destroy();
  idx.indexByMember.clear();
  idx.memberByIndex.length = 0;
  idx.sourceBindingByMember.clear();
  idx.colormapLutIndices.clear();
  idx.colormapNameByMember.clear();
}

/**
 * Per-channel display state, with a no-op default that keeps the descriptor
 * well-formed if a channel index drifts during a transition.
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
 * Exported so tests can check the byte layout without a GPU.
 */
export function serializeEntityDescriptor(
  target: ArrayBuffer,
  offset: number,
  entry: ColdStateActiveEntry,
  selection: EntitySourceSelection,
  displayState: ColdStateDisplayState,
  colormapLutIndices: Map<string, number>,
  sampleFormat: SampleFormat = "u16",
): void {
  const f32 = new Float32Array(target, offset, DESCRIPTOR_ENTRY_SIZE / 4);
  const u32 = new Uint32Array(target, offset, DESCRIPTOR_ENTRY_SIZE / 4);

  if (entry.modelMatrix.length === 16) f32.set(entry.modelMatrix, OFFSET_MODEL_MATRIX / 4);
  if (entry.invModelMatrix.length === 16) f32.set(entry.invModelMatrix, OFFSET_INV_MODEL_MATRIX / 4);

  const lutIdx = colormapLutIndices.get(displayState.colormapName) ?? 0;

  u32[OFFSET_CHANNEL_MASK / 4] = displayState.channelMask >>> 0;
  u32[OFFSET_SAMPLE_FORMAT / 4] = sampleFormatCode(sampleFormat);
  u32[OFFSET_PAD0 / 4] = 0;
  u32[OFFSET_PAD1 / 4] = 0;

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
