/**
 * The overlay's draw list: each chunk cell's color, hover text, and which cell
 * the pointer is over. Pure, so the slice overlay, the projected volume
 * overlay, and tests over fixture documents share it.
 *
 * Phase color and churn tint read the trace ({@link ChunkReading}), not the
 * cache, using the timeline's palette. A chunk with no row says why in words
 * rather than wearing a color. The brushed selection highlights its cells in
 * any mode; it arrives as an input, never read from the dock.
 *
 * Every other color is a canvas token, since the cells sit over the data and
 * take their contrast from the canvas background.
 */

import type { EvictionTier } from "../pipeline/fetch/index.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import { formatMs } from "../monitor/monitorModel.ts";
import { ROW_STATE_COLORS, withAlpha } from "../monitor/timelinePalette.ts";
import type { ChunkSelection } from "../trace/diagnose/chunkSelection.ts";
import { chunkIdentity, type ChunkReading } from "../trace/diagnose/chunkStates.ts";
import { describeState } from "../trace/diagnose/rowState.ts";
import type { ChunkLookup, RowState } from "../trace/diagnose/types.ts";
import { labelMs } from "../trace/diagnose/window.ts";
import { mixColor, paint, tokenColors } from "../theme/tokenColors.ts";
import type { ResolvedColor, TokenName } from "../theme/tokens.ts";

export type ChunkStatus = "cached" | "in-flight" | "planned";
export type DisplayTier = ResidencyTier | "missing";

/** A point in CSS pixels, relative to the viewer canvas. */
export type ScreenPoint = [number, number];

/**
 * A chunk box's eight corners on screen, or null for a corner behind the
 * camera. Corner `i` is at the box's far face in x when bit 0 of `i` is
 * set, in y for bit 1, in z for bit 2.
 */
export type BoxCorners = readonly (ScreenPoint | null)[];

/**
 * One chunk cell the overlay projected: which chunk it is, where it is on
 * screen, and what the cache says about it. The identity fields are the
 * trace's `ChunkCoordinates`, so a cell is handed to the recorder as it is.
 */
export interface ChunkCell {
  key: string;
  datasetId: string;
  entityId: string;
  chunkKey: string;
  level: number;
  t: number;
  c: number;
  z: number;
  /** Chunk indices along the two image axes. */
  y: number;
  x: number;
  /** CSS pixels, relative to the viewer canvas. */
  left: number;
  top: number;
  width: number;
  height: number;
  status: ChunkStatus;
  /** Current render tier visible to the shader, or missing fallback. */
  sourceTier?: DisplayTier;
  /** For a planned cell: zero-based rank in the pending fetch queue, or undefined when not queued. */
  priorityRank?: number;
  /** For a cached cell: its eviction tier, or null when the lookup failed. */
  tier?: EvictionTier | null;
  /**
   * True for the one rectangle a group served by a proxy asset gets. Not a
   * chunk, so it has no row: the trace-reading modes leave it to the cache
   * colors and say what it is. Its identity fields are placeholders.
   */
  proxyAsset?: boolean;
  /**
   * In volume mode, the chunk box's corners on screen. The rectangle above
   * is their bounds. Absent in slice mode, where the cell is the rectangle.
   */
  corners?: BoxCorners;
  /**
   * In volume mode, the squared distance from the camera to the box's
   * center in world units, so boxes along one line of sight order front
   * to back. Absent in slice mode.
   */
  depth?: number;
}

/** The color modes over the chunk grid. Each gates on its own toggle. */
export interface OverlayModes {
  chunkTier: boolean;
  cachedTier: boolean;
  plannedRank: boolean;
  phaseColor: boolean;
  churnTint: boolean;
}

export interface ChunkDrawItem {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fill: string;
  border: string;
  /** The cell's tier and cache status in one phrase. */
  status: string;
  /** The cell in one line: the status, then phase and churn when those modes are on. */
  tooltip: string;
  /** What the trace says about the chunk, or null when no row carries it. */
  reading: ChunkReading | null;
  /** True when the cell's identity is in the published selection. */
  selected: boolean;
  cell: ChunkCell;
}

export interface ChunkDrawList {
  items: ChunkDrawItem[];
  /** Cells the trace had a row for. */
  withRow: number;
  /** Cells fetched more than once in the window. */
  churned: number;
  /** Cells in the published selection. */
  selected: number;
}

export interface DrawListInput {
  cells: readonly ChunkCell[];
  /** From {@link readOverlayColors}, once per draw list. */
  colors: OverlayColors;
  modes: OverlayModes;
  /**
   * The trace's reading for a cell, or null when no row carries the chunk.
   * Asked only when phase color or churn tint is on, so the other modes cost
   * the trace nothing.
   */
  readingOf: (cell: ChunkCell) => ChunkReading | null;
  /** The window the churn counts are over, in milliseconds, or null when no interval is open. */
  windowMs: number | null;
  /**
   * The chunk set a brushed window published, or null when none is brushed.
   * A cell whose identity is in it is highlighted whatever else is on. One
   * set lookup per cell, so a selection costs the draw no row.
   */
  selection?: ChunkSelection | null;
}

const OVERLAY_COLOR_TOKENS = {
  stroke: "--lc-canvas-stroke",
  label: "--lc-canvas-label",
  success: "--lc-canvas-success",
  warning: "--lc-canvas-warning",
  danger: "--lc-canvas-danger",
  info: "--lc-canvas-info",
} as const satisfies Record<string, TokenName>;

/** The tokens the overlay paints with, resolved. */
export type OverlayColors = { readonly [K in keyof typeof OVERLAY_COLOR_TOKENS]: ResolvedColor };

export function readOverlayColors(): OverlayColors {
  return tokenColors(OVERLAY_COLOR_TOKENS);
}

export interface ChurnBand {
  minFetches: number;
  fill: string;
  border: string;
  label: string;
}

/** Every fill and border the overlay paints outside the phase colors, as CSS. */
export interface OverlayPaints {
  cached: string;
  inFlight: string;
  planned: string;
  tier: Record<"detail" | "coarse" | "missing", string>;
  /** The default cell border. */
  cellBorder: string;
  /** The fill and border a trace-reading mode gives a cell with no row. */
  noRowFill: string;
  noRowBorder: string;
  /**
   * The highlight a cell in the brushed selection wears. The border carries
   * it whatever mode is on, so a phase color or a churn band keeps its fill
   * and the set still reads. On the plain grid the fill goes light too, since
   * the cache colors answer a different question from the one the brush asked.
   */
  selectedBorder: string;
  selectedFill: string;
  /**
   * Rank 0 is next to fetch. Discrete bands rather than a gradient, so the
   * grid reads at a glance: amber is imminent, orange is soon, red is further,
   * faint red is far back.
   */
  plannedRank: { unqueued: string; under5: string; under20: string; under60: string; beyond: string };
  /**
   * Stays in the green family so cached still reads as green, with shifts for
   * how at risk the chunk is: active detail green, demoted detail paler,
   * prefetch teal.
   */
  cachedTier: Record<EvictionTier, string>;
  /**
   * The churn bands, most fetches first: one fetch is the normal case and
   * barely tinted; two is the first refetch, and from there the tint warms.
   * The bands are discrete so a loop reads at a glance.
   */
  churnBands: readonly ChurnBand[];
}

const paintsByColors = new WeakMap<OverlayColors, OverlayPaints>();

/** The overlay's paints for a set of colors, built once per set. */
export function overlayPaints(colors: OverlayColors): OverlayPaints {
  let paints = paintsByColors.get(colors);
  if (paints) return paints;
  const { stroke, label, success, warning, danger, info } = colors;
  const orange = mixColor(danger, warning, 0.5);
  const cellBorder = `1px solid ${paint(stroke, 0.26)}`;
  paints = {
    cached: paint(success, 0.3),
    inFlight: paint(warning, 0.35),
    planned: paint(danger, 0.3),
    tier: { detail: paint(success, 0.36), coarse: paint(warning, 0.34), missing: paint(danger, 0.38) },
    cellBorder,
    noRowFill: paint(stroke, 0.05),
    noRowBorder: `1px dashed ${paint(stroke, 0.33)}`,
    selectedBorder: `2px solid ${paint(label)}`,
    selectedFill: paint(stroke, 0.35),
    plannedRank: {
      unqueued: paint(stroke, 0.2),
      under5: paint(warning, 0.5),
      under20: paint(orange, 0.4),
      under60: paint(danger, 0.32),
      beyond: paint(danger, 0.2),
    },
    cachedTier: {
      "active-detail": paint(success, 0.36),
      "demoted-detail": paint(mixColor(success, label, 0.4), 0.3),
      prefetch: paint(mixColor(success, info, 0.5), 0.32),
    },
    churnBands: [
      { minFetches: 4, fill: paint(danger, 0.56), border: `2px solid ${paint(danger, 0.95)}`, label: "4 or more fetches" },
      { minFetches: 3, fill: paint(orange, 0.48), border: `2px solid ${paint(orange, 0.9)}`, label: "3 fetches" },
      { minFetches: 2, fill: paint(warning, 0.4), border: `2px solid ${paint(warning, 0.85)}`, label: "2 fetches" },
      { minFetches: 1, fill: paint(info, 0.16), border: cellBorder, label: "1 fetch" },
    ],
  };
  paintsByColors.set(colors, paints);
  return paints;
}

/** How opaque a phase color is painted over the pixels. */
export const PHASE_FILL_ALPHA = 0.42;

/** What the tooltip and the inspector add for a cell in the brushed selection. */
export const SELECTED_LABEL = "in the brushed window";

/** The band a fetch count falls in, or null for a chunk the window never fetched. */
export function churnBand(fetches: number, paints: OverlayPaints): ChurnBand | null {
  for (const band of paints.churnBands) if (fetches >= band.minFetches) return band;
  return null;
}

/** The churn window as the legend and the tooltips state it. */
export function churnWindowLabel(windowMs: number | null): string {
  if (windowMs === null) return "no interval open";
  return `over the open interval, ${formatSeconds(windowMs)}`;
}

export function buildChunkDrawList(input: DrawListInput): ChunkDrawList {
  const { cells, modes } = input;
  const paints = overlayPaints(input.colors);
  const readsTrace = modes.phaseColor || modes.churnTint;
  const selection = input.selection ?? null;
  const items: ChunkDrawItem[] = [];
  let withRow = 0;
  let churned = 0;
  let selected = 0;

  for (const cell of cells) {
    const status = statusText(cell, modes);
    if (cell.proxyAsset) {
      items.push({
        key: cell.key,
        left: cell.left,
        top: cell.top,
        width: cell.width,
        height: cell.height,
        fill: cacheFill(cell, modes, paints),
        border: paints.cellBorder,
        status,
        tooltip: `${status} · group proxy asset: not a chunk, so it has no row`,
        reading: null,
        selected: false,
        cell,
      });
      continue;
    }
    const reading = readsTrace ? input.readingOf(cell) : null;
    if (reading) withRow += 1;
    const band = modes.churnTint && reading ? churnBand(reading.fetches, paints) : null;
    if (band && reading && reading.fetches >= 2) churned += 1;
    const inSelection =
      selection !== null &&
      selection.identities.has(chunkIdentity(cell.datasetId, cell.entityId, cell.chunkKey));
    if (inSelection) selected += 1;

    let fill: string;
    let border = paints.cellBorder;
    if (modes.phaseColor) {
      fill = reading ? withAlpha(ROW_STATE_COLORS[reading.state], PHASE_FILL_ALPHA) : paints.noRowFill;
      if (!reading) border = paints.noRowBorder;
      if (band) border = band.border;
    } else if (modes.churnTint) {
      fill = band ? band.fill : paints.noRowFill;
      if (!reading) border = paints.noRowBorder;
    } else {
      fill = cacheFill(cell, modes, paints);
    }
    if (inSelection) {
      border = paints.selectedBorder;
      if (!readsTrace) fill = paints.selectedFill;
    }

    const tooltip = tooltipFor(status, modes, reading, input.windowMs);
    items.push({
      key: cell.key,
      left: cell.left,
      top: cell.top,
      width: cell.width,
      height: cell.height,
      fill,
      border,
      status,
      tooltip: inSelection ? `${tooltip} · ${SELECTED_LABEL}` : tooltip,
      reading,
      selected: inSelection,
      cell,
    });
  }
  return { items, withRow, churned, selected };
}

function cacheFill(cell: ChunkCell, modes: OverlayModes, paints: OverlayPaints): string {
  const tier = cell.sourceTier;
  if (modes.chunkTier && (tier === "detail" || tier === "coarse" || tier === "missing")) return paints.tier[tier];
  if (cell.status === "cached") return modes.cachedTier && cell.tier ? paints.cachedTier[cell.tier] : paints.cached;
  if (cell.status === "in-flight") return paints.inFlight;
  return modes.plannedRank ? plannedColor(cell.priorityRank, paints) : paints.planned;
}

function plannedColor(rank: number | undefined, paints: OverlayPaints): string {
  const bands = paints.plannedRank;
  if (rank === undefined) return bands.unqueued;
  if (rank < 5) return bands.under5;
  if (rank < 20) return bands.under20;
  if (rank < 60) return bands.under60;
  return bands.beyond;
}

function statusText(cell: ChunkCell, modes: OverlayModes): string {
  const status =
    cell.status === "cached"
      ? modes.cachedTier && cell.tier
        ? `cached · tier ${cell.tier}`
        : "cached"
      : cell.status === "in-flight"
        ? "in-flight"
        : modes.plannedRank && cell.priorityRank !== undefined
          ? `planned · queue rank ${cell.priorityRank}`
          : modes.plannedRank
            ? "planned · not in pending queue"
            : "planned";
  return cell.sourceTier ? `${cell.sourceTier} · ${status}` : status;
}

function tooltipFor(
  status: string,
  modes: OverlayModes,
  reading: ChunkReading | null,
  windowMs: number | null,
): string {
  const parts: string[] = [status];
  if (modes.phaseColor || modes.churnTint) {
    if (!reading) parts.push(noRowStatement(windowMs));
    else {
      if (modes.phaseColor) parts.push(`phase ${stateLabel(reading.state)}`);
      if (modes.churnTint) parts.push(churnStatement(reading, windowMs));
    }
  }
  return parts.join(" · ");
}

/** A row state as the legend names it: the table's `unstamped` is the bar's `planned`. */
export function stateLabel(state: RowState): string {
  return state === "unstamped" ? "planned" : state;
}

/** What a cell with no row means, in the words the spatial summary uses. */
export function noRowStatement(windowMs: number | null): string {
  if (windowMs === null) return "no interval open, so no row to read";
  return "no row in the open interval: resident before it opened, still queued, or never wanted";
}

/** A chunk's fetch count with its window, so the count has a denominator. */
export function churnStatement(reading: ChunkReading, windowMs: number | null): string {
  const times = reading.fetches === 1 ? "once" : `${reading.fetches}×`;
  return `fetched ${times} ${churnWindowLabel(windowMs)}`;
}

/**
 * The cell under a point, or null. Cells overlap where a coarse chunk sits
 * behind the detail chunks it covers, so the smallest cell containing the
 * point wins: it is the most specific thing the pointer is over.
 */
export function hitTestChunk(items: readonly ChunkDrawItem[], x: number, y: number): ChunkDrawItem | null {
  let best: ChunkDrawItem | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (x < item.left || y < item.top || x > item.left + item.width || y > item.top + item.height) continue;
    const area = item.width * item.height;
    if (area < bestArea) {
      best = item;
      bestArea = area;
    }
  }
  return best;
}

/** What the hover inspector shows for one cell. */
export interface InspectorView {
  title: string;
  lines: string[];
}

/**
 * The hover inspector's text for the cell under the pointer: the newest row's
 * phase, queue rank, and age, and the window's fetch count. `lookup` is null
 * when no interval is open.
 *
 * The lookup caps its list at a chunk's oldest rows, so phase and age come
 * from the cell's reading, which holds the true newest row and colored the
 * cell. The listed row supplies the rank, and the text says when it is not
 * the newest.
 */
export function describeHoverInspector(
  item: ChunkDrawItem,
  lookup: ChunkLookup | null,
  windowMs: number | null,
): InspectorView {
  const { cell, reading } = item;
  const title = `${cell.entityId} · ${cell.chunkKey}`;
  const lines: string[] = [item.status];
  if (item.selected) lines.push(SELECTED_LABEL);
  if (!lookup) {
    lines.push(noRowStatement(null));
    return { title, lines };
  }
  if (lookup.rowCount === 0) {
    lines.push(noRowStatement(windowMs));
    return { title, lines };
  }
  const listed = lookup.rows[lookup.rows.length - 1];
  const capped = lookup.rowCount > lookup.rows.length;
  const state = reading ? reading.state : listed.state;
  const lastPhase = !capped && listed.phases.length > 0 ? listed.phases[listed.phases.length - 1] : null;
  lines.push(
    `phase: ${describeState(state)}` +
      (lastPhase && state !== lastPhase.phase ? ` · ${lastPhase.phase} took ${formatMs(lastPhase.durationMs)}` : ""),
  );
  const rankOf = capped ? "queue rank of the newest listed row" : "queue rank";
  lines.push(
    listed.queue
      ? `${rankOf}: ${listed.queue.aheadAtAdmission.toLocaleString()} ahead at admission · ` +
          `${listed.queue.overtaken.toLocaleString()} overtook it · waited ${formatMs(listed.queue.waitedMs)}` +
          (listed.queue.dispatched ? "" : " · not dispatched yet")
      : `${rankOf}: never entered the queue`,
  );
  const ageMs = reading ? reading.ageMs : listed.ageMs;
  lines.push(ageMs === null ? "age: no boundary reached" : `age: ${formatMs(ageMs)}`);
  if (reading) lines.push(churnStatement(reading, windowMs));
  if (capped) {
    lines.push(
      `${lookup.rowCount} rows carry this chunk; the ${lookup.rows.length} oldest are listed, and the newest is not among them`,
    );
  } else if (lookup.rowCount > 1) {
    lines.push(`${lookup.rowCount} rows carry this chunk; the newest is shown`);
  }
  if (lookup.eventCount > 0) {
    const last = lookup.events[lookup.events.length - 1];
    lines.push(`${lookup.eventCount} event(s), last ${last.kind} (${last.reason}) at ${formatMs(last.atMs)}`);
  }
  lines.push("ranks and ages count recorded rows only");
  return { title, lines };
}

/**
 * What an empty picture means, for the caption the overlay shows when a
 * trace-reading mode is on and paints nothing. Null when there is nothing
 * to say: the mode is off, or the picture has something in it.
 */
export function overlayAbsence(modes: OverlayModes, list: ChunkDrawList, windowMs: number | null): string | null {
  if (!modes.phaseColor && !modes.churnTint) return null;
  if (windowMs === null) return "no interval is open, so the trace has no row to color a chunk by";
  if (list.items.length === 0) return "no chunk on screen to color: nothing is planned for this view";
  if (list.withRow === 0) {
    const mode = modes.phaseColor ? "phase" : "churn";
    return (
      `${mode}: no chunk on screen has a row in the open interval (${formatSeconds(windowMs)}); ` +
      "each was resident before it opened, is still queued, or was never wanted"
    );
  }
  // With phase color on, the picture is painted, so a quiet churn is not an
  // empty picture and gets no caption.
  if (modes.churnTint && !modes.phaseColor && list.churned === 0) {
    return `churn: no chunk on screen was fetched more than once in the open interval (${formatSeconds(windowMs)})`;
  }
  return null;
}

/**
 * The caption the overlay shows while a window is brushed: the window, the
 * phase the set is narrowed to, and how much of the set is on screen. A
 * viewport with no highlighted cell then reads as "the set is elsewhere"
 * rather than as an empty set. Null when nothing is brushed.
 */
export function selectionCaption(selection: ChunkSelection | null, list: ChunkDrawList): string | null {
  if (!selection) return null;
  const scope = `brushed ${labelMs(selection.window.startMs, selection.window.endMs)} ms of run ${selection.runId}`;
  const where = selection.phase ? `in ${selection.phase}` : "active";
  if (selection.chunks === 0) {
    return `${scope}: no chunk had a row ${where} in the window, so nothing is highlighted`;
  }
  const set = `${selection.chunks.toLocaleString()} chunks with a row ${where} in the window`;
  if (list.selected === 0) return `${scope}: none of the ${set} is on screen at this view`;
  return (
    `${scope}: ${list.selected.toLocaleString()} of ${set} are on screen; ` +
    "the rest are off screen or at a level this view does not show"
  );
}

function formatSeconds(ms: number): string {
  return `${(ms / 1_000).toFixed(1)} s`;
}
