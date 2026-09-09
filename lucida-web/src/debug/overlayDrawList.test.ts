/**
 * The overlay's draw list, asserted from fixture documents: the derivation
 * reads the rows, the draw list reads the derivation, and the colors it
 * hands back are the timeline's palette. No browser, no cache, no recorder.
 */

import { describe, expect, it } from "vitest";

import {
  PHASE_COLORS,
  PLANNED_COLOR,
  ROW_STATE_COLORS,
  seriesColor,
  withAlpha,
} from "../monitor/timelinePalette.ts";
import { lookupChunk } from "../trace/diagnose/chunkLookup.ts";
import { chunkIdentity, deriveChunkStates, type ChunkStates } from "../trace/diagnose/chunkStates.ts";
import {
  healthyLocalOpen,
  makeRow,
  makeRun,
  refetchLoopSteadyState,
  saturatedReopen,
} from "../trace/diagnose/fixtures.ts";
import { PHASES, type TraceRun } from "../trace/types.ts";
import {
  buildChunkDrawList,
  CELL_BORDER,
  CHURN_BANDS,
  churnBand,
  churnWindowLabel,
  describeHoverInspector,
  hitTestChunk,
  NO_ROW_FILL,
  overlayAbsence,
  PHASE_FILL_ALPHA,
  type ChunkCell,
  type OverlayModes,
} from "./overlayDrawList.ts";

const MS = 1_000;

const OFF: OverlayModes = {
  chunkTier: false,
  cachedTier: false,
  plannedRank: false,
  phaseColor: false,
  churnTint: false,
};

/** A cell for one of the fixture's rows: level 1, along y, x 0, on the row's member. */
function cell(y: number, overrides: Partial<ChunkCell> = {}): ChunkCell {
  return {
    key: `ds/member-${y % 8}/detail/1/0/0/0/${y}/0`,
    datasetId: "ds",
    entityId: `member-${y % 8}`,
    chunkKey: `1/0/0/0/${y}/0`,
    level: 1,
    t: 0,
    c: 0,
    z: 0,
    y,
    x: 0,
    left: 0,
    top: y * 10,
    width: 10,
    height: 10,
    status: "cached",
    sourceTier: "detail",
    ...overrides,
  };
}

function readerOver(states: ChunkStates) {
  return (c: ChunkCell) => states.byIdentity.get(chunkIdentity(c.datasetId, c.entityId, c.chunkKey)) ?? null;
}

function drawOver(run: TraceRun, cells: ChunkCell[], modes: Partial<OverlayModes>) {
  const states = deriveChunkStates(run);
  return {
    states,
    list: buildChunkDrawList({ cells, modes: { ...OFF, ...modes }, readingOf: readerOver(states), windowMs: states.windowMs }),
  };
}

describe("phase color", () => {
  it("paints each cell with the shared palette's color for the phase its newest row is in", () => {
    const { list } = drawOver(saturatedReopen(), [cell(0), cell(300)], { phaseColor: true });

    // Row 0 completed; row 300 is still in the queue.
    expect(list.items[0].fill).toBe(withAlpha(ROW_STATE_COLORS.complete, PHASE_FILL_ALPHA));
    expect(list.items[1].fill).toBe(withAlpha(PHASE_COLORS.queue, PHASE_FILL_ALPHA));
    expect(list.items[1].tooltip).toContain("phase queue");
    expect(list.withRow).toBe(2);
  });

  it("reads the one table the timeline reads: a phase is one color in space and in time", () => {
    // The timeline's occupancy chart and the dock's live bar both take a
    // phase's color from PHASE_COLORS; the overlay takes it from the row
    // state table, whose phase entries are those same entries.
    for (const phase of PHASES) {
      expect(ROW_STATE_COLORS[phase]).toBe(PHASE_COLORS[phase]);
      expect(seriesColor("occupancy.browser", phase)).toBe(PHASE_COLORS[phase]);
    }
    expect(ROW_STATE_COLORS.unstamped).toBe(PLANNED_COLOR);

    const rows = [
      makeRow({ startUs: 10 * MS, durations: { plan: 100, queue: MS, wire: 5 * MS }, outcome: "in-flight" }, 0),
    ];
    const { list } = drawOver(makeRun({ header: { durationUs: 100 * MS }, rows }), [cell(0)], { phaseColor: true });
    const hex = PHASE_COLORS.decode;
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    // The rgba the overlay paints is the timeline's hex with an alpha, nothing else.
    expect(list.items[0].fill).toBe(`rgba(${r}, ${g}, ${b}, ${PHASE_FILL_ALPHA})`);
    expect(list.items[0].fill).toBe(withAlpha(seriesColor("occupancy.browser", "decode"), PHASE_FILL_ALPHA));
  });

  it("leaves a cell with no row unpainted and says why, rather than giving it a phase", () => {
    const { list } = drawOver(healthyLocalOpen(), [cell(999)], { phaseColor: true });

    expect(list.items[0].fill).toBe(NO_ROW_FILL);
    expect(list.items[0].border).not.toBe(CELL_BORDER);
    expect(list.items[0].reading).toBeNull();
    expect(list.items[0].tooltip).toContain("no row in the open interval");
    expect(list.items[0].tooltip).toContain("resident before it opened, still queued, or never wanted");
    expect(list.withRow).toBe(0);
  });
});

describe("churn tint", () => {
  const loopCells = () =>
    Array.from({ length: 12 }, (_, chunk) =>
      cell(chunk, {
        key: `loop-${chunk}`,
        entityId: "member-1",
        chunkKey: `1/0/0/0/${chunk}/0`,
        y: chunk,
      }),
    );

  it("tints each chunk by how many times the window fetched it, and states the window", () => {
    const run = healthyLocalOpen();
    const { list, states } = drawOver(refetchLoopSteadyState(run), [...loopCells(), cell(500, { key: "never" })], {
      churnTint: true,
    });

    const three = churnBand(3)!;
    for (const item of list.items.slice(0, 12)) {
      expect(item.fill).toBe(three.fill);
      expect(item.tooltip).toContain(`fetched 3× ${churnWindowLabel(states.windowMs)}`);
      expect(item.tooltip).toContain("8.0 s");
    }
    expect(list.churned).toBe(12);
    expect(list.items[12].fill).toBe(NO_ROW_FILL);
  });

  it("bands the count so a loop reads at a glance, with one fetch barely tinted", () => {
    expect(churnBand(0)).toBeNull();
    expect(churnBand(1)?.label).toBe("1 fetch");
    expect(churnBand(2)?.label).toBe("2 fetches");
    expect(churnBand(3)?.label).toBe("3 fetches");
    expect(churnBand(9)?.label).toBe("4 or more fetches");
    expect(CHURN_BANDS.map((band) => band.minFetches)).toEqual([4, 3, 2, 1]);
  });

  it("draws churn as the border when phase color has the fill", () => {
    const { list } = drawOver(refetchLoopSteadyState(healthyLocalOpen()), loopCells(), {
      phaseColor: true,
      churnTint: true,
    });
    expect(list.items[0].fill).toBe(withAlpha(ROW_STATE_COLORS.complete, PHASE_FILL_ALPHA));
    expect(list.items[0].border).toBe(churnBand(3)!.border);
    expect(list.items[0].tooltip).toContain("phase complete");
    expect(list.items[0].tooltip).toContain("fetched 3×");
  });

  it("states that no interval is open instead of inventing a window", () => {
    expect(churnWindowLabel(null)).toBe("no interval open");
    expect(churnWindowLabel(12_340)).toBe("over the open interval, 12.3 s");
  });
});

describe("the cache modes", () => {
  it("never ask the trace for a reading, and color as the grid always has", () => {
    let asked = 0;
    const list = buildChunkDrawList({
      cells: [cell(0), cell(1, { status: "in-flight" }), cell(2, { status: "planned", priorityRank: 3 })],
      modes: { ...OFF, plannedRank: true },
      readingOf: () => {
        asked += 1;
        return null;
      },
      windowMs: null,
    });
    expect(asked).toBe(0);
    expect(list.items.map((item) => item.fill)).toEqual([
      "rgba(80, 220, 120, 0.30)",
      "rgba(240, 200, 70, 0.35)",
      "rgba(255, 180, 60, 0.50)",
    ]);
    expect(list.items[2].tooltip).toBe("detail · planned · queue rank 3");
  });
});

describe("hover", () => {
  it("picks the smallest cell under the pointer, so a detail chunk wins over the coarse one behind it", () => {
    const { list } = drawOver(healthyLocalOpen(), [
      cell(0, { key: "coarse", left: 0, top: 0, width: 40, height: 40, sourceTier: "coarse" }),
      cell(1, { key: "detail", left: 0, top: 0, width: 10, height: 10 }),
    ], {});
    expect(hitTestChunk(list.items, 5, 5)?.key).toBe("detail");
    expect(hitTestChunk(list.items, 30, 30)?.key).toBe("coarse");
    expect(hitTestChunk(list.items, 50, 50)).toBeNull();
  });

  it("shows phase, queue rank and age from the chunk lookup, with the fetch count and its window", () => {
    const run = healthyLocalOpen();
    const { list, states } = drawOver(run, [cell(119)], { phaseColor: true, churnTint: true });
    const lookup = lookupChunk(run, "member-7/1/0/0/0/119/0", "under the pointer");

    const view = describeHoverInspector(list.items[0], lookup, states.windowMs);
    expect(view.title).toBe("member-7 · 1/0/0/0/119/0");
    expect(view.lines).toEqual([
      "detail · cached",
      "phase: complete · present took 2 ms",
      "queue rank: 9 ahead at admission · 0 overtook it · waited 2 ms",
      "age: 247 ms",
      "fetched once over the open interval, 0.3 s",
      "ranks and ages count recorded rows only",
    ]);
  });

  it("says when the chunk has no row, and when no interval is open", () => {
    const { list, states } = drawOver(healthyLocalOpen(), [cell(999)], { phaseColor: true });
    const missing = lookupChunk(healthyLocalOpen(), "member-7/1/0/0/0/999/0", "under the pointer");

    const noRow = describeHoverInspector(list.items[0], missing, states.windowMs);
    expect(noRow.lines[1]).toBe("no row in the open interval: resident before it opened, still queued, or never wanted");

    const noInterval = describeHoverInspector(list.items[0], null, null);
    expect(noInterval.lines[1]).toBe("no interval open, so no row to read");
  });

  it("keeps the first line as the cell's status, whichever cache modes are on", () => {
    const { list, states } = drawOver(
      healthyLocalOpen(),
      [cell(3, { status: "planned", priorityRank: 12, sourceTier: undefined })],
      { plannedRank: true, phaseColor: true },
    );
    const view = describeHoverInspector(
      list.items[0],
      lookupChunk(healthyLocalOpen(), "member-3/1/0/0/0/3/0", "under the pointer"),
      states.windowMs,
    );
    expect(view.lines[0]).toBe("planned · queue rank 12");
    expect(view.lines[1]).toBe("phase: complete · present took 2 ms");
  });

  it("takes the phase and the age from the newest row when the lookup's list is capped", () => {
    // Twenty fetches of one chunk: the lookup lists the sixteen oldest, all
    // complete, and the newest is still on the wire. The cell's color came
    // from that newest row, so the inspector has to agree with it.
    const rows = Array.from({ length: 20 }, (_, i) =>
      makeRow(
        i < 19
          ? { startUs: (10 + i * 5) * MS, durations: { plan: 100, queue: MS, wire: 2 * MS, decode: 100, upload: 100, present: 100 } }
          : { startUs: 200 * MS, durations: { plan: 100, queue: MS }, outcome: "in-flight" },
        0,
      ),
    );
    const run = makeRun({ header: { durationUs: 300 * MS }, rows });
    const { list, states } = drawOver(run, [cell(0)], { phaseColor: true, churnTint: true });
    const lookup = lookupChunk(run, "member-0/1/0/0/0/0/0", "under the pointer");
    expect(lookup.rows).toHaveLength(16);

    const view = describeHoverInspector(list.items[0], lookup, states.windowMs);
    expect(list.items[0].fill).toBe(withAlpha(PHASE_COLORS.wire, PHASE_FILL_ALPHA));
    expect(view.lines[1]).toBe("phase: in wire");
    expect(view.lines[2]).toMatch(/^queue rank of the newest listed row: /);
    expect(view.lines[3]).toBe("age: 100 ms");
    expect(view.lines[4]).toBe("fetched 19× over the open interval, 0.3 s");
    expect(view.lines[5]).toBe("20 rows carry this chunk; the 16 oldest are listed, and the newest is not among them");
  });

  it("names a row still in the queue as waiting, with its rank now", () => {
    const run = saturatedReopen();
    const { list, states } = drawOver(run, [cell(300)], { phaseColor: true });
    const view = describeHoverInspector(
      list.items[0],
      lookupChunk(run, "member-4/1/0/0/0/300/0", "under the pointer"),
      states.windowMs,
    );
    expect(view.lines[1]).toBe("phase: in queue · plan took 0 ms");
    expect(view.lines[2]).toBe("queue rank: 170 ahead at admission · 0 overtook it · waited 3.8 s · not dispatched yet");
    expect(view.lines[3]).toBe("age: 3.9 s");
  });
});

describe("what an empty picture means", () => {
  it("says nothing when the trace modes are off, or when the picture has something in it", () => {
    const { list, states } = drawOver(saturatedReopen(), [cell(0)], { phaseColor: true });
    expect(overlayAbsence({ ...OFF, chunkTier: true }, list, states.windowMs)).toBeNull();
    expect(overlayAbsence({ ...OFF, phaseColor: true }, list, states.windowMs)).toBeNull();
  });

  it("names each nothing: no interval, no cell, no row, and no chunk fetched twice", () => {
    const modes = { ...OFF, phaseColor: true, churnTint: true };
    const empty = buildChunkDrawList({ cells: [], modes, readingOf: () => null, windowMs: null });
    expect(overlayAbsence(modes, empty, null)).toContain("no interval is open");
    expect(overlayAbsence(modes, empty, 4_000)).toContain("no chunk on screen to color");

    const { list: noRow, states } = drawOver(healthyLocalOpen(), [cell(999)], modes);
    expect(overlayAbsence(modes, noRow, states.windowMs)).toBe(
      "phase: no chunk on screen has a row in the open interval (0.3 s); " +
        "each was resident before it opened, is still queued, or was never wanted",
    );

    const { list: quiet } = drawOver(healthyLocalOpen(), [cell(0)], { churnTint: true });
    expect(overlayAbsence({ ...OFF, churnTint: true }, quiet, states.windowMs)).toBe(
      "churn: no chunk on screen was fetched more than once in the open interval (0.3 s)",
    );
    // With phase color on, the picture is painted; a quiet churn is not an empty picture.
    const { list: painted } = drawOver(healthyLocalOpen(), [cell(0)], modes);
    expect(overlayAbsence(modes, painted, states.windowMs)).toBeNull();
  });
});
