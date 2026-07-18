/**
 * Planning tunables. `PlanningConfig` is the single value {@link plan}
 * accepts for policy knobs (principle §4 in `wiki/principles/planning.md`:
 * planning is pure, knobs are explicit inputs).
 *
 * Defaults live in this leaf module (no `./index.ts` import) so the
 * barrel can re-export both the named constants and
 * {@link DEFAULT_PLANNING_CONFIG} without a circular dependency.
 */

/**
 * Minimap lane offset — highest urgency, dedicated lane at `0` so
 * whole-sample spatial context appears within ~1 s of dataset open.
 * See ADR 0023. Applies only while the pending seed set is small
 * ({@link MINIMAP_SEED_FAST_MAX_CHUNKS}); larger sets emit at
 * {@link MINIMAP_SEED_BULK_LANE_OFFSET}.
 */
export const MINIMAP_LANE_OFFSET = 0;

/**
 * Largest pending minimap seed set (chunks, per dataset) that still
 * rides the top-priority lane. ADR 0023's top placement rests on the
 * seed set being SMALL — a bounded ~1 s starvation window for the view
 * lanes. A wide collection breaks that premise: tens of thousands of
 * coarsest chunks at top priority would hold every fetch slot for tens
 * of minutes while the visible band waits. Above this count the whole
 * seed set emits at {@link MINIMAP_SEED_BULK_LANE_OFFSET} instead. At
 * typical fetch throughput the cap bounds the worst-case fast-lane
 * window to a few seconds — and on a small collection most seeds are
 * the same chunks the view's coarse lane wants anyway, so they fill
 * both at once.
 */
export const MINIMAP_SEED_FAST_MAX_CHUNKS = 128;

/**
 * Priority FLOOR for minimap seeding once the pending seed count
 * exceeds {@link MINIMAP_SEED_FAST_MAX_CHUNKS}. Lane offsets are not
 * bands — the importance/distance terms in the priority formula are
 * unbounded, so a wide view's coarse/detail requests can run far past
 * any constant — therefore the planner emits bulk seeds at
 * `max(this, highest priority already in the plan + 1)`: strictly
 * behind everything the view asked for. The minimap then fills
 * opportunistically as fetch slots free up: it may take minutes, which
 * is acceptable for a whole-collection overview and not acceptable for
 * the main view.
 */
export const MINIMAP_SEED_BULK_LANE_OFFSET = 2600;

/** Priority lane offset for detail requests (visible chunks). */
export const DETAIL_LANE_OFFSET = 500;

/** Priority lane offset for prefetch (next-timepoint) requests. */
export const PREFETCH_LANE_OFFSET = 1500;

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
 * Depth bias for the 3-D center-out chunk-spawn origin, expressed as a
 * fraction of the visible region's half-depth along the near↔far (Z)
 * axis. `-1` biases the spawn origin to the near plane, `+1` to the far
 * plane, `0` keeps it centered.
 *
 * **Safety property (issue #532):** the default is exactly `0`, which
 * adds a `0 * halfDepth = 0` offset to the focal Z used by
 * `chunkDistanceFromCenter`. At the default the priority computation is
 * therefore byte-identical to the pre-bias behavior — proven by
 * `planning.test.ts` ("depth bias 0 reproduces unbiased ordering").
 */
export const DEPTH_BIAS_VIEW = 0;

/** Per-tick planning tunables threaded through {@link plan}. */
export interface PlanningConfig {
  // -- prefetch -------------------------------------------------------
  /** Number of future timepoints to prefetch (length of the prefetch lane). */
  prefetchDepth: number;

  // -- priority weights -----------------------------------------------
  /** Coefficient on `(1 - importance)` in the priority formula. */
  importanceWeight: number;
  /** Coefficient on chunk distance from the view center. */
  distanceWeight: number;
  /**
   * Depth bias for the 3-D center-out spawn origin along the near↔far
   * (Z) axis, as a fraction of the visible region's half-depth. `0`
   * (default) keeps the spawn origin centered — byte-identical to the
   * unbiased behavior. Negative biases toward near, positive toward
   * far. Clamped to `[-1, 1]`; the resulting focal Z is clamped to the
   * visible Z range. See {@link DEPTH_BIAS_VIEW}.
   */
  depthBiasView: number;
  // -- residency model ------------------------------------------------
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
  /**
   * Largest pending minimap seed set that still rides the top-priority
   * lane. See {@link MINIMAP_SEED_FAST_MAX_CHUNKS}. Optional for
   * compatibility with config objects predating the knob (older
   * persisted snapshots, external callers of the pure planner):
   * `emitMinimapLane` falls back to the module default when absent, so
   * large demand can never ride the fast lane by omission.
   */
  minimapSeedFastMaxChunks?: number;
  /**
   * Lane offset for minimap seeding beyond the fast cap (lowest
   * urgency). See {@link MINIMAP_SEED_BULK_LANE_OFFSET}. Optional for
   * the same compatibility reason as {@link minimapSeedFastMaxChunks}.
   */
  minimapSeedBulkLaneOffset?: number;
  /** Detail requests (visible chunks). */
  detailLaneOffset: number;
  /** Prefetch (next-timepoint) requests. */
  prefetchLaneOffset: number;
  /** Coarse requests for the chunk-only bridge. */
  coarseLaneOffset: number;
}

/** Canonical defaults. Sourced from the module-level constants so the two cannot drift. */
export const DEFAULT_PLANNING_CONFIG: PlanningConfig = {
  prefetchDepth: PREFETCH_DEPTH,
  importanceWeight: IMPORTANCE_WEIGHT,
  distanceWeight: DISTANCE_WEIGHT,
  depthBiasView: DEPTH_BIAS_VIEW,
  detailRenderRadiusView: RENDER_RADIUS_DISABLED_VIEW,
  coarseRenderRadiusView: RENDER_RADIUS_DISABLED_VIEW,
  minimapLaneOffset: MINIMAP_LANE_OFFSET,
  minimapSeedFastMaxChunks: MINIMAP_SEED_FAST_MAX_CHUNKS,
  minimapSeedBulkLaneOffset: MINIMAP_SEED_BULK_LANE_OFFSET,
  detailLaneOffset: DETAIL_LANE_OFFSET,
  prefetchLaneOffset: PREFETCH_LANE_OFFSET,
  coarseLaneOffset: COARSE_LANE_OFFSET,
};

/** Merge a partial config over {@link DEFAULT_PLANNING_CONFIG}; returns a fresh object. */
export function mergeConfig(partial: Partial<PlanningConfig>): PlanningConfig {
  return { ...DEFAULT_PLANNING_CONFIG, ...partial };
}
