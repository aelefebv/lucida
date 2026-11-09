/**
 * The trace seam: the page-level export function every reader goes through.
 * `lucida trace`, an agent driving its own browser, and the
 * monitor's save button all call it, so no surface gets a privately shaped
 * copy.
 *
 * Installed in every build, because a diagnostic that only exists in
 * development cannot explain a field report. Treat this object like a wire
 * type: versioned, and not reshaped casually.
 */

import { readDeviceMemoryGiB } from "../deviceBudget.ts";
import { configStore } from "../pipeline/planning/configStore.ts";
import { bundleServices, exportBundle, type BundleOptions, type TraceBundle } from "./bundle.ts";
import { toChromeTraceJson } from "./chromeTrace.ts";
import { compareTraces, renderComparison, type CompareSide, type RunComparison } from "./diagnose/compare.ts";
import { diagnoseDocument } from "./diagnose/diagnose.ts";
import { decodePngOnPage, pageDecodesPng, readFrame } from "./flatFrame.ts";
import { readPageScroll } from "./pageScroll.ts";
import {
  renderProvisional,
  type ProvisionalOptions,
  type ProvisionalReading,
} from "./diagnose/provisional.ts";
import { renderDiagnostic, renderLiveTimeline, type RenderDepth } from "./diagnose/renderText.ts";
import type { LiveTimeline, LiveTimelineOptions } from "./diagnose/timeline.ts";
import type { DiagnosticDocument, WindowRequest } from "./diagnose/types.ts";
import { traceRecorder } from "./recorder.ts";
import type { LiveProgress } from "./liveProgress.ts";
import type { SettleState } from "../pipeline/settle.ts";
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
import { requestAdapterWithRetry, type AdapterRetry } from "../renderer/requestAdapter.ts";
import type { SavedView } from "../savedView/types.ts";
import {
  TRACE_SCHEMA_VERSION,
  type FrameReading,
  type GpuIdentity,
  type PageScrollReading,
  type TraceDocument,
} from "./types.ts";

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
  readonly quiescence: SettleState | null;
  /**
   * How long `quiescent` must hold before the run closes itself. A driver
   * that exports the moment the boolean first goes true closes the run as
   * `explicit` instead, losing the one field that says the page settled, so
   * the wait belongs to whoever polls, and this is how long to wait.
   */
  readonly quiescenceHoldMs: number;
  /**
   * How long a run may stay open before it closes as `timeout`, in
   * milliseconds: sixty seconds unless a driver sets it. `lucida trace` sets
   * it from `--timeout-seconds` as soon as the seam appears, and a run
   * already open is held to it from when it opened. A view that settles or
   * stalls closes its run sooner.
   */
  runTimeoutMs: number;
  /**
   * Whether a labelled run is open right now, and how many have concluded on
   * their own. Both are readable without exporting, which would close the
   * run being asked about.
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
   * open: counts of the rows it has made, where the unfinished ones are
   * sitting, and how long it has been going.
   *
   * Like {@link provisional}, it does not close the run. It carries no
   * verdict: the attribution back-walk needs an end to walk back from. Poll
   * it, then read {@link diagnose} for the run named in `runId` once it
   * closes.
   */
  progress(): LiveProgress | null;
  /**
   * A provisional reading over a trailing window of the run in progress, or
   * null when no run is open: the phase occupancy this instant, the top
   * finding over the window, and the page's quiescence reason, with the
   * window it read and the rows it did not see. Labelled provisional in the
   * document and in every rendering, because it changes while you read it.
   * It carries no `verdict` field; a gate reads only the verdict of a closed
   * run.
   *
   * Does not close the run, and walks no row, so a session that never
   * quiesces can be polled at the tick cadence without being perturbed.
   * `windowMs` sets how far back it looks; the default is five seconds.
   */
  provisional(options?: ProvisionalOptions): ProvisionalReading | null;
  /** {@link provisional} rendered as text, or null when no run is open. */
  provisionalText(options?: ProvisionalOptions): string | null;
  /**
   * The dock's live charts over a trailing window of the run in progress,
   * as fields, or null when no run is open: the closed set of timeline
   * charts binned over the window, drawn from the per-tick tiers alone.
   * The charts read from the rows are absent here and say when they are
   * read. Labelled provisional like {@link provisional}, for the same
   * reason, and closing nothing. `windowMs` sets how far back it looks; the
   * default is thirty seconds.
   *
   * The closed run's timeline is the `timeline` section of {@link diagnose},
   * over the same closed set, with the row-derived charts filled in.
   */
  liveTimeline(options?: LiveTimelineOptions): LiveTimeline | null;
  /** {@link liveTimeline} rendered as text, one line per chart, or null when no run is open. */
  liveTimelineText(options?: LiveTimelineOptions): string | null;
  /**
   * The merged trace document. Closes the run in progress as `explicit`:
   * every run carries an end reason, and asking for the document concludes
   * the interval being asked about.
   */
  exportTrace(): TraceDocument;
  /**
   * The same document projected into Chrome Trace Event JSON, ready to open
   * in Perfetto. A string rather than an object: every caller writes it to
   * a file or a blob, and handing a driver a 13,000-slice object graph to
   * re-serialise over CDP would cost more than the projection.
   *
   * Closes the run in progress, exactly as {@link exportTrace} does.
   */
  exportChromeTrace(): string;
  /**
   * The bundle: the trace document, the diagnostic with every text
   * rendering, the settled frame, the view URL, the planning configuration,
   * the pins, the server's dataset health counters, and a header sufficient
   * to replay the run. The monitor's **Save bundle** and `lucida trace
   * --bundle` are two callers of this one function, so the file a person
   * saves and the file the driver writes are the same artifact.
   *
   * Asynchronous because the health is a socket round trip and the frame is
   * read off the render worker's canvas. A driver that took its own
   * screenshot passes it as `fallbackFrame`, and the page carries it only
   * when that read fails. Closes the run in progress, exactly as
   * {@link exportTrace} does: it is the same export with more around it.
   * The Perfetto projection is included only when `perfetto` is set.
   */
  exportBundle(options?: BundleOptions): Promise<TraceBundle>;
  /**
   * Read the frame on the canvas through the page's own capture and record
   * it on run `runId`, the newest concluded run when absent, where the
   * diagnostic reads it: a frame of one flat colour is a finding. A driver
   * calls this once the run it waited for has closed, before it exports, so
   * the frame is the one the run settled on. Closes nothing.
   */
  readFrame(runId?: string): Promise<FrameReading>;
  /**
   * Read where the page is scrolled and how far it could scroll, and record
   * it on run `runId`, the newest concluded run when absent, where the
   * diagnostic reads it: a page that scrolled or overflows its viewport is a
   * finding. A driver calls this beside {@link readFrame}. Closes nothing.
   */
  readPageScroll(runId?: string): PageScrollReading;
  /**
   * The trace read as a diagnostic: thresholds, the attribution back-walk,
   * the coverage block and the verdict. Defaults to the newest run.
   *
   * The derivation lives behind the seam so the monitor's cards and the
   * agent's text render from this one object and cannot disagree.
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
   * number in the text exists in {@link diagnose}'s output. A caller drops to
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
   * Two runs compared: header differences with a warning when they
   * make the runs incomparable, phase deltas, and finding deltas, every
   * delta right minus left. The subtraction lives here, behind the seam, so
   * `lucida trace diff` and any viewer surface that sets two runs side by
   * side print the same deltas. Each side is a trace document handed in, as
   * {@link diagnoseTrace} takes one, with what the caller knows about the
   * conditions the document does not record: the planning configuration and
   * the CPU cache knobs the run ran under.
   *
   * Reads nothing from and closes nothing in the recorder.
   */
  compareTraces(left: CompareSide, right: CompareSide): RunComparison;
  /** {@link compareTraces} rendered as text. */
  compareTracesText(left: CompareSide, right: CompareSide): string;
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
   * A scripted contrast: set the window of a channel of the dataset in hand
   * through the handler the layer panel's limits call, which stops
   * auto-contrast for the dataset as a hand-set limit does. The layer panel
   * is hidden on the capture surface, as for {@link select}.
   */
  contrast(channel: number, min: number, max: number): StepOutcome;
  /**
   * A scripted add: open a dataset in this workspace by source URL through
   * the handler the add-data dialog calls, which the capture surface does
   * not mount. Answers once the dataset has opened or failed to, or after
   * `timeoutMs`, sixty seconds unless given.
   */
  addDataset(url: string, timeoutMs?: number): Promise<StepOutcome>;
  /**
   * A scripted remove: take the dataset opened from a source URL out of this
   * workspace through the handler the layer panel's remove calls once a
   * person has confirmed it.
   */
  removeDataset(url: string): Promise<StepOutcome>;
  /**
   * Close the run in progress without exporting: the *Stop & analyse* path.
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
    get runTimeoutMs() {
      return traceRecorder.runTimeoutMs;
    },
    set runTimeoutMs(ms: number) {
      traceRecorder.setRunTimeout(ms);
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
    provisional: (options?: ProvisionalOptions) => traceRecorder.provisionalReading(options),
    provisionalText: (options?: ProvisionalOptions) => {
      const reading = traceRecorder.provisionalReading(options);
      return reading ? renderProvisional(reading) : null;
    },
    liveTimeline: (options?: LiveTimelineOptions) => traceRecorder.liveTimeline(options),
    liveTimelineText: (options?: LiveTimelineOptions) => {
      const live = traceRecorder.liveTimeline(options);
      return live ? renderLiveTimeline(live) : null;
    },
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
          deviceMemoryGib: readDeviceMemoryGiB(),
          decodePng: pageDecodesPng() ? decodePngOnPage : null,
          now: Date.now(),
        },
        options,
      ),
    readFrame: async (runId?: string) => {
      const services = bundleServices();
      const reading = await readFrame(
        services ? () => services.captureFrame() : null,
        pageDecodesPng() ? decodePngOnPage : null,
      );
      const run = runId ?? traceRecorder.concludedRuns.lastId;
      if (run) traceRecorder.noteFrame(run, reading);
      return reading;
    },
    readPageScroll: (runId?: string) => {
      const reading = readPageScroll();
      const run = runId ?? traceRecorder.concludedRuns.lastId;
      if (run) traceRecorder.notePageScroll(run, reading);
      return reading;
    },
    diagnose: (runId?: string, scope?: Omit<DiagnoseScope, "runId">) =>
      diagnoseTrace(traceRecorder.exportDocument(), { ...scope, runId }),
    diagnoseText: (runId?: string, options?: Omit<DiagnoseTextScope, "runId">) =>
      diagnoseTraceText(traceRecorder.exportDocument(), { ...options, runId }),
    diagnoseTrace,
    diagnoseTraceText,
    compareTraces,
    compareTracesText: (left: CompareSide, right: CompareSide) =>
      renderComparison(compareTraces(left, right)),
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
    contrast: (channel: number, min: number, max: number) => {
      const controls = scriptControls();
      if (!controls) return noControls();
      if (!Number.isInteger(channel) || channel < 0) {
        return refused(`a channel is a whole number from 0, not ${channel}`);
      }
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
        return refused(`a contrast window is two finite numbers, the minimum below the maximum, not ${min},${max}`);
      }
      return controls.contrast(channel, min, max);
    },
    addDataset: async (url: string, timeoutMs: number = DEFAULT_ADD_TIMEOUT_MS) => {
      const controls = scriptControls();
      if (!controls) return noControls();
      if (typeof url !== "string" || url.trim() === "") return refused("a dataset is named by its source URL");
      const wait = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_ADD_TIMEOUT_MS;
      return controls.addDataset(url, wait);
    },
    removeDataset: async (url: string) => {
      const controls = scriptControls();
      if (!controls) return noControls();
      if (typeof url !== "string" || url.trim() === "") return refused("a dataset is named by its source URL");
      return controls.removeDataset(url);
    },
    closeRun: (endReason: "explicit" | "timeout" = "explicit") =>
      traceRecorder.closeRun(endReason),
  };
  target.lucidaTrace = seam;
  return seam;
}

const DEFAULT_ADD_TIMEOUT_MS = 60_000;

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
export async function resolveGpuIdentity(retry?: AdapterRetry): Promise<GpuIdentity | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  try {
    const adapter = await requestAdapterWithRetry(gpu, {}, retry);
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
 * Browsers expose `isFallbackAdapter` on the adapter or on its info record.
 * Read whichever the browser has, and answer null rather than hardware when
 * it has neither.
 */
function isFallbackAdapter(adapter: GPUAdapter): boolean | null {
  const onInfo = (adapter.info as { isFallbackAdapter?: boolean }).isFallbackAdapter;
  if (typeof onInfo === "boolean") return onInfo;
  const onAdapter = (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter;
  return typeof onAdapter === "boolean" ? onAdapter : null;
}
