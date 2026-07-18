/**
 * Worker-side renderer state — every per-session Map / counter / pointer
 * the worker dispatcher owns. Threaded through {@link WorkerCtx.state};
 * handlers read/write `ctx.state.<field>` rather than reaching for
 * module globals.
 *
 * Renderer-class singletons (slice/volume/cursor/compositor renderers)
 * and persistent GPU resources (LUT cache, offscreen pool, dummy
 * textures) intentionally stay at module scope in `gpu.worker.ts`.
 *
 * Created in `case "init"` by {@link createInitialState}; torn down by
 * `case "destroy"`. GPU resources held by atlas / descriptor
 * pools are destroyed separately via the per-mode `destroyAll*Resources`
 * helpers.
 */

import type { SceneEpochs } from "../../pipeline/epochs.ts";
import type { ColdStateMessage } from "../workerProtocol.ts";
import type { AtlasState, LabelVolumePool, LodIndirectionMeta } from "../volume/atlas.ts";
import type { SliceAtlasState, LabelSlicePool } from "../slice/atlas.ts";
import type { EntityDescriptorIndex } from "../descriptorBuffer.ts";
import type { AggregateBatch } from "../sliceRenderer.ts";

/** Camera transform shared by every resident member in one cached aggregate. */
export interface AggregateCameraView {
  cx: number;
  cy: number;
  offsetX: number;
  offsetY: number;
  dataW: number;
  dataH: number;
}

/** Lazy per-member camera lookup for aggregate eviction distance. */
export interface AggregateMemberCamera {
  cacheKey: string;
  rect: readonly [x: number, y: number, width: number, height: number];
  view: AggregateCameraView;
}

/** Worker-resolved aggregate topology, reusable until residency changes. */
export interface ResolvedAggregateTopology {
  generation: number;
  descriptor: EntityDescriptorIndex;
  quadData: ArrayBuffer;
  batches: AggregateBatch[];
  atlases: Set<SliceAtlasState>;
  cameraView: AggregateCameraView;
  cameraMemberIds: string[];
}

export interface AggregateQuadCacheEntry {
  ownerDatasetId: string;
  ownerKey: string;
  quads: ArrayBuffer;
  resolved?: ResolvedAggregateTopology;
}

export interface RendererState {
  // ── Cold-state routing ────────────────────────────────────────────
  /** memberId → datasetId (canonical: imageId or imageId:chN). */
  memberToDataset: Map<string, string>;
  /** memberId → detail pool key. Legacy compatibility for callers that have not become tier-aware. */
  memberToPool: Map<string, string>;
  /** `${memberId}|${tier}` → pool key encoding (datasetId, channel, tier, chunkDims). */
  memberTierToPool: Map<string, string>;
  /** Per-dataset entityMetas snapshot captured during the most recent cold state. */
  currentEntityMetasByDataset: Map<string, Map<string, LodIndirectionMeta[]>>;
  // ── Descriptor registry ──────────────────────────────────────────
  /** dataset → entity descriptor buffer + index maps (rebuilt fresh on each cold state). */
  descriptorBuffersByDataset: Map<string, EntityDescriptorIndex>;

  // ── Per-mode atlas registries ────────────────────────────────────
  /** poolKey → volume atlas pool state. */
  volumeAtlases: Map<string, AtlasState>;
  /** poolKey → slice atlas pool state. */
  sliceAtlases: Map<string, SliceAtlasState>;
  /**
   * memberId → r32uint label overlay slice pool. Separate from
   * {@link sliceAtlases} (r16uint intensity) because label ids need full
   * 32-bit storage and render through the categorical shader path.
   */
  labelSlicePools: Map<string, LabelSlicePool>;
  /**
   * memberId → r32uint label overlay volume pool. The 3D counterpart to
   * {@link labelSlicePools}: holds the full label mask volume for the
   * first-hit categorical surface drawn over the translucent intensity
   * volume. Separate from {@link volumeAtlases} (r16uint intensity) for the
   * same reason — full 32-bit ids + the categorical shader path.
   */
  labelVolumePools: Map<string, LabelVolumePool>;
  /**
   * Main-thread aggregate geometry published once per roster/settings state.
   * Entries are CPU buffers (not GPU allocations) and are replaceable by
   * dataset/channel owner so zooming cannot grow the worker without bound.
   */
  aggregateQuadCache: Map<string, AggregateQuadCacheEntry>;
  /** Replaceable aggregate owner slot → current cache key. */
  aggregateKeyByOwner: Map<string, string>;
  /** Dataset-scoped residency/routing/descriptor generation. */
  aggregateTopologyGenerationByDataset: Map<string, number>;

  // ── Per-entity eviction reference points ─────────────────────────
  /** memberId → last known ray-volume hit in entity-local [0,1]^3 (volume mode). */
  rayHitPerEntity: Map<string, [number, number, number]>;
  /** memberId → last known viewport center in entity-local [0,1]^2 (slice mode). */
  cameraUVPerEntity: Map<string, [number, number]>;
  /** memberId → lazy camera mapping owned by a cached aggregate topology. */
  aggregateCameraByMember: Map<string, AggregateMemberCamera>;

  // ── Cold-state / epoch tracking ──────────────────────────────────
  /** Current scene epochs (replaced on every cold state). */
  currentEpochs: SceneEpochs | null;
  /** Last cold-state message (replaced on every cold state). */
  currentColdState: ColdStateMessage | null;
  /**
   * Per-dataset most-recent cold-state message. A display-only update
   * (`coldStateDisplay`) patches this dataset's entry and rebuilds its
   * descriptor buffer from it, so display edits get the full active set
   * without re-sending it. Cleared on dataset removal.
   */
  coldStateByDataset: Map<string, ColdStateMessage>;

}

/** Build an empty {@link RendererState}. Called once in `case "init"`. */
export function createInitialState(): RendererState {
  return {
    memberToDataset: new Map(),
    memberToPool: new Map(),
    memberTierToPool: new Map(),
    currentEntityMetasByDataset: new Map(),
    descriptorBuffersByDataset: new Map(),
    volumeAtlases: new Map(),
    sliceAtlases: new Map(),
    labelSlicePools: new Map(),
    labelVolumePools: new Map(),
    aggregateQuadCache: new Map(),
    aggregateKeyByOwner: new Map(),
    aggregateTopologyGenerationByDataset: new Map(),
    rayHitPerEntity: new Map(),
    cameraUVPerEntity: new Map(),
    aggregateCameraByMember: new Map(),
    currentEpochs: null,
    currentColdState: null,
    coldStateByDataset: new Map(),
  };
}

export function aggregateTopologyGeneration(
  state: RendererState,
  datasetId: string,
): number {
  return state.aggregateTopologyGenerationByDataset.get(datasetId) ?? 0;
}

/** Invalidate only aggregate topology whose worker-side inputs changed. */
export function invalidateAggregateTopologyForDataset(
  state: RendererState,
  datasetId: string,
): void {
  state.aggregateTopologyGenerationByDataset.set(
    datasetId,
    aggregateTopologyGeneration(state, datasetId) + 1,
  );
}
