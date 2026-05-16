/**
 * Upload-phase constants.
 *
 * Two families live here:
 *
 * 1. Per-frame upload budget (`MAIN_VIEW_UPLOAD_BUDGET_BYTES`) — the
 *    soft cap on bytes the orchestrator hands the worker each tick for
 *    the main view (slice + volume). The minimap path uses a separate,
 *    smaller budget that stays in `renderLoopTypes.ts`.
 *
 * 2. Telemetry windows / thresholds for both the cold-state rebuild
 *    detector and the upload anomaly detectors. Lifted out of
 *    `orchestrator.ts` so the per-pass telemetry modules (extracted in
 *    later slices of PRD #607) own their tuning knobs.
 */

// ---------------------------------------------------------------------------
// Per-frame upload budgets
// ---------------------------------------------------------------------------

/** Per-frame upload budget for the main view (slice + volume). */
export const MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 * 1024 * 1024; // 8 MB per frame

// ---------------------------------------------------------------------------
// Cold-state rebuild telemetry constants
// ---------------------------------------------------------------------------
//
// `planAndFetch` either takes the epoch fast-path (cache hit) or runs a full
// rebuild. We track both paths so the panel can show hit rate, rebuild rate,
// per-epoch cause attribution, and timing — and so we can flag pathological
// non-view churn.

/** Rolling-window size for hit/rebuild rates and cause attribution. */
export const COLD_STATE_WINDOW_MS = 1000;

/** Bounded sample buffer for p50/p95 rebuild duration. */
export const COLD_STATE_DURATION_SAMPLES = 60;

/**
 * Threshold above which sustained non-view rebuild churn is considered
 * pathological. View-epoch churn is expected during camera motion;
 * other epochs (selection, content, layout, asset) bumping at >30/s is
 * almost always a bug.
 */
export const COLD_STATE_CHURN_THRESHOLD_PER_SEC = 30;

/** How long the rate must stay above threshold before a log fires. */
export const COLD_STATE_CHURN_SUSTAIN_MS = 2000;

/** Don't re-log churn more often than this. */
export const COLD_STATE_CHURN_LOG_RATE_LIMIT_MS = 2000;

// ---------------------------------------------------------------------------
// Upload (CPU → GPU hand-off) telemetry constants
// ---------------------------------------------------------------------------

/** Rolling window for bytes/sec, uploads/sec, ratios, exhausted-tick count. */
export const UPLOAD_WINDOW_MS = 1000;

/** Bounded sample buffer for p50/p95 upload byte size. */
export const UPLOAD_SIZE_SAMPLES = 120;

/** Consecutive ticks of `budgetExhausted=true` before logging. */
export const UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD = 3;

/** Resend ratio above which `upload.resend_storm` arms (atlas thrashing). */
export const UPLOAD_RESEND_RATIO_THRESHOLD = 0.5;

/** Filter ratio above which `upload.drain_waste` arms (decoded chunks unwanted). */
export const UPLOAD_FILTER_RATIO_THRESHOLD = 0.5;

/**
 * Sustain duration for resend_storm and drain_waste before a log fires.
 * Mirrors the cold-state churn pattern — short bursts during transitions
 * (e.g. zoom transitions) are normal and shouldn't spam the console.
 */
export const UPLOAD_LOG_SUSTAIN_MS = 2000;

/** Don't re-log the same condition more often than this. */
export const UPLOAD_LOG_RATE_LIMIT_MS = 2000;
