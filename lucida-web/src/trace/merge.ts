/**
 * Placing the server's rows on the browser's timeline.
 *
 * The two sides run on two clocks and nothing here synchronises them. The
 * browser stamped when it sent a label and when the bytes came back, and the
 * server's work for that label is strictly nested inside those two instants
 * — so the placement is derived from the browser's clock alone, and skew
 * cannot produce a wrong picture.
 *
 * What is left over inside the bracket is network plus socket queue. It is
 * named as a gap and never folded into either side's numbers: a merged
 * timeline that is confidently wrong is worse than one that admits what it
 * does not know.
 */

import type { StoredServerRow } from "./serverRowTable.ts";
import type {
  DatasetOpenBracket,
  ServerPlacement,
  TraceRow,
  TraceServerRow,
  UnplacedReason,
} from "./types.ts";

interface Bracket {
  startUs: number;
  endUs: number;
}

/**
 * Join each server row to the bracket the browser measured for it and place
 * it inside.
 *
 * There are two joins, because there are two kinds of parent. A chunk or
 * asset row equi-joins on `(connectionGeneration, rid)`; coalesced browser
 * rows all carry the first sender's label, so several rows may share one
 * bracket — that is the cardinality, not a defect to clean up. A
 * metadata-read row joins on the `request_id` of the open that performed
 * it, which is what puts a cold open's cost on the timeline at all: those
 * reads happen before the first chunk exists, so no chunk bracket could
 * ever hold them.
 */
export function placeServerRows(
  browserRows: readonly TraceRow[],
  serverRows: readonly StoredServerRow[],
  datasetOpens: readonly DatasetOpenBracket[],
): TraceServerRow[] {
  const opens = new Map(datasetOpens.map(open => [open.requestId, open]));
  const brackets = new Map<string, Bracket | null>();
  for (const row of browserRows) {
    // Generation 0 is "no wire request was sent", not a label. Letting it
    // into the map would make an unlabelled row indistinguishable from a
    // connection's genuine first request, which really is `rid: 0`.
    if (row.connectionGeneration === 0) continue;
    const key = labelKey(row.connectionGeneration, row.rid);
    const wire = row.phases.wire;
    const existing = brackets.get(key);
    if (!wire) {
      // Records that the label is known even when this row never closed.
      if (existing === undefined) brackets.set(key, null);
      continue;
    }
    if (!existing) {
      brackets.set(key, { startUs: wire.startUs, endUs: wire.endUs });
      continue;
    }
    existing.startUs = Math.min(existing.startUs, wire.startUs);
    existing.endUs = Math.max(existing.endUs, wire.endUs);
  }

  return serverRows.map(row => {
    if (row.family === "metadata-read") {
      const open = row.requestId === null ? undefined : opens.get(row.requestId);
      if (!open) return unplaced(row, "no-open-bracket");
      return { ...row, placement: placeInOpen(row, open), unplacedReason: null };
    }
    const bracket = brackets.get(labelKey(row.connectionGeneration, row.rid));
    if (bracket === undefined) {
      return unplaced(row, "no-browser-row");
    }
    if (bracket === null) {
      // A not-ready answer is the honest end of the server's work: no bytes
      // were ever coming, so the open bracket is not the server sitting on
      // the request. Anything reading this as a server stall is the
      // mis-attribution this column exists to prevent.
      return unplaced(row, row.outcome === "not-ready" ? "answered-without-delivery" : "bracket-open");
    }
    return { ...row, placement: place(row, bracket), unplacedReason: null };
  });
}

function place(row: StoredServerRow, bracket: Bracket): ServerPlacement {
  const bracketUs = Math.max(0, bracket.endUs - bracket.startUs);
  const serverUs = row.dispatchOffsetUs + row.durationUs;

  // The server reporting more than the bracket holds is a disagreement
  // between two clocks, not a longer server. The bracket wins — it is the
  // one measured on a single clock — and the disagreement is reported at
  // its actual size.
  if (serverUs >= bracketUs) {
    return {
      startUs: bracket.startUs,
      endUs: bracket.endUs,
      gapUs: 0,
      overshootUs: serverUs - bracketUs,
    };
  }

  // Centred: the gap is measured, its split between the outbound and
  // inbound legs is not.
  const gapUs = bracketUs - serverUs;
  const startUs = bracket.startUs + Math.floor(gapUs / 2);
  return {
    startUs,
    endUs: startUs + serverUs,
    gapUs,
    overshootUs: 0,
  };
}

/**
 * Lay a metadata read out where inside the open it happened, rather than
 * centring it: the row carries its own offset from the open's arrival at
 * the server, so hundreds of reads spread across the open's bracket
 * instead of stacking at its midpoint.
 *
 * The offset is measured from the server's arrival and the bracket starts
 * at the browser's send, so every read is drawn slightly late by the
 * outbound network leg. That remainder is not attributed to any row — it
 * is the same unattributed gap the labelled families name, and it belongs
 * to the open as a whole rather than to one of its reads.
 *
 * An open that has not settled still places its reads. Unlike a chunk
 * bracket, placement here needs only the start, and a run that closed over
 * an open still running is exactly the run someone is reading.
 */
function placeInOpen(row: StoredServerRow, open: DatasetOpenBracket): ServerPlacement {
  const startUs = open.startUs + row.dispatchOffsetUs;
  const endUs = startUs + row.durationUs;
  if (open.endUs === null) {
    return { startUs, endUs, gapUs: 0, overshootUs: 0 };
  }
  // Past the end of the bracket means the two clocks disagree, and the
  // bracket wins — it is the one measured on a single clock.
  return {
    startUs: Math.min(startUs, open.endUs),
    endUs: Math.min(endUs, open.endUs),
    gapUs: 0,
    overshootUs: Math.max(0, endUs - open.endUs),
  };
}

function unplaced(row: StoredServerRow, reason: UnplacedReason): TraceServerRow {
  return { ...row, placement: null, unplacedReason: reason };
}

function labelKey(connectionGeneration: number, rid: number): string {
  return `${connectionGeneration}:${rid}`;
}
