/**
 * Planning tunables. `PlanningConfig` is the single value {@link plan}
 * accepts for policy knobs: planning is pure, so knobs are explicit inputs
 * (see the planning section of `intention.md`).
 *
 * Defaults live in this leaf module (no `./index.ts` import) so the
 * barrel can re-export both the named constants and
 * {@link DEFAULT_PLANNING_CONFIG} without a circular dependency.
 */

/**
 * Minimap lane offset. The top lane, so whole-sample context appears
 * within about 1 s of dataset open. Applies only while the
 * pending seed set is small ({@link MINIMAP_SEED_FAST_MAX_CHUNKS});
 * larger sets emit at {@link MINIMAP_SEED_BULK_LANE_OFFSET}.
 */
export const MINIMAP_LANE_OFFSET = 0;

/**
 * Largest pending minimap seed set (chunks, per dataset) that still
 * rides the top lane. Top placement is only safe while the seed set is
 * small enough to starve the view lanes for a second or two. A wide
 * collection's coarsest chunks would hold every fetch slot for minutes,
 * so above this count the whole set emits at
 * {@link MINIMAP_SEED_BULK_LANE_OFFSET}.
 */
export const MINIMAP_SEED_FAST_MAX_CHUNKS = 128;

/**
 * Priority floor for minimap seeding above
 * {@link MINIMAP_SEED_FAST_MAX_CHUNKS}. The other lane offsets are knobs
 * and may be set past it, so the planner emits bulk seeds at
 * `max(this, highest band already in the plan + 1)`, behind everything the
 * view asked for.
 */
export const MINIMAP_SEED_BULK_LANE_OFFSET = 2600;

/** Priority lane offset for detail requests (visible chunks). */
export const DETAIL_LANE_OFFSET = 500;

/**
 * Priority lane offset for prefetch requests: future timepoints, and the
 * next level in the direction of the last zoom change.
 */
export const PREFETCH_LANE_OFFSET = 1500;

/**
 * Coarse lane offset, the floor under the detail tier. The least urgent
 * of the view lanes, so minimap and detail stay ahead of whole-context
 * fill.
 */
export const COARSE_LANE_OFFSET = 2400;

/**
 * Steps the prefetch lane looks ahead, each one visible target-level set.
 * Every step is a future timepoint until a zoom direction is known; then
 * the next level in that direction takes the last step.
 */
export const PREFETCH_DEPTH = 2;

/**
 * Planes the slice view fetches on each side of the one it draws, so its
 * first steps along Z find their planes resident while the rest of the chunk
 * is still on its way. A move of at most this many planes is a step along Z,
 * after which the slice view fetches the whole chunks its plane lies in; a
 * longer one is a jump, which fetches only the band.
 */
export const SLICE_BAND_PLANES = 2;

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
 * The default must stay exactly `0` so it adds no offset to the focal Z
 * the core scores chunks from (`ChunkView` in `lucida-core/src/chunk.rs`)
 * and ordering matches the unbiased formula byte for byte.
 * `planning.test.ts` pins this.
 */
export const DEPTH_BIAS_VIEW = 0;

/**
 * Per-tick planning tunables threaded through {@link plan}. Lane offsets
 * are whole numbers: a lane's requests take priorities less than one above
 * its offset, so lanes at different offsets never interleave.
 */
export interface PlanningConfig {
  /** See {@link PREFETCH_DEPTH}. */
  prefetchDepth: number;
  /** See {@link SLICE_BAND_PLANES}. */
  sliceBandPlanes: number;

  /** Coefficient on `(1 - importance)` in a request's place within its lane. */
  importanceWeight: number;
  /** Coefficient on chunk distance from the view's focus, within a lane. */
  distanceWeight: number;
  /**
   * Clamped to `[-1, 1]`; the resulting focal Z is clamped to the
   * visible Z range. See {@link DEPTH_BIAS_VIEW}.
   */
  depthBiasView: number;

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

  /** See {@link MINIMAP_LANE_OFFSET}. */
  minimapLaneOffset: number;
  /**
   * See {@link MINIMAP_SEED_FAST_MAX_CHUNKS}. Optional so configs that
   * lack it (older persisted snapshots, external callers) fall back to
   * the module default in `emitMinimapLane` instead of riding the fast
   * lane by omission.
   */
  minimapSeedFastMaxChunks?: number;
  /**
   * See {@link MINIMAP_SEED_BULK_LANE_OFFSET}. Optional for the same
   * reason as {@link minimapSeedFastMaxChunks}.
   */
  minimapSeedBulkLaneOffset?: number;
  /** Detail requests (visible chunks). */
  detailLaneOffset: number;
  /** Prefetch requests: future timepoints and the next level in the zoom direction. */
  prefetchLaneOffset: number;
  /** Coarse requests (lowest urgency of the view lanes). */
  coarseLaneOffset: number;
}

/** Canonical defaults. Sourced from the module-level constants so the two cannot drift. */
export const DEFAULT_PLANNING_CONFIG: PlanningConfig = {
  prefetchDepth: PREFETCH_DEPTH,
  sliceBandPlanes: SLICE_BAND_PLANES,
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
