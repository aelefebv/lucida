/**
 * Scene-state epoch counters.
 *
 * Each field is bumped when a particular slice of scene state changes; the
 * orchestrator and downstream consumers (planning, renderer) read these
 * counters to detect what has changed since their last view of the world.
 *
 * Of the six fields only `request` is planning-specific (bumped by
 * {@link plan} each tick); the rest track scene-state changes that
 * planning consumes but does not own. See ADR 0028 for the rename
 * rationale (formerly `PlanningEpochs` in `pipeline/planning/index.ts`).
 */
export interface SceneEpochs {
  content: number;
  layout: number;
  view: number;
  selection: number;
  /**
   * Bumped by `apply_asset_catalog_delta` (catalog membership change).
   * The orchestrator reads it from `wasmScene.asset_epoch()` each tick.
   */
  asset: number;
  /** Bumped when Planning produces a new request plan. */
  request: number;
}
