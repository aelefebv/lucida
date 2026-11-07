/**
 * Where the monitor gets its run, and how it writes one to a file or
 * sends one to the workspace inbox.
 *
 * Everything here goes through `window.lucidaTrace` — the page-level export
 * function ADR 0051 made public interface in every build. The monitor is a
 * third caller of the same seam the CLI and an agent driving its own browser
 * use, so no surface gets a privately shaped copy of the document, a run
 * saved from this page is byte-identical to one saved by `lucida trace`, and
 * a bundle saved here is the bundle the driver writes.
 *
 * One export per read, deliberately. Exporting concludes the interval being
 * asked about, and the page needs both the diagnosis and the list of runs to
 * choose from — so it takes the document once and applies the derivation the
 * seam itself applies, rather than asking the seam twice and closing an
 * interval on the way to each answer.
 */

import type { InboxReceipt } from "../bridge.ts";
import { configStore } from "../pipeline/planning/configStore.ts";
import {
  artifactRunId,
  artifactTrace,
  compareSideOf,
  readArtifact,
  type TraceArtifact,
} from "../trace/artifact.ts";
import { bundleFilename } from "../trace/bundle.ts";
import { selectChunks, type ChunkSelection } from "../trace/diagnose/chunkSelection.ts";
import {
  compareTraces,
  renderComparison,
  type CompareSide,
  type RunComparison,
} from "../trace/diagnose/compare.ts";
import { diagnoseDocument } from "../trace/diagnose/diagnose.ts";
import type { ProvisionalReading } from "../trace/diagnose/provisional.ts";
import type { LiveTimeline } from "../trace/diagnose/timeline.ts";
import type { DiagnosticDocument, WindowRequest } from "../trace/diagnose/types.ts";
import type { LiveProgress } from "../trace/liveProgress.ts";
import { sendBundle } from "../trace/reportInbox.ts";
import type { LucidaTraceSeam } from "../trace/seam.ts";
import type { TraceDocument } from "../trace/types.ts";
import { formatCause } from "./monitorModel.ts";

export type MonitorRead =
  | { ok: true; document: DiagnosticDocument }
  | { ok: false; reason: string };

/** One run in the trace, as an index entry rather than a diagnosis. */
export interface MonitorRunSummary {
  runId: string;
  datasetCount: number;
  cause: string;
  endReason: string;
  wallMs: number;
}

export interface MonitorSnapshot {
  read: MonitorRead;
  /**
   * Every run the recording still holds, newest first.
   *
   * The newest is not always the one you came for: an open settles, a later
   * camera move opens a second run, and by the time someone reaches for the
   * monitor the newest interval can be the quiet tail rather than the open.
   */
  runs: MonitorRunSummary[];
  /**
   * The document the read came from, kept so a window brushed later is
   * derived from it, and so the run on screen can stand on one side of a
   * comparison, without a second export, which would close another
   * interval on the way to the same run. Null where there was no seam to
   * export from.
   */
  trace: TraceDocument | null;
}

/** A run read over one window of its clock, and the chunk set the window selected. */
export interface WindowedRead {
  document: DiagnosticDocument;
  selection: ChunkSelection;
}

/**
 * Read a run as a diagnostic, and the runs available to read. The newest by
 * default.
 *
 * This closes the run in progress as `explicit` — asking what a run means
 * concludes the interval being asked about, and it happens the moment the page
 * opens rather than when a control is touched. A recording with nothing in it
 * is a reason rather than an exception: "nothing has been recorded yet" is a
 * legitimate state for a page someone opened before doing anything.
 */
export function readMonitor(runId?: string, seam = window.lucidaTrace): MonitorSnapshot {
  if (!seam) {
    return {
      read: {
        ok: false,
        reason: "This page is not running a lucida build with the trace seam installed.",
      },
      runs: [],
      trace: null,
    };
  }
  const document = seam.exportTrace();
  return { read: readRunOf(document, runId), runs: summariseRuns(document), trace: document };
}

function readRunOf(document: TraceDocument, runId?: string): MonitorRead {
  try {
    return { ok: true, document: diagnoseDocument(document, { runId }) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// A dropped file, and two runs compared (#1066)
// ---------------------------------------------------------------------------

/**
 * A run read from somewhere other than this page's recording: a file
 * somebody dropped on the dock or chose, or the run on screen offered to a
 * comparison. Read the way a live run is read, so the same report renders
 * from it at every depth, and nothing here touches the recorder.
 */
export interface LoadedArtifact {
  /** The file's name, or `this page` for the run on screen. A comparison names the side by it. */
  name: string;
  /** Whether the document came from a file or from this page's own export. */
  origin: "file" | "page";
  artifact: TraceArtifact;
  /** Every run the document holds, newest first, as {@link MonitorSnapshot} lists them. */
  runs: MonitorRunSummary[];
  /**
   * The run being read: the one a bundle's or a run file's header names,
   * the newest of a saved run, or the one chosen since. Null when the
   * document holds no run to read.
   */
  runId: string | null;
  read: MonitorRead;
}

/**
 * Read a file's text as whichever artifact it is, and its run as a
 * diagnostic. Throws, by the file's name, for a file that is not a bundle,
 * a run file, or a saved run, or that is one from a version this page does
 * not read. A readable file whose run cannot be read is a reason in `read`,
 * as an empty recording is for a live read.
 */
export function readArtifactFile(text: string, name: string): LoadedArtifact {
  const artifact = readArtifact(text, name);
  return loadedFrom(artifact, name, "file", artifactRunId(artifact) ?? undefined);
}

/** {@link readArtifactFile} over a file the drop handler or the file input hands over. */
export async function loadArtifact(file: Pick<File, "name" | "text">): Promise<LoadedArtifact> {
  return readArtifactFile(await file.text(), file.name);
}

/** Which of the three files a loaded run came from, as the dock names it in a sentence. */
export function describeArtifact(loaded: LoadedArtifact): string {
  switch (loaded.artifact.kind) {
    case "bundle":
      return "a bundle";
    case "run-file":
      return "a run file the trace driver wrote";
    case "saved-run":
      return "a saved run";
  }
}

/** The same file, read about another of its runs. */
export function rereadLoaded(loaded: LoadedArtifact, runId: string): LoadedArtifact {
  return loadedFrom(loaded.artifact, loaded.name, loaded.origin, runId);
}

/**
 * The run on screen as a side a comparison can take, or null when nothing
 * was read. Built from the snapshot's own document rather than from a
 * second export, which would close another interval on the way to a
 * document the dock already holds.
 */
export function pageArtifact(snapshot: MonitorSnapshot): LoadedArtifact | null {
  if (!snapshot.trace || !snapshot.read.ok) return null;
  return loadedFrom({ kind: "saved-run", trace: snapshot.trace }, "this page", "page", snapshot.read.document.runId);
}

function loadedFrom(
  artifact: TraceArtifact,
  name: string,
  origin: LoadedArtifact["origin"],
  runId: string | undefined,
): LoadedArtifact {
  const trace = artifactTrace(artifact);
  const read = readRunOf(trace, runId);
  return {
    name,
    origin,
    artifact,
    runs: summariseRuns(trace),
    runId: read.ok ? read.document.runId : (runId ?? null),
    read,
  };
}

/**
 * The side of a comparison a loaded run stands on, built as the CLI builds
 * one from the same file. It carries what the file knows beyond its
 * document and names the run the side was read about, which is the chosen
 * one when somebody changed it. The run on screen knows what a bundle's
 * header would carry, the planning configuration this page runs under, and
 * nothing a bundle would not.
 */
export function compareSideFor(loaded: LoadedArtifact): CompareSide {
  const side =
    loaded.origin === "page"
      ? {
          trace: artifactTrace(loaded.artifact),
          label: loaded.name,
          planning: configStore.get(),
          cache: null,
          conditions: {},
        }
      : compareSideOf(loaded.artifact, loaded.name);
  return { ...side, runId: loaded.runId ?? side.runId };
}

/** Two runs compared, as the document and as the text `lucida trace diff` prints. */
export interface LoadedComparison {
  comparison: RunComparison;
  text: string;
}

/**
 * Compare `right` against `left` through the seam's own compare function,
 * which is the function `lucida trace diff` evaluates on a page: the dock
 * and the CLI print one subtraction. Every delta is right minus left, so a
 * baseline on the left and a candidate on the right read as what the
 * candidate changed. Reads nothing from and closes nothing in the recorder.
 */
export function compareLoaded(left: LoadedArtifact, right: LoadedArtifact): LoadedComparison {
  const comparison = compareTraces(compareSideFor(left), compareSideFor(right));
  return { comparison, text: renderComparison(comparison) };
}

/**
 * Read one run over a window of its clock: the report the brush scopes to,
 * and the chunk set the brush publishes.
 *
 * Derived from the document already in hand and never from a fresh export,
 * so brushing closes nothing. It is the derivation the seam's `diagnoseTrace`
 * applies, and that is what `lucida trace show --window` evaluates on a
 * page, so the numbers under a brush and under the flag are one computation.
 * `phase` narrows the set to the rows that were in that phase during the
 * window, and null takes every row the window can see. The document is the
 * window's either way.
 *
 * Throws, as the derivation does, when the document has no such run or the
 * window is empty once clamped to it.
 */
export function readWindow(
  trace: TraceDocument,
  runId: string,
  window: WindowRequest,
  phase: string | null,
): WindowedRead {
  const run = trace.runs.find((candidate) => candidate.header.runId === runId);
  if (!run) throw new Error(`no run ${runId} in this trace document`);
  return {
    document: diagnoseDocument(trace, { runId, window }),
    selection: selectChunks(run, window, phase),
  };
}

/**
 * The run in progress, or null when none is open (#937).
 *
 * One of the two reads on this page that leave the recording alone. It is
 * polled while a run is open, where every other read here would conclude the
 * interval being watched. A page with no seam on it has no run in progress
 * either, so the missing-seam case is the same null rather than a second
 * shape.
 */
export function readProgress(seam = window.lucidaTrace): LiveProgress | null {
  return seam?.progress() ?? null;
}

/**
 * The provisional reading over the run in progress, or null when none is
 * open (#1057). The other read that leaves the recording alone: the same
 * object the watch stream carries and an agent reads over the seam, so the
 * live view and the text an agent sees cannot disagree.
 */
export function readProvisional(seam = window.lucidaTrace): ProvisionalReading | null {
  return seam?.provisional() ?? null;
}

/**
 * The live charts over the run in progress, or null when none is open. The
 * third read that leaves the recording alone: drawn from the per-tick tiers
 * and never from a row, which is what lets the dock poll it while a run is
 * open without perturbing the run it draws.
 */
export function readLiveTimeline(seam = window.lucidaTrace): LiveTimeline | null {
  return seam?.liveTimeline() ?? null;
}

/**
 * *Stop & analyse*: close the run explicitly so it can be read.
 *
 * `explicit` rather than `timeout`, and the distinction is not cosmetic —
 * `timeout` says the run ran out of the recorder's own patience, where this
 * says a person decided they had seen enough. A later reader trusts that
 * field.
 */
export function stopRun(seam = window.lucidaTrace): void {
  seam?.closeRun("explicit");
}

function summariseRuns(document: TraceDocument): MonitorRunSummary[] {
  return document.runs
    .map((run) => ({
      runId: run.header.runId,
      datasetCount: run.header.datasetIds.length,
      // The whole cause, not the source alone. "pan" and "dataset_added"
      // would otherwise read as the same kind of run.
      cause: formatCause(run.header.cause),
      endReason: run.header.endReason,
      wallMs: Math.round(run.header.durationUs / 1_000),
    }))
    .reverse();
}

/** The two things a run can be saved as. */
export type TraceFileKind = "trace" | "perfetto";

export interface TraceFile {
  filename: string;
  mime: string;
  text: string;
}

/**
 * Serialise the recording for a file, named for the run being read.
 *
 * `trace` is the merged document, headers included — the dataset, view, build,
 * GPU, device pixel ratio, viewport and cache warmth that make two runs
 * comparable or visibly not. `perfetto` is the same content in Chrome Trace
 * Event JSON, for the raw-span questions this page deliberately does not
 * answer.
 *
 * Both carry every retained run rather than the one on screen: that is the
 * artifact the seam produces, and a monitor that cut one run out of it would
 * be shipping a second export shape. The **name** follows the run on screen,
 * so the file and the follow-up command that names that run agree.
 */
export function traceFile(
  kind: TraceFileKind,
  runId?: string,
  seam = window.lucidaTrace,
): TraceFile {
  if (!seam) throw new Error("no trace seam on this page");
  if (kind === "perfetto") {
    const text = seam.exportChromeTrace();
    return { filename: `${stem(runId, seam)}.perfetto.json`, mime: "application/json", text };
  }
  const document = seam.exportTrace();
  return {
    filename: `lucida-${runId ?? newestRunId(document)}.trace.json`,
    mime: "application/json",
    text: JSON.stringify(document),
  };
}

function stem(runId: string | undefined, seam: LucidaTraceSeam): string {
  return `lucida-${runId ?? newestRunId(seam.exportTrace())}`;
}

function newestRunId(document: TraceDocument): string {
  // The run id, not a timestamp: it is what every follow-up command names, so
  // a file on disk and a `lucida trace show <run>` refer to each other.
  return document.runs[document.runs.length - 1]?.header.runId ?? "empty";
}

/** Hand the file to the browser's download path. */
export function downloadTraceFile(
  kind: TraceFileKind,
  runId?: string,
  seam = window.lucidaTrace,
): string {
  const file = traceFile(kind, runId, seam);
  downloadText(file);
  return file.filename;
}

/**
 * The bundle for the run on screen (#1055): the document, the settled frame,
 * the view URL, the planning configuration, the pins, the server's health
 * counters, and the replay header, in one file.
 *
 * Through the seam's own bundle function, which is the same one `lucida
 * trace --bundle` calls, so the file this page saves and the file the driver
 * writes are the same artifact. Asynchronous because the seam fetches the
 * health and reads the frame off the render worker before it exports. The
 * Perfetto projection stays out. **Save for Perfetto** is the control for
 * that, and a bundle that always carried it would be megabytes nobody asked
 * for.
 */
export async function downloadBundle(runId?: string, seam = window.lucidaTrace): Promise<string> {
  if (!seam) throw new Error("no trace seam on this page");
  const bundle = await seam.exportBundle({ runId });
  const filename = bundleFilename(bundle);
  downloadText({ filename, mime: "application/json", text: JSON.stringify(bundle) });
  return filename;
}

/**
 * **Send report** (#1067): the bundle for the run on screen, posted to
 * the workspace inbox, and the entry it landed in.
 *
 * The same bundle **Save bundle** writes, through the same seam function
 * — one artifact, two destinations, so the report an agent fetches and
 * the file a person saves cannot differ. What comes back is the entry's
 * id and when the inbox's retention drops it, which is what the page
 * shows and what `lucida trace inbox fetch` takes.
 *
 * This runs when somebody presses the action, and at no other time.
 */
export async function sendReport(
  runId?: string,
  seam = window.lucidaTrace,
): Promise<InboxReceipt> {
  if (!seam) throw new Error("no trace seam on this page");
  return sendBundle(await seam.exportBundle({ runId }));
}

/** The only DOM this module touches. */
function downloadText(file: TraceFile): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
