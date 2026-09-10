/**
 * The timeline's draw list: the canvas primitives for one timeline section
 * at one size, and the function that paints them.
 *
 * Split in two on purpose. {@link buildTimelineDrawList} is pure: it reads
 * the section the derivation produced and lays it out in CSS pixels, so the
 * geometry is testable with no canvas and the cost of a live draw is a
 * measurement rather than a claim. {@link paintTimeline} is the only part
 * that touches a rendering context, and it does nothing but replay the list
 * at the device pixel ratio the list was built for.
 *
 * Nothing here computes a number the document does not carry. A bar's height
 * is a series value over the series' own peak, a band's edges are the
 * interval's own, and an absent chart draws its own statement as a label
 * where its bars would have been, so a quiet row is never read as a quiet
 * pipeline.
 */

import type {
  TimelineChart,
  TimelineInterval,
  TimelineSection,
  TimelineSeries,
} from "../trace/diagnose/types.ts";
import { BAND_COLORS, CANVAS_COLORS, seriesColor } from "./timelinePalette.ts";

/** The size the list is laid out at, in CSS pixels, and the ratio it is painted at. */
export interface TimelineLayout {
  width: number;
  devicePixelRatio: number;
  /**
   * A span to lay the plot out against instead of the section's own, in
   * milliseconds. Compare mode lays two runs out to the longer one's span,
   * so both share one scale from run start and the shorter run ends where
   * it ended rather than being stretched to match. A span no longer than
   * the section's own changes nothing.
   */
  alignSpanMs?: number;
}

export type DrawPrimitive =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill: string }
  | { kind: "polyline"; points: { x: number; y: number }[]; stroke: string; width: number }
  | { kind: "tick"; x: number; y: number; h: number; stroke: string }
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      fill: string;
      align: "left" | "right" | "center";
      size: number;
    };

/** One chart's row: where it sits, what it draws, and the legend the DOM prints beside it. */
export interface TimelineDrawRow {
  chartId: TimelineChart["id"];
  title: string;
  top: number;
  height: number;
  primitives: DrawPrimitive[];
  /** The chart's own statement when nothing is drawn, so the row is labelled rather than blank. */
  absent: string | null;
  legend: TimelineLegendEntry[];
}

export interface TimelineLegendEntry {
  seriesId: string;
  label: string;
  color: string;
  /** The series' peak and newest value, or the reason it is absent. */
  reading: string;
  recorded: boolean;
  /** Buckets with no sample, which the canvas leaves as gaps. The document's own count. */
  unsampled: number;
}

export interface TimelineDrawList {
  width: number;
  height: number;
  devicePixelRatio: number;
  /** The interval strip: run bands, steady-state ribbon, and the axis extent over them. */
  bands: DrawPrimitive[];
  axis: DrawPrimitive[];
  rows: TimelineDrawRow[];
  /** Every primitive in the list, so a cost gate can bound the draw by a count. */
  primitiveCount: number;
}

/** The left gutter that carries each row's title. */
export const GUTTER_PX = 168;
const RIGHT_PAD_PX = 12;
const BAND_STRIP_PX = 18;
const AXIS_STRIP_PX = 16;
export const ROW_PX = 30;
const ROW_GAP_PX = 4;
const ROW_PAD_PX = 3;
const FONT_PX = 11;
const MIN_PLOT_PX = 120;

export function buildTimelineDrawList(section: TimelineSection, layout: TimelineLayout): TimelineDrawList {
  const width = Math.max(GUTTER_PX + MIN_PLOT_PX + RIGHT_PAD_PX, Math.floor(layout.width));
  const plotX = GUTTER_PX;
  const plotWidth = (width - GUTTER_PX - RIGHT_PAD_PX) * plotShare(section, layout);
  const bands = bandStrip(section, plotX, plotWidth);
  const axis = axisStrip(section, plotX, plotWidth, BAND_STRIP_PX);
  const rows: TimelineDrawRow[] = [];
  let top = BAND_STRIP_PX + AXIS_STRIP_PX;
  let primitiveCount = bands.length + axis.length;
  for (const chart of section.charts) {
    const row = rowOf(chart, top, plotX, plotWidth);
    rows.push(row);
    primitiveCount += row.primitives.length;
    top += ROW_PX + ROW_GAP_PX;
  }
  return {
    width,
    height: rows.length > 0 ? top - ROW_GAP_PX : top,
    devicePixelRatio: layout.devicePixelRatio,
    bands,
    axis,
    rows,
    primitiveCount,
  };
}

function plotShare(section: TimelineSection, layout: TimelineLayout): number {
  const own = section.axis.spanMs;
  const shared = layout.alignSpanMs;
  if (shared === undefined || !(shared > own) || !(own > 0)) return 1;
  return own / shared;
}

// ---------------------------------------------------------------------------
// The interval strip and the axis
// ---------------------------------------------------------------------------

/**
 * Scaled to the whole retained span rather than to the axis below, so an
 * open, a pan and the quiet stretch between them read as annotations on one
 * line. The stretch the charts cover is marked on the strip, because on a
 * long recording it is a sliver.
 */
function bandStrip(section: TimelineSection, plotX: number, plotWidth: number): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  const intervals = section.intervals;
  const axis = section.axis;
  const startMs = Math.min(axis.startMs, ...intervals.map((interval) => interval.startMs));
  const endMs = Math.max(axis.endMs, ...intervals.map((interval) => interval.endMs));
  const spanMs = Math.max(1, endMs - startMs);
  const xOf = (ms: number): number => plotX + ((ms - startMs) / spanMs) * plotWidth;

  out.push({
    kind: "text",
    x: plotX - 8,
    y: BAND_STRIP_PX / 2,
    text: "runs",
    fill: CANVAS_COLORS.dim,
    align: "right",
    size: FONT_PX,
  });
  for (const interval of intervals) {
    const x = xOf(interval.startMs);
    const w = Math.max(2, xOf(interval.endMs) - x);
    const isRun = interval.kind === "run";
    out.push({
      kind: "rect",
      x,
      y: isRun ? 2 : BAND_STRIP_PX / 2 - 2,
      w,
      h: isRun ? BAND_STRIP_PX - 4 : 4,
      fill: interval.current ? BAND_COLORS.current : BAND_COLORS[interval.kind],
    });
    if (isRun && w > 24) {
      out.push({
        kind: "text",
        x: x + 3,
        y: BAND_STRIP_PX / 2,
        text: bandLabel(interval),
        fill: interval.current ? CANVAS_COLORS.background : CANVAS_COLORS.text,
        align: "left",
        size: FONT_PX - 1,
      });
    }
  }
  const from = xOf(axis.startMs);
  const to = xOf(axis.endMs);
  out.push({ kind: "rect", x: from, y: BAND_STRIP_PX - 2, w: Math.max(2, to - from), h: 2, fill: CANVAS_COLORS.text });
  return out;
}

function bandLabel(interval: TimelineInterval): string {
  const source = interval.cause?.source ?? "steady state";
  return interval.endReason === null ? `${source} (open)` : source;
}

function axisStrip(
  section: TimelineSection,
  plotX: number,
  plotWidth: number,
  top: number,
): DrawPrimitive[] {
  const axis = section.axis;
  const out: DrawPrimitive[] = [];
  const divisions = 6;
  for (let i = 0; i <= divisions; i += 1) {
    const x = plotX + (i / divisions) * plotWidth;
    const ms = axis.startMs + (i / divisions) * axis.spanMs;
    out.push({ kind: "tick", x, y: top, h: 4, stroke: CANVAS_COLORS.grid });
    out.push({
      kind: "text",
      x,
      y: top + AXIS_STRIP_PX / 2 + 3,
      text: `${Math.round(ms)} ms`,
      fill: CANVAS_COLORS.dim,
      align: i === 0 ? "left" : i === divisions ? "right" : "center",
      size: FONT_PX - 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

function rowOf(chart: TimelineChart, top: number, plotX: number, plotWidth: number): TimelineDrawRow {
  const primitives: DrawPrimitive[] = [
    { kind: "rect", x: plotX, y: top, w: plotWidth, h: ROW_PX, fill: CANVAS_COLORS.row },
    {
      kind: "text",
      x: plotX - 8,
      y: top + ROW_PX / 2,
      text: chart.title,
      fill: chart.recorded ? CANVAS_COLORS.text : CANVAS_COLORS.dim,
      align: "right",
      size: FONT_PX,
    },
  ];
  const legend = chart.series.map((series) => legendOf(chart, series));
  if (!chart.recorded) {
    primitives.push({
      kind: "text",
      x: plotX + 6,
      y: top + ROW_PX / 2,
      text: `absent — ${chart.statement}`,
      fill: CANVAS_COLORS.absent,
      align: "left",
      size: FONT_PX - 1,
    });
    return { chartId: chart.id, title: chart.title, top, height: ROW_PX, primitives, absent: chart.statement, legend };
  }

  const recorded = chart.series.filter((series): series is RecordedSeries => series.recorded);
  const plot = { x: plotX, y: top + ROW_PAD_PX, w: plotWidth, h: ROW_PX - ROW_PAD_PX * 2 };
  switch (chart.kind) {
    case "line":
      for (const series of recorded) primitives.push(...polyline(chart, series, plot));
      break;
    case "marks":
      primitives.push(...marks(chart, recorded, plot));
      break;
    default:
      primitives.push(...stackedBars(chart, recorded, plot));
  }
  return { chartId: chart.id, title: chart.title, top, height: ROW_PX, primitives, absent: null, legend };
}

type RecordedSeries = Extract<TimelineSeries, { recorded: true }>;

interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Scaled to the tallest stack, so the row reads as a shape and the legend
 * carries the peak. A bucket with no sample adds nothing to the stack.
 */
function stackedBars(chart: TimelineChart, series: RecordedSeries[], plot: Plot): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  const buckets = series[0]?.values.length ?? 0;
  if (buckets === 0) return out;
  const totals = new Float64Array(buckets);
  for (const one of series) {
    for (let b = 0; b < buckets; b += 1) totals[b] += one.values[b] ?? 0;
  }
  let peak = 0;
  for (let b = 0; b < buckets; b += 1) peak = Math.max(peak, totals[b]);
  if (peak <= 0) return out;
  const bucketWidth = plot.w / buckets;
  const barWidth = Math.max(1, bucketWidth - (bucketWidth > 3 ? 1 : 0));
  for (let b = 0; b < buckets; b += 1) {
    let stacked = 0;
    for (const one of series) {
      const value = one.values[b];
      if (value === null || value <= 0) continue;
      const h = (value / peak) * plot.h;
      out.push({
        kind: "rect",
        x: plot.x + b * bucketWidth,
        y: plot.y + plot.h - stacked - h,
        w: barWidth,
        h,
        fill: seriesColor(chart.id, one.id),
      });
      stacked += h;
    }
  }
  return out;
}

/**
 * A held reading as a line over its own peak, broken where a bucket has no
 * sample: a gap is what an unmeasured stretch looks like, and joining across
 * it would draw a value nothing recorded.
 */
function polyline(chart: TimelineChart, series: RecordedSeries, plot: Plot): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  const buckets = series.values.length;
  if (buckets === 0 || series.max <= 0) return out;
  const bucketWidth = plot.w / buckets;
  const stroke = seriesColor(chart.id, series.id);
  let points: { x: number; y: number }[] = [];
  const flush = (): void => {
    if (points.length === 1) {
      // A one-point line is invisible, so a lone sampled bucket draws as a
      // bar of its height.
      out.push({ kind: "rect", x: points[0].x - 1, y: points[0].y, w: 2, h: plot.y + plot.h - points[0].y, fill: stroke });
    } else if (points.length > 1) {
      out.push({ kind: "polyline", points, stroke, width: 1.5 });
    }
    points = [];
  };
  for (let b = 0; b < buckets; b += 1) {
    const value = series.values[b];
    if (value === null) {
      flush();
      continue;
    }
    points.push({
      x: plot.x + (b + 0.5) * bucketWidth,
      y: plot.y + plot.h - (value / series.max) * plot.h,
    });
  }
  flush();
  return out;
}

function marks(chart: TimelineChart, series: RecordedSeries[], plot: Plot): DrawPrimitive[] {
  const out: DrawPrimitive[] = [];
  const buckets = series[0]?.values.length ?? 0;
  if (buckets === 0) return out;
  const bucketWidth = plot.w / buckets;
  const peak = Math.max(1, ...series.map((one) => one.max));
  series.forEach((one, index) => {
    const stroke = seriesColor(chart.id, one.id);
    // Each kind gets its own sub-pixel offset so two kinds in one bucket
    // stay distinguishable rather than painting over each other.
    const offset = (index / Math.max(1, series.length - 1) - 0.5) * Math.min(4, bucketWidth * 0.5);
    for (let b = 0; b < buckets; b += 1) {
      const value = one.values[b];
      if (value === null || value <= 0) continue;
      const h = Math.max(4, (value / peak) * plot.h);
      out.push({ kind: "tick", x: plot.x + (b + 0.5) * bucketWidth + offset, y: plot.y + plot.h - h, h, stroke });
    }
  });
  return out;
}

function legendOf(chart: TimelineChart, series: TimelineSeries): TimelineLegendEntry {
  if (!series.recorded) {
    return {
      seriesId: series.id,
      label: series.label,
      color: seriesColor(chart.id, series.id),
      reading: `absent: ${series.statement}`,
      recorded: false,
      unsampled: 0,
    };
  }
  const last = series.last === null ? "" : ` · last ${format(series.last)}`;
  return {
    seriesId: series.id,
    label: series.label,
    color: seriesColor(chart.id, series.id),
    reading: `max ${format(series.max)}${last} ${chart.unit}`,
    recorded: true,
    unsampled: series.unsampled,
  };
}

/**
 * Thousands grouped by hand rather than through the locale formatter, which
 * costs tens of microseconds a call and runs twice per series on every poll.
 */
function format(value: number): string {
  const text = String(value);
  if (!Number.isInteger(value) || Math.abs(value) < 1_000) return text;
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/**
 * The canvas backing store for a list: the CSS size times the device pixel
 * ratio the list was built for, so a retina display draws crisp bars rather
 * than a scaled-up bitmap. One place, read by the element's attributes and
 * by the paint.
 */
export function backingStoreSize(list: TimelineDrawList): { width: number; height: number; ratio: number } {
  const ratio = Math.max(1, list.devicePixelRatio);
  return { width: Math.round(list.width * ratio), height: Math.round(list.height * ratio), ratio };
}

/** Replay the list on a context, sizing the store and setting the transform first. */
export function paintTimeline(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  list: TimelineDrawList,
): void {
  const store = backingStoreSize(list);
  canvas.width = store.width;
  canvas.height = store.height;
  ctx.setTransform(store.ratio, 0, 0, store.ratio, 0, 0);
  ctx.fillStyle = CANVAS_COLORS.background;
  ctx.fillRect(0, 0, list.width, list.height);
  ctx.textBaseline = "middle";
  for (const primitive of list.bands) paint(ctx, primitive);
  for (const primitive of list.axis) paint(ctx, primitive);
  for (const row of list.rows) for (const primitive of row.primitives) paint(ctx, primitive);
}

function paint(ctx: CanvasRenderingContext2D, primitive: DrawPrimitive): void {
  switch (primitive.kind) {
    case "rect":
      ctx.fillStyle = primitive.fill;
      ctx.fillRect(primitive.x, primitive.y, primitive.w, primitive.h);
      return;
    case "polyline": {
      ctx.strokeStyle = primitive.stroke;
      ctx.lineWidth = primitive.width;
      ctx.beginPath();
      primitive.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
      return;
    }
    case "tick":
      ctx.strokeStyle = primitive.stroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(primitive.x) + 0.5, primitive.y);
      ctx.lineTo(Math.round(primitive.x) + 0.5, primitive.y + primitive.h);
      ctx.stroke();
      return;
    case "text":
      ctx.fillStyle = primitive.fill;
      ctx.font = `${primitive.size}px system-ui, sans-serif`;
      ctx.textAlign = primitive.align;
      ctx.fillText(primitive.text, primitive.x, primitive.y);
      return;
  }
}
