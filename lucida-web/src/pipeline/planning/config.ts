/**
 * Planning tunables. `PlanningConfig` is the single value {@link plan}
 * accepts for policy knobs (principle §4 in `wiki/principles/planning.md`:
 * planning is pure, knobs are explicit inputs).
 *
 * Defaults live in this leaf module (no `./index.ts` import) so the
 * barrel can re-export both the named constants and
 * {@link DEFAULT_PLANNING_CONFIG} without a circular dependency.
 */

/** Far threshold (px). Below this, a well promotes to `well-as-proxy`. */
export const FAR_THRESHOLD_PX = 80;

/** Medium/Detail threshold (px). Above this, fields use real detail chunks. */
export const DETAIL_THRESHOLD_PX = 150;

/** Hysteresis band (px) on either side of each threshold. */
export const HYSTERESIS_PX = 5;

/**
 * Minimap lane offset — highest urgency, dedicated lane at `0` so
 * whole-sample spatial context appears within ~1 s of dataset open.
 * See ADR 0023.
 */
export const MINIMAP_LANE_OFFSET = 0;

/** Priority lane offset for detail requests (visible chunks). */
export const DETAIL_LANE_OFFSET = 500;

/** Priority lane offset for proxy requests (well/field proxy fallbacks). */
export const PROXY_LANE_OFFSET = 1000;

/** Default worker-global GPU proxy residency budget: 128 MiB. */
export const DEFAULT_PROXY_RESIDENCY_BUDGET_BYTES = 128 * 1024 * 1024;

/** Priority lane offset for prefetch (next-timepoint) requests. */
export const PREFETCH_LANE_OFFSET = 1500;

/**
 * Overview lane offset — per-entity coarsest pass that backstops the
 * shader's fallback chain. Lowest urgency.
 */
export const OVERVIEW_LANE_OFFSET = 2500;

/**
 * Coarse lane offset for the chunk-only bridge. Kept near the old
 * overview lane so minimap/detail stay ahead of whole-context fill.
 */
export const COARSE_LANE_OFFSET = 2400;

/** Number of future timepoints to prefetch (length of the prefetch lane). */
export const PREFETCH_DEPTH = 2;

/**
 * Render-radius slider value that disables radius filtering. Values
 * below this are interpreted as a multiplier of the current visible
 * region's half-diagonal.
 */
export const RENDER_RADIUS_DISABLED_VIEW = 2;

/**
 * Coefficient on `(1 - importance)`. Tuned so a one-importance-step gap
 * roughly equals a 50-voxel distance gap.
 */
export const IMPORTANCE_WEIGHT = 500;

/** Coefficient on chunk distance from view center. */
export const DISTANCE_WEIGHT = 10;

/**
 * Bump on the parent-well `WellProxy3D` request inside
 * `fields-with-proxy-fallback` — pushes it below per-field proxies so
 * the well proxy is only a coarse fallback while those are in flight.
 */
export const WELL_PROXY_PRIORITY_BUMP = 100;

/** Per-tick planning tunables threaded through {@link plan}. */
export interface PlanningConfig {
  // -- mode-decision thresholds ---------------------------------------
  /** Below this projected diagonal (px) a well promotes to `well-as-proxy`. */
  farThresholdPx: number;
  /** Above this projected diagonal (px) fields use real detail chunks. */
  detailThresholdPx: number;
  /** Hysteresis band (px) on either side of each threshold. */
  hysteresisPx: number;

  // -- prefetch -------------------------------------------------------
  /** Number of future timepoints to prefetch (length of the prefetch lane). */
  prefetchDepth: number;

  // -- priority weights -----------------------------------------------
  /** Coefficient on `(1 - importance)` in the priority formula. */
  importanceWeight: number;
  /** Coefficient on chunk distance from the view center. */
  distanceWeight: number;
  /**
   * Bump applied to the parent-well `WellProxy3D` request emitted inside
   * `fields-with-proxy-fallback`. Pushes it below per-field proxies.
   */
  wellProxyPriorityBump: number;

  // -- GPU proxy residency -------------------------------------------
  /** Worker-global GPU proxy residency budget, in bytes. */
  proxyResidencyBudgetBytes: number;

  // -- residency model ------------------------------------------------
  /**
   * Internal bridge flag for chunk-only coarse/detail residency. False
   * preserves the proxy-era planner until the new path reaches parity.
   */
  coarseDetailEnabled: boolean;
  /**
   * Detail render radius as a multiplier of the visible-region
   * half-diagonal. The default max value disables filtering.
   */
  detailRenderRadiusView: number;
  /**
   * Coarse render radius as a multiplier of the visible-region
   * half-diagonal. The default max value disables filtering.
   */
  coarseRenderRadiusView: number;

  // -- lane offsets ---------------------------------------------------
  /** Minimap lane (highest urgency). See {@link MINIMAP_LANE_OFFSET}. */
  minimapLaneOffset: number;
  /** Detail requests (visible chunks). */
  detailLaneOffset: number;
  /** Proxy requests (well/field proxy fallbacks). */
  proxyLaneOffset: number;
  /** Prefetch (next-timepoint) requests. */
  prefetchLaneOffset: number;
  /** Overview requests (lowest urgency). */
  overviewLaneOffset: number;
  /** Coarse requests for the chunk-only bridge. */
  coarseLaneOffset: number;
}

/** Canonical defaults. Sourced from the module-level constants so the two cannot drift. */
export const DEFAULT_PLANNING_CONFIG: PlanningConfig = {
  farThresholdPx: FAR_THRESHOLD_PX,
  detailThresholdPx: DETAIL_THRESHOLD_PX,
  hysteresisPx: HYSTERESIS_PX,
  prefetchDepth: PREFETCH_DEPTH,
  importanceWeight: IMPORTANCE_WEIGHT,
  distanceWeight: DISTANCE_WEIGHT,
  wellProxyPriorityBump: WELL_PROXY_PRIORITY_BUMP,
  proxyResidencyBudgetBytes: DEFAULT_PROXY_RESIDENCY_BUDGET_BYTES,
  coarseDetailEnabled: true,
  detailRenderRadiusView: RENDER_RADIUS_DISABLED_VIEW,
  coarseRenderRadiusView: RENDER_RADIUS_DISABLED_VIEW,
  minimapLaneOffset: MINIMAP_LANE_OFFSET,
  detailLaneOffset: DETAIL_LANE_OFFSET,
  proxyLaneOffset: PROXY_LANE_OFFSET,
  prefetchLaneOffset: PREFETCH_LANE_OFFSET,
  overviewLaneOffset: OVERVIEW_LANE_OFFSET,
  coarseLaneOffset: COARSE_LANE_OFFSET,
};

/** Merge a partial config over {@link DEFAULT_PLANNING_CONFIG}; returns a fresh object. */
export function mergeConfig(partial: Partial<PlanningConfig>): PlanningConfig {
  return { ...DEFAULT_PLANNING_CONFIG, ...partial };
}
