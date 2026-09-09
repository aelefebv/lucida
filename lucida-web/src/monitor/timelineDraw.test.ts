/**
 * The draw list, over the derivation's fixture runs.
 *
 * The list is the geometry of what the canvas paints, so these cases are
 * about what is drawn and what is not: an absent chart draws its label and
 * no bars, a bucket with no sample is a gap and never a zero, a retina
 * layout keeps CSS coordinates and doubles the backing store, and the list
 * is bounded by the charts and buckets rather than by the run's rows.
 */

import { describe, expect, it } from "vitest";

import { diagnoseRun } from "../trace/diagnose/diagnose.ts";
import {
  coldRemoteOpen,
  healthyLocalOpen,
  lateStallOpen,
  makeReading,
  makeRun,
  mainThreadOnlyOpen,
  saturatedReopen,
} from "../trace/diagnose/fixtures.ts";
import { TIMELINE_BUCKETS, TIMELINE_CHARTS } from "../trace/diagnose/timeline.ts";
import type { TimelineSection } from "../trace/diagnose/types.ts";
import {
  brushWindow,
  buildTimelineDrawList,
  GUTTER_PX,
  msAtX,
  ROW_PX,
  xAtMs,
  type DrawPrimitive,
} from "./timelineDraw.ts";
import { PHASE_COLORS, seriesColor } from "./timelinePalette.ts";

const MS = 1_000;

function row(section: TimelineSection, chartId: string, width = 1_000) {
  const list = buildTimelineDrawList(section, { width, devicePixelRatio: 1 });
  const found = list.rows.find((candidate) => candidate.chartId === chartId);
  if (!found) throw new Error(`no row ${chartId}`);
  return found;
}

function texts(primitives: DrawPrimitive[]): string[] {
  return primitives.flatMap((primitive) => (primitive.kind === "text" ? [primitive.text] : []));
}

describe("one row per chart", () => {
  it("lays the closed set out in order, one row each, under the bands and the axis", () => {
    const list = buildTimelineDrawList(diagnoseRun(coldRemoteOpen()).timeline, { width: 1_000, devicePixelRatio: 1 });

    expect(list.rows.map((entry) => entry.chartId)).toEqual(TIMELINE_CHARTS.map((entry) => entry.id));
    for (let i = 1; i < list.rows.length; i += 1) {
      expect(list.rows[i].top).toBeGreaterThan(list.rows[i - 1].top);
    }
    expect(list.height).toBe(list.rows[list.rows.length - 1].top + ROW_PX);
    expect(list.height).toBeGreaterThan(TIMELINE_CHARTS.length * ROW_PX);
    for (const entry of list.rows) expect(texts(entry.primitives)).toContain(entry.title);
  });

  it("labels an absent chart as absent where its bars would be, and draws no bars", () => {
    const received = row(diagnoseRun(healthyLocalOpen()).timeline, "bytes.received");

    expect(received.absent).toMatch(/not recorded/);
    expect(received.primitives.filter((primitive) => primitive.kind === "rect")).toHaveLength(1);
    expect(texts(received.primitives).some((text) => text.startsWith("absent"))).toBe(true);
  });

  it("names an absent series in the legend of a chart that is otherwise drawn", () => {
    const frame = row(diagnoseRun(mainThreadOnlyOpen()).timeline, "frame");

    expect(frame.absent).toBeNull();
    const gpu = frame.legend.find((entry) => entry.seriesId === "gpu-pass");
    expect(gpu).toMatchObject({ recorded: false });
    expect(gpu?.reading).toMatch(/^absent: the adapter offers no timestamp queries/);
    expect(frame.legend.find((entry) => entry.seriesId === "main-thread")?.reading).toMatch(/^max 3\.5 .*ms$/);
  });
});

describe("gaps are gaps", () => {
  it("breaks a held reading's line where a bucket has no sample and counts the gaps in the legend", () => {
    // Readings at 100 ms and 700 ms of 1.2 s: the buckets before the first
    // reading have no value, and the line starts where the first one lands.
    const run = makeRun({
      header: { durationUs: 1_200 * MS },
      readings: [
        makeReading(100 * MS, { queueDepth: 5, inFlight: 2 }),
        makeReading(700 * MS, { queueDepth: 0, inFlight: 1 }),
      ],
    });
    const inFlight = row(diagnoseRun(run).timeline, "in-flight");
    const lines = inFlight.primitives.filter((primitive) => primitive.kind === "polyline");

    expect(lines.length).toBeGreaterThan(0);
    const plotWidth = 1_000 - GUTTER_PX - 12;
    const firstX = Math.min(...lines.map((line) => line.points[0].x));
    // Nothing is drawn over the first tenth of the axis.
    expect(firstX).toBeGreaterThan(GUTTER_PX + plotWidth * 0.08);
    // The count is the document's own, not the legend's.
    expect(inFlight.legend.find((entry) => entry.seriesId === "in-flight")?.unsampled).toBe(10);
  });

  it("draws a frame time only in the buckets a reading landed in", () => {
    const frame = row(diagnoseRun(saturatedReopen()).timeline, "frame");
    const drawn = frame.primitives.filter((primitive) => primitive.kind === "polyline" || primitive.kind === "rect");
    // One background rect plus the drawn buckets, which are fewer than the axis has.
    expect(drawn.length).toBeGreaterThan(1);
    expect(frame.legend.find((entry) => entry.seriesId === "main-thread")?.unsampled).toBeGreaterThan(0);
  });
});

describe("the bands", () => {
  it("draws a run as a labelled band and the run being read in its own colour", () => {
    const list = buildTimelineDrawList(diagnoseRun(healthyLocalOpen()).timeline, { width: 1_000, devicePixelRatio: 1 });

    const labels = texts(list.bands);
    expect(labels).toContain("dataset_added");
    expect(list.bands.some((primitive) => primitive.kind === "rect" && primitive.fill === "#6f8fd1")).toBe(true);
  });

  it("draws a steady-state interval as unlabelled ribbon", () => {
    const section = diagnoseRun(healthyLocalOpen()).timeline;
    section.intervals.unshift({
      runId: "steady-0",
      kind: "steady-state",
      current: false,
      cause: null,
      endReason: "run-opened",
      startMs: -2_000,
      endMs: 0,
    });
    const list = buildTimelineDrawList(section, { width: 1_000, devicePixelRatio: 1 });

    expect(texts(list.bands)).not.toContain("steady state");
    const ribbon = list.bands.find((primitive) => primitive.kind === "rect" && primitive.fill === "#262626");
    expect(ribbon).toBeDefined();
    if (ribbon?.kind === "rect") expect(ribbon.h).toBeLessThan(6);
  });
});

describe("the palette", () => {
  it("colours a browser phase the way the live bar and the overlay colour it", () => {
    const browser = row(diagnoseRun(healthyLocalOpen()).timeline, "occupancy.browser");
    const fills = new Set(
      browser.primitives.flatMap((primitive) => (primitive.kind === "rect" ? [primitive.fill] : [])),
    );
    expect(fills.has(PHASE_COLORS.wire)).toBe(true);
    expect(seriesColor("occupancy.browser", "wire")).toBe(PHASE_COLORS.wire);
    expect(browser.legend.find((entry) => entry.seriesId === "wire")?.color).toBe(PHASE_COLORS.wire);
  });
});

describe("device pixel ratio", () => {
  it("keeps CSS coordinates and records the ratio the backing store is scaled by", () => {
    const section = diagnoseRun(coldRemoteOpen()).timeline;
    const one = buildTimelineDrawList(section, { width: 1_000, devicePixelRatio: 1 });
    const two = buildTimelineDrawList(section, { width: 1_000, devicePixelRatio: 2 });

    expect(two.width).toBe(one.width);
    expect(two.height).toBe(one.height);
    expect(two.devicePixelRatio).toBe(2);
    expect(two.rows[0].primitives).toEqual(one.rows[0].primitives);
  });

  it("never lays out narrower than the gutter and a readable plot", () => {
    const list = buildTimelineDrawList(diagnoseRun(coldRemoteOpen()).timeline, { width: 10, devicePixelRatio: 1 });
    expect(list.width).toBeGreaterThan(GUTTER_PX + 100);
  });
});

describe("the axis scale", () => {
  it("maps a CSS x on the plot to milliseconds on the run's clock and back, clamped to the axis", () => {
    const list = buildTimelineDrawList(diagnoseRun(lateStallOpen()).timeline, { width: 1_000, devicePixelRatio: 1 });
    const plotWidth = 1_000 - GUTTER_PX - 12;

    expect(list.scale).toEqual({ plotX: GUTTER_PX, plotWidth, startMs: 0, spanMs: 2_000 });
    expect(msAtX(list.scale, GUTTER_PX)).toBe(0);
    expect(msAtX(list.scale, GUTTER_PX + plotWidth / 2)).toBe(1_000);
    expect(msAtX(list.scale, GUTTER_PX + plotWidth)).toBe(2_000);
    // The gutter and anything past the plot clamp to the axis's ends.
    expect(msAtX(list.scale, 0)).toBe(0);
    expect(msAtX(list.scale, 5_000)).toBe(2_000);
    expect(xAtMs(list.scale, 1_000)).toBe(GUTTER_PX + plotWidth / 2);
    expect(xAtMs(list.scale, 2_000)).toBe(GUTTER_PX + plotWidth);
  });

  it("follows the axis the section was derived over, so a windowed section maps its own stretch", () => {
    const section = diagnoseRun(lateStallOpen(), { window: { startMs: 1_100, endMs: 2_000 } }).timeline;
    const list = buildTimelineDrawList(section, { width: 1_000, devicePixelRatio: 1 });

    expect(list.scale.startMs).toBe(1_100);
    expect(list.scale.spanMs).toBe(900);
    expect(msAtX(list.scale, GUTTER_PX)).toBe(1_100);
  });

  it("turns a drag into a window in whole milliseconds, whichever way it was dragged, and refuses a click", () => {
    const list = buildTimelineDrawList(diagnoseRun(lateStallOpen()).timeline, { width: 1_000, devicePixelRatio: 1 });
    const from = xAtMs(list.scale, 1_100.4);
    const to = xAtMs(list.scale, 1_999.6);

    expect(brushWindow(list.scale, from, to)).toEqual({ startMs: 1_100, endMs: 2_000 });
    expect(brushWindow(list.scale, to, from)).toEqual({ startMs: 1_100, endMs: 2_000 });
    // A drag that starts in the gutter or runs off the plot clamps to the axis.
    expect(brushWindow(list.scale, 0, 5_000)).toEqual({ startMs: 0, endMs: 2_000 });
    // A click, or a drag under a millisecond, brushes nothing.
    expect(brushWindow(list.scale, from, from)).toBeNull();
    expect(brushWindow(list.scale, from, from + 0.01)).toBeNull();
  });
});

describe("the list is bounded", () => {
  it("grows with the charts and buckets, not with the run's rows", () => {
    const small = buildTimelineDrawList(diagnoseRun(healthyLocalOpen()).timeline, { width: 1_000, devicePixelRatio: 1 });
    const large = buildTimelineDrawList(diagnoseRun(saturatedReopen()).timeline, { width: 1_000, devicePixelRatio: 1 });
    const seriesCount = (section: TimelineSection): number =>
      section.charts.reduce((total, chart) => total + chart.series.length, 0);

    const ceiling = (section: TimelineSection): number =>
      // Each series can draw at most one primitive per bucket, plus the
      // titles, backgrounds, bands and axis labels.
      seriesCount(section) * TIMELINE_BUCKETS + section.charts.length * 3 + 64;
    expect(small.primitiveCount).toBeLessThan(ceiling(diagnoseRun(healthyLocalOpen()).timeline));
    expect(large.primitiveCount).toBeLessThan(ceiling(diagnoseRun(saturatedReopen()).timeline));
  });
});
