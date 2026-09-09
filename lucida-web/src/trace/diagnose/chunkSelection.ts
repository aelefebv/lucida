/**
 * The chunk set a brushed window publishes: which chunks had a row inside a
 * window of the run's clock, narrowed to one phase when the reader has
 * scoped to one.
 *
 * This is the link between the dock and the overlay. The dock is the
 * temporal surface and the overlay the spatial one, and they do not merge:
 * a window brushed on the dock's axis becomes a set of row identities here,
 * the dock publishes it, and the overlay highlights the cells whose identity
 * is in it (ADR 0052 as amended). Derived beside the chunk lookup and the
 * spatial summary so the set reads the same rows by the same rules: a row's
 * position is its boundaries, a row still in flight is charged to the run's
 * close, and a row that crosses the window's edge counts for the part
 * inside, as it does in the phase rollup.
 *
 * Like the per-chunk states, this grows with the chunks the window touched,
 * so it is not a section of the diagnostic document. Its counts and its
 * statement still reach a reader. The dock prints them beside the window,
 * and a test asserts them.
 */

import { labelKey } from "../merge.ts";
import { PHASES, SERVER_PHASES, type Phase, type ServerPhase, type TraceRow, type TraceRun } from "../types.ts";
import { chunkIdentity } from "./chunkStates.ts";
import { lastBoundaryUs, rowSpanUs, rowState } from "./rowState.ts";
import type { DiagnosticWindow, WindowRequest } from "./types.ts";
import { clipSpan, describeWindow, resolveWindow, windowLabel } from "./window.ts";

/** The chunks a window of one run selected, keyed as the overlay keys its cells. */
export interface ChunkSelection {
  runId: string;
  /** The window as the derivation read it: clamped to the run and stated on the run's clock. */
  window: DiagnosticWindow;
  /**
   * The phase rollup id the set is narrowed to, such as `browser.wire` or
   * `server.permit-wait`, or null when any row inside the window counts.
   */
  phase: string | null;
  /** Row identities, as {@link chunkIdentity} spells them. */
  identities: ReadonlySet<string>;
  /** How many identities the set holds. */
  chunks: number;
  /** How many rows put them there; more than {@link chunks} when a chunk was fetched more than once. */
  rows: number;
  /** What the set is, with its window, in one sentence. */
  statement: string;
  /** What the set cannot show, one statement each. Never empty. */
  cannotShow: string[];
}

const NO_ROW =
  "a chunk resident before the run opened, re-delivered from the CPU cache, or never wanted has no row, so it is never in the set";

/** A phase rollup id split into the side it was measured on and the phase's own name. */
function parsePhase(id: string): { side: "browser" | "server" | "metadata" | null; name: string } {
  for (const side of ["browser", "server", "metadata"] as const) {
    if (id.startsWith(`${side}.`)) return { side, name: id.slice(side.length + 1) };
  }
  return { side: null, name: id };
}

/**
 * Select the chunks with a row inside `request`, narrowed to `phase` when
 * one is named. Throws, as the derivation does, on a window that is empty
 * once clamped to the run.
 */
export function selectChunks(
  run: TraceRun,
  request: WindowRequest,
  phase: string | null = null,
): ChunkSelection {
  const window = resolveWindow(run, request);
  const closeUs = Math.max(0, run.header.durationUs);
  const identities = new Set<string>();
  const cannotShow: string[] = [];
  const label = `${windowLabel(window)} ms of run ${run.header.runId}`;
  let rows = 0;
  let statement: string;

  const add = (row: TraceRow): void => {
    rows += 1;
    identities.add(chunkIdentity(row.datasetId, row.entityId, row.chunkKey));
  };
  const unknownPhase = (kind: string): void => {
    cannotShow.push(`no ${kind} is called ${phase}, so the set is empty`);
    statement = `no chunk: ${phase} is not a phase of this run`;
  };
  const parsed = phase === null ? null : parsePhase(phase);

  if (parsed === null) {
    let unplaced = 0;
    for (const row of run.rows) {
      const span = rowSpanUs(row, closeUs);
      if (span === null) {
        unplaced += 1;
        continue;
      }
      if (clipSpan(span.startUs, span.endUs, window)) add(row);
    }
    if (unplaced > 0) {
      cannotShow.push(
        `${unplaced} row(s) reached no boundary, so they have no position on the run's clock and are not in the set`,
      );
    }
    statement = `${countPhrase(identities.size)} with a row active during ${label}${fromRows(rows, identities.size)}`;
  } else if (parsed.side === "browser") {
    const name = parsed.name as Phase;
    if (!PHASES.includes(name)) {
      unknownPhase("browser phase");
    } else {
      let atClose = 0;
      for (const row of run.rows) {
        const timing = row.phases[name];
        if (timing && clipSpan(timing.startUs, timing.endUs, window)) {
          add(row);
          continue;
        }
        // An in-flight row whose state is this phase has entered it and not
        // left, so it occupies the phase from its last boundary to the close.
        if (row.outcome !== "in-flight" || rowState(row) !== name) continue;
        const last = lastBoundaryUs(row);
        if (last !== null && clipSpan(last, closeUs, window)) {
          add(row);
          atClose += 1;
        }
      }
      statement =
        `${countPhrase(identities.size)} with a row in ${phase} during ${label}${fromRows(rows, identities.size)}` +
        (atClose > 0 ? `; ${atClose} of them were still in it at the run's close` : "");
    }
  } else if (parsed.side === "server") {
    const name = parsed.name as ServerPhase;
    if (!SERVER_PHASES.includes(name)) {
      unknownPhase("server phase");
    } else {
      // A server row carries a wire label and no chunk identity, so the set
      // is the browser rows whose label a server row in this phase answered
      // inside the window.
      const labels = new Set<string>();
      let unplaced = 0;
      for (const serverRow of run.serverRows) {
        if (serverRow.family === "metadata-read") continue;
        const durationUs = serverRow.phases[name];
        if (durationUs === undefined || !(durationUs > 0)) continue;
        if (!serverRow.placement) {
          unplaced += 1;
          continue;
        }
        if (!clipSpan(serverRow.placement.startUs, serverRow.placement.endUs, window)) continue;
        labels.add(labelKey(serverRow.connectionGeneration, serverRow.rid));
      }
      for (const row of run.rows) {
        if (labels.has(labelKey(row.connectionGeneration, row.rid))) add(row);
      }
      if (unplaced > 0) {
        cannotShow.push(
          `${unplaced} server row(s) in ${phase} have no position on the run's clock, so the window cannot say whether they were inside it`,
        );
      }
      cannotShow.push(
        "a server row sits somewhere inside its browser bracket, so a row counts when the bracket reaches the window rather than when the phase does",
      );
      statement = `${countPhrase(identities.size)} whose wire request was in ${phase} during ${label}${fromRows(rows, identities.size)}`;
    }
  } else if (parsed.side === "metadata") {
    cannotShow.push(
      `${phase} is a dataset-open metadata read, keyed by the open's request id and not a chunk, so the phase names no chunk`,
    );
    statement = `no chunk: ${phase} is a metadata read, not a chunk phase`;
  } else {
    unknownPhase("phase");
  }

  cannotShow.push(NO_ROW);
  return {
    runId: run.header.runId,
    window: describeWindow(run, window),
    phase,
    identities,
    chunks: identities.size,
    rows,
    statement: statement!,
    cannotShow,
  };
}

function countPhrase(chunks: number): string {
  if (chunks === 0) return "no chunk";
  return chunks === 1 ? "1 chunk" : `${chunks.toLocaleString()} chunks`;
}

function fromRows(rows: number, chunks: number): string {
  return rows > chunks ? `, from ${rows.toLocaleString()} rows` : "";
}
