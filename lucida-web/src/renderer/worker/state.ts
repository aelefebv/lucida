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
 * `case "destroy"`. GPU resources held by atlas / descriptor / proxy
 * pools are destroyed separately via the per-mode `destroyAll*Resources`
 * helpers.
 */

import type { SceneEpochs } from "../../pipeline/epochs.ts";
import type { ColdStateMessage } from "../workerProtocol.ts";
import type { AtlasState, LodIndirectionMeta } from "../volume/atlas.ts";
import type { SliceAtlasState, LabelSlicePool } from "../slice/atlas.ts";
import type { ProxyAtlasState } from "../proxyAtlas.ts";
import type { EntityProxyDescriptor } from "../workerContext.ts";
import type { EntityDescriptorIndex } from "../descriptorBuffer.ts";

export interface RendererState {
  // ── Cold-state routing ────────────────────────────────────────────
  /** memberId → datasetId (canonical: imageId or imageId:chN; well-as-proxy resolves to entityId). */
  memberToDataset: Map<string, string>;
  /** memberId → detail pool key. Legacy compatibility for callers that have not become tier-aware. */
  memberToPool: Map<string, string>;
  /** `${memberId}|${tier}` → pool key encoding (datasetId, channel, tier, chunkDims). */
  memberTierToPool: Map<string, string>;
  /** Per-dataset entityMetas snapshot captured during the most recent cold state. */
  currentEntityMetasByDataset: Map<string, Map<string, LodIndirectionMeta[]>>;
  /** wellId → set of child fieldEntityIds (used for WellProxy3D fan-out). */
  wellToFields: Map<string, Set<string>>;
  /**
   * dataset → wellIds whose entries currently live in {@link wellToFields}.
   * Tracked so `removeLayerResources` can drop the well→fields entries
   * owned by the removed dataset without scanning every well's child set.
   */
  wellsByDataset: Map<string, Set<string>>;

  // ── Proxy + descriptor registries ────────────────────────────────
  /** dataset → poolKey → ProxyAtlasState (proxy GPU residency by `(datasetId, kind, slotDims, channel)`). */
  proxyPoolsByDataset: Map<string, Map<string, ProxyAtlasState>>;
  /** `${entityId}|${t}|${c}` → field/well proxy handle pair (CPU mirror of GPU descriptor). */
  proxyDescriptorsByEntity: Map<string, EntityProxyDescriptor>;
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

  // ── Per-entity eviction reference points ─────────────────────────
  /** memberId → last known ray-volume hit in entity-local [0,1]^3 (volume mode). */
  rayHitPerEntity: Map<string, [number, number, number]>;
  /** memberId → last known viewport center in entity-local [0,1]^2 (slice mode). */
  cameraUVPerEntity: Map<string, [number, number]>;

  // ── Cold-state / epoch tracking ──────────────────────────────────
  /** Current scene epochs (replaced on every cold state). */
  currentEpochs: SceneEpochs | null;
  /** Last cold-state message (replaced on every cold state). */
  currentColdState: ColdStateMessage | null;

  // ── Devtools counter (worker-side HITL) ──────────────────────────
  /** Proxy upload/residency counters exposed via `self.__lucidaProxyStats`. */
  proxyStats: {
    uploaded: number;
    dropped: number;
    evicted: number;
    droppedStale: number;
    droppedNotDesired: number;
    droppedStaleRequest: number;
    evictedLru: number;
    evictedPolicy: number;
  };
}

/** Build an empty {@link RendererState}. Called once in `case "init"`. */
export function createInitialState(): RendererState {
  return {
    memberToDataset: new Map(),
    memberToPool: new Map(),
    memberTierToPool: new Map(),
    currentEntityMetasByDataset: new Map(),
    wellToFields: new Map(),
    wellsByDataset: new Map(),
    proxyPoolsByDataset: new Map(),
    proxyDescriptorsByEntity: new Map(),
    descriptorBuffersByDataset: new Map(),
    volumeAtlases: new Map(),
    sliceAtlases: new Map(),
    labelSlicePools: new Map(),
    rayHitPerEntity: new Map(),
    cameraUVPerEntity: new Map(),
    currentEpochs: null,
    currentColdState: null,
    proxyStats: {
      uploaded: 0,
      dropped: 0,
      evicted: 0,
      droppedStale: 0,
      droppedNotDesired: 0,
      droppedStaleRequest: 0,
      evictedLru: 0,
      evictedPolicy: 0,
    },
  };
}
