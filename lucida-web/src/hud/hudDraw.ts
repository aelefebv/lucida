/**
 * Draw one {@link HudView} onto a 2D context.
 *
 * Layout is in CSS pixels on a context scaled by the device pixel ratio. The
 * output depends only on the view and the box, so the cost gate can drive it
 * with a fake context. Below the sparklines, the pools, lanes, and status
 * column sit side by side when the strip is wide enough and stack when not,
 * so a narrow viewport costs height rather than readouts.
 */

import { mixColor, paint, tokenColor, tokenColors } from "../theme/tokenColors.ts";
import type { TokenName } from "../theme/tokens.ts";
import { HUD_HISTORY, type HudSeriesView, type HudTone, type HudView } from "./hudModel.ts";

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

/**
 * What the strip paints with, as CSS colors. The strip is a floating card,
 * so it follows the UI theme, not the canvas background.
 */
export interface HudColors {
  background: string;
  text: string;
  muted: string;
  /** The empty part of a pool's bar. */
  track: string;
  tones: Record<HudTone, string>;
  series: Record<HudSeriesView["key"], string>;
}

const TONE_TOKENS = {
  ok: "--lc-success",
  busy: "--lc-warning",
  warn: "--lc-danger",
  absent: "--lc-text-subtle",
  info: "--lc-info",
} as const satisfies Record<HudTone, TokenName>;

/** The strip's colors from the current theme tokens. */
export function readHudColors(): HudColors {
  const tones = tokenColors(TONE_TOKENS);
  return {
    background: paint(tokenColor("--lc-surface-float")),
    text: paint(tokenColor("--lc-text")),
    muted: paint(tokenColor("--lc-text-muted")),
    track: paint(tokenColor("--lc-border")),
    tones: {
      ok: paint(tones.ok),
      busy: paint(tones.busy),
      warn: paint(tones.warn),
      absent: paint(tones.absent),
      info: paint(tones.info),
    },
    // Each sparkline has its own labelled cell, so these only need to differ
    // enough to scan.
    series: {
      received: paint(tones.info),
      sent: paint(tokenColor("--lc-accent-text")),
      frame: paint(tones.ok),
      gpu: paint(mixColor(tones.ok, tones.info, 0.5)),
    },
  };
}

const PAD = 8;
const GAP = 8;
const FONT_PX = 11;
const LINE = 15;
const HEADER = 13;
const CHART_H = 44;
const CHAR_W = FONT_PX * 0.62;
const FONT = `${FONT_PX}px ui-monospace, Menlo, Consolas, monospace`;
const POOLS_W = 336;
const POOL_LABEL_W = 60;
const LANES_W = 200;
const STATUS_MIN = 260;
const BAR_W = 56;

/** How many datasets the levels column lists before it counts the rest. */
export const LEVEL_ROWS_SHOWN = 3;

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

export function drawHud(ctx: HudDrawContext, view: HudView, box: HudBox, colors: HudColors): void {
  const { width, height, dpr } = box;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = 1;
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = FONT;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  const inner = width - 2 * PAD;
  let y = PAD;

  text(ctx, "pipeline HUD", PAD, y + 10, colors.muted, inner / 2);
  const windowText = fit(view.window, inner / 2);
  text(ctx, windowText, width - PAD - windowText.length * CHAR_W, y + 10, colors.muted, inner / 2);
  y += HEADER + 4;

  const cellW = (inner - GAP * (view.series.length - 1)) / view.series.length;
  view.series.forEach((series, i) => {
    sparkline(ctx, colors, series, PAD + i * (cellW + GAP), y, cellW, CHART_H);
  });

  for (const band of layout(view, width).bands) {
    for (const column of band.columns) {
      if (column.kind === "pools") pools(ctx, colors, view, column.x, band.y, column.w);
      else if (column.kind === "lanes") lanes(ctx, colors, view, column.x, band.y, column.w);
      else status(ctx, colors, view, column.x, band.y, column.w);
    }
  }
}

function sparkline(ctx: HudDrawContext, colors: HudColors, series: HudSeriesView, x: number, y: number, w: number, h: number): void {
  const titleY = y + 10;
  let labelRoom = w;
  if (series.absent === null) {
    const latest = fit(series.latest, w * 0.4);
    const latestW = latest.length * CHAR_W;
    text(ctx, latest, x + w - latestW, titleY, colors.tones[series.tone], w * 0.4);
    labelRoom = w - latestW - 8;
  }
  text(ctx, fit(series.label, labelRoom), x, titleY, colors.muted, labelRoom);

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
    const color = colors.series[series.key];

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
    text(ctx, fit(series.absent, w), x, bottom - 3, colors.muted, w);
  } else if (series.state !== null) {
    const stateText = fit(series.state, w * 0.6);
    text(ctx, stateText, x + w - stateText.length * CHAR_W, bottom - 3, colors.tones[series.tone], w);
  }
}

function pools(ctx: HudDrawContext, colors: HudColors, view: HudView, x: number, y: number, w: number): void {
  view.pools.forEach((pool, i) => {
    const baseline = y + LINE * (i + 1) - 4;
    text(ctx, fit(pool.label, POOL_LABEL_W), x, baseline, colors.muted, POOL_LABEL_W);
    const barX = x + POOL_LABEL_W + 4;
    ctx.fillStyle = colors.track;
    ctx.fillRect(barX, baseline - 8, BAR_W, 8);
    if (pool.fill !== null) {
      ctx.fillStyle = colors.tones[pool.tone];
      ctx.fillRect(barX, baseline - 8, Math.max(1, Math.min(1, pool.fill) * BAR_W), 8);
    }
    const textX = barX + BAR_W + 8;
    const line = pool.text === pool.state ? pool.state : `${pool.text} · ${pool.state}`;
    text(ctx, fit(line, w - (textX - x)), textX, baseline, colors.tones[pool.tone], w);
  });
}

function lanes(ctx: HudDrawContext, colors: HudColors, view: HudView, x: number, y: number, w: number): void {
  let baseline = y + LINE - 4;
  text(ctx, fit("in flight / pending by lane", w), x, baseline, colors.muted, w);
  for (const row of view.lanes.rows) {
    baseline += LINE;
    text(ctx, fit(`${row.label.padEnd(13)} ${String(row.inFlight).padStart(4)} / ${row.pending}`, w), x, baseline, colors.text, w);
  }
  baseline += LINE;
  text(
    ctx,
    fit(`${"all".padEnd(13)} ${String(view.lanes.inFlightTotal).padStart(4)} / ${view.lanes.pendingTotal}`, w),
    x,
    baseline,
    colors.muted,
    w,
  );
  if (view.lanes.note) {
    baseline += LINE;
    text(ctx, fit(view.lanes.note.text, w), x, baseline, colors.tones[view.lanes.note.tone], w);
  }
}

function status(ctx: HudDrawContext, colors: HudColors, view: HudView, x: number, y: number, w: number): void {
  let baseline = y + LINE - 4;
  stateLine(ctx, colors, x, baseline, w, view.quiescence.tone, view.quiescence.label, view.quiescence.detail);
  baseline += LINE;
  stateLine(ctx, colors, x, baseline, w, view.run.tone, view.run.label, view.run.detail);
  baseline += LINE;
  stateLine(ctx, colors, x, baseline, w, view.adapter.tone, view.adapter.label, view.adapter.detail);
  const shown = view.levels.slice(0, LEVEL_ROWS_SHOWN);
  // The state word leads so a narrow column truncates the numbers, not the judgment.
  for (const level of shown) {
    baseline += LINE;
    stateLine(ctx, colors, x, baseline, w, level.tone, level.name, `${level.state} · ${level.text}`);
  }
  if (view.levels.length > shown.length) {
    baseline += LINE;
    text(ctx, `+${view.levels.length - shown.length} more datasets`, x + 12, baseline, colors.muted, w);
  }
}

function stateLine(
  ctx: HudDrawContext,
  colors: HudColors,
  x: number,
  baseline: number,
  w: number,
  tone: HudTone,
  label: string,
  detail: string,
): void {
  ctx.fillStyle = colors.tones[tone];
  ctx.beginPath();
  ctx.arc(x + 4, baseline - 4, 3.5, 0, Math.PI * 2);
  ctx.fill();
  const labelText = fit(label, w * 0.5);
  text(ctx, labelText, x + 12, baseline, colors.tones[tone], w);
  const detailX = x + 12 + labelText.length * CHAR_W + 8;
  const room = w - (detailX - x);
  if (room > CHAR_W * 4) text(ctx, fit(detail, room), detailX, baseline, colors.muted, room);
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
