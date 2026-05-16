/**
 * Barrel for `pipeline/upload/` — the upload-phase (CPU → GPU hand-off) modules.
 * Populated incrementally across PRD #607's slices.
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

export {
  proxyKeyFromDelivery,
  proxyKeyFromMissing,
  proxyKeyFromRequest,
} from "./proxyKeys.ts";

export { identityMatrix } from "./coldState/identity.ts";
export { buildDisplayStateByChannel } from "./coldState/displayState.ts";
export {
  buildRoster,
  synthesizeWellRosterEntry,
  type BuildRosterResult,
} from "./coldState/roster.ts";
export { buildColdState, buildColdActiveEntry } from "./coldState/build.ts";
export { buildViewHotState } from "./coldState/hotState.ts";

export { computeScissorRect } from "./scissor.ts";

export { DeliveryTracker } from "./delivery/tracker.ts";
export { WorkerFeedback } from "./delivery/feedback.ts";
export {
  buildManifestByImage,
  type ManifestEntry,
} from "./delivery/manifestIndex.ts";
export { dispatchChunk, dispatchProxy } from "./delivery/dispatch.ts";
export {
  classifyDelivery,
  runDrainPass,
  type FilterVerdict,
  type RunDrainPassArgs,
  type RunPassResult,
} from "./delivery/drain.ts";
export {
  classifyChunkResend,
  classifyProxyResend,
  runChunkResendPass,
  runProxyResendPass,
  type ResendVerdict,
  type RunChunkResendPassArgs,
  type RunProxyResendPassArgs,
} from "./delivery/resend.ts";

// Telemetry collaborators (Slice 9 of PRD #607). See `Orchestrator` for
// wiring; consumers outside the orchestrator don't typically need these
// directly, but the barrel re-exports them so the upload package has a
// single import surface.
export {
  SustainedCondition,
  ConsecutiveTickDetector,
} from "./telemetry/sustained.ts";
export { UploadTelemetry } from "./telemetry/upload.ts";
export {
  ColdStateTelemetry,
  type ColdStateCauseKey,
} from "./telemetry/coldState.ts";

// Uploader (Slice 10 of PRD #607). Owns the upload-phase concerns the
// pre-refactor Orchestrator god-class also carried alongside planning;
// see `uploader.ts` JSDoc for the planner → uploader seam.
export { Uploader } from "./uploader.ts";
