/**
 * Gate for the orchestration telemetry aggregators — the upload rolling
 * window ({@link UploadTelemetry}) and the cold-state rebuild window
 * ({@link ColdStateTelemetry}), including their sustained-anomaly
 * detectors.
 *
 * These aggregators have exactly one consumer left: the `orch` debug-log
 * category, which the detectors emit through. The debug panel was the other,
 * fed through `debugStats` while it was open — that gate is gone with the
 * unconditional recorder (ADR 0049), and the gauges went with it, because the
 * trace already carries the per-tick aggregates on a path that allocates
 * nothing.
 *
 * When the log category is off there is no one to see the output, so the
 * per-tick ring-buffer/window bookkeeping is skipped at the call sites
 * (Uploader.deliverToWorker, TickCoordinator.planAndFetch). The telemetry
 * classes themselves stay unconditional and pure — gating lives with the
 * callers.
 */

import { isDebugEnabled } from "../../../debug/logging.ts";

export function orchTelemetryActive(): boolean {
  return isDebugEnabled("orch");
}
