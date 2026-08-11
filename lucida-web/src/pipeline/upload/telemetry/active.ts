/**
 * Gate for the orchestration telemetry aggregators — the upload rolling
 * window ({@link UploadTelemetry}) and the cold-state rebuild window
 * ({@link ColdStateTelemetry}), including their sustained-anomaly detectors.
 *
 * The `orch` debug-log category is their only consumer: the detectors emit
 * through it. When it is off nobody sees the output, so the per-tick
 * ring-buffer bookkeeping is skipped at the call sites
 * (Uploader.deliverToWorker, TickCoordinator.planAndFetch) — the telemetry
 * classes themselves stay unconditional and pure, and gating lives with the
 * callers. Named rather than inlined because "who can still see this?" is the
 * question both call sites are asking.
 */

import { isDebugEnabled } from "../../../debug/logging.ts";

export function orchTelemetryActive(): boolean {
  return isDebugEnabled("orch");
}
