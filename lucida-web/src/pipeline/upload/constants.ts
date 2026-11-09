/**
 * Upload-phase constants: per-frame upload budget + telemetry tuning
 * (windows, thresholds) for the cold-state rebuild and upload detectors.
 */

/** Per-frame upload budget for the main view (slice + volume). */
export const MAIN_VIEW_UPLOAD_BUDGET_BYTES = 8 * 1024 * 1024; // 8 MB per frame

/**
 * Per-frame upload budget for chunks held back while the view moved, once it
 * holds still. The frames these uploads delay answer no input, and the held
 * chunks are what the stopped view waits for.
 */
export const HELD_UPLOAD_BUDGET_BYTES = 32 * 1024 * 1024;

// Cold-state rebuild telemetry
/** Rolling-window size for hit/rebuild rates and cause attribution. */
export const COLD_STATE_WINDOW_MS = 1000;

/** Bounded sample buffer for p50/p95 rebuild duration. */
export const COLD_STATE_DURATION_SAMPLES = 60;

/**
 * View-epoch churn is expected during camera motion; selection / content /
 * layout bumping at >30/s is almost always a bug.
 */
export const COLD_STATE_CHURN_THRESHOLD_PER_SEC = 30;

export const COLD_STATE_CHURN_SUSTAIN_MS = 2000;

export const COLD_STATE_CHURN_LOG_RATE_LIMIT_MS = 2000;

// Upload (CPU → GPU hand-off) telemetry
/** Rolling window for bytes/sec, uploads/sec, ratios, exhausted-tick count. */
export const UPLOAD_WINDOW_MS = 1000;

/** Bounded sample buffer for p50/p95 upload byte size. */
export const UPLOAD_SIZE_SAMPLES = 120;

/** Consecutive ticks of `budgetExhausted=true` before logging. */
export const UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD = 3;

/** Filter ratio above which `upload.drain_waste` arms (decoded chunks unwanted). */
export const UPLOAD_FILTER_RATIO_THRESHOLD = 0.5;

/** Short bursts during transitions are normal; require sustain before logging. */
export const UPLOAD_LOG_SUSTAIN_MS = 2000;

export const UPLOAD_LOG_RATE_LIMIT_MS = 2000;
