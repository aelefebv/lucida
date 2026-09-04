/**
 * Planning domain — public barrel. See ADR 0029.
 * Core lives in sibling files; this module is re-exports only.
 */

export {
  emptyPlanStats,
  initialPlanningState,
  type ZoomDirection,
  type ActiveSetEntry,
  type AssetCatalogSnapshot,
  type BaseEntitySnapshot,
  type CacheStateSnapshot,
  type ChunkRequest,
  type EntityMode,
  type EntitySnapshot,
  type TileEntry,
  type TileSnapshot,
  type ImageSnapshot,
  type InvisibleEntry,
  type MinimapChunkCoord,
  type PlanCullingStats,
  type PlanningSnapshot,
  type PlanningState,
  type PlanStats,
  type ProxyKind,
  type ProxyRequest,
  type RequestPlan,
  type SelectionState,
  type GroupAsProxyEntry,
  type MemberGroup,
  type GroupSnapshot,
} from "./types.ts";

export { buildActiveSet, groupMembers } from "./activeSet.ts";

export {
  chunkKey,
  chunkOutsideFrustum,
  chunkWorldDims,
  iterateChunks,
  iterateChunksAtLevels,
} from "./chunks.ts";

export {
  emitCoarseLane,
  emitDetailLane,
  emitMinimapLane,
  emitPrefetchLane,
} from "./emit.ts";

export { plan, emitPlanRequests } from "./plan.ts";

export {
  DEFAULT_PLANNING_CONFIG,
  COARSE_LANE_OFFSET,
  DEFAULT_PROXY_RESIDENCY_BUDGET_BYTES,
  DEPTH_BIAS_VIEW,
  DETAIL_LANE_OFFSET,
  DISTANCE_WEIGHT,
  IMPORTANCE_WEIGHT,
  MINIMAP_LANE_OFFSET,
  MINIMAP_SEED_BULK_LANE_OFFSET,
  MINIMAP_SEED_FAST_MAX_CHUNKS,
  PREFETCH_DEPTH,
  PREFETCH_LANE_OFFSET,
  PROXY_LANE_OFFSET,
  RENDER_RADIUS_DISABLED_VIEW,
  GROUP_PROXY_PRIORITY_BUMP,
  mergeConfig,
  type PlanningConfig,
} from "./config.ts";

export {
  planProxyResidency,
  planProxyResidencyForInputs,
  proxyRequestKey,
  type ProxyResidencyBundleDecision,
  type ProxyResidencyInput,
  type ProxyResidencyPlan,
  type ProxyResidencyStats,
} from "./proxyResidency.ts";

export {
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
  type CreateSyntheticEntityOverrides,
} from "./synthetic.ts";
