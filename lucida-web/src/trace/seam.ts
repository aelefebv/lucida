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

import { configStore } from "../pipeline/planning/configStore.ts";
import { bundleServices, exportBundle, type BundleOptions, type TraceBundle } from "./bundle.ts";
import { toChromeTraceJson } from "./chromeTrace.ts";
import { diagnoseDocument } from "./diagnose/diagnose.ts";
import { renderDiagnostic, type RenderDepth } from "./diagnose/renderText.ts";
import type { DiagnosticDocument, WindowRequest } from "./diagnose/types.ts";
import { traceRecorder } from "./recorder.ts";
import type { LiveProgress } from "./liveProgress.ts";
import type { QuiescenceState } from "./quiescence.ts";
import {
  SCRUB_AXES,
  scriptControls,
  viewSignature,
  type ScrubAxis,
  type SelectTarget,
  type StepOutcome,
  type ViewSignature,
} from "./steps.ts";
import { INPUT_SCALE, type InputScale } from "../components/inputScale.ts";
import type { SavedView } from "../savedView/types.ts";
import { TRACE_SCHEMA_VERSION, type GpuIdentity, type TraceDocument } from "./types.ts";

/**
 * What a reading of a trace can be scoped to: one run, and one interval of
 * its clock. Brushing the interval in the monitor and the CLI's window flag
 * both arrive here.
 */
export interface DiagnoseScope {
  /** The run to read. The newest when absent. */
  runId?: string;
  /** The interval of the run to read, in milliseconds from run start. The whole run when absent. */
  window?: WindowRequest;
  /** The chunk the document's lookup is about, as `[entity/]level/t/c/z/y/x`. The worst row's when absent. */
  chunk?: string;
}

/** A scope plus which rendering of it to produce. */
export interface DiagnoseTextScope extends DiagnoseScope {
  depth?: RenderDepth;
  /** Which phase `depth: "phase"` is about. */
  phase?: string;
}

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
   * Whether a labelled run is open right now, and how many have concluded on
   * their own — both readable without exporting, which would close the run
   * being asked about.
   *
   * A driver needs this to read {@link quiescence} honestly. Before a run
   * begins nothing is dirty and nothing is wanted, so the predicate is
   * trivially true; a driver watching only the boolean would call a run that
   * has not started a run that has finished. `lastConcludedRunId` names the
   * run it waited for, so the export that follows reads that run rather than
   * the empty interval the export itself just closed.
   */
  readonly runState: { open: boolean; concluded: number; lastConcludedRunId: string | null };
  /**
   * What the run in progress can say about itself, or null when no run is
   * open (#937): counts of the rows it has made, where the unfinished ones
   * are sitting, and how long it has been going.
   *
   * The only read here that does **not** close the run — which is what makes
   * a live view possible at all. It deliberately carries no verdict: the
   * attribution back-walk needs an end to walk back from, and a headline that
   * changes while you read it is not a headline. Poll it, then read
   * {@link diagnose} for the run named in `runId` once it closes.
   */
  progress(): LiveProgress | null;
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
   * The bundle (#1055): the trace document, the diagnostic with every text
   * rendering, the settled frame, the view URL, the planning configuration,
   * the pins, the server's dataset health counters, and a header sufficient
   * to replay the run. The monitor's **Save bundle** and `lucida trace
   * --bundle` are two callers of this one function, so the file a person
   * saves and the file the driver writes are the same artifact.
   *
   * Asynchronous because the health is a socket round trip and the frame is
   * read off the render worker's canvas. Closes the run in progress, exactly
   * as {@link exportTrace} does: it is the same export with more around it.
   * The Perfetto projection is included only when `perfetto` is set.
   */
  exportBundle(options?: BundleOptions): Promise<TraceBundle>;
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
   *
   * `window` scopes the reading to an interval of the run's clock: the phase
   * rollup, the findings and the critical path are then of that interval, and
   * the document's header says so. `chunk` names the chunk the document's
   * lookup is about, as `[entity/]level/t/c/z/y/x`; left out, the lookup is
   * the worst row's.
   */
  diagnose(runId?: string, scope?: Omit<DiagnoseScope, "runId">): DiagnosticDocument;
  /**
   * The same diagnostic rendered as the default text. One renderer, so every
   * number in the text exists in {@link diagnose}'s output — a caller drops to
   * the JSON for the fields the text selected against, never for a different
   * answer.
   *
   * `depth` selects the rendering, not a different derivation: a driver that
   * has to archive a deeper depth reads it here rather than growing a second
   * renderer outside the page, where it would drift. `depth: "phase"` takes
   * the phase id in `phase`; `depth: "chunk"` renders the lookup for `chunk`,
   * or for the worst row when none is named; `depth: "spatial"` renders what
   * is where. `window` and `chunk` scope the reading as they do on
   * {@link diagnose}.
   */
  diagnoseText(runId?: string, options?: Omit<DiagnoseTextScope, "runId">): string;
  /**
   * The derivation over a trace document handed in, rather than over the
   * page's own recording. For a run file read back after the browser that
   * recorded it is gone: the file carries the whole-run reading and no
   * other, and a window cannot be rendered at export because there is no
   * finite set of them. `lucida trace show --window` opens a page and calls
   * this, so the CLI stays free of the derivation it would otherwise have to
   * restate.
   *
   * Reads nothing from and closes nothing in the recorder: the document is
   * the caller's.
   */
  diagnoseTrace(document: TraceDocument, scope?: DiagnoseScope): DiagnosticDocument;
  /** {@link diagnoseTrace} rendered as text, at any depth {@link diagnoseText} renders. */
  diagnoseTraceText(document: TraceDocument, options?: DiagnoseTextScope): string;
  /**
   * The view as the page would save it: camera, selectors, and every
   * dataset's display settings. Null before a scene exists. The trace driver
   * reads this before and after each scripted step and records both, so a
   * step that did not land is a fact in the run rather than a silence.
   */
  view(): SavedView | null;
  /**
   * The part of {@link view} a scripted step is judged by: camera without
   * its viewport, selectors, and what is shown. The driver compares the
   * signature before and after a step to say whether the view changed, so
   * the page and not the driver decides what counts, and a contrast refit
   * during a hold is not a change of view.
   */
  viewSignature(): ViewSignature | null;
  /**
   * How far a drag or a wheel event moves the view, as the viewers apply
   * it. The driver turns a scripted angle or factor into pixels and deltas
   * with these, so a scripted orbit is the drag a person would make.
   */
  readonly inputScale: Readonly<InputScale>;
  /**
   * A scripted scrub: move the `z`, `t`, or `c` selector by `count`
   * positions, through the handler the dimension control calls. A script's
   * pan, zoom, and orbit reach the page as synthesized pointer events and
   * need no such entry, but the capture surface hides the selectors, so a
   * scrub has nothing to click. The recorder hears the input at the control,
   * as it does for a person's. Refuses what the control would refuse, and
   * says why.
   */
  scrub(axis: ScrubAxis, count: number): StepOutcome;
  /**
   * A scripted select: show or hide a channel of the dataset in hand or a
   * layer by dataset id, through the handler the layer panel calls. Shows
   * unless `visible` is false. The layer panel is hidden on the capture
   * surface, which is why this entry exists beside {@link scrub}.
   */
  select(target: SelectTarget, visible?: boolean): StepOutcome;
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
  const diagnoseTrace = (document: TraceDocument, scope?: DiagnoseScope): DiagnosticDocument =>
    diagnoseDocument(document, { runId: scope?.runId, window: scope?.window, chunk: scope?.chunk });
  const diagnoseTraceText = (document: TraceDocument, options?: DiagnoseTextScope): string =>
    renderDiagnostic(diagnoseTrace(document, options), {
      depth: options?.depth,
      phase: options?.phase,
    }).text;
  const seam: LucidaTraceSeam = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    get quiescence() {
      return traceRecorder.quiescence;
    },
    get quiescenceHoldMs() {
      return traceRecorder.holdMs;
    },
    get runState() {
      const concluded = traceRecorder.concludedRuns;
      return {
        open: traceRecorder.isRunOpen,
        concluded: concluded.count,
        lastConcludedRunId: concluded.lastId,
      };
    },
    progress: () => traceRecorder.liveProgress,
    exportTrace: () => traceRecorder.exportDocument(),
    exportChromeTrace: () => toChromeTraceJson(traceRecorder.exportDocument()),
    exportBundle: (options?: BundleOptions) =>
      exportBundle(
        {
          exportTrace: () => traceRecorder.exportDocument(),
          services: bundleServices(),
          planning: configStore.get(),
          origin: target.location?.origin ?? null,
          devicePixelRatio: target.devicePixelRatio ?? null,
          now: Date.now(),
        },
        options,
      ),
    diagnose: (runId?: string, scope?: Omit<DiagnoseScope, "runId">) =>
      diagnoseTrace(traceRecorder.exportDocument(), { ...scope, runId }),
    diagnoseText: (runId?: string, options?: Omit<DiagnoseTextScope, "runId">) =>
      diagnoseTraceText(traceRecorder.exportDocument(), { ...options, runId }),
    diagnoseTrace,
    diagnoseTraceText,
    view: () => scriptControls()?.view() ?? null,
    viewSignature: () => viewSignature(scriptControls()?.view() ?? null),
    inputScale: INPUT_SCALE,
    scrub: (axis: ScrubAxis, count: number) => {
      const controls = scriptControls();
      if (!controls) return noControls();
      if (!SCRUB_AXES.includes(axis)) return refused(`no selector is called ${String(axis)}`);
      return controls.scrub(axis, count);
    },
    select: (target: SelectTarget, visible: boolean = true) => {
      const controls = scriptControls();
      if (!controls) return noControls();
      const named = target as Partial<{ channel: unknown; layer: unknown }> | null;
      if (named && typeof named.channel === "number") {
        if (!Number.isInteger(named.channel) || named.channel < 0) {
          return refused(`a channel is a whole number from 0, not ${named.channel}`);
        }
        return controls.select({ channel: named.channel }, visible === true);
      }
      if (named && typeof named.layer === "string" && named.layer !== "") {
        return controls.select({ layer: named.layer }, visible === true);
      }
      return refused("a select names a channel index or a layer id");
    },
    closeRun: (endReason: "explicit" | "timeout" = "explicit") =>
      traceRecorder.closeRun(endReason),
  };
  target.lucidaTrace = seam;
  return seam;
}

function refused(reason: string): StepOutcome {
  return { applied: false, reason };
}

function noControls(): StepOutcome {
  return refused("no viewer has registered its controls on this page");
}

/**
 * Record the adapter the page is running against, so two runs on different
 * hardware are visibly not comparable. Asking for an adapter does not create
 * a device and does not disturb the renderer's own.
 *
 * The render worker asks for the same default adapter, so what this reports
 * about fallback status and timestamp queries is what the worker's device
 * has: the worker enables timestamp queries exactly when the adapter offers
 * them, and records a GPU pass time per frame only then.
 */
export async function resolveGpuIdentity(): Promise<GpuIdentity | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    const info = adapter?.info;
    if (!adapter || !info) return null;
    return {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      fallback: isFallbackAdapter(adapter),
      timestampQueries: adapter.features.has("timestamp-query"),
    };
  } catch {
    return null;
  }
}

/**
 * `isFallbackAdapter` moved from the adapter to its info record. Read
 * whichever the browser has, and answer null rather than hardware when it
 * has neither.
 */
function isFallbackAdapter(adapter: GPUAdapter): boolean | null {
  const onInfo = (adapter.info as { isFallbackAdapter?: boolean }).isFallbackAdapter;
  if (typeof onInfo === "boolean") return onInfo;
  const onAdapter = (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter;
  return typeof onAdapter === "boolean" ? onAdapter : null;
}
