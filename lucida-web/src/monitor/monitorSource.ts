/**
 * Where the monitor gets its run, and how it writes one to a file.
 *
 * Everything here goes through `window.lucidaTrace` — the page-level export
 * function ADR 0051 made public interface in every build. The monitor is a
 * third caller of the same seam the CLI and an agent driving its own browser
 * use, so no surface gets a privately shaped copy of the document and a run
 * saved from this page is byte-identical to one saved by `lucida trace`.
 *
 * One export per read, deliberately. Exporting concludes the interval being
 * asked about, and the page needs both the diagnosis and the list of runs to
 * choose from — so it takes the document once and applies the derivation the
 * seam itself applies, rather than asking the seam twice and closing an
 * interval on the way to each answer.
 */

import { diagnoseDocument } from "../trace/diagnose/diagnose.ts";
import type { DiagnosticDocument } from "../trace/diagnose/types.ts";
import type { LucidaTraceSeam } from "../trace/seam.ts";
import type { TraceDocument } from "../trace/types.ts";

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
    };
  }
  const document = seam.exportTrace();
  const runs = summariseRuns(document);
  try {
    return { read: { ok: true, document: diagnoseDocument(document, { runId }) }, runs };
  } catch (error) {
    return {
      read: { ok: false, reason: error instanceof Error ? error.message : String(error) },
      runs,
    };
  }
}

function summariseRuns(document: TraceDocument): MonitorRunSummary[] {
  return document.runs
    .map((run) => ({
      runId: run.header.runId,
      datasetCount: run.header.datasetIds.length,
      cause: run.header.cause?.source ?? "steady state",
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

/** Hand the file to the browser's download path. The only DOM this module touches. */
export function downloadTraceFile(
  kind: TraceFileKind,
  runId?: string,
  seam = window.lucidaTrace,
): string {
  const file = traceFile(kind, runId, seam);
  const url = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return file.filename;
}
