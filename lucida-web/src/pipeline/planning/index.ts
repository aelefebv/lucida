/**
 * Planning domain — public barrel. See ADR 0029.
 * Core lives in sibling files; this module is re-exports only.
 */

// ---------------------------------------------------------------------------
// Types and the empty-stats factory.
// ---------------------------------------------------------------------------

export {
  emptyPlanStats,
  type ActiveSetEntry,
  type AssetCatalogSnapshot,
  type BaseEntitySnapshot,
  type CacheStateSnapshot,
  type ChunkRequest,
  type EntityMode,
  type EntitySnapshot,
  type FieldEntry,
  type FieldSnapshot,
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
  type ResolvedMode,
  type SelectionState,
  type WellAsProxyEntry,
  type WellGroup,
  type WellSnapshot,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Mode-decision helpers.
// ---------------------------------------------------------------------------

export {
  assignModes,
  buildPrevModeByWell,
  chooseEntityMode,
  degradeForCatalog,
  groupByWell,
} from "./modes.ts";

// ---------------------------------------------------------------------------
// Chunk enumeration and culling primitives.
// ---------------------------------------------------------------------------

export {
  chunkKey,
  chunkOutsideFrustum,
  chunkWorldDims,
  iterateChunks,
  iterateChunksAtLodRange,
} from "./chunks.ts";

// ---------------------------------------------------------------------------
// Lane emission helpers.
// ---------------------------------------------------------------------------

export {
  emitDetailLane,
  emitMinimapLane,
  emitOverviewLane,
  emitPrefetchLane,
} from "./emit.ts";

// ---------------------------------------------------------------------------
// Top-level planner.
// ---------------------------------------------------------------------------

export { plan } from "./plan.ts";

// ---------------------------------------------------------------------------
// Tunables (configurable defaults).
// ---------------------------------------------------------------------------

export {
  DEFAULT_PLANNING_CONFIG,
  DETAIL_LANE_OFFSET,
  DETAIL_THRESHOLD_PX,
  DISTANCE_WEIGHT,
  FAR_THRESHOLD_PX,
  HYSTERESIS_PX,
  IMPORTANCE_WEIGHT,
  MINIMAP_LANE_OFFSET,
  OVERVIEW_LANE_OFFSET,
  PREFETCH_DEPTH,
  PREFETCH_LANE_OFFSET,
  PROXY_LANE_OFFSET,
  WELL_PROXY_PRIORITY_BUMP,
  mergeConfig,
  type PlanningConfig,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Synthetic test helpers.
// ---------------------------------------------------------------------------

export {
  createSyntheticEntity,
  createSyntheticSnapshot,
  createSyntheticState,
} from "./synthetic.ts";
