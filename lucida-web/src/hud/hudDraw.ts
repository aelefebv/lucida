/**
 * Draw one {@link HudView} onto a 2D context.
 *
 * Layout is in CSS pixels and the context is scaled by the device pixel
 * ratio, so the strip is crisp at ratio 2 and the arithmetic is the same at
 * ratio 1. Nothing here reads the view model's sources: it is a function of
 * the view and the box it was given, which is what lets the cost gate drive
 * it with a fake context.
 *
 * The sparklines share the top. Below them the pools, the lanes, and the
 * status column sit side by side when the strip is wide enough and stack
 * when it is not, so a narrow viewport costs height rather than readouts.
 */

import { HUD_COLORS, HUD_HISTORY, type HudSeriesView, type HudTone, type HudView } from "./hudModel.ts";

/** The part of a 2D context the strip uses. A test can fake this. */
export type HudDrawContext = Pick<
  CanvasRenderingContext2D,
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "font"
  | "textBaseline"
  | "textAlign"
  | "globalAlpha"
  | "setTransform"
  | "clearRect"
  | "fillRect"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "closePath"
  | "stroke"
  | "fill"
  | "arc"
  | "fillText"
>;

export interface HudBox {
  width: number;
  height: number;
  dpr: number;
}

const PAD = 8;
const GAP = 8;
const FONT_PX = 11;
const LINE = 15;
const HEADER = 13;
const CHART_H = 44;
const CHAR_W = FONT_PX * 0.62;
const FONT = `${FONT_PX}px ui-monospace, Menlo, Consolas, monospace`;
const BACKGROUND = "rgba(12, 14, 18, 0.8)";
const TEXT = "#e3e6ea";
const MUTED = "#9aa0a6";
const POOLS_W = 336;
const POOL_LABEL_W = 60;
const LANES_W = 200;
const STATUS_MIN = 260;
const BAR_W = 56;

/** How many datasets the levels column lists before it counts the rest. */
export const LEVEL_ROWS_SHOWN = 3;

const SERIES_LINE: Record<HudSeriesView["key"], string> = {
  received: "#64b5f6",
  sent: "#ce93d8",
  frame: "#5ec269",
  gpu: "#4db6ac",
};

type ColumnKind = "pools" | "lanes" | "status";

interface Column {
  kind: ColumnKind;
  x: number;
  w: number;
}

interface Band {
  y: number;
  columns: Column[];
}

interface Layout {
  height: number;
  bands: Band[];
}

function rowsOf(view: HudView): Record<ColumnKind, number> {
  const levelRows =
    Math.min(view.levels.length, LEVEL_ROWS_SHOWN) + (view.levels.length > LEVEL_ROWS_SHOWN ? 1 : 0);
  return {
    pools: view.pools.length,
    lanes: 2 + view.lanes.rows.length + (view.lanes.note ? 1 : 0),
    status: 3 + levelRows,
  };
}

function layout(view: HudView, width: number): Layout {
  const inner = width - 2 * PAD;
  const rows = rowsOf(view);
  const bands: Array<{ rows: number; columns: Column[] }> = [];

  if (inner >= POOLS_W + LANES_W + STATUS_MIN + 2 * GAP) {
    bands.push({
      rows: Math.max(rows.pools, rows.lanes, rows.status),
      columns: [
        { kind: "pools", x: PAD, w: POOLS_W },
        { kind: "lanes", x: PAD + POOLS_W + GAP, w: LANES_W },
        { kind: "status", x: PAD + POOLS_W + LANES_W + 2 * GAP, w: inner - POOLS_W - LANES_W - 2 * GAP },
      ],
    });
  } else if (inner >= POOLS_W + LANES_W + GAP) {
    bands.push({
      rows: Math.max(rows.pools, rows.lanes),
      columns: [
        { kind: "pools", x: PAD, w: POOLS_W },
        { kind: "lanes", x: PAD + POOLS_W + GAP, w: inner - POOLS_W - GAP },
      ],
    });
    bands.push({ rows: rows.status, columns: [{ kind: "status", x: PAD, w: inner }] });
  } else {
    bands.push({ rows: rows.pools, columns: [{ kind: "pools", x: PAD, w: inner }] });
    bands.push({ rows: rows.lanes, columns: [{ kind: "lanes", x: PAD, w: inner }] });
    bands.push({ rows: rows.status, columns: [{ kind: "status", x: PAD, w: inner }] });
  }

  let y = PAD + HEADER + 4 + CHART_H + GAP;
  const placed: Band[] = [];
  for (const band of bands) {
    placed.push({ y, columns: band.columns });
    y += LINE * band.rows + GAP;
  }
  return { height: y - GAP + PAD, bands: placed };
}

/** The strip's height for a view at a width, so the canvas is sized before drawing. */
export function hudHeight(view: HudView, width: number): number {
  return layout(view, width).height;
}

export function drawHud(ctx: HudDrawContext, view: HudView, box: HudBox): void {
  const { width, height, dpr } = box;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = 1;
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  ctx.font = FONT;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  const inner = width - 2 * PAD;
  let y = PAD;

  text(ctx, "pipeline HUD", PAD, y + 10, MUTED, inner / 2);
  const windowText = fit(view.window, inner / 2);
  text(ctx, windowText, width - PAD - windowText.length * CHAR_W, y + 10, MUTED, inner / 2);
  y += HEADER + 4;

  const cellW = (inner - GAP * (view.series.length - 1)) / view.series.length;
  view.series.forEach((series, i) => {
    sparkline(ctx, series, PAD + i * (cellW + GAP), y, cellW, CHART_H);
  });

  for (const band of layout(view, width).bands) {
    for (const column of band.columns) {
      if (column.kind === "pools") pools(ctx, view, column.x, band.y, column.w);
      else if (column.kind === "lanes") lanes(ctx, view, column.x, band.y, column.w);
      else status(ctx, view, column.x, band.y, column.w);
    }
  }
}

function sparkline(ctx: HudDrawContext, series: HudSeriesView, x: number, y: number, w: number, h: number): void {
  const titleY = y + 10;
  let labelRoom = w;
  if (series.absent === null) {
    const latest = fit(series.latest, w * 0.4);
    const latestW = latest.length * CHAR_W;
    text(ctx, latest, x + w - latestW, titleY, HUD_COLORS[series.tone], w * 0.4);
    labelRoom = w - latestW - 8;
  }
  text(ctx, fit(series.label, labelRoom), x, titleY, MUTED, labelRoom);

  const top = y + 16;
  const bottom = y + h;
  const graphH = bottom - top;
  let max = 0;
  for (const v of series.values) if (Number.isFinite(v) && v > max) max = v;

  if (max > 0) {
    // Plot on the window's full width so the line scrolls rather than
    // stretches while the window fills.
    const slots = Math.max(HUD_HISTORY, series.values.length);
    const step = w / (slots - 1);
    const offset = slots - series.values.length;
    const color = SERIES_LINE[series.key];

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let open = false;
    for (let i = 0; i < series.values.length; i++) {
      const v = series.values[i];
      if (!Number.isFinite(v)) {
        open = false;
        continue;
      }
      const px = x + (offset + i) * step;
      const py = bottom - (v / max) * graphH;
      if (open) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      open = true;
    }
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    open = false;
    let runStart = 0;
    for (let i = 0; i <= series.values.length; i++) {
      const v = i < series.values.length ? series.values[i] : Number.NaN;
      const px = x + (offset + i) * step;
      if (Number.isFinite(v)) {
        const py = bottom - (v / max) * graphH;
        if (!open) {
          runStart = px;
          ctx.moveTo(px, bottom);
        }
        ctx.lineTo(px, py);
        open = true;
      } else if (open) {
        const prev = x + (offset + i - 1) * step;
        ctx.lineTo(prev, bottom);
        ctx.lineTo(runStart, bottom);
        ctx.closePath();
        open = false;
      }
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  if (series.absent !== null) {
    text(ctx, fit(series.absent, w), x, bottom - 3, MUTED, w);
  } else if (series.state !== null) {
    const stateText = fit(series.state, w * 0.6);
    text(ctx, stateText, x + w - stateText.length * CHAR_W, bottom - 3, HUD_COLORS[series.tone], w);
  }
}

function pools(ctx: HudDrawContext, view: HudView, x: number, y: number, w: number): void {
  view.pools.forEach((pool, i) => {
    const baseline = y + LINE * (i + 1) - 4;
    text(ctx, fit(pool.label, POOL_LABEL_W), x, baseline, MUTED, POOL_LABEL_W);
    const barX = x + POOL_LABEL_W + 4;
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    ctx.fillRect(barX, baseline - 8, BAR_W, 8);
    if (pool.fill !== null) {
      ctx.fillStyle = HUD_COLORS[pool.tone];
      ctx.fillRect(barX, baseline - 8, Math.max(1, Math.min(1, pool.fill) * BAR_W), 8);
    }
    const textX = barX + BAR_W + 8;
    const line = pool.text === pool.state ? pool.state : `${pool.text} · ${pool.state}`;
    text(ctx, fit(line, w - (textX - x)), textX, baseline, HUD_COLORS[pool.tone], w);
  });
}

function lanes(ctx: HudDrawContext, view: HudView, x: number, y: number, w: number): void {
  let baseline = y + LINE - 4;
  text(ctx, fit("in flight / pending by lane", w), x, baseline, MUTED, w);
  for (const row of view.lanes.rows) {
    baseline += LINE;
    text(ctx, fit(`${row.label.padEnd(13)} ${String(row.inFlight).padStart(4)} / ${row.pending}`, w), x, baseline, TEXT, w);
  }
  baseline += LINE;
  text(
    ctx,
    fit(`${"all".padEnd(13)} ${String(view.lanes.inFlightTotal).padStart(4)} / ${view.lanes.pendingTotal}`, w),
    x,
    baseline,
    MUTED,
    w,
  );
  if (view.lanes.note) {
    baseline += LINE;
    text(ctx, fit(view.lanes.note.text, w), x, baseline, HUD_COLORS[view.lanes.note.tone], w);
  }
}

function status(ctx: HudDrawContext, view: HudView, x: number, y: number, w: number): void {
  let baseline = y + LINE - 4;
  stateLine(ctx, x, baseline, w, view.quiescence.tone, view.quiescence.label, view.quiescence.detail);
  baseline += LINE;
  stateLine(ctx, x, baseline, w, view.run.tone, view.run.label, view.run.detail);
  baseline += LINE;
  stateLine(ctx, x, baseline, w, view.adapter.tone, view.adapter.label, view.adapter.detail);
  const shown = view.levels.slice(0, LEVEL_ROWS_SHOWN);
  // The state word leads so a narrow column truncates the numbers, not the judgment.
  for (const level of shown) {
    baseline += LINE;
    stateLine(ctx, x, baseline, w, level.tone, level.name, `${level.state} · ${level.text}`);
  }
  if (view.levels.length > shown.length) {
    baseline += LINE;
    text(ctx, `+${view.levels.length - shown.length} more datasets`, x + 12, baseline, MUTED, w);
  }
}

function stateLine(
  ctx: HudDrawContext,
  x: number,
  baseline: number,
  w: number,
  tone: HudTone,
  label: string,
  detail: string,
): void {
  ctx.fillStyle = HUD_COLORS[tone];
  ctx.beginPath();
  ctx.arc(x + 4, baseline - 4, 3.5, 0, Math.PI * 2);
  ctx.fill();
  const labelText = fit(label, w * 0.5);
  text(ctx, labelText, x + 12, baseline, HUD_COLORS[tone], w);
  const detailX = x + 12 + labelText.length * CHAR_W + 8;
  const room = w - (detailX - x);
  if (room > CHAR_W * 4) text(ctx, fit(detail, room), detailX, baseline, MUTED, room);
}

function text(ctx: HudDrawContext, value: string, x: number, baseline: number, color: string, maxW: number): void {
  if (maxW <= 0 || value.length === 0) return;
  ctx.fillStyle = color;
  ctx.fillText(value, x, baseline);
}

/** Truncate by the font's approximate advance, so the context is never asked to measure text. */
function fit(value: string, maxW: number): string {
  const chars = Math.floor(maxW / CHAR_W);
  if (chars <= 0) return "";
  if (value.length <= chars) return value;
  return chars <= 1 ? "…" : `${value.slice(0, chars - 1)}…`;
}
