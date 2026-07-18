/**
 * Barrel for `pipeline/upload/` — the upload-phase (CPU → GPU hand-off) modules.
 */

export {
  COLD_STATE_CHURN_LOG_RATE_LIMIT_MS,
  COLD_STATE_CHURN_SUSTAIN_MS,
  COLD_STATE_CHURN_THRESHOLD_PER_SEC,
  COLD_STATE_DURATION_SAMPLES,
  COLD_STATE_WINDOW_MS,
  MAIN_VIEW_UPLOAD_BUDGET_BYTES,
  UPLOAD_BUDGET_EXHAUSTED_STREAK_THRESHOLD,
  UPLOAD_FILTER_RATIO_THRESHOLD,
  UPLOAD_LOG_RATE_LIMIT_MS,
  UPLOAD_LOG_SUSTAIN_MS,
  UPLOAD_RESEND_RATIO_THRESHOLD,
  UPLOAD_SIZE_SAMPLES,
  UPLOAD_WINDOW_MS,
} from "./constants.ts";

export { identityMatrix } from "./coldState/identity.ts";
export { buildDisplayStateByChannel } from "./coldState/displayState.ts";
export {
  buildRoster,
  type BuildRosterResult,
} from "./coldState/roster.ts";
export { buildColdState, buildColdActiveEntry } from "./coldState/build.ts";
export { buildViewHotState } from "./coldState/hotState.ts";

export { computeScissorRect } from "./scissor.ts";

export { WorkerFeedback } from "./delivery/feedback.ts";
export {
  buildManifestByImage,
  manifestEntryKey,
  type ManifestEntry,
} from "./delivery/manifestIndex.ts";
export {
  dispatchChunk,
  dispatchChunkDelivery,
  workerMemberIdForChunk,
  parseWorkerMemberId,
  channelFromChunkKey,
} from "./delivery/dispatch.ts";
export { WorkerResourceTracker } from "./delivery/resources.ts";

export {
  SustainedCondition,
  ConsecutiveTickDetector,
} from "./telemetry/sustained.ts";
export { UploadTelemetry } from "./telemetry/upload.ts";
export { orchTelemetryActive } from "./telemetry/active.ts";
export {
  ColdStateTelemetry,
  type ColdStateCauseKey,
} from "./telemetry/coldState.ts";

export { Uploader } from "./uploader.ts";

export type {
  UploadClient,
  ChunksEvictedHandler,
  WantedSetHandler,
} from "./uploadClient.ts";
