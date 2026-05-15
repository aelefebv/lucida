/**
 * Planning tunables — typed, parameter-passed.
 *
 * Slice 3 of the planning refactor (PRD #545) lifts the legacy
 * module-level constants out of the planning code paths and into a
 * `PlanningConfig` value that {@link plan} accepts as a parameter. This
 * honours principle §4 of `wiki/principles/planning.md` — planning is
 * pure and any state that survives across ticks (or any policy knob the
 * user might twist live) is an explicit input.
 *
 * The default-value literals live in this module (the leaf, to avoid a
 * circular import with `./index.ts`) and are re-exported from
 * `./index.ts` under their historical names (`FAR_THRESHOLD_PX`, etc.)
 * so existing callers and tests keep importing them from the planning
 * entry point. Both the named constants and {@link DEFAULT_PLANNING_CONFIG}
 * share the same underlying numbers, so the two cannot drift. Slice 6
 * wires a live `configStore` into the orchestrator; until then the
 * orchestrator passes {@link DEFAULT_PLANNING_CONFIG} verbatim,
 * preserving today's behaviour exactly.
 */

// ---------------------------------------------------------------------------
// Canonical default values
// ---------------------------------------------------------------------------
//
// These constants are the single source of truth for every planning
// tunable's default. They live in this leaf module (no imports from
// `./index.ts`) so the planning entry point can import them — and the
// {@link DEFAULT_PLANNING_CONFIG} that wraps them — without a circular
// dependency. `./index.ts` re-exports each one under its historical
// public name (`FAR_THRESHOLD_PX`, etc.).

/**
 * Far threshold (px). Below this, a well promotes to `well-as-proxy`.
 * Replaces the legacy two-tier `PROMOTE_THRESHOLD_PX = 80`; same value.
 */
export const FAR_THRESHOLD_PX = 80;

/** Medium/Detail threshold (px). Above this, fields use real detail chunks. */
export const DETAIL_THRESHOLD_PX = 150;

/** Hysteresis band (px) on either side of each threshold. */
export const HYSTERESIS_PX = 5;

/**
 * Priority lane offset for the minimap lane (highest urgency in the
 * system). Slice 5 of PRD #545 promoted minimap from the OVERVIEW
 * lane (2000) to its own dedicated lane at offset `0` so the
 * whole-sample spatial context appears within ~1 second of dataset
 * open instead of after every other lane drains. See ADR 0023.
 */
export const MINIMAP_LANE_OFFSET = 0;

/** Priority lane offset for detail requests (visible chunks). */
export const DETAIL_LANE_OFFSET = 500;

/** Priority lane offset for proxy requests (well/field proxy fallbacks). */
export const PROXY_LANE_OFFSET = 1000;

/** Priority lane offset for prefetch (next-timepoint) requests. */
export const PREFETCH_LANE_OFFSET = 1500;

/**
 * Priority lane offset for overview requests — the per-entity
 * coarsest pass that backstops the shader's fallback chain. Distinct
 * from {@link MINIMAP_LANE_OFFSET}; this lane is per-entity and
 * lowest urgency in the system.
 */
export const OVERVIEW_LANE_OFFSET = 2500;

/** Number of future timepoints to prefetch (length of the prefetch lane). */
export const PREFETCH_DEPTH = 2;

/**
 * Coefficient applied to `(1 - importance)` in the priority formula.
 * Tuned so a one-importance-step gap roughly equals a 50-voxel distance
 * gap — high enough that a focused entity beats a far-but-uniform one.
 */
export const IMPORTANCE_WEIGHT = 500;

/**
 * Coefficient applied to chunk distance from the view center in the
 * priority formula. Lower than {@link IMPORTANCE_WEIGHT} so importance
 * dominates within a lane until distances become large.
 */
export const DISTANCE_WEIGHT = 10;

/**
 * Priority bump applied to the parent-well `WellProxy3D` request emitted
 * inside `fields-with-proxy-fallback`. Pushes it below per-field proxy
 * requests so detail + per-field proxy load first; the well proxy is
 * only a coarse fallback while those are in flight.
 */
export const WELL_PROXY_PRIORITY_BUMP = 100;

/**
 * Per-tick planning tunables, threaded through {@link plan} and the
 * downstream lane / mode functions. Defaults live in
 * {@link DEFAULT_PLANNING_CONFIG} and match the canonical module-level
 * constants exactly.
 */
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

  // -- lane offsets ---------------------------------------------------
  /**
   * Priority lane offset for the minimap lane (highest urgency).
   * See {@link MINIMAP_LANE_OFFSET}.
   */
  minimapLaneOffset: number;
  /** Priority lane offset for detail requests (visible chunks). */
  detailLaneOffset: number;
  /** Priority lane offset for proxy requests (well/field proxy fallbacks). */
  proxyLaneOffset: number;
  /** Priority lane offset for prefetch (next-timepoint) requests. */
  prefetchLaneOffset: number;
  /** Priority lane offset for overview requests (lowest urgency). */
  overviewLaneOffset: number;
}

/**
 * Canonical defaults. Values are sourced from the module-level
 * constants in `./index.ts` so this struct cannot silently drift from
 * the historical values.
 */
export const DEFAULT_PLANNING_CONFIG: PlanningConfig = {
  farThresholdPx: FAR_THRESHOLD_PX,
  detailThresholdPx: DETAIL_THRESHOLD_PX,
  hysteresisPx: HYSTERESIS_PX,
  prefetchDepth: PREFETCH_DEPTH,
  importanceWeight: IMPORTANCE_WEIGHT,
  distanceWeight: DISTANCE_WEIGHT,
  wellProxyPriorityBump: WELL_PROXY_PRIORITY_BUMP,
  minimapLaneOffset: MINIMAP_LANE_OFFSET,
  detailLaneOffset: DETAIL_LANE_OFFSET,
  proxyLaneOffset: PROXY_LANE_OFFSET,
  prefetchLaneOffset: PREFETCH_LANE_OFFSET,
  overviewLaneOffset: OVERVIEW_LANE_OFFSET,
};

/**
 * Merge a partial config over {@link DEFAULT_PLANNING_CONFIG}, returning
 * a fresh object. Convenience for tests and call sites that only want
 * to override a handful of fields.
 */
export function mergeConfig(partial: Partial<PlanningConfig>): PlanningConfig {
  return { ...DEFAULT_PLANNING_CONFIG, ...partial };
}
