/**
 * Upload-phase constants: how much upload work the render worker may have
 * in hand, how its write rate is learned, and telemetry tuning (windows,
 * thresholds) for the cold-state rebuild and upload detectors.
 */

/**
 * The upload work handed to the render worker and not yet done, on the
 * worker and on the GPU, that a gesture allows. A gesture's frame goes to the
 * worker ahead of its tick's uploads (`viewTick.ts`), and this keeps them
 * done before the next one, so uploads go on through a gesture without
 * costing it a frame.
 */
export const GESTURE_UPLOAD_AHEAD_MS = 4;

/**
 * The upload work handed to the render worker and not yet done when no input
 * waits on a frame: a view opening, switching mode or filling in once it
 * stops. Two frames at 60 Hz, so a fill keeps the worker and the GPU busy
 * through a full-quality frame, which holds back the report of every upload
 * behind it. The first input that lands meanwhile waits behind no more.
 */
export const UPLOAD_AHEAD_MS = 32;

/** The write rate assumed until the worker reports one: below a workstation GPU's, so a slow device is not flooded first. */
export const INITIAL_UPLOAD_BYTES_PER_MS = 1024 * 1024;

/**
 * How much measured write time halves an earlier report's weight in the
 * write rate: a couple of ticks' uploads, so the rate follows a device that
 * slows under load within a few frames.
 */
export const UPLOAD_COST_HALF_LIFE_MS = 20;

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
