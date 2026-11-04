/**
 * Gate for the orchestration telemetry aggregators ({@link UploadTelemetry},
 * {@link ColdStateTelemetry}) and their sustained-anomaly detectors. Their
 * only consumer is the `orch` debug-log category, so when it is off the call
 * sites skip the per-tick bookkeeping. The telemetry classes stay
 * unconditional; gating lives with the callers.
 */

import { isDebugEnabled } from "../../../debug/logging.ts";

export function orchTelemetryActive(): boolean {
  return isDebugEnabled("orch");
}
