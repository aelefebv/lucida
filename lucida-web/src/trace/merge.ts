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
import type { ServerPlacement, TraceRow, TraceServerRow, UnplacedReason } from "./types.ts";

interface Bracket {
  startUs: number;
  endUs: number;
}

/**
 * Join each server row to the browser rows carrying its label and place it
 * inside their bracket.
 *
 * The join is a plain equi-join on `(connectionGeneration, rid)`. Coalesced
 * browser rows all carry the first sender's label, so several rows may share
 * one bracket — that is the cardinality, not a defect to clean up.
 */
export function placeServerRows(
  browserRows: readonly TraceRow[],
  serverRows: readonly StoredServerRow[],
): TraceServerRow[] {
  const brackets = new Map<string, Bracket | null>();
  for (const row of browserRows) {
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
  // one measured on a single clock — and the disagreement is declared.
  if (serverUs >= bracketUs) {
    return {
      startUs: bracket.startUs,
      endUs: bracket.endUs,
      gapUs: 0,
      gapSplit: "even",
      clamped: serverUs > bracketUs,
    };
  }

  const gapUs = bracketUs - serverUs;
  const startUs = bracket.startUs + Math.floor(gapUs / 2);
  return {
    startUs,
    endUs: startUs + serverUs,
    gapUs,
    gapSplit: "even",
    clamped: false,
  };
}

function unplaced(row: StoredServerRow, reason: UnplacedReason): TraceServerRow {
  return { ...row, placement: null, unplacedReason: reason };
}

function labelKey(connectionGeneration: number, rid: number): string {
  return `${connectionGeneration}:${rid}`;
}
