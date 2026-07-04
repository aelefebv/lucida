/**
 * Gate for the orchestration telemetry aggregators — the upload rolling
 * window ({@link UploadTelemetry}) and the cold-state rebuild window
 * ({@link ColdStateTelemetry}), including their sustained-anomaly
 * detectors.
 *
 * These aggregators have exactly two consumers:
 *   1. the DebugPanel, fed through `debugStats` while the panel is open
 *      (`debugStats.enabled`), and
 *   2. the `orch` debug-log category, which the detectors emit through.
 *
 * When neither consumer is on there is no one to see the output, so the
 * per-tick ring-buffer/window bookkeeping is skipped at the call sites
 * (Uploader.deliverToWorker, TickCoordinator.planAndFetch). The
 * telemetry classes themselves stay unconditional and pure — gating
 * lives with the callers, matching the existing `debugStats.enabled`
 * call-site discipline.
 */

import { debugStats } from "../../../debug/debugStats.ts";
import { isDebugEnabled } from "../../../debug/logging.ts";

export function orchTelemetryActive(): boolean {
  return debugStats.enabled || isDebugEnabled("orch");
}
