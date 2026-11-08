/**
 * Planning domain — public barrel.
 * Core lives in sibling files; this module is re-exports only.
 */

export {
  emptyPlanStats,
  initialPlanningState,
  type ZoomDirection,
  type ActiveSetEntry,
  type BaseEntitySnapshot,
  type CacheStateSnapshot,
  type ChunkRequest,
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
  type RequestPlan,
  type SelectionState,
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
  DEPTH_BIAS_VIEW,
  DETAIL_LANE_OFFSET,
  DISTANCE_WEIGHT,
  IMPORTANCE_WEIGHT,
  MINIMAP_LANE_OFFSET,
  MINIMAP_SEED_BULK_LANE_OFFSET,
  MINIMAP_SEED_FAST_MAX_CHUNKS,
  PREFETCH_DEPTH,
  PREFETCH_LANE_OFFSET,
  RENDER_RADIUS_DISABLED_VIEW,
  mergeConfig,
  type PlanningConfig,
} from "./config.ts";

export {
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
  type CreateSyntheticEntityOverrides,
} from "./synthetic.ts";
