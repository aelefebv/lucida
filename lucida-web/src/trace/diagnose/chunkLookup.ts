/**
 * The chunk lookup: one chunk by row identity, read out of the rows the run
 * recorded. "Why is this chunk not resident" answered in text, from the same
 * document the overlay's hover inspector reads, so the two cannot disagree.
 *
 * The queue rank is derived, not recorded. The scheduler keeps no per-key
 * bookkeeping behind its admission window (ADR 0044), so the trace carries no
 * rank; what it does carry is every recorded row's admission and dispatch,
 * and a rank is a count over those. Two facts bound what that count can say,
 * and both are stated on the lookup itself: a row is born at dispatch
 * (`TraceRecorder.beginChunkRow`), so a chunk still queued at close has no
 * row and is invisible to the count, and a chunk re-delivered from the CPU
 * cache carries no second row.
 */

import {
  NEVER_ADMITTED,
  NOT_DISPATCHED,
  PHASES,
  type AdmissionColumns,
  type MatchedRow,
  type Phase,
  type TracePointEvent,
  type TraceRow,
  type TraceRun,
} from "../types.ts";
import { nullableUsToMs, usToMs } from "./phaseRollup.ts";
import { describeState, firstBoundaryUs, rowAgeUs, rowState } from "./rowState.ts";
import type {
  ChunkEventReading,
  ChunkLookup,
  ChunkRowReading,
  Finding,
  PhaseRollup,
  QueueRank,
  RowPhaseReading,
} from "./types.ts";

/**
 * How many rows, and how many events, a lookup lists. A bare key matches one
 * row per tile in a collection; the count of what matched is always
 * reported, and the caller narrows by entity.
 */
export const MAX_CHUNK_ROWS = 16;

const CHUNK_KEY_COMPONENTS = 6;

const LIMITS =
  "ranks and ages count recorded rows only: a row is born at dispatch, so a chunk still queued at run close has no row and every rank is a floor, and a chunk re-delivered from the CPU cache carries no second row";

export interface ChunkSelector {
  /** Null for a bare key, which matches the chunk in every entity that has one. */
  entityId: string | null;
  chunkKey: string;
}

/** The chunk the default text points at, and the phrase that says why. */
export interface WorstRow {
  selector: string;
  chosen: string;
}

/**
 * Read `[entity/]level/t/c/z/y/x`. The key is always the last six components,
 * so an entity id may itself contain the separator.
 */
export function parseChunkSelector(selector: string): ChunkSelector | null {
  const parts = selector.split("/");
  if (parts.length < CHUNK_KEY_COMPONENTS) return null;
  const coordinates = parts.slice(-CHUNK_KEY_COMPONENTS);
  if (!coordinates.every((part) => /^\d+$/.test(part))) return null;
  const prefix = parts.slice(0, -CHUNK_KEY_COMPONENTS);
  return {
    entityId: prefix.length === 0 ? null : prefix.join("/"),
    chunkKey: coordinates.join("/"),
  };
}

/**
 * The chunk the default text points at when nobody named one: the row that
 * spent longest in the lead finding's phase, or failing a browser-side lead,
 * in the largest browser phase. Named with its entity, so the follow-up
 * command it produces is unambiguous on a collection.
 *
 * Null when the run recorded no chunk row at all.
 */
export function worstRowSelector(
  run: TraceRun,
  phases: PhaseRollup[],
  findings: Finding[],
): WorstRow | null {
  const lead = findings.find((finding) => finding.severity !== "note");
  const candidates: string[] = [];
  if (lead && lead.subject.startsWith("browser.")) candidates.push(lead.subject);
  for (const phase of phases) if (phase.side === "browser") candidates.push(phase.id);

  for (const id of candidates) {
    const phase = id.slice("browser.".length) as Phase;
    // A derived path segment such as the pre-plan stretch is not a row phase.
    if (!PHASES.includes(phase)) continue;
    let best: TraceRow | null = null;
    let bestUs = -1;
    for (const row of run.rows) {
      const timing = row.phases[phase];
      // `>=` keeps the last of equals, which is the row the rollup names.
      if (timing && timing.durationUs >= bestUs) {
        best = row;
        bestUs = timing.durationUs;
      }
    }
    if (best) {
      return {
        selector: `${best.entityId}/${best.chunkKey}`,
        chosen: `the row that spent longest in ${id}`,
      };
    }
  }
  return null;
}

/** The lookup with nothing to look up: a run that recorded no chunk row. */
export function emptyChunkLookup(chosen: string): ChunkLookup {
  return {
    selector: null,
    chosen,
    chunkKey: null,
    entityId: null,
    rows: [],
    rowCount: 0,
    entityCount: 0,
    events: [],
    eventCount: 0,
    statement: "this run recorded no chunk row, so there is nothing to look up",
    limits: LIMITS,
  };
}

/**
 * Look one chunk up in `run`. `chosen` says how the selector was arrived at,
 * and is carried through so a reader knows whether they asked for this chunk
 * or the derivation picked it.
 */
export function lookupChunk(run: TraceRun, selector: string, chosen: string): ChunkLookup {
  const parsed = parseChunkSelector(selector);
  if (!parsed) {
    return {
      ...emptyChunkLookup(chosen),
      selector,
      statement: `"${selector}" is not a chunk selector; a chunk is named as [entity/]level/t/c/z/y/x`,
    };
  }
  const { entityId, chunkKey } = parsed;
  const matched: MatchedRow[] = [];
  run.rows.forEach((row, index) => {
    if (row.chunkKey !== chunkKey) return;
    if (entityId !== null && row.entityId !== entityId) return;
    matched.push({ row, index });
  });
  return readChunk({
    selector,
    chosen,
    chunkKey,
    entityId,
    matched,
    admissions: admissionColumnsOf(run.rows),
    events: run.events,
    closeUs: run.header.durationUs,
  });
}

/** What the chunk lookup reads: the matched rows, the columns to rank them against, and the events. */
export interface ChunkReadInput {
  selector: string;
  chosen: string;
  chunkKey: string;
  /** The entity the selector named, or null for a bare key. */
  entityId: string | null;
  /** Every row carrying the chunk, in table order. */
  matched: MatchedRow[];
  admissions: AdmissionColumns;
  /** The interval's point events, from which the ones naming the chunk are kept. */
  events: readonly TracePointEvent[];
  /** The interval's clock at the reading: its close, or now for an interval still open. */
  closeUs: number;
}

/**
 * The lookup over rows already matched. `lookupChunk` matches over a
 * serialised run; the recorder's live index matches over the open interval
 * and hands its rows here, so the hover inspector and the text read one
 * function.
 */
export function readChunk(input: ChunkReadInput): ChunkLookup {
  const { selector, chosen, chunkKey, entityId, admissions, closeUs } = input;
  // Oldest first, so several rows read as one history; rows with no boundary go last.
  const matched = [...input.matched].sort((a, b) => {
    const first = firstBoundaryUs(a.row);
    const second = firstBoundaryUs(b.row);
    if (first === null || second === null) return first === null ? (second === null ? 0 : 1) : -1;
    return first - second;
  });

  const rows = matched
    .slice(0, MAX_CHUNK_ROWS)
    .map(({ row, index }, position) => rowReading(row, index, position + 1, admissions, closeUs));

  const events: ChunkEventReading[] = [];
  let eventCount = 0;
  for (const event of input.events) {
    const chunk = event.chunk;
    if (!chunk || chunk.chunkKey !== chunkKey) continue;
    if (entityId !== null && chunk.entityId !== entityId) continue;
    eventCount += 1;
    if (events.length < MAX_CHUNK_ROWS) {
      events.push({
        atMs: usToMs(event.atUs),
        kind: event.kind,
        reason: event.reason,
        entityId: chunk.entityId,
        residencyTier: chunk.residencyTier,
      });
    }
  }
  events.sort((a, b) => a.atMs - b.atMs);

  const entityCount = new Set(matched.map(({ row }) => row.entityId)).size;
  return {
    selector,
    chosen,
    chunkKey,
    entityId,
    rows,
    rowCount: matched.length,
    entityCount,
    events,
    eventCount,
    statement: statementFor({ chunkKey, entityId, rows, rowCount: matched.length, entityCount, eventCount }),
    limits: LIMITS,
  };
}

/** One row as the lookup lists it, ranked against the interval's other rows. */
export function rowReading(
  row: TraceRow,
  index: number,
  id: number,
  admissions: AdmissionColumns,
  closeUs: number,
): ChunkRowReading {
  return {
    id,
    datasetId: row.datasetId,
    entityId: row.entityId,
    imageId: row.imageId,
    lane: row.lane,
    residencyTier: row.residencyTier,
    rid: row.rid,
    connectionGeneration: row.connectionGeneration,
    outcome: row.outcome,
    state: rowState(row),
    firstSeenMs: nullableUsToMs(firstBoundaryUs(row)),
    ageMs: nullableUsToMs(rowAgeUs(row, closeUs)),
    phases: phaseHistory(row),
    queue: queueRankOf(index, admissions, closeUs),
  };
}

/** The admission columns of serialised rows, read once so a lookup over many rows does not re-derive them. */
export function admissionColumnsOf(rows: readonly TraceRow[]): AdmissionColumns {
  const admitted = new Float64Array(rows.length);
  const dispatched = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const admission = admissionOf(rows[i]);
    admitted[i] = admission ? admission.admittedUs : NEVER_ADMITTED;
    dispatched[i] = admission ? (admission.dispatchedUs ?? NOT_DISPATCHED) : NOT_DISPATCHED;
  }
  return {
    length: rows.length,
    admittedUs: (index) => admitted[index],
    dispatchedUs: (index) => dispatched[index],
  };
}

function phaseHistory(row: TraceRow): RowPhaseReading[] {
  const out: RowPhaseReading[] = [];
  for (const phase of PHASES) {
    const timing = row.phases[phase];
    if (!timing) continue;
    out.push({
      phase,
      startMs: usToMs(timing.startUs),
      endMs: usToMs(timing.endUs),
      durationMs: usToMs(timing.durationUs),
    });
  }
  return out;
}

/** When a row was admitted to the queue, and when it left; null while it is still there. */
export interface Admission {
  admittedUs: number;
  dispatchedUs: number | null;
}

/**
 * A row's admission, read off its phases. A row that finished `queue` was
 * admitted when it started and dispatched when it ended. A row still in the
 * queue has no queue phase yet; it was admitted when its plan phase ended.
 * Any other row never entered the queue as far as the rows can show.
 */
export function admissionOf(row: TraceRow): Admission | null {
  const queue = row.phases.queue;
  if (queue) return { admittedUs: queue.startUs, dispatchedUs: queue.endUs };
  if (rowState(row) === "queue" && row.phases.plan) {
    return { admittedUs: row.phases.plan.endUs, dispatchedUs: null };
  }
  return null;
}

/**
 * The row's rank, counted over the other rows' admissions and dispatches.
 * Rows admitted at the same instant are neither ahead of nor behind the row,
 * unless they dispatched first, in which case they overtook it: that is the
 * scheduler's own ordering within one plan pass showing through. Null when
 * the row never entered the queue.
 */
export function queueRankOf(
  targetIndex: number,
  admissions: AdmissionColumns,
  closeUs: number,
): QueueRank | null {
  const targetAdmitted = admissions.admittedUs(targetIndex);
  if (targetAdmitted === NEVER_ADMITTED) return null;
  const targetDispatched = admissions.dispatchedUs(targetIndex);
  let ahead = 0;
  let overtaken = 0;
  for (let i = 0; i < admissions.length; i += 1) {
    if (i === targetIndex) continue;
    const admitted = admissions.admittedUs(i);
    if (admitted === NEVER_ADMITTED) continue;
    const dispatched = admissions.dispatchedUs(i);
    if (admitted < targetAdmitted) {
      if (dispatched > targetAdmitted) ahead += 1;
    } else if (dispatched < targetDispatched) {
      overtaken += 1;
    }
  }
  const dispatchedAtUs = targetDispatched === NOT_DISPATCHED ? closeUs : targetDispatched;
  return {
    aheadAtAdmission: ahead,
    overtaken,
    waitedMs: usToMs(dispatchedAtUs - targetAdmitted),
    dispatched: targetDispatched !== NOT_DISPATCHED,
  };
}

function statementFor(input: {
  chunkKey: string;
  entityId: string | null;
  rows: ChunkRowReading[];
  rowCount: number;
  entityCount: number;
  eventCount: number;
}): string {
  const { chunkKey, entityId, rows, rowCount, entityCount, eventCount } = input;
  const name = entityId === null ? `chunk ${chunkKey}` : `chunk ${chunkKey} of ${entityId}`;
  if (rowCount === 0) {
    const events = eventCount === 0 ? "" : ` ${plural(eventCount, "point event")} name it.`;
    return (
      `${name} is not in this run: no lifecycle row carries it. A row is born at dispatch, so the chunk ` +
      `was either never dispatched (still queued, or never wanted) or resident before the run opened.${events}`
    );
  }
  const tally = new Map<string, number>();
  for (const row of rows) tally.set(describeState(row.state), (tally.get(describeState(row.state)) ?? 0) + 1);
  const states = [...tally].map(([state, n]) => `${state} ×${n}`).join(", ");
  const parts = [`${plural(rowCount, "row")} across ${plural(entityCount, "entity", "entities")}: ${states}`];
  if (rowCount > rows.length) parts.push(`the ${rows.length} oldest are listed`);
  if (entityId === null && entityCount > 1) parts.push(`name the entity to narrow: <entity>/${chunkKey}`);
  if (eventCount > 0) parts.push(`${plural(eventCount, "point event")} name it`);
  return parts.join("; ");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
