/**
 * Planning domain — public barrel. See ADR 0029.
 * Core lives in sibling files; this module is re-exports only.
 */

export {
  emptyPlanStats,
  type ActiveSetEntry,
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
  type RequestPlan,
  type SelectionState,
  type MemberGroup,
  type GroupSnapshot,
} from "./types.ts";

export {
  assignChunkModes,
  groupMembers,
} from "./modes.ts";

export {
  chunkKey,
  chunkOutsideFrustum,
  chunkWorldDims,
  iterateChunks,
  iterateChunksAtLodRange,
} from "./chunks.ts";

export {
  emitCoarseLane,
  emitDetailLane,
  emitMinimapLane,
  emitPrefetchLane,
} from "./emit.ts";

export {
  plan,
  emitPlanRequests,
  compareChunkRequests,
  applyWorkspaceMinimapPriority,
} from "./plan.ts";

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
} from "./synthetic.ts";
