/**
 * The trace seam: the page-level export function every reader goes through
 * (ADR 0051).
 *
 * `lucida trace`, an agent driving its own browser, and the monitor's save
 * button are three callers of one function, so no surface gets a privately
 * shaped copy. It is **public interface in every build** — the existing dev
 * globals are `import.meta.env.DEV`-gated and therefore invisible to a
 * driver running against a real bundle, and a diagnostic that only exists in
 * development cannot explain a field report.
 *
 * Treat this object like a wire type: versioned, and not reshaped casually.
 *
 * ```js
 * // From a console, or over CDP against a production page:
 * const doc = window.lucidaTrace.exportTrace();
 * window.lucidaTrace.quiescence.quiescent;  // has the page settled?
 * ```
 */

import { toChromeTraceJson } from "./chromeTrace.ts";
import { diagnoseDocument } from "./diagnose/diagnose.ts";
import { renderDiagnostic, type RenderDepth } from "./diagnose/renderText.ts";
import type { DiagnosticDocument } from "./diagnose/types.ts";
import { traceRecorder } from "./recorder.ts";
import type { QuiescenceState } from "./quiescence.ts";
import { TRACE_SCHEMA_VERSION, type GpuIdentity, type TraceDocument } from "./types.ts";

export interface LucidaTraceSeam {
  /** The document's schema version, readable without exporting one. */
  readonly schemaVersion: number;
  /**
   * The page's published quiescence, refreshed by the render loop. Null
   * before the first publication. A driver polls this and waits for
   * `quiescent` to hold; it never infers settling from the outside, because
   * a stalled pipeline and a finished one both stop drawing.
   */
  readonly quiescence: QuiescenceState | null;
  /**
   * How long `quiescent` must hold before the run closes itself (ADR 0051).
   * A driver that exports the moment the boolean first goes true closes the
   * run as `explicit` instead, losing the one field that says the page
   * settled — so the wait belongs to whoever polls, and this is the number
   * they have to wait.
   */
  readonly quiescenceHoldMs: number;
  /**
   * The merged trace document. Closes the run in progress as `explicit`:
   * every run carries an end reason, and asking for the document concludes
   * the interval being asked about.
   */
  exportTrace(): TraceDocument;
  /**
   * The same document projected into Chrome Trace Event JSON, ready to open
   * in Perfetto (#934). A string rather than an object: every caller writes
   * it to a file or a blob, and handing a driver a 13,000-slice object graph
   * to re-serialise over CDP would cost more than the projection.
   *
   * Closes the run in progress, exactly as {@link exportTrace} does — it is
   * the same export, in the other format.
   */
  exportChromeTrace(): string;
  /**
   * The trace read as a diagnostic (#933): thresholds, the attribution
   * back-walk, the coverage block and the verdict. Defaults to the newest run.
   *
   * The derivation lives behind the seam because both surfaces read it — the
   * monitor's cards and the agent's text render from this one object, so they
   * cannot disagree — and because a CLI that computed its own verdict would
   * make the second entry point a second-class citizen.
   *
   * Closes the run in progress, exactly as {@link exportTrace} does: asking
   * what a run means concludes the interval being asked about.
   */
  diagnose(runId?: string): DiagnosticDocument;
  /**
   * The same diagnostic rendered as the default text. One renderer, so every
   * number in the text exists in {@link diagnose}'s output — a caller drops to
   * the JSON for the fields the text selected against, never for a different
   * answer.
   *
   * `depth` selects the rendering, not a different derivation: a driver that
   * has to archive the deeper depth reads it here rather than growing a second
   * renderer outside the page, where it would drift.
   */
  diagnoseText(runId?: string, options?: { depth?: RenderDepth }): string;
  /**
   * Close the run in progress without exporting — the *Stop & analyse* path.
   *
   * A driver that gave up on a run that never settled passes `"timeout"`:
   * every run carries an end reason, and `explicit` would claim the run was
   * concluded by somebody asking for it rather than by running out of time.
   */
  closeRun(endReason?: "explicit" | "timeout"): void;
}

declare global {
  interface Window {
    lucidaTrace?: LucidaTraceSeam;
  }
}

/**
 * Install the seam. Unconditional, in every build: recording is
 * unconditional already, and an unread seam costs nothing.
 */
export function installTraceSeam(target: Window = window): LucidaTraceSeam {
  const seam: LucidaTraceSeam = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    get quiescence() {
      return traceRecorder.quiescence;
    },
    get quiescenceHoldMs() {
      return traceRecorder.holdMs;
    },
    exportTrace: () => traceRecorder.exportDocument(),
    exportChromeTrace: () => toChromeTraceJson(traceRecorder.exportDocument()),
    diagnose: (runId?: string) => diagnoseDocument(traceRecorder.exportDocument(), { runId }),
    diagnoseText: (runId?: string, options?: { depth?: RenderDepth }) =>
      renderDiagnostic(diagnoseDocument(traceRecorder.exportDocument(), { runId }), {
        depth: options?.depth,
      }).text,
    closeRun: (endReason: "explicit" | "timeout" = "explicit") =>
      traceRecorder.closeRun(endReason),
  };
  target.lucidaTrace = seam;
  return seam;
}

/**
 * Record the adapter the page is running against, so two runs on different
 * hardware are visibly not comparable. Asking for an adapter does not create
 * a device and does not disturb the renderer's own.
 */
export async function resolveGpuIdentity(): Promise<GpuIdentity | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    const info = adapter?.info;
    if (!info) return null;
    return {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    };
  } catch {
    return null;
  }
}
