/**
 * A run or a bundle read back from a file (#1066), the way the CLI reads
 * one.
 *
 * Three files carry a trace document: the bundle either entry point writes,
 * the run file the trace driver writes around the page's export, and the
 * document alone, which is what the monitor's **Save run** writes. The
 * CLI's `read_artifact` tells the first two apart the same way this does,
 * by the bundle's own `format` field and then the run file's version, and
 * refuses a version it does not know by number rather than guessing. The
 * saved run is the page's own export, so this reader takes it too, and the
 * CLI, which has no renderings to print for it without a page, does not.
 *
 * What a file knows beyond its document decides what a comparison can list.
 * A bundle carries the whole planning configuration and no cache knobs. A
 * run file carries the knobs the driver set, with every other field at the
 * page's default, and the server's warmth as a condition. A saved run knows
 * nothing beyond the document. {@link compareSideOf} writes each of those
 * into the side the seam's compare function takes, field for field as the
 * CLI's `CompareSide::from_bundle` and `from_run_file` do, so the dock and
 * `lucida trace diff` hand the one compare function the same input.
 */

import type { CacheKnobs } from "../pipeline/fetch/cacheKnobs.ts";
import type { PlanningConfig } from "../pipeline/planning/config.ts";
import { BUNDLE_FORMAT, BUNDLE_VERSION, type TraceBundle } from "./bundle.ts";
import type { CompareSide } from "./diagnose/compare.ts";
import { TRACE_SCHEMA_VERSION, type TraceDocument } from "./types.ts";

/** The run file's own version, which the CLI writes and this reader refuses any other of. */
export const RUN_FILE_VERSION = 1;

/**
 * The trace driver's run file, as far as a page reads it: the version, the
 * header fields a comparison lists, and the document. The renderings and
 * the diagnostic are carried as they arrived and never read here, because
 * the page derives its own from the document.
 */
export interface TraceRunFile {
  fileVersion: number;
  header: TraceRunFileHeader;
  renderings: unknown;
  diagnostic: unknown;
  trace: TraceDocument;
}

/**
 * The run file's header, as far as a page reads it: the run it names, the
 * server's warmth, and the knobs the driver set. The driver writes more,
 * the composed view, whether the run settled, the script it ran, which is
 * carried under the index signature and never read here.
 */
export interface TraceRunFileHeader {
  runId: string | null;
  /** The server's warmth when the run started. The summary is the line a comparison lists. */
  serverWarmth: { summary: string; [field: string]: unknown };
  /** The Dev controls knobs the driver set before the page loaded. Absent when it set none. */
  knobs?: { planning?: Partial<PlanningConfig>; cache?: CacheKnobs } | null;
  [field: string]: unknown;
}

/** Whichever of the three files a reader was handed. */
export type TraceArtifact =
  | { kind: "bundle"; bundle: TraceBundle }
  | { kind: "run-file"; file: TraceRunFile }
  | { kind: "saved-run"; trace: TraceDocument };

/**
 * Read whichever artifact `text` holds. `name` is how the file is named in
 * every message, as the CLI names the path.
 */
export function readArtifact(text: string, name: string): TraceArtifact {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not JSON: ${message(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${name} is not a lucida trace bundle, run file, or saved run`);

  if (value.format === BUNDLE_FORMAT) return { kind: "bundle", bundle: parseBundle(value, name) };
  if (typeof value.fileVersion === "number") return { kind: "run-file", file: parseRunFile(value, name) };
  if (typeof value.schemaVersion === "number" && Array.isArray(value.runs)) {
    return { kind: "saved-run", trace: parseSavedRun(value, name) };
  }
  throw new Error(`${name} is not a lucida trace bundle, run file, or saved run`);
}

/** The trace document any of the three carries. */
export function artifactTrace(artifact: TraceArtifact): TraceDocument {
  switch (artifact.kind) {
    case "bundle":
      return artifact.bundle.trace;
    case "run-file":
      return artifact.file.trace;
    case "saved-run":
      return artifact.trace;
  }
}

/**
 * The run the artifact is about, when its header names one. A saved run is
 * the document alone and names none, so a reader takes the newest, as the
 * seam and the CLI do by default.
 */
export function artifactRunId(artifact: TraceArtifact): string | null {
  switch (artifact.kind) {
    case "bundle":
      return artifact.bundle.header.runId;
    case "run-file":
      return artifact.file.header.runId;
    case "saved-run":
      return null;
  }
}

/**
 * The side the seam's compare function takes for this artifact, labelled
 * `label`, with what the file knows beyond its document and nothing else.
 * The bundle and run file branches write the fields the CLI's
 * `CompareSide::from_bundle` and `from_run_file` write, so the dock's diff
 * and `lucida trace diff` are one function over one input.
 */
export function compareSideOf(artifact: TraceArtifact, label: string): CompareSide {
  switch (artifact.kind) {
    case "bundle":
      return {
        trace: artifact.bundle.trace,
        runId: artifact.bundle.header.runId ?? undefined,
        label,
        planning: artifact.bundle.header.planning,
        cache: null,
        conditions: {},
      };
    case "run-file": {
      // A run file that set no knob ran at the page's defaults, and an empty
      // object says so, where null would say the side could not tell.
      const knobs = artifact.file.header.knobs ?? {};
      return {
        trace: artifact.file.trace,
        runId: artifact.file.header.runId ?? undefined,
        label,
        planning: knobs.planning ?? {},
        cache: knobs.cache ?? {},
        conditions: { "server warmth": artifact.file.header.serverWarmth.summary },
      };
    }
    case "saved-run":
      return { trace: artifact.trace, runId: undefined, label, planning: null, cache: null, conditions: null };
  }
}

function parseBundle(value: Record<string, unknown>, name: string): TraceBundle {
  const shape = bundleShapeFailure(value);
  if (shape) throw new Error(`${name} is not a lucida trace bundle: ${shape}`);
  if (value.bundleVersion !== BUNDLE_VERSION) {
    throw new Error(
      `${name} was written by bundle version ${String(value.bundleVersion)}, and this page reads version ${BUNDLE_VERSION}`,
    );
  }
  return value as unknown as TraceBundle;
}

function bundleShapeFailure(value: Record<string, unknown>): string | null {
  if (typeof value.bundleVersion !== "number") return "missing field `bundleVersion`";
  if (!isRecord(value.header)) return "missing field `header`";
  if (!isTraceDocument(value.trace)) return "missing field `trace`";
  return null;
}

function parseRunFile(value: Record<string, unknown>, name: string): TraceRunFile {
  const header = value.header;
  if (!isRecord(header) || !isRecord(header.serverWarmth) || !isTraceDocument(value.trace)) {
    throw new Error(`${name} is not a lucida trace run file: missing field \`header\` or \`trace\``);
  }
  if (value.fileVersion !== RUN_FILE_VERSION) {
    throw new Error(
      `${name} was written by run file version ${String(value.fileVersion)}, and this page reads version ${RUN_FILE_VERSION}`,
    );
  }
  return value as unknown as TraceRunFile;
}

/**
 * The schema check the derivation makes per run, made once for the file,
 * so a document from another schema is refused by name at the drop rather
 * than partway through a reading (ADR 0047).
 */
function parseSavedRun(value: Record<string, unknown>, name: string): TraceDocument {
  if (value.schemaVersion !== TRACE_SCHEMA_VERSION) {
    throw new Error(
      `${name} was recorded under trace schema ${String(value.schemaVersion)}; this build reads schema ${TRACE_SCHEMA_VERSION}`,
    );
  }
  return value as unknown as TraceDocument;
}

function isTraceDocument(value: unknown): value is TraceDocument {
  return isRecord(value) && typeof value.schemaVersion === "number" && Array.isArray(value.runs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
